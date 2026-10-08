"""M20：管理员文档 bundle 只能由管理员会话读取。"""
import asyncio
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app


class AdminDocsAccessTests(unittest.TestCase):
    def test_admin_docs_bundle_requires_admin_session(self):
        async def run():
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                static = root / "static"
                static.mkdir(parents=True)
                (static / "index.html").write_text("app", encoding="utf-8")
                (static / "admin-docs.js").write_text("admin docs", encoding="utf-8")
                app = create_app(root / "data", secure_cookies=False, static_dir=static)
                app.accounts.setup("encryption passphrase", "admin", "admin password")
                app.accounts.create_user("alice", "alice password")
                client = Client(app)

                status, _, _ = await client.request("GET", "/api/admin/v1/docs-bundle.js")
                self.assertEqual(status, 401)
                status, _, _ = await client.request("GET", "/admin-docs.js")
                self.assertEqual(status, 404)
                # 单页应用：所有路径（含 /admin 开头的）都由同一个 index.html 承载，权限由接口按角色校验。
                for path in ("/", "/docs", "/s/token", "/admin", "/admin/", "/admin/docs/deploy", "/admin/users"):
                    status, _, body = await client.request("GET", path)
                    self.assertEqual((path, status, body), (path, 200, b"app"))

                user = await client.login("user", "alice", "alice password")
                status, _, _ = await client.request("GET", "/api/admin/v1/docs-bundle.js", headers=user)
                self.assertEqual(status, 403)

                admin = await client.login("admin", "admin", "admin password")
                status, headers, body = await client.request("GET", "/api/admin/v1/docs-bundle.js", headers=admin)
                self.assertEqual(status, 200)
                self.assertEqual(headers["content-type"], "text/javascript; charset=utf-8")
                self.assertEqual(body, b"admin docs")
                app.metadata.close()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
