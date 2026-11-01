"""音频的响应类型：存成 video/x-flac、通用二进制或非标准别名的音乐按扩展名返回标准音频 MIME 并内联播放。
iOS 的 Safari／Chrome 按 Content-Type 判断 <audio> 能否播放，不嗅探内容。"""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote

from tgdrive.app import create_app
from tgdrive.filekinds import served_type
from tgdrive.objects import Scope
from tests.test_public_links import Client


class ServedTypeTests(unittest.TestCase):
    def test_audio_extensions_get_standard_types(self):
        self.assertEqual(served_type("歌/以父之名.flac", "video/x-flac"), "audio/flac")
        self.assertEqual(served_type("a.FLAC", "audio/x-flac"), "audio/flac")
        self.assertEqual(served_type("a.mp3", "application/octet-stream"), "audio/mpeg")
        self.assertEqual(served_type("a.m4a", None), "audio/mp4")
        self.assertEqual(served_type("a.mp3", "audio/mpeg; charset=binary"), "audio/mpeg")

    def test_other_files_keep_their_type(self):
        self.assertEqual(served_type("a.mp4", "video/mp4"), "video/mp4")
        self.assertEqual(served_type("notes.txt", "text/plain"), "text/plain")
        self.assertEqual(served_type("flac/readme", "application/octet-stream"), "application/octet-stream")


class AudioResponseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.client = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def test_mislabeled_flac_is_served_as_audio_inline(self):
        data = b"fLaC" + b"\0" * 60
        asyncio.run(self.app.objects.put_object(Scope(self.alice.bucket_id), "音乐/以父之名.flac", data, len(data), "video/x-flac"))
        auth = asyncio.run(self.client.login("user", "alice@example.com", "alice password"))
        status, headers, _ = asyncio.run(self.client.request("GET", "/api/user/v1/content?path=" + quote("音乐/以父之名.flac"),
                                                             headers={**auth, "range": "bytes=0-9"}))
        self.assertEqual(status, 206)
        self.assertEqual(headers["content-type"], "audio/flac")
        self.assertTrue(headers["content-disposition"].startswith("inline"))


if __name__ == "__main__":
    unittest.main()
