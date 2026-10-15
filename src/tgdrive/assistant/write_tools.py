"""提议写入工具（docs/assistant-design.md §7.3）。

这些工具从不直接修改文件：它们把规则展开成具体条目（含对象版本），通过 ctx.propose 生成「待确认操作」，
由用户在界面卡片上确认后才由 actions.ActionExecutor 执行。模型拿到的只是编号、条目数、冲突数和前 20 条样例。
"""

from __future__ import annotations

import fnmatch
import re
from datetime import datetime

from ..api import normalize_user_path
from ..filekinds import kind_clause, kind_of
from .actions import KINDS, directory_version
from .tools import (
    END,
    KIND,
    KIND_LABELS,
    PATH,
    ToolContext,
    ToolError,
    ToolOutput,
    _fmt,
    _int,
    _regex,
    _str,
    _thread,
    tool,
)

SCAN_LIMIT = 50000
NAME_BYTES = 220

MATCH = {"type": "object", "description": "匹配条件：path 为目录（省略为作用域根），其余条件取交集，只匹配文件",
         "properties": {"path": PATH, "glob": {"type": "string", "description": "文件名通配符，如 IMG_*.jpg"},
                        "regex": {"type": "string", "description": "文件名正则（不区分大小写），分组可在模板中用 {1}{2} 引用"},
                        "kind": KIND, "ext": {"type": "array", "items": {"type": "string"}, "description": "扩展名列表"},
                        "recursive": {"type": "boolean", "description": "是否包含子目录，默认 false"}}}
CONFLICT = {"type": "string", "enum": ["skip", "suffix"], "description": "目标重名时：skip 跳过（默认），suffix 自动加 (1)(2)"}


# ---------- 公共辅助 ----------

def _name_of(key: str) -> str:
    return key.rstrip("/").rsplit("/", 1)[-1]


def _parent_of(key: str) -> str:
    stripped = key.rstrip("/")
    return stripped.rsplit("/", 1)[0] + "/" if "/" in stripped else ""


def _check_name(name: str) -> str:
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise ToolError(f"新名称 {name!r} 不合法：不能为空，也不能包含 /")
    if any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise ToolError("新名称不能包含控制字符")
    if len(name.encode()) > NAME_BYTES:
        raise ToolError(f"新名称 {name[:40]}… 超过 {NAME_BYTES} 字节")
    return name


def _valid_key(key: str) -> str:
    try:
        return normalize_user_path(key, directory=key.endswith("/"))
    except (PermissionError, ValueError) as exc:
        raise ToolError(f"路径 /{key} 不合法") from exc


def _match_rows(ctx: ToolContext, match: object, *, limit: int) -> list:
    if not isinstance(match, dict):
        raise ToolError("参数 match 不正确：需要对象")
    unknown = set(match) - {"path", "glob", "regex", "kind", "ext", "recursive"}
    if unknown:
        raise ToolError(f"参数 match 不支持 {', '.join(sorted(unknown))}")
    prefix = ctx.resolve(match.get("path"), directory=True)
    glob = _str(match, "glob", limit=100)
    pattern = _regex(_str(match, "regex", limit=100)) if match.get("regex") else None
    where = ["bucket_id=? AND key>? AND key<? AND substr(key,-1)!='/' AND substr(key,1,9)!='.tgdrive/'"]
    params: list = [ctx.bucket_id, prefix, prefix + END]
    if not match.get("recursive"):
        where.append("instr(substr(key,?),'/')=0")
        params.append(len(prefix) + 1)
    if match.get("kind"):
        try:
            clause, args = kind_clause(match["kind"])
        except ValueError as exc:
            raise ToolError("参数 kind 不正确") from exc
        where.append(clause)
        params += args
    ext = match.get("ext")
    if ext:
        if not isinstance(ext, list) or len(ext) > 20 or not all(isinstance(e, str) and 0 < len(e) <= 16 for e in ext):
            raise ToolError("参数 ext 不正确")
        where.append("(" + " OR ".join("lower(key) LIKE ?" for _ in ext) + ")")
        params += [f"%.{e.lower().lstrip('.')}" for e in ext]

    def read():
        rows = []
        for row in ctx.db.execute(f"SELECT * FROM objects WHERE {' AND '.join(where)} ORDER BY key LIMIT ?", (*params, SCAN_LIMIT + 1)):
            name = _name_of(row["key"])
            if glob and not fnmatch.fnmatch(name.lower(), glob.lower()):
                continue
            if pattern is not None and not pattern.search(name):
                continue
            rows.append(row)
            if len(rows) > limit:
                break
        return rows

    return read


