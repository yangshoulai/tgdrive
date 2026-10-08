"""Telegram 云端 Bot API 适配层（M2）。"""

from .client import (
    TelegramAuthError,
    TelegramClient,
    TelegramError,
    TelegramNotFoundError,
    TelegramRateLimitError,
    TelegramTransientError,
)
from .pool import BotPool, BotState, PoolBot
from .store import TelegramBlobStore
from .config import TelegramBotConfigStore

__all__ = [
    "BotPool", "BotState", "PoolBot", "TelegramAuthError", "TelegramBlobStore",
    "TelegramClient", "TelegramError", "TelegramNotFoundError", "TelegramRateLimitError",
    "TelegramBotConfigStore",
    "TelegramTransientError",
]
