"""文件助手的跨对话偏好记忆：用户明确要求记住的偏好（命名习惯、默认保存位置、语言风格等），之后每个对话都会参考。

- 只在用户明确要求时由 remember_preference 写入，用户可在网页「文件助手 → 记住的偏好」查看与删除，也可让助手 forget_preference。
- 每人最多 MAX_ITEMS 条、每条最多 MAX_CHARS 字；内容与对话留痕一样用助手留痕密钥加密（assistant_memories.body）。
- 私密对话可以读取偏好，但不写入（私密对话的内容不应留在普通对话也能看到的地方）。
- 写入前经秘密保护（guard）检查，不保存密码、密钥等凭据。
"""

from __future__ import annotations

import time

MAX_ITEMS = 50
MAX_CHARS = 200


class MemoryStore:
    def __init__(self, metadata, trace) -> None:
        self.metadata, self.trace = metadata, trace

    def list(self, user_id: int) -> list[dict]:
        rows = self.metadata.db.execute("SELECT id, body, created_at FROM assistant_memories WHERE user_id=? ORDER BY id", (user_id,)).fetchall()
        items = []
        for row in rows:
            try:
                text = self.trace._open(row["body"], f"assistant-memory:{user_id}:{row['id']}")
            except Exception:
                continue
            if isinstance(text, str):
                items.append({"id": row["id"], "text": text, "created_at": row["created_at"]})
        return items

    def add(self, user_id: int, text: str) -> dict:
        text = " ".join(str(text or "").split())
        if not text:
            raise ValueError("要记住的内容不能为空")
        if len(text) > MAX_CHARS:
            raise ValueError(f"每条偏好最多 {MAX_CHARS} 字，请精简后再记")
        existing = self.list(user_id)
        if any(item["text"] == text for item in existing):
            return next(item for item in existing if item["text"] == text)
        if len(existing) >= MAX_ITEMS:
            raise ValueError(f"最多记住 {MAX_ITEMS} 条偏好，请先删除不再需要的")
        now = time.time()
        with self.metadata.transaction() as db:
            ident = db.execute("INSERT INTO assistant_memories(user_id, body, created_at) VALUES(?, x'', ?)", (user_id, now)).lastrowid
            db.execute("UPDATE assistant_memories SET body=? WHERE id=?", (self.trace._seal(text, f"assistant-memory:{user_id}:{ident}"), ident))
        return {"id": ident, "text": text, "created_at": now}

    def remove(self, user_id: int, ident: int) -> bool:
        with self.metadata.transaction() as db:
            return db.execute("DELETE FROM assistant_memories WHERE user_id=? AND id=?", (user_id, ident)).rowcount > 0

    def clear(self, user_id: int) -> int:
        with self.metadata.transaction() as db:
            return db.execute("DELETE FROM assistant_memories WHERE user_id=?", (user_id,)).rowcount

    def clear_all(self) -> int:
        """「清除全部助手数据」时调用：留痕密钥会重置，旧偏好也无法再解密，一并删除。"""
        with self.metadata.transaction() as db:
            return db.execute("DELETE FROM assistant_memories").rowcount
