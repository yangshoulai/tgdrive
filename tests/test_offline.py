"""离线下载的关键回归：命令隔离、授权、凭据加密与条件续传。"""

import asyncio
import json
import tempfile
import unittest
from unittest.mock import patch
from contextlib import asynccontextmanager

from tgdrive.app import create_app
from tgdrive.errors import NotFoundError
from tgdrive.objects import Scope
from tgdrive.offline.hls import parse_playlist
from tgdrive.offline.http import DownloadError, SafeHttpClient, public_ip
from tgdrive.offline.request import parse_requests
from tgdrive.offline.resources import ResourceSettings
from tests.test_public_links import Client


class RequestTests(unittest.TestCase):
    def test_browser_curl_and_wget(self):
        request = parse_requests("curl 'https://example.com/f?x=1&y=2' " + "\\\n" + " -H 'Cookie: auth=private' -H 'Range: bytes=1-9' --compressed -L")[0]
        self.assertEqual(request.url, "https://example.com/f?x=1&y=2")
        self.assertIn(("Cookie", "auth=private"), request.headers)
        self.assertNotIn("range", [key.lower() for key, _ in request.headers])
        self.assertTrue(request.warnings)
        request = parse_requests("wget --header='Authorization: Bearer test' --post-data='a=b' -O 'file.zip' https://example.com/download")[0]
        self.assertEqual((request.method, request.body, request.name), ("POST", "a=b", "file.zip"))
        request = parse_requests("curl https://example.com/f --data-raw $'a=hello\\nworld'")[0]
        self.assertEqual(request.body, "a=hello\nworld")

    def test_dangerous_or_unknown_arguments_rejected(self):
        for text in ("curl https://example.com/f; whoami", "curl $(whoami)", "curl \"https://example.com/$SECRET\"", "curl -k https://example.com/f", "curl --proxy http://secret https://example.com/f", "curl -d @/etc/passwd https://example.com/f", "wget --load-cookies cookies https://example.com/f", "curl https://example.com/f -H 'Host: localhost'", "magnet:?xt=x", "file:///etc/passwd"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_requests(text)
        request = parse_requests("curl https://example.com/f --data-raw '$(id); harmless'")[0]
        self.assertEqual(request.body, "$(id); harmless")

    def test_public_addresses_only(self):
        for value in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "224.0.0.1"):
            self.assertFalse(public_ip(value), value)
        self.assertTrue(public_ip("8.8.8.8"))

    def test_hls_limits(self):
        base = "https://example.com/video/index.m3u8"
        playlist = parse_playlist(b"#EXTM3U\n#EXTINF:2,\n1.ts\n#EXTINF:3,\n2.ts\n#EXT-X-ENDLIST\n", base)
        self.assertEqual(playlist.duration, 5)
        self.assertEqual(playlist.segments[0][0], "https://example.com/video/1.ts")
        for text in ("#EXTM3U\n#EXTINF:2,\n1.ts", "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key\"\n#EXTINF:2,\n1.ts\n#EXT-X-ENDLIST", "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2,\n1.ts", "#EXTM3U\n#EXT-X-GAP\n#EXTINF:2,\n1.ts\n#EXT-X-ENDLIST"):
            with self.assertRaises(ValueError):
                parse_playlist(text.encode(), base)


class MemoryResponse:
    def __init__(self, request, method, start, size, *, changed=False):
        self.url, self.method, self.start = request.url, method, start
        self.size, self.status = size - start, 206 if start else 200
        self.headers = {"etag": '"changed"' if changed else '"version-1"', "content-type": "application/octet-stream"}
        if start:
            self.headers["content-range"] = f"bytes {start}-{size - 1}/{size}"

    async def stream(self):
        remaining = self.size
        while remaining:
            await asyncio.sleep(0.001)
            piece = b"x" * min(65536, remaining)
            remaining -= len(piece)
            yield piece