async def _rows(ctx: ToolContext, match: object, limit: int) -> list:
    rows = await _thread(ctx, _match_rows(ctx, match, limit=limit))
    if len(rows) > limit:
        raise ToolError(f"匹配超过 {limit} 项，超过单次上限，请缩小范围（指定子目录、类型或时间）。")
    return rows


def _item_limit(ctx: ToolContext) -> int:
    return int(ctx.limits.get("action_items", 10000))


class Targets:
    """冻结时为每个目标分配位置：已存在或本次已占用的目标按冲突策略跳过或加序号。"""

    def __init__(self, ctx: ToolContext, conflict: str) -> None:
        self.ctx, self.conflict, self.reserved = ctx, conflict, set()
        if conflict not in ("skip", "suffix"):
            raise ToolError("参数 conflict 不正确：可选 skip 或 suffix")

    def taken(self, key: str) -> bool:
        if key in self.reserved:
            return True
        if key.endswith("/"):
            return self.ctx.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1",
                                       (self.ctx.bucket_id, key, key + END)).fetchone() is not None
        return self.ctx.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND (key=? OR key=?)",
                                   (self.ctx.bucket_id, key, key + "/")).fetchone() is not None

    def claim(self, key: str) -> str | None:
        if not self.taken(key):
            self.reserved.add(key)
            return key
        if self.conflict == "skip":
            return None
        folder = key.endswith("/")
        stem_key = key.rstrip("/")
        directory, _, name = stem_key.rpartition("/")
        base, dot, ext = name.rpartition(".")
        if folder or not dot or not base:
            base, dot, ext = name, "", ""
        for n in range(1, 1000):
            candidate = f"{directory}{'/' if directory else ''}{base} ({n}){dot}{ext}" + ("/" if folder else "")
            if not self.taken(candidate):
                self.reserved.add(candidate)
                return candidate
        return None


def _move_item(row) -> dict:
    return {"from": row["key"], "to": None, "folder": row["key"].endswith("/"), "etag": row["etag"], "modified_at": row["modified_at"],
            "directory_version": row.get("directory_version") if isinstance(row, dict) else None, "size": int(row["size"] or 0)}


async def _propose(ctx: ToolContext, kind: str, items: list[dict], *, skipped: list[dict], summary: str, options: dict | None = None,
                   danger: bool = False, sample=None) -> ToolOutput:
    if ctx.propose is None:
        raise ToolError("当前无法生成待确认操作")
    if not items:
        reason = "；".join(f"{entry['path']}：{entry['reason']}" for entry in skipped[:5])
        raise ToolError("没有需要执行的条目" + (f"（{reason}{' 等' if len(skipped) > 5 else ''}）" if reason else "，请确认范围是否正确"))
    limit = _item_limit(ctx)
    if len(items) > limit:
        raise ToolError(f"匹配 {len(items)} 项，超过单次上限 {limit}，请缩小范围（指定子目录、类型或时间）。")
    size = sum(int(item.get("size") or 0) for item in items)
    payload = {"kind": kind, "title": KINDS[kind], "scope": ctx.scope_root, "items": items, "skipped": skipped[:200],
               "conflicts": len(skipped), "size": size, "danger": danger, "summary": summary, "options": options or {}}
    created = await ctx.propose(kind, payload, len(items))
    describe = sample or (lambda item: str(item))
    samples = [describe(item) for item in items[:20]]
    return ToolOutput({"action_id": created["action_id"], "kind": kind, "count": len(items), "conflicts": len(skipped),
                       "samples": samples, "expires_at": datetime.fromtimestamp(created["expires_at"]).isoformat(timespec="seconds"),
                       "status": "已生成待确认操作，等待用户在界面卡片上确认；确认前不会执行任何修改"},
                      f"{summary}（待确认）", items=len(items),
                      event={"type": "action", "action_id": created["action_id"], "kind": kind, "count": len(items)})


