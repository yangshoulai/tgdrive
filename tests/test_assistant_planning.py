"""计划状态与执行循环的定向回归；使用临时数据目录里的留痕与工具替身。"""

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, Mock, patch

from tgdrive.assistant.config import LIMITS
from tgdrive.assistant.planning import Plan, display_plan
from tgdrive.assistant.providers import Reply, ToolCall
from tgdrive.assistant.service import AssistantService, RunState
from tgdrive.assistant.tools import TOOLS, ToolContext, ToolOutput, ToolSpec
from tgdrive.assistant.web_tools import collect_gallery
from tgdrive.offline.http import DownloadError
from tests.trace_fixture import real_trace


def step(status="in_progress", **extra):
    return {"id": "one", "content": "核对文件", "status": status, **extra}


def result(call_id="c1", status="ok", **extra):
    return {"call_id": call_id, "name": "search_files", "status": status, "summary": "已查询", "result": {}, **extra}


def call(name, args=None, ident="c1"):
    return ToolCall(ident, name, json.dumps(args or {}, ensure_ascii=False))


class PlanTests(unittest.TestCase):
    def test_completion_requires_actual_result_and_stable_ids(self):
        plan = Plan("run")
        first = plan.update({"items": [step()]})
        with self.assertRaisesRegex(ValueError, "成功"):
            plan.update({"items": [step("completed")]})
        plan.begin("c1", "search_files", "one")
        with self.assertRaisesRegex(ValueError, "进行中"):
            plan.update({"items": [step("completed")]})
        plan.observe(result())
        final = plan.update({"items": [step("completed")]})
        self.assertEqual(final["id"], first["id"])
        self.assertEqual(final["status"], "completed")
        plan.begin("c2", "search_files", "one")
        self.assertEqual(plan.data["status"], "in_progress")
        with self.assertRaisesRegex(ValueError, "进行中"):
            plan.update({"items": [step("completed")]})
        plan.observe(result("c2"))
        plan.update({"items": [step("completed")]})
        plan.update({"items": [step("pending", content="重新核对并分类")]})
        self.assertEqual(plan.data["items"][0].get("evidence", []), [])
        with self.assertRaisesRegex(ValueError, "成功"):
            plan.update({"items": [step("completed", content="重新核对并分类")]})

    def test_confirmation_and_partial_action_results_are_not_completion(self):
        plan = Plan()
        plan.update({"items": [step()]})
        plan.begin("c1", "propose_move", "one")
        plan.observe(result(event={"type": "action", "action_id": "a1"}))
        self.assertEqual(plan.data["status"], "waiting_user")
        with self.assertRaisesRegex(ValueError, "待确认"):
            plan.update({"items": [step("completed")]})
        plan.reconcile([{"id": "a1", "status": "running"}])
        self.assertEqual(plan.data["status"], "in_progress")
        plan.reconcile([{"id": "a1", "status": "partial"}])
        self.assertEqual(plan.data["status"], "failed")
        plan.begin("c2", "propose_move", "one")
        plan.observe(result("c2", event={"type": "action", "action_id": "a2"}))
        plan.reconcile([{"id": "a1", "status": "partial"}, {"id": "a2", "status": "done"}])
        self.assertEqual(plan.data["status"], "completed")

    def test_reasoning_needs_summary_and_tool_use_prevents_bypass(self):
        plan = Plan()
        with self.assertRaisesRegex(ValueError, "detail"):
            plan.update({"items": [step("completed", kind="reasoning")]})
        plan.update({"items": [step(kind="reasoning")]})
        plan.begin("c1", "search_files", "one")
        plan.observe(result(status="error"))
        with self.assertRaisesRegex(ValueError, "纯分析"):
            plan.update({"items": [step("completed", kind="reasoning", detail="已分析")]})

    def test_explicit_plan_waits_for_all_calls_and_preserves_failure(self):
        plan = Plan("run")
        plan.update({"items": [step()]})
        calls = [call("search_files", ident=f"c{i}") for i in range(3)]
        for entry in calls:
            plan.begin(entry.id, entry.name, "one")
        plan.observe(result("c0", status="error"))
        plan.observe(result("c1"))
        plan.observe(result("c2"))
        self.assertEqual(plan.data["status"], "failed")
        retry = call("search_files", ident="retry")
        plan.begin(retry.id, retry.name, "one")
        plan.observe(result("retry"))
        plan.update({"items": [step("completed")]})
        self.assertEqual(plan.data["status"], "completed")

    def test_plan_can_be_edited_reordered_and_reopened_after_action_completion(self):
        plan = Plan("run")
        plan.update({"items": [step()]})
        plan.begin("c1", "propose_move", "one")
        plan.observe(result(event={"type": "action", "action_id": "a1"}))
        plan.reconcile([{"id": "a1", "status": "done"}])
        snapshot = plan.snapshot()
        resumed = Plan("next", snapshot)
        updated = resumed.update({"plan_id": snapshot["id"], "items": [
            {"id": "two", "content": "检查新规则", "status": "pending"}, step(content="按新要求整理")]})
        self.assertEqual(updated["id"], snapshot["id"])
        self.assertEqual(updated["status"], "in_progress")
        resumed.reconcile([{"id": "a1", "status": "done"}])
        self.assertEqual(resumed.data["items"][1]["status"], "in_progress", "旧操作不能完成重开的步骤")
        self.assertNotIn("actions", resumed.data["items"][1])
        resumed.begin("c2", "search_files", "no-longer-exists")
        self.assertNotIn("c2", resumed.calls, "过期的计划编号不阻止业务工具")

    def test_pending_steps_cannot_be_removed_and_metadata_does_not_block_reads(self):
        plan = Plan()
        plan.update({"items": [step()]})
        plan.begin("c1", "propose_move", "one")
        plan.observe(result(event={"type": "action", "action_id": "a1"}))
        with self.assertRaisesRegex(ValueError, "等待确认"):
            plan.update({"items": [{"id": "two", "content": "替换", "status": "pending"}]})
        plan.begin("c2", "search_files", "one")
        plan.observe(result("c2"))
        plan.reconcile([{"id": "a1", "status": "pending"}])
        self.assertEqual(plan.data["status"], "waiting_user")

    def test_resume_and_restart_keep_completed_steps(self):
        plan = Plan("run")
        plan.update({"items": [step("completed", kind="reasoning", detail="已确认范围"),
                               {"id": "two", "content": "执行整理", "status": "in_progress"}]})
        snapshot = display_plan(plan.snapshot(), [], active=False)
        self.assertEqual([item["status"] for item in snapshot["items"]], ["completed", "paused"])
        resumed = Plan("next-run", snapshot)
        event = resumed.update({"plan_id": snapshot["id"], "items": [snapshot["items"][0],
                                  {"id": "two", "content": "执行整理", "status": "in_progress"}]})
        self.assertEqual(event["id"], snapshot["id"])
        self.assertEqual(event["run_id"], "run")
        resumed.finish("stopped", "stopped")
        self.assertEqual([item["status"] for item in resumed.data["items"]], ["completed", "cancelled"])
        with self.assertRaisesRegex(ValueError, "当前对话"):
            Plan(candidate=snapshot).update({"plan_id": "other", "items": [step()]})

    def test_private_conversation_keeps_plan_in_trace(self):
        trace, _ = real_trace(self)
        cid = trace.create_conversation(1, "", 1, keep=1, private=True)
        rid = trace.start_run(cid, 1, "test")
        plan = Plan(rid)
        event = plan.update({"items": [step()]})
        trace.append(cid, rid, "event", {"type": "plan", "event": event}, tool_name="update_plan")
        self.assertEqual(trace.latest_plan(cid), event)
        trace.latest_plan(cid)["items"].clear()
        self.assertEqual(len(trace.latest_plan(cid)["items"]), 1)

    def test_tool_metadata_does_not_mutate_business_schema(self):
        spec = TOOLS["http_request"]
        self.assertIn("plan_step_id", spec.definition(planning=True).parameters["properties"])
        self.assertNotIn("plan_step_id", spec.parameters["properties"])
        self.assertNotIn("plan_step_id", spec.definition().parameters["properties"])

    def test_stopping_or_restarting_http_confirmation_is_resumable(self):
        plan = Plan()
        plan.update({"items": [step()]})
        plan.begin("http", "http_request", "one")
        plan.wait("http", "等待确认 HTTP 请求")
        snapshot = plan.snapshot()
        plan.finish("stopped", "stopped")
        self.assertEqual(plan.data["status"], "cancelled")
        self.assertEqual(display_plan(snapshot, [], active=False)["status"], "paused")

    def test_missing_confirmation_request_does_not_leave_plan_waiting(self):
        plan = Plan()
        plan.update({"items": [step("waiting_user")]})
        plan.finish("failed", "missing_review")
        self.assertEqual(plan.snapshot()["status"], "failed")
        self.assertIn("没有生成可确认", plan.snapshot()["items"][0]["detail"])

    def test_partial_tool_results_cannot_be_completed_by_changing_status(self):
        plan = Plan()
        plan.update({"items": [step()]})
        plan.begin("c1", "search_files", "one")
        plan.observe(result(result={"stopped": "达到上限"}))
        plan.update({"items": [step("paused")]})
        with self.assertRaisesRegex(ValueError, "成功"):
            plan.update({"items": [step("completed")]})
        plan.update({"items": [step()]})
        plan.begin("c2", "search_files", "one")
        plan.observe(result("c2"))
        self.assertEqual(plan.update({"items": [step("completed")]})["status"], "completed")

    def test_completion_flag_does_not_hide_failures_or_truncation(self):
        for payload in ({"complete": True, "failed": 1}, {"complete": True, "partial": True},
                        {"complete": True, "truncated": True}, {"complete": True, "body_complete": False}):
            with self.subTest(payload=payload):
                plan = Plan()
                plan.update({"items": [step()]})
                plan.begin("c1", "collect_gallery", "one")
                plan.observe(result(name="collect_gallery", result=payload))
                with self.assertRaisesRegex(ValueError, "成功"):
                    plan.update({"items": [step("completed")]})


