"""图片／视频显示尺寸：按内容记录，列表接口返回 dimensions；只写入仍是同一版本的文件；离线下载转封装时自动记录。"""

import asyncio
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote

from tgdrive.app import create_app
from tgdrive.objects import Scope
from tgdrive.offline.mp4 import video_size
from tests.test_offline_fragmented import BytesHttp
from tests.test_public_links import Client

FFMPEG = shutil.which("ffmpeg")


def sample(directory: str, *flags: str) -> bytes:
    path = Path(directory) / "sample.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", *flags, str(path)], check=True)
    return path.read_bytes()


class MediaSizeApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.alice.bucket_id)
        self.client = Client(self.app)
        self.auth = asyncio.run(self.client.login("user", "alice@example.com", "alice password"))

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def post(self, body):
        status, _, data = asyncio.run(self.client.request("POST", "/api/user/v1/media/size", json.dumps(body).encode(), self.auth))
        return status, json.loads(data)

    def listed(self):
        status, _, data = asyncio.run(self.client.request("GET", "/api/user/v1/list?prefix=" + quote("视频/"), headers=self.auth))
        return {item["key"]: item.get("dimensions") for item in json.loads(data)["objects"]}

    def test_size_is_recorded_per_content_and_version(self):
        info = asyncio.run(self.app.objects.put_object(self.scope, "视频/a.mp4", b"video-a", 7, "video/mp4"))
        asyncio.run(self.app.objects.put_object(self.scope, "视频/copy.mp4", b"video-a", 7, "video/mp4"))  # 同内容合并到同一 Blob
        self.assertEqual(self.listed(), {"视频/a.mp4": None, "视频/copy.mp4": None})
        self.assertEqual(self.post({"path": "视频/a.mp4", "etag": "stale", "width": 1920, "height": 1080}), (200, {"saved": False}))
        self.assertEqual(self.post({"path": "视频/a.mp4", "etag": info.etag, "width": 1080, "height": 1920}), (200, {"saved": True}))
        self.assertEqual(self.listed(), {"视频/a.mp4": {"width": 1080, "height": 1920}, "视频/copy.mp4": {"width": 1080, "height": 1920}})
        for bad in ({"width": 0, "height": 10}, {"width": "1920", "height": 1080}, {"width": 99999, "height": 1080}, {"width": True, "height": 1}):
            status, _ = self.post({"path": "视频/a.mp4", "etag": info.etag, **bad})
            self.assertEqual(status, 400, bad)


@unittest.skipUnless(FFMPEG, "需要 FFmpeg 生成视频样本")
class VideoSizeParseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_reads_display_size_from_moov(self):
        data = sample(self.temp.name, "-movflags", "+faststart")
        self.assertEqual(video_size(data[:65536]), (320, 180))
        self.assertIsNone(video_size(b"not an mp4"))

    async def test_offline_conversion_records_size(self):
        app = create_app(self.temp.name + "/data", secure_cookies=False, run_scheduler=False)
        try:
            app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
            alice = app.accounts.create_user("alice@example.com", "alice password")
            app.offline.http = BytesHttp(sample(self.temp.name, "-movflags", "frag_keyframe+empty_moov+default_base_moof"))
            parsed = await app.offline.parse(alice.id, "https://example.com/video.mp4")
            task = app.offline.create(alice.id, [{"ticket": parsed["candidates"][0]["ticket"], "name": "video.mp4"}], "downloads/")[0]
            app.offline.start()
            async with asyncio.timeout(30):
                while app.offline._row(task["id"])["status"] not in ("completed", "failed"):
                    await asyncio.sleep(0.02)
            info = app.objects.head_object(Scope(alice.bucket_id), "downloads/video.mp4")
            self.assertEqual(app.objects.media_sizes([info.blob_uuid]), {info.blob_uuid: (320, 180)})
        finally:
            await app.offline.stop()
            app.metadata.close()


if __name__ == "__main__":
    unittest.main()
