"""FFmpeg 管道输出的分片 MP4：补写总时长、生成 sidx 索引、丢弃失效的 mfra，以及离线下载把 sidx 插进第 1 段。"""
import asyncio
import os
import struct
import tempfile
import unittest
from unittest.mock import patch

from tests.test_offline import MemoryHttp
from tgdrive.app import create_app
from tgdrive.objects import Scope
from tgdrive.offline.mp4 import FragmentIndexer, patch_duration, with_duration


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def full(kind: bytes, version: int, flags: int, payload: bytes) -> bytes:
    return box(kind, struct.pack(">B", version) + flags.to_bytes(3, "big") + payload)


def track(track_id: int, timescale: int, handler: bytes) -> bytes:
    tkhd = full(b"tkhd", 0, 3, struct.pack(">III", 0, 0, track_id) + bytes(68))
    mdhd = full(b"mdhd", 0, 0, struct.pack(">IIII", 0, 0, timescale, 0) + bytes(4))
    hdlr = full(b"hdlr", 0, 0, bytes(4) + handler + bytes(12) + b"\0")
    return box(b"trak", tkhd + box(b"mdia", mdhd + hdlr))


# 两条轨：视频 90000、音频 44100；每个分片视频 2 秒（50 帧）、音频约 2 秒（86 帧 × 1024）。
TRACKS = ((1, 90000, b"vide", 1800), (2, 44100, b"soun", 1024))
SAMPLES = {1: 50, 2: 86}


def fragmented_mp4(fragments: int, payload: int) -> tuple[bytes, list[int]]:
    """仿照 FFmpeg empty_moov+frag_keyframe+default_base_moof 的结构；返回文件和每个 moof 的偏移。"""
    mvhd = full(b"mvhd", 0, 0, struct.pack(">IIII", 0, 0, 1000, 0) + bytes(80))
    mvex = box(b"mvex", b"".join(full(b"trex", 0, 0, struct.pack(">IIIII", tid, 1, duration, 0, 0))
                                 for tid, _, _, duration in TRACKS))
    moov = box(b"moov", mvhd + b"".join(track(tid, ts, kind) for tid, ts, kind, _ in TRACKS) + mvex + box(b"udta", bytes(90)))
    data, offsets = bytearray(box(b"ftyp", b"isom\0\0\x02\0isomiso6mp41") + moov), []
    for index in range(fragments):
        trafs = b""
        for tid, _, _, duration in TRACKS:
            count = SAMPLES[tid]
            tfhd = full(b"tfhd", 0, 0x020000, struct.pack(">I", tid))
            tfdt = full(b"tfdt", 1, 0, struct.pack(">Q", index * count * duration))
            # 视频轨逐样本写时长（flags 0x100），音频轨使用 trex 默认时长。
            if tid == 1:
                trun = full(b"trun", 0, 0x101, struct.pack(">Ii", count, 0) + b"".join(struct.pack(">I", duration) for _ in range(count)))
            else:
                trun = full(b"trun", 0, 0x001, struct.pack(">Ii", count, 0))
            trafs += box(b"traf", tfhd + tfdt + trun)
        offsets.append(len(data))
        data += box(b"moof", full(b"mfhd", 0, 0, struct.pack(">I", index + 1)) + trafs)
        data += box(b"mdat", os.urandom(payload))
    data += box(b"mfra", full(b"tfra", 1, 0, bytes(12)) + full(b"mfro", 0, 0, struct.pack(">I", 16)))
    return bytes(data), offsets


async def pieces(data: bytes, size: int):
    for index in range(0, len(data), size):
        yield data[index:index + size]


def parse_sidx(data: bytes, at: int):
    size = struct.unpack(">I", data[at:at + 4])[0]
    body = data[at + 8:at + size]
    track_id, timescale, first_time, first_offset = struct.unpack(">IIQQ", body[4:28])
    count = struct.unpack(">H", body[30:32])[0]
    return size, track_id, timescale, first_offset, [struct.unpack(">III", body[32 + 12 * i:44 + 12 * i]) for i in range(count)]


