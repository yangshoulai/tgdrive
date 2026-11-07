"""按文件内容判断类型：写入时看文件开头几 KB 的格式特征，不信任文件名或上传方给出的类型。

结果分几种把握程度，存进 blobs.sniffed（形如 ``exact:image/jpeg``），提交对象时由 :func:`resolve` 与上传方给出的类型合并：

- ``exact``：格式特征明确（JPEG、PNG、MP4、PDF、ZIP 等），直接采用；
- ``text``：内容是文本，具体是哪种文本（Markdown、代码、JSON、字幕）看不出来，上传方给出的是文本类型就保留，否则按文件名推断
  文本类型，再不行用 text/plain；
- ``zip``／``ole``：Office 文档等也是这类容器，上传方给出的类型属于同一种容器时保留，否则用容器本身的类型；
- ``unknown``：没有认出的二进制。上传方声称的类型如果是能认出特征的格式（说是 JPEG，内容却不是），按通用二进制处理，否则保留；
- ``empty``：空文件，保留上传方给出的类型。

同一种容器里音频与视频（MP4／M4A、Ogg、Matroska）只按容器标识区分，不解析轨道；文件名上明确的音频扩展名仍由
filekinds 的规则在列表与播放时处理。
"""

from __future__ import annotations

import mimetypes

HEAD_BYTES = 8192

_FTYP_AUDIO = {b"M4A ", b"M4B ", b"M4P ", b"F4A ", b"F4B "}
_FTYP_IMAGE = {b"avif": "image/avif", b"avis": "image/avif", b"heic": "image/heic", b"heix": "image/heic",
               b"heim": "image/heic", b"heis": "image/heic", b"hevc": "image/heic", b"mif1": "image/heif", b"msf1": "image/heif",
               b"miaf": "image/heif"}
_FTYP_OTHER = {b"qt  ": "video/quicktime", b"3gp4": "video/3gpp", b"3gp5": "video/3gpp", b"3gp6": "video/3gpp",
               b"3g2a": "video/3gpp2", b"crx ": "image/x-canon-cr3"}
_OOXML = {b"word/": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          b"xl/": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          b"ppt/": "application/vnd.openxmlformats-officedocument.presentationml.presentation"}
_OPEN_DOCUMENT = (b"application/vnd.oasis.opendocument.text", b"application/vnd.oasis.opendocument.spreadsheet",
                  b"application/vnd.oasis.opendocument.presentation")
# 这些类型都有明确的格式特征：上传方这样声称、内容却认不出时，说明类型不可信。
_SIGNED = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/avif", "image/heic", "image/heif", "image/tiff",
           "video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/x-msvideo", "video/mp2t", "video/ogg",
           "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/flac", "audio/x-flac", "audio/ogg", "audio/opus", "audio/wav",
           "audio/x-wav", "application/pdf", "application/zip", "application/gzip", "application/x-gzip", "application/x-bzip2",
           "application/x-xz", "application/x-7z-compressed", "application/vnd.rar", "application/x-rar-compressed", "application/x-tar"}
_AV_CONTAINERS = {"video/mp4", "video/ogg", "video/webm", "video/x-matroska", "video/x-ms-asf", "video/3gpp"}
_TEXTUAL = ("application/json", "application/xml", "application/javascript", "application/x-javascript", "application/x-sh",
            "application/x-yaml", "application/yaml", "application/toml", "application/sql", "application/x-subrip", "application/ld+json",
            "image/svg+xml")


def _ftyp(head: bytes) -> str | None:
    if len(head) < 12 or head[4:8] != b"ftyp":
        return None
    brands = [head[8:12]] + [head[index:index + 4] for index in range(16, min(len(head), 8 + int.from_bytes(head[:4], "big")), 4)]
    for brand in brands:
        if brand in _FTYP_IMAGE:
            return _FTYP_IMAGE[brand]
    major = head[8:12]
    if major in _FTYP_AUDIO:
        return "audio/mp4"
    if major in _FTYP_OTHER:
        return _FTYP_OTHER[major]
    # 品牌不认识时看开头里的处理器类型（hdlr 盒子：类型后跳过版本／标志与预留各 4 字节）：HEIF 系列图片的 meta 里是 pict，
    # 不能因为品牌陌生就当成视频（列表会显示为视频却无法播放）。没有线索时仍按 MP4 视频。
    handler = head.find(b"hdlr")
    if handler > 0 and len(head) >= handler + 16:
        kind = head[handler + 12:handler + 16]
        if kind == b"pict":
            return "image/heif"
        if kind == b"soun" and b"vide" not in head:
            return "audio/mp4"
    return "video/mp4"


