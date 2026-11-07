"""网页静态资源服务。"""

import asyncio
import errno
import mimetypes
import re
from html import escape
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


class StaticFiles:
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
        if encoding:
            headers["Content-Encoding"] = encoding
        if https:
            headers["Strict-Transport-Security"] = "max-age=31536000"
        await send({"type": "http.response.start", "status": 200, "headers": self._headers(headers)})
        await send({"type": "http.response.body", "body": b"" if method == "HEAD" else data})
