"""本地站点解析、Cookie 域隔离与受限的音视频轨缓存。"""

from __future__ import annotations

import asyncio
import base64
import importlib.metadata
import importlib.util
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .http import RETRY_STATUS, DownloadError, ExpiredMedia, TransientError, status_error
from .request import DownloadRequest, checked_url


MIB = 1024 * 1024
ERRORS = {"live": "暂不支持直播、预告或仍在处理中的视频",
          "formats": "平台未提供可下载的 H.264／AAC 格式；可能需要登录、播放证明或允许的服务器出口，请确认浏览器可以播放并检查代理设置",
          "empty": "帖子没有可下载的图片或视频，或当前登录状态无法访问",
          "bot": "YouTube 要求登录确认真人，请导入当前账号的有效 Cookie；仍失败时检查服务器代理出口",
          "cookie": "平台拒绝了已失效或格式不正确的 Cookie，请重新导入当前登录状态",
          "login": "该媒体需要登录或年龄验证，请使用有播放权限的账号 Cookie",
          "region": "该视频受地区限制，当前服务器出口地区无法访问",
          "rate_limit": "平台限制了请求频率，请稍后重试并检查代理出口",
          "temporary": "平台解析服务暂时不可用，请稍后重试",
          "unavailable": "平台未返回这条媒体，可能已删除、被屏蔽或限制登录账号访问；请先确认浏览器中可播放，受限帖子需导入有权限的账号 Cookie",
          "js": "YouTube 的播放器挑战未能解开，请稍后重试或更新平台镜像",
          "forbidden": "平台拒绝了解析请求（HTTP 403），请检查账号权限、Cookie 和服务器代理出口",
          "extractor": "解析组件未能识别平台响应，请检查代理是否返回了验证页面，或更新平台镜像",
          "components": "平台解析器导入组件失败，请重新构建或更新平台镜像",
          "transport": "平台解析器使用了尚未适配的网络请求方式，请更新 Tessera 平台适配器",
          "extract": "平台解析失败，请检查链接、更新 Cookie 或稍后重试；服务器出口也可能受到平台限制"}
JS_ERRORS = {"memory": "YouTube 挑战脚本超过解析内存预算，请稍后重试，或使用内存更充足的服务器",
             "components": "YouTube 挑战脚本缺失、版本不匹配或校验失败，请重新构建包含配套 yt-dlp-ejs 的平台镜像",
             "runtime": "YouTube 的 JavaScript 运行进程启动失败或异常退出，请检查 Node.js／Deno 的版本、权限和容器资源",
             "player": "无法取得 YouTube 挑战所需的播放器脚本，请检查服务器代理出口后重试",
             "solver": "当前解析组件无法处理此 YouTube 播放器脚本，公开客户端重试也未取得格式；请更新平台镜像或稍后重试"}
ROOTS = {"x": ("x.com", "twitter.com", "twimg.com"),
         "youtube": ("youtube.com", "youtube-nocookie.com", "youtu.be", "googlevideo.com", "ytimg.com", "ggpht.com", "google.com")}
COOKIE_ROOTS = {"x": ("x.com", "twitter.com"), "youtube": ("youtube.com", "google.com")}
DEFAULT_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
EXTRACT_STAGES = {"webpage": "网页", "player_api": "播放 API", "metadata_api": "元数据 API",
                  "player_js": "播放器脚本", "manifest": "播放列表", "media_probe": "媒体探测",
                  "guest_auth": "访客认证", "tweet_api": "帖子 API", "public_embed": "公开嵌入接口",
                  "other": "平台接口"}


