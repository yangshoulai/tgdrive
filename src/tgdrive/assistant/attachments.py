"""对话附件（docs/assistant-design.md §22.5）。

附件属于对话，不是普通文件：对象存放在系统区 .tgdrive/assistant/<附件ID>/<文件名>，网页文件接口、访问密钥、S3、
列表与搜索都看不到；照常加密、计入存储桶配额。归属与对话绑定登记在 assistant_attachments，
这里是附件唯一的写入与删除入口：未发送的可以放弃，已发送的只随对话删除（删除对话、重试截断、保留期清理）。
"""

from __future__ import annotations

import re
import time
import uuid

from ..errors import NotFoundError
from ..objects import ObjectService, Scope
from .vision import ATTACHMENT_ROOT as ROOT, is_image

PREFIX = "附件:"
MAX_BYTES = 64 * 1024 * 1024
MAX_PENDING = 20
MAX_PER_MESSAGE = 10
PENDING_TTL = 86400
NAME_BYTES = 200


def clean_name(value: object) -> str:
    name = re.sub(r"[\\/\x00-\x1f\x7f]", "_", str(value or "")).strip().strip(".") or "未命名文件"
    while len(name.encode("utf-8")) > NAME_BYTES:
        stem, dot, ext = name.rpartition(".")
        name = (stem[:-1] + dot + ext) if dot and stem and len(ext) <= 16 else name[:-1]
    return name


def _numbered(name: str, n: int) -> str:
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, dot, ext = name, "", ""
    return f"{stem} ({n}){dot}{ext}"


