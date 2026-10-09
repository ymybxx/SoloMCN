"""Hacker News：用 Algolia 提供的官方搜索接口取首页，免费、无需密钥。"""
from channels import Item, Source
from channels.http import get_json


async def hackernews() -> list[Item]:
    d = await get_json("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30")
    hits = sorted(d.get("hits") or [], key=lambda h: h.get("points") or 0, reverse=True)
    return [
        Item(
            title=h["title"],
            url=h.get("url") or f"https://news.ycombinator.com/item?id={h['objectID']}",
            rank=i + 1,
            heat=h.get("points"),
            extra={
                "points": h.get("points"),
                "comments": h.get("num_comments"),
                "discussion": f"https://news.ycombinator.com/item?id={h['objectID']}",
                "created_at": h.get("created_at"),
            },
        )
        for i, h in enumerate(hits)
        if h.get("title")
    ]


SOURCES = [Source("hackernews", "Hacker News", "global", "post", hackernews)]
