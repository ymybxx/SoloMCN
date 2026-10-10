"""YouTube 渠道和接口封装的测试。不访问 YouTube：搜索用假函数代替，额度文件放临时目录。"""

import asyncio
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import youtube
from channels.youtube import DEFAULT_QUERIES, YouTubeChannel, heat


def fake_video(vid: str, views: int, hours_ago: float) -> dict:
    t = (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"id": vid, "url": f"https://www.youtube.com/watch?v={vid}", "title": f"视频 {vid}", "channel": "频道",
            "channelId": "c1", "publishedAt": t, "description": "简介", "tags": ["a"], "lang": "en", "durationSec": 600,
            "short": False, "views": views, "likes": 10, "comments": 2, "thumbnail": None, "captions": True}


class HelperTests(unittest.TestCase):
    def test_video_id(self):
        for s in ["dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3", "https://youtu.be/dQw4w9WgXcQ",
                  "https://www.youtube.com/shorts/dQw4w9WgXcQ"]:
            self.assertEqual(youtube.video_id(s), "dQw4w9WgXcQ")
        self.assertIsNone(youtube.video_id("https://example.com/x"))

    def test_duration(self):
        self.assertEqual(youtube._iso_secs("PT1H2M3S"), 3723)
        self.assertEqual(youtube._iso_secs("PT45S"), 45)
        self.assertIsNone(youtube._iso_secs(None))

    def test_heat(self):
        now = datetime.now(timezone.utc)
        self.assertLess(heat(100, now - timedelta(hours=10), now), heat(1_000_000, now - timedelta(hours=10), now))
        self.assertEqual(heat(10**9, now - timedelta(hours=1), now), 100.0)


class ChannelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patches = [mock.patch.object(youtube, "QUOTA_FILE", Path(self.tmp.name) / "q.json"),
                        mock.patch.object(youtube, "YOUTUBE_API_KEY", "test"),
                        mock.patch.object(youtube, "KEY_FILE", Path(self.tmp.name) / "k.json")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_validate(self):
        ch = YouTubeChannel()
        ok = ch.validate({"queries": [{"name": "a", "query": "x|y", "lang": "zh-Hans"}], "days": 3, "limit": 20})
        self.assertEqual(ok["queries"][0]["lang"], "zh-Hans")
        for bad in [{"queries": []}, {"queries": [{"name": "a", "query": ""}]},
                    {"queries": [{"name": "a", "query": "x"}, {"name": "A", "query": "y"}]},
                    {"queries": [{"name": "a", "query": "x", "enabled": False}]},
                    {"queries": [{"name": "a", "query": "x", "lang": "中文"}]},
                    {"queries": [{"name": "a", "query": "x"}], "days": 60}]:
            with self.assertRaises(ValueError):
                ch.validate(bad)

    def test_collect_merges_groups(self):
        ch = YouTubeChannel()
        ch.apply({"queries": [{"name": "g1", "query": "a", "enabled": True}, {"name": "g2", "query": "b", "enabled": True}]})
        results = {"a": [fake_video("aaaaaaaaaaa", 5000, 5), fake_video("bbbbbbbbbbb", 100, 50)], "b": [fake_video("aaaaaaaaaaa", 5000, 5)]}

        async def fake_search(q, **_):
            return results[q]

        with mock.patch.object(youtube, "search", fake_search):
            entries = asyncio.run(ch.collect())
        by = {e.item_id: e for e in entries}
        self.assertEqual(by["aaaaaaaaaaa"].extra["matched"], ["g1", "g2"])
        self.assertGreater(by["aaaaaaaaaaa"].score, by["bbbbbbbbbbb"].score)

    def test_collect_keeps_reserve(self):
        ch = YouTubeChannel()
        youtube._save({"day": youtube._today(), "used": youtube.YOUTUBE_DAILY_QUOTA - 100})
        with self.assertRaises(RuntimeError):
            asyncio.run(ch.collect())

    def test_key_status_hides_key(self):
        st = youtube.key_status()
        self.assertEqual(st, {"configured": True, "source": "env", "tail": "test"})
        youtube.KEY_FILE.write_text('{"key": "AIzaPAGEKEY1234"}')
        self.assertEqual(youtube.key_status()["source"], "page")
        self.assertNotIn("AIzaPAGEKEY1234", json.dumps(youtube.quota()))
        youtube.clear_key()
        self.assertEqual(youtube.key_status()["source"], "env")

    def test_defaults_valid(self):
        YouTubeChannel().validate({"queries": DEFAULT_QUERIES})


class NotReadyTests(unittest.IsolatedAsyncioTestCase):
    async def test_channel_waits_for_a_key(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(youtube, "KEY_FILE", Path(d) / "youtube-key.json"), \
                mock.patch.object(youtube, "YOUTUBE_API_KEY", None):
            ch = YouTubeChannel()
            self.assertIn("API key", await ch.not_ready())
            youtube.KEY_FILE.write_text(json.dumps({"key": "AIza" + "x" * 35}), encoding="utf-8")
            self.assertIsNone(await ch.not_ready())


if __name__ == "__main__":
    unittest.main()
