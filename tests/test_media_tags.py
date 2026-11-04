import asyncio
import base64
import struct
import unittest

from tgdrive.media import tags as media_tags


def run(data: bytes, budget: int = media_tags.READ_BUDGET):
    reads = []

    async def read(start, end):
        reads.append((start, end))
        return data[start:end]

    result = asyncio.run(media_tags.parse(read, len(data), budget=budget))
    return result, reads


def syncsafe(value: int) -> bytes:
    return bytes(((value >> 21) & 0x7F, (value >> 14) & 0x7F, (value >> 7) & 0x7F, value & 0x7F))


def id3_frame(frame_id: str, body: bytes) -> bytes:
    return frame_id.encode() + struct.pack(">I", len(body)) + b"\x00\x00"


def id3(frames: list[tuple[str, bytes]], version: int = 3) -> bytes:
    payload = b"".join(id3_frame(name, body)[:4] + (syncsafe(len(body)) if version == 4 else struct.pack(">I", len(body))) + b"\x00\x00" + body
                       for name, body in frames)
    return b"ID3" + bytes((version, 0, 0)) + syncsafe(len(payload)) + payload


def mpeg_frames(count: int = 4) -> bytes:
    # MPEG-1 Layer III，128 kbps，44.1 kHz，立体声：每帧 417 字节。
    header = b"\xff\xfb\x90\x00"
    return (header + b"\x00" * 413) * count


def xing_frame(frames: int) -> bytes:
    body = bytearray(b"\xff\xfb\x90\x00" + b"\x00" * 413)
    body[36:48] = b"Xing" + struct.pack(">II", 1, frames)
    return bytes(body)


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload) + 8) + kind + payload


