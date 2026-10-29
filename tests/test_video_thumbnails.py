"""用真实 FFmpeg 验证视频选帧；解码器可选，不依赖外网或 Telegram。"""

import asyncio
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.keystore import KeyStore
from tgdrive.metadata import Metadata
from tgdrive.objects import ObjectService, Scope
from tgdrive.thumbnails import ThumbnailError, ThumbnailService, video_frame_usable


def decoder():
    executable = shutil.which("ffmpeg")
    if executable:
        return executable
    try:
        import imageio_ffmpeg  # 可选的本地验证运行时，不是服务依赖。
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        return None


FFMPEG = decoder()


@unittest.skipUnless(FFMPEG, "本机没有可用的 FFmpeg")
class VideoDecoderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.metadata = Metadata()
        self.keys = KeyStore(self.metadata)
        self.keys.initialize("test passphrase")
        self.engine = BlobEngine(self.metadata, LocalDiskBlobStore(self.directory / "store"), keystore=self.keys,
                                 chunk_size=64 * 1024, frame_size=4096)
        self.objects = ObjectService(self.metadata, self.engine)
        self.scope = Scope(self.objects.create_bucket("video-tests"))
        self.worker = ThumbnailService(SimpleNamespace(keystore=self.keys), self.objects,
                                       SimpleNamespace(ffmpeg=FFMPEG, detected={"memory_bytes": 1024**3}, pressure=lambda: None))

    async def asyncTearDown(self):
        await self.worker.stop()
        self.metadata.close()
        self.temp.cleanup()

    async def ffmpeg(self, *options, data=None):
        process = await asyncio.create_subprocess_exec(FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *options,
            stdin=asyncio.subprocess.PIPE if data is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        output, error = await asyncio.wait_for(process.communicate(data), 20)
        self.assertEqual(process.returncode, 0, error.decode(errors="replace"))
        return output

    async def clip(self, name, intro, *, body=True):
        target = self.directory / (name + ".mkv")
        graph = f"{intro}[intro];testsrc2=s=320x180:r=8:d=2[body];[intro][body]concat=n=2:v=1:a=0[out]" if body else intro + "[out]"
        await self.ffmpeg("-filter_complex", graph, "-map", "[out]", "-c:v", "ffv1", str(target))
        return await self.objects.put_object(self.scope, target.name, target.read_bytes(), content_type="video/x-matroska")

    async def test_regeneration_skips_black_white_and_mostly_blank_intros(self):
        samples = {
            "black": "color=c=black:s=320x180:r=8:d=2",
            "white": "color=c=white:s=320x180:r=8:d=2",
            "mostly-black": "color=c=black:s=320x180:r=8:d=2,drawbox=x=100:y=60:w=120:h=60:color=white:t=fill",
            "mostly-white": "color=c=white:s=320x180:r=8:d=2,drawbox=x=100:y=60:w=120:h=60:color=black:t=fill",
            "gray": "color=c=gray:s=320x180:r=8:d=2",
        }
        original = self.engine.store.get
        guard = AsyncMock(side_effect=AssertionError("自动截帧不能额外回源"))
        for name, intro in samples.items():
            with self.subTest(intro=name):
                info = await self.clip(name, intro)
                old = b"\xff\xd8\xff\xe0old-thumbnail"
                await self.objects.set_thumbnail(self.scope, info.key, old)
                # 只在截帧期间禁止回源；缩略图存为系统区对象，读回结果本身需要读取存储。
                self.engine.store.get = guard
                try:
                    await self.worker.generate(info, force=True)
                finally:
                    self.engine.store.get = original
                image, mime, _ = await self.objects.get_thumbnail(self.scope, info.key)
                self.assertNotEqual(image, old)
                self.assertEqual(mime, "image/jpeg")
                pixels = await self.ffmpeg("-i", "pipe:0", "-vf", "scale=32:32:out_range=full", "-frames:v", "1",
                                           "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1", data=image)
                self.assertEqual(len(pixels), 1024)
                self.assertTrue(video_frame_usable(pixels), name)
        guard.assert_not_awaited()

    async def test_short_blank_video_keeps_old_thumbnail_and_reports_no_suitable_frame(self):
        info = await self.clip("blank", "color=c=white:s=320x180:r=8:d=0.5", body=False)
        old = b"\xff\xd8\xff\xe0old-thumbnail"
        await self.objects.set_thumbnail(self.scope, info.key, old)
        with self.assertRaisesRegex(ThumbnailError, "未替换现有缩略图"):
            await self.worker.generate(info, force=True)
        self.assertEqual((await self.objects.get_thumbnail(self.scope, info.key))[0], old)
