"""可嵌入的 S3 兼容子集处理器。

它使用一个小的请求/响应接口，不绑定 FastAPI，便于先进行本地互操作测试；
HTTP 框架只需把请求字段转成 ``handle`` 参数即可。
"""

from __future__ import annotations

import datetime as dt
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from email.utils import formatdate
from urllib.parse import parse_qs, unquote, urlsplit
from xml.etree import ElementTree
from xml.sax.saxutils import escape

from ..errors import NotFoundError, NotReadyError, QuotaExceededError
from ..objects import ObjectService, Scope
from .auth import ClientAuthStore
from .payload import (
    ChunkSigningContext,
    PayloadError,
    as_stream,
    limit_size,
    read_all,
    verified_body,
)
from .sigv4 import SignedRequest, SigV4Error, SigV4Verifier


class InvalidAccessKeyError(SigV4Error):
    """Access Key 不存在、被禁用或客户端已禁用。"""


class S3Error(Exception):
    """直接映射为 S3 错误码的请求错误。"""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def _local(tag: str) -> str:
    # 客户端（如 botocore）会给请求 XML 加 S3 命名空间，解析时只比较本地名。
    return tag.rsplit("}", 1)[-1]


def _parse_xml(body: bytes, root_name: str) -> ElementTree.Element:
    try:
        root = ElementTree.fromstring(body)
    except ElementTree.ParseError as exc:
        raise S3Error("MalformedXML", "request XML is not well-formed") from exc
    if _local(root.tag) != root_name:
        raise S3Error("MalformedXML", f"expected <{root_name}> document")
    return root


def _child_text(node: ElementTree.Element, name: str) -> str | None:
    for child in node:
        if _local(child.tag) == name:
            return child.text or ""
    return None


