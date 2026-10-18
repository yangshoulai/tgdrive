"""助手批量调度回归：并发容量、真实执行计数、停止边界与整轮时限。"""
import asyncio
import json
from unittest import mock

from tests.test_assistant import AssistantCase, answer, call
from tgdrive.assistant.providers import Reply, ToolCall
from tgdrive.assistant.tools import TOOLS


def folder_calls(count):
    return [ToolCall(f"folder_{i}", "list_folder", json.dumps({"path": f"/相册{i:02d}/"}, ensure_ascii=False))
            for i in range(count)]


class AssistantLoopTests(AssistantCase):
    async def prepare(self, limits):
        admin, _, _ = await self.setup_assistant()
        status, result = await self.req("POST", "/api/admin/v1/assistant/limits", limits, admin)
        self.assertEqual(status, 200, result)
        user = await self.client.login("user", "alice@example.com", "alice password")
        return admin, user

    def test_large_reply_runs_all_calls_with_bounded_concurrency(self):
        async def run():
            _, user = await self.prepare({"parallel_calls": 8, "repeat_threshold": 10, "error_threshold": 5})
            conversation = await self.start_conversation(user)
            calls = folder_calls(23)
            self.model.replies = [Reply(tool_calls=calls), answer("已处理全部相册。")]
            execute = self.service._execute
            active = peak = 0
            started = []

            async def tracked(state, tool_call, *args):
                nonlocal active, peak
                active += 1
                peak = max(peak, active)
                started.append(tool_call.id)
                try:
                    await asyncio.sleep(0)
                    return await execute(state, tool_call, *args)
                finally:
                    active -= 1

            with mock.patch.object(self.service, "_execute", side_effect=tracked):
                _, result = await self.send(user, conversation, "批量处理相册")
            self.assertEqual(started, [c.id for c in calls])
            self.assertEqual((peak, active), (8, 0))
            self.assertEqual(self.service.runs[result["run_id"]].stop_reason, "completed")
            tools = [m for m in await self.messages(user, conversation) if m["role"] == "tool"]
            self.assertEqual([m["status"] for m in tools], ["ok"] * 23)
            returned = [m["tool_call_id"] for m in self.model.calls[1]["messages"] if m["role"] == "tool"]
            self.assertEqual(returned, [c.id for c in calls], "下一次模型调用必须拿到全部调用的结果")
            self.assertIn("最多同时执行 8 个", self.model.calls[0]["messages"][-1]["content"])
        self.run_async(run())

    def test_total_budget_skips_remaining_calls_without_false_loop_or_errors(self):
        async def run():
            _, user = await self.prepare({"max_tool_calls": 3, "parallel_calls": 2,
                                          "repeat_threshold": 2, "error_threshold": 1})
            conversation = await self.start_conversation(user)
            calls = folder_calls(18)
            self.model.replies = [Reply(tool_calls=calls), answer("已到工具总次数上限。")]
            _, result = await self.send(user, conversation, "批量处理相册")
            self.assertEqual(self.service.runs[result["run_id"]].stop_reason, "limit")
            tools = [m for m in await self.messages(user, conversation) if m["role"] == "tool"]
            self.assertEqual([m["status"] for m in tools], ["ok"] * 3 + ["limited"] * 15)
            self.assertEqual([m["arguments"] for m in tools], [json.loads(c.arguments) for c in calls])
            self.assertEqual(self.model.calls[1]["tools"], [], "触达总数后只允许模型总结")
            self.assertEqual(len([m for m in self.model.calls[1]["messages"] if m["role"] == "tool"]), 18)
            row = self.app.metadata.db.execute("SELECT tool_calls FROM assistant_runs WHERE id=?", (result["run_id"],)).fetchone()
            self.assertEqual(row["tool_calls"], 3, "排队但未执行的调用不占工具次数")
        self.run_async(run())

    def test_stop_conditions_do_not_start_later_batches(self):
        async def run():
            admin, user = await self.prepare({})
            duplicate = [ToolCall("dup_1", "list_folder", '{"path":"/","limit":10}'),
                         ToolCall("dup_2", "list_folder", '{"limit":10,"path":"/"}'),
                         ToolCall("dup_3", "list_folder", '{"path":"/", "limit":10}')]
            cases = [
                ("loop", {"parallel_calls": 1, "repeat_threshold": 2, "error_threshold": 8}, duplicate, 3),
                ("errors", {"parallel_calls": 2, "repeat_threshold": 4, "error_threshold": 2},
                 [call("read_text_file", path=f"/missing{i}.txt").tool_calls[0] for i in range(2)], 2),
                ("waiting_user", {"parallel_calls": 1, "error_threshold": 8},
                 call("ask_user", question="保存到哪里？", options=["相册", "下载"]).tool_calls, 1),
            ]
            for reason, limits, initial, count in cases:
                with self.subTest(reason=reason):
                    await self.req("POST", "/api/admin/v1/assistant/limits", limits, admin)
                    conversation = await self.start_conversation(user)
                    self.model.replies = [Reply(tool_calls=initial + folder_calls(3))]
                    _, result = await self.send(user, conversation, "处理相册")
                    self.assertEqual(self.service.runs[result["run_id"]].stop_reason, reason)
                    tools = [m for m in await self.messages(user, conversation) if m["role"] == "tool"]
                    self.assertEqual(len(tools), count + 3)
                    self.assertEqual([m["status"] for m in tools[count:]], ["cancelled"] * 3)
                    self.assertTrue(all("未执行" in m["summary"] for m in tools[count:]))
        self.run_async(run())

    def test_unavailable_calls_with_different_arguments_are_not_repeats(self):
        async def run():
            _, user = await self.prepare({"parallel_calls": 1, "repeat_threshold": 2, "error_threshold": 50})
            conversation = await self.start_conversation(user)
            calls = [ToolCall(str(i), "unavailable_tool", json.dumps({"url": f"https://example.invalid/{i}"})) for i in range(4)]
            self.model.replies = [Reply(tool_calls=calls), answer("工具不可用。")]
            _, result = await self.send(user, conversation, "处理相册")
            self.assertEqual(self.service.runs[result["run_id"]].stop_reason, "completed")
            tools = [m for m in await self.messages(user, conversation) if m["role"] == "tool"]
            self.assertEqual([m["status"] for m in tools], ["error"] * 4)
        self.run_async(run())

    def test_token_budget_is_checked_between_batches(self):
        async def run():
            _, user = await self.prepare({"parallel_calls": 1, "run_tokens": 4000})
            conversation = await self.start_conversation(user)
            self.model.replies = [Reply(tool_calls=folder_calls(3)), answer("已达到处理预算。")]
            execute = self.service._execute

            async def spend(state, *args):
                result = await execute(state, *args)
                state.input_tokens += 4000
                return result

            with mock.patch.object(self.service, "_execute", side_effect=spend):
                _, result = await self.send(user, conversation, "处理相册")
            self.assertEqual(self.service.runs[result["run_id"]].stop_reason, "limit")
            tools = [m for m in await self.messages(user, conversation) if m["role"] == "tool"]
            self.assertEqual([m["status"] for m in tools], ["ok", "limited", "limited"])
            self.assertIn("token 预算", tools[1]["summary"])
            self.assertEqual(self.model.calls[1]["tools"], [])
        self.run_async(run())

    def test_run_timeout_cancels_pending_tools_and_keeps_completed_results(self):
        async def run():
            _, user = await self.prepare({"parallel_calls": 2})
            conversation = await self.start_conversation(user)
            self.model.replies = [Reply(tool_calls=folder_calls(3)), answer("已到运行时间上限。")]
            handler = TOOLS["list_folder"].handler
            cancelled = asyncio.Event()
            started = []

            async def slow(context, arguments):
                started.append(arguments["path"])
                if arguments["path"] == "/相册01/":
                    try:
                        await asyncio.Event().wait()
                    finally:
                        cancelled.set()
                return await handler(context, arguments)

            limits = {**self.service.config.limits(), "run_seconds": 0.1}
            with mock.patch.object(self.service.config, "limits", return_value=limits), \
                    mock.patch.object(TOOLS["list_folder"], "handler", side_effect=slow):
                _, result = await self.send(user, conversation, "处理相册")
            self.assertTrue(cancelled.is_set(), "超时后必须等待进行中的工具完成取消")
            self.assertEqual(started, ["/相册00/", "/相册01/"])
            self.assertEqual(self.service.runs[result["run_id"]].stop_reason, "limit")
            tools = [m for m in await self.messages(user, conversation) if m["role"] == "tool"]
            self.assertEqual([m["status"] for m in tools], ["ok", "limited", "limited"])
            self.assertIn("已取消", tools[1]["summary"])
            self.assertIn("未执行", tools[2]["summary"])
            self.assertEqual(self.model.calls[1]["tools"], [])
        self.run_async(run())

    def test_stopping_run_cancels_all_active_tools(self):
        async def run():
            _, user = await self.prepare({"parallel_calls": 2})
            conversation = await self.start_conversation(user)
            self.model.replies = [Reply(tool_calls=folder_calls(3))]
            ready = asyncio.Event()
            started, cancelled = [], []

            async def slow(context, arguments):
                started.append(arguments["path"])
                if len(started) == 2:
                    ready.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.append(arguments["path"])

            with mock.patch.object(TOOLS["list_folder"], "handler", side_effect=slow):
                status, result = await self.req("POST", f"/api/user/v1/assistant/conversations/{conversation}/messages",
                                                {"text": "处理相册"}, user)
                self.assertEqual(status, 201, result)
                await asyncio.wait_for(ready.wait(), 2)
                status, _ = await self.req("POST", f"/api/user/v1/assistant/runs/{result['run_id']}/stop", {}, user)
                self.assertEqual(status, 204)
                await self.service.runs[result["run_id"]].task
            self.assertEqual(self.service.runs[result["run_id"]].stop_reason, "stopped")
            self.assertEqual(started, ["/相册00/", "/相册01/"])
            self.assertCountEqual(cancelled, started, "用户停止后不能留下仍在执行的工具任务")
        self.run_async(run())
