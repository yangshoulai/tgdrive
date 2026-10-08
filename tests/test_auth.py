import datetime as dt
import hashlib
import hmac
import json
import tempfile
import unittest
from pathlib import Path

from tgdrive.accounts import AccountService
from tgdrive.api import AdminApi, UserApi
from tgdrive.app import create_app
from tgdrive.asgi import TgDriveASGI
from tgdrive.authn import (
    AuthenticationError,
    CsrfError,
    SessionManager,
    hash_password,
    verify_password,
)
from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.keystore import KeyStore
from tgdrive.metadata import Metadata
from tgdrive.s3.sigv4 import SigV4Verifier


class M5Tests(unittest.TestCase):
    def test_password_hash_and_session_csrf(self):
        encoded = hash_password("correct horse battery")
        self.assertTrue(verify_password("correct horse battery", encoded))
        self.assertFalse(verify_password("wrong password", encoded))
        manager = SessionManager(ttl=60)
        session = manager.create(1, "admin", "admin")
        self.assertEqual(manager.require(session.token, role="admin").user_id, 1)
        with self.assertRaises(CsrfError):
            manager.require(session.token, mutation=True, csrf="bad")
        manager.require(session.token, mutation=True, csrf=session.csrf_token)

    def test_setup_login_user_bucket_and_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            metadata = Metadata(Path(temp) / "meta.db")
            keys = KeyStore(metadata)
            accounts = AccountService(metadata, keys)
            admin = accounts.setup("encryption passphrase", "admin", "admin password")
            self.assertEqual(admin.role, "admin")
            self.assertTrue(accounts.status()["initialized"])
            self.assertTrue(accounts.status()["unlocked"])
            session = accounts.login("admin", "admin password", role="admin")
            user = accounts.create_user("alice", "alice password")
            self.assertIsNotNone(user.bucket_id)
            self.assertEqual(accounts.account_for_session(session).bucket_id, admin.bucket_id)
            with self.assertRaises(AuthenticationError):
                accounts.login("alice", "bad password")
            keys.lock()
            self.assertFalse(accounts.status()["unlocked"])

    def test_admin_and_user_api_flow(self):
        import asyncio
        async def run():
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                metadata = Metadata(root / "meta.db")
                keys = KeyStore(metadata)
                accounts = AccountService(metadata, keys)
                from tgdrive.objects import ObjectService
                from tgdrive.s3.auth import ClientAuthStore
                objects = ObjectService(metadata, BlobEngine(metadata, LocalDiskBlobStore(root / "blobs"), b"0" * 32,
                                                             chunk_size=32, frame_size=8))
                admin_api = AdminApi(accounts, objects, ClientAuthStore(metadata, keystore=keys))
                admin_api.setup("encryption passphrase", "admin", "admin password")
                # 初始化后客户端密钥服务必须使用实际解锁的 KEK。
                admin = admin_api.login("admin", "admin password")
                user = admin_api.create_user(admin["session"], admin["csrf_token"], "alice", "alice password")
                self.assertEqual(admin_api.list_users(admin["session"])[1]["username"], "alice")
                created_client = admin_api.create_client(admin["session"], admin["csrf_token"], "backup", [])
                clients = admin_api.list_clients(admin["session"])
                self.assertEqual(clients[0]["name"], "backup")
                admin_api.disable_client_key(admin["session"], admin["csrf_token"], created_client["access_key_id"])
                user_api = UserApi(accounts, objects)
                # 统一登录：管理员也能登录文件空间并使用自己的存储桶，普通用户的会话调用不了管理接口。
                admin_session = user_api.login("admin", "admin password")
                self.assertEqual(admin_session["role"], "admin")
                await user_api.put(admin_session["session"], admin_session["csrf_token"], "mine.txt", b"x", "text/plain")
                self.assertEqual(user_api.me(admin_session["session"])["role"], "admin")
                login = user_api.login("alice", "alice password")
                with self.assertRaises(PermissionError):
                    admin_api.list_users(login["session"])
                await user_api.put(login["session"], login["csrf_token"], "docs/a.txt", b"hello", "text/plain")
                listing = await user_api.list(login["session"], prefix="docs/")
                self.assertEqual(listing["objects"][0]["key"], "docs/a.txt")
                info, stream = await user_api.content(login["session"], "docs/a.txt", 1, 4)
                self.assertEqual((info.size, b"".join([part async for part in stream])), (5, b"ell"))
                admin_api.set_user_status(admin["session"], admin["csrf_token"], user["id"], "disabled")
                self.assertEqual(admin_api.list_users(admin["session"])[1]["status"], "disabled")
                metadata.close()
        asyncio.run(run())

    def test_asgi_setup_login_and_status(self):
        import asyncio
        async def run():
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                metadata = Metadata(root / "meta.db")
                keys = KeyStore(metadata)
                accounts = AccountService(metadata, keys)
                from tgdrive.objects import ObjectService
                from tgdrive.s3.auth import ClientAuthStore
                objects = ObjectService(metadata, BlobEngine(metadata, LocalDiskBlobStore(root / "blobs"), b"1" * 32,
                                                             chunk_size=32, frame_size=8))
                app = TgDriveASGI(AdminApi(accounts, objects, ClientAuthStore(metadata, b"1" * 32)), UserApi(accounts, objects))

                async def request(method, path, body=b"", headers=None):
                    sent = []
                    queue = [{"type": "http.request", "body": body, "more_body": False}]
                    async def receive(): return queue.pop(0)
                    async def send(message): sent.append(message)
                    await app({"type": "http", "method": method, "path": path.split("?", 1)[0],
                               "query_string": path.split("?", 1)[1].encode() if "?" in path else b"",
                               "headers": [(k.encode(), v.encode()) for k, v in (headers or {}).items()]}, receive, send)
                    return sent

                status = await request("GET", "/api/admin/v1/status")
                self.assertEqual(status[0]["status"], 200)
                setup = await request("POST", "/api/admin/v1/setup", b'{"passphrase":"encryption passphrase","username":"admin","password":"admin password"}', {"content-type":"application/json"})
                self.assertEqual(setup[0]["status"], 201)
                app.admin.accounts.create_user("alice", "alice password")
                login_messages = await request("POST", "/api/user/v1/login", b'{"username":"alice","password":"alice password"}', {"content-type":"application/json"})
                login_body = json.loads(login_messages[-1]["body"])
                cookie = login_messages[0]["headers"]
                session_cookie = next(value.decode() for key, value in cookie if key.lower() == b"set-cookie").split(";", 1)[0]
                auth_headers = {"cookie": session_cookie, "x-csrf-token": login_body["csrf_token"], "content-length": "5"}
                put = await request("PUT", "/api/user/v1/files?path=hello.txt", b"hello", auth_headers)
                self.assertEqual(put[0]["status"], 200)
                content = await request("GET", "/api/user/v1/content?path=hello.txt", b"", {"cookie": session_cookie, "range": "bytes=1-3"})
                self.assertEqual(content[0]["status"], 206)
                self.assertEqual(b"".join(message.get("body", b"") for message in content[1:]), b"ell")
                metadata.close()
        asyncio.run(run())

    def test_application_factory_keeps_keystore_dynamic(self):
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(temp)
            self.assertFalse(app.keystore.unlocked)
            self.assertEqual(app.accounts.status()["initialized"], False)
            app.metadata.close()

    def test_asgi_mounts_s3_signed_routes(self):
        import asyncio

        async def run():
            with tempfile.TemporaryDirectory() as temp:
                app = create_app(temp)
                account = app.accounts.setup("encryption passphrase", "admin", "admin password")
                bucket_id = app.objects.create_bucket("s3-test")
                client_id = app.s3.auth.create_client("asgi-test")
                access_key, secret = app.s3.auth.create_key(client_id)
                app.s3.auth.grant(client_id, bucket_id, "", "rw")
                verifier = SigV4Verifier()
                now = dt.datetime.now(dt.UTC)

                def signed(method: str, path: str, body: bytes = b""):
                    stamp = now.strftime("%Y%m%dT%H%M%SZ")
                    date = now.strftime("%Y%m%d")
                    payload = hashlib.sha256(body).hexdigest()
                    signed_names = "host;x-amz-content-sha256;x-amz-date"
                    canonical = "\n".join((method, path, "", "host:s3.example.test\n"
                                             "x-amz-content-sha256:" + payload + "\n"
                                             "x-amz-date:" + stamp + "\n", signed_names, payload))
                    scope = f"{date}/us-east-1/s3/aws4_request"
                    string_to_sign = "\n".join(("AWS4-HMAC-SHA256", stamp, scope,
                                                 hashlib.sha256(canonical.encode()).hexdigest()))
                    signature = hmac.new(verifier._signing_key(secret, date, "us-east-1", "s3"),
                                         string_to_sign.encode(), hashlib.sha256).hexdigest()
                    return {
                        "host": "s3.example.test",
                        "x-amz-date": stamp,
                        "x-amz-content-sha256": payload,
                        "authorization": (
                            f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
                            f"SignedHeaders={signed_names}, Signature={signature}"
                        ),
                    }

                async def request(method: str, path: str, body: bytes = b""):
                    headers = signed(method, path, body)
                    sent = []
                    queue = [{"type": "http.request", "body": body, "more_body": False}]

                    async def receive():
                        return queue.pop(0)

                    async def send(message):
                        sent.append(message)

                    await app({"type": "http", "method": method, "path": path,
                               "query_string": b"", "scheme": "http",
                               "headers": [(key.encode(), value.encode()) for key, value in headers.items()]},
                              receive, send)
                    return sent

                put = await request("PUT", "/s3-test/hello.txt", b"hello")
                self.assertEqual(put[0]["status"], 200)
                get = await request("GET", "/s3-test/hello.txt")
                self.assertEqual(get[0]["status"], 200)
                self.assertEqual(b"".join(message.get("body", b"") for message in get[1:]), b"hello")
                root = await request("GET", "/")
                self.assertEqual(root[0]["status"], 200)
                self.assertIn(b"s3-test", b"".join(message.get("body", b"") for message in root[1:]))
                head = await request("HEAD", "/s3-test")
                self.assertEqual(head[0]["status"], 200)
                app.metadata.close()

        asyncio.run(run())

    def test_asgi_host_routing_serves_static_spa(self):
        import asyncio

        async def run():
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                static = root / "dist"
                static.mkdir()
                (static / "index.html").write_text("<html>tgdrive</html>", encoding="utf-8")
                app = create_app(root / "data", static_dir=static, s3_host="s3.example.test")
                sent = []
                queue = [{"type": "http.request", "body": b"", "more_body": False}]

                async def receive():
                    return queue.pop(0)

                async def send(message):
                    sent.append(message)

                await app({"type": "http", "method": "GET", "path": "/admin",
                           "query_string": b"", "headers": [(b"host", b"drive.example.test")]}, receive, send)
                self.assertEqual(sent[0]["status"], 200)
                self.assertIn(b"tgdrive", sent[-1]["body"])
                app.metadata.close()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