def _arrow(item: dict) -> str:
    return f"/{item['from']} → /{item['to']}"


# ---------- 改名 ----------

_VAR = re.compile(r"\{([a-z0-9]+)(?::([^{}]{1,30}))?\}")


def render_name(template: str, row, n: int, groups: tuple) -> str:
    name = _name_of(row["key"])
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, ext = name, ""
    extension = f".{ext}" if ext else ""
    parent = _name_of(_parent_of(row["key"])) if _parent_of(row["key"]) else ""

    def replace(match: re.Match) -> str:
        var, spec = match[1], match[2]
        if var == "n":
            try:
                return format(n, spec or "")
            except ValueError as exc:
                raise ToolError(f"模板变量 {{n:{spec}}} 的格式不正确，示例 {{n:03}}") from exc
        if var == "mtime":
            if spec and not re.fullmatch(r"[%A-Za-z0-9 _.\-]+", spec):
                raise ToolError("mtime 的格式只能包含 %Y %m %d %H %M %S 与 - _ . 空格")
            return datetime.fromtimestamp(row["modified_at"]).strftime(spec or "%Y-%m-%d")
        if spec:
            raise ToolError(f"模板变量 {{{var}}} 不支持格式")
        if var == "name":
            return name
        if var == "stem":
            return stem
        if var == "ext":
            return extension
        if var == "parent":
            return parent
        if var.isdigit():
            index = int(var)
            if not 1 <= index <= len(groups):
                raise ToolError(f"模板引用了 {{{var}}}，但 regex 没有第 {index} 个分组")
            return groups[index - 1] or ""
        raise ToolError(f"未知的模板变量 {{{var}}}；可用 name stem ext n parent mtime 与正则分组 1–9")

    return _VAR.sub(replace, template)


@tool("propose_rename", "批量改名", "write", "write",
      "生成批量改名的待确认操作，不会立即执行，也不能跨目录（移动请用 propose_move）。\n"
      "- 规则模式：match 指定范围，template 指定新文件名。可用变量：{name} 原文件名、{stem} 不含扩展名、{ext} 含点的扩展名、"
      "{n} 序号（{n:03} 补零，按 sort 排序后从 start 开始）、{parent} 所在目录名、{mtime:%Y-%m-%d} 修改时间、{1}{2} match.regex 的分组。\n"
      "- 映射模式：mapping 为 [{from, to}]，最多 200 项，from 为文件路径，to 只能是新文件名。\n"
      "返回待确认操作的编号、条目数、冲突数和前 20 条样例。",
      {"match": MATCH, "template": {"type": "string", "description": "新文件名模板，如 {mtime:%Y%m%d}_{n:03}{ext}"},
       "mapping": {"type": "array", "items": {"type": "object", "properties": {"from": {"type": "string"}, "to": {"type": "string"}},
                                              "required": ["from", "to"]}, "description": "逐个指定新名称（≤200 项）"},
       "sort": {"type": "string", "enum": ["name", "mtime"], "description": "{n} 的排序依据，默认 name"},
       "start": {"type": "integer", "description": "{n} 的起始值，默认 1"}, "conflict": CONFLICT})
