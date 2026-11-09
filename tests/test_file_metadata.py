"""文件级元数据：升级补建、音乐库只读存储的元数据、排除内置字幕、在线查找信息。仅使用临时存储。"""

import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from urllib.parse import quote

from tgdrive.app import create_app
from tgdrive.metadata import Metadata
from tgdrive.objects import Scope
from tests.test_media_service import FakeHttp, song
from tests.test_public_links import Client


class FileMetadataTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "data"
        self.app = create_app(self.root, secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("test encryption passphrase", "admin@example.com", "admin password")
        self.user = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.user.bucket_id)
        self.store = self.app.objects.file_metadata
        self.client = Client(self.app)
        self.auth = await self.client.login("user", "alice@example.com", "alice password")

    async def asyncTearDown(self):
        await self.app.media.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    async def put(self, key, data=None, mime="audio/mpeg"):
        return await self.app.objects.put_object(self.scope, key, song() if data is None else data, content_type=mime, declared_type=True)

    async def get(self, path):
        status, _, data = await self.client.request("GET", path, b"", self.auth)
        self.assertEqual(status, 200, data)
        return json.loads(data)

    async def test_upgrade_backfills_from_parse_cache_without_reading(self):
        parsed = await self.put("音乐/晴天.mp3")
        await self.app.media.ensure_metadata(self.scope, parsed.key)
        fresh = await self.put("音乐/新歌.mp3", song(title="新歌"))
        note = await self.put("文档/a.txt", b"hello", "text/plain")
        self.app.metadata.close()
        # 模拟升级前的数据库：对象还没有元数据编号，只有按 Blob 的解析缓存。
        with closing(sqlite3.connect(self.root / "meta.db")) as db:
            db.execute("UPDATE objects SET metadata_id=NULL")
            db.execute("DELETE FROM file_metadata")
            db.execute("DELETE FROM media_info WHERE blob_uuid=?", (fresh.blob_uuid,))
            db.execute("PRAGMA user_version=43")
            db.commit()
        with closing(Metadata(self.root / "meta.db")) as migrated:
            rows = {row["key"]: row for row in migrated.db.execute(
                "SELECT o.key, f.kind, f.state, f.fields_ready, f.auto_fields FROM objects o JOIN file_metadata f ON f.id=o.metadata_id")}
        self.assertEqual(set(rows), {parsed.key, fresh.key, note.key})
        cached = rows[parsed.key]
        self.assertEqual((cached["kind"], cached["state"], cached["fields_ready"]), ("audio", "ready", 1))
        fields = json.loads(cached["auto_fields"])
        self.assertEqual((fields["title"], fields["artist"]), ("晴天", "周杰伦"))
        self.assertGreater(fields["duration"], 0)
        # 没有解析缓存的音频留给后台按需解析；其他文件只管理封面。
        self.assertEqual((rows[fresh.key]["state"], rows[fresh.key]["fields_ready"]), ("pending", 0))
        self.assertEqual((rows[note.key]["kind"], rows[note.key]["state"]), ("other", "ready"))

    async def test_music_library_uses_stored_metadata_only(self):
        info = await self.put("音乐/晴天.mp3")
        editor = self.app.media.editor
        opened = await editor.info(self.scope, info.key)
        job = await editor.start(self.scope, info.key, {"etag": info.etag, "revision": opened["revision"],
                                                        "fields": {"album": "我的专辑", "title": "改过的歌名", "track": "3"}})
        await editor.jobs[job["id"]].task
        # 解析缓存里的旧标签不再参与展示与归类。
        self.app.metadata.db.execute("UPDATE media_info SET album='缓存专辑', title='缓存歌名' WHERE blob_uuid=?", (info.blob_uuid,))
        albums = await self.get("/api/user/v1/library/albums")
        self.assertEqual([item["album"] for item in albums["albums"]], ["我的专辑"])
        page = await self.get("/api/user/v1/library?view=music&album=" + quote("我的专辑"))
        media = page["objects"][0]["media"]
        self.assertEqual((media["title"], media["album"], media["track"], media["artist"]), ("改过的歌名", "我的专辑", "3", "周杰伦"))
        self.assertNotIn("metadata_revision", media)
        found = await self.get("/api/user/v1/library?view=music&q=" + quote("改过"))
        self.assertEqual(len(found["objects"]), 1)
        self.assertEqual((await self.get("/api/user/v1/library?view=music&q=" + quote("缓存")))["objects"], [])
        # 非音视频文件不带 media 字段。
        note = await self.put("a.txt", b"hello", "text/plain")
        self.assertNotIn((note.bucket_id, note.key), self.app.objects.file_media_fields([note]))

    async def test_excluded_embedded_subtitles_stop_falling_back(self):
        info = await self.put("视频/a.mkv", b"\x1a\x45\xdf\xa3" + b"\x00" * 64, "video/x-matroska")
        _, row = self.store.ensure(self.scope, info.key)
        streams = [{"index": 0, "text": True, "language": "chi"}, {"index": 1, "text": True, "language": "eng"}, {"index": 2, "text": False}]
        self.assertEqual([item["index"] for item in self.store.embedded_subtitles(row, streams)], [0, 1])
        editor = self.app.media.editor
        await self.app.media.ensure_metadata(self.scope, info.key)
        row = self.store.row(info.metadata_id)
        job = await editor.start(self.scope, info.key, {"etag": info.etag, "revision": row["revision"], "subtitles": {"exclude": [1]}})
        await editor.jobs[job["id"]].task
        self.assertEqual(editor.jobs[job["id"]].state, "done", editor.jobs[job["id"]].detail)
        row = self.store.row(info.metadata_id)
        self.assertEqual([item["index"] for item in self.store.embedded_subtitles(row, streams)], [0])
        with self.assertRaises(ValueError):
            await editor.start(self.scope, info.key, {"etag": info.etag, "revision": row["revision"], "subtitles": {"exclude": ["1"]}})

    async def test_info_lookup_returns_structured_fields_without_tokens(self):
        http = FakeHttp()
        self.app.media.http = http
        http.add("https://lrclib.net/api/search", (200, [
            {"id": 7, "trackName": "晴天", "artistName": "周杰伦", "albumName": "叶惠美", "duration": 269.0, "syncedLyrics": "[00:29.00]故事的小黄花"},
        ]))
        info = await self.put("音乐/晴天.mp3")
        status, _, data = await self.client.request("POST", "/api/user/v1/media/lookup",
                                                    json.dumps({"path": info.key, "want": "info"}).encode(), self.auth)
        self.assertEqual(status, 200, data)
        body = json.loads(data)
        by_provider = {item["provider"]: item for item in body["candidates"]}
        self.assertEqual(by_provider["lrclib"]["fields"], {"title": "晴天", "artist": "周杰伦", "album": "叶惠美"})
        self.assertEqual(by_provider["embedded"]["fields"]["title"], "晴天")
        self.assertTrue(all(item["token"] == "" and item["want"] == "info" for item in body["candidates"]))
        media = await self.get("/api/user/v1/media/info?path=" + quote(info.key))
        self.assertIn({"id": "lrclib", "name": "LRCLIB"}, media["providers"]["info"])


if __name__ == "__main__":
    unittest.main()
