"""注册的认证边界、原子核销、验证码生命周期与邮件秘密保护。"""

import asyncio
import json
import smtplib
import ssl
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.authn import hash_password
from tgdrive.mailer import send_mail, verification_message


SMTP = {"host": "smtp.example.com", "port": 465, "security": "ssl", "username": "mailer@example.com",
        "sender": "noreply@example.com", "sender_name": "Tessera 文件空间"}


class RegistrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tgdrive-registration-test-")
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.admin = self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.service = self.app.registration
        self.client = Client(self.app)
        self.messages = []
        self.service.sender = lambda config, password, message: self.messages.append(message)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    async def request(self, method, route, body=None, headers=None):
        status, response_headers, data = await self.client.request(method, route,
            json.dumps(body).encode() if body is not None else b"",
            {"content-type": "application/json", **(headers or {})})
        return status, json.loads(data) if data else None, response_headers

    def enable(self, *, email=False, invite=True, quota=10 * 1024 ** 3):
        return self.service.configure({"enabled": True, "email_enabled": email, "invite_enabled": invite,
            "default_quota_bytes": quota, "smtp": SMTP, "smtp_password": "smtp-secret-password"})

    def invites(self, count=1, **options):
        return self.service.create_invitations({"count": count, "expires_at": time.time() + 3600, **options}, self.admin.id)["invites"]

    async def register(self, email="new@example.com", **options):
        return await self.request("POST", "/api/auth/v1/register", {"email": email, "password": "new user password", **options})

    async def send_code(self, email="new@example.com", code=804321):
        with patch("tgdrive.registration.secrets.randbelow", return_value=code):
            return await self.request("POST", "/api/auth/v1/registration/code", {"email": email})

    async def test_registration_starts_closed_and_lock_pauses_both_methods(self):
        status, config, headers = await self.request("GET", "/api/auth/v1/registration")
        self.assertEqual(status, 200)
        self.assertFalse(config["enabled"])
        self.assertNotIn("smtp", config)
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual((await self.register(method="invite", invite_code="x" * 24))[0], 400)
        self.assertEqual((await self.send_code())[0], 400)
        self.enable(email=True)
        invite = self.invites()[0]
        self.app.keystore.lock()
        self.assertFalse((await self.request("GET", "/api/auth/v1/registration"))[1]["available"])
        self.assertEqual((await self.register(method="invite", invite_code=invite["code"]))[0], 503)
        self.assertEqual((await self.send_code())[0], 503)

    async def test_admin_endpoints_require_role_csrf_and_hide_password(self):
        self.enable(email=True)
        self.app.accounts.create_user("alice@example.com", "alice password")
        ordinary = await self.client.login("user", "alice@example.com", "alice password")
        admin = await self.client.login("user", "admin@example.com", "admin password")
        for method, route, payload in (("GET", "/registration", None), ("POST", "/registration", {"enabled": False}),
                ("GET", "/registration/invites", None), ("POST", "/registration/invites", {"count": 1}),
                ("POST", "/registration/test-email", {"email": "recipient@example.com"}),
                ("POST", "/registration/invites/1/revoke", {})):
            route = "/api/admin/v1" + route
            self.assertEqual((await self.request(method, route, payload))[0], 401)
            self.assertEqual((await self.request(method, route, payload, ordinary))[0], 403)
            if method == "POST":
                self.assertEqual((await self.request(method, route, payload, {"cookie": admin["cookie"]}))[0], 403)
        status, config, _ = await self.request("GET", "/api/admin/v1/registration", headers=admin)
        self.assertEqual(status, 200)
        self.assertTrue(config["smtp"]["has_password"])
        self.assertNotIn("smtp-secret-password", json.dumps(config))
        status, _, _ = await self.request("POST", "/api/admin/v1/registration/test-email", {"email": "recipient@example.com"}, admin)
        self.assertEqual(status, 200)
        self.assertIn("邮件服务已就绪", self.messages[-1].get_body(preferencelist=("plain",)).get_content())

    async def test_invite_creates_only_normal_user_with_snapshot_quota_and_no_session(self):
        self.enable(quota=12345)
        invite = self.invites()[0]
        self.service.configure({"default_quota_bytes": 67890})
        status, account, headers = await self.register(email="New@Example.COM", method="invite", invite_code=invite["code"], role="admin", quota_bytes=None)
        self.assertEqual(status, 201)
        self.assertEqual(account, {"username": "new@example.com", "quota_bytes": 12345})
        self.assertNotIn("set-cookie", headers)
        row = self.app.metadata.db.execute("SELECT u.role,b.quota_bytes FROM users u JOIN buckets b ON u.bucket_id=b.id WHERE u.username='new@example.com'").fetchone()
        self.assertEqual(tuple(row), ("user", 12345))
        self.assertEqual((await self.register("other@example.com", method="invite", invite_code=invite["code"]))[0], 400)
        login = await self.client.login("user", "new@example.com", "new user password")
        self.assertEqual((await self.request("GET", "/api/auth/v1/me", headers=login))[1]["quota_bytes"], 12345)
        logs = json.dumps([dict(row) for row in self.app.metadata.db.execute("SELECT * FROM audit_log")])
        self.assertNotIn(invite["code"], logs)
        self.assertNotIn("new user password", logs)
        self.assertIn("user.register", logs)

    async def test_failed_registration_does_not_consume_invite(self):
        self.enable()
        invite = self.invites()[0]
        self.assertEqual((await self.register("admin@example.com", method="invite", invite_code=invite["code"]))[0], 400)
        row = self.app.metadata.db.execute("SELECT used_at FROM registration_invites WHERE id=?", (invite["id"],)).fetchone()
        self.assertIsNone(row["used_at"])
        self.assertEqual((await self.register(method="invite", invite_code=invite["code"]))[0], 201)

    async def test_invite_expiry_revocation_pagination_and_validation(self):
        self.enable()
        invitations = self.invites(3, quota_bytes=0)
        with patch("tgdrive.registration.time.time", return_value=invitations[0]["expires_at"] + 1):
            self.assertEqual((await self.register(method="invite", invite_code=invitations[0]["code"]))[0], 400)
        self.service.revoke_invitation(invitations[1]["id"])
        self.assertEqual((await self.register(method="invite", invite_code=invitations[1]["code"]))[0], 400)
        first = self.service.list_invitations(limit=2)
        second = self.service.list_invitations(first["next_cursor"], limit=2)
        self.assertEqual([item["id"] for item in first["invites"] + second["invites"]], [3, 2, 1])
        self.assertEqual(self.service.list_invitations(status="active")["total"], 2)
        for options in ({"count": 101}, {"count": True}, {"expires_at": time.time() - 1}, {"quota_bytes": -1}, {"quota_bytes": True}):
            with self.assertRaises(ValueError):
                self.invites(**options)

    async def test_email_code_is_hashed_single_use_and_mail_has_html_and_text(self):
        self.enable(email=True, invite=False, quota=56789)
        status, _, _ = await self.send_code()
        self.assertEqual(status, 200)
        message = self.messages[-1]
        self.assertIn("804321", message.get_body(preferencelist=("plain",)).get_content())
        html = message.get_body(preferencelist=("html",)).get_content()
        self.assertIn("804321", html)
        self.assertIn("10 分钟", html)
        self.assertIn("Tessera", html)
        self.assertNotIn(b"804321", self.service._codes["new@example.com"].digest)
        self.assertEqual((await self.register(method="email", email_code="804321"))[0], 201)
        self.assertNotIn("new@example.com", self.service._codes)
        self.assertEqual((await self.register(method="email", email_code="804321"))[0], 400)
        self.assertEqual((await self.register("other@example.com", method="email", email_code="804321"))[0], 400)

    async def test_code_resend_expiration_and_five_wrong_guesses(self):
        self.enable(email=True)
        self.assertEqual((await self.send_code())[0], 200)
        self.assertEqual((await self.send_code())[0], 429)
        self.service._codes["new@example.com"].sent -= 61
        self.assertEqual((await self.send_code(code=227799))[0], 200)
        self.assertEqual((await self.register(method="email", email_code="804321"))[0], 400)
        for _ in range(4):
            self.assertEqual((await self.register(method="email", email_code="000000"))[0], 400)
        self.assertNotIn("new@example.com", self.service._codes)
        self.assertEqual((await self.send_code("expired@example.com"))[0], 200)
        self.service._codes["expired@example.com"].expires -= 601
        self.assertEqual((await self.register("expired@example.com", method="email", email_code="804321"))[0], 400)

    async def test_same_invite_cannot_register_twice_concurrently(self):
        self.enable()
        invite = self.invites()[0]
        results = await asyncio.gather(self.register("first@example.com", method="invite", invite_code=invite["code"]),
                                       self.register("second@example.com", method="invite", invite_code=invite["code"]))
        self.assertEqual(sorted(result[0] for result in results), [201, 400])

    async def test_disable_during_password_calculation_is_rechecked(self):
        self.enable()
        invite = self.invites()[0]
        encoded = hash_password("new user password")
        async def interrupted(*args, **kwargs):
            self.service.configure({"enabled": False})
            return encoded
        with patch.object(self.app.accounts.password_work, "run", side_effect=interrupted):
            self.assertEqual((await self.register(method="invite", invite_code=invite["code"]))[0], 400)
        self.assertIsNone(self.app.metadata.db.execute("SELECT used_at FROM registration_invites WHERE id=?", (invite["id"],)).fetchone()["used_at"])
        self.assertIsNone(self.app.metadata.db.execute("SELECT 1 FROM users WHERE username='new@example.com'").fetchone())

    async def test_configuration_clears_codes_and_rotation_keeps_secrets_usable(self):
        self.enable(email=True)
        invite = self.invites()[0]
        await self.send_code()
        self.service.configure({"default_quota_bytes": None})
        self.assertEqual(self.service._codes, {})
        raw = self.app.metadata.db.execute("SELECT value FROM settings WHERE key='registration.smtp_password'").fetchone()["value"]
        self.assertNotIn("smtp-secret-password", raw)
        self.app.keystore.rotate("encryption passphrase", "new encryption passphrase")
        self.assertEqual(self.service._smtp_password(), "smtp-secret-password")
        self.assertEqual(self.service.list_invitations()["invites"][0]["code"], invite["code"])
        self.assertEqual((await self.register(method="invite", invite_code=invite["code"]))[0], 201)

    async def test_json_origin_and_smtp_configuration_validation(self):
        self.enable(email=True)
        status, _, _ = await self.client.request("POST", "/api/auth/v1/register", b'{"email":"new@example.com"}', {"content-type": "text/plain"})
        self.assertEqual(status, 400)
        self.app.settings.update({"public_base_url": "https://drive.example.com"})
        status, _, _ = await self.request("POST", "/api/auth/v1/registration/code", {"email": "new@example.com"}, {"origin": "https://other.example.com"})
        self.assertEqual(status, 403)
        for patch_values in ({"enabled": True, "email_enabled": False, "invite_enabled": False},
                             {"smtp": {"security": "none"}}, {"smtp": {"sender_name": "bad\r\nBcc:bad@example.com"}}):
            with self.assertRaises(ValueError):
                self.service.configure(patch_values)


