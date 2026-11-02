"""缩略图生成前的资源评估：按服务器内存、临时空间与读取速度判断，不适合时不启动解码器；存储均为替身。"""
import asyncio
import struct
import unittest
from collections import OrderedDict
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from tgdrive.objects import ObjectInfo, Scope
from tgdrive.thumbnails import (MIB, ThumbnailRetry, ThumbnailService, ThumbnailUnsuitable, _Job, decode_estimate,
                                image_header, image_size)

GIB = 1024 ** 3


def png(width, height):
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height) + b"\x08\x06\x00\x00\x00"


class ImageSizeTests(unittest.TestCase):
    def test_reads_dimensions_from_headers_only(self):
        app1 = b"\xff\xe1" + struct.pack(">H", 2 + 1000) + b"\x00" * 1000
        sof = b"\xff\xc2" + struct.pack(">HBHHB", 17, 8, 567, 1234, 3) + bytes([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
        vp8 = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 4 + b"\x00\x00\x00\x9d\x01\x2a" + struct.pack("<HH", 1234, 567)
        bits = (1234 - 1) | ((567 - 1) << 14)
        vp8l = b"RIFF\x00\x00\x00\x00WEBPVP8L" + b"\x00" * 4 + b"\x2f" + struct.pack("<I", bits)
        vp8x = b"RIFF\x00\x00\x00\x00WEBPVP8X" + b"\x00" * 8 + (1233).to_bytes(3, "little") + (566).to_bytes(3, "little")
        tiff = b"II*\x00" + struct.pack("<I", 8) + struct.pack("<H", 2) + \
            struct.pack("<HHII", 256, 4, 1, 1234) + struct.pack("<HHIHH", 257, 3, 1, 567, 0)
        ispe = lambda w, h: struct.pack(">I", 20) + b"ispe" + b"\x00" * 4 + struct.pack(">II", w, h)
        ipco = struct.pack(">I", 8 + 40) + b"ipco" + ispe(512, 512) + ispe(1234, 567)
        iprp = struct.pack(">I", 8 + len(ipco)) + b"iprp" + ipco
        meta = struct.pack(">I", 12 + len(iprp)) + b"meta" + b"\x00" * 4 + iprp
        avif = struct.pack(">I", 16) + b"ftypavif" + b"\x00" * 4 + meta
        cases = {
            "png": png(1234, 567), "gif": b"GIF89a" + struct.pack("<HH", 1234, 567),
            "bmp": b"BM" + b"\x00" * 12 + struct.pack("<Iii", 40, 1234, -567), "jpeg": b"\xff\xd8" + app1 + sof,
            "webp": vp8, "webp-lossless": vp8l, "webp-extended": vp8x, "tiff": tiff, "avif": avif,
        }
        for name, data in cases.items():
            with self.subTest(name):
                self.assertEqual(image_size(data), (1234, 567))

    def test_reads_decoded_bytes_per_pixel_when_the_header_says(self):
        sof = lambda *factors: b"\xff\xd8\xff\xc0" + struct.pack(">HBHHB", 8 + 3 * len(factors), 8, 10, 10, len(factors)) + \
            b"".join(bytes([n + 1, factor, 0]) for n, factor in enumerate(factors))
        self.assertEqual(image_header(sof(0x22, 0x11, 0x11))[2], 1.5)   # 4:2:0
        self.assertEqual(image_header(sof(0x11, 0x11, 0x11))[2], 3)     # 4:4:4
        self.assertEqual(image_header(sof(0x11))[2], 1)                 # 灰度
        ihdr = lambda depth, color: png(10, 10)[:24] + bytes([depth, color])
        self.assertEqual(image_header(ihdr(8, 2))[2], 3)
        self.assertEqual(image_header(ihdr(16, 6))[2], 8)
        self.assertEqual(image_header(ihdr(8, 3))[2], 1)
        self.assertIsNone(image_header(b"GIF89a" + struct.pack("<HH", 10, 10))[2])

    def test_unknown_or_truncated_headers_return_none(self):
        for data in (b"", b"plain text", b"\xff\xd8\xff\xe1\x10\x00", png(0, 10), b"\xff\xd8\xff\xda\x00\x02"):
            with self.subTest(data=data[:8]):
                self.assertIsNone(image_size(data))

    def test_estimates_scale_with_pixels_and_file_size(self):
        self.assertGreater(decode_estimate("image", 500 * MIB, None), GIB)
        self.assertLess(decode_estimate("image", 5 * MIB, (8000, 8000)), 300 * MIB)
        # 视频与文件大小无关，只看分辨率。
        self.assertEqual(decode_estimate("video", 50 * GIB, (3840, 2160)), decode_estimate("video", MIB, (3840, 2160)))
        self.assertEqual(decode_estimate("audio", 2 * GIB, None), decode_estimate("audio", MIB, None))


class AssessmentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.info = ObjectInfo(7, "huge.png", 100 * MIB, "etag", "image/png", {}, 0, "blob")
        self.sizes = {}
        self.available = None
        self.header = png(1000, 1000)
        worker = self.worker = ThumbnailService.__new__(ThumbnailService)

        async def stream(blob, start, end, **options):
            self.reads.append((start, end, options))
            yield self.header[start:end]
        self.reads = []
        worker.objects = SimpleNamespace(head_object=Mock(return_value=self.info), _check_scope=Mock(),
            engine=SimpleNamespace(stream=stream), set_thumbnail=AsyncMock(), finish_thumbnail_set=Mock(),
            media_sizes=lambda blobs: {blob: self.sizes[blob] for blob in blobs if blob in self.sizes})
        worker.resources = SimpleNamespace(ffmpeg="ffmpeg", detected={"memory_bytes": 2 * GIB}, pressure=lambda: None,
                                           available_memory=lambda: self.available)
        worker.keystore = SimpleNamespace(unlocked=True)
        worker.cache = SimpleNamespace(per_blob=65 * MIB, prepare=Mock(), revision=Mock(return_value=0), drop=Mock())
        worker._pending, worker._leases, worker._history = OrderedDict(), {}, OrderedDict()
        worker._wake = asyncio.Event()
        worker._active = worker._task = None
        worker._remote_bytes = 0
        worker._backfill_skip = {}
        worker._unsuitable, worker._probed, worker._read_rate = OrderedDict(), OrderedDict(), None
        worker._has_thumbnail = Mock(return_value=False)
        worker._scope = Mock(return_value=SimpleNamespace(authorize=Mock()))
        worker._plan_backfill = AsyncMock(return_value=False)
        worker._render = AsyncMock(return_value={"thumb": b"jpeg"})
        self.input = Mock()
        channel = SimpleNamespace(remote_bytes=0)

        class Context:
            async def __aenter__(self): return channel
            async def __aexit__(self, *_): return False
        self.input.return_value = Context()

    async def generate(self, **options):
        with patch("tgdrive.thumbnails._RangeInput", self.input):
            return await self.worker.generate(self.info, **options)

    async def test_request_rejects_known_unsuitable_size_without_queueing(self):
        # 像素上限只看尺寸；内存要等读过文件头、知道解码格式后才能判断（之前的任务已读过）。
        for size, probed, reason in (((20000, 15000), None, "像素上限"), ((15000, 15000), (15000, 15000, 4), "内存")):
            with self.subTest(size=size):
                self.sizes["blob"] = size
                if probed:
                    self.worker._probed["blob"] = probed
                with self.assertRaisesRegex(ValueError, reason):
                    self.worker.request(Scope(7), self.info.key, "etag")
                self.assertEqual(self.worker._pending, OrderedDict())

    async def test_request_queues_when_only_recorded_size_is_known(self):
        self.sizes["blob"] = (15000, 15000)
        self.assertEqual(self.worker.request(Scope(7), self.info.key, "etag"), {"accepted": True})

    async def test_request_waits_when_server_memory_is_busy(self):
        self.sizes["blob"] = (4000, 4000)
        self.available = 200 * MIB
        with self.assertRaisesRegex(ValueError, "可用内存.*稍后再试"):
            self.worker.request(Scope(7), self.info.key, "etag")
        self.available = 4 * GIB
        self.assertEqual(self.worker.request(Scope(7), self.info.key, "etag"), {"accepted": True})

    async def test_probes_header_then_skips_without_decoding_or_marking_none(self):
        self.header = png(15000, 15000)
        job = _Job(self.info, remote=True, backfill=True)
        self.worker._pending["blob"] = job
        runner = asyncio.create_task(self.worker._run())
        try:
            async with asyncio.timeout(1):
                while "blob" not in self.worker._history:
                    await asyncio.sleep(0)
        finally:
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)
        self.assertEqual(self.worker._history["blob"]["state"], "failed")
        self.assertIn("不生成缩略图", self.worker._history["blob"]["detail"])
        self.assertIn("blob", self.worker._unsuitable)
        self.assertEqual(self.reads, [(0, 512 * 1024, {"window": MIB, "bucket_id": 7, "cache_only": False, "background": True,
                                                        "read_budget": self.reads[0][2]["read_budget"]})])
        self.input.assert_not_called()
        self.worker.objects.set_thumbnail.assert_not_awaited()  # 不记 none：浏览器预览仍可以生成
        # 之后的自动任务直接跳过，不再读取文件头。
        self.worker.enqueue(self.info)
        with self.assertRaises(ThumbnailUnsuitable):
            await self.generate(allow_remote=True)
        self.assertEqual(len(self.reads), 1)

    async def test_file_size_alone_can_exceed_a_small_server(self):
        # 管道解封装器把整个图片文件攒成一个数据包：500 MB 的图片在 2 GB 内存的服务器上不适合生成。
        self.info = ObjectInfo(7, "huge.png", 500 * MIB, "etag", "image/png", {}, 0, "blob")
        self.worker.objects.head_object.return_value = self.info
        with self.assertRaisesRegex(ValueError, "内存"):
            self.worker.request(Scope(7), self.info.key, "etag")
        self.worker.resources.detected["memory_bytes"] = 8 * GIB
        self.assertEqual(self.worker.request(Scope(7), self.info.key, "etag"), {"accepted": True})

    async def test_cache_only_job_for_image_larger_than_cache_does_not_read(self):
        with self.assertRaisesRegex(ThumbnailRetry, "短期缓存"):
            await self.generate()
        self.assertEqual(self.reads, [])

    async def test_slow_storage_defers_large_image(self):
        self.worker._read_rate = 128 * 1024  # 100 MB 约需 13 分钟
        with self.assertRaisesRegex(ThumbnailRetry, "读取速度"):
            await self.generate(allow_remote=True)
        self.input.assert_not_called()
        self.worker._read_rate = 50 * MIB
        await self.generate(allow_remote=True)
        self.worker.objects.set_thumbnail.assert_awaited()

    async def test_suitable_files_still_generate(self):
        self.info = ObjectInfo(7, "clip.mp4", 40 * GIB, "etag", "video/mp4", {}, 0, "blob")
        self.sizes["blob"] = (3840, 2160)
        await self.generate(allow_remote=True)
        self.input.assert_called_once()
        self.worker.objects.set_thumbnail.assert_awaited()


if __name__ == "__main__":
    unittest.main()


class AvailableMemoryTests(unittest.TestCase):
    def test_cgroup_headroom_excludes_reclaimable_cache(self):
        import tempfile
        from pathlib import Path
        from tgdrive.offline.resources import ResourceSettings
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "memory.current").write_text(str(900 * MIB))
            (root / "memory.max").write_text(str(GIB))
            (root / "memory.stat").write_text(f"anon {600 * MIB}\ninactive_file {300 * MIB}\n")
            settings = ResourceSettings.__new__(ResourceSettings)
            settings.detected = {"memory_usage_paths": [str(root / "memory.current")]}
            available = settings.available_memory()
            # 已用 900 MiB 中有 300 MiB 是可回收的文件缓存：剩余约 424 MiB（系统 MemAvailable 可能更小）。
            self.assertIsNotNone(available)
            self.assertLessEqual(available, GIB - 600 * MIB)
