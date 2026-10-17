"""浏览器本地缓存（docs/client-cache-design.md）：只下发密钥与核对引用，文件内容由浏览器的 Service Worker 加密保存。

- 缓存主密钥 C 是随机 32 字节，用 KEK 子密钥 ``client-cache`` 包裹后存在 settings 表（``client_cache.key``），
  改加密口令时由 ``keystore.rotate`` 重新包裹，浏览器里已有的缓存不受影响。
- 普通层：会话有效时下发层级密钥 K_tier，条目密钥由浏览器从 K_tier 派生；别处删除的文件靠 ``check`` 对账清理。
- 私密层：私密授权有效时才下发层级密钥；每个条目的编号与密钥都由服务端逐个计算，只有私密区仍引用该版本时才给出。
- 所有密钥都绑定 用户 ‖ 设备 ‖ 纪元 ‖ 密码哈希：改密码、重置纪元都会让旧缓存无法解开。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import threading

from .crypto import derive_subkey, open_sealed, seal
from .objects import PRIVATE_PREFIX

SETTING_KEY = "client_cache.key"
POLICY_KEY = "client_cache.policy"
WRAP_PURPOSE = "client-cache"
WRAP_AAD = "client-cache-key"
DEVICE = re.compile(r"[A-Za-z0-9_-]{22,64}")
BATCH = 500
DEFAULT_POLICY = {
    "enabled": True,            # 是否允许浏览器缓存普通文件
    "max_mib": 4096,            # 每台设备普通层上限
    "entry_mib": 2048,          # 单个文件最多缓存的字节数（视频按块稀疏保存）
    "private_enabled": False,   # 是否允许用户在信任的设备上缓存私密文件
    "private_max_mib": 1024,
    "private_ttl_days": 7,      # 私密条目多少天未访问即清除
}
LIMITS = {"max_mib": (64, 1024 * 1024), "entry_mib": (16, 64 * 1024), "private_max_mib": (16, 1024 * 1024), "private_ttl_days": (1, 90)}


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def normalize_policy(values: dict | None, base: dict | None = None) -> dict:
    policy = dict(base or DEFAULT_POLICY)
    for key, value in (values or {}).items():
        if key not in DEFAULT_POLICY:
            raise ValueError(f"未知设置：{key}")
        if key in ("enabled", "private_enabled"):
            if not isinstance(value, bool):
                raise ValueError("开关必须是布尔值")
            policy[key] = value
            continue
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("数值必须是整数")
        low, high = LIMITS[key]
        if not low <= value <= high:
            raise ValueError(f"{key} 必须在 {low}–{high} 之间")
        policy[key] = value
    return policy


class ClientCache:
    def __init__(self, user, private_space) -> None:
        self.user, self.private_space = user, private_space
        self.metadata = user.accounts.metadata
        self.keystore = user.accounts.keystore
        self._lock = threading.Lock()
        self._cached: tuple[bytes, bytes] | None = None

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

    def policy(self) -> dict:
        row = self.metadata.db.execute("SELECT value FROM settings WHERE key=?", (POLICY_KEY,)).fetchone()
        try:
            return normalize_policy(json.loads(row["value"]) if row else None)
        except (ValueError, TypeError):
            return dict(DEFAULT_POLICY)

    def configure(self, values: dict) -> dict:
        policy = normalize_policy(values, self.policy())
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (POLICY_KEY, json.dumps(policy, separators=(",", ":"))))
        return policy

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
        policy = self.policy()
        result = {"namespace": self._namespace(account.id), "bucket_id": scope.bucket_id, "policy": policy}
        if policy["enabled"]:
            result["key"] = _b64(self._derive("tier", "n", *self._identity(account.id, device)))
        return result

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
        if not self.policy()["private_enabled"]:
            raise PermissionError("管理员未开启私密文件的本机缓存")
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
