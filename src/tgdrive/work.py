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
        self._global = asyncio.Semaphore(total)
        self._buckets: dict[int | None, list] = {}
        self.per_bucket, self.wait_seconds = per_bucket, wait_seconds

    @asynccontextmanager
    async def slot(self, bucket_id: int | None):
        entry = self._buckets.setdefault(bucket_id, [asyncio.Semaphore(self.per_bucket), 0])
        entry[1] += 1
        local, global_slot = False, False
        try:
            try:
                async with asyncio.timeout(self.wait_seconds):
                    await entry[0].acquire()
                    local = True
                    await self._global.acquire()
                    global_slot = True
            except TimeoutError as exc:
                raise WorkBusyError("传输繁忙，请稍后重试") from exc
            yield
        finally:
            if global_slot:
                self._global.release()
            if local:
                entry[0].release()
            entry[1] -= 1
            if not entry[1]:
                self._buckets.pop(bucket_id, None)
