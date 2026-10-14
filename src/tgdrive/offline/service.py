"""持久下载队列。后台授权绑定账号，绝不保存网页会话或明文来源凭据。"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import re
import time
from collections.abc import Callable
from dataclasses import replace
from email.message import Message
from urllib.parse import parse_qs, unquote, urlsplit

from cryptography.exceptions import InvalidTag

from ..api import normalize_user_path
from ..crypto import derive_subkey, open_sealed, seal
from ..errors import NotFoundError, NotReadyError, QuotaExceededError
from ..objects import PRIVATE_PREFIX, Scope
from ..work import WorkBusyError
from .hls import load_playlist, remux
from .http import RETRY_STATUS, DownloadError, SafeHttpClient, TransientError, status_error
from .request import DownloadRequest, filename, parse_requests, url_filename
from .platforms import MIB, ExpiredMedia, PlatformResolver, allowed_url, clear_cache, media_request, merge_tracks, prepare, site_link, track_stream


PART_SIZE = 16 * 1024 * 1024
ACTIVE = ("queued", "running", "interrupted")
RETRY_DELAYS = (10, 30, 90)
# mimetypes 对这几种常见类型给出的扩展名不符合习惯（如 .jpe），这里固定。
KNOWN_EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
                    "video/mp4": ".mp4", "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "application/pdf": ".pdf",
                    "application/zip": ".zip", "text/plain": ".txt"}
# 解析结果的复用期限；YouTube 地址自带 expire 参数时以它为准。
RESOLVED_TTL = {"x": 24 * 3600, "youtube": 3 * 3600}
PUBLIC_FIELDS = ("id", "key", "source_host", "method", "kind", "platform", "phase", "status", "size", "received", "stored_bytes", "segments_done", "segments_total", "duration", "processed_seconds", "elapsed_seconds", "error", "created_at", "updated_at")


class Paused(NotReadyError):
    pass


class PrivateTaskLocked(Paused):
    pass


class OfflineDownloads:
    def __init__(self, accounts, objects, resources, *, http=None):
        self.accounts, self.objects, self.resources = accounts, objects, resources
        self.metadata, self.keystore = objects.metadata, accounts.keystore
        self.http = http or SafeHttpClient(proxy=lambda: resources.config()["proxy"])
        self._runner = None
        self._running: dict[int, asyncio.Task] = {}
        self._stats: dict[int, dict] = {}
        self._intents: dict[int, tuple[str, str | None]] = {}
        self._controls: dict[int, asyncio.Lock] = {}
        self._control_refs: dict[int, int] = {}
        self._wake = asyncio.Event()
        self._parse_slots = asyncio.Semaphore(2)
        self._closing = False
        self._next_byte = 0.0
        self._pressure_at, self._pressure = 0.0, None
        self._checked: dict[int, float] = {}
        # 私密授权只存在于当前进程内存；服务重启后由用户解锁并手动恢复任务。
        self._private_authorizers: dict[int, Callable[[], None]] = {}
        self._limit_at, self._limit = 0.0, 0
        # 自动重试状态只在进程内保存；重启后“等待恢复”的任务本来就会继续。
        self._retries: dict[int, int] = {}
        self._retry_at: dict[int, float] = {}
        self.platforms = PlatformResolver(self.http, resources)
        self.cache_root = resources.data_dir / "offline-cache"

    def _key(self, label="offline-request"):
        return derive_subkey(self.keystore.require_kek(), label)

    def _source(self, row):
        return json.loads(open_sealed(self._key(), row["request_enc"], f"offline:{row['id']}"))

    def _save_source(self, task_id, value):
        encrypted = seal(self._key(), json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(), f"offline:{task_id}")
        self._set(task_id, request_enc=encrypted)

    def _row(self, task_id: int, user_id: int | None = None):
        row = self.metadata.db.execute("SELECT * FROM offline_tasks WHERE id=?" + (" AND user_id=?" if user_id is not None else ""),
            (task_id, user_id) if user_id is not None else (task_id,)).fetchone()
        if row is None:
            raise NotFoundError("下载任务不存在")
        return row

    def _set(self, task_id, **values):
        # 字段名均由本模块静态提供，不能由 API payload 传入。
        values["updated_at"] = time.time()
        with self.metadata.transaction() as db:
            db.execute("UPDATE offline_tasks SET " + ",".join(f"{key}=?" for key in values) + " WHERE id=?", (*values.values(), task_id))

    def scope(self, user_id: int) -> Scope:
        def authorize():
            if not self.keystore.unlocked:
                raise Paused("系统已锁定，解锁后继续")
            row = self.metadata.db.execute("SELECT status,bucket_id FROM users WHERE id=?", (user_id,)).fetchone()
            if row is None or row["status"] != "active":
                raise Paused("账号已禁用或删除")
        authorize()
        account = self.metadata.db.execute("SELECT bucket_id FROM users WHERE id=?", (user_id,)).fetchone()
        if account[0] is None:
            raise PermissionError("账号没有文件空间")
        return Scope(account[0], authorize=authorize)

    def check(self, user_id: int, task_id: int | None = None):
        # 每个 64 KiB 数据块都会调用；账号与锁定状态每 0.5 秒查一次库即可。
        # 禁用账号和锁定系统另有直接取消任务的路径，不依赖这里的检查及时生效。
        now = time.monotonic()
        if now - self._checked.get(user_id, 0) > 0.5:
            self.scope(user_id)
            self._checked[user_id] = now
        if task_id is not None:
            row = self._row(task_id)
            if row["key"].startswith(PRIVATE_PREFIX):
                authorize = self._private_authorizers.get(task_id)
                if authorize is None:
                    raise PrivateTaskLocked("私密空间已锁定，请解锁后继续下载")
                try:
                    authorize()
                except PermissionError as exc:
                    raise PrivateTaskLocked(str(exc) or "私密空间已锁定，请解锁后继续下载") from exc
        if now - self._pressure_at > 1:
            self._pressure_at, self._pressure = now, self.resources.pressure()
        if self._pressure:
            raise Paused(self._pressure)

    async def throttle(self, size: int):
        if time.monotonic() - self._limit_at > 1:
            self._limit_at, self._limit = time.monotonic(), self.resources.effective()["bandwidth_kib"] * 1024
        limit = self._limit
        if not limit:
            self._next_byte = 0.0
            return
        now = time.monotonic()
        start = max(now, self._next_byte)
        self._next_byte = start + size / limit
        if start > now:
            await asyncio.sleep(start - now)

    async def parse(self, user_id: int, text: str, *, download_type="auto", cookies="") -> dict:
        if download_type not in ("auto", "http", "hls", "x", "youtube"):
            raise ValueError("下载类型不正确")
        if not isinstance(cookies, str) or len(cookies.encode()) > 32768:
            raise ValueError("Cookie 文本不能超过 32 KiB")
        self.scope(user_id)
        requests = parse_requests(text)
        sites = [site_link(request.url) if download_type in ("auto", "x", "youtube") else None for request in requests]
        if sum(site is not None for site in sites) > 1:
            raise ValueError("每次解析一个 X 帖子或 YouTube 视频，媒体可在解析后逐项选择")
        async def inspect(request, site):
            async with self._parse_slots:
                if download_type in ("x", "youtube") and (not site or site[0] != download_type):
                    raise ValueError("链接与选择的平台不匹配")
                if site:
                    return await self._parse_platform(user_id, request, site, cookies)
                if cookies:
                    raise ValueError("额外的 Cookie 导入只用于平台链接；文件直链请在 curl 命令中携带 Cookie")
                return await self._parse_request(user_id, request, download_type)
        groups = await asyncio.gather(*(inspect(request, site) for request, site in zip(requests, sites)))
        candidates = [{**candidate, "group": f"{index}:{candidate.get('group', '0')}"} for index, group in enumerate(groups) for candidate in group]
        if len(candidates) > 32:
            raise ValueError("解析结果超过 32 个文件，请分批提交")
        self.scope(user_id)
        return {"candidates": candidates}

    def _encode_ticket(self, value):
        import base64
        return base64.urlsafe_b64encode(seal(self._key("offline-ticket"), json.dumps(value, ensure_ascii=False).encode(), "offline-ticket")).decode()

    async def _parse_platform(self, user_id, request, site, cookies):
        platform, media_id, canonical = site
        source = prepare(request, cookies, platform, media_id, canonical)
        self.platforms.client = self.http
        entries = await self.platforms.resolve(source, lambda: self.check(user_id))
        candidates = []
        for entry in entries:
            if entry.get("too_large"):
                continue
            ticket = {"user_id": user_id, "expires": time.time() + 1200, "request": request.json(),
                      "kind": "http", "size": entry["size"], "content_type": entry["content_type"],
                      "platform": platform, "platform_source": {**source, "selection": entry["selection"],
                          "entry": entry, "resolved_at": time.time()}}
            warnings = list(request.warnings)
            if any(key.lower() not in ("cookie", "user-agent") for key, _ in request.headers):
                warnings.append("平台解析仅使用 Cookie 和 User-Agent，其余自定义请求头不转发")
            if entry.get("estimated_size") and entry["size"] is None:
                warnings.append(f"估算大小约 {entry['estimated_size'] / MIB:.1f} MiB，实际大小将在下载时校验")
            candidates.append({"ticket": self._encode_ticket(ticket), "group": entry["group"],
                "name": request.name or entry["name"], "source_host": urlsplit(canonical).hostname,
                "method": "GET", "kind": "http", "platform": platform, "media_type": entry["media_type"],
                "size": entry["size"], "variant": entry["variant"], "warnings": warnings,
                "header_names": ["Cookie"] if source["cookies"] else [], "body_bytes": 0})
        if not candidates:
            raise DownloadError("可用媒体需要的临时缓存超过当前资源上限，请选择其他格式或调整资源设置")
        return candidates

    async def _parse_request(self, user_id, request, download_type):
        candidates = []
        name, size, content_type = request.name or url_filename(request.url), None, None
        # POST 的解析完全不访问来源，不预先发送，也不进行探测性重放。
        if request.method == "GET":
            try:
                async with asyncio.timeout(6):
                    for method in ("HEAD", "GET"):
                        # 兼容拒绝 HEAD 或省略元数据的来源；GET 只读响应头，立即关闭连接。
                        async with self.http.open(request, method=method, identity=True) as response:
                            if response.status != 200:
                                if method == "HEAD" and response.status in (400, 403, 405, 501):
                                    continue
                                raise DownloadError(f"来源未提供文件信息（HTTP {response.status}），请检查链接和认证参数")
                            size = response.size
                            content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower() or None
                            message = Message()
                            message["Content-Disposition"] = response.headers.get("content-disposition", "")
                            suggested = message.get_filename()
                            if suggested and not request.name:
                                name = filename(unquote(suggested))
                            if method == "GET" or size is not None and content_type:
                                break
            except DownloadError as exc:
                request.warnings.append(f"暂未取得文件信息：{exc}")
            except TimeoutError:
                request.warnings.append("获取文件信息超时，开始下载时会再次校验来源")
        if not request.name and "." not in name and content_type and content_type != "application/octet-stream":
            # 地址里没有扩展名（如 /it/u=123&fm=3028）时按来源的 Content-Type 补上，便于识别和打开文件。
            extension = KNOWN_EXTENSIONS.get(content_type) or mimetypes.guess_extension(content_type, strict=False)
            if extension:
                name = filename(name + extension)
        detected_hls = urlsplit(request.url).path.lower().endswith(".m3u8") or name.lower().endswith(".m3u8") or content_type in ("application/vnd.apple.mpegurl", "application/x-mpegurl")
        hls = download_type == "hls" or download_type == "auto" and detected_hls
        choices = [(request, None, None)]
        if hls:
            effective = self.resources.effective()
            if not effective["hls_enabled"] or not effective["hls_available"]:
                raise ValueError("M3U8 下载尚未启用，请联系管理员安装 FFmpeg 并在系统设置中启用")
            playlist = await load_playlist(self.http, request)
            if playlist.variants:
                choices = [(replace(request, url=url, credential_origin=request.credential_origin or request.url), label,
                            replace(request, url=playlist.audio[url], credential_origin=request.credential_origin or request.url).json() if url in playlist.audio else None)
                           for url, label in playlist.variants]
            stem = name.rsplit(".", 1)[0] if "." in name else name
            name = filename(stem + ".mp4")
        for choice, label, audio in choices:
            if len(candidates) >= 32:
                raise ValueError("解析结果超过 32 个文件，请分批提交")
            ticket = {"user_id": user_id, "expires": time.time() + 1200, "request": choice.json(), "kind": "hls" if hls else "http", "size": None if hls else size, "content_type": "video/mp4" if hls else content_type, "hls_audio": audio}
            import base64
            encoded = base64.urlsafe_b64encode(seal(self._key("offline-ticket"), json.dumps(ticket, ensure_ascii=False).encode(), "offline-ticket")).decode()
            candidates.append({"ticket": encoded, "name": name, "source_host": urlsplit(choice.url).hostname, "method": choice.method,
                "kind": ticket["kind"], "content_type": ticket["content_type"], "size": ticket["size"], "variant": label, "warnings": choice.warnings,
                "header_names": [key for key, _ in choice.headers], "body_bytes": len((choice.body or "").encode())})
        self.scope(user_id)
        return candidates

    def _ticket(self, user_id, token):
        import base64
        try:
            if not isinstance(token, str) or len(token) > 1048576:
                raise ValueError()
            value = json.loads(open_sealed(self._key("offline-ticket"), base64.urlsafe_b64decode(token), "offline-ticket"))
            if value["user_id"] != user_id or value["expires"] < time.time():
                raise ValueError()
            return value
        except (ValueError, InvalidTag, KeyError, TypeError) as exc:
            raise ValueError("解析结果已过期或加密口令已变更，请重新解析") from exc

    def create(self, user_id: int, items: list, destination: str, *, private_scope: Scope | None = None,
               private_activity=None, key_scope: Scope | None = None) -> list[dict]:
        regular_scope = self.scope(user_id)
        if key_scope is not None:
            # 访问密钥创建的任务只能写入密钥的授权前缀；运行时仍按账号身份校验。
            if key_scope.bucket_id != regular_scope.bucket_id:
                raise PermissionError("离线下载只能保存到密钥所属用户的存储桶")
            regular_scope = replace(regular_scope, prefix=key_scope.prefix, perms=key_scope.perms)
        if not isinstance(items, list) or not 1 <= len(items) <= 32:
            raise ValueError("一次请选择 1–32 个文件")
        if not isinstance(destination, str):
            raise ValueError("目标目录不正确")
        private_destination = destination.startswith(PRIVATE_PREFIX)
        if private_destination:
            if private_scope is None or not private_scope.private_access or private_scope.bucket_id != regular_scope.bucket_id:
                raise ValueError("请先解锁私密空间，再选择私密下载位置")
            if private_scope.authorize is not None:
                private_scope.authorize()
            relative = destination[len(PRIVATE_PREFIX):]
            prefix = PRIVATE_PREFIX + (normalize_user_path(relative, directory=True) if relative else "")
            scope = private_scope
        else:
            prefix = normalize_user_path(destination, directory=True) if destination else ""
            scope = regular_scope
        decoded = []
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str):
                raise ValueError("文件名称不正确")
            value = self._ticket(user_id, item.get("ticket"))
            name = normalize_user_path(item["name"])
            if "/" in name:
                raise ValueError("文件名称不能包含路径")
            key = prefix + name
            self.objects._check_scope(scope, key, write=True)
            decoded.append((value, key))
        now, ids = time.time(), []
        with self.metadata.transaction() as db:
            pending = db.execute("SELECT COUNT(*) FROM offline_tasks WHERE user_id=? AND status!='completed'", (user_id,)).fetchone()[0]
            if pending + len(decoded) > 500:
                raise ValueError("未完成任务最多 500 个，请先清理任务")
            reserved = {row[0] for row in db.execute("SELECT key FROM offline_tasks WHERE bucket_id=? AND status!='completed'", (scope.bucket_id,))}
            for value, key in decoded:
                if key in reserved or db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key)).fetchone():
                    key = self.objects._free_name(db, scope.bucket_id, key, reserved)
                self.objects._check_scope(scope, key, write=True)
                request = DownloadRequest.from_json(value["request"])
                platform = value.get("platform")
                source_host = urlsplit(value["platform_source"]["url"]).hostname if platform else urlsplit(request.url).hostname
                cursor = db.execute("INSERT INTO offline_tasks(user_id,bucket_id,key,source_host,method,kind,platform,request_enc,status,size,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?)",
                    (user_id, scope.bucket_id, key, source_host, request.method, value["kind"], platform, b"", value["size"], now, now))
                task_id = cursor.lastrowid
                self._save_source(task_id, {"request": request.json(), "state": {}, "content_type": value["content_type"], "platform_source": value.get("platform_source"), "hls_audio": value.get("hls_audio")})
                reserved.add(key)
                ids.append(task_id)
        if private_destination:
            authorize = self._private_authorizer(private_scope, private_activity)
            for task_id in ids:
                self._private_authorizers[task_id] = authorize
        self._wake.set()
        return [self.public(self._row(task_id), reveal_private=private_destination) for task_id in ids]

    @staticmethod
    def _private_authorizer(scope: Scope, activity=None):
        def authorize():
            try:
                if scope.authorize is not None:
                    scope.authorize()
                if activity is not None:
                    activity()
            except PermissionError as exc:
                raise PrivateTaskLocked(str(exc) or "私密空间已锁定，请解锁后继续下载") from exc
        return authorize

    def public(self, row, *, reveal_private=False):
        result = {key: row[key] for key in PUBLIC_FIELDS}
        result["private"] = row["key"].startswith(PRIVATE_PREFIX)
        if result["private"] and not reveal_private:
            result["key"] = "私密空间下载"
        stats = self._stats.get(row["id"], {})
        result.update({key: value for key, value in stats.items() if key in ("received", "segments_done", "processed_seconds")})
        speed = stats.get("speed", 0) if time.monotonic() - stats.get("tick", 0) < 3 else 0
        result["speed"] = speed if row["status"] == "running" and row["phase"] not in ("merging", "saving", "resolving") else 0
        result["eta_seconds"] = max(0, (row["size"] - result["received"]) / speed) if result["speed"] and row["size"] and row["kind"] == "http" else None
        return result

    def list(self, user_id, *, cursor=0, status="", limit=50, private_scope: Scope | None = None):
        self.scope(user_id)
        reveal_private = bool(private_scope and private_scope.private_access)
        if reveal_private and private_scope.authorize is not None:
            private_scope.authorize()
        if status not in ("", "active", "stopped", "completed", "failed") or cursor < 0:
            raise ValueError("任务筛选或分页参数不正确")
        limit = max(1, min(limit, 100))
        where, args = "user_id=?", [user_id]
        if status == "active":
            where += " AND status IN ('queued','running','interrupted')"
        elif status:
            where += " AND status=?"
            args.append(status)
        total = self.metadata.db.execute(f"SELECT COUNT(*) FROM offline_tasks WHERE {where}", args).fetchone()[0]
        if cursor:
            where += " AND id<?"
            args.append(cursor)
        rows = self.metadata.db.execute(f"SELECT {','.join(PUBLIC_FIELDS)} FROM offline_tasks WHERE {where} ORDER BY id DESC LIMIT ?", (*args, limit + 1)).fetchall()
        effective = self.resources.effective()
        return {"tasks": [self.public(row, reveal_private=reveal_private) for row in rows[:limit]], "total": total,
                "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
                "capabilities": {"hls": effective["hls_enabled"] and effective["hls_available"],
                    "x": effective["x_enabled"] and effective["x_available"],
                    "youtube": effective["youtube_enabled"] and effective["youtube_available"],
                    "concurrency": effective["concurrency"], "pressure": self.resources.pressure()}}

    def status_of(self, user_id: int, ids: list[int], permits: Callable[[str], bool]) -> list[dict]:
        """按 ID 查询任务状态（访问密钥轮询进度用）：只返回该用户、路径被 permits 允许的普通任务，不含私密任务。"""
        self.scope(user_id)
        if not isinstance(ids, list) or len(ids) > 100 or not all(type(value) is int for value in ids):
            raise ValueError("ids 最多 100 个任务编号")
        if not ids:
            return []
        rows = self.metadata.db.execute(f"SELECT {','.join(PUBLIC_FIELDS)} FROM offline_tasks WHERE user_id=? AND id IN ({','.join('?' * len(ids))}) ORDER BY id",
                                        (user_id, *ids)).fetchall()
        return [self.public(row) for row in rows if not row["key"].startswith(".tgdrive/") and permits(row["key"])]

    async def control(self, user_id, task_id, action, *, item=None, private_scope: Scope | None = None,
                      private_activity=None):
        if action not in ("stop", "resume", "restart", "delete", "update"):
            raise ValueError("下载任务操作不正确")
        self.scope(user_id)
        lock = self._controls.setdefault(task_id, asyncio.Lock())
        self._control_refs[task_id] = self._control_refs.get(task_id, 0) + 1
        try:
            async with lock:
                row = self._row(task_id, user_id)
                private_task = row["key"].startswith(PRIVATE_PREFIX)
                reveal_private = False
                if private_task and action in ("resume", "restart", "update"):
                    if (private_scope is None or not private_scope.private_access
                            or private_scope.bucket_id != row["bucket_id"] or private_scope.prefix != PRIVATE_PREFIX):
                        raise ValueError("请先解锁私密空间后继续下载")
                    authorize = self._private_authorizer(private_scope, private_activity)
                    authorize()
                    self._private_authorizers[task_id] = authorize
                    reveal_private = True
                if action == "resume" and row["status"] in ("running", "queued"):
                    return self.public(row, reveal_private=reveal_private)
                if action == "stop" and row["status"] == "completed":
                    return self.public(row)
                if action == "resume" and row["status"] == "completed":
                    raise ValueError("已完成的任务请使用重新下载")
                replacement = self._ticket(user_id, item.get("ticket")) if action == "update" and isinstance(item, dict) else None
                if action == "update" and replacement is None:
                    raise ValueError("请选择重新解析后的文件")
                if replacement and (replacement["kind"] != row["kind"] or replacement.get("platform") != row["platform"]):
                    raise ValueError("更新参数不能改变文件下载类型，请添加新任务")
                await self._cancel(task_id, "stopped", None)
                # 手动操作重新计算自动重试次数。
                self._retries.pop(task_id, None)
                self._retry_at.pop(task_id, None)
                row = self._row(task_id, user_id)
                self.scope(user_id)
                if action == "delete":
                    await self._discard(row)
                    with self.metadata.transaction() as db:
                        db.execute("DELETE FROM offline_tasks WHERE id=? AND user_id=?", (task_id, user_id))
                    self._private_authorizers.pop(task_id, None)
                    return None
                if action in ("restart", "update"):
                    await self._discard(row)
                    self._set(task_id, received=0, stored_bytes=0, segments_done=0, processed_seconds=0, elapsed_seconds=0)
                    source = self._source(self._row(task_id))
                    source["state"] = {}
                    if action == "update":
                        if not isinstance(item, dict):
                            raise ValueError("请选择重新解析后的文件")
                        value = replacement
                        source.update(request=value["request"], content_type=value["content_type"], platform_source=value.get("platform_source"), hls_audio=value.get("hls_audio"))
                        self._set(task_id, kind=value["kind"], method=value["request"]["method"], source_host=urlsplit(value["platform_source"]["url"] if value.get("platform") else value["request"]["url"]).hostname, size=value["size"])
                    self._save_source(task_id, source)
                self._set(task_id, status="stopped" if action == "stop" else "queued", phase=None, error=None)
                if action == "stop" and private_task:
                    self._private_authorizers.pop(task_id, None)
                self._wake.set()
                return self.public(self._row(task_id), reveal_private=reveal_private)
        finally:
            self._control_refs[task_id] -= 1
            if not self._control_refs[task_id]:
                self._control_refs.pop(task_id)
                self._controls.pop(task_id, None)

    async def clear(self, user_id, status):
        """批量删除已完成或失败的任务；已保存的文件保留，失败任务的未完成分片一并清理。"""
        if status not in ("completed", "failed"):
            raise ValueError("只能清理已完成或失败的任务")
        self.scope(user_id)
        rows = self.metadata.db.execute("SELECT id FROM offline_tasks WHERE user_id=? AND status=? ORDER BY id LIMIT 500",
                                        (user_id, status)).fetchall()
        removed = 0
        for row in rows:
            try:
                await self.control(user_id, row["id"], "delete")
                removed += 1
            except NotFoundError:
                pass
        return {"removed": removed}

    async def _discard(self, row):
        if row["upload_id"]:
            upload = self.metadata.db.execute("SELECT completed_at FROM uploads WHERE upload_id=?", (row["upload_id"],)).fetchone()
            if upload and upload[0] is None:
                cleanup_scope = (Scope(row["bucket_id"], PRIVATE_PREFIX, private_access=True)
                                 if row["key"].startswith(PRIVATE_PREFIX) else Scope(row["bucket_id"]))
                await self.objects.abort_multipart(cleanup_scope, row["upload_id"])
            self._set(row["id"], upload_id=None)

    async def _cancel(self, task_id, status, error):
        self._intents[task_id] = (status, error)
        task = self._running.get(task_id)
        if task and not task.done():
            # 只取消一次，并让分片写入、GC 和子进程回收完成；请求或调度器取消不能再次打断清理。
            if not task.cancelling():
                task.cancel()
            await asyncio.shield(asyncio.gather(task, return_exceptions=True))
        self._set(task_id, status=status, error=error)
        self._intents.pop(task_id, None)

    async def cancel_user(self, user_id):
        rows = self.metadata.db.execute("SELECT id FROM offline_tasks WHERE user_id=? AND status!='completed'", (user_id,)).fetchall()
        for row in rows:
            await self._cancel(row["id"], "stopped", "账号已删除")
            await self._discard(self._row(row["id"]))

    def pause_user(self, user_id):
        with self.metadata.transaction() as db:
            db.execute("UPDATE offline_tasks SET status='stopped',error='账号已禁用',updated_at=? WHERE user_id=? AND status IN ('queued','running','interrupted')", (time.time(), user_id))
        for task_id, task in self._running.items():
            if not task.done() and self._row(task_id)["user_id"] == user_id:
                self._intents[task_id] = ("stopped", "账号已禁用")
                if not task.cancelling():
                    task.cancel()

    def start(self):
        if self._runner is not None:
            return
        self._closing = False
        clear_cache(self.cache_root)
        with self.metadata.transaction() as db:
            db.execute("UPDATE offline_tasks SET status=CASE WHEN method='POST' THEN 'stopped' ELSE 'interrupted' END,"
                       "error=CASE WHEN method='POST' THEN '服务已重启，POST 任务需手动重新发送' ELSE '服务已重启，等待恢复' END,updated_at=? WHERE status='running'", (time.time(),))
            db.execute("UPDATE offline_tasks SET status='stopped',error='POST 任务已中断，请手动重新发送',updated_at=? WHERE method='POST' AND status='interrupted'", (time.time(),))
        self._runner = asyncio.create_task(self._loop())

    async def stop(self):
        self._closing = True
        self._wake.set()
        if self._runner:
            self._runner.cancel()
            await asyncio.gather(self._runner, return_exceptions=True)
            self._runner = None
        for task_id in list(self._running):
            if self._running[task_id].done():
                continue
            row = self._row(task_id)
            if not self._running[task_id].done():
                status = ("stopped" if row["method"] == "POST" else "interrupted") if row["status"] in ACTIVE else row["status"]
                await self._cancel(task_id, status, "服务已停止" if row["status"] in ACTIVE else row["error"])
        self._running.clear()

    async def _loop(self):
        while not self._closing:
            try:
                for task_id, task in list(self._running.items()):
                    if task.done():
                        self._running.pop(task_id, None)
                        self._intents.pop(task_id, None)
                        continue
                    row = self._row(task_id)
                    try:
                        self.check(row["user_id"], task_id)
                    except PrivateTaskLocked as exc:
                        self._private_authorizers.pop(task_id, None)
                        await self._cancel(task_id, "interrupted", str(exc))
                    except Paused as exc:
                        status = "stopped" if "账号" in str(exc) or row["method"] == "POST" else "interrupted"
                        await self._cancel(task_id, status, str(exc))
                config = self.resources.effective()
                if self.keystore.unlocked and not self.resources.pressure():
                    candidates = self.metadata.db.execute("SELECT t.id,t.user_id,t.kind,t.method,t.platform FROM offline_tasks t JOIN users u ON u.id=t.user_id WHERE t.status IN ('queued','interrupted') AND u.status='active' ORDER BY t.id LIMIT 100").fetchall()
                    hls_running = any(self._row(task_id)["kind"] == "hls" or self._row(task_id)["platform"] == "youtube" for task_id in self._running)
                    now = time.monotonic()
                    for row in candidates:
                        if len(self._running) >= config["concurrency"]:
                            break
                        if row["id"] in self._running or row["id"] in self._controls or self._retry_at.get(row["id"], 0) > now:
                            continue
                        if self._row(row["id"])["key"].startswith(PRIVATE_PREFIX) and row["id"] not in self._private_authorizers:
                            continue
                        if (row["kind"] == "hls" or row["platform"] == "youtube") and hls_running:
                            continue
                        if row["platform"]:
                            # 解析子进程由 PlatformResolver 全局限制为一个；复用解析结果的任务可以并行下载。
                            if not config[f"{row['platform']}_enabled"] or not config[f"{row['platform']}_available"]:
                                self._set(row["id"], status="stopped", phase=None, error="平台下载未启用或缺少本地解析组件")
                                continue
                        if row["kind"] == "hls" and (not config["hls_enabled"] or not config["hls_available"]):
                            self._set(row["id"], status="stopped", error="M3U8 下载未启用或未安装 FFmpeg")
                            continue
                        self._set(row["id"], status="running", error=None)
                        self._running[row["id"]] = asyncio.create_task(self._run(row["id"]))
                        hls_running |= row["kind"] == "hls" or row["platform"] == "youtube"
            except (NotFoundError, NotReadyError):
                pass
            self._wake.clear()
            try:
                async with asyncio.timeout(1):
                    await self._wake.wait()
            except TimeoutError:
                pass

    def _progress(self, task_id, *, bytes_in=0, segment=None, seconds=0):
        stats = self._stats[task_id]
        stats["received"] += bytes_in
        if segment is not None:
            stats["segments_done"] = segment
            stats["processed_seconds"] += seconds
        now = time.monotonic()
        elapsed = now - stats["tick"]
        if elapsed >= 1:
            stats["speed"] = (stats["received"] - stats["last_bytes"]) / elapsed
            stats["tick"], stats["last_bytes"] = now, stats["received"]
            self._set(task_id, **{key: stats[key] for key in ("received", "segments_done", "processed_seconds")})

    async def _run(self, task_id):
        started = time.monotonic()
        try:
            row = self._row(task_id)
            scope = self._task_scope(row)
            source = self._source(row)
            self._stats[task_id] = {"received": row["stored_bytes"] if row["kind"] == "http" else 0, "segments_done": 0,
                                   "processed_seconds": 0, "speed": 0, "tick": time.monotonic(), "last_bytes": row["stored_bytes"]}
            if row["platform"]:
                await self._platform(row, scope, source)
            elif row["kind"] == "hls":
                await self._hls(row, scope, source)
            else:
                await self._http(row, scope, source)
        except asyncio.CancelledError:
            row = self._row(task_id)
            fallback = ("stopped", "POST 任务已中断，请手动重新发送") if row["method"] == "POST" else ("interrupted", "任务已中断")
            status, error = self._intents.get(task_id, fallback)
            self._set(task_id, status=status, error=error)
        except PrivateTaskLocked as exc:
            self._private_authorizers.pop(task_id, None)
            self._set(task_id, status="interrupted", error=str(exc))
        except Paused as exc:
            row = self._row(task_id)
            self._set(task_id, status="stopped" if "账号" in str(exc) or row["method"] == "POST" else "interrupted", error=str(exc))
        except TransientError as exc:
            row = self._row(task_id)
            attempt = self._retries.get(task_id, 0) + 1
            if row["method"] == "POST" or attempt > len(RETRY_DELAYS):
                self._retries.pop(task_id, None)
                self._set(task_id, status="failed", error=f"{exc}（已自动重试 {attempt - 1} 次）" if attempt > 1 else str(exc))
            else:
                delay = RETRY_DELAYS[attempt - 1]
                self._retries[task_id], self._retry_at[task_id] = attempt, time.monotonic() + delay
                self._set(task_id, status="interrupted", error=f"{exc}；{delay} 秒后自动重试（第 {attempt}/{len(RETRY_DELAYS)} 次）")
        except (DownloadError, QuotaExceededError, WorkBusyError) as exc:
            self._set(task_id, status="failed", error=str(exc) if isinstance(exc, DownloadError) else "空间配额不足或传输繁忙，请调整后重试")
        except Exception:
            # 外部异常可能含 URL、签名或响应内容，不能直接返回或写日志。
            self._set(task_id, status="failed", error="下载或保存失败，请检查来源参数、存储通道与可用空间后重试")
        finally:
            stats = self._stats.pop(task_id, None)
            if stats:
                self._set(task_id, **{key: stats[key] for key in ("received", "segments_done", "processed_seconds")})
            row = self._row(task_id)
            self._set(task_id, elapsed_seconds=row["elapsed_seconds"] + time.monotonic() - started)
            row = self._row(task_id)
            if (row["kind"] == "hls" or row["platform"]) and row["status"] != "completed":
                await self._discard(row)
                self._set(task_id, stored_bytes=0)
            if row["status"] != "completed":
                self._set(task_id, phase=None)
            else:
                self._retries.pop(task_id, None)
            if row["status"] != "interrupted":
                self._retry_at.pop(task_id, None)
            self._intents.pop(task_id, None)
            self._wake.set()

    def _task_scope(self, row):
        if row["key"].startswith(PRIVATE_PREFIX):
            authorize = self._private_authorizers.get(row["id"])
            if authorize is None:
                raise PrivateTaskLocked("私密空间已锁定，请解锁后继续下载")
            self.scope(row["user_id"])
            authorize()
            return Scope(row["bucket_id"], PRIVATE_PREFIX, private_access=True, authorize=authorize)
        return self.scope(row["user_id"])

    def _reserve_target(self, row, scope, upload_id=None):
        key = self.objects._upload(scope, upload_id)["key"] if upload_id else self._row(row["id"])["key"]
        with self.metadata.transaction() as db:
            if db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key)).fetchone():
                reserved = {r[0] for r in db.execute("SELECT key FROM offline_tasks WHERE bucket_id=? AND id!=? AND status!='completed'", (scope.bucket_id, row["id"]))}
                key = self.objects._free_name(db, scope.bucket_id, key, reserved)
                self.objects._check_scope(scope, key, write=True)
                db.execute("UPDATE offline_tasks SET key=? WHERE id=?", (key, row["id"]))
                if upload_id:
                    db.execute("UPDATE uploads SET key=? WHERE upload_id=?", (key, upload_id))
        return key

    async def _begin(self, row, scope, content_type, size=None):
        key = self._reserve_target(row, scope)
        room = self.objects._quota_room(scope.bucket_id, key)
        if size is not None and room is not None and size > room:
            raise QuotaExceededError("下载文件超过剩余配额")
        upload_id = await self.objects.create_multipart(scope, key, content_type)
        self._set(row["id"], upload_id=upload_id, stored_bytes=0)
        return upload_id

    async def _stage(self, row, scope, upload_id, stream, *, offset=0, count_input=True):
        number, pieces, buffered, stored = offset // PART_SIZE + 1, [], 0, offset
        async for piece in stream:
            self.check(row["user_id"], row["id"])
            if count_input:
                await self.throttle(len(piece))
                self._progress(row["id"], bytes_in=len(piece))
            pieces.append(piece)
            buffered += len(piece)
            if buffered >= PART_SIZE:
                # 来源块最多 64 KB，分段边界保留原块，不再复制一份整个 16 MB 的缓冲。
                joined = b"".join(pieces)
                body, rest = joined[:PART_SIZE], joined[PART_SIZE:]
                pieces, buffered = ([rest] if rest else []), len(rest)
                del joined
                await self.objects.upload_part(scope, upload_id, number, body, PART_SIZE)
                del body
                number, stored = number + 1, stored + PART_SIZE
                self._set(row["id"], stored_bytes=stored)
        if pieces or stored == 0:
            await self.objects.upload_part(scope, upload_id, number, pieces, buffered)
            stored += buffered
            self._set(row["id"], stored_bytes=stored)
        return stored

    async def _finish(self, row, scope, upload_id):
        self.check(row["user_id"], row["id"])
        parts = self.objects.list_parts(scope, upload_id)
        # 在提交前再次解决同名冲突；下载任务默认不覆盖用户刚上传的文件。
        # complete_multipart 目前内部没有真正挂起的 await，改名与提交才在事件循环里保持原子；
        # 若以后它需要等待 I/O，必须改成在同一事务里完成改名和提交，不能在持有事务时让出。
        with self.metadata.transaction() as db:
            upload = self.objects._upload(scope, upload_id)
            if upload["completed_at"] is None:
                self._reserve_target(row, scope, upload_id)
            info = await self.objects.complete_multipart(scope, upload_id, [(part.part_no, part.etag) for part in parts])
            self._set(row["id"], status="completed", phase=None, key=info.key, stored_bytes=info.size, size=info.size if row["kind"] == "http" else None, error=None)

    async def _http(self, row, scope, source):
        request = DownloadRequest.from_json(source["request"])
        state = source["state"]
        upload_id = row["upload_id"]
        upload = self.metadata.db.execute("SELECT * FROM uploads WHERE upload_id=?", (upload_id,)).fetchone() if upload_id else None
        if upload is None:
            upload_id, state = None, {}
        if upload and (upload["completed_at"] is not None or state.get("eof")):
            await self._finish(row, scope, upload_id)
            return
        parts = self.objects.list_parts(scope, upload_id) if upload else []
        if upload:
            self._reserve_target(row, scope, upload_id)
        offset = sum(part.size for part in parts)
        resume = offset and request.method == "GET" and state.get("etag") and all(part.size == PART_SIZE for part in parts)
        if offset and not resume:
            await self._discard(row)
            upload_id, offset, state = None, 0, {}
        self._stats[row["id"]].update(received=offset, last_bytes=offset)
        extra = {"Range": f"bytes={offset}-", "If-Range": state["etag"]} if resume else {}
        async with self.http.open(request, extra_headers=extra, identity=True) as response:
            if response.status in RETRY_STATUS:
                # 来源临时故障不能当作文件变化而清理断点。
                raise status_error(response.status, f"来源暂时不可用（HTTP {response.status}），可以稍后继续")
            if resume:
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("content-range", ""))
                unchanged = response.headers.get("etag") == state["etag"] and response.url == state.get("url")
                if response.status == 416 and unchanged and response.headers.get("content-range") == f"bytes */{offset}" and state.get("size") == offset:
                    state["eof"] = True
                    source["state"] = state
                    self._save_source(row["id"], source)
                    await self._finish(row, scope, upload_id)
                    return
                if response.status != 206 or not match or int(match[1]) != offset or int(match[2]) + 1 != int(match[3]) or int(match[3]) != state.get("size") or not unchanged or response.size != int(match[2]) - offset + 1:
                    await self._discard(row)
                    source["state"] = {}
                    self._save_source(row["id"], source)
                    self._set(row["id"], stored_bytes=0, received=0)
                    self._stats[row["id"]].update(received=0, last_bytes=0, speed=0)
                    raise DownloadError("来源文件已变化或不支持可靠续传，旧断点已清理，请重新下载")
                size = int(match[3])
            else:
                if response.status != 200:
                    raise status_error(response.status, f"来源下载失败（HTTP {response.status}），请检查链接和认证参数")
                size = response.size
                etag = response.headers.get("etag", "")
                state = {"etag": etag if re.fullmatch(r'"[\x21\x23-\x7e]{0,4096}"', etag) and size is not None else None,
                         "url": response.url, "size": size, "eof": False}
            self._set(row["id"], size=size)
            source["state"] = state
            self._save_source(row["id"], source)
            if not upload_id:
                upload_id = await self._begin(row, scope, response.headers.get("content-type", source.get("content_type")), size=size)
            stored = await self._stage(row, scope, upload_id, response.stream(), offset=offset)
            if size is not None and stored != size:
                raise DownloadError("下载文件的实际长度与来源声明不一致，请重新下载")
            state["eof"] = True
            self._save_source(row["id"], source)
        await self._finish(row, scope, upload_id)

    @staticmethod
    def _fresh(platform, entry, resolved_at):
        if not entry or not resolved_at:
            return False
        deadline = resolved_at + RESOLVED_TTL[platform]
        for track in entry["tracks"]:
            expire = parse_qs(urlsplit(track["url"]).query).get("expire", [""])[0]
            if expire.isdigit():
                deadline = min(deadline, int(expire) - 600)
        return time.time() < deadline

    async def _resolve_entry(self, row, source):
        self._set(row["id"], phase="resolving")
        self.platforms.client = self.http
        entries = await self.platforms.resolve(source["platform_source"], lambda: self.check(row["user_id"], row["id"]))
        selection = source["platform_source"]["selection"]
        entry = next((item for item in entries if item["selection"] == selection), None)
        if entry is None:
            raise DownloadError("此前选择的媒体或清晰度已不可用，请更新下载参数")
        if entry.get("too_large"):
            raise DownloadError("媒体需要的临时缓存超过当前资源上限，请选择其他格式或调整资源设置")
        # 保存新地址，网络重试或稍后继续时不必再次解析。
        source["platform_source"].update(entry=entry, resolved_at=time.time())
        self._save_source(row["id"], source)
        return entry

    async def _platform(self, row, scope, source):
        # 平台任务不拼接旧分片；解析结果在有效期内直接复用，地址失效（401/403/404/410）时重新解析一次。
        await self._discard(row)
        self._set(row["id"], received=0, stored_bytes=0, segments_done=0, processed_seconds=0)
        self._stats[row["id"]].update(received=0, last_bytes=0, speed=0)
        cached = source["platform_source"].get("entry")
        reuse = self._fresh(row["platform"], cached, source["platform_source"].get("resolved_at"))
        entry = cached if reuse else await self._resolve_entry(row, source)
        try:
            await self._fetch_entry(row, scope, entry)
        except ExpiredMedia:
            direct_youtube = row["platform"] == "youtube" and any(track.get("protocol") != "hls" for track in entry["tracks"])
            if not reuse and not direct_youtube:
                raise
            await self._discard(self._row(row["id"]))
            self._stats[row["id"]].update(received=0, last_bytes=0, speed=0)
            if direct_youtube:
                # 登录后的直连格式可能需要额外的播放证明。重新解析时同清晰度优先选 HLS。
                source["platform_source"]["prefer_hls"] = True
            await self._fetch_entry(row, scope, await self._resolve_entry(row, source))

    async def _fetch_entry(self, row, scope, entry):
        self._set(row["id"], phase="downloading", size=entry["size"], duration=entry.get("duration"), received=0, stored_bytes=0)
        config = self.resources.effective()
        if len(entry["tracks"]) == 1 and entry["tracks"][0].get("protocol") == "hls":
            request = media_request(row["platform"], entry["tracks"][0])
            url_check = lambda url: allowed_url(row["platform"], url)
            playlist = await load_playlist(self.http, request, url_check=url_check)
            self._set(row["id"], segments_total=len(playlist.segments), size=None)
            upload_id = await self._begin(row, scope, entry["content_type"])
            stream = remux(self.http, request, playlist, self.resources.ffmpeg,
                cache_root=self.cache_root, task_id=row["id"], limit=config["platform_max_mib"] * MIB,
                reserve=config["reserve_mib"] * MIB, media_type=entry["media_type"], url_check=url_check,
                check=lambda: self.check(row["user_id"], row["id"]), progress=lambda **values: self._progress(row["id"], **values),
                throttle=self.throttle, phase=lambda phase: self._set(row["id"], phase=phase))
            try:
                await self._stage(row, scope, upload_id, stream, count_input=False)
            finally:
                await stream.aclose()
            await self._finish(row, scope, upload_id)
            return
        if len(entry["tracks"]) == 1:
            def sized(size):
                self._set(row["id"], size=size)
            upload_id = await self._begin(row, scope, entry["content_type"], size=entry["size"])
            stream = track_stream(self.http, row["platform"], entry["tracks"][0], on_size=sized)
            try:
                await self._stage(row, scope, upload_id, stream)
            finally:
                await stream.aclose()
            await self._finish(row, scope, upload_id)
            return
        upload_id = await self._begin(row, scope, "video/mp4", size=entry["size"])
        stream = merge_tracks(self.http, row["platform"], entry, self.resources.ffmpeg, self.cache_root,
            row["id"], config["platform_max_mib"] * MIB, config["reserve_mib"] * MIB,
            check=lambda: self.check(row["user_id"], row["id"]), progress=lambda **values: self._progress(row["id"], **values),
            throttle=self.throttle, phase=lambda phase: self._set(row["id"], phase=phase))
        try:
            # 合并后的成品直接流入加密分片，不占用音视频输入轨的临时缓存预算。
            await self._stage(row, scope, upload_id, stream, count_input=False)
        finally:
            await stream.aclose()
        await self._finish(row, scope, upload_id)

    async def _hls(self, row, scope, source):
        # 封装器的状态无法从中间 MP4 恢复，任何中断都必须从头封装。
        await self._discard(row)
        self._set(row["id"], stored_bytes=0, received=0, segments_done=0, processed_seconds=0, size=None)
        request = DownloadRequest.from_json(source["request"])
        playlist = await load_playlist(self.http, request)
        if playlist.variants:
            raise DownloadError("请选择一个具体清晰度后下载")
        audio = None
        if source.get("hls_audio"):
            audio_request = DownloadRequest.from_json(source["hls_audio"])
            audio = (audio_request, await load_playlist(self.http, audio_request))
        self._set(row["id"], phase="downloading", segments_total=len(playlist.segments) + (len(audio[1].segments) if audio else 0), duration=playlist.duration)
        upload_id = await self._begin(row, scope, "video/mp4")
        stream = remux(self.http, request, playlist, self.resources.ffmpeg,
            cache_root=self.cache_root, task_id=row["id"], reserve=self.resources.effective()["reserve_mib"] * MIB,
            limit=self.objects._quota_room(scope.bucket_id, row["key"]), audio=audio,
            check=lambda: self.check(row["user_id"], row["id"]), progress=lambda **values: self._progress(row["id"], **values), throttle=self.throttle,
            phase=lambda phase: self._set(row["id"], phase=phase))
        try:
            await self._stage(row, scope, upload_id, stream, count_input=False)
        finally:
            await stream.aclose()
        await self._finish(row, scope, upload_id)
