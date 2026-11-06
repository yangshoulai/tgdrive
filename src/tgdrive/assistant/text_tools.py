"""新建与编辑文本文件的提议工具（docs/assistant-design.md §42）。

与其他写入工具一样只生成待确认操作（操作类型 text），由用户确认（或完全访问下自动执行）后才写入：
- 新建：路径不存在时写入 content。
- 整体改写：给出完整的新内容（如格式化 Markdown）。必须在本轮用 read_text_file 完整读过这个版本，避免改写没看过的内容。
- 局部修改：edits 给出若干「查找 → 替换」，适合大文件的小改动；每处原文必须唯一出现（或声明 all）。
只编辑 UTF-8 文本，保留原文件的 BOM 与 CRLF 换行。read_text_file 交给模型的内容里，疑似密钥的片段被替换成占位文本；
这里在原文上按同样的规则找出这些片段，新内容里的占位按顺序还原成原文，数量对不上时拒绝，避免把密钥写丢或写成占位。
新内容作为操作的冻结数据（_frozen）单独加密存放：不进入卡片条目、模型结果或日志，操作结束后清除；确认卡片经服务器读取前后内容做对比。
"""

from __future__ import annotations

import difflib
import mimetypes

from ..filekinds import kind_of
from .guard import HIDDEN, redact_content, redact_values
from .tools import PATH, END, ToolContext, ToolError, ToolOutput, _fmt, _str, _thread, tool
from .write_tools import _check_name, _name_of, _propose

BOM = b"\xef\xbb\xbf"
MAX_EDITS = 50
DIFF_PREVIEW = 4000
# 去掉相同头尾后仍超过这么多行时不再逐行比较（行数统计按整段删除与新增）。
DIFF_LINES = 20000


def decode_text(data: bytes) -> tuple[str, bool]:
    """按 UTF-8 解码（可带 BOM），返回（文本，是否带 BOM）；不是 UTF-8 文本时抛 ToolError。"""
    bom = data.startswith(BOM)
    body = data[len(BOM):] if bom else data
    if b"\x00" in body[:8192]:
        raise ToolError("文件包含二进制数据，不是文本文件")
    try:
        return body.decode("utf-8"), bom
    except UnicodeDecodeError:
        raise ToolError("只能编辑 UTF-8 编码的文本文件；这个文件是其他编码，请在网页预览里编辑") from None


def crlf_only(text: str) -> bool:
    return "\r\n" in text and text.count("\n") == text.count("\r\n")


def encode_text(text: str, *, bom: bool, crlf: bool) -> bytes:
    text = text.replace("\r\n", "\n")
    if crlf:
        text = text.replace("\n", "\r\n")
    return (BOM if bom else b"") + text.encode("utf-8")


def restore_hidden(text: str, values: list[str]) -> str:
    if not values:
        return text
    pieces = text.split(HIDDEN)
    if len(pieces) - 1 != len(values):
        raise ToolError(f"原文件有 {len(values)} 处疑似密钥被隐藏（显示为「{HIDDEN}」），新内容里必须原样、按顺序保留这些占位，"
                        "不能删除、复制或改写；如果确实要修改这些位置，请让用户在网页里编辑")
    out = [pieces[0]]
    for value, piece in zip(values, pieces[1:]):
        out += [value, piece]
    return "".join(out)


def apply_edits(text: str, edits: object) -> str:
    if not isinstance(edits, list) or not 1 <= len(edits) <= MAX_EDITS:
        raise ToolError(f"参数 edits 需要 1–{MAX_EDITS} 处修改")
    for number, edit in enumerate(edits, 1):
        if not isinstance(edit, dict) or not isinstance(edit.get("find"), str) or not isinstance(edit.get("replace"), str):
            raise ToolError(f"第 {number} 处修改需要字符串 find 与 replace")
        find, replace = edit["find"].replace("\r\n", "\n"), edit["replace"].replace("\r\n", "\n")
        if not find:
            raise ToolError(f"第 {number} 处修改的 find 不能为空")
        count = text.count(find)
        if not count:
            raise ToolError(f"第 {number} 处修改找不到 find 指定的原文（需与文件内容逐字一致，包括空格与换行）；请先用 read_text_file 读取后再改")
        if count > 1 and edit.get("all") is not True:
            raise ToolError(f"第 {number} 处修改的原文出现了 {count} 次：请给出更长、唯一的上下文，或设置 all=true 全部替换")
        text = text.replace(find, replace)
    return text


