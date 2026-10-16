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
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from types import SimpleNamespace
from urllib.parse import unquote
from zoneinfo import ZoneInfo

from ..api import normalize_user_path
from ..authn import AuthenticationError
from ..errors import NotFoundError, NotReadyError
from . import client_tools, http_tools, knowledge, prompts, providers, vision, web, web_tools, write_tools  # noqa: F401  导入即注册工具
from .actions import CONFIRM_KINDS, DANGER_KINDS, KINDS, ActionExecutor, Progress, share_options
from .catalog import CatalogStore
from .channels import ChannelStore
from .config import LIMITS, AssistantConfig
from .guard import SecretGuard
from .providers import ProviderError, ToolDef
from .tools import (
    TOOLS,
    ToolContext,
    ToolError,
    describe_tools,
    effective_tools,
    tool_params,
    validate_tool_settings,
)
from .trace import TraceStore

log = logging.getLogger(__name__)

EVENT_BUFFER = 2000
EVENT_KEEP_SECONDS = 600
EVENT_BYTES = 64 * 1024 * 1024
MAX_TEXT = 8000
STORED_RESULT = 256 * 1024
CLIENT_TIMEOUT = 45
CLIENT_RESULT_BYTES = 64 * 1024
AUTO_WAIT = 25
ACCESS_MODES = ("approval", "full")
MAX_MENTIONS = 20
# 聊天框附件：统一保存在普通文件区域的这个目录下（§22.5），每条消息最多 10 个。
ATTACHMENT_ROOT = "助手附件/"
MAX_ATTACHMENTS = 10
# 读取不可信外部内容的工具：结果进入上下文后，完全访问模式下的修改仍需确认（§19.5）。
TAINT_TOOLS = {"read_text_file": "读取过文件内容", "analyze_page": "分析过网页", "collect_gallery": "分析过网页",
               "parse_download_source": "解析过外部链接", "http_request": "读取过外部 HTTP 响应", "view_image": "查看过图片内容"}


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
    event_sizes: collections.deque = field(default_factory=collections.deque)
    event_bytes: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    trim_events: Callable[[], None] | None = None
    seq: int = 0
    status: str = "queued"
    stop_reason: str | None = None
    finished_at: float | None = None
    task: asyncio.Task | None = None
    changed: asyncio.Condition = field(default_factory=asyncio.Condition)
    # 浏览器工具：等待页面回传结果的调用（call_id → Future）
    client_waiters: dict = field(default_factory=dict)
    # 本轮读取过的不可信外部内容（之后的修改在完全访问下也需要确认）
    tainted: str | None = None
    listeners: int = 0
    thinking: dict = field(default_factory=dict)
    environment: dict = field(default_factory=dict)
    # 本轮已读取的图片（对象键 → {"mime","data",…} 或不能发送的原因）。只在内存中，不进入留痕。
    images: dict = field(default_factory=dict)

    async def emit(self, event: dict) -> None:
        self.seq += 1
        value = {"seq": self.seq, **event}
        if len(self.events) == EVENT_BUFFER:
            self.event_bytes -= self.event_sizes.popleft()
        size = len(json.dumps(value, ensure_ascii=False).encode())
        self.events.append(value)
        self.event_sizes.append(size)
        self.event_bytes += size
        if self.trim_events is not None:
            self.trim_events()
        async with self.changed:
            self.changed.notify_all()


class AssistantDenied(PermissionError):
    """助手对当前用户不可用（未启用、未开放、无模型）。HTTP 层返回 403 并展示原因。"""


class StopRun(Exception):
    def __init__(self, reason: str, text: str):
        super().__init__(text)
        self.reason, self.text = reason, text


