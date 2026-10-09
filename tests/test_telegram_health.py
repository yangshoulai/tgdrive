"""M15：Telegram 读写路径缓存、file_path LRU、失败退避与 Bot 健康检查。"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.test_telegram_store import FakeTransport
from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.keystore import KeyStore
from tgdrive.metadata import Metadata
from tgdrive.objects import ObjectService, Scope
from tgdrive.telegram import config as config_module
from tgdrive.telegram.client import HttpResponse, TelegramClient
from tgdrive.telegram.config import ConfiguredBlobStore, TelegramBotConfigStore
from tgdrive.telegram.pool import BotPool, PoolBot
from tgdrive.telegram.store import TelegramBlobStore, TelegramRef

TOKEN_A = "1000001:" + "a" * 30
TOKEN_B = "1000002:" + "b" * 30


class FlakyTransport(FakeTransport):
    """sendDocument 返回 5xx，用于验证换 Bot 重试与冷却。"""

    async def request(self, method, url, headers, body):
        if url.endswith("/sendDocument"):
            return HttpResponse(502, {}, json.dumps({"ok": False, "error_code": 502, "description": "bad gateway"}).encode())
        return await super().request(method, url, headers, body)


class TelegramPathTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.metadata = Metadata(root / "meta.db")
        self.keys = KeyStore(self.metadata)
        self.keys.initialize("pass")
        self.config = TelegramBotConfigStore(self.metadata, self.keys)
        self.transport = FakeTransport()
        self.built = 0

        def client_factory(token, **kwargs):
            self.built += 1
            return TelegramClient(token, transport=self.transport)
        patcher = mock.patch.object(config_module, "TelegramClient", side_effect=client_factory)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.store = ConfiguredBlobStore(self.metadata, self.keys, LocalDiskBlobStore(root / "blobs"), self.config)

    async def asyncTearDown(self):
        self.metadata.close()
        self.temp.cleanup()

    async def test_reads_reuse_one_store_and_file_path_cache(self):
        bot = self.config.create("main", TOKEN_A, "-1001234567")
        ref = await self.store.put("k", b"hello world")
        for _ in range(5):
            self.assertEqual(await self.store.get(ref, 0, 5), b"hello")
        self.assertEqual(self.built, 1, "token must be decrypted and client built once")
        self.assertEqual(self.transport.get_file_count, 1, "file_path cache must survive across reads")
        # 停用的 Bot 不再上传，但旧数据仍可读取；配置变化时只重建一次。
        self.config.set_status(int(bot["id"]), "disabled")
        self.assertEqual(await self.store.get(ref), b"hello world")
        local_ref = await self.store.put("k2", b"local")
        self.assertIsNone(ConfiguredBlobStore._telegram_bot_id(local_ref))
        self.assertEqual(self.built, 2)
        # 锁定后丢弃内存中的客户端（含 token）。
        self.keys.lock()
        self.assertIsNone(self.store._build())
        self.assertIsNone(self.store._telegram)

    async def test_file_path_cache_is_bounded(self):
        pool = BotPool([PoolBot("1", TelegramClient("1:x", transport=self.transport), -1001)], min_interval=0)
        store = TelegramBlobStore(pool, max_cached_paths=3)
        refs = [await store.put(f"k{index}", f"data{index}".encode()) for index in range(6)]
        for ref in refs:
            await store.get(ref)
        self.assertEqual(len(store._file_cache), 3)
        self.assertEqual([key[1] for key in store._file_cache], [TelegramRef.decode(ref).file_id for ref in refs[-3:]])

    async def test_channel_usage_counts_encrypted_chunks_without_duplicate_copies(self):
        first = self.config.create("first", TOKEN_A, "-1001234567")
        engine = BlobEngine(self.metadata, self.store, keystore=self.keys, chunk_size=8, frame_size=4)
        objects = ObjectService(self.metadata, engine)
        scope = Scope(objects.create_bucket("usage-test"))
        item = await objects.put_object(scope, "a.bin", b"0123456789")
        chunks = self.metadata.list_chunks(item.blob_uuid)
        expected = {"chunk_count": 2, "stored_bytes": sum(chunk.cipher_size for chunk in chunks)}
        self.assertEqual(self.config.storage_usage(), {str(first["id"]): expected})
        self.assertGreater(expected["stored_bytes"], item.size)
        await objects.copy_object(scope, "a.bin", scope, "copy.bin")
        self.assertEqual(self.config.storage_usage()[str(first["id"])], expected)
        self.config.set_status(int(first["id"]), "disabled")
        second = self.config.create("second", TOKEN_B, "-1007654321")
        second_item = await objects.put_object(scope, "b.bin", b"new")
        second_size = sum(chunk.cipher_size for chunk in self.metadata.list_chunks(second_item.blob_uuid))
        self.assertEqual(self.config.storage_usage()[str(second["id"])], {"chunk_count": 1, "stored_bytes": second_size})
        self.assertEqual(self.config.storage_usage()[str(first["id"])], expected)
        self.config.set_status(int(second["id"]), "disabled")
        await objects.put_object(scope, "local.bin", b"local")
        self.assertEqual(sum(value["chunk_count"] for value in self.config.storage_usage().values()), 3)
        await objects.trash(scope, ["a.bin"])
        self.assertEqual(self.config.storage_usage()[str(first["id"])], expected)
        await objects.delete_objects(scope, ["copy.bin"])
        self.assertEqual(self.config.storage_usage()[str(first["id"])], expected)

    async def test_failed_bot_is_retried_on_another_and_cooled_down(self):
        flaky = PoolBot("bad", TelegramClient("1:x", transport=FlakyTransport()), -1001)
        good = PoolBot("good", TelegramClient("2:y", transport=self.transport), -1002)
        pool = BotPool([flaky, good], min_interval=0)
        store = TelegramBlobStore(pool)
        for index in range(6):
            ref = await store.put(f"k{index}", b"x")
            self.assertEqual(TelegramRef.decode(ref).bot, "good")
        self.assertGreaterEqual(flaky.failures, BotPool.FAILURE_THRESHOLD)
        self.assertGreater(flaky.cooldown_until, 0)
        self.assertEqual(good.failures, 0)

    async def test_all_bots_cooling_waits_until_available(self):
        bot = PoolBot("cooling", TelegramClient(TOKEN_A, transport=self.transport), "-1001", cooldown_until=130)
        pool = BotPool([bot], min_interval=1)
        with mock.patch("tgdrive.telegram.pool.time.monotonic", return_value=100), mock.patch("tgdrive.telegram.pool.asyncio.sleep", new_callable=mock.AsyncMock) as sleep:
            self.assertIs(await pool.acquire_for_upload(), bot)
            sleep.assert_awaited_once_with(30)

    async def test_download_retries_transient_failure(self):
        client = TelegramClient(TOKEN_A, transport=self.transport)
        store = TelegramBlobStore(BotPool([PoolBot("main", client, "-1001")], min_interval=0))
        ref = await store.put("file", b"keep range")
        download = client.download_file
        calls = 0
        async def flaky(*args):
            nonlocal calls
            calls += 1
            if calls < 3:
                return HttpResponse(502, {}, b"")
            return await download(*args)
        with mock.patch.object(client, "download_file", side_effect=flaky), mock.patch("tgdrive.telegram.store.asyncio.sleep", new_callable=mock.AsyncMock) as sleep:
            self.assertEqual(await store.get(ref, 0, 4), b"keep")
            self.assertEqual(calls, 3)
            self.assertEqual(sleep.await_count, 2)

    async def test_health_check_records_status(self):
        bot = self.config.create("main", TOKEN_A, "-1001234567")

        def responder(member):
            async def request(method, url, headers, body):
                if url.endswith("/getMe"):
                    return FakeTransport._json({"ok": True, "result": {"id": 42}})
                if url.endswith("/getChatMember"):
                    return FakeTransport._json({"ok": True, "result": member})
                if url.endswith("/getChat"):
                    return FakeTransport._json({"ok": True, "result": {"id": -1001234567}})
                raise AssertionError(url)
            return mock.Mock(request=request)

        cases = [({"status": "administrator", "can_post_messages": True}, True, "ok"),
                 ({"status": "member"}, False, "管理员"),
                 ({"status": "administrator", "can_post_messages": False}, False, "发布消息")]
        for member, ok, text in cases:
            result = await self.config.check(int(bot["id"]), TelegramClient(TOKEN_A, transport=responder(member)))
            self.assertEqual(result["ok"], ok)
            self.assertIn(text, result["status"])
            row = self.config.list()[0]
            self.assertEqual(row["last_check_status"], result["status"])
            self.assertIsNotNone(row["last_check_at"])

        async def unauthorized(method, url, headers, body):
            return HttpResponse(401, {}, json.dumps({"ok": False, "error_code": 401, "description": "Unauthorized"}).encode())
        result = await self.config.check(int(bot["id"]), TelegramClient(TOKEN_A, transport=mock.Mock(request=unauthorized)))
        self.assertIn("token", result["status"])


if __name__ == "__main__":
    unittest.main()
