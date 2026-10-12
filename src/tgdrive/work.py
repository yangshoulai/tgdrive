"""限制高内存密码计算的并发；会话与数据库变更仍在事件循环中执行。"""

from __future__ import annotations

import asyncio
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
