"""管理端和用户端 API 的框架无关服务层。

方法返回可直接序列化为 JSON 的字典；文件下载保留异步流，避免把大对象
一次性读入内存。HTTP 路由层只负责 Cookie、JSON 和状态码转换。
"""

from __future__ import annotations

import unicodedata
from collections.abc import AsyncIterator
from dataclasses import replace

from .accounts import AccountService
from .authn import AuthenticationError, Session, hash_password
from .errors import NotFoundError, NotReadyError
from .filekinds import kind_case, kind_clause
from .maintenance import MaintenanceService
from .metrics import TrafficMetrics
from .objects import PRIVATE_PREFIX, PRIVATE_TRASH_PREFIX, ObjectService, Scope
from .s3.auth import ClientAuthStore
from .telegram.config import ConfiguredBlobStore, TelegramBotConfigStore


def apply_share(objects: ObjectService, scope: Scope, key: str, public: bool, options: dict[str, object] | None, *, password_hash=ObjectService._UNSET):
    """网页与密钥 API 共用：切换公开状态，并按需更新有效期与访问密码。"""
    info = objects.set_public(scope, key, public)
    if public and options:
        kwargs = {name: options[name] for name in ("expires_at", "password") if name in options}
        if kwargs:
            info = objects.update_share(scope, key, **kwargs, password_hash=password_hash)
    return info


def normalize_user_path(value: str, *, directory: bool = False) -> str:
    value = unicodedata.normalize("NFC", value)
    if not value or value.startswith("/") or "\x00" in value or any(ord(ch) < 32 for ch in value):
        raise ValueError("invalid path")
    if any(part in ("", ".", "..") for part in value.rstrip("/").split("/")):
        raise ValueError("invalid path")
    if value.startswith(".tgdrive/") or value == ".tgdrive":
        raise PermissionError("reserved path")
    if len(value.encode("utf-8")) > 1024:
        raise ValueError("path is too long")
    if directory and not value.endswith("/"):
        value += "/"
    return value


