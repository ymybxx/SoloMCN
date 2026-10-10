"""调度器、各热榜渠道和推特渠道的测试。不访问外网：推特渠道用假的号池和假推文对象。用到数据库的测试各自用一个临时的 SQLite 文件。"""

import asyncio
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from channels.x import XChannel, heat, to_entry
from db import connect
from scheduler import Busy, Entry, Scheduler


def now() -> datetime:
    return datetime.now(timezone.utc)


class FakeChannel:
    def __init__(self, cid="fake", every_min=60, entries=None, error=None):
        self.id, self.name, self.every_min = cid, cid, every_min
        self.entries, self.error = entries or [], error
        self.gate: asyncio.Event | None = None

    async def collect(self):
        if self.gate:
            await self.gate.wait()
        if self.error:
            raise self.error
        return self.entries


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db = await connect(Path(tmp.name) / "test.db")
        self.addAsyncCleanup(self.db.close)

    async def test_run_saves_entries_and_records_run(self):
        ch = FakeChannel(entries=[Entry("1", "第一条", text="全文", links=["https://a.example"], metrics={"likes": 5}, score=40, extra={"k": "v"})])
        s = Scheduler(self.db, [ch])

        self.assertEqual(await s.run("fake"), {"channel": "fake", "count": 1, "error": None})

        items = await s.feed()
        self.assertEqual(len(items), 1)
        self.assertEqual((items[0]["title"], items[0]["text"], items[0]["links"], items[0]["metrics"], items[0]["extra"]),
                         ("第一条", "全文", ["https://a.example"], {"likes": 5}, {"k": "v"}))
        status = (await s.status())[0]
        self.assertEqual((status["total"], status["lastRun"]["count"], status["lastRun"]["error"]), (1, 1, None))

    async def test_rerun_updates_numbers_but_keeps_first_seen(self):
        ch = FakeChannel(entries=[Entry("1", "旧", metrics={"likes": 5}, score=10)])
        s = Scheduler(self.db, [ch])
        await s.run("fake")
        first = await self.db.fetchrow("select first_seen, last_seen from entries")
        ch.entries = [Entry("1", "新", metrics={"likes": 50}, score=30)]
        await s.run("fake")

        row = await self.db.fetchrow("select * from entries")
        self.assertEqual((row["title"], row["score"], row["first_seen"]), ("新", 30, first["first_seen"]))
        self.assertGreater(row["last_seen"], first["last_seen"])
        self.assertEqual(await self.db.fetchval("select count(*) from entries"), 1)

    async def test_failure_is_recorded_and_does_not_raise(self):
        s = Scheduler(self.db, [FakeChannel(error=RuntimeError("上游挂了"))])
        result = await s.run("fake")
        self.assertIn("上游挂了", result["error"])
        self.assertIn("上游挂了", (await s.status())[0]["lastRun"]["error"])
        self.assertEqual(s.running, set())

    async def test_same_channel_cannot_run_twice_at_once(self):
        ch = FakeChannel()
        ch.gate = asyncio.Event()
        s = Scheduler(self.db, [ch])
        first = asyncio.create_task(s.run("fake"))
        await asyncio.sleep(0.05)
        with self.assertRaises(Busy):
            await s.run("fake")
        self.assertEqual(await s.due(), [])  # 正在跑的不算到点
        ch.gate.set()
        await first

    async def test_config_is_validated_saved_and_reloaded(self):
        class Configurable(FakeChannel):
            min_every_min = 30
            settings = {"words": ["默认"]}
            default_settings = {"words": ["默认"]}

            def validate(self, s):
                if not s.get("words"):
                    raise ValueError("至少一个词")
                return {"words": s["words"]}

            def apply(self, s):
                self.settings = s

        ch = Configurable("c", every_min=60)
        s = Scheduler(self.db, [ch])
        with self.assertRaisesRegex(ValueError, "30–1440"):
            await s.set_config("c", 10, {"words": ["x"]})
        with self.assertRaisesRegex(ValueError, "至少一个词"):
            await s.set_config("c", 60, {"words": []})
        self.assertEqual(await self.db.fetchval("select count(*) from channel_config"), 0)

        cfg = await s.set_config("c", 90, {"words": ["新"]})
        self.assertEqual((cfg["everyMin"], cfg["settings"], cfg["defaults"]), (90, {"words": ["新"]}, {"words": ["默认"]}))
        self.assertEqual((await s.status())[0]["config"]["settings"], {"words": ["新"]})

        fresh = Configurable("c", every_min=60)
        await Scheduler(self.db, [fresh]).load()
        self.assertEqual((fresh.every_min, fresh.settings), (90, {"words": ["新"]}))

    async def test_due_uses_last_run_time(self):
        s = Scheduler(self.db, [FakeChannel("a", every_min=60), FakeChannel("b", every_min=60), FakeChannel("c", every_min=60)])
        await self.db.execute("insert into runs (channel, started_at) values ('a', strftime('%s', 'now') - 1800), ('b', strftime('%s', 'now') - 3660)")
        self.assertEqual(sorted(await s.due()), ["b", "c"])

    async def test_feed_filters_by_channel_and_age_and_sorts_by_score(self):
        t = now()
        a = FakeChannel("a", entries=[Entry("1", "低分", published_at=t, score=10), Entry("2", "高分", published_at=t, score=90),
                                      Entry("3", "太旧", published_at=t - timedelta(hours=30), score=99)])
        b = FakeChannel("b", entries=[Entry("1", "别的渠道", score=50)])
        s = Scheduler(self.db, [a, b])
        await s.run("a")
        await s.run("b")

        self.assertEqual([x["title"] for x in await s.feed(hours=24)], ["高分", "别的渠道", "低分"])
        self.assertEqual([x["title"] for x in await s.feed(["a"], hours=48)], ["太旧", "高分", "低分"])
        self.assertEqual([x["title"] for x in await s.feed(["a"], limit=1)], ["高分"])

    async def test_new_only_after_the_channel_has_been_watching(self):
        ch = FakeChannel("hot", entries=[Entry("老", "第一次抓就在")])
        s = Scheduler(self.db, [ch])
        await s.run("hot")
        self.assertEqual([x["isNew"] for x in await s.feed()], [False])

        # 模拟第一次抓取发生在一小时前
        await self.db.execute("update runs set started_at = strftime('%s', 'now') - 3600")
        await self.db.execute("update entries set first_seen = strftime('%s', 'now') - 3600")
        ch.entries = [Entry("老", "第一次抓就在"), Entry("新", "后来上榜")]
        await s.run("hot")
        self.assertEqual({x["title"]: x["isNew"] for x in await s.feed()}, {"第一次抓就在": False, "后来上榜": True})

        await self.db.execute("update entries set first_seen = strftime('%s', 'now') - 14400 where item_id = '新'")
        self.assertFalse(next(x for x in await s.feed() if x["id"] == "新")["isNew"])

    async def test_not_new_after_the_channel_was_down_for_a_while(self):
        ch = FakeChannel("hot", entries=[Entry("老", "老词")])
        s = Scheduler(self.db, [ch])
        await s.run("hot")
        # 服务停了 8 小时，期间上榜的词在重启后第一次被看到，不能算新上榜
        await self.db.execute("update runs set started_at = strftime('%s', 'now') - 28800")
        await self.db.execute("update entries set first_seen = strftime('%s', 'now') - 28800")
        ch.entries = [Entry("老", "老词"), Entry("停机期间上榜", "停机期间上榜")]
        await s.run("hot")
        self.assertEqual({x["title"]: x["isNew"] for x in await s.feed()}, {"老词": False, "停机期间上榜": False})

    async def test_hot_list_entries_without_publish_time_stay_while_still_on_the_list(self):
        s = Scheduler(self.db, [FakeChannel("hot", entries=[Entry("词", "还在榜上", score=50)])])
        await s.run("hot")
        await self.db.execute("update entries set first_seen = strftime('%s', 'now') - 259200")
        self.assertEqual([x["title"] for x in await s.feed(hours=24)], ["还在榜上"])
        await self.db.execute("update entries set last_seen = strftime('%s', 'now') - 172800")
        self.assertEqual(await s.feed(hours=24), [])


