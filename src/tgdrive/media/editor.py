"""媒体元数据写回：流复制、临时输出、读回检查、条件提交；不把完整媒体放进内存。"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import os
import secrets
import shutil
import struct
import tempfile
import time
from dataclasses import dataclass, field, replace
from pathlib import Path

from ..errors import NotFoundError, VersionConflict
from .tags import FIELD_LIMIT, READ_BUDGET, _id3_text, _split_terminated, _year

TEXT_FIELDS = {"title", "artist", "album", "album_artist", "track", "year", "genre"}
FIELDS = TEXT_FIELDS | {"lyrics", "subtitle"}
FORMATS = {"mp3": ("mp3", "mp3"), "flac": ("flac", "flac"), "mp4": ("mov", "mp4"), "wav": ("wav", "wav"), "matroska": ("matroska", "matroska")}
ID3_FIELDS = {"title": b"TIT2", "artist": b"TPE1", "album": b"TALB", "album_artist": b"TPE2", "track": b"TRCK", "year": b"TYER", "genre": b"TCON"}
LYRICS_BUFFER = "tessera_lyrics_buffer"


def mp3_lyrics_frames(lyrics):
    frames = []
    for text, language in lyrics:
        if not text.strip():
            continue
        language = {"zh": "zho", "en": "eng", "ja": "jpn", "ko": "kor"}.get(language, language or "und")
        if len(language) != 3 or not language.isascii() or not language.isalpha():
            language = "und"
        body = b"\x01" + language.encode() + b"\xff\xfe\x00\x00" + text.encode("utf-16")
        frames.append(b"USLT" + struct.pack(">I", len(body)) + b"\x00\x00" + body)
    return b"".join(frames)


def id3_text_frames(fields):
    result = b""
    for key, value in fields.items():
        if key in ID3_FIELDS and value:
            body = b"\x01" + value.encode("utf-16")
            result += ID3_FIELDS[key] + struct.pack(">I", len(body)) + b"\x00\x00" + body
    return result


def append_wav_tags(path, frames):
    """WAV INFO 无法容纳歌词和图片，附上标准 ID3 块并更新 RIFF 长度。"""
    size = path.stat().st_size
    chunk = b"id3 " + struct.pack("<I", len(frames) + 10)
    header = b"ID3\x03\x00\x00" + bytes((len(frames) >> shift) & 127 for shift in (21, 14, 7, 0))
    data = chunk + header + frames + (b"\x00" if len(frames) & 1 else b"")
    if size + len(data) - 8 > 0xFFFFFFFF:
        raise ValueError("WAV 写回暂支持 4 GB 以内的 RIFF 文件")
    with path.open("r+b") as handle:
        if handle.read(4) != b"RIFF":
            raise ValueError("WAV 容器格式不正确")
        handle.seek(0, 2); handle.write(data)
        handle.seek(4); handle.write(struct.pack("<I", size + len(data) - 8))


def write_mp3_lyrics(path, frames, fields=None):
    """歌词写标准 USLT、文本写 Unicode，避免 FFmpeg 的标签兼容性与旧编码问题。

    封装时预留了标签空间，这里只原位改文件头，不移动或读取音频数据。
    """
    with path.open("r+b") as handle:
        header = handle.read(10)
        if header[:4] != b"ID3\x03" or header[5] != 0:
            raise ValueError("生成的 MP3 标签格式不正确")
        size = sum((byte & 127) << shift for byte, shift in zip(header[6:10], (21, 14, 7, 0)))
        if size > READ_BUDGET:
            raise ValueError("MP3 标签超过处理上限")
        original = handle.read(size)
        kept, cursor = [], 0
        while cursor + 10 <= len(original) and original[cursor] != 0:
            name = original[cursor:cursor + 4]
            length = int.from_bytes(original[cursor + 4:cursor + 8], "big")
            end = cursor + 10 + length
            if end > len(original):
                raise ValueError("MP3 标签内容不完整")
            remove = name in (b"USLT", b"SYLT")
            if fields:
                remove |= name in {ID3_FIELDS[key] for key in fields if key in ID3_FIELDS}
                remove |= "year" in fields and name in (b"TDRC", b"TDOR")
            if name == b"TXXX" and length:
                body = original[cursor + 10:end]
                descriptor, _ = _split_terminated(body[0], body[1:])
                descriptor = _id3_text(body[0], descriptor).strip().lower()
                remove = descriptor.startswith("lyrics") or descriptor in ("uslt", "unsyncedlyrics", LYRICS_BUFFER)
            if not remove:
                kept.append(original[cursor:end])
            cursor = end
        data = b"".join(kept) + frames
        if len(data) > size:
            raise ValueError("MP3 歌词标签空间不足")
        handle.seek(10)
        handle.write(data + b"\x00" * (size - len(data)))


def metadata_text(values):
    def escape(value):
        return str(value).replace("\\", "\\\\").replace("=", "\\=").replace(";", "\\;").replace("#", "\\#").replace("\n", "\\\n")
    return ";FFMETADATA1\n" + "".join(f"{escape(key)}={escape(value)}\n" for key, value in values.items())


def lyric_keys(text):
    """只读全局标签名，合并转义换行，避免把歌词正文当成标签名。"""
    logical = ""
    for line in text.splitlines():
        logical += line
        slashes = len(line) - len(line.rstrip("\\"))
        if slashes % 2:
            logical = logical[:-1] + "\n"
            continue
        if logical.startswith("["):
            break
        key, escaped = "", False
        for char in logical:
            if escaped:
                key += char; escaped = False
            elif char == "\\":
                escaped = True
            elif char == "=":
                if key.lower().startswith("lyrics") or key.lower() in ("unsyncedlyrics", "unsynced lyrics", "syncedlyrics"):
                    yield key
                break
            else:
                key += char
        logical = ""


@dataclass
class EditJob:
    id: str
    bucket: int
    key: str
    etag: str
    size: int
    state: str = "queued"
    read: int = 0
    stored: int = 0
    detail: str = "等待更新元数据"
    finished: float = 0
    result: dict | None = None
    task: asyncio.Task | None = field(default=None, repr=False)

    def public(self):
        return {name: getattr(self, name) for name in ("id", "state", "read", "stored", "size", "detail", "result")} | {"path": self.key}


class AudioEditor:
    MAX_JOBS = 32
    KEEP = 3600
    TIMEOUT = 3600
    COVER_LIMIT = 5 * 1024 * 1024
    REQUEST_LIMIT = 8 * 1024 * 1024

    def __init__(self, media):
        self.media = media
        self.jobs = {}
        self.slot = asyncio.Semaphore(1)

    @staticmethod
    def supported(info, record, ffmpeg):
        return bool(ffmpeg and record.get("container") in FORMATS and info.key.lower().endswith((".mp3", ".flac", ".m4a", ".wav", ".mp4", ".m4v", ".mov", ".mkv", ".webm")))

    def validate(self, payload):
        fields = payload.get("fields", {})
        if not isinstance(fields, dict) or set(fields) - FIELDS:
            raise ValueError("元数据包含不支持的字段")
        result = {}
        for key, value in fields.items():
            limit = FIELD_LIMIT // 2 if key in ("lyrics", "subtitle") else 512
            if (not isinstance(value, str) or "\x00" in value or len(value.encode()) > limit
                    or key == "lyrics" and len(value.encode("utf-16")) + 8 > FIELD_LIMIT):
                raise ValueError("歌词或字幕最多 512 KB，其他元数据每项最多 512 字节，不能含空字符")
            result[key] = value.replace("\r\n", "\n").replace("\r", "\n") if key == "lyrics" else value.strip()
        cover = payload.get("cover", "keep")
        picture = None
        if cover not in ("keep", "remove"):
            from ..thumbnails import image_mime
            if not isinstance(cover, str) or len(cover) > self.COVER_LIMIT * 4 // 3 + 256:
                raise ValueError("内置封面最多 5 MB")
            try:
                picture = base64.b64decode(cover, validate=True)
            except (ValueError, binascii.Error):
                raise ValueError("封面数据不正确") from None
            if len(picture) > self.COVER_LIMIT or image_mime(picture) not in ("image/jpeg", "image/png"):
                raise ValueError("内置封面仅支持 5 MB 以内的 JPEG 或 PNG 图片")
        if not result and cover == "keep":
            raise ValueError("没有需要保存的元数据")
        return result, cover, picture

    async def info(self, scope, key):
        from .service import FileAccess
        info, kind = self.media._media(scope, key)
        self.media.objects._check_scope(scope, key, write=True)
        record = await self.media._record(scope, info)
        file = FileAccess(self.media, scope, info)
        tags = await self.media._parsed(file)
        lyrics = tags.best_lyrics() if tags else None
        return {"etag": info.etag, "kind": kind, "fields": {key: record.get(key) or "" for key in TEXT_FIELDS},
                "lyrics": lyrics.text if lyrics else "", "cover": bool(tags and tags.pictures),
                "editable": self.supported(info, record, getattr(self.media.resources, "ffmpeg", None)),
                "reason": "支持 MP3、FLAC、M4A、WAV 和 MP4、MOV、MKV、WebM；服务器需安装 FFmpeg"}

    async def start(self, scope, key, payload):
        fields, cover, picture = self.validate(payload)
        info, kind = self.media._media(scope, key)
        self.media.objects._check_scope(scope, key, write=True)
        if payload.get("etag") != info.etag:
            raise VersionConflict("文件已在别处修改，请重新打开后再编辑")
        record = await self.media._record(scope, info)
        if not self.supported(info, record, getattr(self.media.resources, "ffmpeg", None)):
            raise ValueError("此格式暂不支持元数据写回，或服务器没有安装 FFmpeg")
        if record.get("container") == "mp4" and fields.get("track"):
            parts = fields["track"].split("/")
            if len(parts) > 2 or any(not part.isascii() or not part.isdigit() or not 0 < int(part) <= 65535 for part in parts):
                raise ValueError("此格式的曲目编号需为数字或编号/总数，每项为 1–65535")
        if "subtitle" in fields and kind != "video" or "lyrics" in fields and kind != "audio":
            raise ValueError("歌词只能写入音频，字幕只能写入视频")
        if fields.get("subtitle", "").strip():
            from .text import normalize_subtitle
            from .providers.base import ProviderError
            try:
                normalize_subtitle(fields["subtitle"].encode("utf-8"))
            except ProviderError as exc:
                raise ValueError(str(exc)) from None
        if kind == "video" and cover != "keep":
            raise ValueError("视频封面请通过封面页更新，不改动视频画面")
        now = time.monotonic()
        self.jobs = {key: job for key, job in self.jobs.items() if not job.finished or now - job.finished < self.KEEP}
        active = [job for job in self.jobs.values() if not job.finished]
        if len(active) >= self.MAX_JOBS or any(job.bucket == scope.bucket_id for job in active):
            raise ValueError("已有文件正在保存，请等待完成后重试")
        job = EditJob(secrets.token_hex(8), scope.bucket_id, key, info.etag, info.size)
        self.jobs[job.id] = job
        job.task = asyncio.create_task(self.run(job, scope, info, record["container"], fields, cover, picture))
        return job.public()

    def status(self, scope, ids):
        found = []
        for ident in ids[:32]:
            job = self.jobs.get(ident)
            if job is not None and job.bucket == scope.bucket_id:
                self.media.objects._check_scope(scope, job.key, write=True)
                found.append(job.public())
        return found

    def cancel(self, scope, ident):
        if not isinstance(ident, str):
            raise ValueError("元数据保存任务编号不正确")
        jobs = self.status(scope, [ident])
        if not jobs:
            raise NotFoundError("元数据保存任务不存在")
        job = self.jobs[ident]
        cancelled = False
        if job.result is None and job.state in ("queued", "running") and job.task is not None and not job.task.done():
            job.state, job.detail, job.finished = "cancelled", "已取消保存", time.monotonic()
            job.task.cancel()
            cancelled = True
        return {"cancelled": cancelled, "committed": job.result is not None}

    async def command(self, options, authorize, directory, reserve, *, progress=lambda: None):
        env = {key: value for key, value in os.environ.items() if key.lower() not in ("http_proxy", "https_proxy", "all_proxy", "no_proxy")}
        process = await asyncio.create_subprocess_exec(self.media.resources.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            *options, env=env, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)

        async def read(stream, limit):
            data = bytearray()
            while chunk := await stream.read(65536):
                data.extend(chunk)
                if len(data) > limit:
                    raise ValueError("媒体标签数据超过处理上限")
            return bytes(data)

        async def watch():
            while process.returncode is None:
                authorize()
                progress()
                if shutil.disk_usage(directory).free < reserve:
                    raise ValueError("临时空间不足，请稍后重试")
                await asyncio.sleep(0.5)

        watcher = asyncio.create_task(watch())
        operation = asyncio.create_task(self.collect(process, read))
        try:
            done, _ = await asyncio.wait((watcher, operation), return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            data, _ = await operation
            if await process.wait() != 0:
                raise ValueError("无法更新这份媒体文件，请确认文件格式及内容完整")
            authorize()
            return data
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
            watcher.cancel(); operation.cancel()
            await asyncio.gather(watcher, operation, return_exceptions=True)

    @staticmethod
    async def collect(process, read):
        return await asyncio.gather(read(process.stdout, 2 * FIELD_LIMIT), read(process.stderr, 128 * 1024))

    async def run(self, job, scope, info, container, fields, cover, picture):
        from ..api import UserApi
        from ..thumbnails import _RangeInput
        objects = self.media.objects
        expected = None

        def committed():
            # 条件提交完成后，清理重复 Blob 等步骤仍可能被取消；按已消费完的输出校验提交结果。
            if job.result is None and expected is not None:
                row = objects.metadata.db.execute("SELECT * FROM objects WHERE bucket_id=? AND key=?", (scope.bucket_id, info.key)).fetchone()
                if row is not None and row["etag"] == expected:
                    job.result = UserApi._object_json(objects._object(row))
            return job.result is not None

        def authorize():
            objects._check_scope(scope, info.key, write=True)
            if objects.head_object(scope, info.key).etag != info.etag:
                raise VersionConflict("文件已在别处修改，本次修改未覆盖原文件")

        try:
            async with self.slot, asyncio.timeout(self.TIMEOUT):
                authorize()
                reserve = (self.media.resources.config().get("reserve_mib", 512) if self.media.resources else 512) * 1024 * 1024
                # 使用配置所在磁盘，临时目录权限为 0700；结束、失败和取消都会清理。
                parent = getattr(self.media.resources, "data_dir", None)
                with tempfile.TemporaryDirectory(prefix="audio-edit-", dir=parent) as directory:
                    folder = Path(directory)
                    if shutil.disk_usage(folder).free < info.size + self.COVER_LIMIT + reserve:
                        raise ValueError("临时空间不足，需要容纳一份媒体文件和封面，请稍后重试")
                    images = {}
                    if cover == "keep":
                        for variant in objects.thumbnail_variants([info.blob_uuid]).get(info.blob_uuid, []):
                            if variant not in ("thumb", "grid", "poster"):
                                continue
                            try:
                                images[variant] = (await objects.get_thumbnail(scope, info.key, variant))[0]
                            except NotFoundError:
                                pass
                    job.state, job.detail = "running", "正在写入元数据，音视频不会重新编码"
                    async with _RangeInput(objects.engine, info, authorize) as source:
                        from .service import FileAccess
                        from . import tags as media_tags
                        file = FileAccess(self.media, scope, info)
                        tags = await self.media._parsed(file)
                        # FFmpeg 不识别旧标签中误声明的 GBK；用已正确解码的字段覆盖，避免未修改的中文也乱码。
                        # 年份读取会省略月日；未修改日期时保留原日期标签，不能用年份覆盖完整日期。
                        canonical = {key: getattr(tags, key) for key in TEXT_FIELDS - {"year"} if tags and getattr(tags, key) is not None}
                        canonical.update({key: value for key, value in fields.items() if key in TEXT_FIELDS})
                        video = self.media.kind(info) == "video"
                        input_format, output_format = FORMATS[container]
                        if container == "mp4":
                            output_format = "mov" if info.key.lower().endswith(".mov") else "mp4" if video else "ipod"
                        elif info.key.lower().endswith(".webm"):
                            output_format = "webm"
                        inputs = ["-protocol_whitelist", "http,tcp", "-f", input_format]
                        if container == "mp4":
                            inputs += ["-enable_drefs", "0", "-use_absolute_path", "0"]
                        inputs += ["-i", source.url]
                        values = {("date" if key == "year" else key): value for key, value in canonical.items()}
                        native_lyrics = None
                        native_fields = id3_text_frames(canonical)
                        if container in ("mp3", "wav"):
                            lyrics = [(fields["lyrics"], "und")] if "lyrics" in fields else [(item.text, item.language) for item in tags.lyrics] if tags else []
                            native_lyrics = mp3_lyrics_frames(lyrics)
                            if container == "mp3":
                                values[LYRICS_BUFFER] = "0" * (len(native_lyrics) + len(native_fields) + 128)
                        elif "lyrics" in fields:
                            metadata = await self.command(inputs + ["-t", "0", "-f", "ffmetadata", "pipe:1"], authorize, folder, reserve)
                            values.update({key: "" for key in lyric_keys(metadata.decode("utf-8", errors="replace"))})
                            values["lyrics"] = fields["lyrics"]
                        (folder / "tags").write_text(metadata_text(values), encoding="utf-8")
                        metadata_inputs = inputs + ["-protocol_whitelist", "file", "-f", "ffmetadata", "-i", str(folder / "tags")]
                        options = metadata_inputs.copy()
                        options += ["-map", "0" if video else "0:a", "-map_metadata", "1", "-map_metadata", "0", "-c", "copy"]
                        if cover == "keep" and not video and container != "wav":
                            options += ["-map", "0:v?"]
                        elif picture is not None and container != "wav":
                            (folder / "cover").write_bytes(picture)
                            # 限定单张图片解封装器，禁止把用户提供的数据当作播放列表访问其他文件或网络。
                            options = inputs + ["-protocol_whitelist", "file", "-f", "ffmetadata", "-i", str(folder / "tags"),
                                "-protocol_whitelist", "file", "-f", "image2", "-pattern_type", "none", "-i", str(folder / "cover"),
                                "-map", "0:a", "-map", "2:v", "-map_metadata", "1", "-map_metadata", "0", "-c", "copy",
                                "-disposition:v", "attached_pic", "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)"]
                        if container == "mp3":
                            options += ["-id3v2_version", "3"]
                        if container == "wav":
                            options += ["-rf64", "never"]
                        if fields.get("subtitle", "").strip():
                            from .text import normalize_subtitle
                            subtitle = normalize_subtitle(fields["subtitle"].encode("utf-8"))
                            (folder / "subtitle").write_text(subtitle.text, encoding="utf-8")
                            codec = "mov_text" if container == "mp4" else "webvtt" if output_format == "webm" else "subrip"
                            index = len(tags.subtitles) if tags else 0
                            subtitle_input = ["-protocol_whitelist", "file", "-f", "webvtt" if subtitle.format == "vtt" else "srt", "-sub_charenc", "UTF-8", "-i", str(folder / "subtitle")]
                            options = metadata_inputs + subtitle_input + options[len(metadata_inputs):] + ["-map", "2:s:0", f"-c:s:{index}", codec, f"-metadata:s:s:{index}", "language=und"]
                        output = folder / "edited"
                        options += ["-f", output_format, str(output)]
                        def progress():
                            job.read = min(info.size, source.remote_bytes)
                        await self.command(options, authorize, folder, reserve, progress=progress)
                        if container == "mp3":
                            await asyncio.to_thread(write_mp3_lyrics, output, native_lyrics + native_fields, canonical)
                        elif container == "wav":
                            art = picture
                            if cover == "keep" and tags and tags.pictures:
                                art = (await self.media.embedded_cover(scope, info.key, info.etag))[0]
                            frames = native_fields + native_lyrics
                            if art:
                                from ..thumbnails import image_mime
                                body = b"\x00" + image_mime(art).encode("ascii") + b"\x00\x03\x00" + art
                                frames += b"APIC" + struct.pack(">I", len(body)) + b"\x00\x00" + body
                            await asyncio.to_thread(append_wav_tags, output, frames)
                        async def read_output(start, end):
                            def read():
                                with output.open("rb") as handle:
                                    handle.seek(start)
                                    return handle.read(end - start)
                            return await asyncio.to_thread(read)
                        written = await media_tags.parse(read_output, output.stat().st_size)
                        for key, value in canonical.items():
                            expected_text = _year(value) if key == "year" else value.strip() or None
                            if key == "track" and container == "mp4" and value:
                                expected_text = "/".join(str(int(part)) for part in value.split("/"))
                            if (getattr(written, key, None) or None) != expected_text:
                                raise ValueError("元数据写回校验失败，原文件未修改，请检查文件编码或格式")
                        if "lyrics" in fields:
                            actual = written.best_lyrics() if written else None
                            if (actual.text if actual else "") != fields["lyrics"].strip():
                                raise ValueError("歌词写回校验失败，原文件未修改")
                        if fields.get("subtitle", "").strip() and len(written.subtitles if written else []) != len(tags.subtitles if tags else []) + 1:
                            raise ValueError("字幕写回校验失败，原文件未修改")
                        if source.failure is not None:
                            raise source.failure
                        job.read = min(info.size, source.remote_bytes)
                    authorize()
                    job.detail = "正在保存媒体文件"
                    size = output.stat().st_size
                    async def body():
                        nonlocal expected
                        digest = hashlib.md5()
                        with output.open("rb") as handle:
                            while chunk := await asyncio.to_thread(handle.read, 1024 * 1024):
                                authorize()
                                digest.update(chunk)
                                job.stored += len(chunk)
                                yield chunk
                        expected = digest.hexdigest()
                    commit_scope = replace(scope, custom_cover=bool(images) or picture is not None)
                    saved = await objects.put_object(commit_scope, info.key, body(), size, info.content_type, info.user_meta, if_match=info.etag)
                    job.result = UserApi._object_json(saved)
                    job.detail = "文件已保存，正在更新媒体信息"
                    # 原路径的分享与收藏由条件覆盖保留；新 Blob 重新提取标签及封面。
                    def saved_authorize():
                        objects._check_scope(scope, saved.key, write=True)
                        if objects.head_object(scope, saved.key).etag != saved.etag:
                            raise VersionConflict("文件已在别处修改")
                    fresh_scope = replace(scope, authorize=saved_authorize)
                    thumbnails = getattr(objects, "thumbnail_service", None)
                    try:
                        await self.media._record(fresh_scope, saved)
                        if picture is not None and thumbnails is not None:
                            images = await thumbnails.render_image(picture, authorize=saved_authorize)
                        if images and thumbnails is not None:
                            await thumbnails.apply_custom(fresh_scope, saved.key, images)
                    except Exception:
                        # 音频内容已经成功提交，封面缓存交给既有后台补图，不误报整个保存失败。
                        if thumbnails is not None:
                            thumbnails.enqueue(saved)
                    job.state, job.detail = "done", "元数据已保存"
        except asyncio.CancelledError:
            if not committed():
                job.state, job.detail = "cancelled", "已取消，未完成的修改不会覆盖原文件"
            else:
                job.state, job.detail = "done", "元数据已保存"
        except Exception as exc:
            if committed():
                job.state, job.detail = "done", "元数据已保存"
            else:
                job.state = "failed"
                job.detail = str(exc) if isinstance(exc, (ValueError, VersionConflict, PermissionError)) else "保存失败，请稍后重试"
        finally:
            job.finished = time.monotonic()

    async def stop(self):
        tasks = [job.task for job in self.jobs.values() if job.task is not None and not job.task.done()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
