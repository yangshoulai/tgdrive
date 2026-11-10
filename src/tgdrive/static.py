"""网页静态资源服务。"""

import asyncio
import errno
import mimetypes
import re
from html import escape, unescape
from pathlib import Path

from .settings import normalize_origin

# 网页（用户端、控制台、文档、分享页）的安全响应头：只允许同源脚本，禁止被其他站点嵌入框架（防点击劫持）。
# wasm-unsafe-eval 只允许编译 WebAssembly（HEIC 图片解码器），不放开 eval 与内联脚本。
# connect-src 的 blob: 只用于读取页面自己创建的 Blob 地址（视频播放器按地址加载字幕），不放开任何外部来源。
PAGE_SECURITY_HEADERS = {
    "Content-Security-Policy": ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
                                "img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; connect-src 'self' blob:; "
                                "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"),
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
}



def _accepts(header: str, coding: str) -> bool:
    """Accept-Encoding 是否接受某种编码（q=0 表示拒绝）。"""
    for part in header.lower().split(","):
        name, _, params = part.strip().partition(";")
        if name.strip() == coding:
            quality = params.strip()
            return not (quality.startswith("q=") and quality[2:].strip() in ("0", "0.0", "0.00", "0.000"))
    return False


def _set_meta(html: str, attribute: str, name: str, value: str) -> str:
    return re.sub(rf'(<meta {attribute}="{re.escape(name)}" content=")[^"]*(")',
                  lambda match: match[1] + escape(value, quote=True) + match[2], html, count=1)


def apply_share_card(html: str, card: dict) -> str:
    """把分享链接自己的标题、说明与封面写进 index.html 的 Open Graph／Twitter 元信息（爬虫不执行脚本）。

    card：title（页面标题，不含站点名）、description、path（分享页路径，令牌无效时省略、保持首页）、image（站内封面路径，可省略，
    省略时保留站点默认卡片）、large（封面是否适合大图卡片）。站点名取自构建产物里的 og:site_name。"""
    site = re.search(r'<meta property="og:site_name" content="([^"]*)"', html)
    site_name = unescape(site[1]) if site else ""
    title = f"{card['title']} · {site_name}" if site_name else card["title"]
    html = re.sub(r"<title>[^<]*</title>", lambda _: f"<title>{escape(title, quote=False)}</title>", html, count=1)
    for attribute, name, value in (("name", "description", card["description"]), ("property", "og:title", card["title"]),
                                   ("property", "og:description", card["description"]), ("property", "og:url", card.get("path") or "/"),
                                   ("name", "twitter:title", card["title"]), ("name", "twitter:description", card["description"]),
                                   ("property", "og:image:alt", card["title"]), ("name", "twitter:image:alt", card["title"])):
        html = _set_meta(html, attribute, name, value)
    if card.get("image"):
        # 封面尺寸因文件而异，去掉站点卡片的固定宽高与类型，由爬虫自行读取。
        html = re.sub(r'<meta property="og:image:(?:type|width|height)" content="[^"]*">', "", html)
        html = _set_meta(html, "property", "og:image", card["image"])
        html = _set_meta(html, "name", "twitter:image", card["image"])
        html = _set_meta(html, "name", "twitter:card", "summary_large_image" if card.get("large") else "summary")
    return html


class StaticFiles:
    async def _share_card(self, path: str) -> dict | None:
        """分享页（/s/、/m/）的链接预览信息；应用在 asgi.py 中实现，默认不改写。"""
        return None

    async def _static(self, send, path: str, method: str, *, https: bool = False, origin: str = "",
                      accept_encoding: str = "") -> None:
        assert self.static_dir is not None
        static_dir = Path(self.static_dir)
        # 单页应用：真实存在的文件原样返回，其余路径（/、/docs、/s/<令牌>、/admin/...）都交给 index.html，
        # 由前端按路径和登录账号的角色决定显示什么；管理功能的权限由接口按角色校验，与这里无关。
        relative = path.lstrip("/")
        try:
            candidate = (static_dir / relative).resolve() if relative else static_dir / "index.html"
            if static_dir not in candidate.parents and candidate != static_dir:
                await self._send(send, 404, {"error": {"code": "not_found", "message": "资源不存在"}})
                return
            exists = candidate.is_file()
        except OSError as error:
            if error.errno not in (errno.ENAMETOOLONG, errno.EINVAL):
                raise
            await self._send(send, 404, {"error": {"code": "not_found", "message": "资源不存在"}})
            return
        if not exists:
            candidate = static_dir / "index.html"
        if not candidate.is_file():
            await self._send(send, 404, {"error": {"code": "not_found", "message": "前端资源未构建"}})
            return
        # 构建时预压缩的 .br／.gz（build-apps.mjs）：浏览器支持时直接返回，主包体积约为原来的四分之一。
        encoding = None
        if candidate.name != "index.html":
            for name, suffix in (("br", ".br"), ("gzip", ".gz")):
                if _accepts(accept_encoding, name) and (encoded := candidate.with_name(candidate.name + suffix)).is_file():
                    candidate_data, encoding = encoded, name
                    break
        data = await asyncio.to_thread((candidate_data if encoding else candidate).read_bytes)
        if candidate.name == "index.html":
            if candidate == static_dir / "index.html" and (card := await self._share_card(path)):
                data = apply_share_card(data.decode("utf-8"), card).encode("utf-8")
            # 爬虫不执行应用脚本；在原始 HTML 中使用部署地址，兼容未配置地址的首次部署。
            try:
                origin = normalize_origin(self.settings.get("public_base_url") or origin, "站点地址") or ""
            except ValueError:
                origin = ""
            if origin:
                html = data.decode("utf-8")
                html = re.sub(r'(<meta (?:property="og:(?:url|image)"|name="twitter:image") content=")(/[^\"]*)(")',
                              lambda match: match[1] + escape(origin + match[2], quote=True) + match[3], html)
                data = html.encode("utf-8")
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        headers = {"Content-Type": content_type, "Content-Length": str(len(data)),
                   # sw.js 的地址固定，必须每次校验，浏览器才能及时取得新版本（其余资源文件名带内容哈希）。
                   "Cache-Control": "no-cache" if candidate.name in ("index.html", "sw.js") else "public, max-age=31536000, immutable",
                   **PAGE_SECURITY_HEADERS}
        if candidate.name != "index.html":
            headers["Vary"] = "Accept-Encoding"
        if candidate == static_dir / "grabber" / "index.html":
            # 只有无 Cookie、无普通网页会话的脚本解锁入口允许嵌入；主站继续禁止被第三方嵌入。
            headers["Content-Security-Policy"] = PAGE_SECURITY_HEADERS["Content-Security-Policy"].replace("frame-ancestors 'none'", "frame-ancestors *")
            headers.pop("X-Frame-Options", None)
            headers["Referrer-Policy"] = "no-referrer"
        if encoding:
            headers["Content-Encoding"] = encoding
        if https:
            headers["Strict-Transport-Security"] = "max-age=31536000"
        await send({"type": "http.response.start", "status": 200, "headers": self._headers(headers)})
        await send({"type": "http.response.body", "body": b"" if method == "HEAD" else data})
