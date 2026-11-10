"""文件助手的网络搜索（assistant/search.py）与跨对话偏好记忆（assistant/memory.py、recall_tools.py）。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from tgdrive.app import create_app
from tgdrive.assistant import prompts
from tgdrive.assistant.memory import MAX_CHARS
from tgdrive.assistant.search import SearchError
from tgdrive.assistant.tools import TOOLS, ToolContext, ToolError


class RecallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.service = self.app.assistant

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    def context(self, **extra):
        return ToolContext(self.alice.id, self.alice.bucket_id, "", self.app.objects, None, "files", "", {"searches_per_run": 2}, {},
                           memory=self.service.memory, redact=self.service.guard.redact, **extra)

    def test_search_providers_and_key_masking(self):
        search = self.service.search
        self.assertFalse(search.configured())
        self.assertNotIn("web_search", self.service._user_tools(self.alice.id), "未配置时不提供搜索工具")
        with self.assertRaises(ValueError):
            search.configure({"provider": "brave"})
        seen = []
        def opener(request, timeout):
            seen.append((request.full_url, dict(request.header_items()), request.data))
            if "brave" in request.full_url:
                return 200, json.dumps({"web": {"results": [{"title": "A", "url": "https://a.example/", "description": "摘要"},
                                                            {"title": "坏链接", "url": "javascript:alert(1)"}]}}).encode()
            if "tavily" in request.full_url:
                return 200, json.dumps({"results": [{"title": "T", "url": "https://t.example/", "content": "内容"}]}).encode()
            return 200, json.dumps({"results": [{"title": "S", "url": "https://s.example/", "content": "c"}]}).encode()
        search._opener = opener
        described = search.configure({"provider": "brave", "api_key": "BSA-secret-key-123"})
        self.assertTrue(described["configured"])
        self.assertNotIn("secret-key", json.dumps(described))
        stored = self.app.metadata.db.execute("SELECT value FROM settings WHERE key='assistant.search'").fetchone()["value"]
        self.assertNotIn("BSA-secret", stored, "API Key 加密保存")
        results = asyncio.run(search.search("天气", 5))
        self.assertEqual(results, [{"title": "A", "url": "https://a.example/", "snippet": "摘要"}])
        self.assertEqual(seen[-1][1].get("X-subscription-token"), "BSA-secret-key-123")
        search.configure({"provider": "tavily", "api_key": "tvly-abc"})
        self.assertEqual(asyncio.run(search.search("x", 3))[0]["url"], "https://t.example/")
        self.assertEqual(json.loads(seen[-1][2])["max_results"], 3)
        with self.assertRaises(ValueError):
            search.configure({"provider": "searxng", "url": "ftp://bad"})
        search.configure({"provider": "searxng", "url": "http://10.0.0.5:8888/"})
        self.assertTrue(seen and asyncio.run(search.search("x", 3))[0]["url"] == "https://s.example/")
        self.assertTrue(seen[-1][0].startswith("http://10.0.0.5:8888/search?"), "自建实例可以在内网")
        self.assertIn("web_search", self.service._user_tools(self.alice.id))
        search._opener = lambda request, timeout: (401, b"")
        with self.assertRaises(SearchError):
            asyncio.run(search.search("x", 3))
        search.configure({"provider": ""})
        self.assertFalse(search.configured())

    def test_web_search_tool_limits_and_taints(self):
        marks = []
        async def fake(query, count, language):
            return [{"title": query, "url": "https://x.example/", "snippet": ""}]
        ctx = self.context(search=fake, taint=marks.append)
        handler = TOOLS["web_search"].handler
        output = asyncio.run(handler(ctx, {"query": "Tessera"}))
        self.assertEqual(output.result["results"][0]["title"], "Tessera")
        self.assertEqual(marks, ["网络搜索结果"])
        asyncio.run(handler(ctx, {"query": "again"}))
        with self.assertRaises(ToolError):
            asyncio.run(handler(ctx, {"query": "third"}))
        with self.assertRaises(ToolError):
            asyncio.run(handler(self.context(), {"query": "未配置"}))

    def test_memories_are_encrypted_limited_and_reach_prompt(self):
        remember = TOOLS["remember_preference"].handler
        out = asyncio.run(remember(self.context(), {"text": "照片按 年-月 建文件夹整理"}))
        ident = out.result["id"]
        body = self.app.metadata.db.execute("SELECT body FROM assistant_memories WHERE id=?", (ident,)).fetchone()["body"]
        self.assertNotIn("照片".encode(), bytes(body), "偏好密文保存")
        # 重复记同一条不新增；过长、私密对话中写入都拒绝。
        asyncio.run(remember(self.context(), {"text": "照片按 年-月 建文件夹整理"}))
        self.assertEqual(len(self.service.memory.list(self.alice.id)), 1)
        with self.assertRaises(ToolError):
            asyncio.run(remember(self.context(), {"text": "长" * (MAX_CHARS + 1)}))
        with self.assertRaises(ToolError):
            asyncio.run(remember(self.context(base=".tgdrive/private/"), {"text": "私密里的偏好"}))
        listed = asyncio.run(TOOLS["list_preferences"].handler(self.context(), {})).result["preferences"]
        self.assertEqual(listed, [{"id": ident, "text": "照片按 年-月 建文件夹整理"}])
        text = prompts.system_prompt(date="2026-11-10", timezone="UTC", scope_root="/", can_write=True, can_read_text=True,
                                     can_remember=True, memories=self.service.memory.list(self.alice.id))
        self.assertIn(f"[{ident}] 照片按 年-月 建文件夹整理", text)
        asyncio.run(TOOLS["forget_preference"].handler(self.context(), {"id": ident}))
        self.assertEqual(self.service.memory.list(self.alice.id), [])
        # 账号删除后一并删除。
        self.service.memory.add(self.alice.id, "回复用英文")
        self.app.metadata.db.execute("PRAGMA foreign_keys=ON")
        with self.app.metadata.transaction() as db:
            db.execute("DELETE FROM users WHERE id=?", (self.alice.id,))
        self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM assistant_memories").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
