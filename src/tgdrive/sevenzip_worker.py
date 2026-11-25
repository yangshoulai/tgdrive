"""受限的原生 7z 解码进程。通过 stdin / stdout 随机读取归档并传回条目。"""

from __future__ import annotations

import ctypes as ct
from ctypes.util import find_library
import json
import stat
import sys

from .sevenzip import BLOCK_SIZE


class DecodeError(Exception):
    pass


def emit(message: dict, data: bytes = b"") -> None:
    sys.stdout.buffer.write(json.dumps(message, ensure_ascii=False).encode("utf-8") + b"\n")
    if data:
        sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def extract(size: int) -> None:
    library = find_library("archive")
    if not library:
        raise DecodeError("unavailable")
    ptr, offset_type = ct.c_void_p, ct.c_int64
    read_cb = ct.CFUNCTYPE(ct.c_ssize_t, ptr, ptr, ct.POINTER(ptr))
    seek_cb = ct.CFUNCTYPE(offset_type, ptr, ptr, offset_type, ct.c_int)
    signatures = {
        "archive_read_new": (ptr, []), "archive_read_free": (ct.c_int, [ptr]),
        "archive_read_support_format_7zip": (ct.c_int, [ptr]),
        "archive_read_set_read_callback": (ct.c_int, [ptr, read_cb]),
        "archive_read_set_seek_callback": (ct.c_int, [ptr, seek_cb]),
        "archive_read_set_callback_data": (ct.c_int, [ptr, ptr]),
        "archive_read_open1": (ct.c_int, [ptr]),
        "archive_read_next_header": (ct.c_int, [ptr, ct.POINTER(ptr)]),
        "archive_read_data": (ct.c_ssize_t, [ptr, ptr, ct.c_size_t]),
        "archive_read_data_skip": (ct.c_int, [ptr]),
        "archive_entry_pathname_utf8": (ct.c_char_p, [ptr]),
        "archive_entry_filetype": (ct.c_uint, [ptr]),
        "archive_entry_size": (offset_type, [ptr]),
        "archive_entry_is_encrypted": (ct.c_int, [ptr]),
        "archive_entry_hardlink": (ct.c_char_p, [ptr]),
        "archive_error_string": (ct.c_char_p, [ptr]),
    }
    try:
        lib = ct.CDLL(library)
        for name, (result, args) in signatures.items():
            function = getattr(lib, name)
            function.restype, function.argtypes = result, args
    except (OSError, AttributeError):
        raise DecodeError("unavailable") from None

    position, buffer = 0, None

    @read_cb
    def read(_, __, output):
        nonlocal position, buffer
        end = min(position + BLOCK_SIZE, size)
        if end == position:
            return 0
        try:
            emit({"read": [position, end]})
            data = sys.stdin.buffer.read(end - position)
            if len(data) != end - position:
                return -1
            buffer = ct.create_string_buffer(data)
            output[0] = ct.cast(buffer, ptr)
            position = end
            return len(data)
        except (OSError, MemoryError):
            return -1

    @seek_cb
    def seek(_, __, offset, mode):
        nonlocal position
        if mode not in (0, 1, 2):
            return -1
        target = (0, position, size)[mode] + offset
        if not 0 <= target <= size:
            return -1
        position = target
        return target

    archive = lib.archive_read_new()
    if not archive:
        raise DecodeError("limit")

    def checked(status):
        if status < 0:
            message = lib.archive_error_string(archive) or b""
            raise DecodeError("encrypted" if b"encrypt" in message.lower() else "invalid")
        return status

    try:
        if lib.archive_read_support_format_7zip(archive) < 0:
            raise DecodeError("unavailable")
        checked(lib.archive_read_set_read_callback(archive, read))
        checked(lib.archive_read_set_seek_callback(archive, seek))
        # 部分 libarchive 版本需要显式登记一个回调数据源，即使回调状态由闭包保存。
        checked(lib.archive_read_set_callback_data(archive, None))
        checked(lib.archive_read_open1(archive))
        entry, block = ptr(), ct.create_string_buffer(BLOCK_SIZE)
        while checked(lib.archive_read_next_header(archive, ct.byref(entry))) != 1:
            if lib.archive_entry_is_encrypted(entry) > 0:
                raise DecodeError("encrypted")
            raw = lib.archive_entry_pathname_utf8(entry)
            if not raw:
                raise DecodeError("invalid")
            if len(raw) > 4096:
                raise DecodeError("name")
            filetype = lib.archive_entry_filetype(entry)
            kind = {stat.S_IFREG: "file", stat.S_IFDIR: "dir"}.get(filetype, "special")
            if lib.archive_entry_hardlink(entry):
                kind = "special"
            entry_size = lib.archive_entry_size(entry) if kind == "file" else 0
            emit({"entry": [raw.decode("utf-8"), kind, entry_size]})
            command = sys.stdin.buffer.read(1)
            if command == b"s":
                checked(lib.archive_read_data_skip(archive))
            elif command == b"x" and kind == "file":
                while count := checked(lib.archive_read_data(archive, block, BLOCK_SIZE)):
                    emit({"data": count}, block[:count])
                emit({"end": True})
            else:
                raise DecodeError("invalid")
    finally:
        lib.archive_read_free(archive)


def main() -> None:
    try:
        if sys.platform != "win32":
            import resource
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            if sys.platform == "linux":
                memory = 256 * 1024 * 1024
                soft, _ = resource.getrlimit(resource.RLIMIT_AS)
                limit = min(soft, memory) if soft != resource.RLIM_INFINITY else memory
                resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        size = int(sys.stdin.buffer.readline(32))
        if not 0 < size < 2**63:
            raise DecodeError("invalid")
        extract(size)
        emit({"done": True})
    except DecodeError as exc:
        emit({"error": str(exc)})
    except MemoryError:
        emit({"error": "limit"})
    except (ValueError, OSError):
        emit({"error": "invalid"})


if __name__ == "__main__":
    main()
