"""缩略图：按 Blob 加密保存、两种规格、无法生成标记、共享与失效、旧版迁移和公开分享边界。"""
import asyncio
import base64
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.objects import Scope

WEBP = b"RIFF\x1a\x00\x00\x00WEBPVP8 " + b"\x00" * 14
JPEG = b"\xff\xd8\xff\xe0" + b"poster-bytes" * 8
PASSPHRASE = "encryption passphrase"


def encoded(data):
    return "data:image/webp;base64," + base64.b64encode(data).decode()


class ThumbnailTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp.name) / "data"
        self.open_app()
        self.app.accounts.setup(PASSPHRASE, "admin", "admin password")
        self.alice = self.app.accounts.create_user("alice", "alice password", quota_bytes=50_000_000)
        self.scope = Scope(self.alice.bucket_id)
        self.user = asyncio.run(self.client.login("user", "alice", "alice password"))

    def open_app(self):
        self.app = create_app(self.data_dir, secure_cookies=False)
        self.client = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def call(self, method, path, payload=None, headers=None):
        body = json.dumps(payload).encode() if payload is not None else b""
        status, response_headers, data = asyncio.run(self.client.request(method, path, body, self.user if headers is None else headers))
        is_json = response_headers.get("content-type", "").startswith("application/json")
        return status, (json.loads(data) if data and is_json else data), response_headers

    def put(self, key, data=b"original"):
        return asyncio.run(self.app.objects.put_object(self.scope, key, data))

    def set_thumb(self, path, data, variant="thumb"):
        return self.call("POST", "/api/user/v1/thumbnail", {"path": path, "data": encoded(data) if data else None, "variant": variant})[0]

    def listed(self, key):
        return next(item for item in self.call("GET", "/api/user/v1/list")[1]["objects"] if item["key"] == key)

    def test_variants_are_encrypted_and_poster_falls_back(self):
        info = self.put("movie.mp4")
        self.assertEqual(self.set_thumb("movie.mp4", WEBP), 204)
        status, data, headers = self.call("GET", "/api/user/v1/thumbnail?path=movie.mp4&variant=poster")
        self.assertEqual((status, data, headers["content-type"]), (200, WEBP, "image/webp"), "poster falls back to thumb")
        self.assertEqual(self.set_thumb("movie.mp4", JPEG, "poster"), 204)
        status, data, headers = self.call("GET", "/api/user/v1/thumbnail?path=movie.mp4&variant=poster")
        self.assertEqual((status, data, headers["content-type"]), (200, JPEG, "image/jpeg"))
        stored = [bytes(row[0]) for row in self.app.metadata.db.execute("SELECT data FROM thumbnails WHERE blob_uuid=?", (info.blob_uuid,))]
        self.assertEqual(len(stored), 2)
        self.assertTrue(all(WEBP not in value and b"poster-bytes" not in value for value in stored), "thumbnails must be encrypted at rest")
        item = self.listed("movie.mp4")
        self.assertTrue(item["has_thumbnail"])
        self.assertEqual(sorted(item["thumbnails"]), ["poster", "thumb"])
        # ETag 不变时返回 304
        etag = self.call("GET", "/api/user/v1/thumbnail?path=movie.mp4")[2]["etag"]
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=movie.mp4", headers={**self.user, "if-none-match": etag})[0], 304)

    def test_limits_and_unknown_variant(self):
        self.put("a.jpg")
        self.assertEqual(self.set_thumb("a.jpg", WEBP + b"\x00" * (96 * 1024)), 400)
        self.assertEqual(self.set_thumb("a.jpg", JPEG + b"\x00" * (200 * 1024), "poster"), 204)
        self.assertEqual(self.set_thumb("a.jpg", WEBP, "huge"), 400)
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=a.jpg&variant=huge")[0], 404)
        self.call("POST", "/api/user/v1/folders", {"path": "dir/"})
        self.assertEqual(self.set_thumb("dir/", WEBP), 400, "folders cannot have thumbnails")

    def test_none_marker(self):
        self.put("song.mp3")
        self.assertEqual(self.set_thumb("song.mp3", None, "none"), 204)
        item = self.listed("song.mp3")
        self.assertEqual((item["has_thumbnail"], item["thumbnails"]), (False, ["none"]))
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=song.mp3")[0], 404)
        self.assertEqual(self.set_thumb("song.mp3", WEBP), 204)
        self.assertEqual(self.listed("song.mp3")["thumbnails"], ["thumb"], "a real thumbnail replaces the marker")
        self.assertEqual(self.set_thumb("song.mp3", None, "none"), 204)
        self.assertEqual(self.listed("song.mp3")["thumbnails"], ["thumb"], "marker never hides an existing thumbnail")

    def test_shared_by_copy_and_dropped_with_content(self):
        self.put("photo.jpg")
        self.set_thumb("photo.jpg", WEBP)
        status, copied, _ = self.call("POST", "/api/user/v1/copy", {"from": "photo.jpg", "to": "copy.jpg"})
        self.assertEqual((status, copied["has_thumbnail"]), (201, True), "copies share the blob and its thumbnail")
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=copy.jpg")[1], WEBP)
        self.put("copy.jpg", b"different content")
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=copy.jpg")[0], 404)
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=photo.jpg")[0], 200)
        # 删除并清空回收站后，Blob 回收时缩略图一并删除
        self.call("POST", "/api/user/v1/trash", {"paths": ["photo.jpg"]})
        self.call("POST", "/api/user/v1/trash/purge", {"all": True})
        self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0], 0)

    def test_survives_passphrase_change(self):
        self.put("photo.jpg")
        self.set_thumb("photo.jpg", WEBP)
        self.app.accounts.keystore.rotate(PASSPHRASE, "a brand new passphrase")
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=photo.jpg")[1], WEBP)

    def test_legacy_plaintext_thumbnails_are_migrated_and_encrypted(self):
        info = self.put("old.jpg")
        db = self.app.metadata.db
        db.execute("UPDATE objects SET user_meta=? WHERE bucket_id=? AND key=?",
                   (json.dumps({"tgdrive-thumbnail": base64.b64encode(WEBP).decode(), "other": "kept"}), self.alice.bucket_id, "old.jpg"))
        db.execute("DROP TABLE thumbnails")
        db.execute("DROP TABLE thumbnail_legacy")
        db.execute("PRAGMA user_version = 11")
        db.commit()
        self.app.metadata.close()
        self.open_app()
        meta = json.loads(self.app.metadata.db.execute("SELECT user_meta FROM objects WHERE key='old.jpg'").fetchone()[0])
        self.assertEqual(meta, {"other": "kept"}, "plaintext leaves user_meta during migration")
        self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM thumbnail_legacy").fetchone()[0], 1)
        self.app.accounts.keystore.unlock(PASSPHRASE)
        self.user = asyncio.run(self.client.login("user", "alice", "alice password"))
        self.assertTrue(self.listed("old.jpg")["has_thumbnail"])
        self.assertEqual(self.app.objects.adopt_legacy_thumbnails(), 1)
        self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM thumbnail_legacy").fetchone()[0], 0)
        sealed = bytes(self.app.metadata.db.execute("SELECT data FROM thumbnails WHERE blob_uuid=?", (info.blob_uuid,)).fetchone()[0])
        self.assertNotIn(WEBP, sealed)
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=old.jpg")[1], WEBP)

    def test_public_shares_follow_share_boundaries(self):
        self.put("album/a.jpg")
        self.put("secret.jpg")
        self.set_thumb("album/a.jpg", WEBP)
        self.set_thumb("album/a.jpg", JPEG, "poster")
        self.set_thumb("secret.jpg", WEBP)
        folder = self.app.objects.set_public(self.scope, "album/", True).public_token
        status, _, data = asyncio.run(self.client.request("GET", f"/p/{folder}/a.jpg?thumbnail=poster"))
        self.assertEqual((status, data), (200, JPEG))
        self.assertNotEqual(asyncio.run(self.client.request("GET", f"/p/{folder}/../secret.jpg?thumbnail=thumb"))[0], 200)
        listing = json.loads(asyncio.run(self.client.request("GET", f"/api/public/v1/folders/{folder}/list"))[2])
        self.assertEqual(sorted(listing["files"][0]["thumbnails"]), ["poster", "thumb"])
        downloads = self.app.metadata.db.execute("SELECT public_downloads FROM objects WHERE key='album/'").fetchone()[0]
        self.assertEqual(downloads, 0, "thumbnails do not count as downloads")
        # 带密码的文件分享：没有访问凭证时不能读取缩略图
        status, shared, _ = self.call("POST", "/api/user/v1/public", {"paths": ["secret.jpg"], "public": True, "password": "pass1234"})
        token = shared["objects"][0]["public_token"]
        self.assertNotEqual(asyncio.run(self.client.request("GET", f"/p/{token}?thumbnail=thumb"))[0], 200)
        self.call("POST", "/api/user/v1/public", {"paths": ["secret.jpg"], "public": True, "password": ""})
        self.assertEqual(asyncio.run(self.client.request("GET", f"/p/{token}?thumbnail=thumb"))[2], WEBP)
        info = json.loads(asyncio.run(self.client.request("GET", f"/api/public/v1/objects/{token}"))[2])
        self.assertEqual(info["thumbnails"], ["thumb"])

    def test_backups_leave_out_thumbnails(self):
        self.put("photo.jpg")
        self.set_thumb("photo.jpg", WEBP)
        backup = self.app.maintenance.backups.create()
        restored = self.app.maintenance.snapshots.open(self.app.maintenance.backups.directory / backup["name"])
        snapshot = Path(self.temp.name) / "restored.db"
        snapshot.write_bytes(restored)
        connection = sqlite3.connect(snapshot)
        try:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM objects WHERE key='photo.jpg'").fetchone()[0], 1)
        finally:
            connection.close()
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=photo.jpg")[1], WEBP, "live database keeps its thumbnails")


if __name__ == "__main__":
    unittest.main()
