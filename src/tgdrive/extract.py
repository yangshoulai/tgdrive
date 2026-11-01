"""在线解压：把存储里的 ZIP／TAR 压缩包解到同一账号的文件空间。

全程流式，不写本地临时文件：按字节范围从存储读取压缩包 → 内存中解密、解压 → 直接写回存储（put_object），
所以服务器本机磁盘大小不受影响，只受账号配额限制（开始前按解压后大小检查）。

- ZIP：读中央目录得到全部条目（支持 ZIP64、UTF-8／GBK 文件名、存储／Deflate／BZip2／LZMA），每个条目是一段连续字节，
  单独按范围读取；支持传统 ZipCrypto 与 WinZip AES 密码。
- TAR（含 .tar.gz／.tgz／.tar.bz2／.tar.xz）：顺序读一遍；单个 .gz／.bz2／.xz 文件解出一个文件。
- 7z、RAR 需要外部程序，不支持。

任务只在进程内存里（重启后丢失，已解出的文件保留）；密码只在任务运行期间留在内存，不写日志、审计或接口回显。
"""

from __future__ import annotations

import asyncio
import bz2
import hashlib
import hmac
import lzma
import re
import secrets
import struct
import time
import unicodedata
import zlib
from dataclasses import dataclass, field, replace
from typing import AsyncIterator, Callable

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from .errors import NotFoundError, QuotaExceededError
from .objects import PRIVATE_PREFIX, ObjectService, Scope

MAX_ENTRIES = 50_000          # 一个压缩包最多处理的条目数
MAX_CENTRAL = 64 * 1024 * 1024  # 中央目录最大字节数
CHUNK = 1024 * 1024           # 解压输出分块
SAMPLE = 500                  # 预览列出的条目数
JOB_KEEP = 3600               # 已结束任务保留时间（秒）
JOBS_PER_USER = 50
RUNNING = 2                   # 全站同时进行的解压任务数
ARCHIVE_TYPES = re.compile(r"\.(zip|tar|tgz|tbz2?|txz|tar\.(?:gz|bz2|xz)|gz|bz2|xz)$", re.IGNORECASE)
UNSUPPORTED = re.compile(r"\.(7z|rar|zst|tar\.zst|iso|cab|arj|lzh)$", re.IGNORECASE)
CONFLICTS = ("skip", "overwrite", "rename")


class ArchiveError(ValueError):
    """压缩包本身的问题（格式、密码、损坏）；按 400 返回。"""


class PasswordRequired(ArchiveError):
    pass


# ---------- 读取存储里的压缩包 ----------

class Source:
    """按字节范围读取压缩包；每次读取都复核版本与（私密空间的）授权。"""

    def __init__(self, objects: ObjectService, scope: Scope, key: str, etag: str, size: int, on_read: Callable[[int], None] | None = None):
        self.objects, self.scope, self.key, self.etag, self.size, self.on_read = objects, scope, key, etag, size, on_read

    async def stream(self, start: int, end: int) -> AsyncIterator[bytes]:
        if self.scope.authorize is not None:
            self.scope.authorize()
        info, body = await self.objects.get_object(self.scope, self.key, start, end)
        if info.etag != self.etag:
            await body.aclose()
            raise ArchiveError("压缩包已被修改，请重新开始解压")
        try:
            async for chunk in body:
                if self.scope.authorize is not None:
                    self.scope.authorize()
                if self.on_read:
                    self.on_read(len(chunk))
                yield chunk
        finally:
            await body.aclose()

    async def read(self, start: int, end: int) -> bytes:
        parts = [chunk async for chunk in self.stream(start, end)]
        return b"".join(parts)


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
    if total > MAX_ENTRIES:
        raise ArchiveError(f"压缩包里的条目太多（超过 {MAX_ENTRIES} 个）")
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


