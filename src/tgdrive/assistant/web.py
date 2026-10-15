"""网页相册分析与抓取（docs/assistant-design.md §9）。

- 页面统一表示为「规范页」：{url, title, images: [{path, urls: {属性: 绝对地址}, w, h}], links: [{path, href, text, rel}], og_image}。
  服务端抓取的 HTML 由这里解析生成；抓取脚本发来的快照（§9.1）是浏览器在已渲染 DOM 上生成的同一结构。
- 结构摘要按元素路径（最近 4 层「标签.首个类名」）把图片候选聚类，交给无工具的隔离分析调用；
  分析结果只能引用摘要中的聚类编号与链接编号，经校验后保存为确定性的提取规则，不执行任何选择器或代码。
- 所有网络请求经离线下载的 SafeHttpClient（内网拦截、代理规则），单页 ≤5 MB，只接受 HTML。
"""

from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

from ..offline.http import DownloadError
from ..offline.request import DownloadRequest, checked_url

PAGE_BYTES = 5 * 1024 * 1024
URL_BYTES = 2048
IMAGE_ATTRS = ("src", "data-src", "data-original", "data-lazy-src", "data-lazy", "data-url", "srcset", "href")
IMAGE_EXT = re.compile(r"\.(jpe?g|png|gif|webp|avif|bmp|heic|jfif)(?:$|[?#])", re.I)
NEXT_TEXT = re.compile(r"^\s*(下一页|下页|后页|下一张|next(\s*page)?|older|more|›|»|>|→)\s*[›»>→]?\s*$", re.I)
VOID = {"img", "source", "br", "meta", "link", "input", "hr", "wbr", "area", "base", "col", "embed", "param", "track"}


def _segment(tag: str, classes: str) -> str:
    first = next((c for c in classes.split() if c), "")
    first = re.sub(r"\d+", "*", re.sub(r"[^A-Za-z0-9_-]", "", first))[:30]
    return f"{tag}.{first}" if first else tag


def _http(url: str | None) -> str | None:
    if not url or len(url) > URL_BYTES:
        return None
    try:
        parts = urlsplit(url)
        _ = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username is not None or parts.password is not None:
        return None
    return url.split("#", 1)[0]


def _largest_srcset(value: str) -> str | None:
    best, best_size = None, -1.0
    for part in value.split(","):
        bits = part.strip().split()
        if not bits:
            continue
        size = 1.0
        if len(bits) > 1:
            match = re.fullmatch(r"([\d.]+)([wx])", bits[1])
            if match:
                size = float(match[1]) * (1 if match[2] == "w" else 1000)
        if size > best_size:
            best, best_size = bits[0], size
    return best


def _int(value: str | None) -> int | None:
    match = re.match(r"\s*(\d{1,5})", value or "")
    return int(match[1]) if match else None


