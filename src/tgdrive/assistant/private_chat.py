"""私密对话的内存留痕（docs/assistant-design.md §24.3）。

私密对话不写 assistant_conversations／messages／runs／actions／collections：消息、工具结果、待确认操作与结果集
都放在进程内存，随私密授权一起消失（锁定、闲置过期、退出、改密、重启）。MemoryTrace 实现 TraceStore 中与单个对话
有关的接口，RoutedTrace 按编号前缀把调用分给内存或数据库，Agent 循环与操作执行因此不需要区分两种对话。
"""

from __future__ import annotations

import copy
import json
import secrets
import threading
import time

from ..errors import NotFoundError

# 私密对话的编号前缀：对话、运行、待确认操作、结果集。普通对话的编号是 c_／r_／a_／g_／s_。
PRIVATE_IDS = ("pc_", "pr_", "pa_", "pg_")


def is_private(value: object) -> bool:
    return isinstance(value, str) and value.startswith(PRIVATE_IDS)


def _copy(value):
    """保存与读出都复制一份，调用方修改返回值不会影响内存中的记录（与数据库读写语义一致）。"""
    return None if value is None else json.loads(json.dumps(value, ensure_ascii=False))


class MemoryTrace:
    SAMPLES = 20

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.conversations: dict[str, dict] = {}
        self.messages_by: dict[str, list[dict]] = {}
        self.runs: dict[str, dict] = {}
        self.action_rows: dict[str, dict] = {}
        self.collections: dict[str, dict] = {}

    # ---------- 生命周期 ----------

    def drop(self, conversation_id: str) -> None:
        """清除一个私密对话的全部内存数据。"""
        with self._lock:
            self.conversations.pop(conversation_id, None)
            self.messages_by.pop(conversation_id, None)
            for store in (self.runs, self.action_rows, self.collections):
                for key in [key for key, row in store.items() if row["conversation_id"] == conversation_id]:
                    store.pop(key, None)

    # ---------- 对话 ----------

    def create_conversation(self, user_id: int, scope_root: str, model_id: int | None, *, keep: int = 1) -> str:
        conversation_id = "pc_" + secrets.token_urlsafe(12)
        now = time.time()
        with self._lock:
            self.conversations[conversation_id] = {
                "id": conversation_id, "user_id": user_id, "title": None, "scope_root": scope_root, "model_id": model_id,
                "archived": 0, "access_mode": "approval", "messages": 0, "hidden_at": None, "created_at": now, "updated_at": now,
                "input_tokens": 0, "output_tokens": 0}
            self.messages_by[conversation_id] = []
        return conversation_id

    def conversation(self, user_id: int, conversation_id: str, *, include_hidden: bool = False) -> dict:
        row = self.conversations.get(conversation_id)
        if row is None or row["user_id"] != user_id:
            raise NotFoundError("对话不存在")
        return dict(row)

    @staticmethod
    def conversation_json(row) -> dict[str, object]:
        return {"id": row["id"], "title": row["title"], "scope_root": row["scope_root"], "model_id": row["model_id"],
                "archived": False, "access_mode": row["access_mode"] if row["access_mode"] in ("approval", "full") else "approval",
                "messages": row["messages"], "created_at": row["created_at"], "updated_at": row["updated_at"], "private": True}

    def update_conversation(self, user_id: int, conversation_id: str, *, title=None, archived=None, scope_root=None,
                            model_id=None, access_mode=None) -> None:
        self.conversation(user_id, conversation_id)
        with self._lock:
            row = self.conversations[conversation_id]
            for name, value in (("title", title), ("scope_root", scope_root), ("model_id", model_id), ("access_mode", access_mode)):
                if value is not None:
                    row[name] = value

    def hide_conversation(self, user_id: int, conversation_id: str) -> None:
        self.conversation(user_id, conversation_id)
        self.drop(conversation_id)

    # ---------- 消息 ----------

    def append(self, conversation_id: str, run_id: str | None, role: str, body: dict, *, tool_name: str | None = None) -> int:
        now = time.time()
        with self._lock:
            row = self.conversations.get(conversation_id)
            if row is None:
                raise NotFoundError("对话不存在")
            messages = self.messages_by[conversation_id]
            seq = (messages[-1]["seq"] if messages else 0) + 1
            messages.append({"seq": seq, "run_id": run_id, "role": role, "tool_name": tool_name, "created_at": now, "body": _copy(body)})
            row["messages"] += 1
            row["updated_at"] = now
        return seq

    def update_message(self, conversation_id: str, seq: int, body: dict) -> None:
        with self._lock:
            for message in self.messages_by.get(conversation_id, []):
                if message["seq"] == seq:
                    message["body"] = _copy(body)

    def message(self, conversation_id: str, seq: int) -> dict[str, object] | None:
        found = self.messages(conversation_id, after=seq - 1, limit=1)
        return found[0] if found and found[0]["seq"] == seq else None

    def truncate(self, conversation_id: str, seq: int) -> int:
        now = time.time()
        with self._lock:
            messages = self.messages_by.get(conversation_id, [])
            runs = {m["run_id"] for m in messages if m["seq"] >= seq and m["run_id"]}
            for action in self.action_rows.values():
                if action["conversation_id"] == conversation_id and action["status"] == "pending" and action["run_id"] in runs:
                    action.update(status="expired", decided_at=now)
            kept = [m for m in messages if m["seq"] < seq]
            removed = len(messages) - len(kept)
            self.messages_by[conversation_id] = kept
            if conversation_id in self.conversations:
                row = self.conversations[conversation_id]
                row["messages"] = max(0, row["messages"] - removed)
                row["updated_at"] = now
        return removed

    def messages(self, conversation_id: str, *, after: int = 0, limit: int = 500) -> list[dict[str, object]]:
        with self._lock:
            rows = [m for m in self.messages_by.get(conversation_id, []) if m["seq"] > after][:limit]
            return [{"seq": m["seq"], "run_id": m["run_id"], "role": m["role"], "tool_name": m["tool_name"],
                     "created_at": m["created_at"], **_copy(m["body"])} for m in rows]

    def latest_plan(self, conversation_id: str) -> dict | None:
        with self._lock:
            for message in reversed(self.messages_by.get(conversation_id, [])):
                if message["role"] == "event" and message["tool_name"] == "update_plan":
                    return _copy(message["body"].get("event"))
        return None

    def taint(self, conversation_id: str, names: list[str]) -> str | None:
        """最近一次摘要之后读取外部内容的工具名（与 AssistantService._conversation_taint 的 SQL 等价）。"""
        with self._lock:
            messages = self.messages_by.get(conversation_id, [])
            floor = max((m["seq"] for m in messages if m["role"] == "event" and m["tool_name"] == "summary"), default=0)
            for message in reversed(messages):
                if message["seq"] > floor and message["role"] == "tool" and message["tool_name"] in names:
                    return message["tool_name"]
        return None

    # ---------- 运行 ----------

    def start_run(self, conversation_id: str, model_id: int, prompt_version: str) -> str:
        run_id = "pr_" + secrets.token_urlsafe(12)
        with self._lock:
            self.runs[run_id] = {"id": run_id, "conversation_id": conversation_id, "status": "running", "stop_reason": None,
                                 "started_at": time.time()}
        return run_id

    def finish_run(self, run_id: str, *, status: str, stop_reason: str | None, steps: int, tool_calls: int,
                   input_tokens: int, output_tokens: int) -> None:
        with self._lock:
            run = self.runs.get(run_id)
            if run is None:
                return
            run.update(status=status, stop_reason=stop_reason, ended_at=time.time())
            row = self.conversations.get(run["conversation_id"])
            if row is not None:
                row["input_tokens"] += input_tokens
                row["output_tokens"] += output_tokens

    def run(self, user_id: int, run_id: str) -> dict | None:
        run = self.runs.get(run_id)
        if run is None or self.conversations.get(run["conversation_id"], {}).get("user_id") != user_id:
            return None
        return dict(run)

    # ---------- 待确认操作 ----------

    def create_action(self, conversation_id: str, run_id: str, user_id: int, session_hash: str, kind: str, tool_name: str,
                      payload: dict, *, count: int, ttl: float = 900, keep_pending: int = 5) -> str:
        action_id = "pa_" + secrets.token_urlsafe(12)
        now = time.time()
        with self._lock:
            pending = sorted((a for a in self.action_rows.values() if a["conversation_id"] == conversation_id and a["status"] == "pending"),
                             key=lambda a: a["created_at"], reverse=True)
            for action in pending[keep_pending - 1:]:
                action.update(status="expired", decided_at=now)
            self.action_rows[action_id] = {
                "id": action_id, "conversation_id": conversation_id, "run_id": run_id, "user_id": user_id, "session_hash": session_hash,
                "kind": kind, "tool_name": tool_name, "status": "pending", "count": count, "payload": _copy(payload),
                "result": None, "undo": None, "created_at": now, "expires_at": now + ttl, "decided_at": None, "finished_at": None,
                "compacted": 0}
        return action_id

    def action(self, user_id: int, action_id: str) -> dict:
        row = self.action_rows.get(action_id)
        if row is None or row["user_id"] != user_id or row["conversation_id"] not in self.conversations:
            raise NotFoundError("操作不存在")
        return dict(row)

    def action_payload(self, row) -> dict:
        return _copy(row["payload"])

    def action_json(self, row) -> dict[str, object]:
        status = row["status"]
        if status == "pending" and row["expires_at"] <= time.time():
            status = "expired"
        payload = self.action_payload(row)
        if isinstance(payload, dict) and "items" in payload:
            payload = {**{key: value for key, value in payload.items() if key != "items"}, "samples": payload["items"][:self.SAMPLES]}
        return {"id": row["id"], "kind": row["kind"], "tool_name": row["tool_name"], "status": status, "count": row["count"],
                "payload": payload, "result": _copy(row["result"]),
                "undoable": row["undo"] is not None and status in ("done", "partial", "cancelled")
                and (row["finished_at"] or 0) > time.time() - 86400,
                "created_at": row["created_at"], "expires_at": row["expires_at"], "decided_at": row["decided_at"],
                "finished_at": row["finished_at"], "private": True}

    def action_items(self, row, *, offset: int = 0, limit: int = 100) -> dict[str, object]:
        payload = self.action_payload(row)
        items = payload.get("items", []) if isinstance(payload, dict) else []
        limit = max(1, min(limit, 500))
        return {"items": items[offset:offset + limit], "skipped": payload.get("skipped", []) if offset == 0 and isinstance(payload, dict) else [],
                "total": len(items), "next_offset": offset + limit if offset + limit < len(items) else None, "compacted": False}

    def _update_action(self, action_id: str, when, **values) -> bool:
        with self._lock:
            row = self.action_rows.get(action_id)
            if row is None or not when(row):
                return False
            row.update(values)
            return True

    def start_action(self, action_id: str) -> bool:
        now = time.time()
        return self._update_action(action_id, lambda r: r["status"] == "pending" and r["expires_at"] > now, status="running", decided_at=now)

    def action_recorder(self, action_id: str, conversation_id: str):
        def finish(status: str, result: dict, undo: dict | None, event: dict) -> None:
            if not self._update_action(action_id, lambda r: True, status=status, finished_at=time.time(), result=_copy(result), undo=_copy(undo)):
                return  # 对话已经清除，不重新创建记录。
            try:
                self.append(conversation_id, None, "event", event)
            except NotFoundError:
                pass
        return finish

    def action_undo(self, row) -> dict | None:
        return _copy(row["undo"])

    def take_undo(self, action_id: str) -> bool:
        limit = time.time() - 86400
        return self._update_action(action_id, lambda r: r["undo"] is not None and r["status"] in ("done", "partial", "cancelled")
                                   and (r["finished_at"] or 0) > limit, status="undoing")

    def restore_action(self, action_id: str, status: str) -> None:
        """撤销失败时把 undoing 恢复为原状态（数据库版本在 service 里用 SQL 完成）。"""
        self._update_action(action_id, lambda r: r["status"] == "undoing", status=status)

    def finish_undo(self, action_id: str, result: dict) -> None:
        self._update_action(action_id, lambda r: True, status="undone", undo=None, result=_copy(result))

    def actions(self, conversation_id: str) -> list[dict[str, object]]:
        with self._lock:
            rows = sorted((dict(a) for a in self.action_rows.values() if a["conversation_id"] == conversation_id),
                          key=lambda a: a["created_at"])
        return [self.action_json(row) for row in rows]

    def decide_action(self, action_id: str, status: str, result: dict | None = None) -> bool:
        now = time.time()
        return self._update_action(action_id, lambda r: r["status"] == "pending" and r["expires_at"] > now,
                                   status=status, decided_at=now, finished_at=now, result=_copy(result))

    def expire_session_actions(self, session_hash: str) -> None:
        now = time.time()
        with self._lock:
            for action in self.action_rows.values():
                if action["session_hash"] == session_hash and action["status"] == "pending":
                    action.update(status="expired", decided_at=now)

    def pending_actions(self, conversation_id: str) -> list[dict[str, object]]:
        now = time.time()
        with self._lock:
            rows = sorted((a for a in self.action_rows.values() if a["conversation_id"] == conversation_id
                           and a["status"] == "pending" and a["expires_at"] > now), key=lambda a: a["created_at"])
            return [{"id": a["id"], "kind": a["kind"], "count": a["count"]} for a in rows]

    def expire_actions(self, conversation_id: str | None = None, *, user_id: int | None = None, tool_names: list[str] | None = None) -> int:
        now, count = time.time(), 0
        with self._lock:
            for action in self.action_rows.values():
                if action["status"] != "pending":
                    continue
                if (conversation_id is not None and action["conversation_id"] != conversation_id) or \
                        (user_id is not None and action["user_id"] != user_id) or (tool_names and action["tool_name"] not in tool_names):
                    continue
                action.update(status="expired", decided_at=now)
                count += 1
        return count

    # ---------- 结果集 ----------

    def create_collection(self, conversation_id: str, user_id: int, kind: str, *, source: str | None, rule: dict | None,
                          urls: list, count: int, ttl: float = 86400) -> str:
        collection_id = "pg_" + secrets.token_urlsafe(12)
        now = time.time()
        with self._lock:
            self.collections[collection_id] = {"id": collection_id, "conversation_id": conversation_id, "user_id": user_id, "kind": kind,
                                               "source": source, "rule": _copy(rule), "urls": _copy(urls), "count": count,
                                               "created_at": now, "expires_at": now + ttl}
        return collection_id

    def collection(self, user_id: int, collection_id: str, *, kind: str | None = None) -> dict[str, object]:
        row = self.collections.get(collection_id)
        if row is None or row["user_id"] != user_id or row["expires_at"] <= time.time() or (kind is not None and row["kind"] != kind):
            raise NotFoundError("结果集不存在或已过期（保留 24 小时）")
        return copy.deepcopy(row)

    def update_collection(self, collection_id: str, *, rule: dict | None = None, urls: list | None = None) -> None:
        with self._lock:
            row = self.collections.get(collection_id)
            if row is None:
                return
            if rule is not None:
                row["rule"] = _copy(rule)
            if urls is not None:
                row["urls"], row["count"] = _copy(urls), len(urls)


