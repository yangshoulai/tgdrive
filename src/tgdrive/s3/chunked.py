"""AWS chunked 请求体的基础解码器。"""

from __future__ import annotations

from .sigv4 import SigV4Error


def decode_aws_chunked(body: bytes, *, max_size: int = 1 << 40) -> bytes:
    """解码带 ``chunk-signature`` 扩展的 HTTP chunked body。

    签名链由网关的 SigV4 层验证；此函数负责严格解析边界、拒绝截断和
    超过配置上限的请求，避免把传输编码字节直接交给对象服务。
    """
    cursor = 0
    output = bytearray()
    while True:
        line_end = body.find(b"\r\n", cursor)
        if line_end < 0:
            raise SigV4Error("invalid aws-chunked framing")
        line = body[cursor:line_end]
        cursor = line_end + 2
        size_text = line.split(b";", 1)[0]
        try:
            size = int(size_text, 16)
        except ValueError as exc:
            raise SigV4Error("invalid aws-chunked size") from exc
        if size < 0 or len(output) + size > max_size or cursor + size > len(body):
            raise SigV4Error("invalid aws-chunked length")
        if size:
            output.extend(body[cursor:cursor + size])
        cursor += size
        if size > 0:
            if body[cursor:cursor + 2] != b"\r\n":
                raise SigV4Error("missing aws-chunked terminator")
            cursor += 2
        if size == 0:
            # 可选尾部 header 直到空行；只保留 framing，不解释未声明的尾部字段。
            trailer_end = body.find(b"\r\n\r\n", cursor)
            if trailer_end >= 0:
                cursor = trailer_end + 4
            elif cursor != len(body):
                raise SigV4Error("invalid aws-chunked trailers")
            if cursor != len(body):
                raise SigV4Error("unexpected bytes after aws-chunked body")
            return bytes(output)
