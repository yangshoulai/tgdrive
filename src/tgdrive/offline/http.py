"""带背压的 HTTP/1.1 客户端。每次连接与跳转都验证并固定公网 IP。"""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import re
import socket
import ssl
import struct
import zlib
from contextlib import asynccontextmanager
from urllib.parse import quote, unquote, urljoin, urlsplit

from .request import DownloadRequest, checked_url


class DownloadError(ValueError):
    """可以安全展示的错误；禁止携带来源 URL、响应正文或凭据。"""


class TransientError(DownloadError):
    """连接重置、超时等网络抖动；调用方可以安全重试，内容错误和认证失败不属于此类。"""


class ExpiredMedia(DownloadError):
    """平台媒体地址失效或无权访问，需要重新解析。"""


RETRY_STATUS = frozenset((408, 425, 429, 500, 502, 503, 504))


def status_error(status: int, message: str) -> DownloadError:
    """来源返回的非预期状态：限流和服务端临时故障可重试，其余按内容或权限错误处理。"""
    return (TransientError if status in RETRY_STATUS else DownloadError)(message)


def _tls_error(exc: BaseException, message: str) -> DownloadError:
    # 证书校验失败重试也不会成功，不能归为网络抖动。
    if isinstance(exc, ssl.SSLCertVerificationError):
        return DownloadError("来源的 HTTPS 证书校验失败，请检查链接")
    return TransientError(message)


def origin(url: str) -> tuple[str, str, int]:
    parts = urlsplit(url)
    return parts.scheme, parts.hostname.lower(), parts.port or (443 if parts.scheme == "https" else 80)


def public_ip(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    if not ip.is_global or ip.is_multicast or ip.is_reserved:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return public_ip(str(ip.ipv4_mapped))
        # 禁止可把公网 IPv6 映射到内部 IPv4 的过渡机制。
        if any(ip in ipaddress.ip_network(net) for net in ("64:ff9b::/96", "64:ff9b:1::/48", "2002::/16", "2001::/32")):
            return False
    return True


_INTERNAL_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp", ".localdomain")


def proxied_host(host: str) -> None:
    """代理负责 DNS 时无法固定 IP；至少拒绝字面内网地址和明显的内部主机名。"""
    host = host.lower().rstrip(".")
    try:
        address = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        address = None
    if address is not None:
        if not public_ip(str(address)):
            raise DownloadError("下载地址必须指向公网，不能访问本机、内网或云服务元数据地址")
        return
    # 部分解析器把 2130706433、0x7f.1 这类数字主机名当作 IPv4。
    if "." not in host or host == "localhost" or host.endswith(_INTERNAL_SUFFIXES) \
            or re.fullmatch(r"(?:0x[0-9a-f]*|[0-9]+)(?:\.(?:0x[0-9a-f]*|[0-9]+))*", host):
        raise DownloadError("下载地址必须是公网域名，不能访问本机或内网主机名")


def proxy_parts(value: str):
    """返回 (协议, 主机, 端口, 用户名, 密码)；格式不正确时抛出 ValueError。"""
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 33 or ord(c) == 127 for c in value):
        raise ValueError("下载代理地址格式不正确")
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError as exc:
        raise ValueError("下载代理地址或端口不正确") from exc
    scheme = parts.scheme.lower()
    if scheme not in ("http", "socks5", "socks5h") or not parts.hostname or port is None:
        raise ValueError("下载代理须为 http://主机:端口 或 socks5://主机:端口")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ValueError("下载代理地址不能包含路径或参数")
    user = unquote(parts.username) if parts.username is not None else None
    password = unquote(parts.password) if parts.password is not None else None
    if user is not None and (len(user.encode()) > 255 or len((password or "").encode()) > 255):
        raise ValueError("下载代理的用户名和密码均不能超过 255 字节")
    return scheme, parts.hostname, port, user, password


