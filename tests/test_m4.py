import datetime as dt
import hashlib
import hmac
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode

from tgdrive.keystore import KeyStore
from tgdrive.metadata import Metadata
from tgdrive.s3.auth import ClientAuthStore
from tgdrive.s3.sigv4 import SigV4Error, SigV4Verifier
from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.objects import ObjectService, Scope
from tgdrive.s3.gateway import S3Gateway


class M4Tests(unittest.TestCase):
    def test_sigv4_header_verification_and_tamper(self):
        verifier = SigV4Verifier()
        now = dt.datetime(2026, 10, 1, 12, 0, 0, tzinfo=dt.timezone.utc)
        body = b"hello"
        amz_date = "20261001T120000Z"
        headers = {"Host": "s3.example.test", "x-amz-date": amz_date,
                   "x-amz-content-sha256": hashlib.sha256(body).hexdigest()}
        signed = "host;x-amz-content-sha256;x-amz-date"
        # 使用 verifier 相同的规范化过程构造测试请求签名。
        canonical = "\n".join(("PUT", "/bucket/a.txt", "", "host:s3.example.test\n"
                                 "x-amz-content-sha256:" + headers["x-amz-content-sha256"] + "\n"
                                 "x-amz-date:" + amz_date + "\n", signed, headers["x-amz-content-sha256"]))
        scope = "20261001/us-east-1/s3/aws4_request"
        string_to_sign = "\n".join(("AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()))
        signing_key = verifier._signing_key("secret", "20261001", "us-east-1", "s3")
        signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
        headers["Authorization"] = ("AWS4-HMAC-SHA256 Credential=AKID/20261001/us-east-1/s3/aws4_request, "
                                     f"SignedHeaders={signed}, Signature={signature}")
        result = verifier.verify("PUT", "https://s3.example.test/bucket/a.txt", headers, body, secret="secret", now=now)
        self.assertEqual(result.access_key_id, "AKID")
        headers["Host"] = "evil.example.test"
        with self.assertRaises(SigV4Error):
            verifier.verify("PUT", "https://s3.example.test/bucket/a.txt", headers, body, secret="secret", now=now)

    def test_client_secret_is_rewrapped_with_kek_rotation(self):
        with tempfile.TemporaryDirectory() as temp:
            metadata = Metadata(Path(temp) / "meta.db")
            keys = KeyStore(metadata)
            keys.initialize("old")
            auth = ClientAuthStore(metadata, keys.require_kek())
            client_id = auth.create_client("backup")
            access_key, secret = auth.create_key(client_id)
            principal, loaded = auth.secret_for(access_key)
            self.assertEqual(principal.client_id, client_id)
            self.assertEqual(loaded, secret)
            keys.rotate("old", "new")
            auth.kek = keys.require_kek()
            _, loaded_after = auth.secret_for(access_key)
            self.assertEqual(loaded_after, secret)
            auth.disable_key(access_key)
            with self.assertRaises(Exception):
                auth.secret_for(access_key)

    def test_presigned_request_verification(self):
        verifier = SigV4Verifier()
        now = dt.datetime(2026, 10, 1, 12, 0, 0, tzinfo=dt.timezone.utc)
        params = {
            "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": "AKID/20261001/us-east-1/s3/aws4_request",
            "X-Amz-Date": "20261001T120000Z", "X-Amz-Expires": "60", "X-Amz-SignedHeaders": "host",
            "X-Amz-Signature": "0" * 64,
        }
        url = "https://s3.example.test/bucket/a.txt?" + urlencode(params)
        from tgdrive.s3.sigv4 import _canonical_query, _canonical_uri
        canonical = "\n".join(("GET", _canonical_uri("/bucket/a.txt"), _canonical_query(url.split("?", 1)[1], omit={"X-Amz-Signature"}),
                                 "host:s3.example.test\n", "host", "UNSIGNED-PAYLOAD"))
        string_to_sign = "\n".join(("AWS4-HMAC-SHA256", params["X-Amz-Date"], "20261001/us-east-1/s3/aws4_request",
                                     hashlib.sha256(canonical.encode()).hexdigest()))
        key = verifier._signing_key("secret", "20261001", "us-east-1", "s3")
        params["X-Amz-Signature"] = hmac.new(key, string_to_sign.encode(), hashlib.sha256).hexdigest()
        url = "https://s3.example.test/bucket/a.txt?" + urlencode(params)
        self.assertEqual(verifier.verify_presigned("GET", url, {"Host": "s3.example.test"}, secret="secret", now=now).access_key_id, "AKID")

    def test_s3_gateway_put_get(self):
        import asyncio
        async def run():
            with tempfile.TemporaryDirectory() as temp:
                metadata = Metadata(Path(temp) / "meta.db")
                keys = KeyStore(metadata)
                keys.initialize("pass")
                engine = BlobEngine(metadata, LocalDiskBlobStore(Path(temp) / "blobs"), keys.require_kek(), chunk_size=32, frame_size=8)
                objects = ObjectService(metadata, engine)
                bucket = objects.create_bucket("user-a")
                client_store = ClientAuthStore(metadata, keys.require_kek())
                client_id = client_store.create_client("cli")
                access_key, secret = client_store.create_key(client_id)
                client_store.grant(client_id, bucket, "", "rw")
                gateway = S3Gateway(objects, client_store)
                verifier = SigV4Verifier()
                now = dt.datetime.now(dt.timezone.utc)

                def signed(method, url, body, timestamp):
                    stamp = timestamp.strftime("%Y%m%dT%H%M%SZ")
                    date = timestamp.strftime("%Y%m%d")
                    payload = hashlib.sha256(body).hexdigest()
                    h = {"Host": "s3.example.test", "x-amz-date": stamp, "x-amz-content-sha256": payload}
                    names = "host;x-amz-content-sha256;x-amz-date"
                    canonical = "\n".join((method, url.split(".test", 1)[1], "", "host:s3.example.test\n"
                                             "x-amz-content-sha256:" + payload + "\n" + "x-amz-date:" + stamp + "\n", names, payload))
                    sts = "\n".join(("AWS4-HMAC-SHA256", stamp, f"{date}/us-east-1/s3/aws4_request", hashlib.sha256(canonical.encode()).hexdigest()))
                    sig = hmac.new(verifier._signing_key(secret, date, "us-east-1", "s3"), sts.encode(), hashlib.sha256).hexdigest()
                    h["Authorization"] = f"AWS4-HMAC-SHA256 Credential={access_key}/{date}/us-east-1/s3/aws4_request, SignedHeaders={names}, Signature={sig}"
                    return h

                url = "https://s3.example.test/user-a/a.txt"
                put_headers = signed("PUT", url, b"hello", now)
                verifier.verify("PUT", url, put_headers, b"hello", secret=secret, now=now)
                gateway._authenticate("PUT", url, put_headers)
                put = await gateway.handle("PUT", url, put_headers, b"hello")
                self.assertEqual(put.status, 200, put.body)
                get = await gateway.handle("GET", url, signed("GET", url, b"", now), b"")
                self.assertEqual((get.status, b"".join([chunk async for chunk in get.stream])), (200, b"hello"))
                root_url = "https://s3.example.test/"
                root = await gateway.handle("GET", root_url, signed("GET", root_url, b"", now), b"")
                self.assertEqual(root.status, 200)
                self.assertIn(b"user-a", root.body)
                head_bucket = await gateway.handle("HEAD", "https://s3.example.test/user-a", signed("HEAD", "https://s3.example.test/user-a", b"", now), b"")
                self.assertEqual(head_bucket.status, 200)
                metadata.close()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
