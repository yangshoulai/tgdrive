"""模型目录（docs/assistant-design.md §19.1）：从公开的模型信息源同步上下文、输出上限、能力与价格，按模型 ID 匹配渠道模型。

- 来源默认 models.dev（按服务商分组），也兼容 OpenRouter 的 /api/v1/models 格式；地址由管理员配置。
- 同步只替换来自数据源的条目；管理员手动新增或编辑的条目（source='manual'）不会被覆盖或删除。
- 渠道模型记录 catalog_id；管理员手动改过的字段记在 manual_fields 里，目录同步不再改它们。
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Callable

from ..errors import NotFoundError
from ..metadata import Metadata
from . import providers
from .config import AssistantConfig
from .providers import ProviderError

DEFAULT_URL = "https://models.dev/api.json"
MAX_BYTES = 32 * 1024 * 1024
SYNC_INTERVAL = 86400
CAPABILITIES = ("tools", "reasoning", "vision", "structured")
# 由目录带入渠道模型、且管理员可以手动覆盖的字段。
MODEL_FIELDS = ("context_window", "max_output", "tools", "input_price", "output_price", "capabilities")

# 同名模型在多个服务商出现时，优先原厂。
_ORIGINS = (
    (("gpt-", "o1", "o3", "o4", "chatgpt", "codex", "text-embedding", "dall-e", "whisper"), "openai"),
    (("claude",), "anthropic"),
    (("gemini", "gemma"), "google"),
    (("deepseek",), "deepseek"),
    (("qwen", "qwq", "qvq"), "alibaba"),
    (("glm", "chatglm"), "zhipuai"),
    (("kimi", "moonshot"), "moonshotai"),
    (("mistral", "codestral", "ministral", "magistral", "devstral", "pixtral", "voxtral"), "mistral"),
    (("grok",), "xai"),
    (("llama",), "llama"),
    (("minimax", "abab"), "minimax"),
    (("doubao",), "volcengine"),
    (("hunyuan",), "tencent"),
    (("ernie",), "baidu"),
)
_SUFFIXES = re.compile(r":(free|beta|extended|thinking|nitro|floor|online|exacto)$")
_DATES = re.compile(r"(-\d{4}-\d{2}-\d{2}|-\d{8}|-\d{6}|-\d{4}|-latest|@\d{8})$")


def bare(model: str) -> str:
    value = model.strip().lower()
    value = value.rsplit("/", 1)[-1]
    return _SUFFIXES.sub("", value)


def undated(model: str) -> str:
    value = bare(model)
    for _ in range(2):
        value = _DATES.sub("", value)
    return value


def loose(model: str) -> str:
    return undated(model).replace(".", "-").replace("_", "-")


def origin(model: str) -> str | None:
    value = bare(model)
    for prefixes, provider in _ORIGINS:
        if value.startswith(prefixes):
            return provider
    return None


def _number(value: object, *, scale: float = 1.0) -> float | None:
    try:
        number = float(value) * scale  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return number if number >= 0 and number < 1e9 else None


def _int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and 0 < value < 1e9:
        return int(value)
    return None


def _text(value: object, limit: int = 200) -> str | None:
    return value.strip()[:limit] if isinstance(value, str) and value.strip() else None


def parse(data: object) -> list[dict]:
    """把数据源响应转换成目录条目；无法识别的格式抛 ValueError。"""
    entries: list[dict] = []
    if isinstance(data, dict) and isinstance(data.get("data"), list):  # OpenRouter
        for item in data["data"]:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or "/" not in item["id"]:
                continue
            provider, model = item["id"].split("/", 1)
            pricing = item.get("pricing") if isinstance(item.get("pricing"), dict) else {}
            params = item.get("supported_parameters") if isinstance(item.get("supported_parameters"), list) else []
            architecture = item.get("architecture") if isinstance(item.get("architecture"), dict) else {}
            inputs = architecture.get("input_modalities") if isinstance(architecture.get("input_modalities"), list) else []
            top = item.get("top_provider") if isinstance(item.get("top_provider"), dict) else {}
            name = _text(item.get("name"))
            entries.append({
                "provider": provider.lower()[:60], "model": model[:200],
                "name": name.split(": ", 1)[-1] if name else None, "family": None,
                "context_window": _int(item.get("context_length")), "max_output": _int(top.get("max_completion_tokens")),
                "input_price": _number(pricing.get("prompt"), scale=1e6), "output_price": _number(pricing.get("completion"), scale=1e6),
                "cache_price": _number(pricing.get("input_cache_read"), scale=1e6),
                "capabilities": {"tools": "tools" in params, "reasoning": "reasoning" in params or "include_reasoning" in params,
                                 "vision": "image" in inputs, "structured": "structured_outputs" in params or "response_format" in params},
                "knowledge": None, "released": None})
        return entries
    if not isinstance(data, dict):
        raise ValueError("模型目录格式无法识别")
    for provider_key, provider in data.items():  # models.dev
        if not isinstance(provider, dict) or not isinstance(provider.get("models"), dict):
            continue
        provider_id = str(provider.get("id") or provider_key).lower()[:60]
        for model_key, item in provider["models"].items():
            if not isinstance(item, dict):
                continue
            model = str(item.get("id") or model_key)[:200]
            cost = item.get("cost") if isinstance(item.get("cost"), dict) else {}
            limit = item.get("limit") if isinstance(item.get("limit"), dict) else {}
            modalities = item.get("modalities") if isinstance(item.get("modalities"), dict) else {}
            inputs = modalities.get("input") if isinstance(modalities.get("input"), list) else []
            tool_call = item.get("tool_call")
            entries.append({
                "provider": provider_id, "model": model, "name": _text(item.get("name")), "family": _text(item.get("family"), 60),
                "context_window": _int(limit.get("context")), "max_output": _int(limit.get("output")),
                "input_price": _number(cost.get("input")), "output_price": _number(cost.get("output")),
                "cache_price": _number(cost.get("cache_read")),
                "capabilities": {"tools": tool_call if isinstance(tool_call, bool) else None, "reasoning": item.get("reasoning") is True,
                                 "vision": "image" in inputs or item.get("attachment") is True,
                                 "structured": item.get("structured_output") is True},
                "knowledge": _text(item.get("knowledge"), 20), "released": _text(item.get("release_date"), 20)})
    if not entries:
        raise ValueError("模型目录为空或格式无法识别")
    return entries


class CatalogStore:
    def __init__(self, metadata: Metadata, config: AssistantConfig, *, log_call: Callable[..., None] | None = None) -> None:
        self.metadata, self.config = metadata, config
        self.log_call = log_call or (lambda **_: None)
        self._index: tuple[int, dict] | None = None
        self._lock = asyncio.Lock()

    # ---------- 设置与状态 ----------

    def settings(self) -> dict[str, object]:
        stored = self.config.raw("catalog")
        stored = stored if isinstance(stored, dict) else {}
        url = stored.get("url") if isinstance(stored.get("url"), str) and stored.get("url") else DEFAULT_URL
        return {"url": url, "auto_sync": stored.get("auto_sync") is not False}

    def status(self) -> dict[str, object]:
        state = self.config.raw("catalog_state")
        state = state if isinstance(state, dict) else {}
        counts = self.metadata.db.execute("SELECT COUNT(*), COALESCE(SUM(source='manual'),0), COUNT(DISTINCT provider) FROM ai_catalog").fetchone()
        return {**self.settings(), "default_url": DEFAULT_URL, "synced_at": state.get("synced_at"), "note": state.get("note"),
                "error": state.get("error"), "total": int(counts[0]), "manual": int(counts[1]), "providers": int(counts[2])}

    def update_settings(self, payload: dict) -> dict[str, object]:
        unknown = set(payload) - {"url", "auto_sync"}
        if unknown:
            raise ValueError(f"未知字段：{', '.join(sorted(unknown))}")
        current = self.settings()
        if "url" in payload:
            url = payload["url"]
            if url in (None, ""):
                current["url"] = DEFAULT_URL
            else:
                from .channels import normalize_base_url
                current["url"] = normalize_base_url(url)
        if "auto_sync" in payload:
            if not isinstance(payload["auto_sync"], bool):
                raise ValueError("auto_sync 必须是布尔值")
            current["auto_sync"] = payload["auto_sync"]
        self.config.write_raw("catalog", {"url": current["url"] if current["url"] != DEFAULT_URL else None,
                                          "auto_sync": current["auto_sync"]})
        return self.status()

    # ---------- 读取 ----------

    @staticmethod
    def _json(row) -> dict[str, object]:
        try:
            capabilities = json.loads(row["capabilities"] or "{}")
        except ValueError:
            capabilities = {}
        return {"id": row["id"], "provider": row["provider"], "model": row["model"], "name": row["name"], "family": row["family"],
                "context_window": row["context_window"], "max_output": row["max_output"], "input_price": row["input_price"],
                "output_price": row["output_price"], "cache_price": row["cache_price"],
                "capabilities": {name: capabilities.get(name) for name in CAPABILITIES},
                "knowledge": row["knowledge"], "released": row["released"], "source": row["source"], "updated_at": row["updated_at"]}

    def entries(self, *, query: str = "", provider: str = "", cursor: str = "", limit: int = 100) -> dict[str, object]:
        limit = max(1, min(limit, 200))
        where, args = ["1"], []
        if query.strip():
            pattern = "%" + query.strip().lower().replace("\\", "").replace("%", "\\%").replace("_", "\\_") + "%"
            where.append("(lower(id) LIKE ? ESCAPE '\\' OR lower(COALESCE(name,'')) LIKE ? ESCAPE '\\')")
            args += [pattern, pattern]
        if provider:
            where.append("provider=?")
            args.append(provider)
        if cursor:
            where.append("id>?")
            args.append(cursor)
        rows = self.metadata.db.execute(f"SELECT * FROM ai_catalog WHERE {' AND '.join(where)} ORDER BY id LIMIT ?", (*args, limit + 1)).fetchall()
        return {"entries": [self._json(row) for row in rows[:limit]], "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None}

    def providers(self) -> list[dict[str, object]]:
        return [{"provider": row[0], "count": int(row[1])} for row in
                self.metadata.db.execute("SELECT provider, COUNT(*) FROM ai_catalog GROUP BY provider ORDER BY COUNT(*) DESC, provider")]

    def get(self, entry_id: str) -> dict[str, object]:
        row = self.metadata.db.execute("SELECT * FROM ai_catalog WHERE id=?", (entry_id,)).fetchone()
        if row is None:
            raise NotFoundError("目录条目不存在")
        return self._json(row)

    def _lookup(self) -> dict[str, dict[str, list[dict]]]:
        """按 完整 ID／去前缀／去日期／宽松 四级建立索引；目录变化（写事务）后重建。"""
        revision = self.metadata.db.execute("SELECT COUNT(*), COALESCE(MAX(updated_at),0) FROM ai_catalog").fetchone()
        key = hash((revision[0], revision[1]))
        if self._index is not None and self._index[0] == key:
            return self._index[1]
        index: dict[str, dict[str, list[dict]]] = {"id": {}, "bare": {}, "undated": {}, "loose": {}}
        for row in self.metadata.db.execute("SELECT * FROM ai_catalog"):
            entry = self._json(row)
            index["id"].setdefault(entry["id"].lower(), []).append(entry)
            index["bare"].setdefault(bare(entry["model"]), []).append(entry)
            index["undated"].setdefault(undated(entry["model"]), []).append(entry)
            index["loose"].setdefault(loose(entry["model"]), []).append(entry)
        self._index = (key, index)
        return index

    @staticmethod
    def _best(model: str, candidates: list[dict]) -> dict:
        preferred = origin(model)
        prefix = model.lower().split("/", 1)[0] if "/" in model else None

        def score(entry: dict) -> tuple:
            filled = sum(entry[name] is not None for name in ("context_window", "max_output", "input_price", "output_price"))
            return (entry["source"] == "manual", entry["provider"] == prefix, entry["provider"] == preferred, filled, -len(entry["id"]))

        return max(candidates, key=score)

    def match(self, model: str) -> dict | None:
        if not model:
            return None
        index = self._lookup()
        for level, key in (("id", model.strip().lower()), ("bare", bare(model)), ("undated", undated(model)), ("loose", loose(model))):
            candidates = index[level].get(key)
            if candidates:
                return self._best(model, candidates)
        return None

    # ---------- 手动维护 ----------

    @staticmethod
    def _fields(payload: dict, *, creating: bool) -> dict[str, object]:
        allowed = {"provider", "model", "name", "context_window", "max_output", "input_price", "output_price", "cache_price", "capabilities"}
        unknown = set(payload) - allowed
        if unknown:
            raise ValueError(f"未知字段：{', '.join(sorted(unknown))}")
        values: dict[str, object] = {}
        for name, limit in (("provider", 60), ("model", 200)):
            if creating or name in payload:
                value = payload.get(name)
                if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit or any(ord(c) < 33 for c in value.strip()):
                    raise ValueError(f"{'服务商' if name == 'provider' else '模型 ID'}需要 1–{limit} 个可见字符")
                values[name] = value.strip().lower() if name == "provider" else value.strip()
        if "name" in payload:
            name = payload["name"]
            if name is not None and (not isinstance(name, str) or len(name) > 120):
                raise ValueError("名称最多 120 个字符")
            values["name"] = name.strip() if isinstance(name, str) and name.strip() else None
        for name, high in (("context_window", 100_000_000), ("max_output", 10_000_000)):
            if name in payload:
                value = payload[name]
                if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 0 < value <= high):
                    raise ValueError(f"{name} 必须是 1–{high} 的整数")
                values[name] = value
        for name in ("input_price", "output_price", "cache_price"):
            if name in payload:
                value = payload[name]
                if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 100000):
                    raise ValueError("价格必须是 0–100000 之间的数字（美元／百万 token）")
                values[name] = None if value is None else float(value)
        if "capabilities" in payload:
            caps = payload["capabilities"]
            if not isinstance(caps, dict) or set(caps) - set(CAPABILITIES) or not all(v is None or isinstance(v, bool) for v in caps.values()):
                raise ValueError("能力只能包含 tools、reasoning、vision、structured，值为布尔或 null")
            values["capabilities"] = json.dumps({name: caps.get(name) for name in CAPABILITIES})
        return values

    def create(self, payload: dict) -> dict[str, object]:
        values = self._fields(payload, creating=True)
        entry_id = f"{values['provider']}/{values['model']}"
        with self.metadata.transaction() as db:
            if db.execute("SELECT 1 FROM ai_catalog WHERE id=?", (entry_id,)).fetchone():
                raise ValueError("目录中已有这个模型，请直接编辑")
            columns = {**values, "id": entry_id, "source": "manual", "updated_at": time.time()}
            columns.setdefault("capabilities", json.dumps({name: None for name in CAPABILITIES}))
            db.execute(f"INSERT INTO ai_catalog({','.join(columns)}) VALUES({','.join('?' * len(columns))})", tuple(columns.values()))
        self.refresh_models()
        return self.get(entry_id)

    def update(self, entry_id: str, payload: dict) -> dict[str, object]:
        self.get(entry_id)
        values = self._fields({k: v for k, v in payload.items() if k not in ("provider", "model")}, creating=False)
        if {"provider", "model"} & set(payload):
            raise ValueError("服务商与模型 ID 不能修改")
        with self.metadata.transaction() as db:
            sets = [f"{name}=?" for name in values] + ["source='manual'", "updated_at=?"]
            db.execute(f"UPDATE ai_catalog SET {','.join(sets)} WHERE id=?", (*values.values(), time.time(), entry_id))
        self.refresh_models()
        return self.get(entry_id)

    def delete(self, entry_id: str) -> None:
        entry = self.get(entry_id)
        if entry["source"] != "manual":
            raise ValueError("同步来的条目不能删除；可以编辑它，编辑后不再被同步覆盖")
        with self.metadata.transaction() as db:
            db.execute("DELETE FROM ai_catalog WHERE id=?", (entry_id,))
            db.execute("UPDATE ai_models SET catalog_id=NULL WHERE catalog_id=?", (entry_id,))

    # ---------- 同步 ----------

    def due(self, now: float | None = None) -> bool:
        if not self.settings()["auto_sync"]:
            return False
        state = self.config.raw("catalog_state")
        last = state.get("attempted_at") if isinstance(state, dict) else None
        return not isinstance(last, (int, float)) or (now or time.time()) - last >= SYNC_INTERVAL

    async def _fetch(self, url: str) -> object:
        request = await providers._open("GET", url, {"Accept": "application/json", "User-Agent": "Tessera-Assistant"}, None, 60)
        try:
            raw = await asyncio.to_thread(request.read_all, MAX_BYTES + 1)
        finally:
            request.close()
        if len(raw) > MAX_BYTES:
            raise ProviderError("模型目录超过 32 MB", code="bad_response")
        try:
            return json.loads(raw)
        except ValueError as exc:
            raise ProviderError("模型目录不是 JSON", code="bad_response") from exc

    async def sync(self, *, actor: str | None = None) -> dict[str, object]:
        async with self._lock:
            url = str(self.settings()["url"])
            started = time.time()
            state = self.config.raw("catalog_state")
            state = dict(state) if isinstance(state, dict) else {}
            state["attempted_at"] = started
            try:
                entries = parse(await self._fetch(url))
            except (ProviderError, ValueError) as exc:
                message = str(exc)
                self.config.write_raw("catalog_state", {**state, "error": message})
                self.log_call(kind="sync", actor=actor or "system", started_at=started, status="error",
                              error_code=getattr(exc, "code", "bad_response"), error=f"模型目录：{message}",
                              duration_ms=int((time.time() - started) * 1000))
                raise ValueError(f"模型目录同步失败：{message}") from exc
            now = time.time()

            def write() -> tuple[int, int]:
                added = updated = 0
                with self.metadata.transaction() as db:
                    manual = {row[0] for row in db.execute("SELECT id FROM ai_catalog WHERE source='manual'")}
                    existing = {row[0] for row in db.execute("SELECT id FROM ai_catalog WHERE source!='manual'")}
                    seen = set()
                    for entry in entries:
                        entry_id = f"{entry['provider']}/{entry['model']}"
                        if entry_id in manual or entry_id in seen:
                            continue
                        seen.add(entry_id)
                        values = (entry["provider"], entry["model"], entry["name"], entry["family"], entry["context_window"],
                                  entry["max_output"], entry["input_price"], entry["output_price"], entry["cache_price"],
                                  json.dumps(entry["capabilities"]), entry["knowledge"], entry["released"], source, now)
                        if entry_id in existing:
                            db.execute("UPDATE ai_catalog SET provider=?,model=?,name=?,family=?,context_window=?,max_output=?,input_price=?,"
                                       "output_price=?,cache_price=?,capabilities=?,knowledge=?,released=?,source=?,updated_at=? WHERE id=?",
                                       (*values, entry_id))
                            updated += 1
                        else:
                            db.execute("INSERT INTO ai_catalog(provider,model,name,family,context_window,max_output,input_price,output_price,"
                                       "cache_price,capabilities,knowledge,released,source,updated_at,id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                       (*values, entry_id))
                            added += 1
                    for entry_id in existing - seen:
                        db.execute("DELETE FROM ai_catalog WHERE id=?", (entry_id,))
                return added, updated

            source = "openrouter" if "openrouter" in url else "models.dev"
            added, updated = await self.metadata.run_in_thread(write)
            note = f"{len(entries)} 个模型，新增 {added} 个"
            self.config.write_raw("catalog_state", {"attempted_at": started, "synced_at": now, "note": note, "error": None})
            self.log_call(kind="sync", actor=actor or "system", started_at=started, status="ok", items=len(entries),
                          duration_ms=int((time.time() - started) * 1000))
            refreshed = self.refresh_models()
            return {"total": len(entries), "added": added, "updated": updated, "models": refreshed, "note": note}

    # ---------- 套用到渠道模型 ----------

    def values_for(self, entry: dict | None) -> dict[str, object]:
        if entry is None:
            return {}
        caps = entry["capabilities"]
        result: dict[str, object] = {"context_window": entry["context_window"], "max_output": entry["max_output"],
                                     "input_price": entry["input_price"], "output_price": entry["output_price"],
                                     "capabilities": json.dumps({name: caps.get(name) for name in CAPABILITIES})}
        if caps.get("tools") is not None:
            result["tools"] = "yes" if caps["tools"] else "no"
        return result

    def apply(self, db, row, entry: dict | None) -> bool:
        """把目录信息写入一个渠道模型；跳过管理员手动改过的字段与已经测试过的工具支持。"""
        try:
            manual = set(json.loads(row["manual_fields"] or "[]"))
        except ValueError:
            manual = set()
        values = self.values_for(entry)
        if row["tested_at"] is not None:
            values.pop("tools", None)
        updates = {name: value for name, value in values.items() if name not in manual and value is not None}
        if "vision" in manual and "capabilities" in updates:
            # 管理员手动设置的图片输入支持在目录同步时保留，其余能力仍跟随目录。
            try:
                current = json.loads(row["capabilities"] or "{}")
            except ValueError:
                current = {}
            updates["capabilities"] = json.dumps({**json.loads(updates["capabilities"]), "vision": current.get("vision")})
        updates["catalog_id"] = entry["id"] if entry else None
        changed = {name: value for name, value in updates.items() if row[name] != value}
        if changed:
            db.execute(f"UPDATE ai_models SET {','.join(f'{name}=?' for name in changed)} WHERE id=?", (*changed.values(), row["id"]))
        return bool(changed)

    def refresh_models(self) -> int:
        """目录变化后重新匹配所有渠道模型。"""
        self._index = None
        count = 0
        with self.metadata.transaction() as db:
            for row in db.execute("SELECT * FROM ai_models").fetchall():
                count += int(self.apply(db, row, self.match(row["model"])))
        return count
