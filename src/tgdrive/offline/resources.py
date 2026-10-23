"""启动时探测容器预算；管理员预设持久保存，运行中只做资源保护。"""

from __future__ import annotations

import datetime
import json
import os
import re
import shutil
from pathlib import Path

from urllib.parse import quote

from .http import proxy_parts
from .platforms import capabilities, tool_version


MIB = 1024 * 1024
DEFAULTS = {"mode": "auto", "concurrency": 1, "bandwidth_kib": 0,
            "reserve_mib": 512, "hls_enabled": False, "x_enabled": False, "youtube_enabled": False,
            "youtube_max_height": 2160, "platform_max_mib": 512, "proxy": "",
            "transfer_concurrency": 4, "bucket_concurrency": 2,
            "upload_concurrency": 4, "upload_kib": 0, "bot_interval_ms": 1000,
            "web_part_concurrency": 4, "web_file_concurrency": 2}
# 写入存储（Telegram 发送）的每个在途分片约占明文与密文两份内存。
UPLOAD_MEMORY = 32 * MIB
# 文件读取并发（下载、预览、播放、S3 读取共用）：每路约占 (预读窗口数 + 1) × 8 MB 内存。
TRANSFER_MEMORY = 24 * MIB
MASK = "******"


def normalize_proxy(value: str) -> str:
    if not value.strip():
        return ""
    scheme, host, port, user, password = proxy_parts(value.strip())
    credentials = f"{quote(user, safe='')}:{quote(password or '', safe='')}@" if user is not None else ""
    return f"{scheme}://{credentials}{f'[{host}]' if ':' in host else host}:{port}"


def mask_proxy(value: str) -> str:
    """管理端只回显代理用户名，密码用占位符代替；提交占位符表示保留原密码。"""
    if not value:
        return ""
    scheme, host, port, user, password = proxy_parts(value)
    credentials = f"{quote(user, safe='')}:{MASK}@" if user is not None and password else f"{quote(user, safe='')}@" if user is not None else ""
    return f"{scheme}://{credentials}{f'[{host}]' if ':' in host else host}:{port}"


def _text(path: Path) -> str:
    try:
        return path.read_text().strip()
    except (OSError, UnicodeError):
        return ""


def _positive(value: str) -> int | None:
    try:
        number = int(value)
        return number if 0 < number < 2**60 else None
    except ValueError:
        return None


def _cgroup_paths() -> list[Path]:
    roots = {Path("/sys/fs/cgroup"), Path("/sys/fs/cgroup/memory"), Path("/sys/fs/cgroup/cpu"), Path("/sys/fs/cgroup/cpu,cpuacct")}
    for line in _text(Path("/proc/self/cgroup")).splitlines():
        parts = line.split(":", 2)
        if len(parts) != 3 or ".." in Path(parts[2]).parts:
            continue
        for controller in {*parts[1].split(","), parts[1]}:
            root = Path("/sys/fs/cgroup") / controller if controller else Path("/sys/fs/cgroup")
            directory = root / parts[2].lstrip("/")
            if directory.is_dir():
                roots.add(directory)
                while directory != root and root in directory.parents:
                    directory = directory.parent
                    roots.add(directory)
    return sorted(roots)


def detect_resources() -> dict:
    memory = None
    try:
        memory = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError, AttributeError):
        pass
    try:
        cpus = float(len(os.sched_getaffinity(0)))
    except AttributeError:
        cpus = float(os.cpu_count() or 1)
    paths = _cgroup_paths()
    limits, usages = [], []
    for path in paths:
        for name in ("memory.max", "memory.limit_in_bytes"):
            limit = _positive(_text(path / name))
            if limit:
                limits.append(limit)
        for name in ("memory.current", "memory.usage_in_bytes"):
            if (path / name).is_file():
                usages.append(str(path / name))
        quota = _text(path / "cpu.max").split()
        if len(quota) != 2:
            quota = [_text(path / "cpu.cfs_quota_us"), _text(path / "cpu.cfs_period_us")]
        if len(quota) == 2 and _positive(quota[0]) and _positive(quota[1]):
            cpus = min(cpus, int(quota[0]) / int(quota[1]))
    if limits:
        memory = min([*limits, *([memory] if memory else [])])
    return {"cpu_cores": cpus, "memory_bytes": memory, "memory_usage_paths": usages,
            "memory_limits": limits, "container_limits": bool(limits or any(_text(path / "cpu.max") for path in paths))}


