"""私密空间安全边界回归；仅使用替身，不创建数据库、不执行 SQL。"""

import asyncio
import unittest
import logging
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from tgdrive.api import UserApi, normalize_user_path
from tgdrive.accounts import AccountService
from tgdrive.asgi import TgDriveASGI
from tgdrive.authn import CsrfError, SessionExpired, SessionManager, TooManyAttempts, hash_password
from tgdrive.objects import PRIVATE_PREFIX, PRIVATE_TRASH_PREFIX, ObjectService, Scope
from tgdrive.private import PrivateAccessLogFilter, PrivateFiles, PrivateLocked, PrivateSpace


class PasswordWork:
    async def run(self, function, *args):
        return function(*args)


class PrivateSpaceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.sessions = SessionManager()
        self.session = self.sessions.create(7, "测试用户", "user")
        self.account = SimpleNamespace(id=7, bucket_id=9)
        self.metadata = Mock()
        self.metadata.transaction.side_effect = lambda: nullcontext(self.metadata.db)
        async def run(function, *args, **kwargs):
            return function(*args, **kwargs)
        self.metadata.run_in_thread.side_effect = run
        self.user_row = {"id": 7, "username": "测试用户", "status": "active", "role": "user",
                         "bucket_id": 9, "password_hash": hash_password("login-password")}
        self.metadata.db.execute.return_value.fetchone.return_value = self.user_row
        accounts = AccountService(self.metadata, SimpleNamespace(unlocked=True), sessions=self.sessions)
        accounts.password_work = PasswordWork()
        accounts.account_for_session = lambda session: self.account
        self.objects = Mock()
        self.user = UserApi(accounts, self.objects)
        self.space = PrivateSpace(self.user)
        self.space._user_row = Mock(side_effect=lambda user_id: self.user_row if user_id == 7 else None)
        self.space._config = Mock(return_value=None)
        self.space.ensure_config = Mock(return_value={"idle_seconds": 1800})
        self.user.private_space = self.space

    def issue(self, idle=60):
        return self.space._issue(self.session.token, self.account.id, idle)["access"]

    async def test_native_access_token_is_removed_from_access_logs(self):
        record = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s %s %s %s %s',
            ("127.0.0.1", "GET", "/api/user/v1/private/content?path=video.mp4&access=fixture-secret&download=1", "1.1", 200), None)
        PrivateAccessLogFilter().filter(record)
        self.assertNotIn("fixture-secret", record.getMessage())
        self.assertIn("path=video.mp4", record.getMessage())
        self.assertIn("download=1", record.getMessage())

    async def test_idle_reads_do_not_extend_but_activity_and_playback_do(self):
        with patch("tgdrive.private.time.monotonic", return_value=100):
            access = self.issue()
        with patch("tgdrive.private.time.monotonic", return_value=150):
            self.assertEqual(self.space.activity(self.session.token, self.session.csrf_token, access)["remaining_seconds"], 10)
            self.space.files(self.session.token, access)
        with patch("tgdrive.private.time.monotonic", return_value=159):
            self.space.activity(self.session.token, self.session.csrf_token, access, playing=True)
        with patch("tgdrive.private.time.monotonic", return_value=210):
            self.space.activity(self.session.token, self.session.csrf_token, access, active=True)
        with patch("tgdrive.private.time.monotonic", return_value=271):
            with self.assertRaises(PrivateLocked):
                self.space.require(self.session.token, access)
        self.sessions.require(self.session.token)

    async def test_grants_are_bound_to_login_and_lock_is_independent(self):
        access = self.issue()
        other = self.sessions.create(7, "测试用户", "user")
        with self.assertRaises(PrivateLocked):
            self.space.require(other.token, access)
        self.space.lock(other.token, other.csrf_token, access)
        self.space.require(self.session.token, access)
        with self.assertRaises(CsrfError):
            self.space.lock(self.session.token, "bad-csrf", access)
        self.space.lock(self.session.token, self.session.csrf_token, access)
        with self.assertRaises(PrivateLocked):
            self.space.require(self.session.token, access)
        self.sessions.require(self.session.token)
        renewed = self.issue()
        self.space.lock(self.session.token, self.session.csrf_token, access)
        with self.assertRaises(PrivateLocked):
            self.space.require(self.session.token, renewed)
        access = self.issue()
        self.user.logout(self.session.token)
        self.assertNotIn(access, self.space.grants)
        with self.assertRaises(SessionExpired):
            self.space.require(self.session.token, access)

    async def test_status_restores_only_current_session_without_extending_idle(self):
        self.space.passkeys.capability = Mock(return_value={})
        with patch("tgdrive.private.time.monotonic", return_value=100):
            access = self.issue(1800)
        with patch("tgdrive.private.time.monotonic", return_value=120):
            status = self.space.status(self.session.token)
            self.assertEqual(status["access"], access)
            self.assertEqual(status["remaining_seconds"], 1780)
            self.assertEqual(self.space.grants[access].expires_at, 1900)
            other = self.sessions.create(7, "测试用户", "user")
            self.assertFalse(self.space.status(other.token)["unlocked"])
        with patch("tgdrive.private.time.monotonic", return_value=1901):
            self.assertFalse(self.space.status(self.session.token)["unlocked"])
        self.assertNotIn(self.session.token, self.space.session_grants)

    async def test_manual_lock_cancels_password_validation_in_progress(self):
        started, resume = asyncio.Event(), asyncio.Event()
        async def confirm(*args):
            started.set()
            await resume.wait()
            return self.account, self.user_row
        self.space.check_password = AsyncMock(side_effect=confirm)
        pending = asyncio.create_task(self.space.unlock(self.session.token, self.session.csrf_token, "login-password"))
        await started.wait()
        self.space.lock(self.session.token, self.session.csrf_token, "")
        resume.set()
        with self.assertRaises(PrivateLocked):
            await pending
        self.assertFalse(self.space.grants)

    async def test_wrong_password_is_rate_limited_without_logging_user_out(self):
        for _ in range(5):
            with self.assertRaisesRegex(ValueError, "登录密码不正确"):
                await self.space.unlock(self.session.token, self.session.csrf_token, "wrong-password", "127.0.0.1")
        with self.assertRaises(TooManyAttempts):
            await self.space.unlock(self.session.token, self.session.csrf_token, "login-password", "127.0.0.1")
        self.assertFalse(self.space.grants)
        self.sessions.require(self.session.token)

    async def test_account_password_change_revokes_all_previous_windows(self):
        first = self.issue()
        other = self.sessions.create(7, "测试用户", "user")
        second = self.space._issue(other.token, self.account.id, 60)["access"]
        self.user_row["password_hash"] = hash_password("changed-password")
        for token, access in ((self.session.token, first), (other.token, second)):
            with self.assertRaises(PrivateLocked):
                self.space.require(token, access)
        with self.assertRaisesRegex(ValueError, "登录密码不正确"):
            await self.space.unlock(self.session.token, self.session.csrf_token, "login-password")
        updated = await self.space.unlock(self.session.token, self.session.csrf_token, "changed-password")
        self.assertEqual(updated["idle_seconds"], 1800)
        renewed = await self.space.configure(self.session.token, self.session.csrf_token, updated["access"], idle=900)
        with self.assertRaises(PrivateLocked):
            self.space.require(self.session.token, updated["access"])
        self.assertEqual(self.space.require(self.session.token, renewed["access"]).idle_seconds, 900)
        self.assertEqual(self.metadata.db.execute.call_args.args[1][:2], (7, 900))
        self.assertNotIn("changed-password", self.metadata.db.execute.call_args.args[1])

    async def test_locked_settings_validate_idle_without_unlocking_files(self):
        for idle in (0, 120, True, None):
            with self.assertRaises(ValueError):
                await self.space.configure(self.session.token, self.session.csrf_token, "", idle=idle)
        self.metadata.db.execute.assert_not_called()
        saved = await self.space.configure(self.session.token, self.session.csrf_token, "", idle=900)
        self.assertIsNone(saved["access"])
        self.assertEqual(saved["idle_seconds"], 900)
        self.assertEqual(self.metadata.db.execute.call_args.args[1][:2], (7, 900))
        self.assertFalse(self.space.grants)
        with self.assertRaises(PrivateLocked):
            self.space.require(self.session.token, "")

    async def test_transfer_normalizes_paths_and_moves_outermost_folder(self):
        access = self.issue()
        self.objects.move.return_value = SimpleNamespace(moved=2, skipped=0)
        result = await self.space.transfer(self.session.token, self.session.csrf_token, access,
            ["照片/", "照片/夏天.png"], PRIVATE_PREFIX, True)
        self.assertEqual(result["moved"], 2)
        args, kwargs = self.objects.move.call_args
        self.assertEqual(args[1:3], ("照片/", PRIVATE_PREFIX + "照片/"))
        self.assertTrue(args[0].private_access)
        self.assertTrue(kwargs["revoke_public"])
        for destination in (".tgdrive/trash/", PRIVATE_PREFIX + "../", "普通目录/"):
            with self.assertRaises((ValueError, PermissionError)):
                await self.space.transfer(self.session.token, self.session.csrf_token, access,
                                          ["照片/"], destination, True)
        self.objects.move.reset_mock()
        await self.space.transfer(self.session.token, self.session.csrf_token, access,
                                  [PRIVATE_PREFIX + "音乐.wav"], "", False)
        self.assertEqual(self.objects.move.call_args.args[1:3], (PRIVATE_PREFIX + "音乐.wav", "音乐.wav"))
        self.assertTrue(self.objects.move.call_args.kwargs["revoke_public"])

    async def test_content_stream_stops_after_manual_lock(self):
        access = self.issue()
        closed = []
        async def content():
            try:
                yield b"first"
                yield b"second"
            finally:
                closed.append(True)
        self.objects.get_object = AsyncMock(return_value=(SimpleNamespace(), content()))
        _, stream = await self.space.files(self.session.token, access).content(self.session.token, PRIVATE_PREFIX + "music.wav")
        self.assertEqual(await anext(stream), b"first")
        self.space.lock(self.session.token, self.session.csrf_token, access)
        with self.assertRaises(PrivateLocked):
            await anext(stream)
        self.assertEqual(closed, [True])

    async def test_ordinary_lists_skip_reserved_space_and_direct_apis_deny_it(self):
        service = ObjectService(self.metadata, Mock())
        service._bucket = Mock()
        service._object = lambda row: row
        batches = iter([[{"key": PRIVATE_PREFIX + "隐藏文件.png"}], [{"key": "普通文件.png"}], []])
        self.metadata.db.execute.side_effect = lambda *args: SimpleNamespace(fetchall=lambda: next(batches))
        page = service.list_objects(Scope(9), limit=10)
        self.assertEqual([item["key"] for item in page.objects], ["普通文件.png"])
        for prefix in (PRIVATE_PREFIX, PRIVATE_TRASH_PREFIX):
            with self.assertRaises(PermissionError):
                service.list_objects(Scope(9), prefix)
            with self.assertRaises(PermissionError):
                service.move(Scope(9), prefix, "普通文件夹/")
            with self.assertRaises(PermissionError):
                service.move(Scope(9), "普通文件夹/", prefix)
        for key in (PRIVATE_PREFIX + "秘密.png", PRIVATE_TRASH_PREFIX + "id/秘密.png", ".tgdrive/"):
            for scoped in (Scope(9), Scope(9, ".tgdrive/", "rw"), Scope(9, PRIVATE_PREFIX, "ro")):
                with self.assertRaises(PermissionError):
                    ObjectService._check_scope(scoped, key)
            with self.assertRaises(PermissionError):
                normalize_user_path(key)
        with self.assertRaises(PermissionError):
            PrivateFiles.path("普通文件.png")
        with self.assertRaises(ValueError):
            PrivateFiles.path(PRIVATE_PREFIX + "../普通文件.png")
        self.assertEqual(PrivateFiles.path(PRIVATE_PREFIX + "照片/"), PRIVATE_PREFIX + "照片/")

    async def test_expired_multipart_cannot_commit_uploaded_part(self):
        service = ObjectService(self.metadata, Mock())
        row = {"blob_uuid": "blob", "key": PRIVATE_PREFIX + "大文件.mp4"}
        service._upload = Mock(return_value=row)
        service._quota_room = Mock(return_value=None)
        self.metadata.db.execute.return_value.fetchone.return_value = [0]
        service.engine.put_part = AsyncMock(return_value=SimpleNamespace(size=4))
        scope = Scope(9, PRIVATE_PREFIX, private_access=True, authorize=Mock(side_effect=PrivateLocked("已锁定")))
        with self.assertRaises(PrivateLocked):
            await service.upload_part(scope, "upload", 1, b"data", 4)
        self.metadata.transaction.assert_not_called()

    async def test_private_http_errors_are_no_store_and_keep_ordinary_session(self):
        app = object.__new__(TgDriveASGI)
        app.user, app.private_space = self.user, self.space
        app.metrics, app.s3, app.s3_host, app.static_dir = None, None, None, None
        app.settings = SimpleNamespace(s3_hostname=lambda: None)
        app.json_limit = 1024
        sent = []
        async def receive():
            return {"type": "http.request", "body": b""}
        async def send(message):
            sent.append(message)
        scope = {"type": "http", "method": "GET", "path": "/api/user/v1/private/list",
                 "headers": [(b"cookie", f"tg_session={self.session.token}".encode()), (b"x-private-access", b"unknown")],
                 "query_string": b""}
        await app(scope, receive, send)
        self.assertEqual(sent[0]["status"], 423)
        self.assertEqual(dict(sent[0]["headers"])[b"cache-control"], b"no-store")
        self.assertEqual(dict(sent[0]["headers"])[b"referrer-policy"], b"no-referrer")
        self.sessions.require(self.session.token)


if __name__ == "__main__":
    unittest.main()
