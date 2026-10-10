"""视频字幕和拆解报告的测试。不访问 YouTube：拉字幕用假函数代替，字幕内容是合成的。"""

import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config
import videonotes
from db import connect
from videonotes import NoteError, VideoNotes, parse_vtt, pick_track

VTT = """WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.000
<c>first</c> line here

00:00:01.500 --> 00:00:03.000
first line here
second line

00:00:21.000 --> 00:00:23.000
third &amp; last
"""


class ParseTests(unittest.TestCase):
    def test_rolling_duplicates_are_dropped_and_paragraphs_are_timed(self):
        self.assertEqual(parse_vtt(VTT), "[0:00] first line here second line\n[0:21] third & last")

    def test_long_videos_get_hour_stamps(self):
        vtt = "WEBVTT\n\n01:02:03.000 --> 01:02:05.000\nlate words\n"
        self.assertEqual(parse_vtt(vtt), "[1:02:03] late words")

    def test_empty(self):
        self.assertEqual(parse_vtt("WEBVTT\n\n"), "")


def fmt(url):
    return [{"ext": "json3", "url": url + ".json"}, {"ext": "vtt", "url": url}]


class PickTrackTests(unittest.TestCase):
    def test_manual_subtitles_win_over_auto(self):
        info = {"language": "en", "subtitles": {"en": fmt("m-en")}, "automatic_captions": {"en-orig": fmt("a-en")}}
        self.assertEqual(pick_track(info), ("en", "manual", "m-en"))

    def test_auto_prefers_english_even_when_machine_translated(self):
        info = {"language": "ja", "automatic_captions": {"de": fmt("a-de"), "en": fmt("a-en"), "ja-orig": fmt("a-ja")}}
        self.assertEqual(pick_track(info), ("en", "auto", "a-en"))
        info = {"language": "ja", "automatic_captions": {"de": fmt("a-de"), "ja-orig": fmt("a-ja")}}
        self.assertEqual(pick_track(info), ("ja-orig", "auto", "a-ja"))

    def test_chinese_videos_keep_chinese(self):
        info = {"language": "zh-CN", "automatic_captions": {"en": fmt("a-en"), "zh-Hans": fmt("a-zh")}}
        self.assertEqual(pick_track(info), ("zh-Hans", "auto", "a-zh"))

    def test_misheard_original_language_loses_to_the_title_language(self):
        info = {"title": "I made an automatic stoplight", "automatic_captions": {"bn-orig": fmt("a-bn"), "en-orig": fmt("a-en-orig"), "en": fmt("a-en")}}
        self.assertEqual(pick_track(info), ("en-orig", "auto", "a-en-orig"))
        info = {"title": "大模型到底会不会记住你", "automatic_captions": {"bn-orig": fmt("a-bn"), "zh-Hans": fmt("a-zh")}}
        self.assertEqual(pick_track(info), ("zh-Hans", "auto", "a-zh"))

    def test_manual_prefers_english_then_the_video_language(self):
        info = {"language": "fr", "subtitles": {"de": fmt("m-de"), "en": fmt("m-en")}}
        self.assertEqual(pick_track(info), ("en", "manual", "m-en"))
        info = {"language": "fr", "subtitles": {"fr-FR": fmt("m-fr"), "en": fmt("m-en")}}
        self.assertEqual(pick_track(info), ("en", "manual", "m-en"))
        info = {"language": "fr", "subtitles": {"fr-FR": fmt("m-fr")}, "automatic_captions": {"en": fmt("a-en")}}
        self.assertEqual(pick_track(info), ("fr-FR", "manual", "m-fr"))  # 作者上传的优先于自动生成的

    def test_live_chat_and_missing_vtt_are_ignored(self):
        info = {"subtitles": {"live_chat": [{"ext": "json", "url": "x"}], "en": [{"ext": "json3", "url": "j"}]}}
        self.assertIsNone(pick_track(info))

    def test_bot_wall_is_reported_not_bypassed(self):
        e = videonotes.explain(Exception("ERROR: Sign in to confirm you're not a bot"))
        self.assertEqual(e.code, "blocked")
        self.assertIn("不去绕过", str(e))


