"""
统一调度：各渠道按自己的频率定时抓取，结果写进 entries 表，每次运行记在 runs 表（SQLite，见 db.py）。
渠道只需要提供 id、name、every_min 和 collect()，返回 Entry 列表；去重、存储、对外接口都在这里。
渠道可以有自己的设置（settings、validate、apply），页面上改的配置存在 channel_config 表，保存后下一轮生效。
"""
import asyncio
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Protocol

from db import DB

RUN_TIMEOUT_SEC = 15 * 60  # 单次运行最长时间，超过算失败
TICK_SEC = 60
NEW_WINDOW = 3 * 3600  # 多久之内（秒）第一次出现的算“新上榜”


@dataclass
class Entry:
    item_id: str
    title: str
    text: str | None = None
    url: str | None = None
    links: list[str] = field(default_factory=list)
    author: str | None = None
    published_at: datetime | None = None
    metrics: dict = field(default_factory=dict)
    score: float = 0
    extra: dict = field(default_factory=dict)


class Channel(Protocol):
    id: str
    name: str
    every_min: int

    async def collect(self) -> list[Entry]: ...

    # 可选：还没准备好时（比如推特号池里没有账号）返回原因，这时不定时抓、也不记失败
    # async def not_ready(self) -> str | None: ...


async def not_ready(ch) -> str | None:
    check = getattr(ch, "not_ready", None)
    return await check() if check else None


class Busy(Exception):
    pass


def channel_config(ch) -> dict:
    return {
        "everyMin": ch.every_min,
        "minEveryMin": getattr(ch, "min_every_min", 10),
        "settings": getattr(ch, "settings", {}),
        "defaults": getattr(ch, "default_settings", {}),
    }


def ts(dt: datetime | None) -> float | None:
    """datetime 转成存进数据库的 UTC Unix 秒；没有时区的按 UTC 算。"""
    if dt is None:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def fmt(t: float | None) -> str | None:
    """Unix 秒转成本地时间的「年-月-日T时:分」。"""
    return datetime.fromtimestamp(t).strftime("%Y-%m-%dT%H:%M") if t else None


