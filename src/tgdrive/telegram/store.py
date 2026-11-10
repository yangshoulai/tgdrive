"""把 Telegram 频道消息适配为 BlobStore。"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass

from ..blobstore import BlobStore
from ..errors import BlobNotFound, IntegrityError, StorageAccessError
from .client import (
    TelegramAuthError,
    TelegramError,
    TelegramRateLimitError,
    TelegramTransientError,
)
from .pool import BotPool

log = logging.getLogger(__name__)


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
    def decode(cls, value: str) -> TelegramRef:
        try:
            data = json.loads(value)
            if data.get("v") != 1:
                raise ValueError
            return cls(str(data["bot"]), data["chat"], int(data["msg"]), str(data["fid"]), data.get("uid"))
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
            raise ValueError("invalid Telegram blob reference") from exc


class TelegramBlobStore(BlobStore):
    MAX_UPLOAD_ATTEMPTS = 4
    RETRY_PAUSE = 2.0

    def __init__(self, pool: BotPool, *, file_path_ttl: float = 50 * 60, max_cached_paths: int = 4096) -> None:
        self.pool = pool
        self.file_path_ttl = file_path_ttl
        self.max_cached_paths = max_cached_paths
        # file_path 由 getFile 返回、约 1 小时有效；按 LRU 保留，避免长期运行时无限增长。
        self._file_cache: OrderedDict[tuple[str, str], tuple[str, float]] = OrderedDict()

    async def put(self, key: str, data: bytes) -> str:
        # 一个 Bot 失败（限流、网络、token 失效、请求被拒）时换另一个 Bot 重试，失败的 Bot 进入退避冷却；
        # 每个 Bot 都试过后稍等再从头轮换，只有一个 Bot 时也能重试。大文件要上传几百个分片，
        # 任何一次偶发错误都会让整个文件失败，所以不能只靠任务层从头重来。
        tried: set[str] = set()
        last_error: Exception | None = None
        for attempt in range(self.MAX_UPLOAD_ATTEMPTS):
            if tried and tried.issuperset(self.pool.enabled_ids()):
                tried.clear()
                await asyncio.sleep(self.RETRY_PAUSE * attempt)
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
            except TelegramError as exc:
                # 其他拒绝（400 等）：说明来自 Telegram，不含 token 或数据，记下来便于排查。
                log.warning("Telegram 拒绝上传分片：bot=%s code=%s %s", bot.id, exc.error_code, exc)
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
        for attempt in range(3):
            try:
                return await self._get_once(ref_value, start, end)
            except (TelegramRateLimitError, TelegramTransientError, OSError) as exc:
                if attempt == 2:
                    raise
                delay = exc.retry_after if isinstance(exc, TelegramRateLimitError) else 2 ** attempt
                await asyncio.sleep(max(0, delay))
        raise AssertionError("unreachable")

    async def _get_once(self, ref_value: str, start: int | None = None, end: int | None = None) -> bytes:
        try:
            ref = TelegramRef.decode(ref_value)
            bot = self.pool.get(ref.bot)
        except (ValueError, KeyError) as exc:
            raise BlobNotFound(ref_value) from exc
        try:
            path = await self._file_path(ref)
        except TelegramAuthError as exc:
            raise StorageAccessError("Telegram Bot 凭据不可用，请检查 Bot token") from exc
        response = await bot.client.download_file(path, start, end)
        if response.status == 404:
            path = await self._file_path(ref, refresh=True)
            response = await bot.client.download_file(path, start, end)
        if response.status == 429:
            raise TelegramRateLimitError("Telegram 文件下载限流", retry_after=1, method="file")
        if response.status >= 500:
            raise TelegramTransientError("Telegram 文件下载暂时失败", method="file", status=response.status)
        if response.status in (401, 403):
            # 凭据或权限问题：与「分片不存在」区分，巡检不应把它记成分片损坏。
            raise StorageAccessError(f"Telegram 拒绝读取分片（HTTP {response.status}），请检查 Bot 凭据与频道权限")
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
        except TelegramError as exc:
            # 远端已删除、本地尚未来得及出队便重启时，重试会收到 400 而不是 404。
            # 只把明确的「消息不存在」视为幂等成功；频道、凭据或 API 地址错误仍须保留失败记录。
            message = str(exc).strip().casefold().removeprefix("bad request: ").strip()
            if exc.error_code == 400 and message == "message to delete not found":
                return
            raise
