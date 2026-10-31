"""文本编辑保存：网页上传带 If-Match 时只覆盖打开的那个版本，文件已在别处改动则 409，不写入。"""

import json
import tempfile
import unittest
from urllib.parse import quote

from tgdrive.app import create_app
from tgdrive.errors import VersionConflict
from tgdrive.objects import Scope
from tests.test_public_links import Client


class TextEditSaveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(self.temp.name, secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.alice.bucket_id)
        self.objects = self.app.objects

    async def asyncTearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    async def read(self, key):
        info, chunks = await self.objects.get_object(self.scope, key)
        return b"".join([chunk async for chunk in chunks])

    async def test_matching_version_overwrites_and_keeps_share(self):
        first = await self.objects.put_object(self.scope, "notes.md", b"# v1", 4, "text/markdown")
        shared = self.objects.set_public(self.scope, "notes.md", True)
        saved = await self.objects.put_object(self.scope, "notes.md", b"# v2", 4, "text/markdown", if_match=first.etag)
        self.assertNotEqual(saved.etag, first.etag)
        self.assertEqual(await self.read("notes.md"), b"# v2")
        self.assertEqual(self.objects.head_object(self.scope, "notes.md").public_token, shared.public_token, "覆盖保存保留公开链接")

    async def test_stale_or_missing_version_is_rejected_without_writing(self):
        first = await self.objects.put_object(self.scope, "app.log", b"line 1\n", 7, "text/plain")
        await self.objects.put_object(self.scope, "app.log", b"line 1\nline 2\n", 14, "text/plain")
        with self.assertRaises(VersionConflict):
            await self.objects.put_object(self.scope, "app.log", b"edited\n", 7, "text/plain", if_match=first.etag)
        self.assertEqual(await self.read("app.log"), b"line 1\nline 2\n", "版本不符时不覆盖")
        with self.assertRaises(VersionConflict):
            await self.objects.put_object(self.scope, "gone.txt", b"x", 1, "text/plain", if_match=first.etag)
        with self.assertRaises(Exception):
            self.objects.head_object(self.scope, "gone.txt")

    async def test_commit_rechecks_version_inside_transaction(self):
        first = await self.objects.put_object(self.scope, "race.txt", b"a", 1, "text/plain")
        commit = self.objects._commit_blob

        def overwrite_first(*args, **kwargs):
            # 预检通过后、提交前另一个写入抢先覆盖：提交事务内的复核必须拒绝。
            self.objects._commit_blob = commit
            commit(self.alice.bucket_id, "race.txt", first.blob_uuid, first.size, "other-etag", "text/plain", None)
            return commit(*args, **kwargs)

        self.objects._commit_blob = overwrite_first
        with self.assertRaises(VersionConflict):
            await self.objects.put_object(self.scope, "race.txt", b"b", 1, "text/plain", if_match=first.etag)

    async def test_web_route_returns_conflict(self):
        client = Client(self.app)
        headers = await client.login("user", "alice@example.com", "alice password")
        first = await self.objects.put_object(self.scope, "code.py", b"print(1)\n", 9, "text/x-python")
        url = "/api/user/v1/files?path=" + quote("code.py")
        status, _, body = await client.request("PUT", url, b"print(2)\n", {**headers, "if-match": f'"{first.etag}"'})
        self.assertEqual(status, 200, body)
        status, _, body = await client.request("PUT", url, b"print(3)\n", {**headers, "if-match": f'"{first.etag}"'})
        self.assertEqual((status, json.loads(body)["error"]["code"]), (409, "version_conflict"))
        self.assertEqual(await self.read("code.py"), b"print(2)\n")
        status, _, body = await client.request("GET", "/api/user/v1/files/info?path=" + quote("code.py"), headers=headers)
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["etag"], self.objects.head_object(self.scope, "code.py").etag, "冲突后可取得最新版本")


if __name__ == "__main__":
    unittest.main()
