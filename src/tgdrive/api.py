"""管理端和用户端 API 的框架无关服务层。

方法返回可直接序列化为 JSON 的字典；文件下载保留异步流，避免把大对象
一次性读入内存。HTTP 路由层只负责 Cookie、JSON 和状态码转换。
"""

from __future__ import annotations

import unicodedata
from collections.abc import AsyncIterator

from .accounts import AccountService
from .authn import AuthenticationError, Session, hash_password
from .errors import NotFoundError, NotReadyError
from .maintenance import MaintenanceService
from .metrics import TrafficMetrics
from .objects import ObjectService, Scope
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

    async def asetup(self, passphrase: str, username: str, password: str):
        account = await self.accounts.asetup(passphrase, username, password)
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

    async def acreate_user(self, token: str, csrf: str, username: str, password: str, quota_bytes: int | None = None):
        def authorize():
            self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        authorize()
        account = await self.accounts.acreate_user(username, password, quota_bytes=quota_bytes, authorize=authorize)
        return {"id": account.id, "username": account.username, "bucket_id": account.bucket_id, "quota_bytes": quota_bytes}

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
        return await self.accounts.metadata.run_in_thread(self.clients.list_clients, **options)

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
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        client_id, access_key, secret = self.clients.create_client_with_key(
            name, grants=[(int(grant["bucket_id"]), str(grant.get("prefix", "")), str(grant.get("perms", "ro"))) for grant in grants])
        return {"id": client_id, "access_key_id": access_key, "secret": secret}

    def list_clients(self, token: str, *, limit: int | None = None, cursor: int = 0):
        self.accounts.sessions.require(token, role="admin")
        return self.clients.list_clients(limit=limit, cursor=cursor)

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
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        self.clients.grant(client_id, bucket_id, prefix, perms)

    def list_bots(self, token: str) -> list[dict[str, object]]:
        self.accounts.sessions.require(token, role="admin")
        if self.telegram_bots is None:
            return []
        items = self.telegram_bots.list()
        runtime = self.storage.bot_runtime() if self.storage is not None else {}
        return [{**item, "runtime": runtime.get(str(item["id"]))} for item in items]

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

    async def list_objects(self, token: str, *, limit: int = 100, cursor: str | None = None, query: str = "",
                           public_only: bool = False) -> dict[str, object]:
        return await self.accounts.metadata.run_in_thread(
            self._list_objects_sync, token, limit=limit, cursor=cursor, query=query, public_only=public_only)

    def _list_objects_sync(self, token: str, *, limit: int = 100, cursor: str | None = None, query: str = "",
                            public_only: bool = False) -> dict[str, object]:
        """全部文件：按修改时间倒序的键集分页，筛选在 SQL 中完成。不包含文件夹标记。"""
        self.accounts.sessions.require(token, role="admin")
        limit = max(1, min(limit, 200))
        where = ["substr(o.key,-1)!='/'", "substr(o.key,1,9)!='.tgdrive/'"]
        args: list[object] = []
        query = unicodedata.normalize("NFC", query.strip())
        if query:
            where.append("instr(lower(o.key || ' ' || ifnull(u.username,'') || ' ' || b.name), lower(?))>0")
            args.append(query)
        if public_only:
            where.append("o.public_token IS NOT NULL")
        base = ("FROM objects o JOIN buckets b ON b.id=o.bucket_id LEFT JOIN users u ON u.bucket_id=o.bucket_id "
                "WHERE " + " AND ".join(where))
        page_where, page_args = "", []
        if cursor:
            try:
                modified, bucket_id, key = cursor.split("|", 2)
                page_where, page_args = " AND (o.modified_at,o.bucket_id,o.key) < (?,?,?)", [float(modified), int(bucket_id), key]
            except ValueError as exc:
                raise ValueError("cursor 不合法") from exc
        rows = self.objects.metadata.db.execute(
            "SELECT o.bucket_id,o.key,o.size,o.etag,o.content_type,o.modified_at,o.public_token,o.public_at,"
            "o.public_expires_at,o.public_downloads,o.public_password IS NOT NULL AS public_has_password,"
            "b.name AS bucket_name,u.username " + base + page_where +
            " ORDER BY o.modified_at DESC, o.bucket_id DESC, o.key DESC LIMIT ?", (*args, *page_args, limit + 1)).fetchall()
        items = [dict(row) for row in rows[:limit]]
        last = items[-1] if items else None
        totals = self.objects.metadata.cached_read(("admin-objects-total", query, public_only),
            lambda: tuple(self.objects.metadata.db.execute("SELECT COUNT(*), COUNT(o.public_token) " + base, args).fetchone()))
        return {"objects": items, "total": totals[0], "public_total": totals[1],
                "next_cursor": f"{last['modified_at']!r}|{last['bucket_id']}|{last['key']}" if len(rows) > limit and last else None}

    async def content(self, token: str, bucket_id: int, path: str, start: int = 0, end: int | None = None):
        self.accounts.sessions.require(token, role="admin")
        return await self.objects.get_object(Scope(bucket_id), normalize_user_path(path), start, end)

    def set_object_public(self, token: str, csrf: str, bucket_id: int, path: str, public: bool) -> dict[str, object]:
        """管理员可以撤销任意对象的公开链接，用于处置不当分享。"""
        self.accounts.sessions.require(token, role="admin", csrf=csrf, mutation=True)
        return UserApi._object_json(self.objects.set_public(Scope(bucket_id), normalize_user_path(path), public))

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

    async def achange_password(self, token: str, csrf: str, old_password: str, new_password: str) -> None:
        session = self.accounts.sessions.require(token, csrf=csrf, mutation=True)
        if len(new_password) < 8:
            raise ValueError("新密码至少需要 8 个字符")
        try:
            await self.accounts.achange_password(session, old_password, new_password)
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

    def me(self, token: str) -> dict[str, object]:
        # 不检查锁定状态：管理员在锁定时也要能恢复会话并看到解锁入口。
        session = self.accounts.sessions.require(token)
        account = self.accounts.account_for_session(session)
        bucket = self.objects._bucket(account.bucket_id) if account.bucket_id is not None else None
        return {"id": account.id, "username": account.username, "role": account.role,
                "bucket_id": account.bucket_id, "quota_bytes": bucket["quota_bytes"] if bucket else None,
                "used_bytes": bucket["used_bytes"] if bucket else 0,
                "unlocked": self.accounts.keystore.unlocked, "remember": session.remember,
                "csrf_token": session.csrf_token, "expires_at": session.expires_at}

    async def list(self, token: str, *, prefix: str = "", cursor: str | None = None, limit: int = 1000, public_only: bool = False):
        session = self._session(token)
        account = self.accounts.account_for_session(session)
        path_prefix = normalize_user_path(prefix) if prefix else ""
        if public_only:
            return await self.objects.metadata.run_in_thread(self._public_directory_page, account.bucket_id, path_prefix, cursor, limit)
        page = await self.objects.alist_objects(Scope(account.bucket_id, ""), path_prefix, "/", cursor, min(limit, 1000))
        return {"objects": [self._object_json(item) for item in page.objects],
                "common_prefixes": page.common_prefixes, "next_cursor": page.next_cursor,
                "public_folders": self._public_folders(account.bucket_id, page.common_prefixes)}

    def _public_directory_page(self, bucket_id: int, prefix: str, cursor: str | None, limit: int):
        limit = max(1, min(limit, 200))
        rows = self.objects.metadata.db.execute(
            "SELECT * FROM objects WHERE bucket_id=? AND key>? AND key<? AND key>? "
            "AND public_token IS NOT NULL AND substr(key,1,9)!='.tgdrive/' "
            "AND instr(rtrim(substr(key,?),'/'),'/')=0 ORDER BY key LIMIT ?",
            (bucket_id, prefix, prefix + self.objects._PREFIX_END, cursor or "", len(prefix) + 1, limit + 1)).fetchall()
        items = [self._object_json(self.objects._object(row)) for row in rows[:limit]]
        folders = {item["key"]: item for item in items if item["key"].endswith("/")}
        return {"objects": [item for item in items if not item["key"].endswith("/")],
                "common_prefixes": list(folders), "public_folders": folders,
                "next_cursor": rows[limit - 1]["key"] if len(rows) > limit else None}

    async def folders(self, token: str, *, prefix: str = "", cursor: str = "", limit: int = 50):
        account = self.accounts.account_for_session(self._session(token))
        prefix = normalize_user_path(prefix, directory=True) if prefix else ""
        limit = max(1, min(limit, 200))
        def read():
            # 包含隐式目录；找到目录后跳过整棵子树，不扫描其中每个文件来去重。
            folders = []
            position = cursor + self.objects._PREFIX_END if cursor else prefix
            while len(folders) <= limit:
                row = self.objects.metadata.db.execute(
                    "SELECT key FROM objects WHERE bucket_id=? AND key>? AND key<? "
                    "AND substr(key,1,9)!='.tgdrive/' AND instr(substr(key,?),'/')>0 ORDER BY key LIMIT 1",
                    (account.bucket_id, position, prefix + self.objects._PREFIX_END, len(prefix) + 1)).fetchone()
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
        keys = [normalize_user_path(path) for path in paths]
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

    async def search(self, token: str, query: str, cursor: str = "", limit: int = 100, public_only: bool = False):
        session = self._session(token)
        account = self.accounts.account_for_session(session)
        self.objects._bucket(account.bucket_id)
        limit = max(1, min(limit, 200))
        query = unicodedata.normalize("NFC", query.strip())
        if len(query) > 256:
            raise ValueError("搜索词不能超过 256 个字符")
        def read_page():
            return self.objects.metadata.db.execute(
                "SELECT * FROM objects "
                "WHERE bucket_id=? AND key>? AND instr(lower(key),lower(?))>0 "
                "AND substr(key,-1)!='/' AND substr(key,1,9)!='.tgdrive/' AND (?=0 OR public_token IS NOT NULL) ORDER BY key LIMIT ?",
                (account.bucket_id, cursor, query, int(public_only), limit + 1),
            ).fetchall()
        rows = await self.objects.metadata.run_in_thread(read_page)
        return {"objects": [self._object_json(self.objects._object(row)) for row in rows[:limit]], "common_prefixes": [],
                "next_cursor": rows[limit - 1]["key"] if len(rows) > limit else None}

    async def folder(self, token: str, csrf: str, path: str) -> dict[str, object]:
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        item = await self.objects.put_directory_marker(Scope(account.bucket_id), normalize_user_path(path, directory=True))
        return self._object_json(item)

    async def put(self, token: str, csrf: str, path: str, body: bytes | AsyncIterator[bytes],
                  content_type: str | None = None, size: int | None = None,
                  public: bool | None = None) -> dict[str, object]:
        """上传对象；public 为 None 时保持原有公开状态，True/False 显式开启或关闭链接。"""
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        key = normalize_user_path(path)
        item = await self.objects.put_object(Scope(account.bucket_id), key, body,
                                             len(body) if isinstance(body, bytes) else size, content_type)
        if public is not None:
            item = self.objects.set_public(Scope(account.bucket_id), key, public)
        return self._object_json(item)

    def instant_put(self, token: str, csrf: str, path: str, size: int, fingerprint: str,
                    content_type: str | None = None, public: bool | None = None) -> dict[str, object]:
        """秒传：存储桶内已有内容相同的文件时直接引用它；未命中返回 {"hit": False}，由前端走普通上传。"""
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        scope = Scope(account.bucket_id)
        key = normalize_user_path(path)
        item = self.objects.instant_put(scope, key, int(size), fingerprint, content_type)
        if item is None:
            return {"hit": False}
        if public is not None:
            item = self.objects.set_public(scope, key, public)
        return {"hit": True, **self._object_json(item)}

    def set_public(self, token: str, csrf: str, paths: list[str], public: bool,
                   options: dict[str, object] | None = None, *, password_hash=ObjectService._UNSET) -> list[dict[str, object]]:
        """开启/关闭公开分享；options 可包含 expires_at（时间戳或 None）与 password（字符串，空为取消）。"""
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        return [self._object_json(apply_share(self.objects, Scope(account.bucket_id), normalize_user_path(path), public, options, password_hash=password_hash))
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
        if limit is not None:
            limit = max(1, min(limit, 200))
            where, args = "bucket_id=?", [scope.bucket_id]
            totals = self.objects.metadata.cached_read(("trash-total", scope.bucket_id),
                lambda: tuple(self.objects.metadata.db.execute(
                    "SELECT COUNT(*),COALESCE(SUM(size),0) FROM trash WHERE bucket_id=?", (scope.bucket_id,)).fetchone()))
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
        items = self.objects.list_trash(scope.bucket_id)
        return {"items": items, "total_size": sum(int(item["size"]) for item in items), "retention_days": self.objects.TRASH_DAYS}

    async def trash(self, token: str, csrf: str, paths: list[str]) -> list[dict[str, object]]:
        scope = self._scope(token, csrf=csrf, mutation=True)
        return await self.objects.trash(scope, [normalize_user_path(path, directory=path.endswith("/")) for path in paths])

    def restore_trash(self, token: str, csrf: str, ids: list[str]) -> list[dict[str, object]]:
        return self.objects.restore(self._scope(token, csrf=csrf, mutation=True), [str(item) for item in ids])

    async def purge_trash(self, token: str, csrf: str, ids: list[str] | None) -> int:
        return await self.objects.purge_trash(self._scope(token, csrf=csrf, mutation=True),
                                              None if ids is None else [str(item) for item in ids])

    # ---------- 缩略图 ----------

    def set_thumbnail(self, token: str, csrf: str, path: str, data: str) -> None:
        import base64
        import binascii
        try:
            raw = base64.b64decode(data.split(",", 1)[-1], validate=True)
        except binascii.Error as exc:
            raise ValueError("缩略图数据不是有效的 base64") from exc
        self.objects.set_thumbnail(self._scope(token, csrf=csrf, mutation=True), normalize_user_path(path), raw)

    def thumbnail(self, token: str, path: str) -> tuple[bytes, str]:
        return self.objects.get_thumbnail(self._scope(token), normalize_user_path(path))

    # ---------- 可续传的分段上传 ----------

    async def create_upload(self, token: str, csrf: str, path: str, content_type: str | None) -> dict[str, object]:
        scope = self._scope(token, csrf=csrf, mutation=True)
        upload_id = await self.objects.create_multipart(scope, normalize_user_path(path), content_type)
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
        scope = self._scope(token, csrf=csrf, mutation=True)
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
            return [self._object_json(item) for item in self.objects.list_public(scope.bucket_id)]
        limit = max(1, min(limit, 200))
        condition = "bucket_id=? AND public_token IS NOT NULL AND substr(key,1,9)!='.tgdrive/'"
        total = self.objects.metadata.cached_read(("public-total", scope.bucket_id),
            lambda: self.objects.metadata.db.execute(f"SELECT COUNT(*) FROM objects WHERE {condition}", (scope.bucket_id,)).fetchone()[0])
        rows = self.objects.metadata.db.execute(
            f"SELECT * FROM objects WHERE {condition} AND key>? ORDER BY key LIMIT ?", (scope.bucket_id, cursor, limit + 1)).fetchall()
        return {"objects": [self._object_json(self.objects._object(row)) for row in rows[:limit]], "total": total,
                "next_cursor": rows[limit - 1]["key"] if len(rows) > limit else None}

    def change_password(self, token: str, csrf: str, old_password: str, new_password: str) -> None:
        session = self.accounts.sessions.require(token, csrf=csrf, mutation=True)
        if len(new_password) < 8:
            raise ValueError("新密码至少需要 8 个字符")
        try:
            self.accounts.change_password(session, old_password, new_password)
        except AuthenticationError as exc:
            # 旧密码错误不是会话失效，不能返回 401 触发前端退出登录。
            raise ValueError("当前密码不正确") from exc

    async def content(self, token: str, path: str, start: int = 0, end: int | None = None):
        session = self._session(token)
        account = self.accounts.account_for_session(session)
        return await self.objects.get_object(Scope(account.bucket_id), normalize_user_path(path), start, end)

    async def delete(self, token: str, csrf: str, paths: list[str], recursive: bool = False) -> list[dict[str, object]]:
        """删除文件；recursive 为 True 时，以 / 结尾的路径会删除整个文件夹（在服务端分批完成）。"""
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        scope = Scope(account.bucket_id)
        normalized = [normalize_user_path(path) for path in paths]
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
        old = normalize_user_path(source, directory=source.endswith("/"))
        new = normalize_user_path(target, directory=target.endswith("/"))
        result = self.objects.move(Scope(account.bucket_id), old, new, conflict)
        return {"moved": result.moved, "skipped": result.skipped}

    async def copy(self, token: str, csrf: str, source: str, target: str) -> dict[str, object]:
        session = self._session(token, csrf=csrf, mutation=True)
        account = self.accounts.account_for_session(session)
        item = await self.objects.copy_object(Scope(account.bucket_id), normalize_user_path(source),
                                              Scope(account.bucket_id), normalize_user_path(target))
        return self._object_json(item)

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

    @staticmethod
    def _object_json(item) -> dict[str, object]:
        meta = {key: value for key, value in item.user_meta.items() if key != ObjectService.THUMBNAIL_META}
        return {"key": item.key, "size": item.size, "etag": item.etag, "content_type": item.content_type,
                "user_meta": meta, "modified_at": item.modified_at, "has_thumbnail": ObjectService.THUMBNAIL_META in item.user_meta,
                "public_token": item.public_token, "public_at": item.public_at, "public_expires_at": item.public_expires_at,
                "public_has_password": item.public_has_password, "public_downloads": item.public_downloads}
