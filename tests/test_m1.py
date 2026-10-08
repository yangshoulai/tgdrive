import asyncio
import tempfile
import unittest
from pathlib import Path

from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.crypto import FileKey, cipher_size, decrypt_range, encrypt_chunk, new_dek
from tgdrive.errors import IntegrityError, WrongPassphrase
from tgdrive.keystore import KeyStore
from tgdrive.metadata import Metadata


class CryptoTests(unittest.TestCase):
    def test_frame_round_trip_and_tamper_detection(self):
        fk = FileKey(new_dek(), b"blob-1", 96)
        plain = bytes(range(251)) * 3
        encrypted, salt = encrypt_chunk(fk, plain)
        self.assertEqual(len(encrypted), cipher_size(len(plain), 96))
        for lo, hi in ((0, 0), (1, 95), (96, 200), (len(plain) - 10, len(plain) - 1)):
            start = 17 + (lo // 96) * 112
            end = min(17 + ((hi // 96) + 1) * 112, len(encrypted))
            self.assertEqual(decrypt_range(fk, salt, len(plain), encrypted[start:end], lo, hi), plain[lo:hi + 1])
        damaged = bytearray(encrypted)
        damaged[-1] ^= 1
        with self.assertRaises(IntegrityError):
            decrypt_range(fk, salt, len(plain), bytes(damaged[17:]), 0, len(plain) - 1)


class M1Tests(unittest.IsolatedAsyncioTestCase):
    async def test_out_of_order_parts_range_scrub_and_rotation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            metadata = Metadata(root / "meta.db")
            keys = KeyStore(metadata)
            keys.initialize("old pass")
            keys.lock()
            with self.assertRaises(WrongPassphrase):
                keys.unlock("wrong")
            keys.unlock("old pass")
            engine = BlobEngine(metadata, LocalDiskBlobStore(root / "blobs"), keys.require_kek(),
                                 chunk_size=1000, frame_size=96)
            source = bytes(range(256)) * 21 + b"tail"
            blob = engine.begin_blob()
            await engine.put_part(blob, 2, source[1200:])
            await engine.put_part(blob, 1, source[:1200])
            self.assertEqual(engine.finalize(blob, [1, 2]), len(source))
            self.assertEqual(await engine.read(blob), source)
            self.assertEqual(await engine.read(blob, 37, 1700), source[37:1700])
            self.assertEqual(await engine.scrub(blob, deep=True), [])

            report = keys.rotate("old pass", "new pass")
            self.assertEqual(report.blob_count, 1)
            keys.lock()
            keys.unlock("new pass")
            engine.kek = keys.require_kek()
            self.assertEqual(await engine.read(blob), source)

    async def test_part_retry_replaces_old_ciphertext(self):
        with tempfile.TemporaryDirectory() as temp:
            metadata = Metadata(Path(temp) / "meta.db")
            keys = KeyStore(metadata)
            keys.initialize("pass")
            engine = BlobEngine(metadata, LocalDiskBlobStore(Path(temp) / "blobs"), keys.require_kek(),
                                 chunk_size=32, frame_size=8)
            blob = engine.begin_blob()
            await engine.put_part(blob, 1, b"old")
            await engine.put_part(blob, 1, b"new")
            engine.finalize(blob, [1])
            self.assertEqual(await engine.read(blob), b"new")
            self.assertEqual(len(metadata.db.execute("SELECT * FROM gc_queue").fetchall()), 1)


if __name__ == "__main__":
    unittest.main()
