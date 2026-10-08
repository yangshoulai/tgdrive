"""M20：管理员文档 bundle 只能由管理员会话读取。"""
import asyncio
import tempfile
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tests.test_m8 import Client


class AdminDocsAccessTests(unittest.TestCase):
    def test_admin_docs_bundle_requires_admin_session(self):
        async def run():
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                static = root / "static"
                (static / "admin").mkdir(parents=True)
                (static / "index.html").write_text("user app", encoding="utf-8")
                (static / "admin" / "index.html").write_text("admin app", encoding="utf-8")
                (static / "admin" / "admin-docs.js").write_text("admin docs", encoding="utf-8")
                app = create_app(root / "data", secure_cookies=False, static_dir=static)
                app.accounts.setup("encryption passphrase", "admin", "admin password")
                app.accounts.create_user("alice", "alice password")
                client = Client(app)

                status, _, _ = await client.request("GET", "/api/admin/v1/docs-bundle.js")
                self.assertEqual(status, 401)
                status, _, _ = await client.request("GET", "/admin/admin-docs.js")
                self.assertEqual(status, 404)
                status, _, body = await client.request("GET", "/admin")
                self.assertEqual((status, body), (200, b"admin app"))

                user = await client.login("user", "alice", "alice password")
                status, _, _ = await client.request("GET", "/api/admin/v1/docs-bundle.js", headers=user)
                self.assertEqual(status, 401)

                admin = await client.login("admin", "admin", "admin password")
                status, headers, body = await client.request("GET", "/api/admin/v1/docs-bundle.js", headers=admin)
                self.assertEqual(status, 200)
                self.assertEqual(headers["content-type"], "text/javascript; charset=utf-8")
                self.assertEqual(body, b"admin docs")
                app.metadata.close()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
