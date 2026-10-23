"""大批量任务入队边界：数据库与来源均使用替身，不执行 SQL 或访问网络。"""
import asyncio
import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock

from tgdrive.assistant.actions import ActionExecutor, DOWNLOAD_BATCH, Progress
from tgdrive.objects import PRIVATE_PREFIX, ObjectService, Scope
from tgdrive.offline.service import MAX_CREATE_ITEMS, MAX_PENDING_TASKS, OfflineDownloads


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
        service = self.prepare(MAX_PENDING_TASKS - MAX_CREATE_ITEMS)
        self.assertEqual(len(service.create(1, self.items(MAX_CREATE_ITEMS), "文件/")), MAX_CREATE_ITEMS)
        with self.assertRaisesRegex(ValueError, str(MAX_PENDING_TASKS)):
            service.create(1, self.items(1), "文件/")
        self.assertEqual(service._save_source.call_count, MAX_CREATE_ITEMS)
        full = self.prepare(MAX_PENDING_TASKS - 1)
        with self.assertRaisesRegex(ValueError, str(MAX_PENDING_TASKS)):
            full.create(1, self.items(2), "相册/")
        full._save_source.assert_not_called()

    def test_single_submission_accepts_1000_and_rejects_invalid_counts_before_writing(self):
        service = self.prepare(0)
        self.assertEqual(len(service.create(1, self.items(1000), "文件/")), 1000)
        self.assertEqual(service.metadata.transaction.call_count, 1, "单次提交保持一个事务")
        for items in ([], self.items(1001), None):
            with self.subTest(count=len(items) if items is not None else None):
                rejected = self.prepare(0)
                with self.assertRaisesRegex(ValueError, "1–1000"):
                    rejected.create(1, items, "文件/")
                rejected.metadata.transaction.assert_not_called()
                rejected._save_source.assert_not_called()

    def test_invalid_last_item_does_not_create_earlier_tasks(self):
        service = self.prepare(0)
        items = self.items(MAX_CREATE_ITEMS)
        items[-1]["name"] = "其他目录/文件.txt"
        with self.assertRaisesRegex(ValueError, "不能包含路径"):
            service.create(1, items, "文件/")
        service.metadata.transaction.assert_not_called()
        service._save_source.assert_not_called()

    def test_bulk_creation_keeps_key_scope_checks(self):
        service = self.prepare(0)
        service.objects._check_scope = ObjectService._check_scope
        with self.assertRaises(PermissionError):
            service.create(1, self.items(MAX_CREATE_ITEMS), "其他/", key_scope=Scope(8, prefix="授权/"))
        service.metadata.transaction.assert_not_called()
        service._save_source.assert_not_called()

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


class AssistantQueueBatchTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, count):
        executor = ActionExecutor.__new__(ActionExecutor)
        executor.offline = SimpleNamespace(direct_ticket=Mock(return_value="fixture"), create=Mock())
        payload = {"options": {"target": "文件/"}, "items": [
            {"url": f"https://example.test/{n}.bin", "name": f"{n}.bin"} for n in range(count)]}
        return executor, payload, Progress(total=count)

    async def test_large_proposal_is_automatically_split_with_progress(self):
        executor, payload, progress = self.fixture(2000)
        done = []
        await executor._downloads(1, "", payload, progress, lambda: done.append(progress.done))
        sizes = [len(call.args[1]) for call in executor.offline.create.call_args_list]
        self.assertEqual(sum(sizes), 2000)
        self.assertEqual(max(sizes), DOWNLOAD_BATCH)
        self.assertGreater(DOWNLOAD_BATCH, 32)
        self.assertLessEqual(DOWNLOAD_BATCH, MAX_CREATE_ITEMS)
        self.assertEqual(done[-1], 2000)
        self.assertEqual((progress.ok, progress.failed), (2000, 0))

    async def test_cancel_or_authorization_loss_stops_later_batches(self):
        for cancel in (True, False):
            with self.subTest(cancel=cancel):
                executor, payload, progress = self.fixture(DOWNLOAD_BATCH * 3)
                allowed = True

                def on_progress():
                    nonlocal allowed
                    if cancel:
                        progress.cancel = True
                    else:
                        allowed = False

                await executor._downloads(1, "", payload, progress, on_progress, authorized=lambda: allowed)
                executor.offline.create.assert_called_once()
                self.assertEqual(progress.done, DOWNLOAD_BATCH)
                self.assertTrue(progress.cancel)