def ebml(element: int, payload: bytes) -> bytes:
    element_bytes = element.to_bytes((element.bit_length() + 7) // 8, "big")
    return element_bytes + bytes((0x01,)) + len(payload).to_bytes(7, "big") + payload


class Id3Tests(unittest.TestCase):
    def test_text_frames_lyrics_and_duration(self):
        lyrics = "[00:01.00]第一句\n[00:05.20]第二句"
        tag = id3([
            ("TIT2", b"\x03" + "晴天".encode()),
            ("TPE1", b"\x01" + "周杰伦".encode("utf-16")),
            ("TALB", b"\x00" + "叶惠美".encode("gb18030")),
            ("TRCK", b"\x00" + b"3/11"),
            ("TYER", b"\x00" + b"2003"),
            ("TCON", b"\x00" + b"(13)"),
            ("USLT", b"\x03" + b"chi" + b"\x00" + lyrics.encode()),
            ("TXXX", b"\x00" + b"MusicBrainz Album Id\x00" + b"abc-123"),
        ])
        result, _ = run(tag + xing_frame(1000) + mpeg_frames())
        self.assertEqual((result.container, result.title, result.artist, result.album), ("mp3", "晴天", "周杰伦", "叶惠美"))
        self.assertEqual((result.track, result.year, result.genre), ("3/11", "2003", "Pop"))
        self.assertAlmostEqual(result.duration, 1000 * 1152 / 44100, places=3)
        self.assertEqual(result.extra["musicbrainz_release"], "abc-123")
        best = result.best_lyrics()
        self.assertTrue(best.synced)
        self.assertEqual(best.language, "chi")
        self.assertIn("第二句", best.text)

    def test_sylt_becomes_lrc(self):
        body = b"\x03" + b"eng" + b"\x02" + b"\x01" + b"\x00" + b"Hello\x00" + struct.pack(">I", 1500) + b"World\x00" + struct.pack(">I", 62000)
        result, _ = run(id3([("SYLT", body)], version=4) + mpeg_frames())
        best = result.best_lyrics()
        self.assertTrue(best.synced)
        self.assertEqual(best.text, "[00:01.50]Hello\n[01:02.00]World")

    def test_large_picture_is_skipped_not_read(self):
        picture = b"\x00" + b"image/jpeg\x00" + b"\x03" + b"\x00" + b"\xff\xd8" + b"\x00" * (8 * 1024 * 1024)
        tag = id3([("APIC", picture), ("TIT2", b"\x03Song")])
        result, reads = run(tag + mpeg_frames())
        self.assertEqual(result.title, "Song")
        cover = result.cover()
        self.assertEqual(cover.mime, "image/jpeg")
        data = (tag + mpeg_frames())[cover.offset:cover.offset + cover.length]
        self.assertTrue(data.startswith(b"\xff\xd8"))
        self.assertLess(sum(end - start for start, end in reads), 1024 * 1024)

    def test_cbr_estimate_and_id3v1(self):
        frames = mpeg_frames(100)
        v1 = b"TAG" + b"Title".ljust(30, b"\x00") + b"Artist".ljust(30, b"\x00") + b"Album".ljust(30, b"\x00") + b"1999" + b"\x00" * 28 + b"\x00\x05" + bytes((17,))
        result, _ = run(frames + v1)
        self.assertEqual((result.title, result.artist, result.album, result.year, result.track, result.genre),
                         ("Title", "Artist", "Album", "1999", "5", "Rock"))
        self.assertAlmostEqual(result.duration, (len(frames) + 128) * 8 / 128000, places=2)


class FlacOggTests(unittest.TestCase):
    def vorbis(self, entries):
        vendor = b"test"
        body = struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", len(entries))
        for entry in entries:
            raw = entry.encode()
            body += struct.pack("<I", len(raw)) + raw
        return body

    def test_flac(self):
        rate, total = 44100, 44100 * 200
        packed = rate << 44 | 1 << 41 | 15 << 36 | total
        info = b"\x00" * 10 + packed.to_bytes(8, "big")
        comment = self.vorbis(["TITLE=夜曲", "ARTIST=周杰伦", "LYRICS=[00:01.00]a\n[00:02.00]b", "MUSICBRAINZ_TRACKID=rec-1"])
        picture_data = b"\x89PNG" + b"\x00" * 20
        picture = struct.pack(">II", 3, 9) + b"image/png" + struct.pack(">I", 0) + b"\x00" * 16 + struct.pack(">I", len(picture_data)) + picture_data
        blocks = (b"\x00" + len(info).to_bytes(3, "big") + info + b"\x04" + len(comment).to_bytes(3, "big") + comment
                  + b"\x86" + len(picture).to_bytes(3, "big") + picture)
        data = b"fLaC" + blocks + b"\x00" * 100
        result, _ = run(data)
        self.assertEqual((result.container, result.title, result.artist), ("flac", "夜曲", "周杰伦"))
        self.assertAlmostEqual(result.duration, 200)
        self.assertTrue(result.best_lyrics().synced)
        self.assertEqual(result.extra["musicbrainz_recording"], "rec-1")
        cover = result.cover()
        self.assertEqual(data[cover.offset:cover.offset + cover.length], picture_data)

    def page(self, packet: bytes, granule: int = 0, flags: int = 0) -> bytes:
        lacing = bytes([255] * (len(packet) // 255) + [len(packet) % 255])
        return b"OggS" + bytes((0, flags)) + struct.pack("<qIII", granule, 1, 0, 0) + bytes((len(lacing),)) + lacing + packet

    def test_opus(self):
        head = b"OpusHead" + bytes((1, 2)) + struct.pack("<HIh", 312, 48000, 0) + b"\x00"
        picture_data = b"\xff\xd8\xff" + b"\x00" * 10
        picture = struct.pack(">II", 3, 10) + b"image/jpeg" + struct.pack(">I", 0) + b"\x00" * 16 + struct.pack(">I", len(picture_data)) + picture_data
        tags = b"OpusTags" + self.vorbis(["title=Track", "artist=Band", "METADATA_BLOCK_PICTURE=" + base64.b64encode(picture).decode()])
        data = self.page(head, flags=2) + self.page(tags) + self.page(b"\x00" * 50, granule=48000 * 30 + 312, flags=4)
        result, _ = run(data)
        self.assertEqual((result.container, result.title, result.artist), ("opus", "Track", "Band"))
        self.assertAlmostEqual(result.duration, 30)
        self.assertEqual(result.cover().data, picture_data)


class Mp4Tests(unittest.TestCase):
    def ilst_item(self, kind: bytes, value: bytes, data_type: int = 1) -> bytes:
        return box(kind, box(b"data", struct.pack(">II", data_type, 0) + value))

    def track(self, handler: bytes, codec: bytes, language: str = "chi") -> bytes:
        packed = sum((ord(letter) - 0x60) << shift for letter, shift in zip(language, (10, 5, 0)))
        mdhd = box(b"mdhd", b"\x00" * 4 + b"\x00" * 8 + struct.pack(">II", 1000, 0) + struct.pack(">HH", packed, 0))
        hdlr = box(b"hdlr", b"\x00" * 8 + handler + b"\x00" * 12)
        stsd = box(b"stsd", b"\x00" * 4 + struct.pack(">I", 1) + box(codec, b"\x00" * 8))
        return box(b"trak", box(b"tkhd", b"\x00\x00\x00\x01" + b"\x00" * 80) + box(b"mdia", mdhd + hdlr + box(b"minf", box(b"stbl", stsd))))

    def test_moov_at_end(self):
        mvhd = box(b"mvhd", b"\x00" * 4 + b"\x00" * 8 + struct.pack(">II", 1000, 125500) + b"\x00" * 80)
        cover = b"\xff\xd8\xff\xe0" + b"\x00" * 32
        ilst = box(b"ilst", self.ilst_item(b"\xa9nam", "七里香".encode()) + self.ilst_item(b"\xa9ART", b"Jay")
                   + self.ilst_item(b"trkn", struct.pack(">HHHH", 0, 7, 10, 0), 0) + self.ilst_item(b"\xa9day", b"2004-08-03")
                   + self.ilst_item(b"\xa9lyr", b"plain lyric line") + self.ilst_item(b"covr", cover, 13))
        meta = box(b"meta", b"\x00" * 4 + box(b"hdlr", b"\x00" * 8 + b"mdir" + b"\x00" * 12) + ilst)
        moov = box(b"moov", mvhd + self.track(b"vide", b"avc1", "und") + self.track(b"sbtl", b"tx3g") + self.track(b"text", b"tx3g", "eng") + box(b"udta", meta))
        data = box(b"ftyp", b"M4A " + b"\x00" * 4) + box(b"mdat", b"\x00" * (3 * 1024 * 1024)) + moov
        result, reads = run(data)
        self.assertEqual((result.title, result.artist, result.track, result.year), ("七里香", "Jay", "7", "2004"))
        self.assertAlmostEqual(result.duration, 125.5)
        self.assertFalse(result.best_lyrics().synced)
        found = result.cover()
        self.assertEqual(data[found.offset:found.offset + found.length], cover)
        self.assertEqual([(item.index, item.codec, item.language, item.text) for item in result.subtitles],
                         [(0, "tx3g", "chi", True), (1, "tx3g", "eng", True)])
        self.assertLess(sum(end - start for start, end in reads), 512 * 1024)


class MatroskaTests(unittest.TestCase):
    def test_tracks_and_info(self):
        info = ebml(0x1549A966, ebml(0x2AD7B1, (1_000_000).to_bytes(3, "big")) + ebml(0x4489, struct.pack(">d", 90_000.0)) + ebml(0x7BA9, "电影".encode()))
        video = ebml(0xAE, ebml(0xD7, b"\x01") + ebml(0x83, b"\x01") + ebml(0x86, b"V_MPEG4/ISO/AVC"))
        sub1 = ebml(0xAE, ebml(0xD7, b"\x02") + ebml(0x83, b"\x11") + ebml(0x86, b"S_TEXT/UTF8") + ebml(0x22B59C, b"chi") + ebml(0x536E, "简体".encode()))
        sub2 = ebml(0xAE, ebml(0xD7, b"\x03") + ebml(0x83, b"\x11") + ebml(0x86, b"S_HDMV/PGS") + ebml(0x22B59C, b"eng") + ebml(0x88, b"\x00"))
        tracks = ebml(0x1654AE6B, video + sub1 + sub2)
        cluster = ebml(0x1F43B675, b"\x00" * 4096)
        segment = ebml(0x18538067, info + tracks + cluster)
        data = ebml(0x1A45DFA3, b"\x42\x82\x84webm") + segment
        result, _ = run(data)
        self.assertEqual(result.container, "matroska")
        self.assertEqual(result.title, "电影")
        self.assertAlmostEqual(result.duration, 90)
        self.assertEqual([(item.index, item.codec, item.language, item.title, item.default, item.text) for item in result.subtitles],
                         [(0, "S_TEXT/UTF8", "chi", "简体", True, True), (1, "S_HDMV/PGS", "eng", None, False, False)])


class RobustnessTests(unittest.TestCase):
    def test_unknown_and_truncated(self):
        self.assertIsNone(run(b"plain text file content")[0])
        result, _ = run(id3([("TIT2", b"\x03Name")])[:-2])
        self.assertEqual(result.container, "mp3")

    def test_budget_returns_partial(self):
        tag = id3([("TIT2", b"\x03Name")] + [("TXXX", b"\x00x\x00" + b"y" * 200_000)] * 3)
        result, reads = run(tag + mpeg_frames(), budget=300_000)
        self.assertEqual(result.title, "Name")
        self.assertLessEqual(sum(end - start for start, end in reads), 300_000)


if __name__ == "__main__":
    unittest.main()
