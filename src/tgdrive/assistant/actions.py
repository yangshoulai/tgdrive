"""待确认操作的执行与撤销（docs/assistant-design.md §4.3、§8）。

提议工具在生成操作时已把规则展开成具体条目并记录对象版本（冻结）；这里只在用户确认后逐项执行：
- 每项执行前复核：源仍存在、版本（etag）未变、仍在冻结时的作用域内、不在 .tgdrive/；不满足的跳过并计入结果。
- 按批执行，批间让出事件循环；用户可随时取消，已执行的部分保留。
- 改名、移动、整理、新建文件夹、移入回收站记录撤销数据，24 小时内可撤销（同样复核版本）。
- 私密空间（§37）：私密区域的操作冻结时的作用域是私密空间前缀，执行用带 private_access 与授权复核的作用域；
  移出（move_out）与移入（move_in）是仅有的跨区操作，目标目录在确认时决定，不可撤销。
"""

from __future__ import annotations

import asyncio
import collections
import hashlib
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from ..errors import NotFoundError, QuotaExceededError, VersionConflict
from ..objects import PRIVATE_PREFIX, ObjectService, Scope
from ..offline.request import filename
from ..offline.service import MAX_CREATE_ITEMS, task_path
from .config import LIMITS

BATCH = 500
# 下载提议内部按小批写入并让出事件循环，兼顾入队吞吐、进度与取消响应；不作为模型的提议上限。
DOWNLOAD_BATCH = min(128, MAX_CREATE_ITEMS)
END = "\U0010ffff"
KINDS = {
    "rename": "批量改名", "move": "移动", "organize": "整理文件", "mkdir": "新建文件夹", "trash": "移入回收站",
    "restore": "从回收站恢复", "purge": "彻底删除", "unshare": "取消公开", "share": "公开分享", "downloads": "离线下载",
    "download_control": "下载任务操作", "save_attachment": "保存附件", "move_out": "移出私密空间", "move_in": "移入私密空间",
    "media": "获取封面、歌词与字幕", "text": "编辑文本文件", "copy": "复制", "extract": "解压", "compress": "压缩",
}
MEDIA_LABELS = {"cover": "封面", "lyrics": "歌词", "subtitle": "字幕"}
MOVE_KINDS = ("rename", "move", "organize")
DANGER_KINDS = ("purge",)
# 完全访问模式下仍然必须由用户确认的类型：不可恢复，或会让数据对外可见；跨区移动的目标由用户在卡片上决定。
CONFIRM_KINDS = ("purge", "share", "move_out", "move_in")


def share_options(payload: dict, confirm: dict | None) -> dict[str, object]:
    """确认时用户在卡片中填写的分享设置：有效天数（覆盖提议值）与访问密码（不经过模型，也不写入操作记录）。"""
    confirm = confirm or {}
    options = payload.get("options") or {}
    days = confirm.get("expires_days", options.get("expires_days"))
    if days is not None and (isinstance(days, bool) or not isinstance(days, int) or not 0 <= days <= 365):
        raise ValueError("有效天数必须在 0–365 之间（0 表示永久）")
    password = confirm.get("password")
    if password is not None and (not isinstance(password, str) or (password and not 4 <= len(password) <= 128)):
        raise ValueError("访问密码需要 4–128 个字符")
    result: dict[str, object] = {"expires_at": time.time() + days * 86400 if days else None}
    if password:
        result["password"] = password
    return result


def media_choices(payload: dict, confirm: dict | None) -> list[int | None]:
    """媒体条目各自选中的候选：用户在卡片上的选择（编号或 null＝保留现有）优先；没有选择时
    自动执行取推荐项（best），确认执行取卡片默认值（choice，已有数据时为保留现有）。"""
    given = (confirm or {}).get("choices")
    if given is not None and not isinstance(given, dict):
        raise ValueError("选择不正确")
    result: list[int | None] = []
    for index, item in enumerate(payload.get("items", [])):
        count = len(item.get("candidates") or [])
        if given is not None and str(index) in given:
            value = given[str(index)]
            if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < count):
                raise ValueError("选择的候选不正确，请刷新后重试")
            result.append(value)
        else:
            result.append(item.get("best") if payload.get("auto") else item.get("choice"))
    return result


