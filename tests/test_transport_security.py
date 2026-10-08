"""M18：登录限流、页面安全头、连接复用与代理、并行上传与 Telegram 读取窗口。"""
import asyncio
import http.server
import json
import os
import socket
import socketserver
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.metadata import Metadata
from tgdrive.telegram.client import PooledTransport
from tgdrive.telegram.config import ConfiguredBlobStore


class CountingHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    connections: set = set()

    def do_GET(self):
        CountingHandler.connections.add(self.client_address)
        body = b"x" * 1000
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class ConnectProxy(socketserver.ThreadingTCPServer):
    """只支持 CONNECT 的最小代理，记录隧道目标。"""
    daemon_threads = True
    allow_reuse_address = True
    tunnels: list = []

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            request = b""
            while b"\r\n\r\n" not in request:
                request += self.request.recv(1024)
            target = request.split(b" ")[1].decode()
            ConnectProxy.tunnels.append(target)
            host, port = target.rsplit(":", 1)
            upstream = socket.create_connection((host, int(port)))
            self.request.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")

            def pipe(src, dst):
                try:
                    while data := src.recv(65536):
                        dst.sendall(data)
                except OSError:
                    pass
            threading.Thread(target=pipe, args=(upstream, self.request), daemon=True).start()
            pipe(self.request, upstream)


def serve(server):
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class TransportTests(unittest.TestCase):
    def setUp(self):
        CountingHandler.connections = set()
        self.server = serve(http.server.ThreadingHTTPServer(("127.0.0.1", 0), CountingHandler))
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/file"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_connections_are_reused(self):
        transport = PooledTransport()
        self.addCleanup(transport.close)
        with mock.patch.dict(os.environ, {"NO_PROXY": "*", "no_proxy": "*"}):
            for _ in range(10):
                response = asyncio.run(transport.request("GET", self.url, {}, None))
                self.assertEqual((response.status, len(response.body)), (200, 1000))
        self.assertEqual(len(CountingHandler.connections), 1)

    def test_requests_go_through_configured_proxy(self):
        proxy = serve(ConnectProxy(("127.0.0.1", 0), ConnectProxy.Handler))
        ConnectProxy.tunnels = []
        try:
            env = {"HTTP_PROXY": f"http://127.0.0.1:{proxy.server_address[1]}", "NO_PROXY": "", "no_proxy": ""}
            transport = PooledTransport()
            self.addCleanup(transport.close)
            with mock.patch.dict(os.environ, env):
                response = asyncio.run(transport.request("GET", self.url, {}, None))
            self.assertEqual(response.status, 200)
            self.assertEqual(ConnectProxy.tunnels, [f"127.0.0.1:{self.server.server_address[1]}"])
        finally:
            proxy.shutdown()
            proxy.server_close()


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def test_chunks_upload_in_parallel_and_in_order(self):
        with tempfile.TemporaryDirectory() as temp:
            metadata = Metadata(Path(temp) / "m.db")
            store = LocalDiskBlobStore(Path(temp) / "blobs")
            active, peak = 0, 0
            original = store.put

            async def slow_put(key, data):
                nonlocal active, peak
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.02)
                active -= 1
                return await original(key, data)
            store.put = slow_put
            engine = BlobEngine(metadata, store, b"0" * 32, chunk_size=32, frame_size=8)
            blob = engine.begin_blob()
            data = bytes(range(250))
            result = await engine.put_part(blob, 1, [data[i:i + 10] for i in range(0, len(data), 10)])
            engine.finalize(blob, [1])
            self.assertEqual(peak, engine.upload_concurrency)
            self.assertEqual(await engine.read(blob), data)
            self.assertEqual(result.size, 250)
            metadata.close()

    def test_telegram_refs_use_larger_read_window(self):
        store = ConfiguredBlobStore.__new__(ConfiguredBlobStore)
        self.assertEqual(store.read_window('{"v":1,"bot":"1","chat":-1,"msg":1,"fid":"f"}'), 8 * 1024 * 1024)
        self.assertEqual(store.read_window("ab" * 16), 1024 * 1024)


class WebSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        static = root / "static"
        static.mkdir()
        (static / "index.html").write_text("<html></html>")
        self.app = create_app(root / "data", secure_cookies=False, static_dir=static)
        self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.app.accounts.create_user("alice", "alice password")
        self.client = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def login(self, password, ip):
        async def run():
            sent = []
            queue = [{"type": "http.request", "body": json.dumps({"username": "alice", "password": password}).encode(), "more_body": False}]
            async def receive():
                return queue.pop(0)
            async def send(message):
                sent.append(message)
            await self.app({"type": "http", "method": "POST", "path": "/api/user/v1/login", "query_string": b"",
                            "headers": [], "client": (ip, 1234)}, receive, send)
            return sent[0]["status"]
        return asyncio.run(run())

    def test_attacker_cannot_lock_out_user_from_another_ip(self):
        for _ in range(6):
            self.login("wrong password", "10.0.0.66")
        self.assertEqual(self.login("alice password", "10.0.0.66"), 429)
        self.assertEqual(self.login("alice password", "192.168.1.5"), 200)

    def test_one_ip_cannot_spray_many_usernames(self):
        for index in range(30):
            self.assertIn(self.login_as(f"nobody{index}", "10.9.9.9"), (401, 429))
        self.assertEqual(self.login("alice password", "10.9.9.9"), 429)

    def login_as(self, username, ip):
        async def run():
            sent = []
            queue = [{"type": "http.request", "body": json.dumps({"username": username, "password": "x"}).encode(), "more_body": False}]
            async def receive():
                return queue.pop(0)
            async def send(message):
                sent.append(message)
            await self.app({"type": "http", "method": "POST", "path": "/api/user/v1/login", "query_string": b"",
                            "headers": [], "client": (ip, 1)}, receive, send)
            return sent[0]["status"]
        return asyncio.run(run())

    def test_pages_send_security_headers(self):
        status, headers, _ = asyncio.run(self.client.request("GET", "/", headers={"host": "drive.example.test"}))
        self.assertEqual(status, 200)
        self.assertIn("frame-ancestors 'none'", headers["content-security-policy"])
        self.assertEqual(headers["x-frame-options"], "DENY")
        self.assertNotIn("strict-transport-security", headers)
        # 是否是 HTTPS 以 ASGI 的 scheme 为准：uvicorn 只会对 --trusted-proxies 里的代理采信 X-Forwarded-Proto，
        # 应用自己不再读取这个请求头，避免任何客户端伪造。
        _, headers, _ = asyncio.run(self.client.request("GET", "/", headers={"host": "drive.example.test", "x-forwarded-proto": "https"}))
        self.assertNotIn("strict-transport-security", headers)
        _, headers, _ = asyncio.run(self.client.request("GET", "/", headers={"host": "drive.example.test"}, scheme="https"))
        self.assertIn("max-age", headers["strict-transport-security"])


if __name__ == "__main__":
    unittest.main()
