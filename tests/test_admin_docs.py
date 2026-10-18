"""公开文档与静态资源无需登录，所有账号使用同一入口。"""
import asyncio
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app


class DocsAccessTests(unittest.TestCase):
    def test_social_metadata_uses_public_origin_and_head_matches_get(self):
        async def run():
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                static = root / "static"
                static.mkdir()
                (static / "index.html").write_text('<head><meta property="og:url" content="/">'
                    '<meta property="og:image" content="/social.png"><meta name="twitter:image" content="/social.png"></head>', encoding="utf-8")
                (static / "social.png").write_bytes(b"image")
                app = create_app(root / "data", secure_cookies=False, static_dir=static,
                                 public_base_url="https://drive.example.com")
                client = Client(app)
                try:
                    status, headers, body = await client.request("GET", "/", headers={"host": "internal:8000"})
                    self.assertEqual(status, 200)
                    self.assertIn(b'content="https://drive.example.com/"', body)
                    self.assertEqual(body.count(b'content="https://drive.example.com/social.png"'), 2)
                    self.assertNotIn(b"internal", body)
                    status, head, data = await client.request("HEAD", "/")
                    self.assertEqual((status, data, head["content-length"]), (200, b"", headers["content-length"]))
                    self.assertEqual((await client.request("GET", "/social.png"))[2], b"image")
                    app.settings.defaults.clear()
                    status, _, body = await client.request("GET", "/s/private-token?path=hidden", headers={"host": "drive.local:8100"})
                    self.assertEqual(status, 200)
                    self.assertIn(b'content="http://drive.local:8100/"', body)
                    self.assertNotIn(b"private-token", body)
                finally:
                    app.metadata.close()
        asyncio.run(run())

    def test_docs_and_assets_are_public_for_all_roles(self):
        async def run():
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                static = root / "static"
                static.mkdir(parents=True)
                (static / "index.html").write_text("app", encoding="utf-8")
                (static / "app-docs.js").write_text("all docs", encoding="utf-8")
                app = create_app(root / "data", secure_cookies=False, static_dir=static)
                client = Client(app)
                try:
                    # 尚未初始化、未登录时也能打开完整文档入口。
                    self.assertEqual((await client.request("GET", "/docs/deploy"))[0], 200)
                    app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
                    app.accounts.create_user("alice@example.com", "alice password")
                    user = await client.login("user", "alice@example.com", "alice password")
                    admin = await client.login("admin", "admin@example.com", "admin password")

                    for auth in (None, user, admin):
                        # 页面与主应用代码统一公开，GET 与 HEAD 不依赖会话角色。
                        for path in ("/", "/docs", "/docs/", "/docs/files", "/docs/deploy", "/docs/storage-channels",
                                     "/docs/admin-assistant", "/docs/faq", "/s/token", "/admin", "/admin/",
                                     "/admin/docs/deploy", "/admin/users", "/app-docs.js"):
                            expected = b"all docs" if path.endswith(".js") else b"app"
                            with self.subTest(path=path, authenticated=auth is not None):
                                status, headers, body = await client.request("GET", path, headers=auth)
                                self.assertEqual((status, body), (200, expected))
                                status, head, body = await client.request("HEAD", path, headers=auth)
                                self.assertEqual((status, body, head["content-length"]), (200, b"", headers["content-length"]))

                    # 文档不再通过管理接口单独下发。
                    self.assertEqual((await client.request("GET", "/api/admin/v1/docs-bundle.js", headers=admin))[0], 404)

                    status, _, _ = await client.request("POST", "/api/admin/v1/lock", b"{}", admin)
                    self.assertEqual(status, 204)
                    self.assertEqual((await client.request("GET", "/docs/deploy"))[0], 200)
                finally:
                    app.metadata.close()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
