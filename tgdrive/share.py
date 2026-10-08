"""带密码的公开分享：验证密码后签发短期访问凭证。

凭证格式为 ``<过期时间戳>.<签名>``，签名覆盖令牌、过期时间与当前密码哈希，因此修改或取消
密码后旧凭证立即失效。签名密钥由主密钥派生，系统锁定时无法签发或校验。
"""

from __future__ import annotations

import hashlib
import hmac
import time

from .crypto import derive_subkey
from .keystore import KeyStore


class ShareAccess:
    TTL = 12 * 3600

    def __init__(self, keystore: KeyStore) -> None:
        self.keystore = keystore

    def _signature(self, token: str, password_hash: str, expires: int) -> str:
        key = derive_subkey(self.keystore.require_kek(), "share-access")
        message = f"{token}|{expires}|{hashlib.sha256(password_hash.encode()).hexdigest()}".encode()
        return hmac.new(key, message, hashlib.sha256).hexdigest()[:40]

    def grant(self, token: str, password_hash: str) -> tuple[str, int]:
        expires = int(time.time()) + self.TTL
        return f"{expires}.{self._signature(token, password_hash, expires)}", expires

    def check(self, token: str, password_hash: str, grant: str | None) -> bool:
        if not grant or "." not in grant:
            return False
        expires_text, signature = grant.split(".", 1)
        try:
            expires = int(expires_text)
        except ValueError:
            return False
        if expires < time.time():
            return False
        return hmac.compare_digest(signature, self._signature(token, password_hash, expires))
