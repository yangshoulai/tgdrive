"""离线下载的多连接：直链按 16 MiB 分段并行、来源拒绝分段时退回单连接、中断后只补缺的分段；平台媒体轨分段并行且按顺序交出。
来源与存储均为本机替身，不访问网络。"""

import asyncio
import hashlib
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.objects import Scope
from tgdrive.offline import platforms
from tgdrive.offline.http import DownloadError
from tgdrive.offline.parallel import ordered
from tgdrive.offline.service import PART_SIZE

MIB = 1024 * 1024


def content(size):
    # 周期 251 与 16 MiB 互质：任何一段放错位置都会改变内容。
    return (bytes(range(251)) * (size // 251 + 1))[:size]


class RangeResponse:
    def __init__(self, url, body, status, headers):
        self.url, self.status, self.headers, self.size = url, status, headers, len(body)
        self._body = body

    async def stream(self):
        for start in range(0, len(self._body), 1 * MIB):
            await asyncio.sleep(0.001)
            yield self._body[start:start + MIB]


class RangeHttp:
    """支持 bytes=a-b 与 bytes=a- 的来源替身；ignore_range 时声明支持却总是返回整个文件。"""

    def __init__(self, data, *, accept=True, ignore_range=False, fail_ranges=(), fail_delay=0):
        self.data, self.accept, self.ignore_range = data, accept, ignore_range
        self.fail_ranges, self.fail_delay = set(fail_ranges), fail_delay
        self.active = self.peak = 0
        self.ranges = []

    @asynccontextmanager
    async def open(self, request, *, extra_headers=None, **_):
        header = (extra_headers or {}).get("Range")
        self.ranges.append(header)
        if header in self.fail_ranges:
            await asyncio.sleep(self.fail_delay)
            raise DownloadError("来源拒绝了这一段")
        headers = {"etag": '"v1"', "content-type": "application/octet-stream"}
        if self.accept:
            headers["accept-ranges"] = "bytes"
        body, status = self.data, 200
        if header and not self.ignore_range:
            start, _, end = header.removeprefix("bytes=").partition("-")
            start, end = int(start), int(end) if end else len(self.data) - 1
            body, status = self.data[start:end + 1], 206
            headers["content-range"] = f"bytes {start}-{end}/{len(self.data)}"
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            yield RangeResponse(request.url, body, status, headers)
        finally:
            self.active -= 1


class DirectConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password", quota_bytes=10**10)
        self.offline = self.app.offline
        self.connections = 4
        effective = self.app.resources.effective
        self.app.resources.effective = lambda: {**effective(), "download_connections": self.connections}

    async def asyncTearDown(self):
        await self.offline.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    async def download(self, http, name="file.bin"):
        self.offline.http = http
        parsed = await self.offline.parse(self.alice.id, "https://example.com/file.bin")
        task = self.offline.create(self.alice.id, [{"ticket": parsed["candidates"][0]["ticket"], "name": name}], "d/")[0]
        self.offline.start()
        await self.wait(task["id"], ("completed", "failed"))
        return task["id"]

    async def wait(self, task_id, states):
        async with asyncio.timeout(60):
            while self.offline._row(task_id)["status"] not in states:
                await asyncio.sleep(0.01)

    async def stored(self, key):
        _, chunks = await self.app.objects.get_object(Scope(self.alice.bucket_id), key)
        return b"".join([piece async for piece in chunks])

    async def test_parallel_parts_reassemble_exactly(self):
        data = content(3 * PART_SIZE + 12345)
        http = RangeHttp(data)
        task_id = await self.download(http)
        self.assertEqual(self.offline._row(task_id)["status"], "completed", self.offline._row(task_id)["error"])
        self.assertEqual(hashlib.sha256(await self.stored("d/file.bin")).digest(), hashlib.sha256(data).digest())
        self.assertGreater(http.peak, 1, "同时打开多个连接")
        self.assertIn(f"bytes={PART_SIZE}-{2 * PART_SIZE - 1}", http.ranges, "按 16 MiB 切段请求")

    async def test_source_that_ignores_ranges_falls_back_to_single_connection(self):
        data = content(2 * PART_SIZE + 99)
        http = RangeHttp(data, ignore_range=True)
        task_id = await self.download(http)
        self.assertEqual(self.offline._row(task_id)["status"], "completed", self.offline._row(task_id)["error"])
        self.assertEqual(await self.stored("d/file.bin"), data)
        self.assertIn(task_id, self.offline._single)

    async def test_without_accept_ranges_or_single_connection_stays_sequential(self):
        for accept, connections in ((False, 4), (True, 1)):
            with self.subTest(accept=accept, connections=connections):
                self.connections = connections
                data = content(2 * PART_SIZE + 7)
                http = RangeHttp(data, accept=accept)
                task_id = await self.download(http, name=f"s-{accept}-{connections}.bin")
                self.assertEqual(await self.stored(f"d/s-{accept}-{connections}.bin"), data)
                self.assertEqual(http.peak, 1)
                await self.offline.stop()

    async def test_quota_failure_explains_bucket_usage(self):
        # 「空间不足」指账号存储桶的配额（不是服务器磁盘），失败信息要给出配额与已用量。
        with self.app.metadata.transaction() as db:
            db.execute("UPDATE buckets SET quota_bytes=? WHERE id=?", (2 * PART_SIZE, self.alice.bucket_id))
        task_id = await self.download(RangeHttp(content(3 * PART_SIZE)))
        row = self.offline._row(task_id)
        self.assertEqual(row["status"], "failed")
        self.assertIn("账号存储配额不足：配额 0.03 GB，已用 0.00 GB", row["error"])
        self.assertIn("回收站", row["error"])

    async def test_resume_fetches_only_missing_parts(self):
        data = content(4 * PART_SIZE)
        last = f"bytes={3 * PART_SIZE}-{4 * PART_SIZE - 1}"
        # 最后一段过一会儿才失败：前面的分段先写完，留下可以继续的断点。
        http = RangeHttp(data, fail_ranges={last}, fail_delay=1.5)
        task_id = await self.download(http)
        self.assertEqual(self.offline._row(task_id)["status"], "failed")
        done = {part.part_no for part in self.app.objects.list_parts(Scope(self.alice.bucket_id), self.offline._row(task_id)["upload_id"])}
        self.assertNotIn(4, done)
        self.assertTrue(done, "其余分段已经写入")
        http.fail_ranges.clear()
        http.ranges.clear()
        await self.offline.control(self.alice.id, task_id, "resume")
        await self.wait(task_id, ("completed", "failed"))
        self.assertEqual(self.offline._row(task_id)["status"], "completed", self.offline._row(task_id)["error"])
        self.assertEqual(await self.stored("d/file.bin"), data)
        expected = {f"bytes={(n - 1) * PART_SIZE}-{min(len(data), n * PART_SIZE) - 1}" for n in range(1, 5) if n not in done}
        self.assertEqual(set(http.ranges), expected, "继续时只请求缺的分段")


    async def test_diagnose_reports_running_writes_without_names(self):
        data = content(4 * PART_SIZE)
        last = f"bytes={3 * PART_SIZE}-{4 * PART_SIZE - 1}"
        http = RangeHttp(data, fail_ranges={last}, fail_delay=1.5)
        self.offline.http = http
        parsed = await self.offline.parse(self.alice.id, "https://example.com/file.bin")
        task = self.offline.create(self.alice.id, [{"ticket": parsed["candidates"][0]["ticket"], "name": "secret-name.bin"}], "d/")[0]
        self.offline.start()
        async with asyncio.timeout(30):
            while not (self.offline.diagnose(self.alice.id, task["id"]).get("totals") or {}).get("writes"):
                await asyncio.sleep(0.01)
        report = self.offline.diagnose(self.alice.id, task["id"])
        self.assertTrue(report["running"])
        self.assertEqual(report["phase"], "parallel")
        self.assertEqual(report["connections_limit"], 4)
        self.assertNotIn("secret-name", str(report))
        self.assertNotIn("example.com", str(report))
        await self.wait(task["id"], ("completed", "failed"))
        self.assertFalse(self.offline.diagnose(self.alice.id, task["id"])["running"], "任务结束后不再保留诊断")
        with self.assertRaises(Exception):
            self.offline.diagnose(self.alice.id + 1000, task["id"])


class DiagnosisRecorderTests(unittest.TestCase):
    def test_connections_and_writes_are_recorded_with_ranges_only(self):
        from tgdrive.offline import diagnostics
        recorder = diagnostics.TaskDiagnosis(1)
        connection = recorder.open({"Range": "bytes=0-1048575", "Cookie": "secret"})
        connection.response(206, 1048576)
        connection.data(4096)
        snapshot = recorder.snapshot()
        self.assertEqual(snapshot["connections"][0]["range"], "0-1048575")
        self.assertEqual((snapshot["connections"][0]["received"], snapshot["connections"][0]["size"]), (4096, 1048576))
        self.assertNotIn("secret", str(snapshot))
        recorder.close(connection, asyncio.CancelledError())
        recorder.close(recorder.open(None), DownloadError("来源拒绝了这一段"))
        snapshot = recorder.snapshot()
        self.assertEqual(snapshot["connections"], [])
        self.assertEqual([item["phase"] for item in snapshot["recent"]], ["failed", "cancelled"])
        self.assertEqual(snapshot["totals"]["failed"], 1, "取消的连接不算失败")
        entry = recorder.write_started(3, 100)
        self.assertEqual(recorder.snapshot()["writes"][0]["part"], 3)
        recorder.write_ended(entry)
        self.assertEqual((recorder.snapshot()["totals"]["writes"], recorder.snapshot()["totals"]["written"]), (1, 100))


class TrackConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_chunked_track_is_read_in_parallel_and_in_order(self):
        data = content(10 * MIB + 333)
        http = RangeHttp(data)
        track = {"url": "https://rr1---sn.googlevideo.com/videoplayback?id=1", "headers": {}, "chunk": MIB}
        original = platforms.media_request
        platforms.media_request = lambda platform, item: platforms.DownloadRequest(item["url"])
        try:
            stream = platforms.track_stream(http, "youtube", track, connections=4)
            received = b"".join([piece async for piece in stream])
        finally:
            platforms.media_request = original
        self.assertEqual(received, data)
        self.assertGreater(http.peak, 1)

    async def test_ordered_yields_in_order_and_cancels_on_close(self):
        async def quick(item):
            await asyncio.sleep(0.02 if item % 2 == 0 else 0.001)
            return item
        self.assertEqual([value async for value in ordered(range(10), quick, 3)], list(range(10)), "结果按原顺序交出")

        started, cancelled = [], []

        async def slow(item):
            started.append(item)
            try:
                await asyncio.sleep(5)
                return item
            except asyncio.CancelledError:
                cancelled.append(item)
                raise
        generator = ordered(range(100), slow, 4)
        waiting = asyncio.ensure_future(generator.__anext__())
        await asyncio.sleep(0.05)
        self.assertEqual(started, [0, 1, 2, 3], "只向前预读 concurrency 项")
        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)
        await generator.aclose()
        self.assertEqual(sorted(cancelled), [0, 1, 2, 3], "提前结束时取消并等待全部未完成的读取")

if __name__ == "__main__":
    unittest.main()
