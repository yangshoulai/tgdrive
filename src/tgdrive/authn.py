"""账号口令和内存会话。"""

from __future__ import annotations

import os
import secrets
import time
import hmac
from dataclasses import dataclass

from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
from cryptography.exceptions import InvalidKey

from .errors import TgDriveError


class AuthenticationError(TgDriveError):
    pass


class CsrfError(TgDriveError):
    pass


class SessionExpired(TgDriveError):
    pass


def hash_password(password: str, *, min_length: int = 8) -> str:
    if len(password) < min_length:
        raise ValueError(f"密码至少需要 {min_length} 个字符")
    return Argon2id(salt=os.urandom(16), length=32, iterations=3,
                    memory_cost=65536, lanes=4).derive_phc_encoded(password.encode())


def verify_password(password: str, encoded: str) -> bool:
    try:
        Argon2id.verify_phc_encoded(password.encode(), encoded)
        return True
    except (InvalidKey, ValueError):
        return False


@dataclass(frozen=True)
class Session:
    token: str
    csrf_token: str
    user_id: int
    username: str
    role: str
    expires_at: float


class TooManyAttempts(AuthenticationError):
    """同一来源连续登录失败过多，暂时拒绝。HTTP 层映射为 429。"""


class SessionManager:
    def __init__(self, *, ttl: float = 12 * 60 * 60, max_failures: int = 5, failure_window: float = 15 * 60) -> None:
        self.ttl, self.max_failures, self.failure_window = ttl, max_failures, failure_window
        self._sessions: dict[str, Session] = {}
        self._failures: dict[str, tuple[int, float]] = {}

    def record_failure(self, identity: str) -> None:
        now = time.monotonic()
        if len(self._failures) >= self.MAX_TRACKED_FAILURES and identity not in self._failures:
            # 随机用户名的失败请求不能让计数表无限增长：先清理过期项，仍超限则丢弃最早的记录。
            for key, (_, first) in list(self._failures.items()):
                if now - first > self.failure_window:
                    self._failures.pop(key, None)
            while len(self._failures) >= self.MAX_TRACKED_FAILURES:
                self._failures.pop(min(self._failures, key=lambda key: self._failures[key][1]))
        count, first = self._failures.get(identity, (0, now))
        if now - first > self.failure_window:
            count, first = 0, now
        self._failures[identity] = (count + 1, first)

    def clear_failures(self, identity: str) -> None:
        self._failures.pop(identity, None)

    def is_rate_limited(self, identity: str, *, limit: int | None = None) -> bool:
        item = self._failures.get(identity)
        if item is None:
            return False
        count, first = item
        if time.monotonic() - first > self.failure_window:
            self._failures.pop(identity, None)
            return False
        return count >= (limit or self.max_failures)

    # 会话与失败计数只保存在本进程内：tgdrive 设计为单进程部署（不要用多个 worker 或多实例运行同一个数据目录）。
    MAX_TRACKED_FAILURES = 10_000

    def create(self, user_id: int, username: str, role: str) -> Session:
        now = time.time()
        # 顺带清理过期会话，避免从未再次访问的会话长期驻留内存。
        for token, item in list(self._sessions.items()):
            if item.expires_at <= now:
                self._sessions.pop(token, None)
        session = Session(secrets.token_urlsafe(32), secrets.token_urlsafe(32), user_id, username, role, now + self.ttl)
        self._sessions[session.token] = session
        return session

    def peek(self, token: str) -> Session | None:
        """不做任何校验地查看会话，仅用于审计日志记录操作者。"""
        session = self._sessions.get(token)
        return session if session is not None and session.expires_at > time.time() else None

    def require(self, token: str, *, role: str | None = None, csrf: str | None = None, mutation: bool = False) -> Session:
        session = self._sessions.get(token)
        if session is None or session.expires_at <= time.time():
            if session is not None:
                self._sessions.pop(token, None)
            raise SessionExpired("session is expired")
        if role is not None and session.role != role:
            raise AuthenticationError("insufficient role")
        if mutation and (csrf is None or not hmac.compare_digest(csrf, session.csrf_token)):
            raise CsrfError("invalid CSRF token")
        return session

    def revoke(self, token: str) -> None:
        self._sessions.pop(token, None)

    def clear(self) -> None:
        self._sessions.clear()

    def clear_user(self, user_id: int) -> None:
        for token, session in list(self._sessions.items()):
            if session.user_id == user_id:
                self._sessions.pop(token, None)
