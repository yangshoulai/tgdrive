"""直链下载到分片 MP4 时转成普通 MP4（moov 在前、无 moof）；普通 MP4 原样保存。需要本机 FFmpeg 生成样本，没有时跳过。"""

import asyncio
import shutil
import struct
import subprocess
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.objects import Scope
from tgdrive.offline.mp4 import is_fragmented
from tgdrive.offline.service import _stored_type

FFMPEG = shutil.which("ffmpeg")


def top_boxes(data: bytes) -> list[bytes]:
    boxes, position = [], 0
    while position + 8 <= len(data):
        size, kind = struct.unpack(">I4s", data[position:position + 8])
        boxes.append(kind)
        position += size
    return boxes


class BytesResponse:
    def __init__(self, request, data: bytes):
        self.url, self.status, self.size, self.data = request.url, 200, len(data), data
        self.headers = {"etag": '"v1"', "content-type": "application/octet-stream"}

    async def stream(self):
        for start in range(0, len(self.data), 65536):
            await asyncio.sleep(0)
            yield self.data[start:start + 65536]


class BytesHttp:
    def __init__(self, data: bytes):
        self.data = data

    @asynccontextmanager
    async def open(self, request, **kwargs):
        yield BytesResponse(request, self.data)


class StoredTypeTests(unittest.TestCase):
    def test_audio_names_are_not_saved_as_video(self):
        self.assertTrue(_stored_type("music/以父之名.flac", "video/x-flac").startswith("audio/"))
        self.assertTrue(_stored_type("a.mp3", "application/octet-stream").startswith("audio/"))
        self.assertEqual(_stored_type("a.mp4", "video/mp4"), "video/mp4")
        self.assertEqual(_stored_type("a.flac", "audio/flac"), "audio/flac")


@unittest.skipUnless(FFMPEG, "需要 FFmpeg 生成分片 MP4 样本")
class FragmentedDownloadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(self.temp.name, secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.offline = self.app.offline

    async def asyncTearDown(self):
        await self.offline.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    def sample(self, *flags: str) -> bytes:
        path = Path(self.temp.name) / "sample.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=3",
                        "-f", "lavfi", "-i", "sine=duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
                        "-shortest", *flags, str(path)], check=True)
        return path.read_bytes()

    async def download(self, data: bytes) -> bytes:
        self.offline.http = BytesHttp(data)
        parsed = await self.offline.parse(self.alice.id, "https://example.com/video.mp4")
        task = self.offline.create(self.alice.id, [{"ticket": parsed["candidates"][0]["ticket"], "name": "video.mp4"}], "downloads/")[0]
        self.offline.start()
        async with asyncio.timeout(30):
            while self.offline._row(task["id"])["status"] not in ("completed", "failed"):
                await asyncio.sleep(0.02)
        row = self.offline._row(task["id"])
        self.assertEqual(row["status"], "completed", row["error"])
        info, chunks = await self.app.objects.get_object(Scope(self.alice.bucket_id), "downloads/video.mp4")
        return b"".join([chunk async for chunk in chunks])

    async def test_fragmented_mp4_is_saved_as_regular_mp4(self):
        source = self.sample("-movflags", "frag_keyframe+empty_moov+default_base_moof")
        self.assertTrue(is_fragmented(source[:65536]))
        saved = await self.download(source)
        boxes = top_boxes(saved)
        self.assertEqual(boxes[:3], [b"ftyp", b"moov", b"mdat"], "moov 在前，后面是一整个 mdat")
        self.assertNotIn(b"moof", boxes)
        self.assertFalse(is_fragmented(saved[:65536]))
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "-"],
                               input=saved, capture_output=True, check=True)
        self.assertAlmostEqual(float(probe.stdout), 3.0, delta=0.2)

    async def test_regular_mp4_is_saved_unchanged(self):
        source = self.sample("-movflags", "+faststart")
        self.assertFalse(is_fragmented(source[:65536]))
        self.assertEqual(await self.download(source), source)


if __name__ == "__main__":
    unittest.main()
