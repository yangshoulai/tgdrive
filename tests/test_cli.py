"""命令行入口：版本号与审计归档导出。"""
import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tgdrive import app
from tgdrive.version import __version__


class CliTests(unittest.TestCase):
    def test_version_flag_prints_package_version(self):
        out = io.StringIO()
        with mock.patch("sys.argv", ["tgdrive", "--version"]), contextlib.redirect_stdout(out), self.assertRaises(SystemExit) as raised:
            app.main()
        self.assertEqual(raised.exception.code, 0)
        self.assertEqual(out.getvalue().strip(), f"tgdrive {__version__}")

    def test_audit_export_prompts_for_passphrase_and_reports_failures(self):
        # 曾因缺少 getpass 导入而在提示口令时直接崩溃。
        with tempfile.TemporaryDirectory() as temp, mock.patch("getpass.getpass", return_value="wrong") as prompt:
            target = Path(temp) / "audit.jsonl"
            with self.assertRaises(SystemExit) as raised:
                app.audit_export_main([str(Path(temp) / "missing.tgdbak"), "--output", str(target)])
            prompt.assert_called_once()
            self.assertIn("导出失败", str(raised.exception.code))
            self.assertFalse(target.exists())
            self.assertEqual(list(Path(temp).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
