"""助手的全局设置、Agent 循环上限、工具配置与用户策略。

全局设置存在 settings 表的 `assistant.*` 键里（值为 JSON）；用户策略在 ai_user_policy。所有数值都有服务端硬上限，
管理员只能在硬上限之内调整（docs/assistant-design.md §3.3、§5）。
"""

from __future__ import annotations

import json
import threading
import time

from ..metadata import Metadata

ACTION_TTL = 24 * 60 * 60
HTTP_APPROVAL_TIMEOUT = 30 * 60

# 名称: (默认值, 最小值, 硬上限, 说明)
LIMITS: dict[str, tuple[int, int, int, str]] = {
    "max_steps": (40, 1, 2000, "每轮模型调用次数"),
    "max_tool_calls": (150, 1, 20_000, "每轮工具调用总数"),
    "parallel_calls": (8, 1, 128, "同时执行的工具调用数"),
    "repeat_threshold": (4, 2, 200, "相同工具与参数的重复调用次数"),
    "error_threshold": (8, 1, 500, "连续工具错误次数"),
    "run_seconds": (900, 30, 86_400, "每轮执行时间（不含人工审批，秒）"),
    "tool_seconds": (60, 5, 7200, "单个工具超时（不含人工审批，秒）"),
    "tool_result_bytes": (4 * 1024 * 1024, 2048, 128 * 1024 * 1024, "单个工具结果长度（字节）"),
    "run_tokens": (4_000_000, 0, 1_000_000_000, "每轮累计 token 预算（0 为不限）"),
    "user_concurrency": (1, 1, 32, "每用户同时进行的对话"),
    "global_concurrency": (4, 1, 256, "全站同时进行的对话"),
    "user_messages_per_minute": (10, 1, 600, "每用户每分钟消息数"),
    "max_conversations": (1000, 10, 100_000, "每用户最多保留的对话数"),
    "action_items": (10000, 100, 100_000, "单个待确认操作最多条目数"),
    "download_urls": (2000, 32, 50_000, "单次下载提议最多链接数"),
    "message_images": (6, 1, 10, "每条消息随附给识图模型的图片数"),
}

SETTINGS: dict[str, tuple[int, int, int]] = {
    "user_daily_tokens": (10_000_000, 0, 10_000_000_000),  # 0 表示不限
    "retention_days": (365, 1, 3650),
    "call_log_days": (90, 1, 3650),
}

DEFAULT_NOTICE = ("文件助手会把你的文件名、目录结构，以及它读取的文本文件、打开的网页内容和图片（以预览图形式，仅限支持识图的模型）发送给管理员配置的模型服务，用来理解你的请求。\n\n"
                  "为了给出适合你设备的操作步骤，还会附带浏览器名称与版本、操作系统、语言、时区和当前站点地址。\n\n"
                  "HTTP 工具可访问任务所需的公共网页和第三方接口，支持跨站链接、查询参数、正文和认证。审批模式下带正文、认证或可能修改第三方数据的请求先确认；完全访问下常规请求自动发送，DELETE 始终确认。你提供的第三方凭据可能随对话交给模型，系统不会自动使用浏览器登录状态。\n\n"
                  "对话加密保存一段时间，管理员无法查看正文。修改文件按你选择的访问模式执行；完全访问下普通修改和下载任务自动执行，读取文件或网页不会改变此模式。公开分享、彻底删除和跨私密空间移动始终需要你确认。")

# 默认使用说明的修订时间：说明内容（发送哪些数据）变化时更新它，之前的确认记录失效，用户需重新阅读。
DEFAULT_NOTICE_SINCE = 1792418400.0  # 2026-10-19 14:00 UTC：联网范围与完全访问行为调整

