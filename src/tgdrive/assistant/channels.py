"""模型渠道与模型：增删改、API Key 加密保存、同步上游模型列表、连通性测试。"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from urllib.parse import urlsplit

from ..crypto import derive_subkey, open_sealed, seal
from ..errors import NotFoundError
from ..keystore import KeyStore
from ..metadata import Metadata
from . import providers
from .providers import Endpoint, ProviderError, ToolDef

KINDS = ("openai", "anthropic")
PROTOCOLS = ("chat_completions", "responses")
_FORBIDDEN_HEADERS = {"host", "content-length", "content-type", "connection", "transfer-encoding", "accept",
                      "authorization", "x-api-key", "anthropic-version", "keep-alive", "upgrade", "te", "trailer"}
MASK = "••••••••"


def _mask(secret: str | None) -> str | None:
    if not secret:
        return None
    return MASK + secret[-4:] if len(secret) >= 12 else MASK


def normalize_base_url(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 500:
        raise ValueError("请填写接口地址（Base URL）")
    value = value.strip().rstrip("/")
    try:
        parts = urlsplit(value)
        parts.port
    except ValueError as exc:
        raise ValueError("接口地址格式不正确") from exc
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("接口地址必须以 http:// 或 https:// 开头")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("接口地址不能包含账号、查询参数或锚点")
    return value


class ChannelStore:
    def __init__(self, metadata: Metadata, keystore: KeyStore, *, log_call: Callable[..., None] | None = None, catalog=None) -> None:
        self.metadata, self.keystore = metadata, keystore
        self.log_call = log_call or (lambda **_: None)
        self.catalog = catalog

    def _key(self) -> bytes:
        return derive_subkey(self.keystore.require_kek(), "ai-channel-key")

    def _seal(self, channel_id: int, column: str, value: bytes) -> bytes:
        return seal(self._key(), value, f"ai-channel:{channel_id}:{column}")

    def _open(self, channel_id: int, column: str, value: bytes | None) -> bytes | None:
        return None if value is None else open_sealed(self._key(), value, f"ai-channel:{channel_id}:{column}")

    # ---------- 校验 ----------

    @staticmethod
    def _headers(value: object) -> dict[str, str]:
        if value is None:
            return {}
        if not isinstance(value, dict) or len(value) > 10:
            raise ValueError("附加请求头最多 10 项")
        result = {}
        for name, item in value.items():
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}", name):
                raise ValueError("请求头名称不合法")
            if name.lower() in _FORBIDDEN_HEADERS:
                raise ValueError(f"请求头 {name} 由系统设置，不能自定义")
            if not isinstance(item, str) or len(item) > 1024 or any(ord(c) < 32 or ord(c) == 127 for c in item):
                raise ValueError(f"请求头 {name} 的值不合法")
            result[name] = item
        return result

    @staticmethod
    def _fields(payload: dict, *, creating: bool) -> dict[str, object]:
        allowed = {"name", "kind", "base_url", "api_key", "headers", "enabled", "concurrency", "timeout", "protocol"}
        unknown = set(payload) - allowed
        if unknown:
            raise ValueError(f"未知字段：{', '.join(sorted(unknown))}")
        values: dict[str, object] = {}
        if "protocol" in payload:
            if payload["protocol"] not in PROTOCOLS:
                raise ValueError("OpenAI 接口方式只能是 Chat Completions 或 Responses")
            values["protocol"] = payload["protocol"]
        if creating or "name" in payload:
            name = payload.get("name")
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 40:
                raise ValueError("渠道名称需要 1–40 个字符")
            values["name"] = name.strip()
        if creating or "kind" in payload:
            if payload.get("kind") not in KINDS:
                raise ValueError("渠道类型只能是 OpenAI 兼容或 Anthropic")
            values["kind"] = payload["kind"]
        if creating or "base_url" in payload:
            values["base_url"] = normalize_base_url(payload.get("base_url"))
        if "enabled" in payload:
            if not isinstance(payload["enabled"], bool):
                raise ValueError("enabled 必须是布尔值")
            values["enabled"] = int(payload["enabled"])
        for name, low, high, label in (("concurrency", 1, 32, "并发"), ("timeout", 10, 600, "超时")):
            if name in payload:
                value = payload[name]
                if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                    raise ValueError(f"{label}必须在 {low}–{high} 之间")
                values[name] = value
        return values

    # ---------- 渠道 ----------

    def _protocol(self, channel_id: int) -> str:
        row = self.metadata.db.execute("SELECT value FROM settings WHERE key=?", (f"assistant.channel.{channel_id}.protocol",)).fetchone()
        try:
            value = json.loads(row["value"]) if row else None
        except ValueError:
            value = None
        return value if value in PROTOCOLS else "chat_completions"

    @staticmethod
    def _save_protocol(db, channel_id: int, protocol: str) -> None:
        key = f"assistant.channel.{channel_id}.protocol"
        if protocol == "chat_completions":
            db.execute("DELETE FROM settings WHERE key=?", (key,))
        else:
            db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (key, json.dumps(protocol)))

    def _channel_json(self, row) -> dict[str, object]:
        secret = self._open(row["id"], "secret", row["secret"])
        headers = self._open(row["id"], "headers", row["headers"])
        names = sorted(json.loads(headers)) if headers else []
        counts = self.metadata.db.execute(
            "SELECT COUNT(*) AS total, COALESCE(SUM(enabled),0) AS enabled FROM ai_models WHERE channel_id=?", (row["id"],)).fetchone()
        return {"id": row["id"], "name": row["name"], "kind": row["kind"], "base_url": row["base_url"], "protocol": self._protocol(row["id"]),
                "api_key": _mask(secret.decode() if secret else None), "header_names": names,
                "enabled": bool(row["enabled"]), "concurrency": row["concurrency"], "timeout": row["timeout"],
                "synced_at": row["synced_at"], "sync_note": row["sync_note"], "last_error": row["last_error"],
                "models": int(counts["total"]), "enabled_models": int(counts["enabled"]),
                "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def list(self) -> list[dict[str, object]]:
        return [self._channel_json(row) for row in self.metadata.db.execute("SELECT * FROM ai_channels ORDER BY id")]

    def get(self, channel_id: int) -> dict[str, object]:
        return self._channel_json(self._row(channel_id))

    def _row(self, channel_id: int):
        row = self.metadata.db.execute("SELECT * FROM ai_channels WHERE id=?", (channel_id,)).fetchone()
        if row is None:
            raise NotFoundError("渠道不存在")
        return row

    def create(self, payload: dict) -> dict[str, object]:
        values = self._fields(payload, creating=True)
        protocol = values.pop("protocol", "chat_completions")
        if values["kind"] != "openai" and protocol != "chat_completions":
            raise ValueError("Responses 仅适用于 OpenAI 渠道")
        api_key = payload.get("api_key")
        if api_key is not None and (not isinstance(api_key, str) or len(api_key) > 4096 or any(ord(c) < 33 for c in api_key)):
            raise ValueError("API Key 格式不正确")
        headers = self._headers(payload.get("headers"))
        now = time.time()
        with self.metadata.transaction() as db:
            cursor = db.execute(
                "INSERT INTO ai_channels(name,kind,base_url,enabled,concurrency,timeout,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (values["name"], values["kind"], values["base_url"], values.get("enabled", 1), values.get("concurrency", 4),
                 values.get("timeout", 120), now, now))
            channel_id = int(cursor.lastrowid)
            self._save_protocol(db, channel_id, protocol)
            db.execute("UPDATE ai_channels SET secret=?, headers=? WHERE id=?",
                       (self._seal(channel_id, "secret", api_key.encode()) if api_key else None,
                        self._seal(channel_id, "headers", json.dumps(headers).encode()) if headers else None, channel_id))
        return self.get(channel_id)

    def update(self, channel_id: int, payload: dict) -> dict[str, object]:
        row = self._row(channel_id)
        values = self._fields(payload, creating=False)
        if "kind" in values and values["kind"] != row["kind"]:
            raise ValueError("渠道类型创建后不能修改，请新建渠道")
        protocol = values.pop("protocol", None)
        if row["kind"] != "openai" and protocol not in (None, "chat_completions"):
            raise ValueError("Responses 仅适用于 OpenAI 渠道")
        sets, args = [f"{name}=?" for name in values], list(values.values())
        if "api_key" in payload:
            # 留空表示不修改；只有显式传入 null 或新值才变更。
            api_key = payload["api_key"]
            if api_key == "" or api_key == _mask(None) or (isinstance(api_key, str) and api_key.startswith(MASK)):
                pass
            elif api_key is None:
                sets.append("secret=?")
                args.append(None)
            elif not isinstance(api_key, str) or len(api_key) > 4096 or any(ord(c) < 33 for c in api_key):
                raise ValueError("API Key 格式不正确")
            else:
                sets.append("secret=?")
                args.append(self._seal(channel_id, "secret", api_key.encode()))
        if "headers" in payload:
            headers = self._headers(payload["headers"])
            sets.append("headers=?")
            args.append(self._seal(channel_id, "headers", json.dumps(headers).encode()) if headers else None)
        sets.append("updated_at=?")
        args.append(time.time())
        with self.metadata.transaction() as db:
            db.execute(f"UPDATE ai_channels SET {','.join(sets)} WHERE id=?", (*args, channel_id))
            if protocol is not None:
                self._save_protocol(db, channel_id, protocol)
        return self.get(channel_id)

    def delete(self, channel_id: int) -> None:
        self._row(channel_id)
        with self.metadata.transaction() as db:
            db.execute("DELETE FROM ai_channels WHERE id=?", (channel_id,))
            db.execute("DELETE FROM settings WHERE key=?", (f"assistant.channel.{channel_id}.protocol",))

    def endpoint(self, channel_id: int) -> Endpoint:
        row = self._row(channel_id)
        secret = self._open(channel_id, "secret", row["secret"])
        headers = self._open(channel_id, "headers", row["headers"])
        return Endpoint(row["kind"], row["base_url"], secret.decode() if secret else None,
                        json.loads(headers) if headers else {}, int(row["timeout"]), self._protocol(channel_id))

    def concurrency(self, channel_id: int) -> int:
        row = self.metadata.db.execute("SELECT concurrency FROM ai_channels WHERE id=?", (channel_id,)).fetchone()
        return int(row["concurrency"]) if row else 1

    # ---------- 模型 ----------

    @staticmethod
    def _model_json(row) -> dict[str, object]:
        try:
            capabilities = json.loads(row["capabilities"] or "{}")
            manual = json.loads(row["manual_fields"] or "[]")
        except ValueError:
            capabilities, manual = {}, []
        return {"id": row["id"], "channel_id": row["channel_id"], "model": row["model"],
                "display_name": row["display_name"], "label": row["display_name"] or row["model"],
                "source": row["source"], "enabled": bool(row["enabled"]), "tools": row["tools"],
                "context_window": row["context_window"], "max_output": row["max_output"],
                "input_price": row["input_price"], "output_price": row["output_price"],
                "capabilities": {name: capabilities.get(name) for name in ("tools", "reasoning", "vision", "structured")},
                "catalog_id": row["catalog_id"], "manual_fields": manual,
                "removed_upstream": bool(row["removed_upstream"]), "sort": row["sort"],
                "private_ok": bool(row["private_ok"]),
                "tested_at": row["tested_at"], "test_note": row["test_note"]}

    def models(self, channel_id: int | None = None) -> list[dict[str, object]]:
        if channel_id is None:
            rows = self.metadata.db.execute("SELECT * FROM ai_models ORDER BY channel_id, sort, id")
        else:
            self._row(channel_id)
            rows = self.metadata.db.execute("SELECT * FROM ai_models WHERE channel_id=? ORDER BY sort, id", (channel_id,))
        return [self._model_json(row) for row in rows]

    def model(self, model_id: int) -> dict[str, object]:
        row = self.metadata.db.execute("SELECT * FROM ai_models WHERE id=?", (model_id,)).fetchone()
        if row is None:
            raise NotFoundError("模型不存在")
        return self._model_json(row)

    def usable(self, *, private: bool = False) -> list[dict[str, object]]:
        """用户可选的模型：渠道启用、模型启用、未确认不支持工具调用；private 时只列允许私密对话的模型。"""
        rows = self.metadata.db.execute(
            "SELECT m.*, c.name AS channel_name FROM ai_models m JOIN ai_channels c ON c.id=m.channel_id "
            "WHERE c.enabled=1 AND m.enabled=1 AND m.tools!='no'" + (" AND m.private_ok=1" if private else "")
            + " ORDER BY c.id, m.sort, m.id").fetchall()
        return [{**self._model_json(row), "channel_name": row["channel_name"]} for row in rows]

    def is_usable(self, model_id: int, *, private: bool = False) -> bool:
        """private：私密对话只能使用管理员标记为允许私密对话的模型（docs/assistant-design.md §24.4）。"""
        return self.metadata.db.execute(
            "SELECT 1 FROM ai_models m JOIN ai_channels c ON c.id=m.channel_id "
            "WHERE m.id=? AND c.enabled=1 AND m.enabled=1 AND m.tools!='no'" + (" AND m.private_ok=1" if private else ""),
            (model_id,)).fetchone() is not None

    def add_model(self, channel_id: int, payload: dict) -> dict[str, object]:
        self._row(channel_id)
        model = payload.get("model")
        if not isinstance(model, str) or not 1 <= len(model.strip()) <= 200 or any(ord(c) < 32 for c in model):
            raise ValueError("模型 ID 需要 1–200 个字符")
        values = self._model_fields({k: v for k, v in payload.items() if k != "model"})
        now = time.time()
        with self.metadata.transaction() as db:
            if db.execute("SELECT 1 FROM ai_models WHERE channel_id=? AND model=?", (channel_id, model.strip())).fetchone():
                raise ValueError("该渠道已有同名模型")
            vision = values.pop("vision", None)
            manual = [name for name in ("context_window", "max_output", "tools", "input_price", "output_price") if values.get(name) is not None
                      and not (name == "tools" and values[name] == "unknown")]
            cursor = db.execute(
                "INSERT INTO ai_models(channel_id,model,display_name,source,enabled,tools,context_window,max_output,input_price,output_price,"
                "manual_fields,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (channel_id, model.strip(), values.get("display_name"), "manual", values.get("enabled", 0),
                 values.get("tools", "unknown"), values.get("context_window"), values.get("max_output"),
                 values.get("input_price"), values.get("output_price"), json.dumps(manual), now))
            model_id = int(cursor.lastrowid)
            if self.catalog is not None:
                row = db.execute("SELECT * FROM ai_models WHERE id=?", (model_id,)).fetchone()
                self.catalog.apply(db, row, self.catalog.match(model.strip()))
        if vision in ("yes", "no"):
            return self.update_model(model_id, {"vision": vision})
        return self.model(model_id)

    @staticmethod
    def _model_fields(payload: dict) -> dict[str, object]:
        allowed = {"display_name", "enabled", "tools", "context_window", "max_output", "sort", "input_price", "output_price", "vision",
                   "private_ok"}
        unknown = set(payload) - allowed
        if unknown:
            raise ValueError(f"未知字段：{', '.join(sorted(unknown))}")
        values: dict[str, object] = {}
        if "display_name" in payload:
            name = payload["display_name"]
            if name is not None and (not isinstance(name, str) or len(name) > 80):
                raise ValueError("显示名最多 80 个字符")
            values["display_name"] = name.strip() if isinstance(name, str) and name.strip() else None
        if "enabled" in payload:
            if not isinstance(payload["enabled"], bool):
                raise ValueError("enabled 必须是布尔值")
            values["enabled"] = int(payload["enabled"])
        if "private_ok" in payload:
            if not isinstance(payload["private_ok"], bool):
                raise ValueError("private_ok 必须是布尔值")
            values["private_ok"] = int(payload["private_ok"])
        if "tools" in payload:
            if payload["tools"] not in ("unknown", "yes", "no"):
                raise ValueError("工具调用支持只能是 unknown、yes 或 no")
            values["tools"] = payload["tools"]
        if "vision" in payload:
            # 图片输入：auto 跟随模型目录，yes／no 为管理员手动设置（目录同步不覆盖）。
            if payload["vision"] not in ("auto", "yes", "no"):
                raise ValueError("图片输入支持只能是 auto、yes 或 no")
            values["vision"] = payload["vision"]
        for name, high in (("context_window", 100_000_000), ("max_output", 10_000_000), ("sort", 100000)):
            if name in payload:
                value = payload[name]
                if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= high):
                    raise ValueError(f"{name} 必须是 0–{high} 的整数")
                values[name] = value
        for name in ("input_price", "output_price"):
            if name in payload:
                value = payload[name]
                if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 100000):
                    raise ValueError("价格必须是 0–100000 之间的数字（美元／百万 token）")
                values[name] = None if value is None else float(value)
        return values

    def update_model(self, model_id: int, payload: dict) -> dict[str, object]:
        current = self.model(model_id)
        reset = payload.get("reset_catalog")
        if reset is not None and not isinstance(reset, bool):
            raise ValueError("reset_catalog 必须是布尔值")
        values = self._model_fields({k: v for k, v in payload.items() if k != "reset_catalog"})
        # 与当前值不同的目录字段视为管理员手动设置，之后目录同步不再覆盖。
        manual = set(current["manual_fields"])
        for name in ("context_window", "max_output", "tools", "input_price", "output_price"):
            if name in values and values[name] != current[name]:
                manual.add(name)
        vision = values.pop("vision", None)
        if vision in ("yes", "no"):
            manual.add("vision")
            values["capabilities"] = json.dumps({**current["capabilities"], "vision": vision == "yes"})
        elif vision == "auto":
            # 先清空手动值，再按目录重新匹配；目录没有这个模型时就是「未知」，按不支持处理。
            manual.discard("vision")
            values["capabilities"] = json.dumps({**current["capabilities"], "vision": None})
        if reset:
            manual.clear()
        values["manual_fields"] = json.dumps(sorted(manual))
        with self.metadata.transaction() as db:
            db.execute(f"UPDATE ai_models SET {','.join(f'{name}=?' for name in values)} WHERE id=?", (*values.values(), model_id))
            if (reset or vision == "auto") and self.catalog is not None:
                row = db.execute("SELECT * FROM ai_models WHERE id=?", (model_id,)).fetchone()
                self.catalog.apply(db, row, self.catalog.match(row["model"]))
        return self.model(model_id)

    @staticmethod
    def vision(model: dict) -> bool:
        """只有目录或管理员明确声明支持图片输入才发送图片；未知按不支持处理。"""
        return (model.get("capabilities") or {}).get("vision") is True

    def delete_model(self, model_id: int) -> None:
        self.model(model_id)
        with self.metadata.transaction() as db:
            db.execute("DELETE FROM ai_models WHERE id=?", (model_id,))

    async def _upstream(self, channel_id: int, actor: str | None) -> list[dict]:
        endpoint = self.endpoint(channel_id)
        started = time.time()
        try:
            upstream = await providers.list_models(endpoint)
        except ProviderError as exc:
            self.log_call(kind="sync", channel_id=channel_id, actor=actor, started_at=started, status="error",
                          http_status=exc.status, error_code=exc.code, error=str(exc))
            with self.metadata.transaction() as db:
                db.execute("UPDATE ai_channels SET last_error=?, updated_at=? WHERE id=?", (str(exc), time.time(), channel_id))
            raise ValueError(f"读取模型列表失败：{exc}") from exc
        self.log_call(kind="sync", channel_id=channel_id, actor=actor, started_at=started, status="ok",
                      duration_ms=int((time.time() - started) * 1000), items=len(upstream))
        return upstream

    def _mark_upstream(self, channel_id: int, names: set[str], now: float) -> tuple[int, int]:
        removed = restored = 0
        with self.metadata.transaction() as db:
            for row in db.execute("SELECT id, model, source, removed_upstream FROM ai_models WHERE channel_id=?", (channel_id,)).fetchall():
                if row["model"] in names and row["removed_upstream"]:
                    db.execute("UPDATE ai_models SET removed_upstream=0 WHERE id=?", (row["id"],))
                    restored += 1
                elif row["model"] not in names and row["source"] == "auto" and not row["removed_upstream"]:
                    db.execute("UPDATE ai_models SET removed_upstream=1 WHERE id=?", (row["id"],))
                    removed += 1
        return removed, restored

    async def discover(self, channel_id: int, *, actor: str | None = None) -> dict[str, object]:
        """读取上游模型列表并附上目录匹配，不写入模型表（由管理员勾选后 add_models 加入）。"""
        upstream = await self._upstream(channel_id, actor)
        now = time.time()
        names = {item["model"] for item in upstream}
        removed, restored = self._mark_upstream(channel_id, names, now)
        added = {row["model"]: row["id"] for row in self.metadata.db.execute("SELECT id, model FROM ai_models WHERE channel_id=?", (channel_id,))}
        items = []
        for item in upstream:
            entry = self.catalog.match(item["model"]) if self.catalog is not None else None
            items.append({"model": item["model"], "display_name": item["display_name"] or (entry["name"] if entry else None),
                          "context_window": (entry or {}).get("context_window") or item["context_window"],
                          "max_output": (entry or {}).get("max_output"),
                          "input_price": (entry or {}).get("input_price"), "output_price": (entry or {}).get("output_price"),
                          "capabilities": (entry or {}).get("capabilities") or {}, "catalog_id": entry["id"] if entry else None,
                          "added": item["model"] in added, "model_id": added.get(item["model"])})
        note = f"上游 {len(upstream)} 个模型，已加入 {sum(1 for item in items if item['added'])} 个" + (f"，{removed} 个已从上游移除" if removed else "")
        with self.metadata.transaction() as db:
            db.execute("UPDATE ai_channels SET synced_at=?, sync_note=?, last_error=NULL, updated_at=? WHERE id=?", (now, note, now, channel_id))
        return {"models": items, "total": len(items), "removed": removed, "restored": restored, "note": note}

    async def add_models(self, channel_id: int, names: object, *, actor: str | None = None) -> dict[str, object]:
        """把管理员选中的上游模型加入渠道：按目录带入上下文、价格与能力；目录确认支持工具调用的直接启用。"""
        self._row(channel_id)
        if not isinstance(names, list) or not 1 <= len(names) <= 500 or not all(isinstance(n, str) and 0 < len(n) <= 200 for n in names):
            raise ValueError("请选择 1–500 个模型")
        upstream = {item["model"]: item for item in await self._upstream(channel_id, actor)}
        missing = [name for name in names if name not in upstream]
        if missing:
            raise ValueError(f"上游没有这些模型：{', '.join(missing[:5])}")
        now = time.time()
        added = enabled = 0
        with self.metadata.transaction() as db:
            existing = {row["model"] for row in db.execute("SELECT model FROM ai_models WHERE channel_id=?", (channel_id,))}
            sort = db.execute("SELECT COALESCE(MAX(sort),-1)+1 FROM ai_models WHERE channel_id=?", (channel_id,)).fetchone()[0]
            for name in dict.fromkeys(names):
                if name in existing:
                    continue
                item = upstream[name]
                entry = self.catalog.match(name) if self.catalog is not None else None
                on = bool(entry and entry["capabilities"].get("tools") is True)
                cursor = db.execute("INSERT INTO ai_models(channel_id,model,display_name,source,enabled,context_window,sort,created_at) "
                                    "VALUES(?,?,?,?,?,?,?,?)", (channel_id, name, item["display_name"] or (entry["name"] if entry else None),
                                                                "auto", int(on), item["context_window"], sort, now))
                sort += 1
                if self.catalog is not None:
                    row = db.execute("SELECT * FROM ai_models WHERE id=?", (cursor.lastrowid,)).fetchone()
                    self.catalog.apply(db, row, entry)
                added += 1
                enabled += int(on)
        return {"added": added, "enabled": enabled}

    async def sync(self, channel_id: int, *, actor: str | None = None) -> dict[str, object]:
        """检查上游：只更新已加入模型的“上游已移除”标记，不新增模型。"""
        result = await self.discover(channel_id, actor=actor)
        return {"total": result["total"], "added": 0, "restored": result["restored"], "removed": result["removed"], "note": result["note"]}

    async def test(self, model_id: int, tool: ToolDef, prompt: str, *, actor: str | None = None) -> dict[str, object]:
        model = self.model(model_id)
        endpoint = self.endpoint(model["channel_id"])
        started = time.time()
        try:
            reply = await providers.chat(endpoint, model["model"], "你是连通性测试助手。", [{"role": "user", "content": prompt}],
                                         [tool], max_tokens=4096 if endpoint.protocol == "responses" else 256)
        except ProviderError as exc:
            note = str(exc)
            self.log_call(kind="test", channel_id=model["channel_id"], model_id=model_id, actor=actor, started_at=started,
                          status="error", http_status=exc.status, error_code=exc.code, error=note,
                          duration_ms=int((time.time() - started) * 1000))
            with self.metadata.transaction() as db:
                db.execute("UPDATE ai_models SET tested_at=?, test_note=? WHERE id=?", (time.time(), note, model_id))
            return {"ok": False, "tools": model["tools"], "note": note, "duration_ms": int((time.time() - started) * 1000)}
        duration = int((time.time() - started) * 1000)
        supports = any(call.name == tool.name for call in reply.tool_calls)
        # Responses 的预算也包含推理，达到上限只能记为未确认，不能把可用模型改成不支持工具。
        uncertain = reply.finish == "length" and not supports
        detected = model["tools"] if uncertain else "yes" if supports else "no"
        note = "连通正常，输出达到测试上限，尚未确认工具调用能力" if uncertain else f"连通正常，{'支持' if supports else '未发起'}工具调用，耗时 {duration / 1000:.1f} 秒"
        with self.metadata.transaction() as db:
            db.execute("UPDATE ai_models SET tested_at=?, test_note=?, tools=? WHERE id=?",
                       (time.time(), note, detected, model_id))
        self.log_call(kind="test", channel_id=model["channel_id"], model_id=model_id, actor=actor, started_at=started,
                      status="ok", http_status=reply.status, duration_ms=duration, ttfb_ms=reply.ttfb_ms, input_tokens=reply.input_tokens,
                      output_tokens=reply.output_tokens, cached_tokens=reply.cached_tokens, upstream_id=reply.upstream_id, items=len(reply.tool_calls))
        return {"ok": True, "tools": detected, "note": note, "duration_ms": duration}
