"""离线下载「更改保存位置」与「立即下载」：只改未完成任务的目录且不中断下载；插队时只暂停本账号进度最小的任务并放回排队。"""

import asyncio
import tempfile
import unittest

from tgdrive.app import create_app
from tgdrive.objects import PRIVATE_PREFIX, Scope
from tests.test_offline_probe import ScriptedHttp


class OfflinePriorityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(self.temp.name, secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.bob = self.app.accounts.create_user("bob@example.com", "bob password")
        self.offline = self.app.offline
        self.offline.http = ScriptedHttp([0] * 40)
        self.concurrency, self.videos = 2, 1
        effective = self.offline.resources.effective
        self.offline.resources.effective = lambda: {**effective(), "concurrency": self.concurrency, "ffmpeg_concurrency": self.videos,
                                                    "hls_enabled": True, "hls_available": True}

    async def asyncTearDown(self):
        for task in self.offline._running.values():
            task.cancel()
        await asyncio.gather(*self.offline._running.values(), return_exceptions=True)
        self.offline._running.clear()
        await self.offline.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    async def create(self, user, name, destination="下载/"):
        ticket = (await self.offline.parse(user.id, f"https://pan.example.com/{name}?sign=1"))["candidates"][0]["ticket"]
        return self.offline.create(user.id, [{"ticket": ticket, "name": name}], destination)[0]["id"]

    def row(self, task_id):
        return self.offline._row(task_id)

    def fake_running(self, task_id, *, received=0, size=None, method=None):
        """模拟运行中的任务：与 _run 一样在取消时按意图写回状态。"""
        values = {"status": "running", "received": received, "size": size}
        if method:
            values["method"] = method
        self.offline._set(task_id, **values)

        async def run():
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                status, error = self.offline._intents.get(task_id, ("interrupted", "任务已中断"))
                self.offline._set(task_id, status=status, error=error)
                raise
        self.offline._running[task_id] = asyncio.create_task(run())

    # ---------- 更改保存位置 ----------

    async def test_relocate_changes_folder_keeps_name_and_running_upload(self):
        queued, running = await self.create(self.alice, "a.bin"), await self.create(self.alice, "b.bin")
        scope = Scope(self.alice.bucket_id)
        upload = await self.app.user.objects.create_multipart(scope, "下载/b.bin")
        self.offline._set(running, status="running", upload_id=upload)
        result = self.offline.relocate(self.alice.id, [queued, running], "归档/2026/")
        self.assertEqual((result["moved"], result["skipped"]), (2, 0))
        self.assertEqual(self.row(queued)["key"], "归档/2026/a.bin")
        self.assertEqual(self.row(running)["key"], "归档/2026/b.bin")
        self.assertEqual(self.row(running)["status"], "running", "正在下载的任务不中断")
        # 进行中的分段上传一起改到新位置，提交时直接保存到新目录。
        self.assertEqual(self.app.metadata.db.execute("SELECT key FROM uploads WHERE upload_id=?", (upload,)).fetchone()[0], "归档/2026/b.bin")

    async def test_relocate_skips_completed_and_renames_conflicts(self):
        done, first, second = await self.create(self.alice, "x.bin"), await self.create(self.alice, "c.bin"), await self.create(self.alice, "c.bin", "其他/")
        self.offline._set(done, status="completed")
        result = self.offline.relocate(self.alice.id, [done, first, second], "合并/")
        self.assertEqual((result["moved"], result["skipped"]), (2, 1))
        self.assertEqual(self.row(done)["key"], "下载/x.bin")
        self.assertEqual({self.row(first)["key"], self.row(second)["key"]}, {"合并/c.bin", "合并/c (1).bin"})

    async def test_relocate_rejects_other_users_area_and_system_paths(self):
        task = await self.create(self.alice, "a.bin")
        self.assertEqual(self.offline.relocate(self.bob.id, [task], "b/")["skipped"], 1)
        with self.assertRaises(ValueError):
            self.offline.relocate(self.alice.id, [task], PRIVATE_PREFIX + "x/")  # 未解锁
        private_scope = Scope(self.alice.bucket_id, PRIVATE_PREFIX, private_access=True)
        with self.assertRaisesRegex(ValueError, "我的文件与私密空间"):
            self.offline.relocate(self.alice.id, [task], PRIVATE_PREFIX + "x/", private_scope=private_scope)
        for destination in (".tgdrive/", "../up/"):
            with self.assertRaises((ValueError, PermissionError)):
                self.offline.relocate(self.alice.id, [task], destination)
        self.assertEqual(self.row(task)["key"], "下载/a.bin")

    # ---------- 立即下载 ----------

    async def test_now_pauses_own_task_with_least_progress_and_requeues_it(self):
        slow, fast, target = await self.create(self.alice, "slow.bin"), await self.create(self.alice, "fast.bin"), await self.create(self.alice, "t.bin")
        self.fake_running(slow, received=10, size=100)
        self.fake_running(fast, received=90, size=100)
        plan = await self.offline.prioritize(self.alice.id, target, preview=True)
        self.assertEqual(plan["victim"]["id"], slow)
        self.assertEqual(self.row(slow)["status"], "running", "预览不改变任何任务")
        result = await self.offline.prioritize(self.alice.id, target)
        self.assertEqual(result["victim"]["id"], slow)
        self.assertEqual(self.row(slow)["status"], "queued", "让出的任务回到排队，稍后自动继续")
        self.assertEqual(self.row(fast)["status"], "running")
        self.assertGreater(self.row(target)["priority"], 0)
        self.assertEqual(self.row(target)["status"], "queued")

    async def test_now_never_pauses_other_users_or_post_tasks(self):
        other, post, target = await self.create(self.bob, "bob.bin"), await self.create(self.alice, "post.bin"), await self.create(self.alice, "t.bin")
        self.fake_running(other, received=1, size=100)
        self.fake_running(post, received=1, size=100, method="POST")
        result = await self.offline.prioritize(self.alice.id, target)
        self.assertEqual((result["victim"], result["waiting"]), (None, True))
        self.assertEqual((self.row(other)["status"], self.row(post)["status"]), ("running", "running"))
        self.assertGreater(self.row(target)["priority"], 0)

    async def test_now_with_free_slot_does_not_pause_and_resumes_stopped_task(self):
        busy, target = await self.create(self.alice, "busy.bin"), await self.create(self.alice, "t.bin")
        self.fake_running(busy, received=1, size=100)
        self.offline._set(target, status="failed", error="boom")
        result = await self.offline.prioritize(self.alice.id, target)
        self.assertEqual((result["victim"], result["waiting"]), (None, False))
        self.assertEqual((self.row(target)["status"], self.row(target)["error"]), ("queued", None))
        self.offline._set(target, status="completed")
        with self.assertRaises(ValueError):
            await self.offline.prioritize(self.alice.id, target)

    async def test_scheduler_starts_prioritized_task_first_and_stop_clears_priority(self):
        ids = [await self.create(self.alice, f"{n}.bin") for n in range(3)]
        await self.offline.prioritize(self.alice.id, ids[2])
        await self.offline.control(self.alice.id, ids[1], "stop")
        self.assertEqual(self.row(ids[1])["priority"], 0)
        await self.offline.prioritize(self.alice.id, ids[1])
        self.assertGreater(self.row(ids[1])["priority"], self.row(ids[2])["priority"])
        started = []

        async def run(task_id):
            started.append(task_id)
            await asyncio.sleep(3600)
        self.concurrency = 1
        self.offline._run = run
        self.offline.resources.pressure = lambda: None
        self.offline.start()
        for _ in range(100):
            if started:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(started, [ids[1]], "最近一次插队的任务最先开始")


    async def test_video_concurrency_limits_only_video_tasks(self):
        videos = [await self.create(self.alice, f"v{n}.mp4") for n in range(3)]
        plain = await self.create(self.alice, "plain.bin")
        for task_id in videos:
            self.offline._set(task_id, kind="hls")
        started = []

        async def run(task_id):
            started.append(task_id)
            await asyncio.sleep(3600)
        self.concurrency, self.videos = 4, 2
        self.offline._run = run
        self.offline.resources.pressure = lambda: None
        self.offline.start()
        for _ in range(100):
            if len(started) >= 3:
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)
        self.assertEqual(sorted(started), sorted([videos[0], videos[1], plain]), "同时封装 2 个视频，第三个视频排队，普通任务照常开始")

    async def test_now_for_video_yields_a_video_when_video_slots_are_full(self):
        running_video, running_plain, target = (await self.create(self.alice, "a.mp4"), await self.create(self.alice, "b.bin"),
                                                await self.create(self.alice, "c.mp4"))
        for task_id in (running_video, target):
            self.offline._set(task_id, kind="hls")
        self.concurrency, self.videos = 4, 1
        self.fake_running(running_video, received=50, size=100)
        self.fake_running(running_plain, received=1, size=100)
        plan = await self.offline.prioritize(self.alice.id, target, preview=True)
        self.assertEqual(plan["victim"]["id"], running_video, "视频名额已满时只能让出视频任务，即使普通任务进度更小")
        self.videos = 2
        plan = await self.offline.prioritize(self.alice.id, target, preview=True)
        self.assertEqual((plan["victim"], plan["waiting"]), (None, False), "还有视频名额和下载空位时不需要让出")


if __name__ == "__main__":
    unittest.main()
