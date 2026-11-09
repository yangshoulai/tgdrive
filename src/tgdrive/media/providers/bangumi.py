"""Bangumi 番组计划：动画（含剧场版）封面的开放接口，无需密钥。"""

from __future__ import annotations

from urllib.parse import quote

from .base import Candidate, Fetched, GuideStep, MediaQuery, Provider, ProviderContext, info_fields

API = "https://api.bgm.tv"


def _https(url: str) -> str:
    return url.replace("http://", "https://")


class BangumiProvider(Provider):
    id = "bangumi"
    name = "Bangumi 番组计划"
    description = "动画（番剧与剧场版）数据库，无需密钥，中文、日文名都能查到封面。"
    homepage = "https://bgm.tv"
    capabilities = frozenset({"cover"})
    media = frozenset({"video"})
    default_enabled = True
    info = True
    guide = (GuideStep("无需配置", "打开开关即可使用。查询会把片名发送给 Bangumi；只收录动画作品。"),)

    async def search(self, query: MediaQuery, want, ctx: ProviderContext) -> list[Candidate]:
        for title in query.titles("cjk"):
            data = await ctx.get_json(f"{API}/search/subject/{quote(title, safe='')}", params={"type": 2, "responseGroup": "small", "max_results": 8},
                                      allow=(200, 404))
            items = (data or {}).get("list") if isinstance(data, dict) else None
            results = []
            for item in items or []:
                images = item.get("images") if isinstance(item, dict) else None
                if not images or not images.get("large"):
                    continue
                year = str(item.get("air_date") or "")[:4]
                results.append(Candidate("cover", str(item.get("name_cn") or item.get("name") or ""),
                                         {"url": _https(images["large"]), "preview_url": _https(images.get("common") or images["large"])},
                                         subtitle=" · ".join(part for part in (str(item.get("name") or ""), year) if part and part != item.get("name_cn")),
                                         note="动画封面", fields=info_fields(title=item.get("name_cn") or item.get("name"), year=year,
                                                                           genre="动画", description=item.get("summary"))))
            if results:
                return results
        return []

    async def fetch(self, ref, want, ctx: ProviderContext) -> Fetched:
        data, mime = await ctx.get_bytes(ref["url"])
        return Fetched(data=data, mime=mime)
