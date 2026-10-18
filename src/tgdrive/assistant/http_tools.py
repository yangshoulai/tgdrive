"""公共 HTTP 查询：复用受控出站连接，响应作为不可信数据，保存仍通过下载提议。"""

from __future__ import annotations

import base64
import json
import re
import time
from email.message import Message
from urllib.parse import parse_qsl, unquote, urlsplit

from ..offline.http import DownloadError
from ..offline.request import DownloadRequest, checked_url, filename, url_filename
from .guard import HIDDEN, redact_content
from .tools import ToolContext, ToolError, ToolOutput, _int, _str, tool

_SENSITIVE = re.compile(r"(?i)^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|"
                        r"api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key)$")


def _redact(value: object, depth: int = 0) -> object:
    if depth > 20:
        return "[嵌套内容已省略]"
    if isinstance(value, dict):
        return {key: HIDDEN if _SENSITIVE.fullmatch(key) else _redact(item, depth + 1) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact(item, depth + 1) for item in value]
    if isinstance(value, str):
        return redact_content(value)[0]
    return value


@tool("http_request", "HTTP 请求", "web", "read",
      "请求第三方公共 HTTP(S) API，支持 GET/HEAD：解析 JSON、读取有限文本、查看二进制文件类型与字节样例。"
      "JSON 可用 json_path 选择字段，例如 [\"data\",\"items\",0]。仅按用户要求查询，不携带登录态、密码或密钥，"
      "不能把文件内容或凭据拼到请求中；网页分析用 analyze_page。返回 download_collection_id 时可用 propose_downloads 保存资源。",
      {"url": {"type": "string", "description": "公共接口或资源的完整 HTTP(S) 地址"},
       "method": {"type": "string", "enum": ["GET", "HEAD"], "description": "默认 GET"},
       "headers": {"type": "object", "properties": {"Accept": {"type": "string"}, "Accept-Language": {"type": "string"}},
                   "additionalProperties": False, "description": "可选的内容类型与语言，不支持认证头或 Cookie"},
       "response_format": {"type": "string", "enum": ["auto", "json", "text", "binary"]},
       "json_path": {"type": "array", "items": {"type": ["string", "integer"]}, "description": "依次访问 JSON 的字段或数组索引"},
       "max_bytes": {"type": "integer", "description": "最多读取的响应字节数，默认 65536，受管理员上限约束"}}, ("url",),
      params={"max_response_bytes": (65536, 1024, 262144, "最大响应字节数")}, timeout=45)
