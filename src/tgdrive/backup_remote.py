"""把已加密的元数据备份（.tgdbak）发到 Telegram 频道，作为本机磁盘之外的副本。

meta.db 里存着全部包裹密钥与分片引用：数据目录所在磁盘损坏时，频道里的分片就无法解密。备份本身已用口令派生的
密钥加密，发到频道不泄露内容。Bot API 单个文件最多 50 MB，所以按 PART_SIZE 分卷，文件名形如
``tgdrive-20261110-030000-….tgdbak.001``：本机数据库整个丢失时，也能在 Telegram 客户端里下载全部分卷，
按序号拼接（``cat *.tgdbak.0* > x.tgdbak``）后用 ``tgdrive restore`` 恢复。

备份使用**独立的 Bot 与频道**，与存储通道完全分开：管理员在「备份设置」填写备份 Bot 的 token（用 KEK 派生的子密钥
加密保存，接口只返回 Bot 用户名）和备份频道 ID。保存时调用 Telegram 预检 token 有效、Bot 已在频道中并能发布消息；
存储通道的 Bot 不能用作备份 Bot。频道里只保留最近 keep 份，更早的分卷消息由备份 Bot 删除（删除失败只记录）。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import time
from pathlib import Path

from .crypto import derive_subkey, open_sealed, seal
from .telegram.client import TelegramAuthError, TelegramClient, TelegramError

log = logging.getLogger(__name__)

PART_SIZE = 45 * 1024 * 1024
SETTINGS_KEY = "backup.remote"
ITEMS_KEY = "backup.remote.items"
TOKEN_PATTERN = re.compile(r"\d{5,20}:[A-Za-z0-9_-]{30,64}")
CHANNEL_PATTERN = re.compile(r"-100\d{5,16}|@[A-Za-z][A-Za-z0-9_]{4,31}")


def _get(metadata, key, default):
    row = metadata.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except ValueError:
        return default


def _put(metadata, key, value) -> None:
    with metadata.transaction() as db:
        db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (key, json.dumps(value, ensure_ascii=False, separators=(",", ":"))))


class RemoteBackup:
    def __init__(self, metadata, keystore, *, storage_bot_ids=None, client_factory=TelegramClient,
                 part_size: int = PART_SIZE) -> None:
        # storage_bot_ids：返回存储通道 Bot 的 Telegram 编号（token 冒号前的数字），备份 Bot 不能与它们相同。
        self.metadata, self.keystore = metadata, keystore
        self.storage_bot_ids, self.client_factory, self.part_size = storage_bot_ids, client_factory, part_size
        self._lock = asyncio.Lock()

    # ---------- 设置 ----------

    def _key(self) -> bytes:
        return derive_subkey(self.keystore.require_kek(), "backup-remote")

    def _stored(self) -> dict:
        value = _get(self.metadata, SETTINGS_KEY, {}) or {}
        return value if isinstance(value, dict) else {}

    def _seal(self, token: str) -> str:
        return base64.b64encode(seal(self._key(), token.encode(), "backup-remote-token")).decode()

    def _token(self) -> str | None:
        sealed = self._stored().get("token")
        if not sealed:
            return None
        return open_sealed(self._key(), base64.b64decode(sealed), "backup-remote-token").decode()

    def settings(self) -> dict[str, object]:
        saved = self._stored()
        keep = saved.get("keep")
        return {"enabled": bool(saved.get("enabled", False)), "channel": str(saved.get("channel") or ""),
                "keep": keep if type(keep) is int and 1 <= keep <= 100 else 7,
                "bot": saved.get("bot_username") or None, "has_token": bool(saved.get("token"))}

    async def configure(self, payload: dict) -> dict[str, object]:
        """保存设置。启用时必须有备份 Bot 与频道，并通过 Telegram 预检；token 留空表示沿用已保存的。"""
        if not isinstance(payload, dict):
            raise ValueError("备份设置格式不正确")
        enabled, channel, keep, token = payload.get("enabled"), payload.get("channel"), payload.get("keep"), payload.get("token")
        if not isinstance(enabled, bool):
            raise ValueError("请选择是否把备份发送到 Telegram")
        channel = "" if channel is None else str(channel).strip()
        if type(keep) is not int or not 1 <= keep <= 100:
            raise ValueError("频道中保留的备份数量必须是 1–100 的整数")
        if token is not None and not isinstance(token, str):
            raise ValueError("Bot token 格式不正确")
        token = (token or "").strip()
        if channel and not CHANNEL_PATTERN.fullmatch(channel):
            if channel.lstrip("-").isdigit():
                raise ValueError("私有频道 ID 应以 -100 开头，例如 -1001234567890；可以把频道里的一条消息转发给 @userinfobot 查看")
            raise ValueError("备份频道请填写以 -100 开头的频道 ID，或公开频道的 @用户名")
        if token and not TOKEN_PATTERN.fullmatch(token):
            raise ValueError("Bot token 格式不正确，应形如 123456789:AA…（在 @BotFather 创建 Bot 后获得）")
        stored = self._stored()
        value = {"enabled": enabled, "channel": channel, "keep": keep,
                 **{name: stored[name] for name in ("token", "bot_username", "bot_id") if name in stored}}
        if token:
            value.pop("bot_username", None)
        if enabled:
            if not channel:
                raise ValueError("请填写备份频道")
            current = token or self._token()
            if not current:
                raise ValueError("请填写备份 Bot 的 token")
            bot_id = current.split(":", 1)[0]
            storage = {str(item) for item in (self.storage_bot_ids() if callable(self.storage_bot_ids) else [])}
            if bot_id in storage:
                raise ValueError("这个 Bot 已用作存储通道。备份请使用单独的 Bot，在 @BotFather 新建一个即可")
            value.update(bot_username=await self._check(current, channel), bot_id=bot_id)
        if token:
            value["token"] = self._seal(token)
        _put(self.metadata, SETTINGS_KEY, value)
        return self.status()

    async def _check(self, token: str, channel: str) -> str:
        """预检：token 有效、Bot 是频道管理员并能发布消息。返回 Bot 用户名。"""
        client = self.client_factory(token)
        try:
            me = await client.get_me()
        except TelegramAuthError:
            raise ValueError("Bot token 无效或已被撤销，请在 @BotFather 确认后重新填写") from None
        except (TelegramError, OSError) as exc:
            raise ValueError(f"连接 Telegram 失败：{str(exc)[:120]}") from None
        username = str(me.get("username") or me.get("id"))
        try:
            member = await client.get_chat_member(channel, int(me["id"]))
        except TelegramError as exc:
            if "chat not found" in str(exc).casefold():
                raise ValueError(f"@{username} 找不到频道 {channel}：请确认频道 ID 正确，并已把 @{username} 加为该频道的管理员") from None
            raise ValueError(f"无法读取频道 {channel}：{str(exc)[:120]}") from None
        except OSError as exc:
            raise ValueError(f"连接 Telegram 失败：{type(exc).__name__}") from None
        if member.get("status") not in ("administrator", "creator"):
            raise ValueError(f"@{username} 还不是频道 {channel} 的管理员，请在频道的管理员设置中添加它")
        if member.get("status") == "administrator" and member.get("can_post_messages") is False:
            raise ValueError(f"@{username} 没有在频道 {channel} 发布消息的权限，请在管理员权限中打开「发布消息」")
        return username

    def items(self) -> list[dict[str, object]]:
        items = _get(self.metadata, ITEMS_KEY, []) or []
        return [item for item in items if isinstance(item, dict)]

    def status(self) -> dict[str, object]:
        return {**self.settings(), "uploaded": [{"name": item["name"], "size": item["size"], "uploaded_at": item["uploaded_at"],
                                                 "parts": len(item["parts"]), "channel": item["channel"]} for item in self.items()]}

    # ---------- 发送 ----------

    def _client(self) -> TelegramClient:
        token = self._token()
        if not token:
            raise RuntimeError("还没有配置备份 Bot")
        return self.client_factory(token)

    async def upload(self, path: str | Path) -> dict[str, object] | None:
        """发送一份备份；未启用时返回 None。失败时抛出，由维护任务记录。"""
        config = self.settings()
        if not config["enabled"]:
            return None
        if not config["channel"]:
            raise RuntimeError("还没有配置备份频道")
        path = Path(path)
        async with self._lock:
            client, channel = self._client(), config["channel"]
            sent: list[dict[str, object]] = []
            size = path.stat().st_size
            total = max(1, -(-size // self.part_size))
            try:
                with path.open("rb") as handle:
                    for index in range(total):
                        data = await asyncio.to_thread(handle.read, self.part_size)
                        name = f"{path.name}.{index + 1:03d}" if total > 1 else path.name
                        result = await client.send_document(channel, data, filename=name)
                        sent.append({"chat": channel, "msg": result.message_id})
            except TelegramError as exc:
                await self._delete(client, sent)  # 不留下不完整的一组分卷
                text = str(exc).casefold()
                if "chat not found" in text or isinstance(exc, TelegramAuthError) or "not enough rights" in text:
                    raise RuntimeError(f"备份 Bot @{config['bot'] or '?'} 无法向频道 {channel} 发消息（Telegram：{exc}）。"
                                       "请确认它仍是该频道的管理员并能发布消息，然后在「备份设置」重新保存以检查") from None
                raise
            except BaseException:
                await self._delete(client, sent)
                raise
            item = {"name": path.name, "size": size, "uploaded_at": time.time(), "channel": str(channel), "parts": sent}
            items = [item, *self.items()]
            keep = int(config["keep"])
            stale = items[keep:]
            _put(self.metadata, ITEMS_KEY, items[:keep])
            for old in stale:
                await self._delete(client, old.get("parts") or [])
            return {"name": path.name, "parts": len(sent), "channel": str(channel)}

    async def _delete(self, client, parts) -> None:
        for part in parts:
            try:
                await client.delete_message(part["chat"], int(part["msg"]))
            except Exception as exc:  # 旧消息可能已超过删除时限、已被手动删除，或由旧版用存储 Bot 发出
                log.info("删除频道中的旧备份分卷失败：%s", type(exc).__name__)
