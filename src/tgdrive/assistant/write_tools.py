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
from .attachments import PREFIX as ATTACHMENT_PREFIX
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

MATCH = {"type": "object", "description": "匹配条件：path 为目录（省略为作用域根），其余条件取交集；默认只匹配文件",
         "properties": {"path": PATH, "glob": {"type": "string", "description": "文件名通配符，如 IMG_*.jpg"},
                        "regex": {"type": "string", "description": "文件名正则（不区分大小写），分组可在模板中用 {1}{2} 引用"},
                        "kind": KIND, "ext": {"type": "array", "items": {"type": "string"}, "description": "扩展名列表"},
                        "recursive": {"type": "boolean", "description": "是否包含子目录，默认 false"}}}
RENAME_MATCH = {**MATCH, "description": "匹配条件：path 为目录（省略为作用域根），其余条件取交集。type=folder 时匹配文件夹（kind、ext 不适用）",
                "properties": {**MATCH["properties"], "type": {"type": "string", "enum": ["file", "folder"],
                                                                "description": "匹配文件（默认）或文件夹"}}}
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


def _match_rows(ctx: ToolContext, match: object, *, limit: int) -> list:
    if not isinstance(match, dict):
        raise ToolError("参数 match 不正确：需要对象")
    unknown = set(match) - {"path", "glob", "regex", "kind", "ext", "recursive", "type"}
    if unknown:
        raise ToolError(f"参数 match 不支持 {', '.join(sorted(unknown))}")
    if match.get("type") not in (None, "file", "folder"):
        raise ToolError("参数 match.type 只能是 file 或 folder")
    if match.get("type") == "folder":
        return _match_folders(ctx, match, limit=limit)
    prefix = ctx.resolve(match.get("path"), directory=True)
    glob = _str(match, "glob", limit=100)
    pattern = _regex(_str(match, "regex", limit=100)) if match.get("regex") else None
    where = [f"bucket_id=? AND key>? AND key<? AND substr(key,-1)!='/' AND {ctx.hide()}"]
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
        for row in ctx.db.execute(f"SELECT * FROM objects WHERE {' AND '.join(where)} ORDER BY key LIMIT ?", (*params, max(SCAN_LIMIT, limit) + 1)):
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


def _folder_row(ctx: ToolContext, folder: str, *, limit: int) -> dict:
    version, count = directory_version(ctx.db, ctx.bucket_id, folder, limit=limit)
    if count > limit:
        raise ToolError(f"文件夹 {ctx.display(folder)} 超过单次上限，请指定更小的目录")
    stats = ctx.db.execute("SELECT COALESCE(SUM(size),0), MAX(modified_at) FROM objects WHERE bucket_id=? AND key>=? AND key<?",
                           (ctx.bucket_id, folder, folder + END)).fetchone()
    return {"key": folder, "etag": None, "directory_version": version, "size": int(stats[0]), "modified_at": stats[1],
            "content_type": None}


