"""
热点数据服务。启动：
    .venv/bin/python app.py
默认监听 http://127.0.0.1:5179 ，接口文档在 /docs。
"""
import asyncio
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import uvicorn
from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from channels.douyin import DouyinChannel
from channels.hotlist import HotListChannel
from channels.x import XChannel
from channels.youtube import YouTubeChannel
from config import DB_PATH, FETCH_INTERVAL_MIN, HOST, PORT
from hub import SOURCES, Hub
from scheduler import Busy, Scheduler
from db import connect
from xpool import PoolError, XPool
from videonotes import NoteError, VideoNotes
import youtube

hub = Hub()
xpool = XPool()
notes: VideoNotes | None = None
scheduler: Scheduler | None = None


async def refresh_loop():
    """定时抓一遍所有热榜，攒下连续的历史快照，“新上榜”“上升”才判断得准。"""
    while True:
        try:
            await hub.fetch_all(force=True)
        except Exception as e:  # noqa: BLE001
            print(f"[hub] 定时抓取出错：{e}")
        await asyncio.sleep(FETCH_INTERVAL_MIN * 60)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global scheduler, notes
    db = await connect(DB_PATH)
    await xpool.start(db)
    notes = VideoNotes(db)
    # 抖音有自己的渠道（数据更全），其余榜单包一层复用热榜中心的抓取和缓存
    lists = [HotListChannel(hub, s) for s in SOURCES if s.id != "douyin"]
    scheduler = Scheduler(db, [XChannel(xpool), YouTubeChannel(), DouyinChannel(), *lists])
    await scheduler.load()
    tasks = [asyncio.create_task(refresh_loop()), asyncio.create_task(xpool.background()), asyncio.create_task(scheduler.loop())]
    yield
    for t in tasks:
        t.cancel()
    await db.close()


app = FastAPI(title="热点数据服务", lifespan=lifespan)

LOOPBACK = {"127.0.0.1", "localhost", "::1"}


@app.middleware("http")
async def only_from_self(request: Request, call_next):
    """只接受本机程序（工作台）和同源页面的请求，挡住别的网站借浏览器来调：
    Host 不是本机地址的拒绝（DNS 重绑定），带 Origin 的必须同源（CSRF）。
    用 HOT_HOST=0.0.0.0 开放给局域网时只校验同源。"""
    host = request.headers.get("host", "")
    origin = request.headers.get("origin")
    if HOST in LOOPBACK and (urlsplit(f"http://{host}").hostname or "") not in LOOPBACK:
        allowed = False
    else:
        allowed = origin is None or urlsplit(origin).netloc == host
    if not allowed:
        return JSONResponse(status_code=403, content={"error": {"code": "forbidden", "message": "只接受本机发来的请求"}})
    return await call_next(request)

POOL_STATUS = {"no_accounts": 503, "quota": 429, "timeout": 504, "busy": 409, "not_found": 404, "bad_input": 400}


@app.exception_handler(PoolError)
async def pool_error(_req, exc: PoolError):
    return JSONResponse(status_code=POOL_STATUS.get(exc.code, 502), content={"error": {"code": exc.code, "message": str(exc)}})


@app.exception_handler(Exception)
async def any_error(_req, exc: Exception):
    return JSONResponse(status_code=502, content={"error": {"code": "upstream", "message": f"{type(exc).__name__}: {exc}"[:300]}})


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/sources")
async def sources():
    """各来源最近一次抓取的状态（不触发抓取）。"""
    out = []
    for s in SOURCES:
        c = hub.cache.get(s.id)
        out.append({
            "id": s.id, "name": s.name, "region": s.region, "kind": s.kind, "weight": s.weight,
            "count": len(c["items"]) if c else 0, "error": c["error"] if c else None, "via": c["via"] if c else None,
        })
    return out


@app.get("/topics")
async def topics(
    limit: int = Query(50, ge=1, le=300),
    sources: str | None = Query(None, description="逗号分隔的来源 id"),
    refresh: bool = False,
    risky: bool = Query(False, description="也返回默认隐藏的高风险话题"),
):
    """国内热榜聚合：跨平台合并、打分、风险过滤，附 B站热门视频。"""
    ids = [s for s in (sources or "").split(",") if s]
    return await hub.topics(ids or None, force=refresh, limit=limit, include_risky=risky)


@app.get("/global")
async def global_feed(limit: int = Query(30, ge=1, le=100), refresh: bool = False):
    """国外渠道：Hacker News 首页。"""
    return await hub.global_feed(force=refresh, limit=limit)


