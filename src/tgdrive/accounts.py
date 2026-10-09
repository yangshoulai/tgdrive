"""管理员和普通用户账号服务。"""

from __future__ import annotations

import hashlib
import re
import time
from dataclasses import dataclass

from .authn import (
    AuthenticationError,
    Session,
    SessionManager,
    TooManyAttempts,
    hash_password,
    verify_password,
)
from .errors import NotFoundError, NotReadyError
from .keystore import KeyStore
from .metadata import Metadata
from .work import PasswordWork


@dataclass(frozen=True)
class Account:
    id: int
    username: str
    role: str
    status: str
    bucket_id: int | None


class MetadataSessionStore:
    """“保持登录”会话的持久化：数据库里只保存令牌的 SHA-256，泄露数据库也拿不到可用的令牌。"""

    def __init__(self, metadata: Metadata) -> None:
        self.metadata = metadata

    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def save(self, session: Session) -> None:
        now = time.time()
        with self.metadata.transaction() as db:
            db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            db.execute("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)",
                       (self._digest(session.token), session.user_id, session.csrf_token, session.expires_at, now))

    def load(self, token: str) -> Session | None:
        row = self.metadata.db.execute(
            "SELECT s.csrf_token, s.expires_at, u.id, u.username, u.role, u.status FROM sessions s "
            "JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", (self._digest(token),)).fetchone()
        if row is None:
            return None
        if row["expires_at"] <= time.time() or row["status"] != "active":
            self.delete(token)
            return None
        return Session(token, row["csrf_token"], row["id"], row["username"], row["role"], row["expires_at"], True)

    def delete(self, token: str) -> None:
        with self.metadata.transaction() as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (self._digest(token),))

    def delete_user(self, user_id: int, *, keep: str | None = None) -> None:
        with self.metadata.transaction() as db:
            db.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user_id, self._digest(keep) if keep else ""))

    def delete_all(self) -> None:
        with self.metadata.transaction() as db:
            db.execute("DELETE FROM sessions")


