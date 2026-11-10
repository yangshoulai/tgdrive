"""文件级元数据与小资源：原媒体不变，隐藏资源通过对象服务加密并计入用户配额。"""

from __future__ import annotations

import json
import re
import secrets
import time

from ..errors import NotFoundError, QuotaExceededError, VersionConflict
from ..filekinds import kind_of

AUDIO_FIELDS = {"title", "artist", "album", "album_artist", "track", "year", "genre", "composer", "description"}
VIDEO_FIELDS = {"title", "artist", "director", "actors", "year", "genre", "description"}
FIELDS = AUDIO_FIELDS | VIDEO_FIELDS
# 列表、音乐库与歌单展示的字段；duration 只来自首次解析（不可编辑），其余为手动覆盖 > 首次解析。
LIST_FIELDS = ("title", "artist", "album", "album_artist", "track", "year", "genre", "duration")
TEXT_LIMIT = 2 * 1024 * 1024
ASSET_LIMIT = 32


def parsed_fields(record) -> dict:
    """把解析结果（media_info 行或 MediaService._record）转成首次字段；只保留非空值。"""
    fields = {name: str(record[name]) for name in ("title", "artist", "album", "album_artist", "track", "year", "genre")
              if record[name] not in (None, "")}
    extra = record["extra"] or {}
    if isinstance(extra, str):
        try:
            extra = json.loads(extra)
        except ValueError:
            extra = {}
    for name in ("composer", "director", "actors", "description"):
        if extra.get(name):
            fields[name] = str(extra[name])[:16384 if name == "description" else 4096]
    if isinstance(record["duration"], (int, float)) and record["duration"] > 0:
        fields["duration"] = float(record["duration"])
    return fields