async def propose_rename(ctx: ToolContext, args: dict) -> ToolOutput:
    targets = Targets(ctx, args.get("conflict") or "skip")
    items, skipped = [], []
    mapping, template = args.get("mapping"), _str(args, "template", limit=200)
    if bool(mapping) == bool(template):
        raise ToolError("请在 template（规则模式）与 mapping（映射模式）中二选一")
    if mapping:
        if not isinstance(mapping, list) or not 1 <= len(mapping) <= 200:
            raise ToolError("参数 mapping 需要 1–200 项")
        sources = []
        for entry in mapping:
            if not isinstance(entry, dict) or not isinstance(entry.get("from"), str) or not isinstance(entry.get("to"), str):
                raise ToolError("mapping 的每一项需要 from 与 to")
            key = ctx.resolve(entry["from"])
            if not key or key.endswith("/"):
                raise ToolError("mapping.from 必须是文件路径")
            sources.append((key, _check_name(entry["to"].strip())))
        rows = {row["key"]: row for row in ctx.db.execute(
            f"SELECT * FROM objects WHERE bucket_id=? AND key IN ({','.join('?' * len(sources))})",
            (ctx.bucket_id, *[key for key, _ in sources]))}
        plan = []
        for key, name in sources:
            row = rows.get(key)
            if row is None:
                skipped.append({"path": ctx.display(key), "reason": "文件不存在"})
                continue
            plan.append((row, name))
    else:
        rows = await _rows(ctx, args.get("match") or {}, _item_limit(ctx))
        if (args.get("sort") or "name") == "mtime":
            rows.sort(key=lambda row: (row["modified_at"], row["key"]))
        elif args.get("sort") not in (None, "name"):
            raise ToolError("参数 sort 不正确")
        start = _int(args, "start", 1, 0, 10**9)
        pattern = _regex(_str(args["match"], "regex", limit=100)) if isinstance(args.get("match"), dict) and args["match"].get("regex") else None
        plan = []
        for index, row in enumerate(rows):
            groups = pattern.search(_name_of(row["key"])).groups() if pattern else ()
            plan.append((row, _check_name(render_name(template, row, start + index, groups).strip())))
    for row, name in plan:
        source = row["key"]
        target = _parent_of(source) + name
        if target == source:
            continue
        _valid_key(target)
        claimed = targets.claim(target)
        if claimed is None:
            skipped.append({"path": ctx.display(source), "reason": f"{name} 已存在"})
            continue
        items.append({**_move_item(row), "to": claimed})
    return await _propose(ctx, "rename", items, skipped=skipped, sample=_arrow,
                          summary=f"重命名 {len(items)} 个文件" + (f"，{len(skipped)} 项重名将跳过" if skipped else ""))


# ---------- 移动与整理 ----------

def _source_rows(ctx: ToolContext, paths: object) -> tuple[list, list]:
    """把路径列表解析成对象行：文件按键精确匹配，文件夹（以 / 结尾或存在同名前缀）作为整体。"""
    if not isinstance(paths, list) or not 1 <= len(paths) <= 1000:
        raise ToolError("参数 paths/sources 需要 1–1000 个路径")
    rows, missing = [], []
    for value in paths:
        key = ctx.resolve(value)
        if not key:
            raise ToolError("不能对整个空间整体操作，请指定具体的文件或文件夹")
        if key == ctx.scope_root:
            raise ToolError("不能对作用域根目录本身操作，请指定其中的文件或文件夹")
        row = None if key.endswith("/") else ctx.db.execute("SELECT * FROM objects WHERE bucket_id=? AND key=?",
                                                           (ctx.bucket_id, key)).fetchone()
        if row is not None:
            rows.append(row)
            continue
        folder = key if key.endswith("/") else key + "/"
        exists = ctx.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1",
                                (ctx.bucket_id, folder, folder + END)).fetchone()
        if exists is None:
            missing.append({"path": ctx.display(key), "reason": "不存在"})
            continue
        version, count = directory_version(ctx.db, ctx.bucket_id, folder, limit=_item_limit(ctx))
        if count > _item_limit(ctx):
            raise ToolError(f"文件夹 {ctx.display(folder)} 超过单次上限，请指定更小的目录")
        stats = ctx.db.execute("SELECT COALESCE(SUM(size),0) FROM objects WHERE bucket_id=? AND key>=? AND key<?",
                               (ctx.bucket_id, folder, folder + END)).fetchone()
        rows.append({"key": folder, "etag": None, "directory_version": version, "size": int(stats[0]), "modified_at": None, "content_type": None})
    return rows, missing


