"""读取音视频文件自带的元数据：标签、时长、内嵌歌词、内嵌封面与字幕轨（纯 Python，不依赖 FFmpeg）。

只按需读取文件头与少量索引结构（经 ``read(start, end)`` 回调按字节范围读取），不读取音视频数据本身：
- ID3v2.2–2.4（MP3、WAV 的 id3 块）：常用文本帧、USLT／SYLT 歌词、APIC 封面（只记位置）、TXXX 中的 MusicBrainz 编号；
  MP3 时长取 Xing／Info／VBRI 帧，没有时按码率估算；没有 ID3v2 时退回文件末尾的 ID3v1。
- FLAC、Ogg Vorbis／Opus：Vorbis Comment（含 LYRICS）、PICTURE、时长。
- MP4／M4A／MOV：mvhd 时长、ilst 标签与 covr 封面、字幕轨（tx3g、wvtt 等）。
- Matroska／WebM：Info 标题与时长、字幕轨、Tags、封面附件。
- WAV：fmt／data 时长、LIST INFO、内嵌 ID3。

字幕轨的 ``index`` 是它在全部字幕流中的序号（FFmpeg 的 ``0:s:N``），用于提取。
"""

from __future__ import annotations

import base64
import re
import struct
import zlib
from dataclasses import dataclass, field
from typing import Awaitable, Callable

Reader = Callable[[int, int], Awaitable[bytes]]

PARSER_VERSION = 3
READ_BUDGET = 16 * 1024 * 1024   # 单个文件解析时最多读取的字节数
WINDOW = 64 * 1024               # 每次回源至少读取这么多，减少往返
FIELD_LIMIT = 1024 * 1024        # 单个标签字段（歌词等）最多读取这么多
TEXT_LIMIT = 512                 # 普通文本标签保留的字符数


@dataclass
class Lyrics:
    text: str
    synced: bool
    language: str | None = None
    source: str = ""


@dataclass
class Picture:
    """内嵌封面：offset／length 是在文件中的字节范围；Ogg 等以 Base64 存放的图片直接带 data。"""
    mime: str | None
    offset: int = 0
    length: int = 0
    data: bytes | None = None
    front: bool = True


@dataclass
class SubtitleStream:
    index: int
    codec: str
    language: str | None = None
    title: str | None = None
    default: bool = False
    text: bool = True   # 文本字幕可以转成 WebVTT；图片字幕（PGS、VobSub 等）不行


@dataclass
class MediaTags:
    container: str
    duration: float | None = None
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    album_artist: str | None = None
    track: str | None = None
    year: str | None = None
    genre: str | None = None
    extra: dict[str, str] = field(default_factory=dict)
    lyrics: list[Lyrics] = field(default_factory=list)
    pictures: list[Picture] = field(default_factory=list)
    subtitles: list[SubtitleStream] = field(default_factory=list)

    def set(self, name: str, value: str | None) -> None:
        """只填写还没有值的字段：同一文件的多个标签块里，先读到的优先。"""
        value = _clean(value)
        if value and not getattr(self, name):
            setattr(self, name, value[:TEXT_LIMIT])

    def best_lyrics(self) -> Lyrics | None:
        return next((item for item in self.lyrics if item.synced), None) or (self.lyrics[0] if self.lyrics else None)

    def cover(self) -> Picture | None:
        return next((item for item in self.pictures if item.front), None) or (self.pictures[0] if self.pictures else None)


class _Budget(Exception):
    pass


class _Source:
    """带缓冲的按范围读取：连续的小读取合并成一个窗口，并限制总读取量。"""

    def __init__(self, read: Reader, size: int, budget: int = READ_BUDGET):
        self._read, self.size, self.budget = read, size, budget
        self.used = 0
        self._start, self._data = 0, b""

    async def get(self, start: int, length: int) -> bytes:
        if start < 0 or length <= 0 or start >= self.size:
            return b""
        end = min(self.size, start + length)
        if self._start <= start and end <= self._start + len(self._data):
            return self._data[start - self._start:end - self._start]
        fetch_end = min(self.size, max(end, start + WINDOW))
        if self.used + (fetch_end - start) > self.budget:
            fetch_end = end
            if self.used + (fetch_end - start) > self.budget:
                raise _Budget()
        data = await self._read(start, fetch_end)
        self.used += len(data)
        self._start, self._data = start, data
        return data[:end - start]


# ---------- 文本工具 ----------

_LRC_LINE = re.compile(r"^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]", re.MULTILINE)
_CJK = re.compile(r"[　-鿿가-힯＀-￯]")


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.replace("\x00", " ").strip()
    return value or None


def _legacy(data: bytes) -> str:
    """ID3 声明 ISO-8859-1 的文本实际上常是 GBK：能按 GB18030 严格解出中日韩文字时采用它。"""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    if any(byte >= 0x80 for byte in data):
        try:
            text = data.decode("gb18030")
            if _CJK.search(text):
                return text
        except UnicodeDecodeError:
            pass
    return data.decode("latin-1")


def _unicode(data: bytes) -> str:
    """标准 UTF-8 优先；兼容旧工具写入的 GBK 标签，避免先用替换字符丢失原文。"""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return _legacy(data)


def is_synced(text: str) -> bool:
    return len(_LRC_LINE.findall(text)) >= 2


def _language(code: str | None, text: str) -> str | None:
    code = (code or "").strip().lower()
    if not re.fullmatch(r"[a-z]{3}", code) or code in ("xxx", "und", "zxx"):
        return None
    if code == "eng" and _CJK.search(text):
        return None   # 很多软件把未知语言一律写成 eng
    return code