def directory_version(db, bucket_id: int, prefix: str, *, limit: int = LIMITS["action_items"][2]) -> tuple[str, int]:
    """相对路径与版本的摘要；限量扫描，避免目录整体操作绕过条目上限。"""
    digest, count = hashlib.sha256(), 0
    for row in db.execute("SELECT key, etag, modified_at FROM objects WHERE bucket_id=? AND key>=? AND key<? ORDER BY key LIMIT ?",
                          (bucket_id, prefix, prefix + END, limit + 1)):
        count += 1
        digest.update(json.dumps([row["key"][len(prefix):], row["etag"], row["modified_at"]], ensure_ascii=False).encode())
        digest.update(b"\n")
    return digest.hexdigest(), count


def folder_files(db, bucket_id: int, folder: str) -> int:
    """文件夹内（含各级子目录）的文件数；目录标记不算文件。"""
    return int(db.execute("SELECT COUNT(*) FROM objects WHERE bucket_id=? AND key>? AND key<? AND substr(key,-1)!='/'",
                          (bucket_id, folder, folder + END)).fetchone()[0])

@dataclass
class Progress:
    total: int
    done: int = 0
    cancel: bool = False
    ok: int = 0
    skipped: int = 0
    failed: int = 0
    reasons: collections.Counter = field(default_factory=collections.Counter)
    failures: list = field(default_factory=list)
    links: list = field(default_factory=list)  # 公开分享：只写入操作结果给用户看，不进入模型上下文

    def skip(self, path: str, reason: str) -> None:
        self.skipped += 1
        self.reasons[reason] += 1
        if len(self.failures) < 50:
            self.failures.append({"path": path, "reason": reason, "status": "skipped"})

    def fail(self, path: str, reason: str) -> None:
        self.failed += 1
        self.reasons[reason] += 1
        if len(self.failures) < 50:
            self.failures.append({"path": path, "reason": reason, "status": "failed"})

    def result(self) -> dict[str, object]:
        result = {"ok": self.ok, "skipped": self.skipped, "failed": self.failed, "total": self.total,
                  "reasons": dict(self.reasons.most_common(10)), "failures": self.failures}
        if self.links:
            result["links"] = self.links
        return result

    def status(self) -> str:
        if self.cancel:
            return "cancelled"
        if self.failed and not self.ok:
            return "failed"
        return "partial" if self.failed or self.skipped else "done"


def display(key: str) -> str:
    """给用户与模型看的路径：私密空间内的路径相对私密空间根显示，不暴露系统区前缀。"""
    return "/" + (key[len(PRIVATE_PREFIX):] if key.startswith(PRIVATE_PREFIX) else key)


