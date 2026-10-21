"""长任务（docs/assistant-design.md §38）：进度记录、裁剪后找回结果、按结果判断重复、多层网页收集与分批下载。
只使用临时留痕与网页替身，不访问外网。"""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from tests import test_assistant_planning as planning
from tests.test_assistant_planning import call, step
from tests.trace_fixture import real_trace
from tgdrive.assistant.actions import ActionExecutor, Progress
from tgdrive.assistant.planning import Plan
from tgdrive.assistant.providers import Reply
from tgdrive.assistant.service import _slim_result
from tgdrive.assistant.tools import ToolContext, ToolError, ToolOutput, recall_result
from tgdrive.assistant.web_tools import collect_gallery, collect_links, get_collection, propose_downloads

SITE = "https://photos.example"


def album_page(album: int, page: int, *, pages: int = 3, per_page: int = 20, title: str | None = None) -> dict:
    """相册夹具：每页 per_page 张大图，「下一页」链接位置固定。"""
    url = f"{SITE}/album/{album}" + (f"?page={page}" if page > 1 else "")
    images = [{"path": "div.gallery>img", "urls": {"src": f"{SITE}/img/{album}/{page}-{n}.jpg"}, "w": 1200, "h": 800}
              for n in range(per_page)]
    links = [{"path": "div.pager>a", "href": f"{SITE}/album/{album}?page={page + 1}", "text": "下一页", "rel": ""}] if page < pages else []
    links.append({"path": "nav>a", "href": f"{SITE}/album/{album + 1}", "text": "下一个相册", "rel": ""})
    return {"url": url, "title": title or f"相册 {album}", "images": images, "links": links}


def list_page(page: int, *, pages: int = 4, per_page: int = 25) -> dict:
    first = (page - 1) * per_page + 1
    links = [{"path": "ul.albums>li>a", "href": f"{SITE}/album/{n}", "text": f"相册 {n}", "rel": ""} for n in range(first, first + per_page)]
    links += [{"path": "footer>a", "href": f"{SITE}/about", "text": "关于", "rel": ""}]
    if page < pages:
        links.append({"path": "div.pager>a", "href": f"{SITE}/model?page={page + 1}", "text": "下一页", "rel": "next"})
    return {"url": f"{SITE}/model" + (f"?page={page}" if page > 1 else ""), "title": "模特", "images": [], "links": links}


class Site:
    """按地址返回页面的 _fetch_page 替身，记录请求过的地址。"""

    def __init__(self, broken: set[int] = frozenset()):
        self.requests: list[str] = []
        self.broken = broken

    async def __call__(self, ctx, url, **options):
        self.requests.append(url)
        if url.startswith(f"{SITE}/model"):
            return list_page(int(url.split("page=")[1]) if "page=" in url else 1)
        album = int(url.split("/album/")[1].split("?")[0])
        page = int(url.split("page=")[1]) if "page=" in url else 1
        if album in self.broken:
            return {"url": url, "title": "广告页", "images": [], "links": []}
        return album_page(album, page, title="同名相册" if album in (7, 8) else None)


