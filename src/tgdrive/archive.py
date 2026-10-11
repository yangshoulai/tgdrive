"""边读取对象边生成无压缩 ZIP，不落盘或在内存中拼接完整文件。"""
from __future__ import annotations

from contextlib import aclosing
from io import RawIOBase
from time import gmtime
from typing import AsyncIterator
from zipfile import ZIP_STORED, ZipFile, ZipInfo

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


async def stream_zip(entries: AsyncIterator[tuple[str, int, float, AsyncIterator[bytes]]]):
    output = _ArchiveOutput()
    try:
        async with aclosing(entries):
            with ZipFile(output, "w", compression=ZIP_STORED, allowZip64=True) as archive:
                async for name, size, modified, stream in entries:
                    if not name or "/" in name or "\\" in name or "\x00" in name or name in (".", ".."):
                        raise ValueError("invalid archive filename")
                    # ZIP 不保存时区，统一使用 UTC 并限制在 DOS 时间范围内。
                    info = ZipInfo(name, gmtime(max(315532800, min(4354819198, modified)))[:6])
                    info.file_size = size
                    written = 0
                    async with aclosing(stream):
                        # 首块解密失败时还没有 ZIP 输出，HTTP 层仍能返回正常错误。
                        first = await anext(stream, b"")
                        if len(first) > size:
                            raise IntegrityError("archive object size changed")
                        with archive.open(info, "w", force_zip64=True) as target:
                            target.write(first)
                            written += len(first)
                            first = b""
                            for part in output.drain():
                                yield part
                            async for chunk in stream:
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
