"""离线任务附带的缩略图（封面）与记住的保存位置。下载来源与图片处理均为替身，不访问网络或 FFmpeg。"""

import asyncio
import base64
import json
import tempfile
import unittest
from unittest.mock import AsyncMock

from tgdrive.app import create_app
from tgdrive.assistant.actions import ActionExecutor
from tgdrive.objects import PRIVATE_PREFIX, Scope
from tgdrive.offline.service import COVER_PREFIX
from tests.test_offline import MemoryHttp
from tests.test_public_links import Client

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
WEBP = b"RIFF\x1a\x00\x00\x00WEBPVP8 " + b"\x00" * 14


def encoded(**images):
    return {variant: base64.b64encode(data).decode() for variant, data in images.items()}


class OfflineCoverTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(self.temp.name, secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.offline = self.app.offline
        self.offline.http = MemoryHttp()
        self.scope = Scope(self.alice.bucket_id)

    async def asyncTearDown(self):
        await self.offline.stop()
        await asyncio.gather(*self.offline._covers, return_exceptions=True)
        self.app.metadata.close()
        self.temp.cleanup()

    async def make(self, name="clip.bin", destination="downloads/", cover=None, private_scope=None):
        parsed = await self.offline.parse(self.alice.id, f"https://example.com/{name}")
        item = {"ticket": parsed["candidates"][0]["ticket"], "name": name, **({"cover": cover} if cover else {})}
        return self.offline.create(self.alice.id, [item], destination, private_scope=private_scope)[0]

    async def finish(self, task_id):
        self.offline.start()
        async with asyncio.timeout(15):
            while self.offline._row(task_id)["status"] != "completed" or self.offline._covers:
                await asyncio.sleep(0.01)

    def thumbnails(self, key, scope=None):
        info = self.app.objects.head_object(scope or self.scope, key)
        return {row["variant"] for row in self.app.metadata.db.execute(
            "SELECT variant FROM thumbnails WHERE blob_uuid=?", (info.blob_uuid,))}

    def staged(self, task_id):
        prefix = f"{COVER_PREFIX}{task_id}/"
        return [row["key"] for row in self.app.metadata.db.execute(
            "SELECT key FROM objects WHERE bucket_id=? AND key>=? AND key<?", (self.alice.bucket_id, prefix, prefix + "\U0010ffff"))]

    async def test_staged_cover_becomes_thumbnail_after_download(self):
        task = await self.make()
        result = await self.offline.set_cover(self.alice.id, task["id"], encoded(thumb=JPEG, grid=WEBP))
        self.assertEqual(result, {"applied": False})
        self.assertEqual(len(self.staged(task["id"])), 2)
        await self.finish(task["id"])
        self.assertEqual(self.thumbnails("downloads/clip.bin"), {"thumb", "grid"})
        self.assertEqual(self.staged(task["id"]), [], "暂存的封面在使用后删除")

    async def test_cover_for_completed_task_applies_immediately(self):
        task = await self.make()
        await self.finish(task["id"])
        self.assertEqual(await self.offline.set_cover(self.alice.id, task["id"], encoded(thumb=JPEG)), {"applied": True})
        self.assertEqual(self.thumbnails("downloads/clip.bin"), {"thumb"})
        self.assertEqual(self.staged(task["id"]), [])

    async def test_image_url_cover_is_fetched_and_resized_on_completion(self):
        service = self.app.objects.thumbnail_service
        service.fetch_image = AsyncMock(return_value=(JPEG, "image/jpeg"))
        service.render_image = AsyncMock(return_value={"thumb": JPEG, "poster": JPEG})
        task = await self.make(cover={"url": "https://img.example.com/cover.jpg"})
        await self.finish(task["id"])
        service.fetch_image.assert_awaited_once_with("https://img.example.com/cover.jpg")
        self.assertEqual(self.thumbnails("downloads/clip.bin"), {"thumb", "poster"})
        self.assertNotIn("cover", self.offline._source(self.offline._row(task["id"])), "封面只使用一次")

    async def test_cover_failure_keeps_download_result(self):
        service = self.app.objects.thumbnail_service
        service.fetch_image = AsyncMock(side_effect=ValueError("图片地址无法访问（HTTP 404）"))
        task = await self.make(cover="https://img.example.com/missing.jpg")
        await self.finish(task["id"])
        self.assertEqual(self.offline._row(task["id"])["status"], "completed")
        self.assertEqual(self.thumbnails("downloads/clip.bin"), set())

    async def test_invalid_covers_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "图片地址"):
            await self.make(cover={"url": "file:///etc/passwd"})
        task = await self.make()
        for images in ({"grid": base64.b64encode(JPEG).decode()}, encoded(thumb=b"<svg/>"), encoded(thumb=JPEG + b"\x00" * 100 * 1024),
                       {"thumb": "not base64!"}, encoded(thumb=JPEG, extra=JPEG)):
            with self.subTest(images=list(images)), self.assertRaises(ValueError):
                await self.offline.set_cover(self.alice.id, task["id"], images)

    async def test_deleting_task_removes_staged_cover_and_private_requires_unlock(self):
        task = await self.make()
        await self.offline.set_cover(self.alice.id, task["id"], encoded(thumb=JPEG))
        await self.offline.control(self.alice.id, task["id"], "delete")
        self.assertEqual(self.staged(task["id"]), [])
        unlocked = Scope(self.alice.bucket_id, private_access=True)
        hidden = await self.make(destination=PRIVATE_PREFIX, private_scope=unlocked)
        with self.assertRaisesRegex(ValueError, "解锁"):
            await self.offline.set_cover(self.alice.id, hidden["id"], encoded(thumb=JPEG))
        await self.offline.set_cover(self.alice.id, hidden["id"], encoded(thumb=JPEG), private_scope=unlocked)
        await self.finish(hidden["id"])
        self.assertEqual(self.thumbnails(PRIVATE_PREFIX + "clip.bin", unlocked), {"thumb"})

    async def test_last_destination_is_remembered_per_area(self):
        self.assertEqual(self.offline.last_destination(self.alice.id), {"area": "normal", "normal": "", "private": None})
        await self.make(destination="videos/2026/")
        unlocked = Scope(self.alice.bucket_id, private_access=True)
        await self.make(destination=PRIVATE_PREFIX + "相册/", private_scope=unlocked)
        self.assertEqual(self.offline.last_destination(self.alice.id),
                         {"area": "private", "normal": "videos/2026/", "private": None}, "未解锁时不返回私密路径")
        self.assertEqual(self.offline.last_destination(self.alice.id, private_scope=unlocked)["private"], PRIVATE_PREFIX + "相册/")
        await self.make(destination="videos/")
        self.assertEqual(self.offline.last_destination(self.alice.id)["area"], "normal")

    async def test_web_routes(self):
        client = Client(self.app)
        headers = await client.login("user", "alice@example.com", "alice password")
        task = await self.make(destination="music/")
        status, _, body = await client.request("GET", "/api/user/v1/downloads/destination", headers=headers)
        self.assertEqual((status, json.loads(body)["normal"]), (200, "music/"))
        payload = json.dumps({"images": encoded(thumb=JPEG)}).encode()
        status, _, body = await client.request("POST", f"/api/user/v1/downloads/{task['id']}/cover", payload, headers)
        self.assertEqual((status, json.loads(body)), (200, {"applied": False}))
        status, _, _ = await client.request("POST", f"/api/user/v1/downloads/{task['id']}/cover", payload, {"cookie": headers["cookie"]})
        self.assertEqual(status, 403, "提交封面需要 CSRF")
        status, _, body = await client.request("GET", "/api/user/v1/private/downloads/destination", headers=headers)
        self.assertEqual(status, 423, "私密位置需要解锁")


class AssistantCoverTests(unittest.IsolatedAsyncioTestCase):
    async def test_executor_passes_cover_url_to_tasks(self):
        executor = ActionExecutor.__new__(ActionExecutor)
        executor.offline = type("Offline", (), {})()
        created = []
        executor.offline.direct_ticket = lambda user_id, url, **kwargs: "ticket"
        executor.offline.create = lambda user_id, items, destination, **kwargs: created.extend(items) or []
        progress = type("Progress", (), {"cancel": False, "ok": 0, "done": 0, "fail": lambda *args: None})()
        payload = {"options": {"target": "videos/"}, "items": [
            {"url": "https://example.com/a.mp4", "name": "a.mp4", "cover": "https://img.example.com/a.jpg"},
            {"url": "https://example.com/b.mp4", "name": "b.mp4"}]}
        await executor._downloads(1, "", payload, progress, None)
        self.assertEqual(created[0]["cover"], {"url": "https://img.example.com/a.jpg"})
        self.assertNotIn("cover", created[1])
