"""浏览器工具（docs/assistant-design.md §19.7）：在用户打开的 Tessera 页面里执行。

- 读取与跳转类（ui_get_view、ui_navigate、ui_select、ui_preview）：服务端校验参数后通过 ctx.client 发出 client_call 事件，
  由对话框执行并回传结果；对话框没有打开时返回「浏览器未连接」。
- 需要用户手势的动作（ui_download、browser_open_url、ui_copy）：浏览器不允许脚本自动下载、弹出新窗口或写剪贴板，
  所以只在对话里生成一张动作卡片，用户点击后执行；工具立即返回。
- ui_generate_thumbnails：缩略图只能在浏览器生成且大图计入用户空间，同样只生成卡片，由用户点击后在对话框里逐个生成。
- 路径一律经 ctx.resolve 校验在作用域内且不在 .tgdrive/；页面回传的数据同样按不可信数据包装。
- 私密对话（§24.5.4）：只由持有同一私密授权的抽屉执行，读取与跳转只作用于私密空间页面；
  打开网页只能用对话中出现过的完整地址，复制卡片完整显示文本。
"""

from __future__ import annotations

import time
from urllib.parse import urlsplit

from ..filekinds import kind_of
from .tools import END, PATH, ToolContext, ToolError, ToolOutput, _str, tool

VIEWS = {"files": "文件", "trash": "回收站", "downloads": "下载任务", "shared": "公开分享"}
PRIVATE_VIEWS = {"files": "私密空间", "trash": "私密回收站", "downloads": "私密下载任务"}


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
    if ctx.private:
        # 私密页面回传的是相对私密空间根的路径（也接受完整对象键）。
        key = key if key.startswith(ctx.base) else ctx.base + key
        return ctx.display(key) if key.startswith(ctx.scope_root) and ".." not in key.split("/") else None
    if key.startswith(".tgdrive/") or not key.startswith(ctx.scope_root):
        return None
    return "/" + key


@tool("ui_get_view", "读取当前页面", "browser", "read",
      "读取用户当前在 Tessera 里看到的页面：页面类型、所在目录、用户已选中的文件，以及当前页可见的条目（最多 200 个）。"
      "用户说「这些」「选中的」「这里」时先调用它。私密空间页面不会返回内容。", timeout=50)
async def ui_get_view(ctx: ToolContext, args: dict) -> ToolOutput:
    result = await _call(ctx, "ui_get_view", {})
    view = str(result.get("view") or "")[:20]
    if ctx.private and view != "private":
        # 私密对话只读取私密空间页面；用户在其他页面时不返回那里的条目。
        return ToolOutput({"view": view, "note": "用户当前不在私密空间页面，无法读取那里的内容"}, "不在私密空间页面")
    if not ctx.private and view == "private":
        return ToolOutput({"view": "private", "note": "用户正在私密空间，普通对话无法查看其中的内容；请用户在私密空间里打开助手（私密对话）"},
                          "私密空间（不开放）")
    if ctx.private:
        view = str(result.get("section") or "files")[:20]
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
    views = PRIVATE_VIEWS if ctx.private else VIEWS
    payload = {"view": view, "view_label": views.get(view, view), "path": path, "selected": selected, "visible": visible,
               "visible_total": result.get("total") if isinstance(result.get("total"), int) else len(visible),
               "preview": _inside(ctx, result.get("preview"))}
    if hidden > 0:
        payload["note"] = f"{hidden} 个选中项不在当前作用域内，已省略"
    label = views.get(view, view or "未知页面")
    return ToolOutput(payload, f"{label}{' ' + path if path else ''} · 已选中 {len(selected)} 项", items=len(visible))


@tool("ui_navigate", "打开页面", "browser", "read",
      "在用户的 Tessera 中打开页面：view=files 时打开 path 指定的目录（默认作用域根），也可以打开 trash 回收站、downloads 下载任务、"
      "shared 公开分享。用于把用户带到结果所在的位置。",
      {"view": {"type": "string", "enum": list(VIEWS), "description": "页面，默认 files"}, "path": PATH}, timeout=50)