class OptsTests(unittest.TestCase):
    def test_node_solves_youtube_challenges_and_cookies_only_when_given(self):
        with mock.patch.object(config, "YT_NODE", "/usr/local/bin/node"):
            self.assertEqual(videonotes.ydl_opts()["js_runtimes"], {"node": {"path": "/usr/local/bin/node"}})
            self.assertNotIn("cookiefile", videonotes.ydl_opts())
            self.assertEqual(videonotes.ydl_opts("/tmp/c.txt")["cookiefile"], "/tmp/c.txt")
        with mock.patch.object(config, "YT_NODE", ""):
            self.assertNotIn("js_runtimes", videonotes.ydl_opts())


class NotesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db = await connect(Path(tmp.name) / "hot.db")
        self.addAsyncCleanup(self.db.close)
        self.calls = []
        self.result = {"title": "视频标题", "lang": "en", "source": "auto", "text": "[0:00] words"}

        async def fetch(vid):
            self.calls.append(vid)
            if isinstance(self.result, Exception):
                raise self.result
            return self.result

        self.notes = VideoNotes(self.db, fetch)

    async def test_transcript_is_fetched_once_and_reused(self):
        first = await self.notes.transcript("abcdefghijk")
        second = await self.notes.transcript("abcdefghijk")
        self.assertEqual(self.calls, ["abcdefghijk"])
        self.assertEqual((first["cached"], second["cached"]), (False, True))
        self.assertEqual((second["transcript"], second["title"], second["lang"]), ("[0:00] words", "视频标题", "en"))

    async def test_refresh_fetches_again(self):
        await self.notes.transcript("abcdefghijk")
        self.result = {**self.result, "text": "[0:00] newer"}
        r = await self.notes.transcript("abcdefghijk", refresh=True)
        self.assertEqual((len(self.calls), r["transcript"]), (2, "[0:00] newer"))

    async def test_failure_is_remembered_and_not_retried_automatically(self):
        self.result = NoteError("blocked", "被拦了")
        with self.assertRaises(NoteError):
            await self.notes.transcript("abcdefghijk")
        r = await self.notes.transcript("abcdefghijk")
        self.assertEqual((r["error"], r["transcript"], len(self.calls)), ("被拦了", None, 1))
        # 过了重试间隔，或者手动重新拉，会再试
        with mock.patch.object(videonotes.time, "time", return_value=time.time() + videonotes.RETRY_AFTER + 1):
            self.result = {"title": "t", "lang": "en", "source": "manual", "text": "[0:00] ok"}
            r = await self.notes.transcript("abcdefghijk")
        self.assertEqual((r["transcript"], r["error"], len(self.calls)), ("[0:00] ok", None, 2))

    async def test_teardown_is_bound_to_the_video_and_kept_when_transcript_refreshes(self):
        await self.notes.transcript("abcdefghijk")
        await self.notes.save_teardown("abcdefghijk", "## 拆解报告")
        await self.notes.transcript("abcdefghijk", refresh=True)
        r = await self.notes.get("abcdefghijk")
        self.assertEqual((r["teardown"], r["transcript"]), ("## 拆解报告", "[0:00] words"))
        self.assertIsNotNone(r["teardownAt"])

    async def test_teardown_can_exist_without_a_transcript(self):
        await self.notes.save_teardown("abcdefghijk", "## 只用简介和评论拆的", title="标题")
        r = await self.notes.get("abcdefghijk")
        self.assertEqual((r["teardown"], r["title"], r["transcript"]), ("## 只用简介和评论拆的", "标题", None))

    async def test_status_lists_what_each_video_has(self):
        await self.notes.transcript("aaaaaaaaaaa")
        await self.notes.save_teardown("bbbbbbbbbbb", "## 拆解")
        s = await self.notes.status(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"])
        self.assertEqual(set(s), {"aaaaaaaaaaa", "bbbbbbbbbbb"})
        self.assertTrue(s["aaaaaaaaaaa"]["transcript"])
        self.assertIsNone(s["aaaaaaaaaaa"]["teardownAt"])
        self.assertFalse(s["bbbbbbbbbbb"]["transcript"])
        self.assertIsNotNone(s["bbbbbbbbbbb"]["teardownAt"])


BOT = Exception("ERROR: [youtube] x: Sign in to confirm you're not a bot. Use --cookies-from-browser")


class LoginFallbackTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.cookies = Path(tmp.name) / "youtube-cookies.txt"
        self.cookies.write_text("# Netscape HTTP Cookie File\n")
        self.calls = []
        self.with_cookies = {"language": "en", "subtitles": {"en": fmt("m-en")}, "title": "标题"}

        def fetch(vid, cookiefile=None):
            self.calls.append(cookiefile)
            if cookiefile is None:
                raise BOT
            if isinstance(self.with_cookies, Exception):
                raise self.with_cookies
            track = pick_track(self.with_cookies)
            return self.with_cookies, track, VTT if track else None

        patches = [mock.patch.object(config, "DATA_DIR", Path(tmp.name)), mock.patch.object(config, "YT_COOKIES_FILE", str(self.cookies)),
                   mock.patch.object(config, "YT_LOGIN_MIN_GAP_SEC", 0), mock.patch.object(config, "YT_LOGIN_DAILY_CAP", 2),
                   mock.patch.object(videonotes, "_fetch", fetch)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    async def test_without_login_the_block_is_reported(self):
        self.cookies.unlink()
        with self.assertRaises(NoteError) as raised:
            await videonotes.fetch_transcript("abcdefghijk")
        self.assertEqual((raised.exception.code, self.calls), ("blocked", [None]))

    async def test_blocked_request_is_retried_once_with_the_login(self):
        got = await videonotes.fetch_transcript("abcdefghijk")
        self.assertEqual(self.calls, [None, str(self.cookies)])
        self.assertEqual((got["source"], got["title"]), ("manual", "标题"))
        st = videonotes.login_status()
        self.assertEqual((st["cookies"], st["expired"], st["usedToday"]), (True, False, 1))
        self.assertIsNotNone(st["okAt"])

    async def test_still_blocked_with_login_marks_it_expired(self):
        self.with_cookies = BOT
        with self.assertRaises(NoteError) as raised:
            await videonotes.fetch_transcript("abcdefghijk")
        self.assertEqual(raised.exception.code, "login_expired")
        self.assertTrue(videonotes.login_status()["expired"])

    async def test_rate_limit_with_login_is_not_expiry(self):
        self.with_cookies = Exception("HTTP Error 429: Too Many Requests")
        with self.assertRaises(NoteError) as raised:
            await videonotes.fetch_transcript("abcdefghijk")
        self.assertEqual(raised.exception.code, "blocked")
        self.assertFalse(videonotes.login_status()["expired"])

    async def test_logged_in_requests_queue_up_with_a_gap(self):
        import asyncio
        with mock.patch.object(config, "YT_LOGIN_MIN_GAP_SEC", 0.2), mock.patch.object(config, "YT_LOGIN_DAILY_CAP", 10):
            t0 = time.monotonic()
            await asyncio.gather(*(videonotes.fetch_transcript(v) for v in ("aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc")))
            self.assertGreaterEqual(time.monotonic() - t0, 0.4)  # 三条排队，中间两个间隔
        self.assertEqual(self.calls.count(str(self.cookies)), 3)

    async def test_daily_cap_protects_the_account(self):
        await videonotes.fetch_transcript("abcdefghijk")
        await videonotes.fetch_transcript("bcdefghijkl")
        with self.assertRaises(NoteError) as raised:
            await videonotes.fetch_transcript("cdefghijklm")
        self.assertEqual(raised.exception.code, "login_limited")
        self.assertEqual(self.calls.count(str(self.cookies)), 2)


if __name__ == "__main__":
    unittest.main()
