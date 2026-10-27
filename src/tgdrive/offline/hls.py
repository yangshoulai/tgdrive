"""受控获取 HLS 点播；通过管道或任务内回环连接向 FFmpeg 提供媒体。"""

from __future__ import annotations

import asyncio
import math
import os
import re
import secrets
from dataclasses import dataclass, field
from urllib.parse import urljoin

from .http import DownloadError, ExpiredMedia, SafeHttpClient, status_error
from .request import DownloadRequest, checked_url


@dataclass(frozen=True)
class Key:
    url: str
    iv: str | None = None


@dataclass(frozen=True)
class Asset:
    url: str
    byte_range: tuple[int, int] | None = None  # 起点、长度
    key: Key | None = None


@dataclass(frozen=True)
class Segment:
    asset: Asset
    duration: float
    init: Asset | None = None
    discontinuity: bool = False


@dataclass(frozen=True)
class Playlist:
    variants: list[tuple[str, str]]
    segments: list[tuple[str, float]]
    items: list[Segment] = field(default_factory=list)
    audio: dict[str, str] = field(default_factory=dict)
    sequence: int = 0

    @property
    def duration(self):
        return sum(duration for _, duration in self.segments)


def attributes(value: str) -> dict[str, str]:
    return {match[1]: match[2].strip('"') for match in re.finditer(r'([A-Z0-9-]+)=("[^"\r\n]*"|[^,]*)', value)}


def byte_range(value, url, previous):
    match = re.fullmatch(r"([0-9]+)(?:@([0-9]+))?", value)
    if not match:
        raise DownloadError("M3U8 字节范围不正确")
    length = int(match[1])
    if match[2] is not None:
        offset = int(match[2])
    elif previous and previous[0] == url:
        offset = previous[1]
    else:
        raise DownloadError("M3U8 隐式字节范围缺少同一资源的前一个范围")
    if length <= 0 or offset + length >= 2**63:
        raise DownloadError("M3U8 字节范围不正确")
    return offset, length