async def ui_navigate(ctx: ToolContext, args: dict) -> ToolOutput:
    view = args.get("view") or "files"
    views = PRIVATE_VIEWS if ctx.private else VIEWS
    if view not in views:
        raise ToolError("参数 view 不正确" + ("：私密对话只能打开 files（私密空间）、trash（私密回收站）、downloads（私密下载任务）" if ctx.private else ""))
    path = ctx.resolve(args.get("path"), directory=True) if view == "files" else None
    if path is not None and path and ctx.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1",
                                                    (ctx.bucket_id, path, path + END)).fetchone() is None:
        raise ToolError(f"目录 {ctx.display(path)} 不存在")
    await _call(ctx, "ui_navigate", {"view": view, "path": path})
    return ToolOutput({"status": "已打开", "view": view, "path": ctx.display(path) if path is not None else None},
                      f"打开{views[view]}" + (f" {ctx.display(path)}" if path and path != ctx.base else ""))


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
    ctx.check_url(url, "seen")
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
                      event={"type": "browser", "action": "copy", "text": text, "title": title or None,
                             **({"private": True} if ctx.private else {})})


THUMBNAIL_KINDS = {"image", "video", "audio"}
THUMBNAIL_LIMIT = 300


@tool("ui_generate_thumbnails", "生成缩略图", "browser", "read",
      "为图片、视频和音乐补生成缩略图（列表小图、网格图与预览封面）。生成需要读取原文件，并且网格图与封面会计入用户空间，"
      "所以工具只在对话中显示「生成缩略图」卡片，由用户点击后提交给服务器后台生成，工具立即返回。path 可以是文件或目录；recursive 包含子目录；"
      "regenerate 时也重新生成已有但缺少网格图的旧版缩略图（例如用户觉得网格视图模糊）。单次最多 300 个文件。",
      {"path": PATH, "recursive": {"type": "boolean", "description": "目录是否包含子目录，默认否"},
       "regenerate": {"type": "boolean", "description": "是否重新生成缺少网格图的旧缩略图，默认否"}}, ("path",))
async def ui_generate_thumbnails(ctx: ToolContext, args: dict) -> ToolOutput:
    key = ctx.resolve(_str(args, "path", limit=1024))
    recursive, regenerate = args.get("recursive") is True, args.get("regenerate") is True
    single = None if key.endswith("/") or not key else ctx.db.execute(
        "SELECT key, size, etag, content_type, blob_uuid FROM objects WHERE bucket_id=? AND key=?", (ctx.bucket_id, key)).fetchone()
    if single is not None:
        rows = [single]
    else:
        folder = key.rstrip("/") + "/" if key else ctx.scope_root
        rows = ctx.db.execute("SELECT key, size, etag, content_type, blob_uuid FROM objects WHERE bucket_id=? AND key>=? AND key<? "
                              f"AND substr(key,-1)!='/' AND {ctx.hide()} ORDER BY key LIMIT 5000",
                              (ctx.bucket_id, folder, folder + END)).fetchall()
        if not rows and ctx.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1",
                                       (ctx.bucket_id, folder, folder + END)).fetchone() is None:
            raise ToolError(f"{ctx.display(folder)} 不存在")
        if not recursive:
            rows = [row for row in rows if "/" not in row["key"][len(folder):]]
    media = [row for row in rows if row["blob_uuid"] and kind_of(row["key"], row["content_type"]) in THUMBNAIL_KINDS]
    variants = ctx.objects.thumbnail_variants([row["blob_uuid"] for row in media])
    # 没有任何记录的需要生成；regenerate 时缺少网格图的（旧版 320px 小图、曾经失败的）也重新生成。
    todo = [row for row in media if not variants.get(row["blob_uuid"])
            or regenerate and "grid" not in variants[row["blob_uuid"]]]
    items = [{"path": row["key"], "size": int(row["size"] or 0), "etag": row["etag"], "content_type": row["content_type"]}
             for row in todo[:THUMBNAIL_LIMIT]]
    payload = {"media_files": len(media), "need": len(todo), "in_card": len(items)}
    if not items:
        return ToolOutput({**payload, "status": "没有需要生成缩略图的文件"}, "没有需要生成的缩略图")
    if len(todo) > len(items):
        payload["note"] = f"还有 {len(todo) - len(items)} 个文件，用户完成这一批后可以再调用一次"
    return ToolOutput({**payload, "status": "已在对话中显示生成缩略图卡片，等待用户点击"}, f"准备为 {len(items)} 个文件生成缩略图",
                      items=len(items), event={"type": "browser", "action": "thumbnails", "items": items,
                                                "regenerate": regenerate})


