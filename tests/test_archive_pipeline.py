"""用内存存储验证大包解压的输出分块、磁盘预算和清理。"""

import asyncio
import errno
import io
import os
import tarfile
import tempfile
import unittest
import zipfile
import zlib
from contextlib import aclosing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tests.test_extract_7z import MemoryObjects
from tgdrive.archive_staging import FRAME_SIZE, OVERHEAD, ArchiveStaging
from tgdrive.extract import CHUNK, ArchiveError, ArchiveService, decompressed
from tgdrive.objects import Scope
from tgdrive.work import TransferSlots


def stored_zip() -> tuple[bytes, bytes]:
    payload = b"x" * (FRAME_SIZE + 17)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("data.txt", payload)
    return buffer.getvalue(), payload


class PipelineObjects(MemoryObjects):
    def __init__(self, objects):
        super().__init__(objects)
        self.transfers = TransferSlots(1, 1, 0.2)
        self.ranges = []
        self.write_error = None
        self.pause_at = None
        self.downloading = asyncio.Event()

    async def get_object(self, scope, key, start, end):
        self.ranges.append((key, start, end))
        info = self.head_object(scope, key)

        async def stream():
            async with self.transfers.slot(scope.bucket_id):
                for offset in range(start, end, FRAME_SIZE):
                    if self.pause_at == (start, end, offset):
                        self.downloading.set()
                        await asyncio.Future()
                    yield self.objects[key][offset:min(offset + FRAME_SIZE, end)]

        return info, stream()

    async def put_object(self, scope, key, body, size, content_type, *, buffered=False):
        async def consume():
            async for piece in body:
                if len(piece) > CHUNK:
                    raise AssertionError("解压输出块大于限制")
                if self.write_error is not None:
                    raise self.write_error
                yield piece

        async with aclosing(consume()) as chunks:
            if buffered:
                await super().put_object(scope, key, chunks, size, content_type, buffered=True)
            else:
                async with self.transfers.slot(scope.bucket_id):
                    await super().put_object(scope, key, chunks, size, content_type)


class ArchivePipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_gzip_output_is_bounded_and_truncation_fails(self):
        block = b"a" * CHUNK
        compressor = zlib.compressobj(wbits=31)
        data = b"".join(compressor.compress(block) for _ in range(24)) + compressor.flush()

        async def chunks(payload):
            yield payload

        count, largest = 0, 0
        async for piece in decompressed(chunks(data), "gz"):
            count += len(piece)
            largest = max(largest, len(piece))
        self.assertEqual((count, largest), (24 * CHUNK, CHUNK))
        with self.assertRaisesRegex(ArchiveError, "不完整"):
            async for _ in decompressed(chunks(data[:-5]), "gz"):
                pass

    async def test_zip_and_tar_gz_read_with_one_transfer_slot(self):
        archive, contents = stored_zip()
        tar = io.BytesIO()
        with tarfile.open(fileobj=tar, mode="w:gz") as bundle:
            member = tarfile.TarInfo("data.txt")
            member.size = len(contents)
            bundle.addfile(member, io.BytesIO(contents))
        for path, data in (("large.zip", archive), ("large.tar.gz", tar.getvalue())):
            with self.subTest(path=path):
                store = PipelineObjects({path: data})
                service = ArchiveService(store)
                self.addAsyncCleanup(service.stop)
                started = await service.start(1, Scope(1), path, "out/", None, "rename", True)
                job = service.jobs[started["id"]]
                await asyncio.wait_for(job.task, 5)
                self.assertEqual(job.status, "completed", job.error)
                self.assertEqual(store.objects["out/data.txt"], contents)

    async def test_disk_budget_reserves_space_before_concurrent_downloads(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            reserve = 4 * FRAME_SIZE
            size = 2 * FRAME_SIZE
            disk = ArchiveStaging(path, lambda: reserve)
            free = reserve + size + 2 * OVERHEAD + FRAME_SIZE
            with patch("tgdrive.archive_staging.shutil.disk_usage", return_value=SimpleNamespace(free=free)):
                async with disk.allocate(size) as first:
                    self.assertIsNotNone(first)
                    async with disk.allocate(size) as second:
                        self.assertIsNone(second)
                    block = b"archive input" * 11
                    block = block.ljust(FRAME_SIZE, b"a")
                    await first.append(block)
                    await first.append(block)
                    self.assertEqual(await first.read(FRAME_SIZE - 3, FRAME_SIZE + 5), block[-3:] + block[:5])
                    first.file.seek(0)
                    self.assertNotIn(block[:100], first.file.read(FRAME_SIZE))
                    if os.name == "posix":
                        self.assertEqual(os.fstat(first.file.fileno()).st_nlink, 0)
                self.assertTrue(first.file.closed)
                async with disk.allocate(size) as next_job:
                    self.assertIsNotNone(next_job)
            self.assertEqual(list(path.iterdir()), [])

    async def test_staging_fallback_failure_and_shutdown_close_the_file(self):
        archive, contents = stored_zip()
        # 每个场景使用自己的对象、预算和匿名临时文件。
        for mode in ("staged", "no_space", "space_changed", "write_error", "stop"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                store = PipelineObjects({"large.zip": archive})
                staging = ArchiveStaging(Path(directory), lambda: 0)
                service = ArchiveService(store, staging=staging)
                if mode == "write_error":
                    store.write_error = OSError(errno.ENOSPC, "fixture")
                if mode == "stop":
                    store.pause_at = (0, len(archive), FRAME_SIZE)
                choices = {"no_space": [False], "space_changed": [True, True, False],
                           "staged": [True] * 3, "write_error": [True] * 3, "stop": [True] * 2}
                files = []
                original = tempfile.TemporaryFile

                def open_temp(*args, _original=original, _files=files, **kwargs):
                    file = _original(*args, **kwargs)
                    _files.append(file)
                    return file

                # 记录真实文件描述符的关闭结果，磁盘空间判断使用可控快照。
                with (patch.object(staging, "_has_space", side_effect=choices[mode]),
                      patch("tgdrive.extract.STAGE_MIN_SIZE", 1),
                      patch("tgdrive.archive_staging.tempfile.TemporaryFile", side_effect=open_temp)):
                    try:
                        started = await service.start(1, Scope(1), "large.zip", "out/", None, "rename", False)
                        job = service.jobs[started["id"]]
                        mark = len(store.ranges)
                        if mode == "stop":
                            await asyncio.wait_for(store.downloading.wait(), 5)
                            self.assertTrue(job.public()["staging"])
                            await asyncio.wait_for(service.stop(), 5)
                            self.assertTrue(job.task.done())
                        else:
                            await asyncio.wait_for(job.task, 5)
                    finally:
                        await service.stop()
                self.assertEqual(len(files), int(mode != "no_space"))
                self.assertTrue(all(file.closed for file in files))
                self.assertEqual(list(Path(directory).iterdir()), [])
                if mode == "stop":
                    self.assertEqual(job.status, "cancelled")
                    store.trash.assert_not_awaited()
                elif mode == "write_error":
                    self.assertEqual(job.status, "failed")
                    self.assertIn("服务器磁盘空间不足", job.error)
                    self.assertNotIn("out/data.txt", store.objects)
                    store.trash.assert_not_awaited()
                else:
                    self.assertEqual(job.status, "completed", job.error)
                    self.assertEqual(store.objects["out/data.txt"], contents)
                    if mode == "staged":
                        self.assertEqual(store.ranges[mark:], [("large.zip", 0, len(archive))])
