"""文件类型筛选：把前端 `getFileKind`（web/src/files.tsx）的识别规则翻译成 SQL 条件。

规则按顺序匹配，先命中的类型优先（例如 MIME 是 image/* 的 .txt 算图片），所以某一类的条件是
「命中本类规则且没有命中排在前面的任何规则」。两边的扩展名与 MIME 列表必须保持一致。
"""

def _ext(*names: str) -> list[str]:
    return [f"%.{name}" for name in names]


# (类型, content_type 的 LIKE 模式, key 的 LIKE 模式)，顺序与 getFileKind 相同；"stream" 对应它把 MPEG-TS 归为“其他”的那一步。
_RULES: list[tuple[str, list[str], list[str]]] = [
    ("image", ["image/%"], _ext("png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico", "heic")),
    ("stream", ["video/mp2t%"], _ext("mts", "m2ts")),
    ("video", ["video/%"], _ext("mp4", "webm", "mov", "mkv", "avi", "m4v", "ogv")),
    ("audio", ["audio/%"], _ext("mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac")),
    ("pdf", ["application/pdf%"], _ext("pdf")),
    ("document", ["%wordprocessingml%", "%msword%", "%opendocument.text%"],
     _ext("doc", "docx", "dot", "dotx", "odt", "rtf", "pages", "wps")),
    ("spreadsheet", ["%spreadsheetml%", "%ms-excel%", "%opendocument.spreadsheet%"],
     _ext("xls", "xlsx", "xlsm", "xlt", "xltx", "ods", "numbers", "et")),
    ("presentation", ["%presentationml%", "%ms-powerpoint%", "%opendocument.presentation%"],
     _ext("ppt", "pptx", "pot", "potx", "odp", "key", "dps")),
    ("code", [], _ext("js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "go", "rs", "java", "c", "cc", "cpp", "cxx", "h", "hpp",
                      "cs", "sh", "bash", "zsh", "ps1", "bat", "htm", "html", "css", "scss", "sass", "less", "vue", "svelte",
                      "sql", "rb", "php", "swift", "kt", "kts", "scala", "dart", "gradle", "lua", "diff", "patch")
     + ["dockerfile", "%/dockerfile", "makefile", "%/makefile"]),
    ("text", ["text/%", "application/json%"],
     _ext("md", "markdown", "mdx", "rst", "txt", "json", "jsonc", "csv", "tsv", "log", "xml", "yml", "yaml", "toml", "ini",
          "conf", "cfg", "properties", "env", "gitignore", "editorconfig", "lrc", "srt", "vtt")
     + [".env", "%/.env", ".env.%", "%/.env.%"]),
    ("archive", ["%zip%", "%compressed%", "%x-tar%"],
     _ext("zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "dmg", "iso")),
]

# 界面上的筛选项：文档合并 PDF／文档／表格／演示文稿，文本合并纯文本与源代码。
KIND_GROUPS: dict[str, set[str]] = {
    "image": {"image"}, "video": {"video"}, "audio": {"audio"},
    "document": {"pdf", "document", "spreadsheet", "presentation"},
    "text": {"text", "code"}, "archive": {"archive"},
}


def _match(mimes: list[str], keys: list[str]) -> tuple[str, list[str]]:
    parts = ["lower(coalesce(content_type,'')) LIKE ?"] * len(mimes) + ["lower(key) LIKE ?"] * len(keys)
    return "(" + " OR ".join(parts) + ")", [*mimes, *keys]


def kind_clause(kind: str) -> tuple[str, list[str]]:
    """返回 (SQL 条件, 参数)，用于 objects 表；kind 不是已知筛选项时抛 ValueError（400）。"""
    if kind not in KIND_GROUPS:
        raise ValueError("未知的文件类型筛选")
    clauses, params, earlier = [], [], []
    for name, mimes, keys in _RULES:
        sql, args = _match(mimes, keys)
        if name in KIND_GROUPS[kind]:
            if earlier:
                clauses.append(f"({sql} AND NOT ({' OR '.join(part for part, _ in earlier)}))")
                params += args + [value for _, values in earlier for value in values]
            else:
                clauses.append(sql)
                params += args
        earlier.append((sql, args))
    return "(" + " OR ".join(clauses) + ")", params


def _like(value: str, pattern: str) -> bool:
    # SQL LIKE 的 Python 版：% 匹配任意串（规则里没有用到 _），比较前统一小写。
    parts = pattern.split("%")
    if len(parts) == 1:
        return value == pattern
    if not value.startswith(parts[0]) or not value.endswith(parts[-1]) or len(value) < len(parts[0]) + len(parts[-1]):
        return False
    position = len(parts[0])
    for middle in parts[1:-1]:
        found = value.find(middle, position, len(value) - len(parts[-1]))
        if found < 0:
            return False
        position = found + len(middle)
    return True


def kind_of(key: str, content_type: str | None) -> str | None:
    """按与 kind_clause 相同的规则判断单个对象属于哪个筛选项（image／video／…），都不属于时返回 None。"""
    mime, name = (content_type or "").lower(), key.lower()
    for rule, mimes, keys in _RULES:
        if any(_like(mime, pattern) for pattern in mimes) or any(_like(name, pattern) for pattern in keys):
            return next((group for group, members in KIND_GROUPS.items() if rule in members), None)
    return None