async def zip_entry_stream(source: Source, entry: ZipEntry, password: bytes | None) -> AsyncIterator[bytes]:
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
    reader = Reader(source.stream(start, end))
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
        decompressor = _decompressor(method) if method != 14 else None
        lzma_ready = method != 14
        crc, produced = 0, 0
        while remaining > 0:
            data = await reader.some(min(CHUNK, remaining))
            if not data:
                raise ArchiveError("压缩包不完整或已损坏")
            remaining -= len(data)
            if decrypt is not None:
                data = await asyncio.to_thread(decrypt, data) if slow or len(data) > 65536 else decrypt(data)
            if not lzma_ready:
                # ZIP 里的 LZMA：2 字节版本、2 字节属性长度、属性，之后是原始 LZMA1 数据。
                if len(data) < 4:
                    raise ArchiveError("LZMA 条目头无效")
                (props_length,) = struct.unpack_from("<H", data, 2)
                props = data[4:4 + props_length]
                decompressor = lzma.LZMADecompressor(lzma.FORMAT_RAW, filters=[lzma._decode_filter_properties(lzma.FILTER_LZMA1, props)])
                data, lzma_ready = data[4 + props_length:], True
            output = data if decompressor is None else await asyncio.to_thread(decompressor.decompress, data)
            if output:
                produced += len(output)
                if produced > entry.size:
                    raise ArchiveError("解压后的大小与记录不符，已停止（可能是压缩炸弹或文件损坏）")
                crc = zlib.crc32(output, crc)
                for index in range(0, len(output), CHUNK):
                    yield output[index:index + CHUNK]
        if method == 8:
            tail = decompressor.flush()
            if tail:
                produced += len(tail)
                if produced > entry.size:
                    raise ArchiveError("解压后的大小与记录不符，已停止（可能是压缩炸弹或文件损坏）")
                crc = zlib.crc32(tail, crc)
                yield tail
        if aes is not None:
            aes.verify(await reader.exactly(10))
        if produced != entry.size:
            raise ArchiveError("解压后的大小与记录不符，文件可能已损坏")
        # AE-2 不存 CRC，只靠 HMAC 校验。
        if not (entry.aes and entry.aes_version == 2) and crc != entry.crc:
            raise ArchiveError("文件校验失败：" + ("密码不正确或" if entry.encrypted else "") + "压缩包已损坏")
    finally:
        await reader.close()


async def check_zip_password(source: Source, entries: list[ZipEntry], password: bytes) -> bool:
    """只检查第一个加密条目的密码校验字节（AES 为派生的校验值，传统加密为解密后的头部），不解出内容。"""
    entry = next((item for item in entries if item.encrypted and not item.is_dir), None)
    if entry is None:
        return True
    stream = zip_entry_stream(source, entry, password)
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

def _stream_decompressor(kind: str):
    if kind == "gz":
        return zlib.decompressobj(31)
    if kind == "bz2":
        return bz2.BZ2Decompressor()
    if kind == "xz":
        return lzma.LZMADecompressor()
    return None


async def decompressed(chunks: AsyncIterator[bytes], kind: str) -> AsyncIterator[bytes]:
    decompressor = _stream_decompressor(kind)
    if decompressor is None:
        async for chunk in chunks:
            yield chunk
        return
    async for chunk in chunks:
        while chunk:
            output = await asyncio.to_thread(decompressor.decompress, chunk)
            chunk = b""
            if output:
                yield output
            # gzip 可能由多段拼接：一段结束后继续解剩下的数据。
            if kind == "gz" and decompressor.eof and decompressor.unused_data:
                chunk, decompressor = decompressor.unused_data, zlib.decompressobj(31)
    if kind == "gz":
        tail = decompressor.flush()
        if tail:
            yield tail


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
    if head[:6] == b"7z\xbc\xaf\x27\x1c" or head[:7] == b"Rar!\x1a\x07":
        raise ArchiveError("暂不支持 7z 与 RAR 格式，只支持 ZIP 与 TAR（含 .tar.gz、.tar.bz2、.tar.xz）")
    if len(head) >= 262 and head[257:262] == b"ustar":
        return "tar"
    compressed = "gz" if head[:2] == b"\x1f\x8b" else "bz2" if head[:3] == b"BZh" else "xz" if head[:6] == b"\xfd7zXZ\0" else None
    if compressed:
        tarred = re.search(r"\.(tar\.(gz|bz2|xz)|tgz|tbz2?|txz)$", lower)
        return f"tar.{compressed}" if tarred else compressed
    if lower.endswith(".zip"):
        raise ArchiveError("不是有效的 ZIP 压缩包")
    if UNSUPPORTED.search(lower):
        raise ArchiveError("暂不支持这种压缩格式，只支持 ZIP 与 TAR（含 .tar.gz、.tar.bz2、.tar.xz）")
    raise ArchiveError("无法识别压缩格式，只支持 ZIP 与 TAR（含 .tar.gz、.tar.bz2、.tar.xz）")


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

    def public(self) -> dict:
        return {"id": self.id, "private": self.private, "archive": self.archive, "destination": self.destination, "format": self.format,
                "conflict": self.conflict, "keep_archive": self.keep_archive, "status": self.status,
                "total_files": self.total_files, "total_bytes": self.total_bytes, "archive_size": self.archive_size, "read_bytes": self.read_bytes,
                "done_files": self.done_files, "done_bytes": self.done_bytes, "skipped": self.skipped, "renamed": self.renamed,
                "failed": self.failed_count, "failures": self.failures[:20], "current": self.current, "error": self.error,
                "archive_removed": self.archive_removed, "created_at": self.created_at, "finished_at": self.finished_at}


