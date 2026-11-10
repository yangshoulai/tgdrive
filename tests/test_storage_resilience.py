"""存储可靠性：分段并发重传的 GC、系统小对象上限、按字节预算的巡检、凭据错误与分片缺失的区分、
字幕超限不锁死编辑、备份发到 Telegram 频道、失效 Bot 的分片重新认领。"""
import asyncio
import dataclasses
import json
import tempfile
import time
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.backup_remote import RemoteBackup
from tgdrive.errors import StorageAccessError
from tgdrive.objects import Scope
from tgdrive.telegram.client import HttpResponse, SentDocument
from tgdrive.telegram.pool import BotPool, PoolBot
from tgdrive.telegram.reclaim import BotReclaimer
from tgdrive.telegram.store import TelegramBlobStore, TelegramRef


class FakeClient:
    def __init__(self):
        self.sent, self.deleted, self.forwarded = [], [], []
        self.next_id = 100

    async def send_document(self, chat, data, *, filename="blob.bin"):
        self.next_id += 1
        self.sent.append((chat, filename, len(data)))
        return SentDocument(self.next_id, f"fid-{self.next_id}", f"uid-{self.next_id}")

    async def delete_message(self, chat, message):
        self.deleted.append((chat, message))

    async def forward_message(self, chat, from_chat, message):
        self.next_id += 1
        self.forwarded.append((chat, from_chat, message))
        return SentDocument(self.next_id, f"new-fid-{self.next_id}", f"uid-{message}")


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.alice.bucket_id)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def put(self, key, data):
        return asyncio.run(self.app.objects.put_object(self.scope, key, data))

    def gc_refs(self):
        return [row[0] for row in self.app.metadata.db.execute("SELECT blob_ref FROM gc_queue ORDER BY id")]


class ReplacePartTests(Base):
    def test_concurrent_retries_enqueue_every_replaced_ref(self):
        info = self.put("a.bin", b"payload")
        md = self.app.metadata
        chunk = md.list_chunks(info.blob_uuid)[0]
        original = chunk.blob_ref
        # 两个请求都在开始时看到 original；先完成的写入 B，后完成的写入 C。B 必须进 GC。
        md.replace_part(chunk.blob_uuid, chunk.part_no, [dataclasses.replace(chunk, blob_ref="ref-B")], [original], time.time())
        md.replace_part(chunk.blob_uuid, chunk.part_no, [dataclasses.replace(chunk, blob_ref="ref-C")], [original], time.time())
        self.assertEqual(self.gc_refs(), [original, "ref-B"])
        self.assertEqual([c.blob_ref for c in md.list_chunks(info.blob_uuid)], ["ref-C"])


class SmallObjectTests(Base):
    def test_text_assets_between_1_and_2_mib_are_stored_and_read(self):
        data = ("歌" * 600_000).encode()  # 约 1.7 MiB
        asyncio.run(self.app.objects.put_object(self.scope, "big.lrc", data, len(data), "text/plain", small=True))
        info = self.app.objects.head_object(self.scope, "big.lrc")
        self.assertEqual(asyncio.run(self.app.engine.read_small(info.blob_uuid)), data)


class ScrubBudgetTests(Base):
    def test_budget_limits_bytes_and_always_checks_one(self):
        for index in range(4):
            self.put(f"f{index}", bytes([index]) * 1000)
        scrub = self.app.maintenance.scrub
        report = asyncio.run(scrub.run_once(limit=100, budget=2500))
        self.assertEqual((report.checked, report.bytes, report.wrapped), (2, 2000, False))
        report = asyncio.run(scrub.run_once(limit=100, budget=10))
        self.assertEqual(report.checked, 1)
        report = asyncio.run(scrub.run_once(limit=100, budget=10_000))
        self.assertEqual((report.checked, report.wrapped), (1, True))

    def test_budget_comes_from_resource_settings(self):
        # 每日读取量是「下载与资源」的系统配置：0 关闭自动校验，超出范围拒绝保存。
        resources = self.app.offline.resources
        scrub = self.app.maintenance.scrub
        self.assertEqual(scrub.budget(), 2048 * 1024 ** 2)
        resources.update({"scrub_daily_mib": 256})
        self.assertEqual(scrub.budget(), 256 * 1024 ** 2)
        with self.assertRaises(ValueError):
            resources.update({"scrub_daily_mib": -1})
        resources.update({"scrub_daily_mib": 0})
        from tgdrive.maintenance import MaintenanceScheduler
        done = asyncio.run(MaintenanceScheduler(self.app.maintenance).tick())
        self.assertNotIn("scrub", done, "0 表示关闭自动校验")


