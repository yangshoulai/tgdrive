"""文件助手识图与聊天框附件（docs/assistant-design.md §22）。"""
import json
import unittest

from tests.test_assistant import AssistantCase, answer, call
from tgdrive.assistant import providers
from tgdrive.assistant.tools import ToolContext, ToolError
from tgdrive.objects import Scope

JPEG = b"\xff\xd8\xff\xe0" + b"poster-jpeg" * 20
PNG = b"\x89PNG\r\n\x1a\n" + b"original-png" * 20
SHOT = "助手附件/2026-10/截图 1.png"


class VisionTests(AssistantCase):
    async def prepare(self, *, can_see: bool):
        admin, _, model = await self.setup_assistant()
        if can_see:
            status, model = await self.req("POST", f"/api/admin/v1/assistant/models/{model['id']}/update", {"vision": "yes"}, admin)
            self.assertEqual(status, 200, model)
            self.assertTrue(model["capabilities"]["vision"])
        user = await self.client.login("user", "alice@example.com", "alice password")
        await self.put("相册/cat.jpg", b"large original that is not used" * 10)
        self.app.objects.set_thumbnail(Scope(self.alice.bucket_id), "相册/cat.jpg", JPEG, "poster")
        await self.put("相册/notes.txt", b"hello")
        await self.put(SHOT, PNG)
        await self.put("文档/readme.txt", b"doc")
        return admin, user, model

    @staticmethod
    def user_messages(call_record):
        return [m for m in call_record["messages"] if m["role"] == "user" and not m["content"].startswith("<context>")]

    def test_mentions_and_attachments_reach_vision_model_in_current_run_only(self):
        async def scenario():
            _, user, _ = await self.prepare(can_see=True)
            conversation = await self.start_conversation(user)
            self.model.replies = [answer("一只猫和一张截图。"), answer("好的。")]
            status, data = await self.send(user, conversation, "描述一下 @/相册/cat.jpg 和附件", scope="path", scope_path="/相册/",
                                           mentions=["/相册/cat.jpg", "/相册/notes.txt"], attachments=["/" + SHOT])
            self.assertEqual(status, 201, data)
            first = self.user_messages(self.model.calls[0])[-1]
            self.assertEqual([(image["path"], image["mime"]) for image in first["images"]],
                             [("/相册/cat.jpg", "image/jpeg"), ("/" + SHOT, "image/png")])
            self.assertEqual(first["images"][0]["data"], JPEG, "优先发送预览图")
            self.assertEqual(first["images"][1]["data"], PNG, "没有预览图时发送受支持格式的小原图")
            self.assertIn("[附件]", first["content"])
            self.assertIn("view_image", self.model.calls[0]["tools"])
            # 附件在作用域外也允许；留痕只保存路径，不保存图片字节。
            stored = [m for m in await self.messages(user, conversation) if m["role"] == "user"][0]
            self.assertEqual(stored["attachments"], ["/" + SHOT])
            self.assertNotIn("images", stored)
            await self.send(user, conversation, "谢谢")
            earlier, latest = self.user_messages(self.model.calls[-1])[-2:]
            self.assertNotIn("images", earlier, "更早轮次的图片不再发送")
            self.assertIn("是之前消息里的图片", earlier["content"])
            self.assertNotIn("images", latest)
        self.run_async(scenario())

    def test_model_without_vision_gets_note_and_no_tool(self):
        async def scenario():
            _, user, _ = await self.prepare(can_see=False)
            conversation = await self.start_conversation(user)
            self.model.replies = [answer("我看不到图片。")]
            status, _ = await self.send(user, conversation, "这是什么", mentions=["/相册/cat.jpg"])
            self.assertEqual(status, 201)
            message = self.user_messages(self.model.calls[0])[-1]
            self.assertNotIn("images", message)
            self.assertIn("当前模型不能识图", message["content"])
            self.assertNotIn("view_image", self.model.calls[0]["tools"])
        self.run_async(scenario())

    def test_view_image_and_read_only_attachment_allowlist(self):
        async def scenario():
            _, user, _ = await self.prepare(can_see=True)
            conversation = await self.start_conversation(user)
            self.model.replies = [call("view_image", path="/" + SHOT), call("propose_move", sources=["/" + SHOT], target="/文档/"),
                                  answer("看过了。")]
            status, data = await self.send(user, conversation, "看看附件", scope="path", scope_path="/文档/", attachments=["/" + SHOT])
            self.assertEqual(status, 201, data)
            tool = [m for m in self.model.calls[1]["messages"] if m["role"] == "tool"][-1]
            self.assertEqual([(image["path"], image["mime"]) for image in tool["images"]], [("/" + SHOT, "image/png")])
            messages = await self.messages(user, conversation)
            viewed, moved = [m for m in messages if m["role"] == "tool"]
            self.assertEqual(viewed["status"], "ok")
            self.assertEqual(viewed["images"], [SHOT], "留痕只保存图片引用")
            self.assertEqual(moved["status"], "error", "写入工具没有附件白名单例外")
            self.assertIn("作用域", moved["result"]["error"])
            self.assertEqual(self.service._conversation_taint(conversation), "查看过图片内容")
        self.run_async(scenario())

    def test_attachment_validation(self):
        async def scenario():
            _, user, _ = await self.prepare(can_see=True)
            conversation = await self.start_conversation(user)
            for attachments, reason in ((["/相册/cat.jpg"], "必须保存在"), (["/助手附件/2026-10/missing.png"], "不存在"),
                                        (["/" + SHOT] * 11, "最多 10 个"), (["/.tgdrive/private/a.png"], "附件")):
                status, data = await self.send(user, conversation, "看看", attachments=attachments)
                self.assertEqual(status, 400, attachments)
                self.assertIn(reason, json.dumps(data, ensure_ascii=False))
        self.run_async(scenario())

    def test_vision_override_survives_catalog_refresh(self):
        async def scenario():
            admin, _, model = await self.prepare(can_see=True)
            self.assertIn("vision", self.service.channels.model(model["id"])["manual_fields"])
            self.service.catalog.refresh_models()
            self.assertTrue(self.service.channels.model(model["id"])["capabilities"]["vision"])
            status, model = await self.req("POST", f"/api/admin/v1/assistant/models/{model['id']}/update", {"vision": "auto"}, admin)
            self.assertEqual(status, 200, model)
            self.assertNotIn("vision", model["manual_fields"])
            self.assertFalse(self.service.channels.vision(model), "目录没有声明时按不支持处理")
        self.run_async(scenario())

    def test_estimate_does_not_count_base64(self):
        estimate = self.service._estimate([{"role": "user", "content": "看图",
                                            "images": [{"mime": "image/png", "data": b"x" * 2_000_000, "path": "/a.png"}]}])
        self.assertLess(estimate, 2000)

    def test_resolve_allowlist_is_exact(self):
        context = ToolContext(1, self.alice.bucket_id, "文档/", self.app.objects, None, "files", "", {}, {},
                              readable=frozenset({SHOT}))
        self.assertEqual(context.resolve("/" + SHOT), SHOT)
        self.assertEqual(context.scope_for(SHOT).prefix, "")
        with self.assertRaises(ToolError):
            context.resolve("/助手附件/2026-10/other.png")


