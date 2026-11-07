"""跨文件夹浏览（GET /api/user/v1/library）与照片拍摄时间（exif.py）。"""
import asyncio
import json
import struct
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from tests.test_public_links import Client
from tgdrive import exif
from tgdrive.app import create_app
from tgdrive.objects import Scope


def exif_jpeg(taken: str, offset: str | None = None, order: str = "<") -> bytes:
    """最小的带 EXIF 的 JPEG：IFD0 指向 Exif 子目录，子目录里有 DateTimeOriginal（和可选的时区）。"""
    mark = b"II" if order == "<" else b"MM"
    entries = [(exif.DATETIME_ORIGINAL, taken.encode() + b"\x00")] + ([(exif.OFFSET_ORIGINAL, offset.encode() + b"\x00")] if offset else [])
    ifd0_at = 8
    sub_at = ifd0_at + 2 + 12 + 4
    data_at = sub_at + 2 + 12 * len(entries) + 4
    tiff = mark + struct.pack(order + "HI", 42, ifd0_at)
    tiff += struct.pack(order + "H", 1) + struct.pack(order + "HHII", exif.EXIF_IFD, 4, 1, sub_at) + struct.pack(order + "I", 0)
    blob, sub = b"", struct.pack(order + "H", len(entries))
    for tag, value in entries:
        sub += struct.pack(order + "HHII", tag, 2, len(value), data_at + len(blob))
        blob += value
    tiff += sub + struct.pack(order + "I", 0) + blob
    app1 = b"Exif\x00\x00" + tiff
    return b"\xff\xd8" + b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1 + b"\xff\xda" + b"\x00" * 64


class ExifTests(unittest.TestCase):
    def test_reads_datetime_original_in_both_byte_orders(self):
        expected = datetime(2023, 8, 15, 18, 30, 5, tzinfo=timezone.utc).timestamp()
        self.assertEqual(exif.taken_at(exif_jpeg("2023:08:15 18:30:05")), expected)
        self.assertEqual(exif.taken_at(exif_jpeg("2023:08:15 18:30:05", order=">")), expected)

    def test_uses_offset_when_present(self):
        self.assertEqual(exif.taken_at(exif_jpeg("2023:08:15 18:30:05", "+08:00")),
                         datetime(2023, 8, 15, 10, 30, 5, tzinfo=timezone.utc).timestamp())

    def test_rejects_non_photos_and_bad_dates(self):
        self.assertIsNone(exif.taken_at(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100))
        self.assertIsNone(exif.taken_at(exif_jpeg("0000:00:00 00:00:00")))
        self.assertIsNone(exif.taken_at(b"\xff\xd8\xff\xe1\x00"))


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.alice.bucket_id)
        self.client = Client(self.app)
        self.session = asyncio.run(self.client.login("user", "alice@example.com", "alice password"))

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def put(self, key, data, content_type, modified=None):
        asyncio.run(self.app.objects.put_object(self.scope, key, data, len(data), content_type))
        if modified is not None:
            with self.app.metadata.transaction() as db:
                db.execute("UPDATE objects SET modified_at=? WHERE bucket_id=? AND key=?", (modified, self.alice.bucket_id, key))

    def page(self, view, limit=2):
        keys, cursor, bodies = [], "", []
        while True:
            status, _, data = asyncio.run(self.client.request("GET", f"/api/user/v1/library?view={view}&limit={limit}&cursor={quote(cursor)}",
                                                              headers=self.session))
            self.assertEqual(status, 200, data)
            body = json.loads(data)
            bodies += body["objects"]
            keys += [item["key"] for item in body["objects"]]
            if not body["next_cursor"]:
                return keys, bodies
            cursor = body["next_cursor"]

    def test_recent_lists_newest_files_across_folders(self):
        now = time.time()
        self.put("a/old.txt", b"old", "text/plain", now - 300)
        self.put("b/new.txt", b"new", "text/plain", now - 10)
        self.put("c/mid.txt", b"mid", "text/plain", now - 100)
        self.put("c/same.txt", b"same", "text/plain", now - 100)
        asyncio.run(self.app.objects.put_object(Scope(self.alice.bucket_id, private_access=True), ".tgdrive/private/secret.txt", b"secret", 6, "text/plain"))
        asyncio.run(self.app.objects.put_directory_marker(self.scope, "empty/"))
        keys, _ = self.page("recent")
        self.assertEqual(keys, ["b/new.txt", "c/mid.txt", "c/same.txt", "a/old.txt"], "按修改时间倒序，同一时间按路径，翻页不重复不遗漏")

    def test_photos_prefer_exif_time_and_music_lists_audio(self):
        now = time.time()
        self.put("trip/early.jpg", exif_jpeg("2019:05:01 08:00:00"), "image/jpeg", now)
        self.put("trip/plain.jpg", b"\xff\xd8\xff\xdb" + b"\x00" * 64, "image/jpeg", now - 50)
        self.put("notes.txt", b"x", "text/plain", now)
        self.put("music/b.mp3", b"ID3" + b"\x00" * 64, "audio/mpeg")
        self.put("music/a.mp3", b"ID3" + b"\x00" * 64, "audio/mpeg")
        keys, bodies = self.page("photos")
        self.assertEqual(keys, ["trip/plain.jpg", "trip/early.jpg"], "有 EXIF 的按拍摄时间（2019 年）排在后面")
        self.assertEqual(bodies[1]["taken_at"], datetime(2019, 5, 1, 8, tzinfo=timezone.utc).timestamp())
        self.assertNotIn("taken_at", bodies[0])
        keys, _ = self.page("music")
        self.assertEqual(keys, ["music/a.mp3", "music/b.mp3"])

    def test_rejects_unknown_view(self):
        status, _, data = asyncio.run(self.client.request("GET", "/api/user/v1/library?view=all", headers=self.session))
        self.assertEqual(status, 400, data)


if __name__ == "__main__":
    unittest.main()
