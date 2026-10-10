"""
推特渠道：按固定的搜索语句，定时抓最近两天的高互动推文。
搜索语句里用 X 的高级语法先过滤（点赞数、不要回复和转推），since 按日期自动加上。
"""
import html
import math
import re
from datetime import datetime, timedelta, timezone

from config import X_FEED_INTERVAL_MIN, X_FEED_LIMIT
from scheduler import Entry

# 只搜 AI 会搜回一堆融资、发模型的行业新闻；用“AI + 场景词”两组 OR 并列，搜的是 AI 改变了什么。
# 英文要加 lang:en（不然葡萄牙语的 "aí" 也会命中），并排除加密货币推广和软色情。
# 这是默认值，页面「渠道 → 推特」里可以改，改过的存在 channel_config 表。
# 类别名存进每条推文的 extra.matched，页面和 Claude 按类别分开看，不然英文大号的互动量天然高，中文圈的帖子永远挤不到前面。
NOISE = "-crypto -token -airdrop -presale -NFT -giveaway -onlyfans"
BASE = "-filter:replies -filter:retweets"
DEFAULT_QUERIES = [
    {"name": "生活", "enabled": True,  # 家长、学校、恋爱、看病、客服……
     "query": "(AI OR ChatGPT) (parents OR kids OR school OR teacher OR dating OR boyfriend OR girlfriend OR marriage OR wedding "
              f'OR grandma OR therapist OR doctor OR "customer service" OR landlord) min_faves:1000 lang:en {NOISE} {BASE}'},
    {"name": "行业", "enabled": True,  # 失业、招聘、各行各业被 AI 改变
     "query": '(AI OR ChatGPT) (jobs OR replaced OR "laid off" OR hiring OR career OR lawyers OR nurses OR farmers OR restaurant '
              f"OR factory OR artists OR Hollywood) min_faves:2000 lang:en {NOISE} {BASE}"},
    {"name": "中文圈", "enabled": True,  # 国内视角的 AI 生活、搞钱和争论，体量小，门槛低一些
     "query": f"(AI OR 人工智能 OR ChatGPT OR 大模型 OR AI视频) min_faves:300 lang:zh {BASE}"},
    {"name": "创作", "enabled": True,  # 新玩法、新形式，以及围绕 AI 内容的梗和争论
     "query": '("AI generated" OR "made with AI" OR "AI art" OR "AI short film" OR "AI music video" OR "AI animation") '
              f"min_faves:300 lang:en {NOISE} {BASE}"},
]
MAX_AGE = timedelta(hours=48)  # Top 排序会混进很老的帖子，超过这个时间的丢掉
TCO = re.compile(r"https://t\.co/\w+")


def heat(t, now: datetime) -> float:
    """互动速度（每小时的加权互动量）取对数换成 0–100：10/小时约 20，1000/小时约 60，10 万/小时封顶 100。"""
    engagement = (t.likeCount or 0) + 2 * (t.retweetCount or 0) + 2 * (t.quoteCount or 0) + (t.replyCount or 0)
    hours = max((now - t.date).total_seconds() / 3600, 1)
    return round(min(100.0, 20 * math.log10(1 + engagement / hours)), 1)


def expand(text: str, links) -> str:
    """X 返回的正文带 HTML 转义（&gt; &amp;），先还原，再把 t.co 短链换成真实地址。"""
    text = html.unescape(text)
    for link in links or []:
        if link.tcourl and link.url:
            text = text.replace(link.tcourl, link.url)
    return text


def title_of(t, text: str) -> str:
    line = next((x.strip() for x in TCO.sub("", text).splitlines() if x.strip()), "")
    if not line:
        kind = "视频" if t.media and t.media.videos else "图片" if t.media and t.media.photos else "推文"
        line = f"@{t.user.username} 发布的{kind}"
    return line if len(line) <= 80 else line[:79] + "…"


