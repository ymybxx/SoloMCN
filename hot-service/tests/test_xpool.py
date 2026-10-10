"""
号池测试。凭据都是合成的；不会访问 X（建账号客户端的方法被替换成直接报错）。
用到数据库的测试各自用一个临时的 SQLite 文件。
"""

import asyncio
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import xpool
from db import connect
from twscrape.account import Account


def auth(number: int) -> str:
    return f"{number:040x}"


def csrf(number: int) -> str:
    return f"{number:064x}"


def cookies(number: int, csrf_number: int | None = None) -> str:
    return f"auth_token={auth(number)}; ct0={csrf(csrf_number or number)}"


def record(username: str, number: int, password: str = "synthetic-password") -> str:
    return f"{username}:{password}:fixture@example.invalid:{auth(number)}:{csrf(number)}"


def now() -> datetime:
    return datetime.now(timezone.utc)


class ParsePasteTests(unittest.TestCase):
    def test_multiple_colon_records_extract_only_username_and_cookies(self):
        entries, errors = xpool.parse_paste("\n".join(record(name, n) for n, name in enumerate(("Alice", "Bob", "Carol"), 1)))

        self.assertEqual(errors, [])
        self.assertEqual([entry["username"] for entry in entries], ["Alice", "Bob", "Carol"])
        for number, entry in enumerate(entries, 1):
            self.assertEqual(set(entry), {"username", "cookies"})
            self.assertEqual(xpool.cookie_dict(entry["cookies"]), {"auth_token": auth(number), "ct0": csrf(number)})
        self.assertNotIn("synthetic-password", json.dumps(entries))
        self.assertNotIn("fixture@example.invalid", json.dumps(entries))

    def test_colon_in_password_does_not_shift_cookie_fields(self):
        entries, errors = xpool.parse_paste(record("Alice", 1, password="synthetic:password:parts"))

        self.assertEqual(errors, [])
        self.assertEqual(entries, [{"username": "Alice", "cookies": cookies(1)}])

    def test_standard_cookie_formats_remain_supported(self):
        for value in (cookies(1), "Cookie: " + cookies(1), '"' + cookies(1) + '"', "@Alice " + cookies(1), "Alice\t" + cookies(1)):
            with self.subTest(value=value):
                entries, errors = xpool.parse_paste(value)
                self.assertEqual(errors, [])
                self.assertEqual(len(entries), 1)
                self.assertEqual(xpool.cookie_dict(entries[0]["cookies"]), {"auth_token": auth(1), "ct0": csrf(1)})

    def test_cookie_editor_json_remains_supported(self):
        value = json.dumps([{"name": "auth_token", "value": auth(1)}, {"name": "ct0", "value": csrf(1)}])
        entries, errors = xpool.parse_paste(value, "Alice")

        self.assertEqual(errors, [])
        self.assertEqual(entries, [{"username": "Alice", "cookies": cookies(1)}])

    def test_colons_in_extra_cookie_do_not_turn_cookie_input_into_account_record(self):
        value = "Alice " + cookies(1) + "; redirect=https://example.invalid:8443/a:b:c"
        entries, errors = xpool.parse_paste(value)

        self.assertEqual(errors, [])
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["username"], "Alice")
        self.assertEqual(xpool.cookie_dict(entries[0]["cookies"])["auth_token"], auth(1))

    def test_username_override_applies_only_to_one_unnamed_record(self):
        single, errors = xpool.parse_paste("\n# ignored comment\n" + cookies(1) + "\n", "Alice")
        self.assertEqual(errors, [])
        self.assertEqual(single[0]["username"], "Alice")

        multiple, errors = xpool.parse_paste(cookies(1) + "\n" + cookies(2), "SharedName")
        self.assertEqual(errors, [])
        self.assertEqual(len({entry["username"] for entry in multiple}), 2)
        self.assertNotIn("SharedName", [entry["username"] for entry in multiple])

    def test_explicit_username_takes_precedence_over_override(self):
        entries, errors = xpool.parse_paste(record("Alice", 1), "Bob")
        self.assertEqual(errors, [])
        self.assertEqual(entries[0]["username"], "Alice")

    def test_errors_refer_to_original_line_and_do_not_echo_input(self):
        secret_marker = "sensitive-invalid-input@example.invalid"
        value = "\n# comment\n" + record("Alice", 1) + "\n\n" + secret_marker + " " + cookies(2)
        entries, errors = xpool.parse_paste(value)

        self.assertEqual(len(entries), 1)
        self.assertEqual(len(errors), 1)
        self.assertRegex(errors[0], r"第\s*5\s*行")
        self.assertNotIn(secret_marker, errors[0])
        self.assertNotIn(auth(2), errors[0])
        self.assertNotIn(csrf(2), errors[0])

    def test_invalid_colon_tokens_are_rejected_without_echoing_credentials(self):
        malformed = [
            f"Alice:private-fixture:fixture@example.invalid:{auth(1)[:-1]}:{csrf(1)}",
            f"Alice:private-fixture:fixture@example.invalid:{auth(1)}:short-csrf",
            record("Alice", 1) + "unrelated-suffix",
        ]
        for value in malformed:
            with self.subTest(value=value):
                entries, errors = xpool.parse_paste(value)
                self.assertEqual(entries, [])
                self.assertTrue(errors)
                self.assertNotIn("private-fixture", " ".join(errors))
                self.assertNotIn("fixture@example.invalid", " ".join(errors))

    def test_malformed_json_returns_validation_error(self):
        entries, errors = xpool.parse_paste('[{"name": "auth_token",')
        self.assertEqual(entries, [])
        self.assertTrue(errors)

    def test_json_rejects_cookie_names_or_values_that_can_inject_fields_or_lines(self):
        bad_items = [
            {"name": "extra;another", "value": "fixture"},
            {"name": "extra=another", "value": "fixture"},
            {"name": "extra", "value": "fixture; auth_token=" + auth(2)},
        ]
        for separator in "\r\n\v\f\x1c\x1d\x1e\x85\u2028\u2029":
            bad_items.extend((
                {"name": "extra" + separator + "Alice", "value": "fixture"},
                {"name": "extra", "value": "fixture" + separator + "Bob " + cookies(2)},
            ))
        for bad_item in bad_items:
            with self.subTest(bad_item=bad_item):
                value = json.dumps([
                    {"name": "auth_token", "value": auth(1)},
                    {"name": "ct0", "value": csrf(1)},
                    bad_item,
                ])
                entries, errors = xpool.parse_paste(value)
                self.assertEqual(entries, [])
                self.assertTrue(errors)
                self.assertNotIn("fixture", " ".join(errors))


