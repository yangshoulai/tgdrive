"""长对话按模型上下文判断，用量预算与上下文容量独立。"""
import json
import sqlite3
import unittest
from contextlib import closing
from types import SimpleNamespace

from tests.test_assistant import AssistantCase, answer
from tgdrive.assistant.actions import ActionExecutor
from tgdrive.assistant.write_tools import _folder_row, _match_rows


class AssistantLimitsTests(AssistantCase):
    def test_larger_loop_and_capacity_limits_save_and_reject_overflow_atomically(self):
        async def run():
            admin, _, _ = await self.setup_assistant()
            expected = {"max_steps": 2000, "max_tool_calls": 20_000, "parallel_calls": 128,
                        "repeat_threshold": 200, "error_threshold": 500, "run_seconds": 86_400,
                        "tool_seconds": 7200, "tool_result_bytes": 128 * 1024 * 1024, "run_tokens": 1_000_000_000,
                        "user_concurrency": 32, "global_concurrency": 256, "user_messages_per_minute": 600,
                        "max_conversations": 100_000, "action_items": 100_000, "download_urls": 50_000}
            status, original = await self.req("GET", "/api/admin/v1/assistant/limits", headers=admin)
            self.assertEqual(status, 200, original)
            self.assertEqual({name: original["bounds"][name]["max"] for name in expected}, expected)
            self.assertEqual(original["values"]["max_steps"], 40)
            self.assertEqual(original["values"]["global_concurrency"], 4)
            status, saved = await self.req("POST", "/api/admin/v1/assistant/limits", expected, admin)
            self.assertEqual(status, 200, saved)
            self.assertEqual({name: saved["values"][name] for name in expected}, expected)
            # 任意字段超过硬上限时，整个提交失败，不能把同次提交的其他字段部分保存。
            for name, high in expected.items():
                status, result = await self.req("POST", "/api/admin/v1/assistant/limits",
                                                {"max_steps": 40, name: high + 1}, admin)
                self.assertEqual(status, 400, (name, result))
                self.assertEqual(self.service.config.limits()["max_steps"], 2000)
            _, restored = await self.req("POST", "/api/admin/v1/assistant/limits", {"tool_seconds": 6000}, admin)
            self.assertEqual(restored["values"]["tool_seconds"], 6000)
            self.assertEqual(restored["values"]["max_steps"], 2000, "修改其他项保留既有自定义上限")
        self.run_async(run())

    def test_expanded_global_and_user_token_ranges_preserve_custom_values(self):
        async def run():
            admin, _, _ = await self.setup_assistant()
            _, settings = await self.req("GET", "/api/admin/v1/assistant/settings", headers=admin)
            self.assertEqual(settings["user_daily_tokens"], 10_000_000)
            self.assertEqual(settings["bounds"]["user_daily_tokens"]["max"], 10_000_000_000)
            for value in (10_000_000_000, 0, 42_000_000):
                status, settings = await self.req("POST", "/api/admin/v1/assistant/settings", {"user_daily_tokens": value}, admin)
                self.assertEqual(status, 200, settings)
                self.assertEqual(settings["user_daily_tokens"], value)
                status, policy = await self.req("POST", f"/api/admin/v1/assistant/users/{self.alice.id}/policy", {"daily_tokens": value}, admin)
                self.assertEqual(status, 200, policy)
                self.assertEqual(policy["effective"]["daily_tokens"], value)
            status, _ = await self.req("POST", "/api/admin/v1/assistant/settings", {"user_daily_tokens": 10_000_000_001}, admin)
            self.assertEqual(status, 400)
            _, limits = await self.req("GET", "/api/admin/v1/assistant/limits", headers=admin)
            self.assertEqual(limits["values"]["run_tokens"], 4_000_000)
            self.assertNotIn("max_messages", limits["values"])
            for value in (0, 100_000_000, 400_000):
                status, limits = await self.req("POST", "/api/admin/v1/assistant/limits", {"run_tokens": value, "max_messages": 20}, admin)
                self.assertEqual(status, 200, limits)
                self.assertEqual(limits["values"]["run_tokens"], value)
                self.assertNotIn("max_messages", limits["bounds"])
            await self.req("POST", "/api/admin/v1/assistant/limits", {"parallel_calls": 2}, admin)
            self.assertEqual(self.service.config.limits()["run_tokens"], 400_000, "更新其他选项不覆盖已有预算")
        self.run_async(run())

    def test_old_large_conversation_continues_and_latest_messages_are_not_lost(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            self.service.channels.update_model(model["id"], {"context_window": 128000})
            await self.req("POST", "/api/admin/v1/assistant/settings", {"user_daily_tokens": 10_000_000_000}, admin)
            user = await self.client.login("user", "alice@example.com", "alice password")
            conversation = await self.start_conversation(user)
            trace = self.service.trace
            self.service.config.write_raw("limits", {"max_messages": 20})
            trace.append(conversation, None, "user", {"text": "最早的用户要求"})
            for _ in range(5200):
                trace.append(conversation, None, "event", {"type": "progress", "text": "工具进度"})
            trace.add_usage(self.alice.id, model["id"], 100_000_001, 0)
            self.model.replies = [answer("可以继续"), answer("标题")]
            status, result = await self.send(user, conversation, "最新要求，继续处理")
            self.assertEqual(status, 201, result)
            self.assertEqual(self.service.runs[result["run_id"]].stop_reason, "completed")
            prompt = json.dumps(next(c for c in self.model.calls if c["tools"])["messages"], ensure_ascii=False)
            self.assertIn("最早的用户要求", prompt)
            self.assertIn("最新要求，继续处理", prompt, "第 5000 条后的内容也必须进入上下文")
            _, detail = await self.req("GET", f"/api/user/v1/assistant/conversations/{conversation}", headers=user)
            self.assertLess(detail["context"]["used"] / detail["context"]["window"], 0.2)
            self.assertEqual(detail["messages"][-1]["text"], "可以继续")
            self.assertEqual(len(detail["messages"]), 2000)
            all_messages = detail["messages"]
            cursor = detail["before_seq"]
            while cursor:
                status, page = await self.req("GET", f"/api/user/v1/assistant/conversations/{conversation}?before_seq={cursor}", headers=user)
                self.assertEqual(status, 200, page)
                self.assertLess(page["messages"][-1]["seq"], cursor)
                all_messages = page["messages"] + all_messages
                cursor = page["before_seq"]
            self.assertEqual([m["seq"] for m in all_messages], list(range(1, detail["conversation"]["messages"] + 1)))
            status, _ = await self.req("GET", f"/api/user/v1/assistant/conversations/{conversation}?before_seq=-1", headers=user)
            self.assertEqual(status, 400)
            # 摘要位于第 5000 条之后时，仍须找到它，并只传摘要及其后的内容。
            upto = all_messages[-1]["seq"]
            trace.append(conversation, None, "event", {"type": "summary", "upto": upto, "model_text": "保留的任务摘要"}, tool_name="summary")
            trace.append(conversation, None, "user", {"text": "摘要之后的最新要求"})
            history = json.dumps(self.service._history(conversation, model["context_window"]), ensure_ascii=False)
            self.assertIn("保留的任务摘要", history)
            self.assertIn("摘要之后的最新要求", history)
            self.assertNotIn("最早的用户要求", history)
        self.run_async(run())


class AssistantBulkCapacityTests(unittest.TestCase):
    def test_large_match_and_directory_revalidation_cover_entries_beyond_old_caps(self):
        with closing(sqlite3.connect(":memory:")) as db:
            db.row_factory = sqlite3.Row
            db.execute("CREATE TABLE objects(bucket_id INTEGER, key TEXT, etag TEXT, modified_at REAL, size INTEGER, "
                       "PRIMARY KEY(bucket_id,key))")
            db.executemany("INSERT INTO objects VALUES(1,?,?,1,1)",
                           ((f"source/{index:05}.txt", "etag") for index in range(55_000)))
            db.execute("INSERT INTO objects VALUES(1,'zz-other/last.txt','etag',1,1)")
            ctx = SimpleNamespace(db=db, bucket_id=1, limits={"action_items": 60_000},
                                  resolve=lambda path, **options: path.lstrip("/"), hide=lambda: "1=1", display=lambda key: "/" + key)
            rows = _match_rows(ctx, {"path": "/source/"}, limit=60_000)()
            self.assertEqual(len(rows), 55_000, "扫描预算应覆盖管理员配置的条目数，不再固定止于 50000")
            folders = _match_rows(ctx, {"path": "/", "type": "folder"}, limit=60_000)()
            self.assertEqual([row["key"] for row in folders], ["source/", "zz-other/"], "扫描尾部的目录也不能丢失")
            frozen = _folder_row(ctx, "source/", limit=60_000)
            executor = ActionExecutor(SimpleNamespace(metadata=SimpleNamespace(db=db)))
            self.assertIsNone(executor._check_source(1, "", frozen, "source/"), "大目录冻结和执行复核应使用完整版本")
            db.execute("UPDATE objects SET etag='changed' WHERE key='source/54999.txt'")
            self.assertEqual(executor._check_source(1, "", frozen, "source/"), "源文件夹内容已变化，请重新生成操作",
                             "旧复核边界之后的变化仍须检出")
