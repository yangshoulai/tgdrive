"""浏览器工具（docs/assistant-design.md §19.7）：在用户打开的 Tessera 页面里执行。

- 读取与跳转类（ui_get_view、ui_navigate、ui_select、ui_preview）：服务端校验参数后通过 ctx.client 发出 client_call 事件，
  由对话框执行并回传结果；对话框没有打开时返回「浏览器未连接」。
- 需要用户手势的动作（ui_download、browser_open_url、ui_copy）：浏览器不允许脚本自动下载、弹出新窗口或写剪贴板，
  所以只在对话里生成一张动作卡片，用户点击后执行；工具立即返回。
- 路径一律经 ctx.resolve 校验在作用域内且不在 .tgdrive/；页面回传的数据同样按不可信数据包装。
"""

from __future__ import annotations

import time
from urllib.parse import urlsplit

from .tools import END, PATH, ToolContext, ToolError, ToolOutput, _str, tool

VIEWS = {"files": "文件", "trash": "回收站", "downloads": "下载任务", "shared": "公开分享"}


async def _call(ctx: ToolContext, name: str, args: dict) -> dict:
    if ctx.client is None:
        raise ToolError("浏览器未连接：用户的对话框没有打开，无法操作页面")
    result = await ctx.client(name, args)
    if not isinstance(result, dict):
        raise ToolError("浏览器返回的数据格式不正确")
    if result.get("error"):
        raise ToolError(str(result["error"])[:200])
    return result


def _inside(ctx: ToolContext, value: object) -> str | None:
    """页面回传的路径：只保留作用域内的普通文件路径。"""
    if not isinstance(value, str):
        return None
    key = value.lstrip("/")
    if key.startswith(".tgdrive/") or not key.startswith(ctx.scope_root):
        return None
    return "/" + key


@tool("ui_get_view", "读取当前页面", "browser", "read",
      "读取用户当前在 Tessera 里看到的页面：页面类型、所在目录、用户已选中的文件，以及当前页可见的条目（最多 200 个）。"
      "用户说「这些」「选中的」「这里」时先调用它。私密空间页面不会返回内容。", timeout=50)
async def ui_get_view(ctx: ToolContext, args: dict) -> ToolOutput:
    result = await _call(ctx, "ui_get_view", {})
    view = str(result.get("view") or "")[:20]
    if view == "private":
        return ToolOutput({"view": "private", "note": "用户正在私密空间，助手无法查看或操作其中的内容"}, "私密空间（不开放）")
    selected = [path for path in (_inside(ctx, item) for item in (result.get("selected") or [])[:1000]) if path]
    visible = []
    for item in (result.get("visible") or [])[:200]:
        if isinstance(item, dict):
            path = _inside(ctx, item.get("path"))
            if path:
                visible.append({"path": path, "kind": "folder" if path.endswith("/") else "file",
                                **({"size": item["size"]} if isinstance(item.get("size"), int) else {})})
    path = _inside(ctx, result.get("path")) if view == "files" else None
    hidden = len(result.get("selected") or []) - len(selected)
    payload = {"view": view, "view_label": VIEWS.get(view, view), "path": path, "selected": selected, "visible": visible,
               "visible_total": result.get("total") if isinstance(result.get("total"), int) else len(visible),
               "preview": _inside(ctx, result.get("preview"))}
    if hidden > 0:
        payload["note"] = f"{hidden} 个选中项不在当前作用域内，已省略"
    label = VIEWS.get(view, view or "未知页面")
    return ToolOutput(payload, f"{label}{' ' + path if path else ''} · 已选中 {len(selected)} 项", items=len(visible))


@tool("ui_navigate", "打开页面", "browser", "read",
      "在用户的 Tessera 中打开页面：view=files 时打开 path 指定的目录（默认作用域根），也可以打开 trash 回收站、downloads 下载任务、"
      "shared 公开分享。用于把用户带到结果所在的位置。",
      {"view": {"type": "string", "enum": list(VIEWS), "description": "页面，默认 files"}, "path": PATH}, timeout=50)
