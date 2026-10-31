"""侧栏「收藏」：用户固定在侧栏的常用文件夹（类似 Finder 的个人收藏），按存储桶保存在 settings 表。

每项是文件夹的完整键（以 / 结尾）加可选的图标名：普通文件夹如 ``照片/2024/``，私密空间的文件夹以 ``.tgdrive/private/`` 开头。
图标只是界面里的名称（如 ``audio``、``film``），服务端只校验格式，前端不认识的名称按默认文件夹图标显示。
旧版本只存路径字符串，读取时兼容。
私密收藏只在当前登录会话已解锁时返回；锁定时保存的列表不包含它们，服务端按原位置把它们放回去，不会丢失。
文件夹被移动或改名时由 ``ObjectService.move`` 在同一事务里调用 :func:`moved` 改写；移入回收站或系统区时移除。
"""

from __future__ import annotations

import json
import re

LIMIT = 50
PRIVATE_PREFIX = ".tgdrive/private/"
_ICON = re.compile(r"[a-zA-Z][a-zA-Z0-9]{0,23}")

Entry = dict  # {"path": str, "icon": str | None}


def setting_key(bucket_id: int) -> str:
    return f"favorites.{bucket_id}"


def is_private(path: str) -> bool:
    return path.startswith(PRIVATE_PREFIX)


def _allowed(path: str) -> bool:
    """收藏只能指向普通文件夹或私密空间里的文件夹（不含两个根目录本身，它们已在侧栏里）。"""
    if not path.endswith("/") or path == PRIVATE_PREFIX:
        return False
    return is_private(path) or not path.startswith(".tgdrive/")


def icon_name(value: object) -> str | None:
    """图标名：空值表示默认文件夹图标；格式不对时报错（400）。"""
    if value in (None, "", "folder"):
        return None
    if not isinstance(value, str) or not _ICON.fullmatch(value):
        raise ValueError("收藏的图标不正确")
    return value


def _entry(value: object) -> Entry | None:
    if isinstance(value, str):
        return {"path": value, "icon": None} if _allowed(value) else None
    if isinstance(value, dict) and isinstance(value.get("path"), str) and _allowed(value["path"]):
        icon = value.get("icon")
        return {"path": value["path"], "icon": icon if isinstance(icon, str) and _ICON.fullmatch(icon) else None}
    return None


def load(db, bucket_id: int) -> list[Entry]:
    row = db.execute("SELECT value FROM settings WHERE key=?", (setting_key(bucket_id),)).fetchone()
    if row is None:
        return []
    try:
        value = json.loads(row["value"])
    except (TypeError, ValueError):
        return []
    if not isinstance(value, list):
        return []
    entries = [entry for entry in map(_entry, value) if entry is not None]
    return entries[:LIMIT]


def store(db, bucket_id: int, entries: list[Entry]) -> None:
    if entries:
        value = [{"path": entry["path"], **({"icon": entry["icon"]} if entry.get("icon") else {})} for entry in entries[:LIMIT]]
        db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (setting_key(bucket_id), json.dumps(value, ensure_ascii=False)))
    else:
        db.execute("DELETE FROM settings WHERE key=?", (setting_key(bucket_id),))


def merge_hidden(current: list[Entry], given: list[Entry], hidden: set[str]) -> list[Entry]:
    """锁定时客户端看不到私密收藏：把它们按原来的位置插回客户端提交的新顺序里（同一路径只保留第一项）。"""
    result: list[Entry] = []
    seen: set[str] = set()
    for entry in given:
        if entry["path"] not in hidden and entry["path"] not in seen:
            seen.add(entry["path"])
            result.append(entry)
    for index, entry in enumerate(current):
        if entry["path"] in hidden and entry["path"] not in seen:
            seen.add(entry["path"])
            result.insert(min(index, len(result)), entry)
    return result[:LIMIT]


def moved(db, bucket_id: int, old: str, new: str) -> None:
    """文件夹 old 移动到 new：改写以它开头的收藏（图标保留）；移入回收站等系统区时移除，同一位置只保留一项。"""
    current = load(db, bucket_id)
    if not any(entry["path"].startswith(old) for entry in current):
        return
    updated: list[Entry] = []
    for entry in current:
        path = entry["path"]
        target = new + path[len(old):] if path.startswith(old) else path
        if _allowed(target) and all(item["path"] != target for item in updated):
            updated.append({**entry, "path": target})
    store(db, bucket_id, updated)
