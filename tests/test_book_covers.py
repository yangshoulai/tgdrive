"""书籍二进制解析与接入边界；只使用内存样本和替身，不创建或连接数据库。"""

import asyncio
import base64
import ctypes.util
import io
import struct
import unittest
import zipfile
import zlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from tgdrive.media.book_covers import BookCoverError, read_cover
from tgdrive.media.service import FileAccess, MediaService
from tgdrive.thumbnail_cache import ThumbnailCache
from tgdrive.thumbnails import ThumbnailService, source_kind

IMAGE = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFz0AAAAASUVORK5CYII=")


def archive(files, compression=zipfile.ZIP_DEFLATED):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=compression) as stream:
        for name, data in files.items():
            stream.writestr(name, data)
    return output.getvalue()


def epub(manifest='<item id="cover" href="cover.png" properties="cover-image"/>', metadata="", extra=None):
    return archive({
        "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
        "OPS/book.opf": f'<package><metadata>{metadata}</metadata><manifest>{manifest}</manifest></package>',
        "OPS/cover.png": IMAGE,
        **(extra or {}),
    })


def mobi(with_cover=True):
    record = bytearray(16 + 232)
    record[16:20] = b"MOBI"
    struct.pack_into(">I", record, 20, 232)
    struct.pack_into(">I", record, 108, 2)
    exth_record = struct.pack(">III", 201, 12, 0) if with_cover else b""
    record.extend(b"EXTH" + struct.pack(">II", 12 + len(exth_record), int(with_cover)) + exth_record)
    header = bytearray(78)
    header[60:68] = b"BOOKMOBI"
    struct.pack_into(">H", header, 76, 3)
    first = 78 + 24
    table = b"".join(struct.pack(">II", offset, 0) for offset in (first, first + len(record), first + len(record) + 8))
    return bytes(header) + table + record + b"texttext" + IMAGE


def rar(files):
    # 自建未压缩 RAR4，覆盖原生 libarchive 的目录／范围回调与目标图片读取。
    def header(kind, flags, body):
        value = struct.pack("<BHH", kind, flags, 7 + len(body)) + body
        return struct.pack("<H", zlib.crc32(value) & 0xFFFF) + value
    result = bytearray(b"Rar!\x1a\x07\x00" + header(0x73, 0, b"\0" * 6))
    for name, data in files.items():
        if isinstance(data, str):
            data = data.encode()
        encoded = name.encode()
        body = struct.pack("<IIBIIBBHI", len(data), len(data), 3, zlib.crc32(data), 0, 20, 0x30, len(encoded), 0o100644)
        result.extend(header(0x74, 0x8000, body + encoded) + data)
    result.extend(header(0x7B, 0, b""))
    return bytes(result)