class _Parser(HTMLParser):
    def __init__(self, base: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base = base
        self.stack: list[tuple[str, str, dict]] = []
        self.images: list[dict] = []
        self.links: list[dict] = []
        self.title = ""
        self.og_image = None
        self._in_title = False
        self._anchor_text: list[list[str]] = []

    def _path(self, tag: str, classes: str) -> str:
        chain = [_segment(t, c) for t, c, _ in self.stack[-3:]] + [_segment(tag, classes)]
        return ">".join(chain)

    def _abs(self, value: str | None) -> str | None:
        if not value:
            return None
        try:
            return _http(urljoin(self.base, value.strip()))
        except ValueError:
            return None

    def _anchor(self) -> dict | None:
        for tag, _, attrs in reversed(self.stack):
            if tag == "a":
                return attrs
        return None

    def handle_starttag(self, tag, attrs):
        values = {key: value or "" for key, value in attrs}
        classes = values.get("class", "")
        if tag == "base" and values.get("href"):
            self.base = self._abs(values["href"]) or self.base
        if tag == "title":
            self._in_title = True
        if tag == "meta" and values.get("property", values.get("name", "")).lower() == "og:image":
            self.og_image = self._abs(values.get("content"))
        if tag == "link" and "next" in values.get("rel", "").lower().split():
            href = self._abs(values.get("href"))
            if href:
                self.links.append({"path": "link", "href": href, "text": "", "rel": "next"})
        if tag == "img" and len(self.images) < 20000:
            urls = {}
            for name in ("src", "data-src", "data-original", "data-lazy-src", "data-lazy", "data-url"):
                url = self._abs(values.get(name))
                if url:
                    urls[name] = url
            srcset = values.get("srcset") or values.get("data-srcset")
            if srcset:
                url = self._abs(_largest_srcset(srcset))
                if url:
                    urls["srcset"] = url
            anchor = self._anchor()
            if anchor is not None:
                href = self._abs(anchor.get("href"))
                if href:
                    urls["href"] = href
            if urls:
                self.images.append({"path": self._path(tag, classes), "urls": urls,
                                    "w": _int(values.get("width")), "h": _int(values.get("height"))})
        if tag in VOID:
            return
        self.stack.append((tag, classes, values))
        if len(self.stack) > 400:
            self.stack = self.stack[-200:]
        if tag == "a":
            self._anchor_text.append([])

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in VOID:
            return
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                # 被隐式关闭的内层链接也要弹出它们的文字缓冲，保持一一对应。
                for inner in self.stack[index + 1:]:
                    if inner[0] == "a" and self._anchor_text:
                        self._anchor_text.pop()
                if tag == "a":
                    self._close_anchor(index)
                del self.stack[index:]
                return

    def _close_anchor(self, index: int) -> None:
        attrs = self.stack[index][2]
        text = " ".join("".join(self._anchor_text.pop() if self._anchor_text else []).split())[:60]
        href = self._abs(attrs.get("href"))
        if not href or len(self.links) >= 5000:
            return
        path = ">".join(_segment(t, c) for t, c, _ in self.stack[max(0, index - 3):index + 1])
        self.links.append({"path": path, "href": href, "text": text, "rel": attrs.get("rel", "").lower()})
        # 外层链接直接指向图片、里面没有 <img> 的情况（例如纯文字的「原图」链接）也作为候选。
        if IMAGE_EXT.search(urlsplit(href).path) and not any(image["urls"].get("href") == href for image in self.images[-3:]):
            if len(self.images) < 20000:
                self.images.append({"path": path, "urls": {"href": href}, "w": None, "h": None})

    def handle_data(self, data):
        if self._in_title and len(self.title) < 200:
            self.title += data
        if self._anchor_text:
            self._anchor_text[-1].append(data)


def parse_html(html: str, url: str) -> dict:
    parser = _Parser(url)
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # 残缺的 HTML 尽量保留已解析的部分
        pass
    return {"url": url, "title": " ".join(parser.title.split())[:200], "images": parser.images, "links": parser.links,
            "og_image": parser.og_image}


def _charset(content_type: str, head: bytes) -> str:
    match = re.search(r"charset=([\w-]+)", content_type, re.I) or re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", head[:4096], re.I)
    if match:
        value = match[1].decode() if isinstance(match[1], bytes) else match[1]
        try:
            "".encode(value)
            return value
        except LookupError:
            pass
    return "utf-8"


async def fetch_page(http, url: str, *, referer: str | None = None, same_origin: str | None = None) -> dict:
    """经 SafeHttpClient 抓取一个 HTML 页面并解析为规范页。"""
    request = DownloadRequest(checked_url(url), headers=[("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"),
                                                        ("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8"),
                                                        ("User-Agent", "Mozilla/5.0 (compatible; Tessera)")]
                              + ([("Referer", referer)] if referer else []))
    def check_redirect(target):
        if same_origin is not None and _origin(target) != _origin(same_origin):
            raise DownloadError("分页重定向到了其他来源，已停止抓取")
    options = {"url_check": check_redirect} if same_origin is not None else {}
    async with http.open(request, identity=True, **options) as response:
        if response.status != 200:
            raise DownloadError(f"页面返回 HTTP {response.status}")
        content_type = response.headers.get("content-type", "")
        if "html" not in content_type.lower():
            raise DownloadError("地址不是网页（只能分析 HTML 页面）")
        pieces, size = [], 0
        async for piece in response.stream():
            size += len(piece)
            if size > PAGE_BYTES:
                raise DownloadError("页面超过 5 MB，无法分析")
            pieces.append(piece)
        data = b"".join(pieces)
        final = response.url
    return parse_html(data.decode(_charset(content_type, data), "replace"), final)


# ---------- 摘要 ----------

def summarize(pages: list[dict], *, limit_clusters: int = 15) -> tuple[dict, dict, dict]:
    """返回 (给模型的摘要, 聚类编号 → 路径, 链接编号 → 链接)。"""
    clusters: dict[str, dict] = {}
    for page in pages:
        for image in page.get("images", []):
            entry = clusters.setdefault(image["path"], {"count": 0, "attrs": {}, "sizes": []})
            entry["count"] += 1
            for attr, url in image["urls"].items():
                samples = entry["attrs"].setdefault(attr, [])
                if len(samples) < 3 and url not in samples:
                    samples.append(url)
            if image.get("w") and image.get("h") and len(entry["sizes"]) < 50:
                entry["sizes"].append((image["w"], image["h"]))
    ranked = sorted(clusters.items(), key=lambda item: -item[1]["count"])[:limit_clusters]
    cluster_ids, cluster_view = {}, []
    for index, (path, entry) in enumerate(ranked, 1):
        cluster_ids[f"c{index}"] = path
        sizes = sorted(entry["sizes"])
        cluster_view.append({"id": f"c{index}", "path": path, "count": entry["count"],
                             "attrs": {attr: [url[:200] for url in urls] for attr, urls in entry["attrs"].items()},
                             "typical_size": f"{sizes[len(sizes) // 2][0]}x{sizes[len(sizes) // 2][1]}" if sizes else None})
    first = pages[0] if pages else {"links": [], "url": ""}
    candidates, numbers, seen = [], [], set()
    for link in first.get("links", []):
        if link["href"] in seen:
            continue
        if "next" in link["rel"].split() or NEXT_TEXT.match(link["text"] or ""):
            seen.add(link["href"])
            candidates.append(link)
        elif re.fullmatch(r"\d{1,4}", link["text"] or "") and len(numbers) < 12:
            seen.add(link["href"])
            numbers.append({"text": link["text"], "href": link["href"][:200]})
    link_ids, link_view = {}, []
    for index, link in enumerate(candidates[:20], 1):
        link_ids[f"n{index}"] = link
        link_view.append({"id": f"n{index}", "text": link["text"], "rel": link["rel"] or None, "href": link["href"][:200],
                          "path": link["path"]})
    summary = {"url": first.get("url", ""), "title": first.get("title", ""), "pages": len(pages), "og_image": first.get("og_image"),
               "image_clusters": cluster_view, "next_links": link_view, "page_number_links": numbers}
    return summary, cluster_ids, link_ids


# ---------- 规则 ----------

def validate_rule(raw: object, cluster_ids: dict, link_ids: dict, start_url: str, *, max_pages: int) -> dict:
    """把隔离分析的输出校验成确定性规则；不合格时抛 ValueError（说明原因）。"""
    if not isinstance(raw, dict):
        raise ValueError("分析结果不是 JSON 对象")
    images = raw.get("images")
    if not isinstance(images, dict) or images.get("cluster") not in cluster_ids:
        raise ValueError("分析结果没有选中摘要中的图片分组")
    attr = images.get("attr") or "src"
    if attr not in IMAGE_ATTRS:
        raise ValueError("分析结果的图片属性不正确")
    transforms = images.get("transform") or []
    if not isinstance(transforms, list) or len(transforms) > 5:
        raise ValueError("transform 最多 5 条")
    clean = []
    for item in transforms:
        if not isinstance(item, dict) or not isinstance(item.get("replace"), str) or not isinstance(item.get("with", ""), str):
            raise ValueError("transform 格式不正确")
        if not 0 < len(item["replace"]) <= 100 or len(item.get("with", "")) > 100:
            raise ValueError("transform 的文本长度不正确")
        clean.append({"replace": item["replace"], "with": item.get("with", "")})
    pagination = raw.get("pagination") or {"type": "none"}
    if not isinstance(pagination, dict):
        raise ValueError("pagination 格式不正确")
    kind = pagination.get("type", "none")
    page_rule: dict = {"type": "none"}
    if kind == "next_link":
        link = link_ids.get(pagination.get("link"))
        if link is None:
            raise ValueError("分析结果的下一页链接不在摘要中")
        page_rule = {"type": "next_link", "rel_next": "next" in link["rel"].split(), "text": link["text"], "path": link["path"]}
    elif kind == "url_pattern":
        pattern = pagination.get("pattern")
        if not isinstance(pattern, str) or "{page}" not in pattern or len(pattern) > URL_BYTES:
            raise ValueError("url_pattern 需要包含 {page}")
        start, end = pagination.get("start", 2), pagination.get("end")
        if not isinstance(start, int) or isinstance(start, bool) or not 0 <= start <= 100000:
            raise ValueError("url_pattern 的 start 不正确")
        if end is not None and (not isinstance(end, int) or isinstance(end, bool) or end < start):
            raise ValueError("url_pattern 的 end 不正确")
        sample = _http(urljoin(start_url, pattern.replace("{page}", str(start))))
        if sample is None or _origin(sample) != _origin(start_url):
            raise ValueError("分页地址必须与起始页同源")
        page_rule = {"type": "url_pattern", "pattern": urljoin(start_url, pattern.replace("{page}", "__PAGE__")).replace("__PAGE__", "{page}"),
                     "start": start, "end": min(end if end is not None else start + max_pages, start + max_pages)}
    elif kind != "none":
        raise ValueError("pagination.type 只能是 next_link、url_pattern 或 none")
    confidence = raw.get("confidence")
    return {"images": {"path": cluster_ids[images["cluster"]], "attr": attr, "transform": clean}, "pagination": page_rule,
            "confidence": float(confidence) if isinstance(confidence, (int, float)) and not isinstance(confidence, bool) else None,
            "notes": str(raw.get("notes") or "")[:200]}


def _origin(url: str) -> tuple[str, str, int | None]:
    parts = urlsplit(url)
    return parts.scheme, (parts.hostname or "").lower(), parts.port


def extract(page: dict, rule: dict) -> list[str]:
    images = rule["images"]
    result, seen = [], set()
    for image in page.get("images", []):
        if image["path"] != images["path"]:
            continue
        url = image["urls"].get(images["attr"])
        if not url:
            continue
        for step in images["transform"]:
            url = url.replace(step["replace"], step["with"])
        url = _http(url)
        if url and url not in seen:
            seen.add(url)
            result.append(url)
    return result


def next_page(page: dict, rule: dict, visited: set[str], start_url: str) -> str | None:
    pagination = rule["pagination"]
    if pagination["type"] != "next_link":
        return None
    for link in page.get("links", []):
        if link["href"] in visited or _origin(link["href"]) != _origin(start_url):
            continue
        if pagination["rel_next"] and "next" in link["rel"].split():
            return link["href"]
        if link["text"] == pagination["text"] and link["path"] == pagination["path"]:
            return link["href"]
    return None


# ---------- 快照（抓取脚本） ----------

def validate_snapshot(payload: object) -> tuple[str, list[dict], int]:
    """校验抓取脚本发来的快照，返回 (来源 origin, 规范页列表, 图片候选数)。"""
    if not isinstance(payload, dict):
        raise ValueError("快照格式不正确")
    pages = payload.get("pages")
    if not isinstance(pages, list) or not 1 <= len(pages) <= 50:
        raise ValueError("快照需要 1–50 页")
    clean, total, origin = [], 0, None
    for page in pages:
        if not isinstance(page, dict):
            raise ValueError("快照页面格式不正确")
        url = _http(page.get("url") if isinstance(page.get("url"), str) else None)
        if url is None:
            raise ValueError("快照页面地址必须是 http(s)")
        page_origin = "{}://{}".format(*_origin(url)[:2]) + (f":{_origin(url)[2]}" if _origin(url)[2] else "")
        if origin is not None and page_origin != origin:
            raise ValueError("同一份快照的页面必须来自同一来源")
        origin = origin or page_origin
        if not isinstance(page.get("images"), list) or not isinstance(page.get("links", []), list):
            raise ValueError("快照图片与链接必须是列表")
        images = []
        for image in (page.get("images") or [])[:20000]:
            if not isinstance(image, dict) or not isinstance(image.get("path"), str) or not isinstance(image.get("urls"), dict):
                continue
            urls = {attr: _http(value) for attr, value in image["urls"].items()
                    if attr in IMAGE_ATTRS and isinstance(value, str)}
            urls = {attr: value for attr, value in urls.items() if value}
            if urls:
                images.append({"path": image["path"][:200], "urls": urls,
                               "w": image.get("w") if isinstance(image.get("w"), int) else None,
                               "h": image.get("h") if isinstance(image.get("h"), int) else None})
        total += len(images)
        if total > 5000:
            raise ValueError("快照中的图片候选超过 5,000 个")
        links = []
        for link in (page.get("links") or [])[:2000]:
            if isinstance(link, dict) and isinstance(link.get("href"), str) and _http(link["href"]):
                links.append({"path": str(link.get("path") or "")[:200], "href": _http(link["href"]),
                              "text": " ".join(str(link.get("text") or "").split())[:60], "rel": str(link.get("rel") or "").lower()[:40]})
        clean.append({"url": url, "title": " ".join(str(page.get("title") or "").split())[:200], "images": images, "links": links,
                      "og_image": None})
    if len(json.dumps(clean, ensure_ascii=False).encode()) > 2 * 1024 * 1024:
        raise ValueError("快照超过 2 MB")
    return origin or "", clean, total


def parse_analysis(text: str) -> object:
    """从隔离分析的回复中取出 JSON（容忍代码块包裹）。"""
    match = re.search(r"\{.*\}", text or "", re.S)
    if not match:
        raise ValueError("分析结果不是 JSON")
    try:
        return json.loads(match[0])
    except ValueError as exc:
        raise ValueError("分析结果不是合法的 JSON") from exc
