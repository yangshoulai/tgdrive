"""缩略图：按 Blob 加密保存、两种规格、无法生成标记、共享与失效、旧版迁移和公开分享边界。"""
import asyncio
import base64
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.api import UserApi
from tgdrive.asgi import TgDriveASGI
from tgdrive.errors import NotFoundError
from tgdrive.objects import ObjectService, Scope

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


class ThumbnailCacheTests(unittest.TestCase):
    """缓存与授权回归使用替身，不初始化数据库或执行 SQL。"""

    def setUp(self):
        self.app = object.__new__(TgDriveASGI)
        self.app.user = SimpleNamespace(thumbnail=Mock(return_value=(WEBP, "image/webp", "content-thumb-123")),
                                        objects=SimpleNamespace(read_thumbnail=Mock(return_value=(WEBP, "image/webp", "content-thumb-123"))))
        self.app.admin = SimpleNamespace(thumbnail=Mock(return_value=(WEBP, "image/webp", "content-thumb-123")))
        self.app.private_space = SimpleNamespace(files=lambda *_: self.app.user)
        self.app.metrics = self.app.s3 = self.app.s3_host = self.app.static_dir = None
        self.app.settings = SimpleNamespace(s3_hostname=lambda: None)
        self.app.json_limit = 1024
        self.client = Client(self.app)

    def request(self, path, headers=None):
        return asyncio.run(self.client.request("GET", path, headers=headers))

    def test_long_cache_only_for_current_bucket_and_thumbnail_version(self):
        for route in ("/api/user/v1/thumbnail", "/api/admin/v1/thumbnail"):
            for suffix, expected in (
                ("&bucket_id=9&v=content.thumb.123", "private, max-age=2592000, immutable"),
                ("&bucket_id=9&v=content.thumb.122", "private, no-cache"),
                ("&bucket_id=9&v=content.thumb.123&variant=poster", "private, no-cache"),
                ("&bucket_id=9", "private, no-cache"),
            ):
                with self.subTest(route=route, suffix=suffix):
                    status, headers, data = self.request(route + "?path=a.jpg" + suffix)
                    self.assertEqual((status, data), (200, WEBP))
                    self.assertEqual(headers["cache-control"], expected)
        headers = self.request("/api/user/v1/thumbnail?path=a.jpg&v=content.thumb.123")[1]
        self.assertEqual(headers["cache-control"], "private, no-cache")

    def test_private_thumbnail_never_uses_persistent_cache(self):
        status, headers, data = self.request("/api/user/v1/private/thumbnail?path=hidden.jpg&bucket_id=9&v=content.thumb.123")
        self.assertEqual((status, data), (200, WEBP))
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(headers["referrer-policy"], "no-referrer")

    def test_conditional_response_preserves_policy_and_sends_no_image(self):
        path = "/api/user/v1/thumbnail?path=a.jpg&bucket_id=9&v=content.thumb.123"
        for validator in ('"content-thumb-123"', '"old", W/"content-thumb-123"', "*"):
            with self.subTest(validator=validator):
                status, headers, data = self.request(path, {"if-none-match": validator})
                self.assertEqual((status, data), (304, b""))
                self.assertEqual(headers["cache-control"], "private, max-age=2592000, immutable")
                self.assertEqual(headers["etag"], '"content-thumb-123"')

    def test_public_thumbnail_revalidates_and_revoked_share_cannot_return_304(self):
        self.app._public_share = Mock(return_value=(SimpleNamespace(key="a.jpg"), None))
        status, headers, _ = self.request("/p/share?thumbnail=thumb")
        self.assertEqual(status, 200)
        self.assertEqual(headers["cache-control"], "public, no-cache")
        self.assertEqual(self.request("/p/share?thumbnail=thumb", {"if-none-match": headers["etag"]})[0], 304)
        self.app._public_share.side_effect = NotFoundError("share")
        self.assertEqual(self.request("/p/share?thumbnail=thumb", {"if-none-match": headers["etag"]})[0], 404)

    def test_bucket_cache_key_cannot_read_another_accounts_thumbnail(self):
        api = UserApi(Mock(), Mock())
        api._scope = Mock(return_value=Scope(9))
        with self.assertRaises(PermissionError):
            api.thumbnail("session", "a.jpg", bucket_id=10)
        api.objects.get_thumbnail.assert_not_called()
        api.thumbnail("session", "a.jpg", bucket_id=9)
        api.objects.get_thumbnail.assert_called_once_with(Scope(9), "a.jpg", "thumb")

    def test_regeneration_within_one_second_changes_image_version(self):
        service = ObjectService(Mock(), Mock())
        service.metadata.db.execute.return_value.fetchone.side_effect = [
            {"mime": "image/webp", "data": b"sealed", "created_at": 1000.001},
            {"mime": "image/webp", "data": b"sealed", "created_at": 1000.002},
        ]
        service.engine.open_thumbnail.return_value = WEBP
        info = SimpleNamespace(blob_uuid="blob", etag="content-2")
        first = service.read_thumbnail(info)[2]
        second = service.read_thumbnail(info)[2]
        self.assertNotEqual(first, second)
        self.assertEqual(TgDriveASGI._thumbnail_cache_control({"bucket_id": ["9"], "v": ["content-2.thumb.1000002000"]}, second),
                         "private, max-age=2592000, immutable")
        self.assertEqual(TgDriveASGI._thumbnail_cache_control({"bucket_id": ["9"], "v": ["content-2.thumb.1000001000"]}, second),
                         "private, no-cache")

    def test_folder_and_file_list_share_same_thumb_revision(self):
        service = ObjectService(Mock(), Mock())
        service.metadata.cached_read = lambda key, read: read()
        row = {"prefix": "album/", "key": "album/a.jpg", "size": 8, "etag": "content", "content_type": "image/jpeg",
               "modified_at": 1000, "thumbnail_created_at": 1000.001}
        service.metadata.db.execute.return_value = [row]
        folder = service.folder_previews(Scope(9), ["album/"])["album/"][0]
        service.metadata.db.execute.return_value = [
            {"blob_uuid": "blob", "variant": "thumb", "created_at": 1000.001},
            {"blob_uuid": "blob", "variant": "poster", "created_at": 1000.002},
        ]
        versions = service.thumbnail_versions(["blob", "blob"])
        self.assertEqual(folder["thumbnail_versions"]["thumb"], versions["blob"]["thumb"])
        self.assertNotEqual(versions["blob"]["thumb"], versions["blob"]["poster"])


if __name__ == "__main__":
    unittest.main()
