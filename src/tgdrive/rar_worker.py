"""仅在受限解码子进程中加载 RAR 解码库。"""

from __future__ import annotations

import ctypes as ct
import os

from .sevenzip import BLOCK_SIZE, RAR_SIGNATURES

LIBRARY = "/usr/local/lib/tessera/libtgdrive-rar.so"
READ = ct.CFUNCTYPE(ct.c_int, ct.c_uint64, ct.c_void_p, ct.c_uint32)
ENTRY = ct.CFUNCTYPE(ct.c_int, ct.c_void_p, ct.c_uint32, ct.c_int, ct.c_uint64)
WRITE = ct.CFUNCTYPE(ct.c_int, ct.c_void_p, ct.c_uint32)
FINISH = ct.CFUNCTYPE(ct.c_int)
RESULTS = (None, "invalid", "encrypted", "password", "missing", "unsupported", "memory")


class Callbacks(ct.Structure):
    _fields_ = [("read", READ), ("entry", ENTRY), ("write", WRITE), ("finish", FINISH)]


def extract_rar(source, volumes: list[int], numbered: bool, password: str | None, select_entry, emit) -> str | None:
    head = source.read(min(8, volumes[0]))
    if not head.startswith(RAR_SIGNATURES):
        return "invalid"
    try:
        library = ct.CDLL(os.environ.get("TGDRIVE_RAR_LIBRARY") or LIBRARY)
        extract = library.tessera_extract_rar
    except (OSError, AttributeError):
        return "unavailable"
    extract.argtypes = (ct.POINTER(ct.c_uint64), ct.c_uint32, ct.c_int, ct.c_int, ct.c_char_p, ct.POINTER(Callbacks))
    extract.restype = ct.c_int

    failure: Exception | None = None

    def callback(signature):
        def register(fn):
            @signature
            def call(*args):
                nonlocal failure
                if failure is not None:
                    return -1
                try:
                    return fn(*args)
                except Exception as exc:  # noqa: BLE001
                    # ctypes 无法传递回调异常，先让原生解码停止，退出后重新抛出。
                    failure = exc
                    return -1
            return call
        return register

    @callback(READ)
    def read(offset, buffer, size):
        source.seek(offset)
        data = source.read(size)
        if len(data) != size:
            return -1
        ct.memmove(buffer, data, size)
        return 0

    @callback(ENTRY)
    def entry(name, length, kind, size):
        # 先限制从原生缓冲区复制的字节数；共享入口负责返回文件名过长的错误。
        name = ct.string_at(name, min(length, 4097)).decode("utf-8", "replace")
        return int(select_entry(name, ("file", "dir", "special")[kind], size))

    @callback(WRITE)
    def write(buffer, size):
        for offset in range(0, size, BLOCK_SIZE):
            count = min(BLOCK_SIZE, size - offset)
            emit({"data": count}, ct.string_at(buffer + offset, count))
        return 0

    @callback(FINISH)
    def finish():
        emit({"end": True})
        return 0

    sizes = (ct.c_uint64 * len(volumes))(*volumes)
    args = Callbacks(read, entry, write, finish)
    result = extract(sizes, len(volumes), head == RAR_SIGNATURES[1], numbered,
                     password.encode("utf-8") if password else None, ct.byref(args))
    if failure is not None:
        raise failure
    return RESULTS[result] if 0 <= result < len(RESULTS) else "invalid"
