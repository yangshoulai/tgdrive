"""首版仅接受已结束、连续、未加密的 TS 点播列表；不缓存整段视频。"""

from __future__ import annotations

import asyncio
import math
import re
from dataclasses import dataclass
from urllib.parse import urljoin

from .http import DownloadError, SafeHttpClient, status_error
from .request import DownloadRequest, checked_url


@dataclass(frozen=True)
class Playlist:
    variants: list[tuple[str, str]]
    segments: list[tuple[str, float]]

    @property
    def duration(self):
        return sum(duration for _, duration in self.segments)


def attributes(value: str) -> dict[str, str]:
    return {match[1]: match[2].strip('"') for match in re.finditer(r'([A-Z0-9-]+)=("[^"\r\n]*"|[^,]*)', value)}


def parse_playlist(data: bytes, base_url: str) -> Playlist:
    try:
        lines = [line.strip() for line in data.decode("utf-8-sig").splitlines() if line.strip()]
    except UnicodeError as exc:
        raise DownloadError("M3U8 播放列表必须是 UTF-8 文本") from exc
    if not lines or lines[0] != "#EXTM3U":
        raise DownloadError("来源不是有效的 M3U8 播放列表")
    variants, segments, duration, pending = [], [], None, None
    ended = False
    for line in lines[1:]:
        if line.startswith("#EXT-X-STREAM-INF:"):
            pending = attributes(line.split(":", 1)[1])
            if "AUDIO" in pending or "VIDEO" in pending or "SUBTITLES" in pending:
                raise DownloadError("首版暂不支持独立音轨、视频轨或字幕轨的 M3U8")
            codecs = pending.get("CODECS", "")
            if codecs and any(not codec.strip().startswith(("avc1", "avc3", "mp4a.40.")) for codec in codecs.split(",")):
                raise DownloadError("首版 M3U8 仅支持 H.264 视频和 AAC 音频")
        elif line.startswith("#EXT-X-MEDIA:"):
            values = attributes(line.split(":", 1)[1])
            if values.get("URI"):
                raise DownloadError("首版暂不支持带独立媒体轨的 M3U8")
        elif line.startswith(("#EXT-X-KEY:", "#EXT-X-SESSION-KEY:")):
            if attributes(line.split(":", 1)[1]).get("METHOD") != "NONE":
                raise DownloadError("首版暂不支持加密或 DRM 的 M3U8")
        elif line.startswith("#EXT-X-DISCONTINUITY-SEQUENCE:"):
            # 这是之前的时间线序号，并不表示本列表里发生了跳变。
            if not re.fullmatch(r"[0-9]+", line.split(":", 1)[1]):
                raise DownloadError("M3U8 时间线序号不正确")
        elif line.startswith(("#EXT-X-MAP", "#EXT-X-BYTERANGE", "#EXT-X-DISCONTINUITY", "#EXT-X-GAP", "#EXT-X-DEFINE", "#EXT-X-PART", "#EXT-X-PRELOAD", "#EXT-X-I-FRAMES-ONLY")):
            raise DownloadError("首版暂不支持 fMP4、字节范围、时间线跳变或低延迟分片的 M3U8")
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
                if len(variants) > 32:
                    raise DownloadError("M3U8 清晰度选项超过 32 个")
                pending = None
            elif duration is not None:
                segments.append((url, duration))
                if len(segments) > 20000:
                    raise DownloadError("M3U8 分片超过 20000 个")
                duration = None
            else:
                raise DownloadError("M3U8 中存在缺少时长或清晰度说明的链接")
    if pending is not None or duration is not None or (variants and segments):
        raise DownloadError("M3U8 播放列表不完整")
    if variants:
        if len(variants) > 32:
            raise DownloadError("M3U8 清晰度选项超过 32 个")
    elif not segments or not ended:
        raise DownloadError("仅支持已经结束的 M3U8 点播视频，暂不支持直播")
    if len(segments) > 20000:
        raise DownloadError("M3U8 分片超过 20000 个")
    return Playlist(variants, segments)


async def load_playlist(client: SafeHttpClient, request: DownloadRequest):
    if request.method != "GET":
        raise DownloadError("M3U8 只支持 GET 请求")
    async with client.open(request, identity=True) as response:
        if response.status != 200:
            raise status_error(response.status, f"读取 M3U8 失败（HTTP {response.status}）")
        return parse_playlist(await response.read(), response.url)


async def remux(client: SafeHttpClient, request: DownloadRequest, playlist: Playlist,
                executable: str, *, check, progress, throttle):
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
                async with client.open(request, url=url, method="GET", identity=True) as response:
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
            raise DownloadError("视频封装失败：请检查分片完整性，首版仅支持连续的 H.264／AAC 视频")
    except (BrokenPipeError, ConnectionResetError, TimeoutError) as exc:
        raise DownloadError("视频封装中断或超时，可以重新下载") from exc
    finally:
        if process.returncode is None:
            process.kill()
        feeder.cancel()
        await asyncio.gather(feeder, return_exceptions=True)
        await process.wait()
        await stderr
