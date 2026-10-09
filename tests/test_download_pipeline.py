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
