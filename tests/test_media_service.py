"""媒体元数据服务：文件信息记录、提供者配置与密钥加密、在线查找候选的令牌绑定、歌词／字幕保存与私密空间授权。
第三方接口一律用替身，不连接真实网络。"""

import asyncio
import json
import struct
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote, urlsplit

from tgdrive.app import create_app
from tgdrive.media.providers.base import ProviderError
from tgdrive.objects import PRIVATE_PREFIX, Scope
from tests.test_media_tags import id3, mpeg_frames
from tests.test_public_links import Client


class FakeHttp:
    """按「主机 + 路径」返回预置响应，记录所有请求。"""

    def __init__(self):
        self.routes: dict[str, object] = {}
        self.calls: list[tuple[str, str, str, dict, bytes | None]] = []

    def add(self, url: str, response):
        self.routes[url] = response

    async def request(self, provider, method, url, headers, body, limit):
        self.calls.append((provider.id, method, url, headers, body))
        parts = urlsplit(url)
        key = f"{parts.scheme}://{parts.netloc}{parts.path}"
        response = self.routes.get(key)
        if response is None:
            return 404, {}, b"{}"
        if isinstance(response, Exception):
            raise response
        if callable(response):
            response = response(url, body)
        status, payload = response
        data = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        return status, {"content-type": "application/json"}, data


def song(title="晴天", artist="周杰伦", lyrics="[00:01.00]故事的小黄花\n[00:03.00]从出生那年就飘着"):
    return id3([("TIT2", b"\x03" + title.encode()), ("TPE1", b"\x03" + artist.encode()),
                ("USLT", b"\x03chi\x00" + lyrics.encode())]) + mpeg_frames(20)


class MediaServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.bob = self.app.accounts.create_user("bob@example.com", "bob password")
        self.scope = Scope(self.alice.bucket_id)
        self.client = Client(self.app)
        self.http = FakeHttp()
        self.app.media.http = self.http
        self.auth = self.wait(self.client.login("user", "alice@example.com", "alice password"))
        self.admin = self.wait(self.client.login("admin", "admin@example.com", "admin password"))

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def wait(self, coroutine):
        return asyncio.run(coroutine)

    def call(self, method, path, body=None, auth=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        status, headers, raw = self.wait(self.client.request(method, path, data, auth if auth is not None else self.auth))
        try:
            return status, json.loads(raw), headers
        except ValueError:
            return status, raw, headers

    def put(self, key, data, content_type="audio/mpeg"):
        return self.wait(self.app.objects.put_object(self.scope, key, data, len(data), content_type))

    def enable(self, **providers):
        status, body, _ = self.call("POST", "/api/admin/v1/media/providers",
                                    {"providers": {key: {"enabled": value} for key, value in providers.items()}}, self.admin)
        self.assertEqual(status, 200, body)
        return body

    # ---------- 文件元数据 ----------

    def test_info_records_tags_per_content_and_serves_embedded_lyrics(self):
        info = self.put("音乐/晴天.mp3", song())
        status, body, _ = self.call("GET", "/api/user/v1/media/info?path=" + quote("音乐/晴天.mp3"))
        self.assertEqual(status, 200, body)
        # 首次解析只记字段，不把内置歌词另存为资源；没有保存的歌词时给出内置歌词作为回退。
        self.assertEqual((body["kind"], body["title"], body["artist"], body["lyrics"], body["embedded_lyrics"]["synced"]), ("audio", "晴天", "周杰伦", None, True))
        self.assertGreater(body["duration"], 0)
        self.assertEqual(body["providers"]["lyrics"], [{"id": "lrclib", "name": "LRCLIB"}])
        row = self.app.metadata.db.execute("SELECT title, lyrics FROM media_info WHERE blob_uuid=?", (info.blob_uuid,)).fetchone()
        self.assertEqual((row["title"], row["lyrics"]), ("晴天", 2))
        status, text, headers = self.call("GET", f"/api/user/v1/media/lyrics?path={quote('音乐/晴天.mp3')}&etag={info.etag}")
        self.assertEqual(status, 200)
        self.assertIn("故事的小黄花", text.decode())
        self.assertEqual(headers["cache-control"], "no-store")
        status, _, _ = self.call("GET", f"/api/user/v1/media/lyrics?path={quote('音乐/晴天.mp3')}&etag=stale")
        self.assertEqual(status, 400)
        # 只有音视频有媒体信息；别人的文件读不到。
        self.put("文档/a.txt", b"hello", "text/plain")
        self.assertEqual(self.call("GET", "/api/user/v1/media/info?path=" + quote("文档/a.txt"))[0], 400)
        bob = self.wait(self.client.login("user", "bob@example.com", "bob password"))
        self.assertEqual(self.call("GET", "/api/user/v1/media/info?path=" + quote("音乐/晴天.mp3"), auth=bob)[0], 404)

    def test_disabling_lookup_provider_keeps_initialized_metadata(self):
        self.put("音乐/晴天.mp3", song())
        self.enable(embedded=False)
        status, body, _ = self.call("GET", "/api/user/v1/media/info?path=" + quote("音乐/晴天.mp3"))
        self.assertEqual(status, 200)
        self.assertEqual((body["title"], body["embedded_lyrics"]["synced"], body["embedded"]), ("晴天", True, True))
        # 关闭在线「内置数据」来源不影响播放回退读取文件自带的歌词。
        info = self.app.objects.head_object(self.scope, "音乐/晴天.mp3")
        status, text, _ = self.call("GET", f"/api/user/v1/media/lyrics?path={quote('音乐/晴天.mp3')}&etag={info.etag}")
        self.assertEqual(status, 200)
        self.assertIn("故事的小黄花", text.decode())

    # ---------- 配置 ----------

    def test_provider_settings_require_admin_and_encrypt_secrets(self):
        self.assertEqual(self.call("GET", "/api/admin/v1/media/providers", auth=self.auth)[0], 403)
        status, body, _ = self.call("POST", "/api/admin/v1/media/providers", {"providers": {"tmdb": {"enabled": True}}}, self.admin)
        self.assertEqual(status, 400)
        self.assertIn("API 读访问令牌", body["error"]["message"])
        body = self.enable()
        status, body, _ = self.call("POST", "/api/admin/v1/media/providers",
                                    {"providers": {"tmdb": {"enabled": True, "config": {"token": "secret-token-value", "language": "zh-TW"}}}}, self.admin)
        self.assertEqual(status, 200, body)
        tmdb = next(item for item in body["providers"] if item["id"] == "tmdb")
        self.assertEqual((tmdb["enabled"], tmdb["secrets"], tmdb["config"], tmdb["missing"]), (True, {"token": True}, {"language": "zh-TW"}, []))
        self.assertNotIn("secret-token-value", json.dumps(body))
        stored = self.app.metadata.db.execute("SELECT value FROM settings WHERE key='media.secret.tmdb.token'").fetchone()["value"]
        self.assertNotIn("secret-token-value", stored)
        self.app.keystore.rotate("encryption passphrase", "another encryption passphrase")
        self.assertEqual(self.app.media.config_of(self.app.media.providers["tmdb"])["token"], "secret-token-value")
        audit = self.app.metadata.db.execute("SELECT detail FROM audit_log WHERE action='media.providers.update' ORDER BY id DESC LIMIT 1").fetchone()
        self.assertNotIn("secret-token-value", audit["detail"])
        # 清除必填密钥时不能保持启用。
        status, body, _ = self.call("POST", "/api/admin/v1/media/providers", {"providers": {"tmdb": {"clear": ["token"]}}}, self.admin)
        self.assertEqual(status, 400)
        status, body, _ = self.call("POST", "/api/admin/v1/media/providers", {"providers": {"tmdb": {"enabled": False, "clear": ["token"]}}}, self.admin)
        self.assertEqual(status, 200)
        self.assertEqual(next(item for item in body["providers"] if item["id"] == "tmdb")["secrets"], {"token": False})

    def test_provider_test_reports_errors_without_raising(self):
        self.http.add("https://lrclib.net/api/search", (200, []))
        status, body, _ = self.call("POST", "/api/admin/v1/media/providers/lrclib/test", {}, self.admin)
        self.assertEqual((status, body["ok"]), (200, True))
        self.http.add("https://lrclib.net/api/search", ProviderError("连接 lrclib.net 超时"))
        status, body, _ = self.call("POST", "/api/admin/v1/media/providers/lrclib/test", {}, self.admin)
        self.assertEqual((status, body), (200, {"ok": False, "message": "连接 lrclib.net 超时"}))
        status, body, _ = self.call("POST", "/api/admin/v1/media/providers/tmdb/test", {}, self.admin)
        self.assertFalse(body["ok"])

    # ---------- 查找、读取与保存 ----------

    def lrclib(self):
        self.http.add("https://lrclib.net/api/search", (200, [
            {"id": 7, "trackName": "晴天", "artistName": "周杰伦", "albumName": "叶惠美", "duration": 269.0,
             "syncedLyrics": "[00:29.00]故事的小黄花\n[00:32.00]从出生那年就飘着", "plainLyrics": "故事的小黄花"},
            {"id": 8, "trackName": "晴天 (Live)", "artistName": "其他人", "duration": 100.0, "plainLyrics": "别的歌词"},
        ]))

    def test_lookup_save_and_conflict(self):
        self.lrclib()
        self.http.add("https://music.163.com/api/cloudsearch/pc", ProviderError("接口暂时不可用（HTTP 503）"))
        self.enable(netease=True)
        self.put("音乐/晴天.mp3", id3([("TIT2", b"\x03\xe6\x99\xb4\xe5\xa4\xa9"), ("TPE1", "周杰伦".encode("utf-16").join((b"\x01", b"")))]) + mpeg_frames(20))
        status, body, _ = self.call("POST", "/api/user/v1/media/lookup", {"path": "音乐/晴天.mp3", "want": "lyrics"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["query"]["title"], "晴天")
        statuses = {item["id"]: item for item in body["providers"]}
        self.assertEqual(statuses["lrclib"]["count"], 2)
        self.assertEqual(statuses["netease"]["error"], "接口暂时不可用（HTTP 503）")
        first = body["candidates"][0]
        self.assertEqual((first["provider"], first["title"], first["synced"]), ("lrclib", "晴天", True))
        self.assertGreater(first["score"], body["candidates"][1]["score"])
        self.assertNotIn("text", first)
        # 发出的查询只含歌名与歌手。
        sent = next(url for provider, _, url, _, _ in self.http.calls if provider == "lrclib")
        self.assertIn("track_name=", sent)
        self.assertIn("artist_name=", sent)

        status, fetched, _ = self.call("POST", "/api/user/v1/media/fetch", {"path": "音乐/晴天.mp3", "token": first["token"]})
        self.assertEqual((status, fetched["format"]), (200, "lrc"))
        status, saved, _ = self.call("POST", "/api/user/v1/media/save", {"path": "音乐/晴天.mp3", "token": first["token"], "overwrite": True})
        self.assertEqual(status, 201, saved)
        self.assertTrue(saved["path"].startswith("metadata:"))
        self.assertFalse(saved["replaced"])
        status, assets, _ = self.call("GET", "/api/user/v1/preview-assets?path=" + quote("音乐/晴天.mp3"))
        self.assertEqual([item["kind"] for item in assets], ["lyrics"])
        status, body, _ = self.call("POST", "/api/user/v1/media/save", {"path": "音乐/晴天.mp3", "token": first["token"]})
        self.assertEqual((status, body["error"]["code"]), (409, "asset_exists"))
        status, saved, _ = self.call("POST", "/api/user/v1/media/save", {"path": "音乐/晴天.mp3", "token": first["token"], "overwrite": True})
        self.assertEqual((status, saved["replaced"]), (201, True))
        audit = self.app.metadata.db.execute("SELECT detail FROM audit_log WHERE action='media.save' ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(json.loads(audit["detail"]), {"provider": "lrclib", "format": "lrc", "replaced": True})
        status, body, _ = self.call("POST", "/api/user/v1/media/save", {"path": "音乐/晴天.mp3", "token": first["token"], "language": "../x"})
        self.assertEqual(status, 400)

    def test_tokens_are_bound_to_owner_and_version(self):
        self.lrclib()
        self.put("音乐/晴天.mp3", song())
        status, body, _ = self.call("POST", "/api/user/v1/media/lookup", {"path": "音乐/晴天.mp3", "want": "lyrics"})
        token = next(item["token"] for item in body["candidates"] if item["provider"] == "lrclib")
        bob_scope = Scope(self.bob.bucket_id)
        self.wait(self.app.objects.put_object(bob_scope, "音乐/晴天.mp3", song(), len(song()), "audio/mpeg"))
        bob = self.wait(self.client.login("user", "bob@example.com", "bob password"))
        status, body, _ = self.call("POST", "/api/user/v1/media/save", {"path": "音乐/晴天.mp3", "token": token}, bob)
        self.assertEqual(status, 400)
        self.put("音乐/晴天.mp3", song(title="晴天（新版）"))
        status, body, _ = self.call("POST", "/api/user/v1/media/save", {"path": "音乐/晴天.mp3", "token": token})
        self.assertEqual(status, 400)
        self.assertIn("文件已变化", body["error"]["message"])
        status, body, _ = self.call("POST", "/api/user/v1/media/fetch", {"path": "音乐/晴天.mp3", "token": "made-up"})
        self.assertEqual(status, 400)

    def test_cover_candidates_and_preview_via_server(self):
        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
        self.http.add("https://itunes.apple.com/search", (200, {"results": [
            {"trackName": "晴天", "artistName": "周杰伦", "collectionName": "叶惠美", "releaseDate": "2003-07-31T07:00:00Z",
             "artworkUrl100": "https://is1.mzstatic.com/image/thumb/a/100x100bb.jpg", "trackTimeMillis": 269000}]}))
        self.http.add("https://is1.mzstatic.com/image/thumb/a/240x240bb.jpg", (200, png))
        self.http.add("https://is1.mzstatic.com/image/thumb/a/1200x1200bb.jpg", (200, b"not an image"))
        self.enable(musicbrainz=False)
        self.put("音乐/晴天.mp3", song())
        status, body, _ = self.call("POST", "/api/user/v1/media/lookup", {"path": "音乐/晴天.mp3", "want": "cover"})
        self.assertEqual(status, 200, body)
        candidate = next(item for item in body["candidates"] if item["provider"] == "itunes")
        self.assertTrue(candidate["has_preview_image"])
        status, data, headers = self.call("GET", f"/api/user/v1/media/preview?path={quote('音乐/晴天.mp3')}&token={candidate['token']}")
        self.assertEqual((status, headers["content-type"]), (200, "image/png"))
        self.assertEqual(data, png)
        status, body, _ = self.call("POST", "/api/user/v1/media/fetch", {"path": "音乐/晴天.mp3", "token": candidate["token"]})
        self.assertEqual(status, 400)
        self.assertIn("不是受支持的图片", body["error"]["message"])
        status, body, _ = self.call("POST", "/api/user/v1/media/save", {"path": "音乐/晴天.mp3", "token": candidate["token"]})
        self.assertEqual(status, 400)

    def test_video_cover_filters_unrelated_results(self):
        self.http.add("https://movie.douban.com/j/subject_suggest", (200, [
            {"title": "盗梦空间", "sub_title": "Inception", "year": "2010", "type": "movie", "img": "https://img9.doubanio.com/view/photo/s_ratio_poster/public/a.jpg"},
            {"title": "完全无关的片子", "sub_title": "", "year": "1999", "type": "movie", "img": "https://img9.doubanio.com/view/photo/s_ratio_poster/public/b.jpg"}]))
        data = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64
        self.put("视频/盗梦空间.Inception.2010.1080p.mp4", data, "video/mp4")
        status, body, _ = self.call("POST", "/api/user/v1/media/lookup", {"path": "视频/盗梦空间.Inception.2010.1080p.mp4", "want": "cover", "providers": ["douban"]})
        self.assertEqual(status, 200, body)
        self.assertEqual([item["title"] for item in body["candidates"]], ["盗梦空间"])
        self.assertEqual(body["providers"], [{"id": "douban", "name": "豆瓣电影", "official": False, "count": 1, "error": None}])

    def test_embedded_cover_endpoint(self):
        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40
        picture = b"\x00image/png\x00\x03\x00" + png
        info = self.put("音乐/有封面.mp3", id3([("APIC", picture), ("TIT2", b"\x03Song")]) + mpeg_frames(4))
        status, data, headers = self.call("GET", f"/api/user/v1/media/cover?path={quote('音乐/有封面.mp3')}&etag={info.etag}")
        self.assertEqual((status, headers["content-type"], data), (200, "image/png", png))
        info = self.put("音乐/无封面.mp3", song())
        self.assertEqual(self.call("GET", f"/api/user/v1/media/cover?path={quote('音乐/无封面.mp3')}&etag={info.etag}")[0], 404)

    def test_commit_records_metadata_in_background(self):
        async def scenario():
            self.app.media.COMMIT_DELAY = 0
            self.app.media.start()
            data = song(title="后台记录")
            info = await self.app.objects.put_object(self.scope, "音乐/后台.mp3", data, len(data), "audio/mpeg")
            for _ in range(50):
                row = self.app.metadata.db.execute("SELECT title FROM media_info WHERE blob_uuid=?", (info.blob_uuid,)).fetchone()
                if row:
                    break
                await asyncio.sleep(0.02)
            await self.app.media.stop()
            return row
        row = self.wait(scenario())
        self.assertEqual(row["title"], "后台记录")

    def test_lookup_rate_limit(self):
        self.lrclib()
        self.put("音乐/晴天.mp3", song())
        self.app.media.LOOKUP_PER_MINUTE = 2
        for _ in range(2):
            self.assertEqual(self.call("POST", "/api/user/v1/media/lookup", {"path": "音乐/晴天.mp3", "want": "lyrics"})[0], 200)
        status, body, _ = self.call("POST", "/api/user/v1/media/lookup", {"path": "音乐/晴天.mp3", "want": "lyrics"})
        self.assertEqual(status, 400)
        self.assertIn("太频繁", body["error"]["message"])

    def test_subtitle_needs_video(self):
        self.put("音乐/晴天.mp3", song())
        status, _, _ = self.call("POST", "/api/user/v1/media/lookup", {"path": "音乐/晴天.mp3", "want": "subtitle"})
        self.assertEqual(status, 400)

    # ---------- 私密空间 ----------

    def test_private_space_requires_unlock(self):
        self.lrclib()
        data = song()
        self.wait(self.app.objects.put_object(Scope(self.alice.bucket_id, private_access=True), PRIVATE_PREFIX + "音乐/晴天.mp3", data, len(data), "audio/mpeg"))
        path = quote(PRIVATE_PREFIX + "音乐/晴天.mp3")
        status, body, _ = self.call("GET", f"/api/user/v1/private/media/info?path={path}")
        self.assertIn(status, (403, 423), body)
        status, body, _ = self.call("POST", "/api/user/v1/private/unlock", {"password": "alice password"})
        self.assertEqual(status, 200, body)
        self.auth = {**self.auth, "x-private-access": body["access"]}
        status, body, _ = self.call("GET", f"/api/user/v1/private/media/info?path={path}")
        self.assertEqual((status, body["title"]), (200, "晴天"))
        status, body, _ = self.call("POST", "/api/user/v1/private/media/lookup", {"path": PRIVATE_PREFIX + "音乐/晴天.mp3", "want": "lyrics"})
        self.assertEqual(status, 200, body)
        token = next(item["token"] for item in body["candidates"] if item["provider"] == "lrclib")
        status, saved, _ = self.call("POST", "/api/user/v1/private/media/save", {"path": PRIVATE_PREFIX + "音乐/晴天.mp3", "token": token, "overwrite": True})
        self.assertEqual(status, 201, saved)
        self.assertTrue(saved["path"].startswith("metadata:"))
        # 普通接口不能访问私密文件。
        self.assertNotEqual(self.call("GET", f"/api/user/v1/media/info?path={path}")[0], 200)


class MovieHashTests(unittest.TestCase):
    def test_matches_reference_algorithm(self):
        from tgdrive.media.service import FileAccess, MediaService
        data = bytes(range(256)) * 1024
        chunk = 65536

        class Info:
            size = len(data)

        class File:
            info = Info()

            async def read(self, start, end):
                return data[start:end]

        expected = len(data)
        for part in (data[:chunk], data[-chunk:]):
            expected += sum(struct.unpack(f"<{chunk // 8}Q", part))
        value = asyncio.run(MediaService._moviehash(None, File()))
        self.assertEqual(value, f"{expected & 0xFFFFFFFFFFFFFFFF:016x}")
        self.assertTrue(FileAccess)


if __name__ == "__main__":
    unittest.main()


class BestCoverTests(unittest.IsolatedAsyncioTestCase):
    """文件助手生成封面时的在线查找：只用替身，不访问网络或数据库。"""

    async def test_takes_first_matching_candidate_and_skips_weak_ones(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        from tgdrive.media.service import MediaService
        service = MediaService.__new__(MediaService)
        info = SimpleNamespace(key="a.mp3", etag="e")
        good, weak = (SimpleNamespace(provider="itunes", ref={}, score=score, hash_match=False) for score in (0.8, 0.3))
        service.collect = AsyncMock(return_value=(info, None, [good, weak], []))
        service._fetch = AsyncMock(side_effect=[ValueError("坏图"), SimpleNamespace(data=b"jpeg")])
        scope = SimpleNamespace(bucket_id=1)
        self.assertIsNone(await service.best_cover(scope, "a.mp3"), "第一张读取失败、其余匹配度不足时不采用")
        self.assertEqual(service.collect.await_args.kwargs, {"skip": ("embedded",), "throttle": False})
        service.collect = AsyncMock(return_value=(info, None, [good], []))
        self.assertEqual(await service.best_cover(scope, "a.mp3"), b"jpeg")
