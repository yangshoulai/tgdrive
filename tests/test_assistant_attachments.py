"""文件助手对话附件（docs/assistant-design.md §22.5）：系统区存放、随对话删除、保存到我的文件与容量分项。"""
import json
import time
from urllib.parse import quote

from tests.test_assistant import AssistantCase, answer, call
from tests.test_assistant_vision import upload
from tgdrive.objects import Scope

PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 200


class AttachmentTests(AssistantCase):
    async def prepare(self):
        await self.setup_assistant()
        user = await self.client.login("user", "alice@example.com", "alice password")
        conversation = await self.start_conversation(user)
        return user, conversation

    def used(self):
        return self.app.metadata.db.execute("SELECT used_bytes FROM buckets WHERE id=?", (self.alice.bucket_id,)).fetchone()[0]

    def keys(self, prefix=".tgdrive/assistant/"):
        return [row[0] for row in self.app.metadata.db.execute(
            "SELECT key FROM objects WHERE bucket_id=? AND key>=? AND key<?", (self.alice.bucket_id, prefix, prefix + "\U0010ffff"))]

    def test_attachments_are_hidden_counted_and_owned(self):
        async def scenario():
            user, conversation = await self.prepare()
            item = await upload(self, user, "说明.txt", b"hello attachment", "text/plain")
            self.assertEqual((item["name"], item["size"], item["image"], item["conversation_id"]), ("说明.txt", 16, False, None))
            self.assertEqual(self.used(), 16, "附件计入已用空间")
            self.assertEqual(len(self.keys()), 1)
            _, listing = await self.req("GET", "/api/user/v1/list?prefix=", headers=user)
            self.assertEqual(listing["objects"], [], "我的文件看不到附件")
            self.assertNotIn(".tgdrive/", json.dumps(listing["prefixes"] if "prefixes" in listing else listing, ensure_ascii=False))
            status, _ = await self.req("GET", f"/api/user/v1/content?path={quote(self.keys()[0])}", headers=user)
            self.assertNotEqual(status, 200, "普通文件接口不能读取系统区")
            status, _, body = await self.client.request("GET", f"/api/user/v1/assistant/attachments/{item['id']}/content", b"", user)
            self.assertEqual((status, body), (200, b"hello attachment"))
            # 另一个用户既不能读取，也不能发送别人的附件。
            self.app.accounts.create_user("bob@example.com", "bob password")
            bob = await self.client.login("user", "bob@example.com", "bob password")
            status, _, _ = await self.client.request("GET", f"/api/user/v1/assistant/attachments/{item['id']}/content", b"", bob)
            self.assertEqual(status, 404)
            other = await self.start_conversation(bob)
            status, data = await self.send(bob, other, "看看", attachments=[item["id"]])
            self.assertEqual(status, 400, data)
            # 用量分项。
            _, usage = await self.req("GET", "/api/user/v1/usage", headers=user)
            self.assertEqual(usage["assistant"], 16)
            self.assertEqual(usage["files"] + usage["trash"] + usage["private"] + usage["assistant"], usage["total"])
        self.run_async(scenario())

    def test_send_binds_renames_and_locks_attachments(self):
        async def scenario():
            user, conversation = await self.prepare()
            first = await upload(self, user, "a.txt", b"one", "text/plain")
            self.model.replies = [answer("好"), answer("好")]
            status, data = await self.send(user, conversation, "第一条", attachments=[first["id"]])
            self.assertEqual(status, 201, data)
            status, data = await self.req("POST", f"/api/user/v1/assistant/attachments/{first['id']}/discard", {}, user)
            self.assertEqual(status, 400, "已发送的附件不能单独删除")
            status, data = await self.send(user, conversation, "再发一次", attachments=[first["id"]])
            self.assertEqual(status, 400, "附件不能重复发送")
            second = await upload(self, user, "a.txt", b"two", "text/plain")
            status, data = await self.send(user, conversation, "同名附件", attachments=[second["id"]])
            self.assertEqual(status, 201, data)
            stored = [m for m in await self.messages(user, conversation) if m["role"] == "user"]
            self.assertEqual([item["name"] for m in stored for item in m.get("attachments", [])], ["a.txt", "a (2).txt"])
            self.assertIn("附件:a (2).txt", self.model.calls[-1]["messages"][-2]["content"])
            # 未发送的附件可以放弃，立即释放空间。
            spare = await upload(self, user, "spare.bin", b"12345")
            before = self.used()
            status, _ = await self.req("POST", f"/api/user/v1/assistant/attachments/{spare['id']}/discard", {}, user)
            self.assertEqual(status, 204)
            self.assertEqual(self.used(), before - 5)
            _, stats = await self.req("GET", "/api/user/v1/assistant/attachments/stats", headers=user)
            self.assertEqual((stats["count"], stats["size"]), (2, 6))
            self.assertEqual([(item["conversation_id"], item["count"]) for item in stats["conversations"]], [(conversation, 2)])
            _, detail = await self.req("GET", f"/api/user/v1/assistant/conversations/{conversation}", headers=user)
            self.assertEqual(detail["attachments"], {"count": 2, "size": 6})
        self.run_async(scenario())

    def test_delete_conversation_and_retry_remove_attachments(self):
        async def scenario():
            user, conversation = await self.prepare()
            kept = await upload(self, user, "kept.txt", b"kept", "text/plain")
            dropped = await upload(self, user, "dropped.txt", b"dropped!", "text/plain")
            self.model.replies = [answer("一"), answer("二"), answer("重试")]
            await self.send(user, conversation, "一", attachments=[kept["id"]])
            await self.send(user, conversation, "二", attachments=[dropped["id"]])
            first_seq = next(m["seq"] for m in await self.messages(user, conversation) if m["role"] == "user")
            status, data = await self.req("POST", f"/api/user/v1/assistant/conversations/{conversation}/retry", {"seq": first_seq}, user)
            self.assertEqual(status, 201, data)
            await self.service.runs[data["run_id"]].task
            users = [m for m in await self.messages(user, conversation) if m["role"] == "user"]
            self.assertEqual([[item["id"] for item in m.get("attachments", [])] for m in users], [[kept["id"]]], "重试保留重发的附件")
            self.assertEqual(self.used(), 4, "被截断消息上的附件已删除")
            gc_before = self.app.metadata.db.execute("SELECT COUNT(*) FROM gc_queue").fetchone()[0]
            status, _ = await self.req("POST", f"/api/user/v1/assistant/conversations/{conversation}/delete", {}, user)
            self.assertEqual(status, 204)
            self.assertEqual((self.used(), self.keys()), (0, []), "删除对话立即删除附件")
            self.assertGreater(self.app.metadata.db.execute("SELECT COUNT(*) FROM gc_queue").fetchone()[0], gc_before)
            self.assertEqual(self.app.metadata.db.execute("SELECT COUNT(*) FROM assistant_attachments").fetchone()[0], 0)
        self.run_async(scenario())

    def test_cleanup_removes_stale_pending_and_expired_conversations(self):
        async def scenario():
            user, conversation = await self.prepare()
            pending = await upload(self, user, "pending.txt", b"p")
            fresh = await upload(self, user, "fresh.txt", b"f")
            sent = await upload(self, user, "sent.txt", b"s")
            self.model.replies = [answer("好")]
            await self.send(user, conversation, "附件", attachments=[sent["id"]])
            with self.app.metadata.transaction() as db:
                db.execute("UPDATE assistant_attachments SET created_at=? WHERE id=?", (time.time() - 2 * 86400, pending["id"]))
            report = await self.service.cleanup()
            self.assertEqual(report["attachments"], 1)
            ids = {row[0] for row in self.app.metadata.db.execute("SELECT id FROM assistant_attachments")}
            self.assertEqual(ids, {fresh["id"], sent["id"]})
            # 保留期到期的对话连同附件一起清理。
            with self.app.metadata.transaction() as db:
                db.execute("UPDATE assistant_conversations SET updated_at=0 WHERE id=?", (conversation,))
            await self.service.cleanup()
            ids = {row[0] for row in self.app.metadata.db.execute("SELECT id FROM assistant_attachments")}
            self.assertEqual(ids, {fresh["id"]})
            self.assertEqual(self.used(), 1)
        self.run_async(scenario())

    def test_save_to_files_shares_blob_and_survives_conversation(self):
        async def scenario():
            user, conversation = await self.prepare()
            item = await upload(self, user, "报告.txt", b"report body", "text/plain")
            self.model.replies = [answer("好")]
            await self.send(user, conversation, "存一下", attachments=[item["id"]])
            await self.put("文档/报告.txt", b"existing")
            status, saved = await self.req("POST", f"/api/user/v1/assistant/attachments/{item['id']}/save", {"path": "/文档/"}, user)
            self.assertEqual(status, 200, saved)
            self.assertEqual(saved["path"], "/文档/报告 (1).txt", "同名自动改名")
            blobs = self.app.metadata.db.execute("SELECT DISTINCT blob_uuid FROM objects WHERE bucket_id=? AND (key=? OR key LIKE '.tgdrive/assistant/%')",
                                                 (self.alice.bucket_id, "文档/报告 (1).txt")).fetchall()
            self.assertEqual(len(blobs), 1, "引用同一个 Blob")
            for target in ("/.tgdrive/private/", "../x"):
                status, _ = await self.req("POST", f"/api/user/v1/assistant/attachments/{item['id']}/save", {"path": target}, user)
                self.assertEqual(status, 400, target)
            await self.req("POST", f"/api/user/v1/assistant/conversations/{conversation}/delete", {}, user)
            _, stream = await self.app.objects.get_object(Scope(self.alice.bucket_id), "文档/报告 (1).txt")
            self.assertEqual(b"".join([chunk async for chunk in stream]), b"report body")
            events = self.app.audit.list(limit=20)
            events = events["events"] if isinstance(events, dict) else events
            saved_event = next(event for event in events if event["action"] == "assistant.attachment.save" and event["ok"])
            self.assertIsNone(saved_event["target"], "审计不记录路径")
            self.assertEqual(saved_event["detail"], {"bytes": 11})
        self.run_async(scenario())

    def test_propose_save_attachment_requires_confirmation(self):
        async def scenario():
            user, conversation = await self.prepare()
            item = await upload(self, user, "照片.png", PNG, "image/png")
            self.model.replies = [call("propose_save_attachment", items=[{"attachment": "附件:照片.png", "target": "/相册/"}]),
                                  answer("请确认。")]
            status, data = await self.send(user, conversation, "存到相册", attachments=[item["id"]])
            self.assertEqual(status, 201, data)
            _, detail = await self.req("GET", f"/api/user/v1/assistant/conversations/{conversation}", headers=user)
            action = detail["actions"][-1]
            self.assertEqual((action["kind"], action["status"]), ("save_attachment", "pending"))
            self.assertEqual(self.keys("相册/"), [], "确认前不保存")
            status, result = await self.req("POST", f"/api/user/v1/assistant/actions/{action['id']}/confirm", {}, user)
            self.assertEqual(status, 200, result)
            for _ in range(50):
                if self.keys("相册/"):
                    break
                await __import__("asyncio").sleep(0.02)
            self.assertEqual(self.keys("相册/"), ["相册/照片.png"])
        self.run_async(scenario())
