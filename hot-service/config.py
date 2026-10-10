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

# 推特号池。账号在工作台「渠道 → 推特」里添加，网络跟系统的代理设置走；下面是号池的使用规则，一般不用改
X_POOL_MIN = int(os.getenv("X_POOL_MIN", "2"))  # 可用账号少于这个数就提醒补充
X_DAILY_REQ_PER_ACCOUNT = int(os.getenv("X_DAILY_REQ_PER_ACCOUNT", "150"))  # 每个账号每天最多请求次数
X_MIN_INTERVAL_SEC = float(os.getenv("X_MIN_INTERVAL_SEC", "3"))  # 两次请求之间至少间隔
X_CHECK_INTERVAL_H = float(os.getenv("X_CHECK_INTERVAL_H", "6"))  # 可用账号的体检间隔
X_COOLDOWN_STEPS_H = [float(x) for x in os.getenv("X_COOLDOWN_STEPS_H", "1,4,12,24").split(",")]  # 冷却账号的重测间隔，依次递增，之后一直用最后一个
X_COOLDOWN_GIVEUP_DAYS = float(os.getenv("X_COOLDOWN_GIVEUP_DAYS", "3"))  # 冷却超过这么多天仍失败就判定失效
X_LOCKED_RECHECK_H = float(os.getenv("X_LOCKED_RECHECK_H", "12"))  # 被锁账号的重测间隔
X_LOCKED_GIVEUP_DAYS = float(os.getenv("X_LOCKED_GIVEUP_DAYS", "7"))  # 锁定超过这么多天没解锁就判定失效
X_REQUEST_TIMEOUT = float(os.getenv("X_REQUEST_TIMEOUT", "60"))
X_CHECK_QUERY = os.getenv("X_CHECK_QUERY", "the")  # 体检时搜的词：一定搜得到结果，搜不到就说明这个号的搜索被限制了

# YouTube（官方数据接口）。API key 在工作台「渠道 → YouTube」里填，存在 data/youtube-key.json
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY") or None  # 没在页面里填时用这个
YOUTUBE_DAILY_QUOTA = int(os.getenv("YOUTUBE_DAILY_QUOTA", "10000"))  # Google 给每个项目每天的额度
YOUTUBE_RESERVE = int(os.getenv("YOUTUBE_RESERVE", "3000"))  # 定时抓取不动用的额度，留给 Claude 临时搜索

# 定时抓取
YOUTUBE_FEED_INTERVAL_MIN = int(os.getenv("YOUTUBE_FEED_INTERVAL_MIN", "360"))  # YouTube 渠道多久抓一次
X_FEED_INTERVAL_MIN = int(os.getenv("X_FEED_INTERVAL_MIN", "120"))  # 推特渠道多久抓一次（花号池的请求次数）
X_FEED_LIMIT = int(os.getenv("X_FEED_LIMIT", "60"))  # 每条搜索语句每次最多取多少条（每 20 条约一次请求）
DOUYIN_FEED_INTERVAL_MIN = int(os.getenv("DOUYIN_FEED_INTERVAL_MIN", "30"))  # 抖音热搜多久抓一次（公开接口）
HOTLIST_FEED_INTERVAL_MIN = int(os.getenv("HOTLIST_FEED_INTERVAL_MIN", "30"))  # 微博、B站、知乎等公开榜单多久抓一次

