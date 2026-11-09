"""抓取脚本的临时私密授权：密钥只作身份识别，解锁仍复用账号密码、通行密钥与闲置规则。"""

from __future__ import annotations

import time
from dataclasses import dataclass

from .api import UserApi, normalize_user_path
from .authn import SessionExpired
from .objects import PRIVATE_PREFIX, Scope
from .keyapi import KeyPrincipal


@dataclass(frozen=True)
class PrivateKeyPrincipal(KeyPrincipal):
    private_client: str


class KeyPrivateAccess:
    def __init__(self, keys, space):
        self.keys, self.space = keys, space
        self.accounts = space.user.accounts
        self.metadata = space.metadata
        # 内部会话不写 Cookie、不返回客户端、不持久化；每把密钥独立，普通 API 与 S3 仍不能访问私密文件。
        self.sessions = {}

    def owner(self, principal, bucket=None):
        user_id, bucket_id = self.keys._download_user(principal, bucket)
        row = self.metadata.db.execute(
            "SELECT u.* FROM client_keys k JOIN clients c ON c.id=k.client_id JOIN users u ON u.id=c.owner_user_id "
            "WHERE k.access_key_id=? AND c.id=? AND u.id=? AND u.bucket_id=? "
            "AND k.status='active' AND c.status='active' AND u.status='active' "
            "AND EXISTS (SELECT 1 FROM client_grants g WHERE g.client_id=c.id AND g.bucket_id=u.bucket_id "
            "AND g.prefix='' AND g.perms='rw')",
            (principal.access_key_id, principal.client_id, user_id, bucket_id)).fetchone()
        if row is None:
            raise PermissionError("脚本私密解锁需要所属账号根目录读写权限的访问密钥")
        return row

    def session(self, principal, bucket=None):
        row = self.owner(principal, bucket)
        identity = (principal.access_key_id, principal.private_client)
        session = self.sessions.get(identity)
        if session is not None:
            try:
                self.accounts.sessions.require(session.token)
            except SessionExpired:
                self.space.revoke_session(session.token)
                self.sessions.pop(identity, None)
                session = None
        if session is None:
            for key, old in list(self.sessions.items()):
                if self.accounts.sessions.peek(old.token) is None or old.expires_at <= time.time():
                    self.space.revoke_session(old.token)
                    self.sessions.pop(key, None)
            if len(self.sessions) >= self.space.MAX_GRANTS:
                raise ValueError("脚本解锁窗口过多，请稍后重试")
            session = self.accounts.sessions.create(row["id"], row["username"], "user")
            self.sessions[identity] = session
        return session

    def status(self, principal, bucket=None, origin=None):
        session = self.session(principal, bucket)
        return self.space.status(session.token, origin)

    async def unlock(self, principal, bucket, password, ip=None):
        session = self.session(principal, bucket)
        result = await self.space.unlock(session.token, session.csrf_token, password, ip)
        # 密码计算在工作线程里，完成后必须再次确认访问密钥没有被撤销或收紧。
        try:
            self.owner(principal, bucket)
        except Exception:
            self.space.lock(session.token, session.csrf_token, result["access"])
            raise
        return result

    def passkey_options(self, principal, bucket, origin, ip=None):
        session = self.session(principal, bucket)
        return self.space.passkeys.private_options(session.token, session.csrf_token, origin, ip)

    async def passkey_unlock(self, principal, bucket, payload, origin, ip=None):
        session = self.session(principal, bucket)
        result = await self.space.passkeys.private_unlock(session.token, session.csrf_token,
            payload.get("request_id"), payload.get("credential"), origin, ip)
        try:
            self.owner(principal, bucket)
        except Exception:
            self.space.lock(session.token, session.csrf_token, result["access"])
            raise
        return result

    def lock(self, principal, bucket, access):
        session = self.session(principal, bucket)
        self.space.lock(session.token, session.csrf_token, access)

    def activity(self, principal, bucket, access, active=False):
        session = self.session(principal, bucket)
        return self.space.activity(session.token, session.csrf_token, access, active=active is True)

    def scope(self, principal, bucket, access, *, active=False):
        session = self.session(principal, bucket)
        bucket_id = self.owner(principal, bucket)["bucket_id"]

        def authorize():
            self.owner(principal, bucket)
            grant = self.space.require(session.token, access)
            if active:
                grant.expires_at = time.monotonic() + grant.idle_seconds

        authorize()
        return Scope(bucket_id, PRIVATE_PREFIX,
                     private_access=True, authorize=authorize)

    @staticmethod
    def path(value, *, directory=False):
        if not isinstance(value, str) or not value and not directory:
            raise ValueError("私密目录不正确")
        # 对脚本暴露相对目录；不接受调用方传入系统区绝对前缀。
        return PRIVATE_PREFIX + (normalize_user_path(value, directory=directory) if value else "")

    async def folders(self, principal, bucket, access, prefix="", cursor="", limit=100):
        scope = self.scope(principal, bucket, access, active=True)
        root = self.path(prefix, directory=True)
        limit = max(1, min(int(limit), 200))
        after = self.path(cursor, directory=True) if cursor else ""
        if after and not after.startswith(root):
            raise ValueError("目录游标不属于当前私密目录")

        def read():
            scope.authorize()
            folders, position = [], after + self.keys.objects._PREFIX_END if after else root
            while len(folders) <= limit:
                row = self.metadata.db.execute(
                    "SELECT key FROM objects WHERE bucket_id=? AND key>? AND key<? "
                    "AND instr(substr(key,?),'/')>0 ORDER BY key LIMIT 1",
                    (scope.bucket_id, position, root + self.keys.objects._PREFIX_END, len(root) + 1)).fetchone()
                if row is None:
                    break
                folder = root + row["key"][len(root):].split("/", 1)[0] + "/"
                folders.append(folder[len(PRIVATE_PREFIX):])
                position = folder + self.keys.objects._PREFIX_END
            scope.authorize()
            return folders
        folders = await self.metadata.run_in_thread(read)
        return {"prefix": prefix, "folders": folders[:limit], "writable": True,
                "next_cursor": folders[limit - 1] if len(folders) > limit else None}

    async def folder(self, principal, bucket, access, path):
        scope = self.scope(principal, bucket, access, active=True)
        info = await self.keys.objects.put_directory_marker(scope, self.path(path, directory=True))
        return UserApi._object_json(info)

    async def put(self, principal, bucket, access, path, body, mime, size):
        scope = self.scope(principal, bucket, access, active=True)
        path = self.path(path)
        if not path.rsplit("/", 1)[-1].startswith(".tessera-upload-"):
            raise ValueError("请先上传到脚本临时文件名，再提交保存名称")
        info = await self.keys.objects.put_object(scope, path, body, size, mime)
        result = UserApi._object_json(info)
        result["key"] = info.key[len(PRIVATE_PREFIX):]
        return result

    def move(self, principal, bucket, access, payload):
        scope = self.scope(principal, bucket, access, active=True)
        source, target = self.path(payload["from"]), self.path(payload["to"])
        # 仅提交本地上传的临时对象，不提供跨空间移动或覆盖已有私密文件的入口。
        if (not source.rsplit("/", 1)[-1].startswith(".tessera-upload-")
                or source.rsplit("/", 1)[0] != target.rsplit("/", 1)[0]):
            raise ValueError("只能在原目录提交脚本上传的临时文件")
        result = self.keys.objects.move(scope, source, target, "skip")
        return {"moved": result.moved, "skipped": result.skipped}

    async def delete(self, principal, bucket, access, paths):
        scope = self.scope(principal, bucket, access)
        if not isinstance(paths, list) or not 1 <= len(paths) <= 100:
            raise ValueError("临时文件数量不正确")
        keys = [self.path(path) for path in paths]
        if any(not key.rsplit("/", 1)[-1].startswith(".tessera-upload-") for key in keys):
            raise ValueError("只能清理脚本上传的临时文件")
        return {"results": [{"path": item.key[len(PRIVATE_PREFIX):], "deleted": item.deleted}
                            for item in await self.keys.objects.delete_objects(scope, keys)]}