async def ui_navigate(ctx: ToolContext, args: dict) -> ToolOutput:
    view = args.get("view") or "files"
    if view not in VIEWS:
        raise ToolError("参数 view 不正确")
    path = ctx.resolve(args.get("path"), directory=True) if view == "files" else None
    if path is not None and path and ctx.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1",
                                                    (ctx.bucket_id, path, path + END)).fetchone() is None:
        raise ToolError(f"目录 {ctx.display(path)} 不存在")
    await _call(ctx, "ui_navigate", {"view": view, "path": path})
    return ToolOutput({"status": "已打开", "view": view, "path": ctx.display(path) if path is not None else None},
                      f"打开{VIEWS[view]}" + (f" {ctx.display(path)}" if path else ""))


@tool("ui_select", "选中文件", "browser", "read",
      "在文件页选中指定的文件或文件夹（会先打开它们所在的目录，所有路径必须在同一个目录下），方便用户随后自己下载、移动或分享。",
      {"paths": {"type": "array", "items": {"type": "string"}, "description": "同一目录下的文件或文件夹路径（≤200 个）"}}, ("paths",),
      timeout=50)
async def ui_select(ctx: ToolContext, args: dict) -> ToolOutput:
    paths = args.get("paths")
    if not isinstance(paths, list) or not 1 <= len(paths) <= 200:
        raise ToolError("参数 paths 需要 1–200 个路径")
    keys = []
    for value in paths:
        key = ctx.resolve(value)
        if not key or key == ctx.scope_root:
            raise ToolError("请指定具体的文件或文件夹")
        keys.append(key)
    parents = {key.rstrip("/").rsplit("/", 1)[0] + "/" if "/" in key.rstrip("/") else "" for key in keys}
    if len(parents) != 1:
        raise ToolError("一次只能选中同一个目录下的条目")
    parent = parents.pop()
    if not parent.startswith(ctx.scope_root):
        raise ToolError("所在目录不在当前作用域内")
    result = await _call(ctx, "ui_select", {"folder": parent, "paths": keys})
    count = result.get("selected") if isinstance(result.get("selected"), int) else len(keys)
    return ToolOutput({"status": "已选中", "folder": ctx.display(parent), "selected": count,
                       **({"missing": result["missing"]} if isinstance(result.get("missing"), int) and result["missing"] else {})},
                      f"在 {ctx.display(parent)} 选中 {count} 项", items=count)


@tool("ui_preview", "预览文件", "browser", "read",
      "用 Tessera 的预览打开一个文件（图片、视频、音乐、文档、文本等），会先打开它所在的目录。",
      {"path": PATH}, ("path",), timeout=50)
async def ui_preview(ctx: ToolContext, args: dict) -> ToolOutput:
    key = ctx.resolve(_str(args, "path", limit=1024))
    if not key or key.endswith("/"):
        raise ToolError("请指定文件路径")
    if ctx.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key=?", (ctx.bucket_id, key)).fetchone() is None:
        raise ToolError(f"找不到文件 {ctx.display(key)}")
    await _call(ctx, "ui_preview", {"path": key})
    return ToolOutput({"status": "已打开预览", "path": ctx.display(key)}, f"预览 {ctx.display(key)}")


@tool("ui_download", "下载到本机", "browser", "read",
      "把文件或文件夹下载到用户的电脑：在对话中生成「下载」按钮，由用户点击后开始（多项或文件夹打包为 ZIP）。工具立即返回，不等待用户点击。",
      {"paths": {"type": "array", "items": {"type": "string"}, "description": "文件或文件夹路径（≤200 个）"}}, ("paths",))
