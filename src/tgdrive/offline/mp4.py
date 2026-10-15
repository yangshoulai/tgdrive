"""把 FFmpeg 管道输出的分片 MP4 边收边转换成普通 MP4（moov 在前、带完整样本表）。

FFmpeg 写管道时不能回头改写文件，只能输出分片 MP4（empty_moov）。分片 MP4 在浏览器里有两个问题：
Chrome 拖动进度时要从头扫描整个文件（即使带 sidx 索引，1.5 GB 的视频每拖一次都要读完全部数据），
Safari／iOS 也比普通 MP4 挑剔。普通 MP4 没有这些问题，但 moov 里的样本表要等全部数据输出后才知道，
且必须放在文件开头才能边下边播。

做法：分片的 moof 和 mdat 头在流经时解析并丢弃，只把音视频数据原样转发（离线下载从第 2 段起上传）；
同时记下每个样本的大小、时长、关键帧和位置。结束后生成完整的 moov，与文件开头的数据一起作为第 1 段最后上传。
内存只保留样本表（每个样本约 13 字节）和第 1 段，不写临时文件。
"""

from __future__ import annotations

import bisect
import struct
from array import array
from collections.abc import AsyncIterator

from .http import DownloadError

NON_SYNC = 0x00010000          # sample_is_non_sync_sample
MAX_BUFFERED_BOX = 16 * 1024 * 1024
# 由样本表重新生成的盒子；sbgp 的样本计数在分片文件里是空的，一并去掉。
REPLACED = {b"stts", b"ctts", b"stss", b"stsz", b"stz2", b"stsc", b"stco", b"co64", b"sdtp", b"sbgp"}
_LITTLE = array("I", [1]).tobytes()[0] == 1


def _be(values: array) -> bytes:
    """array 按大端字节输出（MP4 是大端）。"""
    if _LITTLE:
        values = array(values.typecode, values)
        values.byteswap()
    return values.tobytes()


def _boxes(data: bytes, start: int = 0, end: int | None = None):
    """依次返回 (类型, 起点, 头长, 总长)。"""
    end = len(data) if end is None else end
    position = start
    while position + 8 <= end:
        size, kind = struct.unpack(">I4s", data[position:position + 8])
        header = 8
        if size == 1:
            size, header = struct.unpack(">Q", data[position + 8:position + 16])[0], 16
        elif size == 0:
            size = end - position
        if size < header or position + size > end:
            raise DownloadError("视频封装结果格式异常")
        yield kind, position, header, size
        position += size


def _box(kind: bytes, payload: bytes) -> bytes:
    if 8 + len(payload) < 1 << 32:
        return struct.pack(">I4s", 8 + len(payload), kind) + payload
    return struct.pack(">I4sQ", 1, kind, 16 + len(payload)) + payload


def _full(kind: bytes, version: int, flags: int, payload: bytes) -> bytes:
    return _box(kind, struct.pack(">B", version) + flags.to_bytes(3, "big") + payload)


def _with_duration(kind: bytes, body: bytes, duration: int) -> bytes:
    """改写 mvhd／tkhd／mdhd 的时长；version 0 放不下时升级为 version 1。"""
    version = body[0]
    if version == 0 and duration >= 1 << 32:
        # version 0 的创建、修改时间是 4 字节；之后到 duration 之前：tkhd 是 track_ID + 保留，mvhd／mdhd 是 timescale。
        times = struct.unpack(">II", body[4:12])
        middle = body[12:20] if kind == b"tkhd" else body[12:16]
        rest = body[24:] if kind == b"tkhd" else body[20:]
        body = b"\x01" + body[1:4] + struct.pack(">QQ", *times) + middle + bytes(8) + rest
        version = 1
    at = (28 if kind == b"tkhd" else 24) if version == 1 else (20 if kind == b"tkhd" else 16)
    width = 8 if version == 1 else 4
    return body[:at] + duration.to_bytes(width, "big") + body[at + width:]


def _runs(values) -> list[tuple[int, int]]:
    result: list[list[int]] = []
    for value in values:
        if result and result[-1][1] == value:
            result[-1][0] += 1
        else:
            result.append([1, value])
    return [(count, value) for count, value in result]


class _Track:
    def __init__(self, track_id: int, timescale: int, trak: bytes) -> None:
        self.track_id, self.timescale, self.trak = track_id, timescale, trak
        self.defaults = (0, 0, 0)               # trex：时长、大小、标志
        self.sizes = array("I")
        self.durations = array("I")
        self.cts = array("i")
        self.sync = bytearray()
        self.chunks: list[tuple[int, int]] = []  # (在输入流中的起点, 样本数)，每个 trun 是一个 chunk


