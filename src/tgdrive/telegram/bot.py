"""Telegram 交互机器人：用户在 Telegram 私聊里使用 Tessera。

与存储通道的 Bot 分开配置（管理员在「存储通道」页另填一个 token，只以密文保存在 settings 表）。服务进程用 getUpdates
长轮询收消息（单进程部署，不需要公网地址或 Webhook）。用户在网页「设置 → Telegram」生成一次性绑定链接
（t.me/<机器人>?start=<绑定码>，10 分钟内有效，只在进程内存里），在 Telegram 里点开即完成绑定；一个账号绑定一个私聊。

已绑定的私聊里：
- 发链接、M3U8 或 curl 命令：解析后在设置的保存位置创建离线下载（每项选清晰度最高的一个）；
- 发送或转发文件（照片、视频、音频、文档）：保存到同一位置。官方 Bot API 只能下载 20 MB 以内的文件；
  配置自建 Bot API 服务（telegram-bot-api 的 --local 模式，docker-compose 的 bot-api 配置）后上限为 2000 MB：
  服务把文件下载到它自己的目录，Tessera 从挂载的同一目录边读边写入网盘，保存后删除；大文件按离线下载的同时下载数逐个处理，
  开始前检查目录所在磁盘的剩余空间；
- 其他文字（或 /ask）：转给文件助手，回复以文本发回；需要确认的操作附带「确认」「拒绝」按钮，在这个私聊里决定；
- 离线下载完成或失败时推送提醒（可在设置里关闭；私密空间的任务不显示文件名）。
助手对话用机器人为这个账号建立的内存会话（与网页会话一样 12 小时有效、过期重建）；助手里需要浏览器的工具不提供，
私密空间在 Telegram 里不能解锁。系统锁定时暂停收消息，token 也不留在内存里。
"""

from __future__ import annotations

import asyncio
import base64
import html
import os
import shutil
import json
import logging
import mimetypes
import re
import secrets
import time
from datetime import datetime
from urllib.parse import quote

from ..api import normalize_user_path
from ..crypto import derive_subkey, open_sealed, seal
from ..errors import NotFoundError, NotReadyError, QuotaExceededError
from ..objects import PRIVATE_PREFIX
from ..offline.http import DownloadError
from ..offline.request import filename
from ..work import Limiter
from .client import PooledTransport, TelegramAuthError, TelegramClient, TelegramError, TelegramRateLimitError

log = logging.getLogger(__name__)

TOKEN_KEY = "telegram.bot.token"
INFO_KEY = "telegram.bot.info"
OFFSET_KEY = "telegram.bot.offset"
TOKEN_AAD = "telegram-interaction-bot"
TOKEN_PATTERN = re.compile(r"\d{6,20}:[A-Za-z0-9_-]{20,}")
CODE_TTL = 600
FILE_LIMIT = 20 * 1024 * 1024
# 自建 Bot API 服务（--local）允许机器人下载的上限。
LOCAL_FILE_LIMIT = 2000 * 1024 * 1024
# 自建服务的默认工作目录（aiogram/telegram-bot-api 镜像的 TELEGRAM_WORK_DIR），Tessera 挂载到同一路径。
DEFAULT_FILES_DIR = "/var/lib/telegram-bot-api"
READ_PIECE = 1024 * 1024
MESSAGE_LIMIT = 4000
ASSISTANT_WAIT = 15 * 60
ACTION_WAIT = 10 * 60
URL_PATTERN = re.compile(r"https?://", re.IGNORECASE)

COMMANDS = [
    ("help", "使用说明"),
    ("status", "最近的离线下载"),
    ("folder", "查看或修改保存位置"),
    ("notify", "开关下载完成提醒：/notify on 或 off"),
    ("ask", "向文件助手提问（消息里有链接时用它）"),
    ("new", "开始新的助手对话"),
    ("unbind", "解除与 Tessera 账号的绑定"),
]

HELP = ("可以这样使用：\n"
        "• 发送链接、M3U8 地址或 curl 命令：创建离线下载，完成或失败时提醒你\n"
        "• 发送或转发照片、视频、音频、文档：保存到网盘（单个文件 {limit} 以内）\n"
        "• 直接发文字：向文件助手提问；需要确认的操作会附带按钮\n\n"
        "命令：\n" + "\n".join(f"/{name} — {text}" for name, text in COMMANDS))


def _display(path: str) -> str:
    return "/" + path.rstrip("/") if path else "我的文件（根目录）"


def _size(value: int | None) -> str:
    if not value:
        return ""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return ""


def markdown_html(text: str) -> str:
    """把助手回复里常见的 Markdown 转成 Telegram 支持的 HTML 子集：代码块、行内代码、粗体、链接与标题；其余原样（已转义）。"""
    parts = re.split(r"```[^\n]*\n?(.*?)```", text, flags=re.DOTALL)
    out = []
    for index, part in enumerate(parts):
        if index % 2:
            out.append(f"<pre>{html.escape(part.rstrip())}</pre>")
            continue
        chunks = re.split(r"`([^`\n]+)`", part)
        for position, chunk in enumerate(chunks):
            if position % 2:
                out.append(f"<code>{html.escape(chunk)}</code>")
                continue
            value = html.escape(chunk, quote=False)
            value = re.sub(r"^#{1,6}\s+(.+)$", r"<b>\1</b>", value, flags=re.MULTILINE)
            value = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", value)
            value = re.sub(r"\[([^\]\n]+)\]\((https?://[^)\s]+)\)",
                           lambda match: f'<a href="{html.escape(match[2])}">{match[1]}</a>', value)
            value = re.sub(r"^(\s*)[-*]\s+", r"\1• ", value, flags=re.MULTILINE)
            out.append(value)
    return "".join(out)


def _chunks(text: str, limit: int = MESSAGE_LIMIT) -> list[str]:
    """按段落切成 Telegram 单条消息的长度；切开的部分各自独立（代码块被切开时退回纯文本发送）。"""
    pieces, current = [], ""
    for line in text.splitlines(keepends=True):
        while len(line) > limit:
            pieces.append(current + line[:limit - len(current)])
            line, current = line[limit - len(current):], ""
        if len(current) + len(line) > limit:
            pieces.append(current)
            current = ""
        current += line
    if current.strip():
        pieces.append(current)
    return pieces or [text[:limit]]