class ProviderImageFormatTests(unittest.TestCase):
    IMAGE = {"mime": "image/png", "data": b"png", "path": "/a.png"}

    def test_openai_puts_tool_images_after_the_whole_batch(self):
        messages = [{"role": "user", "content": "看图", "images": [self.IMAGE]},
                    {"role": "assistant", "content": "", "tool_calls": [{"id": "1", "name": "view_image", "arguments": "{}"},
                                                                         {"id": "2", "name": "list_folder", "arguments": "{}"}]},
                    {"role": "tool", "tool_call_id": "1", "content": "ok", "images": [self.IMAGE]},
                    {"role": "tool", "tool_call_id": "2", "content": "ok"}]
        result = providers._openai_messages("system", messages)
        self.assertEqual([item["role"] for item in result], ["system", "user", "assistant", "tool", "tool", "user"])
        self.assertEqual(result[1]["content"][1], {"type": "image_url", "image_url": {"url": "data:image/png;base64,cG5n"}})
        self.assertEqual(result[3]["content"], "ok", "工具消息保持文本")
        self.assertEqual(result[5]["content"][1]["image_url"]["url"], "data:image/png;base64,cG5n")

    def test_anthropic_uses_image_blocks(self):
        messages = [{"role": "user", "content": "看图", "images": [self.IMAGE]},
                    {"role": "assistant", "content": "", "tool_calls": [{"id": "1", "name": "view_image", "arguments": "{}"}]},
                    {"role": "tool", "tool_call_id": "1", "content": "ok", "images": [self.IMAGE]}]
        result, _ = providers._anthropic_messages(messages)
        image = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "cG5n"}}
        self.assertEqual(result[0]["content"][1], image)
        self.assertEqual(result[2]["content"][0]["content"], [{"type": "text", "text": "ok"}, image])

    def test_text_only_messages_are_unchanged(self):
        result = providers._openai_messages("system", [{"role": "user", "content": "你好"}])
        self.assertEqual(result[1], {"role": "user", "content": "你好"})


if __name__ == "__main__":
    unittest.main()