def _match_folders(ctx: ToolContext, match: dict, *, limit: int):
    """按目录匹配：直接子目录（含只靠前缀存在的隐式目录）；recursive 时包含各级子目录。"""
    if match.get("kind") or match.get("ext"):
        raise ToolError("匹配文件夹时不能使用 kind 或 ext")
    prefix = ctx.resolve(match.get("path"), directory=True)
    glob = _str(match, "glob", limit=100)
    pattern = _regex(_str(match, "regex", limit=100)) if match.get("regex") else None
    recursive = bool(match.get("recursive"))

    def read():
        folders: set[str] = set()
        for (key,) in ctx.db.execute(f"SELECT key FROM objects WHERE bucket_id=? AND key>? AND key<? AND {ctx.hide()} "
                                     "ORDER BY key LIMIT ?", (ctx.bucket_id, prefix, prefix + END, max(SCAN_LIMIT, limit) + 1)):
            parts = key[len(prefix):].split("/")[:-1]
            if not recursive:
                parts = parts[:1]
            for depth in range(1, len(parts) + 1):
                folders.add(prefix + "/".join(parts[:depth]) + "/")
        rows = []
        for folder in sorted(folders):
            name = _name_of(folder)
            if glob and not fnmatch.fnmatch(name.lower(), glob.lower()):
                continue
            if pattern is not None and not pattern.search(name):
                continue
            if len(rows) >= limit:
                rows.append({"key": folder})
                break
            rows.append(_folder_row(ctx, folder, limit=_item_limit(ctx)))
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
    folder = row["key"].endswith("/")
    return {"from": row["key"], "to": None, "folder": folder, "etag": row["etag"], "modified_at": None if folder else row["modified_at"],
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
    result = {"action_id": created["action_id"], "kind": kind, "count": len(items), "conflicts": len(skipped), "samples": samples}
    event = {"type": "action", "action_id": created["action_id"], "kind": kind, "count": len(items)}
    if created.get("auto"):
        # 完全访问模式：操作已自动执行（或仍在执行），把结果直接交给模型。
        outcome = created.get("outcome") or {}
        if outcome.get("status") == "running":
            result["status"] = "已在完全访问模式下自动开始执行，条目较多仍在进行，完成后对话中会出现结果"
        else:
            result["status"] = "已在完全访问模式下自动执行完毕（用户可在卡片上撤销）"
            result["result"] = {key: outcome.get(key) for key in ("ok", "skipped", "failed", "reasons")}
        return ToolOutput(result, f"{summary}（已自动执行）", items=len(items), event={**event, "auto": True})
    result["expires_at"] = datetime.fromtimestamp(created["expires_at"]).isoformat(timespec="seconds")
    result["status"] = "已生成待确认操作，等待用户在界面卡片上确认；确认前不会执行任何修改"
    if created.get("confirm_reason"):
        result["status"] += f"（当前为完全访问模式，但{created['confirm_reason']}）"
    return ToolOutput(result, f"{summary}（待确认）", items=len(items), event=event)


def _arrow(ctx: ToolContext):
    return lambda item: f"{ctx.display(item['from'])} → {ctx.display(item['to'])}"


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
            return datetime.fromtimestamp(row["modified_at"] or 0).strftime(spec or "%Y-%m-%d")
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
      "生成批量改名操作（文件或文件夹）；审批模式等待确认，完全访问下自动执行。不能跨目录（移动请用 propose_move）。\n"
      "- 规则模式：match 指定范围（match.type=folder 时改文件夹名），template 指定新名称。可用变量：{name} 原名称、{stem} 不含扩展名、"
      "{ext} 含点的扩展名（文件夹为空）、{n} 序号（{n:03} 补零，按 sort 排序后从 start 开始）、{parent} 所在目录名、"
      "{mtime:%Y-%m-%d} 修改时间（文件夹取其中最新文件）、{1}{2} match.regex 的分组。\n"
      "- 映射模式：mapping 为 [{from, to}]，最多 200 项，from 为文件或文件夹路径，to 只能是新名称。\n"
      "同一次提议不能同时改名某个文件夹和它的下级。返回待确认操作的编号、条目数、冲突数和前 20 条样例。",
      {"match": RENAME_MATCH, "template": {"type": "string", "description": "新名称模板，如 {mtime:%Y%m%d}_{n:03}{ext}"},
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
        plan = []
        for entry in mapping:
            if not isinstance(entry, dict) or not isinstance(entry.get("from"), str) or not isinstance(entry.get("to"), str):
                raise ToolError("mapping 的每一项需要 from 与 to")
            name = _check_name(entry["to"].strip().strip("/"))
            rows, missing = _source_rows(ctx, [entry["from"]])
            if missing:
                skipped.append({"path": missing[0]["path"], "reason": "不存在"})
                continue
            plan.append((rows[0], name))
    else:
        match = args.get("match") or {}
        rows = await _rows(ctx, match, _item_limit(ctx))
        if (args.get("sort") or "name") == "mtime":
            rows.sort(key=lambda row: (row["modified_at"] or 0, row["key"]))
        elif args.get("sort") not in (None, "name"):
            raise ToolError("参数 sort 不正确")
        start = _int(args, "start", 1, 0, 10**9)
        pattern = _regex(_str(match, "regex", limit=100)) if isinstance(match, dict) and match.get("regex") else None
        plan = []
        for index, row in enumerate(rows):
            groups = pattern.search(_name_of(row["key"])).groups() if pattern else ()
            plan.append((row, _check_name(render_name(template, row, start + index, groups).strip().strip("/"))))
    folders = sorted(row["key"] for row, _ in plan if row["key"].endswith("/"))
    for row, name in plan:
        source = row["key"]
        folder = source.endswith("/")
        if any(source != other and source.startswith(other) for other in folders):
            skipped.append({"path": ctx.display(source), "reason": "上级文件夹也在改名，请分两次进行"})
            continue
        target = _parent_of(source) + name + ("/" if folder else "")
        if target == source:
            continue
        ctx.valid_key(target)
        claimed = targets.claim(target)
        if claimed is None:
            skipped.append({"path": ctx.display(source), "reason": f"{name} 已存在"})
            continue
        items.append({**_move_item(row), "to": claimed})
    folders_count = sum(1 for item in items if item["folder"])
    noun = "个文件夹" if folders_count == len(items) else "个文件" if not folders_count else "项"
    return await _propose(ctx, "rename", items, skipped=skipped, sample=_arrow(ctx),
                          summary=f"重命名 {len(items)} {noun}" + (f"，{len(skipped)} 项将跳过" if skipped else ""))


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
        rows.append(_folder_row(ctx, folder, limit=_item_limit(ctx)))
    return rows, missing


@tool("propose_move", "移动", "write", "write",
      "生成把文件或文件夹移动到目标目录的操作；审批模式等待确认，完全访问下自动执行。sources 与 match 二选一；不能把文件夹移入它自己的子目录。",
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
        ctx.valid_key(target)
        claimed = targets.claim(target)
        if claimed is None:
            skipped.append({"path": ctx.display(source), "reason": "目标已存在同名项目"})
            continue
        items.append({**_move_item(row), "to": claimed})
    size = sum(item["size"] for item in items)
    return await _propose(ctx, "move", items, skipped=skipped, sample=_arrow(ctx),
                          summary=f"移动 {len(items)} 项（{_fmt(size)}）到 {ctx.display(target_dir)}"
                          + (f"，{len(skipped)} 项将跳过" if skipped else ""))


@tool("propose_organize", "整理文件", "write", "write",
      "按规则把目录中的文件归类到子文件夹；审批模式等待确认，完全访问下自动执行。by：kind 按类型（图片、视频…）、ext 按扩展名、"
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
        ctx.valid_key(target)
        claimed = targets.claim(target)
        if claimed is None:
            skipped.append({"path": ctx.display(row["key"]), "reason": "目标已存在同名文件"})
            continue
        folders.add(group)
        items.append({**_move_item(row), "to": claimed})
    size = sum(item["size"] for item in items)
    return await _propose(ctx, "organize", items, skipped=skipped, sample=_arrow(ctx), options={"by": by, "folders": sorted(folders)[:50]},
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
        key = ctx.valid_key(ctx.resolve(value, directory=True))
        if not key or key == ctx.scope_root or key in seen:
            continue
        seen.add(key)
        if ctx.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1",
                          (ctx.bucket_id, key, key + END)).fetchone():
            skipped.append({"path": ctx.display(key), "reason": "已存在"})
            continue
        items.append({"path": key})
    return await _propose(ctx, "mkdir", items, skipped=skipped, sample=lambda item: ctx.display(item["path"]),
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
    return await _propose(ctx, "trash", items, skipped=skipped, sample=lambda item: ctx.display(item["path"]),
                          summary=f"把 {len(items)} 项（{_fmt(size)}）移入回收站")


def _trash_rows(ctx: ToolContext, ids: object, prefix: str | None, *, limit: int) -> list:
    where = [f"bucket_id=? AND {ctx.hide('original_path')} AND original_path>=? AND original_path<?"]
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
    return await _propose(ctx, "restore", items, skipped=[], sample=lambda item: ctx.display(item["path"]),
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
    return await _propose(ctx, "purge", items, skipped=[], danger=True, sample=lambda item: ctx.display(item["path"]),
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
    return await _propose(ctx, "unshare", items, skipped=skipped, sample=lambda item: ctx.display(item["path"]),
                          summary=f"取消 {len(items)} 个公开链接")


@tool("propose_save_attachment", "保存附件", "write", "write",
      "把用户随消息上传的附件另存为普通文件（附件本身只能读取，随对话删除；保存出来的文件不受影响）。"
      "目标以 / 结尾表示保存到该文件夹并沿用附件名；同名时自动改名。",
      {"items": {"type": "array", "description": "要保存的附件（≤10 个）", "items": {"type": "object", "properties": {
          "attachment": {"type": "string", "description": "附件名称，如 附件:截图.png"},
          "target": {"type": "string", "description": "目标文件夹（以 / 结尾）或完整文件路径"}}, "required": ["attachment", "target"]}}},
      ("items",))
async def propose_save_attachment(ctx: ToolContext, args: dict) -> ToolOutput:
    entries = args.get("items")
    if not isinstance(entries, list) or not 1 <= len(entries) <= 10:
        raise ToolError("参数 items 需要 1–10 项")
    items, skipped = [], []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("attachment"), str) or not isinstance(entry.get("target"), str):
            raise ToolError("每项需要 attachment 与 target")
        name = entry["attachment"].strip()
        if not name.startswith(ATTACHMENT_PREFIX):
            raise ToolError(f"{name} 不是附件名称，附件名称形如 {ATTACHMENT_PREFIX}截图.png")
        key = ctx.attachment(name)
        row = ctx.db.execute("SELECT id, size FROM assistant_attachments WHERE key=? AND user_id=?", (key, ctx.user_id)).fetchone()
        if row is None:
            skipped.append({"path": name, "reason": "附件已不存在"})
            continue
        target = ctx.resolve(entry["target"], directory=entry["target"].strip().endswith("/"))
        if not target or target.endswith("/"):
            target += name[len(ATTACHMENT_PREFIX):]
        items.append({"attachment": row["id"], "name": name, "path": ctx.valid_key(target), "size": int(row["size"])})
    return await _propose(ctx, "save_attachment", items, skipped=skipped,
                          sample=lambda item: f"{item['name']} → {ctx.display(item['path'])}", summary=f"保存 {len(items)} 个附件到我的文件")


@tool("propose_share", "公开分享", "write", "write",
      "生成公开分享文件或文件夹的待确认操作；已公开的项目会按新设置调整有效期与密码。确认卡片中用户可以修改有效期，"
      "并在卡片里自行输入访问密码（不要向用户索要密码，也不要把密码写进参数）。执行后链接只显示给用户，你不会拿到链接。"
      "公开分享总是需要用户确认。",
      {"paths": {"type": "array", "items": {"type": "string"}, "description": "文件或文件夹路径（≤200 个）"},
       "expires_days": {"type": "integer", "description": "有效天数 1–365，0 或省略表示永久有效"},
       "require_password": {"type": "boolean", "description": "是否建议设置访问密码（由用户在卡片中填写）"}}, ("paths",))
async def propose_share(ctx: ToolContext, args: dict) -> ToolOutput:
    paths = args.get("paths")
    if not isinstance(paths, list) or not 1 <= len(paths) <= 200:
        raise ToolError("参数 paths 需要 1–200 个路径")
    days = _int(args, "expires_days", 0, 0, 365)
    require = args.get("require_password") is True
    rows, skipped = _source_rows(ctx, paths)
    items, seen = [], set()
    for row in rows:
        key = row["key"]
        if key in seen:
            continue
        seen.add(key)
        current = ctx.db.execute("SELECT public_token FROM objects WHERE bucket_id=? AND key=?", (ctx.bucket_id, key)).fetchone()
        items.append({"path": key, "folder": key.endswith("/"), "public": bool(current and current["public_token"]),
                      "size": int(row["size"] or 0)})
    already = sum(item["public"] for item in items)
    summary = (f"公开分享 {len(items)} 项" + (f"（其中 {already} 项已公开，将更新设置）" if already else "")
               + (f"，{days} 天后失效" if days else "，永久有效") + ("，建议设置访问密码" if require else ""))
    return await _propose(ctx, "share", items, skipped=skipped, sample=lambda item: ctx.display(item["path"]), summary=summary,
                          options={"expires_days": days or None, "require_password": require})


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
        if row is None or (not ctx.private and row["key"].startswith(".tgdrive/")) or not row["key"].startswith(ctx.scope_root):
            skipped.append({"path": f"任务 #{task_id}", "reason": "不存在"})
            continue
        items.append({"id": task_id, "op": op, "path": row["key"], "status": row["status"]})
    return await _propose(ctx, "download_control", items, skipped=skipped, options={"op": op},
                          sample=lambda item: f"#{item['id']} {ctx.display(item['path'])}", summary=f"{labels[op]} {len(items)} 个下载任务")


# ---------- 跨区移动（docs/assistant-design.md §24.5.3） ----------

MOVE_OUT_LIMIT = 200


def _normal_folder(value: object) -> str:
    """普通文件区的目标目录（对象键，根目录为空字符串）；系统区一律拒绝。"""
    if not isinstance(value, str) or len(value) > 1024:
        raise ToolError("参数 target 不正确")
    text = value.strip().strip("/")
    if not text:
        return ""
    try:
        return normalize_user_path(text, directory=True)
    except PermissionError as exc:
        raise ToolError("目标不能是系统保留区域") from exc
    except ValueError as exc:
        raise ToolError(f"目标目录 {value} 不合法") from exc


def _cross_items(ctx: ToolContext, paths: object) -> tuple[list, list]:
    if not isinstance(paths, list) or not 1 <= len(paths) <= MOVE_OUT_LIMIT:
        raise ToolError(f"参数 paths 需要 1–{MOVE_OUT_LIMIT} 个路径")
    rows, skipped = _source_rows(ctx, paths)
    folders = sorted(row["key"] for row in rows if row["key"].endswith("/"))
    items, seen = [], set()
    for row in rows:
        key = row["key"]
        if key in seen or any(key != folder and key.startswith(folder) for folder in folders):
            continue
        seen.add(key)
        items.append({**_move_item(row), "name": _name_of(key)})
    return items, skipped


@tool("propose_move_out", "移出私密空间", "write", "write",
      "生成把私密空间中的文件或文件夹移到普通文件目录的待确认操作。移出后不再受私密空间保护，所以只在用户明确要求时使用；"
      "用户确认时需要重新验证身份，执行后不能撤销。"
      "paths 为私密空间中的路径（≤200 个），target 为普通文件区的目录（如 /文档/；/ 表示根目录），用户可以在卡片上改选。",
      {"paths": {"type": "array", "items": {"type": "string"}, "description": "私密空间中的文件或文件夹路径（≤200 个）"},
       "target": {"type": "string", "description": "普通文件区的目标目录"}}, ("paths", "target"))
async def propose_move_out(ctx: ToolContext, args: dict) -> ToolOutput:
    if not ctx.private:
        raise ToolError("只能在私密对话中使用")
    target = _normal_folder(args.get("target"))
    items, skipped = _cross_items(ctx, args.get("paths"))
    size = sum(item["size"] for item in items)
    return await _propose(ctx, "move_out", items, skipped=skipped, sample=lambda item: ctx.display(item["from"]),
                          options={"target": target},
                          summary=f"把 {len(items)} 项（{_fmt(size)}）移出私密空间到 /{target}，需要你重新验证身份")


@tool("propose_move_to_private", "移入私密空间", "write", "write",
      "生成把普通文件或文件夹移入私密空间的待确认操作（≤200 个）。私密空间中的目标位置由用户在卡片上选择，你不会知道私密空间的目录结构；"
      "确认时需要私密空间处于解锁状态。移入后公开链接会被取消。",
      {"paths": {"type": "array", "items": {"type": "string"}, "description": "作用域内的文件或文件夹路径（≤200 个）"}}, ("paths",))
async def propose_move_to_private(ctx: ToolContext, args: dict) -> ToolOutput:
    if ctx.private:
        raise ToolError("已经在私密空间中")
    items, skipped = _cross_items(ctx, args.get("paths"))
    size = sum(item["size"] for item in items)
    return await _propose(ctx, "move_in", items, skipped=skipped, sample=lambda item: ctx.display(item["from"]),
                          summary=f"把 {len(items)} 项（{_fmt(size)}）移入私密空间，目标位置由你在卡片上选择")
