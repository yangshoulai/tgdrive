"""S3 请求体的流式校验。

请求体从不整体读入内存：边读边校验，校验失败时在流中抛出异常，
上层的 put_object/upload_part 会放弃这次写入并回收临时 Blob。

支持的 ``x-amz-content-sha256`` 取值：
- 64 位十六进制：整个请求体的 SHA-256，读完后比对；
- ``UNSIGNED-PAYLOAD``：不校验请求体（预签名 URL、HTTPS 下的 SDK）；
- ``STREAMING-AWS4-HMAC-SHA256-PAYLOAD``：aws-chunked 分块，逐块校验签名链；
- ``STREAMING-UNSIGNED-PAYLOAD-TRAILER``：aws-chunked 分块，校验尾部的 x-amz-checksum-*。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import zlib
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

from .sigv4 import SigV4Error

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
UNSIGNED = "UNSIGNED-PAYLOAD"
STREAMING_SIGNED = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD"
STREAMING_UNSIGNED_TRAILER = "STREAMING-UNSIGNED-PAYLOAD-TRAILER"
MAX_CHUNK = 16 * 1024 * 1024
_HEX64 = re.compile(r"[0-9a-f]{64}")


class PayloadError(Exception):
    """请求体与声明不符，直接映射为 S3 错误码。"""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


@dataclass(frozen=True)
class ChunkSigningContext:
    signing_key: bytes
    amz_date: str
    scope: str
    seed_signature: str


async def as_stream(body: bytes | AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    if isinstance(body, (bytes, bytearray)):
        if body:
            yield bytes(body)
        return
    async for chunk in body:
        if chunk:
            yield chunk


async def limit_size(source: AsyncIterator[bytes], limit: int) -> AsyncIterator[bytes]:
    total = 0
    async for chunk in source:
        total += len(chunk)
        if total > limit:
            raise PayloadError("EntityTooLarge", f"request body exceeds the {limit} byte limit")
        yield chunk


async def read_all(source: AsyncIterator[bytes], limit: int) -> bytes:
    """读取小型 XML 请求体（CompleteMultipartUpload、DeleteObjects），超过上限即拒绝。"""
    data = bytearray()
    async for chunk in limit_size(source, limit):
        data.extend(chunk)
    return bytes(data)


async def _verify_sha256(source: AsyncIterator[bytes], expected: str) -> AsyncIterator[bytes]:
    digest = hashlib.sha256()
    async for chunk in source:
        digest.update(chunk)
        yield chunk
    if not hmac.compare_digest(digest.hexdigest(), expected):
        raise PayloadError("XAmzContentSHA256Mismatch", "the request body does not match x-amz-content-sha256")


class _Reader:
    """在异步字节流上按行、按长度读取，缓冲区大小受限。"""

    def __init__(self, source: AsyncIterator[bytes]) -> None:
        self._it = source.__aiter__()
        self._buffer = bytearray()

    async def _fill(self) -> bool:
        try:
            self._buffer.extend(await self._it.__anext__())
            return True
        except StopAsyncIteration:
            return False

    async def line(self, limit: int = 8192) -> bytes:
        while True:
            end = self._buffer.find(b"\r\n")
            if end >= 0:
                value = bytes(self._buffer[:end])
                del self._buffer[:end + 2]
                return value
            if len(self._buffer) > limit:
                raise PayloadError("InvalidRequest", "aws-chunked header line is too long")
            if not await self._fill():
                raise PayloadError("IncompleteBody", "the request body ended before the aws-chunked framing completed")

    async def exact(self, size: int) -> bytes:
        while len(self._buffer) < size:
            if not await self._fill():
                raise PayloadError("IncompleteBody", "the request body is shorter than the declared chunk size")
        value = bytes(self._buffer[:size])
        del self._buffer[:size]
        return value

    async def at_end(self) -> bool:
        return not self._buffer and not await self._fill()


def _trailer_digest(name: str) -> tuple[Callable[[bytes], None], Callable[[], bytes]] | None:
    if name == "x-amz-checksum-crc32":
        state = [0]

        def update(data: bytes) -> None:
            state[0] = zlib.crc32(data, state[0])
        return update, lambda: state[0].to_bytes(4, "big")
    if name in ("x-amz-checksum-sha1", "x-amz-checksum-sha256"):
        digest = hashlib.sha1() if name.endswith("sha1") else hashlib.sha256()
        return digest.update, digest.digest
    return None  # crc32c、crc64nvme 等算法不在标准库中，不做校验。


async def _aws_chunked(source: AsyncIterator[bytes], *, signing: ChunkSigningContext | None,
                       trailer: str | None) -> AsyncIterator[bytes]:
    reader = _Reader(source)
    previous = signing.seed_signature if signing else ""
    checksum = _trailer_digest(trailer) if trailer else None
    while True:
        header = (await reader.line()).decode("latin-1")
        size_text, _, extension = header.partition(";")
        try:
            size = int(size_text.strip(), 16)
        except ValueError as exc:
            raise PayloadError("InvalidRequest", "invalid aws-chunked chunk size") from exc
        if size < 0 or size > MAX_CHUNK:
            raise PayloadError("InvalidRequest", "aws-chunked chunk size is out of range")
        data = await reader.exact(size) if size else b""
        if signing is not None:
            match = re.fullmatch(r"\s*chunk-signature=([0-9a-f]{64})\s*", extension)
            if not match:
                raise SigV4Error("missing chunk-signature")
            string_to_sign = "\n".join(("AWS4-HMAC-SHA256-PAYLOAD", signing.amz_date, signing.scope, previous,
                                        EMPTY_SHA256, hashlib.sha256(data).hexdigest()))
            expected = hmac.new(signing.signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, match.group(1)):
                raise SigV4Error("chunk signature mismatch")
            previous = expected
        if size:
            if await reader.exact(2) != b"\r\n":
                raise PayloadError("InvalidRequest", "missing aws-chunked chunk terminator")
            if checksum:
                checksum[0](data)
            yield data
            continue
        # 结束块之后是可选的尾部头，以空行结束。
        trailers: dict[str, str] = {}
        while True:
            line = (await reader.line()).decode("latin-1")
            if not line:
                break
            name, _, value = line.partition(":")
            trailers[name.strip().lower()] = value.strip()
        if not await reader.at_end():
            raise PayloadError("InvalidRequest", "unexpected bytes after the aws-chunked body")
        if trailer:
            if trailer not in trailers:
                raise PayloadError("InvalidRequest", f"missing trailing header {trailer}")
            if checksum and not hmac.compare_digest(base64.b64encode(checksum[1]()).decode(), trailers[trailer]):
                raise PayloadError("BadDigest", f"the request body does not match {trailer}")
        return


def verified_body(source: AsyncIterator[bytes], payload_hash: str, *, signing: ChunkSigningContext | None,
                  trailer: str | None) -> AsyncIterator[bytes]:
    """按签名中声明的负载模式返回解码并校验后的请求体流。"""
    if payload_hash == UNSIGNED:
        return source
    if payload_hash == STREAMING_SIGNED:
        if signing is None:
            raise SigV4Error("streaming signature requires header authentication")
        return _aws_chunked(source, signing=signing, trailer=None)
    if payload_hash == STREAMING_UNSIGNED_TRAILER:
        return _aws_chunked(source, signing=None, trailer=(trailer or "").strip().lower() or None)
    if payload_hash.startswith("STREAMING-"):
        raise PayloadError("NotImplemented", f"{payload_hash} is not supported", 501)
    if not _HEX64.fullmatch(payload_hash):
        raise PayloadError("InvalidArgument", "x-amz-content-sha256 is not a valid SHA-256 hex digest")
    return _verify_sha256(source, payload_hash)
