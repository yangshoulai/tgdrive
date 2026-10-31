"""侧栏「收藏」：用户固定在侧栏的常用文件夹（类似 Finder 的个人收藏），按存储桶保存在 settings 表。

每项是文件夹的完整键（以 / 结尾）：普通文件夹如 ``照片/2024/``，私密空间的文件夹以 ``.tgdrive/private/`` 开头。
私密收藏只在当前登录会话已解锁时返回；锁定时保存的列表不包含它们，服务端按原位置把它们放回去，不会丢失。
文件夹被移动或改名时由 ``ObjectService.move`` 在同一事务里调用 :func:`moved` 改写；移入回收站或系统区时移除。
"""

from __future__ import annotations

import json

LIMIT = 50
PRIVATE_PREFIX = ".tgdrive/private/"


def setting_key(bucket_id: int) -> str:
    return f"favorites.{bucket_id}"


def is_private(path: str) -> bool:
    return path.startswith(PRIVATE_PREFIX)


def _allowed(path: str) -> bool:
    """收藏只能指向普通文件夹或私密空间里的文件夹（不含两个根目录本身，它们已在侧栏里）。"""
    if not path.endswith("/") or path == PRIVATE_PREFIX:
        return False
    return is_private(path) or not path.startswith(".tgdrive/")


def load(db, bucket_id: int) -> list[str]:
    row = db.execute("SELECT value FROM settings WHERE key=?", (setting_key(bucket_id),)).fetchone()
    if row is None:
        return []
    try:
        value = json.loads(row["value"])
    except (TypeError, ValueError):
        return []
    return [item for item in value if isinstance(item, str) and _allowed(item)][:LIMIT] if isinstance(value, list) else []


def store(db, bucket_id: int, paths: list[str]) -> None:
    if paths:
        db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (setting_key(bucket_id), json.dumps(paths[:LIMIT], ensure_ascii=False)))
    else:
        db.execute("DELETE FROM settings WHERE key=?", (setting_key(bucket_id),))


def merge_hidden(current: list[str], given: list[str], hidden: set[str]) -> list[str]:
    """锁定时客户端看不到私密收藏：把它们按原来的位置插回客户端提交的新顺序里。"""
    result = [path for path in dict.fromkeys(given) if path not in hidden]
    for index, path in enumerate(current):
        if path in hidden and path not in result:
            result.insert(min(index, len(result)), path)
    return result[:LIMIT]


def moved(db, bucket_id: int, old: str, new: str) -> None:
    """文件夹 old 移动到 new：改写以它开头的收藏；移入回收站等系统区时移除，同一位置只保留一项。"""
    current = load(db, bucket_id)
    if not any(path.startswith(old) for path in current):
        return
    updated: list[str] = []
    for path in current:
        target = new + path[len(old):] if path.startswith(old) else path
        if _allowed(target) and target not in updated:
            updated.append(target)
    store(db, bucket_id, updated)
