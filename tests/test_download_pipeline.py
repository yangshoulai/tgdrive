"""下载预读流水线：顺序正确、并行度受限、中断时取消预读。"""
import asyncio
import os
import tempfile
import unittest
from pathlib import Path

from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.keystore import KeyStore
from tgdrive.metadata import Metadata
from tgdrive.work import TransferSlots, WorkBusyError


class SlowStore(LocalDiskBlobStore):
    """每次读取都有固定延迟，并记录同时进行的读取数。"""

    def __init__(self, root, delay: float) -> None:
        super().__init__(root)
        self.delay, self.active, self.peak, self.calls = delay, 0, 0, 0

    async def get(self, ref, start=None, end=None):
        self.calls += 1
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            await asyncio.sleep(self.delay)
            return await super().get(ref, start, end)
        finally:
            self.active -= 1


class DownloadPipelineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.metadata = Metadata(root / "meta.db")
        keys = KeyStore(self.metadata)
        keys.initialize("pass")
        self.store = SlowStore(root / "blobs", 0.02)
        self.engine = BlobEngine(self.metadata, self.store, keys.require_kek(), chunk_size=256, frame_size=16)
        self.data = os.urandom(256 * 6 + 37)
        blob = self.engine.begin_blob()
        await self.engine.put_part(blob, 1, self.data)
        self.engine.finalize(blob, [1])
        self.blob = blob

    async def asyncTearDown(self):
        self.metadata.close()
        self.temp.cleanup()

    async def test_ranges_are_ordered_and_correct_with_read_ahead(self):
        for start, end in ((0, None), (5, 1000), (255, 257), (256 * 3, None), (len(self.data) - 1, None)):
            got = b"".join([piece async for piece in self.engine.stream(self.blob, start, end, window=64)])
            self.assertEqual(got, self.data[start:end], (start, end))

    async def test_read_ahead_overlaps_requests_but_is_bounded(self):
        self.engine.read_ahead = 2
        [piece async for piece in self.engine.stream(self.blob, window=64)]
        self.assertGreater(self.store.peak, 1)
        self.assertLessEqual(self.store.peak, 3)

    async def test_no_read_ahead_is_sequential(self):
        self.engine.read_ahead = 0
        [piece async for piece in self.engine.stream(self.blob, window=64)]
        self.assertEqual(self.store.peak, 1)

    async def test_remote_long_read_starts_small_and_short_range_stays_single(self):
        self.store.read_window = lambda ref: 128
        self.engine.read_ahead = 0
        stream = self.engine.stream(self.blob, window=64)
        try:
            self.assertEqual(await anext(stream), self.data[:64])
            self.assertEqual(await anext(stream), self.data[64:192])
        finally:
            await stream.aclose()
        calls = self.store.calls
        pieces = [piece async for piece in self.engine.stream(self.blob, 5, 105, window=64)]
        self.assertEqual(pieces, [self.data[5:105]])
        self.assertEqual(self.store.calls - calls, 1)

    async def test_aborted_remote_read_does_not_prefetch_large_windows(self):
        # 浏览器播放视频时会连发开放式 Range 并很快中断：只读了首段就中断的请求不应触发预读。
        self.store.read_window = lambda ref: 1024
        self.engine.read_ahead = 2
        stream = self.engine.stream(self.blob, window=16)
        self.assertEqual(await anext(stream), self.data[:16])
        await stream.aclose()
        self.assertEqual(self.store.calls, 1)
        # 持续读取时窗口按 4 倍放大、预读逐步加深，最终结果不变。
        calls = self.store.calls
        self.assertEqual(b"".join([piece async for piece in self.engine.stream(self.blob, window=16)]), self.data)
        self.assertGreater(self.store.peak, 1)
        self.assertLess(self.store.calls - calls, len(self.data) // 16)

    def test_telegram_transport_stops_reading_when_cancelled(self):
        import io
        import threading
        from tgdrive.telegram.client import PooledTransport
        transport = PooledTransport()
        cancel = threading.Event()
        class Response(io.BytesIO):
            def read(self, size=-1):
                cancel.set()   # 读到第一段后调用方取消
                return super().read(size)
        self.assertIsNone(transport._read_body(Response(b"x" * (PooledTransport.READ_PIECE * 4)), cancel))
        self.assertEqual(transport._read_body(io.BytesIO(b"abc"), threading.Event()), b"abc")

    async def test_global_and_bucket_limits_survive_cancellation(self):
        slots = TransferSlots(total=2, per_bucket=1, wait_seconds=0.03)
        async with slots.slot(1):
            async with slots.slot(2):
                with self.assertRaises(WorkBusyError):
                    async with slots.slot(3):
                        self.fail("超过全局上限")
                with self.assertRaises(WorkBusyError):
                    async with slots.slot(1):
                        self.fail("超过账号上限")
                async def waiting():
                    async with slots.slot(1):
                        pass
                pending = asyncio.create_task(waiting())
                await asyncio.sleep(0)
                pending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
        self.assertEqual(slots._buckets, {})
        async with slots.slot(1):
            pass

    async def test_closing_stream_cancels_pending_reads(self):
        stream = self.engine.stream(self.blob, window=64)
        await anext(stream)
        await stream.aclose()
        await asyncio.sleep(0.1)
        self.assertEqual(self.store.active, 0)
        self.assertEqual(self.engine.transfers._buckets, {})
        self.assertLess(self.store.calls, len(self.data) // 64)


if __name__ == "__main__":
    unittest.main()
