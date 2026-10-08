"""维护任务：GC、scrub、清理、加密元数据备份与后台调度。

每个任务都是幂等的 ``run_once`` 调用；``MaintenanceScheduler`` 在服务进程内按固定间隔
调用它们，管理员也可以在控制台手动触发。备份只包含 SQLite 元数据：密文分片仍保存在
Telegram 频道（或本地 BlobStore）中，恢复时两者都必须可用。
"""

from __future__ import annotations

import asyncio
import base64
import datetime as dt
import json
import logging
import os
import re
import secrets
import sqlite3
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from .blobengine import BlobEngine
from .blobstore import BlobStore
from .crypto import KdfParams, derive_kek, derive_subkey, open_sealed, seal, verify_check_blob
from .keystore import KeyStore
from .metadata import Metadata

log = logging.getLogger("tgdrive.maintenance")


@dataclass(frozen=True)
class GcReport:
    processed: int
    deleted: int
    failed: int
    dead: int = 0


@dataclass(frozen=True)
class ScrubReport:
    checked: int
    bad: list[tuple[str, list[tuple[int, int]]]]
    wrapped: bool = False


@dataclass(frozen=True)
class CleanupReport:
    aborted_uploads: int
    stale_blobs: int
    expired_upload_records: int


def _get_state(metadata: Metadata, key: str, default=None):
    row = metadata.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except ValueError:
        return default


def _set_state(metadata: Metadata, key: str, value) -> None:
    with metadata.transaction() as db:
        db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (key, json.dumps(value, ensure_ascii=False, separators=(",", ":"))))


class GarbageCollector:
    # 失败超过这个次数的条目不再重试，避免永久失败的条目堵住队列头部。
    MAX_ATTEMPTS = 8

    def __init__(self, metadata: Metadata, store: BlobStore) -> None:
        self.metadata, self.store = metadata, store

    def dead_count(self) -> int:
        return int(self.metadata.db.execute("SELECT COUNT(*) FROM gc_queue WHERE attempts >= ?",
                                            (self.MAX_ATTEMPTS,)).fetchone()[0])

    async def run_once(self, *, limit: int = 100) -> GcReport:
        if limit <= 0:
            raise ValueError("limit must be positive")
        # 按失败次数优先处理新条目：失败过的条目排在后面，不会挡住其他分片的回收。
        rows = self.metadata.db.execute(
            "SELECT id,blob_ref FROM gc_queue WHERE attempts < ? ORDER BY attempts, id LIMIT ?",
            (self.MAX_ATTEMPTS, limit),
        ).fetchall()
        deleted = failed = 0
        for row in rows:
            try:
                await self.store.delete(row["blob_ref"])
            except Exception as exc:
                failed += 1
                with self.metadata.transaction() as db:
                    db.execute("UPDATE gc_queue SET attempts=attempts+1,last_error=? WHERE id=?",
                               (str(exc)[:1000], row["id"]))
            else:
                deleted += 1
                with self.metadata.transaction() as db:
                    db.execute("DELETE FROM gc_queue WHERE id=?", (row["id"],))
        return GcReport(len(rows), deleted, failed, self.dead_count())

    def retry_dead(self) -> int:
        """把放弃重试的条目重新放回队列（例如修复了 Bot 配置之后）。"""
        with self.metadata.transaction() as db:
            return db.execute("UPDATE gc_queue SET attempts=0 WHERE attempts >= ?", (self.MAX_ATTEMPTS,)).rowcount


class Scrubber:
    CURSOR_KEY = "maintenance.scrub_cursor"

    def __init__(self, metadata: Metadata, engine: BlobEngine) -> None:
        self.metadata, self.engine = metadata, engine

    async def run_once(self, *, limit: int = 100, deep: bool = False) -> ScrubReport:
        """从上次停下的位置继续检查，检查到末尾后从头开始，保证所有文件轮流被覆盖。"""
        if limit <= 0:
            raise ValueError("limit must be positive")
        cursor = _get_state(self.metadata, self.CURSOR_KEY)
        args: tuple = (limit,)
        where = "status='complete'"
        if cursor:
            where += " AND (created_at, uuid) > (?, ?)"
            args = (cursor[0], cursor[1], limit)
        rows = self.metadata.db.execute(
            f"SELECT uuid, created_at FROM blobs WHERE {where} ORDER BY created_at, uuid LIMIT ?", args).fetchall()
        bad: list[tuple[str, list[tuple[int, int]]]] = []
        for row in rows:
            failures = await self.engine.scrub(row["uuid"], deep=deep)
            if failures:
                bad.append((row["uuid"], failures))
        wrapped = len(rows) < limit
        _set_state(self.metadata, self.CURSOR_KEY, None if wrapped else [rows[-1]["created_at"], rows[-1]["uuid"]])
        return ScrubReport(len(rows), bad, wrapped)


