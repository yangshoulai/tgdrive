"""受限书籍解析器：仅通过父进程读取字节，不解压到磁盘、不访问网络。

ZIP 使用标准库并只解所需条目；RAR 使用 libarchive 的范围读取回调，原生解压与主服务隔离。
"""

from __future__ import annotations

import base64
import ctypes as ct
import ctypes.util
import io
import json
import posixpath
import re
import struct
import sys
import zipfile
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit
from xml.parsers import expat

from .book_covers import MAX_COVER, MAX_READ, READ_CHUNK

MAX_XML = 2 * 1024 * 1024
MAX_ENTRIES = 50_000
RASTER = re.compile(r"\.(jpe?g|png|gif|webp|bmp|avif)$", re.I)


class Failure(Exception):
    def __init__(self, code="invalid"):
        self.code = code


def emit(value):
    sys.stdout.buffer.write(json.dumps(value, separators=(",", ":")).encode() + b"\n")
    sys.stdout.buffer.flush()


class RangeFile(io.RawIOBase):
    def __init__(self, size):
        self.size, self.position, self.consumed = size, 0, 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        target = offset + (self.position if whence == 1 else self.size if whence == 2 else 0)
        if whence not in (0, 1, 2) or not 0 <= target <= self.size:
            raise Failure()
        self.position = target
        return target

    def read(self, length=-1):
        length = min(self.size - self.position, length if length >= 0 else self.size)
        if length > MAX_COVER + MAX_XML or self.consumed + length > MAX_READ:
            raise Failure("limit")
        pieces = []
        while length:
            count = min(READ_CHUNK, length)
            emit({"read": [self.position, self.position + count]})
            header = sys.stdin.buffer.read(4)
            if len(header) != 4 or struct.unpack(">I", header)[0] != count:
                raise Failure()
            data = sys.stdin.buffer.read(count)
            if len(data) != count:
                raise Failure()
            pieces.append(data)
            self.position += count
            self.consumed += count
            length -= count
        return b"".join(pieces)

    def at(self, start, end):
        self.seek(start)
        return self.read(end - start)


def safe_name(name):
    if "\\" in name or "\0" in name or name.startswith("/"):
        return None
    parts = PurePosixPath(name).parts
    if any(part in ("..", "__MACOSX") or part.startswith(".") for part in parts):
        return None
    return posixpath.normpath(name) if parts else None


def resource_path(base, href):
    parsed = urlsplit(href)
    if parsed.scheme or parsed.netloc or not parsed.path:
        raise Failure("unsupported")
    path = safe_name(posixpath.normpath(posixpath.join(posixpath.dirname(base), unquote(parsed.path))))
    if not path:
        raise Failure()
    return path


def xml_tree(data):
    # Expat 不构建正文树，只为有界的 OPF／导航／ComicInfo 构建最小节点结构；拒绝 DTD 和实体。
    parser = expat.ParserCreate(namespace_separator="}")
    root, stack = [], []

    def start(name, attrs):
        if len(stack) >= 128:
            raise Failure("limit")
        node = (name.rsplit("}", 1)[-1], {key.rsplit("}", 1)[-1]: value for key, value in attrs.items()}, [])
        (stack[-1][2] if stack else root).append(node)
        stack.append(node)

    def reject(*_):
        raise Failure("unsupported")

    parser.StartElementHandler = start
    parser.EndElementHandler = lambda _: stack.pop()
    parser.StartDoctypeDeclHandler = reject
    parser.EntityDeclHandler = reject
    parser.ExternalEntityRefHandler = reject
    parser.Parse(data, True)
    if len(root) != 1:
        raise Failure()
    return root[0]


def nodes(node, name):
    if node[0] == name:
        yield node
    for child in node[2]:
        yield from nodes(child, name)


def natural(name):
    return [(0, int(part)) if part.isdecimal() else (1, part.casefold()) for part in re.split(r"(\d+)", name)]


def comic_cover(names, comic_info):
    pictures = sorted((name for name in names if RASTER.search(name)), key=natural)
    if not pictures:
        return None
    if comic_info:
        for _, attrs, _ in nodes(xml_tree(comic_info), "Page"):
            if "frontcover" in {value.strip() for value in attrs.get("Type", "").lower().split(",")}:
                index = int(attrs.get("Image", "-1"))
                if 0 <= index < len(pictures):
                    return pictures[index]
    return pictures[0]


