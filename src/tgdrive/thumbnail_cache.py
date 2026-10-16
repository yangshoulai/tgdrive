"""缩略图专用的短期密文缓存：只保留已经传输的字节，不在缓存缺失时访问远端。"""

from __future__ import annotations

import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass

from .filekinds import kind_of


MIB = 1024 * 1024


class ThumbnailCacheMiss(Exception):
    pass


@dataclass
class _Segment:
    blob: str
    ref: str
    start: int
    size: int
    file: object


class ThumbnailCache:
    """缓存现有加密分片／范围；匿名临时文件关闭即删除，不保存明文或解密密钥。"""

    def __init__(self, *, limit=128 * MIB, per_blob=64 * MIB + MIB, ttl=900):
        self.limit, self.per_blob, self.ttl = limit, per_blob, ttl
        self._lock = threading.RLock()
        self._blobs = OrderedDict()
        self._segments = OrderedDict()
        self._serial = self._size = 0
        self.on_data = None

    def prepare(self, blob, key, content_type=None):
        kind = kind_of(key, content_type)
        if kind not in ("image", "video", "audio") or key.endswith("/"):
            return
        if key.startswith(".tgdrive/") and not key.startswith(".tgdrive/private/"):
            return
        if key.lower().endswith(".svg") or "svg" in (content_type or "").lower():
            return
        with self._lock:
            self._prune()
            self._blobs[blob] = (time.monotonic(), self._blobs.get(blob, (0, 0))[1])
            self._blobs.move_to_end(blob)
            while len(self._blobs) > 256:
                self.drop(next(iter(self._blobs)))

    def _remove(self, identity):
        item = self._segments.pop(identity)
        self._size -= item.size
        item.file.close()

    def _prune(self):
        now = time.monotonic()
        for blob, (at, _) in list(self._blobs.items()):
            if now - at >= self.ttl:
                self.drop(blob)

    def put(self, blob, ref, start, data):
        notify = False
        with self._lock:
            self._prune()
            if blob not in self._blobs or not data or len(data) > self.per_blob:
                return
            segments = [(identity, item) for identity, item in self._segments.items() if item.blob == blob]
            if any(item.ref == ref and item.start <= start and item.start + item.size >= start + len(data) for _, item in segments):
                return
            for identity, item in segments:
                if item.ref == ref and start <= item.start and start + len(data) >= item.start + item.size:
                    self._remove(identity)
            # 大文件只留有界的数据窗口；不能为缩略图把整个视频缓存到服务器。
            while self._segments and (self._size + len(data) > self.limit or len(self._segments) >= 512):
                self._remove(next(iter(self._segments)))
            # 保留早期分片及最近收到的尾部，兼顾图片、音频标签和位于 MP4 尾部的索引。
            while sum(item.size for item in self._segments.values() if item.blob == blob) + len(data) > self.per_blob:
                victim = next((identity for identity, item in reversed(self._segments.items()) if item.blob == blob), None)
                if victim is None:
                    return
                self._remove(victim)
            try:
                file = tempfile.TemporaryFile(prefix="tessera-thumb-cipher-")
                file.write(data)
            except OSError:
                if "file" in locals():
                    file.close()
                return  # 缓存不能让正常上传或预览失败。
            self._serial += 1
            self._segments[self._serial] = _Segment(blob, ref, start, len(data), file)
            self._size += len(data)
            self._blobs[blob] = (time.monotonic(), self._serial)
            notify = True
        if notify and self.on_data is not None:
            self.on_data(blob)

    def get(self, blob, ref, start, end):
        with self._lock:
            self._prune()
            position, pieces = start, []
            segments = sorted((item for item in self._segments.values() if item.blob == blob and item.ref == ref), key=lambda item: item.start)
            for item in segments:
                if item.start > position:
                    break
                if item.start + item.size <= position:
                    continue
                size = min(end, item.start + item.size) - position
                item.file.seek(position - item.start)
                piece = item.file.read(size)
                if len(piece) != size:
                    break
                pieces.append(piece)
                position += size
                if position >= end:
                    return b"".join(pieces)
            raise ThumbnailCacheMiss("等待已接收的数据，不自动下载原文件")

    def revision(self, blob):
        with self._lock:
            self._prune()
            return self._blobs.get(blob, (0, 0))[1]

    def drop(self, blob):
        with self._lock:
            self._blobs.pop(blob, None)
            for identity, item in list(self._segments.items()):
                if item.blob == blob:
                    self._remove(identity)

    def close(self):
        with self._lock:
            for identity in list(self._segments):
                self._remove(identity)
            self._blobs.clear()

    def status(self):
        with self._lock:
            self._prune()
            return {"bytes": self._size, "limit_bytes": self.limit, "ttl_seconds": self.ttl}