class AttachmentStore:
    def __init__(self, metadata, objects: ObjectService) -> None:
        self.metadata, self.objects = metadata, objects

    @staticmethod
    def json(row) -> dict[str, object]:
        return {"id": row["id"], "name": row["name"], "size": row["size"], "content_type": row["content_type"],
                "image": is_image(row["name"], row["content_type"]), "conversation_id": row["conversation_id"],
                "created_at": row["created_at"]}

    def row(self, user_id: int, attachment_id: str):
        row = self.metadata.db.execute("SELECT * FROM assistant_attachments WHERE id=? AND user_id=?",
                                       (str(attachment_id), user_id)).fetchone()
        if row is None:
            raise NotFoundError("附件不存在")
        return row

    # ---------- 上传与预览图 ----------

    async def upload(self, user_id: int, bucket_id: int, name: object, content_type: str | None, body, size: int | None) -> dict:
        if size is not None and size > MAX_BYTES:
            raise ValueError("单个附件不能超过 64 MB，更大的文件请在文件页上传后用 @ 引用")
        pending = self.metadata.db.execute("SELECT COUNT(*) FROM assistant_attachments WHERE user_id=? AND conversation_id IS NULL",
                                           (user_id,)).fetchone()[0]
        if pending >= MAX_PENDING:
            raise ValueError(f"未发送的附件最多 {MAX_PENDING} 个，请先发送或移除一些")
        name = clean_name(name)
        attachment_id = uuid.uuid4().hex
        key = f"{ROOT}{attachment_id}/{name}"

        async def limited():
            total = 0
            async for chunk in body:
                total += len(chunk)
                if total > MAX_BYTES:
                    raise ValueError("单个附件不能超过 64 MB，更大的文件请在文件页上传后用 @ 引用")
                yield chunk

        mime = (content_type or "").split(";", 1)[0].strip()[:100] or None
        info = await self.objects.put_object(Scope(bucket_id), key, limited(), size, mime)
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO assistant_attachments(id,user_id,bucket_id,key,name,size,content_type,created_at) "
                       "VALUES(?,?,?,?,?,?,?,?)", (attachment_id, user_id, bucket_id, key, name, info.size, mime, time.time()))
        return self.json(self.row(user_id, attachment_id))

    def set_thumbnail(self, user_id: int, attachment_id: str, data: bytes | None, variant: str) -> None:
        row = self.row(user_id, attachment_id)
        self.objects.set_thumbnail(Scope(row["bucket_id"]), row["key"], data, variant)

    def thumbnail(self, user_id: int, attachment_id: str, variant: str):
        row = self.row(user_id, attachment_id)
        return self.objects.get_thumbnail(Scope(row["bucket_id"]), row["key"], variant)

    async def content(self, user_id: int, attachment_id: str, start: int = 0, end: int | None = None):
        row = self.row(user_id, attachment_id)
        return await self.objects.get_object(Scope(row["bucket_id"]), row["key"], start, end)

    # ---------- 发送与对话内名称 ----------

    def check(self, user_id: int, conversation_id: str, ids: object, *, keep: frozenset = frozenset()) -> list[str]:
        """发送前校验（不写入），返回去重后的附件 ID；bind 在消息写入后完成绑定。"""
        if ids in (None, []):
            return []
        if not isinstance(ids, list) or len(ids) > MAX_PER_MESSAGE or not all(isinstance(item, str) for item in ids):
            raise ValueError(f"一条消息最多 {MAX_PER_MESSAGE} 个附件")
        for attachment_id in dict.fromkeys(ids):
            row = self.metadata.db.execute("SELECT * FROM assistant_attachments WHERE id=? AND user_id=?", (attachment_id, user_id)).fetchone()
            if row is None:
                raise ValueError("附件不存在，可能已被移除，请重新添加")
            if row["conversation_id"] is not None and not (row["conversation_id"] == conversation_id and attachment_id in keep):
                raise ValueError(f"附件 {row['name']} 已经发送过，不能再次使用")
            if not self.metadata.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (row["bucket_id"], row["key"])).fetchone():
                raise ValueError(f"附件 {row['name']} 不存在")
        return list(dict.fromkeys(ids))

    def bind(self, user_id: int, conversation_id: str, seq: int, ids: object, *, keep: frozenset = frozenset()) -> list[dict]:
        """把附件绑定到对话的一条消息。只接受本人尚未发送的附件，或 keep 中（重试时重发的）本对话附件。
        同一对话里同名附件按「名称 (2)」改名，模型用这个名称称呼附件。"""
        if ids in (None, []):
            return []
        if not isinstance(ids, list) or len(ids) > MAX_PER_MESSAGE or not all(isinstance(item, str) for item in ids):
            raise ValueError(f"一条消息最多 {MAX_PER_MESSAGE} 个附件")
        now = time.time()
        bound: list[dict] = []
        with self.metadata.transaction() as db:
            taken = {row[0] for row in db.execute("SELECT name FROM assistant_attachments WHERE conversation_id=? AND id NOT IN "
                                                  f"({','.join('?' * len(ids))})", (conversation_id, *ids))}
            for attachment_id in dict.fromkeys(ids):
                row = db.execute("SELECT * FROM assistant_attachments WHERE id=? AND user_id=?", (attachment_id, user_id)).fetchone()
                if row is None:
                    raise ValueError("附件不存在，可能已被移除，请重新添加")
                if row["conversation_id"] is not None and not (row["conversation_id"] == conversation_id and attachment_id in keep):
                    raise ValueError(f"附件 {row['name']} 已经发送过，不能再次使用")
                if not db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (row["bucket_id"], row["key"])).fetchone():
                    raise ValueError(f"附件 {row['name']} 不存在")
                name, n = row["name"], 2
                while name in taken:
                    name, n = _numbered(row["name"], n), n + 1
                taken.add(name)
                db.execute("UPDATE assistant_attachments SET conversation_id=?, message_seq=?, name=?, bound_at=? WHERE id=?",
                           (conversation_id, seq, name, now, attachment_id))
                bound.append({"id": attachment_id, "name": name, "size": row["size"], "content_type": row["content_type"],
                              "image": is_image(name, row["content_type"])})
        return bound

    def for_conversation(self, conversation_id: str) -> dict[str, str]:
        """{显示名: 对象键}：只读工具的附件表。"""
        return {row["name"]: row["key"] for row in self.metadata.db.execute(
            "SELECT name, key FROM assistant_attachments WHERE conversation_id=?", (conversation_id,))}

    def message_ids(self, conversation_id: str, seq: int) -> list[str]:
        return [row[0] for row in self.metadata.db.execute(
            "SELECT id FROM assistant_attachments WHERE conversation_id=? AND message_seq=? ORDER BY bound_at, id", (conversation_id, seq))]

    def conversation_usage(self, user_id: int, conversation_id: str) -> dict[str, int]:
        row = self.metadata.db.execute("SELECT COUNT(*), COALESCE(SUM(size),0) FROM assistant_attachments WHERE user_id=? AND conversation_id=?",
                                       (user_id, conversation_id)).fetchone()
        return {"count": int(row[0]), "size": int(row[1])}

    # ---------- 删除 ----------

    def _delete(self, rows) -> int:
        rows = list(rows)
        by_bucket: dict[int, list[str]] = {}
        for row in rows:
            by_bucket.setdefault(int(row["bucket_id"]), []).append(row["key"])
        for bucket_id, keys in by_bucket.items():
            if self.metadata.db.execute("SELECT 1 FROM buckets WHERE id=?", (bucket_id,)).fetchone():
                for start in range(0, len(keys), 500):
                    self.objects._delete_objects_sync(Scope(bucket_id), keys[start:start + 500])
        with self.metadata.transaction() as db:
            for row in rows:
                db.execute("DELETE FROM assistant_attachments WHERE id=?", (row["id"],))
        return len(rows)

    def discard(self, user_id: int, attachment_id: str) -> None:
        row = self.row(user_id, attachment_id)
        if row["conversation_id"] is not None:
            raise ValueError("已发送的附件随对话保存，删除对话时会一起删除")
        self._delete([row])

    def delete_for_conversation(self, conversation_id: str) -> int:
        return self._delete(self.metadata.db.execute("SELECT * FROM assistant_attachments WHERE conversation_id=?",
                                                     (conversation_id,)).fetchall())

    def delete_after(self, conversation_id: str, seq: int, *, keep: frozenset = frozenset()) -> int:
        """重试截断：删除 seq 及之后消息上的附件，keep 中（重发的）除外。"""
        rows = self.metadata.db.execute("SELECT * FROM assistant_attachments WHERE conversation_id=? AND message_seq>=?",
                                        (conversation_id, seq)).fetchall()
        return self._delete(row for row in rows if row["id"] not in keep)

    def purge_all(self) -> int:
        return self._delete(self.metadata.db.execute("SELECT * FROM assistant_attachments").fetchall())

    def cleanup(self, now: float | None = None, *, batch: int = 500) -> int:
        """维护任务：超过 24 小时仍未发送的附件，以及对话已删除（隐藏或已清理）却残留的附件。"""
        now = now or time.time()
        rows = self.metadata.db.execute(
            "SELECT a.* FROM assistant_attachments a LEFT JOIN assistant_conversations c ON c.id=a.conversation_id "
            "WHERE (a.conversation_id IS NULL AND a.created_at<?) OR (a.conversation_id IS NOT NULL AND (c.id IS NULL OR c.hidden_at IS NOT NULL)) "
            "LIMIT ?", (now - PENDING_TTL, batch)).fetchall()
        return self._delete(rows)

    # ---------- 保存到我的文件与统计 ----------

    def save(self, user_id: int, attachment_id: str, destination: Scope, target: str):
        """另存为普通文件（引用同一个 Blob）。只能保存已发送到未删除对话中的附件或自己未发送的附件。"""
        row = self.row(user_id, attachment_id)
        if destination.bucket_id != row["bucket_id"]:
            raise PermissionError("只能保存到自己的存储空间")
        return self.objects.link_copy(row["bucket_id"], row["key"], destination, target)

    def stats(self, user_id: int) -> dict[str, object]:
        rows = self.metadata.db.execute(
            "SELECT a.conversation_id, COUNT(*) AS count, COALESCE(SUM(a.size),0) AS size, MAX(a.created_at) AS latest "
            "FROM assistant_attachments a JOIN assistant_conversations c ON c.id=a.conversation_id "
            "WHERE a.user_id=? AND c.hidden_at IS NULL GROUP BY a.conversation_id ORDER BY latest DESC LIMIT 200", (user_id,)).fetchall()
        total = self.metadata.db.execute("SELECT COUNT(*), COALESCE(SUM(size),0) FROM assistant_attachments WHERE user_id=?",
                                         (user_id,)).fetchone()
        pending = self.metadata.db.execute("SELECT COUNT(*), COALESCE(SUM(size),0) FROM assistant_attachments "
                                           "WHERE user_id=? AND conversation_id IS NULL", (user_id,)).fetchone()
        return {"count": int(total[0]), "size": int(total[1]), "pending": {"count": int(pending[0]), "size": int(pending[1])},
                "conversations": [{"conversation_id": row["conversation_id"], "count": int(row["count"]), "size": int(row["size"]),
                                   "latest": row["latest"]} for row in rows]}