def zip_cover(source, comic):
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_ENTRIES:
            raise Failure("limit")
        files = {}
        for entry in entries:
            name = safe_name(entry.filename)
            # 不跟随归档内链接，也不从重复路径中任意选取一份内容。
            if not name or entry.is_dir() or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                continue
            if name in files:
                raise Failure()
            files[name] = entry

        def read(name, limit=MAX_XML):
            entry = files.get(name)
            if entry is None:
                raise Failure()
            if entry.flag_bits & 1:
                raise Failure("encrypted")
            if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise Failure("unsupported")
            if entry.file_size > limit or entry.compress_size > MAX_COVER:
                raise Failure("limit")
            with archive.open(entry) as member:
                data = member.read(limit + 1)
            if len(data) > limit or len(data) != entry.file_size:
                raise Failure("limit")
            return data

        if comic:
            info = next((name for name in files if name.casefold() == "comicinfo.xml"), None)
            cover = comic_cover(files, read(info) if info else None)
            return read(cover, MAX_COVER) if cover else None
        container = xml_tree(read("META-INF/container.xml"))
        if container[0] != "container":
            raise Failure()
        root = next(nodes(container, "rootfile"), None)
        if root is None:
            raise Failure()
        package = resource_path("", root[1].get("full-path", ""))
        tree = xml_tree(read(package))
        if tree[0] != "package":
            raise Failure()
        items = list(nodes(tree, "item"))
        cover = next((item for item in items if "cover-image" in item[1].get("properties", "").split()), None)
        if cover is None:
            meta = next((item for item in nodes(tree, "meta") if item[1].get("name", "").lower() == "cover"), None)
            cover = next((item for item in items if meta and item[1].get("id") == meta[1].get("content")), None)
        if cover is not None:
            path = resource_path(package, cover[1].get("href", ""))
        else:
            guide = next((item for item in nodes(tree, "reference") if item[1].get("type", "").lower() == "cover"), None)
            if guide is None:
                return None
            path = resource_path(package, guide[1].get("href", ""))
        # 常见的封面 XHTML／SVG 包装页只引用一张本地位图，不执行脚本或加载外部资源。
        if not RASTER.search(path):
            wrapper = xml_tree(read(path))
            images = [item for name in ("img", "image") for item in nodes(wrapper, name)]
            if len(images) != 1:
                raise Failure("unsupported")
            path = resource_path(path, images[0][1].get("src", images[0][1].get("href", "")))
            if not RASTER.search(path):
                raise Failure("unsupported")
        return read(path, MAX_COVER)


def mobi_cover(source):
    head = source.at(0, min(78, source.size))
    if len(head) != 78 or head[60:68].upper() not in (b"BOOKMOBI", b"TEXTREAD"):
        raise Failure()
    count = struct.unpack_from(">H", head, 76)[0]
    if not count or 78 + count * 8 > source.size:
        raise Failure()
    table = source.at(78, 78 + count * 8)
    offsets = [struct.unpack_from(">I", table, i * 8)[0] for i in range(count)] + [source.size]
    if offsets[0] < 78 + count * 8 or any(a > b for a, b in zip(offsets, offsets[1:])):
        raise Failure()

    def header(index):
        start, end = offsets[index:index + 2]
        data = source.at(start, min(end, start + 132))
        if data[16:20] != b"MOBI" or len(data) < 132:
            raise Failure()
        length = struct.unpack_from(">I", data, 20)[0]
        if length < 116 or length > MAX_XML or start + 16 + length > end:
            raise Failure()
        first_image = struct.unpack_from(">I", data, 108)[0]
        exth = source.at(start + 16 + length, min(end, start + 16 + length + 12))
        records = {}
        if exth[:4] == b"EXTH":
            total, number = struct.unpack_from(">II", exth, 4)
            if total < 12 or total > MAX_XML or number > MAX_ENTRIES or start + 16 + length + total > end:
                raise Failure("limit")
            block = source.at(start + 16 + length, start + 16 + length + total)
            pos = 12
            for _ in range(number):
                if pos + 8 > total:
                    raise Failure()
                kind, size = struct.unpack_from(">II", block, pos)
                if size < 8 or pos + size > total:
                    raise Failure()
                records[kind] = block[pos + 8:pos + size]
                pos += size
        return first_image, records

    first_image, records = header(0)
    # 双格式 MOBI 的 KF8 头可能带单独的封面索引；没有明确封面索引时不把插图误当封面。
    if 201 not in records and len(records.get(121, b"")) == 4:
        kf8 = struct.unpack(">I", records[121])[0]
        if 0 < kf8 < count and offsets[kf8] - offsets[kf8 - 1] == 8 and source.at(offsets[kf8 - 1], offsets[kf8]) == b"BOUNDARY":
            kf8_image, records = header(kf8)
            # 双格式通常共用 MOBI6 的图片区；仅 KF8 自有图片时索引相对 KF8 头。
            if first_image == 0xFFFFFFFF:
                first_image = kf8 + kf8_image if kf8_image != 0xFFFFFFFF else 0xFFFFFFFF
    offset = next((value for kind in (201, 202) if (value := records.get(kind)) is not None and value != b"\xff" * 4), None)
    if offset is None or first_image == 0xFFFFFFFF:
        return None
    if len(offset) != 4:
        raise Failure()
    index = first_image + struct.unpack(">I", offset)[0]
    if not 0 <= index < count:
        raise Failure()
    start, end = offsets[index:index + 2]
    if end - start > MAX_COVER:
        raise Failure("limit")
    return source.at(start, end)


