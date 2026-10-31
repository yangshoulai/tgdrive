"""侧栏收藏：保存与排序、文件夹移动或改名后跟随、移入回收站后移除、私密收藏只在解锁时可见且锁定时保存不会丢失。"""

import json
import tempfile
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.objects import PRIVATE_PREFIX, Scope
from tests.test_public_links import Client


class FavoriteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.alice.bucket_id)
        self.client = Client(self.app)
        self.auth = await self.client.login("user", "alice@example.com", "alice password")
        for key in ("照片/2024/a.txt", "工作/报告/b.txt", "音乐/c.txt"):
            await self.app.objects.put_object(self.scope, key, key.encode(), len(key.encode()), "text/plain")

    async def asyncTearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    async def call(self, method, body=None, headers=None):
        status, _, data = await self.client.request(method, "/api/user/v1/favorites",
                                                    json.dumps(body).encode() if body is not None else b"", headers or self.auth)
        return status, json.loads(data)

    async def paths(self, headers=None):
        status, body = await self.call("GET", headers=headers)
        self.assertEqual(status, 200, body)
        return [item["path"] for item in body["items"]]

    async def test_save_order_move_and_trash(self):
        status, body = await self.call("PUT", {"paths": ["音乐/", "照片/2024", "工作/报告/"]})
        self.assertEqual(status, 200, body)
        self.assertEqual([item["path"] for item in body["items"]], ["音乐/", "照片/2024/", "工作/报告/"], "文件夹路径补全结尾的 /")
        self.assertFalse(any(item["missing"] for item in body["items"]))
        # 拖动排序就是按新顺序整体保存。
        await self.call("PUT", {"paths": ["工作/报告/", "音乐/", "照片/2024/"]})
        self.assertEqual(await self.paths(), ["工作/报告/", "音乐/", "照片/2024/"])
        # 改名上级文件夹：收藏跟着走。
        self.app.objects.move(self.scope, "照片/", "相册/")
        self.assertEqual(await self.paths(), ["工作/报告/", "音乐/", "相册/2024/"])
        # 移入回收站：从收藏中移除。
        status, _, data = await self.client.request("POST", "/api/user/v1/trash", json.dumps({"paths": ["音乐/"]}).encode(), self.auth)
        self.assertEqual(status, 200, data)
        self.assertEqual(await self.paths(), ["工作/报告/", "相册/2024/"])
        # 文件夹被删空后显示为不存在。
        self.app.objects.move(self.scope, "工作/报告/b.txt", "b.txt")
        status, body = await self.call("GET")
        self.assertEqual([item["missing"] for item in body["items"]], [True, False])

    async def test_rejects_system_paths_and_too_many(self):
        for paths in (["../x/"], [".tgdrive/trash/x/"], [PRIVATE_PREFIX], "照片/", [f"f{n}/" for n in range(51)]):
            status, body = await self.call("PUT", {"paths": paths})
            self.assertIn(status, (400, 403), body)
            self.assertEqual(await self.paths(), [])

    async def test_private_favorites_hidden_while_locked_and_kept(self):
        private = PRIVATE_PREFIX + "账本/"
        # 未解锁不能新增私密收藏。
        status, _ = await self.call("PUT", {"paths": [private]})
        self.assertEqual(status, 423)
        status, _, data = await self.client.request("POST", "/api/user/v1/private/unlock", json.dumps({"password": "alice password"}).encode(), self.auth)
        self.assertEqual(status, 200, data)
        access = json.loads(data)["access"]
        await self.call("PUT", {"paths": ["音乐/", private, "照片/2024/"]})
        status, body = await self.call("GET")
        self.assertEqual([(item["path"], item["private"]) for item in body["items"]], [("音乐/", False), (private, True), ("照片/2024/", False)])
        status, _, data = await self.client.request("POST", "/api/user/v1/private/lock", b"{}", {**self.auth, "x-private-access": access})
        self.assertEqual(status, 204, data)
        # 锁定后看不到私密收藏；此时调整普通收藏的顺序，私密收藏按原位置保留。
        self.assertEqual(await self.paths(), ["音乐/", "照片/2024/"])
        await self.call("PUT", {"paths": ["照片/2024/", "音乐/"]})
        status, _, data = await self.client.request("POST", "/api/user/v1/private/unlock", json.dumps({"password": "alice password"}).encode(), self.auth)
        self.assertEqual(await self.paths(), ["照片/2024/", private, "音乐/"])


if __name__ == "__main__":
    unittest.main()
