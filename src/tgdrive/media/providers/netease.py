"""网易云音乐：歌词（含翻译）与专辑封面。使用网页端公开接口，非官方开放平台，可能随时变更或限流。"""

from __future__ import annotations

from .base import Candidate, Fetched, GuideStep, MediaQuery, Provider, ProviderContext, ProviderError
from .. import text as media_text

API = "https://music.163.com/api"
HEADERS = {"Referer": "https://music.163.com/",
           "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}


class NeteaseProvider(Provider):
    id = "netease"
    name = "网易云音乐"
    description = "中文歌曲覆盖好，提供同步歌词（可附带翻译）与专辑封面。"
    homepage = "https://music.163.com"
    capabilities = frozenset({"cover", "lyrics"})
    media = frozenset({"audio"})
    official = False
    notice = "使用网易云音乐网页端的公开接口，并非官方开放平台：接口可能随时变更、限流或失效，请自行评估使用条款。"
    guide = (GuideStep("无需配置", "打开开关即可使用。查询会把歌名与歌手发送给网易云音乐。"),
             GuideStep("出现失败时", "多为接口变更或请求过于频繁导致，稍后再试；长期失效时可关闭此项，改用其他歌词来源。"))

    async def search(self, query: MediaQuery, want, ctx: ProviderContext) -> list[Candidate]:
        data = await ctx.get_json(f"{API}/cloudsearch/pc", params={"s": query.keywords, "type": 1, "limit": 12, "offset": 0}, headers=HEADERS)
        songs = ((data or {}).get("result") or {}).get("songs") or []
        results = []
        for song in songs:
            if not isinstance(song, dict) or not song.get("id"):
                continue
            artists = " / ".join(str(item.get("name")) for item in song.get("ar") or [] if isinstance(item, dict) and item.get("name"))
            album = song.get("al") or {}
            duration = song.get("dt")
            common = dict(subtitle=" · ".join(part for part in (artists, str(album.get("name") or "")) if part),
                          duration=duration / 1000 if isinstance(duration, (int, float)) else None)
            if want == "cover":
                picture = album.get("picUrl")
                if picture:
                    results.append(Candidate("cover", str(song.get("name") or ""), {"url": f"{picture}?param=1200y1200",
                                             "preview_url": f"{picture}?param=240y240", "artist": artists}, **common))
            else:
                results.append(Candidate("lyrics", str(song.get("name") or ""), {"id": int(song["id"]), "artist": artists},
                                         synced=True, format="lrc", **common))
        return results

    async def fetch(self, ref, want, ctx: ProviderContext) -> Fetched:
        if want == "cover":
            data, mime = await ctx.get_bytes(ref["url"], headers=HEADERS)
            return Fetched(data=data, mime=mime)
        data = await ctx.get_json(f"{API}/song/lyric", params={"id": ref["id"], "lv": -1, "tv": -1}, headers=HEADERS)
        if not isinstance(data, dict) or data.get("nolyric") or data.get("uncollected"):
            raise ProviderError("这首歌在网易云音乐没有歌词")
        original = ((data.get("lrc") or {}).get("lyric") or "").strip()
        if not original:
            raise ProviderError("这首歌在网易云音乐没有歌词")
        translation = ((data.get("tlyric") or {}).get("lyric") or "").strip()
        fetched = media_text.normalize_lyrics(media_text.merge_translation(original, translation) if translation else original)
        fetched.format = "lrc" if media_text.detect(fetched.text) == "lrc" else "txt"
        return fetched