class AdminApi:
    def __init__(self, accounts: AccountService, objects: ObjectService, clients: ClientAuthStore,
                 maintenance: MaintenanceService | None = None,
                 telegram_bots: TelegramBotConfigStore | None = None,
                 metrics: TrafficMetrics | None = None,
                 storage: ConfiguredBlobStore | None = None) -> None:
        self.accounts, self.objects, self.clients = accounts, objects, clients
        self.maintenance, self.telegram_bots, self.metrics, self.storage = maintenance, telegram_bots, metrics, storage

    def status(self) -> dict[str, object]:
        result = self.accounts.status()
        if self.metrics is not None:
            result["traffic"] = self.metrics.snapshot()
        return result

    def setup(self, passphrase: str, username: str, password: str) -> dict[str, object]:
        account = self.accounts.setup(passphrase, username, password)
        return {"user_id": account.id, "username": account.username, "bucket_id": account.bucket_id}

    def login(self, username: str, password: str, ip: str | None = None) -> dict[str, object]:
        session = self.accounts.login(username, password, role="admin", ip=ip)
        return self._session_payload(session)

    async def asetup(self, passphrase: str, username: str, password: str, nickname: str | None = None):
        account = await self.accounts.asetup(passphrase, username, password, nickname=nickname)
        return {"user_id": account.id, "username": account.username, "bucket_id": account.bucket_id}

    async def aunlock(self, token: str, csrf: str, passphrase: str):
        def authorize():
            session = self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
            self.accounts.account_for_session(session)
        authorize()
        keys = self.accounts.keystore
        row = keys.metadata.get_key_row()
        material = await self.accounts.password_work.run(keys.unlock_material, row, passphrase)
        authorize()
        keys.unlock(passphrase, material=material, expected=(row["version"], row["kdf_salt"]))
        return self.accounts.status()

    async def achange_passphrase(self, token: str, csrf: str, old: str, new: str):
        def authorize():
            self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        authorize()
        if len(new) < 12 or new == old:
            raise ValueError("新加密口令至少 12 个字符，且不能与当前口令相同")
        keys = self.accounts.keystore
        row = keys.metadata.get_key_row()
        material = await self.accounts.password_work.run(keys.rotation_material, row, old, new)
        authorize()
        report = keys.rotate(old, new, material=material, expected=(row["version"], row["kdf_salt"]))
        return {"key_version": report.new_version, "rewrapped_files": report.blob_count}

    async def alogin(self, username: str, password: str, ip: str | None = None):
        return self._session_payload(await self.accounts.alogin(username, password, role="admin", ip=ip))

    async def acreate_user(self, token: str, csrf: str, username: str, password: str, quota_bytes: int | None = None,
                           nickname: str | None = None):
        def authorize():
            self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        authorize()
        account = await self.accounts.acreate_user(username, password, quota_bytes=quota_bytes, authorize=authorize, nickname=nickname)
        return {"id": account.id, "username": account.username, "bucket_id": account.bucket_id, "quota_bytes": quota_bytes,
                "nickname": account.nickname}

    def user_avatar(self, token: str, user_id: int) -> tuple[bytes, str, str]:
        self.accounts.sessions.require(token, role="admin")
        return self.accounts.avatar(user_id)

    async def areset_user_password(self, token: str, csrf: str, user_id: int, password: str):
        def authorize():
            self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
            row = self.accounts.metadata.db.execute("SELECT role FROM users WHERE id=?", (user_id,)).fetchone()
            if row is not None and row["role"] == "admin":
                raise PermissionError("管理员请在账号菜单中修改自己的密码")
        authorize()
        await self.accounts.areset_password(user_id, password, authorize=authorize)

    async def alist_users(self, token: str, **options):
        self.accounts.sessions.require(token, role="admin")
        return await self.accounts.metadata.run_in_thread(
            self.accounts.list_accounts if options.get("limit") is None else self.accounts.list_accounts_page,
            **({} if options.get("limit") is None else options))

    async def auser_summary(self, token: str):
        self.accounts.sessions.require(token, role="admin")
        return await self.accounts.metadata.run_in_thread(self.accounts.account_summary)

    async def alist_clients(self, token: str, **options):
        self.accounts.sessions.require(token, role="admin")
        return await self.accounts.metadata.run_in_thread(self.list_clients, token, **options)

    def logout(self, token: str) -> None:
        self.accounts.sessions.revoke(token)

    def me(self, token: str) -> dict[str, object]:
        """返回管理员当前会话，用于刷新页面后恢复前端状态。"""
        session = self.accounts.sessions.require(token, role="admin")
        account = self.accounts.account_for_session(session)
        return {
            "id": account.id,
            "username": account.username,
            "role": account.role,
            "status": account.status,
            "csrf_token": session.csrf_token,
            "expires_at": session.expires_at,
        }

    def unlock(self, token: str, csrf: str, passphrase: str) -> dict[str, object]:
        session = self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        self.accounts.account_for_session(session)
        self.accounts.keystore.unlock(passphrase)
        return self.accounts.status()

    def lock(self, token: str, csrf: str) -> None:
        session = self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        del session
        self.accounts.keystore.lock()
        self.accounts.sessions.clear()

    def create_user(self, token: str, csrf: str, username: str, password: str,
                    quota_bytes: int | None = None) -> dict[str, object]:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        account = self.accounts.create_user(username, password, quota_bytes=quota_bytes)
        return {"id": account.id, "username": account.username, "bucket_id": account.bucket_id,
                "quota_bytes": quota_bytes}

    def list_users(self, token: str, *, limit: int | None = None, cursor: int = 0, query: str = "", status: str = ""):
        self.accounts.sessions.require(token, role="admin")
        return self.accounts.list_accounts() if limit is None else self.accounts.list_accounts_page(
            limit=limit, cursor=cursor, query=query, status=status)

    def set_user_status(self, token: str, csrf: str, user_id: int, status: str) -> None:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        self.accounts.set_account_status(user_id, status)

    def user_summary(self, token: str):
        self.accounts.sessions.require(token, role="admin")
        return self.accounts.account_summary()

    def reset_user_password(self, token: str, csrf: str, user_id: int, password: str) -> None:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        row = self.accounts.metadata.db.execute("SELECT role FROM users WHERE id=?", (user_id,)).fetchone()
        if row is not None and row["role"] == "admin":
            raise PermissionError("管理员请在账号菜单中修改自己的密码")
        self.accounts.reset_password(user_id, password)

    def change_own_password(self, token: str, csrf: str, old_password: str, new_password: str) -> None:
        session = self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        if len(new_password) < 8:
            raise ValueError("新密码至少需要 8 个字符")
        try:
            self.accounts.change_password(session, old_password, new_password)
            if space := getattr(self, "private_space", None):
                space.revoke_user(session.user_id)
        except AuthenticationError as exc:
            raise ValueError("当前密码不正确") from exc

    def change_passphrase(self, token: str, csrf: str, old: str, new: str) -> dict[str, object]:
        """更换加密口令：重新包裹所有文件密钥、访问密钥 Secret 与 Bot token。频道中的分片无需改动。"""
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        if len(new) < 12:
            raise ValueError("加密口令至少 12 个字符")
        if new == old:
            raise ValueError("新口令不能与当前口令相同")
        report = self.accounts.keystore.rotate(old, new)
        return {"key_version": report.new_version, "rewrapped_files": report.blob_count}

    async def delete_user(self, token: str, csrf: str, user_id: int, confirm: str) -> dict[str, object]:
        """永久删除用户：文件（含回收站）、访问密钥、存储桶与账号。需要输入用户名确认。"""
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        db = self.accounts.metadata.db
        row = db.execute("SELECT id, username, role, bucket_id FROM users WHERE id=?", (user_id,)).fetchone()
        if row is None:
            raise NotFoundError("user not found")
        if row["role"] == "admin":
            raise PermissionError("管理员账号不能删除")
        if confirm != row["username"]:
            raise ValueError("请输入用户名以确认删除")
        # 先禁止新写入，避免取消后台任务后、清理存储桶期间又出现新任务。
        self.accounts.set_account_status(user_id, "disabled")
        if offline := getattr(self, "offline", None):
            await offline.cancel_user(user_id)
        deleted = await self.objects.purge_bucket(row["bucket_id"]) if row["bucket_id"] is not None else 0
        with self.accounts.metadata.transaction() as tx:
            tx.execute("DELETE FROM clients WHERE owner_user_id=?", (user_id,))
            tx.execute("UPDATE users SET bucket_id=NULL WHERE id=?", (user_id,))
            if row["bucket_id"] is not None:
                tx.execute("DELETE FROM buckets WHERE id=?", (row["bucket_id"],))
            tx.execute("DELETE FROM users WHERE id=?", (user_id,))
        self.accounts.sessions.clear_user(user_id)
        return {"username": row["username"], "deleted_objects": deleted}

    def set_user_quota(self, token: str, csrf: str, user_id: int, quota_bytes: int | None) -> None:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        self.accounts.set_quota(user_id, quota_bytes)

    def create_client(self, token: str, csrf: str, name: str, grants: list[dict[str, object]]) -> dict[str, object]:
        session = self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        if any(int(grant["bucket_id"]) != account.bucket_id for grant in grants):
            raise PermissionError("访问密钥只能授权自己的存储桶")
        client_id, access_key, secret = self.clients.create_client_with_key(
            name, owner_user_id=account.id,
            grants=[(int(grant["bucket_id"]), str(grant.get("prefix", "")), str(grant.get("perms", "ro"))) for grant in grants])
        return {"id": client_id, "access_key_id": access_key, "secret": secret}

    def list_clients(self, token: str, *, limit: int | None = None, cursor: int = 0):
        session = self.accounts.sessions.require(token, role="admin")
        result = self.clients.list_clients(limit=limit, cursor=cursor)
        for item in result if isinstance(result, list) else result["clients"]:
            if item["owner_user_id"] != session.user_id:
                # 管理密钥的状态与归属即可，不暴露用户填写的名称、说明和文件夹路径。
                item["name"], item["description"] = f"访问凭据 #{item['id']}", None
                item["grants"] = [{**grant, "prefix": "", "path_hidden": True} for grant in item["grants"]]
        return result

    def set_client_status(self, token: str, csrf: str, client_id: int, status: str) -> None:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        self.clients.set_client_status(client_id, status)

    def disable_client_key(self, token: str, csrf: str, access_key_id: str) -> None:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        self.clients.disable_key(access_key_id)

    def delete_client_key(self, token: str, csrf: str, access_key_id: str) -> None:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        self.clients.delete_key(access_key_id)

    def delete_client(self, token: str, csrf: str, client_id: int) -> None:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        self.clients.delete_client(client_id)

    def grant_client(self, token: str, csrf: str, client_id: int, bucket_id: int, prefix: str, perms: str) -> None:
        session = self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        client = self.accounts.metadata.db.execute("SELECT owner_user_id FROM clients WHERE id=?", (client_id,)).fetchone()
        if client is None or client["owner_user_id"] != account.id or bucket_id != account.bucket_id:
            raise PermissionError("只能修改自己密钥的授权，且不能访问其他存储桶")
        self.clients.grant(client_id, bucket_id, prefix, perms)

    async def list_bots(self, token: str) -> list[dict[str, object]]:
        self.accounts.sessions.require(token, role="admin")
        if self.telegram_bots is None:
            return []
        items = self.telegram_bots.list()
        runtime = self.storage.bot_runtime() if self.storage is not None else {}
        usage = await self.accounts.metadata.run_in_thread(self.telegram_bots.storage_usage) if items else {}
        return [{**item, "runtime": runtime.get(str(item["id"])),
                 **usage.get(str(item["id"]), {"chunk_count": 0, "stored_bytes": 0})} for item in items]

    def create_bot(self, token: str, csrf: str, name: str, bot_token: str, channel_id: str) -> dict[str, object]:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        if self.telegram_bots is None:
            raise NotReadyError("Telegram Bot 配置尚未启用")
        return self.telegram_bots.create(name, bot_token, channel_id)

    async def check_bot(self, token: str, csrf: str, bot_id: int) -> dict[str, object]:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        if self.telegram_bots is None:
            raise NotReadyError("Telegram Bot 配置尚未启用")
        return await self.telegram_bots.check(bot_id)

    def set_bot_status(self, token: str, csrf: str, bot_id: int, status: str) -> None:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        if self.telegram_bots is None:
            raise NotReadyError("Telegram Bot 配置尚未启用")
        self.telegram_bots.set_status(bot_id, status)

    async def object_summary(self, token: str) -> dict[str, int]:
        """系统概览只读取汇总数量，不返回任何用户文件元信息。"""
        self.accounts.sessions.require(token, role="admin")
        def read():
            return self.objects.metadata.cached_read(("admin-object-summary",), lambda: dict(
                self.objects.metadata.db.execute(
                    "SELECT COUNT(*) AS total,COUNT(public_token) AS public_total FROM objects "
                    "WHERE substr(key,-1)!='/' AND substr(key,1,9)!='.tgdrive/'").fetchone()))
        return await self.accounts.metadata.run_in_thread(read)

    async def run_gc(self, token: str, csrf: str, limit: int = 100) -> dict[str, int]:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        if self.maintenance is None:
            raise NotReadyError("maintenance is not configured")
        report = await self.maintenance.gc.run_once(limit=limit)
        result = {"processed": report.processed, "deleted": report.deleted, "failed": report.failed, "dead": report.dead}
        self.maintenance.record("gc", result)
        return result

    def _maintenance(self):
        if self.maintenance is None:
            raise NotReadyError("maintenance is not configured")
        return self.maintenance

    def maintenance_status(self, token: str) -> dict[str, object]:
        self.accounts.sessions.require(token, role="admin")
        return self._maintenance().status()

    async def run_cleanup(self, token: str, csrf: str) -> dict[str, object]:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        report = await self.accounts.metadata.run_in_thread(self._maintenance().cleaner.run_once)
        result = {"aborted_uploads": report.aborted_uploads, "stale_blobs": report.stale_blobs,
                  "expired_upload_records": report.expired_upload_records}
        self._maintenance().record("cleanup", result)
        return result

    def retry_gc(self, token: str, csrf: str) -> dict[str, object]:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        return {"requeued": self._maintenance().gc.retry_dead()}

    def list_backups(self, token: str) -> list[dict[str, object]]:
        self.accounts.sessions.require(token, role="admin")
        return self._maintenance().backups.list()

    async def create_backup(self, token: str, csrf: str) -> dict[str, object]:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        import asyncio
        result = await asyncio.to_thread(self._maintenance().backups.create)
        self._maintenance().record("backup", result)
        return result

    def backup_path(self, token: str, name: str):
        self.accounts.sessions.require(token, role="admin")
        try:
            return self._maintenance().backups.path(name)
        except FileNotFoundError as exc:
            raise NotFoundError("备份不存在") from exc

    async def run_scrub(self, token: str, csrf: str, limit: int = 100, deep: bool = False) -> dict[str, object]:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        if self.maintenance is None:
            raise NotReadyError("maintenance is not configured")
        report = await self.maintenance.scrub.run_once(limit=limit, deep=deep)
        self.maintenance.record("scrub", {"checked": report.checked, "bad": len(report.bad),
                                          "bad_blobs": [uuid for uuid, _ in report.bad][:20], "wrapped": report.wrapped})
        return {"checked": report.checked, "bad": [{"blob_uuid": uuid, "chunks": chunks}
                                                      for uuid, chunks in report.bad], "wrapped": report.wrapped}

    @staticmethod
    def _session_payload(session: Session) -> dict[str, object]:
        return {"session": session.token, "csrf_token": session.csrf_token, "expires_at": session.expires_at,
                "username": session.username, "role": session.role, "remember": session.remember}


