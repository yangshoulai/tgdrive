"""模型适配：OpenAI 兼容与 Anthropic 的流式解析、工具调用、模型列表与错误脱敏（本地 HTTP 服务模拟上游）。"""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from tgdrive.assistant import providers
from tgdrive.assistant.providers import Endpoint, ProviderError, ToolDef


class Upstream(BaseHTTPRequestHandler):
    routes: dict = {}
    seen: list = []

    def log_message(self, *args):
        pass

    def _reply(self):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        Upstream.seen.append({"path": self.path, "headers": dict(self.headers), "body": body})
        status, content_type, payload = Upstream.routes[self.path.split("?")[0]]
        data = payload.encode() if isinstance(payload, str) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = _reply
    do_POST = _reply


def sse(*events, named=False):
    lines = []
    for event in events:
        if named:
            lines.append(f"event: {event['type']}")
        lines.append("data: " + (event if isinstance(event, str) else json.dumps(event)))
        lines.append("")
    return "\n".join(lines) + "\n"


class ProviderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Upstream.routes, Upstream.seen = {}, []

    def endpoint(self, kind, path=""):
        return Endpoint(kind, self.base + path, "sk-test-key-123456", {"X-Extra": "1"}, 10)

    def test_openai_stream_with_tool_calls_and_usage(self):
        Upstream.routes["/v1/chat/completions"] = (200, "text/event-stream", sse(
            {"id": "cmpl-1", "choices": [{"delta": {"content": "正在"}}]},
            {"id": "cmpl-1", "choices": [{"delta": {"content": "查询"}}]},
            {"id": "cmpl-1", "choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_a", "function": {"name": "search_files", "arguments": "{\"qu"}}]}}]},
            {"id": "cmpl-1", "choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "ery\":\"x\"}"}}]}, "finish_reason": "tool_calls"}]},
            {"id": "cmpl-1", "choices": [], "usage": {"prompt_tokens": 120, "completion_tokens": 30, "prompt_tokens_details": {"cached_tokens": 100}}},
            "[DONE]"))
        chunks = []

        async def on_text(text):
            chunks.append(text)
        reply = asyncio.run(providers.chat(self.endpoint("openai", "/v1"), "gpt-x", "系统", [
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "c0", "name": "get_context", "arguments": "{}"}]},
            {"role": "tool", "tool_call_id": "c0", "content": "ok"}],
            [ToolDef("search_files", "搜索", {"type": "object", "properties": {}})], max_tokens=None, on_text=on_text))
        self.assertEqual("".join(chunks), "正在查询")
        self.assertEqual(reply.tool_calls[0].name, "search_files")
        self.assertEqual(json.loads(reply.tool_calls[0].arguments), {"query": "x"})
        self.assertEqual((reply.input_tokens, reply.output_tokens, reply.cached_tokens), (120, 30, 100))
        self.assertEqual(reply.status, 200)
        sent = Upstream.seen[0]
        self.assertEqual(sent["headers"]["Authorization"], "Bearer sk-test-key-123456")
        self.assertEqual(sent["headers"]["X-Extra"], "1")
        self.assertEqual(sent["body"]["messages"][0], {"role": "system", "content": "系统"})
        self.assertIsNone(sent["body"]["messages"][2]["content"])
        self.assertEqual(sent["body"]["tools"][0]["function"]["name"], "search_files")

    def test_anthropic_stream_and_message_merging(self):
        Upstream.routes["/v1/messages"] = (200, "text/event-stream", sse(
            {"type": "message_start", "message": {"id": "msg_1", "usage": {"input_tokens": 50, "output_tokens": 1}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "好的"}},
            {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "list_folder"}},
            {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"path\":"}},
            {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "\"/\"}"}},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 40}},
            {"type": "message_stop"}, named=True))
        reply = asyncio.run(providers.chat(self.endpoint("anthropic"), "claude-x", "系统", [
            {"role": "user", "content": "看看"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "t0", "name": "get_context", "arguments": "{}"}]},
            {"role": "tool", "tool_call_id": "t0", "content": "结果"},
            {"role": "user", "content": "<context>…</context>"}],
            [ToolDef("list_folder", "列目录", {"type": "object", "properties": {}})], max_tokens=None))
        self.assertEqual(reply.text, "好的")
        self.assertEqual((reply.tool_calls[0].id, json.loads(reply.tool_calls[0].arguments)), ("toolu_1", {"path": "/"}))
        self.assertEqual((reply.input_tokens, reply.output_tokens, reply.finish), (50, 40, "tool_use"))
        self.assertEqual(reply.status, 200)
        sent = Upstream.seen[0]
        self.assertEqual(sent["headers"]["x-api-key"], "sk-test-key-123456")
        messages = sent["body"]["messages"]
        # 工具结果与随后的用户消息合并成一条 user 消息，保持 user/assistant 交替。
        self.assertEqual([m["role"] for m in messages], ["user", "assistant", "user"])
        self.assertEqual([b["type"] for b in messages[2]["content"]], ["tool_result", "text"])
        self.assertEqual(sent["body"]["tools"][0]["input_schema"], {"type": "object", "properties": {}})
        self.assertEqual(sent["body"]["max_tokens"], 4096)

    def test_openai_reasoning_alias_is_not_hidden_by_an_empty_field(self):
        Upstream.routes["/v1/chat/completions"] = (200, "text/event-stream", sse(
            {"choices": [{"delta": {"reasoning_content": "", "reasoning": "先检查"}}]},
            {"choices": [{"delta": {"reasoning_content": "目录"}}]}, "[DONE]"))
        chunks = []

        async def thought(text):
            chunks.append(text)

        reply = asyncio.run(providers.chat(self.endpoint("openai", "/v1"), "gpt-6-luna", "系统", [], [],
                                           max_tokens=None, on_reasoning=thought))
        self.assertEqual(reply.reasoning, "先检查目录")
        self.assertEqual("".join(chunks), reply.reasoning)

    def test_responses_reasoning_stream_tools_and_stateless_history(self):
        opaque = {"type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "opaque-for-provider"}
        reasoning = {**opaque, "summary": [{"type": "summary_text", "text": "先核对目录"}]}
        message = {"type": "message", "id": "msg_1", "role": "assistant", "phase": "commentary",
                   "content": [{"type": "output_text", "text": "正在检查已有相册。"}]}
        function = {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "list_folder", "arguments": '{"path":"目录/"}'}
        Upstream.routes["/v1/responses"] = (200, "text/event-stream", sse(
            {"type": "response.created", "response": {"id": "resp_1"}},
            {"type": "response.reasoning_summary_text.delta", "item_id": "rs_1", "delta": "先核对"},
            {"type": "response.reasoning_summary_text.delta", "item_id": "rs_1", "delta": "目录"},
            {"type": "response.reasoning_summary_text.done", "item_id": "rs_1", "text": "先核对目录"},
            {"type": "response.output_item.done", "output_index": 0, "item": reasoning},
            {"type": "response.output_text.delta", "item_id": "msg_1", "delta": "正在检查已有相册。"},
            {"type": "response.output_item.done", "output_index": 1, "item": message},
            {"type": "response.output_item.added", "output_index": 2, "item": {**function, "arguments": ""}},
            {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "output_index": 2, "delta": '{"path":'},
            {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "output_index": 2, "delta": '"目录/"}'},
            {"type": "response.function_call_arguments.done", "item_id": "fc_1", "output_index": 2, "arguments": function["arguments"]},
            {"type": "response.completed", "response": {"id": "resp_1", "output": [reasoning, message, function],
             "usage": {"input_tokens": 120, "output_tokens": 30, "input_tokens_details": {"cached_tokens": 60}}}}, named=True))
        texts, thoughts = [], []

        async def output(text):
            texts.append(text)

        async def thought(text):
            thoughts.append(text)

        endpoint = self.endpoint("openai", "/v1")
        endpoint.protocol = "responses"
        history = [{"role": "assistant", "content": "此前进度", "reasoning": "可见思考不能回传", "_responses_items": [opaque],
                    "_responses_phase": "commentary", "tool_calls": [{"id": "old_call", "name": "get_context", "arguments": "{}"}]},
                   {"role": "tool", "tool_call_id": "old_call", "content": "目录信息"}, {"role": "user", "content": "继续"}]
        reply = asyncio.run(providers.chat(endpoint, "gpt-6-luna", "系统", history,
                                           [ToolDef("list_folder", "列目录", {"type": "object", "properties": {}})],
                                           max_tokens=4000, on_text=output, on_reasoning=thought))
        self.assertEqual((reply.text, reply.reasoning), ("正在检查已有相册。", "先核对目录"))
        self.assertEqual(("".join(texts), "".join(thoughts)), (reply.text, reply.reasoning))
        self.assertEqual((reply.tool_calls[0].id, reply.tool_calls[0].arguments), ("call_1", function["arguments"]))
        self.assertEqual((reply.input_tokens, reply.output_tokens, reply.cached_tokens), (120, 30, 60))
        self.assertEqual(reply.continuation, [opaque])
        self.assertEqual(reply.phase, "commentary")
        sent = Upstream.seen[0]["body"]
        self.assertEqual(sent["reasoning"], {"summary": "auto"})
        self.assertFalse(sent["store"])
        self.assertEqual(sent["max_output_tokens"], 4000)
        self.assertNotIn("max_tokens", sent)
        self.assertEqual(sent["tools"][0]["name"], "list_folder")
        self.assertEqual(sent["input"][0], opaque)
        self.assertEqual(sent["input"][3], {"type": "function_call_output", "call_id": "old_call", "output": "目录信息"})
        self.assertNotIn("可见思考不能回传", str(sent))

    def test_responses_completed_snapshot_and_interrupted_stream(self):
        endpoint = self.endpoint("openai", "/v1")
        endpoint.protocol = "responses"
        Upstream.routes["/v1/responses"] = (200, "text/event-stream", sse({"type": "response.completed", "response": {
            "id": "resp_2", "output": [{"type": "reasoning", "id": "rs_2", "summary": [{"type": "summary_text", "text": "检查完成"}]},
                                     {"type": "message", "id": "msg_2", "content": [{"type": "output_text", "text": "已完成"}]}]}}))
        reply = asyncio.run(providers.chat(endpoint, "gpt-6-luna", "系统", [], [], max_tokens=None))
        self.assertEqual((reply.reasoning, reply.text), ("检查完成", "已完成"))
        Upstream.routes["/v1/responses"] = (200, "text/event-stream", sse({"type": "response.output_text.delta", "delta": "尚未完成"}))
        with self.assertRaises(ProviderError) as caught:
            asyncio.run(providers.chat(endpoint, "gpt-6-luna", "系统", [], [], max_tokens=None))
        self.assertEqual((caught.exception.code, caught.exception.status), ("stream_error", 200))

    def test_errors_are_scrubbed(self):
        Upstream.routes["/v1/chat/completions"] = (401, "application/json",
                                                   {"error": {"message": "Incorrect API key provided: sk-test-key-123456"}})
        with self.assertRaises(ProviderError) as caught:
            asyncio.run(providers.chat(self.endpoint("openai", "/v1"), "m", "s", [{"role": "user", "content": "x"}], [], max_tokens=None))
        self.assertEqual((caught.exception.status, caught.exception.code), (401, "unauthorized"))
        self.assertNotIn("sk-test-key", str(caught.exception))
        self.assertFalse(caught.exception.retryable)
        Upstream.routes["/v1/chat/completions"] = (503, "application/json", {"error": "overloaded"})
        with self.assertRaises(ProviderError) as caught:
            asyncio.run(providers.chat(self.endpoint("openai", "/v1"), "m", "s", [{"role": "user", "content": "x"}], [], max_tokens=None))
        self.assertTrue(caught.exception.retryable)

    def test_connection_failure(self):
        endpoint = Endpoint("openai", "http://127.0.0.1:9", None, {}, 2)
        with self.assertRaises(ProviderError) as caught:
            asyncio.run(providers.list_models(endpoint))
        self.assertEqual(caught.exception.code, "connect_error")

    def test_stream_errors_keep_http_status(self):
        for kind, path in (("openai", "/v1/chat/completions"), ("anthropic", "/v1/messages")):
            with self.subTest(kind=kind):
                Upstream.routes[path] = (200, "text/event-stream", sse(
                    {"type": "error", "error": {"message": "服务暂时不可用"}}))
                with self.assertRaises(ProviderError) as caught:
                    asyncio.run(providers.chat(self.endpoint(kind, "/v1"), "m", "s", [], [], max_tokens=None))
                self.assertEqual((caught.exception.status, caught.exception.code), (200, "upstream_error"))

    def test_list_models(self):
        Upstream.routes["/v1/models"] = (200, "application/json", {"data": [{"id": "a", "context_length": 8000}, {"id": "b"}, {"x": 1}]})
        models = asyncio.run(providers.list_models(self.endpoint("openai", "/v1")))
        self.assertEqual([(m["model"], m["context_window"]) for m in models], [("a", 8000), ("b", None)])
        Upstream.routes["/v1/models"] = (200, "application/json", {"data": [{"id": "claude-1", "display_name": "Claude"}], "has_more": False})
        models = asyncio.run(providers.list_models(self.endpoint("anthropic")))
        self.assertEqual(models[0]["display_name"], "Claude")
        self.assertIn("limit=1000", Upstream.seen[-1]["path"])


class ResponsesConfigTests(unittest.TestCase):
    """只使用字典替身，不初始化或连接数据库。"""

    def test_protocol_defaults_persists_and_is_removed_with_channel(self):
        from contextlib import nullcontext
        from types import SimpleNamespace
        from tgdrive.assistant.channels import ChannelStore

        class Settings:
            values = {}

            def execute(self, query, args):
                if query.startswith("INSERT INTO settings"):
                    self.values[args[0]] = args[1]
                elif query.startswith("DELETE FROM settings"):
                    self.values.pop(args[0], None)
                found = self.values.get(args[0]) if query.startswith("SELECT value FROM settings") else None
                return SimpleNamespace(fetchone=lambda: {"value": found} if found else None)

        db = Settings()
        store = object.__new__(ChannelStore)
        store.metadata = SimpleNamespace(db=db, transaction=lambda: nullcontext(db))
        row = {"kind": "openai", "base_url": "https://relay.example/v1", "secret": None, "headers": None, "timeout": 120}
        store._row = lambda _: row
        store._open = lambda *_: None
        store.get = lambda identifier: {"protocol": store._protocol(identifier)}
        self.assertEqual(store.endpoint(1).protocol, "chat_completions")
        self.assertEqual(store.update(1, {"protocol": "responses"})["protocol"], "responses")
        self.assertEqual(store.update(1, {"name": "修改名称"})["protocol"], "responses")
        self.assertEqual(store.endpoint(1).protocol, "responses")
        store.delete(1)
        self.assertEqual(db.values, {})
        row["kind"] = "anthropic"
        with self.assertRaises(ValueError):
            store.update(1, {"protocol": "responses"})

    def test_exports_keep_visible_reasoning_and_exclude_opaque_state(self):
        from tgdrive.assistant import export
        conversation = {"id": "chat", "title": "演示", "created_at": 1, "updated_at": 2}
        messages = [{"role": "assistant", "created_at": 2, "text": "进度说明", "reasoning": "官方思考摘要",
                     "_responses": {"binding": "binding", "items": [{"encrypted_content": "opaque-secret"}]}}]
        markdown = export.render_markdown(conversation, messages, export.UTC, 3).decode()
        raw = export.render_json(conversation, messages, [], export.UTC, 3).decode()
        self.assertIn("> **思考**", markdown)
        self.assertIn("官方思考摘要", markdown)
        self.assertIn("官方思考摘要", raw)
        self.assertNotIn("_responses", raw)
        self.assertNotIn("opaque-secret", raw + markdown)

    def test_reasoning_probe_budget_does_not_disable_known_tool_support(self):
        from contextlib import nullcontext
        from types import SimpleNamespace
        from unittest.mock import AsyncMock, Mock, patch
        from tgdrive.assistant.channels import ChannelStore

        store = object.__new__(ChannelStore)
        db = SimpleNamespace(execute=Mock())
        store.metadata = SimpleNamespace(transaction=lambda: nullcontext(db))
        store.model = lambda _: {"id": 1, "channel_id": 1, "model": "gpt-6-luna", "tools": "yes"}
        store.endpoint = lambda _: Endpoint("openai", "https://relay.example/v1", None, {}, 120, "responses")
        store.log_call = Mock()
        with patch.object(providers, "chat", new=AsyncMock(return_value=providers.Reply(finish="length"))) as chat:
            result = asyncio.run(store.test(1, ToolDef("probe", "测试", {}), "测试"))
        self.assertEqual(chat.call_args.kwargs["max_tokens"], 4096)
        self.assertEqual(result["tools"], "yes")
        self.assertIn("尚未确认", result["note"])

    def test_opaque_history_is_bound_to_model_address_and_credentials(self):
        from dataclasses import replace
        endpoint = Endpoint("openai", "https://relay.example/v1", "test-key", {}, 120, "responses")
        _, binding = providers.prepare_messages(endpoint, 1, [])
        opaque = [{"type": "reasoning", "summary": [], "encrypted_content": "opaque"}]
        messages = [{"role": "assistant", "content": "进度", "_responses": {"binding": binding, "items": opaque, "phase": "commentary"}}]
        prepared, _ = providers.prepare_messages(endpoint, 1, messages)
        self.assertEqual(prepared[0]["_responses_items"], opaque)
        self.assertIn("_responses", messages[0])
        for current, identifier in [(endpoint, 2), (replace(endpoint, api_key="another-key"), 1),
                                    (replace(endpoint, base_url="https://another.example/v1"), 1),
                                    (replace(endpoint, headers={"X-Org": "another"}), 1),
                                    (replace(endpoint, protocol="chat_completions"), 1)]:
            prepared, _ = providers.prepare_messages(current, identifier, messages)
            self.assertNotIn("_responses_items", prepared[0])
            self.assertNotIn("_responses", prepared[0])


class FailureTextTests(unittest.TestCase):
    def test_user_sees_reason_and_next_step_not_upstream_text(self):
        from tgdrive.assistant.service import provider_failure_text
        # 用户看到的说明按错误类别给出下一步，不包含上游原文、HTTP 状态码或英文内部信息。
        for code in ("unauthorized", "forbidden", "rate_limited", "not_found", "stream_error", "upstream_error", "anything"):
            text = provider_failure_text(code)
            self.assertNotRegex(text, r"[A-Za-z]{3,}|HTTP|\d{3}")
            self.assertTrue(text.endswith("。"))
        self.assertIn("管理员", provider_failure_text("unauthorized"))
        self.assertIn("重试", provider_failure_text("rate_limited"))


if __name__ == "__main__":
    unittest.main()
