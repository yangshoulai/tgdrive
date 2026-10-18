"""私密文件空间：账号凭据验证、绑定登录会话的短期授权与元数据移动。"""

from __future__ import annotations

import secrets
import time
import logging
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .api import UserApi, normalize_user_path
from .objects import PRIVATE_PREFIX, Scope
from .passkeys import Passkeys


class PrivateLocked(PermissionError):
    """私密授权失效不应注销用户的普通登录会话。"""


class PrivateAccessLogFilter(logging.Filter):
    """原生媒体必须把授权带在地址中，但不能把它写入 Uvicorn 访问日志。"""

    def filter(self, record):
        if (isinstance(record.args, tuple) and len(record.args) == 5 and isinstance(record.args[2], str)
                and record.args[2].startswith("/api/user/v1/private/")):
            parsed = urlsplit(record.args[2])
            if parsed.path.startswith("/api/user/v1/private/"):
                query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key != "access"]
                path = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))
                record.args = (*record.args[:2], path, *record.args[3:])
        return True


@dataclass
class PrivateGrant:
    session: str
    user_id: int
    idle_seconds: int
    expires_at: float
    password_hash: str


class PrivateSpace:
    IDLE_OPTIONS = (60, 300, 900, 1800)
    DEFAULT_IDLE = 1800
    MAX_GRANTS = 5000

    def __init__(self, user: UserApi, settings=None):
        self.user = user
        self.metadata = user.accounts.metadata
        self.grants: dict[str, PrivateGrant] = {}
        self.session_grants: dict[str, str] = {}
        self.pending_unlocks: dict[str, dict[object, int]] = {}
        self.passkeys = Passkeys(user, settings, self)
        # 授权被撤销时的回调（文件助手据此清除私密对话，docs/assistant-design.md §24.2）。
        self.listeners: list = []

    def _account(self, token, csrf=None, mutation=False):
        session = self.user._session(token, csrf=csrf, mutation=mutation)
        return self.user.accounts.account_for_session(session)

    def _config(self, user_id):
        return self.metadata.db.execute("SELECT * FROM private_spaces WHERE user_id=?", (user_id,)).fetchone()

    def _user_row(self, user_id):
        return self.metadata.db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()

    def ensure_config(self, user_id, idle=DEFAULT_IDLE):
        with self.metadata.transaction() as db:
            db.execute("INSERT OR IGNORE INTO private_spaces(user_id,idle_seconds,created_at) VALUES(?,?,?)",
                       (user_id, self._idle(idle), time.time()))
        return self._config(user_id)

    def status(self, token, origin=None):
        account = self._account(token)
        row = self._config(account.id)
        access = self.session_grants.get(token)
        grant = None
        if access:
            try:
                grant = self.require(token, access)
            except PrivateLocked:
                self.session_grants.pop(token, None)
                access = None
        return {"configured": row is not None, "idle_seconds": row["idle_seconds"] if row else self.DEFAULT_IDLE,
                "unlocked": grant is not None, "access": access if grant is not None else None,
                "remaining_seconds": max(0, grant.expires_at - time.monotonic()) if grant else 0,
                "passkeys": self.passkeys.capability(account.id, origin)}

    def _forget(self, access):
        grant = self.grants.pop(access, None)
        if grant is not None and self.session_grants.get(grant.session) == access:
            self.session_grants.pop(grant.session, None)
        if grant is not None:
            for listener in self.listeners:
                try:
                    listener(access)
                except Exception:
                    logging.getLogger(__name__).error("private grant listener failed")

    @classmethod
    def _idle(cls, value):
        if isinstance(value, bool) or value not in cls.IDLE_OPTIONS:
            raise ValueError("闲置时间只能选择 1、5、15 或 30 分钟")
        return int(value)

    def _issue(self, token, user_id, idle, *, password_hash=None):
        account = self._account(token)
        row = self._user_row(user_id)
        if account.id != user_id or row is None or (password_hash is not None and row["password_hash"] != password_hash):
            raise ValueError("登录凭据已变化，请重新解锁")
        now = time.monotonic()
        for key, grant in list(self.grants.items()):
            if grant.expires_at <= now:
                self._forget(key)
        access = self.session_grants.get(token)
        previous = self.grants.get(access)
        if previous is not None and previous.user_id == user_id and previous.password_hash == row["password_hash"]:
            previous.idle_seconds = idle
            previous.expires_at = now + idle
            return {"access": access, "idle_seconds": idle, "remaining_seconds": idle}
        if access:
            self._forget(access)
        if len(self.grants) >= self.MAX_GRANTS:
            raise ValueError("解锁窗口过多，请关闭其他窗口后重试")
        access = secrets.token_urlsafe(32)
        self.grants[access] = PrivateGrant(token, user_id, idle, now + idle, row["password_hash"])
        self.session_grants[token] = access
        return {"access": access, "idle_seconds": idle, "remaining_seconds": idle}

    async def setup(self, token, csrf, password, idle=DEFAULT_IDLE):
        # 保留旧网页接口的兼容入口，首次进入也只验证账号登录密码。
        return await self.unlock(token, csrf, password, idle=self._idle(idle))

    async def unlock(self, token, csrf, password, ip=None, *, idle=DEFAULT_IDLE):
        account = self._account(token, csrf, True)
        request = object()
        self.pending_unlocks.setdefault(token, {})[request] = account.id
        try:
            account, row = await self.check_password(token, csrf, password, ip)
            if request not in self.pending_unlocks.get(token, {}):
                raise PrivateLocked("私密空间已被锁定，请重新验证")
            config = self.ensure_config(account.id, idle)
            return self._issue(token, account.id, config["idle_seconds"], password_hash=row["password_hash"])
        finally:
            pending = self.pending_unlocks.get(token)
            if pending is not None:
                pending.pop(request, None)
                if not pending:
                    self.pending_unlocks.pop(token, None)

    async def check_password(self, token, csrf, password, ip=None):
        """私密解锁始终使用账号的当前登录密码，不再保存第二个密码。"""
        self._account(token, csrf, True)
        result = await self.user.accounts.confirm_password(token, csrf, password, ip=ip, purpose="private")
        self._account(token, csrf, True)
        return result

    def require(self, token, access):
        account = self._account(token)
        grant = self.grants.get(access)
        if grant is None or grant.session != token or grant.user_id != account.id:
            raise PrivateLocked("请重新解锁私密空间")
        if grant.expires_at <= time.monotonic():
            self._forget(access)
            raise PrivateLocked("私密空间已因闲置自动锁定")
        row = self._user_row(account.id)
        if row is None or row["password_hash"] != grant.password_hash:
            self._forget(access)
            raise PrivateLocked("登录密码已修改，请重新解锁私密空间")
        return grant

    def activity(self, token, csrf, access, *, active=False, playing=False):
        self._account(token, csrf, True)
        grant = self.require(token, access)
        # 普通读取、列表轮询和校验请求不续期；只有交互或有进展的播放才续期。
        if active or playing:
            grant.expires_at = time.monotonic() + grant.idle_seconds
        return {"remaining_seconds": max(0, grant.expires_at - time.monotonic()), "idle_seconds": grant.idle_seconds}

    def lock(self, token, csrf, access):
        self._account(token, csrf, True)
        # 授权现在由同一登录会话共享，旧窗口的锁定也要撤销刚重新签发的授权。
        current = self.session_grants.get(token)
        if current:
            self._forget(current)
        grant = self.grants.get(access)
        if grant is not None and grant.session == token:
            self._forget(access)
        self.pending_unlocks.pop(token, None)
        self.passkeys.revoke(token=token, kind="private")

    def revoke_user(self, user_id):
        self.passkeys.revoke(user_id=user_id, kind="private")
        for token, pending in list(self.pending_unlocks.items()):
            if user_id in pending.values():
                self.pending_unlocks.pop(token, None)
        for key, grant in list(self.grants.items()):
            if grant.user_id == user_id:
                self._forget(key)

    def revoke_session(self, token):
        self.passkeys.revoke(token=token)
        self.pending_unlocks.pop(token, None)
        for key, grant in list(self.grants.items()):
            if grant.session == token:
                self._forget(key)

    async def configure(self, token, csrf, access, password=None, idle=DEFAULT_IDLE, new_password=None):
        account = self._account(token, csrf, True)
        grant = None
        if access:
            try:
                grant = self.require(token, access)
            except PrivateLocked:
                pass
        idle = self._idle(idle)
        if new_password:
            raise ValueError("私密空间使用登录密码，请在设置中修改密码")
        if password is not None:
            await self.check_password(token, csrf, password)
            if grant is not None:
                self.require(token, access)
        self._account(token, csrf, True)
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO private_spaces(user_id,idle_seconds,created_at) VALUES(?,?,?) "
                       "ON CONFLICT(user_id) DO UPDATE SET idle_seconds=excluded.idle_seconds",
                       (account.id, idle, time.time()))
        # 仅撤销本账号旧授权。当前会话已有有效授权时可以续用；锁定状态下设置时间不会解锁文件。
        self.revoke_user(account.id)
        if grant is not None:
            return self._issue(token, account.id, idle, password_hash=grant.password_hash)
        return {"access": None, "idle_seconds": idle}

    def files(self, token, access):
        self.require(token, access)
        return PrivateFiles(self, token, access)

    async def transfer(self, token, csrf, access, paths, destination, into, conflict="rename"):
        self.require(token, access)
        account = self._account(token, csrf, True)
        if not isinstance(paths, list) or not 1 <= len(paths) <= 200 or any(not isinstance(p, str) for p in paths):
            raise ValueError("一次最多移动 200 个项目")
        if not isinstance(into, bool):
            raise ValueError("移动方向不合法")
        sources = [PrivateFiles.path(p) if not into else normalize_user_path(p, directory=p.endswith("/")) for p in paths]
        destination = (PrivateFiles.path(destination) if into else
                       normalize_user_path(destination, directory=True) if destination else "")
        if destination and not destination.endswith("/"):
            raise ValueError("目标必须是文件夹")
        authorize = lambda: self.require(token, access)
        scope = Scope(account.bucket_id, private_access=True, authorize=authorize)
        def move():
            authorize()
            moved = skipped = 0
            # 文件夹与子项同时选择时，只移动最外层目录，避免子项已随父目录移动后报错。
            roots = [p for p in dict.fromkeys(sources) if not any(p != other and other.endswith("/") and p.startswith(other) for other in sources)]
            with self.metadata.transaction():
                for source in roots:
                    name = source.rstrip("/").rsplit("/", 1)[-1] + ("/" if source.endswith("/") else "")
                    result = self.user.objects.move(scope, source, destination + name, conflict, revoke_public=True)
                    moved += result.moved
                    skipped += result.skipped
                authorize()
            return {"moved": moved, "skipped": skipped}
        return await self.metadata.run_in_thread(move)