class DouyinTests(unittest.TestCase):
    def test_entry_uses_word_as_id_and_flags_risk(self):
        from channels.douyin import heat as dy_heat, to_entry as dy_entry

        e = dy_entry({"word": " 打工人返程崩溃 ", "hot_value": 10_000_000, "label": 3}, 2)
        self.assertEqual((e.item_id, e.title, e.metrics["hot"], e.metrics["rank"]), ("打工人返程崩溃", "打工人返程崩溃", 10_000_000, 2))
        self.assertEqual((e.extra["since"], e.extra["rising"], "risk" in e.extra), (None, False, False))
        self.assertIn("douyin.com/search/", e.url)  # 老接口没有热点 id，退回搜索页
        self.assertEqual(dy_heat(10_000_000), 75)
        self.assertEqual(dy_heat(None), 0)
        self.assertEqual(dy_entry({"word": "某地地震", "hot_value": 1}, 1).extra["risk"]["level"], "avoid")

    def test_web_list_links_hot_page_and_keeps_rising_words(self):
        from channels.douyin import RISING_SCORE, parse_web

        entries = parse_web({"data": {
            "word_list": [{"word": "中微子是什么", "hot_value": 12_000_000, "position": 2, "sentence_id": "2683790",
                           "event_time": 1791295112, "max_rank": 1, "video_count": 7, "label": 3}],
            "trending_list": [{"word": "中微子是什么", "hot_value": 0}, {"word": "驻马店有自己的天妇罗", "hot_value": 0, "sentence_id": "2683217"}],
        }})
        top, rising = entries
        self.assertEqual(len(entries), 2)  # 上升榜里和热搜重复的词只算一次
        self.assertEqual(top.url, "https://www.douyin.com/hot/2683790")
        self.assertEqual((top.metrics["rank"], top.metrics["videos"], top.extra["maxRank"]), (2, 7, 1))
        self.assertTrue(top.extra["since"].startswith("2026-10-06T"))
        self.assertEqual((rising.extra["rising"], rising.metrics["rank"], rising.score), (True, None, RISING_SCORE))
        with self.assertRaises(ValueError):
            parse_web({"data": {"word_list": []}})


