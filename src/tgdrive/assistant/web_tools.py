"""网页与下载工具（docs/assistant-design.md §7.4、§9）以及 propose_downloads。

- 主 Agent 永远看不到网页原文：analyze_page 把结构摘要交给无工具的隔离调用（ctx.analyze），只返回经校验的规则摘要与样例。
- 结果集（解析结果、相册 URL）加密保存在 assistant_collections，24 小时过期；模型只拿到编号、统计与少量样例。
- collect_gallery 翻页抓取同源页面，请求间隔不少于 1 秒；快照模式只在快照内提取，不发任何请求。
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
import time
from urllib.parse import urlsplit

from ..offline.http import DownloadError
from ..offline.request import checked_url, filename, url_filename
from . import web
from .config import LIMITS, batch_limit
from .tools import ToolContext, ToolError, ToolOutput, _int, _str, tool
from .write_tools import _propose, render_name

SAMPLE = 5


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def _record(ctx: ToolContext, collection_id: str, *, kind: str | None = None) -> dict:
    if ctx.trace is None:
        raise ToolError("当前无法读取结果集")
    try:
        record = ctx.trace.collection(ctx.user_id, collection_id, kind=kind)
    except Exception as exc:
        raise ToolError(f"找不到结果集 {collection_id}（可能已过期，结果集保留 24 小时）") from exc
    if record["conversation_id"] != ctx.conversation_id:
        raise ToolError(f"结果集 {collection_id} 不属于当前对话")
    return record


async def _fetch_page(ctx: ToolContext, url: str, *, referer: str | None = None, same_origin: str | None = None, structure: bool = False) -> dict:
    """同一轮复用页面，避免分析、收集链接与收集图片时重复请求；最多 32 页、合计 16 MB、十分钟（§38）。"""
    cache = ctx.state.setdefault("web_pages", {})
    cache_key = (url, "structure") if structure else url
    cached = cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < 600:
        return cached[1]
    started = time.time()
    try:
        options = {"same_origin": same_origin} if same_origin is not None else {}
        if structure:
            options["structure"] = True
        page = await web.fetch_page(ctx.offline.http, url, referer=referer, **options)
    except (DownloadError, ValueError):
        ctx.trace.log_call(kind="fetch", user_id=ctx.user_id, conversation_id=ctx.conversation_id, host=urlsplit(url).hostname,
                           started_at=started, duration_ms=int((time.time() - started) * 1000), status="error", error="网页抓取失败")
        raise
    ctx.trace.log_call(kind="fetch", user_id=ctx.user_id, conversation_id=ctx.conversation_id, host=urlsplit(url).hostname,
                       started_at=started, duration_ms=int((time.time() - started) * 1000), status="ok", items=len(page["images"]))
    size = len(json.dumps(page, ensure_ascii=False).encode())
    if size <= 4 * 1024 * 1024:
        cache.pop(cache_key, None)
        while cache and (len(cache) >= 32 or sum(entry[2] for entry in cache.values()) + size > 16 * 1024 * 1024):
            cache.pop(next(iter(cache)))
        cache[cache_key] = (time.monotonic(), page, size)
    return page


@tool("parse_download_source", "识别下载链接", "web", "read",
      "识别用户给出的下载链接（文件直链、M3U8、X 帖子、YouTube 视频，或 curl/wget 命令，多个链接每行一个，数量上限由管理员配置，0 为不限），"
      "返回可下载的文件、大小与清晰度选项，以及结果集编号 collection_id；之后用 propose_downloads(collection_id, indices) 生成下载提议。",
      {"text": {"type": "string", "description": "链接或命令文本，最多 256 KiB"}}, ("text",),
      params={"max_urls": (32, 0, 1000, "单次最多识别链接数（0 为不限）")})
async def parse_download_source(ctx: ToolContext, args: dict) -> ToolOutput:
    if ctx.offline is None:
        raise ToolError("离线下载未启用")
    text = _str(args, "text", limit=262144)
    if not text:
        raise ToolError("请提供链接")
    # 普通和私密对话均可解析当前任务所需的链接或请求配置；连接由离线请求层校验。
    ctx.check_url(text, "text")
    try:
        parsed = await ctx.offline.parse(ctx.user_id, text, max_urls=int(ctx.params.get("max_urls", 32)), multiple_platforms=True)
    except (ValueError, DownloadError) as exc:
        raise ToolError(f"无法识别：{exc}") from exc
    candidates = parsed["candidates"]
    if ctx.taint is not None:
        ctx.taint("解析了外部链接")
    collection_id = ctx.trace.create_collection(ctx.conversation_id, ctx.user_id, "collection", source=None,
                                                rule={"type": "parsed"}, urls=candidates, count=len(candidates), ttl=1200)
    view = [{"index": index, "name": item["name"], "size": item.get("size"), "variant": item.get("variant"), "kind": item.get("kind"),
             "platform": item.get("platform"), "source_host": item.get("source_host"), "group": item.get("group"),
             "warnings": item.get("warnings") or []} for index, item in enumerate(candidates)]
    return ToolOutput({"collection_id": collection_id, "candidates": view,
                       "note": "同一 group 的多个候选是同一媒体的不同清晰度，通常只选一个。解析结果 20 分钟内有效。"},
                      f"{len(candidates)} 个可下载文件", items=len(candidates))


@tool("inspect_page", "分析网页结构", "web", "read",
      "分析通用网页的 HTML 结构：语义布局、标题层级、表格、链接和分页候选；页面没有图片也可使用。"
      "section 默认 overview 返回概览，其余分区用 offset/next_offset 翻页；tables 指定 table_index 后读取该表格的行。"
      "不执行 JavaScript，不读取浏览器登录状态，也不提供实际 CSS 坐标。需要图片下载规则时使用 analyze_page。",
      {"url": {"type": "string", "description": "完整公共 HTTP(S) 网页地址"},
       "section": {"type": "string", "enum": ["overview", "layout", "headings", "links", "tables", "pagination"]},
       "table_index": {"type": "integer", "description": "tables 分区的表格编号，从 0 开始；省略时列出表格概览"},
       "offset": {"type": "integer", "description": "分区或表格行的起始位置，默认 0"},
       "limit": {"type": "integer", "description": "本次返回项数，默认 50，上限由管理员设置"}}, ("url",),
      params={"max_results": (200, 10, 2000, "单次最多返回项数")})
async def inspect_page(ctx: ToolContext, args: dict) -> ToolOutput:
    if ctx.offline is None:
        raise ToolError("离线下载未启用，无法访问网页")
    url = _str(args, "url", limit=web.URL_BYTES)
    ctx.check_url(url, "page")
    section = args.get("section", "overview")
    if section not in ("overview", "layout", "headings", "links", "tables", "pagination"):
        raise ToolError("网页结构分区不正确")
    high = int(ctx.params.get("max_results", 200))
    offset, limit = _int(args, "offset", 0, 0, 10**6), _int(args, "limit", min(50, high), 1, high)
    try:
        page = await _fetch_page(ctx, checked_url(url), structure=True)
    except (DownloadError, ValueError) as exc:
        raise ToolError(f"无法获取页面：{exc}") from exc
    if ctx.taint:
        ctx.taint("分析了网页结构")
    structure = page["structure"]
    links = page.get("links", [])
    pagination = [link for link in links if set(link.get("rel", "").split()) & {"next", "prev"}
                  or web.NEXT_TEXT.fullmatch(link.get("text", "")) or link.get("text", "").strip().isdigit()
                  or link.get("text", "").strip().lower() in ("上一页", "上页", "首页", "末页", "previous", "prev")]
    tables = [{key: value for key, value in table.items() if key != "rows"} for table in structure["tables"]]
    payload = {"url": page["url"], "title": page["title"], "source": "static_html", "scripts_executed": False,
               "section": section, "truncated": structure["truncated"] or len(links) >= 5000,
               "note": "HTML 结构不能代表渲染后的视觉布局或 JavaScript 动态内容；分页链接为候选，需按实际页面核对。"}
    if section == "overview":
        payload.update(counts={"layout": len(structure["layout"]), "headings": len(structure["headings"]),
                               "tables": len(tables), "links": len(links), "pagination": len(pagination)},
                       layout=structure["layout"][:10], headings=structure["headings"][:20], tables=tables[:10],
                       pagination=pagination[:10], links=links[:10],
                       next="使用 section=layout/headings/links/tables/pagination 查看完整分区；表格行使用 table_index")
    else:
        values = {"layout": structure["layout"], "headings": structure["headings"], "links": links,
                  "tables": tables, "pagination": pagination}[section]
        if args.get("table_index") is not None:
            index = _int(args, "table_index", 0, 0, 49)
            if section != "tables" or index >= len(tables):
                raise ToolError("表格编号不正确，请先查看 tables 分区")
            values = structure["tables"][index]["rows"]
            payload["table"] = tables[index]
        payload.update(items=values[offset:offset + limit], total=len(values), offset=offset,
                       next_offset=offset + limit if offset + limit < len(values) else None)
    return ToolOutput(payload, f"{page['title'][:30] or _origin(page['url'])} · {section}", items=len(payload.get("items", [])))


def _following(page: dict, visited: set[str], start: str, number: int) -> str | None:
    """通用翻页：rel=next、「下一页」类文字，或文字是下一个页码的同源链接（§38）。"""
    origin = _origin(start)
    candidates = [link for link in page.get("links", []) if link["href"] not in visited and _origin(link["href"]) == origin]
    for test in (lambda link: "next" in link.get("rel", "").split(), lambda link: bool(web.NEXT_TEXT.fullmatch(link.get("text", ""))),
                 lambda link: link.get("text", "").strip() == str(number + 1)):
        found = next((link["href"] for link in candidates if test(link)), None)
        if found:
            return found
    return None


@tool("collect_links", "收集链接", "web", "read",
      "从列表页收集符合条件的链接（例如相册列表里的每个相册、文章列表里的每篇文章），可按「下一页」翻页（只走同一网站），"
      "去重后保存为结果集并返回 collection_id，不需要把链接逐个记在对话里。先用 inspect_page 的 links 分区确认目标链接的 path "
      "或网址规律，再用 path、href_glob、text_contains 选择（同时给出时都要满足）。之后可以把结果集交给 collect_gallery(albums=…)，"
      "或用 get_collection 分批查看。",
      {"url": {"type": "string", "description": "列表第一页的地址"},
       "path": {"type": "string", "description": "链接在页面中的位置（inspect_page 链接的 path 原样）"},
       "href_glob": {"type": "string", "description": "链接地址通配符，如 https://example.com/album/*"},
       "text_contains": {"type": "string", "description": "链接文字包含的内容"},
       "follow": {"type": "boolean", "description": "是否按下一页继续收集，默认 true"},
       "max_pages": {"type": "integer", "description": "最多翻页数，默认与上限为管理员设置"}},
      ("url",), timeout=120,
      params={"max_pages": (20, 1, 200, "最多翻页数"), "max_links": (2000, 10, 20000, "最多链接数"),
              "delay_ms": (1000, 1000, 10000, "翻页间隔（毫秒）")})
async def collect_links(ctx: ToolContext, args: dict) -> ToolOutput:
    if ctx.offline is None or ctx.trace is None:
        raise ToolError("离线下载未启用，无法访问网页")
    url = _str(args, "url", limit=web.URL_BYTES)
    ctx.check_url(url, "page")
    try:
        start = checked_url(url)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    path, glob, text = (_str(args, name, limit=500) for name in ("path", "href_glob", "text_contains"))
    if not (path or glob or text):
        raise ToolError("请至少给出 path、href_glob、text_contains 中的一个筛选条件")
    follow = args.get("follow", True) is not False
    high = int(ctx.params.get("max_pages", 20))
    max_pages = _int(args, "max_pages", high, 1, high) if follow else 1
    max_links = int(ctx.params.get("max_links", 2000))
    delay = max(1.0, int(ctx.params.get("delay_ms", 1000)) / 1000)
    if ctx.taint is not None:
        ctx.taint("分析了网页")

    def wanted(link: dict) -> bool:
        return (not path or link.get("path") == path) and (not glob or fnmatch.fnmatchcase(link["href"], glob)) \
            and (not text or text.lower() in link.get("text", "").lower())

    deadline = time.monotonic() + 105
    found: list[dict] = []
    seen: set[str] = set()
    visited: set[str] = set()
    current, pages, stopped, complete = start, 0, None, True
    while current and pages < max_pages:
        if time.monotonic() > deadline:
            stopped, complete = "运行时间到达上限", False
            break
        if pages:
            await asyncio.sleep(delay)
        visited.add(current)
        try:
            page = await _fetch_page(ctx, current, referer=start, same_origin=start)
        except (DownloadError, ValueError) as exc:
            if pages == 0:
                raise ToolError(f"无法获取页面：{exc}") from exc
            stopped, complete = f"第 {pages + 1} 页获取失败（{exc}）", False
            break
        pages += 1
        before = len(found)
        for link in page.get("links", []):
            if link["href"] in seen or link["href"] in visited or not wanted(link):
                continue
            seen.add(link["href"])
            found.append({"url": link["href"], "text": link.get("text", "")[:120], "referer": page["url"]})
            if len(found) >= max_links:
                break
        if len(found) >= max_links:
            stopped, complete = "达到链接数上限", False
            break
        if pages > 1 and len(found) == before:
            stopped = "这一页没有新的链接，判断为最后一页"
            break
        current = _following(page, visited, start, pages) if follow else None
    if current and pages >= max_pages and not stopped and follow:
        stopped, complete = "达到页数上限", False
    if not found:
        raise ToolError("没有找到符合条件的链接；请用 inspect_page 的 links 分区核对 path 或网址规律")
    collection_id = ctx.trace.create_collection(ctx.conversation_id, ctx.user_id, "collection", source=_origin(start),
                                                rule={"type": "links", "start_url": start}, urls=found, count=len(found))
    return ToolOutput({"collection_id": collection_id, "count": len(found), "pages": pages,
                       "samples": [{"url": item["url"], "text": item["text"]} for item in found[:SAMPLE * 2]],
                       "stopped": stopped, "complete": complete,
                       "next": "用 collect_gallery(collection_id=<相册规则>, albums=本结果集) 收集每个链接里的图片，或 get_collection 分批查看"},
                      f"{pages} 页 · {len(found)} 个链接" + (f"（{stopped}）" if stopped else ""), items=len(found))


@tool("analyze_page", "分析相册", "web", "read",
      "分析网页相册：抓取页面（或使用抓取脚本发来的快照 snapshot_id），由隔离的结构分析找出主体图片与分页方式，"
      "返回规则摘要、第一页样例和 collection_id。不会返回网页原文。之后用 collect_gallery(collection_id) 收集全部页面的图片。",
      {"url": {"type": "string", "description": "网页地址（http/https）"},
       "snapshot_id": {"type": "string", "description": "用户通过抓取脚本发来的页面快照编号"},
       "goal": {"type": "string", "description": "用户想保存什么，例如「相册里的大图」"}}, ("goal",))
async def analyze_page(ctx: ToolContext, args: dict) -> ToolOutput:
    if ctx.analyze is None or ctx.trace is None:
        raise ToolError("当前无法分析网页")
    if ctx.taint is not None:
        ctx.taint("分析了网页")
    url, snapshot_id = _str(args, "url", limit=web.URL_BYTES), _str(args, "snapshot_id", limit=40)
    goal = _str(args, "goal", limit=300) or "保存页面中的主体图片"
    if bool(url) == bool(snapshot_id):
        raise ToolError("请在 url 与 snapshot_id 中二选一")
    if snapshot_id and ctx.private:
        raise ToolError("处理私密空间时不接受抓取脚本的页面快照，请让用户在消息里给出网页链接")
    if url:
        ctx.check_url(url.strip(), "page")
    if snapshot_id:
        snapshot = _record(ctx, snapshot_id, kind="snapshot")
        pages, start_url, source = snapshot["urls"], snapshot["urls"][0]["url"], snapshot["source"]
    else:
        if ctx.offline is None:
            raise ToolError("离线下载未启用，无法访问网页")
        try:
            start_url = checked_url(url)
        except ValueError as exc:
            raise ToolError(str(exc)) from exc
        try:
            page = await _fetch_page(ctx, start_url)
        except (DownloadError, ValueError) as exc:
            raise ToolError(f"无法获取页面：{exc}。如果页面需要登录或验证，建议用户在该页面打开 Tessera 抓取脚本，点击「发给文件助手」。") from exc
        pages, source = [page], _origin(page["url"])
        start_url = page["url"]
    summary, clusters, links = web.summarize(pages)
    if not clusters:
        raise ToolError("页面没有可识别的图片（可能由 JavaScript 动态加载或需要登录）。建议用户在该页面打开 Tessera 抓取脚本，点击「发给文件助手」。")
    max_pages = int(ctx.params.get("max_pages", 100))
    try:
        raw = await ctx.analyze(summary, goal)
        rule = web.validate_rule(raw, clusters, links, start_url, max_pages=max_pages)
    except ValueError as exc:
        raise ToolError(f"无法确定图片规则：{exc}。可以请用户描述想保存哪些图片后重试。") from exc
    first = web.extract(pages[0], rule)
    if snapshot_id:
        rule["pagination"] = {"type": "snapshot", "pages": len(pages)}
    rule.update(start_url=start_url, snapshot_id=snapshot_id or None, goal=goal)
    collection_id = ctx.trace.create_collection(ctx.conversation_id, ctx.user_id, "collection", source=source, rule=rule,
                                                urls=[{"url": item, "referer": pages[0]["url"]} for item in first], count=len(first))
    pagination = {"none": "没有分页", "next_link": f"按「{rule['pagination'].get('text') or '下一页'}」链接翻页",
                  "url_pattern": f"按页码 {rule['pagination'].get('pattern', '')}", "snapshot": f"快照内共 {len(pages)} 页"}[rule["pagination"]["type"]]
    return ToolOutput({"collection_id": collection_id, "title": summary["title"], "source": source,
                       "images": {"element": rule["images"]["path"], "attribute": rule["images"]["attr"],
                                  "transform": rule["images"]["transform"]},
                       "pagination": pagination, "first_page_count": len(first), "samples": first[:SAMPLE],
                       "confidence": rule["confidence"], "notes": rule["notes"],
                       "next": "调用 collect_gallery 收集全部页面" if rule["pagination"]["type"] != "none" or snapshot_id and len(pages) > 1
                       else "页面没有分页，可直接用 propose_downloads 保存"},
                      f"{summary['title'][:30] or source} · 第一页 {len(first)} 张", items=len(first))


@tool("collect_gallery", "抓取相册", "web", "read",
      "按 analyze_page 得到的规则翻页收集图片地址（只访问与起始页同源的分页，请求间隔不少于 1 秒；快照模式不发请求），"
      "去重后保存到结果集，返回总数、页数与样例；complete 表示是否正常遍历结束，stopped 说明结束原因。"
      "多个结构相同的相册：先用 analyze_page 分析其中一个，再传 albums（collect_links 的结果集编号）或 album_urls（地址列表），"
      "用同一条规则逐个收集，图片记录所属相册；一次调用处理不完时返回 progress，用同一个 collection_id 再次调用即可继续。"
      "目标链接来自列表页时，可先用 inspect_page 确认链接结构，再用 collect_links 收集目标相册链接；结构相同的相册不必逐个重复分析。"
      "之后用 propose_downloads(collection_id) 生成下载提议。",
      {"collection_id": {"type": "string", "description": "analyze_page 返回的结果集编号"},
       "albums": {"type": "string", "description": "多个相册：collect_links 返回的链接结果集编号"},
       "album_urls": {"type": "array", "items": {"type": "string"}, "description": "多个相册：相册地址列表（≤500），与 albums 二选一"},
       "max_pages": {"type": "integer", "description": "每个相册最多翻页数，默认与上限为管理员设置"},
       "ext": {"type": "array", "items": {"type": "string"}, "description": "只保留这些扩展名，如 [\"jpg\",\"png\"]"},
       "min_width": {"type": "integer", "description": "只保留 HTML 中声明宽度不小于该值的图片（未声明的保留）"}},
      ("collection_id",), depends=("analyze_page",), timeout=120,
      params={"max_pages": (100, 1, 500, "最多翻页数"), "max_images": (20000, 100, 20000, "最多图片数"),
              "delay_ms": (1000, 1000, 10000, "翻页间隔（毫秒）")})
async def collect_gallery(ctx: ToolContext, args: dict) -> ToolOutput:
    record = _record(ctx, _str(args, "collection_id", limit=40), kind="collection")
    rule = record["rule"] or {}
    if rule.get("type") == "links":
        raise ToolError("这是链接结果集：请把它作为 albums 传入，collection_id 使用 analyze_page 返回的相册规则")
    if rule.get("type") == "parsed" or "images" not in rule:
        raise ToolError("这个结果集不是网页相册，不需要收集")
    max_pages = _int(args, "max_pages", int(ctx.params.get("max_pages", 100)), 1, int(ctx.params.get("max_pages", 100)))
    max_images = int(ctx.params.get("max_images", 20000))
    delay = max(1.0, int(ctx.params.get("delay_ms", 1000)) / 1000)
    exts = args.get("ext")
    if exts is not None and (not isinstance(exts, list) or not all(isinstance(e, str) and 0 < len(e) <= 8 for e in exts)):
        raise ToolError("参数 ext 不正确")
    exts = {e.lower().lstrip(".") for e in exts or []}
    min_width = _int(args, "min_width", 0, 0, 20000)

    def select(page: dict) -> list[str]:
        """按规则取出这一页的图片地址，再按扩展名与声明宽度过滤。"""
        chosen = {**page, "images": [image for image in page.get("images", []) if not min_width or not image.get("w") or image["w"] >= min_width]}
        return [url for url in web.extract(chosen, rule) if not exts or urlsplit(url).path.rsplit(".", 1)[-1].lower() in exts]

    if args.get("albums") is not None and args.get("album_urls") is not None:
        raise ToolError("albums 与 album_urls 二选一")
    albums = args.get("albums") if args.get("albums") is not None else args.get("album_urls")
    if albums is not None or rule.get("batch"):
        return await _collect_albums(ctx, record, rule, albums, select=select, max_pages=max_pages,
                                     max_images=max_images, delay=delay)
    deadline = time.monotonic() + 105
    urls: list[dict] = []
    seen: set[str] = set()
    pages_done, stopped = 0, None
    complete = True

    def keep(page: dict) -> None:
        for url in select(page):
            if url not in seen:
                seen.add(url)
                urls.append({"url": url, "referer": page["url"]})

    if rule["pagination"]["type"] == "snapshot":
        snapshot = _record(ctx, rule["snapshot_id"], kind="snapshot")
        for page in snapshot["urls"][:max_pages]:
            keep(page)
            pages_done += 1
            if len(urls) >= max_images:
                stopped, complete = "达到图片数上限", False
                break
        if not stopped and pages_done < len(snapshot["urls"]):
            stopped, complete = "达到页数上限", False
    else:
        start = rule["start_url"]
        start_origin = _origin(start)
        visited: set[str] = set()
        queue: list[str] = [start]
        pattern = rule["pagination"] if rule["pagination"]["type"] == "url_pattern" else None
        if pattern:
            queue += [pattern["pattern"].replace("{page}", str(n)) for n in range(pattern["start"], pattern["end"] + 1)]
        while queue and pages_done < max_pages:
            url = queue.pop(0)
            if url in visited or _origin(url) != start_origin:
                continue
            if time.monotonic() > deadline:
                stopped, complete = "运行时间到达上限", False
                break
            if pages_done:
                await asyncio.sleep(delay)
            visited.add(url)
            try:
                page = await _fetch_page(ctx, url, referer=start, same_origin=start)
            except (DownloadError, ValueError) as exc:
                if pages_done == 0:
                    raise ToolError(f"无法获取页面：{exc}") from exc
                stopped, complete = f"第 {pages_done + 1} 页获取失败（{exc}）", False
                break
            pages_done += 1
            before = len(urls)
            keep(page)
            if len(urls) >= max_images:
                stopped, complete = "达到图片数上限", False
                break
            if pages_done > 1 and len(urls) == before:
                stopped = "这一页没有新图片，判断为最后一页"
                break
            following = web.next_page(page, rule, visited, start)
            if following and not pattern:
                queue.append(following)
        if not stopped and queue and pages_done >= max_pages:
            stopped, complete = "达到页数上限", False
    urls = urls[:max_images]
    ctx.trace.update_collection(record["id"], urls=urls)
    return ToolOutput({"collection_id": record["id"], "pages": pages_done, "count": len(urls),
                       "samples": [item["url"] for item in urls[:SAMPLE]], "stopped": stopped, "complete": complete},
                      f"{pages_done} 页 · {len(urls)} 张图片" + (f"（{stopped}）" if stopped else ""), items=len(urls))


MAX_ALBUMS = 500


def _album_urls(ctx: ToolContext, albums: object) -> list[str]:
    """albums 参数：collect_links 的结果集编号，或地址列表。"""
    if isinstance(albums, str):
        record = _record(ctx, albums, kind="collection")
        if (record["rule"] or {}).get("type") != "links":
            raise ToolError("albums 需要 collect_links 返回的链接结果集，或相册地址列表")
        values = [item["url"] for item in record["urls"]]
    elif isinstance(albums, list) and all(isinstance(item, str) for item in albums):
        values = []
        for item in albums:
            ctx.check_url(item.strip(), "page")
            try:
                values.append(checked_url(item.strip()))
            except ValueError as exc:
                raise ToolError(f"相册地址 {item[:80]} 不正确：{exc}") from exc
    else:
        raise ToolError("albums 需要链接结果集编号或地址列表")
    values = list(dict.fromkeys(values))
    if not values:
        raise ToolError("没有要收集的相册")
    if len(values) > MAX_ALBUMS:
        raise ToolError(f"一次最多 {MAX_ALBUMS} 个相册（当前 {len(values)} 个），请分批传入地址列表")
    return values


def _album_pattern(rule: dict, album: str):
    """把分析时得到的页码规则套用到另一个相册：规则以原相册地址开头时替换为新地址，否则不能套用。"""
    pagination = rule["pagination"]
    if pagination["type"] != "url_pattern":
        return None
    base = rule["start_url"].split("#", 1)[0].split("?", 1)[0].rstrip("/")
    if not pagination["pattern"].startswith(base):
        return None
    tail = pagination["pattern"][len(base):]
    root = album.split("#", 1)[0].split("?", 1)[0].rstrip("/")
    return lambda number: (root + tail).replace("{page}", str(number))


async def _collect_albums(ctx: ToolContext, record: dict, rule: dict, albums: object, *, select, max_pages: int,
                          max_images: int, delay: float) -> ToolOutput:
    """多个相册（§38）：同一条规则逐个相册翻页；进度保存在结果集里，一次调用处理不完时下次接着做。"""
    if rule["pagination"]["type"] == "snapshot":
        raise ToolError("抓取脚本快照得到的规则不能用于多个相册，请用网页地址重新 analyze_page")
    batch = rule.get("batch")
    entries = list(record["urls"])
    if albums is not None:
        urls = _album_urls(ctx, albums)
        if not batch or batch["albums"] != urls:
            batch, entries = {"albums": urls, "next": 0, "failed": [], "names": [], "partial": [], "current": None}, []
    if not batch:
        raise ToolError("请传入 albums")
    seen = {entry["url"] for entry in entries}
    deadline = time.monotonic() + 105
    started_at, added, stopped = batch["next"], 0, None
    while batch["next"] < len(batch["albums"]):
        if len(entries) >= max_images:
            stopped = "达到图片数上限"
            break
        if time.monotonic() > deadline - 3:
            break
        index = batch["next"]
        album = batch["albums"][index]
        current = batch["current"] if batch.get("current") and batch["current"]["index"] == index else {"index": index, "name": None}
        batch["current"] = current
        pattern = _album_pattern(rule, album)
        origin = _origin(album)
        visited: set[str] = set()
        queue, pages, matched, error, timed_out = [album], 0, 0, None, False
        while queue and pages < max_pages:
            url = queue.pop(0)
            if url in visited or _origin(url) != origin:
                continue
            if time.monotonic() > deadline:
                timed_out = True
                break
            if pages:
                await asyncio.sleep(delay)
            visited.add(url)
            try:
                page = await _fetch_page(ctx, url, referer=album, same_origin=album)
            except (DownloadError, ValueError) as exc:
                if pages == 0:
                    error = f"无法获取页面（{str(exc)[:120]}）"
                break
            pages += 1
            if current["name"] is None:
                # 相册名取第一页标题，清理成合法文件夹名；重名加序号。
                title = (page.get("title") or "").strip()[:80].replace("/", "／").replace("\\", "＼")
                base = filename(title, fallback=f"相册{index + 1}") or f"相册{index + 1}"
                name, number = base, 2
                while name in batch["names"]:
                    name, number = f"{base} ({number})", number + 1
                current["name"] = name
                batch["names"].append(name)
            found = select(page)
            matched += len(found)
            fresh = 0
            for image in found:
                if image not in seen:
                    seen.add(image)
                    entries.append({"url": image, "referer": page["url"], "album": current["name"]})
                    fresh += 1
            added += fresh
            if not found or pages > 1 and not fresh or len(entries) >= max_images:
                break
            following = web.next_page(page, rule, visited, album) if rule["pagination"]["type"] == "next_link" \
                else pattern(rule["pagination"]["start"] + pages - 1) if pattern else None
            if following:
                queue.append(following)
        if timed_out and index > started_at:
            break  # 这个相册下次从头再走（已收集的图片按地址去重）
        if error or not matched:
            batch["failed"] = (batch["failed"] + [{"url": album, "reason": error or "第一页没有符合规则的图片，结构可能不同"}])[-50:]
        elif timed_out:
            batch["partial"] = (batch["partial"] + [{"url": album, "name": current["name"], "pages": pages}])[-50:]
        batch["next"] = index + 1
        batch["current"] = None
    entries = entries[:max_images]
    total = len(batch["albums"])
    done = batch["next"]
    complete = done >= total and not stopped
    ctx.trace.update_collection(record["id"], urls=entries, rule={**rule, "batch": batch})
    progress = {"albums": total, "done": done, "remaining": total - done, "failed": len(batch["failed"]),
                "this_call": {"albums": done - started_at, "images": added}}
    return ToolOutput({"collection_id": record["id"], "count": len(entries), "progress": progress, "complete": complete,
                       "stopped": stopped, "failed_samples": batch["failed"][:5], "partial": batch["partial"][:5],
                       "albums_named": len(batch["names"]), "samples": [item["url"] for item in entries[-SAMPLE:]],
                       "next": None if complete or stopped else f"还有 {total - done} 个相册，用同一个 collection_id 再次调用 collect_gallery 继续"},
                      f"相册 {done}/{total} · {len(entries)} 张图片" + (f"（{stopped}）" if stopped else "")
                      + (f"，{len(batch['failed'])} 个失败" if batch["failed"] else ""), items=added)


@tool("get_collection", "查看结果集", "web", "read",
      "分页读取结果集。count 是总项数，returned 是本次项数，每项 index 是从 0 起的稳定序号；offset 默认 0。"
      "每页大小由管理员设置并受工具结果预算约束；只从 next_offset 继续，null 表示本页之后没有下一页。"
      "已读页面不必反复读取；按稳定序号和条目内容核对任务进度，不能把显示序号与 offset 混用。",
      {"collection_id": {"type": "string"}, "offset": {"type": "integer", "description": "从 0 起的条目序号；续读使用返回的 next_offset"}},
      ("collection_id",), depends=("analyze_page",), params={"max_results": (200, 10, 2000, "单次最多返回项数")})
async def get_collection(ctx: ToolContext, args: dict) -> ToolOutput:
    record = _record(ctx, _str(args, "collection_id", limit=40))
    offset = _int(args, "offset", 0, 0, 10**6)
    size = int(ctx.params.get("max_results", 200))
    items = record["urls"] if record["kind"] == "collection" else []
    page = items[offset:offset + size]
    kind = {"parsed": "parsed", "links": "links"}.get((record["rule"] or {}).get("type"), "gallery")
    view = []
    for index, item in enumerate(page, offset):
        if "ticket" in item:
            entry = {"name": item.get("name"), "size": item.get("size"), "variant": item.get("variant")}
        elif kind == "links":
            entry = {"url": item.get("url"), "text": item.get("text")}
        else:
            entry = {"url": item.get("url"), **({"album": item["album"]} if item.get("album") else {})}
        view.append({"index": index, **entry})
    budget = int(ctx.limits.get("tool_result_bytes", LIMITS["tool_result_bytes"][0]))
    # 先按实际返回项数决定游标，避免通用裁剪删掉条目后让下一页跳过尚未读到的内容。
    while True:
        returned = len(view)
        payload = {"collection_id": record["id"], "kind": kind, "source": record["source"], "count": len(items),
                   "offset": offset, "returned": returned, "items": view,
                   "next_offset": offset + returned if offset + returned < len(items) else None}
        if len(json.dumps(payload, ensure_ascii=False).encode()) <= budget:
            break
        if returned <= 1:
            raise ToolError("单个结果集条目超过工具结果预算，请提高统一工具结果预算")
        view = view[:returned // 2]
    summary = f"共 {len(items)} 项 · " + (f"本次第 {offset + 1}–{offset + returned} 项" if returned else "本次无条目")
    return ToolOutput(payload, summary, items=returned)


@tool("propose_downloads", "离线下载", "write", "write",
      "生成创建离线下载任务的待确认操作。来源三选一：collection_id（analyze_page/collect_gallery 的相册结果，或 parse_download_source "
      "的解析结果，可用 indices 选择其中几项，或用 offset/limit 选一段）、urls（直链列表）。target 为保存目录。name_template 可选，变量 {name} {stem} {ext} {n}"
      "（如 {n:03}{ext}）；默认使用链接里的文件名。多个相册的结果集可设 by_album=true，按相册保存到「target/相册名/」。"
      "超过单次上限时按 offset/limit 分批提议，结果里的 next_offset 是下一批的起点。已有文件直链可直接传 urls，无需逐条重新解析；"
      "当前提议上限见参数定义，在上限内优先一次提交已确认的条目；后台会自动分批入队并控制实际并发，无需按底层接口批次拆分。"
      "续接时核对已成功提交的部分，避免重复提议。",
      {"collection_id": {"type": "string"}, "indices": {"type": "array", "items": {"type": "integer"}, "description": "只选结果集中的这些序号"},
       "offset": {"type": "integer", "description": "从结果集的第几项开始（与 indices 二选一）"},
       "limit": {"type": "integer", "description": "这一批最多几项，默认为单次上限"},
       "by_album": {"type": "boolean", "description": "按相册分子目录保存（结果集由 collect_gallery 的多个相册得到时）"},
       "urls": {"type": "array", "items": {"type": "string"}, "description": "文件直链（http/https）"},
       "target": {"type": "string", "description": "保存目录"},
       "name_template": {"type": "string"}}, ("target",),
      input_limits={name: ("download_urls", "action_items") for name in ("urls", "indices", "limit")})
async def propose_downloads(ctx: ToolContext, args: dict) -> ToolOutput:
    if ctx.offline is None:
        raise ToolError("离线下载未启用")
    target = ctx.resolve(_str(args, "target", limit=1024) or None, directory=True)
    collection_id, urls = _str(args, "collection_id", limit=40), args.get("urls")
    if bool(collection_id) == bool(urls):
        raise ToolError("请在 collection_id 与 urls 中二选一")
    limit = batch_limit(ctx.limits, "download_urls", "action_items")
    template = _str(args, "name_template", limit=120)
    items: list[dict] = []
    source = None
    by_album = args.get("by_album") is True
    following = None
    if collection_id:
        record = _record(ctx, collection_id, kind="collection")
        if (record["rule"] or {}).get("type") == "links":
            raise ToolError("这是网页链接的结果集，不是文件：先用 collect_gallery(albums=…) 收集其中的图片")
        entries = record["urls"]
        source = record["source"]
        indices = args.get("indices")
        if indices is not None and args.get("offset") is not None:
            raise ToolError("indices 与 offset 二选一")
        if indices is not None:
            if not isinstance(indices, list) or not all(isinstance(i, int) and not isinstance(i, bool) for i in indices):
                raise ToolError("参数 indices 需要整数列表")
            entries = [entries[i] for i in dict.fromkeys(indices) if 0 <= i < len(entries)]
        elif args.get("offset") is not None or args.get("limit") is not None:
            start = _int(args, "offset", 0, 0, 10**7)
            count = _int(args, "limit", limit, 1, limit)
            following = start + count if start + count < len(entries) else None
            entries = entries[start:start + count]
            if not entries:
                raise ToolError(f"offset 超出范围（结果集共 {len(record['urls'])} 项）")
        if by_album and not any(entry.get("album") for entry in entries):
            raise ToolError("这个结果集没有相册信息；by_album 只用于 collect_gallery 多个相册的结果")
        for entry in entries:
            if "ticket" in entry:
                items.append({"ticket": entry["ticket"], "name": entry["name"], "host": entry.get("source_host"),
                              "size": entry.get("size") or 0, "variant": entry.get("variant")})
            else:
                items.append({"url": entry["url"], "referer": entry.get("referer"), "name": entry.get("name") or url_filename(entry["url"]),
                              "host": urlsplit(entry["url"]).hostname,
                              **({"folder": filename(entry["album"], fallback="相册")} if by_album and entry.get("album") else {})})
    else:
        if not isinstance(urls, list) or not all(isinstance(url, str) for url in urls):
            raise ToolError("参数 urls 需要链接列表")
        for url in dict.fromkeys(urls):
            ctx.check_url(url.strip(), "page")
            try:
                clean = checked_url(url.strip())
            except ValueError as exc:
                raise ToolError(f"链接 {url[:80]} 不正确：{exc}") from exc
            items.append({"url": clean, "name": url_filename(clean), "host": urlsplit(clean).hostname})
    if len(items) > limit:
        raise ToolError(f"共 {len(items)} 个链接，超过单次上限 {limit}，请用 offset/limit 分批提议（例如 offset=0, limit={limit}）。")
    for number, item in enumerate(items, 1):
        if template:
            fake = {"key": item["name"], "modified_at": time.time()}
            item["name"] = filename(render_name(template, fake, number, ()), fallback=item["name"])
    hosts = sorted({item["host"] for item in items if item.get("host")})
    tickets = any("ticket" in item for item in items)
    folders = len({item["folder"] for item in items if item.get("folder")})
    output = await _propose(ctx, "downloads", items, skipped=[],
                            sample=lambda item: f"{item['folder'] + '/' if item.get('folder') else ''}{item['name']} ← {item.get('host') or ''}",
                            options={"target": target, "hosts": hosts[:10], "source": source, "expires_soon": tickets,
                                     **({"album_folders": folders} if folders else {})},
                            summary=f"创建 {len(items)} 个离线下载任务，保存到 {ctx.display(target)}"
                            + (f" 下的 {folders} 个相册文件夹" if folders else "")
                            + (f"（来源 {hosts[0]}{' 等' if len(hosts) > 1 else ''}）" if hosts else ""))
    if following is not None:
        output.result["next_offset"] = following
        output.result["note"] = f"结果集还有后续条目，下一批从 offset={following} 开始"
    return output

