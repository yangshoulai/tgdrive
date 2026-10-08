"""管理员可配置的系统设置：对外访问地址。

值保存在 SQLite `settings` 表中，优先级为：管理员设置 > 启动参数/环境变量 > 前端按当前站点推断。
这些值不是秘密，读取时不需要系统解锁。
"""

from __future__ import annotations

from urllib.parse import urlsplit

from .metadata import Metadata

# 设置键 → 中文名称，用于错误提示。
URL_SETTINGS = {
    "public_base_url": "公开访问地址",
    "s3_endpoint": "S3 Endpoint",
}


def normalize_origin(value: str | None, label: str) -> str | None:
    """校验并规范化为 `scheme://host[:port]`；空值表示恢复默认。"""
    value = (value or "").strip()
    if not value:
        return None
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"{label}必须是以 http:// 或 https:// 开头的完整地址")
    if parts.path not in ("", "/") or parts.query or parts.fragment or parts.username or parts.password:
        raise ValueError(f"{label}只能包含协议、域名和端口，不能带路径或参数")
    try:
        port = parts.port
    except ValueError as exc:
        raise ValueError(f"{label}的端口不合法") from exc
    host = parts.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    default_port = 443 if parts.scheme == "https" else 80
    return f"{parts.scheme}://{host}" + (f":{port}" if port and port != default_port else "")


class SystemSettings:
    def __init__(self, metadata: Metadata, defaults: dict[str, str | None] | None = None) -> None:
        self.metadata = metadata
        self._cache: dict[str, str] | None = None
        self.defaults = {key: normalize_origin(value, URL_SETTINGS[key]) for key, value in (defaults or {}).items()
                         if key in URL_SETTINGS}

    def _stored(self) -> dict[str, str]:
        # 路由每个请求都要读取 S3 主机名，缓存到下一次 update。
        if self._cache is None:
            rows = self.metadata.db.execute(
                f"SELECT key,value FROM settings WHERE key IN ({','.join('?' * len(URL_SETTINGS))})", tuple(URL_SETTINGS))
            self._cache = {row["key"]: row["value"] for row in rows}
        return self._cache

    def get(self, key: str) -> str | None:
        """生效值：管理员设置优先，其次启动参数默认值。"""
        return self._stored().get(key) or self.defaults.get(key)

    def describe(self) -> dict[str, dict[str, str | None]]:
        stored = self._stored()
        return {key: {"value": stored.get(key), "default": self.defaults.get(key),
                      "effective": stored.get(key) or self.defaults.get(key)} for key in URL_SETTINGS}

    def public_config(self) -> dict[str, str | None]:
        return {key: self.get(key) for key in URL_SETTINGS}

    def s3_hostname(self) -> str | None:
        endpoint = self.get("s3_endpoint")
        return urlsplit(endpoint).hostname if endpoint else None

    def update(self, values: dict[str, object]) -> dict[str, dict[str, str | None]]:
        unknown = set(values) - set(URL_SETTINGS)
        if unknown:
            raise ValueError(f"未知设置：{', '.join(sorted(unknown))}")
        normalized = {key: normalize_origin(None if value is None else str(value), URL_SETTINGS[key])
                      for key, value in values.items()}
        merged = {**self.public_config(), **{k: v or self.defaults.get(k) for k, v in normalized.items()}}
        public, s3 = merged.get("public_base_url"), merged.get("s3_endpoint")
        # S3 采用路径风格，与网页共用同一主机名时 /bucket/key 会和页面路由冲突。
        if public and s3 and urlsplit(public).hostname == urlsplit(s3).hostname:
            raise ValueError("S3 Endpoint 必须使用与公开访问地址不同的域名，例如 s3.example.com")
        with self.metadata.transaction() as db:
            for key, value in normalized.items():
                if value is None:
                    db.execute("DELETE FROM settings WHERE key=?", (key,))
                else:
                    db.execute("INSERT INTO settings(key,value) VALUES(?,?) "
                               "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
        self._cache = None
        return self.describe()