# 私密对话（docs/assistant-design.md §24.4）的单独说明：首次在私密空间使用前确认，内容变化时更新 PRIVATE_NOTICE_SINCE。
PRIVATE_NOTICE = ("私密对话会把私密空间中的文件名、目录结构，以及助手读取的文本和图片发送给管理员允许用于私密对话的模型服务。\n\n"
                  "私密对话不保存：锁定私密空间、闲置自动锁定或服务重启后，对话会被清除；管理员看不到对话内容。\n\n"
                  "联网、分析网页和离线下载可访问任务所需的公共地址及跨站链接；HTTP 支持查询参数、正文和你提供的第三方认证。请求按所选访问模式执行，完全访问下常规请求与私密空间内的普通修改自动执行；彻底删除、跨区移动和 HTTP DELETE 仍需确认。把文件移出私密空间需要重新验证身份。")
PRIVATE_NOTICE_SINCE = 1792418400.0  # 2026-10-19 14:00 UTC：私密对话联网与访问模式调整

LEVELS = ("read", "write", "danger")


def _int(value, default: int, low: int, high: int, label: str) -> int:
    if value is None or value == "":
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f"{label}必须是整数")
    try:
        number = int(value)
    except ValueError as exc:
        raise ValueError(f"{label}必须是整数") from exc
    if not low <= number <= high:
        raise ValueError(f"{label}必须在 {low}–{high} 之间")
    return number


