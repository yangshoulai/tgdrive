"""S3 兼容层基础组件。"""

from .auth import ClientAuthStore, ClientGrant, ClientPrincipal
from .chunked import decode_aws_chunked
from .gateway import S3Gateway, S3Response
from .sigv4 import SigV4Error, SigV4Verifier, SignedRequest

__all__ = ["ClientAuthStore", "ClientGrant", "ClientPrincipal", "S3Gateway", "S3Response",
           "SigV4Error", "SigV4Verifier", "SignedRequest", "decode_aws_chunked"]
