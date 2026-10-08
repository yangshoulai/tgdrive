"""M13：S3 请求体流式校验、大小上限、配额预检与失败分片回收。"""
import base64
import hashlib
import hmac
import tempfile
import unittest
import zlib
from pathlib import Path
from xml.etree import ElementTree

from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.errors import QuotaExceededError
from tgdrive.keystore import KeyStore
from tgdrive.metadata import Metadata
from tgdrive.objects import ObjectService, Scope
from tgdrive.s3.auth import ClientAuthStore
from tgdrive.s3.gateway import S3Gateway
from tgdrive.s3.payload import EMPTY_SHA256
from tgdrive.s3.sigv4 import SignedRequest

BASE = "https://s3.example.test"
SIGNING_KEY = b"k" * 32
SEED = "a" * 64
AMZ_DATE = "20261001T120000Z"
SCOPE = "20261001/us-east-1/s3/aws4_request"


def signed_chunks(data_parts, *, tamper=False):
    previous, body = SEED, bytearray()
    for data in [*data_parts, b""]:
        sts = "\n".join(("AWS4-HMAC-SHA256-PAYLOAD", AMZ_DATE, SCOPE, previous, EMPTY_SHA256, hashlib.sha256(data).hexdigest()))
        signature = hmac.new(SIGNING_KEY, sts.encode(), hashlib.sha256).hexdigest()
        previous = signature
        payload = (b"X" * len(data)) if tamper and data else data
        body += f"{len(data):x};chunk-signature={signature}\r\n".encode() + payload + b"\r\n"
    return bytes(body)


def unsigned_trailer(data_parts, checksum):
    body = bytearray()
    for data in data_parts:
        body += f"{len(data):x}\r\n".encode() + data + b"\r\n"
    body += b"0\r\n" + f"x-amz-checksum-crc32:{checksum}\r\n\r\n".encode()
    return bytes(body)


async def chunks_of(data, size=7):
    for index in range(0, len(data), size):
        yield data[index:index + size]


