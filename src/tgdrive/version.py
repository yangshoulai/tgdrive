"""版本号：唯一来源是 pyproject.toml，运行时从安装包元数据读取。"""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("tgdrive")
except PackageNotFoundError:  # 未安装（直接从源码目录运行）
    __version__ = "0.0.0+dev"
