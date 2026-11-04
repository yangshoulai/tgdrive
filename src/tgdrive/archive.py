"""边读取对象边生成 ZIP（默认不压缩，在线压缩可选 Deflate），不落盘或在内存中拼接完整文件。"""
from __future__ import annotations

import asyncio
from contextlib import aclosing
from io import RawIOBase
from time import gmtime
from typing import AsyncIterator
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

from .errors import IntegrityError


class _ArchiveOutput(RawIOBase):
    def __init__(self):
        self.position = 0
        self.parts: list[bytes] = []

    def writable(self):
        return True

    def tell(self):
        return self.position

    def write(self, data):
        if data:
            self.parts.append(data if isinstance(data, bytes) else bytes(data))
            self.position += len(data)
        return len(data)

    def drain(self):
        parts, self.parts = self.parts, []
        return parts


def _valid_name(name: str, nested: bool) -> bool:
    if not name or "\\" in name or "\x00" in name or (not nested and "/" in name):
        return False
    parts = name.split("/") if nested else [name]
    return all(part not in ("", ".", "..") for part in parts)


async def stream_zip(entries: AsyncIterator[tuple[str, int, float, AsyncIterator[bytes]]], *, nested: bool = False, deflate: bool = False):
    """nested 为 True 时允许 a/b.txt 这样的相对路径（打包文件夹）；任何一段都不能为空、. 或 ..。
    deflate 为 True 时按 Deflate 压缩（在线压缩），压缩在线程里进行，不阻塞事件循环。"""
    output = _ArchiveOutput()
    try:
        async with aclosing(entries):
            with ZipFile(output, "w", compression=ZIP_DEFLATED if deflate else ZIP_STORED, compresslevel=6 if deflate else None,
                         allowZip64=True) as archive:
                async for name, size, modified, stream in entries:
                    if not _valid_name(name, nested):
                        raise ValueError("invalid archive filename")
                    # ZIP 不保存时区，统一使用 UTC 并限制在 DOS 时间范围内。
                    info = ZipInfo(name, gmtime(max(315532800, min(4354819198, modified)))[:6])
                    info.file_size = size
                    if deflate:
                        info.compress_type = ZIP_DEFLATED
                    written = 0
                    async with aclosing(stream):
                        # 首块解密失败时还没有 ZIP 输出，HTTP 层仍能返回正常错误。
                        first = await anext(stream, b"")
                        if len(first) > size:
                            raise IntegrityError("archive object size changed")
                        with archive.open(info, "w", force_zip64=True) as target:
                            write = (lambda data: asyncio.to_thread(target.write, data)) if deflate else None
                            if write:
                                await write(first)
                            else:
                                target.write(first)
                            written += len(first)
                            first = b""
                            for part in output.drain():
                                yield part
                            async for chunk in stream:
                                if write:
                                    await write(chunk)
                                else:
                                    target.write(chunk)
                                written += len(chunk)
                                if written > size:
                                    raise IntegrityError("archive object size changed")
                                for part in output.drain():
                                    yield part
                            if written != size:
                                raise IntegrityError("archive object is incomplete")
                        for part in output.drain():
                            yield part
            for part in output.drain():
                yield part
    finally:
        output.parts.clear()
        output.close()
