"""通用 HTML 结构提取；不执行脚本，不把属性中的表单值或事件处理器交给模型。"""

from html.parser import HTMLParser
from urllib.parse import urljoin

from .web import VOID, _http, _segment

LAYOUT = {"header", "nav", "main", "aside", "section", "article", "footer", "form", "div"}
HIDDEN = {"script", "style", "noscript", "template"}


class StructureParser(HTMLParser):
    def __init__(self, url: str):
        super().__init__(convert_charrefs=True)
        self.url = url
        self.stack = []
        self.layout, self.headings, self.tables = [], [], []
        self.cells = 0
        self.truncated = False

    def _parent(self, field):
        return next((node[field] for node in reversed(self.stack) if field in node), None)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        hidden = tag in HIDDEN or "hidden" in attrs or attrs.get("aria-hidden") == "true" or bool(self._parent("hidden"))
        path = ">".join([node["segment"] for node in self.stack[-3:]] + [_segment(tag, attrs.get("class") or "")])
        node = {"tag": tag, "segment": _segment(tag, attrs.get("class") or ""), "hidden": hidden}
        if not hidden:
            if tag in LAYOUT or attrs.get("role") in ("main", "navigation", "banner", "complementary", "contentinfo", "region"):
                if len(self.layout) < 1000:
                    item = {"tag": tag, "role": attrs.get("role"), "path": path, "depth": len(self.stack),
                            "id": (attrs.get("id") or "")[:120], "label": (attrs.get("aria-label") or "")[:180], "text": ""}
                    if tag == "form":
                        item.update(method=(attrs.get("method") or "GET").upper(), action=_http(urljoin(self.url, attrs.get("action") or "")))
                    self.layout.append(item)
                    node["layout"] = item
                else:
                    self.truncated = True
            if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
                if len(self.headings) < 500:
                    item = {"level": int(tag[1]), "path": path, "text": ""}
                    self.headings.append(item)
                    node["heading"] = item
                else:
                    self.truncated = True
            if tag == "table":
                node["table"] = None
                if len(self.tables) < 50:
                    item = {"index": len(self.tables), "path": path, "caption": "", "row_count": 0, "column_count": 0, "rows": []}
                    self.tables.append(item)
                    node["table"] = item
                else:
                    self.truncated = True
            table = node.get("table") if tag == "table" else self._parent("table")
            if table is not None:
                if tag == "caption":
                    node["caption"] = table
                if tag == "tr":
                    table["row_count"] += 1
                    node["row"] = None
                    if len(table["rows"]) < 5000:
                        node["row"] = {"cells": [], "header": False}
                        table["rows"].append(node["row"])
                    else:
                        self.truncated = True
                if tag in ("td", "th"):
                    row = self._parent("row")
                    if row is not None and len(row["cells"]) < 50 and self.cells < 20000:
                        cell = {"text": ""}
                        row["cells"].append(cell)
                        row["header"] = row["header"] or tag == "th"
                        node["cell"] = cell
                        self.cells += 1
                        table["column_count"] = max(table["column_count"], len(row["cells"]))
                    else:
                        self.truncated = True
        if tag not in VOID:
            self.stack.append(node)
            if len(self.stack) > 400:
                self.stack = self.stack[-200:]
                self.truncated = True

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]["tag"] == tag:
                del self.stack[index:]
                return

    def handle_data(self, data):
        if self._parent("hidden"):
            return
        for key, maximum in (("layout", 180), ("heading", 240), ("cell", 500), ("caption", 240)):
            item = self._parent(key)
            field = "caption" if key == "caption" else "text"
            if item is not None and key == "cell" and len(data) > max(0, maximum - len(item[field])):
                self.truncated = True
            if item is not None and len(item[field]) < maximum:
                item[field] += data[:maximum - len(item[field])]


def parse_structure(html: str, url: str) -> dict:
    parser = StructureParser(url)
    try:
        parser.feed(html)
        parser.close()
    except (ValueError, RecursionError):
        parser.truncated = True
    for item in [*parser.layout, *parser.headings]:
        item["text"] = " ".join(item["text"].split())
    for table in parser.tables:
        table["caption"] = " ".join(table["caption"].split())
        table["rows"] = [{"cells": [" ".join(cell["text"].split()) for cell in row["cells"]], "header": row["header"]}
                         for row in table["rows"]]
    return {"layout": parser.layout, "headings": parser.headings, "tables": parser.tables, "truncated": parser.truncated}
