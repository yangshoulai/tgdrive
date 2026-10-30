"""离线下载的关键回归：命令隔离、授权、凭据加密与条件续传。"""

import asyncio
import json
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch
from contextlib import asynccontextmanager
from types import SimpleNamespace

from tgdrive.app import create_app
from tgdrive.assistant.tools import ToolContext, ToolError, describe_tools, tool_params, validate_tool_settings
from tgdrive.assistant.web_tools import parse_download_source
from tgdrive.errors import NotFoundError
from tgdrive.objects import PRIVATE_PREFIX, PRIVATE_TRASH_PREFIX, Scope
from tgdrive.offline.hls import parse_playlist
from tgdrive.offline.http import DownloadError, SafeHttpClient, public_ip
from tgdrive.offline.request import DownloadRequest, command_text, parse_requests
from tgdrive.offline.resources import ResourceSettings
from tgdrive.offline.service import OfflineDownloads
from tests.test_public_links import Client


class RequestTests(unittest.TestCase):
    def test_configurable_link_limit_keeps_default_and_supports_zero(self):
        links = [f"https://example.com/{index}.bin" for index in range(1001)]
        self.assertEqual(len(parse_requests("\n".join(links[:32]))), 32)
        with self.assertRaisesRegex(ValueError, "最多解析 32"):
            parse_requests("\n".join(links[:33]))
        self.assertEqual(len(parse_requests("\n".join(links[:1000]), max_urls=1000)), 1000)
        with self.assertRaisesRegex(ValueError, "最多解析 1000"):
            parse_requests("\n".join(links), max_urls=1000)
        self.assertEqual(len(parse_requests("\n".join(links), max_urls=0)), 1001)
        self.assertEqual(len(parse_requests("\n".join(f"curl '{url}'" for url in links[:33]), max_urls=33)), 33)
        for value in (-1, True, 1.5):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_requests(links[0], max_urls=value)

    def test_browser_curl_and_wget(self):
        request = parse_requests("curl 'https://example.com/f?x=1&y=2' " + "\\\n" + " -H 'Cookie: auth=private' -H 'Range: bytes=1-9' --compressed -L")[0]
        self.assertEqual(request.url, "https://example.com/f?x=1&y=2")
        self.assertIn(("Cookie", "auth=private"), request.headers)
        self.assertNotIn("range", [key.lower() for key, _ in request.headers])
        self.assertTrue(request.warnings)
        request = parse_requests("wget --header='Authorization: Bearer test' --post-data='a=b' -O 'file.zip' https://example.com/download")[0]
        self.assertEqual((request.method, request.body, request.name), ("POST", "a=b", "file.zip"))
        request = parse_requests("curl https://example.com/f --data-raw $'a=hello\\nworld'")[0]
        self.assertEqual(request.body, "a=hello\nworld")

    def test_command_text_round_trips(self):
        for text in ("https://example.com/a b".replace(" ", "%20"),
                     "curl 'https://example.com/f?sig=1' -H \"Cookie: a='quoted'\" -H 'Referer: https://example.com/' -o 'name.bin'",
                     "curl https://example.com/f --data-raw $'a=1\\nb=2'",
                     "curl https://example.com/f -X POST"):
            with self.subTest(text=text):
                original = parse_requests(text)[0]
                again = parse_requests(command_text(original))[0]
                self.assertEqual((again.url, again.method, again.headers, again.body, again.follow_redirects, again.name),
                                 (original.url, original.method, original.headers, original.body, original.follow_redirects, original.name))
        self.assertEqual(command_text(parse_requests("https://example.com/plain")[0]), "https://example.com/plain")

    def test_dangerous_or_unknown_arguments_rejected(self):
        for text in ("curl https://example.com/f; whoami", "curl $(whoami)", "curl \"https://example.com/$SECRET\"", "curl -k https://example.com/f", "curl --proxy http://secret https://example.com/f", "curl -d @/etc/passwd https://example.com/f", "wget --load-cookies cookies https://example.com/f", "curl https://example.com/f -H 'Host: localhost'", "magnet:?xt=x", "file:///etc/passwd"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_requests(text)
        request = parse_requests("curl https://example.com/f --data-raw '$(id); harmless'")[0]
        self.assertEqual(request.body, "$(id); harmless")

    def test_public_addresses_only(self):
        for value in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "224.0.0.1"):
            self.assertFalse(public_ip(value), value)
        self.assertTrue(public_ip("8.8.8.8"))

    def test_hls_limits(self):
        base = "https://example.com/video/index.m3u8"
        playlist = parse_playlist(b"#EXTM3U\n#EXTINF:2,\n1.ts\n#EXTINF:3,\n2.ts\n#EXT-X-ENDLIST\n", base)
        self.assertEqual(playlist.duration, 5)
        self.assertEqual(playlist.segments[0][0], "https://example.com/video/1.ts")
        for text in ("#EXTM3U\n#EXTINF:2,\n1.ts", "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key\"\n#EXTINF:2,\n1.ts\n#EXT-X-ENDLIST", "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2,\n1.ts", "#EXTM3U\n#EXT-X-GAP\n#EXTINF:2,\n1.ts\n#EXT-X-ENDLIST"):
            with self.assertRaises(ValueError):
                parse_playlist(text.encode(), base)


