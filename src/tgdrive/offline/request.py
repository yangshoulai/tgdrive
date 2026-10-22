"""把链接和命令当作数据解析；不调用 shell、curl 或 wget。"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict, dataclass, field
from urllib.parse import unquote, urlsplit, urlunsplit


@dataclass
class DownloadRequest:
    url: str
    method: str = "GET"
    headers: list[tuple[str, str]] = field(default_factory=list)
    body: str | None = None
    follow_redirects: bool = True
    name: str | None = None
    warnings: list[str] = field(default_factory=list)
    credential_origin: str | None = None

    def json(self):
        return asdict(self)

    @classmethod
    def from_json(cls, value):
        return cls(**value)


def checked_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 16384 or any(ord(c) < 33 or c.isspace() for c in value):
        raise ValueError("下载地址格式不正确")
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError as exc:
        raise ValueError("下载地址或端口不正确") from exc
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("只支持 HTTP 和 HTTPS 文件链接")
    if parts.username is not None or parts.password is not None:
        raise ValueError("链接中不能包含用户名或密码，请使用请求头传递认证信息")
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("下载地址的端口不正确")
    if "\\" in value or "%" in parts.hostname:
        raise ValueError("下载地址的主机名不正确")
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, ""))


def filename(value: str | None, fallback: str = "下载文件") -> str:
    # 外部提供的名称永远只作为文件名，不能带入目标目录或系统保留路径。
    name = unicodedata.normalize("NFC", value or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(c for c in name if ord(c) >= 32 and ord(c) != 127).strip().strip(".")
    if not name or name == ".tgdrive":
        name = fallback
    while len(name.encode("utf-8")) > 220:
        name = name[:-1]
    return name


def url_filename(url: str) -> str:
    return filename(unquote(urlsplit(url).path.rsplit("/", 1)[-1]))


def shell_words(text: str) -> list[list[str]]:
    """只识别 POSIX 引号、续行与 Bash ANSI-C 字符串，拒绝 shell 操作。"""
    commands, words, current = [], [], []
    quote, active, index = "", False, 0
    while index < len(text):
        char = text[index]
        if quote == "'":
            if char == "'":
                quote = ""
            else:
                current.append(char)
        elif quote == "ansi":
            if char == "'":
                quote = ""
            elif char == "\\":
                index += 1
                if index >= len(text):
                    raise ValueError("命令中的转义不完整")
                escaped = text[index]
                escapes = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\", "'": "'", '"': '"'}
                if escaped in escapes:
                    current.append(escapes[escaped])
                elif escaped in ("x", "u", "U"):
                    count = {"x": 2, "u": 4, "U": 8}[escaped]
                    digits = text[index + 1:index + 1 + count]
                    if len(digits) != count or not re.fullmatch(r"[0-9a-fA-F]+", digits):
                        raise ValueError("不支持这个命令转义，请复制 bash 格式的 curl 命令")
                    try:
                        current.append(chr(int(digits, 16)))
                    except ValueError as exc:
                        raise ValueError("命令中的字符转义不正确") from exc
                    index += count
                else:
                    raise ValueError("不支持这个命令转义，请复制 bash 格式的 curl 命令")
            else:
                current.append(char)
        elif quote == '"':
            if char == '"':
                quote = ""
            elif char in ("$", "`"):
                raise ValueError("不支持变量或命令替换，请粘贴完整的请求参数")
            elif char == "\\" and index + 1 < len(text):
                following = text[index + 1]
                if following in ('"', "\\", "$", "`", "\n"):
                    index += 1
                    if following != "\n":
                        current.append(following)
                else:
                    current.append(char)
            else:
                current.append(char)
        elif char == "$" and text[index:index + 2] == "$'":
            quote, active = "ansi", True
            index += 1
        elif char in ("'", '"'):
            quote, active = char, True
        elif char == "\\":
            index += 1
            if index >= len(text):
                raise ValueError("命令中的转义不完整")
            if text[index] != "\n":
                current.append(text[index])
                active = True
        elif char in "$`;|&<>()":
            raise ValueError("不支持 shell 操作符、变量、管道或命令替换")
        elif char.isspace():
            if active:
                words.append("".join(current))
                current, active = [], False
            if char == "\n" and words:
                commands.append(words)
                words = []
        else:
            current.append(char)
            active = True
        index += 1
    if quote:
        raise ValueError("命令中的引号没有闭合")
    if active:
        words.append("".join(current))
    if words:
        commands.append(words)
    return commands


_REMOVED = {"range", "if-range", "if-none-match", "if-modified-since"}
_FORBIDDEN = {"host", "connection", "content-length", "transfer-encoding", "expect", "upgrade", "te", "trailer", "proxy-authorization", "proxy-connection"}


def _command(words: list[str]) -> list[DownloadRequest]:
    if not words or words[0] not in ("curl", "wget"):
        raise ValueError("请粘贴 HTTP(S) 链接，或 curl／wget 命令（bash 格式）")
    curl = words[0] == "curl"
    urls, headers, bodies, warnings = [], [], [], []
    method, name, follow = None, None, not curl
    value_options = ({"-H": "header", "--header": "header", "-b": "cookie", "--cookie": "cookie", "-A": "agent", "--user-agent": "agent", "-e": "referer", "--referer": "referer", "-X": "method", "--request": "method", "-d": "data", "--data": "data", "--data-raw": "raw", "--data-binary": "data", "--url": "url", "-o": "name", "--output": "name"} if curl else
                     {"--header": "header", "--user-agent": "agent", "-U": "agent", "--referer": "referer", "--method": "method", "--post-data": "raw", "-O": "name", "--output-document": "name"})
    harmless = ({"-s", "--silent", "-S", "--show-error", "-f", "--fail", "--fail-with-body", "-g", "--globoff", "--no-progress-meter", "--http1.1", "-O", "--remote-name"} if curl else {"-q", "--quiet", "--no-verbose", "-nv", "--content-disposition"})
    index = 1
    while index < len(words):
        word = words[index]
        if word.startswith(("https://", "http://")):
            urls.append(checked_url(word))
        elif word == "--":
            urls.extend(checked_url(item) for item in words[index + 1:])
            break
        elif curl and word in ("-L", "--location"):
            follow = True
        elif curl and word == "--compressed":
            headers.append(("Accept-Encoding", "gzip, deflate"))
        elif word in harmless or (curl and re.fullmatch(r"-[sSfLgO]{2,}", word)):
            if "L" in word:
                follow = True
        else:
            option, separator, value = word.partition("=") if word.startswith("--") else (word, "", "")
            if option not in value_options and word.startswith("-") and not word.startswith("--") and word[:2] in value_options:
                option, separator, value = word[:2], "=", word[2:]
            if option not in value_options:
                # 错误不能回显参数值，其中可能包含密码、代理口令或签名。
                raise ValueError("命令包含不支持的参数；仅支持请求头、Cookie、方法、文本请求体、重定向和输出文件名，不支持代理、本地文件、下载脚本或关闭证书验证")
            if not separator:
                index += 1
                if index >= len(words):
                    raise ValueError("命令参数缺少值")
                value = words[index]
            kind = value_options[option]
            if kind == "header":
                key, colon, content = value.partition(":")
                if not colon:
                    raise ValueError("请求头必须使用 名称: 值 的格式")
                headers.append((key.strip(), content.strip()))
            elif kind == "cookie":
                if "=" not in value or value.startswith("@"):
                    raise ValueError("Cookie 只接受文本值，不读取本地 Cookie 文件")
                headers.append(("Cookie", value))
            elif kind in ("agent", "referer"):
                headers.append(("User-Agent" if kind == "agent" else "Referer", value))
            elif kind == "method":
                method = value.upper()
            elif kind in ("data", "raw"):
                if kind == "data" and value.startswith("@"):
                    raise ValueError("不读取本地请求体文件，请使用 --data-raw 文本")
                bodies.append(value)
            elif kind == "url":
                urls.append(checked_url(value))
            elif kind == "name":
                name = filename(value)
        index += 1
    if not urls:
        raise ValueError("命令没有包含下载地址")
    method = method or ("POST" if bodies else "GET")
    if method not in ("GET", "POST") or (method == "GET" and bodies):
        raise ValueError("只支持 GET 下载及带文本请求体的 POST 下载")
    body = "&".join(bodies) if bodies else None
    if body is not None and len(body.encode()) > 65536:
        raise ValueError("文本请求体不能超过 64 KB")
    normalized = []
    for key, value in headers:
        if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", key) or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("请求头包含不合法的名称或控制字符")
        try:
            value.encode("latin-1")
        except UnicodeEncodeError as exc:
            raise ValueError("请求头必须符合 HTTP 字符编码") from exc
        lowered = key.lower()
        if lowered in _FORBIDDEN:
            raise ValueError("不支持覆盖连接、主机或请求长度等传输请求头")
        if lowered in _REMOVED:
            warnings.append(f"已移除 {key}：任务会下载完整文件，续传由下载器管理")
            continue
        if lowered == "accept-encoding":
            if value != "gzip, deflate":
                warnings.append("压缩响应只使用 gzip／deflate；其他压缩格式不会请求")
            value = "gzip, deflate"
            warnings.append("下载时优先请求未压缩内容以支持续传；来源仍返回压缩内容时流式解压")
        normalized.append((key, value))
    if len(normalized) > 100 or sum(len(k) + len(v) for k, v in normalized) > 32768:
        raise ValueError("请求头过多或超过 32 KB")
    if body is not None and not any(k.lower() == "content-type" for k, _ in normalized):
        normalized.append(("Content-Type", "application/x-www-form-urlencoded"))
    return [DownloadRequest(url, method, list(normalized), body, follow, name, list(dict.fromkeys(warnings))) for url in urls]


def _quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def command_text(request: DownloadRequest) -> str:
    """把已保存的请求还原成 parse_requests 能解析回同一请求的文本（bash 单引号）。没有额外参数的 GET 只给出链接。"""
    if request.method == "GET" and not request.headers and request.body is None and request.follow_redirects and not request.name:
        return request.url
    words = ["curl " + _quote(request.url)]
    if request.follow_redirects:
        words.append("-L")
    if request.method == "POST" and request.body is None:
        words.append("-X POST")
    words.extend("-H " + _quote(f"{key}: {value}") for key, value in request.headers)
    if request.body is not None:
        words.append("--data-raw " + _quote(request.body))
    if request.name:
        words.append("-o " + _quote(request.name))
    return " \\\n  ".join(words)


def parse_requests(text: str, *, max_urls: int = 32) -> list[DownloadRequest]:
    if isinstance(max_urls, bool) or not isinstance(max_urls, int) or max_urls < 0:
        raise ValueError("链接数量上限必须为非负整数")
    if not isinstance(text, str) or not text.strip() or len(text.encode()) > 262144:
        raise ValueError("请输入链接或命令，内容最多 256 KB")
    text = text.strip().replace("\r\n", "\n")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if all(line.startswith(("https://", "http://")) for line in lines):
        requests = [DownloadRequest(checked_url(line)) for line in lines]
    else:
        requests = [request for words in shell_words(text) for request in _command(words)]
    if not requests:
        raise ValueError("请提供文件链接")
    if max_urls and len(requests) > max_urls:
        raise ValueError(f"一次最多解析 {max_urls} 个文件链接")
    return requests