# ---------- 本机缓存（§26）：缓存只在用户浏览器里，服务端只负责校验路径并列出文件 ----------

CACHE_LIMIT = 300
CACHE_STATES = {"none", "partial", "auto", "manual", "caching"}
CACHE_PATHS = {"type": "array", "items": {"type": "string"}, "description": "文件或文件夹路径（≤200 个）"}


def _cache_rows(ctx: ToolContext, paths: object, *, recursive: bool, limit: int, required: bool = True) -> tuple[list, int]:
    """把文件与目录展开成作用域内的文件行（去重、跳过系统区），返回 (前 limit 行, 总数)。"""
    if paths is None and not required:
        return [], 0
    if not isinstance(paths, list) or not 1 <= len(paths) <= 200:
        raise ToolError("参数 paths 需要 1–200 个路径")
    rows: dict[str, object] = {}
    for value in dict.fromkeys(paths):
        key = ctx.resolve(value)
        single = None if not key or key.endswith("/") else ctx.db.execute(
            "SELECT key, size, etag, content_type FROM objects WHERE bucket_id=? AND key=?", (ctx.bucket_id, key)).fetchone()
        if single is not None:
            rows.setdefault(single["key"], single)
            continue
        folder = key.rstrip("/") + "/" if key else ctx.scope_root
        found = ctx.db.execute("SELECT key, size, etag, content_type FROM objects WHERE bucket_id=? AND key>=? AND key<? "
                               f"AND substr(key,-1)!='/' AND {ctx.hide()} ORDER BY key LIMIT 5000",
                               (ctx.bucket_id, folder, folder + END)).fetchall()
        if not recursive:
            found = [row for row in found if "/" not in row["key"][len(folder):]]
        if not found and ctx.db.execute("SELECT 1 FROM objects WHERE bucket_id=? AND key>=? AND key<? LIMIT 1",
                                        (ctx.bucket_id, folder, folder + END)).fetchone() is None:
            raise ToolError(f"{ctx.display(key)} 不存在")
        for row in found:
            rows.setdefault(row["key"], row)
    items = [row for row in rows.values() if row["etag"]]
    return items[:limit], len(items)


def _cache_item(row) -> dict:
    return {"path": row["key"], "size": int(row["size"] or 0), "etag": row["etag"], "content_type": row["content_type"]}


@tool("ui_cache_status", "查看本机缓存", "browser", "read",
      "查询这台设备（用户当前使用的浏览器）上的本机缓存：不传 paths 时只返回占用与上限；传入文件或文件夹时逐个返回缓存状态"
      "（none 未缓存、partial 部分、auto 自动缓存、manual 手动缓存、caching 正在缓存）。文件夹只看直接包含的文件，最多 200 个。",
      {"paths": CACHE_PATHS}, timeout=50)
