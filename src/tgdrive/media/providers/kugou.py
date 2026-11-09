"""酷狗音乐：按歌名、歌手与时长匹配歌词。使用客户端公开接口，非官方开放平台。"""

from __future__ import annotations

import base64
import binascii

from .base import Candidate, Fetched, GuideStep, MediaQuery, Provider, ProviderContext, ProviderError, info_fields
from .. import text as media_text

SEARCH = "https://krcs.kugou.com/search"
DOWNLOAD = "https://lyrics.kugou.com/download"
HEADERS = {"User-Agent": "Android712-AndroidPhone-11451-376-0-FeeCacheModule-wifi"}


class KugouProvider(Provider):
    id = "kugou"
    name = "酷狗音乐"
    description = "按歌名、歌手与时长匹配同步歌词，中文歌曲覆盖好。"
    homepage = "https://www.kugou.com"
    capabilities = frozenset({"lyrics"})
    media = frozenset({"audio"})
    official = False
    info = True
    notice = "使用酷狗客户端的公开歌词接口，并非官方开放平台：接口可能随时变更、限流或失效，请自行评估使用条款。"
    guide = (GuideStep("无需配置", "打开开关即可使用。查询会把歌名、歌手与时长发送给酷狗。"),)

    async def search(self, query: MediaQuery, want, ctx: ProviderContext) -> list[Candidate]:
        keyword = " - ".join(part for part in (query.artist, query.title) if part) or query.name
        params = {"ver": 1, "man": "yes", "client": "mobi", "keyword": keyword,
                  "duration": int(query.duration * 1000) if query.duration else None, "hash": ""}
        data = await ctx.get_json(SEARCH, params=params, headers=HEADERS)
        results = []
        for item in (data or {}).get("candidates") or []:
            if not isinstance(item, dict) or not item.get("id") or not item.get("accesskey"):
                continue
            duration = item.get("duration")
            results.append(Candidate("lyrics", str(item.get("song") or ""), {"id": str(item["id"]), "accesskey": str(item["accesskey"]), "artist": str(item.get("singer") or "")},
                                     subtitle=str(item.get("singer") or ""), synced=True, format="lrc",
                                     fields=info_fields(title=item.get("song"), artist=item.get("singer")),
                                     duration=duration / 1000 if isinstance(duration, (int, float)) and duration else None))
        return results

    async def fetch(self, ref, want, ctx: ProviderContext) -> Fetched:
        data = await ctx.get_json(DOWNLOAD, params={"ver": 1, "client": "pc", "id": ref["id"], "accesskey": ref["accesskey"],
                                                    "fmt": "lrc", "charset": "utf8"}, headers=HEADERS)
        content = (data or {}).get("content") if isinstance(data, dict) else None
        if not content:
            raise ProviderError("酷狗没有返回歌词")
        try:
            text = base64.b64decode(content).decode("utf-8-sig", errors="replace")
        except (binascii.Error, ValueError) as exc:
            raise ProviderError("酷狗返回的歌词格式不正确") from exc
        fetched = media_text.normalize_lyrics(text)
        fetched.format = "lrc" if media_text.detect(fetched.text) == "lrc" else "txt"
        return fetched
