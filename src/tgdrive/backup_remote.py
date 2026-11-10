"""把已加密的元数据备份（.tgdbak）发到 Telegram 频道，作为本机磁盘之外的副本。

meta.db 里存着全部包裹密钥与分片引用：数据目录所在磁盘损坏时，频道里的分片就无法解密。备份本身已用口令派生的
密钥加密，发到频道不泄露内容。Bot API 单个文件最多 50 MB，所以按 PART_SIZE 分卷，文件名形如
``tgdrive-20261110-030000-….tgdbak.001``：本机数据库整个丢失时，也能在 Telegram 客户端里下载全部分卷，
按序号拼接（``cat *.tgdbak.0* > x.tgdbak``）后用 ``tgdrive restore`` 恢复。

发送位置：设置了独立备份频道时发到那里（推荐，存储频道被删时备份仍在），否则回落到第一个可用 Bot 的存储频道。
只保留最近 keep 份，更早的分卷消息会被删除（超过 Bot API 48 小时删除时限的旧消息删除失败时只记录，不影响新备份）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path


log = logging.getLogger(__name__)

PART_SIZE = 45 * 1024 * 1024
SETTINGS_KEY = "backup.remote"
ITEMS_KEY = "backup.remote.items"


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
    def __init__(self, metadata, pool, *, part_size: int = PART_SIZE) -> None:
        # pool 是 BotPool，或返回当前 BotPool（未配置 Telegram 时为 None）的函数：Bot 池随配置变化重建。
        self.metadata, self._pool, self.part_size = metadata, pool, part_size
        self._lock = asyncio.Lock()

    def settings(self) -> dict[str, object]:
        saved = _get(self.metadata, SETTINGS_KEY, {}) or {}
        keep = saved.get("keep")
        return {"enabled": bool(saved.get("enabled", False)), "channel": str(saved.get("channel") or ""),
                "keep": keep if type(keep) is int and 1 <= keep <= 100 else 7}

    def configure(self, enabled, channel, keep) -> dict[str, object]:
        if not isinstance(enabled, bool):
            raise ValueError("请选择是否把备份发送到 Telegram")
        channel = "" if channel is None else str(channel).strip()
        if channel and not (channel.lstrip("-").isdigit() or (channel.startswith("@") and 5 < len(channel) <= 33)):
            raise ValueError("备份频道请填写频道 ID（如 -1001234567890）或 @用户名，留空表示使用存储频道")
        if type(keep) is not int or not 1 <= keep <= 100:
            raise ValueError("频道中保留的备份数量必须是 1–100 的整数")
        _put(self.metadata, SETTINGS_KEY, {"enabled": enabled, "channel": channel, "keep": keep})
        return self.settings()

    def items(self) -> list[dict[str, object]]:
        items = _get(self.metadata, ITEMS_KEY, []) or []
        return [item for item in items if isinstance(item, dict)]

    def status(self) -> dict[str, object]:
        items = self.items()
        return {**self.settings(), "uploaded": [{"name": item["name"], "size": item["size"], "uploaded_at": item["uploaded_at"],
                                                 "parts": len(item["parts"]), "channel": item["channel"]} for item in items]}

    @property
    def pool(self):
        pool = self._pool() if callable(self._pool) else self._pool
        if pool is None:
            raise RuntimeError("尚未配置 Telegram 存储通道，无法把备份发送到频道")
        return pool

    def _bot(self):
        enabled = self.pool.enabled_ids()
        if not enabled:
            raise RuntimeError("没有可用的 Telegram Bot，无法把备份发送到频道")
        return self.pool.get(enabled[0])

    async def upload(self, path: str | Path) -> dict[str, object] | None:
        """发送一份备份；未启用时返回 None。失败时抛出，由维护任务记录。"""
        config = self.settings()
        if not config["enabled"]:
            return None
        path = Path(path)
        async with self._lock:
            bot = self._bot()
            channel = config["channel"] or bot.channel_id
            sent: list[dict[str, object]] = []
            size = path.stat().st_size
            total = max(1, -(-size // self.part_size))
            try:
                with path.open("rb") as handle:
                    for index in range(total):
                        data = await asyncio.to_thread(handle.read, self.part_size)
                        name = f"{path.name}.{index + 1:03d}" if total > 1 else path.name
                        result = await bot.client.send_document(channel, data, filename=name)
                        sent.append({"bot": bot.id, "chat": channel, "msg": result.message_id})
            except BaseException:
                await self._delete(sent)  # 不留下不完整的一组分卷
                raise
            item = {"name": path.name, "size": size, "uploaded_at": time.time(), "channel": str(channel), "parts": sent}
            items = [item, *self.items()]
            keep = int(config["keep"])
            stale = items[keep:]
            _put(self.metadata, ITEMS_KEY, items[:keep])
            for old in stale:
                await self._delete(old.get("parts") or [])
            return {"name": path.name, "parts": len(sent), "channel": str(channel)}

    async def _delete(self, parts) -> None:
        for part in parts:
            try:
                await self.pool.get(str(part["bot"])).client.delete_message(part["chat"], int(part["msg"]))
            except Exception as exc:  # 旧消息可能已超过删除时限或已被手动删除
                log.info("删除频道中的旧备份分卷失败：%s", type(exc).__name__)
