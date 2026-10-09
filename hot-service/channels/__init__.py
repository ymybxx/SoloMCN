"""数据渠道。每个来源提供 fetch()，返回统一格式的条目列表。"""
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable


@dataclass
class Item:
    title: str
    url: str | None
    rank: int
    heat: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class Source:
    id: str
    name: str
    region: str  # cn / global
    kind: str  # search = 热搜词，video = 热门视频，post = 帖子
    fetch: Callable[[], Awaitable[list[Item]]]
    weight: float = 1.0  # 打分权重：越贴近短视频受众越高
    newsnow: str | None = None  # 官方接口失败时的 newsnow 兜底 id
    via: str = "direct"
