"""缩略图协作：缓存零回源、生成权超时、源版本、取消与私密空间访问边界。"""

import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.errors import NotFoundError, NotReadyError
from tgdrive.keystore import KeyStore
from tgdrive.metadata import Metadata
from tgdrive.objects import ObjectService, PRIVATE_PREFIX, Scope
from tgdrive.thumbnails import MIB, ThumbnailBudget, ThumbnailError, ThumbnailRetry, ThumbnailService, _RangeInput, _Job
from tgdrive.thumbnail_cache import ThumbnailCacheMiss


JPEG = b"\xff\xd8\xff\xe0" + b"test-thumbnail" * 8


class Writer:
    def __init__(self):
        self.data = bytearray()

    def write(self, data):
        self.data.extend(data)

    async def drain(self):
        pass

    def close(self):
        pass

    async def wait_closed(self):
        pass


class GenerationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.metadata = Metadata()
        self.keys = KeyStore(self.metadata)
        self.keys.initialize("test passphrase")
        self.engine = BlobEngine(self.metadata, LocalDiskBlobStore(Path(self.temp.name)), keystore=self.keys,
                                 chunk_size=32, frame_size=8)
        self.objects = ObjectService(self.metadata, self.engine)
        self.scope = Scope(self.objects.create_bucket("thumbnail-tests"))
        resources = SimpleNamespace(ffmpeg="ffmpeg", detected={"memory_bytes": 1024**3}, pressure=lambda: None)
        self.worker = ThumbnailService(SimpleNamespace(keystore=self.keys), self.objects, resources)

    async def asyncTearDown(self):
        await self.worker.stop()
        self.metadata.close()
        self.temp.cleanup()

    async def put(self, key="image.jpg", scope=None):
        return await self.objects.put_object(scope or self.scope, key, bytes(range(128)))

    def variants(self, info):
        return [row[0] for row in self.metadata.db.execute(
            "SELECT variant FROM thumbnails WHERE blob_uuid=? ORDER BY variant", (info.blob_uuid,))]

    def renderer(self, result):
        # 生成器独立于解码器测试：不启动本地监听，也不要求 CI 安装 FFmpeg。
        entry = Mock()
        entry.return_value.__aenter__ = AsyncMock(return_value=Mock())
        entry.return_value.__aexit__ = AsyncMock(return_value=False)
        return patch("tgdrive.thumbnails._RangeInput", entry), patch.object(self.worker, "_render", AsyncMock(return_value=result))

    async def test_put_and_multipart_notify_after_commit_with_scope(self):
        notify = Mock()
        self.objects.on_commit = notify
        info = await self.put()
        notify.assert_called_once_with(info, self.scope)
        upload = await self.objects.create_multipart(self.scope, "video.mp4")
        part = await self.objects.upload_part(self.scope, upload, 1, b"video")
        completed = await self.objects.complete_multipart(self.scope, upload, [(1, part.etag)])
        self.assertEqual(notify.call_args.args, (completed, self.scope))
        self.assertEqual(notify.call_count, 2)
        self.objects.on_commit = Mock(side_effect=RuntimeError("queue unavailable"))
        saved = await self.put("still-saved.jpg")
        self.assertEqual(self.objects.head_object(self.scope, saved.key).blob_uuid, saved.blob_uuid)

    async def test_commit_generates_from_received_cache_and_skips_system_files(self):
        info = await self.put()
        private = Scope(self.scope.bucket_id, PRIVATE_PREFIX, private_access=True, authorize=lambda: None)
        secret = await self.put(PRIVATE_PREFIX + "secret.jpg", private)
        attachment = await self.put(".tgdrive/assistant/attachment.jpg")
        report = await self.put("report.pdf")
        self.assertFalse(self.worker._eligible(attachment))
        self.assertFalse(self.worker._eligible(report))
        channel, render = self.renderer({"thumb": JPEG})
        with channel, render:
            self.worker.start()
            for item in (info, secret, attachment, report):
                self.worker.enqueue(item)
            async with asyncio.timeout(4):
                while not (self.variants(info) and self.variants(secret)):
                    await asyncio.sleep(0.01)
            await self.worker.stop()
        self.assertEqual(self.variants(info), ["thumb"])
        self.assertEqual(self.variants(attachment), [])
        stored = self.metadata.db.execute("SELECT data FROM thumbnails WHERE blob_uuid=?", (info.blob_uuid,)).fetchone()[0]
        self.assertNotIn(JPEG, bytes(stored))

    async def test_jobs_without_received_data_leave_the_queue(self):
        info = await self.put()
        self.worker.cache.drop(info.blob_uuid)
        channel, render = self.renderer({"thumb": JPEG})
        with channel, render as decoder:
            self.worker.start()
            self.worker._enqueue(_Job(info))
            async with asyncio.timeout(3):
                while info.blob_uuid in self.worker._pending:
                    await asyncio.sleep(0.01)
            decoder.assert_not_awaited()
        self.assertNotIn(info.blob_uuid, self.worker._history, "复制、秒传等没有数据的任务不进入队列记录")

    async def test_web_preview_waits_for_browser_before_backend_takes_over(self):
        self.worker._loop = asyncio.get_running_loop()
        image, song = await self.put("photo.jpg"), await self.put("song.mp3")
        self.worker.observe(image, client=True)
        self.worker.observe(song, client=True)
        await asyncio.sleep(0)
        self.assertEqual(self.worker._pending[image.blob_uuid].state, "waiting_client")
        self.assertEqual(self.worker._pending[song.blob_uuid].state, "queued", "浏览器取不到音频缓冲，直接由后台处理")

    async def test_cache_misses_back_off_and_give_up(self):
        info = await self.put("clip.mp4")
        channel, render = self.renderer({})
        with channel, render as decoder:
            decoder.side_effect = ThumbnailCacheMiss("partial")
            self.worker.start()
            job = _Job(info)
            self.worker._enqueue(job)
            for attempt in range(1, 7):
                async with asyncio.timeout(3):
                    while decoder.await_count < attempt:
                        await asyncio.sleep(0.01)
                await asyncio.sleep(0.02)
                if attempt < 6:
                    self.assertEqual(job.state, "waiting_data")
                    self.worker._received(info.blob_uuid)
                    self.assertGreaterEqual(job.ready_at - __import__("time").monotonic(), 2 << job.misses - 1)
                    job.ready_at = 0
                    self.worker._wake.set()
        self.assertNotIn(info.blob_uuid, self.worker._pending)
        self.assertEqual(self.worker._history[info.blob_uuid]["state"], "failed")

    async def test_quota_keeps_small_thumbnail_and_no_cover_is_not_repeated(self):
        info = await self.put()
        self.metadata.db.execute("UPDATE buckets SET quota_bytes=used_bytes WHERE id=?", (info.bucket_id,))
        channel, render = self.renderer({"thumb": JPEG, "grid": JPEG, "poster": JPEG})
        with channel, render:
            await self.worker.generate(info)
        self.assertEqual(self.variants(info), ["thumb"])
        audio = await self.put("song.mp3", Scope(self.objects.create_bucket("audio-tests")))
        channel, render = self.renderer(None)
        with channel, render as decoder:
            await self.worker.generate(audio)
            await self.worker.generate(audio)
            self.assertEqual(decoder.await_count, 1)
        self.assertEqual(self.variants(audio), ["none"])

    async def test_overwritten_source_cannot_receive_stale_result(self):
        info = await self.put()

        async def overwrite(*_):
            await self.put()
            return {"thumb": JPEG}

        channel, render = self.renderer({})
        with channel, render as decoder:
            decoder.side_effect = overwrite
            with self.assertRaises(NotFoundError):
                await self.worker.generate(info)
        current = self.objects.head_object(self.scope, info.key)
        self.assertEqual(self.variants(current), [])

    async def test_private_lock_does_not_block_internal_job_but_system_lock_does(self):
        authorize = Mock()
        private = Scope(self.scope.bucket_id, PRIVATE_PREFIX, private_access=True, authorize=authorize)
        info = await self.put(PRIVATE_PREFIX + "secret.jpg", private)
        async def lock(*_):
            authorize.side_effect = PermissionError("private locked")
            return {"thumb": JPEG}

        channel, render = self.renderer({})
        with channel, render as decoder:
            decoder.side_effect = lock
            await self.worker.generate(info, private)
        self.assertEqual(self.variants(info), ["thumb"])
        self.assertEqual(authorize.call_count, 2, "后台任务不调用或延长网页私密授权")
        public = await self.put("public.jpg")
        scope = self.worker._scope(public, None)
        self.keys.lock()
        with self.assertRaises(NotReadyError):
            scope.authorize()

    async def request(self, source, target, byte_range="bytes=28-69"):
        source.origin, source.url = "http://127.0.0.1:12345", "http://127.0.0.1:12345" + source.path
        reader, writer = asyncio.StreamReader(), Writer()
        reader.feed_data(f"GET {target} HTTP/1.1\r\nHost: 127.0.0.1:12345\r\nRange: {byte_range}\r\n\r\n".encode())
        await source._serve(reader, writer)
        return bytes(writer.data)

    async def test_range_crosses_encrypted_chunks_and_rejects_external_targets(self):
        info = await self.put()
        source = _RangeInput(self.engine, info, lambda: None, 128, cache_only=True)
        response = await self.request(source, source.path)
        self.assertEqual(response.split(b"\r\n\r\n", 1)[1], bytes(range(28, 70)))
        self.assertIn(b"Content-Range: bytes 28-69/128", response)
        response = await self.request(source, "http://192.168.1.1/secret")
        self.assertTrue(response.startswith(b"HTTP/1.1 403"))
        self.assertEqual(source.remaining, 128 - 42)

    async def test_read_budget_and_revoked_access_stop_plaintext_delivery(self):
        info = await self.put()
        source = _RangeInput(self.engine, info, lambda: None, 16)
        response = await self.request(source, source.path)
        self.assertIsInstance(source.failure, ThumbnailBudget)
        self.assertEqual(response.split(b"\r\n\r\n", 1)[1], b"")
        authorize = Mock(side_effect=[None, None, PermissionError("revoked")])
        source = _RangeInput(self.engine, info, authorize, 128)
        response = await self.request(source, source.path)
        self.assertIsInstance(source.failure, PermissionError)
        self.assertEqual(response.split(b"\r\n\r\n", 1)[1], b"")

    async def test_timeout_terminates_decoder_and_drains_its_pipes(self):
        ended = asyncio.Event()
        process = SimpleNamespace(pid=0, returncode=None, stderr=asyncio.StreamReader())

        async def wait():
            await ended.wait()
            return process.returncode

        def kill():
            process.returncode = -9
            process.stderr.feed_eof()
            ended.set()

        process.wait, process.kill = wait, Mock(side_effect=kill)
        source = SimpleNamespace(url="http://127.0.0.1/input", origin="http://127.0.0.1", failure=None)
        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=process)):
            with self.assertRaises(TimeoutError):
                async with asyncio.timeout(0.02):
                    await self.worker._render(source, "video", Path(self.temp.name), lambda: None)
        process.kill.assert_called_once()
        self.assertTrue(ended.is_set())

    async def test_received_upload_cache_generates_without_store_get(self):
        info = await self.put()
        self.engine.store.get = AsyncMock(side_effect=AssertionError("自动任务不能回源"))
        source = _RangeInput(self.engine, info, lambda: None, 128, cache_only=True)
        response = await self.request(source, source.path)
        self.assertEqual(response.split(b"\r\n\r\n", 1)[1], bytes(range(28, 70)))
        self.assertIsNone(source.failure)
        self.engine.store.get.assert_not_awaited()

    async def test_cache_miss_never_falls_back_to_remote(self):
        info = await self.put()
        self.worker.cache.drop(info.blob_uuid)
        self.engine.store.get = AsyncMock(side_effect=AssertionError("不能回源"))
        source = _RangeInput(self.engine, info, lambda: None, 128, cache_only=True)
        response = await self.request(source, source.path)
        self.assertIsInstance(source.failure, ThumbnailCacheMiss)
        self.assertEqual(response.split(b"\r\n\r\n", 1)[1], b"")
        self.engine.store.get.assert_not_awaited()

    async def test_manual_read_downloads_each_cipher_chunk_only_once(self):
        info = await self.put()
        self.worker.cache.drop(info.blob_uuid)
        self.worker.cache.prepare(info.blob_uuid, info.key)
        original = self.engine.store.get
        self.engine.store.get = AsyncMock(side_effect=original)
        source = _RangeInput(self.engine, info, lambda: None, 1024)
        for _ in range(2):
            response = await self.request(source, source.path)
            self.assertIsNone(source.failure)
            self.assertEqual(response.split(b"\r\n\r\n", 1)[1], bytes(range(28, 70)))
        self.assertEqual(self.engine.store.get.await_count, 3, "28–69 只涉及三个加密分片，每片取回一次")
        self.assertTrue(all(call.args[1:] == () for call in self.engine.store.get.await_args_list))

    async def test_browser_claim_excludes_backend_and_expired_results(self):
        info = await self.put()
        lease = self.worker.claim(self.scope, info.key, info.etag)
        self.assertTrue(lease["token"])
        self.assertIsNone(self.worker.claim(self.scope, info.key, info.etag)["token"])
        self.assertEqual(self.worker._pending[info.blob_uuid].state, "waiting_client")
        self.worker.check_claim(info, lease["token"])
        self.worker._leases[info.blob_uuid].until = 0
        with self.assertRaises(ValueError):
            self.worker.check_claim(info, lease["token"])
        lease = self.worker.claim(self.scope, info.key, info.etag)
        self.worker.release(self.scope, info.key, info.etag, lease["token"])
        self.assertEqual(self.worker._pending[info.blob_uuid].state, "queued")

    async def test_deletion_and_overwrite_cancel_pending_and_running_jobs(self):
        self.worker._loop = asyncio.get_running_loop()
        info = await self.put()
        self.worker._enqueue(_Job(info))
        await self.objects.delete_objects(self.scope, [info.key])
        await asyncio.sleep(0)
        self.assertNotIn(info.blob_uuid, self.worker._pending)
        self.assertEqual(self.worker._history[info.blob_uuid]["state"], "cancelled")
        info = await self.put()
        job = _Job(info, state="running")
        self.worker._enqueue(job)
        self.worker._active, self.worker._task = job, asyncio.create_task(asyncio.sleep(60))
        await self.put()
        await asyncio.sleep(0)
        await asyncio.gather(self.worker._task, return_exceptions=True)
        self.assertTrue(self.worker._task.cancelled())
        self.assertNotIn(info.blob_uuid, self.worker._pending)

    async def test_multipart_cache_works_with_out_of_order_parts(self):
        self.objects.MIN_PART_SIZE = 1
        upload = await self.objects.create_multipart(self.scope, "song.flac")
        second = await self.objects.upload_part(self.scope, upload, 2, b"second")
        first = await self.objects.upload_part(self.scope, upload, 1, b"first")
        info = await self.objects.complete_multipart(self.scope, upload, [(1, first.etag), (2, second.etag)])
        self.engine.store.get = AsyncMock(side_effect=AssertionError("不能回源"))
        data = b"".join([piece async for piece in self.engine.stream(info.blob_uuid, cache_only=True)])
        self.assertEqual(data, b"firstsecond")

    async def test_browser_timeout_hands_cache_to_backend_without_overlap(self):
        info = await self.put()
        lease = self.worker.claim(self.scope, info.key, info.etag)
        channel, render = self.renderer({"thumb": JPEG})
        with channel, render as decoder:
            self.worker.start()
            await asyncio.sleep(0.03)
            decoder.assert_not_awaited()
            self.worker._leases[info.blob_uuid].until = 0
            self.worker._pending[info.blob_uuid].ready_at = 0
            self.worker._wake.set()
            async with asyncio.timeout(3):
                while not self.variants(info):
                    await asyncio.sleep(0.01)
            decoder.assert_awaited_once()
        with self.assertRaises(ValueError):
            self.worker.check_claim(info, lease["token"])

    async def test_move_retargets_job_and_preserves_received_cipher_data(self):
        self.worker._loop = asyncio.get_running_loop()
        info = await self.put()
        self.worker.claim(self.scope, info.key, info.etag)
        self.objects.move(self.scope, info.key, "renamed.jpg")
        await asyncio.sleep(0)
        self.assertEqual(self.worker._pending[info.blob_uuid].info.key, "renamed.jpg")
        self.assertNotIn(info.blob_uuid, self.worker._leases)
        self.engine.store.get = AsyncMock(side_effect=AssertionError("不能回源"))
        self.assertEqual(b"".join([part async for part in self.engine.stream(info.blob_uuid, cache_only=True)]), bytes(range(128)))

    def age(self, info, seconds=3600):
        self.metadata.db.execute("UPDATE objects SET modified_at=modified_at-? WHERE bucket_id=? AND key=?", (seconds, info.bucket_id, info.key))

    def remote_renderer(self, result, remote=0):
        # 补图任务会从存储读取：替身来源报告读取量，用来核对每日额度。
        entry = Mock()
        entry.return_value.__aenter__ = AsyncMock(return_value=SimpleNamespace(remote_bytes=remote))
        entry.return_value.__aexit__ = AsyncMock(return_value=False)
        return patch("tgdrive.thumbnails._RangeInput", entry), patch.object(self.worker, "_render", AsyncMock(return_value=result))

    async def test_backfill_generates_old_files_without_cache_and_counts_daily_reads(self):
        old, fresh = await self.put("old.jpg"), await self.put("fresh.jpg")
        private = Scope(self.scope.bucket_id, PRIVATE_PREFIX, private_access=True, authorize=lambda: None)
        secret = await self.put(PRIVATE_PREFIX + "secret.mp3", private)
        for info in (old, fresh, secret):
            self.worker.cache.drop(info.blob_uuid)
        self.age(old); self.age(secret)
        channel, render = self.remote_renderer({"thumb": JPEG}, remote=3 * MIB)
        with channel as source, render:
            self.worker.start()
            self.worker._backfill_at = 0
            async with asyncio.timeout(4):
                while not (self.variants(old) and self.variants(secret)):
                    await asyncio.sleep(0.01)
            self.assertTrue(all(call.kwargs.get("cache_only") is False for call in source.call_args_list), "补图允许按预算读取存储")
        self.assertEqual(self.variants(fresh), [], "刚写入的文件先留给上传端与缓存处理")
        self.assertEqual(self.worker.backfill_status()["used_bytes"], 6 * MIB)

    async def test_backfill_respects_daily_limit_and_switch(self):
        info = await self.put()
        self.worker.cache.drop(info.blob_uuid)
        self.age(info)
        self.worker.configure_backfill(0)
        channel, render = self.remote_renderer({"thumb": JPEG})
        with channel, render as decoder:
            self.worker.start()
            self.worker._backfill_at = 0
            await asyncio.sleep(0.2)
            decoder.assert_not_awaited()
            self.worker.configure_backfill(1)
            self.worker._charge_backfill(MIB)
            self.worker._backfill_at = 0
            await asyncio.sleep(0.2)
            decoder.assert_not_awaited()
            self.worker.configure_backfill(-1)
            async with asyncio.timeout(3):
                while not self.variants(info):
                    await asyncio.sleep(0.01)
        self.assertIsNone(self.worker.backfill_status()["daily_bytes"])
        for bad in (True, "4096", -2, 2 ** 40):
            with self.assertRaises(ValueError):
                self.worker.configure_backfill(bad)

    async def test_backfill_marks_undecodable_file_once(self):
        info = await self.put("broken.mp4")
        self.worker.cache.drop(info.blob_uuid)
        self.age(info)
        channel, render = self.remote_renderer({})
        with channel, render as decoder:
            decoder.side_effect = ThumbnailError("当前解码器未能生成缩略图")
            self.worker.start()
            self.worker._backfill_at = 0
            async with asyncio.timeout(3):
                while not self.variants(info):
                    await asyncio.sleep(0.01)
            self.worker._backfill_at = 0
            await asyncio.sleep(0.2)
            self.assertEqual(decoder.await_count, 1, "记为无法生成后不再自动重试")
        self.assertEqual(self.variants(info), ["none"])

    async def test_decoder_environment_failure_is_retried_not_marked_undecodable(self):
        # 旧版用 RLIMIT_AS 限制解码器，FFmpeg 7 在加载库或创建线程时就失败，结果所有文件都被误记为「无法生成」。
        directory = Path(self.temp.name) / "fake-ffmpeg"
        directory.mkdir()
        for name, (message, code) in {"threads": ("pthread_create() failed: Resource temporarily unavailable", 1),
                                       "killed": ("", -9), "broken": ("Invalid data found when processing input", 1)}.items():
            script = directory / name
            script.write_text("#!/bin/sh\n" + (f"echo '{message}' >&2\n" if message else "") +
                              ("kill -9 $$\n" if code < 0 else f"exit {code}\n"))
            script.chmod(0o755)
        source = SimpleNamespace(url="http://127.0.0.1:9/x", origin="http://127.0.0.1:9", failure=None)
        for name, expected in (("threads", ThumbnailRetry), ("killed", ThumbnailRetry), ("broken", ThumbnailError)):
            self.worker.resources.ffmpeg = str(directory / name)
            with self.assertRaises(ThumbnailError) as caught:
                await self.worker._render(source, "image", directory, lambda: None)
            self.assertIs(type(caught.exception), expected, name)
        info = await self.put("photo.jpg")
        self.worker.cache.drop(info.blob_uuid)
        self.age(info)
        channel, render = self.remote_renderer({})
        with channel, render as decoder:
            decoder.side_effect = ThumbnailRetry("解码器运行环境受限，稍后再生成")
            self.worker.start()
            self.worker._backfill_at = 0
            async with asyncio.timeout(3):
                while not decoder.await_count:
                    await asyncio.sleep(0.01)
                while self.worker._active is not None or info.blob_uuid in self.worker._pending:
                    await asyncio.sleep(0.01)
            for _ in range(3):
                self.worker._backfill_skip.clear()
                self.worker._backfill_at = 0
                self.worker._wake.set()
                await asyncio.sleep(0.15)
        self.assertGreaterEqual(decoder.await_count, 3)
        self.assertEqual(self.variants(info), [], "运行环境问题不能把文件记为无法生成")

    async def test_backfill_cursor_keeps_files_beyond_the_queue_limit(self):
        infos = [await self.put(f"batch/{index:02}.jpg") for index in range(10)]
        for info in infos:
            self.worker.cache.drop(info.blob_uuid)
            self.age(info)
        channel, render = self.remote_renderer({"thumb": JPEG})
        with channel, render:
            self.worker.start()
            self.worker._backfill_at = 0
            async with asyncio.timeout(4):
                while not all(self.variants(info) for info in infos):
                    await asyncio.sleep(0.01)

    async def test_repair_clears_old_undecodable_marks_once(self):
        info = await self.put("old.jpg")
        await self.objects.set_thumbnail(self.scope, info.key, None, "none")
        self.worker._repair()
        self.assertEqual(self.variants(info), [], "升级后重新交给补图")
        await self.objects.set_thumbnail(self.scope, info.key, None, "none")
        self.worker._repair()
        self.assertEqual(self.variants(info), ["none"], "只执行一次，之后的确定结果保留")


if __name__ == "__main__":
    unittest.main()
