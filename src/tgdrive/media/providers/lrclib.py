"""LRCLIB（https://lrclib.net）：开放的歌词库，免费、无需密钥，有逐行同步歌词。"""

from __future__ import annotations

from .base import Candidate, Fetched, GuideStep, MediaQuery, Provider, ProviderContext, ProviderError, info_fields
from .. import text as media_text

API = "https://lrclib.net/api"


class LrclibProvider(Provider):
    id = "lrclib"
    name = "LRCLIB"
    description = "开放的歌词数据库，免费、无需密钥，多数歌曲有逐行同步的 LRC 歌词。中文歌曲收录较少，可同时启用国内音乐平台。"
    homepage = "https://lrclib.net"
    capabilities = frozenset({"lyrics"})
    media = frozenset({"audio"})
    default_enabled = True
    info = True
    guide = (GuideStep("无需配置", "打开开关即可使用。查询会把歌名、歌手、专辑与时长发送给 LRCLIB。"),)

    async def search(self, query: MediaQuery, want, ctx: ProviderContext) -> list[Candidate]:
        if query.title and query.artist:
            params = {"track_name": query.title, "artist_name": query.artist, "album_name": query.album or None}
        else:
            params = {"q": query.keywords}
        items = await ctx.get_json(f"{API}/search", params=params)
        if not isinstance(items, list):
            raise ProviderError("LRCLIB 返回的数据格式不正确")
        results = []
        # 同一首歌常有许多几乎相同的条目：只取前 10 个，其余靠打分排序也难以区分。
        for item in items[:10]:
            if not isinstance(item, dict) or item.get("instrumental"):
                continue
            synced, plain = item.get("syncedLyrics") or "", item.get("plainLyrics") or ""
            lyrics = synced or plain
            if not lyrics:
                continue
            duration = item.get("duration")
            results.append(Candidate(
                "lyrics", str(item.get("trackName") or ""), {"id": item.get("id"), "text": lyrics, "synced": bool(synced), "artist": str(item.get("artistName") or "")},
                subtitle=" · ".join(part for part in (str(item.get("artistName") or ""), str(item.get("albumName") or "")) if part),
                synced=bool(synced), format="lrc" if synced else "txt",
                fields=info_fields(title=item.get("trackName"), artist=item.get("artistName"), album=item.get("albumName")),
                duration=float(duration) if isinstance(duration, (int, float)) else None, preview=media_text.preview(lyrics),
                note="" if synced else "没有时间轴"))
        return results

    async def fetch(self, ref, want, ctx: ProviderContext) -> Fetched:
        text = ref.get("text")
        if not text:
            item = await ctx.get_json(f"{API}/get/{int(ref['id'])}")
            text = item.get("syncedLyrics") or item.get("plainLyrics") if isinstance(item, dict) else None
        if not text:
            raise ProviderError("这首歌没有歌词")
        fetched = media_text.normalize_lyrics(text)
        fetched.format = "lrc" if ref.get("synced") else "txt"
        return fetched
