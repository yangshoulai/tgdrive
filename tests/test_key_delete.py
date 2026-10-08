"""访问密钥可以被永久删除：立即失效，只能删自己的，管理员可以删任何人的，审计里不含 Secret。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app


class KeyDeleteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.app.accounts.create_user("alice", "alice password")
        self.app.accounts.create_user("bob", "bob password")
        self.client = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    async def post(self, path, auth, payload=None):
        status, _, data = await self.client.request("POST", path, json.dumps(payload or {}).encode(), auth)
        return status, (json.loads(data) if data else None)

    async def make_key(self, auth, name="cli"):
        status, body = await self.post("/api/user/v1/clients", auth, {"name": name})
        self.assertEqual(status, 201, body)
        return body

    async def key_api_status(self, key):
        status, _, _ = await self.client.request("GET", "/api/v1/me", b"", {"authorization": f"Bearer {key['access_key_id']}:{key['secret']}"})
        return status

    def count(self, table):
        return self.app.metadata.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]

    def test_user_deletes_own_key_and_it_stops_working_at_once(self):
        async def run():
            alice = await self.client.login("user", "alice", "alice password")
            key = await self.make_key(alice)
            self.assertEqual(await self.key_api_status(key), 200)
            status, _ = await self.post("/api/user/v1/client-keys/delete", alice, {"access_key_id": key["access_key_id"]})
            self.assertEqual(status, 204)
            self.assertEqual(await self.key_api_status(key), 401)
            # 客户端没有其他密钥了，连同授权一起清除
            self.assertEqual((self.count("clients"), self.count("client_keys"), self.count("client_grants")), (0, 0, 0))
            status, _, data = await self.client.request("GET", "/api/user/v1/clients", b"", alice)
            self.assertEqual(json.loads(data), [])
            # 已经不存在的密钥：和别人的密钥一样返回 403，不泄露它是否存在
            status, _ = await self.post("/api/user/v1/client-keys/delete", alice, {"access_key_id": key["access_key_id"]})
            self.assertEqual(status, 403)
        asyncio.run(run())

    def test_disabled_keys_can_be_deleted_too(self):
        async def run():
            alice = await self.client.login("user", "alice", "alice password")
            key = await self.make_key(alice)
            await self.post("/api/user/v1/client-keys/disable", alice, {"access_key_id": key["access_key_id"]})
            status, _ = await self.post("/api/user/v1/client-keys/delete", alice, {"access_key_id": key["access_key_id"]})
            self.assertEqual(status, 204)
            self.assertEqual(self.count("client_keys"), 0)
        asyncio.run(run())

    def test_cannot_delete_someone_elses_key(self):
        async def run():
            alice = await self.client.login("user", "alice", "alice password")
            bob = await self.client.login("user", "bob", "bob password")
            key = await self.make_key(alice)
            status, _ = await self.post("/api/user/v1/client-keys/delete", bob, {"access_key_id": key["access_key_id"]})
            self.assertEqual(status, 403)
            self.assertEqual(await self.key_api_status(key), 200)
            status, _ = await self.post("/api/admin/v1/client-keys/delete", bob, {"access_key_id": key["access_key_id"]})
            self.assertEqual(status, 403)
            status, _ = await self.post(f"/api/admin/v1/clients/{key['id']}/delete", bob)
            self.assertEqual(status, 403)
        asyncio.run(run())

    def test_admin_deletes_a_key_or_a_whole_client_and_it_is_audited_without_secrets(self):
        async def run():
            alice = await self.client.login("user", "alice", "alice password")
            admin = await self.client.login("admin", "admin", "admin password")
            first = await self.make_key(alice, "one")
            second = await self.make_key(alice, "two")
            status, _ = await self.post("/api/admin/v1/client-keys/delete", admin, {"access_key_id": first["access_key_id"]})
            self.assertEqual(status, 204)
            self.assertEqual(await self.key_api_status(first), 401)
            self.assertEqual(await self.key_api_status(second), 200)
            status, _ = await self.post(f"/api/admin/v1/clients/{second['id']}/delete", admin)
            self.assertEqual(status, 204)
            self.assertEqual(await self.key_api_status(second), 401)
            self.assertEqual((self.count("clients"), self.count("client_keys")), (0, 0))
            status, _ = await self.post("/api/admin/v1/clients/9999/delete", admin)
            self.assertEqual(status, 404)
            status, _, data = await self.client.request("GET", "/api/admin/v1/audit?limit=50", b"", admin)
            events = json.loads(data)["events"]
            actions = [event["action"] for event in events]
            self.assertIn("key.delete", actions)
            self.assertIn("client.delete", actions)
            dump = json.dumps(events)
            self.assertNotIn(first["secret"], dump)
            self.assertNotIn(second["secret"], dump)
        asyncio.run(run())

    def test_one_key_of_a_client_with_several_keys_keeps_the_client(self):
        async def run():
            alice = await self.client.login("user", "alice", "alice password")
            key = await self.make_key(alice)
            extra, _ = self.app.s3.auth.create_key(key["id"])
            status, _ = await self.post("/api/user/v1/client-keys/delete", alice, {"access_key_id": key["access_key_id"]})
            self.assertEqual(status, 204)
            self.assertEqual((self.count("clients"), self.count("client_keys")), (1, 1))
            self.assertEqual(self.app.metadata.db.execute("SELECT access_key_id FROM client_keys").fetchone()[0], extra)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