# ---------- 定时抓取的渠道 ----------
@app.get("/channels")
async def channels():
    """各渠道的抓取频率、上次运行结果、下次运行时间、累计条数。"""
    return await scheduler.status()


@app.post("/channels/{channel_id}/run")
async def channel_run(channel_id: str):
    """立即抓一次。"""
    if channel_id not in scheduler.channels:
        return JSONResponse(status_code=404, content={"error": {"code": "not_found", "message": f"没有渠道 {channel_id}"}})
    try:
        return await scheduler.run(channel_id)
    except Busy as e:
        return JSONResponse(status_code=409, content={"error": {"code": "busy", "message": str(e)}})


class ChannelConfig(BaseModel):
    everyMin: int
    settings: dict = Field(default_factory=dict)


@app.put("/channels/{channel_id}/config")
async def channel_config_put(channel_id: str, body: ChannelConfig):
    """保存一个渠道的配置（抓取间隔、渠道自己的设置），下一轮抓取起生效。"""
    if channel_id not in scheduler.channels:
        return JSONResponse(status_code=404, content={"error": {"code": "not_found", "message": f"没有渠道 {channel_id}"}})
    try:
        return await scheduler.set_config(channel_id, body.everyMin, body.settings)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"code": "bad_input", "message": str(e)}})


@app.get("/feed")
async def feed(
    channels: str | None = Query(None, description="逗号分隔的渠道 id，不填就是全部"),
    hours: float = Query(24, gt=0, le=24 * 30, description="最近多少小时内发布的"),
    limit: int = Query(50, ge=1, le=1000),
):
    """各渠道抓到的内容，按热度分排序。只读数据库，不会触发抓取。"""
    ids = [c for c in (channels or "").split(",") if c]
    return {"items": await scheduler.feed(ids or None, hours, limit)}


# ---------- 推特号池 ----------
@app.get("/x/pool")
async def x_pool():
    return await xpool.status()


@app.post("/x/pool/check")
async def x_pool_check():
    """立即检测所有没失效的账号（会对每个账号发一次请求）。"""
    return await xpool.check_all()


@app.post("/x/pool/accounts/{username}/check")
async def x_pool_check_one(username: str):
    """立即检测一个账号，已失效的也可以，成功就恢复可用。"""
    return await xpool.check_one(username)


class AddAccounts(BaseModel):
    text: str = Field(..., max_length=200_000, description="多行 用户名:密码:邮箱:auth_token:ct0、用户名 Cookie、纯 Cookie，或 Cookie-Editor JSON")
    username: str | None = Field(None, description="只粘贴一份 Cookie 时可以单独填用户名")


@app.post("/x/pool/accounts")
async def x_pool_add(body: AddAccounts):
    """提取 Cookie、批内及存量去重，返回新增、更新、重复和无效数量。"""
    return await xpool.add_accounts(body.text, body.username)


@app.delete("/x/pool/accounts/{username}")
async def x_pool_remove(username: str):
    return await xpool.remove_account(username)


YT_STATUS = {"no_key": 503, "bad_key": 502, "quota": 429, "bad_input": 400, "not_found": 404, "comments_disabled": 409}


@app.exception_handler(youtube.YouTubeError)
async def youtube_error(_req, exc: youtube.YouTubeError):
    return JSONResponse(status_code=YT_STATUS.get(exc.code, 502), content={"error": {"code": exc.code, "message": str(exc)}})


# ---------- YouTube（官方数据接口） ----------
@app.get("/youtube/search")
async def youtube_search(q: str, days: float = Query(7, ge=0, le=3650, description="只看最近多少天发布的，0 不限"),
                         order: str = Query("viewCount", pattern="^(viewCount|relevance|date|rating)$"),
                         limit: int = Query(20, ge=1, le=50), lang: str | None = None, region: str | None = None):
    """按关键词搜视频（100 点额度），每条带播放、点赞、评论数和简介。q 支持 A|B、-词、"短语"。"""
    return {"q": q, "items": await youtube.search(q, days=days or None, order=order, limit=limit, lang=lang, region=region),
            "quota": youtube.quota()}


@app.get("/youtube/videos")
async def youtube_videos(ids: str = Query(..., description="逗号分隔的视频 id 或链接，最多 50 条")):
    """视频详情：完整简介、标签、时长、播放点赞评论数（1 点额度）。"""
    vids = [youtube.video_id(x) for x in ids.split(",")][:50]
    if not any(vids):
        raise youtube.YouTubeError("bad_input", "没认出视频 id，给 YouTube 视频链接或 11 位 id")
    return {"items": await youtube.videos([v for v in vids if v]), "quota": youtube.quota()}