class MemoryHttp:
    def __init__(self, size=1000):
        self.size, self.calls, self.changed = size, [], False

    @asynccontextmanager
    async def open(self, request, *, method=None, extra_headers=None, **kwargs):
        method = method or request.method
        extra = extra_headers or {}
        self.calls.append((method, dict(extra), request.url))
        start = int(extra.get("Range", "bytes=0-").split("=", 1)[1].split("-", 1)[0])
        yield MemoryResponse(request, method, start, self.size, changed=self.changed)


class TaskTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(self.temp.name, secure_cookies=False, run_scheduler=False)
        self.admin = self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.alice = self.app.accounts.create_user("alice", "alice password")
        self.offline = self.app.offline
        self.offline.http = self.http = MemoryHttp()

    async def asyncTearDown(self):
        await self.offline.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    async def make(self, text="curl https://example.com/file.bin -H 'Cookie: secret=hidden' -L"):
        parsed = await self.offline.parse(self.alice.id, text)
        return self.offline.create(self.alice.id, [{"ticket": parsed["candidates"][0]["ticket"], "name": "file.bin"}], "downloads/")[0]

    async def wait_for(self, predicate):
        async with asyncio.timeout(15):
            while not predicate():
                await asyncio.sleep(0.01)

    async def test_elapsed_time_recorded_and_reset_on_restart(self):
        task = await self.make()
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
        listed = self.offline.list(self.alice.id)["tasks"][0]
        self.assertGreater(listed["elapsed_seconds"], 0)
        await self.offline.stop()  # 停止调度，重新下载后任务保持排队，便于检查重置结果
        await self.offline.control(self.alice.id, task["id"], "restart")
        self.assertEqual(self.offline._row(task["id"])["elapsed_seconds"], 0)

    async def test_missing_extension_taken_from_content_type(self):
        http = self.http
        class Typed(MemoryHttp):
            @asynccontextmanager
            async def open(inner, request, **kwargs):
                async with http.open(request, **kwargs) as response:
                    response.headers["content-type"] = "image/jpeg"
                    yield response
        self.offline.http = Typed()
        parsed = await self.offline.parse(self.alice.id, "https://gips2.example.com/it/u=195724436,3554684702&fm=3028&app=3028")
        self.assertEqual(parsed["candidates"][0]["name"], "u=195724436,3554684702&fm=3028&app=3028.jpg")
        parsed = await self.offline.parse(self.alice.id, "https://example.com/download/archive")
        self.assertEqual(parsed["candidates"][0]["name"], "archive.jpg")
        self.offline.http = http
        parsed = await self.offline.parse(self.alice.id, "https://example.com/download/blob")
        self.assertEqual(parsed["candidates"][0]["name"], "blob")

    async def test_hls_separate_audio_survives_ticket_update_and_saves(self):
        self.app.resources.ffmpeg = "fixture"
        self.app.resources.update({"hls_enabled": True})
        class HlsHttp(MemoryHttp):
            audio = "audio.m3u8"
            @asynccontextmanager
            async def open(inner, request, **kwargs):
                async with self.http.open(request, **kwargs) as response:
                    response.headers["content-type"] = "application/vnd.apple.mpegurl"
                    async def read():
                        if request.url.endswith("master.m3u8"):
                            return (f'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="{inner.audio}"\n'
                                '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a"\nvideo.m3u8\n').encode()
                        return b'#EXTM3U\n#EXTINF:2,\n1.ts\n#EXT-X-ENDLIST\n'
                    response.read = read
                    yield response
        client = HlsHttp()
        self.offline.http = client
        async def parse():
            return (await self.offline.parse(self.alice.id,
                "curl https://example.com/master.m3u8 -H 'Cookie: secret=hidden'"))["candidates"][0]
        candidate = await parse()
        task = self.offline.create(self.alice.id, [{"ticket": candidate["ticket"], "name": "movie.mp4"}], "")[0]
        client.audio = "updated.m3u8"
        replacement = await parse()
        await self.offline.control(self.alice.id, task["id"], "update", item={"ticket": replacement["ticket"]})
        source = self.offline._source(self.offline._row(task["id"]))
        self.assertEqual(source["hls_audio"]["url"], "https://example.com/updated.m3u8")
        self.assertEqual(source["hls_audio"]["credential_origin"], "https://example.com/master.m3u8")
        calls = []
        async def remux(*args, **kwargs):
            calls.append(kwargs)
            yield b'muxed movie'
        with patch('tgdrive.offline.service.remux', remux):
            self.offline.start()
            await self.wait_for(lambda: self.offline._row(task["id"])["status"] in ("completed", "failed"))
        self.assertEqual(self.offline._row(task["id"])["status"], "completed")
        self.assertEqual(calls[0]["audio"][0].url, "https://example.com/updated.m3u8")
        self.assertEqual(self.offline._row(task["id"])["segments_total"], 2)

    async def test_credentials_permissions_and_delete_retains_file(self):
        task = await self.make()
        row = self.offline._row(task["id"])
        self.assertNotIn(b"secret=hidden", row["request_enc"])
        self.assertNotIn("hidden", json.dumps(self.offline.list(self.alice.id)))
        self.assertEqual(self.offline._source(row)["request"]["headers"][0][1], "secret=hidden")
        with self.assertRaises(NotFoundError):
            await self.offline.control(self.admin.id, task["id"], "delete")
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
        self.assertEqual(self.app.objects.head_object(Scope(self.alice.bucket_id), "downloads/file.bin").size, 1000)
        await self.offline.control(self.alice.id, task["id"], "delete")
        self.assertEqual(self.app.objects.head_object(Scope(self.alice.bucket_id), "downloads/file.bin").size, 1000)

    async def test_stop_and_strong_validator_resume(self):
        self.http.size = 20 * 1024 * 1024
        task = await self.make()
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["stored_bytes"] >= 16 * 1024 * 1024)
        await self.offline.control(self.alice.id, task["id"], "stop")
        row = self.offline._row(task["id"])
        self.assertEqual(row["status"], "stopped")
        await self.offline.control(self.alice.id, task["id"], "resume")
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
        ranges = [headers for method, headers, _ in self.http.calls if method == "GET" and headers]
        self.assertEqual(ranges[-1], {"Range": "bytes=16777216-", "If-Range": '"version-1"'})
        self.assertEqual(self.app.objects.head_object(Scope(self.alice.bucket_id), "downloads/file.bin").size, self.http.size)

    async def test_temporary_source_error_keeps_breakpoint_and_retries(self):
        from tgdrive.offline import service
        self.http.size = 20 * 1024 * 1024
        task = await self.make()
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["stored_bytes"] >= 16 * 1024 * 1024)
        await self.offline.control(self.alice.id, task["id"], "stop")
        http, outages = self.http, [1]
        class Unavailable:
            @asynccontextmanager
            async def open(self, request, **kwargs):
                if outages[0]:
                    outages[0] -= 1
                    yield type("Reply", (), {"status": 503, "headers": {}, "size": 0, "url": request.url})()
                    return
                async with http.open(request, **kwargs) as response:
                    yield response
        original, service.RETRY_DELAYS = service.RETRY_DELAYS, (0.05, 0.05, 0.05)
        try:
            self.offline.http = Unavailable()
            await self.offline.control(self.alice.id, task["id"], "resume")
            await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
        finally:
            service.RETRY_DELAYS = original
        # 503 之后仍从 16 MiB 断点继续，没有清理已保存的分段。
        ranges = [headers for method, headers, _ in http.calls if method == "GET" and headers]
        self.assertEqual(ranges[-1], {"Range": "bytes=16777216-", "If-Range": '"version-1"'})

    async def test_changed_source_is_never_appended(self):
        self.http.size = 20 * 1024 * 1024
        task = await self.make()
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["stored_bytes"] >= 16 * 1024 * 1024)
        await self.offline.control(self.alice.id, task["id"], "stop")
        self.http.changed = True
        await self.offline.control(self.alice.id, task["id"], "resume")
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "failed")
        self.assertIsNone(self.offline._row(task["id"])["upload_id"])
        with self.assertRaises(NotFoundError):
            self.app.objects.head_object(Scope(self.alice.bucket_id), "downloads/file.bin")

    async def test_post_parse_no_probe_and_rotation_preserves_secrets(self):
        task = await self.make("curl https://example.com/file.bin --data-raw 'private=value'")
        self.assertEqual(self.http.calls, [])
        self.app.keystore.rotate("encryption passphrase", "new encryption passphrase")
        self.assertEqual(self.offline._source(self.offline._row(task["id"]))["request"]["body"], "private=value")
        self.offline._set(task["id"], status="running")
        self.offline.start()
        self.assertEqual(self.offline._row(task["id"])["status"], "stopped")
        await asyncio.sleep(0.02)
        self.assertEqual(self.http.calls, [])

    async def test_expired_upload_and_conflict_are_safe(self):
        task = await self.make()
        self.offline._set(task["id"], upload_id="already-cleaned", stored_bytes=12345)
        await self.app.objects.put_object(Scope(self.alice.bucket_id), "downloads/file.bin", b"keep this file")
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
        self.assertEqual(self.app.objects.head_object(Scope(self.alice.bucket_id), "downloads/file.bin").size, 14)
        self.assertEqual(self.offline._row(task["id"])["key"], "downloads/file (1).bin")

    async def test_admin_config_and_web_authorization(self):
        client = Client(self.app)
        alice = await client.login("user", "alice", "alice password")
        status, _, _ = await client.request("POST", "/api/admin/v1/resources", b'{"mode":"low"}', alice)
        self.assertEqual(status, 403)
        status, _, _ = await client.request("POST", "/api/user/v1/downloads/parse", b'{"input":"https://example.com/f"}', {"cookie": alice["cookie"]})
        self.assertEqual(status, 403)
        admin = await client.login("admin", "admin", "admin password")
        status, _, data = await client.request("POST", "/api/admin/v1/resources", b'{"mode":"low"}', admin)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["effective"]["concurrency"], 1)
        self.assertEqual(self.app.engine.transfers.per_bucket, 1)
        # 私密下载位置需要已解锁的私密授权；未授权是业务校验错误（400），不能让前端当成会话过期。
        with self.assertRaises(ValueError):
            parsed = await self.offline.parse(self.alice.id, "https://example.com/f")
            self.offline.create(self.alice.id, [{"ticket": parsed["candidates"][0]["ticket"], "name": "f"}], ".tgdrive/private/")

    async def test_budget_persistence_and_disabled_queue(self):
        self.app.resources.detected.update(cpu_cores=1, memory_bytes=750 * 1024 * 1024)
        saved = self.app.resources.update({"mode": "custom", "concurrency": 4})
        self.assertEqual(saved["effective"]["concurrency"], 1)
        self.assertTrue(saved["effective"]["reduced"])
        restored = ResourceSettings(self.app.metadata, self.app.resources.data_dir, {"mode": "standard"})
        self.assertEqual(restored.config()["mode"], "custom")
        task = await self.make()
        self.app.accounts.set_account_status(self.alice.id, "disabled")
        self.assertEqual(self.offline._row(task["id"])["status"], "stopped")
        self.app.accounts.set_account_status(self.alice.id, "active")
        self.offline.start()
        await asyncio.sleep(0.02)
        self.assertEqual(self.offline._row(task["id"])["status"], "stopped")

    async def test_lock_unlock_resumes_get(self):
        self.http.size = 20 * 1024 * 1024
        task = await self.make()
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["stored_bytes"] >= 16 * 1024 * 1024)
        self.app.keystore.lock()
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "interrupted")
        self.app.keystore.unlock("encryption passphrase")
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")

    async def test_shutdown_keeps_completed_status(self):
        task = await self.make()
        worker = asyncio.create_task(self.offline._run(task["id"]))
        await worker
        self.offline._running[task["id"]] = worker
        await self.offline.stop()
        self.assertEqual(self.offline._row(task["id"])["status"], "completed")

    async def test_ambient_cancel_does_not_replay_post(self):
        self.http.size = 20 * 1024 * 1024
        task = await self.make("curl https://example.com/file.bin --data-raw 'fixture=value'")
        self.offline.start()
        await self.wait_for(lambda: bool(self.http.calls))
        worker = self.offline._running[task["id"]]
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)
        self.assertEqual(self.offline._row(task["id"])["status"], "stopped")
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.http.calls), 1)
