"""文件助手服务：Agent 循环、运行状态与事件流、用户端与管理端服务方法（docs/assistant-design.md §2、§5、§6、§10）。

每条用户消息触发一个 run，在服务端以 asyncio 任务运行，与 HTTP 连接解耦：事件进入内存环形缓冲（断线后按 seq 续读），
消息与工具调用同时落库。每一步模型调用前都重新校验：系统已解锁、会话有效、账号可用、助手与模型仍启用、额度未用尽。

统一对话（§37）：普通与私密空间共用一个助手与一份历史。对话一旦涉及私密空间即被标记（assistant_conversations.private），
之后每个接口、每一步与每次读取私密内容都复核当前登录会话的私密授权（PrivateSpace.session_grants）；锁定后停止运行，
对话保留在历史中，需要重新解锁才能查看或继续。工具按参数逐次决定作用于普通文件还是私密空间（tools.call_area）。
"""

from __future__ import annotations

import asyncio
import collections
import hashlib
import json
import logging
import re
import secrets
import threading
import time
import traceback
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from types import SimpleNamespace
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

from ..api import normalize_user_path
from ..authn import AuthenticationError
from ..errors import NotFoundError, NotReadyError
from ..objects import PRIVATE_PREFIX, Scope
from ..offline.request import checked_url
from . import client_tools, http_tools, knowledge, prompts, providers, vision, web, web_tools, write_tools  # noqa: F401  导入即注册工具
from .attachments import PREFIX as ATTACHMENT_PREFIX, AttachmentStore
from .actions import DANGER_KINDS, KINDS, ActionExecutor, Progress, share_options
from .catalog import CatalogStore
from .channels import ChannelStore
from .config import HTTP_APPROVAL_TIMEOUT, LIMITS, PRIVATE_MARKED, PRIVATE_NOTICE, AssistantConfig
from .planning import META_TOOLS, Plan, display_plan
from .guard import SecretGuard
from .providers import ProviderError, ToolCall, ToolDef
from .tools import (
    PRIVATE_LABEL,
    TAINT_TOOLS,
    TOOLS,
    ToolContext,
    ToolError,
    call_area,
    describe_tools,
    display_key,
    effective_tools,
    key_of,
    private_enabled,
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


def session_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def display(key: str) -> str:
    """路径显示：私密空间写作「私密:/…」（§37.3），普通文件写作「/…」，不暴露系统区前缀。"""
    return display_key(key)


PROVIDER_FAILURES = {
    "unauthorized": "模型服务拒绝了请求，请联系管理员检查文件助手的设置。",
    "forbidden": "模型服务拒绝了请求，请联系管理员检查文件助手的设置。",
    "rate_limited": "模型服务现在太忙，请稍等片刻后重试。",
    "not_found": "所选模型暂时不可用，请换一个模型，或联系管理员。",
    "stream_error": "与模型服务的连接中断了，请重试。",
}


def provider_failure_text(code: str) -> str:
    """模型请求失败时给用户看的说明：只写原因与下一步，不带上游错误原文。"""
    return PROVIDER_FAILURES.get(code, "模型服务暂时出错，请稍后重试；如果一直失败，请联系管理员。")


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
    context: dict | None = None
    trim_events: Callable[[], None] | None = None
    seq: int = 0
    status: str = "queued"
    stop_reason: str | None = None
    finished_at: float | None = None
    task: asyncio.Task | None = None
    changed: asyncio.Condition = field(default_factory=asyncio.Condition)
    # 浏览器工具：等待页面回传结果的调用（call_id → Future）
    client_waiters: dict = field(default_factory=dict)
    approval_waiters: int = 0
    approval_started: float | None = None
    approval_seconds: float = 0
    action_revision: int = 0
    seen_action_revision: int = 0
    # 本轮读取过的不可信外部内容；仅作为来源标记，不改变访问模式。
    tainted: str | None = None
    listeners: int = 0
    thinking: dict = field(default_factory=dict)
    environment: dict = field(default_factory=dict)
    # 本轮已读取的图片（对象键 → {"mime","data",…} 或不能发送的原因）。只在内存中，不进入留痕。
    images: dict = field(default_factory=dict)
    # 对话是否涉及私密空间（§37.1）；涉及时每一步复核当前登录会话的私密授权。
    private: bool = False
    # 本轮访问私密空间时使用的授权：锁定通知按它找到要停止的运行，续期也只认它。
    access: str | None = None
    # 锁定导致的取消（停止原因记为 private_locked）；工具需要解锁时本轮结束并提示用户解锁。
    locked: bool = False
    private_needed: bool = False
    plan: Plan = field(default_factory=Plan)

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


def _run_clock(state) -> float:
    """人工审批暂停执行预算；并行审批的重叠等待只扣除一次。"""
    now = time.monotonic()
    started = getattr(state, "approval_started", None)
    return now - getattr(state, "approval_seconds", 0) - (now - started if started is not None else 0)


_REVIEW_PROMISE = re.compile(r"(?:^|[。！？\n])\s*(?:我(?:会|将|先)?|接下来(?:我会)?|现在(?:我会)?)?\s*(?:等待|等候)(?:你|您)(?:的)?(?:确认|审批|批准)"
                             r"|(?:你|您)(?:确认|批准|审批)(?:后|之后)[^。！？\n]{0,20}我(?:会|将)[^。！？\n]{0,12}继续")
# 结束语里承诺「稍后／自动继续」：本轮结束后不会有人继续，这样的回复不能当作最终回复。
_CONTINUE_PROMISE = re.compile(r"(?:我|助手)(?:会|将|再)?(?:自动|稍后|随后|马上|接着|继续)+(?:继续)?(?:处理|执行|下载|完成|进行|抓取|保存|整理)")


class AssistantDenied(PermissionError):
    """助手对当前用户不可用（未启用、未开放、无模型）。HTTP 层返回 403 并展示原因。"""


class PrivateRequired(Exception):
    """工具调用需要私密空间：当前登录会话未解锁，或还没确认私密说明。本轮结束，界面提示解锁（§37.3）。"""

    def __init__(self, reason: str = "locked") -> None:
        super().__init__(reason)
        self.reason = reason


class StopRun(Exception):
    def __init__(self, reason: str, text: str):
        super().__init__(text)
        self.reason, self.text = reason, text


class ContextFull(Exception):
    """压缩与兜底之后上下文仍超过窗口 85%（§23）。"""


class AssistantService:
    def __init__(self, accounts, objects, offline=None, *, user_api=None, settings=None) -> None:
        self.accounts, self.objects, self.offline, self.user_api = accounts, objects, offline, user_api
        self.settings = settings
        self.metadata, self.keystore = accounts.metadata, accounts.keystore
        self.config = AssistantConfig(self.metadata)
        self.trace = TraceStore(self.metadata, self.keystore)
        # 私密空间授权（PrivateSpace），由 HTTP 层注入；未注入时助手不能处理私密空间。
        self.private_space = None
        # 执行中的私密操作：操作编号 → 使用的私密授权（锁定时取消、执行期间续期）。
        self._private_actions: dict[str, str] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_thread: int | None = None
        self.attachments = AttachmentStore(self.metadata, objects)
        self.catalog = CatalogStore(self.metadata, self.config, log_call=self.trace.log_call)
        self.channels = ChannelStore(self.metadata, self.keystore, log_call=self.trace.log_call, catalog=self.catalog)
        self.guard = SecretGuard(self.channels, offline)
        self.http_guard = http_tools.HttpGuard()
        self.on_audit: Callable[[str, int, dict], None] | None = None  # 由 HTTP 层注入：自动执行的操作写审计
        self.chat = providers.chat  # 测试可替换为脚本化的假模型
        self.executor = ActionExecutor(objects, offline)
        self.executions: dict[str, Progress] = {}
        self._execution_tasks: dict[str, asyncio.Task] = {}
        # 与运行并行或在运行结束后继续的后台任务（生成标题）：保留引用，避免被回收。
        self._background: set[asyncio.Task] = set()
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

    def _availability(self, user_id: int, *, private: bool = False) -> tuple[bool, str | None]:
        if not self.config.enabled:
            return False, "管理员尚未启用文件助手"
        policy = self.config.policy(user_id)["effective"]
        if not policy["enabled"]:
            return False, "管理员未对你的账号开放文件助手"
        if private:
            if self.private_space is None or not policy["private"]:
                return False, "管理员未开放私密对话"
            if not self.channels.usable(private=True):
                return False, "管理员还没有允许任何模型用于私密对话"
            return True, None
        if not self.channels.usable():
            return False, "暂无可用的模型"
        return True, None

    def _require_available(self, user_id: int, *, private: bool = False) -> None:
        available, reason = self._availability(user_id, private=private)
        if not available:
            raise AssistantDenied(reason)

    # ---------- 私密空间授权（§37.2） ----------

    def _session_access(self, token: str) -> str | None:
        """当前登录会话有效的私密授权；未解锁或已失效时返回 None。复核本身不续期。"""
        from ..private import PrivateLocked
        if self.private_space is None or not token:
            return None
        access = self.private_space.session_grants.get(token)
        if not access:
            return None
        try:
            self.private_space.require(token, access)
        except (PrivateLocked, AuthenticationError, NotFoundError, NotReadyError, PermissionError):
            return None
        return access

    def _require_unlocked(self, token: str) -> str:
        """没有有效的私密授权时抛出 PrivateLocked（HTTP 423，界面提示解锁，不退出登录）。"""
        from ..private import PrivateLocked
        access = self._session_access(token)
        if access is None:
            raise PrivateLocked("这个对话涉及私密空间，请先解锁私密空间")
        return access

    def _check_private(self, token: str, conversation_id: str) -> None:
        """涉及私密的对话：任何读取和操作都要求当前登录会话已解锁私密空间。"""
        if self.trace.is_private(conversation_id):
            self._require_unlocked(token)

    def _private_ready(self, user_id: int, *, model_id: int | None = None) -> None:
        """处理私密内容的前提：管理员开放、已确认私密说明、模型允许（不含解锁，解锁另行检查）。"""
        self._require_available(user_id, private=True)
        if self.config.policy(user_id)["private_notice_ack_at"] is None:
            raise ValueError("请先阅读并确认私密空间的使用说明")
        if model_id is not None and not self.channels.is_usable(model_id, private=True):
            raise ValueError("当前模型未被允许处理私密空间的内容，请换一个允许私密对话的模型")

    def on_private_forget(self, access: str) -> None:
        """授权撤销（锁定、闲置过期、退出、改密）：停止用这个授权访问私密空间的运行与操作；对话保留在历史中（§37.2）。
        撤销可能发生在工作线程（对象层的 authorize），这时转交事件循环线程执行。"""
        if self._loop is not None and threading.get_ident() != self._loop_thread:
            try:
                self._loop.call_soon_threadsafe(lambda: self.on_private_forget(access))
            except RuntimeError:
                pass  # 事件循环已关闭
            return
        for run in list(self.runs.values()):
            if run.access == access and run.private and run.finished_at is None and run.task is not None:
                run.locked = True
                run.task.cancel()
        for action_id, held in list(self._private_actions.items()):
            progress = self.executions.get(action_id)
            if held == access and progress is not None:
                progress.cancel = True

    def private_busy(self, token: str, access: str) -> bool:
        """只保持同一会话、同一授权下涉及私密的真实执行；普通对话的运行与人工等待都不延长闲置时间（§30、§37.2）。"""
        if any(run.token == token and run.access == access and run.private
               and run.status in ("queued", "running") and run.finished_at is None and not run.approval_waiters
               and run.task is not None and not run.task.done() for run in list(self.runs.values())):
            return True
        return any(not task.done() and self._private_actions.get(action_id) == access
                   for action_id, task in list(self._execution_tasks.items()))

    def _finish_private_activity(self, token: str, access: str | None) -> None:
        """私密执行结束时复核一次授权，让闲置计时从结束时重新开始；已撤销的授权不会因此恢复。"""
        if access is not None and self.private_space is not None:
            try:
                self.private_space.require(token, access)
            except Exception:
                pass

    def _private_state(self, state: RunState) -> dict[str, bool]:
        """get_context 报告的私密空间状态：是否可用、当前登录会话是否已解锁。"""
        available = self._availability(state.user_id, private=True)[0]
        return {"available": available, "unlocked": available and self._session_access(state.token) is not None}

    def _url_allowed(self, conversation_id: str):
        """私密对话使用公共 HTTP(S) 地址，不再按用户原文、来源主机或已见地址设白名单。

        实际请求仍由 SafeHttpClient 检查公网地址、DNS 与每次跳转；这里不发网络请求。
        """
        def allowed(url: str, level: str) -> bool:
            if not isinstance(url, str) or not url.strip():
                return False
            if level == "text":
                return True  # curl／多链接仍由离线来源解析器逐项校验。
            try:
                checked_url(url.strip())
                return True
            except ValueError:
                return False
        return allowed

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

    def _choose_model(self, requested: object, fallback: int | None, *, private: bool = False) -> int:
        for candidate in (requested, fallback, self.config.default_model):
            if isinstance(candidate, int) and not isinstance(candidate, bool) and self.channels.is_usable(candidate, private=private):
                return candidate
        if private and isinstance(requested, int) and not isinstance(requested, bool):
            raise ValueError("这个模型不能用于私密对话，请选择管理员允许的模型")
        usable = self.channels.usable(private=private)
        if not usable:
            raise AssistantDenied("管理员还没有允许任何模型用于私密对话" if private else "暂无可用的模型")
        return int(usable[0]["id"])

    @staticmethod
    def _location(value: object) -> str:
        """普通文件区的位置或作用域；私密空间、回收站等系统区域不能作为作用域。"""
        if value in (None, "", "/"):
            return ""
        if not isinstance(value, str):
            raise ValueError("位置参数不正确")
        text = value.strip().lstrip("/")
        if not text:
            return ""
        if text.startswith(".tgdrive"):
            return ""
        return normalize_user_path(text, directory=True)

    @staticmethod
    def _place(value: object) -> str:
        """用户所在位置：普通目录，或私密空间里的目录（对象键带私密前缀，也接受「私密:/…」）。"""
        if isinstance(value, str):
            text = value.strip()
            if text.startswith(PRIVATE_LABEL):
                text = PRIVATE_PREFIX + text[len(PRIVATE_LABEL):].lstrip("/")
            text = text.lstrip("/")
            if text.startswith(PRIVATE_PREFIX):
                relative = text[len(PRIVATE_PREFIX):]
                if not relative or relative.startswith(".tgdrive"):
                    return PRIVATE_PREFIX
                return PRIVATE_PREFIX + normalize_user_path(relative, directory=True)
        return AssistantService._location(value)

    def _mentions(self, bucket_id: int, value: object, scope_root: str, token: str) -> list[str]:
        """@ 引用的文件或文件夹：普通文件必须在作用域内（超出时由界面先扩大作用域）；「私密:/…」引用私密空间，
        先要求已解锁再检查是否存在，锁定时不泄露私密文件是否存在（§37.1）。都必须存在。"""
        if value in (None, []):
            return []
        if not isinstance(value, list) or len(value) > MAX_MENTIONS or not all(isinstance(item, str) for item in value):
            raise ValueError(f"一次最多引用 {MAX_MENTIONS} 个文件或文件夹")
        keys: list[str] = []
        for item in value:
            raw = item.strip()
            private = raw.startswith(PRIVATE_LABEL)
            text = (raw[len(PRIVATE_LABEL):] if private else raw).lstrip("/")
            try:
                key = (PRIVATE_PREFIX if private else "") + normalize_user_path(text, directory=text.endswith("/"))
            except PermissionError as exc:
                raise ValueError("不能引用系统区域的内容") from exc
            except ValueError as exc:
                raise ValueError(f"引用的路径不正确：{item}") from exc
            if private:
                self._require_unlocked(token)
            elif not key.startswith(scope_root):
                raise ValueError(f"引用的 {display(key)} 不在作用域 {display(scope_root)} 内")
            query = ("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1", (bucket_id, key, key + "\U0010ffff")) \
                if key.endswith("/") else ("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (bucket_id, key))
            if self.metadata.db.execute(*query).fetchone() is None:
                raise ValueError(f"引用的 {display(key)} 不存在")
            if key not in keys:
                keys.append(key)
        return keys

    # ---------- 用户端：配置 ----------

    def user_config(self, token: str) -> dict[str, object]:
        session, account = self._session(token)
        available, reason = self._availability(account.id)
        private_available = self._availability(account.id, private=True)[0]
        policy = self.config.policy(account.id)
        level = policy["effective"]["max_level"]
        enabled = self._user_tools(account.id) if available else {}
        settings = self._tool_settings()
        tools = []
        for item in describe_tools(settings):
            reason_off = None
            if not item["enabled"]:
                reason_off = "管理员已关闭"
            elif item["name"] not in enabled:
                reason_off = "你的账号仅允许只读" if level == "read" else "暂不可用"
            # 能否作用于私密空间（§37.3）：不提供、管理员单独停用或受限时给出说明。
            private_note = None
            if private_available and item["private"] in ("never", "na"):
                private_note = item["private_note"] or "不能用于私密空间"
            elif private_available and not item["private_enabled"]:
                private_note = "管理员已对私密空间停用"
            elif private_available and item["private"] == "limited":
                private_note = item["private_note"]
            tools.append({"name": item["name"], "label": item["label"], "group": item["group"], "group_label": item["group_label"],
                          "level": item["level"], "description": item["description"].split("。")[0] + "。",
                          "available": reason_off is None, "reason": reason_off, "warning": item["warning"],
                          **({"note": private_note} if private_note else {})})
        daily = int(policy["effective"]["daily_tokens"])
        return {"available": available, "reason": reason, "models": self.channels.usable() if available else [],
                "default_model": self.config.default_model, "tools": tools, "max_level": level,
                "usage": {"today": self.trace.tokens_today(account.id), "limit": daily or None},
                "notice": self.config.notice, "notice_ack": policy["notice_ack_at"] is not None,
                "retention_days": self.config.setting("retention_days"), "full_access": self._full_access(account.id),
                # 私密空间（§37）：是否开放、单独的说明与确认、当前登录会话是否已解锁。
                "private_available": private_available, "private_notice": PRIVATE_NOTICE,
                "private_notice_ack": policy["private_notice_ack_at"] is not None,
                "private_unlocked": self._session_access(token) is not None}

    def ack_notice(self, token: str, csrf: str, private: bool = False) -> None:
        _, account = self._session(token, csrf=csrf, mutation=True)
        now = time.time()
        if private:
            self._require_available(account.id, private=True)
            if self.config.policy(account.id)["notice_ack_at"] is None:
                self.config.acknowledge_notice(account.id, now)
            self.config.acknowledge_private_notice(account.id, now)
            return
        self.config.acknowledge_notice(account.id, now)

    # ---------- 用户端：对话 ----------

    def list_conversations(self, token: str, *, cursor: str = "", archived: bool = False) -> dict[str, object]:
        _, account = self._session(token)
        result = self.trace.list_conversations(account.id, cursor=cursor, archived=archived)
        unlocked = self._session_access(token) is not None
        for item in result["conversations"]:
            item["scope"] = display(item.pop("scope_root"))
            item["active_run"] = self._active_run(item["id"])
            if item["private"] and not unlocked:
                # 锁定时只显示这是一个私密对话与时间，标题可能含私密文件名（§37.2）。
                item.update(title=None, locked=True)
        return result

    def _active_run(self, conversation_id: str) -> str | None:
        for run in self.runs.values():
            if run.conversation_id == conversation_id and run.finished_at is None:
                return run.id
        return None

    def create_conversation(self, token: str, csrf: str, payload: dict) -> dict[str, object]:
        _, account = self._session(token, csrf=csrf, mutation=True)
        self._require_available(account.id)
        location = self._place(payload.get("location"))
        # 在私密空间页面新建的对话涉及私密（§37.1）：要求已解锁、已开放并使用允许私密的模型。
        private = location.startswith(PRIVATE_PREFIX)
        if private:
            self._require_unlocked(token)
            self._require_available(account.id, private=True)
        scope_root = "" if private else location
        model_id = self._choose_model(payload.get("model_id"), None, private=private)
        mode = self._access_mode(account.id, payload.get("access_mode", "approval"))
        conversation_id = self.trace.create_conversation(account.id, scope_root, model_id,
                                                         keep=self.config.limits()["max_conversations"], private=private)
        if mode != "approval":
            self.trace.update_conversation(account.id, conversation_id, access_mode=mode)
        return self.conversation(token, conversation_id)

    def _access_mode(self, user_id: int, value: object) -> str:
        if value not in ACCESS_MODES:
            raise ValueError("访问模式只能是 approval 或 full")
        if value == "full" and not self._full_access(user_id):
            raise ValueError("管理员未允许你使用完全访问模式")
        return str(value)

    def conversation(self, token: str, conversation_id: str, *, before: int = 0) -> dict[str, object]:
        _, account = self._session(token)
        self.trace.conversation(account.id, conversation_id)
        self._check_private(token, conversation_id)
        row = self.trace.conversation(account.id, conversation_id)
        item = self.trace.conversation_json(row)
        item["scope"] = display(item.pop("scope_root"))
        if item["access_mode"] == "full" and not self._full_access(account.id):
            item["access_mode"] = "approval"
        if before < 0:
            raise ValueError("消息游标无效")
        messages = self.trace.messages(conversation_id, before=before, limit=2001, latest=True)
        has_earlier = len(messages) > 2000
        messages = messages[-2000:]
        context_messages = self.trace.messages(conversation_id, limit=2000, latest=True) if before else messages
        actions = [self._action_view(action) for action in self.trace.actions(conversation_id)]
        active_run = self._active_run(conversation_id)
        seen_plans: set[str] = set()
        for message in reversed(messages):
            event = message.get("event") or {}
            if event.get("type") == "plan" and event.get("id") and event["id"] not in seen_plans:
                seen_plans.add(event["id"])
                message["event"] = display_plan(event, actions, active=bool(active_run and message.get("run_id") == active_run))
        return {"conversation": item, "messages": [self._public_message(m) for m in messages], "context": self._context_usage(row, context_messages),
                "before_seq": messages[0]["seq"] if has_earlier else None,
                "actions": actions, "active_run": active_run,
                "attachments": self.attachments.conversation_usage(account.id, conversation_id)}

    def _context_usage(self, row, messages: list[dict]) -> dict | None:
        """最近一次模型请求的上下文占用；请求过长时也保存本次估算，避免仍显示上一轮的低占用。"""
        last = next((m for m in reversed(messages) if isinstance(m.get("context"), dict)
                     or m["role"] == "assistant" and (m.get("input_tokens") or m.get("prompt_estimate"))), None)
        if last is None:
            return None
        if isinstance(last.get("context"), dict):
            used = last["context"]["used"]
        else:
            actual = int(last.get("input_tokens") or 0)
            estimate = last.get("prompt_estimate") if isinstance(last.get("prompt_estimate"), int) else 0
            used = (actual if actual * 4 >= estimate else estimate) + int(last.get("output_tokens") or 0)
        try:
            window = self.channels.model(row["model_id"] or last.get("model_id"))["context_window"]
        except (NotFoundError, TypeError, KeyError):
            window = None
        return {"used": used, "window": window or 32000}

    @staticmethod
    def _public_message(message: dict) -> dict:
        """发给浏览器的消息：去掉只给模型看的包装文本。"""
        return {key: value for key, value in message.items() if key not in ("model_content", "images")}

    def update_conversation(self, token: str, csrf: str, conversation_id: str, payload: dict) -> dict[str, object]:
        _, account = self._session(token, csrf=csrf, mutation=True)
        self.trace.conversation(account.id, conversation_id)
        self._check_private(token, conversation_id)
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
                "model_text": "[系统事件] 用户切换到完全访问模式。常规修改、下载任务、HTTP 请求、缓存和缩略图提交自动执行；"
                              "读取文件、图片或网页不改变此模式。彻底删除、公开分享、跨私密空间移动和 HTTP DELETE 仍需确认。" if mode == "full" else
                              "[系统事件] 用户切换到审批模式，所有修改都需要用户在卡片上确认。"})
        item = self.trace.conversation_json(self.trace.conversation(account.id, conversation_id))
        item["scope"] = display(item.pop("scope_root"))
        return item

    def delete_conversation(self, token: str, csrf: str, conversation_id: str) -> None:
        # 删除不需要解锁：不读取任何内容，锁定时也能清理历史（§37.2）。
        _, account = self._session(token, csrf=csrf, mutation=True)
        run_id = self._active_run(conversation_id)
        if run_id and self.runs[run_id].user_id == account.id and self.runs[run_id].task:
            self.runs[run_id].task.cancel()
        self.trace.hide_conversation(account.id, conversation_id)
        self.trace.expire_actions(conversation_id)
        self.attachments.delete_for_conversation(conversation_id)

    # ---------- 用户端：对话附件（§22.5） ----------

    async def upload_attachment(self, token: str, csrf: str, name: str, content_type: str | None, body, size: int | None) -> dict:
        _, account = self._session(token, csrf=csrf, mutation=True)
        self._require_available(account.id)
        return await self.attachments.upload(account.id, account.bucket_id, unquote(name or ""), content_type, body, size)

    async def attachment_thumbnail(self, token: str, csrf: str, attachment_id: str, data: str | None, variant: str = "thumb") -> None:
        import base64
        import binascii
        _, account = self._session(token, csrf=csrf, mutation=True)
        raw = None
        if variant != "none":
            try:
                raw = base64.b64decode(str(data or "").split(",", 1)[-1], validate=True)
            except binascii.Error as exc:
                raise ValueError("缩略图数据不是有效的 base64") from exc
        await self.attachments.set_thumbnail(account.id, attachment_id, raw, variant)

    async def read_attachment_thumbnail(self, token: str, attachment_id: str, variant: str = "thumb"):
        _, account = self._session(token)
        return await self.attachments.thumbnail(account.id, attachment_id, variant)

    async def attachment_content(self, token: str, attachment_id: str, start: int = 0, end: int | None = None):
        _, account = self._session(token)
        return await self.attachments.content(account.id, attachment_id, start, end)

    def discard_attachment(self, token: str, csrf: str, attachment_id: str) -> None:
        _, account = self._session(token, csrf=csrf, mutation=True)
        self.attachments.discard(account.id, attachment_id)

    def discard_pending_attachments(self, token: str, csrf: str) -> dict[str, int]:
        _, account = self._session(token, csrf=csrf, mutation=True)
        return self.attachments.discard_pending(account.id)

    def save_attachment(self, token: str, csrf: str, attachment_id: str, payload: dict) -> dict[str, object]:
        """另存为普通文件：path 为目标文件夹（以 / 结尾）或完整文件路径；同名自动改名。"""
        _, account = self._session(token, csrf=csrf, mutation=True)
        row = self.attachments.row(account.id, attachment_id)
        target = self._save_target(payload.get("path"), row["name"])
        info = self.attachments.save(account.id, attachment_id, Scope(account.bucket_id), target)
        return {"path": display(info.key), "size": info.size, "attachment_id": attachment_id}

    @staticmethod
    def _save_target(value: object, name: str) -> str:
        if not isinstance(value, str) or len(value) > 1024:
            raise ValueError("请选择保存位置")
        text = value.strip()
        bare = text.strip("/")
        if not bare:
            return name
        folder = text.endswith("/")
        try:
            key = normalize_user_path(bare, directory=folder)
        except PermissionError as exc:
            raise ValueError("不能保存到私密空间或系统区域") from exc
        except ValueError as exc:
            raise ValueError("保存位置不正确") from exc
        return key + name if folder else key

    def attachment_stats(self, token: str) -> dict[str, object]:
        _, account = self._session(token)
        stats = self.attachments.stats(account.id)
        for item in stats["conversations"]:
            try:
                conversation = self.trace.conversation_json(self.trace.conversation(account.id, item["conversation_id"]))
                locked = conversation["private"] and self._session_access(token) is None
                item.update(title=None if locked else conversation.get("title"), archived=conversation.get("archived"), locked=locked)
            except (NotFoundError, PermissionError, ValueError):
                item.update(title=None, archived=False)
        return stats

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

    def _enter_private(self, token: str, csrf: str, account, conversation_id: str, model_id: int) -> str:
        """发送前进入私密空间：已解锁、已开放、已确认说明、模型允许；发送算一次交互，续期闲置计时。
        对话首次涉及私密时标记并在消息流里说明（§37.1）。返回使用的私密授权。"""
        access = self._require_unlocked(token)
        self._private_ready(account.id, model_id=model_id)
        self.private_space.activity(token, csrf, access, active=True)
        if self.trace.mark_private(conversation_id):
            self.trace.append(conversation_id, None, "event", {"type": "private", "text": PRIVATE_MARKED})
        return access

    async def send(self, token: str, csrf: str, conversation_id: str, payload: dict) -> dict[str, object]:
        session, account = self._session(token, csrf=csrf, mutation=True)
        row = self.trace.conversation(account.id, conversation_id)
        self._check_private(token, conversation_id)
        self._require_available(account.id)
        policy = self.config.policy(account.id)
        if policy["notice_ack_at"] is None:
            raise ValueError("请先阅读并确认文件助手的使用说明")
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("请输入消息")
        if len(text) > MAX_TEXT:
            raise ValueError(f"消息最多 {MAX_TEXT} 个字符")
        self._admit(account.id, row)
        view = payload.get("view") if isinstance(payload.get("view"), str) and len(payload.get("view")) <= 20 else "files"
        scope_root = row["scope_root"]
        choice = payload.get("scope")
        location = self._place(payload.get("location"))
        if choice not in (None, "conversation", "location", "root", "path"):
            raise ValueError("作用域选项不正确")
        # path：用户在目录树中选定的目录（排除私密空间与系统区域），属于用户本人的操作；私密空间里的位置不改变作用域。
        normal_location = "" if location.startswith(PRIVATE_PREFIX) else location
        new_scope = self._location(payload.get("scope_path")) if choice == "path" else \
            {"location": normal_location, "root": ""}.get(choice or "conversation", scope_root)
        mentions = self._mentions(account.bucket_id, payload.get("mentions"), new_scope, token)
        private = bool(row["private"]) or location.startswith(PRIVATE_PREFIX) or any(key.startswith(PRIVATE_PREFIX) for key in mentions)
        model_id = self._choose_model(payload.get("model_id"), row["model_id"], private=private)
        access = self._enter_private(token, csrf, account, conversation_id, model_id) if private else None
        attachments = self.attachments.check(account.id, conversation_id, payload.get("attachments"))
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
        message_seq = self._append_user(account.id, conversation_id, run_id, body, attachments)
        state = self._start(run_id, conversation_id, account, token, model_id, view, location,
                            environment=knowledge.client_environment(payload.get("environment")), private=private, access=access)
        return {"run_id": state.id, "message_seq": message_seq}

    def _append_user(self, user_id: int, conversation_id: str, run_id: str, body: dict, attachments: list[str],
                     keep: frozenset = frozenset()) -> int:
        """写入用户消息并把附件绑定到它；正文里保存附件的显示名与基本信息（不含存放位置）。"""
        seq = self.trace.append(conversation_id, run_id, "user", body)
        if attachments:
            body["attachments"] = self.attachments.bind(user_id, conversation_id, seq, attachments, keep=keep)
            self.trace.update_message(conversation_id, seq, body)
        return seq

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
        row = self.trace.conversation(account.id, conversation_id)
        self._check_private(token, conversation_id)
        self._require_available(account.id)
        if self.config.policy(account.id)["notice_ack_at"] is None:
            raise ValueError("请先阅读并确认文件助手的使用说明")
        seq = payload.get("seq")
        if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
            raise ValueError("消息编号不正确")
        self._admit(account.id, row)
        message = self.trace.message(conversation_id, seq)
        if message is None or message["role"] != "user":
            raise ValueError("只能从你发送的消息重试")
        view = payload.get("view") if isinstance(payload.get("view"), str) and len(payload.get("view")) <= 20 else message.get("view", "files")
        location = self._place(payload.get("location")) if payload.get("location") is not None else self._place(message.get("location"))
        body = {key: message[key] for key in ("text", "attachment") if key in message}
        body.update({"location": display(location), "view": view, "scope": display(row["scope_root"])})
        # 引用按当前作用域重新校验：期间文件可能被移动或删除。
        mentions = self._mentions(account.bucket_id, message.get("mentions"), row["scope_root"], token)
        if mentions:
            body["mentions"] = [display(key) for key in mentions]
        private = bool(row["private"]) or location.startswith(PRIVATE_PREFIX) or any(key.startswith(PRIVATE_PREFIX) for key in mentions)
        model_id = self._choose_model(payload.get("model_id"), row["model_id"], private=private)
        access = self._enter_private(token, csrf, account, conversation_id, model_id) if private else None
        # 重发这条消息的附件（改绑到新消息）；被截断的其他消息上的附件随之删除。
        attachments = self.attachments.message_ids(conversation_id, seq)
        keep = frozenset(attachments)
        self.attachments.delete_after(conversation_id, seq, keep=keep)
        self.trace.truncate(conversation_id, seq)
        self._switch_model(account.id, row, model_id)
        run_id = self.trace.start_run(conversation_id, model_id, prompts.PROMPT_VERSION)
        message_seq = self._append_user(account.id, conversation_id, run_id, body, attachments, keep)
        state = self._start(run_id, conversation_id, account, token, model_id, view, location,
                            environment=knowledge.client_environment(payload.get("environment")), private=private, access=access)
        return {"run_id": state.id, "message_seq": message_seq}

    def _start(self, run_id: str, conversation_id: str, account, token: str, model_id: int, view: str, location: str,
               *, environment: dict | None = None, private: bool | None = None, access: str | None = None) -> RunState:
        if private is None:
            private = self.trace.is_private(conversation_id)
        if private and access is None:
            access = self._session_access(token)
        state = RunState(run_id, conversation_id, account.id, account.bucket_id, token, model_id, view, location,
                         private=private, access=access)
        state.environment = environment if environment is not None else next(
            (run.environment for run in reversed(self.runs.values()) if run.conversation_id == conversation_id and run.token == token), {})
        state.trim_events = self._gc_runs
        if self._loop is None:
            self._loop, self._loop_thread = asyncio.get_running_loop(), threading.get_ident()
        self.runs[run_id] = state
        state.task = asyncio.get_running_loop().create_task(self._run(state))
        self._gc_runs()
        return state

    def share_link(self, token: str, conversation_id: str, path: str) -> dict:
        """分享令牌只按需交给界面，不存入工具消息或发送给模型。"""
        _, account = self._session(token)
        self._check_private(token, conversation_id)
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

    def _run_for(self, user_id: int, run_id: str, token: str | None = None) -> RunState:
        state = self.runs.get(run_id)
        if state is None or state.user_id != user_id:
            raise NotFoundError("运行不存在或已结束")
        if token is not None and state.private:
            self._require_unlocked(token)
        return state

    def stop(self, token: str, csrf: str, run_id: str) -> None:
        # 停止不读取任何内容，锁定后也可以停止（锁定本身已停止涉及私密的运行）。
        _, account = self._session(token, csrf=csrf, mutation=True)
        state = self._run_for(account.id, run_id)
        if state.finished_at is None and state.task is not None:
            state.task.cancel()

    async def events(self, token: str, run_id: str, after: int = 0):
        """事件流：先补发缓冲中 seq>after 的事件，再等待新事件，run 结束后关闭。"""
        _, account = self._session(token)
        state = self.runs.get(run_id)
        if state is not None and state.user_id == account.id:
            self._check_private(token, state.conversation_id)
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
            # 长连接也重验权限，不能在退出或隐藏对话后继续获得正文；涉及私密的对话还要复核私密授权（锁定即断开）。
            _, current = self._session(token)
            self._check_private(token, state.conversation_id)
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
        """对话框回传浏览器工具的执行结果：只接受发起这个 run 的登录会话、正在等待中的调用；
        涉及私密的对话要求同一登录会话仍已解锁私密空间（§37.2）。"""
        _, account = self._session(token, csrf=csrf, mutation=True)
        state = self._run_for(account.id, run_id, token)
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

    async def _client_call(self, state: RunState, call_id: str, name: str, arguments: dict, *, review: dict | None = None) -> dict:
        tool_call_id = call_id
        # 确认必须绑定本次冻结请求，不能被模型重复使用的工具调用编号串到另一条请求。
        if name == "http_request_approval":
            call_id = "http_" + secrets.token_hex(16)
            if review is not None:
                review.update(id=call_id, requested_at=time.time())
        if state.listeners <= 0:
            return {"error": "浏览器未连接：用户的对话框没有打开，无法操作页面", "decision": "cancelled"}
        future = asyncio.get_running_loop().create_future()
        state.client_waiters[call_id] = future
        approval = name == "http_request_approval"
        timeout = HTTP_APPROVAL_TIMEOUT if approval else CLIENT_TIMEOUT
        if approval:
            if not getattr(state, "approval_waiters", 0):
                state.approval_started = time.monotonic()
            state.approval_waiters = getattr(state, "approval_waiters", 0) + 1
        try:
            await state.emit({"type": "client_call", "call_id": call_id, "tool_call_id": tool_call_id, "name": name, "args": arguments,
                              "expires_at": time.time() + timeout, "requested_at": review.get("requested_at") if review is not None else time.time()})
            return await asyncio.wait_for(future, timeout)
        except TimeoutError:
            return {"error": "浏览器没有响应：对话框可能已关闭", "decision": "expired"}
        finally:
            state.client_waiters.pop(call_id, None)
            if approval:
                state.approval_waiters -= 1
                if not state.approval_waiters:
                    state.approval_seconds = getattr(state, "approval_seconds", 0) + time.monotonic() - state.approval_started
                    state.approval_started = None

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
        self._check_private(token, row["conversation_id"])
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

    def _action_row(self, token: str, account, action_id: str):
        row = self.trace.action(account.id, action_id)
        self._check_private(token, row["conversation_id"])
        return row

    @staticmethod
    def _action_private(row, payload: dict | None = None) -> bool:
        """操作是否作用于私密空间：私密区域生成的操作（scope 在私密前缀下）与跨区移动。"""
        if row["kind"] in ("move_out", "move_in"):
            return True
        return bool(payload and str(payload.get("scope") or "").startswith(PRIVATE_PREFIX))

    def action_detail(self, token: str, action_id: str) -> dict[str, object]:
        _, account = self._session(token)
        return self._action_view(self.trace.action_json(self._action_row(token, account, action_id)))

    def action_items(self, token: str, action_id: str, offset: int = 0) -> dict[str, object]:
        _, account = self._session(token)
        row = self._action_row(token, account, action_id)
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

    async def _cross_confirm(self, token: str, csrf: str, row, payload: dict, origin, ip) -> dict:
        """跨区移动的确认（§24.5.3）：目标目录由用户在卡片上决定。移出必须当场重新验证账号密码或通行密钥，
        验证只对这一次确认有效；移入需要当前登录会话已解锁私密空间。"""
        target = payload.get("target")
        if target is not None and (not isinstance(target, str) or len(target) > 1024):
            raise ValueError("目标目录不正确")
        confirm = {} if target is None else {"target": target}
        if row["kind"] == "move_out":
            password, passkey = payload.get("password"), payload.get("passkey")
            if isinstance(password, str) and password:
                await self.private_space.check_password(token, csrf, password, ip)
            elif isinstance(passkey, dict):
                await self.private_space.passkeys.private_unlock(token, csrf, passkey.get("request_id"), passkey.get("credential"), origin, ip)
            else:
                raise ValueError("移出私密空间需要重新验证身份：请输入登录密码或使用通行密钥")
        self._require_unlocked(token)
        return confirm

    async def decide_action(self, token: str, csrf: str, action_id: str, approve: bool, payload: dict,
                            *, origin=None, ip=None) -> dict[str, object]:
        """用户确认或拒绝待确认操作：只能由生成它的登录会话、带 CSRF、在过期前决定一次。"""
        session, account = self._session(token, csrf=csrf, mutation=True)
        row = self._action_row(token, account, action_id)
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
        if self._action_private(row, action_payload):
            # 作用于私密空间的操作：确认时必须已解锁，且仍允许处理私密内容。
            if self.private_space is None:
                raise ValueError("私密空间不可用")
            self._require_unlocked(token)
            self._require_available(account.id, private=True)
        confirm = None
        if row["kind"] in ("move_out", "move_in"):
            confirm = await self._cross_confirm(token, csrf, row, payload, origin, ip)
        if row["kind"] == "share":
            # 卡片中填写的有效期与访问密码只在这次请求的内存里使用，不写入操作记录、审计或对话。
            share = payload.get("share") if isinstance(payload.get("share"), dict) else {}
            confirm = {key: share[key] for key in ("expires_days", "password") if key in share}
            share_options(action_payload, confirm)
        if not self.trace.start_action(action_id):
            raise ValueError("该操作已处理或已过期")
        self._launch_action(row, account, token, action_payload, confirm, "已确认")
        if row["kind"] in ("move_out", "move_in") and self.on_audit is not None:
            # 跨区移动单独审计，只记条目数（§24.9）。
            self.on_audit("private.assistant." + row["kind"], account.id, {"count": row["count"]})
        return self.action_detail(token, action_id)

    def _guard(self, token: str, private: bool):
        """作用于私密空间的操作执行中逐项复核当前登录会话的私密授权（锁定后立即停止）。"""
        if not private:
            return None
        return lambda: self._require_unlocked(token)

    def _launch_action(self, row, account, token: str, payload: dict, confirm: dict | None, decision: str) -> asyncio.Task:
        action_id = row["id"]
        private = self._action_private(row, payload)
        access = self._session_access(token) if private else None
        if access is not None:
            self._private_actions[action_id] = access
        record = self.trace.action_recorder(action_id, row["conversation_id"])
        progress = Progress(total=row["count"])
        self.executions[action_id] = progress
        if decision == "已确认":
            self._action_event(row, decision, None, f"已确认：{KINDS.get(row['kind'], row['kind'])} {row['count']} 项")
        task = asyncio.get_running_loop().create_task(self._run_action(row, account, payload, progress, token, record, confirm, decision,
                                                                       private, access))
        self._execution_tasks[action_id] = task
        return task

    async def _continue_action(self, row, token: str) -> str | None:
        """用户确认的真实结果落地后继续最新任务；同一事件循环内检查并创建，避免并行结果重复续跑。"""
        cid, origin = row["conversation_id"], self.runs.get(row["run_id"])
        if origin and origin.finished_at is None and origin.task is not None:
            try:
                await asyncio.shield(origin.task)
            except asyncio.CancelledError:
                return None
        try:
            latest = self.trace.latest_run(cid)
            unseen = origin and origin.action_revision > origin.seen_action_revision
            if latest is None or latest["id"] != row["run_id"] or latest["status"] != "completed" \
                    or not (latest["stop_reason"] == "waiting_user" or unseen and latest["stop_reason"] in ("completed", "plan_incomplete")) \
                    or self.trace.has_open_actions(cid) or self.trace.continuation_blocked(cid, row["run_id"]):
                return None
            _, account = self._session(token)
            self._check_private(token, cid)
            conversation = self.trace.conversation(account.id, cid)
            private = bool(conversation["private"])
            self._require_available(account.id, private=private)
            self._admit(account.id, conversation)
            model_id = self._choose_model(None, conversation["model_id"], private=private)
            run_id = self.trace.start_run(cid, model_id, prompts.PROMPT_VERSION)
            state = self._start(run_id, cid, account, token, model_id, origin.view if origin else "files",
                                origin.location if origin else conversation["scope_root"], private=private)
            return state.id
        except (ValueError, PermissionError, AuthenticationError, NotFoundError, NotReadyError) as exc:
            # 不能静默承诺稍后继续；额度或权限不允许时留下可见原因。
            try:
                self._check_private(token, cid)
                self.trace.append(cid, None, "event", {"type": "continuation_paused", "text": "操作结果已保留，助手未继续：" + str(exc)[:200]})
            except (PermissionError, AuthenticationError, NotFoundError, NotReadyError):
                pass
            return None

    def _action_authorized(self, token: str, row, private: bool = False) -> bool:
        try:
            _, account = self._session(token)
            self._require_available(account.id, private=private)
            self._check_private(token, row["conversation_id"])
            self.trace.conversation(account.id, row["conversation_id"])
            return row["user_id"] == account.id and row["tool_name"] in self._user_tools(account.id)
        except (AuthenticationError, NotFoundError, NotReadyError, PermissionError):
            return False

    async def _run_action(self, row, account, payload: dict, progress: Progress, token: str, record, confirm: dict | None = None,
                          decision: str = "已确认", private: bool = False, access: str | None = None) -> dict:
        action_id = row["id"]
        undo = None
        try:
            undo = await self.executor.execute(user_id=account.id, bucket_id=account.bucket_id, payload=payload, progress=progress,
                                               authorized=lambda: self._action_authorized(token, row, private), confirm=confirm,
                                               guard=self._guard(token, private))
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
            origin = self.runs.get(row["run_id"])
            if decision == "已确认" and origin is not None:
                origin.action_revision += 1
                if origin.finished_at is None:
                    await origin.emit({"type": "resync"})
        except Exception:
            log.error("assistant action bookkeeping failed id=%s", action_id)
        if decision == "自动执行" and self.on_audit is not None:
            try:
                self.on_audit("assistant.action.auto", account.id, {"kind": row["kind"], "status": status, "count": row["count"]})
            except Exception:
                log.error("assistant audit failed id=%s", action_id)
        self._finish_private_activity(token, access)
        self._execution_tasks.pop(action_id, None)
        self._private_actions.pop(action_id, None)
        # 进度在内存里多保留一会儿，便于界面读取最终计数。
        await asyncio.sleep(0)
        self.executions.pop(action_id, None)
        if decision == "已确认" and status != "cancelled":
            await self._continue_action(row, token)
        return {"status": status, **result}

    def cancel_action(self, token: str, csrf: str, action_id: str) -> dict[str, object]:
        _, account = self._session(token, csrf=csrf, mutation=True)
        row = self._action_row(token, account, action_id)
        progress = self.executions.get(action_id)
        if row["status"] != "running" or progress is None:
            raise ValueError("操作不在执行中")
        progress.cancel = True
        return self.action_detail(token, action_id)

    async def undo_action(self, token: str, csrf: str, action_id: str) -> dict[str, object]:
        _, account = self._session(token, csrf=csrf, mutation=True)
        row = self._action_row(token, account, action_id)
        self.trace.conversation(account.id, row["conversation_id"])
        payload = self.trace.action_payload(row)
        private = self._action_private(row, payload)
        if not self._action_authorized(token, row, private):
            raise PermissionError("当前不能执行这类操作")
        data = self.trace.action_undo(row)
        if data is None or not self.trace.take_undo(action_id):
            raise ValueError("这个操作不能撤销（超过 24 小时、已撤销或不支持撤销）")
        try:
            result = await self.executor.undo(bucket_id=account.bucket_id, payload=payload, data=data,
                                              authorized=lambda: self._action_authorized(token, row, private),
                                              guard=self._guard(token, private))
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
        self.trace.conversation(account.id, conversation_id)
        self._check_private(token, conversation_id)
        self._require_available(account.id)
        if "analyze_page" not in self._user_tools(account.id):
            raise ValueError("管理员未启用网页分析，无法使用页面快照")
        source, pages, total = web.validate_snapshot(payload)
        snapshot_id = self.trace.create_collection(conversation_id, account.id, "snapshot", source=source, rule=None, urls=pages,
                                                   count=total)
        return {"snapshot_id": snapshot_id, "source": source, "pages": len(pages), "images": total}

    # ---------- Agent 循环 ----------

    def _validate(self, state: RunState) -> None:
        if not self.keystore.unlocked:
            raise StopRun("locked", "服务正在等待管理员完成启动，这次回复已停止。请稍后再试。")
        session = self.accounts.sessions.peek(state.token)
        if session is None or session.user_id != state.user_id:
            self.trace.expire_session_actions(session_hash(state.token))
            raise StopRun("session", "登录已过期，请重新登录后继续。")
        try:
            self.accounts.account_for_session(session)
        except (AuthenticationError, NotFoundError) as exc:
            raise StopRun("account", "这个账号已停用，请联系管理员。") from exc
        if state.private:
            # 涉及私密的对话：每一步都复核私密授权，失效立即结束且不再请求模型（§37.2）。
            access = self._session_access(state.token)
            if access is None:
                raise StopRun("private_locked", "私密空间已锁定，已停止。解锁后可以继续这个对话。")
            state.access = access
        available, reason = self._availability(state.user_id, private=state.private)
        if not available:
            raise StopRun("disabled", reason or "文件助手不可用")
        if not self.channels.is_usable(state.model_id, private=state.private):
            raise StopRun("model", "所选模型已停用或不能用于私密对话，请换一个模型" if state.private else "所选模型已停用，请换一个模型")
        daily = int(self.config.policy(state.user_id)["effective"]["daily_tokens"])
        if daily and self.trace.tokens_today(state.user_id) >= daily:
            raise StopRun("daily_limit", "今天的助手额度已经用完，明天 0 点恢复。需要更多额度请联系管理员。")

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

    def _stored_history(self, conversation_id: str, context_window: int | None) -> list[dict]:
        """跳过已摘要的前缀，读取与模型窗口相称的最新记录，避免固定读取最早 5000 条。"""
        summary = self.trace.latest_summary(conversation_id)
        floor = int(summary.get("upto") or 0) if summary else 0
        messages = self.trace.messages(conversation_id, after=floor, limit=max(5000, context_window or 32000), latest=True)
        if summary and not any(m["seq"] == summary["seq"] for m in messages):
            messages.append(summary)
            messages.sort(key=lambda m: m["seq"])
        return messages

    def _history(self, conversation_id: str, context_window: int | None, *, run_id: str | None = None,
                 can_see: bool = False, meta: dict | None = None) -> list[dict]:
        """把留痕还原成发给模型的消息。最近一次摘要之前的内容用摘要代替；缺少结果的工具调用补上「已取消」。
        识图（§22.3）：只有当前这一轮（run_id）的用户消息与 view_image 结果带 image_refs，由 _attach_images 读取图片；
        更早轮次的图片换成文字占位，不重复发送。
        上下文（§23）：早于最近两轮用户消息的工具结果只发摘要行；工具消息带 _run（属于本轮）与 _slim（摘要行）供 _shrink 使用。
        meta 收集最近一条助手消息的实际用量（model_id、input_tokens、prompt_estimate），用于 _measure。"""
        messages = self._stored_history(conversation_id, context_window)
        files = self.attachments.for_conversation(conversation_id)
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
        users = [m["seq"] for m in selected if m["role"] == "user"]
        recent_from = users[-2] if len(users) >= 2 else (users[-1] if users else 0)
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
                uploaded = [item for item in message.get("attachments") or [] if isinstance(item, dict) and item.get("name")] \
                    if isinstance(message.get("attachments"), list) else []
                if uploaded:
                    note += "\n\n[附件] 用户随消息上传了这些文件，用「附件:名称」读取（只读；要放进文件夹请用 propose_save_attachment）：" + \
                        "、".join(f"{ATTACHMENT_PREFIX}{item['name']}（{'图片' if item.get('image') else '文件'}，{_fmt(int(item.get('size') or 0))}）"
                                 for item in uploaded)
                candidates = [str(path) for path in (mentioned if isinstance(mentioned, list) else [])
                              if isinstance(path, str) and not path.endswith("/")]
                candidates += [ATTACHMENT_PREFIX + item["name"] for item in uploaded if item["name"] in files]
                # 引用保存的是显示路径（「私密:/…」或「/…」），读取图片时还原为对象键。
                keys = {path: files[path[len(ATTACHMENT_PREFIX):]] if path.startswith(ATTACHMENT_PREFIX) else key_of(path)
                        for path in candidates}
                pictures = [path for path in candidates if vision.is_image(path, None)]
                item = {"role": "user", "content": message["text"] + note}
                if candidates and can_see and message.get("run_id") == run_id:
                    item["image_refs"] = list(dict.fromkeys(keys[path] for path in candidates))
                elif pictures and can_see:
                    item["content"] += "\n\n[图片] " + "、".join(pictures) + " 是之前消息里的图片，内容不再附上；需要时调用 view_image 查看。"
                elif pictures:
                    item["content"] += "\n\n[图片] 当前模型不能识图，只能按文件名和类型处理这些图片：" + "、".join(pictures)
                result.append(item)
            elif role == "assistant":
                calls = message.get("tool_calls") or []
                result.append({"role": "assistant", "content": message.get("text") or "", "tool_calls": calls})
                pending = {call["id"]: call["name"] for call in calls}
                if meta is not None and message.get("input_tokens"):
                    meta.update(model_id=message.get("model_id"), input_tokens=int(message["input_tokens"]),
                                output_tokens=int(message.get("output_tokens") or 0), prompt_estimate=message.get("prompt_estimate"))
            elif role == "tool":
                if message.get("call_id") in pending:
                    pending.pop(message["call_id"])
                    slim = _slim_result(message)
                    old_turn = message["seq"] < recent_from
                    item = {"role": "tool", "tool_call_id": message["call_id"], "content": slim if old_turn else message["model_content"],
                            "_run": message.get("run_id") == run_id and run_id is not None, "_slim": slim}
                    refs = message.get("images") if isinstance(message.get("images"), list) and not old_turn else []
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
            text = {key: value for key, value in message.items() if key not in ("images", "image_refs") and not key.startswith("_")}
            total += len(json.dumps(text, ensure_ascii=False)) // 2 + pictures * vision.IMAGE_TOKENS
        return total

    @staticmethod
    def _measure(meta: dict, model_id: int, estimate: int) -> int:
        """§23：最近一次同模型调用的实际 input_tokens 加上之后的估算增量；没有实际用量时用估算。
        实际值不到当时估算的四分之一视为不可信（部分兼容服务的用量字段不准），也退回估算。"""
        if (meta.get("model_id") == model_id and meta.get("input_tokens") and isinstance(meta.get("prompt_estimate"), int)
                and meta["input_tokens"] * 4 >= meta["prompt_estimate"]):
            return max(estimate // 2, meta["input_tokens"] + estimate - meta["prompt_estimate"])
        return estimate

    def _shrink(self, history: list[dict], used: int, target: float) -> int:
        """§23 单轮兜底：本轮较早的工具结果从旧到新换成摘要行（最近一批保留原文），直到估算占用低于 target。"""
        last_assistant = max((index for index, item in enumerate(history) if item["role"] == "assistant"), default=-1)
        for index, item in enumerate(history):
            if used <= target:
                break
            if index > last_assistant or item["role"] != "tool" or not item.get("_run") or item["content"] == item.get("_slim"):
                continue
            before = self._estimate([item])
            item["content"] = item["_slim"]
            item.pop("image_refs", None)
            used -= before - self._estimate([item])
        return used

    async def _context(self, state: RunState, model: dict, endpoint, can_see: bool, fixed: int, *,
                       allow_compact: bool, force: bool = False) -> tuple[list[dict], int, int, bool]:
        """准备发给模型的历史（§23）：瘦身 → 估算 → 必要时模型摘要 → 本轮兜底。
        返回 (历史, 估算占用, 原始估算, 是否压缩过)。force 用于渠道报上下文超长后的重试。"""
        window = model["context_window"] or 32000
        meta: dict = {}
        history = self._history(state.conversation_id, model["context_window"], run_id=state.id, can_see=can_see, meta=meta)
        raw = self._estimate(history) + fixed
        used = self._measure(meta, model["id"], raw)
        # 摘要请求本身也可能被上游拒绝，停止时应保留这次准备请求的占用。
        state.context = {"used": used, "window": window}
        compacted = False
        if (force or (allow_compact and used > window * 0.7 and len(history) > 6)):
            compacted = await self._compact(state, model, endpoint)
            if compacted:
                meta = {}
                history = self._history(state.conversation_id, model["context_window"], run_id=state.id, can_see=can_see, meta=meta)
                raw = self._estimate(history) + fixed
                used = self._measure(meta, model["id"], raw)
        target = window * (0.5 if force else 0.85)
        if used > target:
            shrunk = self._shrink(history, used, target)
            raw -= used - shrunk
            used = shrunk
        return history, used, raw, compacted

    def _private_scope(self, state: RunState) -> Scope:
        return Scope(state.bucket_id, PRIVATE_PREFIX, private_access=True, authorize=lambda: self._require_unlocked(state.token))

    async def _attach_images(self, state: RunState, history: list[dict]) -> None:
        """把 image_refs 换成图片数据（同一轮内缓存）。用户消息里不是图片的引用直接忽略；读不出的图片写进文字说明。"""
        limit = self.config.limits()["message_images"]
        max_bytes = int(tool_params(self._tool_settings(), "view_image").get("max_bytes", vision.DEFAULT_ORIGINAL_BYTES))
        names = {key: name for name, key in self.attachments.for_conversation(state.conversation_id).items()}
        label = lambda key: ATTACHMENT_PREFIX + names[key] if key in names else display(key)
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
                        if key.startswith(vision.ATTACHMENT_ROOT) and key not in names:
                            raise vision.ImageUnavailable("附件已随对话删除")
                        cached = await vision.load_image(self.objects, state.bucket_id, key, max_bytes=max_bytes, label=label(key),
                                                         scope=self._private_scope(state) if key.startswith(PRIVATE_PREFIX) else None)
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
                    notes.append(f"{label(key)} 超过每条消息 {limit} 张的上限，没有附上；需要时调用 view_image 查看")
                else:
                    images.append({"mime": cached["mime"], "data": cached["data"], "path": label(key)})
            if images:
                message["images"] = images
                state.tainted = state.tainted or "查看了图片内容"
                if message["role"] == "user":
                    message["content"] += "\n\n[图片] 已随这条消息附上：" + "、".join(item["path"] for item in images)
            if notes:
                message["content"] += "\n\n[图片] " + "；".join(notes)

    async def _compact(self, state: RunState, model: dict, endpoint) -> bool:
        """压缩较早的历史：保留最近两轮用户消息及其后的全部内容原文，之前的部分（连同旧摘要）交给模型概括。"""
        messages = self._stored_history(state.conversation_id, model["context_window"])
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
                          max_tokens: int | None, stream: bool = True, quiet: bool = False):
        """quiet：与主回复并行的后台调用（生成标题），不改动思考计时，也不向界面发流事件。"""
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
                    if not quiet:
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
                    if not quiet:
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

    def _private_call(self, state: RunState, spec) -> Callable[[], None]:
        """工具调用进入私密空间（§37.3）：工具允许、已开放、模型允许、已确认说明、当前会话已解锁。
        首次进入时把对话标记为涉及私密；返回读写私密内容前复核授权的函数。"""
        if not private_enabled(self._tool_settings(), spec):
            raise ToolError(f"{spec.label}不能用于私密空间" + (f"：{spec.private_note}" if spec.private_note else "（管理员已停用）"))
        available, reason = self._availability(state.user_id, private=True)
        if not available:
            raise ToolError(reason or "私密空间不可用")
        if not self.channels.is_usable(state.model_id, private=True):
            raise ToolError("当前模型未被允许处理私密空间的内容。请告诉用户在模型菜单里换一个允许私密对话的模型后重试。")
        if self.config.policy(state.user_id)["private_notice_ack_at"] is None:
            raise PrivateRequired("notice")
        access = self._session_access(state.token)
        if access is None:
            raise PrivateRequired("locked")
        state.access = access
        if not state.private:
            state.private = True
            if self.trace.mark_private(state.conversation_id):
                seq = self.trace.append(state.conversation_id, state.id, "event", {"type": "private", "text": PRIVATE_MARKED})
                message = {"seq": seq, "run_id": state.id, "created_at": time.time(), "role": "event", "type": "private", "text": PRIVATE_MARKED}
                # 在同步检查里调用：事件交给事件循环稍后推送。
                task = asyncio.get_running_loop().create_task(state.emit({"type": "message", "message": message}))
                self._background.add(task)
                task.add_done_callback(self._background.discard)
        return lambda: self._require_unlocked(state.token)

    async def _execute(self, state: RunState, call, tools: dict, limits: dict, shared: dict) -> dict:
        """执行一个工具调用，返回要落库的工具消息正文。"""
        self._validate(state)
        spec = self._user_tools(state.user_id).get(call.name)
        started = time.time()
        arguments: dict = {}
        label = TOOLS[call.name].label if call.name in TOOLS else call.name
        await state.emit({"type": "tool_started", "call_id": call.id, "name": call.name, "label": label})
        status, summary, items, event = "ok", "", None, None
        http_review = None
        tool_timer = None
        plan = state.plan if isinstance(getattr(state, "plan", None), Plan) else None
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
            step_id = arguments.pop("plan_step_id", None)
            # 按路径参数决定这次调用作用于普通文件还是私密空间；留痕保留模型给出的原始路径（§37.3）。
            in_private, call_args = call_area(spec, arguments)
            authorize = self._private_call(state, spec) if in_private else None
            if call.name == "http_request":
                arguments.pop("max_bytes", None)  # 兼容旧上下文；新工具定义和留痕不再携带此参数。
            if plan is not None:
                plan.begin(call.id, call.name, step_id)
                await self._publish_plan(state)
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
                # 完全访问遵从用户选择；读取内容和批量数量不再使可撤销操作退回审批。
                auto = False
                current = self.trace.conversation(state.user_id, state.conversation_id, include_hidden=True)
                if current["access_mode"] == "full" and self._full_access(state.user_id):
                    if kind in ("move_out", "move_in"):
                        reason = "移出或移入私密空间总是需要你确认"
                    elif kind == "share" and (payload.get("options") or {}).get("require_password"):
                        reason = "需要设置访问密码的分享要由你填写密码并确认"
                    elif kind == "share" and not self.config.setting("full_auto_share"):
                        reason = "公开分享需要你确认"
                    elif kind == "purge" and not self.config.setting("full_auto_purge"):
                        reason = "彻底删除不可恢复，需要你确认"
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
                nonlocal http_review
                if name != "http_request_approval":
                    return await self._client_call(state, call.id, name, arguments)
                # 只保存已经脱敏的冻结预览；确认卡片与执行结果复用同一条加密工具消息。
                http_review = {"type": "http_request", "request": arguments, "decision": "cancelled"}
                if plan is not None:
                    plan.wait(call.id, "等待你在确认区批准 HTTP 请求")
                    await self._publish_plan(state)
                # 人工确认不消耗工具执行时间；恢复后仍使用等待前剩余的预算。
                remaining = max(0, tool_timer.when() - time.monotonic()) if tool_timer is not None else None
                if tool_timer is not None:
                    tool_timer.reschedule(None)
                try:
                    result = await self._client_call(state, call.id, name, arguments, review=http_review)
                finally:
                    if tool_timer is not None:
                        tool_timer.reschedule(time.monotonic() + remaining)
                decision = result.get("decision")
                if result.get("approved") is True:
                    http_review["decision"] = "approved"
                else:
                    http_review["decision"] = decision if decision in ("expired", "cancelled") else "rejected"
                return result

            def http_authorize() -> None:
                self._validate(state)
                if "http_request" not in self._user_tools(state.user_id):
                    raise ToolError("HTTP 请求工具已停用，未发送请求")

            def auto_approve() -> bool:
                self._validate(state)
                current = self.trace.conversation(state.user_id, state.conversation_id, include_hidden=True)
                return current["access_mode"] == "full" and self._full_access(state.user_id)

            async def analyze(summary: dict, goal: str) -> dict:
                model = self.channels.model(state.model_id)
                endpoint = self.channels.endpoint(model["channel_id"])
                reply = await self._model_call(state, model, endpoint, prompts.ANALYSIS_SYSTEM,
                                               [{"role": "user", "content": prompts.analysis_prompt(goal, summary)}], [],
                                               max_tokens=800, stream=False)
                return web.parse_analysis(reply.text)

            area = {"base": PRIVATE_PREFIX, "authorize": authorize} if in_private else {}
            context = ToolContext(state.user_id, state.bucket_id, PRIVATE_PREFIX if in_private else conversation["scope_root"],
                                  self.objects, self.offline,
                                  state.view, state.location, tool_params(self._tool_settings(), call.name), shared,
                                  scope_request, {"used_bytes": usage["used_bytes"] if usage else None,
                                                  "quota_bytes": usage["quota_bytes"] if usage else None},
                                  conversation_id=state.conversation_id, limits=limits, propose=propose, trace=self.trace,
                                  analyze=analyze, client=client, taint=taint,
                                  public_config=knowledge.public_config(self.settings, state.environment), environment=state.environment,
                                  redact=self.guard.redact,
                                  plan=plan,
                                  http_guard=self.http_guard, http_authorize=http_authorize, auto_approve=auto_approve,
                                  attachments=shared.setdefault("attachments", self.attachments.for_conversation(state.conversation_id)),
                                  read_only=spec.level == "read",
                                  vision=self.channels.vision(self.channels.model(state.model_id)),
                                  tainted=lambda: state.tainted or self._conversation_taint(state.conversation_id),
                                  url_allowed=self._url_allowed(state.conversation_id),
                                  require_private=lambda: self._private_call(state, spec),
                                  private_state=lambda: self._private_state(state),
                                  **area)
            timeout = max(limits["tool_seconds"], spec.timeout or 0)
            async with asyncio.timeout(timeout) as tool_timer:
                output = await spec.handler(context, call_args)
            browser = output.event or {}
            if browser.get("type") == "browser" and browser.get("action") == "copy" and state.private:
                # 涉及私密的对话：复制卡片提示内容会离开私密空间。
                browser["private"] = True
            if browser.get("type") == "browser" and browser.get("action") in ("cache", "uncache", "thumbnails") and auto_approve():
                # 缓存和缩略图提交不需要浏览器用户手势，按完全访问权限直接执行。
                response = await client(call.name, {**browser, "private": context.private})
                if not isinstance(response, dict) or response.get("error"):
                    raise ToolError(str(response.get("error") if isinstance(response, dict) else "浏览器没有返回操作结果")[:200])
                total = len(browser.get("items", []))
                def count(name: str, maximum: int) -> int:
                    value = response.get(name)
                    return max(0, min(value, maximum)) if isinstance(value, int) and not isinstance(value, bool) else 0
                ok = count("ok", total)
                skipped = count("skipped", total - ok)
                failed = total - ok - skipped
                output.summary = f"{label}（已自动执行：成功 {ok}，跳过 {skipped}，失败 {failed}）"
                output.result = {**output.result, "status": output.summary, "auto": True, "ok": ok,
                                 "skipped": skipped, "failed": failed, "note": str(response.get("note") or "")[:300]}
                output.event = None
            payload, truncated = self._fit(self.guard.redact_value(output.result), limits["tool_result_bytes"])
            summary, items, event = self.guard.redact(output.summary), output.items, self.guard.redact_value(output.event)
            ends_turn = output.ends_turn
            images = list(output.images)
        except PrivateRequired as exc:
            # 私密空间未解锁或未确认说明：结束本轮，由界面弹出解锁；用户解锁后会继续（§37.3）。
            state.private_needed = True
            await state.emit({"type": "private_required", "reason": exc.reason})
            text = "私密空间已锁定" if exc.reason == "locked" else "需要先确认私密空间的使用说明"
            status, payload, truncated, ends_turn = "error", {"error": f"{text}：已请用户在界面上处理，本轮到此结束；处理完成后会继续，请勿重试"}, False, True
            summary = "需要解锁私密空间" if exc.reason == "locked" else "需要确认私密空间说明"
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
        except Exception as exc:
            # 只记异常类型与出错位置：异常文本可能带文件路径（含私密空间），不写入日志。
            frame = traceback.extract_tb(exc.__traceback__)[-1:] or [None]
            where = f"{frame[0].filename.rsplit('/', 1)[-1]}:{frame[0].lineno}" if frame[0] else "?"
            log.error("assistant tool failed name=%s error=%s at=%s", call.name, type(exc).__name__, where)
            status, payload, truncated, ends_turn = "error", {"error": "工具执行失败"}, False, False
            summary = "工具执行失败"
        duration = int((time.time() - started) * 1000)
        if http_review is not None:
            event = self.guard.redact_value(http_review)
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
        if plan is not None:
            plan.observe(body)
            if plan.has_actions:
                plan.reconcile(self.trace.actions(state.conversation_id))
            if call.name == "update_plan" and status == "ok":
                body["event"] = self.guard.redact_value(plan.snapshot())
            await self._publish_plan(state)
        return body

    @staticmethod
    def _skipped_tool(call: ToolCall, reason: str, *, status: str = "limited") -> dict:
        """未执行的调用也补齐结果，但不作为工具执行错误或重复调用计数。"""
        try:
            arguments = json.loads(call.arguments or "{}")
        except ValueError:
            arguments = {}
        payload = {"error": reason}
        return {"call_id": call.id, "name": call.name, "label": TOOLS[call.name].label if call.name in TOOLS else call.name,
                "arguments": arguments if isinstance(arguments, dict) else {}, "status": status,
                "summary": reason, "result": payload, "items": None, "duration_ms": 0, "truncated": False,
                "event": None, "ends_turn": False, "model_content": prompts.wrap_result(call.name, status, payload, False)}

    async def _record_tool(self, state: RunState, body: dict) -> int:
        seq = self.trace.append(state.conversation_id, state.id, "tool", body, tool_name=body["name"])
        await state.emit({"type": "message", "message": self._public_message(
            {"seq": seq, "run_id": state.id, "created_at": time.time(), "role": "tool", "tool_name": body["name"], **body})})
        if body["event"]:
            await state.emit({"type": "tool_event", **body["event"]})
        return seq

    async def _publish_plan(self, state: RunState) -> None:
        plan = state.plan
        event = plan.snapshot()
        if not event or event["version"] == plan.published:
            return
        event = self.guard.redact_value(event)
        plan.published = event["version"]
        body = {"type": "plan", "event": event}
        seq = self.trace.append(state.conversation_id, state.id, "event", body, tool_name="update_plan")
        await state.emit({"type": "message", "message": {"seq": seq, "run_id": state.id, "created_at": time.time(), "role": "event", **body}})

    async def _tool_batch(self, state: RunState, calls: list[ToolCall], tools: dict, limits: dict,
                          shared: dict, deadline: float) -> list[dict]:
        """整轮时限内执行一批；取消时回收全部子任务，保留已经完成的结果。"""
        tasks = [asyncio.create_task(self._execute(state, call, tools, limits, shared)) for call in calls]
        try:
            done, pending = set(), set(tasks)
            while pending and (remaining := deadline - _run_clock(state)) > 0:
                finished, pending = await asyncio.wait(pending, timeout=remaining, return_when=asyncio.FIRST_COMPLETED)
                done.update(finished)
                for task in finished:
                    if task.cancelled():
                        raise asyncio.CancelledError()
                    if error := task.exception():
                        raise error
            return [task.result() if task in done else self._skipped_tool(
                call, "已达到本轮运行时间上限，本次调用已取消") for call, task in zip(calls, tasks)]
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _run(self, state: RunState) -> None:
        status, stop_reason = "completed", "completed"
        steps = tool_calls = 0
        spent_steps = spent_tools = 0  # 已结束各段的累计，写入运行记录
        acquired = False
        try:
            await self._acquire(state)
            acquired = True
            state.status = "running"
            await state.emit({"type": "run_started", "run_id": state.id, "model_id": state.model_id})
            limits = self.config.limits()
            deadline = _run_clock(state) + limits["run_seconds"]
            repeats: collections.Counter = collections.Counter()
            # 重复检测（§38）：同一调用得到同样的结果才算没有进展；第一次超限只提醒，同一段再超限才停止。
            repeat_refs: dict = {}
            loop_warned = False
            trim_warned = False
            errors = 0
            shared: dict = {}
            candidate = self.trace.latest_plan(state.conversation_id)
            if candidate:
                candidate = display_plan(candidate, self.trace.actions(state.conversation_id), active=False)
            state.plan = Plan(state.id, candidate)
            plan_checked = False
            review_checked = False
            continue_checked = False
            forced_final: str | None = None
            compacted = overflowed = False
            # 长任务分段（§32）：预算按段计算；计划仍有可执行步骤且本段有进展时，在同一轮中自动开始下一段。
            segment, segment_tokens, segment_done, segment_ok = 1, 0, state.plan.completed, 0
            while True:
                self._validate(state)
                model = self.channels.model(state.model_id)
                endpoint = self.channels.endpoint(model["channel_id"])
                can_see = self.channels.vision(model)
                tools = self._user_tools(state.user_id)
                if state.plan.has_actions:
                    state.plan.reconcile(self.trace.actions(state.conversation_id))
                await self._publish_plan(state)
                if not can_see:
                    tools.pop("view_image", None)
                conversation = self.trace.conversation(state.user_id, state.conversation_id, include_hidden=True)
                scope_root = conversation["scope_root"]
                if forced_final is None:
                    if steps >= limits["max_steps"]:
                        forced_final = "模型调用次数"
                    elif tool_calls >= limits["max_tool_calls"]:
                        forced_final = "工具调用次数"
                    elif limits["run_tokens"] and state.input_tokens + state.output_tokens - segment_tokens >= limits["run_tokens"]:
                        forced_final = "累计 token 预算"
                    elif _run_clock(state) >= deadline:
                        forced_final = "运行时间"
                    # 有进展：多完成了计划步骤，或本段至少有 3 次成功的工具调用；没有进展时续跑只会重复消耗。
                    progressed = state.plan.completed > segment_done or segment_ok >= 3
                    if forced_final and segment <= limits.get("auto_continue", 0) and progressed and state.plan.actionable \
                            and not self.trace.has_open_actions(state.conversation_id):
                        segment += 1
                        message = {"type": "continued", "text": f"已达到本段{forced_final}上限，计划还有 {state.plan.remaining} 步，自动继续（第 {segment} 段）",
                                   "model_text": prompts.auto_continue(forced_final, segment, state.plan.remaining)}
                        seq = self.trace.append(state.conversation_id, state.id, "event", message)
                        await state.emit({"type": "message", "message": {"seq": seq, "run_id": state.id, "role": "event", **message}})
                        spent_steps, spent_tools = spent_steps + steps, spent_tools + tool_calls
                        steps = tool_calls = segment_ok = 0
                        segment_tokens = state.input_tokens + state.output_tokens
                        segment_done = state.plan.completed
                        deadline = _run_clock(state) + limits["run_seconds"]
                        repeats.clear()
                        repeat_refs.clear()
                        loop_warned = trim_warned = False
                        compacted = plan_checked = review_checked = continue_checked = False
                        forced_final = None
                    if forced_final and state.plan.data and not state.plan.remaining:
                        # 计划已经全部完成，只差最终回复：不提示上限，也不把这一轮记为预算中断。
                        message = {"type": "finalize", "model_text": "[系统事件] 计划已全部完成，本段预算已用完，"
                                   "不能再调用工具。请根据已有结果给出最终回复。"}
                        self.trace.append(state.conversation_id, state.id, "event", message)
                    elif forced_final:
                        stop_reason = "limit"
                        message = {"type": "limit", "text": f"已达到本轮{forced_final}上限",
                                   "model_text": prompts.limit_reached(forced_final)}
                        seq = self.trace.append(state.conversation_id, state.id, "event", message)
                        await state.emit({"type": "message", "message": {"seq": seq, "role": "event", **message}})
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
                                               and self._full_access(state.user_id) else "approval",
                                               # 能处理私密空间：管理员开放且当前模型允许（是否已解锁见上下文块）。
                                               private=self._availability(state.user_id, private=True)[0]
                                               and self.channels.is_usable(state.model_id, private=True),
                                               can_move_private="propose_move_to_private" in tools,
                                               can_plan="update_plan" in tools, can_inspect="inspect_page" in tools,
                                               auto_share=bool(self.config.setting("full_auto_share")),
                                               auto_purge=bool(self.config.setting("full_auto_purge")))
                pending = self.trace.pending_actions(state.conversation_id)
                remaining, private_status = None, ""
                if self.private_space is not None and self._availability(state.user_id, private=True)[0]:
                    access = self._session_access(state.token)
                    grant = self.private_space.grants.get(access) if access else None
                    if grant is not None:
                        remaining = max(0, int(grant.expires_at - time.monotonic()))
                    else:
                        private_status = "已锁定（访问「私密:/」路径时会提示用户解锁）"
                    if not self.channels.is_usable(state.model_id, private=True):
                        remaining, private_status = None, "当前模型不能处理私密空间的内容"
                context_block = {"role": "user", "content": prompts.context_block(
                    private_remaining=remaining, private=private_status,
                    scope_root=display(scope_root), view=state.view, location=display(state.location),
                    used=_fmt(usage["used_bytes"] if usage else 0),
                    quota="不限" if not usage or usage["quota_bytes"] is None else _fmt(usage["quota_bytes"]),
                    remaining_steps=max(0, limits["max_steps"] - steps), remaining_tools=max(0, limits["max_tool_calls"] - tool_calls),
                    parallel_calls=limits["parallel_calls"],
                    plan=self.guard.redact(state.plan.context()) if "update_plan" in tools else "无",
                    pending="；".join(f"#{a['id']}（{KINDS.get(a['kind'], a['kind'])}，{a['count']} 项）" for a in pending) or "无")}
                definitions = [] if forced_final else [spec.definition(planning="update_plan" in tools) for spec in tools.values()]
                # 系统提示词、工具定义与动态上下文块也占窗口（§23）。
                fixed = (len(system) + len(json.dumps([vars(item) for item in definitions], ensure_ascii=False))) // 2 \
                    + self._estimate([context_block])
                window = model["context_window"] or 32000
                state.seen_action_revision = state.action_revision
                history, used, estimate, did = await self._context(state, model, endpoint, can_see, fixed, allow_compact=not compacted)
                compacted = compacted or did
                state.context = {"used": used, "window": window}
                await state.emit({"type": "context", **state.context})
                if used > window * 0.85:
                    raise ContextFull()
                if used > window * 0.7 and not trim_warned and "update_plan" in tools:
                    # 裁剪前提醒（§38）：较早的工具结果即将只剩摘要行，先把进度与编号写进计划的 notes。
                    trim_warned = True
                    context_block = {**context_block, "content": context_block["content"] + "\n\n[系统提示] 上下文已用约 "
                                     f"{round(used / window * 100)}%，较早的工具结果很快会被省略为摘要行（可用 recall_result 找回）。"
                                     "请先用 update_plan 的 notes 记下已完成的范围、下一步起点、结果集编号和游标，再继续。"}
                await self._attach_images(state, history)
                history.append(context_block)
                remaining = max(5.0, deadline + (60 if forced_final else 0) - _run_clock(state))
                await state.emit({"type": "thinking"})
                try:
                    reply = await asyncio.wait_for(self._model_call(state, model, endpoint, system, _clean(history), definitions,
                                                                    max_tokens=model["max_output"]), remaining)
                except ProviderError as exc:
                    if exc.code != "context_overflow" or overflowed:
                        raise
                    # 渠道报上下文超长：强制摘要并把本轮工具结果瘦身到窗口一半，重试一次（§23）。
                    overflowed = True
                    state.seen_action_revision = state.action_revision
                    history, used, estimate, did = await self._context(state, model, endpoint, can_see, fixed,
                                                                       allow_compact=True, force=True)
                    compacted = compacted or did
                    state.context = {"used": used, "window": window}
                    await state.emit({"type": "context", **state.context})
                    await self._attach_images(state, history)
                    history.append(context_block)
                    remaining = max(5.0, deadline + (60 if forced_final else 0) - _run_clock(state))
                    reply = await asyncio.wait_for(self._model_call(state, model, endpoint, system, _clean(history), definitions,
                                                                    max_tokens=model["max_output"]), remaining)
                actual = reply.input_tokens if reply.input_tokens * 4 >= estimate else estimate
                state.context = {"used": actual + reply.output_tokens, "window": window}
                await state.emit({"type": "context", **state.context})
                steps += 1
                self._validate(state)
                calls = reply.tool_calls if not forced_final else []
                waiting_claim = bool(_REVIEW_PROMISE.search(reply.text))
                executing_actions = not calls and self.trace.has_open_actions(state.conversation_id) \
                    and not self.trace.pending_actions(state.conversation_id)
                missing_review = not calls and not forced_final and not self.trace.has_open_actions(state.conversation_id) \
                    and (waiting_claim or bool(state.plan.data and any(
                        item["status"] == "waiting_user" for item in state.plan.data["items"])))
                repair_review = missing_review and not review_checked
                check_plan = not calls and not forced_final and not missing_review and state.plan.needs_check and not plan_checked
                # 没有待确认的操作却说「我会继续处理」就要结束：让模型现在就继续，或者给出真实的最终结果（一轮一次）。
                check_continue = not calls and not forced_final and not missing_review and not check_plan and not continue_checked \
                    and not self.trace.has_open_actions(state.conversation_id) and bool(_CONTINUE_PROMISE.search(reply.text))
                assistant = {"text": self.guard.redact(reply.text), "tool_calls": [{"id": c.id, "name": c.name, "arguments": c.arguments} for c in calls],
                             "model_id": model["id"], "input_tokens": reply.input_tokens, "output_tokens": reply.output_tokens,
                             "prompt_estimate": estimate}
                if check_plan or repair_review or check_continue:
                    assistant["text"] = ""
                elif missing_review:
                    assistant["text"] = "助手没有生成可确认的请求，尚需确认的这一步未执行。请补充要求后重试。"
                    status, stop_reason = "failed", "missing_review"
                elif executing_actions and waiting_claim:
                    assistant["text"] = "操作已确认，正在执行，完成后会继续处理原任务。"
                if reply.reasoning.strip():
                    started_at = state.thinking.get("start")
                    ended_at = state.thinking.get("end") or state.thinking.get("last")
                    assistant["reasoning"] = self.guard.redact(reply.reasoning.strip())
                    assistant["reasoning_ms"] = int((ended_at - started_at) * 1000) if started_at and ended_at else None
                seq = self.trace.append(state.conversation_id, state.id, "assistant", assistant)
                await state.emit({"type": "message", "message": {"seq": seq, "run_id": state.id, "created_at": time.time(), "role": "assistant", **assistant}})
                if not calls:
                    if not forced_final and state.action_revision > state.seen_action_revision:
                        if stop_reason == "missing_review":
                            status, stop_reason = "completed", "completed"
                        continue  # 模型生成回复期间操作才完成，先消费真实结果，不能停在旧的等待回复上。
                    if repair_review:
                        review_checked = True
                        message = {"type": "review_check", "text": "正在核对需要你确认的请求",
                                   "model_text": "[系统事件] 当前没有真实的待确认请求。不能只在文字中要求用户审批或承诺审批后继续。"
                                   "需要修改时调用对应 propose_* 工具，提问时调用 ask_user；完全访问下常规操作直接通过工具执行。"
                                   "若工作已完成请汇报真实结果，无法执行则说明原因，不要虚构确认卡片。"}
                        seq = self.trace.append(state.conversation_id, state.id, "event", message)
                        await state.emit({"type": "message", "message": {"seq": seq, "run_id": state.id, "role": "event", **message}})
                        continue
                    if check_continue:
                        continue_checked = True
                        message = {"type": "continue_check", "text": "继续处理尚未完成的部分",
                                   "model_text": "[系统事件] 你在回复里表示会继续处理，但没有调用工具，本轮即将结束，之后不会自动继续。"
                                   "还有可以完成的工作就现在调用工具继续；已经完成就汇报真实结果；需要用户决定时调用 ask_user 或对应的 propose_* 工具。"
                                   "不要再承诺稍后继续。"}
                        seq = self.trace.append(state.conversation_id, state.id, "event", message)
                        await state.emit({"type": "message", "message": {"seq": seq, "run_id": state.id, "role": "event", **message}})
                        continue
                    if check_plan:
                        plan_checked = True
                        message = {"type": "plan_check", "text": "正在核验计划中尚未完成的步骤",
                                   "model_text": "[系统事件] 计划仍有待执行或执行中的步骤。请依据实际工具结果更新计划，"
                                   "继续可完成的工作；若无法继续，明确标成等待、失败或暂停并说明原因，再给出最终回复。"}
                        seq = self.trace.append(state.conversation_id, state.id, "event", message)
                        await state.emit({"type": "message", "message": {"seq": seq, "run_id": state.id, "role": "event", **message}})
                        continue
                    waiting_actions = self.trace.has_open_actions(state.conversation_id)
                    if waiting_actions and not forced_final:
                        stop_reason = "waiting_user"
                    if state.plan.remaining and not missing_review:
                        waiting = waiting_actions or any(item["status"] == "waiting_user" or item.get("action_pending") for item in state.plan.data["items"])
                        if not forced_final:
                            stop_reason = "waiting_user" if waiting else "plan_incomplete"
                        message = {"type": "plan_incomplete", "text": f"计划还有 {state.plan.remaining} 个步骤未完成，"
                                   + ("请先处理需要确认的操作或回复。" if waiting else "当前进度已保留，可以继续处理。")}
                        seq = self.trace.append(state.conversation_id, state.id, "event", message)
                        await state.emit({"type": "message", "message": {"seq": seq, "run_id": state.id, "role": "event", **message}})
                    break
                ends = False
                looping = too_many_errors = False
                offset = 0
                skipped_status = "limited"
                skipped_reason = ""
                while offset < len(calls):
                    self._validate(state)
                    if tool_calls >= limits["max_tool_calls"]:
                        skipped_reason = "已达到本轮工具调用次数上限，本次调用未执行"
                        break
                    if limits["run_tokens"] and state.input_tokens + state.output_tokens - segment_tokens >= limits["run_tokens"]:
                        skipped_reason = "已达到本轮累计 token 预算，本次调用未执行"
                        break
                    if _run_clock(state) >= deadline:
                        skipped_reason = "已达到本轮运行时间上限，本次调用未执行"
                        break
                    size = min(limits["parallel_calls"], limits["max_tool_calls"] - tool_calls)
                    batch = calls[offset:offset + size]
                    # 计划更新先落地，后续工具才能绑定新步骤；其余独立调用仍按原有并发预算执行。
                    if batch[0].name == "update_plan":
                        batch = batch[:1]
                    else:
                        first_plan = next((index for index, call in enumerate(batch) if call.name == "update_plan"), len(batch))
                        batch = batch[:first_plan]
                    tool_calls += len(batch)
                    results = await self._tool_batch(state, batch, tools, limits, shared, deadline)
                    offset += len(batch)
                    for call, body in zip(batch, results):
                        ref = await self._record_tool(state, body)
                        if body["status"] == "limited":
                            continue
                        ends = ends or bool(body.get("ends_turn"))
                        segment_ok += body["status"] == "ok" and call.name not in META_TOOLS
                        errors = errors + 1 if body["status"] != "ok" else 0
                        too_many_errors = too_many_errors or errors >= limits["error_threshold"]
                        # 使用调用原文归一化，避免未解析参数等情况把不同调用合并成同一个空参数。
                        try:
                            repeated_args = json.loads(call.arguments or "{}")
                            if isinstance(repeated_args, dict):
                                repeated_args.pop("plan_step_id", None)
                            arguments = json.dumps(repeated_args, sort_keys=True, ensure_ascii=False)
                        except ValueError:
                            arguments = call.arguments
                        outcome = hashlib.sha256(str(body.get("model_content", "")).encode()).hexdigest()[:16]
                        key = (call.name, arguments, outcome)
                        repeats[key] += 1
                        repeat_refs.setdefault(key, ref)
                        if repeats[key] > limits["repeat_threshold"]:
                            looping, loop_key = True, key
                    if ends or looping or too_many_errors:
                        skipped_status = "cancelled"
                        skipped_reason = ("等待用户回复或确认，本次调用未执行" if ends else
                                          "检测到重复工具调用，本次调用未执行" if looping else "工具连续出错，本次调用未执行")
                        break
                for call in calls[offset:]:
                    body = self._skipped_tool(call, skipped_reason, status=skipped_status)
                    state.plan.observe(body)
                    await self._record_tool(state, body)
                if ends:
                    # 需要解锁私密空间时单独标记，界面据此弹出解锁并在解锁后继续（§37.3）。
                    stop_reason = "private_locked" if state.private_needed else "waiting_user"
                    break
                if looping and not loop_warned:
                    loop_warned = True
                    name = loop_key[0]
                    repeats[loop_key] = 0
                    message = {"type": "repeat_check", "text": "发现重复调用，已提醒助手换个做法",
                               "model_text": f"[系统事件] 你已经多次用相同参数调用 {name}，每次结果都相同（第一次的结果 ref={repeat_refs[loop_key]}）。"
                               "不要再重复这次调用：需要之前的结果用 recall_result(ref) 读取；把进度、结果集编号和游标记在 update_plan 的 notes 里；"
                               "需要推进时换参数（如 offset、cursor、下一项）或换方法；确实无法推进就说明原因后结束。"}
                    seq = self.trace.append(state.conversation_id, state.id, "event", message)
                    await state.emit({"type": "message", "message": {"seq": seq, "run_id": state.id, "role": "event", **message}})
                    continue
                if looping:
                    raise StopRun("loop", "助手重复调用了相同的工具，已停止。请换一种说法或缩小范围。")
                if too_many_errors:
                    raise StopRun("errors", "工具连续出错，已停止。请换一种说法或缩小范围。")
        except asyncio.CancelledError:
            # 锁定私密空间也会取消涉及私密的运行（§37.2），停止原因单独记录。
            status, stop_reason = "stopped", "private_locked" if state.locked else "stopped"
            message = {"type": "stopped", "text": "私密空间已锁定，已停止。解锁后可以继续这个对话。" if state.locked else "已停止"}
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
        except ContextFull:
            status, stop_reason = "stopped", "context"
            await self._context_full(state)
        except TimeoutError:
            status, stop_reason = "failed", "timeout"
            await self._fail(state, "这次处理时间太长，已经停止。可以缩小范围（例如指定某个文件夹）后再试。")
        except ProviderError as exc:
            if exc.code == "context_overflow":
                status, stop_reason = "stopped", "context"
                await self._context_full(state, upstream=True)
            else:
                status, stop_reason = "failed", exc.code
                # 用户只看到原因与下一步；上游的原始错误（已脱敏）留在调用日志里给管理员排查。
                await self._fail(state, provider_failure_text(exc.code), retry=True)
        except Exception:
            log.error("assistant run failed id=%s", state.id)
            status, stop_reason = "failed", "internal"
            await self._fail(state, "助手出了点问题，没有完成这次回复。请稍后重试。", retry=True)
        finally:
            # 收尾必须完整执行：停止请求可能在收尾期间到达，CancelledError 不能跳过运行记录与 run_finished，
            # 否则界面会一直停在运行中，之后的停止也不再生效。
            self._finish_private_activity(state.token, state.access)
            try:
                if state.plan.has_actions:
                    state.plan.reconcile(self.trace.actions(state.conversation_id))
                state.plan.finish(status, stop_reason)
                await self._publish_plan(state)
            except asyncio.CancelledError:
                pass
            except Exception:
                log.error("assistant plan bookkeeping failed id=%s", state.id)
            if acquired:
                self._release()
            try:
                self.trace.finish_run(state.id, status=status, stop_reason=stop_reason, steps=spent_steps + steps, tool_calls=spent_tools + tool_calls,
                                      input_tokens=state.input_tokens, output_tokens=state.output_tokens)
                self.trace.add_usage(state.user_id, state.model_id, 0, 0, runs=1)
            except Exception:
                log.error("assistant run bookkeeping failed id=%s", state.id)
            state.status, state.stop_reason = status, stop_reason
            state.finished_at = time.time()
            try:
                await asyncio.shield(state.emit({"type": "run_finished", "status": status, "stop_reason": stop_reason,
                                                 "usage": {"today": self.trace.tokens_today(state.user_id)}}))
            except asyncio.CancelledError:
                pass
            if status == "completed" or stop_reason == "waiting_user":
                # 标题在这一轮结束之后于后台生成（涉及私密的对话也生成，锁定时列表隐藏，§37.1）：回复结束不用再等一次模型调用，
                # 停止请求也不会打断收尾。界面在运行结束后补读标题。
                task = asyncio.get_running_loop().create_task(self._title_safely(state))
                self._background.add(task)
                task.add_done_callback(self._background.discard)

    async def _context_full(self, state: RunState, *, upstream: bool = False) -> None:
        """压缩与兜底之后仍放不下：结束本轮，不再请求渠道（§23）。"""
        text = ("模型服务报告本次请求超过上下文上限，自动压缩后重试仍未成功。请检查模型的上下文配置，或选择上下文更大的模型；也可新建对话继续。"
                if upstream else "本次请求已接近模型上下文上限，自动压缩后仍无法容纳。可以减少本轮内容、选择上下文更大的模型，或新建对话继续。")
        message = {"type": "limit", "text": text, "context": state.context,
                   "model_text": "[系统事件] 上一轮因对话上下文已满而停止。请简要总结已完成的部分，并建议用户新建对话继续。"}
        try:
            if state.context:
                await state.emit({"type": "context", **state.context})
            seq = self.trace.append(state.conversation_id, state.id, "event", message)
            await state.emit({"type": "message", "message": {"seq": seq, "role": "event", **message}})
        except Exception:
            pass

    async def _fail(self, state: RunState, text: str, *, retry: bool = False) -> None:
        message = {"type": "error", "text": text, "retry": retry}
        try:
            seq = self.trace.append(state.conversation_id, state.id, "event", message)
            await state.emit({"type": "message", "message": {"seq": seq, "role": "event", **message}})
        except Exception:
            pass

    async def _title_safely(self, state: RunState) -> None:
        """后台生成标题：失败只保留默认标题，不影响这一轮回复。"""
        try:
            await self._title(state)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("assistant title failed run=%s", state.id)

    async def _title(self, state: RunState) -> None:
        row = self.trace.conversation(state.user_id, state.conversation_id, include_hidden=True)
        if row["title"] is not None:
            return
        first = next((m["text"] for m in self.trace.messages(state.conversation_id, limit=50) if m["role"] == "user"), "")
        title = first.strip().splitlines()[0][:20] if first.strip() else "新对话"
        try:
            budget = self.config.limits()["run_tokens"]
            if budget and state.input_tokens + state.output_tokens >= budget:
                raise StopRun("limit", "这次回复的处理量已到上限，已经停止。可以缩小范围后继续。")
            model = self.channels.model(state.model_id)
            endpoint = self.channels.endpoint(model["channel_id"])
            reply = await asyncio.wait_for(self._model_call(state, model, endpoint, "你负责给对话起标题。",
                                                            [{"role": "user", "content": prompts.title_prompt(first)}], [],
                                                            max_tokens=60, stream=False, quiet=True), 20)
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
        result = self.config.update_settings(payload, model_exists=self.channels.is_usable)
        if payload.get("enabled") is False or payload.get("private") is False:
            self._stop_private()  # 关闭助手或私密能力：立即停止进行中的涉及私密的运行（对话保留）
        return result

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
        if payload.get("enabled") is False or payload.get("private") is False:
            self._stop_private(user_id)
        return self.admin_policy(user_id)

    def _stop_private(self, user_id: int | None = None) -> None:
        """管理员关闭助手或私密能力：停止进行中的涉及私密的运行与操作；对话保留在历史中（§37.2）。"""
        for run in list(self.runs.values()):
            if run.private and run.finished_at is None and run.task is not None and (user_id is None or run.user_id == user_id):
                run.task.cancel()
        if user_id is None:
            for action_id in list(self._private_actions):
                progress = self.executions.get(action_id)
                if progress is not None:
                    progress.cancel = True

    def admin_purge(self) -> None:
        for progress in self.executions.values():
            progress.cancel = True
        for run in self.runs.values():
            if run.finished_at is None and run.task:
                run.task.cancel()
        self.attachments.purge_all()
        self.trace.purge_all()
        self.config.purge_all()

    async def cleanup(self, now: float | None = None) -> dict[str, int]:
        """维护任务：按保留期清理留痕与调用日志；附件先于对话删除，之后再兜底清理残留与超时未发送的附件。"""

        def work():
            now_ = now or time.time()
            expired = [row[0] for row in self.metadata.db.execute(
                "SELECT id FROM assistant_conversations WHERE updated_at<? LIMIT 2000",
                (now_ - self.config.setting("retention_days") * 86400,))]
            for conversation_id in expired:
                self.attachments.delete_for_conversation(conversation_id)
            report = self.trace.cleanup(retention_days=self.config.setting("retention_days"),
                                        call_log_days=self.config.setting("call_log_days"), now=now_)
            report["attachments"] = self.attachments.cleanup(now_)
            return report
        return await self.metadata.run_in_thread(work)

    async def sync_catalog_if_due(self, now: float | None = None) -> dict[str, object]:
        """维护任务：每天同步一次模型目录。只在已经配置过模型渠道后自动同步，未使用助手的部署不访问外网。"""
        if not self.metadata.db.execute("SELECT 1 FROM ai_channels LIMIT 1").fetchone() or not self.catalog.due(now):
            return {"skipped": True}
        try:
            result = await self.catalog.sync()
        except ValueError as exc:
            return {"error": str(exc)[:200]}
        return {key: result[key] for key in ("total", "added", "updated", "models")}


