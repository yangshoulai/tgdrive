"""手动候选图的关键回归；服务与权限用内存替身，不连接数据库或 Telegram。"""

import asyncio
import shutil
import struct
import tempfile
import time
import unittest
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from tgdrive.asgi import TgDriveASGI
from tgdrive.api import UserApi
from tgdrive.crypto import open_sealed, seal
from tgdrive.objects import ObjectInfo, ObjectService, PRIVATE_PREFIX, Scope
from tgdrive.errors import QuotaExceededError
from tgdrive.thumbnails import MIB, ThumbnailError, ThumbnailService, _Job
from tgdrive.video_candidates import frame_positions, frame_usable, same_frame


JPEG = b"\xff\xd8\xff\xe0test-image"


def detailed(seed=0):
    return bytes(32 + (x * 17 + y * 13 + seed * 37) % 180 for y in range(64) for x in range(64))


def ffmpeg_executable():
    executable = shutil.which("ffmpeg")
    if not executable:
        try:
            import imageio_ffmpeg  # 本地验证可选，服务不依赖这个包。
            executable = imageio_ffmpeg.get_ffmpeg_exe()
        except (ImportError, RuntimeError):
            return None
    return executable


class CandidateFrameTests(unittest.TestCase):
    def test_gray_background_with_dense_text_is_rejected(self):
        pixels = bytes(224 if y % 12 in (4, 5, 6) and 8 <= x < 56 else 110 for y in range(64) for x in range(64))
        self.assertFalse(frame_usable(pixels))
        self.assertFalse(frame_usable(bytes(4096)))
        self.assertFalse(frame_usable(b"\xff" * 4096))
        antialiased = bytes(128 if (x + y * 5) % 10 < 6 else 195 if (x + y * 5) % 10 < 8 else 230
                            for y in range(64) for x in range(64))
        self.assertFalse(frame_usable(antialiased))
        self.assertTrue(frame_usable(detailed()))

    def test_candidates_are_different_and_short_videos_stay_in_range(self):
        self.assertTrue(same_frame(detailed(), detailed()))
        self.assertFalse(same_frame(detailed(), detailed(1)))
        positions = frame_positions(.8)
        self.assertGreaterEqual(len(positions), 5)
        self.assertEqual(positions[:3], sorted(positions[:3]))
        self.assertEqual(len(positions), len(set(positions)))
        self.assertTrue(all(0 < value < .8 for value in positions))
        self.assertEqual(frame_positions(1200)[:3], [120, 600, 1080])

    def test_long_movie_candidates_cover_different_sections_before_nearby_fallbacks(self):
        positions = frame_positions(7200, 9)
        self.assertEqual(positions[:9], list(range(720, 6481, 720)))
        self.assertTrue(all(abs(right - left) >= 720 for left, right in zip(positions[:8], positions[1:9])))
        self.assertEqual(frame_positions(7200, 1)[0], 3600)
        self.assertEqual(frame_positions(None, 9)[:4], [5, 15, 30, 60])


