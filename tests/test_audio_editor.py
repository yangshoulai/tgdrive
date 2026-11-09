"""真实 FFmpeg 的标签写回回归，仅用临时文件、临时数据库和本地存储。"""

import asyncio
import base64
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tgdrive.app import create_app
from tgdrive.errors import VersionConflict
from tgdrive.objects import Scope
from tests.test_public_links import Client

FFMPEG = shutil.which("ffmpeg")
LYRICS = "[00:00.10]第一句 # = ; \\\n[00:00.20]Second line\n"


@unittest.skipUnless(FFMPEG, "需要 FFmpeg")
class AudioEditorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.app = create_app(self.folder / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("test encryption passphrase", "admin@example.com", "admin password")
        self.user = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.user.bucket_id)
        self.editor = self.app.media.editor

    async def asyncTearDown(self):
        await self.app.media.stop()
        await self.app.thumbnails.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    def sample(self, extension):
        path = self.folder / ("source." + extension)
        lyrics = ["-metadata", "UNSYNCEDLYRICS=旧歌词", "-metadata", "SYNCEDLYRICS=[00:00.10]旧同步歌词"] if extension == "flac" else []
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.4",
                        "-metadata", "artist=原歌手", "-metadata", "comment=keep me", *lyrics, str(path)], check=True)
        return path

    async def wait(self, job):
        await asyncio.wait_for(self.editor.jobs[job["id"]].task, timeout=20)
        return self.editor.status(self.scope, [job["id"]])[0]

    async def content(self, key):
        info = self.app.objects.head_object(self.scope, key)
        return b"".join([piece async for piece in self.app.objects.engine.stream(info.blob_uuid, bucket_id=self.scope.bucket_id)])

    def pcm(self, path):
        return subprocess.check_output([FFMPEG, "-v", "error", "-i", str(path), "-map", "0:a:0", "-f", "hash", "-hash", "sha256", "-"])

    async def test_three_formats_embed_tags_lyrics_and_cover_without_reencoding(self):
        cover = self.folder / "cover.png"
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", str(cover)], check=True)
        for extension in ("mp3", "flac", "m4a"):
            with self.subTest(extension=extension):
                path = self.sample(extension)
                info = await self.app.objects.put_object(self.scope, path.name, path.read_bytes(), content_type="audio/" + extension)
                job = await self.editor.start(self.scope, path.name, {"etag": info.etag,
                    "fields": {"title": "新歌名", "artist": "新歌手", "album": "新专辑", "lyrics": LYRICS},
                    "cover": base64.b64encode(cover.read_bytes()).decode()})
                result = await self.wait(job)
                self.assertEqual(result["state"], "done", result)
                latest = await self.editor.info(self.scope, path.name)
                self.assertEqual(latest["fields"]["title"], "新歌名")
                self.assertEqual(latest["fields"]["artist"], "新歌手")
                self.assertEqual(latest["fields"]["album"], "新专辑")
                self.assertEqual(latest["lyrics"], LYRICS.strip())
                self.assertTrue(latest["cover"])
                output = self.folder / ("saved." + extension)
                output.write_bytes(await self.content(path.name))
                self.assertEqual(self.pcm(path), self.pcm(output), "保存标签不能改变解码后的音频")
                dump = subprocess.check_output([FFMPEG, "-v", "error", "-i", str(output), "-f", "ffmetadata", "-"]).decode()
                self.assertIn("keep me", dump)
                self.assertIsNone(self.app.metadata.db.execute("SELECT 1 FROM objects WHERE key LIKE '%.lrc'").fetchone())
                unchanged = await self.wait(await self.editor.start(self.scope, path.name, {"etag": latest["etag"], "fields": {"title": "只改歌名"}}))
                self.assertEqual(unchanged["state"], "done", unchanged)
                latest = await self.editor.info(self.scope, path.name)
                self.assertEqual(latest["lyrics"], LYRICS.strip())
                self.assertTrue(latest["cover"])
                removed = await self.wait(await self.editor.start(self.scope, path.name, {"etag": latest["etag"], "fields": {"lyrics": ""}, "cover": "remove"}))
                self.assertEqual(removed["state"], "done", removed)
                latest = await self.editor.info(self.scope, path.name)
                self.assertFalse(latest["cover"])
                self.assertEqual(latest["lyrics"], "")

    async def test_version_conflict_and_cancel_keep_original(self):
        path = self.sample("flac")
        info = await self.app.objects.put_object(self.scope, path.name, path.read_bytes(), content_type="audio/flac")
        with self.assertRaises(VersionConflict):
            await self.editor.start(self.scope, path.name, {"etag": "stale", "fields": {"title": "wrong"}})
        await self.editor.slot.acquire()
        try:
            job = await self.editor.start(self.scope, path.name, {"etag": info.etag, "fields": {"title": "取消"}})
            await asyncio.sleep(0)
            self.editor.cancel(self.scope, job["id"])
            result = await self.wait(job)
            self.assertEqual(result["state"], "cancelled")
            self.assertEqual(self.app.objects.head_object(self.scope, path.name).etag, info.etag)
        finally:
            self.editor.slot.release()

    async def test_private_jobs_are_not_visible_through_normal_scope(self):
        path = self.sample("mp3")
        scope = Scope(self.user.bucket_id, ".tgdrive/private/", private_access=True)
        key = ".tgdrive/private/" + path.name
        info = await self.app.objects.put_object(scope, key, path.read_bytes(), content_type="audio/mpeg")
        await self.editor.slot.acquire()
        try:
            job = await self.editor.start(scope, key, {"etag": info.etag, "fields": {"title": "私密歌曲"}})
            with self.assertRaises(PermissionError):
                self.editor.status(self.scope, [job["id"]])
            self.editor.cancel(scope, job["id"])
        finally:
            self.editor.slot.release()

    async def test_http_edit_accepts_cover_and_requires_csrf_without_audit_content(self):
        client = Client(self.app)
        auth = await client.login("user", "alice@example.com", "alice password")
        path = self.sample("flac")
        info = await self.app.objects.put_object(self.scope, path.name, path.read_bytes(), content_type="audio/flac")
        cover = self.folder / "large.png"
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=800x800,noise=alls=100:allf=t", "-frames:v", "1", str(cover)], check=True)
        payload = json.dumps({"path": path.name, "etag": info.etag, "fields": {"title": "不要记录的歌名"}, "cover": base64.b64encode(cover.read_bytes()).decode()}).encode()
        self.assertGreater(len(payload), self.app.json_limit)
        status, _, _ = await client.request("POST", "/api/user/v1/media/edit", payload, {"cookie": auth["cookie"]})
        self.assertEqual(status, 403)
        status, headers, data = await client.request("POST", "/api/user/v1/media/edit", payload, auth)
        self.assertEqual(status, 202, data)
        self.assertEqual(headers["cache-control"], "no-store")
        job = await self.wait(json.loads(data))
        self.assertEqual(job["state"], "done", job)
        status, _, data = await client.request("GET", f"/api/user/v1/media/edit/jobs?ids={job['id']}", headers=auth)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["jobs"][0]["state"], "done")
        rows = self.app.metadata.db.execute("SELECT target,detail FROM audit_log WHERE action='media.edit'").fetchall()
        self.assertTrue(rows)
        self.assertNotIn("不要记录的歌名", str([tuple(row) for row in rows]))
        self.assertTrue(all(row["target"] is None for row in rows))

    async def test_cancel_after_commit_reports_saved_file(self):
        path = self.sample("flac")
        info = await self.app.objects.put_object(self.scope, path.name, path.read_bytes(), content_type="audio/flac")
        put = self.app.objects.put_object
        async def cancelled_after_commit(*args, **kwargs):
            await put(*args, **kwargs)
            raise asyncio.CancelledError()
        with patch.object(self.app.objects, "put_object", cancelled_after_commit):
            job = await self.wait(await self.editor.start(self.scope, path.name, {"etag": info.etag, "fields": {"title": "已提交"}}))
        self.assertEqual(job["state"], "done", job)
        self.assertEqual(job["result"]["key"], path.name)
