"""各媒体信息提供者的请求参数与响应解析（样例按各接口的返回格式构造，不连接网络），以及歌词／字幕文本规范化。"""

import asyncio
import base64
import io
import json
import unittest
import zipfile
from urllib.parse import parse_qs, urlsplit

from tgdrive.media import query as media_query
from tgdrive.media import text as media_text
from tgdrive.media.providers import registry
from tgdrive.media.providers.base import MediaQuery, ProviderContext, ProviderError, score, similarity


class Http:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    async def request(self, provider, method, url, headers, body, limit):
        self.calls.append((method, url, headers, body))
        parts = urlsplit(url)
        response = self.routes.get(f"{parts.scheme}://{parts.netloc}{parts.path}")
        if response is None:
            return 404, {}, b"{}"
        status, payload = response(url, body) if callable(response) else response
        return status, {}, payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()


def provider_ctx(provider_id, routes, config=None):
    provider = registry()[provider_id]
    http = Http(routes)
    return provider, ProviderContext(provider, config or {}, http), http


def run(coroutine):
    return asyncio.run(coroutine)


def params(url):
    return {key: values[0] for key, values in parse_qs(urlsplit(url).query).items()}


AUDIO = MediaQuery("audio", name="晴天", title="晴天", artist="周杰伦", duration=269)
VIDEO = MediaQuery("video", name="Inception.2010.1080p.BluRay.x264", title="Inception", year="2010", size=1 << 30)


class LyricsProviderTests(unittest.TestCase):
    def test_netease_merges_translation(self):
        provider, ctx, http = provider_ctx("netease", {
            "https://music.163.com/api/cloudsearch/pc": (200, {"code": 200, "result": {"songs": [
                {"id": 186016, "name": "晴天", "ar": [{"name": "周杰伦"}], "al": {"name": "叶惠美", "picUrl": "https://p1.music.126.net/a.jpg"}, "dt": 269000}]}}),
            "https://music.163.com/api/song/lyric": (200, {"lrc": {"lyric": "[00:01.00]Hello\n[00:02.50]World"},
                                                          "tlyric": {"lyric": "[00:01.00]你好\n[00:02.50]世界"}}),
        })
        results = run(provider.search(AUDIO, "lyrics", ctx))
        self.assertEqual((results[0].title, results[0].duration, results[0].ref["id"]), ("晴天", 269, 186016))
        self.assertEqual(params(http.calls[0][1])["s"], "晴天 周杰伦")
        self.assertEqual(http.calls[0][2]["Referer"], "https://music.163.com/")
        fetched = run(provider.fetch(results[0].ref, "lyrics", ctx))
        self.assertEqual(fetched.text, "[00:01.00]Hello\n[00:01.00]你好\n[00:02.50]World\n[00:02.50]世界\n")
        covers = run(provider.search(AUDIO, "cover", ctx))
        self.assertEqual(covers[0].ref["url"], "https://p1.music.126.net/a.jpg?param=1200y1200")

    def test_netease_without_lyrics(self):
        provider, ctx, _ = provider_ctx("netease", {"https://music.163.com/api/song/lyric": (200, {"nolyric": True})})
        with self.assertRaises(ProviderError):
            run(provider.fetch({"id": 1}, "lyrics", ctx))

    def test_qqmusic_decodes_base64(self):
        lyric = base64.b64encode("[00:01.00]故事的小黄花&#32;\n[00:02.00]第二句".encode()).decode()
        provider, ctx, http = provider_ctx("qqmusic", {
            "https://c.y.qq.com/soso/fcgi-bin/client_search_cp": (200, {"data": {"song": {"list": [
                {"mid": "0039MnYb0qxYhV", "title": "晴天", "singer": [{"name": "周杰伦"}], "album": {"mid": "000MkMni19ClKG", "name": "叶惠美"}, "interval": 269}]}}}),
            "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg": (200, {"retcode": 0, "lyric": lyric, "trans": ""}),
        })
        results = run(provider.search(AUDIO, "lyrics", ctx))
        self.assertEqual(results[0].ref["mid"], "0039MnYb0qxYhV")
        self.assertIn("故事的小黄花 ", run(provider.fetch(results[0].ref, "lyrics", ctx)).text)
        covers = run(provider.search(AUDIO, "cover", ctx))
        self.assertEqual(covers[0].ref["url"], "https://y.gtimg.cn/music/photo_new/T002R800x800M000000MkMni19ClKG.jpg")

    def test_kugou_two_steps(self):
        provider, ctx, http = provider_ctx("kugou", {
            "https://krcs.kugou.com/search": (200, {"status": 200, "candidates": [{"id": "123", "accesskey": "ABC", "song": "晴天", "singer": "周杰伦", "duration": 269000}]}),
            "https://lyrics.kugou.com/download": (200, {"status": 200, "content": base64.b64encode("﻿[00:01.00]a\n[00:02.00]b".encode()).decode()}),
        })
        results = run(provider.search(AUDIO, "lyrics", ctx))
        self.assertEqual(params(http.calls[0][1])["duration"], "269000")
        self.assertEqual(params(http.calls[0][1])["keyword"], "周杰伦 - 晴天")
        self.assertEqual(run(provider.fetch(results[0].ref, "lyrics", ctx)).text, "[00:01.00]a\n[00:02.00]b\n")

    def test_lrclib_keyword_search_without_artist(self):
        provider, ctx, http = provider_ctx("lrclib", {"https://lrclib.net/api/search": (200, [
            {"id": 1, "trackName": "A", "artistName": "B", "instrumental": True},
            {"id": 2, "trackName": "Song", "artistName": "B", "plainLyrics": "line one\nline two"}])})
        results = run(provider.search(MediaQuery("audio", name="Song B", title="Song B"), "lyrics", ctx))
        self.assertEqual(params(http.calls[0][1]), {"q": "Song B"})
        self.assertEqual(len(results), 1)
        self.assertFalse(results[0].synced)
        self.assertEqual(results[0].preview, "line one\nline two")


