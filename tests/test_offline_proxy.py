"""出站代理（HTTP CONNECT／SOCKS5）与平台分段读取的回归；代理和来源都用本地受控服务替身。"""

import asyncio
import struct
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path

from tgdrive.metadata import Metadata
from tgdrive.offline.http import DownloadError, SafeHttpClient
from tgdrive.offline.platforms import MIB, track_stream
from tgdrive.offline.request import DownloadRequest
from tgdrive.offline.resources import ResourceSettings


class NoDns(SafeHttpClient):
    async def resolve(self, host, port):
        raise AssertionError("启用代理后不能在本地解析来源域名")


class ProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tunnels = []
        self.origin = await asyncio.start_server(self.serve_origin, "127.0.0.1", 0)
        self.origin_port = self.origin.sockets[0].getsockname()[1]
        self.http_proxy = await asyncio.start_server(self.serve_connect, "127.0.0.1", 0)
        self.socks_proxy = await asyncio.start_server(self.serve_socks, "127.0.0.1", 0)

    async def asyncTearDown(self):
        for server in (self.origin, self.http_proxy, self.socks_proxy):
            server.close()
            await server.wait_closed()

    async def serve_origin(self, reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nfile")
        await writer.drain()
        writer.close()

    async def pipe(self, reader, writer):
        # 测试代理不论目标域名，统一转发到本地来源。
        upstream_reader, upstream_writer = await asyncio.open_connection("127.0.0.1", self.origin_port)
        async def copy(source, target):
            while data := await source.read(65536):
                target.write(data)
                await target.drain()
            target.close()
        await asyncio.gather(copy(reader, upstream_writer), copy(upstream_reader, writer), return_exceptions=True)

    async def serve_connect(self, reader, writer):
        head = await reader.readuntil(b"\r\n\r\n")
        self.tunnels.append(head)
        if b"Proxy-Authorization: Basic dXNlcjpwYXNz" not in head:
            writer.write(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await writer.drain()
        await self.pipe(reader, writer)

    async def serve_socks(self, reader, writer):
        version, count = await reader.readexactly(2)
        methods = await reader.readexactly(count)
        assert version == 5 and 2 in methods
        writer.write(b"\x05\x02")
        _, size = await reader.readexactly(2)
        user = await reader.readexactly(size)
        password = await reader.readexactly((await reader.readexactly(1))[0])
        writer.write(b"\x01\x00" if (user, password) == (b"user", b"pass") else b"\x01\x01")
        _, command, _, kind = await reader.readexactly(4)
        host = await reader.readexactly((await reader.readexactly(1))[0])
        port = struct.unpack(">H", await reader.readexactly(2))[0]
        self.tunnels.append((command, kind, host, port))
        writer.write(b"\x05\x00\x00\x01" + bytes(4) + b"\x00\x00")
        await writer.drain()
        await self.pipe(reader, writer)

    def request(self):
        return DownloadRequest(f"http://files.example.com:{self.origin_port}/file")

    async def test_http_connect_tunnel_uses_proxy_dns_and_auth(self):
        client = NoDns(proxy=lambda: f"http://user:pass@127.0.0.1:{self.http_proxy.sockets[0].getsockname()[1]}")
        async with client.open(self.request()) as response:
            self.assertEqual(await response.read(), b"file")
        self.assertTrue(self.tunnels[0].startswith(f"CONNECT files.example.com:{self.origin_port} HTTP/1.1".encode()))

    async def test_socks5_sends_hostname_to_proxy(self):
        client = NoDns(proxy=lambda: f"socks5://user:pass@127.0.0.1:{self.socks_proxy.sockets[0].getsockname()[1]}")
        async with client.open(self.request()) as response:
            self.assertEqual(await response.read(), b"file")
        self.assertEqual(self.tunnels[0], (1, 3, b"files.example.com", self.origin_port))

    async def test_proxy_rejection_is_reported_without_credentials(self):
        client = NoDns(proxy=lambda: f"http://user:wrong@127.0.0.1:{self.http_proxy.sockets[0].getsockname()[1]}")
        with self.assertRaises(DownloadError) as caught:
            async with client.open(self.request()):
                pass
        self.assertIn("407", str(caught.exception))
        self.assertNotIn("wrong", str(caught.exception))

    async def test_reset_during_connect_is_retried(self):
        attempts = []
        async def flaky(reader, writer):
            attempts.append(1)
            if len(attempts) == 1:
                writer.transport.abort()
                return
            await self.serve_connect(reader, writer)
        server = await asyncio.start_server(flaky, "127.0.0.1", 0)
        try:
            client = NoDns(proxy=lambda: f"http://user:pass@127.0.0.1:{server.sockets[0].getsockname()[1]}")
            async with client.open(self.request()) as response:
                self.assertEqual(await response.read(), b"file")
            self.assertEqual(len(attempts), 2)
        finally:
            server.close()
            await server.wait_closed()

    async def test_internal_targets_rejected_before_proxy(self):
        client = NoDns(proxy=lambda: f"http://user:pass@127.0.0.1:{self.http_proxy.sockets[0].getsockname()[1]}")
        for url in ("http://127.0.0.1/a", "http://[::1]/a", "http://169.254.169.254/a", "http://localhost/a",
                    "http://nas.local/a", "http://router.lan/a", "http://intranet/a", "http://2130706433/a", "http://0x7f.1/a"):
            with self.subTest(url=url), self.assertRaises(DownloadError):
                async with client.open(DownloadRequest(url)):
                    pass
        self.assertEqual(self.tunnels, [])


class ProxySettingsTests(unittest.TestCase):
    def test_validation_masking_and_preserved_password(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata = Metadata(Path(directory) / "meta.db")
            resources = ResourceSettings(metadata, Path(directory))
            for value in ("ftp://proxy:21", "http://proxy", "http://proxy:8080/path", "socks4://proxy:1080", "http://pro xy:1"):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    resources.update({"proxy": value})
            described = resources.update({"proxy": "SOCKS5h://user:p%40ss@Proxy.example:1080"})
            self.assertEqual(resources.config()["proxy"], "socks5h://user:p%40ss@proxy.example:1080")
            self.assertEqual(described["config"]["proxy"], "socks5h://user:******@proxy.example:1080")
            self.assertNotIn("p%40ss", repr(described))
            resources.update({"proxy": described["config"]["proxy"], "bandwidth_kib": 10})
            self.assertEqual(resources.config()["proxy"], "socks5h://user:p%40ss@proxy.example:1080")
            resources.update({"proxy": ""})
            self.assertEqual(resources.config()["proxy"], "")
            metadata.close()


class RangeResponse:
    def __init__(self, status, headers, body):
        self.status, self.headers, self.body = status, headers, body
        self.size = len(body)

    async def stream(self):
        for index in range(0, len(self.body), 65536):
            yield self.body[index:index + 65536]


class RangeHttp:
    def __init__(self, data, *, ignore_range=False, total=None):
        self.data, self.ranges, self.ignore_range, self.total = data, [], ignore_range, total

    @asynccontextmanager
    async def open(self, request, *, extra_headers=None, **_):
        header = (extra_headers or {}).get("Range")
        self.ranges.append(header)
        if header is None or self.ignore_range:
            yield RangeResponse(200, {}, self.data)
            return
        start, end = (int(value) for value in header.split("=", 1)[1].split("-"))
        end = min(end, len(self.data) - 1)
        yield RangeResponse(206, {"content-range": f"bytes {start}-{end}/{self.total or len(self.data)}"}, self.data[start:end + 1])


class TrackStreamTests(unittest.IsolatedAsyncioTestCase):
    def track(self, chunk=MIB):
        return {"url": "https://rr1---sn-test.googlevideo.com/videoplayback?id=1", "headers": {}, "chunk": chunk}

    async def read(self, client, track):
        sizes = []
        data = b"".join([piece async for piece in track_stream(client, "youtube", track, on_size=sizes.append)])
        return data, sizes

    async def test_chunked_ranges_cover_whole_file(self):
        payload = bytes(range(256)) * (10 * 1024)  # 2.5 MiB
        client = RangeHttp(payload)
        data, sizes = await self.read(client, self.track())
        self.assertEqual(data, payload)
        self.assertEqual(sizes, [len(payload)])
        self.assertEqual(client.ranges, ["bytes=0-1048575", "bytes=1048576-2097151", f"bytes=2097152-{len(payload) - 1}"])

    async def test_unchunked_or_range_ignored_reads_once(self):
        payload = b"x" * 300000
        for client, track in ((RangeHttp(payload), self.track(None)), (RangeHttp(payload, ignore_range=True), self.track())):
            data, _ = await self.read(client, track)
            self.assertEqual((data, len(client.ranges)), (payload, 1))

    async def test_interrupted_chunk_resumes_from_exact_offset(self):
        from tgdrive.offline.http import TransientError
        payload = bytes(range(256)) * (10 * 1024)
        class Dropping(RangeHttp):
            dropped = False
            @asynccontextmanager
            async def open(self, request, **kwargs):
                async with super().open(request, **kwargs) as response:
                    if self.ranges[-1] == "bytes=1048576-2097151" and not self.dropped:
                        self.dropped = True
                        async def half():
                            yield response.body[:300000]
                            raise TransientError("来源连接中断，可以稍后重试")
                        response.stream = half
                    yield response
        client = Dropping(payload)
        data, _ = await self.read(client, self.track())
        self.assertEqual(data, payload)
        # 断开后从已读取的位置继续，不重新请求已经交给调用方的字节。
        self.assertTrue(client.ranges[2].startswith(f"bytes={1048576 + 300000}-"))

    async def test_changed_total_fails(self):
        class Shifting(RangeHttp):
            @asynccontextmanager
            async def open(self, request, **kwargs):
                async with super().open(request, **kwargs) as response:
                    yield response
                self.total = len(self.data) + 1
        with self.assertRaises(DownloadError):
            await self.read(Shifting(b"y" * (3 * MIB)), self.track())


if __name__ == "__main__":
    unittest.main()
