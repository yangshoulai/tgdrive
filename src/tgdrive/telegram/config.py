"""Telegram Bot 与私有频道的加密配置存储。"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from ..blobstore import BlobStore
from ..crypto import derive_subkey, open_sealed, seal
from ..errors import NotFoundError, NotReadyError
from ..keystore import KeyStore
from ..metadata import Metadata
from .client import TelegramAuthError, TelegramClient, TelegramError, TelegramNotFoundError
from .pool import BotPool, BotState, PoolBot
from .store import TelegramBlobStore


class TelegramBotConfigStore:
    """保存 Bot token 的密文，列表接口永远不返回 token。"""

    def __init__(self, metadata: Metadata, keystore: KeyStore) -> None:
        self.metadata, self.keystore = metadata, keystore

    def _key(self) -> bytes:
        return derive_subkey(self.keystore.require_kek(), "telegram-bot-token")

    @staticmethod
    def _validate(name: str, token: str, channel_id: str) -> None:
        if not re.fullmatch(r"[^\s]{1,80}", name):
            raise ValueError("Bot 名称不合法")
        if not re.fullmatch(r"\d{6,20}:[A-Za-z0-9_-]{20,}", token):
            raise ValueError("Bot token 格式不合法")
        if not re.fullmatch(r"-100\d{5,20}|@[A-Za-z0-9_]{5,32}", channel_id):
            raise ValueError("私有频道 ID 应为 -100 开头的数字或 @频道用户名")

    def create(self, name: str, token: str, channel_id: str) -> dict[str, object]:
        self._validate(name, token, channel_id)
        now = time.time()
        with self.metadata.transaction() as db:
            cursor = db.execute(
                "INSERT INTO telegram_bots(name,token_enc,channel_id,status,created_at) VALUES(?,?,?,'active',?)",
                (name, b"", channel_id, now),
            )
            bot_id = int(cursor.lastrowid)
            encrypted = seal(self._key(), token.encode(), f"telegram-bot:{bot_id}")
            db.execute("UPDATE telegram_bots SET token_enc=? WHERE id=?", (encrypted, bot_id))
        return {"id": bot_id, "name": name, "channel_id": channel_id, "status": "active", "created_at": now}

    def list(self) -> list[dict[str, object]]:
        rows = self.metadata.db.execute(
            "SELECT id,name,channel_id,status,created_at,last_check_at,last_check_status "
            "FROM telegram_bots ORDER BY id"
        ).fetchall()
        return [dict(row) for row in rows]

    def storage_usage(self) -> dict[str, dict[str, int]]:
        """按通道对应的 Bot 汇总已记录的加密分片，复用短期缓存，不访问 Telegram。"""
        def read():
            rows = self.metadata.db.execute(
                "WITH refs AS (SELECT cipher_size, "
                "CASE WHEN json_valid(blob_ref) THEN CAST(json_extract(blob_ref,'$.bot') AS TEXT) END AS bot_id, "
                "CASE WHEN json_valid(blob_ref) THEN json_extract(blob_ref,'$.v') END AS version FROM chunks) "
                "SELECT bot_id,COUNT(*) AS chunk_count,COALESCE(SUM(cipher_size),0) AS stored_bytes "
                "FROM refs WHERE version=1 AND bot_id IS NOT NULL GROUP BY bot_id")
            return {row["bot_id"]: {"chunk_count": int(row["chunk_count"]), "stored_bytes": int(row["stored_bytes"])}
                    for row in rows}
        return self.metadata.cached_read(("telegram-storage-usage",), read)

    def record_check(self, bot_id: int, status: str) -> None:
        with self.metadata.transaction() as db:
            db.execute("UPDATE telegram_bots SET last_check_at=?, last_check_status=? WHERE id=?", (time.time(), status, bot_id))

    async def check(self, bot_id: int, client: TelegramClient | None = None) -> dict[str, object]:
        """依次检查 token、频道访问权限与发消息权限，并把结果写入 last_check_*。"""
        row = self.metadata.db.execute("SELECT channel_id FROM telegram_bots WHERE id=?", (bot_id,)).fetchone()
        if row is None:
            raise NotFoundError("Bot 不存在")
        client = client or TelegramClient(self.token(bot_id))
        try:
            me = await client.get_me()
            await client.get_chat(row["channel_id"])
            member = await client.get_chat_member(row["channel_id"], int(me["id"]))
            if member.get("status") not in ("administrator", "creator"):
                status = "Bot 不是该频道的管理员"
            elif member.get("status") == "administrator" and member.get("can_post_messages") is False:
                status = "Bot 没有在频道中发布消息的权限"
            else:
                status = "ok"
        except TelegramAuthError:
            status = "token 无效，或 Bot 已被移出频道"
        except TelegramNotFoundError:
            status = "找不到该频道，请确认频道 ID 且 Bot 已加入频道"
        except TelegramError as exc:
            status = f"Telegram 返回错误：{exc}"
        except OSError as exc:
            status = f"无法连接 Telegram：{exc}"
        self.record_check(bot_id, status)
        return {"id": bot_id, "ok": status == "ok", "status": status}

    def token(self, bot_id: int) -> str:
        row = self.metadata.db.execute("SELECT token_enc FROM telegram_bots WHERE id=?", (bot_id,)).fetchone()
        if row is None:
            raise NotFoundError("Bot 不存在")
        return open_sealed(self._key(), row["token_enc"], f"telegram-bot:{bot_id}").decode()

    def set_status(self, bot_id: int, status: str) -> None:
        if status not in ("active", "disabled"):
            raise ValueError("Bot 状态不合法")
        with self.metadata.transaction() as db:
            cursor = db.execute("UPDATE telegram_bots SET status=? WHERE id=?", (status, bot_id))
            if cursor.rowcount != 1:
                raise NotFoundError("Bot 不存在")


class ConfiguredBlobStore(BlobStore):
    """根据配置把新写入切换到 Telegram，同时兼容已有本地 Blob。"""

    def __init__(self, metadata: Metadata, keystore: KeyStore, local: BlobStore,
                 config: TelegramBotConfigStore) -> None:
        self.metadata, self.keystore, self.local, self.config = metadata, keystore, local, config
        self._telegram: TelegramBlobStore | None = None
        self._signature: tuple[tuple[int, str, str], ...] | None = None

    def _build(self) -> TelegramBlobStore | None:
        """读写共用一个缓存的 Bot 池：停用的 Bot 仍用于读取和删除，但不参与上传。

        只有 Bot 配置（ID、状态、频道）变化时才重新解密 token 并重建客户端，
        因此 file_path 缓存与失败退避状态能跨请求保留。
        """
        if not self.keystore.unlocked:
            # 系统锁定后不再在内存中保留 Bot token。
            self._telegram, self._signature = None, None
            return None
        bots = self.config.list()
        if not bots:
            return None
        signature = tuple((int(row["id"]), str(row["status"]), str(row["channel_id"])) for row in bots)
        if self._telegram is not None and self._signature == signature:
            return self._telegram
        pool_bots: list[PoolBot] = []
        for row in bots:
            token = self.config.token(int(row["id"]))
            state = BotState.ENABLED if row["status"] == "active" else BotState.DISABLED
            pool_bots.append(PoolBot(str(row["id"]), TelegramClient(token), row["channel_id"], state))
        self._telegram, self._signature = TelegramBlobStore(BotPool(pool_bots)), signature
        return self._telegram

    @staticmethod
    def _telegram_bot_id(ref: str) -> str | None:
        try:
            value: Any = json.loads(ref)
            return str(value["bot"]) if value.get("v") == 1 and "bot" in value else None
        except (TypeError, ValueError, json.JSONDecodeError):
            return None

    # Telegram 每次下载请求都有固定开销：按 8 MiB 读取，一个 16 MiB 分片只需 2 次请求。
    TELEGRAM_READ_WINDOW = 8 * 1024 * 1024

    def read_window(self, ref: str) -> int:
        return self.TELEGRAM_READ_WINDOW if self._telegram_bot_id(ref) is not None else 1024 * 1024

    def bot_runtime(self) -> dict[str, dict[str, object]]:
        """返回当前进程中各 Bot 的退避状态，不包含 token 或频道内容。"""
        store = self._build()
        return {} if store is None else store.pool.snapshot()

    async def put(self, key: str, data: bytes) -> str:
        store = self._build()
        if store is None or not store.pool.enabled_ids():
            return await self.local.put(key, data)
        return await store.put(key, data)

    async def get(self, ref: str, start: int | None = None, end: int | None = None) -> bytes:
        bot_id = self._telegram_bot_id(ref)
        if bot_id is not None:
            store = self._build()
            if store is None:
                raise NotReadyError("读取 Telegram Blob 需要解锁并保留对应 Bot 配置")
            return await store.get(ref, start, end)
        return await self.local.get(ref, start, end)

    async def delete(self, ref: str) -> None:
        bot_id = self._telegram_bot_id(ref)
        if bot_id is not None:
            store = self._build()
            if store is None:
                raise NotReadyError("删除 Telegram Blob 需要解锁并保留对应 Bot 配置")
            await store.delete(ref)
            return
        await self.local.delete(ref)
