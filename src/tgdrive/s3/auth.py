"""S3 客户端凭据和按桶/前缀授权。"""

from __future__ import annotations

import base64
import secrets
import time
from dataclasses import dataclass

from ..crypto import derive_subkey, open_sealed, seal
from ..errors import NotFoundError
from ..metadata import Metadata
from ..keystore import KeyStore


@dataclass(frozen=True)
class ClientPrincipal:
    access_key_id: str
    client_id: int


@dataclass(frozen=True)
class ClientGrant:
    client_id: int
    bucket_id: int
    prefix: str
    perms: str

    def permits(self, key: str, *, write: bool = False) -> bool:
        return key.startswith(self.prefix) and (not write or self.perms == "rw")


class ClientAuthStore:
    def __init__(self, metadata: Metadata, kek: bytes | None = None, *, keystore: KeyStore | None = None) -> None:
        if kek is None and keystore is None:
            raise ValueError("either kek or keystore is required")
        self.metadata, self.kek, self.keystore = metadata, kek, keystore

    def _kek(self) -> bytes:
        return self.keystore.require_kek() if self.keystore is not None else self.kek  # type: ignore[return-value]

    def create_client(self, name: str, description: str | None = None, owner_user_id: int | None = None) -> int:
        if not name or len(name) > 128:
            raise ValueError("invalid client name")
        with self.metadata.transaction() as db:
            cursor = db.execute("INSERT INTO clients(name,description,owner_user_id,status,created_at) VALUES(?,?,?,'active',?)",
                                (name, description, owner_user_id, time.time()))
            return int(cursor.lastrowid)

    def create_key(self, client_id: int) -> tuple[str, str]:
        client = self.metadata.db.execute("SELECT status FROM clients WHERE id=?", (client_id,)).fetchone()
        if client is None:
            raise NotFoundError("client not found")
        access_key = "TGD" + secrets.token_hex(9)[:17]
        secret = base64.urlsafe_b64encode(secrets.token_bytes(30)).decode().rstrip("=")
        encrypted = seal(derive_subkey(self._kek(), "client-secret"), secret.encode(), access_key)
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO client_keys(access_key_id,client_id,secret_enc,status,created_at) VALUES(?,?,?,'active',?)",
                       (access_key, client_id, encrypted, time.time()))
        return access_key, secret

    def create_client_with_key(self, name: str, *, owner_user_id: int | None = None,
                               grants: list[tuple[int, str, str]] = ()) -> tuple[int, str, str]:
        """在一个事务中创建客户端、密钥与授权；任一步失败（例如系统锁定）都不会留下半成品。"""
        self._kek()  # 先确认已解锁，避免进入事务后才失败
        with self.metadata.transaction():
            client_id = self.create_client(name, owner_user_id=owner_user_id)
            access_key, secret = self.create_key(client_id)
            for bucket_id, prefix, perms in grants:
                self.grant(client_id, bucket_id, prefix, perms)
        return client_id, access_key, secret

    def disable_key(self, access_key_id: str) -> None:
        with self.metadata.transaction() as db:
            cursor = db.execute("UPDATE client_keys SET status='disabled' WHERE access_key_id=?", (access_key_id,))
            if cursor.rowcount != 1:
                raise NotFoundError("access key not found")

    def set_client_status(self, client_id: int, status: str) -> None:
        if status not in ("active", "disabled"):
            raise ValueError("invalid client status")
        with self.metadata.transaction() as db:
            cursor = db.execute("UPDATE clients SET status=? WHERE id=?", (status, client_id))
            if cursor.rowcount != 1:
                raise NotFoundError("client not found")

    def list_clients(self, owner_user_id: int | None = None) -> list[dict[str, object]]:
        if owner_user_id is None:
            clients = self.metadata.db.execute(
                "SELECT id,name,description,owner_user_id,status,created_at FROM clients ORDER BY id"
            ).fetchall()
        else:
            clients = self.metadata.db.execute(
                "SELECT id,name,description,owner_user_id,status,created_at FROM clients "
                "WHERE owner_user_id=? ORDER BY id", (owner_user_id,)
            ).fetchall()
        result: list[dict[str, object]] = []
        for client in clients:
            keys = self.metadata.db.execute(
                "SELECT access_key_id,status,created_at,last_used_at FROM client_keys "
                "WHERE client_id=? ORDER BY created_at", (client["id"],)
            ).fetchall()
            grants = self.metadata.db.execute(
                "SELECT g.bucket_id,b.name AS bucket_name,g.prefix,g.perms "
                "FROM client_grants g JOIN buckets b ON b.id=g.bucket_id "
                "WHERE g.client_id=? ORDER BY g.bucket_id,g.prefix", (client["id"],)
            ).fetchall()
            result.append({
                "id": client["id"], "name": client["name"], "description": client["description"],
                "owner_user_id": client["owner_user_id"], "status": client["status"],
                "created_at": client["created_at"],
                "keys": [{"access_key_id": row["access_key_id"], "status": row["status"],
                          "created_at": row["created_at"], "last_used_at": row["last_used_at"]}
                         for row in keys],
                "grants": [{"bucket_id": row["bucket_id"], "bucket_name": row["bucket_name"],
                            "prefix": row["prefix"], "perms": row["perms"]} for row in grants],
            })
        return result

    def secret_for(self, access_key_id: str) -> tuple[ClientPrincipal, str]:
        row = self.metadata.db.execute(
            "SELECT k.client_id,k.secret_enc,k.status AS key_status,c.status AS client_status,u.status AS owner_status "
            "FROM client_keys k JOIN clients c ON c.id=k.client_id LEFT JOIN users u ON u.id=c.owner_user_id "
            "WHERE k.access_key_id=?", (access_key_id,)
        ).fetchone()
        # 所属用户被禁用时，其全部密钥一并失效（S3 与 HTTP API 都经过这里）。
        if (row is None or row["key_status"] != "active" or row["client_status"] != "active"
                or row["owner_status"] not in (None, "active")):
            raise NotFoundError("access key not found")
        secret = open_sealed(derive_subkey(self._kek(), "client-secret"), row["secret_enc"], access_key_id).decode()
        with self.metadata.transaction() as db:
            db.execute("UPDATE client_keys SET last_used_at=? WHERE access_key_id=?", (time.time(), access_key_id))
        return ClientPrincipal(access_key_id, row["client_id"]), secret

    def grant(self, client_id: int, bucket_id: int, prefix: str = "", perms: str = "ro") -> None:
        if perms not in ("ro", "rw") or "\x00" in prefix:
            raise ValueError("invalid grant")
        with self.metadata.transaction() as db:
            db.execute("INSERT OR REPLACE INTO client_grants(client_id,bucket_id,prefix,perms) VALUES(?,?,?,?)",
                       (client_id, bucket_id, prefix, perms))

    def grants(self, client_id: int, bucket_id: int) -> list[ClientGrant]:
        rows = self.metadata.db.execute("SELECT * FROM client_grants WHERE client_id=? AND bucket_id=?",
                                        (client_id, bucket_id))
        return [ClientGrant(r["client_id"], r["bucket_id"], r["prefix"], r["perms"]) for r in rows]

    def client_grants(self, client_id: int) -> list[ClientGrant]:
        rows = self.metadata.db.execute("SELECT * FROM client_grants WHERE client_id=?", (client_id,))
        return [ClientGrant(r["client_id"], r["bucket_id"], r["prefix"], r["perms"]) for r in rows]

    def authorize(self, principal: ClientPrincipal, bucket_id: int, key: str, *, write: bool = False) -> ClientGrant:
        grants = [grant for grant in self.grants(principal.client_id, bucket_id) if grant.permits(key, write=write)]
        if not grants:
            raise PermissionError("client is not authorized for this bucket/key")
        return max(grants, key=lambda grant: len(grant.prefix))
