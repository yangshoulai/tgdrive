"""文件助手私密对话（docs/assistant-design.md §24）：授权绑定、内存留痕、工具规则、地址规则与跨区移动。"""
import json
from unittest.mock import AsyncMock

from tests.test_assistant import AssistantCase, answer, call
from tests.test_assistant_loop import folder_calls
from tests.test_assistant_actions import ActionHelpers
from tests.test_assistant_http import HttpFixture
from tgdrive.assistant.providers import Reply

PRIVATE = "/api/user/v1/private/assistant"
TABLES = ("assistant_conversations", "assistant_messages", "assistant_runs", "assistant_actions", "assistant_collections")


class PrivateAssistantTests(ActionHelpers, AssistantCase):

    async def enable_private(self, admin, model):
        status, data = await self.req("POST", "/api/admin/v1/assistant/settings", {"private": True}, admin)
        self.assertEqual(status, 200, data)
        status, data = await self.req("POST", f"/api/admin/v1/assistant/models/{model['id']}/update", {"private_ok": True}, admin)
        self.assertEqual(status, 200, data)
        self.assertTrue(data["private_ok"])

    async def unlock(self, user):
        status, data = await self.req("POST", "/api/user/v1/private/unlock", {"password": "alice password"}, user)
        self.assertEqual(status, 200, data)
        return {**user, "x-private-access": data["access"]}

    async def private_conversation(self, user, *, ack=True):
        status, _ = await self.req("POST", "/api/user/v1/assistant/notice/ack", {}, user)
        self.assertEqual(status, 204)
        if ack:
            status, _ = await self.req("POST", f"{PRIVATE}/notice/ack", {}, user)
            self.assertEqual(status, 204)
        status, data = await self.req("POST", f"{PRIVATE}/conversations", {}, user)
        self.assertEqual(status, 201, data)
        return data["conversation"]["id"]

    async def private_send(self, user, conversation, text):
        status, data = await self.req("POST", f"{PRIVATE}/conversations/{conversation}/messages", {"text": text}, user)
        if status == 201:
            task = self.service.runs[data["run_id"]].task
            await task
        return status, data

    async def private_tools(self, user, conversation):
        _, data = await self.req("GET", f"{PRIVATE}/conversations/{conversation}", headers=user)
        return [m for m in data["messages"] if m["role"] == "tool"]

    def counts(self):
        return {table: self.app.metadata.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in TABLES}

    def test_private_large_tool_batch_finishes_in_memory(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            await self.req("POST", "/api/admin/v1/assistant/limits",
                           {"parallel_calls": 8, "repeat_threshold": 10, "error_threshold": 5}, admin)
            user = await self.unlock(await self.client.login("user", "alice@example.com", "alice password"))
            conversation = await self.private_conversation(user)
            before = self.counts()
            calls = folder_calls(23)
            self.model.replies = [Reply(tool_calls=calls), answer("全部处理完成。")]
            _, result = await self.private_send(user, conversation, "处理私密空间中的相册")
            self.assertEqual(self.service.runs[result["run_id"]].stop_reason, "completed")
            tools = await self.private_tools(user, conversation)
            self.assertEqual([m["status"] for m in tools], ["ok"] * 23)
            self.assertEqual([m["call_id"] for m in tools], [c.id for c in calls])
            self.assertEqual(self.counts(), before, "分批调度仍须遵守私密对话只存在内存中的约定")
            self.assertIn("最多同时执行 8 个", self.model.calls[0]["messages"][-1]["content"])
        self.run_async(run())

    def test_private_requires_admin_opt_in_model_and_notice(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            user = await self.unlock(await self.client.login("user", "alice@example.com", "alice password"))
            _, config = await self.req("GET", f"{PRIVATE}/config", headers=user)
            self.assertFalse(config["available"])
            self.assertEqual(config["reason"], "管理员未开放私密对话")
            await self.req("POST", "/api/admin/v1/assistant/settings", {"private": True}, admin)
            _, config = await self.req("GET", f"{PRIVATE}/config", headers=user)
            self.assertIn("没有允许任何模型", config["reason"])
            await self.req("POST", f"/api/admin/v1/assistant/models/{model['id']}/update", {"private_ok": True}, admin)
            _, config = await self.req("GET", f"{PRIVATE}/config", headers=user)
            self.assertTrue(config["available"])
            self.assertTrue(config["private"])
            self.assertIn("私密对话不保存", config["notice"])
            names = {tool["name"] for tool in config["tools"]}
            self.assertNotIn("request_scope", names)
            self.assertNotIn("list_public_links", names)
            self.assertIn("propose_move_out", names)
            share = next(tool for tool in config["tools"] if tool["name"] == "propose_share")
            self.assertFalse(share["available"])
            # 普通对话不出现只用于私密对话的工具。
            _, normal = await self.req("GET", "/api/user/v1/assistant/config", headers=user)
            self.assertNotIn("propose_move_out", {tool["name"] for tool in normal["tools"]})
            # 没有确认私密说明不能发送。
            conversation = await self.private_conversation(user, ack=False)
            status, data = await self.private_send(user, conversation, "你好")
            self.assertEqual(status, 400)
            self.assertIn("私密对话的使用说明", data["error"]["message"])
            # 用户策略可以单独禁止。
            await self.req("POST", f"/api/admin/v1/assistant/users/{self.alice.id}/policy", {"private": False}, admin)
            _, config = await self.req("GET", f"{PRIVATE}/config", headers=user)
            self.assertFalse(config["available"])
            self.assertNotIn(conversation, self.service.private_chats, "关闭后清除私密对话")
        self.run_async(run())

    def test_private_conversation_reads_private_files_only_in_memory(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            await self.put(".tgdrive/private/合同/租房.txt", "租金 3000 元".encode())
            await self.put("公开/readme.txt", b"normal")
            before = self.counts()
            user = await self.unlock(await self.client.login("user", "alice@example.com", "alice password"))
            conversation = await self.private_conversation(user)
            self.assertTrue(conversation.startswith("pc_"))
            self.model.replies = [call("search_files", query="租房"), call("read_text_file", path="/合同/租房.txt"),
                                  call("list_folder", path="/../公开/"), answer("租金是 3000 元")]
            status, data = await self.private_send(user, conversation, "租金是多少")
            self.assertEqual(status, 201, data)
            tools = await self.private_tools(user, conversation)
            self.assertEqual(tools[0]["result"]["files"][0]["path"], "/合同/租房.txt")
            self.assertIn("3000", tools[1]["result"]["content"])
            self.assertEqual(tools[2]["status"], "error", "不能越出私密空间")
            self.assertNotIn(".tgdrive", json.dumps(tools, ensure_ascii=False))
            # 发给模型的工具定义里没有分享、作用域请求等工具；系统提示词是私密版本。
            sent = self.model.calls[0]
            self.assertNotIn("propose_share", sent["tools"])
            self.assertNotIn("request_scope", sent["tools"])
            self.assertIn("私密空间中工作", sent["system"])
            self.assertIn("私密空间授权剩余", sent["messages"][-1]["content"])
            # 不写任何留痕表；调用日志不关联对话、不记工具执行。
            self.assertEqual(self.counts(), before)
            calls = self.app.metadata.db.execute("SELECT kind, conversation_id, run_id, private FROM assistant_calls WHERE private=1").fetchall()
            self.assertTrue(calls)
            self.assertEqual({row["kind"] for row in calls}, {"model"})
            self.assertTrue(all(row["conversation_id"] is None and row["run_id"] is None for row in calls))
            # 普通接口不能访问私密对话，私密接口不带授权也不能。
            plain = {key: value for key, value in user.items() if key != "x-private-access"}
            status, _ = await self.req("GET", f"/api/user/v1/assistant/conversations/{conversation}", headers=plain)
            self.assertEqual(status, 404)
            status, _ = await self.req("GET", f"{PRIVATE}/conversations/{conversation}", headers=plain)
            self.assertNotEqual(status, 200)
            _, listed = await self.req("GET", "/api/user/v1/assistant/conversations", headers=plain)
            self.assertEqual(listed["conversations"], [])
            # 管理端看不到私密对话。
            _, records = await self.req("GET", "/api/admin/v1/assistant/conversations", headers=admin)
            self.assertNotIn("pc_", json.dumps(records))
        self.run_async(run())

    def test_mentions_are_relative_to_private_root(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            await self.put(".tgdrive/private/相册/猫.jpg", b"\xff\xd8\xff\xe0 image")
            await self.put("相册/狗.jpg", b"\xff\xd8\xff\xe0 image")
            user = await self.unlock(await self.client.login("user", "alice@example.com", "alice password"))
            conversation = await self.private_conversation(user)
            self.model.replies = [answer("好的")]
            status, data = await self.req("POST", f"{PRIVATE}/conversations/{conversation}/messages",
                                          {"text": "看看 @/相册/猫.jpg", "mentions": ["/相册/猫.jpg"]}, user)
            self.assertEqual(status, 201, data)
            await self.service.runs[data["run_id"]].task
            _, detail = await self.req("GET", f"{PRIVATE}/conversations/{conversation}", headers=user)
            sent = next(m for m in detail["messages"] if m["role"] == "user")
            self.assertEqual(sent["mentions"], ["/相册/猫.jpg"], "显示路径相对私密空间根")
            # 识图读取的是私密空间里的对象。
            history = self.service._history(conversation, None, run_id=data["run_id"], can_see=True)
            refs = next(item["image_refs"] for item in history if item.get("image_refs"))
            self.assertEqual(refs, [".tgdrive/private/相册/猫.jpg"])
            # 普通文件不能被私密对话引用。
            status, data = await self.req("POST", f"{PRIVATE}/conversations/{conversation}/messages",
                                          {"text": "@/相册/狗.jpg", "mentions": ["/相册/狗.jpg"]}, user)
            self.assertEqual(status, 400)
            self.assertIn("不存在", data["error"]["message"])
        self.run_async(run())

    def test_lock_clears_conversation_and_stops_requests(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            user = await self.unlock(await self.client.login("user", "alice@example.com", "alice password"))
            conversation = await self.private_conversation(user)
            self.model.replies = [answer("好")]
            await self.private_send(user, conversation, "你好")
            status, _ = await self.req("POST", "/api/user/v1/private/lock", {}, user)
            self.assertEqual(status, 204)
            self.assertNotIn(conversation, self.service.private_chats)
            self.assertNotIn(conversation, self.service.memory.conversations)
            calls = len(self.model.calls)
            status, _ = await self.private_send(user, conversation, "还在吗")
            self.assertNotEqual(status, 201)
            self.assertEqual(len(self.model.calls), calls, "锁定后不再请求模型")
            # 重新解锁得到新的空对话。
            user = await self.unlock(user)
            _, listed = await self.req("GET", f"{PRIVATE}/conversations", headers=user)
            self.assertEqual(listed["conversations"], [])
        self.run_async(run())

    def test_normal_conversation_cannot_see_private(self):
        async def run():
            await self.setup_assistant()
            await self.put(".tgdrive/private/secret.txt", b"secret")
            user = await self.client.login("user", "alice@example.com", "alice password")
            conversation = await self.start_conversation(user)
            self.model.replies = [call("read_text_file", path="/.tgdrive/private/secret.txt"), call("search_files", query="secret"), answer("无")]
            await self.send(user, conversation, "读一下")
            tools = await self.tool_results(user, conversation)
            self.assertEqual(tools[0]["status"], "error")
            self.assertEqual(tools[1]["result"]["files"], [])
            self.assertNotIn("propose_move_out", self.model.calls[0]["tools"])
        self.run_async(run())

    def test_private_requests_can_follow_cross_site_task_links(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            user = await self.unlock(await self.client.login("user", "alice@example.com", "alice password"))
            conversation = await self.private_conversation(user)
            http = HttpFixture()
            self.app.offline.http.open = http.open
            self.model.replies = [call("http_request", url="https://cdn.example/assets?page=2"),
                                  call("browser_open_url", url="https://cdn.example/assets?page=2"),
                                  call("browser_open_url", url="https://docs.example.com/guide#part"), answer("好")]
            await self.private_send(user, conversation, "打开 https://docs.example.com/guide 看看")
            tools = await self.private_tools(user, conversation)
            self.assertEqual(tools[0]["status"], "ok", tools[0]["result"])
            self.assertEqual(http.requests[0][0].url, "https://cdn.example/assets?page=2")
            self.assertEqual(tools[1]["status"], "ok")
            self.assertEqual(tools[2]["status"], "ok", tools[2]["result"])
        self.run_async(run())

    def test_private_url_validation_does_not_require_user_or_same_site_whitelist(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            user = await self.unlock(await self.client.login("user", "alice@example.com", "alice password"))
            conversation = await self.private_conversation(user)
            self.model.replies = [answer("好")]
            await self.private_send(user, conversation, "爬取 https://www.photos.example.com/albums 里的所有相册")
            memory = self.service.memory
            # 相册列表页的分析结果：同站的相册地址可以继续访问，其他网站的不行。
            memory.append(conversation, None, "tool", {"status": "ok", "model_content": json.dumps({"samples": [
                "https://photos.example.com/album/1", "https://www.photos.example.com/album/2?page=3", "https://evil.example/album/3"]})},
                tool_name="analyze_page")
            # 私密文件里出现的同站地址、失败结果里回显的地址都不算。
            memory.append(conversation, None, "tool", {"status": "ok", "model_content": "见 https://photos.example.com/album/9"}, tool_name="read_text_file")
            memory.append(conversation, None, "tool", {"status": "error", "model_content": "https://photos.example.com/album/8"}, tool_name="http_request")
            allowed = self.service._url_allowed(conversation)
            self.assertTrue(allowed("https://www.photos.example.com/albums", "page"))
            self.assertTrue(allowed("https://photos.example.com/album/1", "page"))
            self.assertTrue(allowed("https://www.photos.example.com/album/2?page=3#top", "page"))
            self.assertTrue(allowed("https://photos.example.com/album/2?page=3&sort=time", "page"))
            self.assertTrue(allowed("https://cdn.example/album/3", "page"))
            self.assertTrue(allowed("https://photos.example.com/album/9", "page"))
            self.assertTrue(allowed("https://photos.example.com/album/8", "page"))
            self.assertTrue(allowed("https://photos.example.com/album/1", "user"))
            for invalid in ("file:///etc/passwd", "javascript:alert(1)", "https://user:password@example.com/"):
                self.assertFalse(allowed(invalid, "page"))
            http = HttpFixture()
            self.app.offline.http.open = http.open
            self.model.replies = [call("http_request", url="https://cdn.example/album/3"), answer("好")]
            await self.private_send(user, conversation, "继续")
            self.assertEqual((await self.private_tools(user, conversation))[-1]["status"], "ok")
        self.run_async(run())

    def test_private_full_mode_keeps_auto_execution_after_content_and_http(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            await self.req("POST", "/api/admin/v1/assistant/settings", {"full_access": True}, admin)
            await self.put(".tgdrive/private/a.txt", b"task content")
            user = await self.unlock(await self.client.login("user", "alice@example.com", "alice password"))
            conversation = await self.private_conversation(user)
            await self.req("POST", f"{PRIVATE}/conversations/{conversation}/update", {"access_mode": "full"}, user)
            self.service._client_call = AsyncMock(return_value={"approved": True})
            http = HttpFixture()
            self.app.offline.http.open = http.open
            self.model.replies = [call("read_text_file", path="/a.txt"),
                call("http_request", url="https://other.example/api", method="POST", json={"page": 2}, auth={"type": "bearer", "token": "third-party"}),
                call("propose_rename", mapping=[{"from": "/a.txt", "to": "b.txt"}]),
                call("propose_downloads", urls=["https://cdn.example/file.txt"], target="/"), answer("完成")]
            await self.private_send(user, conversation, "读文件、查询接口，改名并保存资源")
            tools = await self.private_tools(user, conversation)
            self.assertTrue(all(tool["status"] == "ok" for tool in tools), tools)
            self.assertTrue(tools[1]["result"]["auto"])
            self.assertIn("自动执行", tools[2]["result"]["status"])
            self.assertIn("自动执行", tools[3]["result"]["status"])
            self.assertIn(".tgdrive/private/b.txt", self.keys())
            self.service._client_call.assert_not_awaited()
            self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM assistant_actions").fetchone()[0], 0)
        self.run_async(run())

    def test_private_actions_stay_inside_and_move_out_requires_verification(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            await self.put(".tgdrive/private/a.txt", b"a")
            await self.put(".tgdrive/private/b.txt", b"b")
            user = await self.unlock(await self.client.login("user", "alice@example.com", "alice password"))
            conversation = await self.private_conversation(user)
            # 私密空间内移动：操作只在内存，确认后执行，可撤销。
            self.model.replies = [call("propose_move", sources=["/a.txt"], target="/归档/"), answer("请确认")]
            await self.private_send(user, conversation, "把 a 移到归档")
            tool = (await self.private_tools(user, conversation))[-1]
            self.assertEqual(tool["status"], "ok", tool["result"])
            action_id = tool["result"]["action_id"]
            self.assertTrue(action_id.startswith("pa_"))
            self.assertEqual(tool["result"]["samples"], ["/a.txt → /归档/a.txt"])
            status, _ = await self.req("POST", f"/api/user/v1/assistant/actions/{action_id}/confirm", {}, user)
            self.assertEqual(status, 404, "普通接口不能确认私密操作")
            status, done = await self.req("POST", f"{PRIVATE}/actions/{action_id}/confirm", {}, user)
            self.assertEqual(status, 200, done)
            await self.service._execution_tasks.get(action_id, None) or done
            self.assertIn(".tgdrive/private/归档/a.txt", self.keys())
            self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM assistant_actions").fetchone()[0], 0)
            # 读取内容后仍可按用户要求提议移出，但不会自动执行。
            self.model.replies = [call("read_text_file", path="/b.txt"), call("propose_move_out", paths=["/b.txt"], target="/"), answer("不行")]
            await self.private_send(user, conversation, "读 b 然后移出")
            tool = (await self.private_tools(user, conversation))[-1]
            self.assertEqual(tool["status"], "ok", tool["result"])
            self.assertEqual(self.service.trace.action(self.alice.id, tool["result"]["action_id"])["status"], "pending")
            # 新一轮（新对话）里由用户直接提出：确认时必须重新验证身份。
            conversation = await self.private_conversation(user)
            self.model.replies = [call("propose_move_out", paths=["/b.txt"], target="/导出/"), answer("请确认")]
            await self.private_send(user, conversation, "把 b 移出私密空间到导出")
            action_id = (await self.private_tools(user, conversation))[-1]["result"]["action_id"]
            status, data = await self.req("POST", f"{PRIVATE}/actions/{action_id}/confirm", {}, user)
            self.assertEqual(status, 400)
            self.assertIn("重新验证", data["error"]["message"])
            status, _ = await self.req("POST", f"{PRIVATE}/actions/{action_id}/confirm", {"password": "wrong"}, user)
            self.assertNotEqual(status, 200)
            status, done = await self.req("POST", f"{PRIVATE}/actions/{action_id}/confirm", {"password": "alice password"}, user)
            self.assertEqual(status, 200, done)
            task = self.service._execution_tasks.get(action_id)
            if task:
                await task
            self.assertIn("导出/b.txt", self.keys())
            audit = {row["action"] for row in self.app.metadata.db.execute("SELECT action FROM audit_log")}
            self.assertIn("private.assistant.move_out", audit)
        self.run_async(run())

    def test_normal_conversation_moves_into_private_with_target_chosen_on_card(self):
        async def run():
            await self.setup_assistant()
            await self.put("Downloads/身份证.jpg", b"id")
            user = await self.client.login("user", "alice@example.com", "alice password")
            conversation = await self.start_conversation(user, "Downloads/")
            action_id, tool = await self.propose(user, conversation, call("propose_move_to_private", paths=["/Downloads/身份证.jpg"]))
            status, data = await self.confirm(user, action_id, {"target": "/证件/"})
            self.assertEqual(status, 400)
            self.assertIn("请先解锁私密空间", data["error"]["message"])
            await self.unlock(user)
            status, done = await self.confirm(user, action_id, {"target": "/证件/"})
            self.assertEqual(status, 200, done)
            self.assertIn(".tgdrive/private/证件/身份证.jpg", self.keys())
            self.assertNotIn("证件", json.dumps(await self.messages(user, conversation), ensure_ascii=False), "目标目录不回传给对话")
        self.run_async(run())

    def test_admin_can_disable_tool_only_in_private_conversations(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            status, tools = await self.req("POST", "/api/admin/v1/assistant/tools", {"read_text_file": {"private_enabled": False}}, admin)
            self.assertEqual(status, 200, tools)
            item = next(tool for tool in tools if tool["name"] == "read_text_file")
            self.assertEqual((item["enabled"], item["private_enabled"], item["private"]), (True, False, "allow"))
            status, _ = await self.req("POST", "/api/admin/v1/assistant/tools", {"propose_share": {"private_enabled": True}}, admin)
            self.assertEqual(status, 400, "不提供的工具不能在私密对话中启用")
            user = await self.unlock(await self.client.login("user", "alice@example.com", "alice password"))
            conversation = await self.private_conversation(user)
            self.model.replies = [answer("好")]
            await self.private_send(user, conversation, "你好")
            self.assertNotIn("read_text_file", self.model.calls[-1]["tools"])
            normal = await self.start_conversation(user)
            self.model.replies = [answer("好")]
            before = len(self.model.calls)
            await self.send({k: v for k, v in user.items() if k != "x-private-access"}, normal, "你好")
            # 普通对话之后还有一次生成标题的调用（没有工具），取第一次调用。
            self.assertIn("read_text_file", self.model.calls[before]["tools"])
        self.run_async(run())
