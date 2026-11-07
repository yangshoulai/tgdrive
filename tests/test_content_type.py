"""文件类型以内容为准：写入时看文件开头判断，文件名与上传方声明的类型不能推翻；S3 与复制保留声明的类型。"""
import asyncio
import tempfile
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.filekinds import kind_of
from tgdrive.objects import Scope
from tgdrive.sniff import resolve, sniff

JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + bytes(64)
PNG = b"\x89PNG\r\n\x1a\n" + bytes(64)
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + bytes(64)
M4A = b"\x00\x00\x00\x18ftypM4A \x00\x00\x02\x00isomiso2" + bytes(64)


class SniffTests(unittest.TestCase):
    def test_signatures(self):
        cases = {JPEG: "exact:image/jpeg", PNG: "exact:image/png", MP4: "exact:video/mp4", M4A: "exact:audio/mp4",
                 b"%PDF-1.7\n": "exact:application/pdf", b"fLaC\x00\x00": "exact:audio/flac", b"ID3\x04": "exact:audio/mpeg",
                 b"\x1aE\xdf\xa3\x01\x00\x00\x00webm": "exact:video/webm", b"PK\x03\x04" + bytes(26): "zip:application/zip",
                 b"PK\x03\x04" + bytes(26) + b"[Content_Types].xml word/document.xml": "exact:application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                 "# 标题\n正文".encode(): "text:text/plain", b"<svg xmlns='http://www.w3.org/2000/svg'/>": "exact:image/svg+xml",
                 b"\x00\x01\x00\x00\x00\x12\x01\x00\x00\x04\x00\x20" + bytes(64): "exact:font/ttf", b"OTTO\x00\x0b" + bytes(64): "exact:font/otf",
                 b"wOFF" + bytes(64): "exact:font/woff", b"wOF2" + bytes(64): "exact:font/woff2",
                 b"PK\x03\x04" + bytes(26) + b"mimetypeapplication/epub+zip": "exact:application/epub+zip",
                 b"": "empty:", bytes(range(256)) * 4: "unknown:"}
        for head, expected in cases.items():
            with self.subTest(head=head[:12]):
                self.assertEqual(sniff(head), expected)

    def test_resolve_prefers_content(self):
        self.assertEqual(resolve("exact:image/png", "image/jpeg", "a.jpg"), "image/png", "扩展名说是 JPEG，内容是 PNG")
        self.assertEqual(resolve("text:text/plain", "image/jpeg", "a.jpg"), "text/plain")
        self.assertEqual(resolve("text:text/plain", "text/markdown", "a.md"), "text/markdown", "文本的具体种类保留声明")
        self.assertEqual(resolve("text:text/plain", "video/mp2t", "a.ts"), "text/plain", "TypeScript 源码不是 MPEG-TS")
        self.assertEqual(resolve("exact:video/mp4", "audio/mp4", "a.m4a"), "audio/mp4", "同一容器的音频保留声明")
        self.assertEqual(resolve("unknown:", "image/jpeg", "a.jpg"), "application/octet-stream", "声称是 JPEG 却认不出")
        self.assertEqual(resolve("unknown:", "application/x-sqlite3", "a.db"), "application/x-sqlite3")
        self.assertEqual(resolve("zip:application/zip", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx"),
                         "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        self.assertEqual(resolve(None, "image/jpeg", "a.jpg"), "image/jpeg", "旧数据没有记录时沿用原类型")

    def test_kinds_follow_specific_type_not_name(self):
        self.assertEqual(kind_of("a.jpg", "text/plain"), "text")
        self.assertEqual(kind_of("a.jpg", None), "image", "没有类型时才按扩展名")
        self.assertEqual(kind_of("a.jpg", "application/octet-stream"), "image")
        self.assertEqual(kind_of("song.flac", "video/x-flac"), "audio", "容器相同时音频扩展名仍算音频")
        self.assertEqual(kind_of("main.py", "text/plain"), "text")
        self.assertEqual(kind_of("book.epub", "application/epub+zip"), "document", "电子书归文档，不算压缩包")
        self.assertEqual(kind_of("a.ipynb", "application/x-ipynb+json"), "text")
        self.assertEqual(kind_of("a.jsonl", None), "text")


class StoredTypeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.alice.bucket_id)

    async def asyncTearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    async def type_of(self, key):
        return self.app.objects.head_object(self.scope, key).content_type

    async def test_upload_and_multipart_use_content(self):
        objects = self.app.objects
        await objects.put_object(self.scope, "photo.jpg", PNG, len(PNG), "image/jpeg")
        self.assertEqual(await self.type_of("photo.jpg"), "image/png")
        await objects.put_object(self.scope, "notes.jpg", b"just text", 9, "image/jpeg")
        self.assertEqual(await self.type_of("notes.jpg"), "text/plain")
        upload = await objects.create_multipart(self.scope, "movie.bin", "application/octet-stream")
        part = await objects.upload_part(self.scope, upload, 1, MP4, len(MP4))
        await objects.complete_multipart(self.scope, upload, [(1, part.etag)])
        self.assertEqual(await self.type_of("movie.bin"), "video/mp4")
        # 改名不改类型。
        objects.move(self.scope, "photo.jpg", "photo.txt")
        self.assertEqual(await self.type_of("photo.txt"), "image/png")

    async def test_s3_declared_type_is_kept(self):
        await self.app.objects.put_object(self.scope, "s3.bin", b"plain text", 10, "image/x-test", declared_type=True)
        self.assertEqual(await self.type_of("s3.bin"), "image/x-test")


if __name__ == "__main__":
    unittest.main()


class ImageMistakenForVideoTests(unittest.IsolatedAsyncioTestCase):
    """部分图片被当成视频（列表显示为视频却无法播放）：识别规则与已保存文件的修正。"""
    asyncSetUp, asyncTearDown, type_of = StoredTypeTests.asyncSetUp, StoredTypeTests.asyncTearDown, StoredTypeTests.type_of

    def test_unknown_brand_heif_and_miaf_are_images(self):
        # 陌生品牌的 ISO-BMFF：meta 里的处理器是 pict 就是图片，不再一律当成 MP4 视频。
        heif = b"\x00\x00\x00\x14ftypabcd\x00\x00\x00\x00abcd" + b"\x00\x00\x00\x21meta\x00\x00\x00\x00\x00\x00\x00\x21hdlr\x00\x00\x00\x00\x00\x00\x00\x00pict" + bytes(32)
        self.assertEqual(sniff(heif), "exact:image/heif")
        miaf = b"\x00\x00\x00\x1cftypabcd\x00\x00\x00\x00abcdmiafMA1B" + bytes(32)
        self.assertEqual(sniff(miaf), "exact:image/heif")
        self.assertEqual(sniff(MP4), "exact:video/mp4", "普通 MP4 不受影响")

    def test_unknown_content_with_image_name_is_not_video(self):
        self.assertEqual(resolve("unknown:", "video/mp4", "photo.jpg"), "image/jpeg", "网站把图片标成视频：按文件名保存为图片")
        self.assertEqual(resolve("unknown:", "video/mp4", "clip.mp4"), "application/octet-stream", "声称视频又认不出时仍按通用二进制")

    async def test_maintenance_retypes_stored_images(self):
        objects, db = self.app.objects, self.app.metadata
        await objects.put_object(self.scope, "old/photo.jpg", JPEG, len(JPEG), "image/jpeg")
        await objects.put_object(self.scope, "old/movie.mp4", MP4, len(MP4), "video/mp4")
        await objects.put_object(self.scope, "old/real.jpg", MP4, len(MP4), "video/mp4")
        row = db.db.execute("SELECT blob_uuid FROM objects WHERE bucket_id=? AND key=?", (self.alice.bucket_id, "old/photo.jpg")).fetchone()
        with db.transaction() as tx:
            # 模拟内容识别上线前保存、来源把图片标成视频的文件：没有识别记录，类型是 video/mp4，还记过「无法生成封面」。
            tx.execute("UPDATE blobs SET sniffed=NULL WHERE uuid=?", (row["blob_uuid"],))
            tx.execute("UPDATE objects SET content_type='video/mp4' WHERE bucket_id=? AND key=?", (self.alice.bucket_id, "old/photo.jpg"))
            tx.execute("INSERT INTO thumbnails(blob_uuid, variant, mime, data, created_at) VALUES (?, 'none', '', x'', 0)", (row["blob_uuid"],))
        result = await self.app.maintenance.retyper.run_once()
        self.assertEqual((result["fixed"], result["done"]), (1, True))
        self.assertEqual(await self.type_of("old/photo.jpg"), "image/jpeg")
        self.assertEqual(await self.type_of("old/movie.mp4"), "video/mp4", "真正的视频不动")
        self.assertEqual(await self.type_of("old/real.jpg"), "video/mp4", "名字像图片、内容确实是 MP4 的保持视频")
        self.assertIsNone(db.db.execute("SELECT 1 FROM thumbnails WHERE blob_uuid=? AND variant='none'", (row["blob_uuid"],)).fetchone(),
                          "清掉无法生成封面的记录，让封面重新生成")
        self.assertEqual(await self.app.maintenance.retyper.run_once(), {"done": True}, "扫完一遍后不再重复读取")
