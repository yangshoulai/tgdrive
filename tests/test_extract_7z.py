"""用 7z 单包和分卷样本验证在线解压，存储以字节对象代替。"""

import hashlib
import io
import lzma
import random
import secrets
import shutil
import subprocess
import tempfile
import unittest
from ctypes.util import find_library
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from tgdrive.errors import NotFoundError
from tgdrive.extract import ArchiveError, ArchiveService
from tgdrive.objects import ObjectService, Scope


def split_archive(archive: bytes, name: str) -> dict[str, bytes]:
    width = (len(archive) + 2) // 3
    return {f"{name}.{index + 1:03d}": archive[start:start + width]
            for index, start in enumerate(range(0, len(archive), width))}


def encrypted_archive(files: dict[str, bytes], password: str, header_encryption: bool, *, store: bool = False) -> bytes:
    import py7zr

    buffer = io.BytesIO()
    compression = {"id": py7zr.FILTER_COPY} if store else {"id": lzma.FILTER_LZMA2, "preset": 2}
    filters = [compression, {"id": py7zr.FILTER_CRYPTO_AES256_SHA256}]
    with py7zr.SevenZipFile(buffer, "w", password=password, header_encryption=header_encryption, filters=filters) as archive:
        for name, data in files.items():
            archive.writestr(data, name)
    return buffer.getvalue()


class MemoryObjects:
    _check_scope = staticmethod(ObjectService._check_scope)

    def __init__(self, objects):
        self.objects = dict(objects)
        self.metadata = SimpleNamespace(run_in_thread=self.run, db=MagicMock())
        self.metadata.db.execute.return_value.fetchone.return_value = None
        self.trash = AsyncMock()

    @staticmethod
    async def run(function, *args):
        return function(*args)

    def head_object(self, scope, key):
        self._check_scope(scope, key)
        if key not in self.objects:
            raise NotFoundError(key)
        data = self.objects[key]
        return SimpleNamespace(key=key, size=len(data), etag=hashlib.sha256(data).hexdigest())

    async def get_object(self, scope, key, start, end):
        info = self.head_object(scope, key)
        data = self.objects[key]
        async def stream():
            yield data[start:end]
        return info, stream()

    async def put_object(self, scope, key, body, size, content_type, *, buffered=False):
        self._check_scope(scope, key, write=True)
        data = b"".join([chunk async for chunk in body])
        if len(data) != size:
            raise ValueError("写入大小与声明不符")
        self.objects[key] = data

    @staticmethod
    def _quota_room(scope, key):
        return None


