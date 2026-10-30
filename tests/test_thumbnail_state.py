"""图片规格与失败状态分离，以及助手补图的无数据库回归。"""

import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from tgdrive.api import UserApi
from tgdrive.assistant.client_tools import ui_generate_thumbnails
from tgdrive.assistant.tools import ToolContext
from tgdrive.objects import ObjectInfo, ObjectService
from tgdrive.offline.service import OfflineDownloads


class ThumbnailStateTests(unittest.TestCase):
    def test_list_separates_missing_failed_and_ready_files(self):
        api = UserApi.__new__(UserApi)
        versions = {"failed": {"none": "1"}, "ready": {"thumb": "2", "grid": "3", "poster": "4"}}
        api.objects = SimpleNamespace(thumbnail_versions=Mock(return_value=versions))
        files = [ObjectInfo(1, name + ".mp4", 100, name, "video/mp4", {}, 0, name)
                 for name in ("missing", "failed", "ready")]
        missing, failed, ready = api._objects_json(files)
        self.assertEqual((missing["thumbnails"], missing["thumbnail_status"]), ([], "missing"))
        self.assertEqual((failed["has_thumbnail"], failed["thumbnails"], failed["thumbnail_versions"], failed["thumbnail_status"]),
                         (False, [], {}, "unavailable"))
        self.assertEqual((ready["has_thumbnail"], ready["thumbnail_status"]), (True, "ready"))
        self.assertEqual(ready["thumbnail_versions"], versions["ready"])
        self.assertEqual(set(ready["thumbnails"]), {"thumb", "grid", "poster"})
        self.assertEqual(versions["failed"], {"none": "1"}, "网页过滤不能删除内部失败记录")
        api.objects.thumbnail_versions.assert_called_once_with(["missing", "failed", "ready"])

    def test_real_images_take_precedence_over_a_stale_failure_marker(self):
        state = ObjectService.thumbnail_fields(("none", "thumb"), {"none": "1", "thumb": "2"})
        self.assertEqual(state, {"has_thumbnail": True, "thumbnails": ["thumb"],
                                 "thumbnail_versions": {"thumb": "2"}, "thumbnail_status": "ready"})

    def test_programmatic_api_can_preserve_its_existing_contract(self):
        info = ObjectInfo(1, "clip.mp4", 100, "etag", "video/mp4", {}, 0, "blob")
        state = UserApi._object_json(info, ["none"], legacy_thumbnails=True)
        self.assertEqual(state["thumbnails"], ["none"])
        self.assertNotIn("thumbnail_status", state)

    def test_download_task_does_not_publish_none_as_an_image(self):
        worker = OfflineDownloads.__new__(OfflineDownloads)
        worker.metadata = Mock()
        worker.metadata.db.execute.return_value = [{"key": "clip.mp4", "size": 100, "etag": "etag",
                                                    "content_type": "video/mp4", "blob_uuid": "blob"}]
        worker.objects = ObjectService(Mock(), Mock())
        worker.objects.thumbnail_versions = Mock(return_value={"blob": {"none": "1"}})
        task = {}
        worker._attach_files(1, [(task, {"bucket_id": 1, "key": "clip.mp4"})])
        self.assertEqual((task["file"]["thumbnails"], task["file"]["thumbnail_versions"], task["file"]["thumbnail_status"]),
                         ([], {}, "unavailable"))


class AssistantThumbnailStateTests(unittest.IsolatedAsyncioTestCase):
    def context(self, rows, variants):
        objects = ObjectService(Mock(), Mock())
        objects.metadata.db.execute.return_value.fetchall.return_value = rows
        objects.thumbnail_variants = Mock(return_value=variants)
        return ToolContext(user_id=1, bucket_id=1, scope_root="", objects=objects, offline=None,
                           view="files", location="", params={"max_files": 500}, state={})

    async def test_five_failed_episodes_are_selected_without_regenerate(self):
        rows = [{"key": f"电影/暗潮之下/第{index:02}集.mp4", "size": 100, "etag": str(index),
                 "content_type": "video/mp4", "blob_uuid": str(index)} for index in range(1, 7)]
        variants = {str(index): ["thumb", "grid", "poster"] if index == 4 else ["none"] for index in range(1, 7)}
        result = await ui_generate_thumbnails(self.context(rows, variants), {"path": "/电影/暗潮之下/"})
        self.assertEqual((result.result["media_files"], result.result["need"], result.result["already_have"],
                          result.result["previously_failed"]), (6, 5, 1, 5))
        self.assertEqual([item["path"] for item in result.event["items"]], [row["key"] for row in rows if row["blob_uuid"] != "4"])
        self.assertTrue(all(item["retry"] for item in result.event["items"]), "浏览器退路必须能覆盖旧失败标记")
        self.assertFalse(result.event["regenerate"], "重试缺图无需请求重做已有缩略图")

    async def test_existing_thumbnail_is_skipped_but_regenerate_can_fill_grid(self):
        row = {"key": "album/a.jpg", "size": 100, "etag": "etag", "content_type": "image/jpeg", "blob_uuid": "blob"}
        ctx = self.context([row], {"blob": ["thumb"]})
        result = await ui_generate_thumbnails(ctx, {"path": "/album/"})
        self.assertEqual(result.result["need"], 0)
        self.assertIsNone(result.event)
        result = await ui_generate_thumbnails(ctx, {"path": "/album/", "regenerate": True})
        self.assertEqual(result.result["need"], 1)
        self.assertFalse(result.event["items"][0]["retry"])

