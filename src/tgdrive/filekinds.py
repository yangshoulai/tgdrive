"""文件类型筛选：把前端 `getFileKind`（web/src/files.tsx）的识别规则翻译成 SQL 条件。

规则按顺序匹配，先命中的类型优先（例如 MIME 是 image/* 的 .txt 算图片），所以某一类的条件是
「命中本类规则且没有命中排在前面的任何规则」。两边的扩展名与 MIME 列表必须保持一致。

类型以内容为准（写入时按内容判断，见 sniff.py）：只有 MIME 缺失或是通用二进制时才按扩展名判断，
具体的 MIME（例如内容是文本的 a.jpg 保存为 text/plain）不会被文件名推翻。例外是同一种容器里看不出音频与视频
（明确的音频扩展名配 video/* 仍算音频），以及文本里按扩展名细分出源代码。
"""

# 扩展名生效的条件：generic 只在 MIME 缺失或通用二进制时；text 另外允许文本类 MIME（细分源代码、字幕等）；
# media 另外允许音视频 MIME（容器相同时按音频扩展名区分）。
_GENERIC = "(coalesce(content_type,'')='' OR lower(content_type) LIKE 'application/octet-stream%' OR lower(content_type) LIKE 'binary/octet-stream%')"
_TEXTUAL_SQL = ("(lower(coalesce(content_type,'')) LIKE 'text/%' OR lower(coalesce(content_type,'')) LIKE 'application/json%'"
                " OR lower(coalesce(content_type,'')) LIKE 'application/%+json%')")
_MEDIA_SQL = "(lower(coalesce(content_type,'')) LIKE 'video/%' OR lower(coalesce(content_type,'')) LIKE 'audio/%')"

def _ext(*names: str) -> list[str]:
    return [f"%.{name}" for name in names]


