"""媒体元数据服务：统一对网页提供「文件元数据、查找候选、读取候选、保存」，具体内容来自已启用的提供者。

- 文件自带的元数据由 ``tags.parse`` 按需读取文件头提取，按 Blob 记在 ``media_info``（副本共用）。
- 提供者在系统设置里逐个开关；秘密配置用 KEK 子密钥 ``media-provider-secret`` 加密保存，接口只回显是否已填写。
- 查找结果的 ``ref``（外部地址、编号等）只留在服务端，网页拿到的是绑定（存储桶、路径、版本）的短期令牌。
- 字段按文件独立保存，歌词、字幕和自定义封面保存为用户隐藏空间中的加密对象，不改写原文件。
- 内嵌字幕轨用 FFmpeg 经回环地址按范围读取原文件提取成 WebVTT；MKV 的字幕分散在整个文件里，需要读完整个文件，
  所以首次提取是可恢复的后台任务，结果持久保存为小资源。
"""

from __future__ import annotations

import asyncio
import base64
import collections
import dataclasses
import logging
import json
import os
import re
import secrets
import struct
import time
import tempfile
from pathlib import Path
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from ..crypto import derive_subkey, open_sealed, seal
from ..errors import NotFoundError, VersionConflict
from ..filekinds import kind_of
from ..library import book_type
from ..objects import ObjectInfo, Scope
from ..version import __version__
from . import query as media_query
from . import tags as media_tags
from . import text as media_text
from . import book_covers
from .providers import registry
from .records import ASSET_LIMIT, parsed_fields
from .providers.base import WANTS, Candidate, Fetched, MediaQuery, Provider, ProviderContext, ProviderError, score, similarity

CONFIG_KEY = "media.providers"
SECRET_PREFIX = "media.secret."
SECRET_CONTEXT = "media-provider-secret"
log = logging.getLogger(__name__)
USER_AGENT = f"Tessera/{__version__.split('+')[0]} (+https://github.com/yangshoulai/tgdrive)"
_LANGUAGE = re.compile(r"[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*")


class AssetExists(VersionConflict):
    """同名的歌词或字幕文件已存在，需要用户确认覆盖。"""


def _mime_ok(data: bytes) -> str | None:
    from ..thumbnails import image_mime
    return image_mime(data)


class _Http:
    """提供者出站请求：经离线下载的受控客户端（拒绝内网地址、遵循出站代理），并按提供者限速。"""

    TIMEOUT = 15

    def __init__(self, proxy):
        from ..offline.http import SafeHttpClient
        self.client = SafeHttpClient(proxy=proxy)
        self._last: dict[tuple[str, str], float] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    async def request(self, provider: Provider, method: str, url: str, headers: dict[str, str], body: bytes | None,
                      limit: int) -> tuple[int, dict[str, str], bytes]:
        from ..offline.http import DownloadError
        from ..offline.request import DownloadRequest
        host = (urlsplit(url).hostname or "").lower()
        if provider.interval and (provider.interval_hosts is None or host in provider.interval_hosts):
            key = (provider.id, host)
            async with self._locks.setdefault(key, asyncio.Lock()):
                wait = self._last.get(key, 0) + provider.interval - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                self._last[key] = time.monotonic()
        headers = {"User-Agent": USER_AGENT, **headers}
        request = DownloadRequest(url, method=method, headers=list(headers.items()))
        options = {"request_body": body} if body is not None else {}
        try:
            async with asyncio.timeout(self.TIMEOUT):
                async with self.client.open(request, **options) as response:
                    pieces, size = [], 0
                    async for piece in response.stream():
                        size += len(piece)
                        if size > limit:
                            raise ProviderError("接口返回的内容过大")
                        pieces.append(piece)
                    return response.status, dict(response.headers), b"".join(pieces)
        except TimeoutError:
            raise ProviderError(f"连接 {host} 超时") from None
        except (DownloadError, ValueError, OSError) as exc:
            raise ProviderError(f"无法连接 {host}：{exc}") from None


class FileAccess:
    """提供者（内置数据）与服务读取当前文件：每次读取前复核授权，读取按普通读取占名额。"""

    def __init__(self, service: "MediaService", scope: Scope, info: ObjectInfo, *, background: bool = False):
        self.service, self.scope, self.info, self.background = service, scope, info, background
        self.tags: media_tags.MediaTags | None = None

    async def read(self, start: int, end: int) -> bytes:
        if self.scope.authorize is not None:
            self.scope.authorize()
        if not self.info.blob_uuid or start >= end:
            return b""
        pieces = []
        stream = self.service.objects.engine.stream(self.info.blob_uuid, start, min(end, self.info.size), window=max(64 * 1024, end - start),
                                                    bucket_id=self.info.bucket_id, background=self.background)
        try:
            async for piece in stream:
                pieces.append(piece)
        finally:
            await stream.aclose()
        return b"".join(pieces)

    async def subtitle(self, index: int) -> str:
        assets = self.service.objects.file_metadata.assets(self.info.metadata_id, "subtitle")
        asset = next((item for item in assets if item["source"] == f"embedded:{index}"), None)
        if asset:
            return (await self.service.objects.file_metadata.read_asset(self.scope, self.info.key, asset["id"]))[0].decode("utf-8")
        text = self.service._subtitles.get((self.info.blob_uuid, index))
        if text is None:
            raise ProviderError("这条内嵌字幕尚在后台提取，请稍后重试或手动导入")
        return text


@dataclass
class _Entry:
    provider: str
    want: str
    ref: dict
    bucket_id: int
    key: str
    etag: str
    candidate: Candidate
    expires: float
    fetched: Fetched | None = None


@dataclass
class _Job:
    id: str
    bucket_id: int
    blob: str
    key: str
    etag: str
    track: int
    size: int
    state: str = "queued"
    read: int = 0
    detail: str = ""
    finished: float = 0.0
    task: asyncio.Task | None = field(default=None, repr=False)
    # 同一次读取里一并提取的全部字幕轨（含 track）。
    tracks: set[int] = field(default_factory=set)

    def public(self) -> dict:
        return {"id": self.id, "path": self.key, "track": self.track, "state": self.state, "read": self.read, "size": self.size,
                "detail": self.detail}


