"""7z 解码进程的读写协议。子进程只接收从网盘取出的字节，不接触对象路径。"""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

BLOCK_SIZE = 256 * 1024
MESSAGE_LIMIT = 32 * 1024
TIMEOUT = 60
ERRORS = {
    "unavailable": "解压 7z 需要服务器安装支持 7z 的 libarchive",
    "aes_unavailable": "服务器缺少加密 7z 解码组件，请安装 Tessera 的运行依赖",
    "encrypted": "这个 7z 压缩包需要密码",
    "password": "密码不正确或 7z 压缩包已损坏",
    "unsupported": "这个 7z 压缩包使用了当前解码器不支持的压缩方式",
    "unchecked": "7z 压缩包内有文件缺少完整性校验信息，无法确认解密结果",
    "invalid": "7z 压缩包已损坏或使用了不支持的压缩方式",
    "name": "7z 压缩包内有文件名过长的条目",
    "limit": "7z 压缩包超过解码资源上限",
}


class SevenZipError(ValueError):
    def __init__(self, message: str, *, code: str = "invalid"):
        super().__init__(message)
        self.code = code


class Decoder:
    def __init__(self, process: asyncio.subprocess.Process, read: Callable[[int, int], Awaitable[bytes]],
                 size: int, check: Callable[[], None]):
        self.process = process
        self.read_range, self.size, self.check = read, size, check

    async def _send(self, data: bytes) -> None:
        self.process.stdin.write(data)
        async with asyncio.timeout(TIMEOUT):
            await self.process.stdin.drain()

    async def _readline(self) -> bytes:
        try:
            async with asyncio.timeout(TIMEOUT):
                while True:
                    try:
                        return await asyncio.wait_for(self.process.stdout.readline(), timeout=1)
                    except TimeoutError:
                        self.check()  # 解码长条目期间也要响应私密空间锁定。
        except ValueError:
            raise SevenZipError(ERRORS["invalid"]) from None

    async def _receive(self) -> dict:
        while True:
            self.check()
            line = await self._readline()
            self.check()
            if not line:
                raise SevenZipError("7z 解码进程意外退出，压缩包可能已损坏或超过资源上限")
            try:
                message = json.loads(line)
            except ValueError:
                raise SevenZipError(ERRORS["invalid"]) from None
            if not isinstance(message, dict):
                raise SevenZipError(ERRORS["invalid"])
            if "error" in message:
                code = message["error"]
                if not isinstance(code, str) or code not in ERRORS:
                    code = "invalid"
                raise SevenZipError(ERRORS[code], code=code)
            if "read" not in message:
                return message
            request = message["read"]
            if not (isinstance(request, list) and len(request) == 2 and all(type(value) is int for value in request)
                    and 0 <= request[0] < request[1] <= self.size and request[1] - request[0] <= BLOCK_SIZE):
                raise SevenZipError(ERRORS["invalid"])
            data = await self.read_range(*request)
            self.check()
            if len(data) != request[1] - request[0]:
                raise SevenZipError(ERRORS["invalid"])
            await self._send(data)

    async def next_entry(self) -> tuple[str, str, int] | None:
        message = await self._receive()
        if message.get("done") is True:
            async with asyncio.timeout(TIMEOUT):
                if await self.process.wait() != 0:
                    raise SevenZipError(ERRORS["invalid"])
            return None
        entry = message.get("entry")
        if not (isinstance(entry, list) and len(entry) == 3 and isinstance(entry[0], str)
                and entry[1] in ("dir", "file", "special") and type(entry[2]) is int and entry[2] >= 0):
            raise SevenZipError(ERRORS["invalid"])
        return entry[0], entry[1], entry[2]

    async def skip(self) -> None:
        await self._send(b"s")

    async def content(self, size: int) -> AsyncIterator[bytes]:
        await self._send(b"x")
        remaining = size
        while True:
            message = await self._receive()
            if message.get("end") is True and remaining == 0:
                return
            count = message.get("data")
            if type(count) is not int or not 0 < count <= min(BLOCK_SIZE, remaining):
                raise SevenZipError("7z 解压后的大小与记录不符，压缩包可能已损坏")
            async with asyncio.timeout(TIMEOUT):
                data = await self.process.stdout.readexactly(count)
            self.check()
            remaining -= count
            yield data


@asynccontextmanager
async def open_decoder(read: Callable[[int, int], Awaitable[bytes]], size: int,
                       check: Callable[[], None], *, password: str | None, max_entries: int) -> AsyncIterator[Decoder]:
    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-B", "-m", "tgdrive.sevenzip_worker",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, limit=MESSAGE_LIMIT,
        )
    except OSError:
        raise SevenZipError("无法启动 7z 解码进程，请稍后重试") from None
    decoder = Decoder(process, read, size, check)
    try:
        # 密码和归档大小走同一条管道，进程参数里只有固定的模块名。
        await decoder._send(json.dumps({"size": size, "password": password, "max_entries": max_entries}).encode("ascii") + b"\n")
        yield decoder
    except TimeoutError:
        raise SevenZipError("读取 7z 压缩包超时，请稍后重试") from None
    except (BrokenPipeError, ConnectionResetError, asyncio.IncompleteReadError):
        raise SevenZipError("7z 解码进程中断，请检查压缩包后重试") from None
    finally:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        # 取消时管道可能还有一段未消费的解压数据，读完才能回收进程。
        await process.communicate()
