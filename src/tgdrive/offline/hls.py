"""受控获取 HLS 点播；FFmpeg 只读取重写后的本地列表和媒体。"""

from __future__ import annotations

import asyncio
import math
import os
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urljoin

from .http import DownloadError, ExpiredMedia, SafeHttpClient, status_error
from .mp4 import with_duration
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
    """FFmpeg 只读取本地管道；不把用户 URL、命令或请求头交给它。"""
    process = await asyncio.create_subprocess_exec(
        executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
        "-protocol_whitelist", "pipe", "-probesize", "1048576", "-analyzeduration", "2000000",
        "-f", "mpegts", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a:0?",
        "-c", "copy", "-tag:v", "avc1", "-bsf:a", "aac_adtstoasc", "-threads", "1",
        "-max_muxing_queue_size", "64", "-avoid_negative_ts", "make_zero",
        "-movflags", "empty_moov+frag_keyframe+default_base_moof", "-frag_duration", "2000000",
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


def remux(client: SafeHttpClient, request: DownloadRequest, playlist: Playlist, executable: str, **options):
    """封装为分片 MP4，并按列表的总时长补写文件头（管道输出时 FFmpeg 写不了时长，浏览器会把视频当成只有几秒）。"""
    return with_duration(_remux(client, request, playlist, executable, **options), playlist.duration)


async def _remux(client: SafeHttpClient, request: DownloadRequest, playlist: Playlist,
                executable: str, *, check, progress, throttle, cache_root: Path | None = None,
                task_id=0, limit=None, reserve=0, audio=None, media_type="video", url_check=None, phase=None):
    """普通 TS 保持管道传输；复杂列表缓存受控分片，并生成不含外部 URI 的本地 HLS。

    不将原始列表交给 FFmpeg，避免其绕过 SafeHttpClient 请求分片、密钥或初始化文件。
    """
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
    if cache_root is None:
        raise DownloadError("此 M3U8 格式需要配置受控临时目录")
    cache_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if cache_root.is_symlink():
        raise DownloadError("离线临时目录不能是符号链接")
    with tempfile.TemporaryDirectory(prefix=f"task-{task_id}-", dir=cache_root) as directory:
        root = Path(directory)
        files, keys, received, completed = {}, {}, 0, 0

        async def save(source, asset, extension):
            nonlocal received
            identity = (source.url, asset)
            if identity in files:
                return files[identity]
            name = f"media-{len(files)}.{extension}"
            headers = playback_headers(source) if url_check else {}
            if asset.byte_range:
                offset, length = asset.byte_range
                headers["Range"] = f"bytes={offset}-{offset + length - 1}"
            check()
            async with client.open(source, url=asset.url, method="GET", identity=True,
                                   extra_headers=headers, url_check=url_check) as response:
                if url_check and response.status in (401, 403, 404, 410):
                    raise ExpiredMedia(f"平台视频分片不可访问（HTTP {response.status}），需要重新解析")
                if response.status in (408, 425, 429, 500, 502, 503, 504):
                    raise status_error(response.status, f"读取视频资源失败（HTTP {response.status}）")
                if asset.byte_range:
                    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("content-range", ""))
                    if response.status != 206 or not match or (int(match[1]), int(match[2])) != (offset, offset + length - 1) or int(match[3]) < offset + length:
                        raise DownloadError("M3U8 来源未返回所请求的字节范围")
                elif response.status != 200:
                    raise status_error(response.status, f"读取视频资源失败（HTTP {response.status}）")
                maximum = 16 if extension == "key" else limit
                size = 0
                with (root / name).open("wb") as output:
                    os.chmod(root / name, 0o600)
                    async for piece in response.stream():
                        check()
                        size += len(piece)
                        received += len(piece)
                        if maximum is not None and size > maximum or limit is not None and received > limit:
                            raise DownloadError("视频资源超过临时缓存大小上限，请调整资源设置或选择更低清晰度")
                        if asset.byte_range and size > length:
                            raise DownloadError("M3U8 字节范围响应长度不正确")
                        # 输入缓存与加密成品同时占盘，按已接收输入预留成品空间。
                        if shutil.disk_usage(root).free < reserve + received + len(piece) + 32 * 1024 * 1024:
                            raise DownloadError("视频临时磁盘空间不足，请释放空间后重试")
                        await throttle(len(piece))
                        await asyncio.to_thread(output.write, piece)
                        progress(bytes_in=len(piece))
                if not size or asset.byte_range and size != length:
                    raise DownloadError("M3U8 视频资源不完整")
                if extension == "key" and size != 16:
                    raise DownloadError("M3U8 AES-128 密钥必须为 16 字节")
            files[identity] = name
            return name

        async def key_line(source, key):
            if key is None:
                return "#EXT-X-KEY:METHOD=NONE"
            if (source.url, key.url) not in keys:
                keys[(source.url, key.url)] = await save(source, Asset(key.url), "key")
            line = f'#EXT-X-KEY:METHOD=AES-128,URI="{keys[(source.url, key.url)]}"'
            return line + (f",IV={key.iv}" if key.iv else "")

        async def local_playlist(source, parsed, name, audio_track=False):
            nonlocal completed
            if parsed.variants or not parsed.items:
                raise DownloadError("M3U8 子列表必须是具体的点播媒体列表")
            lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-PLAYLIST-TYPE:VOD",
                     f"#EXT-X-TARGETDURATION:{math.ceil(max(item.duration for item in parsed.items))}",
                     f"#EXT-X-MEDIA-SEQUENCE:{parsed.sequence}"]
            active_key, active_init = None, None
            for item in parsed.items:
                if item.discontinuity:
                    lines.append("#EXT-X-DISCONTINUITY")
                if item.init and item.init != active_init:
                    if item.init.key != active_key:
                        lines.append(await key_line(source, item.init.key))
                        active_key = item.init.key
                    local = await save(source, item.init, "mp4")
                    lines.append(f'#EXT-X-MAP:URI="{local}"')
                    active_init = item.init
                if item.asset.key != active_key:
                    lines.append(await key_line(source, item.asset.key))
                    active_key = item.asset.key
                local = await save(source, item.asset, "m4s" if item.init else "ts")
                lines.extend((f"#EXTINF:{item.duration:.6f},", local))
                completed += 1
                # 独立音轨与视频时间重叠，播放时长只按主轨累加。
                progress(segment=completed, seconds=0 if audio_track else item.duration)
            lines.append("#EXT-X-ENDLIST")
            (root / name).write_text("\n".join(lines) + "\n", encoding="utf-8")
            os.chmod(root / name, 0o600)
            return root / name

        primary = await local_playlist(request, playlist, "video.m3u8")
        secondary = await local_playlist(*audio, "audio.m3u8", True) if audio else None
        if phase:
            phase("merging")
        inputs = []
        for path in ([primary, secondary] if secondary else [primary]):
            inputs.extend(("-protocol_whitelist", "file,crypto", "-allowed_extensions", "ALL",
                           "-f", "hls", "-i", str(path)))
        mapping = ["-map", "0:a:0", "-vn"] if media_type == "audio" else ["-map", "0:v:0", "-map", "1:a:0" if secondary else "0:a:0?"]
        process = await asyncio.create_subprocess_exec(executable,
            "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-max_alloc", "33554432",
            *inputs, *mapping, "-c", "copy", "-tag:v", "avc1", "-bsf:a", "aac_adtstoasc", "-threads", "1", "-max_muxing_queue_size", "64",
            "-avoid_negative_ts", "make_zero", "-movflags", "empty_moov+frag_keyframe+default_base_moof",
            "-frag_duration", "2000000", "-f", "mp4", "pipe:1",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=131072)
        async def discard_errors():
            while await process.stderr.read(65536):
                pass
        stderr = asyncio.create_task(discard_errors())
        size = 0
        try:
            while True:
                check()
                async with asyncio.timeout(120):
                    piece = await process.stdout.read(65536)
                if not piece:
                    break
                size += len(piece)
                if limit is not None and size > limit + 16 * 1024 * 1024:
                    raise DownloadError("视频封装结果超过大小上限")
                yield piece
            if await process.wait() != 0 or not size:
                raise DownloadError("M3U8 封装失败，请检查分片完整性与 H.264／AAC 编码")
            if phase:
                phase("saving")
        except (BrokenPipeError, ConnectionResetError, TimeoutError) as exc:
            raise DownloadError("视频封装中断或超时，可以重新下载") from exc
        finally:
            if process.returncode is None:
                process.kill()
            await process.wait()
            await stderr
