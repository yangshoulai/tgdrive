"""只编辑文件级元数据和隐藏小资源，绝不重封装或覆盖原始媒体。"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field

from ..errors import NotFoundError, QuotaExceededError, VersionConflict
from .records import ASSET_LIMIT, FIELDS, TEXT_LIMIT


@dataclass
class EditJob:
    id: str
    bucket: int
    key: str
    etag: str
    size: int = 0
    state: str = "queued"
    read: int = 0
    stored: int = 0
    detail: str = "等待保存元数据"
    finished: float = 0
    result: dict | None = None
    task: asyncio.Task | None = field(default=None, repr=False)

    def public(self):
        return {name: getattr(self, name) for name in ("id", "state", "read", "stored", "size", "detail", "result")} | {"path": self.key}


class AudioEditor:
    """保留网页接口的服务名；音频和视频统一使用文件级元数据。"""
    REQUEST_LIMIT = 8 * 1024 * 1024
    MAX_JOBS = 32
    KEEP = 3600

    def __init__(self, media):
        self.media = media
        self.store = media.objects.file_metadata
        self.jobs = {}
        self.slot = asyncio.Semaphore(1)

    async def info(self, scope, key):
        """编辑器初始内容：已保存的资源优先；没有保存歌词时预填文件内置歌词（不修改就不会保存），
        视频另列出还没保存的内置文字字幕轨，可以提取保存或排除。"""
        self.media.objects._check_scope(scope, key, write=True)
        info, row = await self.media.ensure_metadata(scope, key)
        fields = self.store.fields(row)
        assets = self.store.preview_assets(info)
        lyrics = next((asset for asset in assets if asset["kind"] == "lyrics"), None)
        text, source = "", ""
        if lyrics:
            text, source = (await self.store.read_asset(scope, key, lyrics["id"]))[0].decode("utf-8"), "metadata"
        elif row["kind"] == "audio" and not row["manual_lyrics"]:
            try:
                text, source = await self.media.embedded_lyrics(scope, key, info.etag), "embedded"
            except (NotFoundError, ValueError):
                pass
        embedded = []
        if row["kind"] == "video":
            record = await self.media._record(scope, info)
            embedded = [{name: stream.get(name) for name in ("index", "codec", "language", "title", "default")}
                        for stream in self.store.embedded_subtitles(row, record.get("streams") or [])]
        covers = self.media.objects.file_thumbnail_versions([info])[(info.bucket_id, info.key)]
        return {"etag": info.etag, "revision": row["revision"], "kind": row["kind"], "size": info.size,
                "duration": fields.get("duration"), "fields": {key: str(fields.get(key) or "") for key in FIELDS},
                "lyrics": text, "lyrics_source": source,
                "assets": [asset for asset in assets if asset["kind"] == "subtitle"], "embedded_subtitles": embedded,
                "cover": "thumb" in covers, "editable": row["kind"] in ("audio", "video"),
                "initialization": {"state": row["state"], "detail": row["detail"]}, "reason": "其他文件只支持封面管理"}

    async def start(self, scope, key, payload):
        info, row = self.store.ensure(scope, key)
        self.media.objects._check_scope(scope, key, write=True)
        if info.etag != payload.get("etag"):
            raise VersionConflict("原文件已变化，请重新打开编辑")
        revision = payload.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or row["revision"] != revision:
            raise VersionConflict("元数据已变化或页面版本已过期，请重新打开编辑")
        if payload.get("cover", "keep") != "keep":
            raise ValueError("封面请在封面页保存；元数据编辑不会修改原文件")
        fields = payload.get("fields", {})
        if not isinstance(fields, dict):
            raise ValueError("元数据字段格式不正确")
        fields = fields.copy()
        lyrics = fields.pop("lyrics", None) if "lyrics" in fields else None
        has_lyrics = "lyrics" in payload.get("fields", {})
        legacy_subtitle = fields.pop("subtitle", None)
        fields = self.store.validate_fields(row["kind"], fields)
        if has_lyrics and (row["kind"] != "audio" or not isinstance(lyrics, str) or len(lyrics.encode("utf-8")) > TEXT_LIMIT):
            raise ValueError("歌词只用于音频，每份最多 2 MB")
        ops = payload.get("subtitles") or {}
        if not isinstance(ops, dict) or set(ops) - {"upsert", "remove", "exclude"}:
            raise ValueError("字幕操作格式不正确")
        upsert, remove, exclude = ops.get("upsert", []), ops.get("remove", []), ops.get("exclude", [])
        if not isinstance(exclude, list) or len(exclude) > 256 or any(isinstance(item, bool) or not isinstance(item, int) or not 0 <= item < 256 for item in exclude):
            raise ValueError("要排除的内置字幕轨不正确")
        exclude = [f"embedded:{item}" for item in dict.fromkeys(exclude)]
        if legacy_subtitle and isinstance(upsert, list):
            upsert = [*upsert, {"text": legacy_subtitle, "title": "字幕"}]
        if not isinstance(upsert, list) or not isinstance(remove, list) or len(upsert) + len(remove) > 2 * ASSET_LIMIT:
            raise ValueError("每次最多管理 32 条字幕")
        has_subtitles = bool(upsert or remove or exclude)
        if has_subtitles and row["kind"] != "video":
            raise ValueError("只有视频可以管理字幕")
        known = {asset["id"]: asset for asset in self.store.assets(info.metadata_id, "subtitle")}
        if any(not isinstance(ident, str) or ident not in known for ident in remove):
            raise ValueError("要删除的字幕不存在")
        clean = []
        seen = set()
        for value in upsert:
            if not isinstance(value, dict) or set(value) - {"id", "text", "language", "title", "default"}:
                raise ValueError("字幕信息格式不正确")
            ident = value.get("id")
            if ident is not None and (not isinstance(ident, str) or ident not in known or ident in seen or ident in remove):
                raise ValueError("字幕编号不存在或重复")
            seen.add(ident) if ident is not None else None
            old = known.get(ident)
            language = self.store.language(value.get("language", old["language"] if old else None))
            title = value.get("title", old["title"] if old else "字幕")
            default = value.get("default", bool(old["is_default"]) if old else not known and not clean)
            if not isinstance(title, str) or len(title.encode("utf-8")) > 512 or not isinstance(default, bool):
                raise ValueError("字幕名称或默认设置不正确")
            item = {"id": ident, "language": language, "title": title, "is_default": int(default)}
            if "text" in value:
                text = value["text"]
                if not isinstance(text, str) or len(text.encode("utf-8")) > TEXT_LIMIT:
                    raise ValueError("每份字幕最多 2 MB")
                item["text"] = text
            elif old is None:
                raise ValueError("新增字幕需要填写内容")
            clean.append(item)
        if not fields and not has_lyrics and not has_subtitles:
            raise ValueError("没有需要保存的修改")
        now = time.monotonic()
        self.jobs = {ident: job for ident, job in self.jobs.items() if not job.finished or now - job.finished < self.KEEP}
        active = [job for job in self.jobs.values() if not job.finished]
        if len(active) >= self.MAX_JOBS or any(job.bucket == scope.bucket_id for job in active):
            raise ValueError("已有元数据正在保存，请稍后重试")
        size = (len(lyrics.encode("utf-8")) if lyrics else 0) + sum(len(item.get("text", "").encode("utf-8")) for item in clean)
        job = EditJob(secrets.token_hex(8), scope.bucket_id, key, info.etag, size)
        self.jobs[job.id] = job
        job.task = asyncio.create_task(self.run(job, scope, info, revision, fields, lyrics, has_lyrics, clean, remove, exclude))
        return job.public()

    def status(self, scope, ids):
        result = []
        for ident in ids[:32]:
            job = self.jobs.get(ident)
            if job is not None and job.bucket == scope.bucket_id:
                self.media.objects._check_scope(scope, job.key, write=True)
                result.append(job.public())
        return result

    def cancel(self, scope, ident):
        if not isinstance(ident, str) or not self.status(scope, [ident]):
            raise NotFoundError("元数据保存任务不存在")
        job = self.jobs[ident]
        cancelled = False
        if job.result is None and job.state in ("queued", "running") and job.task and not job.task.done():
            job.state, job.detail, job.finished = "cancelled", "已取消保存", time.monotonic()
            job.task.cancel(); cancelled = True
        return {"cancelled": cancelled, "committed": job.result is not None}

    async def run(self, job, scope, info, revision, fields, lyrics, has_lyrics, subtitles, remove, exclude=()):
        from ..api import UserApi
        staged = []
        try:
            async with self.slot:
                self.store.guard(scope, info)()
                job.state, job.detail = "running", "正在保存元数据，原文件不会改动"
                if lyrics and lyrics.strip():
                    staged.append(await self.store.stage_text(scope, info, "lyrics", lyrics, title="歌词", default=True))
                updates = []
                for item in subtitles:
                    if "text" in item:
                        staged.append(await self.store.stage_text(scope, info, "subtitle", item["text"], ident=item["id"],
                            language=item["language"], title=item["title"], default=bool(item["is_default"])))
                    else:
                        updates.append(item)
                job.stored = sum(asset["size"] for asset in staged)
                row = self.store.commit_edit(scope, info, revision, fields, staged, updates, remove,
                                             lyrics=has_lyrics, subtitles=bool(subtitles or remove), exclude=exclude)
                saved = self.media.objects.head_object(scope, info.key)
                preferred = next((asset for asset in staged if asset["is_default"]), staged[-1] if staged else None)
                job.result = UserApi._object_json(saved) | {"metadata_revision": row["revision"],
                    "asset": "metadata:" + preferred["id"] if preferred else None}
                job.state, job.detail = "done", "元数据已保存，原文件未改动"
        except asyncio.CancelledError:
            job.state, job.detail = "cancelled", "已取消保存，原文件未改动"
        except Exception as exc:
            job.state = "failed"
            job.detail = str(exc) if isinstance(exc, (ValueError, VersionConflict, QuotaExceededError, PermissionError)) else "元数据保存失败，请稍后重试"
        finally:
            try:
                await self.store.discard(scope.bucket_id, staged)
            finally:
                job.finished = time.monotonic()

    async def stop(self):
        tasks = [job.task for job in self.jobs.values() if job.task and not job.task.done()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
