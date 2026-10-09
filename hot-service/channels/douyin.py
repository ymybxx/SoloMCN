"""
抖音渠道：抖音网页版的热搜榜（50 条）加实时上升热点，不用登录、不用签名。
每个热搜词带上榜时间、最高排名、相关视频数，链接是热点详情页（App 里点热搜看到的那一页）。
热搜词下面具体视频的点赞等数据要请求签名才能拿，不做破解，所以只有热度值。
网页版接口失败时退回到更早的公开接口（只有热搜词和热度值）。
热搜词本身就是 item_id：同一个词反复上榜只算一条。
"""
import math
from datetime import datetime, timezone
from urllib.parse import quote

from aggregate import risk_of
from channels.http import get_json
from config import DOUYIN_FEED_INTERVAL_MIN
from scheduler import Entry

WEB_URL = "https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1"
FALLBACK_URL = "https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/"
RISING_SCORE = 50.0  # 上升热点没有热度值，给一个中间分


def heat(hot_value: int | None) -> float:
    """热度值取对数换成 0–100：30 万约 37，100 万约 50，1000 万约 75。"""
    return round(min(100.0, max(0.0, 25 * math.log10(max(hot_value or 0, 1) / 1e4))), 1)


def to_entry(word: dict, rank: int | None, rising: bool = False) -> Entry:
    title = word["word"].strip()
    risk = risk_of(title)
    sid = word.get("sentence_id")
    since = word.get("event_time")
    extra = {
        "rank": rank,
        "label": word.get("label"),
        "since": datetime.fromtimestamp(since, timezone.utc).isoformat() if since else None,  # 开始上榜的时间
        "maxRank": word.get("max_rank"),
        "rising": rising,
    }
    if risk:
        extra["risk"] = risk
    return Entry(
        item_id=title,
        title=title,
        url=f"https://www.douyin.com/hot/{sid}" if sid else "https://www.douyin.com/search/" + quote(title),
        metrics={"hot": word.get("hot_value") or None, "rank": rank, "videos": word.get("video_count")},
        score=RISING_SCORE if rising else heat(word.get("hot_value")),
        extra=extra,
    )


def parse_web(d: dict) -> list[Entry]:
    data = d.get("data") or {}
    words = [w for w in data.get("word_list") or [] if (w.get("word") or "").strip()]
    if not words:
        raise ValueError("网页版热搜返回空列表")
    entries = [to_entry(w, w.get("position") or i + 1) for i, w in enumerate(words)]
    seen = {e.item_id for e in entries}
    for w in data.get("trending_list") or []:
        if (w.get("word") or "").strip() and w["word"].strip() not in seen:
            entries.append(to_entry(w, None, rising=True))
    return entries


class DouyinChannel:
    id = "douyin"
    name = "抖音"
    description = "抖音网页版热搜榜 50 条加实时上升热点，带上榜时间、最高排名、相关视频数"
    min_every_min = 10  # 公开接口

    def __init__(self):
        self.every_min = DOUYIN_FEED_INTERVAL_MIN

    async def collect(self) -> list[Entry]:
        try:
            return parse_web(await get_json(WEB_URL, {"referer": "https://www.douyin.com/"}))
        except Exception:  # noqa: BLE001 — 退回老接口，至少有热搜词和热度
            d = await get_json(FALLBACK_URL)
            words = [w for w in d.get("word_list") or [] if (w.get("word") or "").strip()]
            if not words:
                raise RuntimeError("抖音热搜两个接口都返回空列表")
            return [to_entry(w, i + 1) for i, w in enumerate(words)]
