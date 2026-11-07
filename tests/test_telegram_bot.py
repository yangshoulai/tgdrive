"""Telegram 交互机器人（telegram/bot.py）：配置、绑定、保存文件、创建离线下载、下载提醒与文本转换。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app
from tgdrive.objects import Scope
from tgdrive.telegram import bot as botmod
from tgdrive.telegram.client import HttpResponse, FileInfo

TOKEN = "123456789:" + "A" * 35


class FakeClient:
    """记录发出的请求；文件下载返回预先放好的内容。"""
    files: dict[str, bytes] = {}

    def __init__(self, token):
        self.token = token
        self.sent: list[dict] = []
        self.calls: list[str] = []

    async def get_me(self):
        return {"id": 42, "username": "tessera_bot", "first_name": "Tessera"}

    async def delete_webhook(self):
        self.calls.append("deleteWebhook")

    async def set_my_commands(self, commands):
        self.calls.append("setMyCommands")

    async def get_updates(self, offset, timeout=25):
        await asyncio.sleep(3600)

    async def send_message(self, chat_id, text, *, html=False, buttons=None, reply_to=None):
        self.sent.append({"chat_id": chat_id, "text": text, "html": html, "buttons": buttons})
        return {"message_id": len(self.sent)}

    async def send_chat_action(self, chat_id, action="typing"):
        pass

    async def get_file(self, file_id):
        return FileInfo(file_id, None, f"documents/{file_id}")

    async def download_file(self, file_path, start=None, end=None):
        return HttpResponse(200, {}, self.files[file_path.rsplit("/", 1)[-1]])


class TelegramBotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "data", secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.bot = self.app.telegram_bot
        self.clients: list[FakeClient] = []
        def factory(token):
            client = FakeClient(token)
            self.clients.append(client)
            return client
        self.bot.client_factory = factory
        self.http = Client(self.app)

    def tearDown(self):
        self.app.metadata.close()
        self.temp.cleanup()

    @property
    def sent(self):
        return [message for client in self.clients for message in client.sent]

    def message(self, text=None, chat=555, **extra):
        body = {"message_id": 7, "date": 1700000000, "chat": {"id": chat, "type": "private"},
                "from": {"id": chat, "username": "alice_tg", "first_name": "Alice"}, **extra}
        if text is not None:
            body["text"] = text
        return {"update_id": 1, "message": body}

    def dispatch(self, update):
        async def run():
            self.bot._loop = asyncio.get_running_loop()
            await self.bot._dispatch(update)
            await asyncio.gather(*list(self.bot._background), return_exceptions=True)
        asyncio.run(run())

    def configure_and_bind(self):
        status = asyncio.run(self.bot.configure(TOKEN))
        self.assertEqual((status["enabled"], status["username"]), (True, "tessera_bot"))
        code = self.bot.create_code(self.alice.id)
        self.assertEqual(code["url"], f"https://t.me/tessera_bot?start={code['code']}")
        self.dispatch(self.message(f"/start {code['code']}"))
        self.assertIn("绑定成功", self.sent[-1]["text"])

    def test_configure_hides_token_and_survives_passphrase_rotation(self):
        status = asyncio.run(self.bot.configure(TOKEN))
        self.assertNotIn(TOKEN, json.dumps(status))
        self.assertEqual(self.clients[0].calls, ["deleteWebhook", "setMyCommands"])
        stored = self.app.metadata.db.execute("SELECT value FROM settings WHERE key=?", (botmod.TOKEN_KEY,)).fetchone()["value"]
        self.assertNotIn(TOKEN, stored)
        self.app.keystore.rotate("encryption passphrase", "another passphrase")
        self.assertEqual(self.bot._token(), TOKEN, "更换加密口令后 token 仍可解开")
        with self.assertRaises(ValueError):
            asyncio.run(self.bot.configure("not-a-token"))

    def test_storage_bot_token_is_rejected(self):
        self.app.telegram_bots.create("主存储", TOKEN, "-1001234567890")
        with self.assertRaises(ValueError) as caught:
            asyncio.run(self.bot.configure(TOKEN))
        self.assertIn("存储通道", str(caught.exception))

    def test_binding_and_codes_are_single_use(self):
        asyncio.run(self.bot.configure(TOKEN))
        self.dispatch(self.message("你好"))
        self.assertIn("还没有绑定", self.sent[-1]["text"])
        code = self.bot.create_code(self.alice.id)["code"]
        self.dispatch(self.message(f"/start {code}"))
        link = self.bot.user_status(self.alice.id)["link"]
        self.assertEqual((link["tg_username"], link["tg_name"]), ("alice_tg", "Alice"))
        self.dispatch(self.message(f"/start {code}", chat=777))
        self.assertIn("已失效", self.sent[-1]["text"], "绑定码只能用一次")
        self.dispatch({"update_id": 2, "message": {"message_id": 1, "chat": {"id": -100, "type": "group"}, "text": "hi"}})
        self.assertNotEqual(self.sent[-1]["chat_id"], -100, "群组消息不响应")
        self.dispatch(self.message("/unbind"))
        self.assertIsNone(self.bot.user_status(self.alice.id)["link"])

    def test_files_are_saved_to_the_chosen_folder(self):
        self.configure_and_bind()
        self.dispatch(self.message("/folder 下载/Telegram"))
        self.assertEqual(self.bot.user_status(self.alice.id)["link"]["folder"], "下载/Telegram/")
        FakeClient.files = {"doc1": b"hello telegram"}
        document = {"file_id": "doc1", "file_unique_id": "u1", "file_name": "note.txt", "mime_type": "text/plain", "file_size": 14}
        self.dispatch(self.message(document=document))
        self.dispatch(self.message(document=document))
        keys = [row["key"] for row in self.app.metadata.db.execute("SELECT key FROM objects WHERE bucket_id=? ORDER BY key", (self.alice.bucket_id,))]
        self.assertEqual(keys, ["下载/Telegram/note (1).txt", "下载/Telegram/note.txt"], "同名时自动改名，不覆盖")
        self.assertIn("note (1).txt", self.sent[-1]["text"])
        self.dispatch(self.message(document={**document, "file_id": "big", "file_size": 30 * 1024 * 1024}))
        self.assertIn("20 MB", self.sent[-1]["text"])
        self.dispatch(self.message("/folder .tgdrive/private"))
        self.assertIn("我的文件", self.sent[-1]["text"])

    def test_links_create_offline_tasks_with_the_best_variant(self):
        self.configure_and_bind()
        created = {}
        async def parse(user_id, text, **options):
            self.assertEqual(user_id, self.alice.id)
            return {"candidates": [
                {"ticket": "low", "name": "movie.mp4", "group": "0:0", "variant": "640x360 · 0.8 Mbps"},
                {"ticket": "high", "name": "movie.mp4", "group": "0:0", "variant": "1920x1080 · 5.0 Mbps"},
                {"ticket": "file", "name": "a.zip", "group": "1:0", "variant": None}]}
        def create(user_id, items, destination, **options):
            created.update(items=items, destination=destination)
            return [{"key": destination + item["name"], "size": None} for item in items]
        self.app.offline.parse, self.app.offline.create = parse, create
        self.dispatch(self.message("看看这个 https://example.com/movie.m3u8 和 https://example.com/a.zip"))
        self.assertEqual([item["ticket"] for item in created["items"]], ["high", "file"])
        self.assertEqual(created["destination"], "")
        self.assertIn("已创建 2 个离线下载", self.sent[-1]["text"])

    def test_finished_downloads_notify_without_private_names(self):
        self.configure_and_bind()
        def finish(row):
            async def run():
                self.bot._loop = asyncio.get_running_loop()
                self.bot.offline_finished(row)
                await asyncio.sleep(0.05)
                await asyncio.gather(*list(self.bot._background), return_exceptions=True)
            asyncio.run(run())
        finish({"user_id": self.alice.id, "key": "电影/a.mp4", "status": "completed", "size": 2048, "error": None})
        self.assertIn("下载完成：a.mp4", self.sent[-1]["text"])
        finish({"user_id": self.alice.id, "key": ".tgdrive/private/秘密.mp4", "status": "failed", "size": None, "error": "HTTP 403"})
        self.assertNotIn("秘密", self.sent[-1]["text"])
        self.bot.update_link(self.alice.id, {"notify": False})
        count = len(self.sent)
        finish({"user_id": self.alice.id, "key": "b.mp4", "status": "completed", "size": 1, "error": None})
        self.assertEqual(len(self.sent), count, "关闭提醒后不再推送")

    def test_user_api_and_admin_api(self):
        user = asyncio.run(self.http.login("user", "alice@example.com", "alice password"))
        admin = asyncio.run(self.http.login("admin", "admin@example.com", "admin password"))
        def call(method, path, body=None, session=user, expect=200):
            status, _, data = asyncio.run(self.http.request(method, path, json.dumps(body or {}).encode() if body is not None else b"", headers=session))
            self.assertEqual(status, expect, data)
            return json.loads(data) if data else None
        self.assertFalse(call("GET", "/api/user/v1/telegram")["available"])
        call("POST", "/api/admin/v1/telegram-bot", {"token": TOKEN}, session=user, expect=403)
        call("POST", "/api/admin/v1/telegram-bot", {"token": TOKEN}, session=admin)
        audit = self.app.metadata.db.execute("SELECT detail FROM audit_log WHERE action='telegram_bot.update'").fetchone()
        self.assertNotIn(TOKEN, audit["detail"] or "")
        self.assertTrue(call("GET", "/api/user/v1/telegram")["available"])
        link = call("POST", "/api/user/v1/telegram/link", {})
        self.assertTrue(link["url"].startswith("https://t.me/tessera_bot?start="))
        call("POST", "/api/user/v1/telegram", {"folder": "x"}, expect=400)

    def test_markdown_conversion(self):
        self.assertEqual(botmod.markdown_html("**粗体** 与 `a<b>` 和 [链接](https://e.com/x)"),
                         '<b>粗体</b> 与 <code>a&lt;b&gt;</code> 和 <a href="https://e.com/x">链接</a>')
        self.assertEqual(botmod.markdown_html("```py\nx < 1\n```"), "<pre>x &lt; 1</pre>")
        self.assertEqual(botmod.markdown_html("# 标题\n- 一项"), "<b>标题</b>\n• 一项")
        self.assertEqual(len(botmod._chunks("a\n" * 5000, 100)[0]), 100)


if __name__ == "__main__":
    unittest.main()


from tests.test_assistant import AssistantCase, answer, call  # noqa: E402


class TelegramAssistantTests(AssistantCase):
    """私聊里的文字转给文件助手：回复发回 Telegram，待确认操作附带按钮，在私聊里确认后执行并转发结果。"""

    def test_assistant_reply_and_action_buttons(self):
        async def run():
            await self.setup_assistant()
            user = await self.client.login("user", "alice@example.com", "alice password")
            status, _ = await self.req("POST", "/api/user/v1/assistant/notice/ack", {}, user)
            self.assertEqual(status, 204)
            await self.put("old.txt", b"old")
            bot = self.app.telegram_bot
            clients = []
            bot.client_factory = lambda token: clients.append(FakeClient(token)) or clients[-1]
            await bot.configure(TOKEN)
            bot._loop = asyncio.get_running_loop()
            code = bot.create_code(self.alice.id)["code"]
            base = {"message_id": 1, "date": 1700000000, "chat": {"id": 9, "type": "private"}, "from": {"id": 9}}
            await bot._dispatch({"update_id": 1, "message": {**base, "text": f"/start {code}"}})
            self.model.replies = [call("propose_trash", paths=["old.txt"]), answer("已准备把 **old.txt** 移入回收站，请确认。")]
            await bot._dispatch({"update_id": 2, "message": {**base, "text": "删掉 old.txt"}})
            active = bot.client()
            sent = active.sent
            reply = next(item for item in sent if "移入回收站，请确认" in item["text"])
            self.assertTrue(reply["html"], "助手回复按 HTML 发送，Markdown 粗体转成 <b>")
            self.assertIn("<b>old.txt</b>", reply["text"])
            card = sent[-1]
            self.assertIn("需要你确认：移入回收站 1 项", card["text"])
            self.assertIn("/old.txt", card["text"])
            data = card["buttons"][0][0]["callback_data"]
            self.assertTrue(data.endswith(":y"))
            tools = self.model.calls[0]["tools"]
            self.assertNotIn("ui_get_view", tools, "Telegram 对话不提供浏览器工具")
            self.assertIn("Telegram 机器人私聊", json.dumps(self.model.calls[0]["messages"], ensure_ascii=False))
            active.answered = []
            async def answer_callback(callback_id, text=""):
                active.answered.append(text)
            async def edit(chat_id, message_id, text, **options):
                active.sent.append({"chat_id": chat_id, "text": text, "edited": True})
            active.answer_callback_query, active.edit_message_text = answer_callback, edit
            self.model.replies = [answer("已经移入回收站。")]
            await bot._dispatch({"update_id": 3, "callback_query": {"id": "cb", "data": data, "message": {**base, "message_id": 5}}})
            self.assertEqual(active.answered, ["已确认，正在执行"])
            await asyncio.gather(*list(bot._background), return_exceptions=True)
            keys = [row["key"] for row in self.app.metadata.db.execute("SELECT key FROM objects WHERE bucket_id=?", (self.alice.bucket_id,))]
            self.assertNotIn("old.txt", keys)
            self.assertTrue(any("已经移入回收站" in item["text"] or "执行完成" in item["text"] for item in active.sent[-2:]), active.sent[-3:])
        self.run_async(run())
