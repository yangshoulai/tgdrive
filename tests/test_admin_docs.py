"""M20：管理员文档 bundle 只能由管理员会话读取。"""
import asyncio
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app


class AdminDocsAccessTests(unittest.TestCase):
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

    def test_admin_docs_bundle_requires_admin_session(self):
        async def run():
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                static = root / "static"
                static.mkdir(parents=True)
                (static / "index.html").write_text("app", encoding="utf-8")
                (static / "admin-docs.js").write_text("admin docs", encoding="utf-8")
                app = create_app(root / "data", secure_cookies=False, static_dir=static)
                app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
                app.accounts.create_user("alice@example.com", "alice password")
                client = Client(app)

                status, _, _ = await client.request("GET", "/api/admin/v1/docs-bundle.js")
                self.assertEqual(status, 401)
                status, _, _ = await client.request("GET", "/admin-docs.js")
                self.assertEqual(status, 404)
                # 单页应用：所有路径（含 /admin 开头的）都由同一个 index.html 承载，权限由接口按角色校验。
                for path in ("/", "/docs", "/s/token", "/admin", "/admin/", "/admin/docs/deploy", "/admin/users"):
                    status, _, body = await client.request("GET", path)
                    self.assertEqual((path, status, body), (path, 200, b"app"))

                user = await client.login("user", "alice@example.com", "alice password")
                status, _, _ = await client.request("GET", "/api/admin/v1/docs-bundle.js", headers=user)
                self.assertEqual(status, 403)

                admin = await client.login("admin", "admin@example.com", "admin password")
                status, headers, body = await client.request("GET", "/api/admin/v1/docs-bundle.js", headers=admin)
                self.assertEqual(status, 200)
                self.assertEqual(headers["content-type"], "text/javascript; charset=utf-8")
                self.assertEqual(body, b"admin docs")
                app.metadata.close()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
