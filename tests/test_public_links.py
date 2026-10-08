"""M8：公开链接、配额调整与密码修改。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.objects import Scope


class Client:
    def __init__(self, app):
        self.app = app

    async def request(self, method, path, body=b"", headers=None, scheme="http"):
        sent = []
        queue = [{"type": "http.request", "body": body, "more_body": False}]

        async def receive():
            return queue.pop(0)

        async def send(message):
            sent.append(message)

        await self.app({"type": "http", "scheme": scheme, "method": method, "path": path.split("?", 1)[0],
                        "query_string": path.split("?", 1)[1].encode() if "?" in path else b"",
                        "headers": [(k.encode(), v.encode()) for k, v in (headers or {}).items()]}, receive, send)
        status = sent[0]["status"]
        response_headers = {k.decode(): v.decode() for k, v in sent[0]["headers"]}
        data = b"".join(message.get("body", b"") for message in sent[1:])
        return status, response_headers, data

    async def login(self, role, username, password):
        status, headers, data = await self.request(
            "POST", f"/api/{role}/v1/login", json.dumps({"username": username, "password": password}).encode())
        assert status == 200, data
        return {"cookie": headers["set-cookie"].split(";", 1)[0], "x-csrf-token": json.loads(data)["csrf_token"]}


class PublicLinkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, public_base_url="https://drive.example.test/")
        self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.alice = self.app.accounts.create_user("alice", "alice password")
        self.client = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def run_async(self, coro):
        return asyncio.run(coro)

    def test_upload_public_and_stream_without_session(self):
        async def run():
            auth = await self.client.login("user", "alice", "alice password")
            status, _, data = await self.client.request(
                "PUT", "/api/user/v1/files?path=docs/hello.txt&public=1", b"hello world",
                {**auth, "content-type": "text/plain", "content-length": "11"})
            self.assertEqual(status, 200)
            token = json.loads(data)["public_token"]
            self.assertTrue(token)

            status, headers, body = await self.client.request("GET", f"/p/{token}/hello.txt", headers={"range": "bytes=0-4"})
            self.assertEqual((status, body), (206, b"hello"))
            self.assertEqual(headers["cache-control"], "public, no-cache")

            status, _, data = await self.client.request("GET", f"/api/public/v1/objects/{token}")
            meta = json.loads(data)
            self.assertEqual((status, meta["name"], meta["size"]), (200, "hello.txt", 11))
            self.assertNotIn("key", meta)

            status, _, data = await self.client.request("GET", "/api/user/v1/me", headers=auth)
            self.assertEqual(json.loads(data)["public_base_url"], "https://drive.example.test")
        self.run_async(run())

    def test_link_survives_overwrite_and_move_but_not_revoke(self):
        async def run():
            auth = await self.client.login("user", "alice", "alice password")
            await self.client.request("PUT", "/api/user/v1/files?path=a.txt", b"one", {**auth, "content-length": "3"})
            status, _, data = await self.client.request(
                "POST", "/api/user/v1/public", json.dumps({"path": "a.txt", "public": True}).encode(), auth)
            self.assertEqual(status, 200)
            token = json.loads(data)["objects"][0]["public_token"]

            # 覆盖写入（不带 public 参数）保留链接。
            await self.client.request("PUT", "/api/user/v1/files?path=a.txt", b"two!", {**auth, "content-length": "4"})
            self.assertEqual((await self.client.request("GET", f"/p/{token}"))[2], b"two!")

            await self.client.request("POST", "/api/user/v1/move",
                                      json.dumps({"from": "a.txt", "to": "moved/a.txt"}).encode(), auth)
            self.assertEqual((await self.client.request("GET", f"/p/{token}"))[0], 200)
            status, _, data = await self.client.request("GET", "/api/user/v1/public", headers=auth)
            self.assertEqual([item["key"] for item in json.loads(data)], ["moved/a.txt"])

            await self.client.request("POST", "/api/user/v1/public",
                                      json.dumps({"paths": ["moved/a.txt"], "public": False}).encode(), auth)
            self.assertEqual((await self.client.request("GET", f"/p/{token}"))[0], 404)
        self.run_async(run())

    def test_bad_tokens_are_404(self):
        async def run():
            self.assertEqual((await self.client.request("GET", "/p/../etc"))[0], 404)
            self.assertEqual((await self.client.request("GET", "/p/doesnotexist123"))[0], 404)
        self.run_async(run())

    def test_disabled_owner_admin_revoke_and_lock(self):
        async def run():
            user = await self.client.login("user", "alice", "alice password")
            _, _, data = await self.client.request(
                "PUT", "/api/user/v1/files?path=x.bin&public=true", b"x", {**user, "content-length": "1"})
            token = json.loads(data)["public_token"]
            admin = await self.client.login("admin", "admin", "admin password")

            _, _, data = await self.client.request("GET", "/api/admin/v1/objects", headers=admin)
            self.assertEqual(json.loads(data)["objects"][0]["public_token"], token)

            self.app.accounts.set_account_status(self.alice.id, "disabled")
            self.assertEqual((await self.client.request("GET", f"/p/{token}"))[0], 404)
            self.app.accounts.set_account_status(self.alice.id, "active")
            self.assertEqual((await self.client.request("GET", f"/p/{token}"))[0], 200)

            status, _, _ = await self.client.request("POST", "/api/admin/v1/objects/public", json.dumps(
                {"bucket_id": self.alice.bucket_id, "path": "x.bin", "public": False}).encode(), admin)
            self.assertEqual(status, 200)
            self.assertEqual((await self.client.request("GET", f"/p/{token}"))[0], 404)

            self.app.objects.set_public(Scope(self.alice.bucket_id), "x.bin", True)
            token = self.app.objects.list_public(self.alice.bucket_id)[0].public_token
            self.app.keystore.lock()
            self.assertEqual((await self.client.request("GET", f"/p/{token}"))[0], 503)
        self.run_async(run())

    def test_quota_update_and_password_change(self):
        async def run():
            admin = await self.client.login("admin", "admin", "admin password")
            status, _, _ = await self.client.request(
                "POST", f"/api/admin/v1/users/{self.alice.id}/quota", json.dumps({"quota_bytes": 2}).encode(), admin)
            self.assertEqual(status, 204)
            user = await self.client.login("user", "alice", "alice password")
            status, _, data = await self.client.request(
                "PUT", "/api/user/v1/files?path=big.bin", b"abc", {**user, "content-length": "3"})
            self.assertEqual((status, json.loads(data)["error"]["code"]), (413, "quota_exceeded"))

            status, _, _ = await self.client.request("POST", "/api/user/v1/password", json.dumps(
                {"old_password": "wrong", "new_password": "new password"}).encode(), user)
            self.assertEqual(status, 400)
            status, _, _ = await self.client.request("POST", "/api/user/v1/password", json.dumps(
                {"old_password": "alice password", "new_password": "new password"}).encode(), user)
            self.assertEqual(status, 204)
            await self.client.login("user", "alice", "new password")
        self.run_async(run())


if __name__ == "__main__":
    unittest.main()
