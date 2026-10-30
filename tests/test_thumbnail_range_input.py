"""缩略图解码器的本地 Range 入口：不限制读取量、缓存回收后可重读、每次交付都复核授权；仅内存替身，不连接数据库。"""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from tgdrive.thumbnails import MIB, _RangeInput


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


class RangeInputTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.data = bytes(range(256)) * 64
        self.info = SimpleNamespace(size=len(self.data), blob_uuid="video", bucket_id=7)
        self.remote_reads = set()

    async def stream(self, blob, start, end, *, read_budget=None, **kwargs):
        for part in range(start // 4096, (end - 1) // 4096 + 1):
            ref = (blob, part)
            if read_budget and ref not in self.remote_reads:
                read_budget(ref, 4096)
                self.remote_reads.add(ref)
        await asyncio.sleep(0)
        yield self.data[start:end]

    def source(self, *, authorize=lambda: None):
        source = _RangeInput(SimpleNamespace(stream=self.stream), self.info, authorize)
        source.origin, source.url = "http://127.0.0.1:12345", "http://127.0.0.1:12345" + source.path
        return source

    async def read(self, source, start, end, writer=None):
        reader, writer = asyncio.StreamReader(), writer or _Writer()
        reader.feed_data(f"GET {source.path} HTTP/1.1\r\nHost: 127.0.0.1:12345\r\nRange: bytes={start}-{end - 1}\r\n\r\n".encode())
        await source._serve(reader, writer)
        return bytes(writer.data).split(b"\r\n\r\n", 1)[1]

    async def test_repeated_probes_have_no_read_limit(self):
        source = self.source()
        for _ in range(20):
            self.assertEqual(await self.read(source, 0, 4096), self.data[:4096])
            self.assertEqual(await self.read(source, 4096, 8192), self.data[4096:8192])
        self.assertIsNone(source.failure)
        self.assertEqual(source.remote_bytes, 8192)
        self.assertEqual(self.remote_reads, {("video", 0), ("video", 1)})

    async def test_overlapping_and_parallel_ranges_keep_working(self):
        source = self.source()
        results = await asyncio.gather(self.read(source, 0, 6144), self.read(source, 2048, 8192))
        self.assertEqual(results, [self.data[:6144], self.data[2048:8192]])
        self.assertEqual(await self.read(source, 1024, 7168), self.data[1024:7168])
        self.assertIsNone(source.failure)

    async def test_large_files_stream_without_buffering_or_limits(self):
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

    async def test_fragment_can_reload_after_cache_eviction(self):
        source = self.source()
        self.assertEqual(await self.read(source, 0, 4096), self.data[:4096])
        self.remote_reads.clear()
        self.assertEqual(await self.read(source, 0, 4096), self.data[:4096])
        self.assertIsNone(source.failure)
        self.assertEqual(source.remote_bytes, 8192)

    async def test_cache_reuse_does_not_skip_authorization(self):
        authorize = Mock()
        source = self.source(authorize=authorize)
        await self.read(source, 0, 4096)
        authorize.side_effect = PermissionError("访问已撤销")
        self.assertEqual(await self.read(source, 0, 4096), b"")
        self.assertIsInstance(source.failure, PermissionError)


if __name__ == "__main__":
    unittest.main()
