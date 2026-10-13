"""平台下载的授权、Cookie 隔离、地址重解析与真实解析器通道回归。"""

import asyncio
import base64
import json
import tempfile
import unittest
from pathlib import Path
from contextlib import asynccontextmanager
from types import SimpleNamespace
from urllib.parse import urlsplit
from unittest.mock import AsyncMock, patch

from tgdrive.app import create_app
from tgdrive.objects import Scope
from tgdrive.metadata import Metadata
from tgdrive.offline.http import DownloadError, ExpiredMedia, TransientError
from tgdrive.offline.platforms import PlatformResolver, allowed_url, capabilities, parse_cookies, prepare, site_link
from tgdrive.offline.request import DownloadRequest, parse_requests
from tgdrive.offline.resources import ResourceSettings
from tests.test_offline import MemoryHttp


class InputTests(unittest.TestCase):
    def test_single_media_and_domain_boundaries(self):
        self.assertEqual(site_link("https://twitter.com/user/status/123/photo/1"), ("x", "123", "https://x.com/i/web/status/123"))
        self.assertEqual(site_link("https://youtu.be/BaW_jenozKc?list=unused")[1], "BaW_jenozKc")
        for url in ("https://x.com/user", "https://youtube.com/playlist?list=123", "https://youtube.com/@channel"):
            with self.assertRaises(DownloadError): site_link(url)
        for url in ("https://x.com.evil.example/a", "http://x.com/a", "https://x.com:444/a", "https://127.0.0.1/a"):
            with self.assertRaises(DownloadError): allowed_url("x", url)

    def test_cookie_scope_and_validation(self):
        text = "# Netscape HTTP Cookie File\n#HttpOnly_.twitter.com\tTRUE\t/\tTRUE\t0\tauth_token\tprivate\n.other.example\tTRUE\t/\tTRUE\t0\tsecret\tignored"
        records = parse_cookies(text, "x")
        self.assertEqual([(row["domain"], row["name"]) for row in records], [(".x.com", "auth_token")])
        self.assertEqual(parse_cookies("a=b=c; ct0=test", "x")[0]["value"], "b=c")
        self.assertEqual(parse_cookies("cookie: ct0=test", "x")[0]["name"], "ct0")
        for text in ("a=b\nInjected: value", "a=b\x00", "missing separator", "a=" + "x" * 9000):
            with self.assertRaises(DownloadError): parse_cookies(text, "x")

    def test_v14_upgrade_preserves_tables_and_creates_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meta.db"
            metadata = Metadata(path)
            with metadata.transaction() as db:
                db.execute("INSERT INTO settings(key,value) VALUES('platform-test','preserved')")
                db.execute("ALTER TABLE offline_tasks DROP COLUMN platform")
                db.execute("ALTER TABLE offline_tasks DROP COLUMN phase")
                db.execute("PRAGMA user_version=14")
            metadata.close()
            migrated = Metadata(path)
            self.assertEqual(migrated.db.execute("PRAGMA user_version").fetchone()[0], Metadata.SCHEMA_VERSION)
            self.assertIn("elapsed_seconds", {row[1] for row in migrated.db.execute("PRAGMA table_info(offline_tasks)")})
            self.assertEqual(migrated.db.execute("SELECT value FROM settings WHERE key='platform-test'").fetchone()[0], "preserved")
            self.assertTrue({"platform", "phase"}.issubset({row[1] for row in migrated.db.execute("PRAGMA table_info(offline_tasks)")}))
            self.assertEqual(len(list(Path(directory).glob("meta.db.v14.*.bak"))), 1)
            migrated.close()

    def test_reclaimable_file_cache_does_not_pause_small_container(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current = root / "memory.current"
            current.write_text(str(720 * 1024 * 1024))
            (root / "memory.max").write_text(str(750 * 1024 * 1024))
            (root / "memory.stat").write_text(f"inactive_file {400 * 1024 * 1024}\n")
            resources = ResourceSettings(None, root, {"reserve_mib": 128})
            resources._config = resources.defaults
            resources.detected["memory_usage_paths"] = [str(current)]
            self.assertIsNone(resources.pressure())
            (root / "memory.stat").write_text("inactive_file 0\n")
            self.assertIn("内存", resources.pressure())


def image(url="https://pbs.twimg.com/media/test.jpg"):
    return {"selection": {"id": "123", "index": "1"}, "group": "1", "name": "X-123-1.jpg",
            "media_type": "image", "content_type": "image/jpeg", "variant": None,
            "size": None, "duration": None, "tracks": [{"url": url, "headers": {}, "extension": "jpg"}]}


class PlatformTasks(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(self.temp.name, run_scheduler=False, offline_x=True)
        self.admin = self.app.accounts.setup("test encryption passphrase", "admin", "test admin password")
        self.user = self.app.accounts.create_user("alice", "test user password")
        self.offline = self.app.offline
        self.app.resources.platform_tools["x_available"] = True
        self.offline.http = self.http = MemoryHttp()
        self.extracted = []
        async def resolve(source, check):
            check()
            self.extracted.append(source)
            return [image(f"https://pbs.twimg.com/media/version-{len(self.extracted)}.jpg")]
        self.offline.platforms.resolve = resolve

    async def asyncTearDown(self):
        await self.offline.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    async def make(self):
        parsed = await self.offline.parse(self.user.id, "https://x.com/u/status/123", cookies="auth_token=private; ct0=private2")
        candidate = parsed["candidates"][0]
        return self.offline.create(self.user.id, [{"ticket": candidate["ticket"], "name": candidate["name"]}], "downloads/")[0]

    async def test_credentials_tickets_and_fresh_media_address(self):
        task = await self.make()
        self.assertEqual(task["platform"], "x")
        row = self.offline._row(task["id"])
        self.assertNotIn(b"private", row["request_enc"])
        self.assertNotIn("private", json.dumps(self.offline.list(self.user.id)))
        self.offline.start()
        async with asyncio.timeout(10):
            while self.offline._row(task["id"])["status"] not in ("completed", "failed"):
                await asyncio.sleep(0.01)
        self.assertEqual(self.offline._row(task["id"])["status"], "completed")
        # 解析结果仍在有效期内，开始下载时直接复用，不再启动解析子进程。
        self.assertEqual(len(self.extracted), 1)
        self.assertTrue(any(url.endswith("version-1.jpg") for method, _, url in self.http.calls if method == "GET"))
        self.assertEqual(self.app.objects.head_object(Scope(self.user.bucket_id), task["key"]).size, 1000)
        with self.assertRaises(ValueError):
            await self.offline.parse(self.user.id, "https://youtube.com/watch?v=BaW_jenozKc", download_type="x")
        with self.assertRaises(ValueError):
            await self.offline.parse(self.user.id, "https://x.com/u/status/123\nhttps://x.com/u/status/456")

    async def wait(self, task_id, statuses=("completed", "failed")):
        async with asyncio.timeout(10):
            while self.offline._row(task_id)["status"] not in statuses:
                await asyncio.sleep(0.01)
        return self.offline._row(task_id)

    async def test_expired_media_address_is_resolved_again(self):
        http = self.http
        class Expiring(MemoryHttp):
            @asynccontextmanager
            async def open(inner, request, **kwargs):
                if request.url.endswith("version-1.jpg"):
                    http.calls.append(("GET", {}, request.url))
                    yield SimpleNamespace(status=403, headers={}, size=0, url=request.url)
                    return
                async with http.open(request, **kwargs) as response:
                    yield response
        task = await self.make()
        self.offline.http = Expiring()
        self.offline.start()
        row = await self.wait(task["id"])
        self.assertEqual(row["status"], "completed")
        self.assertEqual(len(self.extracted), 2)
        self.assertTrue(any(url.endswith("version-2.jpg") for _, _, url in http.calls))

    async def test_youtube_403_retries_same_height_with_hls_preferred(self):
        self.app.resources.ffmpeg = "fixture"
        self.app.resources.platform_tools["youtube_available"] = True
        self.app.resources.update({"youtube_enabled": True})
        sources = []
        async def resolve(source, check):
            sources.append(dict(source))
            return [{**image("https://manifest.googlevideo.com/index.m3u8"),
                "selection": {"id": "BaW_jenozKc", "index": "1", "height": 720}, "media_type": "video",
                "name": "video.mp4", "content_type": "video/mp4", "variant": "720p · MP4",
                "tracks": [{"url": "https://manifest.googlevideo.com/index.m3u8", "headers": {},
                            "protocol": "hls" if source.get("prefer_hls") else "https"}]}]
        self.offline.platforms.resolve = resolve
        candidate = (await self.offline.parse(self.user.id, "https://youtu.be/BaW_jenozKc"))["candidates"][0]
        task = self.offline.create(self.user.id, [{"ticket": candidate["ticket"], "name": "video.mp4"}], "")[0]
        row = self.offline._row(task["id"])
        self.offline._stats[task["id"]] = {}
        fetched = AsyncMock(side_effect=[ExpiredMedia("HTTP 403"), None])
        with patch.object(self.offline, "_fetch_entry", fetched):
            await self.offline._platform(row, self.offline.scope(self.user.id), self.offline._source(row))
        self.assertEqual(fetched.await_count, 2)
        self.assertTrue(sources[-1]["prefer_hls"])
        self.assertEqual(fetched.await_args_list[0].args[2]["selection"], fetched.await_args_list[1].args[2]["selection"])
        self.assertEqual(fetched.await_args_list[1].args[2]["tracks"][0]["protocol"], "hls")

    async def test_transient_failures_retry_automatically_then_give_up(self):
        from tgdrive.offline import service
        from tgdrive.offline.http import TransientError
        http, failures = self.http, [2]
        class Flaky(MemoryHttp):
            @asynccontextmanager
            async def open(inner, request, **kwargs):
                if failures[0]:
                    failures[0] -= 1
                    raise TransientError("来源连接中断，可以稍后重试")
                async with http.open(request, **kwargs) as response:
                    yield response
        original = service.RETRY_DELAYS
        service.RETRY_DELAYS = (0.05, 0.05, 0.05)
        try:
            task = await self.make()
            self.offline.http = Flaky()
            self.offline.start()
            row = await self.wait(task["id"], ("interrupted",))
            self.assertIn("自动重试（第 1/3 次）", row["error"])
            row = await self.wait(task["id"])
            self.assertEqual((row["status"], row["error"]), ("completed", None))
            failures[0] = 10
            await self.offline.control(self.user.id, task["id"], "restart")
            row = await self.wait(task["id"], ("failed",))
            self.assertIn("已自动重试 3 次", row["error"])
        finally:
            service.RETRY_DELAYS = original

    async def test_clear_finished_tasks_keeps_files_and_active_tasks(self):
        done, failed, queued = [await self.make() for _ in range(3)]
        self.offline.start()
        await self.wait(done["id"])
        await self.wait(failed["id"])
        await self.wait(queued["id"])
        self.offline._set(failed["id"], status="failed", error="测试失败")
        self.offline._set(queued["id"], status="stopped")
        self.assertEqual(await self.offline.clear(self.user.id, "completed"), {"removed": 1})
        self.assertEqual(await self.offline.clear(self.user.id, "failed"), {"removed": 1})
        remaining = [task["id"] for task in self.offline.list(self.user.id)["tasks"]]
        self.assertEqual(remaining, [queued["id"]])
        self.app.objects.head_object(Scope(self.user.bucket_id), done["key"])
        with self.assertRaises(ValueError):
            await self.offline.clear(self.user.id, "stopped")
        bob = self.app.accounts.create_user("bob", "test user password")
        self.offline._set(queued["id"], status="completed")
        self.assertEqual(await self.offline.clear(bob.id, "completed"), {"removed": 0})
        self.assertEqual(len(self.offline.list(self.user.id)["tasks"]), 1)

    def test_component_versions_reported(self):
        components = self.app.resources.describe()["components"]
        self.assertIn("yt-dlp", components["versions"])
        self.assertIn("ffmpeg", components["versions"])

    async def test_stop_cleans_platform_partial_and_disable_stops_queue(self):
        self.http.size = 30 * 1024 * 1024
        task = await self.make()
        self.offline.start()
        async with asyncio.timeout(10):
            while self.offline._row(task["id"])["stored_bytes"] < 16 * 1024 * 1024:
                await asyncio.sleep(0.01)
        await self.offline.control(self.user.id, task["id"], "stop")
        row = self.offline._row(task["id"])
        self.assertEqual((row["status"], row["stored_bytes"], row["upload_id"]), ("stopped", 0, None))
        self.app.resources.update({"x_enabled": False})
        await self.offline.control(self.user.id, task["id"], "resume")
        async with asyncio.timeout(3):
            while self.offline._row(task["id"])["status"] != "stopped":
                await asyncio.sleep(0.01)
        self.assertIn("未启用", self.offline._row(task["id"])["error"])


class Reply:
    def __init__(self, url, body):
        self.url, self.status = url, 200
        self.data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.size = len(self.data)
        self.headers = {"content-type": "application/json", "content-length": str(self.size)}
        self.raw_headers = list(self.headers.items())

    async def stream(self):
        yield self.data


class ExtractorHttp:
    def __init__(self, platform):
        self.platform, self.calls = platform, []

    @asynccontextmanager
    async def open(self, request, **_):
        self.calls.append(request)
        path = urlsplit(request.url).path
        if self.platform.startswith("x"):
            if self.platform == "x_logged" and path == "/home":
                # 用真实库初始化交易 ID，覆盖访客 API 未涉及的登录流程。
                verification = base64.b64encode(bytes(32)).decode()
                frames = ''.join(f'<svg id="loading-x-anim-{number}"><path d="M0"></path>'
                    '<path d="M000000000 0 0 0 0 0 0 0 0 255 255"></path></svg>'
                    for number in range(4))
                data = (f'<meta name="twitter-site-verification" content="{verification}">'
                    '<script>var assets={0:"other",123:"ondemand.s",123:"fixture"};</script>'
                    + frames).encode()
            elif self.platform == "x_logged" and path.endswith(".js"):
                data = b'(a[0], 16);(a[1], 16);(a[2], 16);(a[3], 16);'
            elif path.endswith("guest/activate.json"):
                data = {"guest_token": "test-guest-token"}
            else:
                user = {"id_str": "1", "name": "Test", "screen_name": "test", "created_at": "Wed Oct 10 20:19:24 +0000 2018",
                        "location": "", "verified": False, "protected": False, "profile_image_url_https": "", "description": ""}
                tweet = {"rest_id": "123", "core": {"user_results": {"result": user}},
                         "legacy": {"id_str": "123", "lang": "en", "full_text": "test", "created_at": user["created_at"],
                                    "entities": {}, "extended_entities": {"media": [
                                        {"type": "photo", "media_url_https": "https://pbs.twimg.com/media/first.jpg", "original_info": {"width": 600, "height": 400}},
                                        {"type": "video", "media_url_https": "https://pbs.twimg.com/media/second.jpg", "original_info": {"width": 640, "height": 360},
                                         "video_info": {"duration_millis": 6000, "variants": [{"bitrate": 100000, "url": "https://video.twimg.com/test.mp4"}]}}
                                    ]}}}
                data = {"data": {"tweetResult": {"result": tweet}}}
                if self.platform == "x_logged":
                    data = {'data': {'threaded_conversation_with_injections_v2': {'instructions': [
                        {'type': 'TimelineAddEntries', 'entries': [
                            {'entryId': 'tweet-123', 'content': {'itemContent': {
                                'tweet_results': {'result': tweet}}}}
                        ]}
                    ]}}}
                elif self.platform in ("x_fallback", "x_empty"):
                    if path.endswith('/tweet-result'):
                        data = {'id_str': '123', 'user': {'screen_name': 'test'},
                                'mediaDetails': tweet['legacy']['extended_entities']['media']}
                    elif self.platform == "x_fallback":
                        data = {"data": {"tweetResult": {"result": {"__typename": "TweetTombstone", "tombstone": {}}}}}
                    else:
                        data = {"data": {"tweetResult": {"result": {**tweet, "legacy": {
                            **tweet['legacy'], "extended_entities": {"media": []}}}}}}
                elif self.platform == "x_login":
                    data = {"data": {"tweetResult": {"result": {"__typename": "TweetUnavailable", "reason": "NsfwLoggedOut"}}}}
        else:
            data = {"playabilityStatus": {"status": "OK"},
                    "videoDetails": {"videoId": "BaW_jenozKc", "title": "Test video", "lengthSeconds": "6", "author": "test", "channelId": "UCaaaaaaaaaaaaaaaaaaaaaa", "isLiveContent": False},
                    "streamingData": {"formats": [{"itag": 18, "url": "https://r1.googlevideo.com/combined.mp4", "mimeType": 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', "width": 640, "height": 360, "bitrate": 200000, "contentLength": "1000", "quality": "medium"}],
                                      "adaptiveFormats": [{"itag": 136, "url": "https://r1.googlevideo.com/video.mp4", "mimeType": 'video/mp4; codecs="avc1.4d401f"', "width": 1280, "height": 720, "bitrate": 1000000, "contentLength": "2000", "quality": "hd720", "fps": 30},
                                                          {"itag": 140, "url": "https://r1.googlevideo.com/audio.m4a", "mimeType": 'audio/mp4; codecs="mp4a.40.2"', "bitrate": 128000, "contentLength": "500", "audioSampleRate": "44100", "audioChannels": 2}]}}
            if not path.startswith("/youtubei/"):
                data = ("<html><script>var ytInitialPlayerResponse = " + json.dumps(data) + ";</script><script>ytcfg.set({\"INNERTUBE_API_KEY\":\"test\",\"INNERTUBE_CONTEXT\":{\"client\":{\"clientName\":\"WEB\",\"clientVersion\":\"2.20260101\"}}});</script></html>").encode()
        yield Reply(request.url, data)


class RealExtractors(unittest.IsolatedAsyncioTestCase):
    async def resolve(self, platform, url, *, cookies="", http=None, request=None):
        tools = capabilities()
        resources = SimpleNamespace(platform_tools=tools, effective=lambda: {"x_enabled": True, "youtube_enabled": True,
            "x_available": tools["x_available"], "youtube_available": tools["youtube_available"], "platform_max_mib": 512, "youtube_max_height": 720})
        http = http if http is not None else ExtractorHttp(platform)
        site, media_id, canonical = site_link(url)
        entries = await PlatformResolver(http, resources).resolve(prepare(request or DownloadRequest(url), cookies, site, media_id, canonical), lambda: None)
        return entries, http.calls

    @unittest.skipUnless(capabilities()["x_available"], "未安装可选 X 解析组件")
    async def test_logged_x_transaction_headers_use_parent_transport(self):
        url = 'https://x.com/u/status/123'
        curl = parse_requests(f"curl --url '{url}' -b 'auth_token=login-private; ct0=csrf-private' "
            "-H 'user-agent: TestBrowser'")[0]
        cases = [(curl, '')]
        for domain, include in (('.x.com', 'TRUE'), ('x.com', 'FALSE')):
            cookies = f'{domain}\t{include}\t/\tTRUE\t0\tauth_token\tlogin-private\n'
            cookies += f'{domain}\t{include}\t/\tTRUE\t0\tct0\tcsrf-private'
            cases.append((DownloadRequest(url), cookies))
        for request, cookies in cases:
            with self.subTest(format='curl' if request is curl else cookies.split('\t')[0]):
                entries, calls = await self.resolve('x_logged', url, request=request,
                    cookies=cookies, http=ExtractorHttp('x_logged'))
                self.assertEqual([entry['media_type'] for entry in entries], ['image', 'video'])
                self.assertEqual([urlsplit(call.url).path.rsplit('/', 1)[-1] for call in calls],
                    ['home', 'ondemand.s.fixturea.js', 'TweetDetail'])
                headers = {key.lower(): value for key, value in calls[-1].headers}
                self.assertEqual(headers['x-twitter-auth-type'], 'OAuth2Session')
                self.assertEqual(headers['x-csrf-token'], 'csrf-private')
                self.assertIn('auth_token=login-private', headers['cookie'])
                self.assertIn('ct0=csrf-private', headers['cookie'])
                self.assertEqual(len(base64.b64decode(headers['x-client-transaction-id'], validate=True)), 54)
                self.assertNotIn('cookie', {key.lower() for key, _ in calls[1].headers})
                self.assertFalse({'cookie', 'authorization'} &
                    {name.lower() for name in entries[1]['tracks'][0]['headers']})

    @unittest.skipUnless(capabilities()["x_available"], "未安装可选 X 解析组件")
    async def test_real_x_library_uses_parent_transport(self):
        entries, calls = await self.resolve("x", "https://x.com/u/status/123")
        self.assertEqual([entry["media_type"] for entry in entries], ["image", "video"])
        self.assertEqual(entries[0]["name"], "test-123-1.jpg")
        self.assertIn("name=orig", entries[0]["tracks"][0]["url"])
        self.assertEqual(entries[1]["tracks"][0]["url"], "https://video.twimg.com/test.mp4")
        self.assertGreaterEqual(len(calls), 2)

    @unittest.skipUnless(capabilities()["x_available"], "未安装可选 X 解析组件")
    async def test_tombstone_tries_official_embed_endpoint(self):
        for platform in ('x_fallback', 'x_empty'):
            with self.subTest(platform=platform):
                entries, calls = await self.resolve(platform, "https://x.com/u/status/123")
                self.assertEqual([entry["media_type"] for entry in entries], ["image", "video"])
                self.assertTrue(any(urlsplit(request.url).hostname == "cdn.syndication.twimg.com" for request in calls))
                self.assertEqual(entries[1]["name"], "test-123-2.mp4")

    @unittest.skipUnless(capabilities()["x_available"], "未安装可选 X 解析组件")
    async def test_restricted_tweet_is_reported_as_login_required(self):
        with self.assertRaisesRegex(DownloadError, "登录或年龄验证"):
            await self.resolve("x_login", "https://x.com/u/status/123")

    @unittest.skipUnless(capabilities()["youtube_available"], "未安装可选 YouTube 解析组件")
    async def test_real_youtube_library_and_separate_tracks(self):
        entries, calls = await self.resolve("youtube", "https://youtu.be/BaW_jenozKc")
        self.assertEqual([entry["variant"] for entry in entries], ["720p · MP4", "360p · MP4", "仅音频 · M4A"])
        self.assertEqual([len(entry["tracks"]) for entry in entries], [2, 1, 1])
        audio = entries[-1]
        self.assertEqual((audio["media_type"], audio["content_type"], audio["selection"].get("audio")), ("audio", "audio/mp4", "m4a"))
        self.assertTrue(audio["name"].endswith(".m4a"))
        self.assertTrue(audio["tracks"][0]["url"].endswith("audio.m4a"))
        self.assertTrue(all("youtube.com" in request.url for request in calls))

    @unittest.skipUnless(capabilities()["youtube_available"], "未安装可选 YouTube 解析组件")
    async def test_logged_youtube_keeps_hls_when_optional_clients_return_403(self):
        http = LoggedYoutubeHttp()
        entries, calls = await self.resolve("youtube", "https://youtu.be/BaW_jenozKc", cookies=http.cookies, http=http)
        self.assertEqual([entry['variant'] for entry in entries], ['720p · MP4'])
        self.assertEqual(entries[0]['tracks'][0]['protocol'], 'hls')
        players = [request for request in calls if urlsplit(request.url).path == '/youtubei/v1/player']
        self.assertTrue(any('redirected=1' in request.url for request in players))
        for request in players:
            headers = {key.lower(): value for key, value in request.headers}
            self.assertIn('LOGIN_INFO=login-private', headers['cookie'])
            self.assertIn('SAPISID=sid-private', headers['cookie'])
            self.assertTrue(headers['authorization'].startswith('SAPISIDHASH '))
        self.assertFalse(any('/videoplayback' in request.url for request in calls))
        manifests = [request for request in calls if urlsplit(request.url).hostname == 'manifest.googlevideo.com']
        self.assertTrue(manifests)
        for request in manifests:
            self.assertFalse({'cookie', 'authorization'} & {key.lower() for key, _ in request.headers})

    @unittest.skipUnless(capabilities()["youtube_available"], "未安装可选 YouTube 解析组件")
    async def test_parse_403_identifies_stage_without_logging_credentials(self):
        http = LoggedYoutubeHttp(reject=403)
        with self.assertLogs('tgdrive.offline.platforms', level='WARNING') as captured:
            with self.assertRaisesRegex(DownloadError, r'解析请求（HTTP 403，播放 API）'):
                await self.resolve('youtube', 'https://youtu.be/BaW_jenozKc', cookies=http.cookies, http=http)
        logs = '\n'.join(captured.output)
        self.assertIn('stage=extract', logs)
        self.assertIn('player_api:web_safari:cookie=1:auth=1:403', logs)
        for secret in ('login-private', 'sid-private', 'SAPISIDHASH', 'token=', 'youtube.com', 'BaW_jenozKc'):
            self.assertNotIn(secret, logs)

    @unittest.skipUnless(capabilities()["youtube_available"], "未安装可选 YouTube 解析组件")
    async def test_temporary_parse_service_failure_remains_retryable(self):
        http = LoggedYoutubeHttp(reject=503)
        with self.assertLogs('tgdrive.offline.platforms', level='WARNING'):
            with self.assertRaises(TransientError):
                await self.resolve('youtube', 'https://youtu.be/BaW_jenozKc', cookies=http.cookies, http=http)


class LoggedYoutubeHttp:
    cookies = 'LOGIN_INFO=login-private; SAPISID=sid-private; __Secure-1PAPISID=first-private; __Secure-3PAPISID=third-private'

    def __init__(self, reject=None):
        self.calls, self.reject = [], reject

    @asynccontextmanager
    async def open(self, request, **_):
        self.calls.append(request)
        parts = urlsplit(request.url)
        headers = {key.lower(): value for key, value in request.headers}
        info = {'playabilityStatus': {'status': 'OK'}, 'videoDetails': {'videoId': 'BaW_jenozKc',
            'title': 'Test video', 'lengthSeconds': '6', 'author': 'test', 'isLiveContent': False}}
        reply = None
        if parts.path == '/youtubei/v1/player':
            if self.reject or 'Safari/605' not in headers.get('user-agent', ''):
                reply = Reply(request.url, {'error': {'message': 'Forbidden token=upstream-private'}})
                reply.status = self.reject or 403
            elif 'redirected=1' not in parts.query:
                reply = Reply(request.url, b'')
                reply.status = 307
                reply.headers['location'] = '/youtubei/v1/player?redirected=1'
                reply.raw_headers = list(reply.headers.items())
            else:
                info['streamingData'] = {'hlsManifestUrl': 'https://manifest.googlevideo.com/api/manifest/hls_playlist/master.m3u8?token=signed-private'}
        elif parts.hostname == 'manifest.googlevideo.com':
            info = b'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.4d001f,mp4a.40.2"\nhttps://r1.googlevideo.com/api/manifest/hls_playlist/itag/95/index.m3u8?token=signed-private\n'
        else:
            info = ('<html><script>var ytInitialPlayerResponse = ' + json.dumps(info) + ';</script>'
                    '<script>ytcfg.set({"LOGGED_IN":true,"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB",'
                    '"clientVersion":"2.20260101"}}});</script></html>').encode()
        yield reply if reply is not None else Reply(request.url, info)


if __name__ == "__main__":
    unittest.main()
