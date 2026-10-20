"""HTTP 能力与安全边界的定向回归；使用内存替身，不建数据库、不访问外网。"""
import asyncio
import base64
import json
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from tgdrive.assistant.guard import HIDDEN
from tgdrive.assistant.http_tools import HttpGuard, http_request
from tgdrive.assistant.tools import TOOLS, ToolContext, ToolError
from tgdrive.assistant.service import AssistantService
from tgdrive.offline.http import DownloadError, HttpResponse, SafeHttpClient, public_ip
from tgdrive.offline.request import DownloadRequest


class HttpFixture:
    def __init__(self, body=b'{"ok":true}', mime="application/json", status=200, headers=None, hops=()):
        self.body, self.mime, self.status = body, mime, status
        self.headers, self.hops, self.requests = headers or {}, hops, []

    @asynccontextmanager
    async def open(self, request, **options):
        if options.get("url_check"):
            for url in [request.url, *self.hops]:
                options["url_check"](url)
        self.requests.append((request, options))
        body = self.body if request.method != "HEAD" else b""
        async def stream():
            yield body
        yield SimpleNamespace(status=self.status, url=request.url, size=len(body), history=[],
                              headers={"content-type": self.mime, **self.headers},
                              raw_headers=list({"content-type": self.mime, **self.headers}.items()), stream=stream)


def context(http=None, **kwargs):
    return ToolContext(1, 1, "", None, SimpleNamespace(http=http or HttpFixture()), "files", "", {}, {},
                       http_guard=HttpGuard(), client=AsyncMock(return_value={"approved": True}),
                       http_authorize=Mock(), **kwargs)


class HttpToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_html_and_head_return_response_headers(self):
        ctx = context(HttpFixture(b"<html>example</html>", "text/html", headers={"x-demo": "yes"}))
        result = await http_request(ctx, {"url": "https://public.example/page"})
        self.assertEqual(result.result["text"], "<html>example</html>")
        self.assertEqual(result.result["headers"]["x-demo"], "yes")
        self.assertEqual(result.result["url"], "https://public.example/page")
        ctx.client.assert_not_awaited()
        head = await http_request(context(), {"url": "https://public.example/api", "method": "HEAD"})
        self.assertIn("headers", head.result)
        self.assertEqual(head.result["read_bytes"], 0)

    async def test_post_freezes_json_query_headers_before_confirmation(self):
        ctx = context()
        args = {"url": "https://public.example/api?fixed=1", "method": "POST", "query": {"q": ["a b", "中文"]},
                "headers": {"X-Demo": "yes", "Authorization": "Bearer third-party-token"}, "json": {"name": "中文"}}
        async def approve(name, review):
            self.assertEqual(name, "http_request_approval")
            self.assertEqual(review["headers"]["Authorization"], HIDDEN)
            self.assertEqual(ctx.offline.http.requests, [])
            args["url"] = "https://other.example/"
            args["json"]["name"] = "changed"
            return {"approved": True, "url": "https://evil.example/"}
        ctx.client.side_effect = approve
        await http_request(ctx, args)
        request, options = ctx.offline.http.requests[0]
        self.assertTrue(request.url.startswith("https://public.example/api?fixed=1&q="))
        self.assertEqual(json.loads(options["request_body"]), {"name": "中文"})
        self.assertIn(("Authorization", "Bearer third-party-token"), request.headers)
        self.assertFalse(options["redirects"])
        self.assertGreaterEqual(ctx.http_authorize.call_count, 2)

    async def test_rejection_and_non_boolean_approval_never_send(self):
        for decision in ({"approved": False}, {"approved": "true"}, {"error": "closed"}):
            ctx = context()
            ctx.client.return_value = decision
            with self.assertRaisesRegex(ToolError, "未确认"):
                await http_request(ctx, {"url": "https://public.example/api", "method": "POST"})
            self.assertEqual(ctx.offline.http.requests, [])

    async def test_post_form_raw_binary_and_other_methods(self):
        for args, expected in [({"method": "POST", "form": {"name": "a b", "id": [1, 2]}}, b"name=a+b&id=1&id=2"),
                               ({"method": "PATCH", "body": "<xml/>"}, b"<xml/>"),
                               ({"method": "PUT", "body_base64": base64.b64encode(b"\0\xff").decode()}, b"\0\xff"),
                               ({"method": "DELETE"}, None), ({"method": "OPTIONS"}, None)]:
            ctx = context()
            await http_request(ctx, {"url": "https://public.example/api", **args})
            request, options = ctx.offline.http.requests[0]
            self.assertEqual(request.method, args["method"])
            self.assertEqual(options.get("request_body"), expected)
            self.assertEqual(ctx.client.await_count, 0 if args["method"] == "OPTIONS" else 1)

    async def test_basic_auth_is_built_on_server(self):
        ctx = context()
        await http_request(ctx, {"url": "https://public.example/api", "auth": {"type": "basic", "username": "demo", "password": "pass"}})
        self.assertIn(("Authorization", "Basic " + base64.b64encode(b"demo:pass").decode()), ctx.offline.http.requests[0][0].headers)
        ctx.client.assert_awaited_once()

    async def test_empty_success_and_explicit_binary_format(self):
        output = (await http_request(context(HttpFixture(b"", status=204)), {"url": "https://public.example/api", "method": "DELETE"})).result
        self.assertEqual((output["status"], output["format"]), (204, "empty"))
        output = (await http_request(context(HttpFixture(b"<html>example</html>", "text/html")), {"url": "https://public.example/", "response_format": "binary"})).result
        self.assertEqual(output["format"], "binary")
        self.assertEqual(base64.b64decode(output["sample_base64"]), b"<html>example</html>")

    async def test_signed_resource_urls_preserved_but_text_credentials_hidden(self):
        url = "https://cdn.example/video?access_token=resource-signature-12345"
        ctx = context(HttpFixture(('<a href="' + url + '">video</a> password=private-password').encode(), "text/html"))
        output = (await http_request(ctx, {"url": "https://public.example/"})).result
        self.assertIn(url, output["text"])
        self.assertNotIn("private-password", output["text"])

    async def test_form_password_is_masked_in_confirmation(self):
        ctx = context()
        await http_request(ctx, {"url": "https://public.example/login", "method": "POST", "form": {"password": "short", "username": "demo"}})
        review = ctx.client.call_args.args[1]
        self.assertIn("password=" + HIDDEN, review["body"])
        self.assertNotIn("short", review["body"])

    async def test_wire_headers_methods_and_ambiguous_bodies_rejected(self):
        cases = [{"method": "CONNECT"}, {"method": "GET\r\nX: y"}, {"json": {}, "body": ""}, {"body_base64": "!not-base64"},
                 *[{"headers": {name: "bad"}} for name in ("Host", "Content-Length", "Transfer-Encoding", "Connection", "Proxy-Authorization")],
                 {"headers": {"X-Demo": "value\r\nInjected: yes"}}, {"headers": {"Accept": "a", "accept": "b"}}]
        for args in cases:
            with self.subTest(args=args):
                ctx = context()
                with self.assertRaises(ToolError):
                    await http_request(ctx, {"url": "https://public.example/", **args})
                self.assertEqual(ctx.offline.http.requests, [])

    async def test_system_credentials_cannot_be_sent_or_referenced(self):
        secret = "system-channel-secret"
        for args in [{"headers": {"Authorization": secret}}, {"body": secret},
                     {"auth": {"type": "basic", "username": "user", "password": secret}},
                     {"body_base64": base64.b64encode(secret.encode()).decode()}]:
            ctx = context(redact=lambda text: text.replace(secret, HIDDEN))
            with self.assertRaisesRegex(ToolError, "系统凭据"):
                await http_request(ctx, {"url": "https://public.example/", **args})
            self.assertEqual(ctx.offline.http.requests, [])
        ctx = context(HttpFixture(json.dumps({"access_token": secret}).encode()), redact=lambda text: text.replace(secret, HIDDEN))
        output = await http_request(ctx, {"url": "https://public.example/token"})
        self.assertNotIn("credential_refs", output.result)
        self.assertEqual(ctx.state["http_secrets"], {})

    async def test_tokens_reusable_in_same_origin_and_json_escaping_preserved(self):
        token = 'third-party-"quoted"\\token'
        ctx = context(HttpFixture(json.dumps({"access_token": token, "url": "https://cdn.example/file?token=download"}).encode(), headers={"set-cookie": "session=abc12345; HttpOnly; Path=/"}))
        output = (await http_request(ctx, {"url": "https://public.example/token"})).result
        reference = output["credential_refs"]["$.access_token"]
        self.assertEqual(output["data"]["access_token"], HIDDEN)
        self.assertNotIn(token, json.dumps(output))
        self.assertIn("token=download", output["data"]["url"])
        self.assertIn("cookie.session", output["credential_refs"])
        await http_request(ctx, {"url": "https://public.example/api", "method": "POST", "json": {"token": reference}})
        self.assertEqual(json.loads(ctx.offline.http.requests[-1][1]["request_body"])["token"], token)
        await http_request(ctx, {"url": "https://public.example/api", "query": {"token": reference}})
        self.assertIn("token=third-party-", ctx.offline.http.requests[-1][0].url)
        for destination in ("https://other.example/", "http://public.example/", "https://public.example:444/"):
            with self.assertRaisesRegex(ToolError, "凭据引用"):
                await http_request(ctx, {"url": destination, "headers": {"Authorization": "Bearer " + reference}})
        with self.assertRaisesRegex(ToolError, "凭据引用"):
            await http_request(context(), {"url": "https://public.example/", "headers": {"Cookie": reference}})

    async def test_admin_can_disable_advanced_but_keep_public_queries(self):
        ctx = context()
        ctx.params["allow_advanced_requests"] = 0
        await http_request(ctx, {"url": "https://public.example/"})
        with self.assertRaisesRegex(ToolError, "管理员已关闭"):
            await http_request(ctx, {"url": "https://public.example/", "method": "POST"})
        self.assertEqual(len(ctx.offline.http.requests), 1)

    async def test_tainted_query_does_not_prompt_and_permission_is_rechecked(self):
        ctx = context(tainted=lambda: "读取过网页")
        ctx.http_authorize.side_effect = [None, ToolError("权限已撤销")]
        with self.assertRaisesRegex(ToolError, "权限已撤销"):
            await http_request(ctx, {"url": "https://public.example/api"})
        ctx.client.assert_not_awaited()
        self.assertEqual(ctx.offline.http.requests, [])

    async def test_bounded_bodies_and_responses(self):
        ctx = context(HttpFixture(b"x" * 5000, "text/plain"))
        ctx.params.update(max_request_bytes=10, max_response_bytes=1024)
        ctx.limits["tool_result_bytes"] = 2048
        with self.assertRaisesRegex(ToolError, "请求体超过"):
            await http_request(ctx, {"url": "https://public.example/", "body": "x" * 11})
        output = (await http_request(ctx, {"url": "https://public.example/"})).result
        self.assertLessEqual(len(json.dumps(output, ensure_ascii=False).encode()), 2048)
        self.assertFalse(output["body_complete"])
        self.assertNotIn("max_bytes", TOOLS["http_request"].parameters["properties"])
        self.assertNotIn("max_response_bytes", TOOLS["http_request"].params)
        binary = (await http_request(context(HttpFixture(b"\0" * 5000, "application/octet-stream")), {"url": "https://public.example/", "response_format": "binary"})).result
        self.assertEqual(binary["sample_bytes"], 512)

    async def test_larger_default_payloads_and_text_continuation(self):
        data = ("中文正文" * 40000).encode()
        ctx = context(HttpFixture(data, "text/plain; charset=utf-8"))
        output = (await http_request(ctx, {"url": "https://public.example/api"})).result
        self.assertTrue(output["body_complete"])
        self.assertEqual(output["text"].encode(), data)
        await http_request(ctx, {"url": "https://public.example/api", "method": "POST", "body": "x" * 300000})
        self.assertEqual(len(ctx.offline.http.requests[-1][1]["request_body"]), 300000)
        pieces = []
        offset = 0
        ctx.limits["tool_result_bytes"] = 120000
        while True:
            output = (await http_request(ctx, {"url": "https://public.example/api", "response_format": "text", "offset": offset, "max_bytes": 120000})).result
            pieces.append(output["text"].encode())
            if output["next_offset"] is None:
                break
            self.assertGreater(output["next_offset"], offset)
            offset = output["next_offset"]
        self.assertEqual(b"".join(pieces), data)

    async def test_full_access_auto_sends_standard_requests_in_both_chat_modes(self):
        for base in ("", ".tgdrive/private/"):
            ctx = context(base=base, auto_approve=lambda: True, tainted=lambda: "读取过文件与网页")
            output = await http_request(ctx, {"url": "https://other.example/api", "method": "POST",
                "query": {"page": 2}, "json": {"title": "用户请求的数据"}, "auth": {"type": "bearer", "token": "third-party"}})
            ctx.client.assert_not_awaited()
            self.assertTrue(output.result["auto"])
            request, options = ctx.offline.http.requests[-1]
            self.assertEqual(request.method, "POST")
            self.assertIn("page=2", request.url)
            self.assertFalse(options["redirects"], "自动执行也不能重放带认证或正文的请求")
            await http_request(ctx, {"url": "https://other.example/api", "method": "DELETE"})
            ctx.client.assert_awaited_once()

    async def test_text_continuation_preserves_multibyte_characters(self):
        original = "中文🙂继续" * 300
        for charset in ("utf-8", "utf-16", "utf-32"):
            ctx = context(HttpFixture(original.encode(charset), "text/plain; charset=" + charset))
            ctx.limits["tool_result_bytes"] = 2048
            offset, text = 0, ""
            for _ in range(40):
                output = (await http_request(ctx, {"url": "https://public.example/", "response_format": "text", "max_bytes": 7, "offset": offset})).result
                text += output["text"]
                self.assertLessEqual(len(json.dumps(output, ensure_ascii=False).encode()), 2048)
                if output["next_offset"] is None:
                    break
                self.assertGreater(output["next_offset"], offset)
                offset = output["next_offset"]
            self.assertEqual(text, original, charset)

    async def test_response_budget_keeps_escaped_text_and_ignores_old_read_limits(self):
        original = "\x00\n\\\"" * 2000
        ctx = context(HttpFixture(original.encode(), "text/plain"))
        ctx.params["max_response_bytes"] = 10
        ctx.limits["tool_result_bytes"] = 2048
        offset, pieces = 0, []
        while True:
            payload = (await http_request(ctx, {"url": "https://public.example/", "offset": offset, "max_bytes": 1})).result
            self.assertLessEqual(len(json.dumps(payload, ensure_ascii=False).encode()), 2048)
            pieces.append(payload["text"])
            if payload["next_offset"] is None:
                break
            self.assertGreater(payload["next_offset"], offset)
            offset = payload["next_offset"]
        self.assertEqual("".join(pieces), original)

    async def test_full_access_revocation_blocks_automatic_send(self):
        ctx = context(auto_approve=Mock(side_effect=[True, False]))
        with self.assertRaisesRegex(ToolError, "完全访问权限已关闭"):
            await http_request(ctx, {"url": "https://public.example/", "method": "POST", "json": {"ok": True}})
        self.assertEqual(ctx.offline.http.requests, [])
        ctx.client.assert_not_awaited()

    async def test_cancelled_http_queue_releases_slots(self):
        guard = HttpGuard()
        async def queued():
            async with guard.slot(1):
                self.fail("已取消的等待不应进入网络阶段")
        async with guard.slot(1), guard.slot(1):
            task = asyncio.create_task(queued())
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(guard.active, {})
        self.assertEqual(guard.waiting, {})
        self.assertEqual(guard.slots, {})

    async def test_minute_quota_shared_between_conversations_and_redirects_count(self):
        guard = HttpGuard()
        first, second = context(), context()
        first.http_guard = second.http_guard = guard
        first.params["requests_per_minute"] = second.params["requests_per_minute"] = 1
        await http_request(first, {"url": "https://public.example/"})
        with self.assertRaisesRegex(ToolError, "过于频繁"):
            await http_request(second, {"url": "https://public.example/"})
        ctx = context(HttpFixture(hops=["https://public.example/next"]))
        ctx.params["requests_per_run"] = 1
        with self.assertRaisesRegex(ToolError, "本轮 HTTP"):
            await http_request(ctx, {"url": "https://public.example/"})

    async def test_waiting_for_approval_cannot_bank_minute_quota(self):
        guard = HttpGuard()
        first, second = context(), context()
        first.http_guard = second.http_guard = guard
        first.params["requests_per_minute"] = second.params["requests_per_minute"] = 1
        with patch("tgdrive.assistant.http_tools.time.monotonic", return_value=100) as clock:
            async def approve(name, review):
                clock.return_value = 161
                return {"approved": True}
            first.client.side_effect = approve
            await http_request(first, {"url": "https://public.example/", "method": "POST"})
            with self.assertRaisesRegex(ToolError, "过于频繁"):
                await http_request(second, {"url": "https://public.example/"})
        self.assertEqual(second.offline.http.requests, [])

    async def test_private_context_supports_methods_query_auth_and_bodies(self):
        allowed = "https://public.example/"
        for args in ({"method": "POST"}, {"query": {"x": 1}}, {"headers": {"Authorization": "Bearer third-party"}}, {"body": "x"}):
            ctx = context(base=".tgdrive/private/", url_allowed=lambda url, level: True)
            await http_request(ctx, {"url": allowed, **args})
            self.assertEqual(len(ctx.offline.http.requests), 1)
        ctx = context(base=".tgdrive/private/", url_allowed=lambda url, level: url == allowed)
        with self.assertRaisesRegex(ToolError, "地址"):
            await http_request(ctx, {"url": allowed + "other"})
        ctx = context(base=".tgdrive/private/", url_allowed=lambda url, level: url == "https://public.example")
        await http_request(ctx, {"url": "https://public.example"})
        self.assertEqual(ctx.offline.http.requests[0][0].url, "https://public.example/")

    async def test_concurrent_requests_queue_instead_of_failing(self):
        guard = HttpGuard()
        acquired = asyncio.Event()
        async def third():
            async with guard.slot(1):
                acquired.set()
        async with guard.slot(1), guard.slot(1):
            waiting = asyncio.create_task(third())
            await asyncio.sleep(0)
            self.assertFalse(acquired.is_set())
            self.assertEqual(guard.active[1], 2)
        await asyncio.wait_for(waiting, 1)
        self.assertTrue(acquired.is_set())
        self.assertEqual(guard.active, {})
        self.assertEqual(guard.slots, {})

    def test_public_address_boundaries_remain(self):
        for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1"):
            self.assertFalse(public_ip(address))


