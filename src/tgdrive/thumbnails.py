"""缩略图协作队列：自动任务复用已接收密文；用户可为任意文件上传自定义缩略图。"""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
import re
import secrets
import hashlib
import tempfile
import time
from collections import OrderedDict
from contextlib import aclosing
from dataclasses import dataclass
from pathlib import Path

from .errors import NotFoundError, NotReadyError, QuotaExceededError
from .filekinds import kind_clause, kind_of
from .objects import PRIVATE_PREFIX, ObjectInfo, Scope
from .thumbnail_cache import ThumbnailCache, ThumbnailCacheMiss


log = logging.getLogger("tgdrive.thumbnails")
MIB = 1024 * 1024
IMAGE_LIMIT = 60 * MIB
READ_LIMITS = {"image": IMAGE_LIMIT, "video": 64 * MIB, "audio": 32 * MIB}
TIMEOUT = 45
CLIENT_TIMEOUT = 90
# 网页预览图片／视频时浏览器手里已有解码好的画面，先等它生成；超时后后台再用同一批已接收的密文接管。
PREVIEW_GRACE = 30
# 缓存不足时只在收到新数据后重试，并逐次拉长间隔；多次仍不足就放弃，避免边播放边反复启动解码器。
MISS_LIMIT = 6
# 自动补图：上传或修改超过 BACKFILL_AGE 秒仍没有缩略图的文件（缓存已过期、复制或秒传、服务器重启等），
# 由后台按单文件预算从存储读取生成，保证最终都有缩略图。只产生存储到服务器的入站流量，每天总量受管理员设置限制。
BACKFILL_AGE = 600
BACKFILL_DEFAULT_MIB = 4096
BACKFILL_KEY, BACKFILL_USAGE_KEY = "thumbnails.backfill", "thumbnails.backfill_usage"
BACKFILL_RETRY = 6 * 3600
MAX_PIXELS = 40_000_000
VIDEO_PIXELS = 4096 * 2160
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
# 一次性清理：修复前运行环境问题会被误记为「无法生成」，升级后清掉这些记录让补图重新处理。
REPAIR_KEY = "thumbnails.repair"
# 自定义缩略图可以填写图片地址，由服务器经受控出站客户端读取后交给网页处理。
FETCH_LIMIT = 20 * MIB
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


class ThumbnailBudget(ThumbnailError):
    pass


