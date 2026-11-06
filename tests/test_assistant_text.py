"""文件助手的新建与编辑文本文件（docs/assistant-design.md §42）：只生成待确认操作、整体改写须先完整读取、
局部修改的唯一性、保留 BOM 与 CRLF、隐藏的密钥按顺序还原、执行时的版本复核。"""

import asyncio
import tempfile
import time
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.assistant.actions import Progress
from tgdrive.assistant.guard import HIDDEN
from tgdrive.assistant.text_tools import propose_write_text
from tgdrive.assistant.tools import ToolContext, ToolError, read_text_file
from tgdrive.objects import Scope
from tests.test_assistant import AssistantCase, call
from tests.test_assistant_actions import ActionHelpers


class TextToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.alice.bucket_id)
        self.proposed: list[dict] = []
        self.state: dict = {}

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def wait(self, coroutine):
        return asyncio.run(coroutine)

    def put(self, key, data, content_type="text/markdown"):
        return self.wait(self.app.objects.put_object(self.scope, key, data, len(data), content_type))

    def read(self, key):
        _, stream = self.wait(self.app.objects.get_object(self.scope, key))

        async def collect():
            return b"".join([chunk async for chunk in stream])
        return asyncio.run(collect())

    def context(self):
        async def propose(kind, payload, count):
            self.proposed.append(payload)
            return {"action_id": f"a_{len(self.proposed)}", "expires_at": time.time() + 3600}
        return ToolContext(self.alice.id, self.alice.bucket_id, "", self.app.objects, None, "files", "", {}, self.state,
                           limits={"action_items": 1000}, propose=propose)

    def tool(self, **args):
        return self.wait(propose_write_text(self.context(), args))

    def read_tool(self, path):
        return self.wait(read_text_file(self.context(), {"path": path}))

    def execute(self, payload):
        progress = Progress(total=len(payload["items"]))
        self.wait(self.app.assistant.executor.execute(user_id=self.alice.id, bucket_id=self.alice.bucket_id, payload=payload, progress=progress))
        return progress

    def test_create_only_proposes_until_confirmed(self):
        output = self.tool(path="/笔记/待办.md", content="# 待办\n\n- 买菜\n", summary="新建待办")
        payload = self.proposed[-1]
        self.assertEqual(payload["kind"], "text")
        item = payload["items"][0]
        self.assertEqual((item["path"], item["mode"], item["added"]), ("笔记/待办.md", "create", 3))
        # 新内容只在不公开的 _refs 里，条目与模型结果都不带全文。
        self.assertNotIn("买菜", str(item))
        self.assertNotIn("content", output.result)
        with self.assertRaises(Exception):
            self.app.objects.head_object(self.scope, "笔记/待办.md")
        progress = self.execute(payload)
        self.assertEqual((progress.ok, progress.skipped), (1, 0), progress.reasons)
        self.assertEqual(self.read("笔记/待办.md"), "# 待办\n\n- 买菜\n".encode())
        # 确认前已有同名文件时跳过，不覆盖。
        progress = self.execute(payload)
        self.assertEqual((progress.ok, progress.skipped), (0, 1))
        with self.assertRaises(ToolError):
            self.tool(path="/图片.png", content="x")

    def test_overwrite_requires_full_read_and_keeps_bom_and_crlf(self):
        self.put("说明.md", b"\xef\xbb\xbf#  Title\r\n*  a\r\n*  b\r\n")
        with self.assertRaises(ToolError) as caught:
            self.tool(path="/说明.md", content="# Title\n\n- a\n- b\n")
        self.assertIn("read_text_file", str(caught.exception))
        self.read_tool("/说明.md")
        output = self.tool(path="/说明.md", content="# Title\n\n- a\n- b\n", summary="格式化 Markdown")
        payload = self.proposed[-1]
        self.assertEqual(payload["items"][0]["mode"], "overwrite")
        self.assertIn("+# Title", output.result["diff"])
        progress = self.execute(payload)
        self.assertEqual(progress.ok, 1, progress.reasons)
        self.assertEqual(self.read("说明.md"), b"\xef\xbb\xbf# Title\r\n\r\n- a\r\n- b\r\n")
        info = self.app.objects.head_object(self.scope, "说明.md")
        self.assertTrue(info.content_type.startswith("text/"))

    def test_edits_must_be_unique_and_version_is_checked(self):
        self.put("todo.txt", b"apple\nbanana\napple\n", "text/plain")
        with self.assertRaises(ToolError) as caught:
            self.tool(path="/todo.txt", edits=[{"find": "apple", "replace": "pear"}])
        self.assertIn("2 次", str(caught.exception))
        with self.assertRaises(ToolError):
            self.tool(path="/todo.txt", edits=[{"find": "cherry", "replace": "x"}])
        self.tool(path="/todo.txt", edits=[{"find": "apple", "replace": "pear", "all": True}, {"find": "banana\n", "replace": ""}])
        payload = self.proposed[-1]
        self.assertEqual(payload["items"][0]["mode"], "edit")
        # 确认前文件被别处修改：跳过，不覆盖。
        self.put("todo.txt", b"apple\nbanana\napple\nmore\n", "text/plain")
        progress = self.execute(payload)
        self.assertEqual((progress.ok, progress.skipped), (0, 1))
        self.assertEqual(self.read("todo.txt"), b"apple\nbanana\napple\nmore\n")
        self.tool(path="/todo.txt", edits=[{"find": "more\n", "replace": ""}])
        self.assertEqual(self.execute(self.proposed[-1]).ok, 1)
        self.assertEqual(self.read("todo.txt"), b"apple\nbanana\napple\n")

    def test_hidden_secrets_are_restored_in_order(self):
        secret_a, secret_b = "sk-" + "a" * 30, "sk-" + "b" * 30
        self.put("config.md", f"# 配置\nkey1: {secret_a}\nkey2: {secret_b}\n".encode())
        read = self.read_tool("/config.md")
        self.assertNotIn(secret_a, read.result["content"])
        self.assertEqual(read.result["content"].count(HIDDEN), 2)
        formatted = read.result["content"].replace("# 配置", "# 配置说明")
        output = self.tool(path="/config.md", content=formatted)
        self.assertNotIn(secret_a, output.result["diff"])
        self.assertEqual(self.execute(self.proposed[-1]).ok, 1)
        self.assertEqual(self.read("config.md").decode(), f"# 配置说明\nkey1: {secret_a}\nkey2: {secret_b}\n")
        # 占位被删掉或复制时拒绝，不能把密钥写丢。
        self.read_tool("/config.md")
        with self.assertRaises(ToolError):
            self.tool(path="/config.md", content="# 配置说明\nkey1: removed\n")
        with self.assertRaises(ToolError):
            self.tool(path="/config.md", edits=[{"find": f"key2: {HIDDEN}", "replace": f"key2: {HIDDEN}\nkey3: {HIDDEN}"}])

    def test_rejects_non_text_and_other_encodings(self):
        self.put("photo.jpg", b"\xff\xd8\xff\xe0" + b"\x00" * 32, "image/jpeg")
        with self.assertRaises(ToolError):
            self.tool(path="/photo.jpg", edits=[{"find": "a", "replace": "b"}])
        self.put("gbk.txt", "中文内容".encode("gb18030"), "text/plain")
        with self.assertRaises(ToolError) as caught:
            self.tool(path="/gbk.txt", edits=[{"find": "a", "replace": "b"}])
        self.assertIn("UTF-8", str(caught.exception))
        with self.assertRaises(ToolError):
            self.tool(path="/gbk.txt")


