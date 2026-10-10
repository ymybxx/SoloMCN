"""
推特号池。账号和状态存在本地 SQLite（x_accounts 等表，见 migrations/002_xpool.sql）；
twscrape 自己的 SQLite（data/x_accounts.db）只是运行时副本，只放状态可用、今天还没用满的账号，
由 _sync_runtime 单向同步过去，删掉也会自动重建。

账号状态：
  active    可用
  cooldown  暂时不可用（限流、403、超时等）。按 1h→4h→12h→24h 重测，成功就恢复；超过 X_COOLDOWN_GIVEUP_DAYS 天转为 invalid
  locked    账号被锁（326），要在浏览器里登录解锁。每 X_LOCKED_RECHECK_H 小时重测，成功就恢复；超过 X_LOCKED_GIVEUP_DAYS 天转为 invalid
  invalid   Cookie 失效（32、缺少 Cookie），不再自动重测；换新 Cookie 或手动重新检测成功才会恢复

每个账号都有下次检测时间，后台每分钟检测到期的账号（可用账号每 X_CHECK_INTERVAL_H 小时一次）。
同一批检测里没有任何账号得到明确结果、且至少两个账号结果不明时，判定为网络问题，不改账号状态，一小时后再测。

用量：每个账号每天最多 X_DAILY_REQ_PER_ACCOUNT 次请求，用满的当天移出运行时号池；取账号时优先用最久没用过的。
不做任何规避风控的处理（不改设备指纹、不处理验证码、不自动注册）。

号池里没有账号时，推特渠道和查询都不工作，其他功能不受影响。
"""
import asyncio
import hashlib
import json
import random
import re
import tempfile
import time
from contextlib import aclosing
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from twscrape import API
from twscrape.logger import set_log_level

from config import (
    DATA_DIR,
    X_CHECK_INTERVAL_H,
    X_CHECK_TARGET,
    X_COOLDOWN_GIVEUP_DAYS,
    X_COOLDOWN_STEPS_H,
    X_DAILY_REQ_PER_ACCOUNT,
    X_LOCKED_GIVEUP_DAYS,
    X_LOCKED_RECHECK_H,
    X_MIN_INTERVAL_SEC,
    X_POOL_MIN,
    X_REQUEST_TIMEOUT,
)
from db import DB

set_log_level("WARNING")

STATUSES = ("active", "cooldown", "locked", "invalid")
NETWORK_RETRY = timedelta(hours=1)  # 疑似网络问题时，多久后再测


class PoolError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def parse_cookie_line(line: str) -> tuple[str | None, str] | None:
    """
    支持两种写法：
      用户名 auth_token=xxx; ct0=yyy; ...
      auth_token=xxx; ct0=yyy; ...        （没写用户名时自动生成一个标识）
    """
    line = line.strip().strip("'\"")
    if not line or line.startswith("#"):
        return None
    if re.match(r"^cookie\s*:", line, flags=re.I):
        return None, line
    parts = line.split(maxsplit=1)
    if len(parts) == 2 and "=" not in parts[0]:
        return parts[0].lstrip("@"), parts[1]
    return None, line


def cookie_dict(cookies: str) -> dict[str, str]:
    out = {}
    for part in cookies.split(";"):
        k, _, v = part.strip().partition("=")
        if k and v:
            out[k.strip()] = v.strip()
    return out


USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{1,40}$")
LINE_BREAKS = r"\r\n\v\f\x1c-\x1e\x85  "


def normalize_cookies(raw: str) -> str:
    """接受 'Cookie: a=1; b=2'、带引号、多余空白等常见复制格式，整理成 'a=1; b=2'。"""
    s = raw.strip().strip("'\"")
    s = re.sub(r"^cookie\s*:\s*", "", s, flags=re.I)
    return "; ".join(f"{k}={v}" for k, v in cookie_dict(s).items())


