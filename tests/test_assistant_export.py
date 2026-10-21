"""对话导出：只能导出自己的对话，内容是明文留痕；涉及私密的对话要求当前会话已解锁。"""
import json
from urllib.parse import unquote

from tests.test_assistant import AssistantCase, answer, call
from tests.test_assistant_actions import ActionHelpers
from tests import test_assistant_private as private_tests

BASE = "/api/user/v1/assistant"


class ConversationExportTests(ActionHelpers, AssistantCase):
    enable_private = private_tests.PrivateAssistantTests.enable_private
    login = private_tests.PrivateAssistantTests.login
    unlock = private_tests.PrivateAssistantTests.unlock
    lock = private_tests.PrivateAssistantTests.lock
    ack_private = private_tests.PrivateAssistantTests.ack_private
    private_conversation = private_tests.PrivateAssistantTests.private_conversation

    async def export(self, user, conversation, fmt="markdown", tz="Asia/Shanghai"):
        status, headers, data = await self.client.request(
            "GET", f"{BASE}/conversations/{conversation}/export?format={fmt}&tz={tz}", b"", user)
        return status, headers, data

    def test_markdown_and_json_contain_plaintext(self):
        async def run():
            _, _, _ = await self.setup_assistant()
            user = await self.login()
            await self.put("相册/海边.jpg", b"jpg")
            conversation = await self.start_conversation(user)
            self.model.replies = [call("list_folder", path="/相册"), answer("相册里有一张**海边**的照片。")]
            status, data = await self.send(user, conversation, "看看相册里有什么")
            self.assertEqual(status, 201, data)

            status, headers, body = await self.export(user, conversation)
            self.assertEqual(status, 200, body)
            self.assertTrue(headers["content-type"].startswith("text/markdown"))
            self.assertEqual(headers["cache-control"], "no-store")
            self.assertIn("attachment;", headers["content-disposition"])
            self.assertTrue(unquote(headers["content-disposition"].split("UTF-8''", 1)[1]).endswith(".md"))
            text = body.decode()
            self.assertIn("## 用户", text)
            self.assertIn("看看相册里有什么", text)
            self.assertIn("相册里有一张**海边**的照片。", text)
            self.assertIn("### 工具：", text)
            self.assertIn("海边.jpg", text)
            self.assertNotIn("model_content", text)

            status, headers, body = await self.export(user, conversation, "json")
            self.assertEqual(status, 200, body)
            self.assertTrue(headers["content-type"].startswith("application/json"))
            data = json.loads(body)
            self.assertEqual(data["format"], "tessera.assistant.conversation")
            self.assertEqual(data["conversation"]["id"], conversation)
            self.assertTrue(data["conversation"]["created_at"].endswith("+08:00"))
            roles = [message["role"] for message in data["messages"]]
            self.assertIn("user", roles)
            self.assertIn("tool", roles)
            self.assertIn("assistant", roles)
            self.assertFalse(any("model_content" in message for message in data["messages"]))

            status, _, _ = await self.export(user, conversation, "pdf")
            self.assertEqual(status, 400)
            audit = self.app.metadata.db.execute(
                "SELECT target, detail FROM audit_log WHERE action='assistant.conversation.export'").fetchall()
            self.assertEqual(len(audit), 2)
            self.assertNotIn("海边", "".join(str(tuple(row)) for row in audit))
        self.run_async(run())

    def test_other_users_cannot_export(self):
        async def run():
            admin, _, _ = await self.setup_assistant()
            user = await self.login()
            conversation = await self.start_conversation(user)
            status, _, _ = await self.export(admin, conversation)
            self.assertEqual(status, 404)
        self.run_async(run())

    def test_private_conversation_requires_unlock(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            user = await self.unlock(await self.login())
            conversation = await self.private_conversation(user)
            self.model.replies = [answer("私密相册已整理。")]
            status, data = await self.send(user, conversation, "整理私密相册")
            self.assertEqual(status, 201, data)
            status, _, body = await self.export(user, conversation)
            self.assertEqual(status, 200, body)
            self.assertIn("私密相册已整理。", body.decode())
            self.assertIn("作用域：私密空间", body.decode())

            await self.lock(user)
            status, _, body = await self.export(user, conversation, "json")
            self.assertEqual(status, 423, body)
            self.assertIn(b"private_locked", body)
            self.assertNotIn("私密相册".encode(), body)
        self.run_async(run())
