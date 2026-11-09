"""iTunes Search API：苹果公开的搜索接口，无需密钥，提供高清专辑封面。"""

from __future__ import annotations

import re

from .base import Candidate, ConfigField, Fetched, GuideStep, MediaQuery, Provider, ProviderContext, info_fields

API = "https://itunes.apple.com/search"


def _sized(url: str, size: int) -> str:
    return re.sub(r"/\d+x\d+(bb|cc)?\.(jpg|png|webp)$", f"/{size}x{size}bb.jpg", url)


class ItunesProvider(Provider):
    id = "itunes"
    name = "iTunes"
    description = "苹果公开的搜索接口，无需密钥，专辑封面清晰（最高 1200px）。"
    homepage = "https://performance-partners.apple.com/search-api"
    capabilities = frozenset({"cover"})
    media = frozenset({"audio"})
    default_enabled = True
    info = True
    fields = (ConfigField("country", "商店地区", hint="两位地区代码，决定搜索哪个地区的商店，如 TW、HK、US、JP。留空为 TW（中国大陆商店的搜索接口目前不返回结果）。", placeholder="TW"),)
    guide = (GuideStep("无需密钥", "打开开关即可使用。查询会把歌名、歌手与专辑发送给苹果。"),
             GuideStep("选择商店地区", "中文歌曲建议用 TW 或 HK，欧美歌曲用 US；地区不同，收录与封面会有差异。中国大陆（CN）商店的搜索接口目前不返回结果。"))

    async def search(self, query: MediaQuery, want, ctx: ProviderContext) -> list[Candidate]:
        country = (ctx.config.get("country") or "TW").strip().upper()
        if not re.fullmatch(r"[A-Z]{2}", country):
            country = "TW"
        term = " ".join(part for part in (query.title, query.artist) if part) or query.name
        data = await ctx.get_json(API, params={"term": term, "media": "music", "entity": "song", "limit": 15, "country": country})
        results, seen = [], set()
        for item in (data or {}).get("results") or []:
            artwork = item.get("artworkUrl100") if isinstance(item, dict) else None
            if not artwork:
                continue
            album = str(item.get("collectionName") or "")
            key = (album, item.get("artistName"))
            if key in seen:
                continue
            seen.add(key)
            millis = item.get("trackTimeMillis")
            year = str(item.get("releaseDate") or "")[:4]
            results.append(Candidate("cover", str(item.get("trackName") or album), {"url": _sized(artwork, 1200), "preview_url": _sized(artwork, 240),
                                     "artist": str(item.get("artistName") or "")},
                                     subtitle=" · ".join(part for part in (str(item.get("artistName") or ""), album, year) if part),
                                     duration=millis / 1000 if isinstance(millis, (int, float)) else None, width=1200, height=1200,
                                     fields=info_fields(title=item.get("trackName"), artist=item.get("artistName"), album=album,
                                                        album_artist=item.get("collectionArtistName"), year=year, genre=item.get("primaryGenreName"),
                                                        track=item.get("trackNumber"))))
        return results

    async def fetch(self, ref, want, ctx: ProviderContext) -> Fetched:
        data, mime = await ctx.get_bytes(ref["url"])
        return Fetched(data=data, mime=mime)
