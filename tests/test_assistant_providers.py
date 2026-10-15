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
        sent = Upstream.seen[0]
        self.assertEqual(sent["headers"]["x-api-key"], "sk-test-key-123456")
        messages = sent["body"]["messages"]
        # 工具结果与随后的用户消息合并成一条 user 消息，保持 user/assistant 交替。
        self.assertEqual([m["role"] for m in messages], ["user", "assistant", "user"])
        self.assertEqual([b["type"] for b in messages[2]["content"]], ["tool_result", "text"])
        self.assertEqual(sent["body"]["tools"][0]["input_schema"], {"type": "object", "properties": {}})
        self.assertEqual(sent["body"]["max_tokens"], 4096)

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

    def test_list_models(self):
        Upstream.routes["/v1/models"] = (200, "application/json", {"data": [{"id": "a", "context_length": 8000}, {"id": "b"}, {"x": 1}]})
        models = asyncio.run(providers.list_models(self.endpoint("openai", "/v1")))
        self.assertEqual([(m["model"], m["context_window"]) for m in models], [("a", 8000), ("b", None)])
        Upstream.routes["/v1/models"] = (200, "application/json", {"data": [{"id": "claude-1", "display_name": "Claude"}], "has_more": False})
        models = asyncio.run(providers.list_models(self.endpoint("anthropic")))
        self.assertEqual(models[0]["display_name"], "Claude")
        self.assertIn("limit=1000", Upstream.seen[-1]["path"])


if __name__ == "__main__":
    unittest.main()