def _lyrics(text: str | None, source: str, language: str | None = None) -> Lyrics | None:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return None
    return Lyrics(text[:FIELD_LIMIT], is_synced(text), _language(language, text), source)


def _year(value: str | None) -> str | None:
    match = re.search(r"\b(1[89]\d\d|2[01]\d\d)\b", value or "")
    return match.group(1) if match else None


_GENRES = ("Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop", "Jazz", "Metal", "New Age", "Oldies",
           "Other", "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno", "Industrial", "Alternative", "Ska", "Death Metal", "Pranks",
           "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance", "Classical", "Instrumental",
           "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise", "Alternative Rock", "Bass", "Soul", "Punk", "Space", "Meditative",
           "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial", "Electronic", "Pop-Folk",
           "Eurodance", "Dream", "Southern Rock", "Comedy", "Cult", "Gangsta", "Top 40", "Christian Rap", "Pop/Funk", "Jungle",
           "Native American", "Cabaret", "New Wave", "Psychedelic", "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk",
           "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock")


def _genre(value: str | None) -> str | None:
    value = _clean(value)
    if not value:
        return None
    match = re.fullmatch(r"\((\d+)\)(.*)", value)
    if match:
        index = int(match.group(1))
        return _clean(match.group(2)) or (_GENRES[index] if index < len(_GENRES) else None)
    if value.isdigit() and int(value) < len(_GENRES):
        return _GENRES[int(value)]
    return value


_MUSICBRAINZ = {
    "musicbrainz_trackid": "musicbrainz_recording", "musicbrainz track id": "musicbrainz_recording",
    "musicbrainz_releasetrackid": "musicbrainz_track", "musicbrainz release track id": "musicbrainz_track",
    "musicbrainz_albumid": "musicbrainz_release", "musicbrainz album id": "musicbrainz_release",
    "musicbrainz_releasegroupid": "musicbrainz_release_group", "musicbrainz release group id": "musicbrainz_release_group",
    "musicbrainz_artistid": "musicbrainz_artist", "musicbrainz artist id": "musicbrainz_artist",
    "isrc": "isrc",
}


def _extra(tags: MediaTags, name: str, value: str | None) -> None:
    name = name.strip().lower()
    value = _clean(value)
    aliases = {"composer": "composer", "director": "director", "actor": "actors", "actors": "actors", "cast": "actors",
               "description": "description", "comment": "description", "synopsis": "description"}
    if name in aliases and value:
        tags.extra.setdefault(aliases[name], value[:16384 if aliases[name] == "description" else 4096])
        return
    key = _MUSICBRAINZ.get(name)
    if key and value and key not in tags.extra:
        tags.extra[key] = value.split("/")[0].strip()[:64]


# ---------- 入口 ----------

async def parse(read: Reader, size: int, *, budget: int = READ_BUDGET) -> MediaTags | None:
    """识别容器并解析；不认识的格式返回 None。读取量超出预算时返回已解析到的部分。"""
    source = _Source(read, size, budget)
    head = await source.get(0, 64)
    if len(head) < 12:
        return None
    tags: MediaTags | None = None
    try:
        if head[:3] == b"ID3":
            tags = MediaTags("mp3")
            end = await _id3(source, 0, tags)
            marker = await source.get(end, 4)
            if marker == b"fLaC":
                tags.container = "flac"
                await _flac(source, end, tags)
            else:
                await _mpeg_duration(source, end, tags)
                await _id3v1(source, tags)
            return tags
        if head[:4] == b"fLaC":
            tags = MediaTags("flac")
            await _flac(source, 0, tags)
            return tags
        if head[:4] == b"OggS":
            tags = MediaTags("ogg")
            await _ogg(source, tags)
            return tags
        if head[4:8] == b"ftyp":
            tags = MediaTags("mp4")
            await _mp4(source, tags)
            return tags
        if head[:4] == b"\x1a\x45\xdf\xa3":
            tags = MediaTags("matroska")
            await _matroska(source, tags)
            return tags
        if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
            tags = MediaTags("wav")
            await _wav(source, tags)
            return tags
        if _frame_header(head[:4]) is not None:
            tags = MediaTags("mp3")
            await _mpeg_duration(source, 0, tags)
            await _id3v1(source, tags)
            return tags
    except _Budget:
        return tags
    except (struct.error, IndexError, ValueError, zlib.error):
        # 结构损坏时保留已读出的字段，不让一个坏标签影响播放。
        return tags
    return None


# ---------- ID3 ----------

def _syncsafe(data: bytes) -> int:
    return (data[0] & 0x7F) << 21 | (data[1] & 0x7F) << 14 | (data[2] & 0x7F) << 7 | (data[3] & 0x7F)


def _unsync(data: bytes) -> bytes:
    return data.replace(b"\xff\x00", b"\xff")


def _id3_text(encoding: int, data: bytes) -> str:
    if encoding == 1:
        return data.decode("utf-16", errors="replace") if data[:2] in (b"\xff\xfe", b"\xfe\xff") else data.decode("utf-16-le", errors="replace")
    if encoding == 2:
        return data.decode("utf-16-be", errors="replace")
    if encoding == 3:
        return data.decode("utf-8", errors="replace")
    return _legacy(data)


