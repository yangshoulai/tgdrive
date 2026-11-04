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

    def __init__(self, service: "MediaService", scope: Scope, info: ObjectInfo):
        self.service, self.scope, self.info = service, scope, info
        self.tags: media_tags.MediaTags | None = None

    async def read(self, start: int, end: int) -> bytes:
        if self.scope.authorize is not None:
            self.scope.authorize()
        if not self.info.blob_uuid or start >= end:
            return b""
        pieces = []
        stream = self.service.objects.engine.stream(self.info.blob_uuid, start, min(end, self.info.size), window=max(64 * 1024, end - start),
                                                    bucket_id=self.info.bucket_id)
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
    LOOKUP_PER_MINUTE = 30
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

    def _rank(self, query: MediaQuery, want: str, provider: Provider, candidate: Candidate) -> float:
        if provider.id == "embedded":
            return candidate.score
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

    async def lookup(self, scope: Scope, key: str, want: str, overrides: dict | None = None, only: list[str] | None = None) -> dict:
        if want not in WANTS:
            raise ValueError("不支持的查找类型")
        info, kind = self._media(scope, key)
        if want == "subtitle" and kind != "video" or want == "lyrics" and kind != "audio":
            raise ValueError("歌词只适用于音频，字幕只适用于视频")
        self._limit(scope.bucket_id)
        record = await self._record(scope, info)
        query = media_query.build(kind, info.key, info.size, record, overrides)
        providers = [provider for provider in self.providers.values()
                     if provider.supports(want, kind) and self.enabled(provider) and (not only or provider.id in only)]
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
                status["count"] = len(outcome)
                for candidate in outcome:
                    candidate.provider = provider.id
                    candidate.score = self._rank(query, want, provider, candidate)
                    candidates.append((order, candidate))
            statuses.append(status)
        candidates.sort(key=lambda item: (item[1].provider != "embedded", -round(item[1].score, 2), item[0]))
        public = [candidate.public(self._register(scope, info, want, candidate)) for _, candidate in candidates[:60]]
        return {"want": want, "kind": kind, "query": {"title": query.title, "artist": query.artist, "album": query.album, "year": query.year,
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
        if entry.want != "cover":
            raise ValueError("只有封面有预览图")
        url = entry.ref.get("preview_url")
        if not url:
            fetched = await self._fetch(scope, entry, info)
            return fetched.data, fetched.mime
        provider = self.providers[entry.provider]
        try:
            data, _ = await ProviderContext(provider, self.config_of(provider), self.http).get_bytes(url, limit=self.PREVIEW_LIMIT)
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
        directory, _, name = key.rpartition("/")
        stem = name.rsplit(".", 1)[0] if "." in name else name
        extension = "lrc" if entry.want == "lyrics" else (fetched.format if fetched.format in ("srt", "vtt") else "srt")
        target = (directory + "/" if directory else "") + stem + (f".{language}" if language else "") + "." + extension
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
                "provider": entry.provider, "format": extension, "replaced": existing is not None}

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
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
