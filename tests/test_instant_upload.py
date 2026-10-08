"""秒传：内容指纹随写入计算，同一存储桶内相同内容直接引用已有 Blob。"""
import asyncio
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.errors import QuotaExceededError
from tgdrive.fingerprint import BlockHasher, combine
from tgdrive.keystore import KeyStore
from tgdrive.metadata import Metadata
from tgdrive.objects import ObjectService, Scope

BLOCK = 64  # 测试用的小分块


def reference(data: bytes, block: int = BLOCK) -> str:
    """按文档约定的算法独立计算指纹，用来校验服务端的实现。"""
    leaves = b"".join(hashlib.sha256(data[i:i + block]).digest() for i in range(0, len(data), block))
    return hashlib.sha256(b"tgdrive-fp-v1\n" + len(data).to_bytes(8, "big") + leaves).hexdigest()


class FingerprintTests(unittest.TestCase):
    def test_hasher_matches_reference_for_any_chunking(self):
        data = os.urandom(BLOCK * 5 + 17)
        for step in (1, 7, BLOCK - 1, BLOCK, BLOCK + 1, len(data)):
            hasher = BlockHasher(BLOCK)
            for i in range(0, len(data), step):
                hasher.update(data[i:i + step])
            self.assertEqual(combine(len(data), hasher.finish()), reference(data), step)

    def test_exact_multiple_has_no_trailing_empty_block(self):
        hasher = BlockHasher(BLOCK)
        hasher.update(b"x" * BLOCK * 2)
        self.assertEqual(len(hasher.finish()), 64)


class InstantUploadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.metadata = Metadata(root / "meta.db")
        keys = KeyStore(self.metadata)
        keys.initialize("pass")
        self.engine = BlobEngine(self.metadata, LocalDiskBlobStore(root / "blobs"), keys.require_kek(),
                                 chunk_size=BLOCK, frame_size=16)
        self.engine.fingerprint_block = BLOCK
        self.service = ObjectService(self.metadata, self.engine)
        self.service.MIN_PART_SIZE = 1
        self.scope = Scope(self.service.create_bucket("user-a"))
        self.other = Scope(self.service.create_bucket("user-b"))

    async def asyncTearDown(self):
        self.metadata.close()
        self.temp.cleanup()

    def blob_count(self):
        return self.metadata.db.execute("SELECT COUNT(*) FROM blobs").fetchone()[0]

    async def test_single_put_hit_shares_blob_without_new_data(self):
        data = os.urandom(BLOCK * 3 + 5)
        first = await self.service.put_object(self.scope, "a/one.bin", data, len(data), "application/x-test")
        hit = self.service.instant_put(self.scope, "b/two.bin", len(data), reference(data))
        self.assertIsNotNone(hit)
        self.assertEqual((hit.etag, hit.size), (first.etag, first.size))
        self.assertEqual(hit.content_type, "application/x-test")
        self.assertEqual(self.blob_count(), 1)
        refcount = self.metadata.db.execute("SELECT refcount FROM blobs").fetchone()[0]
        self.assertEqual(refcount, 2)
        stream = (await self.service.get_object(self.scope, "b/two.bin"))[1]
        self.assertEqual(b"".join([piece async for piece in stream]), data)

    async def test_deleting_one_copy_keeps_the_other_readable(self):
        data = os.urandom(BLOCK * 2)
        await self.service.put_object(self.scope, "a.bin", data, len(data))
        self.service.instant_put(self.scope, "b.bin", len(data), reference(data))
        await self.service.delete_objects(self.scope, ["a.bin"])
        stream = (await self.service.get_object(self.scope, "b.bin"))[1]
        self.assertEqual(b"".join([piece async for piece in stream]), data)

    async def test_miss_on_unknown_content_or_wrong_size(self):
        data = os.urandom(BLOCK + 1)
        await self.service.put_object(self.scope, "a.bin", data, len(data))
        self.assertIsNone(self.service.instant_put(self.scope, "b.bin", len(data), reference(os.urandom(BLOCK + 1))))
        self.assertIsNone(self.service.instant_put(self.scope, "b.bin", len(data) + 1, reference(data)))

    async def test_never_matches_other_buckets_or_outside_scope_prefix(self):
        data = os.urandom(BLOCK * 2)
        await self.service.put_object(self.scope, "private/a.bin", data, len(data))
        self.assertIsNone(self.service.instant_put(self.other, "copy.bin", len(data), reference(data)))
        narrow = Scope(self.scope.bucket_id, prefix="public/")
        self.assertIsNone(self.service.instant_put(narrow, "public/copy.bin", len(data), reference(data)))

    async def test_trash_internal_prefix_is_ignored(self):
        data = os.urandom(BLOCK * 2)
        await self.service.put_object(self.scope, "a.bin", data, len(data))
        await self.service.trash(self.scope, ["a.bin"])
        self.assertIsNone(self.service.instant_put(self.scope, "b.bin", len(data), reference(data)))

    async def test_overwrite_keeps_public_link(self):
        data = os.urandom(BLOCK * 2)
        await self.service.put_object(self.scope, "a.bin", data, len(data))
        await self.service.put_object(self.scope, "b.bin", b"old", 3)
        token = self.service.set_public(self.scope, "b.bin", True).public_token
        hit = self.service.instant_put(self.scope, "b.bin", len(data), reference(data))
        self.assertEqual(hit.public_token, token)

    async def test_quota_is_still_enforced(self):
        data = os.urandom(BLOCK * 2)
        await self.service.put_object(self.scope, "a.bin", data, len(data))
        self.metadata.db.execute("UPDATE buckets SET quota_bytes = ? WHERE id = ?", (len(data) + 10, self.scope.bucket_id))
        self.metadata.db.commit()
        with self.assertRaises(QuotaExceededError):
            self.service.instant_put(self.scope, "b.bin", len(data), reference(data))

    async def test_same_path_reupload_is_safe(self):
        data = os.urandom(BLOCK * 2)
        await self.service.put_object(self.scope, "a.bin", data, len(data))
        self.assertIsNotNone(self.service.instant_put(self.scope, "a.bin", len(data), reference(data)))
        self.assertEqual(self.metadata.db.execute("SELECT refcount FROM blobs").fetchone()[0], 1)
        stream = (await self.service.get_object(self.scope, "a.bin"))[1]
        self.assertEqual(b"".join([piece async for piece in stream]), data)

    async def test_multipart_aligned_parts_produce_same_fingerprint(self):
        data = os.urandom(BLOCK * 5 + 9)
        upload = await self.service.create_multipart(self.scope, "big.bin")
        sizes = [BLOCK * 2, BLOCK * 2, BLOCK + 9]
        parts, offset = [], 0
        for number, size in enumerate(sizes, 1):
            info = await self.service.upload_part(self.scope, upload, number, data[offset:offset + size], size)
            parts.append((number, info.etag))
            offset += size
        await self.service.complete_multipart(self.scope, upload, parts)
        hit = self.service.instant_put(self.scope, "again.bin", len(data), reference(data))
        self.assertIsNotNone(hit)
        self.assertEqual(self.blob_count(), 1)

    async def test_multipart_parts_can_arrive_out_of_order(self):
        data = os.urandom(BLOCK * 3 + 1)
        upload = await self.service.create_multipart(self.scope, "big.bin")
        sizes = [BLOCK, BLOCK, BLOCK + 1]
        slices = [data[:BLOCK], data[BLOCK:BLOCK * 2], data[BLOCK * 2:]]
        etags = {}
        for number in (3, 1, 2):
            etags[number] = (await self.service.upload_part(self.scope, upload, number, slices[number - 1], sizes[number - 1])).etag
        await self.service.complete_multipart(self.scope, upload, [(n, etags[n]) for n in (1, 2, 3)])
        self.assertIsNotNone(self.service.instant_put(self.scope, "x.bin", len(data), reference(data)))

    async def test_multipart_unaligned_parts_get_no_fingerprint(self):
        data = os.urandom(BLOCK * 3)
        upload = await self.service.create_multipart(self.scope, "odd.bin")
        sizes = [BLOCK + 8, BLOCK + 8, BLOCK * 3 - 2 * (BLOCK + 8)]
        parts, offset = [], 0
        for number, size in enumerate(sizes, 1):
            info = await self.service.upload_part(self.scope, upload, number, data[offset:offset + size], size)
            parts.append((number, info.etag))
            offset += size
        await self.service.complete_multipart(self.scope, upload, parts)
        self.assertIsNone(self.service.instant_put(self.scope, "x.bin", len(data), reference(data)))

    async def test_server_side_copy_keeps_fingerprint(self):
        data = os.urandom(BLOCK * 2)
        await self.service.put_object(self.scope, "a.bin", data, len(data))
        await self.service.copy_object(self.scope, "a.bin", self.scope, "copy.bin")
        await self.service.delete_objects(self.scope, ["a.bin"])
        self.assertIsNotNone(self.service.instant_put(self.scope, "c.bin", len(data), reference(data)))

    async def test_invalid_input_and_empty_files_are_rejected(self):
        with self.assertRaises(ValueError):
            self.service.instant_put(self.scope, "a.bin", 10, "nothex")
        with self.assertRaises(ValueError):
            self.service.instant_put(self.scope, "a.bin", 0, reference(b""))


