"""批量删除与清空回收站的性能回归：删除路径上的查询必须走索引、带上界，不能随桶内对象总数线性变慢。"""
import asyncio
import tempfile
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.objects import Scope


class DeletePerformanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password", quota_bytes=10**9)
        self.scope = Scope(self.alice.bucket_id)
        self.objects = self.app.user.objects

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def plan(self, sql, *params):
        return " ".join(row[-1] for row in self.app.metadata.db.execute("EXPLAIN QUERY PLAN " + sql, params))

    def test_reference_lookups_use_indexes(self):
        # 释放 Blob 时的引用检查、缩略图转交、分段上传清理与移动时的下载任务查询。
        self.assertIn("objects_by_blob", self.plan("SELECT 1 FROM objects WHERE bucket_id=? AND blob_uuid=? LIMIT 1", 1, "x"))
        self.assertIn("objects_by_blob", self.plan("SELECT bucket_id FROM objects WHERE blob_uuid=? AND bucket_id!=? LIMIT 1", "x", 1))
        self.assertIn("uploads_by_blob", self.plan("DELETE FROM uploads WHERE blob_uuid=?", "x"))
        self.assertIn("offline_by_key", self.plan("SELECT id FROM offline_tasks WHERE bucket_id=? AND key=?", 1, "a"))

    def test_trash_only_touches_its_own_keys(self):
        async def run():
            for key in ("a/f.txt", "a/f.txt.bak", "a/folder/x.txt", "a/folder2/y.txt", "b/z.txt"):
                data = key.encode()
                await self.objects.put_object(self.scope, key, data, len(data), "text/plain")
            await self.objects.trash(self.scope, ["a/f.txt", "a/folder/"])
            keys = [row[0] for row in self.app.metadata.db.execute(
                "SELECT key FROM objects WHERE bucket_id=? AND substr(key,1,9)!='.tgdrive/' ORDER BY key", (self.alice.bucket_id,))]
            self.assertEqual(keys, ["a/f.txt.bak", "a/folder2/y.txt", "b/z.txt"])
            self.assertEqual(await self.objects.purge_trash(self.scope, None), 2)
            self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM blobs").fetchone()[0], 3)
        asyncio.run(run())

    def test_batch_trash_scales_with_selection_not_bucket(self):
        async def run():
            for i in range(50):
                data = f"file {i}".encode()
                await self.objects.put_object(self.scope, f"a/f{i}.txt", data, len(data), "text/plain")
            db = self.app.metadata.db
            columns = [row[1] for row in db.execute("PRAGMA table_info(objects)")]
            row = dict(db.execute("SELECT * FROM objects WHERE bucket_id=? AND key='a/f0.txt'", (self.alice.bucket_id,)).fetchone())
            with self.app.metadata.transaction() as tx:
                tx.executemany(f"INSERT INTO objects({','.join(columns)}) VALUES({','.join('?' * len(columns))})",
                               [tuple(dict(row, key=f"z/{i:06d}", blob_uuid=None, public_token=None)[c] for c in columns)
                                for i in range(20000)])
            reads = 0

            def count(*_):
                nonlocal reads
                reads += 1
                return 0
            # 统计 SQLite 虚拟机步数：每项移动都扫描其后整个桶时会达到数百万步。
            db.set_progress_handler(count, 1000)
            try:
                await self.objects.trash(self.scope, [f"a/f{i}.txt" for i in range(50)])
            finally:
                db.set_progress_handler(None, 0)
            self.assertLess(reads, 200, reads)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