class ResourceSettings:
    KEY = "offline.resources"

    def __init__(self, metadata, data_dir: Path, defaults: dict | None = None):
        self.metadata, self.data_dir = metadata, data_dir
        self.defaults = self.validate({**DEFAULTS, **(defaults or {})})
        self.detected = detect_resources()
        self.ffmpeg = shutil.which("ffmpeg")
        self.platform_tools = capabilities()
        self.platform_tools["versions"]["ffmpeg"] = tool_version(self.ffmpeg)
        self._config = None
        self.on_change = None
        self._disk_pressure = self._memory_pressure = False

    @staticmethod
    def validate(value: dict) -> dict:
        if not isinstance(value, dict) or set(value) - set(DEFAULTS):
            raise ValueError("下载资源配置包含未知参数")
        merged = {**DEFAULTS, **value}
        # 1.13 起「标准」并入「自动」：旧配置、启动参数与接口里的 standard 一律按 auto 处理（硬件足够时自动就是标准档）。
        if merged["mode"] == "standard":
            merged["mode"] = "auto"
        if merged["mode"] not in ("auto", "low", "custom"):
            raise ValueError("资源模式不正确")
        for key, low, high in (("concurrency", 1, 4), ("bandwidth_kib", 0, 1048576), ("reserve_mib", 128, 1048576)):
            if type(merged[key]) is not int or not low <= merged[key] <= high:
                raise ValueError("并发须为 1–4，限速须非负，磁盘保留空间至少为 128 MiB")
        for key in ("hls_enabled", "x_enabled", "youtube_enabled"):
            if type(merged[key]) is not bool:
                raise ValueError("下载能力开关必须为布尔值")
        if type(merged["youtube_max_height"]) is not int or merged["youtube_max_height"] not in (360, 480, 720, 1080, 2160):
            raise ValueError("YouTube 清晰度上限不正确")
        if type(merged["platform_max_mib"]) is not int or not 16 <= merged["platform_max_mib"] <= 8192:
            raise ValueError("平台临时缓存预算须为 16–8192 MiB")
        for key, high in (("transfer_concurrency", 16), ("bucket_concurrency", 16)):
            if type(merged[key]) is not int or not 1 <= merged[key] <= high:
                raise ValueError("文件读取并发须为 1–16")
        if merged["bucket_concurrency"] > merged["transfer_concurrency"]:
            raise ValueError("每个账号的读取并发不能超过服务器总数")
        for key, low, high, message in (("upload_concurrency", 1, 16, "同时写入存储的分片数须为 1–16"),
                                        ("upload_kib", 0, 1048576, "上传限速须为 0–1048576 KiB/s"),
                                        ("bot_interval_ms", 0, 10000, "Bot 发送间隔须为 0–10000 毫秒"),
                                        ("web_part_concurrency", 1, 8, "网页单个文件的分段并发须为 1–8"),
                                        ("web_file_concurrency", 1, 4, "网页同时上传的文件数须为 1–4")):
            if type(merged[key]) is not int or not low <= merged[key] <= high:
                raise ValueError(message)
        if not isinstance(merged["proxy"], str):
            raise ValueError("下载代理地址格式不正确")
        merged["proxy"] = normalize_proxy(merged["proxy"])
        return merged

    def config(self):
        if self._config is None:
            row = self.metadata.db.execute("SELECT value FROM settings WHERE key=?", (self.KEY,)).fetchone()
            # 旧版保存的配置没有后来新增的项，用启动参数补齐，而不是模块默认值。
            self._config = self.validate({**self.defaults, **json.loads(row[0])}) if row else dict(self.defaults)
        return dict(self._config)

    def effective(self):
        config = self.config()
        cpu, memory = self.detected["cpu_cores"], self.detected["memory_bytes"]
        low = cpu < 2 or memory is None or memory < 1024 * MIB
        mode = ("low" if low else "standard") if config["mode"] == "auto" else config["mode"]
        desired = config["concurrency"] if mode == "custom" else (1 if mode == "low" else 2)
        ceiling = 1 if low else min(4, max(1, int(memory / (256 * MIB)) - 2))
        platform_limit = min(config["platform_max_mib"], 512) if low or mode == "low" else config["platform_max_mib"]
        # 小型个人部署允许适度并行；不足 512 MiB 或内存未知时保留原先的保守限制。
        low_parallel = 4 if memory and memory >= 512 * MIB else 2
        # 文件读取每路约 24 MB，最多占检测内存的四分之一；管理员设得更低时不主动抬高。
        transfer = config["transfer_concurrency"]
        if mode == "low":
            transfer = min(transfer, low_parallel)
        if memory:
            transfer = min(transfer, max(2, memory // 4 // TRANSFER_MEMORY))
        bucket = min(config["bucket_concurrency"], transfer, low_parallel // 2 if mode == "low" else 16)
        # 写入分片每路约 32 MB；低资源下网页分段同步受此预算限制，避免小容器额外缓冲太多请求。
        upload = config["upload_concurrency"]
        upload_budget = max(1, memory // 4 // UPLOAD_MEMORY) if memory else 16
        if mode == "low":
            upload = min(upload, low_parallel)
        upload = min(upload, upload_budget)
        web_parts = min(config["web_part_concurrency"], low_parallel, upload_budget) if mode == "low" else config["web_part_concurrency"]
        return {**config, "mode": mode, "concurrency": min(desired, ceiling), "ffmpeg_concurrency": 1,
                "transfer_concurrency": transfer, "bucket_concurrency": bucket,
                "upload_concurrency": upload, "web_part_concurrency": web_parts,
                "upload_reduced": (upload, web_parts) != (config["upload_concurrency"], config["web_part_concurrency"]),
                "transfer_reduced": (transfer, bucket) != (config["transfer_concurrency"], config["bucket_concurrency"]),
                "streaming": True, "cache_mib": platform_limit if config["youtube_enabled"] else 0,
                "platform_max_mib": platform_limit,
                "youtube_max_height": config["youtube_max_height"],
                "x_available": self.platform_tools["x_available"],
                "youtube_available": self.platform_tools["youtube_available"] and bool(self.ffmpeg),
                "hls_available": bool(self.ffmpeg), "reduced": desired > ceiling}

    def pressure(self) -> str | None:
        config = self.effective()
        try:
            free = shutil.disk_usage(self.data_dir).free
        except OSError:
            return "无法读取数据目录的磁盘空间"
        disk_threshold = config["reserve_mib"] * MIB + (64 if self._disk_pressure else 32) * MIB
        self._disk_pressure = free < disk_threshold
        if self._disk_pressure:
            return "磁盘剩余空间不足，等待释放空间"
        # 配额和用量必须取同一 cgroup；不能拿父级的用量和子级的限额交叉比较。
        memory_threshold = 0.8 if self._memory_pressure else 0.9
        self._memory_pressure = False
        for filename in self.detected["memory_usage_paths"]:
            path = Path(filename)
            used = _positive(_text(path))
            limit = _positive(_text(path.with_name("memory.max" if path.name == "memory.current" else "memory.limit_in_bytes")))
            # 顺序写入临时轨会增加可回收的文件缓存，不能把它当作解析器常驻内存而反复重下载。
            stats = dict(line.split() for line in _text(path.with_name("memory.stat")).splitlines() if len(line.split()) == 2)
            reclaimable = _positive(stats.get("inactive_file" if path.name == "memory.current" else "total_inactive_file", "")) or 0
            if used:
                used = max(0, used - reclaimable)
            if used and limit and used > limit * memory_threshold:
                self._memory_pressure = True
        if self._memory_pressure:
            return "容器内存紧张，等待释放内存"
        return None

    def describe(self):
        detected = {key: value for key, value in self.detected.items() if key not in ("memory_usage_paths", "memory_limits")}
        try:
            disk = shutil.disk_usage(self.data_dir)
            detected.update(disk_total_bytes=disk.total, disk_free_bytes=disk.free)
        except OSError:
            detected.update(disk_total_bytes=None, disk_free_bytes=None)
        stored = self.metadata.db.execute("SELECT 1 FROM settings WHERE key=?", (self.KEY,)).fetchone()
        config, effective = self.config(), self.effective()
        config["proxy"] = effective["proxy"] = mask_proxy(config["proxy"])
        return {"config": config, "effective": effective, "detected": detected,
                "components": self.components(),
                "source": "admin" if stored else "startup", "pressure": self.pressure()}

    def components(self):
        """组件版本与更新提示；yt-dlp 的版本号即发布日期，平台改版后旧版本常常无法解析。"""
        versions = dict(self.platform_tools.get("versions") or {})
        stale_days = None
        match = re.fullmatch(r"(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.\d+)?", versions.get("yt-dlp") or "")
        if match:
            try:
                stale_days = (datetime.date.today() - datetime.date(int(match[1]), int(match[2]), int(match[3]))).days
            except ValueError:
                stale_days = None
        return {"versions": versions, "ytdlp_age_days": stale_days}

    def update(self, value):
        if not isinstance(value, dict):
            raise ValueError("下载资源配置必须为对象")
        current = self.config()
        if value.get("proxy") and value["proxy"] == mask_proxy(current["proxy"]):
            value = {**value, "proxy": current["proxy"]}
        config = self.validate({**current, **value})
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (self.KEY, json.dumps(config, separators=(",", ":"))))
        self._config = config
        if self.on_change:
            self.on_change(self.effective())
        return self.describe()