async def ui_cache_status(ctx: ToolContext, args: dict) -> ToolOutput:
    rows, total = _cache_rows(ctx, args.get("paths"), recursive=False, limit=200, required=False)
    sent = {row["key"]: row for row in rows}
    result = await _call(ctx, "ui_cache_status", {"items": [_cache_item(row) for row in rows]})
    if result.get("available") is not True:
        reason = str(result.get("reason") or "这台设备不能使用本机缓存")[:200]
        return ToolOutput({"available": False, "reason": reason}, "本机缓存不可用")
    device = result.get("device") if isinstance(result.get("device"), dict) else {}
    number = lambda value: value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None
    payload: dict = {"available": True, "device": {
        "normal_bytes": number(device.get("normal_bytes")), "normal_limit_bytes": number(device.get("normal_limit_bytes")),
        "private_bytes": number(device.get("private_bytes")), "private_enabled": device.get("private_enabled") is True}}
    items, counts, reported = [], {}, set()
    for item in (result.get("items") or [])[:200]:
        if not isinstance(item, dict) or item.get("path") not in sent or item["path"] in reported:
            continue  # 只接受自己发出的路径，每个路径一次
        reported.add(item["path"])
        state = item.get("state") if item.get("state") in CACHE_STATES else "none"
        counts[state] = counts.get(state, 0) + 1
        entry = {"path": ctx.display(item["path"]), "state": state, "size": int(sent[item["path"]]["size"] or 0)}
        percent = number(item.get("percent"))
        if state in ("partial", "caching") and percent is not None:
            entry["percent"] = min(percent, 100)
        items.append(entry)
    if rows:
        payload["items"] = items
        payload["counts"] = counts
        if total > len(rows):
            payload["note"] = f"共 {total} 个文件，只查询了前 {len(rows)} 个"
    if result.get("private_note"):
        payload["private_note"] = str(result["private_note"])[:200]
    cached = sum(value for key, value in counts.items() if key != "none")
    return ToolOutput(payload, f"本机缓存：{cached} / {len(items)} 个文件已缓存" if rows else "本机缓存占用", items=len(items))


def _cache_card(ctx: ToolContext, args: dict, action: str) -> ToolOutput:
    rows, total = _cache_rows(ctx, args.get("paths"), recursive=args.get("recursive") is True, limit=CACHE_LIMIT)
    if not rows:
        return ToolOutput({"status": "没有可处理的文件"}, "没有文件")
    items = [_cache_item(row) for row in rows]
    size = sum(item["size"] for item in items)
    payload = {"status": "已在对话中显示卡片，等待用户点击", "files": len(items), "size": size}
    if total > len(items):
        payload["note"] = f"还有 {total - len(items)} 个文件，用户完成这一批后可以再调用一次"
    verb = "缓存" if action == "cache" else "清除缓存"
    return ToolOutput(payload, f"准备{verb} {len(items)} 个文件", items=len(items),
                      event={"type": "browser", "action": action, "items": items, "size": size, **({"private": True} if ctx.private else {})})


@tool("ui_cache_files", "缓存到本机", "browser", "read",
      "把文件保存到这台设备的本机缓存，之后预览和下载直接读取本机数据（适合即将离线使用或反复打开的文件）。"
      "会占用设备空间，所以只在对话中显示「缓存到本机」卡片，由用户点击后开始，工具立即返回。path 可以是文件或文件夹；"
      "recursive 包含子目录；单次最多 300 个文件。",
      {"paths": CACHE_PATHS, "recursive": {"type": "boolean", "description": "文件夹是否包含子目录，默认否"}}, ("paths",))
async def ui_cache_files(ctx: ToolContext, args: dict) -> ToolOutput:
    return _cache_card(ctx, args, "cache")


@tool("ui_clear_cache", "清除本机缓存", "browser", "read",
      "删除这台设备上指定文件的本机缓存（云端文件不受影响）。只在对话中显示「清除」卡片，由用户点击后执行，工具立即返回。"
      "参数同 ui_cache_files；单次最多 300 个文件。",
      {"paths": CACHE_PATHS, "recursive": {"type": "boolean", "description": "文件夹是否包含子目录，默认否"}}, ("paths",))
async def ui_clear_cache(ctx: ToolContext, args: dict) -> ToolOutput:
    return _cache_card(ctx, args, "uncache")