class Cleaner:
    """回收中断或放弃的写入：未完成的分段上传、崩溃遗留的临时 Blob、过期的分段上传记录。"""

    def __init__(self, metadata: Metadata, *, upload_ttl: float = 7 * 86400, stale_blob_ttl: float = 2 * 86400) -> None:
        self.metadata, self.upload_ttl, self.stale_blob_ttl = metadata, upload_ttl, stale_blob_ttl

    def _discard_blob(self, db, blob_uuid: str, now: float) -> None:
        refs = [r[0] for r in db.execute("SELECT blob_ref FROM chunks WHERE blob_uuid=?", (blob_uuid,))]
        db.executemany("INSERT INTO gc_queue(blob_ref,enqueued_at) VALUES(?,?)", ((ref, now) for ref in refs))
        db.execute("DELETE FROM blobs WHERE uuid=?", (blob_uuid,))

    def run_once(self, *, now: float | None = None) -> CleanupReport:
        now = now or time.time()
        aborted = stale = expired = 0
        with self.metadata.transaction() as db:
            for row in db.execute("SELECT upload_id, blob_uuid FROM uploads WHERE completed_at IS NULL AND last_activity < ?",
                                  (now - self.upload_ttl,)).fetchall():
                db.execute("DELETE FROM uploads WHERE upload_id=?", (row["upload_id"],))
                self._discard_blob(db, row["blob_uuid"], now)
                aborted += 1
            # 已完成的记录只用于幂等重试；过期后删除记录本身，Blob 由对象继续引用。
            expired = db.execute("DELETE FROM uploads WHERE completed_at IS NOT NULL AND completed_at < ?",
                                 (now - self.upload_ttl,)).rowcount
            for row in db.execute(
                    "SELECT uuid FROM blobs b WHERE status='uploading' AND created_at < ? AND refcount = 0 "
                    "AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.blob_uuid=b.uuid)",
                    (now - self.stale_blob_ttl,)).fetchall():
                self._discard_blob(db, row["uuid"], now)
                stale += 1
        return CleanupReport(aborted, stale, expired)


