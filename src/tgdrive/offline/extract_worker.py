"""按需运行的站点解析子进程；所有 HTTP 请求通过标准输入输出交给主进程。"""

from __future__ import annotations

import base64
import contextlib
import io
import json
import logging
import re
import sys
import traceback
import urllib.request
from email.message import Message
from http.client import responses
from http.cookiejar import Cookie
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

from .http import origin
from .request import filename


WIRE_LIMIT = 12 * 1024 * 1024
_output = sys.stdout.buffer


def extraction_failure(error):
    # 第三方异常可能包含带签名的 URL 或 Cookie，只返回固定分类和代码位置。
    causes, current = [], error
    for _ in range(5):
        if current is None or current in causes:
            break
        causes.append(current)
        current = getattr(current, "cause", None) or current.__cause__ or current.__context__
    detail = " ".join(str(cause)[:4096] for cause in causes).lower().replace("\u2019", "'")
    hints = (
        ("cookie", ("cookies are no longer valid", "cookies have expired", "invalid cookies", "not a netscape", "could not authenticate you", "invalid or expired token")),
        ("bot", ("confirm you're not a bot", "unusual traffic", "captcha")),
        ("region", ("not available in your country", "not available from your location", "geo-restricted")),
        ("login", ("sign in to confirm your age", "login required", "sign in to", "authentication required", "nsfw", "protected tweet", "not authorized", "age-restricted", "adult content")),
        ("rate_limit", ("http error 429", "too many requests", "rate limit")),
        ("unavailable", ("video unavailable", "private video", "video has been removed", "video is not available", "members-only", "tweet unavailable", "post is unavailable", "tweet has been deleted", "'unavailable'", "tweet tombstone")),
        ("js", ("javascript runtime", "javascript challenge", "challenge solving failed", "signature extraction failed", "n challenge")),
        ("formats", ("requested format is not available", "no video formats found")),
        ("forbidden", ("http error 403", "403 forbidden")),
        ("extractor", ("unable to extract", "unsupported request", "no supporting handlers")),
    )
    code = next((code for code, terms in hints if any(term in detail for term in terms)), "extract")
    if code == "extract" and any(type(cause).__name__ == "AuthRequired" for cause in causes):
        code = "login"
    if code == "extract" and any(type(cause).__name__ == "NotFoundError" for cause in causes):
        code = "unavailable"
    if code == "extract" and re.search(r"\b(?:401|403)\b", detail):
        code = "forbidden"
    if code == "extract" and re.search(r"\b429\b", detail):
        code = "rate_limit"
    if isinstance(error, ImportError):
        code = "components"
    elif isinstance(error, PermissionError) and "use parent transport" in detail:
        code = "transport"
    frames = traceback.extract_tb(error.__traceback__)[-8:]
    return {"error": code, "exception_type": type(error).__name__,
            "stack": [f"{Path(frame.filename).name}:{frame.lineno}:{frame.name}" for frame in frames]}


def emit(value):
    _output.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode() + b"\n")
    _output.flush()