def _matroska(head: bytes) -> str:
    return "video/webm" if b"webm" in head[:64] else "video/x-matroska"


def _ogg(head: bytes) -> str:
    if b"\x80theora" in head:
        return "video/ogg"
    return "audio/ogg"


def _mp3(head: bytes) -> bool:
    if head[:3] == b"ID3":
        return True
    # 无标签的 MPEG 音频帧头：同步位、合法的层、码率与采样率，避免把以 0xFF 开头的任意数据认成 MP3。
    return (len(head) >= 4 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0 and head[1] & 0x06 != 0
            and head[2] >> 4 not in (0, 15) and (head[2] >> 2) & 3 != 3)


def _text(head: bytes) -> bool:
    if b"\x00" in head:
        # UTF-16 文本带 BOM 时也算文本。
        return head[:2] in (b"\xff\xfe", b"\xfe\xff")
    sample = head
    try:
        sample.decode("utf-8")
        return True
    except UnicodeDecodeError as exc:
        # 截在多字节字符中间不算错；之前的部分能正常解码就是 UTF-8 文本。
        if exc.start >= len(sample) - 4 and exc.reason in ("unexpected end of data", "invalid continuation byte"):
            return True
    try:
        sample.decode("gb18030")
    except UnicodeDecodeError:
        return False
    control = sum(1 for byte in sample if byte < 9 or 13 < byte < 32)
    return control <= len(sample) // 100


