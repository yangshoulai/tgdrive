"""统一生成流程、取消与失败重试；所有存储均为替身，不创建数据库。"""
import asyncio
import unittest
from collections import OrderedDict
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from tgdrive.api import UserApi
from tgdrive.objects import ObjectInfo, Scope
from tgdrive.thumbnails import MIB, ThumbnailError, ThumbnailRetry, ThumbnailService, _Job, _Lease, source_kind


class ThumbnailPolicyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.info = ObjectInfo(7, "song.flac", 80 * MIB, "etag", "audio/flac", {}, 0, "blob")
        self.scope = Scope(7)
        self.worker = ThumbnailService.__new__(ThumbnailService)
        self.worker.objects = SimpleNamespace(head_object=Mock(return_value=self.info), _check_scope=Mock(),
            engine=Mock(), set_thumbnail=AsyncMock(), finish_thumbnail_set=Mock())
        self.worker.resources = SimpleNamespace(ffmpeg="ffmpeg", pressure=lambda: None)
        self.worker.keystore = SimpleNamespace(unlocked=True)
        self.worker.cache = Mock()
        self.worker._pending, self.worker._leases, self.worker._history = OrderedDict(), {}, OrderedDict()
        self.worker._wake = asyncio.Event()
        self.worker._active = self.worker._task = None
        self.worker._remote_bytes = 0
        self.worker._backfill_skip = {}
        self.worker._has_thumbnail = Mock(return_value=False)
        self.worker._scope = Mock(return_value=SimpleNamespace(authorize=Mock()))
        self.worker._plan_backfill = AsyncMock(return_value=False)
        self.worker._render = AsyncMock(return_value={"thumb": b"jpeg"})

    def source(self):
        channel = SimpleNamespace(remote_bytes=0)
        class Context:
            async def __aenter__(self): return channel
            async def __aexit__(self, *_): return False
        self.input = Mock(return_value=Context())
        return patch("tgdrive.thumbnails._RangeInput", self.input)

    async def test_large_files_have_no_read_limit(self):
        with self.source():
            await self.worker.generate(self.info, force=True, allow_remote=True)
        self.assertEqual(self.input.call_args.args[:3], (self.worker.objects.engine, self.info, self.worker._scope.return_value.authorize))
        self.assertEqual(self.input.call_args.kwargs, {"cache_only": False})
        self.worker.objects.set_thumbnail.assert_awaited_once()

    async def test_automatic_timeout_does_not_mark_file_as_unavailable(self):
        async def slow(*args, **kwargs): await asyncio.sleep(1)
        self.worker._render.side_effect = slow
        with self.source(), patch("tgdrive.thumbnails.TIMEOUT", 0.005), self.assertRaises(TimeoutError):
            await self.worker.generate(self.info, allow_remote=True)
        self.worker.objects.set_thumbnail.assert_not_awaited()

    async def test_retryable_and_decoder_failures_do_not_write_none(self):
        for error in (ThumbnailRetry("resources"), ThumbnailError("decoder")):
            with self.subTest(error=type(error).__name__), self.source(), self.assertRaises(type(error)):
                self.worker._render.side_effect = error
                await self.worker.generate(self.info, allow_remote=True)
        self.worker.objects.set_thumbnail.assert_not_awaited()

    async def test_confirmed_missing_cover_can_be_marked_unavailable(self):
        self.worker._render.return_value = None
        with self.source(): await self.worker.generate(self.info)
        self.worker.objects.set_thumbnail.assert_awaited_once_with(self.worker._scope.return_value, self.info.key, None, "none")

    async def run_one(self, job):
        self.worker._pending[self.info.blob_uuid] = job
        runner = asyncio.create_task(self.worker._run())
        try:
            async with asyncio.timeout(1):
                while self.info.blob_uuid not in self.worker._history: await asyncio.sleep(0)
        finally:
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)

    async def test_queue_uses_one_policy_for_requests_and_backfill(self):
        for job in (_Job(self.info, remote=True, backfill=True), _Job(self.info, force=True, remote=True)):
            with self.subTest(backfill=job.backfill):
                self.worker._history.clear()
                self.worker.generate = AsyncMock(return_value=None)
                await self.run_one(job)
                self.assertEqual(self.worker.generate.call_args.kwargs, {"force": job.force, "allow_remote": True})

    async def test_repeated_automatic_errors_stay_retryable(self):
        self.worker.generate = AsyncMock(side_effect=ThumbnailError("decoder"))
        for _ in range(4):
            self.worker._history.clear()
            await self.run_one(_Job(self.info, remote=True, backfill=True))
            self.assertIn("blob", self.worker._backfill_skip)
        self.worker.objects.set_thumbnail.assert_not_awaited()

    async def test_cancel_stops_active_task_and_revokes_browser_ticket(self):
        job = _Job(self.info, remote=True)
        self.worker._pending["blob"] = self.worker._active = job
        task = self.worker._task = asyncio.create_task(asyncio.sleep(60))
        self.worker._leases["blob"] = _Lease(self.info, "token", 10**12)
        self.assertTrue(self.worker.cancel(self.scope, self.info.key, self.info.etag)["cancelled"])
        await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(task.cancelled())
        self.assertNotIn("blob", self.worker._leases)
        self.assertNotIn("blob", self.worker._pending)
        self.assertEqual(self.worker._history["blob"]["state"], "cancelled")

    async def test_cancel_rejects_stale_versions_and_other_buckets(self):
        with self.assertRaises(ValueError): self.worker.cancel(self.scope, self.info.key, "stale")
        other = ObjectInfo(8, "song.flac", 80 * MIB, "etag", "audio/flac", {}, 0, "blob")
        self.worker._pending["blob"] = _Job(other)
        self.assertFalse(self.worker.cancel(self.scope, self.info.key, "etag")["cancelled"])
        self.assertIn("blob", self.worker._pending)
        self.worker.objects._check_scope.side_effect = PermissionError()
        with self.assertRaises(PermissionError): self.worker.cancel(self.scope, self.info.key, "etag")

    async def test_renewal_works_during_partial_save_and_checks_identity(self):
        self.worker._leases["blob"] = _Lease(self.info, "token", 10**12)
        self.worker._has_thumbnail.return_value = True  # 小图已保存，另外两种规格尚未保存。
        self.assertEqual(self.worker.claim(self.scope, self.info.key, "etag", ticket="token")["token"], "token")
        for etag, token in (("stale", "token"), ("etag", "wrong")):
            with self.assertRaises(ValueError): self.worker.claim(self.scope, self.info.key, etag, ticket=token)
        self.worker._leases["blob"].until = 0
        with self.assertRaises(ValueError): self.worker.claim(self.scope, self.info.key, "etag", ticket="token")

    async def test_user_request_takes_over_active_automatic_job(self):
        job = _Job(self.info, remote=True, backfill=True, state="running")
        self.worker._pending["blob"] = self.worker._active = job
        task = self.worker._task = asyncio.create_task(asyncio.sleep(60))
        self.worker._leases["blob"] = _Lease(self.info, "browser", 10**12)
        self.worker.request(self.scope, self.info.key, "etag")
        self.assertNotIn("blob", self.worker._leases)
        await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(task.cancelled())
        self.assertEqual((job.state, job.backfill, job.force), ("queued", False, True))

    async def test_progress_reports_queue_then_latest_result(self):
        self.assertEqual(self.worker.progress(self.scope, self.info.key, "etag")["state"], "idle")
        self.worker._history["blob"] = {"state": "failed", "detail": "旧结果"}
        self.worker._eligible = Mock(return_value=True)
        self.worker._enqueue = Mock()
        self.worker.request(self.scope, self.info.key, "etag")
        self.assertNotIn("blob", self.worker._history, "重新请求时不能沿用上一次的结果")
        job = _Job(self.info, force=True, remote=True, detail="用户请求生成")
        self.worker._pending["blob"] = job
        self.assertEqual(self.worker.progress(self.scope, self.info.key, "etag"), {"state": "queued", "detail": "用户请求生成"})
        self.worker._active = job
        self.assertEqual(self.worker.progress(self.scope, self.info.key, "etag")["state"], "running")
        self.worker._pending.clear(); self.worker._active = None
        self.worker._record(job, "done", "缩略图处理完成")
        self.assertEqual(self.worker.progress(self.scope, self.info.key, "etag"), {"state": "done", "detail": "缩略图处理完成"})
        other = ObjectInfo(8, "song.flac", 80 * MIB, "etag", "audio/flac", {}, 0, "blob")
        self.worker._pending["blob"] = _Job(other)
        self.assertEqual(self.worker.progress(self.scope, self.info.key, "etag")["state"], "done", "其他桶的任务不可见")
        with self.assertRaises(ValueError): self.worker.progress(self.scope, self.info.key, "stale")

    def test_large_images_are_eligible(self):
        self.assertEqual(source_kind(ObjectInfo(7, "large.png", 80 * MIB, "etag", "image/png", {}, 0, "blob")), "image")

    def test_cancel_and_renewal_require_mutating_web_scope(self):
        api = UserApi.__new__(UserApi)
        api.objects = SimpleNamespace(thumbnail_service=self.worker)
        api._scope = Mock(return_value=self.scope)
        self.worker._leases["blob"] = _Lease(self.info, "token", 10**12)
        api.thumbnail_claim("session", "csrf", self.info.key, "etag", ticket="token")
        api._scope.assert_called_with("session", csrf="csrf", mutation=True)
        api.thumbnail_cancel("session", "csrf", self.info.key, "etag")
        api._scope.assert_called_with("session", csrf="csrf", mutation=True)