@tool("propose_move", "移动", "write", "write",
      "生成把文件或文件夹移动到目标目录的待确认操作，不会立即执行。sources 与 match 二选一；不能把文件夹移入它自己的子目录。",
      {"sources": {"type": "array", "items": {"type": "string"}, "description": "要移动的文件或文件夹路径（≤1000 个）"},
       "match": MATCH, "target": {"type": "string", "description": "目标目录，不存在时自动创建"}, "conflict": CONFLICT},
      ("target",))
async def propose_move(ctx: ToolContext, args: dict) -> ToolOutput:
    target_dir = ctx.resolve(_str(args, "target", limit=1024) or None, directory=True)
    targets = Targets(ctx, args.get("conflict") or "skip")
    if bool(args.get("sources")) == bool(args.get("match")):
        raise ToolError("请在 sources 与 match 中二选一")
    if args.get("sources"):
        rows, skipped = _source_rows(ctx, args["sources"])
    else:
        rows, skipped = await _rows(ctx, args["match"], _item_limit(ctx)), []
    items = []
    for row in rows:
        source = row["key"]
        if source.endswith("/") and target_dir.startswith(source):
            skipped.append({"path": ctx.display(source), "reason": "不能移入它自己的子目录"})
            continue
        if _parent_of(source) == target_dir:
            continue
        target = target_dir + _name_of(source) + ("/" if source.endswith("/") else "")
        _valid_key(target)
        claimed = targets.claim(target)
        if claimed is None:
            skipped.append({"path": ctx.display(source), "reason": "目标已存在同名项目"})
            continue
        items.append({**_move_item(row), "to": claimed})
    size = sum(item["size"] for item in items)
    return await _propose(ctx, "move", items, skipped=skipped, sample=_arrow,
                          summary=f"移动 {len(items)} 项（{_fmt(size)}）到 {ctx.display(target_dir)}"
                          + (f"，{len(skipped)} 项将跳过" if skipped else ""))


@tool("propose_organize", "整理文件", "write", "write",
      "按规则把目录中的文件归类到子文件夹，生成待确认操作，不会立即执行。by：kind 按类型（图片、视频…）、ext 按扩展名、"
      "year 按修改年份、month 按修改年月（YYYY-MM）、mapping 按扩展名映射到指定文件夹（mapping 形如 {\"jpg\":\"照片\",\"*\":\"其他\"}，"
      "没有 * 时未映射的文件保持不动）。target 为放置子文件夹的目录，默认就是 path。",
      {"path": PATH, "by": {"type": "string", "enum": ["kind", "ext", "year", "month", "mapping"]},
       "mapping": {"type": "object", "additionalProperties": {"type": "string"}, "description": "扩展名 → 文件夹名"},
       "target": {"type": "string", "description": "放置子文件夹的目录，默认与 path 相同"},
       "recursive": {"type": "boolean", "description": "是否包含子目录中的文件，默认 false"},
       "kind": KIND, "conflict": CONFLICT}, ("by",))
