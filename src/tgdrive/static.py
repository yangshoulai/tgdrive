"""网页静态资源和管理员文档的独立服务边界。"""

import asyncio
import mimetypes
from pathlib import Path

from .errors import NotFoundError

# 网页（用户端、控制台、文档、分享页）的安全响应头：只允许同源脚本，禁止被其他站点嵌入框架（防点击劫持）。
PAGE_SECURITY_HEADERS = {
    "Content-Security-Policy": ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                                "img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; connect-src 'self'; "
                                "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"),
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
}



class StaticFiles:
    async def _static(self, send, path: str, method: str, *, https: bool = False) -> None:
        assert self.static_dir is not None
        static_dir = Path(self.static_dir)
        # 单页应用：真实存在的文件原样返回，其余路径（/、/docs、/s/<令牌>、/admin/...）都交给 index.html，
        # 由前端按路径和登录账号的角色决定显示什么；管理功能的权限由接口按角色校验，与这里无关。
        relative = path.lstrip("/")
        candidate = (static_dir / relative).resolve() if relative else static_dir / "index.html"
        if static_dir not in candidate.parents and candidate != static_dir:
            await self._send(send, 404, {"error": {"code": "not_found", "message": "资源不存在"}})
            return
        if not candidate.is_file():
            candidate = static_dir / "index.html"
        if not candidate.is_file():
            await self._send(send, 404, {"error": {"code": "not_found", "message": "前端资源未构建"}})
            return
        data = await asyncio.to_thread(candidate.read_bytes)
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        headers = {"Content-Type": content_type, "Content-Length": str(len(data)),
                   "Cache-Control": "no-cache" if candidate.name == "index.html" else "public, max-age=31536000, immutable",
                   **PAGE_SECURITY_HEADERS}
        if https:
            headers["Strict-Transport-Security"] = "max-age=31536000"
        await send({"type": "http.response.start", "status": 200, "headers": self._headers(headers)})
        await send({"type": "http.response.body", "body": b"" if method == "HEAD" else data})

    async def _admin_docs_bundle(self, send, method: str, token: str) -> None:
        """只向管理员会话返回管理员文档代码，避免普通用户从前端 bundle 读取运维内容。"""
        session = self.admin.accounts.sessions.require(token, role="admin")
        self.admin.accounts.account_for_session(session)
        if self.static_dir is None:
            raise NotFoundError("管理员文档未构建")
        candidate = Path(self.static_dir) / "admin-docs.js"
        if not candidate.is_file():
            raise NotFoundError("管理员文档未构建")
        data = await asyncio.to_thread(candidate.read_bytes)
        await self._send_raw(send, 200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-store",
            **PAGE_SECURITY_HEADERS,
        }, b"" if method == "HEAD" else data)

