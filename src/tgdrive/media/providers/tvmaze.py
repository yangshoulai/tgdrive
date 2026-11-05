"""TVmaze：开放的剧集数据库，无需密钥；文件名带季集编号（如 S01E02）时可取单集剧照。"""

from __future__ import annotations

from .base import Candidate, Fetched, GuideStep, MediaQuery, Provider, ProviderContext, ProviderError

API = "https://api.tvmaze.com"


class TvmazeProvider(Provider):
    id = "tvmaze"
    name = "TVmaze"
    description = "开放的剧集数据库，无需密钥，以英文剧集为主；文件名带季集编号时同时给出单集剧照。"
    homepage = "https://www.tvmaze.com"
    capabilities = frozenset({"cover"})
    media = frozenset({"video"})
    default_enabled = True
    notice = "数据来自 TVmaze（CC BY-SA）。"
    guide = (GuideStep("无需配置", "打开开关即可使用。查询会把剧名发送给 TVmaze，英文剧名效果最好。"),)

    async def search(self, query: MediaQuery, want, ctx: ProviderContext) -> list[Candidate]:
        # 只收录剧集：文件名没有季集编号时多半是电影，模糊搜索只会给出不相关的剧。
        if query.season is None and query.episode is None:
            return []
        for title in query.titles("latin"):
            items = await ctx.get_json(f"{API}/search/shows", params={"q": title})
            shows = [item.get("show") for item in items if isinstance(item, dict) and isinstance(item.get("show"), dict)] if isinstance(items, list) else []
            if not shows:
                continue
            results: list[Candidate] = []
            if query.episode and shows[0].get("id"):
                try:
                    episode = await ctx.get_json(f"{API}/shows/{int(shows[0]['id'])}/episodebynumber",
                                                 params={"season": query.season or 1, "number": query.episode})
                except ProviderError:
                    episode = None
                image = (episode or {}).get("image") if isinstance(episode, dict) else None
                if image and image.get("original"):
                    label = f"S{query.season or 1:02d}E{query.episode:02d} {episode.get('name') or ''}".strip()
                    results.append(Candidate("cover", str(shows[0].get("name") or ""), {"url": image["original"], "preview_url": image.get("medium") or image["original"],
                                             "bonus": 0.3}, subtitle=label, note="单集剧照 · 数据来自 TVmaze"))
            for show in shows[:8]:
                image = show.get("image") or {}
                if not image.get("original"):
                    continue
                year = str(show.get("premiered") or "")[:4]
                results.append(Candidate("cover", str(show.get("name") or ""), {"url": image["original"], "preview_url": image.get("medium") or image["original"]},
                                         subtitle=" · ".join(part for part in ("剧集", year) if part), note="海报 · 数据来自 TVmaze"))
            return results
        return []

    async def fetch(self, ref, want, ctx: ProviderContext) -> Fetched:
        data, mime = await ctx.get_bytes(ref["url"])
        return Fetched(data=data, mime=mime)
