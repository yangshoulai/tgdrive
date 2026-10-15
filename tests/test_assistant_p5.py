"""文件助手 P5：文件夹改名、公开分享、完全访问模式、浏览器工具、思考过程、秘密保护（docs/assistant-design.md §19）。"""
import asyncio
import unittest

from tests.test_assistant import AssistantCase, answer, call
from tests.test_assistant_actions import ActionHelpers
from tgdrive.assistant.providers import Reply


class AssistantP5Tests(ActionHelpers, AssistantCase):
    async def ready(self, files=(), location=""):
        admin, channel, model = await self.setup_assistant()
        for key in files:
            await self.put(key, key.encode())
        user = await self.client.login("user", "alice@example.com", "alice password")
        conversation = await self.start_conversation(user, location)
        return admin, user, conversation

    # ---------- 文件夹改名 ----------

    def test_rename_folders_by_rule_and_mapping(self):
        async def run():
            _, user, conversation = await self.ready(["Music/a.mp3", "Book/b.pdf", "Book/sub/c.txt", "notes.txt"])
            action_id, tool = await self.propose(user, conversation, call(
                "propose_rename", match={"type": "folder"}, template="{name}_2026"))
            self.assertEqual(tool["result"]["count"], 2)
            status, data = await self.confirm(user, action_id)
            self.assertEqual(data["status"], "done", data)
            self.assertIn("Book_2026/sub/c.txt", self.keys())
            self.assertIn("Music_2026/a.mp3", self.keys())
            # 映射模式支持文件夹；同时改名上级和下级时下级跳过。
            action_id, tool = await self.propose(user, conversation, call(
                "propose_rename", mapping=[{"from": "/Book_2026", "to": "图书"}, {"from": "/Book_2026/sub/", "to": "子目录"}]))
            self.assertEqual(tool["result"]["count"], 1)
            self.assertEqual(tool["result"]["conflicts"], 1)
            status, data = await self.confirm(user, action_id)
            self.assertIn("图书/sub/c.txt", self.keys())
            status, data = await self.req("POST", f"/api/user/v1/assistant/actions/{action_id}/undo", {}, user)
            self.assertEqual(status, 200, data)
            self.assertIn("Book_2026/sub/c.txt", self.keys())
        self.run_async(run())

    # ---------- 公开分享 ----------

    def test_share_password_only_from_card_and_links_hidden_from_model(self):
        async def run():
            _, user, conversation = await self.ready(["Docs/report.pdf", "Docs/plan.md"])
            action_id, tool = await self.propose(user, conversation, call(
                "propose_share", paths=["/Docs/report.pdf", "/Docs/"], expires_days=7, require_password=True))
            self.assertEqual(tool["result"]["count"], 2)
            status, data = await self.confirm(user, action_id, {"share": {"password": "ab"}}, wait=False)
            self.assertEqual(status, 400, "密码太短被拒绝")
            status, data = await self.confirm(user, action_id, {"share": {"password": "secret-pass-42", "expires_days": 3}})
            self.assertEqual(data["status"], "done", data)
            links = data["result"]["links"]
            self.assertEqual(len(links), 2)
            row = self.app.metadata.db.execute("SELECT public_token, public_password, public_expires_at FROM objects WHERE key='Docs/report.pdf'").fetchone()
            self.assertIsNotNone(row["public_password"])
            self.assertAlmostEqual(row["public_expires_at"] - __import__("time").time(), 3 * 86400, delta=60)
            # 链接令牌与密码不进入模型上下文与对话正文。
            messages = await self.messages(user, conversation)
            text = str(messages)
            self.assertNotIn(row["public_token"], text)
            self.assertNotIn("secret-pass-42", text)
            self.model.replies = [answer("好的")]
            await self.send(user, conversation, "继续")
            self.assertNotIn(row["public_token"], str(self.model.calls[-1]["messages"]))
            audit = self.app.metadata.db.execute("SELECT detail FROM audit_log WHERE action='assistant.action.confirm'").fetchall()
            self.assertNotIn("secret-pass-42", str([dict(r) for r in audit]))
            # 撤销取消新创建的公开链接。
            status, data = await self.req("POST", f"/api/user/v1/assistant/actions/{action_id}/undo", {}, user)
            self.assertEqual(status, 200, data)
            row = self.app.metadata.db.execute("SELECT public_token FROM objects WHERE key='Docs/report.pdf'").fetchone()
            self.assertIsNone(row["public_token"])
        self.run_async(run())

    # ---------- 完全访问 ----------

    def test_full_access_requires_admin_permission(self):
        async def run():
            admin, user, conversation = await self.ready()
            status, data = await self.req("POST", f"/api/user/v1/assistant/conversations/{conversation}/update", {"access_mode": "full"}, user)
            self.assertEqual(status, 400, "默认不允许完全访问")
            await self.req("POST", f"/api/admin/v1/assistant/users/{self.alice.id}/policy", {"full_access": True}, admin)
            status, data = await self.req("POST", f"/api/user/v1/assistant/conversations/{conversation}/update", {"access_mode": "full"}, user)
            self.assertEqual((status, data["access_mode"]), (200, "full"))
            # 管理员收回后对话按审批模式处理。
            await self.req("POST", f"/api/admin/v1/assistant/users/{self.alice.id}/policy", {"full_access": False}, admin)
            _, detail = await self.req("GET", f"/api/user/v1/assistant/conversations/{conversation}", headers=user)
            self.assertEqual(detail["conversation"]["access_mode"], "approval")
        self.run_async(run())

    def test_full_access_auto_executes_but_not_after_reading_content(self):
        async def run():
            admin, user, conversation = await self.ready(["Inbox/a.jpg", "Inbox/b.jpg", "Inbox/readme.txt"])
            await self.req("POST", "/api/admin/v1/assistant/settings", {"full_access": True}, admin)
            await self.req("POST", f"/api/user/v1/assistant/conversations/{conversation}/update", {"access_mode": "full"}, user)
            self.model.replies = [call("propose_rename", match={"path": "/Inbox", "glob": "*.jpg"}, template="pic_{n}{ext}"), answer("完成")]
            await self.send(user, conversation, "改名")
            tool = (await self.tool_results(user, conversation))[-1]
            self.assertIn("自动执行", tool["result"]["status"])
            self.assertEqual(tool["result"]["result"]["ok"], 2)
            self.assertIn("Inbox/pic_1.jpg", self.keys())
            action = self.app.metadata.db.execute("SELECT status FROM assistant_actions WHERE id=?", (tool["result"]["action_id"],)).fetchone()
            self.assertEqual(action["status"], "done")
            self.assertTrue(self.app.metadata.db.execute("SELECT 1 FROM audit_log WHERE action='assistant.action.auto'").fetchone())
            # 自动执行的结果事件写在工具结果之前，模型看到的仍是完整的工具结果而不是「已取消」。
            last = [c for c in self.model.calls if c["tools"]][-1]
            sent = [m for m in last["messages"] if m.get("role") == "tool"]
            self.assertTrue(sent and "已取消" not in sent[-1]["content"], sent)
            # 分享总是需要确认。
            action_id, tool = await self.propose(user, conversation, call("propose_share", paths=["/Inbox/readme.txt"]))
            self.assertIn("等待用户", tool["result"]["status"])
            # 读取文件内容后，同一对话后续修改需要确认（防止内容里的诱导指令）。
            self.model.replies = [call("read_text_file", path="/Inbox/readme.txt"), call("propose_trash", paths=["/Inbox/pic_1.jpg"]), answer("好")]
            await self.send(user, conversation, "读一下再删")
            tool = (await self.tool_results(user, conversation))[-1]
            self.assertIn("等待用户", tool["result"]["status"])
            self.assertIn("Inbox/pic_1.jpg", self.keys())
        self.run_async(run())

    # ---------- 浏览器工具 ----------

    def test_client_tools_round_trip_and_filter(self):
        async def run():
            _, user, conversation = await self.ready(["Photos/a.jpg"], location="Photos/")
            self.model.replies = [call("ui_get_view"), answer("看到了")]
            # 没有对话框在监听时立即失败，不会卡住。
            await self.send(user, conversation, "看看我选中了什么")
            tool = (await self.tool_results(user, conversation))[-1]
            self.assertEqual(tool["status"], "error")
            self.assertIn("未连接", tool["result"]["error"])

            self.model.replies = [call("ui_get_view"), answer("看到了")]
            status, data = await self.req("POST", f"/api/user/v1/assistant/conversations/{conversation}/messages", {"text": "再看看"}, user)
            state = self.service.runs[data["run_id"]]
            state.listeners += 1  # 模拟对话框订阅了事件流
            for _ in range(100):
                calls = [e for e in state.events if e["type"] == "client_call"]
                if calls:
                    break
                await asyncio.sleep(0.01)
            event = calls[0]
            other = await self.client.login("user", "alice@example.com", "alice password")
            status, _ = await self.req("POST", f"/api/user/v1/assistant/runs/{data['run_id']}/client-results",
                                       {"call_id": event["call_id"], "result": {}}, other)
            self.assertEqual(status, 403, "其他登录会话不能回传")
            result = {"view": "files", "path": "/Photos/", "selected": ["/Photos/a.jpg", "/Secret/x.txt", "/.tgdrive/private/y"],
                      "visible": [{"path": "/Photos/a.jpg", "size": 7}], "total": 1}
            status, _ = await self.req("POST", f"/api/user/v1/assistant/runs/{data['run_id']}/client-results",
                                       {"call_id": event["call_id"], "result": result}, user)
            self.assertEqual(status, 204)
            await state.task
            tool = (await self.tool_results(user, conversation))[-1]
            self.assertEqual(tool["result"]["selected"], ["/Photos/a.jpg"], "作用域外与私密空间的条目被过滤")
            status, _ = await self.req("POST", f"/api/user/v1/assistant/runs/{data['run_id']}/client-results",
                                       {"call_id": event["call_id"], "result": {}}, user)
            self.assertIn(status, (400, 404))
        self.run_async(run())

    def test_gesture_tools_create_cards(self):
        async def run():
            _, user, conversation = await self.ready(["Photos/a.jpg", "Photos/b.jpg"])
            self.model.replies = [call("ui_download", paths=["/Photos/"]), call("browser_open_url", url="javascript:alert(1)"),
                                  call("browser_open_url", url="https://example.com/a"), answer("好")]
            await self.send(user, conversation, "下载")
            tools = await self.tool_results(user, conversation)
            self.assertEqual(tools[0]["event"]["action"], "download")
            self.assertEqual(tools[0]["event"]["items"], [{"path": "Photos/", "folder": True}])
            self.assertEqual(tools[1]["status"], "error")
            self.assertEqual(tools[2]["event"]["url"], "https://example.com/a")
            self.model.replies = [call("ui_download", paths=["/.tgdrive/private/x"]), answer("好")]
            await self.send(user, conversation, "下载私密")
            self.assertEqual((await self.tool_results(user, conversation))[-1]["status"], "error")
        self.run_async(run())

    # ---------- 思考与秘密 ----------

    def test_reasoning_is_stored_but_not_sent_back(self):
        async def run():
            _, user, conversation = await self.ready()
            self.model.replies = [Reply(text="答案", reasoning="先想一想用户要什么", input_tokens=10, output_tokens=5)]
            await self.send(user, conversation, "你好")
            assistant = [m for m in await self.messages(user, conversation) if m["role"] == "assistant"][-1]
            self.assertEqual(assistant["reasoning"], "先想一想用户要什么")
            self.model.replies = [answer("好")]
            await self.send(user, conversation, "继续")
            self.assertNotIn("先想一想", str(self.model.calls[-1]["messages"]))
        self.run_async(run())

    def test_secrets_are_redacted(self):
        async def run():
            _, user, conversation = await self.ready(["keys.txt"])
            await self.put("keys.txt", b"token: sk-abcdefghijklmnopqrstuvwxyz0123\nhello")
            self.model.replies = [call("read_text_file", path="/keys.txt"), answer("渠道密钥是 sk-secret-value-1234")]
            await self.send(user, conversation, "读一下")
            messages = await self.messages(user, conversation)
            tool = [m for m in messages if m["role"] == "tool"][-1]
            self.assertNotIn("sk-abcdefghijklmnopqrstuvwxyz0123", tool["result"]["content"])
            self.assertIn("已隐藏", tool["result"]["content"])
            final = [m for m in messages if m["role"] == "assistant"][-1]
            self.assertNotIn("sk-secret-value-1234", final["text"], "已知的渠道 API Key 不会出现在输出中")
            system = self.model.calls[0]["system"]
            self.assertIn("保密", system)
            self.assertNotIn("127.0.0.1", system)
        self.run_async(run())


if __name__ == "__main__":
    unittest.main()
