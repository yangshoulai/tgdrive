"""把 Telegram 频道消息适配为 BlobStore。"""

from __future__ import annotations

import json
import time
from collections import OrderedDict
from dataclasses import dataclass

from ..blobstore import BlobStore
from ..errors import BlobNotFound, IntegrityError
from .client import TelegramAuthError, TelegramNotFoundError, TelegramRateLimitError, TelegramTransientError
from .pool import BotPool


@dataclass(frozen=True)
class TelegramRef:
    bot: str
    chat: int | str
    message: int
    file_id: str
    file_unique_id: str | None = None

    def encode(self) -> str:
        return json.dumps({"v": 1, "bot": self.bot, "chat": self.chat, "msg": self.message,
                           "fid": self.file_id, "uid": self.file_unique_id}, separators=(",", ":"))

    @classmethod
    def decode(cls, value: str) -> "TelegramRef":
        try:
            data = json.loads(value)
            if data.get("v") != 1:
                raise ValueError
            return cls(str(data["bot"]), data["chat"], int(data["msg"]), str(data["fid"]), data.get("uid"))
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
            raise ValueError("invalid Telegram blob reference") from exc


class TelegramBlobStore(BlobStore):
    MAX_UPLOAD_ATTEMPTS = 3

    def __init__(self, pool: BotPool, *, file_path_ttl: float = 50 * 60, max_cached_paths: int = 4096) -> None:
        self.pool = pool
        self.file_path_ttl = file_path_ttl
        self.max_cached_paths = max_cached_paths
        # file_path 由 getFile 返回、约 1 小时有效；按 LRU 保留，避免长期运行时无限增长。
        self._file_cache: OrderedDict[tuple[str, str], tuple[str, float]] = OrderedDict()

    async def put(self, key: str, data: bytes) -> str:
        # 一个 Bot 失败（限流、网络、token 失效）时换另一个 Bot 重试，失败的 Bot 进入退避冷却。
        tried: set[str] = set()
        last_error: Exception | None = None
        for _ in range(self.MAX_UPLOAD_ATTEMPTS):
            try:
                bot = await self.pool.acquire_for_upload(exclude=tried)
            except RuntimeError:
                break
            tried.add(bot.id)
            try:
                sent = await bot.client.send_document(bot.channel_id, data, filename="chunk.bin")
            except TelegramRateLimitError as exc:
                self.pool.mark_failure(bot.id, retry_after=exc.retry_after)
                last_error = exc
                continue
            except (TelegramTransientError, TelegramAuthError, OSError) as exc:
                self.pool.mark_failure(bot.id)
                last_error = exc
                continue
            self.pool.mark_success(bot.id)
            return TelegramRef(bot.id, bot.channel_id, sent.message_id, sent.file_id, sent.file_unique_id).encode()
        if last_error is not None:
            raise last_error
        raise RuntimeError("没有可用于上传的 Telegram Bot")

    async def _file_path(self, ref: TelegramRef, *, refresh: bool = False) -> str:
        cache_key = (ref.bot, ref.file_id)
        cached = self._file_cache.get(cache_key)
        now = time.monotonic()
        if not refresh and cached is not None and cached[1] > now:
            self._file_cache.move_to_end(cache_key)
            return cached[0]
        bot = self.pool.get(ref.bot)
        info = await bot.client.get_file(ref.file_id)
        self._file_cache[cache_key] = (info.file_path, now + self.file_path_ttl)
        self._file_cache.move_to_end(cache_key)
        while len(self._file_cache) > self.max_cached_paths:
            self._file_cache.popitem(last=False)
        return info.file_path

    async def get(self, ref_value: str, start: int | None = None, end: int | None = None) -> bytes:
        try:
            ref = TelegramRef.decode(ref_value)
            bot = self.pool.get(ref.bot)
        except (ValueError, KeyError) as exc:
            raise BlobNotFound(ref_value) from exc
        path = await self._file_path(ref)
        response = await bot.client.download_file(path, start, end)
        if response.status == 404:
            path = await self._file_path(ref, refresh=True)
            response = await bot.client.download_file(path, start, end)
        if response.status == 429:
            raise TelegramRateLimitError("Telegram 文件下载限流", retry_after=1, method="file")
        if response.status >= 500:
            raise TelegramTransientError("Telegram 文件下载暂时失败", method="file", status=response.status)
        if response.status >= 400:
            raise BlobNotFound(ref_value)
        if start is not None or end is not None:
            content_range = response.headers.get("Content-Range", "")
            if response.status == 200 and not content_range:
                # Telegram Range 降级：下载完整消息后在本地裁剪，正确性优先于性能。
                left = start or 0
                right = end if end is not None else len(response.body)
                return response.body[left:right]
            if response.status == 206:
                expected = (end - start) if start is not None and end is not None else None
                if expected is not None and len(response.body) != expected:
                    raise IntegrityError("Telegram Range 响应长度不匹配")
        return response.body

    async def delete(self, ref_value: str) -> None:
        try:
            ref = TelegramRef.decode(ref_value)
            bot = self.pool.get(ref.bot)
        except (ValueError, KeyError) as exc:
            raise BlobNotFound(ref_value) from exc
        try:
            await bot.client.delete_message(ref.chat, ref.message)
        except TelegramNotFoundError:
            return
