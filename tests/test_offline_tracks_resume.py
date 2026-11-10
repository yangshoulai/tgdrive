"""平台分离音视频轨按整条轨续传（offline/platforms.merge_tracks 的 resume_dir）。"""
import asyncio
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tgdrive.offline import platforms
from tgdrive.offline.http import DownloadError

FFMPEG = os.environ.get("TGDRIVE_TEST_FFMPEG") or shutil.which("ffmpeg")


@unittest.skipUnless(FFMPEG, "需要 FFmpeg 验证真实合并")
class TrackResumeTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25", "-t", "2",
                        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(root / "v.mp4")], check=True)
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=800", "-t", "2",
                        "-c:a", "aac", str(root / "a.m4a")], check=True)
        cls.video, cls.audio = (root / "v.mp4").read_bytes(), (root / "a.m4a").read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    async def run_merge(self, entry, resume_dir, fail_audio):
        calls = []
        def fake_stream(client, platform, track, *, on_size=None, connections=1):
            calls.append(platforms.track_identity(track))
            body = self.video if track["extension"] == "mp4" else self.audio
            async def generate():
                on_size(len(body))
                for start in range(0, len(body), 4096):
                    if fail_audio and track["extension"] == "m4a" and start > len(body) // 2:
                        raise DownloadError("来源中断")
                    await asyncio.sleep(0)
                    yield body[start:start + 4096]
            return generate()
        async def throttle(_):
            pass
        with patch.object(platforms, "track_stream", fake_stream):
            stream = platforms.merge_tracks(None, "youtube", entry, FFMPEG, Path(self.temp.name) / "cache", 1, 512 * 1024 * 1024, 0,
                                            check=lambda: None, progress=lambda **_: None, throttle=throttle, phase=lambda _: None,
                                            resume_dir=resume_dir)
            try:
                body = b"".join([piece async for piece in stream])
            finally:
                await stream.aclose()
        return calls, body

    async def test_completed_track_is_reused_after_interruption(self):
        entry = {"tracks": [{"url": "https://rr.googlevideo.com/videoplayback?itag=137&clen=1000&expire=1&sig=a", "extension": "mp4"},
                            {"url": "https://rr.googlevideo.com/videoplayback?itag=140&clen=500&expire=1&sig=b", "extension": "m4a"}]}
        resume = Path(self.temp.name) / "tracks-1"
        with self.assertRaises(DownloadError):
            await self.run_merge(entry, resume, fail_audio=True)
        # 重新解析后签名与过期时间变化，但格式编号与长度相同：视频轨直接复用，只重新下载音频轨。
        fresh = {"tracks": [{**entry["tracks"][0], "url": entry["tracks"][0]["url"].replace("sig=a", "sig=c")},
                            {**entry["tracks"][1], "url": entry["tracks"][1]["url"].replace("sig=b", "sig=d")}]}
        calls, body = await self.run_merge(fresh, resume, fail_audio=False)
        self.assertEqual(calls, ["itag=140;clen=500"])
        output = Path(self.temp.name) / "merged.mp4"
        output.write_bytes(body)
        decoded = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(output), "-f", "null", "-"], capture_output=True)
        self.assertEqual(decoded.returncode, 0, decoded.stderr.decode(errors="replace"))
        # 换了清晰度（格式编号不同）不能复用旧轨。
        other = {"tracks": [{**fresh["tracks"][0], "url": fresh["tracks"][0]["url"].replace("itag=137", "itag=136")}, fresh["tracks"][1]]}
        calls, _ = await self.run_merge(other, resume, fail_audio=False)
        self.assertEqual(calls, ["itag=136;clen=1000"])


if __name__ == "__main__":
    unittest.main()