class AssistantConfig:
    """读写 `assistant.*` 设置。读取有进程内缓存，写入后立即失效。"""

    def __init__(self, metadata: Metadata) -> None:
        self.metadata = metadata
        self._cache: dict[str, object] | None = None
        self._lock = threading.Lock()

    def _stored(self) -> dict[str, object]:
        with self._lock:
            if self._cache is None:
                rows = self.metadata.db.execute("SELECT key,value FROM settings WHERE key LIKE 'assistant.%' AND key!='assistant.trace_key'")
                cache: dict[str, object] = {}
                for row in rows:
                    try:
                        cache[row["key"][len("assistant."):]] = json.loads(row["value"])
                    except ValueError:
                        continue
                self._cache = cache
            return self._cache

    def _write(self, values: dict[str, object]) -> None:
        with self.metadata.transaction() as db:
            for key, value in values.items():
                if value is None:
                    db.execute("DELETE FROM settings WHERE key=?", (f"assistant.{key}",))
                else:
                    db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                               (f"assistant.{key}", json.dumps(value, ensure_ascii=False, separators=(",", ":"))))
        with self._lock:
            self._cache = None

    def raw(self, name: str) -> object:
        """其他模块保存在 assistant.* 下的结构化状态（如模型目录设置）。"""
        return self._stored().get(name)

    def write_raw(self, name: str, value: object) -> None:
        self._write({name: value})

    # ---------- 全局设置 ----------

    @property
    def enabled(self) -> bool:
        return self._stored().get("enabled") is True

    @property
    def full_access_default(self) -> bool:
        """是否默认允许用户使用完全访问模式（用户策略可单独覆盖）。"""
        return self._stored().get("full_access") is True

    @property
    def private_default(self) -> bool:
        """是否默认允许用户在私密空间使用助手（私密对话，§24.4）；用户策略可单独覆盖。"""
        return self._stored().get("private") is True

    @property
    def default_model(self) -> int | None:
        value = self._stored().get("default_model")
        return value if isinstance(value, int) else None

    def setting(self, name: str) -> int:
        default, low, high = SETTINGS[name]
        value = self._stored().get(name)
        return value if isinstance(value, int) and low <= value <= high else default

    @property
    def notice(self) -> str:
        value = self._stored().get("notice")
        return value if isinstance(value, str) and value.strip() else DEFAULT_NOTICE

    @property
    def notice_since(self) -> float:
        """在这之前的确认不再有效：默认说明的修订时间与管理员最近一次修改说明的时间取较晚者。"""
        updated = self._stored().get("notice_updated_at")
        return max(DEFAULT_NOTICE_SINCE, float(updated) if isinstance(updated, (int, float)) and not isinstance(updated, bool) else 0.0)

    def describe_settings(self) -> dict[str, object]:
        return {"enabled": self.enabled, "default_model": self.default_model, "full_access": self.full_access_default,
                "private": self.private_default, "private_notice": PRIVATE_NOTICE,
                **{name: self.setting(name) for name in SETTINGS},
                "notice": self.notice, "notice_default": DEFAULT_NOTICE,
                "bounds": {name: {"default": d, "min": lo, "max": hi} for name, (d, lo, hi) in SETTINGS.items()}}

    def update_settings(self, payload: dict, *, model_exists) -> dict[str, object]:
        allowed = {"enabled", "default_model", "notice", "full_access", "private", *SETTINGS}
        unknown = set(payload) - allowed
        if unknown:
            raise ValueError(f"未知设置：{', '.join(sorted(unknown))}")
        values: dict[str, object] = {}
        if "default_model" in payload:
            model = payload["default_model"]
            if model is not None and (isinstance(model, bool) or not isinstance(model, int) or not model_exists(model)):
                raise ValueError("默认模型不存在或未启用")
            values["default_model"] = model
        for name, (default, low, high) in SETTINGS.items():
            if name in payload:
                values[name] = _int(payload[name], default, low, high, name)
        if "full_access" in payload:
            if not isinstance(payload["full_access"], bool):
                raise ValueError("full_access 必须是布尔值")
            values["full_access"] = payload["full_access"] or None
        if "private" in payload:
            if not isinstance(payload["private"], bool):
                raise ValueError("private 必须是布尔值")
            values["private"] = payload["private"] or None
        if "notice" in payload:
            notice = payload["notice"]
            if notice is not None and (not isinstance(notice, str) or len(notice) > 2000):
                raise ValueError("使用说明最多 2000 个字符")
            values["notice"] = notice.strip() if isinstance(notice, str) and notice.strip() else None
            if values["notice"] != self._stored().get("notice"):
                values["notice_updated_at"] = time.time()
        if "enabled" in payload:
            if not isinstance(payload["enabled"], bool):
                raise ValueError("enabled 必须是布尔值")
            target = values.get("default_model", self.default_model)
            if payload["enabled"] and (target is None or not model_exists(target)):
                raise ValueError("启用前请先设置一个可用的默认模型")
            values["enabled"] = payload["enabled"]
        self._write(values)
        return self.describe_settings()

    # ---------- 上限 ----------

    def limits(self) -> dict[str, int]:
        stored = self._stored().get("limits")
        stored = stored if isinstance(stored, dict) else {}
        result = {}
        for name, (default, low, high, _) in LIMITS.items():
            value = stored.get(name)
            result[name] = value if isinstance(value, int) and not isinstance(value, bool) and low <= value <= high else default
        return result

    def describe_limits(self) -> dict[str, object]:
        return {"values": self.limits(),
                "bounds": {name: {"default": d, "min": lo, "max": hi, "label": label} for name, (d, lo, hi, label) in LIMITS.items()}}

    def update_limits(self, payload: dict) -> dict[str, object]:
        # 兼容升级前已打开的控制台；历史消息条数不再限制对话容量。
        unknown = set(payload) - set(LIMITS) - {"max_messages"}
        if unknown:
            raise ValueError(f"未知上限：{', '.join(sorted(unknown))}")
        current = self.limits()
        for name, value in payload.items():
            if name == "max_messages":
                continue
            default, low, high, label = LIMITS[name]
            current[name] = _int(value, default, low, high, label)
        self._write({"limits": current})
        return self.describe_limits()

    # ---------- 工具配置 ----------

    def tool_settings(self) -> dict[str, dict]:
        stored = self._stored().get("tools")
        return stored if isinstance(stored, dict) else {}

    def save_tool_settings(self, value: dict[str, dict]) -> None:
        self._write({"tools": value})

    # ---------- 用户策略 ----------

    def policy(self, user_id: int) -> dict[str, object]:
        row = self.metadata.db.execute("SELECT * FROM ai_user_policy WHERE user_id=?", (user_id,)).fetchone()
        enabled = None if row is None or row["enabled"] is None else bool(row["enabled"])
        level = row["max_level"] if row is not None and row["max_level"] in LEVELS else None
        daily = row["daily_tokens"] if row is not None else None
        full = None if row is None or row["full_access"] is None else bool(row["full_access"])
        private = None if row is None or row["private"] is None else bool(row["private"])
        return {"enabled": enabled, "max_level": level, "daily_tokens": daily, "full_access": full, "private": private,
                "effective": {"enabled": enabled is not False, "max_level": level or "write",
                              "daily_tokens": self.setting("user_daily_tokens") if daily is None else daily,
                              "full_access": self.full_access_default if full is None else full,
                              "private": self.private_default if private is None else private},
                "notice_ack_at": row["notice_ack_at"] if row is not None and row["notice_ack_at"] is not None
                and row["notice_ack_at"] >= self.notice_since else None,
                "private_notice_ack_at": row["private_notice_ack_at"] if row is not None and row["private_notice_ack_at"] is not None
                and row["private_notice_ack_at"] >= PRIVATE_NOTICE_SINCE else None}

    def update_policy(self, user_id: int, payload: dict) -> dict[str, object]:
        unknown = set(payload) - {"enabled", "max_level", "daily_tokens", "full_access", "private"}
        if unknown:
            raise ValueError(f"未知字段：{', '.join(sorted(unknown))}")
        current = self.policy(user_id)
        enabled, level, daily, full = current["enabled"], current["max_level"], current["daily_tokens"], current["full_access"]
        private = current["private"]
        if "enabled" in payload:
            if payload["enabled"] is not None and not isinstance(payload["enabled"], bool):
                raise ValueError("enabled 只能是 true、false 或 null（跟随全局）")
            enabled = payload["enabled"]
        if "max_level" in payload:
            if payload["max_level"] is not None and payload["max_level"] not in LEVELS:
                raise ValueError("最高操作级别只能是 read、write 或 danger")
            level = payload["max_level"]
        if "daily_tokens" in payload:
            value = payload["daily_tokens"]
            _, low, high = SETTINGS["user_daily_tokens"]
            daily = None if value is None else _int(value, 0, low, high, "每日 token")
        if "full_access" in payload:
            if payload["full_access"] is not None and not isinstance(payload["full_access"], bool):
                raise ValueError("full_access 只能是 true、false 或 null（跟随全局）")
            full = payload["full_access"]
        if "private" in payload:
            if payload["private"] is not None and not isinstance(payload["private"], bool):
                raise ValueError("private 只能是 true、false 或 null（跟随全局）")
            private = payload["private"]
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO ai_user_policy(user_id,enabled,max_level,daily_tokens,full_access,private) VALUES(?,?,?,?,?,?) "
                       "ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,max_level=excluded.max_level,"
                       "daily_tokens=excluded.daily_tokens,full_access=excluded.full_access,private=excluded.private",
                       (user_id, None if enabled is None else int(enabled), level, daily, None if full is None else int(full),
                        None if private is None else int(private)))
        return self.policy(user_id)

    def acknowledge_notice(self, user_id: int, now: float) -> None:
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO ai_user_policy(user_id,notice_ack_at) VALUES(?,?) "
                       "ON CONFLICT(user_id) DO UPDATE SET notice_ack_at=excluded.notice_ack_at", (user_id, now))

    def acknowledge_private_notice(self, user_id: int, now: float) -> None:
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO ai_user_policy(user_id,private_notice_ack_at) VALUES(?,?) "
                       "ON CONFLICT(user_id) DO UPDATE SET private_notice_ack_at=excluded.private_notice_ack_at", (user_id, now))

    def purge_all(self) -> None:
        """清除所有助手数据时同时重置阅读说明记录，渠道与设置保留。"""
        with self.metadata.transaction() as db:
            db.execute("UPDATE ai_user_policy SET notice_ack_at=NULL, private_notice_ack_at=NULL")
