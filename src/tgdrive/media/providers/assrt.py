"""射手网（伪）assrt.net：中文字幕库，按文件名匹配；需要管理员登录后取得 API Token。"""

from __future__ import annotations

from .base import Candidate, ConfigField, Fetched, GuideStep, MediaQuery, Provider, ProviderContext, ProviderError
from .. import text as media_text

API = "https://api.assrt.net/v1"
_ERRORS = {101: "射手网 Token 无效，请检查配置", 20000: "射手网 Token 无效，请检查配置", 30000: "射手网请求过于频繁，请稍后再试",
           30900: "射手网请求过于频繁，请稍后再试"}


class AssrtProvider(Provider):
    id = "assrt"
    name = "射手网（伪）"
    description = "中文字幕资源多，支持按视频文件名匹配发布版本；部分字幕以压缩包提供（支持 ZIP，不支持 RAR／7z）。"
    homepage = "https://assrt.net"
    capabilities = frozenset({"subtitle"})
    media = frozenset({"video"})
    official = False
    interval = 3.0
    fields = (ConfigField("token", "API Token", secret=True, required=True, hint="登录 assrt.net 后在用户面板中查看。每个 Token 每分钟最多约 20 次请求。"),)
    guide = (GuideStep("注册并登录", "在 assrt.net 注册账号并登录。", "https://assrt.net", "打开射手网"),
             GuideStep("取得 Token", "打开用户面板（个人信息页），复制其中的 API Token（一串 32 位字符），粘贴到下方并保存。"),
             GuideStep("测试连接", "保存后点「测试连接」确认 Token 可用。"))
    notice = "射手网（伪）是个人运营的字幕站，接口与可用性没有保证；请自行评估使用条款。"

    def _token(self, ctx: ProviderContext) -> str:
        token = (ctx.config.get("token") or "").strip()
        if not token:
            raise ProviderError("没有配置射手网 Token")
        return token

    async def _get(self, ctx: ProviderContext, path: str, params: dict) -> dict:
        data = await ctx.get_json(f"{API}{path}", params={"token": self._token(ctx), **params})
        if not isinstance(data, dict):
            raise ProviderError("射手网返回的数据格式不正确")
        status = data.get("status", 0)
        if status:
            raise ProviderError(_ERRORS.get(status, f"射手网返回错误（{status}）"))
        return data

    async def search(self, query: MediaQuery, want, ctx: ProviderContext) -> list[Candidate]:
        by_file = len(query.name) >= 3
        keyword = query.name if by_file else (query.title or query.name)
        if len(keyword) < 3:
            keyword = f"{keyword} {query.year}".strip()
        if len(keyword) < 3:
            return []
        data = await self._get(ctx, "/sub/search", {"q": keyword, "cnt": 15, "pos": 0, "is_file": 1 if by_file else 0, "no_muxer": 1})
        results = []
        for item in ((data.get("sub") or {}).get("subs") or []):
            if not isinstance(item, dict) or not item.get("id"):
                continue
            langs = ((item.get("lang") or {}).get("langlist") or {})
            language = "zh-CN" if langs.get("langchs") or langs.get("langdou") else "zh-TW" if langs.get("langcht") else "en" if langs.get("langeng") else None
            description = str((item.get("lang") or {}).get("desc") or "")
            results.append(Candidate("subtitle", str(item.get("native_name") or item.get("videoname") or ""), {"id": int(item["id"])},
                                     subtitle=" · ".join(part for part in (str(item.get("videoname") or ""), str(item.get("release_site") or "")) if part),
                                     language=language, note=" · ".join(part for part in (description, str(item.get("upload_time") or "")[:10]) if part)))
        return results

    async def fetch(self, ref, want, ctx: ProviderContext) -> Fetched:
        data = await self._get(ctx, "/sub/detail", {"id": ref["id"]})
        subs = ((data.get("sub") or {}).get("subs") or [])
        if not subs:
            raise ProviderError("射手网没有返回字幕详情")
        detail = subs[0]
        files = [item for item in detail.get("filelist") or [] if isinstance(item, dict) and item.get("url") and item.get("f")]
        chosen = None
        if files:
            names = [item["f"] for item in files]
            picked = media_text.pick_subtitle(names)
            chosen = next((item for item in files if item["f"] == picked), None)
        url, name = (chosen["url"], chosen["f"]) if chosen else (detail.get("url"), detail.get("filename"))
        if not url:
            raise ProviderError("射手网没有返回下载地址")
        raw, _ = await ctx.get_bytes(url, limit=media_text.TEXT_LIMIT * 4)
        return media_text.normalize_subtitle(raw, name)

    async def test(self, ctx: ProviderContext) -> str:
        data = await self._get(ctx, "/user/quota", {})
        quota = (data.get("user") or {}).get("quota")
        return f"Token 有效，每分钟剩余额度 {quota}" if quota is not None else "Token 有效，连接正常"
