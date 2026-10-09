"""
公开榜单渠道：微博、B站热搜、知乎、百度、头条、B站热门视频、Hacker News，每个平台一个渠道。
抓取复用热榜中心（hub.py）的 fetch_source：同一来源 10 分钟内不重复请求，官方接口失败自动切 newsnow。
热榜中心同时拿这些数据做跨平台聚合（MCP 的 get_hot_topics），两边共用缓存，不会重复请求。
标题就是 item_id，同一条反复上榜只算一条。
"""
from aggregate import risk_of
from config import HOTLIST_FEED_INTERVAL_MIN
from scheduler import Entry

DESCRIPTIONS = {
    "weibo": "微博热搜，官方接口要登录，走 newsnow 拿",
    "bilibili": "B站热搜词，官方公开接口，失败时切 newsnow",
    "zhihu": "知乎热榜问题，官方公开接口，失败时切 newsnow",
    "baidu": "百度实时热搜，官方公开接口，失败时切 newsnow；偏新闻",
    "toutiao": "今日头条热榜，官方公开接口，失败时切 newsnow；偏新闻",
    "bilibili-video": "B站综合热门视频，带分区、播放、点赞，用来看什么题材和形式在火",
    "hackernews": "Hacker News 首页，科技和 AI 圈的一手讨论，带分数和评论数",
}


def score(rank: int) -> float:
    """榜单只有排名可比：第 1 名 100 分，每往后一名少 2 分。"""
    return float(max(0, 100 - (rank - 1) * 2))


def to_entry(item) -> Entry:
    title = item.title.strip()
    risk = risk_of(title)
    extra = {"rank": item.rank, **item.extra}
    if risk:
        extra["risk"] = risk
    return Entry(
        item_id=title,
        title=title,
        url=item.url,
        metrics={"rank": item.rank, "hot": item.heat},
        score=score(item.rank),
        extra=extra,
    )


class HotListChannel:
    min_every_min = 10  # 公开接口

    def __init__(self, hub, src):
        self.hub = hub
        self.src = src
        self.id = src.id
        self.name = src.name
        self.description = DESCRIPTIONS.get(src.id, "")
        self.every_min = HOTLIST_FEED_INTERVAL_MIN

    async def collect(self) -> list[Entry]:
        e = await self.hub.fetch_source(self.src)
        if e.get("stale") or not e["items"]:
            # 抓取失败时热榜中心会返回旧数据，不能当成这一轮还在榜上
            raise RuntimeError(e.get("error") or "榜单是空的")
        return [to_entry(it) for it in e["items"]]
