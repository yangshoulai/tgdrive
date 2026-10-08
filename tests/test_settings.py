"""对外地址设置：管理员配置对外访问地址。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.settings import normalize_origin
from tests.test_public_links import Client


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, public_base_url="http://default.test:8001")
        self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.app.accounts.create_user("alice", "alice password")
        self.client = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def test_setup_requires_long_passphrase(self):
        import tempfile as _tempfile
        with _tempfile.TemporaryDirectory() as temp:
            app = create_app(Path(temp) / "data", secure_cookies=False)
            with self.assertRaisesRegex(ValueError, "12"):
                app.accounts.setup("short pass", "admin", "admin password")
            self.assertFalse(app.accounts.status()["initialized"])
            app.metadata.close()

    def test_normalize_origin(self):
        self.assertEqual(normalize_origin(" HTTPS://Drive.Example.com:443/ ", "x"), "https://drive.example.com")
        self.assertEqual(normalize_origin("http://127.0.0.1:8001", "x"), "http://127.0.0.1:8001")
        self.assertIsNone(normalize_origin("", "x"))
        for bad in ("drive.example.com", "ftp://a.com", "https://a.com/drive", "https://a.com?x=1", "https://u:p@a.com"):
            with self.assertRaises(ValueError):
                normalize_origin(bad, "x")

    def test_admin_updates_addresses_and_everyone_sees_them(self):
        async def run():
            admin = await self.client.login("admin", "admin", "admin password")
            _, _, data = await self.client.request("GET", "/api/admin/v1/settings", headers=admin)
            self.assertEqual(json.loads(data)["public_base_url"]["effective"], "http://default.test:8001")

            body = json.dumps({"public_base_url": "https://drive.example.com/", "s3_endpoint": "https://s3.example.com"}).encode()
            status, _, data = await self.client.request("POST", "/api/admin/v1/settings", body, admin)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(data)["s3_endpoint"]["value"], "https://s3.example.com")

            _, _, data = await self.client.request("GET", "/api/public/v1/config")
            self.assertEqual(json.loads(data), {"public_base_url": "https://drive.example.com", "s3_endpoint": "https://s3.example.com"})
            user = await self.client.login("user", "alice", "alice password")
            _, _, data = await self.client.request("GET", "/api/user/v1/me", headers=user)
            self.assertEqual(json.loads(data)["s3_endpoint"], "https://s3.example.com")

            # 清空后回到启动参数默认值。
            await self.client.request("POST", "/api/admin/v1/settings", json.dumps({"public_base_url": ""}).encode(), admin)
            _, _, data = await self.client.request("GET", "/api/public/v1/config")
            self.assertEqual(json.loads(data)["public_base_url"], "http://default.test:8001")
        asyncio.run(run())

    def test_validation_and_permissions(self):
        async def run():
            admin = await self.client.login("admin", "admin", "admin password")
            same = json.dumps({"public_base_url": "https://a.example.com", "s3_endpoint": "https://a.example.com:9000"}).encode()
            status, _, data = await self.client.request("POST", "/api/admin/v1/settings", same, admin)
            self.assertEqual(status, 400)
            self.assertIn("不同的域名", json.loads(data)["error"]["message"])
            status, _, _ = await self.client.request("POST", "/api/admin/v1/settings", json.dumps({"other": "x"}).encode(), admin)
            self.assertEqual(status, 400)
            no_csrf = {"cookie": admin["cookie"]}
            status, _, _ = await self.client.request("POST", "/api/admin/v1/settings", b'{"s3_endpoint":"https://s3.x.com"}', no_csrf)
            self.assertEqual(status, 403)
            user = await self.client.login("user", "alice", "alice password")
            status, _, _ = await self.client.request("GET", "/api/admin/v1/settings", headers={"cookie": user["cookie"]})
            self.assertEqual(status, 403)  # 已登录的普通用户：权限不足，而不是会话失效
        asyncio.run(run())

    def test_s3_endpoint_drives_host_routing(self):
        async def run():
            admin = await self.client.login("admin", "admin", "admin password")
            await self.client.request("POST", "/api/admin/v1/settings", json.dumps({"s3_endpoint": "https://s3.example.com"}).encode(), admin)
            # 配置的 S3 主机名收到的非 /api 请求交给 S3 网关（未签名 → S3 错误 XML）。
            status, headers, body = await self.client.request("GET", "/bucket/key", headers={"host": "s3.example.com"})
            self.assertIn(b"<Error>", body)
            # 其他主机名不再走 S3。
            status, _, body = await self.client.request("GET", "/bucket/key", headers={"host": "drive.example.com"})
            self.assertNotIn(b"<Error>", body)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
