"""M3 对象服务：桶、对象、目录前缀和 S3 multipart 基础语义。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import secrets
import time
import unicodedata
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass, replace
from typing import Callable

from .blobengine import BlobEngine
from .errors import InvalidStateError, NotFoundError, QuotaExceededError, ShareExpiredError, VersionConflict
from .filekinds import kind_clause
from .fingerprint import combine, is_fingerprint
from .metadata import Metadata


PRIVATE_PREFIX = ".tgdrive/private/"
PRIVATE_TRASH_PREFIX = ".tgdrive/private-trash/"
log = logging.getLogger("tgdrive.objects")


@dataclass(frozen=True)
class Scope:
    bucket_id: int
    prefix: str = ""
    perms: str = "rw"
    private_access: bool = False
    authorize: Callable[[], None] | None = None
    thumbnail_client: bool = False
    # 后台读取（本机缓存整文件）：让出一个读取名额给播放和预览，不用小窗口起步。
    background: bool = False


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
        self.on_commit: Callable[[ObjectInfo, Scope | None], None] | None = None
        self.on_change: Callable[[int], None] | None = None
        self.thumbnail_service = None

    def _changed(self, bucket_id: int) -> None:
        if self.on_change is not None:
            try:
                self.on_change(bucket_id)
            except Exception as exc:
                log.debug("对象变更通知暂未投递：%s", type(exc).__name__)

    def _cache_upload(self, blob_uuid: str, key: str, content_type: str | None) -> None:
        if self.engine.thumbnail_cache is not None:
            self.engine.thumbnail_cache.prepare(blob_uuid, key, content_type)

    @staticmethod
    def _check_scope(scope: Scope, key: str, *, write: bool = False) -> None:
        if scope.authorize is not None:
            scope.authorize()
        protected = (PRIVATE_PREFIX, PRIVATE_TRASH_PREFIX)
        if not scope.private_access and (key.startswith(protected) or
                (key.endswith("/") and any(prefix.startswith(key) for prefix in protected))):
            raise PermissionError("私密空间需要单独解锁")
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

    def _release_blob(self, db, blob_uuid: str, now: float, bucket_id: int | None = None) -> None:
        """引用计数减一。bucket_id 是刚删掉引用的存储桶：该桶已不再引用这个 Blob 时，一并删除存在这个桶里的大缩略图。"""
        row = db.execute("SELECT refcount FROM blobs WHERE uuid = ?", (blob_uuid,)).fetchone()
        if row is None:
            return
        count = int(row["refcount"]) - 1
        if count > 0:
            db.execute("UPDATE blobs SET refcount = ? WHERE uuid = ?", (count, blob_uuid))
            if bucket_id is not None and not db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND blob_uuid=? LIMIT 1",
                                                        (bucket_id, blob_uuid)).fetchone():
                self._hand_over_thumbnails(db, blob_uuid, bucket_id, now)
            return
        self._drop_thumbnail_objects(db, blob_uuid, now)
        refs = [r[0] for r in db.execute("SELECT blob_ref FROM chunks WHERE blob_uuid = ?", (blob_uuid,))]
        db.executemany("INSERT INTO gc_queue(blob_ref,enqueued_at) VALUES(?,?)", ((ref, now) for ref in refs))
        # 已完成的分段上传记录仍引用该 Blob（用于幂等重试），必须先删除，否则外键约束会阻止删除和覆盖。
        db.execute("DELETE FROM uploads WHERE blob_uuid = ?", (blob_uuid,))
        db.execute("DELETE FROM blobs WHERE uuid = ?", (blob_uuid,))

    def _duplicate_blob(self, db, bucket_id: int, blob_uuid: str, size: int) -> str | None:
        """同一存储桶里已有内容指纹相同的完整 Blob 时返回它（写入后合并）：网页、离线下载、S3 与 API 上传都适用，
        重复内容只保留一份数据和一套缩略图。查找范围与秒传相同（含私密空间，不含回收站与系统区）。"""
        row = db.execute("SELECT fingerprint FROM blobs WHERE uuid=?", (blob_uuid,)).fetchone()
        if row is None or not row["fingerprint"]:
            return None
        match = db.execute(
            "SELECT o.blob_uuid FROM objects o JOIN blobs b ON b.uuid = o.blob_uuid "
            "WHERE o.bucket_id = ? AND b.fingerprint = ? AND b.size = ? AND b.status = 'complete' AND b.uuid != ? "
            "AND (substr(o.key,1,9)!='.tgdrive/' OR substr(o.key,1,?)=?) ORDER BY o.modified_at DESC LIMIT 1",
            (bucket_id, row["fingerprint"], size, blob_uuid, len(PRIVATE_PREFIX), PRIVATE_PREFIX)).fetchone()
        return match["blob_uuid"] if match else None

    def _commit_blob(self, bucket_id: int, key: str, blob_uuid: str, size: int, etag: str,
                     content_type: str | None, user_meta: dict[str, str] | None, *, scope: Scope | None = None,
                     dedupe: bool = False, if_match: str | None = None) -> ObjectInfo:
        """dedupe=True 用于刚写入的新 Blob：已有相同内容时改为引用那份，调用方随后删除新 Blob（返回对象的 blob_uuid 不同）。
        对象自己的 ETag 保持不变，S3 分段上传返回的 ETag 不受影响。"""
        now = time.time()
        meta_json = json.dumps(user_meta or {}, ensure_ascii=False, separators=(",", ":"))
        with self.metadata.transaction() as db:
            if dedupe:
                blob_uuid = self._duplicate_blob(db, bucket_id, blob_uuid, size) or blob_uuid
            bucket = db.execute("SELECT quota_bytes, used_bytes FROM buckets WHERE id = ?", (bucket_id,)).fetchone()
            if bucket is None:
                raise NotFoundError(f"bucket {bucket_id} not found")
            old = db.execute("SELECT * FROM objects WHERE bucket_id = ? AND key = ?", (bucket_id, key)).fetchone()
            # 条件写入：在提交事务内复核版本，与覆盖在同一事务完成，避免两次保存交错时互相覆盖。
            if if_match is not None and (old is None or old["etag"] != if_match):
                raise VersionConflict("文件已在别处修改")
            old_size = int(old["size"]) if old else 0
            new_used = int(bucket["used_bytes"]) - old_size + size
            if bucket["quota_bytes"] is not None and new_used > bucket["quota_bytes"]:
                raise QuotaExceededError("存储桶配额不足")
            db.execute("UPDATE blobs SET refcount = refcount + 1 WHERE uuid = ?", (blob_uuid,))
            db.execute("DELETE FROM objects WHERE bucket_id = ? AND key = ?", (bucket_id, key))
            if old and old["blob_uuid"]:
                self._release_blob(db, old["blob_uuid"], now, bucket_id)
            # 覆盖写入保留原公开链接，已分享的地址不会因为更新内容而失效。
            share = [old[name] if old else None for name in ("public_token", "public_at", "public_expires_at", "public_password")]
            downloads = old["public_downloads"] if old else 0
            db.execute("INSERT INTO objects(bucket_id,key,blob_uuid,size,etag,content_type,user_meta,modified_at,"
                       "public_token,public_at,public_expires_at,public_password,public_downloads) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (bucket_id, key, blob_uuid, size, etag, content_type, meta_json, now, *share, downloads))
            # 相对更新：释放旧 Blob 时可能顺带删除了该桶里的大缩略图，那部分已在上面扣减。
            db.execute("UPDATE buckets SET used_bytes = used_bytes - ? + ? WHERE id = ?", (old_size, size, bucket_id))
        row = self.metadata.db.execute("SELECT * FROM objects WHERE bucket_id = ? AND key = ?", (bucket_id, key)).fetchone()
        info = self._object(row)
        self._changed(bucket_id)
        if self.on_commit is not None:
            try:
                self.on_commit(info, scope)
            except Exception as exc:
                log.debug("对象已保存，后台通知暂未投递：%s", type(exc).__name__)
        return info

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
                         user_meta: dict[str, str] | None = None, *, expect_md5: str | None = None, small: bool = False,
                         if_match: str | None = None) -> ObjectInfo:
        """if_match：只在对象当前 ETag 等于它时覆盖（网页文本编辑保存用），否则抛 VersionConflict，不写入。"""
        self._check_scope(scope, key, write=True)
        if if_match is not None:
            # 先查一次，版本已变时不必上传；提交事务内还会再复核。
            current = self.metadata.db.execute("SELECT etag FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key)).fetchone()
            if current is None or current["etag"] != if_match:
                raise VersionConflict("文件已在别处修改")
        room = self._quota_room(scope.bucket_id, key)
        if small:
            # 系统小对象已整块在内存里，大小已知：直接比较剩余配额（提交时事务内仍会复核）。
            if room is not None and len(body) > room:  # type: ignore[arg-type]
                raise QuotaExceededError("存储桶配额不足")
        else:
            body = self._guard_quota(body, room, size)
        blob_uuid = self.engine.begin_blob()
        self._cache_upload(blob_uuid, key, content_type)
        try:
            result = await self.engine.put_part(blob_uuid, 1, body, bucket_id=scope.bucket_id, small=small)
            if size is not None and result.size != size:
                raise ValueError("object size does not match request")
            if expect_md5 is not None and result.md5.lower() != expect_md5.lower():
                raise ValueError("object MD5 does not match request")
            self.engine.finalize(blob_uuid, [1])
            if result.size:
                self.metadata.set_fingerprint(blob_uuid, combine(result.size, result.leaves))
            self._check_scope(scope, key, write=True)
            info = self._commit_blob(scope.bucket_id, key, blob_uuid, result.size, result.md5,
                                     content_type, user_meta, scope=scope, dedupe=not small, if_match=if_match)
        except Exception:
            # 已写入后端的分片由 orphan cleanup/GC 处理；元数据中的临时 blob 可立即入队。
            try:
                await self.engine.delete(blob_uuid)
            except Exception:
                pass
            raise
        if info.blob_uuid != blob_uuid:
            await self.engine.delete(blob_uuid)  # 内容与已有文件相同：只保留原来那份数据与缩略图
        return info

    MIN_PART_SIZE = 5 * 1024 * 1024  # S3 规定：除最后一段外每段至少 5 MiB

    def find_by_fingerprint(self, bucket_id: int, fingerprint: str, size: int, prefix: str = "", *, private_access=False):
        """在同一个存储桶、调用者授权前缀内按内容指纹找一个现有对象；回收站内部前缀不参与。"""
        return self.metadata.db.execute(
            "SELECT o.* FROM objects o JOIN blobs b ON b.uuid = o.blob_uuid "
            "WHERE o.bucket_id = ? AND b.fingerprint = ? AND b.size = ? AND b.status = 'complete' "
            "AND substr(o.key, 1, ?) = ? AND (substr(o.key,1,9)!='.tgdrive/' OR "
            "(?=1 AND substr(o.key,1,?)=?)) ORDER BY o.modified_at DESC LIMIT 1",
            (bucket_id, fingerprint, size, len(prefix), prefix, int(private_access), len(PRIVATE_PREFIX), PRIVATE_PREFIX)).fetchone()

    def instant_put(self, scope: Scope, key: str, size: int, fingerprint: str,
                    content_type: str | None = None) -> ObjectInfo | None:
        """秒传：同一存储桶里已有内容指纹相同的对象时，让新路径直接引用它的加密 Blob，不传输任何数据。

        只在调用者自己的存储桶内查找，因此不会泄露其他用户是否保存过某个文件。未命中返回 None。
        """
        self._check_scope(scope, key, write=True)
        if not is_fingerprint(fingerprint) or size <= 0:
            raise ValueError("无效的内容指纹或文件大小")
        source = self.find_by_fingerprint(scope.bucket_id, fingerprint, size, scope.prefix, private_access=scope.private_access)
        if source is None:
            return None
        return self._commit_blob(scope.bucket_id, key, source["blob_uuid"], source["size"], source["etag"],
                                 content_type if content_type else source["content_type"],
                                 json.loads(source["user_meta"] or "{}"), scope=scope)

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
                self._release_blob(db, old["blob_uuid"], now, scope.bucket_id)
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
        if self.thumbnail_service is not None and self.thumbnail_service.wants_data(info):
            self._cache_upload(info.blob_uuid, key, info.content_type)
            self.thumbnail_service.observe(info, client=scope.thumbnail_client)
        return info, self.engine.stream(info.blob_uuid, start, end, bucket_id=scope.bucket_id, background=scope.background)

    def head_object(self, scope: Scope, key: str) -> ObjectInfo:
        return self._object(self._lookup(scope, key))

    def set_public(self, scope: Scope, key: str, public: bool) -> ObjectInfo:
        """开启或关闭对象的公开链接；重复开启返回同一个令牌。"""
        if public and key.startswith((PRIVATE_PREFIX, PRIVATE_TRASH_PREFIX)):
            raise PermissionError("私密空间不能公开分享")
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

    # ---------- 缩略图（按 Blob 保存：移动、复制、秒传自动共享，覆盖内容后自然失效） ----------
    # thumb：列表小图（约 160px）、grid：网格图（约 640px）与 poster：预览封面（约 960px）都存为系统区对象
    # .tgdrive/thumbnails/<blob>/<规格>，计入所在存储桶的配额，表中只记录存储桶与键。该桶不再引用源文件时，
    # 转交给另一个仍引用它的存储桶；没有其他引用时删除。旧版内联在 data 列里的图片（加密）由维护任务分批转存。

    THUMBNAIL_META = "tgdrive-thumbnail"  # 旧版存放位置，仅用于从 user_meta 中剔除
    THUMBNAIL_PREFIX = ".tgdrive/thumbnails/"
    THUMBNAIL_LIMITS = {"thumb": 96 * 1024, "grid": 160 * 1024, "poster": 320 * 1024}
    STORED_THUMBNAILS = frozenset({"thumb", "grid", "poster"})
    # 请求的规格不存在时依次退回：网格图与封面互为替代，最后用列表小图。
    THUMBNAIL_FALLBACK = {"thumb": ("thumb",), "grid": ("grid", "poster", "thumb"), "poster": ("poster", "grid", "thumb")}

    @staticmethod
    def _thumbnail_revision(created_at: float | None) -> str:
        # 使用微秒版本，重新生成同一文件的封面时也能更新缓存；旧版图片首次转存后会获得新版本。
        return str(int(created_at * 1_000_000)) if created_at is not None else "legacy"

    @staticmethod
    def _thumbnail_mime(data: bytes) -> str:
        if data.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return "image/webp"
        raise ValueError("缩略图必须是 JPEG、PNG 或 WebP")

    def _thumbnail_blob(self, scope: Scope, key: str, *, write: bool = False) -> tuple[ObjectInfo, str]:
        info = self._object(self._lookup(scope, key, write=write))
        if key.endswith("/") or not info.blob_uuid:
            raise ValueError("只有文件可以设置缩略图")
        return info, info.blob_uuid

    def _drop_thumbnail_objects(self, db, blob_uuid: str, now: float, bucket_id: int | None = None) -> None:
        """删除某个 Blob 存为系统区对象的缩略图（可只删某个存储桶里的），并释放空间。"""
        sql = "SELECT variant, bucket_id, object_key FROM thumbnails WHERE blob_uuid=? AND object_key IS NOT NULL"
        rows = db.execute(sql + (" AND bucket_id=?" if bucket_id is not None else ""),
                          (blob_uuid,) if bucket_id is None else (blob_uuid, bucket_id)).fetchall()
        for row in rows:
            self._drop_object_row(db, row["bucket_id"], row["object_key"], now)
            db.execute("DELETE FROM thumbnails WHERE blob_uuid=? AND variant=?", (blob_uuid, row["variant"]))

    def _hand_over_thumbnails(self, db, blob_uuid: str, bucket_id: int, now: float) -> None:
        """某个存储桶不再引用源文件：把存在这个桶里的缩略图对象改归另一个仍引用它的桶（不重新上传），
        没有其他引用的桶（例如只剩系统区副本）时删除。"""
        heir = db.execute("SELECT bucket_id FROM objects WHERE blob_uuid=? AND bucket_id!=? AND substr(key,1,length(?))!=? "
                          "ORDER BY bucket_id LIMIT 1", (blob_uuid, bucket_id, self.THUMBNAIL_PREFIX, self.THUMBNAIL_PREFIX)).fetchone()
        if heir is None:
            self._drop_thumbnail_objects(db, blob_uuid, now, bucket_id)
            return
        target = heir["bucket_id"]
        rows = db.execute("SELECT variant, object_key FROM thumbnails WHERE blob_uuid=? AND bucket_id=? AND object_key IS NOT NULL",
                          (blob_uuid, bucket_id)).fetchall()
        for row in rows:
            key = row["object_key"]
            item = db.execute("SELECT size FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key)).fetchone()
            if item is None:
                db.execute("DELETE FROM thumbnails WHERE blob_uuid=? AND variant=?", (blob_uuid, row["variant"]))
                continue
            self._drop_object_row(db, target, key, now)  # 目标桶里同名的残留对象
            db.execute("UPDATE objects SET bucket_id=? WHERE bucket_id=? AND key=?", (target, bucket_id, key))
            db.execute("UPDATE buckets SET used_bytes = MAX(0, used_bytes - ?) WHERE id=?", (item["size"], bucket_id))
            db.execute("UPDATE buckets SET used_bytes = used_bytes + ? WHERE id=?", (item["size"], target))
            db.execute("UPDATE thumbnails SET bucket_id=? WHERE blob_uuid=? AND variant=?", (target, blob_uuid, row["variant"]))

    def _drop_object_row(self, db, bucket_id: int, key: str, now: float) -> None:
        old = db.execute("SELECT blob_uuid, size FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key)).fetchone()
        if old is None:
            return
        db.execute("DELETE FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key))
        db.execute("UPDATE buckets SET used_bytes = MAX(0, used_bytes - ?) WHERE id=?", (old["size"], bucket_id))
        if old["blob_uuid"]:
            self._release_blob(db, old["blob_uuid"], now)

    async def set_thumbnail(self, scope: Scope, key: str, data: bytes | None, variant: str = "thumb") -> None:
        """保存一种规格的缩略图；variant='none' 记录“已尝试但无法生成”，避免各端反复尝试。"""
        info, blob_uuid = self._thumbnail_blob(scope, key, write=True)
        now = time.time()
        if variant == "none":
            with self.metadata.transaction() as db:
                if not db.execute("SELECT 1 FROM thumbnails WHERE blob_uuid=? AND variant='thumb'", (blob_uuid,)).fetchone():
                    db.execute("INSERT OR REPLACE INTO thumbnails(blob_uuid,variant,mime,data,created_at) VALUES(?,'none','',x'',?)",
                               (blob_uuid, now))
            return
        limit = self.THUMBNAIL_LIMITS.get(variant)
        if limit is None:
            raise ValueError("不支持的缩略图规格")
        if not data or len(data) > limit:
            raise ValueError("缩略图过大")
        await self._store_thumbnail(info.bucket_id, blob_uuid, variant, self._thumbnail_mime(data), data, scope)

    async def _store_thumbnail(self, bucket_id: int, blob_uuid: str, variant: str, mime: str, data: bytes,
                               scope: Scope | None = None) -> None:
        """大缩略图写成系统区对象（经 put_object 加密、计入配额），提交前复核源文件仍引用该 Blob。"""
        key = f"{self.THUMBNAIL_PREFIX}{blob_uuid}/{variant}"
        await self.put_object(Scope(bucket_id), key, data, len(data), mime, small=True)
        now = time.time()
        with self.metadata.transaction() as db:
            if scope is not None and scope.authorize is not None:
                scope.authorize()
            alive = db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND blob_uuid=? LIMIT 1", (bucket_id, blob_uuid)).fetchone()
            previous = db.execute("SELECT bucket_id, object_key FROM thumbnails WHERE blob_uuid=? AND variant=?",
                                  (blob_uuid, variant)).fetchone()
            if not alive:
                # 生成期间源文件被删除或覆盖：丢弃刚写入的对象。
                self._drop_object_row(db, bucket_id, key, now)
                if previous is not None and previous["bucket_id"] == bucket_id and previous["object_key"] == key:
                    db.execute("DELETE FROM thumbnails WHERE blob_uuid=? AND variant=?", (blob_uuid, variant))
                return
            if previous is not None and previous["object_key"] and (previous["bucket_id"], previous["object_key"]) != (bucket_id, key):
                # 同一个 Blob 只保留一份：别的存储桶里的旧版本删掉。
                self._drop_object_row(db, previous["bucket_id"], previous["object_key"], now)
            db.execute("INSERT OR REPLACE INTO thumbnails(blob_uuid,variant,mime,data,created_at,bucket_id,object_key) "
                       "VALUES(?,?,?,x'',?,?,?)", (blob_uuid, variant, mime, now, bucket_id, key))
            db.execute("DELETE FROM thumbnails WHERE blob_uuid=? AND variant='none'", (blob_uuid,))
            if variant == "thumb":
                db.execute("DELETE FROM thumbnail_legacy WHERE blob_uuid=?", (blob_uuid,))

    def finish_thumbnail_set(self, scope: Scope, key: str, variants: list[str]) -> None:
        """重新生成成功后移除未生成的旧规格；失败期间始终保留原来的缩略图。"""
        if "thumb" not in variants:
            return
        _, blob = self._thumbnail_blob(scope, key, write=True)
        with self.metadata.transaction() as db:
            rows = db.execute("SELECT variant,bucket_id,object_key FROM thumbnails WHERE blob_uuid=?", (blob,)).fetchall()
            for row in rows:
                if row["variant"] in variants:
                    continue
                if row["object_key"]:
                    self._drop_object_row(db, row["bucket_id"], row["object_key"], time.time())
                db.execute("DELETE FROM thumbnails WHERE blob_uuid=? AND variant=?", (blob, row["variant"]))

    async def read_thumbnail(self, info: ObjectInfo, variant: str = "thumb") -> tuple[bytes, str, str]:
        """返回 (图片, MIME, ETag)。所需规格缺失时按 THUMBNAIL_FALLBACK 退回。
        旧版内联在表里的图片与更早的明文缩略图在转存完成前照常读取，转存由维护任务完成。"""
        if variant not in self.THUMBNAIL_LIMITS or not info.blob_uuid:
            raise NotFoundError("thumbnail not found")
        db = self.metadata.db
        for candidate in self.THUMBNAIL_FALLBACK[variant]:
            sql = "SELECT mime, data, created_at, bucket_id, object_key FROM thumbnails WHERE blob_uuid=? AND variant=?"
            row = db.execute(sql, (info.blob_uuid, candidate)).fetchone()
            if row is None and candidate == "thumb":
                legacy = db.execute("SELECT data FROM thumbnail_legacy WHERE blob_uuid=?", (info.blob_uuid,)).fetchone()
                if legacy is not None:
                    try:
                        return legacy["data"], self._thumbnail_mime(legacy["data"]), f"{info.etag}-thumb-legacy"
                    except ValueError:
                        pass
            if row is None:
                continue
            etag = f"{info.etag}-{candidate}-{self._thumbnail_revision(row['created_at'])}"
            if not row["object_key"]:
                return self.engine.open_thumbnail(info.blob_uuid, candidate, row["data"]), row["mime"], etag
            stored = db.execute("SELECT blob_uuid FROM objects WHERE bucket_id=? AND key=?",
                                (row["bucket_id"], row["object_key"])).fetchone()
            if stored is None or not stored["blob_uuid"]:
                # 所在存储桶已删除：去掉记录，下次浏览时重新生成。
                with self.metadata.transaction() as tx:
                    tx.execute("DELETE FROM thumbnails WHERE blob_uuid=? AND variant=? AND object_key=?",
                               (info.blob_uuid, candidate, row["object_key"]))
                continue
            # 大图很小（≤320 KB），走独立的小读取通道，不占用普通下载与预览的传输名额。
            return await self.engine.read_small(stored["blob_uuid"]), row["mime"], etag
        raise NotFoundError("thumbnail not found")

    async def get_thumbnail(self, scope: Scope, key: str, variant: str = "thumb") -> tuple[bytes, str, str]:
        return await self.read_thumbnail(self._object(self._lookup(scope, key)), variant)

    async def get_thumbnail_by_etag(self, scope: Scope, etag: str, variant: str = "thumb", *,
                                    accept: Callable[[str], object] | None = None) -> tuple[bytes, str, str]:
        """按内容版本读取缩略图：地址不含路径，移动或改名后浏览器缓存仍然有效。
        只考虑调用者用路径同样能读取的文件（accept 复核网页路径规则，_check_scope 复核前缀与私密空间）。"""
        if not etag or len(etag) > 128:
            raise NotFoundError("thumbnail not found")
        self._bucket(scope.bucket_id)
        rows = self.metadata.db.execute("SELECT * FROM objects WHERE bucket_id=? AND etag=? AND blob_uuid IS NOT NULL "
                                        "AND substr(key,-1)!='/' ORDER BY key LIMIT 16", (scope.bucket_id, etag)).fetchall()
        for row in rows:
            try:
                if accept is not None:
                    accept(row["key"])
                self._check_scope(scope, row["key"])
            except (PermissionError, ValueError):
                continue
            try:
                return await self.read_thumbnail(self._object(row), variant)
            except NotFoundError:
                continue  # 相同内容的另一份副本可能已有缩略图。
        raise NotFoundError("thumbnail not found")

    MIGRATE_CURSOR = "thumbnails.migrate_cursor"

    def _setting(self, key: str, default=None):
        row = self.metadata.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        try:
            return json.loads(row["value"]) if row is not None else default
        except (TypeError, ValueError):
            return default

    def _save_setting(self, key: str, value) -> None:
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (key, json.dumps(value)))

    def inline_thumbnails(self) -> dict[str, int]:
        """还内联在表里、等待转存为对象的缩略图（含旧版明文）的数量与字节数。"""
        row = self.metadata.db.execute("SELECT COUNT(*), COALESCE(SUM(length(data)),0) FROM thumbnails "
                                       "WHERE object_key IS NULL AND length(data) > 0").fetchone()
        legacy = self.metadata.db.execute("SELECT COUNT(*), COALESCE(SUM(length(data)),0) FROM thumbnail_legacy").fetchone()
        state = self._setting(self.MIGRATE_CURSOR, {}) or {}
        return {"count": int(row[0]) + int(legacy[0]), "bytes": int(row[1]) + int(legacy[1]),
                "skipped_quota": int(state.get("skipped", 0) or 0)}

    async def migrate_thumbnails(self, limit: int = 100, *, seconds: float | None = None) -> int:
        """维护任务：把旧版内联在数据库里的缩略图逐张转存为系统区对象，释放服务器磁盘。
        对象写入引用该 Blob 的第一个存储桶；没有任何对象引用时直接删除记录。每张是一条 Telegram 消息，
        所以按数量与时间片限制。配额已满时：大图删除（之后浏览重新生成），列表小图保留在表里，
        用游标跳过、下一遍再试，避免回源补图。"""
        deadline = time.monotonic() + seconds if seconds is not None else None
        state = self._setting(self.MIGRATE_CURSOR, {}) or {}
        after = (str(state.get("blob", "")), str(state.get("variant", "")))
        skipped, current = int(state.get("skipped", 0) or 0), int(state.get("current", 0) or 0)
        moved, wrapped = 0, False
        try:
            while moved < limit and (deadline is None or time.monotonic() < deadline):
                row = self.metadata.db.execute(
                    "SELECT blob_uuid, variant, mime, data FROM thumbnails WHERE object_key IS NULL AND length(data) > 0 "
                    "AND variant IN ('thumb','grid','poster') AND (blob_uuid > ? OR (blob_uuid = ? AND variant > ?)) "
                    "ORDER BY blob_uuid, variant LIMIT 1", (after[0], after[0], after[1])).fetchone()
                if row is None:
                    # 走完一遍：记下这一遍因配额跳过的小图数，从头再试；每次调用最多绕回一次，不在同一批行上空转。
                    skipped, current = current, 0
                    if wrapped or after == ("", ""):
                        after = ("", "")
                        break
                    after, wrapped = ("", ""), True
                    continue
                blob_uuid, variant = row["blob_uuid"], row["variant"]
                after = (blob_uuid, variant)
                owner = self.metadata.db.execute(
                    "SELECT bucket_id FROM objects WHERE blob_uuid=? AND substr(key,1,length(?))!=? ORDER BY bucket_id LIMIT 1",
                    (blob_uuid, self.THUMBNAIL_PREFIX, self.THUMBNAIL_PREFIX)).fetchone()
                try:
                    if owner is None:
                        raise LookupError
                    data = self.engine.open_thumbnail(blob_uuid, variant, row["data"])
                    await self._store_thumbnail(owner["bucket_id"], blob_uuid, variant, row["mime"], data)
                    moved += 1
                except LookupError:
                    with self.metadata.transaction() as db:
                        db.execute("DELETE FROM thumbnails WHERE blob_uuid=? AND variant=? AND object_key IS NULL", (blob_uuid, variant))
                except QuotaExceededError:
                    if variant == "thumb":
                        current += 1
                    else:
                        # 大图不再保留，界面退回列表小图，之后浏览时重新生成。
                        with self.metadata.transaction() as db:
                            db.execute("DELETE FROM thumbnails WHERE blob_uuid=? AND variant=? AND object_key IS NULL",
                                       (blob_uuid, variant))
        finally:
            self._save_setting(self.MIGRATE_CURSOR, {"blob": after[0], "variant": after[1],
                                                     "skipped": max(skipped, current), "current": current})
        return moved

    def sweep_thumbnail_objects(self, limit: int = 500, *, older_than: float = 3600) -> int:
        """维护任务：删除没有登记的大缩略图对象（例如从不含缩略图表的备份恢复后），释放配额。
        只处理写入超过一小时的对象，避开正在保存、尚未登记的那一刻。"""
        prefix = self.THUMBNAIL_PREFIX
        rows = self.metadata.db.execute(
            "SELECT o.bucket_id, o.key FROM objects o WHERE o.key >= ? AND o.key < ? AND o.modified_at < ? "
            "AND NOT EXISTS(SELECT 1 FROM thumbnails t WHERE t.bucket_id=o.bucket_id AND t.object_key=o.key) LIMIT ?",
            (prefix, prefix + self._PREFIX_END, time.time() - older_than, limit)).fetchall()
        now = time.time()
        with self.metadata.transaction() as db:
            for row in rows:
                self._drop_object_row(db, row["bucket_id"], row["key"], now)
        return len(rows)

    def thumbnail_variants(self, blob_uuids: list[str]) -> dict[str, list[str]]:
        """内部缩略图记录，含 none 失败标记；网页输出需经 thumbnail_fields 分离图片与状态。"""
        return {uuid: list(versions) for uuid, versions in self.thumbnail_versions(blob_uuids).items()}

    @classmethod
    def thumbnail_fields(cls, variants: Iterable[str] = (), versions: dict[str, str] | None = None) -> dict[str, object]:
        """none 只表示曾尝试但未生成，不能出现在网页的图片规格或图片版本中。"""
        variants = tuple(variants)
        images = [variant for variant in variants if variant in cls.STORED_THUMBNAILS]
        return {"has_thumbnail": "thumb" in images, "thumbnails": images,
                "thumbnail_versions": {name: revision for name, revision in (versions or {}).items() if name in images},
                "thumbnail_status": "ready" if images else "unavailable" if "none" in variants else "missing"}

    def thumbnail_versions(self, blob_uuids: list[str]) -> dict[str, dict[str, str]]:
        """批量读取各规格的独立版本，列表与目录封面复用同一资源地址。"""
        unique = list(dict.fromkeys(uuid for uuid in blob_uuids if uuid))
        if not unique:
            return {}
        marks = ",".join("?" for _ in unique)
        result: dict[str, dict[str, str]] = {}
        for row in self.metadata.db.execute(
                f"SELECT blob_uuid, variant, created_at FROM thumbnails WHERE blob_uuid IN ({marks}) "
                f"UNION ALL SELECT blob_uuid, 'thumb', NULL FROM thumbnail_legacy WHERE blob_uuid IN ({marks}) ORDER BY 2 DESC, 3 DESC",
                (*unique, *unique)):
            variants = result.setdefault(row["blob_uuid"], {})
            variants.setdefault(row["variant"], self._thumbnail_revision(row["created_at"]))
        return result

    async def adopt_legacy_thumbnails(self, limit: int = 100, *, seconds: float | None = None) -> int:
        """维护任务：把旧版明文缩略图直接转存为列表小图对象并删除明文，需要系统已解锁。"""
        deadline = time.monotonic() + seconds if seconds is not None else None
        rows = self.metadata.db.execute("SELECT blob_uuid, data FROM thumbnail_legacy LIMIT ?", (limit,)).fetchall()
        adopted = 0
        for row in rows:
            if deadline is not None and time.monotonic() >= deadline:
                break
            blob_uuid = row["blob_uuid"]
            owner = self.metadata.db.execute(
                "SELECT bucket_id FROM objects WHERE blob_uuid=? AND substr(key,1,length(?))!=? ORDER BY bucket_id LIMIT 1",
                (blob_uuid, self.THUMBNAIL_PREFIX, self.THUMBNAIL_PREFIX)).fetchone()
            try:
                mime = self._thumbnail_mime(row["data"])
            except ValueError:
                owner = None
            if owner is None or self.metadata.db.execute(
                    "SELECT 1 FROM thumbnails WHERE blob_uuid=? AND variant='thumb'", (blob_uuid,)).fetchone():
                with self.metadata.transaction() as db:
                    db.execute("DELETE FROM thumbnail_legacy WHERE blob_uuid=?", (blob_uuid,))
                continue
            try:
                await self._store_thumbnail(owner["bucket_id"], blob_uuid, "thumb", mime, row["data"])
                adopted += 1
            except QuotaExceededError:
                continue  # 保留明文副本，配额腾出后再转
        return adopted

    # ---------- 回收站：条目以 .tgdrive/trash/<id>/<原路径> 保存，仍计入容量 ----------

    TRASH_PREFIX = ".tgdrive/trash/"
    TRASH_DAYS = 30

    async def trash(self, scope: Scope, keys: list[str]) -> list[dict[str, object]]:
        entries = []
        for key in keys:
            folder = key.endswith("/")
            self._check_scope(scope, key, write=True)
            if key.startswith(".tgdrive/") and not (scope.private_access and key.startswith(PRIVATE_PREFIX)):
                raise PermissionError("reserved path")
            stats = self.metadata.db.execute(
                "SELECT COUNT(*), COALESCE(SUM(size),0) FROM objects WHERE bucket_id=? AND "
                + ("key>=? AND key<?" if folder else "key=?"),
                (scope.bucket_id, key, key + self._PREFIX_END) if folder else (scope.bucket_id, key)).fetchone()
            if not stats[0]:
                raise NotFoundError(key)
            entry_id = f"{int(time.time() * 1000)}-{secrets.token_hex(3)}"
            target = self._trash_key(entry_id, key)
            internal = replace(scope, prefix="")
            self.move(internal, key, target, "overwrite")
            if folder and not self.metadata.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, target)).fetchone():
                # 没有目录标记的“隐式”文件夹在回收站中补一个标记，恢复时才能得到完整的文件夹。
                # 已有标记时不能覆盖：公开分享信息（令牌、有效期、密码）保存在标记行上，还原后链接要恢复。
                await self.put_directory_marker(internal, target)
            with self.metadata.transaction() as db:
                db.execute("INSERT INTO trash(id,bucket_id,original_path,is_folder,size,item_count,deleted_at) VALUES(?,?,?,?,?,?,?)",
                           (entry_id, scope.bucket_id, key, int(folder), int(stats[1]), int(stats[0]), time.time()))
            entries.append({"id": entry_id, "path": key})
        return entries

    def list_trash(self, bucket_id: int, *, private: bool = False) -> list[dict[str, object]]:
        rows = self.metadata.db.execute("SELECT * FROM trash WHERE bucket_id=? AND (substr(original_path,1,?)=?)=? "
                                       "ORDER BY deleted_at DESC", (bucket_id, len(PRIVATE_PREFIX), PRIVATE_PREFIX, int(private)))
        return [{"id": row["id"], "path": row["original_path"], "is_folder": bool(row["is_folder"]), "size": row["size"],
                 "item_count": row["item_count"], "deleted_at": row["deleted_at"],
                 "purge_at": row["deleted_at"] + self.TRASH_DAYS * 86400} for row in rows]

    def _trash_row(self, bucket_id: int, entry_id: str):
        row = self.metadata.db.execute("SELECT * FROM trash WHERE bucket_id=? AND id=?", (bucket_id, entry_id)).fetchone()
        if row is None:
            raise NotFoundError("trash entry not found")
        return row

    def _trash_key(self, entry_id: str, original: str) -> str:
        if original.startswith(PRIVATE_PREFIX):
            return f"{PRIVATE_TRASH_PREFIX}{entry_id}/{original[len(PRIVATE_PREFIX):]}"
        return f"{self.TRASH_PREFIX}{entry_id}/{original}"

    def restore(self, scope: Scope, entry_ids: list[str]) -> list[dict[str, object]]:
        """还原到原位置；原位置已有同名文件时自动改名保留两者。"""
        restored = []
        for entry_id in entry_ids:
            row = self._trash_row(scope.bucket_id, entry_id)
            self._check_scope(scope, row["original_path"], write=True)
            source = self._trash_key(entry_id, row["original_path"])
            self.move(replace(scope, prefix=""), source, row["original_path"], "rename")
            with self.metadata.transaction() as db:
                db.execute("DELETE FROM trash WHERE id=?", (entry_id,))
            restored.append({"id": entry_id, "path": row["original_path"]})
        return restored

    async def purge_trash(self, scope: Scope, entry_ids: list[str] | None = None) -> int:
        """永久删除回收站条目；entry_ids 为 None 时清空整个回收站。"""
        if entry_ids is None:
            total = 0
            condition, params = "bucket_id=?", [scope.bucket_id]
            if scope.prefix == PRIVATE_PREFIX:
                condition += " AND substr(original_path,1,?)=?"
                params.extend((len(PRIVATE_PREFIX), PRIVATE_PREFIX))
            elif not scope.private_access:
                condition += " AND substr(original_path,1,?)!=?"
                params.extend((len(PRIVATE_PREFIX), PRIVATE_PREFIX))
            while True:
                ids = [row["id"] for row in self.metadata.db.execute(
                    f"SELECT id FROM trash WHERE {condition} ORDER BY deleted_at,id LIMIT 100", params)]
                if not ids:
                    return total
                total += await self.purge_trash(scope, ids)
                await asyncio.sleep(0)
        for entry_id in entry_ids:
            row = self._trash_row(scope.bucket_id, entry_id)
            self._check_scope(scope, row["original_path"], write=True)
            original = row["original_path"]
            prefix = PRIVATE_TRASH_PREFIX if original.startswith(PRIVATE_PREFIX) else self.TRASH_PREFIX
            await self.delete_prefix(replace(scope, prefix=""), f"{prefix}{entry_id}/")
            with self.metadata.transaction() as db:
                db.execute("DELETE FROM trash WHERE id=?", (entry_id,))
        return len(entry_ids)

    async def purge_expired_trash(self, now: float | None = None) -> int:
        cutoff = (time.time() if now is None else now) - self.TRASH_DAYS * 86400
        # 单次调度有界，剩余条目留给下一轮，避免过期条目积压时占满整个维护周期。
        rows = self.metadata.db.execute(
            "SELECT id,bucket_id FROM trash WHERE deleted_at<? ORDER BY deleted_at,id LIMIT 100", (cutoff,)).fetchall()
        for row in rows:
            await self.purge_trash(Scope(row["bucket_id"], private_access=True), [row["id"]])
        return len(rows)

    async def purge_bucket(self, bucket_id: int) -> int:
        """删除存储桶中的全部对象与未完成的分段上传（用于删除用户）。返回删除的对象数。"""
        scope = Scope(bucket_id, private_access=True)
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
            "SELECT * FROM objects WHERE bucket_id=? AND public_token IS NOT NULL AND substr(key,1,9)!='.tgdrive/' ORDER BY public_at DESC LIMIT ?",
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

    async def list_public_folder(self, token: str, relative: str = "", cursor: str | None = None, limit: int = 200,
                                 kind: str = "") -> dict[str, object]:
        """列出被公开的文件夹（或其中的子文件夹）。内容是实时的：分享之后新增的文件访客也能看到。

        kind 按文件类型筛选当前目录的直接子文件（不含文件夹），规则与网页文件列表相同。
        """
        root = self._public_folder_root(token)
        relative = self._public_relative(relative)
        if relative and not relative.endswith("/"):
            relative += "/"
        prefix = root.key + relative
        scope = Scope(root.bucket_id, root.key)
        clause = kind_clause(kind) if kind else None
        def read_page():
            if clause is not None:
                size = max(1, min(limit, 500))
                condition, args = clause
                rows = self.metadata.db.execute(
                    "SELECT * FROM objects WHERE bucket_id=? AND key>? AND key<? AND key>? AND substr(key,-1)!='/' "
                    f"AND instr(substr(key,?),'/')=0 AND {condition} ORDER BY key LIMIT ?",
                    (root.bucket_id, prefix, prefix + self._PREFIX_END, cursor or "", len(prefix) + 1, *args, size + 1)).fetchall()
                page = ListPage([self._object(row) for row in rows[:size]], [], rows[size - 1]["key"] if len(rows) > size else None)
            else:
                page = self.list_objects(scope, prefix, "/", cursor, max(1, min(limit, 500)))
            return (page, self.folder_summary(scope, page.common_prefixes),
                    self.thumbnail_variants([item.blob_uuid for item in page.objects]), self.folder_previews(scope, page.common_prefixes))
        page, sizes, thumbnails, previews = await self.metadata.run_in_thread(read_page)
        files = [{"name": item.key[len(prefix):], "path": item.key[len(root.key):], "size": item.size, "content_type": item.content_type,
                  "etag": item.etag, "modified_at": item.modified_at,
                  **self.thumbnail_fields(thumbnails.get(item.blob_uuid or "", []))}
                 for item in page.objects if item.key != prefix and not item.key.endswith("/")]
        folders = [{"name": value[len(prefix):].rstrip("/"), "path": value[len(root.key):], "size": sizes[value][0], "modified_at": sizes[value][1],
                    "previews": [{"name": item["key"].rsplit("/", 1)[-1], "path": item["key"][len(root.key):],
                                  **{key: data for key, data in item.items() if key != "key"}} for item in previews[value]]}
                   for value in page.common_prefixes]
        if relative and not files and not folders and cursor is None and clause is None and not self.metadata.db.execute(
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

    SAVE_PUBLIC_LIMIT = 10000

    def save_public(self, token: str, dst: Scope, destination: str, paths: list[str] | None = None) -> dict[str, object]:
        """把公开分享的文件或文件夹保存到 dst 的 destination 目录（以 / 结尾，空串为根目录）。

        新对象引用同一个加密 Blob（不搬运数据，计入保存者的配额），不继承来源的公开链接。
        paths 为分享文件夹内的相对路径（文件或以 / 结尾的子文件夹），平铺保存到目标目录；
        省略时保存整个分享。同名文件或文件夹自动改名。全部在一个事务内完成，配额不足时不保存任何内容。
        调用方负责校验分享密码；这里校验有效期、账号状态与相对路径范围。
        """
        root = self.resolve_public(token)
        if root.bucket_id == dst.bucket_id:
            raise ValueError("这是你自己分享的内容，无需保存")
        if destination and not destination.endswith("/"):
            raise ValueError("目标目录不正确")
        if destination:
            self._check_scope(dst, destination, write=True)
        # (来源前缀, 目标前缀)：文件以完整键精确匹配，文件夹按前缀匹配。
        if not root.key.endswith("/"):
            if paths:
                raise ValueError("单个文件的分享不能选择子路径")
            sources = [(root.key, destination + root.key.rsplit("/", 1)[-1])]
        elif not paths:
            sources = [(root.key, destination + root.key.rstrip("/").rsplit("/", 1)[-1] + "/")]
        else:
            if len(paths) > self.SAVE_PUBLIC_LIMIT:
                raise ValueError(f"一次最多保存 {self.SAVE_PUBLIC_LIMIT} 个项目")
            sources = []
            for value in dict.fromkeys(paths):
                relative = self._public_relative(value)
                if not relative:
                    raise ValueError("请选择要保存的文件")
                sources.append((root.key + relative, destination + relative.rstrip("/").rsplit("/", 1)[-1] + ("/" if relative.endswith("/") else "")))
        for _, target in sources:
            self._check_scope(dst, target, write=True)

        now = time.time()
        with self.metadata.transaction() as db:
            plan: list[tuple] = []  # (来源序号, 来源行或 None, 相对来源的子路径)
            for index, (source, target) in enumerate(sources):
                if source.endswith("/"):
                    rows = db.execute("SELECT * FROM objects WHERE bucket_id=? AND key>=? AND key<? ORDER BY key LIMIT ?",
                                      (root.bucket_id, source, source + self._PREFIX_END, self.SAVE_PUBLIC_LIMIT + 1)).fetchall()
                    if not rows:
                        raise NotFoundError(source[len(root.key):])
                    plan.extend((index, row, row["key"][len(source):]) for row in rows)
                    if not any(row["key"] == source for row in rows):
                        plan.append((index, None, ""))  # 隐式文件夹：补一个目录标记
                else:
                    row = db.execute("SELECT * FROM objects WHERE bucket_id=? AND key=?", (root.bucket_id, source)).fetchone()
                    if row is None:
                        raise NotFoundError(source[len(root.key):])
                    plan.append((index, row, ""))
                if len(plan) > self.SAVE_PUBLIC_LIMIT:
                    raise ValueError(f"一次最多保存 {self.SAVE_PUBLIC_LIMIT} 个文件，请进入子文件夹分批保存")
            bucket = db.execute("SELECT quota_bytes, used_bytes FROM buckets WHERE id=?", (dst.bucket_id,)).fetchone()
            if bucket is None:
                raise NotFoundError(f"bucket {dst.bucket_id} not found")
            total = sum(int(row["size"]) for _, row, _ in plan if row is not None)
            if bucket["quota_bytes"] is not None and int(bucket["used_bytes"]) + total > bucket["quota_bytes"]:
                raise QuotaExceededError("存储空间不足，无法保存")
            # 只给每个顶层目标改名：保存出来的文件夹是全新的，内部不会再有冲突。
            reserved: set[str] = set()  # 本次已占用的顶层名称（不含结尾 /）
            renamed: list[str] = []
            def occupied(name: str) -> bool:
                # 同名文件或同名文件夹（含只有子项、没有目录标记的隐式文件夹）都算占用。
                return name in reserved or db.execute(
                    "SELECT 1 FROM objects WHERE bucket_id=? AND (key=? OR (key>=? AND key<?)) LIMIT 1",
                    (dst.bucket_id, name, name + "/", name + "/" + self._PREFIX_END)).fetchone() is not None
            for _, target in sources:
                final = bare = target.rstrip("/")
                directory, slash, name = bare.rpartition("/")
                base, dot, ext = name.rpartition(".")
                if not dot or not base or target.endswith("/"):
                    base, dot, ext = name, "", ""
                n = 1
                while occupied(final):
                    final, n = f"{directory}{slash}{base} ({n}){dot}{ext}", n + 1
                reserved.add(final)
                renamed.append(final + ("/" if target.endswith("/") else ""))
            saved = 0
            for index, row, rest in plan:
                key = renamed[index] + rest
                self._check_scope(dst, key, write=True)
                if row is None or row["blob_uuid"] is None:
                    db.execute("INSERT OR IGNORE INTO objects(bucket_id,key,blob_uuid,size,etag,content_type,user_meta,modified_at) "
                               "VALUES(?,?,?,?,?,?,?,?)", (dst.bucket_id, key, None, 0,
                                                          hashlib.md5(b"").hexdigest(), "application/x-directory", "{}", now))
                else:
                    db.execute("UPDATE blobs SET refcount = refcount + 1 WHERE uuid = ?", (row["blob_uuid"],))
                    db.execute("INSERT INTO objects(bucket_id,key,blob_uuid,size,etag,content_type,user_meta,modified_at) "
                               "VALUES(?,?,?,?,?,?,?,?)", (dst.bucket_id, key, row["blob_uuid"], row["size"], row["etag"],
                                                          row["content_type"], row["user_meta"], now))
                    saved += 1
            db.execute("UPDATE buckets SET used_bytes = used_bytes + ? WHERE id=?", (total, dst.bucket_id))
            # 每次保存计为一次下载，分享者能看到被转存，以后的下载次数上限也不会被绕过。
            db.execute("UPDATE objects SET public_downloads=public_downloads+1 WHERE bucket_id=? AND key=?", (root.bucket_id, root.key))
        return {"saved": saved, "bytes": total, "items": renamed}

    def link_copy(self, source_bucket: int, source_key: str, dst: Scope, target: str) -> ObjectInfo:
        """把一个文件以「引用同一个加密 Blob」的方式另存为 dst 中的普通文件：不搬运数据，计入目标配额，
        不继承公开链接；目标已存在时自动改名为「名称 (n).扩展名」。调用方负责授权来源。"""
        if not target or target.endswith("/"):
            raise ValueError("目标文件名不正确")
        self._check_scope(dst, target, write=True)
        now = time.time()
        with self.metadata.transaction() as db:
            row = db.execute("SELECT * FROM objects WHERE bucket_id=? AND key=?", (source_bucket, source_key)).fetchone()
            if row is None or not row["blob_uuid"]:
                raise NotFoundError(source_key)
            bucket = db.execute("SELECT quota_bytes, used_bytes FROM buckets WHERE id=?", (dst.bucket_id,)).fetchone()
            if bucket is None:
                raise NotFoundError(f"bucket {dst.bucket_id} not found")
            if bucket["quota_bytes"] is not None and int(bucket["used_bytes"]) + int(row["size"]) > bucket["quota_bytes"]:
                raise QuotaExceededError("存储空间不足，无法保存")
            directory, slash, name = target.rpartition("/")
            base, dot, ext = name.rpartition(".")
            if not dot or not base:
                base, dot, ext = name, "", ""
            final, n = target, 1
            while db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND (key=? OR (key>=? AND key<?)) LIMIT 1",
                             (dst.bucket_id, final, final + "/", final + "/" + self._PREFIX_END)).fetchone() is not None:
                final, n = f"{directory}{slash}{base} ({n}){dot}{ext}", n + 1
            self._check_scope(dst, final, write=True)
            db.execute("UPDATE blobs SET refcount = refcount + 1 WHERE uuid = ?", (row["blob_uuid"],))
            db.execute("INSERT INTO objects(bucket_id,key,blob_uuid,size,etag,content_type,user_meta,modified_at) "
                       "VALUES(?,?,?,?,?,?,?,?)", (dst.bucket_id, final, row["blob_uuid"], row["size"], row["etag"],
                                                  row["content_type"], row["user_meta"], now))
            db.execute("UPDATE buckets SET used_bytes = used_bytes + ? WHERE id=?", (row["size"], dst.bucket_id))
        return self._object(self.metadata.db.execute("SELECT * FROM objects WHERE bucket_id=? AND key=?",
                                                      (dst.bucket_id, final)).fetchone())

    async def asave_public(self, token: str, dst: Scope, destination: str, paths: list[str] | None = None) -> dict[str, object]:
        return await self.metadata.run_in_thread(self.save_public, token, dst, destination, paths)

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
                    self._release_blob(db, row["blob_uuid"], now, scope.bucket_id)
                else:
                    db.execute("DELETE FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key))
                db.execute("UPDATE buckets SET used_bytes = used_bytes - ? WHERE id=?", (row["size"], scope.bucket_id))
                results.append(DeleteResult(key, True))
        self._changed(scope.bucket_id)
        return results

    async def delete_objects(self, scope: Scope, keys: list[str]) -> list[DeleteResult]:
        return await self.metadata.run_in_thread(self._delete_objects_sync, scope, keys)

    # 跳过一个公共前缀下全部键时使用的上界：U+10FFFF 是最大码点，按 SQLite 二进制排序大于该前缀下的任何键。
    _PREFIX_END = "\U0010ffff"

    PREVIEW_SAMPLE = 64

    def folder_previews(self, scope: Scope, prefixes: list[str]) -> dict[str, list[dict[str, object]]]:
        """批量取得每个目录最多四张已有缩略图的元信息，不读取原文件或缩略图内容。"""
        prefixes = list(dict.fromkeys(prefixes))
        for prefix in prefixes:
            self._check_scope(scope, prefix)
            if not prefix.endswith("/"):
                raise ValueError("folder path must end with /")
        if not prefixes:
            return {}
        def read():
            previews: dict[str, list[dict[str, object]]] = {prefix: [] for prefix in prefixes}
            for prefix in prefixes:
                # 先按桶 / 键索引限定候选，再关联缩略图。不能把采样放进多层关联 IN 子查询，
                # 否则 SQLite 可能为桶内每个对象重复计算候选，即使 LIMIT 很小也会拖慢目录列表。
                # 每个目录单独执行有界查询，最多检查 PREVIEW_SAMPLE 个文件，避免为凑四张封面扫描整个目录。
                rows = self.metadata.db.execute(
                    "SELECT sample.key,sample.size,sample.etag,sample.content_type,sample.modified_at,"
                    "t.created_at AS thumbnail_created_at FROM ("
                    "SELECT key,blob_uuid,size,etag,content_type,modified_at FROM objects WHERE bucket_id=? "
                    "AND key>? AND key<? AND substr(key,-1)!='/' "
                    "AND (substr(key,1,9)!='.tgdrive/' OR ?=1) ORDER BY key LIMIT ?) sample "
                    "LEFT JOIN thumbnails t ON t.blob_uuid=sample.blob_uuid AND t.variant='thumb' "
                    "LEFT JOIN thumbnail_legacy l ON l.blob_uuid=sample.blob_uuid "
                    "WHERE t.blob_uuid IS NOT NULL OR l.blob_uuid IS NOT NULL ORDER BY sample.key LIMIT 4",
                    (scope.bucket_id, prefix, prefix + self._PREFIX_END, int(scope.private_access), self.PREVIEW_SAMPLE))
                for row in rows:
                    item = {key: row[key] for key in ("key", "size", "etag", "content_type", "modified_at")}
                    previews[prefix].append({**item, "thumbnails": ["thumb"], "has_thumbnail": True,
                        "thumbnail_versions": {"thumb": self._thumbnail_revision(row["thumbnail_created_at"])}})
            return previews
        return self.metadata.cached_read(("folder-previews", scope.bucket_id, tuple(prefixes)), read)

    def folder_summary(self, scope: Scope, prefixes: list[str]) -> dict[str, tuple[int, float | None]]:
        """当前页各目录的汇总：(子孙文件的原始大小合计, 目录内最近修改时间)。修改时间含子目录与目录标记，空目录取标记的时间；
        由桶和路径范围限制查询，不读取文件内容。"""
        prefixes = list(dict.fromkeys(prefixes))
        for prefix in prefixes:
            self._check_scope(scope, prefix)
            if not prefix.endswith("/"):
                raise ValueError("folder path must end with /")
        if not prefixes:
            return {}
        def read():
            summary: dict[str, tuple[int, float | None]] = {}
            # 限制 SQL 参数数量；范围连接使用已有的桶 / 键索引，隐式目录和空目录也能统计。
            for start in range(0, len(prefixes), 200):
                batch = prefixes[start:start + 200]
                values = ",".join("(?,?)" for _ in batch)
                params = [value for prefix in batch for value in (prefix, prefix + self._PREFIX_END)]
                rows = self.metadata.db.execute(
                    f"WITH folders(prefix,upper_key) AS (VALUES {values}) "
                    "SELECT f.prefix,COALESCE(SUM(CASE WHEN substr(o.key,-1)!='/' THEN o.size END),0) AS size,"
                    "MAX(o.modified_at) AS modified FROM folders f "
                    "LEFT JOIN objects o ON o.bucket_id=? AND o.key>=f.prefix AND o.key<f.upper_key GROUP BY f.prefix",
                    (*params, scope.bucket_id))
                summary.update((row["prefix"], (int(row["size"]), row["modified"])) for row in rows)
            return summary
        return self.metadata.cached_read(("folder-summary", scope.bucket_id, tuple(prefixes)), read)

    def folder_sizes(self, scope: Scope, prefixes: list[str]) -> dict[str, int]:
        return {prefix: size for prefix, (size, _) in self.folder_summary(scope, prefixes).items()}

    def folder_modified(self, scope: Scope, prefixes: list[str]) -> dict[str, float | None]:
        return {prefix: modified for prefix, (_, modified) in self.folder_summary(scope, prefixes).items()}

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
        if scope.authorize is not None:
            scope.authorize()
        if effective.startswith((PRIVATE_PREFIX, PRIVATE_TRASH_PREFIX)) and not scope.private_access:
            raise PermissionError("私密空间需要单独解锁")
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
                protected = next((p for p in (PRIVATE_PREFIX, PRIVATE_TRASH_PREFIX) if key.startswith(p)), None)
                if protected and not scope.private_access:
                    position, inclusive, jumped = protected + self._PREFIX_END, False, True
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

    async def apreview_list(self, scope: Scope, key: str, cursor: str | None = None, limit: int = 200) -> ListPage:
        """分页读取预览文件所在目录；媒体类型与浏览器可播放性由前端统一判断。"""
        def read():
            info = self.head_object(scope, key)
            if info.key.endswith("/") or key.startswith(".tgdrive/"):
                raise ValueError("只能读取普通文件的播放列表")
            directory = key.rpartition("/")[0] + "/" if "/" in key else ""
            return self.list_objects(scope, directory, "/", cursor, max(1, min(limit, 200)))
        return await self.metadata.run_in_thread(read)

    def preview_assets(self, scope: Scope, key: str) -> list[dict[str, object]]:
        """按同目录、同主文件名查找歌词和字幕，不依赖文件列表当前页。"""
        info = self.head_object(scope, key)
        if info.key.endswith("/") or (key.startswith(".tgdrive/") and not scope.private_access):
            raise ValueError("只能查找普通文件的预览附件")
        directory, _, name = key.rpartition("/")
        stem, dot, _ = name.rpartition(".")
        if not dot or not stem:
            return []
        prefix = (directory + "/" if directory else "") + stem + "."
        # bucket_id/key 索引限定同名范围；过滤子目录，并限制附件数量与大小。
        assets = []
        cursor = prefix
        while len(assets) < 32:
            rows = self.metadata.db.execute(
                "SELECT key,size,etag FROM objects WHERE bucket_id=? AND key>? AND key<? "
                "AND instr(substr(key,?),'/')=0 AND lower(substr(key,-4)) IN ('.lrc','.srt','.vtt') "
                "AND size<=? ORDER BY key LIMIT 64",
                (scope.bucket_id, cursor, prefix + self._PREFIX_END, len(prefix) + 1, 2 * 1024 * 1024)).fetchall()
            if not rows:
                break
            cursor = rows[-1]["key"]
            for row in rows:
                self._check_scope(scope, row["key"])
                suffix = row["key"][len(prefix):]
                language, separator, extension = suffix.rpartition(".")
                if separator and not language:
                    continue
                # 允许语言标记；不把「电影.续集.srt」误关联给「电影.mp4」。
                if language and not re.fullmatch(r"[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*", language):
                    continue
                assets.append({"path": row["key"], "name": row["key"].rsplit("/", 1)[-1],
                               "kind": "lyrics" if extension.lower() == "lrc" else "subtitle",
                               "language": language.replace("_", "-") or None,
                               "size": row["size"], "etag": row["etag"]})
                if len(assets) == 32:
                    break
        return assets

    async def apreview_assets(self, scope: Scope, key: str) -> list[dict[str, object]]:
        return await self.metadata.run_in_thread(self.preview_assets, scope, key)

    async def copy_object(self, src: Scope, src_key: str, dst: Scope, dst_key: str,
                          *, metadata: dict[str, str] | None = None, content_type: str | None = None) -> ObjectInfo:
        """服务端复制：新对象引用同一个加密 Blob，不搬运数据；目标的公开链接按覆盖写入规则保留。"""
        source = self._lookup(src, src_key)
        self._check_scope(dst, dst_key, write=True)
        if source["blob_uuid"] is None:
            return await self.put_directory_marker(dst, dst_key)
        return self._commit_blob(dst.bucket_id, dst_key, source["blob_uuid"], source["size"], source["etag"],
                                 content_type if content_type is not None else source["content_type"],
                                 metadata if metadata is not None else json.loads(source["user_meta"] or "{}"), scope=dst)

    def move_prefix(self, scope: Scope, old: str, new: str, conflict: str = "skip") -> int:
        return self.move(scope, old, new, conflict).moved

    def move(self, scope: Scope, old: str, new: str, conflict: str = "skip", *, revoke_public: bool = False) -> MoveResult:
        """移动单个文件（old 不以 / 结尾，精确匹配）或整个文件夹（old 以 / 结尾，前缀匹配）。

        文件夹之间的同名目录标记直接合并；文件冲突按 conflict 处理，skip 时计入 skipped。
        """
        self._check_scope(scope, old, write=True)
        self._check_scope(scope, new, write=True)
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
            # 查询必须带上界：文件精确匹配，文件夹限定在前缀范围内。只写 key>=? 会扫描并读出桶里其后的全部对象，
            # 批量移入回收站时每一项都扫一遍整个桶。
            rows = db.execute("SELECT * FROM objects WHERE bucket_id=? AND key>=? AND key<? ORDER BY key",
                              (scope.bucket_id, old, old + self._PREFIX_END)).fetchall() if folder else \
                db.execute("SELECT * FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, old)).fetchall()
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
                            self._release_blob(db, existing["blob_uuid"], now, scope.bucket_id)
                        db.execute("UPDATE buckets SET used_bytes = used_bytes - ? WHERE id=?",
                                   (existing["size"], scope.bucket_id))
                    else:
                        target = self._free_name(db, scope.bucket_id, target, {t for _, t in moves})
                # 目录移动会给每个子项增加目标前缀，事务提交前也要校验最终路径长度。
                self._check_scope(replace(scope, authorize=None), target, write=True)
                moves.append((row["key"], target))
            token = f"\x01tgdrive-move-{secrets.token_hex(8)}"
            for old_key, _ in moves:
                db.execute("UPDATE objects SET key=? WHERE bucket_id=? AND key=?", (token + old_key, scope.bucket_id, old_key))
            for old_key, target in moves:
                db.execute("UPDATE objects SET key=? WHERE bucket_id=? AND key=?", (target, scope.bucket_id, token + old_key))
                if revoke_public:
                    db.execute("UPDATE objects SET public_token=NULL,public_at=NULL,public_expires_at=NULL,"
                               "public_password=NULL,public_downloads=0 WHERE bucket_id=? AND key=?", (scope.bucket_id, target))
            # 下载任务的目标也是文件系统路径；移动目录时同步未完成任务和已移动成品的位置。
            actual_moves = dict(moves)
            tasks = db.execute("SELECT id,key,status,upload_id FROM offline_tasks WHERE bucket_id=? AND key>=? AND key<?",
                               (scope.bucket_id, old, old + self._PREFIX_END)).fetchall() if folder else \
                db.execute("SELECT id,key,status,upload_id FROM offline_tasks WHERE bucket_id=? AND key=?",
                           (scope.bucket_id, old)).fetchall()
            for task in tasks:
                task_key = task["key"]
                if folder:
                    if not task_key.startswith(old):
                        continue
                    if task["status"] == "completed":
                        target = actual_moves.get(task_key)
                        if target is None:
                            continue
                    else:
                        target = new + task_key[len(old):]
                else:
                    if task_key != old:
                        continue
                    target = actual_moves.get(task_key)
                    if target is None:
                        # 冲突策略跳过了成品文件，就不能把已完成任务的位置也改掉。
                        if task["status"] == "completed":
                            continue
                        target = new
                db.execute("UPDATE offline_tasks SET key=?,updated_at=? WHERE id=?", (target, now, task["id"]))
                if task["upload_id"]:
                    db.execute("UPDATE uploads SET key=? WHERE upload_id=?", (target, task["upload_id"]))
            if scope.authorize is not None:
                scope.authorize()
            result = MoveResult(len(moves), skipped)
        self._changed(scope.bucket_id)
        return result

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
        self._cache_upload(blob_uuid, key, content_type)
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
        if self.engine.thumbnail_cache is not None:
            self._cache_upload(row["blob_uuid"], row["key"], row["content_type"] if "content_type" in row.keys() else None)
        # 同一次分段上传中其他分段已占用的大小也计入预检。
        others = self.metadata.db.execute("SELECT COALESCE(SUM(size),0) FROM upload_parts WHERE upload_id=? AND part_no!=?",
                                          (upload_id, part_no)).fetchone()[0]
        body = self._guard_quota(body, self._quota_room(scope.bucket_id, row["key"], reserved=int(others)), size)
        result = await self.engine.put_part(row["blob_uuid"], part_no, body, bucket_id=scope.bucket_id)
        if size is not None and size != result.size:
            raise ValueError("part size does not match request")
        self._check_scope(scope, row["key"], write=True)
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
        self._check_scope(scope, upload["key"], write=True)
        info = self._commit_blob(scope.bucket_id, upload["key"], upload["blob_uuid"], blob_size, combined,
                                 upload["content_type"], json.loads(upload["user_meta"] or "{}"), scope=scope, dedupe=True)
        with self.metadata.transaction() as db:
            # 合并到已有 Blob 时，上传记录（幂等重试用）改指向它，才能删除刚写入的这份。
            db.execute("UPDATE uploads SET completed_at=?, result_etag=?, blob_uuid=? WHERE upload_id=?",
                       (time.time(), combined, info.blob_uuid, upload_id))
        if info.blob_uuid != upload["blob_uuid"]:
            await self.engine.delete(upload["blob_uuid"])
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