def sniff(head: bytes) -> str:
    """看文件开头（至多 HEAD_BYTES）判断类型，返回 ``把握程度:类型``。"""
    head = head[:HEAD_BYTES]
    if not head:
        return "empty:"
    if head[:3] == b"\xff\xd8\xff":
        return "exact:image/jpeg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "exact:image/png"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "exact:image/gif"
    if head[:4] == b"RIFF" and len(head) >= 12:
        kind = head[8:12]
        if kind == b"WEBP":
            return "exact:image/webp"
        if kind == b"WAVE":
            return "exact:audio/wav"
        if kind == b"AVI ":
            return "exact:video/x-msvideo"
    if head[:2] == b"BM" and len(head) >= 14 and int.from_bytes(head[2:6], "little") >= 26:
        return "exact:image/bmp"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "exact:image/tiff"
    if head[:4] == b"\x00\x00\x01\x00" and len(head) >= 6 and 0 < int.from_bytes(head[4:6], "little") < 256:
        return "exact:image/x-icon"
    if ftyp := _ftyp(head):
        return f"exact:{ftyp}"
    if head[:4] == b"\x1aE\xdf\xa3":
        return f"exact:{_matroska(head)}"
    if head[:4] == b"OggS":
        return f"exact:{_ogg(head)}"
    if head[:4] == b"fLaC":
        return "exact:audio/flac"
    if head[:4] == b"FORM" and head[8:12] in (b"AIFF", b"AIFC"):
        return "exact:audio/aiff"
    if head[:4] == b"MThd":
        return "exact:audio/midi"
    if head[:5] == b"#!AMR":
        return "exact:audio/amr"
    if head[:4] == b"MAC ":
        return "exact:audio/x-ape"
    if head[:4] == b"DSD ":
        return "exact:audio/x-dsf"
    if head[:16] == b"\x30\x26\xb2\x75\x8e\x66\xcf\x11\xa6\xd9\x00\xaa\x00\x62\xce\x6c":
        return "exact:video/x-ms-asf"
    if head[:3] == b"FLV":
        return "exact:video/x-flv"
    if head[:4] == b".RMF":
        return "exact:application/vnd.rn-realmedia"
    if head[:4] == b"8BPS":
        return "exact:image/vnd.adobe.photoshop"
    if head[:2] == b"\xff\x0a" or head[:12] == b"\x00\x00\x00\x0cJXL \r\n\x87\n":
        return "exact:image/jxl"
    # 字体：TrueType（版本 1.0 或 Apple 的 true）、OpenType CFF、WOFF／WOFF2 与字体集合。表数量要合理，避免把以 0x00010000 开头的任意数据认成字体。
    if len(head) >= 12 and (head[:4] in (b"\x00\x01\x00\x00", b"true") and 0 < int.from_bytes(head[4:6], "big") < 64):
        return "exact:font/ttf"
    if head[:4] == b"OTTO" and len(head) >= 12 and 0 < int.from_bytes(head[4:6], "big") < 64:
        return "exact:font/otf"
    if head[:4] == b"wOFF" and len(head) >= 44:
        return "exact:font/woff"
    if head[:4] == b"wOF2" and len(head) >= 48:
        return "exact:font/woff2"
    if head[:4] == b"ttcf" and len(head) >= 12:
        return "exact:font/collection"
    if head[:5] == b"%PDF-":
        return "exact:application/pdf"
    if head[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
        if head[30:38] == b"mimetype":
            for value in _OPEN_DOCUMENT + (b"application/epub+zip",):
                if head[38:38 + len(value)] == value:
                    return f"exact:{value.decode()}"
        if b"[Content_Types].xml" in head:
            for marker, value in _OOXML.items():
                if marker in head:
                    return f"exact:{value}"
        return "zip:application/zip"
    if head[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        return "ole:application/x-ole-storage"
    if head[:2] == b"\x1f\x8b":
        return "exact:application/gzip"
    if head[:3] == b"BZh":
        return "exact:application/x-bzip2"
    if head[:6] == b"\xfd7zXZ\x00":
        return "exact:application/x-xz"
    if head[:6] == b"7z\xbc\xaf\x27\x1c":
        return "exact:application/x-7z-compressed"
    if head[:6] == b"Rar!\x1a\x07":
        return "exact:application/vnd.rar"
    if len(head) > 262 and head[257:262] == b"ustar":
        return "exact:application/x-tar"
    if head[0] == 0x47 and (len(head) < 189 or head[188] == 0x47) and (len(head) < 377 or head[376] == 0x47) and len(head) >= 189:
        return "exact:video/mp2t"
    if head[:2] in (b"\xff\xf1", b"\xff\xf9"):
        return "exact:audio/aac"
    if _mp3(head):
        return "exact:audio/mpeg"
    if head[:4] == b"\x00asm":
        return "exact:application/wasm"
    if head[:4] == b"SQLi" and head[:16] == b"SQLite format 3\x00":
        return "exact:application/vnd.sqlite3"
    if _text(head):
        lowered = head.lstrip(b"\xef\xbb\xbf \t\r\n")[:512].lower()
        if lowered.startswith(b"<svg") or lowered.startswith(b"<?xml") and b"<svg" in head.lower():
            return "exact:image/svg+xml"
        return "text:text/plain"
    return "unknown:"


def _container(value: str | None) -> str:
    return (value or "").split(";", 1)[0].strip().lower()


def resolve(sniffed: str | None, provided: str | None, key: str = "") -> str | None:
    """提交对象时的类型：sniffed 为写入时记录的 :func:`sniff` 结果，没有记录（旧数据、未经 put_part 写入）时保留上传方的类型。"""
    if not sniffed:
        return provided
    certainty, _, detected = sniffed.partition(":")
    given = _container(provided)
    name = key.rsplit("/", 1)[-1]
    if certainty == "exact":
        # 同一种容器里音频与视频看不出区别：上传方说是音频就保留（M4A、WMA、Ogg 音频等）。
        if detected in _AV_CONTAINERS and given.startswith("audio/"):
            return provided
        # 相机 RAW（CR2、NEF、DNG）都是 TIFF 结构：保留更具体的图片类型。
        if detected == "image/tiff" and given.startswith("image/"):
            return provided
        return detected
    if certainty == "text":
        if given.startswith("text/") or given in _TEXTUAL:
            return provided
        guessed = mimetypes.guess_type(name)[0] or ""
        if guessed.startswith("text/") or guessed in _TEXTUAL:
            return guessed
        return "text/plain"
    if certainty == "zip":
        guessed = mimetypes.guess_type(name)[0] or ""
        for candidate in (given, guessed):
            if candidate.endswith("+zip") or candidate.startswith(("application/vnd.openxmlformats", "application/vnd.oasis", "application/java-archive",
                                                                  "application/vnd.android", "application/epub")):
                return candidate
        return detected
    if certainty == "ole":
        guessed = mimetypes.guess_type(name)[0] or ""
        for candidate in (given, guessed):
            if candidate.startswith(("application/msword", "application/vnd.ms-", "application/vnd.visio")):
                return candidate
        return "application/octet-stream"
    if certainty == "unknown":
        # 内容认不出、来源却说是音视频，而文件名是图片：多半是网站给错了 Content-Type（离线下载常见），按图片保存，
        # 不让列表显示成无法播放的视频。
        guessed = mimetypes.guess_type(name)[0] or ""
        if given.startswith(("video/", "audio/")) and guessed.startswith("image/"):
            return guessed
        if given in _SIGNED:
            # 声称是有明确格式的媒体或压缩包，内容却认不出：不能让浏览器按它去解码。
            return "application/octet-stream"
        return provided
    return provided
