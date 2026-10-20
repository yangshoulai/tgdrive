"""通用网页结构回归：仅解析固定 HTML 与 HTTP 替身，不访问外网或数据库。"""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from tests.test_assistant_http import HttpFixture
from tgdrive.assistant.structure import parse_structure
from tgdrive.assistant.tools import ToolContext, ToolError, effective_tools
from tgdrive.assistant.web_tools import inspect_page

HTML = """<!doctype html><title>数据目录</title><header>站点导航</header>
<nav><a href="/">首页</a><a rel="next" href="?page=2">下一页</a></nav>
<main id="content"><h1>相册列表</h1><section><h2>统计</h2>
<table><caption>列表</caption><tr><th>名称</th><th>数量</th></tr>
<tr><td>相册 <b>A</b></td><td>100</td></tr></table></section>
<form action="/search"><input name="password" value="must-not-be-returned"></form>
<div hidden><h2>隐藏标题</h2></div><script>window.secret = 'script-must-not-run'</script></main>"""


class StructureTests(unittest.IsolatedAsyncioTestCase):
    def context(self):
        http = HttpFixture(HTML.encode(), "text/html; charset=utf-8")
        ctx = ToolContext(1, 1, "", None, SimpleNamespace(http=http), "private", "", {}, {}, trace=Mock(),
                          taint=Mock(), base=".tgdrive/private/")
        return ctx, http

    async def test_page_without_images_has_layout_headings_tables_and_links(self):
        ctx, http = self.context()
        payload = (await inspect_page(ctx, {"url": "https://public.example/list"})).result
        self.assertEqual(payload["title"], "数据目录")
        self.assertEqual([item["text"] for item in payload["headings"]], ["相册列表", "统计"])
        self.assertEqual(payload["tables"][0]["row_count"], 2)
        self.assertTrue(any(item["tag"] == "main" for item in payload["layout"]))
        self.assertFalse(payload["scripts_executed"])
        self.assertNotIn("must-not", json.dumps(payload))
        ctx.taint.assert_called_once()
        self.assertIn("inspect_page", effective_tools({}, "read", private=True))
        self.assertEqual(len(http.requests), 1)

    async def test_sections_and_table_rows_page_without_refetching(self):
        ctx, http = self.context()
        links = (await inspect_page(ctx, {"url": "https://public.example/list", "section": "links", "limit": 1})).result
        self.assertEqual((len(links["items"]), links["total"], links["next_offset"]), (1, 2, 1))
        rows = (await inspect_page(ctx, {"url": "https://public.example/list", "section": "tables", "table_index": 0,
                                        "offset": 1, "limit": 1})).result
        self.assertEqual(rows["items"], [{"cells": ["相册 A", "100"], "header": False}])
        self.assertIsNone(rows["next_offset"])
        self.assertEqual(len(http.requests), 1)
        with self.assertRaisesRegex(ToolError, "表格编号"):
            await inspect_page(ctx, {"url": "https://public.example/list", "section": "tables", "table_index": 2})

    async def test_structure_limits_are_explicit(self):
        payload = parse_structure("<main>" + "<div>内容</div>" * 1005 + "</main>", "https://public.example/")
        self.assertTrue(payload["truncated"])
        self.assertEqual(len(payload["layout"]), 1000)


if __name__ == "__main__":
    unittest.main()