def fb2_cover(source):
    parser = expat.ParserCreate(namespace_separator="}")
    stack, encoded, target = [], [], None
    collecting, encoded_size = False, 0

    class Found(Exception):
        pass

    def start(name, attrs):
        nonlocal target, collecting
        name = name.rsplit("}", 1)[-1]
        if not stack and name != "FictionBook":
            raise Failure()
        if len(stack) >= 128:
            raise Failure("limit")
        stack.append(name)
        if name == "image" and "coverpage" in stack and target is None:
            href = next((value for key, value in attrs.items() if key.rsplit("}", 1)[-1] == "href"), "")
            if href.startswith("#"):
                target = href[1:]
        if name == "binary" and target and attrs.get("id") == target:
            collecting = True

    def end(name):
        nonlocal collecting
        if name.rsplit("}", 1)[-1] == "binary" and collecting:
            raise Found()
        stack.pop()

    def chars(text):
        nonlocal encoded_size
        if collecting:
            text = "".join(text.split())
            encoded_size += len(text)
            if encoded_size > (MAX_COVER + 2) // 3 * 4:
                raise Failure("limit")
            encoded.append(text)

    def reject(*_):
        raise Failure("unsupported")

    parser.StartElementHandler, parser.EndElementHandler, parser.CharacterDataHandler = start, end, chars
    parser.StartDoctypeDeclHandler = parser.EntityDeclHandler = parser.ExternalEntityRefHandler = reject
    source.seek(0)
    try:
        while chunk := source.read(min(64 * 1024, source.size - source.tell())):
            parser.Parse(chunk, False)
        parser.Parse(b"", True)
    except Found:
        data = base64.b64decode("".join(encoded), validate=True)
        if not data or len(data) > MAX_COVER:
            raise Failure("limit")
        return data
    return None


