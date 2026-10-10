"""
视频素材的字幕和拆解报告，存在 video_notes 表，按视频 id 和素材绑定。

字幕：用 yt-dlp 只读视频信息、取一份字幕（作者上传的优先，没有就用自动生成的原语言字幕），不下载视频。
先不带登录拉；YouTube 要求“登录以确认不是机器人”时，如果用户在「渠道 → YouTube」登录了自己的账号，
就用导出的 cookie 再试一次（限量：每天最多 YT_LOGIN_DAILY_CAP 次、两次至少隔 YT_LOGIN_MIN_GAP_SEC 秒）；
登录了也被拦，就判定登录失效、提醒重新登录。不用 PO Token、代理这类模拟验证或躲检测的办法。
没拿到的记下原因，6 小时内不自动重试，手动「重新拉字幕」可以随时再试。
拆解报告由 Claude 写好后存进来，精选、出题、调研、写脚本都读这一份。
"""
import asyncio
import html
import json
import re
import time
from datetime import date
from pathlib import Path

import yt_dlp

import config
from channels.http import client
from db import DB

RETRY_AFTER = 6 * 3600  # 上次没拿到字幕，多久之内不自动重试
WATCH = "https://www.youtube.com/watch?v={}"
TIME_RE = re.compile(r"^(\d+:)?\d{1,2}:\d{2}[.,]\d{3}\s+-->")
TAG_RE = re.compile(r"<[^>]+>")


class NoteError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _clock(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}" if sec >= 3600 else f"{sec // 60}:{sec % 60:02d}"


def _secs(stamp: str) -> float:
    parts = stamp.replace(",", ".").split(":")
    return sum(float(p) * 60 ** i for i, p in enumerate(reversed(parts)))


def parse_vtt(text: str, every: float = 20) -> str:
    """
    WebVTT 整理成纯文字，大约每 every 秒一段，段首带时间。
    自动字幕是滚动显示的，同一句会在相邻几条里重复出现，只保留新出现的那一行。
    """
    out, buf, start, last = [], [], None, ""
    t = 0.0
    for line in text.splitlines():
        line = line.strip()
        if not line or line == "WEBVTT" or line.isdigit() or line.startswith(("Kind:", "Language:", "NOTE", "STYLE")):
            continue
        if TIME_RE.match(line):
            t = _secs(line.split("-->")[0].strip())
            continue
        words = html.unescape(TAG_RE.sub("", line)).strip()
        if not words or words == last:
            continue
        last = words
        if start is None:
            start = t
        elif t - start >= every and buf:
            out.append(f"[{_clock(start)}] " + " ".join(buf))
            buf, start = [], t
        buf.append(words)
    if buf:
        out.append(f"[{_clock(start or 0)}] " + " ".join(buf))
    return "\n".join(out)


def pick_track(info: dict) -> tuple[str, str, str] | None:
    """选一份字幕，返回 (语言, manual|auto, 字幕地址)。作者上传的优先，按视频本身的语言、英文、中文的顺序选。"""
    lang = (info.get("language") or "").split("-")[0]

    def vtt(formats):
        return next((f["url"] for f in formats or [] if f.get("ext") == "vtt" and f.get("url")), None)

    def order(keys, prefer_orig):
        keys = list(keys)
        ranked = []
        if prefer_orig:  # 自动字幕里 xx-orig 是原语言识别出来的，其余多是机器翻译
            ranked += [k for k in keys if k.endswith("-orig")]
        for want in [lang, "en", "zh-Hans", "zh-Hant", "zh"]:
            if want:
                ranked += [k for k in keys if k == want or k.split("-")[0] == want]
        return list(dict.fromkeys(ranked + ([] if prefer_orig else keys)))

