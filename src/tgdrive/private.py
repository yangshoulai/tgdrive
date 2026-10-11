"""私密文件空间：独立访问密码、绑定登录会话的短期授权与元数据移动。"""

from __future__ import annotations

import secrets
import time
import logging
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .api import UserApi, normalize_user_path
from .authn import TooManyAttempts, hash_password, verify_password
from .objects import PRIVATE_PREFIX, Scope


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


class PrivateSpace:
    IDLE_OPTIONS = (60, 300, 900, 1800)
    MAX_GRANTS = 5000

    def __init__(self, user: UserApi):
        self.user = user
        self.metadata = user.accounts.metadata
        self.grants: dict[str, PrivateGrant] = {}

    def _account(self, token, csrf=None, mutation=False):
        session = self.user._session(token, csrf=csrf, mutation=mutation)
        return self.user.accounts.account_for_session(session)

    def _config(self, user_id):
        return self.metadata.db.execute("SELECT * FROM private_spaces WHERE user_id=?", (user_id,)).fetchone()

    def status(self, token):
        row = self._config(self._account(token).id)
        return {"configured": row is not None, "idle_seconds": row["idle_seconds"] if row else 300}

    @classmethod
    def _idle(cls, value):
        if isinstance(value, bool) or value not in cls.IDLE_OPTIONS:
            raise ValueError("闲置时间只能选择 1、5、15 或 30 分钟")
        return int(value)

    def _issue(self, token, user_id, idle):
        now = time.monotonic()
        for key, grant in list(self.grants.items()):
            if grant.expires_at <= now:
                self.grants.pop(key, None)
        if len(self.grants) >= self.MAX_GRANTS:
            raise ValueError("解锁窗口过多，请关闭其他窗口后重试")
        access = secrets.token_urlsafe(32)
        self.grants[access] = PrivateGrant(token, user_id, idle, now + idle)
        return {"access": access, "idle_seconds": idle}

    async def setup(self, token, csrf, password, idle=300):
        account = self._account(token, csrf, True)
        idle = self._idle(idle)
        if self._config(account.id) is not None:
            raise ValueError("私密空间已经创建，请输入访问密码解锁")
        encoded = await self.user.accounts.password_work.run(hash_password, password)
        self._account(token, csrf, True)
        with self.metadata.transaction() as db:
            if self._config(account.id) is not None:
                raise ValueError("私密空间已经创建，请重新解锁")
            db.execute("INSERT INTO private_spaces(user_id,password_hash,idle_seconds,created_at) VALUES(?,?,?,?)",
                       (account.id, encoded, idle, time.time()))
        return self._issue(token, account.id, idle)

    async def unlock(self, token, csrf, password, ip=None):
        account = self._account(token, csrf, True)
        row = self._config(account.id)
        if row is None:
            raise ValueError("请先设置私密空间访问密码")
        sessions = self.user.accounts.sessions
        identities = (f"private-user:{account.id}", f"private-ip:{ip}") if ip else (f"private-user:{account.id}",)
        if any(sessions.is_rate_limited(identity) for identity in identities):
            raise TooManyAttempts("访问密码错误次数过多，请稍后重试")
        valid = await self.user.accounts.password_work.run(verify_password, password, row["password_hash"])
        self._account(token, csrf, True)
        current = self._config(account.id)
        if current is None or current["password_hash"] != row["password_hash"]:
            raise ValueError("访问密码已修改，请重试")
        if not valid:
            for identity in identities:
                sessions.record_failure(identity)
            raise ValueError("访问密码不正确")
        for identity in identities:
            sessions.clear_failures(identity)
        return self._issue(token, account.id, current["idle_seconds"])

    def require(self, token, access):
        account = self._account(token)
        grant = self.grants.get(access)
        if grant is None or grant.session != token or grant.user_id != account.id:
            raise PrivateLocked("请重新输入密码解锁私密空间")
        if grant.expires_at <= time.monotonic():
            self.grants.pop(access, None)
            raise PrivateLocked("私密空间已因闲置自动锁定")
        return grant

    def activity(self, token, csrf, access, *, active=False, playing=False):
        self._account(token, csrf, True)
        grant = self.require(token, access)
        # 普通读取、列表轮询和校验请求不续期；只有交互或有进展的播放才续期。
        if active or playing:
            grant.expires_at = time.monotonic() + grant.idle_seconds
        return {"remaining_seconds": max(0, grant.expires_at - time.monotonic())}

    def lock(self, token, csrf, access):
        self._account(token, csrf, True)
        grant = self.grants.get(access)
        if grant is not None and grant.session == token:
            self.grants.pop(access, None)

    def revoke_user(self, user_id):
        for key, grant in list(self.grants.items()):
            if grant.user_id == user_id:
                self.grants.pop(key, None)

    def revoke_session(self, token):
        for key, grant in list(self.grants.items()):
            if grant.session == token:
                self.grants.pop(key, None)

    async def configure(self, token, csrf, access, password, idle=300, new_password=None):
        grant = self.require(token, access)
        self._account(token, csrf, True)
        idle = self._idle(idle)
        row = self._config(grant.user_id)
        sessions = self.user.accounts.sessions
        identity = f"private-user:{grant.user_id}"
        if sessions.is_rate_limited(identity):
            raise TooManyAttempts("访问密码错误次数过多，请稍后重试")
        valid = await self.user.accounts.password_work.run(verify_password, password, row["password_hash"])
        if not valid:
            sessions.record_failure(identity)
            raise ValueError("当前访问密码不正确")
        sessions.clear_failures(identity)
        encoded = await self.user.accounts.password_work.run(hash_password, new_password) if new_password else row["password_hash"]
        self.require(token, access)
        self._account(token, csrf, True)
        with self.metadata.transaction() as db:
            updated = db.execute("UPDATE private_spaces SET password_hash=?,idle_seconds=? WHERE user_id=? AND password_hash=?",
                                 (encoded, idle, grant.user_id, row["password_hash"]))
            if updated.rowcount != 1:
                raise ValueError("访问密码已修改，请重新解锁")
        self.revoke_user(grant.user_id)
        return self._issue(token, grant.user_id, idle)

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
