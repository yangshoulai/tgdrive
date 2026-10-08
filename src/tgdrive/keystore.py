"""KEK 初始化、解锁和数据库内 DEK 重新包裹。"""

from __future__ import annotations

import os
from dataclasses import dataclass

from .crypto import (
    KdfParams, derive_kek, derive_subkey, make_check_blob, new_dek, open_sealed,
    seal, unwrap_dek, verify_check_blob, wrap_dek,
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

    def is_initialized(self) -> bool:
        return self.metadata.get_key_row() is not None

    @property
    def unlocked(self) -> bool:
        return self._kek is not None

    def initialize(self, passphrase: str, *, kdf: KdfParams | None = None) -> None:
        if self.is_initialized():
            raise ValueError("keystore already initialized")
        params = kdf or KdfParams()
        salt = os.urandom(16)
        kek = derive_kek(passphrase, salt, params)
        self.metadata.put_key_row(1, salt, params.as_dict(), make_check_blob(kek))
        self._kek = kek

    def unlock(self, passphrase: str) -> bytes:
        row = self.metadata.get_key_row()
        if row is None:
            raise NotReadyError("keystore is not initialized")
        import json
        params = KdfParams(**json.loads(row["kdf_params"]))
        kek = derive_kek(passphrase, row["kdf_salt"], params)
        verify_check_blob(kek, row["check_blob"])
        self._kek = kek
        return kek

    def lock(self) -> None:
        self._kek = None

    def require_kek(self) -> bytes:
        if self._kek is None:
            raise NotReadyError("keystore is locked")
        return self._kek

    def rotate(self, old: str, new: str, *, kdf: KdfParams | None = None) -> RotationReport:
        row = self.metadata.get_key_row()
        if row is None:
            raise NotReadyError("keystore is not initialized")
        import json
        old_params = KdfParams(**json.loads(row["kdf_params"]))
        old_kek = derive_kek(old, row["kdf_salt"], old_params)
        verify_check_blob(old_kek, row["check_blob"])
        params = kdf or old_params
        salt = os.urandom(16)
        new_kek = derive_kek(new, salt, params)
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