class HttpResponse:
    def __init__(self, reader, writer, status: int, headers: dict[str, str], url: str, method: str, raw_headers=None):
        self.reader, self.writer = reader, writer
        self.status, self.headers, self.url, self.method = status, headers, url, method
        self.raw_headers = raw_headers or list(headers.items())
        self.encoding = headers.get("content-encoding", "identity").lower().strip()
        self.length = None
        if "content-length" in headers:
            try:
                self.length = int(headers["content-length"])
                if not 0 <= self.length < 2**63:
                    raise ValueError()
            except ValueError as exc:
                raise DownloadError("来源返回了不合法的文件长度") from exc
        transfer = headers.get("transfer-encoding", "").lower()
        if transfer not in ("", "chunked"):
            raise DownloadError("来源使用了不支持的 HTTP 传输编码")
        if transfer and self.length is not None:
            raise DownloadError("来源同时声明了冲突的 HTTP 文件长度")
        self.chunked = transfer == "chunked"

    @property
    def size(self) -> int | None:
        return self.length if self.encoding in ("", "identity") else None

    async def _read(self, count: int, *, exact=False):
        try:
            async with asyncio.timeout(30):
                return await (self.reader.readexactly(count) if exact else self.reader.read(count))
        except (TimeoutError, asyncio.IncompleteReadError) as exc:
            raise TransientError("来源连接超时或文件传输提前中断，可以稍后继续") from exc

    async def _line(self):
        try:
            async with asyncio.timeout(30):
                line = await self.reader.readline()
            if not line or len(line) > 8192 or not line.endswith(b"\r\n"):
                raise DownloadError("来源返回了不合法的 HTTP 数据")
            return line
        except (TimeoutError, ValueError) as exc:
            if isinstance(exc, TimeoutError):
                raise TransientError("来源响应超时，可以稍后继续") from exc
            raise DownloadError("来源返回了不合法的 HTTP 数据") from exc

    async def _raw(self):
        if self.method == "HEAD" or self.status in (204, 304):
            return
        if self.chunked:
            while True:
                line = (await self._line()).split(b";", 1)[0].strip()
                if not re.fullmatch(rb"[0-9a-fA-F]{1,16}", line):
                    raise DownloadError("来源返回了不合法的分块长度")
                remaining = int(line, 16)
                if not remaining:
                    trailer_size = 0
                    while True:
                        trailer = await self._line()
                        trailer_size += len(trailer)
                        if trailer_size > 32768:
                            raise DownloadError("来源响应尾部过大")
                        if trailer == b"\r\n":
                            return
                while remaining:
                    piece = await self._read(min(remaining, 65536), exact=True)
                    remaining -= len(piece)
                    yield piece
                if await self._read(2, exact=True) != b"\r\n":
                    raise DownloadError("来源返回了不合法的分块边界")
        elif self.length is not None:
            remaining = self.length
            while remaining:
                piece = await self._read(min(remaining, 65536), exact=True)
                remaining -= len(piece)
                yield piece
        else:
            while piece := await self._read(65536):
                yield piece

    async def stream(self):
        if self.encoding in ("", "identity"):
            async for piece in self._raw():
                yield piece
            return
        if self.encoding not in ("gzip", "deflate"):
            raise DownloadError("来源使用了不支持的响应压缩格式，请移除 Accept-Encoding 请求头")
        decoder = zlib.decompressobj(31 if self.encoding == "gzip" else 15)
        try:
            async for piece in self._raw():
                pending = piece
                while pending:
                    output = decoder.decompress(pending, 65536)
                    pending = decoder.unconsumed_tail
                    if output:
                        yield output
                    if decoder.unused_data:
                        raise DownloadError("来源压缩数据包含不支持的额外内容")
            if not decoder.eof:
                raise DownloadError("来源压缩数据不完整，可以重新下载")
        except zlib.error as exc:
            raise DownloadError("来源压缩数据校验失败") from exc

    async def read(self, limit: int = 2 * 1024 * 1024) -> bytes:
        pieces, size = [], 0
        async for piece in self.stream():
            size += len(piece)
            if size > limit:
                raise DownloadError("播放列表超过 2 MB，无法解析")
            pieces.append(piece)
        return b"".join(pieces)


