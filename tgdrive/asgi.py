"""管理/用户 HTTP 入口；上传与下载通过异步迭代器传递背压。"""
from __future__ import annotations

import asyncio
import json
import mimetypes
import re
from pathlib import Path
from urllib.parse import parse_qs, quote

from .api import AdminApi, UserApi
from .audit import AuditLog
from .keyapi import KeyApi, KeyAuthError
from .authn import AuthenticationError, CsrfError, SessionExpired, TooManyAttempts, verify_password
from .objects import Scope
from .settings import SystemSettings
from .errors import IntegrityError, NotFoundError, NotReadyError, QuotaExceededError, ShareExpiredError, WrongPassphrase
from .share import ShareAccess


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


# 网页（用户端、控制台、文档、分享页）的安全响应头：只允许同源脚本，禁止被其他站点嵌入框架（防点击劫持）。
PAGE_SECURITY_HEADERS = {
    "Content-Security-Policy": ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                                "img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; connect-src 'self'; "
                                "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"),
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
}


class SharePasswordRequired(PermissionError):
    """带密码的分享缺少有效访问凭证。"""


class TgDriveASGI:
    def __init__(self, admin: AdminApi, user: UserApi, *, secure_cookies: bool = True,
                 json_limit: int = 1024 * 1024, s3=None, s3_host: str | None = None,
                 static_dir: str | Path | dict[str, str | Path] | None = None,
                 public_base_url: str | None = None, settings: SystemSettings | None = None,
                 keys: KeyApi | None = None, scheduler=None) -> None:
        self.scheduler = scheduler
        self.admin, self.user, self.s3 = admin, user, s3
        # /api/v1 只认访问密钥；未注入时使用用户 API 的对象服务与密钥存储。
        self.keys = keys or (KeyApi(user.objects, user.clients) if user.clients is not None else None)
        self.audit = AuditLog(admin.accounts.metadata)
        self.share_access = ShareAccess(admin.accounts.keystore)
        # 对外地址由管理员在控制台配置；启动参数 --public-url 只作为默认值。
        self.settings = settings or SystemSettings(admin.accounts.metadata, {"public_base_url": public_base_url})
        self.s3_host = s3_host.split(":", 1)[0].lower() if s3_host else None
        self.static_dir = ({key: Path(value).expanduser().resolve() for key, value in static_dir.items()}
                           if isinstance(static_dir, dict) else Path(static_dir).expanduser().resolve() if static_dir else None)
        self.secure_cookies, self.json_limit = secure_cookies, json_limit

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    if self.scheduler is not None:
                        self.scheduler.start()
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
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
        # 两个入口可同时登录。旧 Cookie 仅用于兼容，角色仍由服务层校验。
        cookie_name = "tg_admin_session" if path.startswith("/api/admin/") else "tg_user_session"
        token = cookies.get(cookie_name, cookies.get("tg_session", ""))
        csrf = headers.get("x-csrf-token", "")
        host = headers.get("host", "localhost").split(":", 1)[0].lower()
        query = parse_qs(scope.get("query_string", b"").decode(), keep_blank_values=True)
        started = False

        async def tracked_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        async def body_stream():
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    raise ConnectionError("上传连接已中断")
                if message["type"] != "http.request":
                    continue
                if message.get("body"):
                    yield message["body"]
                if not message.get("more_body", False):
                    return

        try:
            # 公开直链优先于 S3 路径路由；桶名至少 3 个字符，因此 /p/ 不会与桶冲突。
            if path.startswith("/p/") and method in ("GET", "HEAD"):
                await self._public_content(tracked_send, method, path, query, headers)
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
                    await self._send_stream(tracked_send, response.status, response.headers, response.stream, method)
                else:
                    await self._send_raw(tracked_send, response.status, response.headers, response.body)
                return
            if self.static_dir is not None and method in ("GET", "HEAD") and not path.startswith("/api/"):
                https = scope.get("scheme") == "https" or headers.get("x-forwarded-proto") == "https"
                await self._static(tracked_send, path, method, https=https)
                return
            if path.startswith("/api/v1/"):
                await self._key_api(tracked_send, method, path[len("/api/v1"):], query, headers, body_stream)
                return
            if path == "/api/user/v1/files" and method == "PUT":
                size = int(headers["content-length"]) if "content-length" in headers else None
                public = query.get("public", [None])[0]
                result = await self.user.put(token, csrf, query.get("path", [""])[0], body_stream(),
                                              headers.get("content-type"), size,
                                              None if public is None else public in ("1", "true"))
                await self._send(tracked_send, 200, result)
                return
            part_route = re.fullmatch(r"/api/user/v1/uploads/([A-Za-z0-9_-]+)/parts/(\d+)", path)
            if part_route and method == "PUT":
                size = int(headers["content-length"]) if "content-length" in headers else None
                result = await self.user.upload_part(token, csrf, part_route.group(1), int(part_route.group(2)), body_stream(), size)
                await self._send(tracked_send, 200, result)
                return
            if path == "/api/user/v1/thumbnail" and method == "GET":
                data, etag = self.user.thumbnail(token, query.get("path", [""])[0])
                if headers.get("if-none-match") == f'"{etag}"':
                    await self._send(tracked_send, 304, None, {"ETag": f'"{etag}"'})
                    return
                kind = "image/webp" if data[8:12] == b"WEBP" else "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"
                await self._send_raw(tracked_send, 200, {"Content-Type": kind, "ETag": f'"{etag}"', "Cache-Control": "private, max-age=86400",
                                                         "X-Content-Type-Options": "nosniff"}, data)
                return
            if path == "/api/user/v1/content" and method in ("GET", "HEAD"):
                await self._content(tracked_send, method, token, query, headers, admin=False)
                return
            if path.startswith("/api/admin/v1/backups/") and method == "GET":
                await self._backup_download(tracked_send, token, path.rsplit("/", 1)[-1])
                return
            if path == "/api/admin/v1/content" and method in ("GET", "HEAD"):
                await self._content(tracked_send, method, token, query, headers, admin=True)
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
            audit = self._audit_entry(method, path, payload, token, scope)
            try:
                status, result, extra = await self._route(method, path, query, payload, token, csrf,
                                                          ip=(scope.get("client") or [None])[0])
            except Exception as exc:
                if audit:
                    self._write_audit(audit, ok=False, error=exc)
                raise
            if audit:
                self._write_audit(audit, ok=True, result=result)
            await self._send(tracked_send, status, result, extra)
        except Exception as exc:
            if started:
                # 流已开始时交给 ASGI 服务器关闭连接，不能再发送第二个响应头。
                raise
            await self._send(tracked_send, *self._error(exc))

    # (前缀, 路由模式) → 审计动作。路由中的 {} 匹配一个路径段。
    _AUDITED = {
        "/api/admin/v1": {"/setup": "system.setup", "/login": "admin.login", "/logout": "admin.logout",
                          "/unlock": "system.unlock", "/lock": "system.lock", "/users": "user.create",
                          "/users/{}/status": "user.status", "/users/{}/quota": "user.quota", "/clients": "key.create",
                          "/clients/{}/status": "client.status", "/clients/{}/grants": "client.grant",
                          "/client-keys/disable": "key.disable", "/bots": "bot.create", "/bots/{}/status": "bot.status",
                          "/bots/{}/check": "bot.check", "/objects/public": "object.public", "/settings": "settings.update",
                          "/maintenance/gc": "maintenance.gc", "/maintenance/scrub": "maintenance.scrub",
                          "/maintenance/cleanup": "maintenance.cleanup", "/maintenance/gc/retry": "maintenance.gc_retry",
                          "/backups": "backup.create", "/password": "admin.password", "/passphrase": "system.passphrase",
                          "/users/{}/password": "user.password_reset", "/users/{}/delete": "user.delete"},
        "/api/user/v1": {"/login": "user.login", "/logout": "user.logout", "/password": "user.password",
                         "/clients": "key.create", "/client-keys/disable": "key.disable", "/public": "object.public",
                         "/trash/purge": "trash.purge"},
    }

    def _audit_entry(self, method, path, payload, token, scope):
        """在执行操作前确定审计动作与操作者（退出、锁定会清除会话，执行后就查不到了）。"""
        if method != "POST":
            return None
        for prefix, routes in self._AUDITED.items():
            if not path.startswith(prefix + "/"):
                continue
            route = path[len(prefix):]
            pattern = re.sub(r"^/(users|clients|bots)/\d+/", r"/\1/{}/", route)
            action = routes.get(pattern)
            if action is None:
                return None
            role = "admin" if prefix.endswith("admin/v1") else "user"
            session = self.admin.accounts.sessions.peek(token)
            actor = str(payload.get("username") or "") if action.endswith(".login") or action == "system.setup" else (session.username if session else None)
            target_id = route.split("/")[2] if pattern.count("{}") else None
            return {"action": action, "actor_type": role, "actor": actor or None, "payload": payload, "target_id": target_id,
                    "ip": (scope.get("client") or [None])[0]}
        return None

    def _write_audit(self, entry, *, ok, result=None, error=None):
        payload, action = entry["payload"], entry["action"]
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
        elif action == "key.disable":
            target = payload.get("access_key_id")
        elif action == "client.grant":
            detail = {key: payload.get(key) for key in ("bucket_id", "prefix", "perms")}
        elif action == "bot.create":
            target, detail = payload.get("name"), {"channel_id": payload.get("channel_id")}
        elif action == "bot.check" and ok:
            detail = {"status": (result or {}).get("status")}
        elif action == "object.public":
            paths = payload["paths"] if isinstance(payload.get("paths"), list) else [payload.get("path")]
            target = ", ".join(str(item) for item in paths[:5]) + (f" 等 {len(paths)} 项" if len(paths) > 5 else "")
            detail = {"public": bool(payload.get("public")), **({"bucket_id": payload["bucket_id"]} if "bucket_id" in payload else {})}
            if "expires_at" in payload:
                detail["expires_at"] = payload["expires_at"]
            if "password" in payload:
                detail["password"] = "set" if payload["password"] else "cleared"
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
            result = self.keys.list(principal, bucket, arg("prefix"), arg("cursor") or None, int(arg("limit", "1000")))
        elif method == "GET" and route == "/search":
            result = self.keys.search(principal, bucket, arg("q"), arg("cursor"), int(arg("limit", "100")))
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
                result = {"objects": self.keys.set_public(principal, bucket, paths, bool(payload["public"]), self._share_options(payload))}
            except Exception as exc:
                self._write_audit(entry, ok=False, error=exc)
                raise
            self._write_audit(entry, ok=True)
        else:
            raise NotFoundError("接口不存在")
        await self._send(send, 200, result)

    async def _route(self, method, path, query, payload, token, csrf, ip=None):
        if path.startswith("/api/admin/v1/"):
            route = path[len("/api/admin/v1"):]
            if method == "GET" and route == "/status":
                return 200, self.admin.status(), {}
            if method == "POST" and route == "/setup":
                result = self.admin.setup(payload["passphrase"], payload["username"], payload["password"])
                return 201, result, {}
            if method == "POST" and route == "/login":
                return self._login(self.admin.login(payload["username"], payload["password"], ip))
            # 除首次设置和登录外，修改操作统一要求管理员会话和 CSRF。
            session = self.admin.accounts.sessions.require(token, role="admin", csrf=csrf,
                                                           mutation=method != "GET")
            self.admin.accounts.account_for_session(session)
            if method == "GET" and route == "/me":
                return 200, {**self.admin.me(token), **self.settings.public_config()}, {}
            if method == "GET" and route == "/audit":
                before = query.get("cursor", [""])[0]
                return 200, self.audit.list(before=int(before) if before else None, limit=int(query.get("limit", ["50"])[0]),
                                            action=query.get("action", [""])[0] or None,
                                            failed_only=query.get("failed", ["0"])[0] in ("1", "true")), {}
            if method == "GET" and route == "/settings":
                return 200, self.settings.describe(), {}
            if method == "POST" and route == "/settings":
                return 200, self.settings.update(payload), {}
            if method == "POST" and route == "/unlock":
                return 200, self.admin.unlock(token, csrf, payload["passphrase"]), {}
            if method == "POST" and route == "/lock":
                self.admin.lock(token, csrf)
                return 204, None, {"Set-Cookie": self._cookie("", role="admin", expires=True)}
            if method == "POST" and route == "/logout":
                self.admin.logout(token)
                return 204, None, {"Set-Cookie": self._cookie("", role="admin", expires=True)}
            if not self.admin.accounts.keystore.unlocked:
                raise NotReadyError("系统尚未解锁")
            if method == "GET" and route == "/users":
                return 200, self.admin.list_users(token), {}
            if method == "GET" and route == "/clients":
                return 200, self.admin.list_clients(token), {}
            if method == "GET" and route == "/bots":
                return 200, self.admin.list_bots(token), {}
            if method == "POST" and route == "/users":
                quota = payload.get("quota_bytes")
                return 201, self.admin.create_user(token, csrf, payload["username"], payload["password"],
                                                    int(quota) if quota is not None and quota != "" else None), {}
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
                return 200, self.admin.list_objects(token, limit=int(query.get("limit", ["100"])[0]),
                                                    cursor=query.get("cursor", [None])[0] or None, query=query.get("q", [""])[0],
                                                    public_only=query.get("public", ["0"])[0] in ("1", "true")), {}
            if method == "POST" and route == "/objects/public":
                return 200, self.admin.set_object_public(token, csrf, int(payload["bucket_id"]), payload["path"],
                                                         bool(payload["public"])), {}
            if route.startswith("/users/") and method == "POST" and route.endswith("/delete"):
                return 200, await self.admin.delete_user(token, csrf, int(route.split("/")[2]), str(payload.get("confirm", ""))), {}
            if route.startswith("/users/") and method == "POST" and route.endswith("/password"):
                self.admin.reset_user_password(token, csrf, int(route.split("/")[2]), payload["password"])
                return 204, None, {}
            if method == "POST" and route == "/password":
                self.admin.change_own_password(token, csrf, payload["old_password"], payload["new_password"])
                return 204, None, {}
            if method == "POST" and route == "/passphrase":
                return 200, self.admin.change_passphrase(token, csrf, payload["old_passphrase"], payload["new_passphrase"]), {}
            if method == "GET" and route == "/maintenance/status":
                return 200, self.admin.maintenance_status(token), {}
            if method == "POST" and route == "/maintenance/cleanup":
                return 200, self.admin.run_cleanup(token, csrf), {}
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
            if method == "POST" and route == "/login":
                return self._login(self.user.login(payload["username"], payload["password"], ip))
            if method == "POST" and route == "/logout":
                self.user.accounts.sessions.require(token, role="user", csrf=csrf, mutation=True)
                self.user.logout(token)
                return 204, None, {"Set-Cookie": self._cookie("", role="user", expires=True)}
            if method == "GET" and route == "/me":
                return 200, {**self.user.me(token), **self.settings.public_config()}, {}
            if method == "POST" and route == "/password":
                self.user.change_password(token, csrf, payload["old_password"], payload["new_password"])
                return 204, None, {}
            if method == "GET" and route == "/public":
                return 200, self.user.list_public(token), {}
            if method == "POST" and route == "/public":
                paths = payload["paths"] if "paths" in payload else [payload["path"]]
                if not isinstance(paths, list):
                    raise ValueError("paths 必须为数组")
                return 200, {"objects": self.user.set_public(token, csrf, paths, bool(payload["public"]), self._share_options(payload))}, {}
            if method == "GET" and route == "/trash":
                return 200, self.user.list_trash(token), {}
            if method == "POST" and route == "/trash":
                return 200, {"items": await self.user.trash(token, csrf, list(payload["paths"]))}, {}
            if method == "POST" and route == "/trash/restore":
                return 200, {"restored": self.user.restore_trash(token, csrf, list(payload["ids"]))}, {}
            if method == "POST" and route == "/trash/purge":
                ids = None if payload.get("all") else list(payload["ids"])
                return 200, {"purged": await self.user.purge_trash(token, csrf, ids)}, {}
            if method == "POST" and route == "/thumbnail":
                self.user.set_thumbnail(token, csrf, payload["path"], str(payload["data"]))
                return 204, None, {}
            if method == "POST" and route == "/uploads":
                return 201, await self.user.create_upload(token, csrf, payload["path"], payload.get("content_type")), {}
            upload_route = re.fullmatch(r"/uploads/([A-Za-z0-9_-]+)(/complete)?", route)
            if upload_route and method == "GET" and not upload_route.group(2):
                return 200, self.user.get_upload(token, upload_route.group(1)), {}
            if upload_route and method == "POST" and upload_route.group(2):
                public = payload.get("public")
                return 200, await self.user.complete_upload(token, csrf, upload_route.group(1), list(payload["parts"]),
                                                            None if public is None else bool(public)), {}
            if upload_route and method == "DELETE" and not upload_route.group(2):
                await self.user.abort_upload(token, csrf, upload_route.group(1))
                return 204, None, {}
            if method == "GET" and route == "/search":
                return 200, self.user.search(token, query.get("q", [""])[0],
                    query.get("cursor", [""])[0], int(query.get("limit", ["100"])[0])), {}
            if method == "GET" and route == "/list":
                return 200, self.user.list(token, prefix=query.get("prefix", [""])[0],
                                          cursor=query.get("cursor", [None])[0], limit=int(query.get("limit", ["1000"])[0])), {}
            if method == "POST" and route == "/folders":
                return 201, await self.user.folder(token, csrf, payload["path"]), {}
            if method == "POST" and route == "/delete":
                return 200, {"results": await self.user.delete(token, csrf, payload["paths"], bool(payload.get("recursive", False)))}, {}
            if method == "POST" and route == "/move":
                return 200, await self.user.move(token, csrf, payload["from"], payload["to"], payload.get("conflict", "skip")), {}
            if method == "POST" and route == "/copy":
                return 201, await self.user.copy(token, csrf, payload["from"], payload["to"]), {}
            if method == "GET" and route == "/clients":
                return 200, self.user.list_clients(token), {}
            if method == "POST" and route == "/clients":
                return 201, self.user.create_client(token, csrf, payload["name"]), {}
            if method == "POST" and route == "/client-keys/disable":
                self.user.disable_client_key(token, csrf, payload["access_key_id"])
                return 204, None, {}
        elif path == "/api/public/v1/config" and method == "GET":
            return 200, self.settings.public_config(), {}
        elif re.fullmatch(r"/api/public/v1/objects/[A-Za-z0-9_-]+/unlock", path) and method == "POST":
            token = path.split("/")[5]
            info, password_hash = self._public_share(token)
            limiter, key = self.user.accounts.sessions, f"share:{token}|{ip or '-'}"
            if limiter.is_rate_limited(key):
                raise TooManyAttempts("too many attempts")
            if not password_hash or not verify_password(str(payload.get("password", "")), password_hash):
                limiter.record_failure(key)
                raise ValueError("访问密码不正确")
            access, expires = self.share_access.grant(token, password_hash)
            return 200, {"access": access, "expires_at": expires}, {}
        elif path.startswith("/api/public/v1/objects/") and method == "GET":
            token = path[len("/api/public/v1/objects/"):]
            info, password_hash = self._public_share(token)
            if password_hash and not self.share_access.check(token, password_hash, query.get("access", [None])[0]):
                return 200, {"token": token, "password_required": True}, {}
            return 200, {"token": info.public_token, "name": info.key.rsplit("/", 1)[-1], "size": info.size,
                         "content_type": info.content_type, "etag": info.etag, "password_required": False,
                         "modified_at": info.modified_at, "public_at": info.public_at,
                         "expires_at": info.public_expires_at}, {}
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

    def _login(self, result):
        token = result["session"]
        # 会话 ID 仅放 HttpOnly Cookie，浏览器脚本只需要 CSRF token。
        return 200, {k: v for k, v in result.items() if k != "session"}, {"Set-Cookie": self._cookie(token, role=result["role"])}

    async def _content(self, send, method, token, query, headers, *, admin: bool = False):
        path = query.get("path", [""])[0]
        if admin:
            bucket_id = int(query.get("bucket_id", [""])[0])
            info, _ = await self.admin.content(token, bucket_id, path)
            opener = lambda start, end: self.admin.content(token, bucket_id, path, start, end)
        else:
            info, _ = await self.user.content(token, path)
            opener = lambda start, end: self.user.content(token, path, start, end)
        await self._stream_object(send, method, info, opener, query, headers, "private")

    async def _public_content(self, send, method, path, query, headers):
        # /p/<token> 与 /p/<token>/<文件名> 等价，文件名只用于让链接更易读。
        token = path[len("/p/"):].split("/", 1)[0]
        info, password_hash = self._public_share(token)
        if password_hash and not self.share_access.check(token, password_hash, query.get("access", [None])[0]):
            raise SharePasswordRequired("password required")

        def opener(start, end):
            # 从头开始的完整读取计为一次下载；Range 续传与预览拖动不重复计数。
            if start == 0:
                self.user.objects.count_public_download(info.bucket_id, info.key)
            return self.user.objects.get_object(Scope(info.bucket_id), info.key, start, end)
        # 允许 CDN/浏览器存储，但每次使用前必须回源验证（ETag → 304）。关闭分享后回源即得到 404，链接立即失效。
        await self._stream_object(send, method, info, opener, query, headers, "public, no-cache")

    async def _stream_object(self, send, method, info, opener, query, headers, cache_control):
        etag = f'"{info.etag}"'
        if headers.get("if-none-match") in (etag, "*"):
            await self._send(send, 304, None, {"ETag": etag})
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
        # 首个窗口解密成功后才提交响应头；后续完整性失败使连接终止。
        first = await anext(iterator, b"")
        await send({"type": "http.response.start", "status": 206 if partial else 200,
                    "headers": self._headers(response_headers)})
        await send({"type": "http.response.body", "body": first, "more_body": True})
        async for chunk in iterator:
            await send({"type": "http.response.body", "body": chunk, "more_body": True})
        await send({"type": "http.response.body", "body": b""})

    async def _static(self, send, path: str, method: str, *, https: bool = False) -> None:
        assert self.static_dir is not None
        static_dir = self.static_dir
        if isinstance(static_dir, dict):
            # 生产部署可把两个应用挂到不同域名；本地单进程也按路径保持相同隔离。
            static_dir = static_dir["admin"] if path.startswith("/admin") else static_dir["user"]
        static_dir = Path(static_dir)
        relative = path.lstrip("/")
        if path.startswith("/admin"):
            relative = relative[len("admin"):].lstrip("/")
        candidate = (static_dir / relative).resolve() if relative else static_dir / "index.html"
        if static_dir not in candidate.parents and candidate != static_dir:
            await self._send(send, 404, {"error": {"code": "not_found", "message": "资源不存在"}})
            return
        if not candidate.is_file():
            candidate = static_dir / "index.html"
        if not candidate.is_file():
            await self._send(send, 404, {"error": {"code": "not_found", "message": "前端资源未构建"}})
            return
        data = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        headers = {"Content-Type": content_type, "Content-Length": str(len(data)),
                   "Cache-Control": "no-cache" if candidate.name == "index.html" else "public, max-age=31536000, immutable",
                   **PAGE_SECURITY_HEADERS}
        if https:
            headers["Strict-Transport-Security"] = "max-age=31536000"
        await send({"type": "http.response.start", "status": 200, "headers": self._headers(headers)})
        await send({"type": "http.response.body", "body": b"" if method == "HEAD" else data})

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

    async def _send_raw(self, send, status, headers, data):
        response_headers = {str(key): str(value) for key, value in headers.items()}
        response_headers.setdefault("Content-Length", str(len(data)))
        await send({"type": "http.response.start", "status": status, "headers": self._headers(response_headers)})
        await send({"type": "http.response.body", "body": data})

    @staticmethod
    def _error(exc):
        extra = {}
        if isinstance(exc, ShareExpiredError):
            status, code, message = 410, "share_expired", "分享链接已过期"
        elif isinstance(exc, SharePasswordRequired):
            status, code, message = 403, "password_required", "该分享需要访问密码"
        elif isinstance(exc, KeyAuthError):
            status, code, message = 401, "invalid_key", str(exc)
            # 使用 Bearer 质询，避免浏览器直接访问时弹出 Basic 登录框。
            extra["WWW-Authenticate"] = 'Bearer realm="tgdrive"'
        # 口令错误不是会话失效：返回 400，避免前端把管理员登出。
        elif isinstance(exc, WrongPassphrase): status, code, message = 400, "wrong_passphrase", "加密口令不正确"
        elif isinstance(exc, TooManyAttempts): status, code, message = 429, "too_many_attempts", "登录失败次数过多，请 15 分钟后再试"
        elif isinstance(exc, (AuthenticationError, SessionExpired)): status, code, message = 401, "unauthorized", "登录凭据无效或会话已过期"
        elif isinstance(exc, (CsrfError, PermissionError)): status, code, message = 403, "forbidden", "权限不足或 CSRF 校验失败"
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

    def _cookie(self, value, *, role="user", expires=False):
        return (f"tg_{role}_session={value}; HttpOnly; SameSite=Strict; Path=/api/{role}/v1"
                + ("; Secure" if self.secure_cookies else "")
                + ("; Max-Age=0" if expires else f"; Max-Age={int(self.admin.accounts.sessions.ttl)}"))
