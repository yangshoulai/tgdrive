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

    def get(self, path):
        status, _, data = asyncio.run(self.client.request("GET", path, headers=self.session))
        self.assertEqual(status, 200, data)
        return json.loads(data)

    def page(self, view, limit=2, extra=""):
        keys, cursor, bodies = [], "", []
        while True:
            status, _, data = asyncio.run(self.client.request("GET", f"/api/user/v1/library?view={view}&limit={limit}&cursor={quote(cursor)}{extra}",
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

    def test_photos_are_images_only_and_folder_lists_by_taken_time(self):
        now = time.time()
        self.put("trip/early.jpg", exif_jpeg("2019:05:01 08:00:00"), "image/jpeg", now)
        self.put("trip/plain.jpg", b"\xff\xd8\xff\xdb" + b"\x00" * 64, "image/jpeg", now - 50)
        self.put("trip/day/sub.jpg", b"\xff\xd8\xff\xdb" + b"\x00" * 64, "image/jpeg", now)
        self.put("trip/clip.mp4", b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64, "video/mp4", now)
        self.put("notes.txt", b"x", "text/plain", now)
        keys, bodies = self.page("photos", extra="&folder=" + quote("trip/"))
        self.assertEqual(keys, ["trip/plain.jpg", "trip/early.jpg"], "只列这个文件夹直接包含的图片，有 EXIF 的按拍摄时间（2019 年）排在后面，不含视频")
        self.assertEqual(bodies[1]["taken_at"], datetime(2019, 5, 1, 8, tzinfo=timezone.utc).timestamp())
        self.assertNotIn("taken_at", bodies[0])
        keys, _ = self.page("photos")
        self.assertEqual(keys, ["trip/day/sub.jpg", "trip/early.jpg", "trip/plain.jpg"], "不带文件夹时按路径排列，便于网页按文件夹分段")
        keys, _ = self.page("videos")
        self.assertEqual(keys, ["trip/clip.mp4"])

    def test_folders_group_media_by_parent_directory(self):
        now = time.time()
        for index in range(6):
            self.put(f"trip/{index}.jpg", b"\xff\xd8\xff\xdb" + bytes([index]) * 64, "image/jpeg", now - 100 + index)
        self.put("home.jpg", b"\xff\xd8\xff\xdb" + b"\x09" * 64, "image/jpeg", now)
        self.put("trip/day/sub.jpg", b"\xff\xd8\xff\xdb" + b"\x08" * 64, "image/jpeg", now - 500)
        body = self.get("/api/user/v1/library/folders?view=photos")
        self.assertFalse(body["truncated"])
        self.assertEqual([(item["path"], item["count"]) for item in body["folders"]], [("", 1), ("trip/", 6), ("trip/day/", 1)],
                         "按最近时间倒序；根目录与子文件夹各自成组")
        trip = body["folders"][1]
        self.assertEqual([item["key"] for item in trip["samples"]], ["trip/5.jpg", "trip/4.jpg", "trip/3.jpg", "trip/2.jpg"], "样本取最新的 4 张")
        self.assertEqual(trip["size"], 6 * 68)

    def tag(self, key, **fields):
        # 音乐库只读文件级元数据（首次解析字段），不再读取按 Blob 的解析缓存 media_info。
        row = self.app.metadata.db.execute("SELECT metadata_id FROM objects WHERE bucket_id=? AND key=?", (self.alice.bucket_id, key)).fetchone()
        with self.app.metadata.transaction() as db:
            db.execute("UPDATE file_metadata SET auto_fields=?, fields_ready=1, state='ready' WHERE id=?",
                       (json.dumps(fields, ensure_ascii=False), row["metadata_id"]))

    def test_music_groups_by_album_name(self):
        self.put("a/1.mp3", b"ID3" + b"\x01" * 64, "audio/mpeg")
        self.put("b/2.mp3", b"ID3" + b"\x02" * 64, "audio/mpeg")
        self.put("b/3.mp3", b"ID3" + b"\x03" * 64, "audio/mpeg")
        self.put("c/loose.mp3", b"ID3" + b"\x04" * 64, "audio/mpeg")
        self.put("c/blank.mp3", b"ID3" + b"\x05" * 64, "audio/mpeg")
        self.tag("b/2.mp3", album="精选", artist="甲", track="2/10", duration=30.0)
        self.tag("a/1.mp3", album=" 精选 ", artist="乙", track="1", duration=40.0)
        self.tag("b/3.mp3", album="林间", artist="甲")
        self.tag("c/blank.mp3", album="", title="空专辑")
        body = self.get("/api/user/v1/library/albums")
        self.assertFalse(body["truncated"])
        self.assertEqual([(item["album"], item["count"]) for item in body["albums"]], [("林间", 1), ("精选", 2), ("", 2)],
                         "同名专辑（去掉首尾空白）合为一张，不区分艺人；没有专辑的歌曲合为一项排在最后")
        album = body["albums"][1]
        self.assertEqual([item["key"] for item in album["samples"]], ["a/1.mp3", "b/2.mp3"], "按曲目号排列，第一首作封面")
        self.assertEqual((album["artist"], album["duration"]), ("多位艺人", 70.0))
        self.assertEqual(body["albums"][0]["artist"], "甲")
        keys, _ = self.page("music", extra="&album=" + quote("精选"))
        self.assertEqual(sorted(keys), ["a/1.mp3", "b/2.mp3"])
        keys, _ = self.page("music", extra="&album=")
        self.assertEqual(keys, ["c/blank.mp3", "c/loose.mp3"], "空专辑名与没有标签记录的歌曲都在「无专辑」里")

    def test_music_search_matches_path_and_tags(self):
        self.put("music/b.mp3", b"ID3" + b"\x00" * 64, "audio/mpeg")
        self.put("albums/Rain Song.mp3", b"ID3" + b"\x02" * 64, "audio/mpeg")
        keys, _ = self.page("music", extra="&q=rain")
        self.assertEqual(keys, ["albums/Rain Song.mp3"], "按文件名匹配，不区分大小写")
        keys, _ = self.page("music", extra="&q=" + quote("albums"))
        self.assertEqual(keys, ["albums/Rain Song.mp3"], "也匹配文件夹名")
        self.tag("music/b.mp3", title="晨间漫步", artist="Tessera 乐队", album="林间")
        keys, _ = self.page("music", extra="&q=" + quote("乐队"))
        self.assertEqual(keys, ["music/b.mp3"], "音乐还匹配标签里的歌名、艺人与专辑")
        albums = self.get("/api/user/v1/library/albums?q=" + quote("漫步"))["albums"]
        self.assertEqual([(item["album"], item["count"]) for item in albums], [("林间", 1)], "搜索时只统计匹配的歌曲")
        status, _, _ = asyncio.run(self.client.request("GET", "/api/user/v1/library/folders?view=music", headers=self.session))
        self.assertEqual(status, 400, "音乐按专辑浏览，不提供文件夹分组")

    def test_recent_search_matches_relative_path(self):
        now = time.time()
        self.put("Work/report.txt", b"r", "text/plain", now)
        self.put("notes.txt", b"n", "text/plain", now)
        keys, _ = self.page("recent", extra="&q=work")
        self.assertEqual(keys, ["Work/report.txt"])

    def test_rejects_unknown_view(self):
        status, _, data = asyncio.run(self.client.request("GET", "/api/user/v1/library?view=all", headers=self.session))
        self.assertEqual(status, 400, data)


if __name__ == "__main__":
    unittest.main()
