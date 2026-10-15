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
    def __init__(self, metadata: Metadata, keystore: KeyStore, *, log_call: Callable[..., None] | None = None) -> None:
        self.metadata, self.keystore = metadata, keystore
        self.log_call = log_call or (lambda **_: None)

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
        allowed = {"name", "kind", "base_url", "api_key", "headers", "enabled", "concurrency", "timeout"}
        unknown = set(payload) - allowed
        if unknown:
            raise ValueError(f"未知字段：{', '.join(sorted(unknown))}")
        values: dict[str, object] = {}
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

    def _channel_json(self, row) -> dict[str, object]:
        secret = self._open(row["id"], "secret", row["secret"])
        headers = self._open(row["id"], "headers", row["headers"])
        names = sorted(json.loads(headers)) if headers else []
        counts = self.metadata.db.execute(
            "SELECT COUNT(*) AS total, COALESCE(SUM(enabled),0) AS enabled FROM ai_models WHERE channel_id=?", (row["id"],)).fetchone()
        return {"id": row["id"], "name": row["name"], "kind": row["kind"], "base_url": row["base_url"],
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
            db.execute("UPDATE ai_channels SET secret=?, headers=? WHERE id=?",
                       (self._seal(channel_id, "secret", api_key.encode()) if api_key else None,
                        self._seal(channel_id, "headers", json.dumps(headers).encode()) if headers else None, channel_id))
        return self.get(channel_id)

    def update(self, channel_id: int, payload: dict) -> dict[str, object]:
        row = self._row(channel_id)
        values = self._fields(payload, creating=False)
        if "kind" in values and values["kind"] != row["kind"]:
            raise ValueError("渠道类型创建后不能修改，请新建渠道")
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
        return self.get(channel_id)

    def delete(self, channel_id: int) -> None:
        self._row(channel_id)
        with self.metadata.transaction() as db:
            db.execute("DELETE FROM ai_channels WHERE id=?", (channel_id,))

    def endpoint(self, channel_id: int) -> Endpoint:
        row = self._row(channel_id)
        secret = self._open(channel_id, "secret", row["secret"])
        headers = self._open(channel_id, "headers", row["headers"])
        return Endpoint(row["kind"], row["base_url"], secret.decode() if secret else None,
                        json.loads(headers) if headers else {}, int(row["timeout"]))

    def concurrency(self, channel_id: int) -> int:
        row = self.metadata.db.execute("SELECT concurrency FROM ai_channels WHERE id=?", (channel_id,)).fetchone()
        return int(row["concurrency"]) if row else 1

    # ---------- 模型 ----------

    @staticmethod
    def _model_json(row) -> dict[str, object]:
        return {"id": row["id"], "channel_id": row["channel_id"], "model": row["model"],
                "display_name": row["display_name"], "label": row["display_name"] or row["model"],
                "source": row["source"], "enabled": bool(row["enabled"]), "tools": row["tools"],
                "context_window": row["context_window"], "max_output": row["max_output"],
                "removed_upstream": bool(row["removed_upstream"]), "sort": row["sort"],
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

    def usable(self) -> list[dict[str, object]]:
        """用户可选的模型：渠道启用、模型启用、未确认不支持工具调用。"""
        rows = self.metadata.db.execute(
            "SELECT m.*, c.name AS channel_name FROM ai_models m JOIN ai_channels c ON c.id=m.channel_id "
            "WHERE c.enabled=1 AND m.enabled=1 AND m.tools!='no' ORDER BY c.id, m.sort, m.id").fetchall()
        return [{**self._model_json(row), "channel_name": row["channel_name"]} for row in rows]

    def is_usable(self, model_id: int) -> bool:
        return self.metadata.db.execute(
            "SELECT 1 FROM ai_models m JOIN ai_channels c ON c.id=m.channel_id "
            "WHERE m.id=? AND c.enabled=1 AND m.enabled=1 AND m.tools!='no'", (model_id,)).fetchone() is not None

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
            cursor = db.execute(
                "INSERT INTO ai_models(channel_id,model,display_name,source,enabled,tools,context_window,max_output,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (channel_id, model.strip(), values.get("display_name"), "manual", values.get("enabled", 0),
                 values.get("tools", "unknown"), values.get("context_window"), values.get("max_output"), now))
        return self.model(int(cursor.lastrowid))

    @staticmethod
    def _model_fields(payload: dict) -> dict[str, object]:
        allowed = {"display_name", "enabled", "tools", "context_window", "max_output", "sort"}
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
        if "tools" in payload:
            if payload["tools"] not in ("unknown", "yes", "no"):
                raise ValueError("工具调用支持只能是 unknown、yes 或 no")
            values["tools"] = payload["tools"]
        for name, high in (("context_window", 10_000_000), ("max_output", 1_000_000), ("sort", 100000)):
            if name in payload:
                value = payload[name]
                if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= high):
                    raise ValueError(f"{name} 必须是 0–{high} 的整数")
                values[name] = value
        return values

    def update_model(self, model_id: int, payload: dict) -> dict[str, object]:
        self.model(model_id)
        values = self._model_fields(payload)
        if values:
            with self.metadata.transaction() as db:
                db.execute(f"UPDATE ai_models SET {','.join(f'{name}=?' for name in values)} WHERE id=?", (*values.values(), model_id))
        return self.model(model_id)

    def delete_model(self, model_id: int) -> None:
        model = self.model(model_id)
        if model["source"] == "auto" and not model["removed_upstream"]:
            raise ValueError("自动同步的模型不能删除，可以停用它")
        with self.metadata.transaction() as db:
            db.execute("DELETE FROM ai_models WHERE id=?", (model_id,))

    async def sync(self, channel_id: int, *, actor: str | None = None) -> dict[str, object]:
        endpoint = self.endpoint(channel_id)
        started = time.time()
        try:
            upstream = await providers.list_models(endpoint)
        except ProviderError as exc:
            self.log_call(kind="sync", channel_id=channel_id, actor=actor, started_at=started, status="error",
                          http_status=exc.status, error_code=exc.code, error=str(exc))
            with self.metadata.transaction() as db:
                db.execute("UPDATE ai_channels SET last_error=?, updated_at=? WHERE id=?", (str(exc), time.time(), channel_id))
            raise ValueError(f"同步失败：{exc}") from exc
        now = time.time()
        seen = {item["model"]: item for item in upstream}
        added = restored = removed = 0
        with self.metadata.transaction() as db:
            existing = {row["model"]: row for row in db.execute("SELECT * FROM ai_models WHERE channel_id=?", (channel_id,))}
            for index, (name, item) in enumerate(seen.items()):
                row = existing.get(name)
                if row is None:
                    # 新发现的模型默认停用，避免误开昂贵或不支持工具调用的模型。
                    db.execute("INSERT INTO ai_models(channel_id,model,display_name,source,enabled,context_window,sort,created_at) "
                               "VALUES(?,?,?,?,0,?,?,?)", (channel_id, name, item["display_name"], "auto",
                                                          item["context_window"], index, now))
                    added += 1
                else:
                    if row["removed_upstream"]:
                        restored += 1
                    db.execute("UPDATE ai_models SET removed_upstream=0, context_window=COALESCE(context_window,?) WHERE id=?",
                               (item["context_window"], row["id"]))
            for name, row in existing.items():
                if name not in seen and row["source"] == "auto" and not row["removed_upstream"]:
                    db.execute("UPDATE ai_models SET removed_upstream=1 WHERE id=?", (row["id"],))
                    removed += 1
            note = f"上游 {len(seen)} 个模型，新增 {added} 个" + (f"，{removed} 个已移除" if removed else "")
            db.execute("UPDATE ai_channels SET synced_at=?, sync_note=?, last_error=NULL, updated_at=? WHERE id=?",
                       (now, note, now, channel_id))
        self.log_call(kind="sync", channel_id=channel_id, actor=actor, started_at=started, status="ok",
                      duration_ms=int((time.time() - started) * 1000), items=len(seen))
        return {"total": len(seen), "added": added, "restored": restored, "removed": removed, "note": note}

    async def test(self, model_id: int, tool: ToolDef, prompt: str, *, actor: str | None = None) -> dict[str, object]:
        model = self.model(model_id)
        endpoint = self.endpoint(model["channel_id"])
        started = time.time()
        try:
            reply = await providers.chat(endpoint, model["model"], "你是连通性测试助手。", [{"role": "user", "content": prompt}],
                                         [tool], max_tokens=256)
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
        note = f"连通正常，{'支持' if supports else '未发起'}工具调用，耗时 {duration / 1000:.1f} 秒"
        with self.metadata.transaction() as db:
            db.execute("UPDATE ai_models SET tested_at=?, test_note=?, tools=? WHERE id=?",
                       (time.time(), note, "yes" if supports else "no", model_id))
        self.log_call(kind="test", channel_id=model["channel_id"], model_id=model_id, actor=actor, started_at=started,
                      status="ok", duration_ms=duration, ttfb_ms=reply.ttfb_ms, input_tokens=reply.input_tokens,
                      output_tokens=reply.output_tokens, upstream_id=reply.upstream_id)
        return {"ok": True, "tools": "yes" if supports else "no", "note": note, "duration_ms": duration}
