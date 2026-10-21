"""缩略图：按 Blob 加密保存、两种规格、无法生成标记、共享与失效、旧版迁移和公开分享边界。"""
import asyncio
import base64
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

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
        self.app.accounts.setup(PASSPHRASE, "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password", quota_bytes=50_000_000)
        self.scope = Scope(self.alice.bucket_id)
        self.user = asyncio.run(self.client.login("user", "alice@example.com", "alice password"))

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

    def used(self):
        return self.app.metadata.db.execute("SELECT used_bytes FROM buckets WHERE id=?", (self.alice.bucket_id,)).fetchone()[0]

    def stored_keys(self):
        return [row[0] for row in self.app.metadata.db.execute(
            "SELECT key FROM objects WHERE bucket_id=? AND key LIKE '.tgdrive/thumbnails/%' ORDER BY key", (self.alice.bucket_id,))]

    def test_all_variants_are_system_objects_counted_in_quota(self):
        info = self.put("photo.jpg", b"original")
        self.assertEqual(self.set_thumb("photo.jpg", WEBP), 204)
        self.assertEqual(self.used(), 8 + len(WEBP), "列表小图同样是系统区对象，计入配额")
        self.assertEqual(self.set_thumb("photo.jpg", JPEG, "grid"), 204)
        self.assertEqual(self.set_thumb("photo.jpg", JPEG + b"!", "poster"), 204)
        self.assertEqual(self.stored_keys(), [f".tgdrive/thumbnails/{info.blob_uuid}/{variant}" for variant in ("grid", "poster", "thumb")])
        rows = dict(self.app.metadata.db.execute("SELECT variant, length(data) FROM thumbnails WHERE blob_uuid=?", (info.blob_uuid,)).fetchall())
        self.assertEqual(rows, {"thumb": 0, "grid": 0, "poster": 0}, "缩略图不再存进数据库")
        self.assertEqual(self.used(), 8 + len(WEBP) + len(JPEG) * 2 + 1)
        usage = self.call("GET", "/api/user/v1/usage")[1]
        self.assertEqual((usage["thumbnails"], usage["files"]), (len(WEBP) + len(JPEG) * 2 + 1, 8))
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=photo.jpg&variant=grid")[1], JPEG)
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=photo.jpg&variant=poster")[1], JPEG + b"!")
        self.assertEqual(sorted(self.listed("photo.jpg")["thumbnails"]), ["grid", "poster", "thumb"])
        self.assertEqual([item["key"] for item in self.call("GET", "/api/user/v1/list")[1]["objects"]], ["photo.jpg"], "系统区不出现在列表")
        # 重新生成覆盖旧对象，不重复计入配额。
        self.assertEqual(self.set_thumb("photo.jpg", JPEG, "poster"), 204)
        self.assertEqual(self.used(), 8 + len(WEBP) + len(JPEG) * 2)
        # 覆盖内容后旧 Blob 的大图随之删除。
        self.put("photo.jpg", b"changed!")
        self.assertEqual((self.stored_keys(), self.used()), ([], 8))

    def test_grid_falls_back_and_deleting_file_frees_thumbnail_objects(self):
        self.put("clip.mp4")
        self.set_thumb("clip.mp4", WEBP)
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=clip.mp4&variant=grid")[1], WEBP, "没有网格图时退回小图")
        self.set_thumb("clip.mp4", JPEG, "poster")
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=clip.mp4&variant=grid")[1], JPEG, "网格图退回封面")
        self.call("POST", "/api/user/v1/copy", {"from": "clip.mp4", "to": "copy.mp4"})
        asyncio.run(self.app.objects.delete_objects(self.scope, ["clip.mp4"]))
        self.assertEqual(len(self.stored_keys()), 2, "同一存储桶还有副本引用时保留")
        asyncio.run(self.app.objects.delete_objects(self.scope, ["copy.mp4"]))
        self.assertEqual((self.stored_keys(), self.used()), ([], 0))
        self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0], 0)

    def test_etag_address_survives_move_and_keeps_access_boundaries(self):
        info = self.put("album/photo.jpg", b"same content")
        self.assertEqual(self.set_thumb("album/photo.jpg", WEBP), 204)
        self.assertEqual(self.set_thumb("album/photo.jpg", JPEG, "poster"), 204)
        url = f"/api/user/v1/thumbnail?etag={info.etag}&variant=poster&bucket_id={self.alice.bucket_id}"
        self.assertEqual(self.call("GET", url)[1], JPEG)
        self.app.objects.move(self.scope, "album/photo.jpg", "moved/photo.jpg")
        self.assertEqual(self.call("GET", url)[1], JPEG, "地址不含路径，移动后同一地址仍可读取")
        self.assertEqual(self.call("GET", url.replace("poster", "thumb"))[1], WEBP)
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?etag=unknown&variant=thumb")[0], 404)
        # 其他账号不能凭 ETag 读取；私密空间与系统区的副本也不能经普通接口读取。
        bob = self.app.accounts.create_user("bob@example.com", "bob password", quota_bytes=50_000_000)
        asyncio.run(self.app.objects.put_object(Scope(bob.bucket_id), "copy.jpg", b"same content"))
        other = asyncio.run(self.client.login("user", "bob@example.com", "bob password"))
        self.assertEqual(self.call("GET", f"/api/user/v1/thumbnail?etag={info.etag}&variant=thumb", headers=other)[0], 404)
        self.app.objects.move(Scope(self.alice.bucket_id, private_access=True), "moved/photo.jpg", ".tgdrive/private/photo.jpg")
        self.assertEqual(self.call("GET", url)[0], 404)

    def test_stored_thumbnails_do_not_wait_for_transfer_slots(self):
        self.put("photo.jpg")
        self.put("other.jpg")
        self.assertEqual(self.set_thumb("photo.jpg", JPEG, "grid"), 204)
        transfers = self.app.objects.engine.transfers
        transfers.wait_seconds, transfers._active = 0.05, transfers.total
        status, data, _ = self.call("GET", "/api/user/v1/thumbnail?path=photo.jpg&variant=grid")
        self.assertEqual((status, data), (200, JPEG), "下载占满名额时网格图仍可读取")
        # 保存缩略图同样不占文件传输名额：名额被离线下载占满时也能立即写入，不会反过来挤掉下载。
        self.assertEqual(self.set_thumb("other.jpg", WEBP), 204)
        self.assertEqual(self.set_thumb("other.jpg", JPEG, "poster"), 204)

    def test_maintenance_moves_database_posters_and_sweeps_orphans(self):
        info = self.put("old.jpg")
        sealed = self.app.engine.seal_thumbnail(info.blob_uuid, "poster", JPEG)
        with self.app.metadata.transaction() as db:
            db.execute("INSERT INTO thumbnails(blob_uuid,variant,mime,data,created_at) VALUES(?,?,?,?,?)",
                       (info.blob_uuid, "poster", "image/jpeg", sealed, 1.0))
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=old.jpg&variant=poster")[1], JPEG, "旧版数据库封面仍可读取")
        result = asyncio.run(self.app.maintenance.thumbnail_migrator())
        self.assertEqual(result["moved"], 1)
        row = self.app.metadata.db.execute("SELECT length(data), object_key FROM thumbnails WHERE blob_uuid=?", (info.blob_uuid,)).fetchone()
        self.assertEqual(tuple(row), (0, f".tgdrive/thumbnails/{info.blob_uuid}/poster"))
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=old.jpg&variant=poster")[1], JPEG)
        # 没有登记的对象（例如从备份恢复后）在一小时后清理。
        asyncio.run(self.app.objects.put_object(self.scope, ".tgdrive/thumbnails/stray/grid", JPEG))
        self.assertEqual(self.app.objects.sweep_thumbnail_objects(), 0, "刚写入的对象不清理")
        self.assertEqual(self.app.objects.sweep_thumbnail_objects(older_than=-1), 1)
        self.assertEqual(self.stored_keys(), [f".tgdrive/thumbnails/{info.blob_uuid}/poster"])

    def inline(self, info, variant="thumb", data=WEBP, mime="image/webp"):
        sealed = self.app.engine.seal_thumbnail(info.blob_uuid, variant, data)
        with self.app.metadata.transaction() as db:
            db.execute("INSERT INTO thumbnails(blob_uuid,variant,mime,data,created_at) VALUES(?,?,?,?,?)",
                       (info.blob_uuid, variant, mime, sealed, 1.0))

    def test_maintenance_moves_database_list_thumbnails(self):
        infos = [self.put(f"p{index}.jpg", b"photo-%d" % index) for index in range(3)]
        for info in infos:
            self.inline(info)
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=p0.jpg")[1], WEBP, "旧版内联小图在转存前仍可读取")
        self.assertEqual(self.app.objects.inline_thumbnails()["count"], 3)
        self.assertEqual(asyncio.run(self.app.objects.migrate_thumbnails(2)), 2, "按数量分批")
        result = asyncio.run(self.app.maintenance.thumbnail_migrator())
        self.assertEqual((result["moved"], result["inline"]), (1, 0))
        for info in infos:
            row = self.app.metadata.db.execute("SELECT length(data), object_key FROM thumbnails WHERE blob_uuid=?", (info.blob_uuid,)).fetchone()
            self.assertEqual(tuple(row), (0, f".tgdrive/thumbnails/{info.blob_uuid}/thumb"))
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=p2.jpg")[1], WEBP)
        self.assertEqual(self.used(), sum(len(b"photo-%d" % index) for index in range(3)) + 3 * len(WEBP))

    def test_list_thumbnails_stay_inline_when_quota_is_full(self):
        first, second = self.put("a.jpg", b"a"), self.put("b.jpg", b"b")
        self.inline(first)
        self.inline(second, "poster", JPEG, "image/jpeg")
        with self.app.metadata.transaction() as db:
            db.execute("UPDATE buckets SET quota_bytes=used_bytes WHERE id=?", (self.alice.bucket_id,))
        self.assertEqual(asyncio.run(self.app.objects.migrate_thumbnails(10)), 0)
        rows = dict(self.app.metadata.db.execute("SELECT variant, length(data) > 0 FROM thumbnails").fetchall())
        self.assertEqual(rows, {"thumb": 1}, "小图保留在数据库，大图删除后重新生成")
        self.assertEqual(self.app.objects.inline_thumbnails()["skipped_quota"], 1)
        self.assertEqual(asyncio.run(self.app.objects.migrate_thumbnails(10)), 0, "空间仍满时不会空转")
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=a.jpg")[1], WEBP)
        with self.app.metadata.transaction() as db:
            db.execute("UPDATE buckets SET quota_bytes=50000000 WHERE id=?", (self.alice.bucket_id,))
        self.assertEqual(asyncio.run(self.app.objects.migrate_thumbnails(10)), 1, "腾出空间后从头再试")
        self.assertEqual(self.app.objects.inline_thumbnails(), {"count": 0, "bytes": 0, "skipped_quota": 0})

    def test_thumbnails_are_handed_over_to_remaining_bucket(self):
        info = self.put("shared.jpg", b"same content")
        self.assertEqual(self.set_thumb("shared.jpg", WEBP), 204)
        bob = self.app.accounts.create_user("bob@example.com", "bob password", quota_bytes=50_000_000)
        with self.app.metadata.transaction() as db:  # 模拟保存分享：另一个桶引用同一个 Blob
            db.execute("INSERT INTO objects(bucket_id,key,size,etag,content_type,user_meta,modified_at,blob_uuid) "
                       "SELECT ?,key,size,etag,content_type,user_meta,modified_at,blob_uuid FROM objects WHERE bucket_id=? AND key=?",
                       (bob.bucket_id, self.alice.bucket_id, "shared.jpg"))
            db.execute("UPDATE blobs SET refcount=refcount+1 WHERE uuid=?", (info.blob_uuid,))
            db.execute("UPDATE buckets SET used_bytes=used_bytes+? WHERE id=?", (info.size, bob.bucket_id))
        blobs = self.app.metadata.db.execute("SELECT COUNT(*) FROM blobs").fetchone()[0]
        asyncio.run(self.app.objects.delete_objects(self.scope, ["shared.jpg"]))
        self.assertEqual((self.stored_keys(), self.used()), ([], 0), "原桶不再承担缩略图")
        bob_used = self.app.metadata.db.execute("SELECT used_bytes FROM buckets WHERE id=?", (bob.bucket_id,)).fetchone()[0]
        self.assertEqual(bob_used, info.size + len(WEBP))
        row = self.app.metadata.db.execute("SELECT bucket_id FROM thumbnails WHERE blob_uuid=? AND variant='thumb'", (info.blob_uuid,)).fetchone()
        self.assertEqual(row[0], bob.bucket_id)
        self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM blobs").fetchone()[0], blobs, "改归属，不重新上传")
        data, _, _ = asyncio.run(self.app.objects.get_thumbnail(Scope(bob.bucket_id), "shared.jpg"))
        self.assertEqual(data, WEBP, "转交后无需重新生成")
        asyncio.run(self.app.objects.delete_objects(Scope(bob.bucket_id), ["shared.jpg"]))
        self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0], 0)
        self.assertEqual(self.app.metadata.db.execute("SELECT used_bytes FROM buckets WHERE id=?", (bob.bucket_id,)).fetchone()[0], 0)

    def test_compact_switches_to_incremental_vacuum(self):
        metadata = self.app.metadata
        metadata.COMPACT_MIN_FREE = 1
        with metadata.transaction() as db:
            db.execute("CREATE TABLE filler(data BLOB)")
            db.executemany("INSERT INTO filler VALUES(?)", [(b"x" * 4096,) for _ in range(512)])
        with metadata.transaction() as db:
            db.execute("DROP TABLE filler")
        result = metadata.compact()
        self.assertEqual(result["mode"], "vacuum")
        self.assertGreater(result["freed"], 1024 * 1024)
        self.assertEqual(metadata.db.execute("PRAGMA auto_vacuum").fetchone()[0], 2)
        with metadata.transaction() as db:
            db.execute("CREATE TABLE filler(data BLOB)")
            db.executemany("INSERT INTO filler VALUES(?)", [(b"x" * 4096,) for _ in range(256)])
        with metadata.transaction() as db:
            db.execute("DROP TABLE filler")
        result = metadata.compact()
        self.assertEqual((result["mode"], result["free"]), ("incremental", 0))
        self.assertGreater(result["freed"], 512 * 1024)

    def test_migration_rebuilds_thumbnail_table(self):
        columns = [row[1] for row in self.app.metadata.db.execute("PRAGMA table_info(thumbnails)")]
        self.assertIn("object_key", columns)
        self.put("x.jpg")
        self.assertEqual(self.set_thumb("x.jpg", JPEG, "grid"), 204, "新规格通过 CHECK 约束")

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

    def test_identical_upload_reuses_existing_thumbnails(self):
        first = self.put("a.jpg", b"same photo")
        self.assertEqual(self.set_thumb("a.jpg", WEBP), 204)
        objects = len(self.stored_keys())
        second = self.put("album/b.jpg", b"same photo")
        self.assertEqual(second.blob_uuid, first.blob_uuid)
        self.assertEqual(self.listed_in("album/", "album/b.jpg")["thumbnails"], ["thumb"], "相同内容直接共用已有缩略图")
        self.assertEqual(len(self.stored_keys()), objects, "没有生成第二套缩略图")

    def listed_in(self, prefix, key):
        return next(item for item in self.call("GET", f"/api/user/v1/list?prefix={prefix}")[1]["objects"] if item["key"] == key)

    def test_thumbnail_status_returns_only_listed_files(self):
        first, second = self.put("a.jpg"), self.put("b.jpg", b"other")
        self.assertEqual(self.set_thumb("a.jpg", WEBP), 204)
        status, body, headers = self.call("POST", "/api/user/v1/thumbnail/status", {"paths": ["a.jpg", "b.jpg", "gone.jpg"]})
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body["files"]), {"a.jpg", "b.jpg"}, "不存在的路径不出现，页面据此整页刷新")
        self.assertEqual(body["files"]["a.jpg"]["thumbnails"], ["thumb"])
        self.assertEqual((body["files"]["a.jpg"]["etag"], body["files"]["b.jpg"]["thumbnails"]), (first.etag, []))
        self.assertNotIn("key", body["files"]["a.jpg"])
        self.assertEqual(headers["cache-control"], "no-store")
        for paths in ([], ["x"] * 201, "a.jpg", [1]):
            self.assertEqual(self.call("POST", "/api/user/v1/thumbnail/status", {"paths": paths})[0], 400, paths)
        self.assertIn(self.call("POST", "/api/user/v1/thumbnail/status", {"paths": [".tgdrive/private/x.jpg"]})[0], (400, 403))

    def test_queue_is_admin_only_and_contains_no_file_identity(self):
        info = self.put("secret-subdirectory/photo.jpg")
        self.call("POST", "/api/user/v1/thumbnail/claim", {"path": info.key, "etag": info.etag})
        self.assertEqual(self.call("GET", "/api/admin/v1/maintenance/thumbnails")[0], 403)
        admin = asyncio.run(self.client.login("admin", "admin@example.com", "admin password"))
        status, queue, headers = self.call("GET", "/api/admin/v1/maintenance/thumbnails", headers=admin)
        self.assertEqual(status, 200)
        self.assertFalse(queue["automatic_remote_reads"])
        self.assertNotIn("secret-subdirectory", json.dumps(queue))
        self.assertNotIn("photo.jpg", json.dumps(queue))
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(self.call("GET", "/api/user/v1/maintenance/thumbnails")[0], 404)

    def test_browser_generation_ticket_cannot_write_to_overwritten_file(self):
        info = self.put("photo.jpg")
        status, lease, _ = self.call("POST", "/api/user/v1/thumbnail/claim", {"path": info.key, "etag": info.etag})
        self.assertEqual(status, 200)
        self.assertTrue(lease["token"])
        self.put("photo.jpg", b"changed content")
        status, _, _ = self.call("POST", "/api/user/v1/thumbnail", {"path": info.key, "etag": info.etag,
            "ticket": lease["token"], "variant": "thumb", "data": base64.b64encode(WEBP).decode()})
        self.assertEqual(status, 400)
        self.assertFalse(self.listed(info.key)["has_thumbnail"])

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
        status, body = self.call("POST", "/api/user/v1/trash/purge", {"all": True})[:2]
        self.assertEqual((status, body["purged"]), (200, 1))
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
        self.user = asyncio.run(self.client.login("user", "alice@example.com", "alice password"))
        self.assertTrue(self.listed("old.jpg")["has_thumbnail"])
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=old.jpg")[1], WEBP, "转存前直接读取明文副本")
        self.assertEqual(asyncio.run(self.app.objects.adopt_legacy_thumbnails()), 1)
        self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM thumbnail_legacy").fetchone()[0], 0)
        row = self.app.metadata.db.execute("SELECT length(data), object_key FROM thumbnails WHERE blob_uuid=?", (info.blob_uuid,)).fetchone()
        self.assertEqual(tuple(row), (0, f".tgdrive/thumbnails/{info.blob_uuid}/thumb"), "明文直接转为加密存储的对象")
        self.assertEqual(self.call("GET", "/api/user/v1/thumbnail?path=old.jpg")[1], WEBP)

    def test_public_shares_follow_share_boundaries(self):
        self.put("album/a.jpg")
        self.put("secret.jpg", b"secret")
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

    def test_file_list_returns_bounded_folder_previews(self):
        for index in range(3):
            self.put(f"album/{index}.jpg", f"photo {index}".encode())
            self.assertEqual(self.set_thumb(f"album/{index}.jpg", WEBP), 204)
        self.put("album/notes.txt", b"text")
        page = self.call("GET", "/api/user/v1/list")[1]
        self.assertEqual([item["key"] for item in page["folder_previews"]["album/"]], ["album/0.jpg", "album/1.jpg", "album/2.jpg"])
        # 只在每个目录的前 PREVIEW_SAMPLE 个文件里找：前面全是没有缩略图的文件时不扫描整个目录。
        self.app.objects.PREVIEW_SAMPLE = 2
        for index in range(3):
            self.put(f"big/{index:02}.bin", b"x")
        self.put("big/zz.jpg", b"late photo")
        self.assertEqual(self.set_thumb("big/zz.jpg", WEBP), 204)
        page = self.call("GET", "/api/user/v1/list")[1]
        self.assertEqual(page["folder_previews"]["big/"], [])