def _split_terminated(encoding: int, data: bytes) -> tuple[bytes, bytes]:
    """按编码拆出以空字符结尾的一段（描述等），返回（这一段，其余部分）。"""
    if encoding in (1, 2):
        for index in range(0, len(data) - 1, 2):
            if data[index:index + 2] == b"\x00\x00":
                return data[:index], data[index + 2:]
        return data, b""
    index = data.find(b"\x00")
    return (data, b"") if index < 0 else (data[:index], data[index + 1:])


_ID3_TEXT = {"TIT2": "title", "TT2": "title", "TPE1": "artist", "TP1": "artist", "TALB": "album", "TAL": "album",
             "TPE2": "album_artist", "TP2": "album_artist", "TRCK": "track", "TRK": "track"}


async def _id3(source: _Source, start: int, tags: MediaTags) -> int:
    """解析一个 ID3v2 标签，返回标签之后的位置。"""
    header = await source.get(start, 10)
    major, flags = header[3], header[5]
    end = start + 10 + _syncsafe(header[6:10]) + (10 if flags & 0x10 else 0)
    if major not in (2, 3, 4):
        return end
    position = start + 10
    whole: bytes | None = None
    if flags & 0x80 and major < 4:
        # v2.2／2.3 的整体反同步要先还原整个标签才能按帧解析；过大的标签直接放弃。
        if end - position > FIELD_LIMIT * 4:
            return end
        whole = _unsync(await source.get(position, end - position))
    if flags & 0x40 and major >= 3:
        extended = whole[:4] if whole is not None else await source.get(position, 4)
        skip = (_syncsafe(extended) if major == 4 else struct.unpack(">I", extended)[0] + 4)
        position += skip
    header_size = 6 if major == 2 else 10
    cursor = position
    limit = end - (10 if flags & 0x10 else 0)
    while cursor + header_size <= limit:
        if whole is not None:
            offset = cursor - start - 10
            frame = whole[offset:offset + header_size]
        else:
            frame = await source.get(cursor, header_size)
        if len(frame) < header_size or frame[0] == 0:
            break
        if major == 2:
            frame_id, length, frame_flags = frame[:3].decode("latin-1"), int.from_bytes(frame[3:6], "big"), 0
        else:
            frame_id = frame[:4].decode("latin-1")
            length = _syncsafe(frame[4:8]) if major == 4 else struct.unpack(">I", frame[4:8])[0]
            frame_flags = struct.unpack(">H", frame[8:10])[0]
        if not re.fullmatch(r"[A-Z0-9]{3,4}", frame_id) or length <= 0:
            break
        body_start = cursor + header_size
        cursor = body_start + length
        if frame_id in ("APIC", "PIC"):
            await _id3_picture(source, whole, start, body_start, length, major, frame_flags, tags)
            continue
        wanted = frame_id in _ID3_TEXT or frame_id in ("TDRC", "TYER", "TYE", "TCON", "TCO", "TLEN", "TLE", "TXXX", "TXX",
                                                       "USLT", "ULT", "SYLT", "SLT", "TSRC", "TRC")
        if not wanted or length > FIELD_LIMIT:
            continue
        if whole is not None:
            offset = body_start - start - 10
            body = whole[offset:offset + length]
        else:
            body = await source.get(body_start, length)
        body = _id3_frame_body(body, major, frame_flags)
        if body is None or not body:
            continue
        _id3_frame(frame_id, body, tags)
    return end


def _id3_frame_body(body: bytes, major: int, flags: int) -> bytes | None:
    if major == 4:
        if flags & 0x0004:   # 加密
            return None
        if flags & 0x0001:   # 数据长度指示
            body = body[4:]
        if flags & 0x0002:
            body = _unsync(body)
        if flags & 0x0008:
            body = zlib.decompress(body)[:FIELD_LIMIT]
    elif major == 3:
        if flags & 0x0040:
            return None
        if flags & 0x0080:
            body = zlib.decompress(body[4:])[:FIELD_LIMIT]
    return body


def _id3_frame(frame_id: str, body: bytes, tags: MediaTags) -> None:
    encoding = body[0]
    if frame_id in ("USLT", "ULT"):
        language = body[1:4].decode("latin-1", errors="replace")
        _, text = _split_terminated(encoding, body[4:])
        item = _lyrics(_id3_text(encoding, text), "id3", language)
        if item:
            tags.lyrics.append(item)
        return
    if frame_id in ("SYLT", "SLT"):
        language = body[1:4].decode("latin-1", errors="replace")
        stamp_format = body[4]
        _, rest = _split_terminated(encoding, body[6:])
        if stamp_format != 2:   # 只支持毫秒时间戳；按 MPEG 帧计时的少见，跳过
            return
        lines = []
        while rest:
            text, rest = _split_terminated(encoding, rest)
            if len(rest) < 4:
                break
            stamp, rest = struct.unpack(">I", rest[:4])[0], rest[4:]
            minutes, millis = divmod(stamp, 60000)
            lines.append(f"[{minutes:02d}:{millis // 1000:02d}.{millis % 1000 // 10:02d}]{_id3_text(encoding, text).strip()}")
        if len(lines) >= 2:
            text = "\n".join(lines)[:FIELD_LIMIT]
            tags.lyrics.insert(0, Lyrics(text, True, _language(language, text), "id3"))
        return
    if frame_id in ("COMM", "COM") and len(body) > 4:
        _, value = _split_terminated(encoding, body[4:])
        _extra(tags, "description", _id3_text(encoding, value))
        return
    if frame_id in ("TXXX", "TXX"):
        description, value = _split_terminated(encoding, body[1:])
        _extra(tags, _id3_text(encoding, description), _id3_text(encoding, value))
        return
    text = _id3_text(encoding, body[1:])
    # v2.4 的多个值用空字符分隔。
    values = [item.strip() for item in text.split("\x00") if item.strip()]
    value = " / ".join(dict.fromkeys(values)) if values else None
    if frame_id in _ID3_TEXT:
        tags.set(_ID3_TEXT[frame_id], value)
    elif frame_id in ("TDRC", "TYER", "TYE"):
        tags.set("year", _year(value))
    elif frame_id in ("TCON", "TCO"):
        tags.set("genre", _genre(values[0] if values else None))
    elif frame_id in ("TLEN", "TLE") and value and value.isdigit() and tags.duration is None:
        tags.duration = int(value) / 1000
    elif frame_id in ("TCOM", "TCM"):
        _extra(tags, "composer", value)
    elif frame_id in ("TSRC", "TRC"):
        _extra(tags, "isrc", value)