class AccessErrorTests(unittest.TestCase):
    def test_403_is_access_error_not_missing_blob(self):
        class Client:
            async def get_file(self, file_id):
                from tgdrive.telegram.client import FileInfo
                return FileInfo(file_id, None, "doc/x")

            async def download_file(self, path, start=None, end=None):
                return HttpResponse(403, {}, b"")
        store = TelegramBlobStore(BotPool([PoolBot("1", Client(), -100)]))
        ref = TelegramRef("1", -100, 5, "fid").encode()
        with self.assertRaises(StorageAccessError):
            asyncio.run(store.get(ref))


class RemoteBackupTests(Base):
    def test_split_upload_and_rotation(self):
        client = FakeClient()
        pool = BotPool([PoolBot("1", client, -1001)])
        remote = RemoteBackup(self.app.metadata, lambda: pool, part_size=1024)
        self.assertIsNone(asyncio.run(remote.upload(Path(self.temp.name) / "missing")))  # 未启用
        remote.configure(True, "-1002", 1)
        backup = Path(self.temp.name) / "tgdrive-20261110-030000-1.tgdbak"
        backup.write_bytes(b"x" * 2500)
        result = asyncio.run(remote.upload(backup))
        self.assertEqual(result["parts"], 3)
        self.assertEqual([name for _, name, _ in client.sent],
                         [f"{backup.name}.00{i}" for i in (1, 2, 3)])
        self.assertTrue(all(chat == "-1002" for chat, _, _ in client.sent))
        asyncio.run(remote.upload(backup))
        self.assertEqual(len(client.deleted), 3)  # 只保留 1 份：上一组分卷被删除
        self.assertEqual(len(remote.items()), 1)

    def test_invalid_channel_rejected(self):
        remote = RemoteBackup(self.app.metadata, lambda: None)
        with self.assertRaises(ValueError):
            remote.configure(True, "not a channel", 3)


class ReclaimTests(Base):
    def test_other_bot_takes_over_chunks_and_old_message_deletion(self):
        info = self.put("a.bin", b"data")
        md = self.app.metadata
        dead = TelegramRef("1", -100, 42, "dead-fid", "uid-42").encode()
        with md.transaction() as db:
            db.execute("UPDATE chunks SET blob_ref=? WHERE blob_uuid=?", (dead, info.blob_uuid))
            db.execute("INSERT INTO gc_queue(blob_ref,enqueued_at,attempts) VALUES(?,?,8)",
                       (TelegramRef("1", -100, 7, "x").encode(), 0))
        client = FakeClient()
        pool = BotPool([PoolBot("1", FakeClient(), -100), PoolBot("2", client, -200)], min_interval=0)
        pool.set_state("1", "disabled")
        reclaimer = BotReclaimer(md, lambda: pool)
        self.assertEqual(reclaimer.pending("1"), {"chunks": 1, "gc": 1})
        result = asyncio.run(reclaimer.run_once("1"))
        self.assertEqual((result["reclaimed"], result["failed"], result["rebound_gc"], result["remaining"]), (1, 0, 1, 0))
        self.assertEqual(client.forwarded, [(-200, -100, 42)])
        new = TelegramRef.decode(md.list_chunks(info.blob_uuid)[0].blob_ref)
        self.assertEqual((new.bot, new.chat, new.file_id), ("2", -200, f"new-fid-{client.next_id}"))
        gc = [TelegramRef.decode(ref) for ref in self.gc_refs()]
        self.assertEqual(sorted((ref.bot, ref.message) for ref in gc), [("2", 7), ("2", 42)])
        attempts = md.db.execute("SELECT MAX(attempts) FROM gc_queue").fetchone()[0]
        self.assertEqual(attempts, 0)

    def test_requires_another_enabled_bot(self):
        pool = BotPool([PoolBot("1", FakeClient(), -100)])
        with self.assertRaises(ValueError):
            asyncio.run(BotReclaimer(self.app.metadata, lambda: pool).run_once("1"))


if __name__ == "__main__":
    unittest.main()