class ThumbnailCacheTests(unittest.TestCase):
    """缓存与授权回归使用替身，不初始化数据库或执行 SQL。"""

    def setUp(self):
        self.app = object.__new__(TgDriveASGI)
        self.app.user = SimpleNamespace(thumbnail=AsyncMock(return_value=(WEBP, "image/webp", "content-thumb-123")),
                                        objects=SimpleNamespace(read_thumbnail=AsyncMock(return_value=(WEBP, "image/webp", "content-thumb-123"))))
        self.app.admin = SimpleNamespace(thumbnail=AsyncMock(return_value=(WEBP, "image/webp", "content-thumb-123")))
        self.app.private_space = SimpleNamespace(files=lambda *_: self.app.user)
        self.app.metrics = self.app.s3 = self.app.s3_host = self.app.static_dir = None
        self.app.settings = SimpleNamespace(s3_hostname=lambda: None)
        self.app.json_limit = 1024
        self.client = Client(self.app)

    def request(self, path, headers=None):
        return asyncio.run(self.client.request("GET", path, headers=headers))

    def test_long_cache_only_for_current_bucket_and_thumbnail_version(self):
        for route in ("/api/user/v1/thumbnail",):
            for suffix, expected in (
                ("&bucket_id=9&v=content.thumb.123", "private, max-age=31536000, immutable"),
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

    def test_private_thumbnail_uses_session_grant_and_is_never_http_cached(self):
        # 地址里不带解锁令牌，同一版本在多次解锁之间地址不变；授权取自登录会话当前的私密授权。
        # 私密明文不进入浏览器 HTTP 缓存，本机缓存只能由 Service Worker 加密保存（docs/client-cache-design.md）。
        seen = []
        self.app.private_space = SimpleNamespace(session_grants={"session-token": "grant"},
                                                 files=lambda token, access: seen.append((token, access)) or self.app.user)
        status, headers, data = self.request("/api/user/v1/private/thumbnail?path=hidden.jpg&bucket_id=9&v=content.thumb.123",
                                             {"cookie": "tg_session=session-token"})
        self.assertEqual((status, data), (200, WEBP))
        self.assertEqual(seen, [("session-token", "grant")])
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(headers["referrer-policy"], "no-referrer")

    def test_conditional_response_preserves_policy_and_sends_no_image(self):
        path = "/api/user/v1/thumbnail?path=a.jpg&bucket_id=9&v=content.thumb.123"
        for validator in ('"content-thumb-123"', '"old", W/"content-thumb-123"', "*"):
            with self.subTest(validator=validator):
                status, headers, data = self.request(path, {"if-none-match": validator})
                self.assertEqual((status, data), (304, b""))
                self.assertEqual(headers["cache-control"], "private, max-age=31536000, immutable")
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
        api.objects.get_thumbnail = AsyncMock()
        api._scope = Mock(return_value=Scope(9))
        with self.assertRaises(PermissionError):
            asyncio.run(api.thumbnail("session", "a.jpg", bucket_id=10))
        api.objects.get_thumbnail.assert_not_called()
        asyncio.run(api.thumbnail("session", "a.jpg", bucket_id=9))
        api.objects.get_thumbnail.assert_called_once_with(Scope(9), "a.jpg", "thumb")

    def test_regeneration_within_one_second_changes_image_version(self):
        service = ObjectService(Mock(), Mock())
        service.metadata.db.execute.return_value.fetchone.side_effect = [
            {"mime": "image/webp", "data": b"sealed", "created_at": 1000.001, "bucket_id": None, "object_key": None},
            {"mime": "image/webp", "data": b"sealed", "created_at": 1000.002, "bucket_id": None, "object_key": None},
        ]
        service.engine.open_thumbnail.return_value = WEBP
        info = SimpleNamespace(blob_uuid="blob", etag="content-2")
        first = asyncio.run(service.read_thumbnail(info))[2]
        second = asyncio.run(service.read_thumbnail(info))[2]
        self.assertNotEqual(first, second)
        self.assertEqual(TgDriveASGI._thumbnail_cache_control({"bucket_id": ["9"], "v": ["content-2.thumb.1000002000"]}, second),
                         "private, max-age=31536000, immutable")
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


class FolderPreviewQueryTests(unittest.TestCase):
    """仅用常量表执行只读查询，不建表、不迁移，也不读取真实数据库。"""

    def test_sampling_is_bounded_before_thumbnail_lookup(self):
        root = ".tgdrive/private/照片/"
        folder = root + "相册/"
        objects = [(9, folder + f"{index:03d}.jpg", f"blob-{index}", 8, f"etag-{index}", "image/jpeg", 1)
                   for index in range(80)]
        # 同桶其他目录、其他桶及目录标记都不能进入候选；第 65 个文件以后的缩略图不能补入采样。
        objects += [(9, root + f"其他/{index:04d}.jpg", f"other-{index}", 8, "other", "image/jpeg", 1)
                    for index in range(200)]
        objects += [(10, folder + "000.jpg", "foreign", 8, "foreign", "image/jpeg", 1),
                    (9, folder + "000/", None, 0, "directory", None, 1)]
        thumbnails = [(f"blob-{index}", "thumb", 1000 + index) for index in (1, 3, 4, 5, 64, 65)]
        legacy = [("blob-2",)]
        definitions, values = [], []
        for name, columns, rows in (
                ("objects", "bucket_id,key,blob_uuid,size,etag,content_type,modified_at", objects),
                ("thumbnails", "blob_uuid,variant,created_at", thumbnails),
                ("thumbnail_legacy", "blob_uuid", legacy)):
            placeholders = ",".join("(" + ",".join("?" for _ in row) + ")" for row in rows)
            definitions.append(f"{name}({columns}) AS MATERIALIZED (VALUES {placeholders})")
            values.extend(value for row in rows for value in row)
        fixture = "WITH " + ",".join(definitions)
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        # 用虚拟机步数限制重复扫描，避免按耗时断言依赖机器速度；旧查询会耗尽这个预算。
        steps = 0

        def progress():
            nonlocal steps
            steps += 1000
            return steps > 500_000

        def execute(query, parameters):
            statement = fixture + ("," + query[5:] if query.startswith("WITH ") else " " + query)
            return connection.execute(statement, (*values, *parameters))

        metadata = Mock()
        metadata.cached_read.side_effect = lambda key, read: read()
        metadata.db.execute.side_effect = execute
        service = ObjectService(metadata, Mock())
        connection.set_progress_handler(progress, 1000)
        try:
            previews = service.folder_previews(Scope(9, ".tgdrive/private/", private_access=True),
                                               [folder, root + "其他/", root + "空/", folder])
            self.assertEqual([item["key"] for item in previews[folder]],
                             [folder + f"{index:03d}.jpg" for index in (1, 2, 3, 4)])
            self.assertEqual(previews[folder][0]["thumbnail_versions"]["thumb"], "1001000000")
            self.assertEqual({key: items for key, items in previews.items() if key != folder},
                             {root + "其他/": [], root + "空/": []})
            service.PREVIEW_SAMPLE = 1
            self.assertEqual(service.folder_previews(Scope(9, ".tgdrive/private/", private_access=True), [folder]),
                             {folder: []})
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