def extract_endpoint(platform, url):
    """只返回固定请求分类，不能把路径、查询参数或动态 CDN 主机名写入日志。"""
    parts = urlsplit(url)
    path, host = parts.path, parts.hostname or ""
    if platform == "youtube":
        if path == "/youtubei/v1/player":
            return "player_api"
        if path.startswith("/youtubei/"):
            return "metadata_api"
        if path.startswith("/s/player/") or path == "/iframe_api":
            return "player_js"
        if host.endswith(".googlevideo.com"):
            return "manifest" if host == "manifest.googlevideo.com" or path.startswith("/api/manifest/") else "media_probe"
        if host == "youtube.com" or host.endswith(".youtube.com"):
            return "webpage"
    else:
        if path.endswith("/guest/activate.json"):
            return "guest_auth"
        if "/graphql/" in path:
            return "tweet_api"
        if host == "cdn.syndication.twimg.com":
            return "public_embed"
    return "other"


def extract_context(platform, value):
    headers = {key.lower(): content for key, content in value["headers"]}
    client = "other"
    if platform == "youtube":
        client = {"1": "web", "56": "web_embedded", "7": "tv"}.get(headers.get("x-youtube-client-name"), "other")
        if client == "web" and "Safari/605" in headers.get("user-agent", ""):
            client = "web_safari"
    return (f"{extract_endpoint(platform, value['url'])}:{client}:"
            f"cookie={int(bool(headers.get('cookie')))}:auth={int(bool(headers.get('authorization')))}")


def site_link(url: str):
    parts = urlsplit(checked_url(url))
    host = parts.hostname.lower()
    if host in ("x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"):
        match = re.fullmatch(r"/(?:[A-Za-z0-9_]+|i/web|i)/status/([0-9]{1,24})(?:/(?:photo|video)/[0-9]+)?/?", parts.path)
        if not match:
            raise DownloadError("X 只支持单条帖子链接，请使用包含 /status/ 的地址")
        return "x", match[1], f"https://x.com/i/web/status/{match[1]}"
    if host in ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be", "www.youtube-nocookie.com", "youtube-nocookie.com"):
        if parts.path == "/watch":
            video = parse_qs(parts.query).get("v", [""])[0]
        else:
            match = re.fullmatch(r"/(?:shorts/|embed/|live/)?([A-Za-z0-9_-]{11})/?", parts.path)
            video = match[1] if match else ""
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video):
            raise DownloadError("YouTube 只支持单个视频或 Shorts，请使用视频播放链接")
        return "youtube", video, f"https://www.youtube.com/watch?v={video}"
    return None


def allowed_url(platform: str, url: str):
    parts = urlsplit(checked_url(url))
    host = parts.hostname.lower()
    if parts.scheme != "https" or parts.port not in (None, 443) or not any(host == root or host.endswith("." + root) for root in ROOTS[platform]):
        raise DownloadError("平台解析请求只能访问该平台的 HTTPS 域名和媒体域名")


def _cookie_record(domain, include, path, secure, expires, name, value):
    if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) or len(value) > 8192:
        raise DownloadError("Cookie 名称或长度不正确")
    if not path.startswith("/") or len(path) > 1024 or any(ord(char) < 32 or ord(char) == 127 for char in path + value):
        raise DownloadError("Cookie 包含不合法的路径或控制字符")
    try:
        value.encode("latin-1")
    except UnicodeError as exc:
        raise DownloadError("Cookie 必须符合 HTTP 字符编码") from exc
    return {"domain": domain, "include_subdomains": include, "path": path, "secure": secure,
            "expires": expires, "name": name, "value": value}