class InstantUploadHttpTests(unittest.TestCase):
    """网页接口与访问密钥接口使用同一套指纹算法；默认 16 MiB 分块在小文件上就是单块。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.alice = self.app.accounts.create_user("alice", "alice password")
        self.bob = self.app.accounts.create_user("bob", "bob password")
        self.client = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def test_web_api_hit_miss_and_isolation(self):
        data = b"hello instant world" * 100
        fp = reference(data, 16 * 1024 * 1024)

        async def run():
            alice = await self.client.login("user", "alice", "alice password")
            bob = await self.client.login("user", "bob", "bob password")
            status, _, _ = await self.client.request("PUT", "/api/user/v1/files?path=a/one.txt", data,
                                                     {**alice, "content-type": "text/plain", "content-length": str(len(data))})
            self.assertEqual(status, 200)

            def probe(auth, path, **extra):
                payload = {"path": path, "size": len(data), "fingerprint": fp, **extra}
                return self.client.request("POST", "/api/user/v1/files/instant", json.dumps(payload).encode(), auth)

            status, _, body = await probe(alice, "b/two.txt", public=True)
            result = json.loads(body)
            self.assertEqual((status, result["hit"], result["key"], result["size"]), (200, True, "b/two.txt", len(data)))
            self.assertTrue(result["public_token"])
            status, _, body = await self.client.request("GET", "/api/user/v1/content?path=b/two.txt", b"", alice)
            self.assertEqual((status, body), (200, data))
            status, _, body = await probe(bob, "mine.txt")
            self.assertEqual((status, json.loads(body)), (200, {"hit": False}))
            status, _, _ = await self.client.request("POST", "/api/user/v1/files/instant", b"{}", {**alice})
            self.assertEqual(status, 400)
            status, _, _ = await probe({"cookie": alice["cookie"]}, "x.txt")
            self.assertIn(status, (401, 403))

        asyncio.run(run())

    def test_key_api_hit_and_miss(self):
        data = os.urandom(5000)
        fp = reference(data, 16 * 1024 * 1024)
        auth = self.app.s3.auth
        cid = auth.create_client("cli", owner_user_id=self.alice.id)
        ak, secret = auth.create_key(cid)
        auth.grant(cid, self.alice.bucket_id, "", "rw")
        headers = {"authorization": f"Bearer {ak}:{secret}"}

        async def run():
            status, _, _ = await self.client.request("PUT", "/api/v1/files?path=one.bin", data,
                                                     {**headers, "content-length": str(len(data))})
            self.assertEqual(status, 200)
            payload = json.dumps({"path": "two.bin", "size": len(data), "fingerprint": fp}).encode()
            status, _, body = await self.client.request("POST", "/api/v1/files/instant", payload, headers)
            self.assertEqual((status, json.loads(body)["hit"]), (200, True))
            miss = json.dumps({"path": "three.bin", "size": len(data), "fingerprint": "0" * 64}).encode()
            status, _, body = await self.client.request("POST", "/api/v1/files/instant", miss, headers)
            self.assertEqual((status, json.loads(body)), (200, {"hit": False}))

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