async def _id3_picture(source, whole, start, body_start, length, major, flags, tags):
    if major == 4 and flags & 0x000F:
        return   # 压缩、加密或反同步的封面无法按原始字节范围读取
    head = (whole[body_start - start - 10:body_start - start - 10 + min(length, 512)] if whole is not None
            else await source.get(body_start, min(length, 512)))
    encoding = head[0]
    if major == 2:
        image_format, rest = head[1:4].decode("latin-1").upper(), head[4:]
        mime = {"JPG": "image/jpeg", "PNG": "image/png"}.get(image_format)
    else:
        mime_bytes, rest = _split_terminated(0, head[1:])
        mime = mime_bytes.decode("latin-1", errors="replace").lower() or None
        if mime and "/" not in mime:
            mime = "image/" + mime.replace("jpg", "jpeg")
    picture_type, rest = rest[0], rest[1:]
    _, rest = _split_terminated(encoding, rest)
    data_offset = len(head) - len(rest)
    if whole is not None or data_offset >= length:
        return
    tags.pictures.append(Picture(mime, body_start + data_offset, length - data_offset, front=picture_type in (0, 3)))


async def _id3v1(source: _Source, tags: MediaTags) -> None:
    if tags.title or source.size < 128:
        return
    data = await source.get(source.size - 128, 128)
    if data[:3] != b"TAG":
        return
    def text(raw: bytes) -> str:
        return _legacy(raw.split(b"\x00", 1)[0]).strip()
    tags.set("title", text(data[3:33]))
    tags.set("artist", text(data[33:63]))
    tags.set("album", text(data[63:93]))
    tags.set("year", _year(text(data[93:97])))
    if data[125] == 0 and data[126]:
        tags.set("track", str(data[126]))
    if data[127] < len(_GENRES):
        tags.set("genre", _GENRES[data[127]])


# ---------- MPEG 音频时长 ----------

_BITRATES = {
    (1, 1): (0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448),
    (1, 2): (0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384),
    (1, 3): (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320),
    (2, 1): (0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256),
    (2, 2): (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),
}
_RATES = {1: (44100, 48000, 32000), 2: (22050, 24000, 16000), 25: (11025, 12000, 8000)}


def _frame_header(data: bytes):
    if len(data) < 4 or data[0] != 0xFF or data[1] & 0xE0 != 0xE0:
        return None
    version = {3: 1, 2: 2, 0: 25}.get(data[1] >> 3 & 3)
    layer = {3: 1, 2: 2, 1: 3}.get(data[1] >> 1 & 3)
    bitrate_index, rate_index = data[2] >> 4, data[2] >> 2 & 3
    if version is None or layer is None or bitrate_index in (0, 15) or rate_index == 3:
        return None
    table = _BITRATES[(1, layer)] if version == 1 else _BITRATES[(2, 1 if layer == 1 else 2)]
    samples = 384 if layer == 1 else 1152 if version == 1 or layer == 2 else 576
    mono = data[3] >> 6 == 3
    return {"version": version, "layer": layer, "bitrate": table[bitrate_index] * 1000, "rate": _RATES[version][rate_index],
            "samples": samples, "mono": mono}


async def _mpeg_duration(source: _Source, start: int, tags: MediaTags) -> None:
    if tags.duration is not None:
        return
    data = await source.get(start, WINDOW)
    position = next((index for index in range(0, max(0, len(data) - 4)) if _frame_header(data[index:index + 4])), None)
    if position is None:
        return
    frame = _frame_header(data[position:position + 4])
    side = (32 if not frame["mono"] else 17) if frame["version"] == 1 else (17 if not frame["mono"] else 9)
    xing = data[position + 4 + side:position + 4 + side + 16]
    if xing[:4] in (b"Xing", b"Info"):
        flags = struct.unpack(">I", xing[4:8])[0]
        if flags & 1:
            frames = struct.unpack(">I", xing[8:12])[0]
            tags.duration = frames * frame["samples"] / frame["rate"]
            return
    vbri = data[position + 36:position + 36 + 18]
    if vbri[:4] == b"VBRI":
        frames = struct.unpack(">I", vbri[14:18])[0]
        tags.duration = frames * frame["samples"] / frame["rate"]
        return
    audio = source.size - (start + position)
    if frame["bitrate"] and audio > 0:
        tags.duration = audio * 8 / frame["bitrate"]


# ---------- FLAC／Vorbis Comment ----------

_VORBIS = {"title": "title", "artist": "artist", "album": "album", "albumartist": "album_artist", "album artist": "album_artist",
           "album_artist": "album_artist", "tracknumber": "track"}


