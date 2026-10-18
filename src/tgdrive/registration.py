"""访客注册、一次性邀请码和注册邮件配置。"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import math
import re
import secrets
import time
from dataclasses import dataclass

from .accounts import AccountService, normalize_email
from .authn import SessionManager, TooManyAttempts, hash_password
from .crypto import derive_subkey, open_sealed, seal
from .errors import NotFoundError, NotReadyError
from .mailer import send_mail, verification_message
from .work import PasswordWork


CONFIG_KEY = "registration.config"
SMTP_PASSWORD_KEY = "registration.smtp_password"
SECRET_CONTEXT = "registration-secret"
DEFAULT_CONFIG = {
    "enabled": False, "email_enabled": False, "invite_enabled": True,
    "default_quota_bytes": 500 * 1024 ** 3,
    "smtp": {"host": "", "port": 465, "security": "ssl", "username": "", "sender": "", "sender_name": "Tessera"},
}


def quota_value(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 2 ** 53 - 1:
        raise ValueError("额度必须为非负整数，或留空表示不限")
    return value


@dataclass
class EmailCode:
    digest: bytes
    expires: float
    sent: float
    generation: int
    attempts: int = 0
    ready: bool = False


class RegistrationService:
    CODE_TTL = 600
    RESEND_DELAY = 60
    MAX_CODES = 5000

    def __init__(self, accounts: AccountService) -> None:
        self.accounts, self.metadata, self.keystore = accounts, accounts.metadata, accounts.keystore
        self._codes: dict[str, EmailCode] = {}
        self._pepper = secrets.token_bytes(32)
        self._generation = 0
        self._limits = SessionManager()
        # SMTP 为阻塞 I/O，复用带取消保护的线程名额，断开的请求不能提前释放发送名额。
        self._mail_work = PasswordWork(2)
        self.sender = send_mail

    def config(self) -> dict:
        row = self.metadata.db.execute("SELECT value FROM settings WHERE key=?", (CONFIG_KEY,)).fetchone()
        return json.loads(row["value"]) if row else {**DEFAULT_CONFIG, "smtp": dict(DEFAULT_CONFIG["smtp"])}

    def describe(self) -> dict:
        config = self.config()
        has_password = self.metadata.db.execute("SELECT 1 FROM settings WHERE key=?", (SMTP_PASSWORD_KEY,)).fetchone() is not None
        return {**config, "smtp": {**config["smtp"], "has_password": has_password}}

    def public_config(self) -> dict:
        config = self.config()
        available = bool(config["enabled"] and self.keystore.unlocked)
        return {"enabled": bool(config["enabled"]), "available": available,
                "email_enabled": bool(config["email_enabled"]), "invite_enabled": bool(config["invite_enabled"]),
                "default_quota_bytes": config["default_quota_bytes"],
                "code_ttl": self.CODE_TTL, "resend_delay": self.RESEND_DELAY}

    def _seal(self, text: str, aad: str) -> bytes:
        return seal(derive_subkey(self.keystore.require_kek(), SECRET_CONTEXT), text.encode(), aad)

    def _open(self, data: bytes, aad: str) -> str:
        return open_sealed(derive_subkey(self.keystore.require_kek(), SECRET_CONTEXT), data, aad).decode()

    def _smtp_password(self) -> str:
        row = self.metadata.db.execute("SELECT value FROM settings WHERE key=?", (SMTP_PASSWORD_KEY,)).fetchone()
        return self._open(base64.b64decode(row["value"]), SMTP_PASSWORD_KEY) if row else ""

    @staticmethod
    def _text(value: object, label: str, limit: int = 254) -> str:
        if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError(f"{label}不合法")
        return value.strip()

    def configure(self, values: dict) -> dict:
        current = self.config()
        if set(values) - {*DEFAULT_CONFIG, "smtp_password", "clear_smtp_password"}:
            raise ValueError("注册配置包含未知字段")
        config = {**current, **{key: values[key] for key in DEFAULT_CONFIG if key in values and key != "smtp"}}
        for key in ("enabled", "email_enabled", "invite_enabled"):
            if not isinstance(config[key], bool):
                raise ValueError("注册开关必须为布尔值")
        config["default_quota_bytes"] = quota_value(config["default_quota_bytes"])
        if config["enabled"] and not (config["email_enabled"] or config["invite_enabled"]):
            raise ValueError("开启注册时至少选择一种验证方式")
        smtp_values = values.get("smtp", {})
        if not isinstance(smtp_values, dict) or set(smtp_values) - set(DEFAULT_CONFIG["smtp"]):
            raise ValueError("邮件服务器配置不合法")
        smtp = {**current["smtp"], **smtp_values}
        for key, label in (("host", "邮件服务器"), ("username", "邮件账号"), ("sender", "发件邮箱"), ("sender_name", "发件人名称")):
            smtp[key] = self._text(smtp[key], label)
        if smtp["host"] and (re.search(r"[\s/@?#]", smtp["host"]) or ":" in smtp["host"]):
            raise ValueError("邮件服务器只填写主机名或 IPv4 地址，端口单独填写")
        if isinstance(smtp["port"], bool) or not isinstance(smtp["port"], int) or not 1 <= smtp["port"] <= 65535:
            raise ValueError("邮件服务器端口必须在 1–65535 之间")
        if smtp["security"] not in ("ssl", "starttls"):
            raise ValueError("邮件连接必须使用 SSL/TLS 或 STARTTLS")
        if smtp["sender"]:
            smtp["sender"] = normalize_email(smtp["sender"])
        password = values.get("smtp_password", "")
        if not isinstance(password, str) or len(password) > 4096 or "\x00" in password:
            raise ValueError("邮件密码不合法")
        clear_password = values.get("clear_smtp_password", False)
        if not isinstance(clear_password, bool) or (clear_password and password):
            raise ValueError("邮件密码清除选项不合法")
        config["smtp"] = smtp
        if config["enabled"] and config["email_enabled"]:
            self._require_smtp(smtp, password if password else "" if clear_password else self._smtp_password())
        secret = base64.b64encode(self._seal(password, SMTP_PASSWORD_KEY)).decode() if password else None
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (CONFIG_KEY, json.dumps(config, separators=(",", ":"))))
            if clear_password:
                db.execute("DELETE FROM settings WHERE key=?", (SMTP_PASSWORD_KEY,))
            elif secret is not None:
                db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (SMTP_PASSWORD_KEY, secret))
        self._generation += 1
        self._codes.clear()
        return self.describe()

    @staticmethod
    def _require_smtp(smtp: dict, password: str) -> None:
        if not smtp["host"] or not smtp["sender"] or (smtp["username"] and not password):
            raise ValueError("请先配置邮件服务器、发件邮箱，以及邮件账号所需的密码或授权码")

    def _require_open(self, method: str) -> dict:
        if not self.keystore.unlocked:
            raise NotReadyError("system is locked")
        config = self.config()
        if method not in ("email", "invite") or not config["enabled"] or not config[f"{method}_enabled"]:
            raise ValueError("当前注册方式未开放，请返回登录页或联系管理员")
        return config

    def _budget(self, kind: str, email: str, ip: str | None) -> None:
        limits = [(f"{kind}:email:{email}", 5 if kind == "mail" else 15),
                  (f"{kind}:ip:{ip or '-'}", 20 if kind == "mail" else 40)]
        if kind == "mail":
            limits.append(("mail:global", 200))
        if any(self._limits.is_rate_limited(key, limit=limit) for key, limit in limits):
            raise TooManyAttempts("验证请求过于频繁，请 15 分钟后再试")
        for key, _ in limits:
            self._limits.record_failure(key)

    def _digest(self, email: str, code: str) -> bytes:
        return hmac.digest(self._pepper, f"{email}\0{code}".encode(), "sha256")

    async def send_code(self, value: object, ip: str | None) -> dict:
        config = self._require_open("email")
        email = normalize_email(value)
        self._budget("mail", email, ip)
        now = time.monotonic()
        previous = self._codes.get(email)
        if previous and now - previous.sent < self.RESEND_DELAY:
            raise TooManyAttempts("验证码发送过于频繁，请 60 秒后重试")
        self._codes = {key: item for key, item in self._codes.items() if item.expires > now}
        if len(self._codes) >= self.MAX_CODES:
            raise TooManyAttempts("验证请求过多，请稍后重试")
        password = self._smtp_password()
        self._require_smtp(config["smtp"], password)
        code = f"{secrets.randbelow(1_000_000):06d}"
        pending = EmailCode(self._digest(email, code), now + self.CODE_TTL, now, self._generation)
        self._codes[email] = pending
        message = verification_message(config["smtp"]["sender"], config["smtp"]["sender_name"], email, code)
        try:
            # 同一邮箱并发请求在第一次 await 前就已保留发送时间，不能绕过冷却时间。
            await self._send(config["smtp"], password, message, lambda: self._require_open("email"))
            if self._codes.get(email) is pending and pending.generation == self._generation:
                pending.ready = True
            else:
                raise ValueError("注册配置已更新，请重新获取验证码")
        except BaseException:
            if self._codes.get(email) is pending:
                self._codes.pop(email, None)
            raise
        return {"sent": True, "resend_after": self.RESEND_DELAY, "expires_in": self.CODE_TTL}

    async def _send(self, config, password, message, authorize) -> None:
        try:
            async with asyncio.timeout(35):
                await self._mail_work.run(self.sender, config, password, message, before=authorize)
        except TimeoutError:
            raise ValueError("邮件发送超时，请稍后重试或联系管理员") from None

    async def test_email(self, recipient: object, authorize) -> dict:
        self._budget("mail", normalize_email(recipient), "admin-test")
        config = self.config()["smtp"]
        password = self._smtp_password()
        self._require_smtp(config, password)
        message = verification_message(config["sender"], config["sender_name"], normalize_email(recipient), "123456", test=True)
        await self._send(config, password, message, authorize)
        return {"sent": True}

    def _invitation(self, code: object):
        if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9_-]{24}", code):
            raise ValueError("邀请码无效、已使用或已过期")
        row = self.metadata.db.execute("SELECT * FROM registration_invites WHERE code_hash=?", (hashlib.sha256(code.encode()).hexdigest(),)).fetchone()
        if row is None or row["used_at"] is not None or row["revoked_at"] is not None or row["expires_at"] <= time.time():
            raise ValueError("邀请码无效、已使用或已过期")
        return row

    def _email_code(self, email: str, code: object, *, expected: EmailCode | None = None) -> EmailCode:
        pending = self._codes.get(email)
        if pending is None or not pending.ready or pending.expires <= time.monotonic() or pending.generation != self._generation:
            raise ValueError("验证码无效或已过期，请重新获取")
        if expected is not None and pending is not expected:
            raise ValueError("验证码已更新，请使用最新收到的验证码")
        if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code) or not hmac.compare_digest(pending.digest, self._digest(email, code)):
            pending.attempts += 1
            if pending.attempts >= 5:
                self._codes.pop(email, None)
            raise ValueError("验证码不正确，连续错误 5 次后需重新获取")
        return pending

    async def register(self, values: dict, ip: str | None) -> dict:
        method = values.get("method")
        self._require_open(method)
        email = normalize_email(values.get("email"))
        password = values.get("password")
        if not isinstance(password, str) or not 8 <= len(password) <= 1024:
            raise ValueError("登录密码需要 8–1024 个字符")
        self._budget("register", email, ip)
        pending = None
        if method == "invite":
            self._invitation(values.get("invite_code"))
        else:
            pending = self._email_code(email, values.get("email_code"))
        encoded = await self.accounts.password_work.run(hash_password, password, before=lambda: self._require_open(method))
        # 密码计算会让出事件循环；提交时复核开关、额度、验证版本和邀请码状态。
        with self.metadata.transaction() as db:
            config = self._require_open(method)
            if method == "invite":
                invite = self._invitation(values.get("invite_code"))
                quota = invite["quota_bytes"]
            else:
                self._email_code(email, values.get("email_code"), expected=pending)
                quota = config["default_quota_bytes"]
            account = self.accounts._create_account(email, password, "user", quota, encoded=encoded)
            if method == "invite":
                db.execute("UPDATE registration_invites SET used_at=?,used_by=? WHERE id=?", (time.time(), account.id, invite["id"]))
        self._codes.pop(email, None)
        return {"username": account.username, "quota_bytes": quota}

    def create_invitations(self, values: dict, creator: int) -> dict:
        count = values.get("count", 1)
        if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 100:
            raise ValueError("一次可以创建 1–100 个邀请码")
        expires = values.get("expires_at")
        now = time.time()
        if isinstance(expires, bool) or not isinstance(expires, (int, float)) or not math.isfinite(expires) or not now < expires <= 253402300799:
            raise ValueError("请为邀请码设置将来的失效时间")
        quota = quota_value(values.get("quota_bytes", self.config()["default_quota_bytes"]))
        created = []
        with self.metadata.transaction() as db:
            for _ in range(count):
                code = secrets.token_urlsafe(18)
                digest = hashlib.sha256(code.encode()).hexdigest()
                cursor = db.execute("INSERT INTO registration_invites(code_hash,code_enc,quota_bytes,expires_at,created_at,created_by) VALUES(?,?,?,?,?,?)",
                                    (digest, self._seal(code, f"invite:{digest}"), quota, expires, now, creator))
                created.append({"id": cursor.lastrowid, "code": code, "quota_bytes": quota, "expires_at": expires, "created_at": now, "status": "active"})
        return {"invites": created}

    def list_invitations(self, cursor: int = 0, status: str = "all", limit: int = 50) -> dict:
        now = time.time()
        conditions = {"all": ("1=1", ()), "active": ("used_at IS NULL AND revoked_at IS NULL AND expires_at>?", (now,)),
                      "used": ("used_at IS NOT NULL", ()), "revoked": ("revoked_at IS NOT NULL AND used_at IS NULL", ()),
                      "expired": ("used_at IS NULL AND revoked_at IS NULL AND expires_at<=?", (now,))}
        if cursor < 0 or status not in conditions:
            raise ValueError("邀请码筛选或分页参数不合法")
        limit = max(1, min(limit, 100))
        condition, args = conditions[status]
        total = self.metadata.db.execute(f"SELECT COUNT(*) FROM registration_invites WHERE {condition}", args).fetchone()[0]
        rows = self.metadata.db.execute(f"SELECT * FROM registration_invites WHERE {condition} AND (?=0 OR id<?) ORDER BY id DESC LIMIT ?", (*args, cursor, cursor, limit + 1)).fetchall()
        items = []
        for row in rows[:limit]:
            state = "used" if row["used_at"] is not None else "revoked" if row["revoked_at"] is not None else "expired" if row["expires_at"] <= now else "active"
            items.append({key: row[key] for key in ("id", "quota_bytes", "expires_at", "created_at", "used_at")} |
                         {"code": self._open(row["code_enc"], f"invite:{row['code_hash']}"), "status": state})
        return {"invites": items, "total": total, "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None}

    def revoke_invitation(self, invite_id: int) -> None:
        with self.metadata.transaction() as db:
            row = db.execute("SELECT used_at FROM registration_invites WHERE id=?", (invite_id,)).fetchone()
            if row is None:
                raise NotFoundError("邀请码不存在")
            if row["used_at"] is not None:
                raise ValueError("邀请码已经使用，无法撤销注册；可在用户页管理该账号")
            db.execute("UPDATE registration_invites SET revoked_at=? WHERE id=?", (time.time(), invite_id))
