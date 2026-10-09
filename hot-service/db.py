"""
Postgres 连接和表结构迁移。整个项目共用一个数据库，各服务只管自己的 schema：hot-service 用 hot。
迁移文件放在 migrations/，按文件名顺序执行，执行过的记在 public.hot_service_migrations。
"""
from pathlib import Path

import asyncpg

MIGRATIONS = Path(__file__).resolve().parent / "migrations"
TRACKING = "public.hot_service_migrations"


async def _create_database(dsn: str) -> None:
    """数据库还没建就自动建一个（连同一台 Postgres 上的 postgres 库来执行 create database）。"""
    from urllib.parse import urlsplit, urlunsplit
    u = urlsplit(dsn)
    name = u.path.lstrip("/")
    conn = await asyncpg.connect(urlunsplit(u._replace(path="/postgres")))
    try:
        await conn.execute(f'create database "{name}"')
        print(f"[db] 已创建数据库 {name}")
    finally:
        await conn.close()


async def connect(dsn: str) -> asyncpg.Pool:
    try:
        try:
            pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5)
        except asyncpg.InvalidCatalogNameError:
            await _create_database(dsn)
            pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5)
    except (OSError, asyncpg.PostgresError) as e:
        raise RuntimeError(
            f"连不上数据库（{type(e).__name__}: {e}）。确认 Postgres 已安装并启动（brew install postgresql@18 && brew services start postgresql@18），"
            "或用环境变量 DATABASE_URL 指定别的地址"
        ) from e
    await migrate(pool)
    return pool


async def migrate(pool: asyncpg.Pool) -> list[str]:
    applied = []
    async with pool.acquire() as c, c.transaction():
        # 多个进程同时启动时只让一个执行迁移
        await c.execute("select pg_advisory_xact_lock(hashtext('hot_service.migrate'))")
        await c.execute(f"create table if not exists {TRACKING} (name text primary key, applied_at timestamptz not null default now())")
        done = {r["name"] for r in await c.fetch(f"select name from {TRACKING}")}
        for f in sorted(MIGRATIONS.glob("*.sql")):
            if f.name in done:
                continue
            await c.execute(f.read_text(encoding="utf-8"))
            await c.execute(f"insert into {TRACKING} (name) values ($1)", f.name)
            applied.append(f.name)
    return applied
