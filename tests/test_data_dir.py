"""数据目录不可写时给出明确的错误，而不是 sqlite 的 “unable to open database file”。"""
import os
import stat
import tempfile
import unittest
from pathlib import Path

from tgdrive.app import create_app


@unittest.skipIf(os.geteuid() == 0, "root 不受目录权限限制")
class DataDirTests(unittest.TestCase):
    def test_unwritable_data_dir_gives_a_clear_message(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp) / "data"
            data.mkdir()
            data.chmod(stat.S_IRUSR | stat.S_IXUSR)
            try:
                with self.assertRaises(SystemExit) as raised:
                    create_app(data)
            finally:
                data.chmod(stat.S_IRWXU)
            message = str(raised.exception)
            self.assertIn("不可写", message)
            self.assertIn("10001", message)  # 提示 Docker 容器默认以 10001 运行

    def test_writable_data_dir_works(self):
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(Path(temp) / "new" / "data", secure_cookies=False)
            app.metadata.close()


if __name__ == "__main__":
    unittest.main()