def fetch(url, method, headers, data=None):
    if data is not None and not isinstance(data, bytes):
        raise ValueError("unsupported body")
    normalized = []
    for key, value in headers.items():
        # gallery-dl 的 X 登录交易 ID 是 bytes；按 HTTP 编码无损转换后才能进入 JSON 通道。
        key = key.decode("ascii") if isinstance(key, bytes) else key
        value = value.decode("latin-1") if isinstance(value, bytes) else value
        if not isinstance(key, str) or not isinstance(value, str):
            raise ValueError("unsupported header")
        normalized.append((key, value))
    emit({"fetch": {"url": url, "method": method, "headers": normalized,
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
                    redirected = urljoin(url, raw["Location"])
                    if origin(redirected) != origin(url):
                        headers = {key: value for key, value in headers.items()
                                   if key.lower() not in ("cookie", "authorization", "origin", "referer", "x-origin", "x-goog-authuser", "x-goog-pageid", "x-youtube-bootstrap-logged-in")}
                    url = redirected
                    if response.status == 303 or response.status in (301, 302) and method == "POST":
                        method, data = "GET", None
                    continue
                if response.status >= 400:
                    raise HTTPError(response)
                return response
            raise TransportError("redirect limit")

    warnings = []
    class Quiet:
        def debug(self, *_): pass
        def warning(self, text, *_):
            warnings.append(extraction_failure(ValueError(text))["error"])
        def error(self, *_): pass

    yt_dlp.globals.plugin_dirs.value = []
    options = {"quiet": True, "no_warnings": True, "logger": Quiet(), "noplaylist": True,
               "skip_download": True, "cachedir": False, "proxy": "", "socket_timeout": 20,
               "retries": 0, "extractor_retries": 0, "remote_components": [],
               # 与 yt-dlp 列举格式相同：解析时不选默认格式，也不试下载被标记待验证的媒体。
               "simulate": "list_only", "check_formats": False,
               # 保留上游默认客户端，并补充支持 Cookie 的 Safari HLS 客户端。
               "extractor_args": {"youtube": {"player_client": ["default", "web_safari"]}},
               "js_runtimes": {payload["runtime"]["name"]: {"path": payload["runtime"]["path"]}},
               "http_headers": {"User-Agent": payload["user_agent"]}}
    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            for record in payload["cookies"]:
                downloader.cookiejar.set_cookie(cookie(record))
            downloader._request_director.close()
            downloader._request_director = downloader.build_request_director([TesseraRH])
            info = downloader.extract_info(payload["url"], download=False)
        result = youtube_entries(info, payload)
    except Exception as error:
        result = extraction_failure(error)
    if result.get("error") in ("formats", "extract", "extractor"):
        for code in ("cookie", "bot", "login", "region", "rate_limit", "js", "forbidden"):
            if code in warnings:
                result["error"] = code
                break
    if "error" in result:
        result["warnings"] = sorted(set(warnings))
    return result


def youtube_entries(info, payload):
    """选择浏览器可播放的 H.264/AAC；保留 HTTPS 与 HLS 两类上游格式。"""
    if not info or info.get("_type") in ("playlist", "url", "url_transparent"):
        raise ValueError("not single video")
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live"):
        return {"error": "live"}
    formats = [item for item in (info.get("formats") or [])[:1000]
               if item.get("protocol") in ("https", "http", "m3u8_native", "m3u8")
               and (not item.get("fragments") or item.get("protocol") in ("m3u8_native", "m3u8"))
               and item.get("url", "").startswith("https://") and not item.get("has_drm")]
    audios = [item for item in formats if item.get("vcodec") == "none"
             and (item.get("acodec") or "").startswith(("mp4a", "aac")) and item.get("ext") in ("m4a", "mp4")]
    direct_audio = max((item for item in audios if item.get("protocol") in ("https", "http")),
                       key=lambda item: item.get("abr") or item.get("tbr") or 0, default=None)
    preferred = ("m3u8_native", "m3u8") if payload.get("prefer_hls") else ("https", "http")
    audio = max(audios, key=lambda item: (item.get("protocol") in preferred, item.get("abr") or item.get("tbr") or 0), default=None)
    best = {}
    for item in formats:
        height = item.get("height")
        if not isinstance(height, int) or not 0 < height <= payload["max_height"]:
            continue
        if item.get("ext") != "mp4" or not (item.get("vcodec") or "").startswith(("avc1", "avc3", "h264")):
            continue
        combined = (item.get("acodec") or "").startswith(("mp4a", "aac"))
        direct = item.get("protocol") in ("https", "http")
        if not combined and (not direct or item.get("acodec") != "none" or direct_audio is None):
            continue
        score = (not direct if payload.get("prefer_hls") else direct, combined, item.get("tbr") or 0)
        if height not in best or score > best[height][0]:
            best[height] = (score, item, combined)
    result = []
    for height, (_, video, combined) in sorted(best.items(), reverse=True):
        tracks = [video] if combined else [video, direct_audio]
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
                                   "protocol": "hls" if track.get("protocol") in ("m3u8_native", "m3u8") else "https",
                                   "extension": "mp4" if index == 0 else "m4a",
                                   "chunk": (track.get("downloader_options") or {}).get("http_chunk_size")}
                                  for index, track in enumerate(tracks)]})
    if audio is not None:
        # 仅音频与视频清晰度同组；HTTPS 不需要合并，HLS 仍需封装。
        result.append({"selection": {"id": info["id"], "index": "1", "audio": "m4a"},
                       "name": filename(f"{info.get('title') or info['id']} [{info['id']}].m4a"),
                       "variant": "仅音频 · M4A", "group": "1", "media_type": "audio",
                       "content_type": "audio/mp4", "duration": info.get("duration"),
                       "size": audio["filesize"] if type(audio.get("filesize")) is int and audio["filesize"] > 0 else None,
                       "estimated_size": audio.get("filesize") or audio.get("filesize_approx"),
                       "tracks": [{"url": audio["url"], "headers": audio.get("http_headers") or {}, "extension": "m4a",
                                   "protocol": "hls" if audio.get("protocol") in ("m3u8_native", "m3u8") else "https",
                                   "chunk": (audio.get("downloader_options") or {}).get("http_chunk_size")}]})
    return {"entries": result} if result else {"error": "formats"}