def parse_playlist(data: bytes, base_url: str) -> Playlist:
    try:
        lines = [line.strip() for line in data.decode("utf-8-sig").splitlines() if line.strip()]
    except UnicodeError as exc:
        raise DownloadError("M3U8 播放列表必须是 UTF-8 文本") from exc
    if not lines or lines[0] != "#EXTM3U":
        raise DownloadError("来源不是有效的 M3U8 播放列表")
    variants, segments, items, audio_groups, variant_audio = [], [], [], {}, {}
    duration, pending, key, init, range_text, previous, previous_map = (None,) * 7
    discontinuity, sequence = False, 0
    ended = False
    for line in lines[1:]:
        if line.startswith("#EXT-X-STREAM-INF:"):
            pending = attributes(line.split(":", 1)[1])
            if "VIDEO" in pending:
                raise DownloadError("暂不支持外置视频组的 M3U8")
            codecs = pending.get("CODECS", "")
            if codecs and any(not codec.strip().startswith(("avc1", "avc3", "mp4a.40.")) for codec in codecs.split(",")):
                raise DownloadError("M3U8 仅支持 H.264 视频和 AAC 音频")
        elif line.startswith("#EXT-X-MEDIA:"):
            values = attributes(line.split(":", 1)[1])
            if values.get("TYPE") == "AUDIO" and values.get("URI"):
                group = values.get("GROUP-ID", "")
                if group not in audio_groups or values.get("DEFAULT") == "YES":
                    audio_groups[group] = checked_url(urljoin(base_url, values["URI"]))
        elif line.startswith(("#EXT-X-KEY:", "#EXT-X-SESSION-KEY:")):
            values = attributes(line.split(":", 1)[1])
            method = values.get("METHOD")
            if method == "NONE":
                key = None
            elif method == "AES-128" and values.get("KEYFORMAT", "identity") == "identity" and values.get("URI"):
                iv = values.get("IV")
                if iv is not None:
                    if not re.fullmatch(r"0[xX][0-9a-fA-F]{1,32}", iv):
                        raise DownloadError("M3U8 AES 初始向量不正确")
                    iv = "0x" + iv[2:].zfill(32)
                key = Key(checked_url(urljoin(base_url, values["URI"])), iv)
            else:
                raise DownloadError("暂不支持 DRM 或 SAMPLE-AES 的 M3U8；仅支持普通 AES-128")
        elif line.startswith("#EXT-X-MAP:"):
            values = attributes(line.split(":", 1)[1])
            if not values.get("URI"):
                raise DownloadError("M3U8 初始化分片缺少地址")
            url = checked_url(urljoin(base_url, values["URI"]))
            span = byte_range(values["BYTERANGE"], url, previous_map) if "BYTERANGE" in values else None
            previous_map = (url, sum(span)) if span else None
            if key and key.iv is None:
                raise DownloadError("AES-128 初始化分片必须指定 IV")
            init = Asset(url, span, key)
        elif line.startswith("#EXT-X-BYTERANGE:"):
            range_text = line.split(":", 1)[1]
        elif line == "#EXT-X-DISCONTINUITY":
            discontinuity = True
        elif line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            value = line.split(":", 1)[1]
            if items or not re.fullmatch(r"[0-9]{1,20}", value):
                raise DownloadError("M3U8 媒体序号不正确")
            sequence = int(value)
        elif line.startswith("#EXT-X-DISCONTINUITY-SEQUENCE:"):
            # 这是之前的时间线序号，并不表示本列表里发生了跳变。
            if not re.fullmatch(r"[0-9]+", line.split(":", 1)[1]):
                raise DownloadError("M3U8 时间线序号不正确")
        elif line.startswith(("#EXT-X-GAP", "#EXT-X-DEFINE", "#EXT-X-PART:", "#EXT-X-PRELOAD", "#EXT-X-I-FRAMES-ONLY")):
            raise DownloadError("暂不支持缺失分片、变量替换或低延迟直播的 M3U8")
        elif line == "#EXT-X-ENDLIST":
            ended = True
        elif line.startswith("#EXTINF:"):
            try:
                duration = float(line.split(":", 1)[1].split(",", 1)[0])
                if not math.isfinite(duration) or not 0 < duration <= 3600:
                    raise ValueError()
            except ValueError as exc:
                raise DownloadError("M3U8 分片时长不正确") from exc
        elif not line.startswith("#"):
            url = checked_url(urljoin(base_url, line))
            if pending is not None:
                resolution = pending.get("RESOLUTION", "")
                label = resolution if re.fullmatch(r"[0-9]{1,5}x[0-9]{1,5}", resolution) else "视频"
                try:
                    bandwidth = int(pending.get("AVERAGE-BANDWIDTH", pending.get("BANDWIDTH", "0")))
                    if bandwidth > 0:
                        label += f" · {bandwidth / 1000000:.1f} Mbps"
                except ValueError:
                    pass
                variants.append((url, label))
                if "AUDIO" in pending:
                    variant_audio[url] = pending["AUDIO"]
                if len(variants) > 32:
                    raise DownloadError("M3U8 清晰度选项超过 32 个")
                pending = None
            elif duration is not None:
                segments.append((url, duration))
                span = byte_range(range_text, url, previous) if range_text is not None else None
                previous = (url, sum(span)) if span else None
                items.append(Segment(Asset(url, span, key), duration, init, discontinuity))
                range_text, discontinuity = None, False
                if len(segments) > 20000:
                    raise DownloadError("M3U8 分片超过 20000 个")
                duration = None
            else:
                raise DownloadError("M3U8 中存在缺少时长或清晰度说明的链接")
    if pending is not None or duration is not None or range_text is not None or (variants and segments):
        raise DownloadError("M3U8 播放列表不完整")
    if variants:
        if len(variants) > 32:
            raise DownloadError("M3U8 清晰度选项超过 32 个")
    elif not segments or not ended:
        raise DownloadError("仅支持已经结束的 M3U8 点播视频，暂不支持直播")
    if len(segments) > 20000:
        raise DownloadError("M3U8 分片超过 20000 个")
    return Playlist(variants, segments, items,
                    {url: audio_groups[group] for url, group in variant_audio.items() if group in audio_groups}, sequence)


