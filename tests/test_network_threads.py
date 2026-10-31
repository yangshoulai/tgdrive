"""Telegram 网络请求使用专用线程池：默认线程池被长任务占满时，读取文件末尾等新请求不必排队。"""

import asyncio
import concurrent.futures
import threading
import time
import unittest

from tgdrive.telegram.client import in_network_thread


class NetworkThreadTests(unittest.IsolatedAsyncioTestCase):
    async def test_network_requests_do_not_wait_for_busy_default_pool(self):
        loop = asyncio.get_running_loop()
        loop.set_default_executor(concurrent.futures.ThreadPoolExecutor(max_workers=2))
        release = threading.Event()
        busy = [asyncio.to_thread(release.wait, 5) for _ in range(4)]  # 默认线程池占满且还有排队
        await asyncio.sleep(0.05)
        started = time.monotonic()
        result = await asyncio.wait_for(in_network_thread(lambda: "tail"), timeout=1)
        self.assertEqual(result, "tail")
        self.assertLess(time.monotonic() - started, 0.5)
        release.set()
        await asyncio.gather(*busy)


if __name__ == "__main__":
    unittest.main()
