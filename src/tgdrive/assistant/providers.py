"""模型服务适配：OpenAI 兼容（/chat/completions）与 Anthropic（/v1/messages），均为流式请求。

渠道地址只能由管理员配置（可以是本机 Ollama），所以这里不走离线下载的 SafeHttpClient；
错误信息一律脱敏后才离开本模块：不含 API Key、请求头、URL 查询串与长令牌。
"""

from __future__ import annotations

import asyncio
import http.client
import json
import re
import ssl
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from urllib.parse import urlsplit


class ProviderError(Exception):
    """模型服务返回错误或无法连接。message 已脱敏，可以展示与写入调用日志。"""

    def __init__(self, message: str, *, status: int | None = None, code: str = "upstream_error", retryable: bool = False):
        super().__init__(message)
        self.status, self.code, self.retryable = status, code, retryable


_SECRETISH = re.compile(r"(?i)(sk-[A-Za-z0-9_\-]{6,}|bearer\s+\S+|api[-_]?key\S*|[A-Za-z0-9_\-]{32,})")


def scrub(text: object, limit: int = 300) -> str:
    """移除形如密钥的长串与查询参数，截断到 limit 个字符。"""
    value = str(text or "")
    value = re.sub(r"(?i)(authorization|x-api-key|api[-_]?key|proxy-authorization)\s*[\"\']?\s*[:=]\s*[\"\']?[^\r\n,;]+", "•••", value)
    value = re.sub(r"https?://\S+", lambda m: m.group(0).split("?", 1)[0], value)
    value = _SECRETISH.sub("•••", value)
    value = " ".join(value.split())
    return value[:limit]


@dataclass
class ToolDef:
    name: str
    description: str
    parameters: dict


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str  # 原始 JSON 文本，由调用方解析与校验


@dataclass
class Reply:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    upstream_id: str | None = None
    ttfb_ms: int | None = None
    status: int | None = None


@dataclass
class Endpoint:
    kind: str
    base_url: str
    api_key: str | None
    headers: dict[str, str]
    timeout: int


# ---------- HTTP ----------

class _Request:
    """在线程中执行一次 HTTP 请求；close() 可从事件循环线程调用以中止读取。"""

    def __init__(self, method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float):
        self.method, self.url, self.headers, self.body, self.timeout = method, url, headers, body, timeout
        self.conn: http.client.HTTPConnection | None = None
        self.response: http.client.HTTPResponse | None = None
        self._closed = threading.Event()

    def open(self) -> int:
        parts = urlsplit(self.url)
        port = parts.port
        if parts.scheme == "https":
            self.conn = http.client.HTTPSConnection(parts.hostname, port, timeout=self.timeout, context=ssl.create_default_context())
        else:
            self.conn = http.client.HTTPConnection(parts.hostname, port, timeout=self.timeout)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        self.conn.request(self.method, path, body=self.body, headers=self.headers)
        self.response = self.conn.getresponse()
        return self.response.status

    def read(self, size: int = 16384) -> bytes:
        if self._closed.is_set() or self.response is None:
            return b""
        return self.response.read1(size)

    def read_all(self, limit: int = 4 * 1024 * 1024) -> bytes:
        data = bytearray()
        while len(data) < limit:
            chunk = self.read(65536)
            if not chunk:
                break
            data.extend(chunk)
        return bytes(data)

    def close(self) -> None:
        self._closed.set()
        if self.conn is not None:
            try:
                self.conn.close()
            except OSError:
                pass


async def _open(method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float) -> _Request:
    request = _Request(method, url, headers, body, timeout)
    try:
        status = await asyncio.to_thread(request.open)
    except asyncio.CancelledError:
        request.close()
        raise
    except ssl.SSLCertVerificationError as exc:
        request.close()
        raise ProviderError("模型服务的 HTTPS 证书校验失败", code="tls_error") from exc
    except (TimeoutError, OSError, http.client.HTTPException) as exc:
        request.close()
        raise ProviderError(f"无法连接模型服务：{type(exc).__name__}", code="connect_error", retryable=True) from exc
    if status >= 400:
        try:
            raw = await asyncio.to_thread(request.read_all, 65536)
        except (OSError, http.client.HTTPException):
            raw = b""
        finally:
            request.close()
        raise _status_error(status, raw)
    return request


