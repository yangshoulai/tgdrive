"""候选截图的实际 Range 交付回归；仅内存输入和 HTTP 字节替身，不连接数据库。"""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from tgdrive.thumbnails import MIB, ThumbnailBudget, ThumbnailRetry, _RangeInput


class _Writer:
    def __init__(self):
        self.data = bytearray()

    def write(self, data):
        self.data.extend(data)

    async def drain(self):
        await asyncio.sleep(0)

    def close(self):
        pass

    async def wait_closed(self):
        pass


class _CountingWriter(_Writer):
    def __init__(self):
        super().__init__()
        self.body_size = 0

    def write(self, data):
        if data.startswith(b"HTTP/1.1"):
            super().write(data)
        else:
            self.body_size += len(data)


class CandidateReadBudgetTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.data = bytes(range(256)) * 64
        self.info = SimpleNamespace(size=len(self.data), blob_uuid="video", bucket_id=7)
        self.remote_reads = set()

    async def stream(self, blob, start, end, *, read_budget=None, **kwargs):
        if read_budget and blob not in self.remote_reads:
            read_budget(blob, len(self.data))
            self.remote_reads.add(blob)
        await asyncio.sleep(0)
        yield self.data[start:end]

    def source(self, *, budget=None, authorize=lambda: None):
        source = _RangeInput(SimpleNamespace(stream=self.stream), self.info, authorize, budget)
        source.origin, source.url = "http://127.0.0.1:12345", "http://127.0.0.1:12345" + source.path
        return source

    async def read(self, source, start, end, writer=None):
        reader, writer = asyncio.StreamReader(), writer or _Writer()
        reader.feed_data(f"GET {source.path} HTTP/1.1\r\nHost: 127.0.0.1:12345\r\nRange: bytes={start}-{end - 1}\r\n\r\n".encode())
        await source._serve(reader, writer)
        return bytes(writer.data).split(b"\r\n\r\n", 1)[1]

    async def test_manual_repeated_probes_do_not_have_a_read_limit(self):
        source = self.source()
        for _ in range(20):
            self.assertEqual(await self.read(source, 0, 4096), self.data[:4096])
            self.assertEqual(await self.read(source, 4096, 8192), self.data[4096:8192])
        self.assertIsNone(source.failure)
        self.assertIsNone(source.remaining)
        self.assertEqual(source.remote_bytes, len(self.data))
        self.assertEqual(self.remote_reads, {"video"})

    async def test_budgeted_frame_probes_charge_the_same_range_once(self):
        source = self.source(budget=8192)
        for _ in range(20):
            self.assertEqual(await self.read(source, 0, 4096), self.data[:4096])
            self.assertEqual(await self.read(source, 4096, 8192), self.data[4096:8192])
        self.assertIsNone(source.failure)
        self.assertEqual(source.remaining, 0)
        self.assertEqual(source.remote_bytes, len(self.data))

    async def test_manual_overlapping_and_parallel_ranges_keep_working(self):
        source = self.source()
        results = await asyncio.gather(self.read(source, 0, 6144), self.read(source, 2048, 8192))
        self.assertEqual(results, [self.data[:6144], self.data[2048:8192]])
        self.assertEqual(await self.read(source, 1024, 7168), self.data[1024:7168])
        self.assertIsNone(source.failure)
        self.assertIsNone(source.remaining)

    async def test_budgeted_overlapping_and_parallel_ranges_only_charge_new_bytes(self):
        source = self.source(budget=8192)
        results = await asyncio.gather(self.read(source, 0, 6144), self.read(source, 2048, 8192))
        self.assertEqual(results, [self.data[:6144], self.data[2048:8192]])
        self.assertEqual(await self.read(source, 1024, 7168), self.data[1024:7168])
        self.assertIsNone(source.failure)
        self.assertEqual(source.remaining, 0)
        self.assertEqual(source._ranges, [(0, 8192)])
        self.assertEqual(await self.read(source, 8192, 8193), b"")
        self.assertIsInstance(source.failure, ThumbnailBudget)

    async def test_automatic_new_content_still_stops_at_its_read_limit(self):
        source = self.source(budget=8192)
        await self.read(source, 0, 8192)
        self.assertEqual(await self.read(source, 8192, 12288), b"")
        self.assertIsInstance(source.failure, ThumbnailBudget)
        self.assertIn("读取量超过预算", str(source.failure))

    async def test_manual_can_stream_more_than_sixty_four_mib_without_buffering_a_video(self):
        source, writer = self.source(), _CountingWriter()
        source.info = SimpleNamespace(size=72 * MIB, blob_uuid="large-video", bucket_id=7)
        piece = bytes(MIB)
        async def stream(blob, start, end, *, read_budget=None, **kwargs):
            read_budget(str(start), end - start)
            yield piece[:end - start]
        source.engine.stream = stream
        await self.read(source, 0, source.info.size, writer)
        self.assertIsNone(source.failure)
        self.assertEqual(writer.body_size, 72 * MIB)
        self.assertEqual(source.remote_bytes, 72 * MIB)

    async def test_manual_can_reload_a_fragment_after_cache_eviction(self):
        source = self.source()
        self.assertEqual(await self.read(source, 0, 4096), self.data[:4096])
        self.remote_reads.clear()
        self.assertEqual(await self.read(source, 0, 4096), self.data[:4096])
        self.assertIsNone(source.failure)
        self.assertEqual(source.remote_bytes, len(self.data) * 2)

    async def test_cache_reuse_does_not_skip_authorization(self):
        authorize = Mock()
        source = self.source(authorize=authorize)
        await self.read(source, 0, 4096)
        authorize.side_effect = PermissionError("访问已撤销")
        self.assertEqual(await self.read(source, 0, 4096), b"")
        self.assertIsInstance(source.failure, PermissionError)

    async def test_generation_limits_new_content_instead_of_repeated_bytes(self):
        source = self.source(budget=8192)
        for _ in range(3):
            self.assertEqual(await self.read(source, 0, 4096), self.data[:4096])
        self.assertEqual(source.remaining, 4096)
        self.assertEqual(await self.read(source, 4096, 8192), self.data[4096:8192])
        self.assertEqual(await self.read(source, 8192, 12288), b"")
        self.assertIsInstance(source.failure, ThumbnailBudget)
        self.assertEqual(source.remaining, 0)

    async def test_range_merging_preserves_gaps_and_coalesces_a_bridge(self):
        source = self.source(budget=8192)
        for start, end in ((0, 2048), (6144, 8192), (2048, 6144)):
            self.assertEqual(await self.read(source, start, end), self.data[start:end])
        self.assertEqual(source._ranges, [(0, 8192)])
        self.assertEqual(source.remaining, 0)
        self.assertIsNone(source.failure)

    async def test_budgeted_cached_reread_still_checks_authorization(self):
        authorize = Mock()
        source = self.source(budget=8192, authorize=authorize)
        await self.read(source, 0, 4096)
        authorize.side_effect = PermissionError("访问已撤销")
        self.assertEqual(await self.read(source, 0, 4096), b"")
        self.assertIsInstance(source.failure, PermissionError)

    async def test_budgeted_reread_stops_if_the_cached_fragment_was_evicted(self):
        source = self.source(budget=8192)
        self.assertEqual(await self.read(source, 0, 4096), self.data[:4096])
        self.remote_reads.clear()
        self.assertEqual(await self.read(source, 0, 4096), b"")
        self.assertIsInstance(source.failure, ThumbnailRetry)
        self.assertEqual(source.remote_bytes, len(self.data))

    async def test_actual_fragment_downloads_keep_their_separate_budget(self):
        source = self.source(budget=8192)
        async def stream(blob, start, end, *, read_budget=None, **kwargs):
            read_budget(str(start), MIB)
            yield self.data[start:end]
        source.engine.stream = stream
        self.assertEqual(await self.read(source, 0, 4096), self.data[:4096])
        self.assertEqual(await self.read(source, 4096, 8192), b"")
        self.assertIsInstance(source.failure, ThumbnailBudget)
        self.assertIn("回源读取量超过预算", str(source.failure))
        self.assertEqual(source.remote_bytes, MIB)


if __name__ == "__main__":
    unittest.main()