def _vorbis_comment(data: bytes, tags: MediaTags) -> None:
    vendor = struct.unpack("<I", data[:4])[0]
    position = 4 + vendor
    count = struct.unpack("<I", data[position:position + 4])[0]
    position += 4
    for _ in range(min(count, 4096)):
        if position + 4 > len(data):
            break
        length = struct.unpack("<I", data[position:position + 4])[0]
        entry = data[position + 4:position + 4 + length]
        position += 4 + length
        name, separator, value = entry.partition(b"=")
        if not separator:
            continue
        key = name.decode("ascii", errors="replace").lower()
        if key == "metadata_block_picture":
            try:
                picture = base64.b64decode(value, validate=False)
                parsed = _flac_picture(picture)
                if parsed:
                    picture_type, mime, offset = parsed
                    tags.pictures.append(Picture(mime, data=picture[offset:], front=picture_type in (0, 3)))
            except (ValueError, struct.error):
                pass
            continue
        text = _unicode(value)
        if key in _VORBIS:
            tags.set(_VORBIS[key], text)
        elif key in ("date", "year", "originaldate"):
            tags.set("year", _year(text))
        elif key == "genre":
            tags.set("genre", _genre(text))
        elif key in ("lyrics", "unsyncedlyrics", "unsynced lyrics", "syncedlyrics"):
            item = _lyrics(text, "vorbis")
            if item:
                tags.lyrics.append(item)
        else:
            _extra(tags, key, text)


def _flac_picture(data: bytes):
    """返回（封面类型，MIME，图片数据在块内的偏移）。"""
    picture_type, mime_length = struct.unpack(">II", data[:8])
    mime = data[8:8 + mime_length].decode("latin-1", errors="replace").lower() or None
    position = 8 + mime_length
    description_length = struct.unpack(">I", data[position:position + 4])[0]
    position += 4 + description_length + 16
    data_length = struct.unpack(">I", data[position:position + 4])[0]
    position += 4
    if data_length <= 0:
        return None
    return picture_type, mime, position


async def _flac(source: _Source, start: int, tags: MediaTags) -> None:
    position = start + 4
    for _ in range(256):
        header = await source.get(position, 4)
        if len(header) < 4:
            return
        last, kind, length = header[0] & 0x80, header[0] & 0x7F, int.from_bytes(header[1:4], "big")
        body = position + 4
        if kind == 0 and length >= 18:
            info = await source.get(body, 18)
            packed = int.from_bytes(info[10:18], "big")
            rate, total = packed >> 44, packed & 0xFFFFFFFFF
            if rate and total:
                tags.duration = total / rate
        elif kind == 4 and length <= FIELD_LIMIT * 4:
            _vorbis_comment(await source.get(body, length), tags)
        elif kind == 6:
            parsed = _flac_picture(await source.get(body, min(length, 2048)))
            if parsed:
                picture_type, mime, offset = parsed
                tags.pictures.append(Picture(mime, body + offset, length - offset, front=picture_type in (0, 3)))
        position = body + length
        if last:
            return


# ---------- Ogg ----------

async def _ogg(source: _Source, tags: MediaTags) -> None:
    packets: list[bytes] = []
    current = b""
    position = 0
    while len(packets) < 2 and position < source.size:
        header = await source.get(position, 27)
        if header[:4] != b"OggS" or len(header) < 27:
            break
        segments = header[26]
        lacing = await source.get(position + 27, segments)
        offset = position + 27 + segments
        for value in lacing:
            current += await source.get(offset, value) if value else b""
            offset += value
            if len(current) > FIELD_LIMIT * 4:
                return
            if value < 255:
                packets.append(current)
                current = b""
                if len(packets) == 2:
                    break
        position = offset
    if not packets:
        return
    identification = packets[0]
    rate, skip = 0, 0
    if identification[:7] == b"\x01vorbis":
        tags.container = "ogg"
        rate = struct.unpack("<I", identification[12:16])[0]
    elif identification[:8] == b"OpusHead":
        tags.container = "opus"
        rate, skip = 48000, struct.unpack("<H", identification[10:12])[0]
    if len(packets) > 1:
        comment = packets[1]
        if comment[:7] == b"\x03vorbis":
            _vorbis_comment(comment[7:], tags)
        elif comment[:8] == b"OpusTags":
            _vorbis_comment(comment[8:], tags)
    if rate:
        tail_start = max(0, source.size - WINDOW)
        tail = await source.get(tail_start, source.size - tail_start)
        index = tail.rfind(b"OggS")
        if index >= 0 and index + 14 <= len(tail):
            granule = struct.unpack("<q", tail[index + 6:index + 14])[0]
            if granule > 0:
                tags.duration = max(0, granule - skip) / rate


# ---------- MP4 ----------

async def _boxes(source: _Source, start: int, end: int):
    position = start
    while position + 8 <= end:
        header = await source.get(position, 16)
        if len(header) < 8:
            return
        size, kind = struct.unpack(">I", header[:4])[0], header[4:8]
        offset = 8
        if size == 1:
            size, offset = struct.unpack(">Q", header[8:16])[0], 16
        elif size == 0:
            size = end - position
        if size < offset:
            return
        yield kind, position + offset, min(end, position + size)
        position += size


def _mp4_language(packed: int) -> str | None:
    if not packed or packed == 0x7FFF:
        return None
    letters = "".join(chr(((packed >> shift) & 0x1F) + 0x60) for shift in (10, 5, 0))
    return None if letters in ("und", "```") or not letters.isalpha() else letters


