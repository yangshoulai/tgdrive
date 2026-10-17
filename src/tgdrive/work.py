"""并发与速率限制：密码计算、文件读取名额、写入存储的上传名额与上传限速。"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager


class WorkBusyError(Exception):
    """等待资源名额超时，客户端可以稍后重试。"""


class PasswordWork:
    def __init__(self, concurrency: int = 2) -> None:
        self._slots = asyncio.Semaphore(concurrency)

    async def run(self, function, /, *args, before=None, **kwargs):
        await self._slots.acquire()
        task = None
        try:
            if before is not None:
                before()
            task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
            return await asyncio.shield(task)
        finally:
            if task is None or task.done():
                self._slots.release()
            else:
                # 请求取消不终止线程，也不能提前归还名额；后台任务实际结束后再释放。
                def finished(completed):
                    if not completed.cancelled():
                        completed.exception()
                    self._slots.release()
                task.add_done_callback(finished)


class TransferSlots:
    def __init__(self, total: int = 4, per_bucket: int = 2, wait_seconds: float = 30) -> None:
        if total < 1 or per_bucket < 1 or wait_seconds <= 0:
            raise ValueError("传输并发和等待时间必须为正数")
        self.total, self.per_bucket, self.wait_seconds = total, per_bucket, wait_seconds
        self._active = 0
        self._buckets: dict[int | None, int] = {}
        self._condition = asyncio.Condition()

    def set_limits(self, total: int, per_bucket: int) -> None:
        """降低名额不取消现有传输；等待者在释放名额或短周期检查时使用新预算。"""
        if total < 1 or per_bucket < 1:
            raise ValueError("传输并发必须为正数")
        self.total, self.per_bucket = total, per_bucket

    @asynccontextmanager
    async def slot(self, bucket_id: int | None):
        acquired = False
        try:
            try:
                async with asyncio.timeout(self.wait_seconds):
                    async with self._condition:
                        while self._active >= self.total or self._buckets.get(bucket_id, 0) >= self.per_bucket:
                            try:
                                async with asyncio.timeout(0.5):
                                    await self._condition.wait()
                            except TimeoutError:
                                pass
                        self._active += 1
                        self._buckets[bucket_id] = self._buckets.get(bucket_id, 0) + 1
                        acquired = True
            except TimeoutError as exc:
                raise WorkBusyError("传输繁忙，请稍后重试") from exc
            yield
        finally:
            if acquired:
                async with self._condition:
                    self._active -= 1
                    self._buckets[bucket_id] -= 1
                    if not self._buckets[bucket_id]:
                        self._buckets.pop(bucket_id)
                    self._condition.notify_all()


class Limiter:
    """可随时调整上限的并发名额；调低时不打断已获准的任务，后续排队按新上限放行。"""

    def __init__(self, limit: int) -> None:
        if limit < 1:
            raise ValueError("并发必须为正数")
        self.limit, self._active = limit, 0
        self._condition = asyncio.Condition()

    def set_limit(self, limit: int) -> None:
        if limit < 1:
            raise ValueError("并发必须为正数")
        self.limit = limit
        # 在事件循环外调用时不能直接 notify；等待者也会每 0.5 秒自行检查。

    @asynccontextmanager
    async def slot(self):
        async with self._condition:
            while self._active >= self.limit:
                try:
                    async with asyncio.timeout(0.5):
                        await self._condition.wait()
                except TimeoutError:
                    pass
            self._active += 1
        try:
            yield
        finally:
            async with self._condition:
                self._active -= 1
                self._condition.notify_all()


class RateLimiter:
    """按字节计的平均速率限制；rate 为 0 表示不限速。按预约时刻排队，不同调用者共享同一速率。"""

    def __init__(self, rate: int = 0) -> None:
        self.rate, self._next = 0, 0.0
        self.set_rate(rate)

    def set_rate(self, rate: int) -> None:
        if rate < 0:
            raise ValueError("限速不能为负数")
        self.rate = rate

    async def consume(self, size: int) -> None:
        rate = self.rate
        if not rate or size <= 0:
            self._next = 0.0
            return
        now = time.monotonic()
        start = max(now, self._next)
        self._next = start + size / rate
        if start > now:
            await asyncio.sleep(start - now)