class EncryptedSnapshotStore:
    MAGIC = b"TGD-SNAPSHOT-1\x00"
    # v2 在明文头部携带 KDF 盐与参数，因此只凭加密口令就能解密，不依赖被备份的数据库本身。
    MAGIC_V2 = b"TGD-SNAPSHOT-2\x00"
    AAD = b"tgdrive-snapshot-v1"

    def __init__(self, metadata: Metadata, keystore: KeyStore) -> None:
        self.metadata, self.keystore = metadata, keystore

    def _plaintext(self) -> bytes:
        with tempfile.TemporaryDirectory(prefix="tgdrive-snapshot-") as workdir:
            plain_path = Path(workdir) / "meta.db"
            target = sqlite3.connect(plain_path)
            try:
                with self.metadata._lock:  # backup 期间避免本地事务并发修改
                    self.metadata.db.backup(target)
                target.commit()
            finally:
                target.close()
            return plain_path.read_bytes()

    def create(self, destination: str | Path) -> Path:
        """生成一个原子替换的加密 SQLite 快照，并返回最终路径。"""
        destination = Path(destination).expanduser()
        destination.parent.mkdir(parents=True, exist_ok=True)
        row = self.metadata.get_key_row()
        header = json.dumps({"kdf_salt": base64.b64encode(row["kdf_salt"]).decode(), "kdf_params": json.loads(row["kdf_params"]),
                             "key_version": row["version"], "created_at": time.time()}, separators=(",", ":")).encode()
        sealed = seal(derive_subkey(self.keystore.require_kek(), "snapshot"), self._plaintext(), self.AAD + header)
        payload = self.MAGIC_V2 + len(header).to_bytes(4, "big") + header + sealed
        temporary = destination.with_name(f".{destination.name}.{secrets.token_hex(6)}.tmp")
        temporary.write_bytes(payload)
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
        return destination

    @classmethod
    def _parse(cls, payload: bytes) -> tuple[dict | None, bytes, bytes]:
        if payload.startswith(cls.MAGIC_V2):
            body = payload[len(cls.MAGIC_V2):]
            size = int.from_bytes(body[:4], "big")
            header_bytes = body[4:4 + size]
            return json.loads(header_bytes), cls.AAD + header_bytes, body[4 + size:]
        if payload.startswith(cls.MAGIC):
            return None, cls.AAD, payload[len(cls.MAGIC):]
        raise ValueError("不是 tgdrive 备份文件")

    def open(self, snapshot: str | Path) -> bytes:
        """用当前已解锁的 KEK 解密（口令未更换过时可用）。"""
        _, aad, sealed = self._parse(Path(snapshot).read_bytes())
        return open_sealed(derive_subkey(self.keystore.require_kek(), "snapshot"), sealed, aad)

    @classmethod
    def open_with_passphrase(cls, snapshot: str | Path, passphrase: str) -> bytes:
        """只凭备份文件和备份时的加密口令解密，用于灾难恢复。"""
        header, aad, sealed = cls._parse(Path(snapshot).read_bytes())
        if header is None:
            raise ValueError("旧格式备份不包含密钥参数，无法仅凭口令恢复")
        kek = derive_kek(passphrase, base64.b64decode(header["kdf_salt"]), KdfParams(**header["kdf_params"]))
        try:
            return open_sealed(derive_subkey(kek, "snapshot"), sealed, aad)
        except Exception as exc:
            raise ValueError("加密口令不正确，或备份文件已损坏") from exc


class BackupService:
    NAME = re.compile(r"tgdrive-\d{8}-\d{6}\.tgdbak")

    def __init__(self, snapshots: EncryptedSnapshotStore, directory: str | Path, *, keep: int = 14) -> None:
        self.snapshots, self.directory, self.keep = snapshots, Path(directory), keep

    def create(self) -> dict[str, object]:
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        path = self.snapshots.create(self.directory / f"tgdrive-{stamp}.tgdbak")
        for old in self.list()[self.keep:]:
            (self.directory / str(old["name"])).unlink(missing_ok=True)
        return {"name": path.name, "size": path.stat().st_size, "created_at": path.stat().st_mtime}

    def list(self) -> list[dict[str, object]]:
        if not self.directory.is_dir():
            return []
        items = [path for path in self.directory.iterdir() if self.NAME.fullmatch(path.name)]
        return [{"name": path.name, "size": path.stat().st_size, "created_at": path.stat().st_mtime}
                for path in sorted(items, key=lambda item: item.name, reverse=True)]

    def path(self, name: str) -> Path:
        if not self.NAME.fullmatch(name) or not (self.directory / name).is_file():
            raise FileNotFoundError(name)
        return self.directory / name


def restore_backup(backup: str | Path, passphrase: str, data_dir: str | Path) -> Path:
    """把备份恢复为数据目录中的 meta.db。原数据库移到 meta.db.before-restore-*，不会被覆盖。

    必须在服务停止时执行。
    """
    plaintext = EncryptedSnapshotStore.open_with_passphrase(backup, passphrase)
    data_dir = Path(data_dir).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    staging = data_dir / f".restore-{secrets.token_hex(6)}.db"
    staging.write_bytes(plaintext)
    try:
        check = sqlite3.connect(staging)
        try:
            if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("备份中的数据库未通过完整性检查")
            key_row = check.execute("SELECT kdf_salt, kdf_params, check_blob FROM keys WHERE id=1").fetchone()
        finally:
            check.close()
        verify_check_blob(derive_kek(passphrase, key_row[0], KdfParams(**json.loads(key_row[1]))), key_row[2])
        target = data_dir / "meta.db"
        if target.exists():
            os.replace(target, data_dir / f"meta.db.before-restore-{time.time_ns()}")
        for suffix in ("-wal", "-shm"):
            (data_dir / f"meta.db{suffix}").unlink(missing_ok=True)
        os.replace(staging, target)
        return target
    finally:
        staging.unlink(missing_ok=True)


