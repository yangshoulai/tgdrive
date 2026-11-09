"""内嵌字幕轨：解析容器里的字幕轨，并用 FFmpeg 经回环地址按范围读取原文件提取成 WebVTT。没有 FFmpeg 时跳过。"""

import asyncio
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.objects import Scope

FFMPEG = shutil.which("ffmpeg")
SRT = "1\n00:00:00,200 --> 00:00:01,500\n第一句字幕\n\n2\n00:00:01,600 --> 00:00:02,800\nSecond line\n"


def sample(directory: str, extension: str, codec: str) -> bytes:
    folder = Path(directory)
    (folder / "sub.srt").write_text(SRT, encoding="utf-8")
    output = folder / f"sample.{extension}"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=3", "-i", str(folder / "sub.srt"),
                    "-map", "0:v", "-map", "1:s", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:s", codec,
                    "-metadata:s:s:0", "language=chi", str(output)], check=True)
    return output.read_bytes()


@unittest.skipUnless(FFMPEG, "需要 FFmpeg")
class EmbeddedSubtitleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.alice.bucket_id)
        self.app.media.resources = self.app.resources

    async def asyncTearDown(self):
        await self.app.media.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    async def wait_job(self, key, job):
        for _ in range(400):
            if job["state"] not in ("queued", "running"):
                break
            await asyncio.sleep(0.05)
            job = self.app.media.jobs(self.scope, [job["id"]])[0]
        self.assertEqual(job["state"], "done", job["detail"])

    async def extract(self, key, data, content_type):
        info = await self.app.objects.put_object(self.scope, key, data, len(data), content_type)
        self.app.media.start()
        for _ in range(200):
            row = self.app.objects.file_metadata.row(info.metadata_id)
            if row["state"] == "ready":
                break
            if row["state"] == "partial":
                self.fail(row["detail"])
            await asyncio.sleep(0.05)
        self.assertEqual(row["state"], "ready")
        # 首次解析只读标签：不提取字幕、不回源读整个视频；播放时内置字幕轨作为回退来源列出。
        self.assertEqual(self.app.objects.preview_assets(self.scope, key), [])
        media = await self.app.media.info(self.scope, key)
        self.assertEqual([(item["index"], item["language"]) for item in media["embedded_subtitles"]], [(0, "chi")])
        await self.wait_job(key, await self.app.media.extract(self.scope, key, info.etag, 0))
        self.assertIn("第一句字幕", self.app.media.embedded_subtitle(self.scope, key, info.etag, 0))
        # 按需提取后保存为元数据资源，下次播放不再回源；回退列表随之清空。
        assets = self.app.objects.preview_assets(self.scope, key)
        self.assertEqual(len(assets), 1)
        self.assertEqual((assets[0]["source"], assets[0]["language"]), ("metadata", "chi"))
        data, mime, _ = await self.app.objects.file_metadata.read_asset(self.scope, key, assets[0]["id"])
        self.assertIn("WEBVTT", data.decode())
        self.assertIn("第一句字幕", data.decode())
        self.assertIn("Second line", data.decode())
        self.assertEqual((await self.app.media.info(self.scope, key))["embedded_subtitles"], [])
        self.assertEqual(self.app.objects.head_object(self.scope, key).blob_uuid, info.blob_uuid)

    async def test_mp4_mov_text(self):
        if self.app.resources.ffmpeg is None:
            self.skipTest("应用没有检测到 FFmpeg")
        await self.extract("视频/a.mp4", sample(self.temp.name, "mp4", "mov_text"), "video/mp4")

    async def test_mkv_srt(self):
        if self.app.resources.ffmpeg is None:
            self.skipTest("应用没有检测到 FFmpeg")
        await self.extract("视频/b.mkv", sample(self.temp.name, "mkv", "srt"), "video/x-matroska")

    async def test_all_languages_are_extracted_in_one_pass_with_native_fields(self):
        from unittest.mock import patch
        from tgdrive.media.service import FileAccess
        folder = Path(self.temp.name)
        (folder / "zh.srt").write_text(SRT, encoding="utf-8")
        (folder / "en.srt").write_text(SRT.replace("第一句字幕", "English"), encoding="utf-8")
        path = folder / "multi.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "color=s=160x90:d=3", "-i", str(folder / "zh.srt"), "-i", str(folder / "en.srt"),
                        "-map", "0:v", "-map", "1:s", "-map", "2:s", "-c:v", "libx264", "-c:s", "mov_text", "-metadata:s:s:0", "language=chi",
                        "-metadata:s:s:1", "language=eng", "-movflags", "use_metadata_tags", "-metadata", "director=中文导演", "-metadata", "actors=演员甲、演员乙", str(path)], check=True)
        info = await self.app.objects.put_object(self.scope, path.name, path.read_bytes(), content_type="video/mp4")
        info, _ = await self.app.media.ensure_metadata(self.scope, info.key)
        tags = await self.app.media._parsed(FileAccess(self.app.media, self.scope, info))
        self.assertEqual(tags.extra["director"], "中文导演")
        self.assertEqual(tags.extra["actors"], "演员甲、演员乙")
        self.assertEqual(self.app.objects.preview_assets(self.scope, info.key), [])
        create = asyncio.create_subprocess_exec
        with patch("asyncio.create_subprocess_exec", wraps=create) as launch:
            await self.wait_job(info.key, await self.app.media.extract(self.scope, info.key, info.etag, 1))
            # 其他语言在同一次读取里已经提取，再请求不会启动新的 FFmpeg。
            await self.wait_job(info.key, await self.app.media.extract(self.scope, info.key, info.etag, 0))
        self.assertEqual(launch.call_count, 1)
        self.assertEqual({item["language"] for item in self.app.objects.preview_assets(self.scope, info.key)}, {"chi", "eng"})
        self.assertEqual(self.app.objects.head_object(self.scope, info.key).etag, info.etag)

    async def test_rejects_wrong_track_and_version(self):
        if self.app.resources.ffmpeg is None:
            self.skipTest("应用没有检测到 FFmpeg")
        data = sample(self.temp.name, "mkv", "srt")
        info = await self.app.objects.put_object(self.scope, "视频/c.mkv", data, len(data), "video/x-matroska")
        with self.assertRaises(ValueError):
            await self.app.media.extract(self.scope, "视频/c.mkv", info.etag, 5)
        with self.assertRaises(ValueError):
            await self.app.media.extract(self.scope, "视频/c.mkv", "stale", 0)


if __name__ == "__main__":
    unittest.main()