async def propose_organize(ctx: ToolContext, args: dict) -> ToolOutput:
    by = args.get("by")
    if by not in ("kind", "ext", "year", "month", "mapping"):
        raise ToolError("参数 by 不正确")
    path = ctx.resolve(args.get("path"), directory=True)
    base = ctx.resolve(_str(args, "target", limit=1024) or args.get("path"), directory=True)
    mapping = args.get("mapping") or {}
    if by == "mapping":
        if not isinstance(mapping, dict) or not 1 <= len(mapping) <= 100:
            raise ToolError("参数 mapping 需要 1–100 项")
        mapping = {str(key).lower().lstrip("."): _check_name(str(value).strip().strip("/")) for key, value in mapping.items()}
    rows = await _rows(ctx, {"path": ctx.display(path), "recursive": bool(args.get("recursive")),
                             **({"kind": args["kind"]} if args.get("kind") else {})}, _item_limit(ctx))
    targets = Targets(ctx, args.get("conflict") or "skip")
    items, skipped, folders = [], [], set()
    for row in rows:
        name = _name_of(row["key"])
        ext = name.rsplit(".", 1)[-1].lower() if "." in name.strip(".") else ""
        if by == "kind":
            group = KIND_LABELS.get(kind_of(row["key"], row["content_type"]) or "", "其他")
        elif by == "ext":
            group = ext.upper() if ext else "无扩展名"
        elif by == "year":
            group = datetime.fromtimestamp(row["modified_at"]).strftime("%Y")
        elif by == "month":
            group = datetime.fromtimestamp(row["modified_at"]).strftime("%Y-%m")
        else:
            group = mapping.get(ext) or mapping.get("*")
            if not group:
                continue
        folder = base + group + "/"
        if _parent_of(row["key"]) == folder:
            continue
        target = folder + name
        _valid_key(target)
        claimed = targets.claim(target)
        if claimed is None:
            skipped.append({"path": ctx.display(row["key"]), "reason": "目标已存在同名文件"})
            continue
        folders.add(group)
        items.append({**_move_item(row), "to": claimed})
    size = sum(item["size"] for item in items)
    return await _propose(ctx, "organize", items, skipped=skipped, sample=_arrow, options={"by": by, "folders": sorted(folders)[:50]},
                          summary=f"把 {len(items)} 个文件（{_fmt(size)}）归类到 {len(folders)} 个文件夹"
                          + (f"，{len(skipped)} 项重名将跳过" if skipped else ""))


# ---------- 新建、回收站、公开链接 ----------

@tool("propose_create_folders", "新建文件夹", "write", "write", "生成新建一个或多个文件夹的待确认操作（≤200 个）。",
      {"paths": {"type": "array", "items": {"type": "string"}, "description": "文件夹路径"}}, ("paths",))
async def propose_create_folders(ctx: ToolContext, args: dict) -> ToolOutput:
    paths = args.get("paths")
    if not isinstance(paths, list) or not 1 <= len(paths) <= 200:
        raise ToolError("参数 paths 需要 1–200 个路径")
    items, skipped, seen = [], [], set()
    for value in paths:
        key = _valid_key(ctx.resolve(value, directory=True))
        if not key or key == ctx.scope_root or key in seen:
            continue
        seen.add(key)
        if ctx.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1",
                          (ctx.bucket_id, key, key + END)).fetchone():
            skipped.append({"path": ctx.display(key), "reason": "已存在"})
            continue
        items.append({"path": key})
    return await _propose(ctx, "mkdir", items, skipped=skipped, sample=lambda item: "/" + item["path"],
                          summary=f"新建 {len(items)} 个文件夹")


@tool("propose_trash", "移入回收站", "write", "write",
      "生成把文件或文件夹移入回收站的待确认操作（可从回收站恢复，30 天后自动清除）。paths 与 match 二选一。",
      {"paths": {"type": "array", "items": {"type": "string"}, "description": "文件或文件夹路径（≤1000 个）"}, "match": MATCH})
