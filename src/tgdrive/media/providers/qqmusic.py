"""QQ 音乐：歌词（含翻译）与专辑封面。使用网页端公开接口，非官方开放平台。"""

from __future__ import annotations

import base64
import binascii
import html

from .base import Candidate, Fetched, GuideStep, MediaQuery, Provider, ProviderContext, ProviderError, info_fields, year_of
from .. import text as media_text

SEARCH = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp"
LYRIC = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg"
COVER = "https://y.gtimg.cn/music/photo_new/T002R{size}x{size}M000{mid}.jpg"
HEADERS = {"Referer": "https://y.qq.com/",
           "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}


def _decode(value: str) -> str:
    if not value:
        return ""
    try:
        return html.unescape(base64.b64decode(value).decode("utf-8", errors="replace"))
    except (binascii.Error, ValueError):
        return html.unescape(value)


class QQMusicProvider(Provider):
    id = "qqmusic"
    name = "QQ 音乐"
    description = "中文歌曲覆盖好，提供同步歌词（可附带翻译）与 800px 专辑封面。"
    homepage = "https://y.qq.com"
    capabilities = frozenset({"cover", "lyrics"})
    media = frozenset({"audio"})
    official = False
    info = True
    notice = "使用 QQ 音乐网页端的公开接口，并非官方开放平台：接口可能随时变更、限流或失效，请自行评估使用条款。"
    guide = (GuideStep("无需配置", "打开开关即可使用。查询会把歌名与歌手发送给 QQ 音乐。"),)

    async def search(self, query: MediaQuery, want, ctx: ProviderContext) -> list[Candidate]:
        data = await ctx.get_json(SEARCH, params={"w": query.keywords, "p": 1, "n": 12, "format": "json", "cr": 1, "new_json": 1}, headers=HEADERS)
        songs = (((data or {}).get("data") or {}).get("song") or {}).get("list") or []
        results = []
        for song in songs:
            if not isinstance(song, dict):
                continue
            mid = song.get("mid") or song.get("songmid")
            album = song.get("album") or {}
            album_mid = album.get("mid") if isinstance(album, dict) else song.get("albummid")
            album_name = album.get("name") if isinstance(album, dict) else song.get("albumname")
            title = song.get("title") or song.get("name") or song.get("songname") or ""
            artists = " / ".join(str(item.get("name")) for item in song.get("singer") or [] if isinstance(item, dict) and item.get("name"))
            interval = song.get("interval")
            common = dict(subtitle=" · ".join(part for part in (artists, str(album_name or "")) if part),
                          duration=float(interval) if isinstance(interval, (int, float)) and interval else None,
                          fields=info_fields(title=title, artist=artists, album=album_name, year=year_of(song.get("time_public")),
                                             track=song.get("index_album") or None))
            if want == "cover":
                if album_mid:
                    results.append(Candidate("cover", str(title), {"url": COVER.format(size=800, mid=album_mid),
                                             "preview_url": COVER.format(size=300, mid=album_mid), "artist": artists}, width=800, height=800, **common))
            elif mid:
                results.append(Candidate("lyrics", str(title), {"mid": mid, "artist": artists}, synced=True, format="lrc", **common))
        return results

    async def fetch(self, ref, want, ctx: ProviderContext) -> Fetched:
        if want == "cover":
            data, mime = await ctx.get_bytes(ref["url"], headers=HEADERS)
            return Fetched(data=data, mime=mime)
        data = await ctx.get_json(LYRIC, params={"songmid": ref["mid"], "format": "json", "g_tk": 5381}, headers=HEADERS)
        if not isinstance(data, dict) or data.get("retcode", data.get("code", 0)) != 0:
            raise ProviderError("这首歌在 QQ 音乐没有歌词")
        original = _decode(data.get("lyric") or "").strip()
        if not original:
            raise ProviderError("这首歌在 QQ 音乐没有歌词")
        translation = _decode(data.get("trans") or "").strip()
        fetched = media_text.normalize_lyrics(media_text.merge_translation(original, translation) if translation else original)
        fetched.format = "lrc" if media_text.detect(fetched.text) == "lrc" else "txt"
        return fetched
