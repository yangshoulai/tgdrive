"""Telegram Bot API 客户端。

默认传输使用 Python 标准库并放到线程池中，因此核心包不强制绑定某一个
HTTP 客户端。生产部署可以通过包装 transport 接入连接池；测试则可注入
内存 transport，不需要真实 Bot token。
"""

from __future__ import annotations

import asyncio
import http.client
import json
import mimetypes
import secrets
import threading
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlsplit


class TelegramError(Exception):
    """Telegram API 调用失败。"""

    def __init__(self, message: str, *, method: str = "", status: int | None = None,
                 error_code: int | None = None) -> None:
        super().__init__(message)
        self.method, self.status, self.error_code = method, status, error_code


class TelegramAuthError(TelegramError):
    pass


class TelegramNotFoundError(TelegramError):
    pass


class TelegramRateLimitError(TelegramError):
    def __init__(self, message: str, *, retry_after: float, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.retry_after = retry_after


class TelegramTransientError(TelegramError):
    pass


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes


class Transport(Protocol):
    async def request(self, method: str, url: str, headers: Mapping[str, str], body: bytes | None) -> HttpResponse: ...


class UrllibTransport:
    async def request(self, method: str, url: str, headers: Mapping[str, str], body: bytes | None) -> HttpResponse:
        def request_sync() -> HttpResponse:
            request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    return HttpResponse(response.status, dict(response.headers.items()), response.read())
            except urllib.error.HTTPError as exc:
                return HttpResponse(exc.code, dict(exc.headers.items()), exc.read())
            except (urllib.error.URLError, TimeoutError) as exc:
                raise TelegramTransientError(str(exc)) from exc
        return await asyncio.to_thread(request_sync)


@dataclass(frozen=True)
class FileInfo:
    file_id: str
    file_unique_id: str | None
    file_path: str


@dataclass(frozen=True)
class SentDocument:
    message_id: int
    file_id: str
    file_unique_id: str | None


class PooledTransport:
    """保持连接的 HTTP 传输：同一主机复用 TCP/TLS 连接，避免每次下载窗口都重新握手。

    遵循 HTTPS_PROXY / HTTP_PROXY / NO_PROXY 环境变量；HTTPS 经 HTTP 代理时使用 CONNECT 隧道。
    """

    MAX_IDLE_PER_HOST = 8

    def __init__(self, *, timeout: float = 60) -> None:
        self.timeout = timeout
        self._idle: dict[tuple[str, str, int], list[http.client.HTTPConnection]] = {}
        self._lock = threading.Lock()

    def _connect(self, scheme: str, host: str, port: int) -> http.client.HTTPConnection:
        proxy = None if urllib.request.proxy_bypass(host) else urllib.request.getproxies().get(scheme)
        if proxy:
            parts = urlsplit(proxy if "://" in proxy else f"http://{proxy}")
            proxy_host, proxy_port = parts.hostname or "", parts.port or (443 if parts.scheme == "https" else 80)
            if scheme == "https":
                connection: http.client.HTTPConnection = http.client.HTTPSConnection(proxy_host, proxy_port, timeout=self.timeout)
                connection.set_tunnel(host, port)
            else:
                connection = http.client.HTTPConnection(proxy_host, proxy_port, timeout=self.timeout)
                connection.set_tunnel(host, port)
            return connection
        cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
        return cls(host, port, timeout=self.timeout)

    READ_PIECE = 256 * 1024

    def _request_sync(self, method: str, url: str, headers: Mapping[str, str], body: bytes | None,
                      cancel: threading.Event | None = None) -> HttpResponse:
        parts = urlsplit(url)
        scheme, host = parts.scheme, parts.hostname or ""
        port = parts.port or (443 if scheme == "https" else 80)
        key = (scheme, host, port)
        target = parts.path + (f"?{parts.query}" if parts.query else "")
        for attempt in range(2):
            with self._lock:
                pool = self._idle.setdefault(key, [])
                connection, reused = (pool.pop(), True) if pool else (None, False)
            connection = connection or self._connect(scheme, host, port)
            try:
                connection.request(method, target, body=body, headers=dict(headers))
                response = connection.getresponse()
                data = self._read_body(response, cancel)
                if data is None:
                    # 调用方已取消（浏览器中断了预览请求）：丢弃这条读了一半的连接，不再继续下载。
                    connection.close()
                    raise TelegramTransientError("request cancelled")
            except (http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError) as exc:
                connection.close()
                # 复用的空闲连接可能已被服务器关闭：换新连接重试一次。
                if reused and attempt == 0:
                    continue
                raise TelegramTransientError(str(exc) or exc.__class__.__name__) from exc
            except (OSError, http.client.HTTPException) as exc:
                connection.close()
                raise TelegramTransientError(str(exc) or exc.__class__.__name__) from exc
            if response.will_close:
                connection.close()
            else:
                with self._lock:
                    pool = self._idle.setdefault(key, [])
                    if len(pool) < self.MAX_IDLE_PER_HOST:
                        pool.append(connection)
                    else:
                        connection.close()
            return HttpResponse(response.status, dict(response.getheaders()), data)
        raise TelegramTransientError("connection failed")

    def _read_body(self, response: http.client.HTTPResponse, cancel: threading.Event | None) -> bytes | None:
        """分段读取响应体，每段之间检查取消标记；被取消时返回 None。"""
        if cancel is None:
            return response.read()
        pieces: list[bytes] = []
        while not cancel.is_set():
            piece = response.read(self.READ_PIECE)
            if not piece:
                return b"".join(pieces)
            pieces.append(piece)
        return None

    async def request(self, method: str, url: str, headers: Mapping[str, str], body: bytes | None) -> HttpResponse:
        # 线程里的阻塞读取无法被 asyncio 取消；取消时设置标记，让线程在下一段读取前停下并关闭连接，
        # 避免被中断的预览请求继续占用 Telegram 带宽和线程池。
        cancel = threading.Event()
        try:
            return await asyncio.to_thread(self._request_sync, method, url, headers, body, cancel)
        except asyncio.CancelledError:
            cancel.set()
            raise

    def close(self) -> None:
        with self._lock:
            for pool in self._idle.values():
                for connection in pool:
                    connection.close()
            self._idle.clear()


_shared_transport: PooledTransport | None = None


def shared_transport() -> PooledTransport:
    """全部 Bot 共用一个连接池（Telegram API 与文件下载都在同一主机）。"""
    global _shared_transport
    if _shared_transport is None:
        _shared_transport = PooledTransport()
    return _shared_transport


class TelegramClient:
    def __init__(self, token: str, *, api_base: str = "https://api.telegram.org",
                 transport: Transport | None = None) -> None:
        if not token or any(ch.isspace() for ch in token):
            raise ValueError("invalid Telegram bot token")
        self.token = token
        self.api_base = api_base.rstrip("/")
        self.transport = transport or shared_transport()

    def _api_url(self, method: str) -> str:
        return f"{self.api_base}/bot{self.token}/{method}"

    async def _api(self, method: str, payload: Mapping[str, Any] | None = None) -> Any:
        body = json.dumps(payload or {}, separators=(",", ":")).encode()
        response = await self.transport.request("POST", self._api_url(method),
                                                {"Content-Type": "application/json"}, body)
        try:
            data = json.loads(response.body)
        except (ValueError, UnicodeDecodeError) as exc:
            raise TelegramTransientError("Telegram 返回了无效 JSON", method=method, status=response.status) from exc
        if not data.get("ok"):
            self._raise_api_error(method, response.status, data)
        return data.get("result")

    @staticmethod
    def _raise_api_error(method: str, status: int, data: Mapping[str, Any]) -> None:
        code = data.get("error_code")
        description = str(data.get("description", "Telegram API error"))
        parameters = data.get("parameters") or {}
        if code in (401, 403):
            raise TelegramAuthError(description, method=method, status=status, error_code=code)
        if code == 404:
            raise TelegramNotFoundError(description, method=method, status=status, error_code=code)
        if code == 429:
            raise TelegramRateLimitError(description, retry_after=float(parameters.get("retry_after", 1)),
                                          method=method, status=status, error_code=code)
        if code is not None and int(code) >= 500:
            raise TelegramTransientError(description, method=method, status=status, error_code=code)
        raise TelegramError(description, method=method, status=status, error_code=code)

    async def get_me(self) -> Mapping[str, Any]:
        return await self._api("getMe")

    async def get_chat(self, chat_id: int | str) -> Mapping[str, Any]:
        return await self._api("getChat", {"chat_id": chat_id})

    async def get_chat_member(self, chat_id: int | str, user_id: int) -> Mapping[str, Any]:
        return await self._api("getChatMember", {"chat_id": chat_id, "user_id": user_id})

    async def send_document(self, chat_id: int | str, data: bytes, *, filename: str = "blob.bin") -> SentDocument:
        boundary = "----tgdrive-" + secrets.token_hex(12)
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        parts = [
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat_id}\r\n".encode(),
            (f"--{boundary}\r\nContent-Disposition: form-data; name=\"document\"; filename=\"{filename}\"\r\n"
             f"Content-Type: {content_type}\r\n\r\n").encode() + data + b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
        response = await self.transport.request("POST", self._api_url("sendDocument"),
                                                {"Content-Type": f"multipart/form-data; boundary={boundary}"}, b"".join(parts))
        try:
            result = json.loads(response.body)
        except (ValueError, UnicodeDecodeError) as exc:
            raise TelegramTransientError("Telegram 返回了无效 JSON", method="sendDocument", status=response.status) from exc
        if not result.get("ok"):
            self._raise_api_error("sendDocument", response.status, result)
        message = result["result"]
        document = message.get("document") or {}
        return SentDocument(int(message["message_id"]), document["file_id"], document.get("file_unique_id"))

    async def get_file(self, file_id: str) -> FileInfo:
        result = await self._api("getFile", {"file_id": file_id})
        return FileInfo(file_id, result.get("file_unique_id"), result["file_path"])

    async def download_file(self, file_path: str, start: int | None = None, end: int | None = None) -> HttpResponse:
        headers: dict[str, str] = {}
        if start is not None or end is not None:
            left = "" if start is None else str(start)
            right = "" if end is None else str(end - 1)
            headers["Range"] = f"bytes={left}-{right}"
        url = f"{self.api_base}/file/bot{self.token}/{file_path.lstrip('/')}"
        return await self.transport.request("GET", url, headers, None)

    async def delete_message(self, chat_id: int | str, message_id: int) -> None:
        await self._api("deleteMessage", {"chat_id": chat_id, "message_id": message_id})
