"""歌词与字幕文本：解码、格式识别与规范化（ASS／SSA 转 SRT，压缩包里取出字幕）。

保存到网盘的只有播放器能直接读取的格式：歌词为 LRC，字幕为 SRT 或 WebVTT。
"""

from __future__ import annotations

import io
import re
import zipfile

from .providers.base import Fetched, ProviderError

TEXT_LIMIT = 5 * 1024 * 1024
SUBTITLE_EXTENSIONS = (".srt", ".vtt", ".ass", ".ssa")
# ZIP 内优先选择的字幕：简体中文、繁体、双语，其次是任何字幕。
_PREFERRED = (r"chs|sc|简|zh[-_.]?(?:cn|hans)|gb", r"cht|tc|繁|zh[-_.]?(?:tw|hk|hant)|big5", r"双语|chs.?eng|中英")


def decode(data: bytes) -> str:
    """字幕常是 GBK／UTF-16：按 BOM、严格 UTF-8、GB18030、Big5 依次尝试。"""
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace")
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", errors="replace")
    for encoding in ("utf-8", "gb18030", "big5"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def detect(text: str) -> str | None:
    head = text.lstrip()[:4096]
    if head.startswith("WEBVTT"):
        return "vtt"
    if re.search(r"^\[Script Info\]", head, re.MULTILINE | re.IGNORECASE) or re.search(r"^Dialogue:", text[:65536], re.MULTILINE):
        return "ass"
    if re.search(r"\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}", head):
        return "srt"
    if len(re.findall(r"^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]", head, re.MULTILINE)) >= 2:
        return "lrc"
    return None


def _ass_time(value: str) -> str:
    hours, minutes, rest = value.strip().split(":")
    seconds, _, centis = rest.partition(".")
    millis = int((centis + "00")[:3]) if centis else 0
    return f"{int(hours):02d}:{int(minutes):02d}:{int(seconds):02d},{millis:03d}"


def ass_to_srt(text: str) -> str:
    """只保留对白文字：去掉样式与特效标签，\\N 换行；按开始时间排序。"""
    fields: list[str] | None = None
    events = []
    section = ""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped.lower()
            continue
        if section != "[events]":
            continue
        if stripped.lower().startswith("format:"):
            fields = [item.strip().lower() for item in stripped[7:].split(",")]
            continue
        if not stripped.lower().startswith("dialogue:"):
            continue
        names = fields or ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"]
        values = stripped[9:].strip().split(",", len(names) - 1)
        if len(values) < len(names):
            continue
        row = dict(zip(names, values))
        body = re.sub(r"\{[^}]*\}", "", row.get("text", ""))
        body = body.replace("\\N", "\n").replace("\\n", "\n").replace("\\h", " ").strip()
        if not body:
            continue
        try:
            events.append((_ass_time(row["start"]), _ass_time(row["end"]), body))
        except (KeyError, ValueError):
            continue
    if not events:
        raise ProviderError("字幕文件里没有可用的对白")
    events.sort(key=lambda item: item[0])
    return "\n".join(f"{index}\n{start} --> {end}\n{body}\n" for index, (start, end, body) in enumerate(events, 1))


def pick_subtitle(names: list[str]) -> str | None:
    subtitles = [name for name in names if name.lower().endswith(SUBTITLE_EXTENSIONS) and not name.startswith("__MACOSX/")]
    for pattern in _PREFERRED:
        for name in subtitles:
            if re.search(pattern, name, re.IGNORECASE):
                return name
    return subtitles[0] if subtitles else None


def unpack(data: bytes, name: str | None = None) -> tuple[bytes, str | None]:
    """字幕站常以压缩包分发：ZIP 在内存里取出一个字幕文件；RAR、7z 不支持。"""
    if data[:4] == b"PK\x03\x04":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                chosen = pick_subtitle([item.filename for item in archive.infolist() if not item.is_dir()])
                if chosen is None:
                    raise ProviderError("压缩包里没有字幕文件")
                info = archive.getinfo(chosen)
                if info.file_size > TEXT_LIMIT:
                    raise ProviderError("压缩包里的字幕超过 5 MB")
                with archive.open(info) as handle:
                    return handle.read(TEXT_LIMIT + 1)[:TEXT_LIMIT], chosen.rsplit("/", 1)[-1]
        except zipfile.BadZipFile as exc:
            raise ProviderError("字幕压缩包已损坏") from exc
    if data[:4] == b"Rar!" or data[:6] == b"7z\xbc\xaf\x27\x1c":
        raise ProviderError("这个字幕以 RAR 或 7z 压缩包提供，暂不支持，请换一个")
    return data, name


def normalize_lyrics(text: str) -> Fetched:
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise ProviderError("没有歌词内容")
    return Fetched(text=text + "\n", format="lrc")


def normalize_subtitle(data: bytes, name: str | None = None) -> Fetched:
    data, name = unpack(data, name)
    text = decode(data).replace("\r\n", "\n").replace("\r", "\n")
    kind = detect(text)
    if kind == "ass":
        return Fetched(text=ass_to_srt(text), format="srt", name=name)
    if kind in ("srt", "vtt"):
        return Fetched(text=text.strip() + "\n", format=kind, name=name)
    raise ProviderError("不是可识别的字幕格式（支持 SRT、WebVTT、ASS）")


def merge_translation(original: str, translation: str) -> str:
    """把同一时间戳的译文放在原文下一行（播放器按时间戳分组，小窗只显示第一行）。"""
    stamp = re.compile(r"^((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+)(.*)$")
    translated: dict[str, str] = {}
    for line in translation.splitlines():
        match = stamp.match(line.strip())
        if match and match.group(2).strip():
            for tag in re.findall(r"\[[^\]]+\]", match.group(1)):
                translated[_stamp_key(tag)] = match.group(2).strip()
    if not translated:
        return original
    lines = []
    for line in original.splitlines():
        lines.append(line)
        match = stamp.match(line.strip())
        if match and match.group(2).strip():
            tag = re.findall(r"\[[^\]]+\]", match.group(1))[0]
            value = translated.get(_stamp_key(tag))
            if value and value != match.group(2).strip():
                lines.append(tag + value)
    return "\n".join(lines)


def _stamp_key(tag: str) -> str:
    match = re.match(r"\[(\d+):(\d+)(?:[.:](\d+))?\]", tag)
    if not match:
        return tag
    minutes, seconds, fraction = match.groups()
    return f"{int(minutes) * 60 + int(seconds)}.{(fraction or '0').ljust(3, '0')[:2]}"


def preview(text: str, lines: int = 6) -> str:
    rows = []
    for line in text.splitlines():
        line = re.sub(r"^(\[[^\]]*\])+", "", line).strip()
        if not line or re.fullmatch(r"\d+|[\d:,.]+\s*-->\s*[\d:,.]+.*|WEBVTT.*", line) or re.match(r"^(ti|ar|al|by|offset|length|re|ve):", line):
            continue
        rows.append(line)
        if len(rows) >= lines:
            break
    return "\n".join(rows)