class RoutedTrace:
    """按编号前缀把留痕调用分给内存（私密对话）或数据库（普通对话）；其余调用（用量、调用日志、管理端）直接交给数据库。"""

    def __init__(self, db, memory: MemoryTrace) -> None:
        self.db, self.memory = db, memory

    def __getattr__(self, name):
        return getattr(self.db, name)

    def _by(self, value):
        return self.memory if is_private(value) else self.db

    def conversation(self, user_id, conversation_id, **options):
        return self._by(conversation_id).conversation(user_id, conversation_id, **options)

    def conversation_json(self, row):
        return self._by(row["id"]).conversation_json(row)

    def update_conversation(self, user_id, conversation_id, **options):
        return self._by(conversation_id).update_conversation(user_id, conversation_id, **options)

    def hide_conversation(self, user_id, conversation_id):
        return self._by(conversation_id).hide_conversation(user_id, conversation_id)

    def append(self, conversation_id, *args, **options):
        return self._by(conversation_id).append(conversation_id, *args, **options)

    def update_message(self, conversation_id, *args):
        return self._by(conversation_id).update_message(conversation_id, *args)

    def message(self, conversation_id, seq):
        return self._by(conversation_id).message(conversation_id, seq)

    def truncate(self, conversation_id, seq):
        return self._by(conversation_id).truncate(conversation_id, seq)

    def messages(self, conversation_id, **options):
        return self._by(conversation_id).messages(conversation_id, **options)

    def latest_plan(self, conversation_id):
        return self._by(conversation_id).latest_plan(conversation_id)

    def start_run(self, conversation_id, *args):
        return self._by(conversation_id).start_run(conversation_id, *args)

    def finish_run(self, run_id, **options):
        return self._by(run_id).finish_run(run_id, **options)

    def create_action(self, conversation_id, *args, **options):
        return self._by(conversation_id).create_action(conversation_id, *args, **options)

    def action(self, user_id, action_id):
        return self._by(action_id).action(user_id, action_id)

    def action_payload(self, row):
        return self._by(row["id"]).action_payload(row)

    def action_json(self, row):
        return self._by(row["id"]).action_json(row)

    def action_items(self, row, **options):
        return self._by(row["id"]).action_items(row, **options)

    def start_action(self, action_id):
        return self._by(action_id).start_action(action_id)

    def action_recorder(self, action_id, conversation_id):
        return self._by(action_id).action_recorder(action_id, conversation_id)

    def action_undo(self, row):
        return self._by(row["id"]).action_undo(row)

    def take_undo(self, action_id):
        return self._by(action_id).take_undo(action_id)

    def finish_undo(self, action_id, result):
        return self._by(action_id).finish_undo(action_id, result)

    def actions(self, conversation_id):
        return self._by(conversation_id).actions(conversation_id)

    def decide_action(self, action_id, *args, **options):
        return self._by(action_id).decide_action(action_id, *args, **options)

    def pending_actions(self, conversation_id):
        return self._by(conversation_id).pending_actions(conversation_id)

    def expire_session_actions(self, session_hash):
        self.memory.expire_session_actions(session_hash)
        return self.db.expire_session_actions(session_hash)

    def expire_actions(self, conversation_id=None, **options):
        if conversation_id is not None:
            return self._by(conversation_id).expire_actions(conversation_id, **options)
        return self.memory.expire_actions(**options) + self.db.expire_actions(**options)

    def create_collection(self, conversation_id, *args, **options):
        return self._by(conversation_id).create_collection(conversation_id, *args, **options)

    def collection(self, user_id, collection_id, **options):
        return self._by(collection_id).collection(user_id, collection_id, **options)

    def update_collection(self, collection_id, **options):
        return self._by(collection_id).update_collection(collection_id, **options)

    def log_call(self, **fields):
        # 私密对话的调用日志不关联对话、运行或操作，只记 private 标记（§24.9）。
        if any(is_private(fields.get(name)) for name in ("conversation_id", "run_id", "action_id")) or fields.get("private"):
            if fields.get("kind") == "tool":
                return None  # 私密对话的工具执行不写调用日志，只保留模型请求与网页请求的元数据。
            fields = {**fields, "conversation_id": None, "run_id": None, "action_id": None, "tool_name": None, "private": True}
        return self.db.log_call(**fields)
