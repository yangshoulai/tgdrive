"""封面缓存（ThumbnailCache）的容量设置：可配置总量、单个文件上限、调小时淘汰、磁盘不足时不缓存、放在数据目录下。"""

import os
import tempfile
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.thumbnail_cache import MIB, ThumbnailCache


class ThumbnailCacheSizeTests(unittest.TestCase):
    def test_configure_sets_total_and_per_file_limits_and_evicts(self):
        cache = ThumbnailCache()
        cache.configure(1024)
        self.assertEqual((cache.limit, cache.per_blob), (1024 * MIB, 256 * MIB + MIB))
        cache.configure(256)
        self.assertEqual(cache.per_blob, 64 * MIB + MIB, "单个文件最多占总量的四分之一")
        cache.configure(8192)
        self.assertEqual(cache.per_blob, 256 * MIB + MIB, "单个文件最多 256 MiB")
        cache.configure(128)
        for index in range(3):
            cache.prepare(f"b{index}", f"p{index}.jpg", "image/jpeg")
            cache.put(f"b{index}", "r", 0, b"x" * (30 * MIB))
        self.assertEqual(cache.status()["bytes"], 90 * MIB)
        cache.configure(64)
        self.assertLessEqual(cache.status()["bytes"], 64 * MIB, "调小后立即淘汰最早的数据")
        cache.close()

    def test_skips_caching_when_disk_is_low_and_uses_given_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "thumbnail-cache"
            cache = ThumbnailCache(directory=target, reserve=lambda: 1 << 62)
            self.assertTrue(target.is_dir())
            cache.prepare("b", "a.jpg", "image/jpeg")
            cache.put("b", "r", 0, b"data")
            self.assertEqual(cache.status()["bytes"], 0, "剩余空间低于保留值时不缓存")
            cache.reserve = lambda: 0
            cache.put("b", "r", 0, b"data")
            self.assertEqual(cache.get("b", "r", 0, 4), b"data")
            cache.close()

    def test_app_puts_cache_in_data_dir_and_applies_setting(self):
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(Path(directory) / "data", secure_cookies=False, run_scheduler=False)
            cache = app.user.objects.thumbnail_service.cache
            self.assertEqual(Path(cache.directory).resolve(), (Path(directory) / "data" / "thumbnail-cache").resolve())
            self.assertEqual(cache.limit, 1024 * MIB, "默认 1024 MiB")
            app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
            app.resources.update({"thumbnail_cache_mib": 2048})
            self.assertEqual(cache.limit, 2048 * MIB, "保存后立即生效")
            for bad in (127, 8193):
                with self.subTest(bad=bad), self.assertRaises(ValueError):
                    app.resources.update({"thumbnail_cache_mib": bad})
            app.metadata.close()


if __name__ == "__main__":
    unittest.main()
