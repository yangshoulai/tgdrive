"""M3 对象服务：桶、对象、目录前缀和 S3 multipart 基础语义。"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import time
import unicodedata
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass

from .blobengine import BlobEngine
from .errors import InvalidStateError, NotFoundError, QuotaExceededError, ShareExpiredError
from .fingerprint import combine, is_fingerprint
from .metadata import Metadata


@dataclass(frozen=True)
class Scope:
    bucket_id: int
    prefix: str = ""
    perms: str = "rw"


@dataclass(frozen=True)
class ObjectInfo:
    bucket_id: int
    key: str
    size: int
    etag: str
    content_type: str | None
    user_meta: dict[str, str]
    modified_at: float
    blob_uuid: str | None
    public_token: str | None = None
    public_at: float | None = None
    public_expires_at: float | None = None
    public_has_password: bool = False
    public_downloads: int = 0


@dataclass(frozen=True)
class ListPage:
    objects: list[ObjectInfo]
    common_prefixes: list[str]
    next_cursor: str | None


@dataclass(frozen=True)
class DeleteResult:
    key: str
    deleted: bool


@dataclass(frozen=True)
class MoveResult:
    moved: int
    skipped: int


@dataclass(frozen=True)
class PartInfo:
    upload_id: str
    part_no: int
    size: int
    etag: str
    uploaded_at: float


class ObjectService:
    def __init__(self, metadata: Metadata, engine: BlobEngine) -> None:
        self.metadata, self.engine = metadata, engine

    @staticmethod
    def _check_scope(scope: Scope, key: str, *, write: bool = False) -> None:
        if scope.perms not in ("ro", "rw"):
            raise PermissionError("invalid scope permissions")
        if write and scope.perms != "rw":
            raise PermissionError("scope is read-only")
        if (not key or "\x00" in key or key.startswith("/") or
                any(segment == ".." for segment in key.split("/")) or len(key.encode("utf-8")) > 1024):
            raise ValueError("invalid object key")
        if not key.startswith(scope.prefix):
            raise PermissionError("object key is outside scope prefix")

    def create_bucket(self, name: str, *, owner_user_id: int | None = None,
                      quota_bytes: int | None = None) -> int:
        if not (3 <= len(name) <= 63 and re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?", name)):
            raise ValueError("invalid bucket name")
        if quota_bytes is not None and quota_bytes < 0:
            raise ValueError("quota must be non-negative")
        with self.metadata.transaction() as db:
            cursor = db.execute("INSERT INTO buckets(name,owner_user_id,quota_bytes,created_at) VALUES(?,?,?,?)",
                                (name, owner_user_id, quota_bytes, time.time()))
            return int(cursor.lastrowid)

    def _bucket(self, bucket_id: int):
        row = self.metadata.db.execute("SELECT * FROM buckets WHERE id = ?", (bucket_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"bucket {bucket_id} not found")
        return row

    @staticmethod
    def _object(row) -> ObjectInfo:
        try:
            user_meta = json.loads(row["user_meta"]) if row["user_meta"] else {}
        except (ValueError, TypeError):
            user_meta = {}
        columns = row.keys()
        get = lambda name, default=None: row[name] if name in columns else default
        return ObjectInfo(row["bucket_id"], row["key"], row["size"], row["etag"], row["content_type"],
                          user_meta, row["modified_at"], row["blob_uuid"], get("public_token"), get("public_at"),
                          get("public_expires_at"), bool(get("public_password")), int(get("public_downloads", 0) or 0))

    def _lookup(self, scope: Scope, key: str, *, write: bool = False):
        self._check_scope(scope, key, write=write)
        self._bucket(scope.bucket_id)
        row = self.metadata.db.execute("SELECT * FROM objects WHERE bucket_id = ? AND key = ?",
                                       (scope.bucket_id, key)).fetchone()
        if row is None:
            raise NotFoundError(key)
        return row

    def _release_blob(self, db, blob_uuid: str, now: float) -> None:
        row = db.execute("SELECT refcount FROM blobs WHERE uuid = ?", (blob_uuid,)).fetchone()
        if row is None:
            return
        count = int(row["refcount"]) - 1
        if count > 0:
            db.execute("UPDATE blobs SET refcount = ? WHERE uuid = ?", (count, blob_uuid))
            return
        refs = [r[0] for r in db.execute("SELECT blob_ref FROM chunks WHERE blob_uuid = ?", (blob_uuid,))]
        db.executemany("INSERT INTO gc_queue(blob_ref,enqueued_at) VALUES(?,?)", ((ref, now) for ref in refs))
        # 已完成的分段上传记录仍引用该 Blob（用于幂等重试），必须先删除，否则外键约束会阻止删除和覆盖。
        db.execute("DELETE FROM uploads WHERE blob_uuid = ?", (blob_uuid,))
        db.execute("DELETE FROM blobs WHERE uuid = ?", (blob_uuid,))

    def _commit_blob(self, bucket_id: int, key: str, blob_uuid: str, size: int, etag: str,
                     content_type: str | None, user_meta: dict[str, str] | None) -> ObjectInfo:
        now = time.time()
        meta_json = json.dumps(user_meta or {}, ensure_ascii=False, separators=(",", ":"))
        with self.metadata.transaction() as db:
            bucket = db.execute("SELECT quota_bytes, used_bytes FROM buckets WHERE id = ?", (bucket_id,)).fetchone()
            if bucket is None:
                raise NotFoundError(f"bucket {bucket_id} not found")
            old = db.execute("SELECT * FROM objects WHERE bucket_id = ? AND key = ?", (bucket_id, key)).fetchone()
            old_size = int(old["size"]) if old else 0
            new_used = int(bucket["used_bytes"]) - old_size + size
            if bucket["quota_bytes"] is not None and new_used > bucket["quota_bytes"]:
                raise QuotaExceededError("存储桶配额不足")
            db.execute("UPDATE blobs SET refcount = refcount + 1 WHERE uuid = ?", (blob_uuid,))
            db.execute("DELETE FROM objects WHERE bucket_id = ? AND key = ?", (bucket_id, key))
            if old and old["blob_uuid"]:
                self._release_blob(db, old["blob_uuid"], now)
            # 覆盖写入保留原公开链接，已分享的地址不会因为更新内容而失效。
            share = [old[name] if old else None for name in ("public_token", "public_at", "public_expires_at", "public_password")]
            downloads = old["public_downloads"] if old else 0
            db.execute("INSERT INTO objects(bucket_id,key,blob_uuid,size,etag,content_type,user_meta,modified_at,"
                       "public_token,public_at,public_expires_at,public_password,public_downloads) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (bucket_id, key, blob_uuid, size, etag, content_type, meta_json, now, *share, downloads))
            db.execute("UPDATE buckets SET used_bytes = ? WHERE id = ?", (new_used, bucket_id))
        row = self.metadata.db.execute("SELECT * FROM objects WHERE bucket_id = ? AND key = ?", (bucket_id, key)).fetchone()
        return self._object(row)

    def _quota_room(self, bucket_id: int, key: str, *, reserved: int = 0) -> int | None:
        """写入 key 时还能容纳的字节数；None 表示不限。已有同名对象的大小会被释放，计入可用空间。"""
        bucket = self._bucket(bucket_id)
        if bucket["quota_bytes"] is None:
            return None
        old = self.metadata.db.execute("SELECT size FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key)).fetchone()
        return int(bucket["quota_bytes"]) - int(bucket["used_bytes"]) + (int(old["size"]) if old else 0) - reserved

    @staticmethod
    async def _within_quota(body: AsyncIterator[bytes] | Iterable[bytes] | bytes, room: int) -> AsyncIterator[bytes]:
        """大小未知的请求体边读边计数，超过剩余配额立即中止，不再继续写入后端。"""
        if isinstance(body, (bytes, bytearray)):
            body = [bytes(body)]
        total = 0
        if hasattr(body, "__aiter__"):
            async for chunk in body:  # type: ignore[union-attr]
                total += len(chunk)
                if total > room:
                    raise QuotaExceededError("存储桶配额不足")
                yield chunk
        else:
            for chunk in body:  # type: ignore[union-attr]
                total += len(chunk)
                if total > room:
                    raise QuotaExceededError("存储桶配额不足")
                yield chunk

    def _guard_quota(self, body, room: int | None, size: int | None):
        # 提交时仍会在事务内复核；这里的预检只是避免把注定失败的数据先写进 Telegram。
        if room is None:
            return body
        if size is not None and size > room:
            raise QuotaExceededError("存储桶配额不足")
        return self._within_quota(body, room)

    async def put_object(self, scope: Scope, key: str, body: AsyncIterator[bytes] | Iterable[bytes] | bytes,
                         size: int | None = None, content_type: str | None = None,
                         user_meta: dict[str, str] | None = None, *, expect_md5: str | None = None) -> ObjectInfo:
        self._check_scope(scope, key, write=True)
        body = self._guard_quota(body, self._quota_room(scope.bucket_id, key), size)
        blob_uuid = self.engine.begin_blob()
        try:
            result = await self.engine.put_part(blob_uuid, 1, body, bucket_id=scope.bucket_id)
            if size is not None and result.size != size:
                raise ValueError("object size does not match request")
            if expect_md5 is not None and result.md5.lower() != expect_md5.lower():
                raise ValueError("object MD5 does not match request")
            self.engine.finalize(blob_uuid, [1])
            if result.size:
                self.metadata.set_fingerprint(blob_uuid, combine(result.size, result.leaves))
            return self._commit_blob(scope.bucket_id, key, blob_uuid, result.size, result.md5,
                                     content_type, user_meta)
        except Exception:
            # 已写入后端的分片由 orphan cleanup/GC 处理；元数据中的临时 blob 可立即入队。
            try:
                await self.engine.delete(blob_uuid)
            except Exception:
                pass
            raise

    MIN_PART_SIZE = 5 * 1024 * 1024  # S3 规定：除最后一段外每段至少 5 MiB

    def find_by_fingerprint(self, bucket_id: int, fingerprint: str, size: int, prefix: str = ""):
        """在同一个存储桶、调用者授权前缀内按内容指纹找一个现有对象；回收站内部前缀不参与。"""
        return self.metadata.db.execute(
            "SELECT o.* FROM objects o JOIN blobs b ON b.uuid = o.blob_uuid "
            "WHERE o.bucket_id = ? AND b.fingerprint = ? AND b.size = ? AND b.status = 'complete' "
            "AND substr(o.key, 1, ?) = ? AND o.key NOT LIKE '.tgdrive/%' ORDER BY o.modified_at DESC LIMIT 1",
            (bucket_id, fingerprint, size, len(prefix), prefix)).fetchone()

    def instant_put(self, scope: Scope, key: str, size: int, fingerprint: str,
                    content_type: str | None = None) -> ObjectInfo | None:
        """秒传：同一存储桶里已有内容指纹相同的对象时，让新路径直接引用它的加密 Blob，不传输任何数据。

        只在调用者自己的存储桶内查找，因此不会泄露其他用户是否保存过某个文件。未命中返回 None。
        """
        self._check_scope(scope, key, write=True)
        if not is_fingerprint(fingerprint) or size <= 0:
            raise ValueError("无效的内容指纹或文件大小")
        source = self.find_by_fingerprint(scope.bucket_id, fingerprint, size, scope.prefix)
        if source is None:
            return None
        return self._commit_blob(scope.bucket_id, key, source["blob_uuid"], source["size"], source["etag"],
                                 content_type if content_type else source["content_type"],
                                 json.loads(source["user_meta"] or "{}"))

    async def put_directory_marker(self, scope: Scope, key: str) -> ObjectInfo:
        return self._write_directory_marker(scope, key)

    def _write_directory_marker(self, scope: Scope, key: str) -> ObjectInfo:
        if not key.endswith("/"):
            key += "/"
        self._check_scope(scope, key, write=True)
        self._bucket(scope.bucket_id)
        now = time.time()
        with self.metadata.transaction() as db:
            old = db.execute("SELECT * FROM objects WHERE bucket_id = ? AND key = ?", (scope.bucket_id, key)).fetchone()
            db.execute("DELETE FROM objects WHERE bucket_id = ? AND key = ?", (scope.bucket_id, key))
            if old and old["blob_uuid"]:
                self._release_blob(db, old["blob_uuid"], now)
            old_size = old["size"] if old else 0
            # 文件夹的公开分享（令牌、有效期、密码、下载次数）保存在目录标记行上：重写标记时必须保留。
            share = [old[name] if old else None for name in ("public_token", "public_at", "public_expires_at", "public_password")]
            downloads = old["public_downloads"] if old else 0
            db.execute("INSERT INTO objects(bucket_id,key,blob_uuid,size,etag,content_type,user_meta,modified_at,"
                       "public_token,public_at,public_expires_at,public_password,public_downloads) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (scope.bucket_id, key, None, 0, hashlib.md5(b"").hexdigest(), "application/x-directory", "{}", now, *share, downloads))
            db.execute("UPDATE buckets SET used_bytes = used_bytes - ? WHERE id = ?", (old_size, scope.bucket_id))
        return self._object(self.metadata.db.execute("SELECT * FROM objects WHERE bucket_id=? AND key=?",
                                                      (scope.bucket_id, key)).fetchone())

    async def get_object(self, scope: Scope, key: str, start: int = 0, end: int | None = None):
        row = self._lookup(scope, key)
        info = self._object(row)
        if info.blob_uuid is None:
            async def empty():
                if False:
                    yield b""
            return info, empty()
        return info, self.engine.stream(info.blob_uuid, start, end, bucket_id=scope.bucket_id)

    def head_object(self, scope: Scope, key: str) -> ObjectInfo:
        return self._object(self._lookup(scope, key))

    def set_public(self, scope: Scope, key: str, public: bool) -> ObjectInfo:
        """开启或关闭对象的公开链接；重复开启返回同一个令牌。"""
        if key.endswith("/"):
            # 文件夹的分享信息保存在它的目录标记行上；只靠前缀存在的“隐式文件夹”先补一个标记。
            self._check_scope(scope, key, write=True)
            marker = self.metadata.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key)).fetchone()
            if marker is None:
                if not self.metadata.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>? AND key<? LIMIT 1",
                                                (scope.bucket_id, key, key + self._PREFIX_END)).fetchone():
                    raise NotFoundError(key)
                self._write_directory_marker(scope, key)
        row = self._lookup(scope, key, write=True)
        if public and row["public_token"] is None:
            with self.metadata.transaction() as db:
                db.execute("UPDATE objects SET public_token=?, public_at=?, public_downloads=0 WHERE bucket_id=? AND key=?",
                           (secrets.token_urlsafe(12), time.time(), scope.bucket_id, key))
        elif not public and row["public_token"] is not None:
            with self.metadata.transaction() as db:
                db.execute("UPDATE objects SET public_token=NULL, public_at=NULL, public_expires_at=NULL, public_password=NULL, "
                           "public_downloads=0 WHERE bucket_id=? AND key=?", (scope.bucket_id, key))
        return self.head_object(scope, key)

    _UNSET = object()

    def update_share(self, scope: Scope, key: str, *, expires_at=_UNSET, password=_UNSET, password_hash=_UNSET) -> ObjectInfo:
        """设置分享有效期（None 为永久）与访问密码（None 或空字符串为取消）。只对已公开的文件有效。"""
        row = self._lookup(scope, key, write=True)
        if row["public_token"] is None:
            raise ValueError("文件尚未公开分享")
        updates, args = [], []
        if expires_at is not self._UNSET:
            if expires_at is not None and float(expires_at) <= time.time():
                raise ValueError("有效期必须晚于当前时间")
            updates.append("public_expires_at=?")
            args.append(None if expires_at is None else float(expires_at))
        if password is not self._UNSET:
            if password and len(str(password)) < 4:
                raise ValueError("访问密码至少 4 个字符")
            from .authn import hash_password
            updates.append("public_password=?")
            args.append(password_hash if password_hash is not self._UNSET else hash_password(str(password), min_length=4) if password else None)
        if updates:
            with self.metadata.transaction() as db:
                db.execute(f"UPDATE objects SET {', '.join(updates)} WHERE bucket_id=? AND key=?", (*args, scope.bucket_id, key))
        return self.head_object(scope, key)

    def count_public_download(self, bucket_id: int, key: str) -> None:
        with self.metadata.transaction() as db:
            db.execute("UPDATE objects SET public_downloads=public_downloads+1 WHERE bucket_id=? AND key=?", (bucket_id, key))

    # ---------- 缩略图（存于 user_meta，随移动/复制保留，覆盖内容后失效） ----------

    THUMBNAIL_META = "tgdrive-thumbnail"
    MAX_THUMBNAIL = 96 * 1024

    def set_thumbnail(self, scope: Scope, key: str, data: bytes) -> None:
        if len(data) > self.MAX_THUMBNAIL:
            raise ValueError("缩略图过大")
        if not (data.startswith(b"\xff\xd8\xff") or data.startswith(b"\x89PNG") or data[8:12] == b"WEBP"):
            raise ValueError("缩略图必须是 JPEG、PNG 或 WebP")
        row = self._lookup(scope, key, write=True)
        meta = json.loads(row["user_meta"] or "{}")
        meta[self.THUMBNAIL_META] = base64.b64encode(data).decode()
        with self.metadata.transaction() as db:
            db.execute("UPDATE objects SET user_meta=? WHERE bucket_id=? AND key=?",
                       (json.dumps(meta, separators=(",", ":")), scope.bucket_id, key))

    def get_thumbnail(self, scope: Scope, key: str) -> tuple[bytes, str]:
        info = self._object(self._lookup(scope, key))
        value = info.user_meta.get(self.THUMBNAIL_META)
        if not value:
            raise NotFoundError("thumbnail not found")
        return base64.b64decode(value), info.etag

    # ---------- 回收站：条目以 .tgdrive/trash/<id>/<原路径> 保存，仍计入容量 ----------

    TRASH_PREFIX = ".tgdrive/trash/"
    TRASH_DAYS = 30

    async def trash(self, scope: Scope, keys: list[str]) -> list[dict[str, object]]:
        entries = []
        for key in keys:
            folder = key.endswith("/")
            if key.startswith(".tgdrive/"):
                raise PermissionError("reserved path")
            stats = self.metadata.db.execute(
                "SELECT COUNT(*), COALESCE(SUM(size),0) FROM objects WHERE bucket_id=? AND "
                + ("key>=? AND key<?" if folder else "key=?"),
                (scope.bucket_id, key, key + self._PREFIX_END) if folder else (scope.bucket_id, key)).fetchone()
            if not stats[0]:
                raise NotFoundError(key)
            entry_id = f"{int(time.time() * 1000)}-{secrets.token_hex(3)}"
            target = f"{self.TRASH_PREFIX}{entry_id}/{key}"
            self.move(scope, key, target, "overwrite")
            if folder and not self.metadata.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, target)).fetchone():
                # 没有目录标记的“隐式”文件夹在回收站中补一个标记，恢复时才能得到完整的文件夹。
                # 已有标记时不能覆盖：公开分享信息（令牌、有效期、密码）保存在标记行上，还原后链接要恢复。
                await self.put_directory_marker(scope, target)
            with self.metadata.transaction() as db:
                db.execute("INSERT INTO trash(id,bucket_id,original_path,is_folder,size,item_count,deleted_at) VALUES(?,?,?,?,?,?,?)",
                           (entry_id, scope.bucket_id, key, int(folder), int(stats[1]), int(stats[0]), time.time()))
            entries.append({"id": entry_id, "path": key})
        return entries

    def list_trash(self, bucket_id: int) -> list[dict[str, object]]:
        rows = self.metadata.db.execute("SELECT * FROM trash WHERE bucket_id=? ORDER BY deleted_at DESC", (bucket_id,))
        return [{"id": row["id"], "path": row["original_path"], "is_folder": bool(row["is_folder"]), "size": row["size"],
                 "item_count": row["item_count"], "deleted_at": row["deleted_at"],
                 "purge_at": row["deleted_at"] + self.TRASH_DAYS * 86400} for row in rows]

    def _trash_row(self, bucket_id: int, entry_id: str):
        row = self.metadata.db.execute("SELECT * FROM trash WHERE bucket_id=? AND id=?", (bucket_id, entry_id)).fetchone()
        if row is None:
            raise NotFoundError("trash entry not found")
        return row

    def restore(self, scope: Scope, entry_ids: list[str]) -> list[dict[str, object]]:
        """还原到原位置；原位置已有同名文件时自动改名保留两者。"""
        restored = []
        for entry_id in entry_ids:
            row = self._trash_row(scope.bucket_id, entry_id)
            source = f"{self.TRASH_PREFIX}{entry_id}/{row['original_path']}"
            self.move(scope, source, row["original_path"], "rename")
            with self.metadata.transaction() as db:
                db.execute("DELETE FROM trash WHERE id=?", (entry_id,))
            restored.append({"id": entry_id, "path": row["original_path"]})
        return restored

    async def purge_trash(self, scope: Scope, entry_ids: list[str] | None = None) -> int:
        """永久删除回收站条目；entry_ids 为 None 时清空整个回收站。"""
        if entry_ids is None:
            total = 0
            while True:
                ids = [row["id"] for row in self.metadata.db.execute(
                    "SELECT id FROM trash WHERE bucket_id=? ORDER BY deleted_at,id LIMIT 100", (scope.bucket_id,))]
                if not ids:
                    return total
                total += await self.purge_trash(scope, ids)
                await asyncio.sleep(0)
        for entry_id in entry_ids:
            self._trash_row(scope.bucket_id, entry_id)
            await self.delete_prefix(scope, f"{self.TRASH_PREFIX}{entry_id}/")
            with self.metadata.transaction() as db:
                db.execute("DELETE FROM trash WHERE id=?", (entry_id,))
        return len(entry_ids)

    async def purge_expired_trash(self, now: float | None = None) -> int:
        cutoff = (time.time() if now is None else now) - self.TRASH_DAYS * 86400
        # 单次调度有界，剩余条目留给下一轮，避免过期条目积压时占满整个维护周期。
        rows = self.metadata.db.execute(
            "SELECT id,bucket_id FROM trash WHERE deleted_at<? ORDER BY deleted_at,id LIMIT 100", (cutoff,)).fetchall()
        for row in rows:
            await self.purge_trash(Scope(row["bucket_id"]), [row["id"]])
        return len(rows)

    async def purge_bucket(self, bucket_id: int) -> int:
        """删除存储桶中的全部对象与未完成的分段上传（用于删除用户）。返回删除的对象数。"""
        scope = Scope(bucket_id)
        deleted = 0
        while True:
            keys = [row["key"] for row in self.metadata.db.execute(
                "SELECT key FROM objects WHERE bucket_id=? ORDER BY key LIMIT 1000", (bucket_id,))]
            if not keys:
                break
            deleted += sum(item.deleted for item in await self.delete_objects(scope, keys))
        now = time.time()
        with self.metadata.transaction() as db:
            for row in db.execute("SELECT upload_id, blob_uuid FROM uploads WHERE bucket_id=?", (bucket_id,)).fetchall():
                db.execute("DELETE FROM uploads WHERE upload_id=?", (row["upload_id"],))
                if db.execute("SELECT 1 FROM blobs WHERE uuid=? AND status='uploading'", (row["blob_uuid"],)).fetchone():
                    refs = [r[0] for r in db.execute("SELECT blob_ref FROM chunks WHERE blob_uuid=?", (row["blob_uuid"],))]
                    db.executemany("INSERT INTO gc_queue(blob_ref,enqueued_at) VALUES(?,?)", ((ref, now) for ref in refs))
                    db.execute("DELETE FROM blobs WHERE uuid=?", (row["blob_uuid"],))
            db.execute("DELETE FROM trash WHERE bucket_id=?", (bucket_id,))
        return deleted

    def list_public(self, bucket_id: int, limit: int = 1000) -> list[ObjectInfo]:
        self._bucket(bucket_id)
        rows = self.metadata.db.execute(
            "SELECT * FROM objects WHERE bucket_id=? AND public_token IS NOT NULL ORDER BY public_at DESC LIMIT ?",
            (bucket_id, limit))
        return [self._object(row) for row in rows]

    def resolve_public(self, token: str) -> ObjectInfo:
        """按公开令牌查找对象；所属账号被禁用时链接一并失效。"""
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", token or ""):
            raise NotFoundError("public link not found")
        row = self.public_row(token)
        if row["public_expires_at"] is not None and row["public_expires_at"] <= time.time():
            raise ShareExpiredError("public link has expired")
        return self._object(row)

    def public_row(self, token: str):
        """原始行（含密码哈希）。回收站中的文件与被禁用账号的文件不可访问。"""
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", token or ""):
            raise NotFoundError("public link not found")
        row = self.metadata.db.execute(
            "SELECT o.* FROM objects o LEFT JOIN users u ON u.bucket_id=o.bucket_id "
            "WHERE o.public_token=? AND (u.id IS NULL OR u.status='active') AND substr(o.key,1,9)!='.tgdrive/'", (token,)).fetchone()
        if row is None:
            raise NotFoundError("public link not found")
        return row

    @staticmethod
    def _public_relative(value: str) -> str:
        """分享文件夹内的相对路径：不允许绝对路径、.、..、空段与控制字符，防止越出被分享的目录。"""
        value = unicodedata.normalize("NFC", value or "")
        if value.startswith("/") or "\x00" in value or any(ord(ch) < 32 for ch in value):
            raise ValueError("invalid path")
        if value and any(part in ("", ".", "..") for part in value.rstrip("/").split("/")):
            raise ValueError("invalid path")
        return value

    def _public_folder_root(self, token: str) -> ObjectInfo:
        info = self.resolve_public(token)
        if not info.key.endswith("/"):
            raise NotFoundError("not a shared folder")
        return info

    async def list_public_folder(self, token: str, relative: str = "", cursor: str | None = None, limit: int = 200) -> dict[str, object]:
        """列出被公开的文件夹（或其中的子文件夹）。内容是实时的：分享之后新增的文件访客也能看到。"""
        root = self._public_folder_root(token)
        relative = self._public_relative(relative)
        if relative and not relative.endswith("/"):
            relative += "/"
        prefix = root.key + relative
        scope = Scope(root.bucket_id, root.key)
        def read_page():
            page = self.list_objects(scope, prefix, "/", cursor, max(1, min(limit, 500)))
            return page, self.folder_sizes(scope, page.common_prefixes)
        page, sizes = await self.metadata.run_in_thread(read_page)
        files = [{"name": item.key[len(prefix):], "path": item.key[len(root.key):], "size": item.size, "content_type": item.content_type,
                  "etag": item.etag, "modified_at": item.modified_at}
                 for item in page.objects if item.key != prefix and not item.key.endswith("/")]
        folders = [{"name": value[len(prefix):].rstrip("/"), "path": value[len(root.key):], "size": sizes[value]}
                   for value in page.common_prefixes]
        if relative and not files and not folders and cursor is None and not self.metadata.db.execute(
                "SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (root.bucket_id, prefix)).fetchone():
            raise NotFoundError(relative)
        return {"name": root.key.rstrip("/").rsplit("/", 1)[-1], "path": relative, "folders": folders, "files": files,
                "next_cursor": page.next_cursor}

    def public_folder_file(self, token: str, relative: str) -> tuple[ObjectInfo, ObjectInfo]:
        """返回 (文件夹分享根, 文件信息)；路径必须落在被分享的文件夹内，且指向一个文件。"""
        root = self._public_folder_root(token)
        relative = self._public_relative(relative)
        if not relative or relative.endswith("/"):
            raise NotFoundError(relative)
        return root, self.head_object(Scope(root.bucket_id), root.key + relative)

    async def get_public_object(self, token: str, start: int = 0, end: int | None = None):
        info = self.resolve_public(token)
        return await self.get_object(Scope(info.bucket_id), info.key, start, end)

    def _delete_objects_sync(self, scope: Scope, keys: list[str]) -> list[DeleteResult]:
        self._check_scope(scope, keys[0], write=True) if keys else None
        results: list[DeleteResult] = []
        now = time.time()
        with self.metadata.transaction() as db:
            for key in keys:
                self._check_scope(scope, key, write=True)
                row = db.execute("SELECT * FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key)).fetchone()
                if row is None:
                    results.append(DeleteResult(key, False))
                    continue
                if row["blob_uuid"]:
                    db.execute("DELETE FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key))
                    self._release_blob(db, row["blob_uuid"], now)
                else:
                    db.execute("DELETE FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key))
                db.execute("UPDATE buckets SET used_bytes = used_bytes - ? WHERE id=?", (row["size"], scope.bucket_id))
                results.append(DeleteResult(key, True))
        return results

    async def delete_objects(self, scope: Scope, keys: list[str]) -> list[DeleteResult]:
        return await self.metadata.run_in_thread(self._delete_objects_sync, scope, keys)

    # 跳过一个公共前缀下全部键时使用的上界：U+10FFFF 是最大码点，按 SQLite 二进制排序大于该前缀下的任何键。
    _PREFIX_END = "\U0010ffff"

    def folder_sizes(self, scope: Scope, prefixes: list[str]) -> dict[str, int]:
        """只汇总当前页目录下的原始文件大小；由桶和路径范围限制查询，不读取文件内容。"""
        prefixes = list(dict.fromkeys(prefixes))
        for prefix in prefixes:
            self._check_scope(scope, prefix)
            if not prefix.endswith("/"):
                raise ValueError("folder path must end with /")
        if not prefixes:
            return {}
        def read():
            sizes: dict[str, int] = {}
            # 限制 SQL 参数数量；范围连接使用已有的桶 / 键索引，隐式目录和空目录也能统计。
            for start in range(0, len(prefixes), 200):
                batch = prefixes[start:start + 200]
                values = ",".join("(?,?)" for _ in batch)
                params = [value for prefix in batch for value in (prefix, prefix + self._PREFIX_END)]
                rows = self.metadata.db.execute(
                    f"WITH folders(prefix,upper_key) AS (VALUES {values}) "
                    "SELECT f.prefix,COALESCE(SUM(o.size),0) AS size FROM folders f "
                    "LEFT JOIN objects o ON o.bucket_id=? AND o.key>f.prefix AND o.key<f.upper_key "
                    "AND substr(o.key,-1)!='/' GROUP BY f.prefix", (*params, scope.bucket_id))
                sizes.update((row["prefix"], int(row["size"])) for row in rows)
            return sizes
        return self.metadata.cached_read(("folder-sizes", scope.bucket_id, tuple(prefixes)), read)

    async def delete_prefix(self, scope: Scope, prefix: str, *, batch: int = 1000) -> int:
        """删除前缀下的全部对象（含目录标记），按批提交，避免长时间占用写锁。返回删除数量。"""
        if not prefix.endswith("/"):
            raise ValueError("folder path must end with /")
        self._check_scope(scope, prefix, write=True)
        deleted = 0
        while True:
            def read_keys():
                return [row["key"] for row in self.metadata.db.execute(
                    "SELECT key FROM objects WHERE bucket_id=? AND key>=? AND key<? ORDER BY key LIMIT ?",
                    (scope.bucket_id, prefix, prefix + self._PREFIX_END, batch))]
            keys = await self.metadata.run_in_thread(read_keys)
            if not keys:
                return deleted
            results = await self.metadata.run_in_thread(self._delete_objects_sync, scope, keys)
            deleted += sum(result.deleted for result in results)

    def list_objects(self, scope: Scope, prefix: str = "", delimiter: str | None = "/",
                     cursor: str | None = None, limit: int = 1000) -> ListPage:
        """按键有序分页列出对象；遇到公共前缀直接跳过其子树，扫描量与返回量成正比，而非与桶大小成正比。"""
        if limit <= 0:
            raise ValueError("limit must be positive")
        effective = prefix if prefix else scope.prefix
        if not effective.startswith(scope.prefix):
            raise PermissionError("prefix is outside scope")
        self._bucket(scope.bucket_id)
        objects: list[ObjectInfo] = []
        common: list[str] = []
        last_position: str | None = None
        position, inclusive = (cursor, False) if cursor is not None and cursor >= effective else (effective, True)
        batch = min(limit + 1, 500)
        while len(objects) + len(common) <= limit:
            rows = self.metadata.db.execute(
                f"SELECT * FROM objects WHERE bucket_id=? AND key {'>=' if inclusive else '>'} ? ORDER BY key LIMIT ?",
                (scope.bucket_id, position, batch)).fetchall()
            if not rows:
                break
            jumped = False
            for row in rows:
                key = row["key"]
                if not key.startswith(effective):
                    # 已越过前缀范围，后面的键都不属于本次列表。
                    rows = []
                    break
                if key.startswith(".tgdrive/") and not effective.startswith(".tgdrive/"):
                    # 系统保留区（回收站）不出现在普通列表中，直接跳过整个子树。
                    position, inclusive, jumped = ".tgdrive/" + self._PREFIX_END, False, True
                    break
                if len(objects) + len(common) == limit:
                    # 已凑满一页且确认还有下一项：以最后返回的位置作为游标。
                    return ListPage(objects, common, last_position)
                rest = key[len(effective):]
                pos = rest.find(delimiter) if delimiter else -1
                if pos >= 0:
                    value = effective + rest[:pos + len(delimiter)]
                    common.append(value)
                    last_position = value + self._PREFIX_END
                    position, inclusive, jumped = last_position, False, True
                    break
                objects.append(self._object(row))
                last_position = key
                position, inclusive = key, False
            if not rows or (not jumped and len(rows) < batch):
                break
        return ListPage(objects, common, None)

    async def alist_objects(self, scope: Scope, prefix: str = "", delimiter: str | None = "/",
                            cursor: str | None = None, limit: int = 1000) -> ListPage:
        """在线程池中执行列表查询，避免大目录扫描占用 ASGI 事件循环。"""
        return await self.metadata.run_in_thread(self.list_objects, scope, prefix, delimiter, cursor, limit)

    async def copy_object(self, src: Scope, src_key: str, dst: Scope, dst_key: str,
                          *, metadata: dict[str, str] | None = None, content_type: str | None = None) -> ObjectInfo:
        """服务端复制：新对象引用同一个加密 Blob，不搬运数据；目标的公开链接按覆盖写入规则保留。"""
        source = self._lookup(src, src_key)
        self._check_scope(dst, dst_key, write=True)
        if source["blob_uuid"] is None:
            return await self.put_directory_marker(dst, dst_key)
        return self._commit_blob(dst.bucket_id, dst_key, source["blob_uuid"], source["size"], source["etag"],
                                 content_type if content_type is not None else source["content_type"],
                                 metadata if metadata is not None else json.loads(source["user_meta"] or "{}"))

    def move_prefix(self, scope: Scope, old: str, new: str, conflict: str = "skip") -> int:
        return self.move(scope, old, new, conflict).moved

    def move(self, scope: Scope, old: str, new: str, conflict: str = "skip") -> MoveResult:
        """移动单个文件（old 不以 / 结尾，精确匹配）或整个文件夹（old 以 / 结尾，前缀匹配）。

        文件夹之间的同名目录标记直接合并；文件冲突按 conflict 处理，skip 时计入 skipped。
        """
        if scope.perms != "rw":
            raise PermissionError("scope is read-only")
        if not old or not new or not old.startswith(scope.prefix) or not new.startswith(scope.prefix):
            raise PermissionError("prefix is outside scope")
        self._bucket(scope.bucket_id)
        if conflict not in ("skip", "overwrite", "rename"):
            raise ValueError("conflict must be skip, overwrite or rename")
        folder = old.endswith("/")
        if folder != new.endswith("/"):
            raise ValueError("文件和文件夹不能互相移动")
        if folder and new.startswith(old):
            raise ValueError("不能把文件夹移动到它自己或它的子文件夹中")
        if old == new:
            return MoveResult(0, 0)
        with self.metadata.transaction() as db:
            rows = [r for r in db.execute("SELECT * FROM objects WHERE bucket_id=? AND key>=? ORDER BY key",
                                          (scope.bucket_id, old))
                    if (r["key"].startswith(old) if folder else r["key"] == old)]
            if not rows:
                raise NotFoundError(old)
            moving = {r["key"] for r in rows}
            moves: list[tuple[str, str]] = []
            skipped = 0
            now = time.time()
            for row in rows:
                target = new + row["key"][len(old):]
                existing = db.execute("SELECT * FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, target)).fetchone()
                if existing and existing["key"] not in moving:
                    if row["key"].endswith("/") and row["blob_uuid"] is None:
                        # 目标位置已有同名文件夹：合并，丢弃源目录标记。
                        db.execute("DELETE FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, row["key"]))
                        continue
                    if conflict == "skip":
                        skipped += 1
                        continue
                    if conflict == "overwrite":
                        db.execute("DELETE FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, target))
                        if existing["blob_uuid"]:
                            self._release_blob(db, existing["blob_uuid"], now)
                        db.execute("UPDATE buckets SET used_bytes = used_bytes - ? WHERE id=?",
                                   (existing["size"], scope.bucket_id))
                    else:
                        target = self._free_name(db, scope.bucket_id, target, {t for _, t in moves})
                moves.append((row["key"], target))
            token = f"\x01tgdrive-move-{secrets.token_hex(8)}"
            for old_key, _ in moves:
                db.execute("UPDATE objects SET key=? WHERE bucket_id=? AND key=?", (token + old_key, scope.bucket_id, old_key))
            for old_key, target in moves:
                db.execute("UPDATE objects SET key=? WHERE bucket_id=? AND key=?", (target, scope.bucket_id, token + old_key))
            return MoveResult(len(moves), skipped)

    @staticmethod
    def _free_name(db, bucket_id: int, target: str, reserved: set[str]) -> str:
        """为 rename 冲突策略生成 “名称 (n).扩展名”，直到不与现有对象重名。"""
        directory, slash, name = target.rpartition("/")
        base, dot, ext = name.rpartition(".")
        if not dot or not base:
            base, dot, ext = name, "", ""
        for n in range(1, 10000):
            candidate = f"{directory}{slash}{base} ({n}){dot}{ext}"
            if candidate not in reserved and db.execute(
                    "SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (bucket_id, candidate)).fetchone() is None:
                return candidate
        raise ValueError("无法为冲突文件生成新名称")

    async def create_multipart(self, scope: Scope, key: str, content_type: str | None = None,
                               user_meta: dict[str, str] | None = None) -> str:
        self._check_scope(scope, key, write=True)
        self._bucket(scope.bucket_id)
        upload_id, blob_uuid, now = secrets.token_urlsafe(24), self.engine.begin_blob(), time.time()
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO uploads(upload_id,bucket_id,key,blob_uuid,content_type,user_meta,created_at,last_activity) "
                       "VALUES(?,?,?,?,?,?,?,?)", (upload_id, scope.bucket_id, key, blob_uuid, content_type,
                                                    json.dumps(user_meta or {}, separators=(",", ":")), now, now))
        return upload_id

    def _upload(self, scope: Scope, upload_id: str):
        row = self.metadata.db.execute("SELECT * FROM uploads WHERE upload_id=? AND bucket_id=?",
                                       (upload_id, scope.bucket_id)).fetchone()
        if row is None:
            raise NotFoundError("upload not found")
        self._check_scope(scope, row["key"], write=True)
        return row

    async def upload_part(self, scope: Scope, upload_id: str, part_no: int,
                          body: AsyncIterator[bytes] | Iterable[bytes] | bytes, size: int | None = None) -> PartInfo:
        row = self._upload(scope, upload_id)
        # 同一次分段上传中其他分段已占用的大小也计入预检。
        others = self.metadata.db.execute("SELECT COALESCE(SUM(size),0) FROM upload_parts WHERE upload_id=? AND part_no!=?",
                                          (upload_id, part_no)).fetchone()[0]
        body = self._guard_quota(body, self._quota_room(scope.bucket_id, row["key"], reserved=int(others)), size)
        result = await self.engine.put_part(row["blob_uuid"], part_no, body, bucket_id=scope.bucket_id)
        if size is not None and size != result.size:
            raise ValueError("part size does not match request")
        now = time.time()
        with self.metadata.transaction() as db:
            db.execute("INSERT OR REPLACE INTO upload_parts(upload_id,part_no,size,md5,uploaded_at,leaves) VALUES(?,?,?,?,?,?)",
                       (upload_id, part_no, result.size, result.md5, now, result.leaves))
            db.execute("UPDATE uploads SET last_activity=? WHERE upload_id=?", (now, upload_id))
        return PartInfo(upload_id, part_no, result.size, result.md5, now)

    def list_parts(self, scope: Scope, upload_id: str) -> list[PartInfo]:
        self._upload(scope, upload_id)
        rows = self.metadata.db.execute("SELECT * FROM upload_parts WHERE upload_id=? ORDER BY part_no", (upload_id,))
        return [PartInfo(upload_id, r["part_no"], r["size"], r["md5"], r["uploaded_at"]) for r in rows]

    async def complete_multipart(self, scope: Scope, upload_id: str, parts: list[tuple[int, str]]) -> ObjectInfo:
        upload = self._upload(scope, upload_id)
        if upload["completed_at"] is not None:
            return self.head_object(scope, upload["key"])
        if not parts or [p[0] for p in parts] != sorted(p[0] for p in parts) or len({p[0] for p in parts}) != len(parts):
            raise ValueError("InvalidPartOrder")
        records = {r["part_no"]: r for r in self.metadata.db.execute("SELECT * FROM upload_parts WHERE upload_id=?", (upload_id,))}
        for index, (number, etag) in enumerate(parts):
            if number not in records or records[number]["md5"].lower() != etag.strip('"').lower():
                raise ValueError("InvalidPart")
            if index < len(parts) - 1 and records[number]["size"] < self.MIN_PART_SIZE:
                raise ValueError("EntityTooSmall")
        blob_size = self.engine.finalize(upload["blob_uuid"], [p[0] for p in parts])
        # 只有除最后一段外每段大小都是指纹分块的整数倍时，各段的块边界才与整个文件对齐，才能由各段的
        # 块哈希拼出指纹；否则（例如 aws cli 默认 8 MB 分段）这个对象不参与秒传，也不需要重读数据。
        block = self.engine.fingerprint_block
        if blob_size and all(records[n]["leaves"] is not None for n, _ in parts) \
                and all(records[n]["size"] % block == 0 for n, _ in parts[:-1]):
            self.metadata.set_fingerprint(upload["blob_uuid"],
                                          combine(blob_size, b"".join(bytes(records[n]["leaves"]) for n, _ in parts)))
        combined = hashlib.md5(b"".join(bytes.fromhex(records[p[0]]["md5"]) for p in parts)).hexdigest() + f"-{len(parts)}"
        info = self._commit_blob(scope.bucket_id, upload["key"], upload["blob_uuid"], blob_size, combined,
                                 upload["content_type"], json.loads(upload["user_meta"] or "{}"))
        with self.metadata.transaction() as db:
            db.execute("UPDATE uploads SET completed_at=?, result_etag=? WHERE upload_id=?", (time.time(), combined, upload_id))
        return info

    async def abort_multipart(self, scope: Scope, upload_id: str) -> None:
        upload = self._upload(scope, upload_id)
        if upload["completed_at"] is not None:
            raise InvalidStateError("multipart upload is already complete")
        with self.metadata.transaction() as db:
            refs = [r[0] for r in db.execute("SELECT blob_ref FROM chunks WHERE blob_uuid=?", (upload["blob_uuid"],))]
            db.executemany("INSERT INTO gc_queue(blob_ref,enqueued_at) VALUES(?,?)",
                           ((ref, time.time()) for ref in refs))
            # 先删除引用 Blob 的上传记录，再删除 Blob，否则外键约束会让中止永远失败。
            db.execute("DELETE FROM uploads WHERE upload_id=?", (upload_id,))
            db.execute("DELETE FROM blobs WHERE uuid=?", (upload["blob_uuid"],))