def _status_error(status: int, raw: bytes) -> ProviderError:
    message = ""
    try:
        data = json.loads(raw)
        error = data.get("error") if isinstance(data, dict) else None
        if isinstance(error, dict):
            message = error.get("message") or error.get("type") or ""
        elif isinstance(error, str):
            message = error
        elif isinstance(data, dict):
            message = data.get("message") or data.get("detail") or ""
    except ValueError:
        message = raw[:200].decode("utf-8", "replace")
    labels = {401: "API Key 无效或未授权", 403: "没有权限访问该模型", 404: "接口地址或模型不存在", 429: "请求过于频繁或额度不足"}
    prefix = labels.get(status, f"模型服务返回错误（HTTP {status}）")
    text = f"{prefix}：{scrub(message)}" if message else prefix
    code = {401: "unauthorized", 403: "forbidden", 404: "not_found", 429: "rate_limited"}.get(status, "upstream_error")
    return ProviderError(text, status=status, code=code, retryable=status in (408, 425, 429, 500, 502, 503, 504))


async def _lines(request: _Request):
    """把响应体切成行（SSE），每次在线程中读取一块。"""
    buffer = b""
    while True:
        try:
            chunk = await asyncio.to_thread(request.read)
        except (TimeoutError, OSError, http.client.HTTPException) as exc:
            raise ProviderError(f"模型服务响应中断：{type(exc).__name__}", code="stream_error", retryable=True) from exc
        if not chunk:
            break
        buffer += chunk
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            yield line.rstrip(b"\r").decode("utf-8", "replace")
        if len(buffer) > 4 * 1024 * 1024:
            raise ProviderError("模型服务返回了过长的数据行", code="stream_error")
    if buffer:
        yield buffer.decode("utf-8", "replace")


async def _events(request: _Request):
    """解析 SSE：产出 (event, data) 二元组。"""
    event, data = "", []
    async for line in _lines(request):
        if not line:
            if data:
                yield event, "\n".join(data)
            event, data = "", []
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
    if data:
        yield event, "\n".join(data)


async def _get_json(url: str, headers: dict[str, str], timeout: float) -> object:
    request = await _open("GET", url, {"Accept": "application/json", **headers}, None, timeout)
    try:
        raw = await asyncio.to_thread(request.read_all)
    finally:
        request.close()
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise ProviderError("模型服务返回的不是 JSON", code="bad_response") from exc


# ---------- 适配 ----------

def _openai_url(base: str, path: str) -> str:
    return base.rstrip("/") + path


def _anthropic_url(base: str, path: str) -> str:
    base = base.rstrip("/")
    return base + path if base.endswith("/v1") else base + "/v1" + path


def _openai_headers(endpoint: Endpoint) -> dict[str, str]:
    headers = {**endpoint.headers}
    if endpoint.api_key:
        headers["Authorization"] = f"Bearer {endpoint.api_key}"
    return headers


def _anthropic_headers(endpoint: Endpoint) -> dict[str, str]:
    headers = {"anthropic-version": "2023-06-01", **endpoint.headers}
    if endpoint.api_key:
        headers["x-api-key"] = endpoint.api_key
    return headers


async def list_models(endpoint: Endpoint) -> list[dict]:
    """返回 [{model, display_name, context_window}]，按上游顺序。"""
    if endpoint.kind == "openai":
        data = await _get_json(_openai_url(endpoint.base_url, "/models"), _openai_headers(endpoint), endpoint.timeout)
        items = data.get("data") if isinstance(data, dict) else data if isinstance(data, list) else None
        if not isinstance(items, list):
            raise ProviderError("模型列表格式无法识别", code="bad_response")
        result = []
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                window = item.get("context_length") or item.get("context_window")
                result.append({"model": item["id"][:200], "display_name": None,
                               "context_window": window if isinstance(window, int) and window > 0 else None})
        return result
    result, after = [], None
    for _ in range(20):
        url = _anthropic_url(endpoint.base_url, "/models?limit=1000" + (f"&after_id={after}" if after else ""))
        data = await _get_json(url, _anthropic_headers(endpoint), endpoint.timeout)
        if not isinstance(data, dict) or not isinstance(data.get("data"), list):
            raise ProviderError("模型列表格式无法识别", code="bad_response")
        for item in data["data"]:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                name = item.get("display_name")
                result.append({"model": item["id"][:200], "display_name": name[:200] if isinstance(name, str) else None,
                               "context_window": None})
        if not data.get("has_more") or not isinstance(data.get("last_id"), str):
            break
        after = data["last_id"]
    return result


