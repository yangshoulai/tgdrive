"""上传限制：全局写入名额、平均限速、Bot 发送间隔与网页并发都来自「下载与资源」配置并随时生效。"""

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.work import Limiter, RateLimiter


class LimiterTests(unittest.IsolatedAsyncioTestCase):
    async def test_limiter_caps_concurrency_and_accepts_new_limit(self):
        limiter, active, peak = Limiter(2), 0, 0

        async def job():
            nonlocal active, peak
            async with limiter.slot():
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.02)
                active -= 1

        await asyncio.gather(*(job() for _ in range(6)))
        self.assertEqual(peak, 2)
        limiter.set_limit(4)
        peak = 0
        await asyncio.gather(*(job() for _ in range(8)))
        self.assertEqual(peak, 4)
        with self.assertRaises(ValueError):
            limiter.set_limit(0)

    async def test_rate_limiter_spaces_bytes_and_zero_is_unlimited(self):
        limiter = RateLimiter(0)
        started = time.monotonic()
        for _ in range(5):
            await limiter.consume(10 ** 9)
        self.assertLess(time.monotonic() - started, 0.05)
        limiter.set_rate(1000)
        started = time.monotonic()
        await asyncio.gather(limiter.consume(50), limiter.consume(50), limiter.consume(50))
        self.assertGreaterEqual(time.monotonic() - started, 0.09, "第三个调用要等前两个的 100 字节按 1000 B/s 发完")


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.app.accounts.create_user("alice@example.com", "alice password", quota_bytes=10_000_000)
        self.client = Client(self.app)
        self.app.resources.detected.update(cpu_cores=4, memory_bytes=8 * 1024 ** 3)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def test_admin_settings_apply_immediately_and_web_reads_them(self):
        resources, engine = self.app.resources, self.app.objects.engine
        store = engine.store
        saved = resources.update({"mode": "standard", "upload_concurrency": 6, "upload_kib": 2048, "bot_interval_ms": 2500,
                                  "web_part_concurrency": 6, "web_file_concurrency": 3})["effective"]
        self.assertEqual((saved["upload_concurrency"], saved["upload_reduced"]), (6, False))
        self.assertEqual((engine.upload_slots.limit, engine.upload_rate.rate, store.bot_interval), (6, 2048 * 1024, 2.5))
        store._telegram = SimpleNamespace(pool=SimpleNamespace(min_interval=1.0))
        resources.update({"bot_interval_ms": 300})
        self.assertEqual(store._telegram.pool.min_interval, 0.3, "已建立的 Bot 池立即使用新间隔")
        store._telegram = None
        user = asyncio.run(self.client.login("user", "alice@example.com", "alice password"))
        status, _, data = asyncio.run(self.client.request("GET", "/api/user/v1/upload-config", b"", user))
        self.assertEqual((status, json.loads(data)), (200, {"part_concurrency": 6, "file_concurrency": 3}))
        self.assertEqual(asyncio.run(self.client.request("GET", "/api/user/v1/upload-config", b"", {}))[0], 401)
        low = resources.update({"mode": "low"})["effective"]
        self.assertEqual((low["upload_concurrency"], low["web_part_concurrency"], low["upload_reduced"]), (2, 2, True))
        resources.update({"mode": "standard"})
        resources.detected.update(memory_bytes=512 * 1024 ** 2)
        self.assertEqual(resources.effective()["upload_concurrency"], 4, "每个分片约 32 MB，最多占内存的四分之一")
        for bad in ({"upload_concurrency": 0}, {"upload_kib": -1}, {"bot_interval_ms": 10001}, {"web_part_concurrency": 9},
                    {"web_file_concurrency": 5}, {"upload_kib": 1.5}):
            with self.assertRaises(ValueError):
                resources.update(bad)


if __name__ == "__main__":
    unittest.main()
