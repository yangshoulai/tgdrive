"""在线解压：把存储里的压缩包解到同一账号的文件空间。

从存储读取压缩包，在有界内存中解密、解压并逐文件写回存储。磁盘空间充足时可加密暂存较大的压缩输入，
便于随机读取；解压后的内容始终直接写回存储。写入时检查账号配额，ZIP 可在开始前估算空间。

- ZIP：读中央目录得到全部条目（支持 ZIP64、UTF-8／GBK 文件名、存储／Deflate／BZip2／LZMA），每个条目是一段连续字节，
  单独按范围读取；支持传统 ZipCrypto 与 WinZip AES 密码。
- TAR（含 .tar.gz／.tgz／.tar.bz2／.tar.xz）：顺序读一遍；单个 .gz／.bz2／.xz 文件解出一个文件。
- 7z 单包和分卷：按字节范围读取，由独立进程逐条解码，使用 libarchive 或支持 AES 的 py7zr。
- RAR 单包和分卷：独立进程用 7-Zip 按卷读取并解码 RAR4／RAR5，支持密码。

任务只在进程内存里（重启后丢失，已解出的文件保留）；密码只在任务运行期间留在内存，不写日志、审计或接口回显。
"""

from __future__ import annotations

import asyncio
import bz2
import errno
import hashlib
import hmac
import lzma
import logging
import re
import secrets
import struct
import sys
import time
import unicodedata
import zlib
from bisect import bisect_right
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable
from contextlib import aclosing, asynccontextmanager, nullcontext
from dataclasses import dataclass, field
from itertools import accumulate

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from .archive import stream_zip
from .archive_staging import FRAME_SIZE, ArchiveStaging, StagedArchive, StagingUnavailable
from .errors import IntegrityError, NotFoundError, NotReadyError, QuotaExceededError, StorageAccessError
from .objects import ObjectService, Scope
from .sevenzip import (
    DEFAULT_MEMORY_LIMIT,
    MIB,
    RAR_SIGNATURES,
    DecoderError,
    decoder_memory_budget,
    decoder_memory_limit,
    open_decoder,
)
from .telegram.client import TelegramError, TelegramRateLimitError
from .work import WorkBusyError

log = logging.getLogger(__name__)

MAX_ZIP_ENTRIES = 50_000      # ZIP 需要在主进程列出可选择的条目
MAX_CENTRAL = 64 * 1024 * 1024  # 中央目录最大字节数
CHUNK = 1024 * 1024           # 解压输出分块
STAGE_MIN_SIZE = 64 * MIB      # 小包按需读，避免为几次范围读取付出整包暂存开销
MAX_TAR_METADATA = 4 * MIB    # GNU 长名和 PAX 元数据读入内存解析，文件内容无此限制
MAX_VOLUMES = 1000            # 限制一次预检读取的对象元数据量
READ_WINDOW = 4 * 1024 * 1024
ARCHIVE_READ_BATCH = 8 * MIB   # 接近 Telegram 的读取窗口，写回期间让出读取名额
SEVEN_ZIP_SIGNATURE = b"7z\xbc\xaf\x27\x1c"
SEVEN_ZIP_VOLUME = re.compile(r"(.*\.7z)\.[0-9]{3,}\Z", re.IGNORECASE)
RAR_NUMBERED_VOLUME = re.compile(r"(.*)\.part([0-9]+)\.rar\Z", re.IGNORECASE)
RAR_LEGACY_VOLUME = re.compile(r"(.*)\.(rar|[r-z][0-9]{2})\Z", re.IGNORECASE)
SAMPLE = 500                  # 预览列出的条目数
JOB_KEEP = 3600               # 已结束任务保留时间（秒）
DIRECTORY_CACHE = 8           # 在线浏览时缓存的中央目录个数
DIRECTORY_TTL = 600           # 缓存的中央目录保留时间（秒）
JOBS_PER_USER = 50
RUNNING = 2                   # 全站同时进行的解压任务数
DECODER_FORMATS = ("7z", "rar")
ARCHIVE_TYPES = re.compile(r"\.(zip|7z|rar|tar|tgz|tbz2?|txz|tar\.(?:gz|bz2|xz)|gz|bz2|xz)$", re.IGNORECASE)
UNSUPPORTED = re.compile(r"\.(zst|tar\.zst|iso|cab|arj|lzh)$", re.IGNORECASE)
CONFLICTS = ("skip", "overwrite", "rename")


class ArchiveError(ValueError):
    """压缩包本身的问题（格式、密码、损坏）；按 400 返回。"""


class PasswordRequired(ArchiveError):
    pass


class ArchiveReadError(ArchiveError):
    pass


class ArchiveWriteError(ArchiveError):
    pass


STORAGE_ERRORS = (NotFoundError, IntegrityError, NotReadyError, StorageAccessError, WorkBusyError, TelegramError, OSError)


def _storage_failure(exc: Exception, action: str) -> str:
    if isinstance(exc, WorkBusyError):
        return f"{action}失败：等待读取或传输名额超时，请稍后重试"
    if isinstance(exc, TelegramRateLimitError):
        return f"{action}失败：Telegram 限流，请稍后重试"
    if isinstance(exc, TelegramError):
        return f"{action}失败：Telegram 存储暂不可用，请稍后重试"
    if isinstance(exc, StorageAccessError):
        return f"{action}失败：存储通道拒绝访问，请联系管理员检查权限"
    if isinstance(exc, NotReadyError):
        return f"{action}失败：系统已锁定或存储通道不可用"
    if isinstance(exc, NotFoundError):
        return f"{action}失败：文件已移动、删除或有存储分片缺失"
    if isinstance(exc, IntegrityError):
        return f"{action}失败：存储分片校验未通过"
    if isinstance(exc, OSError) and exc.errno in (errno.ENOSPC, errno.EDQUOT):
        return f"{action}失败：服务器磁盘空间不足"
    if isinstance(exc, TimeoutError):
        return f"{action}超时，请稍后重试"
    return f"{action}失败：存储读写异常，请稍后重试"


# ---------- 读取存储里的压缩包 ----------

class Source:
    """按字节范围读取压缩包；每次读取都复核版本与（私密空间的）授权。"""

    def __init__(self, objects: ObjectService, scope: Scope, key: str, etag: str, size: int, on_read: Callable[[int], None] | None = None):
        self.objects, self.scope, self.key, self.etag, self.size, self.on_read = objects, scope, key, etag, size, on_read
        self.staged: StagedArchive | None = None

    async def stream(self, start: int, end: int) -> AsyncIterator[bytes]:
        if self.scope.authorize is not None:
            self.scope.authorize()
        try:
            if self.staged is not None:
                body = self.staged.stream(start, end)
            else:
                info, body = await self.objects.get_object(self.scope, self.key, start, end)
                if info.etag != self.etag:
                    await body.aclose()
                    raise ArchiveReadError("压缩包已被修改，请重新开始解压")
            remaining = end - start
            async with aclosing(body):
                async for chunk in body:
                    if self.scope.authorize is not None:
                        self.scope.authorize()
                    remaining -= len(chunk)
                    if remaining < 0:
                        raise ArchiveReadError("读取到的压缩包大小与记录不符")
                    if self.on_read:
                        self.on_read(len(chunk))
                    yield chunk
            if remaining:
                raise ArchiveReadError("压缩包读取不完整，请检查存储通道后重试")
        except PermissionError:
            raise
        except StagingUnavailable:
            raise ArchiveReadError("读取解压暂存失败，请稍后重试") from None
        except STORAGE_ERRORS as exc:
            action = "读取解压暂存" if self.staged is not None else "读取压缩包"
            raise ArchiveReadError(_storage_failure(exc, action)) from None

    async def read(self, start: int, end: int) -> bytes:
        return b"".join([chunk async for chunk in self.stream(start, end)])

    async def batches(self, start: int, end: int) -> AsyncIterator[bytes]:
        """每批读完先归还读取名额，解压或上传慢时其他任务仍可读取。"""
        if self.staged is not None:
            async with aclosing(self.stream(start, end)) as stream:
                async for chunk in stream:
                    yield chunk
            return
        while start < end:
            stop = min(end, start + ARCHIVE_READ_BATCH)
            yield await self.read(start, stop)
            start = stop

    def check_version(self, label: str = "压缩包") -> None:
        try:
            info = self.objects.head_object(self.scope, self.key)
        except NotFoundError:
            raise ArchiveReadError(f"{label}已移动或删除，请重新选择后解压") from None
        if info.etag != self.etag or info.size != self.size:
            raise ArchiveReadError(f"{label}已被修改，请重新选择后解压")