class UserApi:
    _path = staticmethod(normalize_user_path)

    def __init__(self, accounts: AccountService, objects: ObjectService,
                 clients: ClientAuthStore | None = None) -> None:
        self.accounts, self.objects, self.clients = accounts, objects, clients

    def _session(self, token: str, *, csrf: str | None = None, mutation: bool = False) -> Session:
        if not self.accounts.keystore.unlocked:
            raise NotReadyError("system is locked")
        # 文件空间接口接受任何角色的有效会话：管理员同样拥有自己的存储桶。管理接口另由 role="admin" 校验。
        return self.accounts.sessions.require(token, csrf=csrf, mutation=mutation)

    def login(self, username: str, password: str, ip: str | None = None, remember: bool = False) -> dict[str, object]:
        """统一登录入口：任何角色的账号都从这里登录，登录后的菜单与权限由角色决定。

        系统锁定时只有管理员可以登录（需要进入控制台输入口令解锁），普通用户得到“系统已锁定”。
        """
        session = self.accounts.login(username, password, ip=ip, remember=remember)
        if not self.accounts.keystore.unlocked and session.role != "admin":
            self.accounts.sessions.revoke(session.token)
            raise NotReadyError("system is locked")
        return AdminApi._session_payload(session)

    async def alogin(self, username: str, password: str, ip: str | None = None, remember: bool = False):
        session = await self.accounts.alogin(username, password, ip=ip, remember=remember)
        if not self.accounts.keystore.unlocked and session.role != "admin":
            self.accounts.sessions.revoke(session.token)
            raise NotReadyError("system is locked")
        return AdminApi._session_payload(session)

    # ---------- 账号资料 ----------

    def update_profile(self, token: str, csrf: str, nickname: object) -> dict[str, object]:
        return self.accounts.update_profile(self.accounts.sessions.require(token, csrf=csrf, mutation=True), nickname)

    async def change_email(self, token: str, csrf: str, password: object, email: object, ip: str | None = None):
        return await self.accounts.change_email(token, csrf, password, email, ip=ip)

    def set_avatar(self, token: str, csrf: str, data: object) -> dict[str, object]:
        import base64
        import binascii
        session = self.accounts.sessions.require(token, csrf=csrf, mutation=True)
        try:
            raw = base64.b64decode(str(data or "").split(",", 1)[-1], validate=True)
        except binascii.Error as exc:
            raise ValueError("头像数据不是有效的 base64") from exc
        return self.accounts.set_avatar(session, raw)

    def delete_avatar(self, token: str, csrf: str) -> dict[str, object]:
        return self.accounts.delete_avatar(self.accounts.sessions.require(token, csrf=csrf, mutation=True))

    def avatar(self, token: str) -> tuple[bytes, str, str]:
        return self.accounts.avatar(self.accounts.sessions.require(token).user_id)

    async def achange_password(self, token: str, csrf: str, old_password: str, new_password: str) -> None:
        session = self.accounts.sessions.require(token, csrf=csrf, mutation=True)
        if len(new_password) < 8:
            raise ValueError("新密码至少需要 8 个字符")
        try:
            await self.accounts.achange_password(session, old_password, new_password)
            if space := getattr(self, "private_space", None):
                space.revoke_user(session.user_id)
        except AuthenticationError as exc:
            raise ValueError("当前密码不正确") from exc

    async def alist_clients(self, token: str, **options):
        account = self.accounts.account_for_session(self._session(token))
        if self.clients is None:
            return [] if options.get("limit") is None else {"clients": [], "total": 0, "next_cursor": None}
        return await self.accounts.metadata.run_in_thread(self.clients.list_clients, owner_user_id=account.id, **options)

    async def alist_public(self, token: str, **options):
        scope = self._scope(token)
        return await self.objects.metadata.run_in_thread(self._list_public_scope, scope, **options)

    async def alist_trash(self, token: str, **options):
        scope = self._scope(token)
        return await self.objects.metadata.run_in_thread(self._list_trash_scope, scope, **options)

    def logout(self, token: str) -> None:
        self.accounts.sessions.require(token)
        self.accounts.sessions.revoke(token)
        if space := getattr(self, "private_space", None):
            space.revoke_session(token)

    def me(self, token: str) -> dict[str, object]:
        # 不检查锁定状态：管理员在锁定时也要能恢复会话并看到解锁入口。
        session = self.accounts.sessions.require(token)
        account = self.accounts.account_for_session(session)
        bucket = self.objects._bucket(account.bucket_id) if account.bucket_id is not None else None
        return {"id": account.id, "username": account.username, "role": account.role, **self.accounts.profile(account.id),
                "bucket_id": account.bucket_id, "quota_bytes": bucket["quota_bytes"] if bucket else None,
                "used_bytes": bucket["used_bytes"] if bucket else 0,
                "unlocked": self.accounts.keystore.unlocked, "remember": session.remember,
                "csrf_token": session.csrf_token, "expires_at": session.expires_at}

    def usage(self, token: str) -> dict[str, object]:
        """已用空间分项：回收站、私密空间（含其回收站）、助手对话附件与大缩略图都位于 .tgdrive/ 系统区，其余是我的文件。
        每项是 (bucket_id, key) 索引上的范围求和，不扫描整个存储桶。"""
        scope = self._scope(token)
        bucket = self.objects._bucket(scope.bucket_id)
        db = self.objects.metadata.db

        def total(prefix: str) -> int:
            return int(db.execute("SELECT COALESCE(SUM(size),0) FROM objects WHERE bucket_id=? AND key>=? AND key<?",
                                  (scope.bucket_id, prefix, prefix + "\U0010ffff")).fetchone()[0])

        trash = total(".tgdrive/trash/")
        private = total(".tgdrive/private/") + total(".tgdrive/private-trash/")
        assistant = total(".tgdrive/assistant/")
        thumbnails = total(self.objects.THUMBNAIL_PREFIX)
        used = int(bucket["used_bytes"])
        return {"total": used, "quota_bytes": bucket["quota_bytes"], "trash": trash, "private": private, "assistant": assistant,
                "thumbnails": thumbnails, "files": max(0, used - trash - private - assistant - thumbnails)}

    async def list(self, token: str, *, prefix: str = "", cursor: str | None = None, limit: int = 1000, public_only: bool = False,
                   kind: str = ""):
        session = self._session(token)
        account = self.accounts.account_for_session(session)
        path_prefix = self._path(prefix) if prefix else ""
        if kind:
            clause = kind_clause(kind)
            scope = self._scope(token)
            return await self.objects.metadata.run_in_thread(self._kind_directory_page, scope, path_prefix, cursor, limit, clause, public_only)
        if public_only:
            return await self.objects.metadata.run_in_thread(self._public_directory_page, account.bucket_id, path_prefix, cursor, limit)
        def read_page():
            scope = self._scope(token)
            page = self.objects.list_objects(scope, path_prefix, "/", cursor, min(limit, 1000))
            return {"objects": self._objects_json(page.objects),
                    "common_prefixes": page.common_prefixes, "next_cursor": page.next_cursor,
                    "folder_sizes": self.objects.folder_sizes(scope, page.common_prefixes),
                    "folder_modified": self.objects.folder_modified(scope, page.common_prefixes),
                    # 网格视图的文件夹封面：每个文件夹最多四张已有的列表小图，只读元数据。
                    "folder_previews": self.objects.folder_previews(scope, page.common_prefixes),
                    "public_folders": self._public_folders(account.bucket_id, page.common_prefixes)}
        return await self.objects.metadata.run_in_thread(read_page)

    def _public_directory_page(self, bucket_id: int, prefix: str, cursor: str | None, limit: int):
        limit = max(1, min(limit, 200))
        rows = self.objects.metadata.db.execute(
            "SELECT * FROM objects WHERE bucket_id=? AND key>? AND key<? AND key>? "
            "AND public_token IS NOT NULL AND substr(key,1,9)!='.tgdrive/' "
            "AND instr(rtrim(substr(key,?),'/'),'/')=0 ORDER BY key LIMIT ?",
            (bucket_id, prefix, prefix + self.objects._PREFIX_END, cursor or "", len(prefix) + 1, limit + 1)).fetchall()
        items = self._objects_json([self.objects._object(row) for row in rows[:limit]])
        folders = {item["key"]: item for item in items if item["key"].endswith("/")}
        return {"objects": [item for item in items if not item["key"].endswith("/")],
                "common_prefixes": list(folders), "public_folders": folders,
                "folder_sizes": self.objects.folder_sizes(Scope(bucket_id), list(folders)),
                "folder_modified": self.objects.folder_modified(Scope(bucket_id), list(folders)),
                "next_cursor": rows[limit - 1]["key"] if len(rows) > limit else None}

    def _kind_directory_page(self, scope: Scope, prefix: str, cursor: str | None, limit: int,
                             clause: tuple[str, list[str]], public_only: bool):
        """按类型筛选当前目录的文件（不含文件夹），键集分页；扫描范围与「公开」筛选相同，只看直接子项。"""
        if scope.authorize is not None:
            scope.authorize()
        effective = prefix or scope.prefix
        if effective.startswith((PRIVATE_PREFIX, PRIVATE_TRASH_PREFIX)) and not scope.private_access:
            raise PermissionError("私密空间需要单独解锁")
        if not effective.startswith(scope.prefix):
            raise PermissionError("prefix is outside scope")
        limit = max(1, min(limit, 200))
        condition, args = clause
        rows = self.objects.metadata.db.execute(
            "SELECT * FROM objects WHERE bucket_id=? AND key>? AND key<? AND key>? AND substr(key,-1)!='/' "
            "AND (substr(key,1,9)!='.tgdrive/' OR ?=1) AND instr(substr(key,?),'/')=0 "
            f"AND (?=0 OR public_token IS NOT NULL) AND {condition} ORDER BY key LIMIT ?",
            (scope.bucket_id, effective, effective + self.objects._PREFIX_END, cursor or "", int(scope.private_access),
             len(effective) + 1, int(public_only), *args, limit + 1)).fetchall()
        return {"objects": self._objects_json([self.objects._object(row) for row in rows[:limit]]),
                "common_prefixes": [], "folder_sizes": {}, "folder_modified": {}, "public_folders": {},
                "next_cursor": rows[limit - 1]["key"] if len(rows) > limit else None}

    STATS_LARGEST = 5

    async def stats(self, token: str, prefix: str = "") -> dict[str, object]:
        """目录统计（含所有子文件夹）：文件与文件夹数量、总大小、按类型分组的数量与大小、最大的几个文件。
        只在 (bucket_id, key) 索引的范围内聚合，不把对象读进内存；根目录不含 .tgdrive/ 系统区。"""
        self._session(token)
        scope = self._scope(token)
        prefix = self._path(prefix, directory=True) if prefix else ""
        effective = prefix or scope.prefix
        if effective.startswith((PRIVATE_PREFIX, PRIVATE_TRASH_PREFIX)) and not scope.private_access:
            raise PermissionError("私密空间需要单独解锁")
        if not effective.startswith(scope.prefix):
            raise PermissionError("prefix is outside scope")
        case, case_args = kind_case()

        def read():
            if scope.authorize is not None:
                scope.authorize()
            db = self.objects.metadata.db
            # 根目录排除系统区（回收站、私密空间、缩略图与助手附件）；私密空间的范围本身就在系统区内。
            where = "bucket_id=? AND key>=? AND key<? AND (substr(key,1,9)!='.tgdrive/' OR ?=1)"
            args = (scope.bucket_id, effective, effective + self.objects._PREFIX_END, int(effective.startswith(".tgdrive/")))
            kinds = [{"kind": row[0], "count": row[1], "bytes": row[2]} for row in db.execute(
                f"SELECT {case} AS kind, COUNT(*), COALESCE(SUM(size),0) FROM objects WHERE {where} AND substr(key,-1)!='/' "
                "GROUP BY kind ORDER BY 3 DESC, 2 DESC", (*case_args, *args))]
            largest = [{"key": row["key"], "size": row["size"], "content_type": row["content_type"]} for row in db.execute(
                f"SELECT key,size,content_type FROM objects WHERE {where} AND substr(key,-1)!='/' ORDER BY size DESC, key LIMIT ?",
                (*args, self.STATS_LARGEST))]
            # 文件夹包括目录标记与只由文件路径隐含的文件夹：按键顺序流式读取，只记住出现过的文件夹路径。
            folders, direct_files, direct_folders, latest = set(), 0, set(), 0.0
            for key, modified in db.execute(f"SELECT key, modified_at FROM objects WHERE {where}", args):
                relative = key[len(effective):]
                parts = relative.split("/")
                for depth in range(1, len(parts)):
                    folders.add("/".join(parts[:depth]))
                if len(parts) == 1 and relative:
                    direct_files += 1
                elif parts[0]:
                    direct_folders.add(parts[0])
                if not key.endswith("/"):
                    latest = max(latest, float(modified or 0))
            return {"prefix": effective if prefix else "", "files": sum(item["count"] for item in kinds),
                    "bytes": sum(item["bytes"] for item in kinds), "folders": len(folders),
                    "direct_files": direct_files, "direct_folders": len(direct_folders), "kinds": kinds,
                    "largest": largest, "latest_modified": latest or None}
        return await self.objects.metadata.run_in_thread(read)

    async def folders(self, token: str, *, prefix: str = "", cursor: str = "", limit: int = 50):
        account = self.accounts.account_for_session(self._session(token))
        scope = self._scope(token)
        prefix = self._path(prefix, directory=True) if prefix else ""
        prefix = prefix or scope.prefix
        limit = max(1, min(limit, 200))
        def read():
            if scope.authorize is not None:
                scope.authorize()
            # 包含隐式目录；找到目录后跳过整棵子树，不扫描其中每个文件来去重。
            folders = []
            position = cursor + self.objects._PREFIX_END if cursor else prefix
            while len(folders) <= limit:
                row = self.objects.metadata.db.execute(
                    "SELECT key FROM objects WHERE bucket_id=? AND key>? AND key<? "
                    "AND (substr(key,1,9)!='.tgdrive/' OR ?=1) AND instr(substr(key,?),'/')>0 ORDER BY key LIMIT 1",
                    (account.bucket_id, position, prefix + self.objects._PREFIX_END, int(scope.private_access), len(prefix) + 1)).fetchone()
                if row is None:
                    break
                folder = prefix + row["key"][len(prefix):].split("/", 1)[0] + "/"
                folders.append(folder)
                position = folder + self.objects._PREFIX_END
            return {"folders": folders[:limit], "next_cursor": folders[limit - 1] if len(folders) > limit else None}
        return await self.objects.metadata.run_in_thread(read)

    def check_files(self, token: str, csrf: str, paths: list[str]):
        scope = self._scope(token, csrf=csrf, mutation=True)
        if not isinstance(paths, list) or len(paths) > 200 or any(not isinstance(path, str) for path in paths):
            raise ValueError("一次最多检查 200 个文件")
        keys = [self._path(path) for path in paths]
        if not keys:
            return {"paths": []}
        marks = ",".join("?" for _ in keys)
        rows = self.objects.metadata.db.execute(
            f"SELECT key FROM objects WHERE bucket_id=? AND key IN ({marks})", (scope.bucket_id, *keys))
        return {"paths": [row["key"] for row in rows]}

    def _public_folders(self, bucket_id: int, prefixes: list[str]) -> dict[str, dict[str, object]]:
        """这一页里已公开的文件夹：{文件夹路径: 公开信息}。文件夹的分享信息保存在它的目录标记行上。"""
        if not prefixes:
            return {}
        marks = ",".join("?" for _ in prefixes)
        rows = self.objects.metadata.db.execute(
            f"SELECT * FROM objects WHERE bucket_id=? AND public_token IS NOT NULL AND key IN ({marks})", (bucket_id, *prefixes)).fetchall()
        return {row["key"]: self._object_json(self.objects._object(row)) for row in rows}

    async def search(self, token: str, query: str, cursor: str = "", limit: int = 100, public_only: bool = False, kind: str = ""):
        session = self._session(token)
        account = self.accounts.account_for_session(session)
        scope = self._scope(token)
        self.objects._bucket(account.bucket_id)
        limit = max(1, min(limit, 200))
        query = unicodedata.normalize("NFC", query.strip())
        if len(query) > 256:
            raise ValueError("搜索词不能超过 256 个字符")
        condition, kind_args = kind_clause(kind) if kind else ("1", [])
        def read_page():
            if scope.authorize is not None:
                scope.authorize()
            return self.objects.metadata.db.execute(
                "SELECT * FROM objects "
                "WHERE bucket_id=? AND key>? AND instr(lower(key),lower(?))>0 "
                "AND substr(key,-1)!='/' AND (substr(key,1,9)!='.tgdrive/' OR ?=1) "
                f"AND key>=? AND key<? AND (?=0 OR public_token IS NOT NULL) AND {condition} ORDER BY key LIMIT ?",
                (account.bucket_id, cursor, query, int(scope.private_access), scope.prefix,
                 scope.prefix + self.objects._PREFIX_END, int(public_only), *kind_args, limit + 1),
            ).fetchall()
        rows = await self.objects.metadata.run_in_thread(read_page)
        return {"objects": self._objects_json([self.objects._object(row) for row in rows[:limit]]), "common_prefixes": [],
                "next_cursor": rows[limit - 1]["key"] if len(rows) > limit else None}

    async def folder(self, token: str, csrf: str, path: str) -> dict[str, object]:
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        item = await self.objects.put_directory_marker(self._scope(token), self._path(path, directory=True))
        return self._object_json(item)

    async def put(self, token: str, csrf: str, path: str, body: bytes | AsyncIterator[bytes],
                  content_type: str | None = None, size: int | None = None,
                  public: bool | None = None) -> dict[str, object]:
        """上传对象；public 为 None 时保持原有公开状态，True/False 显式开启或关闭链接。"""
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        key = self._path(path)
        item = await self.objects.put_object(replace(self._scope(token), thumbnail_client=True), key, body,
                                             len(body) if isinstance(body, bytes) else size, content_type)
        if public is not None:
            item = self.objects.set_public(self._scope(token), key, public)
        return self._object_json(item)

    def instant_put(self, token: str, csrf: str, path: str, size: int, fingerprint: str,
                    content_type: str | None = None, public: bool | None = None) -> dict[str, object]:
        """秒传：存储桶内已有内容相同的文件时直接引用它；未命中返回 {"hit": False}，由前端走普通上传。"""
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        scope = replace(self._scope(token), thumbnail_client=True)
        key = self._path(path)
        item = self.objects.instant_put(scope, key, int(size), fingerprint, content_type)
        if item is None:
            return {"hit": False}
        if public is not None:
            item = self.objects.set_public(scope, key, public)
        return {"hit": True, **self._objects_json([item])[0]}

    def set_public(self, token: str, csrf: str, paths: list[str], public: bool,
                   options: dict[str, object] | None = None, *, password_hash=ObjectService._UNSET) -> list[dict[str, object]]:
        """开启/关闭公开分享；options 可包含 expires_at（时间戳或 None）与 password（字符串，空为取消）。"""
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        return [self._object_json(apply_share(self.objects, self._scope(token), self._path(path), public, options, password_hash=password_hash))
                for path in paths]

    async def aset_public(self, token: str, csrf: str, paths: list[str], public: bool, options=None):
        self._scope(token, csrf=csrf, mutation=True)
        encoded = ObjectService._UNSET
        if public and options and options.get("password"):
            encoded = await self.accounts.password_work.run(hash_password, str(options["password"]), min_length=4)
        return self.set_public(token, csrf, paths, public, options, password_hash=encoded)

    def _scope(self, token: str, *, csrf: str | None = None, mutation: bool = False) -> Scope:
        session = self._session(token, csrf=csrf, mutation=mutation)
        return Scope(self.accounts.account_for_session(session).bucket_id)

    # ---------- 回收站 ----------

    def list_trash(self, token: str, *, limit: int | None = None, cursor: str = "") -> dict[str, object]:
        return self._list_trash_scope(self._scope(token), limit=limit, cursor=cursor)

    def _list_trash_scope(self, scope: Scope, *, limit: int | None = None, cursor: str = ""):
        if scope.authorize is not None:
            scope.authorize()
        if limit is not None:
            limit = max(1, min(limit, 200))
            private = scope.prefix == PRIVATE_PREFIX
            where = "bucket_id=? AND (substr(original_path,1,?)=?)=?"
            args = [scope.bucket_id, len(PRIVATE_PREFIX), PRIVATE_PREFIX, int(private)]
            totals = self.objects.metadata.cached_read(("trash-total", scope.bucket_id, private),
                lambda: tuple(self.objects.metadata.db.execute(
                    f"SELECT COUNT(*),COALESCE(SUM(size),0) FROM trash WHERE {where}", args).fetchone()))
            if cursor:
                try:
                    deleted, entry_id = cursor.split("|", 1)
                    args.extend((float(deleted), float(deleted), entry_id))
                except (ValueError, TypeError) as exc:
                    raise ValueError("cursor 不合法") from exc
                where += " AND (deleted_at<? OR (deleted_at=? AND id<?))"
            rows = self.objects.metadata.db.execute(
                f"SELECT * FROM trash WHERE {where} ORDER BY deleted_at DESC,id DESC LIMIT ?", (*args, limit + 1)).fetchall()
            items = [{"id": row["id"], "path": row["original_path"], "is_folder": bool(row["is_folder"]), "size": row["size"],
                      "item_count": row["item_count"], "deleted_at": row["deleted_at"],
                      "purge_at": row["deleted_at"] + self.objects.TRASH_DAYS * 86400} for row in rows[:limit]]
            last = rows[limit - 1] if len(rows) > limit else None
            return {"items": items, "total": totals[0], "total_size": totals[1], "retention_days": self.objects.TRASH_DAYS,
                    "next_cursor": f"{last['deleted_at']!r}|{last['id']}" if last else None}
        items = self.objects.list_trash(scope.bucket_id, private=scope.prefix == PRIVATE_PREFIX)
        return {"items": items, "total_size": sum(int(item["size"]) for item in items), "retention_days": self.objects.TRASH_DAYS}

    async def trash(self, token: str, csrf: str, paths: list[str]) -> list[dict[str, object]]:
        scope = self._scope(token, csrf=csrf, mutation=True)
        return await self.objects.trash(scope, [self._path(path, directory=path.endswith("/")) for path in paths])

    def restore_trash(self, token: str, csrf: str, ids: list[str]) -> list[dict[str, object]]:
        return self.objects.restore(self._scope(token, csrf=csrf, mutation=True), [str(item) for item in ids])

    async def purge_trash(self, token: str, csrf: str, ids: list[str] | None) -> int:
        return await self.objects.purge_trash(self._scope(token, csrf=csrf, mutation=True),
                                              None if ids is None else [str(item) for item in ids])

    # ---------- 缩略图 ----------

    async def set_thumbnail(self, token: str, csrf: str, path: str, data: str | None, variant: str = "thumb",
                            *, etag: str | None = None, ticket: str | None = None) -> None:
        import base64
        import binascii
        raw = None
        if variant != "none":
            try:
                raw = base64.b64decode(str(data or "").split(",", 1)[-1], validate=True)
            except binascii.Error as exc:
                raise ValueError("缩略图数据不是有效的 base64") from exc
        scope, key = self._scope(token, csrf=csrf, mutation=True), self._path(path)
        if etag is not None or ticket is not None:
            info = self.objects.head_object(scope, key)
            def authorize():
                if scope.authorize is not None:
                    scope.authorize()
                current = self.objects.head_object(replace(scope, authorize=None), key)
                if current.etag != etag or current.blob_uuid != info.blob_uuid:
                    raise ValueError("文件已删除或覆盖，缩略图结果已丢弃")
                if ticket is not None:
                    self.objects.thumbnail_service.check_claim(current, ticket)
            authorize()
            guarded = replace(scope, authorize=authorize)
        else:
            guarded = scope  # 兼容旧客户端；新版客户端均带内容版本和生成票据。
        await self.objects.set_thumbnail(guarded, key, raw, variant)

    THUMBNAIL_STATUS_LIMIT = 200

    def thumbnail_status(self, token: str, paths: list) -> dict[str, object]:
        """页面等待缩略图时的轻量查询：只返回所列文件当前的 ETag 与缩略图状态，不读取列表或文件内容。
        已删除或不在授权范围内的路径不出现在结果里，由页面按需整页刷新。"""
        if not isinstance(paths, list) or not 1 <= len(paths) <= self.THUMBNAIL_STATUS_LIMIT or any(not isinstance(path, str) for path in paths):
            raise ValueError(f"一次最多查询 {self.THUMBNAIL_STATUS_LIMIT} 个文件")
        scope = self._scope(token)
        keys = []
        for path in dict.fromkeys(paths):
            key = self._path(path)
            self.objects._check_scope(scope, key)
            keys.append(key)
        if scope.authorize is not None:
            scope.authorize()
        rows = self.objects.metadata.db.execute(
            f"SELECT * FROM objects WHERE bucket_id=? AND key IN ({','.join('?' * len(keys))})", (scope.bucket_id, *keys)).fetchall()
        items = [self.objects._object(row) for row in rows]
        return {"files": {item["key"]: {name: item[name] for name in ("etag", "size", "modified_at", "has_thumbnail", "thumbnails", "thumbnail_versions")}
                          for item in self._objects_json(items)}}

    def thumbnail_claim(self, token, csrf, path, etag, force=False):
        scope = self._scope(token, csrf=csrf, mutation=True)
        return self.objects.thumbnail_service.claim(scope, self._path(path), etag, force=force)

    def thumbnail_release(self, token, csrf, path, etag, ticket, variants=None):
        scope = self._scope(token, csrf=csrf, mutation=True)
        key = self._path(path)
        if variants is not None:
            if (not isinstance(variants, list) or not variants or "thumb" not in variants
                    or any(not isinstance(value, str) or value not in self.objects.STORED_THUMBNAILS for value in variants)):
                raise ValueError("缩略图规格不正确")
            info = self.objects.head_object(scope, key)
            if info.etag != etag:
                raise ValueError("文件内容已变化，结果已丢弃")
            self.objects.thumbnail_service.check_claim(info, ticket)
            self.objects.finish_thumbnail_set(scope, key, variants)
        self.objects.thumbnail_service.release(scope, key, etag, ticket)

    def thumbnail_generate(self, token, csrf, path, etag):
        scope = self._scope(token, csrf=csrf, mutation=True)
        return self.objects.thumbnail_service.request(scope, self._path(path), etag)

    def thumbnail_candidates(self, token, csrf, path, etag, request_id=None, *, cancel=False):
        scope = self._scope(token, csrf=csrf, mutation=cancel or request_id is None)
        service, key = self.objects.thumbnail_service, self._path(path)
        if request_id is None:
            return service.request_candidates(scope, key, etag, token)
        if cancel:
            service.cancel_candidates(scope, key, etag, token, request_id)
            return None
        return service.candidates_status(scope, key, etag, token, request_id)

    def thumbnail_candidate_image(self, token, path, etag, request_id, index):
        return self.objects.thumbnail_service.candidate_image(self._scope(token), self._path(path), etag, token, request_id, index)

    async def thumbnail_select(self, token, csrf, path, etag, request_id, index):
        scope, key = self._scope(token, csrf=csrf, mutation=True), self._path(path)
        # 保存三种规格可能跨越多个网络请求，每次提交都复核登录会话、账号和私密解锁状态。
        guarded = replace(scope, authorize=lambda: self._scope(token))
        await self.objects.thumbnail_service.select_candidate(guarded, key, etag, token, request_id, index)

    async def thumbnail(self, token: str, path: str, variant: str = "thumb", *, bucket_id: int | None = None,
                        etag: str = "") -> tuple[bytes, str, str]:
        scope = self._scope(token)
        if bucket_id is not None and bucket_id != scope.bucket_id:
            raise PermissionError("缩略图所属文件空间不匹配")
        if etag and not path:
            # 网页地址按内容版本标识，不含路径：移动、改名后浏览器缓存继续有效。
            return await self.objects.get_thumbnail_by_etag(scope, etag, variant, accept=self._path)
        return await self.objects.get_thumbnail(scope, self._path(path), variant)

    # ---------- 可续传的分段上传 ----------

    async def create_upload(self, token: str, csrf: str, path: str, content_type: str | None) -> dict[str, object]:
        scope = self._scope(token, csrf=csrf, mutation=True)
        upload_id = await self.objects.create_multipart(scope, self._path(path), content_type)
        return {"upload_id": upload_id, "path": path, "part_size": 16 * 1024 * 1024}

    def get_upload(self, token: str, upload_id: str) -> dict[str, object]:
        scope = self._scope(token)
        row = self.objects._upload(scope, upload_id)
        parts = self.objects.list_parts(scope, upload_id)
        return {"upload_id": upload_id, "path": row["key"], "completed": row["completed_at"] is not None,
                "parts": [{"part_no": part.part_no, "size": part.size, "etag": part.etag} for part in parts]}

    async def upload_part(self, token: str, csrf: str, upload_id: str, part_no: int, body, size: int | None) -> dict[str, object]:
        scope = self._scope(token, csrf=csrf, mutation=True)
        part = await self.objects.upload_part(scope, upload_id, part_no, body, size)
        return {"part_no": part.part_no, "size": part.size, "etag": part.etag}

    async def complete_upload(self, token: str, csrf: str, upload_id: str, parts: list, public: bool | None) -> dict[str, object]:
        scope = replace(self._scope(token, csrf=csrf, mutation=True), thumbnail_client=True)
        info = await self.objects.complete_multipart(scope, upload_id, [(int(number), str(etag)) for number, etag in parts])
        if public is not None:
            info = self.objects.set_public(scope, info.key, public)
        return self._object_json(info)

    async def abort_upload(self, token: str, csrf: str, upload_id: str) -> None:
        await self.objects.abort_multipart(self._scope(token, csrf=csrf, mutation=True), upload_id)

    def list_public(self, token: str, *, cursor: str = "", limit: int | None = None):
        return self._list_public_scope(self._scope(token), cursor=cursor, limit=limit)

    def _list_public_scope(self, scope: Scope, *, cursor: str = "", limit: int | None = None):
        if limit is None:
            return self._objects_json(self.objects.list_public(scope.bucket_id))
        limit = max(1, min(limit, 200))
        condition = "bucket_id=? AND public_token IS NOT NULL AND substr(key,1,9)!='.tgdrive/'"
        total = self.objects.metadata.cached_read(("public-total", scope.bucket_id),
            lambda: self.objects.metadata.db.execute(f"SELECT COUNT(*) FROM objects WHERE {condition}", (scope.bucket_id,)).fetchone()[0])
        rows = self.objects.metadata.db.execute(
            f"SELECT * FROM objects WHERE {condition} AND key>? ORDER BY key LIMIT ?", (scope.bucket_id, cursor, limit + 1)).fetchall()
        items = self._objects_json([self.objects._object(row) for row in rows[:limit]])
        return {"objects": items, "total": total,
                "folder_sizes": self.objects.folder_sizes(scope, [item["key"] for item in items if item["key"].endswith("/")]),
                "folder_modified": self.objects.folder_modified(scope, [item["key"] for item in items if item["key"].endswith("/")]),
                "folder_previews": self.objects.folder_previews(scope, [item["key"] for item in items if item["key"].endswith("/")]),
                "next_cursor": rows[limit - 1]["key"] if len(rows) > limit else None}

    def change_password(self, token: str, csrf: str, old_password: str, new_password: str) -> None:
        session = self.accounts.sessions.require(token, csrf=csrf, mutation=True)
        if len(new_password) < 8:
            raise ValueError("新密码至少需要 8 个字符")
        try:
            self.accounts.change_password(session, old_password, new_password)
            if space := getattr(self, "private_space", None):
                space.revoke_user(session.user_id)
        except AuthenticationError as exc:
            # 旧密码错误不是会话失效，不能返回 401 触发前端退出登录。
            raise ValueError("当前密码不正确") from exc

    async def content(self, token: str, path: str, start: int = 0, end: int | None = None):
        session = self._session(token)
        account = self.accounts.account_for_session(session)
        # 网页读取：图片、视频的缩略图优先由预览页用已加载的画面生成，后台稍后才接管。
        return await self.objects.get_object(replace(self._scope(token), thumbnail_client=True), self._path(path), start, end)

    ARCHIVE_LIMIT = 200

    async def archive(self, token: str, paths: list[str]) -> tuple[str, AsyncIterator[tuple[str, int, float, AsyncIterator[bytes]]]]:
        """打包下载所选文件与文件夹（递归）。返回压缩包名与条目迭代器；条目逐个按需读取，不在内存中拼接。

        每个条目都经 content 读取，因此私密空间沿用逐块校验授权；文件夹按键集分页列出。"""
        if not isinstance(paths, list) or not 1 <= len(paths) <= self.ARCHIVE_LIMIT or any(not isinstance(p, str) for p in paths):
            raise ValueError(f"一次最多打包下载 {self.ARCHIVE_LIMIT} 项")
        keys = [self._path(p, directory=p.endswith("/")) for p in dict.fromkeys(paths)]
        # 文件夹与其中的项目同时选择时只打包最外层，避免重复。
        roots = [k for k in keys if not any(k != other and other.endswith("/") and k.startswith(other) for other in keys)]
        scope = self._scope(token)
        # 预先校验所选文件存在，避免下载到一半才发现缺文件。
        await self.objects.metadata.run_in_thread(lambda: [self.objects.head_object(scope, k) for k in roots if not k.endswith("/")])
        base = lambda key: key[:key.rstrip("/").rfind("/") + 1]

        async def entries():
            found = False
            for key in roots:
                if not key.endswith("/"):
                    info, stream = await self.content(token, key)
                    found = True
                    yield key[len(base(key)):], info.size, info.modified_at, stream
                    continue
                cursor: str | None = None
                while True:
                    page = await self.objects.metadata.run_in_thread(
                        lambda: self.objects.list_objects(self._scope(token), key, None, cursor, 200))
                    for item in page.objects:
                        if item.key.endswith("/"):
                            continue
                        info, stream = await self.content(token, item.key)
                        found = True
                        yield item.key[len(base(key)):], info.size, info.modified_at, stream
                    if not page.next_cursor:
                        break
                    cursor = page.next_cursor
            if not found:
                raise ValueError("所选文件夹中没有可下载的文件")

        single = roots[0].rstrip("/").rsplit("/", 1)[-1] if len(roots) == 1 else ""
        parent = "" if base(roots[0]) == PRIVATE_PREFIX else base(roots[0]).rstrip("/").rsplit("/", 1)[-1]
        return (single or parent or "files") + ".zip", entries()

    async def preview_assets(self, token: str, path: str):
        return await self.objects.apreview_assets(self._scope(token), self._path(path))

    async def preview_list(self, token: str, path: str, cursor: str | None = None):
        page = await self.objects.apreview_list(self._scope(token), self._path(path), cursor)
        items = await self.objects.metadata.run_in_thread(self._objects_json, page.objects)
        return {"objects": items, "next_cursor": page.next_cursor}

    async def delete(self, token: str, csrf: str, paths: list[str], recursive: bool = False) -> list[dict[str, object]]:
        """删除文件；recursive 为 True 时，以 / 结尾的路径会删除整个文件夹（在服务端分批完成）。"""
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        scope = self._scope(token)
        normalized = [self._path(path) for path in paths]
        results: list[dict[str, object]] = []
        plain = [key for key in normalized if not (recursive and key.endswith("/"))]
        for key in normalized:
            if recursive and key.endswith("/"):
                count = await self.objects.delete_prefix(scope, key)
                results.append({"path": key, "deleted": count > 0, "count": count})
        if plain:
            results.extend({"path": result.key, "deleted": result.deleted}
                           for result in await self.objects.delete_objects(scope, plain))
        return results

    async def move(self, token: str, csrf: str, source: str, target: str, conflict: str = "skip") -> dict[str, int]:
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        old = self._path(source, directory=source.endswith("/"))
        new = self._path(target, directory=target.endswith("/"))
        result = self.objects.move(self._scope(token), old, new, conflict)
        return {"moved": result.moved, "skipped": result.skipped}

    async def copy(self, token: str, csrf: str, source: str, target: str) -> dict[str, object]:
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        item = await self.objects.copy_object(self._scope(token), self._path(source),
                                              self._scope(token), self._path(target))
        return self._objects_json([item])[0]

    # ---------- 保存他人的分享 ----------

    def share_status(self, token: str, share_token: str) -> dict[str, object]:
        """只回答分享是否属于当前账号，不向访客透露分享者是谁。"""
        own = self.objects.resolve_public(share_token).bucket_id == self._scope(token).bucket_id
        return {"own": own}

    async def save_share(self, token: str, csrf: str, share_token: str, destination, paths) -> dict[str, object]:
        """把分享保存到自己的文件（普通目录，不能是私密空间）。调用方负责校验分享密码。"""
        scope = self._scope(token, csrf=csrf, mutation=True)
        if not isinstance(destination, str):
            raise ValueError("目标目录不正确")
        if paths is not None and (not isinstance(paths, list) or not all(isinstance(item, str) for item in paths)):
            raise ValueError("paths 必须为字符串数组")
        prefix = self._path(destination, directory=True) if destination else ""
        return await self.objects.asave_public(share_token, scope, prefix, paths or None)

    def list_clients(self, token: str, *, limit: int | None = None, cursor: int = 0):
        session = self._session(token)
        if self.clients is None:
            return [] if limit is None else {"clients": [], "total": 0, "next_cursor": None}
        return self.clients.list_clients(owner_user_id=session.user_id, limit=limit, cursor=cursor)

    def create_client(self, token: str, csrf: str, name: str) -> dict[str, object]:
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        if self.clients is None or account.bucket_id is None:
            raise NotReadyError("客户端密钥服务尚未启用")
        client_id, access_key, secret = self.clients.create_client_with_key(
            name, owner_user_id=account.id, grants=[(account.bucket_id, "", "rw")])
        return {"id": client_id, "access_key_id": access_key, "secret": secret}

    def _own_key(self, token: str, csrf: str, access_key_id: str) -> None:
        """只能操作自己创建的密钥。"""
        session = self._session(token, csrf=csrf, mutation=True)
        if self.clients is None:
            raise NotReadyError("客户端密钥服务尚未启用")
        row = self.clients.metadata.db.execute(
            "SELECT c.owner_user_id FROM client_keys k JOIN clients c ON c.id=k.client_id WHERE k.access_key_id=?",
            (access_key_id,),
        ).fetchone()
        if row is None or row["owner_user_id"] != session.user_id:
            raise PermissionError("不能操作其他用户的客户端")

    def disable_client_key(self, token: str, csrf: str, access_key_id: str) -> None:
        self._own_key(token, csrf, access_key_id)
        self.clients.disable_key(access_key_id)

    def delete_client_key(self, token: str, csrf: str, access_key_id: str) -> None:
        self._own_key(token, csrf, access_key_id)
        self.clients.delete_key(access_key_id)

    def _objects_json(self, items) -> list[dict[str, object]]:
        """序列化一页对象，并用一次查询附上缩略图状态。"""
        versions = self.objects.thumbnail_versions([item.blob_uuid for item in items])
        return [self._object_json(item, tuple(versions.get(item.blob_uuid or "", {})),
                                  versions.get(item.blob_uuid or "", {})) for item in items]

    @staticmethod
    def _object_json(item, thumbnails: list[str] | tuple[str, ...] = (), thumbnail_versions: dict[str, str] | None = None) -> dict[str, object]:
        meta = {key: value for key, value in item.user_meta.items() if key != ObjectService.THUMBNAIL_META}
        return {"key": item.key, "size": item.size, "etag": item.etag, "content_type": item.content_type,
                "user_meta": meta, "modified_at": item.modified_at,
                "has_thumbnail": "thumb" in thumbnails, "thumbnails": list(thumbnails), "thumbnail_versions": thumbnail_versions or {},
                "public_token": item.public_token, "public_at": item.public_at, "public_expires_at": item.public_expires_at,
                "public_has_password": item.public_has_password, "public_downloads": item.public_downloads}
