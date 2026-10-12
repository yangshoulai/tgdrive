"""按需运行的站点解析子进程；所有 HTTP 请求通过标准输入输出交给主进程。"""

from __future__ import annotations

import base64
import contextlib
import io
import json
import logging
import resource
import sys
import urllib.request
from email.message import Message
from http.cookiejar import Cookie
from types import SimpleNamespace
from urllib.parse import urljoin

from .request import filename


WIRE_LIMIT = 12 * 1024 * 1024
_output = sys.stdout.buffer


def emit(value):
    _output.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode() + b"\n")
    _output.flush()


def fetch(url, method, headers, data=None):
    if data is not None and not isinstance(data, bytes):
        raise ValueError("unsupported body")
    emit({"fetch": {"url": url, "method": method, "headers": list(headers.items()),
                    "body": base64.b64encode(data).decode() if data is not None else None}})
    line = sys.stdin.buffer.readline(WIRE_LIMIT + 1)
    if len(line) > WIRE_LIMIT or not line.endswith(b"\n"):
        raise ValueError("invalid transport")
    reply = json.loads(line)
    if "error" in reply:
        raise ValueError("source unavailable")
    return reply, base64.b64decode(reply["body"], validate=True)


def cookie(record):
    domain = record["domain"]
    return Cookie(0, record["name"], record["value"], None, False, domain,
                  record["include_subdomains"], domain.startswith("."), record["path"], True,
                  record["secure"], record["expires"], record["expires"] is None, None, None, {}, False)


def message(headers):
    result = Message()
    for key, value in headers:
        result[key] = value
    return result