def parse_cookies(text: str, platform: str, headers=()) -> list[dict]:
    if not isinstance(text, str) or len(text.encode()) > 32768:
        raise DownloadError("Cookie 文本不能超过 32 KiB")
    records = {}
    raw = [value for key, value in headers if key.lower() == "cookie"]
    if text.strip() and "\t" not in text:
        raw.append(re.sub(r"^cookie:\s*", "", text.strip(), flags=re.IGNORECASE))
    elif text.strip():
        for line in text.splitlines():
            if not line or line.startswith("#") and not line.startswith("#HttpOnly_"):
                continue
            cells = line.removeprefix("#HttpOnly_").split("\t")
            if len(cells) != 7:
                raise DownloadError("请使用 Netscape cookies.txt 格式，或 Cookie 请求头文本")
            domain, include, path, secure, expires, name, value = cells
            domain = domain.lower()
            if include not in ("TRUE", "FALSE") or secure not in ("TRUE", "FALSE") or not expires.isdigit():
                raise DownloadError("Cookie 的域、有效期或格式不正确")
            host = domain.lstrip(".")
            if not any(host == root or host.endswith("." + root) for root in COOKIE_ROOTS[platform]):
                continue
            if platform == "x" and host == "twitter.com":
                domain = ".x.com" if include == "TRUE" else "x.com"
            record = _cookie_record(domain, include == "TRUE", path, secure == "TRUE", int(expires) or None, name, value)
            records[(domain, path, name)] = record
    domain = ".x.com" if platform == "x" else ".youtube.com"
    for line in raw:
        for item in line.split(";"):
            if not item.strip():
                continue
            name, separator, value = item.strip().partition("=")
            if not separator:
                raise DownloadError("Cookie 文本应为 name=value，以分号分隔")
            record = _cookie_record(domain, True, "/", True, None, name, value)
            records[(domain, "/", name)] = record
    if len(records) > 128:
        raise DownloadError("同一平台最多导入 128 个 Cookie")
    if text.strip() and not records:
        raise DownloadError("Cookie 文件中没有找到该平台的 Cookie")
    return list(records.values())