def _content_type(key: str) -> str | None:
    from .offline.service import _stored_type
    return _stored_type(key, None)


class ArchiveService:
    def __init__(self, objects: ObjectService):
        self.objects = objects
        self.jobs: dict[str, Job] = {}
        self.slots = asyncio.Semaphore(RUNNING)

    # ----- 预览 -----

    async def _open(self, scope: Scope, key: str):
        if key.endswith("/"):
            raise ArchiveError("请选择一个压缩包文件")
        info = await self.objects.metadata.run_in_thread(self.objects.head_object, scope, key)
        if info.size <= 0:
            raise ArchiveError("压缩包是空文件")
        source = Source(self.objects, scope, key, info.etag, info.size)
        head = await source.read(0, min(info.size, 512))
        return info, source, archive_format(key.rsplit("/", 1)[-1], head)

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

    async def inspect(self, scope: Scope, key: str, destination: str | None, password: str | None) -> dict:
        info, source, kind = await self._open(scope, key)
        result: dict = {"format": kind, "size": info.size, "room": await self.objects.metadata.run_in_thread(self._room, scope)}
        if kind != "zip":
            # TAR 没有目录索引，要读完整个压缩包才知道内容；解压时边读边写，配额不足会停止。
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
            result["password_ok"] = await check_zip_password(source, entries, password.encode("utf-8"))
        if destination is not None:
            targets = [destination + relative for entry, relative in usable if not entry.is_dir]
            existing = await self.objects.metadata.run_in_thread(self._existing, scope, targets)
            result["conflicts"] = len(existing)
            result["conflict_bytes"] = sum(existing.values())
        return result

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
            raise NotFoundError("解压任务不存在")
        if job.status in ("queued", "running"):
            job.cancelled = True
        return job.public()

    async def start(self, owner: int, scope: Scope, key: str, destination: str, password: str | None, conflict: str, keep_archive: bool) -> dict:
        if conflict not in CONFLICTS:
            raise ValueError("同名文件的处理方式不正确")
        if not isinstance(keep_archive, bool):
            raise ValueError("是否保留压缩包的设置不正确")
        if password is not None and (not isinstance(password, str) or len(password) > 1024):
            raise ValueError("密码不正确")
        self._prune()
        mine = [job for job in self.jobs.values() if job.owner == owner]
        if sum(1 for job in mine if job.status in ("queued", "running")) >= 5:
            raise ValueError("同时进行的解压任务最多 5 个，请等待完成后再试")
        if len(mine) >= JOBS_PER_USER:
            raise ValueError("解压记录过多，请稍后再试")
        if destination.startswith(key + "/"):
            raise ValueError("不能解压到压缩包自身的位置")
        self.objects._check_scope(scope, destination + "x", write=True)
        info, source, kind = await self._open(scope, key)
        plan = None
        if kind == "zip":
            entries = await read_zip(source)
            if any(entry.encrypted and not entry.is_dir for entry in entries):
                if not password:
                    raise PasswordRequired("这个压缩包需要密码")
                if not await check_zip_password(source, entries, password.encode("utf-8")):
                    raise ArchiveError("密码不正确")
            plan = [(entry, relative) for entry in entries if (relative := safe_relative(entry.name, entry.is_dir)) and not ignored(relative)]
            files = [(entry, relative) for entry, relative in plan if not entry.is_dir]
            existing = await self.objects.metadata.run_in_thread(self._existing, scope, [destination + relative for _, relative in files])
            # 开始前按解压后的大小检查配额：跳过同名时不计已有文件，覆盖时扣掉被替换文件的大小。
            need = sum(entry.size for entry, relative in files if not (conflict == "skip" and destination + relative in existing))
            if conflict == "overwrite":
                need -= sum(existing.values())
            room = await self.objects.metadata.run_in_thread(self._room, scope)
            if room is not None and need > room:
                raise QuotaExceededError(f"空间不足：解压后需要约 {need} 字节，当前可用 {max(0, room)} 字节")
        job = Job(secrets.token_hex(8), owner, bool(scope.private_access), key, destination, kind, conflict, keep_archive,
                  archive_size=info.size)
        if plan is not None:
            job.total_files = sum(1 for entry, _ in plan if not entry.is_dir)
            job.total_bytes = sum(entry.size for entry, _ in plan if not entry.is_dir)
        self.jobs[job.id] = job
        job.task = asyncio.create_task(self._run(job, scope, info.etag, plan, password.encode("utf-8") if password else None))
        return job.public()

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

    async def _write(self, scope: Scope, job: Job, key: str, body: AsyncIterator[bytes], size: int | None) -> None:
        async def counted():
            async for chunk in body:
                if job.cancelled:
                    raise asyncio.CancelledError()
                job.done_bytes += len(chunk)
                yield chunk
        await self.objects.put_object(scope, key, counted(), size, _content_type(key))

    async def _run(self, job: Job, scope: Scope, etag: str, plan, password: bytes | None) -> None:
        async with self.slots:
            if job.cancelled:
                job.status, job.finished_at = "cancelled", time.time()
                return
            job.status = "running"
            source = Source(self.objects, scope, job.archive, etag, job.archive_size,
                            on_read=lambda size: setattr(job, "read_bytes", job.read_bytes + size))
            reserved: set[str] = set()
            try:
                if plan is not None:
                    await self._run_zip(job, scope, source, plan, password, reserved)
                else:
                    await self._run_stream(job, scope, source, reserved)
                if job.cancelled:
                    job.status = "cancelled"
                else:
                    job.status = "completed"
                    if not job.keep_archive and not job.failed_count:
                        # 解压全部成功才移走原压缩包，放进回收站，可以还原。
                        info = await self.objects.metadata.run_in_thread(self.objects.head_object, scope, job.archive)
                        if info.etag == etag:
                            await self.objects.trash(scope, [job.archive])
                            job.archive_removed = True
            except asyncio.CancelledError:
                job.status = "cancelled"
            except QuotaExceededError:
                job.status, job.error = "failed", "空间不足，解压已停止；已解出的文件保留"
            except Exception as exc:  # noqa: BLE001 - 任务失败原因交给界面显示
                job.status = "failed"
                job.error = str(exc) if isinstance(exc, (ArchiveError, ValueError, PermissionError)) else "解压失败，请稍后重试"
                if type(exc).__name__ == "PrivateLocked":
                    job.error = "私密空间已锁定，解压已停止；已解出的文件保留"
            finally:
                job.current = ""
                job.finished_at = time.time()

    async def _run_zip(self, job: Job, scope: Scope, source: Source, plan, password: bytes | None, reserved: set[str]) -> None:
        for entry, relative in plan:
            if job.cancelled:
                return
            if scope.authorize is not None:
                scope.authorize()
            job.current = relative
            if entry.is_dir:
                key = job.destination + relative
                exists = await self.objects.metadata.run_in_thread(
                    lambda: self.objects.metadata.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key)).fetchone() is not None)
                if not exists:
                    await self.objects.put_directory_marker(scope, key)
                continue
            key = await self._target(scope, job, relative, reserved)
            if key is None:
                continue
            before = job.done_bytes
            try:
                await self._write(scope, job, key, zip_entry_stream(source, entry, password), entry.size)
                job.done_files += 1
            except (ArchiveError, ValueError) as exc:
                if isinstance(exc, ArchiveError) and "已被修改" in str(exc):
                    raise
                job.done_bytes = before + entry.size
                self._fail(job, relative, str(exc) if isinstance(exc, ArchiveError) else "写入失败")

    async def _run_stream(self, job: Job, scope: Scope, source: Source, reserved: set[str]) -> None:
        kind = job.format
        compression = kind.split(".", 1)[1] if kind.startswith("tar.") else kind if kind in ("gz", "bz2", "xz") else None
        chunks = decompressed(source.stream(0, job.archive_size), compression) if compression else source.stream(0, job.archive_size)
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
                    key = job.destination + relative
                    exists = await self.objects.metadata.run_in_thread(
                        lambda: self.objects.metadata.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key)).fetchone() is not None)
                    if not exists:
                        await self.objects.put_directory_marker(scope, key)
                    continue
                if member.kind != "file":
                    self._fail(job, relative, "链接等特殊文件不解压")
                    continue
                key = await self._target(scope, job, relative, reserved)
                if key is None:
                    continue
                await self._write(scope, job, key, body(), member.size)
                job.done_files += 1
        finally:
            await reader.close()

    async def stop(self) -> None:
        for job in self.jobs.values():
            job.cancelled = True
            if job.task is not None and not job.task.done():
                job.task.cancel()
