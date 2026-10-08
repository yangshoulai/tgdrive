"""健康检查和进程内流量指标的 HTTP 回归测试。"""

import asyncio
import tempfile
import unittest
from pathlib import Path

from tests.test_public_links import Client
from tgdrive.app import create_app


class HealthTests(unittest.TestCase):
    def test_health_endpoint_is_public_and_metrics_are_exposed_to_admin(self):
        async def run():
            with tempfile.TemporaryDirectory() as temp:
                app = create_app(Path(temp) / "data", secure_cookies=False, run_scheduler=False)
                client = Client(app)
                status, _, body = await client.request("GET", "/healthz")
                self.assertEqual(status, 200)
                self.assertEqual(body, b'{"status": "ok"}')
                status, _, _ = await client.request("GET", "/api/admin/v1/status")
                self.assertEqual(status, 200)
                app.metadata.close()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
