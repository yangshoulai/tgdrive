"""文件元信息与按封面整理：解析、未知状态、分页、权限以及查询后移入回收站。"""

import json
from unittest import mock

from tests.test_assistant import AssistantCase, answer, call
from tests.test_assistant_actions import ActionHelpers
from tests.test_media_tags import id3, mpeg_frames
from tgdrive.assistant.tools import ToolContext, ToolError, get_file_info, list_folder, search_files
from tgdrive.errors import NotFoundError
from tgdrive.objects import PRIVATE_PREFIX, Scope

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def song():
    return id3([("TIT2", b"\x03" + "晴天".encode()), ("TPE1", b"\x03" + "周杰伦".encode()),
                ("TALB", b"\x03" + "叶惠美".encode()), ("USLT", b"\x03chi\x00" + "歌词".encode()),
                ("APIC", b"\x03image/png\x00\x03\x00" + PNG)]) + mpeg_frames(20)


class FileInfoTests(AssistantCase):
    def tearDown(self):
        self.app.thumbnails.cache.close()
        super().tearDown()

    def context(self, root="", **extra):
        return ToolContext(self.alice.id, self.alice.bucket_id, root, self.app.objects, None, "files", root,
                           {}, {}, media=self.app.media, read_only=True, **extra)

    def test_media_tags_embedded_cover_and_sidecar_references(self):
        async def run():
            await self.put("音乐/晴天.mp3", song())
            await self.put("音乐/晴天.lrc", b"[00:01.00]lyrics")
            await self.put("音乐/晴天.zh.srt", b"subtitle")
            await self.put("音乐/晴天.other-song.srt", b"unrelated")
            taint = mock.Mock()
            with mock.patch.object(self.app.media.http, "request", new_callable=mock.AsyncMock) as request:
                info = (await get_file_info(self.context(taint=taint), {"path": "/音乐/晴天.mp3"})).result
            self.assertEqual((info["name"], info["file_kind"], info["has_cover"]), ("晴天.mp3", "audio", False))
            media = info["media"]
            self.assertEqual((media["status"], media["title"], media["artist"], media["album"]),
                             ("ready", "晴天", "周杰伦", "叶惠美"))
            self.assertGreater(media["duration"], 0)
            self.assertTrue(media["embedded_cover"])
            self.assertEqual(media["embedded_lyrics"], {"present": True, "synced": False})
            self.assertEqual([item["path"] for item in media["lyrics_files"]], ["/音乐/晴天.lrc"])
            self.assertEqual([item["path"] for item in media["subtitle_files"]], ["/音乐/晴天.zh.srt"])
            self.assertNotIn("text", media["embedded_lyrics"])
            request.assert_not_called()
            taint.assert_called_once_with("读取过文件元数据")
        self.run_async(run())

    async def photos(self):
        for name in ("a", "b", "c", "d"):
            await self.put(f"照片/{name}.jpg", name.encode())
        scope = Scope(self.alice.bucket_id)
        await self.app.objects.set_thumbnail(scope, "照片/a.jpg", PNG, "grid")
        await self.app.objects.set_thumbnail(scope, "照片/b.jpg", None, "none")
        self.app.objects.set_media_size(scope, "照片/a.jpg", self.app.objects.head_object(scope, "照片/a.jpg").etag, 320, 240)

    def test_cover_filters_page_without_reading_contents(self):
        async def run():
            await self.photos()
            ctx = self.context("照片/")
            with mock.patch.object(self.app.engine, "stream", side_effect=AssertionError("索引查询不应读取内容")):
                detail = (await get_file_info(ctx, {"path": "a.jpg", "include_media": False})).result
                self.assertTrue(detail["has_cover"], "只有网格图也算真实封面")
                self.assertFalse(detail["has_thumbnail"])
                self.assertEqual(detail["dimensions"], {"width": 320, "height": 240})
                self.assertEqual(detail["media"]["status"], "not_requested")
                first = (await search_files(ctx, {"kind": "image", "has_cover": False, "limit": 1})).result
                second = (await search_files(ctx, {"has_cover": False, "limit": 1, "cursor": first["next_cursor"]})).result
                third = (await search_files(ctx, {"has_cover": False, "limit": 1, "cursor": second["next_cursor"]})).result
                self.assertEqual([page["files"][0]["name"] for page in (first, second, third)], ["b.jpg", "c.jpg", "d.jpg"])
                self.assertIsNone(third["next_cursor"])
                self.assertEqual(first["files"][0]["thumbnail_status"], "unavailable")
                first = (await list_folder(ctx, {"has_cover": False, "limit": 2})).result
                second = (await list_folder(ctx, {"has_cover": False, "limit": 2, "cursor": first["next_cursor"]})).result
                self.assertEqual([item["name"] for page in (first, second) for item in page["files"]], ["b.jpg", "c.jpg", "d.jpg"])
                present = (await search_files(ctx, {"has_cover": True})).result
                self.assertEqual([item["name"] for item in present["files"]], ["a.jpg"])
        self.run_async(run())

    def test_legacy_cover_counts_and_none_does_not(self):
        async def run():
            await self.photos()
            blob = self.app.objects.head_object(Scope(self.alice.bucket_id), "照片/c.jpg").blob_uuid
            with self.app.metadata.transaction() as db:
                db.execute("INSERT INTO thumbnail_legacy(blob_uuid,data) VALUES(?,?)", (blob, PNG))
            found = (await search_files(self.context("照片/"), {"has_cover": True})).result["files"]
            self.assertEqual([item["name"] for item in found], ["a.jpg", "c.jpg"])
        self.run_async(run())

    def test_scope_and_private_area_are_preserved(self):
        async def run():
            await self.put("许可/a.jpg", b"a")
            await self.put("别处/b.jpg", b"b")
            await self.put(PRIVATE_PREFIX + "音乐/晴天.mp3", song())
            bob = self.app.accounts.create_user("bob@example.com", "bob password")
            await self.app.objects.put_object(Scope(bob.bucket_id), "许可/bob.jpg", PNG)
            ctx = self.context("许可/")
            found = (await search_files(ctx, {"has_cover": False})).result["files"]
            self.assertEqual([item["path"] for item in found], ["/许可/a.jpg"])
            with self.assertRaises(ToolError):
                await get_file_info(ctx, {"path": "/别处/b.jpg"})
            with self.assertRaises(ToolError):
                await search_files(ctx, {"path": "/.tgdrive/private/", "has_cover": False})
            ctx = self.context(PRIVATE_PREFIX, base=PRIVATE_PREFIX, authorize=lambda: None)
            found = (await search_files(ctx, {"has_cover": False})).result["files"]
            self.assertEqual([item["path"] for item in found], ["私密:/音乐/晴天.mp3"])
            info = (await get_file_info(ctx, {"path": "/音乐/晴天.mp3"})).result
            self.assertEqual(info["media"]["artist"], "周杰伦")
            self.assertNotIn(".tgdrive", json.dumps(info, ensure_ascii=False))
        self.run_async(run())

    def test_failed_unsupported_and_disabled_embedded_metadata_stay_unknown(self):
        async def run():
            await self.put("song.mp3", song())
            ctx = self.context()
            for response, status in ((OSError("temporary"), "unavailable"), ({"container": None}, "unsupported"),
                                     ({"container": "mp3", "embedded": False}, "ready")):
                options = {"side_effect": response} if isinstance(response, Exception) else {"return_value": response}
                with mock.patch.object(self.app.media, "info", new=mock.AsyncMock(**options)):
                    info = (await get_file_info(ctx, {"path": "song.mp3"})).result
                self.assertEqual(info["media"]["status"], status)
                self.assertIsNone(info["media"]["embedded_cover"])
                self.assertIsNone(info["media"]["embedded_lyrics"])
            for tool, args in ((search_files, {"has_cover": "false"}), (list_folder, {"has_cover": 0}),
                               (get_file_info, {"path": "song.mp3", "include_media": "false"})):
                with self.assertRaises(ToolError):
                    await tool(ctx, args)
        self.run_async(run())

    def test_version_and_authorization_rechecked_after_media_read(self):
        async def run():
            key = PRIVATE_PREFIX + "song.mp3"
            await self.put(key, song())
            allowed = True

            def authorize():
                if not allowed:
                    raise PermissionError("已锁定")

            ctx = self.context(PRIVATE_PREFIX, base=PRIVATE_PREFIX, authorize=authorize)
            original = self.app.media.info

            async def revoke(*args):
                nonlocal allowed
                info = await original(*args)
                allowed = False
                return info

            with mock.patch.object(self.app.media, "info", side_effect=revoke):
                with self.assertRaises(PermissionError):
                    await get_file_info(ctx, {"path": "/song.mp3"})
            allowed = True

            async def replace(*args):
                info = await original(*args)
                await self.put(key, id3([("TIT2", b"\x03changed")]) + mpeg_frames(10))
                return info

            with mock.patch.object(self.app.media, "info", side_effect=replace):
                with self.assertRaisesRegex(ToolError, "文件内容已变化"):
                    await get_file_info(ctx, {"path": "/song.mp3"})
        self.run_async(run())


