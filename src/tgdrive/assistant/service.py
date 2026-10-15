"""文件助手服务：Agent 循环、运行状态与事件流、用户端与管理端服务方法（docs/assistant-design.md §2、§5、§6、§10）。

每条用户消息触发一个 run，在服务端以 asyncio 任务运行，与 HTTP 连接解耦：事件进入内存环形缓冲（断线后按 seq 续读），
消息与工具调用同时落库。每一步模型调用前都重新校验：系统已解锁、会话有效、账号可用、助手与模型仍启用、额度未用尽。
"""

from __future__ import annotations

import asyncio
import collections
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime

from ..api import normalize_user_path
from ..authn import AuthenticationError
from ..errors import NotFoundError, NotReadyError
from . import prompts, providers
from .channels import ChannelStore
from .config import LIMITS, AssistantConfig
from .providers import ProviderError, ToolDef
from .tools import TOOLS, ToolContext, ToolError, describe_tools, effective_tools, tool_params, validate_tool_settings
from .trace import TraceStore

log = logging.getLogger(__name__)

EVENT_BUFFER = 2000
EVENT_KEEP_SECONDS = 600
MAX_TEXT = 8000
STORED_RESULT = 256 * 1024


def session_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def display(key: str) -> str:
    return "/" + key


@dataclass
class RunState:
    id: str
    conversation_id: str
    user_id: int
    bucket_id: int
    token: str
    model_id: int
    view: str
    location: str
    events: collections.deque = field(default_factory=lambda: collections.deque(maxlen=EVENT_BUFFER))
    seq: int = 0
    status: str = "queued"
    stop_reason: str | None = None
    finished_at: float | None = None
    task: asyncio.Task | None = None
    changed: asyncio.Condition = field(default_factory=asyncio.Condition)

    async def emit(self, event: dict) -> None:
        self.seq += 1
        self.events.append({"seq": self.seq, **event})
        async with self.changed:
            self.changed.notify_all()


class AssistantDenied(PermissionError):
    """助手对当前用户不可用（未启用、未开放、无模型）。HTTP 层返回 403 并展示原因。"""


class StopRun(Exception):
    def __init__(self, reason: str, text: str):
        super().__init__(text)
        self.reason, self.text = reason, text


