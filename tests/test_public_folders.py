"""文件夹公开分享：只读浏览、预览与下载，内容实时，密码与有效期和文件一致，不能越出被分享的目录。"""
import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app


class PublicFolderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.app.accounts.create_user("alice", "alice password")
        self.app.accounts.create_user("bob", "bob password")
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

    async def seed(self):
        alice = await self.client.login("user", "alice", "alice password")
        await self.put(alice, "dir/a.txt", b"hello a")
        await self.put(alice, "dir/sub/b.txt", b"bee")
        await self.put(alice, "dir/sub/deep/c.txt", b"sea")
        await self.put(alice, "other/secret.txt", b"private")
        return alice

    async def share(self, alice, path="dir/", **options):
        status, body = await self.api("POST", "/api/user/v1/public", alice, {"paths": [path], "public": True, **options})
        self.assertEqual(status, 200, body)
        return body["objects"][0]

    def test_share_browse_and_download(self):
        async def run():
            alice = await self.seed()
            shared = await self.share(alice)
            token = shared["public_token"]
            self.assertEqual(shared["key"], "dir/")

            status, meta = await self.api("GET", f"/api/public/v1/objects/{token}")
            self.assertEqual((status, meta["kind"], meta["name"], meta["password_required"]), (200, "folder", "dir", False))

            status, page = await self.api("GET", f"/api/public/v1/folders/{token}/list")
            self.assertEqual((status, [item["name"] for item in page["files"]], [item["path"] for item in page["folders"]]),
                             (200, ["a.txt"], ["sub/"]))
            status, page = await self.api("GET", f"/api/public/v1/folders/{token}/list?path=sub/")
            self.assertEqual(([item["path"] for item in page["files"]], [item["path"] for item in page["folders"]]),
                             (["sub/b.txt"], ["sub/deep/"]))
            status, page = await self.api("GET", f"/api/public/v1/folders/{token}/list?path=sub/deep")
            self.assertEqual([item["name"] for item in page["files"]], ["c.txt"])

            status, _, data = await self.client.request("GET", f"/p/{token}/a.txt")
            self.assertEqual((status, data), (200, b"hello a"))
            status, headers, data = await self.client.request("GET", f"/p/{token}/sub/deep/c.txt", headers={"range": "bytes=1-2"})
            self.assertEqual((status, data, headers["content-range"]), (206, b"ea", "bytes 1-2/3"))

            status, listing = await self.api("GET", "/api/user/v1/public", alice)
            self.assertEqual([item["key"] for item in listing], ["dir/"])
            self.assertGreaterEqual(listing[0]["public_downloads"], 1)
        asyncio.run(run())

    def test_cannot_escape_the_shared_folder(self):
        async def run():
            alice = await self.seed()
            token = (await self.share(alice))["public_token"]
            for path in (f"/p/{token}/../other/secret.txt", f"/p/{token}/sub/../../other/secret.txt", f"/p/{token}/", f"/p/{token}",
                         f"/p/{token}/sub/", f"/p/{token}/missing.txt", f"/p/{token}//a.txt"):
                status, _, _ = await self.client.request("GET", path)
                self.assertIn(status, (400, 404), path)
            for path in ("../other/", "sub/../../other/", "/other/", "..", "a.txt/"):
                status, _ = await self.api("GET", f"/api/public/v1/folders/{token}/list?path={path}")
                self.assertIn(status, (400, 404), path)
            # 其他用户的同名文件夹、未公开的文件夹都读不到
            status, _ = await self.api("GET", f"/api/public/v1/folders/{token}/list?path=other/")
            self.assertIn(status, (400, 404))
        asyncio.run(run())

    def test_content_is_live(self):
        async def run():
            alice = await self.seed()
            token = (await self.share(alice))["public_token"]
            await self.put(alice, "dir/new.txt", b"fresh")
            _, page = await self.api("GET", f"/api/public/v1/folders/{token}/list")
            self.assertEqual(sorted(item["name"] for item in page["files"]), ["a.txt", "new.txt"])
            await self.api("POST", "/api/user/v1/delete", alice, {"paths": ["dir/a.txt"]})
            status, _, _ = await self.client.request("GET", f"/p/{token}/a.txt")
            self.assertEqual(status, 404)
        asyncio.run(run())

    def test_password_expiry_and_revoking(self):
        async def run():
            alice = await self.seed()
            token = (await self.share(alice, password="secret1"))["public_token"]
            status, meta = await self.api("GET", f"/api/public/v1/objects/{token}")
            self.assertEqual((status, meta["password_required"]), (200, True))
            status, _ = await self.api("GET", f"/api/public/v1/folders/{token}/list")
            self.assertEqual(status, 403)
            self.assertEqual((await self.client.request("GET", f"/p/{token}/a.txt"))[0], 403)
            status, _ = await self.api("POST", f"/api/public/v1/objects/{token}/unlock", None, {"password": "wrong"})
            self.assertEqual(status, 400)
            status, grant = await self.api("POST", f"/api/public/v1/objects/{token}/unlock", None, {"password": "secret1"})
            self.assertEqual(status, 200)
            access = grant["access"]
            status, page = await self.api("GET", f"/api/public/v1/folders/{token}/list?access={access}")
            self.assertEqual((status, len(page["files"])), (200, 1))
            status, _, data = await self.client.request("GET", f"/p/{token}/a.txt?access={access}")
            self.assertEqual((status, data), (200, b"hello a"))

            await self.share(alice, password=None, expires_at=time.time() + 3600)
            self.assertEqual((await self.api("GET", f"/api/public/v1/folders/{token}/list"))[0], 200)
            self.app.metadata.db.execute("UPDATE objects SET public_expires_at=? WHERE key='dir/'", (time.time() - 1,))
            self.app.metadata.db.commit()
            self.assertEqual((await self.api("GET", f"/api/public/v1/folders/{token}/list"))[0], 410)
            self.assertEqual((await self.client.request("GET", f"/p/{token}/a.txt"))[0], 410)

            status, body = await self.api("POST", "/api/user/v1/public", alice, {"paths": ["dir/"], "public": False})
            self.assertEqual(status, 200)
            self.assertEqual((await self.api("GET", f"/api/public/v1/folders/{token}/list"))[0], 404)
        asyncio.run(run())

    def test_trash_move_and_delete_follow_the_folder(self):
        async def run():
            alice = await self.seed()
            token = (await self.share(alice))["public_token"]
            status, body = await self.api("POST", "/api/user/v1/trash", alice, {"paths": ["dir/"]})
            self.assertEqual(status, 200, body)
            self.assertEqual((await self.api("GET", f"/api/public/v1/folders/{token}/list"))[0], 404)
            self.assertEqual((await self.client.request("GET", f"/p/{token}/a.txt"))[0], 404)
            status, restored = await self.api("POST", "/api/user/v1/trash/restore", alice, {"ids": [body["items"][0]["id"]]})
            self.assertEqual(status, 200, restored)
            # 还原后链接恢复（令牌随目录标记一起保存）
            self.assertEqual((await self.api("GET", f"/api/public/v1/folders/{token}/list"))[0], 200)
            # 移动文件夹：令牌随行保留，路径变了但链接仍然有效
            status, _ = await self.api("POST", "/api/user/v1/move", alice, {"from": "dir/", "to": "moved/dir/"})
            self.assertEqual(status, 200)
            status, page = await self.api("GET", f"/api/public/v1/folders/{token}/list")
            self.assertEqual((status, [item["name"] for item in page["files"]]), (200, ["a.txt"]))
            status, listing = await self.api("GET", "/api/user/v1/public", alice)
            self.assertEqual([item["key"] for item in listing], ["moved/dir/"])
        asyncio.run(run())

    def test_listing_reports_public_folders_and_unknown_folders_are_rejected(self):
        async def run():
            alice = await self.seed()
            token = (await self.share(alice, "dir/sub/"))["public_token"]
            _, page = await self.api("GET", "/api/user/v1/list?prefix=dir/", alice)
            self.assertEqual(page["public_folders"]["dir/sub/"]["public_token"], token)
            _, page = await self.api("GET", "/api/user/v1/list", alice)
            self.assertEqual(page["public_folders"], {})
            status, _ = await self.api("POST", "/api/user/v1/public", alice, {"paths": ["nothing/"], "public": True})
            self.assertEqual(status, 404)
            bob = await self.client.login("user", "bob", "bob password")
            status, _ = await self.api("POST", "/api/user/v1/public", bob, {"paths": ["dir/"], "public": True})
            self.assertEqual(status, 404)
        asyncio.run(run())

    def test_recreating_a_folder_keeps_its_share(self):
        async def run():
            alice = await self.seed()
            token = (await self.share(alice, password="secret1"))["public_token"]
            status, _ = await self.api("POST", "/api/user/v1/folders", alice, {"path": "dir"})
            self.assertIn(status, (200, 201))
            status, meta = await self.api("GET", f"/api/public/v1/objects/{token}")
            self.assertEqual((status, meta["password_required"]), (200, True))
        asyncio.run(run())

    def test_explicit_empty_folder_and_key_api(self):
        async def run():
            alice = await self.client.login("user", "alice", "alice password")
            await self.api("POST", "/api/user/v1/folders", alice, {"path": "empty"})
            token = (await self.share(alice, "empty/"))["public_token"]
            status, page = await self.api("GET", f"/api/public/v1/folders/{token}/list")
            self.assertEqual((status, page["files"], page["folders"]), (200, [], []))
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
