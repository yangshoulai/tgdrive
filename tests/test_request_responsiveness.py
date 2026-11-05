"""传输线程忙碌时，切换页面的元数据请求仍能返回；不连接 Telegram 或外部来源。"""

import asyncio
import concurrent.futures
import contextvars
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.blobengine import encrypt_chunk
from tgdrive.objects import Scope


class RequestResponsivenessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.client = Client(self.app)
        self.engine = self.app.objects.engine

    async def asyncSetUp(self):
        # 缩小线程池，确定性模拟传输工作排满全部默认线程的情况。
        asyncio.get_running_loop().set_default_executor(concurrent.futures.ThreadPoolExecutor(max_workers=2))
        self.auth = await self.client.login("user", "admin@example.com", "admin password")
        session = self.app.accounts.sessions.require(self.auth["cookie"].split("=", 1)[1])
        account = self.app.accounts.account_for_session(session)
        self.scope = Scope(account.bucket_id)
        self.file = await self.app.objects.put_object(self.scope, "docs/example.txt", b"example")

    def tearDown(self):
        self.app.thumbnails.cache.close()
        self.app.metadata.close()
        self.temp.cleanup()

    async def assert_pages_respond(self):
        # 同时验证目录与管理页面：两者均有真正的异步数据库查询。
        directory, users = await asyncio.wait_for(asyncio.gather(
            self.client.request("GET", "/api/user/v1/list?prefix=docs/", headers=self.auth),
            self.client.request("GET", "/api/admin/v1/users", headers=self.auth),
        ), timeout=1)
        self.assertEqual(directory[0], 200)
        self.assertEqual([item["key"] for item in json.loads(directory[2])["objects"]], ["docs/example.txt"])
        self.assertEqual(users[0], 200)

    async def wait_for_threads(self, events):
        async with asyncio.timeout(2):
            while not all(event.is_set() for event in events):
                await asyncio.sleep(0.001)

    async def test_pages_respond_while_offline_parts_are_encrypting(self):
        # 与离线下载相同的 buffered 分段写入；两路加密占满测试中的默认线程池。
        release = threading.Event()
        started = [threading.Event(), threading.Event()]
        blobs = [self.engine.begin_blob(), self.engine.begin_blob()]

        def encrypt(key, plain):
            started[plain[0]].set()
            if not release.wait(5):
                raise TimeoutError("测试没有释放加密线程")
            return encrypt_chunk(key, plain)

        with patch("tgdrive.blobengine.encrypt_chunk", side_effect=encrypt):
            writes = [asyncio.create_task(self.engine.put_part(blob, 1, bytes([index]), buffered=True))
                      for index, blob in enumerate(blobs)]
            try:
                await self.wait_for_threads(started)
                self.assertEqual(self.engine.transfers._active, 0, "离线分段未占用读取名额")
                await self.assert_pages_respond()
            finally:
                release.set()
                await asyncio.gather(*writes)

    async def test_pages_respond_while_background_cache_is_reading_disk(self):
        # 本机缓存读取已加密的数据时，慢磁盘占满默认线程池；读取名额仍有余量。
        self.engine.transfers.set_limits(4, 4)
        self.engine.thumbnail_cache = self.app.thumbnails.cache
        release = threading.Event()
        started = [threading.Event(), threading.Event()]
        count = 0
        original = self.app.thumbnails.cache.get

        def read(*args):
            nonlocal count
            index = count
            count += 1
            if index < len(started):
                started[index].set()
                if not release.wait(5):
                    raise TimeoutError("测试没有释放缓存读取线程")
            return original(*args)

        async def cache():
            return b"".join([piece async for piece in self.engine.stream(
                self.file.blob_uuid, bucket_id=self.scope.bucket_id, background=True)])

        with patch.object(self.app.thumbnails.cache, "get", side_effect=read):
            reads = [asyncio.create_task(cache()), asyncio.create_task(cache())]
            try:
                await self.wait_for_threads(started)
                self.assertLess(self.engine.transfers._active, self.engine.transfers.total)
                await self.assert_pages_respond()
            finally:
                release.set()
                self.assertEqual(await asyncio.gather(*reads), [b"example", b"example"])

    async def test_database_worker_keeps_context_and_separate_connection(self):
        marker = contextvars.ContextVar("request_marker")
        token = marker.set("navigation")
        main_connection = self.app.metadata.db

        def read():
            connection = self.app.metadata.db
            return marker.get(), connection is not main_connection, connection.execute("SELECT 42").fetchone()[0]

        try:
            self.assertEqual(await self.app.metadata.run_in_thread(read), ("navigation", True, 42))
        finally:
            marker.reset(token)
        self.assertIs(self.app.metadata.db, main_connection)


if __name__ == "__main__":
    unittest.main()