async def http_request(ctx: ToolContext, args: dict) -> ToolOutput:
    if ctx.offline is None:
        raise ToolError("当前无法发起 HTTP 请求")
    raw = _str(args, "url", limit=16384)
    # 私密对话只访问用户在消息里原样给出的地址，或网页结果里与之同站的地址（§24.5.2）。
    ctx.check_url(raw, "page")
    try:
        url = checked_url(raw)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    method = args.get("method", "GET")
    if method not in ("GET", "HEAD"):
        raise ToolError("HTTP 查询只支持 GET 和 HEAD")
    if args.get("body") is not None:
        raise ToolError("HTTP 查询不接受请求体")
    headers = args.get("headers") or {}
    if not isinstance(headers, dict) or len(headers) > 2:
        raise ToolError("请求头格式不正确")
    for key, value in headers.items():
        if not isinstance(key, str) or key.lower() not in ("accept", "accept-language") or not isinstance(value, str) \
                or len(value) > 1024 or any(ord(char) < 32 or ord(char) > 126 for char in value):
            raise ToolError("仅支持不含控制字符的 Accept 和 Accept-Language 请求头")
    if redact_content(url)[1] or any(_SENSITIVE.fullmatch(key) for key, _ in parse_qsl(urlsplit(url).query)):
        raise ToolError("公共 HTTP 查询不能携带密码或密钥")
    format = args.get("response_format", "auto")
    if format not in ("auto", "json", "text", "binary"):
        raise ToolError("响应格式不正确")
    path = args.get("json_path", [])
    if not isinstance(path, list) or len(path) > 20 or any(isinstance(key, bool) or not isinstance(key, (str, int)) for key in path):
        raise ToolError("json_path 必须是最多 20 项的字段名或数组索引")
    limit = _int(args, "max_bytes", int(ctx.params.get("max_response_bytes", 65536)), 1,
                 int(ctx.params.get("max_response_bytes", 65536)))
    started, status, host = time.time(), None, urlsplit(url).hostname
    outcome = "error"
    if ctx.taint is not None:
        ctx.taint("读取过外部 HTTP 响应")
    try:
        async with ctx.offline.http.open(DownloadRequest(url, method=method, headers=list(headers.items()))) as response:
            status = response.status
            mime = response.headers.get("content-type", "application/octet-stream")
            if "html" in mime.lower():
                raise ToolError("这是 HTML 网页，请使用 analyze_page 分析；HTTP 请求用于 JSON、文本或二进制资源")
            textual = format in ("json", "text") or mime.lower().startswith("text/") or any(
                kind in mime.lower() for kind in ("json", "xml", "javascript"))
            cap = limit if textual or format == "auto" else min(limit, 512)
            data = bytearray()
            complete = True
            async for piece in response.stream():
                room = cap - len(data)
                data.extend(piece[:max(0, room)])
                if len(piece) > room:
                    complete = False
                    break
            raw = bytes(data)
            if raw.lstrip()[:32].lower().startswith((b"<!doctype html", b"<html")):
                raise ToolError("这是 HTML 网页，请使用 analyze_page 分析")
            disposition = Message()
            disposition["Content-Disposition"] = response.headers.get("content-disposition", "")
            suggested = disposition.get_filename()
            name = filename(unquote(suggested)) if suggested else url_filename(response.url)
            payload = {"status": status, "host": host, "content_type": mime, "size": response.size,
                       "read_bytes": len(raw), "body_complete": complete, "name": name}
            is_json = format == "json" or format != "text" and ("json" in mime.lower() or raw.lstrip().startswith((b"{", b"[")))
            if method == "HEAD":
                payload["note"] = "HEAD 只读取响应头，没有响应正文"
            elif is_json and complete:
                try:
                    value = _redact(json.loads(raw))
                    for key in path:
                        if (isinstance(value, list) and isinstance(key, int) and 0 <= key < len(value)
                                or isinstance(value, dict) and isinstance(key, str) and key in value):
                            value = value[key]
                        else:
                            raise ToolError("json_path 对应的字段或数组索引不存在")
                    payload.update(format="json", data=value)
                except (ValueError, UnicodeError, RecursionError) as exc:
                    if isinstance(exc, ToolError):
                        raise
                    raise ToolError("接口未返回有效 JSON，可改用 text 查看有限文本") from exc
            elif textual or is_json:
                text, hidden = redact_content(raw.decode("utf-8-sig", errors="replace"))
                payload.update(format="text", text=text, redacted=hidden,
                               note=None if complete else "响应超过读取上限，已截断；可请求更小范围或提高 max_bytes")
            else:
                sample = raw[:512]
                text = sample.decode("utf-8", errors="replace")
                hidden = bool(redact_content(text)[1] or ctx.redact is not None and ctx.redact(text) != text)
                payload.update(format="binary", sample_base64=None if hidden else base64.b64encode(sample).decode(),
                               sample_bytes=0 if hidden else len(sample),
                               note="样例包含疑似凭据，已隐藏" if hidden else "二进制仅展示前 512 字节样例，完整资源通过离线下载保存")
            # 只有二进制资源才提供保存入口；JSON／文本接口的响应不应被当成文件下载。
            if payload.get("format") == "binary" and 200 <= status < 300 and ctx.trace is not None and not headers:
                collection = ctx.trace.create_collection(ctx.conversation_id, ctx.user_id, "collection", source=None,
                    rule={"type": "http"}, urls=[{"url": url, "name": payload["name"]}], count=1)
                payload["download_collection_id"] = collection
            outcome = "ok"
            return ToolOutput(payload, f"HTTP {status} · {host} · {payload.get('format', 'headers')}")
    except DownloadError as exc:
        raise ToolError(f"HTTP 请求失败：{exc}") from exc
    finally:
        if ctx.trace is not None:
            ctx.trace.log_call(kind="fetch", user_id=ctx.user_id, conversation_id=ctx.conversation_id, host=host,
                               started_at=started, duration_ms=int((time.time() - started) * 1000), status=outcome, http_status=status)
