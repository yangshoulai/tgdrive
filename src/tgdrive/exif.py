"""照片拍摄时间：从文件开头读 EXIF 的 DateTimeOriginal（相册按拍摄时间排列）。

只解析 JPEG（APP1 Exif）与 TIFF 结构的文件（TIFF 与多数相机 RAW），写入第 1 段时顺带读取开头的数据，不额外回源。
没有时区信息（OffsetTimeOriginal）时按拍摄地的「墙上时间」记录为 UTC 时间戳：界面按 UTC 显示这类时间，
只用于排序与按月分组，几个小时的时区差不影响结果。读不到、格式不对或日期不合理时返回 None。
"""

from __future__ import annotations

import re
import struct
from datetime import datetime, timedelta, timezone

HEAD_BYTES = 64 * 1024  # 手机照片的 EXIF（含缩略图）通常在开头 64 KiB 内
_DATE = re.compile(rb"^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})")
_OFFSET = re.compile(rb"^([+-])(\d{2}):(\d{2})")
DATETIME_ORIGINAL, DATETIME_DIGITIZED, DATETIME, EXIF_IFD, OFFSET_ORIGINAL = 0x9003, 0x9004, 0x0132, 0x8769, 0x9011


def taken_at(head: bytes) -> float | None:
    """返回拍摄时间（UNIX 时间戳）；不是带 EXIF 的照片时返回 None。"""
    try:
        tiff = _tiff_block(head)
        return _parse_tiff(tiff) if tiff else None
    except (struct.error, ValueError, IndexError, OverflowError):
        return None


def _tiff_block(head: bytes) -> bytes | None:
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return head
    if head[:2] != b"\xff\xd8":
        return None
    position = 2
    while position + 4 <= len(head):
        if head[position] != 0xFF:
            return None
        marker = head[position + 1]
        if marker in (0xD9, 0xDA):  # 图像结束或开始压缩数据：之后不会再有 EXIF
            return None
        length = struct.unpack(">H", head[position + 2:position + 4])[0]
        if marker == 0xE1 and head[position + 4:position + 10] == b"Exif\x00\x00":
            return head[position + 10:position + 2 + length]
        position += 2 + length
    return None


def _parse_tiff(data: bytes) -> float | None:
    order = "<" if data[:2] == b"II" else ">" if data[:2] == b"MM" else None
    if order is None:
        return None
    first = struct.unpack(order + "I", data[4:8])[0]
    tags = _ifd(data, order, first)
    if EXIF_IFD in tags:
        tags = {**tags, **_ifd(data, order, tags[EXIF_IFD])}
    for tag in (DATETIME_ORIGINAL, DATETIME_DIGITIZED, DATETIME):
        value = tags.get(tag)
        if isinstance(value, bytes) and (stamp := _stamp(value, tags.get(OFFSET_ORIGINAL))):
            return stamp
    return None


def _ifd(data: bytes, order: str, offset: int) -> dict[int, object]:
    """读一个目录里需要的几项：ASCII 值返回字节串，LONG 值（子目录位置）返回整数。"""
    if not 8 <= offset <= len(data) - 2:
        return {}
    count = struct.unpack(order + "H", data[offset:offset + 2])[0]
    result: dict[int, object] = {}
    for index in range(min(count, 512)):
        entry = offset + 2 + index * 12
        if entry + 12 > len(data):
            break
        tag, kind, number = struct.unpack(order + "HHI", data[entry:entry + 8])
        if tag == EXIF_IFD and kind == 4:
            result[tag] = struct.unpack(order + "I", data[entry + 8:entry + 12])[0]
        elif tag in (DATETIME_ORIGINAL, DATETIME_DIGITIZED, DATETIME, OFFSET_ORIGINAL) and kind == 2:
            if number <= 4:
                result[tag] = data[entry + 8:entry + 8 + number]
            else:
                start = struct.unpack(order + "I", data[entry + 8:entry + 12])[0]
                result[tag] = data[start:start + number]
    return result


def _stamp(value: bytes, offset: object) -> float | None:
    match = _DATE.match(value)
    if not match:
        return None
    year, month, day, hour, minute, second = (int(part) for part in match.groups())
    if not 1900 < year < 2200:
        return None
    moment = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
    if isinstance(offset, bytes) and (zone := _OFFSET.match(offset)):
        sign = 1 if zone[1] == b"+" else -1
        moment -= sign * timedelta(hours=int(zone[2]), minutes=int(zone[3]))
    return moment.timestamp()
