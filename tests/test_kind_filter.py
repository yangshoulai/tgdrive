"""文件列表按类型筛选：规则与前端 getFileKind 一致，服务端键集分页。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.objects import Scope


class KindFilterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.scope = Scope(self.alice.bucket_id)
        self.client = Client(self.app)
        self.session = asyncio.run(self.client.login("user", "alice@example.com", "alice password"))

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def put(self, key, content_type=None):
        asyncio.run(self.app.objects.put_object(self.scope, key, b"x", 1, content_type))

    def keys(self, path):
        keys, cursor = [], ""
        while True:
            status, _, data = asyncio.run(self.client.request("GET", f"{path}&limit=2&cursor={quote(cursor)}", headers=self.session))
            self.assertEqual(status, 200, data)
            body = json.loads(data)
            self.assertEqual(body["common_prefixes"], [])
            keys += [item["key"] for item in body["objects"]]
            if not body["next_cursor"]:
                return keys
            cursor = body["next_cursor"]

    def test_list_and_search_filter_by_kind(self):
        for key, content_type in [("a.MP4", None), ("b.jpg", None), ("c.txt", None), ("d.py", None), ("e.mp3", None),
                                  ("f.pdf", None), ("g.xlsx", None), ("h.zip", None), ("clip.ts", "video/mp2t"),
                                  ("photo.txt", "image/png"), ("noext", "video/webm"), ("Dockerfile", None),
                                  ("sub/deep.mp4", None), (".env.local", None)]:
            self.put(key, content_type)
        self.put("pub.mp4")
        self.app.objects.set_public(self.scope, "pub.mp4", True)
        expected = {
            "video": ["a.MP4", "noext", "pub.mp4"], "image": ["b.jpg", "photo.txt"], "audio": ["e.mp3"],
            "document": ["f.pdf", "g.xlsx"], "text": [".env.local", "Dockerfile", "c.txt", "d.py"], "archive": ["h.zip"],
        }
        for kind, keys in expected.items():
            # 只列当前目录，子目录里的文件与文件夹都不出现；MPEG-TS 不算视频，MIME 为图片的 .txt 算图片。
            self.assertEqual(self.keys(f"/api/user/v1/list?prefix=&kind={kind}"), keys, kind)
        self.assertEqual(self.keys("/api/user/v1/list?prefix=&kind=video&public=1"), ["pub.mp4"])
        self.assertEqual(self.keys("/api/user/v1/list?prefix=sub/&kind=video"), ["sub/deep.mp4"])
        self.assertEqual(self.keys("/api/user/v1/search?q=mp4&kind=video"), ["a.MP4", "pub.mp4", "sub/deep.mp4"])
        # 多选取并集，顺序无关；任一项未知整体拒绝。
        self.assertEqual(self.keys("/api/user/v1/list?prefix=&kind=video,image"), sorted(expected["video"] + expected["image"]))
        self.assertEqual(self.keys("/api/user/v1/list?prefix=&kind=archive%2Caudio"), ["e.mp3", "h.zip"])
        for bogus in ("bogus", "video,bogus", ","):
            status, _, _ = asyncio.run(self.client.request("GET", f"/api/user/v1/list?prefix=&kind={bogus}", headers=self.session))
            self.assertEqual(status, 400, bogus)

    def test_public_folder_filters_by_kind(self):
        for key in ("pub/a.mp4", "pub/b.jpg", "pub/c.txt", "pub/sub/d.mp4", "other.mp4"):
            self.put(key)
        token = self.app.objects.set_public(self.scope, "pub/", True).public_token
        def names(query):
            status, _, data = asyncio.run(self.client.request("GET", f"/api/public/v1/folders/{token}/list?{query}"))
            self.assertEqual(status, 200, data)
            body = json.loads(data)
            return [item["name"] for item in body["files"]], [item["name"] for item in body["folders"]]
        self.assertEqual(names("kind=video"), (["a.mp4"], []))
        self.assertEqual(names("kind=video&path=sub/"), (["d.mp4"], []))
        self.assertEqual(names("kind=image"), (["b.jpg"], []))
        self.assertEqual(names("kind=image,video"), (["a.mp4", "b.jpg"], []))
        self.assertEqual(names(""), (["a.mp4", "b.jpg", "c.txt"], ["sub"]))
        self.assertEqual(asyncio.run(self.client.request("GET", f"/api/public/v1/folders/{token}/list?kind=bogus"))[0], 400)

    def test_kind_filter_keeps_private_space_protected(self):
        private = Scope(self.alice.bucket_id, ".tgdrive/private/", private_access=True)
        asyncio.run(self.app.objects.put_object(private, ".tgdrive/private/secret.mp4", b"x", 1))
        self.assertEqual(self.keys("/api/user/v1/list?prefix=&kind=video"), [])
        status, _, _ = asyncio.run(self.client.request("GET", "/api/user/v1/list?prefix=.tgdrive/private/&kind=video", headers=self.session))
        self.assertIn(status, (400, 403))

    def test_folder_stats_group_by_kind_recursively_and_skip_system_area(self):
        for key, content_type in [("a/x.jpg", None), ("a/b/y.mp4", None), ("a/b/c/z.txt", None), ("a/empty/", None),
                                  ("a/clip.ts", "video/mp2t"), ("top.zip", None)]:
            self.put(key, content_type)
        private = Scope(self.alice.bucket_id, ".tgdrive/private/", private_access=True)
        asyncio.run(self.app.objects.put_object(private, ".tgdrive/private/secret.mp4", b"x", 1))
        def stats(prefix):
            status, _, data = asyncio.run(self.client.request("GET", f"/api/user/v1/stats?prefix={quote(prefix)}", headers=self.session))
            return status, json.loads(data)
        status, body = stats("a/")
        self.assertEqual(status, 200, body)
        self.assertEqual((body["files"], body["folders"], body["direct_files"], body["direct_folders"]), (4, 3, 2, 2))
        self.assertEqual({item["kind"]: item["count"] for item in body["kinds"]}, {"image": 1, "video": 1, "text": 1, "other": 1})
        self.assertEqual(len(body["largest"]), 4)
        status, body = stats("")
        self.assertEqual(body["files"], 5, "根目录不统计 .tgdrive/ 系统区")
        self.assertNotIn("secret", json.dumps(body))
        status, _ = stats(".tgdrive/private/")
        self.assertIn(status, (400, 403))


if __name__ == "__main__":
    unittest.main()
