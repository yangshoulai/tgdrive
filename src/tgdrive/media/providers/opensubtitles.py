"""OpenSubtitles.com：多语言字幕库，按文件哈希精确匹配；需要管理员申请 API Key，下载需要账号。"""

from __future__ import annotations

import time

from ...version import __version__
from .base import Candidate, ConfigField, Fetched, GuideStep, MediaQuery, Provider, ProviderContext, ProviderError
from .. import text as media_text

API = "https://api.opensubtitles.com/api/v1"
_LANGUAGES = {"zh": "zh-cn,zh-tw", "zh-cn": "zh-cn", "zh-hans": "zh-cn", "zh-tw": "zh-tw", "zh-hant": "zh-tw", "en": "en",
              "ja": "ja", "ko": "ko", "fr": "fr", "de": "de", "es": "es", "ru": "ru"}


class OpenSubtitlesProvider(Provider):
    id = "opensubtitles"
    name = "OpenSubtitles"
    description = "全球最大的字幕库之一。按文件哈希匹配时，字幕与这个版本的视频时间轴一致；免费账号每天可下载的字幕数量有限。"
    homepage = "https://www.opensubtitles.com"
    capabilities = frozenset({"subtitle"})
    media = frozenset({"video"})
    fields = (ConfigField("api_key", "API Key", secret=True, required=True, hint="在 OpenSubtitles 的 API 消费者页面创建应用后获得。"),
              ConfigField("username", "用户名", hint="下载字幕需要登录；免费账号每天约 5–20 次下载，VIP 更多。"),
              ConfigField("password", "密码", secret=True, hint="与用户名一起用于登录，只保存在服务器上。"))
    guide = (GuideStep("注册账号", "注册 opensubtitles.com 账号（与旧的 opensubtitles.org 不通用）。", "https://www.opensubtitles.com/users/sign_up", "注册"),
             GuideStep("创建 API 应用", "登录后打开 API 消费者页面，新建一个应用（名称可写 Tessera），复制生成的 API Key。",
                       "https://www.opensubtitles.com/consumers", "打开 API 消费者"),
             GuideStep("填写配置", "把 API Key、账号用户名和密码填到下方并保存，再点「测试连接」确认可以登录。"),
             GuideStep("下载额度", "每次保存字幕消耗一次下载额度；额度用完会提示，第二天恢复。"))

    def __init__(self):
        self._tokens: dict[tuple[str, str], tuple[str, str, float]] = {}

    def _headers(self, ctx: ProviderContext) -> dict:
        key = (ctx.config.get("api_key") or "").strip()
        if not key:
            raise ProviderError("没有配置 OpenSubtitles API Key")
        return {"Api-Key": key, "User-Agent": f"Tessera v{__version__.split('+')[0]}"}

    async def _login(self, ctx: ProviderContext) -> tuple[str | None, str]:
        username, password = (ctx.config.get("username") or "").strip(), ctx.config.get("password") or ""
        if not username or not password:
            return None, API
        cached = self._tokens.get((username, password))
        if cached and cached[2] > time.monotonic():
            return cached[0], cached[1]
        data = await ctx.post_json(f"{API}/login", {"username": username, "password": password}, headers=self._headers(ctx), allow=(200, 401))
        token = data.get("token") if isinstance(data, dict) else None
        if not token:
            raise ProviderError("OpenSubtitles 账号或密码不正确")
        base = data.get("base_url") or "api.opensubtitles.com"
        base = f"https://{base.removeprefix('https://').rstrip('/')}/api/v1"
        self._tokens[(username, password)] = (token, base, time.monotonic() + 12 * 3600)
        return token, base

    async def search(self, query: MediaQuery, want, ctx: ProviderContext) -> list[Candidate]:
        languages = ",".join(dict.fromkeys(code for item in query.languages for code in _LANGUAGES.get(item.lower(), item.lower()).split(",")))
        params = {"languages": languages}
        if query.moviehash:
            params["moviehash"] = query.moviehash
        params["query"] = (query.title or query.name).lower()
        if query.season is not None:
            params["season_number"] = query.season
        if query.episode is not None:
            params["episode_number"] = query.episode
        if query.year:
            params["year"] = query.year
        # 接口要求参数按名称排序，否则会重定向。
        data = await ctx.get_json(f"{API}/subtitles", params=dict(sorted(params.items())), headers=self._headers(ctx))
        results = []
        for item in (data or {}).get("data") or []:
            attributes = item.get("attributes") or {}
            files = attributes.get("files") or []
            if not files or not files[0].get("file_id"):
                continue
            details = attributes.get("feature_details") or {}
            flags = [label for key, label in (("hearing_impaired", "听障"), ("machine_translated", "机器翻译"), ("ai_translated", "AI 翻译")) if attributes.get(key)]
            downloads = attributes.get("download_count")
            note = " · ".join(([f"{downloads} 次下载"] if downloads else []) + flags)
            results.append(Candidate("subtitle", str(attributes.get("release") or files[0].get("file_name") or details.get("title") or ""),
                                     {"file_id": int(files[0]["file_id"]), "name": files[0].get("file_name")},
                                     subtitle=" · ".join(part for part in (str(details.get("movie_name") or details.get("title") or ""), str(details.get("year") or "")) if part),
                                     language=str(attributes.get("language") or "") or None, format="srt",
                                     hash_match=bool(attributes.get("moviehash_match")), note=note))
        return results

    async def fetch(self, ref, want, ctx: ProviderContext) -> Fetched:
        token, base = await self._login(ctx)
        headers = self._headers(ctx)
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = await ctx.post_json(f"{base}/download", {"file_id": ref["file_id"]}, headers=headers, allow=(200, 401, 403, 406))
        link = data.get("link") if isinstance(data, dict) else None
        if not link:
            message = str((data or {}).get("message") or "") if isinstance(data, dict) else ""
            if "quota" in message.lower() or (isinstance(data, dict) and data.get("remaining") == 0):
                raise ProviderError("OpenSubtitles 今天的下载额度已用完，请明天再试")
            raise ProviderError("OpenSubtitles 拒绝下载，请检查账号配置" if not token else "OpenSubtitles 没有返回下载地址")
        raw, _ = await ctx.get_bytes(link, limit=media_text.TEXT_LIMIT)
        return media_text.normalize_subtitle(raw, ref.get("name"))

    async def test(self, ctx: ProviderContext) -> str:
        await ctx.get_json(f"{API}/infos/languages", headers=self._headers(ctx))
        token, _ = await self._login(ctx)
        return "API Key 有效，账号登录成功" if token else "API Key 有效；未填写账号，下载字幕可能受限"
