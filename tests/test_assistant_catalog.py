"""模型目录：解析两种数据源、按模型 ID 匹配、同步不覆盖手动条目、渠道模型套用目录信息与手动字段保留。"""

import unittest
from unittest import mock

from tgdrive.assistant import catalog
from tests.test_assistant import AssistantCase

MODELS_DEV = {
    "openai": {"id": "openai", "models": {
        "gpt-4o": {"id": "gpt-4o", "name": "GPT-4o", "tool_call": True, "reasoning": False, "attachment": True,
                   "modalities": {"input": ["text", "image"]}, "cost": {"input": 2.5, "output": 10, "cache_read": 1.25},
                   "limit": {"context": 128000, "output": 16384}, "knowledge": "2023-09", "release_date": "2024-05-13"}}},
    "azure": {"id": "azure", "models": {"gpt-4o": {"id": "gpt-4o", "name": "GPT-4o (Azure)", "limit": {"context": 128000}}}},
    "anthropic": {"id": "anthropic", "models": {
        "claude-opus-9": {"id": "claude-opus-9", "name": "Claude Opus 9", "tool_call": True, "reasoning": True,
                          "reasoning_options": [{"type": "toggle"}, {"type": "effort", "values": ["low", "medium", "high", "max", "low", "Bad!"]}]},
        "claude-budget": {"id": "claude-budget", "name": "Budget only", "reasoning": True,
                          "reasoning_options": [{"type": "budget_tokens", "min": 1024}]}}},
    "deepseek": {"id": "deepseek", "models": {
        "deepseek-reasoner": {"id": "deepseek-reasoner", "name": "DeepSeek Reasoner", "tool_call": False, "reasoning": True,
                              "cost": {"input": 0.55, "output": 2.19}, "limit": {"context": 64000, "output": 8192}}}},
}
OPENROUTER = {"data": [{"id": "anthropic/claude-sonnet-4", "name": "Anthropic: Claude Sonnet 4", "context_length": 200000,
                        "pricing": {"prompt": "0.000003", "completion": "0.000015"}, "top_provider": {"max_completion_tokens": 64000},
                        "supported_parameters": ["tools", "reasoning"], "architecture": {"input_modalities": ["text", "image"]}}]}


class CatalogParseTests(unittest.TestCase):
    def test_parse_models_dev_and_openrouter(self):
        entries = {f"{e['provider']}/{e['model']}": e for e in catalog.parse(MODELS_DEV)}
        gpt = entries["openai/gpt-4o"]
        self.assertEqual((gpt["context_window"], gpt["max_output"], gpt["input_price"]), (128000, 16384, 2.5))
        self.assertEqual(gpt["capabilities"], {"tools": True, "reasoning": False, "vision": True, "structured": False})
        claude = catalog.parse(OPENROUTER)[0]
        self.assertEqual((claude["provider"], claude["model"], claude["name"]), ("anthropic", "claude-sonnet-4", "Claude Sonnet 4"))
        self.assertAlmostEqual(claude["input_price"], 3.0)
        self.assertTrue(claude["capabilities"]["tools"])
        with self.assertRaises(ValueError):
            catalog.parse({"nothing": 1})

    def test_reasoning_efforts_come_only_from_effort_options(self):
        entries = {f"{e['provider']}/{e['model']}": e for e in catalog.parse(MODELS_DEV)}
        self.assertEqual(entries["anthropic/claude-opus-9"]["reasoning_efforts"], ["low", "medium", "high", "max"], "去重并丢弃不合规的值")
        self.assertEqual(entries["anthropic/claude-budget"]["reasoning_efforts"], [], "只有思考预算没有档位")
        self.assertEqual(entries["openai/gpt-4o"]["reasoning_efforts"], [])
        self.assertEqual(catalog.parse(OPENROUTER)[0]["reasoning_efforts"], [], "OpenRouter 不提供档位")

    def test_normalization(self):
        self.assertEqual(catalog.bare("openai/GPT-4o:free"), "gpt-4o")
        self.assertEqual(catalog.undated("gpt-4o-2024-08-06"), "gpt-4o")
        self.assertEqual(catalog.undated("claude-3-5-sonnet-20241022"), "claude-3-5-sonnet")
        self.assertEqual(catalog.origin("gpt-4o"), "openai")