def _http_date(timestamp: float) -> str:
    return dt.datetime.fromtimestamp(timestamp, dt.UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")


# 与 S3 一致：单次 PutObject 与单个分段最大 5 GiB；XML 请求体（批量删除、完成分段上传）最大 2 MiB。
MAX_OBJECT_PUT = 5 * 1024 ** 3
MAX_XML_BODY = 2 * 1024 * 1024


@dataclass(frozen=True)
class S3Response:
    status: int
    headers: dict[str, str]
    body: bytes = b""
    # GetObject 的响应体以流发送，不在内存中拼接完整对象。
    stream: AsyncIterator[bytes] | None = field(default=None, compare=False)


class S3Gateway:
    def __init__(self, objects: ObjectService, auth: ClientAuthStore, *, region: str = "us-east-1") -> None:
        self.objects, self.auth = objects, auth
        self.verifier = SigV4Verifier(region=region)

    @staticmethod
    def _xml(tag: str, values: dict[str, str]) -> bytes:
        content = "".join(f"<{key}>{escape(value)}</{key}>" for key, value in values.items())
        return f"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<{tag}>{content}</{tag}>".encode()

    @staticmethod
    def _error(code: str, message: str, status: int) -> S3Response:
        body = S3Gateway._xml("Error", {"Code": code, "Message": message})
        return S3Response(status, {"Content-Type": "application/xml", "Content-Length": str(len(body))}, body)

    def _bucket_id(self, name: str) -> int:
        # ObjectService 保持业务校验，这里只做网关路径到内部 ID 的映射。
        row = self.objects.metadata.db.execute("SELECT id FROM buckets WHERE name=?", (name,)).fetchone()
        if row is None:
            raise KeyError(name)
        return int(row["id"])

    def _authenticate(self, method: str, url: str, headers: dict[str, str]) -> tuple[object, SignedRequest]:
        lower = {k.lower(): v for k, v in headers.items()}
        credential = None
        authorization = lower.get("authorization", "")
        if authorization.startswith("AWS4-HMAC-SHA256"):
            match = re.search(r"Credential=([^/,]+)", authorization)
            credential = match.group(1) if match else None
        else:
            query = dict(parse_qs(urlsplit(url).query))
            values = query.get("X-Amz-Credential")
            credential = values[0].split("/", 1)[0] if values else None
        if not credential:
            raise SigV4Error("missing credential")
        try:
            principal, secret = self.auth.secret_for(credential)
        except NotFoundError as exc:
            raise InvalidAccessKeyError("invalid access key") from exc
        if authorization.startswith("AWS4-HMAC-SHA256"):
            signed = self.verifier.verify(method, url, headers, secret=secret)
        else:
            signed = self.verifier.verify_presigned(method, url, headers, secret=secret)
        return principal, signed

    @staticmethod
    def _body(signed: SignedRequest, lower: dict[str, str], raw: AsyncIterator[bytes], limit: int) -> AsyncIterator[bytes]:
        """按签名声明的负载模式解码并校验请求体，同时限制大小。"""
        signing = (ChunkSigningContext(signed.signing_key, signed.amz_date, signed.scope, signed.signature)
                   if signed.signing_key else None)
        return limit_size(verified_body(raw, signed.payload_hash, signing=signing, trailer=lower.get("x-amz-trailer")), limit)

    @staticmethod
    def _declared_size(lower: dict[str, str], signed: SignedRequest) -> int | None:
        value = lower.get("x-amz-decoded-content-length") if signed.payload_hash.startswith("STREAMING-") else lower.get("content-length")
        try:
            size = int(value) if value is not None else None
        except ValueError as exc:
            raise S3Error("InvalidArgument", "invalid content length") from exc
        if size is not None and size > MAX_OBJECT_PUT:
            # 在读取请求体之前拒绝，避免先传输 5 GiB 再失败。
            raise S3Error("EntityTooLarge", "a single PutObject or part is limited to 5 GiB")
        return size

    def _copy_source(self, principal, lower: dict[str, str]):
        """解析并授权 x-amz-copy-source，返回源对象的 (scope, key, info)。"""
        raw = lower["x-amz-copy-source"]
        source, _, query = raw.partition("?")
        version = parse_qs(query).get("versionId", ["null"])[0]
        if version != "null":
            raise S3Error("NotImplemented", "object versioning is not supported", 501)
        source = unquote(source).lstrip("/")
        bucket_name, _, key = source.partition("/")
        if key.startswith(".tgdrive/"):
            raise PermissionError("reserved path")
        if not bucket_name or not key:
            raise S3Error("InvalidArgument", "x-amz-copy-source must be bucket/key")
        try:
            bucket_id = self._bucket_id(bucket_name)
        except KeyError as exc:
            raise S3Error("NoSuchBucket", "source bucket does not exist", 404) from exc
        grant = self.auth.authorize(principal, bucket_id, key, write=False)
        scope = Scope(bucket_id, grant.prefix, grant.perms)
        info = self.objects.head_object(scope, key)
        etag = f'"{info.etag}"'
        if_match = lower.get("x-amz-copy-source-if-match")
        if_none_match = lower.get("x-amz-copy-source-if-none-match")
        if if_match and if_match not in (etag, info.etag, "*"):
            raise S3Error("PreconditionFailed", "x-amz-copy-source-if-match did not match", 412)
        if if_none_match and if_none_match in (etag, info.etag, "*"):
            raise S3Error("PreconditionFailed", "x-amz-copy-source-if-none-match matched", 412)
        return scope, key, info

    @staticmethod
    def _part_number(params: dict[str, list[str]]) -> int:
        try:
            number = int(params["partNumber"][0])
        except ValueError as exc:
            raise S3Error("InvalidArgument", "partNumber must be an integer") from exc
        if not 1 <= number <= 10000:
            raise S3Error("InvalidArgument", "partNumber must be between 1 and 10000")
        return number

    async def _copy_object(self, principal, lower, scope: Scope, bucket_name: str, key: str) -> S3Response:
        src_scope, src_key, source = self._copy_source(principal, lower)
        directive = lower.get("x-amz-metadata-directive", "COPY").upper()
        if directive not in ("COPY", "REPLACE"):
            raise S3Error("InvalidArgument", "x-amz-metadata-directive must be COPY or REPLACE")
        if src_scope.bucket_id == scope.bucket_id and src_key == key and directive == "COPY":
            raise S3Error("InvalidRequest", "This copy request is illegal because it is trying to copy an object "
                                            "to itself without changing the object's metadata.")
        metadata = content_type = None
        if directive == "REPLACE":
            metadata = {name[len("x-amz-meta-"):]: value for name, value in lower.items() if name.startswith("x-amz-meta-")}
            content_type = lower.get("content-type") or source.content_type
        info = await self.objects.copy_object(src_scope, src_key, scope, key, metadata=metadata, content_type=content_type)
        body = self._xml("CopyObjectResult", {"LastModified": _http_date(info.modified_at), "ETag": f'"{info.etag}"'})
        return S3Response(200, {"Content-Type": "application/xml", "Content-Length": str(len(body))}, body)

    async def _upload_part_copy(self, principal, lower, scope: Scope, upload_id: str, part_no: int) -> S3Response:
        src_scope, src_key, source = self._copy_source(principal, lower)
        start, end = 0, source.size
        requested = lower.get("x-amz-copy-source-range")
        if requested:
            match = re.fullmatch(r"bytes=(\d+)-(\d+)", requested.strip())
            if not match or int(match.group(1)) > int(match.group(2)) or int(match.group(2)) >= source.size:
                raise S3Error("InvalidArgument", "x-amz-copy-source-range is not valid for the source object")
            start, end = int(match.group(1)), int(match.group(2)) + 1
        # 分段需要成为新 Blob 的一部分，因此以流的形式解密源范围并重新加密写入。
        _, stream = await self.objects.get_object(src_scope, src_key, start, end)
        part = await self.objects.upload_part(scope, upload_id, part_no, stream, end - start)
        body = self._xml("CopyPartResult", {"LastModified": _http_date(part.uploaded_at), "ETag": f'"{part.etag}"'})
        return S3Response(200, {"Content-Type": "application/xml", "Content-Length": str(len(body))}, body)

    async def _delete_objects(self, principal, bucket_id: int, body: bytes) -> S3Response:
        root = _parse_xml(body, "Delete")
        quiet = (_child_text(root, "Quiet") or "").strip().lower() == "true"
        entries = [child for child in root if _local(child.tag) == "Object"]
        if not entries or len(entries) > 1000:
            raise S3Error("MalformedXML", "Delete must list between 1 and 1000 objects")
        fragments: list[str] = []
        for entry in entries:
            key = _child_text(entry, "Key")
            if not key:
                raise S3Error("MalformedXML", "every Object must have a Key")
            # 每个键单独授权、单独提交：一个键失败不影响其他键，与 S3 的逐项结果一致。
            code = message = None
            version = _child_text(entry, "VersionId")
            if version not in (None, "null"):
                code, message = "NotImplemented", "object versioning is not supported"
            else:
                try:
                    grant = self.auth.authorize(principal, bucket_id, key, write=True)
                    await self.objects.delete_objects(Scope(bucket_id, grant.prefix, grant.perms), [key])
                except PermissionError:
                    code, message = "AccessDenied", "access denied"
                except ValueError as exc:
                    code, message = "InvalidArgument", str(exc)
            if code:
                fragments.append(f"<Error><Key>{escape(key)}</Key><Code>{code}</Code><Message>{escape(message or '')}</Message></Error>")
            elif not quiet:
                fragments.append(f"<Deleted><Key>{escape(key)}</Key></Deleted>")
        xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
               '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' + "".join(fragments) + "</DeleteResult>").encode()
        return S3Response(200, {"Content-Type": "application/xml", "Content-Length": str(len(xml))}, xml)

    async def handle(self, method: str, url: str, headers: dict[str, str],
                     body: bytes | AsyncIterator[bytes] = b"") -> S3Response:
        lower = {name.lower(): value for name, value in headers.items()}
        try:
            principal, signed = self._authenticate(method, url, headers)
            raw = as_stream(body)
            body_stream = lambda limit: self._body(signed, lower, raw, limit)
            split = urlsplit(url)
            path = split.path.strip("/")
            pieces = path.split("/", 1) if path else []
            if not pieces:
                params = parse_qs(split.query, keep_blank_values=True)
                if method != "GET":
                    return self._error("InvalidURI", "bucket is required", 400)
                bucket_rows = self.objects.metadata.db.execute(
                    "SELECT DISTINCT b.name FROM buckets b JOIN client_grants g ON g.bucket_id=b.id "
                    "JOIN clients c ON c.id=g.client_id WHERE c.id=? AND c.status='active' ORDER BY b.name",
                    (principal.client_id,),
                )
                entries = "".join(f"<Bucket><Name>{escape(row['name'])}</Name></Bucket>" for row in bucket_rows)
                xml = ("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
                       f"<ListAllMyBucketsResult><Buckets>{entries}</Buckets></ListAllMyBucketsResult>").encode()
                return S3Response(200, {"Content-Type": "application/xml", "Content-Length": str(len(xml))}, xml)
            bucket_name = unquote(pieces[0])
            key = unquote(pieces[1]) if len(pieces) > 1 else ""
            # .tgdrive/ 是系统保留区（回收站等），S3 客户端不能读写或列出。
            if key.startswith(".tgdrive/") or key == ".tgdrive" or parse_qs(split.query).get("prefix", [""])[0].startswith(".tgdrive"):
                raise PermissionError("reserved path")
            bucket_id = self._bucket_id(bucket_name)
            params = parse_qs(split.query, keep_blank_values=True)
            grants = self.auth.grants(principal.client_id, bucket_id)
            if not grants:
                raise PermissionError("no grant")
            if key:
                write = method in ("PUT", "POST", "DELETE")
                grant = self.auth.authorize(principal, bucket_id, key, write=write)
                scope = Scope(bucket_id, grant.prefix, grant.perms)
            else:
                # List 请求必须显式限制在某个授权前缀内；多个 grant 时返回其并集不在本子集中。
                grant = max(grants, key=lambda item: len(item.prefix))
                scope = Scope(bucket_id, grant.prefix, grant.perms)
            upload_id = params.get("uploadId", [None])[0]
            if method == "HEAD" and not key:
                return S3Response(200, {"Content-Length": "0"})
            if method == "POST" and not key and "delete" in params:
                return await self._delete_objects(principal, bucket_id, await read_all(body_stream(MAX_XML_BODY), MAX_XML_BODY))
            if method == "GET" and not key and "location" in params:
                xml = ("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
                       f"<LocationConstraint>{escape(self.verifier.region)}</LocationConstraint>").encode()
                return S3Response(200, {"Content-Type": "application/xml", "Content-Length": str(len(xml))}, xml)
            if method == "POST" and key and "uploads" in params:
                upload_id = await self.objects.create_multipart(scope, key, headers.get("Content-Type"))
                return S3Response(200, {"Content-Type": "application/xml"},
                                  self._xml("InitiateMultipartUploadResult", {"Bucket": bucket_name, "Key": key, "UploadId": upload_id}))
            # 带 x-amz-copy-source 的 PUT 是复制请求，请求体为空，绝不能按普通上传写入。
            if upload_id and method == "PUT" and key and "partNumber" in params and "x-amz-copy-source" in lower:
                return await self._upload_part_copy(principal, lower, scope, upload_id, self._part_number(params))
            if upload_id and method == "PUT" and key and "partNumber" in params:
                part = await self.objects.upload_part(scope, upload_id, self._part_number(params),
                                                      body_stream(MAX_OBJECT_PUT), self._declared_size(lower, signed))
                return S3Response(200, {"ETag": f'"{part.etag}"', "Content-Length": "0"})
            if upload_id and method == "POST" and key:
                xml_body = await read_all(body_stream(MAX_XML_BODY), MAX_XML_BODY)
                root = _parse_xml(xml_body or b"<CompleteMultipartUpload/>", "CompleteMultipartUpload")
                parts = []
                for node in root:
                    if _local(node.tag) == "Part":
                        parts.append((int(_child_text(node, "PartNumber") or "0"), (_child_text(node, "ETag") or "").strip('"')))
                info = await self.objects.complete_multipart(scope, upload_id, parts)
                return S3Response(200, {"Content-Type": "application/xml"},
                                  self._xml("CompleteMultipartUploadResult", {"Bucket": bucket_name, "Key": key, "ETag": f'"{info.etag}"'}))
            if upload_id and method == "DELETE" and key:
                await self.objects.abort_multipart(scope, upload_id)
                return S3Response(204, {"Content-Length": "0"})
            if method == "GET" and key:
                size = self.objects.head_object(scope, key).size
                start, end = self._range(headers.get("Range") or headers.get("range"), size)
                stop = size if end is None else end
                info, stream = await self.objects.get_object(scope, key, start, stop)
                response_headers = {"ETag": f'"{info.etag}"', "Content-Length": str(stop - start),
                                    "Last-Modified": formatdate(info.modified_at, usegmt=True), "Accept-Ranges": "bytes",
                                    "Content-Type": info.content_type or "application/octet-stream", "X-Content-Type-Options": "nosniff"}
                if start != 0 or end is not None:
                    response_headers["Content-Range"] = f"bytes {start}-{stop - 1}/{info.size}"
                    return S3Response(206, response_headers, stream=stream)
                return S3Response(200, response_headers, stream=stream)
            if method == "HEAD" and key:
                info = self.objects.head_object(scope, key)
                return S3Response(200, {"ETag": f'"{info.etag}"', "Content-Length": str(info.size),
                                        "Last-Modified": formatdate(info.modified_at, usegmt=True),
                                        "Content-Type": info.content_type or "application/octet-stream"})
            if method == "PUT" and key and "x-amz-copy-source" in lower:
                return await self._copy_object(principal, lower, scope, bucket_name, key)
            if method == "PUT" and key:
                info = await self.objects.put_object(scope, key, body_stream(MAX_OBJECT_PUT), self._declared_size(lower, signed),
                                                     lower.get("content-type"))
                return S3Response(200, {"ETag": f'"{info.etag}"', "Content-Length": "0"})
            if method == "DELETE" and key:
                await self.objects.delete_objects(scope, [key])
                return S3Response(204, {"Content-Length": "0"})
            if method == "GET" and not key and params.get("list-type") == ["2"]:
                prefix = params.get("prefix", [""])[0]
                # 与 S3 一致：未提供 delimiter 时递归列出前缀下的全部对象，不做分组。
                delimiter = params.get("delimiter", [""])[0] or None
                max_keys = max(1, min(int(params.get("max-keys", ["1000"])[0]), 1000))
                page = await self.objects.alist_objects(scope, prefix, delimiter,
                                                        params.get("continuation-token", [None])[0], max_keys)
                fragments = ["<Name>" + escape(bucket_name) + "</Name>", "<KeyCount>" + str(len(page.objects) + len(page.common_prefixes)) + "</KeyCount>"]
                fragments.extend(f"<Contents><Key>{escape(item.key)}</Key><LastModified>{_http_date(item.modified_at)}</LastModified>"
                                 f"<ETag>&quot;{escape(item.etag)}&quot;</ETag><Size>{item.size}</Size>"
                                 "<StorageClass>STANDARD</StorageClass></Contents>" for item in page.objects)
                fragments.extend(f"<CommonPrefixes><Prefix>{escape(prefix)}</Prefix></CommonPrefixes>" for prefix in page.common_prefixes)
                fragments.append(f"<Prefix>{escape(prefix)}</Prefix><MaxKeys>{max_keys}</MaxKeys>"
                                 f"<IsTruncated>{'true' if page.next_cursor else 'false'}</IsTruncated>")
                if delimiter:
                    fragments.append(f"<Delimiter>{escape(delimiter)}</Delimiter>")
                if page.next_cursor:
                    fragments.append(f"<NextContinuationToken>{escape(page.next_cursor)}</NextContinuationToken>")
                xml = ("<?xml version=\"1.0\" encoding=\"UTF-8\"?>" + "<ListBucketResult>" + "".join(fragments) + "</ListBucketResult>").encode()
                return S3Response(200, {"Content-Type": "application/xml", "Content-Length": str(len(xml))}, xml)
            return self._error("NotImplemented", "operation is outside tgdrive S3 subset", 501)
        except (S3Error, PayloadError) as exc:
            return self._error(exc.code, exc.message, exc.status)
        except KeyError:
            return self._error("NoSuchBucket", "bucket does not exist", 404)
        except PermissionError:
            return self._error("AccessDenied", "access denied", 403)
        except NotFoundError:
            return self._error("NoSuchKey", "object does not exist", 404)
        except QuotaExceededError:
            return self._error("QuotaExceeded", "the bucket storage quota would be exceeded", 403)
        except NotReadyError:
            return self._error("ServiceUnavailable", "service is locked", 503)
        except ValueError as exc:
            return self._error("InvalidRequest", str(exc), 400)
        except InvalidAccessKeyError:
            return self._error("InvalidAccessKeyId", "access key is invalid or disabled", 403)
        except SigV4Error:
            return self._error("SignatureDoesNotMatch", "signature verification failed", 403)
        except Exception as exc:
            return self._error("InternalError", str(exc), 500)

    @staticmethod
    def _range(value: str | None, size: int) -> tuple[int, int | None]:
        if not value:
            return 0, None
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip())
        if not match:
            raise ValueError("invalid range")
        left, right = match.groups()
        if not left:
            suffix = int(right)
            return max(0, size - suffix), None
        start = int(left)
        end = int(right) + 1 if right else None
        if start >= size or (end is not None and end <= start):
            raise ValueError("range unsatisfiable")
        return start, min(end, size) if end is not None else None
