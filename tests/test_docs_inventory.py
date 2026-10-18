"""确保公开文档覆盖程序可调用 API 的核心入口，避免路由改名后文档静默落后。"""

import re
import unittest
from pathlib import Path

from tgdrive.assistant.knowledge import HELP

ROOT = Path(__file__).resolve().parents[1]


class DocsInventoryTests(unittest.TestCase):
    def test_public_api_examples_are_present(self):
        source = (ROOT / "web/src/docs/docs-content.tsx").read_text(encoding="utf-8")
        for route in ('path="/list"', 'path="/search"', 'path="/content"', 'path="/files"',
                      'path="/files/instant"', 'path="/delete"', 'path="/move"', 'path="/copy"', 'path="/downloads/parse"', 'path="/downloads"', 'path="/downloads?ids="', 'path="/api/v1/public"'):
            self.assertIn(route, source, route)

    def test_shared_docs_include_deployment_and_management_guides(self):
        entry = (ROOT / "web/src/docs/docs.tsx").read_text(encoding="utf-8")
        management = (ROOT / "web/src/docs/docs-admin-content.tsx").read_text(encoding="utf-8")
        self.assertIn('from "./docs-admin-content"', entry)
        self.assertRegex(entry, r"\[\s*\.\.\.DOC_PAGES,\s*\.\.\.ADMIN_DOC_PAGES\s*\]")
        for marker in ("--trusted-proxies", "meta.db.v", "反向代理示例"):
            self.assertIn(marker, management)
        sources = (ROOT / "web/src/docs/docs-content.tsx").read_text(encoding="utf-8") + management
        slugs = re.findall(r'slug: "([a-z0-9-]+)"', sources)
        self.assertEqual(len(slugs), len(set(slugs)), "公开文档不能包含重复页面地址")

    def test_assistant_help_links_point_to_existing_pages(self):
        source = (ROOT / "web/src/docs/docs-content.tsx").read_text(encoding="utf-8")
        slugs = set(re.findall(r'slug: "([a-z0-9-]+)"', source))
        anchors = set(re.findall(r'<H2 id="([a-z0-9-]+)"', source))
        for topic, (_title, path, text) in HELP.items():
            for link in [path, *re.findall(r"/docs/[a-z0-9#-]+", text)]:
                page, _, anchor = link.removeprefix("/docs/").partition("#")
                self.assertIn(page, slugs, f"{topic}: {link}")
                if anchor:
                    self.assertIn(anchor, anchors, f"{topic}: {link}")


if __name__ == "__main__":
    unittest.main()
