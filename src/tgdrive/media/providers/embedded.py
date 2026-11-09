"""内置数据：文件自带的封面、歌词与字幕轨。不联网。"""

from __future__ import annotations

from .base import Candidate, Fetched, MediaQuery, Provider, ProviderContext, ProviderError, info_fields
from .. import text as media_text

_IMAGE_LIMIT = 20 * 1024 * 1024


class EmbeddedProvider(Provider):
    id = "embedded"
    name = "内置数据"
    description = "读取文件自带的标签、内嵌封面、内嵌歌词与字幕轨。只读取文件头与索引，不联网；提取 MKV 等容器里的字幕需要服务器安装 FFmpeg。"
    capabilities = frozenset({"cover", "lyrics", "subtitle"})
    media = frozenset({"audio", "video"})
    default_enabled = True
    info = True

    def info_want(self, kind):
        return "info"

    async def search(self, query: MediaQuery, want, ctx: ProviderContext) -> list[Candidate]:
        file = ctx.file
        tags = file.tags if file is not None else None
        if tags is None:
            return []
        label = tags.title or query.title or query.name
        if want == "info":
            # 文件自带的标签：用户改过字段后可以借此恢复。
            fields = info_fields(**{name: getattr(tags, name) for name in ("title", "artist", "album", "album_artist", "track", "year", "genre")},
                                 **{name: tags.extra.get(name) for name in ("composer", "director", "actors", "description")})
            return [Candidate("info", label, {}, subtitle=" · ".join(part for part in (tags.artist, tags.album) if part), note="文件自带的标签",
                              score=1.0, fields=fields)] if fields else []
        if want == "cover":
            return [Candidate("cover", label, {"picture": index}, subtitle=picture.mime or "内嵌图片", note="文件内嵌封面",
                              score=1.0, preview="embedded")
                    for index, picture in enumerate(tags.pictures[:4])]
        if want == "lyrics":
            return [Candidate("lyrics", label, {"lyrics": index}, subtitle=tags.artist or "", synced=item.synced,
                              language=item.language, format="lrc" if item.synced else "txt", preview=media_text.preview(item.text),
                              note="文件内嵌歌词", score=1.0)
                    for index, item in enumerate(tags.lyrics[:4])]
        if want == "subtitle":
            return [Candidate("subtitle", stream.title or (stream.language or "字幕轨"), {"stream": stream.index},
                              subtitle=stream.codec, language=stream.language, format="vtt",
                              note="内嵌字幕轨" if stream.text else "图片字幕，无法转成文字", score=1.0 if stream.text else 0.0)
                    for stream in tags.subtitles]
        return []

    async def fetch(self, ref, want, ctx: ProviderContext) -> Fetched:
        file = ctx.file
        if file is None or file.tags is None:
            raise ProviderError("文件没有内置数据")
        tags = file.tags
        if want == "cover":
            pictures = tags.pictures
            index = ref.get("picture", 0)
            if not 0 <= index < len(pictures):
                raise ProviderError("内嵌封面已不存在")
            picture = pictures[index]
            if picture.data is not None:
                return Fetched(data=picture.data, mime=picture.mime)
            if picture.length > _IMAGE_LIMIT:
                raise ProviderError("内嵌封面超过 20 MB")
            return Fetched(data=await file.read(picture.offset, picture.offset + picture.length), mime=picture.mime)
        if want == "lyrics":
            index = ref.get("lyrics", 0)
            if not 0 <= index < len(tags.lyrics):
                raise ProviderError("内嵌歌词已不存在")
            item = tags.lyrics[index]
            return Fetched(text=item.text.strip() + "\n", format="lrc" if item.synced else "txt")
        if want == "subtitle":
            stream = next((item for item in tags.subtitles if item.index == ref.get("stream")), None)
            if stream is None or not stream.text:
                raise ProviderError("这条字幕轨不是文字字幕，无法转换")
            return Fetched(text=await file.subtitle(stream.index), format="vtt")
        raise ProviderError("不支持的内容")

    async def test(self, ctx: ProviderContext) -> str:
        return "内置数据不需要连接外部服务"
