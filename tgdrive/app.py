"""默认应用工厂和本地开发启动入口。"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from .accounts import AccountService
from .api import AdminApi, UserApi
from .asgi import TgDriveASGI
from .blobengine import BlobEngine
from .blobstore import LocalDiskBlobStore
from .keystore import KeyStore
from .metadata import Metadata
from .maintenance import MaintenanceScheduler, MaintenanceService
from .objects import ObjectService
from .s3.auth import ClientAuthStore
from .s3.gateway import S3Gateway
from .settings import SystemSettings
from .telegram.config import ConfiguredBlobStore, TelegramBotConfigStore


def create_app(data_dir: str | Path = "./data", *, static_dir: str | Path | dict[str, str | Path] | None = None,
               s3_host: str | None = None, secure_cookies: bool = True,
               public_base_url: str | None = None, s3_endpoint: str | None = None,
               run_scheduler: bool = True) -> TgDriveASGI:
    root = Path(data_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    metadata = Metadata(root / "meta.db")
    keystore = KeyStore(metadata)
    telegram_bots = TelegramBotConfigStore(metadata, keystore)
    local_store = LocalDiskBlobStore(root / "blobs")
    store = ConfiguredBlobStore(metadata, keystore, local_store, telegram_bots)
    engine = BlobEngine(metadata, store, keystore=keystore)
    objects = ObjectService(metadata, engine)
    accounts = AccountService(metadata, keystore)
    clients = ClientAuthStore(metadata, keystore=keystore)
    s3 = S3Gateway(objects, clients)
    maintenance = MaintenanceService(metadata, engine, store, keystore, backup_dir=root / "backups")
    maintenance.trash_purger = objects.purge_expired_trash  # 回收站条目保留 30 天后自动永久删除
    app = TgDriveASGI(AdminApi(accounts, objects, clients, maintenance, telegram_bots), UserApi(accounts, objects, clients),
                      s3=s3, s3_host=s3_host, static_dir=static_dir, secure_cookies=secure_cookies,
                      settings=SystemSettings(metadata, {"public_base_url": public_base_url, "s3_endpoint": s3_endpoint}),
                      scheduler=MaintenanceScheduler(maintenance) if run_scheduler else None)
    app.metadata = metadata  # type: ignore[attr-defined]
    app.keystore = keystore  # type: ignore[attr-defined]
    app.engine = engine  # type: ignore[attr-defined]
    app.accounts = accounts  # type: ignore[attr-defined]
    app.objects = objects  # type: ignore[attr-defined]
    app.s3 = s3  # type: ignore[attr-defined]
    app.maintenance = maintenance  # type: ignore[attr-defined]
    app.telegram_bots = telegram_bots  # type: ignore[attr-defined]
    app.system_settings = app.settings  # type: ignore[attr-defined]
    return app


def restore_main(argv: list[str]) -> None:
    """tgdrive restore <备份文件> --data-dir <目录>：从加密备份恢复元数据库。必须先停止服务。"""
    import getpass
    from .errors import WrongPassphrase
    from .maintenance import restore_backup
    parser = argparse.ArgumentParser(prog="tgdrive restore", description="从加密备份恢复 tgdrive 元数据库（请先停止服务）")
    parser.add_argument("backup", help="备份文件路径（*.tgdbak）")
    parser.add_argument("--data-dir", default=os.environ.get("TGDRIVE_DATA_DIR", "./data"))
    args = parser.parse_args(argv)
    passphrase = getpass.getpass("备份时的加密口令：")
    try:
        target = restore_backup(args.backup, passphrase, args.data_dir)
    except (ValueError, WrongPassphrase) as exc:
        raise SystemExit(f"恢复失败：{str(exc) or '加密口令不正确'}") from exc
    print(f"已恢复到 {target}。原数据库已保留为 meta.db.before-restore-*。启动服务后用备份时的口令解锁。")


def main() -> None:
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "restore":
        restore_main(sys.argv[2:])
        return
    parser = argparse.ArgumentParser(description="启动 tgdrive ASGI 服务")
    parser.add_argument("--data-dir", default=os.environ.get("TGDRIVE_DATA_DIR", "./data"))
    parser.add_argument("--host", default=os.environ.get("TGDRIVE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("TGDRIVE_PORT", "8000")))
    parser.add_argument("--static-dir", default=os.environ.get("TGDRIVE_STATIC_DIR"))
    parser.add_argument("--s3-host", default=os.environ.get("TGDRIVE_S3_HOST"))
    parser.add_argument("--public-url", default=os.environ.get("TGDRIVE_PUBLIC_URL"),
                        help="公开访问地址的默认值，例如 https://drive.example.com；管理员可在控制台覆盖")
    parser.add_argument("--s3-endpoint", default=os.environ.get("TGDRIVE_S3_ENDPOINT"),
                        help="S3 Endpoint 的默认值，例如 https://s3.example.com；管理员可在控制台覆盖")
    parser.add_argument("--insecure-cookies", action="store_true",
                        default=os.environ.get("TGDRIVE_INSECURE_COOKIES", "0") == "1")
    args = parser.parse_args()
    try:
        import uvicorn
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("请安装 uvicorn 后再启动服务") from exc
    uvicorn.run(create_app(args.data_dir, static_dir=args.static_dir, s3_host=args.s3_host,
                           secure_cookies=not args.insecure_cookies, public_base_url=args.public_url,
                           s3_endpoint=args.s3_endpoint),
                host=args.host, port=args.port)


if __name__ == "__main__":
    main()