class SafeHttpClient:
    def __init__(self, proxy=None):
        self.tls = ssl.create_default_context()
        # 可调用对象，每次连接读取管理员当前的代理配置；空字符串表示直连。
        self.proxy = proxy

    async def _tunnel(self, proxy: str, host: str, port: int):
        scheme, proxy_host, proxy_port, user, password = proxy_parts(proxy)
        try:
            async with asyncio.timeout(15):
                reader, writer = await asyncio.open_connection(proxy_host, proxy_port, limit=65536)
        except (OSError, TimeoutError) as exc:
            raise TransientError("无法连接下载代理，请检查系统设置中的代理地址") from exc
        try:
            async with asyncio.timeout(15):
                if scheme == "http":
                    authority = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
                    lines = [f"CONNECT {authority} HTTP/1.1", f"Host: {authority}"]
                    if user is not None:
                        token = base64.b64encode(f"{user}:{password or ''}".encode()).decode()
                        lines.append(f"Proxy-Authorization: Basic {token}")
                    writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
                    await writer.drain()
                    block = await reader.readuntil(b"\r\n\r\n")
                    match = re.match(rb"HTTP/1\.[01] ([0-9]{3})", block)
                    if not match or not 200 <= int(match[1]) < 300:
                        status = match[1].decode() if match else "?"
                        raise (TransientError if status in ("502", "503", "504") else DownloadError)(f"下载代理拒绝连接（HTTP {status}），请检查代理地址与认证信息")
                else:
                    writer.write(b"\x05\x02\x00\x02" if user is not None else b"\x05\x01\x00")
                    await writer.drain()
                    version, method = await reader.readexactly(2)
                    if version != 5 or method not in (0, 2) or method == 2 and user is None:
                        raise DownloadError("下载代理不支持所需的 SOCKS5 认证方式")
                    if method == 2:
                        name, secret = user.encode(), (password or "").encode()
                        writer.write(bytes([1, len(name)]) + name + bytes([len(secret)]) + secret)
                        await writer.drain()
                        if (await reader.readexactly(2))[1] != 0:
                            raise DownloadError("下载代理的用户名或密码不正确")
                    try:
                        address = ipaddress.ip_address(host)
                        target = (b"\x01" if address.version == 4 else b"\x04") + address.packed
                    except ValueError:
                        encoded = host.encode("idna")
                        target = b"\x03" + bytes([len(encoded)]) + encoded
                    writer.write(b"\x05\x01\x00" + target + struct.pack(">H", port))
                    await writer.drain()
                    _, reply, _, kind = await reader.readexactly(4)
                    if reply != 0:
                        raise (TransientError if reply in (1, 3, 4, 6) else DownloadError)(f"下载代理无法连接来源（SOCKS5 错误 {reply}），请检查链接或代理规则")
                    if kind not in (1, 3, 4):
                        raise DownloadError("下载代理返回了不合法的 SOCKS5 响应")
                    await reader.readexactly({1: 4, 4: 16}.get(kind) or (await reader.readexactly(1))[0])
                    await reader.readexactly(2)
            return reader, writer
        except BaseException as exc:
            writer.close()
            if isinstance(exc, (OSError, TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError)):
                raise TransientError("下载代理连接中断或超时，请检查代理是否可用") from exc
            raise

    async def resolve(self, host: str, port: int) -> list[str]:
        try:
            async with asyncio.timeout(10):
                records = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except (OSError, TimeoutError) as exc:
            raise DownloadError("无法解析下载域名，请检查链接或稍后重试") from exc
        addresses = list(dict.fromkeys(record[4][0] for record in records))
        if any(ipaddress.ip_address(address) in ipaddress.ip_network("198.18.0.0/15") for address in addresses):
            raise DownloadError("下载域名解析到了保留地址（198.18.0.0/15），可能启用了代理 Fake-IP；请让该域名返回真实公网 IP")
        if not addresses or any(not public_ip(address) for address in addresses):
            raise DownloadError("下载地址必须指向公网，不能访问本机、内网或云服务元数据地址")
        return addresses

    async def _establish(self, scheme: str, host: str, port: int):
        reader = writer = None
        proxy = self.proxy() if self.proxy else ""
        if proxy:
            # 管理员启用代理后由代理解析 DNS，这里只能拦截字面内网地址和内部主机名。
            proxied_host(host)
            reader, writer = await self._tunnel(proxy, host.strip("[]"), port)
            if scheme == "https":
                try:
                    async with asyncio.timeout(15):
                        await writer.start_tls(self.tls, server_hostname=host.strip("[]"))
                except BaseException as exc:
                    writer.close()
                    if isinstance(exc, (OSError, TimeoutError)):
                        raise _tls_error(exc, "经代理建立 HTTPS 连接失败，请检查链接或代理规则") from exc
                    raise
            return reader, writer
        failure = None
        for address in await self.resolve(host, port):
            try:
                async with asyncio.timeout(10):
                    return await asyncio.open_connection(address, port, ssl=self.tls if scheme == "https" else None,
                        server_hostname=host if scheme == "https" else None, limit=65536)
            except (OSError, TimeoutError) as exc:
                failure = exc
        raise _tls_error(failure, "无法建立来源连接，请检查链接或网络") from failure

    async def _connect(self, request: DownloadRequest, url: str, method: str, body: str | None,
                       headers: list[tuple[str, str]]) -> HttpResponse:
        parts = urlsplit(checked_url(url))
        host = parts.hostname.encode("idna").decode("ascii")
        port = parts.port or (443 if parts.scheme == "https" else 80)
        for attempt in range(3):
            try:
                reader, writer = await self._establish(parts.scheme, host, port)
                break
            except TransientError:
                # 还没有发送任何请求字节，重试连接对 POST 也是安全的。
                if attempt == 2:
                    raise
                await asyncio.sleep(0.5 * (attempt + 1))
        try:
            authority = f"[{host}]" if ":" in host else host
            if port != (443 if parts.scheme == "https" else 80):
                authority += f":{port}"
            target = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
            if parts.query:
                target += "?" + quote(parts.query, safe="%/:?@!$&'()*+,;=-._~")
            lines = [f"{method} {target} HTTP/1.1", f"Host: {authority}", "Connection: close"]
            if not any(key.lower() == "accept-encoding" for key, _ in headers):
                lines.append("Accept-Encoding: identity")
            if not any(key.lower() == "user-agent" for key, _ in headers):
                lines.append("User-Agent: Tessera/1.0")
            lines.extend(f"{key}: {value}" for key, value in headers)
            payload = body.encode() if body is not None else b""
            if body is not None:
                lines.append(f"Content-Length: {len(payload)}")
            async with asyncio.timeout(15):
                writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + payload)
                await writer.drain()
                for _ in range(6):
                    block = await reader.readuntil(b"\r\n\r\n")
                    if len(block) > 32768:
                        raise DownloadError("来源响应头超过 32 KB")
                    lines = block.decode("latin-1").split("\r\n")
                    match = re.fullmatch(r"HTTP/1\.[01] ([0-9]{3})(?: .*)?", lines[0])
                    if not match:
                        raise DownloadError("来源返回了不合法的 HTTP 响应")
                    status = int(match[1])
                    response_headers, raw_headers = {}, []
                    for line in lines[1:]:
                        if not line:
                            continue
                        key, colon, value = line.partition(":")
                        if not colon or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", key):
                            raise DownloadError("来源返回了不合法的 HTTP 响应头")
                        key = key.lower()
                        if any(ord(char) < 32 and char != "\t" or ord(char) == 127 for char in value):
                            raise DownloadError("来源响应头包含不合法的控制字符")
                        if key in response_headers and key in ("content-length", "transfer-encoding", "location", "content-encoding"):
                            raise DownloadError("来源返回了重复的关键响应头")
                        response_headers[key] = value.strip()
                        raw_headers.append((key, value.strip()))
                    if not 100 <= status < 200:
                        return HttpResponse(reader, writer, status, response_headers, url, method, raw_headers)
                raise DownloadError("来源返回了过多的临时 HTTP 响应")
        except BaseException:
            writer.close()
            raise

    @asynccontextmanager
    async def open(self, request: DownloadRequest, *, url: str | None = None, method: str | None = None,
                   extra_headers: dict[str, str] | None = None, identity: bool = False, redirects: bool = True, url_check=None):
        current, verb = checked_url(url or request.url), method or request.method
        body = request.body if verb == "POST" else None
        # 所有自定义头都按来源隔离，跨域 CDN 也不转发 Cookie 或自定义认证字段。
        custom = list(request.headers) if origin(current) == origin(request.credential_origin or request.url) else []
        additions = dict(extra_headers or {})
        if identity:
            additions["Accept-Encoding"] = "identity"
        lowered = {key.lower() for key in additions}
        custom = [(key, value) for key, value in custom if key.lower() not in lowered] + list(additions.items())
        response = None
        try:
            for _ in range(6):
                if url_check:
                    url_check(current)
                response = await self._connect(request, current, verb, body, custom)
                if not redirects or response.status not in (301, 302, 303, 307, 308):
                    yield response
                    return
                if not request.follow_redirects:
                    raise DownloadError("来源要求重定向，请在 curl 命令中加入 -L 后重新解析")
                if verb == "POST":
                    raise DownloadError("POST 请求不会自动重发到重定向地址，请使用最终的文件链接重新提交")
                location = response.headers.get("location")
                if not location:
                    raise DownloadError("来源的重定向缺少目标地址")
                next_url = checked_url(urljoin(current, location))
                if origin(next_url) != origin(current):
                    custom = [(key, value) for key, value in custom if key.lower() in lowered]
                await self._close(response)
                response = None
                current = next_url
            raise DownloadError("来源重定向次数过多")
        except (OSError, TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, UnicodeError) as exc:
            if isinstance(exc, (UnicodeError, asyncio.LimitOverrunError)):
                raise DownloadError("来源响应格式不正确") from exc
            raise TransientError("来源连接中断，可以稍后重试") from exc
        finally:
            if response is not None:
                await self._close(response)

    @staticmethod
    async def _close(response):
        response.writer.close()
        try:
            async with asyncio.timeout(2):
                await response.writer.wait_closed()
        except (OSError, TimeoutError):
            pass