class ParseLimitTests(unittest.IsolatedAsyncioTestCase):
    """只使用解析与留痕替身，不创建数据库或连接来源站。"""

    def service(self):
        offline = OfflineDownloads.__new__(OfflineDownloads)
        offline.scope = Mock()
        offline._parse_slots = asyncio.Semaphore(2)
        candidate = lambda user_id, request, *args: [{"name": request.url.rsplit("/", 1)[-1], "ticket": "fixture"}]
        offline._parse_request = AsyncMock(side_effect=candidate)
        offline._parse_platform = AsyncMock(side_effect=candidate)
        return offline

    def test_tool_configuration_bounds_and_defaults(self):
        self.assertEqual(tool_params({}, "parse_download_source"), {"max_urls": 32})
        for limit in (0, 1000):
            settings = validate_tool_settings({"parse_download_source": {"max_urls": limit}}, {})
            spec = next(tool for tool in describe_tools(settings) if tool["name"] == "parse_download_source")
            param = spec["params"][0]
            self.assertEqual((param["default"], param["min"], param["max"], param["value"]), (32, 0, 1000, limit))
        for value in (-1, 1001, True, 1.5, "100"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_tool_settings({"parse_download_source": {"max_urls": value}}, {})

    async def test_web_and_key_parser_default_accepts_1000_links(self):
        offline = self.service()
        links = [f"https://example.com/{n}.bin" for n in range(1001)]
        result = await offline.parse(1, "\n".join(links[:1000]))
        self.assertEqual(len(result["candidates"]), 1000)
        rejected = self.service()
        with self.assertRaisesRegex(ValueError, "最多解析 1000"):
            await rejected.parse(1, "\n".join(links))
        rejected._parse_request.assert_not_awaited()

    async def test_one_source_can_return_more_than_32_candidates(self):
        offline = self.service()
        offline.http = Mock()
        offline._key = Mock(return_value=b"k" * 32)
        offline.resources = Mock()
        offline.resources.effective.return_value = {"hls_enabled": True, "hls_available": True}
        playlist = SimpleNamespace(variants=[(f"https://example.com/{n}.m3u8", str(n)) for n in range(40)], audio={})
        with patch("tgdrive.offline.service.load_playlist", AsyncMock(return_value=playlist)):
            request = DownloadRequest("https://example.com/index.m3u8", method="POST")
            result = await OfflineDownloads._parse_request(offline, 1, request, "hls")
            self.assertEqual(len(await OfflineDownloads._parse_request(offline, 1, request, "hls", 0)), 40)
            with self.assertRaisesRegex(ValueError, "解析结果超过 10"):
                await OfflineDownloads._parse_request(offline, 1, request, "hls", 10)
        self.assertEqual(len(result), 40, "候选数量由外层统一校验，不能再固定截在32项")

    async def test_parsing_error_cancels_other_source_requests(self):
        offline = self.service()
        started = asyncio.Event()
        active = 0
        cancelled = []

        async def inspect(user_id, request, *args):
            nonlocal active
            active += 1
            try:
                if request.url.endswith("0.bin"):
                    await started.wait()
                    raise ValueError("来源解析失败")
                started.set()
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.append(request.url)
                raise
            finally:
                active -= 1

        offline._parse_request.side_effect = inspect
        with self.assertRaisesRegex(ValueError, "来源解析失败"):
            await asyncio.wait_for(offline.parse(1, "\n".join(f"https://example.com/{n}.bin" for n in range(3))), 1)
        self.assertTrue(cancelled)
        self.assertEqual(active, 0, "返回错误前必须回收仍在运行的解析请求")

    async def test_tool_limit_reaches_parser_and_keeps_large_results(self):
        for limit, count in ((1000, 1000), (0, 1001)):
            with self.subTest(limit=limit):
                offline, trace = self.service(), Mock()
                trace.create_collection.return_value = "fixture-collection"
                ctx = ToolContext(1, 1, "", None, offline, "files", "", {"max_urls": limit}, {},
                                  conversation_id="fixture", trace=trace)
                text = "\n".join(f"https://example.com/{index}.bin" for index in range(count))
                self.assertGreater(len(text), 16384)
                result = await parse_download_source(ctx, {"text": text})
                self.assertEqual((result.items, len(result.result["candidates"])), (count, count))
                self.assertEqual(len({item["group"] for item in result.result["candidates"]}), count)
                self.assertEqual(trace.create_collection.call_args.kwargs["count"], count)
        ctx.params = {"max_urls": 1}
        with self.assertRaisesRegex(ToolError, "最多解析 1"):
            await parse_download_source(ctx, {"text": "https://example.com/a\nhttps://example.com/b"})

    async def test_candidate_limits_and_platform_defaults_remain_enforced(self):
        offline = self.service()
        offline._parse_request.side_effect = lambda *args: [{"name": "a"}, {"name": "b"}]
        text = "https://example.com/a\nhttps://example.com/b"
        with self.assertRaisesRegex(ValueError, "解析结果超过 3"):
            await offline.parse(1, text, max_urls=3)
        self.assertEqual(len((await offline.parse(1, text, max_urls=0))["candidates"]), 4)
        platforms = "https://x.com/u/status/123\nhttps://x.com/u/status/456"
        with self.assertRaisesRegex(ValueError, "每次解析一个"):
            await offline.parse(1, platforms)
        self.assertEqual(len((await offline.parse(1, platforms, max_urls=1000, multiple_platforms=True))["candidates"]), 2)


class MemoryResponse:
    def __init__(self, request, method, start, size, *, changed=False):
        self.url, self.method, self.start = request.url, method, start
        self.size, self.status = size - start, 206 if start else 200
        self.headers = {"etag": '"changed"' if changed else '"version-1"', "content-type": "application/octet-stream"}
        if start:
            self.headers["content-range"] = f"bytes {start}-{size - 1}/{size}"

    async def stream(self):
        remaining = self.size
        while remaining:
            await asyncio.sleep(0.001)
            piece = b"x" * min(65536, remaining)
            remaining -= len(piece)
            yield piece


class MemoryHttp:
    def __init__(self, size=1000):
        self.size, self.calls, self.changed = size, [], False

    @asynccontextmanager
    async def open(self, request, *, method=None, extra_headers=None, **kwargs):
        method = method or request.method
        extra = extra_headers or {}
        self.calls.append((method, dict(extra), request.url))
        start = int(extra.get("Range", "bytes=0-").split("=", 1)[1].split("-", 1)[0])
        yield MemoryResponse(request, method, start, self.size, changed=self.changed)


class TaskTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(self.temp.name, secure_cookies=False, run_scheduler=False)
        self.admin = self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.offline = self.app.offline
        self.offline.http = self.http = MemoryHttp()

    async def asyncTearDown(self):
        await self.offline.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    async def make(self, text="curl https://example.com/file.bin -H 'Cookie: secret=hidden' -L"):
        parsed = await self.offline.parse(self.alice.id, text)
        return self.offline.create(self.alice.id, [{"ticket": parsed["candidates"][0]["ticket"], "name": "file.bin"}], "downloads/")[0]

    async def wait_for(self, predicate):
        async with asyncio.timeout(15):
            while not predicate():
                await asyncio.sleep(0.01)

    async def test_search_paginates_and_respects_owner_and_private_names(self):
        parsed = await self.offline.parse(self.alice.id, "https://example.com/file.bin")
        ticket = parsed["candidates"][0]["ticket"]
        items = [{"ticket": ticket, "name": f"Report-{index}.bin"} for index in range(3)]
        tasks = self.offline.create(self.alice.id, items, "notes/")
        private_scope = Scope(self.alice.bucket_id, private_access=True)
        self.offline.create(self.alice.id, [{"ticket": ticket, "name": "secret-memo.bin"}],
                            ".tgdrive/private/", private_scope=private_scope)
        page = self.offline.list(self.alice.id, query="REPORT", status="active", limit=2)
        following = self.offline.list(self.alice.id, query="REPORT", status="active", limit=2, cursor=page["next_cursor"])
        self.assertEqual((page["total"], following["total"]), (3, 3))
        self.assertEqual([task["id"] for task in page["tasks"] + following["tasks"]], [task["id"] for task in reversed(tasks)])
        self.assertEqual(self.offline.list(self.alice.id, query="notes/")["total"], 3)
        self.assertEqual(self.offline.list(self.alice.id, query="EXAMPLE.COM")["total"], 4)
        self.assertEqual(self.offline.list(self.admin.id, query="Report")["total"], 0)
        self.assertEqual(self.offline.list(self.alice.id, query="secret-memo")["total"], 0)
        self.assertEqual(self.offline.list(self.alice.id, query="secret-memo", private_scope=private_scope)["total"], 1)
        self.assertEqual(self.offline.list(self.alice.id, query="私密空间下载")["tasks"][0]["key"], "私密空间下载")
        self.assertEqual(self.offline.list(self.alice.id, query="Report", status="completed")["total"], 0)
        self.assertEqual(self.offline.list(self.alice.id, query="%_")["total"], 0)
        with self.assertRaises(ValueError):
            self.offline.list(self.alice.id, query="x" * 201)
        client = Client(self.app)
        headers = await client.login("user", "alice@example.com", "alice password")
        status, _, body = await client.request("GET", "/api/user/v1/downloads?q=REPORT&limit=2&status=active", headers=headers)
        self.assertEqual((status, json.loads(body)["total"], len(json.loads(body)["tasks"])), (200, 3, 2))

    async def test_list_source_link_and_prefill_respect_secrets_and_private(self):
        task = await self.make("curl 'https://example.com/file.bin?signature=topsecret' -H 'Cookie: secret=hidden' -L")
        listed = self.offline.list(self.alice.id)["tasks"][0]
        self.assertEqual(listed["source"], {"url": "https://example.com/file.bin", "has_query": True})
        self.assertNotIn("topsecret", json.dumps(self.offline.list(self.alice.id)))
        source = self.offline.source(self.alice.id, task["id"])
        self.assertEqual(source["url"], "https://example.com/file.bin?signature=topsecret")
        self.assertEqual(source["download_type"], "http")
        request = parse_requests(source["input"])[0]
        self.assertEqual((request.url, request.headers), ("https://example.com/file.bin?signature=topsecret", [("Cookie", "secret=hidden")]))
        with self.assertRaises(NotFoundError):
            self.offline.source(self.admin.id, task["id"])
        private_scope = Scope(self.alice.bucket_id, private_access=True)
        parsed = await self.offline.parse(self.alice.id, "https://private.example.com/memo.bin")
        hidden = self.offline.create(self.alice.id, [{"ticket": parsed["candidates"][0]["ticket"], "name": "memo.bin"}], ".tgdrive/private/", private_scope=private_scope)[0]
        locked = next(item for item in self.offline.list(self.alice.id)["tasks"] if item["id"] == hidden["id"])
        self.assertIsNone(locked["source"])
        self.assertNotIn("private.example.com/memo", json.dumps(self.offline.list(self.alice.id)))
        with self.assertRaises(ValueError):
            self.offline.source(self.alice.id, hidden["id"])
        self.assertEqual(self.offline.source(self.alice.id, hidden["id"], private_scope=private_scope)["input"], "https://private.example.com/memo.bin")
        unlocked = next(item for item in self.offline.list(self.alice.id, private_scope=private_scope)["tasks"] if item["id"] == hidden["id"])
        self.assertEqual(unlocked["source"]["url"], "https://private.example.com/memo.bin")
        client = Client(self.app)
        headers = await client.login("user", "alice@example.com", "alice password")
        status, _, body = await client.request("GET", f"/api/user/v1/downloads/{task['id']}/source", headers=headers)
        self.assertEqual((status, json.loads(body)["url"]), (200, "https://example.com/file.bin?signature=topsecret"))
        status, _, _ = await client.request("GET", f"/api/user/v1/downloads/{hidden['id']}/source", headers=headers)
        self.assertEqual(status, 400)

    async def test_completed_task_reports_file_and_thumbnails(self):
        task = await self.make()
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
        listed = self.offline.list(self.alice.id)["tasks"][0]
        self.assertEqual((listed["file"]["key"], listed["file"]["thumbnails"]), ("downloads/file.bin", []))
        scope = Scope(self.alice.bucket_id)
        await self.app.objects.set_thumbnail(scope, "downloads/file.bin", b"RIFF\x1a\x00\x00\x00WEBPVP8 " + b"\x00" * 14)
        listed = self.offline.list(self.alice.id)["tasks"][0]
        self.assertEqual(listed["file"]["thumbnails"], ["thumb"])
        self.assertIn("thumb", listed["file"]["thumbnail_versions"])
        # 移动文件时任务记录随行更新；文件删除后退回普通图标。
        self.app.objects.move(scope, "downloads/file.bin", "elsewhere/file.bin")
        self.assertEqual(self.offline.list(self.alice.id)["tasks"][0]["file"]["key"], "elsewhere/file.bin")
        await self.app.objects.delete_objects(scope, ["elsewhere/file.bin"])
        self.assertIsNone(self.offline.list(self.alice.id)["tasks"][0]["file"])

    async def test_trashed_download_hides_internal_path_and_tracks_restore_conflicts(self):
        task = await self.make()
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
        scope = Scope(self.alice.bucket_id)
        entries = await self.app.objects.trash(scope, ["downloads/"])
        self.assertTrue(self.offline._row(task["id"])["key"].startswith(self.app.objects.TRASH_PREFIX))
        page = self.offline.list(self.alice.id)
        listed = page["tasks"][0]
        self.assertEqual((listed["key"], listed["trashed"], listed["file"], listed["private"]),
                         ("downloads/file.bin", True, None, False))
        self.assertNotIn(".tgdrive/", json.dumps(page))
        self.assertEqual(self.offline.list(self.alice.id, query="downloads/file.bin")["total"], 1)
        self.assertEqual(self.offline.list(self.alice.id, query=entries[0]["id"])["total"], 0)
        self.assertIsNone(self.offline.list(self.alice.id, ids=[task["id"]])["tasks"][0]["file"])
        # 还原时原位置已有其他文件：任务必须跟随自己的成品改名，不能关联到新文件。
        await self.app.objects.put_object(scope, "downloads/file.bin", b"replacement")
        self.app.objects.restore(scope, [entries[0]["id"]])
        listed = self.offline.list(self.alice.id)["tasks"][0]
        self.assertEqual((listed["key"], listed["trashed"], listed["file"]["key"]),
                         ("downloads/file (1).bin", False, "downloads/file (1).bin"))

    async def test_private_trash_keeps_download_names_sources_and_restart_protected(self):
        scope = Scope(self.alice.bucket_id, PRIVATE_PREFIX, private_access=True)
        parsed = await self.offline.parse(self.alice.id, "https://example.com/secret-memo.bin")
        task = self.offline.create(self.alice.id, [{"ticket": parsed["candidates"][0]["ticket"], "name": "secret-memo.bin"}],
                                   PRIVATE_PREFIX + "notes/", private_scope=scope)[0]
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
        await self.offline.stop()
        entries = await self.app.objects.trash(scope, [PRIVATE_PREFIX + "notes/secret-memo.bin"])
        self.assertTrue(self.offline._row(task["id"])["key"].startswith(PRIVATE_TRASH_PREFIX))
        locked = self.offline.list(self.alice.id)["tasks"][0]
        self.assertEqual((locked["key"], locked["private"], locked["trashed"], locked["source"], locked["file"]),
                         ("私密空间下载", True, True, None, None))
        self.assertEqual(self.offline.list(self.alice.id, query="secret-memo")["total"], 0)
        self.assertEqual(self.offline.list(self.alice.id, query="私密空间下载")["total"], 1)
        visible = self.offline.list(self.alice.id, query="secret-memo", private_scope=scope)
        self.assertEqual((visible["total"], visible["tasks"][0]["key"]), (1, PRIVATE_PREFIX + "notes/secret-memo.bin"))
        self.assertNotIn("private-trash", json.dumps(visible))
        with self.assertRaises(ValueError):
            self.offline.source(self.alice.id, task["id"])
        await self.app.objects.purge_trash(scope, [entries[0]["id"]])
        self.assertEqual(self.offline.list(self.alice.id, query="secret-memo")["total"], 0)
        restarted = await self.offline.control(self.alice.id, task["id"], "restart", private_scope=scope)
        self.assertEqual((restarted["key"], restarted["private"], restarted["trashed"]),
                         (PRIVATE_PREFIX + "notes/secret-memo.bin", True, False))

    async def test_private_tasks_do_not_depend_on_private_unlock(self):
        authorized = [True]
        def authorize():
            if not authorized[0]:
                raise PermissionError("私密空间已锁定")
        scope = Scope(self.alice.bucket_id, PRIVATE_PREFIX, private_access=True, authorize=authorize)
        tasks = []
        for name in ("a.bin", "b.bin", "c.bin"):
            parsed = await self.offline.parse(self.alice.id, f"https://example.com/{name}")
            tasks += self.offline.create(self.alice.id, [{"ticket": parsed["candidates"][0]["ticket"], "name": name}], PRIVATE_PREFIX, private_scope=scope)
        # 创建后立即锁定，并模拟服务重启留下的「等待恢复」：任务照常下载，不需要解锁。
        authorized[0] = False
        self.offline._set(tasks[0]["id"], status="interrupted", error="服务已重启，等待恢复")
        await self.offline.control(self.alice.id, tasks[2]["id"], "stop")
        self.offline.start()
        await self.wait_for(lambda: all(self.offline._row(task["id"])["status"] == "completed" for task in tasks[:2]))
        self.assertIsNotNone(self.app.metadata.db.execute("SELECT 1 FROM objects WHERE key=?", (PRIVATE_PREFIX + "a.bin",)).fetchone())
        self.assertEqual(self.offline._row(tasks[2]["id"])["status"], "stopped", "手动停止的任务不自动开始")
        # 锁定时也能继续、删除；返回结果不显示私密名称。更新下载参数需要解锁。
        resumed = await self.offline.control(self.alice.id, tasks[2]["id"], "resume")
        self.assertEqual((resumed["status"], resumed["key"]), ("queued", "私密空间下载"))
        await self.wait_for(lambda: self.offline._row(tasks[2]["id"])["status"] == "completed")
        with self.assertRaisesRegex(ValueError, "解锁"):
            await self.offline.control(self.alice.id, tasks[2]["id"], "update", item={"ticket": "x"})
        self.assertIsNone(await self.offline.control(self.alice.id, tasks[2]["id"], "delete"))

    async def test_redownload_of_deleted_file_returns_to_original_destination(self):
        for action in ("restart", "update"):
            with self.subTest(action=action):
                task = await self.make()
                self.offline.start()
                await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
                await self.offline.stop()
                scope = Scope(self.alice.bucket_id)
                entries = await self.app.objects.trash(scope, ["downloads/file.bin"])
                await self.app.objects.purge_trash(scope, [entries[0]["id"]])
                options = {}
                if action == "update":
                    parsed = await self.offline.parse(self.alice.id, "https://example.com/new.bin")
                    options["item"] = {"ticket": parsed["candidates"][0]["ticket"]}
                restarted = await self.offline.control(self.alice.id, task["id"], action, **options)
                self.assertEqual((restarted["key"], restarted["trashed"]), ("downloads/file.bin", False))
                self.offline.start()
                await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
                await self.offline.stop()
                listed = self.offline.list(self.alice.id, ids=[task["id"]])["tasks"][0]
                self.assertEqual(listed["file"]["key"], "downloads/file.bin")
                await self.app.objects.delete_objects(scope, ["downloads/file.bin"])

    async def test_batch_actions_skip_unsupported_and_foreign_tasks(self):
        first, second = await self.make(), await self.make()
        posted = await self.make("curl https://example.com/post --data-raw 'a=b'")
        result = await self.offline.batch(self.alice.id, "stop", [first["id"], second["id"], posted["id"]])
        self.assertEqual(result, {"done": 3, "skipped": 0})
        # POST 任务继续会重新发送请求体，批量继续时跳过，需逐个确认。
        result = await self.offline.batch(self.alice.id, "resume", [first["id"], posted["id"]])
        self.assertEqual(result, {"done": 1, "skipped": 1})
        self.assertEqual((self.offline._row(first["id"])["status"], self.offline._row(posted["id"])["status"]), ("queued", "stopped"))
        self.assertEqual(await self.offline.batch(self.admin.id, "delete", [first["id"]]), {"done": 0, "skipped": 1})
        for payload in ({"action": "restart", "ids": [first["id"]]}, {"action": "delete", "ids": []}, {"action": "delete", "ids": ["1"]}, {"action": "delete", "ids": list(range(1, 102))}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                await self.offline.batch(self.alice.id, payload["action"], payload["ids"])
        client = Client(self.app)
        headers = await client.login("user", "alice@example.com", "alice password")
        body = json.dumps({"action": "delete", "ids": [first["id"], second["id"], posted["id"], 999999]}).encode()
        status, _, data = await client.request("POST", "/api/user/v1/downloads/batch", body, headers)
        self.assertEqual((status, json.loads(data)), (200, {"done": 3, "skipped": 1}))
        self.assertEqual(self.offline.list(self.alice.id)["total"], 0)
        audit = self.app.metadata.db.execute("SELECT action,detail FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(audit["action"], "download.batch")
        self.assertEqual(json.loads(audit["detail"]), {"action": "delete", "count": 4, "done": 3})

    async def test_stop_all_stops_only_own_active_tasks_and_keeps_records(self):
        queued, interrupted, done, foreign = await self.make(), await self.make(), await self.make(), await self.make()
        with self.app.metadata.transaction() as db:
            db.execute("UPDATE offline_tasks SET status='interrupted' WHERE id=?", (interrupted["id"],))
            db.execute("UPDATE offline_tasks SET status='completed' WHERE id=?", (done["id"],))
            db.execute("UPDATE offline_tasks SET user_id=? WHERE id=?", (self.admin.id, foreign["id"]))
        client = Client(self.app)
        headers = await client.login("user", "alice@example.com", "alice password")
        status, _, data = await client.request("POST", "/api/user/v1/downloads/stop-all", b"{}", headers)
        self.assertEqual((status, json.loads(data)), (200, {"stopped": 2}))
        statuses = {row["id"]: row["status"] for row in self.app.metadata.db.execute("SELECT id, status FROM offline_tasks")}
        self.assertEqual((statuses[queued["id"]], statuses[interrupted["id"]], statuses[done["id"]], statuses[foreign["id"]]),
                         ("stopped", "stopped", "completed", "queued"), "只停止自己的进行中任务，记录保留，之后可以继续")
        audit = self.app.metadata.db.execute("SELECT action,detail FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual((audit["action"], json.loads(audit["detail"])), ("download.stop_all", {"stopped": 2}))
        await self.offline.control(self.alice.id, queued["id"], "resume")
        self.assertEqual(self.offline._row(queued["id"])["status"], "queued")

    async def test_list_by_ids_for_tray_reads_beyond_first_page(self):
        tasks = [await self.make() for _ in range(3)]
        foreign = await self.make()
        self.app.metadata.db.execute("UPDATE offline_tasks SET user_id=? WHERE id=?", (self.admin.id, foreign["id"]))
        listed = self.offline.list(self.alice.id, ids=[tasks[0]["id"], tasks[2]["id"], foreign["id"]], limit=1)
        self.assertEqual(sorted(task["id"] for task in listed["tasks"]), sorted([tasks[0]["id"], tasks[2]["id"]]), "只返回自己的任务，不受 limit 影响")
        self.assertIsNone(listed["next_cursor"])
        for ids in ([], ["1"], list(range(1, 102))):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                self.offline.list(self.alice.id, ids=ids)
        client = Client(self.app)
        headers = await client.login("user", "alice@example.com", "alice password")
        status, _, data = await client.request("GET", f"/api/user/v1/downloads?ids={tasks[1]['id']}", b"", headers)
        self.assertEqual((status, [task["id"] for task in json.loads(data)["tasks"]]), (200, [tasks[1]["id"]]))
        self.assertEqual((await client.request("GET", "/api/user/v1/downloads?ids=a", b"", headers))[0], 400)

    async def test_elapsed_time_recorded_and_reset_on_restart(self):
        task = await self.make()
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
        listed = self.offline.list(self.alice.id)["tasks"][0]
        self.assertGreater(listed["elapsed_seconds"], 0)
        await self.offline.stop()  # 停止调度，重新下载后任务保持排队，便于检查重置结果
        await self.offline.control(self.alice.id, task["id"], "restart")
        self.assertEqual(self.offline._row(task["id"])["elapsed_seconds"], 0)

    async def test_missing_extension_taken_from_content_type(self):
        http = self.http
        class Typed(MemoryHttp):
            @asynccontextmanager
            async def open(inner, request, **kwargs):
                async with http.open(request, **kwargs) as response:
                    response.headers["content-type"] = "image/jpeg"
                    yield response
        self.offline.http = Typed()
        parsed = await self.offline.parse(self.alice.id, "https://gips2.example.com/it/u=195724436,3554684702&fm=3028&app=3028")
        self.assertEqual(parsed["candidates"][0]["name"], "u=195724436,3554684702&fm=3028&app=3028.jpg")
        parsed = await self.offline.parse(self.alice.id, "https://example.com/download/archive")
        self.assertEqual(parsed["candidates"][0]["name"], "archive.jpg")
        self.offline.http = http
        parsed = await self.offline.parse(self.alice.id, "https://example.com/download/blob")
        self.assertEqual(parsed["candidates"][0]["name"], "blob")

    async def test_hls_separate_audio_survives_ticket_update_and_saves(self):
        self.app.resources.ffmpeg = "fixture"
        self.app.resources.update({"hls_enabled": True})
        class HlsHttp(MemoryHttp):
            audio = "audio.m3u8"
            @asynccontextmanager
            async def open(inner, request, **kwargs):
                async with self.http.open(request, **kwargs) as response:
                    response.headers["content-type"] = "application/vnd.apple.mpegurl"
                    async def read():
                        if request.url.endswith("master.m3u8"):
                            return (f'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="{inner.audio}"\n'
                                '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a"\nvideo.m3u8\n').encode()
                        return b'#EXTM3U\n#EXTINF:2,\n1.ts\n#EXT-X-ENDLIST\n'
                    response.read = read
                    yield response
        client = HlsHttp()
        self.offline.http = client
        async def parse():
            return (await self.offline.parse(self.alice.id,
                "curl https://example.com/master.m3u8 -H 'Cookie: secret=hidden'"))["candidates"][0]
        candidate = await parse()
        task = self.offline.create(self.alice.id, [{"ticket": candidate["ticket"], "name": "movie.mp4"}], "")[0]
        client.audio = "updated.m3u8"
        replacement = await parse()
        await self.offline.control(self.alice.id, task["id"], "update", item={"ticket": replacement["ticket"]})
        source = self.offline._source(self.offline._row(task["id"]))
        self.assertEqual(source["hls_audio"]["url"], "https://example.com/updated.m3u8")
        self.assertEqual(source["hls_audio"]["credential_origin"], "https://example.com/master.m3u8")
        from tests.test_mp4_index import fragmented_mp4  # 封装结果会被转成普通 MP4，必须是合法的分片 MP4
        movie, _ = fragmented_mp4(2)
        calls = []
        async def remux(*args, **kwargs):
            calls.append(kwargs)
            yield movie
        with patch('tgdrive.offline.service.remux', remux):
            self.offline.start()
            await self.wait_for(lambda: self.offline._row(task["id"])["status"] in ("completed", "failed"))
        self.assertEqual(self.offline._row(task["id"])["status"], "completed")
        self.assertEqual(calls[0]["audio"][0].url, "https://example.com/updated.m3u8")
        self.assertEqual(self.offline._row(task["id"])["segments_total"], 2)

    async def test_credentials_permissions_and_delete_retains_file(self):
        task = await self.make()
        row = self.offline._row(task["id"])
        self.assertNotIn(b"secret=hidden", row["request_enc"])
        self.assertNotIn("hidden", json.dumps(self.offline.list(self.alice.id)))
        self.assertEqual(self.offline._source(row)["request"]["headers"][0][1], "secret=hidden")
        with self.assertRaises(NotFoundError):
            await self.offline.control(self.admin.id, task["id"], "delete")
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
        self.assertEqual(self.app.objects.head_object(Scope(self.alice.bucket_id), "downloads/file.bin").size, 1000)
        await self.offline.control(self.alice.id, task["id"], "delete")
        self.assertEqual(self.app.objects.head_object(Scope(self.alice.bucket_id), "downloads/file.bin").size, 1000)

    async def test_stop_and_strong_validator_resume(self):
        self.http.size = 20 * 1024 * 1024
        task = await self.make()
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["stored_bytes"] >= 16 * 1024 * 1024)
        await self.offline.control(self.alice.id, task["id"], "stop")
        row = self.offline._row(task["id"])
        self.assertEqual(row["status"], "stopped")
        await self.offline.control(self.alice.id, task["id"], "resume")
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
        ranges = [headers for method, headers, _ in self.http.calls if method == "GET" and headers]
        self.assertEqual(ranges[-1], {"Range": "bytes=16777216-", "If-Range": '"version-1"'})
        self.assertEqual(self.app.objects.head_object(Scope(self.alice.bucket_id), "downloads/file.bin").size, self.http.size)

    async def test_temporary_source_error_keeps_breakpoint_and_retries(self):
        from tgdrive.offline import service
        self.http.size = 20 * 1024 * 1024
        task = await self.make()
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["stored_bytes"] >= 16 * 1024 * 1024)
        await self.offline.control(self.alice.id, task["id"], "stop")
        http, outages = self.http, [1]
        class Unavailable:
            @asynccontextmanager
            async def open(self, request, **kwargs):
                if outages[0]:
                    outages[0] -= 1
                    yield type("Reply", (), {"status": 503, "headers": {}, "size": 0, "url": request.url})()
                    return
                async with http.open(request, **kwargs) as response:
                    yield response
        original, service.RETRY_DELAYS = service.RETRY_DELAYS, (0.05, 0.05, 0.05)
        try:
            self.offline.http = Unavailable()
            await self.offline.control(self.alice.id, task["id"], "resume")
            await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
        finally:
            service.RETRY_DELAYS = original
        # 503 之后仍从 16 MiB 断点继续，没有清理已保存的分段。
        ranges = [headers for method, headers, _ in http.calls if method == "GET" and headers]
        self.assertEqual(ranges[-1], {"Range": "bytes=16777216-", "If-Range": '"version-1"'})

    async def test_changed_source_is_never_appended(self):
        self.http.size = 20 * 1024 * 1024
        task = await self.make()
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["stored_bytes"] >= 16 * 1024 * 1024)
        await self.offline.control(self.alice.id, task["id"], "stop")
        self.http.changed = True
        await self.offline.control(self.alice.id, task["id"], "resume")
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "failed")
        self.assertIsNone(self.offline._row(task["id"])["upload_id"])
        with self.assertRaises(NotFoundError):
            self.app.objects.head_object(Scope(self.alice.bucket_id), "downloads/file.bin")

    async def test_post_parse_no_probe_and_rotation_preserves_secrets(self):
        task = await self.make("curl https://example.com/file.bin --data-raw 'private=value'")
        self.assertEqual(self.http.calls, [])
        self.app.keystore.rotate("encryption passphrase", "new encryption passphrase")
        self.assertEqual(self.offline._source(self.offline._row(task["id"]))["request"]["body"], "private=value")
        self.offline._set(task["id"], status="running")
        self.offline.start()
        self.assertEqual(self.offline._row(task["id"])["status"], "stopped")
        await asyncio.sleep(0.02)
        self.assertEqual(self.http.calls, [])

    async def test_expired_upload_and_conflict_are_safe(self):
        task = await self.make()
        self.offline._set(task["id"], upload_id="already-cleaned", stored_bytes=12345)
        await self.app.objects.put_object(Scope(self.alice.bucket_id), "downloads/file.bin", b"keep this file")
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")
        self.assertEqual(self.app.objects.head_object(Scope(self.alice.bucket_id), "downloads/file.bin").size, 14)
        self.assertEqual(self.offline._row(task["id"])["key"], "downloads/file (1).bin")

    async def test_admin_config_and_web_authorization(self):
        client = Client(self.app)
        alice = await client.login("user", "alice@example.com", "alice password")
        status, _, _ = await client.request("POST", "/api/admin/v1/resources", b'{"mode":"low"}', alice)
        self.assertEqual(status, 403)
        status, _, _ = await client.request("POST", "/api/user/v1/downloads/parse", b'{"input":"https://example.com/f"}', {"cookie": alice["cookie"]})
        self.assertEqual(status, 403)
        admin = await client.login("admin", "admin@example.com", "admin password")
        status, _, data = await client.request("POST", "/api/admin/v1/resources", b'{"mode":"low"}', admin)
        self.assertEqual(status, 200)
        effective = json.loads(data)["effective"]
        self.assertEqual(self.app.engine.transfers.per_bucket, effective["bucket_concurrency"], "保存后读取名额立即生效")
        # 私密下载位置需要已解锁的私密授权；未授权是业务校验错误（400），不能让前端当成会话过期。
        with self.assertRaises(ValueError):
            parsed = await self.offline.parse(self.alice.id, "https://example.com/f")
            self.offline.create(self.alice.id, [{"ticket": parsed["candidates"][0]["ticket"], "name": "f"}], ".tgdrive/private/")

    async def test_budget_persistence_and_disabled_queue(self):
        self.app.resources.detected.update(cpu_cores=1, memory_bytes=750 * 1024 * 1024)
        saved = self.app.resources.update({"mode": "custom", "concurrency": 4})
        self.assertEqual(saved["effective"]["concurrency"], 2, "低配机器（1 核、750 MB）离线下载最多同时 2 个")
        self.assertTrue(saved["effective"]["reduced"])
        restored = ResourceSettings(self.app.metadata, self.app.resources.data_dir, {"mode": "standard"})
        self.assertEqual(restored.config()["mode"], "custom")
        task = await self.make()
        self.app.accounts.set_account_status(self.alice.id, "disabled")
        self.assertEqual(self.offline._row(task["id"])["status"], "stopped")
        self.app.accounts.set_account_status(self.alice.id, "active")
        self.offline.start()
        await asyncio.sleep(0.02)
        self.assertEqual(self.offline._row(task["id"])["status"], "stopped")

    async def test_transfer_concurrency_is_admin_setting_applied_immediately(self):
        resources, transfers = self.app.resources, self.app.engine.transfers
        resources.detected.update(cpu_cores=4, memory_bytes=8 * 1024 ** 3)
        saved = resources.update({"mode": "auto", "transfer_concurrency": 8, "bucket_concurrency": 3})
        self.assertEqual((saved["effective"]["transfer_concurrency"], saved["effective"]["bucket_concurrency"]), (8, 3))
        self.assertEqual((transfers.total, transfers.per_bucket), (8, 3), "保存后立即生效，不需要重启")
        for bad in ({"transfer_concurrency": 0}, {"transfer_concurrency": 17}, {"transfer_concurrency": 2, "bucket_concurrency": 3},
                    {"bucket_concurrency": True}):
            with self.assertRaises(ValueError):
                resources.update(bad)
        resources.update({"transfer_concurrency": 12, "bucket_concurrency": 12})
        low = resources.update({"mode": "low"})["effective"]
        # 低资源档最多 8 路读取，每个账号可以用满（不再减半）。
        self.assertEqual((low["transfer_concurrency"], low["bucket_concurrency"], low["transfer_reduced"]), (8, 8, True))
        self.assertEqual((transfers.total, transfers.per_bucket), (8, 8))
        # 自定义模式不按低资源档收紧，只按检测到的内存留余量（自动模式在 1 GB 以下会选低资源档）。
        resources.update({"mode": "custom"})
        resources.detected.update(memory_bytes=512 * 1024 ** 2)
        self.assertEqual(resources.effective()["transfer_concurrency"], 7, "每路约 24 MB，最多占内存的三分之一")
        # 旧版保存的配置没有这两项时，用启动参数补齐。
        with self.app.metadata.transaction() as db:
            db.execute("UPDATE settings SET value=? WHERE key=?", ('{"mode":"standard"}', ResourceSettings.KEY))
        restored = ResourceSettings(self.app.metadata, resources.data_dir, {"transfer_concurrency": 6, "bucket_concurrency": 2})
        self.assertEqual(restored.config()["transfer_concurrency"], 6)

    async def test_legacy_standard_mode_reads_as_auto(self):
        resources = self.app.resources
        resources.detected.update(cpu_cores=4, memory_bytes=8 * 1024 ** 3)
        # 旧版保存的「标准」：读取时按「自动」处理，硬件足够时生效档位仍是标准。
        with self.app.metadata.transaction() as db:
            db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (ResourceSettings.KEY, '{"mode":"standard","concurrency":3}'))
        restored = ResourceSettings(self.app.metadata, resources.data_dir)
        restored.detected.update(cpu_cores=4, memory_bytes=8 * 1024 ** 3)
        self.assertEqual(restored.config()["mode"], "auto")
        self.assertEqual(restored.effective()["mode"], "standard")
        restored.detected.update(cpu_cores=1, memory_bytes=512 * 1024 ** 2)
        self.assertEqual(restored.effective()["mode"], "low")
        # 启动参数与接口仍接受 standard，保存为 auto。
        self.assertEqual(ResourceSettings(self.app.metadata, resources.data_dir, {"mode": "standard"}).defaults["mode"], "auto")
        self.assertEqual(resources.update({"mode": "standard"})["config"]["mode"], "auto")
        with self.assertRaises(ValueError):
            resources.update({"mode": "turbo"})

    async def test_lock_unlock_resumes_get(self):
        self.http.size = 20 * 1024 * 1024
        task = await self.make()
        self.offline.start()
        await self.wait_for(lambda: self.offline._row(task["id"])["stored_bytes"] >= 16 * 1024 * 1024)
        self.app.keystore.lock()
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "interrupted")
        self.app.keystore.unlock("encryption passphrase")
        await self.wait_for(lambda: self.offline._row(task["id"])["status"] == "completed")

    async def test_shutdown_keeps_completed_status(self):
        task = await self.make()
        worker = asyncio.create_task(self.offline._run(task["id"]))
        await worker
        self.offline._running[task["id"]] = worker
        await self.offline.stop()
        self.assertEqual(self.offline._row(task["id"])["status"], "completed")

    async def test_ambient_cancel_does_not_replay_post(self):
        self.http.size = 20 * 1024 * 1024
        task = await self.make("curl https://example.com/file.bin --data-raw 'fixture=value'")
        self.offline.start()
        await self.wait_for(lambda: bool(self.http.calls))
        worker = self.offline._running[task["id"]]
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)
        self.assertEqual(self.offline._row(task["id"])["status"], "stopped")
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.http.calls), 1)
