"""音乐歌单：用户自己整理的歌曲列表，按存储桶保存在 playlists／playlist_items 表。

条目按 (存储桶, 文件键) 引用普通空间里的音频文件，不复制数据。文件被移动、改名、移入回收站时由 objects 表上的触发器
（playlist_items_follow，见 metadata.py v41）同步键：移入回收站的歌曲暂不列出，还原后回到原位置；永久删除后条目留存但不再列出，
同一路径重新出现文件时恢复。位置是从 0 开始的连续整数，调整顺序时整体重排（每个歌单最多 ITEM_LIMIT 首）。
"""

from __future__ import annotations

import time

from .errors import NotFoundError
from .filekinds import kind_of

LIMIT = 200
ITEM_LIMIT = 5000
NAME_LIMIT = 80
# 列表与歌曲都不含系统区（回收站、私密空间等）：substr(o.key,1,9) 与 objects.py 的系统区判断一致。
_VISIBLE = "substr(o.key,1,9)!='.tgdrive/'"


def clean_name(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("请填写歌单名称")
    name = " ".join(value.split())
    if len(name) > NAME_LIMIT:
        raise ValueError(f"歌单名称最多 {NAME_LIMIT} 个字符")
    return name


class Playlists:
    def __init__(self, metadata) -> None:
        self.metadata = metadata

    def _row(self, db, bucket_id: int, playlist_id: int):
        row = db.execute("SELECT * FROM playlists WHERE id=? AND bucket_id=?", (playlist_id, bucket_id)).fetchone()
        if row is None:
            raise NotFoundError("歌单不存在或已删除")
        return row

    def list(self, bucket_id: int) -> list[dict[str, object]]:
        """全部歌单（最近修改的在前）：数量与总时长只计当前能播放的歌曲；samples 是排在最前的 4 首的对象行（封面用）。"""
        db = self.metadata.db
        rows = db.execute(
            "SELECT p.*, COUNT(o.key) AS total, COALESCE(SUM(m.duration),0) AS seconds FROM playlists p "
            "LEFT JOIN playlist_items i ON i.playlist_id=p.id "
            f"LEFT JOIN objects o ON o.bucket_id=i.bucket_id AND o.key=i.key AND {_VISIBLE} "
            "LEFT JOIN media_info m ON m.blob_uuid=o.blob_uuid "
            "WHERE p.bucket_id=? GROUP BY p.id ORDER BY p.updated_at DESC, p.id DESC", (bucket_id,)).fetchall()
        result = []
        for row in rows:
            samples = db.execute(
                "SELECT o.* FROM playlist_items i JOIN objects o ON o.bucket_id=i.bucket_id AND o.key=i.key "
                f"WHERE i.playlist_id=? AND {_VISIBLE} ORDER BY i.position LIMIT 4", (row["id"],)).fetchall()
            result.append({"id": row["id"], "name": row["name"], "count": row["total"], "duration": row["seconds"] or 0,
                           "created_at": row["created_at"], "updated_at": row["updated_at"], "samples": samples})
        return result

    def get(self, bucket_id: int, playlist_id: int) -> dict[str, object]:
        row = self._row(self.metadata.db, bucket_id, playlist_id)
        return {"id": row["id"], "name": row["name"], "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def items(self, bucket_id: int, playlist_id: int, cursor: int = -1, limit: int = 200) -> tuple[list, int | None]:
        """按歌单顺序的一页歌曲（对象行，附 position）；游标是上一页最后一首的位置。"""
        db = self.metadata.db
        self._row(db, bucket_id, playlist_id)
        limit = max(1, min(limit, 500))
        rows = db.execute(
            "SELECT o.*, i.position AS position FROM playlist_items i JOIN objects o ON o.bucket_id=i.bucket_id AND o.key=i.key "
            f"WHERE i.playlist_id=? AND i.position>? AND {_VISIBLE} ORDER BY i.position LIMIT ?",
            (playlist_id, cursor, limit + 1)).fetchall()
        return rows[:limit], rows[limit - 1]["position"] if len(rows) > limit else None

    def create(self, bucket_id: int, name: object, keys: list[str] | None = None) -> int:
        name = clean_name(name)
        now = time.time()
        with self.metadata.transaction() as db:
            if db.execute("SELECT COUNT(*) FROM playlists WHERE bucket_id=?", (bucket_id,)).fetchone()[0] >= LIMIT:
                raise ValueError(f"最多创建 {LIMIT} 个歌单")
            playlist_id = int(db.execute("INSERT INTO playlists(bucket_id,name,created_at,updated_at) VALUES(?,?,?,?)",
                                         (bucket_id, name, now, now)).lastrowid)
            if keys:
                self._add(db, bucket_id, playlist_id, keys, now)
        return playlist_id

    def rename(self, bucket_id: int, playlist_id: int, name: object) -> None:
        name = clean_name(name)
        with self.metadata.transaction() as db:
            self._row(db, bucket_id, playlist_id)
            db.execute("UPDATE playlists SET name=?, updated_at=? WHERE id=?", (name, time.time(), playlist_id))

    def delete(self, bucket_id: int, playlist_id: int) -> None:
        with self.metadata.transaction() as db:
            self._row(db, bucket_id, playlist_id)
            db.execute("DELETE FROM playlist_items WHERE playlist_id=?", (playlist_id,))
            db.execute("DELETE FROM playlists WHERE id=?", (playlist_id,))

    def _add(self, db, bucket_id: int, playlist_id: int, keys: list[str], now: float) -> int:
        """追加到末尾；已在歌单里的歌曲保持原位置。只接受普通空间里的音频文件。"""
        existing = db.execute("SELECT COUNT(*), COALESCE(MAX(position),-1) FROM playlist_items WHERE playlist_id=?",
                              (playlist_id,)).fetchone()
        count, position, added = existing[0], existing[1], 0
        seen = set()
        for key in keys:
            if key in seen:
                continue
            seen.add(key)
            row = db.execute("SELECT key, content_type FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key)).fetchone()
            if row is None or key.endswith("/") or key.startswith(".tgdrive/"):
                raise NotFoundError(key)
            if kind_of(key, row["content_type"]) != "audio":
                raise ValueError(f"只能把音乐加入歌单：{key.rsplit('/', 1)[-1]}")
            if db.execute("SELECT 1 FROM playlist_items WHERE playlist_id=? AND key=?", (playlist_id, key)).fetchone():
                continue
            if count >= ITEM_LIMIT:
                raise ValueError(f"每个歌单最多 {ITEM_LIMIT} 首歌曲")
            position += 1
            count += 1
            added += 1
            db.execute("INSERT INTO playlist_items(playlist_id,bucket_id,key,position,added_at) VALUES(?,?,?,?,?)",
                       (playlist_id, bucket_id, key, position, now))
        return added

    def add(self, bucket_id: int, playlist_id: int, keys: list[str]) -> int:
        if not 1 <= len(keys) <= ITEM_LIMIT:
            raise ValueError(f"一次最多添加 {ITEM_LIMIT} 首歌曲")
        now = time.time()
        with self.metadata.transaction() as db:
            self._row(db, bucket_id, playlist_id)
            added = self._add(db, bucket_id, playlist_id, keys, now)
            db.execute("UPDATE playlists SET updated_at=? WHERE id=?", (now, playlist_id))
        return added

    def remove(self, bucket_id: int, playlist_id: int, keys: list[str]) -> int:
        with self.metadata.transaction() as db:
            self._row(db, bucket_id, playlist_id)
            removed = sum(db.execute("DELETE FROM playlist_items WHERE playlist_id=? AND key=?", (playlist_id, key)).rowcount
                          for key in set(keys))
            self._renumber(db, playlist_id)
            db.execute("UPDATE playlists SET updated_at=? WHERE id=?", (time.time(), playlist_id))
        return removed

    def move(self, bucket_id: int, playlist_id: int, key: str, before: str | None) -> None:
        """把一首歌移到 before 之前；before 为空时移到末尾。"""
        with self.metadata.transaction() as db:
            self._row(db, bucket_id, playlist_id)
            order = [row[0] for row in db.execute("SELECT key FROM playlist_items WHERE playlist_id=? ORDER BY position",
                                                  (playlist_id,))]
            if key not in order or (before is not None and before not in order):
                raise NotFoundError("歌曲不在这个歌单里")
            if key == before:
                return
            order.remove(key)
            order.insert(order.index(before) if before is not None else len(order), key)
            self._renumber(db, playlist_id, order)
            db.execute("UPDATE playlists SET updated_at=? WHERE id=?", (time.time(), playlist_id))

    @staticmethod
    def _renumber(db, playlist_id: int, order: list[str] | None = None) -> None:
        if order is None:
            order = [row[0] for row in db.execute("SELECT key FROM playlist_items WHERE playlist_id=? ORDER BY position",
                                                  (playlist_id,))]
        # 位置没有唯一约束，按新顺序逐行写回即可。
        db.executemany("UPDATE playlist_items SET position=? WHERE playlist_id=? AND key=?",
                       ((index, playlist_id, key) for index, key in enumerate(order)))

    def containing(self, bucket_id: int, keys: list[str]) -> dict[str, list[int]]:
        """每个文件所在的歌单编号（「添加到歌单」菜单标出已添加的歌单）。"""
        result: dict[str, list[int]] = {}
        for key in keys[:500]:
            ids = [row[0] for row in self.metadata.db.execute(
                "SELECT i.playlist_id FROM playlist_items i JOIN playlists p ON p.id=i.playlist_id "
                "WHERE i.bucket_id=? AND i.key=? AND p.bucket_id=?", (bucket_id, key, bucket_id))]
            if ids:
                result[key] = ids
        return result
