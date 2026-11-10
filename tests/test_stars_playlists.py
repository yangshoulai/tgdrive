"""文件星标（POST /star、GET /starred）与音乐歌单（/playlists）。"""
import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import quote

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.objects import Scope

MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 64


class StarPlaylistTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.bob = self.app.accounts.create_user("bob@example.com", "bob password")
        self.scope = Scope(self.alice.bucket_id)
        self.client = Client(self.app)
        self.session = asyncio.run(self.client.login("user", "alice@example.com", "alice password"))
        self.bob_session = asyncio.run(self.client.login("user", "bob@example.com", "bob password"))

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def put(self, key, data=MP3, content_type="audio/mpeg"):
        asyncio.run(self.app.objects.put_object(self.scope, key, data, len(data), content_type))

    def call(self, method, path, body=None, *, session=None, expect=200):
        payload = b"" if body is None else json.dumps(body).encode()
        status, _, data = asyncio.run(self.client.request(method, "/api/user/v1" + path, payload, headers=session or self.session))
        self.assertEqual(status, expect, data)
        return json.loads(data) if data else None

    def starred(self, extra=""):
        keys, cursor = [], ""
        while True:
            body = self.call("GET", f"/starred?limit=1&cursor={quote(cursor)}{extra}")
            keys += [item["key"] for item in body["objects"]]
            if not body["next_cursor"]:
                return keys
            cursor = body["next_cursor"]

    def test_stars_follow_moves_trash_and_overwrite(self):
        self.put("a/one.txt", b"one", "text/plain")
        self.put("a/two.txt", b"two", "text/plain")
        self.put("b/song.mp3")
        self.assertEqual(self.call("POST", "/star", {"paths": ["a/one.txt", "b/song.mp3"]})["changed"], 2)
        self.assertEqual(self.call("POST", "/star", {"paths": ["a/two.txt"]})["changed"], 1)
        self.assertEqual(self.call("POST", "/star", {"paths": ["a/two.txt"]})["changed"], 0, "已有星标时不重复改动")
        self.assertEqual(self.starred(), ["a/two.txt", "b/song.mp3", "a/one.txt"], "最近加星标的在前，翻页不重复")
        self.assertEqual(self.starred("&kind=audio"), ["b/song.mp3"])
        self.assertEqual(self.starred("&q=one"), ["a/one.txt"])
        listing = self.call("GET", "/list?prefix=a/")
        self.assertTrue(next(item for item in listing["objects"] if item["key"] == "a/one.txt").get("starred_at"))
        self.app.objects.move(self.scope, "a/", "c/")
        self.put("c/one.txt", b"changed", "text/plain")
        self.assertIn("c/one.txt", self.starred(), "移动与覆盖写入保留星标")
        entry = asyncio.run(self.app.objects.trash(self.scope, ["c/one.txt"]))[0]
        self.assertNotIn("c/one.txt", self.starred(), "回收站里的文件不在星标视图")
        self.app.objects.restore(self.scope, [entry["id"]])
        self.assertIn("c/one.txt", self.starred(), "还原后星标仍在")
        asyncio.run(self.app.objects.copy_object(self.scope, "c/one.txt", self.scope, "copy.txt"))
        self.assertNotIn("copy.txt", self.starred(), "复制的文件不继承星标")
        self.call("POST", "/star", {"paths": ["c/one.txt"], "starred": False})
        self.assertNotIn("c/one.txt", self.starred())
        self.call("POST", "/star", {"paths": ["c/"]}, expect=400)
        self.call("POST", "/star", {"paths": ["missing.txt"]}, expect=404)
        self.assertEqual(self.call("GET", "/starred", session=self.bob_session)["objects"], [], "星标按账号隔离")

    def test_playlists_keep_order_and_follow_files(self):
        for name in ("1.mp3", "2.mp3", "3.mp3"):
            self.put("music/" + name)
        self.put("notes.txt", b"x", "text/plain")
        created = self.call("POST", "/playlists", {"name": "  通勤  ", "paths": ["music/1.mp3", "music/2.mp3"]}, expect=201)
        self.assertEqual(created["name"], "通勤")
        playlist = f"/playlists/{created['id']}"
        self.assertEqual(self.call("POST", playlist, {"add": ["music/3.mp3", "music/1.mp3"]})["added"], 1, "已在歌单里的歌曲不重复添加")
        self.call("POST", playlist, {"add": ["notes.txt"]}, expect=400)
        self.call("POST", playlist, {"move": {"path": "music/3.mp3", "before": "music/1.mp3"}})
        keys = lambda: [item["key"] for item in self.call("GET", playlist)["objects"]]
        self.assertEqual(keys(), ["music/3.mp3", "music/1.mp3", "music/2.mp3"])
        self.app.objects.move(self.scope, "music/", "songs/")
        self.assertEqual(keys(), ["songs/3.mp3", "songs/1.mp3", "songs/2.mp3"], "移动文件夹后歌单跟着走")
        entry = asyncio.run(self.app.objects.trash(self.scope, ["songs/1.mp3"]))[0]
        self.assertEqual(keys(), ["songs/3.mp3", "songs/2.mp3"], "回收站里的歌曲不列出")
        listed = self.call("GET", "/playlists")["playlists"]
        self.assertEqual((listed[0]["count"], len(listed[0]["samples"])), (2, 2))
        self.app.objects.restore(self.scope, [entry["id"]])
        self.assertEqual(keys(), ["songs/3.mp3", "songs/1.mp3", "songs/2.mp3"], "还原后回到原来的位置")
        self.assertEqual(self.call("POST", "/playlists/containing", {"paths": ["songs/2.mp3"]})["playlists"], {"songs/2.mp3": [created["id"]]})
        self.call("POST", playlist, {"remove": ["songs/3.mp3"], "name": "晨跑"})
        self.assertEqual(keys(), ["songs/1.mp3", "songs/2.mp3"])
        page = self.call("GET", playlist + "?limit=1")
        self.assertEqual((page["playlist"]["name"], [item["key"] for item in page["objects"]]), ("晨跑", ["songs/1.mp3"]))
        self.assertEqual([item["key"] for item in self.call("GET", f"{playlist}?limit=1&cursor={page['next_cursor']}")["objects"]], ["songs/2.mp3"])
        self.call("GET", playlist, session=self.bob_session, expect=404)
        self.call("POST", playlist + "/delete", {}, session=self.bob_session, expect=404)
        self.call("POST", playlist + "/delete", {}, expect=204)
        self.assertEqual(self.call("GET", "/playlists")["playlists"], [])


