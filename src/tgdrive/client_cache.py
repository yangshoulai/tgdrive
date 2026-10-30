"""浏览器本地缓存（docs/client-cache-design.md）：文件内容由浏览器的 Service Worker 加密保存。

- 缓存主密钥 C 是随机 32 字节，用 KEK 子密钥 ``client-cache`` 包裹后存在 settings 表（``client_cache.key``），
  改加密口令时由 ``keystore.rotate`` 重新包裹，浏览器里已有的缓存不受影响。
- 普通层：会话有效时下发层级密钥 K_tier，条目密钥由浏览器从 K_tier 派生；别处删除的文件靠 ``check`` 对账清理。
- 私密层：私密授权有效时才下发层级密钥；每个条目的编号与密钥都由服务端逐个计算，只有私密区仍引用该版本时才给出。
- 手动缓存：解锁时创建任务，后续按登录会话和任务范围读取，不受私密空间锁定影响。
- 所有密钥都绑定 用户 ‖ 设备 ‖ 纪元 ‖ 密码哈希：改密码、重置纪元都会让旧缓存无法解开。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import threading
from dataclasses import dataclass

from .api import UserApi
from .crypto import derive_subkey, open_sealed, seal
from .objects import PRIVATE_PREFIX, Scope
from .private import PrivateFiles

SETTING_KEY = "client_cache.key"
WRAP_PURPOSE = "client-cache"
WRAP_AAD = "client-cache-key"
DEVICE = re.compile(r"[A-Za-z0-9_-]{22,64}")
BATCH = 500


@dataclass
class CacheTask:
    user_id: int
    bucket_id: int
    device: str
    identity: tuple
    paths: tuple[str, ...]


# 本机缓存是每台设备上用户自己的选择：是否缓存、是否缓存私密文件、占用多少空间都在「设置 → 本机缓存」中设置，
# 服务端不再有管理员策略。接口仍返回固定的 policy 字段，兼容已经安装的旧版 Service Worker。
POLICY = {"enabled": True, "private_enabled": True}


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


class ClientCache:
    def __init__(self, user, private_space) -> None:
        self.user, self.private_space = user, private_space
        self.metadata = user.accounts.metadata
        self.keystore = user.accounts.keystore
        self._lock = threading.Lock()
        self._cached: tuple[bytes, bytes] | None = None
        self._tasks: dict[tuple[str, str], CacheTask] = {}

    # ---------- 主密钥与策略 ----------

    def _master(self) -> bytes:
        kek = self.keystore.require_kek()
        with self._lock:
            if self._cached is not None and self._cached[0] is kek:
                return self._cached[1]
            wrap = derive_subkey(kek, WRAP_PURPOSE)
            row = self.metadata.db.execute("SELECT value FROM settings WHERE key=?", (SETTING_KEY,)).fetchone()
            if row is None:
                key = os.urandom(32)
                with self.metadata.transaction() as db:
                    db.execute("INSERT INTO settings(key,value) VALUES(?,?)", (SETTING_KEY, base64.b64encode(seal(wrap, key, WRAP_AAD)).decode()))
            else:
                key = open_sealed(wrap, base64.b64decode(row["value"]), WRAP_AAD)
            self._cached = (kek, key)
            return key

    @staticmethod
    def policy() -> dict:
        return dict(POLICY)

    # ---------- 派生 ----------

    def _derive(self, *parts: object) -> bytes:
        message = "|".join(str(part) for part in parts).encode()
        return hmac.new(self._master(), message, hashlib.sha256).digest()

    def _identity(self, user_id: int, device: str) -> tuple:
        if not isinstance(device, str) or not DEVICE.fullmatch(device):
            raise ValueError("设备编号不合法")
        row = self.metadata.db.execute("SELECT password_hash, cache_epoch FROM users WHERE id=?", (user_id,)).fetchone()
        if row is None:
            raise ValueError("账号不存在")
        # 密码哈希只参与服务端派生，不会出现在响应里；改密码后同一设备得到不同的密钥。
        password = hashlib.sha256(row["password_hash"].encode()).hexdigest()
        return user_id, device, row["cache_epoch"], password

    def _namespace(self, user_id: int) -> str:
        # 本地存储只用这个不透明编号区分账号，不暴露账号 ID；不随设备变化，便于在同一浏览器里切换账号。
        return _b64(self._derive("ns", user_id))[:22]

    # ---------- 普通层 ----------

    def session(self, token: str, device: str) -> dict:
        scope = self.user._scope(token)
        account = self.user.accounts.account_for_session(self.user._session(token))
        return {"namespace": self._namespace(account.id), "bucket_id": scope.bucket_id, "policy": self.policy(),
                "key": _b64(self._derive("tier", "n", *self._identity(account.id, device)))}

    def check(self, token: str, etags: object) -> dict:
        """返回普通区（不含回收站、私密空间与系统区）仍在引用的版本；其余缓存由浏览器删除。"""
        scope = self.user._scope(token)
        values = self._etags(etags)
        if not values:
            return {"valid": []}
        rows = self.metadata.db.execute(
            f"SELECT DISTINCT etag FROM objects WHERE bucket_id=? AND etag IN ({','.join('?' * len(values))}) "
            "AND substr(key,1,9)!='.tgdrive/' AND substr(key,-1)!='/'", (scope.bucket_id, *values))
        return {"valid": sorted(row["etag"] for row in rows)}

    def reset(self, token: str, csrf: str) -> dict:
        session = self.user._session(token, csrf=csrf, mutation=True)
        account = self.user.accounts.account_for_session(session)
        with self.metadata.transaction() as db:
            db.execute("UPDATE users SET cache_epoch=cache_epoch+1 WHERE id=?", (account.id,))
        return {"ok": True}

    # ---------- 私密层 ----------

    def _private_account(self, token: str, access: str) -> tuple[int, int]:
        grant = self.private_space.require(token, access)
        account = self.user.accounts.account_for_session(self.user._session(token))
        if grant.user_id != account.id:
            raise PermissionError("私密授权不属于当前账号")
        return account.id, account.bucket_id

    def private_session(self, token: str, access: str, device: str) -> dict:
        user_id, _ = self._private_account(token, access)
        return {"namespace": self._namespace(user_id), "key": _b64(self._derive("tier", "p", *self._identity(user_id, device)))}

    def private_keys(self, token: str, access: str, device: str, etags: object) -> dict:
        """逐个给出私密条目的编号与密钥；私密区（不含私密回收站）不再引用的版本返回 null，浏览器据此删除。"""
        user_id, bucket_id = self._private_account(token, access)
        identity = self._identity(user_id, device)
        values = self._etags(etags)
        valid = set()
        if values:
            rows = self.metadata.db.execute(
                f"SELECT DISTINCT etag FROM objects WHERE bucket_id=? AND etag IN ({','.join('?' * len(values))}) "
                "AND substr(key,1,?)=? AND substr(key,-1)!='/'", (bucket_id, *values, len(PRIVATE_PREFIX), PRIVATE_PREFIX))
            valid = {row["etag"] for row in rows}
        return {"keys": {etag: ({"id": _b64(self._derive("id", "p", *identity, etag))[:32],
                                 "key": _b64(self._derive("entry", "p", *identity, etag))} if etag in valid else None)
                         for etag in values}}

    @staticmethod
    def _etags(values: object) -> list[str]:
        if not isinstance(values, list) or len(values) > BATCH:
            raise ValueError(f"etags 必须是不超过 {BATCH} 项的列表")
        result = []
        for value in values:
            if not isinstance(value, str) or not 0 < len(value) <= 200:
                raise ValueError("etag 不合法")
            result.append(value)
        return list(dict.fromkeys(result))

    # ---------- 手动缓存任务：复用登录会话，不另发授权凭据或设置到期时间 ----------

    def start_task(self, token: str, csrf: str, access: str, device: str, task_id: str, paths: object) -> dict:
        self.user._session(token, csrf=csrf, mutation=True)
        user_id, bucket_id = self._private_account(token, access)
        if not isinstance(task_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", task_id):
            raise ValueError("缓存任务编号不合法")
        if not isinstance(paths, list) or not paths:
            raise ValueError("请选择需要缓存的文件或文件夹")
        normalized = tuple(dict.fromkeys(PrivateFiles.path(path) for path in paths))
        identity = self._identity(user_id, device)
        with self._lock:
            # 任务随网页结束移除；异常关闭遗漏的记录在下次创建时按登录会话清理。
            self._tasks = {key: task for key, task in self._tasks.items()
                           if self.user.accounts.sessions.peek(key[0]) is not None}
            self._tasks[token, task_id] = CacheTask(user_id, bucket_id, device, identity, normalized)
        return {"namespace": self._namespace(user_id), "bucket_id": bucket_id,
                "key": _b64(self._derive("tier", "p", *identity))}

    def _task(self, token: str, task_id: str) -> CacheTask:
        account = self.user.accounts.account_for_session(self.user._session(token))
        with self._lock:
            task = self._tasks.get((token, task_id))
        if task is None or task.user_id != account.id or task.bucket_id != account.bucket_id:
            raise PermissionError("缓存任务不存在或已结束")
        if task.identity != self._identity(account.id, task.device):
            raise PermissionError("缓存密钥已变化，请重新加入缓存")
        return task

    def task_files(self, token: str, task_id: str):
        self._task(token, task_id)
        return CacheTaskFiles(self, token, task_id)

    def task_key(self, token: str, task_id: str, path: str, etag: str) -> dict:
        files = self.task_files(token, task_id)
        task = self._task(token, task_id)
        info = self.user.objects.head_object(files._scope(token), files._path(path))
        if info.etag != etag or info.key.endswith("/"):
            raise ValueError("文件已变化，请刷新列表后重新缓存")
        return {"key": _b64(self._derive("entry", "p", *task.identity, etag))}

    def finish_task(self, token: str, task_id: str) -> dict:
        self.user._session(token)
        with self._lock:
            self._tasks.pop((token, task_id), None)
        return {"ok": True}


class CacheTaskFiles(UserApi):
    """仅供 Worker 补齐指定范围的缓存；不可用于私密预览或任何写入操作。"""

    def __init__(self, cache: ClientCache, token: str, task_id: str):
        super().__init__(cache.user.accounts, cache.user.objects, cache.user.clients)
        self.cache, self.token, self.task_id = cache, token, task_id

    def _path(self, path, *, directory=False):
        key = PrivateFiles.path(path, directory=directory)
        task = self.cache._task(self.token, self.task_id)
        if not any(key == root or root.endswith("/") and key.startswith(root) for root in task.paths):
            raise PermissionError("文件超出已选定的缓存范围")
        return key

    def _scope(self, token, *, csrf=None, mutation=False):
        if mutation or token != self.token:
            raise PermissionError("缓存任务仅允许读取已选定的文件")
        task = self.cache._task(token, self.task_id)
        return Scope(task.bucket_id, PRIVATE_PREFIX, perms="ro", private_access=True,
                     authorize=lambda: self.cache._task(token, self.task_id))

    async def content(self, token, path, start=0, end=None):
        info, stream = await super().content(token, path, start, end)
        async def guarded():
            try:
                async for chunk in stream:
                    self.cache._task(token, self.task_id)
                    yield chunk
            finally:
                await stream.aclose()
        return info, guarded()
