"""保存他人的分享：引用同一个加密 Blob、计入保存者配额、不继承公开链接，并沿用分享的密码与范围边界。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app


class SaveShareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.bob = self.app.accounts.create_user("bob@example.com", "bob password")
        self.client = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    async def put(self, auth, path, data=b"x"):
        status, _, body = await self.client.request("PUT", f"/api/user/v1/files?path={path}", data, {**auth, "content-length": str(len(data))})
        self.assertEqual(status, 200, body)

    async def api(self, method, path, auth=None, payload=None):
        status, headers, data = await self.client.request(method, path, json.dumps(payload).encode() if payload is not None else b"", auth or {})
        return status, (json.loads(data) if data and headers.get("content-type", "").startswith("application/json") else data)

    async def share(self, auth, path, **options):
        status, body = await self.api("POST", "/api/user/v1/public", auth, {"paths": [path], "public": True, **options})
        self.assertEqual(status, 200, body)
        return body["objects"][0]["public_token"]

    def keys(self, user):
        return [row[0] for row in self.app.metadata.db.execute(
            "SELECT key FROM objects WHERE bucket_id=? ORDER BY key", (user.bucket_id,))]

    def row(self, user, key):
        return self.app.metadata.db.execute("SELECT * FROM objects WHERE bucket_id=? AND key=?", (user.bucket_id, key)).fetchone()

    def test_save_file_and_folder_reference_same_blob(self):
        async def run():
            alice = await self.client.login("user", "alice@example.com", "alice password")
            bob = await self.client.login("user", "bob@example.com", "bob password")
            await self.put(alice, "photos/a.jpg", b"aaaa")
            await self.put(alice, "photos/trip/b.jpg", b"bb")
            await self.put(alice, "report.pdf", b"pdf!")
            file_token, folder_token = await self.share(alice, "report.pdf"), await self.share(alice, "photos/")

            # 自己的分享：status 返回 own，保存被拒绝；他人的分享 own 为 false。
            self.assertEqual(await self.api("GET", f"/api/user/v1/shares/{file_token}/status", alice), (200, {"own": True}))
            self.assertEqual(await self.api("GET", f"/api/user/v1/shares/{file_token}/status", bob), (200, {"own": False}))
            self.assertEqual((await self.api("POST", f"/api/user/v1/shares/{file_token}/save", alice, {"destination": ""}))[0], 400)

            status, body = await self.api("POST", f"/api/user/v1/shares/{file_token}/save", bob, {"destination": "inbox"})
            self.assertEqual((status, body), (200, {"saved": 1, "bytes": 4, "items": ["inbox/report.pdf"]}))
            status, body = await self.api("POST", f"/api/user/v1/shares/{folder_token}/save", bob, {"destination": "inbox"})
            self.assertEqual((status, body["saved"], body["items"]), (200, 2, ["inbox/photos/"]))
            # 再次保存同名内容自动改名，不覆盖。
            status, body = await self.api("POST", f"/api/user/v1/shares/{folder_token}/save", bob, {"destination": "inbox"})
            self.assertEqual(body["items"], ["inbox/photos (1)/"])
            status, body = await self.api("POST", f"/api/user/v1/shares/{file_token}/save", bob, {"destination": "inbox"})
            self.assertEqual(body["items"], ["inbox/report (1).pdf"])
            self.assertEqual(self.keys(self.bob), ["inbox/photos (1)/", "inbox/photos (1)/a.jpg", "inbox/photos (1)/trip/b.jpg",
                                                   "inbox/photos/", "inbox/photos/a.jpg", "inbox/photos/trip/b.jpg",
                                                   "inbox/report (1).pdf", "inbox/report.pdf"])

            # 引用同一个 Blob，引用计数增加；配额计在保存者名下；不继承公开链接。
            source, copy = self.row(self.alice, "photos/a.jpg"), self.row(self.bob, "inbox/photos/a.jpg")
            self.assertEqual(copy["blob_uuid"], source["blob_uuid"])
            self.assertIsNone(copy["public_token"])
            self.assertIsNone(self.row(self.bob, "inbox/photos/")["public_token"])
            refcount = self.app.metadata.db.execute("SELECT refcount FROM blobs WHERE uuid=?", (source["blob_uuid"],)).fetchone()[0]
            self.assertEqual(refcount, 3)
            used = self.app.metadata.db.execute("SELECT used_bytes FROM buckets WHERE id=?", (self.bob.bucket_id,)).fetchone()[0]
            self.assertEqual(used, (4 + 6) * 2)
            # 每次保存计一次下载。
            self.assertEqual(self.row(self.alice, "photos/")["public_downloads"], 2)

            # 分享者删除原文件后，保存的副本仍可读取。
            self.assertEqual((await self.api("POST", "/api/user/v1/delete", alice, {"paths": ["report.pdf"]}))[0], 200)
            status, _, data = await self.client.request("GET", "/api/user/v1/content?path=inbox/report.pdf", b"", bob)
            self.assertEqual((status, data), (200, b"pdf!"))

            audit = self.app.metadata.db.execute("SELECT actor, target, detail FROM audit_log WHERE action='share.save' AND ok=1 ORDER BY id").fetchall()
            self.assertEqual(len(audit), 4)
            self.assertEqual((audit[0]["actor"], audit[0]["target"]), ("bob@example.com", "inbox"))
            self.assertNotIn(file_token, json.dumps([dict(item) for item in audit], ensure_ascii=False))
        asyncio.run(run())

    def test_selected_paths_stay_inside_share(self):
        async def run():
            alice = await self.client.login("user", "alice@example.com", "alice password")
            bob = await self.client.login("user", "bob@example.com", "bob password")
            await self.put(alice, "dir/a/x.txt", b"1")
            await self.put(alice, "dir/b/x.txt", b"22")
            await self.put(alice, "dir/sub/deep/c.txt", b"333")
            await self.put(alice, "other/secret.txt", b"private")
            token = await self.share(alice, "dir/")
            status, body = await self.api("POST", f"/api/user/v1/shares/{token}/save", bob,
                                          {"destination": "", "paths": ["a/x.txt", "b/x.txt", "sub/"]})
            # 选中的文件平铺到目标目录，同名的第二个自动改名；子文件夹保留结构。
            self.assertEqual((status, body["items"], body["saved"]), (200, ["x.txt", "x (1).txt", "sub/"], 3))
            self.assertEqual(self.keys(self.bob), ["sub/", "sub/deep/c.txt", "x (1).txt", "x.txt"])
            for paths in (["../other/secret.txt"], ["/etc"], ["a/../../other/secret.txt"]):
                self.assertEqual((await self.api("POST", f"/api/user/v1/shares/{token}/save", bob, {"paths": paths}))[0], 400, paths)
            self.assertEqual((await self.api("POST", f"/api/user/v1/shares/{token}/save", bob, {"paths": ["missing.txt"]}))[0], 404)
            # 不能保存到私密空间，也不能缺少 CSRF。
            self.assertEqual((await self.api("POST", f"/api/user/v1/shares/{token}/save", bob, {"destination": ".tgdrive/private/"}))[0], 403)
            no_csrf = {"cookie": bob["cookie"]}
            self.assertEqual((await self.api("POST", f"/api/user/v1/shares/{token}/save", no_csrf, {"destination": ""}))[0], 403)
            self.assertEqual((await self.api("POST", f"/api/user/v1/shares/{token}/save", None, {"destination": ""}))[0], 401)
        asyncio.run(run())

    def test_password_quota_and_revoked_shares(self):
        async def run():
            alice = await self.client.login("user", "alice@example.com", "alice password")
            bob = await self.client.login("user", "bob@example.com", "bob password")
            await self.put(alice, "big.bin", b"x" * 100)
            token = await self.share(alice, "big.bin", password="letmein")
            status, body = await self.api("POST", f"/api/user/v1/shares/{token}/save", bob, {"destination": ""})
            self.assertEqual((status, body["error"]["code"]), (403, "password_required"))
            status, body = await self.api("POST", f"/api/public/v1/objects/{token}/unlock", None, {"password": "letmein"})
            access = body["access"]
            # 配额不足时一个文件都不保存。
            self.app.accounts.set_quota(self.bob.id, 50)
            self.assertEqual((await self.api("POST", f"/api/user/v1/shares/{token}/save", bob, {"access": access}))[0], 413)
            self.assertEqual(self.keys(self.bob), [])
            self.app.accounts.set_quota(self.bob.id, None)
            self.assertEqual((await self.api("POST", f"/api/user/v1/shares/{token}/save", bob, {"access": access}))[0], 200)
            # 关闭分享或分享者被禁用后不能再保存。
            self.app.accounts.set_account_status(self.alice.id, "disabled")
            self.assertEqual((await self.api("POST", f"/api/user/v1/shares/{token}/save", bob, {"access": access}))[0], 404)
            self.assertEqual((await self.api("GET", f"/api/user/v1/shares/{token}/status", bob))[0], 404)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
