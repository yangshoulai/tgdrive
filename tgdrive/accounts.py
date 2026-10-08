"""管理员和普通用户账号服务。"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass

from .authn import AuthenticationError, Session, SessionManager, TooManyAttempts, hash_password, verify_password
from .errors import NotFoundError, NotReadyError
from .keystore import KeyStore
from .metadata import Metadata


@dataclass(frozen=True)
class Account:
    id: int
    username: str
    role: str
    status: str
    bucket_id: int | None


class AccountService:
    def __init__(self, metadata: Metadata, keystore: KeyStore, *, sessions: SessionManager | None = None) -> None:
        self.metadata, self.keystore = metadata, keystore
        self.sessions = sessions or SessionManager()

    def status(self) -> dict[str, object]:
        return {"initialized": self.keystore.is_initialized(), "unlocked": self.keystore.unlocked,
                "user_count": self.metadata.db.execute("SELECT COUNT(*) FROM users").fetchone()[0]}

    def setup(self, passphrase: str, username: str, password: str) -> Account:
        if self.keystore.is_initialized() or self.metadata.db.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None:
            raise NotReadyError("initial setup has already completed")
        self._validate_username(username)
        if len(passphrase) < 12:
            # 与初始化页面的校验一致；后端是最终校验边界。
            raise ValueError("加密口令至少 12 个字符")
        try:
            with self.metadata.transaction():
                self.keystore.initialize(passphrase)
                return self._create_account(username, password, "admin")
        except BaseException:
            self.keystore.lock()
            raise

    @staticmethod
    def _validate_username(username: str) -> None:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{1,63}", username):
            raise ValueError("用户名需要 2-64 位英文字母、数字、点、下划线或连字符")

    def _create_account(self, username: str, password: str, role: str,
                        quota_bytes: int | None = None) -> Account:
        self._validate_username(username)
        if quota_bytes is not None and quota_bytes < 0:
            raise ValueError("quota must be non-negative")
        password_hash = hash_password(password)
        now = time.time()
        with self.metadata.transaction() as db:
            if db.execute("SELECT 1 FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone() is not None:
                raise ValueError("用户名已存在")
            cursor = db.execute("INSERT INTO users(username,password_hash,role,status,bucket_id,created_at) VALUES(?,?,?,'active',NULL,?)",
                                (username, password_hash, role, now))
            user_id = int(cursor.lastrowid)
            bucket_name = f"user-{user_id}"
            bucket = db.execute("INSERT INTO buckets(name,owner_user_id,quota_bytes,created_at) VALUES(?,?,?,?)",
                                (bucket_name, user_id, quota_bytes, now))
            bucket_id = int(bucket.lastrowid)
            db.execute("UPDATE users SET bucket_id=? WHERE id=?", (bucket_id, user_id))
        return Account(user_id, username, role, "active", bucket_id)

    def create_user(self, username: str, password: str, *, quota_bytes: int | None = None) -> Account:
        return self._create_account(username, password, "user", quota_bytes)

    def list_accounts(self) -> list[dict[str, object]]:
        rows = self.metadata.db.execute(
            "SELECT u.id,u.username,u.role,u.status,u.bucket_id,u.created_at,u.last_login_at,"
            "b.quota_bytes,b.used_bytes FROM users u LEFT JOIN buckets b ON b.id=u.bucket_id ORDER BY u.id"
        )
        return [
            {"id": row["id"], "username": row["username"], "role": row["role"],
             "status": row["status"], "bucket_id": row["bucket_id"],
             "created_at": row["created_at"], "last_login_at": row["last_login_at"],
             "quota_bytes": row["quota_bytes"], "used_bytes": row["used_bytes"]}
            for row in rows
        ]

    def set_account_status(self, account_id: int, status: str) -> None:
        if status not in ("active", "disabled"):
            raise ValueError("invalid account status")
        with self.metadata.transaction() as db:
            row = db.execute("SELECT role FROM users WHERE id=?", (account_id,)).fetchone()
            if row is None:
                raise NotFoundError("user not found")
            if row["role"] == "admin" and status == "disabled":
                raise PermissionError("the administrator account cannot be disabled")
            cursor = db.execute("UPDATE users SET status=? WHERE id=?", (status, account_id))
            if cursor.rowcount != 1:
                raise NotFoundError("user not found")
        if status == "disabled":
            self.sessions.clear_user(account_id)

    def set_quota(self, account_id: int, quota_bytes: int | None) -> None:
        if quota_bytes is not None and quota_bytes < 0:
            raise ValueError("quota must be non-negative")
        with self.metadata.transaction() as db:
            row = db.execute("SELECT bucket_id FROM users WHERE id=?", (account_id,)).fetchone()
            if row is None or row["bucket_id"] is None:
                raise NotFoundError("user not found")
            db.execute("UPDATE buckets SET quota_bytes=? WHERE id=?", (quota_bytes, row["bucket_id"]))

    def _row(self, username: str):
        row = self.metadata.db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        if row is None:
            raise AuthenticationError("invalid credentials")
        return row

    # 单个 IP 在失败窗口内对所有用户名的失败总数上限（防止用一个密码批量尝试用户名）。
    MAX_FAILURES_PER_IP = 30

    def login(self, username: str, password: str, *, role: str | None = None, ip: str | None = None) -> Session:
        # 失败按“用户名 + 来源 IP”计数：别人从其他地址输错密码不会把真正的用户（尤其是管理员）锁在门外。
        account_key = f"{username.lower()}|{ip or '-'}"
        ip_key = f"ip:{ip}" if ip else None
        if self.sessions.is_rate_limited(account_key) or (
                ip_key and self.sessions.is_rate_limited(ip_key, limit=self.MAX_FAILURES_PER_IP)):
            raise TooManyAttempts("too many login attempts")

        def fail() -> None:
            self.sessions.record_failure(account_key)
            if ip_key:
                self.sessions.record_failure(ip_key)
        try:
            row = self._row(username)
        except AuthenticationError:
            fail()
            raise
        if row["status"] != "active" or (role is not None and row["role"] != role) or not verify_password(password, row["password_hash"]):
            fail()
            raise AuthenticationError("invalid credentials")
        self.sessions.clear_failures(account_key)
        with self.metadata.transaction() as db:
            db.execute("UPDATE users SET last_login_at=? WHERE id=?", (time.time(), row["id"]))
        return self.sessions.create(row["id"], row["username"], row["role"])

    def account_for_session(self, session: Session) -> Account:
        row = self.metadata.db.execute("SELECT * FROM users WHERE id=?", (session.user_id,)).fetchone()
        if row is None:
            raise NotFoundError("user not found")
        if row["status"] != "active":
            raise AuthenticationError("account is disabled")
        return Account(row["id"], row["username"], row["role"], row["status"], row["bucket_id"])

    def reset_password(self, account_id: int, new_password: str) -> None:
        """管理员为用户设置新密码；该用户的全部会话立即失效。"""
        if len(new_password) < 8:
            raise ValueError("密码至少需要 8 个字符")
        encoded = hash_password(new_password)
        with self.metadata.transaction() as db:
            if db.execute("UPDATE users SET password_hash=? WHERE id=?", (encoded, account_id)).rowcount != 1:
                raise NotFoundError("user not found")
        self.sessions.clear_user(account_id)

    def change_password(self, session: Session, old_password: str, new_password: str) -> None:
        row = self.metadata.db.execute("SELECT password_hash FROM users WHERE id=?", (session.user_id,)).fetchone()
        if row is None or not verify_password(old_password, row["password_hash"]):
            raise AuthenticationError("invalid password")
        encoded = hash_password(new_password)
        with self.metadata.transaction() as db:
            db.execute("UPDATE users SET password_hash=? WHERE id=?", (encoded, session.user_id))
