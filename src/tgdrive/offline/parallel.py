"""离线下载的多连接工具：同时进行若干个读取，结果按原来的顺序交出。"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from typing import TypeVar

T = TypeVar("T")
R = TypeVar("R")


async def ordered(items: Iterable[T], fetch: Callable[[T], Awaitable[R]], concurrency: int) -> AsyncIterator[R]:
    """最多同时运行 concurrency 个 fetch(item)，按 items 的顺序逐个交出结果。

    窗口只向前预读 concurrency 项：调用方处理得慢时不会无限攒结果。任何一项失败都会抛出，
    提前结束（调用方 aclose、取消或出错）时取消并等待所有未完成的读取，不留下后台连接。
    """
    pending: deque[asyncio.Task[R]] = deque()
    source = iter(items)
    try:
        for item in source:
            pending.append(asyncio.ensure_future(fetch(item)))
            if len(pending) >= max(1, concurrency):
                break
        while pending:
            result = await pending[0]
            pending.popleft()
            for item in source:
                pending.append(asyncio.ensure_future(fetch(item)))
                break
            yield result
    finally:
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
