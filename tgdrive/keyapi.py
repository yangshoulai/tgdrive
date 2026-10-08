"""面向程序的 HTTP API（/api/v1）：只接受访问密钥认证，不读取 Cookie，也不需要 CSRF。

访问密钥与 S3 共用同一套凭据和授权（存储桶 + 前缀 + 只读/读写）。请求通过
``Authorization: Basic base64(AccessKeyId:Secret)`` 或 ``Authorization: Bearer AccessKeyId:Secret`` 认证。
"""

from __future__ import annotations

import base64
import binascii
import hmac
import unicodedata
from dataclasses import dataclass
from typing import AsyncIterator

from .api import UserApi, apply_share, normalize_user_path
from .authn import AuthenticationError
from .errors import NotFoundError
from .objects import ObjectService, Scope
from .s3.auth import ClientAuthStore, ClientGrant


class KeyAuthError(AuthenticationError):
    """访问密钥缺失或无效；HTTP 层据此返回 401 与 WWW-Authenticate。"""


@dataclass(frozen=True)
class KeyPrincipal:
    access_key_id: str
    client_id: int


class KeyApi:
    def __init__(self, objects: ObjectService, clients: ClientAuthStore) -> None:
        self.objects, self.clients = objects, clients

    # ---------- 认证与授权 ----------

    def authenticate(self, authorization: str | None) -> KeyPrincipal:
        scheme, _, value = (authorization or "").strip().partition(" ")
        value = value.strip()
        if scheme.lower() == "basic":
            try:
                credential = base64.b64decode(value, validate=True).decode("utf-8")
            except (binascii.Error, UnicodeDecodeError) as exc:
                raise KeyAuthError("Authorization 头格式不正确") from exc
        elif scheme.lower() == "bearer":
            credential = value
        else:
            raise KeyAuthError("缺少访问密钥：请使用 Authorization: Bearer <AccessKeyId>:<Secret> 或 HTTP Basic 认证")
        access_key, sep, secret = credential.partition(":")
        if not sep or not access_key or not secret:
            raise KeyAuthError("访问密钥格式应为 <AccessKeyId>:<Secret>")
        try:
            principal, expected = self.clients.secret_for(access_key)
        except NotFoundError as exc:
            raise KeyAuthError("访问密钥无效或已被禁用") from exc
        if not hmac.compare_digest(secret.encode(), expected.encode()):
            raise KeyAuthError("访问密钥无效或已被禁用")
        return KeyPrincipal(principal.access_key_id, principal.client_id)

    def _bucket(self, principal: KeyPrincipal, name: str | None) -> int:
        bucket_ids = sorted({grant.bucket_id for grant in self.clients.client_grants(principal.client_id)})
        if name:
            row = self.objects.metadata.db.execute("SELECT id FROM buckets WHERE name=?", (name,)).fetchone()
            if row is None or row["id"] not in bucket_ids:
                raise PermissionError("该密钥无权访问这个存储桶")
            return int(row["id"])
        if not bucket_ids:
            raise PermissionError("该密钥没有任何存储桶授权")
        if len(bucket_ids) > 1:
            raise ValueError("该密钥可以访问多个存储桶，请通过 bucket 参数指定")
        return bucket_ids[0]

    def _scope(self, principal: KeyPrincipal, bucket_id: int, keys: list[str], *, write: bool) -> Scope:
        """找到一条同时覆盖所有路径的授权；文件夹移动等操作要求源和目标在同一授权内。"""
        grants = [grant for grant in self.clients.grants(principal.client_id, bucket_id)
                  if all(grant.permits(key, write=write) for key in keys)]
        if not grants:
            raise PermissionError("该密钥无权" + ("写入" if write else "读取") + "这个路径")
        grant = max(grants, key=lambda item: len(item.prefix))
        return Scope(bucket_id, grant.prefix, grant.perms)

    def _readable(self, principal: KeyPrincipal, bucket_id: int) -> list[ClientGrant]:
        return self.clients.grants(principal.client_id, bucket_id)

    # ---------- 只读接口 ----------

    def whoami(self, principal: KeyPrincipal) -> dict[str, object]:
        row = self.objects.metadata.db.execute(
            "SELECT c.name, c.owner_user_id, u.username FROM clients c LEFT JOIN users u ON u.id=c.owner_user_id "
            "WHERE c.id=?", (principal.client_id,)).fetchone()
        grants = self.objects.metadata.db.execute(
            "SELECT b.name AS bucket, g.prefix, g.perms FROM client_grants g JOIN buckets b ON b.id=g.bucket_id "
            "WHERE g.client_id=? ORDER BY b.name, g.prefix", (principal.client_id,)).fetchall()
        return {"access_key_id": principal.access_key_id, "name": row["name"], "owner": row["username"],
                "grants": [{"bucket": item["bucket"], "prefix": item["prefix"], "perms": item["perms"]} for item in grants]}

    def list(self, principal: KeyPrincipal, bucket: str | None, prefix: str, cursor: str | None, limit: int):
        bucket_id = self._bucket(principal, bucket)
        prefix = normalize_user_path(prefix, directory=True) if prefix else ""
        grants = self._readable(principal, bucket_id)
        covering = [grant for grant in grants if prefix.startswith(grant.prefix)]
        if covering:
            grant = max(covering, key=lambda item: len(item.prefix))
        else:
            # 与 S3 网关一致：列出上层目录时，返回该密钥被授权的子目录内容。
            inside = [grant for grant in grants if grant.prefix.startswith(prefix)]
            if not inside:
                raise PermissionError("该密钥无权读取这个路径")
            grant = min(inside, key=lambda item: len(item.prefix))
            prefix = grant.prefix
        page = self.objects.list_objects(Scope(bucket_id, grant.prefix, grant.perms), prefix, "/", cursor,
                                         max(1, min(limit, 1000)))
        return {"objects": [UserApi._object_json(item) for item in page.objects],
                "common_prefixes": page.common_prefixes, "next_cursor": page.next_cursor}

    def search(self, principal: KeyPrincipal, bucket: str | None, query: str, cursor: str, limit: int):
        bucket_id = self._bucket(principal, bucket)
        grants = self._readable(principal, bucket_id)
        query = unicodedata.normalize("NFC", query.strip())
        if not query or len(query) > 256:
            raise ValueError("搜索词长度需要在 1 到 256 个字符之间")
        limit = max(1, min(limit, 200))
        if not grants:
            raise PermissionError("该密钥无权读取这个存储桶")
        # 授权前缀条件下推到 SQL，并只取一页加一条，避免把全部匹配项读入内存。
        prefixes = sorted({grant.prefix for grant in grants})
        prefix_sql = " OR ".join("substr(key,1,?)=?" for _ in prefixes)
        prefix_args = [value for prefix in prefixes for value in (len(prefix), prefix)]
        rows = self.objects.metadata.db.execute(
            "SELECT key,size,etag,content_type,modified_at,public_token,public_at FROM objects "
            f"WHERE bucket_id=? AND key>? AND instr(lower(key),lower(?))>0 AND substr(key,-1)!='/' "
            f"AND substr(key,1,9)!='.tgdrive/' AND ({prefix_sql}) "
            "ORDER BY key LIMIT ?",
            (bucket_id, cursor, query, *prefix_args, limit + 1)).fetchall()
        return {"objects": [dict(row) for row in rows[:limit]], "common_prefixes": [],
                "next_cursor": rows[limit - 1]["key"] if len(rows) > limit else None}

    async def content(self, principal: KeyPrincipal, bucket: str | None, path: str):
        """返回 (info, opener)，由 HTTP 层负责 Range、ETag 与流式发送。"""
        bucket_id = self._bucket(principal, bucket)
        key = normalize_user_path(path)
        scope = self._scope(principal, bucket_id, [key], write=False)
        info = self.objects.head_object(scope, key)
        return info, lambda start, end: self.objects.get_object(scope, key, start, end)

    def list_public(self, principal: KeyPrincipal, bucket: str | None):
        bucket_id = self._bucket(principal, bucket)
        grants = self._readable(principal, bucket_id)
        return [UserApi._object_json(item) for item in self.objects.list_public(bucket_id)
                if any(grant.permits(item.key) for grant in grants)]

    # ---------- 写入接口 ----------

    async def put(self, principal: KeyPrincipal, bucket: str | None, path: str, body: AsyncIterator[bytes],
                  content_type: str | None, size: int | None, public: bool | None):
        bucket_id = self._bucket(principal, bucket)
        key = normalize_user_path(path)
        scope = self._scope(principal, bucket_id, [key], write=True)
        item = await self.objects.put_object(scope, key, body, size, content_type)
        if public is not None:
            item = self.objects.set_public(scope, key, public)
        return UserApi._object_json(item)

    async def folder(self, principal: KeyPrincipal, bucket: str | None, path: str):
        bucket_id = self._bucket(principal, bucket)
        key = normalize_user_path(path, directory=True)
        scope = self._scope(principal, bucket_id, [key], write=True)
        return UserApi._object_json(await self.objects.put_directory_marker(scope, key))

    async def delete(self, principal: KeyPrincipal, bucket: str | None, paths: list[str], recursive: bool = False):
        bucket_id = self._bucket(principal, bucket)
        keys = [normalize_user_path(path) for path in paths]
        # 先校验全部路径，避免批量删除只执行了一半。
        scopes = [self._scope(principal, bucket_id, [key], write=True) for key in keys]
        results = []
        for scope, key in zip(scopes, keys):
            if recursive and key.endswith("/"):
                count = await self.objects.delete_prefix(scope, key)
                results.append({"path": key, "deleted": count > 0, "count": count})
            else:
                results.extend({"path": item.key, "deleted": item.deleted} for item in await self.objects.delete_objects(scope, [key]))
        return results

    def move(self, principal: KeyPrincipal, bucket: str | None, source: str, target: str, conflict: str):
        bucket_id = self._bucket(principal, bucket)
        old = normalize_user_path(source, directory=source.endswith("/"))
        new = normalize_user_path(target, directory=target.endswith("/"))
        scope = self._scope(principal, bucket_id, [old, new], write=True)
        result = self.objects.move(scope, old, new, conflict)
        return {"moved": result.moved, "skipped": result.skipped}

    async def copy(self, principal: KeyPrincipal, bucket: str | None, source: str, target: str):
        bucket_id = self._bucket(principal, bucket)
        src, dst = normalize_user_path(source), normalize_user_path(target)
        item = await self.objects.copy_object(self._scope(principal, bucket_id, [src], write=False), src,
                                              self._scope(principal, bucket_id, [dst], write=True), dst)
        return UserApi._object_json(item)

    def set_public(self, principal: KeyPrincipal, bucket: str | None, paths: list[str], public: bool,
                   options: dict[str, object] | None = None):
        bucket_id = self._bucket(principal, bucket)
        keys = [normalize_user_path(path) for path in paths]
        scopes = [self._scope(principal, bucket_id, [key], write=True) for key in keys]
        return [UserApi._object_json(apply_share(self.objects, scope, key, public, options)) for scope, key in zip(scopes, keys)]
