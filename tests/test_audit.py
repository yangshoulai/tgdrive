"""M16：审计日志、原子创建访问密钥与内存中会话状态的上限。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.authn import SessionManager
from tgdrive.errors import NotReadyError


class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
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
        self.request("POST", "/api/user/v1/login", {"username": "alice@example.com", "password": "WRONG-password"})
        user = asyncio.run(self.client.login("user", "alice@example.com", "alice password"))
        admin = asyncio.run(self.client.login("admin", "admin@example.com", "admin password"))
        _, created = self.request("POST", "/api/user/v1/clients", {"name": "nas"}, user)
        self.request("POST", "/api/user/v1/password", {"old_password": "alice password", "new_password": "brand new password"}, user)
        self.request("POST", f"/api/admin/v1/users/{self.alice.id}/quota", {"quota_bytes": 1024}, admin)
        self.request("POST", "/api/admin/v1/settings", {"s3_endpoint": "https://s3.example.com"}, admin)
        self.request("POST", "/api/admin/v1/bots", {"name": "main", "token": "123456:" + "x" * 30, "channel_id": "-1001234567"}, admin)
        status, bots = self.request("GET", "/api/admin/v1/bots", headers=admin)
        self.assertEqual((status, bots[0]["chunk_count"], bots[0]["stored_bytes"]), (200, 0, 0))
        self.assertNotIn("token", bots[0])
        self.assertEqual(self.request("GET", "/api/admin/v1/bots", headers=user)[0], 403)
        events = self.events(admin)
        summary = [(event["action"], event["actor"], event["ok"]) for event in reversed(events)]
        self.assertEqual(summary, [
            ("user.login", "alice@example.com", False), ("user.login", "alice@example.com", True), ("admin.login", "admin@example.com", True),
            ("key.create", "alice@example.com", True), ("user.password", "alice@example.com", True), ("user.quota", "admin@example.com", True),
            ("settings.update", "admin@example.com", True), ("bot.create", "admin@example.com", True),
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
        self.assertEqual(self.request("GET", "/api/admin/v1/audit", headers=user)[0], 403)

    def test_lock_and_logout_record_the_actor(self):
        admin = asyncio.run(self.client.login("admin", "admin@example.com", "admin password"))
        self.request("POST", "/api/admin/v1/lock", headers=admin)
        admin = asyncio.run(self.client.login("admin", "admin@example.com", "admin password"))
        events = self.events(admin)
        lock = next(event for event in events if event["action"] == "system.lock")
        self.assertEqual((lock["actor"], lock["ok"]), ("admin@example.com", True))

    def test_file_privacy_is_enforced_on_write_and_legacy_reads(self):
        admin = asyncio.run(self.client.login("admin", "admin@example.com", "admin password"))
        from tgdrive.audit import AuditLog
        audit = AuditLog(self.app.metadata)
        audit.record("object.public", actor_type="user", actor="alice@example.com", ok=True,
                     target="私人报告.pdf", detail={"public": True, "count": 1, "path": "私人报告.pdf"})
        audit.record("client.grant", actor_type="user", actor="alice@example.com", ok=True,
                     detail={"prefix": "私人目录/", "perms": "ro", "bucket_id": self.alice.bucket_id})
        audit.record("key.create", actor_type="user", actor="alice@example.com", ok=True,
                     detail={"name": "私人目录备份"})
        raw = self.app.metadata.db.execute("SELECT target,detail FROM audit_log WHERE action='object.public'").fetchone()
        self.assertIsNone(raw["target"])
        self.assertNotIn("私人", raw["detail"])
        # 模拟升级前已经写入的记录；读取时脱敏，不修改历史数据库行。
        with self.app.metadata.transaction() as db:
            db.execute("INSERT INTO audit_log(ts,actor_type,actor,action,target,ok,detail) VALUES(1,'user','alice@example.com','share.save',?,1,?)",
                       ("私人旧目录/", json.dumps({"saved": 2, "destination": "私人旧目录/"})))
        events = self.events(admin)
        dump = json.dumps(events, ensure_ascii=False)
        self.assertNotIn("私人", dump)
        legacy = next(event for event in events if event["action"] == "share.save")
        self.assertEqual((legacy["target"], legacy["detail"]), (None, {"saved": 2}))

    def test_audit_pagination(self):
        admin = asyncio.run(self.client.login("admin", "admin@example.com", "admin password"))
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
        manager.record_failure("alice@example.com")
        self.assertIn("alice@example.com", manager._failures)
        expired = SessionManager(ttl=-1)
        for index in range(20):
            expired.create(index, f"u{index}", "user")
        self.assertLessEqual(len(expired._sessions), 1)


if __name__ == "__main__":
    unittest.main()