_MP4_TEXT = {b"\xa9nam": "title", b"\xa9ART": "artist", b"\xa9alb": "album", b"aART": "album_artist"}
_MP4_SUBTITLE_CODECS = {b"tx3g": True, b"text": True, b"wvtt": True, b"c608": False, b"c708": False, b"stpp": False}


async def _mp4(source: _Source, tags: MediaTags) -> None:
    async for kind, start, end in _boxes(source, 0, source.size):
        if kind != b"moov":
            continue
        subtitle_index = 0
        async for child, child_start, child_end in _boxes(source, start, end):
            if child == b"mvhd":
                body = await source.get(child_start, 32)
                if body[0] == 1:
                    scale, duration = struct.unpack(">IQ", body[20:32])
                else:
                    scale, duration = struct.unpack(">II", body[12:20])
                if scale:
                    tags.duration = duration / scale
            elif child == b"trak":
                stream = await _mp4_track(source, child_start, child_end, subtitle_index)
                if stream is not None:
                    tags.subtitles.append(stream)
                    subtitle_index += 1
            elif child == b"udta":
                async for item, item_start, item_end in _boxes(source, child_start, child_end):
                    if item == b"meta":
                        await _mp4_meta(source, item_start, item_end, tags)
                    elif item in _MP4_TEXT or item in (b"\xa9day", b"\xa9gen"):
                        # QuickTime 把文本直接放在 udta：两字节长度、两字节语言，然后才是正文。
                        if 4 <= item_end - item_start <= FIELD_LIMIT:
                            raw = await source.get(item_start, item_end - item_start)
                            length = int.from_bytes(raw[:2], "big")
                            value = _unicode(raw[4:4 + length])
                            if item in _MP4_TEXT:
                                tags.set(_MP4_TEXT[item], value)
                            elif item == b"\xa9day":
                                tags.set("year", _year(value))
                            else:
                                tags.set("genre", value)
            elif child == b"meta":
                await _mp4_meta(source, child_start, child_end, tags)
        return


async def _mp4_meta(source: _Source, start: int, end: int, tags: MediaTags) -> None:
    probe = await source.get(start, 8)
    # ISO 的 meta 是带版本号的完整盒子；QuickTime 的没有。
    offset = 0 if probe[4:8] == b"hdlr" else 4
    names, tables = {}, []
    async for leaf, leaf_start, leaf_end in _boxes(source, start + offset, end):
        if leaf == b"keys" and leaf_end - leaf_start <= FIELD_LIMIT:
            data = await source.get(leaf_start, leaf_end - leaf_start)
            if len(data) < 8:
                continue
            count, position = int.from_bytes(data[4:8], "big"), 8
            for index in range(1, min(count, 1024) + 1):
                if position + 8 > len(data):
                    break
                size = int.from_bytes(data[position:position + 4], "big")
                if size < 8 or position + size > len(data):
                    break
                names[index] = data[position + 8:position + size].decode("utf-8", errors="replace")
                position += size
        elif leaf == b"ilst":
            tables.append((leaf_start, leaf_end))
    for table_start, table_end in tables:
        await _mp4_ilst(source, table_start, table_end, tags, names)


async def _mp4_track(source: _Source, start: int, end: int, ordinal: int) -> SubtitleStream | None:
    handler, language, codec, enabled = None, None, None, True
    async for kind, box_start, box_end in _boxes(source, start, end):
        if kind == b"tkhd":
            head = await source.get(box_start, 4)
            enabled = bool(head[3] & 1)
        elif kind == b"mdia":
            async for child, child_start, child_end in _boxes(source, box_start, box_end):
                if child == b"mdhd":
                    body = await source.get(child_start, 36)
                    at = 32 if body[0] == 1 else 20
                    language = _mp4_language(struct.unpack(">H", body[at:at + 2])[0])
                elif child == b"hdlr":
                    handler = (await source.get(child_start, 12))[8:12]
                elif child == b"minf":
                    async for leaf, leaf_start, leaf_end in _boxes(source, child_start, child_end):
                        if leaf == b"stbl":
                            async for table, table_start, _ in _boxes(source, leaf_start, leaf_end):
                                if table == b"stsd":
                                    codec = (await source.get(table_start + 8, 8))[4:8]
                                    break
    if handler not in (b"sbtl", b"text", b"subt", b"clcp") and codec not in _MP4_SUBTITLE_CODECS:
        return None
    name = (codec or b"").decode("latin-1", errors="replace").strip() or "subtitle"
    return SubtitleStream(ordinal, name, language, None, enabled, _MP4_SUBTITLE_CODECS.get(codec, False))