class CoverProviderTests(unittest.TestCase):
    def test_itunes_sizes_and_country(self):
        provider, ctx, http = provider_ctx("itunes", {"https://itunes.apple.com/search": (200, {"results": [
            {"trackName": "晴天", "artistName": "周杰伦", "collectionName": "叶惠美", "artworkUrl100": "https://is1-ssl.mzstatic.com/x/100x100bb.jpg"},
            {"trackName": "晴天", "artistName": "周杰伦", "collectionName": "叶惠美", "artworkUrl100": "https://is1-ssl.mzstatic.com/x/100x100bb.jpg"}]})},
            {"country": "hk"})
        results = run(provider.search(AUDIO, "cover", ctx))
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].ref["url"], "https://is1-ssl.mzstatic.com/x/1200x1200bb.jpg")
        self.assertEqual(params(http.calls[0][1])["country"], "HK")

    def test_musicbrainz_uses_release_id_from_tags(self):
        provider, ctx, http = provider_ctx("musicbrainz", {})
        query = MediaQuery("audio", title="Yesterday", extra={"musicbrainz_release": "abcd-1234"})
        results = run(provider.search(query, "cover", ctx))
        self.assertTrue(results[0].hash_match)
        self.assertEqual(results[0].ref["url"], "https://coverartarchive.org/release/abcd-1234/front-1200")
        self.assertEqual(http.calls, [])

    def test_musicbrainz_search_groups_by_release_group(self):
        provider, ctx, http = provider_ctx("musicbrainz", {"https://musicbrainz.org/ws/2/recording": (200, {"recordings": [
            {"title": "Yesterday", "length": 125000, "artist-credit": [{"name": "The Beatles"}], "releases": [
                {"title": "Help!", "date": "1965", "release-group": {"id": "rg1"}}, {"title": "Help! (remaster)", "release-group": {"id": "rg1"}},
                {"title": "1", "date": "2000", "release-group": {"id": "rg2"}}]}]})})
        results = run(provider.search(MediaQuery("audio", title="Yesterday", artist="The Beatles"), "cover", ctx))
        self.assertEqual([item.ref["url"].split("/")[-2] for item in results], ["rg1", "rg2"])
        self.assertIn('artist:"The Beatles"', params(http.calls[0][1])["query"])

    def test_tmdb_episode_still_and_auth(self):
        provider, ctx, http = provider_ctx("tmdb", {
            "https://api.themoviedb.org/3/search/tv": (200, {"results": [{"id": 1399, "name": "权力的游戏", "first_air_date": "2011-04-17",
                                                                         "poster_path": "/p.jpg", "backdrop_path": "/b.jpg"}]}),
            "https://api.themoviedb.org/3/tv/1399/season/1/episode/2": (200, {"name": "国王大道", "still_path": "/s.jpg"}),
        }, {"token": "eyJhbGciOiJIUzI1NiJ9.long-token"})
        query = MediaQuery("video", name="Game.of.Thrones.S01E02", title="Game of Thrones", season=1, episode=2)
        results = run(provider.search(query, "cover", ctx))
        self.assertEqual([item.ref["url"] for item in results], ["https://image.tmdb.org/t/p/w1280/s.jpg", "https://image.tmdb.org/t/p/w780/p.jpg",
                                                                 "https://image.tmdb.org/t/p/w1280/b.jpg"])
        self.assertEqual(http.calls[0][2]["Authorization"], "Bearer eyJhbGciOiJIUzI1NiJ9.long-token")
        _, ctx, http = provider_ctx("tmdb", {"https://api.themoviedb.org/3/search/movie": (200, {"results": []}),
                                             "https://api.themoviedb.org/3/search/tv": (200, {"results": []})}, {"token": "0123456789abcdef0123456789abcdef"})
        run(provider.search(VIDEO, "cover", ctx))
        self.assertEqual(params(http.calls[0][1])["api_key"], "0123456789abcdef0123456789abcdef")
        _, ctx, _ = provider_ctx("tmdb", {"https://api.themoviedb.org/3/search/movie": (401, {"success": False, "status_code": 7})}, {"token": "bad"})
        with self.assertRaises(ProviderError) as caught:
            run(provider.search(VIDEO, "cover", ctx))
        self.assertIn("令牌", str(caught.exception))