async def load_playlist(client: SafeHttpClient, request: DownloadRequest, *, url_check=None):
    if request.method != "GET":
        raise DownloadError("M3U8 只支持 GET 请求")
    headers = playback_headers(request) if url_check else {}
    async with client.open(request, identity=True, url_check=url_check, extra_headers=headers) as response:
        if url_check and response.status in (401, 403, 404, 410):
            raise ExpiredMedia(f"平台播放列表不可访问（HTTP {response.status}），需要重新解析")
        if response.status != 200:
            raise status_error(response.status, f"读取 M3U8 失败（HTTP {response.status}）")
        return parse_playlist(await response.read(), response.url)


def playback_headers(request):
    """仅平台 CDN 间保留播放头，登录 Cookie 与认证头仍按来源隔离。"""
    return {key: value for key, value in request.headers if key.lower() in ("user-agent", "referer", "origin", "accept")}


async def _pipe_remux(client: SafeHttpClient, request: DownloadRequest, playlist: Playlist,
                executable: str, *, check, progress, throttle, url_check=None):
    """FFmpeg 只读取本地管道；不把用户 URL、命令或请求头交给它。

    delay_moov 不能省：TS 里的 AAC 带 ADTS 头，解码配置要等 aac_adtstoasc 处理第一个音频包才生成；
    empty_moov 会在此之前写出 moov，音轨缺少 AudioSpecificConfig，Safari／iOS 识别不了音轨，只播放第一个分片（约 2 秒）。
    """
    process = await asyncio.create_subprocess_exec(
        executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
        "-protocol_whitelist", "pipe", "-probesize", "1048576", "-analyzeduration", "2000000",
        "-f", "mpegts", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a:0?",
        "-c", "copy", "-tag:v", "avc1", "-bsf:a", "aac_adtstoasc", "-threads", "1",
        "-max_muxing_queue_size", "64", "-avoid_negative_ts", "make_zero",
        "-movflags", "empty_moov+delay_moov+frag_keyframe+default_base_moof", "-frag_duration", "2000000",
        "-f", "mp4", "pipe:1", stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=131072,
    )

    async def feed():
        try:
            for index, (url, duration) in enumerate(playlist.segments):
                check()
                async with client.open(request, url=url, method="GET", identity=True, url_check=url_check,
                                       extra_headers=playback_headers(request) if url_check else {}) as response:
                    if url_check and response.status in (401, 403, 404, 410):
                        raise ExpiredMedia(f"平台视频分片不可访问（HTTP {response.status}），需要重新解析")
                    if response.status != 200:
                        raise status_error(response.status, f"读取视频分片失败（HTTP {response.status}）")
                    prefix, validated = b"", False
                    async for piece in response.stream():
                        check()
                        await throttle(len(piece))
                        # 强制 TS 输入，拒绝 fMP4 或把网页误当成视频；不保存整个分片。
                        if not validated:
                            prefix += piece
                            if len(prefix) < 377:
                                continue
                            if prefix[0] != 0x47 or prefix[188] != 0x47 or prefix[376] != 0x47:
                                raise DownloadError("视频分片不是支持的 MPEG-TS 格式")
                            piece, prefix, validated = prefix, b"", True
                        process.stdin.write(piece)
                        async with asyncio.timeout(120):
                            await process.stdin.drain()
                        progress(bytes_in=len(piece))
                    if not validated:
                        raise DownloadError("视频分片不完整")
                    progress(segment=index + 1, seconds=duration)
            process.stdin.close()
        except BaseException:
            if process.returncode is None:
                process.kill()
            raise

    async def discard_stderr():
        # 持续排空，不能把外部媒体元信息写入错误日志，也不能无限攒在内存里。
        while await process.stderr.read(65536):
            pass

    feeder, stderr = asyncio.create_task(feed()), asyncio.create_task(discard_stderr())
    try:
        while True:
            check()
            async with asyncio.timeout(120):
                piece = await process.stdout.read(65536)
            if not piece:
                break
            yield piece
        await feeder
        if await process.wait() != 0:
            raise DownloadError("视频封装失败：请检查分片完整性与 H.264／AAC 编码")
    except (BrokenPipeError, ConnectionResetError, TimeoutError) as exc:
        raise DownloadError("视频封装中断或超时，可以重新下载") from exc
    finally:
        if process.returncode is None:
            process.kill()
        feeder.cancel()
        await asyncio.gather(feeder, return_exceptions=True)
        await process.wait()
        await stderr


