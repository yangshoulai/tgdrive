"""用跨卷的 LZMA2 样本验证在线解压，存储以字节对象代替，不建数据库。"""

import hashlib
import random
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
            archive = subprocess.run(["bsdtar", "--format=7zip", "--options", "7zip:compression=lzma2", "-cf", "-", *cls.files],
                                     cwd=folder, capture_output=True, check=True).stdout
        width = (len(archive) + 2) // 3
        cls.volumes = {f"资料.7z.{index + 1:03d}": archive[start:start + width]
                       for index, start in enumerate(range(0, len(archive), width))}

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
