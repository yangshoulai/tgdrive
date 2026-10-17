"""加密分片 Blob 引擎：写入 part、定稿、范围读取和 scrub。"""

from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from collections import deque
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass
from contextlib import aclosing

from .blobstore import BlobStore
from .crypto import (
    FORMAT_VERSION,
    FileKey,
    cipher_range,
    decrypt_range,
    encrypt_chunk,
    new_dek,
    open_sealed,
    seal,
    thumbnail_key,
    unwrap_dek,
    wrap_dek,
)
from .errors import IntegrityError, InvalidStateError, NotFoundError
from .fingerprint import BLOCK_SIZE, BlockHasher
from .keystore import KeyStore
from .metadata import BlobRecord, ChunkRecord, Metadata
from .thumbnail_cache import ThumbnailCacheMiss
from .work import Limiter, RateLimiter, TransferSlots, WorkBusyError

# 小对象读取通道：并发数、单个对象上限与排队等待时间。
SMALL_READ_CONCURRENCY = 4
SMALL_READ_LIMIT = 1024 * 1024
SMALL_READ_WAIT = 60


@dataclass(frozen=True)
class PartResult:
    blob_uuid: str
    part_no: int
    size: int
    md5: str
    chunks: int
    # 本分段按 fingerprint_block 切块后各块 SHA-256 的拼接，用于计算内容指纹（见 fingerprint.py）。
    leaves: bytes = b""


