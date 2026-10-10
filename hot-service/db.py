"""
本地数据库：SQLite，就是 data/hot.db 一个文件，不用另外安装或启动数据库服务。
数据量很小（各渠道最近抓到的条目和运行记录），单个连接加一把锁就够用；所有读写都放到线程里做，不卡住事件循环。
表结构在 migrations/ 里，按文件名顺序执行，执行过的记在 migrations 表。
时间一律存 UTC 的 Unix 秒（浮点数），JSON 存成文本。
"""
import asyncio
import sqlite3
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent / "migrations"


class DB:
    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("pragma journal_mode = wal")
        self.conn.execute("pragma busy_timeout = 5000")
        self.conn.execute("pragma foreign_keys = on")
        self.lock = asyncio.Lock()

    async def _run(self, fn):
        async with self.lock:
            return await asyncio.to_thread(fn)

    async def fetch(self, sql: str, *args) -> list[sqlite3.Row]:
        return await self._run(lambda: self.conn.execute(sql, args).fetchall())

    async def fetchrow(self, sql: str, *args) -> sqlite3.Row | None:
        return await self._run(lambda: self.conn.execute(sql, args).fetchone())

    async def fetchval(self, sql: str, *args):
        row = await self.fetchrow(sql, *args)
        return row[0] if row else None

    async def execute(self, sql: str, *args) -> int:
        """返回最后插入的行 id（插入时有用）。"""
        return await self._run(lambda: self.conn.execute(sql, args).lastrowid)

    async def executemany(self, sql: str, rows: list[tuple]) -> None:
        def go():
            self.conn.execute("begin")
            try:
                self.conn.executemany(sql, rows)
                self.conn.execute("commit")
            except Exception:
                self.conn.execute("rollback")
                raise
        await self._run(go)

    async def tx(self, fn):
        """在一个事务里执行 fn(conn)（普通函数，放到线程里跑），返回它的结果；出错整体回滚。
        所有读写共用一把锁，事务里的“先查再改”不会被别的请求插进来。"""
        def go():
            self.conn.execute("begin immediate")
            try:
                out = fn(self.conn)
            except BaseException:
                self.conn.execute("rollback")
                raise
            self.conn.execute("commit")
            return out
        return await self._run(go)

    async def close(self) -> None:
        await self._run(self.conn.close)


async def connect(path: str | Path) -> DB:
    db = DB(path)
    await migrate(db)
    return db


async def migrate(db: DB) -> list[str]:
    def go():
        db.conn.execute("create table if not exists migrations (name text primary key, applied_at real not null default (strftime('%s', 'now')))")
        done = {r["name"] for r in db.conn.execute("select name from migrations")}
        applied = []
        for f in sorted(MIGRATIONS.glob("*.sql")):
            if f.name in done:
                continue
            db.conn.executescript("begin;\n" + f.read_text(encoding="utf-8") + f"\ninsert into migrations (name) values ('{f.name}');\ncommit;")
            applied.append(f.name)
        return applied
    return await db._run(go)
