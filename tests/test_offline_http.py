"""用本地受控来源验证流式 HTTP，测试替身只在测试中允许回环连接。"""

import asyncio
import gzip
import unittest
from unittest.mock import AsyncMock, patch

from tgdrive.offline.http import DownloadError, SafeHttpClient
from tgdrive.offline.request import DownloadRequest


class FixtureHttp(SafeHttpClient):
    async def resolve(self, host, port):
        return ["127.0.0.1"]


class HttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.server = await asyncio.start_server(self.serve, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.client = FixtureHttp()

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def serve(self, reader, writer):
        try:
            request = await reader.readuntil(b"\r\n\r\n")
            self.requests.append(request)
            path = request.split(b" ")[1]
            if path == b"/redirect":
                writer.write(f"HTTP/1.1 302 Found\r\nLocation: http://other.test:{self.port}/file\r\nContent-Length: 0\r\n\r\n".encode())
            elif path == b"/chunked":
                writer.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\none\r\n3\r\ntwo\r\n0\r\nX-OK: yes\r\n\r\n")
            elif path == b"/gzip":
                body = gzip.compress(b"x" * 1000000)
                writer.write(f"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
            elif path == b"/short":
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort")
            elif path == b"/ambiguous":
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nx")
            else:
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nfile")
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    def request(self, path, **kwargs):
        return DownloadRequest(f"http://origin.test:{self.port}{path}", **kwargs)

    async def test_redirect_strips_all_custom_headers(self):
        request = self.request("/redirect", headers=[("Cookie", "secret=hidden"), ("Authorization", "Bearer hidden"), ("X-Custom-Key", "hidden")])
        async with self.client.open(request) as response:
            self.assertEqual(await response.read(), b"file")
        self.assertIn(b"secret=hidden", self.requests[0])
        self.assertNotIn(b"hidden", self.requests[1])

    async def test_chunked_and_bounded_decompression(self):
        async with self.client.open(self.request("/chunked")) as response:
            self.assertEqual(await response.read(), b"onetwo")
        async with self.client.open(self.request("/gzip")) as response:
            sizes = [len(piece) async for piece in response.stream()]
            self.assertEqual(sum(sizes), 1000000)
            self.assertLessEqual(max(sizes), 65536)

    async def test_post_redirect_never_replays_body(self):
        with self.assertRaises(DownloadError):
            async with self.client.open(self.request("/redirect", method="POST", body="fixture=value")):
                pass
        self.assertEqual(len(self.requests), 1)

    async def test_truncated_and_conflicting_length_fail(self):
        for path in ("/short", "/ambiguous"):
            with self.subTest(path=path), self.assertRaises(DownloadError):
                async with self.client.open(self.request(path)) as response:
                    await response.read()

    async def test_production_client_rejects_loopback_and_mixed_dns(self):
        with self.assertRaises(DownloadError):
            await SafeHttpClient().resolve("127.0.0.1", self.port)
        loop = asyncio.get_running_loop()
        records = [(2, 1, 6, "", ("8.8.8.8", 80)), (2, 1, 6, "", ("10.0.0.1", 80))]
        with patch.object(loop, "getaddrinfo", new=AsyncMock(return_value=records)), self.assertRaises(DownloadError):
            await SafeHttpClient().resolve("mixed.test", 80)
