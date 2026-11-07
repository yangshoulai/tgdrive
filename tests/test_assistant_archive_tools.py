"""文件助手的复制、解压与压缩工具（propose_copy／propose_extract／propose_compress）。"""
import io
import unittest
import zipfile

from tests.test_assistant import AssistantCase, call
from tests.test_assistant_actions import ActionHelpers


def make_zip(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return buffer.getvalue()


class ArchiveToolTests(ActionHelpers, AssistantCase):
    async def ready(self):
        await self.setup_assistant()
        user = await self.client.login("user", "alice@example.com", "alice password")
        return user, await self.start_conversation(user)

    def test_copy_files_and_folders_then_undo(self):
        async def run():
            user, conversation = await self.ready()
            await self.put("a/one.txt", b"one")
            await self.put("a/sub/two.txt", b"two")
            await self.put("note.txt", b"note")
            await self.put("dest/note.txt", b"existing")
            action_id, tool = await self.propose(user, conversation, call("propose_copy", sources=["/a/", "/note.txt"], target="/dest/"))
            self.assertIn("复制 2 项", tool["summary"])
            _, done = await self.confirm(user, action_id)
            self.assertEqual(done["result"]["ok"], 2, done)
            keys = self.keys()
            for key in ("a/one.txt", "a/sub/two.txt", "dest/a/one.txt", "dest/a/sub/two.txt", "dest/note.txt", "dest/note (1).txt"):
                self.assertIn(key, keys)
            row = self.app.metadata.db.execute("SELECT blob_uuid FROM objects WHERE bucket_id=? AND key IN (?,?)",
                                               (self.alice.bucket_id, "a/one.txt", "dest/a/one.txt")).fetchall()
            self.assertEqual(len({r["blob_uuid"] for r in row}), 1, "复制引用同一个 Blob，不重新上传")
            _, undone = await self.req("POST", f"/api/user/v1/assistant/actions/{action_id}/undo", {}, user)
            self.assertEqual(undone["status"], "undone", undone)
            keys = self.keys()
            self.assertNotIn("dest/a/one.txt", keys)
            self.assertNotIn("dest/note (1).txt", keys)
            self.assertIn("dest/note.txt", keys, "撤销不删除复制前已有的文件")
            self.assertIn("a/one.txt", keys)
        self.run_async(run())

    def test_copy_rejects_folder_into_itself(self):
        async def run():
            user, conversation = await self.ready()
            await self.put("a/one.txt", b"one")
            self.model.replies = [call("propose_copy", sources=["/a/"], target="/a/inner/")]
            await self.send(user, conversation, "复制")
            tool = (await self.tool_results(user, conversation))[-1]
            self.assertEqual(tool["status"], "error")
            self.assertIn("自己里面", tool["result"]["error"])
        self.run_async(run())

    def test_extract_zip_into_named_folder(self):
        async def run():
            user, conversation = await self.ready()
            await self.put("pack/照片.zip", make_zip({"a.txt": b"aaa", "dir/b.txt": b"bbb"}))
            action_id, tool = await self.propose(user, conversation, call("propose_extract", paths=["/pack/照片.zip"]))
            self.assertIn("/pack/照片/", " ".join(tool["result"]["samples"]))
            _, done = await self.confirm(user, action_id)
            self.assertEqual(done["result"]["ok"], 1, done)
            keys = self.keys()
            self.assertIn("pack/照片/a.txt", keys)
            self.assertIn("pack/照片/dir/b.txt", keys)
            self.assertIn("pack/照片.zip", keys, "默认保留压缩包")
        self.run_async(run())

    def test_extract_rejects_unsupported_formats(self):
        async def run():
            user, conversation = await self.ready()
            await self.put("x.rar", b"Rar!")
            self.model.replies = [call("propose_extract", paths=["/x.rar"])]
            await self.send(user, conversation, "解压")
            tool = (await self.tool_results(user, conversation))[-1]
            self.assertEqual(tool["status"], "error")
            self.assertIn("7z", tool["result"]["error"])
        self.run_async(run())

    def test_compress_creates_zip_and_undo_removes_it(self):
        async def run():
            user, conversation = await self.ready()
            await self.put("docs/a.txt", b"alpha")
            await self.put("docs/sub/b.txt", b"beta")
            await self.put("readme.md", b"# hi")
            action_id, _ = await self.propose(user, conversation, call("propose_compress", sources=["/docs/", "/readme.md"], name="打包", target="/"))
            _, done = await self.confirm(user, action_id)
            self.assertEqual(done["result"]["ok"], 1, done)
            self.assertIn("打包.zip", self.keys())
            from tgdrive.objects import Scope
            info, stream = await self.app.objects.get_object(Scope(self.alice.bucket_id), "打包.zip")
            data = b"".join([chunk async for chunk in stream])
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                self.assertEqual(sorted(archive.namelist()), ["docs/a.txt", "docs/sub/b.txt", "readme.md"])
                self.assertEqual(archive.read("docs/sub/b.txt"), b"beta")
            _, undone = await self.req("POST", f"/api/user/v1/assistant/actions/{action_id}/undo", {}, user)
            self.assertEqual(undone["status"], "undone", undone)
            self.assertNotIn("打包.zip", self.keys())
        self.run_async(run())

    def test_compress_refuses_target_inside_source(self):
        async def run():
            user, conversation = await self.ready()
            await self.put("docs/a.txt", b"alpha")
            self.model.replies = [call("propose_compress", sources=["/docs/"], name="x", target="/docs/")]
            await self.send(user, conversation, "压缩")
            tool = (await self.tool_results(user, conversation))[-1]
            self.assertEqual(tool["status"], "error")
            self.assertIn("要压缩的文件夹里面", tool["result"]["error"])
        self.run_async(run())


if __name__ == "__main__":
    unittest.main()
