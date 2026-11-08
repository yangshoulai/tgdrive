"""缩略图协作队列：自动任务复用已接收密文；用户可为任意文件上传自定义缩略图。"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import secrets
import hashlib
import shutil
import tempfile
import time
from collections import OrderedDict
from contextlib import aclosing
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

from .errors import NotFoundError, NotReadyError, QuotaExceededError
from .filekinds import kind_clause, kind_of
from .objects import PRIVATE_PREFIX, ObjectInfo, Scope
from .media import tags as media_tags
from .thumbnail_cache import ThumbnailCache, ThumbnailCacheMiss
from .work import WorkBusyError


log = logging.getLogger("tgdrive.thumbnails")
MIB = 1024 * 1024
# 回收卡死的解码器（损坏文件、存储长时间无响应）；资源评估也按它判断读完整张图片是否来得及。用户请求和后台任务一致。
TIMEOUT = 600
CLIENT_TIMEOUT = 90
# 网页预览图片／视频时浏览器手里已有解码好的画面，先等它生成；超时后后台再用同一批已接收的密文接管。
PREVIEW_GRACE = 30
# 缓存不足时只在收到新数据后重试，并逐次拉长间隔；多次仍不足就放弃，避免边播放边反复启动解码器。
MISS_LIMIT = 6
# 自动补图：上传或修改超过 BACKFILL_AGE 秒仍没有缩略图的图片、视频、音频（缓存已过期、复制或秒传、服务器重启等），
# 由后台在队列空闲时从存储读取生成，单并发、只产生存储到服务器的入站流量，不设额度。
BACKFILL_AGE = 600
BACKFILL_RETRY = 6 * 3600
# 与 web/src/video-frame.ts 保持一致；只分析 32×32 灰度样本，不在 Python 中解码完整图片。
VIDEO_SAMPLE_SIZE = 32
VIDEO_FRAME_TIMES = (0, 1, 3, 10, 30, 60, 120)
# 不允许播放列表、concat、SVG 等会加载其他资源的格式。HTTP 请求还统一经过下面的本地代理。
FORMATS = ("mov,matroska,webm,avi,ogg,mp3,flac,wav,aac,aiff,asf,flv,mpeg,mpegts,ape,wv,"
           "jpeg_pipe,png_pipe,webp_pipe,gif,bmp_pipe,tiff_pipe,ico,jxl_pipe,avif,heif")
# 解码器输出里出现这些内容说明是运行环境（线程、内存、动态库）的问题，而不是文件本身无法解码。
ENVIRONMENT_ERRORS = (b"pthread_create", b"Cannot allocate memory", b"Resource temporarily unavailable",
                      b"error while loading shared libraries", b"failed to map segment")
# 仅匹配已知错误并输出固定说明，原始 stderr 可能包含媒体信息或本地路径，不能写入日志或队列。
DECODER_ERRORS = (
    ("pixel_limit", (b"exceeds specified max pixel count",), "媒体画面像素数超过解码上限"),
    ("unsupported_codec", (b"unknown decoder", b"decoder not found", b"no decoder found", b"unsupported codec"),
     "当前解码器不支持此媒体编码"),
    ("missing_stream", (b"matches no streams", b"does not contain any stream"), "媒体没有可用的画面或封面"),
    ("invalid_data", (b"invalid data found when processing input", b"moov atom not found", b"could not find codec parameters"),
     "未能解析媒体数据或索引"),
    ("filter_error", (b"error reinitializing filters", b"error initializing complex filters", b"error while filtering",
                      b"failed to configure output pad"), "解码器未能完成画面转换"),
)
# 一次性清理：运行环境问题、旧版视频仅提取内嵌封面的策略会留下「无法生成」，升级后交给补图重新处理。
REPAIR_KEY = "thumbnails.repair"
# 资源评估：生成前按这台服务器此刻的内存、临时目录与读取速度判断是否适合，不设固定的文件大小门槛。
# 估算系数来自实测（同一滤镜图、单线程，误差约 5%）：图片约「像素 × 解码后每像素字节数 + 文件大小 × 2」（管道解封装器
# 把整个文件攒成一个数据包；JPEG 4:2:0 为 1.5、4:4:4 为 3，PNG 按位深与颜色类型），视频由分辨率与参考帧决定、
# 与文件大小无关（4K 实测 125–325 MiB，按 16 帧 × 1.5 字节／像素估算）。
DECODE_BASE = 40 * MIB
IMAGE_BYTES_PER_PIXEL = 4  # 文件头里读不出解码格式时按 RGBA 估算
VIDEO_BYTES_PER_PIXEL = 24
# FFmpeg 的 av_image_check_size：(宽 + 128) × (高 + 128) 必须小于 INT_MAX / 8，超过的画面根本无法解码。
PIXEL_LIMIT = (2**31 - 1) // 8
# 生成时给服务其他部分留出的内存与临时目录空间。
MEMORY_RESERVE = 128 * MIB
TEMP_RESERVE = 64 * MIB
# 没有记录尺寸的图片只读文件开头解析宽高（不解码画面）。
HEADER_BYTES = 512 * 1024
# 本进程记住的「这台服务器不适合生成」的 Blob 数量上限；重启后按已记录的尺寸重新评估，代价很小。
UNSUITABLE_LIMIT = 4096
# 自定义缩略图可以填写图片地址，由服务器经受控出站客户端读取后交给网页处理。
FETCH_LIMIT = 50 * MIB
FETCH_TIMEOUT = 30


def _resident(pid):
    """Linux 上进程当前的常驻内存字节数；其他系统或进程已退出时返回 0。"""
    try:
        with open(f"/proc/{pid}/status", "rb") as status:
            for line in status:
                if line.startswith(b"VmRSS:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return 0


class ThumbnailError(Exception):
    pass


class ThumbnailRetry(ThumbnailError):
    """暂时无法继续（服务器资源不足、已读分片缓存被回收），稍后可以再试，不能记为「无法生成」。"""


class ThumbnailUnsuitable(ThumbnailError):
    """按这台服务器的资源条件不适合生成（所需内存超过上限、画面超过解码器上限）：自动流程不再尝试。
    不记为「无法生成」，浏览器预览时仍可用已加载的画面生成，用户也可以上传图片作为缩略图。"""


def _size_text(value: int) -> str:
    return f"{value / 1024 ** 3:.1f} GB" if value >= 1024 ** 3 else f"{max(1, round(value / MIB))} MB"


def decode_estimate(kind: str, size: int, dims: tuple[int, int] | None, bpp: float | None = None) -> int:
    """估算生成缩略图时解码器的内存峰值。bpp 是图片解码后每像素的字节数（未知按 4）；
    尺寸未知时只计入能确定的部分，由运行中的内存巡检兜底。"""
    pixels = dims[0] * dims[1] if dims else 0
    if kind == "image":
        return DECODE_BASE + 2 * size + int(pixels * (IMAGE_BYTES_PER_PIXEL if bpp is None else bpp))
    if kind == "video":
        return DECODE_BASE + pixels * VIDEO_BYTES_PER_PIXEL
    return DECODE_BASE


def _boxes(data: bytes, start: int, end: int):
    """ISO BMFF（AVIF／HEIF）盒子：(类型, 内容起点, 终点)；被截断的盒子只给出已读到的部分。"""
    while start + 8 <= end:
        size, kind, header = int.from_bytes(data[start:start + 4], "big"), data[start + 4:start + 8], 8
        if size == 1:
            size, header = int.from_bytes(data[start + 8:start + 16], "big"), 16
        elif size == 0:
            size = end - start
        if size < header:
            return
        yield kind, start + header, min(start + size, end)
        start += size


def image_size(data: bytes) -> tuple[int, int] | None:
    header = image_header(data)
    return header[:2] if header else None


def image_header(data: bytes) -> tuple[int, int, float | None] | None:
    """只解析文件开头的图片头部，取得宽、高与解码后每像素的字节数（读不出时为 None），不解码画面；
    格式不认识或头部不完整时返回 None。"""
    bpp = None
    try:
        if data.startswith(b"\x89PNG\r\n\x1a\n") and data[12:16] == b"IHDR":
            size = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
            # 颜色类型 → 通道数；调色板解码为 8 位索引。
            channels = {0: 1, 2: 3, 3: None, 4: 2, 6: 4}.get(data[25])
            bpp = 1 if data[25] == 3 else channels * max(8, data[24]) / 8 if channels else None
        elif data[:6] in (b"GIF87a", b"GIF89a"):
            size = int.from_bytes(data[6:8], "little"), int.from_bytes(data[8:10], "little")
        elif data[:2] == b"BM" and len(data) >= 26:
            if int.from_bytes(data[14:18], "little") == 12:
                size = int.from_bytes(data[18:20], "little"), int.from_bytes(data[20:22], "little")
            else:
                size = (abs(int.from_bytes(data[18:22], "little", signed=True)),
                        abs(int.from_bytes(data[22:26], "little", signed=True)))
                if len(data) >= 30:
                    bpp = max(1, int.from_bytes(data[28:30], "little") // 8)
        elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            chunk = data[12:16]
            if chunk == b"VP8X":
                size = 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
            elif chunk == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
                size = int.from_bytes(data[26:28], "little") & 0x3FFF, int.from_bytes(data[28:30], "little") & 0x3FFF
            elif chunk == b"VP8L" and data[20] == 0x2F:
                bits = int.from_bytes(data[21:25], "little")
                size = (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            else:
                return None
        elif data.startswith(b"\xff\xd8"):
            index, size = 2, None
            while size is None:
                if index + 9 > len(data) or data[index] != 0xFF:
                    return None
                marker = data[index + 1]
                if marker == 0xFF:
                    index += 1
                elif marker == 0x01 or 0xD0 <= marker <= 0xD8:
                    index += 2
                elif marker == 0xDA:
                    return None
                elif 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    size = int.from_bytes(data[index + 7:index + 9], "big"), int.from_bytes(data[index + 5:index + 7], "big")
                    # 各分量的采样因子决定解码后的平面大小：4:2:0 为 1.5 字节／像素，4:4:4 为 3。
                    count = data[index + 9]
                    factors = [(data[index + 11 + 3 * n] >> 4, data[index + 11 + 3 * n] & 15) for n in range(count)]
                    widest, tallest = max(h for h, _ in factors), max(v for _, v in factors)
                    if widest and tallest:
                        bpp = sum(h * v for h, v in factors) / (widest * tallest) * max(1, data[index + 4] // 8)
                else:
                    index += 2 + int.from_bytes(data[index + 2:index + 4], "big")
        elif data[:4] in (b"II*\x00", b"MM\x00*"):
            order = "little" if data[:2] == b"II" else "big"
            offset = int.from_bytes(data[4:8], order)
            values = {}
            for entry in range(int.from_bytes(data[offset:offset + 2], order)):
                start = offset + 2 + entry * 12
                if start + 12 > len(data):
                    break
                tag, kind = int.from_bytes(data[start:start + 2], order), int.from_bytes(data[start + 2:start + 4], order)
                values[tag] = int.from_bytes(data[start + 8:start + (10 if kind == 3 else 12)], order)
            size = values.get(256, 0), values.get(257, 0)
        elif data[4:8] == b"ftyp":
            # AVIF／HEIF：meta → iprp → ipco 中的 ispe；网格图片取最大的一项（整张画面）。
            size = (0, 0)
            for kind, start, end in _boxes(data, 0, len(data)):
                if kind != b"meta":
                    continue
                for child, child_start, child_end in _boxes(data, start + 4, end):
                    if child != b"iprp":
                        continue
                    for group, group_start, group_end in _boxes(data, child_start, child_end):
                        if group != b"ipco":
                            continue
                        for prop, prop_start, prop_end in _boxes(data, group_start, group_end):
                            if prop == b"ispe" and prop_end - prop_start >= 12:
                                found = (int.from_bytes(data[prop_start + 4:prop_start + 8], "big"),
                                         int.from_bytes(data[prop_start + 8:prop_start + 12], "big"))
                                if found[0] * found[1] > size[0] * size[1]:
                                    size = found
        else:
            return None
    except (IndexError, ValueError, ZeroDivisionError):
        return None
    return (*size, bpp) if size and size[0] > 0 and size[1] > 0 else None


def video_frame_usable(pixels: bytes) -> bool:
    if len(pixels) != VIDEO_SAMPLE_SIZE ** 2:
        return False
    count = len(pixels)
    if sum(value <= 24 for value in pixels) >= count * 0.7 or sum(value >= 232 for value in pixels) >= count * 0.7:
        return False
    mean = sum(pixels) / count
    if sum(value * value for value in pixels) / count - mean * mean < 12 ** 2:
        return False
    # 大面积单色叠加小标志也会有很高的全局方差；85% 像素集中在相近的 25 级亮度仍视为空白。
    histogram = [0] * 256
    for value in pixels:
        histogram[value] += 1
    band = sum(histogram[:25])
    if band >= count * 0.85:
        return False
    for value in range(25, 256):
        band += histogram[value] - histogram[value - 25]
        if band >= count * 0.85:
            return False
    # 至少 8% 像素有明显邻域变化，覆盖 4 个分区并包含中部，避免平滑渐变、黑边和角落标志充数。
    tiles = [0] * 16
    tile_size = VIDEO_SAMPLE_SIZE // 4
    for index, value in enumerate(pixels):
        x, y = index % VIDEO_SAMPLE_SIZE, index // VIDEO_SAMPLE_SIZE
        horizontal = x > 0 and abs(value - pixels[index - 1]) >= 12
        vertical = y > 0 and abs(value - pixels[index - VIDEO_SAMPLE_SIZE]) >= 12
        if horizontal or vertical:
            tiles[(y // tile_size) * 4 + x // tile_size] += 1
    return (sum(tiles) >= count * 0.08 and sum(value >= 4 for value in tiles) >= 4
            and any(tiles[index] >= 4 for index in (5, 6, 9, 10)))


def source_kind(info: ObjectInfo) -> str | None:
    kind = kind_of(info.key, info.content_type)
    if not info.blob_uuid or not info.size or info.key.endswith("/"):
        return None
    if kind == "image" and (info.key.lower().endswith(".svg") or "svg" in (info.content_type or "").lower()):
        return None
    return kind if kind in ("image", "video", "audio") else None


def image_mime(data: bytes) -> str | None:
    """按文件头判断图片类型；不信任来源声明的 Content-Type，也不在服务端解码。"""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:2] == b"BM" and len(data) > 26:
        return "image/bmp"
    if data[4:8] == b"ftyp" and data[8:12] in (b"avif", b"avis"):
        return "image/avif"
    return None


class _RangeInput:
    """只提供一个 Blob 的短期本地 HTTP/代理入口，支持解码器跳到尾部索引再回读画面。"""

    def __init__(self, engine, info, authorize, *, cache_only=False):
        self.engine, self.info, self.authorize = engine, info, authorize
        self.failure = None
        # 只统计从存储读取的量（管理员页显示），不限制。
        self.remote_bytes = 0
        self.cache_only = cache_only
        self.path = "/" + secrets.token_urlsafe(32)
        self.server = None
        self.tasks = set()
        self.slots = asyncio.Semaphore(2)

    def _charge(self, ref, size):
        self.remote_bytes += size

    async def __aenter__(self):
        self.server = await asyncio.start_server(self._serve, "127.0.0.1", 0, limit=8192)
        port = self.server.sockets[0].getsockname()[1]
        self.origin = f"http://127.0.0.1:{port}"
        self.url = self.origin + self.path
        return self

    async def __aexit__(self, *_):
        self.server.close()
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.server.wait_closed()

    def _range(self, value):
        size = self.info.size
        if value is None:
            return 0, size, 200
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
        if not match or not any(match.groups()):
            raise ValueError("invalid range")
        left, right = match.groups()
        start = int(left) if left else max(0, size - int(right))
        end = min(size, int(right) + 1) if left and right else size
        if start >= end:
            raise ValueError("invalid range")
        return start, end, 206

    async def _serve(self, reader, writer):
        task = asyncio.current_task()
        if len(self.tasks) >= 4:
            writer.close()
            return
        self.tasks.add(task)
        started = False
        try:
            async with self.slots:
                header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
                lines = header.decode("iso-8859-1").split("\r\n")
                method, target, _ = lines[0].split(" ", 2)
                headers = dict(line.split(":", 1) for line in lines[1:] if ":" in line)
                headers = {key.lower(): value.strip() for key, value in headers.items()}
                # 代理请求使用绝对地址；其他主机、路径和方法一律拒绝，不能借此让解码器出站。
                if method not in ("GET", "HEAD") or target not in (self.path, self.url) or headers.get("host") != self.origin[7:]:
                    writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    await writer.drain()
                    return
                self.authorize()
                start, end, status = self._range(headers.get("range"))
                response = [f"HTTP/1.1 {status} OK", f"Content-Length: {end - start}",
                            "Content-Type: application/octet-stream", "Accept-Ranges: bytes",
                            "Cache-Control: no-store", "Connection: close"]
                if status == 206:
                    response.append(f"Content-Range: bytes {start}-{end - 1}/{self.info.size}")
                writer.write(("\r\n".join(response) + "\r\n\r\n").encode("ascii"))
                started = True
                await writer.drain()
                if method == "HEAD":
                    return
                while start < end:
                    self.authorize()
                    # 分窗口流式交付，不把完整文件放入内存。
                    stop = min(end, start + MIB)
                    # 缩略图是后台工作：读取名额给前台下载、预览与播放留一个。
                    async with aclosing(self.engine.stream(self.info.blob_uuid, start, stop,
                                                          window=MIB, bucket_id=self.info.bucket_id,
                                                          cache_only=self.cache_only, background=True,
                                                          read_budget=None if self.cache_only else self._charge)) as source:
                        async for piece in source:
                            self.authorize()
                            writer.write(piece)
                            await writer.drain()
                    start = stop
        except (ConnectionError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
            # FFmpeg 跳转或退出会中断旧连接；不把这种正常中断当作文件损坏。
            pass
        except Exception as exc:
            self.failure = exc
            if not started:
                writer.write(b"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass
            self.tasks.discard(task)


@dataclass
class _Job:
    info: ObjectInfo
    ready_at: float = 0
    force: bool = False
    remote: bool = False
    state: str = "queued"
    detail: str = "等待处理"
    revision: int = 0
    misses: int = 0
    backfill: bool = False
    # auto：自动流程（图片按原图，音视频优先内嵌封面，视频没有时截帧）；capture：截图生成（视频截取画面）；
    # smart：文件助手生成（音视频依次用内嵌封面、在线查找、截取画面）。
    mode: str = "auto"


@dataclass
class _Lease:
    info: ObjectInfo
    token: str
    until: float


class ThumbnailService:
    """单并发协作队列。即时任务复用已收数据，空闲补图按管理员日额度回源，用户请求不设单文件门槛。"""

    def __init__(self, accounts, objects, resources):
        self.accounts, self.objects, self.resources = accounts, objects, resources
        self.metadata, self.keystore = objects.metadata, accounts.keystore
        data_dir = getattr(resources, "data_dir", None)
        config = getattr(resources, "config", None)
        self.cache = ThumbnailCache(directory=data_dir / "thumbnail-cache" if data_dir is not None else None,
                                    reserve=(lambda: config()["reserve_mib"] * 1024 * 1024) if callable(config) else None)
        if callable(config):
            self.cache.configure(config()["thumbnail_cache_mib"])
        objects.thumbnail_service = self
        objects.engine.thumbnail_cache = self.cache if resources.ffmpeg else None
        objects.on_change = lambda bucket: self._dispatch(self._changed, bucket)
        self.cache.on_data = lambda blob: self._dispatch(self._received, blob)
        self._runner = self._loop = self._active = self._task = None
        self._wake = asyncio.Event()
        self._pending, self._leases, self._history = OrderedDict(), {}, OrderedDict()
        self._fetches = asyncio.Semaphore(2)
        self._http = None
        self._remote_bytes = 0
        # 补图扫描的键集游标、下一次扫描时间与暂时失败后推迟重试的 Blob（进程内，重启后重新尝试）。
        self._backfill_cursor, self._backfill_at, self._backfill_skip = (0, ""), 0.0, {}
        # 资源评估：不适合这台服务器的 Blob 与原因、从文件头读到的图片尺寸（进程内，有上限）、最近的存储读取速度。
        self._unsuitable, self._probed = OrderedDict(), OrderedDict()
        self._read_rate = None
        # 在线查找封面（文件助手生成时使用），由 asgi 注入 MediaService；没有时跳过这一步。
        self.media = None

    def _dispatch(self, action, *args):
        loop = self._loop
        if loop is not None and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(action, *args)
            except RuntimeError:
                pass

    def start(self):
        if self._runner is None and self.resources.ffmpeg:
            try:
                self._repair()
            except Exception as exc:
                log.warning("缩略图记录修复暂未完成：%s", type(exc).__name__)
            self.objects.engine.thumbnail_cache = self.cache
            self._backfill_cursor, self._backfill_at = (0, ""), time.monotonic() + 30
            self._loop = asyncio.get_running_loop()
            self._runner = asyncio.create_task(self._run())

    async def stop(self):
        self._loop = None
        if self._runner is not None:
            self._runner.cancel()
            await asyncio.gather(self._runner, return_exceptions=True)
            self._runner = None
        self._pending.clear()
        self._leases.clear()
        self.cache.close()

    @staticmethod
    def _eligible(info):
        return source_kind(info) is not None and (not info.key.startswith(".tgdrive/") or info.key.startswith(PRIVATE_PREFIX))

    def _has_thumbnail(self, blob):
        return self.metadata.db.execute("SELECT 1 FROM thumbnails WHERE blob_uuid=? LIMIT 1", (blob,)).fetchone() is not None

    def enqueue(self, info: ObjectInfo, scope: Scope | None = None):
        if scope is not None and scope.custom_cover:
            return  # 写入方已指定封面，以它为准，不从文件内容自动生成。
        if self._eligible(info) and info.blob_uuid not in self._unsuitable:
            delay = CLIENT_TIMEOUT if scope and scope.thumbnail_client else 1
            self._dispatch(self._enqueue, _Job(info, time.monotonic() + delay,
                state="waiting_client" if delay == CLIENT_TIMEOUT else "queued",
                detail="等待上传端生成" if delay == CLIENT_TIMEOUT else "等待处理"))

    def observe(self, info, *, client=False):
        """用户真正读取文件时登记；接下来交付的密文会进入缓存，不另开原文件请求。
        client 表示读取者是登录的网页：图片和视频由预览页用已解码的画面生成，后台只在超时后接管。"""
        if self._eligible(info) and not self._has_thumbnail(info.blob_uuid):
            if client and source_kind(info) in ("image", "video"):
                job = _Job(info, time.monotonic() + PREVIEW_GRACE, state="waiting_client", detail="等待预览页用已加载的画面生成")
            else:
                job = _Job(info, time.monotonic() + 2)
            self._dispatch(self._enqueue, job)

    def wants_data(self, info):
        return self._eligible(info) and not self._has_thumbnail(info.blob_uuid)

    def _enqueue(self, job):
        blob = job.info.blob_uuid
        if not job.force and self._has_thumbnail(blob):
            return False
        previous = self._pending.get(blob)
        if previous is not None:
            if job.remote and not job.backfill and (not previous.remote or previous.backfill):
                previous.info = job.info
                self._leases.pop(blob, None)
                previous.force, previous.remote, previous.backfill, previous.ready_at = True, True, False, 0
                previous.mode = job.mode
                previous.state, previous.detail = "queued", "用户请求重新生成"
                if self._active is previous and self._task is not None:
                    self._task.cancel()  # 从后台策略切换为用户主动任务，复用已有缓存重新开始。
            return True
        if len(self._pending) >= 128:
            # 缺图扫描可以重建自动任务；优先让出等待数据的名额给新上传与用户请求。
            victim = next((key for key, item in self._pending.items() if (item.state == "waiting_data" or item.backfill) and key not in self._leases and item is not self._active), None)
            if victim is None:
                if job.remote and not job.backfill:
                    raise ValueError("封面队列已满，请稍后重试")
                return False
            self._pending.pop(victim)
        self._pending[blob] = job
        self._wake.set()
        return True

    def _expire_clients(self):
        now = time.monotonic()
        for blob, lease in list(self._leases.items()):
            if lease.until <= now:
                self._leases.pop(blob)
        for blob, job in self._pending.items():
            if job.state == "waiting_client" and blob not in self._leases and job.ready_at <= now:
                job.state, job.detail = "queued", "上传端超时，服务端接管缓存数据"

    def _received(self, blob):
        job = self._pending.get(blob)
        if job is not None and job.state == "waiting_data" and blob not in self._leases:
            job.state, job.detail = "queued", "已收到新数据"
            job.ready_at = time.monotonic() + min(60, 2 << job.misses)
            self._wake.set()

    def _changed(self, bucket):
        for blob, job in list(self._pending.items()):
            if job.info.bucket_id != bucket:
                continue
            try:
                self._scope(job.info, None).authorize()
            except NotFoundError:
                rows = self.metadata.db.execute("SELECT * FROM objects WHERE bucket_id=? AND blob_uuid=? "
                    "AND (substr(key,1,9)!='.tgdrive/' OR substr(key,1,?)=?) LIMIT 8",
                    (bucket, blob, len(PRIVATE_PREFIX), PRIVATE_PREFIX)).fetchall()
                replacement = next((self.objects._object(row) for row in rows if self._eligible(self.objects._object(row))), None)
                if replacement is not None:
                    # 改名或仍有副本时沿用同一份缓存，只撤销旧路径的浏览器票据。
                    self._leases.pop(blob, None)
                    job.info, job.state, job.detail, job.ready_at = replacement, "queued", "文件位置已更新，复用原缓存", 0
                    if self._active is job and self._task is not None:
                        self._task.cancel()
                    continue
                self._cancel(job)
            except PermissionError:
                self._cancel(job)
            except NotReadyError:
                pass  # 系统锁定时保留任务，恢复解锁后再处理。
        self._wake.set()

    def _cancel(self, job, detail="文件已删除、移动、覆盖或账号不可用"):
        blob = job.info.blob_uuid
        self._pending.pop(blob, None)
        self._leases.pop(blob, None)
        if self._active is job and self._task is not None:
            self._task.cancel()
        self._record(job, "cancelled", detail)
        self.cache.drop(blob)

    def claim(self, scope, key, etag, *, force=False, custom=False, ticket=None):
        self._expire_clients()
        info = self.objects.head_object(scope, key)
        self.objects._check_scope(scope, key, write=True)
        if info.etag != etag:
            raise ValueError("文件内容已变化，请刷新后重试")
        if ticket is not None:
            self.check_claim(info, ticket)
            lease = self._leases[info.blob_uuid]
            lease.until = time.monotonic() + CLIENT_TIMEOUT
            job = self._pending.get(info.blob_uuid)
            if job is not None:
                job.ready_at = lease.until
            return {"token": lease.token, "expires_in": CLIENT_TIMEOUT}
        if custom:
            return self._custom_claim(info)
        if not self._eligible(info) or (not force and self._has_thumbnail(info.blob_uuid)):
            return {"token": None}
        blob, now = info.blob_uuid, time.monotonic()
        lease = self._leases.get(blob)
        if self._active is not None and self._active.info.blob_uuid == blob or lease is not None and lease.until > now:
            return {"token": None}
        job = self._pending.get(blob) or _Job(info, force=force)
        if not self._enqueue(job):
            return {"token": None}
        lease = _Lease(info, secrets.token_urlsafe(24), now + CLIENT_TIMEOUT)
        self._leases[blob] = lease
        job.state, job.detail, job.ready_at = "waiting_client", "浏览器正在复用本地或预览数据", lease.until
        return {"token": lease.token, "expires_in": CLIENT_TIMEOUT}

    def _take_over(self, info):
        """用户指定的缩略图优先于自动生成：取消这个 Blob 排队或进行中的自动任务。"""
        if info.key.endswith("/") or not info.blob_uuid:
            raise ValueError("只有文件可以设置封面")
        if info.key.startswith(".tgdrive/") and not info.key.startswith(PRIVATE_PREFIX):
            raise ValueError("系统文件不能设置封面")
        job = self._pending.pop(info.blob_uuid, None)
        if job is not None:
            if self._active is job and self._task is not None:
                self._task.cancel()
            self._record(job, "cancelled", "用户设置了自定义封面")

    def _custom_claim(self, info):
        """用户指定的缩略图（上传图片、图片地址或播放器当前画面）适用于任何文件，优先于自动生成：
        取消这个 Blob 排队或进行中的自动任务并收回旧票据，不登记新任务；保存仍走带票据的普通写入。"""
        self._take_over(info)
        blob = info.blob_uuid
        lease = _Lease(info, secrets.token_urlsafe(24), time.monotonic() + CLIENT_TIMEOUT)
        self._leases[blob] = lease
        return {"token": lease.token, "expires_in": CLIENT_TIMEOUT}

    async def fetch_image(self, url):
        """读取用户填写的图片地址，只返回受支持的图片原始字节，由网页缩放后按普通流程保存。
        连接经离线下载的受控客户端（拒绝内网地址、遵循出站代理），不转发任何登录凭据。"""
        from .offline.http import SafeHttpClient
        from .offline.request import DownloadRequest
        if not isinstance(url, str) or not url.strip() or len(url) > 4096:
            raise ValueError("请填写图片地址")
        url = url.strip()
        if not re.match(r"https?://", url, re.IGNORECASE):
            raise ValueError("图片地址必须以 http:// 或 https:// 开头")
        if self._http is None:
            self._http = SafeHttpClient(proxy=lambda: self.resources.config().get("proxy") or "")
        request = DownloadRequest(url, headers=[("Accept", "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8")])
        async with self._fetches:
            try:
                async with asyncio.timeout(FETCH_TIMEOUT):
                    async with self._http.open(request, identity=True) as response:
                        if response.status != 200:
                            raise ValueError(f"图片地址无法访问（HTTP {response.status}）")
                        if response.size is not None and response.size > FETCH_LIMIT:
                            raise ValueError("图片超过 50 MB，请换一张较小的图片")
                        pieces, size = [], 0
                        async for piece in response.stream():
                            size += len(piece)
                            if size > FETCH_LIMIT:
                                raise ValueError("图片超过 50 MB，请换一张较小的图片")
                            pieces.append(piece)
            except TimeoutError:
                raise ValueError("读取图片超时，请检查地址或稍后重试") from None
        data = b"".join(pieces)
        mime = image_mime(data)
        if mime is None:
            raise ValueError("地址返回的不是受支持的图片（JPEG、PNG、WebP、GIF、BMP 或 AVIF）")
        return data, mime

    async def apply_custom(self, scope, key, images):
        """服务端直接保存用户指定的缩略图（离线下载任务附带的封面）：与网页自定义缩略图同样取消自动任务、
        保存后清除没有更新的旧规格。images 是已缩放好的 {规格: 图片字节}。"""
        info = self.objects.head_object(scope, key)
        self._take_over(info)
        self._leases.pop(info.blob_uuid, None)
        saved = []
        for variant in ("thumb", "grid", "poster"):
            if variant in images:
                await self.objects.set_thumbnail(scope, key, images[variant], variant)
                saved.append(variant)
        self.objects.finish_thumbnail_set(scope, key, saved)
        return saved

    async def render_image(self, data, *, authorize=lambda: None):
        """把内嵌封面或离线任务指定的图片缩放成缩略图；服务器没有 FFmpeg 时返回 None。"""
        if not self.resources.ffmpeg or image_mime(data) is None:
            return None
        with tempfile.TemporaryDirectory(prefix="tessera-cover-") as directory:
            path = Path(directory) / "source"
            path.write_bytes(data)
            source = SimpleNamespace(url=str(path), origin="", failure=None)
            async with asyncio.timeout(TIMEOUT):
                images, _ = await self._render_frame(source, "image", Path(directory), authorize, protocols="file")
            return images

    async def _embedded_images(self, info, authorize, allow_remote):
        """视频按容器索引读取内嵌封面；与截图生成共用缓存、授权和读取策略，不读完整个视频。"""
        async def read(start, end):
            authorize()
            try:
                return await self._read(info, start, end, allow_remote)
            except WorkBusyError:
                raise ThumbnailRetry("文件读取名额繁忙，稍后再生成") from None

        tags = await media_tags.parse(read, info.size)
        picture = tags.cover() if tags else None
        if picture is None:
            return None
        if picture.data is not None:
            data = picture.data
        elif picture.length > 20 * MIB:
            return None
        else:
            data = await read(picture.offset, picture.offset + picture.length)
        return await self._render_picture(data, authorize)

    async def _render_picture(self, data, authorize):
        """把一张图片（内嵌封面或在线找到的封面）缩放成缩略图；不是受支持的图片时返回 None。"""
        if image_mime(data) is None:
            return None
        header = image_header(data)
        # 封面按图片自身评估，不能因为主视频分辨率过高而拒绝一张很小的内嵌图片。
        self._plan(SimpleNamespace(size=len(data)), "image", header[:2] if header else None,
                   header[2] if header else None, remote=False)
        return await self.render_image(data, authorize=authorize)

    def check_claim(self, info, token):
        lease = self._leases.get(info.blob_uuid)
        if lease is None or not secrets.compare_digest(lease.token, token) or lease.until <= time.monotonic() or (
                lease.info.bucket_id, lease.info.key, lease.info.etag) != (info.bucket_id, info.key, info.etag):
            raise ValueError("封面生成授权已失效，结果已丢弃")

    def release(self, scope, key, etag, token):
        info = self.objects.head_object(scope, key)
        if info.etag != etag:
            raise ValueError("文件内容已变化，结果已丢弃")
        self.check_claim(info, token)
        self._leases.pop(info.blob_uuid, None)
        job = self._pending.get(info.blob_uuid)
        if job is not None:
            if self._has_thumbnail(info.blob_uuid):
                self._pending.pop(info.blob_uuid, None)
                self._record(job, "done", "浏览器已生成，无需回源")
                self.cache.drop(info.blob_uuid)
            else:
                job.state, job.detail, job.ready_at = "queued", "上传端未完成，服务端接管缓存数据", 0
        self._wake.set()

    def request(self, scope, key, etag, mode="capture"):
        """用户请求生成：capture 为「更新封面 → 截图生成」（图片按原图缩放、视频截取画面），
        smart 为文件助手生成（音视频依次用内嵌封面、在线查找、截取画面）。"""
        if mode not in ("capture", "smart"):
            raise ValueError("不支持的封面生成方式")
        self.objects._check_scope(scope, key, write=True)
        info = self.objects.head_object(scope, key)
        if info.etag != etag:
            raise ValueError("文件内容已变化，请刷新后重试")
        if not self._eligible(info):
            raise ValueError("此文件不支持生成封面")
        if mode == "capture" and source_kind(info) == "audio":
            raise ValueError("音频没有画面可以截取，请使用内置封面、在线查找或本地图片")
        if not self.resources.ffmpeg:
            raise ValueError("服务器未安装 FFmpeg，无法在服务器生成")
        # 已知尺寸时当场评估，不适合就直接说明原因，不进入队列；尺寸未知的图片在任务里读文件头后再评估。
        try:
            self._plan(info, source_kind(info), *self._known(info), remote=True)
        except ThumbnailError as exc:
            raise ValueError(str(exc)) from None
        self._unsuitable.pop(info.blob_uuid, None)
        self._history.pop(info.blob_uuid, None)
        self._enqueue(_Job(info, force=True, remote=True, detail="用户请求生成", mode=mode))
        return {"accepted": True}

    def progress(self, scope, key, etag):
        """网页「更新封面 → 截图生成」与文件助手生成封面查询这个文件的生成进度：排队、处理中，或最近一次的结果与原因。"""
        self.objects._check_scope(scope, key)
        info = self.objects.head_object(scope, key)
        if info.etag != etag:
            raise ValueError("文件内容已变化，请刷新后重试")
        job = self._pending.get(info.blob_uuid)
        if job is not None and job.info.bucket_id == info.bucket_id:
            return {"state": "running" if self._active is job else "queued", "detail": job.detail}
        record = self._history.get(info.blob_uuid)
        return {"state": record["state"], "detail": record["detail"]} if record else {"state": "idle", "detail": ""}

    def cancel(self, scope, key, etag):
        self.objects._check_scope(scope, key, write=True)
        info = self.objects.head_object(scope, key)
        if info.etag != etag:
            raise ValueError("文件内容已变化，请刷新后重试")
        job = self._pending.get(info.blob_uuid)
        if job is None or job.info.bucket_id != info.bucket_id:
            return {"cancelled": False}
        self.objects._check_scope(scope, job.info.key, write=True)
        self._cancel(job, "用户已停止生成")
        return {"cancelled": True}

    # ---------- 自动补图 ----------

    def _setting(self, key):
        row = self.metadata.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        try:
            return json.loads(row["value"]) if row else {}
        except (TypeError, ValueError):
            return {}

    def _save_setting(self, key, value):
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (key, json.dumps(value, separators=(",", ":"))))

    def backfill_status(self):
        return {"age_seconds": BACKFILL_AGE, "pending": sum(1 for job in self._pending.values() if job.backfill)}

    def _backfill_page(self):
        """按键集分页找出较早写入、仍没有任何缩略图记录（含「无法生成」）的媒体文件；只读元数据。"""
        clauses, args = kind_clause("image,video,audio")
        rows = self.metadata.db.execute(
            "SELECT o.* FROM objects o JOIN buckets b ON b.id=o.bucket_id "
            "LEFT JOIN users u ON u.id=b.owner_user_id WHERE o.blob_uuid IS NOT NULL AND o.size>0 "
            "AND (substr(o.key,1,9)!='.tgdrive/' OR substr(o.key,1,?)=?) "
            "AND (b.owner_user_id IS NULL OR u.status='active') AND o.modified_at<? "
            # 缩略图计入所在存储桶的配额：空间已满的桶保存不了，先不回源。
            "AND (b.quota_bytes IS NULL OR b.quota_bytes-b.used_bytes>=1048576) "
            "AND (o.bucket_id,o.key)>(?,?) AND NOT EXISTS (SELECT 1 FROM thumbnails t WHERE t.blob_uuid=o.blob_uuid) "
            f"AND {clauses} ORDER BY o.bucket_id,o.key LIMIT 32",
            (len(PRIVATE_PREFIX), PRIVATE_PREFIX, time.time() - BACKFILL_AGE, *self._backfill_cursor, *args)).fetchall()
        return [self.objects._object(row) for row in rows]

    async def _plan_backfill(self):
        """队列里没有更便宜的任务时补充最多 4 个补图任务；扫描到末尾后暂停一段时间。"""
        if time.monotonic() < self._backfill_at or sum(1 for job in self._pending.values() if job.backfill) >= 4:
            return False
        page = await self.metadata.run_in_thread(self._backfill_page)
        if not page:
            # 一轮扫描结束：下一轮从头开始，覆盖这段时间里新变得「较早」的文件（只查元数据，开销很小）。
            self._backfill_cursor, self._backfill_at = (0, ""), time.monotonic() + BACKFILL_AGE
            return False
        now, added = time.monotonic(), False
        for key, until in list(self._backfill_skip.items()):
            if until <= now:
                self._backfill_skip.pop(key)
        for info in page:
            if sum(1 for job in self._pending.values() if job.backfill) >= 4:
                break
            # 游标只越过已经看过的文件；名额满时这一页剩下的文件下次接着处理，不能等到下一轮。
            self._backfill_cursor = (info.bucket_id, info.key)
            blob = info.blob_uuid
            if (not self._eligible(info) or blob in self._pending or blob in self._leases or blob in self._backfill_skip
                    or blob in self._unsuitable):
                continue
            added = self._enqueue(_Job(info, remote=True, backfill=True, detail="自动补图：从存储读取")) or added
        return added

    def _repair(self):
        """升级后执行一次：旧版失败标记交给自动补图，版本 2 只重试启用截帧回退的视频。"""
        version = self._setting(REPAIR_KEY).get("version", 0)
        if version >= 2:
            return
        with self.metadata.transaction() as db:
            if version < 1:
                db.execute("DELETE FROM thumbnails WHERE variant='none'")
            else:
                clause, args = kind_clause("video")
                db.execute("DELETE FROM thumbnails WHERE variant='none' AND blob_uuid IN "
                           f"(SELECT blob_uuid FROM objects WHERE {clause})", args)
        self._save_setting(REPAIR_KEY, {"version": 2})

    def _record(self, job, state, detail):
        blob = job.info.blob_uuid
        self._history[blob] = {"id": hashlib.sha256(blob.encode()).hexdigest()[:12], "kind": source_kind(job.info),
            "state": state, "detail": detail, "at": time.time()}
        self._history.move_to_end(blob)
        while len(self._history) > 50:
            self._history.popitem(last=False)

    def status(self):
        self._expire_clients()
        jobs = [{"id": hashlib.sha256(blob.encode()).hexdigest()[:12], "kind": source_kind(job.info),
                 "state": job.state, "detail": job.detail, "backfill": job.backfill,
                 "wait_seconds": max(0, int(job.ready_at - time.monotonic()))} for blob, job in self._pending.items()]
        pressure = self.resources.pressure()
        return {"available": bool(self.resources.ffmpeg), "unlocked": self.keystore.unlocked,
                "pressure": pressure, "jobs": jobs, "recent": list(reversed(self._history.values())),
                "cache": self.cache.status(), "remote_bytes": self._remote_bytes,
                "client_timeout_seconds": CLIENT_TIMEOUT, "task_timeout_seconds": TIMEOUT,
                "capacity": 128, "backfill": self.backfill_status(),
                "limits": {"memory_cap": self._memory_cap(), "memory_available": self.resources.available_memory(),
                           "read_rate": round(self._read_rate) if self._read_rate else None, "unsuitable": len(self._unsuitable)},
                "inline": self.objects.inline_thumbnails()}

    async def _run(self):
        while True:
            try:
                self._wake.clear()
                if self.keystore.unlocked and not self.resources.pressure():
                    self._expire_clients()
                    now = time.monotonic()
                    ready = (item for item in self._pending.values() if item.state == "queued" and item.ready_at <= now and item.info.blob_uuid not in self._leases)
                    # 用户请求优先，其次是只用缓存的自动任务，最后才是需要读取存储的补图；同级先图片和音频。
                    job = min(ready, key=lambda item: (2 if item.backfill else 0 if item.remote else 1,
                                                       {"image": 0, "audio": 1, "video": 2}[source_kind(item.info)]), default=None)
                    if job is not None:
                        blob = job.info.blob_uuid
                        if not job.force and self._has_thumbnail(blob):
                            self._pending.pop(blob)
                            self.cache.drop(blob)
                            continue
                        if not job.remote and not self.cache.revision(blob):
                            # 没有任何已接收的数据：不占队列名额，等文件被实际读取时 observe 再登记。
                            self._pending.pop(blob, None)
                            continue
                        job.state, job.detail = "running", "使用已接收缓存" if not job.remote else "优先使用缓存，必要时读取存储"
                        job.revision = self.cache.revision(blob)
                        self._active = job
                        started_remote = job.remote
                        self._task = asyncio.create_task(self.generate(job.info, force=job.force, allow_remote=job.remote, mode=job.mode))
                        try:
                            failure_detail = await self._task
                            self._pending.pop(blob, None)
                            if isinstance(failure_detail, str):
                                self._record(job, "failed", failure_detail)
                            else:
                                self._unsuitable.pop(blob, None)
                                self._record(job, "done", "自动补图完成" if job.backfill else "封面处理完成")
                            self.cache.drop(blob)
                        except ThumbnailCacheMiss:
                            job.misses += 1
                            job.state, job.detail = "waiting_data", "已接收的数据还不够，等待继续播放或下载；不会自动回源"
                            if job.remote and not started_remote:
                                job.state, job.ready_at = "queued", 0
                            elif job.misses >= MISS_LIMIT:
                                self._pending.pop(blob, None)
                                self._record(job, "failed", "已接收的数据不足以生成，可在文件菜单更新封面")
                                self.cache.drop(blob)
                            elif self.cache.revision(blob) != job.revision:
                                job.state, job.ready_at = "queued", time.monotonic() + min(60, 2 << job.misses)
                        except asyncio.CancelledError:
                            if asyncio.current_task().cancelling():
                                raise
                        except Exception as exc:
                            self._pending.pop(blob, None)
                            if isinstance(exc, ThumbnailUnsuitable):
                                # 这台服务器的资源条件不适合：本进程内自动流程不再尝试，用户请求时重新评估。
                                self._remember(self._unsuitable, blob, str(exc))
                            elif job.backfill and not isinstance(exc, (NotFoundError, PermissionError)):
                                # 资源、额度、网络和解码错误都可能恢复，不得据此永久跳过文件。
                                self._backfill_skip[blob] = time.monotonic() + BACKFILL_RETRY
                            if not isinstance(exc, (ThumbnailError, TimeoutError, NotFoundError, PermissionError)):
                                log.warning("缩略图任务失败：id=%s reason=unexpected_error error=%s",
                                            hashlib.sha256(blob.encode()).hexdigest()[:12], type(exc).__name__)
                            if isinstance(exc, TimeoutError):
                                detail = "处理超时"
                            elif isinstance(exc, ThumbnailError):
                                detail = str(exc)
                            elif isinstance(exc, NotFoundError):
                                detail = "源文件已删除、移动或覆盖"
                            elif isinstance(exc, PermissionError):
                                detail = "访问权限不足，无法生成"
                            else:
                                detail = "生成未完成，请结合服务日志排查"
                            self._record(job, "failed", detail)
                        finally:
                            self._active = self._task = None
                        continue
                    if await self._plan_backfill():
                        continue
                await asyncio.wait_for(self._wake.wait(), 1)
            except TimeoutError:
                pass
            except Exception as exc:
                log.debug("后台缩略图暂未生成：%s", type(exc).__name__)
                await asyncio.sleep(1)

    def _scope(self, info, original):
        # 私密空间只是网页访问锁，文件仍使用系统 KEK；内部后台任务不保存或借用网页解锁票据。
        kek = self.keystore.require_kek()
        def authorize():
            if self.keystore.require_kek() is not kek:
                raise NotReadyError("加密状态已变化")
            row = self.metadata.db.execute(
                "SELECT o.blob_uuid,b.owner_user_id,u.status FROM objects o JOIN buckets b ON b.id=o.bucket_id "
                "LEFT JOIN users u ON u.id=b.owner_user_id WHERE o.bucket_id=? AND o.key=?",
                (info.bucket_id, info.key)).fetchone()
            if row is None or row["blob_uuid"] != info.blob_uuid:
                raise NotFoundError("源文件已删除、移动或覆盖")
            if row["owner_user_id"] is not None and row["status"] != "active":
                raise PermissionError("账号已禁用或删除")
        scope = Scope(info.bucket_id, private_access=info.key.startswith(PRIVATE_PREFIX), authorize=authorize)
        self.objects._check_scope(scope, info.key, write=True)
        return scope

    async def generate(self, info: ObjectInfo, original: Scope | None = None, *, force=False, allow_remote=False, mode="auto") -> str | None:
        """生成并保存缩略图。用户请求、自动补图与已收数据任务走同一流程：开始前按服务器此刻的内存、临时空间与读取速度
        评估（_plan），不适合或暂时不行就不启动解码器；allow_remote 只决定缓存不足时能否从存储读取。
        来源按 mode：自动流程中图片按原图、音视频优先用文件内嵌封面，视频没有时截取画面；截图生成时视频直接截取画面；
        文件助手生成时音视频依次用内嵌封面、在线查找、截取画面（只有视频能截图）。
        只有确实没有可用图片才记录 none；资源不适合不记 none（浏览器预览仍可生成），运行异常交给队列延后重试。"""
        kind = source_kind(info)
        if not self._eligible(info) or not self.resources.ffmpeg:
            return
        scope = self._scope(info, None)
        self.cache.prepare(info.blob_uuid, info.key, info.content_type)
        if not force and self._has_thumbnail(info.blob_uuid):
            return
        if not force and info.blob_uuid in self._unsuitable:
            raise ThumbnailUnsuitable(self._unsuitable[info.blob_uuid])
        if kind == "image" and not allow_remote and info.size > self.cache.per_blob:
            # 解码图片要读完整个文件，短期缓存装不下时只用缓存必然失败；交给自动补图或用户请求评估后再读取存储。
            raise ThumbnailRetry("图片超过服务器的短期缓存，稍后由自动补图评估后从存储读取")
        async with asyncio.timeout(TIMEOUT):
            images = None
            if kind == "video":
                if mode != "capture":
                    images = await self._embedded_images(info, scope.authorize, allow_remote)
            else:
                # 图片按原图缩放；音频由解码器取出内嵌的专辑封面（音频没有画面可截）。
                images = await self._decode(info, kind, scope, allow_remote)
            if images is None and mode == "smart" and kind in ("audio", "video"):
                images = await self._online_cover(info, scope)
            if images is None and kind == "video":
                images = await self._decode(info, kind, scope, allow_remote)
            scope.authorize()
            if not force and self._has_thumbnail(info.blob_uuid):
                return
            if images is None:
                if kind == "video":
                    failure_detail = ("没有内嵌封面，截取的画面均为空白或细节不足" if mode == "auto"
                                      else "截取的画面均为空白或细节不足" if mode == "capture"
                                      else "没有内嵌封面，在线也没有找到合适的封面，截取的画面均为空白或细节不足")
                else:
                    failure_detail = ("音频没有可用的内嵌封面" + ("，在线也没有找到合适的封面" if mode == "smart" else "")) if kind == "audio" \
                        else "未能提取图片画面"
                if force and kind == "video":
                    raise ThumbnailError(failure_detail + "，未替换现有封面")
                await self.objects.set_thumbnail(scope, info.key, None, "none")
                return failure_detail
            saved = []
            for variant, data in images.items():
                scope.authorize()
                try:
                    await self.objects.set_thumbnail(scope, info.key, data, variant)
                    saved.append(variant)
                except QuotaExceededError:
                    if not saved:
                        # 没有保存任何规格：不记「无法生成」，空间腾出后还能自动补图。
                        raise ThumbnailRetry("存储空间已满，无法保存封面") from None
                    break
            if force:
                self.objects.finish_thumbnail_set(scope, info.key, saved)

    async def _decode(self, info, kind, scope, allow_remote):
        """经回环地址按范围读取原文件，由解码器生成：图片缩放原图、音频取内嵌封面、视频截取画面。"""
        self._plan(info, kind, *await self._dimensions(info, kind, allow_remote), remote=allow_remote)
        started = time.monotonic()
        async with _RangeInput(self.objects.engine, info, scope.authorize, cache_only=not allow_remote) as source:
            try:
                with tempfile.TemporaryDirectory(prefix="tessera-thumbnail-") as directory:
                    return await self._render(source, kind, Path(directory), scope.authorize)
            except WorkBusyError:
                raise ThumbnailRetry("文件读取名额繁忙，稍后再生成") from None
            finally:
                remote = source.remote_bytes if isinstance(source.remote_bytes, int) else 0
                self._remote_bytes += remote
                self._observe_rate(remote, time.monotonic() - started)

    async def _online_cover(self, info, scope):
        """文件助手生成封面的第二步：从管理员启用的媒体信息来源查找，取匹配度足够的第一张（与「获取封面、歌词与字幕」同一查询）。"""
        if self.media is None:
            return None
        try:
            data = await self.media.best_cover(scope, info.key)
        except (ValueError, NotFoundError):
            return None
        if data is None:
            return None
        try:
            return await self._render_picture(data, scope.authorize)
        except ThumbnailUnsuitable:
            return None

    @staticmethod
    def _remember(store, key, value):
        store[key] = value
        store.move_to_end(key)
        while len(store) > UNSUITABLE_LIMIT:
            store.popitem(last=False)

    def _memory_cap(self):
        """缩略图解码器最多可用的内存：至少 512 MiB，大内存服务器放宽到一半。超过它的文件在这台服务器上不生成。"""
        return max(512 * MIB, (self.resources.detected["memory_bytes"] or 0) // 2)

    def _reserve(self):
        """生成期间给服务其他部分留出的内存；小内存服务器按总量的八分之一。"""
        return min(MEMORY_RESERVE, (self.resources.detected["memory_bytes"] or 0) // 8) or MEMORY_RESERVE

    def _observe_rate(self, size, seconds):
        """记录从存储读取原文件的实际速度（含解码耗时），评估大图片能否在单次处理时限内读完。"""
        if size >= 8 * MIB and seconds >= 1:
            rate = size / seconds
            self._read_rate = rate if self._read_rate is None else (self._read_rate + rate) / 2

    def _known(self, info):
        """评估用的（尺寸, 每像素字节数）。图片以文件头为准（解码按未旋转的原始尺寸），没有读过时退回已记录的显示尺寸，
        每像素字节数记为 0：只按能确定的部分（文件大小、像素上限）评估，其余等任务读取文件头后再判断。"""
        probed = self._probed.get(info.blob_uuid)
        if probed:
            return probed[:2], probed[2]
        recorded = self.objects.media_sizes([info.blob_uuid]).get(info.blob_uuid)
        return recorded, 0 if recorded and source_kind(info) == "image" else None

    def _plan(self, info, kind, size, bpp=None, *, remote):
        """按这台服务器此刻的条件评估能否生成，返回估算的内存峰值，不设固定的文件大小门槛。
        超过解码器像素上限或本机内存上限抛 ThumbnailUnsuitable（自动流程不再尝试）；
        可用内存、临时目录空间不足或按最近读取速度读不完抛 ThumbnailRetry（稍后再试）。"""
        if size and (size[0] + 128) * (size[1] + 128) >= PIXEL_LIMIT:
            raise ThumbnailUnsuitable(f"画面 {size[0]}×{size[1]} 超过解码器的像素上限，不生成封面；可以改用本地图片或图片地址")
        need, cap = decode_estimate(kind, info.size, size, bpp), self._memory_cap()
        if need > cap:
            raise ThumbnailUnsuitable(f"生成预计需要约 {_size_text(need)} 内存，超过这台服务器允许封面使用的 {_size_text(cap)}，"
                                      "不生成封面；可以改用本地图片或图片地址")
        available = self.resources.available_memory()
        if available is not None and need > available - self._reserve():
            raise ThumbnailRetry(f"服务器当前可用内存约 {_size_text(available)}，生成预计需要约 {_size_text(need)}，稍后再试")
        try:
            free = shutil.disk_usage(tempfile.gettempdir()).free
        except OSError:
            free = None
        if free is not None and free < TEMP_RESERVE:
            raise ThumbnailRetry("服务器临时目录剩余空间不足，稍后再试")
        if kind == "image" and remote and self._read_rate and info.size > self.cache.per_blob:
            seconds = info.size / self._read_rate
            if seconds > TIMEOUT * 0.8:
                raise ThumbnailRetry(f"按最近的读取速度，读完整张图片约需 {math.ceil(seconds / 60)} 分钟，"
                                     f"超过单次处理上限 {TIMEOUT // 60} 分钟，稍后再试")
        return need

    async def _dimensions(self, info, kind, allow_remote):
        """评估用的（尺寸, 每像素字节数）。图片总是先读文件开头 512 KiB 解析头部（不解码画面）：生成本来就要读完整个文件，
        这点额外读取可以忽略；读不出时退回已记录的显示尺寸并按 4 字节／像素估算。视频、音频用已记录的尺寸。
        读到的结果只留在进程内供评估使用，不写入 blobs：文件头不含 EXIF 旋转，写进去会让预览按错误的方向布局。"""
        if kind != "image":
            return self._known(info)
        if info.blob_uuid in self._probed:
            return self._known(info)
        data = await self._read(info, 0, min(info.size, HEADER_BYTES), allow_remote)
        header = image_header(data)
        if header is None and data[:4] in (b"II*\x00", b"MM\x00*"):
            # TIFF 的首个目录可以放在文件末尾：只再读那一小段。
            order = "little" if data[:2] == b"II" else "big"
            offset = int.from_bytes(data[4:8], order)
            if len(data) <= offset < info.size:
                block = await self._read(info, offset, min(info.size, offset + 4096), allow_remote)
                header = image_header(data[:4] + (8).to_bytes(4, order) + block)
        if header is None:
            return self.objects.media_sizes([info.blob_uuid]).get(info.blob_uuid), None
        self._remember(self._probed, info.blob_uuid, header)
        return header[:2], header[2]

    async def _read(self, info, start, end, allow_remote):
        def charge(_ref, size):
            self._remote_bytes += size
        data = bytearray()
        async with aclosing(self.objects.engine.stream(info.blob_uuid, start, end, window=MIB, bucket_id=info.bucket_id,
                                                      cache_only=not allow_remote, background=True,
                                                      read_budget=None if not allow_remote else charge)) as source:
            async for piece in source:
                data.extend(piece)
        return bytes(data)

    async def _render(self, source, kind, directory, authorize):
        if kind != "video":
            images, _ = await self._render_frame(source, kind, directory, authorize)
            return images
        for index, position in enumerate(VIDEO_FRAME_TIMES):
            authorize()
            candidate = directory / str(index)
            candidate.mkdir()
            images, pixels = await self._render_frame(source, kind, candidate, authorize, position=position)
            if not images:  # 已到短视频结尾，无需继续跳到更远的位置。
                break
            if len(pixels) != VIDEO_SAMPLE_SIZE ** 2:
                raise ThumbnailError("未能检查视频画面")
            if video_frame_usable(pixels):
                return images
        # 不把片头黑屏、白屏或近乎纯色的画面固化为封面。
        return None

    async def _render_frame(self, source, kind, directory, authorize, *, position=0, protocols="http,tcp"):
        selector = "V:0" if kind == "video" else "v:0"
        filters = [f"[0:{selector}]split=4[t][g][p][q]" if kind == "video" else f"[0:{selector}]split=3[t][g][p]"]
        if kind == "video":
            filters.append(f"[q]scale={VIDEO_SAMPLE_SIZE}:{VIDEO_SAMPLE_SIZE}:out_range=full,format=gray[quality]")
        for label, variant, size in (("t", "thumb", 160), ("g", "grid", 640), ("p", "poster", 960)):
            filters.append(f"[{label}]scale=w='max(2,min({size},iw))':h='max(2,min({size},ih))':"
                           f"force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p[{variant}]")
        options = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                   "-threads", "1", "-filter_complex_threads", "1", "-protocol_whitelist", protocols,
                   "-format_whitelist", FORMATS]
        if position:
            options += ["-ss", str(position)]
        options += ["-i", source.url, "-filter_complex", ";".join(filters)]
        for variant in ("thumb", "grid", "poster"):
            options += ["-map", f"[{variant}]", "-an", "-sn", "-dn", "-frames:v", "1", "-threads", "1",
                        "-c:v", "mjpeg", "-q:v", "8", "-f", "image2", "-update", "1", str(directory / f"{variant}.jpg")]
        if kind == "video":
            options += ["-map", "[quality]", "-an", "-sn", "-dn", "-frames:v", "1", "-threads", "1",
                        "-c:v", "rawvideo", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"]
        # 原文件流式经过当前 Blob 的回环代理，拒绝媒体中的外部引用。
        env = {key: value for key, value in os.environ.items()
               if key.lower() not in ("http_proxy", "https_proxy", "all_proxy", "no_proxy")}
        env.update(http_proxy=source.origin, OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1")
        process = await asyncio.create_subprocess_exec(self.resources.ffmpeg, *options, env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE if kind == "video" else asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE)
        waiting = asyncio.create_task(process.wait())

        async def errors():
            output = bytearray()
            while piece := await process.stderr.read(4096):
                output.extend(piece[:max(0, 8192 - len(output))])
            return bytes(output)

        async def samples():
            output = bytearray()
            while piece := await process.stdout.read(4096):
                output.extend(piece[:max(0, VIDEO_SAMPLE_SIZE ** 2 - len(output))])
            return bytes(output)

        stderr = asyncio.create_task(errors())
        quality = asyncio.create_task(samples()) if kind == "video" else None
        # 按实际占用的物理内存（RSS）巡检，不用 RLIMIT_AS：FFmpeg 7 为每路输入、输出和滤镜各开线程，
        # 加上动态库映射，虚拟地址空间远大于实际用量，限制地址空间会让它在加载库或创建线程时直接失败。
        # 生成前已按估算评估过；这里按实际用量兜底：超过本机上限说明这个文件不适合这台服务器，
        # 服务器整体可用内存见底时先停下让出资源，稍后再试。
        memory, reserve = self._memory_cap(), self._reserve()
        try:
            while not waiting.done():
                authorize()
                if source.failure:
                    raise source.failure
                if self.resources.pressure():
                    raise ThumbnailRetry("服务器资源不足，稍后再生成")
                if _resident(process.pid) > memory:
                    raise ThumbnailUnsuitable(f"解码实际占用的内存超过这台服务器允许封面使用的 {_size_text(memory)}，"
                                              "已停止，不生成封面；可以改用本地图片或图片地址")
                available = self.resources.available_memory()
                if available is not None and available < reserve // 2:
                    raise ThumbnailRetry("服务器可用内存不足，已停止生成，稍后再试")
                await asyncio.wait({waiting}, timeout=0.25)
            output = await stderr
            if source.failure:
                raise source.failure
            if process.returncode:
                if kind == "audio" and b"matches no streams" in output:
                    return None, b""
                reason, detail = "decoder_error", "当前解码器未能生成封面"
                lowered = output.lower()
                environment = process.returncode < 0 or any(sign.lower() in lowered for sign in ENVIRONMENT_ERRORS)
                if environment:
                    reason, detail = "environment", "解码器运行环境受限，稍后再生成"
                else:
                    for code, signs, message in DECODER_ERRORS:
                        if any(sign in lowered for sign in signs):
                            reason, detail = code, message
                            break
                blob = getattr(getattr(source, "info", None), "blob_uuid", None)
                anonymous_id = hashlib.sha256(blob.encode()).hexdigest()[:12] if isinstance(blob, str) else "unknown"
                log.warning("缩略图解码失败：id=%s reason=%s returncode=%s", anonymous_id, reason, process.returncode)
                if environment:
                    # 被系统终止、线程或内存不足、缺少动态库都是运行环境的问题，不能据此把文件记为「无法生成」。
                    raise ThumbnailRetry(detail)
                raise ThumbnailError(detail)
            images = {}
            for variant, limit in self.objects.THUMBNAIL_LIMITS.items():
                path = directory / f"{variant}.jpg"
                if path.is_file() and 0 < path.stat().st_size <= limit:
                    images[variant] = path.read_bytes()
            if "thumb" not in images:
                if kind == "video" and position:
                    return None, b""
                raise ThumbnailError("未能提取画面或封面")
            # 缩小前尺寸未知时，FFmpeg 可能输出同样大小的图片；不重复保存同一张图。
            for variant in ("poster", "grid"):
                if images.get(variant) == images.get("grid" if variant == "poster" else "thumb"):
                    images.pop(variant, None)
            return images, (await quality if quality else b"")
        finally:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await asyncio.gather(waiting, stderr, *([quality] if quality else []), return_exceptions=True)