class S3PayloadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.metadata = Metadata(root / "meta.db")
        keys = KeyStore(self.metadata)
        keys.initialize("pass")
        engine = BlobEngine(self.metadata, LocalDiskBlobStore(root / "blobs"), keys.require_kek(), chunk_size=32, frame_size=8)
        self.objects = ObjectService(self.metadata, engine)
        self.bucket = self.objects.create_bucket("user-a")
        self.scope = Scope(self.bucket)
        auth = ClientAuthStore(self.metadata, keys.require_kek())
        client = auth.create_client("cli")
        auth.grant(client, self.bucket, "", "rw")
        principal = auth.secret_for(auth.create_key(client)[0])[0]
        self.gateway = S3Gateway(self.objects, auth)
        self.payload_hash = "UNSIGNED-PAYLOAD"
        self.gateway._authenticate = lambda *args: (principal, SignedRequest(
            "ak", "us-east-1", "s3", ("host",), "", self.payload_hash, SEED, AMZ_DATE, SCOPE, SIGNING_KEY))

    async def asyncTearDown(self):
        self.metadata.close()
        self.temp.cleanup()

    async def put(self, key, body, headers=None, payload_hash="UNSIGNED-PAYLOAD"):
        self.payload_hash = payload_hash
        return await self.gateway.handle("PUT", f"{BASE}/user-a/{key}", headers or {}, body)

    async def read(self, key):
        _, stream = await self.objects.get_object(self.scope, key)
        return b"".join([chunk async for chunk in stream])

    def code(self, response):
        return ElementTree.fromstring(response.body).findtext("Code")

    def exists(self, key):
        return self.metadata.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (self.bucket, key)).fetchone() is not None

    async def test_sha256_payload_is_verified_while_streaming(self):
        data = b"payload " * 20
        ok = await self.put("ok.bin", chunks_of(data), {"content-length": str(len(data))}, hashlib.sha256(data).hexdigest())
        self.assertEqual(ok.status, 200, ok.body)
        self.assertEqual(await self.read("ok.bin"), data)
        bad = await self.put("bad.bin", chunks_of(b"tampered" * 20), {}, hashlib.sha256(data).hexdigest())
        self.assertEqual((bad.status, self.code(bad)), (400, "XAmzContentSHA256Mismatch"))
        self.assertFalse(self.exists("bad.bin"))
        # 未声明哈希时按空请求体签名，携带任何内容都会被拒绝。
        smuggled = await self.put("x.bin", b"data", {}, EMPTY_SHA256)
        self.assertEqual(self.code(smuggled), "XAmzContentSHA256Mismatch")

    async def test_streaming_signed_chunks(self):
        parts = [b"a" * 40, b"b" * 25]
        headers = {"content-encoding": "aws-chunked", "x-amz-decoded-content-length": "65"}
        ok = await self.put("signed.bin", chunks_of(signed_chunks(parts), 11), headers, "STREAMING-AWS4-HMAC-SHA256-PAYLOAD")
        self.assertEqual(ok.status, 200, ok.body)
        self.assertEqual(await self.read("signed.bin"), b"".join(parts))
        bad = await self.put("forged.bin", signed_chunks(parts, tamper=True), headers, "STREAMING-AWS4-HMAC-SHA256-PAYLOAD")
        self.assertEqual((bad.status, self.code(bad)), (403, "SignatureDoesNotMatch"))
        self.assertFalse(self.exists("forged.bin"))
        truncated = await self.put("short.bin", signed_chunks(parts)[:-30], headers, "STREAMING-AWS4-HMAC-SHA256-PAYLOAD")
        self.assertEqual((truncated.status, self.code(truncated)), (400, "IncompleteBody"))

    async def test_unsigned_payload_with_crc32_trailer(self):
        parts = [b"hello ", b"trailer"]
        crc = base64.b64encode(zlib.crc32(b"".join(parts)).to_bytes(4, "big")).decode()
        headers = {"content-encoding": "aws-chunked", "x-amz-trailer": "x-amz-checksum-crc32"}
        ok = await self.put("t.bin", unsigned_trailer(parts, crc), headers, "STREAMING-UNSIGNED-PAYLOAD-TRAILER")
        self.assertEqual(ok.status, 200, ok.body)
        self.assertEqual(await self.read("t.bin"), b"hello trailer")
        bad = await self.put("t2.bin", unsigned_trailer(parts, "AAAAAA=="), headers, "STREAMING-UNSIGNED-PAYLOAD-TRAILER")
        self.assertEqual((bad.status, self.code(bad)), (400, "BadDigest"))
        self.assertFalse(self.exists("t2.bin"))

    async def test_declared_size_limits_and_xml_cap(self):
        too_big = await self.put("huge.bin", b"", {"content-length": str(6 * 1024 ** 3)})
        self.assertEqual((too_big.status, self.code(too_big)), (400, "EntityTooLarge"))
        self.payload_hash = "UNSIGNED-PAYLOAD"
        huge_xml = b"<Delete>" + b"<Object><Key>k</Key></Object>" * 80_000 + b"</Delete>"
        response = await self.gateway.handle("POST", f"{BASE}/user-a?delete", {}, huge_xml)
        self.assertEqual((response.status, self.code(response)), (400, "EntityTooLarge"))

    async def test_quota_is_checked_before_and_during_upload(self):
        self.metadata.db.execute("UPDATE buckets SET quota_bytes=100 WHERE id=?", (self.bucket,))
        self.metadata.db.commit()
        stored = []
        original = self.objects.engine.store.put

        async def counting_put(key, data):
            stored.append(key)
            return await original(key, data)
        self.objects.engine.store.put = counting_put
        declared = await self.put("big.bin", chunks_of(b"x" * 200), {"content-length": "200"})
        self.assertEqual((declared.status, self.code(declared)), (403, "QuotaExceeded"))
        self.assertEqual(stored, [], "declared oversize upload must be rejected before writing anything")
        unknown = await self.put("big2.bin", chunks_of(b"x" * 200))
        self.assertEqual(self.code(unknown), "QuotaExceeded")
        self.assertLessEqual(len(stored), 4, "unknown-size upload must stop as soon as the quota is exceeded")
        # 覆盖同名对象时，旧对象的大小计入可用空间。
        await self.objects.put_object(self.scope, "a.bin", b"y" * 80)
        overwrite = await self.put("a.bin", b"z" * 90, {"content-length": "90"})
        self.assertEqual(overwrite.status, 200, overwrite.body)

    async def test_failed_upload_enqueues_written_chunks(self):
        async def failing():
            yield b"x" * 100  # 先写入若干个 32 字节分片
            raise ConnectionError("client went away")
        with self.assertRaises(ConnectionError):
            await self.objects.put_object(self.scope, "broken.bin", failing())
        queued = self.metadata.db.execute("SELECT COUNT(*) FROM gc_queue").fetchone()[0]
        self.assertGreaterEqual(queued, 3)

    async def test_multipart_quota_counts_other_parts(self):
        self.metadata.db.execute("UPDATE buckets SET quota_bytes=100 WHERE id=?", (self.bucket,))
        self.metadata.db.commit()
        upload = await self.objects.create_multipart(self.scope, "m.bin")
        await self.objects.upload_part(self.scope, upload, 1, b"a" * 60, 60)
        with self.assertRaises(QuotaExceededError):
            await self.objects.upload_part(self.scope, upload, 2, b"b" * 60, 60)
        # 重传同一个分段不会重复计算自己。
        await self.objects.upload_part(self.scope, upload, 1, b"c" * 90, 90)

    async def test_get_streams_ranges(self):
        data = bytes(range(200))
        await self.objects.put_object(self.scope, "r.bin", data)
        self.payload_hash = "UNSIGNED-PAYLOAD"
        response = await self.gateway.handle("GET", f"{BASE}/user-a/r.bin", {"range": "bytes=10-49"})
        self.assertEqual((response.status, response.headers["Content-Length"], response.headers["Content-Range"]), (206, "40", "bytes 10-49/200"))
        self.assertEqual(b"".join([chunk async for chunk in response.stream]), data[10:50])
        full = await self.gateway.handle("GET", f"{BASE}/user-a/r.bin", {})
        self.assertEqual(b"".join([chunk async for chunk in full.stream]), data)


if __name__ == "__main__":
    unittest.main()
