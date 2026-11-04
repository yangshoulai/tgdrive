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