class RegistrationMailTests(unittest.TestCase):
    def test_smtp_uses_tls_certificate_validation_and_plaintext_fallback(self):
        message = verification_message(SMTP["sender"], SMTP["sender_name"], "new@example.com", "804321")
        for security, constructor in (("ssl", "SMTP_SSL"), ("starttls", "SMTP")):
            with self.subTest(security=security), patch("tgdrive.mailer.smtplib." + constructor) as factory:
                smtp = MagicMock()
                factory.return_value.__enter__.return_value = smtp
                send_mail({**SMTP, "security": security}, "test-password", message)
                context = factory.call_args.kwargs["context"] if security == "ssl" else smtp.starttls.call_args.kwargs["context"]
                self.assertTrue(context.check_hostname)
                self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
                smtp.login.assert_called_once_with(SMTP["username"], "test-password")
                smtp.send_message.assert_called_once()
        self.assertIsNotNone(message.get_body(preferencelist=("plain",)))
        self.assertIsNotNone(message.get_body(preferencelist=("html",)))

    def test_smtp_error_does_not_expose_upstream_credentials(self):
        message = verification_message(SMTP["sender"], SMTP["sender_name"], "new@example.com", "804321")
        with patch("tgdrive.mailer.smtplib.SMTP_SSL", side_effect=smtplib.SMTPAuthenticationError(535, b"leaked-secret")):
            with self.assertRaises(ValueError) as caught:
                send_mail(SMTP, "test-password", message)
            self.assertNotIn("leaked-secret", str(caught.exception))
            self.assertIn("认证失败", str(caught.exception))
