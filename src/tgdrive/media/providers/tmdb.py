"""TMDB（The Movie Database）：电影与剧集的海报、剧照，需要管理员申请免费的 API 令牌。"""

from __future__ import annotations

import asyncio
import re

from .base import Candidate, ConfigField, Fetched, GuideStep, MediaQuery, Provider, ProviderContext, ProviderError

API = "https://api.themoviedb.org/3"
IMAGES = "https://image.tmdb.org/t/p"


class TmdbProvider(Provider):
    id = "tmdb"
    name = "TMDB"
    description = "电影与剧集数据库，提供中文片名、海报与剧照；剧集文件名带季集编号（如 S01E02）时可取单集剧照。"
    homepage = "https://www.themoviedb.org"
    capabilities = frozenset({"cover"})
    media = frozenset({"video"})
    fields = (ConfigField("token", "API 读访问令牌", secret=True, required=True,
                          hint="TMDB 设置 → API 页面的「API 读访问令牌」（较长的一串）；也可以填写 v3 的 API 密钥（32 位）。"),
              ConfigField("language", "结果语言", hint="海报与片名的语言，如 zh-CN、zh-TW、en-US。留空为 zh-CN。", placeholder="zh-CN"))
    guide = (GuideStep("注册 TMDB 账号", "免费注册并登录。", "https://www.themoviedb.org/signup", "注册 TMDB"),
             GuideStep("申请 API", "进入账号「设置 → API」，选择开发者（Developer）用途，按提示填写应用说明（个人网盘即可）。",
                       "https://www.themoviedb.org/settings/api", "打开 API 设置"),
             GuideStep("复制令牌", "复制页面上的「API 读访问令牌」（Read Access Token），粘贴到下方并保存，再点「测试连接」。"),
             GuideStep("署名要求", "TMDB 要求使用方注明数据来源：查找结果里会标注「数据来自 TMDB」。"))
    notice = "本功能使用 TMDB API，但未经 TMDB 认可或认证。"

    def _auth(self, ctx: ProviderContext) -> tuple[dict, dict]:
        token = (ctx.config.get("token") or "").strip()
        if not token:
            raise ProviderError("没有配置 TMDB 令牌")
        if re.fullmatch(r"[0-9a-f]{32}", token):
            return {"api_key": token}, {}
        return {}, {"Authorization": f"Bearer {token}"}

    def _language(self, ctx: ProviderContext) -> str:
        value = (ctx.config.get("language") or "zh-CN").strip()
        return value if re.fullmatch(r"[a-z]{2}(?:-[A-Z]{2})?", value) else "zh-CN"

    async def _get(self, ctx: ProviderContext, path: str, params: dict) -> dict:
        auth, headers = self._auth(ctx)
        data = await ctx.get_json(f"{API}{path}", params={**params, **auth}, headers=headers, allow=(200, 401, 404))
        if isinstance(data, dict) and data.get("success") is False:
            raise ProviderError("TMDB 令牌无效或已失效，请检查配置" if data.get("status_code") in (7, 3) else "TMDB 没有找到对应内容")
        return data if isinstance(data, dict) else {}

    async def search(self, query: MediaQuery, want, ctx: ProviderContext) -> list[Candidate]:
        for title in query.titles("latin"):
            results = await self._search(query, title, ctx)
            if results:
                return results
        return []

    async def _search(self, query: MediaQuery, title: str, ctx: ProviderContext) -> list[Candidate]:
        language = self._language(ctx)
        series = query.season is not None or query.episode is not None
        movie_params = {"query": title, "language": language, "year": query.year or None}
        tv_params = {"query": title, "language": language, "first_air_date_year": query.year or None}
        if series:
            tv = await self._get(ctx, "/search/tv", tv_params)
            movies: dict = {}
        else:
            movies, tv = await asyncio.gather(self._get(ctx, "/search/movie", movie_params), self._get(ctx, "/search/tv", tv_params))
        results: list[Candidate] = []
        shows = [("tv", item) for item in (tv.get("results") or [])[:5]]
        films = [("movie", item) for item in (movies.get("results") or [])[:5]]
        if series and shows and query.episode:
            show = shows[0][1]
            try:
                episode = await self._get(ctx, f"/tv/{int(show['id'])}/season/{query.season or 1}/episode/{query.episode}", {"language": language})
            except ProviderError:
                episode = {}
            if episode.get("still_path"):
                label = f"S{query.season or 1:02d}E{query.episode:02d}" + (f" {episode.get('name')}" if episode.get("name") else "")
                results.append(self._image(episode["still_path"], str(show.get("name") or ""), label, "单集剧照", 16 / 9, 1.0))
        for media, item in (films + shows) if not series else (shows + films):
            name = str(item.get("title") or item.get("name") or "")
            year = str(item.get("release_date") or item.get("first_air_date") or "")[:4]
            label = " · ".join(part for part in ("电影" if media == "movie" else "剧集", year) if part)
            if item.get("poster_path"):
                results.append(self._image(item["poster_path"], name, label, "海报", 2 / 3))
            if item.get("backdrop_path"):
                results.append(self._image(item["backdrop_path"], name, label, "剧照", 16 / 9))
        return results

    @staticmethod
    def _image(path: str, title: str, subtitle: str, note: str, ratio: float, bonus: float = 0.0) -> Candidate:
        width = 780 if ratio < 1 else 1280
        return Candidate("cover", title, {"url": f"{IMAGES}/{'w780' if ratio < 1 else 'w1280'}{path}", "preview_url": f"{IMAGES}/w300{path}",
                                          "bonus": bonus},
                         subtitle=subtitle, note=f"{note} · 数据来自 TMDB", width=width, height=round(width / ratio))

    async def fetch(self, ref, want, ctx: ProviderContext) -> Fetched:
        data, mime = await ctx.get_bytes(ref["url"])
        return Fetched(data=data, mime=mime)

    async def test(self, ctx: ProviderContext) -> str:
        await self._get(ctx, "/configuration", {})
        return "令牌有效，连接正常"