def twitter(payload):
    from gallery_dl import config, extractor
    from gallery_dl.exception import GalleryDLException
    from gallery_dl.extractor.common import Message as GalleryMessage
    from requests import Response, Session
    from requests.adapters import BaseAdapter
    from requests.cookies import RequestsCookieJar, extract_cookies_to_jar

    config.set(("cache",), "file", ":memory:")
    rejection = []

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
            response.reason = responses.get(response.status_code, "")
            response.headers.update(dict(reply["headers"]))
            response._content = body
            response._content_consumed = True
            response.raw = SimpleNamespace(_original_response=SimpleNamespace(msg=message(reply["headers"])),
                                           close=lambda: None, release_conn=lambda: None)
            extract_cookies_to_jar(response.cookies, request, response.raw)
            if "TweetResultByRestId" in request.url and response.status_code == 200:
                try:
                    tweet = response.json().get("data", {}).get("tweetResult", {}).get("result", {})
                    if tweet.get("__typename") == "TweetTombstone":
                        code = extraction_failure(ValueError(json.dumps(tweet.get("tombstone", {}))))["error"]
                        rejection.append(code if code != "extract" else "unavailable")
                except (ValueError, AttributeError):
                    pass
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
        if not result:
            fallback = twitter_public(payload, session)
            return fallback if fallback.get("entries") else {"error": "empty"}
    except (GalleryDLException, KeyError) as error:
        failure = extraction_failure(error)
        if rejection:
            failure["error"] = rejection[-1]
        if failure["error"] in ("extract", "extractor", "unavailable", "rate_limit"):
            fallback = twitter_public(payload, session)
            if fallback.get("entries"):
                return fallback
        return failure
    finally:
        session.close()
    return {"entries": result} if result else {"error": "empty"}


def twitter_public(payload, session):
    """GraphQL 无结果时，尝试 X 自己的公开嵌入接口；不请求第三方解析站。"""
    try:
        from yt_dlp.extractor.twitter import TwitterIE
    except ImportError:
        return {"error": "unavailable"}
    token = TwitterIE()._generate_syndication_token(payload["id"])
    response = session.get("https://cdn.syndication.twimg.com/tweet-result",
        params={"id": payload["id"], "token": token}, headers={"User-Agent": "Googlebot"})
    if response.status_code != 200:
        return {"error": "rate_limit" if response.status_code == 429 else "unavailable"}
    try:
        tweet = response.json()
    except ValueError:
        return {"error": "extractor"}
    if not isinstance(tweet, dict) or str(tweet.get("id_str")) != payload["id"]:
        return {"error": "unavailable"}
    author = (tweet.get("user") or {}).get("screen_name") or "X"
    if not isinstance(author, str) or not re.fullmatch(r"[A-Za-z0-9_]{1,32}", author):
        author = "X"
    result = []
    for number, media in enumerate((tweet.get("mediaDetails") or [])[:32], 1):
        if media.get("type") == "photo":
            url = media.get("media_url_https") or ""
            parts = urlsplit(url)
            extension = parts.path.rsplit(".", 1)[-1].lower()
            if extension not in ("jpg", "jpeg", "png", "webp", "gif"):
                continue
            query = dict(parse_qsl(parts.query))
            query["name"] = "orig"
            url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))
            media_type, duration = "image", None
        elif media.get("type") in ("video", "animated_gif"):
            video = media.get("video_info") or {}
            variants = [item for item in video.get("variants", [])
                        if urlsplit(item.get("url", "")).path.lower().endswith(".mp4")]
            chosen = max(variants, key=lambda item: item.get("bitrate") or 0, default=None)
            if not chosen:
                continue
            url, extension, media_type = chosen["url"], "mp4", "video"
            duration = video.get("duration_millis")
            duration = duration / 1000 if isinstance(duration, (int, float)) else None
        else:
            continue
        index = str(number)
        result.append({"selection": {"id": payload["id"], "index": index}, "group": index,
            "name": f"{author}-{payload['id']}-{index}.{extension}", "variant": None,
            "media_type": media_type, "size": None, "estimated_size": None, "duration": duration,
            "content_type": "video/mp4" if media_type == "video" else f"image/{'jpeg' if extension in ('jpg', 'jpeg') else extension}",
            "tracks": [{"url": url, "headers": {"User-Agent": payload["user_agent"]}, "extension": extension}]})
    return {"entries": result} if result else {"error": "empty"}


def main():
    logging.disable(logging.CRITICAL)
    if sys.platform != "win32":
        import resource
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
    except Exception as error:
        emit({"result": extraction_failure(error)})


if __name__ == "__main__":
    main()