if __name__ == "__main__":
    unittest.main()


class PlaylistShareTests(unittest.TestCase):
    """歌单分享：访客只看到歌单里的歌曲（不含路径），密码、有效期、下载与保存选项，歌单改动立即生效。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.bob = self.app.accounts.create_user("bob@example.com", "bob password")
        self.client = Client(self.app)
        self.alice_session = asyncio.run(self.client.login("user", "alice@example.com", "alice password"))
        self.bob_session = asyncio.run(self.client.login("user", "bob@example.com", "bob password"))
        scope = Scope(self.alice.bucket_id)
        for key in ("私人/歌/a.mp3", "私人/歌/b.mp3", "私人/歌/a.lrc", "私人/secret.mp3"):
            data = b"[00:01.00]hello" if key.endswith(".lrc") else MP3 + key.encode()
            asyncio.run(self.app.objects.put_object(scope, key, data, len(data), "text/plain" if key.endswith(".lrc") else "audio/mpeg"))
        async def register():
            info, _ = self.app.objects.file_metadata.ensure(scope, "私人/歌/a.mp3")
            await self.app.objects.file_metadata.initial_asset(scope, info, "lyrics", "[00:01.00]hello", source="embedded", default=True)
        asyncio.run(register())
        self.playlist = self.call("POST", "/api/user/v1/playlists", {"name": "分享", "paths": ["私人/歌/a.mp3", "私人/歌/b.mp3"]}, expect=201)["id"]

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def call(self, method, path, body=None, *, session=None, expect=200, raw=False):
        payload = b"" if body is None else json.dumps(body).encode()
        status, headers, data = asyncio.run(self.client.request(method, path, payload, headers={} if session is False else session or self.alice_session))
        self.assertEqual(status, expect, data[:300])
        return (headers, data) if raw else json.loads(data) if data else None

    def share(self, **options):
        return self.call("POST", f"/api/user/v1/playlists/{self.playlist}/share", {"enabled": True, **options})["share"]

    def test_visitors_see_only_playlist_songs_without_paths(self):
        share = self.share()
        self.assertEqual((share["download"], share["save"], share["has_password"]), (False, False, False), "两个选项默认关闭")
        page = self.call("GET", f"/api/public/v1/playlists/{share['token']}", session=False)
        self.assertEqual([item["name"] for item in page["items"]], ["a.mp3", "b.mp3"])
        self.assertNotIn("私人", json.dumps(page, ensure_ascii=False), "访客看不到存放路径")
        item = page["items"][0]["id"]
        base = f"/api/public/v1/playlists/{share['token']}/items/{item}"
        _, data = self.call("GET", base + "/content", session=False, raw=True)
        self.assertTrue(data.startswith(MP3))
        self.call("GET", base + "/content?download=1", session=False, expect=403)
        assets = self.call("GET", base + "/assets", session=False)
        self.assertEqual([asset["kind"] for asset in assets], ["lyrics"])
        self.assertNotIn("私人", json.dumps(assets, ensure_ascii=False))
        asset_item, index = assets[0]["path"].split("/")
        _, lyric = self.call("GET", f"/api/public/v1/playlists/{share['token']}/items/{asset_item}/assets/{index}", session=False, raw=True)
        self.assertEqual(lyric, b"[00:01.00]hello")
        # 不在歌单里的文件无法通过编号读取；移出歌单后立即失效。
        from tgdrive.playlists import Playlists
        self.call("GET", f"/api/public/v1/playlists/{share['token']}/items/{Playlists.item_id(share['token'], '私人/secret.mp3')}/content", session=False, expect=404)
        self.call("POST", f"/api/user/v1/playlists/{self.playlist}", {"remove": ["私人/歌/a.mp3"]})
        self.call("GET", base + "/content", session=False, expect=404)
        # 关闭分享后链接失效，再开启得到新链接。
        self.call("POST", f"/api/user/v1/playlists/{self.playlist}/share", {"enabled": False})
        self.call("GET", f"/api/public/v1/playlists/{share['token']}", session=False, expect=404)
        self.assertNotEqual(self.share()["token"], share["token"])

    def test_share_pages_carry_link_preview_metadata(self):
        """分享页的 index.html 带上分享名作为 Open Graph 标题；设了密码、失效的链接不透露名称。"""
        static = Path(self.temp.name) / "static"
        static.mkdir()
        (static / "index.html").write_text(
            '<head><title>Tessera</title><meta name="description" content="站点"><meta property="og:site_name" content="Tessera">'
            '<meta property="og:title" content="Tessera · 标语"><meta property="og:description" content="站点"><meta property="og:url" content="/">'
            '<meta property="og:image" content="/social.png"><meta property="og:image:width" content="1200"><meta name="twitter:card" content="summary_large_image">'
            '<meta name="twitter:title" content="Tessera"><meta name="twitter:description" content="站点"><meta name="twitter:image" content="/social.png"></head>', encoding="utf-8")
        self.app.static_dir = static.resolve()
        page = lambda path: self.call("GET", path, session=False, raw=True)[1].decode()
        token = self.share()["token"]
        html = page(f"/m/{token}")
        self.assertIn("<title>分享 · Tessera</title>", html)
        self.assertIn('<meta property="og:title" content="分享">', html)
        self.assertIn(f'<meta property="og:url" content="http://localhost/m/{token}">', html)
        self.assertIn("2 首", html)
        self.assertNotIn("私人", html, "预览信息不含存放路径")
        self.assertIn('content="http://localhost/social.png"', html, "没有封面时保留站点卡片")
        # 有密码：只给通用标题。
        self.share(password="1234")
        html = page(f"/m/{token}")
        self.assertIn("受密码保护的歌单", html)
        self.assertNotIn("<title>分享 ·", html)
        # 无效令牌：通用标题，不把请求路径写回页面。
        html = page("/m/nonexistent-token")
        self.assertIn("这个链接已失效", html)
        self.assertNotIn("nonexistent-token", html)
        # 单个文件的分享：文件名与大小。
        self.call("POST", "/api/user/v1/public", {"path": "私人/歌/b.mp3", "public": True})
        file_token = self.app.metadata.db.execute("SELECT public_token FROM objects WHERE key='私人/歌/b.mp3'").fetchone()[0]
        html = page(f"/s/{file_token}")
        self.assertIn('<meta property="og:title" content="b.mp3">', html)
        self.assertIn("分享的文件", html)
        self.assertNotIn("私人", html)

    def test_share_card_rewrites_cover(self):
        from tgdrive.static import apply_share_card
        html = ('<title>T</title><meta property="og:site_name" content="T"><meta property="og:image" content="/s.png">'
                '<meta property="og:image:width" content="1200"><meta name="twitter:image" content="/s.png"><meta name="twitter:card" content="summary_large_image">'
                '<meta property="og:title" content="T">')
        out = apply_share_card(html, {"title": 'A "<b>"', "description": "d", "path": "/m/x", "image": "/api/c?thumbnail=poster"})
        self.assertIn("<title>A &quot;&lt;b&gt;&quot; · T</title>".replace("&quot;", '"'), out)
        self.assertIn('content="A &quot;&lt;b&gt;&quot;"', out)
        self.assertEqual(out.count('content="/api/c?thumbnail=poster"'), 2)
        self.assertNotIn("og:image:width", out)
        self.assertIn('<meta name="twitter:card" content="summary">', out)

    def test_password_expiry_download_and_save(self):
        share = self.share(password="1234", download=True, save=True)
        token = share["token"]
        self.assertTrue(self.call("GET", f"/api/public/v1/playlists/{token}", session=False)["password_required"])
        self.call("POST", f"/api/public/v1/playlists/{token}/unlock", {"password": "wrong"}, session=False, expect=400)
        access = self.call("POST", f"/api/public/v1/playlists/{token}/unlock", {"password": "1234"}, session=False)["access"]
        page = self.call("GET", f"/api/public/v1/playlists/{token}?access={access}", session=False)
        self.assertEqual(len(page["items"]), 2)
        item = page["items"][1]["id"]
        self.call("GET", f"/api/public/v1/playlists/{token}/items/{item}/content", session=False, expect=403)
        _, data = self.call("GET", f"/api/public/v1/playlists/{token}/items/{item}/content?download=1&access={access}", session=False, raw=True)
        self.assertTrue(data.startswith(MP3))
        # 访客保存：引用同一份数据到自己的文件夹；自己的分享不能保存。
        self.call("POST", f"/api/user/v1/playlist-shares/{token}/save", {"destination": "收到的", "items": [item]}, session=self.bob_session, expect=403)
        saved = self.call("POST", f"/api/user/v1/playlist-shares/{token}/save", {"destination": "收到的", "items": [item], "access": access}, session=self.bob_session)
        self.assertEqual(saved["items"], ["收到的/b.mp3"])
        self.assertEqual(self.call("GET", f"/api/user/v1/playlist-shares/{token}/status", session=self.bob_session)["own"], False)
        self.call("POST", f"/api/user/v1/playlist-shares/{token}/save", {"destination": "", "access": access}, expect=400)
        audit = [row["detail"] or "" for row in self.app.metadata.db.execute("SELECT detail FROM audit_log WHERE action LIKE 'playlist%'")]
        self.assertTrue(audit and not any("1234" in detail or token in detail for detail in audit), "审计不记录密码与令牌")
        # 关闭保存后访客不能再保存；过期后链接不可用。
        self.share(save=False)
        self.call("POST", f"/api/user/v1/playlist-shares/{token}/save", {"destination": "", "access": access}, session=self.bob_session, expect=400)
        with self.app.metadata.transaction() as db:
            db.execute("UPDATE playlists SET share_expires_at=? WHERE id=?", (time.time() - 1, self.playlist))
        self.call("GET", f"/api/public/v1/playlists/{token}?access={access}", session=False, expect=410)
