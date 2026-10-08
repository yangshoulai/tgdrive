"""BlobStore 抽象和测试/单机用本地实现。"""

from __future__ import annotations

import asyncio
import os
import secrets
from pathlib import Path
from typing import Protocol

from .errors import BlobNotFound


class BlobStore(Protocol):
    async def put(self, key: str, data: bytes) -> str: ...
    async def get(self, ref: str, start: int | None = None, end: int | None = None) -> bytes: ...
    async def delete(self, ref: str) -> None: ...


class LocalDiskBlobStore:
    """按前两位分目录保存，写入临时文件后原子替换，拒绝路径穿越。"""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, ref: str) -> Path:
        if len(ref) != 32 or any(c not in "0123456789abcdef" for c in ref):
            raise ValueError("invalid local blob reference")
        path = (self.root / ref[:2] / ref).resolve()
        if self.root not in path.parents:
            raise ValueError("blob path escapes root")
        return path

    async def put(self, key: str, data: bytes) -> str:
        # key 只作为随机性提示；引用本身始终是不可预测的 128-bit 名称。
        ref = secrets.token_hex(16)
        path = self._path(ref)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
        await asyncio.to_thread(tmp.write_bytes, data)
        await asyncio.to_thread(os.replace, tmp, path)
        return ref

    async def get(self, ref: str, start: int | None = None, end: int | None = None) -> bytes:
        path = self._path(ref)
        if not path.is_file():
            raise BlobNotFound(ref)
        def read() -> bytes:
            with path.open("rb") as fh:
                if start is not None:
                    fh.seek(start)
                return fh.read(None if end is None else max(0, end - (start or 0)))
        return await asyncio.to_thread(read)

    async def delete(self, ref: str) -> None:
        path = self._path(ref)
        try:
            await asyncio.to_thread(path.unlink)
        except FileNotFoundError:
            return
