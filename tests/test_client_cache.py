"""浏览器本地缓存（docs/client-cache-design.md）：密钥派生与绑定、对账范围、私密授权、策略与 Service Worker 注册限制。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.objects import PRIVATE_PREFIX, Scope

DEVICE = "device-aaaaaaaaaaaaaaaaaaaa"
OTHER_DEVICE = "device-bbbbbbbbbbbbbbbbbbbb"


class ClientCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp.name) / "data"
        self.app = create_app(self.data_dir, secure_cookies=False)
        self.client = Client(self.app)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.bob = self.app.accounts.create_user("bob@example.com", "bob password")
        self.user = asyncio.run(self.client.login("user", "alice@example.com", "alice password"))
        self.admin = asyncio.run(self.client.login("admin", "admin@example.com", "admin password"))
        self.scope = Scope(self.alice.bucket_id)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def call(self, method, path, payload=None, headers=None):
        body = json.dumps(payload).encode() if payload is not None else b""
        status, response_headers, data = asyncio.run(self.client.request(method, path, body, self.user if headers is None else headers))
        is_json = response_headers.get("content-type", "").startswith("application/json")
        return status, (json.loads(data) if data and is_json else data), response_headers

    def put(self, key, data=b"content"):
        return asyncio.run(self.app.objects.put_object(Scope(self.alice.bucket_id, private_access=True), key, data))

    def session(self, device=DEVICE, headers=None):
        status, data, response = self.call("POST", "/api/user/v1/cache/session", {"device": device}, headers)
        self.assertEqual(status, 200, data)
        self.assertEqual(response["cache-control"], "no-store")
        return data

    def unlock(self):
        status, data, _ = self.call("POST", "/api/user/v1/private/setup", {"password": "alice password"})
        self.assertIn(status, (200, 201), data)
        return {**self.user, "x-private-access": data["access"]}

    def enable_private(self):
        status, data, _ = self.call("POST", "/api/admin/v1/client-cache", {"private_enabled": True}, self.admin)
        self.assertEqual((status, data["private_enabled"]), (200, True))

    def test_tier_key_is_stable_and_bound_to_device_password_and_epoch(self):
        first = self.session()
        self.assertEqual(first, self.session(), "同一设备重复获取得到同一把密钥")
        self.assertEqual(first["bucket_id"], self.alice.bucket_id)
        self.assertTrue(first["policy"]["enabled"])
        self.assertNotEqual(first["key"], self.session(OTHER_DEVICE)["key"])
        self.assertEqual(first["namespace"], self.session(OTHER_DEVICE)["namespace"], "命名空间只区分账号")
        bob = asyncio.run(self.client.login("user", "bob@example.com", "bob password"))
        self.assertNotEqual(first["namespace"], self.session(headers=bob)["namespace"])
        self.assertEqual(self.call("POST", "/api/user/v1/cache/reset", {}, {"cookie": self.user["cookie"]})[0], 403, "重置需要 CSRF")
        self.assertEqual(self.call("POST", "/api/user/v1/cache/reset", {})[0], 200)
        reset = self.session()
        self.assertNotEqual(first["key"], reset["key"])
        self.assertEqual(first["namespace"], reset["namespace"])
        status, _, _ = self.call("POST", "/api/user/v1/password", {"old_password": "alice password", "new_password": "alice new password"})
        self.assertIn(status, (200, 204))
        self.assertNotEqual(reset["key"], self.session()["key"], "改密码后旧缓存无法解开")

    def test_master_key_survives_passphrase_rotation(self):
        key = self.session()["key"]
        self.app.keystore.rotate("encryption passphrase", "another encryption passphrase")
        self.app.client_cache._cached = None
        self.assertEqual(self.session()["key"], key)

    def test_disabled_policy_returns_no_key_and_session_required(self):
        self.assertEqual(self.call("POST", "/api/user/v1/cache/session", {"device": DEVICE}, {})[0], 401)
        self.assertEqual(self.call("POST", "/api/user/v1/cache/session", {"device": "short"})[0], 400)
        self.assertEqual(self.call("POST", "/api/admin/v1/client-cache", {"enabled": False})[0], 403, "普通用户不能修改策略")
        self.assertEqual(self.call("POST", "/api/admin/v1/client-cache", {"max_mib": 1}, self.admin)[0], 400)
        self.assertEqual(self.call("POST", "/api/admin/v1/client-cache", {"enabled": False}, self.admin)[0], 200)
        self.assertNotIn("key", self.session())

    def test_check_only_keeps_versions_referenced_in_normal_area(self):
        kept = self.put("photos/a.jpg", b"a")
        self.put("photos/copy.jpg", b"a")
        trashed = self.put("photos/b.jpg", b"b")
        hidden = self.put(PRIVATE_PREFIX + "c.jpg", b"c")
        bob = asyncio.run(self.app.objects.put_object(Scope(self.bob.bucket_id), "x.jpg", b"x"))
        self.assertEqual(self.call("POST", "/api/user/v1/delete", {"paths": ["photos/b.jpg"]})[0], 200)
        etags = [kept.etag, trashed.etag, hidden.etag, bob.etag, "missing"]
        self.assertEqual(self.call("POST", "/api/user/v1/cache/check", {"etags": etags})[1], {"valid": [kept.etag]})
        self.assertEqual(self.call("POST", "/api/user/v1/cache/check", {"etags": ["x"] * 501})[0], 400)

    def test_private_tier_requires_policy_and_grant_and_filters_by_area(self):
        visible = self.put(PRIVATE_PREFIX + "a.jpg", b"secret-a")
        normal = self.put("plain.jpg", b"plain")
        private = self.unlock()
        payload = {"device": DEVICE, "etags": [visible.etag, normal.etag]}
        self.assertEqual(self.call("POST", "/api/user/v1/private/cache/session", {"device": DEVICE}, private)[0], 403, "默认关闭")
        self.enable_private()
        self.assertEqual(self.call("POST", "/api/user/v1/private/cache/session", {"device": DEVICE})[0], 423, "需要私密授权")
        status, session, headers = self.call("POST", "/api/user/v1/private/cache/session", {"device": DEVICE}, private)
        self.assertEqual((status, headers["cache-control"]), (200, "no-store"))
        self.assertNotEqual(session["key"], self.session()["key"], "两层密钥不同")
        status, data, _ = self.call("POST", "/api/user/v1/private/cache/keys", payload, private)
        self.assertEqual(status, 200)
        self.assertIsNone(data["keys"][normal.etag], "普通区的版本不给私密密钥")
        entry = data["keys"][visible.etag]
        self.assertEqual(len(entry["id"]), 32)
        self.assertEqual(data, self.call("POST", "/api/user/v1/private/cache/keys", payload, private)[1])
        other = self.call("POST", "/api/user/v1/private/cache/keys", {**payload, "device": OTHER_DEVICE}, private)[1]
        self.assertNotEqual(entry, other["keys"][visible.etag])
        self.assertEqual(self.call("POST", "/api/user/v1/private/lock", {}, private)[0], 204)
        self.assertEqual(self.call("POST", "/api/user/v1/private/cache/keys", payload, private)[0], 423, "锁定后不再下发")

    def test_service_worker_registration_is_limited_to_sw_script(self):
        self.put("evil.js", b"self.onfetch=()=>{}")
        status, _, _ = self.call("GET", "/api/user/v1/content?path=evil.js", headers={**self.user, "service-worker": "script"})
        self.assertEqual(status, 403)
        self.assertEqual(self.call("GET", "/api/user/v1/content?path=evil.js")[0], 200)
