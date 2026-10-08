"""统一登录：全站一个会话 Cookie，菜单与权限由账号角色决定。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app


class UnifiedAuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.app.accounts.create_user("alice", "alice password")
        self.client = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    async def login(self, username, password):
        status, headers, data = await self.client.request(
            "POST", "/api/auth/v1/login", json.dumps({"username": username, "password": password}).encode())
        return status, headers, json.loads(data) if data else None

    @staticmethod
    def auth(headers, body):
        return {"cookie": headers["set-cookie"].split(";", 1)[0], "x-csrf-token": body["csrf_token"]}

    def test_one_cookie_serves_files_and_admin_for_admin_only(self):
        async def run():
            status, headers, body = await self.login("admin", "admin password")
            self.assertEqual((status, body["role"]), (200, "admin"))
            cookie = headers["set-cookie"]
            self.assertTrue(cookie.startswith("tg_session="))
            self.assertIn("Path=/api", cookie)
            self.assertIn("HttpOnly", cookie)
            admin = self.auth(headers, body)

            # 管理员：自己的文件空间 + 管理接口，同一个会话
            status, _, _ = await self.client.request("PUT", "/api/user/v1/files?path=mine.txt", b"hello",
                                                     {**admin, "content-length": "5"})
            self.assertEqual(status, 200)
            status, _, data = await self.client.request("GET", "/api/user/v1/list", b"", admin)
            self.assertEqual([item["key"] for item in json.loads(data)["objects"]], ["mine.txt"])
            status, _, data = await self.client.request("GET", "/api/admin/v1/users", b"", admin)
            self.assertEqual(status, 200)
            self.assertEqual(sorted(user["username"] for user in json.loads(data)), ["admin", "alice"])
            status, _, data = await self.client.request("GET", "/api/auth/v1/me", b"", admin)
            me = json.loads(data)
            self.assertEqual((status, me["role"], me["unlocked"], me["bucket_id"] is not None), (200, "admin", True, True))

            # 普通用户：同样的入口，只能用文件空间，所有管理接口被拒绝
            status, headers, body = await self.login("alice", "alice password")
            self.assertEqual((status, body["role"]), (200, "user"))
            alice = self.auth(headers, body)
            status, _, _ = await self.client.request("PUT", "/api/user/v1/files?path=a.txt", b"x", {**alice, "content-length": "1"})
            self.assertEqual(status, 200)
            for method, path in (("GET", "/api/admin/v1/users"), ("GET", "/api/admin/v1/settings"), ("GET", "/api/admin/v1/audit"),
                                 ("GET", "/api/admin/v1/objects"), ("GET", "/api/admin/v1/docs-bundle.js")):
                status, _, _ = await self.client.request(method, path, b"", alice)
                self.assertEqual(status, 403, path)
            status, _, _ = await self.client.request("POST", "/api/admin/v1/users", b'{"username":"x","password":"password1"}', alice)
            self.assertIn(status, (401, 403))
            # 用户看不到管理员的文件
            status, _, data = await self.client.request("GET", "/api/user/v1/list", b"", alice)
            self.assertEqual([item["key"] for item in json.loads(data)["objects"]], ["a.txt"])
        asyncio.run(run())

    def test_logout_clears_the_single_cookie(self):
        async def run():
            _, headers, body = await self.login("alice", "alice password")
            alice = self.auth(headers, body)
            status, headers, _ = await self.client.request("POST", "/api/auth/v1/logout", b"", alice)
            self.assertEqual(status, 204)
            self.assertIn("tg_session=;", headers["set-cookie"])
            self.assertIn("Max-Age=0", headers["set-cookie"])
            status, _, _ = await self.client.request("GET", "/api/auth/v1/me", b"", alice)
            self.assertEqual(status, 401)
        asyncio.run(run())

    def test_password_change_works_for_both_roles_through_one_endpoint(self):
        async def run():
            for username, old in (("admin", "admin password"), ("alice", "alice password")):
                _, headers, body = await self.login(username, old)
                auth = self.auth(headers, body)
                payload = json.dumps({"old_password": old, "new_password": "brand new pass"}).encode()
                status, _, _ = await self.client.request("POST", "/api/auth/v1/password", payload, auth)
                self.assertEqual((username, status), (username, 204))
                status, _, _ = await self.login(username, "brand new pass")
                self.assertEqual(status, 200)
        asyncio.run(run())

    def test_locked_system_only_lets_admin_in_to_unlock(self):
        async def run():
            _, headers, body = await self.login("admin", "admin password")
            admin = self.auth(headers, body)
            status, _, _ = await self.client.request("POST", "/api/admin/v1/lock", b"{}", admin)
            self.assertEqual(status, 204)

            status, _, body = await self.login("alice", "alice password")
            self.assertEqual(status, 503)
            status, headers, body = await self.login("admin", "admin password")
            self.assertEqual((status, body["role"]), (200, "admin"))
            admin = self.auth(headers, body)
            status, _, data = await self.client.request("GET", "/api/auth/v1/me", b"", admin)
            self.assertEqual((status, json.loads(data)["unlocked"]), (200, False))
            status, _, _ = await self.client.request("GET", "/api/user/v1/list", b"", admin)
            self.assertEqual(status, 503)
            status, _, data = await self.client.request(
                "POST", "/api/admin/v1/unlock", json.dumps({"passphrase": "encryption passphrase"}).encode(), admin)
            self.assertEqual((status, json.loads(data)["unlocked"]), (200, True))
            status, _, _ = await self.client.request("GET", "/api/user/v1/list", b"", admin)
            self.assertEqual(status, 200)
            status, _, _ = await self.login("alice", "alice password")
            self.assertEqual(status, 200)
        asyncio.run(run())

    def test_failed_logins_do_not_reveal_role_or_lock_state(self):
        async def run():
            status, _, _ = await self.login("alice", "wrong password")
            self.assertEqual(status, 401)
            status, _, _ = await self.login("nobody", "whatever password")
            self.assertEqual(status, 401)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
