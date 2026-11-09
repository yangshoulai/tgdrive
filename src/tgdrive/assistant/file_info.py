"""文件详情中的媒体元信息：只读取已有数据与受预算限制的文件头，不查找在线资料。"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..errors import NotFoundError, NotReadyError

if TYPE_CHECKING:
    from .tools import ToolContext


async def media_info(ctx: ToolContext, key: str, include: bool) -> dict:
    if not include:
        return {"status": "not_requested"}
    if key in ctx.attachments.values():
        return {"status": "not_applicable", "reason": "对话附件只提供基础文件信息"}
    scope = ctx.scope_for(key)
    head = ctx.objects.head_object(scope, key)
    if ctx.media is not None:
        kind = ctx.media.kind(head)
    else:
        from ..filekinds import kind_of
        kind = kind_of(key, head.content_type)
    if kind not in ("audio", "video"):
        return {"status": "not_applicable"}

    result = {"status": "unavailable", "embedded_cover": None, "embedded_lyrics": None, "subtitles": None}
    assets = await ctx.objects.apreview_assets(scope, key)
    for name, asset_kind in (("lyrics_files", "lyrics"), ("subtitle_files", "subtitle")):
        result[name] = [{**item, "path": ctx.display(item["path"])} for item in assets if item["kind"] == asset_kind]
    if ctx.media is None:
        return {**result, "reason": "媒体信息服务不可用，不能判断内嵌内容是否存在"}
    if ctx.taint is not None:
        ctx.taint("读取过文件元数据")
    try:
        info = await ctx.media.info(scope, key)
    except (PermissionError, NotFoundError, NotReadyError):
        raise
    except Exception:
        # 网络、资源或解析故障不是“没有封面／歌词”的证据；基础信息和已登记的元数据资源仍可返回。
        return {**result, "reason": "媒体信息读取失败，不能判断内嵌内容是否存在"}
    result.update({name: info.get(name) for name in (
        "container", "duration", "title", "artist", "album", "album_artist", "track", "year", "genre", "composer", "director", "actors", "description")})
    if not info.get("container"):
        return {**result, "status": "unsupported", "reason": "未能解析此文件的媒体格式，内嵌内容状态未知"}
    assets = ctx.objects.file_metadata.preview_assets(ctx.objects.head_object(scope, key))
    for name, asset_kind in (("lyrics_files", "lyrics"), ("subtitle_files", "subtitle")):
        result[name] = [item for item in assets if item["kind"] == asset_kind]
    result.update(status="ready", embedded_enabled=info["embedded"])
    if info["embedded"]:
        # 文件自带的歌词与字幕轨；已保存的歌词、字幕见 lyrics_files／subtitle_files（播放时优先使用）。
        lyrics = info.get("file_lyrics")
        result.update(embedded_cover=info["cover"],
                      embedded_lyrics={"present": bool(lyrics), "synced": lyrics.get("synced") if lyrics else None},
                      subtitles=info["subtitles"], embedded_subtitles=info.get("embedded_subtitles") or [])
    return result
