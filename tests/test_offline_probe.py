"""解析直链时探测文件信息：首次响应慢或临时故障时自动重试，全部超时才提示；内容或权限错误不重试。"""

import asyncio
import tempfile
import unittest
from contextlib import asynccontextmanager
from unittest import mock

from tgdrive.app import create_app
from tgdrive.offline import service


class Response:
    def __init__(self, request, status):
        self.url, self.status, self.size = request.url, status, 4096 if status == 200 else None
        self.headers = {"content-type": "audio/flac", "content-disposition": 'attachment; filename="song.flac"'} if status == 200 else {}


class ScriptedHttp:
    """按顺序执行脚本：数字是延迟秒数后返回 200，"503"／"404" 直接返回对应状态。"""
    def __init__(self, steps):
        self.steps, self.calls = list(steps), 0

    @asynccontextmanager
    async def open(self, request, **kwargs):
        self.calls += 1
        step = self.steps.pop(0) if self.steps else 0
        if isinstance(step, str):
            yield Response(request, int(step))
            return
        await asyncio.sleep(step)
        yield Response(request, 200)


class ProbeRetryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(self.temp.name, secure_cookies=False, run_scheduler=False)
        self.app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
        self.alice = self.app.accounts.create_user("alice@example.com", "alice password")
        self.offline = self.app.offline
        patches = [mock.patch.object(service, "PROBE_TIMEOUT", 0.2), mock.patch.object(service, "PROBE_RETRY_DELAY", 0.01),
                   mock.patch.object(service, "PROBE_BUDGET", 3)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    async def asyncTearDown(self):
        await self.offline.stop()
        self.app.metadata.close()
        self.temp.cleanup()

    async def parse(self, steps):
        self.offline.http = http = ScriptedHttp(steps)
        candidate = (await self.offline.parse(self.alice.id, "https://pan.example.com/file?sign=1"))["candidates"][0]
        return candidate, http.calls

    async def test_slow_first_response_is_retried(self):
        candidate, calls = await self.parse([1, 0])
        self.assertEqual((candidate["size"], candidate["name"]), (4096, "song.flac"))
        self.assertEqual(candidate["warnings"], [])
        self.assertEqual(calls, 2)

    async def test_temporary_failure_is_retried(self):
        candidate, calls = await self.parse(["503", 0])
        self.assertEqual(candidate["size"], 4096)
        self.assertEqual(calls, 2)

    async def test_timeout_warning_after_all_attempts(self):
        candidate, calls = await self.parse([1, 1])
        self.assertEqual(candidate["size"], None)
        self.assertIn("获取文件信息超时，开始下载时会再次校验来源", candidate["warnings"])
        self.assertEqual(calls, service.PROBE_ATTEMPTS)

    async def test_not_found_is_not_retried(self):
        candidate, calls = await self.parse(["404", "404"])
        self.assertTrue(any("HTTP 404" in warning for warning in candidate["warnings"]))
        self.assertEqual(calls, 1, "404 不是临时故障，不重试")


if __name__ == "__main__":
    unittest.main()