# 摘要行保留的结果字段（§38）：继续工作所需的编号、游标与进度，裁剪后不必重新调用工具。
_KEPT_FIELDS = ("collection_id", "action_id", "snapshot_id", "plan_id", "next_offset", "next_cursor", "cursor",
                "count", "total", "pages", "complete", "stopped", "progress", "url", "path")


def _kept(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    parts = []
    for key in _KEPT_FIELDS:
        value = result.get(key)
        if value is None or value == "" or isinstance(value, (list, dict)) and key != "progress":
            continue
        text = json.dumps(value, ensure_ascii=False) if isinstance(value, dict) else str(value)
        parts.append(f"{key}={text[:160]}")
    return "；保留：" + "，".join(parts) if parts else ""


def _slim_result(message: dict) -> str:
    """工具结果的摘要行（§23、§38）：工具名、状态、一行摘要与关键字段；原文可用 recall_result(ref) 找回。"""
    status = "成功" if message.get("status") == "ok" else "出错"
    ref = f"，可用 recall_result(ref={message['seq']}) 重新读取" if message.get("seq") else ""
    return (f"[原始结果已省略{ref}] {message.get('name') or message.get('tool_name') or '工具'} {status}："
            f"{message.get('summary') or '无摘要'}{_kept(message.get('result'))}")


def _clean(history: list[dict]) -> list[dict]:
    """去掉只供内部使用的 _ 开头字段。"""
    return [{key: value for key, value in item.items() if not key.startswith("_")} for item in history]


def _fmt(size: int | None) -> str:
    value = float(size or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return "0 B"


__all__ = ["AssistantDenied", "AssistantService", "LIMITS"]
