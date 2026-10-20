"""确认等待与有效期回归：只使用内存留痕和替身，不创建数据库或访问外网。"""
import asyncio
import json
import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from tests.test_assistant_http import HttpFixture
from tgdrive.assistant.http_tools import HttpGuard, http_request
from tgdrive.assistant.private_chat import MemoryTrace, RoutedTrace
from tgdrive.assistant.actions import Progress
from tgdrive.assistant.providers import ToolCall
from tgdrive.assistant.service import AssistantService, PrivateBinding, RunState, _run_clock
from tgdrive.assistant.tools import ask_user, ToolError
from tgdrive.assistant.trace import TraceStore


class ReviewTests(unittest.IsolatedAsyncioTestCase):
    def continuation_fixture(self):
        memory = MemoryTrace()
        cid = memory.create_conversation(1, "", 1)
        rid = memory.start_run(cid, 1, "test")
        memory.finish_run(rid, status="completed", stop_reason="waiting_user", steps=1, tool_calls=1, input_tokens=0, output_tokens=0)
        service = object.__new__(AssistantService)
        service.memory, service.trace = memory, RoutedTrace(Mock(), memory)
        origin = RunState(rid, cid, 1, 1, "session", 1, "private", "", status="completed", finished_at=1, access="grant")
        service.runs = {rid: origin}
        service.private_chats = {cid: PrivateBinding("session", "grant", 1)}
        service._execution_tasks, service.executions, service.private_space, service.on_audit = {}, {}, None, None
        service._session = Mock(return_value=(None, SimpleNamespace(id=1, bucket_id=1)))
        service._check_private, service._require_available, service._admit = Mock(), Mock(), Mock()
        service._choose_model = Mock(return_value=1)
        service._start = Mock(side_effect=lambda run_id, *args, **kwargs: SimpleNamespace(id=run_id))
        aid = memory.create_action(cid, rid, 1, "session", "move", "propose_move", {}, count=1)
        memory.start_action(aid)
        return service, origin, memory.action(1, aid)

    async def test_confirmation_result_continues_once_after_all_actions_settle(self):
        service, origin, row = self.continuation_fixture()
        async def execute(**kwargs):
            kwargs["progress"].ok = 1
        service.executor = SimpleNamespace(execute=execute)
        extra = service.memory.create_action(origin.conversation_id, origin.id, 1, "session", "move", "propose_move", {}, count=1)
        outcome = await service._run_action(row, SimpleNamespace(id=1, bucket_id=1), {}, Progress(total=1), "session",
                                          service.trace.action_recorder(row["id"], origin.conversation_id), access="grant")
        self.assertEqual(outcome["status"], "done")
        service._start.assert_not_called()
        service.memory.start_action(extra)
        second = service.memory.action(1, extra)
        await service._run_action(second, SimpleNamespace(id=1, bucket_id=1), {}, Progress(total=1), "session",
                                  service.trace.action_recorder(extra, origin.conversation_id), access="grant")
        results = await asyncio.gather(service._continue_action(row, "session", "grant"), service._continue_action(row, "session", "grant"))
        self.assertEqual(results, [None, None])
        service._start.assert_called_once()

    async def test_switching_mode_preserves_current_run_and_pending_request(self):
        service, origin, row = self.continuation_fixture()
        origin.status, origin.finished_at = "running", None
        origin.task = asyncio.get_running_loop().create_future()
        service._access_mode = Mock(return_value="full")
        result = service.update_conversation("session", "csrf", origin.conversation_id, {"access_mode": "full"}, "grant")
        self.assertEqual(result["access_mode"], "full")
        self.assertFalse(origin.task.done())
        self.assertEqual(service.memory.action(1, row["id"])["status"], "running")
        service._start.assert_not_called()
        origin.task.set_result(None)

    async def test_old_stopped_or_unauthorized_task_cannot_resume(self):
        for reason in ("new_task", "stopped", "revoked", "rejected"):
            with self.subTest(reason=reason):
                service, origin, row = self.continuation_fixture()
                service.memory.action_recorder(row["id"], origin.conversation_id)("done", {}, None, {})
                if reason == "new_task":
                    service.memory.start_run(origin.conversation_id, 1, "new")
                elif reason == "stopped":
                    service.memory.runs[origin.id].update(status="stopped", stop_reason="stopped")
                elif reason == "rejected":
                    aid = service.memory.create_action(origin.conversation_id, origin.id, 1, "session", "move", "propose_move", {}, count=1)
                    service.memory.decide_action(aid, "rejected")
                else:
                    service._check_private.side_effect = PermissionError("已锁定")
                self.assertIsNone(await service._continue_action(row, "session", "grant"))
                service._start.assert_not_called()

    async def test_result_arriving_after_final_response_is_not_lost(self):
        for seen in (False, True):
            with self.subTest(seen=seen):
                service, origin, row = self.continuation_fixture()
                service.memory.action_recorder(row["id"], origin.conversation_id)("done", {}, None, {})
                service.memory.runs[origin.id]["stop_reason"] = "completed"
                origin.action_revision, origin.seen_action_revision = 1, int(seen)
                continued = await service._continue_action(row, "session", "grant")
                self.assertEqual(continued is not None, not seen)

    async def test_private_keepalive_uses_real_work_and_same_binding(self):
        service, origin, row = self.continuation_fixture()
        blocker = asyncio.get_running_loop().create_future()
        origin.status, origin.finished_at, origin.task = "running", None, blocker
        self.assertTrue(service.private_busy("session", "grant"))
        self.assertFalse(service.private_busy("other", "grant"))
        origin.approval_waiters = 1
        self.assertFalse(service.private_busy("session", "grant"))
        service._execution_tasks[row["id"]] = blocker
        self.assertTrue(service.private_busy("session", "grant"))
        blocker.set_result(None)
        self.assertFalse(service.private_busy("session", "grant"))

    async def test_new_requests_preserve_existing_confirmation_queue(self):
        memory = MemoryTrace()
        cid = memory.create_conversation(1, "", 1)
        ids = [memory.create_action(cid, "r", 1, "s", "move", "propose_move", {}, count=1) for _ in range(128)]
        self.assertEqual(len(memory.pending_actions(cid)), 128)
        with self.assertRaisesRegex(ValueError, "原有请求已保留"):
            memory.create_action(cid, "r", 1, "s", "move", "propose_move", {}, count=1)
        self.assertTrue(all(memory.action(1, aid)["status"] == "pending" for aid in ids))

    async def test_action_lifetime_is_one_day_for_both_stores(self):
        database = Mock()
        database.execute.return_value.fetchall.return_value = []
        trace = SimpleNamespace(metadata=SimpleNamespace(db=database, transaction=lambda: nullcontext(database)),
                                _seal=lambda *args: b"fixture")
        with patch("tgdrive.assistant.trace.time.time", return_value=1000):
            TraceStore.create_action(trace, "c", "r", 1, "session", "move", "propose_move", {}, count=1)
            memory = MemoryTrace()
            cid = memory.create_conversation(1, "", 1)
            aid = memory.create_action(cid, "r", 1, "session", "move", "propose_move", {}, count=1)
        arguments = database.execute.call_args.args[1]
        self.assertEqual(arguments[-1] - arguments[-2], 86400)
        row = memory.action(1, aid)
        with patch("tgdrive.assistant.private_chat.time.time", return_value=4600):
            self.assertEqual(memory.action_json(row)["status"], "pending")
        with patch("tgdrive.assistant.private_chat.time.time", return_value=87401):
            self.assertEqual(memory.action_json(row)["status"], "expired")
            self.assertFalse(memory.decide_action(aid, "confirmed"))

    async def test_parallel_approvals_pause_run_clock_once(self):
        events, clock = [], [100.0]
        async def emit(event):
            events.append(event)
        state = SimpleNamespace(listeners=1, client_waiters={}, emit=emit)
        fake_time = SimpleNamespace(monotonic=lambda: clock[0], time=lambda: 1000)
        with patch("tgdrive.assistant.service.time", fake_time):
            first = asyncio.create_task(AssistantService._client_call(None, state, "one", "http_request_approval", {}))
            await asyncio.sleep(0)
            clock[0] = 110
            second = asyncio.create_task(AssistantService._client_call(None, state, "two", "http_request_approval", {}))
            await asyncio.sleep(0)
            self.assertEqual(_run_clock(state), 100)
            self.assertTrue(all(event["expires_at"] == 2800 for event in events))
            clock[0] = 120
            state.client_waiters[events[0]["call_id"]].set_result({"approved": False})
            await first
            self.assertEqual(state.approval_waiters, 1)
            clock[0] = 140
            state.client_waiters[events[1]["call_id"]].set_result({"approved": True})
            await second
            self.assertEqual(state.approval_seconds, 40)
            self.assertEqual(state.approval_waiters, 0)
            clock[0] = 145
            self.assertEqual(_run_clock(state), 105)

    async def test_human_wait_outlives_run_budget_but_work_still_times_out(self):
        state = RunState("run", "chat", 1, 1, "session", 1, "files", "", listeners=1)
        call = ToolCall("one", "http_request", "{}")
        async def execute(*args):
            task = asyncio.create_task(AssistantService._client_call(None, state, "one", "http_request_approval", {}))
            await asyncio.sleep(0)
            future = next(iter(state.client_waiters.values()))
            asyncio.get_running_loop().call_later(0.15, future.set_result, {"approved": False})
            return await task
        service = SimpleNamespace(_execute=execute, _skipped_tool=AssistantService._skipped_tool)
        result = await AssistantService._tool_batch(service, state, [call], {}, {}, {}, _run_clock(state) + 0.05)
        self.assertEqual(result, [{"approved": False}])
        async def slow(*args):
            await asyncio.sleep(0.15)
        service._execute = slow
        result = await AssistantService._tool_batch(service, state, [call], {}, {}, {}, _run_clock(state) + 0.02)
        self.assertEqual(result[0]["status"], "limited")

    async def test_http_review_does_not_consume_tool_timeout(self):
        service = Mock()
        service._user_tools.return_value = {"http_request": SimpleNamespace(handler=http_request, level="meta", timeout=0)}
        service._tool_settings.return_value = {}
        service._conversation_taint.return_value = None
        service.trace.conversation.return_value = {"scope_root": "", "access_mode": "approval"}
        service.objects.metadata.db.execute.return_value.fetchone.return_value = None
        service.guard.redact.side_effect = lambda value: value
        service.guard.redact_value.side_effect = lambda value: value
        service._fit.side_effect = lambda value, limit: (value, False)
        async def reject(*args, review):
            review.update(id="review", requested_at=1)
            await asyncio.sleep(0.06)
            return {"approved": False}
        service._client_call = AsyncMock(side_effect=reject)
        service.offline, service.http_guard = SimpleNamespace(http=HttpFixture()), HttpGuard()
        state = SimpleNamespace(id="r", user_id=1, bucket_id=1, conversation_id="c", private=False, view="files", location="",
                                environment={}, model_id=1, tainted=None, emit=AsyncMock())
        call = ToolCall("one", "http_request", json.dumps({"url": "https://public.example/api", "method": "POST", "max_bytes": 100000}))
        with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
            result = await AssistantService._execute(service, state, call, {}, {"tool_seconds": 0.02, "tool_result_bytes": 65536}, {})
        self.assertEqual(result["event"]["decision"], "rejected")
        self.assertNotIn("max_bytes", result["arguments"])
        self.assertEqual(service.offline.http.requests, [])

    async def test_open_questions_accept_text_without_options(self):
        result = await ask_user(None, {"question": "希望按什么规则命名？"})
        self.assertEqual(result.event["options"], [])
        self.assertTrue(result.ends_turn)
        with self.assertRaises(ToolError):
            await ask_user(None, {"question": "规则？", "options": ["x"] * 7})
