"""M17：维护（scrub 游标、GC 死信、清理）、加密备份与恢复、后台调度、账号与口令管理。"""
import asyncio
import json
import tempfile
import time
import unittest
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from tgdrive.audit import AuditLog
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.maintenance import EncryptedSnapshotStore, GarbageCollector, restore_backup
from tgdrive.objects import Scope


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.app = create_app(self.root / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.alice = self.app.accounts.create_user("alice", "alice password")
        self.scope = Scope(self.alice.bucket_id)
        self.client = Client(self.app)
        self.m = self.app.maintenance

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def put(self, key, data=b"x"):
        return asyncio.run(self.app.objects.put_object(self.scope, key, data))

    def request(self, method, path, payload=None, headers=None):
        status, response_headers, data = asyncio.run(self.client.request(
            method, path, json.dumps(payload).encode() if payload is not None else b"", headers or {}))
        return status, (json.loads(data) if data and response_headers.get("content-type", "").startswith("application/json") else data)

    def test_scrub_progresses_through_all_blobs_and_wraps(self):
        for index in range(7):
            self.put(f"f{index}")
        checked = []
        for _ in range(4):
            report = asyncio.run(self.m.scrub.run_once(limit=3))
            checked.append((report.checked, report.wrapped))
        self.assertEqual(checked, [(3, False), (3, False), (1, True), (3, False)])

    def test_gc_skips_dead_entries_and_can_retry(self):
        db = self.app.metadata.db
        with self.app.metadata.transaction() as tx:
            tx.executemany("INSERT INTO gc_queue(blob_ref,enqueued_at,attempts) VALUES(?,?,?)",
                           [(f"dead-{i}", 0, GarbageCollector.MAX_ATTEMPTS) for i in range(5)])
        self.put("doomed.txt")
        asyncio.run(self.app.objects.delete_objects(self.scope, ["doomed.txt"]))
        report = asyncio.run(self.m.gc.run_once(limit=2))
        self.assertEqual((report.deleted, report.dead), (1, 5))
        self.assertEqual(db.execute("SELECT COUNT(*) FROM gc_queue WHERE blob_ref NOT LIKE 'dead-%'").fetchone()[0], 0)
        self.assertEqual(self.m.gc.retry_dead(), 5)
        self.assertEqual(self.m.gc.dead_count(), 0)

    def test_cleanup_aborts_stale_uploads_and_orphan_blobs(self):
        async def run():
            upload = await self.app.objects.create_multipart(self.scope, "big.bin")
            await self.app.objects.upload_part(self.scope, upload, 1, b"part")
            orphan = self.app.engine.begin_blob()
            await self.app.engine.put_part(orphan, 1, b"orphan")
            return upload
        upload = asyncio.run(run())
        future = time.time() + 8 * 86400
        report = self.m.cleaner.run_once(now=future)
        self.assertEqual((report.aborted_uploads, report.stale_blobs), (1, 1))
        db = self.app.metadata.db
        self.assertIsNone(db.execute("SELECT 1 FROM uploads WHERE upload_id=?", (upload,)).fetchone())
        self.assertEqual(db.execute("SELECT COUNT(*) FROM blobs WHERE status='uploading'").fetchone()[0], 0)
        self.assertGreaterEqual(db.execute("SELECT COUNT(*) FROM gc_queue").fetchone()[0], 2)
        # 新的上传不受影响。
        self.assertEqual(self.m.cleaner.run_once().aborted_uploads, 0)

    def test_backup_restore_with_passphrase_only(self):
        self.put("docs/keep.txt", b"precious")
        backup = self.m.backups.create()
        self.assertEqual([item["name"] for item in self.m.backups.list()], [backup["name"]])
        path = self.m.backups.path(str(backup["name"]))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(ValueError):
            EncryptedSnapshotStore.open_with_passphrase(path, "wrong passphrase!!")
        # 在全新的数据目录中恢复，然后用口令解锁并读取原文件（分片仍在原 BlobStore 中）。
        restored_dir = self.root / "restored"
        (restored_dir / "blobs").parent.mkdir(parents=True, exist_ok=True)
        import shutil
        shutil.copytree(self.root / "data" / "blobs", restored_dir / "blobs")
        restore_backup(path, "encryption passphrase", restored_dir)
        restored = create_app(restored_dir, secure_cookies=False)
        try:
            restored.keystore.unlock("encryption passphrase")
            async def read():
                _, stream = await restored.objects.get_object(self.scope, "docs/keep.txt")
                return b"".join([chunk async for chunk in stream])
            self.assertEqual(asyncio.run(read()), b"precious")
        finally:
            restored.metadata.close()
        # 再次恢复会把现有数据库移到旁边，而不是覆盖。
        restore_backup(path, "encryption passphrase", restored_dir)
        self.assertTrue(list(restored_dir.glob("meta.db.before-restore-*")))

    def test_scheduler_tick_runs_tasks_and_skips_when_locked(self):
        scheduler = self.app.scheduler
        done = asyncio.run(scheduler.tick())
        self.assertTrue({"cleanup", "gc", "scrub", "backup"} <= set(done))
        status = self.m.status()
        self.assertIn("at", status["backup"])
        # 一天内不会重复备份与 scrub。
        again = asyncio.run(scheduler.tick())
        self.assertFalse({"scrub", "backup"} & set(again))
        self.app.keystore.lock()
        self.assertEqual(asyncio.run(scheduler.tick()), {})

    def test_admin_endpoints_and_passphrase_rotation(self):
        admin = asyncio.run(self.client.login("admin", "admin", "admin password"))
        self.put("a.txt", b"before rotation")
        status, body = self.request("POST", "/api/admin/v1/backups", headers=admin)
        self.assertEqual(status, 201)
        status, data = self.request("GET", f"/api/admin/v1/backups/{body['name']}", headers=admin)
        self.assertTrue(data.startswith(EncryptedSnapshotStore.MAGIC_V2))
        self.assertEqual(self.request("GET", "/api/admin/v1/backups/../meta.db", headers=admin)[0], 404)
        # 错误口令返回 400 而不是 401（401 会让前端登出）。
        status, body = self.request("POST", "/api/admin/v1/unlock", {"passphrase": "nope"}, admin)
        self.assertEqual((status, body["error"]["code"]), (400, "wrong_passphrase"))
        status, body = self.request("POST", "/api/admin/v1/passphrase",
                                    {"old_passphrase": "encryption passphrase", "new_passphrase": "a brand new passphrase"}, admin)
        self.assertEqual(status, 200, body)
        self.app.keystore.lock()
        self.app.keystore.unlock("a brand new passphrase")
        async def read():
            _, stream = await self.app.objects.get_object(self.scope, "a.txt")
            return b"".join([chunk async for chunk in stream])
        self.assertEqual(asyncio.run(read()), b"before rotation")
        # 旧备份仍需旧口令恢复。
        old_backup = self.m.backups.path(self.m.backups.list()[0]["name"])
        self.assertTrue(EncryptedSnapshotStore.open_with_passphrase(old_backup, "encryption passphrase"))

    def test_backup_keeps_pinned_version_during_rotation(self):
        entered, release = threading.Event(), threading.Event()
        connect = sqlite3.connect
        class PinnedSource:
            def __init__(self, connection):
                object.__setattr__(self, "connection", connection)
            def __getattr__(self, name):
                return getattr(self.connection, name)
            def __setattr__(self, name, value):
                setattr(self.connection, name, value)
            def backup(self, target, **options):
                entered.set()
                if not release.wait(5):
                    raise RuntimeError("备份等待超时")
                return self.connection.backup(target, **options)
        def wrapped_connect(path, *args, **kwargs):
            connection = connect(path, *args, **kwargs)
            return PinnedSource(connection) if str(path) == self.app.metadata.path else connection
        with mock.patch("tgdrive.maintenance.sqlite3.connect", side_effect=wrapped_connect), ThreadPoolExecutor() as executor:
            pending = executor.submit(self.m.backups.create)
            try:
                self.assertTrue(entered.wait(5))
                self.app.keystore.rotate("encryption passphrase", "new encryption passphrase")
            finally:
                release.set()
            backup = pending.result(timeout=5)
        path = self.m.backups.path(backup["name"])
        header, _, _ = EncryptedSnapshotStore._parse(path.read_bytes())
        plaintext = EncryptedSnapshotStore.open_with_passphrase(path, "encryption passphrase")
        restored = self.root / "pinned.db"
        restored.write_bytes(plaintext)
        database = connect(restored)
        try:
            self.assertEqual(header["key_version"], database.execute("SELECT version FROM keys").fetchone()[0])
            self.assertEqual(header["key_version"], 1)
        finally:
            database.close()

    def test_backup_streams_and_names_do_not_collide(self):
        with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("不应全量读取快照")):
            first = self.m.backups.create()
            second = self.m.backups.create()
        self.assertNotEqual(first["name"], second["name"])
        self.assertEqual(len(self.m.backups.list()), 2)

    def test_cleanup_is_batched_and_audit_archive_is_recoverable(self):
        for _ in range(3):
            self.app.engine.begin_blob()
        future = time.time() + 8 * 86400
        self.assertEqual(self.m.cleaner.run_once(now=future, limit=2).stale_blobs, 2)
        self.assertEqual(self.m.cleaner.run_once(now=future, limit=2).stale_blobs, 1)
        audit = AuditLog(self.app.metadata)
        for _ in range(3):
            audit.record("admin.login", actor_type="admin", actor="admin", ok=True)
        result = audit.archive(self.root / "archives", self.app.keystore, days=1, now=future, limit=2)
        self.assertEqual(result["archived"], 2)
        output = self.root / "export.jsonl"
        EncryptedSnapshotStore.decrypt_to(self.root / "archives" / result["name"], output,
                                          "encryption passphrase", kind="audit-jsonl")
        self.assertEqual(len(output.read_text().splitlines()), 2)
        self.assertEqual(len(audit.list()["events"]), 1)
        with mock.patch("tgdrive.audit.os.replace", side_effect=OSError("模拟落盘失败")):
            with self.assertRaises(OSError):
                audit.archive(self.root / "archives", self.app.keystore, days=1, now=future)
        self.assertEqual(len(audit.list()["events"]), 1)

    def test_password_management(self):
        admin = asyncio.run(self.client.login("admin", "admin", "admin password"))
        user = asyncio.run(self.client.login("user", "alice", "alice password"))
        self.assertEqual(self.request("POST", f"/api/admin/v1/users/{self.alice.id}/password", {"password": "short"}, admin)[0], 400)
        self.assertEqual(self.request("POST", f"/api/admin/v1/users/{self.alice.id}/password", {"password": "reset by admin"}, admin)[0], 204)
        self.assertEqual(self.request("GET", "/api/user/v1/me", headers=user)[0], 401, "existing sessions must be revoked")
        asyncio.run(self.client.login("user", "alice", "reset by admin"))
        admin_id = self.app.metadata.db.execute("SELECT id FROM users WHERE role='admin'").fetchone()[0]
        self.assertEqual(self.request("POST", f"/api/admin/v1/users/{admin_id}/password", {"password": "whatever123"}, admin)[0], 403)
        status, body = self.request("POST", "/api/admin/v1/password", {"old_password": "wrong", "new_password": "new admin pass"}, admin)
        self.assertEqual(status, 400)
        self.assertEqual(self.request("POST", "/api/admin/v1/password", {"old_password": "admin password", "new_password": "new admin pass"}, admin)[0], 204)
        asyncio.run(self.client.login("admin", "admin", "new admin pass"))


if __name__ == "__main__":
    unittest.main()