class VolumeSource:
    """把所选对象映射到同一字节地址空间，只缓存最近读过的窗口。"""

    def __init__(self, parts: list[Source], kind: str, *, split: bool = False):
        self.parts = parts
        self.format = kind
        self.label = "分卷" if split else "压缩包"
        self.keys = frozenset(part.key for part in parts)
        self.ends = list(accumulate(part.size for part in parts))
        self.size = self.ends[-1]
        self.window_start, self.window = 0, b""
        self.staged: StagedArchive | None = None

    async def read(self, start: int, end: int, *, window: int = READ_WINDOW) -> bytes:
        if self.staged is not None:
            try:
                return await self.staged.read(start, end)
            except (OSError, IntegrityError, StagingUnavailable):
                raise ArchiveReadError("读取解压暂存失败，请稍后重试") from None
        pieces = []
        while start < end:
            if not self.window_start <= start < self.window_start + len(self.window):
                index = bisect_right(self.ends, start)
                volume_start = self.ends[index - 1] if index else 0
                stop = min(self.ends[index], start + window)
                self.window = await self.parts[index].read(start - volume_start, stop - volume_start)
                self.window_start = start
            stop = min(end, self.window_start + len(self.window))
            pieces.append(self.window[start - self.window_start:stop - self.window_start])
            start = stop
        return b"".join(pieces)

    def check_versions(self) -> None:
        for part in self.parts:
            part.check_version(self.label)


class Reader:
    """在异步分块流上按需读取 n 个字节。"""

    def __init__(self, chunks: AsyncIterator[bytes]):
        self.chunks, self.buffer, self.done = chunks.__aiter__(), bytearray(), False

    async def _fill(self, size: int) -> None:
        while len(self.buffer) < size and not self.done:
            try:
                self.buffer += await anext(self.chunks)
            except StopAsyncIteration:
                self.done = True

    async def read(self, size: int) -> bytes:
        """最多 size 字节；流结束时可能更短。"""
        await self._fill(size)
        data = bytes(self.buffer[:size])
        del self.buffer[:size]
        return data

    async def exactly(self, size: int) -> bytes:
        data = await self.read(size)
        if len(data) != size:
            raise ArchiveError("压缩包不完整或已损坏")
        return data

    async def some(self, limit: int) -> bytes:
        """读取已有数据（至少 1 字节，最多 limit），流结束时返回空。"""
        if not self.buffer:
            await self._fill(1)
        data = bytes(self.buffer[:limit])
        del self.buffer[:limit]
        return data

    async def close(self) -> None:
        closer = getattr(self.chunks, "aclose", None)
        if closer:
            await closer()

    async def drain(self) -> None:
        self.buffer.clear()
        async for _ in self.chunks:
            pass


# ---------- 解密 ----------

_CRC_TABLE = []
for _n in range(256):
    _c = _n
    for _ in range(8):
        _c = (_c >> 1) ^ 0xEDB88320 if _c & 1 else _c >> 1
    _CRC_TABLE.append(_c)


class ZipCrypto:
    """传统 PKWARE 加密（较弱，但仍常见）。纯 Python 逐字节处理，放在线程里跑。"""

    def __init__(self, password: bytes):
        self.k0, self.k1, self.k2 = 305419896, 591751049, 878082192
        for byte in password:
            self._update(byte)

    def _update(self, byte: int) -> None:
        crc = _CRC_TABLE
        self.k0 = crc[(self.k0 ^ byte) & 0xFF] ^ (self.k0 >> 8)
        self.k1 = ((self.k1 + (self.k0 & 0xFF)) * 134775813 + 1) & 0xFFFFFFFF
        self.k2 = crc[(self.k2 ^ (self.k1 >> 24)) & 0xFF] ^ (self.k2 >> 8)

    def decrypt(self, data: bytes) -> bytes:
        crc, out = _CRC_TABLE, bytearray(len(data))
        k0, k1, k2 = self.k0, self.k1, self.k2
        for index, byte in enumerate(data):
            k = (k2 | 2) & 0xFFFF
            plain = byte ^ (((k * (k ^ 1)) >> 8) & 0xFF)
            out[index] = plain
            k0 = crc[(k0 ^ plain) & 0xFF] ^ (k0 >> 8)
            k1 = ((k1 + (k0 & 0xFF)) * 134775813 + 1) & 0xFFFFFFFF
            k2 = crc[(k2 ^ (k1 >> 24)) & 0xFF] ^ (k2 >> 8)
        self.k0, self.k1, self.k2 = k0, k1, k2
        return bytes(out)


class WinZipAes:
    """WinZip AES（AE-1／AE-2）：PBKDF2-HMAC-SHA1 派生密钥，AES-CTR（小端计数器，从 1 开始），HMAC-SHA1 前 10 字节校验。"""

    KEY_SIZES = {1: 16, 2: 24, 3: 32}

    def __init__(self, password: bytes, salt: bytes, strength: int, verifier: bytes):
        size = self.KEY_SIZES[strength]
        derived = hashlib.pbkdf2_hmac("sha1", password, salt, 1000, 2 * size + 2)
        if not hmac.compare_digest(derived[2 * size:], verifier):
            raise ArchiveError("密码不正确")
        self.encryptor = Cipher(algorithms.AES(derived[:size]), modes.ECB()).encryptor()
        self.mac = hmac.new(derived[size:2 * size], digestmod=hashlib.sha1)
        self.counter, self.pending = 1, b""

    def decrypt(self, data: bytes) -> bytes:
        self.mac.update(data)
        need = len(data) - len(self.pending)
        stream = self.pending
        if need > 0:
            blocks = (need + 15) // 16
            counters = b"".join((self.counter + index).to_bytes(16, "little") for index in range(blocks))
            self.counter += blocks
            stream += self.encryptor.update(counters)
        self.pending = stream[len(data):]
        return (int.from_bytes(data, "big") ^ int.from_bytes(stream[:len(data)], "big")).to_bytes(len(data), "big") if data else b""

    def verify(self, code: bytes) -> None:
        if not hmac.compare_digest(self.mac.digest()[:10], code):
            raise ArchiveError("文件校验失败：密码不正确或压缩包已损坏")


# ---------- ZIP ----------

@dataclass
class ZipEntry:
    name: str
    is_dir: bool
    method: int
    flags: int
    crc: int
    compressed: int
    size: int
    offset: int
    mod_time: int
    aes: tuple[int, int] | None = None  # (strength, 实际压缩方式)
    aes_version: int = 0

    @property
    def encrypted(self) -> bool:
        return bool(self.flags & 1)


METHODS = {0: "存储", 8: "Deflate", 12: "BZip2", 14: "LZMA"}


def _extra_fields(extra: bytes) -> dict[int, bytes]:
    fields, position = {}, 0
    while position + 4 <= len(extra):
        header, length = struct.unpack_from("<HH", extra, position)
        fields[header] = extra[position + 4:position + 4 + length]
        position += 4 + length
    return fields