def rar_cover(source):
    name = ctypes.util.find_library("archive")
    if not name:
        raise Failure("rar_unavailable")
    try:
        lib = ct.CDLL(name)
    except OSError:
        raise Failure("rar_unavailable") from None
    ptr, number = ct.c_void_p, ct.c_longlong
    read_cb = ct.CFUNCTYPE(ct.c_ssize_t, ptr, ptr, ct.POINTER(ptr))
    skip_cb = ct.CFUNCTYPE(number, ptr, ptr, number)
    seek_cb = ct.CFUNCTYPE(number, ptr, ptr, number, ct.c_int)
    signatures = {
        "archive_read_new": (ptr, []), "archive_read_free": (ct.c_int, [ptr]),
        "archive_read_support_format_rar": (ct.c_int, [ptr]),
        "archive_read_support_format_rar5": (ct.c_int, [ptr]),
        "archive_read_set_read_callback": (ct.c_int, [ptr, read_cb]),
        "archive_read_set_skip_callback": (ct.c_int, [ptr, skip_cb]),
        "archive_read_set_seek_callback": (ct.c_int, [ptr, seek_cb]),
        "archive_read_set_callback_data": (ct.c_int, [ptr, ptr]),
        "archive_read_open1": (ct.c_int, [ptr]),
        "archive_read_next_header": (ct.c_int, [ptr, ct.POINTER(ptr)]),
        "archive_read_data": (ct.c_ssize_t, [ptr, ptr, ct.c_size_t]),
        "archive_read_data_skip": (ct.c_int, [ptr]),
        "archive_entry_pathname_utf8": (ct.c_char_p, [ptr]),
        "archive_entry_pathname": (ct.c_char_p, [ptr]),
        "archive_entry_filetype": (ct.c_uint, [ptr]),
        "archive_entry_size": (number, [ptr]),
        "archive_entry_is_encrypted": (ct.c_int, [ptr]),
        "archive_entry_hardlink": (ct.c_char_p, [ptr]),
    }
    try:
        for func, (result, args) in signatures.items():
            getattr(lib, func).restype, getattr(lib, func).argtypes = result, args
    except AttributeError:
        raise Failure("rar_unavailable") from None

    def scan(chosen=None):
        source.seek(0)
        buffer, error = None, None

        def read(_, __, output):
            nonlocal buffer, error
            try:
                data = source.read(min(64 * 1024, source.size - source.tell()))
                buffer = ct.create_string_buffer(data)
                output[0] = ct.cast(buffer, ptr)
                return len(data)
            except Exception as reason:
                error = reason
                return -1

        def seek(_, __, offset, whence):
            nonlocal error
            try:
                return source.seek(offset, whence)
            except Exception as reason:
                error = reason
                return -1

        def skip(_, __, offset):
            before = source.tell()
            return seek(None, None, min(max(0, offset), source.size - before), 1) - before

        callbacks = read_cb(read), skip_cb(skip), seek_cb(seek)
        archive = lib.archive_read_new()

        def checked(code):
            if error:
                raise error
            if code < 0:
                raise Failure("rar_unsupported")
            return code

        def data(limit):
            pieces, length = [], 0
            block = ct.create_string_buffer(64 * 1024)
            while count := checked(lib.archive_read_data(archive, block, len(block))):
                length += count
                if length > limit:
                    raise Failure("limit")
                pieces.append(block.raw[:count])
            return b"".join(pieces)

        files, info, entry = {}, None, ptr()
        try:
            checked(lib.archive_read_support_format_rar(archive))
            checked(lib.archive_read_support_format_rar5(archive))
            lib.archive_read_set_read_callback(archive, callbacks[0])
            lib.archive_read_set_skip_callback(archive, callbacks[1])
            lib.archive_read_set_seek_callback(archive, callbacks[2])
            # 即使上下文由闭包持有，也必须登记一个数据源；否则部分 libarchive 版本会解引用空列表。
            checked(lib.archive_read_set_callback_data(archive, None))
            checked(lib.archive_read_open1(archive))
            for _ in range(MAX_ENTRIES + 1):
                if checked(lib.archive_read_next_header(archive, ct.byref(entry))) == 1:
                    if chosen:
                        raise Failure()
                    return files, info
                raw = lib.archive_entry_pathname_utf8(entry) or lib.archive_entry_pathname(entry)
                name = safe_name(raw.decode("utf-8", "replace")) if raw else None
                if name and lib.archive_entry_filetype(entry) == 0o100000 and not lib.archive_entry_hardlink(entry):
                    if name in files:
                        raise Failure()
                    files[name] = lib.archive_entry_size(entry)
                    if lib.archive_entry_is_encrypted(entry) > 0:
                        raise Failure("encrypted")
                    if name == chosen or chosen is None and name.casefold() == "comicinfo.xml":
                        limit = MAX_COVER if chosen else MAX_XML
                        if not 0 <= files[name] <= limit:
                            raise Failure("limit")
                        content = data(limit)
                        if len(content) != files[name]:
                            raise Failure()
                        if chosen:
                            return content
                        info = content
                checked(lib.archive_read_data_skip(archive))
            raise Failure("limit")
        finally:
            lib.archive_read_free(archive)

    files, info = scan()
    chosen = comic_cover(files, info)
    return scan(chosen) if chosen else None


def main():
    try:
        # 原生 RAR 解压的内存和 CPU 也留在子进程，不影响主服务；墙钟超时与取消由父进程回收。
        try:
            import resource
            resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
            if sys.platform == "linux":
                resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
        except (ImportError, ValueError, OSError):
            pass
        request = json.loads(sys.stdin.buffer.readline(4096))
        source = RangeFile(request["size"])
        suffix = request["key"].rsplit(".", 1)[-1].lower()
        mime = (request.get("type") or "").partition(";")[0].strip().lower()
        head = source.at(0, min(8, source.size))
        if head[:2] == b"PK":
            comic = suffix == "cbz" or mime in ("application/vnd.comicbook+zip", "application/x-cbz")
            cover = zip_cover(source, comic)
        elif head[:7] == b"Rar!\x1a\x07\x00" or head == b"Rar!\x1a\x07\x01\x00":
            cover = rar_cover(source)
        elif suffix == "fb2" or "fictionbook" in mime:
            cover = fb2_cover(source)
        else:
            cover = mobi_cover(source)
        if cover is not None and not 0 < len(cover) <= MAX_COVER:
            raise Failure("limit")
        emit({"cover": len(cover) if cover else 0})
        if cover:
            sys.stdout.buffer.write(cover)
            sys.stdout.buffer.flush()
    except Failure as reason:
        emit({"error": reason.code})
    except (NotImplementedError, zipfile.BadZipFile, expat.ExpatError, ValueError, EOFError, OSError, RuntimeError, struct.error):
        emit({"error": "invalid"})


if __name__ == "__main__":
    main()