class LongTaskTools(unittest.IsolatedAsyncioTestCase):
    def context(self, trace, cid, **extra):
        return ToolContext(1, 1, "", None, extra.pop("offline", SimpleNamespace()), "files", "", extra.pop("params", {}), {},
                           conversation_id=cid, trace=trace, **extra)

    def rule(self, trace, cid):
        rule = {"start_url": f"{SITE}/album/1", "images": {"path": "div.gallery>img", "attr": "src", "transform": []},
                "pagination": {"type": "next_link", "rel_next": False, "text": "下一页", "path": "div.pager>a"},
                "confidence": "high", "notes": "", "goal": "大图"}
        return trace.create_collection(cid, 1, "collection", source=SITE, rule=rule, urls=[], count=0)

    async def test_trimmed_result_keeps_ids_and_can_be_recalled(self):
        trace, _ = real_trace(self)
        cid = trace.create_conversation(1, "", 1, keep=10)
        other = trace.create_conversation(1, "", 1, keep=10)
        run = trace.start_run(cid, 1, "test")
        content = '<tool_result tool="analyze_page" status="ok" truncated="false">\n<untrusted_data>\n' + json.dumps(
            {"collection_id": "g_abc", "samples": ["x" * 50] * 40}) + "\n</untrusted_data>\n</tool_result>"
        seq = trace.append(cid, run, "tool", {"call_id": "c1", "name": "analyze_page", "status": "ok", "summary": "相册 · 第一页 60 张",
                                              "result": {"collection_id": "g_abc", "first_page_count": 60, "next_offset": 40},
                                              "model_content": content}, tool_name="analyze_page")
        slim = _slim_result(trace.message(cid, seq))
        self.assertIn(f"recall_result(ref={seq})", slim)
        self.assertIn("collection_id=g_abc", slim)
        self.assertIn("next_offset=40", slim)
        tainted = []
        ctx = self.context(trace, cid, params={"max_chars": 2000}, taint=tainted.append)
        first = await recall_result(ctx, {"ref": seq})
        self.assertTrue(first.result["content"].startswith('{"collection_id": "g_abc"'))
        self.assertNotIn("<tool_result", first.result["content"])
        self.assertEqual(first.result["next_offset"], 2000)
        rest = await recall_result(ctx, {"ref": seq, "offset": 2000})
        self.assertIsNone(rest.result["next_offset"])
        self.assertEqual(len(first.result["content"]) + len(rest.result["content"]), first.result["total"])
        self.assertEqual(tainted, ["分析过网页", "分析过网页"])
        with self.assertRaisesRegex(ToolError, "不是本对话"):
            await recall_result(self.context(trace, other), {"ref": seq})

    async def test_plan_notes_survive_and_can_be_updated_alone(self):
        plan = Plan("run")
        plan.update({"items": [step()], "notes": "相册 1–37 已收集，结果集 g_abc，下一个从第 38 个开始"})
        self.assertIn("下一个从第 38 个开始", plan.context())
        event = plan.update({"notes": "相册 1–60 已收集"})
        self.assertEqual(event["notes"], "相册 1–60 已收集")
        self.assertEqual([item["id"] for item in event["items"]], ["one"])
        self.assertEqual(plan.update({"items": [step()]})["notes"], "相册 1–60 已收集", "改步骤时保留进度记录")
        with self.assertRaisesRegex(ValueError, "notes 最多"):
            plan.update({"notes": "x" * 2001})
        with self.assertRaisesRegex(ValueError, "计划需要"):
            Plan("run").update({"notes": "没有计划时不能只写记录"})

    async def test_collect_links_follows_list_pages_and_filters(self):
        trace, _ = real_trace(self)
        cid = trace.create_conversation(1, "", 1, keep=10)
        site = Site()
        with patch("tgdrive.assistant.web_tools._fetch_page", site), patch("tgdrive.assistant.web_tools.asyncio.sleep", AsyncMock()):
            output = await collect_links(self.context(trace, cid), {"url": f"{SITE}/model", "path": "ul.albums>li>a"})
        self.assertEqual((output.result["count"], output.result["pages"], output.result["complete"]), (100, 4, True))
        self.assertEqual(len(site.requests), 4)
        listed = await get_collection(self.context(trace, cid), {"collection_id": output.result["collection_id"]})
        self.assertEqual(listed.result["kind"], "links")
        self.assertEqual(listed.result["items"][0], {"url": f"{SITE}/album/1", "text": "相册 1"})
        with patch("tgdrive.assistant.web_tools._fetch_page", Site()):
            glob = await collect_links(self.context(trace, cid), {"url": f"{SITE}/model", "href_glob": f"{SITE}/album/*", "follow": False})
        self.assertEqual(glob.result["count"], 25)
        with self.assertRaisesRegex(ToolError, "至少给出"):
            await collect_links(self.context(trace, cid), {"url": f"{SITE}/model"})
        with self.assertRaisesRegex(ToolError, "不是文件"):
            await propose_downloads(self.context(trace, cid), {"collection_id": output.result["collection_id"], "target": "/"})

    async def test_collect_gallery_walks_many_albums_across_calls(self):
        trace, _ = real_trace(self)
        cid = trace.create_conversation(1, "", 1, keep=10)
        site = Site(broken={50})
        with patch("tgdrive.assistant.web_tools._fetch_page", site), patch("tgdrive.assistant.web_tools.asyncio.sleep", AsyncMock()):
            links = await collect_links(self.context(trace, cid), {"url": f"{SITE}/model", "path": "ul.albums>li>a"})
            gallery = self.rule(trace, cid)
            clock = iter(range(0, 10**6, 2))
            calls, outputs = 0, []
            with patch("tgdrive.assistant.web_tools.time.monotonic", lambda: next(clock)):
                while True:
                    calls += 1
                    output = await collect_gallery(self.context(trace, cid), {"collection_id": gallery, "albums": links.result["collection_id"]})
                    outputs.append(output.result)
                    if output.result["complete"] or calls > 50:
                        break
        self.assertGreater(calls, 1, "一次调用处理不完时分多次推进")
        self.assertEqual(len({json.dumps(result["progress"]) for result in outputs}), len(outputs), "每次调用都有进展，不会被判为重复")
        final = outputs[-1]
        self.assertTrue(final["complete"])
        self.assertEqual(final["progress"]["done"], 100)
        self.assertEqual(final["count"], 99 * 60)
        self.assertEqual(final["progress"]["failed"], 1)
        self.assertIn("/album/50", final["failed_samples"][0]["url"])
        record = trace.collection(1, gallery)
        albums = {entry["album"] for entry in record["urls"]}
        self.assertIn("同名相册", albums)
        self.assertIn("同名相册 (2)", albums)
        self.assertNotIn(f"{SITE}/album/101", site.requests, "不跟随「下一个相册」链接")
        # 分批提议、按相册分目录。
        propose = AsyncMock(return_value={"action_id": "a_1", "expires_at": 4102444800})
        ctx = self.context(trace, cid, propose=propose, limits={"download_urls": 2000})
        first = await propose_downloads(ctx, {"collection_id": gallery, "target": "/模特/", "offset": 0, "limit": 2000, "by_album": True})
        self.assertEqual(first.result["next_offset"], 2000)
        payload = propose.await_args.args[1]
        self.assertEqual(len(payload["items"]), 2000)
        self.assertEqual(payload["items"][0]["folder"], "相册 1")
        self.assertEqual(payload["options"]["target"], "模特/")
        last = await propose_downloads(ctx, {"collection_id": gallery, "target": "/模特/", "offset": 4000, "by_album": True})
        self.assertNotIn("next_offset", last.result)
        self.assertEqual(len(propose.await_args.args[1]["items"]), 99 * 60 - 4000)

    async def test_downloads_are_created_per_album_folder(self):
        created = []
        offline = SimpleNamespace(direct_ticket=lambda user, url, referer=None, name=None: f"t:{url}",
                                  create=lambda user, items, destination, private_scope=None: created.append((destination, len(items))))
        executor = ActionExecutor.__new__(ActionExecutor)
        executor.offline = offline
        items = [{"url": f"{SITE}/{n}.jpg", "name": f"{n}.jpg", "folder": "相册 A" if n < 3 else "../相册 B"} for n in range(5)]
        items.append({"url": f"{SITE}/x.jpg", "name": "x.jpg"})
        progress = Progress(total=len(items))
        await executor._downloads(1, "", {"options": {"target": "模特/"}, "items": items}, progress, None)
        self.assertEqual(sorted(created), [("模特/", 1), ("模特/相册 A/", 3), ("模特/相册 B/", 2)])
        self.assertEqual(progress.ok, 6)