async def _mp4_ilst(source: _Source, start: int, end: int, tags: MediaTags, names=None) -> None:
    async for kind, item_start, item_end in _boxes(source, start, end):
        mean = name = None
        async for child, child_start, child_end in _boxes(source, item_start, item_end):
            if child == b"mean":
                mean = (await source.get(child_start + 4, min(256, child_end - child_start - 4))).decode("utf-8", errors="replace")
                continue
            if child == b"name":
                name = (await source.get(child_start + 4, min(256, child_end - child_start - 4))).decode("utf-8", errors="replace")
                continue
            if child != b"data":
                continue
            data_type = struct.unpack(">I", await source.get(child_start, 4))[0] & 0xFFFFFF
            value_start, length = child_start + 8, child_end - child_start - 8
            if kind == b"covr":
                tags.pictures.append(Picture({13: "image/jpeg", 14: "image/png", 27: "image/bmp"}.get(data_type), value_start, length))
                continue
            if length <= 0 or length > FIELD_LIMIT:
                continue
            value = await source.get(value_start, length)
            key = (names or {}).get(int.from_bytes(kind, "big"))
            if key:
                text = value.decode("utf-8", errors="replace")
                key = key.removeprefix("com.apple.quicktime.").lower()
                if key in ("title", "artist", "album", "album_artist", "track", "genre"):
                    tags.set(key, text)
                elif key in ("year", "date", "creationdate"):
                    tags.set("year", _year(text))
                else:
                    _extra(tags, key, text)
            elif kind in _MP4_TEXT:
                tags.set(_MP4_TEXT[kind], value.decode("utf-8", errors="replace"))
            elif kind == b"\xa9day":
                tags.set("year", _year(value.decode("utf-8", errors="replace")))
            elif kind == b"\xa9gen":
                tags.set("genre", value.decode("utf-8", errors="replace"))
            elif kind == b"gnre" and len(value) >= 2:
                index = struct.unpack(">H", value[:2])[0] - 1
                if 0 <= index < len(_GENRES):
                    tags.set("genre", _GENRES[index])
            elif kind == b"trkn" and len(value) >= 4:
                number = struct.unpack(">H", value[2:4])[0]
                if number:
                    total = struct.unpack(">H", value[4:6])[0] if len(value) >= 6 else 0
                    tags.set("track", f"{number}/{total}" if total else str(number))
            elif kind == b"\xa9lyr":
                item = _lyrics(value.decode("utf-8", errors="replace"), "mp4")
                if item:
                    tags.lyrics.append(item)
            elif kind in (b"\xa9wrt", b"desc", b"ldes", b"\xa9cmt"):
                _extra(tags, "composer" if kind == b"\xa9wrt" else "description", value.decode("utf-8", errors="replace"))
            elif kind == b"----" and mean and name and "itunes" in mean.lower():
                _extra(tags, name, value.decode("utf-8", errors="replace"))
            break


# ---------- Matroska ----------

def _vint(data: bytes, position: int, *, keep_marker: bool) -> tuple[int, int]:
    first = data[position]
    length = 1
    mask = 0x80
    while length <= 8 and not first & mask:
        mask >>= 1
        length += 1
    if length > 8:
        raise ValueError("bad vint")
    value = first if keep_marker else first & (mask - 1)
    for byte in data[position + 1:position + length]:
        value = value << 8 | byte
    if len(data) < position + length:
        raise ValueError("short vint")
    unknown = not keep_marker and value == (1 << (7 * length)) - 1
    return (-1 if unknown else value), position + length


async def _elements(source: _Source, start: int, end: int):
    position = start
    while position < end:
        header = await source.get(position, 12)
        if len(header) < 2:
            return
        element, offset = _vint(header, 0, keep_marker=True)
        size, offset = _vint(header, offset, keep_marker=False)
        data_start = position + offset
        data_end = end if size < 0 else min(end, data_start + size)
        yield element, data_start, data_end, size < 0
        if size < 0:
            return
        position = data_end


def _uint(data: bytes) -> int:
    return int.from_bytes(data, "big") if data else 0


_SEGMENT, _SEEKHEAD, _INFO, _TRACKS, _TAGS, _ATTACHMENTS, _CLUSTER = 0x18538067, 0x114D9B74, 0x1549A966, 0x1654AE6B, 0x1254C367, 0x1941A469, 0x1F43B675
_TEXT_SUBTITLES = ("S_TEXT/", "S_ASS", "S_SSA")


async def _matroska(source: _Source, tags: MediaTags) -> None:
    async for element, start, end, _ in _elements(source, 0, source.size):
        if element != _SEGMENT:
            continue
        seen: set[int] = set()
        targets: dict[int, int] = {}
        async for child, child_start, child_end, unknown in _elements(source, start, end):
            if child == _CLUSTER or unknown:
                break
            await _matroska_child(source, child, child_start, child_end, start, tags, seen, targets)
        # 标签、附件常写在簇之后，只能按 SeekHead 给出的位置跳过去读取。
        for target, offset in sorted(targets.items(), key=lambda item: item[1]):
            if target in seen or target not in (_INFO, _TRACKS, _TAGS, _ATTACHMENTS):
                continue
            async for child, child_start, child_end, _ in _elements(source, start + offset, min(end, start + offset + 12 + READ_BUDGET)):
                if child == target:
                    await _matroska_child(source, child, child_start, child_end, start, tags, seen, targets)
                break
        return


