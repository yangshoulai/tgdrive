"""AWS Signature Version 4 头部和预签名请求验签。"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import re
from dataclasses import dataclass
from urllib.parse import parse_qsl, quote, urlsplit


class SigV4Error(Exception):
    pass


@dataclass(frozen=True)
class SignedRequest:
    access_key_id: str
    region: str
    service: str
    signed_headers: tuple[str, ...]
    canonical_request: str
    # 流式请求体校验需要的上下文：负载模式、种子签名与派生密钥。
    payload_hash: str = "UNSIGNED-PAYLOAD"
    signature: str = ""
    amz_date: str = ""
    scope: str = ""
    signing_key: bytes = b""


_AUTH_RE = re.compile(
    r"^AWS4-HMAC-SHA256 Credential=(?P<credential>[^,]+), SignedHeaders=(?P<headers>[^,]+), Signature=(?P<signature>[0-9a-fA-F]{64})$"
)


def _trim(value: str) -> str:
    return " ".join(value.strip().split())


def _canonical_uri(path: str) -> str:
    return quote(path or "/", safe="/-_.~")


def _canonical_query(query: str, *, omit: set[str] | None = None) -> str:
    excluded = omit or set()
    pairs = [(quote(k, safe="-_.~"), quote(v, safe="-_.~")) for k, v in parse_qsl(query, keep_blank_values=True)
             if k not in excluded]
    return "&".join(f"{key}={value}" for key, value in sorted(pairs))


def _canonical_headers(headers: dict[str, str], signed: list[str]) -> str:
    lowered = {key.lower(): _trim(value) for key, value in headers.items()}
    try:
        return "".join(f"{name}:{lowered[name]}\n" for name in signed)
    except KeyError as exc:
        raise SigV4Error(f"signed header missing: {exc.args[0]}") from exc


def _hmac(key: bytes, value: str | bytes) -> bytes:
    return hmac.new(key, value.encode() if isinstance(value, str) else value, hashlib.sha256).digest()


class SigV4Verifier:
    def __init__(self, *, region: str = "us-east-1", service: str = "s3", max_clock_skew: int = 900) -> None:
        self.region, self.service, self.max_clock_skew = region, service, max_clock_skew

    def _signing_key(self, secret: str, date: str, region: str, service: str) -> bytes:
        key = _hmac(b"AWS4" + secret.encode(), date)
        key = _hmac(key, region)
        key = _hmac(key, service)
        return _hmac(key, "aws4_request")

    def verify(self, method: str, url: str, headers: dict[str, str], body: bytes | None = None,
               *, secret: str, now: dt.datetime | None = None) -> SignedRequest:
        normalized = {key.lower(): value for key, value in headers.items()}
        auth = normalized.get("authorization")
        if not auth:
            raise SigV4Error("missing authorization")
        match = _AUTH_RE.match(auth)
        if not match:
            raise SigV4Error("invalid authorization")
        credential = match.group("credential").split("/")
        if len(credential) != 5 or credential[4] != "aws4_request":
            raise SigV4Error("invalid credential scope")
        access_key, date, region, service, _ = credential
        if region != self.region or service != self.service:
            raise SigV4Error("unsupported region or service")
        amz_date = normalized.get("x-amz-date")
        if not amz_date:
            raise SigV4Error("missing x-amz-date")
        try:
            timestamp = dt.datetime.strptime(amz_date, "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
        except ValueError as exc:
            raise SigV4Error("invalid x-amz-date") from exc
        current = now or dt.datetime.now(dt.timezone.utc)
        if abs((current - timestamp).total_seconds()) > self.max_clock_skew:
            raise SigV4Error("request time outside allowed skew")
        signed = [item.strip().lower() for item in match.group("headers").split(";")]
        if signed != sorted(set(signed)) or "host" not in signed:
            raise SigV4Error("invalid signed headers")
        split = urlsplit(url)
        # 请求体以流的形式到达，签名只依赖声明的负载哈希；声明是否属实由 payload.verified_body 在读取时校验。
        # 未声明时按空请求体处理，读取到任何字节都会校验失败。
        payload_hash = normalized.get("x-amz-content-sha256") or hashlib.sha256(body or b"").hexdigest()
        canonical = "\n".join((method.upper(), _canonical_uri(split.path), _canonical_query(split.query),
                                _canonical_headers(normalized, signed), ";".join(signed), payload_hash))
        canonical_hash = hashlib.sha256(canonical.encode()).hexdigest()
        string_to_sign = "\n".join(("AWS4-HMAC-SHA256", amz_date, "/".join(credential[1:]), canonical_hash))
        signing_key = self._signing_key(secret, date, region, service)
        expected = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, match.group("signature").lower()):
            raise SigV4Error("signature mismatch")
        return SignedRequest(access_key, region, service, tuple(signed), canonical, payload_hash, expected,
                             amz_date, "/".join(credential[1:]), signing_key)

    def verify_presigned(self, method: str, url: str, headers: dict[str, str], *, secret: str,
                         now: dt.datetime | None = None) -> SignedRequest:
        """验证 AWS CLI/boto3 常用的 ``X-Amz-*`` 查询参数签名。"""
        split = urlsplit(url)
        query = dict(parse_qsl(split.query, keep_blank_values=True))
        required = ("X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires",
                    "X-Amz-SignedHeaders", "X-Amz-Signature")
        if any(name not in query for name in required) or query["X-Amz-Algorithm"] != "AWS4-HMAC-SHA256":
            raise SigV4Error("invalid presigned parameters")
        try:
            credential = query["X-Amz-Credential"].split("/")
            expires = int(query["X-Amz-Expires"])
            timestamp = dt.datetime.strptime(query["X-Amz-Date"], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
        except (ValueError, IndexError) as exc:
            raise SigV4Error("invalid presigned credential") from exc
        if len(credential) != 5 or credential[4] != "aws4_request" or not 1 <= expires <= 604800:
            raise SigV4Error("invalid presigned scope or expiry")
        current = now or dt.datetime.now(dt.timezone.utc)
        age = (current - timestamp).total_seconds()
        if age < -self.max_clock_skew or age > expires:
            raise SigV4Error("presigned request expired or not yet valid")
        if credential[2] != self.region or credential[3] != self.service:
            raise SigV4Error("unsupported region or service")
        signed = [item.strip().lower() for item in query["X-Amz-SignedHeaders"].split(";")]
        if signed != sorted(set(signed)) or "host" not in signed:
            raise SigV4Error("invalid signed headers")
        normalized = {key.lower(): value for key, value in headers.items()}
        canonical_query = _canonical_query(split.query, omit={"X-Amz-Signature"})
        canonical = "\n".join((method.upper(), _canonical_uri(split.path), canonical_query,
                                _canonical_headers(normalized, signed), ";".join(signed), "UNSIGNED-PAYLOAD"))
        string_to_sign = "\n".join(("AWS4-HMAC-SHA256", query["X-Amz-Date"], "/".join(credential[1:]),
                                    hashlib.sha256(canonical.encode()).hexdigest()))
        expected = hmac.new(self._signing_key(secret, credential[1], credential[2], credential[3]),
                            string_to_sign.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, query["X-Amz-Signature"].lower()):
            raise SigV4Error("signature mismatch")
        return SignedRequest(credential[0], credential[2], credential[3], tuple(signed), canonical)
