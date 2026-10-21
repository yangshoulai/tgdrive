"""定向测试用的真实留痕：临时数据目录里的 TraceStore（私密对话不再有内存留痕，§37）。"""
import tempfile
import unittest
from pathlib import Path

from tgdrive.app import create_app


def real_trace(case: unittest.TestCase):
    """返回 (留痕, 用户编号)；数据目录在测试结束时清理。"""
    temp = tempfile.TemporaryDirectory()
    app = create_app(Path(temp.name) / "data", secure_cookies=False, run_scheduler=False)
    app.accounts.setup("encryption passphrase", "admin@example.com", "admin password")
    case.addCleanup(temp.cleanup)
    case.addCleanup(app.metadata.close)
    return app.assistant.trace, 1