async def _matroska_child(source, child, start, end, segment, tags, seen, targets):
    seen.add(child)
    if child == _SEEKHEAD and end - start <= FIELD_LIMIT:
        async for seek, seek_start, seek_end, _ in _elements(source, start, end):
            if seek != 0x4DBB:
                continue
            target = position = None
            async for leaf, leaf_start, leaf_end, _ in _elements(source, seek_start, seek_end):
                value = await source.get(leaf_start, leaf_end - leaf_start)
                if leaf == 0x53AB:
                    target = _uint(value)
                elif leaf == 0x53AC:
                    position = _uint(value)
            if target is not None and position is not None:
                targets.setdefault(target, position)
    elif child == _INFO and end - start <= FIELD_LIMIT:
        scale, duration = 1_000_000, None
        async for leaf, leaf_start, leaf_end, _ in _elements(source, start, end):
            value = await source.get(leaf_start, leaf_end - leaf_start)
            if leaf == 0x2AD7B1:
                scale = _uint(value) or scale
            elif leaf == 0x4489:
                duration = struct.unpack(">f" if len(value) == 4 else ">d", value)[0]
            elif leaf == 0x7BA9:
                tags.set("title", value.decode("utf-8", errors="replace"))
        if duration:
            tags.duration = duration * scale / 1e9
    elif child == _TRACKS and end - start <= FIELD_LIMIT * 4:
        ordinal = 0
        async for entry, entry_start, entry_end, _ in _elements(source, start, end):
            if entry != 0xAE:
                continue
            track: dict[str, object] = {"default": True}
            async for leaf, leaf_start, leaf_end, _ in _elements(source, entry_start, entry_end):
                if leaf not in (0x83, 0x86, 0x22B59C, 0x22B59D, 0x536E, 0x88):
                    continue
                value = await source.get(leaf_start, leaf_end - leaf_start)
                if leaf == 0x83:
                    track["type"] = _uint(value)
                elif leaf == 0x86:
                    track["codec"] = value.decode("ascii", errors="replace").rstrip("\x00")
                elif leaf == 0x22B59C:
                    track.setdefault("language", value.decode("ascii", errors="replace").rstrip("\x00"))
                elif leaf == 0x22B59D:
                    track["language"] = value.decode("ascii", errors="replace").rstrip("\x00")
                elif leaf == 0x536E:
                    track["name"] = value.decode("utf-8", errors="replace")
                elif leaf == 0x88:
                    track["default"] = bool(_uint(value))
            if track.get("type") == 0x11:
                codec = str(track.get("codec") or "")
                language = str(track.get("language") or "") or None
                tags.subtitles.append(SubtitleStream(ordinal, codec, None if language == "und" else language,
                                                     _clean(str(track.get("name") or "")) , bool(track["default"]),
                                                     codec.startswith(_TEXT_SUBTITLES)))
                ordinal += 1
    elif child == _TAGS and end - start <= FIELD_LIMIT:
        async for tag, tag_start, tag_end, _ in _elements(source, start, end):
            if tag != 0x7373:
                continue
            async for simple, simple_start, simple_end, _ in _elements(source, tag_start, tag_end):
                if simple != 0x67C8:
                    continue
                name = value = None
                async for leaf, leaf_start, leaf_end, _ in _elements(source, simple_start, simple_end):
                    if leaf == 0x45A3:
                        name = (await source.get(leaf_start, leaf_end - leaf_start)).decode("utf-8", errors="replace").upper()
                    elif leaf == 0x4487:
                        value = (await source.get(leaf_start, min(leaf_end - leaf_start, FIELD_LIMIT))).decode("utf-8", errors="replace")
                if name == "TITLE":
                    tags.set("title", value)
                elif name == "ARTIST":
                    tags.set("artist", value)
                elif name in ("DATE", "YEAR", "DATE_RELEASED", "DATE_RECORDED"):
                    tags.set("year", _year(value))
                elif name == "GENRE":
                    tags.set("genre", value)
                elif name:
                    _extra(tags, name, value)
    elif child == _ATTACHMENTS:
        async for attached, attached_start, attached_end, _ in _elements(source, start, end):
            if attached != 0x61A7:
                continue
            name = mime = None
            data_range = None
            async for leaf, leaf_start, leaf_end, _ in _elements(source, attached_start, attached_end):
                if leaf == 0x466E:
                    name = (await source.get(leaf_start, min(leaf_end - leaf_start, 512))).decode("utf-8", errors="replace").lower()
                elif leaf == 0x4660:
                    mime = (await source.get(leaf_start, min(leaf_end - leaf_start, 128))).decode("ascii", errors="replace").lower()
                elif leaf == 0x465C:
                    data_range = (leaf_start, leaf_end - leaf_start)
            if data_range and mime and mime.startswith("image/"):
                tags.pictures.append(Picture(mime, *data_range, front=bool(name and name.startswith("cover"))))


# ---------- WAV ----------

_WAV_INFO = {b"INAM": "title", b"IART": "artist", b"IPRD": "album", b"IGNR": "genre", b"ITRK": "track"}


async def _wav(source: _Source, tags: MediaTags) -> None:
    position, byte_rate = 12, 0
    for _ in range(64):
        header = await source.get(position, 8)
        if len(header) < 8:
            return
        kind, length = header[:4], struct.unpack("<I", header[4:8])[0]
        body = position + 8
        if kind == b"fmt ":
            byte_rate = struct.unpack("<I", (await source.get(body, 16))[8:12])[0]
        elif kind == b"data" and byte_rate:
            tags.duration = length / byte_rate
        elif kind == b"LIST" and length <= FIELD_LIMIT:
            data = await source.get(body, length)
            if data[:4] == b"INFO":
                offset = 4
                while offset + 8 <= len(data):
                    item, size = data[offset:offset + 4], struct.unpack("<I", data[offset + 4:offset + 8])[0]
                    value = _legacy(data[offset + 8:offset + 8 + size].split(b"\x00", 1)[0])
                    if item in _WAV_INFO:
                        tags.set(_WAV_INFO[item], value)
                    elif item == b"ICRD":
                        tags.set("year", _year(value))
                    elif item in (b"ICMT", b"IWRI"):
                        _extra(tags, "description" if item == b"ICMT" else "composer", value)
                    offset += 8 + size + (size & 1)
        elif kind in (b"id3 ", b"ID3 "):
            head = await source.get(body, 3)
            if head == b"ID3":
                await _id3(source, body, tags)
        position = body + length + (length & 1)