class BlobEngine:
    def __init__(self, metadata: Metadata, store: BlobStore, kek: bytes | None = None,
                 *, keystore: KeyStore | None = None,
                 chunk_size: int = 16 * 1024 * 1024, frame_size: int = 64 * 1024,
                 transfer_concurrency: int = 4, bucket_concurrency: int = 2) -> None:
        if chunk_size <= 0 or frame_size <= 0:
            raise ValueError("chunk_size and frame_size must be positive")
        self.metadata, self.store, self.kek = metadata, store, kek
        if kek is None and keystore is None:
            raise ValueError("either kek or keystore is required")
        self.keystore = keystore
        self.chunk_size, self.frame_size = chunk_size, frame_size
        # 同一个分段内并行写入后端的分片数；内存上限约为 (并发数 + 1) × chunk_size。
        self.upload_concurrency = 3
        # 下载时提前取回并解密的窗口数；内存上限约为 (预读数 + 1) × 读取窗口。
        self.read_ahead = 2
        self.fingerprint_block = BLOCK_SIZE
        self.transfers = TransferSlots(transfer_concurrency, bucket_concurrency)
        # 缩略图大图等小对象的独立读取通道：网格视图会一次请求几十张，不能和下载、预览争抢传输名额。
        self.small_reads = asyncio.Semaphore(SMALL_READ_CONCURRENCY)
        # 全局写入存储（Telegram 发送）的分片数与平均速率，由「下载与资源」配置随时调整。
        # 每个在途分片约占明文加密文两份内存（约 32 MB）。
        self.upload_slots = Limiter(4)
        self.upload_rate = RateLimiter(0)
        self.thumbnail_cache = None
        self._thumbnail_read_lock = asyncio.Lock()

    def _kek(self) -> bytes:
        if self.keystore is not None:
            return self.keystore.require_kek()
        assert self.kek is not None
        return self.kek

    def begin_blob(self) -> str:
        blob_uuid = str(uuid.uuid4())
        record = BlobRecord(blob_uuid, None, self.chunk_size, self.frame_size,
                            wrap_dek(self._kek(), new_dek(), blob_uuid), "uploading", 0)
        self.metadata.create_blob(record, time.time())
        return blob_uuid

    @staticmethod
    def _blob_key(blob_uuid: str) -> bytes:
        """按 v2.0 约定将 UUID 以 16 字节形式用于 HKDF info。"""
        try:
            return uuid.UUID(blob_uuid).bytes
        except ValueError:
            return blob_uuid.encode("ascii")

    def _thumbnail_key(self, blob_uuid: str) -> bytes:
        record = self.metadata.get_blob(blob_uuid)
        return thumbnail_key(unwrap_dek(self._kek(), record.wrapped_dek, blob_uuid), self._blob_key(blob_uuid))

    def seal_thumbnail(self, blob_uuid: str, variant: str, data: bytes) -> bytes:
        """缩略图用该 Blob 的 DEK 派生密钥加密，附加数据绑定规格，不能挪作其他规格或其他文件使用。"""
        return seal(self._thumbnail_key(blob_uuid), data, f"thumbnail:{variant}")

    def open_thumbnail(self, blob_uuid: str, variant: str, sealed: bytes) -> bytes:
        return open_sealed(self._thumbnail_key(blob_uuid), sealed, f"thumbnail:{variant}")

    async def put_part(self, blob_uuid: str, part_no: int, body: AsyncIterator[bytes] | Iterable[bytes] | bytes,
                       *, bucket_id: int | None = None) -> PartResult:
        # 在读取请求体前取得名额，让 ASGI 的背压限制尚未获准的上传。
        async with self.transfers.slot(bucket_id):
            return await self._put_part(blob_uuid, part_no, body)

    async def _put_part(self, blob_uuid: str, part_no: int, body: AsyncIterator[bytes] | Iterable[bytes] | bytes) -> PartResult:
        if part_no < 1 or part_no > 10000:
            raise ValueError("part_no must be between 1 and 10000")
        record = self.metadata.get_blob(blob_uuid)
        if record.status != "uploading":
            raise InvalidStateError("cannot upload a part after finalize")
        dek = unwrap_dek(self._kek(), record.wrapped_dek, blob_uuid)
        fk = FileKey(dek, self._blob_key(blob_uuid), record.frame_size)
        md5 = hashlib.md5()
        blocks = BlockHasher(self.fingerprint_block)
        pending: list[ChunkRecord] = []
        old_refs: list[str] = []
        old = self.metadata.list_chunks(blob_uuid, part_no=part_no)
        old_refs.extend(c.blob_ref for c in old)
        total = 0
        # 用片段列表攒满一个分片再拼接。不要用 bytearray 追加后 del 头部：CPython 会让其底层分配不断增长，
        # 上传 400 MB 时进程常驻内存可涨到 1 GB 以上。
        pieces: list[bytes] = []
        buffered = 0

        async def consume() -> AsyncIterator[bytes]:
            if isinstance(body, bytes):
                yield body
            elif hasattr(body, "__aiter__"):
                async for item in body:  # type: ignore[union-attr]
                    yield item
            else:
                for item in body:  # type: ignore[union-attr]
                    yield item

        # 最多同时写入 upload_concurrency 个分片（多个 Bot 时并行上传），按顺序收集结果。
        inflight: list[asyncio.Task[ChunkRecord]] = []
        started = 0

        async def launch(plain: bytes) -> None:
            nonlocal started, total
            md5.update(plain)
            blocks.update(plain)
            total += len(plain)
            inflight.append(asyncio.ensure_future(self._store_chunk(fk, blob_uuid, part_no, started, plain)))
            started += 1
            if len(inflight) >= self.upload_concurrency:
                pending.append(await asyncio.shield(inflight[0]))
                inflight.pop(0)

        try:
            async for item in consume():
                if not isinstance(item, (bytes, bytearray, memoryview)):
                    raise TypeError("body must yield bytes")
                if not item:
                    continue
                pieces.append(bytes(item))
                buffered += len(item)
                while buffered >= record.chunk_size:
                    joined = pieces[0] if len(pieces) == 1 else b"".join(pieces)
                    plain, rest = joined[:record.chunk_size], joined[record.chunk_size:]
                    pieces, buffered = ([rest] if rest else []), len(rest)
                    del joined
                    await launch(plain)
            if buffered or started == 0:
                await launch(b"".join(pieces))
            while inflight:
                pending.append(await asyncio.shield(inflight[0]))
                inflight.pop(0)
            self.metadata.replace_part(blob_uuid, part_no, pending, old_refs, time.time())
        except BaseException:
            # 不取消仍在进行的写入：被取消的写入可能已把数据存进后端却丢失引用，无法回收。
            # 等它们（最多 upload_concurrency 个）结束，再把全部引用交给 GC。
            finished = await asyncio.gather(*inflight, return_exceptions=True)
            pending.extend(item for item in finished if isinstance(item, ChunkRecord))
            # 分段只在全部写完后登记；中途失败时已写入后端的分片交给 GC 回收，否则会永久遗留在频道里。
            self.metadata.enqueue_refs([chunk.blob_ref for chunk in pending], time.time())
            raise
        return PartResult(blob_uuid, part_no, total, md5.hexdigest(), len(pending), blocks.finish())

    async def _store_chunk(self, fk: FileKey, blob_uuid: str, part_no: int, sub_idx: int, plain: bytes) -> ChunkRecord:
        # 16 MB 的 AES-GCM 加密放到线程里，避免阻塞事件循环（cryptography 会释放 GIL）。
        async with self.upload_slots.slot():
            encrypted, salt = await asyncio.to_thread(encrypt_chunk, fk, plain)
            await self.upload_rate.consume(len(encrypted))
            ref = await self.store.put(f"{blob_uuid}:{part_no}:{sub_idx}", encrypted)
        if self.thumbnail_cache is not None:
            await asyncio.to_thread(self.thumbnail_cache.put, blob_uuid, ref, 0, encrypted)
        return ChunkRecord(blob_uuid, part_no, sub_idx, None, len(plain), len(encrypted), salt,
                           hashlib.sha256(encrypted).hexdigest(), ref)

    def finalize(self, blob_uuid: str, part_order: list[int]) -> int:
        if not part_order or len(set(part_order)) != len(part_order):
            raise ValueError("part_order must contain each part exactly once")
        return self.metadata.finalize_blob(blob_uuid, part_order)

    async def stream(self, blob_uuid: str, start: int = 0, end: int | None = None,
                     *, window: int = 1024 * 1024, bucket_id: int | None = None,
                     cache_only: bool = False, read_budget=None) -> AsyncIterator[bytes]:
        async with self.transfers.slot(bucket_id):
            async with aclosing(self._stream(blob_uuid, start, end, window=window, cache_only=cache_only, read_budget=read_budget)) as source:
                async for piece in source:
                    yield piece

    async def _stream(self, blob_uuid: str, start: int = 0, end: int | None = None,
                      *, window: int = 1024 * 1024, cache_only: bool = False, read_budget=None) -> AsyncIterator[bytes]:
        record = self.metadata.get_blob(blob_uuid)
        if record.status != "complete" or record.size is None:
            raise InvalidStateError("blob is not complete")
        if start < 0 or start > record.size:
            raise ValueError("invalid start")
        stop = record.size if end is None else min(end, record.size)
        if stop < start:
            raise ValueError("invalid end")
        if start == stop:
            return
        chunks = self.metadata.list_chunks(blob_uuid)
        dek = unwrap_dek(self._kek(), record.wrapped_dek, blob_uuid)
        fk = FileKey(dek, self._blob_key(blob_uuid), record.frame_size)
        # 远端后端（Telegram）每次请求的开销大，允许它要求更大的读取窗口。
        window_for = getattr(self.store, "read_window", None)
        def windows():
            # 远端长读取从小窗口起步、每次放大 4 倍直到后端窗口：浏览器播放视频时会连发多个开放式 Range
            # 并很快中断其中大部分，起步小可以让被中断的请求只浪费几百 KB，而不是整整一个后端窗口。
            ramp = None
            for chunk in chunks:
                if chunk.offset is None:
                    raise IntegrityError("complete blob has unassigned chunk offset")
                chunk_window = max(window, window_for(chunk.blob_ref)) if callable(window_for) else window
                chunk_end = chunk.offset + chunk.plain_size
                if chunk_end <= start or chunk.offset >= stop:
                    continue
                position = max(start, chunk.offset) - chunk.offset
                hi_exclusive = min(stop, chunk_end) - chunk.offset
                while position < hi_exclusive:
                    # 短 Range 和本地读取仍按原窗口一次取齐。
                    if ramp is None:
                        ramp = min(window, 256 * 1024) if chunk_window > window and stop - start > chunk_window else chunk_window
                    width = min(ramp, chunk_window)
                    ramp = min(ramp * 4, 1 << 40)
                    local_end = min(hi_exclusive, position + max(width, record.frame_size))
                    yield chunk, position, local_end
                    position = local_end

        async def read_cipher(chunk: ChunkRecord, cipher_start: int, cipher_end: int) -> bytes:
            cache = self.thumbnail_cache
            encrypted = None
            if cache is not None:
                try:
                    encrypted = await asyncio.to_thread(cache.get, blob_uuid, chunk.blob_ref, cipher_start, cipher_end)
                except ThumbnailCacheMiss:
                    pass
            if encrypted is None:
                if cache_only:
                    raise ThumbnailCacheMiss("等待已接收的数据，不自动回源")
                if read_budget is not None:
                    # 手动生成按完整密文分片计预算并缓存一次；TG 不支持 Range 时也不会重复下载同一分片。
                    read_budget(chunk.blob_ref, chunk.cipher_size)
                    whole = await self.store.get(chunk.blob_ref)
                    if cache is not None:
                        await asyncio.to_thread(cache.put, blob_uuid, chunk.blob_ref, 0, whole)
                    encrypted = whole[cipher_start:cipher_end]
                else:
                    encrypted = await self.store.get(chunk.blob_ref, cipher_start, cipher_end)
                    if cache is not None:
                        await asyncio.to_thread(cache.put, blob_uuid, chunk.blob_ref, cipher_start, encrypted)
            return encrypted

        async def fetch(chunk: ChunkRecord, lo: int, hi_exclusive: int) -> bytes:
            cipher_start, cipher_end, _, _ = cipher_range(record.frame_size, chunk.plain_size, lo, hi_exclusive - 1)
            if read_budget is not None:
                # 解码器可能并发读头部和尾部；共享同一分片的首次取回，避免两个请求同时缓存未命中。
                async with self._thumbnail_read_lock:
                    encrypted = await read_cipher(chunk, cipher_start, cipher_end)
            else:
                encrypted = await read_cipher(chunk, cipher_start, cipher_end)
            return await asyncio.to_thread(decrypt_range, fk, chunk.salt, chunk.plain_size, encrypted, lo, hi_exclusive - 1)

        # 流水线：消费者处理当前窗口时，后面最多 read_ahead 个窗口已在并行取回与解密，
        # 把远端后端每次请求的往返延迟隐藏起来。结果仍按顺序返回。
        # 预读深度随已交付的窗口数逐步增加：刚开始就被中断的请求（浏览器探测、拖动进度条）不会触发大量预读。
        pending: deque[asyncio.Task[bytes]] = deque()
        source = windows()
        delivered = 0
        try:
            exhausted = False
            while True:
                while not exhausted and len(pending) <= (0 if read_budget is not None else min(self.read_ahead, 2 * delivered)):
                    item = next(source, None)
                    if item is None:
                        exhausted = True
                    else:
                        pending.append(asyncio.ensure_future(fetch(*item)))
                if not pending:
                    return
                yield await pending.popleft()
                delivered += 1
        finally:
            # 客户端中断或某个窗口失败：取消尚未使用的预读，并等待它们结束以免遗留未处理的异常。
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    async def read_small(self, blob_uuid: str, limit: int = SMALL_READ_LIMIT) -> bytes:
        """读取一个小对象（缩略图大图），不占传输名额；等待过久时返回 WorkBusyError，浏览器稍后重试。"""
        record = self.metadata.get_blob(blob_uuid)
        if record.size is not None and record.size > limit:
            raise ValueError("object is too large for a small read")
        try:
            async with asyncio.timeout(SMALL_READ_WAIT):
                await self.small_reads.acquire()
        except TimeoutError as exc:
            raise WorkBusyError("传输繁忙，请稍后重试") from exc
        try:
            parts = [part async for part in self._stream(blob_uuid)]
        finally:
            self.small_reads.release()
        return b"".join(parts)

    async def read(self, blob_uuid: str, start: int = 0, end: int | None = None) -> bytes:
        parts = [part async for part in self.stream(blob_uuid, start, end)]
        return b"".join(parts)

    async def scrub(self, blob_uuid: str, *, deep: bool = False) -> list[tuple[int, int]]:
        async with self.transfers.slot(None):
            return await self._scrub(blob_uuid, deep=deep)

    async def _scrub(self, blob_uuid: str, *, deep: bool = False) -> list[tuple[int, int]]:
        record = self.metadata.get_blob(blob_uuid)
        bad: list[tuple[int, int]] = []
        dek = unwrap_dek(self._kek(), record.wrapped_dek, blob_uuid)
        fk = FileKey(dek, self._blob_key(blob_uuid), record.frame_size)
        for chunk in self.metadata.list_chunks(blob_uuid):
            try:
                encrypted = await self.store.get(chunk.blob_ref)
                if (len(encrypted) != chunk.cipher_size or not encrypted or encrypted[0] != FORMAT_VERSION
                        or hashlib.sha256(encrypted).hexdigest() != chunk.cipher_sha256):
                    raise IntegrityError("ciphertext checksum mismatch")
                if deep and record.size is not None:
                    # 只要完整解密一次即可验证全部帧；结果不必留在内存中。
                    if chunk.plain_size:
                        start, end, _, _ = cipher_range(record.frame_size, chunk.plain_size, 0, chunk.plain_size - 1)
                        await asyncio.to_thread(decrypt_range, fk, chunk.salt, chunk.plain_size, encrypted[start:end], 0, chunk.plain_size - 1)
            except (IntegrityError, NotFoundError):
                bad.append((chunk.part_no, chunk.sub_idx))
        return bad

    async def delete(self, blob_uuid: str) -> None:
        self.metadata.delete_blob(blob_uuid, time.time())
        if self.thumbnail_cache is not None:
            self.thumbnail_cache.drop(blob_uuid)
