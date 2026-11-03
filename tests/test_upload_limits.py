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
        # 个人部署：低资源档也允许每个账号用满读取名额（不再减半），离线下载默认同时 3 个（自定义可到 4 个）。
        self.assertEqual((effective["mode"], effective["concurrency"], effective["ffmpeg_concurrency"]), ("low", 3, 1))
        self.assertEqual(self.effective(mode="custom", concurrency=4)["concurrency"], 4)
        self.assertEqual(self.parallel(effective), (8, 6, 4, 4))
        self.assertFalse(effective["transfer_reduced"] or effective["upload_reduced"])
        self.assertEqual((effective["web_file_concurrency"], effective["bot_interval_ms"], effective["platform_max_mib"]), (2, 1000, 512))

    def test_explicit_low_mode_still_caps_higher_admin_limits(self):
        effective = self.effective(memory=8192 * MIB, cpu=4, mode="low", transfer_concurrency=16,
                                   bucket_concurrency=16, upload_concurrency=16, web_part_concurrency=8)
        self.assertEqual(self.parallel(effective), (8, 8, 8, 8))
        self.assertTrue(effective["transfer_reduced"] and effective["upload_reduced"])

    def test_small_or_unknown_memory_keeps_conservative_limits(self):
        # 读取每路约 24 MB、写入每路约 32 MB，最多各占内存的三分之一；不足 512 MiB 或未知时读写最多 3 路。
        for memory, expected in ((None, (3, 3, 3, 3)), (128, (2, 2, 1, 1)), (256, (3, 3, 2, 2)),
                                 (511, (3, 3, 3, 3)), (512, (7, 6, 4, 4))):
            with self.subTest(memory=memory):
                effective = self.effective(memory=memory * MIB if memory else None)
                self.assertEqual(self.parallel(effective), expected)
                self.assertEqual(effective["concurrency"], 3 if memory and memory >= 512 else 2 if memory else 1)
                self.assertEqual(self.effective(memory=memory * MIB if memory else None, mode="custom", concurrency=4)["concurrency"], 3 if memory == 512 else 2 if memory else 1)

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
        self.assertEqual(self.parallel(custom), (7, 3, 5, 6))


    def test_raised_limits_and_memory_ceiling_for_offline_tasks(self):
        # 1 GiB 以上的机器：离线下载按每个任务约 64 MB、默认最多占内存 60% 封顶，最多 16 个。
        for memory, expected in ((1024, 9), (2048, 16), (16384, 16)):
            with self.subTest(memory=memory):
                self.assertEqual(self.effective(memory=memory * MIB, cpu=4, mode="custom", concurrency=16, download_connections=1)["concurrency"], expected)
        self.assertTrue(self.effective(memory=1024 * MIB, cpu=4, mode="custom", concurrency=16, download_connections=1)["reduced"])
        # 封顶比例可配置（10%–80%）。
        for percent, expected in ((80, 12), (30, 4), (10, 1)):
            with self.subTest(percent=percent):
                self.assertEqual(self.effective(memory=1024 * MIB, cpu=4, mode="custom", concurrency=16, download_connections=1,
                                                download_memory_percent=percent)["concurrency"], expected)
        # 每多一个连接，任务按多 32 MiB 估算：默认 4 个连接时每个任务约 160 MiB（2 GiB 7 个、4 GiB 15 个、8 GiB 起 16 个）。
        for connections, memory, expected in ((4, 2048, 7), (4, 4096, 15), (4, 8192, 16), (8, 2048, 4)):
            with self.subTest(connections=connections, memory=memory):
                effective = self.effective(memory=memory * MIB, cpu=1, mode="custom", concurrency=16, download_connections=connections)
                self.assertEqual((effective["concurrency"], effective["download_connections"]), (expected, connections))
        self.assertEqual(self.effective(memory=750 * MIB, mode="custom", download_connections=8)["download_connections"], 2,
                         "内存不足 1 GiB 时每个任务最多 2 个连接")
        for bad in (0, 9):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.effective(download_connections=bad)
        for bad in (9, 81, 60.5, True):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.effective(download_memory_percent=bad)
        # 内存不足 1 GiB 仍按原来的分档，不受比例影响。
        self.assertEqual(self.effective(memory=750 * MIB, mode="custom", concurrency=16, download_memory_percent=80)["concurrency"], 4)
        # 单核但内存充足：下载上限只看内存，不因核数少而固定在 4 个。
        self.assertEqual(self.effective(memory=2048 * MIB, cpu=1, mode="custom", concurrency=16, download_connections=1)["concurrency"], 16)
        self.assertEqual(self.effective(memory=1024 * MIB, cpu=1, mode="custom", concurrency=16, download_connections=1)["concurrency"], 9)
        raised = self.effective(memory=16384 * MIB, cpu=8, mode="custom", transfer_concurrency=32, bucket_concurrency=32,
                                upload_concurrency=32, web_part_concurrency=16, web_file_concurrency=8, thumbnail_concurrency=32)
        self.assertEqual(self.parallel(raised), (32, 32, 32, 16))
        self.assertEqual((raised["web_file_concurrency"], raised["thumbnail_concurrency"]), (8, 32))

    def test_platform_cache_follows_setting_on_single_core_and_low_mode(self):
        # 平台临时缓存在磁盘上，单核或低资源档都按管理员设置生效，不再压到 512 MiB。
        for mode in ("auto", "low", "custom"):
            with self.subTest(mode=mode):
                effective = self.effective(memory=750 * MIB, cpu=1, mode=mode, youtube_enabled=True, platform_max_mib=4096)
                self.assertEqual((effective["platform_max_mib"], effective["cache_mib"]), (4096, 4096))

    def test_video_concurrency_setting(self):
        self.assertEqual(self.effective(memory=2048 * MIB, cpu=1, mode="custom", concurrency=8)["ffmpeg_concurrency"], 2, "默认同时封装 2 个")
        self.assertEqual(self.effective(memory=2048 * MIB, cpu=1, mode="custom", concurrency=8, video_concurrency=4)["video_concurrency"], 4)
        self.assertEqual(self.effective(memory=2048 * MIB, cpu=1, mode="custom", concurrency=1, video_concurrency=4)["ffmpeg_concurrency"], 1,
                         "不超过同时下载的任务数")
        self.assertEqual(self.effective(memory=750 * MIB, mode="custom", concurrency=4, video_concurrency=4)["ffmpeg_concurrency"], 1,
                         "内存不足 1 GiB 时只封装 1 个")
        for bad in (0, 5):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.effective(video_concurrency=bad)

    def test_thumbnail_concurrency_defaults_and_small_machines(self):
        self.assertEqual(self.effective(memory=8192 * MIB, cpu=4)["thumbnail_concurrency"], 16)
        self.assertEqual(self.effective()["thumbnail_concurrency"], 16, "512 MiB 以上的低资源机器不收紧")
        self.assertEqual(self.effective(memory=256 * MIB)["thumbnail_concurrency"], 3, "内存很小时按低资源档收紧")


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

    def test_legacy_read_defaults_upgrade_once(self):
        # 1.38 之前默认每账号 2 路读取：仍是旧默认值的配置升级为新默认值，管理员改过的值和之后再设的值不受影响。
        metadata, data_dir = self.app.metadata, self.app.resources.data_dir
        def stored(value):
            with metadata.transaction() as db:
                db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (ResourceSettings.KEY, json.dumps(value)))
                db.execute("DELETE FROM settings WHERE key=?", (ResourceSettings.READ_UPGRADE_KEY,))
        stored({"mode": "auto", "transfer_concurrency": 4, "bucket_concurrency": 2})
        upgraded = ResourceSettings(metadata, data_dir).config()
        self.assertEqual((upgraded["transfer_concurrency"], upgraded["bucket_concurrency"]), (8, 6))
        stored({"mode": "auto", "transfer_concurrency": 4, "bucket_concurrency": 3})
        kept = ResourceSettings(metadata, data_dir).config()
        self.assertEqual((kept["transfer_concurrency"], kept["bucket_concurrency"]), (4, 3))
        resources = ResourceSettings(metadata, data_dir)
        resources.update({"transfer_concurrency": 4, "bucket_concurrency": 2})
        again = ResourceSettings(metadata, data_dir).config()
        self.assertEqual((again["transfer_concurrency"], again["bucket_concurrency"]), (4, 2), "升级只做一次")

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
        self.assertEqual((status, json.loads(data)), (200, {"part_concurrency": 6, "file_concurrency": 3, "read_concurrency": 6}))
        self.assertEqual(asyncio.run(self.client.request("GET", "/api/user/v1/upload-config", b"", {}))[0], 401)
        low = resources.update({"mode": "low"})["effective"]
        # 低资源档在内存充足时最多 8 路，管理员设的 6 路不再被收紧。
        self.assertEqual((low["upload_concurrency"], low["web_part_concurrency"], low["upload_reduced"]), (6, 6, False))
        # 自定义模式不按低资源档收紧，只按检测到的内存留余量（自动模式在 1 GB 以下会选低资源档）。
        resources.update({"mode": "custom"})
        resources.detected.update(memory_bytes=512 * 1024 ** 2)
        self.assertEqual(resources.effective()["upload_concurrency"], 5, "每个分片约 32 MB，最多占内存的三分之一")
        for bad in ({"upload_concurrency": 0}, {"upload_kib": -1}, {"bot_interval_ms": 10001}, {"web_part_concurrency": 17},
                    {"web_file_concurrency": 9}, {"upload_kib": 1.5}):
            with self.assertRaises(ValueError):
                resources.update(bad)


if __name__ == "__main__":
    unittest.main()