class AssistantService:
    def __init__(self, accounts, objects, offline=None, *, user_api=None) -> None:
        self.accounts, self.objects, self.offline, self.user_api = accounts, objects, offline, user_api
        self.metadata, self.keystore = accounts.metadata, accounts.keystore
        self.config = AssistantConfig(self.metadata)
        self.trace = TraceStore(self.metadata, self.keystore)
        self.channels = ChannelStore(self.metadata, self.keystore, log_call=self.trace.log_call)
        self.chat = providers.chat  # 测试可替换为脚本化的假模型
        self.runs: dict[str, RunState] = {}
        self._minute: dict[int, collections.deque] = {}
        self._active = 0
        self._channel_active: dict[int, int] = {}
        self._waiters: list[asyncio.Future] = []
        self.trace.interrupt_stale_runs()

    # ---------- 会话与权限 ----------

    def _session(self, token: str, *, csrf: str | None = None, mutation: bool = False):
        if not self.keystore.unlocked:
            raise NotReadyError("system is locked")
        session = self.accounts.sessions.require(token, csrf=csrf, mutation=mutation)
        account = self.accounts.account_for_session(session)
        if account.bucket_id is None:
            raise PermissionError("该账号没有文件空间")
        return session, account

    def _availability(self, user_id: int) -> tuple[bool, str | None]:
        if not self.config.enabled:
            return False, "管理员尚未启用文件助手"
        if not self.config.policy(user_id)["effective"]["enabled"]:
            return False, "管理员未对你的账号开放文件助手"
        if not self.channels.usable():
            return False, "暂无可用的模型"
        return True, None

    def _require_available(self, user_id: int) -> None:
        available, reason = self._availability(user_id)
        if not available:
            raise AssistantDenied(reason)

    def _tool_settings(self) -> dict[str, dict]:
        return self.config.tool_settings()

    def _user_tools(self, user_id: int):
        level = self.config.policy(user_id)["effective"]["max_level"]
        return effective_tools(self._tool_settings(), level)

    def _choose_model(self, requested: object, fallback: int | None) -> int:
        for candidate in (requested, fallback, self.config.default_model):
            if isinstance(candidate, int) and not isinstance(candidate, bool) and self.channels.is_usable(candidate):
                return candidate
        usable = self.channels.usable()
        if not usable:
            raise AssistantDenied("暂无可用的模型")
        return int(usable[0]["id"])

    @staticmethod
    def _location(value: object) -> str:
        if value in (None, "", "/"):
            return ""
        if not isinstance(value, str):
            raise ValueError("位置参数不正确")
        text = value.strip().lstrip("/")
        if not text:
            return ""
        if text.startswith(".tgdrive"):
            return ""  # 私密空间、回收站等系统区域不能作为作用域
        return normalize_user_path(text, directory=True)

    # ---------- 用户端：配置 ----------

    def user_config(self, token: str) -> dict[str, object]:
        session, account = self._session(token)
        available, reason = self._availability(account.id)
        policy = self.config.policy(account.id)
        level = policy["effective"]["max_level"]
        enabled = self._user_tools(account.id) if available else {}
        tools = []
        for item in describe_tools(self._tool_settings()):
            reason_off = None
            if not item["enabled"]:
                reason_off = "管理员已关闭"
            elif item["name"] not in enabled:
                reason_off = "你的账号仅允许只读" if level == "read" else "暂不可用"
            tools.append({"name": item["name"], "label": item["label"], "group": item["group"], "group_label": item["group_label"],
                          "level": item["level"], "description": item["description"].split("。")[0] + "。",
                          "available": reason_off is None, "reason": reason_off, "warning": item["warning"]})
        daily = int(policy["effective"]["daily_tokens"])
        return {"available": available, "reason": reason, "models": self.channels.usable() if available else [],
                "default_model": self.config.default_model, "tools": tools, "max_level": level,
                "usage": {"today": self.trace.tokens_today(account.id), "limit": daily or None},
                "notice": self.config.notice, "notice_ack": policy["notice_ack_at"] is not None,
                "retention_days": self.config.setting("retention_days")}

    def ack_notice(self, token: str, csrf: str) -> None:
        _, account = self._session(token, csrf=csrf, mutation=True)
        self.config.acknowledge_notice(account.id, time.time())

    # ---------- 用户端：对话 ----------

    def list_conversations(self, token: str, *, cursor: str = "", archived: bool = False) -> dict[str, object]:
        _, account = self._session(token)
        result = self.trace.list_conversations(account.id, cursor=cursor, archived=archived)
        for item in result["conversations"]:
            item["scope"] = display(item.pop("scope_root"))
            item["active_run"] = self._active_run(item["id"])
        return result

    def _active_run(self, conversation_id: str) -> str | None:
        for run in self.runs.values():
            if run.conversation_id == conversation_id and run.finished_at is None:
                return run.id
        return None

    def create_conversation(self, token: str, csrf: str, payload: dict) -> dict[str, object]:
        _, account = self._session(token, csrf=csrf, mutation=True)
        self._require_available(account.id)
        scope_root = self._location(payload.get("location"))
        model_id = self._choose_model(payload.get("model_id"), None)
        conversation_id = self.trace.create_conversation(account.id, scope_root, model_id,
                                                         keep=self.config.limits()["max_conversations"])
        return self.conversation(token, conversation_id)

    def conversation(self, token: str, conversation_id: str) -> dict[str, object]:
        _, account = self._session(token)
        row = self.trace.conversation(account.id, conversation_id)
        item = self.trace.conversation_json(row)
        item["scope"] = display(item.pop("scope_root"))
        return {"conversation": item, "messages": [self._public_message(m) for m in self.trace.messages(conversation_id, limit=2000)],
                "actions": self.trace.actions(conversation_id), "active_run": self._active_run(conversation_id)}

    @staticmethod
    def _public_message(message: dict) -> dict:
        """发给浏览器的消息：去掉只给模型看的包装文本。"""
        return {key: value for key, value in message.items() if key not in ("model_content",)}

    def update_conversation(self, token: str, csrf: str, conversation_id: str, payload: dict) -> dict[str, object]:
        _, account = self._session(token, csrf=csrf, mutation=True)
        unknown = set(payload) - {"title", "archived"}
        if unknown:
            raise ValueError(f"未知字段：{', '.join(sorted(unknown))}")
        title = payload.get("title")
        if title is not None and (not isinstance(title, str) or not 1 <= len(title.strip()) <= 60):
            raise ValueError("标题需要 1–60 个字符")
        archived = payload.get("archived")
        if archived is not None and not isinstance(archived, bool):
            raise ValueError("archived 必须是布尔值")
        self.trace.update_conversation(account.id, conversation_id, title=title.strip() if title else None, archived=archived)
        return self.trace.conversation_json(self.trace.conversation(account.id, conversation_id))

    def delete_conversation(self, token: str, csrf: str, conversation_id: str) -> None:
        _, account = self._session(token, csrf=csrf, mutation=True)
        run_id = self._active_run(conversation_id)
        if run_id and self.runs[run_id].user_id == account.id and self.runs[run_id].task:
            self.runs[run_id].task.cancel()
        self.trace.hide_conversation(account.id, conversation_id)

    # ---------- 用户端：发送与运行 ----------

    def _check_rate(self, user_id: int, limits: dict[str, int]) -> None:
        now = time.monotonic()
        window = self._minute.setdefault(user_id, collections.deque())
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= limits["user_messages_per_minute"]:
            raise ValueError("发送太频繁，请稍后再试")
        window.append(now)

    def _check_budget(self, user_id: int) -> None:
        daily = int(self.config.policy(user_id)["effective"]["daily_tokens"])
        if daily and self.trace.tokens_today(user_id) >= daily:
            raise ValueError("今日助手额度已用完，明天 0 点后重置")

    async def send(self, token: str, csrf: str, conversation_id: str, payload: dict) -> dict[str, object]:
        session, account = self._session(token, csrf=csrf, mutation=True)
        self._require_available(account.id)
        policy = self.config.policy(account.id)
        if policy["notice_ack_at"] is None:
            raise ValueError("请先阅读并确认文件助手的使用说明")
        row = self.trace.conversation(account.id, conversation_id)
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("请输入消息")
        if len(text) > MAX_TEXT:
            raise ValueError(f"消息最多 {MAX_TEXT} 个字符")
        limits = self.config.limits()
        if row["messages"] >= limits["max_messages"]:
            raise ValueError("这个对话已经很长了，请新建对话继续")
        if self._active_run(conversation_id):
            raise ValueError("上一条消息还在处理，请稍候或先停止")
        active = sum(1 for run in self.runs.values() if run.user_id == account.id and run.finished_at is None)
        if active >= limits["user_concurrency"]:
            raise ValueError("你有其他对话正在处理，请稍候")
        self._check_budget(account.id)
        self._check_rate(account.id, limits)
        model_id = self._choose_model(payload.get("model_id"), row["model_id"])
        view = payload.get("view") if isinstance(payload.get("view"), str) and len(payload.get("view")) <= 20 else "files"
        location = self._location(payload.get("location"))
        scope_root = row["scope_root"]
        choice = payload.get("scope")
        if choice not in (None, "conversation", "location", "root"):
            raise ValueError("作用域选项不正确")
        new_scope = {"location": location, "root": ""}.get(choice or "conversation", scope_root)
        if model_id != row["model_id"]:
            self.trace.update_conversation(account.id, conversation_id, model_id=model_id)
            if row["model_id"] is not None:
                model = self.channels.model(model_id)
                self.trace.append(conversation_id, None, "event", {"type": "model_switched", "text": f"已切换到 {model['label']}"})
        if new_scope != scope_root:
            # 用户在界面上直接切换作用域，属于用户本人的操作，不需要再确认。
            self.trace.update_conversation(account.id, conversation_id, scope_root=new_scope)
            self.trace.append(conversation_id, None, "event", {
                "type": "scope_changed", "text": f"作用域：{display(scope_root)} → {display(new_scope)}",
                "model_text": f"[系统事件] 用户把作用域从 {display(scope_root)} 切换为 {display(new_scope)}。"})
        run_id = self.trace.start_run(conversation_id, model_id, prompts.PROMPT_VERSION)
        message_seq = self.trace.append(conversation_id, run_id, "user",
                                        {"text": text.strip(), "location": display(location), "view": view, "scope": display(new_scope)})
        state = self._start(run_id, conversation_id, account, token, model_id, view, location)
        return {"run_id": state.id, "message_seq": message_seq}

    def _start(self, run_id: str, conversation_id: str, account, token: str, model_id: int, view: str, location: str) -> RunState:
        state = RunState(run_id, conversation_id, account.id, account.bucket_id, token, model_id, view, location)
        self.runs[run_id] = state
        state.task = asyncio.get_running_loop().create_task(self._run(state))
        self._gc_runs()
        return state

    def _gc_runs(self) -> None:
        now = time.time()
        for run_id, run in list(self.runs.items()):
            if run.finished_at is not None and now - run.finished_at > EVENT_KEEP_SECONDS:
                self.runs.pop(run_id, None)

    def _run_for(self, user_id: int, run_id: str) -> RunState:
        state = self.runs.get(run_id)
        if state is None or state.user_id != user_id:
            raise NotFoundError("运行不存在或已结束")
        return state

    def stop(self, token: str, csrf: str, run_id: str) -> None:
        _, account = self._session(token, csrf=csrf, mutation=True)
        state = self._run_for(account.id, run_id)
        if state.finished_at is None and state.task is not None:
            state.task.cancel()

    async def events(self, token: str, run_id: str, after: int = 0):
        """事件流：先补发缓冲中 seq>after 的事件，再等待新事件，run 结束后关闭。"""
        _, account = self._session(token)
        state = self.runs.get(run_id)
        if state is None or state.user_id != account.id:
            row = self.metadata.db.execute(
                "SELECT r.status, r.stop_reason FROM assistant_runs r JOIN assistant_conversations c ON c.id=r.conversation_id "
                "WHERE r.id=? AND c.user_id=?", (run_id, account.id)).fetchone()
            if row is None:
                raise NotFoundError("运行不存在")
            yield {"seq": after + 1, "type": "run_finished", "status": row["status"], "stop_reason": row["stop_reason"], "replay": True}
            return
        cursor = after
        while True:
            pending = [event for event in list(state.events) if event["seq"] > cursor]
            for event in pending:
                cursor = event["seq"]
                yield event
            if state.finished_at is not None and not [e for e in state.events if e["seq"] > cursor]:
                return
            async with state.changed:
                if not [e for e in state.events if e["seq"] > cursor] and state.finished_at is None:
                    try:
                        await asyncio.wait_for(state.changed.wait(), 15)
                    except TimeoutError:
                        yield {"type": "ping"}

    # ---------- 作用域请求 ----------

    async def decide_scope(self, token: str, csrf: str, action_id: str, approve: bool) -> dict[str, object]:
        session, account = self._session(token, csrf=csrf, mutation=True)
        row = self.trace.action(account.id, action_id)
        if row["kind"] != "scope":
            raise ValueError("操作类型不正确")
        if row["session_hash"] != session_hash(token):
            raise PermissionError("只能在发起请求的登录会话中确认")
        payload = self.trace.action_json(row)["payload"]
        if not self.trace.decide_action(action_id, "confirmed" if approve else "rejected"):
            raise ValueError("该请求已处理或已过期")
        conversation_id = row["conversation_id"]
        conversation = self.trace.conversation(account.id, conversation_id)
        old, new = payload["from"], payload["to"]
        if approve:
            self.trace.update_conversation(account.id, conversation_id, scope_root=new.lstrip("/"))
        self.trace.append(conversation_id, None, "event", {
            "type": "scope_changed" if approve else "scope_rejected", "action_id": action_id,
            "text": f"作用域：{old} → {new}" if approve else f"已拒绝把作用域切换到 {new}",
            "model_text": prompts.scope_event(old, new, approve)})
        result: dict[str, object] = {"status": "confirmed" if approve else "rejected", "scope": new if approve else old}
        # 用户确认后自动继续，让助手接着完成之前的请求。
        available, _ = self._availability(account.id)
        if available and not self._active_run(conversation_id):
            try:
                self._check_budget(account.id)
                model_id = self._choose_model(None, conversation["model_id"])
                run_id = self.trace.start_run(conversation_id, model_id, prompts.PROMPT_VERSION)
                state = self._start(run_id, conversation_id, account, token, model_id, "files", conversation["scope_root"])
                result["run_id"] = state.id
            except (ValueError, PermissionError):
                pass
        return result

    # ---------- Agent 循环 ----------

    def _validate(self, state: RunState) -> None:
        if not self.keystore.unlocked:
            raise StopRun("locked", "系统已锁定")
        session = self.accounts.sessions.peek(state.token)
        if session is None or session.user_id != state.user_id:
            self.trace.expire_session_actions(session_hash(state.token))
            raise StopRun("session", "登录已失效")
        try:
            self.accounts.account_for_session(session)
        except (AuthenticationError, NotFoundError) as exc:
            raise StopRun("account", "账号已停用") from exc
        available, reason = self._availability(state.user_id)
        if not available:
            raise StopRun("disabled", reason or "文件助手不可用")
        if not self.channels.is_usable(state.model_id):
            raise StopRun("model", "所选模型已停用，请换一个模型")
        daily = int(self.config.policy(state.user_id)["effective"]["daily_tokens"])
        if daily and self.trace.tokens_today(state.user_id) >= daily:
            raise StopRun("daily_limit", "今日助手额度已用完")

    async def _acquire(self, state: RunState) -> None:
        """全局并发：超过上限时排队，并推送排队位置。"""
        while self._active >= self.config.limits()["global_concurrency"]:
            future = asyncio.get_running_loop().create_future()
            self._waiters.append(future)
            await state.emit({"type": "queued", "position": len(self._waiters)})
            try:
                await future
            finally:
                if future in self._waiters:
                    self._waiters.remove(future)
        self._active += 1

    def _release(self) -> None:
        self._active = max(0, self._active - 1)
        while self._waiters:
            future = self._waiters.pop(0)
            if not future.done():
                future.set_result(None)
                break

    async def _channel_slot(self, channel_id: int) -> None:
        limit = self.channels.concurrency(channel_id)
        while self._channel_active.get(channel_id, 0) >= limit:
            await asyncio.sleep(0.2)
        self._channel_active[channel_id] = self._channel_active.get(channel_id, 0) + 1

    def _history(self, conversation_id: str, context_window: int | None) -> list[dict]:
        """把留痕还原成发给模型的消息。最近一次摘要之前的内容用摘要代替；缺少结果的工具调用补上「已取消」。"""
        messages = self.trace.messages(conversation_id, limit=5000)
        start = 0
        summary = None
        for index, message in enumerate(messages):
            if message["role"] == "event" and message.get("type") == "summary":
                start, summary = index + 1, message["model_text"]
        result: list[dict] = []
        if summary:
            result.append({"role": "user", "content": summary})
        pending: dict[str, str] = {}
        for message in messages[start:]:
            role = message["role"]
            if role != "tool" and pending:
                for call_id, name in pending.items():
                    result.append({"role": "tool", "tool_call_id": call_id,
                                   "content": prompts.wrap_result(name, "error", {"error": "已取消"}, False)})
                pending = {}
            if role == "user":
                result.append({"role": "user", "content": message["text"]})
            elif role == "assistant":
                calls = message.get("tool_calls") or []
                result.append({"role": "assistant", "content": message.get("text") or "", "tool_calls": calls})
                pending = {call["id"]: call["name"] for call in calls}
            elif role == "tool":
                if message.get("call_id") in pending:
                    pending.pop(message["call_id"])
                    result.append({"role": "tool", "tool_call_id": message["call_id"], "content": message["model_content"]})
            elif role == "event" and message.get("model_text"):
                result.append({"role": "user", "content": message["model_text"]})
        for call_id, name in pending.items():
            result.append({"role": "tool", "tool_call_id": call_id,
                           "content": prompts.wrap_result(name, "error", {"error": "已取消"}, False)})
        return result

    @staticmethod
    def _estimate(messages: list[dict]) -> int:
        return sum(len(json.dumps(m, ensure_ascii=False)) for m in messages) // 2

    async def _compact(self, state: RunState, model: dict, endpoint, history: list[dict]) -> None:
        text = "\n".join(f"[{m['role']}] {m.get('content') or ''}"[:2000] for m in history)[-120000:]
        reply = await self._model_call(state, model, endpoint, "你负责压缩对话历史。", [{"role": "user", "content": prompts.compact_prompt(text)}],
                                       [], max_tokens=1200, stream=False)
        self.trace.append(state.conversation_id, state.id, "event", {
            "type": "summary", "text": "较早的对话已压缩为摘要",
            "model_text": "[对话摘要（较早的消息已压缩）]\n" + reply.text.strip()})

    async def _model_call(self, state: RunState, model: dict, endpoint, system: str, messages: list[dict], tools: list[ToolDef], *,
                          max_tokens: int | None, stream: bool = True):
        await self._channel_slot(model["channel_id"])
        started = time.time()
        try:
            async def on_text(text: str) -> None:
                await state.emit({"type": "text_delta", "text": text})
            for attempt in range(2):
                try:
                    reply = await self.chat(endpoint, model["model"], system, messages, tools, max_tokens=max_tokens,
                                            on_text=on_text if stream else None)
                    break
                except ProviderError as exc:
                    self.trace.log_call(kind="model", run_id=state.id, conversation_id=state.conversation_id, user_id=state.user_id,
                                        channel_id=model["channel_id"], model_id=model["id"], started_at=started,
                                        duration_ms=int((time.time() - started) * 1000), status="error",
                                        http_status=exc.status, error_code=exc.code, error=str(exc))
                    if not exc.retryable or attempt:
                        raise
                    await asyncio.sleep(2)
                    started = time.time()
        except asyncio.CancelledError:
            self.trace.log_call(kind="model", run_id=state.id, conversation_id=state.conversation_id, user_id=state.user_id,
                                channel_id=model["channel_id"], model_id=model["id"], started_at=started,
                                duration_ms=int((time.time() - started) * 1000), status="cancelled")
            raise
        finally:
            self._channel_active[model["channel_id"]] = max(0, self._channel_active.get(model["channel_id"], 1) - 1)
        self.trace.log_call(kind="model", run_id=state.id, conversation_id=state.conversation_id, user_id=state.user_id,
                            channel_id=model["channel_id"], model_id=model["id"], started_at=started,
                            duration_ms=int((time.time() - started) * 1000), ttfb_ms=reply.ttfb_ms, status="ok",
                            input_tokens=reply.input_tokens, output_tokens=reply.output_tokens, cached_tokens=reply.cached_tokens,
                            upstream_id=reply.upstream_id, items=len(reply.tool_calls))
        self.trace.add_usage(state.user_id, model["id"], reply.input_tokens, reply.output_tokens)
        return reply

    def _fit(self, payload: dict, limit: int) -> tuple[dict, bool]:
        """结果超过长度上限时，反复折半最长的列表；仍然过长则只保留摘要信息。"""
        truncated = False
        for _ in range(20):
            if len(json.dumps(payload, ensure_ascii=False).encode()) <= limit:
                return payload, truncated
            lists = [(key, value) for key, value in payload.items() if isinstance(value, list) and len(value) > 1]
            texts = [(key, value) for key, value in payload.items() if isinstance(value, str) and len(value) > 200]
            if lists:
                key, value = max(lists, key=lambda item: len(json.dumps(item[1], ensure_ascii=False)))
                payload = {**payload, key: value[:len(value) // 2]}
            elif texts:
                key, value = max(texts, key=lambda item: len(item[1]))
                payload = {**payload, key: value[:len(value) // 2]}
            else:
                break
            truncated = True
        if len(json.dumps(payload, ensure_ascii=False).encode()) > limit:
            payload = {"error": "结果过长，请缩小范围（指定子目录、类型或时间）"}
            truncated = True
        if truncated:
            payload = {**payload, "note": "结果已截断，请缩小范围"}
        return payload, truncated

    async def _execute(self, state: RunState, call, tools: dict, limits: dict, shared: dict) -> dict:
        """执行一个工具调用，返回要落库的工具消息正文。"""
        spec = tools.get(call.name)
        started = time.time()
        arguments: dict = {}
        label = TOOLS[call.name].label if call.name in TOOLS else call.name
        await state.emit({"type": "tool_started", "call_id": call.id, "name": call.name, "label": label})
        status, summary, items, event = "ok", "", None, None
        try:
            if spec is None:
                raise ToolError(f"工具 {call.name} 不存在或管理员未启用")
            try:
                parsed = json.loads(call.arguments or "{}")
            except ValueError as exc:
                raise ToolError("工具参数不是合法的 JSON") from exc
            if not isinstance(parsed, dict):
                raise ToolError("工具参数必须是对象")
            arguments = parsed
            conversation = self.trace.conversation(state.user_id, state.conversation_id, include_hidden=True)
            usage = self.objects.metadata.db.execute("SELECT quota_bytes, used_bytes FROM buckets WHERE id=?", (state.bucket_id,)).fetchone()

            async def scope_request(target: str, reason: str) -> str:
                return self.trace.create_action(state.conversation_id, state.id, state.user_id, session_hash(state.token), "scope",
                                                call.name, {"from": display(conversation["scope_root"]), "to": display(target),
                                                            "reason": reason}, count=1)

            context = ToolContext(state.user_id, state.bucket_id, conversation["scope_root"], self.objects, self.offline,
                                  state.view, state.location, tool_params(self._tool_settings(), call.name), shared,
                                  scope_request, {"used_bytes": usage["used_bytes"] if usage else None,
                                                  "quota_bytes": usage["quota_bytes"] if usage else None})
            output = await asyncio.wait_for(spec.handler(context, arguments), limits["tool_seconds"])
            payload, truncated = self._fit(output.result, limits["tool_result_bytes"])
            summary, items, event = output.summary, output.items, output.event
            ends_turn = output.ends_turn
        except TimeoutError:
            status, payload, truncated, ends_turn = "error", {"error": "工具执行超时，请缩小范围后重试"}, False, False
            summary = "超时"
        except ToolError as exc:
            status, payload, truncated, ends_turn = "error", {"error": str(exc)}, False, False
            summary = str(exc)
        except (PermissionError, NotFoundError, ValueError) as exc:
            status, payload, truncated, ends_turn = "error", {"error": str(exc) or "操作不被允许"}, False, False
            summary = str(exc) or "操作不被允许"
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("assistant tool failed name=%s", call.name)
            status, payload, truncated, ends_turn = "error", {"error": "工具执行失败"}, False, False
            summary = "工具执行失败"
        duration = int((time.time() - started) * 1000)
        self.trace.log_call(kind="tool", run_id=state.id, conversation_id=state.conversation_id, user_id=state.user_id,
                            tool_name=call.name, started_at=started, duration_ms=duration, status=status, items=items,
                            error_code="tool_error" if status != "ok" else None,
                            # 错误文案可能含路径，调用日志只记录类型。
                            error=None)
        model_content = prompts.wrap_result(call.name, status, payload, truncated)
        stored = payload if len(json.dumps(payload, ensure_ascii=False)) <= STORED_RESULT else {"note": "结果过长，未完整保存"}
        body = {"call_id": call.id, "name": call.name, "label": label, "arguments": arguments, "status": status,
                "summary": summary[:300], "result": stored, "items": items, "duration_ms": duration, "truncated": truncated,
                "event": event, "model_content": model_content, "ends_turn": ends_turn}
        return body

    async def _run(self, state: RunState) -> None:
        status, stop_reason = "completed", "completed"
        steps = tool_calls = input_tokens = output_tokens = 0
        acquired = False
        try:
            await self._acquire(state)
            acquired = True
            state.status = "running"
            await state.emit({"type": "run_started", "run_id": state.id, "model_id": state.model_id})
            limits = self.config.limits()
            deadline = time.monotonic() + limits["run_seconds"]
            repeats: collections.Counter = collections.Counter()
            errors = 0
            shared: dict = {}
            forced_final: str | None = None
            while True:
                self._validate(state)
                model = self.channels.model(state.model_id)
                endpoint = self.channels.endpoint(model["channel_id"])
                tools = self._user_tools(state.user_id)
                conversation = self.trace.conversation(state.user_id, state.conversation_id, include_hidden=True)
                scope_root = conversation["scope_root"]
                if forced_final is None:
                    if steps >= limits["max_steps"]:
                        forced_final = "模型调用次数"
                    elif tool_calls >= limits["max_tool_calls"]:
                        forced_final = "工具调用次数"
                    elif input_tokens + output_tokens >= limits["run_tokens"]:
                        forced_final = "token 预算"
                    elif time.monotonic() >= deadline:
                        forced_final = "运行时间"
                    if forced_final:
                        stop_reason = "limit"
                        message = {"type": "limit", "text": f"已达到本轮{forced_final}上限",
                                   "model_text": prompts.limit_reached(forced_final)}
                        seq = self.trace.append(state.conversation_id, state.id, "event", message)
                        await state.emit({"type": "message", "message": {"seq": seq, "role": "event", **message}})
                history = self._history(state.conversation_id, model["context_window"])
                window = model["context_window"] or 32000
                if self._estimate(history) > window * 0.7 and len(history) > 6:
                    await self._compact(state, model, endpoint, history)
                    history = self._history(state.conversation_id, model["context_window"])
                now = datetime.now().astimezone()
                usage = self.objects.metadata.db.execute("SELECT quota_bytes, used_bytes FROM buckets WHERE id=?",
                                                         (state.bucket_id,)).fetchone()
                system = prompts.system_prompt(date=now.strftime("%Y-%m-%d"), timezone=str(now.tzinfo), scope_root=display(scope_root),
                                               can_write=any(spec.level in ("write", "danger") for spec in tools.values()),
                                               can_read_text="read_text_file" in tools)
                history.append({"role": "user", "content": prompts.context_block(
                    scope_root=display(scope_root), view=state.view, location=display(state.location),
                    used=_fmt(usage["used_bytes"] if usage else 0),
                    quota="不限" if not usage or usage["quota_bytes"] is None else _fmt(usage["quota_bytes"]),
                    remaining_steps=max(0, limits["max_steps"] - steps), remaining_tools=max(0, limits["max_tool_calls"] - tool_calls))})
                definitions = [] if forced_final else [spec.definition() for spec in tools.values()]
                remaining = max(5.0, deadline + (60 if forced_final else 0) - time.monotonic())
                await state.emit({"type": "thinking"})
                reply = await asyncio.wait_for(self._model_call(state, model, endpoint, system, history, definitions,
                                                                max_tokens=model["max_output"]), remaining)
                steps += 1
                input_tokens += reply.input_tokens
                output_tokens += reply.output_tokens
                calls = reply.tool_calls if not forced_final else []
                assistant = {"text": reply.text, "tool_calls": [{"id": c.id, "name": c.name, "arguments": c.arguments} for c in calls],
                             "model_id": model["id"], "input_tokens": reply.input_tokens, "output_tokens": reply.output_tokens}
                seq = self.trace.append(state.conversation_id, state.id, "assistant", assistant)
                await state.emit({"type": "message", "message": {"seq": seq, "role": "assistant", **assistant}})
                if not calls:
                    break
                accepted = calls[:limits["parallel_calls"]]
                results = await asyncio.gather(*(self._execute(state, call, tools, limits, shared) for call in accepted))
                for call in calls[limits["parallel_calls"]:]:
                    results.append({"call_id": call.id, "name": call.name, "label": call.name, "arguments": {}, "status": "error",
                                    "summary": "本轮工具调用过多", "result": {"error": "本轮工具调用过多"}, "items": None,
                                    "duration_ms": 0, "truncated": False, "event": None, "ends_turn": False,
                                    "model_content": prompts.wrap_result(call.name, "error", {"error": "本轮工具调用过多"}, False)})
                ends = False
                looping = False
                for call, body in zip(calls, results):
                    tool_calls += 1
                    seq = self.trace.append(state.conversation_id, state.id, "tool", body, tool_name=body["name"])
                    await state.emit({"type": "message", "message": self._public_message({"seq": seq, "role": "tool", "tool_name": body["name"], **body})})
                    if body["event"]:
                        await state.emit({"type": "tool_event", **body["event"]})
                    ends = ends or bool(body.get("ends_turn"))
                    errors = errors + 1 if body["status"] != "ok" else 0
                    key = (call.name, json.dumps(body["arguments"], sort_keys=True, ensure_ascii=False))
                    repeats[key] += 1
                    if repeats[key] > limits["repeat_threshold"]:
                        looping = True
                if ends:
                    stop_reason = "waiting_user"
                    break
                if looping:
                    raise StopRun("loop", "助手重复调用了相同的工具，已停止。请换一种说法或缩小范围。")
                if errors >= limits["error_threshold"]:
                    raise StopRun("errors", "工具连续出错，已停止。请换一种说法或缩小范围。")
        except asyncio.CancelledError:
            status, stop_reason = "stopped", "stopped"
            message = {"type": "stopped", "text": "已停止"}
            try:
                seq = self.trace.append(state.conversation_id, state.id, "event", message)
                await state.emit({"type": "message", "message": {"seq": seq, "role": "event", **message}})
            except Exception:
                pass
        except StopRun as exc:
            status, stop_reason = ("failed" if exc.reason in ("errors", "loop") else "stopped"), exc.reason
            message = {"type": "error" if exc.reason in ("errors", "loop") else "stopped", "text": exc.text}
            try:
                seq = self.trace.append(state.conversation_id, state.id, "event", message)
                await state.emit({"type": "message", "message": {"seq": seq, "role": "event", **message}})
            except Exception:
                pass
        except TimeoutError:
            status, stop_reason = "failed", "timeout"
            await self._fail(state, "本轮运行超时，请缩小范围后重试")
        except ProviderError as exc:
            status, stop_reason = "failed", exc.code
            await self._fail(state, f"模型请求失败：{exc}", retry=True)
        except Exception:
            log.exception("assistant run failed id=%s", state.id)
            status, stop_reason = "failed", "internal"
            await self._fail(state, "助手内部错误，请稍后重试")
        finally:
            if acquired:
                self._release()
            try:
                self.trace.finish_run(state.id, status=status, stop_reason=stop_reason, steps=steps, tool_calls=tool_calls,
                                      input_tokens=input_tokens, output_tokens=output_tokens)
                self.trace.add_usage(state.user_id, state.model_id, 0, 0, runs=1)
            except Exception:
                log.exception("assistant run bookkeeping failed id=%s", state.id)
            state.status, state.stop_reason = status, stop_reason
            if status == "completed" or stop_reason == "waiting_user":
                try:
                    await self._title(state)
                except Exception:
                    pass
            state.finished_at = time.time()
            await state.emit({"type": "run_finished", "status": status, "stop_reason": stop_reason,
                              "usage": {"today": self.trace.tokens_today(state.user_id)}})

    async def _fail(self, state: RunState, text: str, *, retry: bool = False) -> None:
        message = {"type": "error", "text": text, "retry": retry}
        try:
            seq = self.trace.append(state.conversation_id, state.id, "event", message)
            await state.emit({"type": "message", "message": {"seq": seq, "role": "event", **message}})
        except Exception:
            pass

    async def _title(self, state: RunState) -> None:
        row = self.trace.conversation(state.user_id, state.conversation_id, include_hidden=True)
        if row["title"] is not None:
            return
        first = next((m["text"] for m in self.trace.messages(state.conversation_id, limit=50) if m["role"] == "user"), "")
        title = first.strip().splitlines()[0][:20] if first.strip() else "新对话"
        try:
            model = self.channels.model(state.model_id)
            endpoint = self.channels.endpoint(model["channel_id"])
            reply = await asyncio.wait_for(self._model_call(state, model, endpoint, "你负责给对话起标题。",
                                                            [{"role": "user", "content": prompts.title_prompt(first)}], [],
                                                            max_tokens=60, stream=False), 20)
            candidate = reply.text.strip().strip("“”\"'。.").splitlines()[0] if reply.text.strip() else ""
            if 0 < len(candidate) <= 30:
                title = candidate
        except (ProviderError, TimeoutError, NotFoundError):
            pass
        self.trace.update_conversation(state.user_id, state.conversation_id, title=title)
        await state.emit({"type": "title", "title": title})

    # ---------- 管理端 ----------

    def admin_overview(self) -> dict[str, object]:
        now = time.time()
        start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        today_stats = self.trace.call_stats(kind="model", since=start)
        conversations = self.metadata.db.execute("SELECT COUNT(*) FROM assistant_conversations WHERE updated_at>=?", (start,)).fetchone()[0]
        actions = self.metadata.db.execute(
            "SELECT COALESCE(SUM(status='pending' AND expires_at>?),0), COALESCE(SUM(status IN ('done','confirmed') AND decided_at>=?),0) "
            "FROM assistant_actions", (now, start)).fetchone()
        tokens = self.metadata.db.execute("SELECT COALESCE(SUM(input_tokens+output_tokens),0) FROM assistant_usage WHERE day=?",
                                          (datetime.now().strftime("%Y-%m-%d"),)).fetchone()[0]
        settings = self.config.tool_settings()
        tools = describe_tools(settings)
        usable = self.channels.usable()
        default = self.config.default_model
        default_model = next((m for m in usable if m["id"] == default), None)
        channels = self.channels.list()
        health = self.trace.channel_health()
        return {"enabled": self.config.enabled, "default_model": default_model,
                "usable_models": len(usable), "channels": len([c for c in channels if c["enabled"]]),
                "tools": {"enabled": sum(1 for t in tools if t["enabled"]), "total": len(tools)},
                "today": {"conversations": int(conversations), "requests": today_stats["total"],
                          "tokens": int(tokens), "failure_rate": (1 - today_stats["success_rate"]) if today_stats["success_rate"] is not None else None,
                          "pending_actions": int(actions[0]), "executed_actions": int(actions[1])},
                "usage": self.trace.usage_by_day(days=30),
                "models": {m["id"]: m["label"] for m in self.channels.models()},
                "health": [{"id": c["id"], "name": c["name"], "enabled": c["enabled"], **health.get(c["id"], {})} for c in channels],
                "storage": self.trace.storage()}

    def admin_settings(self) -> dict[str, object]:
        return self.config.describe_settings()

    def admin_update_settings(self, payload: dict) -> dict[str, object]:
        return self.config.update_settings(payload, model_exists=self.channels.is_usable)

    def admin_limits(self) -> dict[str, object]:
        return self.config.describe_limits()

    def admin_update_limits(self, payload: dict) -> dict[str, object]:
        return self.config.update_limits(payload)

    def admin_tools(self) -> list[dict]:
        return describe_tools(self.config.tool_settings())

    def admin_update_tools(self, payload: dict) -> list[dict]:
        updated = validate_tool_settings(payload, self.config.tool_settings())
        self.config.save_tool_settings(updated)
        return self.admin_tools()

    def admin_channels(self) -> list[dict]:
        health = self.trace.channel_health()
        return [{**channel, "health": health.get(channel["id"])} for channel in self.channels.list()]

    def admin_delete_channel(self, channel_id: int) -> None:
        default = self.config.default_model
        if default is not None:
            model = self.metadata.db.execute("SELECT channel_id FROM ai_models WHERE id=?", (default,)).fetchone()
            if model is not None and model["channel_id"] == channel_id:
                if self.config.enabled:
                    raise ValueError("默认模型属于这个渠道，请先另选默认模型")
                self.config.update_settings({"default_model": None}, model_exists=self.channels.is_usable)
        self.channels.delete(channel_id)

    def guard_default(self, model_id: int | None = None, channel_id: int | None = None) -> None:
        """停用渠道或模型前：若会导致助手已启用却没有可用的默认模型，拒绝。"""
        if not self.config.enabled:
            return
        default = self.config.default_model
        if default is None:
            return
        row = self.metadata.db.execute("SELECT channel_id FROM ai_models WHERE id=?", (default,)).fetchone()
        if (model_id is not None and model_id == default) or (channel_id is not None and row and row["channel_id"] == channel_id):
            raise ValueError("这是当前默认模型（或其所在渠道），请先在设置中另选默认模型")

    async def admin_test_model(self, model_id: int, actor: str | None) -> dict[str, object]:
        spec = TOOLS["get_context"]
        return await self.channels.test(model_id, spec.definition(), prompts.TEST_PROMPT, actor=actor)

    def admin_policy(self, user_id: int) -> dict[str, object]:
        if self.metadata.db.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone() is None:
            raise NotFoundError("用户不存在")
        policy = self.config.policy(user_id)
        usage = self.trace.usage_by_day(days=30, user_id=user_id)
        return {**{k: v for k, v in policy.items() if k != "notice_ack_at"},
                "usage": {"today": self.trace.tokens_today(user_id),
                          "days30": sum(int(r["input_tokens"] or 0) + int(r["output_tokens"] or 0) for r in usage)}}

    def admin_update_policy(self, user_id: int, payload: dict) -> dict[str, object]:
        self.admin_policy(user_id)
        self.config.update_policy(user_id, payload)
        if payload.get("enabled") is False:
            for run in self.runs.values():
                if run.user_id == user_id and run.finished_at is None and run.task:
                    run.task.cancel()
        return self.admin_policy(user_id)

    def admin_purge(self) -> None:
        for run in self.runs.values():
            if run.finished_at is None and run.task:
                run.task.cancel()
        self.trace.purge_all()
        self.config.purge_all()

    async def cleanup(self, now: float | None = None) -> dict[str, int]:
        """维护任务：按保留期清理留痕与调用日志。"""
        return await self.metadata.run_in_thread(lambda: self.trace.cleanup(
            retention_days=self.config.setting("retention_days"), call_log_days=self.config.setting("call_log_days"), now=now))


def _fmt(size: int | None) -> str:
    value = float(size or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return "0 B"


__all__ = ["AssistantDenied", "AssistantService", "LIMITS"]