class FileMetadataStore:
    PREFIX = ".tgdrive/media/"

    def __init__(self, objects):
        self.objects = objects
        self.metadata = objects.metadata

    @staticmethod
    def eligible(key):
        return bool(key and not key.endswith("/") and (not key.startswith(".tgdrive/") or key.startswith(".tgdrive/private/")))

    def create(self, db, bucket_id, blob, key, content_type, now=None):
        now = time.time() if now is None else now
        ident = secrets.token_hex(16)
        kind = kind_of(key, content_type)
        kind = kind if kind in ("audio", "video") else "other"
        db.execute("INSERT INTO file_metadata(id,bucket_id,source_blob,kind,state,fields_ready,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                   (ident, bucket_id, blob, kind, "ready" if kind == "other" else "pending", int(kind == "other"), now, now))
        return ident

    def row(self, ident):
        return self.metadata.db.execute("SELECT * FROM file_metadata WHERE id=?", (ident,)).fetchone() if ident else None

    def ensure(self, scope, key):
        info = self.objects.head_object(scope, key)
        if not info.blob_uuid or not self.eligible(key):
            raise ValueError("只有普通文件可以编辑元数据")
        if info.metadata_id and (row := self.row(info.metadata_id)) is not None:
            return info, row
        with self.metadata.transaction() as db:
            current = db.execute("SELECT * FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key)).fetchone()
            self.objects._check_scope(scope, key)
            if current is None or current["blob_uuid"] != info.blob_uuid:
                raise VersionConflict("文件已变化，请重新打开")
            ident = current["metadata_id"]
            if not ident or self.row(ident) is None:
                ident = self.create(db, scope.bucket_id, info.blob_uuid, key, info.content_type)
                db.execute("UPDATE objects SET metadata_id=? WHERE bucket_id=? AND key=?", (ident, scope.bucket_id, key))
        return self.objects.head_object(scope, key), self.row(ident)

    @staticmethod
    def fields(row):
        return json.loads(row["auto_fields"]) | json.loads(row["overrides"])

    def summaries(self, items):
        """列表用的展示字段：只返回非空值，没有任何字段时不返回（网页据此判断是否需要按需补读）。"""
        ids = list(dict.fromkeys(item.metadata_id for item in items if item.metadata_id))
        if not ids:
            return {}
        result = {}
        for row in self.metadata.db.execute(f"SELECT * FROM file_metadata WHERE id IN ({','.join('?' * len(ids))}) AND kind!='other'", ids):
            fields = self.fields(row)
            values = {name: fields[name] for name in LIST_FIELDS if fields.get(name) not in (None, "")}
            if values:
                result[row["id"]] = values
        return result

    def assets(self, ident, kind=None):
        if not ident:
            return []
        return list(self.metadata.db.execute("SELECT * FROM file_media_assets WHERE metadata_id=?" + (" AND kind=?" if kind else "")
                                            + " ORDER BY is_default DESC,updated_at,id", (ident, kind) if kind else (ident,)))

    @staticmethod
    def public_asset(row):
        return {"id": row["id"], "path": "metadata:" + row["id"], "name": row["title"] or ("歌词" if row["kind"] == "lyrics" else "字幕"),
                "kind": row["kind"], "language": row["language"], "size": row["size"], "etag": row["etag"],
                "format": row["format"], "default": bool(row["is_default"]), "source": "metadata",
                "synced": row["format"] == "lrc" if row["kind"] == "lyrics" else False}

    def preview_assets(self, info):
        return [self.public_asset(row) for row in self.assets(info.metadata_id) if row["kind"] in ("lyrics", "subtitle")]

    def guard(self, scope, info):
        def check():
            self.objects._check_scope(scope, info.key, write=True)
            current = self.objects.head_object(scope, info.key)
            if current.blob_uuid != info.blob_uuid or current.metadata_id != info.metadata_id or current.etag != info.etag:
                raise VersionConflict("原文件已删除、移动或覆盖，修改未保存")
        return check

    async def read_asset(self, scope, key, ident):
        # 先校验源文件，再定位隐藏对象；隐藏路径不参与用户授权，不能绕过私密或分享边界。
        info = self.objects.head_object(scope, key)
        row = self.metadata.db.execute("SELECT a.* FROM file_media_assets a WHERE a.id=? AND a.metadata_id=?", (ident, info.metadata_id)).fetchone()
        if row is None or row["kind"] not in ("lyrics", "subtitle"):
            raise NotFoundError("媒体资源不存在")
        item = self.metadata.db.execute("SELECT * FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, row["object_key"])).fetchone()
        if item is None or item["etag"] != row["etag"]:
            raise NotFoundError("媒体资源暂时不可用")
        data = await self.objects.engine.read_small(item["blob_uuid"])
        self.objects._check_scope(scope, key)
        current = self.objects.head_object(scope, key)
        if current.metadata_id != info.metadata_id or current.blob_uuid != info.blob_uuid:
            raise VersionConflict("文件已变化，请重新打开")
        return data, item["content_type"] or "text/plain; charset=utf-8", row["etag"]

    @staticmethod
    def language(value):
        value = value or None
        if value is not None and (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*", value) or len(value) > 24):
            raise ValueError("语言标记不正确，请使用 zh-CN、en、jpn 等标记")
        return value.replace("_", "-") if value else None

    async def stage_text(self, scope, info, kind, text, *, language=None, title="", source=None, ident=None, default=False):
        from ..objects import Scope
        from .text import normalize_subtitle
        from .tags import is_synced
        if not isinstance(text, str) or "\x00" in text or len(text.encode("utf-8")) > TEXT_LIMIT:
            raise ValueError("歌词和字幕最多 2 MB，不能含空字符")
        text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not text:
            raise ValueError("资源内容不能为空")
        if kind == "subtitle":
            try:
                value = normalize_subtitle(text.encode("utf-8"))
            except Exception as exc:
                from .providers.base import ProviderError
                if isinstance(exc, ProviderError):
                    raise ValueError(str(exc)) from None
                raise
            text, extension = value.text, value.format
        else:
            extension = "lrc" if is_synced(text) else "txt"
        language = self.language(language)
        if not isinstance(title, str) or len(title.encode("utf-8")) > 512 or "\x00" in title:
            raise ValueError("资源名称最多 512 字节，不能含空字符")
        data = text.encode("utf-8")
        if len(data) > TEXT_LIMIT:
            raise ValueError("歌词和字幕最多 2 MB")
        key = f"{self.PREFIX}{info.metadata_id}/{secrets.token_hex(16)}.{extension}"
        mime = {"vtt": "text/vtt", "srt": "application/x-subrip"}.get(extension, "text/plain") + "; charset=utf-8"
        check = self.guard(scope, info)
        saved = await self.objects.put_object(Scope(info.bucket_id, authorize=check), key, data, len(data), mime, small=True)
        return {"id": ident or secrets.token_hex(16), "metadata_id": info.metadata_id, "kind": kind, "variant": "", "language": language,
                "title": title.strip(), "object_key": saved.key, "etag": saved.etag, "size": saved.size, "format": extension,
                "source": source, "is_default": int(default), "updated_at": time.time()}

    @staticmethod
    def insert_asset(db, asset):
        names = tuple(asset)
        db.execute(f"INSERT INTO file_media_assets({','.join(names)}) VALUES({','.join('?' * len(names))})", tuple(asset[name] for name in names))

    def drop_asset(self, db, bucket_id, row, now):
        db.execute("DELETE FROM file_media_assets WHERE id=?", (row["id"],))
        self.objects._drop_object_row(db, bucket_id, row["object_key"], now)

    async def discard(self, bucket_id, staged):
        from ..objects import Scope
        keys = [item["object_key"] for item in staged if self.metadata.db.execute(
            "SELECT 1 FROM file_media_assets WHERE object_key=? LIMIT 1", (item["object_key"],)).fetchone() is None]
        if keys:
            await self.objects.delete_objects(Scope(bucket_id), keys)

    def drop_unreferenced(self, db, ident, now):
        if not ident or db.execute("SELECT 1 FROM objects WHERE metadata_id=? LIMIT 1", (ident,)).fetchone():
            return
        row = db.execute("SELECT bucket_id FROM file_metadata WHERE id=?", (ident,)).fetchone()
        if row is None:
            return
        assets = self.assets(ident)
        db.execute("DELETE FROM file_metadata WHERE id=?", (ident,))
        for asset in assets:
            self.objects._drop_object_row(db, row["bucket_id"], asset["object_key"], now)

    def clone(self, db, source, bucket_id, key, now):
        ident = self.create(db, bucket_id, source["blob_uuid"], key, source["content_type"], now)
        row = self.row(source["metadata_id"])
        if row is None:
            return ident
        db.execute("UPDATE file_metadata SET auto_fields=?,overrides=?,fields_ready=?,manual_lyrics=?,manual_subtitles=?,excluded_subtitles=?,state=? WHERE id=?",
                   (row["auto_fields"], row["overrides"], row["fields_ready"], row["manual_lyrics"], row["manual_subtitles"], row["excluded_subtitles"],
                    "ready" if row["state"] == "ready" else "pending", ident))
        if source["bucket_id"] == bucket_id:
            # 本人的复制沿用决定；分享转存不把别人的媒体库偏好带进接收者账号。
            db.execute("UPDATE file_metadata SET library_policy=? WHERE id=?", (row["library_policy"], ident))
        for asset in self.assets(row["id"]):
            old = db.execute("SELECT * FROM objects WHERE bucket_id=? AND key=?", (source["bucket_id"], asset["object_key"])).fetchone()
            if old is None:
                continue
            bucket = db.execute("SELECT used_bytes,quota_bytes FROM buckets WHERE id=?", (bucket_id,)).fetchone()
            if bucket["quota_bytes"] is not None and bucket["used_bytes"] + old["size"] > bucket["quota_bytes"]:
                raise QuotaExceededError("复制媒体资源时存储空间不足")
            target = f"{self.PREFIX}{ident}/{secrets.token_hex(16)}.{asset['format']}"
            db.execute("UPDATE blobs SET refcount=refcount+1 WHERE uuid=?", (old["blob_uuid"],))
            db.execute("INSERT INTO objects(bucket_id,key,blob_uuid,size,etag,content_type,user_meta,modified_at) VALUES(?,?,?,?,?,?,?,?)",
                       (bucket_id, target, old["blob_uuid"], old["size"], old["etag"], old["content_type"], old["user_meta"], now))
            db.execute("UPDATE buckets SET used_bytes=used_bytes+? WHERE id=?", (old["size"], bucket_id))
            copied = dict(asset) | {"id": secrets.token_hex(16), "metadata_id": ident, "object_key": target, "updated_at": now}
            self.insert_asset(db, copied)
        return ident

    def cover_versions(self, items):
        ids = list(dict.fromkeys(item.metadata_id for item in items if item.metadata_id))
        result = {}
        if ids:
            for row in self.metadata.db.execute(f"SELECT metadata_id,variant,updated_at FROM file_media_assets WHERE kind='cover' AND metadata_id IN ({','.join('?' * len(ids))})", ids):
                result.setdefault(row["metadata_id"], {})[row["variant"]] = f"m:{row['metadata_id']}:{int(row['updated_at'] * 1000000)}"
        return result

    async def read_cover(self, info, variant, known):
        rows = {row["variant"]: row for row in self.assets(info.metadata_id, "cover")}
        if not rows:
            return None
        for candidate in self.objects.THUMBNAIL_FALLBACK.get(variant, (variant,)):
            row = rows.get(candidate)
            if row is None:
                continue
            etag = row["etag"]
            if etag in known:
                return b"", "image/jpeg", etag
            item = self.metadata.db.execute("SELECT blob_uuid,content_type FROM objects WHERE bucket_id=? AND key=?", (info.bucket_id, row["object_key"])).fetchone()
            if item:
                return await self.objects.engine.read_small(item["blob_uuid"]), item["content_type"], etag
        raise NotFoundError("封面暂时不可用")

    async def set_cover(self, scope, key, data, variant):
        from ..objects import Scope
        info, _ = self.ensure(scope, key)
        check = self.guard(scope, info)
        target = f"{self.PREFIX}{info.metadata_id}/{secrets.token_hex(16)}.{variant}"
        mime = self.objects._thumbnail_mime(data)
        saved = await self.objects.put_object(Scope(info.bucket_id, authorize=check), target, data, len(data), mime, small=True)
        asset = {"id": secrets.token_hex(16), "metadata_id": info.metadata_id, "kind": "cover", "variant": variant, "language": None,
                 "title": "", "object_key": target, "etag": saved.etag, "size": saved.size, "format": variant, "source": variant,
                 "is_default": 0, "updated_at": time.time()}
        try:
            with self.metadata.transaction() as db:
                check()
                old = next((row for row in self.assets(info.metadata_id, "cover") if row["variant"] == variant), None)
                if old:
                    self.drop_asset(db, scope.bucket_id, old, time.time())
                self.insert_asset(db, asset)
            self.objects._changed(scope.bucket_id)
        finally:
            await self.discard(scope.bucket_id, [asset])

    def finish_covers(self, scope, key, variants):
        info, _ = self.ensure(scope, key)
        self.objects._check_scope(scope, key, write=True)
        with self.metadata.transaction() as db:
            for row in self.assets(info.metadata_id, "cover"):
                if row["variant"] not in variants:
                    self.drop_asset(db, scope.bucket_id, row, time.time())

    def validate_fields(self, kind, fields):
        allowed = AUDIO_FIELDS if kind == "audio" else VIDEO_FIELDS if kind == "video" else set()
        if not isinstance(fields, dict) or set(fields) - allowed:
            raise ValueError("此类文件不支持这些元数据字段")
        result = {}
        for key, value in fields.items():
            if value is None:
                result[key] = None  # 恢复为文件自带（自动解析）的值：去掉覆盖
                continue
            limit = 16384 if key == "description" else 4096 if key == "actors" else 512
            if not isinstance(value, str) or "\x00" in value or len(value.encode("utf-8")) > limit:
                raise ValueError("元数据字段内容过长或包含空字符")
            result[key] = value.strip()
        return result

    def commit_edit(self, scope, info, revision, fields, staged, updates=(), remove=(), *, lyrics=False, subtitles=False, exclude=()):
        check = self.guard(scope, info)
        now = time.time()
        with self.metadata.transaction() as db:
            check()
            row = self.row(info.metadata_id)
            if row is None or row["revision"] != revision:
                raise VersionConflict("元数据已在别处修改，请重新打开编辑")
            current = {asset["id"]: asset for asset in self.assets(info.metadata_id)}
            if any(ident not in current or current[ident]["kind"] == "cover" for ident in remove):
                raise ValueError("要删除的媒体资源不存在")
            if lyrics:
                remove = set(remove) | {ident for ident, asset in current.items() if asset["kind"] == "lyrics"}
            # exclude：编辑器里「不再使用」的内置字幕轨（尚未保存为资源），播放时不再回退到它们。
            excluded = set(json.loads(row["excluded_subtitles"])) | set(exclude)
            for ident in remove:
                if current[ident]["kind"] == "subtitle" and current[ident]["source"]:
                    excluded.add(current[ident]["source"])
                self.drop_asset(db, info.bucket_id, current.pop(ident), now)
            for update in updates:
                old = current.get(update["id"])
                if old is None or old["kind"] != "subtitle":
                    raise ValueError("字幕资源不存在")
                if update.get("is_default"):
                    db.execute("UPDATE file_media_assets SET is_default=0 WHERE metadata_id=? AND kind='subtitle'", (info.metadata_id,))
                db.execute("UPDATE file_media_assets SET language=?,title=?,is_default=?,updated_at=? WHERE id=?",
                           (update["language"], update["title"], update["is_default"], now, old["id"]))
            before = db.execute("SELECT COUNT(*) FROM file_media_assets WHERE metadata_id=? AND kind='subtitle'", (info.metadata_id,)).fetchone()[0]
            for asset in staged:
                old = current.get(asset["id"])
                if old:
                    asset["source"] = old["source"]
                    self.drop_asset(db, info.bucket_id, old, now)
                if asset["is_default"]:
                    db.execute("UPDATE file_media_assets SET is_default=0 WHERE metadata_id=? AND kind=?", (info.metadata_id, asset["kind"]))
                self.insert_asset(db, asset)
            count = db.execute("SELECT COUNT(*) FROM file_media_assets WHERE metadata_id=? AND kind='subtitle'", (info.metadata_id,)).fetchone()[0]
            # 只拒绝让数量继续增长的编辑：旧版本自动提取可能已超过上限，不能因此连标题都改不了。
            if count > ASSET_LIMIT and count > before:
                raise ValueError("每个视频最多保存 32 条字幕")
            overrides = {key: value for key, value in (json.loads(row["overrides"]) | fields).items() if value is not None}
            db.execute("UPDATE file_metadata SET overrides=?,revision=revision+1,manual_lyrics=MAX(manual_lyrics,?),"
                       "manual_subtitles=MAX(manual_subtitles,?),excluded_subtitles=?,updated_at=? WHERE id=?",
                       (json.dumps(overrides, ensure_ascii=False), int(lyrics), int(subtitles), json.dumps(sorted(excluded)), now, info.metadata_id))
        self.objects._changed(scope.bucket_id)
        return self.row(info.metadata_id)

    def initial_fields(self, scope, info, fields):
        check = self.guard(scope, info)
        with self.metadata.transaction() as db:
            check()
            db.execute("UPDATE file_metadata SET auto_fields=?,fields_ready=1,state='ready',detail='',retry_at=0,updated_at=? "
                       "WHERE id=? AND fields_ready=0", (json.dumps(fields, ensure_ascii=False), time.time(), info.metadata_id))

    async def initial_asset(self, scope, info, kind, text, *, source, language=None, title="", default=False):
        row = self.row(info.metadata_id)
        def excluded(row):
            return row["manual_lyrics"] if kind == "lyrics" else source in json.loads(row["excluded_subtitles"])
        existing = self.assets(info.metadata_id, kind) if row is not None else []
        if row is None or excluded(row) or any(asset["source"] == source for asset in existing):
            return
        if kind == "subtitle" and len(existing) >= ASSET_LIMIT:
            return  # 内置字幕轨超过上限的部分不自动保存，仍作为回退来源播放
        asset = await self.stage_text(scope, info, kind, text, source=source, language=language, title=title, default=default)
        try:
            with self.metadata.transaction() as db:
                self.guard(scope, info)()
                row = self.row(info.metadata_id)
                full = kind == "subtitle" and db.execute("SELECT COUNT(*) FROM file_media_assets WHERE metadata_id=? AND kind='subtitle'",
                                                         (info.metadata_id,)).fetchone()[0] >= ASSET_LIMIT
                if row is not None and not full and not excluded(row) and not db.execute(
                        "SELECT 1 FROM file_media_assets WHERE metadata_id=? AND kind=? AND source=?", (info.metadata_id, kind, source)).fetchone():
                    if asset["is_default"] and db.execute("SELECT 1 FROM file_media_assets WHERE metadata_id=? AND kind=? AND is_default=1",
                                                           (info.metadata_id, kind)).fetchone():
                        asset["is_default"] = 0
                    self.insert_asset(db, asset)
        finally:
            await self.discard(info.bucket_id, [asset])

    def embedded_subtitles(self, row, streams):
        """还没保存为资源、也没被用户排除的内置文字字幕轨：播放与编辑时作为回退来源。"""
        if row is None:
            return []
        saved = {asset["source"] for asset in self.assets(row["id"], "subtitle") if asset["source"]}
        excluded = set(json.loads(row["excluded_subtitles"]))
        return [stream for stream in streams if stream.get("text") and f"embedded:{stream['index']}" not in saved | excluded]

    def pending(self):
        """下一个等待首次解析的文件：新文件优先——刚写入的数据还在短期密文缓存里，解析不必回源读取存储。"""
        row = self.metadata.db.execute("SELECT o.* FROM file_metadata f JOIN objects o ON o.metadata_id=f.id "
                                       "WHERE f.state IN ('pending','running','retry','partial') AND f.retry_at<=? "
                                       "AND (substr(o.key,1,9)!='.tgdrive/' OR substr(o.key,1,17)='.tgdrive/private/') "
                                       "ORDER BY f.created_at DESC LIMIT 1", (time.time(),)).fetchone()
        return self.objects._object(row) if row else None

    def state(self, ident, value, detail="", retry=0):
        with self.metadata.transaction() as db:
            db.execute("UPDATE file_metadata SET state=?,detail=?,retry_at=?,updated_at=? WHERE id=?",
                       (value, detail, time.time() + retry if retry else 0, time.time(), ident))

    def sweep(self):
        """回收崩溃前尚未登记的小资源；给仍在提交的请求保留一小时窗口。"""
        now = time.time()
        with self.metadata.transaction() as db:
            rows = db.execute("SELECT bucket_id,key FROM objects o WHERE key>=? AND key<? AND modified_at<? "
                              "AND NOT EXISTS(SELECT 1 FROM file_media_assets a WHERE a.object_key=o.key) LIMIT 128",
                              (self.PREFIX, self.PREFIX + "\U0010ffff", now - 3600)).fetchall()
            for row in rows:
                self.objects._drop_object_row(db, row["bucket_id"], row["key"], now)
