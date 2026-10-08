"""tgdrive v2.0 加密格式实现。

分片头为 `[version:1][salt:16]`，之后是独立 AES-GCM 帧。分片序号和
末片标志不进入派生信息，因 S3 multipart 的 part 可以乱序到达。
"""

from __future__ import annotations

import os
import struct
from dataclasses import dataclass
from typing import Final

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id

from .errors import IntegrityError, WrongPassphrase

FORMAT_VERSION: Final = 1
SALT_SIZE: Final = 16
NONCE_SIZE: Final = 12
TAG_SIZE: Final = 16
HEADER_SIZE: Final = 1 + SALT_SIZE
CHECK_TEXT: Final = b"tgdrive-kek-check"


@dataclass(frozen=True)
class KdfParams:
    iterations: int = 3
    memory_kib: int = 65536
    lanes: int = 4

    def as_dict(self) -> dict[str, int]:
        return {"iterations": self.iterations, "memory_kib": self.memory_kib, "lanes": self.lanes}


@dataclass(frozen=True)
class FileKey:
    dek: bytes
    blob_uuid: bytes
    frame_size: int

    def __post_init__(self) -> None:
        if len(self.dek) != 32 or not self.blob_uuid or self.frame_size <= 0:
            raise ValueError("invalid file key")


def _blob_bytes(blob_uuid: bytes | str) -> bytes:
    if isinstance(blob_uuid, bytes):
        return blob_uuid
    return blob_uuid.encode("ascii")


def n_frames(plain_size: int, frame_size: int) -> int:
    if plain_size < 0 or frame_size <= 0:
        raise ValueError("plain_size must be non-negative and frame_size positive")
    return max(1, (plain_size + frame_size - 1) // frame_size)


def cipher_size(plain_size: int, frame_size: int) -> int:
    return HEADER_SIZE + plain_size + n_frames(plain_size, frame_size) * TAG_SIZE


def derive_kek(passphrase: str | bytes, salt: bytes, params: KdfParams = KdfParams()) -> bytes:
    raw = passphrase.encode() if isinstance(passphrase, str) else passphrase
    return Argon2id(salt=salt, length=32, iterations=params.iterations,
                    memory_cost=params.memory_kib, lanes=params.lanes).derive(raw)


def _chunk_key(fk: FileKey, salt: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt,
                info=b"tgdrive-chunk|" + fk.blob_uuid).derive(fk.dek)


def _frame_nonce(index: int, is_last: bool) -> bytes:
    return index.to_bytes(8, "big") + b"\x00\x00\x00" + bytes([int(is_last)])


def _aad(frame_size: int) -> bytes:
    return struct.pack(">BI", FORMAT_VERSION, frame_size)


def encrypt_chunk(fk: FileKey, plain: bytes) -> tuple[bytes, bytes]:
    salt = os.urandom(SALT_SIZE)
    key = _chunk_key(fk, salt)
    aes = AESGCM(key)
    frames: list[bytes] = []
    count = n_frames(len(plain), fk.frame_size)
    for index in range(count):
        frame = plain[index * fk.frame_size:(index + 1) * fk.frame_size]
        frames.append(aes.encrypt(_frame_nonce(index, index == count - 1), frame, _aad(fk.frame_size)))
    return bytes([FORMAT_VERSION]) + salt + b"".join(frames), salt


def cipher_range(frame_size: int, plain_size: int, lo: int, hi: int) -> tuple[int, int, int, int]:
    """返回明文闭区间 [lo, hi] 对应的密文范围和帧编号。"""
    if not (0 <= lo <= hi < plain_size):
        raise ValueError("range must be a non-empty inclusive range")
    k0, k1 = lo // frame_size, hi // frame_size
    stride = frame_size + TAG_SIZE
    start = HEADER_SIZE + k0 * stride
    end = min(HEADER_SIZE + (k1 + 1) * stride, cipher_size(plain_size, frame_size))
    return start, end, k0, k1


def decrypt_range(fk: FileKey, salt: bytes, plain_size: int, data: bytes, lo: int, hi: int) -> bytes:
    start, end, k0, k1 = cipher_range(fk.frame_size, plain_size, lo, hi)
    if len(data) != end - start:
        raise IntegrityError("cipher range length mismatch")
    if len(salt) != SALT_SIZE:
        raise IntegrityError("invalid salt")
    aes = AESGCM(_chunk_key(fk, salt))
    stride = fk.frame_size + TAG_SIZE
    out = bytearray()
    cursor = 0
    try:
        for index in range(k0, k1 + 1):
            frame_plain_size = min(fk.frame_size, plain_size - index * fk.frame_size)
            frame_cipher_size = frame_plain_size + TAG_SIZE
            frame = data[cursor:cursor + frame_cipher_size]
            cursor += frame_cipher_size
            out.extend(aes.decrypt(_frame_nonce(index, index == n_frames(plain_size, fk.frame_size) - 1),
                                   frame, _aad(fk.frame_size)))
    except (InvalidTag, ValueError) as exc:
        raise IntegrityError("frame authentication failed") from exc
    if cursor != len(data):
        raise IntegrityError("unexpected frame data")
    first = lo - k0 * fk.frame_size
    return bytes(out[first:first + hi - lo + 1])


def new_dek() -> bytes:
    return os.urandom(32)


def wrap_dek(kek: bytes, dek: bytes, blob_uuid: bytes | str) -> bytes:
    nonce = os.urandom(NONCE_SIZE)
    aad = b"tgdrive-dek|" + _blob_bytes(blob_uuid)
    return nonce + AESGCM(kek).encrypt(nonce, dek, aad)


def unwrap_dek(kek: bytes, wrapped: bytes, blob_uuid: bytes | str) -> bytes:
    if len(wrapped) < NONCE_SIZE + TAG_SIZE:
        raise IntegrityError("wrapped DEK is truncated")
    nonce, body = wrapped[:NONCE_SIZE], wrapped[NONCE_SIZE:]
    try:
        dek = AESGCM(kek).decrypt(nonce, body, b"tgdrive-dek|" + _blob_bytes(blob_uuid))
        if len(dek) != 32:
            raise IntegrityError("invalid DEK length")
        return dek
    except InvalidTag as exc:
        raise IntegrityError("wrapped DEK authentication failed") from exc


def derive_subkey(kek: bytes, purpose: str) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=b"tgdrive-sub|" + purpose.encode("utf-8")).derive(kek)


def seal(subkey: bytes, plaintext: bytes, aad: bytes | str) -> bytes:
    nonce = os.urandom(NONCE_SIZE)
    aad_bytes = aad.encode() if isinstance(aad, str) else aad
    return nonce + AESGCM(subkey).encrypt(nonce, plaintext, aad_bytes)


def open_sealed(subkey: bytes, sealed: bytes, aad: bytes | str) -> bytes:
    if len(sealed) < NONCE_SIZE + TAG_SIZE:
        raise IntegrityError("sealed value is truncated")
    aad_bytes = aad.encode() if isinstance(aad, str) else aad
    try:
        return AESGCM(subkey).decrypt(sealed[:NONCE_SIZE], sealed[NONCE_SIZE:], aad_bytes)
    except InvalidTag as exc:
        raise IntegrityError("sealed value authentication failed") from exc


def make_check_blob(kek: bytes) -> bytes:
    return seal(kek, CHECK_TEXT, b"tgdrive-check")


def verify_check_blob(kek: bytes, blob: bytes) -> None:
    try:
        if open_sealed(kek, blob, b"tgdrive-check") != CHECK_TEXT:
            raise WrongPassphrase
    except IntegrityError as exc:
        raise WrongPassphrase from exc