class ClassifyTests(unittest.TestCase):
    def test_only_authentication_failures_are_permanent(self):
        self.assertEqual(xpool.classify("(32) Could not authenticate you")[0], "invalid")
        self.assertEqual(xpool.classify("Missing authentication cookies")[0], "invalid")
        self.assertEqual(xpool.classify("(326) Authorization: Denied by access control")[0], "locked")
        self.assertEqual(xpool.classify("(88) Rate limit exceeded")[0], "cooldown")
        status, reason = xpool.classify(None)
        self.assertEqual(status, "cooldown")
        self.assertTrue(reason)


class TransitionTests(unittest.TestCase):
    def row(self, status="active", since=None, failures=0):
        return {"status": status, "status_since": since or now() - timedelta(days=30), "failures": failures, "last_ok_at": None}

    def test_ok_keeps_active_since_and_schedules_next_check(self):
        row, t = self.row(), now()
        n = xpool.transition(row, "ok", None, t)
        self.assertEqual((n["status"], n["event"], n["since"], n["last_ok"]), ("active", "ok", row["status_since"], t))
        self.assertEqual(n["next_check"], t + timedelta(hours=xpool.X_CHECK_INTERVAL_H))

    def test_ok_restores_any_unavailable_status(self):
        for status in ("cooldown", "locked", "invalid"):
            with self.subTest(status=status):
                t = now()
                n = xpool.transition(self.row(status, failures=3), "ok", None, t)
                self.assertEqual((n["status"], n["event"], n["since"], n["failures"]), ("active", "restored", t, 0))

    def test_cooldown_backs_off_and_resets_since_on_entry(self):
        t = now()
        row = self.row()
        delays = []
        with patch.object(xpool, "X_COOLDOWN_STEPS_H", [1, 4, 12, 24]):
            for _ in range(5):
                n = xpool.transition(row, "cooldown", "fixture", t)
                delays.append((n["next_check"] - t) / timedelta(hours=1))
                row = {"status": n["status"], "status_since": n["since"], "failures": n["failures"], "last_ok_at": None}
        self.assertEqual(delays, [1, 4, 12, 24, 24])
        self.assertEqual(row["status_since"], t)

    def test_cooldown_gives_up_after_configured_days(self):
        t = now()
        with patch.object(xpool, "X_COOLDOWN_GIVEUP_DAYS", 3):
            kept = xpool.transition(self.row("cooldown", t - timedelta(days=2, hours=23), 4), "cooldown", "fixture", t)
            dead = xpool.transition(self.row("cooldown", t - timedelta(days=3), 5), "cooldown", "fixture", t)
        self.assertEqual(kept["status"], "cooldown")
        self.assertEqual((dead["status"], dead["next_check"]), ("invalid", None))
        self.assertIn("冷却超过 3 天", dead["reason"])

    def test_locked_rechecks_and_gives_up(self):
        t = now()
        with patch.object(xpool, "X_LOCKED_RECHECK_H", 12), patch.object(xpool, "X_LOCKED_GIVEUP_DAYS", 7):
            n = xpool.transition(self.row(), "locked", "fixture", t)
            dead = xpool.transition(self.row("locked", t - timedelta(days=7), 14), "locked", "fixture", t)
        self.assertEqual((n["status"], n["next_check"], n["failures"]), ("locked", t + timedelta(hours=12), 1))
        self.assertEqual(dead["status"], "invalid")
        self.assertIn("锁定超过 7 天", dead["reason"])

    def test_switching_unavailable_kind_restarts_the_clock(self):
        t = now()
        n = xpool.transition(self.row("cooldown", t - timedelta(days=2), 4), "locked", "fixture", t)
        self.assertEqual((n["status"], n["since"], n["failures"]), ("locked", t, 1))

    def test_invalid_is_terminal(self):
        n = xpool.transition(self.row("cooldown", failures=2), "invalid", "fixture", now())
        self.assertEqual((n["status"], n["next_check"], n["failures"]), ("invalid", None, 0))


class PoolTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="xpool-test-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for target, value in (("DATA_DIR", root), ("X_MIN_INTERVAL_SEC", 0)):
            patcher = patch.object(xpool, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(xpool.random, "uniform", return_value=0)
        patcher.start()
        self.addCleanup(patcher.stop)
        network_guard = patch.object(Account, "make_client", side_effect=AssertionError("Network access is forbidden in pool tests"))
        network_guard.start()
        self.addCleanup(network_guard.stop)
        db = await connect(root / "hot.db")
        self.addAsyncCleanup(db.close)
        self.pool = xpool.XPool(root / "runtime.db")
        await self.pool.start(db)

    async def row(self, username):
        return xpool.account(await self.pool.db.fetchrow("select * from x_accounts where lower(username) = lower(?)", username))

    async def names(self):
        return {r["username"] for r in await self.pool.db.fetch("select username from x_accounts")}

    async def runtime(self):
        return {a.username: a for a in await self.pool.api.pool.get_all()}

    async def set_row(self, username, **fields):
        sets = ", ".join(f"{k} = ?" for k in fields)
        values = [xpool.ts(v) if isinstance(v, datetime) else v for v in fields.values()]
        await self.pool.db.execute(f"update x_accounts set {sets} where username = ?", *values, username)

    async def events(self, username=None):
        rows = await self.pool.db.fetch("select * from x_account_events order by id")
        return [r["event"] for r in rows if username is None or r["username"] == username]


class AddAccountsTests(PoolTestCase):
    def assert_summary(self, result, *, added=0, updated=0, duplicates=0, invalid=0):
        self.assertEqual(result["summary"], {
            "added": added, "updated": updated, "duplicates": duplicates,
            "invalid": invalid, "total": added + updated + duplicates + invalid,
        })

    async def test_batch_deduplicates_token_and_case_insensitive_username_first_wins(self):
        value = "\n".join((record("Alice", 1), record("Alias", 1), record("aLiCe", 2), record("Bob", 3)))
        result = await self.pool.add_accounts(value)

        self.assert_summary(result, added=2, duplicates=2)
        self.assertEqual(result["added"], ["Alice", "Bob"])
        self.assertEqual([item["reason"] for item in result["duplicates"]], ["batch", "batch"])
        self.assertEqual(await self.names(), {"Alice", "Bob"})
        runtime = await self.runtime()
        self.assertEqual(set(runtime), {"Alice", "Bob"})
        self.assertEqual(runtime["Alice"].cookies["auth_token"], auth(1))
        alice = await self.row("Alice")
        self.assertEqual((alice["status"], alice["auth_token"]), ("active", auth(1)))
        self.assertLessEqual(alice["next_check_at"], now())  # 新账号尽快体检一次

    async def test_existing_token_deduplicates_alias_order_and_different_ct0(self):
        await self.pool.add_accounts(record("Alice", 1))
        before = await self.row("Alice")
        result = await self.pool.add_accounts(f"Alias ct0={csrf(2)}; extra=anything; auth_token={auth(1)}")

        self.assert_summary(result, duplicates=1)
        self.assertEqual(result["duplicates"][0]["reason"], "existing")
        self.assertEqual(await self.names(), {"Alice"})
        self.assertEqual(await self.row("Alice"), before)

    async def test_same_name_new_token_updates_and_preserves_original_case(self):
        await self.pool.add_accounts(record("Alice", 1))
        result = await self.pool.add_accounts(record("aLiCe", 2))

        self.assert_summary(result, updated=1)
        self.assertEqual(result["replaced"], ["Alice"])
        self.assertEqual(await self.names(), {"Alice"})
        self.assertEqual((await self.row("Alice"))["auth_token"], auth(2))
        runtime = await self.runtime()
        self.assertEqual(list(runtime), ["Alice"])
        self.assertEqual(runtime["Alice"].cookies["auth_token"], auth(2))
        self.assertEqual(await self.events("Alice"), ["added", "updated"])

    async def test_new_cookie_reactivates_unavailable_account(self):
        await self.pool.add_accounts(record("Alice", 1))
        await self.set_row("Alice", status="invalid", status_reason="fixture", failures=3, next_check_at=None)
        await self.pool.resync()
        self.assertEqual(await self.runtime(), {})

        await self.pool.add_accounts(record("Alice", 2))

        row = await self.row("Alice")
        self.assertEqual((row["status"], row["status_reason"], row["failures"]), ("active", None, 0))
        self.assertIsNotNone(row["next_check_at"])
        self.assertEqual(list(await self.runtime()), ["Alice"])

    async def test_identical_reimport_preserves_row_and_runtime_usage_and_locks(self):
        await self.pool.add_accounts(record("Alice", 1))
        account = await self.pool.api.pool.get("Alice")
        account.stats = {"SearchTimeline": 17}
        account.locks = {"SearchTimeline": now() + timedelta(hours=1)}
        account.last_used = now()
        await self.pool.api.pool.save(account)
        before_account = (await self.pool.api.pool.get("Alice")).to_rs()
        before_row = await self.row("Alice")

        result = await self.pool.add_accounts(record("Alice", 1))

        self.assert_summary(result, duplicates=1)
        self.assertEqual(await self.row("Alice"), before_row)
        self.assertEqual((await self.pool.api.pool.get("Alice")).to_rs(), before_account)

    async def test_token_of_invalid_account_is_still_a_duplicate(self):
        await self.pool.add_accounts(record("Alice", 1))
        await self.set_row("Alice", status="invalid", next_check_at=None)
        result = await self.pool.add_accounts(record("Alias", 1))

        self.assert_summary(result, duplicates=1)
        self.assertEqual(result["duplicates"][0]["reason"], "existing")
        self.assertEqual((await self.row("Alice"))["status"], "invalid")

    async def test_existing_duplicate_still_reserves_batch_name_for_first_record(self):
        await self.pool.add_accounts(record("Alice", 1))
        result = await self.pool.add_accounts(record("Alias", 1) + "\n" + record("Alias", 2))

        self.assert_summary(result, duplicates=2)
        self.assertEqual([item["reason"] for item in result["duplicates"]], ["existing", "batch"])
        self.assertEqual(await self.names(), {"Alice"})

    async def test_old_token_of_updated_account_is_not_reimported_as_new_alias(self):
        await self.pool.add_accounts(record("Alice", 1))
        result = await self.pool.add_accounts(record("Alice", 2) + "\n" + record("Alias", 1))

        self.assert_summary(result, updated=1, duplicates=1)
        self.assertEqual(result["duplicates"][0]["reason"], "existing")
        self.assertEqual(await self.names(), {"Alice"})
        self.assertEqual((await self.row("Alice"))["auth_token"], auth(2))

    async def test_mixed_valid_invalid_and_duplicates_report_complete_counts(self):
        await self.pool.add_accounts(record("Alice", 1))
        value = "\n".join((record("Bob", 2), "invalid fixture text", record("Alias", 1), record("Bob", 3)))
        result = await self.pool.add_accounts(value)

        self.assert_summary(result, added=1, duplicates=2, invalid=1)
        self.assertEqual(result["added"], ["Bob"])
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(await self.names(), {"Alice", "Bob"})

    async def test_all_invalid_changes_nothing(self):
        await self.pool.add_accounts(record("Alice", 1))
        with self.assertRaises(xpool.PoolError) as raised:
            await self.pool.add_accounts("invalid fixture text")
        self.assertEqual(raised.exception.code, "bad_input")
        self.assertEqual(await self.names(), {"Alice"})
        self.assertEqual(await self.events(), ["added"])

    async def test_concurrent_imports_preserve_both_batches_and_deduplicate_overlap(self):
        first = record("Alice", 1) + "\n" + record("Shared", 3)
        second = record("Bob", 2) + "\n" + record("Shared", 3)
        results = await asyncio.wait_for(asyncio.gather(self.pool.add_accounts(first), self.pool.add_accounts(second)), timeout=10)

        self.assertEqual(sum(result["summary"]["added"] for result in results), 3)
        self.assertEqual(sum(result["summary"]["duplicates"] for result in results), 1)
        self.assertEqual(await self.names(), {"Alice", "Bob", "Shared"})
        self.assertEqual(set(await self.runtime()), {"Alice", "Bob", "Shared"})

    async def test_persistence_discards_password_and_email(self):
        await self.pool.add_accounts(record("Alice", 1, password="do-not-persist-fixture"))
        dump = json.dumps([dict(r) for r in await self.pool.db.fetch("select * from x_accounts")], default=str)
        dump += json.dumps([dict(r) for r in await self.pool.db.fetch("select * from x_account_events")], default=str)
        account = await self.pool.api.pool.get("Alice")

        for secret in ("do-not-persist-fixture", "fixture@example.invalid"):
            self.assertNotIn(secret, dump)
            self.assertNotIn(secret, json.dumps(account.to_rs(), default=str))


class RemoveAccountTests(PoolTestCase):
    async def test_remove_deletes_account_and_usage_but_keeps_history(self):
        await self.pool.add_accounts(record("Alice", 1) + "\n" + record("Bob", 2))
        await self.pool._add_usage({(await self.row("Alice"))["id"]: 5})

        self.assertEqual(await self.pool.remove_account("alice"), {"removed": "Alice"})

        self.assertEqual(await self.names(), {"Bob"})
        self.assertEqual(set(await self.runtime()), {"Bob"})
        self.assertEqual(await self.pool.db.fetchval("select count(*) from x_account_usage"), 0)
        history = await self.pool.db.fetch("select account_id, event from x_account_events where username = 'Alice' order by id")
        self.assertEqual([(r["account_id"], r["event"]) for r in history], [(None, "added"), (None, "removed")])

    async def test_remove_unknown_account(self):
        with self.assertRaises(xpool.PoolError) as raised:
            await self.pool.remove_account("Nobody")
        self.assertEqual(raised.exception.code, "not_found")


class CheckTests(PoolTestCase):
    def probe(self, results: dict):
        async def fake(username, _cookies):
            value = results[username]
            return value if isinstance(value, tuple) else (value, None if value == "ok" else "fixture reason")
        return patch.object(self.pool, "_probe", side_effect=fake)

    async def test_all_unknown_is_treated_as_network_problem(self):
        await self.pool.add_accounts(record("Alice", 1) + "\n" + record("Bob", 2))
        await self.set_row("Bob", status="cooldown", failures=2)
        with self.probe({"Alice": "unknown", "Bob": "unknown"}):
            result = await self.pool.check_all()

        self.assertTrue(result["networkIssue"])
        self.assertEqual(len(result["skipped"]), 2)
        alice, bob = await self.row("Alice"), await self.row("Bob")
        self.assertEqual((alice["status"], bob["status"], bob["failures"]), ("active", "cooldown", 2))
        for row in (alice, bob):
            self.assertAlmostEqual((row["next_check_at"] - now()) / timedelta(hours=1), 1, delta=0.05)
        self.assertIn("网络", (await self.pool.status())["networkIssue"])
        self.assertEqual(await self.events("Alice"), ["added", "network"])

    async def test_unknown_with_another_definite_result_means_account_problem(self):
        await self.pool.add_accounts(record("Alice", 1) + "\n" + record("Bob", 2) + "\n" + record("Carol", 3))
        with self.probe({"Alice": "ok", "Bob": "unknown", "Carol": "unknown"}):
            result = await self.pool.check_all()

        self.assertFalse(result["networkIssue"])
        self.assertEqual([x["username"] for x in result["cooldown"]], ["Bob", "Carol"])
        self.assertEqual(set(await self.runtime()), {"Alice"})

    async def test_single_unknown_goes_to_cooldown(self):
        await self.pool.add_accounts(record("Alice", 1))
        with self.probe({"Alice": "unknown"}):
            result = await self.pool.check_all()
        self.assertEqual([x["username"] for x in result["cooldown"]], ["Alice"])
        self.assertEqual((await self.row("Alice"))["status"], "cooldown")

    async def test_definite_results_map_to_statuses_and_runtime(self):
        names = ("Alice", "Bob", "Carol", "Dave")
        await self.pool.add_accounts("\n".join(record(n, i) for i, n in enumerate(names, 1)))
        with self.probe({"Alice": "ok", "Bob": "cooldown", "Carol": "locked", "Dave": "invalid"}):
            await self.pool.check_all()

        self.assertEqual([(await self.row(n))["status"] for n in names], ["active", "cooldown", "locked", "invalid"])
        self.assertEqual(set(await self.runtime()), {"Alice"})
        self.assertIsNone((await self.row("Dave"))["next_check_at"])
        self.assertEqual((await self.pool.status())["counts"], {"active": 1, "cooldown": 1, "locked": 1, "invalid": 1})

    async def test_due_cooldown_account_is_restored_and_returns_to_runtime(self):
        await self.pool.add_accounts(record("Alice", 1) + "\n" + record("Bob", 2))
        await self.set_row("Alice", status="cooldown", failures=1, next_check_at=now() - timedelta(minutes=1))
        await self.set_row("Bob", next_check_at=now() + timedelta(hours=3))
        await self.pool.resync()
        self.assertEqual(set(await self.runtime()), {"Bob"})

        with self.probe({"Alice": "ok"}) as probed:
            result = await self.pool.check_due()

        self.assertEqual([c.args[0] for c in probed.call_args_list], ["Alice"])
        self.assertEqual([x["username"] for x in result["active"]], ["Alice"])
        row = await self.row("Alice")
        self.assertEqual((row["status"], row["failures"]), ("active", 0))
        self.assertEqual(set(await self.runtime()), {"Alice", "Bob"})
        self.assertIn("restored", await self.events("Alice"))

    async def test_check_due_skips_invalid_and_not_yet_due(self):
        await self.pool.add_accounts(record("Alice", 1) + "\n" + record("Bob", 2))
        await self.set_row("Alice", status="invalid", next_check_at=now() - timedelta(hours=1))
        await self.set_row("Bob", next_check_at=now() + timedelta(hours=1))
        with self.probe({}) as probed:
            self.assertIsNone(await self.pool.check_due())
        probed.assert_not_called()

    async def test_manual_check_can_restore_invalid_account_but_unknown_keeps_it_invalid(self):
        await self.pool.add_accounts(record("Alice", 1))
        await self.set_row("Alice", status="invalid", next_check_at=None)
        with self.probe({"Alice": "unknown"}):
            result = await self.pool.check_one("alice")
        self.assertEqual(len(result["skipped"]), 1)
        self.assertEqual((await self.row("Alice"))["status"], "invalid")

        with self.probe({"Alice": "ok"}):
            await self.pool.check_one("Alice")
        self.assertEqual((await self.row("Alice"))["status"], "active")
        self.assertEqual(list(await self.runtime()), ["Alice"])

    async def test_each_probe_counts_as_a_request_for_that_account(self):
        await self.pool.add_accounts(record("Alice", 1) + "\n" + record("Bob", 2))
        with self.probe({"Alice": "ok", "Bob": "ok"}):
            await self.pool.check_all()
            await self.pool.check_one("Alice")
        usage = {a["username"]: a["requestsToday"] for a in (await self.pool.status())["accounts"]}
        self.assertEqual(usage, {"Alice": 2, "Bob": 1})

    async def test_concurrent_check_is_rejected(self):
        await self.pool.add_accounts(record("Alice", 1))
        self.pool.checking = True
        with self.assertRaises(xpool.PoolError) as raised:
            await self.pool.check_all()
        self.assertEqual(raised.exception.code, "busy")

    async def assert_old_probe_does_not_change_current_account(self, verdict, *, remove=False):
        await self.pool.add_accounts(record("Alice", 1))
        entered = asyncio.Event()
        release = asyncio.Event()

        async def delayed_probe(username, cookie_value):
            self.assertEqual(xpool.cookie_dict(cookie_value)["auth_token"], auth(1))
            entered.set()
            await release.wait()
            return verdict, None if verdict == "ok" else "old fixture result"

        with patch.object(self.pool, "_probe", side_effect=delayed_probe):
            checking = asyncio.create_task(self.pool.check_all())
            try:
                await asyncio.wait_for(entered.wait(), timeout=5)
                if remove:
                    await self.pool.remove_account("Alice")
                else:
                    await self.pool.add_accounts(record("Alice", 2))
                    # 新 Cookie 的失败次数，不能被旧 Cookie 的检测结果清零或累加
                    await self.set_row("Alice", status="cooldown", failures=1)
                before = await self.row("Alice")
                release.set()
                result = await asyncio.wait_for(checking, timeout=5)
            finally:
                release.set()
                if not checking.done():
                    checking.cancel()
                    await asyncio.gather(checking, return_exceptions=True)

        self.assertEqual([x["username"] for x in result["skipped"]], ["Alice"])
        self.assertFalse(self.pool.checking)
        # 旧 Cookie 确实发过一次请求，用量照记；状态相关的字段不能变
        state = lambda r: r and {k: v for k, v in dict(r).items() if k != "last_used_at"}
        self.assertEqual(state(await self.row("Alice")), state(before))
        self.assertNotIn("old fixture result", json.dumps([dict(r) for r in await self.pool.db.fetch("select detail from x_account_events")]))

    async def test_old_results_do_not_apply_to_updated_account(self):
        for verdict in ("ok", "cooldown", "locked", "invalid"):
            with self.subTest(verdict=verdict):
                await self.asyncSetUp()
                await self.assert_old_probe_does_not_change_current_account(verdict)

    async def test_old_results_do_not_apply_to_removed_account(self):
        for verdict in ("ok", "cooldown", "locked", "invalid"):
            with self.subTest(verdict=verdict):
                await self.asyncSetUp()
                await self.assert_old_probe_does_not_change_current_account(verdict, remove=True)


class RequestTests(PoolTestCase):
    async def mark_runtime_inactive(self, username, error):
        account = await self.pool.api.pool.get(username)
        account.active = False
        account.error_msg = error
        await self.pool.api.pool.save(account)

    async def test_accounts_failing_during_requests_are_classified(self):
        names = ("Alice", "Bob", "Carol")
        await self.pool.add_accounts("\n".join(record(n, i) for i, n in enumerate(names, 1)))
        await self.mark_runtime_inactive("Alice", "(32) Could not authenticate you")
        await self.mark_runtime_inactive("Bob", "(326) Authorization: Denied by access control")
        await self.mark_runtime_inactive("Carol", None)

        await self.pool.resync()

        self.assertEqual([(await self.row(n))["status"] for n in names], ["invalid", "locked", "cooldown"])
        self.assertEqual(await self.runtime(), {})
        self.assertEqual(await self.events("Bob"), ["added", "locked"])

    async def test_usage_is_counted_per_account_from_runtime_stats(self):
        await self.pool.add_accounts(record("Alice", 1) + "\n" + record("Bob", 2))

        async def fake_request():
            account = await self.pool.api.pool.get("Bob")
            account.stats = {"SearchTimeline": 3}
            await self.pool.api.pool.save(account)
            return "fixture"

        self.assertEqual(await self.pool._run(fake_request), "fixture")
        usage = {a["username"]: (a["requestsToday"], a["lastUsed"]) for a in (await self.pool.status())["accounts"]}
        self.assertEqual(usage["Bob"][0], 3)
        self.assertIsNotNone(usage["Bob"][1])
        self.assertEqual(usage["Alice"], (0, None))

    async def test_account_at_daily_cap_leaves_runtime_until_quota_is_exhausted(self):
        await self.pool.add_accounts(record("Alice", 1) + "\n" + record("Bob", 2))
        with patch.object(xpool, "X_DAILY_REQ_PER_ACCOUNT", 5):
            await self.pool._add_usage({(await self.row("Alice"))["id"]: 5})
            await self.pool.resync()
            self.assertEqual(set(await self.runtime()), {"Bob"})

            await self.pool._add_usage({(await self.row("Bob"))["id"]: 5})
            with self.assertRaises(xpool.PoolError) as raised:
                await self.pool._run(lambda: asyncio.sleep(0))
            self.assertEqual(raised.exception.code, "quota")
            self.assertEqual(await self.runtime(), {})

    async def test_no_active_accounts(self):
        await self.pool.add_accounts(record("Alice", 1))
        await self.set_row("Alice", status="cooldown")
        with self.assertRaises(xpool.PoolError) as raised:
            await self.pool._run(lambda: asyncio.sleep(0))
        self.assertEqual(raised.exception.code, "no_accounts")

    async def test_runtime_prefers_least_recently_used_account(self):
        await self.pool.add_accounts(record("Alice", 1) + "\n" + record("Bob", 2))
        account = await self.pool.api.pool.get("Alice")
        account.last_used = now()
        await self.pool.api.pool.save(account)

        picked = await self.pool.api.pool.get_for_queue("SearchTimeline")
        self.assertEqual(picked.username, "Bob")

    async def test_collect_closes_generator_when_limit_is_reached(self):
        closed = asyncio.Event()

        async def endless():
            try:
                while True:
                    yield 1
            finally:
                closed.set()

        self.assertEqual(await self.pool._collect(endless(), 3), [1, 1, 1])
        self.assertTrue(closed.is_set())

    async def test_status_masks_tokens(self):
        await self.pool.add_accounts(record("Alice", 1))
        status = await self.pool.status()
        self.assertEqual(status["accounts"][0]["token"], auth(1)[:6] + "…")
        self.assertNotIn(auth(1), json.dumps(status, ensure_ascii=False))
        self.assertNotIn(csrf(1), json.dumps(status, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
