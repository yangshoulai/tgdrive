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
            "transfer_concurrency": 8, "bucket_concurrency": 6,
            "upload_concurrency": 4, "upload_kib": 0, "bot_interval_ms": 1000,
            "web_part_concurrency": 4, "web_file_concurrency": 2, "thumbnail_concurrency": 16,
            "download_memory_percent": 60, "video_concurrency": 2, "thumbnail_cache_mib": 1024,
            "download_connections": 4, "parse_concurrency": 6, "diagnostics": True,
            # 文件校验（巡检）每天最多读取的已存数据量，0 关闭自动校验；Telegram 机器人「发回」文件的大小上限
            # （文件整读进内存后发送；官方 Bot API 另有 50 MB 上限，见 telegram/bot.py 的 _send_limit）。
            "scrub_daily_mib": 2048, "telegram_send_mib": 200}
# 写入存储（Telegram 发送）的每个在途分片约占明文与密文两份内存。
UPLOAD_MEMORY = 32 * MIB
# 文件读取并发（下载、预览、播放、本机缓存、S3 读取共用）：每路约占 (预读窗口数 + 1) × 8 MB 内存。
TRANSFER_MEMORY = 24 * MIB
# 每个离线下载任务按约 64 MB 估算：实测直链任务正在写入时约 48 MB、排队等待写入时约 16–20 MB，
# 视频转封装还要暂留开头 16 MB 与样本表，另留分配器余量。任务总数最多占检测内存的 download_memory_percent（默认 60%）。
DOWNLOAD_MEMORY = 64 * MIB
# 多连接下载时每多一个连接，任务多暂存一段：实测每个连接约 30 MB（读完的 16 MiB 一段在等待写入或加密时还有一份副本），
# 4 个连接的直链任务峰值约 115–163 MB。
CONNECTION_MEMORY = 32 * MIB
DOWNLOAD_MAX = 16
# 1.38 之前的读取并发默认值；仍保存着这组值的配置在升级后改用新默认值（见 ResourceSettings.config）。
LEGACY_READ_DEFAULTS = (4, 2)
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
    READ_UPGRADE_KEY = "offline.resources.read_defaults"

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
        for key, low, high in (("concurrency", 1, DOWNLOAD_MAX), ("bandwidth_kib", 0, 1048576), ("reserve_mib", 128, 1048576)):
            if type(merged[key]) is not int or not low <= merged[key] <= high:
                raise ValueError(f"并发须为 1–{DOWNLOAD_MAX}，限速须非负，磁盘保留空间至少为 128 MiB")
        for key in ("hls_enabled", "x_enabled", "youtube_enabled", "diagnostics"):
            if type(merged[key]) is not bool:
                raise ValueError("下载能力开关必须为布尔值")
        if type(merged["youtube_max_height"]) is not int or merged["youtube_max_height"] not in (360, 480, 720, 1080, 2160):
            raise ValueError("YouTube 清晰度上限不正确")
        if type(merged["platform_max_mib"]) is not int or not 16 <= merged["platform_max_mib"] <= 8192:
            raise ValueError("平台临时缓存预算须为 16–8192 MiB")
        for key, high in (("transfer_concurrency", 32), ("bucket_concurrency", 32)):
            if type(merged[key]) is not int or not 1 <= merged[key] <= high:
                raise ValueError("文件读取并发须为 1–32")
        if merged["bucket_concurrency"] > merged["transfer_concurrency"]:
            raise ValueError("每个账号的读取并发不能超过服务器总数")
        for key, low, high, message in (("upload_concurrency", 1, 32, "同时写入存储的分片数须为 1–32"),
                                        ("upload_kib", 0, 1048576, "上传限速须为 0–1048576 KiB/s"),
                                        ("bot_interval_ms", 0, 10000, "Bot 发送间隔须为 0–10000 毫秒"),
                                        ("web_part_concurrency", 1, 16, "网页单个文件的分段并发须为 1–16"),
                                        ("web_file_concurrency", 1, 8, "网页同时上传的文件数须为 1–8"),
                                        ("thumbnail_concurrency", 1, 32, "封面读取并发须为 1–32"),
                                        ("download_memory_percent", 10, 80, "离线下载可用内存须为检测内存的 10%–80%"),
                                        ("video_concurrency", 1, 4, "同时封装的视频数须为 1–4"),
                                        ("thumbnail_cache_mib", 128, 8192, "封面缓存上限须为 128–8192 MiB"),
                                        ("download_connections", 1, 8, "单个任务的连接数须为 1–8"),
                                        ("parse_concurrency", 1, 16, "同时解析的链接数须为 1–16"),
                                        ("scrub_daily_mib", 0, 1048576, "文件校验每日读取量须为 0–1048576 MiB（0 为关闭）"),
                                        ("telegram_send_mib", 1, 2000, "机器人发回文件上限须为 1–2000 MiB")):
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
            stored = json.loads(row[0]) if row else None
            if stored is not None and not self.metadata.db.execute("SELECT 1 FROM settings WHERE key=?", (self.READ_UPGRADE_KEY,)).fetchone():
                # 一次性升级：仍是旧默认值（每账号 2 路）的配置改用新默认值；管理员改过的值保持不变。
                if (stored.get("transfer_concurrency", 4), stored.get("bucket_concurrency", 2)) == LEGACY_READ_DEFAULTS:
                    stored.update(transfer_concurrency=self.defaults["transfer_concurrency"], bucket_concurrency=self.defaults["bucket_concurrency"])
                with self.metadata.transaction() as db:
                    db.execute("UPDATE settings SET value=? WHERE key=?", (json.dumps(self.validate({**self.defaults, **stored}), separators=(",", ":")), self.KEY))
                    db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (self.READ_UPGRADE_KEY, "1"))
            self._config = self.validate({**self.defaults, **stored}) if stored is not None else dict(self.defaults)
        return dict(self._config)

    def effective(self):
        config = self.config()
        cpu, memory = self.detected["cpu_cores"], self.detected["memory_bytes"]
        low = cpu < 2 or memory is None or memory < 1024 * MIB
        mode = ("low" if low else "standard") if config["mode"] == "auto" else config["mode"]
        # 个人部署通常只有一两个人在用：低资源档按内存放宽并行，只在内存很小或未知时保守处理。
        roomy = bool(memory and memory >= 512 * MIB)
        # 低资源机器的离线下载上限按内存分档：≥640 MiB 4 个、512–640 MiB 3 个、更小 2 个，检测不到内存时 1 个；
        # 「自动」档默认取其中较稳妥的值（最多 3 个），管理员选「自定义」可以用满上限。
        low_ceiling = (4 if memory >= 640 * MIB else 3 if roomy else 2) if memory else 1
        desired = config["concurrency"] if mode == "custom" else min(3, low_ceiling) if mode == "low" else 2
        # 离线下载主要在等网络，CPU 只用于加密与 TLS（视频封装也只复制音视频数据、不转码），所以上限只看内存、不看核数：
        # 内存 1 GiB 以上按每个任务约 64 MB、最多占内存的 download_memory_percent 封顶（默认 60%：1 GiB 9 个、2 GiB 起 16 个）；
        # 不足 1 GiB 或无法检测时沿用 low_ceiling 的保守分档。
        small = not memory or memory < 1024 * MIB
        # 单个任务的连接数：内存不足 1 GiB 时最多 2 个；每多一个连接，任务的内存估算增加 CONNECTION_MEMORY。
        connections = min(config["download_connections"], 2) if small else config["download_connections"]
        per_task = DOWNLOAD_MEMORY + (connections - 1) * CONNECTION_MEMORY
        ceiling = low_ceiling if small else min(DOWNLOAD_MAX, max(1, memory * config["download_memory_percent"] // 100 // per_task))
        # 平台临时缓存放在数据目录的磁盘上（分离的音视频轨合并前暂存），与 CPU 核数和内存无关，按管理员设置生效；
        # 磁盘是否够用由合并时的剩余空间检查（reserve_mib）保证。
        platform_limit = config["platform_max_mib"]
        low_parallel = 8 if roomy else 3
        # 文件读取每路约 24 MB，最多占检测内存的三分之一；每个账号可以用满全部读取名额（低资源档不再减半）。
        # 读取主要在等 Telegram 的网络，CPU 只用于解密（单核每秒数百 MB），所以和离线下载一样不看核数：
        # 「自动」因核数少选了低资源档时读取只按内存收紧，内存不足 512 MiB 或无法检测才压到 3 路；
        # 管理员明确选择「低资源」时仍按该档封顶（最多 8 路）。管理员设得更低时不主动抬高。
        transfer = config["transfer_concurrency"]
        if mode == "low" and (not roomy or config["mode"] == "low"):
            transfer = min(transfer, low_parallel)
        if memory:
            transfer = min(transfer, max(2, memory // 3 // TRANSFER_MEMORY))
        bucket = min(config["bucket_concurrency"], transfer)
        # 写入分片每路约 32 MB，最多占检测内存的三分之一；低资源下网页分段同步受此预算限制。
        upload = config["upload_concurrency"]
        upload_budget = max(1, memory // 3 // UPLOAD_MEMORY) if memory else 16
        if mode == "low":
            upload = min(upload, low_parallel)
        upload = min(upload, upload_budget)
        web_parts = min(config["web_part_concurrency"], low_parallel, upload_budget) if mode == "low" else config["web_part_concurrency"]
        # 缩略图每路读取不到 1 MB，只在内存很小或未知的低资源机器上收紧。
        thumbnails = min(config["thumbnail_concurrency"], low_parallel) if mode == "low" and not roomy else config["thumbnail_concurrency"]
        concurrency = min(desired, ceiling)
        # 同时封装的视频（M3U8 与 YouTube，FFmpeg 复制音视频数据、不转码）：每个另有一个 FFmpeg 进程，YouTube 分离轨
        # 还各占「平台临时缓存上限」的磁盘；内存不足 1 GiB 或无法检测时只允许 1 个，且不超过同时下载的任务数。
        video = 1 if small else max(1, min(config["video_concurrency"], concurrency))
        return {**config, "mode": mode, "concurrency": concurrency, "ffmpeg_concurrency": video, "video_concurrency": video,
                "download_connections": connections, "task_memory_bytes": per_task,
                "transfer_concurrency": transfer, "bucket_concurrency": bucket,
                "upload_concurrency": upload, "web_part_concurrency": web_parts, "thumbnail_concurrency": thumbnails,
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
        self._memory_pressure = any(used > limit * memory_threshold for used, limit in self._cgroup_memory())
        if self._memory_pressure:
            return "容器内存紧张，等待释放内存"
        return None

    def _cgroup_memory(self):
        """逐个 cgroup 给出（已用、上限）；配额和用量必须取同一 cgroup，读不到的跳过。"""
        for filename in self.detected["memory_usage_paths"]:
            path = Path(filename)
            used = _positive(_text(path))
            limit = _positive(_text(path.with_name("memory.max" if path.name == "memory.current" else "memory.limit_in_bytes")))
            # 顺序写入临时轨会增加可回收的文件缓存，不能把它当作解析器常驻内存而反复重下载。
            stats = dict(line.split() for line in _text(path.with_name("memory.stat")).splitlines() if len(line.split()) == 2)
            reclaimable = _positive(stats.get("inactive_file" if path.name == "memory.current" else "total_inactive_file", "")) or 0
            if used and limit:
                yield max(0, used - reclaimable), limit

    def available_memory(self) -> int | None:
        """此刻还能使用的内存：系统 MemAvailable 与各 cgroup 剩余额度取最小值；都读不到（非 Linux）时返回 None。"""
        values = [max(0, limit - used) for used, limit in self._cgroup_memory()]
        for line in _text(Path("/proc/meminfo")).splitlines():
            if line.startswith("MemAvailable:"):
                values.append(int(line.split()[1]) * 1024)
        return min(values) if values else None

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