async def ui_download(ctx: ToolContext, args: dict) -> ToolOutput:
    paths = args.get("paths")
    if not isinstance(paths, list) or not 1 <= len(paths) <= 200:
        raise ToolError("参数 paths 需要 1–200 个路径")
    items, size = [], 0
    for value in dict.fromkeys(paths):
        key = ctx.resolve(value)
        if not key or key == ctx.scope_root:
            raise ToolError("请指定具体的文件或文件夹")
        row = None if key.endswith("/") else ctx.db.execute("SELECT size FROM objects WHERE bucket_id=? AND key=?",
                                                           (ctx.bucket_id, key)).fetchone()
        if row is not None:
            items.append({"path": key, "folder": False})
            size += int(row["size"] or 0)
            continue
        folder = key.rstrip("/") + "/"
        stats = ctx.db.execute("SELECT COUNT(*), COALESCE(SUM(size),0) FROM objects WHERE bucket_id=? AND key>=? AND key<? "
                               "AND substr(key,-1)!='/'", (ctx.bucket_id, folder, folder + END)).fetchone()
        if not stats[0]:
            raise ToolError(f"{ctx.display(key)} 不存在或是空文件夹")
        items.append({"path": folder, "folder": True})
        size += int(stats[1])
    return ToolOutput({"status": "已在对话中显示下载按钮，等待用户点击", "items": len(items), "size": size},
                      f"准备下载 {len(items)} 项", items=len(items),
                      event={"type": "browser", "action": "download", "items": items, "size": size})


def shared_object(ctx: ToolContext, path: object):
    key = ctx.resolve(path, allow_root=False)
    row = ctx.db.execute("SELECT public_token, public_expires_at FROM objects WHERE bucket_id=? AND key=?",
                         (ctx.bucket_id, key)).fetchone()
    if row is None or not row["public_token"]:
        raise ToolError("该文件或文件夹尚未公开分享，请先由用户确认创建分享")
    if row["public_expires_at"] is not None and row["public_expires_at"] <= time.time():
        raise ToolError("该分享已过期，请在分享设置中调整有效期")
    return key, row


@tool("ui_open_share", "打开已有分享", "browser", "read",
      "为作用域内已公开分享的文件或文件夹显示「打开分享页」按钮，由用户点击后在新标签页打开。"
      "提供文件路径即可，无需知道分享令牌；不会创建分享，未公开或已过期时返回提示。",
      {"path": PATH}, ("path",))
async def ui_open_share(ctx: ToolContext, args: dict) -> ToolOutput:
    key, _ = shared_object(ctx, _str(args, "path", limit=1024))
    return ToolOutput({"status": "已显示打开分享页按钮，等待用户点击", "path": ctx.display(key)},
                      f"打开 {ctx.display(key)} 的分享页",
                      event={"type": "browser", "action": "share", "path": key, "conversation_id": ctx.conversation_id})


@tool("browser_open_url", "打开网页", "browser", "read",
      "在用户浏览器的新标签页打开一个外部网页（例如下载来源、相册页，方便用户登录或使用抓取脚本）。生成按钮由用户点击后打开；只允许 http(s)。",
      {"url": {"type": "string", "description": "网页地址"}, "title": {"type": "string", "description": "按钮上显示的简短说明"}}, ("url",))
async def browser_open_url(ctx: ToolContext, args: dict) -> ToolOutput:
    url = _str(args, "url", limit=2000)
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise ToolError("网页地址不正确") from exc
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise ToolError("只能打开 http(s) 网页，且地址中不能包含账号密码")
    title = _str(args, "title", limit=60)
    return ToolOutput({"status": "已在对话中显示打开按钮，等待用户点击", "host": parts.hostname}, f"打开 {parts.hostname}",
                      event={"type": "browser", "action": "open", "url": url, "host": parts.hostname, "title": title or None})


@tool("ui_copy", "复制到剪贴板", "browser", "read",
      "把一段文本（例如整理后的清单、命令、命名方案）放进可复制的卡片，用户点击后复制到剪贴板。",
      {"text": {"type": "string", "description": "要复制的文本（≤10000 字符）"}, "title": {"type": "string", "description": "卡片标题"}}, ("text",))
async def ui_copy(ctx: ToolContext, args: dict) -> ToolOutput:
    text = args.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 10000:
        raise ToolError("参数 text 需要 1–10000 个字符")
    title = _str(args, "title", limit=60)
    return ToolOutput({"status": "已在对话中显示复制按钮"}, title or "可复制的文本",
                      event={"type": "browser", "action": "copy", "text": text, "title": title or None})
