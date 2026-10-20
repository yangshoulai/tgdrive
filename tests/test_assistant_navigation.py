"""私密导航的服务端边界：只用替身，不启动真实应用或数据库。"""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from tgdrive.assistant.client_tools import ui_navigate
from tgdrive.assistant.tools import ToolError


class NavigationTests(unittest.IsolatedAsyncioTestCase):
    async def test_private_download_navigation_never_reaches_browser(self):
        context = SimpleNamespace(private=True, client=AsyncMock())
        with self.assertRaisesRegex(ToolError, "list_downloads"):
            await ui_navigate(context, {"view": "downloads"})
        context.client.assert_not_awaited()

    async def test_private_trash_navigation_stays_available(self):
        context = SimpleNamespace(private=True, client=AsyncMock(return_value={"ok": True}))
        result = await ui_navigate(context, {"view": "trash"})
        context.client.assert_awaited_once_with("ui_navigate", {"view": "trash", "path": None})
        self.assertEqual(result.result["view"], "trash")

    async def test_regular_download_navigation_stays_available(self):
        context = SimpleNamespace(private=False, client=AsyncMock(return_value={"ok": True}))
        await ui_navigate(context, {"view": "downloads"})
        context.client.assert_awaited_once_with("ui_navigate", {"view": "downloads", "path": None})
