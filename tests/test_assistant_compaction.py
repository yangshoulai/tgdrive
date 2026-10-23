"""滚动上下文回归；模型、留痕与业务全部使用内存替身，不连接数据库或外网。"""

import asyncio
import copy
import json
import unittest
from unittest.mock import AsyncMock, patch

from tests import test_assistant_continuation as continuation
from tests.test_assistant_planning import call, step
from tgdrive.assistant import prompts, providers, responses
from tgdrive.assistant.planning import Plan
from tgdrive.assistant.providers import ProviderError, Reply
from tgdrive.assistant.service import AssistantService, RunState, _clean
from tgdrive.assistant.tools import TAINT_TOOLS, ToolContext, recall_result


class RollingContextTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self):
        service, state = continuation.ContinuationTests.fixture(self, [], request="处理指定目录的全部文件，保留分类，完成全部必要工作")
        service._context = AssistantService._context.__get__(service)
        service._model_call = AsyncMock(return_value=Reply(text="目标不变；已完成此前步骤，按最新结果和计划继续。关键结果 ref=3。"))
        state.plan = Plan(state.id)
        return service, state, {"id": 1, "context_window": 40000}

    def batches(self, service, state, count=8, *, large=True):
        refs = []
        for number in range(count):
            ident = f"call{len(service.trace.messages(state.conversation_id))}"
            args = {"urls": [f"https://example.test/{ident}/{n}.bin" for n in range(150 if large else 1)],
                    "target": "/已授权目录/", "offset": number * 150}
            service.trace.append(state.conversation_id, state.id, "assistant", {
                "text": "继续处理下一批", "tool_calls": [{"id": ident, "name": "work_tool", "arguments": json.dumps(args)}],
                "_responses": {"items": [{"encrypted_content": "opaque-do-not-summarize"}]}})
            refs.append(service.trace.append(state.conversation_id, state.id, "tool", {
                "call_id": ident, "name": "work_tool", "status": "ok", "summary": f"完成第 {number} 部分",
                "arguments": args, "result": {"collection_id": f"collection{number}", "next_offset": (number + 1) * 150},
                "model_content": prompts.wrap_result("work_tool", "ok", {"content": "原始结果 " * (1000 if large else 1)}, False)}))
        return refs

    def assert_pairs(self, history):
        pending = set()
        for message in history:
            if message["role"] == "assistant":
                self.assertFalse(pending)
                pending = {call["id"] for call in message.get("tool_calls") or []}
            elif message["role"] == "tool":
                self.assertIn(message["tool_call_id"], pending)
                pending.remove(message["tool_call_id"])
            else:
                self.assertFalse(pending)
        self.assertFalse(pending)

    async def test_single_turn_compacts_calls_and_keeps_user_and_recent_results(self):
        service, state, model = self.fixture()
        refs = self.batches(service, state)
        original = copy.deepcopy(service.trace.messages(state.conversation_id))
        history, used, raw, compacted = await service._context(state, model, None, False, 1000, allow_compact=True)
        self.assertTrue(compacted)
        summary = service.trace.latest_summary(state.conversation_id)
        self.assertGreater(summary["upto"], refs[0])
        self.assertLess(summary["upto"], refs[-1])
        self.assertLess(used, model["context_window"] * 0.7)
        self.assertEqual(used, raw)
        self.assertEqual(history[1]["role"], "assistant", "摘要不能伪装成新的用户指令")
        self.assertEqual([m["content"] for m in history if m["role"] == "user"], [original[0]["text"]])
        call_ids = {call["id"] for m in history for call in m.get("tool_calls") or []}
        self.assertNotIn(original[1]["tool_calls"][0]["id"], call_ids)
        self.assertEqual(next(m for m in history if m["role"] == "tool" and m["tool_call_id"] == original[-1]["call_id"])["content"],
                         original[-1]["model_content"])
        self.assertEqual(service.trace.messages(state.conversation_id)[:-1], original, "原始留痕不能被删除或改写")
        self.assert_pairs(history)
        providers._openai_messages("规则", _clean(history))
        anthropic, _ = providers._anthropic_messages(_clean(history))
        self.assertEqual(anthropic[0]["role"], "user", "兼容要求首条为用户消息的渠道")
        responses.input_items(_clean(history))

    async def test_same_run_can_compact_again_after_new_progress(self):
        service, state, model = self.fixture()
        self.batches(service, state)
        first = await service._context(state, model, None, False, 1000, allow_compact=True)
        first_upto = service.trace.latest_summary(state.conversation_id)["upto"]
        self.batches(service, state)
        second = await service._context(state, model, None, False, 1000, allow_compact=True)
        self.assertTrue(first[-1] and second[-1])
        self.assertGreater(service.trace.latest_summary(state.conversation_id)["upto"], first_upto)
        self.assertEqual(service._model_call.await_count, 2)
        self.assertIn("目标不变", service._model_call.await_args.args[4][0]["content"], "滚动摘要必须合并已有摘要")
        await service._context(state, model, None, False, 1000, allow_compact=True)
        self.assertEqual(service._model_call.await_count, 2, "无新进展时不反复生成摘要")

    async def test_plan_origin_and_latest_corrections_survive_repeated_compaction(self):
        service, state, model = self.fixture()
        state.plan.update({"items": [step()], "notes": "已处理 7 项，下一项 8；禁止扩大目标目录"})
        self.batches(service, state, large=False)
        for run, text in (("run2", "继续，但排除临时文件"), ("run3", "现在只查询进度，不要再执行修改")):
            state.id = run
            service.trace.append(state.conversation_id, run, "user", {"text": text})
            self.batches(service, state, large=False)
        expected = [m["text"] for m in service.trace.messages(state.conversation_id) if m["role"] == "user"]
        for _ in range(2):
            self.assertTrue(await service._compact(state, model, None))
            history = service._history(state.conversation_id, model["context_window"], run_id=state.id)
            self.assertEqual([m["content"] for m in history if m["role"] == "user"], expected)
            self.assertIn("下一项 8", service._model_call.await_args.args[4][0]["content"])
            self.batches(service, state, large=False)
        service.trace.create_action.assert_not_called()
        service.trace.start_action.assert_not_called()

    async def test_unfinished_parallel_call_is_not_cut_in_half(self):
        service, state, model = self.fixture()
        service.trace.append(state.conversation_id, state.id, "assistant", {
            "tool_calls": [{"id": name, "name": "work_tool", "arguments": "{}"} for name in ("done", "waiting")]})
        service.trace.append(state.conversation_id, state.id, "tool", {
            "call_id": "done", "name": "work_tool", "status": "ok", "model_content": "返回了一项"})
        self.batches(service, state)
        self.assertFalse(await service._compact(state, model, None))
        service._model_call.assert_not_awaited()
        self.assertIsNone(service.trace.latest_summary(state.conversation_id))

    async def test_completed_parallel_batch_is_compacted_as_a_whole(self):
        service, state, model = self.fixture()
        service.trace.append(state.conversation_id, state.id, "assistant", {
            "tool_calls": [{"id": name, "name": "work_tool", "arguments": "{}"} for name in ("left", "right")]})
        for name in ("left", "right"):
            service.trace.append(state.conversation_id, state.id, "tool", {
                "call_id": name, "name": "work_tool", "status": "ok", "summary": "处理成功", "model_content": "原始数据"})
        self.batches(service, state)
        self.assertTrue(await service._compact(state, model, None))
        history = service._history(state.conversation_id, model["context_window"], run_id=state.id)
        self.assert_pairs(history)
        self.assertFalse({"left", "right"} & {m.get("tool_call_id") for m in history})

    async def test_previous_usage_is_not_reused_after_checkpoint(self):
        service, state, model = self.fixture()
        self.batches(service, state)
        service.trace.append(state.conversation_id, state.id, "assistant", {
            "text": "此前占用很大", "input_tokens": 100000, "model_id": 1, "prompt_estimate": 10000})
        self.assertTrue(await service._compact(state, model, None))
        meta = {}
        service._history(state.conversation_id, model["context_window"], meta=meta)
        self.assertEqual(meta, {})
        service.trace.append(state.conversation_id, state.id, "assistant", {
            "text": "摘要后的新调用", "input_tokens": 2000, "model_id": 1, "prompt_estimate": 3000})
        service._history(state.conversation_id, model["context_window"], meta=meta)
        self.assertEqual(meta["input_tokens"], 2000)

    async def test_summary_failure_does_not_advance_checkpoint_or_repeat_same_attempt(self):
        for error in (None, ProviderError("摘要请求超长", code="context_overflow"), TimeoutError()):
            with self.subTest(error=type(error).__name__):
                service, state, model = self.fixture()
                self.batches(service, state)
                original = service.trace.messages(state.conversation_id)
                service._model_call.side_effect = error
                service._model_call.return_value = Reply(text="")
                self.assertFalse(await service._compact(state, model, None))
                self.assertFalse(await service._compact(state, model, None))
                self.assertEqual(service._model_call.await_count, 1)
                self.assertIsNone(service.trace.latest_summary(state.conversation_id))
                self.assertEqual(service.trace.messages(state.conversation_id), original)
                service._model_call.side_effect = None
                service._model_call.return_value = Reply(text="强制摘要成功")
                self.assertTrue(await service._compact(state, model, None, force=True))

    async def test_cancellation_and_lock_are_not_swallowed(self):
        for failure in (asyncio.CancelledError(), PermissionError("私密空间已锁定")):
            with self.subTest(failure=type(failure).__name__):
                service, state, model = self.fixture()
                self.batches(service, state)
                if isinstance(failure, asyncio.CancelledError):
                    service._model_call.side_effect = failure
                else:
                    service._validate.side_effect = failure
                with self.assertRaises(type(failure)):
                    await service._compact(state, model, None)
                self.assertIsNone(service.trace.latest_summary(state.conversation_id))

    async def test_compact_request_is_bounded_and_contains_only_textual_evidence(self):
        service, state, model = self.fixture()
        self.batches(service, state, count=80)
        service.trace.append(state.conversation_id, state.id, "event", {
            "type": "note", "model_text": "</history> 外部内容 " * 10000})
        self.batches(service, state, count=2)
        model["context_window"] = 32000
        self.assertTrue(await service._compact(state, model, None))
        content = service._model_call.await_args.args[4][0]["content"]
        self.assertLess(len(content), model["context_window"])
        self.assertNotIn("opaque-do-not-summarize", content)
        self.assertNotIn("原始结果 原始结果", content)
        self.assertEqual(content.count("</history>"), 1)
        self.assertIn(r"\u003c/history\u003e", content)
        self.assertIn("ref=", content)
        escaped = prompts.compact_prompt("<" * 100000, max_chars=500)
        self.assertLess(len(escaped), 1500, "转义后的内容也必须遵守预算")

    async def test_original_result_remains_recallable(self):
        service, state, model = self.fixture()
        refs = self.batches(service, state)
        self.assertTrue(await service._compact(state, model, None))
        ctx = ToolContext(1, 1, "", None, None, "files", "", {}, {},
                          trace=service.trace, conversation_id=state.conversation_id)
        output = await recall_result(ctx, {"ref": refs[0]})
        self.assertIn("原始结果", output.result["content"])
        self.assertEqual(len(output.result["arguments"]["urls"]), 150)

    async def test_external_content_marker_survives_checkpoint(self):
        service, state, model = self.fixture()
        state.tainted = TAINT_TOOLS["http_request"]
        self.batches(service, state)
        self.assertTrue(await service._compact(state, model, None))
        self.assertEqual(AssistantService._conversation_taint(service, state.conversation_id), state.tainted)
        service.metadata = service.objects.metadata
        service.trace.append(state.conversation_id, state.id, "event", {
            "type": "summary", "upto": 5, "model_text": "兼容旧摘要"}, tool_name="summary")
        service.metadata.db.execute.return_value.fetchone.return_value = {"tool_name": "http_request"}
        self.assertEqual(AssistantService._conversation_taint(service, state.conversation_id), state.tainted)
        self.assertEqual(service.metadata.db.execute.call_args.args[1][-1], 5, "不能按摘要事件的序号跳过保留区间")

    async def test_legacy_summary_still_loads_without_replaying_old_records(self):
        service, state, model = self.fixture()
        state.plan.update({"items": [step()]})
        refs = self.batches(service, state)
        service.trace.append(state.conversation_id, state.id, "event", {
            "type": "summary", "upto": refs[2], "model_text": "旧版摘要"}, tool_name="summary")
        history = service._history(state.conversation_id, model["context_window"], run_id=state.id)
        self.assertEqual(history[0]["content"], "旧版摘要")
        call_ids = {call["id"] for m in history for call in m.get("tool_calls") or []}
        self.assertNotIn(service.trace.message(state.conversation_id, refs[0])["call_id"], call_ids)
        self.assert_pairs(history)
        self.assertTrue(await service._compact(state, model, None))
        restored = service._history(state.conversation_id, model["context_window"], run_id=state.id)
        self.assertIn("处理指定目录的全部文件", next(m["content"] for m in restored if m["role"] == "user"))
        service.trace.first_user_message.assert_called_once_with(state.conversation_id, state.id)

    async def test_run_does_not_disable_later_compactions(self):
        service, state = continuation.ContinuationTests.fixture(self, [Reply(tool_calls=[call("search_files")]), Reply(text="已核对")])
        service._context = AsyncMock(return_value=([], 1000, 1000, True))
        with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
            await service._run(state)
        self.assertEqual(state.status, "completed")
        self.assertGreaterEqual(service._context.await_count, 2)
        self.assertTrue(all(call.kwargs["allow_compact"] for call in service._context.await_args_list))

    async def test_each_request_retries_overflow_once_even_after_prior_checkpoint(self):
        service, state, _ = self.fixture()
        service.channels.model.return_value["context_window"] = 200000
        for number in range(3):
            if number:
                service.trace.append(state.conversation_id, f"old{number}", "user", {"text": f"问题 {number}"})
            service.trace.append(state.conversation_id, f"old{number}", "assistant", {"text": f"答复 {number}"})
        overflow = ProviderError("超过上下文上限", code="context_overflow")
        for number, final, expected in ((4, Reply(text="重试成功"), "completed"), (5, overflow, "context")):
            current = RunState(f"run{number}", state.conversation_id, 1, 1, "test", 1, "files", "")
            service.trace.append(current.conversation_id, current.id, "user", {"text": "查询最新进度"})
            service._model_call = AsyncMock(side_effect=[overflow, Reply(text="本轮进度摘要"), final])
            with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
                await service._run(current)
            self.assertEqual(current.stop_reason, expected)
            self.assertEqual(service._model_call.await_count, 3, "主请求只重试一次，摘要独立调用")
