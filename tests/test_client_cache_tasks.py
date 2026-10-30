"""私密缓存任务的定向回归；账号、文件与元数据均为内存替身，不建立数据库。"""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import urlencode

from tgdrive.api import UserApi
from tgdrive.asgi import TgDriveASGI
from tgdrive.authn import AuthenticationError
from tgdrive.client_cache import ClientCache
from tgdrive.errors import NotReadyError
from tgdrive.objects import PRIVATE_PREFIX
from tgdrive.private import PrivateLocked

DEVICE = "device-aaaaaaaaaaaaaaaaaaaa"
ROOT = PRIVATE_PREFIX + "selected/"
FILE = ROOT + "file.bin"


class CacheTaskTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.state = {"unlocked": True, "active": True, "epoch": 0, "password": "password-hash"}
        self.sessions = {"session": SimpleNamespace(user_id=1), "other-session": SimpleNamespace(user_id=1),
                         "other-account": SimpleNamespace(user_id=2)}

        def require(token, *, csrf=None, mutation=False, **kwargs):
            if token not in self.sessions:
                raise AuthenticationError("session expired")
            if mutation and csrf != "csrf":
                raise PermissionError("csrf")
            return self.sessions[token]

        def account(session):
            if not self.state["active"]:
                raise AuthenticationError("account disabled")
            return SimpleNamespace(id=session.user_id, bucket_id=7 if session.user_id == 1 else 8)

        def read(sql, *args):
            if not sql.startswith("SELECT password_hash, cache_epoch"):
                raise AssertionError("测试不得连接或修改数据库")
            return SimpleNamespace(fetchone=lambda: {"password_hash": self.state["password"], "cache_epoch": self.state["epoch"]})

        accounts = SimpleNamespace(metadata=SimpleNamespace(db=SimpleNamespace(execute=read)),
                                   keystore=SimpleNamespace(unlocked=True), sessions=SimpleNamespace(require=require, peek=lambda token: self.sessions.get(token)),
                                   account_for_session=account)
        self.objects = SimpleNamespace()
        self.user = UserApi(accounts, self.objects)

        def private(token, access):
            if not self.state["unlocked"] or access != "unlock":
                raise PrivateLocked("locked")
            return SimpleNamespace(user_id=require(token).user_id)

        self.space = SimpleNamespace(require=Mock(side_effect=private))
        self.cache = ClientCache(self.user, self.space)
        self.cache._master = lambda: b"m" * 32
        self.objects.head_object = lambda scope, path: SimpleNamespace(key=path, etag="version")

    def create(self, paths=None):
        self.cache.start_task("session", "csrf", "unlock", DEVICE, "queue-id", paths or [ROOT])
        return "queue-id"

    async def test_creation_requires_unlock_csrf_and_private_scope(self):
        with self.assertRaises(PermissionError):
            self.cache.start_task("session", "wrong", "unlock", DEVICE, "queue-id", [ROOT])
        self.state["unlocked"] = False
        with self.assertRaises(PrivateLocked):
            self.create()
        self.state["unlocked"] = True
        for path in ("normal/file.bin", ".tgdrive/private-trash/file.bin", ROOT + "../other/file.bin"):
            with self.subTest(path=path), self.assertRaises((PermissionError, ValueError)):
                self.create([path])

    async def test_lock_preserves_task_but_regular_private_keys_still_require_unlock(self):
        task_id = self.create()
        self.state["unlocked"] = False
        self.assertEqual(self.cache._task("session", task_id).bucket_id, 7)
        self.assertIn("key", self.cache.task_key("session", task_id, FILE, "version"))
        with self.assertRaises(PrivateLocked):
            self.cache.private_keys("session", "unlock", DEVICE, ["version"])

    async def test_scope_checks_exact_files_and_folder_boundaries(self):
        task_id = self.create([ROOT, PRIVATE_PREFIX + "exact.bin"])
        files = self.cache.task_files("session", task_id)
        self.assertEqual(files._path(FILE), FILE)
        self.assertEqual(files._path(ROOT + "nested/file.bin"), ROOT + "nested/file.bin")
        self.assertEqual(files._path(PRIVATE_PREFIX + "exact.bin"), PRIVATE_PREFIX + "exact.bin")
        for path in (PRIVATE_PREFIX + "selected-other/file.bin", PRIVATE_PREFIX + "other/file.bin",
                     PRIVATE_PREFIX + "exact.bin/child", FILE + "/../outside"):
            with self.subTest(path=path), self.assertRaises((PermissionError, ValueError)):
                files._path(path)
        self.assertEqual(files._scope("session").perms, "ro")
        with self.assertRaises(PermissionError):
            files._scope("session", mutation=True)
        with self.assertRaises(ValueError):
            self.cache.task_key("session", task_id, FILE, "replacement")

    async def test_other_sessions_accounts_logout_and_system_lock_revoke_access(self):
        task_id = self.create()
        for token in ("other-session", "other-account"):
            with self.subTest(token=token), self.assertRaises(PermissionError):
                self.cache._task(token, task_id)
        self.state["active"] = False
        with self.assertRaises(AuthenticationError):
            self.cache._task("session", task_id)
        self.state["active"] = True
        self.user.accounts.keystore.unlocked = False
        with self.assertRaises(NotReadyError):
            self.cache.task_files("session", task_id)._scope("session")
        self.user.accounts.keystore.unlocked = True
        self.sessions.pop("session")
        with self.assertRaises(AuthenticationError):
            self.cache._task("session", task_id)

    async def test_password_and_cache_epoch_are_checked_each_time(self):
        task_id = self.create()
        self.state["epoch"] += 1
        with self.assertRaises(PermissionError):
            self.cache._task("session", task_id)
        self.state["epoch"] -= 1
        self.state["password"] = "changed"
        with self.assertRaises(PermissionError):
            self.cache._task("session", task_id)

    async def test_tasks_reuse_queue_ids_without_extra_credentials_or_expiry(self):
        body = self.cache.start_task("session", "csrf", "unlock", DEVICE, "existing-id", [ROOT])
        self.assertEqual(set(body), {"namespace", "bucket_id", "key"})
        self.state["unlocked"] = False
        self.space.require.reset_mock()
        self.assertEqual(self.cache._task("session", "existing-id").paths, (ROOT,))
        self.space.require.assert_not_called()
        self.sessions.pop("session")
        self.state["unlocked"] = True
        self.cache.start_task("other-session", "csrf", "unlock", DEVICE, "another-id", [ROOT])
        self.assertEqual(set(self.cache._tasks), {("other-session", "another-id")})

    async def test_stream_survives_private_lock_but_rechecks_account_per_chunk(self):
        task_id = self.create()
        async def source(scope, path, start, end):
            scope.authorize()
            async def chunks():
                yield b"first"
                yield b"second"
                yield b"third"
            return SimpleNamespace(key=path, etag="version"), chunks()
        self.objects.get_object = source
        _, stream = await self.cache.task_files("session", task_id).content("session", FILE)
        self.assertEqual(await anext(stream), b"first")
        self.state["unlocked"] = False
        self.assertEqual(await anext(stream), b"second")
        self.state["active"] = False
        with self.assertRaises(AuthenticationError):
            await anext(stream)

    async def test_content_route_preserves_range_no_store_and_disconnect_cancellation(self):
        task_id = self.create()
        self.state["unlocked"] = False
        app = object.__new__(TgDriveASGI)
        app.user, app.client_cache = self.user, self.cache
        app.settings = SimpleNamespace(s3_hostname=lambda: None)
        app.s3 = app.s3_host = app.static_dir = app.metrics = None
        first, closed = asyncio.Event(), asyncio.Event()
        info = SimpleNamespace(bucket_id=7, key=FILE, etag="version", size=10, content_type="application/octet-stream")

        async def source(scope, path, start, end):
            scope.authorize()
            async def chunks():
                try:
                    yield b"0123456789"[start:end]
                    await asyncio.Event().wait()
                finally:
                    closed.set()
            return info, chunks()
        self.objects.get_object = source
        incoming, messages = asyncio.Queue(), []
        await incoming.put({"type": "http.request", "body": b""})
        async def send(message):
            messages.append(message)
            if message["type"] == "http.response.body":
                first.set()
        scope = {"type": "http", "method": "GET", "path": "/api/user/v1/cache/tasks/content",
                 "query_string": urlencode({"path": FILE, "bucket_id": 7, "v": "version"}).encode(),
                 "headers": [(b"cookie", b"tg_session=session"), (b"x-tessera-cache-task", task_id.encode()), (b"range", b"bytes=2-5")]}
        request = asyncio.create_task(app(scope, incoming.get, send))
        try:
            await asyncio.wait_for(first.wait(), 1)
            headers = dict(messages[0]["headers"])
            self.assertEqual(messages[0]["status"], 206)
            self.assertEqual(headers[b"content-range"], b"bytes 2-5/10")
            self.assertEqual(headers[b"cache-control"], b"no-store")
            self.assertEqual(headers[b"referrer-policy"], b"no-referrer")
            self.assertEqual(messages[1]["body"], b"2345")
            await incoming.put({"type": "http.disconnect"})
            await asyncio.wait_for(request, 1)
            self.assertTrue(closed.is_set(), "浏览器取消缓存时必须停止服务端源流")
        finally:
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)

    async def test_post_routes_forward_private_access_and_task_header(self):
        app = object.__new__(TgDriveASGI)
        app.user, app.client_cache = self.user, self.cache
        status, body, headers = await app._route("POST", "/api/user/v1/cache/tasks", {},
            {"id": "queue-id", "device": DEVICE, "paths": [ROOT]}, "session", "csrf", access="unlock")
        self.assertEqual((status, headers["Cache-Control"]), (201, "no-store"))
        self.state["unlocked"] = False
        result = await app._route("POST", "/api/user/v1/cache/tasks/keys", {}, {"path": FILE, "etag": "version"},
                                  "session", "", cache_task="queue-id")
        self.assertEqual(result[0], 200)
        await app._route("POST", "/api/user/v1/cache/tasks/release", {}, {}, "session", "", cache_task="queue-id")
        with self.assertRaises(PermissionError):
            self.cache._task("session", "queue-id")
