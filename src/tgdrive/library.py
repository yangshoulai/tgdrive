"""媒体库收录规则：文件决定优先于最近一级目录，格式识别与展示偏好相互独立。"""

from __future__ import annotations

import json

from .filekinds import GENERIC_TYPES, kind_of

POLICIES = ("auto", "include", "exclude")
COLLECTIONS = ("included", "excluded", "all")
FOLDER_LIMIT = 200
# 扩展名只补充分不清具体格式的容器；实际图片、视频等具体类型不能被电子书文件名推翻。
BOOK_FORMATS = (
    (("epub",), ("application/epub+zip",), ("application/zip", "application/x-zip-compressed")),
    (("mobi", "azw", "azw3"), ("application/x-mobipocket-ebook", "application/vnd.amazon.ebook"), ()),
    (("fb2",), ("application/x-fictionbook+xml", "application/x-fictionbook"), ("text/plain", "text/xml", "application/xml")),
    (("cbz",), ("application/vnd.comicbook+zip", "application/x-cbz"), ("application/zip", "application/x-zip-compressed")),
    (("cbr",), ("application/vnd.comicbook-rar", "application/x-cbr"), ("application/vnd.rar", "application/x-rar-compressed")),
)
DOCUMENT_FORMATS = ((("pdf",), ("application/pdf",), ()), (("txt",), (), ("text/plain",)))


def book_type(key: str, content_type: str | None, *, documents: bool = False) -> bool:
    mime = (content_type or "").partition(";")[0].strip().lower()
    suffix = key.rpartition(".")[2].lower()
    generic = not mime or mime.startswith(GENERIC_TYPES)
    formats = BOOK_FORMATS + DOCUMENT_FORMATS if documents else BOOK_FORMATS
    return any(mime in mimes or suffix in extensions and (generic or mime in containers)
               for extensions, mimes, containers in formats)


def book_clause(*, documents: bool = False) -> tuple[str, list]:
    """与 book_type 同源的 SQL 条件，仅供媒体库使用，不改变文件管理器的类型。"""
    mime = "lower(trim(substr(coalesce(content_type,'')||';',1,instr(coalesce(content_type,'')||';',';')-1)))"
    generic = f"({mime}='' OR " + " OR ".join(f"{mime} LIKE ?" for _ in GENERIC_TYPES) + ")"
    formats = BOOK_FORMATS + DOCUMENT_FORMATS if documents else BOOK_FORMATS
    clauses, args = [], []
    for extensions, mimes, containers in formats:
        if mimes:
            clauses.append(f"{mime} IN ({','.join('?' for _ in mimes)})")
            args.extend(mimes)
        allowed = generic
        allowed_args = [f"{value}%" for value in GENERIC_TYPES]
        if containers:
            allowed = f"({allowed} OR {mime} IN ({','.join('?' for _ in containers)}))"
            allowed_args.extend(containers)
        clauses.append("((" + " OR ".join("lower(key) LIKE ?" for _ in extensions) + f") AND {allowed})")
        args.extend(f"%.{extension}" for extension in extensions)
        args.extend(allowed_args)
    return "(" + " OR ".join(clauses) + ")", args


def category(key: str, content_type: str | None) -> str | None:
    if book_type(key, content_type, documents=True):
        return "books"
    return {"image": "photos", "video": "videos", "audio": "music"}.get(kind_of(key, content_type))


def load(db, bucket_id: int) -> dict[str, str]:
    row = db.execute("SELECT value FROM settings WHERE key=?", (f"library.folders.{bucket_id}",)).fetchone()
    try:
        value = json.loads(row["value"]) if row else {}
    except (TypeError, ValueError):
        return {}
    if not isinstance(value, dict):
        return {}
    # 系统区的规则暂存于此，目录从回收站或私密空间移回时仍能恢复；网页读取时必须隐藏。
    return {key: policy for key, policy in value.items()
            if isinstance(key, str) and (not key or key.endswith("/")) and policy in ("include", "exclude")}


def store(db, bucket_id: int, rules: dict[str, str]) -> None:
    key = f"library.folders.{bucket_id}"
    if rules:
        db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (key, json.dumps(rules, ensure_ascii=False)))
    else:
        db.execute("DELETE FROM settings WHERE key=?", (key,))


def inherited(rules: dict[str, str], key: str, *, directory: bool = False) -> tuple[str, str | None]:
    matches = [path for path in rules if key.startswith(path) and (directory or key != path)]
    path = max(matches, key=len) if matches else None
    return (rules[path], path) if path is not None else ("auto", None)


def source(rules: dict[str, str], prefix_end: str) -> tuple[str, list]:
    """先生成有效收录策略，再让 SQL 统一筛选、分页、聚合和选封面样本。"""
    args, cases = [], []
    for path in sorted(rules, key=len, reverse=True):
        if path.startswith(".tgdrive/"):
            continue
        cases.append("WHEN x.key>=? AND x.key<? THEN ?")
        args.extend((path, path + prefix_end, rules[path]))
    inherited_sql = "CASE " + " ".join(cases) + " ELSE 'auto' END" if cases else "'auto'"
    return ("(SELECT x.*, coalesce(fm.library_policy,'auto') AS file_library_policy, "
            f"coalesce(nullif(fm.library_policy,'auto'),{inherited_sql}) AS library_policy "
            "FROM objects x LEFT JOIN file_metadata fm ON fm.id=x.metadata_id) o", args)


def moved(db, bucket_id: int, old: str, new: str, moves: dict[str, str], prefix_end: str) -> None:
    rules = load(db, bucket_id)
    updated = dict(rules)
    for path, policy in rules.items():
        if not path.startswith(old) or not any(key.startswith(path) for key in moves):
            continue
        target = new + path[len(old):]
        # 合并目录时保留目的地已有的明确规则；跳过的源文件仍沿用源目录的规则。
        updated.setdefault(target, policy)
        if db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1",
                      (bucket_id, path, path + prefix_end)).fetchone() is None:
            updated.pop(path, None)
    if updated != rules:
        store(db, bucket_id, updated)


def removed(db, bucket_id: int, prefix: str) -> None:
    """永久删除目录时清理对应规则，包括暂存在回收站路径下的规则。"""
    rules = load(db, bucket_id)
    remaining = {path: policy for path, policy in rules.items() if not path.startswith(prefix)}
    if remaining != rules:
        store(db, bucket_id, remaining)