class BookCoverTests(unittest.IsolatedAsyncioTestCase):
    async def cover(self, data, name="book.epub", mime=None):
        self.reads = []
        async def read(start, end):
            self.reads.append((start, end))
            return data[start:end]
        return await read_cover(read, len(data), name, mime)

    async def test_epub3_and_epub2_cover(self):
        self.assertEqual(await self.cover(epub()), IMAGE)
        self.assertEqual(await self.cover(epub('<item id="c" href="cover.png"/>', '<meta name="cover" content="c"/>')), IMAGE)

    async def test_epub_svg_wrapper_references_local_raster(self):
        data = epub('<item id="c" href="cover.svg" properties="cover-image"/>', extra={
            "OPS/cover.svg": '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="cover.png"/></svg>',
        })
        self.assertEqual(await self.cover(data), IMAGE)

    async def test_epub_does_not_read_unrelated_content(self):
        # 体积较大的正文使用存储压缩，防止 fixture 本身被压到读尾范围以内。
        output = io.BytesIO()
        output.write(epub())
        with zipfile.ZipFile(output, "a") as stream:
            stream.writestr("OPS/content.bin", b"body" * (2 * 1024 * 1024))
        self.assertEqual(await self.cover(output.getvalue()), IMAGE)
        self.assertLess(sum(end - start for start, end in self.reads), 150_000)
        self.assertTrue(all(end - start <= 256 * 1024 for start, end in self.reads))

    async def test_no_cover_is_distinct_from_invalid_book(self):
        self.assertIsNone(await self.cover(epub("")))
        with self.assertRaises(BookCoverError):
            await self.cover(b"not an ebook")

    async def test_mobi_azw_azw3_use_explicit_cover_record(self):
        for suffix in ("mobi", "azw", "azw3"):
            with self.subTest(suffix=suffix):
                self.assertEqual(await self.cover(mobi(), f"book.{suffix}"), IMAGE)
        self.assertIsNone(await self.cover(mobi(False), "book.mobi"))

    async def test_joint_mobi_uses_kf8_header_and_shared_image_records(self):
        def record(data):
            start, end = (struct.unpack_from(">I", data, 78 + i * 8)[0] for i in (0, 1))
            return bytearray(data[start:end])
        original, kf8 = record(mobi(False)), record(mobi())
        struct.pack_into(">I", original, 108, 4)
        original[-12:] = b"EXTH" + struct.pack(">IIIII", 24, 1, 121, 12, 3)
        struct.pack_into(">I", kf8, 108, 1)
        records = [original, b"text", b"BOUNDARY", kf8, IMAGE]
        header = bytearray(78)
        header[60:68] = b"BOOKMOBI"
        struct.pack_into(">H", header, 76, len(records))
        offset, table = 78 + 8 * len(records), bytearray()
        for data in records:
            table.extend(struct.pack(">II", offset, 0))
            offset += len(data)
        self.assertEqual(await self.cover(bytes(header + table) + b"".join(records), "joint.mobi"), IMAGE)

    async def test_fb2_streaming_base64_cover_and_utf16(self):
        text = ('<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info>'
                '<coverpage><image l:href="#cover"/></coverpage></title-info></description>'
                '<body><p>正文</p></body><binary id="cover">' + base64.b64encode(IMAGE).decode() + '</binary></FictionBook>')
        for encoding in ("utf-8", "utf-16"):
            with self.subTest(encoding=encoding):
                self.assertEqual(await self.cover(text.encode(encoding), "book.fb2"), IMAGE)

    async def test_cbz_natural_order_and_comicinfo_frontcover(self):
        files = {"10.png": b"wrong", "2.png": IMAGE, "__MACOSX/1.png": b"ignored"}
        self.assertEqual(await self.cover(archive(files), "comic.cbz"), IMAGE)
        files["ComicInfo.xml"] = '<ComicInfo><Pages><Page Image="1" Type="FrontCover"/></Pages></ComicInfo>'
        files["10.png"], files["2.png"] = IMAGE, b"wrong"
        self.assertEqual(await self.cover(archive(files), "comic.cbz"), IMAGE)

    @unittest.skipUnless(ctypes.util.find_library("archive"), "本机没有 libarchive")
    async def test_cbr_rar_reader_selects_marked_cover(self):
        data = rar({"2.png": b"wrong", "10.png": IMAGE,
                    "ComicInfo.xml": '<ComicInfo><Pages><Page Image="1" Type="FrontCover"/></Pages></ComicInfo>'})
        self.assertEqual(await self.cover(data, "comic.cbr"), IMAGE)

    async def test_dtd_external_resources_and_path_escape_are_rejected(self):
        for href in ("https://example.com/cover.png", "../../cover.png", "file:///cover.png"):
            with self.subTest(href=href), self.assertRaises(BookCoverError):
                await self.cover(epub(f'<item href="{href}" properties="cover-image"/>'))
        with self.assertRaises(BookCoverError):
            await self.cover(b'<!DOCTYPE FictionBook [<!ENTITY x "test">]><FictionBook>&x;</FictionBook>', "book.fb2")

    async def test_large_zip_member_is_rejected_before_inflating(self):
        data = epub(extra={"OPS/cover.png": b"x" * (20 * 1024 * 1024 + 1)})
        with self.assertRaisesRegex(BookCoverError, "上限"):
            await self.cover(data)

    async def test_pdf_txt_and_misleading_suffix_are_not_supported(self):
        for name, mime in (("report.pdf", "application/pdf"), ("notes.txt", "text/plain"), ("fake.epub", "image/png")):
            with self.subTest(name=name), self.assertRaises(BookCoverError):
                await self.cover(IMAGE, name, mime)

    async def test_cancel_reaps_parser_process(self):
        process = None
        create = asyncio.create_subprocess_exec
        async def spawn(*args, **kwargs):
            nonlocal process
            process = await create(*args, **kwargs)
            return process
        reading = asyncio.Event()
        async def read(*_):
            reading.set()
            await asyncio.Event().wait()
        with patch("tgdrive.media.book_covers.asyncio.create_subprocess_exec", spawn):
            task = asyncio.create_task(read_cover(read, 100, "book.epub"))
            await asyncio.wait_for(reading.wait(), 5)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertIsNotNone(process.returncode)

    async def test_manual_cover_rechecks_source_after_parse(self):
        info = SimpleNamespace(key="book.epub", content_type="application/epub+zip", size=100, etag="v1", metadata_id="m1", blob_uuid="blob", bucket_id=1)
        service = object.__new__(MediaService)
        service.objects = SimpleNamespace(head_object=Mock(return_value=info))
        scope = SimpleNamespace(private_access=False)
        with patch("tgdrive.media.service.book_covers.read_cover", AsyncMock(return_value=IMAGE)):
            data, mime = await service.embedded_cover(scope, info.key, "v1")
            self.assertEqual((data, mime), (IMAGE, "image/png"))
        other = SimpleNamespace(**{**vars(info), "metadata_id": "replacement"})
        service.objects.head_object.side_effect = [info, other]
        with patch("tgdrive.media.service.book_covers.read_cover", AsyncMock(return_value=IMAGE)):
            with self.assertRaisesRegex(ValueError, "变化"):
                await service.embedded_cover(scope, info.key, "v1")

    async def test_manual_read_stops_when_private_access_is_revoked(self):
        info = SimpleNamespace(key="book.epub", content_type="application/epub+zip", size=len(epub()), etag="v1", metadata_id="m1", blob_uuid="blob", bucket_id=1)
        service = object.__new__(MediaService)
        service.objects = SimpleNamespace(head_object=Mock(side_effect=[info, info, PermissionError("已锁定")]))
        with patch.object(FileAccess, "read", AsyncMock(return_value=epub()[:8])):
            with self.assertRaises(PermissionError):
                await service.embedded_cover(SimpleNamespace(private_access=True), info.key, "v1")

    async def test_new_commit_enqueues_but_historical_observe_does_not(self):
        info = SimpleNamespace(key="book.epub", content_type="application/epub+zip", size=10, blob_uuid="blob")
        service = object.__new__(ThumbnailService)
        service._unsuitable, service._pending = {}, {}
        service._dispatch = Mock()
        service.enqueue(info)
        job = service._dispatch.call_args.args[1]
        self.assertTrue(job.committed)
        service._dispatch.reset_mock()
        service.observe(info, client=True)
        service._dispatch.assert_not_called()
        service.enqueue(info, SimpleNamespace(custom_cover=True))
        service._dispatch.assert_not_called()
        self.assertEqual(source_kind(info), "book")
        self.assertIsNone(source_kind(SimpleNamespace(**{**vars(info), "key": "book.pdf", "content_type": "application/pdf"})))

    async def test_upload_cache_accepts_book_but_not_pdf(self):
        cache = ThumbnailCache()
        try:
            cache.prepare("book", "book.epub", "application/epub+zip")
            cache.prepare("pdf", "report.pdf", "application/pdf")
            cache.put("book", "r", 0, b"ciphertext")
            cache.put("pdf", "r", 0, b"ignored")
            self.assertEqual(cache.get("book", "r", 0, 10), b"ciphertext")
            self.assertEqual(cache.status()["bytes"], 10)
        finally:
            cache.close()
