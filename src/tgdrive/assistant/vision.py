"""识图：把图片交给声明支持图片输入的模型（docs/assistant-design.md §22）。

优先发送浏览器生成并加密保存的 poster 预览图（≤320 KB、约 960px），服务端不解码用户图片；
没有预览图时只发送体积不超过上限的 JPEG／PNG／WebP／GIF 原图。类型按文件头判定，不信任扩展名。
"""

from __future__ import annotations

from ..errors import NotFoundError
from ..filekinds import kind_of
from ..objects import ObjectService, Scope

# 原图上限：默认 4 MB，管理员可调到 10 MB（各家接口对单张图片的限制在 5–20 MB 之间）。
DEFAULT_ORIGINAL_BYTES = 4 * 1024 * 1024
MAX_ORIGINAL_BYTES = 10 * 1024 * 1024
# 估算上下文时每张图片按固定 token 计，不按 base64 长度计算。
IMAGE_TOKENS = 1000


class ImageUnavailable(ValueError):
    """图片无法交给模型（原因可直接展示给用户与模型）。"""


class NotAnImage(ImageUnavailable):
    """引用的文件不是图片：随消息附带时直接忽略。"""


def sniff(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def is_image(key: str, content_type: str | None) -> bool:
    return kind_of(key, content_type) == "image"


async def load_image(objects: ObjectService, bucket_id: int, key: str, *, max_bytes: int = DEFAULT_ORIGINAL_BYTES) -> dict:
    """返回 {"mime", "data", "source", "size"}；不能发送时抛 ImageUnavailable。调用方负责授权（作用域或附件白名单）。"""
    if not key or key.endswith("/") or key.startswith(".tgdrive"):
        raise ImageUnavailable("该路径不能读取")
    scope = Scope(bucket_id, "")
    try:
        info = objects.head_object(scope, key)
    except NotFoundError as exc:
        raise ImageUnavailable(f"找不到图片 /{key}") from exc
    if not is_image(key, info.content_type):
        raise NotAnImage(f"/{key} 不是图片")
    try:
        data, _, _ = await objects.metadata.run_in_thread(objects.get_thumbnail, scope, key, "poster")
        mime = sniff(data)
        if mime:
            return {"mime": mime, "data": data, "source": "poster", "size": info.size}
    except NotFoundError:
        pass
    if info.size > max(1, min(max_bytes, MAX_ORIGINAL_BYTES)):
        raise ImageUnavailable(f"/{key} 还没有预览图，原图又超过 {max_bytes // (1024 * 1024)} MB。"
                               "请在文件页打开所在文件夹，等待预览图生成后再试")
    _, stream = await objects.get_object(scope, key)
    chunks = []
    async for chunk in stream:
        chunks.append(chunk)
    data = b"".join(chunks)
    mime = sniff(data)
    if mime is None:
        raise ImageUnavailable(f"/{key} 的格式不受支持（只支持 JPEG、PNG、WebP、GIF），也还没有预览图。"
                               "请在文件页打开所在文件夹生成预览图后再试")
    return {"mime": mime, "data": data, "source": "original", "size": info.size}
