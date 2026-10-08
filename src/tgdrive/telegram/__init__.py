"""Telegram 云端 Bot API 适配层（M2）。"""

from .client import (
    TelegramAuthError,
    TelegramClient,
    TelegramError,
    TelegramNotFoundError,
    TelegramRateLimitError,
    TelegramTransientError,
)
from .config import TelegramBotConfigStore
from .pool import BotPool, BotState, PoolBot
from .store import TelegramBlobStore

__all__ = [
    "BotPool",
    "BotState",
    "PoolBot",
    "TelegramAuthError",
    "TelegramBlobStore",
    "TelegramBotConfigStore",
    "TelegramClient",
    "TelegramError",
    "TelegramNotFoundError",
    "TelegramRateLimitError",
    "TelegramTransientError",
]
