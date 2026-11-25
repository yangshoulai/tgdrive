"""受限的 7z 解码进程。通过 stdin / stdout 随机读取归档并传回条目。"""

from __future__ import annotations

import ctypes as ct
from ctypes.util import find_library
import errno
import io
import json
import lzma
import stat
import struct
import sys

from .sevenzip import BLOCK_SIZE, MAX_MEMORY_LIMIT, MESSAGE_LIMIT, MIB

PY7ZR_OUTPUT_BLOCK = 4 * MIB


class DecodeError(Exception):
    pass


def emit(message: dict, data: bytes | memoryview = b"") -> None:
    sys.stdout.buffer.write(json.dumps(message, ensure_ascii=False).encode("utf-8") + b"\n")
    if data:
        sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


class RangeInput(io.RawIOBase):
    def __init__(self, size: int, memory_limit: int):
        self.size, self.position = size, 0
        self.memory_limit = memory_limit

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.position

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence not in (io.SEEK_SET, io.SEEK_CUR, io.SEEK_END):
            raise ValueError("invalid seek mode")
        target = (0, self.position, self.size)[whence] + offset
        if not 0 <= target <= self.size:
            raise ValueError("invalid seek position")
        self.position = target
        return target

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            raise DecodeError("invalid")
        end = min(self.position + size, self.size)
        # 合并读取分块时，分块与返回值会暂时各占一份内存。
        if end - self.position > self.memory_limit // 2:
            raise DecodeError("memory")
        pieces = []
        while self.position < end:
            stop = min(self.position + BLOCK_SIZE, end)
            emit({"read": [self.position, stop]})
            data = sys.stdin.buffer.read(stop - self.position)
            if len(data) != stop - self.position:
                raise DecodeError("invalid")
            pieces.append(data)
            self.position = stop
        return b"".join(pieces)


def select_entry(name: str, kind: str, size: int) -> bool:
    if not name or type(size) is not int or size < 0:
        raise DecodeError("invalid")
    if len(name.encode("utf-8")) > 4096:
        raise DecodeError("name")
    emit({"entry": [name, kind, size]})
    command = sys.stdin.buffer.read(1)
    if command == b"s":
        return False
    if command == b"x" and kind == "file":
        return True
    raise DecodeError("invalid")


def extract(source: RangeInput) -> None:
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
        "archive_errno": (ct.c_int, [ptr]),
        "archive_error_string": (ct.c_char_p, [ptr]),
    }
    try:
        lib = ct.CDLL(library)
        for name, (result, args) in signatures.items():
            function = getattr(lib, name)
            function.restype, function.argtypes = result, args
    except (OSError, AttributeError):
        raise DecodeError("unavailable") from None

    buffer = None
    out_of_memory = False

    @read_cb
    def read(_, __, output):
        nonlocal buffer, out_of_memory
        try:
            data = source.read(BLOCK_SIZE)
            if not data:
                return 0
            buffer = ct.create_string_buffer(data)
            output[0] = ct.cast(buffer, ptr)
            return len(data)
        except MemoryError:
            out_of_memory = True
            return -1
        except (DecodeError, OSError):
            return -1

    @seek_cb
    def seek(_, __, offset, mode):
        try:
            return source.seek(offset, mode)
        except ValueError:
            return -1

    archive = lib.archive_read_new()
    if not archive:
        raise DecodeError("memory")

    def checked(status):
        if status < 0:
            if out_of_memory or lib.archive_errno(archive) == errno.ENOMEM:
                raise DecodeError("memory")
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
            filetype = lib.archive_entry_filetype(entry)
            kind = {stat.S_IFREG: "file", stat.S_IFDIR: "dir"}.get(filetype, "special")
            if lib.archive_entry_hardlink(entry):
                kind = "special"
            entry_size = lib.archive_entry_size(entry) if kind == "file" else 0
            if select_entry(raw.decode("utf-8"), kind, entry_size):
                while count := checked(lib.archive_read_data(archive, block, BLOCK_SIZE)):
                    emit({"data": count}, block[:count])
                emit({"end": True})
            else:
                checked(lib.archive_read_data_skip(archive))
    finally:
        lib.archive_read_free(archive)


