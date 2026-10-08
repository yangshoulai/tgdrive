"""领域异常。入口层可以据此映射 HTTP/S3 错误。"""


class TgDriveError(Exception):
    """所有可预期的 tgdrive 错误的基类。"""


class IntegrityError(TgDriveError):
    """密文长度、哈希或 AEAD 校验失败。"""


class WrongPassphrase(TgDriveError):
    """口令不能解出有效的 KEK 校验块。"""


class NotFoundError(TgDriveError):
    """元数据或 Blob 不存在。"""


class NotReadyError(TgDriveError):
    """系统尚未初始化或尚未解锁。"""


class BlobNotFound(NotFoundError):
    """Blob 不存在。"""


class SourceChangedError(TgDriveError):
    """上传源在续传期间发生变化（旧接口兼容）。"""


class InvalidStateError(TgDriveError):
    """对象状态不允许执行当前操作。"""


class ShareExpiredError(NotFoundError):
    """公开链接已超过有效期。"""


class QuotaExceededError(TgDriveError):
    """对象提交后会超过存储桶配额。"""
