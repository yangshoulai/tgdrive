"""M19：回收站、分享有效期/密码/下载计数、缩略图、可续传上传与删除用户。"""
import asyncio
import base64
import json
import tempfile
import time
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.objects import Scope

WEBP = b"RIFF\x1a\x00\x00\x00WEBPVP8 " + b"\x00" * 14


class FeatureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.alice = self.app.accounts.create_user("alice", "alice password", quota_bytes=50_000_000)
        self.scope = Scope(self.alice.bucket_id)
        self.client = Client(self.app)
        self.user = asyncio.run(self.client.login("user", "alice", "alice password"))

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def call(self, method, path, payload=None, headers=None, raw=None):
        body = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else b"")
        status, response_headers, data = asyncio.run(self.client.request(method, path, body, self.user if headers is None else headers))
        is_json = response_headers.get("content-type", "").startswith("application/json")
        return status, (json.loads(data) if data and is_json else data), response_headers

    def put(self, key, data=b"x"):
        return asyncio.run(self.app.objects.put_object(self.scope, key, data))

    def keys(self):
        return sorted(row[0] for row in self.app.metadata.db.execute("SELECT key FROM objects WHERE bucket_id=?", (self.alice.bucket_id,)))

    def test_trash_hides_restores_and_purges(self):
        self.put("docs/a.txt", b"aaaa")
        self.put("docs/sub/b.txt", b"bb")
        self.put("c.txt", b"c")
        token = self.app.objects.set_public(self.scope, "docs/a.txt", True).public_token
        status, body, _ = self.call("POST", "/api/user/v1/trash", {"paths": ["docs/", "c.txt"]})
        self.assertEqual(status, 200)
        listing = self.call("GET", "/api/user/v1/list")[1]
        self.assertEqual((listing["objects"], listing["common_prefixes"]), ([], []))
        self.assertEqual(self.call("GET", "/api/user/v1/search?q=txt")[1]["objects"], [])
        self.assertEqual(asyncio.run(self.client.request("GET", f"/p/{token}"))[0], 404, "trashed share must not be reachable")
        trash = self.call("GET", "/api/user/v1/trash")[1]
        self.assertEqual([(item["path"], item["is_folder"], item["item_count"]) for item in trash["items"]],
                         [("c.txt", False, 1), ("docs/", True, 2)])
        self.assertEqual(trash["total_size"], 7)
        # 还原文件夹：内容与公开链接一并恢复；原位置被占用时改名保留两者。
        self.put("c.txt", b"new")
        docs = next(item for item in trash["items"] if item["path"] == "docs/")
        cfile = next(item for item in trash["items"] if item["path"] == "c.txt")
        self.call("POST", "/api/user/v1/trash/restore", {"ids": [docs["id"], cfile["id"]]})
        self.assertEqual(self.keys(), ["c (1).txt", "c.txt", "docs/", "docs/a.txt", "docs/sub/b.txt"])
        self.assertEqual(asyncio.run(self.client.request("GET", f"/p/{token}"))[0], 200)
        # 永久删除与自动过期。
        self.call("POST", "/api/user/v1/trash", {"paths": ["c (1).txt"]})
        self.call("POST", "/api/user/v1/trash", {"paths": ["c.txt"]})
        self.assertEqual(self.call("POST", "/api/user/v1/trash/purge", {"ids": [self.call("GET", "/api/user/v1/trash")[1]["items"][0]["id"]]})[1]["purged"], 1)
        self.assertEqual(asyncio.run(self.app.objects.purge_expired_trash(time.time() + 31 * 86400)), 1)
        self.assertEqual(self.call("GET", "/api/user/v1/trash")[1]["items"], [])
        self.assertEqual(self.keys(), ["docs/", "docs/a.txt", "docs/sub/b.txt"])
        # S3 与保留路径不能访问回收站。
        self.assertEqual(self.call("GET", "/api/user/v1/list?prefix=.tgdrive/")[0], 403)

    def test_share_expiry_password_and_download_count(self):
        self.put("r.pdf", b"report")
        status, body, _ = self.call("POST", "/api/user/v1/public", {"paths": ["r.pdf"], "public": True, "password": "s3cret"})
        token = body["objects"][0]["public_token"]
        self.assertTrue(body["objects"][0]["public_has_password"])
        meta = json.loads(asyncio.run(self.client.request("GET", f"/api/public/v1/objects/{token}"))[2])
        self.assertEqual(meta, {"token": token, "password_required": True})
        status, _, data = asyncio.run(self.client.request("GET", f"/p/{token}/r.pdf"))
        self.assertEqual((status, json.loads(data)["error"]["code"]), (403, "password_required"))
        bad = asyncio.run(self.client.request("POST", f"/api/public/v1/objects/{token}/unlock", b'{"password":"nope"}'))
        self.assertEqual(bad[0], 400)
        good = json.loads(asyncio.run(self.client.request("POST", f"/api/public/v1/objects/{token}/unlock", b'{"password":"s3cret"}'))[2])
        access = good["access"]
        meta = json.loads(asyncio.run(self.client.request("GET", f"/api/public/v1/objects/{token}?access={access}"))[2])
        self.assertEqual((meta["name"], meta["password_required"]), ("r.pdf", False))
        for _ in range(2):
            self.assertEqual(asyncio.run(self.client.request("GET", f"/p/{token}/r.pdf?access={access}"))[2], b"report")
        asyncio.run(self.client.request("GET", f"/p/{token}?access={access}", headers={"range": "bytes=2-3"}))
        self.assertEqual(self.app.objects.head_object(self.scope, "r.pdf").public_downloads, 2)
        # 修改密码后旧凭证失效。
        self.call("POST", "/api/user/v1/public", {"paths": ["r.pdf"], "public": True, "password": "another"})
        self.assertEqual(asyncio.run(self.client.request("GET", f"/p/{token}?access={access}"))[0], 403)
        # 取消密码、设置有效期，到期后返回 410。
        self.call("POST", "/api/user/v1/public", {"paths": ["r.pdf"], "public": True, "password": None, "expires_at": time.time() + 3600})
        self.assertEqual(asyncio.run(self.client.request("GET", f"/p/{token}"))[0], 200)
        self.app.metadata.db.execute("UPDATE objects SET public_expires_at=? WHERE key='r.pdf'", (time.time() - 1,))
        self.app.metadata.db.commit()
        status, _, data = asyncio.run(self.client.request("GET", f"/p/{token}"))
        self.assertEqual((status, json.loads(data)["error"]["code"]), (410, "share_expired"))
        self.assertEqual(self.call("POST", "/api/user/v1/public", {"paths": ["r.pdf"], "public": True, "expires_at": time.time() - 5})[0], 400)
        # 覆盖上传保留分享设置；关闭分享清除全部设置。
        self.app.metadata.db.execute("UPDATE objects SET public_expires_at=NULL WHERE key='r.pdf'")
        self.app.metadata.db.commit()
        self.call("POST", "/api/user/v1/public", {"paths": ["r.pdf"], "public": True, "password": "keepme"})
        self.put("r.pdf", b"v2")
        self.assertTrue(self.app.objects.head_object(self.scope, "r.pdf").public_has_password)
        self.call("POST", "/api/user/v1/public", {"paths": ["r.pdf"], "public": False})
        info = self.app.objects.head_object(self.scope, "r.pdf")
        self.assertEqual((info.public_token, info.public_has_password, info.public_downloads), (None, False, 0))

    def test_unlock_attempts_are_rate_limited(self):
        self.put("x.bin")
        token = self.call("POST", "/api/user/v1/public", {"paths": ["x.bin"], "public": True, "password": "right"})[1]["objects"][0]["public_token"]
        for _ in range(5):
            asyncio.run(self.client.request("POST", f"/api/public/v1/objects/{token}/unlock", b'{"password":"wrong"}'))
        status = asyncio.run(self.client.request("POST", f"/api/public/v1/objects/{token}/unlock", b'{"password":"right"}'))[0]
        self.assertEqual(status, 429)

    def test_thumbnails(self):
        self.put("photo.jpg", b"big image bytes")
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=photo.jpg")[0], 404)
        self.assertEqual(self.call("POST", "/api/user/v1/thumbnail", {"path": "photo.jpg", "data": base64.b64encode(b"not an image").decode()})[0], 400)
        self.assertEqual(self.call("POST", "/api/user/v1/thumbnail", {"path": "photo.jpg", "data": "data:image/webp;base64," + base64.b64encode(WEBP).decode()})[0], 204)
        status, data, headers = self.call("GET", "/api/user/v1/thumbnail?path=photo.jpg")
        self.assertEqual((status, data, headers["content-type"]), (200, WEBP, "image/webp"))
        listed = self.call("GET", "/api/user/v1/list")[1]["objects"][0]
        self.assertTrue(listed["has_thumbnail"])
        self.assertNotIn("tgdrive-thumbnail", listed["user_meta"])
        self.call("POST", "/api/user/v1/move", {"from": "photo.jpg", "to": "album/photo.jpg"})
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=album/photo.jpg")[0], 200)
        self.put("album/photo.jpg", b"new content")
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=album/photo.jpg")[0], 404, "overwrite must drop stale thumbnail")

    def test_resumable_upload(self):
        part = 5 * 1024 * 1024
        data = bytes(range(256)) * (part * 2 // 256) + b"tail"
        status, created, _ = self.call("POST", "/api/user/v1/uploads", {"path": "big/video.mp4", "content_type": "video/mp4"})
        upload_id = created["upload_id"]
        first = self.call("PUT", f"/api/user/v1/uploads/{upload_id}/parts/1", raw=data[:part], headers={**self.user, "content-length": str(part)})[1]
        # 模拟页面刷新：查询已上传的分段，跳过第一段继续。
        state = self.call("GET", f"/api/user/v1/uploads/{upload_id}")[1]
        self.assertEqual([(item["part_no"], item["size"]) for item in state["parts"]], [(1, part)])
        second = self.call("PUT", f"/api/user/v1/uploads/{upload_id}/parts/2", raw=data[part:2 * part])[1]
        third = self.call("PUT", f"/api/user/v1/uploads/{upload_id}/parts/3", raw=data[2 * part:])[1]
        status, done, _ = self.call("POST", f"/api/user/v1/uploads/{upload_id}/complete",
                                    {"parts": [[1, first["etag"]], [2, second["etag"]], [3, third["etag"]]], "public": True})
        self.assertEqual(status, 200, done)
        self.assertTrue(done["public_token"])
        self.assertEqual(self.call("GET", "/api/user/v1/content?path=big/video.mp4")[1], data)
        # 中止与越权。
        other = self.call("POST", "/api/user/v1/uploads", {"path": "tmp.bin"})[1]["upload_id"]
        self.assertEqual(self.call("DELETE", f"/api/user/v1/uploads/{other}")[0], 204)
        self.assertEqual(self.call("GET", f"/api/user/v1/uploads/{other}")[0], 404)
        bob = self.app.accounts.create_user("bob", "bob password")
        bob_session = asyncio.run(self.client.login("user", "bob", "bob password"))
        self.assertEqual(self.call("GET", f"/api/user/v1/uploads/{upload_id}", headers=bob_session)[0], 404)
        self.assertIsNotNone(bob)

    def test_admin_deletes_user_completely(self):
        self.put("a.txt", b"data")
        self.call("POST", "/api/user/v1/clients", {"name": "nas"})
        self.call("POST", "/api/user/v1/trash", {"paths": ["a.txt"]})
        admin = asyncio.run(self.client.login("admin", "admin", "admin password"))
        self.assertEqual(self.call("POST", f"/api/admin/v1/users/{self.alice.id}/delete", {"confirm": "wrong"}, admin)[0], 400)
        status, body, _ = self.call("POST", f"/api/admin/v1/users/{self.alice.id}/delete", {"confirm": "alice"}, admin)
        self.assertEqual((status, body["deleted_objects"]), (200, 1))
        db = self.app.metadata.db
        for table, column in (("users", "id"), ("buckets", "id"), ("clients", "owner_user_id")):
            value = self.alice.id if column != "id" or table == "users" else self.alice.bucket_id
            self.assertIsNone(db.execute(f"SELECT 1 FROM {table} WHERE {column}=?", (value,)).fetchone(), table)
        self.assertGreater(db.execute("SELECT COUNT(*) FROM gc_queue").fetchone()[0], 0)
        self.assertEqual(self.call("GET", "/api/user/v1/me")[0], 401)
        admin_id = db.execute("SELECT id FROM users WHERE role='admin'").fetchone()[0]
        self.assertEqual(self.call("POST", f"/api/admin/v1/users/{admin_id}/delete", {"confirm": "admin"}, admin)[0], 403)


if __name__ == "__main__":
    unittest.main()