class MediaService:
    CANDIDATE_TTL = 600
    CANDIDATE_MAX = 4000
    SEARCH_TIMEOUT = 12
    LOOKUP_TIMEOUT = 20
    # 网页按来源逐个查询（先返回的先显示），一次查找会调用多次。
    LOOKUP_PER_MINUTE = 120
    RESULT_TTL = 1800
    TAGS_CACHE = 32
    SUBTITLE_CACHE_BYTES = 64 * 1024 * 1024
    SUBTITLE_LIMIT = 4 * 1024 * 1024
    EXTRACT_TIMEOUT = 3600
    JOBS_PER_USER = 2
    JOB_KEEP = 3600
    PREVIEW_LIMIT = 2 * 1024 * 1024

    def __init__(self, objects, keystore, resources=None, *, providers: dict[str, Provider] | None = None, http=None):
        self.objects, self.keystore, self.resources = objects, keystore, resources
        self.metadata = objects.metadata
        self.providers = providers if providers is not None else registry()
        self.http = http or _Http(lambda: (resources.config().get("proxy") or "") if resources is not None else "")
        self._candidates: collections.OrderedDict[str, _Entry] = collections.OrderedDict()
        self._results: dict[tuple, tuple[float, list[Candidate]]] = {}
        self._lookups: dict[int, collections.deque] = {}
        self._tags: collections.OrderedDict[str, media_tags.MediaTags | None] = collections.OrderedDict()
        self._subtitles: collections.OrderedDict[tuple[str, int], str] = collections.OrderedDict()
        self._jobs: dict[str, _Job] = {}
        self._extract_slots = asyncio.Semaphore(1)
        # 写入后在后台记录文件自带的元数据（只读文件头），队列有界，满了就留到首次查看时再提取。
        self._loop: asyncio.AbstractEventLoop | None = None
        self._commits: asyncio.Queue | None = None
        self._worker: asyncio.Task | None = None
        self._initializing: dict[str, asyncio.Lock] = {}
        from .editor import AudioEditor
        self.editor = AudioEditor(self)

    # ---------- 写入后提取 ----------

    COMMIT_QUEUE = 256
    COMMIT_DELAY = 2.0

    def start(self) -> None:
        if self._worker is None:
            self._loop = asyncio.get_running_loop()
            self._commits = asyncio.Queue(self.COMMIT_QUEUE)
            self._worker = asyncio.create_task(self._extract_commits())

    def committed(self, info: ObjectInfo, scope: Scope | None = None) -> None:
        """对象写入完成（上传、离线下载、解压、S3 等所有写入路径）：音视频排队提取元数据。可能在工作线程里调用。"""
        if self._loop is None or self._commits is None or self.kind(info) is None:
            return

        def put():
            try:
                self._commits.put_nowait(info)
            except asyncio.QueueFull:
                pass
        try:
            if asyncio.get_running_loop() is self._loop:
                put()
                return
        except RuntimeError:
            pass
        self._loop.call_soon_threadsafe(put)

    async def ensure_metadata(self, scope, key):
        """确保文件有元数据记录并完成首次字段解析（只读文件头与索引，已有解析缓存时不读取）。
        歌词、字幕不在这里提取：播放与编辑时没有保存的资源就回退到文件内置的数据，避免为整个视频回源。"""
        store = self.objects.file_metadata
        info, row = store.ensure(scope, key)
        if row["kind"] == "other" or row["fields_ready"]:
            return info, row
        ident = info.metadata_id
        task = self._initializing.get(ident)
        if task is None:
            # 同一文件的并发请求共用一次解析。
            task = asyncio.ensure_future(self._initialize(scope, key, info))
            self._initializing[ident] = task
            def done(finished):
                self._initializing.pop(ident, None)
                if not finished.cancelled():
                    finished.exception()  # 发起请求已断开时由后续请求或后台任务重试，不留下未读取的异常。
            task.add_done_callback(done)
        await asyncio.shield(task)
        return info, store.row(ident)

    async def _initialize(self, scope, key, info):
        store = self.objects.file_metadata
        # 解析按后台读取占名额，给播放与预览让路；每次读取前复核调用方的授权。
        reader = Scope(info.bucket_id, private_access=True, authorize=lambda: self.objects.head_object(scope, key))
        record = await self._record(reader, info, background=True)
        store.initial_fields(reader, info, parsed_fields(record) if record else {})

    async def _extract_commits(self) -> None:
        """后台逐个完成首次解析：新写入的文件优先（数据多半还在短期密文缓存里，不必回源），升级前的文件随后补齐。"""
        store = self.objects.file_metadata
        swept = 0.0
        while True:
            if time.monotonic() - swept > 3600:
                await self.metadata.run_in_thread(store.sweep)
                swept = time.monotonic()
            info = await self.metadata.run_in_thread(store.pending)
            if info is None:
                try:
                    await asyncio.wait_for(self._commits.get(), 10)
                except TimeoutError:
                    pass
                continue
            try:
                def authorize():
                    self.keystore.require_kek()
                    row = self.metadata.db.execute("SELECT u.status FROM buckets b LEFT JOIN users u ON u.id=b.owner_user_id WHERE b.id=?", (info.bucket_id,)).fetchone()
                    if row is None or row["status"] not in (None, "active"):
                        raise PermissionError("账号已禁用或删除")
                scope = Scope(info.bucket_id, private_access=True, authorize=authorize)
                authorize()
                store.state(info.metadata_id, "running")
                await self.ensure_metadata(scope, info.key)
                # 字段可能已由按需请求或复制带来；状态单独收尾，避免同一条记录被反复选中。
                store.state(info.metadata_id, "ready")
            except asyncio.CancelledError:
                if info.metadata_id:
                    store.state(info.metadata_id, "retry", "服务重启后继续解析", retry=5)
                raise
            except Exception as exc:
                # 暂时不可读、存储繁忙等都可恢复：稍后重试，期间按需请求仍会尝试解析。
                store.state(info.metadata_id, "partial", str(exc)[:256] if isinstance(exc, (ValueError, ProviderError)) else "首次解析暂未完成，稍后重试", retry=300)
                log.debug("首次解析媒体信息失败：%s", type(exc).__name__)

    # ---------- 配置 ----------

    def _settings(self) -> dict:
        row = self.metadata.db.execute("SELECT value FROM settings WHERE key=?", (CONFIG_KEY,)).fetchone()
        try:
            value = json.loads(row["value"]) if row else {}
        except (TypeError, ValueError):
            value = {}
        return value if isinstance(value, dict) else {}

    def _entry(self, provider: Provider, settings: dict | None = None) -> dict:
        item = (settings if settings is not None else self._settings()).get(provider.id)
        item = item if isinstance(item, dict) else {}
        return {"enabled": bool(item.get("enabled", provider.default_enabled)), "config": item.get("config") if isinstance(item.get("config"), dict) else {}}

    def _secret_key(self) -> bytes:
        return derive_subkey(self.keystore.require_kek(), SECRET_CONTEXT)

    def _secrets(self, provider: Provider) -> dict[str, str]:
        names = [item.key for item in provider.fields if item.secret]
        if not names:
            return {}
        keys = [f"{SECRET_PREFIX}{provider.id}.{name}" for name in names]
        marks = ",".join("?" for _ in keys)
        rows = {row["key"]: row["value"] for row in self.metadata.db.execute(f"SELECT key, value FROM settings WHERE key IN ({marks})", keys)}
        values = {}
        for name, key in zip(names, keys):
            if key in rows:
                values[name] = open_sealed(self._secret_key(), base64.b64decode(rows[key]), key).decode()
        return values

    def _has_secrets(self, provider: Provider) -> dict[str, bool]:
        names = [item.key for item in provider.fields if item.secret]
        keys = {f"{SECRET_PREFIX}{provider.id}.{name}": name for name in names}
        if not keys:
            return {}
        marks = ",".join("?" for _ in keys)
        present = {row["key"] for row in self.metadata.db.execute(f"SELECT key FROM settings WHERE key IN ({marks})", list(keys))}
        return {name: key in present for key, name in keys.items()}

    def config_of(self, provider: Provider) -> dict[str, str]:
        entry = self._entry(provider)
        plain = {item.key: str(entry["config"].get(item.key) or "") for item in provider.fields if not item.secret}
        return {**plain, **self._secrets(provider)}

    def enabled(self, provider: Provider) -> bool:
        return self._entry(provider)["enabled"]

    def describe(self) -> dict:
        settings = self._settings()
        items = []
        for provider in self.providers.values():
            entry = self._entry(provider, settings)
            secrets_present = self._has_secrets(provider)
            config = {item.key: str(entry["config"].get(item.key) or "") for item in provider.fields if not item.secret}
            missing = [item.label for item in provider.fields if item.required
                       and not (secrets_present.get(item.key) if item.secret else config.get(item.key, "").strip())]
            items.append({**provider.describe(), "enabled": entry["enabled"], "config": config, "secrets": secrets_present, "missing": missing})
        return {"providers": items, "ffmpeg": bool(getattr(self.resources, "ffmpeg", None))}

    def configure(self, payload: dict) -> dict:
        changes = payload.get("providers") if isinstance(payload, dict) else None
        if not isinstance(changes, dict):
            raise ValueError("缺少提供者配置")
        settings = self._settings()
        writes: dict[str, str | None] = {}
        for provider_id, change in changes.items():
            provider = self.providers.get(provider_id)
            if provider is None or not isinstance(change, dict):
                raise ValueError("未知的媒体信息提供者")
            entry = self._entry(provider, settings)
            fields = {item.key: item for item in provider.fields}
            config = dict(entry["config"])
            for key, value in (change.get("config") or {}).items():
                item = fields.get(key)
                if item is None or not isinstance(value, str) or len(value) > 2048 or any(ord(char) < 32 for char in value):
                    raise ValueError(f"{provider.name} 的配置项不正确")
                if item.secret:
                    if value.strip():
                        writes[f"{SECRET_PREFIX}{provider.id}.{key}"] = value.strip()
                else:
                    config[key] = value.strip()
            for key in change.get("clear") or []:
                item = fields.get(key)
                if item is None or not item.secret:
                    raise ValueError(f"{provider.name} 的配置项不正确")
                writes[f"{SECRET_PREFIX}{provider.id}.{key}"] = None
            enabled = change.get("enabled", entry["enabled"])
            if not isinstance(enabled, bool):
                raise ValueError("启用状态必须是布尔值")
            if enabled:
                present = self._has_secrets(provider)
                for item in provider.fields:
                    if not item.required:
                        continue
                    name = f"{SECRET_PREFIX}{provider.id}.{item.key}"
                    filled = (writes[name] is not None if name in writes else present.get(item.key)) if item.secret else bool(config.get(item.key))
                    if not filled:
                        raise ValueError(f"启用 {provider.name} 前请先填写「{item.label}」")
            settings[provider.id] = {"enabled": enabled, "config": config}
        key = self._secret_key() if writes else None
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (CONFIG_KEY, json.dumps(settings, ensure_ascii=False)))
            for name, value in writes.items():
                if value is None:
                    db.execute("DELETE FROM settings WHERE key=?", (name,))
                else:
                    db.execute("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                               (name, base64.b64encode(seal(key, value.encode(), name)).decode()))
        self._results.clear()
        return self.describe()

    def enabled_ids(self) -> list[str]:
        return [provider.id for provider in self.providers.values() if self.enabled(provider)]

    async def test(self, provider_id: str) -> dict:
        provider = self.providers.get(provider_id)
        if provider is None:
            raise NotFoundError(provider_id)
        config = self.config_of(provider)
        missing = provider.missing(config)
        if missing:
            return {"ok": False, "message": f"请先填写并保存「{'」「'.join(missing)}」"}
        try:
            async with asyncio.timeout(self.LOOKUP_TIMEOUT):
                message = await provider.test(ProviderContext(provider, config, self.http))
            return {"ok": True, "message": message}
        except ProviderError as exc:
            return {"ok": False, "message": str(exc)}
        except TimeoutError:
            return {"ok": False, "message": "连接超时，请检查服务器网络或出站代理"}

    # ---------- 文件元数据 ----------

    @staticmethod
    def kind(info: ObjectInfo) -> str | None:
        kind = kind_of(info.key, info.content_type)
        return kind if kind in ("audio", "video") and info.blob_uuid and info.size and not info.key.endswith("/") else None

    def _media(self, scope: Scope, key: str) -> tuple[ObjectInfo, str]:
        if key.endswith("/") or (key.startswith(".tgdrive/") and not scope.private_access):
            raise ValueError("只能查看普通音视频文件的媒体信息")
        info = self.objects.head_object(scope, key)
        kind = self.kind(info)
        if kind is None:
            raise ValueError("只有音频和视频文件有媒体信息")
        return info, kind

    async def _parsed(self, file: FileAccess) -> media_tags.MediaTags | None:
        blob = file.info.blob_uuid
        if blob in self._tags:
            self._tags.move_to_end(blob)
            file.tags = self._tags[blob]
            return file.tags
        file.tags = await media_tags.parse(file.read, file.info.size)
        self._tags[blob] = file.tags
        while len(self._tags) > self.TAGS_CACHE:
            self._tags.popitem(last=False)
        return file.tags

    def _row(self, blob: str):
        return self.metadata.db.execute("SELECT * FROM media_info WHERE blob_uuid=?", (blob,)).fetchone()

    def _store(self, blob: str, tags: media_tags.MediaTags | None) -> None:
        streams = [{"index": item.index, "codec": item.codec, "language": item.language, "title": item.title, "default": item.default,
                    "text": item.text} for item in (tags.subtitles if tags else [])]
        best = tags.best_lyrics() if tags else None
        values = (blob, media_tags.PARSER_VERSION, tags.container if tags else None, tags.duration if tags else None,
                  *((getattr(tags, name) if tags else None) for name in ("title", "artist", "album", "album_artist", "track", "year", "genre")),
                  json.dumps(tags.extra if tags else {}, ensure_ascii=False), json.dumps(streams, ensure_ascii=False),
                  0 if best is None else 2 if best.synced else 1, len(tags.pictures) if tags else 0, time.time())
        with self.metadata.transaction() as db:
            if db.execute("SELECT 1 FROM blobs WHERE uuid=?", (blob,)).fetchone() is None:
                return
            db.execute("INSERT INTO media_info(blob_uuid, parser, container, duration, title, artist, album, album_artist, track, year, genre, "
                       "extra, streams, lyrics, cover, extracted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                       "ON CONFLICT(blob_uuid) DO UPDATE SET parser=excluded.parser, container=excluded.container, duration=excluded.duration, "
                       "title=excluded.title, artist=excluded.artist, album=excluded.album, album_artist=excluded.album_artist, "
                       "track=excluded.track, year=excluded.year, genre=excluded.genre, extra=excluded.extra, streams=excluded.streams, "
                       "lyrics=excluded.lyrics, cover=excluded.cover, extracted_at=excluded.extracted_at", values)

    async def _record(self, scope: Scope, info: ObjectInfo, *, background: bool = False) -> dict:
        row = self._row(info.blob_uuid)
        if row is None or row["parser"] != media_tags.PARSER_VERSION:
            file = FileAccess(self, scope, info, background=background)
            await self._parsed(file)
            self._store(info.blob_uuid, file.tags)
            row = self._row(info.blob_uuid)
        if row is None:
            return {}
        return {name: row[name] for name in ("container", "duration", "title", "artist", "album", "album_artist", "track", "year", "genre")} | {
            "extra": json.loads(row["extra"] or "{}"), "streams": json.loads(row["streams"] or "[]"), "lyrics": row["lyrics"],
            "cover": row["cover"], "external": json.loads(row["external"] or "{}")}

    async def info(self, scope: Scope, key: str) -> dict:
        """播放器与编辑器用的媒体信息。lyrics／subtitles 是已保存的元数据资源；没有保存时给出可回退的文件内置数据：
        embedded_lyrics（用户没有清空过歌词时）与 embedded_subtitles（没有保存过、也没有被排除的文字字幕轨）。"""
        info, kind = self._media(scope, key)
        info, row = await self.ensure_metadata(scope, key)
        record = await self._record(scope, info)
        store = self.objects.file_metadata
        fields = store.fields(row)
        providers = {want: [{"id": provider.id, "name": provider.name} for provider in self.providers.values()
                            if provider.id != "embedded" and provider.supports(want, kind) and self.enabled(provider)] for want in (*WANTS, "info")}
        assets = store.preview_assets(info)
        lyrics = next((asset for asset in assets if asset["kind"] == "lyrics"), None)
        embedded_lyrics = ({"synced": record.get("lyrics") == 2} if kind == "audio" and lyrics is None and not row["manual_lyrics"]
                           and record.get("lyrics") else None)
        embedded_subtitles = [{**stream, "extracted": (info.blob_uuid, stream["index"]) in self._subtitles}
                              for stream in store.embedded_subtitles(row, record.get("streams") or [])] if kind == "video" else []
        return {**record, **fields, "kind": kind, "etag": info.etag, "revision": row["revision"], "embedded": True,
                "ffmpeg": bool(getattr(self.resources, "ffmpeg", None)), "providers": providers,
                "lyrics": lyrics, "embedded_lyrics": embedded_lyrics,
                "file_lyrics": {"synced": record.get("lyrics") == 2} if record.get("lyrics") else None,
                "subtitles": [asset for asset in assets if asset["kind"] == "subtitle"], "embedded_subtitles": embedded_subtitles,
                "initialization": row["state"], "detail": row["detail"]}

    async def embedded_lyrics(self, scope: Scope, key: str, etag: str) -> str:
        info, _ = self._media(scope, key)
        if info.etag != etag:
            raise ValueError("文件内容已变化，请重新打开")
        # 没有保存歌词时播放与编辑回退到文件内置的歌词：只读文件头，不受在线「内置数据」来源开关影响。
        file = FileAccess(self, scope, info)
        tags = await self._parsed(file)
        best = tags.best_lyrics() if tags else None
        if best is None:
            raise NotFoundError(key)
        return best.text

    async def embedded_cover(self, scope: Scope, key: str, etag: str) -> tuple[bytes, str]:
        """只读内置封面原图；书籍按索引提取，网页可在服务器没有 FFmpeg 时生成三种规格。"""
        info = self.objects.head_object(scope, key)
        book = book_type(info.key, info.content_type)
        if not book:
            info, _ = self._media(scope, key)
        elif not info.blob_uuid or key.endswith("/") or key.startswith(".tgdrive/") and not scope.private_access:
            raise ValueError("只能读取普通书籍文件的内置封面")
        if info.etag != etag:
            raise ValueError("文件内容已变化，请重新打开")
        if not book and not self.enabled(self.providers["embedded"]):
            raise ValueError("管理员已关闭内置数据")

        def check():
            current = self.objects.head_object(scope, key)
            if (current.blob_uuid, current.etag, current.metadata_id) != (info.blob_uuid, info.etag, info.metadata_id):
                raise ValueError("文件内容已变化，请重新打开")

        file = FileAccess(self, scope, info)

        async def read(start, end):
            check()
            data = await file.read(start, end)
            check()
            return data

        if book:
            data = await book_covers.read_cover(read, info.size, info.key, info.content_type)
        else:
            tags = await self._parsed(file)
            picture = tags.cover() if tags else None
            if picture is None:
                data = None
            elif picture.data is not None:
                data = picture.data
            elif picture.length > 20 * 1024 * 1024:
                raise ValueError("内嵌封面超过 20 MB")
            else:
                data = await read(picture.offset, picture.offset + picture.length)
        check()
        if data is None:
            raise NotFoundError(key)
        mime = _mime_ok(data)
        if mime is None:
            raise ValueError("内嵌封面不是受支持的图片格式")
        return data, mime

    # ---------- 查找与读取 ----------

    def _limit(self, bucket_id: int) -> None:
        now = time.monotonic()
        recent = self._lookups.setdefault(bucket_id, collections.deque())
        while recent and recent[0] < now - 60:
            recent.popleft()
        if len(recent) >= self.LOOKUP_PER_MINUTE:
            raise ValueError("查找太频繁了，请稍后再试")
        recent.append(now)

    async def _moviehash(self, file: FileAccess) -> str | None:
        """OpenSubtitles 的文件哈希：文件大小加上开头与末尾各 64 KiB 按 64 位小端整数求和。"""
        size, chunk = file.info.size, 64 * 1024
        if size < chunk * 2:
            return None
        head, tail = await asyncio.gather(file.read(0, chunk), file.read(size - chunk, size))
        value = size
        for data in (head, tail):
            value += sum(struct.unpack(f"<{chunk // 8}Q", data))
        return f"{value & 0xFFFFFFFFFFFFFFFF:016x}"

    # 影视封面的来源多是模糊搜索：片名相似度低于这个值的结果不显示。
    VIDEO_COVER_MIN = 0.5

    def _rank(self, query: MediaQuery, want: str, provider: Provider, candidate: Candidate) -> float:
        if provider.id == "embedded":
            return candidate.score
        if want == "cover" and query.kind == "video":
            if candidate.hash_match:
                return 1.0
            names = [candidate.title, *(part for part in candidate.subtitle.split(" · ") if part and not part.isdigit())]
            match = max((similarity(title, name) for title in query.titles() for name in names), default=0.0)
            year = 0.1 if query.year and query.year in candidate.subtitle else 0.0
            return min(1.0, match * 0.9 + year + float(candidate.ref.get("bonus") or 0))
        if want == "subtitle":
            if candidate.hash_match:
                return 1.0
            match = max(similarity(query.name, candidate.title), similarity(query.title, candidate.subtitle.split(" · ")[0]) * 0.9)
            language = (candidate.language or "").lower()
            preferred = next((index for index, code in enumerate(query.languages) if language.startswith(code.lower())), None)
            return min(1.0, match * 0.75 + (0.25 if preferred == 0 else 0.15 if preferred is not None else 0))
        value = score(query, candidate, artist=str(candidate.ref.get("artist") or ""))
        return min(1.0, value + float(candidate.ref.get("bonus") or 0))

    async def _search(self, provider: Provider, query: MediaQuery, want: str, ctx: ProviderContext) -> list[Candidate]:
        cache_key = (provider.id, query.cache_key(want))
        cached = self._results.get(cache_key) if provider.id != "embedded" else None
        if cached and cached[0] > time.monotonic():
            return cached[1]
        async with asyncio.timeout(self.SEARCH_TIMEOUT):
            results = await provider.search(query, want, ctx)
        if provider.id != "embedded":
            self._results[cache_key] = (time.monotonic() + self.RESULT_TTL, results)
            if len(self._results) > 512:
                for stale in [item for item, (until, _) in self._results.items() if until <= time.monotonic()] or list(self._results)[:128]:
                    self._results.pop(stale, None)
        return results

    async def collect(self, scope: Scope, key: str, want: str, overrides: dict | None = None, only: list[str] | None = None,
                      *, skip: tuple[str, ...] = (), throttle: bool = True) -> tuple[ObjectInfo, MediaQuery, list[Candidate], list[dict]]:
        """查询全部已启用的提供者：返回（文件、查询条件、按分数排好的候选、各提供者状态）。候选的 ref 只留在服务端。
        throttle=False 用于单并发的后台封面队列：不计入网页的每分钟查找次数，各提供者自身的请求间隔照常生效。"""
        if want not in (*WANTS, "info"):
            raise ValueError("不支持的查找类型")
        info, kind = self._media(scope, key)
        if want == "subtitle" and kind != "video" or want == "lyrics" and kind != "audio":
            raise ValueError("歌词只适用于音频，字幕只适用于视频")
        if throttle:
            self._limit(scope.bucket_id)
        info, metadata = await self.ensure_metadata(scope, key)
        record = (await self._record(scope, info)) | self.objects.file_metadata.fields(metadata)
        query = media_query.build(kind, info.key, info.size, record, overrides)
        providers = [provider for provider in self.providers.values()
                     if provider.supports(want, kind) and self.enabled(provider) and (not only or provider.id in only) and provider.id not in skip]
        file = FileAccess(self, scope, info)
        if want == "subtitle" and any(provider.id == "opensubtitles" for provider in providers):
            query.moviehash = await self._moviehash(file)
        if any(provider.id == "embedded" for provider in providers):
            await self._parsed(file)

        async def run(provider: Provider):
            config = self.config_of(provider)
            missing = provider.missing(config)
            if missing:
                raise ProviderError("管理员尚未完成配置")
            context = ProviderContext(provider, config, self.http, file if provider.id == "embedded" else None)
            if want != "info":
                return await self._search(provider, query, want, context)
            # 查找信息：复用封面或歌词搜索（共用结果缓存），只取带结构化字段的结果，按字段去重。
            results, seen = [], set()
            for candidate in await self._search(provider, query, provider.info_want(kind), context):
                signature = tuple(sorted(candidate.fields.items()))
                if candidate.fields and signature not in seen:
                    seen.add(signature)
                    results.append(dataclasses.replace(candidate, want="info"))
            return results

        outcomes = await asyncio.gather(*(run(provider) for provider in providers), return_exceptions=True)
        statuses, candidates = [], []
        for order, (provider, outcome) in enumerate(zip(providers, outcomes)):
            status = {"id": provider.id, "name": provider.name, "official": provider.official, "count": 0, "error": None}
            if isinstance(outcome, BaseException):
                status["error"] = str(outcome) if isinstance(outcome, ProviderError) else "查询超时" if isinstance(outcome, TimeoutError) else "查询失败"
            else:
                for candidate in outcome:
                    candidate.provider = provider.id
                    candidate.score = self._rank(query, want, provider, candidate)
                    if want == "cover" and kind == "video" and provider.id != "embedded" and candidate.score < self.VIDEO_COVER_MIN:
                        continue
                    candidates.append((order, candidate))
                status["count"] = sum(1 for _, item in candidates if item.provider == provider.id)
            statuses.append(status)
        candidates.sort(key=lambda item: (item[1].provider != "embedded", -round(item[1].score, 2), item[0]))
        return info, query, [candidate for _, candidate in candidates], statuses

    # 自动采用在线封面的最低匹配分（与文件助手「获取封面、歌词与字幕」的自动选择一致）。
    AUTO_COVER_MIN = 0.5

    async def best_cover(self, scope: Scope, key: str) -> bytes | None:
        """文件助手生成封面时的在线查找：跳过内置数据（已先尝试过），按匹配分依次读取前几张，返回第一张可用的原图。"""
        info, _, candidates, _ = await self.collect(scope, key, "cover", skip=("embedded",), throttle=False)
        for candidate in candidates[:3]:
            if not candidate.hash_match and candidate.score < self.AUTO_COVER_MIN:
                break  # 候选按分数从高到低排列，后面的更不匹配。
            entry = _Entry(candidate.provider, "cover", candidate.ref, scope.bucket_id, info.key, info.etag, candidate,
                           time.monotonic() + self.CANDIDATE_TTL)
            try:
                return (await self._fetch(scope, entry, info)).data
            except ValueError:
                continue
        return None

    async def lookup(self, scope: Scope, key: str, want: str, overrides: dict | None = None, only: list[str] | None = None) -> dict:
        info, query, candidates, statuses = await self.collect(scope, key, want, overrides, only)
        # 信息候选直接带字段，不需要读取令牌。
        public = [candidate.public("" if want == "info" else self._register(scope, info, want, candidate)) for candidate in candidates[:60]]
        return {"want": want, "kind": query.kind, "query": {"title": query.title, "artist": query.artist, "album": query.album, "year": query.year,
                                                           "season": query.season, "episode": query.episode, "duration": query.duration,
                                                           "languages": list(query.languages)},
                "candidates": public, "providers": statuses}

    def _register(self, scope: Scope, info: ObjectInfo, want: str, candidate: Candidate) -> str:
        token = secrets.token_urlsafe(18)
        self._candidates[token] = _Entry(candidate.provider, want, candidate.ref, scope.bucket_id, info.key, info.etag, candidate,
                                         time.monotonic() + self.CANDIDATE_TTL)
        while len(self._candidates) > self.CANDIDATE_MAX:
            self._candidates.popitem(last=False)
        return token

    def _claim(self, scope: Scope, key: str, token: str) -> tuple[_Entry, ObjectInfo]:
        entry = self._candidates.get(token) if isinstance(token, str) else None
        if entry is None or entry.expires <= time.monotonic():
            raise ValueError("查找结果已过期，请重新查找")
        info = self.objects.head_object(scope, key)
        if entry.bucket_id != scope.bucket_id or entry.key != key or entry.etag != info.etag:
            raise ValueError("文件已变化，请重新查找")
        return entry, info

    async def _fetch(self, scope: Scope, entry: _Entry, info: ObjectInfo) -> Fetched:
        if entry.fetched is not None:
            return entry.fetched
        provider = self.providers[entry.provider]
        if not self.enabled(provider):
            raise ValueError(f"管理员已关闭 {provider.name}")
        file = FileAccess(self, scope, info) if provider.id == "embedded" else None
        if file is not None:
            await self._parsed(file)
        try:
            async with asyncio.timeout(self.LOOKUP_TIMEOUT * 3):
                fetched = await provider.fetch(entry.ref, entry.want, ProviderContext(provider, self.config_of(provider), self.http, file))
        except ProviderError as exc:
            raise ValueError(str(exc)) from None
        except TimeoutError:
            raise ValueError(f"读取 {provider.name} 的内容超时") from None
        if entry.want == "cover":
            mime = _mime_ok(fetched.data or b"")
            if mime is None:
                raise ValueError("来源返回的不是受支持的图片")
            fetched.mime = mime
        elif not fetched.text or len(fetched.text.encode()) > media_text.TEXT_LIMIT:
            raise ValueError("来源没有返回可用的内容")
        entry.fetched = fetched
        return fetched

    async def fetch(self, scope: Scope, key: str, token: str) -> Fetched:
        entry, info = self._claim(scope, key, token)
        return await self._fetch(scope, entry, info)

    async def preview(self, scope: Scope, key: str, token: str) -> tuple[bytes, str]:
        """封面候选的小图：经服务器读取，浏览器不直接连接第三方（不暴露访问者地址，也符合页面 CSP）。"""
        entry, info = self._claim(scope, key, token)
        return await self._preview(scope, entry, info)

    async def _preview(self, scope: Scope, entry: _Entry, info: ObjectInfo) -> tuple[bytes, str]:
        if entry.want != "cover":
            raise ValueError("只有封面有预览图")
        url = entry.ref.get("preview_url")
        if not url:
            fetched = await self._fetch(scope, entry, info)
            return fetched.data, fetched.mime
        provider = self.providers[entry.provider]
        try:
            data, _ = await ProviderContext(provider, self.config_of(provider), self.http).get_bytes(url, headers=entry.ref.get("preview_headers"),
                                                                                                limit=self.PREVIEW_LIMIT)
        except ProviderError as exc:
            raise ValueError(str(exc)) from None
        mime = _mime_ok(data)
        if mime is None:
            raise ValueError("来源没有这张封面")
        return data, mime

    async def save(self, scope: Scope, key: str, token: str, *, language: str | None = None, overwrite: bool = False) -> dict:
        """把歌词或字幕保存为文件元数据资源。"""
        entry, info = self._claim(scope, key, token)
        if entry.want not in ("lyrics", "subtitle"):
            raise ValueError("封面请在「设置封面」中保存")
        if language:
            if not isinstance(language, str) or not _LANGUAGE.fullmatch(language) or len(language) > 16:
                raise ValueError("语言标记只能使用字母、数字和连字符，如 zh-CN、en")
        original, row = await self.ensure_metadata(scope, key)
        fetched = await self._fetch(scope, entry, info)
        return await self._write_asset(scope, key, entry.want, entry.provider, fetched, language=language, overwrite=overwrite,
                                       expected=(original.metadata_id, row["revision"], info.etag))

    @staticmethod
    def asset_target(key: str, want: str, extension: str = "", language: str | None = None) -> str:
        """歌词、字幕的同名文件路径：歌词为「主名.lrc」，字幕为「主名[.语言].srt|vtt」。"""
        directory, _, name = key.rpartition("/")
        stem = name.rsplit(".", 1)[0] if "." in name else name
        extension = "lrc" if want == "lyrics" else (extension if extension in ("srt", "vtt") else "srt")
        return (directory + "/" if directory else "") + stem + (f".{language}" if language else "") + "." + extension

    async def _write_asset(self, scope: Scope, key: str, want: str, provider: str, fetched: Fetched, *, language: str | None = None,
                           overwrite: bool = False, expected=None) -> dict:
        info, row = await self.ensure_metadata(scope, key)
        if expected is not None and (info.metadata_id, row["revision"], info.etag) != expected:
            raise VersionConflict("元数据已在查找期间修改，请重新获取候选")
        existing = [asset for asset in self.objects.file_metadata.assets(info.metadata_id, want)
                    if want == "lyrics" or asset["language"] == language]
        if existing and not overwrite:
            raise AssetExists("已有同类元数据资源，请确认是否替换")
        asset = await self.objects.file_metadata.stage_text(scope, info, want, fetched.text, language=language,
            title="歌词" if want == "lyrics" else language or "字幕", default=not existing or bool(existing[0]["is_default"]))
        try:
            self.objects.file_metadata.commit_edit(scope, info, row["revision"], {}, [asset],
                remove=[item["id"] for item in existing] if want == "subtitle" else [], lyrics=want == "lyrics", subtitles=want == "subtitle")
        finally:
            await self.objects.file_metadata.discard(info.bucket_id, [asset])
        return self.objects.file_metadata.public_asset(asset) | {"provider": provider, "replaced": bool(existing)}

    # ---------- 按冻结的候选读取与保存（文件助手的待确认操作） ----------

    def _frozen(self, scope: Scope, key: str, etag: str, provider: str, want: str, ref: dict) -> tuple[_Entry, ObjectInfo]:
        info, _ = self._media(scope, key)
        if info.etag != etag:
            raise ValueError("文件内容已变化，请重新查找")
        if provider not in self.providers or want not in WANTS or not isinstance(ref, dict):
            raise ValueError("候选已失效，请重新查找")
        return _Entry(provider, want, ref, scope.bucket_id, key, etag, None, time.monotonic() + self.CANDIDATE_TTL), info

    async def preview_frozen(self, scope: Scope, key: str, etag: str, provider: str, want: str, ref: dict) -> tuple[bytes, str]:
        entry, info = self._frozen(scope, key, etag, provider, want, ref)
        return await self._preview(scope, entry, info)

    async def fetch_frozen(self, scope: Scope, key: str, etag: str, provider: str, want: str, ref: dict) -> Fetched:
        entry, info = self._frozen(scope, key, etag, provider, want, ref)
        return await self._fetch(scope, entry, info)

    async def save_frozen(self, scope: Scope, key: str, etag: str, provider: str, want: str, ref: dict) -> dict:
        """保存选中的候选并覆盖已有的同类数据：歌词、字幕保存到隐藏空间，封面经服务器缩放后设为自定义封面。"""
        entry, info = self._frozen(scope, key, etag, provider, want, ref)
        original, row = await self.ensure_metadata(scope, key)
        cover_versions = self.objects.file_thumbnail_versions([original])[(original.bucket_id, original.key)]
        fetched = await self._fetch(scope, entry, info)
        if want != "cover":
            return await self._write_asset(scope, key, want, provider, fetched, overwrite=True,
                expected=(original.metadata_id, row["revision"], info.etag))
        current = self.objects.head_object(scope, key)
        if current.metadata_id != original.metadata_id or current.etag != etag:
            raise VersionConflict("原文件已变化，请重新查找")
        thumbnails = getattr(self.objects, "thumbnail_service", None)
        if thumbnails is None:
            raise ValueError("封面服务不可用")
        try:
            images = await thumbnails.render_image(fetched.data)
        except Exception as exc:  # FFmpeg 缩放失败时退回直接使用来源图片
            log.info("媒体封面缩放失败：%s", type(exc).__name__)
            images = None
        if not images:
            images = await self._unscaled(scope, entry, info, fetched)
        current = self.objects.head_object(scope, key)
        if cover_versions != self.objects.file_thumbnail_versions([current])[(current.bucket_id, current.key)]:
            raise VersionConflict("封面已在读取候选期间修改，请重新查找")
        saved = await thumbnails.apply_custom(scope, key, images)
        return {"path": key, "provider": provider, "variants": saved}

    async def _unscaled(self, scope: Scope, entry: _Entry, info: ObjectInfo, fetched: Fetched) -> dict:
        """服务器没有 FFmpeg 时不能缩放：按各规格的大小上限直接使用来源的小图与原图（只接受常见的 JPEG／PNG／WebP）。"""
        limits = self.objects.THUMBNAIL_LIMITS
        pictures = [fetched.data]
        if entry.ref.get("preview_url"):
            try:
                small, _ = await self._preview(scope, entry, info)
                pictures.append(small)
            except ValueError:
                pass
        usable = [data for data in pictures if data and _mime_ok(data) in ("image/jpeg", "image/png", "image/webp")]
        images = {}
        for variant, order in (("thumb", usable[::-1]), ("grid", usable), ("poster", usable)):
            choice = next((data for data in order if len(data) <= limits[variant]), None)
            if choice is not None:
                images[variant] = choice
        if "thumb" not in images:
            raise ValueError("服务器没有安装 FFmpeg，这张封面太大无法直接使用；请在文件菜单「设置封面 → 在线查找」中选择")
        return images

    # ---------- 内嵌字幕提取 ----------

    def _remember_subtitle(self, blob: str, track: int, text: str) -> None:
        self._subtitles[(blob, track)] = text
        while sum(len(item) for item in self._subtitles.values()) > self.SUBTITLE_CACHE_BYTES and len(self._subtitles) > 1:
            self._subtitles.popitem(last=False)

    def embedded_subtitle(self, scope: Scope, key: str, etag: str, track: int) -> str:
        info, _ = self._media(scope, key)
        if info.etag != etag:
            raise ValueError("文件内容已变化，请重新打开")
        text = self._subtitles.get((info.blob_uuid, track))
        if text is None:
            raise NotFoundError(key)
        self._subtitles.move_to_end((info.blob_uuid, track))
        return text

    async def extract(self, scope: Scope, key: str, etag: str, track: object) -> dict:
        """按需提取内置文字字幕（没有保存的字幕时播放器回退到它们）。MKV 等容器要读完整个文件，所以一次读取同时提取
        所有还没保存的文字轨，并保存为元数据资源：同一个视频以后不再为字幕回源读取。"""
        if not isinstance(track, int) or isinstance(track, bool) or not 0 <= track < 256:
            raise ValueError("字幕轨编号不正确")
        info, kind = self._media(scope, key)
        if kind != "video" or info.etag != etag:
            raise ValueError("文件内容已变化，请重新打开")
        info, row = await self.ensure_metadata(scope, key)
        record = await self._record(scope, info)
        streams = record.get("streams") or []
        stream = next((item for item in streams if item["index"] == track), None)
        if stream is None or not stream.get("text"):
            raise ValueError("这条字幕轨不是文字字幕，无法提取")
        self._expire_jobs()
        for job in self._jobs.values():
            if job.bucket_id == scope.bucket_id and job.blob == info.blob_uuid and track in job.tracks and job.state in ("queued", "running", "done"):
                return job.public()
        job = _Job(secrets.token_hex(8), scope.bucket_id, info.blob_uuid, info.key, info.etag, track, info.size, tracks={track})
        if (info.blob_uuid, track) in self._subtitles:
            job.state, job.finished = "done", time.monotonic()
            self._jobs[job.id] = job
            return job.public()
        if not getattr(self.resources, "ffmpeg", None):
            raise ValueError("服务器没有安装 FFmpeg，无法提取内嵌字幕")
        if sum(1 for item in self._jobs.values() if item.bucket_id == scope.bucket_id and item.state in ("queued", "running")) >= self.JOBS_PER_USER:
            raise ValueError("同时提取的字幕太多，请等前面的完成")
        others = [item for item in self.objects.file_metadata.embedded_subtitles(row, streams)
                  if item["index"] != track and (info.blob_uuid, item["index"]) not in self._subtitles]
        wanted = [stream, *others][:ASSET_LIMIT]
        job.tracks = {item["index"] for item in wanted}
        self._jobs[job.id] = job
        job.task = asyncio.create_task(self._run_extract(job, scope, info, wanted))
        return job.public()

    def jobs(self, scope: Scope, ids: list[str]) -> list[dict]:
        self._expire_jobs()
        return [job.public() for job_id in ids[:50] if (job := self._jobs.get(job_id)) is not None and job.bucket_id == scope.bucket_id]

    def _expire_jobs(self) -> None:
        now = time.monotonic()
        for job_id in [key for key, job in self._jobs.items() if job.finished and job.finished < now - self.JOB_KEEP]:
            self._jobs.pop(job_id, None)

    async def _run_extract(self, job: _Job, scope: Scope, info: ObjectInfo, streams: list[dict]) -> None:
        from ..thumbnails import FORMATS, _RangeInput

        def authorize():
            if scope.authorize is not None:
                scope.authorize()
            current = self.objects.head_object(scope, job.key)
            if current.etag != job.etag:
                raise ValueError("文件内容已变化")

        extracted: list[tuple[dict, str]] = []
        try:
            async with self._extract_slots:
                job.state = "running"
                # 原视频经回环地址按范围读取，不落盘；临时目录里只有受大小限制的字幕输出。
                async with _RangeInput(self.objects.engine, info, authorize) as source:
                    with tempfile.TemporaryDirectory(prefix="tessera-subtitles-") as directory:
                        outputs = [(stream, Path(directory) / f"{stream['index']}.vtt") for stream in streams]
                        options = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "http,tcp",
                                   "-format_whitelist", FORMATS, "-i", source.url]
                        for stream, path in outputs:
                            options += ["-map", f"0:s:{stream['index']}", "-c:s", "webvtt", "-f", "webvtt", "-fs", str(self.SUBTITLE_LIMIT + 1), str(path)]
                        env = {key: value for key, value in os.environ.items()
                               if key.lower() not in ("http_proxy", "https_proxy", "all_proxy", "no_proxy")}
                        env["http_proxy"] = source.origin
                        process = await asyncio.create_subprocess_exec(self.resources.ffmpeg, *options, env=env, stdin=asyncio.subprocess.DEVNULL,
                                                                       stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)

                        async def drain():
                            # 持续排空错误流，不把整段日志留在内存。
                            while await process.stderr.read(65536):
                                pass

                        async def progress():
                            while True:
                                job.read = source.remote_bytes
                                await asyncio.sleep(0.5)

                        watcher = asyncio.create_task(progress())
                        try:
                            async with asyncio.timeout(self.EXTRACT_TIMEOUT):
                                await drain()
                                code = await process.wait()
                        except BaseException:
                            if process.returncode is None:
                                process.kill()
                                await process.wait()
                            raise
                        finally:
                            watcher.cancel()
                        if source.failure is not None:
                            raise source.failure
                        for stream, path in outputs:
                            if not path.exists() or path.stat().st_size > self.SUBTITLE_LIMIT:
                                continue
                            text = media_text.decode(path.read_bytes()).replace("\r\n", "\n")
                            if "-->" in text:
                                self._remember_subtitle(job.blob, stream["index"], text)
                                extracted.append((stream, text))
                if not any(stream["index"] == job.track for stream, _ in extracted):
                    raise ValueError("FFmpeg 无法提取这条字幕" if code != 0 else "这条字幕轨没有内容")
                job.state, job.read = "done", job.size
        except asyncio.CancelledError:
            job.state, job.detail = "failed", "已取消"
            raise
        except Exception as exc:
            job.state = "failed"
            job.detail = str(exc) if isinstance(exc, (ValueError, ProviderError)) else "提取失败，请稍后重试"
        finally:
            job.finished = time.monotonic()
        # 保存为元数据资源（尽力而为）：失败（如空间已满）时本次播放仍用内存里的结果，下次再提取。
        store = self.objects.file_metadata
        for stream, text in extracted:
            try:
                await store.initial_asset(scope, info, "subtitle", text, source=f"embedded:{stream['index']}",
                                          title=stream.get("title") or stream.get("language") or f"字幕 {stream['index'] + 1}",
                                          language=self._language_tag(stream.get("language")), default=bool(stream.get("default")))
            except Exception as exc:
                log.debug("保存内置字幕失败：%s", type(exc).__name__)

    @staticmethod
    def _language_tag(value):
        return value if isinstance(value, str) and _LANGUAGE.fullmatch(value) and len(value) <= 16 else None

    async def stop(self) -> None:
        await self.editor.stop()
        tasks = [job.task for job in self._jobs.values() if job.task is not None and not job.task.done()]
        if self._worker is not None:
            tasks.append(self._worker)
            self._worker = None
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