class Scheduler:
    def __init__(self, db: DB, channels: list[Channel]):
        self.db = db
        self.channels = {c.id: c for c in channels}
        self.running: set[str] = set()

    async def load(self) -> None:
        """启动时读取页面上保存过的配置。"""
        for r in await self.db.fetch("select * from channel_config"):
            ch = self.channels.get(r["channel"])
            if not ch:
                continue
            if r["every_min"]:
                ch.every_min = r["every_min"]
            settings = json.loads(r["settings"])
            if settings and hasattr(ch, "apply"):
                ch.apply(settings)

    async def set_config(self, channel_id: str, every_min, settings: dict | None) -> dict:
        """校验并保存一个渠道的配置，立即生效（下一轮抓取起）。不合法时抛 ValueError，说明原因。"""
        ch = self.channels[channel_id]
        lo = getattr(ch, "min_every_min", 10)
        if not isinstance(every_min, int) or isinstance(every_min, bool) or not lo <= every_min <= 1440:
            raise ValueError(f"抓取间隔要在 {lo}–1440 分钟之间")
        cleaned = ch.validate(settings or {}) if hasattr(ch, "validate") else {}
        await self.db.execute(
            """insert into channel_config (channel, every_min, settings, updated_at) values (?, ?, ?, ?)
               on conflict (channel) do update set every_min = excluded.every_min, settings = excluded.settings, updated_at = excluded.updated_at""",
            channel_id, every_min, json.dumps(cleaned, ensure_ascii=False), time.time(),
        )
        ch.every_min = every_min
        if hasattr(ch, "apply"):
            ch.apply(cleaned)
        return channel_config(ch)

    async def run(self, channel_id: str) -> dict:
        """立即运行一次。同一个渠道同时只跑一个。"""
        ch = self.channels[channel_id]
        if channel_id in self.running:
            raise Busy(f"{ch.name}正在抓取")
        reason = await not_ready(ch)
        if reason:
            return {"channel": channel_id, "count": 0, "error": reason}
        self.running.add(channel_id)
        run_id = await self.db.execute("insert into runs (channel, started_at) values (?, ?)", channel_id, time.time())
        try:
            entries = await asyncio.wait_for(ch.collect(), RUN_TIMEOUT_SEC)
            await self._save(channel_id, entries)
            await self.db.execute("update runs set finished_at = ?, count = ? where id = ?", time.time(), len(entries), run_id)
            return {"channel": channel_id, "count": len(entries), "error": None}
        except Exception as e:  # noqa: BLE001 — 记下来，下一轮照常跑
            error = (f"{type(e).__name__}: {e}" if str(e) else type(e).__name__)[:500]
            await self.db.execute("update runs set finished_at = ?, error = ? where id = ?", time.time(), error, run_id)
            return {"channel": channel_id, "count": 0, "error": error}
        finally:
            self.running.discard(channel_id)

    async def _save(self, channel_id: str, entries: list[Entry]) -> None:
        if not entries:
            return
        now = time.time()
        await self.db.executemany(
            """insert into entries (channel, item_id, title, text, url, links, author, published_at, metrics, score, extra, first_seen, last_seen)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               on conflict (channel, item_id) do update set
                 title = excluded.title, text = excluded.text, url = excluded.url, links = excluded.links,
                 author = excluded.author, published_at = excluded.published_at, metrics = excluded.metrics,
                 score = excluded.score, extra = excluded.extra, last_seen = excluded.last_seen""",
            [
                (channel_id, e.item_id, e.title, e.text, e.url, json.dumps(e.links), e.author, ts(e.published_at),
                 json.dumps(e.metrics, ensure_ascii=False), e.score, json.dumps(e.extra, ensure_ascii=False), now, now)
                for e in entries
            ],
        )

    async def due(self) -> list[str]:
        """到点该跑的渠道：从没跑过，或距上次开始已超过 every_min。按上次运行时间判断，重启不会重复抓。"""
        last = {r["channel"]: r["at"] for r in await self.db.fetch("select channel, max(started_at) as at from runs group by channel")}
        now = time.time()
        return [
            cid for cid, ch in self.channels.items()
            if cid not in self.running and (cid not in last or now - last[cid] >= ch.every_min * 60) and not await not_ready(ch)
        ]

    async def loop(self) -> None:
        while True:
            try:
                for cid in await self.due():
                    asyncio.create_task(self.run(cid))
            except Exception as e:  # noqa: BLE001 — 调度循环不能挂
                print(f"[scheduler] 出错：{e}")
            await asyncio.sleep(TICK_SEC)

    async def status(self) -> list[dict]:
        out = []
        for cid, ch in self.channels.items():
            last = await self.db.fetchrow("select * from runs where channel = ? order by started_at desc limit 1", cid)
            total = await self.db.fetchval("select count(*) from entries where channel = ?", cid)
            out.append({
                "id": cid, "name": ch.name, "description": getattr(ch, "description", ""),
                "everyMin": ch.every_min, "running": cid in self.running, "total": total,
                "config": channel_config(ch), "notReady": await not_ready(ch),
                "lastRun": last and {"startedAt": fmt(last["started_at"]), "finishedAt": fmt(last["finished_at"]),
                                     "count": last["count"], "error": last["error"]},
                "nextRun": fmt(last["started_at"] + ch.every_min * 60) if last else None,
            })
        return out

    async def feed(self, channels: list[str] | None = None, hours: float = 24, limit: int = 50) -> list[dict]:
        """
        最近 hours 小时内发布的内容，按热度分排序。热榜词条没有发布时间，按最近一次还在榜上的时间算。
        isNew：最近 3 小时第一次出现，并且它出现之前 2 小时内这个渠道抓过一轮（说明一直在盯着）。
        渠道刚开始抓、或者服务停了一阵再开时，所有条目都是“第一次见”，不算新上榜。
        """
        now = time.time()
        only = f"and channel in ({','.join('?' * len(channels))})" if channels else ""
        rows = await self.db.fetch(
            f"""select e.*, e.first_seen >= ?
                 and exists (select 1 from runs r where r.channel = e.channel
                             and r.started_at < e.first_seen - 60
                             and r.started_at > e.first_seen - 7200) as is_new
               from entries e
               where coalesce(published_at, last_seen) >= ? {only}
               order by score desc, coalesce(published_at, last_seen) desc limit ?""",
            now - NEW_WINDOW, now - hours * 3600, *(channels or []), limit,
        )
        return [
            {
                "channel": r["channel"], "id": r["item_id"], "title": r["title"], "text": r["text"], "url": r["url"],
                "links": json.loads(r["links"]), "author": r["author"], "publishedAt": fmt(r["published_at"]),
                "metrics": json.loads(r["metrics"]), "score": round(r["score"], 1), "extra": json.loads(r["extra"]),
                "firstSeen": fmt(r["first_seen"]), "lastSeen": fmt(r["last_seen"]), "isNew": bool(r["is_new"]),
            }
            for r in rows
        ]
