"""“保持登录”：长期会话持久化到数据库（只存令牌哈希），服务重启后仍有效，退出、改密码、禁用、锁定时立即失效。"""
import asyncio
import json
import re
import tempfile
import time
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app


class RememberLoginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "data"
        self.app = create_app(self.data, secure_cookies=False)
        self.app.accounts.setup("encryption passphrase", "admin", "admin password")
        self.alice = self.app.accounts.create_user("alice", "alice password")
        self.client = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def restart(self):
        """模拟重启服务：新进程、内存会话丢失、系统处于锁定状态。"""
        self.app.metadata.close()
        self.app = create_app(self.data, secure_cookies=False)
        self.client = Client(self.app)

    async def login(self, username="alice", password="alice password", remember=None):
        payload = {"username": username, "password": password}
        if remember is not None:
            payload["remember"] = remember
        status, headers, data = await self.client.request("POST", "/api/auth/v1/login", json.dumps(payload).encode())
        self.assertEqual(status, 200, data)
        body = json.loads(data)
        return headers["set-cookie"], {"cookie": headers["set-cookie"].split(";", 1)[0], "x-csrf-token": body["csrf_token"]}, body

    async def me(self, auth):
        status, _, data = await self.client.request("GET", "/api/auth/v1/me", b"", {"cookie": auth["cookie"]})
        return status, (json.loads(data) if status == 200 else None)

    def unlock(self):
        self.app.accounts.keystore.unlock("encryption passphrase")

    def test_cookie_lifetime_depends_on_remember(self):
        async def run():
            cookie, _, body = await self.login()
            self.assertEqual((int(re.search(r"Max-Age=(\d+)", cookie).group(1)), body["remember"]), (12 * 3600, False))
            cookie, _, body = await self.login(remember=True)
            age = int(re.search(r"Max-Age=(\d+)", cookie).group(1))
            self.assertTrue(30 * 86400 - 5 <= age <= 30 * 86400, age)
            self.assertTrue(body["remember"])
            self.assertLessEqual(abs(body["expires_at"] - (time.time() + 30 * 86400)), 5)
        asyncio.run(run())

    def test_remembered_session_survives_a_restart_but_a_normal_one_does_not(self):
        async def run():
            _, remembered, _ = await self.login(remember=True)
            _, ordinary, _ = await self.login(remember=False)
            self.restart()
            self.unlock()
            status, me = await self.me(remembered)
            self.assertEqual((status, me["username"], me["remember"], me["csrf_token"]), (200, "alice", True, remembered["x-csrf-token"]))
            self.assertEqual((await self.me(ordinary))[0], 401)
            # 恢复的会话和原来一样能做写操作（CSRF 令牌不变）
            status, _, _ = await self.client.request("PUT", "/api/user/v1/files?path=a.txt", b"x", {**remembered, "content-length": "1"})
            self.assertEqual(status, 200)
        asyncio.run(run())

    def test_only_the_hash_of_the_token_is_stored(self):
        async def run():
            _, auth, _ = await self.login(remember=True)
            token = auth["cookie"].split("=", 1)[1]
            rows = self.app.metadata.db.execute("SELECT token_hash, csrf_token FROM sessions").fetchall()
            self.assertEqual(len(rows), 1)
            self.assertNotEqual(rows[0]["token_hash"], token)
            dump = "\n".join(self.app.metadata.db.iterdump())
            self.assertNotIn(token, dump)
            # 普通会话不落库
            await self.login(remember=False)
            self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 1)
        asyncio.run(run())

    def test_logout_password_change_disable_and_lock_end_remembered_sessions(self):
        async def run():
            _, first, _ = await self.login(remember=True)
            status, _, _ = await self.client.request("POST", "/api/auth/v1/logout", b"", first)
            self.assertEqual(status, 204)
            self.restart(); self.unlock()
            self.assertEqual((await self.me(first))[0], 401)

            _, second, _ = await self.login(remember=True)
            _, other_device, _ = await self.login(remember=True)
            payload = json.dumps({"old_password": "alice password", "new_password": "another password"}).encode()
            status, _, _ = await self.client.request("POST", "/api/auth/v1/password", payload, second)
            self.assertEqual(status, 204)
            self.restart(); self.unlock()
            # 改密码后其他设备上的登录失效，只保留当前这一个
            self.assertEqual((await self.me(other_device))[0], 401)
            self.assertEqual((await self.me(second))[0], 200)

            _, third, _ = await self.login(password="another password", remember=True)
            self.app.accounts.set_account_status(self.alice.id, "disabled")
            self.restart(); self.unlock()
            self.assertEqual((await self.me(third))[0], 401)
            self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)

            self.app.accounts.set_account_status(self.alice.id, "active")
            _, fourth, _ = await self.login(password="another password", remember=True)
            _, admin, _ = await self.login("admin", "admin password", remember=True)
            status, _, _ = await self.client.request("POST", "/api/admin/v1/lock", b"{}", admin)
            self.assertEqual(status, 204)
            self.restart(); self.unlock()
            self.assertEqual((await self.me(fourth))[0], 401)
            self.assertEqual((await self.me(admin))[0], 401)
        asyncio.run(run())

    def test_expired_remembered_session_is_rejected_and_removed(self):
        async def run():
            _, auth, _ = await self.login(remember=True)
            self.app.metadata.db.execute("UPDATE sessions SET expires_at = ?", (time.time() - 1,))
            self.app.metadata.db.commit()
            self.restart(); self.unlock()
            self.assertEqual((await self.me(auth))[0], 401)
            self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)
        asyncio.run(run())

    def test_remembered_user_after_restart_sees_the_locked_state_until_unlocked(self):
        async def run():
            _, auth, _ = await self.login(remember=True)
            self.restart()  # 重启后系统锁定
            status, me = await self.me(auth)
            self.assertEqual((status, me["unlocked"]), (200, False))
            status, _, _ = await self.client.request("GET", "/api/user/v1/list", b"", {"cookie": auth["cookie"]})
            self.assertEqual(status, 503)
            self.unlock()
            status, _, _ = await self.client.request("GET", "/api/user/v1/list", b"", {"cookie": auth["cookie"]})
            self.assertEqual(status, 200)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
