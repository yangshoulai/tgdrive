"""M9：文件与文件夹移动语义。"""
import asyncio
import tempfile
import unittest
from pathlib import Path

from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.errors import NotFoundError
from tgdrive.metadata import Metadata
from tgdrive.objects import ObjectService, Scope


class MoveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.metadata = Metadata(root / "meta.db")
        engine = BlobEngine(self.metadata, LocalDiskBlobStore(root / "blobs"), b"0" * 32, chunk_size=32, frame_size=8)
        self.service = ObjectService(self.metadata, engine)
        self.scope = Scope(self.service.create_bucket("bucket"))

    async def asyncTearDown(self):
        self.metadata.close()
        self.temp.cleanup()

    async def put(self, *keys):
        for key in keys:
            if key.endswith("/"):
                await self.service.put_directory_marker(self.scope, key)
            else:
                await self.service.put_object(self.scope, key, key.encode())

    def keys(self):
        return sorted(item.key for item in self.service.list_objects(self.scope, "", None).objects)

    async def test_file_move_matches_exact_key_only(self):
        await self.put("a.txt", "a.txt.bak", "notes", "notes.txt")
        self.assertEqual(self.service.move(self.scope, "a.txt", "docs/a.txt").moved, 1)
        self.service.move(self.scope, "notes", "renamed")
        self.assertEqual(self.keys(), ["a.txt.bak", "docs/a.txt", "notes.txt", "renamed"])

    async def test_folder_move_carries_contents_and_public_links(self):
        await self.put("photos/", "photos/x.png", "photos/2026/y.png", "photoshop.psd", "archive/")
        token = self.service.set_public(self.scope, "photos/x.png", True).public_token
        result = self.service.move(self.scope, "photos/", "archive/photos/")
        self.assertEqual((result.moved, result.skipped), (3, 0))
        self.assertEqual(self.keys(), ["archive/", "archive/photos/", "archive/photos/2026/y.png", "archive/photos/x.png", "photoshop.psd"])
        self.assertEqual(self.service.resolve_public(token).key, "archive/photos/x.png")

    async def test_invalid_moves_are_rejected(self):
        await self.put("photos/", "photos/x.png", "a.txt")
        with self.assertRaises(ValueError):
            self.service.move(self.scope, "photos/", "photos/sub/")
        with self.assertRaises(ValueError):
            self.service.move(self.scope, "a.txt", "folder/")
        with self.assertRaises(NotFoundError):
            self.service.move(self.scope, "missing.txt", "b.txt")
        self.assertEqual(self.service.move(self.scope, "a.txt", "a.txt").moved, 0)

    async def test_conflicts_skip_merge_and_rename(self):
        await self.put("in/", "in/same.txt", "in/new.txt", "out/", "out/in/", "out/in/same.txt")
        result = self.service.move(self.scope, "in/", "out/in/", "skip")
        self.assertEqual((result.moved, result.skipped), (1, 1))
        # 冲突文件留在原处；同名目录标记被合并，不计入冲突。
        self.assertEqual(self.keys(), ["in/same.txt", "out/", "out/in/", "out/in/new.txt", "out/in/same.txt"])

        await self.put("x.txt", "dest/x.txt", "dest/x (1).txt")
        self.service.move(self.scope, "x.txt", "dest/x.txt", "rename")
        self.assertIn("dest/x (2).txt", self.keys())


if __name__ == "__main__":
    unittest.main()
