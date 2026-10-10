"""配置：全部可以用环境变量或 hot-service/.env 覆盖。"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file(ROOT / ".env")

HOST = os.getenv("HOT_HOST", "127.0.0.1")
PORT = int(os.getenv("HOT_PORT", "5179"))
DATA_DIR = Path(os.getenv("HOT_DATA_DIR", ROOT / "data"))
# 本地数据库：SQLite 文件，不用另外安装数据库
DB_PATH = Path(os.getenv("HOT_DB_PATH", DATA_DIR / "hot.db"))

# 热榜
CACHE_SECONDS = int(os.getenv("HOT_CACHE_SECONDS", "600"))  # 同一来源 10 分钟内不重复请求
FETCH_INTERVAL_MIN = int(os.getenv("HOT_FETCH_INTERVAL_MIN", "20"))  # 后台定时抓取间隔
REQUEST_TIMEOUT = float(os.getenv("HOT_REQUEST_TIMEOUT", "10"))

# 定时抓取
DOUYIN_FEED_INTERVAL_MIN = int(os.getenv("DOUYIN_FEED_INTERVAL_MIN", "30"))  # 抖音热搜多久抓一次（公开接口）
HOTLIST_FEED_INTERVAL_MIN = int(os.getenv("HOTLIST_FEED_INTERVAL_MIN", "30"))  # 微博、B站、知乎等公开榜单多久抓一次

