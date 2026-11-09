"""MusicBrainz + Cover Art Archive：开放的音乐数据库与封面库，无需密钥，要求每秒最多一次请求。"""

from __future__ import annotations

import asyncio

from .base import Candidate, Fetched, GuideStep, MediaQuery, Provider, ProviderContext, info_fields

API = "https://musicbrainz.org/ws/2"
COVERS = "https://coverartarchive.org"


def _lucene(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


class MusicBrainzProvider(Provider):
    id = "musicbrainz"
    name = "MusicBrainz 封面库"
    description = "开放的音乐百科与 Cover Art Archive 封面库，无需密钥；文件带 MusicBrainz 编号（如经 Picard 整理）时能精确匹配。"
    homepage = "https://musicbrainz.org"
    capabilities = frozenset({"cover"})
    media = frozenset({"audio"})
    default_enabled = True
    info = True
    interval = 1.1
    interval_hosts = ("musicbrainz.org",)
    guide = (GuideStep("无需配置", "打开开关即可使用。MusicBrainz 限制每秒最多一次查询，结果可能比其他来源慢一些。"),
             GuideStep("提高准确度", "用 MusicBrainz Picard 等工具整理过的文件带有专辑编号，会直接读取对应封面。"))

    async def search(self, query: MediaQuery, want, ctx: ProviderContext) -> list[Candidate]:
        release = query.extra.get("musicbrainz_release")
        if release:
            return [Candidate("cover", query.album or query.title or query.name, {"url": f"{COVERS}/release/{release}/front-1200",
                              "preview_url": f"{COVERS}/release/{release}/front-250"},
                              subtitle="按文件中的 MusicBrainz 专辑编号", hash_match=True)]
        parts = [f"recording:{_lucene(query.title or query.name)}"]
        if query.artist:
            parts.append(f"artist:{_lucene(query.artist)}")
        if query.album:
            parts.append(f"release:{_lucene(query.album)}")
        data = await self._get(ctx, {"query": " AND ".join(parts), "fmt": "json", "limit": 10})
        results, seen = [], set()
        for recording in (data or {}).get("recordings") or []:
            artist = " / ".join(str(item.get("name")) for item in recording.get("artist-credit") or [] if isinstance(item, dict) and item.get("name"))
            length = recording.get("length")
            for release_item in recording.get("releases") or []:
                group = (release_item.get("release-group") or {}).get("id")
                if not group or group in seen:
                    continue
                seen.add(group)
                year = str(release_item.get("date") or "")[:4]
                results.append(Candidate("cover", str(recording.get("title") or ""), {"url": f"{COVERS}/release-group/{group}/front-1200",
                                         "preview_url": f"{COVERS}/release-group/{group}/front-250", "artist": artist},
                                         subtitle=" · ".join(part for part in (artist, str(release_item.get("title") or ""), year) if part),
                                         duration=length / 1000 if isinstance(length, (int, float)) else None,
                                         note="封面库可能没有这张专辑的封面",
                                         fields=info_fields(title=recording.get("title"), artist=artist, album=release_item.get("title"), year=year)))
                if len(results) >= 8:
                    return results
        return results

    async def _get(self, ctx: ProviderContext, params: dict):
        # 超过每秒一次（同一出口 IP 上的其他程序也算）时返回 503：稍等再试一次。
        status, _, data = await ctx.request("GET", f"{API}/recording", params=params, headers={"Accept": "application/json"}, limit=ctx.JSON_LIMIT)
        if status == 503:
            await asyncio.sleep(1.5)
            status, _, data = await ctx.request("GET", f"{API}/recording", params=params, headers={"Accept": "application/json"}, limit=ctx.JSON_LIMIT)
        return ctx.decode_json(status, data, (200,))

    async def fetch(self, ref, want, ctx: ProviderContext) -> Fetched:
        data, mime = await ctx.get_bytes(ref["url"])
        return Fetched(data=data, mime=mime)

    async def test(self, ctx: ProviderContext) -> str:
        await self._get(ctx, {"query": 'recording:"Yesterday"', "fmt": "json", "limit": 1})
        return "连接正常"
