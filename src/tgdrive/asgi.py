"""管理/用户 HTTP 入口；上传与下载通过异步迭代器传递背压。"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import time
import traceback
from pathlib import Path
from urllib.parse import parse_qs, quote

from .api import AdminApi, UserApi
from .archive import stream_zip
from .assistant.service import AssistantDenied
from .audit import AuditLog
from .client_cache import CacheTaskGone, ClientCache
from .authn import (
    AuthenticationError,
    CsrfError,
    SessionExpired,
    TooManyAttempts,
    hash_password,
    verify_password,
)
from .context import AppContext
from .filekinds import served_type
from .errors import (
    IntegrityError,
    NotFoundError,
    NotReadyError,
    QuotaExceededError,
    ShareExpiredError,
    VersionConflict,
    WrongPassphrase,
)
from .keyapi import KeyApi, KeyAuthError
from .metrics import TrafficMetrics
from .objects import PRIVATE_PREFIX, Scope
from .private import PrivateAccessLogFilter, PrivateLocked, PrivateSpace
from .extract import ArchiveService
from .extract import _content_type as _archive_type
from .media.service import AssetExists, MediaService
from .registration import RegistrationService
from .settings import SystemSettings
from .share import ShareAccess
from .static import StaticFiles
from .version import __version__
from .work import WorkBusyError

log = logging.getLogger("tgdrive.http")


class InvalidRange(ValueError):
    def __init__(self, size: int):
        super().__init__("请求的字节范围不可满足")
        self.size = size


def byte_range(value: str | None, size: int) -> tuple[int, int, bool]:
    if not value or "," in value:
        return 0, size, False
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip())
    if not match or size == 0:
        raise InvalidRange(size)
    left, right = match.groups()
    if not left:
        if not right or int(right) == 0:
            raise InvalidRange(size)
        return max(0, size - int(right)), size, True
    start = int(left)
    end = min(size, int(right) + 1) if right else size
    if start >= size or start >= end:
        raise InvalidRange(size)
    return start, end, True




class SharePasswordRequired(PermissionError):
    """带密码的分享缺少有效访问凭证。"""


class TgDriveASGI(StaticFiles):
    def __init__(self, admin: AdminApi, user: UserApi, *, secure_cookies: bool = True,
                 json_limit: int = 1024 * 1024, s3=None, s3_host: str | None = None,
                 static_dir: str | Path | None = None,
                 public_base_url: str | None = None, settings: SystemSettings | None = None,
                 keys: KeyApi | None = None, scheduler=None, metrics: TrafficMetrics | None = None,
                 context: AppContext | None = None, offline=None, resources=None, assistant=None, thumbnails=None,
                 telegram_bot=None) -> None:
        self.scheduler = scheduler
        self.admin, self.user, self.s3 = admin, user, s3
        # 对外地址也是通行密钥的固定来源，不能由任意请求头决定。
        self.settings = settings or SystemSettings(admin.accounts.metadata, {"public_base_url": public_base_url})
        self.private_space = PrivateSpace(user, self.settings)
        # 在线解压：任务只在进程内存里，流式读写存储，不落本地磁盘。
        self.archives = ArchiveService(user.objects)
        # 媒体元数据：文件自带的标签、内嵌歌词与字幕，以及可在系统设置中开关的第三方提供者（封面、歌词、字幕）。
        self.media = MediaService(user.objects, admin.accounts.keystore, resources)
        previous_commit = user.objects.on_commit

        def committed(info, scope=None):
            # 缩略图与媒体信息各自排队；一个出错不影响另一个。
            try:
                if previous_commit is not None:
                    previous_commit(info, scope)
            finally:
                self.media.committed(info, scope)
        user.objects.on_commit = committed
        if user.objects.thumbnail_service is not None:
            # 文件助手生成封面：内嵌封面之后、截取画面之前先在线查找。
            user.objects.thumbnail_service.media = self.media
        self.passkeys = self.private_space.passkeys
        self.client_cache = ClientCache(user, self.private_space)
        self.registration = RegistrationService(user.accounts)
        user.private_space = self.private_space
        admin.private_space = self.private_space
        access_logger = logging.getLogger("uvicorn.access")
        if not any(isinstance(item, PrivateAccessLogFilter) for item in access_logger.filters):
            access_logger.addFilter(PrivateAccessLogFilter())
        # /api/v1 只认访问密钥；未注入时使用用户 API 的对象服务与密钥存储。
        self.keys = keys or (KeyApi(user.objects, user.clients) if user.clients is not None else None)
        self.audit = AuditLog(admin.accounts.metadata)
        self.share_access = ShareAccess(admin.accounts.keystore)
        self.s3_host = s3_host.split(":", 1)[0].lower() if s3_host else None
        self.static_dir = Path(static_dir).expanduser().resolve() if static_dir else None
        self.secure_cookies, self.json_limit = secure_cookies, json_limit
        self.metrics = metrics
        self.context = context
        self.offline, self.resources = offline, resources
        self.thumbnails = thumbnails
        self.assistant = assistant
        # Telegram 交互机器人（telegram/bot.py）：绑定与解绑由机器人在私聊里完成，审计由这里写入。
        self.telegram_bot = telegram_bot
        if telegram_bot is not None:
            def audit_bot(action: str, user_id: int, detail: dict) -> None:
                row = admin.accounts.metadata.db.execute("SELECT username FROM users WHERE id=?", (user_id,)).fetchone()
                self.audit.record(action, actor_type="user", actor=row["username"] if row else None, ok=True, detail=detail)
            telegram_bot.on_audit = audit_bot
        if assistant is not None:
            def audit_auto(action: str, user_id: int, detail: dict) -> None:
                row = admin.accounts.metadata.db.execute("SELECT username FROM users WHERE id=?", (user_id,)).fetchone()
                self.audit.record(action, actor_type="user", actor=row["username"] if row else None, ok=True, detail=detail)
            assistant.on_audit = audit_auto
            # 私密对话（docs/assistant-design.md §24）：授权由私密空间管理，撤销时清除对话。
            assistant.private_space = self.private_space
            assistant.media = assistant.executor.media = self.media
            # 助手的解压与压缩（propose_extract／propose_compress）沿用网页的任务队列与并发限制。
            assistant.executor.archives = self.archives
            self.private_space.assistant_busy = assistant.private_busy
            self.private_space.listeners.append(assistant.on_private_forget)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    if self.thumbnails is not None:
                        self.thumbnails.start()
                    self.media.start()
                    if self.offline is not None:
                        self.offline.start()
                    if self.telegram_bot is not None:
                        self.telegram_bot.start()
                    if self.scheduler is not None:
                        self.scheduler.start()
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    if self.telegram_bot is not None:
                        await self.telegram_bot.stop()
                    if self.offline is not None:
                        await self.offline.stop()
                    if self.thumbnails is not None:
                        await self.thumbnails.stop()
                    await self.archives.stop()
                    await self.media.stop()
                    if self.scheduler is not None:
                        await self.scheduler.stop()
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        cookies = {part.strip().split("=", 1)[0]: part.strip().split("=", 1)[1]
                   for part in headers.get("cookie", "").split(";") if "=" in part}
        path, method = scope.get("path", ""), scope.get("method", "GET").upper()
        # 全站只有一个会话 Cookie；账号的角色保存在服务端会话里，由每个接口按角色校验。
        token = cookies.get("tg_session", "")
        # /api/auth/v1/* 是登录、退出、当前会话与改密的统一入口，实现与 /api/user/v1/* 相同。
        if path.startswith("/api/auth/v1/"):
            path = "/api/user/v1/" + path[len("/api/auth/v1/"):]
        csrf = headers.get("x-csrf-token", "")
        host = headers.get("host", "localhost").split(":", 1)[0].lower()
        query = parse_qs(scope.get("query_string", b"").decode(), keep_blank_values=True)
        started = False
        private_response = (path.startswith("/api/user/v1/private/") or path.startswith("/api/user/v1/passkeys")
                            or path.startswith("/api/user/v1/cache/tasks")
                            or path.startswith("/api/user/v1/registration") or path == "/api/user/v1/register"
                            or path.startswith("/api/admin/v1/registration"))
        request_id = secrets.token_hex(8)
        request_start = time.monotonic()

        async def tracked_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                if private_response:
                    # 覆盖所有分支（流、上传和错误，含私密缩略图），避免浏览器 HTTP 缓存或中间代理保存私密明文；
                    # 需要本机缓存时由 Service Worker 加密保存（docs/client-cache-design.md）。
                    message["headers"] = [(k, v) for k, v in message.get("headers", [])
                                          if k.lower() not in (b"cache-control", b"referrer-policy")]
                    message["headers"].extend([(b"cache-control", b"no-store"), (b"referrer-policy", b"no-referrer")])
                message["headers"] = [*message.get("headers", []), (b"x-request-id", request_id.encode())]
            elif message["type"] == "http.response.body" and self.metrics is not None:
                self.metrics.record_out(len(message.get("body", b"")))
            await send(message)

        async def body_stream():
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    raise ConnectionError("上传连接已中断")
                if message["type"] != "http.request":
                    continue
                if message.get("body"):
                    if self.metrics is not None:
                        self.metrics.record_in(len(message["body"]))
                    yield message["body"]
                if not message.get("more_body", False):
                    return

        try:
            if path == "/healthz" and method in ("GET", "HEAD"):
                if method == "HEAD":
                    await self._send_raw(tracked_send, 200, {"Content-Type": "application/json; charset=utf-8"}, b"")
                else:
                    await self._send(tracked_send, 200, {"status": "ok"})
                return
            if headers.get("service-worker") == "script" and path != "/sw.js":
                # 浏览器注册 Service Worker 时会带这个请求头。用户上传的 .js 与站点同源，不能被注册成常驻脚本。
                await self._send(tracked_send, 403, {"error": {"code": "forbidden", "message": "不允许注册为 Service Worker"}})
                return
            # 公开直链优先于 S3 路径路由；桶名至少 3 个字符，因此 /p/ 不会与桶冲突。
            if path.startswith("/p/") and method in ("GET", "HEAD"):
                await self._until_disconnect(receive, self._public_content(tracked_send, method, path, query, headers))
                return
            # 管理员配置的 S3 Endpoint 优先于启动参数 --s3-host。
            s3_host = self.settings.s3_hostname() or self.s3_host
            s3_request = self.s3 is not None and not path.startswith("/api/") and (
                (s3_host is None and self.static_dir is None) or
                (s3_host is not None and host == s3_host)
            )
            if s3_request:
                # 请求体以流交给网关，由它边读边校验签名与哈希；响应体同样流式发送。
                scheme = scope.get("scheme", "http")
                query_text = scope.get("query_string", b"").decode("latin-1")
                url = f"{scheme}://{host}{path}" + (f"?{query_text}" if query_text else "")
                response = await self.s3.handle(method, url, headers, body_stream())
                if response.stream is not None:
                    try:
                        await self._send_stream(tracked_send, response.status, response.headers, response.stream, method)
                    except WorkBusyError:
                        if started:
                            raise
                        busy = self.s3._error("SlowDown", "transfer capacity is busy; retry later", 503)
                        await self._send_raw(tracked_send, busy.status, {**busy.headers, "Retry-After": "5"}, busy.body)
                else:
                    await self._send_raw(tracked_send, response.status, response.headers, response.body)
                return
            if self.static_dir is not None and method in ("GET", "HEAD") and not path.startswith("/api/"):
                https = scope.get("scheme") == "https"
                await self._static(tracked_send, path, method, https=https,
                                   origin=f"{scope.get('scheme', 'http')}://{headers.get('host', 'localhost')}",
                                   accept_encoding=headers.get("accept-encoding", ""))
                return
            if path in {"/api/admin/v1/objects", "/api/admin/v1/content", "/api/admin/v1/thumbnail",
                        "/api/admin/v1/preview-assets", "/api/admin/v1/preview-list", "/api/admin/v1/objects/public"}:
                # 旧管理入口显式拒绝访问，避免只隐藏菜单后仍能枚举或读取用户文件。
                session = self.admin.accounts.sessions.require(token, role="admin")
                self.admin.accounts.account_for_session(session)
                raise PermissionError("系统管理不提供用户文件访问，请在我的空间管理自己的文件")
            if path.startswith("/api/v1/"):
                await self._key_api(tracked_send, method, path[len("/api/v1"):], query, headers, body_stream)
                return
            if path in ("/api/user/v1/cache/tasks/content", "/api/user/v1/cache/tasks/list") and method in ("GET", "HEAD"):
                cache_user = self.client_cache.task_files(token, headers.get("x-tessera-cache-task", ""))
                if path.endswith("/content"):
                    await self._until_disconnect(receive, self._content(tracked_send, method, token, query, headers, user=cache_user, private=True))
                else:
                    prefix = query.get("prefix", [""])[0]
                    if not prefix.endswith("/"):
                        raise ValueError("缓存目录必须以 / 结尾")
                    result = await cache_user.list(token, prefix=prefix, cursor=query.get("cursor", [None])[0], limit=200)
                    await self._send(tracked_send, 200, result)
                return
            file_user = self.user
            private = path.startswith("/api/user/v1/private/")
            access = headers.get("x-private-access", query.get("access", [""])[0])
            if not access and private and method == "GET" and path == "/api/user/v1/private/thumbnail" and token:
                # 私密缩略图地址不带解锁令牌，同一版本在多次解锁之间地址不变（便于本机加密缓存按版本命中）；授权取自同一登录会话当前的私密授权。
                access = self.private_space.session_grants.get(token, "")
            audit_path = path
            if private and path.startswith("/api/user/v1/private/assistant/"):
                # 私密对话已并入统一助手接口（文件助手设计 §37），旧地址不再提供。
                raise NotFoundError("资源不存在")
            elif private:
                route = path[len("/api/user/v1/private"):]
                controls = {"/status", "/setup", "/unlock", "/lock", "/activity", "/settings", "/transfer", "/cache/session", "/cache/keys",
                            "/passkeys", "/passkeys/unlock/options", "/passkeys/unlock/verify"}
                allowed = {"/list", "/search", "/stats", "/folders", "/files", "/files/check", "/files/info", "/files/instant", "/media/size", "/media/info", "/media/lookup", "/media/fetch", "/media/preview", "/media/save",
                           "/media/lyrics", "/media/subtitle", "/media/cover", "/media/extract", "/media/jobs", "/move", "/archive",
                           "/archive/inspect", "/archive/extract", "/archive/jobs", "/archive/browse", "/archive/entry", "/archive/compress",
                           "/copy", "/delete", "/thumbnail", "/thumbnail/status", "/thumbnail/claim", "/thumbnail/release", "/thumbnail/generate", "/thumbnail/cancel", "/thumbnail/progress",
                           "/thumbnail/fetch", "/content", "/preview-assets", "/preview-list",
                           "/trash", "/trash/restore", "/trash/purge", "/uploads",
                           "/downloads", "/downloads/clear", "/downloads/batch", "/downloads/destination", "/downloads/move"}
                if route not in controls:
                    if route not in allowed and not re.fullmatch(r"/uploads/[A-Za-z0-9_-]+(?:/complete|/parts/\d+)?|/downloads/\d+/(?:stop|resume|restart|delete|update|source|cover|now)|/archive/jobs/[0-9a-f]{16}/cancel", route):
                        raise NotFoundError("资源不存在")
                    file_user = self.private_space.files(token, access)
                    path = "/api/user/v1" + route
                if query.get("public", ["0"])[0] in ("1", "true"):
                    raise PermissionError("私密空间不能公开分享")
            if path == "/api/user/v1/files" and method == "PUT":
                size = int(headers["content-length"]) if "content-length" in headers else None
                public = query.get("public", [None])[0]
                # If-Match：文本编辑保存时带上打开时的 ETag，文件已在别处改动则返回 409，不覆盖。
                if_match = headers.get("if-match", "").strip().removeprefix("W/").strip('"') or None
                result = await file_user.put(token, csrf, query.get("path", [""])[0], body_stream(),
                                              headers.get("content-type"), size,
                                              None if public is None else public in ("1", "true"), if_match=if_match)
                await self._send(tracked_send, 200, result)
                return
            part_route = re.fullmatch(r"/api/user/v1/uploads/([A-Za-z0-9_-]+)/parts/(\d+)", path)
            if part_route and method == "PUT":
                size = int(headers["content-length"]) if "content-length" in headers else None
                result = await file_user.upload_part(token, csrf, part_route.group(1), int(part_route.group(2)), body_stream(), size)
                await self._send(tracked_send, 200, result)
                return
            if path == "/api/user/v1/thumbnail" and method == "GET":
                bucket_id = int(query["bucket_id"][0]) if "bucket_id" in query else None

                async def thumbnail():
                    data, mime, etag = await file_user.thumbnail(token, query.get("path", [""])[0], query.get("variant", ["thumb"])[0],
                                                                 bucket_id=bucket_id, etag=query.get("etag", [""])[0],
                                                                 known=self._validators(headers), version=query.get("v", [""])[0])
                    # 私密空间的缩略图同样按版本地址长期缓存：只有授权通过才会返回，删除或覆盖后地址随内容版本变化。
                    await self._send_thumbnail(tracked_send, headers, data, mime, etag, self._thumbnail_cache_control(query, etag))
                # 列表滚走、重新排序或离开目录时浏览器会放弃还没返回的缩略图请求：随之停止读取，释放小读取通道，
                # 否则这些没人要的请求会占满通道，让当前可见的缩略图排队超时（503）。
                await self._until_disconnect(receive, thumbnail())
                return
            if path == "/api/user/v1/avatar" and method == "GET":
                data, mime, etag = self.user.avatar(token)
                await self._send_thumbnail(tracked_send, headers, data, mime, etag, self._avatar_cache_control(query))
                return
            avatar_route = re.fullmatch(r"/api/admin/v1/users/(\d+)/avatar", path)
            if avatar_route and method == "GET":
                data, mime, etag = self.admin.user_avatar(token, int(avatar_route.group(1)))
                await self._send_thumbnail(tracked_send, headers, data, mime, etag, self._avatar_cache_control(query))
                return
            if path == "/api/user/v1/archive" and method == "GET":
                name, entries = await file_user.archive(token, query.get("path", []))
                await self._send_stream(tracked_send, 200, {"Content-Type": "application/zip", "Cache-Control": "no-store",
                    "Content-Disposition": f"attachment; filename=\"files.zip\"; filename*=UTF-8''{quote(name, safe='')}",
                    "X-Content-Type-Options": "nosniff"}, stream_zip(entries, nested=True), "GET")
                return
            if path == "/api/user/v1/archive/entry" and method == "GET":
                # 在线浏览压缩包：边读边解压其中一个文件（只支持 ZIP；不支持分段读取）。
                try:
                    index = int(query.get("index", [""])[0])
                except ValueError:
                    raise ValueError("条目编号不正确") from None
                name, size, stream = await self.archives.entry(file_user._scope(token), file_user._path(query.get("path", [""])[0]),
                                                               index, query.get("etag", [""])[0])
                disposition = "attachment" if query.get("download", ["0"])[0] == "1" else "inline"
                await self._until_disconnect(receive, self._send_stream(tracked_send, 200, {
                    "Content-Type": served_type(name, _archive_type(name)) or "application/octet-stream", "Content-Length": str(size),
                    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
                    "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(name, safe='')}"}, stream, "GET"))
                return
            if path == "/api/user/v1/content" and method in ("GET", "HEAD"):
                await self._until_disconnect(receive, self._content(tracked_send, method, token, query, headers, user=file_user, private=private))
                return
            if path.startswith("/api/admin/v1/backups/") and path != "/api/admin/v1/backups/settings" and method == "GET":
                await self._backup_download(tracked_send, token, path.rsplit("/", 1)[-1])
                return
            attachment = re.fullmatch(r"/api/user/v1/assistant/attachments(?:/([0-9a-f]{32})/(content|thumbnail))?", path)
            if attachment and self.assistant is not None and (method == "PUT" or attachment[1]):
                # 对话附件（§22.5）：上传与读取是流式的，不经过 JSON 请求体。
                if attachment[1] is None:
                    size = int(headers["content-length"]) if "content-length" in headers else None
                    result = await self.assistant.upload_attachment(token, csrf, query.get("name", [""])[0], headers.get("content-type"),
                                                                    body_stream(), size)
                    await self._send(tracked_send, 201, result)
                elif attachment[2] == "content" and method in ("GET", "HEAD"):
                    attachment_id = attachment[1]
                    info, _ = await self.assistant.attachment_content(token, attachment_id)
                    opener = lambda start, end: self.assistant.attachment_content(token, attachment_id, start, end)
                    await self._until_disconnect(receive, self._stream_object(tracked_send, method, info, opener, query, headers, "private, no-cache"))
                elif attachment[2] == "thumbnail" and method == "GET":
                    data, mime, etag = await self.assistant.read_attachment_thumbnail(token, attachment[1], query.get("variant", ["thumb"])[0])
                    await self._send_thumbnail(tracked_send, headers, data, mime, etag, "private, no-cache")
                else:
                    raise NotFoundError("资源不存在")
                return
            run_events = re.fullmatch(r"/api/user/v1/assistant/runs/([A-Za-z0-9_-]{4,40})/events", path)
            if run_events and method == "GET" and self.assistant is not None:
                after = query.get("after", ["0"])[0]
                events = self.assistant.events(token, run_events[1], int(after) if after.isdigit() else 0)
                await self._until_disconnect(receive, self._send_events(tracked_send, events))
                return
            sharer_avatar = re.fullmatch(r"/api/public/v1/objects/([A-Za-z0-9_-]+)/avatar", path)
            if sharer_avatar and method == "GET":
                info, password_hash = self._public_share(sharer_avatar.group(1))
                if password_hash and not self.share_access.check(sharer_avatar.group(1), password_hash, query.get("access", [None])[0]):
                    raise SharePasswordRequired("password required")
                sharer = self.user.accounts.sharer(info.bucket_id)
                if sharer is None or not sharer["avatar_version"]:
                    raise NotFoundError("头像不存在")
                data, mime, etag = self.user.accounts.avatar(int(sharer["user_id"]))
                await self._send_thumbnail(tracked_send, headers, data, mime, etag, self._avatar_cache_control(query))
                return
            folder_download = re.fullmatch(r"/api/public/v1/folders/([A-Za-z0-9_-]+)/download", path)
            if folder_download and method == "POST":
                if headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/x-www-form-urlencoded":
                    raise ValueError("下载请求必须使用表单编码")
                data = bytearray()
                async for chunk in body_stream():
                    if len(data) + len(chunk) > self.json_limit:
                        await self._send(tracked_send, 413, {"error": {"code": "body_too_large", "message": "所选文件过多，请分批下载"}})
                        return
                    data.extend(chunk)
                form = parse_qs(data.decode("utf-8"), keep_blank_values=True, max_num_fields=1003)
                await self._public_folder_download(tracked_send, folder_download.group(1), form)
                return
            data = bytearray()
            # 抓取脚本转交的页面快照最多 2 MB（JSON 编码后略大），其余接口沿用通用上限。
            body_limit = max(self.json_limit, 3 * 1024 * 1024) if re.fullmatch(
                r"/api/user/v1/assistant/conversations/[A-Za-z0-9_-]{4,40}/snapshots", path) else self.json_limit
            async for chunk in body_stream():
                if len(data) + len(chunk) > body_limit:
                    await self._send(tracked_send, 413, {"error": {"code": "body_too_large", "message": "JSON 请求体过大"}})
                    return
                data.extend(chunk)
            if method == "POST" and path in ("/api/user/v1/register", "/api/user/v1/registration/code"):
                if headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                    raise ValueError("注册请求必须使用 JSON 格式")
            payload = json.loads(data) if data else {}
            if not isinstance(payload, dict):
                raise ValueError("JSON 请求体必须为对象")
            if private and payload.get("public"):
                raise PermissionError("私密空间不能公开分享")
            audit = self._audit_entry(method, audit_path, payload, token, scope)
            try:
                status, result, extra = await self._route(method, path, query, payload, token, csrf,
                    ip=(scope.get("client") or [None])[0], user=file_user, private=private, access=access,
                    origin=headers.get("origin") or (f"{scope.get('scheme', 'http')}://{headers.get('host', '')}" if method == "GET" else None),
                    passkey_browser=cookies.get("tg_passkey", ""), cache_task=headers.get("x-tessera-cache-task", ""))
            except Exception as exc:
                if audit:
                    self._write_audit(audit, ok=False, error=exc)
                raise
            if audit:
                self._write_audit(audit, ok=True, result=result)
            if private:
                extra.update({"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
            await self._send(tracked_send, status, result, extra)
        except Exception as exc:
            error = self._error(exc)
            if error[0] == 500:
                # 只记录类型与调用位置，异常字符串、URL、查询参数都可能包含秘密。
                frames = traceback.extract_tb(exc.__traceback__)
                category = "admin" if path.startswith("/api/admin/") else "user" if path.startswith("/api/user/") else "key" if path.startswith("/api/v1/") else "public" if path.startswith("/p/") or path.startswith("/api/public/") else "other"
                log.error("request_failed id=%s method=%s category=%s elapsed_ms=%.0f error_type=%s stack=%s",
                          request_id, method, category, (time.monotonic() - request_start) * 1000, type(exc).__name__,
                          ";".join(f"{Path(frame.filename).name}:{frame.lineno}:{frame.name}" for frame in frames))
            if started:
                # 流已开始时交给 ASGI 服务器关闭连接，不能再发送第二个响应头。
                raise
            await self._send(tracked_send, *error)

    # (前缀, 路由模式) → 审计动作。路由中的 {} 匹配一个路径段。
    _AUDITED = {
        "/api/admin/v1": {"/setup": "system.setup", "/login": "admin.login", "/logout": "admin.logout",
                          "/unlock": "system.unlock", "/lock": "system.lock", "/users": "user.create",
                          "/users/{}/status": "user.status", "/users/{}/quota": "user.quota", "/clients": "key.create",
                          "/clients/{}/status": "client.status", "/clients/{}/grants": "client.grant",
                          "/client-keys/disable": "key.disable", "/client-keys/delete": "key.delete", "/clients/{}/delete": "client.delete",
                          "/bots": "bot.create", "/bots/{}/status": "bot.status",
                          "/bots/{}/check": "bot.check", "/telegram-bot": "telegram_bot.update", "/telegram-bot/delete": "telegram_bot.delete",
                          "/settings": "settings.update", "/resources": "resources.update",
                          "/registration": "registration.update", "/media/providers": "media.providers.update", "/registration/test-email": "registration.test_email",
                          "/registration/invites": "invite.create", "/registration/invites/{}/revoke": "invite.revoke",
                          "/maintenance/gc": "maintenance.gc", "/maintenance/scrub": "maintenance.scrub",
                          "/maintenance/cleanup": "maintenance.cleanup", "/maintenance/gc/retry": "maintenance.gc_retry",
                          "/audit/{}/delete": "audit.delete", "/audit/clear": "audit.clear",
                          "/backups/settings": "backup.settings", "/backups/delete": "backup.delete",
                          "/backups": "backup.create", "/password": "admin.password", "/passphrase": "system.passphrase",
                          "/users/{}/password": "user.password_reset", "/users/{}/delete": "user.delete",
                          "/assistant/settings": "assistant.settings", "/assistant/limits": "assistant.settings",
                          "/assistant/tools": "assistant.tools.update", "/assistant/channels": "assistant.channel.create",
                          "/assistant/channels/{}/update": "assistant.channel.update",
                          "/assistant/channels/{}/delete": "assistant.channel.delete",
                          "/assistant/channels/{}/sync": "assistant.channel.sync",
                          "/assistant/channels/{}/models": "assistant.model.create",
                          "/assistant/channels/{}/models/batch": "assistant.model.create",
                          "/assistant/catalog": "assistant.catalog.create", "/assistant/catalog/update": "assistant.catalog.update",
                          "/assistant/catalog/delete": "assistant.catalog.delete", "/assistant/catalog/sync": "assistant.catalog.sync",
                          "/assistant/catalog/settings": "assistant.catalog.settings",
                          "/assistant/models/{}/update": "assistant.model.update",
                          "/assistant/models/{}/delete": "assistant.model.delete",
                          "/assistant/models/{}/test": "assistant.model.test",
                          "/assistant/users/{}/policy": "assistant.user_policy",
                          "/assistant/conversations/delete": "assistant.trace.delete", "/assistant/purge": "assistant.data.purge"},
        "/api/user/v1": {"/login": "user.login", "/logout": "user.logout", "/password": "user.password", "/register": "user.register",
                         "/profile": "account.profile", "/email": "account.email", "/avatar": "account.avatar",
                         "/avatar/delete": "account.avatar_delete",
                         "/clients": "key.create", "/client-keys/disable": "key.disable", "/client-keys/delete": "key.delete", "/public": "object.public",
                         "/trash/purge": "trash.purge", "/downloads": "download.create", "/downloads/{}/stop": "download.stop",
                         "/downloads/{}/resume": "download.resume", "/downloads/{}/restart": "download.restart",
                         "/downloads/{}/delete": "download.delete", "/downloads/{}/update": "download.update",
                         "/downloads/{}/now": "download.now", "/downloads/move": "download.move",
                         "/downloads/clear": "download.clear", "/downloads/batch": "download.batch", "/downloads/stop-all": "download.stop_all", "/shares/{}/save": "share.save", "/archive/extract": "archive.extract", "/archive/compress": "archive.compress",
                         "/media/save": "media.save", "/private/media/save": "media.save", "/cache/reset": "client_cache.reset",
                         "/private/passkeys/unlock/verify": "private.passkey.unlock",
                         "/passkeys/register/verify": "passkey.create", "/passkeys/rename": "passkey.rename",
                         "/passkeys/delete": "passkey.delete", "/passkeys/enable-login": "passkey.enable",
                         "/passkeys/login/verify": "user.login",
                         "/assistant/scope-requests/{}/confirm": "assistant.scope.confirm",
                         "/assistant/scope-requests/{}/reject": "assistant.scope.reject",
                         "/assistant/actions/{}/confirm": "assistant.action.confirm",
                         "/assistant/actions/{}/reject": "assistant.action.reject",
                         "/assistant/actions/{}/cancel": "assistant.action.cancel",
                         "/assistant/actions/{}/undo": "assistant.action.undo",
                         "/assistant/attachments/{}/save": "assistant.attachment.save", "/telegram/unlink": "telegram.unlink"},
    }

    def _audit_entry(self, method, path, payload, token, scope):
        """在执行操作前确定审计动作与操作者（退出、锁定会清除会话，执行后就查不到了）。"""
        if method != "POST":
            return None
        for prefix, routes in self._AUDITED.items():
            if not path.startswith(prefix + "/"):
                continue
            route = path[len(prefix):]
            pattern = re.sub(r"^/(users|clients|bots|downloads|audit)/\d+/", r"/\1/{}/", route)
            pattern = re.sub(r"^/registration/invites/\d+/", "/registration/invites/{}/", pattern)
            pattern = re.sub(r"^/shares/[A-Za-z0-9_-]+/", "/shares/{}/", pattern)
            pattern = re.sub(r"^/assistant/(channels|models|users)/\d+/", r"/assistant/\1/{}/", pattern)
            pattern = re.sub(r"^/assistant/(scope-requests|actions|attachments)/[A-Za-z0-9_-]+/", r"/assistant/\1/{}/", pattern)
            action = routes.get(pattern)
            if action is None:
                return None
            session = self.admin.accounts.sessions.peek(token)
            # 文件空间接口现在也会收到管理员的会话：操作者类型取会话里的真实角色。
            role = "admin" if prefix.endswith("admin/v1") else (session.role if session else "user")
            actor = str(payload.get("username") or "") if action.endswith(".login") or action == "system.setup" else (session.username if session else None)
            # 分享令牌本身就是访问凭据，不写入审计。
            target_id = route.split("/")[pattern.split("/").index("{}")] if pattern.count("{}") and not pattern.startswith("/shares/") else None
            return {"action": action, "actor_type": role, "actor": actor or None, "payload": payload, "target_id": target_id,
                    "ip": (scope.get("client") or [None])[0]}
        return None

    def _write_audit(self, entry, *, ok, result=None, error=None):
        payload, action = entry["payload"], entry["action"]
        if action == "user.login" and ok and (result or {}).get("username"):
            entry = {**entry, "actor": result["username"]}
        if action == "user.register" and ok:
            entry = {**entry, "actor": (result or {}).get("username"), "actor_type": "user"}
        if action == "user.login" and ok and (result or {}).get("role") == "admin":
            # 统一登录入口：管理员登录在审计里仍记为 admin.login。
            action, entry = "admin.login", {**entry, "actor_type": "admin"}
        # 只挑选非敏感字段：从不记录 password / passphrase / token / secret。
        target, detail = entry["target_id"], {}
        if action in ("user.create",):
            target, detail = payload.get("username"), {"quota_bytes": payload.get("quota_bytes")}
        elif action == "user.register":
            target = (result or {}).get("username") if ok else None
            detail = {"method": payload.get("method") if payload.get("method") in ("email", "invite") else None}
            if ok:
                detail["quota_bytes"] = (result or {}).get("quota_bytes")
        elif action == "registration.update":
            detail = {key: payload[key] for key in ("enabled", "email_enabled", "invite_enabled", "default_quota_bytes") if key in payload}
            if "smtp" in payload or "smtp_password" in payload or "clear_smtp_password" in payload:
                detail["smtp_changed"] = True
        elif action == "invite.create":
            detail = {key: payload[key] for key in ("count", "quota_bytes", "expires_at") if key in payload}
        elif action in ("user.status", "client.status", "bot.status"):
            detail = {"status": payload.get("status")}
        elif action == "user.quota":
            detail = {"quota_bytes": payload.get("quota_bytes")}
        elif action == "key.create":
            target = (result or {}).get("access_key_id") if ok else None
            detail = {}
        elif action in ("key.disable", "key.delete"):
            target = payload.get("access_key_id")
        elif action == "client.grant":
            detail = {key: payload.get(key) for key in ("bucket_id", "perms")}
        elif action == "bot.create":
            target, detail = payload.get("name"), {"channel_id": payload.get("channel_id")}
        elif action == "telegram_bot.update":
            # token 不写入审计，只记是否更换以及启用状态。
            detail = {"token_changed": bool(payload.get("token")), **({"enabled": bool(payload["enabled"])} if "enabled" in payload else {})}
            if ok:
                target = (result or {}).get("username")
        elif action == "bot.check" and ok:
            detail = {"status": (result or {}).get("status")}
        elif action in ("audit.delete", "audit.clear") and ok:
            detail = {"deleted": (result or {}).get("deleted")}
        elif action == "backup.settings" and ok:
            detail = {"keep": (result or {}).get("keep")}
        elif action == "backup.delete" and ok:
            target = (result or {}).get("name")
        elif action == "resources.update":
            detail = {key: payload.get(key) for key in ("mode", "concurrency", "bandwidth_kib", "reserve_mib", "hls_enabled", "x_enabled", "youtube_enabled", "youtube_max_height", "platform_max_mib", "transfer_concurrency", "bucket_concurrency", "upload_concurrency", "upload_kib", "bot_interval_ms", "web_part_concurrency", "web_file_concurrency", "thumbnail_concurrency", "download_memory_percent", "video_concurrency", "thumbnail_cache_mib", "download_connections") if key in payload}
            if "proxy" in payload:
                # 代理地址可能包含认证信息，审计只记录是否启用。
                detail["proxy_enabled"] = bool(payload.get("proxy"))
        elif action == "download.create":
            detail = {"count": len(payload.get("items", [])) if isinstance(payload.get("items"), list) else 0}
        elif action == "archive.extract":
            # 不记录压缩包与保存位置的路径，更不记录密码。
            detail = {"conflict": payload.get("conflict") if payload.get("conflict") in ("skip", "overwrite", "rename") else None,
                      "keep": payload.get("keep_archive") is not False or payload.get("entries") is not None, "format": (result or {}).get("format") if ok else None,
                      "partial": payload.get("entries") is not None}
        elif action == "archive.compress":
            # 只记数量与压缩方式，不记路径。
            detail = {"count": len(payload.get("paths", [])) if isinstance(payload.get("paths"), list) else 0,
                      "compression": "store" if payload.get("compression") == "store" else "deflate"}
        elif action == "media.providers.update":
            # 只记启用状态与是否改了配置；配置值（含令牌、账号）一律不记。
            providers = payload.get("providers") if isinstance(payload.get("providers"), dict) else {}
            detail = {"enabled": {key: value["enabled"] for key, value in providers.items() if isinstance(value, dict) and isinstance(value.get("enabled"), bool)},
                      "configured": sorted(key for key, value in providers.items() if isinstance(value, dict) and (value.get("config") or value.get("clear")))}
        elif action == "media.save":
            # 不记录文件路径、查询词或歌词字幕内容。
            detail = {key: (result or {}).get(key) for key in ("provider", "format", "replaced")} if ok else {}
        elif action == "share.save":
            detail = {"saved": (result or {}).get("saved"), "bytes": (result or {}).get("bytes")} if ok else {}
        elif action == "assistant.attachment.save":
            detail = {"bytes": (result or {}).get("size")} if ok else {}
        elif action == "download.batch":
            ids = payload.get("ids")
            detail = {"action": payload.get("action") if payload.get("action") in ("stop", "resume", "delete") else None,
                      "count": len(ids) if isinstance(ids, list) else 0, "done": (result or {}).get("done") if ok else None}
        elif action == "download.stop_all":
            detail = {"stopped": (result or {}).get("stopped") if ok else None}
        elif action == "download.move":
            # 不记录保存位置的路径。
            ids = payload.get("ids")
            detail = {"count": len(ids) if isinstance(ids, list) else 0, "moved": (result or {}).get("moved") if ok else None}
        elif action == "download.now":
            detail = {"yielded": bool((result or {}).get("victim")) if ok else None}
        elif action == "download.clear":
            detail = {"status": payload.get("status") if payload.get("status") in ("completed", "failed") else None,
                      "removed": (result or {}).get("removed") if ok else None}
        elif action.startswith(("private.passkey.", "passkey.")):
            # 不记录凭据原文、公钥、挑战或用户填写的凭据名称。
            identifier = (result or {}).get("id") if action.endswith(".create") and ok else payload.get("id")
            target = str(identifier) if isinstance(identifier, int) and not isinstance(identifier, bool) else None
            detail = {"method": "passkey"}
        elif action in ("user.login", "admin.login") and "credential" in payload:
            detail = {"method": "passkey"}
        elif action == "object.public":
            paths = payload["paths"] if isinstance(payload.get("paths"), list) else [payload.get("path")]
            detail = {"count": len(paths), "public": bool(payload.get("public")), **({"bucket_id": payload["bucket_id"]} if "bucket_id" in payload else {})}
            if "expires_at" in payload:
                detail["expires_at"] = payload["expires_at"]
            if "password" in payload:
                detail["password"] = "set" if payload["password"] else "cleared"
        elif action == "account.email":
            # 新登录邮箱记为目标，便于追溯账号改名；不记录确认用的密码。
            target = (result or {}).get("username") if ok else None
        elif action == "user.delete":
            detail = {"deleted_objects": (result or {}).get("deleted_objects")} if ok else {}
            target = (result or {}).get("username") if ok else target
        elif action == "trash.purge":
            detail = {"purged": (result or {}).get("purged")} if ok else {}
        elif action == "settings.update":
            detail = {key: value for key, value in payload.items() if key in ("public_base_url", "s3_endpoint")}
        elif action in ("maintenance.gc", "maintenance.scrub") and ok:
            detail = {key: value for key, value in (result or {}).items() if key in ("processed", "deleted", "failed", "checked")}
            if action == "maintenance.scrub":
                detail["bad"] = len((result or {}).get("bad", []))
        elif action == "assistant.settings":
            detail = {"keys": sorted(str(key) for key in payload)[:20],
                      **{key: payload[key] for key in ("enabled", "default_model", "full_access") if key in payload}}
        elif action == "assistant.tools.update":
            detail = {"tools": {str(name): value.get("enabled") for name, value in payload.items()
                                if isinstance(value, dict) and "enabled" in value}}
        elif action in ("assistant.channel.create", "assistant.channel.update"):
            # 不记录 API Key 与请求头的值，只记录是否修改。
            detail = {key: payload.get(key) for key in ("name", "kind", "protocol", "enabled", "concurrency", "timeout") if key in payload}
            if "api_key" in payload:
                detail["api_key"] = "changed"
            if "headers" in payload:
                detail["headers"] = "changed"
            if action.endswith(".create"):
                target = (result or {}).get("id") if ok else None
        elif action == "assistant.channel.sync" and ok:
            detail = {key: (result or {}).get(key) for key in ("total", "added", "removed")}
        elif action == "assistant.model.create":
            if isinstance(payload.get("models"), list):
                detail = {"models": [str(name)[:200] for name in payload["models"][:50]], "added": (result or {}).get("added") if ok else None}
            else:
                detail = {"model": str(payload.get("model", ""))[:200]}
        elif action in ("assistant.catalog.create", "assistant.catalog.update", "assistant.catalog.delete"):
            detail = {"id": str(payload.get("id") or f"{payload.get('provider')}/{payload.get('model')}")[:260]}
        elif action == "assistant.catalog.sync" and ok:
            detail = {key: (result or {}).get(key) for key in ("total", "added", "updated")}
        elif action == "assistant.catalog.settings":
            detail = {key: payload.get(key) for key in ("url", "auto_sync") if key in payload}
        elif action == "assistant.model.update":
            detail = {key: payload.get(key) for key in ("enabled", "tools", "context_window", "max_output") if key in payload}
        elif action == "assistant.model.test" and ok:
            detail = {"ok": (result or {}).get("ok"), "tools": (result or {}).get("tools")}
        elif action == "assistant.user_policy":
            detail = {key: payload.get(key) for key in ("enabled", "max_level", "daily_tokens", "full_access", "private") if key in payload}
        elif action.startswith(("assistant.action.", "private.assistant.action.")) and ok:
            # 只记录操作类型、状态与条目数，不记录路径、链接等条目内容。
            detail = {key: (result or {}).get(key) for key in ("kind", "status", "count")}
        elif action == "assistant.trace.delete":
            detail = {"user_id": payload.get("user_id"), "before": payload.get("before"),
                      "deleted": (result or {}).get("deleted") if ok else None}
        if error is not None:
            detail["error"] = self._error(error)[1]["error"]["code"]
        try:
            self.audit.record(action, actor_type=entry["actor_type"], actor=entry["actor"], ok=ok, target=target,
                              detail=detail or None, ip=entry["ip"])
        except Exception:
            # 审计写入失败不能影响业务请求本身（例如系统已锁定或数据库短暂繁忙）。
            pass

    async def _backup_download(self, send, token, name):
        self.admin.accounts.sessions.require(token, role="admin")
        path = self.admin.backup_path(token, name)
        try:
            handle = path.open("rb")
        except FileNotFoundError as exc:
            raise NotFoundError("备份不存在") from exc
        # 先打开文件再发送响应头，删除或轮换备份不会中断已经开始的下载。
        with handle:
            size = os.fstat(handle.fileno()).st_size
            await send({"type": "http.response.start", "status": 200, "headers": self._headers({
                "Content-Type": "application/octet-stream", "Content-Length": str(size), "Cache-Control": "no-store",
                "Content-Disposition": f"attachment; filename={name}", "X-Content-Type-Options": "nosniff"})})
            while chunk := await asyncio.to_thread(handle.read, 1 << 20):
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
        await send({"type": "http.response.body", "body": b""})
        self.audit.record("backup.download", actor_type="admin", actor=self.admin.accounts.sessions.peek(token).username,
                          ok=True, target=name)

    async def _key_api(self, send, method, route, query, headers, body_stream):
        """访问密钥 API：不读取 Cookie、不校验 CSRF，权限完全由密钥授权决定。"""
        if self.keys is None:
            raise NotFoundError("接口不存在")
        if not self.user.accounts.keystore.unlocked:
            raise NotReadyError("system is locked")
        principal = self.keys.authenticate(headers.get("authorization"))
        arg = lambda name, default="": query.get(name, [default])[0]
        bucket = arg("bucket") or None
        if route == "/files" and method == "PUT":
            size = int(headers["content-length"]) if "content-length" in headers else None
            public = query.get("public", [None])[0]
            result = await self.keys.put(principal, bucket, arg("path"), body_stream(), headers.get("content-type"), size,
                                         None if public is None else public in ("1", "true"))
            await self._send(send, 200, result)
            return
        if route == "/content" and method in ("GET", "HEAD"):
            info, opener = await self.keys.content(principal, bucket, arg("path"))
            await self._stream_object(send, method, info, opener, query, headers, "private")
            return
        data = bytearray()
        async for chunk in body_stream():
            if len(data) + len(chunk) > self.json_limit:
                await self._send(send, 413, {"error": {"code": "body_too_large", "message": "JSON 请求体过大"}})
                return
            data.extend(chunk)
        payload = json.loads(data) if data else {}
        if not isinstance(payload, dict):
            raise ValueError("JSON 请求体必须为对象")
        bucket = payload.get("bucket") or bucket
        if method == "GET" and route == "/me":
            result = self.keys.whoami(principal)
        elif method == "GET" and route == "/list":
            result = await self.keys.list(principal, bucket, arg("prefix"), arg("cursor") or None, int(arg("limit", "1000")))
        elif method == "GET" and route == "/search":
            result = await self.keys.search(principal, bucket, arg("q"), arg("cursor"), int(arg("limit", "100")))
        elif method == "POST" and route == "/files/instant":
            public = payload.get("public")
            result = await self.keys.instant(principal, bucket, payload["path"], payload["size"], payload["fingerprint"],
                                             payload.get("content_type"), None if public is None else bool(public))
        elif method == "GET" and route == "/folders":
            result = await self.keys.folders(principal, bucket, arg("prefix"), arg("cursor"), int(arg("limit", "100")))
        elif method == "POST" and route == "/folders":
            await self._send(send, 201, await self.keys.folder(principal, bucket, payload["path"]))
            return
        elif method == "POST" and route == "/delete":
            result = {"results": await self.keys.delete(principal, bucket, list(payload["paths"]), bool(payload.get("recursive", False)))}
        elif method == "POST" and route == "/move":
            result = await self.keys.move_many(principal, bucket, payload["items"], payload.get("conflict", "skip")) if "items" in payload \
                else self.keys.move(principal, bucket, payload["from"], payload["to"], payload.get("conflict", "skip"))
        elif method == "POST" and route == "/copy":
            await self._send(send, 201, await self.keys.copy(principal, bucket, payload["from"], payload["to"]))
            return
        elif method == "GET" and route == "/public":
            result = self.keys.list_public(principal, bucket)
        elif method == "POST" and route == "/public":
            paths = payload["paths"] if "paths" in payload else [payload["path"]]
            if not isinstance(paths, list):
                raise ValueError("paths 必须为数组")
            entry = {"action": "object.public", "actor_type": "key", "actor": principal.access_key_id, "payload": payload,
                     "target_id": None, "ip": None}
            try:
                options = self._share_options(payload)
                encoded = self.user.objects._UNSET
                if payload["public"] and options.get("password"):
                    encoded = await self.user.accounts.password_work.run(hash_password, str(options["password"]), min_length=4)
                    principal = self.keys.authenticate(headers.get("authorization"))
                result = {"objects": self.keys.set_public(principal, bucket, paths, bool(payload["public"]), options, password_hash=encoded)}
            except Exception as exc:
                self._write_audit(entry, ok=False, error=exc)
                raise
            self._write_audit(entry, ok=True)
        elif method == "GET" and route == "/downloads" and self.offline is not None:
            user_id, permits = self.keys.download_reader(principal, bucket)
            try:
                ids = [int(value) for value in arg("ids").split(",") if value.strip()]
            except ValueError as exc:
                raise ValueError("ids 应为逗号分隔的任务编号") from exc
            result = {"tasks": self.offline.status_of(user_id, ids, permits)}
        elif method == "POST" and route == "/downloads/parse" and self.offline is not None:
            user_id = self.keys.download_owner(principal, bucket)[0]
            result = await self.offline.parse(user_id, payload.get("input"), download_type=payload.get("download_type", "auto"),
                                              cookies=payload.get("cookies", ""))
        elif method == "POST" and route == "/downloads/parse-batch" and self.offline is not None:
            user_id = self.keys.download_owner(principal, bucket)[0]
            result = await self.offline.parse_batch(user_id, payload.get("items"))
        elif method == "POST" and route == "/downloads" and self.offline is not None:
            entry = {"action": "download.create", "actor_type": "key", "actor": principal.access_key_id, "payload": payload,
                     "target_id": None, "ip": None}
            try:
                user_id, destination, scope = self.keys.download_scope(principal, bucket, payload.get("destination"))
                result = {"tasks": self.offline.create(user_id, payload.get("items"), destination, key_scope=scope)}
            except Exception as exc:
                self._write_audit(entry, ok=False, error=exc)
                raise
            self._write_audit(entry, ok=True)
            await self._send(send, 201, result)
            return
        else:
            raise NotFoundError("接口不存在")
        await self._send(send, 200, result)

    async def _route(self, method, path, query, payload, token, csrf, ip=None, *, user=None, private=False, access="", origin=None, passkey_browser="", cache_task=""):
        user = user or self.user
        if path.startswith("/api/admin/v1/"):
            route = path[len("/api/admin/v1"):]
            if method == "GET" and route == "/status":
                return 200, self.admin.status(), {}
            if method == "POST" and route == "/setup":
                result = await self.admin.asetup(payload["passphrase"], payload["username"], payload["password"], payload.get("nickname"))
                return 201, result, {}
            if method == "POST" and route == "/login":
                return self._login(await self.admin.alogin(payload["username"], payload["password"], ip))
            # 除首次设置和登录外，修改操作统一要求管理员会话和 CSRF。
            session = self.admin.accounts.sessions.require(token, role="admin", csrf=csrf,
                                                           mutation=method != "GET")
            self.admin.accounts.account_for_session(session)
            if method == "GET" and route == "/me":
                return 200, {**self.admin.me(token), **self.settings.public_config()}, {}
            if method == "GET" and route == "/audit":
                before = query.get("cursor", [""])[0]
                return 200, await self.admin.accounts.metadata.run_in_thread(self.audit.list, before=int(before) if before else None, limit=int(query.get("limit", ["50"])[0]),
                                            action=query.get("action", [""])[0] or None,
                                            failed_only=query.get("failed", ["0"])[0] in ("1", "true")), {}
            if method == "POST" and re.fullmatch(r"/audit/\d+/delete", route):
                return 200, await self.admin.accounts.metadata.run_in_thread(self.audit.delete, int(route.split("/")[2])), {}
            if method == "POST" and route == "/audit/clear":
                if payload.get("confirm") != "清空":
                    raise ValueError("请输入“清空”确认")
                return 200, await self.admin.accounts.metadata.run_in_thread(self.audit.clear), {}
            if method == "GET" and route == "/settings":
                return 200, self.settings.describe(), {}
            if method == "GET" and route == "/version":
                # 只给管理员看：公开接口不暴露版本号。
                return 200, {"version": __version__}, {}
            if method == "POST" and route == "/settings":
                return 200, self.settings.update(payload), {}
            if route == "/resources" and self.resources is not None:
                if method == "GET":
                    return 200, self.resources.describe(), {}
                if method == "POST":
                    return 200, self.resources.update(payload), {}
            if method == "POST" and route == "/unlock":
                return 200, await self.admin.aunlock(token, csrf, payload["passphrase"]), {}
            if method == "POST" and route == "/lock":
                self.admin.lock(token, csrf)
                return 204, None, {"Set-Cookie": self._cookie("", expires=True)}
            if method == "POST" and route == "/logout":
                self.admin.logout(token)
                return 204, None, {"Set-Cookie": self._cookie("", expires=True)}
            if not self.admin.accounts.keystore.unlocked:
                raise NotReadyError("系统尚未解锁")
            if route == "/media/providers":
                if method == "GET":
                    return 200, self.media.describe(), {}
                if method == "POST":
                    return 200, self.media.configure(payload), {}
            provider_test = re.fullmatch(r"/media/providers/([a-z0-9_-]{1,32})/test", route)
            if provider_test and method == "POST":
                return 200, await self.media.test(provider_test[1]), {}
            if route == "/registration":
                if method == "GET":
                    return 200, self.registration.describe(), {}
                if method == "POST":
                    return 200, self.registration.configure(payload), {}
            if route == "/registration/test-email" and method == "POST":
                def authorize_mail():
                    current = self.admin.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
                    self.admin.accounts.account_for_session(current)
                    self.admin.accounts.keystore.require_kek()
                return 200, await self.registration.test_email(payload.get("email", session.username), authorize_mail), {}
            if route == "/registration/invites":
                if method == "GET":
                    return 200, self.registration.list_invitations(int(query.get("cursor", ["0"])[0]), query.get("status", ["all"])[0], int(query.get("limit", ["50"])[0])), {}
                if method == "POST":
                    return 201, self.registration.create_invitations(payload, session.user_id), {}
            invite_route = re.fullmatch(r"/registration/invites/(\d+)/revoke", route)
            if invite_route and method == "POST":
                self.registration.revoke_invitation(int(invite_route[1]))
                return 204, None, {}
            if route.startswith("/assistant/") and self.assistant is not None:
                return await self._assistant_admin(method, route[len("/assistant"):], query, payload, session)
            if method == "GET" and route == "/users":
                return 200, await self.admin.alist_users(token, limit=int(query["limit"][0]) if "limit" in query else None,
                    cursor=int(query.get("cursor", ["0"])[0]), query=query.get("q", [""])[0], status=query.get("status", [""])[0]), {}
            if method == "GET" and route == "/users/summary":
                return 200, await self.admin.auser_summary(token), {}
            if method == "GET" and route == "/clients":
                return 200, await self.admin.alist_clients(token, limit=int(query["limit"][0]) if "limit" in query else None,
                    cursor=int(query.get("cursor", ["0"])[0])), {}
            if method == "GET" and route == "/bots":
                return 200, await self.admin.list_bots(token), {}
            if route in ("/telegram-bot", "/telegram-bot/delete") and self.telegram_bot is not None:
                self.admin.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=method != "GET")
                if method == "GET" and route == "/telegram-bot":
                    return 200, self.telegram_bot.admin_status(), {"Cache-Control": "no-store"}
                if method == "POST" and route == "/telegram-bot":
                    return 200, await self.telegram_bot.configure(payload.get("token"), payload.get("enabled")), {}
                if method == "POST":
                    return 200, self.telegram_bot.remove(), {}
            if method == "POST" and route == "/users":
                quota = payload.get("quota_bytes")
                return 201, await self.admin.acreate_user(token, csrf, payload["username"], payload["password"],
                                                    int(quota) if quota is not None and quota != "" else None, payload.get("nickname")), {}
            if method == "POST" and route == "/clients":
                return 201, self.admin.create_client(token, csrf, payload["name"], payload.get("grants", [])), {}
            if method == "POST" and route == "/bots":
                return 201, self.admin.create_bot(token, csrf, payload["name"], payload["token"], payload["channel_id"]), {}
            if route.startswith("/bots/") and route.endswith("/check") and method == "POST":
                return 200, await self.admin.check_bot(token, csrf, int(route.split("/")[2])), {}
            if route.startswith("/bots/") and route.endswith("/status") and method == "POST":
                bot_id = int(route.split("/")[2])
                self.admin.set_bot_status(token, csrf, bot_id, payload["status"])
                return 204, None, {}
            if method == "GET" and route == "/objects/summary":
                return 200, await self.admin.object_summary(token), {}
            if route.startswith("/users/") and method == "POST" and route.endswith("/delete"):
                return 200, await self.admin.delete_user(token, csrf, int(route.split("/")[2]), str(payload.get("confirm", ""))), {}
            if route.startswith("/users/") and method == "POST" and route.endswith("/password"):
                await self.admin.areset_user_password(token, csrf, int(route.split("/")[2]), payload["password"])
                return 204, None, {}
            if method == "POST" and route == "/password":
                await user.achange_password(token, csrf, payload["old_password"], payload["new_password"])
                return 204, None, {}
            if method == "POST" and route == "/passphrase":
                return 200, await self.admin.achange_passphrase(token, csrf, payload["old_passphrase"], payload["new_passphrase"]), {}
            if method == "GET" and route == "/maintenance/status":
                return 200, self.admin.maintenance_status(token), {}
            if method == "GET" and route == "/maintenance/thumbnails":
                return 200, self.thumbnails.status(), {"Cache-Control": "no-store"}
            if method == "POST" and route == "/maintenance/cleanup":
                return 200, await self.admin.run_cleanup(token, csrf), {}
            if method == "POST" and route == "/maintenance/gc/retry":
                return 200, self.admin.retry_gc(token, csrf), {}
            if method == "GET" and route == "/backups":
                return 200, await self.admin.list_backups(token), {}
            if method == "GET" and route == "/backups/settings":
                return 200, self.admin.backup_settings(token), {}
            if method == "POST" and route == "/backups/settings":
                return 200, await self.admin.configure_backups(token, csrf, payload.get("keep")), {}
            if method == "POST" and route == "/backups/delete":
                name = payload.get("name")
                if not isinstance(name, str):
                    raise ValueError("请选择要删除的备份")
                return 200, await self.admin.delete_backup(token, csrf, name), {}
            if method == "POST" and route == "/backups":
                return 201, await self.admin.create_backup(token, csrf), {}
            if route.startswith("/users/") and method == "POST" and route.endswith("/quota"):
                user_id = int(route.split("/")[2])
                quota = payload.get("quota_bytes")
                self.admin.set_user_quota(token, csrf, user_id, int(quota) if quota is not None else None)
                return 204, None, {}
            if route.startswith("/users/") and method == "POST" and route.endswith("/status"):
                user_id = int(route.split("/")[2])
                self.admin.set_user_status(token, csrf, user_id, payload["status"])
                return 204, None, {}
            if route.startswith("/clients/") and route.endswith("/status") and method == "POST":
                client_id = int(route.split("/")[2])
                self.admin.set_client_status(token, csrf, client_id, payload["status"])
                return 204, None, {}
            if route == "/client-keys/disable" and method == "POST":
                self.admin.disable_client_key(token, csrf, payload["access_key_id"])
                return 204, None, {}
            if route == "/client-keys/delete" and method == "POST":
                self.admin.delete_client_key(token, csrf, payload["access_key_id"])
                return 204, None, {}
            if route.startswith("/clients/") and route.endswith("/delete") and method == "POST":
                self.admin.delete_client(token, csrf, int(route.split("/")[2]))
                return 204, None, {}
            if route.startswith("/clients/") and route.endswith("/grants") and method == "POST":
                client_id = int(route.split("/")[2])
                self.admin.grant_client(token, csrf, client_id, int(payload["bucket_id"]),
                                        str(payload.get("prefix", "")), str(payload.get("perms", "ro")))
                return 204, None, {}
            if method == "POST" and route == "/maintenance/gc":
                return 200, await self.admin.run_gc(token, csrf, int(payload.get("limit", 100))), {}
            if method == "POST" and route == "/maintenance/scrub":
                return 200, await self.admin.run_scrub(token, csrf, int(payload.get("limit", 100)),
                                                       bool(payload.get("deep", False))), {}
        elif path.startswith("/api/user/v1/"):
            route = path[len("/api/user/v1"):]
            if route == "/registration" and method == "GET":
                return 200, self.registration.public_config(), {}
            if route in ("/register", "/registration/code") and method == "POST":
                # 公共注册接口仅接受 JSON；浏览器跨站表单无法携带 JSON，且不开放 CORS。
                if origin is not None:
                    from .settings import normalize_origin
                    expected = self.settings.get("public_base_url")
                    if expected and normalize_origin(origin, "请求来源") != expected:
                        raise PermissionError("注册请求来源不匹配")
                if route == "/registration/code":
                    return 200, await self.registration.send_code(payload.get("email"), ip), {}
                return 201, await self.registration.register(payload, ip), {}
            if route == "/passkeys/status" and method == "GET":
                return 200, self.passkeys.capability(None, origin), {"Cache-Control": "no-store"}
            if route == "/passkeys/login/options" and method == "POST":
                browser_token = secrets.token_urlsafe(32)
                result = self.passkeys.login_options(origin, browser_token, ip, remember=payload.get("remember") is True)
                cookie = f"tg_passkey={browser_token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age={self.passkeys.CHALLENGE_SECONDS}"
                if self.secure_cookies:
                    cookie += "; Secure"
                return 200, result, {"Set-Cookie": cookie, "Cache-Control": "no-store"}
            if route == "/passkeys/login/verify" and method == "POST":
                session = await self.passkeys.login(passkey_browser, payload.get("request_id"), payload.get("credential"), origin, ip)
                return self._login(AdminApi._session_payload(session))
            if route == "/passkeys" and method == "GET":
                return 200, self.passkeys.list(token, origin), {"Cache-Control": "no-store"}
            if route == "/passkeys/register/options" and method == "POST":
                return 200, await self.passkeys.registration_options(token, csrf, payload.get("password"), payload.get("name"), origin, ip), {}
            if route == "/passkeys/register/verify" and method == "POST":
                return 201, await self.passkeys.register(token, csrf, payload.get("request_id"), payload.get("credential"), origin, ip), {}
            if route in ("/passkeys/rename", "/passkeys/delete", "/passkeys/enable-login") and method == "POST":
                return 200, await self.passkeys.manage(token, csrf, payload.get("password"), payload.get("id"),
                    name=payload.get("name"), delete=route.endswith("/delete"), enable_login=route.endswith("/enable-login"), ip=ip), {}
            shared = re.fullmatch(r"/shares/([A-Za-z0-9_-]{8,64})/(status|save)", route)
            if shared and shared[2] == "status" and method == "GET":
                return 200, user.share_status(token, shared[1]), {"Cache-Control": "no-store"}
            if shared and shared[2] == "save" and method == "POST":
                # 与访客读取文件一致：有密码的分享需要先在分享页通过验证，带上 access 令牌。
                _, password_hash = self._public_share(shared[1])
                if password_hash and not self.share_access.check(shared[1], password_hash, payload.get("access")):
                    raise SharePasswordRequired("password required")
                return 200, await user.save_share(token, csrf, shared[1], payload.get("destination", ""), payload.get("paths")), {}
            if route == "/usage" and method == "GET" and not private:
                return 200, user.usage(token), {"Cache-Control": "no-store"}
            if route == "/favorites" and not private:
                if method == "GET":
                    return 200, user.favorites(token), {"Cache-Control": "no-store"}
                if method == "PUT":
                    return 200, user.set_favorites(token, csrf, payload.get("items"), payload.get("paths")), {"Cache-Control": "no-store"}
            if route.startswith("/cache/") and method == "POST" and not private:
                # 缓存响应一律不进入 HTTP 缓存。任务读取复用登录会话；
                # 创建私密任务要求当前已解锁，创建任务与重置纪元要求 CSRF。
                if route == "/cache/session":
                    return 200, self.client_cache.session(token, payload.get("device")), {"Cache-Control": "no-store"}
                if route == "/cache/check":
                    return 200, self.client_cache.check(token, payload.get("etags")), {"Cache-Control": "no-store"}
                if route == "/cache/reset":
                    return 200, self.client_cache.reset(token, csrf), {"Cache-Control": "no-store"}
                if route == "/cache/tasks":
                    return 201, self.client_cache.start_task(token, csrf, access,
                                                           payload.get("device"), payload.get("id"), payload.get("paths")), {"Cache-Control": "no-store"}
                if route == "/cache/tasks/keys":
                    return 200, self.client_cache.task_key(token, cache_task,
                                                         payload.get("path"), payload.get("etag")), {"Cache-Control": "no-store"}
                if route == "/cache/tasks/release":
                    return 200, self.client_cache.finish_task(token, cache_task), {"Cache-Control": "no-store"}
            if route == "/upload-config" and method == "GET" and not private:
                # 网页上传的并发由管理员在「下载与资源」配置；只返回这几个数值，不暴露其他资源配置。
                user._scope(token)
                effective = self.resources.effective() if self.resources is not None else {}
                # read_concurrency：每个账号同时读取的路数，本机缓存据此决定并行下载的段数。
                return 200, {"part_concurrency": effective.get("web_part_concurrency", 4),
                             "file_concurrency": effective.get("web_file_concurrency", 2),
                             "read_concurrency": effective.get("bucket_concurrency", 2),
                             # diagnostics：管理员是否开放本机缓存与离线下载的诊断弹窗。
                             "diagnostics": effective.get("diagnostics", True)}, {"Cache-Control": "no-store"}
            if route.startswith("/assistant/") and self.assistant is not None:
                return await self._assistant_user(method, route[len("/assistant"):], query, payload, token, csrf,
                                                  origin=origin, ip=ip)
            if route.startswith("/downloads") and self.offline is not None:
                session = user._session(token, csrf=csrf, mutation=method != "GET")
                account = user.accounts.account_for_session(session)
                private_scope = user._scope(token, csrf=csrf, mutation=method != "GET") if private else None
                if route == "/downloads/parse" and method == "POST":
                    return 200, await self.offline.parse(account.id, payload.get("input"), download_type=payload.get("download_type", "auto"), cookies=payload.get("cookies", "")), {"Cache-Control": "no-store"}
                if route == "/downloads" and method == "GET":
                    try:
                        ids = [int(value) for value in query["ids"][0].split(",") if value.strip()] if "ids" in query else None
                    except ValueError as exc:
                        raise ValueError("ids 应为逗号分隔的任务编号") from exc
                    return 200, self.offline.list(account.id, cursor=int(query.get("cursor", ["0"])[0] or "0"), status=query.get("status", [""])[0], query=query.get("q", [""])[0], limit=int(query.get("limit", ["50"])[0]), private_scope=private_scope, ids=ids), {"Cache-Control": "no-store"}
                if route == "/downloads" and method == "POST":
                    return 201, {"tasks": self.offline.create(account.id, payload.get("items"), payload.get("destination", ""), private_scope=private_scope)}, {"Cache-Control": "no-store"}
                if route == "/downloads/destination" and method == "GET":
                    return 200, self.offline.last_destination(account.id, private_scope=private_scope), {"Cache-Control": "no-store"}
                cover = re.fullmatch(r"/downloads/(\d+)/cover", route)
                if cover and method == "POST":
                    return 200, await self.offline.set_cover(account.id, int(cover[1]), payload.get("images"), private_scope=private_scope), {"Cache-Control": "no-store"}
                if route == "/downloads/clear" and method == "POST":
                    return 200, await self.offline.clear(account.id, payload.get("status")), {"Cache-Control": "no-store"}
                if route == "/downloads/stop-all" and method == "POST" and not private:
                    return 200, await self.offline.stop_all(account.id), {"Cache-Control": "no-store"}
                if route == "/downloads/batch" and method == "POST":
                    return 200, await self.offline.batch(account.id, payload.get("action"), payload.get("ids"), private_scope=private_scope), {"Cache-Control": "no-store"}
                if route == "/downloads/move" and method == "POST":
                    return 200, self.offline.relocate(account.id, payload.get("ids"), payload.get("destination", ""), private_scope=private_scope), {"Cache-Control": "no-store"}
                now = re.fullmatch(r"/downloads/(\d+)/now", route)
                if now and method in ("GET", "POST"):
                    return 200, await self.offline.prioritize(account.id, int(now[1]), preview=method == "GET", private_scope=private_scope), {"Cache-Control": "no-store"}
                diagnose = re.fullmatch(r"/downloads/(\d+)/diagnose", route)
                if diagnose and method == "GET":
                    if self.resources is not None and not self.resources.effective().get("diagnostics", True):
                        raise ValueError("管理员已关闭下载诊断")
                    return 200, self.offline.diagnose(account.id, int(diagnose[1])), {"Cache-Control": "no-store"}
                source = re.fullmatch(r"/downloads/(\d+)/source", route)
                if source and method == "GET":
                    return 200, self.offline.source(account.id, int(source[1]), private_scope=private_scope), {"Cache-Control": "no-store"}
                download = re.fullmatch(r"/downloads/(\d+)/(stop|resume|restart|delete|update)", route)
                if download and method == "POST":
                    result = await self.offline.control(account.id, int(download[1]), download[2], item=payload.get("item"), private_scope=private_scope)
                    return (204, None, {}) if result is None else (200, result, {"Cache-Control": "no-store"})
            if route == "/private/cache/session" and method == "POST":
                return 200, self.client_cache.private_session(token, access, payload.get("device")), {}
            if route == "/private/cache/keys" and method == "POST":
                return 200, self.client_cache.private_keys(token, access, payload.get("device"), payload.get("etags")), {}
            if route == "/private/status" and method == "GET":
                return 200, self.private_space.status(token, origin), {}
            if route == "/private/passkeys" and method == "GET":
                self.private_space.require(token, access)
                return 200, self.passkeys.list(token, origin), {}
            if route.startswith("/private/passkeys/") and method == "POST":
                passkeys = self.private_space.passkeys
                if route == "/private/passkeys/unlock/options":
                    return 200, passkeys.private_options(token, csrf, origin, ip), {}
                if route == "/private/passkeys/unlock/verify":
                    return 200, await passkeys.private_unlock(token, csrf, payload.get("request_id"), payload.get("credential"), origin, ip), {}
            if route == "/private/setup" and method == "POST":
                return 201, await self.private_space.setup(token, csrf, payload["password"], payload.get("idle_seconds", self.private_space.DEFAULT_IDLE)), {}
            if route == "/private/unlock" and method == "POST":
                return 200, await self.private_space.unlock(token, csrf, payload["password"], ip), {}
            if route == "/private/lock" and method == "POST":
                self.private_space.lock(token, csrf, access)
                return 204, None, {}
            if route == "/private/activity" and method == "POST":
                return 200, self.private_space.activity(token, csrf, access,
                    active=payload.get("active") is True, playing=payload.get("playing") is True), {}
            if route == "/private/settings" and method == "POST":
                return 200, await self.private_space.configure(token, csrf, access, payload.get("password"),
                    payload.get("idle_seconds"), payload.get("new_password")), {}
            if route == "/private/transfer" and method == "POST":
                return 200, await self.private_space.transfer(token, csrf, access, payload["paths"],
                    payload["destination"], payload["into"], payload.get("conflict", "rename")), {}
            if method == "POST" and route == "/login":
                return self._login(await user.alogin(payload["username"], payload["password"], ip, bool(payload.get("remember"))))
            if method == "POST" and route == "/logout":
                user.accounts.sessions.require(token, csrf=csrf, mutation=True)
                user.logout(token)
                return 204, None, {"Set-Cookie": self._cookie("", expires=True)}
            if method == "GET" and route == "/me":
                return 200, {**user.me(token), **self.settings.public_config()}, {}
            if method == "POST" and route == "/password":
                await user.achange_password(token, csrf, payload["old_password"], payload["new_password"])
                return 204, None, {}
            if method == "POST" and route == "/profile":
                return 200, user.update_profile(token, csrf, payload.get("nickname")), {}
            if method == "POST" and route == "/email":
                return 200, await user.change_email(token, csrf, payload.get("password"), payload.get("email"), ip), {}
            if method == "POST" and route == "/avatar":
                return 200, user.set_avatar(token, csrf, payload.get("data")), {}
            if method == "POST" and route == "/avatar/delete":
                return 200, user.delete_avatar(token, csrf), {}
            if method == "GET" and route == "/public":
                return 200, await user.alist_public(token, limit=int(query["limit"][0]) if "limit" in query else None,
                    cursor=query.get("cursor", [""])[0]), {}
            if method == "GET" and route == "/preview-assets":
                return 200, await user.preview_assets(token, query.get("path", [""])[0]), {}
            if method == "GET" and route == "/preview-list":
                return 200, await user.preview_list(token, query.get("path", [""])[0],
                                                        query.get("cursor", [None])[0] or None), {}
            if method == "POST" and route == "/public":
                paths = payload["paths"] if "paths" in payload else [payload["path"]]
                if not isinstance(paths, list):
                    raise ValueError("paths 必须为数组")
                return 200, {"objects": await user.aset_public(token, csrf, paths, bool(payload["public"]), self._share_options(payload))}, {}
            if method == "GET" and route == "/trash":
                return 200, await user.alist_trash(token, limit=int(query["limit"][0]) if "limit" in query else None,
                    cursor=query.get("cursor", [""])[0]), {}
            if method == "POST" and route == "/trash":
                return 200, {"items": await user.trash(token, csrf, list(payload["paths"]))}, {}
            if method == "POST" and route == "/trash/restore":
                return 200, {"restored": user.restore_trash(token, csrf, list(payload["ids"]))}, {}
            if method == "POST" and route == "/trash/purge":
                ids = None if payload.get("all") else list(payload["ids"])
                return 200, {"purged": await user.purge_trash(token, csrf, ids)}, {}
            if method == "POST" and route == "/thumbnail":
                await user.set_thumbnail(token, csrf, payload["path"], payload.get("data"), str(payload.get("variant") or "thumb"),
                                         etag=payload.get("etag"), ticket=payload.get("ticket"))
                return 204, None, {}
            if method == "POST" and route == "/thumbnail/status":
                return 200, user.thumbnail_status(token, payload.get("paths")), {"Cache-Control": "no-store"}
            if method == "POST" and route == "/thumbnail/claim":
                return 200, user.thumbnail_claim(token, csrf, payload["path"], str(payload["etag"]), bool(payload.get("force")),
                                                 bool(payload.get("custom")), payload.get("ticket")), {"Cache-Control": "no-store"}
            if method == "POST" and route == "/thumbnail/release":
                user.thumbnail_release(token, csrf, payload["path"], str(payload["etag"]), str(payload["ticket"]), payload.get("variants"))
                return 204, None, {}
            if method == "POST" and route == "/thumbnail/generate":
                return 202, user.thumbnail_generate(token, csrf, payload["path"], str(payload["etag"]), str(payload.get("mode") or "capture")), {}
            if method == "POST" and route == "/thumbnail/progress":
                return 200, user.thumbnail_progress(token, payload["path"], str(payload["etag"])), {"Cache-Control": "no-store"}
            if method == "POST" and route == "/thumbnail/cancel":
                return 200, user.thumbnail_cancel(token, csrf, payload["path"], str(payload["etag"])), {}
            if method == "POST" and route == "/thumbnail/fetch":
                data, mime = await user.thumbnail_fetch(token, csrf, payload.get("url"))
                return 200, data, {"Content-Type": mime, "Cache-Control": "no-store"}
            if method == "POST" and route == "/files/instant":
                public = payload.get("public")
                return 200, user.instant_put(token, csrf, payload["path"], payload["size"], payload["fingerprint"],
                                                  payload.get("content_type"), None if public is None else bool(public)), {}
            if method == "POST" and route == "/uploads":
                return 201, await user.create_upload(token, csrf, payload["path"], payload.get("content_type")), {}
            upload_route = re.fullmatch(r"/uploads/([A-Za-z0-9_-]+)(/complete)?", route)
            if upload_route and method == "GET" and not upload_route.group(2):
                return 200, user.get_upload(token, upload_route.group(1)), {}
            if upload_route and method == "POST" and upload_route.group(2):
                public = payload.get("public")
                return 200, await user.complete_upload(token, csrf, upload_route.group(1), list(payload["parts"]),
                                                            None if public is None else bool(public)), {}
            if upload_route and method == "DELETE" and not upload_route.group(2):
                await user.abort_upload(token, csrf, upload_route.group(1))
                return 204, None, {}
            if method == "GET" and route == "/library":
                return 200, await user.library(token, query.get("view", [""])[0], query.get("cursor", [""])[0],
                                               int(query.get("limit", ["100"])[0]), query.get("q", [""])[0],
                                               query["folder"][0] if "folder" in query else None,
                                               query["album"][0] if "album" in query else None), {}
            if method == "GET" and route == "/library/albums":
                return 200, await user.library_albums(token, query.get("q", [""])[0]), {}
            if method == "GET" and route == "/library/folders":
                return 200, await user.library_folders(token, query.get("view", [""])[0], query.get("q", [""])[0]), {}
            if route.startswith("/telegram") and route in ("/telegram", "/telegram/link", "/telegram/unlink") and self.telegram_bot is not None:
                account = user.accounts.account_for_session(user._session(token, csrf=csrf, mutation=method != "GET"))
                if method == "GET" and route == "/telegram":
                    return 200, self.telegram_bot.user_status(account.id), {"Cache-Control": "no-store"}
                if method == "POST" and route == "/telegram":
                    return 200, self.telegram_bot.update_link(account.id, payload), {}
                if method == "POST" and route == "/telegram/link":
                    return 200, self.telegram_bot.create_code(account.id), {"Cache-Control": "no-store"}
                if method == "POST" and route == "/telegram/unlink":
                    self.telegram_bot.unlink(account.id)
                    return 200, self.telegram_bot.user_status(account.id), {}
            if method == "POST" and route == "/star":
                return 200, await user.set_starred(token, csrf, payload.get("paths"), payload.get("starred", True)), {}
            if method == "GET" and route == "/starred":
                return 200, await user.starred(token, query.get("cursor", [""])[0], int(query.get("limit", ["100"])[0]),
                                               query.get("q", [""])[0], query.get("kind", [""])[0]), {"Cache-Control": "no-store"}
            if route == "/playlists" and method == "GET":
                return 200, await user.list_playlists(token), {"Cache-Control": "no-store"}
            if route == "/playlists" and method == "POST":
                return 201, await user.create_playlist(token, csrf, payload.get("name"), payload.get("paths")), {}
            if route == "/playlists/containing" and method == "POST":
                return 200, await user.playlists_containing(token, payload.get("paths")), {"Cache-Control": "no-store"}
            playlist_route = re.fullmatch(r"/playlists/(\d{1,12})(/delete)?", route)
            if playlist_route and method == "GET" and not playlist_route[2]:
                return 200, await user.playlist(token, int(playlist_route[1]), query.get("cursor", [""])[0],
                                                int(query.get("limit", ["200"])[0])), {"Cache-Control": "no-store"}
            if playlist_route and method == "POST" and not playlist_route[2]:
                return 200, await user.update_playlist(token, csrf, int(playlist_route[1]), payload), {}
            if playlist_route and method == "POST" and playlist_route[2]:
                await user.delete_playlist(token, csrf, int(playlist_route[1]))
                return 204, None, {}
            if method == "GET" and route == "/search":
                return 200, await user.search(token, query.get("q", [""])[0],
                    query.get("cursor", [""])[0], int(query.get("limit", ["100"])[0]),
                    public_only=query.get("public", ["0"])[0] == "1", kind=query.get("kind", [""])[0], prefix=query.get("prefix", [""])[0]), {}
            if method == "GET" and route == "/list":
                return 200, await user.list(token, prefix=query.get("prefix", [""])[0],
                                                 cursor=query.get("cursor", [None])[0], limit=int(query.get("limit", ["1000"])[0]),
                                                 public_only=query.get("public", ["0"])[0] == "1", kind=query.get("kind", [""])[0]), {}
            if method == "GET" and route == "/stats":
                return 200, await user.stats(token, query.get("prefix", [""])[0]), {"Cache-Control": "no-store"}
            if route.startswith("/archive/"):
                return await self._archive_route(user, method, route, query, payload, token, csrf, private)
            if method == "POST" and route == "/media/size":
                return 200, user.set_media_size(token, csrf, payload), {}
            if route in ("/media/info", "/media/lookup", "/media/fetch", "/media/preview", "/media/save", "/media/lyrics", "/media/subtitle",
                         "/media/cover", "/media/extract", "/media/jobs"):
                return await self._media_route(user, method, route, query, payload, token, csrf)
            if method == "GET" and route == "/files/info":
                return 200, user.file_info(token, query.get("path", [""])[0]), {"Cache-Control": "no-store"}
            if method == "GET" and route == "/folders":
                return 200, await user.folders(token, prefix=query.get("prefix", [""])[0],
                    cursor=query.get("cursor", [""])[0], limit=int(query.get("limit", ["50"])[0])), {}
            if method == "POST" and route == "/files/check":
                return 200, user.check_files(token, csrf, payload.get("paths", [])), {}
            if method == "POST" and route == "/folders":
                return 201, await user.folder(token, csrf, payload["path"]), {}
            if method == "POST" and route == "/delete":
                return 200, {"results": await user.delete(token, csrf, payload["paths"], bool(payload.get("recursive", False)))}, {}
            if method == "POST" and route == "/move":
                if "items" in payload:
                    return 200, await user.move_many(token, csrf, payload["items"], payload.get("conflict", "skip")), {}
                return 200, await user.move(token, csrf, payload["from"], payload["to"], payload.get("conflict", "skip")), {}
            if method == "POST" and route == "/copy":
                return 201, await user.copy(token, csrf, payload["from"], payload["to"]), {}
            if method == "GET" and route == "/clients":
                return 200, await user.alist_clients(token, limit=int(query["limit"][0]) if "limit" in query else None,
                    cursor=int(query.get("cursor", ["0"])[0])), {}
            if method == "POST" and route == "/clients":
                return 201, user.create_client(token, csrf, payload["name"]), {}
            if method == "POST" and route == "/client-keys/disable":
                user.disable_client_key(token, csrf, payload["access_key_id"])
                return 204, None, {}
            if method == "POST" and route == "/client-keys/delete":
                user.delete_client_key(token, csrf, payload["access_key_id"])
                return 204, None, {}
        elif path == "/api/public/v1/config" and method == "GET":
            return 200, self.settings.public_config(), {}
        elif re.fullmatch(r"/api/public/v1/objects/[A-Za-z0-9_-]+/unlock", path) and method == "POST":
            token = path.split("/")[5]
            info, password_hash = self._public_share(token)
            limiter, key = user.accounts.sessions, f"share:{token}|{ip or '-'}"
            def check_attempts():
                if limiter.is_rate_limited(key):
                    raise TooManyAttempts("too many attempts")
            check_attempts()
            if not password_hash or not await user.accounts.password_work.run(verify_password, str(payload.get("password", "")), password_hash, before=check_attempts):
                limiter.record_failure(key)
                raise ValueError("访问密码不正确")
            _, current_hash = self._public_share(token)
            if current_hash != password_hash:
                raise ValueError("分享设置已更改，请重新输入访问密码")
            access, expires = self.share_access.grant(token, password_hash)
            return 200, {"access": access, "expires_at": expires}, {}
        elif path.startswith("/api/public/v1/objects/") and method == "GET":
            token = path[len("/api/public/v1/objects/"):]
            info, password_hash = self._public_share(token)
            if password_hash and not self.share_access.check(token, password_hash, query.get("access", [None])[0]):
                return 200, {"token": token, "password_required": True}, {}
            sharer = user.accounts.sharer(info.bucket_id)
            sharer = {"nickname": sharer["nickname"], "avatar_version": sharer["avatar_version"]} if sharer else None
            if info.key.endswith("/"):
                return 200, {"token": info.public_token, "kind": "folder", "name": info.key.rstrip("/").rsplit("/", 1)[-1],
                             "password_required": False, "modified_at": info.modified_at, "public_at": info.public_at,
                             "expires_at": info.public_expires_at, "sharer": sharer}, {}
            thumbnails = user.objects.thumbnail_variants([info.blob_uuid]).get(info.blob_uuid or "", [])
            dimensions = user.objects.media_sizes([info.blob_uuid]).get(info.blob_uuid or "")
            return 200, {"token": info.public_token, "kind": "file", "name": info.key.rsplit("/", 1)[-1], "size": info.size,
                         "content_type": info.content_type, "etag": info.etag, "password_required": False,
                         **user.objects.thumbnail_fields(thumbnails),
                         **({"dimensions": {"width": dimensions[0], "height": dimensions[1]}} if dimensions else {}),
                         "modified_at": info.modified_at, "public_at": info.public_at,
                         "expires_at": info.public_expires_at, "sharer": sharer}, {}
        elif re.fullmatch(r"/api/public/v1/folders/[A-Za-z0-9_-]+/(list|preview-assets)", path) and method == "GET":
            token = path.split("/")[5]
            info, password_hash = self._public_share(token)
            if password_hash and not self.share_access.check(token, password_hash, query.get("access", [None])[0]):
                raise SharePasswordRequired("password required")
            if path.endswith("/preview-assets"):
                root, file = user.objects.public_folder_file(token, query.get("path", [""])[0])
                assets = await user.objects.apreview_assets(Scope(root.bucket_id, prefix=root.key), file.key)
                return 200, [{**asset, "path": asset["path"][len(root.key):]} for asset in assets], {}
            return 200, await user.objects.list_public_folder(
                token, query.get("path", [""])[0], query.get("cursor", [None])[0] or None, int(query.get("limit", ["200"])[0]),
                query.get("kind", [""])[0]), {}
        raise NotFoundError("接口不存在")

    @staticmethod
    def _share_options(payload):
        return {name: payload[name] for name in ("expires_at", "password") if name in payload}

    def _public_share(self, token: str):
        """返回 (info, 密码哈希)。过期抛 ShareExpiredError，不存在抛 NotFoundError。"""
        if not self.user.accounts.keystore.unlocked:
            raise NotReadyError("system is locked")
        row = self.user.objects.public_row(token)
        info = self.user.objects.resolve_public(token)
        return info, row["public_password"]

    @staticmethod
    def _avatar_cache_control(query) -> str:
        # 地址带头像版本时内容不变，可长期私有缓存；否则每次协商。
        return "private, max-age=31536000, immutable" if query.get("v") else "private, no-cache"

    def _login(self, result):
        token = result["session"]
        account = self.user.accounts.account_for_session(self.user.accounts.sessions.require(token))
        result = {**result, **self.user.accounts.profile(account.id)}
        # 会话 ID 仅放 HttpOnly Cookie，浏览器脚本只需要 CSRF token。
        # “保持登录”的会话用持久 Cookie（与服务端有效期一致）；普通会话 12 小时。
        return 200, {**{k: v for k, v in result.items() if k != "session"}, "bucket_id": account.bucket_id}, {"Set-Cookie": self._cookie(token, max_age=round(result["expires_at"] - time.time()))}

    async def _content(self, send, method, token, query, headers, *, user=None, private=False):
        user = user or self.user
        path = query.get("path", [""])[0]
        info, _ = await user.content(token, path)
        # 本机缓存的 Service Worker 用这个请求头标记后台整文件读取（只影响读取名额的先后，不影响权限）。
        background = headers.get("x-tessera-background") == "cache"
        opener = lambda start, end: user.content(token, path, start, end, background=background)
        if "bucket_id" in query and int(query["bucket_id"][0]) != info.bucket_id:
            raise PermissionError("文件缓存不属于当前账号")
        # 缓存必须同时绑定存储桶与内容版本，不能在切换账号后复用同路径的内容。
        mime = (info.content_type or "").split(";", 1)[0].strip().lower()
        image = mime.startswith("image/") or (mime in ("", "application/octet-stream")
            and re.search(r"\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico|heic)$", info.key, re.IGNORECASE))
        media = mime.startswith(("video/", "audio/")) or (mime in ("", "application/octet-stream")
            and re.search(r"\.(?:mp4|m4v|mov|webm|mkv|avi|ogv|mp3|m4a|m4b|ogg|oga|opus|wav|flac|aac)$", info.key, re.IGNORECASE))
        cache_control = "no-store" if private else "private, no-cache" if image or media else "private"
        if (not private and (image or media) and query.get("download", ["0"])[0] != "1"
                and query.get("bucket_id", [""])[0] and info.etag and query.get("v", [""])[0] == info.etag):
            cache_control = "private, max-age=604800, immutable"
        await self._stream_object(send, method, info, opener, query, headers, cache_control)

    async def _media_route(self, user, method, route, query, payload, token, csrf):
        """媒体元数据（media/service.py）：文件信息、在线查找、读取与保存候选、内嵌歌词与字幕。
        私密空间走 /private 前缀，范围与授权来自当前解锁的私密会话。"""
        # 查找、读取候选会访问第三方，按修改操作要求 CSRF；封面预览图是 <img> 的 GET 请求，凭只发给本人的候选令牌读取。
        scope = user._scope(token, csrf=csrf, mutation=method != "GET")
        no_store = {"Cache-Control": "no-store"}
        source = payload if method == "POST" else {key: values[0] for key, values in query.items()}
        if route == "/media/jobs" and method == "GET":
            ids = [value for value in source.get("ids", "").split(",") if value]
            return 200, {"jobs": self.media.jobs(scope, ids)}, no_store
        path = user._path(source.get("path", ""))

        def text_response(value, mime):
            return 200, value.encode("utf-8"), {"Content-Type": mime, **no_store, "X-Content-Type-Options": "nosniff"}

        if route == "/media/info" and method == "GET":
            return 200, await self.media.info(scope, path), no_store
        if route == "/media/lookup" and method == "POST":
            only = payload.get("providers")
            only = [item for item in only if isinstance(item, str)][:20] if isinstance(only, list) else None
            overrides = payload.get("query") if isinstance(payload.get("query"), dict) else None
            return 200, await self.media.lookup(scope, path, str(payload.get("want", "")), overrides, only), no_store
        if route == "/media/fetch" and method == "POST":
            fetched = await self.media.fetch(scope, path, str(payload.get("token", "")))
            if fetched.data is not None:
                return 200, fetched.data, {"Content-Type": fetched.mime or "application/octet-stream", **no_store}
            return 200, {"text": fetched.text, "format": fetched.format, "name": fetched.name}, no_store
        if route == "/media/preview" and method == "GET":
            data, mime = await self.media.preview(scope, path, source.get("token", ""))
            return 200, data, {"Content-Type": mime, "Cache-Control": "private, max-age=600"}
        if route == "/media/save" and method == "POST":
            language = payload.get("language")
            return 201, await self.media.save(scope, path, str(payload.get("token", "")), language=language if language else None,
                                              overwrite=payload.get("overwrite") is True), no_store
        if route == "/media/lyrics" and method == "GET":
            return text_response(await self.media.embedded_lyrics(scope, path, source.get("etag", "")), "text/plain; charset=utf-8")
        if route == "/media/cover" and method == "GET":
            data, mime = await self.media.embedded_cover(scope, path, source.get("etag", ""))
            return 200, data, {"Content-Type": mime, **no_store}
        if route == "/media/subtitle" and method == "GET":
            try:
                track = int(source.get("track", ""))
            except ValueError:
                raise ValueError("字幕轨编号不正确") from None
            return text_response(self.media.embedded_subtitle(scope, path, source.get("etag", ""), track), "text/vtt; charset=utf-8")
        if route == "/media/extract" and method == "POST":
            return 202, await self.media.extract(scope, path, str(payload.get("etag", "")), payload.get("track")), no_store
        raise NotFoundError("资源不存在")

    async def _archive_route(self, user, method, route, query, payload, token, csrf, private):
        """在线解压（extract.py）：预览压缩包、开始解压、查看与取消任务。私密空间走 /private 前缀，按当前解锁授权读写。"""
        scope = user._scope(token, csrf=csrf, mutation=method != "GET")
        account = user.accounts.account_for_session(user._session(token))
        no_store = {"Cache-Control": "no-store"}

        def destination(value):
            if not isinstance(value, str):
                raise ValueError("保存位置不正确")
            if private:
                return user._path(value or PRIVATE_PREFIX, directory=True)
            return user._path(value, directory=True) if value else ""

        def password():
            value = payload.get("password")
            if value is not None and (not isinstance(value, str) or len(value) > 1024):
                raise ValueError("密码不正确")
            return value or None

        if route == "/archive/inspect" and method == "POST":
            target = payload.get("destination")
            return 200, await self.archives.inspect(scope, user._path(payload.get("path", "")), None if target is None else destination(target), password()), no_store
        if route == "/archive/browse" and method == "POST":
            return 200, await self.archives.browse(scope, user._path(payload.get("path", ""))), no_store
        if route == "/archive/extract" and method == "POST":
            return 201, await self.archives.start(account.id, scope, user._path(payload.get("path", "")), destination(payload.get("destination", "")),
                                                  password(), payload.get("conflict", "rename"), payload.get("keep_archive", True),
                                                  payload.get("entries")), no_store
        if route == "/archive/compress" and method == "POST":
            # 在线压缩：把所选文件与文件夹打包成 ZIP 保存到网盘（默认放在第一项所在的文件夹）。
            roots, files, total = await user.archive_totals(token, payload.get("paths"))
            folder = destination(payload["destination"]) if payload.get("destination") is not None else roots[0][:roots[0].rstrip("/").rfind("/") + 1]
            if any(root.endswith("/") and folder.startswith(root) for root in roots):
                raise ValueError("压缩包不能保存到要压缩的文件夹里面")
            name = payload.get("name")
            if not isinstance(name, str) or not name.strip() or "/" in name or "\\" in name or len(name.encode()) > 220 or any(ord(c) < 32 for c in name):
                raise ValueError("压缩包名称不正确")
            name = name.strip()
            if not name.lower().endswith(".zip"):
                name += ".zip"
            _, entries = await user.archive(token, payload.get("paths"))
            return 201, await self.archives.compress(account.id, scope, folder + name, lambda: entries, files, total,
                                                     payload.get("compression", "deflate") == "deflate"), no_store
        if route == "/archive/jobs" and method == "GET":
            ids = [value for value in query["ids"][0].split(",") if value] if "ids" in query else None
            return 200, {"jobs": self.archives.list(account.id, private, ids)}, no_store
        cancel = re.fullmatch(r"/archive/jobs/([0-9a-f]{16})/cancel", route)
        if cancel and method == "POST":
            return 200, self.archives.cancel(account.id, private, cancel[1]), no_store
        raise NotFoundError("资源不存在")

    async def _public_content(self, send, method, path, query, headers):
        # 文件分享：/p/<token> 与 /p/<token>/<文件名> 等价，文件名只用于让链接更易读。
        # 文件夹分享：/p/<token>/<文件夹内的相对路径> 指向其中的某个文件。
        token, _, rest = path[len("/p/"):].partition("/")
        info, password_hash = self._public_share(token)
        if password_hash and not self.share_access.check(token, password_hash, query.get("access", [None])[0]):
            raise SharePasswordRequired("password required")
        root = info
        if info.key.endswith("/"):
            root, info = self.user.objects.public_folder_file(token, rest)
        if "thumbnail" in query:
            # 缩略图沿用分享的权限边界（密码、目录范围、账号状态），不计入下载次数。
            data, mime, etag = await self.user.objects.read_thumbnail(info, query["thumbnail"][0])
            await self._send_thumbnail(send, headers, data, mime, etag, "public, no-cache")
            return

        def opener(start, end):
            # 从头开始的完整读取计为一次下载；Range 续传与预览拖动不重复计数。
            if start == 0:
                self.user.objects.count_public_download(root.bucket_id, root.key)
            return self.user.objects.get_object(Scope(info.bucket_id), info.key, start, end)
        # 允许 CDN/浏览器存储，但每次使用前必须回源验证（ETag → 304）。关闭分享后回源即得到 404，链接立即失效。
        await self._stream_object(send, method, info, opener, query, headers, "public, no-cache")

    async def _public_folder_download(self, send, token, form):
        root, password_hash = self._public_share(token)
        access = form.get("access", [None])[0]
        if password_hash and not self.share_access.check(token, password_hash, access):
            raise SharePasswordRequired("password required")
        if not root.key.endswith("/"):
            raise NotFoundError("not a shared folder")
        objects = self.user.objects
        relative = objects._public_relative(form.get("path", [""])[0])
        if relative and not relative.endswith("/"):
            relative += "/"
        prefix, scope = root.key + relative, Scope(root.bucket_id, root.key, "ro")
        selected = list(dict.fromkeys(form.get("files", [])))
        all_files = form.get("all", ["0"])[0] == "1"
        if not all_files and (not selected or len(selected) > 1000):
            raise ValueError("请选择 1 至 1000 个文件")
        keys = []
        for path in selected:
            path = objects._public_relative(path)
            if not path.startswith(relative) or not path[len(relative):] or "/" in path[len(relative):] or "\\" in path:
                raise ValueError("只能选择当前分享目录中的文件")
            keys.append(root.key + path)
        # 所选文件预先校验，避免请求包含不存在的文件时生成不完整下载。
        chosen = None if all_files else await objects.metadata.run_in_thread(
            lambda: [objects.head_object(scope, key) for key in keys])

        async def files():
            if chosen is not None:
                for info in chosen:
                    yield info
                return
            cursor = None
            while True:
                page = await objects.metadata.run_in_thread(lambda: objects.list_objects(scope, prefix, "/", cursor, 200))
                for info in page.objects:
                    if info.key != prefix and not info.key.endswith("/"):
                        yield info
                if not page.next_cursor:
                    return
                cursor = page.next_cursor

        async def entries():
            found = False
            async for info in files():
                current, current_hash = self._public_share(token)
                if (current.bucket_id, current.key) != (root.bucket_id, root.key):
                    raise NotFoundError("shared folder changed")
                if current_hash and not self.share_access.check(token, current_hash, access):
                    raise SharePasswordRequired("password required")
                actual, stream = await objects.get_object(scope, info.key)
                if not found:
                    objects.count_public_download(root.bucket_id, root.key)
                    found = True
                yield actual.key[len(prefix):], actual.size, actual.modified_at, stream
            if not found:
                raise ValueError("当前目录没有可下载的文件")

        name = (prefix.rstrip("/").rsplit("/", 1)[-1] or "files") + ".zip"
        await self._send_stream(send, 200, {"Content-Type": "application/zip", "Cache-Control": "no-store",
            "Content-Disposition": f"attachment; filename=\"files.zip\"; filename*=UTF-8''{quote(name, safe='')}",
            "X-Content-Type-Options": "nosniff"}, stream_zip(entries()), "GET")

    @staticmethod
    def _thumbnail_cache_control(query, etag: str) -> str:
        parts = etag.rsplit("-", 2)
        if len(parts) != 3:
            return "private, no-cache"
        source, variant, revision = parts
        # 只有带存储桶、且匹配实际图片版本的地址允许长期缓存，旧地址继续回源验证。
        if (query.get("bucket_id", [""])[0] and query.get("variant", ["thumb"])[0] == variant
                and query.get("v", [""])[0] == f"{source}.{variant}.{revision}"):
            return "private, max-age=31536000, immutable"
        return "private, no-cache"

    @staticmethod
    def _validators(headers) -> frozenset[str]:
        """If-None-Match 里的 ETag（去掉引号与弱标记），读取缩略图前用来判断能否直接回 304。"""
        return frozenset(value.strip().removeprefix("W/").strip('"') for value in headers.get("if-none-match", "").split(",") if value.strip())

    async def _send_thumbnail(self, send, headers, data: bytes, mime: str, etag: str, cache_control: str):
        validators = [value.strip().removeprefix("W/") for value in headers.get("if-none-match", "").split(",")]
        if f'"{etag}"' in validators or "*" in validators:
            await self._send(send, 304, None, {"ETag": f'"{etag}"', "Cache-Control": cache_control})
            return
        await self._send_raw(send, 200, {"Content-Type": mime, "ETag": f'"{etag}"', "Cache-Control": cache_control,
                                         "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox"}, data)

    @staticmethod
    async def _until_disconnect(receive, response):
        """浏览器停止预加载或 Range 读取后，取消响应并释放分片预读与传输名额。"""
        async def disconnected():
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                # GET 的初始 http.request 不表示断连；让响应任务也有执行机会。
                await asyncio.sleep(0)

        producer = asyncio.create_task(response)
        listener = asyncio.create_task(disconnected())
        try:
            done, _ = await asyncio.wait((producer, listener), return_when=asyncio.FIRST_COMPLETED)
            if producer in done:
                return await producer
            await listener
        finally:
            for task in (producer, listener):
                if not task.done():
                    task.cancel()
            await asyncio.gather(producer, listener, return_exceptions=True)

    async def _stream_object(self, send, method, info, opener, query, headers, cache_control):
        etag = f'"{info.etag}"'
        if headers.get("if-none-match") in (etag, "*"):
            await self._send(send, 304, None, {"ETag": etag, "Cache-Control": cache_control})
            return
        requested = headers.get("range") if method == "GET" else None
        if headers.get("if-range") and headers["if-range"] != etag:
            requested = None
        start, end, partial = byte_range(requested, info.size)
        content_type = served_type(info.key, info.content_type)
        inline = content_type in {
            "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon",
            "video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav",
            "audio/flac", "audio/aac", "application/pdf", "text/plain",
        } and query.get("download", ["0"])[0] != "1"
        disposition = "inline" if inline else "attachment"
        filename = quote(info.key.rsplit("/", 1)[-1], safe="")
        response_headers = {
            "Content-Type": content_type, "ETag": etag, "Content-Length": str(end - start),
            "Accept-Ranges": "bytes", "Cache-Control": cache_control, "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox", "Content-Disposition": f"{disposition}; filename*=UTF-8''{filename}",
        }
        if partial:
            response_headers["Content-Range"] = f"bytes {start}-{end - 1}/{info.size}"
        if method == "HEAD":
            await self._send(send, 200, None, response_headers)
            return
        _, stream = await opener(start, end)
        iterator = stream.__aiter__()
        try:
            # 首个窗口解密成功后才提交响应头；后续完整性失败使连接终止。
            first = await anext(iterator, b"")
            await send({"type": "http.response.start", "status": 206 if partial else 200,
                        "headers": self._headers(response_headers)})
            await send({"type": "http.response.body", "body": first, "more_body": True})
            async for chunk in iterator:
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
            await send({"type": "http.response.body", "body": b""})

        finally:
            if hasattr(iterator, "aclose"):
                await iterator.aclose()

    async def _send_events(self, send, events):
        """Server-Sent Events：首个事件就绪前若出错，仍按普通 JSON 错误返回。"""
        iterator = events.__aiter__()
        try:
            first = await anext(iterator, None)
            await send({"type": "http.response.start", "status": 200, "headers": self._headers({
                "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store",
                "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff"})})
            event = first
            while event is not None:
                if event.get("type") == "ping":
                    data = b": ping\n\n"
                else:
                    data = f"id: {event.get('seq', 0)}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n".encode()
                await send({"type": "http.response.body", "body": data, "more_body": True})
                event = await anext(iterator, None)
            await send({"type": "http.response.body", "body": b""})
        finally:
            await iterator.aclose()

    async def _assistant_user(self, method, route, query, payload, token, csrf, *, origin=None, ip=None):
        # 统一对话（文件助手设计 §37）：私密授权取自同一登录会话，涉及私密的对话在服务层校验（未解锁返回 423）。
        service = self.assistant
        no_store = {"Cache-Control": "no-store"}
        if route == "/config" and method == "GET":
            return 200, service.user_config(token), no_store
        if route == "/notice/ack" and method == "POST":
            service.ack_notice(token, csrf, private=payload.get("private") is True)
            return 204, None, {}
        if route == "/conversations" and method == "GET":
            return 200, service.list_conversations(token, cursor=query.get("cursor", [""])[0],
                                                   archived=query.get("archived", ["0"])[0] in ("1", "true")), no_store
        if route == "/conversations" and method == "POST":
            return 201, service.create_conversation(token, csrf, payload), no_store
        match = re.fullmatch(r"/conversations/([A-Za-z0-9_-]{4,40})(?:/(update|delete|messages|retry|share-link|export))?", route)
        if match and match[2] is None and method == "GET":
            return 200, service.conversation(token, match[1], before=int(query.get("before_seq", ["0"])[0])), no_store
        if match and match[2] == "update" and method == "POST":
            return 200, service.update_conversation(token, csrf, match[1], payload), no_store
        if match and match[2] == "delete" and method == "POST":
            service.delete_conversation(token, csrf, match[1])
            return 204, None, {}
        if match and match[2] == "messages" and method == "POST":
            return 201, await service.send(token, csrf, match[1], payload), no_store
        if match and match[2] == "retry" and method == "POST":
            return 201, await service.retry(token, csrf, match[1], payload), no_store
        if match and match[2] == "export" and method == "GET":
            # 下载对话的明文留痕；涉及私密的对话由服务层要求已解锁（423）。审计只记格式与消息数。
            fmt = query.get("format", ["markdown"])[0]
            name, content_type, content, count = service.export_conversation(token, match[1], fmt, query.get("tz", [""])[0][:64])
            session = self.admin.accounts.sessions.peek(token)
            try:
                self.audit.record("assistant.conversation.export", actor_type=session.role if session else "user",
                                  actor=session.username if session else None, ok=True, target=match[1],
                                  detail={"format": fmt, "messages": count}, ip=ip)
            except Exception:
                pass
            return 200, content, {"Content-Type": content_type, "Cache-Control": "no-store",
                                  "Content-Disposition": f"attachment; filename=\"conversation.{'md' if fmt == 'markdown' else 'json'}\"; filename*=UTF-8''{quote(name, safe='')}"}
        if match and match[2] == "share-link" and method == "GET":
            return 200, service.share_link(token, match[1], query.get("path", [""])[0]), no_store
        match = re.fullmatch(r"/runs/([A-Za-z0-9_-]{4,40})/(stop|client-results)", route)
        if match and method == "POST":
            if match[2] == "stop":
                service.stop(token, csrf, match[1])
            else:
                service.client_result(token, csrf, match[1], payload)
            return 204, None, {}
        match = re.fullmatch(r"/scope-requests/([A-Za-z0-9_-]{4,40})/(confirm|reject)", route)
        if match and method == "POST":
            return 200, await service.decide_scope(token, csrf, match[1], match[2] == "confirm"), no_store
        match = re.fullmatch(r"/actions/([A-Za-z0-9_-]{4,40})/media/(\d{1,3})/(\d{1,3})", route)
        if match and method == "GET":
            data, content_type = await service.action_media(token, match[1], int(match[2]), int(match[3]), full=query.get("full", [""])[0] == "1")
            return 200, data, {"Content-Type": content_type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
                               "Content-Security-Policy": "sandbox"}
        match = re.fullmatch(r"/actions/([A-Za-z0-9_-]{4,40})/text/(\d{1,3})", route)
        if match and method == "GET":
            return 200, await service.action_text(token, match[1], int(match[2])), no_store
        match = re.fullmatch(r"/actions/([A-Za-z0-9_-]{4,40})(?:/(items|confirm|reject|cancel|undo))?", route)
        if match and match[2] is None and method == "GET":
            return 200, service.action_detail(token, match[1]), no_store
        if match and match[2] == "items" and method == "GET":
            offset = query.get("offset", ["0"])[0]
            return 200, service.action_items(token, match[1], int(offset) if offset.isdigit() else 0), no_store
        if match and match[2] in ("confirm", "reject") and method == "POST":
            return 200, await service.decide_action(token, csrf, match[1], match[2] == "confirm", payload,
                                                    origin=origin, ip=ip), no_store
        if match and match[2] == "cancel" and method == "POST":
            return 200, service.cancel_action(token, csrf, match[1]), no_store
        if match and match[2] == "undo" and method == "POST":
            return 200, await service.undo_action(token, csrf, match[1]), no_store
        if route == "/attachments/stats" and method == "GET":
            return 200, service.attachment_stats(token), no_store
        if route == "/attachments/discard-pending" and method == "POST":
            return 200, service.discard_pending_attachments(token, csrf), no_store
        match = re.fullmatch(r"/attachments/([0-9a-f]{32})/(thumbnails|discard|save)", route)
        if match and method == "POST":
            if match[2] == "thumbnails":
                await service.attachment_thumbnail(token, csrf, match[1], payload.get("data"), str(payload.get("variant") or "thumb"))
                return 204, None, {}
            if match[2] == "discard":
                service.discard_attachment(token, csrf, match[1])
                return 204, None, {}
            return 200, service.save_attachment(token, csrf, match[1], payload), no_store
        match = re.fullmatch(r"/conversations/([A-Za-z0-9_-]{4,40})/snapshots", route)
        if match and method == "POST":
            return 201, service.upload_snapshot(token, csrf, match[1], payload), no_store
        raise NotFoundError("资源不存在")

    async def _assistant_admin(self, method, route, query, payload, session):
        service = self.assistant
        q = lambda name, default="": query.get(name, [default])[0]
        number = lambda name: int(q(name)) if q(name).lstrip("-").isdigit() else None
        moment = lambda name: float(q(name)) if q(name).replace(".", "", 1).isdigit() else None
        if route == "/overview" and method == "GET":
            return 200, service.admin_overview(), {}
        if route == "/usage" and method == "GET":
            days = q("days", "30")
            return 200, service.trace.usage_report(days=int(days) if days.isdigit() else 30), {}
        if route == "/settings":
            if method == "GET":
                return 200, service.admin_settings(), {}
            if method == "POST":
                return 200, service.admin_update_settings(payload), {}
        if route == "/limits":
            if method == "GET":
                return 200, service.admin_limits(), {}
            if method == "POST":
                return 200, service.admin_update_limits(payload), {}
        if route == "/tools":
            if method == "GET":
                return 200, service.admin_tools(), {}
            if method == "POST":
                return 200, service.admin_update_tools(payload), {}
        if route == "/channels":
            if method == "GET":
                return 200, service.admin_channels(), {}
            if method == "POST":
                # 新渠道不自动加入模型：界面随后打开「选择模型」，由管理员勾选需要的模型。
                return 201, service.channels.create(payload), {}
        if route == "/catalog" and method == "GET":
            return 200, {"status": service.catalog.status(), "providers": service.catalog.providers(),
                         **service.catalog.entries(query=q("q"), provider=q("provider"), cursor=q("cursor"), limit=number("limit") or 100)}, {}
        if route == "/catalog" and method == "POST":
            return 201, service.catalog.create(payload), {}
        if route == "/catalog/update" and method == "POST":
            entry_id = payload.get("id")
            if not isinstance(entry_id, str):
                raise ValueError("请指定目录条目")
            return 200, service.catalog.update(entry_id, {k: v for k, v in payload.items() if k != "id"}), {}
        if route == "/catalog/delete" and method == "POST":
            if not isinstance(payload.get("id"), str):
                raise ValueError("请指定目录条目")
            service.catalog.delete(payload["id"])
            return 204, None, {}
        if route == "/catalog/sync" and method == "POST":
            return 200, await service.catalog.sync(actor=session.username), {}
        if route == "/catalog/settings" and method == "POST":
            return 200, service.catalog.update_settings(payload), {}
        match = re.fullmatch(r"/channels/(\d+)/(discover|models/batch)", route)
        if match:
            channel_id = int(match[1])
            if match[2] == "discover" and method == "GET":
                return 200, await service.channels.discover(channel_id, actor=session.username), {}
            if match[2] == "models/batch" and method == "POST":
                result = await service.channels.add_models(channel_id, payload.get("models"), actor=session.username)
                service.guard.invalidate()
                return 201, result, {}
        match = re.fullmatch(r"/channels/(\d+)(?:/(update|delete|sync|models))?", route)
        if match:
            channel_id = int(match[1])
            if match[2] is None and method == "GET":
                return 200, service.channels.get(channel_id), {}
            if match[2] == "update" and method == "POST":
                if payload.get("enabled") is False:
                    service.guard_default(channel_id=channel_id)
                service.guard.invalidate()
                return 200, service.channels.update(channel_id, payload), {}
            if match[2] == "delete" and method == "POST":
                service.admin_delete_channel(channel_id)
                return 204, None, {}
            if match[2] == "sync" and method == "POST":
                return 200, await service.channels.sync(channel_id, actor=session.username), {}
            if match[2] == "models" and method == "GET":
                return 200, service.channels.models(channel_id), {}
            if match[2] == "models" and method == "POST":
                return 201, service.channels.add_model(channel_id, payload), {}
        match = re.fullmatch(r"/models/(\d+)/(update|delete|test)", route)
        if match and method == "POST":
            model_id = int(match[1])
            if match[2] == "update":
                if payload.get("enabled") is False or payload.get("tools") == "no":
                    service.guard_default(model_id=model_id)
                return 200, service.channels.update_model(model_id, payload), {}
            if match[2] == "delete":
                service.guard_default(model_id=model_id)
                service.channels.delete_model(model_id)
                return 204, None, {}
            return 200, await service.admin_test_model(model_id, session.username), {}
        match = re.fullmatch(r"/users/(\d+)/policy", route)
        if match:
            if method == "GET":
                return 200, service.admin_policy(int(match[1])), {}
            if method == "POST":
                return 200, service.admin_update_policy(int(match[1]), payload), {}
        if route == "/conversations" and method == "GET":
            return 200, service.trace.admin_conversations(cursor=q("cursor"), user_id=number("user_id"), model_id=number("model_id"),
                                                          since=moment("since"), until=moment("until"), action=q("action")), {}
        match = re.fullmatch(r"/conversations/([A-Za-z0-9_-]{4,40})", route)
        if match and method == "GET":
            return 200, service.trace.admin_conversation(match[1]), {}
        if route == "/conversations/delete" and method == "POST":
            user_id, before = payload.get("user_id"), payload.get("before")
            if user_id is not None and (isinstance(user_id, bool) or not isinstance(user_id, int)):
                raise ValueError("user_id 必须是整数")
            if before is not None and (isinstance(before, bool) or not isinstance(before, (int, float))):
                raise ValueError("before 必须是时间戳")
            if payload.get("dry_run"):
                return 200, {"count": service.trace.admin_count(user_id=user_id, before=before)}, {}
            return 200, {"deleted": service.trace.admin_delete(user_id=user_id, before=before)}, {}
        if route in ("/calls", "/calls/stats") and method == "GET":
            filters = {"kind": q("kind"), "status": q("status"), "channel_id": number("channel_id"), "model_id": number("model_id"),
                       "tool_name": q("tool"), "user_id": number("user_id"), "since": moment("since"), "until": moment("until"),
                       "conversation_id": q("conversation_id")}
            if route == "/calls/stats":
                return 200, service.trace.call_stats(**filters), {}
            return 200, service.trace.list_calls(cursor=number("cursor") or 0, limit=number("limit") or 50, **filters), {}
        if route == "/purge" and method == "POST":
            if payload.get("confirm") != "清除":
                raise ValueError("请输入“清除”确认")
            service.admin_purge()
            return 204, None, {}
        raise NotFoundError("资源不存在")

    @staticmethod
    def _headers(headers):
        return [(k.lower().encode("ascii"), v.encode("latin-1")) for k, v in headers.items()]

    async def _send(self, send, status, result, extra=None):
        headers = dict(extra or {})
        # bytes 结果原样发送（如对话导出），由调用方在 extra 里给出 Content-Type。
        data = b"" if result is None or status in (204, 304) else result if isinstance(result, bytes) \
            else json.dumps(result, ensure_ascii=False).encode()
        if data:
            headers.setdefault("Content-Type", "application/json; charset=utf-8")
        if status != 304:
            headers.setdefault("Content-Length", str(len(data)))
        headers.setdefault("X-Content-Type-Options", "nosniff")
        await send({"type": "http.response.start", "status": status, "headers": self._headers(headers)})
        await send({"type": "http.response.body", "body": data})

    async def _send_stream(self, send, status, headers, stream, method):
        iterator = stream.__aiter__()
        try:
            # 首个窗口解密成功后才提交响应头；之后的失败只能中断连接。
            first = b"" if method == "HEAD" else await anext(iterator, b"")
            await send({"type": "http.response.start", "status": status,
                        "headers": self._headers({str(k): str(v) for k, v in headers.items()})})
            await send({"type": "http.response.body", "body": first, "more_body": method != "HEAD"})
            if method == "HEAD":
                return
            async for chunk in iterator:
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
            await send({"type": "http.response.body", "body": b""})

        finally:
            if hasattr(iterator, "aclose"):
                await iterator.aclose()

    async def _send_raw(self, send, status, headers, data):
        response_headers = {str(key): str(value) for key, value in headers.items()}
        response_headers.setdefault("Content-Length", str(len(data)))
        await send({"type": "http.response.start", "status": status, "headers": self._headers(response_headers)})
        await send({"type": "http.response.body", "body": data})

    @staticmethod
    def _error(exc):
        extra = {}
        if isinstance(exc, PrivateLocked):
            status, code, message = 423, "private_locked", str(exc)
        elif isinstance(exc, ShareExpiredError):
            status, code, message = 410, "share_expired", "分享链接已过期"
        elif isinstance(exc, SharePasswordRequired):
            status, code, message = 403, "password_required", "该分享需要访问密码"
        elif isinstance(exc, KeyAuthError):
            status, code, message = 401, "invalid_key", str(exc)
            # 使用 Bearer 质询，避免浏览器直接访问时弹出 Basic 登录框。
            extra["WWW-Authenticate"] = 'Bearer realm="tgdrive"'
        # 口令错误不是会话失效：返回 400，避免前端把管理员登出。
        elif isinstance(exc, WrongPassphrase): status, code, message = 400, "wrong_passphrase", "加密口令不正确"
        elif isinstance(exc, TooManyAttempts):
            status, code = 429, "too_many_attempts"
            message = str(exc) if str(exc).startswith(("访问密码", "登录", "验证", "通行密钥", "注册")) else "登录失败次数过多，请 15 分钟后再试"
        elif isinstance(exc, (AuthenticationError, SessionExpired)): status, code, message = 401, "unauthorized", "登录已过期，请重新登录"
        elif isinstance(exc, AssistantDenied): status, code, message = 403, "assistant_unavailable", str(exc) or "文件助手不可用"
        elif isinstance(exc, CacheTaskGone): status, code, message = 410, "cache_task_gone", str(exc)
        elif isinstance(exc, (CsrfError, PermissionError)): status, code, message = 403, "forbidden", "没有权限执行这个操作"
        elif isinstance(exc, WorkBusyError):
            status, code, message = 503, "transfer_busy", "传输繁忙，请稍后重试"
            extra["Retry-After"] = "5"
        elif isinstance(exc, NotReadyError): status, code, message = 503, "locked", "服务正在等待管理员完成启动，请稍后再试"
        elif isinstance(exc, NotFoundError): status, code, message = 404, "not_found", "要找的内容不存在，可能已被移动或删除"
        elif isinstance(exc, InvalidRange):
            status, code, message = 416, "range_not_satisfiable", "请求的字节范围不可满足"
            extra["Content-Range"] = f"bytes */{exc.size}"
        elif isinstance(exc, IntegrityError): status, code, message = 500, "integrity_error", "文件完整性校验失败"
        elif isinstance(exc, AssetExists): status, code, message = 409, "asset_exists", str(exc)
        elif isinstance(exc, VersionConflict): status, code, message = 409, "version_conflict", "文件已在别处修改，请重新加载后再保存"
        elif isinstance(exc, QuotaExceededError): status, code, message = 413, "quota_exceeded", "空间不足，请先清理不需要的文件或联系管理员扩容"
        elif isinstance(exc, ValueError):
            status, code, message = 400, "bad_request", str(exc) or "请求参数不合法"
        elif isinstance(exc, (KeyError, TypeError)): status, code, message = 400, "bad_request", "请求参数不合法"
        else: status, code, message = 500, "internal_error", "服务出现问题，请稍后重试"
        return status, {"error": {"code": code, "message": message}}, extra

    def _cookie(self, value, *, expires=False, max_age: int | None = None):
        return (f"tg_session={value}; HttpOnly; SameSite=Strict; Path=/api"
                + ("; Secure" if self.secure_cookies else "")
                + ("; Max-Age=0" if expires else f"; Max-Age={max_age if max_age is not None else int(self.admin.accounts.sessions.ttl)}"))