def youtube(payload):
    import yt_dlp
    from yt_dlp.networking.common import RequestHandler, Response
    from yt_dlp.networking.exceptions import HTTPError, TransportError

    class TesseraRH(RequestHandler):
        _SUPPORTED_URL_SCHEMES = ("https",)
        _SUPPORTED_PROXY_SCHEMES = ()

        def _check_extensions(self, extensions):
            for key in ("cookiejar", "timeout", "legacy_ssl", "keep_header_casing"):
                extensions.pop(key, None)

        def _send(self, request):
            url, method, data = request.url, request.method, request.data
            headers = self._get_headers(request)
            jar = self._get_cookiejar(request)
            for _ in range(6):
                prepared = urllib.request.Request(url, data=data, headers=headers, method=method)
                jar.add_cookie_header(prepared)
                try:
                    reply, body = fetch(url, method, dict(prepared.header_items()), data)
                except ValueError as exc:
                    raise TransportError("source unavailable") from exc
                raw = message(reply["headers"])
                jar.extract_cookies(SimpleNamespace(info=lambda: raw), prepared)
                response = Response(io.BytesIO(body), reply["url"], raw, reply["status"])
                if response.status in (301, 302, 303, 307, 308) and raw.get("Location"):
                    response.close()
                    url = urljoin(url, raw["Location"])
                    headers = {key: value for key, value in headers.items()
                               if key.lower() not in ("cookie", "authorization", "origin", "referer")}
                    if response.status == 303 or response.status in (301, 302) and method == "POST":
                        method, data = "GET", None
                    continue
                if response.status >= 400:
                    raise HTTPError(response)
                return response
            raise TransportError("redirect limit")

    class Quiet:
        def debug(self, *_): pass
        def warning(self, *_): pass
        def error(self, *_): pass

    yt_dlp.globals.plugin_dirs.value = []
    options = {"quiet": True, "no_warnings": True, "logger": Quiet(), "noplaylist": True,
               "skip_download": True, "cachedir": False, "proxy": "", "socket_timeout": 20,
               "retries": 0, "extractor_retries": 0, "remote_components": [],
               "js_runtimes": {payload["runtime"]["name"]: {"path": payload["runtime"]["path"]}},
               "http_headers": {"User-Agent": payload["user_agent"]}}
    with yt_dlp.YoutubeDL(options) as downloader:
        for record in payload["cookies"]:
            downloader.cookiejar.set_cookie(cookie(record))
        downloader._request_director.close()
        downloader._request_director = downloader.build_request_director([TesseraRH])
        info = downloader.extract_info(payload["url"], download=False)
    if not info or info.get("_type") in ("playlist", "url", "url_transparent"):
        raise ValueError("not single video")
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live"):
        return {"error": "live"}
    formats = [item for item in (info.get("formats") or [])[:1000]
               if item.get("protocol") in ("https", "http") and not item.get("fragments")
               and item.get("url", "").startswith("https://") and not item.get("has_drm")]
    audio = [item for item in formats if item.get("vcodec") == "none"
             and (item.get("acodec") or "").startswith(("mp4a", "aac")) and item.get("ext") in ("m4a", "mp4")]
    audio = max(audio, key=lambda item: item.get("abr") or item.get("tbr") or 0, default=None)
    best = {}
    for item in formats:
        height = item.get("height")
        if not isinstance(height, int) or not 0 < height <= payload["max_height"]:
            continue
        if item.get("ext") != "mp4" or not (item.get("vcodec") or "").startswith(("avc1", "avc3", "h264")):
            continue
        combined = (item.get("acodec") or "").startswith(("mp4a", "aac"))
        if not combined and (item.get("acodec") != "none" or audio is None):
            continue
        score = (combined, item.get("tbr") or 0)
        if height not in best or score > best[height][0]:
            best[height] = (score, item, combined)
    result = []
    for height, (_, video, combined) in sorted(best.items(), reverse=True):
        tracks = [video] if combined else [video, audio]
        sizes = [track.get("filesize") for track in tracks]
        estimated = [track.get("filesize") or track.get("filesize_approx") for track in tracks]
        result.append({"selection": {"id": info["id"], "index": "1", "height": height},
                       "name": filename(f"{info.get('title') or info['id']} [{info['id']}].mp4"),
                       "variant": f"{height}p · MP4", "group": "1", "media_type": "video",
                       "content_type": "video/mp4", "duration": info.get("duration"),
                       "size": sum(sizes) if all(type(size) is int and size > 0 for size in sizes) else None,
                       "estimated_size": sum(estimated) if all(type(size) is int and size > 0 for size in estimated) else None,
                       # googlevideo 会把不分段的整文件请求限速到接近播放速度，必须按解析库给出的分段大小读取。
                       "tracks": [{"url": track["url"], "headers": track.get("http_headers") or {},
                                   "extension": "mp4" if index == 0 else "m4a",
                                   "chunk": (track.get("downloader_options") or {}).get("http_chunk_size")}
                                  for index, track in enumerate(tracks)]})
    if audio is not None:
        # 仅音频不需要 FFmpeg 合并；与视频清晰度同组，选择时互斥。
        result.append({"selection": {"id": info["id"], "index": "1", "audio": "m4a"},
                       "name": filename(f"{info.get('title') or info['id']} [{info['id']}].m4a"),
                       "variant": "仅音频 · M4A", "group": "1", "media_type": "audio",
                       "content_type": "audio/mp4", "duration": info.get("duration"),
                       "size": audio["filesize"] if type(audio.get("filesize")) is int and audio["filesize"] > 0 else None,
                       "estimated_size": audio.get("filesize") or audio.get("filesize_approx"),
                       "tracks": [{"url": audio["url"], "headers": audio.get("http_headers") or {}, "extension": "m4a",
                                   "chunk": (audio.get("downloader_options") or {}).get("http_chunk_size")}]})
    return {"entries": result} if result else {"error": "formats"}


