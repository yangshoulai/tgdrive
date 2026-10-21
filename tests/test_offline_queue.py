"""大批量任务入队边界：数据库与来源均使用替身，不执行 SQL 或访问网络。"""
import asyncio
import unittest
from contextlib import nullcontext
from unittest.mock import Mock

from tgdrive.objects import PRIVATE_PREFIX, Scope
from tgdrive.offline.service import MAX_PENDING_TASKS, OfflineDownloads


class QueueCapacityTests(unittest.TestCase):
    def prepare(self, pending):
        service = object.__new__(OfflineDownloads)
        service.scope = Mock(return_value=Scope(8))
        service._ticket = Mock(return_value={"request": {"url": "https://example.test/image.jpg"},
                                           "kind": "http", "size": None, "content_type": None})
        service.objects = Mock()
        service._save_source = Mock()
        service._row = lambda task_id: {"id": task_id}
        service.public = lambda row, **kwargs: row
        service._wake = asyncio.Event()
        database = Mock()
        count = [pending]

        def execute(statement, params):
            result = Mock()
            if statement.startswith("SELECT COUNT(*)"):
                result.fetchone.return_value = (count[0],)
            elif statement.startswith("SELECT key"):
                return []
            elif statement.startswith("SELECT 1"):
                result.fetchone.return_value = None
            elif statement.startswith("INSERT"):
                count[0] += 1
                result.lastrowid = count[0]
            else:
                raise AssertionError(statement)
            return result

        database.execute.side_effect = execute
        service.metadata = Mock()
        service.metadata.transaction.side_effect = lambda: nullcontext(database)
        return service

    @staticmethod
    def items(count):
        return [{"ticket": "fixture", "name": f"image-{index}.jpg"} for index in range(count)]

    def test_ten_thousand_queued_images_allow_another_album_batch(self):
        service = self.prepare(10_000)
        authorize = Mock()
        scope = Scope(8, PRIVATE_PREFIX, private_access=True, authorize=authorize)
        result = service.create(1, self.items(32), PRIVATE_PREFIX + "相册/", private_scope=scope)
        self.assertEqual(len(result), 32)
        authorize.assert_called()

    def test_capacity_accepts_last_batch_and_rejects_whole_overflow(self):
        service = self.prepare(MAX_PENDING_TASKS - 32)
        self.assertEqual(len(service.create(1, self.items(32), "相册/")), 32)
        with self.assertRaisesRegex(ValueError, str(MAX_PENDING_TASKS)):
            service.create(1, self.items(1), "相册/")
        self.assertEqual(service._save_source.call_count, 32)
        full = self.prepare(MAX_PENDING_TASKS - 1)
        with self.assertRaisesRegex(ValueError, str(MAX_PENDING_TASKS)):
            full.create(1, self.items(2), "相册/")
        full._save_source.assert_not_called()

    def test_private_destination_still_requires_its_authorization(self):
        service = self.prepare(0)
        with self.assertRaisesRegex(ValueError, "解锁"):
            service.create(1, self.items(1), PRIVATE_PREFIX + "相册/")
        service._save_source.assert_not_called()

    def test_running_filter_keeps_owner_and_uses_pagination(self):
        service = self.prepare(0)
        database = Mock()
        database.execute.return_value.fetchone.return_value = (0,)
        database.execute.return_value.fetchall.return_value = []
        service.metadata.db = database
        service.resources = Mock()
        service.resources.effective.return_value = {"hls_enabled": False, "x_enabled": False, "youtube_enabled": False, "concurrency": 2}
        service.resources.pressure.return_value = None
        service._key = lambda: b"fixture"
        service._attach_files = Mock()
        result = service.list(1, status="running", limit=100)
        self.assertEqual(result["tasks"], [])
        statement, parameters = database.execute.call_args_list[1].args
        self.assertIn("user_id=? AND status=?", statement)
        self.assertEqual(parameters, (1, "running", 101))