# (类型, content_type 的 LIKE 模式, key 的 LIKE 模式[, 扩展名生效条件])，顺序与 getFileKind 相同；"stream" 对应它把 MPEG-TS 归为“其他”的那一步。
_RULES: list[tuple] = [
    ("image", ["image/%"], _ext("png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico", "heic")),
    ("stream", ["video/mp2t%"], _ext("mts", "m2ts")),
    # 明确的音频扩展名优先于 video/* MIME（来源常把 FLAC、MP3 标成 video/*），与前端 audioName 一致。
    ("audio", [], _ext("mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac"), "media"),
    ("video", ["video/%"], _ext("mp4", "webm", "mov", "mkv", "avi", "m4v", "ogv")),
    ("audio", ["audio/%"], _ext("mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac")),
    ("pdf", ["application/pdf%"], _ext("pdf")),
    # EPUB 电子书归文档（内容是 ZIP，但排在压缩包之前）。
    ("document", ["%wordprocessingml%", "%msword%", "%opendocument.text%", "application/epub%"],
     _ext("doc", "docx", "dot", "dotx", "odt", "rtf", "pages", "wps", "epub")),
    ("spreadsheet", ["%spreadsheetml%", "%ms-excel%", "%opendocument.spreadsheet%"],
     _ext("xls", "xlsx", "xlsm", "xlt", "xltx", "ods", "numbers", "et")),
    ("presentation", ["%presentationml%", "%ms-powerpoint%", "%opendocument.presentation%"],
     _ext("ppt", "pptx", "pot", "potx", "odp", "key", "dps")),
    ("code", [], _ext("js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "go", "rs", "java", "c", "cc", "cpp", "cxx", "h", "hpp",
                      "cs", "sh", "bash", "zsh", "ps1", "bat", "htm", "html", "css", "scss", "sass", "less", "vue", "svelte",
                      "sql", "rb", "php", "swift", "kt", "kts", "scala", "dart", "gradle", "lua", "diff", "patch")
     + ["dockerfile", "%/dockerfile", "makefile", "%/makefile"], "text"),
    ("text", ["text/%", "application/json%", "application/%+json%"],
     _ext("md", "markdown", "mdx", "rst", "txt", "json", "jsonc", "jsonl", "ndjson", "geojson", "ipynb", "csv", "tsv", "log", "xml", "yml", "yaml", "toml", "ini",
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


_WHEN = {"generic": _GENERIC, "text": f"({_GENERIC} OR {_TEXTUAL_SQL})", "media": f"({_GENERIC} OR {_MEDIA_SQL})"}


def _rule(rule: tuple) -> tuple[str, list[str], list[str], str]:
    name, mimes, keys, *rest = rule
    return name, mimes, keys, rest[0] if rest else "generic"


def _match(mimes: list[str], keys: list[str], when: str = "generic") -> tuple[str, list[str]]:
    parts = ["lower(coalesce(content_type,'')) LIKE ?"] * len(mimes)
    if keys:
        parts.append(f"({_WHEN[when]} AND (" + " OR ".join(["lower(key) LIKE ?"] * len(keys)) + "))")
    return "(" + " OR ".join(parts) + ")", [*mimes, *keys]


def kind_clause(kind: str) -> tuple[str, list[str]]:
    """返回 (SQL 条件, 参数)，用于 objects 表。kind 可以是逗号分隔的多个筛选项（取并集，例如 "image,video"）；
    含未知筛选项时抛 ValueError（400）。"""
    names = [item.strip() for item in kind.split(",") if item.strip()]
    if not names or len(names) > len(KIND_GROUPS) or any(name not in KIND_GROUPS for name in names):
        raise ValueError("未知的文件类型筛选")
    wanted = set().union(*(KIND_GROUPS[name] for name in names))
    clauses, params, earlier = [], [], []
    for name, mimes, keys, when in map(_rule, _RULES):
        sql, args = _match(mimes, keys, when)
        if name in wanted:
            if earlier:
                clauses.append(f"({sql} AND NOT ({' OR '.join(part for part, _ in earlier)}))")
                params += args + [value for _, values in earlier for value in values]
            else:
                clauses.append(sql)
                params += args
        earlier.append((sql, args))
    return "(" + " OR ".join(clauses) + ")", params


def kind_case() -> tuple[str, list[str]]:
    """返回 (SQL CASE 表达式, 参数)：把对象归入界面上的筛选组（image/video/audio/document/text/archive），
    其余归为 other。按规则顺序先命中优先，与 kind_clause 和前端 getFileKind 一致，用于目录统计的 GROUP BY。"""
    group_of = {name: group for group, names in KIND_GROUPS.items() for name in names}
    branches, params = [], []
    for name, mimes, keys, when in map(_rule, _RULES):
        sql, args = _match(mimes, keys, when)
        branches.append(f"WHEN {sql} THEN ?")
        params += [*args, group_of.get(name, "other")]
    return "CASE " + " ".join(branches) + " ELSE 'other' END", params


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
    generic = not mime or mime.startswith(("application/octet-stream", "binary/octet-stream"))
    textual = mime.startswith(("text/", "application/json")) or (mime.startswith("application/") and "+json" in mime)
    allowed = {"generic": generic, "text": generic or textual,
               "media": generic or mime.startswith(("video/", "audio/"))}
    for rule, mimes, keys, when in map(_rule, _RULES):
        if any(_like(mime, pattern) for pattern in mimes) or allowed[when] and any(_like(name, pattern) for pattern in keys):
            return next((group for group, members in KIND_GROUPS.items() if rule in members), None)
    return None


# 音频扩展名对应的标准 MIME。Safari／iOS（包括 iOS 上的 Chrome）按响应的 Content-Type 判断 <audio> 能否播放，
# 不像桌面 Chrome 那样嗅探内容：存成 video/x-flac、application/octet-stream 或 audio/x-flac 等别名的音乐会直接播放失败。
AUDIO_TYPES = {"flac": "audio/flac", "mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav",
               "ogg": "audio/ogg", "oga": "audio/ogg", "opus": "audio/ogg"}


def served_type(key: str, content_type: str | None) -> str:
    """响应与保存用的 MIME：明确的音频扩展名在来源没给、给了通用二进制、video/* 或非标准音频别名时改用标准音频类型；
    其余原样返回（与 web/src/cache-store.ts 的 servedType 一致）。"""
    current = (content_type or "application/octet-stream").split(";", 1)[0].strip().lower()
    extension = key.rsplit(".", 1)[-1].lower() if "." in key.rsplit("/", 1)[-1] else ""
    standard = AUDIO_TYPES.get(extension)
    if standard and current != standard and (current == "application/octet-stream" or current.startswith("video/")
                                             or current.startswith("audio/") and current not in AUDIO_TYPES.values()):
        return standard
    return current
