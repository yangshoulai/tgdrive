"""给 FFmpeg 管道输出的分片 MP4 补上总时长。

FFmpeg 写管道时无法回头改写文件头，`empty_moov` 输出的 moov 里时长为 0，也没有 mehd（分片文件的总时长）。
浏览器只能从文件头得知时长：Safari 会把第一个分片（约 2 秒）当成整段视频，Chrome 则反复请求试探长度。
这里在流经时改写文件头：写入 mvhd 时长并在 mvex 中加入 mehd，所需空间取自 FFmpeg 写入的 udta
（编码器信息），moov 总大小不变，后面所有分片和 mfra 中的绝对偏移因此保持有效；不缓存整个文件，也不写临时文件。
"""

from __future__ import annotations

import struct
from collections.abc import AsyncIterator

# 文件头（ftyp + 空 moov）通常只有一两 KB；超过这个长度仍未凑齐就放弃改写，原样输出。
HEADER_LIMIT = 1024 * 1024
MEHD_SIZE = 20  # version 1：8 字节头 + 4 字节版本／标志 + 8 字节时长


def _boxes(data: bytes | bytearray, start: int, end: int):
    """依次返回 (类型, 起点, 头长, 总长)；遇到不完整的盒子停止。"""
    position = start
    while position + 8 <= end:
        size, kind = struct.unpack(">I4s", data[position:position + 8])
        header = 8
        if size == 1:
            if position + 16 > end:
                return
            size, header = struct.unpack(">Q", data[position + 8:position + 16])[0], 16
        elif size == 0:
            size = end - position
        if size < header:
            return
        yield kind, position, header, size
        position += size


def patch_duration(data: bytes | bytearray, seconds: float) -> bytes | None:
    """返回改写后的文件头开头部分（与输入等长）；数据还不够判断时返回 None；无需或无法改写时原样返回。"""
    top = list(_boxes(data, 0, len(data)))
    if top and top[0][0] != b"ftyp":
        return bytes(data)
    if len(top) < 2:
        return None if len(data) < HEADER_LIMIT else bytes(data)
    kind, moov_at, moov_header, moov_size = top[1]
    if kind != b"moov":
        return bytes(data)
    if moov_at + moov_size > len(data):
        return None if len(data) < HEADER_LIMIT else bytes(data)
    children = list(_boxes(data, moov_at + moov_header, moov_at + moov_size))
    found = {kind: (at, header, size) for kind, at, header, size in children}
    if b"mvhd" not in found or b"mvex" not in found or b"udta" not in found:
        return bytes(data)
    mvex_at, mvex_header, mvex_size = found[b"mvex"]
    if any(kind == b"mehd" for kind, *_ in _boxes(data, mvex_at + mvex_header, mvex_at + mvex_size)):
        return bytes(data)
    udta_size = found[b"udta"][2]
    spare = udta_size - MEHD_SIZE
    if spare != 0 and spare < 8:
        return bytes(data)
    mvhd_at, mvhd_header, mvhd_size = found[b"mvhd"]
    mvhd = bytearray(data[mvhd_at:mvhd_at + mvhd_size])
    body = mvhd_header
    version = mvhd[body]
    if version == 1:
        timescale = struct.unpack(">I", mvhd[body + 20:body + 24])[0]
    else:
        timescale = struct.unpack(">I", mvhd[body + 12:body + 16])[0]
    if not timescale:
        return bytes(data)
    units = round(seconds * timescale)
    if version == 1:
        mvhd[body + 24:body + 32] = struct.pack(">Q", units)
    else:
        mvhd[body + 16:body + 20] = struct.pack(">I", min(units, 0xFFFFFFFF))
    mehd = struct.pack(">I4sB3xQ", MEHD_SIZE, b"mehd", 1, units)
    rebuilt = bytearray()
    for kind, at, header, size in children:
        if kind == b"mvhd":
            rebuilt += mvhd
        elif kind == b"mvex":
            # mvex 的头是 8 字节（大小不会超过 4 GB），mehd 按规范放在 trex 之前。
            rebuilt += struct.pack(">I4s", size + MEHD_SIZE, b"mvex") + mehd + data[at + header:at + size]
        elif kind == b"udta":
            if spare:
                rebuilt += struct.pack(">I4s", spare, b"free") + bytes(spare - 8)
        else:
            rebuilt += data[at:at + size]
    if moov_header != 8 or len(rebuilt) != moov_size - moov_header:
        return bytes(data)
    return bytes(data[:moov_at]) + struct.pack(">I4s", moov_size, b"moov") + bytes(rebuilt) + bytes(data[moov_at + moov_size:])