class PlanBasisTests(unittest.TestCase):
    def test_explicit_basis_completes_unlinked_step_and_marks_it(self):
        plan = Plan()
        plan.update({"items": [step()]})
        with self.assertRaisesRegex(ValueError, "detail"):
            plan.update({"items": [step("completed")]})
        done = plan.update({"items": [step("completed", detail="上一步的搜索结果已列出全部 12 个文件")]})
        self.assertEqual(done["status"], "completed")
        self.assertTrue(done["items"][0]["unverified"])
        # 重新打开后旧依据清除，再完成仍需新的依据或真实结果。
        plan.update({"items": [step("pending")]})
        self.assertNotIn("unverified", plan.data["items"][0])

    def test_basis_cannot_close_running_or_unconfirmed_steps(self):
        plan = Plan()
        plan.update({"items": [step()]})
        plan.begin("c1", "search_files", "one")
        with self.assertRaisesRegex(ValueError, "进行中"):
            plan.update({"items": [step("completed", detail="模型认为已完成")]})
        plan.observe(result(event={"type": "action", "action_id": "a1"}))
        with self.assertRaisesRegex(ValueError, "待确认"):
            plan.update({"items": [step("completed", detail="模型认为已完成")]})

    def test_model_view_omits_internal_records_and_allows_twenty_steps(self):
        plan = Plan()
        items = [{"id": f"s{index}", "content": f"步骤 {index}", "status": "pending"} for index in range(20)]
        plan.update({"items": items})
        plan.begin("c1", "search_files", "s0")
        plan.observe(result())
        view = json.loads(plan.context())
        self.assertNotIn("evidence", view["items"][0])
        self.assertTrue(plan.actionable)
        with self.assertRaisesRegex(ValueError, "1–20"):
            plan.update({"items": items + [{"content": "多余", "status": "pending"}]})


class GalleryPlanTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def page(number, *, following=True):
        return {"url": f"https://photos.example/album?page={number}",
                "images": [{"path": "img.photo", "urls": {"src": "https://photos.example/a.jpg"}}],
                "links": [{"href": f"https://photos.example/album?page={number + 1}", "rel": "next",
                           "text": "下一页", "path": "a"}] if following else []}

    async def collect(self, pages, *, max_pages=50, params=None, snapshot=False):
        trace, _ = real_trace(self)
        cid = trace.create_conversation(1, "", 1, keep=1, private=True)
        rule = {"start_url": pages[0]["url"], "images": {"path": "img.photo", "attr": "src", "transform": []},
                "pagination": {"type": "next_link", "rel_next": True, "text": "下一页", "path": "a"}}
        if snapshot:
            sid = trace.create_collection(cid, 1, "snapshot", source="https://photos.example", rule=None,
                                          urls=pages, count=len(pages))
            rule.update(snapshot_id=sid, pagination={"type": "snapshot"})
        ident = trace.create_collection(cid, 1, "collection", source="https://photos.example", rule=rule, urls=[], count=0)
        ctx = ToolContext(1, 1, "", None, None, "private", "", params or {}, {}, conversation_id=cid,
                          trace=trace, base=".tgdrive/private/")
        with patch("tgdrive.assistant.web_tools._fetch_page", AsyncMock(side_effect=pages)) as fetch, \
                patch("tgdrive.assistant.web_tools.asyncio.sleep", AsyncMock()):
            output = await collect_gallery(ctx, {"collection_id": ident, "max_pages": max_pages})
        if snapshot:
            fetch.assert_not_awaited()
        self.assertEqual(len(trace.collection(1, ident)["urls"]), output.result["count"])
        plan = Plan("run")
        plan.update({"items": [step()]})
        plan.begin("c1", "collect_gallery", "one")
        plan.observe(result(name="collect_gallery", result=output.result))
        return output, plan

    async def test_natural_gallery_end_allows_plan_completion(self):
        for pages, snapshot in (([self.page(1), self.page(2)], False),
                                ([self.page(1, following=False)], False),
                                ([self.page(1), self.page(2)], True)):
            with self.subTest(snapshot=snapshot, pages=len(pages)):
                output, plan = await self.collect(pages, snapshot=snapshot)
                self.assertIs(output.result.get("complete"), True)
                self.assertEqual(output.result["count"], 1)
                self.assertEqual(plan.update({"items": [step("completed")]})["status"], "completed")

    async def test_limits_and_failed_pages_keep_plan_incomplete(self):
        for pages, options, reason in (([self.page(1)], {"max_pages": 1}, "页数上限"),
                                       ([self.page(1)], {"params": {"max_images": 1}}, "图片数上限"),
                                       ([self.page(1), DownloadError("页面返回 HTTP 404")], {}, "HTTP 404"),
                                       ([self.page(1), self.page(2)], {"snapshot": True, "max_pages": 1}, "页数上限")):
            with self.subTest(reason=reason):
                output, plan = await self.collect(pages, **options)
                self.assertIs(output.result.get("complete"), False)
                self.assertIn(reason, output.result["stopped"])
                self.assertIn(reason, plan.snapshot()["items"][0]["detail"])
                with self.assertRaisesRegex(ValueError, "one.*成功"):
                    plan.update({"items": [step("completed")]})

    async def test_runtime_limit_keeps_plan_incomplete(self):
        with patch("tgdrive.assistant.web_tools.time") as clock:
            clock.monotonic.side_effect = [0, 106]
            output, plan = await self.collect([self.page(1)])
        self.assertIs(output.result.get("complete"), False)
        self.assertIn("时间", output.result["stopped"])
        with self.assertRaisesRegex(ValueError, "成功"):
            plan.update({"items": [step("completed")]})


class LoopTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, replies):
        service = object.__new__(AssistantService)
        memory, _ = real_trace(self)
        cid = memory.create_conversation(1, "", 1, keep=1)
        rid = memory.start_run(cid, 1, "test")
        service.trace = memory
        state = RunState(rid, cid, 1, 1, "test", 1, "files", "")
        service._validate = Mock()
        service._acquire, service._title, service._attach_images = AsyncMock(), AsyncMock(), AsyncMock()
        service._background = set()
        service._release = Mock()
        service._context = AsyncMock(return_value=([], 0, 0, False))
        service._model_call = AsyncMock(side_effect=replies)
        service.channels = Mock()
        service.channels.model.return_value = {"id": 1, "channel_id": 1, "context_window": 1000000, "max_output": 1000}
        service.channels.vision.return_value = False
        service.config = Mock()
        service.config.limits.return_value = {name: rule[0] for name, rule in LIMITS.items()}
        service.objects, service.guard, service.attachments, service.settings = Mock(), Mock(), Mock(), Mock()
        service.objects.metadata.db.execute.return_value.fetchone.return_value = None
        service.guard.redact.side_effect = lambda value: value
        service.guard.redact_value.side_effect = lambda value: value
        service.attachments.for_conversation.return_value = {}
        service.offline, service.http_guard = None, None
        service._tool_settings = Mock(return_value={})
        service._conversation_taint = Mock(return_value=None)
        service._availability, service.private_space = Mock(return_value=(False, "未开放")), None
        service._fit = lambda value, limit: (value, False)
        service.search = AsyncMock(return_value=ToolOutput({"count": 1}, "找到 1 项"))
        spec = ToolSpec("search_files", "搜索文件", "browse", "read", "查询", {"type": "object", "properties": {}}, service.search)
        service._user_tools = Mock(return_value={"update_plan": TOOLS["update_plan"], "search_files": spec})
        return service, state

    async def run_fixture(self, replies):
        service, state = self.fixture(replies)
        with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
            await service._run(state)
        return service, state

    async def test_plan_precedes_parallel_work_and_uses_real_evidence(self):
        service, state = await self.run_fixture([
            Reply(tool_calls=[call("update_plan", {"items": [step()]}, "plan1"), call("search_files", {"plan_step_id": "one"})]),
            Reply(tool_calls=[call("update_plan", {"items": [step("completed")]}, "plan2")]), Reply(text="已核对")])
        self.assertEqual(state.status, "completed")
        self.assertEqual(service.trace.latest_plan(state.conversation_id)["status"], "completed")
        self.assertEqual(service.search.await_args.args[1], {})
        service.search.assert_awaited_once()

    async def test_final_check_has_one_retry_then_preserves_unfinished_plan(self):
        service, state = await self.run_fixture([Reply(tool_calls=[call("update_plan", {"items": [step()]})]),
                                                 Reply(text="已经全部完成"), Reply(text="本轮暂停")])
        messages = service.trace.messages(state.conversation_id)
        self.assertEqual(service._model_call.await_count, 3)
        self.assertEqual(sum(message.get("type") == "plan_check" for message in messages), 1)
        self.assertNotIn("已经全部完成", [message.get("text") for message in messages])
        self.assertEqual(state.stop_reason, "plan_incomplete")
        self.assertEqual(service.trace.latest_plan(state.conversation_id)["status"], "paused")

    async def test_simple_multiple_tool_calls_do_not_create_plan(self):
        service, state = await self.run_fixture([
            Reply(tool_calls=[call("search_files", ident="c1"), call("search_files", {"q": "next"}, "c2")]), Reply(text="已查询")])
        self.assertEqual(service.search.await_count, 2)
        self.assertIsNone(service.trace.latest_plan(state.conversation_id))

    async def test_waiting_claim_without_request_gets_one_repair_then_clear_failure(self):
        service, state = await self.run_fixture([Reply(text="等待你的确认，我会继续处理。"), Reply(text="等待你的确认。")])
        messages = service.trace.messages(state.conversation_id)
        self.assertEqual(service._model_call.await_count, 2)
        self.assertEqual(sum(message.get("type") == "review_check" for message in messages), 1)
        self.assertEqual(state.stop_reason, "missing_review")
        self.assertEqual(state.status, "failed")
        self.assertIn("没有生成可确认", messages[-1]["text"])

    async def test_promise_to_continue_gets_one_nudge_then_real_work(self):
        service, state = await self.run_fixture([Reply(text="已分析相册，我会自动继续处理剩下的页面。"),
                                                 Reply(tool_calls=[call("search_files", {})]), Reply(text="12 页都已处理完成。")])
        messages = service.trace.messages(state.conversation_id)
        self.assertEqual(service._model_call.await_count, 3)
        self.assertEqual([m.get("type") for m in messages if m["role"] == "event"], ["continue_check"])
        service.search.assert_awaited_once()
        self.assertEqual(state.status, "completed")
        self.assertEqual(messages[-1]["text"], "12 页都已处理完成。")
        # 只提醒一次：再次承诺时按普通回复结束，不会循环。
        service, state = await self.run_fixture([Reply(text="我会继续处理。"), Reply(text="我会继续处理。")])
        self.assertEqual(service._model_call.await_count, 2)
        self.assertEqual(state.status, "completed")
        # 普通的结束语不触发。
        service, state = await self.run_fixture([Reply(text="已完成。如果需要，我可以继续整理其他目录。")])
        self.assertEqual(service._model_call.await_count, 1)

    async def test_action_finishing_during_model_response_gets_consumed(self):
        service, state = self.fixture([])
        replies = iter(["旧的处理中回复", "已根据实际操作结果继续处理"])
        async def model(*args, **kwargs):
            if state.action_revision == 0:
                state.action_revision = 1
            return Reply(text=next(replies))
        service._model_call.side_effect = model
        with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
            await service._run(state)
        self.assertEqual(service._model_call.await_count, 2)
        self.assertEqual(state.seen_action_revision, 1)
        self.assertEqual(state.status, "completed")

    async def test_already_confirmed_running_action_is_not_a_missing_review(self):
        service, state = self.fixture([Reply(text="等待你的确认，我会继续处理。")])
        aid = service.trace.create_action(state.conversation_id, state.id, 1, "session", "move", "propose_move", {}, count=1)
        service.trace.start_action(aid)
        with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
            await service._run(state)
        self.assertEqual(state.stop_reason, "waiting_user")
        self.assertEqual(service._model_call.await_count, 1)
        self.assertIn("操作已确认，正在执行", service.trace.messages(state.conversation_id)[-1]["text"])

    async def test_run_finishes_before_slow_title_generation(self):
        service, state = self.fixture([Reply(text="空间里没有文件")])
        release = asyncio.Event()

        async def slow_title(_state):
            await release.wait()
        service._title = AsyncMock(side_effect=slow_title)
        events = []
        state.emit = AsyncMock(side_effect=lambda event: events.append(event))
        with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
            await asyncio.wait_for(service._run(state), 5)
        # 回复写完即结束这一轮：不用等标题，停止请求也不会落在收尾的模型调用上。
        self.assertEqual(state.status, "completed")
        self.assertEqual(events[-1]["type"], "run_finished")
        self.assertEqual(len(service._background), 1)
        release.set()
        await asyncio.gather(*service._background)
        service._title.assert_awaited_once()

    async def test_cancellation_keeps_explicit_plan_progress(self):
        service, state = await self.run_fixture([Reply(tool_calls=[call("update_plan", {"items": [step()]})]), asyncio.CancelledError()])
        self.assertEqual(state.status, "stopped")
        self.assertEqual(service.trace.latest_plan(state.conversation_id)["status"], "cancelled")

    async def test_budget_limit_keeps_limit_reason_and_plan_progress(self):
        service, state = self.fixture([Reply(tool_calls=[call("update_plan", {"items": [step()]})]), Reply(text="预算已用完")])
        service.config.limits.return_value["max_steps"] = 1
        with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
            await service._run(state)
        self.assertEqual(state.stop_reason, "limit")
        self.assertEqual(service.trace.latest_plan(state.conversation_id)["status"], "paused")

    def segmented(self, extra_replies, auto_continue=3):
        two = [step(), {"id": "two", "content": "整理结果", "status": "pending", "kind": "reasoning"}]
        replies = [Reply(tool_calls=[call("update_plan", {"items": two}, "p1")] + [call("search_files", {"plan_step_id": "one", "n": n}, f"s{n}")
                                                                                   for n in range(3)])] + extra_replies
        service, state = self.fixture(replies)
        service.config.limits.return_value.update(max_steps=1, auto_continue=auto_continue)
        return service, state

    async def test_budget_with_progress_continues_in_new_segment(self):
        done = [step("completed"), {"id": "two", "content": "整理结果", "status": "completed", "kind": "reasoning", "detail": "已汇总"}]
        service, state = self.segmented([Reply(tool_calls=[call("update_plan", {"items": done}, "p2")]), Reply(text="全部完成")])
        with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
            await service._run(state)
        types = [message.get("type") for message in service.trace.messages(state.conversation_id)]
        # 第二段完成了全部步骤，随后只做最终回复，不再续跑也不提示上限。
        self.assertEqual(types.count("continued"), 1)
        self.assertNotIn("limit", types)
        self.assertEqual(state.stop_reason, "completed")
        self.assertEqual(service.trace.latest_plan(state.conversation_id)["status"], "completed")

    async def test_continuation_disabled_or_without_progress_stops_at_limit(self):
        for auto, extra in ((0, [Reply(text="预算已用完")]),
                            (3, [Reply(tool_calls=[call("update_plan", {"items": [step(), {"id": "two", "content": "整理结果", "status": "pending"}]}, "p2")]),
                                 Reply(text="预算已用完")])):
            with self.subTest(auto=auto):
                service, state = self.segmented(extra, auto_continue=auto)
                with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
                    await service._run(state)
                types = [message.get("type") for message in service.trace.messages(state.conversation_id)]
                self.assertEqual(types.count("continued"), 0 if auto == 0 else 1)
                self.assertEqual(state.stop_reason, "limit")

    async def test_next_run_resumes_same_plan_without_repeating_completed_step(self):
        first = {"id": "scope", "content": "确认范围", "kind": "reasoning", "status": "completed", "detail": "已确认"}
        pending = step("paused")
        service, state = await self.run_fixture([Reply(tool_calls=[call("update_plan", {"items": [first, pending]})]), Reply(text="稍后继续")])
        previous = service.trace.latest_plan(state.conversation_id)
        rid = service.trace.start_run(state.conversation_id, 1, "test")
        resumed = RunState(rid, state.conversation_id, 1, 1, "test", 1, "files", "")
        service._model_call.side_effect = [
            Reply(tool_calls=[call("update_plan", {"plan_id": previous["id"], "items": [first, step()]}, "resume"),
                              call("search_files", {"plan_step_id": "one"})]),
            Reply(tool_calls=[call("update_plan", {"items": [first, step("completed")]}, "finish")]), Reply(text="核对完成")]
        with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
            await service._run(resumed)
        latest = service.trace.latest_plan(state.conversation_id)
        self.assertEqual((latest["id"], latest["status"]), (previous["id"], "completed"))
        self.assertEqual(latest["items"][0]["status"], "completed")
        service.search.assert_awaited_once()
        self.assertIn(previous["id"], service._model_call.call_args_list[-3].args[4][-1]["content"])


if __name__ == "__main__":
    unittest.main()
