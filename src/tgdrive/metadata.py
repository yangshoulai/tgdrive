"""SQLite 元数据访问层（M1 基础表）。"""

from __future__ import annotations

import asyncio
import base64
import json
import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from pathlib import Path

from .errors import BlobNotFound, NotFoundError


@dataclass(frozen=True)
class BlobRecord:
    uuid: str
    size: int | None
    chunk_size: int
    frame_size: int
    wrapped_dek: bytes
    status: str
    refcount: int


@dataclass(frozen=True)
class ChunkRecord:
    blob_uuid: str
    part_no: int
    sub_idx: int
    offset: int | None
    plain_size: int
    cipher_size: int
    salt: bytes
    cipher_sha256: str
    blob_ref: str


class Metadata:
    """短事务 SQLite 访问层；连接按实例复用，写事务由锁串行化。"""

    SCHEMA_VERSION = 22

    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        self._lock = threading.RLock()
        self._thread = threading.local()
        self._cache_lock = threading.Lock()
        self._read_cache: dict[tuple, tuple[float, object]] = {}
        self._revision = 0
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("PRAGMA journal_mode = WAL")
        # 统一设置 SQLite 的等待和同步策略：同一进程由 RLock 串行写入，短暂的
        # 外部锁竞争应等待而不是立即失败；WAL 下 NORMAL 已足够保护事务提交。
        self.db.execute("PRAGMA busy_timeout = 5000")
        self.db.execute("PRAGMA synchronous = NORMAL")
        self._migrate()

    @property
    def db(self) -> sqlite3.Connection:
        return getattr(self._thread, "db", self._db)

    def close(self) -> None:
        self.db.close()

    def _migrate(self) -> None:
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version > self.SCHEMA_VERSION:
            raise RuntimeError(f"数据库版本 {version} 高于程序支持的 {self.SCHEMA_VERSION}")
        if 0 < version < self.SCHEMA_VERSION and self.path != ":memory:":
            backup = f"{self.path}.v{version}.{time.time_ns()}.bak"
            self.db.execute("VACUUM INTO ?", (backup,))
        with self.transaction() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > self.SCHEMA_VERSION:
                raise RuntimeError(f"数据库版本 {version} 高于程序支持的 {self.SCHEMA_VERSION}")
            if version < 1:
                self._schema(
                    """
                    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS keys(
                        id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL,
                        kdf_salt BLOB NOT NULL, kdf_params TEXT NOT NULL, check_blob BLOB NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS blobs(
                        uuid TEXT PRIMARY KEY, size INTEGER, chunk_size INTEGER NOT NULL,
                        frame_size INTEGER NOT NULL, wrapped_dek BLOB NOT NULL,
                        status TEXT NOT NULL CHECK(status IN ('uploading','complete')),
                        refcount INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS chunks(
                        blob_uuid TEXT NOT NULL REFERENCES blobs(uuid) ON DELETE CASCADE,
                        part_no INTEGER NOT NULL, sub_idx INTEGER NOT NULL, offset INTEGER,
                        plain_size INTEGER NOT NULL, cipher_size INTEGER NOT NULL,
                        salt BLOB NOT NULL, cipher_sha256 TEXT NOT NULL, blob_ref TEXT NOT NULL,
                        PRIMARY KEY(blob_uuid, part_no, sub_idx)
                    );
                    CREATE INDEX IF NOT EXISTS chunks_by_offset ON chunks(blob_uuid, offset);
                    CREATE TABLE IF NOT EXISTS gc_queue(
                        id INTEGER PRIMARY KEY, blob_ref TEXT NOT NULL, enqueued_at REAL NOT NULL,
                        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
                    );
                    """
                )
                db.execute("PRAGMA user_version = 2")
            if version < 3:
                self._schema(
                    """
                    CREATE TABLE IF NOT EXISTS buckets(
                        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                        owner_user_id INTEGER, quota_bytes INTEGER,
                        used_bytes INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS objects(
                        bucket_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
                        key TEXT NOT NULL, blob_uuid TEXT REFERENCES blobs(uuid),
                        size INTEGER NOT NULL, etag TEXT NOT NULL, content_type TEXT,
                        user_meta TEXT, modified_at REAL NOT NULL,
                        PRIMARY KEY(bucket_id, key)
                    ) WITHOUT ROWID;
                    CREATE INDEX IF NOT EXISTS objects_by_bucket_key ON objects(bucket_id, key);
                    CREATE TABLE IF NOT EXISTS uploads(
                        upload_id TEXT PRIMARY KEY, bucket_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
                        key TEXT NOT NULL, blob_uuid TEXT NOT NULL REFERENCES blobs(uuid), content_type TEXT,
                        user_meta TEXT, created_at REAL NOT NULL, last_activity REAL NOT NULL,
                        completed_at REAL, result_etag TEXT
                    );
                    CREATE TABLE IF NOT EXISTS upload_parts(
                        upload_id TEXT NOT NULL REFERENCES uploads(upload_id) ON DELETE CASCADE,
                        part_no INTEGER NOT NULL CHECK(part_no BETWEEN 1 AND 10000),
                        size INTEGER NOT NULL, md5 TEXT NOT NULL, uploaded_at REAL NOT NULL,
                        PRIMARY KEY(upload_id, part_no)
                    );
                    """
                )
                db.execute("PRAGMA user_version = 3")
            if version < 4:
                self._schema(
                    """
                    CREATE TABLE IF NOT EXISTS clients(
                        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
                        owner_user_id INTEGER, status TEXT NOT NULL CHECK(status IN ('active','disabled')),
                        created_at REAL NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS client_keys(
                        access_key_id TEXT PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
                        secret_enc BLOB NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','disabled')),
                        created_at REAL NOT NULL, last_used_at REAL
                    );
                    CREATE TABLE IF NOT EXISTS client_grants(
                        client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
                        bucket_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
                        prefix TEXT NOT NULL DEFAULT '', perms TEXT NOT NULL CHECK(perms IN ('ro','rw')),
                        PRIMARY KEY(client_id,bucket_id,prefix)
                    );
                    """
                )
                db.execute("PRAGMA user_version = 4")
            if version < 5:
                self._schema(
                    """
                    CREATE TABLE IF NOT EXISTS users(
                        id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                        password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')),
                        status TEXT NOT NULL CHECK(status IN ('active','disabled')),
                        bucket_id INTEGER REFERENCES buckets(id), created_at REAL NOT NULL, last_login_at REAL
                    );
                    CREATE INDEX IF NOT EXISTS users_by_bucket ON users(bucket_id);
                    CREATE TABLE IF NOT EXISTS audit_log(
                        id INTEGER PRIMARY KEY, ts REAL NOT NULL, actor_type TEXT NOT NULL,
                        actor TEXT, action TEXT NOT NULL, target TEXT, ip TEXT, ok INTEGER NOT NULL, detail TEXT
                    );
                    """
                )
                db.execute("PRAGMA user_version = 5")
            if version < 6:
                self._schema(
                    """
                    CREATE TABLE IF NOT EXISTS telegram_bots(
                        id INTEGER PRIMARY KEY,
                        name TEXT NOT NULL UNIQUE,
                        token_enc BLOB NOT NULL,
                        channel_id TEXT NOT NULL,
                        status TEXT NOT NULL CHECK(status IN ('active','disabled')),
                        created_at REAL NOT NULL,
                        last_check_at REAL,
                        last_check_status TEXT
                    );
                    CREATE INDEX IF NOT EXISTS telegram_bots_by_status ON telegram_bots(status);
                    """
                )
                db.execute("PRAGMA user_version = 6")
            if version < 7:
                # 公开链接令牌跟随对象行：移动时保留，删除时随行消失，覆盖写入由对象服务继承。
                self._schema(
                    """
                    ALTER TABLE objects ADD COLUMN public_token TEXT;
                    ALTER TABLE objects ADD COLUMN public_at REAL;
                    CREATE UNIQUE INDEX IF NOT EXISTS objects_by_public_token
                        ON objects(public_token) WHERE public_token IS NOT NULL
                    """
                )
                db.execute("PRAGMA user_version = 7")
            if version < 8:
                # 分享有效期、访问密码（Argon2id 哈希）与下载次数；回收站条目。
                self._schema(
                    """
                    ALTER TABLE objects ADD COLUMN public_expires_at REAL;
                    ALTER TABLE objects ADD COLUMN public_password TEXT;
                    ALTER TABLE objects ADD COLUMN public_downloads INTEGER NOT NULL DEFAULT 0;
                    CREATE TABLE IF NOT EXISTS trash(
                        id TEXT PRIMARY KEY,
                        bucket_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
                        original_path TEXT NOT NULL,
                        is_folder INTEGER NOT NULL,
                        size INTEGER NOT NULL,
                        item_count INTEGER NOT NULL,
                        deleted_at REAL NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS trash_by_bucket ON trash(bucket_id, deleted_at)
                    """
                )
                db.execute("PRAGMA user_version = 8")
            if version < 9:
                # 秒传：Blob 的内容指纹（见 fingerprint.py），以及分段上传时各分段的块哈希。
                # 旧版本写入的 Blob 没有指纹，不参与秒传命中。
                self._schema(
                    """
                    ALTER TABLE blobs ADD COLUMN fingerprint TEXT;
                    ALTER TABLE upload_parts ADD COLUMN leaves BLOB;
                    CREATE INDEX IF NOT EXISTS blobs_by_fingerprint ON blobs(fingerprint) WHERE fingerprint IS NOT NULL
                    """
                )
                db.execute("PRAGMA user_version = 9")
            if version < 10:
                # “保持登录”会话：只保存令牌的哈希，到期后自动清理。
                self._schema(
                    """
                    CREATE TABLE IF NOT EXISTS sessions(
                        token_hash TEXT PRIMARY KEY,
                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        csrf_token TEXT NOT NULL,
                        expires_at REAL NOT NULL,
                        created_at REAL NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id)
                    """
                )
                db.execute("PRAGMA user_version = 10")

            if version < 11:
                self._schema(
                    """
                    CREATE INDEX IF NOT EXISTS objects_admin_page ON objects(modified_at DESC,bucket_id DESC,key DESC)
                        WHERE substr(key,-1)!='/' AND substr(key,1,9)!='.tgdrive/';
                    CREATE INDEX IF NOT EXISTS objects_public_bucket ON objects(bucket_id,key) WHERE public_token IS NOT NULL;
                    CREATE INDEX IF NOT EXISTS client_keys_by_client ON client_keys(client_id,access_key_id);
                    CREATE INDEX IF NOT EXISTS trash_page ON trash(bucket_id,deleted_at DESC,id DESC);
                    CREATE INDEX IF NOT EXISTS audit_failed_page ON audit_log(id DESC) WHERE ok=0;
                    CREATE INDEX IF NOT EXISTS audit_archive_age ON audit_log(ts,id);
                    CREATE INDEX IF NOT EXISTS uploads_activity ON uploads(last_activity) WHERE completed_at IS NULL;
                    CREATE INDEX IF NOT EXISTS uploads_completed ON uploads(completed_at) WHERE completed_at IS NOT NULL
                    """
                )
                db.execute("PRAGMA user_version = 11")

            if version < 12:
                # 缩略图按 Blob 保存并加密（密钥由该 Blob 的 DEK 派生）；variant='none' 表示已尝试但无法生成。
                # 迁移时系统尚未解锁，旧版存在 user_meta 里的明文缩略图先移到 thumbnail_legacy，
                # 解锁后由维护任务或首次读取加密转入 thumbnails 并删除明文。
                self._schema(
                    """
                    CREATE TABLE IF NOT EXISTS thumbnails(
                        blob_uuid TEXT NOT NULL REFERENCES blobs(uuid) ON DELETE CASCADE,
                        variant TEXT NOT NULL CHECK(variant IN ('thumb','poster','none')),
                        mime TEXT NOT NULL, data BLOB NOT NULL, created_at REAL NOT NULL,
                        PRIMARY KEY(blob_uuid, variant)
                    ) WITHOUT ROWID;
                    CREATE TABLE IF NOT EXISTS thumbnail_legacy(
                        blob_uuid TEXT PRIMARY KEY REFERENCES blobs(uuid) ON DELETE CASCADE,
                        data BLOB NOT NULL
                    ) WITHOUT ROWID
                    """
                )
                rows = db.execute("SELECT bucket_id, key, blob_uuid, user_meta FROM objects "
                                  "WHERE user_meta LIKE '%tgdrive-thumbnail%'").fetchall()
                for row in rows:
                    meta = json.loads(row["user_meta"] or "{}")
                    encoded = meta.pop("tgdrive-thumbnail", None)
                    if encoded and row["blob_uuid"]:
                        try:
                            db.execute("INSERT OR IGNORE INTO thumbnail_legacy(blob_uuid, data) VALUES(?, ?)",
                                       (row["blob_uuid"], base64.b64decode(encoded)))
                        except (ValueError, TypeError):
                            pass
                    db.execute("UPDATE objects SET user_meta=? WHERE bucket_id=? AND key=?",
                               (json.dumps(meta, separators=(",", ":")), row["bucket_id"], row["key"]))
                db.execute("PRAGMA user_version = 12")
            if version < 13:
                self._schema("""
                    CREATE TABLE IF NOT EXISTS private_spaces(
                        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                        password_hash TEXT NOT NULL,
                        idle_seconds INTEGER NOT NULL DEFAULT 300 CHECK(idle_seconds IN (60,300,900,1800)),
                        created_at REAL NOT NULL
                    )
                """)
                db.execute("PRAGMA user_version = 13")
            if version < 14:
                self._schema("""
                    CREATE TABLE IF NOT EXISTS offline_tasks(
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        bucket_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
                        key TEXT NOT NULL, source_host TEXT NOT NULL, method TEXT NOT NULL,
                        kind TEXT NOT NULL CHECK(kind IN ('http','hls')), request_enc BLOB NOT NULL,
                        status TEXT NOT NULL CHECK(status IN ('queued','running','stopped','interrupted','completed','failed')),
                        upload_id TEXT, size INTEGER, received INTEGER NOT NULL DEFAULT 0,
                        stored_bytes INTEGER NOT NULL DEFAULT 0, segments_done INTEGER NOT NULL DEFAULT 0,
                        segments_total INTEGER NOT NULL DEFAULT 0, duration REAL,
                        processed_seconds REAL NOT NULL DEFAULT 0, error TEXT,
                        created_at REAL NOT NULL, updated_at REAL NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS offline_owner_page ON offline_tasks(user_id,id DESC);
                    CREATE INDEX IF NOT EXISTS offline_queue ON offline_tasks(status,id);
                    CREATE INDEX IF NOT EXISTS offline_upload ON offline_tasks(upload_id) WHERE upload_id IS NOT NULL
                """)
                db.execute("PRAGMA user_version = 14")
            if version < 15:
                columns = {row[1] for row in db.execute("PRAGMA table_info(offline_tasks)")}
                if "platform" not in columns:
                    db.execute("ALTER TABLE offline_tasks ADD COLUMN platform TEXT CHECK(platform IN ('x','youtube'))")
                if "phase" not in columns:
                    db.execute("ALTER TABLE offline_tasks ADD COLUMN phase TEXT")
                db.execute("PRAGMA user_version = 15")
            if version < 16:
                # 离线任务累计的实际运行时间（不含排队与等待恢复），用于完成后展示用时和平均速度。
                columns = {row[1] for row in db.execute("PRAGMA table_info(offline_tasks)")}
                if "elapsed_seconds" not in columns:
                    db.execute("ALTER TABLE offline_tasks ADD COLUMN elapsed_seconds REAL NOT NULL DEFAULT 0")
                db.execute("PRAGMA user_version = 16")
            if version < 17:
                # 凭据仅保存公钥，用户句柄是随机值；私密密码和文件加密方式保持原有约定。
                columns = {row[1] for row in db.execute("PRAGMA table_info(private_spaces)")}
                if "webauthn_user_handle" not in columns:
                    db.execute("ALTER TABLE private_spaces ADD COLUMN webauthn_user_handle BLOB")
                self._schema("""
                    CREATE TABLE IF NOT EXISTS private_passkeys(
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id INTEGER NOT NULL REFERENCES private_spaces(user_id) ON DELETE CASCADE,
                        credential_id BLOB NOT NULL UNIQUE,
                        public_key BLOB NOT NULL,
                        sign_count INTEGER NOT NULL CHECK(sign_count>=0),
                        rp_id TEXT NOT NULL,
                        name TEXT NOT NULL,
                        transports TEXT NOT NULL DEFAULT '[]',
                        backup_eligible INTEGER NOT NULL DEFAULT 0,
                        backed_up INTEGER NOT NULL DEFAULT 0,
                        created_at REAL NOT NULL,
                        last_used_at REAL
                    );
                    CREATE INDEX IF NOT EXISTS private_passkeys_user ON private_passkeys(user_id,id)
                """)
                db.execute("PRAGMA user_version = 17")
            if version < 18:
                # 统一账号凭据，保留私密文件和闲置设置；旧凭据确认登录密码后才启用登录。
                columns = {row[1] for row in db.execute("PRAGMA table_info(users)")}
                if "webauthn_user_handle" not in columns:
                    db.execute("ALTER TABLE users ADD COLUMN webauthn_user_handle BLOB")
                db.execute("UPDATE users SET webauthn_user_handle=(SELECT p.webauthn_user_handle FROM private_spaces p "
                           "WHERE p.user_id=users.id) WHERE webauthn_user_handle IS NULL")
                self._schema("""
                    CREATE TABLE IF NOT EXISTS account_passkeys(
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        credential_id BLOB NOT NULL UNIQUE,
                        public_key BLOB NOT NULL,
                        sign_count INTEGER NOT NULL CHECK(sign_count>=0),
                        rp_id TEXT NOT NULL,
                        name TEXT NOT NULL,
                        transports TEXT NOT NULL DEFAULT '[]',
                        backup_eligible INTEGER NOT NULL DEFAULT 0,
                        backed_up INTEGER NOT NULL DEFAULT 0,
                        login_enabled INTEGER NOT NULL DEFAULT 1 CHECK(login_enabled IN (0,1)),
                        created_at REAL NOT NULL,
                        last_used_at REAL
                    );
                    CREATE INDEX IF NOT EXISTS account_passkeys_user ON account_passkeys(user_id,id)
                """)
                db.execute("INSERT INTO account_passkeys(id,user_id,credential_id,public_key,sign_count,rp_id,name,"
                           "transports,backup_eligible,backed_up,login_enabled,created_at,last_used_at) "
                           "SELECT id,user_id,credential_id,public_key,sign_count,rp_id,name,transports,backup_eligible,"
                           "backed_up,0,created_at,last_used_at FROM private_passkeys")
                db.execute("DROP TABLE private_passkeys")
                columns = {row[1] for row in db.execute("PRAGMA table_info(private_spaces)")}
                for column in ("password_hash", "webauthn_user_handle"):
                    if column in columns:
                        db.execute(f"ALTER TABLE private_spaces DROP COLUMN {column}")
                db.execute("PRAGMA user_version = 18")
            if version < 19:
                # 账号资料：昵称与头像。登录名仍是 users.username，新账号要求邮箱；旧的非邮箱用户名保留，登录后引导改为邮箱。
                columns = {row[1] for row in db.execute("PRAGMA table_info(users)")}
                if "nickname" not in columns:
                    db.execute("ALTER TABLE users ADD COLUMN nickname TEXT")
                self._schema("""
                    CREATE TABLE IF NOT EXISTS user_avatars(
                        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                        mime TEXT NOT NULL,
                        data BLOB NOT NULL,
                        updated_at REAL NOT NULL
                    )
                """)
                db.execute("PRAGMA user_version = 19")
            if version < 20:
                # 文件助手（docs/assistant-design.md §14）：模型渠道、对话留痕、调用日志。正文类字段一律为加密 BLOB。
                self._schema("""
                    CREATE TABLE IF NOT EXISTS ai_channels(
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT NOT NULL,
                        kind TEXT NOT NULL CHECK(kind IN ('openai','anthropic')),
                        base_url TEXT NOT NULL,
                        secret BLOB,
                        headers BLOB,
                        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
                        concurrency INTEGER NOT NULL DEFAULT 4,
                        timeout INTEGER NOT NULL DEFAULT 120,
                        synced_at REAL,
                        sync_note TEXT,
                        last_error TEXT,
                        created_at REAL NOT NULL,
                        updated_at REAL NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS ai_models(
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        channel_id INTEGER NOT NULL REFERENCES ai_channels(id) ON DELETE CASCADE,
                        model TEXT NOT NULL,
                        display_name TEXT,
                        source TEXT NOT NULL CHECK(source IN ('auto','manual')),
                        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
                        tools TEXT NOT NULL DEFAULT 'unknown' CHECK(tools IN ('unknown','yes','no')),
                        context_window INTEGER,
                        max_output INTEGER,
                        removed_upstream INTEGER NOT NULL DEFAULT 0,
                        sort INTEGER NOT NULL DEFAULT 0,
                        tested_at REAL,
                        test_note TEXT,
                        created_at REAL NOT NULL,
                        UNIQUE(channel_id, model)
                    );
                    CREATE TABLE IF NOT EXISTS ai_user_policy(
                        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                        enabled INTEGER,
                        max_level TEXT CHECK(max_level IN ('read','write','danger')),
                        daily_tokens INTEGER,
                        notice_ack_at REAL
                    );
                    CREATE TABLE IF NOT EXISTS assistant_conversations(
                        id TEXT PRIMARY KEY,
                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        title BLOB,
                        scope_root TEXT NOT NULL,
                        model_id INTEGER,
                        archived INTEGER NOT NULL DEFAULT 0,
                        messages INTEGER NOT NULL DEFAULT 0,
                        input_tokens INTEGER NOT NULL DEFAULT 0,
                        output_tokens INTEGER NOT NULL DEFAULT 0,
                        hidden_at REAL,
                        created_at REAL NOT NULL,
                        updated_at REAL NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS assistant_conversations_by_user ON assistant_conversations(user_id, updated_at DESC, id);
                    CREATE INDEX IF NOT EXISTS assistant_conversations_by_age ON assistant_conversations(updated_at);
                    CREATE TABLE IF NOT EXISTS assistant_runs(
                        id TEXT PRIMARY KEY,
                        conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
                        model_id INTEGER,
                        prompt_version TEXT,
                        status TEXT NOT NULL,
                        stop_reason TEXT,
                        steps INTEGER NOT NULL DEFAULT 0,
                        tool_calls INTEGER NOT NULL DEFAULT 0,
                        input_tokens INTEGER NOT NULL DEFAULT 0,
                        output_tokens INTEGER NOT NULL DEFAULT 0,
                        started_at REAL NOT NULL,
                        ended_at REAL
                    );
                    CREATE INDEX IF NOT EXISTS assistant_runs_by_conversation ON assistant_runs(conversation_id, started_at);
                    CREATE INDEX IF NOT EXISTS assistant_runs_by_status ON assistant_runs(status);
                    CREATE TABLE IF NOT EXISTS assistant_messages(
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
                        run_id TEXT,
                        seq INTEGER NOT NULL,
                        role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','event')),
                        tool_name TEXT,
                        body BLOB NOT NULL,
                        created_at REAL NOT NULL,
                        UNIQUE(conversation_id, seq)
                    );
                    CREATE TABLE IF NOT EXISTS assistant_actions(
                        id TEXT PRIMARY KEY,
                        conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
                        run_id TEXT,
                        user_id INTEGER NOT NULL,
                        session_hash TEXT NOT NULL,
                        kind TEXT NOT NULL,
                        tool_name TEXT,
                        status TEXT NOT NULL,
                        count INTEGER NOT NULL DEFAULT 0,
                        payload BLOB NOT NULL,
                        result BLOB,
                        undo BLOB,
                        compacted INTEGER NOT NULL DEFAULT 0,
                        created_at REAL NOT NULL,
                        expires_at REAL NOT NULL,
                        decided_at REAL,
                        finished_at REAL
                    );
                    CREATE INDEX IF NOT EXISTS assistant_actions_by_status ON assistant_actions(status, expires_at);
                    CREATE INDEX IF NOT EXISTS assistant_actions_by_conversation ON assistant_actions(conversation_id, created_at);
                    CREATE TABLE IF NOT EXISTS assistant_collections(
                        id TEXT PRIMARY KEY,
                        conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
                        user_id INTEGER NOT NULL,
                        kind TEXT NOT NULL CHECK(kind IN ('collection','snapshot')),
                        source TEXT,
                        rule BLOB,
                        urls BLOB NOT NULL,
                        count INTEGER NOT NULL,
                        created_at REAL NOT NULL,
                        expires_at REAL NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS assistant_collections_by_expiry ON assistant_collections(expires_at);
                    CREATE TABLE IF NOT EXISTS assistant_usage(
                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        day TEXT NOT NULL,
                        model_id INTEGER NOT NULL DEFAULT 0,
                        input_tokens INTEGER NOT NULL DEFAULT 0,
                        output_tokens INTEGER NOT NULL DEFAULT 0,
                        runs INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY(user_id, day, model_id)
                    );
                    CREATE TABLE IF NOT EXISTS assistant_calls(
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        kind TEXT NOT NULL CHECK(kind IN ('model','tool','fetch','sync','test')),
                        run_id TEXT,
                        conversation_id TEXT,
                        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                        actor TEXT,
                        channel_id INTEGER,
                        model_id INTEGER,
                        tool_name TEXT,
                        action_id TEXT,
                        host TEXT,
                        started_at REAL NOT NULL,
                        duration_ms INTEGER,
                        ttfb_ms INTEGER,
                        status TEXT NOT NULL,
                        http_status INTEGER,
                        error_code TEXT,
                        error TEXT,
                        input_tokens INTEGER,
                        output_tokens INTEGER,
                        cached_tokens INTEGER,
                        upstream_id TEXT,
                        items INTEGER
                    );
                    CREATE INDEX IF NOT EXISTS assistant_calls_by_time ON assistant_calls(started_at DESC, id);
                    CREATE INDEX IF NOT EXISTS assistant_calls_by_channel ON assistant_calls(channel_id, started_at DESC);
                    CREATE INDEX IF NOT EXISTS assistant_calls_by_user ON assistant_calls(user_id, started_at DESC)
                """)
                db.execute("PRAGMA user_version = 20")
            if version < 21:
                # 文件助手 P5（docs/assistant-design.md §19）：模型目录、渠道模型的目录信息与价格、对话访问模式。
                self._schema("""
                    CREATE TABLE IF NOT EXISTS ai_catalog(
                        id TEXT PRIMARY KEY,
                        provider TEXT NOT NULL,
                        model TEXT NOT NULL,
                        name TEXT,
                        family TEXT,
                        context_window INTEGER,
                        max_output INTEGER,
                        input_price REAL,
                        output_price REAL,
                        cache_price REAL,
                        capabilities TEXT NOT NULL DEFAULT '{}',
                        knowledge TEXT,
                        released TEXT,
                        source TEXT NOT NULL,
                        updated_at REAL NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS ai_catalog_by_model ON ai_catalog(model)
                """)
                for table, column, definition in (
                        ("ai_models", "catalog_id", "TEXT"), ("ai_models", "input_price", "REAL"), ("ai_models", "output_price", "REAL"),
                        ("ai_models", "capabilities", "TEXT NOT NULL DEFAULT '{}'"),
                        ("ai_models", "manual_fields", "TEXT NOT NULL DEFAULT '[]'"),
                        ("ai_user_policy", "full_access", "INTEGER"),
                        ("assistant_conversations", "access_mode", "TEXT NOT NULL DEFAULT 'approval'")):
                    if column not in {row[1] for row in db.execute(f"PRAGMA table_info({table})")}:
                        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
                db.execute("PRAGMA user_version = 21")
            if version < 22:
                # 文件助手对话附件（docs/assistant-design.md §22.5）：对象存于 .tgdrive/assistant/<id>/，这里登记归属与对话。
                self._schema("""
                    CREATE TABLE IF NOT EXISTS assistant_attachments(
                        id TEXT PRIMARY KEY,
                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        bucket_id INTEGER NOT NULL,
                        key TEXT NOT NULL,
                        name TEXT NOT NULL,
                        size INTEGER NOT NULL,
                        content_type TEXT,
                        conversation_id TEXT,
                        message_seq INTEGER,
                        created_at REAL NOT NULL,
                        bound_at REAL
                    );
                    CREATE INDEX IF NOT EXISTS assistant_attachments_by_user ON assistant_attachments(user_id, conversation_id);
                    CREATE INDEX IF NOT EXISTS assistant_attachments_by_conversation ON assistant_attachments(conversation_id, message_seq)
                """)
                db.execute("PRAGMA user_version = 22")

    def cached_read(self, key: tuple, function, *, ttl: float = 2):
        """短期复用统计结果；提交写事务立即失效，缓存大小有界。"""
        now = time.monotonic()
        with self._cache_lock:
            revision = self._revision
            cached = self._read_cache.get(key)
            if cached is not None and cached[0] > now:
                return cached[1]
        result = function()
        with self._cache_lock:
            if revision == self._revision:
                if len(self._read_cache) >= 256:
                    self._read_cache.pop(next(iter(self._read_cache)))
                self._read_cache[key] = (now + ttl, result)
        return result

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with (nullcontext() if hasattr(self._thread, "db") else self._lock):
            nested = self.db.in_transaction
            savepoint = f"tx_{time.time_ns()}"
            try:
                self.db.execute(f"SAVEPOINT {savepoint}" if nested else "BEGIN IMMEDIATE")
                yield self.db
                if nested:
                    self.db.execute(f"RELEASE SAVEPOINT {savepoint}")
                else:
                    self.db.commit()
                    with self._cache_lock:
                        self._revision += 1
                        self._read_cache.clear()
            except BaseException:
                if nested:
                    self.db.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                    self.db.execute(f"RELEASE SAVEPOINT {savepoint}")
                else:
                    self.db.rollback()
                raise

    async def run_in_thread(self, function, /, *args, **kwargs):
        """在线程池和独立连接中执行重查询或批量事务。

        磁盘数据库使用 WAL 独立连接，避免慢查询持有主连接锁，也避免其他
        请求读到线程中尚未提交的事务。纯内存数据库仅供测试，保持原连接。
        """
        def call():
            if self.path == ":memory:":
                with self._lock:
                    return function(*args, **kwargs)
            connection = sqlite3.connect(self.path, timeout=5)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA synchronous = NORMAL")
            self._thread.db = connection
            try:
                return function(*args, **kwargs)
            finally:
                del self._thread.db
                connection.close()
        return await asyncio.to_thread(call)

    def _schema(self, script: str) -> None:
        # executescript 会隐式提交，必须逐条执行以保持迁移原子性。
        for statement in script.split(";"):
            if statement.strip():
                self.db.execute(statement)

    def create_blob(self, record: BlobRecord, created_at: float) -> None:
        with self.transaction() as db:
            db.execute(
                "INSERT INTO blobs(uuid,size,chunk_size,frame_size,wrapped_dek,status,refcount,created_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (record.uuid, record.size, record.chunk_size, record.frame_size,
                 record.wrapped_dek, record.status, record.refcount, created_at),
            )

    def get_blob(self, blob_uuid: str) -> BlobRecord:
        row = self.db.execute("SELECT * FROM blobs WHERE uuid = ?", (blob_uuid,)).fetchone()
        if row is None:
            raise BlobNotFound(blob_uuid)
        return BlobRecord(row["uuid"], row["size"], row["chunk_size"], row["frame_size"],
                          row["wrapped_dek"], row["status"], row["refcount"])

    def list_chunks(self, blob_uuid: str, *, part_no: int | None = None) -> list[ChunkRecord]:
        sql = "SELECT * FROM chunks WHERE blob_uuid = ?"
        args: list[object] = [blob_uuid]
        if part_no is not None:
            sql += " AND part_no = ?"
            args.append(part_no)
        sql += " ORDER BY part_no, sub_idx"
        return [self._chunk(row) for row in self.db.execute(sql, args)]

    def chunks_covering(self, blob_uuid: str, start: int, end: int) -> list[ChunkRecord]:
        """返回覆盖明文半开区间 [start, end) 的已定稿分片。"""
        if start < 0 or end < start:
            raise ValueError("invalid range")
        rows = self.db.execute(
            "SELECT * FROM chunks WHERE blob_uuid = ? AND offset IS NOT NULL "
            "AND offset + plain_size > ? AND offset < ? ORDER BY offset",
            (blob_uuid, start, end),
        )
        return [self._chunk(row) for row in rows]

    @staticmethod
    def _chunk(row: sqlite3.Row) -> ChunkRecord:
        return ChunkRecord(row["blob_uuid"], row["part_no"], row["sub_idx"], row["offset"],
                           row["plain_size"], row["cipher_size"], row["salt"],
                           row["cipher_sha256"], row["blob_ref"])

    def replace_part(self, blob_uuid: str, part_no: int, chunks: list[ChunkRecord], old_refs: list[str], now: float) -> None:
        with self.transaction() as db:
            db.execute("DELETE FROM chunks WHERE blob_uuid = ? AND part_no = ?", (blob_uuid, part_no))
            for ref in old_refs:
                db.execute("INSERT INTO gc_queue(blob_ref,enqueued_at) VALUES(?,?)", (ref, now))
            db.executemany(
                "INSERT INTO chunks(blob_uuid,part_no,sub_idx,offset,plain_size,cipher_size,salt,cipher_sha256,blob_ref) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                [(c.blob_uuid, c.part_no, c.sub_idx, c.offset, c.plain_size, c.cipher_size,
                  c.salt, c.cipher_sha256, c.blob_ref) for c in chunks],
            )

    def set_fingerprint(self, blob_uuid: str, fingerprint: str | None) -> None:
        with self.transaction() as db:
            db.execute("UPDATE blobs SET fingerprint = ? WHERE uuid = ?", (fingerprint, blob_uuid))

    def finalize_blob(self, blob_uuid: str, part_order: list[int]) -> int:
        with self.transaction() as db:
            row = db.execute("SELECT status FROM blobs WHERE uuid = ?", (blob_uuid,)).fetchone()
            if row is None:
                raise BlobNotFound(blob_uuid)
            if row["status"] == "complete":
                return int(db.execute("SELECT size FROM blobs WHERE uuid = ?", (blob_uuid,)).fetchone()[0])
            existing_parts = {r[0] for r in db.execute(
                "SELECT DISTINCT part_no FROM chunks WHERE blob_uuid = ?", (blob_uuid,)
            )}
            if existing_parts != set(part_order):
                raise NotFoundError("part_order does not include exactly the uploaded parts")
            all_chunks = []
            for part in part_order:
                part_chunks = list(db.execute(
                    "SELECT * FROM chunks WHERE blob_uuid = ? AND part_no = ? ORDER BY sub_idx",
                    (blob_uuid, part),
                ))
                if not part_chunks:
                    raise NotFoundError(f"part {part} not found")
                all_chunks.extend(part_chunks)
            offset = 0
            for row in all_chunks:
                db.execute("UPDATE chunks SET offset = ? WHERE blob_uuid = ? AND part_no = ? AND sub_idx = ?",
                           (offset, blob_uuid, row["part_no"], row["sub_idx"]))
                offset += row["plain_size"]
            db.execute("UPDATE blobs SET size = ?, status = 'complete' WHERE uuid = ?", (offset, blob_uuid))
            return offset

    def enqueue_refs(self, refs: list[str], now: float) -> None:
        if not refs:
            return
        with self.transaction() as db:
            db.executemany("INSERT INTO gc_queue(blob_ref,enqueued_at) VALUES(?,?)", ((r, now) for r in refs))

    def delete_blob(self, blob_uuid: str, now: float) -> None:
        with self.transaction() as db:
            refs = [r[0] for r in db.execute("SELECT blob_ref FROM chunks WHERE blob_uuid = ?", (blob_uuid,))]
            db.executemany("INSERT INTO gc_queue(blob_ref,enqueued_at) VALUES(?,?)", ((r, now) for r in refs))
            db.execute("DELETE FROM blobs WHERE uuid = ?", (blob_uuid,))

    def get_key_row(self) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM keys WHERE id = 1").fetchone()

    def put_key_row(self, version: int, salt: bytes, params: dict[str, int], check_blob: bytes) -> None:
        with self.transaction() as db:
            db.execute("INSERT OR REPLACE INTO keys(id,version,kdf_salt,kdf_params,check_blob) VALUES(1,?,?,?,?)",
                       (version, salt, json.dumps(params, separators=(",", ":")), check_blob))

    def update_wrapped_deks(self, rows: list[tuple[str, bytes]]) -> None:
        with self.transaction() as db:
            db.executemany("UPDATE blobs SET wrapped_dek = ? WHERE uuid = ?", ((wrapped, uuid) for uuid, wrapped in rows))
