import asyncio
import tempfile
import unittest
from pathlib import Path

from tgdrive.blobengine import BlobEngine
from tgdrive.blobstore import LocalDiskBlobStore
from tgdrive.keystore import KeyStore
from tgdrive.maintenance import MaintenanceService
from tgdrive.metadata import Metadata
from tgdrive.objects import ObjectService, Scope
from tgdrive.app import create_app


class M7Tests(unittest.TestCase):
    def test_gc_scrub_and_encrypted_snapshot(self):
        async def run():
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                metadata = Metadata(root / "meta.db")
                keys = KeyStore(metadata)
                keys.initialize("snapshot passphrase")
                store = LocalDiskBlobStore(root / "blobs")
                engine = BlobEngine(metadata, store, keystore=keys, chunk_size=32, frame_size=8)
                objects = ObjectService(metadata, engine)
                bucket_id = objects.create_bucket("maintenance")
                maintenance = MaintenanceService(metadata, engine, store, keys)

                item = await objects.put_object(Scope(bucket_id), "healthy.txt", b"healthy")
                scrub = await maintenance.scrub.run_once(deep=True)
                self.assertEqual((scrub.checked, scrub.bad), (1, []))
                await objects.delete_objects(Scope(bucket_id), [item.key])
                gc = await maintenance.gc.run_once()
                self.assertEqual((gc.processed, gc.deleted, gc.failed), (1, 1, 0))
                self.assertEqual(metadata.db.execute("SELECT COUNT(*) FROM gc_queue").fetchone()[0], 0)

                snapshot_path = maintenance.snapshots.create(root / "backup.tgd")
                self.assertTrue(snapshot_path.is_file())
                plaintext = maintenance.snapshots.open(snapshot_path)
                self.assertTrue(plaintext.startswith(b"SQLite format 3"))
                metadata.close()

        asyncio.run(run())

    def test_asgi_maintenance_route(self):
        async def run():
            with tempfile.TemporaryDirectory() as temp:
                app = create_app(temp)
                account = app.accounts.setup("maintenance passphrase", "admin", "admin password")
                item = await app.objects.put_object(Scope(account.bucket_id), "orphan.txt", b"orphan")
                await app.objects.delete_objects(Scope(account.bucket_id), [item.key])
                session = app.accounts.login("admin", "admin password", role="admin")
                sent = []
                body = b'{"limit":10}'
                queue = [{"type": "http.request", "body": body, "more_body": False}]

                async def receive():
                    return queue.pop(0)

                async def send(message):
                    sent.append(message)

                await app({"type": "http", "method": "POST", "path": "/api/admin/v1/maintenance/gc",
                           "query_string": b"", "headers": [
                               (b"cookie", f"tg_session={session.token}".encode()),
                               (b"x-csrf-token", session.csrf_token.encode()),
                               (b"content-type", b"application/json"),
                           ]}, receive, send)
                self.assertEqual(sent[0]["status"], 200)
                self.assertIn(b'"deleted": 1', sent[-1]["body"])
                app.metadata.close()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