def twitter(payload):
    from gallery_dl import config, extractor
    from gallery_dl.extractor.common import Message as GalleryMessage
    from requests import Response, Session
    from requests.adapters import BaseAdapter
    from requests.cookies import RequestsCookieJar, extract_cookies_to_jar

    config.set(("cache",), "file", ":memory:")

    class TwitterCookies(RequestsCookieJar):
        def get(self, name, default=None, domain=None, path=None):
            value = super().get(name, default, domain, path)
            # 库按 .x.com 查找登录状态；兼容没有点前缀的主机 Cookie，发送时仍保留原域限制。
            if value is None and domain == ".x.com":
                return super().get(name, default, "x.com", path)
            return value

    class Adapter(BaseAdapter):
        def send(self, request, **_):
            data = request.body.encode() if isinstance(request.body, str) else request.body
            reply, body = fetch(request.url, request.method, request.headers, data)
            response = Response()
            response.status_code, response.url, response.request = reply["status"], reply["url"], request
            response.headers.update(dict(reply["headers"]))
            response._content = body
            response._content_consumed = True
            response.raw = SimpleNamespace(_original_response=SimpleNamespace(msg=message(reply["headers"])),
                                           close=lambda: None, release_conn=lambda: None)
            extract_cookies_to_jar(response.cookies, request, response.raw)
            return response

        def close(self): pass

    for key, value in {"retries": 0, "retries-api": 0, "ratelimit": "abort", "sleep": 0,
                       "sleep-request": 0, "sleep-429": 0, "proxy-env": False, "proxy": None,
                       "videos": True, "previews": False, "quoted": False, "cards": False,
                       "articles": False, "conversations": False, "size": "orig"}.items():
        config.set(("extractor", "twitter"), key, value)
    found = extractor.find(payload["url"])
    if found is None or found.subcategory != "tweet":
        raise ValueError("not single tweet")
    session = Session()
    session.cookies = TwitterCookies()
    session.trust_env = False
    session.headers.update({"User-Agent": payload["user_agent"], "Accept-Encoding": "identity"})
    session.adapters.clear()
    session.mount("https://", Adapter())
    session.mount("http://", Adapter())
    for record in payload["cookies"]:
        session.cookies.set_cookie(cookie(record))
    found.session = session
    result = []
    try:
        for kind, url, data in found:
            if kind != GalleryMessage.Url:
                continue
            extension = data.get("extension", "").lower()
            media_type = "video" if data.get("type") in ("video", "animated_gif") else "image"
            if extension not in ("jpg", "jpeg", "png", "webp", "gif", "mp4"):
                continue
            index = str(data["num"])
            # 文件名带上作者的用户名，便于在同一目录区分多个账号的帖子。
            author = (data.get("author") or {}).get("name") or (data.get("user") or {}).get("name") or ""
            author = author if author.replace("_", "").isalnum() and len(author) <= 32 else ""
            result.append({"selection": {"id": payload["id"], "index": index}, "group": index,
                           "name": f"{author or 'X'}-{payload['id']}-{index}.{extension}", "variant": None,
                           "media_type": media_type, "size": None, "estimated_size": None,
                           "content_type": "video/mp4" if media_type == "video" else f"image/{'jpeg' if extension in ('jpg', 'jpeg') else extension}",
                           "duration": data.get("duration"),
                           "tracks": [{"url": url, "headers": {"User-Agent": payload["user_agent"]},
                                       "extension": extension}]})
            if len(result) > 32:
                raise ValueError("media limit")
    finally:
        session.close()
    return {"entries": result} if result else {"error": "empty"}


def main():
    logging.disable(logging.CRITICAL)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    def deny_network(event, _):
        if event in ("socket.connect", "socket.bind"):
            raise PermissionError("use parent transport")
    sys.addaudithook(deny_network)
    try:
        line = sys.stdin.buffer.readline(512 * 1024 + 1)
        if len(line) > 512 * 1024:
            raise ValueError("input limit")
        payload = json.loads(line)
        # 第三方库的输出不能混入协议，也不能进入应用日志。
        with contextlib.redirect_stdout(sys.stderr):
            result = twitter(payload) if payload["platform"] == "x" else youtube(payload)
        emit({"result": result})
    except Exception:
        emit({"result": {"error": "extract"}})


if __name__ == "__main__":
    main()