def _decode_name(raw: bytes, flags: int, extra: dict[int, bytes]) -> str:
    unicode_path = extra.get(0x7075)
    if unicode_path and len(unicode_path) > 5 and unicode_path[0] == 1:
        try:
            return unicode_path[5:].decode("utf-8")
        except UnicodeDecodeError:
            pass
    if flags & 0x800:
        return raw.decode("utf-8", "replace")
    # 不少中文压缩工具不设 UTF-8 标记：先按 UTF-8 严格解码，再按 GB18030，最后按 ZIP 规定的 CP437。
    for encoding in ("utf-8", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("cp437")


async def read_zip(source: Source) -> list[ZipEntry]:
    tail_size = min(source.size, 65536 + 22)
    tail = await source.read(source.size - tail_size, source.size)
    position = tail.rfind(b"PK\x05\x06")
    if position < 0 or len(tail) - position < 22:
        raise ArchiveError("不是有效的 ZIP 压缩包，或压缩包不完整")
    _, _, _, total, central_size, central_offset, _ = struct.unpack_from("<HHHHIIH", tail, position + 4)
    if total == 0xFFFF or central_size == 0xFFFFFFFF or central_offset == 0xFFFFFFFF:
        locator = position - 20
        if locator < 0 or tail[locator:locator + 4] != b"PK\x06\x07":
            raise ArchiveError("ZIP64 压缩包缺少目录定位信息")
        (zip64_offset,) = struct.unpack_from("<Q", tail, locator + 8)
        record = await source.read(zip64_offset, min(source.size, zip64_offset + 56))
        if record[:4] != b"PK\x06\x06" or len(record) < 56:
            raise ArchiveError("ZIP64 目录记录无效")
        total, central_size, central_offset = struct.unpack_from("<QQQ", record, 32)
    if total > MAX_ZIP_ENTRIES:
        raise ArchiveError(f"压缩包里的条目太多（超过 {MAX_ZIP_ENTRIES} 个）")
    if central_size > MAX_CENTRAL or central_offset + central_size > source.size:
        raise ArchiveError("ZIP 目录过大或已损坏")
    central = await source.read(central_offset, central_offset + central_size)
    entries, position = [], 0
    while position + 46 <= len(central) and central[position:position + 4] == b"PK\x01\x02":
        (_, _, flags, method, mod_time, mod_date, crc, compressed, size, name_length, extra_length,
         comment_length, _, _, _, offset) = struct.unpack_from("<HHHHHHIIIHHHHHII", central, position + 4)
        name_raw = central[position + 46:position + 46 + name_length]
        extra = _extra_fields(central[position + 46 + name_length:position + 46 + name_length + extra_length])
        position += 46 + name_length + extra_length + comment_length
        if 0x0001 in extra:
            values, index = extra[0x0001], 0
            def next_value():
                nonlocal index
                (value,) = struct.unpack_from("<Q", values, index)
                index += 8
                return value
            try:
                if size == 0xFFFFFFFF:
                    size = next_value()
                if compressed == 0xFFFFFFFF:
                    compressed = next_value()
                if offset == 0xFFFFFFFF:
                    offset = next_value()
            except struct.error:
                raise ArchiveError("ZIP64 扩展信息无效") from None
        name = _decode_name(name_raw, flags, extra)
        entry = ZipEntry(name, name.endswith("/") or name.endswith("\\"), method, flags, crc, compressed, size, offset, (mod_date << 16) | mod_time)
        if method == 99 and 0x9901 in extra and len(extra[0x9901]) >= 7:
            version, _, strength, actual = struct.unpack_from("<H2sBH", extra[0x9901])
            entry.aes, entry.aes_version = (strength, actual), version
        entries.append(entry)
    if len(entries) != total and total < 0xFFFF:
        raise ArchiveError("ZIP 目录与条目数量不一致，压缩包可能已损坏")
    return entries


def _decompressor(method: int):
    if method == 0:
        return None
    if method == 8:
        return zlib.decompressobj(-15)
    if method == 12:
        return bz2.BZ2Decompressor()
    raise ArchiveError(f"不支持的压缩方式（{method}）")


async def _inflate(decoder, data: bytes) -> AsyncIterator[bytes]:
    """每次只展开一个输出块，输出送走以后再继续处理已经接收的压缩数据。"""
    if decoder is None:
        if data:
            yield data
        return
    zlib_stream = hasattr(decoder, "unconsumed_tail")
    while not decoder.eof:
        try:
            output = await asyncio.to_thread(decoder.decompress, data, CHUNK)
        except lzma.LZMAError as exc:
            if "Memory usage limit exceeded" in str(exc):
                raise ArchiveError("XZ 解码内存不足，请联系管理员调整解压内存上限") from None
            raise ArchiveError("压缩流校验失败，数据可能已损坏") from None
        except (zlib.error, OSError, EOFError):
            raise ArchiveError("压缩流校验失败，数据可能已损坏") from None
        if output:
            yield output
        if zlib_stream:
            data = decoder.unconsumed_tail
            if not data and len(output) < CHUNK:
                break
        elif decoder.needs_input:
            break
        else:
            data = b""


async def zip_entry_stream(source: Source, entry: ZipEntry, password: bytes | None, *,
                           memory_limit: int = DEFAULT_MEMORY_LIMIT, batch_reads: bool = False) -> AsyncIterator[bytes]:
    """一个 ZIP 条目的解压内容；结束时校验 CRC／HMAC 与大小。"""
    header = await source.read(entry.offset, min(source.size, entry.offset + 30))
    if header[:4] != b"PK\x03\x04" or len(header) < 30:
        raise ArchiveError("压缩包条目头无效，可能已损坏")
    name_length, extra_length = struct.unpack_from("<HH", header, 26)
    start = entry.offset + 30 + name_length + extra_length
    end = start + entry.compressed
    if end > source.size:
        raise ArchiveError("压缩包不完整或已损坏")
    method = entry.aes[1] if entry.aes else entry.method
    if method not in METHODS:
        raise ArchiveError(f"不支持的压缩方式（{method}）")
    reader = Reader(source.batches(start, end) if batch_reads else source.stream(start, end))
    remaining = entry.compressed
    try:
        decrypt = None
        aes = None
        slow = False  # ZipCrypto 逐字节解密，放进线程
        if entry.encrypted:
            if password is None:
                raise PasswordRequired("这个压缩包需要密码")
            if entry.aes:
                strength = entry.aes[0]
                if strength not in WinZipAes.KEY_SIZES:
                    raise ArchiveError("不支持的 AES 加密强度")
                salt = await reader.exactly(WinZipAes.KEY_SIZES[strength] // 2)
                verifier = await reader.exactly(2)
                aes = WinZipAes(password, salt, strength, verifier)
                decrypt = aes.decrypt
                remaining -= len(salt) + 2 + 10
            elif entry.flags & 0x40:
                raise ArchiveError("不支持 PKWARE 强加密")
            else:
                crypto = ZipCrypto(password)
                head = await asyncio.to_thread(crypto.decrypt, await reader.exactly(12))
                check = (entry.mod_time >> 8) & 0xFF if entry.flags & 0x08 else (entry.crc >> 24) & 0xFF
                if head[11] != check:
                    raise ArchiveError("密码不正确")
                decrypt, slow = crypto.decrypt, True
                remaining -= 12
            if remaining < 0:
                raise ArchiveError("压缩包条目已损坏")
        async def decoded(data: bytes) -> bytes:
            if decrypt is None:
                return data
            return await asyncio.to_thread(decrypt, data) if slow or len(data) > 65536 else decrypt(data)

        if method == 14:
            # LZMA 属性可能跨压缩流的缓冲边界，按长度分别取完。
            if remaining < 4:
                raise ArchiveError("LZMA 条目头无效")
            header = await decoded(await reader.exactly(4))
            (props_length,) = struct.unpack_from("<H", header, 2)
            if props_length != 5 or props_length > remaining - 4:
                raise ArchiveError("LZMA 条目头无效")
            props = await decoded(await reader.exactly(props_length))
            remaining -= 4 + props_length
            try:
                lzma_filter = lzma._decode_filter_properties(lzma.FILTER_LZMA1, props)
            except lzma.LZMAError:
                raise ArchiveError("LZMA 条目头无效") from None
            if lzma_filter["dict_size"] + 8 * MIB > memory_limit:
                raise ArchiveError("ZIP 的 LZMA 字典超过解码内存上限，请联系管理员调整")
            decompressor = lzma.LZMADecompressor(lzma.FORMAT_RAW, filters=[lzma_filter])
        else:
            decompressor = _decompressor(method)
        crc, produced = 0, 0
        while remaining > 0:
            data = await reader.some(min(CHUNK, remaining))
            if not data:
                raise ArchiveError("压缩包不完整或已损坏")
            remaining -= len(data)
            data = await decoded(data)
            async for output in _inflate(decompressor, data):
                produced += len(output)
                if produced > entry.size:
                    raise ArchiveError("解压后的大小与记录不符，已停止（可能是压缩炸弹或文件损坏）")
                crc = zlib.crc32(output, crc)
                yield output
        # ZIP 的 LZMA 可以省略结束标记，此时由声明长度和 CRC／HMAC 校验。
        if decompressor is not None and (method != 14 or entry.flags & 0x02) and not decompressor.eof:
            raise ArchiveError("ZIP 压缩流不完整，文件可能已损坏")
        if aes is not None:
            aes.verify(await reader.exactly(10))
        if produced != entry.size:
            raise ArchiveError("解压后的大小与记录不符，文件可能已损坏")
        # AE-2 不存 CRC，只靠 HMAC 校验。
        if not (entry.aes and entry.aes_version == 2) and crc != entry.crc:
            raise ArchiveError("文件校验失败：" + ("密码不正确或" if entry.encrypted else "") + "压缩包已损坏")
    finally:
        await reader.close()


async def check_zip_password(source: Source, entries: list[ZipEntry], password: bytes, *,
                             memory_limit: int = DEFAULT_MEMORY_LIMIT) -> bool:
    """只检查第一个加密条目的密码校验字节（AES 为派生的校验值，传统加密为解密后的头部），不解出内容。"""
    entry = next((item for item in entries if item.encrypted and not item.is_dir), None)
    if entry is None:
        return True
    stream = zip_entry_stream(source, entry, password, memory_limit=memory_limit)
    try:
        await anext(stream, None)
        return True
    except PasswordRequired:
        return False
    except ArchiveError as exc:
        if "密码" in str(exc):
            return False
        raise
    finally:
        await stream.aclose()


# ---------- TAR 与单文件压缩 ----------

def _stream_decompressor(kind: str, memory_limit: int):
    if kind == "gz":
        return zlib.decompressobj(31)
    if kind == "bz2":
        return bz2.BZ2Decompressor()
    if kind == "xz":
        return lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=memory_limit)
    raise ValueError("不支持的流式压缩格式")


async def decompressed(chunks: AsyncIterator[bytes], kind: str, *,
                       memory_limit: int = DEFAULT_MEMORY_LIMIT) -> AsyncIterator[bytes]:
    decoder = None
    complete = False
    padding = 0
    async with aclosing(chunks):
        async for data in chunks:
            while data:
                if decoder is None:
                    if complete and kind in ("gz", "xz"):
                        stripped = data.lstrip(b"\0")
                        padding += len(data) - len(stripped)
                        data = stripped
                        if not data:
                            break
                        if kind == "xz" and padding % 4:
                            raise ArchiveError("XZ 压缩流的填充无效")
                        padding = 0
                    decoder = _stream_decompressor(kind, memory_limit)
                async for output in _inflate(decoder, data):
                    yield output
                if not decoder.eof:
                    break
                # 拼接的 gzip、bzip2 和 XZ 每段分别校验并继续解码。
                complete, data, decoder = True, decoder.unused_data, None
    if not complete or decoder is not None or kind == "xz" and padding % 4:
        raise ArchiveError("压缩流不完整，文件可能已损坏")


@dataclass
class TarMember:
    name: str
    kind: str  # file / dir / other
    size: int


def _tar_number(field_bytes: bytes) -> int:
    if field_bytes and field_bytes[0] & 0x80:  # GNU base-256
        value = int.from_bytes(field_bytes[1:], "big")
        return value
    text = field_bytes.split(b"\0", 1)[0].strip()
    return int(text, 8) if text else 0


def _pax(data: bytes) -> dict[str, str]:
    values, position = {}, 0
    while position < len(data):
        space = data.find(b" ", position)
        if space < 0:
            break
        try:
            length = int(data[position:space])
        except ValueError:
            break
        record = data[space + 1:position + length - 1]
        key, _, value = record.partition(b"=")
        values[key.decode("utf-8", "replace")] = value.decode("utf-8", "replace")
        position += length
    return values


async def tar_members(reader: Reader) -> AsyncIterator[tuple[TarMember, Callable[[], AsyncIterator[bytes]]]]:
    """顺序读出 TAR 条目；调用方必须先读完（或跳过）上一个条目的内容，再取下一个。"""
    long_name = None
    pax: dict[str, str] = {}
    while True:
        block = await reader.read(512)
        if len(block) < 512 or block == b"\0" * 512:
            return
        if block[257:262] not in (b"ustar", b"") and not block[100:108].strip(b" \0").isdigit():
            raise ArchiveError("不是有效的 TAR 压缩包")
        # 校验和：头部按空格计算，不匹配说明不是 TAR 或已损坏。
        stored = _tar_number(block[148:156])
        if stored != sum(block[:148]) + 8 * 32 + sum(block[156:]):
            raise ArchiveError("TAR 头部校验失败，压缩包可能已损坏")
        size = _tar_number(block[124:136])
        kind_flag = block[156:157]
        name = block[:100].split(b"\0", 1)[0]
        prefix = block[345:500].split(b"\0", 1)[0] if block[257:262] == b"ustar" else b""
        full = (prefix + b"/" + name) if prefix else name
        padded = (size + 511) // 512 * 512
        if kind_flag in (b"L", b"x", b"g"):
            if size > MAX_TAR_METADATA:
                raise ArchiveError("TAR 文件名或扩展头超过解析上限")
            data = (await reader.exactly(padded))[:size]
            if kind_flag == b"L":
                long_name = data.split(b"\0", 1)[0]
            elif kind_flag == b"x":
                pax = _pax(data)
            continue
        if pax.get("path"):
            text = pax["path"]
        else:
            raw = long_name if long_name is not None else full
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("gb18030", "replace")
        if "size" in pax:
            try:
                size = int(pax["size"])
                padded = (size + 511) // 512 * 512
            except ValueError:
                pass
        long_name, pax = None, {}
        kind = "dir" if kind_flag == b"5" or text.endswith("/") else "file" if kind_flag in (b"0", b"\0", b"7") else "other"
        consumed = False

        async def body(size=size, padded=padded):
            nonlocal consumed
            consumed = True
            left = size
            while left > 0:
                data = await reader.some(min(CHUNK, left))
                if not data:
                    raise ArchiveError("压缩包不完整或已损坏")
                left -= len(data)
                yield data
            if padded > size:
                await reader.exactly(padded - size)

        yield TarMember(text, kind, size), body
        if not consumed:
            async for _ in body():
                pass


def archive_format(name: str, head: bytes) -> str:
    lower = name.lower()
    if head[:4] in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"):
        return "zip"
    if head.startswith(SEVEN_ZIP_SIGNATURE):
        return "7z"
    if head.startswith(RAR_SIGNATURES):
        return "rar"
    if len(head) >= 262 and head[257:262] == b"ustar":
        return "tar"
    compressed = "gz" if head[:2] == b"\x1f\x8b" else "bz2" if head[:3] == b"BZh" else "xz" if head[:6] == b"\xfd7zXZ\0" else None
    if compressed:
        tarred = re.search(r"\.(tar\.(gz|bz2|xz)|tgz|tbz2?|txz)$", lower)
        return f"tar.{compressed}" if tarred else compressed
    if lower.endswith(".zip"):
        raise ArchiveError("不是有效的 ZIP 压缩包")
    if lower.endswith(".7z"):
        raise ArchiveError("不是有效的 7z 压缩包")
    if RAR_LEGACY_VOLUME.fullmatch(name):
        raise ArchiveError("不是有效的 RAR 压缩包")
    if UNSUPPORTED.search(lower):
        raise ArchiveError("暂不支持这种压缩格式，可在线解压 ZIP、7z、RAR、TAR 及单个 .gz、.bz2、.xz 文件")
    raise ArchiveError("无法识别压缩格式，可在线解压 ZIP、7z、RAR、TAR 及单个 .gz、.bz2、.xz 文件")


def check_7z_header(head: bytes, size: int, *, split: bool = False) -> None:
    if len(head) < 32 or not head.startswith(SEVEN_ZIP_SIGNATURE) or zlib.crc32(head[12:32]) != int.from_bytes(head[8:12], "little"):
        raise ArchiveError("7z 首卷无效或已损坏，请检查 .001 分卷" if split else "7z 压缩包首部已损坏")
    # 起始头记录末尾目录的位置与长度，可以在提交任务前发现压缩包截断或尾卷缺失。
    offset, length = struct.unpack_from("<QQ", head, 12)
    if size < 32 + offset + length:
        raise ArchiveError("7z 分卷不完整，请选齐所有分卷后再试" if split else "7z 压缩包不完整，请检查文件")


def rar_volume(path: str) -> tuple[str, str, int] | None:
    if match := RAR_NUMBERED_VOLUME.fullmatch(path):
        digits = match[2].lstrip("0")
        return "numbered", match[1], int(digits or "0") if len(digits) <= 4 else MAX_VOLUMES + 1
    if match := RAR_LEGACY_VOLUME.fullmatch(path):
        suffix = match[2].lower()
        number = 1 if suffix == "rar" else (ord(suffix[0]) - ord("r")) * 100 + int(suffix[1:]) + 2
        return "legacy", match[1], number
    return None


def has_rar_volume_suffix(path: str) -> bool:
    part = rar_volume(path)
    return part is not None and (part[0] == "numbered" or part[2] > 1)


def ordered_archive_volumes(key: str, paths: list[str]) -> tuple[str, list[str]]:
    if not 1 <= len(paths) <= MAX_VOLUMES:
        raise ArchiveError(f"请选择一套压缩包分卷，一次最多 {MAX_VOLUMES} 卷")
    if key not in paths:
        raise ArchiveError("请选择同一文件夹内的一套分卷")
    if match := SEVEN_ZIP_VOLUME.fullmatch(key):
        base = match[1]
        for path in paths:
            part = SEVEN_ZIP_VOLUME.fullmatch(path)
            if not part or part[1] != base:
                raise ArchiveError("请选择同一文件夹内、名称相同的一套 7z 分卷")
        ordered = [f"{base}.{number:03d}" for number in range(1, len(paths) + 1)]
        if set(paths) != set(ordered):
            raise ArchiveError("请选择从 .001 开始的连续分卷，补齐缺少的卷后再试")
        return "7z", ordered

    first = rar_volume(key)
    if first is None:
        raise ArchiveError("请选择同一文件夹内的一套 7z 或 RAR 分卷")
    parts = {}
    for path in paths:
        part = rar_volume(path)
        if part is None or part[:2] != first[:2]:
            raise ArchiveError("请选择同一文件夹内、名称相同的一套 RAR 分卷")
        parts[part[2]] = path
    expected = range(1, len(paths) + 1)
    if set(parts) != set(expected):
        raise ArchiveError("请选择从 .part1.rar 或 .rar 开始的连续 RAR 分卷，补齐缺少的卷后再试")
    return "rar", [parts[number] for number in expected]


def _dos_time(value: int) -> str | None:
    """ZIP 里的 DOS 日期时间是打包电脑的本地时间、不带时区：原样给出「年-月-日 时:分」，不换算时区。"""
    date, clock = value >> 16, value & 0xFFFF
    month, day, hour, minute = (date >> 5) & 0xF, date & 0x1F, clock >> 11, (clock >> 5) & 0x3F
    if not date or not 1 <= month <= 12 or not 1 <= day <= 31 or hour > 23 or minute > 59:
        return None
    return f"{1980 + (date >> 9):04d}-{month:02d}-{day:02d} {hour:02d}:{minute:02d}"


def safe_relative(name: str, is_dir: bool) -> str | None:
    """压缩包里的路径转成相对保存位置的路径：去掉开头的 / 与盘符、. 段，含 .. 的条目跳过（不能越出保存位置）。"""
    name = unicodedata.normalize("NFC", name.replace("\\", "/"))
    parts = [part for part in name.split("/") if part not in ("", ".")]
    if parts and re.fullmatch(r"[A-Za-z]:", parts[0]):
        parts = parts[1:]
    if not parts or any(part == ".." for part in parts):
        return None
    parts = [re.sub(r"[\x00-\x1f\x7f]", "", part).strip() or "_" for part in parts]
    if parts[0].startswith(".tgdrive"):
        parts[0] = "_" + parts[0][1:]
    return "/".join(parts) + ("/" if is_dir else "")


def ignored(relative: str) -> bool:
    """macOS 打包时附带的资源分支与 .DS_Store，解出来没有用。"""
    return relative.startswith("__MACOSX/") or relative.rsplit("/", 1)[-1] in (".DS_Store",) or relative == "__MACOSX/"


# ---------- 任务 ----------

@dataclass
class Job:
    id: str
    owner: int
    private: bool
    archive: str
    destination: str
    format: str
    conflict: str
    keep_archive: bool
    status: str = "queued"  # queued / running / completed / failed / cancelled
    total_files: int | None = None
    total_bytes: int | None = None
    archive_size: int = 0
    read_bytes: int = 0
    done_files: int = 0
    done_bytes: int = 0
    skipped: int = 0
    renamed: int = 0
    current: str = ""
    error: str = ""
    failures: list[dict] = field(default_factory=list)
    failed_count: int = 0
    archive_removed: bool = False
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    cancelled: bool = False
    task: asyncio.Task | None = None
    # extract：解压；compress：在线压缩（archive 为生成的压缩包路径，destination 为它所在的文件夹）。
    kind: str = "extract"
    # 只解压了 ZIP 中选中的部分文件。
    partial: bool = False
    password_error: bool = False
    staging: bool = False

    def public(self) -> dict:
        return {"id": self.id, "kind": self.kind, "private": self.private, "archive": self.archive, "destination": self.destination, "format": self.format,
                "conflict": self.conflict, "keep_archive": self.keep_archive, "partial": self.partial, "status": self.status,
                "total_files": self.total_files, "total_bytes": self.total_bytes, "archive_size": self.archive_size, "read_bytes": self.read_bytes,
                "done_files": self.done_files, "done_bytes": self.done_bytes, "skipped": self.skipped, "renamed": self.renamed,
                "failed": self.failed_count, "failures": self.failures[:20], "current": self.current, "error": self.error,
                "password_error": self.password_error, "staging": self.staging,
                "archive_removed": self.archive_removed, "created_at": self.created_at, "finished_at": self.finished_at}


def _content_type(key: str) -> str | None:
    from .offline.service import _stored_type
    return _stored_type(key, None)


class ArchiveService:
    def __init__(self, objects: ObjectService, *, memory_bytes: int | None = None,
                 sevenzip_memory_mib: Callable[[], int] | None = None, staging: ArchiveStaging | None = None):
        self.objects = objects
        self.jobs: dict[str, Job] = {}
        self.slots = asyncio.Semaphore(RUNNING)
        self._staging = staging
        self._decoder_budget = decoder_memory_budget(memory_bytes)
        self._decoder_config = sevenzip_memory_mib
        self._decoder_reserved = 0
        self._decoder_slots = asyncio.Condition()
        self._directories: OrderedDict[tuple, tuple[float, list[ZipEntry]]] = OrderedDict()

    def _memory_limit(self) -> int:
        configured = self._decoder_config() if self._decoder_config is not None else 0
        return decoder_memory_limit(self._decoder_budget, configured)

    # ----- 预览 -----

    async def _open(self, scope: Scope, key: str):
        if key.endswith("/"):
            raise ArchiveError("请选择一个压缩包文件")
        info = await self.objects.metadata.run_in_thread(self.objects.head_object, scope, key)
        if info.size <= 0:
            raise ArchiveError("压缩包是空文件")
        source = Source(self.objects, scope, key, info.etag, info.size)
        head = await source.read(0, min(info.size, 512))
        kind = archive_format(key.rsplit("/", 1)[-1], head)
        if kind == "7z":
            if SEVEN_ZIP_VOLUME.fullmatch(key):
                raise ArchiveError("请在文件列表选齐所有 7z 分卷后解压")
            check_7z_header(head, info.size)
        if kind == "rar" and has_rar_volume_suffix(key):
            raise ArchiveError("请在文件列表选齐所有 RAR 分卷后解压")
        return info, source, kind

    async def _open_volumes(self, scope: Scope, key: str, paths: list[str]) -> VolumeSource:
        kind, ordered = ordered_archive_volumes(key, paths)

        def snapshots():
            return [self.objects.head_object(scope, path) for path in ordered]

        try:
            infos = await self.objects.metadata.run_in_thread(snapshots)
        except NotFoundError:
            raise ArchiveError("分卷已移动或删除，请重新选择后解压") from None
        if any(info.size <= 0 for info in infos):
            raise ArchiveError("所选分卷包含空文件，请检查压缩包")
        source = VolumeSource([Source(self.objects, scope, info.key, info.etag, info.size) for info in infos], kind, split=True)
        if kind == "7z":
            head = await source.read(0, min(32, source.size), window=32)
            check_7z_header(head, source.size, split=True)
        elif not (await source.read(0, min(8, source.parts[0].size), window=8)).startswith(RAR_SIGNATURES):
            raise ArchiveError("RAR 首卷无效或已损坏，请检查所选分卷")
        return source

    def _existing(self, scope: Scope, keys: list[str]) -> dict[str, int]:
        found = {}
        db = self.objects.metadata.db
        for index in range(0, len(keys), 500):
            part = keys[index:index + 500]
            for row in db.execute(f"SELECT key,size FROM objects WHERE bucket_id=? AND key IN ({','.join('?' * len(part))})", (scope.bucket_id, *part)):
                found[row["key"]] = int(row["size"])
        return found

    def _room(self, scope: Scope) -> int | None:
        return self.objects._quota_room(scope.bucket_id, "")

    async def inspect(self, scope: Scope, key: str, destination: str | None, password: str | None,
                      *, volumes: list[str] | None = None) -> dict:
        if volumes is not None:
            source = await self._open_volumes(scope, key, volumes)
            return {"format": source.format, "size": source.size, "room": await self.objects.metadata.run_in_thread(self._room, scope),
                    "listable": False, "encrypted": False, "files": None, "total_bytes": None, "entries": []}
        info, source, kind = await self._open(scope, key)
        result: dict = {"format": kind, "size": info.size, "room": await self.objects.metadata.run_in_thread(self._room, scope)}
        if kind != "zip":
            # 7z、RAR 和 TAR 走整包解压，解压时边读边写，配额不足会停止。
            single = kind in ("gz", "bz2", "xz")
            result.update(listable=False, encrypted=False, files=1 if single else None, total_bytes=None, entries=[],
                          single_name=key.rsplit("/", 1)[-1].rsplit(".", 1)[0] if single else None)
            return result
        entries = await read_zip(source)
        files = [entry for entry in entries if not entry.is_dir]
        encrypted = [entry for entry in files if entry.encrypted]
        relatives = [(entry, safe_relative(entry.name, entry.is_dir)) for entry in entries]
        usable = [(entry, relative) for entry, relative in relatives if relative and not ignored(relative)]
        unsupported = sum(1 for entry, _ in usable if not entry.is_dir and (entry.aes[1] if entry.aes else entry.method) not in METHODS)
        tops = {relative.split("/", 1)[0] for _, relative in usable}
        single_root = next(iter(tops)) if len(tops) == 1 and all("/" in relative for _, relative in usable) else None
        result.update(listable=True, files=sum(1 for entry, _ in usable if not entry.is_dir),
                      total_bytes=sum(entry.size for entry, _ in usable if not entry.is_dir),
                      encrypted=bool(encrypted), encryption="aes" if any(entry.aes for entry in encrypted) else "zipcrypto" if encrypted else None,
                      unsafe=sum(1 for _, relative in relatives if relative is None), unsupported=unsupported, single_root=single_root,
                      entries=[{"name": relative, "size": entry.size, "dir": entry.is_dir} for entry, relative in usable[:SAMPLE]])
        if encrypted and password is not None:
            result["password_ok"] = await check_zip_password(source, entries, password.encode("utf-8"),
                                                             memory_limit=self._memory_limit())
        if destination is not None:
            targets = [destination + relative for entry, relative in usable if not entry.is_dir]
            existing = await self.objects.metadata.run_in_thread(self._existing, scope, targets)
            result["conflicts"] = len(existing)
            result["conflict_bytes"] = sum(existing.values())
        return result

    # ----- 在线浏览（ZIP） -----

    async def _zip_entries(self, scope: Scope, key: str, etag: str, source: Source) -> list[ZipEntry]:
        """同一版本的中央目录短期复用：浏览压缩包时逐个打开条目，不必每次都重读目录。"""
        cache_key = (scope.bucket_id, key, etag)
        cached = self._directories.get(cache_key)
        if cached is not None and time.monotonic() - cached[0] < DIRECTORY_TTL:
            self._directories.move_to_end(cache_key)
            return cached[1]
        entries = await read_zip(source)
        self._directories[cache_key] = (time.monotonic(), entries)
        while len(self._directories) > DIRECTORY_CACHE:
            self._directories.popitem(last=False)
        return entries

    async def browse(self, scope: Scope, key: str) -> dict:
        """列出 ZIP 里的全部条目（最多 MAX_ZIP_ENTRIES 个），供网页按目录浏览。"""
        info, source, kind = await self._open(scope, key)
        result: dict = {"format": kind, "size": info.size, "etag": info.etag}
        if kind != "zip":
            return {**result, "listable": False, "entries": []}
        entries = await self._zip_entries(scope, key, info.etag, source)
        items = []
        for index, entry in enumerate(entries):
            relative = safe_relative(entry.name, entry.is_dir)
            if not relative or ignored(relative):
                continue
            method = entry.aes[1] if entry.aes else entry.method
            items.append({"index": index, "name": relative, "dir": entry.is_dir, "size": entry.size, "compressed": entry.compressed,
                          "modified": _dos_time(entry.mod_time), "encrypted": entry.encrypted, "supported": method in METHODS})
        return {**result, "listable": True, "entries": items}

    async def entry(self, scope: Scope, key: str, index: int, etag: str) -> tuple[str, int, AsyncIterator[bytes]]:
        """读取 ZIP 里的一个文件（边读边解压，不写临时文件）；etag 是浏览时压缩包的版本，压缩包变化后要重新打开。"""
        info, source, kind = await self._open(scope, key)
        if kind != "zip":
            raise ArchiveError("只有 ZIP 压缩包可以直接查看其中的文件，其他格式请先解压")
        if info.etag != etag:
            raise ArchiveError("压缩包已被修改，请重新打开")
        entries = await self._zip_entries(scope, key, info.etag, source)
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(entries) or entries[index].is_dir:
            raise ArchiveError("压缩包里没有这个文件")
        entry = entries[index]
        if entry.encrypted:
            raise ArchiveError("加密的文件不能直接查看，请解压后打开")
        if (entry.aes[1] if entry.aes else entry.method) not in METHODS:
            raise ArchiveError("这个文件的压缩方式不支持，请用本地解压工具打开")
        relative = safe_relative(entry.name, False) or "file"
        body = zip_entry_stream(source, entry, None, memory_limit=self._memory_limit())
        return relative.rsplit("/", 1)[-1], entry.size, body

    # ----- 任务 -----

    def _prune(self) -> None:
        now = time.time()
        for job_id in [job.id for job in self.jobs.values() if job.finished_at and now - job.finished_at > JOB_KEEP]:
            del self.jobs[job_id]

    def list(self, owner: int, private: bool, ids: list[str] | None = None) -> list[dict]:
        self._prune()
        jobs = [job for job in self.jobs.values() if job.owner == owner and job.private == private and (ids is None or job.id in ids)]
        return [job.public() for job in sorted(jobs, key=lambda job: job.created_at, reverse=True)]

    def cancel(self, owner: int, private: bool, job_id: str) -> dict:
        job = self.jobs.get(job_id)
        if job is None or job.owner != owner or job.private != private:
            raise NotFoundError("任务不存在")
        if job.status in ("queued", "running") and not job.cancelled:
            job.cancelled = True
            if job.kind == "extract" and job.task is not None:
                if job.status == "queued":
                    job.status, job.finished_at = "cancelled", time.time()
                job.task.cancel()
        return job.public()

    async def start(self, owner: int, scope: Scope, key: str, destination: str, password: str | None, conflict: str, keep_archive: bool,
                    selection: object = None, *, volumes: list[str] | None = None) -> dict:
        """selection：只解压 ZIP 中的这些条目（browse 返回的 index，文件夹条目可选）；None 表示全部。
        只解压一部分时一律保留压缩包，不然没解出的文件会随压缩包一起进回收站。"""
        if conflict not in CONFLICTS:
            raise ValueError("同名文件的处理方式不正确")
        if not isinstance(keep_archive, bool):
            raise ValueError("是否保留压缩包的设置不正确")
        if password is not None and (not isinstance(password, str) or len(password) > 1024):
            raise ValueError("密码不正确")
        try:
            password_bytes = password.encode("utf-8") if password else None
        except UnicodeEncodeError:
            raise ValueError("密码含有不支持的字符") from None
        if selection is not None:
            if not isinstance(selection, list) or not selection or len(selection) > MAX_ZIP_ENTRIES \
                    or any(isinstance(item, bool) or not isinstance(item, int) or item < 0 for item in selection):
                raise ValueError("要解压的文件不正确")
            selection = set(selection)
        self._admit(owner)
        if destination.startswith(key + "/"):
            raise ValueError("不能解压到压缩包自身的位置")
        self.objects._check_scope(scope, destination + "x", write=True)
        if volumes is None:
            _, source, kind = await self._open(scope, key)
        else:
            if selection is not None:
                raise ArchiveError("分卷仅支持整包解压")
            source = await self._open_volumes(scope, key, volumes)
            if any(destination.startswith(path + "/") for path in source.keys):
                raise ArchiveError("不能解压到分卷自身的位置")
            key = source.parts[0].key
            kind, keep_archive = source.format, True
        if kind in DECODER_FORMATS and selection is not None:
            raise ArchiveError(f"{'7z' if kind == '7z' else 'RAR'} 压缩包仅支持整包解压")
        if kind == "rar" and password_bytes and b"\0" in password_bytes:
            raise ArchiveError("密码含有不支持的字符")
        plan = None
        if kind == "zip":
            entries = await self._zip_entries(scope, key, source.etag, source)
            if selection is not None and max(selection) >= len(entries):
                raise ValueError("压缩包已变化，请重新打开后选择")
            chosen = [entry for index, entry in enumerate(entries) if selection is None or index in selection]
            if any(entry.encrypted and not entry.is_dir for entry in chosen):
                if not password_bytes:
                    raise PasswordRequired("这个压缩包需要密码")
                if not await check_zip_password(source, chosen, password_bytes, memory_limit=self._memory_limit()):
                    raise ArchiveError("密码不正确")
            plan = [(entry, relative) for entry in chosen if (relative := safe_relative(entry.name, entry.is_dir)) and not ignored(relative)]
            if selection is not None:
                if not any(not entry.is_dir for entry, _ in plan):
                    raise ValueError("请至少选择一个文件")
                keep_archive = True
            files = [(entry, relative) for entry, relative in plan if not entry.is_dir]
            existing = await self.objects.metadata.run_in_thread(self._existing, scope, [destination + relative for _, relative in files])
            # 开始前按解压后的大小检查配额：跳过同名时不计已有文件，覆盖时扣掉被替换文件的大小。
            need = sum(entry.size for entry, relative in files if not (conflict == "skip" and destination + relative in existing))
            if conflict == "overwrite":
                need -= sum(existing.values())
            room = await self.objects.metadata.run_in_thread(self._room, scope)
            if room is not None and need > room:
                raise QuotaExceededError(f"空间不足：解压后需要约 {need} 字节，当前可用 {max(0, room)} 字节")
        self._admit(owner)  # 读取期间可能有其他请求已提交任务。
        job = Job(secrets.token_hex(8), owner, bool(scope.private_access), key, destination, kind, conflict, keep_archive,
                  archive_size=source.size)
        job.partial = selection is not None
        if plan is not None:
            job.total_files = sum(1 for entry, _ in plan if not entry.is_dir)
            job.total_bytes = sum(entry.size for entry, _ in plan if not entry.is_dir)
        self.jobs[job.id] = job
        job.task = asyncio.create_task(self._run(job, scope, source, plan, password_bytes))
        return job.public()

    def _admit(self, owner: int) -> None:
        self._prune()
        mine = [job for job in self.jobs.values() if job.owner == owner]
        if sum(1 for job in mine if job.status in ("queued", "running")) >= 5:
            raise ValueError("同时进行的解压与压缩任务最多 5 个，请等待完成后再试")
        if len(mine) >= JOBS_PER_USER:
            raise ValueError("解压与压缩记录过多，请稍后再试")

    async def compress(self, owner: int, scope: Scope, target: str, entries: Callable[[], AsyncIterator[tuple[str, int, float, AsyncIterator[bytes]]]],
                       files: int, total: int, deflate: bool) -> dict:
        """在线压缩：把选中的文件与文件夹边读边打包成 ZIP，直接写成网盘里的一个新文件（不写临时文件）。
        target 已同名时自动改名为「名称 (n).zip」；entries 每次调用重新生成条目（任务开始时才读取）。"""
        if not isinstance(deflate, bool):
            raise ValueError("压缩方式不正确")
        if not target.lower().endswith(".zip") or target.endswith("/"):
            raise ValueError("压缩包名称需要以 .zip 结尾")
        self._admit(owner)
        self.objects._check_scope(scope, target, write=True)
        if not files:
            raise ValueError("所选文件夹中没有可压缩的文件")
        room = await self.objects.metadata.run_in_thread(self._room, scope)
        if room is not None and total > room:
            # 不压缩时压缩包比原文件略大；Deflate 的结果事先不知道，按原大小检查。
            raise QuotaExceededError(f"空间不足：压缩包最多需要约 {total} 字节，当前可用 {max(0, room)} 字节")
        def free() -> str:
            db = self.objects.metadata.db
            exists = db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, target)).fetchone()
            return self.objects._free_name(db, scope.bucket_id, target, set()) if exists else target
        key = await self.objects.metadata.run_in_thread(free)
        job = Job(secrets.token_hex(8), owner, bool(scope.private_access), key, key[:key.rfind("/") + 1], "deflate" if deflate else "store",
                  "rename", True, kind="compress", total_files=files, total_bytes=total)
        self.jobs[job.id] = job
        job.task = asyncio.create_task(self._run_compress(job, scope, entries, deflate))
        return job.public()

    async def _run_compress(self, job: Job, scope: Scope, entries, deflate: bool) -> None:
        async with self.slots:
            if job.cancelled:
                job.status, job.finished_at = "cancelled", time.time()
                return
            job.status = "running"

            async def counted(stream: AsyncIterator[bytes]):
                async with aclosing(stream):
                    async for chunk in stream:
                        if job.cancelled:
                            raise asyncio.CancelledError()
                        job.done_bytes += len(chunk)
                        yield chunk

            async def tracked():
                async with aclosing(entries()) as items:
                    async for name, size, modified, stream in items:
                        job.current = name
                        yield name, size, modified, counted(stream)
                        job.done_files += 1

            async def output():
                async for part in stream_zip(tracked(), nested=True, deflate=deflate):
                    if job.cancelled:
                        raise asyncio.CancelledError()
                    job.read_bytes += len(part)
                    yield part
            try:
                await self.objects.put_object(scope, job.archive, output(), None, "application/zip")
                job.status, job.current = "completed", ""
            except asyncio.CancelledError:
                job.status = "cancelled"
                if not job.cancelled:
                    raise
            except QuotaExceededError:
                job.status, job.error = "failed", "空间不足，压缩没有完成"
            except (ValueError, NotFoundError, PermissionError) as exc:
                job.status, job.error = "failed", str(exc) or "压缩失败"
            except Exception:
                log.exception("在线压缩失败")
                job.status, job.error = "failed", "压缩失败，请稍后重试"
            finally:
                job.finished_at = time.time()

    def _fail(self, job: Job, name: str, error: str) -> None:
        job.failed_count += 1
        if len(job.failures) < 50:
            job.failures.append({"name": name, "error": error})

    async def _target(self, scope: Scope, job: Job, relative: str, reserved: set[str]) -> str | None:
        key = job.destination + relative
        if key == job.archive:
            self._fail(job, relative, "与压缩包本身同名，已跳过")
            return None
        exists = await self.objects.metadata.run_in_thread(
            lambda: self.objects.metadata.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key)).fetchone() is not None)
        if key in reserved or exists:
            if job.conflict == "skip":
                job.skipped += 1
                return None
            if job.conflict == "rename" or key in reserved:
                key = await self.objects.metadata.run_in_thread(lambda: self.objects._free_name(self.objects.metadata.db, scope.bucket_id, key, reserved))
                job.renamed += 1
        reserved.add(key)
        return key

    async def _write_directory(self, scope: Scope, key: str) -> None:
        exists = await self.objects.metadata.run_in_thread(
            lambda: self.objects.metadata.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key)).fetchone() is not None)
        if not exists:
            await self.objects.put_directory_marker(scope, key)

    async def _write(self, scope: Scope, job: Job, key: str, body: AsyncIterator[bytes], size: int | None) -> None:
        async def counted():
            async for chunk in body:
                if job.cancelled:
                    raise asyncio.CancelledError()
                job.done_bytes += len(chunk)
                yield chunk
        before = job.done_bytes
        try:
            # 解压任务已有并发限制。写入只占上传名额，源流可以同时领取读取名额。
            async with aclosing(body), aclosing(counted()) as stream:
                await self.objects.put_object(scope, key, stream, size, _content_type(key), buffered=True)
        except (Exception, asyncio.CancelledError) as exc:
            job.done_bytes = before
            if isinstance(exc, STORAGE_ERRORS) and not isinstance(exc, PermissionError):
                raise ArchiveWriteError(_storage_failure(exc, "写回解压文件")) from None
            raise

    @asynccontextmanager
    async def _staged_input(self, job: Job, source: Source | VolumeSource) -> AsyncIterator[None]:
        if (self._staging is None or source.size < STAGE_MIN_SIZE
                or isinstance(source, Source) and (job.format != "zip" or job.partial)):
            yield
            return

        async def chunks():
            parts = source.parts if isinstance(source, VolumeSource) else [source]
            for part in parts:
                async with aclosing(part.batches(0, part.size)) as stream:
                    async for chunk in stream:
                        yield chunk

        async with self._staging.allocate(source.size) as staged:
            if staged is None:
                yield
                return
            reader = Reader(chunks())
            ready = False
            job.staging = True
            try:
                while job.read_bytes < source.size:
                    block = await reader.exactly(min(FRAME_SIZE, source.size - job.read_bytes))
                    await staged.append(block)
                    job.read_bytes += len(block)
                await reader.drain()
                ready = True
            except StagingUnavailable:
                log.info("解压暂存不可用，改用流式读取：格式=%s，压缩包字节=%d", job.format, source.size)
            finally:
                job.staging, job.read_bytes = False, 0
                await reader.close()
            if ready:
                if isinstance(source, Source):
                    await self.objects.metadata.run_in_thread(source.check_version)
                source.staged = staged
                try:
                    yield
                    if isinstance(source, Source):
                        await self.objects.metadata.run_in_thread(source.check_version)
                finally:
                    source.staged = None
                return
        # 已释放部分暂存，再重新以有界范围读取；此时还没有解压输出。
        yield

    async def _run(self, job: Job, scope: Scope, source: Source | VolumeSource, plan, password: bytes | None) -> None:
        async with self.slots:
            if job.cancelled:
                job.status, job.finished_at = "cancelled", time.time()
                return
            job.status = "running"
            reserved: set[str] = set()
            memory_limit = DEFAULT_MEMORY_LIMIT
            try:
                packed = VolumeSource([source], job.format) if job.format in DECODER_FORMATS and isinstance(source, Source) else source
                uses_budget = (isinstance(packed, VolumeSource) or job.format in ("xz", "tar.xz")
                               or plan is not None and any((entry.aes[1] if entry.aes else entry.method) == 14 for entry, _ in plan))
                budget = self._reserve_decoder_memory(job) if uses_budget else nullcontext(DEFAULT_MEMORY_LIMIT)
                async with self._staged_input(job, packed), budget as memory_limit:
                    if isinstance(packed, VolumeSource):
                        await self._run_decoder(job, scope, packed, password.decode("utf-8") if password else None, memory_limit)
                    else:
                        packed.on_read = lambda size: setattr(job, "read_bytes", job.read_bytes + size)
                        if plan is not None:
                            await self._run_zip(job, scope, packed, plan, password, reserved, memory_limit)
                        else:
                            await self._run_stream(job, scope, packed, reserved, memory_limit)
                if not job.cancelled and isinstance(source, Source) and not job.keep_archive and not job.failed_count:
                    # 原压缩包处理完成后再结束任务，前端轮询才能看到最终结果。
                    info = await self.objects.metadata.run_in_thread(self.objects.head_object, scope, job.archive)
                    if not job.cancelled and info.etag == source.etag:
                        await self.objects.trash(scope, [job.archive])
                        job.archive_removed = True
                job.status = "cancelled" if job.cancelled else "completed"
            except asyncio.CancelledError:
                job.status = "cancelled"
            except QuotaExceededError:
                job.status, job.error = "failed", "空间不足，解压已停止；已解出的文件保留"
            except DecoderError as exc:
                job.status, job.error = "failed", str(exc)
                job.password_error = exc.code in ("encrypted", "password")
                if exc.code == "memory":
                    job.error += f"。本任务上限为 {memory_limit // MIB} MiB，可在系统设置的「下载与资源」中调整。"
            except MemoryError:
                job.status, job.error = "failed", "解压时内存不足，请联系管理员检查服务器内存和解压内存上限"
            except Exception as exc:  # noqa: BLE001 - 任务失败原因交给界面显示
                job.status = "failed"
                job.error = str(exc) if isinstance(exc, (ArchiveError, ValueError, PermissionError)) else "解压失败，请稍后重试"
                if type(exc).__name__ == "PrivateLocked":
                    job.error = "私密空间已锁定，解压已停止；已解出的文件保留"
                if not isinstance(exc, (ArchiveError, ValueError, PermissionError)):
                    log.warning("在线解压异常：格式=%s，压缩包字节=%d，已解出=%d，异常=%s",
                                job.format, job.archive_size, job.done_files, type(exc).__name__)
            finally:
                job.current = ""
                job.finished_at = time.time()

    async def _run_zip(self, job: Job, scope: Scope, source: Source, plan, password: bytes | None,
                       reserved: set[str], memory_limit: int) -> None:
        for entry, relative in plan:
            if job.cancelled:
                return
            if scope.authorize is not None:
                scope.authorize()
            job.current = relative
            if entry.is_dir:
                await self._write_directory(scope, job.destination + relative)
                continue
            key = await self._target(scope, job, relative, reserved)
            if key is None:
                continue
            try:
                body = zip_entry_stream(source, entry, password, memory_limit=memory_limit, batch_reads=True)
                await self._write(scope, job, key, body, entry.size)
                job.done_files += 1
            except (ArchiveReadError, ArchiveWriteError):
                raise
            except (ArchiveError, ValueError) as exc:
                self._fail(job, relative, str(exc) if isinstance(exc, ArchiveError) else "写入失败")

    async def _run_stream(self, job: Job, scope: Scope, source: Source, reserved: set[str], memory_limit: int) -> None:
        kind = job.format
        compression = kind.split(".", 1)[1] if kind.startswith("tar.") else kind if kind in ("gz", "bz2", "xz") else None
        source_stream = source.batches(0, job.archive_size)
        chunks = decompressed(source_stream, compression, memory_limit=memory_limit) if compression else source_stream
        if kind in ("gz", "bz2", "xz"):
            name = job.archive.rsplit("/", 1)[-1].rsplit(".", 1)[0] or "解压结果"
            relative = safe_relative(name, False) or "解压结果"
            job.total_files, job.current = 1, relative
            key = await self._target(scope, job, relative, reserved)
            if key is not None:
                await self._write(scope, job, key, chunks, None)
                job.done_files = 1
            return
        reader = Reader(chunks)
        try:
            async for member, body in tar_members(reader):
                if job.cancelled:
                    return
                if scope.authorize is not None:
                    scope.authorize()
                relative = safe_relative(member.name, member.kind == "dir")
                if relative is None or ignored(relative):
                    continue
                job.current = relative
                if member.kind == "dir":
                    await self._write_directory(scope, job.destination + relative)
                    continue
                if member.kind != "file":
                    self._fail(job, relative, "链接等特殊文件不解压")
                    continue
                key = await self._target(scope, job, relative, reserved)
                if key is None:
                    continue
                await self._write(scope, job, key, body(), member.size)
                job.done_files += 1
            if compression:
                # TAR 条目结束不代表外层 gzip／bzip2／XZ 已读到尾部校验。
                await reader.drain()
        finally:
            await reader.close()

    @asynccontextmanager
    async def _reserve_decoder_memory(self, job: Job) -> AsyncIterator[int]:
        async with self._decoder_slots:
            while True:
                memory_limit = self._memory_limit()
                if self._decoder_reserved + memory_limit <= self._decoder_budget:
                    self._decoder_reserved += memory_limit
                    job.status = "running"
                    break
                job.status = "queued"
                try:
                    # 保存较小的上限后，等待中的任务也能按新预算启动。
                    async with asyncio.timeout(0.5):
                        await self._decoder_slots.wait()
                except TimeoutError:
                    pass
        try:
            yield memory_limit
        finally:
            async with self._decoder_slots:
                self._decoder_reserved -= memory_limit
                self._decoder_slots.notify_all()

    async def _run_decoder(self, job: Job, scope: Scope, source: VolumeSource, password: str | None, memory_limit: int) -> None:
        def check():
            if job.cancelled:
                raise asyncio.CancelledError()
            if scope.authorize is not None:
                scope.authorize()

        async def read(start: int, end: int) -> bytes:
            data = await source.read(start, end)
            job.read_bytes += len(data)
            return data

        reserved = set(source.keys)
        reserved_path_bytes = sum(map(sys.getsizeof, reserved))
        rar_volumes = [part.size for part in source.parts] if source.format == "rar" else None
        numbered = bool(rar_volumes and RAR_NUMBERED_VOLUME.fullmatch(source.parts[0].key))
        await self.objects.metadata.run_in_thread(source.check_versions)
        async with open_decoder(read, source.size, check, password=password, memory_limit=memory_limit,
                                rar_volumes=rar_volumes, numbered=numbered) as decoder:
            while (entry := await decoder.next_entry()) is not None:
                name, kind, size = entry
                relative = safe_relative(name, kind == "dir")
                if not relative or ignored(relative):
                    await decoder.skip()
                    continue
                job.current = relative
                if kind == "dir":
                    await self._write_directory(scope, job.destination + relative)
                elif kind != "file":
                    self._fail(job, relative, "链接等特殊文件不解压")
                elif job.destination + relative in source.keys:
                    self._fail(job, relative, f"与{source.label}本身同名，已跳过")
                else:
                    key = await self._target(scope, job, relative, reserved)
                    if key is not None:
                        # 同名处理在主进程记录已写入的路径，按实际占用限制这部分内存。
                        reserved_path_bytes += sys.getsizeof(key)
                        if reserved_path_bytes + sys.getsizeof(reserved) > memory_limit // 8:
                            raise ArchiveError(f"{decoder.label} 解压的文件路径占用内存超出预算，解压已停止")
                        await self._write(scope, job, key, decoder.content(size), size)
                        job.done_files += 1
                        continue
                await decoder.skip()
        await self.objects.metadata.run_in_thread(source.check_versions)

    async def stop(self) -> None:
        pending = []
        for job in self.jobs.values():
            if job.task is not None and not job.task.done():
                job.cancelled = True
                pending.append(job.task)
                if not job.task.cancelling():
                    if job.status == "queued":
                        job.status, job.finished_at = "cancelled", time.time()
                    job.task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