def extract_with_password(source: RangeInput, password: str) -> None:
    try:
        from py7zr import SevenZipFile, exceptions
        from py7zr import py7zr as reader
        from py7zr.io import MemIO, Py7zIO, WriterFactory
    except ImportError:
        raise DecodeError("aes_unavailable") from None
    # 固定版本的 py7zr 默认根据进程内存扩大每次输出，容易挤占大字典所需的内存。
    reader.get_memory_limit = lambda: PY7ZR_OUTPUT_BLOCK

    class EntryOutput(Py7zIO):
        def __init__(self, entry):
            if entry.is_symlink or entry.is_junction:
                kind = "special"
            elif entry.is_directory:
                kind = "dir"
            else:
                kind = "file" if entry.is_file else "special"
            self.limit, self.count = entry.uncompressed, 0
            self.selected = select_entry(entry.filename, kind, self.limit if kind == "file" else 0)
            if self.selected and self.limit and entry.crc32 is None:
                # 缺少条目 CRC 时，不能仅凭解出相同长度就提交 AES 解密结果。
                raise DecodeError("unchecked")

        def write(self, data: bytes | bytearray) -> int:
            self.count += len(data)
            if self.selected:
                if self.count > self.limit:
                    raise DecodeError("invalid")
                view = memoryview(data)
                for offset in range(0, len(view), BLOCK_SIZE):
                    chunk = view[offset:offset + BLOCK_SIZE]
                    emit({"data": len(chunk)}, chunk)
            return len(data)

        def read(self, size: int | None = None) -> bytes:
            raise DecodeError("invalid")

        def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
            raise DecodeError("invalid")

        def seekable(self) -> bool:
            return False

        def flush(self) -> None:
            pass

        def size(self) -> int:
            return self.count

        def close(self) -> None:
            # py7zr 只在条目解完且 CRC 校验成功后关闭写入器，主进程届时才结束对象上传。
            if self.selected:
                if self.count != self.limit:
                    raise DecodeError("invalid")
                emit({"end": True})

    class Entries(WriterFactory):
        def __init__(self, files):
            self.files = files

        def create(self, filename: str) -> Py7zIO:
            return EntryOutput(self.files[int(filename)])

    try:
        with SevenZipFile(source, "r", password=password) as archive:
            factory = Entries(archive.files)
            # 使用固定版本 py7zr 的成员编号，将每个条目直接绑定到管道写入器。
            # 归档路径始终由主进程校验和处理，重名、目录和链接沿用已有语义。
            for entry in archive.files:
                archive.worker.register_filelike(entry.id, MemIO(str(entry.id), factory))
            archive.worker.extract(source, None, parallel=False)
    except exceptions.PasswordRequired:
        raise DecodeError("encrypted") from None
    except exceptions.UnsupportedCompressionMethodError:
        raise DecodeError("unsupported") from None
    except (exceptions.ArchiveError, lzma.LZMAError, ValueError, EOFError, TypeError, IndexError, KeyError, struct.error):
        # 错密码与损坏的 AES 数据可能产生同一种解码错误，不外传第三方异常的内容。
        raise DecodeError("password") from None


def main() -> None:
    try:
        request = json.loads(sys.stdin.buffer.readline(MESSAGE_LIMIT))
        size, password, memory_limit = request["size"], request["password"], request["memory_limit"]
        if not (type(size) is int and 0 < size < 2**63
                and type(memory_limit) is int and 0 < memory_limit <= MAX_MEMORY_LIMIT
                and (password is None or isinstance(password, str) and 0 < len(password) <= 1024)):
            raise DecodeError("invalid")
        if sys.platform != "win32":
            import resource
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            if sys.platform == "linux":
                limits = (resource.RLIMIT_AS, resource.RLIMIT_DATA) if password is not None else (resource.RLIMIT_AS,)
                for resource_id in limits:
                    soft, _ = resource.getrlimit(resource_id)
                    if soft != resource.RLIM_INFINITY:
                        memory_limit = min(soft, memory_limit)
                    resource.setrlimit(resource_id, (memory_limit, memory_limit))
        source = RangeInput(size, memory_limit)
        if password is None:
            extract(source)
        else:
            extract_with_password(source, password)
        emit({"done": True})
    except DecodeError as exc:
        emit({"error": str(exc)})
    except MemoryError:
        emit({"error": "memory"})
    except OSError as exc:
        emit({"error": "memory" if exc.errno == errno.ENOMEM else "invalid"})
    except (ValueError, KeyError, TypeError):
        emit({"error": "invalid"})


if __name__ == "__main__":
    main()