def _openai_messages(system: str, messages: list[dict]) -> list[dict]:
    result: list[dict] = [{"role": "system", "content": system}]
    for message in messages:
        role = message["role"]
        if role == "system":
            result.append({"role": "system", "content": message["content"]})
        elif role == "user":
            result.append({"role": "user", "content": message["content"]})
        elif role == "assistant":
            item: dict = {"role": "assistant", "content": message.get("content") or None}
            if message.get("tool_calls"):
                item["tool_calls"] = [{"id": call["id"], "type": "function",
                                       "function": {"name": call["name"], "arguments": call["arguments"]}}
                                      for call in message["tool_calls"]]
            result.append(item)
        elif role == "tool":
            result.append({"role": "tool", "tool_call_id": message["tool_call_id"], "content": message["content"]})
    return result


def _anthropic_messages(messages: list[dict]) -> tuple[list[dict], str]:
    """Anthropic 要求 user／assistant 交替：连续的 user（含工具结果）合并成一条。额外的 system 消息拼进系统提示。"""
    result: list[dict] = []
    extra_system: list[str] = []

    def push(role: str, blocks: list[dict]) -> None:
        if result and result[-1]["role"] == role:
            result[-1]["content"].extend(blocks)
        else:
            result.append({"role": role, "content": blocks})

    for message in messages:
        role = message["role"]
        if role == "system":
            extra_system.append(message["content"])
        elif role == "user":
            push("user", [{"type": "text", "text": message["content"] or " "}])
        elif role == "tool":
            push("user", [{"type": "tool_result", "tool_use_id": message["tool_call_id"], "content": message["content"]}])
        elif role == "assistant":
            blocks: list[dict] = []
            if message.get("content"):
                blocks.append({"type": "text", "text": message["content"]})
            for call in message.get("tool_calls") or []:
                try:
                    arguments = json.loads(call["arguments"] or "{}")
                except ValueError:
                    arguments = {}
                blocks.append({"type": "tool_use", "id": call["id"], "name": call["name"],
                               "input": arguments if isinstance(arguments, dict) else {}})
            push("assistant", blocks or [{"type": "text", "text": " "}])
    return result, "\n\n".join(extra_system)