class AssistantService:
    def __init__(self, accounts, objects, offline=None, *, user_api=None, settings=None) -> None:
        self.accounts, self.objects, self.offline, self.user_api = accounts, objects, offline, user_api
        self.settings = settings
        self.metadata, self.keystore = accounts.metadata, accounts.keystore
        self.config = AssistantConfig(self.metadata)
        self.trace = TraceStore(self.metadata, self.keystore)
        self.catalog = CatalogStore(self.metadata, self.config, log_call=self.trace.log_call)
        self.channels = ChannelStore(self.metadata, self.keystore, log_call=self.trace.log_call, catalog=self.catalog)
        self.guard = SecretGuard(self.channels, offline)
        self.on_audit: Callable[[str, int, dict], None] | None = None  # 由 HTTP 层注入：自动执行的操作写审计
        self.chat = providers.chat  # 测试可替换为脚本化的假模型
        self.executor = ActionExecutor(objects, offline)
        self.executions: dict[str, Progress] = {}
        self._execution_tasks: dict[str, asyncio.Task] = {}
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

    def _full_access(self, user_id: int) -> bool:
        """管理员是否允许该账号使用完全访问：用户策略优先，未设置时跟随全局设置。"""
        policy = self.config.policy(user_id)
        allowed = policy.get("full_access")
        return bool(self.config.full_access_default if allowed is None else allowed)

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

    def _mentions(self, bucket_id: int, value: object, scope_root: str) -> list[str]:
        """@ 引用的文件或文件夹：必须是作用域内、存在的普通文件；超出作用域时由界面先扩大作用域再发送。"""
        if value in (None, []):
            return []
        if not isinstance(value, list) or len(value) > MAX_MENTIONS or not all(isinstance(item, str) for item in value):
            raise ValueError(f"一次最多引用 {MAX_MENTIONS} 个文件或文件夹")
        keys: list[str] = []
        for item in value:
            text = item.strip().lstrip("/")
            try:
                key = normalize_user_path(text, directory=text.endswith("/"))
            except PermissionError as exc:
                raise ValueError("不能引用私密空间或系统区域的内容") from exc
            except ValueError as exc:
                raise ValueError(f"引用的路径不正确：{item}") from exc
            if not key.startswith(scope_root):
                raise ValueError(f"引用的 {display(key)} 不在作用域 {display(scope_root)} 内")
            query = ("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1", (bucket_id, key, key + "\U0010ffff")) \
                if key.endswith("/") else ("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key))
            if self.metadata.db.execute(*query).fetchone() is None:
                raise ValueError(f"引用的 {display(key)} 不存在")
            if key not in keys:
                keys.append(key)
        return keys

    def _attachments(self, bucket_id: int, value: object, *, strict: bool = True) -> tuple[list[str], int]:
        """聊天框附件：必须位于「助手附件/」下、存在的普通文件，不要求在作用域内（只读工具对它们有白名单例外）。
        strict=False 用于重试：已不存在的附件跳过，返回跳过的数量。"""
        if value in (None, []):
            return [], 0
        if not isinstance(value, list) or len(value) > MAX_ATTACHMENTS or not all(isinstance(item, str) for item in value):
            raise ValueError(f"一条消息最多 {MAX_ATTACHMENTS} 个附件")
        keys: list[str] = []
        missing = 0
        for item in value:
            try:
                key = normalize_user_path(item.strip().lstrip("/"))
            except (PermissionError, ValueError) as exc:
                raise ValueError(f"附件路径不正确：{item}") from exc
            if not key.startswith(ATTACHMENT_ROOT) or key.endswith("/"):
                raise ValueError(f"附件必须保存在 /{ATTACHMENT_ROOT} 下")
            if self.metadata.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key)).fetchone() is None:
                if strict:
                    raise ValueError(f"附件 {display(key)} 不存在，可能还没有上传完成")
                missing += 1
                continue
            if key not in keys:
                keys.append(key)
        return keys, missing

    def _readable(self, conversation_id: str) -> frozenset:
        """对话的附件白名单：所有用户消息上传过的附件（对象键）。"""
        keys: set[str] = set()
        for message in self.trace.messages(conversation_id, limit=5000):
            if message["role"] == "user" and isinstance(message.get("attachments"), list):
                keys.update(str(path).lstrip("/") for path in message["attachments"])
        return frozenset(keys)

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
                "retention_days": self.config.setting("retention_days"), "full_access": self._full_access(account.id)}

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
        mode = self._access_mode(account.id, payload.get("access_mode", "approval"))
        conversation_id = self.trace.create_conversation(account.id, scope_root, model_id,
                                                         keep=self.config.limits()["max_conversations"])
        if mode != "approval":
            self.trace.update_conversation(account.id, conversation_id, access_mode=mode)
        return self.conversation(token, conversation_id)

    def _access_mode(self, user_id: int, value: object) -> str:
        if value not in ACCESS_MODES:
            raise ValueError("访问模式只能是 approval 或 full")
        if value == "full" and not self._full_access(user_id):
            raise ValueError("管理员未允许你使用完全访问模式")
        return str(value)

    def conversation(self, token: str, conversation_id: str) -> dict[str, object]:
        _, account = self._session(token)
        row = self.trace.conversation(account.id, conversation_id)
        item = self.trace.conversation_json(row)
        item["scope"] = display(item.pop("scope_root"))
        if item["access_mode"] == "full" and not self._full_access(account.id):
            item["access_mode"] = "approval"
        return {"conversation": item, "messages": [self._public_message(m) for m in self.trace.messages(conversation_id, limit=2000)],
                "actions": [self._action_view(action) for action in self.trace.actions(conversation_id)],
                "active_run": self._active_run(conversation_id)}

    @staticmethod
    def _public_message(message: dict) -> dict:
        """发给浏览器的消息：去掉只给模型看的包装文本。"""
        return {key: value for key, value in message.items() if key not in ("model_content",)}

    def update_conversation(self, token: str, csrf: str, conversation_id: str, payload: dict) -> dict[str, object]:
        _, account = self._session(token, csrf=csrf, mutation=True)
        unknown = set(payload) - {"title", "archived", "access_mode"}
        if unknown:
            raise ValueError(f"未知字段：{', '.join(sorted(unknown))}")
        mode = self._access_mode(account.id, payload["access_mode"]) if "access_mode" in payload else None
        title = payload.get("title")
        if title is not None and (not isinstance(title, str) or not 1 <= len(title.strip()) <= 60):
            raise ValueError("标题需要 1–60 个字符")
        archived = payload.get("archived")
        if archived is not None and not isinstance(archived, bool):
            raise ValueError("archived 必须是布尔值")
        self.trace.update_conversation(account.id, conversation_id, title=title.strip() if title else None, archived=archived,
                                       access_mode=mode)
        if mode is not None:
            self.trace.append(conversation_id, None, "event", {
                "type": "mode_changed", "text": "已切换到完全访问：普通修改会自动执行" if mode == "full" else "已切换到审批模式：每次修改都需要你确认",
                "model_text": "[系统事件] 用户切换到完全访问模式。普通修改会在生成提议后自动执行；彻底删除、公开分享、超过 1000 项，"
                              "以及本轮读取过文件内容或网页之后的修改，仍需要用户确认。" if mode == "full" else
                              "[系统事件] 用户切换到审批模式，所有修改都需要用户在卡片上确认。"})
        item = self.trace.conversation_json(self.trace.conversation(account.id, conversation_id))
        item["scope"] = display(item.pop("scope_root"))
        return item

    def delete_conversation(self, token: str, csrf: str, conversation_id: str) -> None:
        _, account = self._session(token, csrf=csrf, mutation=True)
        run_id = self._active_run(conversation_id)
        if run_id and self.runs[run_id].user_id == account.id and self.runs[run_id].task:
            self.runs[run_id].task.cancel()
        self.trace.hide_conversation(account.id, conversation_id)
        self.trace.expire_actions(conversation_id)

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
        limits = self._admit(account.id, row)
        if row["messages"] >= limits["max_messages"]:
            raise ValueError("这个对话已经很长了，请新建对话继续")
        model_id = self._choose_model(payload.get("model_id"), row["model_id"])
        view = payload.get("view") if isinstance(payload.get("view"), str) and len(payload.get("view")) <= 20 else "files"
        location = self._location(payload.get("location"))
        scope_root = row["scope_root"]
        choice = payload.get("scope")
        if choice not in (None, "conversation", "location", "root", "path"):
            raise ValueError("作用域选项不正确")
        # path：用户在目录树中选定的目录（同样排除私密空间与系统区域），属于用户本人的操作。
        new_scope = self._location(payload.get("scope_path")) if choice == "path" else \
            {"location": location, "root": ""}.get(choice or "conversation", scope_root)
        mentions = self._mentions(account.bucket_id, payload.get("mentions"), new_scope)
        attachments, _ = self._attachments(account.bucket_id, payload.get("attachments"))
        self._switch_model(account.id, row, model_id)
        if new_scope != scope_root:
            # 用户在界面上直接切换作用域，属于用户本人的操作，不需要再确认。
            self.trace.expire_actions(conversation_id)
            self.trace.update_conversation(account.id, conversation_id, scope_root=new_scope)
            self.trace.append(conversation_id, None, "event", {
                "type": "scope_changed", "text": f"作用域：{display(scope_root)} → {display(new_scope)}",
                "model_text": f"[系统事件] 用户把作用域从 {display(scope_root)} 切换为 {display(new_scope)}。"})
        body = {"text": text.strip(), "location": display(location), "view": view, "scope": display(new_scope)}
        if mentions:
            body["mentions"] = [display(key) for key in mentions]
        if attachments:
            body["attachments"] = [display(key) for key in attachments]
        snapshot_id = payload.get("snapshot_id")
        if snapshot_id is not None:
            if not isinstance(snapshot_id, str):
                raise ValueError("快照编号不正确")
            snapshot = self.trace.collection(account.id, snapshot_id, kind="snapshot")
            if snapshot["conversation_id"] != conversation_id:
                raise ValueError("快照不属于这个对话")
            body["attachment"] = {"type": "snapshot", "id": snapshot_id, "source": snapshot["source"],
                                  "pages": len(snapshot["urls"]), "images": snapshot["count"]}
        run_id = self.trace.start_run(conversation_id, model_id, prompts.PROMPT_VERSION)
        message_seq = self.trace.append(conversation_id, run_id, "user", body)
        state = self._start(run_id, conversation_id, account, token, model_id, view, location,
                            environment=knowledge.client_environment(payload.get("environment")))
        return {"run_id": state.id, "message_seq": message_seq}

    def _admit(self, user_id: int, row) -> dict:
        """开始新运行前的共同检查：对话空闲、用户并发、每日额度与频率。"""
        limits = self.config.limits()
        if self._active_run(row["id"]):
            raise ValueError("上一条消息还在处理，请稍候或先停止")
        active = sum(1 for run in self.runs.values() if run.user_id == user_id and run.finished_at is None)
        if active >= limits["user_concurrency"]:
            raise ValueError("你有其他对话正在处理，请稍候")
        self._check_budget(user_id)
        self._check_rate(user_id, limits)
        return limits

    def _switch_model(self, user_id: int, row, model_id: int) -> None:
        if model_id == row["model_id"]:
            return
        self.trace.update_conversation(user_id, row["id"], model_id=model_id)
        if row["model_id"] is not None:
            model = self.channels.model(model_id)
            self.trace.append(row["id"], None, "event", {"type": "model_switched", "text": f"已切换到 {model['label']}"})

    async def retry(self, token: str, csrf: str, conversation_id: str, payload: dict) -> dict[str, object]:
        """从自己的某条消息重新回答：丢弃这条消息及之后的全部记录，再以同样的内容（引用、附件）开始新运行。
        被丢弃部分里待确认的操作随之失效；已经执行的文件操作不会撤销。"""
        session, account = self._session(token, csrf=csrf, mutation=True)
        self._require_available(account.id)
        if self.config.policy(account.id)["notice_ack_at"] is None:
            raise ValueError("请先阅读并确认文件助手的使用说明")
        row = self.trace.conversation(account.id, conversation_id)
        seq = payload.get("seq")
        if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
            raise ValueError("消息编号不正确")
        self._admit(account.id, row)
        message = self.trace.message(conversation_id, seq)
        if message is None or message["role"] != "user":
            raise ValueError("只能从你发送的消息重试")
        model_id = self._choose_model(payload.get("model_id"), row["model_id"])
        view = payload.get("view") if isinstance(payload.get("view"), str) and len(payload.get("view")) <= 20 else message.get("view", "files")
        location = self._location(payload.get("location")) if payload.get("location") is not None else self._location(message.get("location"))
        body = {key: message[key] for key in ("text", "attachment") if key in message}
        body.update({"location": display(location), "view": view, "scope": display(row["scope_root"])})
        # 引用按当前作用域重新校验：期间文件可能被移动或删除。
        mentions = self._mentions(account.bucket_id, message.get("mentions"), row["scope_root"])
        if mentions:
            body["mentions"] = [display(key) for key in mentions]
        attachments, missing = self._attachments(account.bucket_id, message.get("attachments"), strict=False)
        if attachments:
            body["attachments"] = [display(key) for key in attachments]
        if missing:
            body["attachments_missing"] = missing
        self.trace.truncate(conversation_id, seq)
        self._switch_model(account.id, row, model_id)
        run_id = self.trace.start_run(conversation_id, model_id, prompts.PROMPT_VERSION)
        message_seq = self.trace.append(conversation_id, run_id, "user", body)
        state = self._start(run_id, conversation_id, account, token, model_id, view, location,
                            environment=knowledge.client_environment(payload.get("environment")))
        return {"run_id": state.id, "message_seq": message_seq}

    def _start(self, run_id: str, conversation_id: str, account, token: str, model_id: int, view: str, location: str,
               *, environment: dict | None = None) -> RunState:
        state = RunState(run_id, conversation_id, account.id, account.bucket_id, token, model_id, view, location)
        state.environment = environment if environment is not None else next(
            (run.environment for run in reversed(self.runs.values()) if run.conversation_id == conversation_id and run.token == token), {})
        state.trim_events = self._gc_runs
        self.runs[run_id] = state
        state.task = asyncio.get_running_loop().create_task(self._run(state))
        self._gc_runs()
        return state

    def share_link(self, token: str, conversation_id: str, path: str) -> dict:
        """分享令牌只按需交给界面，不存入工具消息或发送给模型。"""
        _, account = self._session(token)
        self._require_available(account.id)
        if "ui_open_share" not in self._user_tools(account.id):
            raise PermissionError("打开分享工具已关闭")
        conversation = self.trace.conversation(account.id, conversation_id)
        context = ToolContext(account.id, account.bucket_id, conversation["scope_root"], self.objects, None, "files", "", {}, {})
        _, row = client_tools.shared_object(context, "/" + path.lstrip("/"))
        return {"token": row["public_token"], "public_base_url": self.settings.get("public_base_url") if self.settings else None}

    def _gc_runs(self) -> None:
        now = time.time()
        for run_id, run in list(self.runs.items()):
            if run.finished_at is not None and now - run.finished_at > EVENT_KEEP_SECONDS:
                self.runs.pop(run_id, None)

        total = sum(run.event_bytes for run in self.runs.values())
        for run in sorted(self.runs.values(), key=lambda value: value.finished_at or float("inf")):
            while total > EVENT_BYTES and run.events:
                size = run.event_sizes.popleft()
                run.events.popleft()
                run.event_bytes -= size
                total -= size

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
                "WHERE r.id=? AND c.user_id=? AND c.hidden_at IS NULL", (run_id, account.id)).fetchone()
            if row is None:
                raise NotFoundError("运行不存在")
            yield {"seq": after + 1, "type": "run_finished", "status": row["status"], "stop_reason": row["stop_reason"], "replay": True}
            return
        cursor = after
        state.listeners += 1
        try:
            async for event in self._event_loop(token, state, cursor):
                yield event
        finally:
            state.listeners -= 1

    async def _event_loop(self, token: str, state: RunState, cursor: int):
        while True:
            # 长连接也重验权限，不能在退出或隐藏对话后继续获得正文。
            _, current = self._session(token)
            self.trace.conversation(current.id, state.conversation_id)
            if (state.events and state.events[0]["seq"] > cursor + 1) or (not state.events and state.seq > cursor):
                cursor = state.seq
                yield {"seq": cursor, "type": "resync"}
            pending = [event for event in list(state.events) if event["seq"] > cursor]
            for event in pending:
                cursor = event["seq"]
                yield event
            if state.finished_at is not None and not [e for e in state.events if e["seq"] > cursor]:
                if not pending or pending[-1]["type"] != "run_finished":
                    yield {"seq": cursor + 1, "type": "run_finished", "status": state.status, "stop_reason": state.stop_reason, "replay": True}
                return
            async with state.changed:
                if not [e for e in state.events if e["seq"] > cursor] and state.finished_at is None:
                    try:
                        await asyncio.wait_for(state.changed.wait(), 15)
                    except TimeoutError:
                        yield {"type": "ping"}

    # ---------- 浏览器工具 ----------

    def client_result(self, token: str, csrf: str, run_id: str, payload: dict) -> None:
        """对话框回传浏览器工具的执行结果：只接受发起这个 run 的登录会话、正在等待中的调用。"""
        _, account = self._session(token, csrf=csrf, mutation=True)
        state = self._run_for(account.id, run_id)
        if session_hash(state.token) != session_hash(token):
            raise PermissionError("只能在发起对话的登录会话中回传")
        call_id = payload.get("call_id")
        future = state.client_waiters.get(call_id) if isinstance(call_id, str) else None
        if future is None or future.done():
            raise ValueError("这个调用已经结束")
        if len(json.dumps(payload, ensure_ascii=False).encode()) > CLIENT_RESULT_BYTES:
            future.set_result({"error": "页面返回的数据过大"})
            raise ValueError("回传数据过大")
        result = payload.get("result")
        error = payload.get("error")
        future.set_result({"error": str(error)[:200]} if error else result if isinstance(result, dict) else {"error": "页面没有返回结果"})

    async def _client_call(self, state: RunState, call_id: str, name: str, arguments: dict) -> dict:
        if state.listeners <= 0:
            return {"error": "浏览器未连接：用户的对话框没有打开，无法操作页面"}
        future = asyncio.get_running_loop().create_future()
        state.client_waiters[call_id] = future
        try:
            await state.emit({"type": "client_call", "call_id": call_id, "name": name, "args": arguments,
                              "expires_at": time.time() + CLIENT_TIMEOUT})
            return await asyncio.wait_for(future, CLIENT_TIMEOUT)
        except TimeoutError:
            return {"error": "浏览器没有响应：对话框可能已关闭"}
        finally:
            state.client_waiters.pop(call_id, None)

    def _conversation_taint(self, conversation_id: str) -> str | None:
        """最近一次摘要之后，对话里是否有读取外部内容的工具结果（它们仍在模型上下文中）。"""
        names = list(TAINT_TOOLS)
        row = self.metadata.db.execute(
            f"SELECT tool_name FROM assistant_messages WHERE conversation_id=? AND role='tool' AND tool_name IN ({','.join('?' * len(names))}) "
            "AND seq > COALESCE((SELECT MAX(seq) FROM assistant_messages WHERE conversation_id=? AND role='event' AND tool_name='summary'),0) "
            "ORDER BY seq DESC LIMIT 1", (conversation_id, *names, conversation_id)).fetchone()
        return TAINT_TOOLS.get(row["tool_name"]) if row else None

    # ---------- 作用域请求 ----------

    async def decide_scope(self, token: str, csrf: str, action_id: str, approve: bool) -> dict[str, object]:
        session, account = self._session(token, csrf=csrf, mutation=True)
        row = self.trace.action(account.id, action_id)
        if row["kind"] != "scope":
            raise ValueError("操作类型不正确")
        if row["session_hash"] != session_hash(token):
            raise PermissionError("只能在发起请求的登录会话中确认")
        self.trace.conversation(account.id, row["conversation_id"])
        if approve:
            self._require_available(account.id)
            if "request_scope" not in self._user_tools(account.id):
                raise ValueError("作用域请求工具已停用")
        payload = self.trace.action_json(row)["payload"]
        if not self.trace.decide_action(action_id, "confirmed" if approve else "rejected"):
            raise ValueError("该请求已处理或已过期")
        conversation_id = row["conversation_id"]
        conversation = self.trace.conversation(account.id, conversation_id)
        old, new = payload["from"], payload["to"]
        if approve:
            self.trace.expire_actions(conversation_id)
            self.trace.update_conversation(account.id, conversation_id, scope_root=new.lstrip("/"))
        self.trace.append(conversation_id, None, "event", {
            "type": "scope_changed" if approve else "scope_rejected", "action_id": action_id,
            "text": f"作用域：{old} → {new}" if approve else f"已拒绝把作用域切换到 {new}",
            "model_text": prompts.scope_event(old, new, approve)})
        result: dict[str, object] = {"status": "confirmed" if approve else "rejected", "scope": new if approve else old}
        # 用户确认后自动继续，让助手接着完成之前的请求。
        available, _ = self._availability(account.id)
        if available and not self._active_run(conversation_id) and sum(
                run.user_id == account.id and run.finished_at is None for run in self.runs.values()) < self.config.limits()["user_concurrency"]:
            try:
                self._check_budget(account.id)
                model_id = self._choose_model(None, conversation["model_id"])
                run_id = self.trace.start_run(conversation_id, model_id, prompts.PROMPT_VERSION)
                state = self._start(run_id, conversation_id, account, token, model_id, "files", conversation["scope_root"])
                result["run_id"] = state.id
            except (ValueError, PermissionError):
                pass
        return result

    # ---------- 待确认操作 ----------

    def _action_view(self, action: dict) -> dict:
        progress = self.executions.get(action["id"])
        if progress is not None and action["status"] in ("running", "undoing"):
            action = {**action, "progress": {"done": progress.done, "total": progress.total, "ok": progress.ok,
                                             "skipped": progress.skipped, "failed": progress.failed}}
        return action

    def action_detail(self, token: str, action_id: str) -> dict[str, object]:
        _, account = self._session(token)
        return self._action_view(self.trace.action_json(self.trace.action(account.id, action_id)))

    def action_items(self, token: str, action_id: str, offset: int = 0) -> dict[str, object]:
        _, account = self._session(token)
        row = self.trace.action(account.id, action_id)
        if row["kind"] == "scope":
            raise ValueError("作用域请求没有条目")
        return self.trace.action_items(row, offset=max(0, offset))

    def _action_event(self, row, decision: str, result: dict | None, text: str) -> None:
        try:
            self.trace.append(row["conversation_id"], None, "event", {
                "type": "action_result", "action_id": row["id"], "text": text,
                "model_text": prompts.action_event(row["id"], KINDS.get(row["kind"], row["kind"]), row["count"], decision, result)})
        except NotFoundError:
            pass

    async def decide_action(self, token: str, csrf: str, action_id: str, approve: bool, payload: dict) -> dict[str, object]:
        """用户确认或拒绝待确认操作：只能由生成它的登录会话、带 CSRF、在过期前决定一次。"""
        session, account = self._session(token, csrf=csrf, mutation=True)
        row = self.trace.action(account.id, action_id)
        self.trace.conversation(account.id, row["conversation_id"])
        if row["kind"] == "scope":
            raise ValueError("操作类型不正确")
        if row["session_hash"] != session_hash(token):
            raise PermissionError("只能在发起这个操作的登录会话中确认")
        if not approve:
            if not self.trace.decide_action(action_id, "rejected"):
                raise ValueError("该操作已处理或已过期")
            self._action_event(row, "已拒绝", None, f"已拒绝：{KINDS.get(row['kind'], row['kind'])} {row['count']} 项")
            return self.action_detail(token, action_id)
        self._require_available(account.id)
        tools = self._user_tools(account.id)
        if row["tool_name"] not in tools:
            self.trace.expire_actions(row["conversation_id"], tool_names=[row["tool_name"]])
            raise ValueError("管理员已停用生成这个操作的工具，或你的账号不再允许这类操作；操作已作废")
        if row["kind"] in DANGER_KINDS and payload.get("acknowledge") is not True:
            raise ValueError("这是不可恢复的操作，请先勾选「我了解此操作不可恢复」")
        if row["count"] > 1000 and payload.get("count") != row["count"]:
            raise ValueError(f"条目较多，请再次确认执行 {row['count']} 项")
        action_payload = self.trace.action_payload(row)
        confirm = None
        if row["kind"] == "share":
            # 卡片中填写的有效期与访问密码只在这次请求的内存里使用，不写入操作记录、审计或对话。
            share = payload.get("share") if isinstance(payload.get("share"), dict) else {}
            confirm = {key: share[key] for key in ("expires_days", "password") if key in share}
            share_options(action_payload, confirm)
        if not self.trace.start_action(action_id):
            raise ValueError("该操作已处理或已过期")
        self._launch_action(row, account, token, action_payload, confirm, "已确认")
        return self.action_detail(token, action_id)

    def _launch_action(self, row, account, token: str, payload: dict, confirm: dict | None, decision: str) -> asyncio.Task:
        action_id = row["id"]
        record = self.trace.action_recorder(action_id, row["conversation_id"])
        progress = Progress(total=row["count"])
        self.executions[action_id] = progress
        if decision == "已确认":
            self._action_event(row, decision, None, f"已确认：{KINDS.get(row['kind'], row['kind'])} {row['count']} 项")
        task = asyncio.get_running_loop().create_task(self._run_action(row, account, payload, progress, token, record, confirm, decision))
        self._execution_tasks[action_id] = task
        return task

    def _action_authorized(self, token: str, row) -> bool:
        try:
            _, account = self._session(token)
            self._require_available(account.id)
            self.trace.conversation(account.id, row["conversation_id"])
            return row["user_id"] == account.id and row["tool_name"] in self._user_tools(account.id)
        except (AuthenticationError, NotFoundError, NotReadyError, PermissionError):
            return False

    async def _run_action(self, row, account, payload: dict, progress: Progress, token: str, record, confirm: dict | None = None,
                          decision: str = "已确认") -> dict:
        action_id = row["id"]
        undo = None
        try:
            undo = await self.executor.execute(user_id=account.id, bucket_id=account.bucket_id, payload=payload, progress=progress,
                                               authorized=lambda: self._action_authorized(token, row), confirm=confirm)
            status = progress.status()
        except asyncio.CancelledError:
            progress.cancel = True
            status = "cancelled"
        except Exception as exc:
            log.error("assistant action failed id=%s", action_id)
            progress.fail("", str(exc) if isinstance(exc, (ValueError, PermissionError)) else "执行失败")
            status = "failed" if not progress.ok else "partial"
        result = progress.result()
        self.trace.log_call(kind="tool", conversation_id=row["conversation_id"], user_id=account.id, tool_name=row["tool_name"],
                            action_id=action_id, started_at=row["decided_at"] or time.time(), status="ok" if status in ("done", "partial") else status,
                            items=progress.ok)
        label = {"done": "已完成", "partial": "部分完成", "failed": "执行失败", "cancelled": "已取消"}.get(status, status)
        text = (f"{label}：成功 {result['ok']} 项" + (f"，跳过 {result['skipped']} 项" if result["skipped"] else "")
                + (f"，失败 {result['failed']} 项" if result["failed"] else ""))
        try:
            # 自动执行的结果已经作为工具结果交给模型，这里的事件只给界面看，不再重复写给模型。
            event = {"type": "action_result", "action_id": action_id, "text": ("自动执行" + text) if decision == "自动执行" else text}
            if decision != "自动执行":
                event["model_text"] = prompts.action_event(action_id, KINDS.get(row["kind"], row["kind"]), row["count"], decision, result)
            record(status, result, undo, event)
        except Exception:
            log.error("assistant action bookkeeping failed id=%s", action_id)
        if decision == "自动执行" and self.on_audit is not None:
            try:
                self.on_audit("assistant.action.auto", account.id, {"kind": row["kind"], "status": status, "count": row["count"]})
            except Exception:
                log.error("assistant audit failed id=%s", action_id)
        self._execution_tasks.pop(action_id, None)
        # 进度在内存里多保留一会儿，便于界面读取最终计数。
        await asyncio.sleep(0)
        self.executions.pop(action_id, None)
        return {"status": status, **result}

    def cancel_action(self, token: str, csrf: str, action_id: str) -> dict[str, object]:
        _, account = self._session(token, csrf=csrf, mutation=True)
        row = self.trace.action(account.id, action_id)
        progress = self.executions.get(action_id)
        if row["status"] != "running" or progress is None:
            raise ValueError("操作不在执行中")
        progress.cancel = True
        return self.action_detail(token, action_id)

    async def undo_action(self, token: str, csrf: str, action_id: str) -> dict[str, object]:
        _, account = self._session(token, csrf=csrf, mutation=True)
        row = self.trace.action(account.id, action_id)
        self.trace.conversation(account.id, row["conversation_id"])
        if not self._action_authorized(token, row):
            raise PermissionError("当前不能执行这类操作")
        data = self.trace.action_undo(row)
        if data is None or not self.trace.take_undo(action_id):
            raise ValueError("这个操作不能撤销（超过 24 小时、已撤销或不支持撤销）")
        payload = self.trace.action_payload(row)
        try:
            result = await self.executor.undo(bucket_id=account.bucket_id, payload=payload, data=data,
                                              authorized=lambda: self._action_authorized(token, row))
        except Exception:
            with self.metadata.transaction() as db:
                db.execute("UPDATE assistant_actions SET status=? WHERE id=? AND status='undoing'", (row["status"], action_id))
            raise
        self.trace.finish_undo(action_id, result)
        self._action_event(row, "已撤销", result, f"已撤销：恢复 {result['ok']} 项" + (f"，{result['skipped']} 项无法恢复" if result["skipped"] else ""))
        return self.action_detail(token, action_id)

    # ---------- 页面快照（抓取脚本） ----------

    def upload_snapshot(self, token: str, csrf: str, conversation_id: str, payload: dict) -> dict[str, object]:
        _, account = self._session(token, csrf=csrf, mutation=True)
        self._require_available(account.id)
        self.trace.conversation(account.id, conversation_id)
        if "analyze_page" not in self._user_tools(account.id):
            raise ValueError("管理员未启用网页分析，无法使用页面快照")
        source, pages, total = web.validate_snapshot(payload)
        snapshot_id = self.trace.create_collection(conversation_id, account.id, "snapshot", source=source, rule=None, urls=pages,
                                                   count=total)
        return {"snapshot_id": snapshot_id, "source": source, "pages": len(pages), "images": total}

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

    def _history(self, conversation_id: str, context_window: int | None, *, run_id: str | None = None,
                 can_see: bool = False) -> list[dict]:
        """把留痕还原成发给模型的消息。最近一次摘要之前的内容用摘要代替；缺少结果的工具调用补上「已取消」。
        识图（§22.3）：只有当前这一轮（run_id）的用户消息与 view_image 结果带 image_refs，由 _attach_images 读取图片；
        更早轮次的图片换成文字占位，不重复发送。"""
        messages = self.trace.messages(conversation_id, limit=5000)
        start, upto = 0, None
        summary = None
        for index, message in enumerate(messages):
            if message["role"] == "event" and message.get("type") == "summary":
                start, summary, upto = index + 1, message["model_text"], message.get("upto")
        if upto is not None:
            # 摘要只替换 upto 之前的消息，最近几轮保持原文（摘要事件本身追加在末尾）。
            selected = [m for m in messages if m["seq"] > upto and not (m["role"] == "event" and m.get("type") == "summary")]
        else:
            selected = messages[start:]
        result: list[dict] = []
        if summary:
            result.append({"role": "user", "content": summary})
        pending: dict[str, str] = {}
        # 工具调用尚未全部返回时出现的事件（例如完全访问下自动执行的结果）先暂存，等结果齐了再放进去，
        # 否则会把这些调用截断成「已取消」。
        deferred: list[dict] = []

        def flush() -> None:
            nonlocal pending
            for call_id, name in pending.items():
                result.append({"role": "tool", "tool_call_id": call_id,
                               "content": prompts.wrap_result(name, "error", {"error": "已取消"}, False)})
            pending = {}
            result.extend(deferred)
            deferred.clear()

        for message in selected:
            role = message["role"]
            if role == "event":
                if message.get("model_text"):
                    (deferred if pending else result).append({"role": "user", "content": message["model_text"]})
                continue
            if role != "tool" and pending:
                flush()
            if role == "user":
                attachment = message.get("attachment")
                note = (f"\n\n[附件] 用户通过抓取脚本发来了 {attachment['source']} 的页面快照 snapshot_id={attachment['id']}"
                        f"（{attachment['pages']} 页，{attachment['images']} 个图片候选）。需要时用 analyze_page(snapshot_id=…) 分析。"
                        if isinstance(attachment, dict) and attachment.get("type") == "snapshot" else "")
                mentioned = message.get("mentions")
                if isinstance(mentioned, list) and mentioned:
                    note += "\n\n[引用] 用户用 @ 明确引用了这些路径（以 / 结尾的是文件夹）：" + "、".join(str(path) for path in mentioned)
                uploaded = message.get("attachments") if isinstance(message.get("attachments"), list) else []
                if uploaded:
                    note += "\n\n[附件] 用户在聊天框上传了这些文件（只读工具可以直接读取它们，即使不在作用域内）：" + "、".join(str(path) for path in uploaded)
                if message.get("attachments_missing"):
                    note += f"\n\n[附件] 另有 {message['attachments_missing']} 个附件已被移动或删除，无法再读取。"
                candidates = [str(path) for path in [*(mentioned if isinstance(mentioned, list) else []), *uploaded]
                              if isinstance(path, str) and not path.endswith("/")]
                pictures = [path for path in candidates if vision.is_image(path, None)]
                item = {"role": "user", "content": message["text"] + note}
                if candidates and can_see and message.get("run_id") == run_id:
                    item["image_refs"] = [path.lstrip("/") for path in dict.fromkeys(candidates)]
                elif pictures and can_see:
                    item["content"] += "\n\n[图片] " + "、".join(pictures) + " 是之前消息里的图片，内容不再附上；需要时调用 view_image 查看。"
                elif pictures:
                    item["content"] += "\n\n[图片] 当前模型不能识图，只能按文件名和类型处理这些图片：" + "、".join(pictures)
                result.append(item)
            elif role == "assistant":
                calls = message.get("tool_calls") or []
                result.append({"role": "assistant", "content": message.get("text") or "", "tool_calls": calls})
                pending = {call["id"]: call["name"] for call in calls}
            elif role == "tool":
                if message.get("call_id") in pending:
                    pending.pop(message["call_id"])
                    item = {"role": "tool", "tool_call_id": message["call_id"], "content": message["model_content"]}
                    refs = message.get("images") if isinstance(message.get("images"), list) else []
                    if refs and can_see and message.get("run_id") == run_id:
                        item["image_refs"] = [str(key) for key in refs]
                    elif refs:
                        item["content"] += "\n[图片已在之前查看过，内容不再附上；需要时重新调用 view_image]"
                    result.append(item)
                    if not pending:
                        flush()
        flush()
        return result

    @staticmethod
    def _estimate(messages: list[dict]) -> int:
        """粗略估算 token：图片不按 base64 长度计算，每张按固定值计（§22.3）。"""
        total = 0
        for message in messages:
            pictures = len(message.get("images") or message.get("image_refs") or [])
            text = {key: value for key, value in message.items() if key not in ("images", "image_refs")}
            total += len(json.dumps(text, ensure_ascii=False)) // 2 + pictures * vision.IMAGE_TOKENS
        return total

    async def _attach_images(self, state: RunState, history: list[dict]) -> None:
        """把 image_refs 换成图片数据（同一轮内缓存）。用户消息里不是图片的引用直接忽略；读不出的图片写进文字说明。"""
        limit = self.config.limits()["message_images"]
        max_bytes = int(tool_params(self._tool_settings(), "view_image").get("max_bytes", vision.DEFAULT_ORIGINAL_BYTES))
        for message in history:
            refs = message.pop("image_refs", None)
            if not refs:
                continue
            images: list[dict] = []
            notes: list[str] = []
            for key in refs:
                cached = state.images.get(key)
                if cached is None:
                    try:
                        cached = await vision.load_image(self.objects, state.bucket_id, key, max_bytes=max_bytes)
                    except vision.NotAnImage:
                        cached = False
                    except vision.ImageUnavailable as exc:
                        cached = str(exc)
                    state.images[key] = cached
                if cached is False:
                    continue
                if isinstance(cached, str):
                    notes.append(cached)
                elif message["role"] == "user" and len(images) >= limit:
                    notes.append(f"/{key} 超过每条消息 {limit} 张的上限，没有附上；需要时调用 view_image 查看")
                else:
                    images.append({"mime": cached["mime"], "data": cached["data"], "path": "/" + key})
            if images:
                message["images"] = images
                state.tainted = state.tainted or "查看了图片内容"
                if message["role"] == "user":
                    message["content"] += "\n\n[图片] 已随这条消息附上：" + "、".join(item["path"] for item in images)
            if notes:
                message["content"] += "\n\n[图片] " + "；".join(notes)

    async def _compact(self, state: RunState, model: dict, endpoint) -> bool:
        """压缩较早的历史：保留最近两轮用户消息及其后的全部内容原文，之前的部分（连同旧摘要）交给模型概括。"""
        messages = self.trace.messages(state.conversation_id, limit=5000)
        users = [m["seq"] for m in messages if m["role"] == "user"]
        previous = next((m for m in reversed(messages) if m["role"] == "event" and m.get("type") == "summary"), None)
        floor = previous.get("upto") or 0 if previous else 0
        keep_from = users[-2] if len(users) >= 2 and users[-2] > floor else (users[-1] if users else None)
        if keep_from is None or keep_from <= floor:
            return False
        old = [m for m in messages if floor < m["seq"] < keep_from and not (m["role"] == "event" and m.get("type") == "summary")]
        if len(old) < 4:
            return False
        lines = [previous["model_text"]] if previous else []
        for message in old:
            if message["role"] == "user":
                lines.append(f"[用户] {message.get('text') or ''}"[:2000])
            elif message["role"] == "assistant":
                calls = ", ".join(call["name"] for call in message.get("tool_calls") or [])
                lines.append(f"[助手] {message.get('text') or ''}"[:2000] + (f"（调用：{calls}）" if calls else ""))
            elif message["role"] == "tool":
                lines.append(f"[工具 {message.get('name')}] {message.get('status')}：{message.get('summary') or ''}"[:400])
            elif message.get("model_text"):
                lines.append(message["model_text"][:600])
        text = "\n".join(lines)[-120000:]
        reply = await self._model_call(state, model, endpoint, "你负责压缩对话历史。", [{"role": "user", "content": prompts.compact_prompt(text)}],
                                       [], max_tokens=1200, stream=False)
        if not reply.text.strip():
            return False
        self.trace.append(state.conversation_id, state.id, "event", {
            "type": "summary", "text": "较早的对话已压缩为摘要", "upto": keep_from - 1,
            "model_text": "[对话摘要（较早的消息已压缩）]\n" + reply.text.strip()}, tool_name="summary")
        return True

    async def _model_call(self, state: RunState, model: dict, endpoint, system: str, messages: list[dict], tools: list[ToolDef], *,
                          max_tokens: int | None, stream: bool = True):
        self._validate(state)
        await self._channel_slot(model["channel_id"])
        started = time.time()
        try:
            async def on_text(text: str) -> None:
                if state.thinking.get("start") is not None and state.thinking.get("end") is None:
                    state.thinking["end"] = time.monotonic()
                await state.emit({"type": "text_delta", "text": self.guard.redact(text)})

            async def on_reasoning(text: str) -> None:
                now = time.monotonic()
                state.thinking.setdefault("start", now)
                state.thinking["last"] = now
                await state.emit({"type": "reasoning_delta", "text": self.guard.redact(text)})
            for attempt in range(2):
                try:
                    self._validate(state)
                    state.thinking = {}
                    reply = await self.chat(endpoint, model["model"], system, messages, tools, max_tokens=max_tokens,
                                            **({"on_text": on_text, "on_reasoning": on_reasoning} if stream else {}))
                    break
                except ProviderError as exc:
                    self.trace.log_call(kind="model", run_id=state.id, conversation_id=state.conversation_id, user_id=state.user_id,
                                        channel_id=model["channel_id"], model_id=model["id"], started_at=started,
                                        duration_ms=int((time.time() - started) * 1000), status="error",
                                        http_status=exc.status, error_code=exc.code, error=f"模型请求失败（{exc.code}）")
                    if not exc.retryable or attempt:
                        raise
                    await state.emit({"type": "stream_reset"})
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
                            duration_ms=int((time.time() - started) * 1000), ttfb_ms=reply.ttfb_ms, status="ok", http_status=reply.status,
                            input_tokens=reply.input_tokens, output_tokens=reply.output_tokens, cached_tokens=reply.cached_tokens,
                            upstream_id=reply.upstream_id, items=len(reply.tool_calls))
        state.input_tokens += reply.input_tokens
        state.output_tokens += reply.output_tokens
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
        self._validate(state)
        spec = self._user_tools(state.user_id).get(call.name)
        started = time.time()
        arguments: dict = {}
        label = TOOLS[call.name].label if call.name in TOOLS else call.name
        await state.emit({"type": "tool_started", "call_id": call.id, "name": call.name, "label": label})
        status, summary, items, event = "ok", "", None, None
        images: list[str] = []
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
            if call.name == "http_request":
                url = arguments.get("url")
                decoded = unquote(url) if isinstance(url, str) else ""
                if self.guard.redact_value(arguments) != arguments or self.guard.redact(decoded) != decoded:
                    raise ToolError("HTTP 请求不能携带系统凭据")
            conversation = self.trace.conversation(state.user_id, state.conversation_id, include_hidden=True)
            usage = self.objects.metadata.db.execute("SELECT quota_bytes, used_bytes FROM buckets WHERE id=?", (state.bucket_id,)).fetchone()

            async def scope_request(target: str, reason: str) -> str:
                return self.trace.create_action(state.conversation_id, state.id, state.user_id, session_hash(state.token), "scope",
                                                call.name, {"from": display(conversation["scope_root"]), "to": display(target),
                                                            "reason": reason}, count=1)

            async def propose(kind: str, payload: dict, count: int) -> dict:
                if count > limits["action_items"]:
                    raise ToolError(f"匹配 {count} 项，超过单次上限 {limits['action_items']}，请缩小范围。")
                # 完全访问：普通修改自动确认执行；不可恢复、公开分享、超过 1000 项、读取过外部内容之后仍需确认（§19.5）。
                auto = False
                current = self.trace.conversation(state.user_id, state.conversation_id, include_hidden=True)
                if current["access_mode"] == "full" and self._full_access(state.user_id):
                    taint = state.tainted or self._conversation_taint(state.conversation_id)
                    if kind in CONFIRM_KINDS:
                        reason = "彻底删除与公开分享总是需要你确认"
                    elif count > 1000:
                        reason = "条目超过 1,000 项，需要你确认"
                    elif taint:
                        reason = f"对话中{taint}，为防止内容里的诱导指令，这次修改需要你确认"
                    else:
                        reason, auto = None, True
                    payload = {**payload, "auto": True} if auto else {**payload, "confirm_reason": reason}
                action_id = self.trace.create_action(state.conversation_id, state.id, state.user_id, session_hash(state.token), kind,
                                                     call.name, payload, count=count)
                row = self.trace.action(state.user_id, action_id)
                created: dict = {"action_id": action_id, "expires_at": row["expires_at"]}
                if payload.get("confirm_reason"):
                    created["confirm_reason"] = payload["confirm_reason"]
                if auto and self.trace.start_action(action_id):
                    task = self._launch_action(row, SimpleNamespace(id=state.user_id, bucket_id=state.bucket_id), state.token,
                                               payload, None, "自动执行")
                    try:
                        outcome = await asyncio.wait_for(asyncio.shield(task), min(AUTO_WAIT, max(2, limits["tool_seconds"] - 3)))
                    except TimeoutError:
                        outcome = {"status": "running"}
                    created.update(auto=True, outcome={key: outcome.get(key) for key in ("status", "ok", "skipped", "failed", "reasons")})
                return created

            def taint(reason: str) -> None:
                state.tainted = state.tainted or reason

            async def client(name: str, arguments: dict) -> dict:
                return await self._client_call(state, call.id, name, arguments)

            async def analyze(summary: dict, goal: str) -> dict:
                model = self.channels.model(state.model_id)
                endpoint = self.channels.endpoint(model["channel_id"])
                reply = await self._model_call(state, model, endpoint, prompts.ANALYSIS_SYSTEM,
                                               [{"role": "user", "content": prompts.analysis_prompt(goal, summary)}], [],
                                               max_tokens=800, stream=False)
                return web.parse_analysis(reply.text)

            context = ToolContext(state.user_id, state.bucket_id, conversation["scope_root"], self.objects, self.offline,
                                  state.view, state.location, tool_params(self._tool_settings(), call.name), shared,
                                  scope_request, {"used_bytes": usage["used_bytes"] if usage else None,
                                                  "quota_bytes": usage["quota_bytes"] if usage else None},
                                  conversation_id=state.conversation_id, limits=limits, propose=propose, trace=self.trace,
                                  analyze=analyze, client=client, taint=taint,
                                  public_config=knowledge.public_config(self.settings, state.environment), environment=state.environment,
                                  redact=self.guard.redact,
                                  readable=shared.setdefault("readable", self._readable(state.conversation_id)) if spec.level == "read" else frozenset(),
                                  vision=self.channels.vision(self.channels.model(state.model_id)))
            timeout = max(limits["tool_seconds"], spec.timeout or 0)
            output = await asyncio.wait_for(spec.handler(context, arguments), timeout)
            payload, truncated = self._fit(self.guard.redact_value(output.result), limits["tool_result_bytes"])
            summary, items, event = self.guard.redact(output.summary), output.items, self.guard.redact_value(output.event)
            ends_turn = output.ends_turn
            images = list(output.images)
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
            log.error("assistant tool failed name=%s", call.name)
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
        if images and status == "ok":
            # 只保存图片引用（对象键），图片本身在当前这一轮发给模型时再读取。
            body["images"] = images
        return body

    async def _run(self, state: RunState) -> None:
        status, stop_reason = "completed", "completed"
        steps = tool_calls = 0
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
            compacted = False
            while True:
                self._validate(state)
                model = self.channels.model(state.model_id)
                endpoint = self.channels.endpoint(model["channel_id"])
                can_see = self.channels.vision(model)
                tools = self._user_tools(state.user_id)
                if not can_see:
                    tools.pop("view_image", None)
                conversation = self.trace.conversation(state.user_id, state.conversation_id, include_hidden=True)
                scope_root = conversation["scope_root"]
                if forced_final is None:
                    if steps >= limits["max_steps"]:
                        forced_final = "模型调用次数"
                    elif tool_calls >= limits["max_tool_calls"]:
                        forced_final = "工具调用次数"
                    elif state.input_tokens + state.output_tokens >= limits["run_tokens"]:
                        forced_final = "token 预算"
                    elif time.monotonic() >= deadline:
                        forced_final = "运行时间"
                    if forced_final:
                        stop_reason = "limit"
                        message = {"type": "limit", "text": f"已达到本轮{forced_final}上限",
                                   "model_text": prompts.limit_reached(forced_final)}
                        seq = self.trace.append(state.conversation_id, state.id, "event", message)
                        await state.emit({"type": "message", "message": {"seq": seq, "role": "event", **message}})
                history = self._history(state.conversation_id, model["context_window"], run_id=state.id, can_see=can_see)
                window = model["context_window"] or 32000
                if self._estimate(history) > window * 0.7 and len(history) > 6 and not compacted:
                    compacted = await self._compact(state, model, endpoint)
                    if compacted:
                        history = self._history(state.conversation_id, model["context_window"], run_id=state.id, can_see=can_see)
                await self._attach_images(state, history)
                now = datetime.now(ZoneInfo(state.environment["timezone"])) if state.environment.get("timezone") else datetime.now().astimezone()
                usage = self.objects.metadata.db.execute("SELECT quota_bytes, used_bytes FROM buckets WHERE id=?",
                                                         (state.bucket_id,)).fetchone()
                system = prompts.system_prompt(date=now.strftime("%Y-%m-%d"), timezone=str(now.tzinfo), scope_root=display(scope_root),
                                               can_write=any(spec.level in ("write", "danger") for spec in tools.values()),
                                               can_read_text="read_text_file" in tools, can_web="analyze_page" in tools,
                                               can_danger=any(spec.level == "danger" for spec in tools.values()),
                                               can_share="propose_share" in tools, can_browser="ui_get_view" in tools,
                                               can_http="http_request" in tools, can_view_images=can_see,
                                               public_config=knowledge.public_config(self.settings, state.environment), environment=state.environment,
                                               access_mode="full" if conversation["access_mode"] == "full"
                                               and self._full_access(state.user_id) else "approval")
                pending = self.trace.pending_actions(state.conversation_id)
                history.append({"role": "user", "content": prompts.context_block(
                    scope_root=display(scope_root), view=state.view, location=display(state.location),
                    used=_fmt(usage["used_bytes"] if usage else 0),
                    quota="不限" if not usage or usage["quota_bytes"] is None else _fmt(usage["quota_bytes"]),
                    remaining_steps=max(0, limits["max_steps"] - steps), remaining_tools=max(0, limits["max_tool_calls"] - tool_calls),
                    pending="；".join(f"#{a['id']}（{KINDS.get(a['kind'], a['kind'])}，{a['count']} 项）" for a in pending) or "无")})
                definitions = [] if forced_final else [spec.definition() for spec in tools.values()]
                remaining = max(5.0, deadline + (60 if forced_final else 0) - time.monotonic())
                await state.emit({"type": "thinking"})
                reply = await asyncio.wait_for(self._model_call(state, model, endpoint, system, history, definitions,
                                                                max_tokens=model["max_output"]), remaining)
                steps += 1
                self._validate(state)
                calls = reply.tool_calls if not forced_final else []
                assistant = {"text": self.guard.redact(reply.text), "tool_calls": [{"id": c.id, "name": c.name, "arguments": c.arguments} for c in calls],
                             "model_id": model["id"], "input_tokens": reply.input_tokens, "output_tokens": reply.output_tokens}
                if reply.reasoning.strip():
                    started_at = state.thinking.get("start")
                    ended_at = state.thinking.get("end") or state.thinking.get("last")
                    assistant["reasoning"] = self.guard.redact(reply.reasoning.strip())
                    assistant["reasoning_ms"] = int((ended_at - started_at) * 1000) if started_at and ended_at else None
                seq = self.trace.append(state.conversation_id, state.id, "assistant", assistant)
                await state.emit({"type": "message", "message": {"seq": seq, "run_id": state.id, "created_at": time.time(), "role": "assistant", **assistant}})
                if not calls:
                    break
                allowed = min(limits["parallel_calls"], max(0, limits["max_tool_calls"] - tool_calls))
                accepted = calls[:allowed]
                results = await asyncio.gather(*(self._execute(state, call, tools, limits, shared) for call in accepted))
                for call in calls[allowed:]:
                    results.append({"call_id": call.id, "name": call.name, "label": call.name, "arguments": {}, "status": "error",
                                    "summary": "本轮工具调用过多", "result": {"error": "本轮工具调用过多"}, "items": None,
                                    "duration_ms": 0, "truncated": False, "event": None, "ends_turn": False,
                                    "model_content": prompts.wrap_result(call.name, "error", {"error": "本轮工具调用过多"}, False)})
                ends = False
                looping = False
                for call, body in zip(calls, results):
                    tool_calls += int(call in accepted)
                    seq = self.trace.append(state.conversation_id, state.id, "tool", body, tool_name=body["name"])
                    await state.emit({"type": "message", "message": self._public_message({"seq": seq, "run_id": state.id, "created_at": time.time(), "role": "tool", "tool_name": body["name"], **body})})
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
            log.error("assistant run failed id=%s", state.id)
            status, stop_reason = "failed", "internal"
            await self._fail(state, "助手内部错误，请稍后重试")
        finally:
            if acquired:
                self._release()
            if status == "completed" or stop_reason == "waiting_user":
                try:
                    await self._title(state)
                except Exception:
                    pass
            try:
                self.trace.finish_run(state.id, status=status, stop_reason=stop_reason, steps=steps, tool_calls=tool_calls,
                                      input_tokens=state.input_tokens, output_tokens=state.output_tokens)
                self.trace.add_usage(state.user_id, state.model_id, 0, 0, runs=1)
            except Exception:
                log.error("assistant run bookkeeping failed id=%s", state.id)
            state.status, state.stop_reason = status, stop_reason
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
            if state.input_tokens + state.output_tokens >= self.config.limits()["run_tokens"]:
                raise StopRun("limit", "本轮预算已用完")
            model = self.channels.model(state.model_id)
            endpoint = self.channels.endpoint(model["channel_id"])
            reply = await asyncio.wait_for(self._model_call(state, model, endpoint, "你负责给对话起标题。",
                                                            [{"role": "user", "content": prompts.title_prompt(first)}], [],
                                                            max_tokens=60, stream=False), 20)
            candidate = reply.text.strip().strip("“”\"'。.").splitlines()[0] if reply.text.strip() else ""
            if 0 < len(candidate) <= 30:
                title = candidate
        except (ProviderError, TimeoutError, NotFoundError, StopRun):
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
        disabled = [item["name"] for item in describe_tools(updated) if not item["enabled"]]
        if disabled:
            # 由已停用工具生成、尚未确认的操作立即作废。
            self.trace.expire_actions(tool_names=disabled)
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
        if payload.get("enabled") is False or "max_level" in payload:
            self.trace.expire_actions(user_id=user_id)
        if payload.get("enabled") is False:
            for run in self.runs.values():
                if run.user_id == user_id and run.finished_at is None and run.task:
                    run.task.cancel()
        return self.admin_policy(user_id)

    def admin_purge(self) -> None:
        for progress in self.executions.values():
            progress.cancel = True
        for run in self.runs.values():
            if run.finished_at is None and run.task:
                run.task.cancel()
        self.trace.purge_all()
        self.config.purge_all()

    async def cleanup(self, now: float | None = None) -> dict[str, int]:
        """维护任务：按保留期清理留痕与调用日志。"""
        return await self.metadata.run_in_thread(lambda: self.trace.cleanup(
            retention_days=self.config.setting("retention_days"), call_log_days=self.config.setting("call_log_days"), now=now))

    async def sync_catalog_if_due(self, now: float | None = None) -> dict[str, object]:
        """维护任务：每天同步一次模型目录。只在已经配置过模型渠道后自动同步，未使用助手的部署不访问外网。"""
        if not self.metadata.db.execute("SELECT 1 FROM ai_channels LIMIT 1").fetchone() or not self.catalog.due(now):
            return {"skipped": True}
        try:
            result = await self.catalog.sync()
        except ValueError as exc:
            return {"error": str(exc)[:200]}
        return {key: result[key] for key in ("total", "added", "updated", "models")}


def _fmt(size: int | None) -> str:
    value = float(size or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return "0 B"


__all__ = ["AssistantDenied", "AssistantService", "LIMITS"]
