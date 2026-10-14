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
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.bob = self.app.accounts.create_user("bob@example.com", "bob password")
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
        self.assertEqual((status, body["owner"], body["grants"][0]["perms"]), (200, "alice@example.com", "rw"))
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
        session = asyncio.run(self.client.login("user", "alice@example.com", "alice password"))
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

    def test_offline_downloads_follow_key_owner_and_grants(self):
        from tests.test_offline import MemoryHttp
        self.app.offline.http = MemoryHttp()
        status, body = self.json_call("POST", "/api/v1/downloads/parse", {"input": "https://example.com/a.bin"})
        self.assertEqual(status, 200, body)
        ticket = body["candidates"][0]["ticket"]
        status, body = self.json_call("POST", "/api/v1/downloads", {"items": [{"ticket": ticket, "name": "a.bin"}], "destination": "web"})
        self.assertEqual((status, body["tasks"][0]["key"]), (201, "web/a.bin"))
        row = self.app.metadata.db.execute("SELECT user_id, bucket_id FROM offline_tasks").fetchone()
        self.assertEqual((row["user_id"], row["bucket_id"]), (self.alice.id, self.alice.bucket_id))
        audit = self.app.metadata.db.execute("SELECT actor_type, actor FROM audit_log WHERE action='download.create'").fetchone()
        self.assertEqual(tuple(audit), ("key", self.ak))
        # 前缀授权：省略目录时落到授权前缀，越界或私密目录被拒绝；只读密钥不能解析或创建。
        cid = self.clients.create_client("grabber", owner_user_id=self.alice.id)
        ak, secret = self.clients.create_key(cid)
        self.clients.grant(cid, self.alice.bucket_id, "inbox/", "rw")
        scoped = self.bearer(ak, secret)
        status, body = self.json_call("POST", "/api/v1/downloads", {"items": [{"ticket": ticket, "name": "b.bin"}]}, scoped)
        self.assertEqual((status, body["tasks"][0]["key"]), (201, "inbox/b.bin"))
        for destination in ("other", ".tgdrive/private/x"):
            self.assertEqual(self.json_call("POST", "/api/v1/downloads", {"items": [{"ticket": ticket, "name": "c.bin"}], "destination": destination}, scoped)[0], 403)
        self.assertEqual(self.json_call("POST", "/api/v1/downloads", {"items": [{"ticket": ticket, "name": "../c.bin"}]}, scoped)[0], 400)
        reader = self.clients.create_client("reader", owner_user_id=self.alice.id)
        rak, rsecret = self.clients.create_key(reader)
        self.clients.grant(reader, self.alice.bucket_id, "", "ro")
        self.assertEqual(self.json_call("POST", "/api/v1/downloads/parse", {"input": "https://example.com/a.bin"}, self.bearer(rak, rsecret))[0], 403)
        # 不属于用户的密钥、其他用户的票据都不可用。
        orphan = self.clients.create_client("orphan")
        oak, osecret = self.clients.create_key(orphan)
        self.clients.grant(orphan, self.alice.bucket_id, "", "rw")
        self.assertEqual(self.json_call("POST", "/api/v1/downloads/parse", {"input": "https://example.com/a.bin"}, self.bearer(oak, osecret))[0], 403)
        bob = self.clients.create_client("bob-cli", owner_user_id=self.bob.id)
        bak, bsecret = self.clients.create_key(bob)
        self.clients.grant(bob, self.bob.bucket_id, "", "rw")
        self.assertEqual(self.json_call("POST", "/api/v1/downloads", {"items": [{"ticket": ticket, "name": "d.bin"}]}, self.bearer(bak, bsecret))[0], 400)

        # 按 ID 查询进度：只返回本用户、密钥可读路径内的任务；只读密钥可以查询，其他用户的密钥看不到。
        ids = [row[0] for row in self.app.metadata.db.execute("SELECT id FROM offline_tasks ORDER BY id")]
        query = "/api/v1/downloads?ids=" + ",".join(map(str, ids))
        status, body = self.json_call("GET", query)
        self.assertEqual((status, [task["key"] for task in body["tasks"]]), (200, ["web/a.bin", "inbox/b.bin"]))
        self.assertIn(body["tasks"][0]["status"], ("queued", "running", "completed", "interrupted"))
        self.assertNotIn("request_enc", body["tasks"][0])
        self.assertEqual([task["key"] for task in self.json_call("GET", query, headers=scoped)[1]["tasks"]], ["inbox/b.bin"])
        self.assertEqual(len(self.json_call("GET", query, headers=self.bearer(rak, rsecret))[1]["tasks"]), 2)
        self.assertEqual(self.json_call("GET", query, headers=self.bearer(bak, bsecret))[1]["tasks"], [])
        self.assertEqual(self.json_call("GET", "/api/v1/downloads?ids=x")[0], 400)
        self.assertEqual(self.json_call("GET", "/api/v1/downloads?ids=" + ",".join(map(str, range(1, 102))))[0], 400)

    def test_folders_lists_one_level_within_grants(self):
        for path in ("a/x.txt", "a/b/y.txt", "c/z.txt", "top.txt", "inbox/m/n.txt"):
            self.call("PUT", f"/api/v1/files?path={path}", b"x", self.bearer(**{"content-length": "1"}))
        self.json_call("POST", "/api/v1/folders", {"path": "empty"})
        from tgdrive.objects import Scope
        private = Scope(self.alice.bucket_id, ".tgdrive/private/", private_access=True)
        asyncio.run(self.app.objects.put_object(private, ".tgdrive/private/secret.txt", b"x", 1))
        status, body = self.json_call("GET", "/api/v1/folders")
        self.assertEqual(status, 200, body)
        self.assertNotIn(".tgdrive/", body["folders"])
        self.assertTrue(set(["a/", "empty/", "inbox/"]).issubset(body["folders"]))
        self.assertTrue(body["writable"])
        self.assertEqual(self.json_call("GET", "/api/v1/folders?prefix=a/")[1]["folders"], ["a/b/"])
        # 分页：每页 1 个，游标为上一页最后一个文件夹。
        first = self.json_call("GET", "/api/v1/folders?limit=1")[1]
        second = self.json_call("GET", f"/api/v1/folders?limit=1&cursor={first['next_cursor']}")[1]
        self.assertEqual(len(first["folders"]) + len(second["folders"]), 2)
        self.assertLess(first["folders"][0], second["folders"][0])
        # 前缀授权：根目录只显示通往授权前缀的一层，授权之外不可读，只读密钥 writable 为 false。
        cid = self.clients.create_client("scoped", owner_user_id=self.alice.id)
        ak, secret = self.clients.create_key(cid)
        self.clients.grant(cid, self.alice.bucket_id, "inbox/m/", "ro")
        scoped = self.bearer(ak, secret)
        self.assertEqual(self.json_call("GET", "/api/v1/folders", headers=scoped)[1], {"prefix": "", "folders": ["inbox/"], "writable": False, "next_cursor": None})
        self.assertEqual(self.json_call("GET", "/api/v1/folders?prefix=inbox/", headers=scoped)[1]["folders"], ["inbox/m/"])
        self.assertEqual(self.json_call("GET", "/api/v1/folders?prefix=a/", headers=scoped)[0], 403)


if __name__ == "__main__":
    unittest.main()