class LongTaskLoop(planning.LoopTests):
    """沿用计划测试的执行循环夹具；只运行这里的用例。"""

    async def test_same_call_same_result_is_warned_once_then_stopped(self):
        service, state = await self.run_fixture([Reply(tool_calls=[call("search_files", {})]) for _ in range(6)] + [Reply(text="改用其他方法完成。")])
        messages = service.trace.messages(state.conversation_id)
        self.assertEqual([m.get("type") for m in messages if m["role"] == "event"], ["repeat_check"])
        self.assertIn("recall_result(ref)", next(m for m in messages if m.get("type") == "repeat_check")["model_text"])
        self.assertEqual(state.status, "completed")
        service, state = await self.run_fixture([Reply(tool_calls=[call("search_files", {})]) for _ in range(12)])
        self.assertEqual(state.stop_reason, "loop")

    async def test_same_call_with_new_results_is_progress(self):
        service, state = self.fixture([Reply(tool_calls=[call("search_files", {})]) for _ in range(8)] + [Reply(text="完成")])
        counter = iter(range(100))
        service.search.side_effect = lambda *args: ToolOutput({"count": next(counter)}, "找到")
        with patch("tgdrive.assistant.service.knowledge.public_config", return_value={}):
            await service._run(state)
        messages = service.trace.messages(state.conversation_id)
        self.assertFalse(any(m.get("type") == "repeat_check" for m in messages))
        self.assertEqual(state.status, "completed")


# 只运行本文件新增的循环用例，父类用例由 test_assistant_planning 负责。
for _name in [name for name in vars(planning.LoopTests) if name.startswith("test_")]:
    setattr(LongTaskLoop, _name, None)
del _name
