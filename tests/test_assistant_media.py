"""文件助手的在线获取封面、歌词与字幕（docs/assistant-design.md §40）：候选冻结、优先级、已有数据的覆盖确认与执行。
第三方接口用替身，不连接真实网络。"""

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.assistant.actions import Progress, media_choices
from tgdrive.assistant.media_tools import best_index, last_time, propose_media_assets
from tgdrive.assistant.tools import ToolContext, ToolError
from tgdrive.objects import Scope
from tgdrive.media.providers.base import Fetched
from tests.test_media_service import FakeHttp, song
from tests.test_assistant import AssistantCase, call
from tests.test_assistant_actions import ActionHelpers
from tests.test_media_tags import id3, mpeg_frames

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


class PriorityTests(unittest.TestCase):
    def test_lyrics_prefer_duration_then_synced_then_embedded(self):
        candidates = [
            {"provider": "embedded", "synced": True, "score": 0.9},
            {"provider": "lrclib", "synced": True, "score": 0.6, "duration": 200},
            {"provider": "netease", "synced": False, "score": 0.95, "duration": 250},
            {"provider": "qqmusic", "synced": True, "score": 0.7, "duration": 269.5},
        ]
        self.assertEqual(best_index("lyrics", candidates, 269), 3)
        # 没有时长一致的：能滚动的优先，同样能滚动时内置优先。
        self.assertEqual(best_index("lyrics", candidates[:3], 269), 0)
        self.assertEqual(best_index("lyrics", candidates[1:3], 269), 0)
        # 匹配分太低的在线结果不自动选择。
        self.assertIsNone(best_index("lyrics", [{"provider": "lrclib", "synced": True, "score": 0.2}], 269))

    def test_cover_prefers_embedded_and_subtitle_prefers_hash(self):
        covers = [{"provider": "itunes", "score": 0.95}, {"provider": "embedded", "score": 0.0}]
        self.assertEqual(best_index("cover", covers, None), 1)
        subtitles = [{"provider": "assrt", "score": 0.9}, {"provider": "opensubtitles", "score": 0.5, "hash_match": True}]
        self.assertEqual(best_index("subtitle", subtitles, None), 1)

    def test_last_time_and_choices(self):
        self.assertEqual(last_time("[00:01.00]a\n[03:05.50]b"), 185.5)
        self.assertIsNone(last_time("没有时间标签"))
        payload = {"items": [{"candidates": [{}, {}], "best": 1, "choice": None}, {"candidates": [{}], "best": 0, "choice": 0}]}
        self.assertEqual(media_choices(payload, None), [None, 0])
        self.assertEqual(media_choices({**payload, "auto": True}, None), [1, 0])
        self.assertEqual(media_choices(payload, {"choices": {"0": 0, "1": None}}), [0, None])
        for bad in ({"0": 2}, {"0": True}, {"1": "0"}):
            with self.assertRaises(ValueError):
                media_choices(payload, {"choices": bad})


class MediaToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.alice.bucket_id)
        self.http = FakeHttp()
        self.app.media.http = self.http
        self.app.media.resources = None  # 没有 FFmpeg：封面直接使用来源的小图与原图
        self.http.add("https://lrclib.net/api/search", (200, [
            {"id": 7, "trackName": "晴天", "artistName": "周杰伦", "duration": 269.0,
             "syncedLyrics": "[00:29.00]故事的小黄花\n[00:32.00]从出生那年就飘着", "plainLyrics": "故事的小黄花"}]))
        self.http.add("https://itunes.apple.com/search", (200, {"results": [
            {"trackName": "晴天", "artistName": "周杰伦", "collectionName": "叶惠美",
             "artworkUrl100": "https://is1.mzstatic.com/image/thumb/a/100x100bb.jpg", "trackTimeMillis": 269000}]}))
        self.http.add("https://is1.mzstatic.com/image/thumb/a/240x240bb.jpg", (200, PNG))
        self.http.add("https://is1.mzstatic.com/image/thumb/a/1200x1200bb.jpg", (200, PNG + b"\x00" * 32))
        self.proposed: list[dict] = []

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def wait(self, coroutine):
        return asyncio.run(coroutine)

    def put(self, key, data, content_type="audio/mpeg"):
        return self.wait(self.app.objects.put_object(self.scope, key, data, len(data), content_type))

    def context(self):
        async def propose(kind, payload, count):
            self.proposed.append(payload)
            return {"action_id": f"a_{len(self.proposed)}", "expires_at": time.time() + 3600}
        return ToolContext(self.alice.id, self.alice.bucket_id, "", self.app.objects, None, "files", "", {}, {},
                           limits={"action_items": 1000}, propose=propose, media=self.app.media)

    def run_tool(self, args):
        return self.wait(propose_media_assets(self.context(), args))

    def execute(self, payload, confirm=None):
        progress = Progress(total=len(payload["items"]))
        self.wait(self.app.assistant.executor.execute(user_id=self.alice.id, bucket_id=self.alice.bucket_id, payload=payload,
                                                      progress=progress, confirm=confirm))
        return progress

    def test_embedded_synced_lyrics_are_kept_and_cover_saved_without_ffmpeg(self):
        self.put("音乐/晴天.mp3", song())
        output = self.run_tool({"paths": ["/音乐/"]})
        payload = self.proposed[-1]
        self.assertEqual([item["want"] for item in payload["items"]], ["cover"])
        self.assertTrue(any("播放器会直接使用" in entry["reason"] for entry in payload["skipped"]))
        cover = payload["items"][0]
        self.assertIsNone(cover["exists"])
        self.assertEqual(cover["candidates"][cover["choice"]]["provider"], "itunes")
        # 来源引用只在服务端：不在条目、样例或模型结果里。
        self.assertNotIn("ref", cover["candidates"][0])
        self.assertIn("_refs", payload)
        self.assertNotIn("mzstatic", str(output.result))
        progress = self.execute(payload)
        self.assertEqual((progress.ok, progress.failed), (1, 0), progress.failures)
        info = self.app.objects.head_object(self.scope, "音乐/晴天.mp3")
        variants = set(self.app.objects.file_thumbnail_versions([info])[(info.bucket_id, info.key)])
        self.assertTrue({"thumb", "grid", "poster"} <= variants)

    def test_existing_lyrics_need_choice_unless_auto(self):
        self.put("音乐/晴天.mp3", id3([("TIT2", b"\x03\xe6\x99\xb4\xe5\xa4\xa9")]) + mpeg_frames(20))
        self.put("音乐/晴天.lrc", b"[00:01.00]sidecar", "text/plain")
        self.wait(self.app.media._write_asset(self.scope, "音乐/晴天.mp3", "lyrics", "test", Fetched(text="[00:01.00]old", format="lrc")))
        self.run_tool({"paths": ["/音乐/晴天.mp3"], "want": ["lyrics"]})
        payload = self.proposed[-1]
        item = payload["items"][0]
        self.assertEqual((item["exists"], item["choice"], item["target"]), ("已有歌词元数据", None, "歌词元数据"))
        progress = self.execute(payload)
        self.assertEqual((progress.ok, progress.skipped), (0, 1))
        self.assertEqual(progress.failures[0]["reason"], "保留现有")
        progress = self.execute(payload, {"choices": {"0": item["best"]}})
        self.assertEqual(progress.ok, 1, progress.failures)
        info = self.app.objects.head_object(self.scope, "音乐/晴天.mp3")
        asset = self.app.objects.file_metadata.assets(info.metadata_id, "lyrics")[0]
        self.assertIn("故事的小黄花", self.wait(self.app.objects.file_metadata.read_asset(self.scope, info.key, asset["id"]))[0].decode())
        _, stream = self.wait(self.app.objects.get_object(self.scope, "音乐/晴天.lrc"))
        self.assertEqual(b"".join(self.wait(self._collect(stream))), b"[00:01.00]sidecar")
        # 完全访问：直接覆盖。
        self.put("音乐/晴天.lrc", b"[00:01.00]old", "text/plain")
        self.run_tool({"paths": ["/音乐/晴天.mp3"], "want": ["lyrics"]})
        self.assertEqual(self.execute({**self.proposed[-1], "auto": True}).ok, 1)

    async def _collect(self, stream):
        return [chunk async for chunk in stream]

    def test_force_online_replaces_embedded_and_changed_files_are_skipped(self):
        self.put("音乐/晴天.mp3", song())
        self.run_tool({"paths": ["/音乐/晴天.mp3"], "want": ["lyrics"], "force_online": True})
        payload = self.proposed[-1]
        item = payload["items"][0]
        self.assertEqual(item["exists"], "文件内置能滚动的歌词")
        self.assertEqual([candidate["provider"] for candidate in item["candidates"]], ["lrclib"])
        self.assertEqual(item["choice"], 0)
        self.put("音乐/晴天.mp3", song(title="晴天（新版）"))
        progress = self.execute(payload)
        self.assertEqual((progress.ok, progress.skipped), (0, 1))
        self.assertEqual(progress.failures[0]["reason"], "源文件已被修改")

    def test_rejects_non_media_and_too_many_files(self):
        self.put("文档/a.txt", b"hello", "text/plain")
        with self.assertRaises(ToolError):
            self.run_tool({"paths": ["/文档/a.txt"]})
        for index in range(11):
            self.put(f"专辑/{index:02d}.mp3", mpeg_frames(5))
        with self.assertRaisesRegex(ToolError, "最多处理 10 个"):
            self.run_tool({"paths": ["/专辑/"]})
        with self.assertRaisesRegex(ToolError, "单个文件"):
            self.run_tool({"paths": ["/专辑/00.mp3", "/专辑/01.mp3"], "title": "x"})


