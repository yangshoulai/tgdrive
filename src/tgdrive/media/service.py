"""媒体元数据服务：统一对网页提供「文件元数据、查找候选、读取候选、保存」，具体内容来自已启用的提供者。

- 文件自带的元数据由 ``tags.parse`` 按需读取文件头提取，按 Blob 记在 ``media_info``（副本共用）。
- 提供者在系统设置里逐个开关；秘密配置用 KEK 子密钥 ``media-provider-secret`` 加密保存，接口只回显是否已填写。
- 查找结果的 ``ref``（外部地址、编号等）只留在服务端，网页拿到的是绑定（存储桶、路径、版本）的短期令牌。
- 歌词与字幕保存为媒体同目录的同名文件（``preview_assets`` 自动发现）；封面由网页按自定义封面流程保存。
- 内嵌字幕轨用 FFmpeg 经回环地址按范围读取原文件提取成 WebVTT；MKV 的字幕分散在整个文件里，需要读完整个文件，
  所以提取是后台任务，结果只缓存在内存。
"""

from __future__ import annotations

import asyncio
import base64
import logging
import collections
import json
import os
import re
import secrets
import struct
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from ..crypto import derive_subkey, open_sealed, seal
from ..errors import NotFoundError, VersionConflict
from ..filekinds import kind_of
from ..objects import ObjectInfo, Scope
from ..version import __version__
from . import query as media_query
from . import tags as media_tags
from . import text as media_text
from .providers import registry
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
        text = self.service._subtitles.get((self.info.blob_uuid, index))
        if text is None:
            raise ProviderError("这条内嵌字幕还没有提取，请在播放器的字幕菜单中选择它，提取完成后再保存")
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

    async def _extract_commits(self) -> None:
        while True:
            info = await self._commits.get()
            try:
                await asyncio.sleep(self.COMMIT_DELAY)
                row = self._row(info.blob_uuid)
                if row is not None and row["parser"] == media_tags.PARSER_VERSION:
                    continue
                # 内部任务：按对象所在的存储桶读取，不经网页授权；读取按后台读取占名额，给播放与预览让路。
                file = FileAccess(self, Scope(info.bucket_id, private_access=True), info, background=True)
                file.tags = await media_tags.parse(file.read, info.size)
                self._store(info.blob_uuid, file.tags)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # 文件已删除、存储暂时不可用等：留到首次查看时再提取
                log.debug("写入后提取媒体信息失败：%s", type(exc).__name__)

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

    async def _record(self, scope: Scope, info: ObjectInfo) -> dict:
        row = self._row(info.blob_uuid)
        if row is None or row["parser"] != media_tags.PARSER_VERSION:
            file = FileAccess(self, scope, info)
            await self._parsed(file)
            self._store(info.blob_uuid, file.tags)
            row = self._row(info.blob_uuid)
        if row is None:
            return {}
        return {name: row[name] for name in ("container", "duration", "title", "artist", "album", "album_artist", "track", "year", "genre")} | {
            "extra": json.loads(row["extra"] or "{}"), "streams": json.loads(row["streams"] or "[]"), "lyrics": row["lyrics"],
            "cover": row["cover"], "external": json.loads(row["external"] or "{}")}

    async def info(self, scope: Scope, key: str) -> dict:
        info, kind = self._media(scope, key)
        record = await self._record(scope, info)
        embedded = self.enabled(self.providers["embedded"]) if "embedded" in self.providers else False
        providers = {want: [{"id": provider.id, "name": provider.name} for provider in self.providers.values()
                            if provider.id != "embedded" and provider.supports(want, kind) and self.enabled(provider)] for want in WANTS}
        subtitles = []
        if embedded:
            for stream in record.get("streams") or []:
                subtitles.append({**stream, "extracted": (info.blob_uuid, stream["index"]) in self._subtitles})
        return {"kind": kind, "etag": info.etag, "embedded": embedded, "ffmpeg": bool(getattr(self.resources, "ffmpeg", None)),
                **{name: record.get(name) for name in ("container", "duration", "title", "artist", "album", "album_artist", "track", "year", "genre")},
                "lyrics": ({"synced": record.get("lyrics") == 2} if embedded and record.get("lyrics") else None),
                "cover": bool(embedded and record.get("cover")), "subtitles": subtitles, "providers": providers}

    async def embedded_lyrics(self, scope: Scope, key: str, etag: str) -> str:
        info, _ = self._media(scope, key)
        if info.etag != etag:
            raise ValueError("文件内容已变化，请重新打开")
        if not self.enabled(self.providers["embedded"]):
            raise ValueError("管理员已关闭内置数据")
        file = FileAccess(self, scope, info)
        tags = await self._parsed(file)
        best = tags.best_lyrics() if tags else None
        if best is None:
            raise NotFoundError(key)
        return best.text

    async def embedded_cover(self, scope: Scope, key: str, etag: str) -> tuple[bytes, str]:
        """文件内嵌的封面原图：网页在文件还没有封面时用它生成三种规格（服务器没有 FFmpeg 也能补上音乐封面）。"""
        info, _ = self._media(scope, key)
        if info.etag != etag:
            raise ValueError("文件内容已变化，请重新打开")
        if not self.enabled(self.providers["embedded"]):
            raise ValueError("管理员已关闭内置数据")
        file = FileAccess(self, scope, info)
        tags = await self._parsed(file)
        picture = tags.cover() if tags else None
        if picture is None:
            raise NotFoundError(key)
        if picture.data is not None:
            data = picture.data
        elif picture.length > 20 * 1024 * 1024:
            raise ValueError("内嵌封面超过 20 MB")
        else:
            data = await file.read(picture.offset, picture.offset + picture.length)
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
        if want not in WANTS:
            raise ValueError("不支持的查找类型")
        info, kind = self._media(scope, key)
        if want == "subtitle" and kind != "video" or want == "lyrics" and kind != "audio":
            raise ValueError("歌词只适用于音频，字幕只适用于视频")
        if throttle:
            self._limit(scope.bucket_id)
        record = await self._record(scope, info)
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
            return await self._search(provider, query, want, ProviderContext(provider, config, self.http, file if provider.id == "embedded" else None))

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
        public = [candidate.public(self._register(scope, info, want, candidate)) for candidate in candidates[:60]]
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
        """把歌词或字幕保存为媒体同目录的同名文件（``preview_assets`` 自动发现）。"""
        entry, info = self._claim(scope, key, token)
        if entry.want not in ("lyrics", "subtitle"):
            raise ValueError("封面请在「设置封面」中保存")
        if language:
            if not isinstance(language, str) or not _LANGUAGE.fullmatch(language) or len(language) > 16:
                raise ValueError("语言标记只能使用字母、数字和连字符，如 zh-CN、en")
        fetched = await self._fetch(scope, entry, info)
        return await self._write_asset(scope, key, entry.want, entry.provider, fetched, language=language, overwrite=overwrite)

    @staticmethod
    def asset_target(key: str, want: str, extension: str = "", language: str | None = None) -> str:
        """歌词、字幕的同名文件路径：歌词为「主名.lrc」，字幕为「主名[.语言].srt|vtt」。"""
        directory, _, name = key.rpartition("/")
        stem = name.rsplit(".", 1)[0] if "." in name else name
        extension = "lrc" if want == "lyrics" else (extension if extension in ("srt", "vtt") else "srt")
        return (directory + "/" if directory else "") + stem + (f".{language}" if language else "") + "." + extension

    async def _write_asset(self, scope: Scope, key: str, want: str, provider: str, fetched: Fetched, *, language: str | None = None,
                           overwrite: bool = False) -> dict:
        target = self.asset_target(key, want, fetched.format or "", language)
        extension = target.rsplit(".", 1)[-1]
        try:
            existing = self.objects.head_object(scope, target)
        except NotFoundError:
            existing = None
        if existing is not None and not overwrite:
            raise AssetExists(f"已有同名文件「{target.rsplit('/', 1)[-1]}」")
        data = fetched.text.encode("utf-8")
        mime = {"lrc": "text/plain; charset=utf-8", "srt": "application/x-subrip; charset=utf-8", "vtt": "text/vtt; charset=utf-8"}[extension]
        saved = await self.objects.put_object(scope, target, data, len(data), mime, if_match=existing.etag if existing else None)
        return {"path": saved.key, "name": saved.key.rsplit("/", 1)[-1], "etag": saved.etag, "size": saved.size,
                "provider": provider, "format": extension, "replaced": existing is not None}

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
        """保存选中的候选并覆盖已有的同类数据：歌词、字幕写同名文件，封面经服务器缩放后设为自定义封面。"""
        entry, info = self._frozen(scope, key, etag, provider, want, ref)
        fetched = await self._fetch(scope, entry, info)
        if want != "cover":
            return await self._write_asset(scope, key, want, provider, fetched, overwrite=True)
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
        if not isinstance(track, int) or isinstance(track, bool) or not 0 <= track < 256:
            raise ValueError("字幕轨编号不正确")
        info, kind = self._media(scope, key)
        if kind != "video" or info.etag != etag:
            raise ValueError("文件内容已变化，请重新打开")
        if not self.enabled(self.providers["embedded"]):
            raise ValueError("管理员已关闭内置数据")
        record = await self._record(scope, info)
        stream = next((item for item in record.get("streams") or [] if item["index"] == track), None)
        if stream is None or not stream.get("text"):
            raise ValueError("这条字幕轨不是文字字幕，无法提取")
        self._expire_jobs()
        for job in self._jobs.values():
            if job.bucket_id == scope.bucket_id and job.blob == info.blob_uuid and job.track == track and job.state in ("queued", "running", "done"):
                return job.public()
        job = _Job(secrets.token_hex(8), scope.bucket_id, info.blob_uuid, info.key, info.etag, track, info.size)
        if (info.blob_uuid, track) in self._subtitles:
            job.state, job.finished = "done", time.monotonic()
            self._jobs[job.id] = job
            return job.public()
        if not getattr(self.resources, "ffmpeg", None):
            raise ValueError("服务器没有安装 FFmpeg，无法提取内嵌字幕")
        if sum(1 for item in self._jobs.values() if item.bucket_id == scope.bucket_id and item.state in ("queued", "running")) >= self.JOBS_PER_USER:
            raise ValueError("同时提取的字幕太多，请等前面的完成")
        self._jobs[job.id] = job
        job.task = asyncio.create_task(self._run_extract(job, scope, info))
        return job.public()

    def jobs(self, scope: Scope, ids: list[str]) -> list[dict]:
        self._expire_jobs()
        return [job.public() for job_id in ids[:50] if (job := self._jobs.get(job_id)) is not None and job.bucket_id == scope.bucket_id]

    def _expire_jobs(self) -> None:
        now = time.monotonic()
        for job_id in [key for key, job in self._jobs.items() if job.finished and job.finished < now - self.JOB_KEEP]:
            self._jobs.pop(job_id, None)

    async def _run_extract(self, job: _Job, scope: Scope, info: ObjectInfo) -> None:
        from ..thumbnails import FORMATS, _RangeInput

        def authorize():
            if scope.authorize is not None:
                scope.authorize()
            current = self.objects.head_object(scope, job.key)
            if current.etag != job.etag:
                raise ValueError("文件内容已变化")

        try:
            async with self._extract_slots:
                job.state = "running"
                async with _RangeInput(self.objects.engine, info, authorize) as source:
                    options = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "http,tcp",
                               "-format_whitelist", FORMATS, "-i", source.url, "-map", f"0:s:{job.track}", "-f", "webvtt", "pipe:1"]
                    env = {key: value for key, value in os.environ.items()
                           if key.lower() not in ("http_proxy", "https_proxy", "all_proxy", "no_proxy")}
                    env["http_proxy"] = source.origin
                    process = await asyncio.create_subprocess_exec(self.resources.ffmpeg, *options, env=env, stdin=asyncio.subprocess.DEVNULL,
                                                                   stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    output = bytearray()

                    async def collect():
                        while True:
                            piece = await process.stdout.read(65536)
                            if not piece:
                                return
                            output.extend(piece)
                            if len(output) > self.SUBTITLE_LIMIT:
                                raise ValueError("字幕超过 4 MB")

                    async def progress():
                        while True:
                            job.read = source.remote_bytes
                            await asyncio.sleep(0.5)

                    watcher = asyncio.create_task(progress())
                    try:
                        async with asyncio.timeout(self.EXTRACT_TIMEOUT):
                            _, errors = await asyncio.gather(collect(), process.stderr.read())
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
                    if code != 0:
                        raise ValueError("FFmpeg 无法提取这条字幕")
                text = media_text.decode(bytes(output)).replace("\r\n", "\n")
                if "-->" not in text:
                    raise ValueError("这条字幕轨没有内容")
                self._remember_subtitle(job.blob, job.track, text)
                job.state, job.read = "done", job.size
        except asyncio.CancelledError:
            job.state, job.detail = "failed", "已取消"
            raise
        except Exception as exc:
            job.state = "failed"
            job.detail = str(exc) if isinstance(exc, (ValueError, ProviderError)) else "提取失败，请稍后重试"
        finally:
            job.finished = time.monotonic()

    async def stop(self) -> None:
        tasks = [job.task for job in self._jobs.values() if job.task is not None and not job.task.done()]
        if self._worker is not None:
            tasks.append(self._worker)
            self._worker = None
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