class CatalogStoreTests(AssistantCase):
    def sync(self, data):
        with mock.patch.object(catalog.CatalogStore, "_fetch", mock.AsyncMock(return_value=data)):
            return self.run_async(self.service.catalog.sync(actor="admin"))

    def test_match_prefers_origin_and_handles_dates(self):
        self.sync(MODELS_DEV)
        store = self.service.catalog
        self.assertEqual(store.match("gpt-4o")["id"], "openai/gpt-4o")
        self.assertEqual(store.match("gpt-4o-2024-11-20")["id"], "openai/gpt-4o")
        self.assertEqual(store.match("azure/gpt-4o")["id"], "azure/gpt-4o")
        self.assertEqual(store.match("deepseek/deepseek-reasoner")["id"], "deepseek/deepseek-reasoner")
        self.assertIsNone(store.match("unknown-model"))

    def test_sync_keeps_manual_entries_and_applies_to_models(self):
        async def run():
            admin, channel, model = await self.setup_assistant()
            status, entry = await self.req("POST", "/api/admin/v1/assistant/catalog",
                                           {"provider": "local", "model": "test-model", "context_window": 32000, "input_price": 0,
                                            "capabilities": {"tools": True}}, admin)
            self.assertEqual(status, 201, entry)
            _, models = await self.req("GET", f"/api/admin/v1/assistant/channels/{channel['id']}/models", headers=admin)
            self.assertEqual((models[0]["catalog_id"], models[0]["context_window"]), ("local/test-model", 32000))
            # 管理员手动改过的字段不再被目录覆盖。
            status, updated = await self.req("POST", f"/api/admin/v1/assistant/models/{model['id']}/update", {"context_window": 50000}, admin)
            self.assertEqual(status, 200, updated)
            self.assertIn("context_window", updated["manual_fields"])
            with mock.patch.object(catalog.CatalogStore, "_fetch", mock.AsyncMock(return_value=MODELS_DEV)):
                status, result = await self.req("POST", "/api/admin/v1/assistant/catalog/sync", {}, admin)
            self.assertEqual(status, 200, result)
            status, data = await self.req("GET", "/api/admin/v1/assistant/catalog?q=test-model", headers=admin)
            self.assertEqual([e["id"] for e in data["entries"]], ["local/test-model"], "手动条目保留")
            _, models = await self.req("GET", f"/api/admin/v1/assistant/channels/{channel['id']}/models", headers=admin)
            self.assertEqual(models[0]["context_window"], 50000)
            # 恢复目录值。
            status, reset = await self.req("POST", f"/api/admin/v1/assistant/models/{model['id']}/update", {"reset_catalog": True}, admin)
            self.assertEqual((reset["context_window"], reset["manual_fields"]), (32000, []))
            # 同步来的条目不能删除，手动条目可以。
            status, _ = await self.req("POST", "/api/admin/v1/assistant/catalog/delete", {"id": "openai/gpt-4o"}, admin)
            self.assertEqual(status, 400)
            status, _ = await self.req("POST", "/api/admin/v1/assistant/catalog/delete", {"id": "local/test-model"}, admin)
            self.assertEqual(status, 204)
            audit = self.app.metadata.db.execute("SELECT action FROM audit_log WHERE action LIKE 'assistant.catalog.%'").fetchall()
            self.assertGreaterEqual(len(audit), 3)
        self.run_async(run())

    def test_model_reasoning_effort_follows_catalog_options(self):
        async def run():
            admin, channel, model = await self.setup_assistant()
            status, entry = await self.req("POST", "/api/admin/v1/assistant/catalog",
                                           {"provider": "local", "model": "test-model", "capabilities": {"tools": True},
                                            "reasoning_efforts": ["low", "high"]}, admin)
            self.assertEqual((status, entry["reasoning_efforts"]), (201, ["low", "high"]))
            _, models = await self.req("GET", f"/api/admin/v1/assistant/channels/{channel['id']}/models", headers=admin)
            self.assertEqual((models[0]["reasoning_efforts"], models[0]["reasoning_effort"]), (["low", "high"], None))
            self.assertIsNone(self.service.channels.effort(models[0]), "默认不设置，请求不带思考程度")
            status, error = await self.req("POST", f"/api/admin/v1/assistant/models/{model['id']}/update", {"reasoning_effort": "max"}, admin)
            self.assertEqual(status, 400, "只能选目录给出的档位")
            status, updated = await self.req("POST", f"/api/admin/v1/assistant/models/{model['id']}/update", {"reasoning_effort": "high"}, admin)
            self.assertEqual((status, updated["reasoning_effort"]), (200, "high"))
            self.assertEqual(self.service.channels.effort(updated), "high")
            # 目录不再提供档位时，已选的档位不再发送。
            status, _ = await self.req("POST", "/api/admin/v1/assistant/catalog/update", {"id": "local/test-model", "reasoning_efforts": []}, admin)
            self.assertEqual(status, 200)
            current = self.service.channels.model(model["id"])
            self.assertEqual((current["reasoning_efforts"], current["reasoning_effort"]), ([], "high"))
            self.assertIsNone(self.service.channels.effort(current))
            status, _ = await self.req("POST", f"/api/admin/v1/assistant/models/{model['id']}/update", {"reasoning_effort": None}, admin)
            self.assertEqual(status, 200)
            status, _ = await self.req("POST", "/api/admin/v1/assistant/catalog", {"provider": "local", "model": "bad", "reasoning_efforts": ["Very High"]}, admin)
            self.assertEqual(status, 400)
        self.run_async(run())

    def test_add_models_uses_catalog(self):
        async def run():
            admin = await self.client.login("admin", "admin@example.com", "admin password")
            with mock.patch.object(catalog.CatalogStore, "_fetch", mock.AsyncMock(return_value=MODELS_DEV)):
                await self.service.catalog.sync()
            upstream = mock.AsyncMock(return_value=[{"model": "gpt-4o-2024-08-06", "display_name": None, "context_window": None},
                                                    {"model": "deepseek-reasoner", "display_name": None, "context_window": None}])
            with mock.patch("tgdrive.assistant.channels.providers.list_models", upstream):
                _, channel = await self.req("POST", "/api/admin/v1/assistant/channels",
                                            {"name": "OpenAI", "kind": "openai", "base_url": "http://127.0.0.1:9/v1"}, admin)
                _, found = await self.req("GET", f"/api/admin/v1/assistant/channels/{channel['id']}/discover", headers=admin)
                self.assertEqual(found["models"][0]["catalog_id"], "openai/gpt-4o")
                self.assertEqual(found["models"][0]["input_price"], 2.5)
                status, added = await self.req("POST", f"/api/admin/v1/assistant/channels/{channel['id']}/models/batch",
                                               {"models": ["gpt-4o-2024-08-06", "deepseek-reasoner"]}, admin)
                self.assertEqual((status, added["added"], added["enabled"]), (201, 2, 1))
                status, _ = await self.req("POST", f"/api/admin/v1/assistant/channels/{channel['id']}/models/batch", {"models": ["nope"]}, admin)
                self.assertEqual(status, 400)
            _, models = await self.req("GET", f"/api/admin/v1/assistant/channels/{channel['id']}/models", headers=admin)
            by_name = {m["model"]: m for m in models}
            gpt = by_name["gpt-4o-2024-08-06"]
            self.assertEqual((gpt["enabled"], gpt["tools"], gpt["context_window"], gpt["output_price"], gpt["label"]), (True, "yes", 128000, 10.0, "GPT-4o"))
            self.assertEqual((by_name["deepseek-reasoner"]["enabled"], by_name["deepseek-reasoner"]["tools"]), (False, "no"))
            self.assertTrue(by_name["deepseek-reasoner"]["capabilities"]["reasoning"])
        self.run_async(run())

    def test_catalog_sync_failure_and_settings(self):
        async def run():
            admin = await self.client.login("admin", "admin@example.com", "admin password")
            status, data = await self.req("POST", "/api/admin/v1/assistant/catalog/settings", {"url": "ftp://x"}, admin)
            self.assertEqual(status, 400)
            status, data = await self.req("POST", "/api/admin/v1/assistant/catalog/settings", {"url": "https://example.com/models.json", "auto_sync": False}, admin)
            self.assertEqual((status, data["url"], data["auto_sync"]), (200, "https://example.com/models.json", False))
            self.assertFalse(self.service.catalog.due())
            with mock.patch.object(catalog.CatalogStore, "_fetch", mock.AsyncMock(return_value=[1, 2])):
                status, data = await self.req("POST", "/api/admin/v1/assistant/catalog/sync", {}, admin)
            self.assertEqual(status, 400)
            _, data = await self.req("GET", "/api/admin/v1/assistant/catalog", headers=admin)
            self.assertTrue(data["status"]["error"])
            # 没有渠道时维护任务不会访问外网。
            await self.req("POST", "/api/admin/v1/assistant/catalog/settings", {"auto_sync": True}, admin)
            self.assertEqual(await self.service.sync_catalog_if_due(), {"skipped": True})
        self.run_async(run())


if __name__ == "__main__":
    unittest.main()