class Writer:
    def __init__(self):
        self.data = bytearray()
    def write(self, data):
        self.data.extend(data)
    async def drain(self):
        pass
    def close(self):
        pass
    async def wait_closed(self):
        pass


class HttpWireTests(unittest.IsolatedAsyncioTestCase):
    async def test_confirmation_card_survives_as_safe_tool_event(self):
        for answer, decision in (({"approved": True}, "approved"), ({"approved": False}, "rejected"),
                                 ({"error": "timeout", "decision": "expired"}, "expired"),
                                 ({"approved": False, "decision": "cancelled"}, "cancelled")):
            with self.subTest(decision=decision):
                service = Mock()
                spec = SimpleNamespace(handler=http_request, level="meta", timeout=180)
                service._user_tools.return_value = {"http_request": spec}
                service._tool_settings.return_value = {}
                service._conversation_taint.return_value = None
                service.trace.conversation.return_value = {"scope_root": "", "access_mode": "approval"}
                service.objects.metadata.db.execute.return_value.fetchone.return_value = None
                service.guard.redact.side_effect = lambda value: value
                service.guard.redact_value.side_effect = lambda value: value
                service._fit.side_effect = lambda value, limit: (value, False)
                async def decide(state, call_id, name, arguments, *, review):
                    review.update(id="http_nonce", requested_at=1)
                    return answer
                service._client_call = AsyncMock(side_effect=decide)
                service.offline, service.http_guard = SimpleNamespace(http=HttpFixture()), HttpGuard()
                state = SimpleNamespace(id="run", user_id=1, bucket_id=1, conversation_id="chat", private=False,
                                        view="files", location="", environment={}, model_id=1, tainted=None, emit=AsyncMock())
                call = SimpleNamespace(id="tool", name="http_request", arguments=json.dumps({
                    "url": "https://public.example/api", "method": "POST", "headers": {"Authorization": "Bearer third-party-token"}}))
                with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
                    body = await AssistantService._execute(service, state, call, {}, {"tool_seconds": 60, "tool_result_bytes": 65536}, {})
                self.assertEqual(body["event"]["type"], "http_request")
                self.assertEqual(body["event"]["decision"], decision)
                self.assertEqual(body["event"]["id"], "http_nonce")
                self.assertEqual(body["event"]["request"]["headers"]["Authorization"], HIDDEN)
                self.assertNotIn("third-party-token", json.dumps(body["event"]))
                self.assertEqual(body["status"], "ok" if decision == "approved" else "error")
                self.assertEqual(len(service.offline.http.requests), int(decision == "approved"))

    async def test_approval_nonce_does_not_reuse_model_call_id(self):
        import asyncio
        events, ready = [], asyncio.Event()
        async def emit(event):
            events.append(event)
            if len(events) == 2:
                ready.set()
        state = SimpleNamespace(listeners=1, client_waiters={}, emit=emit)
        reviews = [{}, {}]
        tasks = [asyncio.create_task(AssistantService._client_call(None, state, "duplicate-model-id", "http_request_approval", {"url": url}, review=review))
                 for url, review in zip(("https://public.example/first", "https://public.example/second"), reviews)]
        await ready.wait()
        self.assertNotEqual(events[0]["call_id"], events[1]["call_id"])
        self.assertEqual([event["tool_call_id"] for event in events], ["duplicate-model-id"] * 2)
        self.assertEqual([review["id"] for review in reviews], [event["call_id"] for event in events])
        self.assertEqual([review["requested_at"] for review in reviews], [event["requested_at"] for event in events])
        self.assertEqual(len(state.client_waiters), 2)
        state.client_waiters[events[0]["call_id"]].set_result({"approved": False})
        state.client_waiters[events[1]["call_id"]].set_result({"approved": True})
        self.assertEqual(await asyncio.gather(*tasks), [{"approved": False}, {"approved": True}])
        self.assertEqual(state.client_waiters, {})

    async def test_cancelled_approval_does_not_send_request(self):
        import asyncio
        ctx = context()
        ctx.client.side_effect = asyncio.CancelledError
        with self.assertRaises(asyncio.CancelledError):
            await http_request(ctx, {"url": "https://public.example/", "method": "POST"})
        self.assertEqual(ctx.offline.http.requests, [])

    async def test_explicit_bytes_for_patch_and_legacy_get_body_unchanged(self):
        import asyncio
        for method, explicit in (("PATCH", True), ("GET", False)):
            reader, writer = asyncio.StreamReader(), Writer()
            reader.feed_data(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
            reader.feed_eof()
            client = SafeHttpClient()
            client._establish = AsyncMock(return_value=(reader, writer))
            request = DownloadRequest("https://public.example/api", method=method, body="legacy")
            async with client.open(request, **({"request_body": b"\0\xff"} if explicit else {})) as response:
                self.assertEqual(response.status, 200)
            self.assertTrue(writer.data.startswith(method.encode() + b" /api HTTP/1.1\r\n"))
            if explicit:
                self.assertIn(b"Content-Length: 2\r\n", writer.data)
                self.assertTrue(writer.data.endswith(b"\r\n\r\n\0\xff"))
            else:
                self.assertNotIn(b"legacy", writer.data)
                self.assertNotIn(b"Content-Length", writer.data)

    async def test_redirect_history_and_cross_origin_header_stripping(self):
        client = SafeHttpClient()
        def response(url, status=200, headers=None):
            return HttpResponse(None, Writer(), status, headers or {}, url, "GET")
        client._connect = AsyncMock(side_effect=[response("https://public.example/", 302, {"location": "https://cdn.example/file"}), response("https://cdn.example/file")])
        request = DownloadRequest("https://public.example/", headers=[("Authorization", "Bearer secret"), ("X-Token", "secret")])
        async with client.open(request) as result:
            self.assertEqual(result.history, [{"url": "https://public.example/", "status": 302}])
        self.assertEqual(client._connect.call_args_list[1].args[4], [])

    async def test_explicit_body_is_never_replayed_on_redirect(self):
        client = SafeHttpClient()
        client._connect = AsyncMock(return_value=HttpResponse(None, Writer(), 307, {"location": "/other"}, "https://public.example/", "PUT"))
        with self.assertRaises(DownloadError):
            async with client.open(DownloadRequest("https://public.example/", method="PUT"), request_body=b"data"):
                self.fail("不应重放")
        self.assertEqual(client._connect.await_count, 1)
