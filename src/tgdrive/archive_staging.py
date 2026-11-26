"""大压缩包可选的加密暂存。磁盘上只存压缩输入，文件描述符关闭即释放空间。"""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from collections.abc import AsyncIterator, Callable
from contextlib import ExitStack, asynccontextmanager
from pathlib import Path
from typing import BinaryIO

from .crypto import NONCE_SIZE, TAG_SIZE, new_dek, open_sealed, seal

FRAME_SIZE = 1024 * 1024
OVERHEAD = NONCE_SIZE + TAG_SIZE


class StagingUnavailable(Exception):
    """暂存空间或写入不可用，可以改从存储直接读取。"""


async def _disk_io(function, /, *args):
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # 等待当前这一个块的磁盘操作退出，再关闭匿名文件并释放预算。
        await asyncio.gather(task, return_exceptions=True)
        raise


class ArchiveStaging:
    def __init__(self, directory: Path, reserve: Callable[[], int], *, enabled: Callable[[], bool] | None = None):
        self.directory, self.reserve, self.enabled = directory, reserve, enabled
        self._unwritten = 0
        self._write_lock = asyncio.Lock()

    def _has_space(self, size: int) -> bool:
        try:
            return shutil.disk_usage(self.directory).free >= self.reserve() + size
        except OSError:
            return False

    @asynccontextmanager
    async def allocate(self, size: int) -> AsyncIterator[StagedArchive | None]:
        needed = size + ((size + FRAME_SIZE - 1) // FRAME_SIZE) * OVERHEAD
        if (self.enabled is not None and not self.enabled()) or not self._has_space(needed + self._unwritten + FRAME_SIZE):
            yield None
            return
        with ExitStack() as files:
            try:
                # Unix 上无可见文件名，服务被强杀或重启时内核也会回收；文件描述符不传给解码进程。
                file = files.enter_context(tempfile.TemporaryFile(mode="w+b", buffering=0, dir=self.directory))
            except OSError:
                yield None
                return
            staged = StagedArchive(self, file, size)
            self._unwritten += needed
            try:
                yield staged
            finally:
                self._unwritten -= needed - staged.written


class StagedArchive:
    def __init__(self, pool: ArchiveStaging, file: BinaryIO, size: int):
        self.pool, self.file, self.size = pool, file, size
        self._key = new_dek()
        self.written = 0
        self._frame_number, self._frame = -1, b""

    def _append(self, data: bytes) -> int:
        index = self.written // (FRAME_SIZE + OVERHEAD)
        record = seal(self._key, data, index.to_bytes(8, "big"))
        if self.file.write(record) != len(record):
            raise StagingUnavailable()
        return len(record)

    async def append(self, data: bytes) -> None:
        async with self.pool._write_lock:
            # 保留空间还可能被其他模块或进程使用；每块落盘前复核。
            if not self.pool._has_space(len(data) + OVERHEAD + FRAME_SIZE):
                raise StagingUnavailable()
            try:
                written = await _disk_io(self._append, data)
            except OSError:
                raise StagingUnavailable() from None
            self.written += written
            self.pool._unwritten -= written

    def _read_frame(self, index: int) -> bytes:
        start = index * FRAME_SIZE
        self.file.seek(index * (FRAME_SIZE + OVERHEAD))
        record = self.file.read(min(FRAME_SIZE, self.size - start) + OVERHEAD)
        return open_sealed(self._key, record, index.to_bytes(8, "big"))

    async def stream(self, start: int, end: int) -> AsyncIterator[bytes]:
        while start < end:
            index, offset = divmod(start, FRAME_SIZE)
            if index != self._frame_number:
                self._frame = await _disk_io(self._read_frame, index)
                self._frame_number = index
            size = min(end - start, len(self._frame) - offset)
            if size <= 0:
                raise StagingUnavailable()
            yield self._frame[offset:offset + size]
            start += size

    async def read(self, start: int, end: int) -> bytes:
        return b"".join([piece async for piece in self.stream(start, end)])