def trim_common(old: list[str], new: list[str]) -> tuple[int, int]:
    """相同的开头与结尾各有多少行（两者不重叠）。"""
    head = 0
    while head < len(old) and head < len(new) and old[head] == new[head]:
        head += 1
    tail = 0
    while tail < len(old) - head and tail < len(new) - head and old[-1 - tail] == new[-1 - tail]:
        tail += 1
    return head, tail


def line_stats(before: str, after: str) -> tuple[int, int, str]:
    """（新增行数，删除行数，统一格式差异的开头部分）。先去掉相同的头尾；中间仍很长时（大文件的整段改写）
    不再逐行比较，直接按删除旧段、新增新段统计，避免大文件上耗时过长。"""
    old, new = before.splitlines(), after.splitlines()
    head, tail = trim_common(old, new)
    mid_old, mid_new = old[head:len(old) - tail], new[head:len(new) - tail]
    if len(mid_old) + len(mid_new) > DIFF_LINES:
        return len(mid_new), len(mid_old), f"@@ 第 {head + 1} 行起 @@（改动范围较大：删除 {len(mid_old)} 行，新增 {len(mid_new)} 行）"
    added = removed = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, mid_old, mid_new, autojunk=False).get_opcodes():
        if tag in ("replace", "delete"):
            removed += i2 - i1
        if tag in ("replace", "insert"):
            added += j2 - j1
    start = max(0, head - 1)
    preview = "\n".join(difflib.unified_diff(old[start:len(old) - max(0, tail - 1)], new[start:len(new) - max(0, tail - 1)], lineterm="", n=1))
    if start:
        preview = f"（前 {start} 行未改动）\n" + preview
    return added, removed, preview[:DIFF_PREVIEW] + ("\n…" if len(preview) > DIFF_PREVIEW else "")


def text_type(key: str) -> str:
    guessed = mimetypes.guess_type(_name_of(key))[0]
    if guessed and (guessed.startswith("text/") or guessed in ("application/json", "application/xml") or guessed.endswith("+json")):
        return guessed
    return "text/plain"


@tool("propose_write_text", "编辑文本文件", "write", "write",
      "生成新建或修改一个文本文件（纯文本、Markdown、代码、JSON、字幕等 UTF-8 文本）的待确认操作。"
      "新建：path 不存在时给出 content。整体改写（如格式化、重排、翻译整篇）：给出完整的 content，"
      "必须先在本轮用 read_text_file 完整读取（不截断）这个文件，content 是改写后的全文而不是片段。"
      "局部修改：给出 edits（每项 find 为文件中逐字一致、唯一出现的原文，replace 为替换内容），适合大文件的小改动。"
      "content 与 edits 二选一。读取结果里的「[已隐藏的密钥]」占位要原样保留在原位置。用户确认后才写入；文件在确认前被修改则不会覆盖。",
      {"path": PATH,
       "content": {"type": "string", "description": "新建或整体改写时的完整文本内容"},
       "edits": {"type": "array", "description": "局部修改：按顺序执行的查找替换",
                 "items": {"type": "object", "properties": {
                     "find": {"type": "string", "description": "要替换的原文（逐字一致）"},
                     "replace": {"type": "string", "description": "替换成的内容（可以为空字符串表示删除）"},
                     "all": {"type": "boolean", "description": "原文出现多次时全部替换，默认 false"}},
                     "required": ["find", "replace"], "additionalProperties": False}},
       "summary": {"type": "string", "description": "一句话说明这次修改（显示在确认卡片上），如「格式化 Markdown 标题与列表」"}},
      ("path",),
      params={"max_bytes": (1024 * 1024, 1024, 16 * 1024 * 1024, "可编辑的最大文件大小（字节）")})
