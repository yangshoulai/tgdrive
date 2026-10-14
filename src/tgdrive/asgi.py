"""管理/用户 HTTP 入口；上传与下载通过异步迭代器传递背压。"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import traceback
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, quote

from .api import AdminApi, UserApi
from .archive import stream_zip
from .audit import AuditLog
from .authn import AuthenticationError, CsrfError, SessionExpired, TooManyAttempts, hash_password, verify_password
from .context import AppContext
from .errors import (
    IntegrityError,
    NotFoundError,
    NotReadyError,
    QuotaExceededError,
    ShareExpiredError,
    WrongPassphrase,
)
from .keyapi import KeyApi, KeyAuthError
from .metrics import TrafficMetrics
from .objects import Scope
from .private import PrivateAccessLogFilter, PrivateLocked, PrivateSpace
from .settings import SystemSettings
from .share import ShareAccess
from .static import StaticFiles
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
                 context: AppContext | None = None, offline=None, resources=None) -> None:
        self.scheduler = scheduler
        self.admin, self.user, self.s3 = admin, user, s3
        # 对外地址也是通行密钥的固定来源，不能由任意请求头决定。
        self.settings = settings or SystemSettings(admin.accounts.metadata, {"public_base_url": public_base_url})
        self.private_space = PrivateSpace(user, self.settings)
        self.passkeys = self.private_space.passkeys
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

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    if self.offline is not None:
                        self.offline.start()
                    if self.scheduler is not None:
                        self.scheduler.start()
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    if self.offline is not None:
                        await self.offline.stop()
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
        private_response = path.startswith("/api/user/v1/private/") or path.startswith("/api/user/v1/passkeys")
        request_id = secrets.token_hex(8)
        request_start = time.monotonic()

        async def tracked_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                if private_response:
                    # 覆盖所有分支（流、缩略图、上传和错误），避免浏览器或中间代理保存私密内容。
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
                # 管理员文档代码只能通过下方受保护的 API 返回，不能绕过会话直接读取静态文件。
                if path.endswith("/admin-docs.js"):
                    await self._send(tracked_send, 404, {"error": {"code": "not_found", "message": "资源不存在"}})
                    return
                https = scope.get("scheme") == "https"
                await self._static(tracked_send, path, method, https=https)
                return
            if path == "/api/admin/v1/docs-bundle.js" and method in ("GET", "HEAD"):
                await self._admin_docs_bundle(tracked_send, method, token)
                return
            if path.startswith("/api/v1/"):
                await self._key_api(tracked_send, method, path[len("/api/v1"):], query, headers, body_stream)
                return
            file_user = self.user
            private = path.startswith("/api/user/v1/private/")
            access = headers.get("x-private-access", query.get("access", [""])[0])
            audit_path = path
            if private:
                route = path[len("/api/user/v1/private"):]
                controls = {"/status", "/setup", "/unlock", "/lock", "/activity", "/settings", "/transfer",
                            "/passkeys", "/passkeys/unlock/options", "/passkeys/unlock/verify"}
                allowed = {"/list", "/search", "/folders", "/files", "/files/check", "/files/instant", "/move", "/archive",
                           "/copy", "/delete", "/thumbnail", "/content", "/preview-assets", "/preview-list",
                           "/trash", "/trash/restore", "/trash/purge", "/uploads",
                           "/downloads", "/downloads/clear"}
                if route not in controls:
                    if route not in allowed and not re.fullmatch(r"/uploads/[A-Za-z0-9_-]+(?:/complete|/parts/\d+)?|/downloads/\d+/(?:stop|resume|restart|delete|update)", route):
                        raise NotFoundError("资源不存在")
                    file_user = self.private_space.files(token, access)
                    path = "/api/user/v1" + route
                if query.get("public", ["0"])[0] in ("1", "true"):
                    raise PermissionError("私密空间不能公开分享")
            if path == "/api/user/v1/files" and method == "PUT":
                size = int(headers["content-length"]) if "content-length" in headers else None
                public = query.get("public", [None])[0]
                result = await file_user.put(token, csrf, query.get("path", [""])[0], body_stream(),
                                              headers.get("content-type"), size,
                                              None if public is None else public in ("1", "true"))
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
                data, mime, etag = file_user.thumbnail(token, query.get("path", [""])[0], query.get("variant", ["thumb"])[0], bucket_id=bucket_id)
                await self._send_thumbnail(tracked_send, headers, data, mime, etag, "no-store" if private else self._thumbnail_cache_control(query, etag))
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
            if path == "/api/admin/v1/thumbnail" and method == "GET":
                data, mime, etag = self.admin.thumbnail(token, int(query.get("bucket_id", ["0"])[0]),
                    query.get("path", [""])[0], query.get("variant", ["thumb"])[0])
                await self._send_thumbnail(tracked_send, headers, data, mime, etag, self._thumbnail_cache_control(query, etag))
                return
            if path == "/api/user/v1/archive" and method == "GET":
                name, entries = await file_user.archive(token, query.get("path", []))
                await self._send_stream(tracked_send, 200, {"Content-Type": "application/zip", "Cache-Control": "no-store",
                    "Content-Disposition": f"attachment; filename=\"files.zip\"; filename*=UTF-8''{quote(name, safe='')}",
                    "X-Content-Type-Options": "nosniff"}, stream_zip(entries, nested=True), "GET")
                return
            if path == "/api/user/v1/content" and method in ("GET", "HEAD"):
                await self._until_disconnect(receive, self._content(tracked_send, method, token, query, headers, admin=False, user=file_user, private=private))
                return
            if path.startswith("/api/admin/v1/backups/") and method == "GET":
                await self._backup_download(tracked_send, token, path.rsplit("/", 1)[-1])
                return
            if path == "/api/admin/v1/content" and method in ("GET", "HEAD"):
                await self._until_disconnect(receive, self._content(tracked_send, method, token, query, headers, admin=True))
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
            async for chunk in body_stream():
                if len(data) + len(chunk) > self.json_limit:
                    await self._send(tracked_send, 413, {"error": {"code": "body_too_large", "message": "JSON 请求体过大"}})
                    return
                data.extend(chunk)
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
                    passkey_browser=cookies.get("tg_passkey", ""))
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
                          "/bots/{}/check": "bot.check", "/objects/public": "object.public", "/settings": "settings.update", "/resources": "resources.update",
                          "/maintenance/gc": "maintenance.gc", "/maintenance/scrub": "maintenance.scrub",
                          "/maintenance/cleanup": "maintenance.cleanup", "/maintenance/gc/retry": "maintenance.gc_retry",
                          "/backups": "backup.create", "/password": "admin.password", "/passphrase": "system.passphrase",
                          "/users/{}/password": "user.password_reset", "/users/{}/delete": "user.delete"},
        "/api/user/v1": {"/login": "user.login", "/logout": "user.logout", "/password": "user.password",
                         "/profile": "account.profile", "/email": "account.email", "/avatar": "account.avatar",
                         "/avatar/delete": "account.avatar_delete",
                         "/clients": "key.create", "/client-keys/disable": "key.disable", "/client-keys/delete": "key.delete", "/public": "object.public",
                         "/trash/purge": "trash.purge", "/downloads": "download.create", "/downloads/{}/stop": "download.stop",
                         "/downloads/{}/resume": "download.resume", "/downloads/{}/restart": "download.restart",
                         "/downloads/{}/delete": "download.delete", "/downloads/{}/update": "download.update",
                         "/downloads/clear": "download.clear", "/shares/{}/save": "share.save",
                         "/private/passkeys/unlock/verify": "private.passkey.unlock",
                         "/passkeys/register/verify": "passkey.create", "/passkeys/rename": "passkey.rename",
                         "/passkeys/delete": "passkey.delete", "/passkeys/enable-login": "passkey.enable",
                         "/passkeys/login/verify": "user.login"},
    }

    def _audit_entry(self, method, path, payload, token, scope):
        """在执行操作前确定审计动作与操作者（退出、锁定会清除会话，执行后就查不到了）。"""
        if method != "POST":
            return None
        for prefix, routes in self._AUDITED.items():
            if not path.startswith(prefix + "/"):
                continue
            route = path[len(prefix):]
            pattern = re.sub(r"^/(users|clients|bots|downloads)/\d+/", r"/\1/{}/", route)
            pattern = re.sub(r"^/shares/[A-Za-z0-9_-]+/", "/shares/{}/", pattern)
            action = routes.get(pattern)
            if action is None:
                return None
            session = self.admin.accounts.sessions.peek(token)
            # 文件空间接口现在也会收到管理员的会话：操作者类型取会话里的真实角色。
            role = "admin" if prefix.endswith("admin/v1") else (session.role if session else "user")
            actor = str(payload.get("username") or "") if action.endswith(".login") or action == "system.setup" else (session.username if session else None)
            # 分享令牌本身就是访问凭据，不写入审计。
            target_id = route.split("/")[2] if pattern.count("{}") and not pattern.startswith("/shares/") else None
            return {"action": action, "actor_type": role, "actor": actor or None, "payload": payload, "target_id": target_id,
                    "ip": (scope.get("client") or [None])[0]}
        return None

    def _write_audit(self, entry, *, ok, result=None, error=None):
        payload, action = entry["payload"], entry["action"]
        if action == "user.login" and ok and (result or {}).get("username"):
            entry = {**entry, "actor": result["username"]}
        if action == "user.login" and ok and (result or {}).get("role") == "admin":
            # 统一登录入口：管理员登录在审计里仍记为 admin.login。
            action, entry = "admin.login", {**entry, "actor_type": "admin"}
        # 只挑选非敏感字段：从不记录 password / passphrase / token / secret。
        target, detail = entry["target_id"], {}
        if action in ("user.create",):
            target, detail = payload.get("username"), {"quota_bytes": payload.get("quota_bytes")}
        elif action in ("user.status", "client.status", "bot.status"):
            detail = {"status": payload.get("status")}
        elif action == "user.quota":
            detail = {"quota_bytes": payload.get("quota_bytes")}
        elif action == "key.create":
            target = (result or {}).get("access_key_id") if ok else None
            detail = {"name": payload.get("name")}
        elif action in ("key.disable", "key.delete"):
            target = payload.get("access_key_id")
        elif action == "client.grant":
            detail = {key: payload.get(key) for key in ("bucket_id", "prefix", "perms")}
        elif action == "bot.create":
            target, detail = payload.get("name"), {"channel_id": payload.get("channel_id")}
        elif action == "bot.check" and ok:
            detail = {"status": (result or {}).get("status")}
        elif action == "resources.update":
            detail = {key: payload.get(key) for key in ("mode", "concurrency", "bandwidth_kib", "reserve_mib", "hls_enabled", "x_enabled", "youtube_enabled", "youtube_max_height", "platform_max_mib") if key in payload}
            if "proxy" in payload:
                # 代理地址可能包含认证信息，审计只记录是否启用。
                detail["proxy_enabled"] = bool(payload.get("proxy"))
        elif action == "download.create":
            detail = {"count": len(payload.get("items", [])) if isinstance(payload.get("items"), list) else 0}
        elif action == "share.save":
            target = str(payload.get("destination") or "") or "我的文件"
            detail = {"saved": (result or {}).get("saved"), "bytes": (result or {}).get("bytes")} if ok else {}
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
            target = ", ".join(str(item) for item in paths[:5]) + (f" 等 {len(paths)} 项" if len(paths) > 5 else "")
            detail = {"public": bool(payload.get("public")), **({"bucket_id": payload["bucket_id"]} if "bucket_id" in payload else {})}
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
        size = path.stat().st_size
        await send({"type": "http.response.start", "status": 200, "headers": self._headers({
            "Content-Type": "application/octet-stream", "Content-Length": str(size), "Cache-Control": "no-store",
            "Content-Disposition": f"attachment; filename={name}", "X-Content-Type-Options": "nosniff"})})
        with path.open("rb") as handle:
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
            result = self.keys.move(principal, bucket, payload["from"], payload["to"], payload.get("conflict", "skip"))
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

    async def _route(self, method, path, query, payload, token, csrf, ip=None, *, user=None, private=False, access="", origin=None, passkey_browser=""):
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
            if method == "GET" and route == "/settings":
                return 200, self.settings.describe(), {}
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
            if method == "GET" and route == "/objects":
                return 200, await self.admin.list_objects(token, limit=int(query.get("limit", ["100"])[0]),
                                                         cursor=query.get("cursor", [None])[0] or None, query=query.get("q", [""])[0],
                                                         public_only=query.get("public", ["0"])[0] in ("1", "true")), {}
            if method == "GET" and route == "/preview-assets":
                return 200, await self.admin.preview_assets(token, int(query.get("bucket_id", [""])[0]),
                                                           query.get("path", [""])[0]), {}
            if method == "GET" and route == "/preview-list":
                return 200, await self.admin.preview_list(token, int(query.get("bucket_id", [""])[0]),
                    query.get("path", [""])[0], query.get("cursor", [None])[0] or None), {}
            if method == "POST" and route == "/objects/public":
                return 200, self.admin.set_object_public(token, csrf, int(payload["bucket_id"]), payload["path"],
                                                         bool(payload["public"])), {}
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
            if method == "POST" and route == "/maintenance/cleanup":
                return 200, await self.admin.run_cleanup(token, csrf), {}
            if method == "POST" and route == "/maintenance/gc/retry":
                return 200, self.admin.retry_gc(token, csrf), {}
            if method == "GET" and route == "/backups":
                return 200, self.admin.list_backups(token), {}
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
            if route.startswith("/downloads") and self.offline is not None:
                session = user._session(token, csrf=csrf, mutation=method != "GET")
                account = user.accounts.account_for_session(session)
                private_scope = user._scope(token, csrf=csrf, mutation=method != "GET") if private else None
                private_activity = (lambda: self.private_space.activity(token, csrf, access, active=True)) if private else None
                if route == "/downloads/parse" and method == "POST":
                    return 200, await self.offline.parse(account.id, payload.get("input"), download_type=payload.get("download_type", "auto"), cookies=payload.get("cookies", "")), {"Cache-Control": "no-store"}
                if route == "/downloads" and method == "GET":
                    return 200, self.offline.list(account.id, cursor=int(query.get("cursor", ["0"])[0] or "0"), status=query.get("status", [""])[0], limit=int(query.get("limit", ["50"])[0]), private_scope=private_scope), {"Cache-Control": "no-store"}
                if route == "/downloads" and method == "POST":
                    return 201, {"tasks": self.offline.create(account.id, payload.get("items"), payload.get("destination", ""), private_scope=private_scope, private_activity=private_activity)}, {"Cache-Control": "no-store"}
                if route == "/downloads/clear" and method == "POST":
                    return 200, await self.offline.clear(account.id, payload.get("status")), {"Cache-Control": "no-store"}
                download = re.fullmatch(r"/downloads/(\d+)/(stop|resume|restart|delete|update)", route)
                if download and method == "POST":
                    result = await self.offline.control(account.id, int(download[1]), download[2], item=payload.get("item"), private_scope=private_scope, private_activity=private_activity)
                    return (204, None, {}) if result is None else (200, result, {"Cache-Control": "no-store"})
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
                user.set_thumbnail(token, csrf, payload["path"], payload.get("data"), str(payload.get("variant") or "thumb"))
                return 204, None, {}
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
            if method == "GET" and route == "/search":
                return 200, await user.search(token, query.get("q", [""])[0],
                    query.get("cursor", [""])[0], int(query.get("limit", ["100"])[0]),
                    public_only=query.get("public", ["0"])[0] == "1", kind=query.get("kind", [""])[0]), {}
            if method == "GET" and route == "/list":
                return 200, await user.list(token, prefix=query.get("prefix", [""])[0],
                                                 cursor=query.get("cursor", [None])[0], limit=int(query.get("limit", ["1000"])[0]),
                                                 public_only=query.get("public", ["0"])[0] == "1", kind=query.get("kind", [""])[0]), {}
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
            if info.key.endswith("/"):
                return 200, {"token": info.public_token, "kind": "folder", "name": info.key.rstrip("/").rsplit("/", 1)[-1],
                             "password_required": False, "modified_at": info.modified_at, "public_at": info.public_at,
                             "expires_at": info.public_expires_at}, {}
            thumbnails = user.objects.thumbnail_variants([info.blob_uuid]).get(info.blob_uuid or "", [])
            return 200, {"token": info.public_token, "kind": "file", "name": info.key.rsplit("/", 1)[-1], "size": info.size,
                         "content_type": info.content_type, "etag": info.etag, "password_required": False, "thumbnails": thumbnails,
                         "modified_at": info.modified_at, "public_at": info.public_at,
                         "expires_at": info.public_expires_at}, {}
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

    async def _content(self, send, method, token, query, headers, *, admin: bool = False, user=None, private=False):
        user = user or self.user
        path = query.get("path", [""])[0]
        if admin:
            bucket_id = int(query.get("bucket_id", [""])[0])
            info, _ = await self.admin.content(token, bucket_id, path)
            opener = lambda start, end: self.admin.content(token, bucket_id, path, start, end)
        else:
            info, _ = await user.content(token, path)
            opener = lambda start, end: user.content(token, path, start, end)
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
            data, mime, etag = self.user.objects.read_thumbnail(info, query["thumbnail"][0])
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
            return "private, max-age=2592000, immutable"
        return "private, no-cache"

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
        content_type = (info.content_type or "application/octet-stream").split(";", 1)[0].lower()
        inline = content_type in {
            "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon",
            "video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav",
            "audio/flac", "application/pdf", "text/plain",
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

    @staticmethod
    def _headers(headers):
        return [(k.lower().encode("ascii"), v.encode("latin-1")) for k, v in headers.items()]

    async def _send(self, send, status, result, extra=None):
        headers = dict(extra or {})
        data = b"" if result is None or status in (204, 304) else json.dumps(result, ensure_ascii=False).encode()
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
            message = str(exc) if str(exc).startswith(("访问密码", "登录", "验证", "通行密钥")) else "登录失败次数过多，请 15 分钟后再试"
        elif isinstance(exc, (AuthenticationError, SessionExpired)): status, code, message = 401, "unauthorized", "登录凭据无效或会话已过期"
        elif isinstance(exc, (CsrfError, PermissionError)): status, code, message = 403, "forbidden", "权限不足或 CSRF 校验失败"
        elif isinstance(exc, WorkBusyError):
            status, code, message = 503, "transfer_busy", "传输繁忙，请稍后重试"
            extra["Retry-After"] = "5"
        elif isinstance(exc, NotReadyError): status, code, message = 503, "locked", "系统尚未解锁"
        elif isinstance(exc, NotFoundError): status, code, message = 404, "not_found", "请求的资源不存在"
        elif isinstance(exc, InvalidRange):
            status, code, message = 416, "range_not_satisfiable", "请求的字节范围不可满足"
            extra["Content-Range"] = f"bytes */{exc.size}"
        elif isinstance(exc, IntegrityError): status, code, message = 500, "integrity_error", "文件完整性校验失败"
        elif isinstance(exc, QuotaExceededError): status, code, message = 413, "quota_exceeded", "已超过当前用户的存储配额"
        elif isinstance(exc, ValueError):
            status, code, message = 400, "bad_request", str(exc) or "请求参数不合法"
        elif isinstance(exc, (KeyError, TypeError)): status, code, message = 400, "bad_request", "请求参数不合法"
        else: status, code, message = 500, "internal_error", "内部服务错误"
        return status, {"error": {"code": code, "message": message}}, extra

    def _cookie(self, value, *, expires=False, max_age: int | None = None):
        return (f"tg_session={value}; HttpOnly; SameSite=Strict; Path=/api"
                + ("; Secure" if self.secure_cookies else "")
                + ("; Max-Age=0" if expires else f"; Max-Age={max_age if max_age is not None else int(self.admin.accounts.sessions.ttl)}"))