    subs = {k: v for k, v in (info.get("subtitles") or {}).items() if k != "live_chat"}
    for k in order(subs, False):
        url = vtt(subs[k])
        if url:
            return k, "manual", url
    autos = info.get("automatic_captions") or {}
    for k in order(autos, True):
        url = vtt(autos[k])
        if url:
            return k, "auto", url
    return None


def _extract(video_id: str, cookiefile: str | None = None) -> dict:
    opts = {"skip_download": True, "quiet": True, "no_warnings": True, "noplaylist": True}
    if cookiefile:
        opts["cookiefile"] = cookiefile
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(WATCH.format(video_id), download=False)


# ---------- 登录（可选）：用量和是否失效记在 data/youtube-login.json ----------
def _login_file() -> Path:
    return Path(config.DATA_DIR) / "youtube-login.json"


def _login_state() -> dict:
    try:
        st = json.loads(_login_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        st = {}
    if st.get("day") != date.today().isoformat():
        st.update(day=date.today().isoformat(), used=0)
    return st


def _save_login_state(st: dict) -> None:
    _login_file().parent.mkdir(parents=True, exist_ok=True)
    _login_file().write_text(json.dumps(st), encoding="utf-8")


def login_status() -> dict:
    """给页面看：有没有登录的 cookie、是否失效、今天用了几次。"""
    st = _login_state()
    has = bool(config.YT_COOKIES_FILE) and Path(config.YT_COOKIES_FILE).exists()
    return {"cookies": has, "expired": bool(st.get("expired")) if has else False, "error": st.get("error") if has else None,
            "okAt": st.get("okAt"), "lastAt": st.get("lastAt"), "usedToday": st.get("used", 0), "dailyCap": config.YT_LOGIN_DAILY_CAP}


async def _extract_logged_in(video_id: str) -> dict:
    """不带登录被拦之后，用登录再试一次。限量，登录了也被拦就判定失效。"""
    st = _login_state()
    if st.get("used", 0) >= config.YT_LOGIN_DAILY_CAP:
        raise NoteError("login_limited", f"今天用登录拉字幕已经 {config.YT_LOGIN_DAILY_CAP} 次了，为了保护账号先停一停，明天再试")
    wait = (st.get("lastAt") or 0) + config.YT_LOGIN_MIN_GAP_SEC - time.time()
    if wait > 0:
        await asyncio.sleep(wait)
    st.update(used=st.get("used", 0) + 1, lastAt=time.time())
    _save_login_state(st)
    try:
        info = await asyncio.to_thread(_extract, video_id, config.YT_COOKIES_FILE)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        # 登录了还被要求验证或登录，才算登录失效；请求太频繁只是限流，不算
        if ("confirm you" in msg and "bot" in msg) or "Sign in" in msg:
            st.update(expired=True, error="用登录拉字幕也被 YouTube 要求验证，登录可能失效了")
            _save_login_state(st)
            raise NoteError("login_expired", "YouTube 登录已失效（用登录也被要求验证），去「渠道 → YouTube」重新登录") from e
        raise explain(e) from e
    st.update(expired=False, error=None, okAt=time.time())
    _save_login_state(st)
    return info


def explain(err: Exception) -> NoteError:
    msg = str(err)
    if "confirm you" in msg and "bot" in msg:
        return NoteError("blocked", "YouTube 要求验证不是机器人，这次拿不到字幕（不去绕过它的检测），稍后再试")
    if "429" in msg or "Too Many Requests" in msg:
        return NoteError("blocked", "YouTube 说请求太频繁，这次拿不到字幕，稍后再试")
    if "Private video" in msg or "unavailable" in msg.lower():
        return NoteError("unavailable", "视频不可用（私密、已删除或有地区限制）")
    return NoteError("failed", f"拿字幕出错：{msg[:200]}")


async def fetch_transcript(video_id: str) -> dict:
    """读视频信息、下载一份字幕并整理成文字。不碰数据库。"""
    try:
        info = await asyncio.to_thread(_extract, video_id)
    except Exception as e:  # noqa: BLE001 — yt-dlp 的错误类型很多，统一换成能读懂的原因
        err = explain(e)
        if err.code != "blocked" or not login_status()["cookies"]:
            raise err from e
        info = await _extract_logged_in(video_id)  # 被要求验证、又登录过：用登录再试一次
    track = pick_track(info)
    if not track:
        raise NoteError("no_subtitles", "这条视频没有字幕，也没有自动生成的字幕")
    lang, source, url = track
    res = await client().get(url)
    if res.status_code == 429:
        raise NoteError("blocked", "YouTube 说请求太频繁，这次拿不到字幕，稍后再试")
    if res.status_code >= 400:
        raise NoteError("failed", f"下载字幕失败：HTTP {res.status_code}")
    text = parse_vtt(res.text)
    if not text:
        raise NoteError("no_subtitles", "字幕是空的")
    return {"title": info.get("title"), "lang": lang, "source": source, "text": text}


def _out(r) -> dict:
    return {
        "videoId": r["video_id"], "title": r["title"],
        "transcript": r["transcript"], "lang": r["transcript_lang"], "source": r["transcript_source"],
        "transcriptAt": r["transcript_at"], "error": r["transcript_error"],
        "teardown": r["teardown"], "teardownAt": r["teardown_at"],
    }


class VideoNotes:
    def __init__(self, db: DB, fetch=fetch_transcript):
        self.db = db
        self.fetch = fetch
        self.locks: dict[str, asyncio.Lock] = {}

    async def get(self, video_id: str, platform: str = "youtube") -> dict | None:
        r = await self.db.fetchrow("select * from video_notes where platform = ? and video_id = ?", platform, video_id)
        return _out(r) if r else None

    async def _upsert(self, video_id: str, **fields) -> None:
        cols = ", ".join(fields)
        marks = ", ".join("?" * len(fields))
        sets = ", ".join(f"{k} = excluded.{k}" for k in fields)
        await self.db.execute(
            f"insert into video_notes (platform, video_id, {cols}) values ('youtube', ?, {marks}) "
            f"on conflict (platform, video_id) do update set {sets}",
            video_id, *fields.values(),
        )

    async def transcript(self, video_id: str, refresh: bool = False) -> dict:
        """有存好的字幕就直接给；没有（或者要求重新拉）才去 YouTube 拿。同一条视频同时只拉一次。"""
        lock = self.locks.setdefault(video_id, asyncio.Lock())
        async with lock:
            cur = await self.get(video_id)
            if cur and not refresh:
                if cur["transcript"]:
                    return {**cur, "cached": True}
                if cur["error"] and time.time() - (cur["transcriptAt"] or 0) < RETRY_AFTER:
                    return {**cur, "cached": True}
            try:
                got = await self.fetch(video_id)
            except NoteError as e:
                await self._upsert(video_id, transcript_error=str(e), transcript_at=time.time())
                raise
            await self._upsert(video_id, title=got["title"], transcript=got["text"], transcript_lang=got["lang"],
                               transcript_source=got["source"], transcript_at=time.time(), transcript_error=None)
            return {**await self.get(video_id), "cached": False}

    async def save_teardown(self, video_id: str, text: str, title: str | None = None) -> dict:
        fields = {"teardown": text, "teardown_at": time.time()}
        if title:
            fields["title"] = title
        await self._upsert(video_id, **fields)
        return await self.get(video_id)

    async def status(self, ids: list[str]) -> dict[str, dict]:
        """素材页用：每条视频有没有字幕、有没有拆解，不返回正文。"""
        if not ids:
            return {}
        rows = await self.db.fetch(
            f"select video_id, transcript is not null as has_transcript, transcript_error, transcript_at, teardown_at "
            f"from video_notes where platform = 'youtube' and video_id in ({', '.join('?' * len(ids))})", *ids,
        )
        return {r["video_id"]: {"transcript": bool(r["has_transcript"]), "error": r["transcript_error"],
                                "transcriptAt": r["transcript_at"], "teardownAt": r["teardown_at"]} for r in rows}
