"""持久下载队列。后台授权绑定账号，绝不保存网页会话或明文来源凭据。"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import re
import time
import unicodedata
from collections.abc import Callable
from dataclasses import replace
from email.message import Message
from urllib.parse import parse_qs, unquote, urlsplit, urlunsplit

from cryptography.exceptions import InvalidTag

from ..api import normalize_user_path
from ..crypto import derive_subkey, open_sealed, seal
from ..errors import IntegrityError, NotFoundError, NotReadyError, QuotaExceededError
from ..objects import PRIVATE_PREFIX, PRIVATE_TRASH_PREFIX, ObjectService, Scope
from ..work import WorkBusyError
from .hls import load_playlist, remux
from .http import RETRY_STATUS, DownloadError, SafeHttpClient, TransientError, status_error
from .mp4 import FRAGMENT_PROBE, Defragmenter, is_fragmented
from .request import DownloadRequest, checked_url, command_text, filename, parse_requests, url_filename
from .platforms import MIB, ExpiredMedia, PlatformResolver, allowed_url, clear_cache, media_request, merge_tracks, prepare, site_link, track_stream


PART_SIZE = 16 * 1024 * 1024
log = logging.getLogger(__name__)
# 任务附带的缩略图（封面）：网页在创建任务后上传已缩放好的三种规格，暂存为系统区加密对象（计入配额，不写进数据库），
# 文件下载完成后转为这个文件的缩略图并删除暂存；图片地址形式的封面记在加密的来源参数里，完成时由服务器读取并缩放。
COVER_PREFIX = ".tgdrive/offline-covers/"
# 每个账号记住最近一次的保存位置（普通与私密分别记录），新建任务时默认使用；私密位置只在解锁后返回。
DESTINATION_KEY = "offline.destination.{}"
# 单次提交、队列容量与实际下载并发分别限制。
MAX_CREATE_ITEMS = 1000
MAX_PENDING_TASKS = 20_000
ACTIVE = ("queued", "running", "interrupted")
RETRY_DELAYS = (10, 30, 90)
# mimetypes 对这几种常见类型给出的扩展名不符合习惯（如 .jpe），这里固定。
KNOWN_EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
                    "video/mp4": ".mp4", "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "application/pdf": ".pdf",
                    "application/zip": ".zip", "text/plain": ".txt"}
# 解析结果的复用期限；YouTube 地址自带 expire 参数时以它为准。
RESOLVED_TTL = {"x": 24 * 3600, "youtube": 3 * 3600}
PUBLIC_FIELDS = ("id", "key", "source_host", "method", "kind", "platform", "phase", "status", "size", "received", "stored_bytes", "segments_done", "segments_total", "duration", "processed_seconds", "elapsed_seconds", "error", "created_at", "updated_at")
# 任务仍跟踪成品的实际位置，以便回收站还原（含冲突改名）后重新关联；展示和重新下载使用原路径。
TASK_TRASH_PREFIXES = ((ObjectService.TRASH_PREFIX, ""), (PRIVATE_TRASH_PREFIX, PRIVATE_PREFIX))
TASK_PATH_SQL = "CASE " + " ".join(
    f"WHEN substr(key,1,{len(prefix)})='{prefix}' THEN '{original}' || "
    f"substr(key,{len(prefix) + 1}+instr(substr(key,{len(prefix) + 1}),'/'))"
    for prefix, original in TASK_TRASH_PREFIXES) + " ELSE key END"


def task_path(key: str) -> str:
    for prefix, original in TASK_TRASH_PREFIXES:
        if key.startswith(prefix):
            return original + key[len(prefix):].partition("/")[2]
    return key



async def _peek(stream, size: int):
    """读出流的开头至少 size 字节（不足则到结束），返回 (开头, 包含开头的完整流)。"""
    iterator, head = stream.__aiter__(), bytearray()
    while len(head) < size:
        try:
            head += await iterator.__anext__()
        except StopAsyncIteration:
            break
    async def whole():
        if head:
            yield bytes(head)
        async for piece in iterator:
            yield piece
    return bytes(head), whole()

class Paused(NotReadyError):
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
        self._covers: set[asyncio.Task] = set()
        self._next_byte = 0.0
        self._pressure_at, self._pressure = 0.0, None
        self._checked: dict[int, float] = {}
        self._limit_at, self._limit = 0.0, 0
        # 自动重试状态只在进程内保存；重启后“等待恢复”的任务本来就会继续。
        self._retries: dict[int, int] = {}
        self._retry_at: dict[int, float] = {}
        self.platforms = PlatformResolver(self.http, resources)
        self.cache_root = resources.data_dir / "offline-cache"

    def _key(self, label="offline-request"):
        return derive_subkey(self.keystore.require_kek(), label)

    def _source(self, row, key=None):
        return json.loads(open_sealed(key or self._key(), row["request_enc"], f"offline:{row['id']}"))

    def _source_link(self, row, key) -> dict | None:
        """列表展示用的来源地址：平台任务给出规范链接；直链去掉查询串（可能带签名），完整参数只经 source 接口读取。"""
        try:
            value = self._source(row, key)
            url = value["platform_source"]["url"] if row["platform"] else value["request"]["url"]
            parts = urlsplit(url)
        except (ValueError, InvalidTag, KeyError, TypeError, IntegrityError):  # 来源记录损坏时列表照常显示，只是不带来源链接
            return None
        if row["platform"]:
            return {"url": url, "has_query": False}
        return {"url": urlunsplit((parts.scheme, parts.netloc, parts.path, "", "")), "has_query": bool(parts.query)}

    def _private_view(self, row, private_scope: Scope | None) -> bool:
        """私密任务的文件名、来源和参数只在当前会话已解锁私密空间时可见。"""
        if not task_path(row["key"]).startswith(PRIVATE_PREFIX):
            return True
        if (private_scope is None or not private_scope.private_access or private_scope.bucket_id != row["bucket_id"]):
            return False
        if private_scope.authorize is not None:
            private_scope.authorize()
        return True

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

    async def parse(self, user_id: int, text: str, *, download_type="auto", cookies="", max_urls: int = MAX_CREATE_ITEMS, multiple_platforms: bool = False) -> dict:
        """网页与密钥接口每次最多解析一个提交批次；助手另按工具配置指定上限（0 为不限）。"""
        if download_type not in ("auto", "http", "hls", "x", "youtube"):
            raise ValueError("下载类型不正确")
        if not isinstance(cookies, str) or len(cookies.encode()) > 32768:
            raise ValueError("Cookie 文本不能超过 32 KiB")
        self.scope(user_id)
        requests = parse_requests(text, max_urls=max_urls)
        sites = [site_link(request.url) if download_type in ("auto", "x", "youtube") else None for request in requests]
        if not multiple_platforms and sum(site is not None for site in sites) > 1:
            raise ValueError("每次解析一个 X 帖子或 YouTube 视频，媒体可在解析后逐项选择")
        candidate_count = 0
        async def inspect(request, site):
            nonlocal candidate_count
            async with self._parse_slots:
                if download_type in ("x", "youtube") and (not site or site[0] != download_type):
                    raise ValueError("链接与选择的平台不匹配")
                if site:
                    group = await self._parse_platform(user_id, request, site, cookies)
                else:
                    if cookies:
                        raise ValueError("额外的 Cookie 导入只用于平台链接；文件直链请在 curl 命令中携带 Cookie")
                    group = await self._parse_request(user_id, request, download_type, max_urls)
                candidate_count += len(group)
                if max_urls and candidate_count > max_urls:
                    raise ValueError(f"解析结果超过 {max_urls} 个文件，请分批提交")
                return group
        tasks = [asyncio.create_task(inspect(request, site)) for request, site in zip(requests, sites)]
        try:
            groups = await asyncio.gather(*tasks)
        except BaseException:
            # gather 首次失败不会自动取消其余请求；大批解析必须等待清理完毕再退出。
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        candidates = [{**candidate, "group": f"{index}:{candidate.get('group', '0')}"} for index, group in enumerate(groups) for candidate in group]
        if max_urls and len(candidates) > max_urls:
            raise ValueError(f"解析结果超过 {max_urls} 个文件，请分批提交")
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

    async def _parse_request(self, user_id, request, download_type, max_candidates=MAX_CREATE_ITEMS):
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
            if max_candidates and len(candidates) >= max_candidates:
                raise ValueError(f"解析结果超过 {max_candidates} 个文件，请分批提交")
            ticket = {"user_id": user_id, "expires": time.time() + 1200, "request": choice.json(), "kind": "hls" if hls else "http", "size": None if hls else size, "content_type": "video/mp4" if hls else content_type, "hls_audio": audio}
            import base64
            encoded = base64.urlsafe_b64encode(seal(self._key("offline-ticket"), json.dumps(ticket, ensure_ascii=False).encode(), "offline-ticket")).decode()
            candidates.append({"ticket": encoded, "name": name, "source_host": urlsplit(choice.url).hostname, "method": choice.method,
                "kind": ticket["kind"], "content_type": ticket["content_type"], "size": ticket["size"], "variant": label, "warnings": choice.warnings,
                "header_names": [key for key, _ in choice.headers], "body_bytes": len((choice.body or "").encode())})
        self.scope(user_id)
        return candidates

    def direct_ticket(self, user_id: int, url: str, *, referer: str | None = None, name: str | None = None) -> str:
        """为普通 GET 直链签发任务票据，不预先访问来源（文件助手批量保存相册图片时使用，信息在下载时再校验）。"""
        headers = []
        if referer:
            headers.append(("Referer", checked_url(referer)))
        request = DownloadRequest(checked_url(url), headers=headers, name=filename(name) if name else None)
        return self._encode_ticket({"user_id": user_id, "expires": time.time() + 1200, "request": request.json(), "kind": "http",
                                    "size": None, "content_type": None})

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
               key_scope: Scope | None = None) -> list[dict]:
        regular_scope = self.scope(user_id)
        if key_scope is not None:
            # 访问密钥创建的任务只能写入密钥的授权前缀；运行时仍按账号身份校验。
            if key_scope.bucket_id != regular_scope.bucket_id:
                raise PermissionError("离线下载只能保存到密钥所属用户的存储桶")
            regular_scope = replace(regular_scope, prefix=key_scope.prefix, perms=key_scope.perms)
        if not isinstance(items, list) or not 1 <= len(items) <= MAX_CREATE_ITEMS:
            raise ValueError(f"一次请选择 1–{MAX_CREATE_ITEMS} 个文件")
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
            decoded.append((value, key, self._cover_spec(item.get("cover"))))
        now, ids = time.time(), []
        with self.metadata.transaction() as db:
            pending = db.execute("SELECT COUNT(*) FROM offline_tasks WHERE user_id=? AND status!='completed'", (user_id,)).fetchone()[0]
            if pending + len(decoded) > MAX_PENDING_TASKS:
                raise ValueError(f"未完成任务最多 {MAX_PENDING_TASKS} 个，请等待下载完成或清理不再需要的任务")
            reserved = {row[0] for row in db.execute("SELECT key FROM offline_tasks WHERE bucket_id=? AND status!='completed'", (scope.bucket_id,))}
            for value, key, cover in decoded:
                if key in reserved or db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key)).fetchone():
                    key = self.objects._free_name(db, scope.bucket_id, key, reserved)
                self.objects._check_scope(scope, key, write=True)
                request = DownloadRequest.from_json(value["request"])
                platform = value.get("platform")
                source_host = urlsplit(value["platform_source"]["url"]).hostname if platform else urlsplit(request.url).hostname
                cursor = db.execute("INSERT INTO offline_tasks(user_id,bucket_id,key,source_host,method,kind,platform,request_enc,status,size,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?)",
                    (user_id, scope.bucket_id, key, source_host, request.method, value["kind"], platform, b"", value["size"], now, now))
                task_id = cursor.lastrowid
                self._save_source(task_id, {"request": request.json(), "state": {}, "content_type": value["content_type"], "platform_source": value.get("platform_source"), "hls_audio": value.get("hls_audio"),
                                            **({"cover": cover} if cover else {})})
                reserved.add(key)
                ids.append(task_id)
            self._remember_destination(db, user_id, prefix)
        self._wake.set()
        return [self.public(self._row(task_id), reveal_private=private_destination) for task_id in ids]

    @staticmethod
    def _cover_spec(cover):
        """创建时只接受图片地址形式的封面（文件助手、访问密钥 API）；网页上传的图片在创建后经 set_cover 提交。"""
        if cover is None or cover == "":
            return None
        url = cover.get("url") if isinstance(cover, dict) else cover
        if not isinstance(url, str) or not re.match(r"https?://", url.strip(), re.IGNORECASE) or len(url) > 4096:
            raise ValueError("缩略图必须是 http:// 或 https:// 开头的图片地址")
        return {"url": url.strip()}

    def _remember_destination(self, db, user_id, prefix):
        key = DESTINATION_KEY.format(user_id)
        row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        try:
            value = json.loads(row[0]) if row else {}
        except ValueError:
            value = {}
        area = "private" if prefix.startswith(PRIVATE_PREFIX) else "normal"
        value.update(area=area, **{area: prefix})
        db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (key, json.dumps(value, ensure_ascii=False)))

    def last_destination(self, user_id, *, private_scope: Scope | None = None) -> dict:
        """最近一次创建离线任务时选择的位置。私密路径只在当前会话已解锁时返回，未解锁只告诉网页上次选的是私密空间。"""
        self.scope(user_id)
        row = self.metadata.db.execute("SELECT value FROM settings WHERE key=?", (DESTINATION_KEY.format(user_id),)).fetchone()
        try:
            value = json.loads(row[0]) if row else {}
        except ValueError:
            value = {}
        reveal = bool(private_scope and private_scope.private_access)
        if reveal and private_scope.authorize is not None:
            private_scope.authorize()
        return {"area": "private" if value.get("area") == "private" else "normal", "normal": value.get("normal") or "",
                "private": (value.get("private") or PRIVATE_PREFIX) if reveal else None}

    async def set_cover(self, user_id, task_id, images, *, private_scope: Scope | None = None) -> dict:
        """网页在创建任务后提交封面（浏览器缩放好的 thumb／grid／poster）。任务已完成时直接设为文件的缩略图，
        否则暂存到系统区，下载完成后再使用。私密任务需当前会话已解锁，与查看任务名称的要求一致。"""
        self.scope(user_id)
        row = self._row(task_id, user_id)
        if not self._private_view(row, private_scope):
            raise ValueError("请先解锁私密空间，再设置缩略图")
        images = self._cover_images(images)
        if row["status"] == "completed":
            await self._apply_images(row, images)
            return {"applied": True}
        scope, prefix = Scope(row["bucket_id"]), f"{COVER_PREFIX}{task_id}/"
        await self.objects.delete_prefix(scope, prefix)
        for variant, data in images.items():
            await self.objects.put_object(scope, prefix + variant, data, len(data), self.objects._thumbnail_mime(data), small=True)
        # 暂存期间下载可能已经完成：完成时没看到暂存的封面，这里补上。
        row = self._row(task_id, user_id)
        if row["status"] == "completed":
            await self._apply_cover(task_id)
            return {"applied": True}
        return {"applied": False}

    def _cover_images(self, images):
        import base64
        from ..thumbnails import image_mime
        if not isinstance(images, dict) or "thumb" not in images or not set(images) <= set(ObjectService.STORED_THUMBNAILS):
            raise ValueError("缩略图至少需要列表小图（thumb）")
        decoded = {}
        for variant, value in images.items():
            try:
                data = base64.b64decode(value, validate=True) if isinstance(value, str) else b""
            except ValueError:
                data = b""
            if not data or len(data) > ObjectService.THUMBNAIL_LIMITS[variant] or image_mime(data) not in ("image/jpeg", "image/webp", "image/png"):
                raise ValueError("缩略图图片格式或大小不正确")
            decoded[variant] = data
        return decoded

    async def _apply_images(self, row, images):
        service = self.objects.thumbnail_service
        if service is None:
            raise ValueError("缩略图服务不可用")
        try:
            await service.apply_custom(self._task_scope(row), row["key"], images)
        except NotFoundError:
            raise ValueError("下载的文件已移动或删除，请在文件菜单中设置缩略图") from None

    def _schedule_cover(self, task_id):
        task = asyncio.create_task(self._apply_cover(task_id))
        self._covers.add(task)
        task.add_done_callback(self._covers.discard)

    async def _apply_cover(self, task_id):
        """下载完成后使用任务附带的封面：先用网页上传的暂存图片，没有时读取图片地址并在服务器缩放。
        封面只是附加信息，失败不影响任务结果（自动生成的缩略图照常保留）。每个封面只使用一次。"""
        try:
            row = self._row(task_id)
        except NotFoundError:
            return
        prefix, bucket = f"{COVER_PREFIX}{task_id}/", Scope(row["bucket_id"])
        try:
            images = {}
            keys = [item["key"] for item in self.metadata.db.execute(
                "SELECT key FROM objects WHERE bucket_id=? AND key>=? AND key<?", (row["bucket_id"], prefix, prefix + ObjectService._PREFIX_END))]
            for key in keys:
                _, stream = await self.objects.get_object(bucket, key)
                images[key[len(prefix):]] = b"".join([piece async for piece in stream])
            source = self._source(row)
            url = (source.get("cover") or {}).get("url")
            if "thumb" not in images and url and self.objects.thumbnail_service is not None:
                data, _ = await self.objects.thumbnail_service.fetch_image(url)
                images = await self.objects.thumbnail_service.render_image(data) or {}
            if "thumb" in images and self._row(task_id)["status"] == "completed":
                await self._apply_images(self._row(task_id), images)
        except Exception as exc:  # 封面失败只记录类型，不记录地址或文件名
            log.info("离线任务封面未能使用：task=%s error=%s", task_id, type(exc).__name__)
        finally:
            try:
                await self.objects.delete_prefix(bucket, prefix)
                current = self._row(task_id)
                source = self._source(current)
                if source.pop("cover", None) is not None:
                    self._save_source(task_id, source)
            except Exception:
                pass

    def public(self, row, *, reveal_private=False):
        result = {key: row[key] for key in PUBLIC_FIELDS}
        result["key"] = task_path(row["key"])
        result["trashed"] = any(row["key"].startswith(prefix) for prefix, _ in TASK_TRASH_PREFIXES)
        result["private"] = result["key"].startswith(PRIVATE_PREFIX)
        if result["private"] and not reveal_private:
            result["key"] = "私密空间下载"
        stats = self._stats.get(row["id"], {})
        result.update({key: value for key, value in stats.items() if key in ("received", "segments_done", "processed_seconds")})
        speed = stats.get("speed", 0) if time.monotonic() - stats.get("tick", 0) < 3 else 0
        result["speed"] = speed if row["status"] == "running" and row["phase"] not in ("merging", "saving", "resolving") else 0
        result["eta_seconds"] = max(0, (row["size"] - result["received"]) / speed) if result["speed"] and row["size"] and row["kind"] == "http" else None
        return result

    def list(self, user_id, *, cursor=0, status="", query="", limit=50, private_scope: Scope | None = None, ids=None,
             area: str | None = None, max_limit: int = 100):
        """任务列表（键集分页）。ids 用于托盘跟踪：只返回这些编号中属于该用户的任务（最多 100 个），不分页。
        area 为 normal／private 时在查询中只取普通或私密任务（文件助手按对话类型使用），分页与总数都按该范围计算。"""
        self.scope(user_id)
        reveal_private = bool(private_scope and private_scope.private_access)
        if reveal_private and private_scope.authorize is not None:
            private_scope.authorize()
        if status not in ("", "active", "running", "stopped", "completed", "failed") or cursor < 0:
            raise ValueError("任务筛选或分页参数不正确")
        # 网页每页最多 100 个；文件助手按管理员设置的上限传入 max_limit。
        limit = max(1, min(limit, max(1, min(max_limit, 2000))))
        where, args = "user_id=?", [user_id]
        if ids is not None:
            if not isinstance(ids, list) or not 1 <= len(ids) <= 100 or not all(type(value) is int for value in ids):
                raise ValueError("ids 最多 100 个任务编号")
            where += f" AND id IN ({','.join('?' * len(ids))})"
            args.extend(ids)
            cursor, limit = 0, len(ids)
        if area is not None:
            if area not in ("normal", "private"):
                raise ValueError("任务范围不正确")
            where += f" AND substr(({TASK_PATH_SQL}),1,?){'=' if area == 'private' else '<>'}?"
            args.extend((len(PRIVATE_PREFIX), PRIVATE_PREFIX))
        if status == "active":
            where += " AND status IN ('queued','running','interrupted')"
        elif status:
            where += " AND status=?"
            args.append(status)
        query = unicodedata.normalize("NFC", query.strip())
        if len(query) > 200:
            raise ValueError("搜索内容不能超过 200 个字符")
        if query:
            # 锁定时按可见的占位名称搜索，不能通过命中数探测私密文件名或目录。
            visible_key = TASK_PATH_SQL if reveal_private else f"CASE WHEN substr(({TASK_PATH_SQL}),1,?)=? THEN '私密空间下载' ELSE ({TASK_PATH_SQL}) END"
            where += f" AND instr(lower(({visible_key}) || ' ' || source_host),lower(?))>0"
            if not reveal_private:
                args.extend((len(PRIVATE_PREFIX), PRIVATE_PREFIX))
            args.append(query)
        total = self.metadata.db.execute(f"SELECT COUNT(*) FROM offline_tasks WHERE {where}", args).fetchone()[0]
        if cursor:
            where += " AND id<?"
            args.append(cursor)
        rows = self.metadata.db.execute(f"SELECT {','.join(PUBLIC_FIELDS)},bucket_id,request_enc FROM offline_tasks WHERE {where} ORDER BY id DESC LIMIT ?", (*args, limit + 1)).fetchall()
        effective = self.resources.effective()
        key = self._key()
        tasks = []
        for row in rows[:limit]:
            task = self.public(row, reveal_private=reveal_private)
            visible = reveal_private or not task["private"]
            task["source"] = self._source_link(row, key) if visible else None
            task["file"] = None
            tasks.append(task)
        self._attach_files(user_id, [(task, row) for task, row in zip(tasks, rows) if task["status"] == "completed" and not task["trashed"] and (reveal_private or not task["private"])])
        return {"tasks": tasks, "total": total,
                "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
                "capabilities": {"hls": effective["hls_enabled"] and effective["hls_available"],
                    "x": effective["x_enabled"] and effective["x_available"],
                    "youtube": effective["youtube_enabled"] and effective["youtube_available"],
                    "concurrency": effective["concurrency"], "pressure": self.resources.pressure()}}

    def counts(self, user_id, *, area: str) -> dict[str, int]:
        """按状态统计普通或私密任务数（文件助手用来了解整体规模，不必翻页计数）。"""
        if area not in ("normal", "private"):
            raise ValueError("任务范围不正确")
        rows = self.metadata.db.execute(
            f"SELECT status, COUNT(*) AS n FROM offline_tasks WHERE user_id=? AND substr(({TASK_PATH_SQL}),1,?)"
            f"{'=' if area == 'private' else '<>'}? GROUP BY status", (user_id, len(PRIVATE_PREFIX), PRIVATE_PREFIX)).fetchall()
        return {row["status"]: row["n"] for row in rows}

    def _attach_files(self, user_id, pairs):
        """已完成任务对应的文件（仍在原位置时）与缩略图状态：每页两次查询，不逐项读取。"""
        if not pairs:
            return
        bucket = pairs[0][1]["bucket_id"]
        keys = list(dict.fromkeys(row["key"] for _, row in pairs))
        found = {}
        for start in range(0, len(keys), 200):
            chunk = keys[start:start + 200]
            for item in self.metadata.db.execute(f"SELECT key,size,etag,content_type,blob_uuid FROM objects WHERE bucket_id=? AND key IN ({','.join('?' * len(chunk))})", (bucket, *chunk)):
                found[item["key"]] = item
        versions = self.objects.thumbnail_versions([item["blob_uuid"] for item in found.values()])
        for task, row in pairs:
            item = found.get(row["key"])
            if item is None or row["bucket_id"] != bucket:
                continue
            states = versions.get(item["blob_uuid"] or "", {})
            task["file"] = {"key": item["key"], "size": item["size"], "etag": item["etag"], "content_type": item["content_type"],
                            **self.objects.thumbnail_fields(states, states)}

    def source(self, user_id: int, task_id: int, *, private_scope: Scope | None = None) -> dict:
        """「更新下载参数」回填：还原成可再次解析的链接或 curl 命令（含用户提交过的请求头与请求体，只返回给任务所有者）。"""
        self.scope(user_id)
        row = self._row(task_id, user_id)
        if not self._private_view(row, private_scope):
            raise ValueError("请先解锁私密空间后查看下载参数")
        value = self._source(row)
        request = DownloadRequest.from_json(value["request"])
        request.warnings = []
        platform = row["platform"]
        result = {"input": command_text(request),
                  "download_type": platform or row["kind"], "cookies": "",
                  "url": value["platform_source"]["url"] if platform else request.url}
        if platform:
            # 平台 Cookie 已解析为记录：还原成 cookies.txt，重新解析时得到同一组 Cookie；请求头里的 Cookie 仍在命令中。
            header_cookies = {item.strip().partition("=")[0] for key, header in request.headers if key.lower() == "cookie" for item in header.split(";") if item.strip()}
            lines = [f"{cookie['domain']}\t{'TRUE' if cookie['include_subdomains'] else 'FALSE'}\t{cookie['path']}\t{'TRUE' if cookie['secure'] else 'FALSE'}\t{cookie['expires'] or 0}\t{cookie['name']}\t{cookie['value']}"
                     for cookie in value["platform_source"].get("cookies") or [] if cookie["name"] not in header_cookies]
            result["cookies"] = "\n".join(lines)
        return result

    async def batch(self, user_id, action, ids, *, private_scope: Scope | None = None) -> dict:
        """多选操作：逐项走 control 的同一套校验；单项失败（如私密空间未解锁、POST 任务需单独确认）计入 skipped。"""
        if action not in ("stop", "resume", "delete"):
            raise ValueError("批量操作只支持停止、继续和删除")
        if not isinstance(ids, list) or not 1 <= len(ids) <= 100 or not all(type(value) is int and value > 0 for value in ids):
            raise ValueError("请选择 1–100 个任务")
        self.scope(user_id)
        done, skipped = 0, 0
        for task_id in dict.fromkeys(ids):
            try:
                row = self._row(task_id, user_id)
                if action == "resume" and (row["status"] not in ("stopped", "failed", "interrupted") or row["method"] == "POST"):
                    # 继续 POST 任务会重新发送请求体，必须逐个确认。
                    skipped += 1
                    continue
                if action == "stop" and row["status"] not in ACTIVE:
                    skipped += 1
                    continue
                await self.control(user_id, task_id, action, private_scope=private_scope)
                done += 1
            except NotFoundError:
                skipped += 1
            except (ValueError, PermissionError, Paused):
                skipped += 1
        return {"done": done, "skipped": skipped}

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

    async def control(self, user_id, task_id, action, *, item=None, private_scope: Scope | None = None):
        """停止、继续、重新下载与删除私密任务都不需要解锁：下载在服务端用系统密钥写入私密空间，与网页访问授权无关。
        只有「更新下载参数」会读取并改写原来的来源参数，需要当前会话已解锁；返回结果仍按解锁状态决定是否显示名称。"""
        if action not in ("stop", "resume", "restart", "delete", "update"):
            raise ValueError("下载任务操作不正确")
        self.scope(user_id)
        lock = self._controls.setdefault(task_id, asyncio.Lock())
        self._control_refs[task_id] = self._control_refs.get(task_id, 0) + 1
        try:
            async with lock:
                row = self._row(task_id, user_id)
                private_task = task_path(row["key"]).startswith(PRIVATE_PREFIX)
                reveal_private = self._private_view(row, private_scope) if private_task else False
                if private_task and action == "update" and not reveal_private:
                    raise ValueError("请先解锁私密空间，再更新下载参数")
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
                    await self.objects.delete_prefix(Scope(row["bucket_id"]), f"{COVER_PREFIX}{task_id}/")
                    with self.metadata.transaction() as db:
                        db.execute("DELETE FROM offline_tasks WHERE id=? AND user_id=?", (task_id, user_id))
                    return None
                if action in ("restart", "update"):
                    await self._discard(row)
                    self._set(task_id, key=task_path(row["key"]), received=0, stored_bytes=0, segments_done=0, processed_seconds=0, elapsed_seconds=0)
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

    async def stop_all(self, user_id):
        """停止账号下全部进行中的任务（托盘「全部取消」）：排队与中断的任务在一个事务里改为已停止，
        正在下载的逐个取消；任务记录与已下载的断点保留，之后仍可继续。停止不需要解锁私密空间。"""
        self.scope(user_id)
        now = time.time()
        with self.metadata.transaction() as db:
            # 先改排队任务，调度器不会在取消运行中任务的间隙再启动它们。
            queued = db.execute("UPDATE offline_tasks SET status='stopped',phase=NULL,error=NULL,updated_at=? "
                                "WHERE user_id=? AND status IN ('queued','interrupted')", (now, user_id)).rowcount
        running = [task_id for task_id, task in list(self._running.items())
                   if not task.done() and self._row(task_id)["user_id"] == user_id]
        for task_id in running:
            await self._cancel(task_id, "stopped", None)
        return {"stopped": queued + len(running)}

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
        except Paused as exc:
            row = self._row(task_id)
            self._set(task_id, status="stopped" if "账号" in str(exc) or row["method"] == "POST" else "interrupted", error=str(exc))
        except (TransientError, WorkBusyError) as exc:
            # 存储写入名额暂时被占满（批量下载、上传与缩略图同时写入）和网络抖动一样自动重试，不直接判为失败。
            row = self._row(task_id)
            attempt = self._retries.get(task_id, 0) + 1
            if row["method"] == "POST" or attempt > len(RETRY_DELAYS):
                self._retries.pop(task_id, None)
                self._set(task_id, status="failed", error=f"{exc}（已自动重试 {attempt - 1} 次）" if attempt > 1 else str(exc))
            else:
                delay = RETRY_DELAYS[attempt - 1]
                self._retries[task_id], self._retry_at[task_id] = attempt, time.monotonic() + delay
                self._set(task_id, status="interrupted", error=f"{exc}；{delay} 秒后自动重试（第 {attempt}/{len(RETRY_DELAYS)} 次）")
        except (DownloadError, QuotaExceededError) as exc:
            self._set(task_id, status="failed", error=str(exc) if isinstance(exc, DownloadError) else "存储空间不足，请清理文件或联系管理员扩容后重试")
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
            # 私密空间只是网页访问锁：后台下载与缩略图一样用系统密钥写入，不依赖网页解锁；
            # 每次提交前仍复核账号可用（禁用、删除账号或锁定系统时停止）。
            self.scope(row["user_id"])
            return Scope(row["bucket_id"], PRIVATE_PREFIX, private_access=True, authorize=lambda: self.scope(row["user_id"]))
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

    async def _stage_video(self, row, scope, upload_id, stream):
        """FFmpeg 管道输出的分片 MP4 边收边转成普通 MP4（见 mp4.Defragmenter），浏览器才能快速播放和跳转。

        moov 要等全部数据输出后才能生成，而磁盘不足以暂存整个视频：先在内存里留住开头约 16 MB 的音视频数据，
        其余从第 2 段起边收边传；结束时把 ftyp + moov + mdat 头和留住的数据合成第 1 段再上传
        （分段可以乱序上传，提交时按序号拼接）。
        """
        converter = Defragmenter()
        source = converter.payload(stream)
        try:
            head, held = [], 0
            async for piece in source:
                self.check(row["user_id"], row["id"])
                head.append(piece)
                held += len(piece)
                if held >= PART_SIZE:
                    break
            stored = await self._stage(row, scope, upload_id, source, offset=PART_SIZE, count_input=False) - PART_SIZE
        finally:
            await source.aclose()
        first = converter.header() + b"".join(head)
        del head
        await self.objects.upload_part(scope, upload_id, 1, first, len(first))
        self._set(row["id"], stored_bytes=stored + len(first))

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
        self._schedule_cover(row["id"])

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
            stream = response.stream()
            head, stream = await _peek(stream, FRAGMENT_PROBE) if not offset else (b"", stream)
            fragmented = is_fragmented(head)
            if not upload_id:
                content_type = response.headers.get("content-type", source.get("content_type"))
                if fragmented and not (content_type or "").startswith(("video/", "audio/")):
                    content_type = "video/mp4"
                upload_id = await self._begin(row, scope, content_type, size=size)
            if fragmented:
                # 分片 MP4（直播切片、部分网站与抓取脚本拿到的视频）：浏览器要逐个片段扫描才能开始播放和拖动，
                # 保存时转成普通 MP4（moov 在前）。转换结果长度与来源不同，不能续传，停止后从头下载。
                received = 0
                async def counted():
                    nonlocal received
                    async for piece in stream:
                        await self.throttle(len(piece))
                        self._progress(row["id"], bytes_in=len(piece))
                        received += len(piece)
                        yield piece
                await self._stage_video(row, scope, upload_id, counted())
                if size is not None and received != size:
                    raise DownloadError("下载文件的实际长度与来源声明不一致，请重新下载")
            else:
                stored = await self._stage(row, scope, upload_id, stream, offset=offset)
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
                media_type=entry["media_type"], url_check=url_check,
                check=lambda: self.check(row["user_id"], row["id"]), progress=lambda **values: self._progress(row["id"], **values),
                throttle=self.throttle, phase=lambda phase: self._set(row["id"], phase=phase))
            try:
                await self._stage_video(row, scope, upload_id, stream)
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
            await self._stage_video(row, scope, upload_id, stream)
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
            audio=audio,
            check=lambda: self.check(row["user_id"], row["id"]), progress=lambda **values: self._progress(row["id"], **values), throttle=self.throttle,
            phase=lambda phase: self._set(row["id"], phase=phase))
        try:
            await self._stage_video(row, scope, upload_id, stream)
        finally:
            await stream.aclose()
        await self._finish(row, scope, upload_id)