def to_entry(t, group: str, now: datetime) -> Entry:
    text = expand(t.rawContent or "", t.links)
    media = t.media
    videos = media.videos if media else []
    extra = {
        "lang": t.lang,
        "followers": t.user.followersCount,
        "hasVideo": bool(videos),
        "videoSec": round(videos[0].duration / 1000) if videos and videos[0].duration else None,
        "photos": [p.url for p in media.photos] if media else [],
        "matched": [group],  # 来自哪一类搜索
    }
    q = t.quotedTweet
    if q:  # 很多爆款是“引用 + 一句评论”，真正的内容在被引用的那条里
        extra["quoted"] = {"author": f"@{q.user.username}", "text": expand(q.rawContent or "", q.links), "url": q.url}
    return Entry(
        item_id=t.id_str,
        title=title_of(t, text),
        text=text,
        url=t.url,
        links=[link.url for link in t.links or [] if link.url],
        author=f"@{t.user.username}",
        published_at=t.date,
        metrics={"likes": t.likeCount, "retweets": t.retweetCount, "replies": t.replyCount,
                 "quotes": t.quoteCount, "views": t.viewCount},
        score=heat(t, now),
        extra=extra,
    )


class XChannel:
    id = "x"
    name = "推特"
    description = "按配置的几类搜索语句定时搜推特，取最近两天的高互动帖子，带全文和引用推文"
    min_every_min = 30  # 每轮要花号池请求，不能太频繁

    def __init__(self, pool, queries: list[dict] | None = None):
        self.pool = pool
        self.every_min = X_FEED_INTERVAL_MIN
        self.default_settings = {"queries": DEFAULT_QUERIES, "limit": X_FEED_LIMIT}
        self.settings = {"queries": queries or DEFAULT_QUERIES, "limit": X_FEED_LIMIT}

    async def not_ready(self) -> str | None:
        if not await self.pool.has_accounts():
            return "号池里还没有推特账号，添加账号后开始抓取"
        return None

    def validate(self, settings: dict) -> dict:
        """页面提交的设置：1–10 条搜索语句（类别名、语句、是否启用），每条取 20–100 条。不合法抛 ValueError。"""
        queries = settings.get("queries")
        if not isinstance(queries, list) or not 1 <= len(queries) <= 10:
            raise ValueError("搜索语句要有 1–10 条")
        out, names = [], set()
        for q in queries:
            name = str((q or {}).get("name") or "").strip()
            query = " ".join(str((q or {}).get("query") or "").split())
            if not 1 <= len(name) <= 8:
                raise ValueError("类别名要 1–8 个字")
            if name.casefold() in names:
                raise ValueError(f"类别名「{name}」重复了")
            names.add(name.casefold())
            if not query or len(query) > 480:
                raise ValueError(f"「{name}」的搜索语句不能为空，也不能超过 480 个字符")
            if re.search(r"(^|\s)-?(since|until):", query):
                raise ValueError(f"「{name}」不用写 since 或 until，程序会自动限定最近两天")
            out.append({"name": name, "query": query, "enabled": bool((q or {}).get("enabled", True))})
        if not any(q["enabled"] for q in out):
            raise ValueError("至少要启用一条搜索语句")
        try:
            limit = int(settings.get("limit", X_FEED_LIMIT))
        except (TypeError, ValueError):
            limit = 0
        if not 20 <= limit <= 100:
            raise ValueError("每条取多少要在 20–100 之间")
        return {"queries": out, "limit": limit}

    def apply(self, settings: dict) -> None:
        self.settings = {"queries": settings.get("queries") or DEFAULT_QUERIES, "limit": settings.get("limit") or X_FEED_LIMIT}

    async def collect(self) -> list[Entry]:
        now = datetime.now(timezone.utc)
        since = (now - MAX_AGE).date().isoformat()
        queries = [q for q in self.settings["queries"] if q.get("enabled", True)]
        out: dict[str, Entry] = {}
        errors = []
        for q in queries:
            group = q["name"]
            try:
                tweets = await self.pool.search_tweets(f"{q['query']} since:{since}", self.settings["limit"], "Top")
            except Exception as e:  # noqa: BLE001 — 一条失败不影响其他语句
                errors.append(f"{group}：{e}")
                continue
            for t in tweets:
                if t.retweetedTweet or t.inReplyToTweetId or now - t.date > MAX_AGE:
                    continue
                if t.id_str in out:
                    out[t.id_str].extra["matched"].append(group)
                else:
                    out[t.id_str] = to_entry(t, group, now)
        if errors and len(errors) == len(queries):
            raise RuntimeError("；".join(errors))
        return list(out.values())
