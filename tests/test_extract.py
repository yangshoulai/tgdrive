"""在线解压（extract.py）：ZIP（多种压缩方式、GBK 文件名、ZipCrypto／AES 密码、ZIP64 之外的常见结构）、TAR 与单文件压缩，
同名处理、配额检查、保留／移走原压缩包、路径越界与私密空间授权。"""

import asyncio
import bz2
import hashlib
import hmac
import io
import json
import lzma
import os
import struct
import tarfile
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path
from urllib.parse import quote

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from tgdrive.app import create_app
from tgdrive.extract import ZipCrypto, _CRC_TABLE
from tgdrive.objects import Scope
from tests.test_public_links import Client


def zipcrypto_encrypt(password: bytes, data: bytes, check: int) -> bytes:
    keys = ZipCrypto(password)
    out = bytearray()
    for plain in os.urandom(11) + bytes([check]) + data:
        k = (keys.k2 | 2) & 0xFFFF
        out.append(plain ^ (((k * (k ^ 1)) >> 8) & 0xFF))
        keys._update(plain)
    return bytes(out)


def aes_encrypt(password: bytes, data: bytes) -> bytes:
    salt = os.urandom(16)
    derived = hashlib.pbkdf2_hmac("sha1", password, salt, 1000, 66)
    encryptor = Cipher(algorithms.AES(derived[:32]), modes.ECB()).encryptor()
    blocks = (len(data) + 15) // 16
    stream = encryptor.update(b"".join((index + 1).to_bytes(16, "little") for index in range(blocks)))
    cipher = bytes(a ^ b for a, b in zip(data, stream))
    mac = hmac.new(derived[32:64], cipher, hashlib.sha1).digest()[:10]
    return salt + derived[64:] + cipher + mac


def build_zip(entries) -> bytes:
    """entries: (name_bytes, data, method, encryption, utf8)。只为测试写最小 ZIP。"""
    out, central = bytearray(), bytearray()
    for name, data, method, encryption, utf8 in entries:
        crc = zlib.crc32(data)
        payload = data if method == 0 else zlib.compress(data)[2:-4] if method == 8 else bz2.compress(data) if method == 12 else None
        flags, extra, stored_method, stored_crc = (0x800 if utf8 else 0), b"", method, crc
        if encryption == "zipcrypto":
            flags |= 1
            payload = zipcrypto_encrypt(b"secret", payload, crc >> 24)
        elif encryption == "aes":
            flags |= 1
            stored_method, stored_crc = 99, 0
            extra = struct.pack("<HHH2sBH", 0x9901, 7, 2, b"AE", 3, method)
            payload = aes_encrypt(b"secret", payload)
        offset = len(out)
        out += struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, flags, stored_method, 0, 0, stored_crc, len(payload), len(data), len(name), len(extra)) + name + extra + payload
        central += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, flags, stored_method, 0, 0, stored_crc, len(payload), len(data),
                               len(name), len(extra), 0, 0, 0, 0, offset) + name + extra
    start = len(out)
    out += central + struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(entries), len(entries), len(central), start, 0)
    return bytes(out)


class ExtractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.alice.bucket_id)
        self.client = Client(self.app)
        self.auth = await self.client.login("user", "alice@example.com", "alice password")

    async def asyncTearDown(self):
        await self.app.archives.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    async def post(self, route, body, prefix="/api/user/v1"):
        status, _, data = await self.client.request("POST", prefix + route, json.dumps(body).encode(), self.auth)
        return status, json.loads(data)

    async def put(self, key, data):
        await self.app.objects.put_object(self.scope, key, data, len(data), "application/octet-stream")

    async def read(self, key):
        info, stream = await self.app.objects.get_object(self.scope, key)
        return b"".join([chunk async for chunk in stream])

    def keys(self, prefix):
        return sorted(row["key"] for row in self.app.metadata.db.execute("SELECT key FROM objects WHERE bucket_id=? AND substr(key,1,?)=?", (self.alice.bucket_id, len(prefix), prefix)))

    async def extract(self, body, prefix="/api/user/v1"):
        status, job = await self.post("/archive/extract", body, prefix)
        self.assertEqual(status, 201, job)
        async with asyncio.timeout(30):
            while True:
                status, _, data = await self.client.request("GET", f"{prefix}/archive/jobs?ids={job['id']}", headers=self.auth)
                job = json.loads(data)["jobs"][0]
                if job["status"] not in ("queued", "running"):
                    return job
                await asyncio.sleep(0.02)

    async def test_zip_methods_names_and_structure(self):
        big = os.urandom(200_000) + b"x" * 300_000
        lzma_buffer = io.BytesIO()
        with zipfile.ZipFile(lzma_buffer, "w") as archive:
            archive.writestr("lzma/数据.txt", b"lzma content" * 1000, compress_type=zipfile.ZIP_LZMA)
            archive.writestr("lzma/", b"")
        data = build_zip([
            ("照片/".encode("gbk"), b"", 0, None, False),
            ("照片/春节.txt".encode("gbk"), "你好".encode(), 8, None, False),
            (b"stored.bin", b"plain", 0, None, True),
            (b"big.bin", big, 8, None, True),
            (b"bz.txt", b"bz2 data" * 100, 12, None, True),
            (b"../evil.txt", b"no", 0, None, True),
            (b"__MACOSX/._x", b"junk", 0, None, True),
        ])
        await self.put("包/test.zip", data)
        await self.put("包/l.zip", lzma_buffer.getvalue())
        status, info = await self.post("/archive/inspect", {"path": "包/test.zip", "destination": "包/test/"})
        self.assertEqual(status, 200, info)
        self.assertEqual((info["format"], info["files"], info["encrypted"], info["unsafe"], info["conflicts"]), ("zip", 4, False, 1, 0))
        self.assertIn({"name": "照片/春节.txt", "size": 6, "dir": False}, info["entries"])
        job = await self.extract({"path": "包/test.zip", "destination": "包/test/"})
        self.assertEqual((job["status"], job["done_files"], job["failed"]), ("completed", 4, 0), job)
        self.assertEqual(self.keys("包/test/"), ["包/test/big.bin", "包/test/bz.txt", "包/test/stored.bin", "包/test/照片/", "包/test/照片/春节.txt"])
        self.assertEqual(await self.read("包/test/big.bin"), big)
        self.assertEqual((await self.read("包/test/照片/春节.txt")).decode(), "你好")
        self.assertEqual(self.keys("包/evil"), [])
        job = await self.extract({"path": "包/l.zip", "destination": ""})
        self.assertEqual(job["status"], "completed", job)
        self.assertEqual(await self.read("lzma/数据.txt"), b"lzma content" * 1000)
        # 原压缩包保留。
        self.assertIn("包/test.zip", self.keys("包/"))

    async def test_passwords_conflicts_and_removing_archive(self):
        data = build_zip([(b"a.txt", b"alpha" * 100, 8, "zipcrypto", True), (b"b.txt", b"beta" * 100, 0, "aes", True)])
        await self.put("p.zip", data)
        status, info = await self.post("/archive/inspect", {"path": "p.zip"})
        self.assertEqual((info["encrypted"], info["encryption"]), (True, "aes"))
        status, info = await self.post("/archive/inspect", {"path": "p.zip", "password": "wrong"})
        self.assertFalse(info["password_ok"])
        status, error = await self.post("/archive/extract", {"path": "p.zip", "destination": "out/"})
        self.assertEqual(status, 400)
        self.assertIn("密码", error["error"]["message"])
        status, error = await self.post("/archive/extract", {"path": "p.zip", "destination": "out/", "password": "wrong"})
        self.assertEqual(status, 400)
        await self.put("out/a.txt", b"old")
        job = await self.extract({"path": "p.zip", "destination": "out/", "password": "secret", "conflict": "skip"})
        self.assertEqual((job["status"], job["done_files"], job["skipped"]), ("completed", 1, 1), job)
        self.assertEqual(await self.read("out/a.txt"), b"old")
        self.assertEqual(await self.read("out/b.txt"), b"beta" * 100)
        job = await self.extract({"path": "p.zip", "destination": "out/", "password": "secret", "conflict": "rename"})
        self.assertEqual(job["renamed"], 2)
        self.assertEqual(await self.read("out/a (1).txt"), b"alpha" * 100)
        job = await self.extract({"path": "p.zip", "destination": "out/", "password": "secret", "conflict": "overwrite", "keep_archive": False})
        self.assertEqual((job["status"], job["archive_removed"]), ("completed", True), job)
        self.assertEqual(await self.read("out/a.txt"), b"alpha" * 100)
        self.assertNotIn("p.zip", self.keys(""))
        # 原压缩包在回收站里，可以还原。
        self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM trash WHERE original_path='p.zip'").fetchone()[0], 1)

    async def test_corrupt_entry_fails_alone_and_keeps_archive(self):
        data = bytearray(build_zip([(b"good.txt", b"good" * 50, 8, None, True), (b"bad.txt", b"bad" * 50, 0, None, True)]))
        position = data.find(b"bad" * 50)
        data[position] ^= 0xFF
        await self.put("c.zip", bytes(data))
        job = await self.extract({"path": "c.zip", "destination": "c/", "keep_archive": False})
        self.assertEqual((job["status"], job["done_files"], job["failed"], job["archive_removed"]), ("completed", 1, 1, False), job)
        self.assertIn("校验失败", job["failures"][0]["error"])
        self.assertEqual(self.keys("c/"), ["c/good.txt"])

    async def test_tar_family_and_single_gz(self):
        buffer = io.BytesIO()
        long_name = "深/" + "很长的目录名" * 20 + "/文件.txt"
        with tarfile.open(fileobj=buffer, mode="w:gz", format=tarfile.GNU_FORMAT) as archive:
            for name, content in (("目录/a.txt", b"A" * 1000), (long_name, b"long")):
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
            folder = tarfile.TarInfo("空目录")
            folder.type = tarfile.DIRTYPE
            archive.addfile(folder)
            link = tarfile.TarInfo("链接")
            link.type, link.linkname = tarfile.SYMTYPE, "目录/a.txt"
            archive.addfile(link)
        await self.put("t.tar.gz", buffer.getvalue())
        status, info = await self.post("/archive/inspect", {"path": "t.tar.gz"})
        self.assertEqual((info["format"], info["listable"]), ("tar.gz", False))
        job = await self.extract({"path": "t.tar.gz", "destination": "t/"})
        self.assertEqual((job["status"], job["done_files"], job["failed"]), ("completed", 2, 1), job)
        self.assertEqual(await self.read("t/目录/a.txt"), b"A" * 1000)
        self.assertEqual(await self.read("t/" + long_name), b"long")
        self.assertIn("t/空目录/", self.keys("t/"))
        pax = io.BytesIO()
        with tarfile.open(fileobj=pax, mode="w:xz", format=tarfile.PAX_FORMAT) as archive:
            info = tarfile.TarInfo("pax/" + "名" * 120 + ".txt")
            info.size = 3
            archive.addfile(info, io.BytesIO(b"pax"))
        await self.put("x.tar.xz", pax.getvalue())
        job = await self.extract({"path": "x.tar.xz", "destination": ""})
        self.assertEqual(job["status"], "completed", job)
        self.assertEqual(await self.read("pax/" + "名" * 120 + ".txt"), b"pax")
        await self.put("notes.txt.gz", zlib.compress(b"hello", wbits=31))
        job = await self.extract({"path": "notes.txt.gz", "destination": ""})
        self.assertEqual(await self.read("notes.txt"), b"hello")

    async def test_unsupported_quota_and_bad_destination(self):
        await self.put("a.7z", b"7z\xbc\xaf\x27\x1c" + b"\0" * 32)
        status, error = await self.post("/archive/inspect", {"path": "a.7z"})
        self.assertEqual(status, 400)
        self.assertIn("7z", error["error"]["message"])
        data = build_zip([(b"huge.bin", b"\0" * 2_000_000, 8, None, True)])
        await self.put("q.zip", data)
        self.app.accounts.set_quota(self.alice.id, len(data) + 1000)
        status, error = await self.post("/archive/extract", {"path": "q.zip", "destination": "q/"})
        self.assertNotIn(status, (200, 201))
        self.assertIn("空间不足", error["error"]["message"])
        for destination in ("../x/", ".tgdrive/x/", "/abs/"):
            status, _ = await self.post("/archive/extract", {"path": "q.zip", "destination": destination})
            self.assertIn(status, (400, 403), destination)
        status, _ = await self.post("/archive/extract", {"path": "q.zip", "destination": "", "conflict": "merge"})
        self.assertEqual(status, 400)

    async def test_browse_zip_and_read_single_entry(self):
        data = build_zip([("文档/".encode(), b"", 0, None, True), ("文档/说明.md".encode(), "# 标题\n".encode() * 50, 8, None, True),
                          (b"raw.bin", b"plain bytes", 0, None, True), (b"secret.txt", b"hidden" * 10, 8, "zipcrypto", True),
                          (b"../evil.txt", b"no", 0, None, True)])
        await self.put("包/b.zip", data)
        status, listing = await self.post("/archive/browse", {"path": "包/b.zip"})
        self.assertEqual(status, 200, listing)
        self.assertTrue(listing["listable"])
        names = {item["name"]: item for item in listing["entries"]}
        self.assertEqual(sorted(names), ["raw.bin", "secret.txt", "文档/", "文档/说明.md"], "越界的条目不列出")
        self.assertTrue(names["secret.txt"]["encrypted"])
        md = names["文档/说明.md"]
        query = f"path={quote('包/b.zip')}&index={md['index']}&etag={listing['etag']}"
        status, headers, body = await self.client.request("GET", f"/api/user/v1/archive/entry?{query}", headers=self.auth)
        self.assertEqual((status, body.decode()), (200, "# 标题\n" * 50))
        self.assertEqual(headers["content-security-policy"], "sandbox")
        self.assertIn("filename*=UTF-8''%E8%AF%B4%E6%98%8E.md", headers["content-disposition"])
        # 加密条目、目录与过期的版本都拒绝。
        for index, etag in ((names["secret.txt"]["index"], listing["etag"]), (names["文档/"]["index"], listing["etag"]), (md["index"], "stale")):
            status, _, body = await self.client.request("GET", f"/api/user/v1/archive/entry?path={quote('包/b.zip')}&index={index}&etag={etag}", headers=self.auth)
            self.assertEqual(status, 400, body)
        # TAR 没有目录索引，不列出。
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            info = tarfile.TarInfo("a.txt"); info.size = 1; archive.addfile(info, io.BytesIO(b"a"))
        await self.put("包/t.tar", buffer.getvalue())
        status, listing = await self.post("/archive/browse", {"path": "包/t.tar"})
        self.assertEqual((status, listing["listable"], listing["format"]), (200, False, "tar"))

    async def compress(self, body, prefix="/api/user/v1"):
        status, job = await self.post("/archive/compress", body, prefix)
        self.assertEqual(status, 201, job)
        async with asyncio.timeout(30):
            while True:
                status, _, data = await self.client.request("GET", f"{prefix}/archive/jobs?ids={job['id']}", headers=self.auth)
                job = json.loads(data)["jobs"][0]
                if job["status"] not in ("queued", "running"):
                    return job
                await asyncio.sleep(0.02)

    async def test_compress_folders_and_files_into_zip(self):
        big = os.urandom(300_000)
        await self.put("项目/src/a.txt", b"hello " * 1000)
        await self.put("项目/src/深/b.bin", big)
        await self.put("项目/readme.md", b"# readme")
        job = await self.compress({"paths": ["项目/src/", "项目/readme.md"], "name": "打包"})
        self.assertEqual((job["status"], job["kind"], job["archive"], job["total_files"], job["done_files"]),
                         ("completed", "compress", "项目/打包.zip", 3, 3), job)
        with zipfile.ZipFile(io.BytesIO(await self.read("项目/打包.zip"))) as archive:
            self.assertEqual(sorted(archive.namelist()), ["readme.md", "src/a.txt", "src/深/b.bin"])
            self.assertEqual(archive.read("src/深/b.bin"), big)
            self.assertEqual(archive.getinfo("src/a.txt").compress_type, zipfile.ZIP_DEFLATED)
            self.assertLess(archive.getinfo("src/a.txt").compress_size, 1000, "可压缩的内容按 Deflate 变小")
        self.assertEqual(self.app.objects.head_object(self.scope, "项目/打包.zip").content_type, "application/zip")
        # 同名自动改名；不压缩也可以；保存位置不能在要压缩的文件夹里。
        job = await self.compress({"paths": ["项目/readme.md"], "name": "打包.zip", "compression": "store"})
        self.assertEqual((job["status"], job["archive"]), ("completed", "项目/打包 (1).zip"), job)
        with zipfile.ZipFile(io.BytesIO(await self.read("项目/打包 (1).zip"))) as archive:
            self.assertEqual(archive.getinfo("readme.md").compress_type, zipfile.ZIP_STORED)
        status, error = await self.post("/archive/compress", {"paths": ["项目/src/"], "name": "x", "destination": "项目/src/深/"})
        self.assertEqual(status, 400, error)
        status, error = await self.post("/archive/compress", {"paths": ["项目/src/"], "name": "a/b"})
        self.assertEqual(status, 400, error)
        audit = self.app.metadata.db.execute("SELECT target, detail FROM audit_log WHERE action='archive.compress'").fetchall()
        self.assertTrue(audit)
        self.assertTrue(all(row["target"] is None and "项目" not in (row["detail"] or "") for row in audit), "审计不记路径")

    async def test_private_space_extracts_with_unlock_and_stops_when_locked(self):
        status, _, data = await self.client.request("POST", "/api/user/v1/private/unlock", json.dumps({"password": "alice password"}).encode(), self.auth)
        self.assertEqual(status, 200, data)
        access = json.loads(data)["access"]
        await self.app.objects.put_object(Scope(self.alice.bucket_id, private_access=True), ".tgdrive/private/a.zip",
                                          build_zip([(b"x.txt", b"secret file", 8, None, True)]), None, "application/zip")
        self.auth = {**self.auth, "x-private-access": access}
        job = await self.extract({"path": ".tgdrive/private/a.zip", "destination": ".tgdrive/private/解压/"}, "/api/user/v1/private")
        self.assertEqual((job["status"], job["private"]), ("completed", True), job)
        self.assertEqual(self.keys(".tgdrive/private/解压/"), [".tgdrive/private/解压/x.txt"])
        # 普通接口看不到私密任务，也不能把私密压缩包解到普通位置。
        status, _, data = await self.client.request("GET", "/api/user/v1/archive/jobs", headers=self.auth)
        self.assertEqual(json.loads(data)["jobs"], [])
        status, _ = await self.post("/archive/extract", {"path": ".tgdrive/private/a.zip", "destination": "out/"}, "/api/user/v1/private")
        self.assertIn(status, (400, 403))

    async def test_private_space_requires_unlock(self):
        status, _ = await self.post("/archive/inspect", {"path": ".tgdrive/private/a.zip"})
        self.assertIn(status, (400, 403, 404, 423))
        status, _ = await self.post("/archive/inspect", {"path": ".tgdrive/private/a.zip"}, "/api/user/v1/private")
        self.assertIn(status, (401, 403, 423))


if __name__ == "__main__":
    unittest.main()
