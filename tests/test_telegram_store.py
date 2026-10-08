import asyncio
import json
import re
import unittest
from collections.abc import Mapping

from tgdrive.telegram.client import HttpResponse, TelegramClient, TelegramRateLimitError
from tgdrive.telegram.pool import BotPool, PoolBot
from tgdrive.telegram.store import TelegramBlobStore


class FakeTransport:
    def __init__(self, *, ignore_range: bool = False):
        self.files: dict[str, bytes] = {}
        self.messages: dict[int, str] = {}
        self.next_message = 1
        self.get_file_count = 0
        self.ignore_range = ignore_range

    async def request(self, method: str, url: str, headers: Mapping[str, str], body: bytes | None) -> HttpResponse:
        if method == "POST" and url.endswith("/sendDocument"):
            match = re.search(br'filename="[^"]+".*?\r\n\r\n(.*?)\r\n--', body or b"", re.DOTALL)
            assert match
            file_id = f"file-{self.next_message}"
            message_id = self.next_message
            self.next_message += 1
            self.files[file_id] = match.group(1)
            self.messages[message_id] = file_id
            return self._json({"ok": True, "result": {"message_id": message_id,
                "document": {"file_id": file_id, "file_unique_id": f"uid-{message_id}"}}})
        if method == "POST" and url.endswith("/getFile"):
            self.get_file_count += 1
            payload = json.loads(body or b"{}")
            return self._json({"ok": True, "result": {"file_path": f"files/{payload['file_id']}"}})
        if method == "POST" and url.endswith("/deleteMessage"):
            payload = json.loads(body or b"{}")
            file_id = self.messages.pop(int(payload["message_id"]), None)
            if file_id:
                self.files.pop(file_id, None)
            return self._json({"ok": True, "result": True})
        if method == "GET" and "/file/" in url:
            file_id = url.rsplit("/", 1)[-1]
            data = self.files[file_id]
            if self.ignore_range or "Range" not in headers:
                return HttpResponse(200, {}, data)
            match = re.match(r"bytes=(\d*)-(\d*)", headers["Range"])
            assert match
            start = int(match.group(1) or 0)
            end = int(match.group(2)) if match.group(2) else len(data) - 1
            return HttpResponse(206, {"Content-Range": f"bytes {start}-{end}/{len(data)}"}, data[start:end + 1])
        return self._json({"ok": True, "result": {}})

    @staticmethod
    def _json(data: dict) -> HttpResponse:
        return HttpResponse(200, {"Content-Type": "application/json"}, json.dumps(data).encode())


class M2Tests(unittest.IsolatedAsyncioTestCase):
    async def test_upload_range_cache_fallback_and_delete(self):
        transport = FakeTransport(ignore_range=True)
        client = TelegramClient("123:fake", api_base="https://fake", transport=transport)
        pool = BotPool([PoolBot("b1", client, -1001)], min_interval=0)
        store = TelegramBlobStore(pool, file_path_ttl=600)
        ref = await store.put("ignored", b"0123456789")
        self.assertEqual(await store.get(ref, 2, 7), b"23456")
        self.assertEqual(transport.get_file_count, 1)
        self.assertEqual(await store.get(ref, 1, 3), b"12")
        self.assertEqual(transport.get_file_count, 1)
        await store.delete(ref)
        with self.assertRaises(Exception):
            await store.get(ref)

    async def test_range_request_and_rate_limit_classification(self):
        transport = FakeTransport()
        client = TelegramClient("123:fake", api_base="https://fake", transport=transport)
        pool = BotPool([PoolBot("b1", client, -1001)], min_interval=0)
        store = TelegramBlobStore(pool)
        ref = await store.put("ignored", b"abcdefghij")
        self.assertEqual(await store.get(ref, 3, 8), b"defgh")
        self.assertEqual(transport.get_file_count, 1)

        class RateLimited:
            async def request(self, method, url, headers, body):
                return HttpResponse(429, {}, b'{"ok":false,"error_code":429,"description":"slow","parameters":{"retry_after":2}}')

        with self.assertRaises(TelegramRateLimitError) as caught:
            await TelegramClient("123:fake", transport=RateLimited()).get_me()
        self.assertEqual(caught.exception.retry_after, 2)

    async def test_pool_reserves_each_bot_independently(self):
        clients = [TelegramClient("1:a", transport=FakeTransport()), TelegramClient("2:b", transport=FakeTransport())]
        pool = BotPool([PoolBot("a", clients[0], 1), PoolBot("b", clients[1], 2)], min_interval=0)
        selected = await asyncio.gather(pool.acquire_for_upload(), pool.acquire_for_upload())
        self.assertEqual({bot.id for bot in selected}, {"a", "b"})


if __name__ == "__main__":
    unittest.main()