async def propose_write_text(ctx: ToolContext, args: dict) -> ToolOutput:
    key = ctx.valid_key(ctx.resolve(_str(args, "path", limit=1024)))
    if not key or key.endswith("/"):
        raise ToolError("请指定文件路径（不能是文件夹）")
    _check_name(_name_of(key))
    content, edits = args.get("content"), args.get("edits")
    if (content is None) == (edits is None):
        raise ToolError("content 与 edits 需要且只能给出一个")
    if content is not None and not isinstance(content, str):
        raise ToolError("参数 content 必须是字符串")
    note = _str(args, "summary", limit=200) if args.get("summary") is not None else ""
    max_bytes = int(ctx.params.get("max_bytes", 1024 * 1024))
    row = await _thread(ctx, lambda: ctx.db.execute("SELECT key, etag, size, content_type FROM objects WHERE bucket_id=? AND key=?",
                                                    (ctx.bucket_id, key)).fetchone())
    if row is None:
        if edits is not None:
            raise ToolError(f"找不到文件 {ctx.display(key)}；新建文件请给出 content")
        if await _thread(ctx, lambda: ctx.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1",
                                                     (ctx.bucket_id, key + "/", key + "/" + END)).fetchone()):
            raise ToolError(f"{ctx.display(key)} 是一个文件夹")
        if kind_of(key, None) != "text":
            raise ToolError("只能新建文本类文件，请使用 .txt、.md、.json、.csv、代码等文本扩展名")
        data = encode_text(content, bom=False, crlf=False)
        if len(data) > max_bytes:
            raise ToolError(f"内容超过可编辑的上限 {_fmt(max_bytes)}")
        added, removed, preview = line_stats("", content)
        item = {"path": key, "mode": "create", "etag": None, "size": len(data), "old_size": 0, "added": added, "removed": 0,
                "content_type": text_type(key), "bom": False, "summary": note}
        return await _write(ctx, item, data.decode("utf-8"), preview, f"新建 {ctx.display(key)}")
    if kind_of(row["key"], row["content_type"]) != "text":
        raise ToolError("只能编辑文本文件（纯文本、Markdown、代码、JSON、字幕等），不能编辑图片、音视频、压缩包、PDF 或 Office 文档")
    size = int(row["size"] or 0)
    if size > max_bytes:
        raise ToolError(f"文件大小 {_fmt(size)} 超过可编辑的上限 {_fmt(max_bytes)}")
    if content is not None:
        seen = ctx.state.get("read_full") or set()
        if (key, row["etag"]) not in seen:
            raise ToolError("整体改写前必须先在本轮用 read_text_file 完整读取这个文件的当前版本（不截断）；只改几处时可以改用 edits")
    chunks = []
    if size:
        async for chunk in ctx.read(key, 0, size):
            chunks.append(chunk)
    raw = b"".join(chunks)
    original, bom = decode_text(raw)
    crlf = crlf_only(original)
    # 模型看到的是隐藏密钥后的文本：在同样的文本上改写，再把占位按顺序还原成原文。
    visible, secrets = redact_values(original)
    base = visible.replace("\r\n", "\n")
    updated = content.replace("\r\n", "\n") if content is not None else apply_edits(base, edits)
    final = restore_hidden(updated, secrets)
    data = encode_text(final, bom=bom, crlf=crlf)
    if data == raw:
        raise ToolError("修改后的内容与原文件相同，不需要写入")
    if len(data) > max_bytes:
        raise ToolError(f"修改后的内容超过可编辑的上限 {_fmt(max_bytes)}")
    added, removed, preview = line_stats(base, updated)
    item = {"path": key, "mode": "edit" if edits is not None else "overwrite", "etag": row["etag"], "size": len(data), "old_size": size,
            "added": added, "removed": removed, "content_type": row["content_type"], "bom": bom, "summary": note}
    # 冻结的是最终写入的文本（已按原文件换行，不含 BOM）。
    return await _write(ctx, item, data[len(BOM) if bom else 0:].decode("utf-8"), preview, f"修改 {ctx.display(key)}")


async def _write(ctx: ToolContext, item: dict, text: str, preview: str, summary: str) -> ToolOutput:
    label = f"{summary}（+{item['added']} −{item['removed']} 行）"
    output = await _propose(ctx, "text", [item], skipped=[], summary=item["summary"] or label, frozen={"0": text},
                            sample=lambda entry: f"{ctx.display(entry['path'])}（+{entry['added']} −{entry['removed']} 行，{_fmt(entry['size'])}）")
    # 给模型一段差异核对改动是否符合预期（同样隐藏疑似密钥）。
    output.result["diff"] = redact_content(preview)[0]
    return output

