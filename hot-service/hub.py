"""热榜抓取中心：缓存、兜底、历史快照、聚合。"""
import asyncio
import json
import time
from datetime import datetime, timezone

from aggregate import cluster, score_cluster
from channels import Source, cn, hn
from channels.cn import from_newsnow
from config import CACHE_SECONDS, DATA_DIR

SOURCES: list[Source] = cn.SOURCES + hn.SOURCES
BY_ID = {s.id: s for s in SOURCES}


def iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None


class History:
    """
    记录每次抓取的排名快照，用来判断“新上榜”和“排名变化”。
    只有在追踪期间（上一次快照在 3 小时以内）新出现的标题才算新上榜，避免长时间没抓导致误判。
    """

    MAX_GAP = 3 * 3600
    KEEP_SNAPSHOTS = 250

    def __init__(self, path):
        self.path = path
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            raw = {}
        self.snapshots: dict[str, list[dict]] = raw.get("snapshots", {})
        self.seen: dict[str, dict] = raw.get("seen", {})

    def record(self, source_id: str, at: float, items) -> None:
        snaps = self.snapshots.setdefault(source_id, [])
        if snaps and snaps[-1]["at"] == at:
            return
        prev_at = snaps[-1]["at"] if snaps else None
        watching = prev_at is not None and at - prev_at <= self.MAX_GAP
        from aggregate import norm

        ranks = {}
        for it in items:
            key = norm(it.title)
            ranks[key] = it.rank
            if key not in self.seen:
                self.seen[key] = {"at": at, "known": watching}
        snaps.append({"at": at, "ranks": ranks})
        del snaps[: -self.KEEP_SNAPSHOTS]

    def first_seen(self, keys: list[str]) -> dict | None:
        recs = [self.seen[k] for k in keys if k in self.seen]
        return min(recs, key=lambda r: r["at"]) if recs else None

    def rank_hour_ago(self, source_id: str, key: str, now: float) -> int | None:
        """一小时前（1~3 小时之间最近的一份快照）的排名；0 = 当时不在榜上；None = 没有可比的快照。"""
        best = None
        for s in self.snapshots.get(source_id, []):
            if now - self.MAX_GAP <= s["at"] <= now - 3600:
                best = s
        if best is None:
            return None
        return best["ranks"].get(key, 0)

    def save(self) -> None:
        cutoff = time.time() - 3 * 86400
        self.seen = {k: v for k, v in self.seen.items() if v["at"] >= cutoff}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"snapshots": self.snapshots, "seen": self.seen}, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)


class Hub:
    def __init__(self):
        self.cache: dict[str, dict] = {}
        self.history = History(DATA_DIR / "hot-history.json")
        self.lock = asyncio.Lock()

    async def fetch_source(self, src: Source, force: bool = False) -> dict:
        c = self.cache.get(src.id)
        if not force and c and time.time() - c["at"] < CACHE_SECONDS and not c.get("error"):
            return c
        via, error, items = src.via, None, None
        try:
            items = await src.fetch()
        except Exception as e:  # noqa: BLE001 — 任何来源出错都不影响其他来源
            if src.newsnow:
                try:
                    items, via = await from_newsnow(src.newsnow), "newsnow"
                except Exception as e2:  # noqa: BLE001
                    error = f"{e}；newsnow 兜底也失败：{e2}"
            else:
                error = str(e) or type(e).__name__
        if items is None and c:  # 失败但有旧数据：返回旧数据并标记
            entry = {**c, "error": error, "stale": True}
        else:
            entry = {"at": time.time(), "items": items or [], "via": via, "error": error, "stale": False}
            if entry["items"]:
                self.history.record(src.id, entry["at"], entry["items"])
        self.cache[src.id] = entry
        return entry

    async def fetch_all(self, ids: list[str] | None = None, force: bool = False):
        chosen = [s for s in SOURCES if not ids or s.id in ids]
        async with self.lock:
            entries = await asyncio.gather(*(self.fetch_source(s, force) for s in chosen))
            self.history.save()
        return list(zip(chosen, entries))

    def source_status(self, pairs) -> list[dict]:
        return [
            {"id": s.id, "name": s.name, "region": s.region, "count": len(e["items"]), "via": e["via"], "error": e["error"], "stale": e.get("stale", False), "at": iso(e["at"])}
            for s, e in pairs
        ]

    async def topics(self, sources: list[str] | None = None, force=False, limit=50, include_risky=False) -> dict:
        """国内热搜聚合 + B站热门视频。"""
        ids = [s.id for s in SOURCES if s.region == "cn" and (not sources or s.id in sources)]
        pairs = await self.fetch_all(ids, force)
        now = time.time()
        scored = [score_cluster(c, self.history, now) for c in cluster([(s, e["items"]) for s, e in pairs])]
        for t in scored:
            t["firstSeen"] = iso(t["firstSeen"])
        visible = [t for t in scored if include_risky or not t["risk"] or t["risk"]["level"] != "avoid"]
        visible.sort(key=lambda t: t["score"], reverse=True)
        video = next((e for s, e in pairs if s.id == "bilibili-video"), None)
        return {
            "fetchedAt": iso(now),
            "sources": self.source_status(pairs),
            "topics": visible[:limit],
            "hiddenRisky": 0 if include_risky else len(scored) - len(visible),
            "videos": [{"title": v.title, "url": v.url, **v.extra} for v in (video["items"] if video else [])[:20]],
            "notes": "小红书和快手没有公开热榜，需要时用网页搜索补充。分数 = 排名 50% + 跨平台 30% + 时效 20%，抖音/微博/B站权重 1.0，知乎 0.8，百度/头条 0.6。",
        }

    async def global_feed(self, force=False, limit=30) -> dict:
        """国外渠道（目前是 Hacker News）。"""
        ids = [s.id for s in SOURCES if s.region == "global"]
        pairs = await self.fetch_all(ids, force)
        return {
            "fetchedAt": iso(time.time()),
            "sources": self.source_status(pairs),
            "items": {s.id: [{"title": i.title, "url": i.url, "rank": i.rank, **i.extra} for i in e["items"][:limit]] for s, e in pairs},
        }
