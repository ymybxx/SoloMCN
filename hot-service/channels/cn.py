"""国内热榜：直接请求各平台公开的 JSON 接口，失败时由上层切到 newsnow 兜底。"""
from urllib.parse import quote

from channels import Item, Source
from channels.http import NEWSNOW, get_json, heat_num


async def from_newsnow(newsnow_id: str) -> list[Item]:
    d = await get_json(NEWSNOW + newsnow_id, {"referer": "https://newsnow.busiyi.world/"})
    items = d.get("items") or []
    if not items:
        raise RuntimeError("newsnow 无数据")
    return [Item(title=x["title"], url=x.get("url"), rank=i + 1) for i, x in enumerate(items) if x.get("title")]


async def douyin() -> list[Item]:
    d = await get_json("https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/")
    return [
        Item(title=x["word"], url="https://www.douyin.com/search/" + quote(x["word"]), rank=i + 1, heat=x.get("hot_value"))
        for i, x in enumerate(d["word_list"])
    ]


async def weibo() -> list[Item]:
    # 微博官方接口需要登录，直接用 newsnow
    return await from_newsnow("weibo")


async def bilibili() -> list[Item]:
    d = await get_json("https://app.bilibili.com/x/v2/search/trending/ranking?limit=30")
    rows = [x for x in d["data"]["list"] if x.get("is_commercial") != "1"]  # 去掉广告位
    return [
        Item(title=(x.get("show_name") or x["keyword"]).strip(), url="https://search.bilibili.com/all?keyword=" + quote(x["keyword"]), rank=i + 1)
        for i, x in enumerate(rows)
    ]


async def zhihu() -> list[Item]:
    d = await get_json("https://api.zhihu.com/topstory/hot-lists/total?limit=50")
    out = []
    for i, x in enumerate(d["data"]):
        t = x.get("target") or {}
        if not t.get("title"):
            continue
        url = (t.get("url") or "").replace("api.zhihu.com/questions", "www.zhihu.com/question")
        out.append(Item(title=t["title"], url=url, rank=i + 1, heat=heat_num(x.get("detail_text"))))
    return out


async def baidu() -> list[Item]:
    d = await get_json("https://top.baidu.com/api/board?platform=wise&tab=realtime")
    rows = []
    for card in d["data"]["cards"][0]["content"]:
        rows.extend(card.get("content") or [card])
    rows = [x for x in rows if x.get("word") and not x.get("isTop")]  # 去掉官方置顶
    return [Item(title=x["word"], url=x.get("url"), rank=i + 1, heat=heat_num(x.get("hotScore"))) for i, x in enumerate(rows)]


async def toutiao() -> list[Item]:
    d = await get_json("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc")
    return [
        Item(title=x["Title"], url=(x.get("Url") or "").split("?")[0], rank=i + 1, heat=heat_num(x.get("HotValue")))
        for i, x in enumerate(d["data"])
    ]


async def bilibili_video() -> list[Item]:
    d = await get_json("https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1")
    out = []
    for i, x in enumerate(d["data"]["list"]):
        stat = x.get("stat") or {}
        out.append(Item(
            title=x["title"],
            url="https://www.bilibili.com/video/" + x["bvid"],
            rank=i + 1,
            heat=stat.get("view"),
            extra={
                "category": x.get("tname"),
                "views": stat.get("view"),
                "likes": stat.get("like"),
                "shares": stat.get("share"),
                "reason": (x.get("rcmd_reason") or {}).get("content", ""),
            },
        ))
    return out


# 权重：抖音、微博、B站离短视频受众最近；百度、头条偏新闻
SOURCES = [
    Source("douyin", "抖音热榜", "cn", "search", douyin, weight=1.0, newsnow="douyin"),
    Source("weibo", "微博热搜", "cn", "search", weibo, weight=1.0, via="newsnow"),
    Source("bilibili", "B站热搜", "cn", "search", bilibili, weight=1.0, newsnow="bilibili-hot-search"),
    Source("zhihu", "知乎热榜", "cn", "search", zhihu, weight=0.8, newsnow="zhihu"),
    Source("baidu", "百度热搜", "cn", "search", baidu, weight=0.6, newsnow="baidu"),
    Source("toutiao", "头条热榜", "cn", "search", toutiao, weight=0.6, newsnow="toutiao"),
    Source("bilibili-video", "B站热门视频", "cn", "video", bilibili_video),
]