class MediaActionFlowTests(ActionHelpers, AssistantCase):
    """经对话生成操作、卡片读取候选图片与全文、带选择确认。"""

    def test_card_reads_candidates_and_confirms_choices(self):
        async def run():
            await self.setup_assistant()
            http = FakeHttp()
            self.app.media.http = http
            http.add("https://lrclib.net/api/search", (200, [
                {"id": 7, "trackName": "晴天", "artistName": "周杰伦", "duration": 269.0,
                 "syncedLyrics": "[00:29.00]故事的小黄花", "plainLyrics": "故事的小黄花"}]))
            data = id3([("TIT2", b"\x03\xe6\x99\xb4\xe5\xa4\xa9")]) + mpeg_frames(20)
            await self.app.objects.put_object(Scope(self.alice.bucket_id), "音乐/晴天.mp3", data, len(data), "audio/mpeg")
            await self.app.objects.put_object(Scope(self.alice.bucket_id), "音乐/晴天.lrc", b"[00:01.00]old", 13, "text/plain")
            user = await self.client.login("user", "alice@example.com", "alice password")
            conversation = await self.start_conversation(user, "音乐/")
            action_id, tool = await self.propose(user, conversation, call("propose_media_assets", paths=["/音乐/晴天.mp3"], want=["lyrics"]))
            self.assertNotIn("_refs", json.dumps(tool["result"], ensure_ascii=False))
            _, detail = await self.req("GET", f"/api/user/v1/assistant/actions/{action_id}", headers=user)
            self.assertNotIn("_refs", detail["payload"])
            self.assertEqual(detail["payload"]["samples"][0]["choice"], 0, "同目录文件不再视为已有歌词元数据")
            status, _, text = await self.client.request("GET", f"/api/user/v1/assistant/actions/{action_id}/media/0/0", b"", user)
            self.assertEqual(status, 200)
            self.assertIn("故事的小黄花", text.decode())
            status, _, _ = await self.client.request("GET", f"/api/user/v1/assistant/actions/{action_id}/media/0/9", b"", user)
            self.assertEqual(status, 404)
            status, _ = await self.confirm(user, action_id, {"choices": {"0": 5}}, wait=False)
            self.assertEqual(status, 400)
            status, done = await self.confirm(user, action_id, {"choices": {"0": 0}})
            self.assertEqual((status, done["status"], done["result"]["ok"]), (200, "done", 1))
            scope = Scope(self.alice.bucket_id)
            info = self.app.objects.head_object(scope, "音乐/晴天.mp3")
            asset = self.app.objects.file_metadata.assets(info.metadata_id, "lyrics")[0]
            self.assertIn("故事的小黄花", (await self.app.objects.file_metadata.read_asset(scope, info.key, asset["id"]))[0].decode())
        self.run_async(run())


if __name__ == "__main__":
    unittest.main()
