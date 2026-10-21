"""文件助手统一对话中的私密空间（docs/assistant-design.md §37）：识别与标记、解锁、锁定、续期、工具规则与跨区移动。"""
import asyncio
import json

from tests.test_assistant import AssistantCase, answer, call
from tests.test_assistant_actions import ActionHelpers
from tests.test_assistant_http import HttpFixture

BASE = "/api/user/v1/assistant"


class PrivateAssistantTests(ActionHelpers, AssistantCase):

    async def enable_private(self, admin, model):
        status, data = await self.req("POST", "/api/admin/v1/assistant/settings", {"private": True}, admin)
        self.assertEqual(status, 200, data)
        status, data = await self.req("POST", f"/api/admin/v1/assistant/models/{model['id']}/update", {"private_ok": True}, admin)
        self.assertEqual(status, 200, data)
        self.assertTrue(data["private_ok"])

    async def login(self):
        return await self.client.login("user", "alice@example.com", "alice password")

    async def unlock(self, user):
        status, data = await self.req("POST", "/api/user/v1/private/unlock", {"password": "alice password"}, user)
        self.assertEqual(status, 200, data)
        return {**user, "x-private-access": data["access"]}

    async def lock(self, user):
        status, _ = await self.req("POST", "/api/user/v1/private/lock", {}, user)
        self.assertEqual(status, 204)

    async def ack_private(self, user):
        status, _ = await self.req("POST", f"{BASE}/notice/ack", {}, user)
        self.assertEqual(status, 204)
        status, _ = await self.req("POST", f"{BASE}/notice/ack", {"private": True}, user)
        self.assertEqual(status, 204)

    async def private_conversation(self, user):
        """在私密空间页面新建的对话：一开始就涉及私密。"""
        await self.ack_private(user)
        status, data = await self.req("POST", f"{BASE}/conversations", {"location": "私密:/"}, user)
        self.assertEqual(status, 201, data)
        self.assertTrue(data["conversation"]["private"])
        return data["conversation"]["id"]

    def last_run(self, conversation):
        return self.service.trace.latest_run(conversation)

    def test_tool_reaching_private_asks_to_unlock_then_marks_conversation(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            await self.put(".tgdrive/private/合同/租房.txt", "租金 3000 元".encode())
            user = await self.login()
            await self.ack_private(user)
            conversation = await self.start_conversation(user)
            # 未解锁：工具结束本轮并提示解锁，不读取、不标记。
            self.model.replies = [call("read_text_file", path="私密:/合同/租房.txt"), answer("不应到达")]
            status, data = await self.send(user, conversation, "看看私密空间里的租房合同")
            self.assertEqual(status, 201, data)
            self.assertEqual(self.last_run(conversation)["stop_reason"], "private_locked")
            events = [{k: v for k, v in event.items() if k != "seq"} for event in self.service.runs[data["run_id"]].events]
            self.assertIn({"type": "private_required", "reason": "locked"}, events)
            tools = await self.tool_results(user, conversation)
            self.assertEqual(tools[-1]["status"], "error")
            self.assertNotIn("3000", json.dumps(tools, ensure_ascii=False))
            self.assertFalse(self.service.trace.is_private(conversation))
            # 解锁后继续：读取成功、对话被标记，路径以「私密:/」显示。
            user = await self.unlock(user)
            self.model.replies = [call("search_files", path="私密:/", query="租房"), call("read_text_file", path="私密:/合同/租房.txt"),
                                  answer("租金是 3000 元")]
            status, data = await self.send(user, conversation, "继续")
            self.assertEqual(status, 201, data)
            self.assertEqual(self.last_run(conversation)["stop_reason"], "completed")
            self.assertTrue(self.service.trace.is_private(conversation))
            messages = await self.messages(user, conversation)
            self.assertTrue(any(m.get("type") == "private" for m in messages if m["role"] == "event"))
            tools = [m for m in messages if m["role"] == "tool"]
            self.assertIn("3000", tools[-1]["result"]["content"])
            self.assertNotIn(".tgdrive", json.dumps(tools, ensure_ascii=False))
            self.assertIn("私密:/合同/租房.txt", json.dumps(tools[-2]["result"], ensure_ascii=False))
            # 标记之后的调用日志不关联对话、不记工具执行。
            rows = self.app.metadata.db.execute("SELECT kind, conversation_id, run_id FROM assistant_calls WHERE private=1").fetchall()
            self.assertTrue(rows)
            self.assertNotIn("tool", {row["kind"] for row in rows})
            self.assertTrue(all(row["conversation_id"] is None and row["run_id"] is None for row in rows))
            # 锁定后：对话仍在历史中，但标题隐藏、详情需要解锁；管理端只看到私密标记。
            await self.lock(user)
            _, listed = await self.req("GET", f"{BASE}/conversations", headers=user)
            item = next(c for c in listed["conversations"] if c["id"] == conversation)
            self.assertEqual((item["title"], item["locked"], item["private"]), (None, True, True))
            status, data = await self.req("GET", f"{BASE}/conversations/{conversation}", headers=user)
            self.assertEqual(status, 423, data)
            status, _ = await self.req("POST", f"{BASE}/conversations/{conversation}/messages", {"text": "还在吗"}, user)
            self.assertEqual(status, 423)
            _, records = await self.req("GET", "/api/admin/v1/assistant/conversations", headers=admin)
            record = next(c for c in records["conversations"] if c["id"] == conversation)
            self.assertTrue(record["private"])
            _, detail = await self.req("GET", f"/api/admin/v1/assistant/conversations/{conversation}", headers=admin)
            self.assertNotIn("租房", json.dumps(detail, ensure_ascii=False))
            # 重新解锁即可查看。
            user = await self.unlock(user)
            status, data = await self.req("GET", f"{BASE}/conversations/{conversation}", headers=user)
            self.assertEqual(status, 200, data)
        self.run_async(run())

    def test_private_needs_admin_opt_in_notice_and_allowed_model(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.put(".tgdrive/private/a.txt", b"a")
            user = await self.unlock(await self.login())
            _, config = await self.req("GET", f"{BASE}/config", headers=user)
            self.assertFalse(config["private_available"])
            self.assertTrue(config["private_unlocked"])
            # 未开放：工具作用于私密路径时报错，不标记对话。
            conversation = await self.start_conversation(user)
            self.model.replies = [call("read_text_file", path="私密:/a.txt"), answer("好")]
            await self.send(user, conversation, "读私密文件")
            self.assertEqual((await self.tool_results(user, conversation))[-1]["status"], "error")
            self.assertFalse(self.service.trace.is_private(conversation))
            status, _ = await self.req("POST", f"{BASE}/conversations", {"location": "私密:/"}, user)
            self.assertEqual(status, 403)
            # 开放但模型不允许：给出换模型的提示。
            await self.req("POST", "/api/admin/v1/assistant/settings", {"private": True}, admin)
            await self.req("POST", f"{BASE}/notice/ack", {"private": True}, user)
            self.model.replies = [call("read_text_file", path="私密:/a.txt"), answer("好")]
            await self.send(user, conversation, "再读一次")
            tool = (await self.tool_results(user, conversation))[-1]
            self.assertEqual(tool["status"], "error")
            self.assertIn("模型", json.dumps(tool["result"], ensure_ascii=False))
            self.assertFalse(self.service.trace.is_private(conversation))
            # 模型允许后，未确认私密说明时提示确认（reason=notice）。
            await self.req("POST", f"/api/admin/v1/assistant/models/{model['id']}/update", {"private_ok": True}, admin)
            self.app.metadata.db.execute("UPDATE ai_user_policy SET private_notice_ack_at=NULL")
            self.model.replies = [call("read_text_file", path="私密:/a.txt"), answer("好")]
            status, data = await self.send(user, conversation, "再读一次")
            events = [{k: v for k, v in event.items() if k != "seq"} for event in self.service.runs[data["run_id"]].events]
            self.assertIn({"type": "private_required", "reason": "notice"}, events)
            _, config = await self.req("GET", f"{BASE}/config", headers=user)
            self.assertTrue(config["private_available"])
            self.assertFalse(config["private_notice_ack"])
            # 用户策略可以单独禁止。
            await self.req("POST", f"/api/admin/v1/assistant/users/{self.alice.id}/policy", {"private": False}, admin)
            _, config = await self.req("GET", f"{BASE}/config", headers=user)
            self.assertFalse(config["private_available"])
        self.run_async(run())

    def test_mentions_of_private_files_require_unlock_without_revealing_existence(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            await self.put(".tgdrive/private/相册/猫.jpg", b"\xff\xd8\xff\xe0 image")
            user = await self.login()
            await self.ack_private(user)
            conversation = await self.start_conversation(user)
            for path in ("私密:/相册/猫.jpg", "私密:/相册/不存在.jpg"):
                status, _ = await self.req("POST", f"{BASE}/conversations/{conversation}/messages",
                                           {"text": f"看看 @{path}", "mentions": [path]}, user)
                self.assertEqual(status, 423, "锁定时存在与否返回相同结果")
            self.assertFalse(self.service.trace.is_private(conversation))
            user = await self.unlock(user)
            self.model.replies = [answer("好的")]
            status, data = await self.send(user, conversation, "看看 @私密:/相册/猫.jpg", mentions=["私密:/相册/猫.jpg"])
            self.assertEqual(status, 201, data)
            self.assertTrue(self.service.trace.is_private(conversation))
            sent = next(m for m in await self.messages(user, conversation) if m["role"] == "user")
            self.assertEqual(sent["mentions"], ["私密:/相册/猫.jpg"])
            history = self.service._history(conversation, None, run_id=data["run_id"], can_see=True)
            refs = next(item["image_refs"] for item in history if item.get("image_refs"))
            self.assertEqual(refs, [".tgdrive/private/相册/猫.jpg"])
        self.run_async(run())

    def test_lock_stops_private_run_and_keeps_history(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            user = await self.unlock(await self.login())
            conversation = await self.private_conversation(user)
            gate, scripted = asyncio.Event(), self.service.chat

            async def slow(*args, **kwargs):
                await gate.wait()
                return await scripted(*args, **kwargs)
            self.service.chat = slow
            status, data = await self.req("POST", f"{BASE}/conversations/{conversation}/messages", {"text": "整理私密相册"}, user)
            self.assertEqual(status, 201, data)
            task = self.service.runs[data["run_id"]].task
            await asyncio.sleep(0.05)
            await self.lock(user)
            gate.set()
            await asyncio.gather(task, return_exceptions=True)
            self.assertEqual(self.last_run(conversation)["stop_reason"], "private_locked")
            self.assertEqual(self.model.calls, [], "锁定后不再请求模型")
            _, listed = await self.req("GET", f"{BASE}/conversations", headers=user)
            self.assertIn(conversation, [c["id"] for c in listed["conversations"]])
            # 删除不需要解锁。
            status, _ = await self.req("POST", f"{BASE}/conversations/{conversation}/delete", {}, user)
            self.assertEqual(status, 204)
        self.run_async(run())

    def test_lock_extension_only_for_private_runs(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            user = await self.unlock(await self.login())
            private = await self.private_conversation(user)
            normal = await self.start_conversation(user)
            gate, scripted = asyncio.Event(), self.service.chat

            async def slow(*args, **kwargs):
                await gate.wait()
                return await scripted(*args, **kwargs)
            self.service.chat = slow
            _, data = await self.req("POST", f"{BASE}/conversations/{normal}/messages", {"text": "你好"}, user)
            state = self.service.runs[data["run_id"]]
            access = self.service.private_space.session_grants[state.token]
            await asyncio.sleep(0.05)
            self.assertFalse(self.service.private_busy(state.token, access), "普通对话的运行不续期")
            gate.set()
            await state.task
            gate.clear()
            _, data = await self.req("POST", f"{BASE}/conversations/{private}/messages", {"text": "你好"}, user)
            state = self.service.runs[data["run_id"]]
            await asyncio.sleep(0.05)
            self.assertTrue(self.service.private_busy(state.token, access))
            gate.set()
            await state.task
            self.assertFalse(self.service.private_busy(state.token, access))
        self.run_async(run())

    def test_private_actions_and_move_out_requires_verification(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            await self.put(".tgdrive/private/a.txt", b"a")
            await self.put(".tgdrive/private/b.txt", b"b")
            await self.put(".tgdrive/private/c.txt", b"c")
            user = await self.unlock(await self.login())
            conversation = await self.private_conversation(user)
            # 私密空间内移动：与普通文件一样确认后执行。
            action_id, tool = await self.propose(user, conversation, call("propose_move", sources=["私密:/a.txt"], target="私密:/归档/"))
            self.assertEqual(tool["result"]["samples"], ["私密:/a.txt → 私密:/归档/a.txt"])
            status, done = await self.confirm(user, action_id)
            self.assertEqual(status, 200, done)
            self.assertIn(".tgdrive/private/归档/a.txt", self.keys())
            # 一次调用不能同时处理两个区域。
            self.model.replies = [call("propose_move", sources=["私密:/b.txt"], target="/普通/"), answer("不行")]
            await self.send(user, conversation, "把 b 移到普通目录")
            self.assertEqual((await self.tool_results(user, conversation))[-1]["status"], "error")
            # 公开分享不能用于私密文件。
            self.model.replies = [call("propose_share", paths=["私密:/b.txt"]), answer("不行")]
            await self.send(user, conversation, "分享 b")
            tool = (await self.tool_results(user, conversation))[-1]
            self.assertEqual(tool["status"], "error")
            self.assertIn("私密空间", json.dumps(tool["result"], ensure_ascii=False))
            # 移出私密空间：确认时必须重新验证身份。
            action_id, _ = await self.propose(user, conversation, call("propose_move_out", paths=["私密:/b.txt"], target="/导出/"))
            status, data = await self.confirm(user, action_id)
            self.assertEqual(status, 400)
            self.assertIn("重新验证", data["error"]["message"])
            status, _ = await self.confirm(user, action_id, {"password": "wrong"})
            self.assertNotEqual(status, 200)
            status, done = await self.confirm(user, action_id, {"password": "alice password"})
            self.assertEqual(status, 200, done)
            self.assertIn("导出/b.txt", self.keys())
            audit = {row["action"] for row in self.app.metadata.db.execute("SELECT action FROM audit_log")}
            self.assertIn("private.assistant.move_out", audit)
            # 锁定后待确认的私密操作需要重新解锁才能确认。
            action_id, _ = await self.propose(user, conversation, call("propose_rename", mapping=[{"from": "私密:/c.txt", "to": "d.txt"}]))
            await self.lock(user)
            status, _ = await self.confirm(user, action_id)
            self.assertEqual(status, 423)
            user = await self.unlock(user)
            status, done = await self.confirm(user, action_id)
            self.assertEqual(status, 200, done)
            self.assertIn(".tgdrive/private/d.txt", self.keys())
        self.run_async(run())

    def test_normal_conversation_moves_into_private(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            await self.put("Downloads/身份证.jpg", b"id")
            await self.put("Downloads/护照.jpg", b"pp")
            user = await self.login()
            await self.ack_private(user)
            conversation = await self.start_conversation(user, "Downloads/")
            # 未解锁时由卡片选择目标；确认需要解锁，目标不回传给对话。
            action_id, _ = await self.propose(user, conversation, call("propose_move_to_private", paths=["/Downloads/身份证.jpg"]))
            status, _ = await self.confirm(user, action_id, {"target": "/证件/"})
            self.assertEqual(status, 423)
            user = await self.unlock(user)
            status, done = await self.confirm(user, action_id, {"target": "/证件/"})
            self.assertEqual(status, 200, done)
            self.assertIn(".tgdrive/private/证件/身份证.jpg", self.keys())
            self.assertNotIn("证件", json.dumps(await self.messages(user, conversation), ensure_ascii=False))
            # 已解锁时模型可以给出私密目标，作为卡片的默认值。
            action_id, tool = await self.propose(user, conversation, call("propose_move_to_private", paths=["/Downloads/护照.jpg"],
                                                                          target="私密:/证件/"))
            row = self.service.trace.action(self.alice.id, action_id)
            self.assertEqual(self.service.trace.action_payload(row)["options"]["target"], "证件/")
        self.run_async(run())

    def test_normal_paths_cannot_reach_private(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            await self.put(".tgdrive/private/secret.txt", "绝密内容".encode())
            user = await self.unlock(await self.login())
            await self.ack_private(user)
            conversation = await self.start_conversation(user)
            self.model.replies = [call("read_text_file", path="/.tgdrive/private/secret.txt"), call("search_files", query="secret"),
                                  call("read_text_file", path="私密:/../secret.txt"), call("propose_move_out", paths=["/secret.txt"]),
                                  answer("无")]
            await self.send(user, conversation, "读一下")
            tools = await self.tool_results(user, conversation)
            self.assertEqual(tools[0]["status"], "error")
            self.assertEqual(tools[1]["result"]["files"], [], "普通搜索不包含私密文件")
            self.assertEqual(tools[2]["status"], "error", "不能越出私密空间")
            self.assertEqual(tools[3]["status"], "error", "移出只接受私密路径")
            self.assertIn("只处理私密空间", tools[3]["summary"])
            self.assertNotIn("绝密内容", json.dumps([tools[0], tools[1], tools[3]], ensure_ascii=False))
        self.run_async(run())

    def test_admin_can_disable_tool_only_for_private_paths(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            await self.put(".tgdrive/private/a.txt", b"private text")
            await self.put("a.txt", b"normal text")
            status, tools = await self.req("POST", "/api/admin/v1/assistant/tools", {"read_text_file": {"private_enabled": False}}, admin)
            self.assertEqual(status, 200, tools)
            item = next(tool for tool in tools if tool["name"] == "read_text_file")
            self.assertEqual((item["enabled"], item["private_enabled"], item["private"]), (True, False, "allow"))
            status, _ = await self.req("POST", "/api/admin/v1/assistant/tools", {"propose_share": {"private_enabled": True}}, admin)
            self.assertEqual(status, 400, "不提供的工具不能对私密空间启用")
            user = await self.unlock(await self.login())
            _, config = await self.req("GET", f"{BASE}/config", headers=user)
            self.assertIn("停用", next(tool for tool in config["tools"] if tool["name"] == "read_text_file")["note"])
            conversation = await self.private_conversation(user)
            self.model.replies = [call("read_text_file", path="私密:/a.txt"), call("read_text_file", path="/a.txt"), answer("好")]
            await self.send(user, conversation, "读两个文件")
            tools = await self.tool_results(user, conversation)
            self.assertEqual(tools[0]["status"], "error")
            self.assertEqual(tools[1]["status"], "ok")
            self.assertIn("normal text", tools[1]["result"]["content"])
        self.run_async(run())

    def test_private_full_mode_keeps_auto_execution(self):
        async def run():
            admin, _, model = await self.setup_assistant()
            await self.enable_private(admin, model)
            await self.req("POST", "/api/admin/v1/assistant/settings", {"full_access": True}, admin)
            await self.put(".tgdrive/private/a.txt", b"task content")
            user = await self.unlock(await self.login())
            conversation = await self.private_conversation(user)
            await self.req("POST", f"{BASE}/conversations/{conversation}/update", {"access_mode": "full"}, user)
            http = HttpFixture()
            self.app.offline.http.open = http.open
            self.model.replies = [call("read_text_file", path="私密:/a.txt"),
                                  call("http_request", url="https://other.example/api"),
                                  call("propose_rename", mapping=[{"from": "私密:/a.txt", "to": "b.txt"}]),
                                  call("propose_downloads", urls=["https://cdn.example/file.txt"], target="私密:/"), answer("完成")]
            await self.send(user, conversation, "读文件、查询接口，改名并保存资源")
            tools = await self.tool_results(user, conversation)
            self.assertTrue(all(tool["status"] == "ok" for tool in tools), tools)
            self.assertIn("自动执行", tools[2]["result"]["status"])
            self.assertIn("自动执行", tools[3]["result"]["status"])
            self.assertIn(".tgdrive/private/b.txt", self.keys())
        self.run_async(run())