class HotListTests(unittest.IsolatedAsyncioTestCase):
    async def test_wraps_hub_source_and_refuses_stale_data(self):
        from channels import Item, Source
        from channels.hotlist import HotListChannel

        class FakeHub:
            entry = {"items": [Item("某地暴雨", "https://e.example/1", 1, 999), Item(" 打工人周一 ", "https://e.example/2", 3)], "error": None, "stale": False}

            async def fetch_source(self, src):
                return self.entry

        hub = FakeHub()
        ch = HotListChannel(hub, Source("weibo", "微博热搜", "cn", "search", None))
        first, second = await ch.collect()
        self.assertEqual((ch.id, ch.name), ("weibo", "微博热搜"))
        self.assertEqual((first.score, first.metrics, first.extra["risk"]["level"]), (100.0, {"rank": 1, "hot": 999}, "avoid"))
        self.assertEqual((second.item_id, second.score, "risk" in second.extra), ("打工人周一", 96.0, False))

        hub.entry = {**hub.entry, "stale": True, "error": "超时"}
        with self.assertRaisesRegex(RuntimeError, "超时"):
            await ch.collect()


def link(short, full):
    return NS(tcourl=short, url=full, text=None)


def tweet(id_="1", text="Sora 2 is out\nsecond line https://t.co/abc", hours_ago=2, likes=1000, retweets=100,
          quoted=None, retweeted=None, reply_to=None, videos=None, links=None, username="alice"):
    return NS(
        id_str=id_, url=f"https://x.com/{username}/status/{id_}", date=now() - timedelta(hours=hours_ago), lang="en",
        rawContent=text, likeCount=likes, retweetCount=retweets, replyCount=10, quoteCount=5, viewCount=50000,
        user=NS(username=username, followersCount=1234),
        links=links if links is not None else [link("https://t.co/abc", "https://openai.com/sora")],
        media=NS(photos=[], videos=videos or []), quotedTweet=quoted, retweetedTweet=retweeted, inReplyToTweetId=reply_to,
    )


class XEntryTests(unittest.TestCase):
    def test_entry_keeps_full_text_with_expanded_links(self):
        e = to_entry(tweet(), "AI", now())
        self.assertEqual(e.title, "Sora 2 is out")
        self.assertEqual(e.text, "Sora 2 is out\nsecond line https://openai.com/sora")
        self.assertEqual(e.links, ["https://openai.com/sora"])
        self.assertEqual((e.author, e.item_id, e.metrics["likes"], e.metrics["views"]), ("@alice", "1", 1000, 50000))
        self.assertEqual(e.extra["matched"], ["AI"])

    def test_html_entities_are_unescaped(self):
        e = to_entry(tweet(text="&gt;Pope declares AI cringe &amp; more", links=[]), "AI", now())
        self.assertEqual((e.title, e.text), (">Pope declares AI cringe & more", ">Pope declares AI cringe & more"))

    def test_link_only_tweet_gets_a_readable_title(self):
        t = tweet(text="https://t.co/xyz", links=[], videos=[NS(duration=12500)])
        e = to_entry(t, "AI", now())
        self.assertEqual(e.title, "@alice 发布的视频")
        self.assertEqual((e.extra["hasVideo"], e.extra["videoSec"]), (True, 12))

    def test_quoted_tweet_text_is_kept(self):
        q = tweet("9", text="the real content https://t.co/abc", username="bob")
        e = to_entry(tweet(text="wow", quoted=q), "AI", now())
        self.assertEqual(e.extra["quoted"], {"author": "@bob", "text": "the real content https://openai.com/sora", "url": q.url})

    def test_long_title_is_truncated(self):
        self.assertEqual(len(to_entry(tweet(text="x" * 200), "AI", now()).title), 80)

    def test_heat_prefers_fast_rising_posts(self):
        t = now()
        fresh = heat(tweet(hours_ago=1, likes=2000, retweets=0), t)
        old = heat(tweet(hours_ago=40, likes=20000, retweets=0), t)
        self.assertGreater(fresh, old)
        self.assertLessEqual(heat(tweet(hours_ago=1, likes=10**9), t), 100)
        silent = tweet(likes=0, retweets=0)
        silent.replyCount = silent.quoteCount = 0
        self.assertEqual(heat(silent, t), 0)


