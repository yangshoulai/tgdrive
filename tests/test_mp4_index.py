"""FFmpeg 管道输出的分片 MP4 边收边转换成普通 MP4，以及离线下载把 moov 放进最后上传的第 1 段。"""
import asyncio
import struct
import tempfile
import unittest
from contextlib import asynccontextmanager
from unittest.mock import patch

from tests.test_offline import MemoryHttp
from tgdrive.app import create_app
from tgdrive.objects import Scope
from tgdrive.offline.http import DownloadError
from tgdrive.offline.mp4 import Defragmenter, _boxes


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def full(kind: bytes, version: int, flags: int, payload: bytes) -> bytes:
    return box(kind, struct.pack(">B", version) + flags.to_bytes(3, "big") + payload)


def track(track_id: int, timescale: int, handler: bytes, edit: bytes) -> bytes:
    tkhd = full(b"tkhd", 0, 3, struct.pack(">III", 0, 0, track_id) + bytes(68))
    mdhd = full(b"mdhd", 0, 0, struct.pack(">IIII", 0, 0, timescale, 0) + bytes(4))
    hdlr = full(b"hdlr", 0, 0, bytes(4) + handler + bytes(12) + b"\0")
    empty = b"".join(full(kind, 0, 0, struct.pack(">I", 0)) for kind in (b"stts", b"stsc", b"stco")) + full(b"stsz", 0, 0, bytes(8))
    stbl = box(b"stbl", full(b"stsd", 0, 0, struct.pack(">I", 0)) + empty)
    return box(b"trak", tkhd + box(b"edts", edit) + box(b"mdia", mdhd + hdlr + box(b"minf", stbl)))


# 两条轨：视频 90000（每 25 帧一个关键帧，带合成时间偏移）、音频 44100（全部是同步样本，用 trex 默认时长）。
VIDEO, AUDIO = 1, 2