@app.get("/youtube/comments")
async def youtube_comments(video: str, limit: int = Query(20, ge=1, le=100), order: str = Query("relevance", pattern="^(relevance|time)$")):
    """一条视频的热门（relevance）或最新（time）评论（1 点额度）。"""
    vid = youtube.video_id(video)
    if not vid:
        raise youtube.YouTubeError("bad_input", "没认出视频 id，给 YouTube 视频链接或 11 位 id")
    return {"video": vid, "items": await youtube.comments(vid, limit, order), "quota": youtube.quota()}


class YouTubeKey(BaseModel):
    key: str


@app.put("/youtube/key")
async def youtube_key_put(body: YouTubeKey):
    """保存 API key：先用它查一条视频确认能用（1 点额度）。返回只带末 4 位。"""
    return await youtube.set_key(body.key)


@app.delete("/youtube/key")
async def youtube_key_delete():
    return youtube.clear_key()


NOTE_STATUS = {"blocked": 503, "no_subtitles": 404, "unavailable": 404, "failed": 502}


@app.exception_handler(NoteError)
async def note_error(_req, exc: NoteError):
    return JSONResponse(status_code=NOTE_STATUS.get(exc.code, 502), content={"error": {"code": exc.code, "message": str(exc)}})


def _vid(video: str) -> str:
    vid = youtube.video_id(video)
    if not vid:
        raise youtube.YouTubeError("bad_input", "没认出视频 id，给 YouTube 视频链接或 11 位 id")
    return vid


@app.get("/youtube/transcript/{video}")
async def youtube_transcript(video: str, refresh: bool = False):
    """视频字幕（整理成文字，带时间）。存过就直接给，cached 为 true；refresh=true 重新从 YouTube 拿。不下载视频，不登录。"""
    return await notes.transcript(_vid(video), refresh)


@app.get("/youtube/teardown/{video}")
async def youtube_teardown(video: str):
    """这条视频的拆解报告和字幕状态；还没拆解时 teardown 为空。"""
    return await notes.get(_vid(video)) or {"videoId": _vid(video), "teardown": None, "transcript": None}


class Teardown(BaseModel):
    text: str = Field(..., min_length=20, max_length=40_000)
    title: str | None = Field(None, max_length=300)


@app.put("/youtube/teardown/{video}")
async def youtube_teardown_put(video: str, body: Teardown):
    """保存（覆盖）拆解报告。"""
    return await notes.save_teardown(_vid(video), body.text, body.title)


@app.get("/youtube/notes")
async def youtube_notes(ids: str = Query("", description="逗号分隔的视频 id，最多 500 个")):
    """每条视频有没有字幕、有没有拆解，素材页显示状态用，不返回正文。"""
    vids = [v for v in (youtube.video_id(x) for x in ids.split(",")[:500]) if v]
    return await notes.status(vids)


@app.get("/youtube/quota")
async def youtube_quota():
    """今天的额度用了多少、还剩多少、什么时候恢复，以及 key 有没有配置。"""
    return youtube.quota()


# ---------- 推特（实时查询，花号池的请求次数） ----------
@app.get("/x/trends")
async def x_trends(category: str = Query("trending", description="trending / news / sport / entertainment"), limit: int = Query(30, ge=1, le=50)):
    return {"category": category, "items": await xpool.trends(category, limit)}


@app.get("/x/search")
async def x_search(q: str, limit: int = Query(20, ge=1, le=100), product: str = Query("Top", pattern="^(Top|Latest|Media)$")):
    """搜索推文。q 支持 X 的高级搜索语法，比如 `AI video min_faves:1000 lang:en`。"""
    return {"q": q, "items": await xpool.search(q, limit, product)}


@app.get("/x/list/{list_id}")
async def x_list(list_id: int, limit: int = Query(20, ge=1, le=100)):
    """X 列表的最新推文。把要关注的博主拉进一个列表，用这个接口一次拿到。"""
    return {"listId": list_id, "items": await xpool.list_timeline(list_id, limit)}


@app.get("/x/user/{username}")
async def x_user(username: str, limit: int = Query(20, ge=1, le=100)):
    return {"username": username, "items": await xpool.user_tweets(username.lstrip("@"), limit)}


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