class SubtitleProviderTests(unittest.TestCase):
    def test_opensubtitles_hash_login_and_download(self):
        def download(url, body):
            self.assertEqual(json.loads(body), {"file_id": 99})
            return 200, {"link": "https://dl.opensubtitles.org/file/99", "remaining": 4}
        provider, ctx, http = provider_ctx("opensubtitles", {
            "https://api.opensubtitles.com/api/v1/subtitles": (200, {"data": [{"attributes": {
                "language": "zh-cn", "release": "Inception.2010.1080p.BluRay.x264", "download_count": 1200, "moviehash_match": True,
                "files": [{"file_id": 99, "file_name": "Inception.srt"}], "feature_details": {"title": "Inception", "year": 2010}}}]}),
            "https://api.opensubtitles.com/api/v1/login": (200, {"token": "jwt", "base_url": "vip-api.opensubtitles.com"}),
            "https://vip-api.opensubtitles.com/api/v1/download": download,
            "https://dl.opensubtitles.org/file/99": (200, "1\n00:00:01,000 --> 00:00:02,000\n你好\n".encode("gb18030")),
        }, {"api_key": "key", "username": "u", "password": "p"})
        query = MediaQuery("video", name=VIDEO.name, title="Inception", year="2010", moviehash="8e245d9679d31e12")
        results = run(provider.search(query, "subtitle", ctx))
        sent = params(http.calls[0][1])
        self.assertEqual(sent["moviehash"], "8e245d9679d31e12")
        self.assertEqual(list(sent), sorted(sent))
        self.assertEqual(sent["query"], "inception")
        self.assertTrue(results[0].hash_match)
        self.assertEqual(http.calls[0][2]["Api-Key"], "key")
        fetched = run(provider.fetch(results[0].ref, "subtitle", ctx))
        self.assertEqual((fetched.format, fetched.text), ("srt", "1\n00:00:01,000 --> 00:00:02,000\n你好\n"))
        download_call = next(call for call in http.calls if call[1].endswith("/download"))
        self.assertEqual(download_call[2]["Authorization"], "Bearer jwt")

    def test_assrt_picks_simplified_file_from_archive(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as handle:
            handle.writestr("Inception.cht.srt", "1\n00:00:01,000 --> 00:00:02,000\n繁體\n")
            handle.writestr("Inception.chs.ass", "[Script Info]\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                                                 "Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\an8}你好\\N世界\n")
        provider, ctx, http = provider_ctx("assrt", {
            "https://api.assrt.net/v1/sub/search": (200, {"status": 0, "sub": {"subs": [{"id": 5, "native_name": "盗梦空间", "videoname": "Inception.2010",
                                                                                        "lang": {"desc": "简体", "langlist": {"langchs": True}}}]}}),
            "https://api.assrt.net/v1/sub/detail": (200, {"status": 0, "sub": {"subs": [{"url": "https://file.assrt.net/5.zip", "filename": "5.zip"}]}}),
            "https://file.assrt.net/5.zip": (200, archive.getvalue()),
        }, {"token": "t"})
        results = run(provider.search(VIDEO, "subtitle", ctx))
        self.assertEqual((results[0].title, results[0].language), ("盗梦空间", "zh-CN"))
        self.assertEqual(params(http.calls[0][1])["is_file"], "1")
        fetched = run(provider.fetch(results[0].ref, "subtitle", ctx))
        self.assertEqual(fetched.name, "Inception.chs.ass")
        self.assertEqual(fetched.text, "1\n00:00:01,500 --> 00:00:03,000\n你好\n世界\n")

    def test_assrt_token_error(self):
        provider, ctx, _ = provider_ctx("assrt", {"https://api.assrt.net/v1/sub/search": (200, {"status": 101})}, {"token": "t"})
        with self.assertRaises(ProviderError) as caught:
            run(provider.search(VIDEO, "subtitle", ctx))
        self.assertIn("Token", str(caught.exception))


class TextTests(unittest.TestCase):
    def test_decode_and_detect(self):
        self.assertEqual(media_text.decode("中文".encode("gb18030")), "中文")
        self.assertEqual(media_text.decode("﻿a".encode("utf-8")), "a")
        self.assertEqual(media_text.decode("字幕".encode("utf-16")), "字幕")
        self.assertEqual(media_text.detect("WEBVTT\n\n00:01.000 --> 00:02.000\nx"), "vtt")
        self.assertEqual(media_text.detect("1\n00:00:01,000 --> 00:00:02,000\nx"), "srt")
        self.assertEqual(media_text.detect("[00:01.00]a\n[00:02.00]b"), "lrc")
        self.assertIsNone(media_text.detect("just text"))

    def test_rejects_rar_and_unknown(self):
        with self.assertRaises(ProviderError):
            media_text.normalize_subtitle(b"Rar!\x1a\x07\x00rest")
        with self.assertRaises(ProviderError):
            media_text.normalize_subtitle(b"<html>login</html>")

    def test_preview_skips_metadata(self):
        self.assertEqual(media_text.preview("[ti:晴天]\n[ar:周杰伦]\n[00:01.00]第一句\n[00:02.00]第二句", 1), "第一句")


class QueryTests(unittest.TestCase):
    def test_video_names(self):
        self.assertEqual(media_query.video_from_name("Inception.2010.1080p.BluRay.x264-SPARKS.mkv"), ("Inception", "2010", None, None))
        self.assertEqual(media_query.video_from_name("[字幕组] Game.of.Thrones.S01E02.720p.mkv"), ("Game of Thrones", "", 1, 2))
        self.assertEqual(media_query.video_from_name("1917.2019.2160p.mkv"), ("1917", "2019", None, None))
        self.assertEqual(media_query.video_from_name("流浪地球 第03集.mp4")[3], 3)

    def test_audio_names_and_tags(self):
        self.assertEqual(media_query.audio_from_name("03. 晴天 - 周杰伦.flac"), ("晴天", "周杰伦"))
        query = media_query.build("audio", "a/03. 晴天 - 周杰伦.flac", 10, {"title": "晴天", "artist": "Jay Chou", "duration": 269.5})
        self.assertEqual((query.title, query.artist, query.duration), ("晴天", "Jay Chou", 269.5))
        query = media_query.build("audio", "a/x.mp3", 10, {}, {"title": "  新歌名 ", "season": "bad", "languages": ["en", "../x"]})
        self.assertEqual((query.title, query.languages), ("新歌名", ("en",)))

    def test_score(self):
        query = MediaQuery("audio", title="晴天", artist="周杰伦", duration=269)
        from tgdrive.media.providers.base import Candidate
        exact = Candidate("lyrics", "晴天", {}, duration=270)
        other = Candidate("lyrics", "晴天 (Live)", {}, duration=300)
        self.assertGreater(score(query, exact, artist="周杰伦"), score(query, other, artist="其他"))
        self.assertEqual(similarity("Ｈｅｌｌｏ， World", "hello world"), 1.0)


class RegistryTests(unittest.TestCase):
    def test_descriptions_are_complete(self):
        for provider in registry().values():
            described = provider.describe()
            self.assertTrue(described["name"] and described["description"], provider.id)
            self.assertTrue(described["capabilities"] and described["media"], provider.id)
            if any(field["required"] for field in described["fields"]):
                self.assertTrue(described["guide"], provider.id)
            if not provider.official:
                self.assertTrue(provider.notice, provider.id)


if __name__ == "__main__":
    unittest.main()