async def propose_trash(ctx: ToolContext, args: dict) -> ToolOutput:
    if bool(args.get("paths")) == bool(args.get("match")):
        raise ToolError("请在 paths 与 match 中二选一")
    if args.get("paths"):
        rows, skipped = _source_rows(ctx, args["paths"])
    else:
        rows, skipped = await _rows(ctx, args["match"], _item_limit(ctx)), []
    # 同时选中文件夹和其中的文件时只保留文件夹。
    folders = sorted(row["key"] for row in rows if row["key"].endswith("/"))
    items = []
    for row in rows:
        if any(row["key"] != folder and row["key"].startswith(folder) for folder in folders):
            continue
        items.append({"path": row["key"], "folder": row["key"].endswith("/"), "etag": row["etag"],
                      "modified_at": row["modified_at"], "directory_version": row.get("directory_version") if isinstance(row, dict) else None,
                      "size": int(row["size"] or 0)})
    size = sum(item["size"] for item in items)
    return await _propose(ctx, "trash", items, skipped=skipped, sample=lambda item: "/" + item["path"],
                          summary=f"把 {len(items)} 项（{_fmt(size)}）移入回收站")


def _trash_rows(ctx: ToolContext, ids: object, prefix: str | None, *, limit: int) -> list:
    where = ["bucket_id=? AND substr(original_path,1,9)!='.tgdrive/' AND original_path>=? AND original_path<?"]
    params: list = [ctx.bucket_id, ctx.scope_root, ctx.scope_root + END]
    if ids is not None:
        if not isinstance(ids, list) or not 1 <= len(ids) <= 1000 or not all(isinstance(item, str) for item in ids):
            raise ToolError("参数 ids 需要 1–1000 个回收站条目 ID（来自 list_trash）")
        where.append(f"id IN ({','.join('?' * len(ids))})")
        params += ids
    if prefix:
        where.append("original_path>=? AND original_path<?")
        params += [prefix, prefix + END]
    return ctx.db.execute(f"SELECT * FROM trash WHERE {' AND '.join(where)} ORDER BY deleted_at DESC LIMIT ?",
                          (*params, limit + 1)).fetchall()


@tool("propose_restore", "从回收站恢复", "write", "write",
      "生成从回收站恢复条目的待确认操作；恢复到原位置，原位置已有同名项目时自动改名保留两者。ids（来自 list_trash）"
      "与 original_prefix（按原路径所在目录）二选一。只能恢复原路径在当前作用域内的条目。",
      {"ids": {"type": "array", "items": {"type": "string"}}, "original_prefix": {"type": "string", "description": "原路径所在目录"}})
async def propose_restore(ctx: ToolContext, args: dict) -> ToolOutput:
    ids, prefix_arg = args.get("ids"), _str(args, "original_prefix", limit=1024)
    if bool(ids) == bool(prefix_arg):
        raise ToolError("请在 ids 与 original_prefix 中二选一")
    prefix = ctx.resolve(prefix_arg, directory=True) if prefix_arg else None
    limit = _item_limit(ctx)
    rows = await _thread(ctx, lambda: _trash_rows(ctx, ids or None, prefix, limit=limit))
    if len(rows) > limit:
        raise ToolError(f"匹配超过 {limit} 项，请缩小范围")
    items = [{"id": row["id"], "path": row["original_path"], "size": int(row["size"] or 0), "folder": bool(row["is_folder"])}
             for row in rows]
    return await _propose(ctx, "restore", items, skipped=[], sample=lambda item: "/" + item["path"],
                          summary=f"从回收站恢复 {len(items)} 项（{_fmt(sum(i['size'] for i in items))}）")


@tool("propose_purge_trash", "清空回收站", "write", "danger",
      "生成彻底删除回收站条目的待确认操作，不可恢复。ids（来自 list_trash）或 all=true（原路径在当前作用域内的全部条目）。"
      "提议前必须先告诉用户数量和不可恢复的后果。",
      {"ids": {"type": "array", "items": {"type": "string"}}, "all": {"type": "boolean"}})
