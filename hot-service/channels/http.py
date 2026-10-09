import re

import httpx

from config import REQUEST_TIMEOUT

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
NEWSNOW = "https://newsnow.busiyi.world/api/s?id="

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(headers={"user-agent": UA}, timeout=REQUEST_TIMEOUT, follow_redirects=True)
    return _client


async def get_json(url: str, headers: dict | None = None):
    res = await client().get(url, headers=headers or {})
    res.raise_for_status()
    return res.json()


def heat_num(value) -> int | None:
    """把“1122 万热度”“39112049”这类文字转成数字。"""
    if value is None:
        return None
    m = re.search(r"([\d.]+)\s*(万|亿)?", str(value))
    if not m:
        return None
    n = float(m.group(1)) * (1e8 if m.group(2) == "亿" else 1e4 if m.group(2) == "万" else 1)
    return int(n)