def _variant_score(candidate: dict) -> tuple[int, float]:
    """同一组候选（M3U8 清晰度、平台的多种格式）里选画面最大、码率最高的一个。"""
    label = str(candidate.get("variant") or "")
    pixels = 0
    if match := re.search(r"(\d{2,5})\s*[x×]\s*(\d{2,5})", label):
        pixels = int(match[1]) * int(match[2])
    elif match := re.search(r"(\d{3,4})p", label):
        pixels = int(match[1]) * int(match[1]) * 16 // 9
    rate = float(match[1]) if (match := re.search(r"([\d.]+)\s*Mbps", label)) else 0.0
    return pixels, rate


class InteractionBot:
    def __init__(self, accounts, objects, offline, *, assistant=None, settings=None, client_factory=TelegramClient,
                 api_url: str = "", files_dir: str = "", resources=None) -> None:
        self.accounts, self.objects, self.offline, self.assistant, self.settings = accounts, objects, offline, assistant, settings
        # 启动参数（TGDRIVE_TELEGRAM_BOT_API_URL／_DIR）只是默认值，控制台保存的设置优先。
        self.default_api_url, self.default_files_dir = (api_url or "").strip().rstrip("/"), (files_dir or "").strip() or DEFAULT_FILES_DIR
        self.resources = resources
        # 大文件同时下载的数量与离线下载相同（「下载与资源」按机器内存自动选择）；占用的磁盘按文件大小预留。
        self._imports = Limiter(1)
        self._reserved = 0
        self.metadata, self.keystore = accounts.metadata, accounts.keystore
        self.client_factory = client_factory
        self._codes: dict[str, tuple[int, float]] = {}
        self._sessions: dict[int, str] = {}
        self._chat_locks: dict[int, asyncio.Lock] = {}
        self._albums: dict[str, dict] = {}
        self._background: set[asyncio.Task] = set()
        self._client: TelegramClient | None = None
        self._client_token: tuple[str, str] | None = None
        self._task: asyncio.Task | None = None
        self._wake: asyncio.Event | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self.last_error: str | None = None
        self.last_poll_at: float | None = None
        # 由 HTTP 层注入：私聊里完成的绑定与解绑写审计（只记动作，不记 Telegram 账号信息）。
        self.on_audit = None

    def _audit(self, action: str, user_id: int) -> None:
        if self.on_audit is not None:
            try:
                self.on_audit(action, user_id, {"via": "telegram"})
            except Exception as exc:
                log.debug("交互机器人审计暂未写入：%s", type(exc).__name__)

    # ---------- 配置（管理员） ----------

    def _setting(self, key: str):
        row = self.metadata.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

    def _save(self, db, key: str, value: str) -> None:
        db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def _info(self) -> dict:
        try:
            value = json.loads(self._setting(INFO_KEY) or "{}")
        except ValueError:
            value = {}
        return value if isinstance(value, dict) else {}

    def _key(self) -> bytes:
        return derive_subkey(self.keystore.require_kek(), "telegram-bot-token")

    def _token(self) -> str | None:
        stored = self._setting(TOKEN_KEY)
        if not stored or not self.keystore.unlocked:
            return None
        return open_sealed(self._key(), base64.b64decode(stored), TOKEN_AAD).decode()

    def api_url(self, info: dict | None = None) -> str:
        """当前使用的 Bot API 地址：空串为官方服务器。控制台保存过（含保存为空）时以控制台为准，否则用启动参数。"""
        info = self._info() if info is None else info
        return info["api_url"] if isinstance(info.get("api_url"), str) else self.default_api_url

    def files_dir(self, info: dict | None = None) -> str:
        info = self._info() if info is None else info
        return info["files_dir"] if isinstance(info.get("files_dir"), str) and info["files_dir"] else self.default_files_dir

    def _make_client(self, token: str, api_url: str) -> TelegramClient:
        if not api_url:
            return self.client_factory(token)
        # 自建服务在本地模式下 getFile 要等它把整个文件（最大 2000 MB）下载完才返回，连接超时放宽到 1 小时；
        # 用单独的连接池，不占用存储通道共用的连接。
        return self.client_factory(token, api_base=api_url, transport=PooledTransport(timeout=3600))

    def client(self) -> TelegramClient | None:
        """当前启用的交互机器人客户端；没有配置、已停用或系统锁定时为 None（锁定时不在内存里保留 token）。"""
        info = self._info()
        if not self.keystore.unlocked or not info.get("enabled"):
            self._client = self._client_token = None
            return None
        token = self._token()
        if token is None:
            return None
        signature = (token, self.api_url(info))
        if signature != self._client_token:
            self._client, self._client_token = self._make_client(*signature), signature
        return self._client

    def file_limit(self) -> int:
        return LOCAL_FILE_LIMIT if self.api_url() else FILE_LIMIT

    def _help(self) -> str:
        return HELP.replace("{limit}", "2000 MB" if self.api_url() else "20 MB")

    def admin_status(self) -> dict[str, object]:
        info = self._info()
        configured = self._setting(TOKEN_KEY) is not None
        linked = self.metadata.db.execute("SELECT COUNT(*) FROM telegram_links").fetchone()[0]
        api_url, files_dir = self.api_url(info), self.files_dir(info)
        try:
            usage = shutil.disk_usage(files_dir) if api_url else None
        except OSError:
            usage = None
        return {"configured": configured, "enabled": bool(configured and info.get("enabled")), "username": info.get("username"),
                "name": info.get("name"), "bot_id": info.get("id"), "linked_users": linked,
                "api_url": api_url, "api_url_source": "console" if isinstance(info.get("api_url"), str) else "startup" if self.default_api_url else "default",
                "default_api_url": self.default_api_url, "files_dir": files_dir, "file_limit": self.file_limit(),
                "files_dir_ready": bool(api_url) and os.access(files_dir, os.R_OK | os.X_OK),
                "files_dir_free": usage.free if usage else None, "import_concurrency": self._import_limit(),
                "running": bool(self._task and not self._task.done()) and configured and bool(info.get("enabled")),
                "last_error": self.last_error if configured else None, "last_poll_at": self.last_poll_at}

    _UNSET = object()

    @staticmethod
    def _clean_url(value: object) -> str:
        if value in (None, ""):
            return ""
        if not isinstance(value, str) or not re.fullmatch(r"https?://[A-Za-z0-9.\-_:\[\]]+(/[A-Za-z0-9._~\-/]*)?", value.strip()):
            raise ValueError("Bot API 地址应形如 http://telegram-bot-api:8081，留空使用官方服务器")
        return value.strip().rstrip("/")

    async def _switch_server(self, token: str, old: str, new: str) -> None:
        """机器人从一个 Bot API 服务换到另一个：先在原服务上 logOut（官方要求，否则新服务收不到消息）。
        从自建服务换回官方后，官方服务器约 10 分钟内拒绝登录。原服务已退出或连不上时忽略。"""
        if old == new:
            return
        try:
            await self._make_client(token, old).log_out()
        except (TelegramError, OSError) as exc:
            log.info("交互机器人在原 Bot API 服务上退出时出错（已忽略）：%s", type(exc).__name__)

    async def configure(self, token: object = None, enabled: object = None, *, api_url: object = _UNSET,
                        files_dir: object = _UNSET) -> dict[str, object]:
        """保存或更换 token（先用 getMe 校验并移除 Webhook）、切换 Bot API 服务（api_url，空串为官方）与文件目录，
        或单独启用／停用。token 只以密文保存，不出现在返回值里。"""
        info = self._info()
        old_url = self.api_url(info)
        new_url = old_url if api_url is self._UNSET else self._clean_url(api_url)
        if files_dir is not self._UNSET:
            if files_dir not in (None, "") and (not isinstance(files_dir, str) or not files_dir.startswith("/") or len(files_dir) > 512):
                raise ValueError("文件目录应为容器内的绝对路径，例如 /var/lib/telegram-bot-api")
            info["files_dir"] = (files_dir or "").strip()
        if api_url is not self._UNSET:
            info["api_url"] = new_url
        if token in (None, "") and new_url != old_url:
            current = self._token()
            if current is None:
                raise ValueError("请先填写交互机器人的 token")
            await self._switch_server(current, old_url, new_url)
            client = self._make_client(current, new_url)
            try:
                await client.get_me()
                await client.delete_webhook()
            except TelegramAuthError as exc:
                raise ValueError("新的 Bot API 服务拒绝了这个 token（从自建服务换回官方后约 10 分钟内无法登录，请稍后再试）") from exc
            except (TelegramError, OSError) as exc:
                raise ValueError(f"无法连接新的 Bot API 服务：{exc}") from exc
            with self.metadata.transaction() as db:
                self._save(db, INFO_KEY, json.dumps(info, ensure_ascii=False))
            self.last_error = None
            self._kick()
            return self.admin_status()
        if token in (None, "") and enabled is None:
            with self.metadata.transaction() as db:
                self._save(db, INFO_KEY, json.dumps(info, ensure_ascii=False))
            return self.admin_status()
        if token not in (None, ""):
            if not isinstance(token, str) or not TOKEN_PATTERN.fullmatch(token.strip()):
                raise ValueError("Bot token 格式不正确，应形如 123456789:AAH…")
            token = token.strip()
            for row in self.metadata.db.execute("SELECT id, token_enc FROM telegram_bots").fetchall():
                # token 冒号前是 Bot 的编号：存储通道的 Bot 不能同时作交互机器人（会把存储频道的 Bot 暴露给所有用户）。
                stored = open_sealed(self._key(), row["token_enc"], f"telegram-bot:{row['id']}").decode()
                if stored.split(":", 1)[0] == token.split(":", 1)[0]:
                    raise ValueError("这个 Bot 正在用作存储通道，请另建一个 Bot 作为交互机器人")
            if new_url:
                # 新 token 直接用自建服务：先在官方服务器上退出，否则自建服务收不到这个机器人的消息。
                await self._switch_server(token, "", new_url)
            client = self._make_client(token, new_url)
            try:
                me = await client.get_me()
                await client.delete_webhook()
                await client.set_my_commands(COMMANDS)
            except TelegramAuthError as exc:
                raise ValueError("token 无效：Telegram 拒绝了这个 Bot token") from exc
            except (TelegramError, OSError) as exc:
                raise ValueError(f"无法连接 Telegram：{exc}") from exc
            sealed = base64.b64encode(seal(self._key(), token.encode(), TOKEN_AAD)).decode()
            changed = info.get("id") != me.get("id")
            info = {**{key: info[key] for key in ("api_url", "files_dir") if key in info},
                    "id": me.get("id"), "username": me.get("username"), "name": me.get("first_name"),
                    "enabled": True if enabled is None else bool(enabled), "saved_at": time.time()}
            with self.metadata.transaction() as db:
                self._save(db, TOKEN_KEY, sealed)
                self._save(db, INFO_KEY, json.dumps(info, ensure_ascii=False))
                if changed:
                    # 换成另一个 Bot：消息编号重新开始。已绑定的私聊仍然有效（私聊编号就是用户的 Telegram 编号），
                    # 但用户要先在新机器人里点一次「开始」，机器人才能给他发消息。
                    db.execute("DELETE FROM settings WHERE key=?", (OFFSET_KEY,))
            self.last_error = None
        elif enabled is not None:
            if self._setting(TOKEN_KEY) is None:
                raise ValueError("请先填写交互机器人的 token")
            info["enabled"] = bool(enabled)
            with self.metadata.transaction() as db:
                self._save(db, INFO_KEY, json.dumps(info, ensure_ascii=False))
        self._kick()
        return self.admin_status()

    def remove(self) -> dict[str, object]:
        """删除交互机器人配置；已有的绑定保留，重新配置后继续可用。"""
        with self.metadata.transaction() as db:
            db.execute("DELETE FROM settings WHERE key IN (?,?,?)", (TOKEN_KEY, INFO_KEY, OFFSET_KEY))
        self._client = self._client_token = None
        self.last_error = None
        self._kick()
        return self.admin_status()

    # ---------- 绑定（用户） ----------

    def _link(self, *, user_id: int | None = None, chat_id: int | None = None):
        if user_id is not None:
            return self.metadata.db.execute("SELECT * FROM telegram_links WHERE user_id=?", (user_id,)).fetchone()
        return self.metadata.db.execute("SELECT * FROM telegram_links WHERE chat_id=?", (chat_id,)).fetchone()

    def user_status(self, user_id: int) -> dict[str, object]:
        info = self._info()
        available = bool(self._setting(TOKEN_KEY) and info.get("enabled") and info.get("username"))
        row = self._link(user_id=user_id)
        link = None if row is None else {"tg_username": row["tg_username"], "tg_name": row["tg_name"], "folder": row["folder"],
                                         "notify": bool(row["notify"]), "created_at": row["created_at"]}
        return {"available": available, "bot_username": info.get("username") if available else None, "link": link,
                "assistant": self.assistant is not None and self.assistant.config.enabled}

    def create_code(self, user_id: int) -> dict[str, object]:
        status = self.user_status(user_id)
        if not status["available"]:
            raise ValueError("管理员尚未启用 Telegram 机器人")
        now = time.time()
        for code, (_, expires) in list(self._codes.items()):
            if expires <= now or self._codes[code][0] == user_id:
                self._codes.pop(code, None)
        code = secrets.token_urlsafe(18)
        self._codes[code] = (user_id, now + CODE_TTL)
        return {"code": code, "url": f"https://t.me/{status['bot_username']}?start={code}", "expires_at": now + CODE_TTL}

    def update_link(self, user_id: int, payload: dict) -> dict[str, object]:
        if self._link(user_id=user_id) is None:
            raise ValueError("还没有绑定 Telegram")
        values: dict[str, object] = {}
        if "folder" in payload:
            values["folder"] = self._folder(payload["folder"])
        if "notify" in payload:
            values["notify"] = int(bool(payload["notify"]))
        if values:
            with self.metadata.transaction() as db:
                db.execute("UPDATE telegram_links SET " + ",".join(f"{key}=?" for key in values) + " WHERE user_id=?",
                           (*values.values(), user_id))
        return self.user_status(user_id)

    def unlink(self, user_id: int) -> None:
        with self.metadata.transaction() as db:
            db.execute("DELETE FROM telegram_links WHERE user_id=?", (user_id,))
        self._sessions.pop(user_id, None)

    @staticmethod
    def _folder(value: object) -> str:
        if value in (None, "", "/"):
            return ""
        if not isinstance(value, str) or len(value) > 1024:
            raise ValueError("保存位置不正确")
        try:
            return normalize_user_path(value.strip().strip("/"), directory=True)
        except PermissionError as exc:
            raise ValueError("保存位置只能是「我的文件」里的文件夹") from exc
        except ValueError as exc:
            raise ValueError("保存位置不正确：路径不能包含空的部分、. 或 ..") from exc

    # ---------- 长轮询 ----------

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._loop = asyncio.get_running_loop()
            self._wake = asyncio.Event()
            self._task = self._loop.create_task(self._poll())

    async def stop(self) -> None:
        tasks = [task for task in (self._task, *self._background) if task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._task = None

    def _kick(self) -> None:
        if self._wake is not None and self._loop is not None:
            self._loop.call_soon_threadsafe(self._wake.set)

    async def _sleep(self, seconds: float) -> None:
        assert self._wake is not None
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), seconds)
        except TimeoutError:
            pass

    async def _poll(self) -> None:
        delay = 2.0
        while True:
            try:
                client = self.client()
                if client is None:
                    await self._sleep(30)
                    continue
                offset = self._setting(OFFSET_KEY)
                updates = await client.get_updates(int(offset) if offset else None, timeout=25)
                self.last_poll_at, self.last_error, delay = time.time(), None, 2.0
                if updates:
                    with self.metadata.transaction() as db:
                        self._save(db, OFFSET_KEY, str(max(int(item["update_id"]) for item in updates) + 1))
                for update in updates:
                    self._spawn(self._dispatch(update))
            except asyncio.CancelledError:
                raise
            except TelegramAuthError:
                self.last_error = "token 已失效：请在控制台重新填写交互机器人的 token"
                await self._sleep(300)
            except TelegramRateLimitError as exc:
                await self._sleep(min(300, exc.retry_after + 1))
            except TelegramError as exc:
                self.last_error = ("另一个程序正在用这个机器人接收消息（Telegram 409），请停用它或更换 Bot"
                                   if exc.error_code == 409 else f"Telegram 返回错误：{exc}")
                await self._sleep(delay)
                delay = min(delay * 2, 120)
            except Exception as exc:
                # 网络错误的说明里不含 token；其他异常只记类型。
                self.last_error = f"暂时无法连接 Telegram（{type(exc).__name__}）"
                log.debug("交互机器人轮询失败：%s", type(exc).__name__)
                await self._sleep(delay)
                delay = min(delay * 2, 120)

    def _spawn(self, coroutine) -> None:
        task = asyncio.get_running_loop().create_task(coroutine)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _dispatch(self, update: dict) -> None:
        message = update.get("message")
        callback = update.get("callback_query")
        chat = (message or (callback or {}).get("message") or {}).get("chat") or {}
        if chat.get("type") != "private" or not isinstance(chat.get("id"), int):
            return  # 群组与频道里不响应
        lock = self._chat_locks.setdefault(chat["id"], asyncio.Lock())
        try:
            if callback is not None:
                await self._callback(chat["id"], callback)
            else:
                async with lock:
                    await self._message(chat["id"], message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("交互机器人处理消息失败：%s", type(exc).__name__)
            await self._reply(chat["id"], "处理这条消息时出错了，请稍后重试。")
        finally:
            # 每个私聊一把锁，保证同一私聊的消息按顺序处理；空闲的锁不必一直保留。
            if not lock.locked() and len(self._chat_locks) > 1000:
                self._chat_locks.pop(chat["id"], None)

    async def _reply(self, chat_id: int, text: str, *, html_text: str | None = None, buttons=None, reply_to: int | None = None) -> dict | None:
        client = self.client()
        if client is None:
            return None
        try:
            if html_text is not None:
                try:
                    return await client.send_message(chat_id, html_text, html=True, buttons=buttons, reply_to=reply_to)
                except TelegramError as exc:
                    if exc.error_code != 400:
                        raise
            return await client.send_message(chat_id, text, buttons=buttons, reply_to=reply_to)
        except (TelegramError, OSError) as exc:
            log.debug("交互机器人发送失败：%s", type(exc).__name__)
            return None

    # ---------- 消息 ----------

    def _account(self, user_id: int):
        return self.metadata.db.execute("SELECT id,username,role,status,bucket_id FROM users WHERE id=?", (user_id,)).fetchone()

    async def _message(self, chat_id: int, message: dict) -> None:
        text = (message.get("text") or message.get("caption") or "").strip()
        command, _, argument = text.partition(" ") if text.startswith("/") else ("", "", "")
        command = command.split("@", 1)[0].lower()
        link = self._link(chat_id=chat_id)
        if command == "/start" and argument.strip():
            await self._bind(chat_id, message, argument.strip())
            return
        if link is None:
            await self._reply(chat_id, "这个 Telegram 账号还没有绑定 Tessera。\n请在 Tessera 网页右上角头像 → 设置 → Telegram 中生成绑定链接，在手机上点开即可完成绑定。")
            return
        account = self._account(link["user_id"])
        if account is None or account["status"] != "active" or account["bucket_id"] is None:
            await self._reply(chat_id, "绑定的 Tessera 账号已停用或没有文件空间。")
            return
        if not self.keystore.unlocked:
            await self._reply(chat_id, "Tessera 服务正在等待管理员解锁，请稍后再试。")
            return
        message_id = message.get("message_id")
        if command in ("/start", "/help"):
            await self._reply(chat_id, f"已绑定 Tessera 账号 {account['username']}。\n\n{self._help()}\n\n当前保存位置：{_display(link['folder'])}")
        elif command == "/status":
            await self._status(chat_id, link)
        elif command == "/folder":
            await self._set_folder(chat_id, link, argument)
        elif command == "/notify":
            value = argument.strip().lower()
            if value not in ("on", "off", "开", "关"):
                await self._reply(chat_id, f"下载完成提醒：{'已开启' if link['notify'] else '已关闭'}。发送 /notify on 或 /notify off 修改。")
            else:
                self.update_link(link["user_id"], {"notify": value in ("on", "开")})
                await self._reply(chat_id, "已开启下载完成提醒。" if value in ("on", "开") else "已关闭下载完成提醒。")
        elif command == "/unbind":
            self.unlink(link["user_id"])
            self._audit("telegram.unlink", link["user_id"])
            await self._reply(chat_id, "已解除绑定。需要时可在 Tessera 网页重新绑定。")
        elif command == "/new":
            with self.metadata.transaction() as db:
                db.execute("UPDATE telegram_links SET conversation_id=NULL WHERE user_id=?", (link["user_id"],))
            await self._reply(chat_id, "好的，下一条消息会开始新的助手对话。")
        elif command == "/ask":
            if argument.strip():
                await self._ask(chat_id, link, argument.strip(), message_id)
            else:
                await self._reply(chat_id, "在 /ask 后面写上问题，例如：/ask 帮我找出上周下载的视频")
        elif command:
            await self._reply(chat_id, f"不认识这个命令。\n\n{self._help()}")
        elif self._media(message) is not None:
            await self._save_file(chat_id, link, message)
        elif URL_PATTERN.search(text) or text.lower().startswith("curl "):
            await self._download(chat_id, link, text, message_id)
        elif text:
            await self._ask(chat_id, link, text, message_id)

    async def _bind(self, chat_id: int, message: dict, code: str) -> None:
        entry = self._codes.pop(code, None)
        if entry is None or entry[1] <= time.time():
            await self._reply(chat_id, "绑定链接已失效或已使用，请在 Tessera 网页重新生成。")
            return
        user_id = entry[0]
        account = self._account(user_id)
        if account is None or account["status"] != "active":
            await self._reply(chat_id, "这个 Tessera 账号已停用，不能绑定。")
            return
        existing = self._link(chat_id=chat_id)
        if existing is not None and existing["user_id"] != user_id:
            await self._reply(chat_id, "这个 Telegram 账号已经绑定了另一个 Tessera 账号，请先在那边解除绑定（发送 /unbind）。")
            return
        sender = message.get("from") or {}
        name = " ".join(part for part in (sender.get("first_name"), sender.get("last_name")) if part)[:120] or None
        with self.metadata.transaction() as db:
            previous = db.execute("SELECT folder, notify FROM telegram_links WHERE user_id=?", (user_id,)).fetchone()
            db.execute("DELETE FROM telegram_links WHERE user_id=? OR chat_id=?", (user_id, chat_id))
            db.execute("INSERT INTO telegram_links(user_id,chat_id,tg_username,tg_name,folder,notify,created_at) VALUES(?,?,?,?,?,?,?)",
                       (user_id, chat_id, (sender.get("username") or None), name,
                        previous["folder"] if previous else "", previous["notify"] if previous else 1, time.time()))
        self._audit("telegram.link", user_id)
        await self._reply(chat_id, f"绑定成功，已连接 Tessera 账号 {account['username']}。\n\n{self._help()}")

    async def _status(self, chat_id: int, link) -> None:
        rows = self.metadata.db.execute(
            "SELECT * FROM offline_tasks WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 8", (link["user_id"],)).fetchall()
        if not rows:
            await self._reply(chat_id, "还没有离线下载。发送链接即可创建。")
            return
        labels = {"queued": "排队中", "running": "下载中", "completed": "已完成", "failed": "失败", "stopped": "已暂停",
                  "interrupted": "等待恢复"}
        lines = []
        for row in rows:
            name = "私密空间下载" if row["key"].startswith(PRIVATE_PREFIX) else row["key"].rsplit("/", 1)[-1]
            progress = f" {row['stored_bytes'] * 100 // row['size']}%" if row["status"] == "running" and row["size"] else ""
            lines.append(f"• {labels.get(row['status'], row['status'])}{progress} — {name}")
        await self._reply(chat_id, "最近的离线下载：\n" + "\n".join(lines))

    async def _set_folder(self, chat_id: int, link, argument: str) -> None:
        if not argument.strip():
            await self._reply(chat_id, f"当前保存位置：{_display(link['folder'])}\n发送 /folder 路径 修改，例如：/folder 下载/Telegram（/folder / 为根目录）。")
            return
        try:
            folder = self._folder(argument)
        except ValueError as exc:
            await self._reply(chat_id, str(exc))
            return
        self.update_link(link["user_id"], {"folder": folder})
        await self._reply(chat_id, f"保存位置已改为：{_display(folder)}")

    # ---------- 离线下载 ----------

    async def _download(self, chat_id: int, link, text: str, message_id: int | None) -> None:
        client = self.client()
        if client is not None:
            self._spawn(self._typing(client, chat_id, 1))
        try:
            parsed = await self.offline.parse(link["user_id"], text, multiple_platforms=True)
            groups: dict[str, list[dict]] = {}
            for candidate in parsed["candidates"]:
                groups.setdefault(candidate.get("group", ""), []).append(candidate)
            chosen = [max(items, key=_variant_score) for items in groups.values()]
            tasks = self.offline.create(link["user_id"], [{"ticket": item["ticket"], "name": item["name"]} for item in chosen], link["folder"])
        except (ValueError, DownloadError, PermissionError, NotReadyError, QuotaExceededError) as exc:
            await self._reply(chat_id, f"没有创建离线下载：{exc}", reply_to=message_id)
            return
        lines = [f"• {task['key'].rsplit('/', 1)[-1]}" + (f"（{_size(task['size'])}）" if task.get("size") else "") for task in tasks[:20]]
        more = f"\n…等共 {len(tasks)} 个" if len(tasks) > 20 else ""
        await self._reply(chat_id, f"已创建 {len(tasks)} 个离线下载，保存到 {_display(link['folder'])}：\n" + "\n".join(lines) + more
                          + ("\n完成或失败时会提醒你。" if link["notify"] else ""), reply_to=message_id)

    def offline_finished(self, row) -> None:
        """离线任务完成或失败（OfflineDownloads.on_finished）：给开启提醒的绑定私聊推送一条消息。"""
        if self._loop is None or self.client() is None:
            return
        link = self._link(user_id=row["user_id"])
        if link is None or not link["notify"]:
            return
        private = row["key"].startswith(PRIVATE_PREFIX)
        name = row["key"].rsplit("/", 1)[-1]
        folder = row["key"][:len(row["key"]) - len(name)]
        if row["status"] == "completed":
            text = ("✅ 私密空间的一个离线下载已完成" if private else
                    f"✅ 下载完成：{name}\n保存在 {_display(folder)}" + (f" · {_size(row['size'])}" if row["size"] else ""))
        else:
            text = ("❌ 私密空间的一个离线下载失败，请在网页查看" if private else
                    f"❌ 下载失败：{name}\n{row['error'] or '原因未知'}")
        buttons = None
        base = (self.settings.get("public_base_url") or "") if self.settings is not None else ""
        if base.startswith("https://") and not private:
            target = f"{base.rstrip('/')}/?path={quote(folder)}" if row["status"] == "completed" else f"{base.rstrip('/')}/?view=downloads"
            buttons = [[{"text": "打开文件夹" if row["status"] == "completed" else "查看离线下载", "url": target}]]
        self._loop.call_soon_threadsafe(lambda: self._spawn(self._reply(link["chat_id"], text, buttons=buttons)))

    # ---------- 保存文件 ----------

    @staticmethod
    def _media(message: dict) -> tuple[dict, str, str | None] | None:
        """消息里的文件：(文件信息, 文件名, 类型)。照片取最大的尺寸。"""
        stamp = datetime.fromtimestamp(message.get("date") or time.time()).strftime("%Y%m%d-%H%M%S")
        unique = lambda item: str(item.get("file_unique_id") or "")[-6:]
        if message.get("document"):
            item = message["document"]
            return item, item.get("file_name") or f"Telegram 文件 {stamp}", item.get("mime_type")
        if message.get("photo"):
            item = max(message["photo"], key=lambda size: (size.get("file_size") or 0, size.get("width", 0)))
            return item, f"Telegram 图片 {stamp} {unique(item)}.jpg", "image/jpeg"
        for field, label, extension in (("video", "视频", ".mp4"), ("animation", "动图", ".mp4"), ("audio", "音频", ".mp3"),
                                        ("voice", "语音", ".ogg"), ("video_note", "视频消息", ".mp4")):
            if message.get(field):
                item = message[field]
                name = item.get("file_name")
                if not name and field == "audio" and (item.get("title") or item.get("performer")):
                    name = " - ".join(part for part in (item.get("performer"), item.get("title")) if part) + extension
                mime = item.get("mime_type")
                if not name:
                    guessed = mimetypes.guess_extension(mime or "") if mime else None
                    name = f"Telegram {label} {stamp}{guessed or extension}"
                return item, name, mime
        return None

    def _import_limit(self) -> int:
        if self.resources is None:
            return 1
        try:
            return max(1, int(self.resources.effective()["concurrency"]))
        except Exception:
            return 1

    def _local_path(self, file_path: str) -> str:
        """自建服务（--local）返回服务器上的绝对路径：Tessera 必须把同一目录挂载在 files_dir，且只读取这个目录里的文件。"""
        root = os.path.realpath(self.files_dir())
        path = os.path.realpath(file_path)
        if os.path.commonpath([root, path]) != root:
            raise ValueError(f"文件不在 Tessera 挂载的 Bot API 目录（{self.files_dir()}）里，请检查 docker-compose 的挂载配置")
        return path

    async def _read_local(self, path: str):
        """逐块读取自建服务下载的文件（在线程里读，不阻塞事件循环）。"""
        handle = await asyncio.to_thread(open, path, "rb")
        try:
            while True:
                piece = await asyncio.to_thread(handle.read, READ_PIECE)
                if not piece:
                    return
                yield piece
        finally:
            await asyncio.to_thread(handle.close)

    async def _save_file(self, chat_id: int, link, message: dict) -> None:
        item, name, mime = self._media(message)
        size = item.get("file_size") or 0
        limit = self.file_limit()
        if size > limit:
            hint = ("Telegram 只允许机器人下载 2000 MB 以内的文件。" if limit > FILE_LIMIT
                    else "官方 Bot API 只允许机器人下载 20 MB 以内的文件（管理员配置自建 Bot API 服务后可到 2000 MB）。")
            await self._reply(chat_id, f"「{name}」有 {_size(size)}，{hint}更大的文件请在网页上传，或发送它的下载链接。",
                              reply_to=message.get("message_id"))
            return
        if self.client() is None:
            return
        if size > FILE_LIMIT:
            # 大文件在后台下载与保存，同一私聊的其他消息不必等它完成。
            self._spawn(self._save_large(chat_id, link, message, item, name, mime, size))
            return
        await self._import(chat_id, link, message, item, name, mime)

    async def _save_large(self, chat_id: int, link, message: dict, item: dict, name: str, mime: str | None, size: int) -> None:
        reply_to = message.get("message_id")
        self._imports.set_limit(self._import_limit())
        reserve = (self.resources.effective().get("reserve_mib", 512) if self.resources is not None else 512) * 1024 * 1024
        try:
            free = shutil.disk_usage(self.files_dir()).free
        except OSError:
            await self._reply(chat_id, "暂时无法保存大文件：Tessera 读不到 Bot API 服务的文件目录，请联系管理员检查挂载配置。", reply_to=reply_to)
            return
        if free - self._reserved - size < reserve:
            await self._reply(chat_id, f"「{name}」有 {_size(size)}，服务器磁盘剩余空间不够同时下载它，请稍后再发，或发送下载链接改用离线下载。",
                              reply_to=reply_to)
            return
        self._reserved += size
        try:
            if self._imports._active >= self._imports.limit:
                await self._reply(chat_id, f"「{name}」（{_size(size)}）已排队，前面的大文件保存后开始下载。", reply_to=reply_to)
            async with self._imports.slot():
                await self._reply(chat_id, f"正在下载「{name}」（{_size(size)}），大文件需要几分钟，完成后通知你。", reply_to=reply_to)
                await self._import(chat_id, link, message, item, name, mime)
        finally:
            self._reserved -= size

    async def _import(self, chat_id: int, link, message: dict, item: dict, name: str, mime: str | None) -> None:
        client = self.client()
        if client is None:
            return
        self._spawn(self._typing(client, chat_id, 1, action="upload_document"))
        local = None
        try:
            info = await client.get_file(item["file_id"])
            scope = self.offline.scope(link["user_id"])
            safe = filename(name) or "Telegram 文件"
            key = link["folder"] + safe
            def free():
                with self.metadata.transaction() as db:
                    if db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, key)).fetchone() is None:
                        return key
                    return self.objects._free_name(db, scope.bucket_id, key, set())
            if info.file_path.startswith("/"):
                # 自建服务的本地模式：文件已在共享目录里，边读边写入网盘，不整个读进内存。
                local = self._local_path(info.file_path)
                length = os.path.getsize(local)
                key = await self.metadata.run_in_thread(free)
                await self.objects.put_object(scope, key, self._read_local(local), length, mime)
            else:
                response = await client.download_file(info.file_path)
                if response.status != 200:
                    raise TelegramError(f"HTTP {response.status}")
                key = await self.metadata.run_in_thread(free)
                await self.objects.put_object(scope, key, response.body, len(response.body), mime)
        except TelegramError as exc:
            await self._reply(chat_id, f"读取「{name}」失败：{exc}", reply_to=message.get("message_id"))
            return
        except (ValueError, PermissionError, NotReadyError, QuotaExceededError, OSError) as exc:
            reason = "服务器读不到 Bot API 服务下载的文件，请联系管理员检查挂载与权限" if isinstance(exc, OSError) and not isinstance(exc, PermissionError) else exc
            await self._reply(chat_id, f"保存「{name}」失败：{reason}", reply_to=message.get("message_id"))
            return
        finally:
            if local is not None:
                # 保存后立即删除；没有删除权限时由 bot-api 容器的定时清理删除（docker-compose 示例）。
                try:
                    await asyncio.to_thread(os.remove, local)
                except OSError:
                    pass
        saved = key.rsplit("/", 1)[-1]
        group = message.get("media_group_id")
        if not group:
            await self._reply(chat_id, f"已保存到 {_display(link['folder'])}：{saved}", reply_to=message.get("message_id"))
            return
        # 一次发来的一组照片或视频：攒 2 秒合并回复一次。
        album = self._albums.setdefault(f"{chat_id}:{group}", {"names": [], "folder": link["folder"], "task": None})
        album["names"].append(saved)
        if album["task"] is None:
            async def flush():
                await asyncio.sleep(2)
                entry = self._albums.pop(f"{chat_id}:{group}", None)
                if entry:
                    await self._reply(chat_id, f"已保存 {len(entry['names'])} 个文件到 {_display(entry['folder'])}：\n"
                                      + "\n".join(f"• {item}" for item in entry["names"][:20]))
            album["task"] = True
            self._spawn(flush())

    async def _typing(self, client: TelegramClient, chat_id: int, times: int, *, action: str = "typing") -> None:
        # 「正在输入」提示约 5 秒后消失：需要更久时每 4.5 秒再发一次。
        for index in range(times):
            if index:
                await asyncio.sleep(4.5)
            try:
                await client.send_chat_action(chat_id, action)
            except (TelegramError, OSError):
                return

    # ---------- 文件助手 ----------

    def _session(self, user_id: int) -> tuple[str, str]:
        """机器人代表这个账号使用文件助手的内存会话；过期、注销（改密码、禁用）后重新建立。"""
        token = self._sessions.get(user_id)
        session = self.accounts.sessions.peek(token) if token else None
        if session is None or session.user_id != user_id:
            account = self._account(user_id)
            session = self.accounts.sessions.create(user_id, account["username"], account["role"])
            self._sessions[user_id] = session.token
        return session.token, session.csrf_token

    def _conversation(self, link, token: str, csrf: str) -> str:
        if link["conversation_id"]:
            try:
                row = self.assistant.trace.conversation(link["user_id"], link["conversation_id"])
                if not row["private"]:
                    return row["id"]
            except NotFoundError:
                pass
        created = self.assistant.create_conversation(token, csrf, {"location": ""})["conversation"]["id"]
        with self.metadata.transaction() as db:
            db.execute("UPDATE telegram_links SET conversation_id=? WHERE user_id=?", (created, link["user_id"]))
        return created

    async def _ask(self, chat_id: int, link, text: str, message_id: int | None) -> None:
        if self.assistant is None:
            await self._reply(chat_id, "这里没有开启文件助手。发送链接可创建离线下载，发送文件可保存到网盘。")
            return
        try:
            token, csrf = self._session(link["user_id"])
            conversation = self._conversation(link, token, csrf)
            started = await self.assistant.send(token, csrf, conversation, {"text": text}, channel="telegram")
        except (ValueError, PermissionError, NotReadyError, NotFoundError) as exc:
            message = str(exc)
            if "使用说明" in message:
                message = "第一次使用文件助手前，请先在 Tessera 网页打开文件助手，阅读并确认使用说明。"
            await self._reply(chat_id, message, reply_to=message_id)
            return
        await self._relay(chat_id, link["user_id"], conversation, started["run_id"], reply_to=message_id)

    async def _relay(self, chat_id: int, user_id: int, conversation: str, run_id: str, *, reply_to: int | None = None) -> None:
        """等这一轮结束，把最后一条回复发回 Telegram；本轮新提出、等待确认的操作逐个附上按钮。"""
        state = self.assistant.runs.get(run_id)
        client = self.client()
        if state is not None and state.task is not None:
            typing = None
            if client is not None:
                typing = asyncio.get_running_loop().create_task(self._typing(client, chat_id, ASSISTANT_WAIT // 5))
            try:
                await asyncio.wait_for(asyncio.shield(state.task), ASSISTANT_WAIT)
            except TimeoutError:
                await self._reply(chat_id, "文件助手还在处理，完成后可以在网页的对话列表里查看结果。")
                return
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            finally:
                if typing is not None:
                    typing.cancel()
        messages = [item for item in self.assistant.trace.messages(conversation, limit=200, latest=True) if item.get("run_id") == run_id]
        replies = [item.get("text") for item in messages if item["role"] == "assistant" and (item.get("text") or "").strip()]
        if replies:
            for index, piece in enumerate(_chunks(replies[-1].strip())):
                await self._reply(chat_id, piece, html_text=markdown_html(piece), reply_to=reply_to if index == 0 else None)
        else:
            notes = [item.get("text") for item in messages if item["role"] == "event" and item.get("text")]
            await self._reply(chat_id, notes[-1] if notes else "文件助手没有给出回复，请换个说法再试。", reply_to=reply_to)
        for row in self.metadata.db.execute("SELECT id FROM assistant_actions WHERE run_id=? AND status='pending' ORDER BY created_at",
                                            (run_id,)).fetchall():
            await self._offer_action(chat_id, user_id, row["id"])

    def _action_text(self, action: dict) -> str:
        from ..assistant.actions import KINDS
        payload = action.get("payload") or {}
        samples = payload.get("samples") or []
        def describe(item) -> str:
            if not isinstance(item, dict):
                return str(item)
            if item.get("from") and item.get("to"):
                return f"/{item['from']} → /{item['to']}"
            for key in ("path", "name", "url", "title"):
                if item.get(key):
                    return ("/" + item[key]) if key == "path" else str(item[key])
            return "…"
        lines = [f"• {describe(item)}" for item in samples[:8]]
        more = f"\n…共 {action['count']} 项" if action["count"] > len(lines) else ""
        summary = payload.get("summary") if isinstance(payload.get("summary"), str) else ""
        return (f"需要你确认：{KINDS.get(action['kind'], action['kind'])} {action['count']} 项"
                + (f"\n{summary}" if summary else "") + ("\n" + "\n".join(lines) if lines else "") + more)

    async def _offer_action(self, chat_id: int, user_id: int, action_id: str) -> None:
        from ..assistant.actions import DANGER_KINDS
        try:
            action = self.assistant.trace.action_json(self.assistant.trace.action(user_id, action_id))
        except NotFoundError:
            return
        if action["status"] != "pending":
            return
        approve = "确认（不可恢复）" if action["kind"] in DANGER_KINDS else "确认"
        await self._reply(chat_id, self._action_text(action),
                          buttons=[[{"text": f"✅ {approve}", "callback_data": f"a:{action_id}:y"},
                                    {"text": "✖ 拒绝", "callback_data": f"a:{action_id}:n"}]])

    async def _callback(self, chat_id: int, callback: dict) -> None:
        client = self.client()
        if client is None:
            return
        data = str(callback.get("data") or "")
        match = re.fullmatch(r"a:([A-Za-z0-9_-]{1,40}):([yn])", data)
        link = self._link(chat_id=chat_id)
        if match is None or link is None or self.assistant is None:
            await client.answer_callback_query(callback["id"], "这个按钮已失效")
            return
        action_id, approve = match[1], match[2] == "y"
        message = callback.get("message") or {}
        try:
            token, csrf = self._session(link["user_id"])
            row = self.assistant.trace.action(link["user_id"], action_id)
            action = self.assistant.trace.action_json(row)
            await self.assistant.decide_action(token, csrf, action_id, approve, {"acknowledge": True, "count": action["count"]})
        except (ValueError, PermissionError, NotFoundError, NotReadyError) as exc:
            reason = "这个操作需要在发起它的会话里确认，已经过期，请重新发送请求" if isinstance(exc, PermissionError) else str(exc)
            await client.answer_callback_query(callback["id"], reason[:180])
            return
        await client.answer_callback_query(callback["id"], "已确认，正在执行" if approve else "已拒绝")
        if message.get("message_id"):
            try:
                await client.edit_message_text(chat_id, message["message_id"],
                                               self._action_text(action) + ("\n\n✅ 已确认，正在执行…" if approve else "\n\n✖ 已拒绝"))
            except TelegramError:
                pass
        if approve:
            await self._follow_action(chat_id, link["user_id"], row["conversation_id"], action_id)

    async def _follow_action(self, chat_id: int, user_id: int, conversation: str, action_id: str) -> None:
        """等操作执行完：助手接着处理（确认后继续的运行）时转发它的回复，否则发执行结果。"""
        deadline = time.monotonic() + ACTION_WAIT
        action = None
        while time.monotonic() < deadline:
            action = self.assistant.trace.action_json(self.assistant.trace.action(user_id, action_id))
            if action["status"] not in ("running", "undoing", "pending"):
                break
            await asyncio.sleep(1)
        await asyncio.sleep(0.5)
        run_id = self.assistant._active_run(conversation)
        if run_id is not None:
            await self._relay(chat_id, user_id, conversation, run_id)
            return
        result = (action or {}).get("result") or {}
        if action and action["status"] in ("running", "undoing"):
            await self._reply(chat_id, "操作还在执行，完成后可以在网页查看结果。")
        elif result:
            await self._reply(chat_id, f"执行完成：成功 {result.get('ok', 0)} 项"
                              + (f"，跳过 {result['skipped']} 项" if result.get("skipped") else "")
                              + (f"，失败 {result['failed']} 项" if result.get("failed") else "") + "。")