def parse_paste(text: str, username: str | None = None) -> tuple[list[dict], list[str]]:
    """
    解析页面上粘贴的内容：
      - Cookie-Editor 等插件导出的 JSON 数组（一个账号）
      - 多行文本，每行“用户名 Cookie”或只有 Cookie
      - 用户名:密码:邮箱:auth_token:ct0（丢弃密码和邮箱）
    """
    text = (text or "").lstrip("﻿")
    entries, errors = [], []
    if text.lstrip().startswith("["):
        try:
            arr = json.loads(text)
            if any(not isinstance(c, dict) or not isinstance(c.get("name"), str)
                   or not c["name"] or re.search(f"[;={LINE_BREAKS}]", c["name"])
                   or not isinstance(c.get("value"), str)
                   or re.search(f"[;{LINE_BREAKS}]", c["value"]) for c in arr):
                raise ValueError("invalid cookie array")
            cookies = "; ".join(f"{c['name']}={c['value']}" for c in arr)
        except (ValueError, TypeError, KeyError):
            return [], ["JSON 格式不对：需要是 [{\"name\": ..., \"value\": ...}] 这样的数组"]
        raw_lines = [(1, "", cookies)]
    else:
        raw_lines = []
        for no, line in enumerate(text.splitlines(), start=1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            # 从两端拆开，允许密码里包含冒号；只保留用户名和两个 Cookie。
            if (line.count(":") >= 4
                    and USERNAME_RE.fullmatch(line.partition(":")[0].strip().lstrip("@"))
                    and not re.match(r"^cookie\s*:", line, flags=re.I)):
                name, _, rest = line.partition(":")
                _, email, auth_token, ct0 = (v.strip() for v in rest.rsplit(":", 3))
                if (not re.fullmatch(r"[^\s@:]+@[^\s@:]+", email)
                        or not re.fullmatch(r"[0-9a-fA-F]{40}", auth_token)
                        or not re.fullmatch(r"[0-9a-fA-F]{32,}", ct0)):
                    errors.append(f"第 {no} 行账号格式不对：需要 用户名:密码:邮箱:auth_token:ct0")
                    continue
                raw_lines.append((no, name.strip(), f"auth_token={auth_token}; ct0={ct0}"))
                continue
            parsed = parse_cookie_line(line)
            if parsed:
                name, cookies = parsed
                raw_lines.append((no, name or "", cookies))
    fallback_name = (username or "").strip() if len(raw_lines) + len(errors) == 1 else ""
    for no, name, cookies in raw_lines:
        cookies = normalize_cookies(cookies)
        cd = cookie_dict(cookies)
        if "auth_token" not in cd or "ct0" not in cd:
            errors.append(f"第 {no} 行缺少 auth_token 或 ct0")
            continue
        name = (name or fallback_name or derive_username(cd)).lstrip("@")
        if not USERNAME_RE.fullmatch(name):
            errors.append(f"第 {no} 行用户名不合法，只能用 1–40 位字母、数字和下划线")
            continue
        entries.append({"username": name, "cookies": cookies})
    if not raw_lines and not errors:
        errors.append("没有识别到任何 Cookie")
    return entries, errors


def derive_username(cookies: dict[str, str]) -> str:
    m = re.search(r"u(?:%3D|=)(\d+)", cookies.get("twid", ""))
    if m:
        return f"uid{m.group(1)}"
    return "acct_" + hashlib.sha1(cookies["auth_token"].encode()).hexdigest()[:8]


def classify(error: str | None) -> tuple[str, str]:
    """把 twscrape 记下的错误归成账号状态。只有明确是登录失效的才判 invalid，其余都还有机会恢复。"""
    msg = (error or "").strip()
    if "(32)" in msg or "Missing authentication cookies" in msg:
        return "invalid", f"登录状态失效：{msg}"
    if "(326)" in msg:
        return "locked", f"账号被锁定，需要在浏览器里登录解锁：{msg}"
    return "cooldown", msg or "请求被拒绝，原因不明（可能是临时风控）"


def transition(row, verdict: str, reason: str | None, now: datetime) -> dict:
    """根据一次检测或请求的结果算出账号的新状态。verdict 是 ok / cooldown / locked / invalid。"""
    status = row["status"]
    if verdict == "ok":
        return {
            "status": "active", "reason": None, "since": row["status_since"] if status == "active" else now,
            "failures": 0, "next_check": now + timedelta(hours=X_CHECK_INTERVAL_H), "last_ok": now,
            "event": "ok" if status == "active" else "restored",
        }
    invalid = {"status": "invalid", "reason": reason, "since": now, "failures": 0, "next_check": None,
               "last_ok": row["last_ok_at"], "event": "invalid"}
    if verdict == "invalid":
        return invalid
    same = status == verdict
    since = row["status_since"] if same else now
    failures = row["failures"] + 1 if same else 1
    if verdict == "locked":
        giveup, delay, label = X_LOCKED_GIVEUP_DAYS, X_LOCKED_RECHECK_H, "锁定"
    else:
        giveup, delay, label = X_COOLDOWN_GIVEUP_DAYS, X_COOLDOWN_STEPS_H[min(failures, len(X_COOLDOWN_STEPS_H)) - 1], "冷却"
    if now - since >= timedelta(days=giveup):
        return {**invalid, "reason": f"{label}超过 {giveup:g} 天仍未恢复：{reason}"}
    return {"status": verdict, "reason": reason, "since": since, "failures": failures,
            "next_check": now + timedelta(hours=delay), "last_ok": row["last_ok_at"], "event": verdict}


# 数据库里时间存 UTC 的 Unix 秒；读出来换成带时区的 datetime，状态计算和测试都用 datetime
TIME_COLS = ("status_since", "next_check_at", "last_ok_at", "last_used_at", "created_at", "updated_at", "at")


def ts(dt: datetime | None) -> float | None:
    return dt.timestamp() if dt else None


def account(r) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    for k in TIME_COLS:
        if d.get(k) is not None:
            d[k] = datetime.fromtimestamp(d[k], timezone.utc)
    return d


def fmt(dt: datetime | None) -> str | None:
    return dt.astimezone().strftime("%Y-%m-%dT%H:%M") if dt else None


def today() -> str:
    return date.today().isoformat()


def event(c, account_id, username: str, source: str, name: str, detail: str | None = None) -> None:
    c.execute(
        "insert into x_account_events (account_id, username, at, source, event, detail) values (?, ?, ?, ?, ?, ?)",
        (account_id, username, time.time(), source, name, detail),
    )


class XPool:
    def __init__(self, runtime_db: Path | None = None):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.api = API(str(runtime_db or DATA_DIR / "x_accounts.db"))  # 网络跟系统的代理设置走
        # twscrape 默认按用户名排序取账号，请求会一直压在同一个号上；改成优先用最久没用过的
        self.api.pool._order_by = "last_used IS NOT NULL, last_used"
        self.db: DB | None = None
        # 发请求、改运行时号池都要持有这把锁：同一时间只有一个请求，同步时不会有请求在跑
        self.req_lock = asyncio.Lock()
        self.last_req = 0.0
        self.checking = False
        self.network_issue: str | None = None

    async def start(self, db: DB) -> None:
        self.db = db
        await self.resync()

    # ---------- 保存、删除 ----------
    async def add_accounts(self, text: str, username: str | None = None) -> dict:
        """批量保存：按登录令牌和用户名去重，同名的新令牌更新原账号并重新启用。"""
        entries, errors = parse_paste(text, username)
        if not entries:
            raise PoolError("bad_input", f"新增 0 个，更新 0 个，重复跳过 0 个，格式无效 {len(errors)} 个。" + "；".join(errors))
        added, replaced, duplicates = [], [], []

        def go(c):
            now = time.time()
            rows = c.execute("select id, username, auth_token from x_accounts").fetchall()
            by_name = {r["username"].casefold(): r for r in rows}
            tokens = {r["auth_token"] for r in rows}
            seen_names, seen_tokens = set(), set()
            for e in entries:
                name, cookies = e["username"], e["cookies"]
                key, token = name.casefold(), cookie_dict(cookies)["auth_token"]
                repeated = key in seen_names or token in seen_tokens
                seen_names.add(key)
                seen_tokens.add(token)
                if repeated or token in tokens:
                    duplicates.append({"username": name, "reason": "batch" if repeated else "existing"})
                    continue
                if key in by_name:
                    r = by_name[key]
                    c.execute(
                        """update x_accounts set auth_token = ?, cookies = ?, status = 'active', status_reason = null,
                           status_since = ?, failures = 0, next_check_at = ?, updated_at = ? where id = ?""",
                        (token, cookies, now, now, now, r["id"]),
                    )
                    event(c, r["id"], r["username"], "import", "updated")
                    replaced.append(r["username"])
                else:
                    account_id = c.execute(
                        """insert into x_accounts (username, auth_token, cookies, status_since, next_check_at, created_at, updated_at)
                           values (?, ?, ?, ?, ?, ?, ?)""",
                        (name, token, cookies, now, now, now, now),
                    ).lastrowid
                    event(c, account_id, name, "import", "added")
                    added.append(name)

        await self.db.tx(go)
        await self.resync()
        return {
            "added": added, "replaced": replaced, "duplicates": duplicates, "errors": errors,
            "summary": {"added": len(added), "updated": len(replaced), "duplicates": len(duplicates),
                        "invalid": len(errors), "total": len(entries) + len(errors)},
        }

    async def remove_account(self, username: str) -> dict:
        def go(c):
            r = c.execute("select id, username from x_accounts where lower(username) = lower(?)", (username,)).fetchone()
            if not r:
                return None
            c.execute("delete from x_accounts where id = ?", (r["id"],))
            event(c, None, r["username"], "manual", "removed")
            return r["username"]

        removed = await self.db.tx(go)
        if not removed:
            raise PoolError("not_found", f"号池里没有账号 {username}")
        await self.resync()
        return {"removed": removed}

    # ---------- 状态变化 ----------
    async def _apply(self, username: str, token: str, verdict: str, reason: str | None, source: str) -> str | None:
        """按结果更新账号状态，返回新状态。账号已删除或换了 Cookie（结果属于旧 Cookie）时不改动，返回 None。"""
        def go(c):
            row = account(c.execute(
                "select * from x_accounts where lower(username) = lower(?) and auth_token = ?", (username, token)
            ).fetchone())
            if not row:
                return None
            n = transition(row, verdict, reason, datetime.now(timezone.utc))
            c.execute(
                """update x_accounts set status = ?, status_reason = ?, status_since = ?, failures = ?,
                   next_check_at = ?, last_ok_at = ?, updated_at = ? where id = ?""",
                (n["status"], n["reason"], ts(n["since"]), n["failures"], ts(n["next_check"]), ts(n["last_ok"]), time.time(), row["id"]),
            )
            event(c, row["id"], row["username"], source, n["event"], n["reason"])
            return n["status"]

        return await self.db.tx(go)

    async def _defer(self, username: str, token: str, reason: str) -> bool:
        """疑似网络问题：状态不变，稍后再测。"""
        def go(c):
            row = c.execute(
                "select id, username from x_accounts where lower(username) = lower(?) and auth_token = ?", (username, token)
            ).fetchone()
            if not row:
                return False
            now = time.time()
            c.execute("update x_accounts set next_check_at = ?, updated_at = ? where id = ?",
                      (now + NETWORK_RETRY.total_seconds(), now, row["id"]))
            event(c, row["id"], row["username"], "check", "network", reason)
            return True

        return await self.db.tx(go)

    # ---------- 运行时号池（twscrape） ----------
    async def _runtime_accounts(self) -> list:
        try:
            return await self.api.pool.get_all()
        except Exception as e:  # noqa: BLE001
            if "no such table" in str(e):  # 新的运行时库，表要第一次写入时才创建
                return []
            raise

    async def _sync_runtime(self) -> None:
        """调用方持有 req_lock。运行时号池只保留可用且今天没用满的账号，Cookie 变了的重新加入。"""
        rows = await self.db.fetch(
            """select a.username, a.auth_token, a.cookies from x_accounts a
               left join x_account_usage u on u.account_id = a.id and u.day = ?
               where a.status = 'active' and coalesce(u.requests, 0) < ?""",
            today(), X_DAILY_REQ_PER_ACCOUNT,
        )
        wanted = {r["username"]: r for r in rows}
        current = {a.username: a for a in await self._runtime_accounts()}
        stale = [u for u, a in current.items() if u not in wanted or a.cookies.get("auth_token") != wanted[u]["auth_token"]]
        if stale:
            await self.api.pool.delete_accounts(stale)
        for u, r in wanted.items():
            if u not in current or u in stale:
                await self.api.pool.add_account(u, "-", "-", "-", cookies=r["cookies"])

    async def _reap(self) -> None:
        """调用方持有 req_lock。twscrape 在请求中判定不可用的账号，按错误归类后移出运行时号池。"""
        for a in await self._runtime_accounts():
            if not a.active:
                status, reason = classify(a.error_msg)
                await self._apply(a.username, a.cookies.get("auth_token", ""), status, reason, "request")
        await self._sync_runtime()

    async def resync(self) -> None:
        async with self.req_lock:
            await self._reap()

    # ---------- 用量 ----------
    async def _add_usage(self, counts: dict[int, int]) -> None:
        def go(c):
            now = time.time()
            for account_id, n in counts.items():
                c.execute(
                    """insert into x_account_usage (account_id, day, requests)
                       select ?, ?, ? where exists (select 1 from x_accounts where id = ?)
                       on conflict (account_id, day) do update set requests = x_account_usage.requests + excluded.requests""",
                    (account_id, today(), n, account_id),
                )
                c.execute("update x_accounts set last_used_at = ? where id = ?", (now, account_id))

        await self.db.tx(go)

    async def _runtime_requests(self) -> dict[str, int]:
        return {a.username: sum(a.stats.values()) for a in await self._runtime_accounts()}

    async def _record_runtime_usage(self, before: dict[str, int]) -> None:
        """按 twscrape 记录的请求数差值，算出这次每个账号实际发了几次请求。"""
        deltas = {u: n - before.get(u, 0) for u, n in (await self._runtime_requests()).items() if n > before.get(u, 0)}
        if not deltas:
            return
        marks = ", ".join("?" * len(deltas))
        ids = await self.db.fetch(f"select id, username from x_accounts where username in ({marks})", *deltas)
        await self._add_usage({r["id"]: deltas[r["username"]] for r in ids})

    # ---------- 状态 ----------
    async def status(self) -> dict:
        rows = [account(r) for r in await self.db.fetch(
            """select a.*, coalesce(u.requests, 0) as requests_today from x_accounts a
               left join x_account_usage u on u.account_id = a.id and u.day = ?
               order by case a.status when 'active' then 0 when 'cooldown' then 1 when 'locked' then 2 else 3 end, lower(a.username)""",
            today(),
        )]
        events = [account(r) for r in await self.db.fetch(
            """select username, at, source, event, detail from x_account_events
               where event in ('cooldown', 'locked', 'invalid', 'restored', 'network') order by at desc, id desc limit 10"""
        )]
        last_check = await self.db.fetchval("select max(at) from x_account_events where source = 'check'")
        counts = {s: 0 for s in STATUSES}
        for r in rows:
            counts[r["status"]] += 1
        active = counts["active"]
        need_more = bool(rows) and active < X_POOL_MIN
        return {
            "active": active,
            "counts": counts,
            "minRequired": X_POOL_MIN,
            "needMore": need_more,
            "message": f"可用账号只有 {active} 个，少于 {X_POOL_MIN} 个，请在「渠道 → 推特」补充账号" if need_more else None,
            "networkIssue": self.network_issue,
            "usage": {"today": sum(r["requests_today"] for r in rows), "cap": X_DAILY_REQ_PER_ACCOUNT * active,
                      "perAccount": X_DAILY_REQ_PER_ACCOUNT, "minIntervalSec": X_MIN_INTERVAL_SEC},
            "accounts": [
                {
                    "username": r["username"],
                    "token": r["auth_token"][:6] + "…",  # 只露前 6 位，方便核对是哪一份 Cookie
                    "status": r["status"],
                    "reason": r["status_reason"],
                    "since": fmt(r["status_since"]),
                    "failures": r["failures"],
                    "nextCheckAt": fmt(r["next_check_at"]),
                    "lastOkAt": fmt(r["last_ok_at"]),
                    "lastUsed": fmt(r["last_used_at"]),
                    "requestsToday": r["requests_today"],
                }
                for r in rows
            ],
            "recentChanges": [
                {"username": e["username"], "event": e["event"], "detail": e["detail"], "source": e["source"], "at": fmt(e["at"])}
                for e in events
            ],
            "rules": {"checkIntervalH": X_CHECK_INTERVAL_H, "cooldownStepsH": X_COOLDOWN_STEPS_H,
                      "cooldownGiveupDays": X_COOLDOWN_GIVEUP_DAYS, "lockedRecheckH": X_LOCKED_RECHECK_H,
                      "lockedGiveupDays": X_LOCKED_GIVEUP_DAYS},
            "lastCheck": fmt(datetime.fromtimestamp(last_check, timezone.utc)) if last_check else None,
            "checking": self.checking,
        }

    # ---------- 体检 ----------
    async def _probe(self, username: str, cookies: str) -> tuple[str, str | None]:
        """
        用独立的临时号池单独测试一个账号。返回 ok / cooldown / locked / invalid，
        或 unknown（超时、报错、没结果，分不清是账号还是网络的问题）。
        """
        with tempfile.TemporaryDirectory() as d:
            probe = API(str(Path(d) / "probe.db"))
            await probe.pool.add_account(username, "-", "-", "-", cookies=cookies)
            try:
                user = await asyncio.wait_for(probe.user_by_login(X_CHECK_TARGET), X_REQUEST_TIMEOUT)
            except asyncio.TimeoutError:
                return "unknown", "检测超时"
            except Exception as e:  # noqa: BLE001
                return "unknown", f"{type(e).__name__}: {e}"[:120]
            acc = await probe.pool.get(username)
            if not acc.active:
                return classify(acc.error_msg)
            return ("ok", None) if user else ("unknown", "查询没有返回结果，可能在限流冷却中")

    async def _check(self, rows: list) -> dict:
        """逐个检测。结果不明的先放着，整批看完再判断是账号的问题还是网络的问题。"""
        result = {s: [] for s in STATUSES} | {"skipped": [], "networkIssue": False}

        def put(r, status, reason):
            if status is None:
                result["skipped"].append({"username": r["username"], "reason": "检测期间账号已更新或删除，忽略这次结果"})
            else:
                result[status].append({"username": r["username"], "reason": reason})

        unknown, definite = [], 0
        for i, r in enumerate(rows):
            if i:
                await asyncio.sleep(X_MIN_INTERVAL_SEC + random.uniform(0, 2))
            verdict, reason = await self._probe(r["username"], r["cookies"])
            await self._add_usage({r["id"]: 1})
            if verdict == "unknown":
                unknown.append((r, reason))
                continue
            definite += 1
            put(r, await self._apply(r["username"], r["auth_token"], verdict, reason, "check"), reason)

        network = len(unknown) >= 2 and definite == 0
        for r, reason in unknown:
            if r["status"] == "invalid":  # 手动重测已失效的账号没得到明确结果，保持失效
                result["skipped"].append({"username": r["username"], "reason": f"没有得到明确结果，保持失效：{reason}"})
            elif network:
                await self._defer(r["username"], r["auth_token"], reason)
                result["skipped"].append({"username": r["username"], "reason": f"疑似网络问题，状态不变：{reason}"})
            else:
                put(r, await self._apply(r["username"], r["auth_token"], "cooldown", reason, "check"), reason)
        if network:
            result["networkIssue"] = True
            self.network_issue = (f"{datetime.now():%m-%d %H:%M} 检测的 {len(unknown)} 个账号都没有结果（{unknown[0][1]}），"
                                  "可能是网络或代理问题。账号状态没有改动，一小时后重测")
        elif definite:
            self.network_issue = None
        await self.resync()
        return result

    async def _run_check(self, rows: list) -> dict:
        if self.checking:
            raise PoolError("busy", "体检正在进行中")
        self.checking = True
        try:
            return await self._check(rows)
        finally:
            self.checking = False

    async def check_all(self) -> dict:
        """立即检测所有没失效的账号。"""
        return await self._run_check(await self.db.fetch("select * from x_accounts where status <> 'invalid' order by id"))

    async def check_one(self, username: str) -> dict:
        """立即检测一个账号，已失效的也可以（比如觉得被误判了）。"""
        row = await self.db.fetchrow("select * from x_accounts where lower(username) = lower(?)", username)
        if not row:
            raise PoolError("not_found", f"号池里没有账号 {username}")
        return await self._run_check([row])

    async def check_due(self) -> dict | None:
        """检测到了下次检测时间的账号。"""
        if self.checking:
            return None
        rows = await self.db.fetch(
            "select * from x_accounts where status <> 'invalid' and next_check_at <= ? order by next_check_at, id", time.time()
        )
        return await self._run_check(rows) if rows else None

    # ---------- 查询 ----------
    async def _run(self, make_coro):
        async with self.req_lock:
            await self._sync_runtime()
            n = await self.db.fetchrow(
                """select coalesce(sum(a.status = 'active'), 0) as active,
                          coalesce(sum(a.status = 'active' and coalesce(u.requests, 0) < ?), 0) as usable
                   from x_accounts a left join x_account_usage u on u.account_id = a.id and u.day = ?""",
                X_DAILY_REQ_PER_ACCOUNT, today(),
            )
            if not n["active"]:
                raise PoolError("no_accounts", "号池里没有可用账号，请在「渠道 → 推特」添加账号")
            if not n["usable"]:
                raise PoolError("quota", "可用账号今天的请求次数都用完了，明天再试或增加账号")
            wait = self.last_req + X_MIN_INTERVAL_SEC + random.uniform(0, 2) - time.time()
            if wait > 0:
                await asyncio.sleep(wait)
            before = await self._runtime_requests()
            try:
                return await asyncio.wait_for(make_coro(), X_REQUEST_TIMEOUT)
            except asyncio.TimeoutError as e:
                raise PoolError("timeout", "请求超时：账号可能都在限流冷却中，稍后再试") from e
            finally:
                self.last_req = time.time()
                await self._record_runtime_usage(before)
                await self._reap()

    @staticmethod
    async def _collect(agen, limit: int) -> list:
        # 提前 break 也要立刻关掉生成器：twscrape 在关闭时才记请求数、释放账号占用
        out = []
        async with aclosing(agen) as gen:
            async for x in gen:
                out.append(x)
                if len(out) >= limit:
                    break
        return out

    async def has_accounts(self) -> bool:
        return bool(await self.db.fetchval("select 1 from x_accounts limit 1"))

    async def search_tweets(self, q: str, limit: int = 20, product: str = "Top") -> list:
        """返回 twscrape 的原始推文对象，渠道整理数据时用。"""
        return await self._run(lambda: self._collect(self.api.search(q, limit=limit, kv={"product": product}), limit))

    async def search(self, q: str, limit: int = 20, product: str = "Top") -> list[dict]:
        return [tweet_out(t) for t in await self.search_tweets(q, limit, product)]

    async def list_timeline(self, list_id: int, limit: int = 20) -> list[dict]:
        items = await self._run(lambda: self._collect(self.api.list_timeline(list_id, limit=limit), limit))
        return [tweet_out(t) for t in items]

    async def user_tweets(self, username: str, limit: int = 20) -> list[dict]:
        user = await self._run(lambda: self.api.user_by_login(username))
        if not user:
            raise PoolError("not_found", f"找不到用户 @{username}")
        items = await self._run(lambda: self._collect(self.api.user_tweets(user.id, limit=limit), limit))
        return [tweet_out(t) for t in items]

    async def trends(self, category: str = "trending", limit: int = 30) -> list[dict]:
        items = await self._run(lambda: self._collect(self.api.trends(category, limit=limit), limit))
        return [to_dict(t) for t in items]

    # ---------- 后台任务 ----------
    async def background(self) -> None:
        await asyncio.sleep(30)
        while True:
            try:
                await self.resync()  # 处理请求中失效的账号；跨天后把昨天用满的账号放回来
                await self.check_due()
            except Exception as e:  # noqa: BLE001 — 后台任务不能挂
                print(f"[xpool] 后台任务出错：{e}")
            await asyncio.sleep(60)


def to_dict(obj) -> dict:
    if hasattr(obj, "dict"):
        return obj.dict()
    return dict(vars(obj))


def tweet_out(t) -> dict:
    d = to_dict(t)
    u = d.get("user") or {}
    media = d.get("media") or {}
    return {
        "id": d.get("id_str") or str(d.get("id")),
        "url": d.get("url"),
        "date": d.get("date"),
        "text": d.get("rawContent"),
        "lang": d.get("lang"),
        "likes": d.get("likeCount"),
        "retweets": d.get("retweetCount"),
        "replies": d.get("replyCount"),
        "quotes": d.get("quoteCount"),
        "views": d.get("viewCount"),
        "user": {
            "username": u.get("username"),
            "name": u.get("displayname"),
            "followers": u.get("followersCount"),
            "verified": bool(u.get("verified") or u.get("blue")),
        },
        "media": {
            "photos": [p.get("url") for p in media.get("photos") or []],
            "videos": [{"thumbnail": v.get("thumbnailUrl"), "duration": v.get("duration")} for v in media.get("videos") or []],
        },
    }
