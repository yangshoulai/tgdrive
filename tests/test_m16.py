"""M16：审计日志、原子创建访问密钥与内存中会话状态的上限。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.authn import SessionManager
from tgdrive.errors import NotReadyError
from tests.test_m8 import Client


class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.alice = self.app.accounts.create_user("alice", "alice password")
        self.client = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def request(self, method, path, payload=None, headers=None):
        status, _, data = asyncio.run(self.client.request(method, path, json.dumps(payload).encode() if payload is not None else b"", headers or {}))
        return status, json.loads(data) if data else None

    def events(self, admin):
        return self.request("GET", "/api/admin/v1/audit", headers=admin)[1]["events"]

    def test_security_events_are_recorded_without_secrets(self):
        self.request("POST", "/api/user/v1/login", {"username": "alice", "password": "WRONG-password"})
        user = asyncio.run(self.client.login("user", "alice", "alice password"))
        admin = asyncio.run(self.client.login("admin", "admin", "admin password"))
        _, created = self.request("POST", "/api/user/v1/clients", {"name": "nas"}, user)
        self.request("POST", "/api/user/v1/password", {"old_password": "alice password", "new_password": "brand new password"}, user)
        self.request("POST", f"/api/admin/v1/users/{self.alice.id}/quota", {"quota_bytes": 1024}, admin)
        self.request("POST", "/api/admin/v1/settings", {"s3_endpoint": "https://s3.example.com"}, admin)
        self.request("POST", "/api/admin/v1/bots", {"name": "main", "token": "123456:" + "x" * 30, "channel_id": "-1001234567"}, admin)
        events = self.events(admin)
        summary = [(event["action"], event["actor"], event["ok"]) for event in reversed(events)]
        self.assertEqual(summary, [
            ("user.login", "alice", False), ("user.login", "alice", True), ("admin.login", "admin", True),
            ("key.create", "alice", True), ("user.password", "alice", True), ("user.quota", "admin", True),
            ("settings.update", "admin", True), ("bot.create", "admin", True),
        ])
        key_event = next(event for event in events if event["action"] == "key.create")
        self.assertEqual(key_event["target"], created["access_key_id"])
        dump = json.dumps(events, ensure_ascii=False)
        for secret in ("WRONG-password", "alice password", "brand new password", "admin password", created["secret"], "x" * 30):
            self.assertNotIn(secret, dump)
        # 失败记录带错误码，并可按动作或失败筛选。
        failed = self.request("GET", "/api/admin/v1/audit?failed=1", headers=admin)[1]["events"]
        self.assertEqual([(event["action"], event["detail"]["error"]) for event in failed], [("user.login", "unauthorized")])
        self.assertEqual({event["action"] for event in self.request("GET", "/api/admin/v1/audit?action=user.", headers=admin)[1]["events"]},
                         {"user.login", "user.password", "user.quota"})
        # 普通用户不能读取审计日志。
        self.assertEqual(self.request("GET", "/api/admin/v1/audit", headers=user)[0], 401)

    def test_lock_and_logout_record_the_actor(self):
        admin = asyncio.run(self.client.login("admin", "admin", "admin password"))
        self.request("POST", "/api/admin/v1/lock", headers=admin)
        admin = asyncio.run(self.client.login("admin", "admin", "admin password"))
        events = self.events(admin)
        lock = next(event for event in events if event["action"] == "system.lock")
        self.assertEqual((lock["actor"], lock["ok"]), ("admin", True))

    def test_audit_pagination(self):
        admin = asyncio.run(self.client.login("admin", "admin", "admin password"))
        for _ in range(7):
            self.request("POST", f"/api/admin/v1/users/{self.alice.id}/status", {"status": "active"}, admin)
        first = self.request("GET", "/api/admin/v1/audit?limit=5", headers=admin)[1]
        second = self.request("GET", f"/api/admin/v1/audit?limit=5&cursor={first['next_cursor']}", headers=admin)[1]
        ids = [event["id"] for event in first["events"] + second["events"]]
        self.assertEqual(ids, sorted(ids, reverse=True))
        self.assertEqual(len(set(ids)), 8)
        self.assertIsNone(second["next_cursor"])

    def test_key_creation_is_atomic(self):
        clients = self.app.s3.auth
        self.app.keystore.lock()
        with self.assertRaises(NotReadyError):
            clients.create_client_with_key("half", owner_user_id=self.alice.id, grants=[(self.alice.bucket_id, "", "rw")])
        self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM clients").fetchone()[0], 0)

    def test_session_state_is_bounded(self):
        manager = SessionManager(ttl=60)
        manager.MAX_TRACKED_FAILURES = 50
        for index in range(500):
            manager.record_failure(f"random-{index}")
        self.assertLessEqual(len(manager._failures), 50)
        manager.record_failure("alice")
        self.assertIn("alice", manager._failures)
        expired = SessionManager(ttl=-1)
        for index in range(20):
            expired.create(index, f"u{index}", "user")
        self.assertLessEqual(len(expired._sessions), 1)


if __name__ == "__main__":
    unittest.main()
