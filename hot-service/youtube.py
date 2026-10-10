"""
YouTube 官方数据接口（YouTube Data API v3）：搜视频、查播放点赞评论数、读热门评论。
只要一个 API key，不登录、不受本机出口 IP 影响。key 在工作台「渠道 → YouTube」里填，
存在 data/youtube-key.json（只有本机账号能读，不进 git）；没填时用环境变量 YOUTUBE_API_KEY。

额度：每个 Google 项目每天 10000 点，太平洋时间零点恢复。
搜索一次 100 点；查视频数据（一次最多 50 条）、读评论各 1 点。
用掉多少记在 data/youtube-quota.json，渠道定时抓取会给 Claude 临时搜索留出一部分。
key 放在请求头里（不放网址），出错信息里也不会带出来。
"""
import json
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from channels.http import client
from config import DATA_DIR, YOUTUBE_API_KEY, YOUTUBE_DAILY_QUOTA

API = "https://www.googleapis.com/youtube/v3/"
COST = {"search": 100, "videos": 1, "commentThreads": 1}
QUOTA_FILE = DATA_DIR / "youtube-quota.json"
KEY_FILE = DATA_DIR / "youtube-key.json"
PACIFIC = ZoneInfo("America/Los_Angeles")
ORDERS = ("viewCount", "relevance", "date", "rating")
ID_RE = re.compile(r"(?:v=|youtu\.be/|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})")


class YouTubeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def video_id(s: str) -> str | None:
    """视频链接或 11 位视频 id 都行。"""
    s = (s or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", s):
        return s
    m = ID_RE.search(s)
    return m.group(1) if m else None


# ---------- key ----------
def _key() -> str | None:
    try:
        return json.loads(KEY_FILE.read_text(encoding="utf-8")).get("key") or YOUTUBE_API_KEY
    except (OSError, ValueError):
        return YOUTUBE_API_KEY


def key_status() -> dict:
    """只说有没有配、从哪来、末 4 位，不返回 key 本身。"""
    k = _key()
    source = "page" if KEY_FILE.exists() and k and k != YOUTUBE_API_KEY else "env" if k else None
    return {"configured": bool(k), "source": source, "tail": k[-4:] if k else None}


async def set_key(key: str) -> dict:
    """先用这个 key 查一条视频（1 点额度）确认能用，再存下来。"""
    key = (key or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,100}", key):
        raise YouTubeError("bad_input", "key 格式不对：应该是一串 39 位左右的字母数字，通常以 AIza 开头")
    await _get("videos", {"part": "id", "id": "dQw4w9WgXcQ"}, key=key)
    KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    KEY_FILE.write_text(json.dumps({"key": key}), encoding="utf-8")
    KEY_FILE.chmod(0o600)
    return key_status()


def clear_key() -> dict:
    KEY_FILE.unlink(missing_ok=True)
    return key_status()


# ---------- 额度记账 ----------
def _today() -> str:
    return datetime.now(PACIFIC).date().isoformat()


def _load() -> dict:
    try:
        q = json.loads(QUOTA_FILE.read_text(encoding="utf-8"))
        return q if q.get("day") == _today() else {"day": _today(), "used": 0}
    except (OSError, ValueError):
        return {"day": _today(), "used": 0}


def _save(q: dict) -> None:
    QUOTA_FILE.parent.mkdir(parents=True, exist_ok=True)
    QUOTA_FILE.write_text(json.dumps(q), encoding="utf-8")


def quota() -> dict:
    q = _load()
    reset = (datetime.now(PACIFIC) + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return {**key_status(), "used": q["used"], "limit": YOUTUBE_DAILY_QUOTA,
            "left": max(0, YOUTUBE_DAILY_QUOTA - q["used"]), "resetsAt": reset.astimezone().strftime("%Y-%m-%dT%H:%M")}


def _spend(n: int) -> None:
    q = _load()
    q["used"] += n
    _save(q)


def _exhaust() -> None:
    """Google 说额度用完了，就按用完记，免得今天再白白请求。"""
    q = _load()
    q["used"] = max(q["used"], YOUTUBE_DAILY_QUOTA)
    _save(q)


# ---------- 请求 ----------
async def _get(method: str, params: dict, key: str | None = None) -> dict:
    key = key or _key()
    if not key:
        raise YouTubeError("no_key", "还没填 YouTube 的 API key：在工作台「渠道 → YouTube」里填")
    cost = COST[method]
    if quota()["left"] < cost:
        raise YouTubeError("quota", "今天的 YouTube 额度用完了，太平洋时间零点（北京时间下午三四点）恢复")
    res = await client().get(API + method, params=params, headers={"x-goog-api-key": key})
    _spend(cost)
    if res.status_code >= 400:
        try:
            err = res.json().get("error", {})
        except ValueError:
            err = {}
        reason = ((err.get("errors") or [{}])[0]).get("reason", "")
        msg = err.get("message") or f"HTTP {res.status_code}"
        if reason in ("quotaExceeded", "dailyLimitExceeded"):
            _exhaust()
            raise YouTubeError("quota", "今天的 YouTube 额度用完了，太平洋时间零点（北京时间下午三四点）恢复")
        if reason == "commentsDisabled":
            raise YouTubeError("comments_disabled", "这条视频关闭了评论")
        if res.status_code in (400, 403) and ("API key" in msg or reason in ("keyInvalid", "accessNotConfigured", "forbidden")):
            raise YouTubeError("bad_key", f"YouTube 拒绝了这个 API key：{msg}（检查 key 是否填对、项目里是否启用了 YouTube Data API v3）")
        raise YouTubeError("upstream", f"YouTube 接口出错：{msg}")
    return res.json()


def _iso_secs(d: str | None) -> int | None:
    """PT1H2M3S 换成秒。"""
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", d or "")
    if not m:
        return None
    dd, h, mi, s = (int(x or 0) for x in m.groups())
    return dd * 86400 + h * 3600 + mi * 60 + s


def _int(v) -> int | None:
    return int(v) if v not in (None, "") else None


def _video(v: dict) -> dict:
    sn, st, cd = v.get("snippet", {}), v.get("statistics", {}), v.get("contentDetails", {})
    secs = _iso_secs(cd.get("duration"))
    thumbs = sn.get("thumbnails", {})
    thumb = next((thumbs[k]["url"] for k in ("maxres", "standard", "high", "medium", "default") if k in thumbs), None)
    return {
        "id": v["id"], "url": f"https://www.youtube.com/watch?v={v['id']}",
        "title": sn.get("title", ""), "channel": sn.get("channelTitle", ""), "channelId": sn.get("channelId"),
        "publishedAt": sn.get("publishedAt"), "description": sn.get("description", ""),
        "tags": (sn.get("tags") or [])[:15], "lang": sn.get("defaultAudioLanguage") or sn.get("defaultLanguage"),
        "durationSec": secs, "short": secs is not None and secs <= 180,
        "views": _int(st.get("viewCount")), "likes": _int(st.get("likeCount")), "comments": _int(st.get("commentCount")),
        "thumbnail": thumb, "captions": cd.get("caption") == "true",
    }


async def videos(ids: list[str]) -> list[dict]:
    """视频详情和数据，按给的顺序返回（不存在或已删除的跳过）。每 50 条 1 点额度。"""
    ids = list(dict.fromkeys(i for i in ids if i))
    out: dict[str, dict] = {}
    for i in range(0, len(ids), 50):
        r = await _get("videos", {"part": "snippet,statistics,contentDetails", "id": ",".join(ids[i:i + 50]), "maxResults": 50})
        for v in r.get("items", []):
            out[v["id"]] = _video(v)
    return [out[i] for i in ids if i in out]


async def search(q: str, days: float | None = 7, order: str = "viewCount", limit: int = 25, lang: str | None = None,
                 region: str | None = None) -> list[dict]:
    """
    按关键词搜视频，再补上播放、点赞、评论数。100 点 + 1 点额度。
    q 支持 `A|B`（任意一个）、`-词`（排除）、"精确短语"。days 只看最近多少天发布的，None 不限。
    """
    if order not in ORDERS:
        raise YouTubeError("bad_input", f"order 只能是 {' / '.join(ORDERS)}")
    params = {"part": "snippet", "q": q, "type": "video", "order": order, "maxResults": max(1, min(int(limit), 50))}
    if days:
        params["publishedAfter"] = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    if lang:
        params["relevanceLanguage"] = lang
    if region:
        params["regionCode"] = region
    r = await _get("search", params)
    ids = [it["id"]["videoId"] for it in r.get("items", []) if it.get("id", {}).get("videoId")]
    return await videos(ids) if ids else []


async def comments(vid: str, limit: int = 20, order: str = "relevance") -> list[dict]:
    """热门（relevance）或最新（time）评论，只取一级评论和回复数。1 点额度。"""
    r = await _get("commentThreads", {"part": "snippet", "videoId": vid, "order": order, "textFormat": "plainText",
                                      "maxResults": max(1, min(int(limit), 100))})
    out = []
    for it in r.get("items", []):
        top = it["snippet"]["topLevelComment"]["snippet"]
        out.append({"author": top.get("authorDisplayName"), "text": top.get("textDisplay", ""), "likes": top.get("likeCount", 0),
                    "replies": it["snippet"].get("totalReplyCount", 0), "publishedAt": top.get("publishedAt")})
    return out
