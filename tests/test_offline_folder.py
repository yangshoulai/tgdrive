"""离线任务条目的子目录（folder）：网盘文件夹里的文件按原结构保存在所选位置下；不能越出保存位置或进入系统区。"""

import tempfile
import unittest

from tgdrive.app import create_app
from tests.test_offline_probe import ScriptedHttp


class OfflineFolderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(self.temp.name, secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.offline = self.app.offline
        self.offline.http = ScriptedHttp([0] * 20)

    async def asyncTearDown(self):
        await self.offline.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    async def ticket(self):
        return (await self.offline.parse(self.alice.id, "https://pan.example.com/file?sign=1"))["candidates"][0]["ticket"]

    async def test_folder_is_kept_under_destination(self):
        items = [{"ticket": await self.ticket(), "name": "song.flac", "folder": "专辑/2024/"},
                 {"ticket": await self.ticket(), "name": "song.flac", "folder": "专辑"},
                 {"ticket": await self.ticket(), "name": "song.flac"}]
        tasks = self.offline.create(self.alice.id, items, "下载/")
        self.assertEqual([task["key"] for task in tasks], ["下载/专辑/2024/song.flac", "下载/专辑/song.flac", "下载/song.flac"])
        # 记住的保存位置仍是所选目录，不是子目录。
        self.assertEqual(self.offline.last_destination(self.alice.id)["normal"], "下载/")

    async def test_folder_cannot_escape_or_enter_system_area(self):
        for folder in ("../x/", "/abs/", "a/../b/", ".tgdrive/private/", "a//b/", 3):
            with self.assertRaises((ValueError, PermissionError), msg=folder):
                self.offline.create(self.alice.id, [{"ticket": await self.ticket(), "name": "a.bin", "folder": folder}], "下载/")


if __name__ == "__main__":
    unittest.main()