class Mp4IndexTests(unittest.IsolatedAsyncioTestCase):
    async def test_duration_is_written_without_changing_offsets(self):
        data, _ = fragmented_mp4(3, 100)
        patched = b"".join([piece async for piece in with_duration(pieces(data, 37), 6.5)])
        self.assertEqual(len(patched), len(data))
        moov_at = data.index(b"moov") - 4
        self.assertEqual(patched[moov_at:moov_at + 4], data[moov_at:moov_at + 4])  # moov 大小不变
        self.assertEqual(patched[data.index(b"moof") - 4:], data[data.index(b"moof") - 4:])  # 后面的分片原样
        mvhd = patched.index(b"mvhd") + 4
        self.assertEqual(struct.unpack(">II", patched[mvhd + 12:mvhd + 20]), (1000, 6500))
        mehd = patched.index(b"mehd") + 4
        self.assertEqual(struct.unpack(">Q", patched[mehd + 4:mehd + 12])[0], 6500)
        self.assertIn(b"free", patched[moov_at:data.index(b"moof")])
        self.assertNotIn(b"udta", patched)
        # 已有 mehd、不是 MP4 或时长未知时原样输出。
        self.assertEqual(patch_duration(patched, 9), patched)
        self.assertEqual(patch_duration(b"\0" * 64, 9), b"\0" * 64)
        self.assertEqual(b"".join([piece async for piece in with_duration(pieces(data, 50), None)]), data)

    async def test_indexer_builds_one_sidx_per_track_and_drops_mfra(self):
        data, offsets = fragmented_mp4(4, 300)
        indexer = FragmentIndexer()
        output = b"".join([piece async for piece in indexer.observe(pieces(data, 13))])
        media_end = data.index(b"mfra") - 4
        self.assertEqual(output, data[:media_end])
        self.assertEqual(indexer.offsets, offsets)
        self.assertEqual(indexer.moov_end, offsets[0])
        index = indexer.sidx()
        first = parse_sidx(index, 0)
        second = parse_sidx(index, first[0])
        self.assertEqual(len(index), first[0] + second[0])
        sizes = [end - start for start, end in zip(offsets, offsets[1:] + [media_end])]
        # 第一个 sidx 的 first_offset 跳过第二个 sidx，第二个紧接第一个 moof。
        self.assertEqual(first[1:4], (1, 90000, second[0]))
        self.assertEqual(second[1:4], (2, 44100, 0))
        self.assertEqual(first[4], [(size, 50 * 1800, 0x80000000) for size in sizes])
        self.assertEqual(second[4], [(size, 86 * 1024, 0x80000000) for size in sizes])

    async def test_unrecognised_stream_passes_through_without_index(self):
        indexer = FragmentIndexer()
        data = b"not an mp4 stream at all" * 100
        self.assertEqual(b"".join([piece async for piece in indexer.observe(pieces(data, 7))]), data)
        self.assertEqual(indexer.sidx(), b"")


class OfflineVideoStagingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(self.temp.name, secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.offline = self.app.offline
        self.offline.http = MemoryHttp()

    async def asyncTearDown(self):
        await self.offline.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    async def test_saved_video_has_sidx_after_moov_across_parts(self):
        self.app.resources.ffmpeg = "fixture"
        self.app.resources.update({"hls_enabled": True})
        http = self.offline.http
        class HlsHttp(MemoryHttp):
            from contextlib import asynccontextmanager
            @asynccontextmanager
            async def open(inner, request, **kwargs):
                async with http.open(request, **kwargs) as response:
                    response.headers["content-type"] = "application/vnd.apple.mpegurl"
                    async def read():
                        return b"#EXTM3U\n#EXTINF:2,\n1.ts\n#EXT-X-ENDLIST\n"
                    response.read = read
                    yield response
        self.offline.http = HlsHttp()
        # 超过一个 16 MB 分段：第 1 段在内存中暂留、最后上传，其余分段先上传。
        data, offsets = fragmented_mp4(5, 5 * 1024 * 1024)
        async def remux(*args, **kwargs):
            async for piece in pieces(data, 65536):
                yield piece
        candidate = (await self.offline.parse(self.alice.id, "https://example.com/movie.m3u8"))["candidates"][0]
        task = self.offline.create(self.alice.id, [{"ticket": candidate["ticket"], "name": "movie.mp4"}], "")[0]
        with patch("tgdrive.offline.service.remux", remux):
            self.offline.start()
            async with asyncio.timeout(30):
                while self.offline._row(task["id"])["status"] not in ("completed", "failed"):
                    await asyncio.sleep(0.02)
        row = self.offline._row(task["id"])
        self.assertEqual(row["status"], "completed", row["error"])
        _, stream = await self.app.objects.get_object(Scope(self.alice.bucket_id), row["key"])
        saved = b"".join([piece async for piece in stream])
        moov_end = offsets[0]
        index = saved[moov_end:saved.index(b"moof") - 4]
        self.assertEqual(saved[:moov_end], data[:moov_end])
        self.assertEqual(saved[moov_end + len(index):], data[moov_end:data.index(b"mfra") - 4])
        first = parse_sidx(index, 0)
        self.assertEqual((first[1], len(first[4])), (1, 5))
        self.assertEqual(row["stored_bytes"], len(saved))


if __name__ == "__main__":
    unittest.main()
