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
from . import favorites, library as media_library
from .playlists import ITEM_LIMIT as PLAYLIST_ITEMS, LIMIT as PLAYLIST_LIMIT, Playlists
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

    def _reclaimer(self):
        from .telegram.reclaim import BotReclaimer
        if self.storage is None or not hasattr(self.storage, "pool"):
            raise NotReadyError("Telegram Bot 配置尚未启用")
        return BotReclaimer(self.accounts.metadata, self.storage.pool)

    async def reclaim_status(self, token: str, bot_id: int) -> dict[str, int]:
        self.accounts.sessions.require(token, role="admin")
        return await self.accounts.metadata.run_in_thread(self._reclaimer().pending, str(bot_id))

    async def reclaim_bot(self, token: str, csrf: str, bot_id: int, limit: int = 200) -> dict[str, object]:
        """把失效 Bot 上传的分片交给其他可用 Bot 重新认领（见 telegram/reclaim.py）。每次处理一批，界面循环调用。"""
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        if type(limit) is not int:
            raise ValueError("每次认领数量必须是整数")
        return await self._reclaimer().run_once(str(bot_id), limit=limit)

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

    async def list_backups(self, token: str) -> list[dict[str, object]]:
        self.accounts.sessions.require(token, role="admin")
        import asyncio
        return await asyncio.to_thread(self._maintenance().backups.list)

    def backup_settings(self, token: str) -> dict[str, int]:
        self.accounts.sessions.require(token, role="admin")
        return self._maintenance().backups.settings()

    async def configure_backups(self, token: str, csrf: str, keep: int) -> dict[str, int]:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        return await self.accounts.metadata.run_in_thread(self._maintenance().backups.configure, keep)

    def remote_backup_settings(self, token: str) -> dict[str, object]:
        self.accounts.sessions.require(token, role="admin")
        remote = self._maintenance().remote_backup
        return remote.status() if remote is not None else {"enabled": False, "channel": "", "keep": 7, "bot": None, "has_token": False, "uploaded": []}

    async def configure_remote_backup(self, token: str, csrf: str, payload: dict) -> dict[str, object]:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        remote = self._maintenance().remote_backup
        if remote is None:
            raise ValueError("当前部署不支持把备份发送到 Telegram")
        return await remote.configure(payload)

    async def delete_backup(self, token: str, csrf: str, name: str) -> dict[str, str]:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        import asyncio
        try:
            return await asyncio.to_thread(self._maintenance().backups.delete, name)
        except FileNotFoundError as exc:
            raise NotFoundError("备份不存在") from exc

    async def create_backup(self, token: str, csrf: str) -> dict[str, object]:
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        import asyncio
        result = await self._maintenance().backup()
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
        self._playlists: Playlists | None = None

    @property
    def playlists(self) -> Playlists:
        if self._playlists is None:
            self._playlists = Playlists(self.objects.metadata)
        return self._playlists

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
        media = total(self.objects.file_metadata.PREFIX)
        used = int(bucket["used_bytes"])
        return {"total": used, "quota_bytes": bucket["quota_bytes"], "trash": trash, "private": private, "assistant": assistant,
                "thumbnails": thumbnails, "media": media, "files": max(0, used - trash - private - assistant - thumbnails - media)}

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

    def file_info(self, token: str, path: str) -> dict[str, object]:
        """单个文件的当前元数据（含 ETag 与缩略图状态）；文本编辑遇到版本冲突时用它取得最新版本。"""
        return self._objects_json([self.objects.head_object(self._scope(token), self._path(path))])[0]

    # ---------- 侧栏收藏 ----------

    def _private_unlocked(self, token: str) -> bool:
        """当前登录会话的私密空间是否已解锁（只复核，不续期）。"""
        space = getattr(self, "private_space", None)
        access = space.session_grants.get(token) if space is not None else None
        if not access:
            return False
        try:
            space.require(token, access)
        except Exception:  # noqa: BLE001 - 任何失效都视为未解锁
            return False
        return True

    def _favorite_path(self, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("收藏的文件夹不正确")
        if favorites.is_private(value):
            relative = value[len(favorites.PRIVATE_PREFIX):]
            return favorites.PRIVATE_PREFIX + self._path(relative, directory=True)
        return self._path(value, directory=True)

    def favorites(self, token: str) -> dict[str, object]:
        """侧栏收藏：私密文件夹锁定时也返回（locked=True，点击后先解锁）；missing 表示文件夹已不存在（显示为灰色，可移除）；
        icon 为空表示默认文件夹图标。"""
        scope = self._scope(token)
        unlocked = self._private_unlocked(token)
        db = self.objects.metadata.db
        items = []
        for entry in favorites.load(db, scope.bucket_id):
            path = entry["path"]
            private = favorites.is_private(path)
            exists = db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1",
                                (scope.bucket_id, path, path + ObjectService._PREFIX_END)).fetchone() is not None
            items.append({"path": path, "icon": entry["icon"], "private": private, "locked": private and not unlocked, "missing": not exists})
        return {"items": items, "limit": favorites.LIMIT}

    def set_favorites(self, token: str, csrf: str, items: object = None, paths: object = None) -> dict[str, object]:
        """保存收藏的顺序、内容与图标（items: [{path, icon}]；旧客户端只传 paths 时沿用已有图标）。
        私密收藏锁定时也可见，可以排序或移除；未解锁不能新增私密收藏。"""
        scope = self._scope(token, csrf=csrf, mutation=True)
        raw = items if items is not None else paths
        if not isinstance(raw, list) or len(raw) > favorites.LIMIT:
            raise ValueError(f"最多固定 {favorites.LIMIT} 个常用文件夹")
        unlocked = self._private_unlocked(token)
        with self.objects.metadata.transaction() as db:
            current = favorites.load(db, scope.bucket_id)
            icons = {entry["path"]: entry["icon"] for entry in current}
            given = []
            for value in raw:
                if isinstance(value, dict):
                    path = self._favorite_path(value.get("path"))
                    given.append({"path": path, "icon": favorites.icon_name(value.get("icon"))})
                else:
                    path = self._favorite_path(value)
                    given.append({"path": path, "icon": icons.get(path)})
            known = {entry["path"] for entry in current}
            if not unlocked and any(favorites.is_private(entry["path"]) and entry["path"] not in known for entry in given):
                from .private import PrivateLocked  # private 依赖 api，延迟导入避免循环
                raise PrivateLocked("请先解锁私密空间")
            favorites.store(db, scope.bucket_id, favorites.merge_hidden(current, given, set()))
        return self.favorites(token)

    def set_media_size(self, token: str, csrf: str, payload: dict) -> dict[str, bool]:
        """上传、预览或播放时读到图片／视频的尺寸后补记（只写入仍是同一版本的文件）。"""
        scope = self._scope(token, csrf=csrf, mutation=True)
        path, etag = payload.get("path"), payload.get("etag")
        if not isinstance(path, str) or not isinstance(etag, str):
            raise ValueError("缺少文件路径或版本")
        return {"saved": self.objects.set_media_size(scope, self._path(path), etag, payload.get("width"), payload.get("height"))}

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

    async def search(self, token: str, query: str, cursor: str = "", limit: int = 100, public_only: bool = False, kind: str = "", prefix: str = ""):
        """在授权范围内按名称搜索文件；prefix 为某个文件夹时只搜它及其子文件夹，关键词只匹配文件夹之下的相对路径。"""
        session = self._session(token)
        account = self.accounts.account_for_session(session)
        scope = self._scope(token)
        self.objects._bucket(account.bucket_id)
        limit = max(1, min(limit, 200))
        query = unicodedata.normalize("NFC", query.strip())
        if len(query) > 256:
            raise ValueError("搜索词不能超过 256 个字符")
        condition, kind_args = kind_clause(kind) if kind else ("1", [])
        base = self._path(prefix, directory=True) if prefix else scope.prefix
        if not base.startswith(scope.prefix):
            raise PermissionError("搜索范围超出授权")
        # 关键词只在 base 之下的相对路径里找：搜「照片」里的文件时，不会因为上级目录名包含关键词而全部命中。
        start = len(base) + 1
        def read_page():
            if scope.authorize is not None:
                scope.authorize()
            return self.objects.metadata.db.execute(
                "SELECT * FROM objects "
                "WHERE bucket_id=? AND key>? AND instr(lower(substr(key,?)),lower(?))>0 "
                "AND substr(key,-1)!='/' AND (substr(key,1,9)!='.tgdrive/' OR ?=1) "
                f"AND key>=? AND key<? AND (?=0 OR public_token IS NOT NULL) AND {condition} ORDER BY key LIMIT ?",
                (account.bucket_id, cursor, start, query, int(scope.private_access), base,
                 base + self.objects._PREFIX_END, int(public_only), *kind_args, limit + 1),
            ).fetchall()
        rows = await self.objects.metadata.run_in_thread(read_page)
        return {"objects": self._objects_json([self.objects._object(row) for row in rows[:limit]]), "common_prefixes": [],
                "next_cursor": rows[limit - 1]["key"] if len(rows) > limit else None}

    LIBRARY_VIEWS = ("recent", "photos", "videos", "music", "books")
    _LIBRARY_KINDS = {"photos": "image", "videos": "video", "music": "audio"}
    # 文件所在文件夹（以 / 结尾，根目录为空串）：rtrim 去掉末尾所有非 / 字符，即最后一个 / 之后的文件名。
    _FOLDER_SQL = "rtrim(o.key, replace(o.key, '/', ''))"
    LIBRARY_FOLDER_LIMIT = 2000
    # 音乐按文件级元数据（手动修改 > 首次解析）里的专辑名归类（只看名称，同名专辑不再按艺人区分）；没有专辑的歌曲归为空串一组。
    _ALBUM_SQL = "trim(coalesce(coalesce(json_extract(f.overrides,'$.album'),json_extract(f.auto_fields,'$.album')), ''))"
    # 曲目号（"3"、"3/12" 取前面的数字）；没有时排在有曲目号的歌曲之后。
    _TRACK_SQL = "CASE WHEN CAST(coalesce(json_extract(f.overrides,'$.track'),json_extract(f.auto_fields,'$.track')) AS INTEGER)>0 THEN CAST(coalesce(json_extract(f.overrides,'$.track'),json_extract(f.auto_fields,'$.track')) AS INTEGER) ELSE 1000000 END"

    @staticmethod
    def _field_sql(name: str) -> str:
        return f"coalesce(json_extract(f.overrides,'$.{name}'),json_extract(f.auto_fields,'$.{name}'))"

    def library_rules(self, token: str) -> dict[str, object]:
        scope = self._scope(token)
        rules = media_library.load(self.objects.metadata.db, scope.bucket_id)
        return {"folders": [{"path": path, "policy": rules[path]} for path in sorted(rules)
                            if not path.startswith(".tgdrive/")], "limit": media_library.FOLDER_LIMIT}

    def library_policy(self, token: str, path: str) -> dict[str, object]:
        scope = self._scope(token)
        directory = not path or path.endswith("/")
        path = self._path(path, directory=directory) if path else ""
        rules = media_library.load(self.objects.metadata.db, scope.bucket_id)
        effective, inherited = media_library.inherited(rules, path, directory=directory)
        if directory:
            count = self.objects.metadata.db.execute(
                "SELECT count(*) FROM objects WHERE bucket_id=? AND key>=? AND key<? "
                "AND substr(key,-1)!='/' AND substr(key,1,9)!='.tgdrive/'",
                (scope.bucket_id, path, path + self.objects._PREFIX_END)).fetchone()[0]
            return {"path": path, "policy": rules.get(path, "auto"), "effective": effective,
                    "inherited_from": None if path in rules else inherited, "directory": True, "count": count}
        info = self.objects.head_object(scope, path)
        row = self.objects.file_metadata.row(info.metadata_id)
        policy = row["library_policy"] if row else "auto"
        if policy != "auto":
            effective, inherited = policy, None
        category = media_library.category(info.key, info.content_type)
        automatic = category != "books" or media_library.book_type(info.key, info.content_type)
        included = category is not None and effective != "exclude" and (automatic or effective == "include")
        return {"path": path, "policy": policy, "effective": effective, "inherited_from": inherited,
                "directory": False, "category": category, "included": included,
                "requires_include": category == "books" and not automatic}

    def set_library_policy(self, token: str, csrf: str, paths: object, policy: object) -> dict[str, object]:
        scope = self._scope(token, csrf=csrf, mutation=True)
        if policy not in media_library.POLICIES:
            raise ValueError("媒体库收录方式不正确")
        if not isinstance(paths, list) or not paths or len(paths) > 1000 or not all(isinstance(path, str) for path in paths):
            raise ValueError("请选择 1–1000 个文件或文件夹")
        paths = list(dict.fromkeys(self._path(path, directory=path.endswith("/")) if path else "" for path in paths))
        with self.objects.metadata.transaction() as db:
            rules = media_library.load(db, scope.bucket_id)
            previous_count = sum(not path.startswith(".tgdrive/") for path in rules)
            files = []
            for path in paths:
                if not path or path.endswith("/"):
                    if policy == "auto":
                        rules.pop(path, None)
                    else:
                        if path and db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1",
                                               (scope.bucket_id, path, path + self.objects._PREFIX_END)).fetchone() is None:
                            raise NotFoundError("文件夹已不存在，请刷新后重试")
                        rules[path] = policy
                else:
                    info = self.objects.head_object(scope, path)
                    if policy == "include" and media_library.category(info.key, info.content_type) is None:
                        raise ValueError("只能收录图片、音视频和书籍；PDF、TXT 可以手动作为书籍加入")
                    files.append(info)
            count = sum(not path.startswith(".tgdrive/") for path in rules)
            if count > media_library.FOLDER_LIMIT and count > previous_count:
                raise ValueError(f"最多设置 {media_library.FOLDER_LIMIT} 条文件夹收录规则")
            # 所有输入验证完成后一起提交，批量失败不能只改一部分文件。
            for info in files:
                ident = info.metadata_id
                if not ident or self.objects.file_metadata.row(ident) is None:
                    ident = self.objects.file_metadata.create(db, scope.bucket_id, info.blob_uuid, info.key, info.content_type)
                    db.execute("UPDATE objects SET metadata_id=? WHERE bucket_id=? AND key=?", (ident, scope.bucket_id, info.key))
                db.execute("UPDATE file_metadata SET library_policy=? WHERE id=? AND bucket_id=?", (policy, ident, scope.bucket_id))
            media_library.store(db, scope.bucket_id, rules)
            self._scope(token, csrf=csrf, mutation=True)
        return {"updated": len(paths)}

    def _library_filter(self, token: str, view: str, query: str, collection: str = "included"):
        """媒体库公共条件：普通文件（不含私密空间与系统区）、按视图限定类型、可选关键词。
        关键词匹配授权前缀之下的相对路径（文件夹名或文件名）；音乐另匹配标签里的歌名、艺人与专辑。"""
        if view not in self.LIBRARY_VIEWS:
            raise ValueError("浏览方式不正确")
        if collection not in media_library.COLLECTIONS:
            raise ValueError("媒体库收录范围不正确")
        query = query.strip()
        if len(query) > 200:
            raise ValueError("搜索词太长")
        session = self._session(token)
        account = self.accounts.account_for_session(session)
        scope = self._scope(token)
        base = scope.prefix
        sql = "o.bucket_id=? AND o.key>=? AND o.key<? AND substr(o.key,-1)!='/' AND substr(o.key,1,9)!='.tgdrive/'"
        args: list[object] = [account.bucket_id, base, base + self.objects._PREFIX_END]
        source = "objects o"
        if view != "recent":
            source, rule_args = media_library.source(media_library.load(self.objects.metadata.db, account.bucket_id), self.objects._PREFIX_END)
            args = rule_args + args
        if view in self._LIBRARY_KINDS:
            # kind_clause 只引用 objects 独有的 key、content_type 列，与其他表连接后不需要加表名。
            condition, kind_args = kind_clause(self._LIBRARY_KINDS[view])
            sql += f" AND {condition}"
            args += kind_args
        elif view == "books":
            condition, book_args = media_library.book_clause(documents=True)
            sql += f" AND {condition}"
            args += book_args
        if view != "recent" and collection != "all":
            included = "o.library_policy!='exclude'"
            if view == "books":
                automatic, automatic_args = media_library.book_clause()
                included += f" AND ({automatic} OR o.library_policy='include')"
                args += automatic_args
            sql += f" AND {'NOT ' if collection == 'excluded' else ''}({included})"
        if query:
            fields = ["lower(substr(o.key,?))"]
            if view == "music":
                fields += [f"lower(coalesce({self._field_sql(name)},''))" for name in ("title", "artist", "album")]
            sql += " AND (" + " OR ".join(f"instr({field},lower(?))>0" for field in fields) + ")"
            args += [len(base) + 1, query] + [query] * (len(fields) - 1)
        joins = "LEFT JOIN blobs b ON b.uuid=o.blob_uuid" + (" LEFT JOIN file_metadata f ON f.id=o.metadata_id" if view == "music" else "")
        return account, base, source, joins, sql, args

    async def library(self, token: str, view: str, cursor: str = "", limit: int = 100,
                      query: str = "", folder: str | None = None, album: str | None = None,
                      collection: str = "included") -> dict[str, object]:
        """跨文件夹浏览：recent 全部最近文件；photos（图片）、videos（视频）、music（音频）、books（书籍）。
        folder 给出时只列这个文件夹里直接包含的文件（照片按拍摄时间倒序，其余按路径）；没有 folder 时按路径排列，
        网页按所在文件夹（音乐按专辑）分段（搜索结果）。album 只用于音乐：标签里专辑名（去掉首尾空白）相同的歌曲，
        空串为没有专辑的歌曲。键集分页，游标是上一页最后一项。"""
        _, base, source, joins, sql, args = self._library_filter(token, view, query, collection)
        limit = max(1, min(limit, 500))
        if album is not None and view == "music":
            sql += f" AND {self._ALBUM_SQL}=?"
            args.append(album.strip())
        if folder is not None and view != "recent":
            folder = self._path(folder, directory=True) if folder else ""
            start = base + folder
            sql += " AND o.key>=? AND o.key<? AND instr(substr(o.key,?),'/')=0"
            args += [start, start + self.objects._PREFIX_END, len(start) + 1]
        by_time = view == "recent" or (view == "photos" and folder is not None)
        if by_time:
            sort = "o.modified_at" if view == "recent" else "COALESCE(b.taken_at, o.modified_at)"
            order = f"{sort} DESC, o.key"
            after: tuple[str, list[object]] = ("", [])
            if cursor:
                stamp, _, key = cursor.partition("\n")
                try:
                    stamp_value = float(stamp)
                except ValueError as exc:
                    raise ValueError("游标不正确") from exc
                after = (f"AND ({sort}<? OR ({sort}=? AND o.key>?))", [stamp_value, stamp_value, key])
        else:
            sort = order = "o.key"
            after = ("AND o.key>?", [cursor]) if cursor else ("", [])

        def read_page():
            return self.objects.metadata.db.execute(
                f"SELECT o.*, b.taken_at AS taken_at, {sort} AS sort_value FROM {source} {joins} "
                f"WHERE {sql} {after[0]} ORDER BY {order} LIMIT ?", (*args, *after[1], limit + 1)).fetchall()
        rows = await self.objects.metadata.run_in_thread(read_page)
        page = rows[:limit]
        objects = self._objects_json([self.objects._object(row) for row in page])
        for value, row in zip(objects, page):
            if row["taken_at"] is not None:
                value["taken_at"] = row["taken_at"]
            if view != "recent":
                automatic = view != "books" or media_library.book_type(row["key"], row["content_type"])
                value["library"] = {"policy": row["file_library_policy"], "effective": row["library_policy"],
                                    "included": row["library_policy"] != "exclude" and (automatic or row["library_policy"] == "include")}
        last = page[-1] if len(rows) > limit else None
        next_cursor = None if last is None else f"{last['sort_value']!r}\n{last['key']}" if by_time else last["key"]
        return {"objects": objects, "next_cursor": next_cursor}

    async def library_folders(self, token: str, view: str, query: str = "", collection: str = "included") -> dict[str, object]:
        """媒体库按文件夹分组：相册、影视与书籍给出数量、大小、最近时间与最多 4 个样本（照片取最新的，
        影视与书籍按路径取前几个），文件夹按最近时间倒序。最多 LIBRARY_FOLDER_LIMIT 个文件夹。音乐见 library_albums。"""
        if view not in ("photos", "videos", "books"):
            raise ValueError("浏览方式不正确")
        _, base, source, joins, sql, args = self._library_filter(token, view, query, collection)
        stamp = "COALESCE(b.taken_at, o.modified_at)" if view == "photos" else "o.modified_at"
        sample = "stamp DESC, key" if view == "photos" else "key"
        folder_order = "latest DESC, folder"
        limit = self.LIBRARY_FOLDER_LIMIT

        def read():
            return self.objects.metadata.db.execute(
                f"WITH media AS (SELECT o.*, {stamp} AS stamp, {self._FOLDER_SQL} AS folder FROM {source} {joins} WHERE {sql}), "
                f"ranked AS (SELECT *, row_number() OVER (PARTITION BY folder ORDER BY {sample}) AS rank, "
                "count(*) OVER (PARTITION BY folder) AS total, sum(size) OVER (PARTITION BY folder) AS bytes, "
                "max(stamp) OVER (PARTITION BY folder) AS latest FROM media), "
                f"folders AS (SELECT folder FROM ranked WHERE rank=1 ORDER BY {folder_order} LIMIT ?) "
                f"SELECT * FROM ranked WHERE rank<=4 AND folder IN (SELECT folder FROM folders) ORDER BY {folder_order}, rank",
                (*args, limit + 1)).fetchall()
        rows = await self.objects.metadata.run_in_thread(read)
        groups: dict[str, dict[str, object]] = {}
        samples: dict[str, list] = {}
        for row in rows:
            path = row["folder"][len(base):]
            if path not in groups:
                groups[path] = {"path": path, "count": row["total"], "size": row["bytes"] or 0, "latest": row["latest"]}
                samples[path] = []
            samples[path].append(row)
        truncated = len(groups) > limit
        folders = list(groups.values())[:limit]
        for item in folders:
            item["samples"] = self._objects_json([self.objects._object(row) for row in samples[item["path"]]])
        return {"folders": folders, "truncated": truncated}

    async def library_albums(self, token: str, query: str = "", collection: str = "included") -> dict[str, object]:
        """音乐按专辑归类：标签里专辑名相同的歌曲为一张专辑（不区分艺人），没有专辑的歌曲合为 album 为空串的一项（排在最后）。
        每张专辑给出数量、大小、总时长、艺人（只有一位时，否则为「多位艺人」）与按曲目号排在最前的 4 首（第一首的封面作专辑封面）。"""
        _, _, source, joins, sql, args = self._library_filter(token, "music", query, collection)
        limit = self.LIBRARY_FOLDER_LIMIT

        def read():
            return self.objects.metadata.db.execute(
                f"WITH media AS (SELECT o.*, {self._ALBUM_SQL} AS album, nullif(trim(coalesce({self._field_sql('artist')},'')),'') AS artist, "
                f"{self._field_sql('year')} AS year, coalesce(json_extract(f.auto_fields,'$.duration'), 0) AS duration, {self._TRACK_SQL} AS track_no FROM {source} {joins} WHERE {sql}), "
                "ranked AS (SELECT *, row_number() OVER (PARTITION BY album ORDER BY track_no, key) AS rank, "
                "count(*) OVER (PARTITION BY album) AS total, sum(size) OVER (PARTITION BY album) AS bytes, "
                "sum(duration) OVER (PARTITION BY album) AS seconds, max(modified_at) OVER (PARTITION BY album) AS latest, "
                "min(artist) OVER (PARTITION BY album) AS artist_first, max(artist) OVER (PARTITION BY album) AS artist_last, "
                "max(year) OVER (PARTITION BY album) AS album_year FROM media), "
                "albums AS (SELECT album FROM ranked WHERE rank=1 ORDER BY album='', album LIMIT ?) "
                "SELECT * FROM ranked WHERE rank<=4 AND album IN (SELECT album FROM albums) ORDER BY album='', album, rank",
                (*args, limit + 1)).fetchall()
        rows = await self.objects.metadata.run_in_thread(read)
        groups: dict[str, dict[str, object]] = {}
        samples: dict[str, list] = {}
        for row in rows:
            name = row["album"]
            if name not in groups:
                artist = row["artist_first"] if row["artist_first"] == row["artist_last"] else "多位艺人"
                groups[name] = {"album": name, "count": row["total"], "size": row["bytes"] or 0, "duration": row["seconds"] or 0,
                                "latest": row["latest"], "artist": artist, "year": row["album_year"]}
                samples[name] = []
            samples[name].append(row)
        truncated = len(groups) > limit
        albums = list(groups.values())[:limit]
        for item in albums:
            item["samples"] = self._objects_json([self.objects._object(row) for row in samples[item["album"]]])
        return {"albums": albums, "truncated": truncated}

    # ---------- 星标 ----------

    def _file_paths(self, paths: object, limit: int) -> list[str]:
        if not isinstance(paths, list) or not paths or len(paths) > limit or not all(isinstance(path, str) for path in paths):
            raise ValueError(f"请选择 1–{limit} 个文件")
        return [self._path(path) for path in paths]

    async def set_starred(self, token: str, csrf: str, paths: object, starred: object) -> dict[str, object]:
        self._session(token, csrf=csrf, mutation=True)
        keys = self._file_paths(paths, self.objects.STAR_LIMIT)
        changed = await self.objects.metadata.run_in_thread(self.objects.set_starred, self._scope(token), keys, bool(starred))
        return {"changed": changed, "starred": bool(starred)}

    async def starred(self, token: str, cursor: str = "", limit: int = 100, query: str = "", kind: str = "") -> dict[str, object]:
        """「星标」视图：普通空间里加了星标的文件，最近加星标的在前；可按关键词（相对路径）与类型筛选。键集分页。"""
        account = self.accounts.account_for_session(self._session(token))
        scope = self._scope(token)
        limit = max(1, min(limit, 500))
        query = unicodedata.normalize("NFC", query.strip())
        if len(query) > 200:
            raise ValueError("搜索词太长")
        sql = "bucket_id=? AND starred_at IS NOT NULL AND substr(key,1,9)!='.tgdrive/' AND key>=? AND key<?"
        args: list[object] = [account.bucket_id, scope.prefix, scope.prefix + self.objects._PREFIX_END]
        if kind:
            condition, kind_args = kind_clause(kind)
            sql += f" AND {condition}"
            args += kind_args
        if query:
            sql += " AND instr(lower(substr(key,?)),lower(?))>0"
            args += [len(scope.prefix) + 1, query]
        if cursor:
            stamp, _, key = cursor.partition("\n")
            try:
                value = float(stamp)
            except ValueError as exc:
                raise ValueError("游标不正确") from exc
            sql += " AND (starred_at<? OR (starred_at=? AND key>?))"
            args += [value, value, key]

        def read_page():
            return self.objects.metadata.db.execute(
                f"SELECT * FROM objects WHERE {sql} ORDER BY starred_at DESC, key LIMIT ?", (*args, limit + 1)).fetchall()
        rows = await self.objects.metadata.run_in_thread(read_page)
        page = rows[:limit]
        last = page[-1] if len(rows) > limit else None
        return {"objects": self._objects_json([self.objects._object(row) for row in page]),
                "next_cursor": None if last is None else f"{last['starred_at']!r}\n{last['key']}"}

    # ---------- 歌单 ----------

    def _playlist_bucket(self, token: str, csrf: str | None = None, *, mutation: bool = False) -> int:
        account = self.accounts.account_for_session(self._session(token, csrf=csrf, mutation=mutation))
        if account.bucket_id is None:
            raise PermissionError("该账号没有文件空间")
        return account.bucket_id

    async def list_playlists(self, token: str) -> dict[str, object]:
        bucket_id = self._playlist_bucket(token)
        def read():
            items = self.playlists.list(bucket_id)
            for item in items:
                item["samples"] = self._objects_json([self.objects._object(row) for row in item["samples"]])
            return {"playlists": items, "limit": self.playlists_limit()}
        return await self.objects.metadata.run_in_thread(read)

    @staticmethod
    def playlists_limit() -> dict[str, int]:
        return {"playlists": PLAYLIST_LIMIT, "items": PLAYLIST_ITEMS}

    async def playlist(self, token: str, playlist_id: int, cursor: str = "", limit: int = 200) -> dict[str, object]:
        bucket_id = self._playlist_bucket(token)
        try:
            position = int(cursor) if cursor else -1
        except ValueError as exc:
            raise ValueError("游标不正确") from exc
        def read():
            rows, next_position = self.playlists.items(bucket_id, playlist_id, position, limit)
            return {"playlist": self.playlists.get(bucket_id, playlist_id),
                    "objects": self._objects_json([self.objects._object(row) for row in rows]),
                    "next_cursor": None if next_position is None else str(next_position)}
        return await self.objects.metadata.run_in_thread(read)

    async def create_playlist(self, token: str, csrf: str, name: object, paths: object = None) -> dict[str, object]:
        bucket_id = self._playlist_bucket(token, csrf, mutation=True)
        keys = self._file_paths(paths, self.playlists_limit()["items"]) if paths else []
        playlist_id = await self.objects.metadata.run_in_thread(self.playlists.create, bucket_id, name, keys)
        return self.playlists.get(bucket_id, playlist_id)

    async def update_playlist(self, token: str, csrf: str, playlist_id: int, payload: dict) -> dict[str, object]:
        """改名（name）、追加（add）、移除（remove）或调整一首歌的位置（move: {path, before}），可以同时给出几项。"""
        bucket_id = self._playlist_bucket(token, csrf, mutation=True)
        limit = self.playlists_limit()["items"]
        def write():
            result: dict[str, object] = {}
            if "name" in payload:
                self.playlists.rename(bucket_id, playlist_id, payload["name"])
            if payload.get("add"):
                result["added"] = self.playlists.add(bucket_id, playlist_id, self._file_paths(payload["add"], limit))
            if payload.get("remove"):
                result["removed"] = self.playlists.remove(bucket_id, playlist_id, self._file_paths(payload["remove"], limit))
            move = payload.get("move")
            if move is not None:
                if not isinstance(move, dict) or not isinstance(move.get("path"), str) or not isinstance(move.get("before"), (str, type(None))):
                    raise ValueError("调整顺序的参数不正确")
                self.playlists.move(bucket_id, playlist_id, self._path(move["path"]),
                                    None if move.get("before") is None else self._path(move["before"]))
            return {**self.playlists.get(bucket_id, playlist_id), **result}
        return await self.objects.metadata.run_in_thread(write)

    async def delete_playlist(self, token: str, csrf: str, playlist_id: int) -> None:
        bucket_id = self._playlist_bucket(token, csrf, mutation=True)
        await self.objects.metadata.run_in_thread(self.playlists.delete, bucket_id, playlist_id)

    async def share_playlist(self, token: str, csrf: str, playlist_id: int, payload: dict) -> dict[str, object]:
        """开启、修改或关闭歌单分享：enabled、expires_at（时间戳或 None）、password（字符串，空为取消；不给出时不变）、
        download、save（默认关闭）。密码哈希在专用线程里计算，不占用事件循环。"""
        bucket_id = self._playlist_bucket(token, csrf, mutation=True)
        enabled = payload.get("enabled", True) is not False
        options: dict[str, object] = {}
        if enabled:
            if "expires_at" in payload:
                value = payload["expires_at"]
                if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
                    raise ValueError("有效期不正确")
                options["expires_at"] = value
            if "password" in payload:
                password = payload["password"]
                if password not in (None, "") and (not isinstance(password, str) or len(password) < 4 or len(password) > 128):
                    raise ValueError("访问密码需要 4–128 个字符")
                options["password_hash"] = await self.accounts.password_work.run(hash_password, password, min_length=4) if password else None
            for name in ("download", "save"):
                if name in payload:
                    options[name] = bool(payload[name])
        share = await self.objects.metadata.run_in_thread(lambda: self.playlists.set_share(bucket_id, playlist_id, enabled, **options))
        return {"share": share}

    def public_playlist_items(self, row) -> list[dict[str, object]]:
        """访客看到的歌曲：编号、文件名与标签信息、大小、类型和封面状态；不含存放路径与公开链接字段。"""
        rows = self.playlists.public_items(row)
        values = self._objects_json([self.objects._object(item) for item in rows])
        kept = ("size", "etag", "content_type", "modified_at", "media", "has_thumbnail", "thumbnails", "thumbnail_status", "thumbnail_versions")
        return [{"id": self.playlists.item_id(row["share_token"], item["key"]), "name": item["key"].rsplit("/", 1)[-1],
                 **{name: value[name] for name in kept if name in value}} for item, value in zip(rows, values)]

    def playlist_share_status(self, token: str, share_token: str) -> dict[str, object]:
        """只回答这个歌单分享是不是当前账号自己的，不向访客透露分享者。"""
        return {"own": self.playlists.public(share_token)["bucket_id"] == self._scope(token).bucket_id}

    async def save_playlist_share(self, token: str, csrf: str, share_token: str, destination: object, items: object) -> dict[str, object]:
        """把分享歌单里的歌曲保存到自己的文件夹：引用同一份数据（不复制），计入自己的空间，同名时自动改名。
        分享者需开启「允许保存」；items 是访客看到的歌曲编号，省略时保存全部。调用方负责校验分享密码。"""
        scope = self._scope(token, csrf=csrf, mutation=True)
        if not isinstance(destination, str):
            raise ValueError("目标目录不正确")
        if items is not None and (not isinstance(items, list) or not all(isinstance(item, str) for item in items) or len(items) > 5000):
            raise ValueError("items 必须为歌曲编号数组")
        prefix = self._path(destination, directory=True) if destination else ""

        def save():
            row = self.playlists.public(share_token)
            if not row["share_save"]:
                raise ValueError("分享者没有允许保存这个歌单里的歌曲")
            if row["bucket_id"] == scope.bucket_id:
                raise ValueError("这是你自己分享的歌单，歌曲已经在你的文件中")
            chosen = self.playlists.public_items(row)
            if items is not None:
                wanted = set(items)
                chosen = [item for item in chosen if self.playlists.item_id(share_token, item["key"]) in wanted]
            if not chosen:
                raise ValueError("没有可保存的歌曲")
            saved = [self.objects.link_copy(row["bucket_id"], item["key"], scope, prefix + item["key"].rsplit("/", 1)[-1]).key for item in chosen]
            return {"saved": len(saved), "items": saved}
        return await self.objects.metadata.run_in_thread(save)

    async def playlists_containing(self, token: str, paths: object) -> dict[str, object]:
        bucket_id = self._playlist_bucket(token)
        keys = self._file_paths(paths, 500)
        return {"playlists": await self.objects.metadata.run_in_thread(self.playlists.containing, bucket_id, keys)}

    async def folder(self, token: str, csrf: str, path: str) -> dict[str, object]:
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        item = await self.objects.put_directory_marker(self._scope(token), self._path(path, directory=True))
        return self._object_json(item)

    async def put(self, token: str, csrf: str, path: str, body: bytes | AsyncIterator[bytes],
                  content_type: str | None = None, size: int | None = None,
                  public: bool | None = None, if_match: str | None = None) -> dict[str, object]:
        """上传对象；public 为 None 时保持原有公开状态，True/False 显式开启或关闭链接。
        if_match 是打开时的 ETag（文本编辑保存、图片编辑覆盖原图）：对象已被改动时抛 VersionConflict（409），不覆盖；
        相符时先把旧版本放进回收站（ObjectService.keep_version），误改后可以从回收站还原。"""
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        key = self._path(path)
        scope = self._scope(token)
        kept = self.objects.keep_version(scope, key, if_match) if if_match else None
        try:
            item = await self.objects.put_object(replace(scope, thumbnail_client=True), key, body,
                                                 len(body) if isinstance(body, bytes) else size, content_type, if_match=if_match)
        except BaseException:
            if kept:
                await self.objects.purge_trash(replace(scope, prefix="", private_access=True), [kept])
            raise
        if public is not None:
            item = self.objects.set_public(self._scope(token), key, public)
        return self._object_json(item)

    def instant_probe(self, token: str, path: str, size: object) -> dict[str, bool]:
        """秒传预检：授权范围内有没有大小完全相同的文件。没有就不可能秒传，前端跳过计算完整指纹、直接上传。"""
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            raise ValueError("文件大小不正确")
        scope = self._scope(token)
        self.objects._check_scope(scope, self._path(path), write=True)
        return {"candidates": self.objects.has_size_candidate(scope, size)}

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
                raise ValueError("封面数据不是有效的 base64") from exc
        scope, key = self._scope(token, csrf=csrf, mutation=True), self._path(path)
        if etag is not None or ticket is not None:
            info = self.objects.head_object(scope, key)
            def authorize():
                if scope.authorize is not None:
                    scope.authorize()
                current = self.objects.head_object(replace(scope, authorize=None), key)
                if current.etag != etag or current.blob_uuid != info.blob_uuid:
                    raise ValueError("文件已删除或覆盖，封面结果已丢弃")
                if ticket is not None:
                    self.objects.thumbnail_service.check_claim(current, ticket)
            authorize()
            custom = bool(ticket and self.objects.thumbnail_service.check_claim(info, ticket).custom)
            guarded = replace(scope, authorize=authorize, custom_cover=custom)
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
        return {"files": {item["key"]: {name: item[name] for name in ("etag", "size", "modified_at", "has_thumbnail", "thumbnails", "thumbnail_versions", "thumbnail_status")}
                          for item in self._objects_json(items)}}

    def thumbnail_claim(self, token, csrf, path, etag, force=False, custom=False, ticket=None):
        scope = self._scope(token, csrf=csrf, mutation=True)
        return self.objects.thumbnail_service.claim(scope, self._path(path), etag, force=force, custom=custom, ticket=ticket)

    def thumbnail_release(self, token, csrf, path, etag, ticket, variants=None):
        scope = self._scope(token, csrf=csrf, mutation=True)
        key = self._path(path)
        if variants is not None:
            if (not isinstance(variants, list) or not variants or "thumb" not in variants
                    or any(not isinstance(value, str) or value not in self.objects.STORED_THUMBNAILS for value in variants)):
                raise ValueError("封面规格不正确")
            info = self.objects.head_object(scope, key)
            if info.etag != etag:
                raise ValueError("文件内容已变化，结果已丢弃")
            lease = self.objects.thumbnail_service.check_claim(info, ticket)
            self.objects.finish_thumbnail_set(replace(scope, custom_cover=lease.custom), key, variants)
        self.objects.thumbnail_service.release(scope, key, etag, ticket)

    def thumbnail_generate(self, token, csrf, path, etag, mode="capture"):
        scope = self._scope(token, csrf=csrf, mutation=True)
        return self.objects.thumbnail_service.request(scope, self._path(path), etag, mode)

    def thumbnail_progress(self, token, path, etag):
        return self.objects.thumbnail_service.progress(self._scope(token), self._path(path), etag)

    def thumbnail_cancel(self, token, csrf, path, etag):
        scope = self._scope(token, csrf=csrf, mutation=True)
        return self.objects.thumbnail_service.cancel(scope, self._path(path), etag)

    async def thumbnail_fetch(self, token, csrf, url):
        """自定义缩略图的图片地址：校验网页会话后由服务器读取，图片交回网页处理。"""
        self._scope(token, csrf=csrf, mutation=True)
        return await self.objects.thumbnail_service.fetch_image(url)

    async def thumbnail(self, token: str, path: str, variant: str = "thumb", *, bucket_id: int | None = None,
                        etag: str = "", known: frozenset[str] = frozenset(), version: str = "") -> tuple[bytes, str, str]:
        scope = self._scope(token)
        if bucket_id is not None and bucket_id != scope.bucket_id:
            raise PermissionError("封面所属文件空间不匹配")
        if etag and not path:
            # 网页地址按内容版本标识，不含路径：移动、改名后浏览器缓存继续有效。
            return await self.objects.get_thumbnail_by_etag(scope, etag, variant, accept=self._path, known=known, version=version)
        return await self.objects.get_thumbnail(scope, self._path(path), variant, known=known)

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

    async def content(self, token: str, path: str, start: int = 0, end: int | None = None, *, background: bool = False):
        session = self._session(token)
        account = self.accounts.account_for_session(session)
        # 网页读取：图片、视频的缩略图优先由预览页用已加载的画面生成，后台稍后才接管。
        # background：本机缓存的整文件读取，读取名额让播放和预览优先。
        return await self.objects.get_object(replace(self._scope(token), thumbnail_client=True, background=background), self._path(path), start, end)

    ARCHIVE_LIMIT = 200

    def _archive_roots(self, paths: list[str]) -> list[str]:
        if not isinstance(paths, list) or not 1 <= len(paths) <= self.ARCHIVE_LIMIT or any(not isinstance(p, str) or not p for p in paths):
            raise ValueError(f"一次最多打包 {self.ARCHIVE_LIMIT} 项")
        keys = [self._path(p, directory=p.endswith("/")) for p in dict.fromkeys(paths)]
        # 文件夹与其中的项目同时选择时只打包最外层，避免重复。
        return [k for k in keys if not any(k != other and other.endswith("/") and k.startswith(other) for other in keys)]

    async def archive_totals(self, token: str, paths: list[str]) -> tuple[list[str], int, int]:
        """在线压缩前统计所选内容：(最外层路径, 文件数, 总字节数)。文件夹按键范围在 SQL 里汇总，不逐个列出。"""
        roots = self._archive_roots(paths)
        scope = self._scope(token)

        def count() -> tuple[int, int]:
            files = total = 0
            db = self.objects.metadata.db
            for key in roots:
                if key.endswith("/"):
                    row = db.execute("SELECT COUNT(*), COALESCE(SUM(size),0) FROM objects WHERE bucket_id=? AND key>=? AND key<? AND substr(key,-1)!='/'",
                                     (scope.bucket_id, key, key + self.objects._PREFIX_END)).fetchone()
                else:
                    self.objects.head_object(scope, key)
                    row = db.execute("SELECT COUNT(*), COALESCE(SUM(size),0) FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key)).fetchone()
                files += int(row[0])
                total += int(row[1])
            return files, total
        files, total = await self.objects.metadata.run_in_thread(count)
        return roots, files, total

    async def archive(self, token: str, paths: list[str]) -> tuple[str, AsyncIterator[tuple[str, int, float, AsyncIterator[bytes]]]]:
        """打包下载所选文件与文件夹（递归）。返回压缩包名与条目迭代器；条目逐个按需读取，不在内存中拼接。

        每个条目都经 content 读取，因此私密空间沿用逐块校验授权；文件夹按键集分页列出。"""
        roots = self._archive_roots(paths)
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

    @staticmethod
    def move_pairs(items, path) -> list[tuple[str, str]]:
        """批量移动的条目：[{from, to}]，按 path 规范化；条目数由 ObjectService.move_many 限制。"""
        if not isinstance(items, list) or not all(
                isinstance(item, dict) and isinstance(item.get("from"), str) and isinstance(item.get("to"), str) for item in items):
            raise ValueError("items 必须为 {from, to} 数组")
        return [(path(item["from"], directory=item["from"].endswith("/")), path(item["to"], directory=item["to"].endswith("/")))
                for item in items]

    @staticmethod
    def move_results(moves: list[tuple[str, str]], results) -> dict[str, object]:
        items: list[dict[str, object]] = []
        for (old, _), result in zip(moves, results):
            if isinstance(result, Exception):
                items.append({"from": old, "error": str(result) or "移动失败"})
            else:
                items.append({"from": old, "moved": result.moved, "skipped": result.skipped})
        return {"moved": sum(item.get("moved", 0) for item in items), "skipped": sum(item.get("skipped", 0) for item in items),
                "results": items}

    async def move_many(self, token: str, csrf: str, items, conflict: str = "skip") -> dict[str, object]:
        """一次请求移动多项（同一事务、只提交一次）；每项单独报告结果，失败项不影响其余。"""
        self._session(token, csrf=csrf, mutation=True)
        scope = self._scope(token)
        moves = self.move_pairs(items, self._path)
        results = await self.objects.metadata.run_in_thread(self.objects.move_many, scope, moves, conflict)
        return self.move_results(moves, results)

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
        versions = self.objects.file_thumbnail_versions(items)
        sizes = self.objects.media_sizes([item.blob_uuid for item in items]) if hasattr(self.objects, "media_sizes") else {}
        tags = self.objects.file_media_fields(items)
        result = []
        for item in items:
            value = self._object_json(item, tuple(versions.get((item.bucket_id, item.key), {})), versions.get((item.bucket_id, item.key), {}))
            if size := sizes.get(item.blob_uuid or ""):
                value["dimensions"] = {"width": size[0], "height": size[1]}
            if found := tags.get((item.bucket_id, item.key)):
                value["media"] = found
            result.append(value)
        return result

    @staticmethod
    def _object_json(item, thumbnails: list[str] | tuple[str, ...] = (), thumbnail_versions: dict[str, str] | None = None,
                     *, legacy_thumbnails: bool = False) -> dict[str, object]:
        meta = {key: value for key, value in item.user_meta.items() if key != ObjectService.THUMBNAIL_META}
        # /api/v1 保留既有程序接口契约；网页接口把内部失败标记与实际图片分开。
        state = ({"has_thumbnail": "thumb" in thumbnails, "thumbnails": list(thumbnails), "thumbnail_versions": thumbnail_versions or {}}
                 if legacy_thumbnails else ObjectService.thumbnail_fields(thumbnails, thumbnail_versions))
        return {"key": item.key, "size": item.size, "etag": item.etag, "content_type": item.content_type,
                "user_meta": meta, "modified_at": item.modified_at, **state,
                "public_token": item.public_token, "public_at": item.public_at, "public_expires_at": item.public_expires_at,
                "public_has_password": item.public_has_password, "public_downloads": item.public_downloads,
                **({"starred_at": item.starred_at} if item.starred_at else {})}