def sample(track_id: int, fragment: int, index: int, size: int) -> bytes:
    return bytes([track_id, fragment, index % 256]) * (size // 3) + bytes(size % 3)


def fragmented_mp4(fragments: int, video_size: int = 300, audio_size: int = 50):
    """仿照 FFmpeg empty_moov+delay_moov+frag_keyframe+default_base_moof；返回文件和每条轨的样本 (字节, 时长, 关键帧, cts)。"""
    mvhd = full(b"mvhd", 0, 0, struct.pack(">IIII", 0, 0, 1000, 0) + bytes(80))
    trex = full(b"trex", 0, 0, struct.pack(">IIIII", VIDEO, 1, 3600, 0, 0x01010000)) + \
        full(b"trex", 0, 0, struct.pack(">IIIII", AUDIO, 1, 1024, 0, 0x02000000))
    video_edit = full(b"elst", 0, 0, struct.pack(">I", 2) + struct.pack(">IiI", 23, -1, 0x10000) + struct.pack(">IiI", 0, 0, 0x10000))
    audio_edit = full(b"elst", 0, 0, struct.pack(">I", 1) + struct.pack(">IiI", 0, 0, 0x10000))
    moov = box(b"moov", mvhd + track(VIDEO, 90000, b"vide", video_edit) + track(AUDIO, 44100, b"soun", audio_edit)
               + box(b"mvex", trex) + box(b"udta", bytes(20)))
    data = bytearray(box(b"ftyp", b"isom\0\0\x02\0isomiso6mp41") + moov)
    expected = {VIDEO: [], AUDIO: []}
    for fragment in range(fragments):
        video = [(sample(VIDEO, fragment, i, video_size + i), 3600, i == 0, 7200 if i % 2 else 0) for i in range(5)]
        audio = [(sample(AUDIO, fragment, i, audio_size), 1024 if i % 3 else 1023, True, 0) for i in range(8)]
        expected[VIDEO] += video
        expected[AUDIO] += audio

        def build(video_offset: int, audio_offset: int) -> bytes:
            # 视频：逐样本写时长、大小、标志、合成时间偏移；音频：只写大小和时长，标志用 trex 默认值。
            vrun = full(b"trun", 0, 0xF01, struct.pack(">Ii", len(video), video_offset) + b"".join(
                struct.pack(">IIII", duration, len(raw), 0x02000000 if key else 0x01010000, cts) for raw, duration, key, cts in video))
            arun = full(b"trun", 0, 0x301, struct.pack(">Ii", len(audio), audio_offset) + b"".join(
                struct.pack(">II", duration, len(raw)) for raw, duration, _, _ in audio))
            vtraf = box(b"traf", full(b"tfhd", 0, 0x020000, struct.pack(">I", VIDEO)) + full(b"tfdt", 1, 0, bytes(8)) + vrun)
            atraf = box(b"traf", full(b"tfhd", 0, 0x020000, struct.pack(">I", AUDIO)) + full(b"tfdt", 1, 0, bytes(8)) + arun)
            return box(b"moof", full(b"mfhd", 0, 0, struct.pack(">I", fragment + 1)) + vtraf + atraf)
        size = len(build(0, 0))
        video_bytes = sum(len(raw) for raw, *_ in video)
        data += build(size + 8, size + 8 + video_bytes)
        data += box(b"mdat", b"".join(raw for raw, *_ in video) + b"".join(raw for raw, *_ in audio))
    data += box(b"mfra", full(b"tfra", 1, 0, bytes(12)) + full(b"mfro", 0, 0, struct.pack(">I", 16)))
    return bytes(data), expected


async def pieces(data: bytes, size: int):
    for index in range(0, len(data), size):
        yield data[index:index + size]


def find(data: bytes, path: list[bytes], start: int = 0, end: int | None = None):
    """按路径找子盒子，返回 [(起点, 头长, 总长)]（最后一级的全部匹配）。"""
    end = len(data) if end is None else end
    matches = [(at, header, size) for kind, at, header, size in _boxes(data, start, end) if kind == path[0]]
    if len(path) == 1:
        return matches
    return [item for at, header, size in matches for item in find(data, path[1:], at + header, at + size)]


def read_samples(mp4: bytes) -> dict[int, list[tuple[bytes, int, bool, int]]]:
    """按普通 MP4 的样本表（stsz、stco、stsc、stts、ctts、stss）取出每个样本，验证转换结果。"""
    result = {}
    for at, header, size in find(mp4, [b"moov", b"trak"]):
        trak = mp4[at:at + size]
        track_id = struct.unpack(">I", trak[trak.index(b"tkhd") + 16:trak.index(b"tkhd") + 20])[0]
        def table(kind):
            found = find(trak, [b"trak", b"mdia", b"minf", b"stbl", kind])
            return trak[found[0][0] + 8:found[0][0] + found[0][2]] if found else None
        stsz = table(b"stsz")
        fixed, count = struct.unpack(">II", stsz[4:12])
        sizes = [fixed] * count if fixed else list(struct.unpack(f">{count}I", stsz[12:12 + 4 * count]))
        stco = table(b"stco")
        offsets = struct.unpack(f">{struct.unpack('>I', stco[4:8])[0]}I", stco[8:])
        stsc = table(b"stsc")
        runs = [struct.unpack(">III", stsc[8 + 12 * i:20 + 12 * i]) for i in range(struct.unpack(">I", stsc[4:8])[0])]
        per_chunk = []
        for number in range(1, len(offsets) + 1):
            per_chunk.append([samples for first, samples, _ in runs if first <= number][-1])
        stts = table(b"stts")
        durations = [duration for i in range(struct.unpack(">I", stts[4:8])[0])
                     for count_, duration in [struct.unpack(">II", stts[8 + 8 * i:16 + 8 * i])] for _ in range(count_)]
        ctts = table(b"ctts")
        offsets_cts = [value for i in range(struct.unpack(">I", ctts[4:8])[0])
                       for count_, value in [struct.unpack(">Ii", ctts[8 + 8 * i:16 + 8 * i])] for _ in range(count_)] if ctts else [0] * count
        stss = table(b"stss")
        sync = set(struct.unpack(f">{struct.unpack('>I', stss[4:8])[0]}I", stss[8:])) if stss else None
        samples, index = [], 0
        for offset, n in zip(offsets, per_chunk):
            for _ in range(n):
                samples.append((mp4[offset:offset + sizes[index]], durations[index],
                                sync is None or index + 1 in sync, offsets_cts[index]))
                offset += sizes[index]
                index += 1
        result[track_id] = samples
    return result


class DefragmenterTests(unittest.IsolatedAsyncioTestCase):
    async def convert(self, data: bytes, piece: int) -> tuple[bytes, Defragmenter]:
        converter = Defragmenter()
        payload = b"".join([chunk async for chunk in converter.payload(pieces(data, piece))])
        return converter.header() + payload, converter

    async def test_fragments_become_progressive_mp4_with_complete_sample_tables(self):
        data, expected = fragmented_mp4(4)
        for piece in (7, 4096, len(data)):
            mp4, _ = await self.convert(data, piece)
            self.assertEqual([kind for kind, *_ in _boxes(mp4)], [b"ftyp", b"moov", b"mdat"])
            self.assertEqual(read_samples(mp4), expected, piece)
        moov = mp4[find(mp4, [b"moov"])[0][0]:]
        self.assertNotIn(b"mvex", moov[:find(mp4, [b"moov"])[0][2]])
        mvhd = moov.index(b"mvhd") + 4
        self.assertEqual(struct.unpack(">I", moov[mvhd + 16:mvhd + 20])[0], 4 * 5 * 3600 * 1000 // 90000)
        # 视频编辑列表：23 ms 的空编辑保留，原来写 0 的媒体段改成实际时长。
        elst = moov.index(b"elst") + 4
        self.assertEqual(struct.unpack(">IiI", moov[elst + 20:elst + 32])[0], 4 * 5 * 3600 * 1000 // 90000 - 23)

    async def test_truncated_or_unrecognised_output_fails(self):
        data, _ = fragmented_mp4(2)
        with self.assertRaises(DownloadError):
            await self.convert(data[:data.index(b"mfra") - 200], 64)   # 截断在最后一个 mdat 中间
        with self.assertRaises(DownloadError):
            await self.convert(b"not an mp4 stream at all" * 100, 7)

    async def test_ffmpeg_writes_moov_after_audio_config_is_known(self):
        # empty_moov 单独使用时，TS 来源 AAC 的解码配置还没生成就写出了 moov，Safari 认不出音轨。
        from tgdrive.offline import hls
        captured = []
        async def spawn(*args, **kwargs):
            captured.extend(args)
            raise RuntimeError("stop")
        playlist = hls.Playlist([], [("https://example.com/1.ts", 2.0)])
        with patch("tgdrive.offline.hls.asyncio.create_subprocess_exec", spawn):
            stream = hls._pipe_remux(None, None, playlist, "ffmpeg", check=lambda: None, progress=lambda **_: None, throttle=None)
            with self.assertRaises(RuntimeError):
                await anext(stream)
        self.assertIn("empty_moov+delay_moov+frag_keyframe+default_base_moof", captured)


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

    async def test_saved_video_is_progressive_across_parts(self):
        self.app.resources.ffmpeg = "fixture"
        self.app.resources.update({"hls_enabled": True})
        http = self.offline.http
        class HlsHttp(MemoryHttp):
            @asynccontextmanager
            async def open(inner, request, **kwargs):
                async with http.open(request, **kwargs) as response:
                    response.headers["content-type"] = "application/vnd.apple.mpegurl"
                    async def read():
                        return b"#EXTM3U\n#EXTINF:2,\n1.ts\n#EXT-X-ENDLIST\n"
                    response.read = read
                    yield response
        self.offline.http = HlsHttp()
        # 超过一个 16 MB 分段：开头的数据在内存中暂留、和 moov 一起作为第 1 段最后上传，其余分段先上传。
        data, expected = fragmented_mp4(6, video_size=700_000, audio_size=4000)
        self.assertGreater(len(data), 20 * 1024 * 1024)
        async def remux(*args, **kwargs):
            async for piece in pieces(data, 65536):
                yield piece
        candidate = (await self.offline.parse(self.alice.id, "https://example.com/movie.m3u8"))["candidates"][0]
        task = self.offline.create(self.alice.id, [{"ticket": candidate["ticket"], "name": "movie.mp4"}], "")[0]
        with patch("tgdrive.offline.service.remux", remux):
            self.offline.start()
            async with asyncio.timeout(60):
                while self.offline._row(task["id"])["status"] not in ("completed", "failed"):
                    await asyncio.sleep(0.02)
        row = self.offline._row(task["id"])
        self.assertEqual(row["status"], "completed", row["error"])
        _, stream = await self.app.objects.get_object(Scope(self.alice.bucket_id), row["key"])
        saved = b"".join([piece async for piece in stream])
        self.assertEqual([kind for kind, *_ in _boxes(saved)], [b"ftyp", b"moov", b"mdat"])
        self.assertEqual(read_samples(saved), expected)
        self.assertEqual(row["stored_bytes"], len(saved))


if __name__ == "__main__":
    unittest.main()
