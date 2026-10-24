"""手动候选图的关键回归；服务与权限用内存替身，不连接数据库或 Telegram。"""

import asyncio
import shutil
import tempfile
import time
import unittest
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from tgdrive.asgi import TgDriveASGI
from tgdrive.crypto import open_sealed, seal
from tgdrive.objects import ObjectInfo, ObjectService, PRIVATE_PREFIX, Scope
from tgdrive.errors import QuotaExceededError
from tgdrive.thumbnails import ThumbnailBudget, ThumbnailError, ThumbnailService, _Job
from tgdrive.video_candidates import frame_positions, frame_usable, same_frame


JPEG = b"\xff\xd8\xff\xe0test-image"


def detailed(seed=0):
    return bytes(32 + (x * 17 + y * 13 + seed * 37) % 180 for y in range(64) for x in range(64))


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
        self.assertEqual(positions, sorted(set(positions)))
        self.assertTrue(all(0 < value < .8 for value in positions))
        self.assertEqual(frame_positions(1200)[:5], [1, 2, 3, 5, 8])
        self.assertIn(960, frame_positions(1200))


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
        yield SimpleNamespace(duration=8, remote_bytes=0)

    async def prepare(self, samples):
        value = self.request()
        job = self.worker._pending[self.info.blob_uuid]
        with patch("tgdrive.thumbnails._RangeInput", self.source), patch.object(self.worker, "_render_frame", AsyncMock(side_effect=samples)):
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

    async def test_budget_can_keep_available_candidates_without_replacing_old_thumbnail(self):
        identity = await self.prepare([({"thumb": JPEG}, detailed()), ThumbnailBudget("达到读取预算")])
        self.assertEqual(self.worker._choices[identity].state, "ready")
        self.assertEqual(len(self.worker._choices[identity].frames), 1)
        self.objects.set_thumbnail.assert_not_awaited()
        self.worker.cancel_candidates(self.scope, self.info.key, self.info.etag, "session", identity)
        self.assertNotIn(identity, self.worker._choices)
        self.assertNotIn(self.info.blob_uuid, self.worker._leases)

    async def test_worker_uses_candidate_path_and_reserves_generation_lease(self):
        value = self.request()
        self.worker._repair = Mock()
        with patch("tgdrive.thumbnails._RangeInput", self.source), patch.object(self.worker, "_render_frame", AsyncMock(side_effect=[({"thumb": JPEG}, detailed(seed)) for seed in range(3)])):
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
        executable = shutil.which("ffmpeg")
        if not executable:
            try:
                import imageio_ffmpeg  # 本地验证可选，服务不依赖这个包。
                executable = imageio_ffmpeg.get_ffmpeg_exe()
            except (ImportError, RuntimeError):
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


if __name__ == "__main__":
    unittest.main()