class TextCardTests(ActionHelpers, AssistantCase):
    def test_card_reads_before_and_after_then_confirm_writes(self):
        async def run():
            await self.setup_assistant()
            scope = Scope(self.alice.bucket_id)
            await self.app.objects.put_object(scope, "笔记/a.md", b"#  Title\n", 9, "text/markdown")
            user = await self.client.login("user", "alice@example.com", "alice password")
            conversation = await self.start_conversation(user, "笔记/")
            action_id, tool = await self.propose(user, conversation, call("propose_write_text", path="/笔记/a.md",
                                                                          edits=[{"find": "#  Title", "replace": "# Title"}]))
            self.assertNotIn("_refs", str(tool["result"]))
            _, detail = await self.req("GET", f"/api/user/v1/assistant/actions/{action_id}", headers=user)
            self.assertNotIn("_refs", detail["payload"])
            self.assertEqual(detail["payload"]["samples"][0]["mode"], "edit")
            status, text = await self.req("GET", f"/api/user/v1/assistant/actions/{action_id}/text/0", headers=user)
            self.assertEqual((status, text["before"], text["after"], text["changed"]), (200, "#  Title\n", "# Title\n", False))
            status, _ = await self.req("GET", f"/api/user/v1/assistant/actions/{action_id}/text/3", headers=user)
            self.assertEqual(status, 404)
            # 新内容单独存放：payload 里没有，确认后清除。
            row = self.app.metadata.db.execute("SELECT * FROM assistant_actions WHERE id=?", (action_id,)).fetchone()
            self.assertIsNotNone(row["frozen"])
            self.assertNotIn("_frozen", self.service.trace.action_payload(row))
            status, done = await self.confirm(user, action_id)
            self.assertEqual((status, done["status"], done["result"]["ok"]), (200, "done", 1))
            _, stream = await self.app.objects.get_object(scope, "笔记/a.md")
            self.assertEqual(b"".join([chunk async for chunk in stream]), b"# Title\n")
            row = self.app.metadata.db.execute("SELECT frozen FROM assistant_actions WHERE id=?", (action_id,)).fetchone()
            self.assertIsNone(row["frozen"])
        self.run_async(run())

    def test_large_file_edit_sends_only_the_changed_part(self):
        async def run():
            await self.setup_assistant()
            scope = Scope(self.alice.bucket_id)
            lines = [f"第 {index} 行：" + "内容" * 20 for index in range(120000)]
            data = ("\n".join(lines) + "\n").encode()
            self.assertGreater(len(data), 8 * 1024 * 1024)
            await self.app.objects.put_object(scope, "笔记/big.txt", data, len(data), "text/plain")
            self.service.admin_update_tools({"propose_write_text": {"max_bytes": 16 * 1024 * 1024}})
            user = await self.client.login("user", "alice@example.com", "alice password")
            conversation = await self.start_conversation(user, "笔记/")
            started = time.monotonic()
            action_id, tool = await self.propose(user, conversation, call("propose_write_text", path="/笔记/big.txt",
                                                                          edits=[{"find": "第 60000 行：", "replace": "第 60000 行（已改）："}]))
            self.assertLess(time.monotonic() - started, 20)
            _, detail = await self.req("GET", f"/api/user/v1/assistant/actions/{action_id}", headers=user)
            self.assertEqual((detail["payload"]["samples"][0]["added"], detail["payload"]["samples"][0]["removed"]), (1, 1))
            status, text = await self.req("GET", f"/api/user/v1/assistant/actions/{action_id}/text/0", headers=user)
            self.assertEqual(status, 200)
            self.assertEqual((text["skipped_before"], text["start"], text["truncated"]), (59997, 59998, False))
            self.assertGreater(text["skipped_after"], 50000)
            self.assertLess(len(text["before"]), 2000)
            self.assertIn("（已改）", text["after"])
        self.run_async(run())


if __name__ == "__main__":
    unittest.main()
