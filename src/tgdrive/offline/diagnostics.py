"""离线下载诊断：记录一个任务正在进行的来源连接与存储写入，供网页「下载诊断」查看。

只记录字节数、HTTP 状态、请求范围与时间，不记录地址、请求头、Cookie 或内容。记录器经 ContextVar 传递：
任务协程开始时设置，之后创建的子任务（多连接分段、YouTube 双轨、M3U8 预读）自动继承，
SafeHttpClient 与写入路径只在有记录器时才登记，其他用途（封面地址、文件助手的 HTTP 请求）不受影响。
"""

from __future__ import annotations

import asyncio
import itertools
import re
import time
from collections import deque
from contextvars import ContextVar

CURRENT: ContextVar["TaskDiagnosis | None"] = ContextVar("offline_diagnosis", default=None)

# 已结束的连接与写入各保留最近几条，便于看到刚刚失败的原因。
RECENT = 8


def _range_label(headers: dict[str, str] | None) -> tuple[str, int | None]:
    value = next((v for k, v in (headers or {}).items() if k.lower() == "range"), "")
    match = re.fullmatch(r"bytes=(\d+)-(\d*)", value.strip())
    if not match:
        return "", None
    start = int(match[1])
    end = int(match[2]) if match[2] else None
    return (f"{start}-{end}" if end is not None else f"{start}-"), (end - start + 1 if end is not None else None)


class Connection:
    __slots__ = ("id", "range", "phase", "status", "received", "size", "started", "responded", "first_byte", "last_data", "ended", "error")

    def __init__(self, number: int, headers: dict[str, str] | None):
        self.id = number
        self.range, self.size = _range_label(headers)
        self.phase, self.status, self.received = "connecting", None, 0
        self.started = time.monotonic()
        self.responded = self.first_byte = self.last_data = self.ended = None
        self.error = ""

    def response(self, status: int, length: int | None) -> None:
        self.phase, self.status, self.responded = "receiving", status, time.monotonic()
        if self.size is None and length is not None:
            self.size = length

    def data(self, size: int) -> None:
        now = time.monotonic()
        self.received += size
        self.last_data = now
        if self.first_byte is None:
            self.first_byte = now


class TaskDiagnosis:
    def __init__(self, task_id: int):
        self.task_id = task_id
        self.started = time.monotonic()
        self._ids = itertools.count(1)
        self.connections: dict[int, Connection] = {}
        self.recent: deque[Connection] = deque(maxlen=RECENT)
        self.writes: dict[int, dict] = {}
        self.recent_writes: deque[dict] = deque(maxlen=RECENT)
        self.totals = {"requests": 0, "failed": 0, "writes": 0, "written": 0}
        self.phase = "starting"

    def open(self, headers: dict[str, str] | None) -> Connection:
        connection = Connection(next(self._ids), headers)
        self.connections[connection.id] = connection
        self.totals["requests"] += 1
        return connection

    def close(self, connection: Connection, error: BaseException | None = None) -> None:
        connection.ended = time.monotonic()
        if isinstance(error, asyncio.CancelledError):
            # 任务停止、让出空位或多连接中其他段失败时取消的连接，不算来源故障。
            connection.phase = "cancelled"
        elif error is not None and not isinstance(error, GeneratorExit):
            connection.phase = "failed"
            # 只保留异常类型与面向用户的说明，不带地址。
            connection.error = str(error) if isinstance(error, ValueError) else type(error).__name__
            self.totals["failed"] += 1
        else:
            connection.phase = "done"
        self.connections.pop(connection.id, None)
        self.recent.append(connection)

    def write_started(self, part: int, size: int) -> dict:
        entry = {"part": part, "size": size, "started": time.monotonic(), "ended": None, "error": ""}
        self.writes[part] = entry
        return entry

    def write_ended(self, entry: dict, error: BaseException | None = None) -> None:
        entry["ended"] = time.monotonic()
        if error is None:
            self.totals["writes"] += 1
            self.totals["written"] += entry["size"]
        else:
            entry["error"] = str(error) if isinstance(error, ValueError) else type(error).__name__
        if self.writes.get(entry["part"]) is entry:
            self.writes.pop(entry["part"])
        self.recent_writes.append(entry)

    def snapshot(self) -> dict:
        now = time.monotonic()

        def ago(value):
            return None if value is None else round(now - value, 1)

        def connection(item: Connection) -> dict:
            return {"id": item.id, "range": item.range, "phase": item.phase, "status": item.status, "received": item.received,
                    "size": item.size, "elapsed": round((item.ended or now) - item.started, 1),
                    "wait": None if item.first_byte is None and item.ended else round((item.first_byte or now) - item.started, 1),
                    "first_byte": item.first_byte is not None, "idle": ago(item.last_data or item.responded or item.started),
                    "error": item.error}

        def write(item: dict) -> dict:
            return {"part": item["part"], "size": item["size"], "elapsed": round((item["ended"] or now) - item["started"], 1),
                    "done": item["ended"] is not None, "error": item["error"]}

        return {"phase": self.phase, "elapsed": round(now - self.started, 1), "totals": dict(self.totals),
                "connections": [connection(item) for item in sorted(self.connections.values(), key=lambda c: c.id)],
                "recent": [connection(item) for item in reversed(self.recent)],
                "writes": [write(item) for item in sorted(self.writes.values(), key=lambda w: w["part"])],
                "recent_writes": [write(item) for item in reversed(self.recent_writes)]}
