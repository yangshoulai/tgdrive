"""流式分享下载的格式、权限与取消回归；全部使用内存对象，不初始化数据库。"""
import io
import unittest
import zipfile
from types import SimpleNamespace
from urllib.parse import urlencode

from tgdrive.archive import stream_zip
from tgdrive.asgi import TgDriveASGI
from tgdrive.errors import IntegrityError, NotFoundError
from tgdrive.objects import ListPage, ObjectInfo, ObjectService, Scope


class PublicArchiveTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.data = {"shared/a.txt": b"first", "shared/小曲.mp3": b"second", "shared/sub/inside.txt": b"nested"}
        self.state = {"password": None, "active": True, "downloads": 0, "pages": [], "opened": []}
        self.info = lambda key: ObjectInfo(7, key, len(self.data.get(key, b"")), key, "text/plain", {}, 1, key)
        async def run_in_thread(callback): return callback()
        def head(scope, key):
            self.assertEqual(scope, Scope(7, "shared/", "ro"))
            ObjectService._check_scope(scope, key)
            if key not in self.data: raise NotFoundError(key)
            return self.info(key)
        def page(scope, prefix, delimiter, cursor, limit):
            self.state["pages"].append(cursor)
            self.assertEqual(scope, Scope(7, "shared/", "ro"))
            if prefix == "shared/sub/": return ListPage([self.info("shared/sub/inside.txt")], [], None)
            return ListPage([self.info("shared/小曲.mp3")] if cursor else [self.info("shared/a.txt")],
                            [] if cursor else ["shared/sub/"], None if cursor else "second")
        async def get(scope, key):
            info = head(scope, key)
            self.state["opened"].append(key)
            async def stream():
                yield self.data[key][:2]
                yield self.data[key][2:]
            return info, stream()
        def count(*_): self.state["downloads"] += 1
        self.objects = SimpleNamespace(metadata=SimpleNamespace(run_in_thread=run_in_thread), head_object=head,
            list_objects=page, get_object=get, count_public_download=count, _public_relative=ObjectService._public_relative)
        self.app = TgDriveASGI.__new__(TgDriveASGI)
        self.app.user = SimpleNamespace(objects=self.objects)
        self.app.share_access = SimpleNamespace(check=lambda token, password, grant: grant == "grant")
        def share(token):
            if not self.state["active"]: raise NotFoundError(token)
            return self.info("shared/"), self.state["password"]
        self.app._public_share = share
        self.app.settings = SimpleNamespace(s3_hostname=lambda: None)
        self.app.s3 = self.app.s3_host = self.app.static_dir = self.app.metrics = None
        self.app.json_limit = 1024 * 1024

    async def request(self, form):
        messages = []
        async def receive(): return {"type": "http.request", "body": urlencode(form, doseq=True).encode()}
        async def send(message): messages.append(message)
        await self.app({"type": "http", "method": "POST", "path": "/api/public/v1/folders/public/download",
                        "query_string": b"", "headers": [(b"content-type", b"application/x-www-form-urlencoded")]}, receive, send)
        return messages[0]["status"], dict(messages[0]["headers"]), b"".join(item.get("body", b"") for item in messages[1:])

    async def test_selected_and_all_pages(self):
        status, headers, body = await self.request({"files": ["小曲.mp3", "小曲.mp3"]})
        self.assertEqual(status, 200)
        self.assertEqual(headers[b"content-type"], b"application/zip")
        self.assertEqual(headers[b"cache-control"], b"no-store")
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            self.assertEqual(archive.namelist(), ["小曲.mp3"])
            self.assertEqual(archive.read("小曲.mp3"), b"second")
            self.assertIsNone(archive.testzip())
        self.assertEqual(self.state["downloads"], 1)
        status, _, body = await self.request({"all": "1"})
        self.assertEqual(status, 200)
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            self.assertEqual(archive.namelist(), ["a.txt", "小曲.mp3"])
            self.assertIsNone(archive.testzip())
        self.assertEqual(self.state["pages"], [None, "second"])

    async def test_password_and_revocation(self):
        self.state["password"] = "password-hash"
        self.assertEqual((await self.request({"all": "1"}))[0], 403)
        self.assertEqual(self.state["opened"], [])
        self.assertEqual((await self.request({"access": "grant", "all": "1"}))[0], 200)
        self.state["active"] = False
        self.assertEqual((await self.request({"access": "grant", "all": "1"}))[0], 404)

    async def test_directory_boundaries_and_missing_file(self):
        for path in ("../a.txt", "/a.txt", "sub/inside.txt", "a\\..\\secret.txt", "", "sub/"):
            with self.subTest(path=path):
                self.assertEqual((await self.request({"files": [path]}))[0], 400)
        self.assertEqual((await self.request({"path": "../", "all": "1"}))[0], 400)
        self.assertEqual((await self.request({"files": ["missing.txt"]}))[0], 404)
        self.assertEqual(self.state["opened"], [])
        self.assertEqual((await self.request({"path": "sub/", "files": ["sub/inside.txt"]}))[0], 200)

    async def test_revocation_stops_remaining_files(self):
        async def send(message):
            if message["type"] == "http.response.body":
                self.state["active"] = False
        with self.assertRaises(NotFoundError):
            await self.app._public_folder_download(send, "public", {"all": ["1"]})
        self.assertEqual(self.state["opened"], ["shared/a.txt"])


class ZipStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_closes_source_without_reading_full_file(self):
        reads, closed = [], []
        async def content():
            try:
                for index in range(100):
                    reads.append(index)
                    yield b"x" * 1024
            finally: closed.append("content")
        async def entries():
            try: yield "large.bin", 102400, 0, content()
            finally: closed.append("entries")
        archive = stream_zip(entries())
        self.assertTrue((await anext(archive)).startswith(b"PK"))
        await archive.aclose()
        self.assertEqual(reads, [0])
        self.assertEqual(closed, ["content", "entries"])

    async def test_incomplete_source_and_first_chunk_failure(self):
        async def content(): yield b"short"
        async def entries(): yield "file.txt", 10, 0, content()
        with self.assertRaises(IntegrityError):
            async for _ in stream_zip(entries()): pass
        async def failed():
            raise IntegrityError("decrypt failed")
            yield b""
        async def broken(): yield "file.txt", 1, 0, failed()
        with self.assertRaises(IntegrityError): await anext(stream_zip(broken()))

    async def test_zero_byte_file_and_zip64(self):
        async def empty():
            if False: yield b""
        async def entries(): yield "empty.txt", 0, 0, empty()
        body = b"".join([part async for part in stream_zip(entries())])
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            self.assertEqual(archive.read("empty.txt"), b"")
            self.assertEqual(archive.getinfo("empty.txt").extract_version, 45)


if __name__ == "__main__":
    unittest.main()
