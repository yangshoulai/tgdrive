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
from tgdrive.offline.resources import MIB, ResourceSettings
from tgdrive.work import Limiter, RateLimiter


class ResourceBudgetTests(unittest.TestCase):
    """只计算资源预算，不初始化应用、数据库或外部组件。"""

    def effective(self, memory=750 * MIB, cpu=1, **config):
        resources = ResourceSettings.__new__(ResourceSettings)
        resources._config = ResourceSettings.validate(config)
        resources.detected = {"cpu_cores": cpu, "memory_bytes": memory}
        resources.ffmpeg = "/fixture/ffmpeg"
        resources.platform_tools = {"x_available": True, "youtube_available": True}
        return resources.effective()

    def parallel(self, effective):
        return tuple(effective[key] for key in ("transfer_concurrency", "bucket_concurrency", "upload_concurrency", "web_part_concurrency"))

    def test_low_defaults_allow_parallel_transfers_in_personal_deployment(self):
        effective = self.effective()
        self.assertEqual((effective["mode"], effective["concurrency"], effective["ffmpeg_concurrency"]), ("low", 1, 1))
        self.assertEqual(self.parallel(effective), (4, 2, 4, 4))
        self.assertFalse(effective["transfer_reduced"] or effective["upload_reduced"])
        self.assertEqual((effective["web_file_concurrency"], effective["bot_interval_ms"], effective["platform_max_mib"]), (2, 1000, 512))

    def test_explicit_low_mode_still_caps_higher_admin_limits(self):
        effective = self.effective(memory=8192 * MIB, cpu=4, mode="low", transfer_concurrency=16,
                                   bucket_concurrency=16, upload_concurrency=16, web_part_concurrency=8)
        self.assertEqual(self.parallel(effective), (4, 2, 4, 4))
        self.assertTrue(effective["transfer_reduced"] and effective["upload_reduced"])

    def test_small_or_unknown_memory_keeps_conservative_limits(self):
        for memory, expected in ((None, (2, 1, 2, 2)), (128, (2, 1, 1, 1)), (256, (2, 1, 2, 2)),
                                 (511, (2, 1, 2, 2)), (512, (4, 2, 4, 4))):
            with self.subTest(memory=memory):
                effective = self.effective(memory=memory * MIB if memory else None)
                self.assertEqual(self.parallel(effective), expected)
                self.assertEqual(effective["concurrency"], 1)

    def test_lower_admin_limits_are_preserved(self):
        effective = self.effective(transfer_concurrency=2, bucket_concurrency=1, upload_concurrency=1, web_part_concurrency=1)
        self.assertEqual(self.parallel(effective), (2, 1, 1, 1))
        self.assertFalse(effective["transfer_reduced"] or effective["upload_reduced"])

    def test_standard_and_custom_memory_budgets_remain_unchanged(self):
        config = {"transfer_concurrency": 8, "bucket_concurrency": 3, "upload_concurrency": 6, "web_part_concurrency": 6}
        standard = self.effective(memory=8192 * MIB, cpu=4, **config)
        self.assertEqual((standard["mode"], standard["concurrency"]), ("standard", 2))
        self.assertEqual(self.parallel(standard), (8, 3, 6, 6))
        custom = self.effective(memory=512 * MIB, cpu=4, mode="custom", **config)
        self.assertEqual(self.parallel(custom), (5, 3, 4, 6))


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
        saved = resources.update({"mode": "auto", "upload_concurrency": 6, "upload_kib": 2048, "bot_interval_ms": 2500,
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
        self.assertEqual((low["upload_concurrency"], low["web_part_concurrency"], low["upload_reduced"]), (4, 4, True))
        # 自定义模式不按低资源档收紧，只按检测到的内存留余量（自动模式在 1 GB 以下会选低资源档）。
        resources.update({"mode": "custom"})
        resources.detected.update(memory_bytes=512 * 1024 ** 2)
        self.assertEqual(resources.effective()["upload_concurrency"], 4, "每个分片约 32 MB，最多占内存的四分之一")
        for bad in ({"upload_concurrency": 0}, {"upload_kib": -1}, {"bot_interval_ms": 10001}, {"web_part_concurrency": 9},
                    {"web_file_concurrency": 5}, {"upload_kib": 1.5}):
            with self.assertRaises(ValueError):
                resources.update(bad)


if __name__ == "__main__":
    unittest.main()
