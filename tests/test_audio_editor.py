"""文件级元数据编辑回归：内容不变、小资源计费、版本冲突、生命周期和权限。仅使用临时存储。"""

import asyncio
import json
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tgdrive.app import create_app
from tgdrive.errors import NotFoundError, QuotaExceededError, VersionConflict
from tgdrive.objects import Scope
from tests.test_public_links import Client
from tests.test_media_service import song

FFMPEG = shutil.which("ffmpeg")
LYRICS = "[00:00.10]第一句 # = ; \\\n[00:00.20]Second line\n"
SRT = "1\n00:00:00,200 --> 00:00:01,500\n第一句字幕\n"


class AudioEditorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.app = create_app(self.folder / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("test encryption passphrase", "admin@example.com", "admin password")
        self.user = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.user.bucket_id)
        self.editor = self.app.media.editor
        self.store = self.app.objects.file_metadata

    async def asyncTearDown(self):
        await self.app.media.stop()
        await self.app.thumbnails.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    def sample(self, extension):
        if not FFMPEG:
            self.skipTest("需要 FFmpeg")
        path = self.folder / ("source." + extension)
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.4",
                        "-metadata", "artist=原歌手", "-metadata", "comment=keep me", str(path)], check=True)
        return path

    async def start(self, scope, key, payload):
        info, row = self.store.ensure(scope, key)
        return await self.editor.start(scope, key, {"revision": row["revision"], **payload})

    async def wait(self, job):
        await asyncio.wait_for(self.editor.jobs[job["id"]].task, timeout=20)
        return self.editor.status(self.scope, [job["id"]])[0]

    async def put(self, key="song.mp3", data=None, mime="audio/mpeg"):
        return await self.app.objects.put_object(self.scope, key, song() if data is None else data, content_type=mime, declared_type=True)

    async def test_fields_and_lyrics_do_not_read_or_replace_original(self):
        info = await self.put()
        await self.editor.info(self.scope, info.key)
        with patch.object(self.app.objects.engine, "stream", side_effect=AssertionError("编辑不得读取原文件")):
            result = await self.wait(await self.start(self.scope, info.key, {"etag": info.etag, "fields": {"title": "新歌曲", "artist": "新歌手", "album": "新专辑", "lyrics": LYRICS}}))
        self.assertEqual(result["state"], "done", result)
        latest = await self.editor.info(self.scope, info.key)
        self.assertEqual((latest["fields"]["title"], latest["fields"]["artist"], latest["lyrics"]), ("新歌曲", "新歌手", LYRICS.strip()))
        current = self.app.objects.head_object(self.scope, info.key)
        self.assertEqual((current.blob_uuid, current.etag, current.modified_at, current.size), (info.blob_uuid, info.etag, info.modified_at, info.size))
        resources = self.store.assets(info.metadata_id)
        self.assertTrue(resources)
        self.assertTrue(all(item["object_key"].startswith(".tgdrive/media/") for item in resources))
        self.assertEqual(self.app.objects._bucket(info.bucket_id)["used_bytes"], info.size + sum(item["size"] for item in resources))
        self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM objects WHERE key LIKE '%.lrc' AND substr(key,1,9)!='.tgdrive/'").fetchone()[0], 0)
        raw = self.app.metadata.db.execute("SELECT auto_fields,overrides FROM file_metadata WHERE id=?", (info.metadata_id,)).fetchone()
        self.assertNotIn("第一句", str(tuple(raw)))

    async def test_all_audio_formats_keep_exact_original_bytes(self):
        for extension in ("mp3", "flac", "m4a", "wav"):
            path = self.sample(extension)
            data = path.read_bytes()
            info = await self.put(path.name, data, "audio/" + extension)
            await self.editor.info(self.scope, path.name)
            result = await self.wait(await self.start(self.scope, path.name, {"etag": info.etag, "fields": {"title": "中文歌曲", "lyrics": LYRICS}}))
            self.assertEqual(result["state"], "done", result)
            self.assertEqual(b"".join([piece async for piece in self.app.objects.engine.stream(info.blob_uuid, bucket_id=self.scope.bucket_id)]), data)

    async def test_multiple_subtitles_update_delete_and_no_resurrection(self):
        info = await self.put("movie.mp4", b"video fixture", "video/mp4")
        await self.app.objects.put_object(self.scope, "movie.zh.srt", SRT.encode(), content_type="application/x-subrip")
        self.assertEqual(self.app.objects.preview_assets(self.scope, info.key), [])
        self.assertEqual(len(self.app.objects.related_media_files(self.scope, info.key)), 1)
        result = await self.wait(await self.start(self.scope, info.key, {"etag": info.etag, "fields": {"actors": "演员甲、演员乙", "director": "导演甲"}, "subtitles": {"upsert": [
            {"text": SRT, "language": "zh-CN", "title": "中文字幕", "default": True},
            {"text": SRT.replace("第一句字幕", "Hello"), "language": "en", "title": "English", "default": False}]}}))
        self.assertEqual(result["state"], "done", result)
        assets = self.store.assets(info.metadata_id, "subtitle")
        # 模拟首次提取的中文轨；删除后后台不能重新加回这一来源。
        zh = next(item for item in assets if item["language"] == "zh-CN")
        self.app.metadata.db.execute("UPDATE file_media_assets SET source='embedded:0' WHERE id=?", (zh["id"],))
        self.assertEqual({item["language"] for item in assets}, {"zh-CN", "en"})
        zh, en = next(item for item in assets if item["language"] == "zh-CN"), next(item for item in assets if item["language"] == "en")
        result = await self.wait(await self.start(self.scope, info.key, {"etag": info.etag, "subtitles": {"remove": [zh["id"]], "upsert": [{"id": en["id"], "title": "English default", "default": True}]}}))
        self.assertEqual(result["state"], "done", result)
        await self.store.initial_asset(self.scope, info, "subtitle", SRT, source="embedded:0", language="zh-CN")
        remaining = self.store.assets(info.metadata_id, "subtitle")
        self.assertEqual(len(remaining), 1)
        self.assertEqual((remaining[0]["title"], remaining[0]["is_default"]), ("English default", 1))
        await self.store.initial_asset(self.scope, info, "subtitle", SRT, source="embedded:1", language="ja")
        self.assertEqual(len(self.store.assets(info.metadata_id, "subtitle")), 2)
        self.assertEqual(self.app.objects.head_object(self.scope, info.key).etag, info.etag)

    async def test_revision_conflict_and_cancel_preserve_resources(self):
        info = await self.put()
        await self.editor.info(self.scope, info.key)
        result = await self.wait(await self.start(self.scope, info.key, {"etag": info.etag, "fields": {"title": "已保存"}}))
        self.assertEqual(result["state"], "done", result)
        with self.assertRaises(VersionConflict):
            await self.editor.start(self.scope, info.key, {"etag": info.etag, "revision": 0, "fields": {"title": "冲突"}})
        await self.editor.slot.acquire()
        try:
            job = await self.start(self.scope, info.key, {"etag": info.etag, "fields": {"lyrics": "取消歌词"}})
            await asyncio.sleep(0)
            self.editor.cancel(self.scope, job["id"])
            self.assertEqual((await self.wait(job))["state"], "cancelled")
        finally:
            self.editor.slot.release()
        self.assertEqual((await self.editor.info(self.scope, info.key))["fields"]["title"], "已保存")
        self.assertTrue(self.editor.cancel(self.scope, result["id"])["committed"])

    async def test_quota_failure_rolls_back_and_cleans_staged_objects(self):
        info = await self.put()
        await self.editor.info(self.scope, info.key)
        used = self.app.objects._bucket(info.bucket_id)["used_bytes"]
        self.app.metadata.db.execute("UPDATE buckets SET quota_bytes=? WHERE id=?", (used + len(SRT.encode()) + 50, info.bucket_id))
        result = await self.wait(await self.start(self.scope, info.key, {"etag": info.etag, "fields": {"title": "不可提交", "lyrics": "新歌词" * 300}}))
        self.assertEqual(result["state"], "failed")
        self.assertEqual(self.app.objects._bucket(info.bucket_id)["used_bytes"], used)
        self.assertEqual((await self.editor.info(self.scope, info.key))["fields"]["title"], "晴天")

    async def test_copy_move_trash_restore_and_delete_preserve_independence(self):
        info = await self.put()
        await self.editor.info(self.scope, info.key)
        await self.wait(await self.start(self.scope, info.key, {"etag": info.etag, "fields": {"title": "源歌曲", "lyrics": LYRICS}}))
        copied = self.app.objects.link_copy(info.bucket_id, info.key, self.scope, "copy.mp3")
        self.assertNotEqual(copied.metadata_id, info.metadata_id)
        await self.wait(await self.start(self.scope, copied.key, {"etag": copied.etag, "fields": {"title": "副本"}}))
        self.assertEqual((await self.editor.info(self.scope, info.key))["fields"]["title"], "源歌曲")
        self.app.objects.move(self.scope, info.key, "renamed.mp3")
        entries = await self.app.objects.trash(self.scope, ["renamed.mp3"])
        self.app.objects.restore(self.scope, [entries[0]["id"]])
        self.assertEqual((await self.editor.info(self.scope, "renamed.mp3"))["fields"]["title"], "源歌曲")
        await self.app.objects.delete_objects(self.scope, ["renamed.mp3"])
        self.assertIsNone(self.store.row(info.metadata_id))
        self.assertTrue(self.store.assets(copied.metadata_id))
        self.assertEqual(self.app.objects._bucket(info.bucket_id)["used_bytes"], copied.size + sum(a["size"] for a in self.store.assets(copied.metadata_id)))

    async def test_private_assets_and_jobs_require_source_authorization(self):
        private = Scope(self.user.bucket_id, ".tgdrive/private/", private_access=True)
        key = ".tgdrive/private/song.mp3"
        info = await self.app.objects.put_object(private, key, song(), content_type="audio/mpeg")
        # 没有保存歌词时编辑器预填内置歌词，但不另存资源。
        opened = await self.editor.info(private, key)
        self.assertEqual((opened["lyrics_source"], self.store.assets(info.metadata_id, "lyrics")), ("embedded", []))
        self.assertIn("故事", opened["lyrics"])
        job = await self.start(private, key, {"etag": info.etag, "fields": {"lyrics": LYRICS}})
        await asyncio.wait_for(self.editor.jobs[job["id"]].task, timeout=20)
        asset = self.store.assets(info.metadata_id, "lyrics")[0]
        with self.assertRaises(PermissionError):
            await self.store.read_asset(self.scope, key, asset["id"])
        data, _, _ = await self.store.read_asset(private, key, asset["id"])
        self.assertIn("第一句", data.decode())
        revoked = False
        def authorize():
            if revoked:
                raise PermissionError("已上锁")
        guarded = Scope(self.user.bucket_id, private_access=True, authorize=authorize)
        read = self.app.objects.engine.read_small
        async def lock_while_reading(blob):
            nonlocal revoked
            data = await read(blob); revoked = True; return data
        with patch.object(self.app.objects.engine, "read_small", lock_while_reading):
            with self.assertRaises(PermissionError):
                await self.store.read_asset(guarded, key, asset["id"])

    async def test_http_requires_csrf_and_never_audits_text(self):
        client = Client(self.app)
        auth = await client.login("user", "alice@example.com", "alice password")
        info = await self.put()
        await self.editor.info(self.scope, info.key)
        payload = json.dumps({"path": info.key, "etag": info.etag, "revision": 0, "fields": {"title": "不要记录的歌名", "lyrics": "正文" * 100000}}).encode()
        self.assertEqual((await client.request("POST", "/api/user/v1/media/edit", payload, {"cookie": auth["cookie"]}))[0], 403)
        status, _, data = await client.request("POST", "/api/user/v1/media/edit", payload, auth)
        self.assertEqual(status, 202, data)
        self.assertEqual((await self.wait(json.loads(data)))["state"], "done")
        rows = self.app.metadata.db.execute("SELECT target,detail FROM audit_log WHERE action='media.edit'").fetchall()
        self.assertTrue(rows)
        self.assertNotIn("不要记录", str([tuple(row) for row in rows]))
        self.assertNotIn("正文", str([tuple(row) for row in rows]))

    async def test_custom_covers_are_independent_and_other_files_only_support_covers(self):
        from dataclasses import replace
        from tests.test_thumbnails import WEBP
        info = await self.put("note.txt", b"plain text", "text/plain")
        self.assertFalse((await self.editor.info(self.scope, info.key))["editable"])
        with self.assertRaises(ValueError):
            await self.start(self.scope, info.key, {"etag": info.etag, "fields": {"title": "no"}})
        scope = replace(self.scope, custom_cover=True)
        for variant in ("thumb", "grid", "poster"):
            await self.app.objects.set_thumbnail(scope, info.key, WEBP, variant)
        copied = self.app.objects.link_copy(info.bucket_id, info.key, self.scope, "copy.txt")
        await self.app.objects.set_thumbnail(scope, copied.key, WEBP + b"different", "thumb")
        versions = self.app.objects.file_thumbnail_versions([info, copied])
        data, _, _ = await self.app.objects.get_thumbnail_by_etag(self.scope, copied.etag,
            version=versions[(copied.bucket_id, copied.key)]["thumb"])
        self.assertEqual(data, WEBP + b"different")
        self.assertEqual((await self.app.objects.read_thumbnail(info))[0], WEBP)
        self.assertEqual(set(versions[(info.bucket_id, info.key)]), {"thumb", "grid", "poster"})

    async def test_public_metadata_assets_follow_password_and_revocation(self):
        client = Client(self.app)
        auth = await client.login("user", "alice@example.com", "alice password")
        info = await self.put()
        await self.editor.info(self.scope, info.key)
        await self.wait(await self.start(self.scope, info.key, {"etag": info.etag, "fields": {"lyrics": LYRICS}}))
        payload = json.dumps({"paths": [info.key], "public": True, "password": "share secret"}).encode()
        status, _, data = await client.request("POST", "/api/user/v1/public", payload, auth)
        self.assertEqual(status, 200, data)
        token = json.loads(data)["objects"][0]["public_token"]
        base = "/api/public/v1/objects/" + token
        self.assertEqual((await client.request("GET", base + "/preview-assets"))[0], 403)
        status, _, data = await client.request("POST", base + "/unlock", json.dumps({"password": "share secret"}).encode())
        self.assertEqual(status, 200, data)
        access = json.loads(data)["access"]
        status, _, data = await client.request("GET", base + "/preview-assets?access=" + access)
        self.assertEqual(status, 200, data)
        asset = json.loads(data)["assets"][0]
        route = base + "/asset?access=" + access + "&id=" + asset["id"]
        status, _, data = await client.request("GET", route)
        self.assertEqual(status, 200, data)
        self.assertIn("第一句", data.decode())
        other = await self.put("other.mp3")
        await self.editor.info(self.scope, other.key)
        await self.wait(await self.start(self.scope, other.key, {"etag": other.etag, "fields": {"lyrics": LYRICS}}))
        foreign = self.store.assets(other.metadata_id, "lyrics")[0]
        self.assertEqual((await client.request("GET", base + "/asset?access=" + access + "&id=" + foreign["id"]))[0], 404)
        await client.request("POST", "/api/user/v1/public", json.dumps({"paths": [info.key], "public": False}).encode(), auth)
        self.assertEqual((await client.request("GET", route))[0], 404)

    async def test_library_search_and_album_group_use_manual_fields(self):
        from urllib.parse import quote
        info = await self.put()
        await self.editor.info(self.scope, info.key)
        await self.wait(await self.start(self.scope, info.key, {"etag": info.etag, "fields": {"title": "编辑歌名", "album": "编辑专辑", "artist": "编辑歌手"}}))
        client = Client(self.app)
        auth = await client.login("user", "alice@example.com", "alice password")
        status, _, data = await client.request("GET", "/api/user/v1/library?view=music&q=" + quote("编辑歌名"), headers=auth)
        self.assertEqual(status, 200, data)
        self.assertEqual(len(json.loads(data)["objects"]), 1)
        status, _, data = await client.request("GET", "/api/user/v1/library/albums", headers=auth)
        self.assertEqual(status, 200, data)
        self.assertEqual((json.loads(data)["albums"][0]["album"], json.loads(data)["albums"][0]["artist"]), ("编辑专辑", "编辑歌手"))
        await self.wait(await self.start(self.scope, info.key, {"etag": info.etag, "fields": {"album": "", "artist": ""}}))
        status, _, data = await client.request("GET", "/api/user/v1/library/albums", headers=auth)
        self.assertEqual(json.loads(data)["albums"][0]["album"], "")

    async def test_edit_keeps_chinese_in_legacy_mp3_tags(self):
        path = self.sample("mp3")
        data = path.read_bytes()
        size = sum((value & 127) << shift for value, shift in zip(data[6:10], (21, 14, 7, 0)))
        frames = b""
        for name, text in ((b"TIT2", "原歌曲"), (b"TPE1", "原歌手"), (b"TALB", "原专辑")):
            body = b"\x00" + text.encode("gb18030")
            frames += name + struct.pack(">I", len(body)) + b"\x00\x00" + body
        header = b"ID3\x03\x00\x00" + bytes((len(frames) >> shift) & 127 for shift in (21, 14, 7, 0))
        path.write_bytes(header + frames + data[10 + size:])
        info = await self.app.objects.put_object(self.scope, path.name, path.read_bytes(), content_type="audio/mpeg")
        original = await self.editor.info(self.scope, path.name)
        self.assertEqual(original["fields"]["artist"], "原歌手")
        result = await self.wait(await self.start(self.scope, path.name, {"etag": info.etag, "fields": {"title": "改后的歌曲"}}))
        self.assertEqual(result["state"], "done", result)
        latest = await self.editor.info(self.scope, path.name)
        self.assertEqual(latest["fields"]["title"], "改后的歌曲")
        self.assertEqual(latest["fields"]["artist"], "原歌手")
        self.assertEqual(latest["fields"]["album"], "原专辑")

    async def test_edit_keeps_chinese_in_legacy_flac_tags(self):
        path = self.sample("flac")
        data, position, blocks = path.read_bytes(), 4, []
        while True:
            kind = data[position]
            length = int.from_bytes(data[position + 1:position + 4], "big")
            body = data[position + 4:position + 4 + length]
            position += 4 + length
            if kind & 127 == 4:
                vendor_size = int.from_bytes(body[:4], "little")
                offset = 4 + vendor_size
                count = int.from_bytes(body[offset:offset + 4], "little")
                prefix, offset, entries = body[:offset], offset + 4, []
                for _ in range(count):
                    size = int.from_bytes(body[offset:offset + 4], "little")
                    item = body[offset + 4:offset + 4 + size]
                    if item.partition(b"=")[0].lower() == b"artist":
                        item = b"artist=" + "原歌手".encode("gb18030")
                    entries.append(item); offset += 4 + size
                body = prefix + struct.pack("<I", count) + b"".join(struct.pack("<I", len(item)) + item for item in entries)
            blocks.append(bytes([kind]) + len(body).to_bytes(3, "big") + body)
            if kind & 128:
                break
        path.write_bytes(b"fLaC" + b"".join(blocks) + data[position:])
        info = await self.app.objects.put_object(self.scope, path.name, path.read_bytes(), content_type="audio/flac")
        original = await self.editor.info(self.scope, path.name)
        self.assertEqual(original["fields"]["artist"], "原歌手")
        result = await self.wait(await self.start(self.scope, path.name, {"etag": info.etag, "fields": {"title": "中文歌名"}}))
        self.assertEqual(result["state"], "done", result)
        latest = await self.editor.info(self.scope, path.name)
        self.assertEqual((latest["fields"]["title"], latest["fields"]["artist"]), ("中文歌名", "原歌手"))