def capabilities():
    runtime = None
    installed = all(importlib.util.find_spec(name) is not None for name in ("yt_dlp", "yt_dlp_ejs"))
    if installed:
        for name in ("node", "deno"):
            executable = shutil.which(name)
            if executable:
                try:
                    result = subprocess.run([executable, "--version"], capture_output=True, timeout=2, check=True)
                    version = re.search(rb"(?:v|deno )([0-9]+)\.([0-9]+)", result.stdout)
                    if version and (int(version[1]), int(version[2])) >= ((22, 0) if name == "node" else (2, 3)):
                        full = re.search(rb"(?:v|deno )([0-9]+\.[0-9]+(?:\.[0-9]+)?)", result.stdout)
                        runtime = {"name": name, "path": executable, "version": full[1].decode() if full else None}
                        break
                except (OSError, subprocess.SubprocessError):
                    pass
    versions = {}
    for package in ("yt-dlp", "yt-dlp-ejs", "gallery-dl"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    if runtime:
        versions[runtime["name"]] = runtime["version"]
    return {"x_available": importlib.util.find_spec("gallery_dl") is not None,
            "youtube_available": installed and runtime is not None,
            "runtime": runtime, "versions": versions}


def tool_version(executable: str | None) -> str | None:
    """读取 FFmpeg 版本号，只在启动时调用一次；失败时返回 None。"""
    if not executable:
        return None
    try:
        result = subprocess.run([executable, "-version"], capture_output=True, timeout=3, check=True)
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(rb"version (n?[0-9][0-9A-Za-z.+~-]{0,40})", result.stdout)
    return match[1].decode() if match else None


def prepare(request: DownloadRequest, cookie_text: str, platform: str, media_id: str, canonical: str):
    if request.method != "GET":
        raise DownloadError("平台帖子与视频解析只接受 GET 链接")
    user_agent = next((value for key, value in request.headers if key.lower() == "user-agent"), DEFAULT_AGENT)
    if len(user_agent) > 1024:
        raise DownloadError("User-Agent 不能超过 1024 个字符")
    return {"platform": platform, "id": media_id, "url": canonical,
            "cookies": parse_cookies(cookie_text, platform, request.headers), "user_agent": user_agent}


def media_request(platform, track):
    allowed_url(platform, track["url"])
    headers = [(key, value) for key, value in track.get("headers", {}).items()
               if key.lower() in ("user-agent", "referer", "origin", "accept")]
    for key, value in headers:
        if not isinstance(value, str) or len(value) > 16384 or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise DownloadError("平台返回了不合法的媒体请求头")
        try:
            value.encode("latin-1")
        except UnicodeError as exc:
            raise DownloadError("平台返回了不合法的媒体请求头") from exc
    return DownloadRequest(checked_url(track["url"]), headers=headers)


class PlatformResolver:
    def __init__(self, client, resources):
        self.client, self.resources = client, resources
        self._slot = asyncio.Semaphore(1)

    async def _fetch(self, platform, value, check):
        allowed_url(platform, value["url"])
        if value["method"] not in ("GET", "HEAD", "POST"):
            raise DownloadError("平台请求方法不正确")
        headers = []
        for key, content in value["headers"]:
            if key.lower() in ("host", "content-length", "connection", "accept-encoding", "transfer-encoding", "te", "trailer", "upgrade", "expect", "proxy-authorization", "proxy-connection"):
                continue
            if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", key) or not isinstance(content, str) or any(ord(char) < 32 or ord(char) == 127 for char in content):
                raise DownloadError("平台请求头不正确")
            headers.append((key, content))
        if sum(len(key) + len(value) for key, value in headers) > 32768:
            raise DownloadError("平台请求头过大")
        body = base64.b64decode(value["body"], validate=True) if value.get("body") is not None else None
        if body is not None and len(body) > 65536:
            raise DownloadError("平台请求体过大")
        request = DownloadRequest(value["url"], method=value["method"], headers=headers,
                                  body=body.decode("utf-8") if body is not None else None)
        for attempt in range(3):
            check()
            try:
                async with self.client.open(request, identity=True, redirects=False) as response:
                    pieces, size = [], 0
                    if request.method != "HEAD":
                        async for piece in response.stream():
                            check()
                            size += len(piece)
                            if size > 8 * MIB:
                                raise DownloadError("平台解析响应超过 8 MiB")
                            pieces.append(piece)
                    raw = [(key, value) for key, value in getattr(response, "raw_headers", list(response.headers.items()))
                           if key.lower() not in ("content-encoding", "content-length", "transfer-encoding")]
                    raw.append(("content-length", response.headers.get("content-length", "0") if request.method == "HEAD" else str(size)))
                    return {"status": response.status, "url": response.url, "headers": raw,
                            "body": base64.b64encode(b"".join(pieces)).decode()}
            except TransientError:
                # 解析请求的响应完整缓存后才交给解析库，中途断开时整体重发不会产生半截数据。
                if attempt == 2:
                    raise
                await asyncio.sleep(1 + attempt)

    async def resolve(self, source, check):
        try:
            # 等待全局解析名额也计入时限，避免并发用户积压不可取消的长请求。
            async with asyncio.timeout(120):
                return await self._resolve(source, check)
        except TimeoutError as exc:
            raise DownloadError("平台解析或等待解析名额超时，请稍后重试") from exc

    async def _resolve(self, source, check):
        async with self._slot:
            config = self.resources.effective()
            platform = source["platform"]
            if not config[f"{platform}_enabled"] or not config[f"{platform}_available"]:
                raise DownloadError("平台下载未启用或缺少本地解析组件，请联系管理员使用平台镜像并启用对应功能")
            check()
            payload = {**source, "runtime": self.resources.platform_tools["runtime"],
                       "max_height": config["youtube_max_height"]}
            env = {**os.environ, "NODE_OPTIONS": "--max-old-space-size=128", "PYTHONUNBUFFERED": "1"}
            process = await asyncio.create_subprocess_exec(sys.executable, "-m", "tgdrive.offline.extract_worker",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                limit=2 * MIB, start_new_session=True, env=env,
                **({"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}))
            async def discard_errors():
                while await process.stderr.read(65536):
                    pass
            stderr = asyncio.create_task(discard_errors())
            try:
                async with asyncio.timeout(120):
                    process.stdin.write(json.dumps(payload, ensure_ascii=True).encode() + b"\n")
                    await process.stdin.drain()
                    requests, trace = 0, []
                    while True:
                        check()
                        try:
                            async with asyncio.timeout(0.5):
                                line = await process.stdout.readline()
                        except TimeoutError:
                            continue
                        if not line or len(line) > 2 * MIB:
                            raise DownloadError("平台解析进程退出或返回数据过大，请稍后重试")
                        reply = json.loads(line)
                        if "fetch" in reply:
                            requests += 1
                            if requests > 100:
                                raise DownloadError("平台解析请求过多，已停止")
                            fetch = reply["fetch"]
                            context = extract_context(platform, fetch)
                            try:
                                value = await self._fetch(platform, fetch, check)
                            except DownloadError as exc:
                                trace.append(f"{context}:{'transient' if isinstance(exc, TransientError) else 'source_error'}")
                                logging.getLogger(__name__).warning("platform_source_failed platform=%s stage=extract requests=%s",
                                    platform, ";".join(trace[-16:]))
                                label = EXTRACT_STAGES[extract_endpoint(platform, fetch["url"])]
                                raise type(exc)(f"{exc}（解析阶段：{label}）") from exc
                            trace.append(f"{context}:{value['status']}")
                            trace = trace[-16:]
                            process.stdin.write(json.dumps(value, ensure_ascii=True).encode() + b"\n")
                            await process.stdin.drain()
                        else:
                            result = reply["result"]
                            js_reason = result.get("js_reason", "unknown")
                            if not isinstance(js_reason, str) or js_reason not in JS_ERRORS:
                                js_reason = "unknown"
                            js_retries = result.get("js_retries", [])
                            js_retries = [item for item in js_retries[:2] if isinstance(item, str) and item in ("memory", "public")] if isinstance(js_retries, list) else []
                            if "error" in result:
                                code = result["error"] if result["error"] in ERRORS else "extract"
                                failed = next((item for item in reversed(trace) if item.rsplit(":", 1)[-1].isdigit() and int(item.rsplit(":", 1)[-1]) >= 400), None)
                                if failed and (code in ("formats", "extract", "extractor") or code == "js" and js_reason == "player"):
                                    status = int(failed.rsplit(":", 1)[-1])
                                    if status in (401, 403):
                                        code = "forbidden"
                                    elif status in RETRY_STATUS:
                                        code = "rate_limit" if status == 429 else "temporary"
                                error_type = result.get("exception_type", "")
                                if not isinstance(error_type, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", error_type):
                                    error_type = "unknown"
                                stack = result.get("stack", [])
                                stack = [frame for frame in stack[:8] if isinstance(frame, str) and
                                         re.fullmatch(r"[A-Za-z0-9_.-]{1,80}:\d{1,8}:[A-Za-z0-9_<>]{1,80}", frame)] if isinstance(stack, list) else []
                                warnings = result.get("warnings", [])
                                warnings = sorted({warning for warning in warnings if isinstance(warning, str) and warning in ERRORS}) if isinstance(warnings, list) else []
                                logging.getLogger(__name__).warning("platform_extract_failed platform=%s stage=extract code=%s error_type=%s stack=%s warnings=%s js_reason=%s js_retries=%s requests=%s",
                                    platform, code, error_type, ";".join(stack), ",".join(warnings), js_reason, ",".join(js_retries), ";".join(trace))
                                message = JS_ERRORS.get(js_reason, ERRORS[code]) if code == "js" else ERRORS[code]
                                if code == "js" and js_reason == "solver" and "public" not in js_retries:
                                    message = "当前解析组件无法处理此 YouTube 播放器脚本，请更新平台镜像或稍后重试"
                                denied = next((item for item in reversed(trace) if item.rsplit(":", 1)[-1] in ("401", "403")), None)
                                if code == "forbidden" and denied:
                                    message = f"平台拒绝了解析请求（HTTP {denied.rsplit(':', 1)[-1]}，{EXTRACT_STAGES[denied.split(':', 1)[0]]}），请检查账号权限、Cookie 和服务器代理出口"
                                if code == "extract" and error_type != "unknown":
                                    message += f"（解析异常：{error_type}）"
                                raise (TransientError if code in ("rate_limit", "temporary") else DownloadError)(message)
                            if js_retries:
                                logging.getLogger(__name__).info("platform_extract_recovered platform=%s js_retries=%s", platform, ",".join(js_retries))
                            entries = result["entries"]
                            if not isinstance(entries, list) or not 1 <= len(entries) <= 32:
                                raise DownloadError("平台媒体数量不正确")
                            for entry in entries:
                                if entry["selection"].get("id") != source["id"]:
                                    raise DownloadError("平台返回的媒体与提交链接不一致")
                                if not 1 <= len(entry["tracks"]) <= 2:
                                    raise DownloadError("平台媒体轨数量不正确")
                                for track in entry["tracks"]:
                                    media_request(platform, track)
                                size = entry.get("size") or entry.get("estimated_size")
                                # 单轨媒体直接流入加密分片，不占用整轨缓存；只有分离音视频需要临时缓存并合并。
                                if len(entry["tracks"]) > 1 and size and size > config["platform_max_mib"] * MIB:
                                    entry["too_large"] = True
                            return entries
            except (TimeoutError, BrokenPipeError, ConnectionResetError) as exc:
                raise DownloadError("平台解析超时或中断，请稍后重试") from exc
            except (KeyError, TypeError, ValueError, UnicodeError) as exc:
                if isinstance(exc, DownloadError):
                    raise
                raise DownloadError("平台解析响应不完整或格式不正确，请稍后重试") from exc
            finally:
                # 同时回收解析器与 JavaScript 子进程，避免取消任务后继续占用内存。
                if sys.platform == "win32":
                    if process.returncode is None:
                        killer = await asyncio.create_subprocess_exec("taskkill", "/PID", str(process.pid), "/T", "/F",
                            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                            creationflags=subprocess.CREATE_NO_WINDOW)
                        await killer.wait()
                else:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                await process.wait()
                await stderr


async def track_stream(client, platform, track, *, on_size=None, retries=3):
    """读取一条平台媒体轨。解析库要求分段时按 Range 逐段请求，每段核对范围与总长度；
    分段模式下网络中断从已读取的位置原地续读，不重新下载整条轨。"""
    request = media_request(platform, track)
    options = {"identity": True, "url_check": lambda url: allowed_url(platform, url)}
    chunk = track.get("chunk")
    chunked = type(chunk) is int and MIB <= chunk <= 64 * MIB
    offset, total, failures = 0, None, 0
    while total is None or offset < total:
        headers, end = dict(request.headers), None
        if chunked:
            end = offset + chunk - 1 if total is None else min(offset + chunk, total) - 1
            headers["Range"] = f"bytes={offset}-{end}"
        try:
            async with client.open(request, extra_headers=headers, **options) as response:
                if response.status in (401, 403, 404, 410):
                    raise ExpiredMedia(f"平台拒绝了媒体请求（HTTP {response.status}）；地址可能过期，或需要平台播放校验／允许的服务器出口")
                if response.status == 200 and offset == 0:
                    # 未要求分段，或来源忽略 Range 返回整个文件；这种响应无法原地续读。
                    if on_size:
                        on_size(response.size)
                    received = 0
                    async for piece in response.stream():
                        received += len(piece)
                        yield piece
                    if response.size is not None and received != response.size:
                        raise DownloadError("平台媒体传输不完整，请重新下载")
                    return
                if response.status not in (200, 206):
                    raise status_error(response.status, f"平台媒体下载失败（HTTP {response.status}），请更新 Cookie 或稍后重试")
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("content-range", ""))
                if not chunked or response.status != 206 or not match or int(match[1]) != offset or not offset <= int(match[2]) <= end:
                    raise DownloadError("平台媒体返回了不一致的分段，请重新下载")
                if total is None:
                    total = int(match[3])
                    if on_size:
                        on_size(total)
                elif int(match[3]) != total:
                    raise DownloadError("平台媒体在下载过程中发生变化，请重新下载")
                stop = int(match[2]) + 1
                async for piece in response.stream():
                    if offset + len(piece) > stop:
                        raise DownloadError("平台媒体返回的分段长度不正确，请重新下载")
                    offset += len(piece)
                    yield piece
                if offset != stop:
                    raise TransientError("平台媒体分段传输提前中断")
            failures = 0
        except TransientError:
            failures += 1
            if not chunked or failures > retries:
                raise
            await asyncio.sleep(min(2 ** failures, 10))


def clear_cache(root: Path):
    if not root.exists():
        return
    if root.is_symlink():
        raise DownloadError("离线临时目录不能是符号链接")
    for path in root.iterdir():
        if path.is_dir() and not path.is_symlink() and re.fullmatch(r"task-[0-9]+-[a-z0-9_]{8}", path.name):
            shutil.rmtree(path)


async def merge_tracks(client, platform, entry, executable, cache_root, task_id, limit, reserve, *, check, progress, throttle, phase):
    """只缓存受限的两条输入轨；MP4 输出通过背压直接交给加密存储。"""
    cache_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if cache_root.is_symlink():
        raise DownloadError("离线临时目录不能是符号链接")
    with tempfile.TemporaryDirectory(prefix=f"task-{task_id}-", dir=cache_root) as directory:
        files, received = [], 0
        for index, track in enumerate(entry["tracks"]):
            path = Path(directory) / f"track-{index}.mp4"
            files.append(path)
            def sized(size):
                if size is not None and received + size > limit:
                    raise DownloadError("分离音视频轨超过临时缓存预算，请选择较低清晰度或调整资源设置")
            stream = track_stream(client, platform, track, on_size=sized)
            try:
                with path.open("wb") as output:
                    os.chmod(path, 0o600)
                    async for piece in stream:
                        check()
                        received += len(piece)
                        if received > limit:
                            raise DownloadError("分离音视频轨超过临时缓存预算，请选择较低清晰度或调整资源设置")
                        if shutil.disk_usage(cache_root).free < reserve + len(piece) + 32 * MIB:
                            raise DownloadError("临时磁盘空间不足，请释放空间后重试")
                        await throttle(len(piece))
                        await asyncio.to_thread(output.write, piece)
                        progress(bytes_in=len(piece))
            finally:
                await stream.aclose()
        phase("merging")
        process = await asyncio.create_subprocess_exec(executable,
            "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-max_alloc", "33554432",
            "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", str(files[0]),
            "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", str(files[1]),
            "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-tag:v", "avc1", "-threads", "1",
            "-max_muxing_queue_size", "64", "-movflags", "empty_moov+delay_moov+frag_keyframe+default_base_moof",
            "-frag_duration", "2000000", "-f", "mp4", "pipe:1",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=131072)
        async def discard_errors():
            while await process.stderr.read(65536):
                pass
        stderr = asyncio.create_task(discard_errors())
        total = 0
        try:
            while True:
                check()
                async with asyncio.timeout(120):
                    piece = await process.stdout.read(65536)
                if not piece:
                    break
                total += len(piece)
                yield piece
            if await process.wait() != 0:
                raise DownloadError("音视频合并失败，请重新选择 MP4 清晰度")
            phase("saving")
        finally:
            if process.returncode is None:
                process.kill()
            await process.wait()
            await stderr
