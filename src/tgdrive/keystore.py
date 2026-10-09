"""KEK 初始化、解锁和数据库内 DEK 重新包裹。"""

from __future__ import annotations

import os
from dataclasses import dataclass

from .crypto import (
    KdfParams,
    derive_kek,
    derive_subkey,
    make_check_blob,
    open_sealed,
    seal,
    unwrap_dek,
    verify_check_blob,
    wrap_dek,
)
from .errors import NotReadyError
from .metadata import Metadata


@dataclass(frozen=True)
class RotationReport:
    old_version: int
    new_version: int
    blob_count: int


class KeyStore:
    def __init__(self, metadata: Metadata) -> None:
        self.metadata = metadata
        self._kek: bytes | None = None
        # 密钥状态与数据库版本共用一把锁，备份捕获快照时也使用它。
        self.consistency_lock = metadata._lock

    def is_initialized(self) -> bool:
        return self.metadata.get_key_row() is not None

    @property
    def unlocked(self) -> bool:
        return self._kek is not None

    def initialize(self, passphrase: str, *, kdf: KdfParams | None = None, material=None) -> None:
        with self.consistency_lock:
            if self.is_initialized():
                raise ValueError("keystore already initialized")
            salt, params, kek = material or self.initial_material(passphrase, kdf)
            self.metadata.put_key_row(1, salt, params.as_dict(), make_check_blob(kek))
            self._kek = kek

    def unlock(self, passphrase: str, *, material=None, expected=None) -> bytes:
        with self.consistency_lock:
            row = self.metadata.get_key_row()
            if row is None:
                raise NotReadyError("keystore is not initialized")
            if expected is not None and (row["version"], row["kdf_salt"]) != expected:
                raise ValueError("加密口令已更改，请重试")
            kek = material if material is not None else self.unlock_material(row, passphrase)
            self._kek = kek
            return kek

    @staticmethod
    def initial_material(passphrase: str, kdf: KdfParams | None = None):
        params = kdf or KdfParams()
        salt = os.urandom(16)
        return salt, params, derive_kek(passphrase, salt, params)

    @staticmethod
    def unlock_material(row, passphrase: str):
        import json
        kek = derive_kek(passphrase, row["kdf_salt"], KdfParams(**json.loads(row["kdf_params"])))
        verify_check_blob(kek, row["check_blob"])
        return kek

    @classmethod
    def rotation_material(cls, row, old: str, new: str, kdf: KdfParams | None = None):
        import json
        old_kek = cls.unlock_material(row, old)
        salt, params, new_kek = cls.initial_material(new, kdf or KdfParams(**json.loads(row["kdf_params"])))
        return old_kek, salt, params, new_kek

    def lock(self) -> None:
        with self.consistency_lock:
            self._kek = None

    def require_kek(self) -> bytes:
        if self._kek is None:
            raise NotReadyError("keystore is locked")
        return self._kek

    def rotate(self, old: str, new: str, *, kdf: KdfParams | None = None, material=None, expected=None) -> RotationReport:
        with self.consistency_lock:
            row = self.metadata.get_key_row()
            if row is None:
                raise NotReadyError("keystore is not initialized")
            import json
            if expected is not None and (row["version"], row["kdf_salt"]) != expected:
                raise ValueError("加密口令已更改，请重试")
            old_kek, salt, params, new_kek = material or self.rotation_material(row, old, new, kdf)
            blobs = self.metadata.db.execute("SELECT uuid, wrapped_dek FROM blobs").fetchall()
            wrapped = [(r["uuid"], wrap_dek(new_kek, unwrap_dek(old_kek, r["wrapped_dek"], r["uuid"]), r["uuid"])) for r in blobs]
            old_client_key = derive_subkey(old_kek, "client-secret")
            new_client_key = derive_subkey(new_kek, "client-secret")
            client_secrets = []
            for client in self.metadata.db.execute("SELECT access_key_id, secret_enc FROM client_keys"):
                plaintext = open_sealed(old_client_key, client["secret_enc"], client["access_key_id"])
                client_secrets.append((client["access_key_id"], seal(new_client_key, plaintext, client["access_key_id"])))
            old_bot_key = derive_subkey(old_kek, "telegram-bot-token")
            new_bot_key = derive_subkey(new_kek, "telegram-bot-token")
            bot_secrets = []
            for bot in self.metadata.db.execute("SELECT id, token_enc FROM telegram_bots"):
                aad = f"telegram-bot:{bot['id']}"
                plaintext = open_sealed(old_bot_key, bot["token_enc"], aad)
                bot_secrets.append((bot["id"], seal(new_bot_key, plaintext, aad)))
            # 所有重新包裹和 keys 更新在同一个事务里。
            with self.metadata.transaction() as db:
                db.executemany("UPDATE blobs SET wrapped_dek = ? WHERE uuid = ?", ((w, u) for u, w in wrapped))
                db.executemany("UPDATE client_keys SET secret_enc = ? WHERE access_key_id = ?",
                               ((secret, access_key) for access_key, secret in client_secrets))
                db.executemany("UPDATE telegram_bots SET token_enc = ? WHERE id = ?",
                               ((secret, bot_id) for bot_id, secret in bot_secrets))
                db.execute("UPDATE keys SET version = ?, kdf_salt = ?, kdf_params = ?, check_blob = ? WHERE id = 1",
                           (row["version"] + 1, salt, json.dumps(params.as_dict(), separators=(",", ":")), make_check_blob(new_kek)))
            self._kek = new_kek
            return RotationReport(row["version"], row["version"] + 1, len(wrapped))