class Defragmenter:
    """payload() 只转发音视频数据并记录样本表；结束后 header() 给出 ftyp + moov + mdat 头，二者相接即普通 MP4。"""

    def __init__(self) -> None:
        self.ftyp = b""
        self.moov: list[tuple[bytes, bytes]] = []        # moov 的直接子盒子；trak 只记 track_ID，生成时重建
        self.tracks: dict[int, _Track] = {}
        self.movie_timescale = 0
        self.segments: list[tuple[int, int, int]] = []   # 每个 mdat 的数据：(输入起点, 长度, 输出起点)
        self.length = 0                                   # 已转发的数据总长
        self._position = 0

    # ---------- 解析 ----------

    def _parse_moov(self, box: bytes) -> None:
        for kind, at, header, size in _boxes(box, 8):
            raw = box[at:at + size]
            if kind == b"mvhd":
                body = raw[header:]
                self.movie_timescale = struct.unpack(">I", body[20:24] if body[0] == 1 else body[12:16])[0]
                self.moov.append((kind, raw))
            elif kind == b"trak":
                track_id, timescale = None, 0
                for k1, a1, h1, s1 in _boxes(box, at + header, at + size):
                    if k1 == b"tkhd":
                        body = box[a1 + h1:a1 + s1]
                        track_id = struct.unpack(">I", body[20:24] if body[0] == 1 else body[12:16])[0]
                    elif k1 == b"mdia":
                        for k2, a2, h2, s2 in _boxes(box, a1 + h1, a1 + s1):
                            if k2 == b"mdhd":
                                body = box[a2 + h2:a2 + s2]
                                timescale = struct.unpack(">I", body[20:24] if body[0] == 1 else body[12:16])[0]
                if track_id is None or not timescale or track_id in self.tracks:
                    raise DownloadError("视频封装结果缺少轨道信息")
                self.tracks[track_id] = _Track(track_id, timescale, raw)
                self.moov.append((kind, struct.pack(">I", track_id)))
            elif kind == b"mvex":
                # 普通 MP4 不需要 mvex，只取各轨的默认样本参数。
                for k1, a1, h1, s1 in _boxes(box, at + header, at + size):
                    if k1 == b"trex":
                        track_id, _, duration, sample_size, flags = struct.unpack(">IIIII", box[a1 + h1 + 4:a1 + h1 + 24])
                        if track_id in self.tracks:
                            self.tracks[track_id].defaults = (duration, sample_size, flags)
            else:
                self.moov.append((kind, raw))
        if not self.tracks or not self.movie_timescale:
            raise DownloadError("视频封装结果缺少轨道信息")

    def _parse_traf(self, box: bytes, start: int, end: int, moof_start: int) -> None:
        track, base, defaults, cursor = None, moof_start, None, None
        for kind, at, header, size in _boxes(box, start, end):
            body = box[at + header:at + size]
            version, flags = body[0], int.from_bytes(body[1:4], "big")
            if kind == b"tfhd":
                track = self.tracks.get(struct.unpack(">I", body[4:8])[0])
                if track is None:
                    raise DownloadError("视频封装结果格式异常")
                duration, sample_size, sample_flags = track.defaults
                position = 8
                if flags & 0x01:
                    base = struct.unpack(">Q", body[position:position + 8])[0]
                    position += 8
                if flags & 0x02:
                    position += 4
                if flags & 0x08:
                    duration = struct.unpack(">I", body[position:position + 4])[0]
                    position += 4
                if flags & 0x10:
                    sample_size = struct.unpack(">I", body[position:position + 4])[0]
                    position += 4
                if flags & 0x20:
                    sample_flags = struct.unpack(">I", body[position:position + 4])[0]
                defaults = (duration, sample_size, sample_flags)
            elif kind == b"trun":
                if track is None or defaults is None:
                    raise DownloadError("视频封装结果格式异常")
                count, position = struct.unpack(">I", body[4:8])[0], 8
                # 有 data_offset 时相对 moof（default-base-is-moof）；否则紧接上一个 trun 的数据。
                first = cursor if cursor is not None else base
                if flags & 0x01:
                    first = base + struct.unpack(">i", body[position:position + 4])[0]
                    position += 4
                first_flags = None
                if flags & 0x04:
                    first_flags = struct.unpack(">I", body[position:position + 4])[0]
                    position += 4
                total = 0
                for index in range(count):
                    duration, sample_size, sample_flags = defaults
                    cts = 0
                    if flags & 0x100:
                        duration = struct.unpack(">I", body[position:position + 4])[0]
                        position += 4
                    if flags & 0x200:
                        sample_size = struct.unpack(">I", body[position:position + 4])[0]
                        position += 4
                    if flags & 0x400:
                        sample_flags = struct.unpack(">I", body[position:position + 4])[0]
                        position += 4
                    elif index == 0 and first_flags is not None:
                        sample_flags = first_flags
                    if flags & 0x800:
                        cts = struct.unpack(">i" if version else ">I", body[position:position + 4])[0]
                        position += 4
                    track.sizes.append(sample_size)
                    track.durations.append(duration)
                    track.cts.append(cts)
                    track.sync.append(0 if sample_flags & NON_SYNC else 1)
                    total += sample_size
                if count:
                    track.chunks.append((first, count))
                cursor = first + total

    def _parse_moof(self, box: bytes, moof_start: int) -> None:
        for kind, at, header, size in _boxes(box, 8):
            if kind == b"traf":
                self._parse_traf(box, at + header, at + size, moof_start)

    async def payload(self, stream: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
        """只转发 mdat 里的音视频数据；ftyp、moov、moof 留下解析，其余顶层盒子（mfra 等）丢弃。"""
        header, box = bytearray(), bytearray()
        mode, kind, need, start = None, b"", 0, 0   # mode：None 读盒子头；parse 攒齐后解析；data 转发；drop 丢弃
        try:
            async for piece in stream:
                output, index, total = bytearray(), 0, len(piece)
                while index < total:
                    if mode is None:
                        target = 16 if len(header) >= 8 and struct.unpack(">I", header[:4])[0] == 1 else 8
                        take = min(total - index, target - len(header))
                        header += piece[index:index + take]
                        index += take
                        if len(header) < target:
                            continue
                        size, kind = struct.unpack(">I4s", header[:8])
                        if size == 1 and target == 8:
                            continue
                        if size == 1:
                            size = struct.unpack(">Q", header[8:16])[0]
                        if size < len(header):
                            raise DownloadError("视频封装结果格式异常")
                        start, need = self._position, size - len(header)
                        self._position += len(header)
                        if kind in (b"ftyp", b"moov", b"moof"):
                            if size > MAX_BUFFERED_BOX:
                                raise DownloadError("视频封装结果格式异常")
                            mode, box = "parse", bytearray(header)
                        elif kind == b"mdat":
                            if not self.tracks:
                                raise DownloadError("视频封装结果格式异常")
                            mode = "data"
                            self.segments.append((self._position, need, self.length))
                            self.length += need
                        else:
                            mode = "drop"
                        header = bytearray()
                    else:
                        take = min(total - index, need)
                        if mode == "parse":
                            box += piece[index:index + take]
                        elif mode == "data":
                            output += piece[index:index + take]
                        index += take
                        need -= take
                        self._position += take
                    if mode is not None and need == 0:
                        if mode == "parse":
                            data = bytes(box)
                            if kind == b"ftyp":
                                self.ftyp = data
                            elif kind == b"moov":
                                self._parse_moov(data)
                            elif not self.tracks:
                                raise DownloadError("视频封装结果格式异常")
                            else:
                                self._parse_moof(data, start)
                            box = bytearray()
                        mode = None
                if output:
                    yield bytes(output)
            if header or mode is not None:
                raise DownloadError("视频封装结果不完整")
            if not self.ftyp or not any(track.sizes for track in self.tracks.values()):
                raise DownloadError("视频封装结果没有音视频数据")
        finally:
            await stream.aclose()

    # ---------- 生成 ----------

    def _output_offset(self, position: int) -> int:
        """输入流中的位置 → 转发数据中的位置。"""
        index = bisect.bisect_right(self.segments, (position, 1 << 62, 0)) - 1
        if index < 0:
            raise DownloadError("视频封装结果格式异常")
        start, length, output = self.segments[index]
        if not start <= position <= start + length:
            raise DownloadError("视频封装结果格式异常")
        return output + position - start

    def _stbl(self, track: _Track, base: int, wide: bool) -> bytes:
        stts = _runs(track.durations)
        boxes = [_full(b"stts", 0, 0, struct.pack(">I", len(stts)) + b"".join(struct.pack(">II", *item) for item in stts))]
        if any(track.cts):
            ctts = _runs(track.cts)
            signed = any(value < 0 for _, value in ctts)
            boxes.append(_full(b"ctts", 1 if signed else 0, 0, struct.pack(">I", len(ctts)) + b"".join(
                struct.pack(">Ii" if signed else ">II", *item) for item in ctts)))
        if not all(track.sync):
            sync = array("I", (index + 1 for index, flag in enumerate(track.sync) if flag))
            boxes.append(_full(b"stss", 0, 0, struct.pack(">I", len(sync)) + _be(sync)))
        stsc, previous = [], None
        for number, (_, samples) in enumerate(track.chunks, 1):
            if samples != previous:
                stsc.append(struct.pack(">III", number, samples, 1))
                previous = samples
        boxes.append(_full(b"stsc", 0, 0, struct.pack(">I", len(stsc)) + b"".join(stsc)))
        if len(set(track.sizes)) == 1:
            boxes.append(_full(b"stsz", 0, 0, struct.pack(">II", track.sizes[0], len(track.sizes))))
        else:
            boxes.append(_full(b"stsz", 0, 0, struct.pack(">II", 0, len(track.sizes)) + _be(track.sizes)))
        offsets = [base + self._output_offset(position) for position, _ in track.chunks]
        if wide:
            boxes.append(_full(b"co64", 0, 0, struct.pack(">I", len(offsets)) + _be(array("Q", offsets))))
        else:
            boxes.append(_full(b"stco", 0, 0, struct.pack(">I", len(offsets)) + _be(array("I", offsets))))
        return b"".join(boxes)

    @staticmethod
    def _elst(body: bytes, movie_duration: int) -> bytes:
        """分片文件的编辑列表用 0 表示“到轨道结尾”；普通 MP4 要写实际时长（扣除前面的空编辑）。"""
        version, count = body[0], struct.unpack(">I", body[4:8])[0]
        fmt, width = (">QqI", 20) if version else (">IiI", 12)
        entries = [struct.unpack(fmt, body[8 + i * width:8 + (i + 1) * width]) for i in range(count)]
        empty = sum(duration for duration, media_time, _ in entries if media_time == -1)
        fixed = [(max(movie_duration - empty, 0) if duration == 0 and media_time != -1 else duration, media_time, rate)
                 for duration, media_time, rate in entries]
        if version == 0 and any(duration >= 1 << 32 for duration, _, _ in fixed):
            version, fmt = 1, ">QqI"
        return struct.pack(">B", version) + body[1:4] + struct.pack(">I", count) + b"".join(struct.pack(fmt, *entry) for entry in fixed)

    def _trak(self, track: _Track, base: int, wide: bool) -> tuple[bytes, int]:
        media_duration = sum(track.durations)
        movie_duration = media_duration * self.movie_timescale // track.timescale
        raw = track.trak

        def rebuild(start: int, end: int) -> bytes:
            parts = []
            for kind, at, header, size in _boxes(raw, start, end):
                body = raw[at + header:at + size]
                if kind in (b"mdia", b"minf", b"edts"):
                    parts.append(_box(kind, rebuild(at + header, at + size)))
                elif kind == b"stbl":
                    kept = b"".join(raw[a:a + s] for k, a, _, s in _boxes(raw, at + header, at + size) if k not in REPLACED)
                    parts.append(_box(kind, kept + self._stbl(track, base, wide)))
                elif kind in (b"tkhd", b"mdhd"):
                    parts.append(_box(kind, _with_duration(kind, body, movie_duration if kind == b"tkhd" else media_duration)))
                elif kind == b"elst":
                    parts.append(_box(kind, self._elst(body, movie_duration)))
                else:
                    parts.append(raw[at:at + size])
            return b"".join(parts)

        _, at, header, size = next(_boxes(raw))
        return _box(b"trak", rebuild(at + header, at + size)), movie_duration

    def _moov(self, base: int, wide: bool) -> bytes:
        traks, longest = {}, 0
        for track_id, track in self.tracks.items():
            traks[track_id], duration = self._trak(track, base, wide)
            longest = max(longest, duration)
        parts = []
        for kind, raw in self.moov:
            if kind == b"trak":
                parts.append(traks[struct.unpack(">I", raw)[0]])
            elif kind == b"mvhd":
                parts.append(_box(kind, _with_duration(kind, raw[8:], longest)))
            else:
                parts.append(raw)
        return _box(b"moov", b"".join(parts))

    def header(self) -> bytes:
        """ftyp + moov + mdat 头；之后紧跟 payload() 转发的全部数据即为完整的普通 MP4。"""
        if self.length + 8 < 1 << 32:
            mdat = struct.pack(">I4s", 8 + self.length, b"mdat")
        else:
            mdat = struct.pack(">I4sQ", 1, b"mdat", 16 + self.length)
        # 样本位置取决于 moov 的长度，moov 的长度又取决于用 stco 还是 co64：先按 stco 计算，放不下再换 co64。
        for wide in (False, True):
            base = len(self.ftyp) + len(self._moov(0, wide)) + len(mdat)
            if wide or base + self.length < 1 << 32:
                return self.ftyp + self._moov(base, wide) + mdat
        raise AssertionError("unreachable")
