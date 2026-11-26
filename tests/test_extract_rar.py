"""用 RARLAB 生成的样本验证单包、密码分卷和写入前的完整性校验。"""

import asyncio
import os
import unittest
from pathlib import Path
from random import Random

from tests.test_extract_7z import MemoryObjects
from tgdrive.extract import ArchiveError, ArchiveService, ordered_archive_volumes
from tgdrive.objects import Scope
from tgdrive.rar_worker import LIBRARY

FIXTURES = Path(__file__).with_name("fixtures") / "rar"
DESCRIPTION = "验收 RAR\n".encode()
PASSPHRASE = "fixture"


class RarVolumeTests(unittest.TestCase):
    def test_order_by_number_and_reject_missing_or_mixed_volumes(self):
        for paths in (["a/资料.part02.RAR", "a/资料.part01.rar"], ["a/资料.r00", "a/资料.rar"]):
            with self.subTest(paths=paths):
                self.assertEqual(ordered_archive_volumes(paths[0], paths), ("rar", list(reversed(paths))))
        for paths in (["a/资料.part01.rar", "a/资料.part03.rar"], ["a/资料.rar", "b/资料.r00"]):
            with self.subTest(paths=paths), self.assertRaises(ArchiveError):
                ordered_archive_volumes(paths[0], paths)


@unittest.skipUnless(Path(os.environ.get("TGDRIVE_RAR_LIBRARY") or LIBRARY).is_file(), "需要 Tessera RAR 解码库")
class RarExtractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = MemoryObjects({path.name: path.read_bytes() for path in FIXTURES.glob("*.rar")})
        self.archives = ArchiveService(self.store)
        self.scope = Scope(1)

    async def asyncTearDown(self):
        await self.archives.stop()

    async def extract(self, path, password=None, *, volumes=None):
        result = await self.archives.start(1, self.scope, path, "output/", password, "overwrite", False, volumes=volumes)
        job = self.archives.jobs[result["id"]]
        await asyncio.wait_for(job.task, 20)
        return job

    async def test_single_archive_and_verified_output(self):
        path = "simple.rar"
        info = await self.archives.browse(self.scope, path)
        self.assertEqual((info["format"], info["listable"]), ("rar", False))
        job = await self.extract(path)
        self.assertEqual((job.status, job.done_files, job.archive_removed), ("completed", 2, True), job.error)
        self.assertEqual(self.store.objects["output/文档.txt"], DESCRIPTION)
        self.assertEqual(self.store.objects["output/empty.txt"], b"")

        self.store.objects[path] = self.store.objects[path].replace(DESCRIPTION, b"x" * len(DESCRIPTION))
        self.store.objects["output/文档.txt"] = b"existing"
        self.store.trash.reset_mock()
        job = await self.extract(path)
        self.assertEqual(job.status, "failed")
        self.assertEqual(self.store.objects["output/文档.txt"], b"existing")
        self.store.trash.assert_not_awaited()

    async def test_encrypted_volumes_retry_and_check_last_volume(self):
        first, last = "encrypted.part1.rar", "encrypted.part2.rar"
        paths = [last, first]
        for password, volumes, password_error in ((None, paths, True), ("wrong", paths, True), (PASSPHRASE, [first], False)):
            with self.subTest(volumes=volumes, password_error=password_error):
                job = await self.extract(volumes[0], password, volumes=volumes)
                self.assertEqual((job.status, job.password_error, job.done_files), ("failed", password_error, 0), job.error)
                self.assertNotIn("output/payload.bin", self.store.objects)
        job = await self.extract(last, PASSPHRASE, volumes=paths)
        self.assertEqual((job.status, job.done_files, job.keep_archive), ("completed", 1, True), job.error)
        self.assertEqual(self.store.objects["output/payload.bin"], Random(919).randbytes(2300))
        self.store.trash.assert_not_awaited()
