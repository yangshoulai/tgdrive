"""OpenAI Responses：显式请求思考摘要，转换工具调用，并保留不透明的加密续接项。"""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Awaitable, Callable

from .providers import Endpoint, ProviderError, Reply, ToolCall, ToolDef, _error_detail, _events, _open, _openai_headers, _openai_url, scrub

CONTINUATION_LIMIT = 8 * 1024 * 1024


def input_items(messages: list[dict]) -> list[dict]:
    result: list[dict] = []
    images: list[dict] = []

    def content(text: str, refs: list[dict]) -> list[dict]:
        return [{"type": "input_text", "text": text or " "},
                *[{"type": "input_image", "image_url": f"data:{image['mime']};base64,{base64.b64encode(image['data']).decode()}"}
                  for image in refs]]

    def flush_images() -> None:
        if images:
            result.append({"role": "user", "content": content("以上工具返回的图片：", images)})
            images.clear()

    for message in messages:
        role = message["role"]
        if role != "tool":
            flush_images()
        if role in ("system", "user"):
            result.append({"role": role, "content": content(message.get("content") or "", message.get("images") or [])})
        elif role == "assistant":
            # 这里仅重放服务端保留的加密项，可见思考文字不会进入请求。
            result.extend(message.get("_responses_items") or [])
            if message.get("content"):
                item = {"role": "assistant", "content": message["content"]}
                if message.get("_responses_phase") in ("commentary", "final_answer"):
                    item["phase"] = message["_responses_phase"]
                result.append(item)
            result.extend({"type": "function_call", "call_id": call["id"], "name": call["name"], "arguments": call["arguments"]}
                          for call in message.get("tool_calls") or [])
        elif role == "tool":
            result.append({"type": "function_call_output", "call_id": message["tool_call_id"], "output": message.get("content") or ""})
            images.extend(message.get("images") or [])
    flush_images()
    return result