class _RelayClosed(Exception):
    """本机接收端提前关闭；与可重试的来源连接故障区分。"""


class _HlsRelay:
    """仅向本次 FFmpeg 暴露已登记资源；源站请求仍经 SafeHttpClient，媒体逐块转发、不落盘。"""

    def __init__(self, client, *, check, progress, throttle, url_check, phase):
        self.client, self.check, self.progress = client, check, progress
        self.throttle, self.url_check, self.phase = throttle, url_check, phase
        self.prefix = "/" + secrets.token_urlsafe(24) + "/"
        self.routes, self.playlists, self.keys, self.pending = {}, {}, {}, {}
        self.completed, self.handlers = 0, set()
        self.error = self.process = None

    async def __aenter__(self):
        self.server = await asyncio.start_server(self.serve, "127.0.0.1", 0, limit=8192)
        self.origin = f"http://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"
        return self

    async def __aexit__(self, *_):
        self.server.close()
        handlers = list(self.handlers)
        for task in handlers:
            task.cancel()
        await asyncio.gather(*handlers, return_exceptions=True)
        await self.server.wait_closed()

    def asset(self, source, asset, extension):
        path = f"{self.prefix}media-{len(self.routes)}.{extension}"
        self.routes[path] = source, asset, extension
        return path

    def playlist(self, source, parsed, name, audio_track=False):
        if parsed.variants or not parsed.items:
            raise DownloadError("M3U8 子列表必须是具体的点播媒体列表")
        lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-PLAYLIST-TYPE:VOD",
                 f"#EXT-X-TARGETDURATION:{math.ceil(max(item.duration for item in parsed.items))}",
                 f"#EXT-X-MEDIA-SEQUENCE:{parsed.sequence}"]
        active_key, active_init, keys = None, None, {}

        def key_line(key):
            if key is None:
                return "#EXT-X-KEY:METHOD=NONE"
            if key.url not in keys:
                keys[key.url] = self.asset(source, Asset(key.url), "key")
            line = f'#EXT-X-KEY:METHOD=AES-128,URI="{keys[key.url]}"'
            return line + (f",IV={key.iv}" if key.iv else "")

        for item in parsed.items:
            if item.discontinuity:
                lines.append("#EXT-X-DISCONTINUITY")
            if item.init and item.init != active_init:
                if item.init.key != active_key:
                    lines.append(key_line(item.init.key))
                    active_key = item.init.key
                local = self.asset(source, item.init, "mp4")
                lines.append(f'#EXT-X-MAP:URI="{local}"')
                active_init = item.init
            if item.asset.key != active_key:
                lines.append(key_line(item.asset.key))
                active_key = item.asset.key
            local = self.asset(source, item.asset, "m4s" if item.init else "ts")
            lines.extend((f"#EXTINF:{item.duration:.6f},", local))
            self.pending[local] = 0 if audio_track else item.duration
        lines.append("#EXT-X-ENDLIST")
        path = self.prefix + name
        self.playlists[path] = ("\n".join(lines) + "\n").encode()
        return self.origin + path

    async def head(self, writer, status=200, size=None):
        headers = f"HTTP/1.1 {status} Reply\r\nConnection: close\r\nAccept-Ranges: none\r\n"
        if size is not None:
            headers += f"Content-Length: {size}\r\n"
        await self.write(writer, (headers + "\r\n").encode("ascii"))

    async def write(self, writer, data):
        try:
            writer.write(data)
            async with asyncio.timeout(120):
                await writer.drain()
        except (BrokenPipeError, ConnectionResetError) as exc:
            # 在受控 HTTP 上下文内也要保留区别，避免把 FFmpeg 的探测断连归类为来源故障。
            raise _RelayClosed() from exc
        except TimeoutError as exc:
            raise DownloadError("视频封装中断或超时，可以重新下载") from exc

    async def send_asset(self, path, writer):
        if path in self.keys:
            await self.head(writer, size=16)
            await self.write(writer, self.keys[path])
            return
        source, asset, extension = self.routes[path]
        headers = playback_headers(source) if self.url_check else {}
        if asset.byte_range:
            offset, length = asset.byte_range
            headers["Range"] = f"bytes={offset}-{offset + length - 1}"
        async with self.client.open(source, url=asset.url, method="GET", identity=True,
                                    extra_headers=headers, url_check=self.url_check) as response:
            if self.url_check and response.status in (401, 403, 404, 410):
                raise ExpiredMedia(f"平台视频分片不可访问（HTTP {response.status}），需要重新解析")
            if asset.byte_range:
                if response.status in (408, 425, 429, 500, 502, 503, 504):
                    raise status_error(response.status, f"读取视频资源失败（HTTP {response.status}）")
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("content-range", ""))
                if response.status != 206 or not match or (int(match[1]), int(match[2])) != (offset, offset + length - 1) or int(match[3]) < offset + length:
                    raise DownloadError("M3U8 来源未返回所请求的字节范围")
                expected = length
            else:
                if response.status != 200:
                    raise status_error(response.status, f"读取视频资源失败（HTTP {response.status}）")
                expected = response.size
            if extension != "key":
                await self.head(writer, size=expected)
            size, key = 0, b""
            async for piece in response.stream():
                self.check()
                size += len(piece)
                if extension == "key" and size > 16:
                    raise DownloadError("M3U8 AES-128 密钥必须为 16 字节")
                if expected is not None and size > expected:
                    raise DownloadError("M3U8 视频资源长度不正确")
                await self.throttle(len(piece))
                self.progress(bytes_in=len(piece))
                if extension == "key":
                    key += piece
                else:
                    # 背压贯穿源站、FFmpeg 与加密上传；不会缓存整个分片或整个视频。
                    await self.write(writer, piece)
            if not size or expected is not None and size != expected:
                raise DownloadError("M3U8 视频资源不完整")
            if extension == "key":
                if size != 16:
                    raise DownloadError("M3U8 AES-128 密钥必须为 16 字节")
                self.keys[path] = key
                await self.head(writer, size=16)
                await self.write(writer, key)
        if path in self.pending:
            duration = self.pending.pop(path)
            self.completed += 1
            self.progress(segment=self.completed, seconds=duration)
            if not self.pending and self.phase:
                self.phase("merging")

    async def serve(self, reader, writer):
        task = asyncio.current_task()
        self.handlers.add(task)
        try:
            try:
                async with asyncio.timeout(10):
                    header = await reader.readuntil(b"\r\n\r\n")
                method, path, _ = header.split(b"\r\n", 1)[0].decode("ascii").split(" ")
            except (ValueError, UnicodeError, TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
                await self.head(writer, 400, 0)
                return
            if method != "GET" or path not in self.playlists and path not in self.routes:
                await self.head(writer, 404, 0)
                return
            self.check()
            if path in self.playlists:
                await self.head(writer, size=len(self.playlists[path]))
                await self.write(writer, self.playlists[path])
            else:
                await self.send_asset(path, writer)
        except (_RelayClosed, BrokenPipeError, ConnectionResetError):
            # FFmpeg 探测后可能提前关闭连接；再次读取仍走同一个受控资源。
            pass
        except Exception as exc:
            if self.error is None:
                self.error = exc
            # HLS 解复用器会跳过失败分片，必须中止进程，避免把缺失片段的成品标为成功。
            if self.process is not None and self.process.returncode is None:
                self.process.kill()
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
            finally:
                self.handlers.discard(task)


async def remux(client: SafeHttpClient, request: DownloadRequest, playlist: Playlist,
                executable: str, *, check, progress, throttle, audio=None,
                media_type="video", url_check=None, phase=None):
    """连续 TS 走管道；复杂 HLS 只向 FFmpeg 提供重写后的回环地址，按需读取、不缓存输入。"""
    special = audio is not None or media_type == "audio" or any(
        item.init or item.asset.key or item.asset.byte_range or item.discontinuity for item in playlist.items)
    if not special:
        stream = _pipe_remux(client, request, playlist, executable,
                             check=check, progress=progress, throttle=throttle, url_check=url_check)
        try:
            async for piece in stream:
                yield piece
        finally:
            await stream.aclose()
        return
    async with _HlsRelay(client, check=check, progress=progress, throttle=throttle,
                         url_check=url_check, phase=phase) as relay:
        primary = relay.playlist(request, playlist, "video.m3u8")
        secondary = relay.playlist(*audio, "audio.m3u8", True) if audio else None
        inputs = []
        for path in ([primary, secondary] if secondary else [primary]):
            # 只有外层 HLS 能连接回环服务；分片解复用器仅接受支持的媒体格式，不自行打开网络或文件。
            inputs.extend(("-protocol_whitelist", "http,tcp,crypto", "-allowed_extensions", "ALL",
                           "-seg_format_options", "format_whitelist=mpegts,mov,aac:protocol_whitelist=pipe",
                           "-http_persistent", "0", "-http_multiple", "0", "-http_seekable", "0",
                           "-rw_timeout", "120000000", "-f", "hls", "-i", path))
        mapping = ["-map", "0:a:0", "-vn"] if media_type == "audio" else ["-map", "0:v:0", "-map", "1:a:0" if secondary else "0:a:0?"]
        process = await asyncio.create_subprocess_exec(executable,
            "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-max_alloc", "33554432",
            *inputs, *mapping, "-c", "copy", "-tag:v", "avc1", "-bsf:a", "aac_adtstoasc", "-threads", "1", "-max_muxing_queue_size", "64",
            "-avoid_negative_ts", "make_zero", "-movflags", "empty_moov+delay_moov+frag_keyframe+default_base_moof",
            "-frag_duration", "2000000", "-f", "mp4", "pipe:1",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=131072,
            env={key: value for key, value in os.environ.items() if key.lower() not in ("http_proxy", "https_proxy", "all_proxy")})
        relay.process = process
        async def discard_errors():
            while await process.stderr.read(65536):
                pass
        stderr = asyncio.create_task(discard_errors())
        size = 0
        try:
            while True:
                check()
                if relay.error is not None:
                    raise relay.error
                async with asyncio.timeout(120):
                    piece = await process.stdout.read(65536)
                if not piece:
                    break
                size += len(piece)
                yield piece
            code = await process.wait()
            if code == 0:
                # FFmpeg 收到 Content-Length 指定的字节后就能结束，来源连接的清理可能还在进行。
                async with asyncio.timeout(120):
                    await asyncio.gather(*list(relay.handlers))
            if relay.error is not None:
                raise relay.error
            if code != 0 or not size or relay.pending:
                raise DownloadError("M3U8 封装失败，请检查分片完整性与 H.264／AAC 编码")
            if phase:
                phase("saving")
        except (BrokenPipeError, ConnectionResetError, TimeoutError) as exc:
            raise DownloadError("视频封装中断或超时，可以重新下载") from exc
        finally:
            if process.returncode is None:
                process.kill()
            # 取消时 stdout 可能已因背压暂停；先排空被终止进程的管道，避免 wait 等待管道关闭而挂起。
            while await process.stdout.read(65536):
                pass
            await process.wait()
            await stderr
