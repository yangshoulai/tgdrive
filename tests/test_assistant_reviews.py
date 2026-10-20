"""确认等待与有效期回归：只使用内存留痕和替身，不创建数据库或访问外网。"""
import asyncio
import json
import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from tests.test_assistant_http import HttpFixture
from tgdrive.assistant.http_tools import HttpGuard, http_request
from tgdrive.assistant.private_chat import MemoryTrace
from tgdrive.assistant.providers import ToolCall
from tgdrive.assistant.service import AssistantService, RunState, _run_clock
from tgdrive.assistant.tools import ask_user, ToolError
from tgdrive.assistant.trace import TraceStore


class ReviewTests(unittest.IsolatedAsyncioTestCase):
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
        call = ToolCall("one", "http_request", json.dumps({"url": "https://public.example/api", "method": "POST"}))
        with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
            result = await AssistantService._execute(service, state, call, {}, {"tool_seconds": 0.02, "tool_result_bytes": 65536}, {})
        self.assertEqual(result["event"]["decision"], "rejected")
        self.assertEqual(service.offline.http.requests, [])

    async def test_open_questions_accept_text_without_options(self):
        result = await ask_user(None, {"question": "希望按什么规则命名？"})
        self.assertEqual(result.event["options"], [])
        self.assertTrue(result.ends_turn)
        with self.assertRaises(ToolError):
            await ask_user(None, {"question": "规则？", "options": ["x"] * 7})
