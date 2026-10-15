"""对话留痕、用量统计与调用日志（docs/assistant-design.md §10）。

正文（标题、消息、操作载荷）用随机的留痕数据密钥加密，该密钥再由 KEK 派生子密钥 `assistant-trace` 包裹后存在
settings 表，改口令时只需重新包裹这一把密钥。解密只发生在 `_open`，它只被用户端读取路径调用：
管理端查询（`admin_*`）只读明文索引字段与计数，绝不返回正文。
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import threading
import time

from ..crypto import derive_subkey, open_sealed, seal
from ..errors import NotFoundError
from ..keystore import KeyStore
from ..metadata import Metadata
from .providers import scrub

CALL_FIELDS = ("kind", "run_id", "conversation_id", "user_id", "actor", "channel_id", "model_id", "tool_name", "action_id",
               "host", "started_at", "duration_ms", "ttfb_ms", "status", "http_status", "error_code", "error",
               "input_tokens", "output_tokens", "cached_tokens", "upstream_id", "items")


def today(now: float | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(now if now is not None else time.time()))


class TraceStore:
    def __init__(self, metadata: Metadata, keystore: KeyStore) -> None:
        self.metadata, self.keystore = metadata, keystore
        self._lock = threading.Lock()
        self._cached: tuple[bytes, bytes] | None = None  # (kek, 留痕密钥)

    # ---------- 加密 ----------

    def _key(self) -> bytes:
        kek = self.keystore.require_kek()
        with self._lock:
            if self._cached is not None and self._cached[0] is kek:
                return self._cached[1]
            wrap = derive_subkey(kek, "assistant-trace")
            row = self.metadata.db.execute("SELECT value FROM settings WHERE key='assistant.trace_key'").fetchone()
            if row is None:
                key = os.urandom(32)
                with self.metadata.transaction() as db:
                    db.execute("INSERT INTO settings(key,value) VALUES('assistant.trace_key',?)",
                               (base64.b64encode(seal(wrap, key, "assistant-trace-key")).decode(),))
            else:
                key = open_sealed(wrap, base64.b64decode(row["value"]), "assistant-trace-key")
            self._cached = (kek, key)
            return key

    def _seal(self, value: object, aad: str) -> bytes:
        return seal(self._key(), json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(), aad)

    def _open(self, value: bytes | None, aad: str) -> object:
        return None if value is None else json.loads(open_sealed(self._key(), value, aad))

    # ---------- 对话 ----------

    def create_conversation(self, user_id: int, scope_root: str, model_id: int | None, *, keep: int) -> str:
        conversation_id = "c_" + secrets.token_urlsafe(12)
        now = time.time()
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO assistant_conversations(id,user_id,scope_root,model_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                       (conversation_id, user_id, scope_root, model_id, now, now))
            # 单用户容量保护：超出上限时删除最旧的对话（按最后活动）。
            stale = db.execute("SELECT id FROM assistant_conversations WHERE user_id=? ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?",
                               (user_id, keep)).fetchall()
            for row in stale:
                db.execute("DELETE FROM assistant_conversations WHERE id=?", (row["id"],))
        return conversation_id

    def conversation(self, user_id: int, conversation_id: str, *, include_hidden: bool = False):
        row = self.metadata.db.execute("SELECT * FROM assistant_conversations WHERE id=? AND user_id=?",
                                       (conversation_id, user_id)).fetchone()
        if row is None or (row["hidden_at"] is not None and not include_hidden):
            raise NotFoundError("对话不存在")
        return row

    def conversation_json(self, row) -> dict[str, object]:
        return {"id": row["id"], "title": self._open(row["title"], f"assistant:{row['id']}:title"),
                "scope_root": row["scope_root"], "model_id": row["model_id"], "archived": bool(row["archived"]),
                "messages": row["messages"], "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def list_conversations(self, user_id: int, *, cursor: str = "", limit: int = 50, archived: bool = False) -> dict[str, object]:
        limit = max(1, min(limit, 100))
        where, args = "user_id=? AND hidden_at IS NULL AND archived=?", [user_id, int(archived)]
        if cursor:
            try:
                at, last = cursor.split("|", 1)
                where += " AND (updated_at<? OR (updated_at=? AND id<?))"
                args += [float(at), float(at), last]
            except ValueError as exc:
                raise ValueError("分页游标不正确") from exc
        rows = self.metadata.db.execute(f"SELECT * FROM assistant_conversations WHERE {where} ORDER BY updated_at DESC, id DESC LIMIT ?",
                                        (*args, limit + 1)).fetchall()
        items = [self.conversation_json(row) for row in rows[:limit]]
        next_cursor = f"{rows[limit - 1]['updated_at']!r}|{rows[limit - 1]['id']}" if len(rows) > limit else None
        return {"conversations": items, "next_cursor": next_cursor}

    def update_conversation(self, user_id: int, conversation_id: str, *, title=None, archived=None, scope_root=None,
                            model_id=None) -> None:
        self.conversation(user_id, conversation_id)
        sets, args = [], []
        if title is not None:
            sets.append("title=?")
            args.append(self._seal(title, f"assistant:{conversation_id}:title"))
        if archived is not None:
            sets.append("archived=?")
            args.append(int(archived))
        if scope_root is not None:
            sets.append("scope_root=?")
            args.append(scope_root)
        if model_id is not None:
            sets.append("model_id=?")
            args.append(model_id)
        if sets:
            with self.metadata.transaction() as db:
                db.execute(f"UPDATE assistant_conversations SET {','.join(sets)} WHERE id=?", (*args, conversation_id))

    def hide_conversation(self, user_id: int, conversation_id: str) -> None:
        self.conversation(user_id, conversation_id)
        with self.metadata.transaction() as db:
            db.execute("UPDATE assistant_conversations SET hidden_at=? WHERE id=?", (time.time(), conversation_id))

    # ---------- 消息 ----------

    def append(self, conversation_id: str, run_id: str | None, role: str, body: dict, *, tool_name: str | None = None) -> int:
        now = time.time()
        with self.metadata.transaction() as db:
            seq = db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM assistant_messages WHERE conversation_id=?",
                             (conversation_id,)).fetchone()[0]
            db.execute("INSERT INTO assistant_messages(conversation_id,run_id,seq,role,tool_name,body,created_at) VALUES(?,?,?,?,?,?,?)",
                       (conversation_id, run_id, seq, role, tool_name,
                        self._seal(body, f"assistant:{conversation_id}:{seq}"), now))
            db.execute("UPDATE assistant_conversations SET messages=messages+1, updated_at=? WHERE id=?", (now, conversation_id))
        return int(seq)

    def update_message(self, conversation_id: str, seq: int, body: dict) -> None:
        with self.metadata.transaction() as db:
            db.execute("UPDATE assistant_messages SET body=? WHERE conversation_id=? AND seq=?",
                       (self._seal(body, f"assistant:{conversation_id}:{seq}"), conversation_id, seq))

    def messages(self, conversation_id: str, *, after: int = 0, limit: int = 500) -> list[dict[str, object]]:
        rows = self.metadata.db.execute(
            "SELECT * FROM assistant_messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?",
            (conversation_id, after, limit)).fetchall()
        return [{"seq": row["seq"], "run_id": row["run_id"], "role": row["role"], "tool_name": row["tool_name"],
                 "created_at": row["created_at"], **self._open(row["body"], f"assistant:{conversation_id}:{row['seq']}")}
                for row in rows]

    # ---------- 运行 ----------

    def start_run(self, conversation_id: str, model_id: int, prompt_version: str) -> str:
        run_id = "r_" + secrets.token_urlsafe(12)
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO assistant_runs(id,conversation_id,model_id,prompt_version,status,started_at) VALUES(?,?,?,?,?,?)",
                       (run_id, conversation_id, model_id, prompt_version, "running", time.time()))
        return run_id

    def finish_run(self, run_id: str, *, status: str, stop_reason: str | None, steps: int, tool_calls: int,
                   input_tokens: int, output_tokens: int) -> None:
        with self.metadata.transaction() as db:
            db.execute("UPDATE assistant_runs SET status=?, stop_reason=?, steps=?, tool_calls=?, input_tokens=?, output_tokens=?, "
                       "ended_at=? WHERE id=?", (status, stop_reason, steps, tool_calls, input_tokens, output_tokens, time.time(), run_id))
            db.execute("UPDATE assistant_conversations SET input_tokens=input_tokens+?, output_tokens=output_tokens+? "
                       "WHERE id=(SELECT conversation_id FROM assistant_runs WHERE id=?)", (input_tokens, output_tokens, run_id))

    def interrupt_stale_runs(self) -> int:
        """服务启动时：上次进程留下的 running 标记为 interrupted，它们产生的待确认操作作废；执行到一半的操作记为中断。"""
        now = time.time()
        with self.metadata.transaction() as db:
            count = db.execute("UPDATE assistant_runs SET status='interrupted', stop_reason='server_restart', ended_at=? "
                               "WHERE status='running'", (now,)).rowcount
            db.execute("UPDATE assistant_actions SET status='expired', decided_at=? WHERE status='pending'", (now,))
            db.execute("UPDATE assistant_actions SET status='interrupted', finished_at=? WHERE status IN ('running','undoing')", (now,))
        return count

    # ---------- 待确认操作 ----------

    def create_action(self, conversation_id: str, run_id: str, user_id: int, session_hash: str, kind: str, tool_name: str,
                      payload: dict, *, count: int, ttl: float = 900, keep_pending: int = 5) -> str:
        action_id = "a_" + secrets.token_urlsafe(12)
        now = time.time()
        with self.metadata.transaction() as db:
            pending = db.execute("SELECT id FROM assistant_actions WHERE conversation_id=? AND status='pending' "
                                 "ORDER BY created_at DESC LIMIT -1 OFFSET ?", (conversation_id, keep_pending - 1)).fetchall()
            for row in pending:
                db.execute("UPDATE assistant_actions SET status='expired', decided_at=? WHERE id=?", (now, row["id"]))
            db.execute("INSERT INTO assistant_actions(id,conversation_id,run_id,user_id,session_hash,kind,tool_name,status,count,"
                       "payload,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                       (action_id, conversation_id, run_id, user_id, session_hash, kind, tool_name, "pending", count,
                        self._seal(payload, f"assistant-action:{action_id}"), now, now + ttl))
        return action_id

    def action(self, user_id: int, action_id: str):
        row = self.metadata.db.execute("SELECT a.* FROM assistant_actions a JOIN assistant_conversations c ON c.id=a.conversation_id "
                                       "WHERE a.id=? AND a.user_id=? AND c.hidden_at IS NULL", (action_id, user_id)).fetchone()
        if row is None:
            raise NotFoundError("操作不存在")
        return row

    SAMPLES = 20

    def action_payload(self, row) -> dict:
        return self._open(row["payload"], f"assistant-action:{row['id']}")

    def action_json(self, row) -> dict[str, object]:
        """卡片数据：完整条目只在 /items 分页读取，这里只带前 20 条样例。"""
        status = row["status"]
        if status == "pending" and row["expires_at"] <= time.time():
            status = "expired"
        payload = self.action_payload(row)
        if isinstance(payload, dict) and "items" in payload:
            payload = {**{key: value for key, value in payload.items() if key != "items"}, "samples": payload["items"][:self.SAMPLES]}
        return {"id": row["id"], "kind": row["kind"], "tool_name": row["tool_name"], "status": status, "count": row["count"],
                "payload": payload, "result": self._open(row["result"], f"assistant-action:{row['id']}:result"),
                "undoable": row["undo"] is not None and status in ("done", "partial", "cancelled")
                and (row["finished_at"] or 0) > time.time() - 86400,
                "created_at": row["created_at"], "expires_at": row["expires_at"], "decided_at": row["decided_at"],
                "finished_at": row["finished_at"]}

    def action_items(self, row, *, offset: int = 0, limit: int = 100) -> dict[str, object]:
        payload = self.action_payload(row)
        items = payload.get("items", []) if isinstance(payload, dict) else []
        limit = max(1, min(limit, 500))
        page = items[offset:offset + limit]
        return {"items": page, "skipped": payload.get("skipped", []) if offset == 0 and isinstance(payload, dict) else [],
                "total": len(items), "next_offset": offset + limit if offset + limit < len(items) else None,
                "compacted": bool(row["compacted"])}

    def start_action(self, action_id: str) -> bool:
        """pending → running（只成功一次）。"""
        now = time.time()
        with self.metadata.transaction() as db:
            return db.execute("UPDATE assistant_actions SET status='running', decided_at=? WHERE id=? AND status='pending' "
                              "AND expires_at>?", (now, action_id, now)).rowcount == 1

    def action_recorder(self, action_id: str, conversation_id: str):
        """只写入本次已授权操作的结果。锁定后也能加密收尾，保住已执行部分的撤销记录。"""
        key = self._key()

        def encrypt(value, aad):
            return seal(key, json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(), aad)

        def finish(status: str, result: dict, undo: dict | None, event: dict) -> None:
            now = time.time()
            with self.metadata.transaction() as db:
                changed = db.execute("UPDATE assistant_actions SET status=?, finished_at=?, result=?, undo=? WHERE id=?",
                                     (status, now, encrypt(result, f"assistant-action:{action_id}:result"),
                                      None if undo is None else encrypt(undo, f"assistant-action:{action_id}:undo"), action_id)).rowcount
                if not changed:  # 对话或账号已经被清除，不重新创建任何记录。
                    return
                seq = db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM assistant_messages WHERE conversation_id=?", (conversation_id,)).fetchone()[0]
                db.execute("INSERT INTO assistant_messages(conversation_id,seq,role,body,created_at) VALUES(?,?,'event',?,?)",
                           (conversation_id, seq, encrypt(event, f"assistant:{conversation_id}:{seq}"), now))
                db.execute("UPDATE assistant_conversations SET messages=messages+1, updated_at=? WHERE id=?", (now, conversation_id))
        return finish

    def action_undo(self, row) -> dict | None:
        return self._open(row["undo"], f"assistant-action:{row['id']}:undo")

    def take_undo(self, action_id: str) -> bool:
        """把可撤销的操作标为 undoing（只成功一次），撤销数据保留到撤销完成。"""
        with self.metadata.transaction() as db:
            return db.execute("UPDATE assistant_actions SET status='undoing' WHERE id=? AND undo IS NOT NULL "
                              "AND status IN ('done','partial','cancelled') AND finished_at>?",
                              (action_id, time.time() - 86400)).rowcount == 1

    def finish_undo(self, action_id: str, result: dict) -> None:
        with self.metadata.transaction() as db:
            db.execute("UPDATE assistant_actions SET status='undone', undo=NULL, result=? WHERE id=?",
                       (self._seal(result, f"assistant-action:{action_id}:result"), action_id))

    def actions(self, conversation_id: str) -> list[dict[str, object]]:
        rows = self.metadata.db.execute("SELECT * FROM assistant_actions WHERE conversation_id=? ORDER BY created_at",
                                        (conversation_id,)).fetchall()
        return [self.action_json(row) for row in rows]

    def decide_action(self, action_id: str, status: str, result: dict | None = None) -> bool:
        """把 pending 改为终态；已决定或已过期返回 False（保证只能确认一次）。"""
        now = time.time()
        with self.metadata.transaction() as db:
            changed = db.execute("UPDATE assistant_actions SET status=?, decided_at=?, finished_at=?, result=? "
                                 "WHERE id=? AND status='pending' AND expires_at>?",
                                 (status, now, now, None if result is None else self._seal(result, f"assistant-action:{action_id}:result"),
                                  action_id, now)).rowcount
        return changed == 1

    def expire_session_actions(self, session_hash: str) -> None:
        with self.metadata.transaction() as db:
            db.execute("UPDATE assistant_actions SET status='expired', decided_at=? WHERE session_hash=? AND status='pending'",
                       (time.time(), session_hash))

    def pending_actions(self, conversation_id: str) -> list[dict[str, object]]:
        rows = self.metadata.db.execute("SELECT id, kind, count FROM assistant_actions WHERE conversation_id=? AND status='pending' "
                                        "AND expires_at>? ORDER BY created_at", (conversation_id, time.time())).fetchall()
        return [dict(row) for row in rows]

    def expire_actions(self, conversation_id: str | None = None, *, user_id: int | None = None, tool_names: list[str] | None = None) -> int:
        where, args = ["status='pending'"], [time.time()]
        if conversation_id is not None:
            where.append("conversation_id=?")
            args.append(conversation_id)
        if user_id is not None:
            where.append("user_id=?")
            args.append(user_id)
        if tool_names:
            where.append(f"tool_name IN ({','.join('?' * len(tool_names))})")
            args += tool_names
        with self.metadata.transaction() as db:
            return db.execute(f"UPDATE assistant_actions SET status='expired', decided_at=? WHERE {' AND '.join(where)}", args).rowcount

    # ---------- 网页结果集与页面快照（24 小时） ----------

    def create_collection(self, conversation_id: str, user_id: int, kind: str, *, source: str | None, rule: dict | None,
                          urls: list, count: int, ttl: float = 86400) -> str:
        collection_id = ("s_" if kind == "snapshot" else "g_") + secrets.token_urlsafe(12)
        now = time.time()
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO assistant_collections(id,conversation_id,user_id,kind,source,rule,urls,count,created_at,expires_at) "
                       "VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (collection_id, conversation_id, user_id, kind, source,
                        None if rule is None else self._seal(rule, f"assistant-collection:{collection_id}:rule"),
                        self._seal(urls, f"assistant-collection:{collection_id}"), count, now, now + ttl))
        return collection_id

    def collection(self, user_id: int, collection_id: str, *, kind: str | None = None) -> dict[str, object]:
        row = self.metadata.db.execute("SELECT * FROM assistant_collections WHERE id=? AND user_id=? AND expires_at>?",
                                       (collection_id, user_id, time.time())).fetchone()
        if row is None or (kind is not None and row["kind"] != kind):
            raise NotFoundError("结果集不存在或已过期（保留 24 小时）")
        return {"id": row["id"], "conversation_id": row["conversation_id"], "kind": row["kind"], "source": row["source"],
                "count": row["count"], "created_at": row["created_at"], "expires_at": row["expires_at"],
                "rule": self._open(row["rule"], f"assistant-collection:{row['id']}:rule"),
                "urls": self._open(row["urls"], f"assistant-collection:{row['id']}")}

    def update_collection(self, collection_id: str, *, rule: dict | None = None, urls: list | None = None) -> None:
        sets, args = [], []
        if rule is not None:
            sets.append("rule=?")
            args.append(self._seal(rule, f"assistant-collection:{collection_id}:rule"))
        if urls is not None:
            sets += ["urls=?", "count=?"]
            args += [self._seal(urls, f"assistant-collection:{collection_id}"), len(urls)]
        if sets:
            with self.metadata.transaction() as db:
                db.execute(f"UPDATE assistant_collections SET {','.join(sets)} WHERE id=?", (*args, collection_id))

    # ---------- 用量 ----------

    def add_usage(self, user_id: int, model_id: int, input_tokens: int, output_tokens: int, runs: int = 0) -> None:
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO assistant_usage(user_id,day,model_id,input_tokens,output_tokens,runs) VALUES(?,?,?,?,?,?) "
                       "ON CONFLICT(user_id,day,model_id) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,"
                       "output_tokens=output_tokens+excluded.output_tokens, runs=runs+excluded.runs",
                       (user_id, today(), model_id, input_tokens, output_tokens, runs))

    def tokens_today(self, user_id: int) -> int:
        row = self.metadata.db.execute("SELECT COALESCE(SUM(input_tokens+output_tokens),0) FROM assistant_usage WHERE user_id=? AND day=?",
                                       (user_id, today())).fetchone()
        return int(row[0])

    def usage_by_day(self, *, days: int = 30, user_id: int | None = None) -> list[dict[str, object]]:
        since = today(time.time() - (days - 1) * 86400)
        where, args = "day>=?", [since]
        if user_id is not None:
            where += " AND user_id=?"
            args.append(user_id)
        rows = self.metadata.db.execute(
            f"SELECT day, model_id, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(runs) AS runs "
            f"FROM assistant_usage WHERE {where} GROUP BY day, model_id ORDER BY day", args).fetchall()
        return [dict(row) for row in rows]

    def usage_report(self, *, days: int = 30) -> dict[str, object]:
        """管理端用量报表：按日、按用户、按模型汇总 token 与运行次数，以及工具调用次数、错误率与被上限拦截的运行。"""
        days = max(1, min(days, 400))
        since_day = today(time.time() - (days - 1) * 86400)
        since = time.mktime(time.strptime(since_day, "%Y-%m-%d"))
        db = self.metadata.db
        by_day = [dict(row) for row in db.execute(
            "SELECT day, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(runs) AS runs, "
            "COUNT(DISTINCT user_id) AS users FROM assistant_usage WHERE day>=? GROUP BY day ORDER BY day", (since_day,))]
        by_user = [dict(row) for row in db.execute(
            "SELECT a.user_id, u.username, u.nickname, SUM(a.input_tokens) AS input_tokens, SUM(a.output_tokens) AS output_tokens, "
            "SUM(a.runs) AS runs FROM assistant_usage a LEFT JOIN users u ON u.id=a.user_id WHERE a.day>=? GROUP BY a.user_id "
            "ORDER BY SUM(a.input_tokens+a.output_tokens) DESC LIMIT 50", (since_day,))]
        by_model = [dict(row) for row in db.execute(
            "SELECT a.model_id, m.model AS model_name, m.display_name AS model_label, ch.name AS channel_name, "
            "SUM(a.input_tokens) AS input_tokens, SUM(a.output_tokens) AS output_tokens, SUM(a.runs) AS runs "
            "FROM assistant_usage a LEFT JOIN ai_models m ON m.id=a.model_id LEFT JOIN ai_channels ch ON ch.id=m.channel_id "
            "WHERE a.day>=? GROUP BY a.model_id ORDER BY SUM(a.input_tokens+a.output_tokens) DESC LIMIT 50", (since_day,))]
        tools = [dict(row) for row in db.execute(
            "SELECT tool_name, COUNT(*) AS calls, COALESCE(SUM(status!='ok'),0) AS errors, CAST(AVG(duration_ms) AS INTEGER) AS avg_ms "
            "FROM assistant_calls WHERE kind='tool' AND started_at>=? AND tool_name IS NOT NULL GROUP BY tool_name "
            "ORDER BY calls DESC LIMIT 60", (since,))]
        stops = [dict(row) for row in db.execute(
            "SELECT COALESCE(stop_reason,'') AS reason, COUNT(*) AS runs FROM assistant_runs WHERE started_at>=? "
            "GROUP BY stop_reason ORDER BY runs DESC", (since,))]
        actions = [dict(row) for row in db.execute(
            "SELECT kind, status, COUNT(*) AS actions, SUM(count) AS items FROM assistant_actions WHERE created_at>=? AND kind!='scope' "
            "GROUP BY kind, status ORDER BY actions DESC", (since,))]
        totals = {"input_tokens": sum(int(r["input_tokens"] or 0) for r in by_day), "output_tokens": sum(int(r["output_tokens"] or 0) for r in by_day),
                  "runs": sum(int(r["runs"] or 0) for r in by_day),
                  "users": int(db.execute("SELECT COUNT(DISTINCT user_id) FROM assistant_usage WHERE day>=?", (since_day,)).fetchone()[0])}
        return {"days": days, "since": since_day, "totals": totals, "by_day": by_day, "by_user": by_user, "by_model": by_model,
                "tools": tools, "stops": stops, "actions": actions}

    # ---------- 调用日志 ----------

    def log_call(self, **fields) -> None:
        values = {name: fields.get(name) for name in CALL_FIELDS}
        values["started_at"] = values["started_at"] or time.time()
        if values["error"]:
            values["error"] = scrub(values["error"], 500)
        try:
            with self.metadata.transaction() as db:
                db.execute(f"INSERT INTO assistant_calls({','.join(CALL_FIELDS)}) VALUES({','.join('?' * len(CALL_FIELDS))})",
                           tuple(values[name] for name in CALL_FIELDS))
        except Exception:  # 日志写入失败不能影响对话本身
            pass

    def list_calls(self, *, cursor: int = 0, limit: int = 50, kind: str = "", status: str = "", channel_id: int | None = None,
                   model_id: int | None = None, tool_name: str = "", user_id: int | None = None,
                   since: float | None = None, until: float | None = None, conversation_id: str = "") -> dict[str, object]:
        limit = max(1, min(limit, 200))
        where, args = self._call_filter(kind=kind, status=status, channel_id=channel_id, model_id=model_id, tool_name=tool_name,
                                        user_id=user_id, since=since, until=until, conversation_id=conversation_id)
        if cursor:
            where.append("c.id<?")
            args.append(cursor)
        rows = self.metadata.db.execute(
            "SELECT c.*, u.username AS username, ch.name AS channel_name, m.model AS model_name, m.display_name AS model_label "
            "FROM assistant_calls c LEFT JOIN users u ON u.id=c.user_id LEFT JOIN ai_channels ch ON ch.id=c.channel_id "
            f"LEFT JOIN ai_models m ON m.id=c.model_id WHERE {' AND '.join(where) or '1'} ORDER BY c.id DESC LIMIT ?",
            (*args, limit + 1)).fetchall()
        return {"calls": [self._call_json(row) for row in rows[:limit]], "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None}

    @staticmethod
    def _call_json(row) -> dict:
        item = dict(row)
        # 上游错误可能回显用户输入；历史日志同样不能向管理端暴露正文。
        if item.get("error") and item["kind"] in ("model", "fetch"):
            item["error"] = "模型请求失败" if item["kind"] == "model" else "网页抓取失败"
        return item

    @staticmethod
    def _call_filter(**filters) -> tuple[list[str], list]:
        where, args = [], []
        for name in ("kind", "status", "tool_name", "conversation_id"):
            if filters.get(name):
                where.append(f"c.{name}=?")
                args.append(filters[name])
        for name in ("channel_id", "model_id", "user_id"):
            if filters.get(name) is not None:
                where.append(f"c.{name}=?")
                args.append(filters[name])
        if filters.get("since") is not None:
            where.append("c.started_at>=?")
            args.append(filters["since"])
        if filters.get("until") is not None:
            where.append("c.started_at<?")
            args.append(filters["until"])
        return where, args

    def call_stats(self, **filters) -> dict[str, object]:
        where, args = self._call_filter(**filters)
        clause = " AND ".join(where) or "1"
        row = self.metadata.db.execute(
            f"SELECT COUNT(*) AS total, COALESCE(SUM(c.status='ok'),0) AS ok, COALESCE(SUM(c.input_tokens),0) AS input_tokens, "
            f"COALESCE(SUM(c.output_tokens),0) AS output_tokens FROM assistant_calls c WHERE {clause}", args).fetchone()
        durations = [r[0] for r in self.metadata.db.execute(
            f"SELECT c.duration_ms FROM assistant_calls c WHERE {clause} AND c.duration_ms IS NOT NULL ORDER BY c.duration_ms LIMIT 20000",
            args)]

        def pct(p: float):
            return durations[min(len(durations) - 1, int(len(durations) * p))] if durations else None
        total = int(row["total"])
        return {"total": total, "ok": int(row["ok"]), "success_rate": (int(row["ok"]) / total) if total else None,
                "p50_ms": pct(0.5), "p95_ms": pct(0.95), "input_tokens": int(row["input_tokens"]),
                "output_tokens": int(row["output_tokens"])}

    def channel_health(self) -> dict[int, dict[str, object]]:
        """每个渠道最近 20 次模型请求的成功率与 P95 延迟。"""
        result: dict[int, dict[str, object]] = {}
        for channel in self.metadata.db.execute("SELECT id FROM ai_channels"):
            rows = self.metadata.db.execute(
                "SELECT status, duration_ms, error FROM assistant_calls WHERE channel_id=? AND kind='model' "
                "ORDER BY id DESC LIMIT 20", (channel["id"],)).fetchall()
            if not rows:
                result[channel["id"]] = {"requests": 0, "success_rate": None, "p95_ms": None, "last_error": None, "unhealthy": False}
                continue
            ok = sum(1 for row in rows if row["status"] == "ok")
            durations = sorted(row["duration_ms"] for row in rows if row["duration_ms"] is not None)
            error = "模型请求失败" if any(row["status"] != "ok" and row["error"] for row in rows) else None
            result[channel["id"]] = {"requests": len(rows), "success_rate": ok / len(rows),
                                     "p95_ms": durations[min(len(durations) - 1, int(len(durations) * 0.95))] if durations else None,
                                     "last_error": error, "unhealthy": ok / len(rows) < 0.5}
        return result

    # ---------- 管理端（只读元数据，不解密任何正文） ----------

    def admin_conversations(self, *, cursor: str = "", limit: int = 50, user_id: int | None = None, model_id: int | None = None,
                            since: float | None = None, until: float | None = None, action: str = "") -> dict[str, object]:
        limit = max(1, min(limit, 200))
        where, args = ["1"], []
        if user_id is not None:
            where.append("c.user_id=?")
            args.append(user_id)
        if model_id is not None:
            where.append("c.model_id=?")
            args.append(model_id)
        if since is not None:
            where.append("c.updated_at>=?")
            args.append(since)
        if until is not None:
            where.append("c.updated_at<?")
            args.append(until)
        if action in ("pending", "done", "failed"):
            status = {"pending": "('pending')", "done": "('done','confirmed','partial')", "failed": "('failed','partial')"}[action]
            where.append(f"EXISTS(SELECT 1 FROM assistant_actions a WHERE a.conversation_id=c.id AND a.status IN {status})")
        if cursor:
            try:
                at, last = cursor.split("|", 1)
            except ValueError as exc:
                raise ValueError("分页游标不正确") from exc
            where.append("(c.updated_at<? OR (c.updated_at=? AND c.id<?))")
            args += [float(at), float(at), last]
        rows = self.metadata.db.execute(
            "SELECT c.id, c.user_id, u.username, c.model_id, m.model AS model_name, m.display_name AS model_label, c.messages, "
            "c.input_tokens, c.output_tokens, c.hidden_at, c.archived, c.created_at, c.updated_at, "
            "(SELECT COUNT(*) FROM assistant_runs r WHERE r.conversation_id=c.id) AS runs, "
            "(SELECT COUNT(*) FROM assistant_actions a WHERE a.conversation_id=c.id) AS actions "
            "FROM assistant_conversations c LEFT JOIN users u ON u.id=c.user_id LEFT JOIN ai_models m ON m.id=c.model_id "
            f"WHERE {' AND '.join(where)} ORDER BY c.updated_at DESC, c.id DESC LIMIT ?", (*args, limit + 1)).fetchall()
        items = [{**dict(row), "hidden": row["hidden_at"] is not None} for row in rows[:limit]]
        next_cursor = f"{rows[limit - 1]['updated_at']!r}|{rows[limit - 1]['id']}" if len(rows) > limit else None
        return {"conversations": items, "next_cursor": next_cursor}

    def admin_conversation(self, conversation_id: str) -> dict[str, object]:
        row = self.metadata.db.execute(
            "SELECT c.id, c.user_id, u.username, c.model_id, c.messages, c.input_tokens, c.output_tokens, c.hidden_at, "
            "c.created_at, c.updated_at FROM assistant_conversations c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=?",
            (conversation_id,)).fetchone()
        if row is None:
            raise NotFoundError("对话不存在")
        runs = [dict(r) for r in self.metadata.db.execute(
            "SELECT id, model_id, status, stop_reason, steps, tool_calls, input_tokens, output_tokens, started_at, ended_at "
            "FROM assistant_runs WHERE conversation_id=? ORDER BY started_at", (conversation_id,))]
        tools = [dict(r) for r in self.metadata.db.execute(
            "SELECT tool_name, COUNT(*) AS count FROM assistant_messages WHERE conversation_id=? AND role='tool' "
            "GROUP BY tool_name ORDER BY count DESC", (conversation_id,))]
        actions = [dict(r) for r in self.metadata.db.execute(
            "SELECT id, kind, tool_name, status, count, created_at, decided_at, finished_at FROM assistant_actions "
            "WHERE conversation_id=? ORDER BY created_at", (conversation_id,))]
        return {**dict(row), "hidden": row["hidden_at"] is not None, "runs": runs, "tools": tools, "actions": actions}

    def admin_delete(self, *, user_id: int | None = None, before: float | None = None) -> int:
        if user_id is None and before is None:
            raise ValueError("请至少指定用户或时间")
        where, args = [], []
        if user_id is not None:
            where.append("user_id=?")
            args.append(user_id)
        if before is not None:
            where.append("updated_at<?")
            args.append(before)
        with self.metadata.transaction() as db:
            return db.execute(f"DELETE FROM assistant_conversations WHERE {' AND '.join(where)}", args).rowcount

    def admin_count(self, *, user_id: int | None = None, before: float | None = None) -> int:
        where, args = ["1"], []
        if user_id is not None:
            where.append("user_id=?")
            args.append(user_id)
        if before is not None:
            where.append("updated_at<?")
            args.append(before)
        return int(self.metadata.db.execute(f"SELECT COUNT(*) FROM assistant_conversations WHERE {' AND '.join(where)}", args).fetchone()[0])

    def storage(self) -> dict[str, int]:
        result = {}
        for table in ("assistant_conversations", "assistant_messages", "assistant_runs", "assistant_actions", "assistant_calls"):
            result[table] = int(self.metadata.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        size = self.metadata.db.execute("SELECT COALESCE(SUM(length(body)),0) FROM assistant_messages").fetchone()[0]
        result["message_bytes"] = int(size)
        return result

    def purge_all(self) -> None:
        with self.metadata.transaction() as db:
            for table in ("assistant_conversations", "assistant_usage", "assistant_calls"):
                db.execute(f"DELETE FROM {table}")

    # ---------- 清理（维护任务） ----------

    def cleanup(self, *, retention_days: int, call_log_days: int, now: float | None = None, batch: int = 2000) -> dict[str, int]:
        now = now or time.time()
        report = {"conversations": 0, "calls": 0, "actions_expired": 0, "actions_compacted": 0, "collections": 0, "usage": 0}

        def batched(select: str, delete: str, args: tuple) -> int:
            with self.metadata.transaction() as db:
                ids = [row[0] for row in db.execute(select + " LIMIT ?", (*args, batch))]
                for value in ids:
                    db.execute(delete, (value,))
                return len(ids)

        report["conversations"] = batched("SELECT id FROM assistant_conversations WHERE updated_at<?",
                                          "DELETE FROM assistant_conversations WHERE id=?", (now - retention_days * 86400,))
        report["calls"] = batched("SELECT id FROM assistant_calls WHERE started_at<?", "DELETE FROM assistant_calls WHERE id=?",
                                  (now - call_log_days * 86400,))
        report["collections"] = batched("SELECT id FROM assistant_collections WHERE expires_at<?",
                                        "DELETE FROM assistant_collections WHERE id=?", (now,))
        with self.metadata.transaction() as db:
            report["actions_expired"] = db.execute(
                "UPDATE assistant_actions SET status='expired', decided_at=? WHERE id IN "
                "(SELECT id FROM assistant_actions WHERE status='pending' AND expires_at<=? LIMIT ?)", (now, now, batch)).rowcount
            db.execute("UPDATE assistant_actions SET undo=NULL WHERE id IN "
                       "(SELECT id FROM assistant_actions WHERE undo IS NOT NULL AND finished_at<? LIMIT ?)", (now - 86400, batch))
            report["usage"] = db.execute("DELETE FROM assistant_usage WHERE rowid IN "
                                                 "(SELECT rowid FROM assistant_usage WHERE day<? LIMIT ?)", (today(now - 400 * 86400), batch)).rowcount
        # 终态 30 天后把完整条目压缩成摘要（类型、条目数、前 20 条样例）。
        rows = self.metadata.db.execute(
            "SELECT * FROM assistant_actions WHERE compacted=0 AND status NOT IN ('pending','running','undoing') "
            "AND COALESCE(finished_at, decided_at, created_at)<? LIMIT ?", (now - 30 * 86400, batch)).fetchall()
        for row in rows:
            try:
                payload = self.action_payload(row)
            except Exception:
                continue
            if isinstance(payload, dict) and "items" in payload:
                payload = {**payload, "items": payload["items"][:self.SAMPLES], "skipped": payload.get("skipped", [])[:self.SAMPLES]}
            with self.metadata.transaction() as db:
                db.execute("UPDATE assistant_actions SET payload=?, compacted=1 WHERE id=?",
                           (self._seal(payload, f"assistant-action:{row['id']}"), row["id"]))
            report["actions_compacted"] += 1
        return report