async def chat_responses(endpoint: Endpoint, model: str, system: str, messages: list[dict], tools: list[ToolDef], *,
                         max_tokens: int | None, reply: Reply, started: float,
                         emit: Callable[[str], Awaitable[None]], think: Callable[[str], Awaitable[None]]) -> Reply:
    body = {"model": model, "instructions": system, "input": input_items(messages), "stream": True,
            "store": False, "reasoning": {"summary": "auto"}, "include": ["reasoning.encrypted_content"]}
    if tools:
        body["tools"] = [{"type": "function", "name": tool.name, "description": tool.description,
                          "parameters": tool.parameters, "strict": False} for tool in tools]
    if max_tokens:
        body["max_output_tokens"] = max_tokens
    request = await _open("POST", _openai_url(endpoint.base_url, "/responses"),
                          {"Content-Type": "application/json", "Accept": "text/event-stream", **_openai_headers(endpoint)},
                          json.dumps(body, ensure_ascii=False).encode(), endpoint.timeout)
    reply.status = request.response.status if request.response is not None else None
    pieces: dict[tuple[str, str, int], str] = {}
    calls: dict[str, dict] = {}
    continuation: dict[str, dict] = {}
    terminal = False

    async def text(kind: str, item_id: str, index: int, value: object, *, full: bool = False) -> None:
        if not isinstance(value, str) or not value:
            return
        key = (kind, item_id, index)
        previous = pieces.get(key, "")
        # done／completed 会重复给出全文；只补没有收到的尾部，不重复流式正文。
        delta = value[len(previous):] if full and value.startswith(previous) else "" if full and previous else value
        if not delta:
            return
        callback = think if kind == "reasoning" else emit
        if key not in pieces and any(saved[0] == kind for saved in pieces):
            await callback("\n\n")
        pieces[key] = previous + delta
        await callback(delta)

    async def item(value: object, index: int = 0) -> None:
        if not isinstance(value, dict):
            return
        item_id = str(value.get("id") or f"output-{index}")
        kind = value.get("type")
        if kind == "reasoning":
            for number, part in enumerate(value.get("summary") or []):
                if isinstance(part, dict) and part.get("type") == "summary_text":
                    await text("reasoning", item_id, number, part.get("text"), full=True)
            encrypted = value.get("encrypted_content")
            if isinstance(encrypted, str) and encrypted:
                continuation[item_id] = {"type": "reasoning", "id": item_id, "summary": [], "encrypted_content": encrypted}
                if sum(len(saved["encrypted_content"]) for saved in continuation.values()) > CONTINUATION_LIMIT:
                    raise ProviderError("模型服务返回的加密续接数据过大", code="bad_response")
        elif kind == "message":
            for number, part in enumerate(value.get("content") or []):
                if isinstance(part, dict):
                    await text("text", item_id, number, part.get("text") if part.get("type") == "output_text" else part.get("refusal"), full=True)
            if value.get("phase") in ("commentary", "final_answer"):
                reply.phase = value["phase"]
        elif kind == "function_call":
            saved = calls.setdefault(item_id, {"order": index, "id": "", "name": "", "arguments": ""})
            saved.update(id=value.get("call_id") or saved["id"], name=value.get("name") or saved["name"], order=index)
            if isinstance(value.get("arguments"), str):
                saved["arguments"] = value["arguments"]
            if reply.ttfb_ms is None:
                reply.ttfb_ms = int((time.monotonic() - started) * 1000)

    try:
        async for event, data in _events(request):
            if data == "[DONE]":
                break
            try:
                payload = json.loads(data)
            except ValueError:
                continue
            if not isinstance(payload, dict):
                continue
            kind = payload.get("type") or event
            response = payload.get("response")
            if isinstance(response, dict):
                reply.upstream_id = response.get("id") or reply.upstream_id
            if kind == "error" or kind == "response.failed":
                error = response.get("error") if isinstance(response, dict) else payload
                message, overflow = _error_detail(error or {})
                raise ProviderError(f"模型服务返回错误：{scrub(message)}", code="context_overflow" if overflow else "upstream_error")
            item_id = str(payload.get("item_id") or f"output-{payload.get('output_index', 0)}")
            if kind in ("response.reasoning_summary_text.delta", "response.reasoning_summary_text.done"):
                await text("reasoning", item_id, int(payload.get("summary_index") or 0),
                           payload.get("text") if kind.endswith(".done") else payload.get("delta"), full=kind.endswith(".done"))
            elif kind in ("response.output_text.delta", "response.output_text.done", "response.refusal.delta", "response.refusal.done"):
                await text("text", item_id, int(payload.get("content_index") or 0),
                           (payload.get("text") or payload.get("refusal")) if kind.endswith(".done") else payload.get("delta"), full=kind.endswith(".done"))
            elif kind in ("response.output_item.added", "response.output_item.done"):
                await item(payload.get("item"), int(payload.get("output_index") or 0))
            elif kind in ("response.function_call_arguments.delta", "response.function_call_arguments.done"):
                saved = calls.setdefault(item_id, {"order": int(payload.get("output_index") or 0), "id": "", "name": "", "arguments": ""})
                if kind.endswith(".done"):
                    if isinstance(payload.get("arguments"), str):
                        saved["arguments"] = payload["arguments"]
                elif isinstance(payload.get("delta"), str):
                    saved["arguments"] += payload["delta"]
            elif kind in ("response.completed", "response.incomplete") and isinstance(response, dict):
                terminal = True
                for index, value in enumerate(response.get("output") or []):
                    await item(value, index)
                usage = response.get("usage") or {}
                reply.input_tokens = int(usage.get("input_tokens") or 0)
                reply.output_tokens = int(usage.get("output_tokens") or 0)
                reply.cached_tokens = int((usage.get("input_tokens_details") or {}).get("cached_tokens") or 0)
                reply.finish = "length" if kind == "response.incomplete" else "tool_calls" if calls else "stop"
                break
        if not terminal:
            raise ProviderError("模型服务响应在完成前中断", code="stream_error", retryable=True)
    except ProviderError as exc:
        exc.status = exc.status or reply.status
        raise
    finally:
        request.close()
    reply.tool_calls = [ToolCall(value["id"] or key, value["name"], value["arguments"] or "{}")
                        for key, value in sorted(calls.items(), key=lambda pair: pair[1]["order"]) if value["name"]]
    reply.continuation = list(continuation.values())
    return reply
