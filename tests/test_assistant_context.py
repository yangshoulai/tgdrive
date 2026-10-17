"""文件助手上下文压缩加固（docs/assistant-design.md §23）。"""
import json
import unittest

from tests.test_assistant import AssistantCase, answer, call
from tgdrive.assistant import providers
from tgdrive.assistant.providers import ProviderError, Reply

TEXT = "word " * 6000  # 约 3 万字符，估算约 1.5 万 token


def overflow(messages, tools):
    raise ProviderError("对话内容超出模型的上下文长度", status=400, code="context_overflow")


class ContextTests(AssistantCase):
    async def prepare(self, window: int, *, result_bytes: int = 65536):
        admin, _, model = await self.setup_assistant()
        status, data = await self.req("POST", f"/api/admin/v1/assistant/models/{model['id']}/update", {"context_window": window}, admin)
        self.assertEqual(status, 200, data)
        status, data = await self.req("POST", "/api/admin/v1/assistant/limits", {"tool_result_bytes": result_bytes}, admin)
        self.assertEqual(status, 200, data)
        user = await self.client.login("user", "alice@example.com", "alice password")
        for name in ("a", "b", "c"):
            await self.put(f"文档/{name}.txt", TEXT.encode())
        await self.put("文档/short.txt", b"short text")
        return user, await self.start_conversation(user)

    @staticmethod
    def tool_contents(record):
        return [m["content"] for m in record["messages"] if m["role"] == "tool"]

    def test_old_tool_results_are_slimmed_after_two_turns(self):
        async def scenario():
            user, conversation = await self.prepare(200000, result_bytes=12288)
            self.model.replies = [call("read_text_file", path="/文档/short.txt"), answer("读完了")]
            await self.send(user, conversation, "读一下 short.txt")
            self.model.replies = [answer("第二轮")]
            await self.send(user, conversation, "第二个问题")
            self.assertIn("short text", self.tool_contents([r for r in self.model.calls if r["tools"]][-1])[0], "上一轮的工具结果保持原文")
            self.model.replies = [answer("第三轮")]
            await self.send(user, conversation, "第三个问题")
            content = self.tool_contents([r for r in self.model.calls if r["tools"]][-1])[0]
            self.assertTrue(content.startswith("[已省略原始结果] read_text_file 成功"), content)
            self.assertNotIn("short text", content)
            for record in self.model.calls:
                for message in record["messages"]:
                    self.assertFalse(any(key.startswith("_") for key in message), "内部字段不发给模型")
            # 留痕不变，界面仍能看到完整结果。
            tool = next(m for m in await self.messages(user, conversation) if m["role"] == "tool")
            self.assertIn("short text", json.dumps(tool["result"], ensure_ascii=False))
        self.run_async(scenario())

    def test_single_run_shrinks_older_results_of_this_run(self):
        async def scenario():
            user, conversation = await self.prepare(60000)
            self.model.replies = [call("read_text_file", path="/文档/a.txt"), call("read_text_file", path="/文档/b.txt"),
                                  call("read_text_file", path="/文档/c.txt"), answer("三个文件都读完了")]
            status, data = await self.send(user, conversation, "依次读三个文件")
            self.assertEqual(status, 201, data)
            final = self.tool_contents([record for record in self.model.calls if record["tools"]][-1])  # 最后一次是生成标题
            self.assertEqual(len(final), 3)
            self.assertTrue(final[0].startswith("[已省略原始结果]"), "最早的结果换成摘要行")
            self.assertIn("word word", final[-1], "最近一批保持原文")
            self.assertEqual(self.service.runs[data["run_id"]].stop_reason, "completed")
        self.run_async(scenario())

    def test_context_full_stops_without_calling_channel(self):
        async def scenario():
            user, conversation = await self.prepare(25000)
            self.model.replies = [call("read_text_file", path="/文档/a.txt"), answer("不应该被调用")]
            status, data = await self.send(user, conversation, "读 a.txt")
            self.assertEqual(status, 201, data)
            self.assertEqual(len(self.model.calls), 1, "放不下时不再请求渠道")
            self.assertEqual(self.service.runs[data["run_id"]].stop_reason, "context")
            events = [m for m in await self.messages(user, conversation) if m["role"] == "event"]
            self.assertIn("请新建对话继续", events[-1]["text"])
        self.run_async(scenario())

    def test_channel_overflow_compacts_and_retries_once(self):
        async def scenario():
            user, conversation = await self.prepare(200000)
            for index in range(3):
                self.model.replies = [answer(f"第 {index} 轮回答")]
                await self.send(user, conversation, f"第 {index} 个问题")
            self.model.replies = [overflow, Reply(text="摘要：用户问了三个问题"), answer("重试成功")]
            status, data = await self.send(user, conversation, "最新的问题")
            self.assertEqual(status, 201, data)
            messages = await self.messages(user, conversation)
            self.assertEqual(len([m for m in messages if m.get("type") == "summary"]), 1, "强制压缩")
            self.assertEqual(messages[-1]["text"], "重试成功")
            self.assertIn("摘要：用户问了三个问题", json.dumps(self.model.calls[-1]["messages"], ensure_ascii=False))
            _, detail = await self.req("GET", f"/api/user/v1/assistant/conversations/{conversation}", headers=user)
            self.assertEqual(detail["context"]["window"], 200000)
            self.assertGreater(detail["context"]["used"], 0)
            # 第二次仍超长：结束本轮并提示新建对话，不当作渠道故障。
            self.model.replies = [overflow, overflow]
            status, data = await self.send(user, conversation, "再问一次")
            self.assertEqual(self.service.runs[data["run_id"]].stop_reason, "context")
            last = [m for m in await self.messages(user, conversation) if m["role"] == "event"][-1]
            self.assertIn("请新建对话继续", last["text"])
        self.run_async(scenario())

    def test_measure_uses_actual_usage_and_ignores_implausible_values(self):
        measure = self.service._measure
        self.assertEqual(measure({"model_id": 1, "input_tokens": 9000, "prompt_estimate": 8000}, 1, 8500), 9500)
        self.assertEqual(measure({"model_id": 1, "input_tokens": 50, "prompt_estimate": 8000}, 1, 8500), 8500, "用量明显不可信")
        self.assertEqual(measure({"model_id": 2, "input_tokens": 9000, "prompt_estimate": 8000}, 1, 8500), 8500, "换了模型")
        self.assertEqual(measure({}, 1, 8500), 8500)


class OverflowDetectionTests(unittest.TestCase):
    def test_status_errors(self):
        openai = json.dumps({"error": {"message": "This model's maximum context length is 8192 tokens.", "code": "context_length_exceeded"}})
        anthropic = json.dumps({"type": "error", "error": {"type": "invalid_request_error", "message": "prompt is too long: 210000 tokens > 200000"}})
        self.assertEqual(providers._status_error(400, openai.encode()).code, "context_overflow")
        self.assertEqual(providers._status_error(400, anthropic.encode()).code, "context_overflow")
        self.assertEqual(providers._status_error(400, b'{"error": {"message": "invalid tool schema"}}').code, "upstream_error")
        self.assertEqual(providers._status_error(429, openai.encode()).code, "rate_limited", "限流不按超长处理")


if __name__ == "__main__":
    unittest.main()
