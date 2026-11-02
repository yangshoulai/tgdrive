import asyncio
import tempfile
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.objects import MoveResult, Scope
from tgdrive.errors import NotFoundError


class MoveBatchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password", quota_bytes=10**9)
        self.scope = Scope(self.alice.bucket_id)
        self.objects = self.app.user.objects

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def put(self, *keys):
        async def run():
            for key in keys:
                data = key.encode()
                await self.objects.put_object(self.scope, key, data, len(data), "text/plain")
        asyncio.run(run())

    def keys(self):
        return [row[0] for row in self.app.metadata.db.execute(
            "SELECT key FROM objects WHERE bucket_id=? AND substr(key,1,9)!='.tgdrive/' ORDER BY key", (self.alice.bucket_id,))]

    def test_moves_many_in_one_commit_and_reports_each_item(self):
        self.put("a/1.txt", "a/2.txt", "a/sub/x.txt", "b/2.txt")
        changes = []
        self.objects.on_change = changes.append
        results = self.objects.move_many(self.scope, [
            ("a/1.txt", "b/1.txt"), ("a/2.txt", "b/2.txt"), ("a/missing.txt", "b/missing.txt"),
            ("a/sub/", "a/sub/inner/"), ("a/sub/", "b/sub/")], "skip")
        self.assertEqual(results[0], MoveResult(1, 0))
        self.assertEqual(results[1], MoveResult(0, 1))
        self.assertIsInstance(results[2], NotFoundError)
        self.assertIsInstance(results[3], ValueError)
        self.assertEqual(results[4], MoveResult(1, 0))
        self.assertEqual(self.keys(), ["a/2.txt", "b/1.txt", "b/2.txt", "b/sub/x.txt"])
        self.assertEqual(changes, [self.alice.bucket_id])

    def test_failed_authorization_rolls_back_whole_batch(self):
        self.put("a/1.txt", "a/2.txt")

        def deny():
            raise PermissionError("locked")
        # 前两项内部复核通过，提交前最后一次复核失败：两项都不能生效。
        state = {"n": 0}

        def authorize():
            state["n"] += 1
            if state["n"] > 2:
                deny()
        scope = Scope(self.alice.bucket_id, authorize=authorize)
        with self.assertRaises(PermissionError):
            self.objects.move_many(scope, [("a/1.txt", "b/1.txt"), ("a/2.txt", "b/2.txt")])
        self.assertEqual(self.keys(), ["a/1.txt", "a/2.txt"])

    def test_limits_and_conflict(self):
        with self.assertRaises(ValueError):
            self.objects.move_many(self.scope, [])
        with self.assertRaises(ValueError):
            self.objects.move_many(self.scope, [("a", "b")] * (self.objects.MOVE_BATCH_LIMIT + 1))
        with self.assertRaises(ValueError):
            self.objects.move_many(self.scope, [("a", "b")], "bogus")

    def test_web_api_batch(self):
        self.put("a/1.txt", "a/2.txt")
        token, csrf = self.login()
        result = asyncio.run(self.app.user.move_many(token, csrf, [{"from": "a/1.txt", "to": "c/1.txt"},
                                                                  {"from": "a/none.txt", "to": "c/none.txt"}], "rename"))
        self.assertEqual(result["moved"], 1)
        self.assertEqual(result["results"][0], {"from": "a/1.txt", "moved": 1, "skipped": 0})
        self.assertIn("error", result["results"][1])
        with self.assertRaises(ValueError):
            asyncio.run(self.app.user.move_many(token, csrf, [{"from": "a/2.txt"}]))
        # 不能借批量接口进入系统区。
        with self.assertRaises((PermissionError, ValueError)):
            asyncio.run(self.app.user.move_many(token, csrf, [{"from": "a/2.txt", "to": ".tgdrive/x.txt"}]))

    def test_key_api_batch_requires_one_grant(self):
        from tgdrive.keyapi import KeyPrincipal
        self.put("in/1.txt", "in/2.txt", "other/3.txt")
        bucket = self.app.metadata.db.execute("SELECT name FROM buckets WHERE id=?", (self.alice.bucket_id,)).fetchone()[0]
        client_id, access_key, _ = self.app.s3.auth.create_client_with_key(
            "k", owner_user_id=self.alice.id, grants=[(self.alice.bucket_id, "in/", "rw")])
        principal = KeyPrincipal(access_key, client_id)
        from tgdrive.keyapi import KeyApi
        keys = KeyApi(self.objects, self.app.s3.auth)
        result = asyncio.run(keys.move_many(principal, bucket, [{"from": "in/1.txt", "to": "in/sub/1.txt"},
                                                                {"from": "in/2.txt", "to": "in/sub/2.txt"}], "skip"))
        self.assertEqual(result["moved"], 2)
        with self.assertRaises(PermissionError):
            asyncio.run(keys.move_many(principal, bucket, [{"from": "in/sub/1.txt", "to": "in/1.txt"},
                                                           {"from": "other/3.txt", "to": "in/3.txt"}], "skip"))
        self.assertEqual(self.keys(), ["in/sub/1.txt", "in/sub/2.txt", "other/3.txt"])

    def login(self):
        session = self.app.user.login("alice@example.com", "alice password")
        return session["session"], session["csrf_token"]


if __name__ == "__main__":
    unittest.main()