class FakePool:
    def __init__(self, results):
        self.results, self.queries = results, []

    async def search_tweets(self, q, limit, product):
        self.queries.append((q, limit, product))
        value = self.results[q.split(" since:")[0]]
        if isinstance(value, Exception):
            raise value
        return value


def q(name, enabled=True):
    return {"name": name, "query": name, "enabled": enabled}


class XChannelTests(unittest.IsolatedAsyncioTestCase):
    async def test_collect_filters_and_merges_queries(self):
        shared = tweet("1")
        pool = FakePool({
            "AI": [shared, tweet("2", retweeted=tweet("8")), tweet("3", reply_to=7), tweet("4", hours_ago=50)],
            "Sora": [shared, tweet("5")],
        })
        entries = await XChannel(pool, [q("AI"), q("Sora"), q("关掉的", enabled=False)]).collect()

        self.assertEqual(sorted(e.item_id for e in entries), ["1", "5"])
        self.assertEqual(next(e for e in entries if e.item_id == "1").extra["matched"], ["AI", "Sora"])
        since = (now() - timedelta(hours=48)).date().isoformat()
        self.assertEqual(pool.queries[0][0], f"AI since:{since}")
        self.assertEqual(pool.queries[0][2], "Top")
        self.assertEqual(len(pool.queries), 2)  # 停用的语句不跑

    def test_validate_cleans_and_rejects_bad_settings(self):
        ch = XChannel(FakePool({}))
        ok = ch.validate({"queries": [{"name": " 生活 ", "query": "AI   kids\nmin_faves:100", "enabled": True}], "limit": "40"})
        self.assertEqual(ok, {"queries": [{"name": "生活", "query": "AI kids min_faves:100", "enabled": True}], "limit": 40})
        bad = [
            ({"queries": []}, "1–10"),
            ({"queries": [q("A"), q("a")]}, "重复"),
            ({"queries": [{"name": "A", "query": ""}]}, "不能为空"),
            ({"queries": [{"name": "A", "query": "AI since:2026-01-01"}]}, "since"),
            ({"queries": [q("A", enabled=False)]}, "至少要启用"),
            ({"queries": [q("A")], "limit": 500}, "20–100"),
            ({"queries": [{"name": "这个类别名字太长了超过", "query": "AI"}]}, "1–8"),
        ]
        for settings, msg in bad:
            with self.subTest(msg=msg), self.assertRaisesRegex(ValueError, msg):
                ch.validate(settings)

    async def test_one_failing_query_does_not_fail_the_run(self):
        entries = await XChannel(FakePool({"AI": RuntimeError("限流"), "Sora": [tweet("5")]}), [q("AI"), q("Sora")]).collect()
        self.assertEqual([e.item_id for e in entries], ["5"])

    async def test_all_queries_failing_raises(self):
        with self.assertRaisesRegex(RuntimeError, "限流"):
            await XChannel(FakePool({"AI": RuntimeError("限流")}), [q("AI")]).collect()


class NotReadyTests(unittest.IsolatedAsyncioTestCase):
    async def test_channel_that_is_not_ready_is_skipped_without_a_failed_run(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = await connect(Path(tmp.name) / "test.db")
        self.addAsyncCleanup(db.close)
        ch = FakeChannel("x")
        reason = "号池里还没有推特账号"

        async def not_ready():
            return reason
        ch.not_ready = not_ready
        s = Scheduler(db, [ch])

        self.assertEqual(await s.due(), [])
        self.assertEqual(await s.run("x"), {"channel": "x", "count": 0, "error": reason})
        self.assertEqual(await db.fetchval("select count(*) from runs"), 0)
        self.assertEqual((await s.status())[0]["notReady"], reason)

        reason = None
        self.assertEqual(await s.due(), ["x"])
        self.assertIsNone((await s.status())[0]["notReady"])


if __name__ == "__main__":
    unittest.main()
