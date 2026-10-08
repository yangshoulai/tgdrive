"""进程内运行指标：只保存粗粒度的流量计数，不记录请求内容。"""

from __future__ import annotations

import threading
import time
from collections import deque


class TrafficMetrics:
    """记录最近一小时的请求字节数，服务重启后重新开始统计。"""

    def __init__(self, *, bucket_seconds: int = 60, buckets: int = 60) -> None:
        self.bucket_seconds = bucket_seconds
        self._buckets: deque[dict[str, int | float]] = deque(maxlen=buckets)
        self._lock = threading.Lock()
        self._total_in = 0
        self._total_out = 0

    def _bucket(self, now: float) -> dict[str, int | float]:
        start = now - (now % self.bucket_seconds)
        if not self._buckets or self._buckets[-1]["start"] != start:
            self._buckets.append({"start": start, "in": 0, "out": 0})
        return self._buckets[-1]

    def record_in(self, size: int) -> None:
        if size <= 0:
            return
        with self._lock:
            self._total_in += size
            bucket = self._bucket(time.time())
            bucket["in"] = int(bucket["in"]) + size

    def record_out(self, size: int) -> None:
        if size <= 0:
            return
        with self._lock:
            self._total_out += size
            bucket = self._bucket(time.time())
            bucket["out"] = int(bucket["out"]) + size

    def snapshot(self) -> dict[str, object]:
        now = time.time()
        with self._lock:
            # 补齐最近 60 分钟的分钟桶，前端可以直接绘制连续折线。
            current = int(now - (now % self.bucket_seconds))
            recent = list(self._buckets)
            by_start = {int(item["start"]): item for item in recent}
            points = [
                {"at": start, "in_bytes": int(by_start.get(start, {}).get("in", 0)),
                 "out_bytes": int(by_start.get(start, {}).get("out", 0))}
                for start in range(current - ((self._buckets.maxlen or 60) - 1) * self.bucket_seconds,
                                   current + self.bucket_seconds, self.bucket_seconds)
            ]
            return {"total_in_bytes": self._total_in, "total_out_bytes": self._total_out, "recent": points}