@unittest.skipUnless(shutil.which("bsdtar") and find_library("archive"), "需要支持 7z 的 libarchive 和 bsdtar")
class SevenZipExtractTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = {"跨卷.bin": random.Random(7).randbytes(800_000), "空文件.txt": b""}
        with tempfile.TemporaryDirectory() as folder:
            for name, data in cls.files.items():
                (Path(folder) / name).write_bytes(data)
            cls.archive = subprocess.run(["bsdtar", "--format=7zip", "--options", "7zip:compression=lzma2", "-cf", "-", *cls.files],
                                         cwd=folder, capture_output=True, check=True).stdout
        cls.volumes = split_archive(cls.archive, "资料.7z")

    async def asyncSetUp(self):
        self.store = MemoryObjects(self.volumes)
        self.archives = ArchiveService(self.store)
        self.scope = Scope(1)
        self.paths = list(self.volumes)
        self.first = self.paths[0]

    async def asyncTearDown(self):
        await self.archives.stop()

    async def submit(self):
        result = await self.archives.start(1, self.scope, self.first, "资料/", None, "rename", False,
                                           volumes=list(reversed(self.paths)))
        return self.archives.jobs[result["id"]]

    async def test_browse_and_extract_single_archive(self):
        name = "资料.7Z"
        self.store.objects[name] = self.archive
        info = await self.archives.inspect(self.scope, name, None, None)
        self.assertEqual((info["format"], info["size"], info["listable"]), ("7z", len(self.archive), False))
        listing = await self.archives.browse(self.scope, name)
        self.assertEqual((listing["format"], listing["listable"], listing["entries"]), ("7z", False, []))
        with self.assertRaisesRegex(ArchiveError, "整包解压"):
            await self.archives.start(1, self.scope, name, "资料/", None, "rename", False, [0])
        result = await self.archives.start(1, self.scope, name, "资料/", None, "rename", False)
        job = self.archives.jobs[result["id"]]

        async def trash(scope, keys):
            self.assertEqual(job.status, "running")

        self.store.trash.side_effect = trash
        await job.task
        self.assertEqual((job.status, job.done_files, job.archive_removed), ("completed", len(self.files), True), job.error)
        for filename, data in self.files.items():
            self.assertEqual(self.store.objects[f"资料/{filename}"], data)
        self.store.trash.assert_awaited_once_with(self.scope, [name])

    async def test_reject_truncated_archive_and_unselected_volumes(self):
        name = "截断.7z"
        self.store.objects[name] = self.archive[:32]
        with self.assertRaisesRegex(ArchiveError, "压缩包不完整"):
            await self.archives.inspect(self.scope, name, None, None)
        with self.assertRaisesRegex(ArchiveError, "选齐所有 7z 分卷"):
            await self.archives.start(1, self.scope, self.first, "资料/", None, "rename", True)
        self.assertFalse(self.archives.jobs)

    async def test_extract_reordered_volumes_and_keep_sources(self):
        info = await self.archives.inspect(self.scope, self.first, None, None, volumes=self.paths)
        self.assertEqual((info["format"], info["size"], info["listable"]), ("7z", sum(map(len, self.volumes.values())), False))
        job = await self.submit()
        await job.task
        self.assertEqual((job.status, job.done_files, job.keep_archive), ("completed", len(self.files), True), job.error)
        for name, data in self.files.items():
            self.assertEqual(self.store.objects[f"资料/{name}"], data)
        for path, data in self.volumes.items():
            self.assertEqual(self.store.objects[path], data)
        self.store.trash.assert_not_awaited()

    async def test_reject_missing_middle_or_last_volume(self):
        for paths, message in ((self.paths[::2], "连续分卷"), (self.paths[:-1], "分卷不完整")):
            with self.subTest(paths=paths), self.assertRaisesRegex(ArchiveError, message):
                await self.archives.start(1, self.scope, self.first, "资料/", None, "rename", True, volumes=paths)
        self.assertFalse(self.archives.jobs)

    async def test_stop_when_volume_changed_after_submission(self):
        job = await self.submit()
        self.store.objects[self.paths[-1]] += b"changed"
        await job.task
        self.assertEqual(job.status, "failed", job.error)
        self.assertIn("分卷已被修改", job.error)
        self.assertEqual(set(self.store.objects), set(self.paths))


class SevenZipPasswordTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.password = secrets.token_urlsafe(16) + "密码 "
        cls.files = {"材料/跨卷.bin": random.Random(17).randbytes(1_600_000), "空文件.txt": b""}
        # 仅加密的存储条目用错密码时仍可输出同样长度的数据，必须等 CRC 通过才能提交。
        cls.cases = {}
        for encrypt_names in (False, True):
            archive = encrypted_archive(cls.files, cls.password, encrypt_names, store=not encrypt_names)
            cls.cases[encrypt_names, False] = {"加密.7z": archive}
            cls.cases[encrypt_names, True] = split_archive(archive, "加密.7z")

    async def extract(self, sources, password, *, split):
        store = MemoryObjects(sources)
        service = ArchiveService(store)
        paths = list(sources)
        result = await service.start(1, Scope(1), paths[0], "结果/", password, "rename", True, volumes=paths[::-1] if split else None)
        job = service.jobs[result["id"]]
        await job.task
        return store, job.public()

    async def test_correct_password_for_content_and_encrypted_names(self):
        for (encrypt_names, split), sources in self.cases.items():
            with self.subTest(encrypt_names=encrypt_names, split=split):
                store, job = await self.extract(sources, self.password, split=split)
                self.assertEqual((job["status"], job["done_files"], job["password_error"]), ("completed", 2, False), job)
                self.assertNotIn(self.password, str(job))
                store.trash.assert_not_awaited()
                for filename, expected in self.files.items():
                    self.assertEqual(store.objects[f"结果/{filename}"], expected)

    async def test_wrong_password_leaves_no_unverified_file(self):
        for (encrypt_names, split), sources in self.cases.items():
            with self.subTest(encrypt_names=encrypt_names, split=split):
                store, job = await self.extract(sources, secrets.token_urlsafe(16), split=split)
                self.assertEqual((job["status"], job["done_bytes"], job["password_error"]), ("failed", 0, True), job)
                self.assertIn("密码不正确", job["error"])
                self.assertEqual(store.objects, sources)

    @unittest.skipUnless(find_library("archive"), "需要支持 7z 的 libarchive")
    async def test_missing_password_can_retry(self):
        for (encrypt_names, split), sources in self.cases.items():
            with self.subTest(encrypt_names=encrypt_names, split=split):
                store, job = await self.extract(sources, None, split=split)
                self.assertEqual((job["status"], job["password_error"]), ("failed", True), job)
                self.assertIn("需要密码", job["error"])
                self.assertEqual(store.objects, sources)
