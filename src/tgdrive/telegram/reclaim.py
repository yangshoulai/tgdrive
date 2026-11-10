"""用其他 Bot 重新认领分片：某个 Bot 被封禁或 token 作废后，它上传的分片仍在频道里，但 file_id 只对上传它的 Bot
有效，读不出来。这里让另一个可用的 Bot 把原消息转发到自己的存储频道，取得它自己的 file_id，再把分片引用改指向新消息。

- 原消息的删除改由新 Bot 负责：把 (新 Bot, 原频道, 原消息) 交给 GC，失效的 Bot 不再参与任何操作。新 Bot 没有原频道
  删除权限或超过 Telegram 删除时限时，GC 会把它记为失败，可在控制台查看原因，不影响已认领的分片。
- 引用替换在事务里按旧引用精确匹配：期间分片被删除或已被替换时，新转发的消息交给 GC，不会遗留。
- 等待删除的 GC 条目里属于失效 Bot 的，直接改由新 Bot 删除，不必转发。
- 转发前后核对 file_unique_id（同一个文件对所有 Bot 相同），防止转发到别的消息。
"""

from __future__ import annotations

import json
import logging
import time

from .client import TelegramAuthError, TelegramError, TelegramRateLimitError
from .store import TelegramRef

log = logging.getLogger(__name__)


def ref_prefix(bot_id: str) -> str:
    # TelegramRef.encode 用紧凑 JSON 且 v、bot 在最前，按前缀即可筛出某个 Bot 的引用。
    return '{"v":1,"bot":' + json.dumps(str(bot_id)) + ","


class BotReclaimer:
    def __init__(self, metadata, pool_factory) -> None:
        self.metadata, self.pool_factory = metadata, pool_factory

    def _pool(self):
        pool = self.pool_factory() if callable(self.pool_factory) else self.pool_factory
        if pool is None:
            raise ValueError("尚未配置 Telegram 存储通道，或系统未解锁")
        return pool

    def pending(self, source: str) -> dict[str, int]:
        like = ref_prefix(source).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        chunks = self.metadata.db.execute("SELECT COUNT(DISTINCT blob_ref) FROM chunks WHERE blob_ref LIKE ? ESCAPE '\\'", (like,)).fetchone()[0]
        gc = self.metadata.db.execute("SELECT COUNT(*) FROM gc_queue WHERE blob_ref LIKE ? ESCAPE '\\'", (like,)).fetchone()[0]
        return {"chunks": int(chunks), "gc": int(gc)}

    async def run_once(self, source: str, *, limit: int = 200) -> dict[str, object]:
        source = str(source)
        pool = self._pool()
        targets = [bot_id for bot_id in pool.enabled_ids() if bot_id != source]
        if not targets:
            raise ValueError("没有其他可用的 Bot：请先添加并启用一个新的 Bot，并设为原频道的管理员")
        if not 1 <= limit <= 5000:
            raise ValueError("每次认领数量必须在 1–5000 之间")
        prefix = ref_prefix(source)
        like = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        now = time.time()
        rebound_gc = 0
        # 等待删除的条目：只需换一个 Bot 来删除。
        rows = self.metadata.db.execute("SELECT id, blob_ref FROM gc_queue WHERE blob_ref LIKE ? ESCAPE '\\' LIMIT 5000", (like,)).fetchall()
        if rows:
            with self.metadata.transaction() as db:
                for row in rows:
                    try:
                        ref = TelegramRef.decode(row["blob_ref"])
                    except ValueError:
                        continue
                    target = targets[row["id"] % len(targets)]
                    db.execute("UPDATE gc_queue SET blob_ref=?, attempts=0, last_error=NULL WHERE id=?",
                               (TelegramRef(target, ref.chat, ref.message, ref.file_id, ref.file_unique_id).encode(), row["id"]))
                    rebound_gc += 1
        refs = [row[0] for row in self.metadata.db.execute(
            "SELECT DISTINCT blob_ref FROM chunks WHERE blob_ref LIKE ? ESCAPE '\\' LIMIT ?", (like, limit))]
        reclaimed = failed = 0
        errors: dict[str, int] = {}
        for old in refs:
            try:
                ref = TelegramRef.decode(old)
            except ValueError:
                failed += 1
                errors["引用格式无效"] = errors.get("引用格式无效", 0) + 1
                continue
            bot = await pool.acquire_for_upload(exclude={source})
            try:
                sent = await bot.client.forward_message(bot.channel_id, ref.chat, ref.message)
            except TelegramRateLimitError as exc:
                pool.mark_failure(bot.id, retry_after=exc.retry_after)
                failed += 1
                errors["Telegram 限流，稍后再试"] = errors.get("Telegram 限流，稍后再试", 0) + 1
                break
            except (TelegramAuthError, TelegramError, OSError) as exc:
                failed += 1
                reason = self._reason(exc)
                errors[reason] = errors.get(reason, 0) + 1
                continue
            new = TelegramRef(bot.id, bot.channel_id, sent.message_id, sent.file_id, sent.file_unique_id)
            if ref.file_unique_id and sent.file_unique_id and ref.file_unique_id != sent.file_unique_id:
                # 转发到的不是原文件：不替换，新消息交给 GC。
                self.metadata.enqueue_refs([new.encode()], now)
                failed += 1
                errors["原消息已变成其他文件"] = errors.get("原消息已变成其他文件", 0) + 1
                continue
            pool.mark_success(bot.id)
            with self.metadata.transaction() as db:
                changed = db.execute("UPDATE chunks SET blob_ref=? WHERE blob_ref=?", (new.encode(), old)).rowcount
                if changed:
                    # 原消息由新 Bot 删除；这条引用只用于删除，file_id 不会被读取。
                    db.execute("INSERT INTO gc_queue(blob_ref,enqueued_at) VALUES(?,?)",
                               (TelegramRef(bot.id, ref.chat, ref.message, ref.file_id, ref.file_unique_id).encode(), now))
                else:
                    db.execute("INSERT INTO gc_queue(blob_ref,enqueued_at) VALUES(?,?)", (new.encode(), now))
            reclaimed += 1 if changed else 0
        return {"reclaimed": reclaimed, "failed": failed, "rebound_gc": rebound_gc,
                "errors": [{"reason": reason, "count": count} for reason, count in errors.items()],
                "remaining": self.pending(source)["chunks"]}

    @staticmethod
    def _reason(exc: Exception) -> str:
        text = str(exc).casefold()
        if "message to forward not found" in text or "message not found" in text:
            return "原消息已不存在"
        if "chat not found" in text or "not a member" in text or "kicked" in text or isinstance(exc, TelegramAuthError):
            return "新 Bot 无法访问原频道，请把它设为原频道管理员"
        if isinstance(exc, OSError):
            return "连接 Telegram 失败"
        return "Telegram 拒绝转发"