async def chat(endpoint: Endpoint, model: str, system: str, messages: list[dict], tools: list[ToolDef], *,
               max_tokens: int | None, on_text: Callable[[str], Awaitable[None]] | None = None) -> Reply:
    """流式调用模型，逐段回调文本，返回完整回复（含工具调用与用量）。"""
    started = time.monotonic()
    reply = Reply()

    async def emit(text: str) -> None:
        if not text:
            return
        if reply.ttfb_ms is None:
            reply.ttfb_ms = int((time.monotonic() - started) * 1000)
        reply.text += text
        if on_text is not None:
            await on_text(text)

    if endpoint.kind == "openai":
        body: dict = {"model": model, "messages": _openai_messages(system, messages), "stream": True,
                      "stream_options": {"include_usage": True}}
        if tools:
            body["tools"] = [{"type": "function", "function": {"name": t.name, "description": t.description,
                                                                "parameters": t.parameters}} for t in tools]
        if max_tokens:
            body["max_tokens"] = max_tokens
        url, headers = _openai_url(endpoint.base_url, "/chat/completions"), _openai_headers(endpoint)
        try:
            request = await _open("POST", url, {"Content-Type": "application/json", "Accept": "text/event-stream", **headers},
                                  json.dumps(body, ensure_ascii=False).encode(), endpoint.timeout)
        except ProviderError as exc:
            # 少数兼容实现不认识 stream_options：去掉后重试一次。
            if exc.status != 400 or "stream_options" not in str(exc):
                raise
            body.pop("stream_options")
            request = await _open("POST", url, {"Content-Type": "application/json", "Accept": "text/event-stream", **headers},
                                  json.dumps(body, ensure_ascii=False).encode(), endpoint.timeout)
        calls: dict[int, dict] = {}
        try:
            async for _, data in _events(request):
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except ValueError:
                    continue
                if not isinstance(chunk, dict):
                    continue
                if isinstance(chunk.get("error"), dict):
                    raise ProviderError(f"模型服务返回错误：{scrub(chunk['error'].get('message'))}", code="upstream_error")
                reply.upstream_id = reply.upstream_id or (chunk.get("id") if isinstance(chunk.get("id"), str) else None)
                usage = chunk.get("usage")
                if isinstance(usage, dict):
                    reply.input_tokens = int(usage.get("prompt_tokens") or 0)
                    reply.output_tokens = int(usage.get("completion_tokens") or 0)
                    details = usage.get("prompt_tokens_details")
                    if isinstance(details, dict):
                        reply.cached_tokens = int(details.get("cached_tokens") or 0)
                for choice in chunk.get("choices") or []:
                    if not isinstance(choice, dict):
                        continue
                    delta = choice.get("delta") or {}
                    if isinstance(delta.get("content"), str):
                        await emit(delta["content"])
                    for call in delta.get("tool_calls") or []:
                        if not isinstance(call, dict):
                            continue
                        slot = calls.setdefault(int(call.get("index") or 0), {"id": "", "name": "", "arguments": ""})
                        if reply.ttfb_ms is None:
                            reply.ttfb_ms = int((time.monotonic() - started) * 1000)
                        slot["id"] = call.get("id") or slot["id"]
                        function = call.get("function") or {}
                        slot["name"] += function.get("name") or ""
                        slot["arguments"] += function.get("arguments") or ""
                    if choice.get("finish_reason"):
                        reply.finish = str(choice["finish_reason"])
        finally:
            request.close()
        reply.tool_calls = [ToolCall(slot["id"] or f"call_{index}", slot["name"], slot["arguments"])
                            for index, slot in sorted(calls.items()) if slot["name"]]
        return reply

    converted, extra = _anthropic_messages(messages)
    body = {"model": model, "system": system + ("\n\n" + extra if extra else ""), "messages": converted,
            "max_tokens": max_tokens or 4096, "stream": True}
    if tools:
        body["tools"] = [{"name": t.name, "description": t.description, "input_schema": t.parameters} for t in tools]
    request = await _open("POST", _anthropic_url(endpoint.base_url, "/messages"),
                          {"Content-Type": "application/json", "Accept": "text/event-stream", **_anthropic_headers(endpoint)},
                          json.dumps(body, ensure_ascii=False).encode(), endpoint.timeout)
    blocks: dict[int, dict] = {}
    try:
        async for event, data in _events(request):
            try:
                payload = json.loads(data)
            except ValueError:
                continue
            if not isinstance(payload, dict):
                continue
            kind = payload.get("type") or event
            if kind == "error":
                error = payload.get("error") or {}
                raise ProviderError(f"模型服务返回错误：{scrub(error.get('message') if isinstance(error, dict) else error)}",
                                    code="upstream_error", retryable=isinstance(error, dict) and error.get("type") == "overloaded_error")
            if kind == "message_start":
                message = payload.get("message") or {}
                reply.upstream_id = message.get("id")
                usage = message.get("usage") or {}
                reply.input_tokens = int(usage.get("input_tokens") or 0) + int(usage.get("cache_creation_input_tokens") or 0) \
                    + int(usage.get("cache_read_input_tokens") or 0)
                reply.cached_tokens = int(usage.get("cache_read_input_tokens") or 0)
                reply.output_tokens = int(usage.get("output_tokens") or 0)
            elif kind == "content_block_start":
                block = payload.get("content_block") or {}
                index = int(payload.get("index") or 0)
                if block.get("type") == "tool_use":
                    blocks[index] = {"id": block.get("id") or f"toolu_{index}", "name": block.get("name") or "", "arguments": ""}
                    if reply.ttfb_ms is None:
                        reply.ttfb_ms = int((time.monotonic() - started) * 1000)
                elif block.get("type") == "text" and block.get("text"):
                    await emit(block["text"])
            elif kind == "content_block_delta":
                delta = payload.get("delta") or {}
                index = int(payload.get("index") or 0)
                if delta.get("type") == "text_delta":
                    await emit(delta.get("text") or "")
                elif delta.get("type") == "input_json_delta" and index in blocks:
                    blocks[index]["arguments"] += delta.get("partial_json") or ""
            elif kind == "message_delta":
                delta = payload.get("delta") or {}
                if delta.get("stop_reason"):
                    reply.finish = str(delta["stop_reason"])
                usage = payload.get("usage") or {}
                if usage.get("output_tokens") is not None:
                    reply.output_tokens = int(usage["output_tokens"])
            elif kind == "message_stop":
                break
    finally:
        request.close()
    reply.tool_calls = [ToolCall(slot["id"], slot["name"], slot["arguments"] or "{}")
                        for _, slot in sorted(blocks.items()) if slot["name"]]
    return reply
