"""书籍封面读取入口：解析在短时子进程中进行，存储访问仍由主进程逐段授权。"""

from __future__ import annotations

import asyncio
import json
import struct
import sys
from collections.abc import Awaitable, Callable

from ..library import book_type

MAX_COVER = 20 * 1024 * 1024
READ_CHUNK = 256 * 1024
MAX_READ = 256 * 1024 * 1024
_slots = asyncio.Semaphore(2)


class BookCoverError(ValueError):
    pass


ERRORS = {
    "invalid": "书籍文件已损坏，或不是受支持的书籍格式",
    "limit": "书籍封面或目录超过安全读取上限，请改用本地图片",
    "encrypted": "这本书或漫画已加密，无法直接读取封面",
    "unsupported": "内置封面的格式暂不支持，请改用本地图片",
    "rar_unavailable": "读取 CBR 封面需要服务器安装 libarchive（libarchive-tools）",
    "rar_unsupported": "这个 CBR 的压缩方式暂不支持，或文件已损坏",
}


async def read_cover(read: Callable[[int, int], Awaitable[bytes]], size: int, key: str,
                     content_type: str | None = None) -> bytes | None:
    """只接受明确电子书／漫画；None 仅表示成功解析后确认没有封面，不把失败当作无图。"""
    if not book_type(key, content_type) or size <= 0:
        raise BookCoverError("只有电子书和漫画文件可以读取书籍内置封面")
    async with _slots:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "tgdrive.media.book_cover_worker",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, limit=4096,
        )
        try:
            async with asyncio.timeout(55):
                process.stdin.write(json.dumps({"size": size, "key": key, "type": content_type}).encode() + b"\n")
                await process.stdin.drain()
                consumed = 0
                while True:
                    line = await process.stdout.readline()
                    if not line:
                        raise BookCoverError("书籍封面读取失败，请稍后重试")
                    message = json.loads(line)
                    if "read" in message:
                        start, end = message["read"]
                        if not (isinstance(start, int) and isinstance(end, int) and 0 <= start <= end <= size
                                and end - start <= READ_CHUNK and consumed + end - start <= MAX_READ):
                            raise BookCoverError(ERRORS["limit"])
                        consumed += end - start
                        data = await read(start, end)
                        if len(data) != end - start:
                            raise BookCoverError(ERRORS["invalid"])
                        process.stdin.write(struct.pack(">I", len(data)) + data)
                        await process.stdin.drain()
                    elif "cover" in message:
                        length = message["cover"]
                        if not isinstance(length, int) or not 0 <= length <= MAX_COVER:
                            raise BookCoverError(ERRORS["limit"])
                        data = await process.stdout.readexactly(length) if length else None
                        if await process.wait() != 0:
                            raise BookCoverError("书籍封面读取失败，请稍后重试")
                        return data
                    else:
                        raise BookCoverError(ERRORS.get(message.get("error"), ERRORS["invalid"]))
        except TimeoutError:
            raise BookCoverError("读取书籍封面超时，请稍后重试或改用本地图片") from None
        except (EOFError, BrokenPipeError, ConnectionResetError, asyncio.IncompleteReadError, json.JSONDecodeError):
            raise BookCoverError("书籍封面读取中断，请稍后重试") from None
        finally:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()
            process.stdin.close()
