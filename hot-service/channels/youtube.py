"""
YouTube 渠道：按配置的几组关键词，定时搜最近几天按播放量排在前面的视频，带播放、点赞、评论数。
用官方数据接口，每组关键词每轮 100 点额度；额度不够时少搜几组，给 Claude 临时搜索留出 YOUTUBE_RESERVE。
"""
import math
import re
from datetime import datetime, timezone

import youtube
from config import YOUTUBE_FEED_INTERVAL_MIN, YOUTUBE_RESERVE
from scheduler import Entry

# 这是默认值，页面「渠道 → YouTube」里可以改，改过的存在 channel_config 表。
# 语法：A|B 任意一个，-词 排除，"短语" 精确匹配。类别名存进每条视频的 extra.matched。
DEFAULT_QUERIES = [
    {"name": "智能体", "enabled": True, "query": '"AI agent"|"AI agents"|agentic'},
    {"name": "Claude", "enabled": True, "query": 'Claude|Anthropic|"Claude Code"'},
    {"name": "ChatGPT", "enabled": True, "query": "ChatGPT|OpenAI"},
    # 用工具名而不是 "AI video"：泛词会搜回大量印度娱乐八卦和西语的 "veo"；工具名搜到的是用这些工具做的爆款视频
    {"name": "AI视频", "enabled": True, "query": '"Google Veo"|"OpenAI Sora"|"Kling AI"|"Runway AI"|Seedance|Higgsfield'},
    # 单写 Cursor 会搜回鼠标指针
    {"name": "AI编程", "enabled": True, "query": '"Claude Code"|"Cursor AI"|"vibe coding"|"AI coding"'},
    # 只用中文词：带上 "AI" 会被全世界的 AI 梗视频淹没
    {"name": "中文", "enabled": True, "query": "人工智能|大模型|AI工具|ChatGPT教程", "lang": "zh-Hans"},
]
DEFAULT_DAYS = 7
DEFAULT_LIMIT = 25


def heat(views: int | None, published: datetime, now: datetime) -> float:
    """每小时的播放量取对数换成 0–100：100/小时约 36，1 万/小时约 72，30 万/小时封顶。"""
    hours = max((now - published).total_seconds() / 3600, 1)
    return round(min(100.0, 18 * math.log10(1 + (views or 0) / hours)), 1)


def to_entry(v: dict, group: str, now: datetime) -> Entry:
    published = datetime.fromisoformat(v["publishedAt"].replace("Z", "+00:00"))
    desc = v["description"]
    return Entry(
        item_id=v["id"],
        title=v["title"],
        text=desc[:2000] if desc else None,
        url=v["url"],
        links=[],
        author=v["channel"],
        published_at=published,
        metrics={"views": v["views"], "likes": v["likes"], "comments": v["comments"]},
        score=heat(v["views"], published, now),
        extra={"matched": [group], "channelId": v["channelId"], "durationSec": v["durationSec"], "short": v["short"],
               "lang": v["lang"], "tags": v["tags"][:10], "thumbnail": v["thumbnail"], "captions": v["captions"]},
    )


class YouTubeChannel:
    id = "youtube"
    name = "YouTube"
    description = "按配置的几组关键词定时搜 YouTube，取最近几天播放量最高的视频，带播放、点赞、评论数和简介"
    min_every_min = 120  # 每组关键词每轮 100 点额度，一天总共 10000 点

    def __init__(self):
        self.every_min = YOUTUBE_FEED_INTERVAL_MIN
        self.default_settings = {"queries": DEFAULT_QUERIES, "days": DEFAULT_DAYS, "limit": DEFAULT_LIMIT}
        self.settings = dict(self.default_settings)

    async def not_ready(self) -> str | None:
        if not youtube.key_status()["configured"]:
            return "还没填 YouTube 的 API key，填好后开始抓取"
        return None

    def validate(self, settings: dict) -> dict:
        """1–10 组关键词（类别名、关键词、可选语言、是否启用）；只看最近 1–30 天；每组取 10–50 条。不合法抛 ValueError。"""
        queries = settings.get("queries")
        if not isinstance(queries, list) or not 1 <= len(queries) <= 10:
            raise ValueError("关键词要有 1–10 组")
        out, names = [], set()
        for q in queries:
            q = q or {}
            name = str(q.get("name") or "").strip()
            query = " ".join(str(q.get("query") or "").split())
            lang = str(q.get("lang") or "").strip()
            if not 1 <= len(name) <= 8:
                raise ValueError("类别名要 1–8 个字")
            if name.casefold() in names:
                raise ValueError(f"类别名「{name}」重复了")
            names.add(name.casefold())
            if not query or len(query) > 300:
                raise ValueError(f"「{name}」的关键词不能为空，也不能超过 300 个字符")
            if lang and not re.fullmatch(r"[a-z]{2}(-[A-Za-z]{2,4})?", lang):
                raise ValueError(f"「{name}」的语言代码不对，比如 en、zh-Hans、ja")
            item = {"name": name, "query": query, "enabled": bool(q.get("enabled", True))}
            if lang:
                item["lang"] = lang
            out.append(item)
        if not any(q["enabled"] for q in out):
            raise ValueError("至少要启用一组关键词")
        try:
            days, limit = int(settings.get("days", DEFAULT_DAYS)), int(settings.get("limit", DEFAULT_LIMIT))
        except (TypeError, ValueError):
            days = limit = 0
        if not 1 <= days <= 30:
            raise ValueError("只看最近几天要在 1–30 之间")
        if not 10 <= limit <= 50:
            raise ValueError("每组取多少要在 10–50 之间")
        return {"queries": out, "days": days, "limit": limit}

    def apply(self, settings: dict) -> None:
        self.settings = {**self.default_settings, **{k: v for k, v in settings.items() if v}}

    async def collect(self) -> list[Entry]:
        now = datetime.now(timezone.utc)
        queries = [q for q in self.settings["queries"] if q.get("enabled", True)]
        out: dict[str, Entry] = {}
        errors, skipped = [], []
        for q in queries:
            group = q["name"]
            # 每组 100 点搜索 + 1 点查数据；不够就跳过，留给 Claude 临时搜索
            if youtube.quota()["left"] - 101 < YOUTUBE_RESERVE:
                skipped.append(group)
                continue
            try:
                found = await youtube.search(q["query"], days=self.settings["days"], order="viewCount",
                                             limit=self.settings["limit"], lang=q.get("lang"))
            except youtube.YouTubeError as e:
                if e.code in ("no_key", "bad_key", "quota"):
                    raise RuntimeError(str(e)) from e
                errors.append(f"{group}：{e}")
                continue
            for v in found:
                if not v.get("publishedAt"):
                    continue
                if v["id"] in out:
                    out[v["id"]].extra["matched"].append(group)
                else:
                    out[v["id"]] = to_entry(v, group, now)
        if skipped and len(skipped) == len(queries):
            raise RuntimeError(f"今天的 YouTube 额度只剩 {youtube.quota()['left']} 点，留给 Claude 临时搜索，这轮没搜")
        if errors and len(errors) + len(skipped) == len(queries):
            raise RuntimeError("；".join(errors))
        if skipped:
            print(f"[youtube] 额度不够，这轮跳过：{'、'.join(skipped)}")
        return list(out.values())
