"""M12：访问密钥认证的 HTTP API（/api/v1）。"""
import asyncio
import base64
import json
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app


class KeyApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.alice = self.app.accounts.create_user("alice", "alice password")
        self.bob = self.app.accounts.create_user("bob", "bob password")
        self.client = Client(self.app)
        clients = self.app.s3.auth
        self.clients = clients
        cid = clients.create_client("alice-cli", owner_user_id=self.alice.id)
        self.ak, self.secret = clients.create_key(cid)
        clients.grant(cid, self.alice.bucket_id, "", "rw")

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def bearer(self, ak=None, secret=None, **extra):
        return {"authorization": f"Bearer {ak or self.ak}:{secret or self.secret}", **extra}

    def call(self, method, path, body=b"", headers=None):
        return asyncio.run(self.client.request(method, path, body, headers if headers is not None else self.bearer()))

    def json_call(self, method, path, payload=None, headers=None):
        status, _, data = self.call(method, path, json.dumps(payload).encode() if payload is not None else b"", headers)
        return status, json.loads(data) if data else None

    def test_full_file_lifecycle_with_bearer_and_basic(self):
        status, body = self.json_call("GET", "/api/v1/me")
        self.assertEqual((status, body["owner"], body["grants"][0]["perms"]), (200, "alice", "rw"))
        status, _, data = self.call("PUT", "/api/v1/files?path=docs/a.txt&public=1", b"hello world",
                                    self.bearer(**{"content-type": "text/plain", "content-length": "11"}))
        self.assertEqual(status, 200, data)
        self.assertTrue(json.loads(data)["public_token"])
        basic = {"authorization": "Basic " + base64.b64encode(f"{self.ak}:{self.secret}".encode()).decode()}
        status, headers, data = self.call("GET", "/api/v1/content?path=docs/a.txt", headers={**basic, "range": "bytes=0-4"})
        self.assertEqual((status, data, headers["cache-control"]), (206, b"hello", "private"))
        self.assertEqual(self.json_call("GET", "/api/v1/list?prefix=docs/")[1]["objects"][0]["key"], "docs/a.txt")
        self.assertEqual(self.json_call("GET", "/api/v1/search?q=A.TXT")[1]["objects"][0]["key"], "docs/a.txt")
        self.assertEqual(self.json_call("POST", "/api/v1/folders", {"path": "archive"})[0], 201)
        self.assertEqual(self.json_call("POST", "/api/v1/copy", {"from": "docs/a.txt", "to": "archive/a.txt"})[0], 201)
        self.assertEqual(self.json_call("POST", "/api/v1/move", {"from": "docs/", "to": "old/docs/"})[1], {"moved": 1, "skipped": 0})
        self.assertEqual([item["key"] for item in self.json_call("GET", "/api/v1/public")[1]], ["old/docs/a.txt"])
        status, body = self.json_call("POST", "/api/v1/public", {"paths": ["old/docs/a.txt"], "public": False})
        self.assertIsNone(body["objects"][0]["public_token"])
        status, body = self.json_call("POST", "/api/v1/delete", {"paths": ["archive/a.txt", "missing.txt"]})
        self.assertEqual(body["results"], [{"path": "archive/a.txt", "deleted": True}, {"path": "missing.txt", "deleted": False}])

    def test_authentication_failures_and_no_cookie_or_csrf(self):
        for headers in ({}, {"authorization": "Bearer nope"}, self.bearer(secret="wrong"), {"authorization": "Basic !!!"}):
            status, response_headers, data = self.call("GET", "/api/v1/me", headers=headers)
            self.assertEqual((status, json.loads(data)["error"]["code"]), (401, "invalid_key"))
            self.assertEqual(response_headers["www-authenticate"], 'Bearer realm="tgdrive"')
        # 网页会话 Cookie 不能访问 /api/v1。
        session = asyncio.run(self.client.login("user", "alice", "alice password"))
        self.assertEqual(self.call("GET", "/api/v1/me", headers=session)[0], 401)
        # 密钥不能访问网页接口 /api/user/v1。
        self.assertEqual(self.call("GET", "/api/user/v1/me")[0], 401)
        # 写请求无需 CSRF。
        self.assertEqual(self.json_call("POST", "/api/v1/folders", {"path": "x"})[0], 201)

    def test_disabled_key_owner_and_lock(self):
        self.app.accounts.set_account_status(self.alice.id, "disabled")
        self.assertEqual(self.call("GET", "/api/v1/me")[0], 401)
        self.app.accounts.set_account_status(self.alice.id, "active")
        self.assertEqual(self.call("GET", "/api/v1/me")[0], 200)
        self.clients.disable_key(self.ak)
        self.assertEqual(self.call("GET", "/api/v1/me")[0], 401)
        self.app.keystore.lock()
        self.assertEqual(self.call("GET", "/api/v1/me")[0], 503)

    def test_grants_limit_bucket_prefix_and_writes(self):
        self.call("PUT", "/api/v1/files?path=public/a.txt", b"a", self.bearer(**{"content-length": "1"}))
        self.call("PUT", "/api/v1/files?path=private/b.txt", b"b", self.bearer(**{"content-length": "1"}))
        cid = self.clients.create_client("reader")
        ak, secret = self.clients.create_key(cid)
        self.clients.grant(cid, self.alice.bucket_id, "public/", "ro")
        reader = self.bearer(ak, secret)
        self.assertEqual(self.call("GET", "/api/v1/content?path=public/a.txt", headers=reader)[0], 200)
        self.assertEqual(self.call("GET", "/api/v1/content?path=private/b.txt", headers=reader)[0], 403)
        self.assertEqual(self.call("PUT", "/api/v1/files?path=public/c.txt", b"c", {**reader, "content-length": "1"})[0], 403)
        self.assertEqual(self.json_call("POST", "/api/v1/delete", {"paths": ["public/a.txt"]}, reader)[0], 403)
        # 列出根目录时只看到被授权的子目录；搜索结果同样受前缀限制。
        self.assertEqual([item["key"] for item in self.json_call("GET", "/api/v1/list", headers=reader)[1]["objects"]], ["public/a.txt"])
        self.assertEqual([item["key"] for item in self.json_call("GET", "/api/v1/search?q=txt", headers=reader)[1]["objects"]], ["public/a.txt"])
        # 无法访问其他用户的存储桶；多桶授权时必须指定 bucket。
        bob_bucket = self.app.metadata.db.execute("SELECT name FROM buckets WHERE id=?", (self.bob.bucket_id,)).fetchone()[0]
        self.assertEqual(self.json_call("GET", f"/api/v1/list?bucket={bob_bucket}")[0], 403)
        self.clients.grant(cid, self.bob.bucket_id, "", "ro")
        status, body = self.json_call("GET", "/api/v1/list", headers=reader)
        self.assertEqual(status, 400)
        self.assertIn("bucket", body["error"]["message"])
        self.assertEqual(self.json_call("GET", f"/api/v1/list?bucket={bob_bucket}", headers=reader)[0], 200)


if __name__ == "__main__":
    unittest.main()
