"""M11：S3 CopyObject、UploadPartCopy 与 DeleteObjects。"""
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree

from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.keystore import KeyStore
from tgdrive.metadata import Metadata
from tgdrive.objects import ObjectService, Scope
from tgdrive.s3.auth import ClientAuthStore
from tgdrive.s3.gateway import S3Gateway
from tgdrive.s3.sigv4 import SignedRequest

NS = "http://s3.amazonaws.com/doc/2006-03-01/"
BASE = "https://s3.example.test"


def local(tag):
    return tag.rsplit("}", 1)[-1]


class S3CopyDeleteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.metadata = Metadata(root / "meta.db")
        keys = KeyStore(self.metadata)
        keys.initialize("pass")
        engine = BlobEngine(self.metadata, LocalDiskBlobStore(root / "blobs"), keys.require_kek(), chunk_size=32, frame_size=8)
        self.objects = ObjectService(self.metadata, engine)
        self.bucket = self.objects.create_bucket("user-a", quota_bytes=10_000_000)
        self.other = self.objects.create_bucket("user-b")
        self.auth = ClientAuthStore(self.metadata, keys.require_kek())
        client = self.auth.create_client("cli")
        access_key, _ = self.auth.create_key(client)
        self.auth.grant(client, self.bucket, "", "rw")
        self.auth.grant(self.auth.create_client("other"), self.other, "", "rw")
        self.principal = self.auth.secret_for(access_key)[0]
        self.gateway = S3Gateway(self.objects, self.auth)
        # 签名在 test_m4 中覆盖；这里直接注入已认证的客户端，专注于操作语义。
        self.gateway._authenticate = lambda *args: (self.principal, SignedRequest("ak", "us-east-1", "s3", ("host",), ""))
        self.scope = Scope(self.bucket)

    async def asyncTearDown(self):
        self.metadata.close()
        self.temp.cleanup()

    async def call(self, method, path, headers=None, body=b""):
        response = await self.gateway.handle(method, BASE + path, headers or {}, body)
        if response.stream is not None:
            content = b"".join([chunk async for chunk in response.stream])
            return type(response)(response.status, response.headers, content)
        return response

    async def read(self, key, scope=None):
        _, stream = await self.objects.get_object(scope or self.scope, key)
        return b"".join([chunk async for chunk in stream])

    def error_code(self, response):
        return ElementTree.fromstring(response.body).findtext("Code")

    async def test_copy_object_shares_blob_and_keeps_bytes(self):
        await self.objects.put_object(self.scope, "src.txt", b"hello world", content_type="text/plain")
        response = await self.call("PUT", "/user-a/dir/copy.txt", {"x-amz-copy-source": "/user-a/src.txt"})
        self.assertEqual(response.status, 200, response.body)
        root = ElementTree.fromstring(response.body)
        self.assertEqual(local(root.tag), "CopyObjectResult")
        self.assertTrue(root.findtext("LastModified").endswith("Z"))
        self.assertEqual(await self.read("dir/copy.txt"), b"hello world")
        copy = self.objects.head_object(self.scope, "dir/copy.txt")
        self.assertEqual(copy.content_type, "text/plain")
        self.assertEqual(copy.blob_uuid, self.objects.head_object(self.scope, "src.txt").blob_uuid)
        used = self.metadata.db.execute("SELECT used_bytes FROM buckets WHERE id=?", (self.bucket,)).fetchone()[0]
        self.assertEqual(used, 22)
        # 删除源后副本仍可读：Blob 引用计数正确。
        await self.objects.delete_objects(self.scope, ["src.txt"])
        self.assertEqual(await self.read("dir/copy.txt"), b"hello world")

    async def test_copy_never_writes_empty_object(self):
        await self.objects.put_object(self.scope, "keep.txt", b"important")
        missing = await self.call("PUT", "/user-a/keep.txt", {"x-amz-copy-source": "user-a/missing.txt"})
        self.assertEqual((missing.status, self.error_code(missing)), (404, "NoSuchKey"))
        denied = await self.call("PUT", "/user-a/keep.txt", {"x-amz-copy-source": "user-b/whatever"})
        self.assertIn(denied.status, (403, 404))
        self.assertEqual(await self.read("keep.txt"), b"important")

    async def test_copy_url_encoded_source_and_self_copy_rules(self):
        await self.objects.put_object(self.scope, "照片 1.png", b"img", content_type="image/png")
        encoded = await self.call("PUT", "/user-a/b.png", {"x-amz-copy-source": "/user-a/%E7%85%A7%E7%89%87%201.png"})
        self.assertEqual(encoded.status, 200, encoded.body)
        same = await self.call("PUT", "/user-a/b.png", {"x-amz-copy-source": "/user-a/b.png"})
        self.assertEqual((same.status, self.error_code(same)), (400, "InvalidRequest"))
        replace = await self.call("PUT", "/user-a/b.png", {"x-amz-copy-source": "/user-a/b.png",
                                                           "x-amz-metadata-directive": "REPLACE",
                                                           "content-type": "image/x-test", "x-amz-meta-owner": "alice"})
        self.assertEqual(replace.status, 200, replace.body)
        info = self.objects.head_object(self.scope, "b.png")
        self.assertEqual((info.content_type, info.user_meta), ("image/x-test", {"owner": "alice"}))
        self.assertEqual(await self.read("b.png"), b"img")

    async def test_copy_preconditions_and_quota(self):
        info = await self.objects.put_object(self.scope, "a.bin", b"abc")
        failed = await self.call("PUT", "/user-a/b.bin", {"x-amz-copy-source": "/user-a/a.bin", "x-amz-copy-source-if-match": '"nope"'})
        self.assertEqual((failed.status, self.error_code(failed)), (412, "PreconditionFailed"))
        ok = await self.call("PUT", "/user-a/b.bin", {"x-amz-copy-source": "/user-a/a.bin", "x-amz-copy-source-if-match": f'"{info.etag}"'})
        self.assertEqual(ok.status, 200)
        self.metadata.db.execute("UPDATE buckets SET quota_bytes=7 WHERE id=?", (self.bucket,))
        self.metadata.db.commit()
        over = await self.call("PUT", "/user-a/c.bin", {"x-amz-copy-source": "/user-a/a.bin"})
        self.assertEqual((over.status, self.error_code(over)), (403, "QuotaExceeded"))

    async def test_copy_keeps_destination_public_link_only(self):
        await self.objects.put_object(self.scope, "src.txt", b"new")
        await self.objects.put_object(self.scope, "dst.txt", b"old")
        token = self.objects.set_public(self.scope, "dst.txt", True).public_token
        self.objects.set_public(self.scope, "src.txt", True)
        await self.call("PUT", "/user-a/dst.txt", {"x-amz-copy-source": "/user-a/src.txt"})
        self.assertEqual(self.objects.head_object(self.scope, "dst.txt").public_token, token)
        await self.call("PUT", "/user-a/fresh.txt", {"x-amz-copy-source": "/user-a/src.txt"})
        self.assertIsNone(self.objects.head_object(self.scope, "fresh.txt").public_token)

    async def test_upload_part_copy_with_ranges(self):
        data = bytes(range(256)) * 400  # 102400 字节
        await self.objects.put_object(self.scope, "big.bin", data)
        created = await self.call("POST", "/user-a/joined.bin?uploads")
        upload_id = ElementTree.fromstring(created.body).findtext("UploadId")
        split = 6 * 1024 * 1024
        self.assertLess(len(data), split)
        # 单段复制整个源对象；第二段只复制一个范围。
        first = await self.call("PUT", f"/user-a/joined.bin?partNumber=1&uploadId={upload_id}", {"x-amz-copy-source": "/user-a/big.bin"})
        self.assertEqual(first.status, 200, first.body)
        self.assertEqual(local(ElementTree.fromstring(first.body).tag), "CopyPartResult")
        etag1 = ElementTree.fromstring(first.body).findtext("ETag")
        complete = (f'<CompleteMultipartUpload xmlns="{NS}"><Part><PartNumber>1</PartNumber>'
                    f"<ETag>{etag1}</ETag></Part></CompleteMultipartUpload>").encode()
        done = await self.call("POST", f"/user-a/joined.bin?uploadId={upload_id}", {}, complete)
        self.assertEqual(done.status, 200, done.body)
        self.assertEqual(await self.read("joined.bin"), data)

        created = await self.call("POST", "/user-a/slice.bin?uploads")
        upload_id = ElementTree.fromstring(created.body).findtext("UploadId")
        part = await self.call("PUT", f"/user-a/slice.bin?partNumber=1&uploadId={upload_id}",
                               {"x-amz-copy-source": "/user-a/big.bin", "x-amz-copy-source-range": "bytes=100-299"})
        etag = ElementTree.fromstring(part.body).findtext("ETag")
        await self.call("POST", f"/user-a/slice.bin?uploadId={upload_id}", {},
                        f"<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>{etag}</ETag></Part></CompleteMultipartUpload>".encode())
        self.assertEqual(await self.read("slice.bin"), data[100:300])
        bad = await self.call("PUT", f"/user-a/slice2.bin?partNumber=1&uploadId={upload_id}",
                              {"x-amz-copy-source": "/user-a/big.bin", "x-amz-copy-source-range": "bytes=0-999999"})
        self.assertEqual(bad.status, 400)

    async def test_delete_objects_reports_each_key(self):
        for key in ("a.txt", "b.txt", "dir/c.txt"):
            await self.objects.put_object(self.scope, key, b"x")
        body = (f'<Delete xmlns="{NS}"><Object><Key>a.txt</Key></Object><Object><Key>dir/c.txt</Key></Object>'
                "<Object><Key>missing.txt</Key></Object><Object><Key>../evil</Key></Object></Delete>").encode()
        response = await self.call("POST", "/user-a?delete", {}, body)
        self.assertEqual(response.status, 200, response.body)
        root = ElementTree.fromstring(response.body)
        deleted = [node.findtext(f"{{{NS}}}Key") for node in root if local(node.tag) == "Deleted"]
        errors = [(node.findtext(f"{{{NS}}}Key"), node.findtext(f"{{{NS}}}Code")) for node in root if local(node.tag) == "Error"]
        self.assertEqual(deleted, ["a.txt", "dir/c.txt", "missing.txt"])
        self.assertEqual(errors, [("../evil", "InvalidArgument")])
        self.assertEqual([item.key for item in self.objects.list_objects(self.scope, "", None).objects], ["b.txt"])

        quiet = await self.call("POST", "/user-a?delete", {}, b"<Delete><Quiet>true</Quiet><Object><Key>b.txt</Key></Object></Delete>")
        self.assertEqual([local(node.tag) for node in ElementTree.fromstring(quiet.body)], [])

    async def test_delete_objects_respects_prefix_grants_and_rejects_bad_xml(self):
        limited = self.auth.create_client("limited")
        self.auth.grant(limited, self.bucket, "public/", "rw")
        access_key, _ = self.auth.create_key(limited)
        self.principal = self.auth.secret_for(access_key)[0]
        await self.objects.put_object(self.scope, "public/a.txt", b"x")
        await self.objects.put_object(self.scope, "private/b.txt", b"x")
        response = await self.call("POST", "/user-a?delete", {},
                                   b"<Delete><Object><Key>public/a.txt</Key></Object><Object><Key>private/b.txt</Key></Object></Delete>")
        codes = {node.findtext(f"{{{NS}}}Key"): node.findtext(f"{{{NS}}}Code") for node in ElementTree.fromstring(response.body) if local(node.tag) == "Error"}
        self.assertEqual(codes, {"private/b.txt": "AccessDenied"})
        self.assertEqual(self.objects.head_object(self.scope, "private/b.txt").size, 1)
        for bad in (b"not xml", b"<Delete></Delete>", b"<Other/>"):
            response = await self.call("POST", "/user-a?delete", {}, bad)
            self.assertEqual((response.status, self.error_code(response)), (400, "MalformedXML"))

    async def test_complete_multipart_accepts_namespaced_xml(self):
        created = await self.call("POST", "/user-a/m.bin?uploads")
        upload_id = ElementTree.fromstring(created.body).findtext("UploadId")
        part = await self.call("PUT", f"/user-a/m.bin?partNumber=1&uploadId={upload_id}", {}, b"payload")
        body = (f'<CompleteMultipartUpload xmlns="{NS}"><Part><PartNumber>1</PartNumber>'
                f'<ETag>{part.headers["ETag"]}</ETag></Part></CompleteMultipartUpload>').encode()
        done = await self.call("POST", f"/user-a/m.bin?uploadId={upload_id}", {}, body)
        self.assertEqual(done.status, 200, done.body)
        self.assertEqual(await self.read("m.bin"), b"payload")

    async def test_multipart_objects_can_be_deleted_overwritten_and_copied(self):
        async def multipart(key, payload):
            upload = await self.objects.create_multipart(self.scope, key)
            part = await self.objects.upload_part(self.scope, upload, 1, payload)
            await self.objects.complete_multipart(self.scope, upload, [(1, part.etag)])
        await multipart("m1.bin", b"one")
        await self.objects.put_object(self.scope, "m1.bin", b"overwritten")
        self.assertEqual(await self.read("m1.bin"), b"overwritten")
        await multipart("m2.bin", b"two")
        await self.call("PUT", "/user-a/m2-copy.bin", {"x-amz-copy-source": "/user-a/m2.bin"})
        await self.objects.delete_objects(self.scope, ["m2.bin"])
        self.assertEqual(await self.read("m2-copy.bin"), b"two")
        await self.objects.delete_objects(self.scope, ["m2-copy.bin"])
        self.assertEqual(self.metadata.db.execute("SELECT COUNT(*) FROM uploads").fetchone()[0], 0)

    async def test_list_objects_v2_recursive_and_pagination(self):
        for key in ("a.txt", "docs/b.txt", "docs/sub/c.txt"):
            await self.objects.put_object(self.scope, key, b"x")
        def parse(response):
            root = ElementTree.fromstring(response.body)
            keys = [node.findtext("Key") for node in root if local(node.tag) == "Contents"]
            prefixes = [node.findtext("Prefix") for node in root if local(node.tag) == "CommonPrefixes"]
            return root, keys, prefixes
        _, keys, prefixes = parse(await self.call("GET", "/user-a?list-type=2"))
        self.assertEqual((keys, prefixes), (["a.txt", "docs/b.txt", "docs/sub/c.txt"], []))
        _, keys, prefixes = parse(await self.call("GET", "/user-a?list-type=2&delimiter=/"))
        self.assertEqual((keys, prefixes), (["a.txt"], ["docs/"]))
        root, keys, _ = parse(await self.call("GET", "/user-a?list-type=2&max-keys=2"))
        self.assertEqual((keys, root.findtext("IsTruncated")), (["a.txt", "docs/b.txt"], "true"))
        self.assertTrue(root.find("Contents").findtext("LastModified").endswith("Z"))
        token = root.findtext("NextContinuationToken")
        root, keys, _ = parse(await self.call("GET", f"/user-a?list-type=2&max-keys=2&continuation-token={token}"))
        self.assertEqual((keys, root.findtext("IsTruncated")), (["docs/sub/c.txt"], "false"))

    async def test_abort_multipart_upload(self):
        created = await self.call("POST", "/user-a/aborted.bin?uploads")
        upload_id = ElementTree.fromstring(created.body).findtext("UploadId")
        await self.call("PUT", f"/user-a/aborted.bin?partNumber=1&uploadId={upload_id}", {}, b"partial")
        response = await self.call("DELETE", f"/user-a/aborted.bin?uploadId={upload_id}")
        self.assertEqual(response.status, 204, response.body)
        self.assertIsNone(self.metadata.db.execute("SELECT 1 FROM uploads WHERE upload_id=?", (upload_id,)).fetchone())
        self.assertGreater(self.metadata.db.execute("SELECT COUNT(*) FROM gc_queue").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
