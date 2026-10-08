"""M14：SQL 键集分页列表、按前缀删除、管理端全部文件分页与密钥搜索。"""
import asyncio
import json
import random
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.objects import Scope


class ListingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.alice = self.app.accounts.create_user("alice", "alice password")
        self.objects = self.app.objects
        self.scope = Scope(self.alice.bucket_id)
        self.client = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def put(self, *keys):
        async def run():
            for key in keys:
                if key.endswith("/"):
                    await self.objects.put_directory_marker(self.scope, key)
                else:
                    await self.objects.put_object(self.scope, key, b"x")
        asyncio.run(run())

    def walk(self, prefix, delimiter, limit, scope=None):
        objects, prefixes, cursor = [], [], None
        while True:
            page = self.objects.list_objects(scope or self.scope, prefix, delimiter, cursor, limit)
            objects += [item.key for item in page.objects]
            prefixes += page.common_prefixes
            self.assertLessEqual(len(page.objects) + len(page.common_prefixes), limit)
            if page.next_cursor is None:
                return objects, prefixes
            cursor = page.next_cursor

    @staticmethod
    def expected(keys, prefix, delimiter):
        objects, prefixes = [], []
        for key in sorted(keys):
            if not key.startswith(prefix):
                continue
            rest = key[len(prefix):]
            if delimiter and delimiter in rest:
                value = prefix + rest[:rest.index(delimiter) + 1]
                if value not in prefixes:
                    prefixes.append(value)
            else:
                objects.append(key)
        return objects, prefixes

    def test_pagination_matches_reference_for_random_trees(self):
        rng = random.Random(7)
        segments = ["a", "b", "docs", "照片", "z", "a.b", "a-b"]
        keys = set()
        while len(keys) < 160:
            depth = rng.randint(1, 4)
            key = "/".join(rng.choice(segments) for _ in range(depth))
            keys.add(key + ("/" if rng.random() < 0.1 else ""))
        self.put(*sorted(keys))
        for prefix in ("", "a/", "docs/", "a", "照片/", "missing/"):
            for delimiter in ("/", None):
                for limit in (1, 3, 1000):
                    self.assertEqual(self.walk(prefix, delimiter, limit), self.expected(keys, prefix, delimiter),
                                     (prefix, delimiter, limit))

    def test_listing_reads_rows_proportional_to_page(self):
        self.put(*[f"big/{index:05d}.txt" for index in range(3000)], "small/a.txt", "small/b.txt")
        queries = []
        self.app.metadata.db.set_trace_callback(queries.append)
        page = self.objects.list_objects(self.scope, "", "/", None, 10)
        self.app.metadata.db.set_trace_callback(None)
        self.assertEqual(page.common_prefixes, ["big/", "small/"])
        # 遇到 big/ 后直接跳过 3000 个子项：只需要少量查询。
        self.assertLessEqual(len([query for query in queries if query.startswith("SELECT * FROM objects")]), 4)

    def test_recursive_delete_via_user_and_key_api(self):
        self.put("tree/", "tree/a.txt", "tree/sub/b.txt", "tree-other.txt", "keep/c.txt")
        token = self.objects.set_public(self.scope, "tree/a.txt", True).public_token
        session = asyncio.run(self.client.login("user", "alice", "alice password"))
        status, _, data = asyncio.run(self.client.request("POST", "/api/user/v1/delete",
                                                          json.dumps({"paths": ["tree/"], "recursive": True}).encode(), session))
        self.assertEqual(json.loads(data)["results"], [{"path": "tree/", "deleted": True, "count": 3}])
        self.assertEqual(self.walk("", None, 1000)[0], ["keep/c.txt", "tree-other.txt"])
        self.assertEqual(asyncio.run(self.client.request("GET", f"/p/{token}"))[0], 404)
        # 非递归删除文件夹只删除目录标记，行为不变。
        self.put("only/", "only/x.txt")
        asyncio.run(self.client.request("POST", "/api/user/v1/delete", json.dumps({"paths": ["only/"]}).encode(), session))
        self.assertIn("only/x.txt", self.walk("", None, 1000)[0])

        clients = self.app.s3.auth
        cid = clients.create_client("cli", owner_user_id=self.alice.id)
        ak, secret = clients.create_key(cid)
        clients.grant(cid, self.alice.bucket_id, "", "rw")
        status, _, data = asyncio.run(self.client.request("POST", "/api/v1/delete",
                                                          json.dumps({"paths": ["only/"], "recursive": True}).encode(),
                                                          {"authorization": f"Bearer {ak}:{secret}"}))
        self.assertEqual(json.loads(data)["results"][0]["count"], 1)  # 目录标记已在上一步删除

    def test_key_search_limits_and_respects_prefix_in_sql(self):
        self.put(*[f"pub/{index}.log" for index in range(30)], *[f"priv/{index}.log" for index in range(30)])
        clients = self.app.s3.auth
        cid = clients.create_client("reader")
        ak, secret = clients.create_key(cid)
        clients.grant(cid, self.alice.bucket_id, "pub/", "ro")
        headers = {"authorization": f"Bearer {ak}:{secret}"}
        keys, cursor = [], ""
        while True:
            _, _, data = asyncio.run(self.client.request("GET", f"/api/v1/search?q=log&limit=7&cursor={cursor}", headers=headers))
            body = json.loads(data)
            keys += [item["key"] for item in body["objects"]]
            if not body["next_cursor"]:
                break
            cursor = body["next_cursor"]
        self.assertEqual(sorted(keys), sorted(f"pub/{index}.log" for index in range(30)))

    def test_admin_objects_paginates_and_filters_on_server(self):
        self.put(*[f"f{index:03d}.txt" for index in range(25)], "folder/")
        self.objects.set_public(self.scope, "f003.txt", True)
        admin = asyncio.run(self.client.login("admin", "admin", "admin password"))
        seen, cursor = [], None
        while True:
            path = "/api/admin/v1/objects?limit=10" + (f"&cursor={cursor}" if cursor else "")
            body = json.loads(asyncio.run(self.client.request("GET", path, headers=admin))[2])
            seen += [item["key"] for item in body["objects"]]
            self.assertEqual((body["total"], body["public_total"]), (25, 1))
            cursor = body["next_cursor"]
            if not cursor:
                break
            cursor = __import__("urllib.parse").parse.quote(cursor)
        self.assertEqual(sorted(seen), [f"f{index:03d}.txt" for index in range(25)])
        filtered = json.loads(asyncio.run(self.client.request("GET", "/api/admin/v1/objects?q=ALICE&public=1", headers=admin))[2])
        self.assertEqual([item["key"] for item in filtered["objects"]], ["f003.txt"])
        none = json.loads(asyncio.run(self.client.request("GET", "/api/admin/v1/objects?q=nomatch", headers=admin))[2])
        self.assertEqual((none["objects"], none["total"]), ([], 0))


if __name__ == "__main__":
    unittest.main()
