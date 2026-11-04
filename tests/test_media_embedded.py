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

    async def extract(self, key, data, content_type):
        info = await self.app.objects.put_object(self.scope, key, data, len(data), content_type)
        media = await self.app.media.info(self.scope, key)
        self.assertEqual(len(media["subtitles"]), 1)
        stream = media["subtitles"][0]
        self.assertTrue(stream["text"])
        self.assertEqual(stream["language"], "chi")
        job = await self.app.media.extract(self.scope, key, info.etag, stream["index"])
        for _ in range(300):
            [job] = self.app.media.jobs(self.scope, [job["id"]])
            if job["state"] in ("done", "failed"):
                break
            await asyncio.sleep(0.1)
        self.assertEqual(job["state"], "done", job)
        text = self.app.media.embedded_subtitle(self.scope, key, info.etag, stream["index"])
        self.assertIn("WEBVTT", text)
        self.assertIn("第一句字幕", text)
        self.assertIn("Second line", text)
        again = await self.app.media.extract(self.scope, key, info.etag, stream["index"])
        self.assertEqual(again["state"], "done")
        refreshed = await self.app.media.info(self.scope, key)
        self.assertTrue(refreshed["subtitles"][0]["extracted"])

    async def test_mp4_mov_text(self):
        if self.app.resources.ffmpeg is None:
            self.skipTest("应用没有检测到 FFmpeg")
        await self.extract("视频/a.mp4", sample(self.temp.name, "mp4", "mov_text"), "video/mp4")

    async def test_mkv_srt(self):
        if self.app.resources.ffmpeg is None:
            self.skipTest("应用没有检测到 FFmpeg")
        await self.extract("视频/b.mkv", sample(self.temp.name, "mkv", "srt"), "video/x-matroska")

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
