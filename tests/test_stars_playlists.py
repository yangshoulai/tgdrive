"""文件星标（POST /star、GET /starred）与音乐歌单（/playlists）。"""
import asyncio
import json
import tempfile
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
