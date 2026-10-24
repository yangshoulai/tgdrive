"""候选截图的实际 Range 交付回归；仅内存输入和 HTTP 字节替身，不连接数据库。"""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from tgdrive.thumbnails import ThumbnailBudget, _RangeInput


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

    def source(self, *, unique_reads=True, authorize=lambda: None):
        source = _RangeInput(SimpleNamespace(stream=self.stream), self.info, authorize, 8192, unique_reads=unique_reads)
        source.origin, source.url = "http://127.0.0.1:12345", "http://127.0.0.1:12345" + source.path
        return source

    async def read(self, source, start, end):
        reader, writer = asyncio.StreamReader(), _Writer()
        reader.feed_data(f"GET {source.path} HTTP/1.1\r\nHost: 127.0.0.1:12345\r\nRange: bytes={start}-{end - 1}\r\n\r\n".encode())
        await source._serve(reader, writer)
        return bytes(writer.data).split(b"\r\n\r\n", 1)[1]

    async def test_repeated_probe_and_frame_ranges_only_count_once(self):
        source = self.source()
        for _ in range(20):
            self.assertEqual(await self.read(source, 0, 4096), self.data[:4096])
            self.assertEqual(await self.read(source, 4096, 8192), self.data[4096:8192])
        self.assertIsNone(source.failure)
        self.assertEqual(source.remaining, 0)
        self.assertEqual(source.remote_bytes, len(self.data))
        self.assertEqual(self.remote_reads, {"video"})

    async def test_overlapping_and_parallel_ranges_share_the_limit(self):
        source = self.source()
        results = await asyncio.gather(self.read(source, 0, 6144), self.read(source, 2048, 8192))
        self.assertEqual(results, [self.data[:6144], self.data[2048:8192]])
        self.assertEqual(await self.read(source, 1024, 7168), self.data[1024:7168])
        self.assertIsNone(source.failure)
        self.assertEqual(source.remaining, 0)
        self.assertEqual(source._ranges, [(0, 8192)])

    async def test_new_video_content_still_stops_at_the_real_limit(self):
        source = self.source()
        await self.read(source, 0, 8192)
        self.assertEqual(await self.read(source, 8192, 12288), b"")
        self.assertIsInstance(source.failure, ThumbnailBudget)
        self.assertIn("不同的视频内容", str(source.failure))

    async def test_cache_reuse_does_not_skip_authorization(self):
        authorize = Mock()
        source = self.source(authorize=authorize)
        await self.read(source, 0, 4096)
        authorize.side_effect = PermissionError("访问已撤销")
        self.assertEqual(await self.read(source, 0, 4096), b"")
        self.assertIsInstance(source.failure, PermissionError)

    async def test_automatic_generation_keeps_its_existing_total_read_limit(self):
        source = self.source(unique_reads=False)
        await self.read(source, 0, 4096)
        await self.read(source, 0, 4096)
        self.assertEqual(await self.read(source, 0, 4096), b"")
        self.assertIsInstance(source.failure, ThumbnailBudget)
        self.assertEqual(source.remaining, 0)


if __name__ == "__main__":
    unittest.main()
