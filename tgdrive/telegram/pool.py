"""Telegram Bot 池：选择可用 Bot，并按频道维度限速。"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from enum import StrEnum

from .client import TelegramClient


class BotState(StrEnum):
    ENABLED = "enabled"
    DRAINING = "draining"
    DISABLED = "disabled"


@dataclass
class PoolBot:
    id: str
    client: TelegramClient
    channel_id: int | str
    state: BotState = BotState.ENABLED
    last_sent_at: float = 0.0
    failures: int = 0
    cooldown_until: float = 0.0

    def __post_init__(self) -> None:
        self.state = BotState(self.state)


class BotPool:
    def __init__(self, bots: list[PoolBot] | None = None, *, min_interval: float = 1.0) -> None:
        self.bots = {bot.id: bot for bot in (bots or [])}
        self.min_interval = max(0.0, min_interval)
        self._lock = asyncio.Lock()
        self._cursor = 0

    def add(self, bot: PoolBot) -> None:
        if bot.id in self.bots:
            raise ValueError(f"duplicate bot id: {bot.id}")
        self.bots[bot.id] = bot

    def get(self, bot_id: str) -> PoolBot:
        try:
            return self.bots[bot_id]
        except KeyError as exc:
            raise KeyError(f"unknown bot: {bot_id}") from exc

    # 连续失败达到阈值后进入冷却，冷却时间指数增长并封顶。
    FAILURE_THRESHOLD = 3
    BASE_COOLDOWN = 15.0
    MAX_COOLDOWN = 300.0

    async def acquire_for_upload(self, *, exclude: set[str] | None = None) -> PoolBot:
        async with self._lock:
            now = time.monotonic()
            enabled = [b for b in self.bots.values() if b.state is BotState.ENABLED and b.id not in (exclude or set())]
            if not enabled:
                raise RuntimeError("没有可用于上传的 Telegram Bot")
            healthy = sorted((b for b in enabled if b.cooldown_until <= now), key=lambda bot: bot.id)
            if healthy:
                bot = healthy[self._cursor % len(healthy)]
                self._cursor += 1
            else:
                # 全部处于冷却时退化为尝试最早恢复的那个，而不是直接拒绝上传。
                bot = min(enabled, key=lambda item: item.cooldown_until)
            scheduled = max(now, bot.last_sent_at + self.min_interval)
            # 先预留发送时刻再释放锁，不能因为某个频道限速而阻塞其他 Bot。
            bot.last_sent_at = scheduled
        if scheduled > now:
            await asyncio.sleep(scheduled - now)
        return bot

    def mark_failure(self, bot_id: str, *, retry_after: float | None = None) -> None:
        bot = self.get(bot_id)
        bot.failures += 1
        cooldown = retry_after or 0.0
        if bot.failures >= self.FAILURE_THRESHOLD:
            cooldown = max(cooldown, min(self.MAX_COOLDOWN, self.BASE_COOLDOWN * 2 ** (bot.failures - self.FAILURE_THRESHOLD)))
        if cooldown:
            bot.cooldown_until = max(bot.cooldown_until, time.monotonic() + cooldown)

    def mark_success(self, bot_id: str) -> None:
        bot = self.get(bot_id)
        bot.failures = 0
        bot.cooldown_until = 0.0

    def set_state(self, bot_id: str, state: BotState) -> None:
        self.get(bot_id).state = BotState(state)

    def enabled_ids(self) -> list[str]:
        return sorted(bot.id for bot in self.bots.values() if bot.state is BotState.ENABLED)
