"""秘密保护（docs/assistant-design.md §19.8）。

- 已知秘密：渠道 API Key、渠道附加请求头的值、离线下载出站代理的密码。模型输出与工具结果离开服务端前替换为 •••。
  模型本身拿不到这些值，这一层用来兜底（例如用户把它们写进了自己的文件）。
- 文本内容：read_text_file 返回给模型的内容中形如密钥的片段替换为占位文本，避免用户文件里的凭据被发送给模型服务。
"""

from __future__ import annotations

import re
import time
from urllib.parse import urlsplit

MASK = "•••"
HIDDEN = "[已隐藏的密钥]"

_PATTERNS = re.compile("|".join([
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{0,8192}?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}",
    r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
    r"\bgh[pousr]_[A-Za-z0-9]{36,}\b",
    r"\bgithub_pat_[A-Za-z0-9_]{40,}\b",
    r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b",
    r"\bAIza[0-9A-Za-z_\-]{35}\b",
    r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
    r"(?i:\bbearer\s+[A-Za-z0-9._~+/\-]{20,}=*)",
    r"(?<![A-Za-z0-9])(?i:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*[\"']?[^\s\"']{8,}",
]))


def redact_content(text: str) -> tuple[str, int]:
    """把文本中形如密钥的片段替换为占位文本，返回（新文本，替换次数）。"""
    count = 0

    def replace(match: re.Match) -> str:
        nonlocal count
        count += 1
        value = match.group(0)
        # 「password = xxx」这类保留键名，便于模型理解上下文。
        key = re.match(r"(?i)((?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*[\"']?)", value)
        return (key.group(1) if key else "") + HIDDEN

    return _PATTERNS.sub(replace, text), count


class SecretGuard:
    """收集服务端已知的秘密，替换出现在模型输出或工具结果里的原文。结果缓存 30 秒。"""

    def __init__(self, channels, offline=None) -> None:
        self.channels, self.offline = channels, offline
        self._cache: tuple[float, list[str]] | None = None

    def known(self) -> list[str]:
        now = time.monotonic()
        if self._cache is not None and now - self._cache[0] < 30:
            return self._cache[1]
        values: set[str] = set()
        try:
            for row in self.channels.metadata.db.execute("SELECT id FROM ai_channels").fetchall():
                endpoint = self.channels.endpoint(int(row["id"]))
                if endpoint.api_key:
                    values.add(endpoint.api_key)
                values.update(value for value in endpoint.headers.values() if value)
        except Exception:  # 系统锁定等情况下无法解密：没有可替换的已知秘密
            pass
        try:
            proxy = self.offline.resources.config().get("proxy") if self.offline is not None else ""
            password = urlsplit(proxy).password if proxy else None
            if password:
                values.add(password)
        except Exception:
            pass
        secrets = sorted((value for value in values if len(value) >= 8), key=len, reverse=True)
        self._cache = (now, secrets)
        return secrets

    def redact(self, text: str) -> str:
        if not text:
            return text
        for secret in self.known():
            if secret in text:
                text = text.replace(secret, MASK)
        return text

    def redact_value(self, value: object) -> object:
        if isinstance(value, str):
            return self.redact(value)
        if isinstance(value, list):
            return [self.redact_value(item) for item in value]
        if isinstance(value, dict):
            return {key: self.redact_value(item) for key, item in value.items()}
        return value

    def invalidate(self) -> None:
        self._cache = None
