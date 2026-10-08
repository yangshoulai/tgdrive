"""内容指纹：用于秒传的、与上传方式无关的文件内容标识。

按固定的 16 MiB 分块（最后一块可以更短）分别计算 SHA-256，再把「版本标签 + 文件大小 + 全部块哈希」
一起哈希得到指纹。服务端在写入时顺带计算每块的哈希，不需要事后重读对象；网页端和脚本用同样的方式
计算后即可与服务端比对。算法属于对外约定（见文档站「秒传」一节），改动分块大小或标签会让已有指纹失效。
"""

from __future__ import annotations

import hashlib

BLOCK_SIZE = 16 * 1024 * 1024
DIGEST_SIZE = 32
_TAG = b"tgdrive-fp-v1\n"


class BlockHasher:
    """流式切块：喂入任意大小的数据，按 block_size 对齐输出每块的 SHA-256。"""

    def __init__(self, block_size: int = BLOCK_SIZE) -> None:
        if block_size <= 0:
            raise ValueError("block_size must be positive")
        self.block_size = block_size
        self._leaves: list[bytes] = []
        self._current = hashlib.sha256()
        self._filled = 0
        self.size = 0

    def update(self, data: bytes | bytearray | memoryview) -> None:
        view = memoryview(data)
        self.size += len(view)
        while len(view):
            take = min(len(view), self.block_size - self._filled)
            self._current.update(view[:take])
            self._filled += take
            view = view[take:]
            if self._filled == self.block_size:
                self._leaves.append(self._current.digest())
                self._current, self._filled = hashlib.sha256(), 0

    def finish(self) -> bytes:
        """返回按顺序拼接的块哈希；未满一块的尾部也算一块。"""
        if self._filled:
            self._leaves.append(self._current.digest())
            self._current, self._filled = hashlib.sha256(), 0
        return b"".join(self._leaves)


def combine(size: int, leaves: bytes) -> str:
    """由文件大小和拼接后的块哈希得到最终指纹（64 位十六进制）。"""
    if len(leaves) % DIGEST_SIZE:
        raise ValueError("leaves must be a multiple of 32 bytes")
    return hashlib.sha256(_TAG + size.to_bytes(8, "big") + leaves).hexdigest()


def is_fingerprint(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(ch in "0123456789abcdef" for ch in value)
