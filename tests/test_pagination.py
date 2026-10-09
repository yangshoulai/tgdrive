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

    def test_user_and_client_pages_keep_filters_and_owner_scope(self):
        bob = self.app.accounts.create_user("bob", "bob password")
        self.app.accounts.set_account_status(bob.id, "disabled")
        admin = asyncio.run(self.client.login("admin", "admin", "admin password"))
        alice = asyncio.run(self.client.login("user", "alice", "alice password"))
        def get(path, headers=admin):
            status, _, data = asyncio.run(self.client.request("GET", path, headers=headers))
            self.assertEqual(status, 200, data)
            return json.loads(data)
        first = get("/api/admin/v1/users?limit=1")
        second = get(f"/api/admin/v1/users?limit=1&cursor={first['next_cursor']}")
        self.assertEqual((first["total"], second["users"][0]["username"]), (3, "alice"))
        filtered = get("/api/admin/v1/users?limit=1&q=BO&status=disabled")
        self.assertEqual([user["username"] for user in filtered["users"]], ["bob"])
        self.assertIsNone(filtered["next_cursor"])
        self.assertIsInstance(get("/api/admin/v1/users"), list)
        for i in range(3):
            self.app.s3.auth.create_client_with_key(f"alice-{i}", owner_user_id=self.alice.id)
        self.app.s3.auth.create_client_with_key("bob", owner_user_id=bob.id)
        seen, cursor = [], 0
        while True:
            page = get(f"/api/user/v1/clients?limit=1&cursor={cursor}", alice)
            self.assertEqual(page["total"], 3)
            self.assertEqual(len(page["clients"]), 1)
            self.assertEqual(page["clients"][0]["owner_username"], "alice")
            seen.extend(item["id"] for item in page["clients"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        self.assertEqual(len(set(seen)), 3)
        self.assertEqual(get("/api/admin/v1/clients?limit=1")["total"], 4)
        for route in ("/users?limit=1", "/clients?limit=1", "/users/summary"):
            self.assertEqual(asyncio.run(self.client.request("GET", "/api/admin/v1" + route, headers=alice))[0], 403)

    def test_public_pages_and_directory_filters_do_not_hide_later_matches(self):
        from urllib.parse import quote
        self.put("docs/", "docs/a.txt", "docs/b.txt", "docs/child/", "docs/child/x.txt", "private.txt")
        for key in ("docs/", "docs/b.txt", "docs/child/", "docs/child/x.txt"):
            self.objects.set_public(self.scope, key, True)
        alice = asyncio.run(self.client.login("user", "alice", "alice password"))
        seen, cursor = [], ""
        while True:
            status, _, data = asyncio.run(self.client.request("GET", f"/api/user/v1/public?limit=1&cursor={quote(cursor)}", headers=alice))
            self.assertEqual(status, 200)
            page = json.loads(data)
            self.assertEqual(page["total"], 4)
            seen.extend(item["key"] for item in page["objects"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        self.assertEqual(seen, ["docs/", "docs/b.txt", "docs/child/", "docs/child/x.txt"])
        seen, cursor = [], ""
        while True:
            path = f"/api/user/v1/list?prefix=docs/&public=1&limit=1&cursor={quote(cursor)}"
            page = json.loads(asyncio.run(self.client.request("GET", path, headers=alice))[2])
            seen.extend([item["key"] for item in page["objects"]] + page["common_prefixes"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        self.assertEqual(seen, ["docs/b.txt", "docs/child/"])
        page = json.loads(asyncio.run(self.client.request("GET", "/api/user/v1/search?q=txt&public=1&limit=1", headers=alice))[2])
        self.assertEqual(page["objects"][0]["key"], "docs/b.txt")

    def test_folder_picker_paginates_implicit_directories_and_checks_exact_conflicts(self):
        from urllib.parse import quote
        self.put("docs/a.txt", "docs/z.txt", "docs/child/a.txt", "empty/", "照片/portrait.jpg", "root.txt")
        alice = asyncio.run(self.client.login("user", "alice", "alice password"))
        seen, cursor = [], ""
        while True:
            status, _, data = asyncio.run(self.client.request("GET", f"/api/user/v1/folders?limit=1&cursor={quote(cursor)}", headers=alice))
            self.assertEqual(status, 200)
            page = json.loads(data)
            self.assertLessEqual(len(page["folders"]), 1)
            seen.extend(page["folders"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        self.assertEqual(seen, ["docs/", "empty/", "照片/"])
        page = json.loads(asyncio.run(self.client.request("GET", "/api/user/v1/folders?prefix=docs/", headers=alice))[2])
        self.assertEqual(page["folders"], ["docs/child/"])
        status, _, data = asyncio.run(self.client.request("POST", "/api/user/v1/files/check",
            json.dumps({"paths": ["docs/z.txt", "missing.txt"]}).encode(), alice))
        self.assertEqual((status, json.loads(data)), (200, {"paths": ["docs/z.txt"]}))
        without_csrf = {key: value for key, value in alice.items() if key.lower() != "x-csrf-token"}
        self.assertEqual(asyncio.run(self.client.request("POST", "/api/user/v1/files/check",
            json.dumps({"paths": ["docs/z.txt"]}).encode(), without_csrf))[0], 403)
        for paths in (["../escape.txt"], [1], ["missing.txt"] * 201):
            status = asyncio.run(self.client.request("POST", "/api/user/v1/files/check", json.dumps({"paths": paths}).encode(), alice))[0]
            self.assertEqual(status, 400)

    def test_trash_page_totals_and_overview_summary_are_not_page_counts(self):
        from urllib.parse import quote
        self.put("a.txt", "b.txt", "c.txt")
        asyncio.run(self.objects.trash(self.scope, ["a.txt", "b.txt", "c.txt"]))
        alice = asyncio.run(self.client.login("user", "alice", "alice password"))
        seen, cursor = [], ""
        while True:
            page = json.loads(asyncio.run(self.client.request("GET", f"/api/user/v1/trash?limit=1&cursor={quote(cursor)}", headers=alice))[2])
            self.assertEqual((page["total"], page["total_size"], page["retention_days"]), (3, 3, 30))
            seen.extend(item["id"] for item in page["items"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        self.assertEqual(len(set(seen)), 3)
        admin = asyncio.run(self.client.login("admin", "admin", "admin password"))
        summary = json.loads(asyncio.run(self.client.request("GET", "/api/admin/v1/users/summary", headers=admin))[2])
        self.assertEqual((summary["total"], summary["active"], summary["user_total"], summary["used_bytes"]), (2, 2, 1, 3))
        self.assertEqual([user["username"] for user in summary["top_users"]], ["alice"])


if __name__ == "__main__":
    unittest.main()