class FileInfoFlowTests(ActionHelpers, AssistantCase):
    def tearDown(self):
        self.app.thumbnails.cache.close()
        super().tearDown()

    def test_find_without_cover_then_confirm_trash(self):
        async def run():
            await self.setup_assistant()
            for name in ("covered", "missing", "failed"):
                await self.put(f"照片/{name}.jpg", name.encode())
            scope = Scope(self.alice.bucket_id)
            await self.app.objects.set_thumbnail(scope, "照片/covered.jpg", PNG, "thumb")
            await self.app.objects.set_thumbnail(scope, "照片/failed.jpg", None, "none")
            user = await self.client.login("user", "alice@example.com", "alice password")
            conversation = await self.start_conversation(user, "照片/")
            self.model.replies = [call("search_files", kind="image", has_cover=False),
                                  call("get_file_info", path="/照片/missing.jpg", include_media=False),
                                  call("propose_trash", paths=["/照片/failed.jpg", "/照片/missing.jpg"]), answer("等待确认。")]
            status, _ = await self.send(user, conversation, "删除这个文件夹里没有封面的图片")
            self.assertEqual(status, 201)
            tools = await self.tool_results(user, conversation)
            self.assertTrue(all(item["status"] == "ok" for item in tools), tools)
            self.assertEqual([item["name"] for item in tools[0]["result"]["files"]], ["failed.jpg", "missing.jpg"])
            self.assertFalse(tools[1]["result"]["has_cover"])
            action_id = tools[2]["result"]["action_id"]
            self.assertIsNotNone(self.app.objects.head_object(scope, "照片/missing.jpg"))
            status, done = await self.confirm(user, action_id)
            self.assertEqual((status, done["status"], done["result"]["ok"]), (200, "done", 2))
            for name in ("missing", "failed"):
                with self.assertRaises(NotFoundError):
                    self.app.objects.head_object(scope, f"照片/{name}.jpg")
            self.assertIsNotNone(self.app.objects.head_object(scope, "照片/covered.jpg"))
        self.run_async(run())
