import hashlib
import tempfile
import unittest
from pathlib import Path

from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.keystore import KeyStore
from tgdrive.metadata import Metadata
from tgdrive.objects import ObjectService, Scope


class M3Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.metadata = Metadata(root / "meta.db")
        keys = KeyStore(self.metadata)
        keys.initialize("pass")
        self.engine = BlobEngine(self.metadata, LocalDiskBlobStore(root / "blobs"), keys.require_kek(),
                                 chunk_size=32, frame_size=8)
        self.service = ObjectService(self.metadata, self.engine)
        bucket = self.service.create_bucket("user-a")
        self.scope = Scope(bucket)

    async def asyncTearDown(self):
        self.metadata.close()
        self.temp.cleanup()

    async def test_object_copy_delete_move_and_scope(self):
        info = await self.service.put_object(self.scope, "docs/a.txt", b"hello", 5, "text/plain")
        self.assertEqual(info.etag, hashlib.md5(b"hello").hexdigest())
        copied = await self.service.copy_object(self.scope, "docs/a.txt", self.scope, "docs/b.txt")
        self.assertEqual(copied.blob_uuid, info.blob_uuid)
        await self.service.put_directory_marker(self.scope, "docs/sub")
        page = self.service.list_objects(self.scope, "docs/", "/", None, 100)
        self.assertEqual({x.key for x in page.objects}, {"docs/a.txt", "docs/b.txt"})
        self.assertEqual(page.common_prefixes, ["docs/sub/"])
        first = self.service.list_objects(self.scope, "docs/", None, None, 1)
        second = self.service.list_objects(self.scope, "docs/", None, first.next_cursor, 10)
        self.assertIsNotNone(first.next_cursor)
        self.assertEqual(len(first.objects) + len(second.objects), 3)
        await self.service.delete_objects(self.scope, ["docs/a.txt"])
        _, stream = await self.service.get_object(self.scope, "docs/b.txt")
        self.assertEqual(b"".join([part async for part in stream]), b"hello")
        self.assertEqual(self.service.move_prefix(self.scope, "docs/", "archive/", "skip"), 2)
        self.assertEqual(self.service.head_object(self.scope, "archive/b.txt").size, 5)

    async def test_multipart_and_quota(self):
        upload = await self.service.create_multipart(self.scope, "large.bin")
        body = b"multipart body"
        part = await self.service.upload_part(self.scope, upload, 1, body, len(body))
        result = await self.service.complete_multipart(self.scope, upload, [(1, part.etag)])
        self.assertTrue(result.etag.endswith("-1"))
        self.assertEqual((await self.service.get_object(self.scope, "large.bin"))[0].size, len(body))

        limited_bucket = self.service.create_bucket("limited", quota_bytes=3)
        limited = Scope(limited_bucket)
        with self.assertRaises(Exception):
            await self.service.put_object(limited, "too-large", b"four", 4)

        await self.service.put_object(self.scope, "replace", b"old", 3)
        await self.service.put_object(self.scope, "replace", b"new", 3)
        await self.service.delete_objects(self.scope, ["replace"])

    async def test_read_only_scope_rejected(self):
        with self.assertRaises(PermissionError):
            await self.service.put_object(Scope(self.scope.bucket_id, perms="ro"), "x", b"x", 1)


if __name__ == "__main__":
    unittest.main()
