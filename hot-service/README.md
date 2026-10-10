# 热点数据服务（hot-service）

独立的 Python 服务，定时抓各平台的公开热榜。工作台和 Claude（MCP）都通过它拿数据。在项目根目录 `npm start` 时会自动一起启动，端口是工作台端口 + 1（默认 5179），接口文档在 `/docs`。

## 安装

项目根目录的 `npm run setup` 已经装好了。单独装：

```bash
cd hot-service
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

数据存在本地的 SQLite 文件 `data/hot.db` 里，不用另外安装数据库，表在启动时自动建好。

测试（每个测试用一个临时的 SQLite 文件，不碰正式数据）：

```bash
.venv/bin/python -m unittest discover -s tests
```

## 渠道

| 渠道 | 来源 | 说明 |
|---|---|---|
| 抖音热搜 | 抖音网页版公开接口 | 50 条加实时上升词，带热度、排名、上榜时长、风险标记 |
| 微博、B站、知乎、百度、头条 | 各平台公开接口；微博走 newsnow | 任一来源失败自动切 newsnow；10 分钟缓存 |
| B站热门视频 | B站公开接口 | 看什么形式的视频在火 |
| Hacker News | Algolia 公开搜索接口 | 海外 AI 新产品、新工具的第一手消息 |

全部是公开接口，不用登录、不用密钥。

- **抖音**（`channels/douyin.py`）：每 30 分钟一次。热搜词本身就是 id；热度分 = 热度值取对数（100 万约 50，1000 万约 75）；`extra.risk` 是自动识别的风险（灾难、时政、刑案等）。
- **其他榜单**（`channels/hotlist.py`）：每 30 分钟一次，复用热榜中心的抓取和缓存，和跨平台聚合 `/topics` 共用，不会重复请求。热度分按排名算（第 1 名 100 分，每往后一名少 2 分）。
- 后台每 20 分钟拍一次各榜单的快照，用来判断「新上榜」「正在上升」和上榜时长。只有在持续追踪期间新出现的才算新上榜。

## 接口

| 接口 | 作用 |
|---|---|
| `GET /topics` | 国内热榜聚合：跨平台合并、打分、风险过滤，附 B站热门视频 |
| `GET /global` | Hacker News 首页 |
| `GET /sources` | 各来源最近一次抓取的状态 |
| `GET /feed?channels=douyin&hours=24&limit=50` | 各渠道定时抓到的内容，按热度分排序 |
| `GET /channels` | 各渠道的抓取频率、上次运行结果、下次运行时间 |
| `POST /channels/{id}/run` | 立即抓一次 |
| `PUT /channels/{id}/config` | 保存渠道的抓取间隔：`{"everyMin": 30, "settings": {}}` |

## 配置

都有默认值，一般不用改；需要时用环境变量覆盖：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOT_DB_PATH` | `data/hot.db` | SQLite 数据文件 |
| `HOT_PORT` | 5179 | 端口（由工作台启动时自动设成工作台端口 + 1） |
| `HOT_FETCH_INTERVAL_MIN` | 20 | 后台拍热榜快照的间隔（分钟） |
| `DOUYIN_FEED_INTERVAL_MIN` | 30 | 抖音热搜多久抓一次（分钟），页面上也能改 |
| `HOTLIST_FEED_INTERVAL_MIN` | 30 | 其他榜单多久抓一次（分钟），页面上也能改 |
