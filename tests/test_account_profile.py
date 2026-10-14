"""账号资料：邮箱登录名、昵称、头像，以及旧用户名账号改为邮箱。"""
import asyncio
import base64
import json
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


class AccountProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "Admin@Example.com", "admin password", nickname="  站长  ")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.client = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def call(self, method, path, payload=None, headers=None):
        body = json.dumps(payload).encode() if payload is not None else b""
        status, response_headers, data = asyncio.run(self.client.request(method, path, body, headers or {}))
        try:
            return status, json.loads(data) if data else None, response_headers
        except ValueError:
            return status, data, response_headers

    def login(self, username, password):
        return asyncio.run(self.client.login("user", username, password))

    def test_new_accounts_require_unique_lowercase_email(self):
        admin = self.login("admin@example.com", "admin password")
        status, me, _ = self.call("GET", "/api/auth/v1/me", headers=admin)
        self.assertEqual((me["username"], me["nickname"], me["display_name"], me["needs_email"]), ("admin@example.com", "站长", "站长", False))
        for name in ("bob", "bob@", "bob@example", "a b@example.com"):
            self.assertEqual(self.call("POST", "/api/admin/v1/users", {"username": name, "password": "bob password"}, admin)[0], 400, name)
        self.assertEqual(self.call("POST", "/api/admin/v1/users", {"username": "ALICE@example.com", "password": "x password"}, admin)[0], 400)
        status, body, _ = self.call("POST", "/api/admin/v1/users", {"username": " Bob@Example.COM ", "password": "bob password", "nickname": "Bob"}, admin)
        self.assertEqual((status, body["username"], body["nickname"]), (201, "bob@example.com", "Bob"))
        users = {user["username"]: user for user in self.call("GET", "/api/admin/v1/users", headers=admin)[1]}
        # 未设置昵称时显示邮箱 @ 前面的部分。
        self.assertEqual((users["alice@example.com"]["display_name"], users["bob@example.com"]["display_name"]), ("alice", "Bob"))
        self.assertEqual(self.login("BOB@example.com", "bob password")["x-csrf-token"] != "", True)

    def test_legacy_username_logs_in_and_changes_to_email(self):
        with self.app.metadata.transaction() as db:
            db.execute("UPDATE users SET username='admin' WHERE role='admin'")
        admin = self.login("admin", "admin password")
        status, me, _ = self.call("GET", "/api/auth/v1/me", headers=admin)
        self.assertEqual((me["username"], me["needs_email"], me["display_name"]), ("admin", True, "站长"))
        self.assertEqual(self.call("POST", "/api/auth/v1/email", {"email": "owner@example.com", "password": "wrong"}, admin)[0], 400)
        self.assertEqual(self.call("POST", "/api/auth/v1/email", {"email": "alice@example.com", "password": "admin password"}, admin)[0], 400)
        self.assertEqual(self.call("POST", "/api/auth/v1/email", {"email": "not-an-email", "password": "admin password"}, admin)[0], 400)
        status, body, _ = self.call("POST", "/api/auth/v1/email", {"email": "Owner@Example.com", "password": "admin password"}, admin)
        self.assertEqual((status, body["username"], body["needs_email"]), (200, "owner@example.com", False))
        # 当前会话继续有效并使用新登录名；旧用户名不能再登录，新邮箱可以。
        self.assertEqual(self.call("GET", "/api/auth/v1/me", headers=admin)[1]["username"], "owner@example.com")
        self.assertEqual(self.call("POST", "/api/auth/v1/login", {"username": "admin", "password": "admin password"})[0], 401)
        self.login("owner@example.com", "admin password")
        audit = self.app.metadata.db.execute("SELECT actor, target FROM audit_log WHERE action='account.email' AND ok=1").fetchone()
        self.assertEqual(tuple(audit), ("admin", "owner@example.com"))

    def test_nickname_and_avatar(self):
        alice = self.login("alice@example.com", "alice password")
        status, body, _ = self.call("POST", "/api/auth/v1/profile", {"nickname": "  爱丽丝  "}, alice)
        self.assertEqual((status, body["nickname"], body["display_name"]), (200, "爱丽丝", "爱丽丝"))
        self.assertEqual(self.call("POST", "/api/auth/v1/profile", {"nickname": "x" * 33}, alice)[0], 400)
        self.assertEqual(self.call("POST", "/api/auth/v1/profile", {"nickname": ""}, alice)[1]["display_name"], "alice")
        # 头像：只接受 JPEG / PNG / WebP 且不超过 256 KB。
        self.assertEqual(self.call("GET", "/api/auth/v1/avatar", headers=alice)[0], 404)
        self.assertEqual(self.call("POST", "/api/auth/v1/avatar", {"data": base64.b64encode(b"GIF89a....").decode()}, alice)[0], 400)
        self.assertEqual(self.call("POST", "/api/auth/v1/avatar", {"data": base64.b64encode(PNG + b"\0" * 300_000).decode()}, alice)[0], 400)
        status, body, _ = self.call("POST", "/api/auth/v1/avatar", {"data": "data:image/png;base64," + base64.b64encode(PNG).decode()}, alice)
        self.assertEqual(status, 200)
        version = body["avatar_version"]
        self.assertTrue(version)
        status, data, headers = self.call("GET", f"/api/auth/v1/avatar?v={version}", headers=alice)
        self.assertEqual((status, data, headers["content-type"]), (200, PNG, "image/png"))
        self.assertIn("immutable", headers["cache-control"])
        # 管理员可以读取用户头像；普通用户不能读取管理员接口。
        admin = self.login("admin@example.com", "admin password")
        self.assertEqual(self.call("GET", f"/api/admin/v1/users/{self.alice.id}/avatar", headers=admin)[0], 200)
        self.assertEqual(self.call("GET", f"/api/admin/v1/users/{self.alice.id}/avatar", headers=alice)[0], 403)
        users = {user["username"]: user for user in self.call("GET", "/api/admin/v1/users", headers=admin)[1]}
        self.assertEqual(users["alice@example.com"]["avatar_version"], version)
        status, body, _ = self.call("POST", "/api/auth/v1/avatar/delete", {}, alice)
        self.assertEqual((status, body["avatar_version"]), (200, None))
        self.assertEqual(self.call("GET", "/api/auth/v1/avatar", headers=alice)[0], 404)

    def test_avatar_is_removed_with_the_account(self):
        alice = self.login("alice@example.com", "alice password")
        self.call("POST", "/api/auth/v1/avatar", {"data": base64.b64encode(PNG).decode()}, alice)
        admin = self.login("admin@example.com", "admin password")
        status, _, _ = self.call("POST", f"/api/admin/v1/users/{self.alice.id}/delete", {"confirm": "alice@example.com"}, admin)
        self.assertEqual(status, 200)
        self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM user_avatars").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