class ThumbnailRetry(ThumbnailBudget):
    """暂时无法继续（服务器资源不足、已读分片缓存被回收），稍后可以再试，不能记为「无法生成」。"""


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
    if kind == "image":
        if info.size > IMAGE_LIMIT or info.key.lower().endswith(".svg") or "svg" in (info.content_type or "").lower():
            return None
    return kind if kind in READ_LIMITS else None


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

    def __init__(self, engine, info, authorize, budget, *, cache_only=False):
        self.engine, self.info, self.authorize = engine, info, authorize
        self.remaining, self.failure = budget, None
        self.remote_remaining, self.remote_bytes = None if budget is None else budget + MIB, 0
        self._fetched = set()
        self.cache_only = cache_only
        self.path = "/" + secrets.token_urlsafe(32)
        self.server = None
        self.tasks = set()
        self.slots = asyncio.Semaphore(2)

    def _charge(self, ref, size):
        # 用户手动选图不受自动生成额度约束；缓存已回收时允许重新取回所需分片。
        if self.remote_remaining is None:
            self.remote_bytes += size
            return
        if ref in self._fetched:
            raise ThumbnailRetry("已读分片缓存被回收，停止生成以避免重复下载")
        if size > self.remote_remaining:
            raise ThumbnailBudget("手动缩略图读取量超过预算")
        self.remote_remaining -= size
        self.remote_bytes += size
        self._fetched.add(ref)

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
                    # 分窗口流式交付，不为手动选图把完整视频放入内存。
                    stop = min(end, start + MIB)
                    if self.remaining is not None:
                        if stop - start > self.remaining:
                            raise ThumbnailBudget("缩略图读取量超过预算")
                        self.remaining -= stop - start
                    async with aclosing(self.engine.stream(self.info.blob_uuid, start, stop,
                                                          window=MIB, bucket_id=self.info.bucket_id,
                                                          cache_only=self.cache_only,
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


@dataclass
class _Lease:
    info: ObjectInfo
    token: str
    until: float


class ThumbnailService:
    """单并发协作队列。任务只来自写入、实际读取与用户手动请求；自动任务禁止回源，不扫描整库补图。"""

    def __init__(self, accounts, objects, resources):
        self.accounts, self.objects, self.resources = accounts, objects, resources
        self.metadata, self.keystore = objects.metadata, accounts.keystore
        self.cache = ThumbnailCache()
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
        self._backfill_cursor, self._backfill_at, self._backfill_skip, self._backfill_failures = (0, ""), 0.0, {}, {}

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
        if self._eligible(info):
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
            if job.remote and not job.backfill:
                previous.force, previous.remote, previous.backfill, previous.ready_at = True, True, False, 0
                if self._active is not previous:
                    previous.state, previous.detail = "queued", "用户请求重新生成"
            return True
        if len(self._pending) >= 128:
            # 缺图扫描可以重建自动任务；优先让出等待数据的名额给新上传与明确的手动请求。
            victim = next((key for key, item in self._pending.items() if (item.state == "waiting_data" or item.backfill) and key not in self._leases and item is not self._active), None)
            if victim is None:
                if job.remote and not job.backfill:
                    raise ValueError("缩略图队列已满，请稍后重试")
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

    def _cancel(self, job):
        blob = job.info.blob_uuid
        self._pending.pop(blob, None)
        self._leases.pop(blob, None)
        if self._active is job and self._task is not None:
            self._task.cancel()
        self._record(job, "cancelled", "文件已删除、移动、覆盖或账号不可用")
        self.cache.drop(blob)

    def claim(self, scope, key, etag, *, force=False, custom=False):
        self._expire_clients()
        info = self.objects.head_object(scope, key)
        self.objects._check_scope(scope, key, write=True)
        if info.etag != etag:
            raise ValueError("文件内容已变化，请刷新后重试")
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

    def _custom_claim(self, info):
        """用户指定的缩略图（上传图片、图片地址或播放器当前画面）适用于任何文件，优先于自动生成：
        取消这个 Blob 排队或进行中的自动任务并收回旧票据，不登记新任务；保存仍走带票据的普通写入。"""
        if info.key.endswith("/") or not info.blob_uuid:
            raise ValueError("只有文件可以设置缩略图")
        if info.key.startswith(".tgdrive/") and not info.key.startswith(PRIVATE_PREFIX):
            raise ValueError("系统文件不能设置缩略图")
        blob = info.blob_uuid
        job = self._pending.pop(blob, None)
        if job is not None:
            if self._active is job and self._task is not None:
                self._task.cancel()
            self._record(job, "cancelled", "用户设置了自定义缩略图")
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
                            raise ValueError("图片超过 20 MB，请换一张较小的图片")
                        pieces, size = [], 0
                        async for piece in response.stream():
                            size += len(piece)
                            if size > FETCH_LIMIT:
                                raise ValueError("图片超过 20 MB，请换一张较小的图片")
                            pieces.append(piece)
            except TimeoutError:
                raise ValueError("读取图片超时，请检查地址或稍后重试") from None
        data = b"".join(pieces)
        mime = image_mime(data)
        if mime is None:
            raise ValueError("地址返回的不是受支持的图片（JPEG、PNG、WebP、GIF、BMP 或 AVIF）")
        return data, mime

    def check_claim(self, info, token):
        lease = self._leases.get(info.blob_uuid)
        if lease is None or not secrets.compare_digest(lease.token, token) or lease.until <= time.monotonic() or (
                lease.info.bucket_id, lease.info.key, lease.info.etag) != (info.bucket_id, info.key, info.etag):
            raise ValueError("缩略图生成授权已失效，结果已丢弃")

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

    def request(self, scope, key, etag):
        self.objects._check_scope(scope, key, write=True)
        info = self.objects.head_object(scope, key)
        if info.etag != etag:
            raise ValueError("文件内容已变化，请刷新后重试")
        if not self._eligible(info):
            raise ValueError("此文件不支持生成缩略图")
        if not self.resources.ffmpeg:
            raise ValueError("服务器未安装 FFmpeg，无法执行手动生成")
        self._enqueue(_Job(info, force=True, remote=True, detail="用户请求生成"))
        return {"accepted": True}

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

    def backfill_limit(self):
        """每日自动补图的读取上限（字节）；0 表示关闭，None 表示不限制。"""
        value = self._setting(BACKFILL_KEY).get("daily_mib", BACKFILL_DEFAULT_MIB)
        if not isinstance(value, int) or isinstance(value, bool):
            value = BACKFILL_DEFAULT_MIB
        return None if value < 0 else value * MIB

    def configure_backfill(self, daily_mib):
        if isinstance(daily_mib, bool) or not isinstance(daily_mib, int) or daily_mib < -1 or daily_mib > 1024 * 1024:
            raise ValueError("每日读取上限必须是 0 到 1048576 MiB 之间的整数，-1 表示不限制")
        self._save_setting(BACKFILL_KEY, {"daily_mib": daily_mib})
        self._backfill_at = 0
        self._wake.set()
        return self.backfill_status()

    @staticmethod
    def _today():
        return datetime.date.today().isoformat()

    def _backfill_used(self):
        usage = self._setting(BACKFILL_USAGE_KEY)
        return int(usage.get("bytes", 0)) if usage.get("day") == self._today() else 0

    def _charge_backfill(self, size):
        if size > 0:
            self._save_setting(BACKFILL_USAGE_KEY, {"day": self._today(), "bytes": self._backfill_used() + size})

    def _backfill_room(self):
        limit = self.backfill_limit()
        return None if limit is None else max(0, limit - self._backfill_used())

    def backfill_status(self):
        limit = self.backfill_limit()
        return {"daily_bytes": limit, "used_bytes": self._backfill_used(), "age_seconds": BACKFILL_AGE,
                "pending": sum(1 for job in self._pending.values() if job.backfill)}

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
        """队列里没有更便宜的任务时补充最多 4 个补图任务；预算用完或扫描到末尾后暂停一段时间。"""
        if time.monotonic() < self._backfill_at or sum(1 for job in self._pending.values() if job.backfill) >= 4:
            return False
        room = self._backfill_room()
        if room is not None and room < 2 * MIB:
            self._backfill_at = time.monotonic() + 600
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
            if not self._eligible(info) or blob in self._pending or blob in self._leases or blob in self._backfill_skip:
                continue
            added = self._enqueue(_Job(info, remote=True, backfill=True, detail="自动补图：按预算读取存储")) or added
        return added

    def _repair(self):
        """升级后执行一次：清掉旧版因解码器运行环境受限而误记的「无法生成」，交给自动补图重新处理。"""
        if self._setting(REPAIR_KEY).get("version", 0) >= 1:
            return
        with self.metadata.transaction() as db:
            db.execute("DELETE FROM thumbnails WHERE variant='none'")
        self._save_setting(REPAIR_KEY, {"version": 1})

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
                 "state": job.state, "detail": job.detail, "manual": job.remote and not job.backfill, "backfill": job.backfill,
                 "wait_seconds": max(0, int(job.ready_at - time.monotonic()))} for blob, job in self._pending.items()]
        pressure = self.resources.pressure()
        return {"available": bool(self.resources.ffmpeg), "unlocked": self.keystore.unlocked,
                "pressure": pressure, "jobs": jobs, "recent": list(reversed(self._history.values())),
                "cache": self.cache.status(), "remote_bytes": self._remote_bytes,
                "client_timeout_seconds": CLIENT_TIMEOUT, "task_timeout_seconds": TIMEOUT,
                "automatic_remote_reads": False, "capacity": 128, "backfill": self.backfill_status(),
                "inline": self.objects.inline_thumbnails()}

    async def _run(self):
        while True:
            try:
                self._wake.clear()
                if self.keystore.unlocked and not self.resources.pressure():
                    self._expire_clients()
                    now = time.monotonic()
                    ready = (item for item in self._pending.values() if item.state == "queued" and item.ready_at <= now and item.info.blob_uuid not in self._leases)
                    # 明确的手动请求优先，其次是只用缓存的自动任务，最后才是需要读取存储的补图；同级先图片和音频。
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
                        budget = None
                        if job.backfill:
                            room = self._backfill_room()
                            budget = READ_LIMITS[source_kind(job.info)] if room is None else min(READ_LIMITS[source_kind(job.info)], room - MIB)
                            if budget < MIB:
                                # 今日补图额度用完：保留任务，明天或调高上限后继续。
                                job.ready_at, job.detail = now + 600, "今日自动补图读取量已用完"
                                self._backfill_at = now + 600
                                continue
                        job.state, job.detail = "running", "使用已接收缓存" if not job.remote else "优先使用缓存，必要时按预算回源"
                        job.revision = self.cache.revision(blob)
                        self._active = job
                        started_remote = job.remote
                        before = self._remote_bytes
                        self._task = asyncio.create_task(self.generate(job.info, force=job.force, allow_remote=job.remote, budget=budget, give_up=job.backfill))
                        try:
                            failure_detail = await self._task
                            self._pending.pop(blob, None)
                            if isinstance(failure_detail, str):
                                self._record(job, "failed", failure_detail)
                            else:
                                self._record(job, "done", "自动补图完成" if job.backfill else "缩略图处理完成")
                            self.cache.drop(blob)
                        except ThumbnailCacheMiss:
                            job.misses += 1
                            job.state, job.detail = "waiting_data", "已接收的数据还不够，等待继续播放或下载；不会自动回源"
                            if job.remote and not started_remote:
                                job.state, job.ready_at = "queued", 0
                            elif job.misses >= MISS_LIMIT:
                                self._pending.pop(blob, None)
                                self._record(job, "failed", "已接收的数据不足以生成，可在文件菜单更新缩略图")
                                self.cache.drop(blob)
                            elif self.cache.revision(blob) != job.revision:
                                job.state, job.ready_at = "queued", time.monotonic() + min(60, 2 << job.misses)
                        except asyncio.CancelledError:
                            if asyncio.current_task().cancelling():
                                raise
                        except Exception as exc:
                            self._pending.pop(blob, None)
                            if job.backfill and not isinstance(exc, (NotFoundError, PermissionError)):
                                # 超时、资源不足等暂时性失败：几小时后再试；连续 3 次仍失败就记为「无法生成」，不再消耗补图额度。
                                # 解码器确定无法处理的已在 generate 中记录；运行环境受限（ThumbnailRetry）只推迟，不计次数。
                                failures = self._backfill_failures.get(blob, 0) + (not isinstance(exc, ThumbnailRetry))
                                self._backfill_failures[blob] = failures
                                self._backfill_skip[blob] = time.monotonic() + BACKFILL_RETRY
                                if failures >= 3:
                                    try:
                                        await self.objects.set_thumbnail(self._scope(job.info, None), job.info.key, None, "none")
                                    except Exception:
                                        pass
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
                            if job.backfill:
                                self._charge_backfill(self._remote_bytes - before)
                        continue
                    if self._backfill_room() != 0 and await self._plan_backfill():
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

    async def generate(self, info: ObjectInfo, original: Scope | None = None, *, force=False, allow_remote=False,
                       budget=None, give_up=False) -> str | None:
        """生成并保存缩略图。give_up 用于自动补图：解码器确定无法处理或单文件预算不够时记为「无法生成」，
        以后不再自动重试（可通过文件助手的生成卡片重新请求）。
        返回固定失败说明表示已记录 none，成功或跳过返回 None。"""
        kind = source_kind(info)
        if not self._eligible(info) or not self.resources.ffmpeg:
            return
        scope = self._scope(info, None)
        self.cache.prepare(info.blob_uuid, info.key, info.content_type)
        if not force and self._has_thumbnail(info.blob_uuid):
            return
        async with asyncio.timeout(TIMEOUT):
            failure_detail = None
            async with _RangeInput(self.objects.engine, info, scope.authorize, budget or READ_LIMITS[kind], cache_only=not allow_remote) as source:
                try:
                    with tempfile.TemporaryDirectory(prefix="tessera-thumbnail-") as directory:
                        try:
                            images = await self._render(source, kind, Path(directory), scope.authorize)
                        except ThumbnailError as exc:
                            # 资源压力属于暂时失败；读取预算不够（只在没有缩小预算时）或解码失败才是确定的结果。
                            if not give_up or isinstance(exc, ThumbnailRetry) or isinstance(exc, ThumbnailBudget) and budget and budget < READ_LIMITS[kind]:
                                raise
                            failure_detail = str(exc)
                            images = None
                finally:
                    self._remote_bytes += source.remote_bytes if isinstance(source.remote_bytes, int) else 0
            scope.authorize()
            if not force and self._has_thumbnail(info.blob_uuid):
                return
            if images is None:
                failure_detail = failure_detail or ("候选画面均为空白或细节不足" if kind == "video"
                                                    else "音频没有可用的内嵌封面" if kind == "audio" else "未能提取图片画面")
                if force and kind == "video":
                    raise ThumbnailError(failure_detail + "，未替换现有缩略图")
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
                        raise ThumbnailRetry("存储空间已满，无法保存缩略图") from None
                    break
            if force:
                self.objects.finish_thumbnail_set(scope, info.key, saved)

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

    async def _render_frame(self, source, kind, directory, authorize, *, position=0):
        selector = "V:0" if kind == "video" else "v:0"
        filters = [f"[0:{selector}]split=4[t][g][p][q]" if kind == "video" else f"[0:{selector}]split=3[t][g][p]"]
        if kind == "video":
            filters.append(f"[q]scale={VIDEO_SAMPLE_SIZE}:{VIDEO_SAMPLE_SIZE}:out_range=full,format=gray[quality]")
        for label, variant, size in (("t", "thumb", 160), ("g", "grid", 640), ("p", "poster", 960)):
            filters.append(f"[{label}]scale=w='max(2,min({size},iw))':h='max(2,min({size},ih))':"
                           f"force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p[{variant}]")
        options = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-max_alloc", str(192 * MIB),
                   "-threads", "1", "-filter_complex_threads", "1", "-protocol_whitelist", "http,tcp",
                   "-format_whitelist", FORMATS, "-probesize", str(MIB), "-analyzeduration", "1000000",
                   "-max_pixels", str(VIDEO_PIXELS if kind == "video" else MAX_PIXELS)]
        if position:
            options += ["-ss", str(position)]
        options += ["-i", source.url, "-filter_complex", ";".join(filters)]
        for variant in ("thumb", "grid", "poster"):
            options += ["-map", f"[{variant}]", "-an", "-sn", "-dn", "-frames:v", "1", "-threads", "1",
                        "-c:v", "mjpeg", "-q:v", "8", "-f", "image2", "-update", "1", str(directory / f"{variant}.jpg")]
        if kind == "video":
            options += ["-map", "[quality]", "-an", "-sn", "-dn", "-frames:v", "1", "-threads", "1",
                        "-c:v", "rawvideo", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"]
        # 强制 HTTP 经仅服务当前文件的本地代理，清掉宿主机代理配置，拒绝媒体中的外部引用。
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
        memory = min(512 * MIB, max(192 * MIB, (self.resources.detected["memory_bytes"] or 1536 * MIB) // 3))
        try:
            while not waiting.done():
                authorize()
                if source.failure:
                    raise source.failure
                if self.resources.pressure():
                    raise ThumbnailRetry("服务器资源不足，稍后再生成")
                if _resident(process.pid) > memory:
                    raise ThumbnailRetry("解码所需内存超过上限，稍后再生成")
                await asyncio.wait({waiting}, timeout=0.25)
            output = await stderr
            if source.failure:
                raise source.failure
            if process.returncode:
                if kind == "audio" and b"matches no streams" in output:
                    return None, b""
                reason, detail = "decoder_error", "当前解码器未能生成缩略图"
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
