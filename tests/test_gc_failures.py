"""GC 失败的保留与脱敏摘要；只使用替身，不连接或创建数据库。"""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock

from tgdrive.maintenance import GarbageCollector


class GcFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_deletion_stays_queued_while_acknowledged_deletion_leaves(self):
        metadata = SimpleNamespace(db=Mock(), transaction=MagicMock())
        metadata.db.execute.return_value.fetchall.return_value = [
            {"id": 1, "blob_ref": "already-removed"}, {"id": 2, "blob_ref": "permission-denied"}]
        store = SimpleNamespace(delete=AsyncMock(side_effect=[None, PermissionError("cannot delete")]))
        collector = GarbageCollector(metadata, store)
        collector.dead_count = Mock(return_value=0)
        report = await collector.run_once(limit=2)
        self.assertEqual((report.processed, report.deleted, report.failed), (2, 1, 1))
        writes = metadata.transaction.return_value.__enter__.return_value.execute.call_args_list
        self.assertEqual(len(writes), 2)
        self.assertTrue(writes[0].args[0].startswith("DELETE FROM gc_queue"))
        self.assertEqual(writes[0].args[1], (1,))
        self.assertTrue(writes[1].args[0].startswith("UPDATE gc_queue"))
        self.assertEqual(writes[1].args[1], ("cannot delete", 2))

    async def test_summary_returns_only_fixed_reason_labels_and_counts(self):
        metadata = SimpleNamespace(db=Mock())
        metadata.db.execute.return_value.fetchall.return_value = [
            {"reason": "delete_forbidden", "count": 600, "last_error": "do-not-expose-this-token"},
            {"reason": "message_missing", "count": 20, "blob_ref": "private-file-reference"}]
        summary = GarbageCollector(metadata, SimpleNamespace()).failure_summary()
        self.assertEqual(sum(item["count"] for item in summary), 620)
        self.assertIn("48 小时", summary[0]["hint"])
        serialized = json.dumps(summary)
        self.assertNotIn("do-not-expose-this-token", serialized)
        self.assertNotIn("private-file-reference", serialized)
        sql, params = metadata.db.execute.call_args.args
        self.assertEqual(sql.count("?"), len(params))
        self.assertIn("GROUP BY reason", sql)
        self.assertIn("WHERE attempts>0", sql)