class ActionExecutor:
    def __init__(self, objects: ObjectService, offline=None, media=None, archives=None) -> None:
        self.objects, self.offline, self.media, self.archives = objects, offline, media, archives

    @property
    def db(self):
        return self.objects.metadata.db

    # ---------- 复核 ----------

    @staticmethod
    def _inside(scope_root: str, key: str) -> bool:
        if scope_root.startswith(PRIVATE_PREFIX):
            return key.startswith(scope_root)
        return key.startswith(scope_root) and not key.startswith(".tgdrive/") and key != ".tgdrive"

    def _version(self, bucket_id: int, key: str):
        return self.db.execute("SELECT etag, modified_at FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key)).fetchone()

    def _exists(self, bucket_id: int, key: str) -> bool:
        if key.endswith("/"):
            return self.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1",
                                   (bucket_id, key, key + END)).fetchone() is not None
        return self._version(bucket_id, key) is not None

    def _check_source(self, bucket_id: int, scope_root: str, item: dict, key: str) -> str | None:
        """返回跳过原因；None 表示可以执行。"""
        if not self._inside(scope_root, key):
            return "不在作用域内"
        if key.endswith("/"):
            version, count = directory_version(self.db, bucket_id, key)
            if not count:
                return "源文件夹已不存在"
            if not item.get("directory_version") or version != item["directory_version"]:
                return "源文件夹内容已变化，请重新生成操作"
            return None
        row = self._version(bucket_id, key)
        if row is None:
            return "源文件已不存在"
        if ((item.get("etag") and row["etag"] != item["etag"])
                or (item.get("modified_at") is not None and row["modified_at"] != item["modified_at"])):
            return "源文件已被修改"
        return None

    # ---------- 执行 ----------

    @staticmethod
    def _scope(bucket_id: int, scope_root: str, guard: Callable[[], None] | None) -> Scope:
        """私密空间的操作带 private_access，并在对象层每次读写时复核私密授权。"""
        if scope_root.startswith(PRIVATE_PREFIX):
            return Scope(bucket_id, scope_root, private_access=True, authorize=guard)
        return Scope(bucket_id, scope_root)

    async def execute(self, *, user_id: int, bucket_id: int, payload: dict, progress: Progress,
                      on_progress: Callable[[], None] | None = None,
                      authorized: Callable[[], bool] | None = None, confirm: dict | None = None,
                      guard: Callable[[], None] | None = None) -> dict | None:
        """执行冻结的条目，返回撤销数据（不可撤销的类型返回 None）。guard 在私密操作中复核授权（失效时抛错）。"""
        kind = payload["kind"]
        scope_root = payload.get("scope", "")
        scope = self._scope(bucket_id, scope_root, guard)
        if kind in ("move_out", "move_in"):
            await self._cross(kind, bucket_id, scope_root, payload, progress, authorized, confirm or {}, guard)
            return None
        undo: dict[str, list] = {"moves": [], "trash": [], "mkdir": [], "unshare": [], "created": []}
        items = payload.get("items", [])
        share = share_options(payload, confirm) if kind == "share" else {}
        if kind == "downloads":
            await self._downloads(user_id, scope_root, payload, progress, on_progress, authorized,
                                  scope if scope_root.startswith(PRIVATE_PREFIX) else None)
            return None
        choices = media_choices(payload, confirm) if kind == "media" else []
        refs = payload.get("_refs") or {}
        for index, item in enumerate(items):
            if progress.cancel or (authorized is not None and not authorized()):
                progress.cancel = True
                break
            if kind == "media":
                item = {**item, "chosen": choices[index], "frozen": refs.get(f"{index}:{choices[index]}")}
            elif kind == "text":
                item = {**item, "text": (payload.get("_frozen") or {}).get(str(index))}
            try:
                await self._one(kind, user_id, bucket_id, scope_root, scope, item, progress, undo, share)
            except (PermissionError, ValueError, NotFoundError) as exc:
                progress.fail(self._label(kind, item), str(exc) or "操作不被允许")
            except asyncio.CancelledError:
                raise
            except Exception:  # 单项失败不影响其余条目
                progress.fail(self._label(kind, item), "执行失败")
            progress.done += 1
            if index % 20 == 19 and on_progress:
                on_progress()
            if index % BATCH == BATCH - 1:
                await asyncio.sleep(0)
        if on_progress:
            on_progress()
        if not any(undo.values()):
            return None
        return {key: value for key, value in undo.items() if value}

    async def _copy(self, bucket_id, scope_root, scope, item, progress: Progress, undo) -> None:
        """复制：新对象引用同一个 Blob（不搬运数据）；文件夹连同全部内容一起复制，目标已有同名文件时自动改名。"""
        source, target = item["from"], item["to"]
        reason = self._check_source(bucket_id, scope_root, item, source)
        if reason is None and not self._inside(scope_root, target):
            reason = "目标不在作用域内"
        if reason is None and source.endswith("/") and target.startswith(source):
            reason = "不能复制到它自己里面"
        if reason:
            progress.skip(display(source), reason)
            return
        if not source.endswith("/"):
            info = self.objects.link_copy(bucket_id, source, scope, target)
            undo["created"].append([info.key, info.etag])
            progress.ok += 1
            return
        rows = self.db.execute("SELECT key FROM objects WHERE bucket_id=? AND key>? AND key<? ORDER BY key",
                               (bucket_id, source, source + END)).fetchall()
        if not self._exists(bucket_id, target):
            self.objects._write_directory_marker(scope, target)
            undo["mkdir"].append(target)
        for index, row in enumerate(rows):
            if progress.cancel:
                break
            destination = target + row["key"][len(source):]
            if destination.endswith("/"):
                if not self._exists(bucket_id, destination):
                    self.objects._write_directory_marker(scope, destination)
                    undo["mkdir"].append(destination)
            else:
                info = self.objects.link_copy(bucket_id, row["key"], scope, destination)
                undo["created"].append([info.key, info.etag])
            if index % 200 == 199:
                await asyncio.sleep(0)
        progress.ok += 1

    async def _archive_job(self, kind, user_id, bucket_id, scope_root, scope, item, progress: Progress, undo) -> None:
        """解压与压缩交给网页同一套任务队列（extract.ArchiveService），等它结束后按结果记账；用户取消时一并取消任务。"""
        if self.archives is None:
            progress.fail(display(item["path"]), "服务器暂不支持在线解压与压缩")
            return
        if kind == "extract":
            key = item["path"]
            reason = self._check_source(bucket_id, scope_root, item, key)
            if reason is None and not self._inside(scope_root, item["destination"]):
                reason = "解压位置不在作用域内"
            if reason:
                progress.skip(display(key), reason)
                return
            from ..extract import PasswordRequired
            try:
                job = await self.archives.start(user_id, scope, key, item["destination"], None, item["conflict"], item["keep_archive"])
            except PasswordRequired:
                progress.skip(display(key), "压缩包有密码：请在文件页用「解压…」输入密码后解压")
                return
        else:
            roots = item["sources"]
            for root in roots:
                reason = "不在作用域内" if not self._inside(scope_root, root) else None
                if reason is None and not (self._exists(bucket_id, root) if root.endswith("/") else self._version(bucket_id, root)):
                    reason = "已不存在"
                if reason:
                    progress.skip(display(root), reason)
                    return
            if not self._inside(scope_root, item["path"]):
                progress.skip(display(item["path"]), "保存位置不在作用域内")
                return
            files, total = self._totals(bucket_id, roots)
            job = await self.archives.compress(user_id, scope, item["path"], lambda: self._zip_entries(bucket_id, scope, roots),
                                               files, total, bool(item.get("deflate", True)))
        record = self.archives.jobs[job["id"]]
        while record.status in ("queued", "running"):
            if progress.cancel:
                self.archives.cancel(user_id, record.private, record.id)
            await asyncio.sleep(0.5)
        label = display(item["path"])
        if record.status != "completed":
            progress.fail(label, record.error or ("已取消" if record.status == "cancelled" else "执行失败"))
            return
        progress.ok += 1
        if record.skipped:
            progress.reasons[f"{record.skipped} 个同名文件已跳过"] += 1
        if record.renamed:
            progress.reasons[f"{record.renamed} 个同名文件已改名保存"] += 1
        if kind == "compress" and (row := self._version(bucket_id, record.archive)):
            undo["created"].append([record.archive, row["etag"]])

    def _totals(self, bucket_id: int, roots: list[str]) -> tuple[int, int]:
        files = total = 0
        for key in roots:
            if key.endswith("/"):
                row = self.db.execute("SELECT COUNT(*), COALESCE(SUM(size),0) FROM objects WHERE bucket_id=? AND key>=? AND key<? "
                                      "AND substr(key,-1)!='/'", (bucket_id, key, key + END)).fetchone()
            else:
                row = self.db.execute("SELECT COUNT(*), COALESCE(SUM(size),0) FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key)).fetchone()
            files, total = files + int(row[0]), total + int(row[1])
        return files, total

    async def _zip_entries(self, bucket_id: int, scope: Scope, roots: list[str]):
        """压缩包条目：名称相对于各项所在目录，逐个按需读取（与网页打包下载相同）。"""
        for root in roots:
            base = root[:root.rstrip("/").rfind("/") + 1]
            keys = [root] if not root.endswith("/") else [row["key"] for row in self.db.execute(
                "SELECT key FROM objects WHERE bucket_id=? AND key>=? AND key<? AND substr(key,-1)!='/' ORDER BY key",
                (bucket_id, root, root + END))]
            for key in keys:
                info, stream = await self.objects.get_object(scope, key)
                yield key[len(base):], info.size, info.modified_at, stream

    @staticmethod
    def _label(kind: str, item: dict) -> str:
        if kind in MOVE_KINDS or kind == "copy":
            return display(item["from"])
        if kind in ("restore", "purge"):
            return display(item.get("path", ""))
        if kind == "download_control":
            return f"任务 #{item['id']}"
        if kind == "media":
            return f"{display(item.get('path', ''))}（{MEDIA_LABELS.get(item.get('want'), '')}）"
        return display(item.get("path", ""))

    async def _one(self, kind, user_id, bucket_id, scope_root, scope, item, progress: Progress, undo, share=None) -> None:
        if kind in MOVE_KINDS:
            source, target = item["from"], item["to"]
            reason = self._check_source(bucket_id, scope_root, item, source)
            if reason is None and not self._inside(scope_root, target):
                reason = "目标不在作用域内"
            if reason is None and self._exists(bucket_id, target):
                reason = "目标已存在同名项目"
            if reason:
                progress.skip(display(source), reason)
                return
            result = self.objects.move(scope, source, target, "skip")
            if result.moved == 0:
                progress.skip(display(source), "目标已存在同名项目")
                return
            progress.ok += 1
            if result.skipped:
                progress.reasons[f"文件夹内有 {result.skipped} 个同名文件未移动"] += 1
            elif not source.endswith("/"):
                row = self._version(bucket_id, target)
                undo["moves"].append([target, source, {"etag": row["etag"], "modified_at": row["modified_at"]} if row else {}])
            else:
                undo["moves"].append([target, source, {"directory_version": directory_version(self.db, bucket_id, target)[0]}])
        elif kind == "copy":
            await self._copy(bucket_id, scope_root, scope, item, progress, undo)
        elif kind in ("extract", "compress"):
            await self._archive_job(kind, user_id, bucket_id, scope_root, scope, item, progress, undo)
        elif kind == "mkdir":
            key = item["path"]
            if not self._inside(scope_root, key):
                progress.skip(display(key), "不在作用域内")
                return
            if self._exists(bucket_id, key):
                progress.skip(display(key), "文件夹已存在")
                return
            self.objects._write_directory_marker(scope, key)
            progress.ok += 1
            undo["mkdir"].append(key)
        elif kind == "trash":
            key = item["path"]
            reason = self._check_source(bucket_id, scope_root, item, key)
            if not reason and item.get("only_empty") and (not key.endswith("/") or folder_files(self.db, bucket_id, key)):
                reason = "已不是空目录"
            if reason:
                progress.skip(display(key), reason)
                return
            entries = await self.objects.trash(scope, [key])
            progress.ok += 1
            undo["trash"] += [entry["id"] for entry in entries]
        elif kind == "restore":
            row = self.db.execute("SELECT original_path FROM trash WHERE bucket_id=? AND id=?", (bucket_id, item["id"])).fetchone()
            if row is None:
                progress.skip(display(item["path"]), "回收站中已没有这个条目")
                return
            if not self._inside(scope_root, row["original_path"]):
                progress.skip(display(item["path"]), "不在作用域内")
                return
            self.objects.restore(scope, [item["id"]])
            progress.ok += 1
        elif kind == "purge":
            row = self.db.execute("SELECT original_path FROM trash WHERE bucket_id=? AND id=?", (bucket_id, item["id"])).fetchone()
            if row is None:
                progress.skip(display(item["path"]), "回收站中已没有这个条目")
                return
            if not self._inside(scope_root, row["original_path"]):
                progress.skip(display(item["path"]), "不在作用域内")
                return
            await self.objects.purge_trash(scope, [item["id"]])
            progress.ok += 1
        elif kind == "unshare":
            key = item["path"]
            if not self._inside(scope_root, key):
                progress.skip(display(key), "不在作用域内")
                return
            row = self.db.execute("SELECT public_token FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key)).fetchone()
            if row is None or row["public_token"] is None:
                progress.skip(display(key), "已经不是公开状态")
                return
            self.objects.set_public(scope, key, False)
            progress.ok += 1
        elif kind == "share":
            key = item["path"]
            if not self._inside(scope_root, key):
                progress.skip(display(key), "不在作用域内")
                return
            if not self._exists(bucket_id, key):
                progress.skip(display(key), "已不存在")
                return
            from ..api import apply_share
            row = self.db.execute("SELECT public_token FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key)).fetchone()
            was_public = bool(row and row["public_token"])
            options = dict(share or {})
            info = apply_share(self.objects, scope, key, True, options)
            progress.ok += 1
            progress.links.append({"path": key, "token": info.public_token, "folder": key.endswith("/"),
                                   "expires_at": info.public_expires_at, "password": info.public_has_password})
            if not was_public:
                undo["unshare"].append(key)
        elif kind == "save_attachment":
            # 对话附件另存为普通文件（§22.5）：引用同一个 Blob；附件须仍属于本人且未被删除。
            target = item["path"]
            row = self.db.execute("SELECT key FROM assistant_attachments WHERE id=? AND user_id=?", (item["attachment"], user_id)).fetchone()
            if row is None:
                progress.skip(display(target), "附件已随对话删除")
                return
            if not self._inside(scope_root, target):
                progress.skip(display(target), "不在作用域内")
                return
            info = self.objects.link_copy(bucket_id, row["key"], scope, target)
            progress.ok += 1
            undo["created"].append([info.key, info.etag])
        elif kind == "media":
            # 保存选中的封面、歌词或字幕（覆盖已有的同类数据）；没有选择的条目保留现有。不可撤销。
            key, label = item["path"], self._label(kind, item)
            reason = self._check_source(bucket_id, scope_root, item, key)
            if reason:
                progress.skip(label, reason)
                return
            frozen = item.get("frozen")
            if item.get("chosen") is None or not isinstance(frozen, dict):
                progress.skip(label, "保留现有" if item.get("exists") else "没有选择候选")
                return
            if self.media is None:
                raise ValueError("媒体信息服务不可用")
            await self.media.save_frozen(scope, key, item["etag"], frozen["provider"], item["want"], frozen["ref"])
            progress.ok += 1
        elif kind == "text":
            # 新建或改写文本文件（§42）：新建时目标仍不能存在；改写按冻结的版本条件覆盖（If-Match），确认前被改过就跳过。不可撤销。
            from .text_tools import BOM
            key = item["path"]
            text = item.get("text")
            if not isinstance(text, str):
                progress.skip(display(key), "操作内容缺失，请重新生成")
                return
            if not self._inside(scope_root, key):
                progress.skip(display(key), "不在作用域内")
                return
            if item["mode"] == "create":
                if self._exists(bucket_id, key) or self._exists(bucket_id, key + "/"):
                    progress.skip(display(key), "已存在同名文件，请重新生成操作")
                    return
                if_match = None
            else:
                reason = self._check_source(bucket_id, scope_root, item, key)
                if reason:
                    progress.skip(display(key), reason)
                    return
                if_match = item["etag"]
            # 冻结的文本已按原文件的换行方式处理，原样写回；BOM 由条目标记。
            data = (BOM if item.get("bom") else b"") + text.encode("utf-8")
            try:
                await self.objects.put_object(scope, key, data, len(data), item.get("content_type") or "text/plain", if_match=if_match)
            except VersionConflict:
                progress.skip(display(key), "源文件已被修改")
                return
            except QuotaExceededError:
                progress.fail(display(key), "存储空间不足")
                return
            progress.ok += 1
        elif kind == "download_control":
            if self.offline is None:
                raise ValueError("离线下载未启用")
            row = self.db.execute("SELECT key FROM offline_tasks WHERE id=? AND user_id=?", (item["id"], user_id)).fetchone()
            if row is None:
                progress.skip(f"任务 #{item['id']}", "任务已不存在")
                return
            # 删除和停止只改任务记录，不受普通对话的作用域限制；继续、重新下载会写入文件，保存位置须仍在作用域内。
            # 私密任务与普通任务互不越界：私密对话的作用域就是私密空间。
            path = task_path(row["key"])
            private_scope = scope_root.startswith(PRIVATE_PREFIX)
            if private_scope != path.startswith(PRIVATE_PREFIX):
                progress.skip(f"任务 #{item['id']}", "任务已不存在")
                return
            if (item["op"] in ("resume", "restart") or private_scope) and (row["key"] != item["path"] or not self._inside(scope_root, path)):
                progress.skip(f"任务 #{item['id']}", "任务保存位置已变化或不在作用域内")
                return
            await self.offline.control(user_id, item["id"], item["op"],
                                       private_scope=scope if scope_root.startswith(PRIVATE_PREFIX) else None)
            progress.ok += 1
        else:
            raise ValueError("未知操作类型")

    async def _cross(self, kind, bucket_id, scope_root, payload, progress: Progress, authorized, confirm: dict, guard) -> None:
        """跨区移动（§24.5.3）：move_out 从私密空间移到普通目录，move_in 从普通目录移入私密空间。
        目标目录由用户在卡片上确认（confirm.target），同名时自动改名；逐项复核源版本，不可撤销。"""
        target = confirm.get("target", (payload.get("options") or {}).get("target", ""))
        if not isinstance(target, str) or len(target) > 1024:
            raise ValueError("目标目录不正确")
        from ..api import normalize_user_path
        relative = target.strip().strip("/")
        if kind == "move_out":
            folder = normalize_user_path(relative, directory=True) if relative else ""
        else:
            folder = PRIVATE_PREFIX + (normalize_user_path(relative, directory=True) if relative else "")
        scope = Scope(bucket_id, "", private_access=True, authorize=guard)
        for item in payload.get("items", []):
            if progress.cancel or (authorized is not None and not authorized()):
                progress.cancel = True
                break
            source = item["from"]
            label = display(source)
            try:
                if kind == "move_out" and not source.startswith(PRIVATE_PREFIX):
                    progress.skip(label, "不在私密空间内")
                elif kind == "move_in" and not self._inside(scope_root, source):
                    progress.skip(label, "不在作用域内")
                elif (reason := self._check_source(bucket_id, PRIVATE_PREFIX if kind == "move_out" else scope_root, item, source)):
                    progress.skip(label, reason)
                elif kind == "move_in" and folder.startswith(source):
                    progress.skip(label, "不能移入它自己的子目录")
                else:
                    name = source.rstrip("/").rsplit("/", 1)[-1] + ("/" if source.endswith("/") else "")
                    # 与私密空间页面的「移入／移出」一致：同名自动改名，移入时递归取消公开链接。
                    result = self.objects.move(scope, source, folder + name, "rename", revoke_public=kind == "move_in")
                    if result.moved:
                        progress.ok += 1
                    else:
                        progress.skip(label, "目标已存在同名项目")
            except (PermissionError, ValueError, NotFoundError) as exc:
                progress.fail(label, str(exc) or "操作不被允许")
            progress.done += 1
            await asyncio.sleep(0)

    async def _downloads(self, user_id, scope_root, payload, progress: Progress, on_progress, authorized=None, private_scope=None) -> None:
        if self.offline is None:
            raise ValueError("离线下载未启用")
        target = payload["options"]["target"]
        if not self._inside(scope_root, target) and target != scope_root:
            raise PermissionError("保存目录不在作用域内")
        items = payload.get("items", [])
        for start in range(0, len(items), DOWNLOAD_BATCH):
            if progress.cancel or (authorized is not None and not authorized()):
                progress.cancel = True
                break
            batch = items[start:start + DOWNLOAD_BATCH]
            prepared, labels = [], []
            for item in batch:
                try:
                    ticket = item.get("ticket") or self.offline.direct_ticket(user_id, item["url"], referer=item.get("referer"),
                                                                              name=item["name"])
                    prepared.append({"ticket": ticket, "name": item["name"], "folder": item.get("folder") or "",
                                     **({"cover": {"url": item["cover"]}} if item.get("cover") else {})})
                    labels.append(f"{item['folder']}/{item['name']}" if item.get("folder") else item["name"])
                except ValueError as exc:
                    progress.fail(item.get("name") or item.get("url", ""), str(exc))
                    progress.done += 1
            # 按相册分目录（§38）：子目录名在提议时已清理成单段名称，这里再清理一次并复核仍在作用域内。
            groups: dict[str, list[tuple[dict, str]]] = {}
            for entry, label in zip(prepared, labels):
                groups.setdefault(entry.pop("folder", "") or "", []).append((entry, label))
            for folder, members in groups.items():
                destination = target + filename(folder, fallback="相册") + "/" if folder else target
                try:
                    if folder and not self._inside(scope_root, destination):
                        raise PermissionError("保存目录不在作用域内")
                    # 私密区域的离线下载是私密任务：保存目录在私密空间内，创建与写入都复核私密授权。
                    self.offline.create(user_id, [entry for entry, _ in members], destination, private_scope=private_scope)
                    progress.ok += len(members)
                except (ValueError, PermissionError, NotFoundError) as exc:
                    for _, label in members:
                        progress.fail(label, str(exc) or "创建任务失败")
                progress.done += len(members)
            if on_progress:
                on_progress()
            await asyncio.sleep(0)

    # ---------- 撤销 ----------

    async def undo(self, *, bucket_id: int, payload: dict, data: dict, authorized: Callable[[], bool] | None = None,
                   guard: Callable[[], None] | None = None) -> dict[str, object]:
        scope_root = payload.get("scope", "")
        scope = self._scope(bucket_id, scope_root, guard)
        progress = Progress(total=sum(len(value) for value in data.values()))
        for target, source, version in reversed(data.get("moves", [])):
            if authorized is not None and not authorized():
                progress.cancel = True
                break
            try:
                if not self._exists(bucket_id, target):
                    progress.skip(display(target), "已不存在")
                    continue
                if target.endswith("/"):
                    expected = version.get("directory_version") if isinstance(version, dict) else None
                    if not expected or directory_version(self.db, bucket_id, target)[0] != expected:
                        progress.skip(display(target), "文件夹内容已变化，保留当前位置")
                        continue
                else:
                    expected = version if isinstance(version, dict) else {"etag": version}
                    if self._check_source(bucket_id, scope_root, expected, target):
                        progress.skip(display(target), "已被修改")
                        continue
                if self._exists(bucket_id, source):
                    progress.skip(display(target), "原位置已有同名项目")
                    continue
                result = self.objects.move(scope, target, source, "skip")
                if result.moved:
                    progress.ok += 1
                else:
                    progress.skip(display(target), "原位置已有同名项目")
            except (PermissionError, ValueError, NotFoundError) as exc:
                progress.fail(display(target), str(exc))
            await asyncio.sleep(0)
        for entry_id in data.get("trash", []):
            if progress.cancel or (authorized is not None and not authorized()):
                break
            row = self.db.execute("SELECT original_path FROM trash WHERE bucket_id=? AND id=?", (bucket_id, entry_id)).fetchone()
            if row is None:
                progress.skip(entry_id, "回收站中已没有这个条目")
                continue
            try:
                self.objects.restore(scope, [entry_id])
                progress.ok += 1
            except (PermissionError, ValueError, NotFoundError) as exc:
                progress.fail(display(row["original_path"]), str(exc))
        for key in data.get("unshare", []):
            if progress.cancel or (authorized is not None and not authorized()):
                break
            row = self.db.execute("SELECT public_token FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key)).fetchone()
            if row is None or row["public_token"] is None:
                progress.skip(display(key), "已经不是公开状态")
                continue
            try:
                self.objects.set_public(scope, key, False)
                progress.ok += 1
            except (PermissionError, ValueError, NotFoundError) as exc:
                progress.fail(display(key), str(exc))
        for key, etag in data.get("created", []):
            if progress.cancel or (authorized is not None and not authorized()):
                break
            row = self.db.execute("SELECT etag FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key)).fetchone()
            if row is None:
                progress.skip(display(key), "已不存在")
                continue
            if row["etag"] != etag:
                progress.skip(display(key), "已被修改")
                continue
            try:
                self.objects._delete_objects_sync(scope, [key])
                progress.ok += 1
            except (PermissionError, ValueError, NotFoundError) as exc:
                progress.fail(display(key), str(exc))
        for key in reversed(data.get("mkdir", [])):
            if progress.cancel or (authorized is not None and not authorized()):
                break
            children = self.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>? AND key<? LIMIT 1",
                                       (bucket_id, key, key + END)).fetchone()
            if children is not None:
                progress.skip(display(key), "文件夹不是空的，保留")
                continue
            if self.objects._delete_objects_sync(scope, [key])[0].deleted:
                progress.ok += 1
            else:
                progress.skip(display(key), "已不存在")
        progress.done = progress.total
        return progress.result()
