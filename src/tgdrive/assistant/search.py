"""文件助手的网络搜索：管理员在控制台选择一个搜索服务（自建 SearXNG、Brave Search API 或 Tavily），未配置时不提供 web_search 工具。

- 服务地址由管理员配置（自建 SearXNG 常在内网），因此与模型渠道一样直接请求，不经过离线下载的公网地址限制。
- API Key 用 KEK 派生的子密钥加密保存在 settings 表，接口只返回掩码；系统锁定后无法使用。
- 只把查询词与结果数量发给搜索服务，结果是不可信外部内容，由工具标记来源。
"""

from __future__ import annotations

import asyncio
import base64
import json
import urllib.error
import urllib.parse
import urllib.request

from ..crypto import derive_subkey, open_sealed, seal

SETTINGS_KEY = "assistant.search"
PROVIDERS = {
    "searxng": {"label": "SearXNG（自建）", "needs_url": True, "needs_key": False},
    "brave": {"label": "Brave Search API", "needs_url": False, "needs_key": True},
    "tavily": {"label": "Tavily", "needs_url": False, "needs_key": True},
}
TIMEOUT = 15
MAX_RESPONSE = 2 * 1024 * 1024


class SearchError(Exception):
    pass


def _mask(secret: str | None) -> str | None:
    if not secret:
        return None
    return secret[:3] + "•••" + secret[-2:] if len(secret) > 8 else "•••"


class SearchService:
    def __init__(self, metadata, keystore, *, opener=None) -> None:
        self.metadata, self.keystore = metadata, keystore
        # 测试可以注入 opener(request, timeout) -> (status, bytes)
        self._opener = opener

    # ---------- 设置 ----------

    def _key(self) -> bytes:
        return derive_subkey(self.keystore.require_kek(), "assistant-search")

    def _stored(self) -> dict:
        row = self.metadata.db.execute("SELECT value FROM settings WHERE key=?", (SETTINGS_KEY,)).fetchone()
        try:
            value = json.loads(row["value"]) if row else {}
        except ValueError:
            value = {}
        return value if isinstance(value, dict) else {}

    def _secret(self, stored: dict) -> str | None:
        sealed = stored.get("key")
        if not sealed:
            return None
        return open_sealed(self._key(), base64.b64decode(sealed), "assistant-search-key").decode()

    def configured(self) -> bool:
        stored = self._stored()
        spec = PROVIDERS.get(stored.get("provider") or "")
        return bool(spec and (stored.get("url") or not spec["needs_url"]) and (stored.get("key") or not spec["needs_key"]))

    def describe(self) -> dict:
        stored = self._stored()
        secret = None
        if stored.get("key") and self.keystore.unlocked:
            try:
                secret = self._secret(stored)
            except Exception:
                secret = None
        return {"provider": stored.get("provider") or "", "url": stored.get("url") or "", "api_key": _mask(secret),
                "configured": self.configured(),
                "providers": [{"value": name, **spec} for name, spec in PROVIDERS.items()]}

    def configure(self, payload: dict) -> dict:
        if not isinstance(payload, dict):
            raise ValueError("搜索设置格式不正确")
        provider = payload.get("provider") or ""
        if provider == "":
            with self.metadata.transaction() as db:
                db.execute("DELETE FROM settings WHERE key=?", (SETTINGS_KEY,))
            return self.describe()
        spec = PROVIDERS.get(provider)
        if spec is None:
            raise ValueError("不支持的搜索服务")
        stored = self._stored() if self._stored().get("provider") == provider else {}
        url = payload.get("url", stored.get("url") or "")
        if not isinstance(url, str):
            raise ValueError("搜索服务地址不正确")
        url = url.strip().rstrip("/")
        if spec["needs_url"]:
            parts = urllib.parse.urlsplit(url)
            if parts.scheme not in ("http", "https") or not parts.hostname or len(url) > 512:
                raise ValueError("请填写 SearXNG 实例地址，例如 https://search.example.com")
        else:
            url = ""
        key = payload.get("api_key")
        sealed = stored.get("key")
        if key is not None:
            if not isinstance(key, str) or len(key) > 512 or any(ord(char) < 33 for char in key):
                raise ValueError("API Key 格式不正确")
            sealed = base64.b64encode(seal(self._key(), key.encode(), "assistant-search-key")).decode() if key else None
        if spec["needs_key"] and not sealed:
            raise ValueError(f"{spec['label']} 需要填写 API Key")
        value = {"provider": provider, "url": url, **({"key": sealed} if sealed else {})}
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (SETTINGS_KEY, json.dumps(value)))
        return self.describe()

    # ---------- 搜索 ----------

    def _fetch(self, request: urllib.request.Request) -> bytes:
        if self._opener is not None:
            status, body = self._opener(request, TIMEOUT)
        else:
            try:
                with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                    status, body = response.status, response.read(MAX_RESPONSE + 1)
            except urllib.error.HTTPError as exc:
                status, body = exc.code, b""
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                raise SearchError(f"连接搜索服务失败：{type(exc).__name__}") from None
        if status in (401, 403):
            raise SearchError("搜索服务拒绝了请求，请管理员检查 API Key")
        if status == 429:
            raise SearchError("搜索服务限流，请稍后再试")
        if status >= 400:
            raise SearchError(f"搜索服务返回错误（HTTP {status}）")
        if len(body) > MAX_RESPONSE:
            raise SearchError("搜索结果过大")
        return body

    def _search_sync(self, query: str, count: int, language: str) -> list[dict]:
        stored = self._stored()
        provider = stored.get("provider")
        headers = {"Accept": "application/json", "User-Agent": "Tessera-Assistant"}
        if provider == "searxng":
            params = urllib.parse.urlencode({"q": query, "format": "json", "language": language or "auto", "safesearch": 1})
            data = json.loads(self._fetch(urllib.request.Request(f"{stored['url']}/search?{params}", headers=headers)))
            items = [{"title": item.get("title"), "url": item.get("url"), "snippet": item.get("content")} for item in data.get("results") or []]
        elif provider == "brave":
            params = urllib.parse.urlencode({"q": query, "count": count, **({"search_lang": language.split("-")[0]} if language else {})})
            data = json.loads(self._fetch(urllib.request.Request(f"https://api.search.brave.com/res/v1/web/search?{params}",
                                                                 headers={**headers, "X-Subscription-Token": self._secret(stored) or ""})))
            items = [{"title": item.get("title"), "url": item.get("url"), "snippet": item.get("description")}
                     for item in (data.get("web") or {}).get("results") or []]
        elif provider == "tavily":
            body = json.dumps({"query": query, "max_results": count, "search_depth": "basic"}).encode()
            data = json.loads(self._fetch(urllib.request.Request("https://api.tavily.com/search", data=body, method="POST",
                                                                 headers={**headers, "Content-Type": "application/json",
                                                                          "Authorization": f"Bearer {self._secret(stored) or ''}"})))
            items = [{"title": item.get("title"), "url": item.get("url"), "snippet": item.get("content")} for item in data.get("results") or []]
        else:
            raise SearchError("管理员还没有配置网络搜索")
        results = []
        for item in items:
            url = item.get("url")
            if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                continue
            results.append({"title": str(item.get("title") or "")[:300], "url": url[:2048], "snippet": str(item.get("snippet") or "")[:600]})
            if len(results) >= count:
                break
        return results

    async def search(self, query: str, count: int = 8, language: str = "") -> list[dict]:
        try:
            return await asyncio.to_thread(self._search_sync, query, count, language)
        except (ValueError, KeyError, TypeError) as exc:
            raise SearchError("搜索服务返回了无法识别的结果") from exc