class MaintenanceService:
    STATUS_KEY = "maintenance.last"

    def __init__(self, metadata: Metadata, engine: BlobEngine, store: BlobStore, keystore: KeyStore,
                 *, backup_dir: str | Path | None = None) -> None:
        self.metadata, self.keystore = metadata, keystore
        self.gc = GarbageCollector(metadata, store)
        self.scrub = Scrubber(metadata, engine)
        self.cleaner = Cleaner(metadata)
        self.snapshots = EncryptedSnapshotStore(metadata, keystore)
        self.backups = BackupService(self.snapshots, backup_dir or Path(metadata.path).parent / "backups")
        self.trash_purger = None  # 由应用工厂注入：async (now) -> int

    def status(self) -> dict[str, object]:
        state = _get_state(self.metadata, self.STATUS_KEY, {}) or {}
        state["gc_pending"] = int(self.metadata.db.execute("SELECT COUNT(*) FROM gc_queue WHERE attempts < ?",
                                                           (GarbageCollector.MAX_ATTEMPTS,)).fetchone()[0])
        state["gc_dead"] = self.gc.dead_count()
        return state

    def record(self, task: str, result: dict[str, object]) -> None:
        state = _get_state(self.metadata, self.STATUS_KEY, {}) or {}
        state[task] = {"at": time.time(), **result}
        _set_state(self.metadata, self.STATUS_KEY, state)


class MaintenanceScheduler:
    """在服务进程内定期运行维护任务。系统锁定时跳过，单个任务失败不影响其他任务。"""

    def __init__(self, service: MaintenanceService, *, interval: float = 600, scrub_every: float = 86400,
                 scrub_batch: int = 200, backup_every: float = 86400) -> None:
        self.service, self.interval = service, interval
        self.scrub_every, self.scrub_batch, self.backup_every = scrub_every, scrub_batch, backup_every
        self._task: asyncio.Task | None = None

    def _due(self, task: str, every: float, now: float) -> bool:
        last = (self.service.status().get(task) or {}).get("at")
        return last is None or now - float(last) >= every

    async def tick(self, *, now: float | None = None) -> dict[str, object]:
        if not self.service.keystore.unlocked:
            return {}
        now = now or time.time()
        done: dict[str, object] = {}
        steps = [
            ("cleanup", lambda: self._cleanup(now)),
            ("gc", lambda: self._gc()),
        ]
        if self.service.trash_purger is not None:
            steps.append(("trash", lambda: self._purge(now)))
        if self._due("scrub", self.scrub_every, now):
            steps.append(("scrub", lambda: self._scrub()))
        if self._due("backup", self.backup_every, now):
            steps.append(("backup", lambda: asyncio.to_thread(self.service.backups.create)))
        for name, step in steps:
            try:
                result = await step()
                done[name] = result
                self.service.record(name, result)
            except Exception as exc:  # 记录后继续执行其他任务
                log.exception("maintenance task %s failed", name)
                self.service.record(name, {"error": str(exc)[:500]})
        return done

    async def _cleanup(self, now: float) -> dict[str, object]:
        return asdict(self.service.cleaner.run_once(now=now))

    async def _gc(self) -> dict[str, object]:
        return asdict(await self.service.gc.run_once(limit=500))

    async def _purge(self, now: float) -> dict[str, object]:
        return {"purged": await self.service.trash_purger(now)}

    async def _scrub(self) -> dict[str, object]:
        report = await self.service.scrub.run_once(limit=self.scrub_batch)
        return {"checked": report.checked, "bad": len(report.bad), "bad_blobs": [uuid for uuid, _ in report.bad][:20],
                "wrapped": report.wrapped}

    async def run_forever(self) -> None:
        while True:
            await asyncio.sleep(self.interval)
            await self.tick()

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self.run_forever())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