async def propose_purge_trash(ctx: ToolContext, args: dict) -> ToolOutput:
    ids, everything = args.get("ids"), args.get("all") is True
    if bool(ids) == everything:
        raise ToolError("请在 ids 与 all=true 中二选一")
    limit = _item_limit(ctx)
    rows = await _thread(ctx, lambda: _trash_rows(ctx, ids or None, None, limit=limit))
    if len(rows) > limit:
        raise ToolError(f"回收站中超过 {limit} 项，请分批处理")
    items = [{"id": row["id"], "path": row["original_path"], "size": int(row["size"] or 0), "folder": bool(row["is_folder"])}
             for row in rows]
    return await _propose(ctx, "purge", items, skipped=[], danger=True, sample=lambda item: "/" + item["path"],
                          summary=f"彻底删除回收站中的 {len(items)} 项（{_fmt(sum(i['size'] for i in items))}），不可恢复")


@tool("propose_unshare", "取消公开", "write", "write",
      "生成取消公开链接的待确认操作（只能收回，不能创建公开链接）。取消后原链接立即失效，重新公开会得到新链接。",
      {"paths": {"type": "array", "items": {"type": "string"}, "description": "已公开的文件或文件夹路径（≤1000 个）"}}, ("paths",))
async def propose_unshare(ctx: ToolContext, args: dict) -> ToolOutput:
    paths = args.get("paths")
    if not isinstance(paths, list) or not 1 <= len(paths) <= 1000:
        raise ToolError("参数 paths 需要 1–1000 个路径")
    items, skipped = [], []
    for value in paths:
        key = ctx.resolve(value)
        row = ctx.db.execute("SELECT key, public_token FROM objects WHERE bucket_id=? AND (key=? OR key=?) ORDER BY key DESC LIMIT 1",
                             (ctx.bucket_id, key.rstrip("/") + "/", key)).fetchone() if key else None
        if row is None or row["public_token"] is None:
            skipped.append({"path": ctx.display(key), "reason": "不是公开状态"})
            continue
        items.append({"path": row["key"]})
    return await _propose(ctx, "unshare", items, skipped=skipped, sample=lambda item: "/" + item["path"],
                          summary=f"取消 {len(items)} 个公开链接")


@tool("propose_download_control", "下载任务操作", "write", "write",
      "生成停止、继续、重新下载或删除离线下载任务的待确认操作。删除任务不会删除已保存的文件。私密空间的任务不能操作。",
      {"ids": {"type": "array", "items": {"type": "integer"}, "description": "任务 ID（来自 list_downloads，≤200 个）"},
       "op": {"type": "string", "enum": ["stop", "resume", "restart", "delete"]}}, ("ids", "op"))
async def propose_download_control(ctx: ToolContext, args: dict) -> ToolOutput:
    if ctx.offline is None:
        raise ToolError("离线下载未启用")
    ids, op = args.get("ids"), args.get("op")
    if op not in ("stop", "resume", "restart", "delete"):
        raise ToolError("参数 op 不正确")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 200 or not all(isinstance(i, int) and not isinstance(i, bool) for i in ids):
        raise ToolError("参数 ids 需要 1–200 个任务 ID")
    rows = {row["id"]: row for row in ctx.db.execute(
        f"SELECT id, key, status FROM offline_tasks WHERE user_id=? AND id IN ({','.join('?' * len(ids))})", (ctx.user_id, *ids))}
    items, skipped = [], []
    labels = {"stop": "停止", "resume": "继续", "restart": "重新下载", "delete": "删除"}
    for task_id in dict.fromkeys(ids):
        row = rows.get(task_id)
        if row is None or row["key"].startswith(".tgdrive/") or not row["key"].startswith(ctx.scope_root):
            skipped.append({"path": f"任务 #{task_id}", "reason": "不存在"})
            continue
        items.append({"id": task_id, "op": op, "path": row["key"], "status": row["status"]})
    return await _propose(ctx, "download_control", items, skipped=skipped, options={"op": op},
                          sample=lambda item: f"#{item['id']} /{item['path']}", summary=f"{labels[op]} {len(items)} 个下载任务")