class PrivateFiles(UserApi):
    """复用文件服务，只允许当前解锁授权访问私密前缀。"""

    def __init__(self, space, token, access):
        super().__init__(space.user.accounts, space.user.objects, space.user.clients)
        self.space, self.token, self.access = space, token, access

    @staticmethod
    def path(value, *, directory=False):
        if not isinstance(value, str) or not value.startswith(PRIVATE_PREFIX):
            raise PermissionError("文件不属于私密空间")
        relative = value[len(PRIVATE_PREFIX):]
        return PRIVATE_PREFIX + normalize_user_path(relative, directory=directory) if relative else PRIVATE_PREFIX

    _path = path

    def _scope(self, token, *, csrf=None, mutation=False):
        self._session(token, csrf=csrf, mutation=mutation)
        if token != self.token:
            raise PrivateLocked("私密授权不属于当前登录会话")
        self.space.require(token, self.access)
        account = self.accounts.account_for_session(self.accounts.sessions.require(token))
        return Scope(account.bucket_id, PRIVATE_PREFIX, private_access=True,
                     authorize=lambda: self.space.require(token, self.access))

    async def content(self, token, path, start=0, end=None):
        info, stream = await super().content(token, path, start, end)
        async def guarded():
            try:
                async for chunk in stream:
                    self.space.require(token, self.access)
                    yield chunk
            finally:
                await stream.aclose()
        return info, guarded()
