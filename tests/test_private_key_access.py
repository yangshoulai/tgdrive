"""脚本私密授权：只使用临时目录与本地存储，不连接真实数据库或外部服务。"""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.objects import PRIVATE_PREFIX


class PrivateKeyAccessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False)
        self.app.accounts.setup("test encryption passphrase", "admin@example.com", "admin password")
        self.user = self.app.accounts.create_user("alice@example.com", "alice password")
        self.clients = self.app.s3.auth
        self.cid, self.ak, self.secret = self.clients.create_client_with_key("grabber", owner_user_id=self.user.id,
            grants=[(self.user.bucket_id, "", "rw")])
        self.http = Client(self.app)
        self.app.private_space.ensure_config(self.user.id, 300)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def headers(self, *, client="a" * 64, access=None):
        return {"authorization": f"Bearer {self.ak}:{self.secret}", "x-tessera-private-client": client,
                **({"x-private-access": access} if access else {})}

    def call(self, method, path, payload=None, *, access=None, client="a" * 64, raw=None):
        body = raw if raw is not None else json.dumps(payload).encode() if payload is not None else b""
        status, headers, data = asyncio.run(self.http.request(method, path, body, self.headers(client=client, access=access)))
        return status, headers, json.loads(data) if data else None

    def unlock(self):
        status, _, result = self.call("POST", "/api/v1/private/unlock", {"password": "alice password"})
        self.assertEqual(status, 200, result)
        self.assertNotIn("csrf", result)
        self.assertNotIn("token", result)
        return result["access"]

    def test_unlock_is_bound_to_key_and_script_installation(self):
        self.assertEqual(self.call("GET", "/api/v1/private/status", client="")[0], 400)
        self.assertFalse(self.call("GET", "/api/v1/private/status")[2]["unlocked"])
        self.assertEqual(self.call("POST", "/api/v1/private/unlock", {"password": "wrong"})[0], 400)
        access = self.unlock()
        self.assertTrue(self.call("GET", "/api/v1/private/status")[2]["unlocked"])
        self.assertFalse(self.call("GET", "/api/v1/private/status", client="b" * 64)[2]["unlocked"])
        self.assertEqual(self.call("GET", "/api/v1/private/folders", access=access, client="b" * 64)[0], 423)
        self.assertEqual(self.call("POST", "/api/v1/private/lock", {}, access=access)[0], 200)
        self.assertFalse(self.call("GET", "/api/v1/private/status")[2]["unlocked"])

    def test_status_does_not_extend_but_real_activity_does(self):
        with patch("tgdrive.private.time.monotonic", return_value=100):
            access = self.unlock()
        with patch("tgdrive.private.time.monotonic", return_value=350):
            self.assertEqual(self.call("GET", "/api/v1/private/status")[2]["remaining_seconds"], 50)
        with patch("tgdrive.private.time.monotonic", return_value=399):
            self.assertEqual(self.call("POST", "/api/v1/private/activity", {"active": True}, access=access)[0], 200)
        with patch("tgdrive.private.time.monotonic", return_value=650):
            self.assertTrue(self.call("GET", "/api/v1/private/status")[2]["unlocked"])
        with patch("tgdrive.private.time.monotonic", return_value=700):
            self.assertFalse(self.call("GET", "/api/v1/private/status")[2]["unlocked"])
            self.assertEqual(self.call("PUT", "/api/v1/private/files?path=.tessera-upload-test", access=access, raw=b"x")[0], 423)

    def test_private_upload_and_folder_boundaries(self):
        access = self.unlock()
        self.assertEqual(self.call("POST", "/api/v1/private/folders", {"path": "secret/"}, access=access)[0], 201)
        result = self.call("GET", "/api/v1/private/folders", access=access)
        self.assertEqual(result[2]["folders"], ["secret/"])
        self.assertEqual(result[1]["cache-control"], "no-store")
        temporary = "secret/.tessera-upload-test"
        result = self.call("PUT", f"/api/v1/private/files?path={temporary}", access=access, raw=b"hello")
        self.assertEqual((result[0], result[2]["key"]), (200, temporary))
        self.assertEqual(self.call("POST", "/api/v1/private/move", {"from": temporary, "to": "elsewhere/a.txt"}, access=access)[0], 400)
        self.assertEqual(self.call("POST", "/api/v1/private/move", {"from": temporary, "to": "secret/a.txt"}, access=access)[2]["moved"], 1)
        self.assertIsNotNone(self.app.metadata.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?",
            (self.user.bucket_id, PRIVATE_PREFIX + "secret/a.txt")).fetchone())
        self.assertEqual(self.call("POST", "/api/v1/private/delete", {"paths": ["secret/a.txt"]}, access=access)[0], 400)
        self.assertEqual(self.call("PUT", "/api/v1/private/files?path=secret/a.txt", access=access, raw=b"overwrite")[0], 400)
        self.assertNotEqual(self.call("GET", "/api/v1/content?path=.tgdrive/private/secret/a.txt", access=access)[0], 200)
        self.assertEqual(self.call("PUT", "/api/v1/private/files?path=.tgdrive/escape", access=access, raw=b"x")[0], 403)

    def test_key_scope_and_password_revocation(self):
        access = self.unlock()
        self.clients.disable_key(self.ak)
        self.assertEqual(self.call("GET", "/api/v1/private/folders", access=access)[0], 401)
        _, self.ak, self.secret = self.clients.create_client_with_key("limited", owner_user_id=self.user.id,
            grants=[(self.user.bucket_id, "uploads/", "rw")])
        self.assertEqual(self.call("POST", "/api/v1/private/unlock", {"password": "alice password"})[0], 403)
        _, self.ak, self.secret = self.clients.create_client_with_key("root", owner_user_id=self.user.id,
            grants=[(self.user.bucket_id, "", "rw")])
        self.unlock()
        self.app.accounts.reset_password(self.user.id, "new alice password")
        self.assertFalse(self.call("GET", "/api/v1/private/status")[2]["unlocked"])

    def test_private_downloads_require_grant_and_do_not_leak_to_normal_polling(self):
        from tests.test_offline import MemoryHttp
        self.app.offline.http = MemoryHttp()
        parsed = self.call("POST", "/api/v1/downloads/parse", {"input": "https://example.com/a.bin"})
        self.assertEqual(parsed[0], 200)
        items = [{"ticket": parsed[2]["candidates"][0]["ticket"], "name": "a.bin", "folder": "子目录/"}]
        self.assertEqual(self.call("POST", "/api/v1/private/downloads", {"items": items})[0], 423)
        access = self.unlock()
        status, _, result = self.call("POST", "/api/v1/private/downloads", {"items": items, "destination": "下载/"}, access=access)
        self.assertEqual(status, 201, result)
        task = result["tasks"][0]
        self.assertEqual(task["key"], "下载/子目录/a.bin")
        path = f"/downloads?ids={task['id']}"
        self.assertEqual(self.call("GET", "/api/v1" + path)[2]["tasks"], [])
        with patch("tgdrive.private.time.monotonic", return_value=self.app.private_space.grants[access].expires_at - 10):
            self.assertEqual(len(self.call("GET", "/api/v1/private" + path, access=access)[2]["tasks"]), 1)
            self.assertEqual(self.call("GET", "/api/v1/private/status")[2]["remaining_seconds"], 10)
        self.call("POST", "/api/v1/private/lock", {}, access=access)
        self.assertEqual(self.call("GET", "/api/v1/private" + path, access=access)[0], 423)

    def test_only_dedicated_unlock_page_allows_framing(self):
        directory = Path(self.temp.name) / "static"
        (directory / "grabber").mkdir(parents=True)
        (directory / "index.html").write_text("main")
        (directory / "grabber/index.html").write_text("unlock")
        self.app.static_dir = directory.resolve()
        status, headers, _ = asyncio.run(self.http.request("GET", "/", headers={}))
        self.assertEqual((status, headers["x-frame-options"]), (200, "DENY"))
        status, headers, _ = asyncio.run(self.http.request("GET", "/grabber/index.html", headers={}))
        self.assertEqual(status, 200)
        self.assertNotIn("x-frame-options", headers)
        self.assertIn("frame-ancestors *", headers["content-security-policy"])


if __name__ == "__main__":
    unittest.main()