async def with_duration(stream: AsyncIterator[bytes], seconds: float | None) -> AsyncIterator[bytes]:
    """流式输出 stream；时长已知时改写开头的文件头。只缓存文件头那一小段。"""
    try:
        if not seconds or seconds <= 0:
            async for piece in stream:
                yield piece
            return
        buffer, done = bytearray(), False
        async for piece in stream:
            if done:
                yield piece
                continue
            buffer += piece
            patched = patch_duration(buffer, seconds)
            if patched is not None:
                done = True
                yield patched
        if not done and buffer:
            yield bytes(buffer)
    finally:
        await stream.aclose()


class FragmentIndexer:
    """流经时记录分片 MP4 的每个分片（moof + mdat）的位置、大小和时长，最后生成放在 moov 之后的 sidx。

    Chrome 内置的 MP4 解析器遇到没有 sidx 的分片 MP4，会从头到尾读一遍所有分片来建立索引，
    1.5 GB 的视频要先下载完整个文件才能播放；有了覆盖全文件的 sidx，只读文件头就能开始播放和跳转。
    分片内部用相对 moof 的偏移（default_base_moof），在 moov 后插入 sidx 不影响它们；结尾的 mfra 用绝对偏移，
    插入后会失效，所以直接丢弃（sidx 已经提供了同样的索引）。无法识别的格式原样通过、不生成 sidx。
    """

    def __init__(self) -> None:
        self.moov_end: int | None = None
        self.tracks: list[tuple[int, int]] = []        # (track_ID, timescale)，与 moov 中的顺序一致
        self.defaults: dict[int, int] = {}              # track_ID → trex 默认样本时长
        self.offsets: list[int] = []                    # 每个 moof 的起点
        self.durations: dict[int, list[int]] = {}       # track_ID → 每个分片中该轨的时长
        self.first_times: dict[int, int] = {}           # track_ID → 第一个分片的 tfdt
        self.media_end: int | None = None               # 最后一个分片结束处（mfra 之前）
        self.valid = True
        self._position = 0

    def _parse_moov(self, box: bytes) -> None:
        moov = list(_boxes(box, 8, len(box)))
        tracks: list[tuple[int, int, bytes]] = []
        for kind, at, header, size in moov:
            if kind == b"trak":
                track_id, timescale, handler = None, 0, b""
                for k1, a1, h1, s1 in _boxes(box, at + header, at + size):
                    if k1 == b"tkhd":
                        body = box[a1 + h1:a1 + s1]
                        track_id = struct.unpack(">I", body[20:24] if body[0] == 1 else body[12:16])[0]
                    elif k1 == b"mdia":
                        for k2, a2, h2, s2 in _boxes(box, a1 + h1, a1 + s1):
                            body = box[a2 + h2:a2 + s2]
                            if k2 == b"mdhd":
                                timescale = struct.unpack(">I", body[20:24] if body[0] == 1 else body[12:16])[0]
                            elif k2 == b"hdlr":
                                handler = body[8:12]
                if track_id is not None:
                    tracks.append((track_id, timescale, handler))
            elif kind == b"mvex":
                for k1, a1, h1, s1 in _boxes(box, at + header, at + size):
                    if k1 == b"trex":
                        body = box[a1 + h1:a1 + s1]
                        self.defaults[struct.unpack(">I", body[4:8])[0]] = struct.unpack(">I", body[12:16])[0]
        # 每条轨都要有自己的 sidx：只给视频轨建索引时，Chrome 跳转仍会为了音频轨扫描整个文件。
        self.tracks = [(track_id, timescale) for track_id, timescale, _ in tracks]
        self.durations = {track_id: [] for track_id, _ in self.tracks}
        if not self.tracks or not self.defaults or not all(timescale for _, timescale in self.tracks):
            self.valid = False

    def _parse_moof(self, box: bytes, offset: int) -> None:
        self.offsets.append(offset)
        for durations in self.durations.values():
            durations.append(0)
        for kind, at, header, size in _boxes(box, 8, len(box)):
            if kind != b"traf":
                continue
            track_id, default_duration, start, duration = None, None, None, 0
            for k1, a1, h1, s1 in _boxes(box, at + header, at + size):
                body = box[a1 + h1:a1 + s1]
                flags = int.from_bytes(body[1:4], "big")
                if k1 == b"tfhd":
                    track_id = struct.unpack(">I", body[4:8])[0]
                    position = 8 + (8 if flags & 0x01 else 0) + (4 if flags & 0x02 else 0)
                    if flags & 0x08:
                        default_duration = struct.unpack(">I", body[position:position + 4])[0]
                elif k1 == b"tfdt":
                    start = struct.unpack(">Q", body[4:12])[0] if body[0] == 1 else struct.unpack(">I", body[4:8])[0]
                elif k1 == b"trun":
                    count = struct.unpack(">I", body[4:8])[0]
                    position = 8 + (4 if flags & 0x01 else 0) + (4 if flags & 0x04 else 0)
                    stride = sum(4 for bit in (0x100, 0x200, 0x400, 0x800) if flags & bit)
                    if flags & 0x100:
                        duration += sum(struct.unpack(">I", body[position + i * stride:position + i * stride + 4])[0] for i in range(count))
                    else:
                        fallback = default_duration if default_duration is not None else self.defaults.get(track_id or 0, 0)
                        duration += count * fallback
            if track_id not in self.durations:
                self.valid = False
                return
            self.durations[track_id][-1] += duration
            if start is not None:
                self.first_times.setdefault(track_id, start)

    async def observe(self, stream: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
        """原样转发 stream（丢弃末尾的 mfra），同时记录分片表。只缓存盒子头和 moov／moof。"""
        header, box = bytearray(), bytearray()
        mode, kind, need, start = None, b"", 0, 0   # mode：None 读盒子头；parse 攒齐后解析；pass 转发；drop 丢弃
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
                        start, need = self._position, size - len(header)
                        self._position += len(header)
                        if size < len(header):
                            # 无法识别的结构（含“延续到文件末尾”的盒子）：放弃索引，其余内容原样转发。
                            self.valid, mode, need = False, "pass", 1 << 62
                            output += header
                        elif kind in (b"moov", b"moof") and size <= 16 * 1024 * 1024:
                            mode, box = "parse", bytearray(header)
                        elif kind == b"mfra" and self.valid:
                            mode = "drop"
                            if self.media_end is None:
                                self.media_end = start
                        else:
                            mode = "pass"
                            output += header
                        header = bytearray()
                    else:
                        take = min(total - index, need)
                        if mode == "parse":
                            box += piece[index:index + take]
                        elif mode == "pass":
                            output += piece[index:index + take]
                        index += take
                        need -= take
                        self._position += take
                    if mode is not None and need == 0:
                        if mode == "parse":
                            if self.valid and kind == b"moov":
                                self._parse_moov(bytes(box))
                                self.moov_end = self._position
                            elif self.valid and self.moov_end is not None:
                                self._parse_moof(bytes(box), start)
                            else:
                                self.valid = False
                            output += box
                            box = bytearray()
                        mode = None
                if output:
                    yield bytes(output)
            # 流结束时还没收完的盒子（异常截断）原样交出，由封装器的退出码判断成败。
            if header or box:
                self.valid = False
                yield bytes(header) + bytes(box)
            if self.media_end is None:
                self.media_end = self._position
        finally:
            await stream.aclose()

    def sidx(self) -> bytes:
        """每条轨一个覆盖全部分片的 sidx（version 1），依次放在 moov 之后；分片表不可用时返回空字节。"""
        if not self.valid or self.moov_end is None or not self.offsets or len(self.offsets) > 0xFFFF:
            return b""
        sizes = [end - offset for offset, end in zip(self.offsets, self.offsets[1:] + [self.media_end])]
        if not all(0 < size < 1 << 31 for size in sizes):
            return b""
        boxes = []
        for track_id, timescale in self.tracks:
            durations = self.durations[track_id]
            if any(duration >= 1 << 32 for duration in durations):
                return b""
            # reference_type=0（媒体），starts_with_SAP=1（frag_keyframe 让每个分片都从关键帧开始），与 FFmpeg global_sidx 的写法一致。
            references = b"".join(struct.pack(">III", size, duration, 0x80000000) for size, duration in zip(sizes, durations))
            boxes.append((track_id, timescale, references))
        result, length = [], 40 + 12 * len(self.offsets)
        for index, (track_id, timescale, references) in enumerate(boxes):
            # first_offset：从本 sidx 末尾到第一个 moof 的距离，即后面其他 sidx 的总长。
            following = (len(boxes) - index - 1) * length
            body = struct.pack(">B3xIIQQHH", 1, track_id, timescale, self.first_times.get(track_id, 0), following, 0, len(self.offsets))
            result.append(struct.pack(">I4s", 8 + len(body) + len(references), b"sidx") + body + references)
        return b"".join(result)