class AccountService:
    def __init__(self, metadata: Metadata, keystore: KeyStore, *, sessions: SessionManager | None = None) -> None:
        self.metadata, self.keystore = metadata, keystore
        self.sessions = sessions or SessionManager(store=MetadataSessionStore(metadata))
        self.password_work = PasswordWork()

    def status(self) -> dict[str, object]:
        return {"initialized": self.keystore.is_initialized(), "unlocked": self.keystore.unlocked,
                "user_count": self.metadata.db.execute("SELECT COUNT(*) FROM users").fetchone()[0]}

    def setup(self, passphrase: str, username: str, password: str, *, material=None, encoded=None) -> Account:
        if self.keystore.is_initialized() or self.metadata.db.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None:
            raise NotReadyError("initial setup has already completed")
        self._validate_username(username)
        if len(passphrase) < 12:
            # 与初始化页面的校验一致；后端是最终校验边界。
            raise ValueError("加密口令至少 12 个字符")
        try:
            with self.metadata.transaction():
                self.keystore.initialize(passphrase, material=material)
                return self._create_account(username, password, "admin", encoded=encoded)
        except BaseException:
            self.keystore.lock()
            raise

    async def asetup(self, passphrase: str, username: str, password: str) -> Account:
        self._validate_username(username)
        if len(passphrase) < 12:
            raise ValueError("加密口令至少 12 个字符")
        if self.keystore.is_initialized():
            raise NotReadyError("initial setup has already completed")
        def calculate():
            return self.keystore.initial_material(passphrase), hash_password(password)
        material, encoded = await self.password_work.run(calculate)
        return self.setup(passphrase, username, password, material=material, encoded=encoded)

    @staticmethod
    def _validate_username(username: str) -> None:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{1,63}", username):
            raise ValueError("用户名需要 2-64 位英文字母、数字、点、下划线或连字符")

    def _create_account(self, username: str, password: str, role: str,
                        quota_bytes: int | None = None, *, encoded: str | None = None) -> Account:
        self._validate_username(username)
        if quota_bytes is not None and quota_bytes < 0:
            raise ValueError("quota must be non-negative")
        password_hash = encoded if encoded is not None else hash_password(password)
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

    def list_accounts_page(self, *, cursor: int = 0, limit: int = 50, query: str = "", status: str = "") -> dict[str, object]:
        if cursor < 0 or status not in ("", "active", "disabled") or len(query) > 256:
            raise ValueError("分页或筛选参数不合法")
        limit = max(1, min(limit, 200))
        where, args = ["1=1"], []
        if query.strip():
            where.append("instr(lower(u.username),lower(?))>0")
            args.append(query.strip())
        if status:
            where.append("u.status=?")
            args.append(status)
        condition = " AND ".join(where)
        total = self.metadata.cached_read(("users-total", query.strip(), status),
            lambda: self.metadata.db.execute(f"SELECT COUNT(*) FROM users u WHERE {condition}", args).fetchone()[0])
        rows = self.metadata.db.execute(
            "SELECT u.id,u.username,u.role,u.status,u.bucket_id,u.created_at,u.last_login_at,"
            "b.quota_bytes,COALESCE(b.used_bytes,0) AS used_bytes FROM users u LEFT JOIN buckets b ON b.id=u.bucket_id "
            f"WHERE {condition} AND u.id>? ORDER BY u.id LIMIT ?", (*args, cursor, limit + 1)).fetchall()
        return {"users": [dict(row) for row in rows[:limit]], "total": total,
                "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None}

    def account_summary(self) -> dict[str, object]:
        return self.metadata.cached_read(("account-summary",), self._account_summary)

    def _account_summary(self) -> dict[str, object]:
        totals = self.metadata.db.execute(
            "SELECT COUNT(*) AS total,COALESCE(SUM(u.status='active'),0) AS active,"
            "COALESCE(SUM(u.role='user'),0) AS user_total,COALESCE(SUM(b.used_bytes),0) AS used_bytes "
            "FROM users u LEFT JOIN buckets b ON b.id=u.bucket_id").fetchone()
        columns = ("SELECT u.id,u.username,u.role,u.status,u.bucket_id,u.created_at,u.last_login_at,"
                   "b.quota_bytes,COALESCE(b.used_bytes,0) AS used_bytes FROM users u LEFT JOIN buckets b ON b.id=u.bucket_id ")
        top = self.metadata.db.execute(columns + "WHERE u.role='user' ORDER BY b.used_bytes DESC,u.id LIMIT 8").fetchall()
        near = self.metadata.db.execute(columns + "WHERE b.quota_bytes>0 AND b.used_bytes>=b.quota_bytes*0.85 "
                                       "ORDER BY CAST(b.used_bytes AS REAL)/b.quota_bytes DESC,u.id LIMIT 8").fetchall()
        return {**dict(totals), "top_users": [dict(row) for row in top], "near_quota": [dict(row) for row in near]}

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

    def _login_failure(self, username: str, ip: str | None) -> None:
        self.sessions.record_failure(f"{username.lower()}|{ip or '-'}")
        if ip:
            self.sessions.record_failure(f"ip:{ip}")

    def _login_row(self, username: str, role: str | None, ip: str | None):
        account_key = f"{username.lower()}|{ip or '-'}"
        if self.sessions.is_rate_limited(account_key) or (
                ip and self.sessions.is_rate_limited(f"ip:{ip}", limit=self.MAX_FAILURES_PER_IP)):
            raise TooManyAttempts("too many login attempts")
        try:
            row = self._row(username)
            if row["status"] != "active" or (role is not None and row["role"] != role):
                raise AuthenticationError("invalid credentials")
            return row
        except AuthenticationError:
            self._login_failure(username, ip)
            raise

    def _finish_login(self, row, valid: bool, username: str, ip: str | None, remember: bool) -> Session:
        current = self.metadata.db.execute("SELECT * FROM users WHERE id=?", (row["id"],)).fetchone()
        # 密码校验期间允许禁用、重置密码和锁定；旧结果不能生成新的有效会话。
        if not valid or current is None or current["status"] != "active" or current["password_hash"] != row["password_hash"]:
            self._login_failure(username, ip)
            raise AuthenticationError("invalid credentials")
        self.sessions.clear_failures(f"{username.lower()}|{ip or '-'}")
        with self.metadata.transaction() as db:
            db.execute("UPDATE users SET last_login_at=? WHERE id=?", (time.time(), row["id"]))
        return self.sessions.create(row["id"], row["username"], row["role"], remember=remember)

    def login(self, username: str, password: str, *, role: str | None = None, ip: str | None = None, remember: bool = False) -> Session:
        row = self._login_row(username, role, ip)
        return self._finish_login(row, verify_password(password, row["password_hash"]), username, ip, remember)

    async def alogin(self, username: str, password: str, *, role: str | None = None, ip: str | None = None, remember: bool = False) -> Session:
        row = None
        def prepare():
            nonlocal row
            row = self._login_row(username, role, ip)
        valid = await self.password_work.run(lambda: verify_password(password, row["password_hash"]), before=prepare)
        return self._finish_login(row, valid, username, ip, remember)

    async def acreate_user(self, username: str, password: str, *, quota_bytes: int | None = None, authorize=None) -> Account:
        self._validate_username(username)
        encoded = await self.password_work.run(hash_password, password)
        if authorize:
            authorize()
        return self._create_account(username, password, "user", quota_bytes, encoded=encoded)

    async def areset_password(self, account_id: int, password: str, *, authorize=None) -> None:
        encoded = await self.password_work.run(hash_password, password)
        if authorize:
            authorize()
        self.reset_password(account_id, password, encoded=encoded)

    async def achange_password(self, session: Session, old: str, new: str) -> None:
        row = self.metadata.db.execute("SELECT password_hash FROM users WHERE id=?", (session.user_id,)).fetchone()
        if row is None:
            raise AuthenticationError("invalid password")
        def calculate():
            if not verify_password(old, row["password_hash"]):
                raise AuthenticationError("invalid password")
            return hash_password(new)
        encoded = await self.password_work.run(calculate)
        self.sessions.require(session.token)
        self.change_password(session, old, new, encoded=encoded, expected_hash=row["password_hash"])

    def account_for_session(self, session: Session) -> Account:
        row = self.metadata.db.execute("SELECT * FROM users WHERE id=?", (session.user_id,)).fetchone()
        if row is None:
            raise NotFoundError("user not found")
        if row["status"] != "active":
            raise AuthenticationError("account is disabled")
        return Account(row["id"], row["username"], row["role"], row["status"], row["bucket_id"])

    def reset_password(self, account_id: int, new_password: str, *, encoded: str | None = None) -> None:
        """管理员为用户设置新密码；该用户的全部会话立即失效。"""
        if len(new_password) < 8:
            raise ValueError("密码至少需要 8 个字符")
        encoded = encoded if encoded is not None else hash_password(new_password)
        with self.metadata.transaction() as db:
            if db.execute("UPDATE users SET password_hash=? WHERE id=?", (encoded, account_id)).rowcount != 1:
                raise NotFoundError("user not found")
        self.sessions.clear_user(account_id)

    def change_password(self, session: Session, old_password: str, new_password: str, *, encoded: str | None = None, expected_hash: str | None = None) -> None:
        row = self.metadata.db.execute("SELECT password_hash FROM users WHERE id=?", (session.user_id,)).fetchone()
        if row is None or (row["password_hash"] != expected_hash if encoded is not None else not verify_password(old_password, row["password_hash"])):
            raise AuthenticationError("invalid password")
        encoded = encoded if encoded is not None else hash_password(new_password)
        with self.metadata.transaction() as db:
            db.execute("UPDATE users SET password_hash=? WHERE id=?", (encoded, session.user_id))
        # 改密码后其他设备上的登录（含“保持登录”的长期会话）一律失效，只保留当前这一个。
        self.sessions.clear_user(session.user_id, keep=session.token)
