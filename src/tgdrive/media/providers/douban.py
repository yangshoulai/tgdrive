"""豆瓣电影：中文电影与剧集的海报，按中文或英文片名查找。使用网页搜索建议接口，非官方开放平台。"""

from __future__ import annotations

import re

from .base import Candidate, Fetched, GuideStep, MediaQuery, Provider, ProviderContext, info_fields

SUGGEST = "https://movie.douban.com/j/subject_suggest"
HEADERS = {"Referer": "https://movie.douban.com/",
           "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}


def _sized(url: str, size: str) -> str:
    # 搜索建议只给小图（s_ratio_poster），同一路径换成 m／l 即中图与大图。
    return re.sub(r"/view/photo/[a-z]_ratio_poster/", f"/view/photo/{size}_ratio_poster/", url.replace("http://", "https://"))


class DoubanProvider(Provider):
    id = "douban"
    name = "豆瓣电影"
    description = "中文电影、剧集收录最全，中文或英文片名都能查到海报；剧集按季列出。"
    homepage = "https://movie.douban.com"
    capabilities = frozenset({"cover"})
    media = frozenset({"video"})
    official = False
    default_enabled = True
    info = True
    notice = "使用豆瓣网页的搜索建议接口，并非官方开放平台：接口可能随时变更、限流或失效，请自行评估使用条款。"
    guide = (GuideStep("无需配置", "打开开关即可使用。查询会把片名发送给豆瓣；海报图片由服务器读取。"),)

    async def search(self, query: MediaQuery, want, ctx: ProviderContext) -> list[Candidate]:
        for title in query.titles("cjk"):
            items = await ctx.get_json(SUGGEST, params={"q": title}, headers=HEADERS)
            results = []
            for item in items if isinstance(items, list) else []:
                image = item.get("img") if isinstance(item, dict) else None
                if not image or item.get("type") not in ("movie", "tv", None):
                    continue
                name = str(item.get("title") or "")
                subtitle = " · ".join(part for part in (str(item.get("sub_title") or ""), str(item.get("year") or "")) if part)
                episodes = str(item.get("episode") or "")
                results.append(Candidate("cover", name, {"url": _sized(image, "l"), "preview_url": _sized(image, "m"), "preview_headers": HEADERS},
                                         subtitle=subtitle, note=f"海报{f' · 共 {episodes} 集' if episodes else ''}",
                                         fields=info_fields(title=name, year=item.get("year"))))
            if results:
                return results
        return []

    async def fetch(self, ref, want, ctx: ProviderContext) -> Fetched:
        data, mime = await ctx.get_bytes(ref["url"], headers=HEADERS)
        return Fetched(data=data, mime=mime)