class PlayerThumbnailSaveTests(unittest.TestCase):
    def setUp(self):
        self.api = UserApi.__new__(UserApi)
        self.scope = Scope(7, authorize=lambda: None)
        self.info = ObjectInfo(7, "movie.mp4", 1000000, "video-v1", "video/mp4", {}, 100, "blob-video")
        self.api._scope = Mock(return_value=self.scope)
        self.api.objects = SimpleNamespace(STORED_THUMBNAILS=ObjectService.STORED_THUMBNAILS,
            head_object=Mock(return_value=self.info), finish_thumbnail_set=Mock(), thumbnail_service=Mock())

    def test_selected_frame_finishes_its_set_and_releases_the_generation_claim(self):
        self.api.thumbnail_release("session", "csrf", self.info.key, self.info.etag, "ticket", ["thumb"])
        self.api._scope.assert_called_once_with("session", csrf="csrf", mutation=True)
        self.api.objects.thumbnail_service.check_claim.assert_called_once_with(self.info, "ticket")
        self.api.objects.finish_thumbnail_set.assert_called_once_with(self.scope, self.info.key, ["thumb"])
        self.api.objects.thumbnail_service.release.assert_called_once_with(self.scope, self.info.key, self.info.etag, "ticket")

    def test_old_version_or_invalid_claim_cannot_finish_a_set(self):
        with self.assertRaisesRegex(ValueError, "变化"):
            self.api.thumbnail_release("session", "csrf", self.info.key, "old-version", "ticket", ["thumb"])
        self.api.objects.thumbnail_service.check_claim.side_effect = ValueError("生成权已失效")
        with self.assertRaisesRegex(ValueError, "失效"):
            self.api.thumbnail_release("session", "csrf", self.info.key, self.info.etag, "ticket", ["thumb"])
        self.api.objects.finish_thumbnail_set.assert_not_called()

    def test_invalid_variants_cannot_remove_existing_thumbnails(self):
        for variants in ([], ["none"], ["grid"], ["thumb", "bad"], "thumb", ["thumb", {}]):
            with self.subTest(variants=variants), self.assertRaises(ValueError):
                self.api.thumbnail_release("session", "csrf", self.info.key, self.info.etag, "ticket", variants)
        self.api.objects.finish_thumbnail_set.assert_not_called()


class CandidateServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.info = ObjectInfo(7, "movie.mp4", 1000000, "video-v1", "video/mp4", {}, 100, "blob-video")
        self.scope = Scope(7, authorize=lambda: None)
        key = b"k" * 32
        engine = SimpleNamespace(
            seal_thumbnail=lambda blob, variant, data: seal(key, data, f"{blob}/{variant}"),
            open_thumbnail=lambda blob, variant, data: open_sealed(key, data, f"{blob}/{variant}"))
        self.objects = SimpleNamespace(metadata=Mock(), engine=engine, head_object=Mock(return_value=self.info),
            _check_scope=self.check_scope, set_thumbnail=AsyncMock(), finish_thumbnail_set=Mock(),
            THUMBNAIL_LIMITS=ObjectService.THUMBNAIL_LIMITS)
        self.worker = ThumbnailService(SimpleNamespace(keystore=SimpleNamespace(unlocked=True)), self.objects,
            SimpleNamespace(ffmpeg="test-decoder", pressure=lambda: None, detected={"memory_bytes": 1024**3}))
        self.worker._scope = Mock(return_value=self.scope)
        self.worker._setting = Mock(return_value={})
        self.worker._save_setting = Mock()

    async def asyncTearDown(self):
        await self.worker.stop()

    def check_scope(self, scope, key, *, write=False):
        if scope.authorize:
            scope.authorize()
        if write and scope.perms == "ro" or key.startswith(PRIVATE_PREFIX) and not scope.private_access:
            raise PermissionError("无权访问")

    def request(self):
        return self.worker.request_candidates(self.scope, self.info.key, self.info.etag, "session")

    @asynccontextmanager
    async def source(self, *_args, **_kwargs):
        self.assertIsNone(_args[3], "用户手动选图不应套用自动生成的读取预算")
        yield SimpleNamespace(duration=8, remote_bytes=0)

    async def prepare(self, samples):
        value = self.request()
        job = self.worker._pending[self.info.blob_uuid]
        with patch("tgdrive.thumbnails._RangeInput", self.source), patch.object(self.worker, "_render_frame", AsyncMock(side_effect=[({"thumb": JPEG}, bytes(4096)), *samples])):
            await self.worker._generate_candidates(job)
        return value["id"]

    def test_default_count_admin_range_and_read_only_scope(self):
        self.assertEqual(self.request()["count"], 3)
        self.assertEqual(self.worker.configure_candidates(9), {"candidate_count": 9})
        for count in (0, 10, True, 1.5, "3", None):
            with self.subTest(count=count), self.assertRaises(ValueError):
                self.worker.configure_candidates(count)
        with self.assertRaises(PermissionError):
            self.worker.request_candidates(replace(self.scope, perms="ro"), self.info.key, self.info.etag, "session")

    def test_ownership_etag_and_request_reuse(self):
        first = self.request()
        self.assertEqual(self.request()["id"], first["id"])
        self.assertNotIn("session", repr(self.worker._choices))
        with self.assertRaises(ValueError):
            self.worker.candidates_status(self.scope, self.info.key, self.info.etag, "another-session", first["id"])
        self.objects.head_object.return_value = replace(self.info, etag="overwritten", blob_uuid="another-blob")
        with self.assertRaisesRegex(ValueError, "覆盖"):
            self.worker.candidates_status(self.scope, self.info.key, self.info.etag, "session", first["id"])
        self.assertNotIn(first["id"], self.worker._choices)

    def test_pending_copy_uses_the_path_from_the_manual_request(self):
        other = replace(self.info, key="another-copy.mp4")
        self.worker._pending[self.info.blob_uuid] = _Job(other)
        request = self.request()
        job = self.worker._pending[self.info.blob_uuid]
        self.assertEqual(job.info, self.info)
        self.assertEqual(job.choice, request["id"])

    async def test_gray_intro_duplicates_and_user_confirmation(self):
        samples = [({"thumb": JPEG}, bytes([110]) * 4096), ({"thumb": JPEG + b"1", "grid": JPEG + b"large1"}, detailed()),
                   ({"thumb": JPEG}, detailed()), ({"thumb": JPEG + b"2", "grid": JPEG + b"large2"}, detailed(1)),
                   ({"thumb": JPEG + b"3"}, detailed(2))]
        identity = await self.prepare(samples)
        choice = self.worker.candidates_status(self.scope, self.info.key, self.info.etag, "session", identity)
        self.assertEqual(choice["state"], "ready")
        self.assertEqual(len(choice["frames"]), 3)
        self.assertGreater(choice["frames"][0]["seconds"], 0)
        self.objects.set_thumbnail.assert_not_awaited()
        self.assertNotIn(JPEG, self.worker._choices[identity].frames[1].images["thumb"])
        self.assertEqual(self.worker.candidate_image(self.scope, self.info.key, self.info.etag, "session", identity, 1), JPEG + b"large2")
        await self.worker.select_candidate(self.scope, self.info.key, self.info.etag, "session", identity, 1)
        self.assertEqual([call.args[2] for call in self.objects.set_thumbnail.await_args_list], [JPEG + b"2", JPEG + b"large2"])
        self.objects.finish_thumbnail_set.assert_called_once()
        self.assertNotIn(identity, self.worker._choices)

    async def test_long_movie_opening_probe_does_not_replace_a_distributed_candidate(self):
        self.worker._setting.return_value = {"count": 9}
        @asynccontextmanager
        async def source(*args, **kwargs):
            yield SimpleNamespace(duration=7200, remote_bytes=0)
        # 即使开头本身画质合格，也只用于获取时长，九张候选仍覆盖不同段落。
        renderer = AsyncMock(side_effect=[({"thumb": JPEG}, detailed(seed)) for seed in range(10)])
        value = self.request()
        with patch("tgdrive.thumbnails._RangeInput", source), patch.object(self.worker, "_render_frame", renderer):
            await self.worker._generate_candidates(self.worker._pending[self.info.blob_uuid])
        expected = list(range(720, 6481, 720))
        self.assertEqual([frame.position for frame in self.worker._choices[value["id"]].frames], expected)
        self.assertEqual([call.kwargs["position"] for call in renderer.await_args_list], [0, *expected])

    async def test_decoder_failure_keeps_available_candidates_and_reports_its_real_reason(self):
        identity = await self.prepare([({"thumb": JPEG}, detailed()), ThumbnailError("视频后续画面无法解码")])
        self.assertEqual(self.worker._choices[identity].state, "ready")
        self.assertEqual(len(self.worker._choices[identity].frames), 1)
        self.assertIn("无法解码", self.worker._choices[identity].detail)
        self.assertNotIn("上限", self.worker._choices[identity].detail)
        self.objects.set_thumbnail.assert_not_awaited()
        self.worker.cancel_candidates(self.scope, self.info.key, self.info.etag, "session", identity)
        self.assertNotIn(identity, self.worker._choices)
        self.assertNotIn(self.info.blob_uuid, self.worker._leases)

    async def test_manual_generation_and_save_do_not_use_automatic_deadlines(self):
        async def render(*args, **kwargs):
            await asyncio.sleep(.01)
            return {"thumb": JPEG}, detailed(int(kwargs["position"]))
        with patch("tgdrive.thumbnails.TIMEOUT", .001), patch("tgdrive.thumbnails._RangeInput", self.source), \
                patch.object(self.worker, "_render_frame", render):
            value = self.request()
            await self.worker._generate_candidates(self.worker._pending[self.info.blob_uuid])
            self.assertEqual(len(self.worker._choices[value["id"]].frames), 3)
            async def save(scope, *args):
                await asyncio.sleep(.01)
                self.worker._choices[value["id"]].until = 0
                self.worker._expire_clients()
                scope.authorize()
            self.objects.set_thumbnail.side_effect = save
            await self.worker.select_candidate(self.scope, self.info.key, self.info.etag, "session", value["id"], 0)
        self.objects.finish_thumbnail_set.assert_called_once()

    def test_waiting_or_running_candidates_do_not_expire_during_processing(self):
        value = self.request()
        choice = self.worker._choices[value["id"]]
        choice.until = 0
        for state in ("queued", "running"):
            choice.state = state
            self.assertEqual(self.worker.candidates_status(self.scope, self.info.key, self.info.etag, "session", value["id"])["state"], state)

    async def test_cancel_still_stops_an_active_candidate_decoder(self):
        started, stopped = asyncio.Event(), asyncio.Event()
        async def render(*args, **kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        value = self.request()
        self.worker._repair = Mock()
        with patch("tgdrive.thumbnails._RangeInput", self.source), patch.object(self.worker, "_render_frame", render):
            self.worker.start()
            await asyncio.wait_for(started.wait(), 1)
            self.worker.cancel_candidates(self.scope, self.info.key, self.info.etag, "session", value["id"])
            await asyncio.wait_for(stopped.wait(), 1)
        self.assertNotIn(value["id"], self.worker._choices)
        self.objects.set_thumbnail.assert_not_awaited()

    async def test_worker_uses_candidate_path_and_reserves_generation_lease(self):
        value = self.request()
        self.worker._repair = Mock()
        with patch("tgdrive.thumbnails._RangeInput", self.source), patch.object(self.worker, "_render_frame", AsyncMock(side_effect=[({"thumb": JPEG}, bytes(4096)), *[({"thumb": JPEG}, detailed(seed)) for seed in range(3)]])):
            self.worker.start()
            async def ready():
                while self.worker._choices[value["id"]].state != "ready" or self.info.blob_uuid in self.worker._pending:
                    await asyncio.sleep(0)
            await asyncio.wait_for(ready(), 1)
        self.objects.set_thumbnail.assert_not_awaited()
        self.assertEqual(self.worker._leases[self.info.blob_uuid].token, value["id"])
        self.worker.cancel_candidates(self.scope, self.info.key, self.info.etag, "session", value["id"])
        self.assertNotIn(self.info.blob_uuid, self.worker._leases)

    async def test_quota_after_small_thumbnail_drops_outdated_large_variants(self):
        identity = await self.prepare([({"thumb": JPEG, "grid": JPEG + b"grid"}, detailed(seed)) for seed in range(3)])
        self.objects.set_thumbnail.side_effect = [None, QuotaExceededError("空间不足")]
        await self.worker.select_candidate(self.scope, self.info.key, self.info.etag, "session", identity, 0)
        self.assertEqual(self.objects.finish_thumbnail_set.call_args.args[2], ["thumb"])
        self.assertNotIn(identity, self.worker._choices)

    async def test_expiry_and_private_relock_reject_images_and_saves(self):
        identity = await self.prepare([({"thumb": JPEG}, detailed(seed)) for seed in range(3)])
        locked = replace(self.scope, authorize=Mock(side_effect=PermissionError("私密空间已锁定")))
        with self.assertRaises(PermissionError):
            self.worker.candidate_image(locked, self.info.key, self.info.etag, "session", identity, 0)
        with self.assertRaises(PermissionError):
            await self.worker.select_candidate(locked, self.info.key, self.info.etag, "session", identity, 0)
        self.objects.set_thumbnail.assert_not_awaited()
        self.worker._choices[identity].until = time.monotonic() - 1
        with self.assertRaisesRegex(ValueError, "失效"):
            self.worker.candidates_status(self.scope, self.info.key, self.info.etag, "session", identity)
        self.assertNotIn(self.info.blob_uuid, self.worker._leases)

    async def test_admin_configuration_requires_admin_and_csrf(self):
        app = TgDriveASGI.__new__(TgDriveASGI)
        app.user, app.thumbnails = Mock(), self.worker
        sessions = Mock()
        app.admin = SimpleNamespace(accounts=SimpleNamespace(sessions=sessions, account_for_session=Mock(), keystore=SimpleNamespace(unlocked=True)))
        sessions.require.side_effect = PermissionError("需要管理员")
        with self.assertRaises(PermissionError):
            await app._route("POST", "/api/admin/v1/maintenance/thumbnails", {}, {"candidate_count": 5}, "user", "csrf")
        sessions.require.assert_called_once_with("user", role="admin", csrf="csrf", mutation=True)
        sessions.require.side_effect = None
        result = await app._route("POST", "/api/admin/v1/maintenance/thumbnails", {}, {"candidate_count": 5}, "admin", "csrf")
        self.assertEqual(result[1], {"candidate_count": 5})

    async def test_real_decoder_skips_gray_intro_and_produces_three_or_nine_frames(self):
        executable = ffmpeg_executable()
        if not executable:
            self.skipTest("没有可用 FFmpeg")
        self.worker.resources.ffmpeg = executable
        data, fetched = b"", set()
        async def stream(blob, start, end, *, read_budget=None, **kwargs):
            if read_budget and blob not in fetched:
                read_budget(blob, len(data)); fetched.add(blob)
            for offset in range(start, end, 64 * 1024):
                yield data[offset:min(end, offset + 64 * 1024)]
        self.objects.engine.stream = stream
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "clip.mkv"
            async def encode(body):
                intro = "color=c=gray:s=320x180:r=10:d=2,drawgrid=w=35:h=20:t=3:c=white"
                graph = f"{intro}[a];testsrc2=s=320x180:r=10:d=8[b];[a][b]concat=n=2:v=1:a=0[out]" if body else intro + "[out]"
                process = await asyncio.create_subprocess_exec(executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                    "-filter_complex", graph, "-map", "[out]", "-c:v", "ffv1", str(target),
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                _, error = await asyncio.wait_for(process.communicate(), 20)
                self.assertEqual(process.returncode, 0, error.decode(errors="replace"))
                return target.read_bytes()
            data = await encode(True)
            self.info = self.objects.head_object.return_value = replace(self.info, size=len(data))
            for count in (3, 9):
                self.worker._setting.return_value = {"count": count}
                value = self.request()
                await self.worker._generate_candidates(self.worker._pending[self.info.blob_uuid])
                frames = self.worker.candidates_status(self.scope, self.info.key, self.info.etag, "session", value["id"])["frames"]
                self.assertEqual(len(frames), count)
                self.assertTrue(all(frame["seconds"] >= 2 for frame in frames))
                self.worker.cancel_candidates(self.scope, self.info.key, self.info.etag, "session", value["id"])
            data = await encode(False)
            fetched.clear()
            self.info = self.objects.head_object.return_value = replace(self.info, size=len(data))
            self.request()
            with self.assertRaisesRegex(ThumbnailError, "原缩略图已保留"):
                await self.worker._generate_candidates(self.worker._pending[self.info.blob_uuid])
            self.objects.set_thumbnail.assert_not_awaited()

    async def test_large_mp4_tail_index_and_repeated_probes_keep_all_candidates(self):
        executable = ffmpeg_executable()
        if not executable:
            self.skipTest("没有可用 FFmpeg")
        self.worker.resources.ffmpeg = executable
        with tempfile.TemporaryDirectory() as directory:
            original, target = Path(directory) / "clip.mp4", Path(directory) / "large.mp4"
            graph = ("color=c=gray:s=640x360:r=12:d=10,drawgrid=w=70:h=40:t=4:c=white[a];"
                     "nullsrc=s=640x360:r=12:d=20,geq=lum='mod(X*2+Y+N*10,220)+16':cb=128:cr=128[b];"
                     "[a][b]concat=n=2:v=1:a=0[out]")
            process = await asyncio.create_subprocess_exec(executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-filter_complex", graph, "-map", "[out]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", str(original),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            _, error = await asyncio.wait_for(process.communicate(), 20)
            self.assertEqual(process.returncode, 0, error.decode(errors="replace"))
            # 在媒体数据与尾部索引之间插入稀疏 free atom，保留合法的媒体偏移，不分配整份大文件内存。
            with original.open("rb") as source:
                while header := source.read(8):
                    size, kind = struct.unpack(">I4s", header)
                    self.assertGreaterEqual(size, 8)
                    if kind == b"moov":
                        moov = source.tell() - 8
                        break
                    source.seek(size - 8, 1)
                else:
                    self.fail("测试 MP4 缺少尾部索引")
                source.seek(0)
                with target.open("wb") as output:
                    output.write(source.read(moov))
                    output.write(struct.pack(">I4s", 128 * MIB, b"free"))
                    output.seek(128 * MIB - 8, 1)
                    shutil.copyfileobj(source, output)
            length, fetched = target.stat().st_size, set()
            self.assertGreater(length, 64 * MIB)
            self.info = self.objects.head_object.return_value = replace(self.info, size=length)
            async def stream(blob, start, end, *, read_budget=None, **kwargs):
                with target.open("rb") as source:
                    source.seek(start)
                    for part in range(start // (16 * MIB), (end - 1) // (16 * MIB) + 1):
                        if read_budget and part not in fetched:
                            read_budget(str(part), min(16 * MIB, length - part * 16 * MIB))
                            fetched.add(part)
                    while start < end:
                        piece = source.read(min(64 * 1024, end - start))
                        self.assertTrue(piece)
                        start += len(piece)
                        await asyncio.sleep(0)
                        yield piece
            self.objects.engine.stream = stream
            for count in (3, 9):
                fetched.clear()
                self.worker._setting.return_value = {"count": count}
                value = self.request()
                await self.worker._generate_candidates(self.worker._pending[self.info.blob_uuid])
                frames = self.worker.candidates_status(self.scope, self.info.key, self.info.etag, "session", value["id"])["frames"]
                self.assertEqual(len(frames), count)
                self.assertTrue(all(frame["seconds"] >= 10 for frame in frames))
                self.worker.cancel_candidates(self.scope, self.info.key, self.info.etag, "session", value["id"])
            self.objects.set_thumbnail.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
