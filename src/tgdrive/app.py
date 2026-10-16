"""默认应用工厂和本地开发启动入口。"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from .accounts import AccountService
from .api import AdminApi, UserApi
from .assistant import AssistantService
from .asgi import TgDriveASGI
from .blobengine import BlobEngine
from .blobstore import LocalDiskBlobStore
from .context import AppContext
from .keystore import KeyStore
from .maintenance import MaintenanceScheduler, MaintenanceService
from .metadata import Metadata
from .metrics import TrafficMetrics
from .objects import ObjectService
from .offline.resources import ResourceSettings
from .offline.service import OfflineDownloads
from .s3.auth import ClientAuthStore
from .s3.gateway import S3Gateway
from .settings import SystemSettings
from .telegram.config import ConfiguredBlobStore, TelegramBotConfigStore
from .thumbnails import ThumbnailService
from .version import __version__
from .work import PasswordWork


def create_app(data_dir: str | Path = "./data", *, static_dir: str | Path | None = None,
               s3_host: str | None = None, secure_cookies: bool = True,
               public_base_url: str | None = None, s3_endpoint: str | None = None,
               run_scheduler: bool = True, transfer_concurrency: int = 4, bucket_concurrency: int = 2,
               audit_retention_days: int = 0, resource_mode: str = "auto",
               offline_concurrency: int = 1, offline_bandwidth_kib: int = 0,
               offline_reserve_mib: int = 512, offline_hls: bool = False,
               offline_x: bool = False, offline_youtube: bool = False,
               offline_max_mib: int = 512, youtube_max_height: int = 2160,
               offline_proxy: str = "") -> TgDriveASGI:
    root = Path(data_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    if not os.access(root, os.W_OK | os.X_OK):
        # 比 sqlite 的 “unable to open database file” 更容易看懂：最常见的原因是目录属主与运行用户不一致。
        raise SystemExit(f"数据目录 {root} 不可写（当前用户 uid={os.getuid()}）。请修改目录权限，例如：chown -R {os.getuid()} {root}；"
                         "使用 Docker 时容器默认以 uid 10001 运行，宿主机挂载目录需要对它可写。")
    metadata = Metadata(root / "meta.db")
    keystore = KeyStore(metadata)
    telegram_bots = TelegramBotConfigStore(metadata, keystore)
    local_store = LocalDiskBlobStore(root / "blobs")
    store = ConfiguredBlobStore(metadata, keystore, local_store, telegram_bots)
    engine = BlobEngine(metadata, store, keystore=keystore,
                        transfer_concurrency=transfer_concurrency, bucket_concurrency=bucket_concurrency)
    objects = ObjectService(metadata, engine)
    accounts = AccountService(metadata, keystore)
    resources = ResourceSettings(metadata, root, {"mode": resource_mode, "concurrency": offline_concurrency,
        "bandwidth_kib": offline_bandwidth_kib, "reserve_mib": offline_reserve_mib, "hls_enabled": offline_hls,
        "x_enabled": offline_x, "youtube_enabled": offline_youtube,
        "platform_max_mib": offline_max_mib, "youtube_max_height": youtube_max_height, "proxy": offline_proxy})
    def apply_resources(config):
        low = config["mode"] == "low" or config["concurrency"] == 1
        engine.transfers.set_limits(min(transfer_concurrency, 2) if low else transfer_concurrency,
                                   1 if low else bucket_concurrency)
        engine.upload_concurrency, engine.read_ahead = (1, 1) if low else (3, 2)
    resources.on_change = apply_resources
    apply_resources(resources.effective())
    # 小容器不能在下载缓冲之外再同时分配两份口令计算内存。
    accounts.password_work = PasswordWork(1 if resources.effective()["concurrency"] == 1 else 2)
    offline = OfflineDownloads(accounts, objects, resources)
    thumbnails = ThumbnailService(accounts, objects, resources)
    objects.on_commit = thumbnails.enqueue
    accounts.on_disable = offline.pause_user
    clients = ClientAuthStore(metadata, keystore=keystore)
    s3 = S3Gateway(objects, clients)
    metrics = TrafficMetrics()
    maintenance = MaintenanceService(metadata, engine, store, keystore, backup_dir=root / "backups",
                                     audit_retention_days=audit_retention_days)
    maintenance.trash_purger = objects.purge_expired_trash  # 回收站条目保留 30 天后自动永久删除
    maintenance.thumbnail_adopter = objects.adopt_legacy_thumbnails  # 旧版明文缩略图解锁后加密转存

    async def migrate_thumbnails() -> dict[str, int]:
        # 每轮最多转存 60 张：每张是一条 Telegram 消息，避免挤占正常上传的发送频率。
        return {"moved": await objects.migrate_thumbnails(60),
                "swept": await objects.metadata.run_in_thread(objects.sweep_thumbnail_objects, 500)}
    maintenance.thumbnail_migrator = migrate_thumbnails
    context = AppContext(metadata, keystore, engine, accounts, objects, clients, s3, maintenance,
                         telegram_bots, store, SystemSettings(metadata, {"public_base_url": public_base_url, "s3_endpoint": s3_endpoint}), metrics)
    admin, user = AdminApi(accounts, objects, clients, maintenance, telegram_bots, metrics=metrics, storage=store), UserApi(accounts, objects, clients)
    admin.offline = offline
    # 文件助手：渠道、对话留痕与调用日志；清理挂在维护任务上。
    assistant = AssistantService(accounts, objects, offline, user_api=user, settings=context.system_settings)
    maintenance.assistant_cleaner = assistant.cleanup
    maintenance.assistant_catalog = assistant.sync_catalog_if_due
    app = TgDriveASGI(admin, user,
                      s3=s3, s3_host=s3_host, static_dir=static_dir, secure_cookies=secure_cookies,
                      settings=context.system_settings,
                      scheduler=MaintenanceScheduler(maintenance) if run_scheduler else None, metrics=metrics,
                      context=context, offline=offline, resources=resources, assistant=assistant, thumbnails=thumbnails)
    app.metadata = context.metadata
    app.keystore = context.keystore
    app.engine = context.engine
    app.accounts = context.accounts
    app.objects = context.objects
    app.s3 = context.s3
    app.maintenance = context.maintenance
    app.telegram_bots = context.telegram_bots
    app.system_settings = context.system_settings
    app.assistant = assistant
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


def audit_export_main(argv: list[str]) -> None:
    """导出加密审计归档；不读取或修改在线数据库。"""
    import getpass
    import secrets

    from .maintenance import EncryptedSnapshotStore
    parser = argparse.ArgumentParser(description="导出加密审计归档为 JSONL")
    parser.add_argument("archive")
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    target = Path(args.output).expanduser().resolve()
    if target.exists():
        raise SystemExit("输出文件已经存在，请使用新的文件名")
    staging = target.with_name(f".{target.name}.{secrets.token_hex(6)}.tmp")
    passphrase = getpass.getpass("归档时的加密口令：")
    try:
        EncryptedSnapshotStore.decrypt_to(args.archive, staging, passphrase, kind="audit-jsonl")
        # 硬链接原子发布且拒绝覆盖已有文件。
        os.link(staging, target)
    except (ValueError, OSError) as exc:
        raise SystemExit(f"导出失败：{exc}") from exc
    finally:
        staging.unlink(missing_ok=True)
    print(f"已导出到 {target}")


def main() -> None:
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "restore":
        restore_main(sys.argv[2:])
        return
    if len(sys.argv) > 1 and sys.argv[1] == "audit-export":
        audit_export_main(sys.argv[2:])
        return
    parser = argparse.ArgumentParser(description="启动 tgdrive ASGI 服务")
    parser.add_argument("--version", action="version", version=f"tgdrive {__version__}")
    parser.add_argument("--data-dir", default=os.environ.get("TGDRIVE_DATA_DIR", "./data"))
    parser.add_argument("--host", default=os.environ.get("TGDRIVE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("TGDRIVE_PORT", "8000")))
    parser.add_argument("--static-dir", default=os.environ.get("TGDRIVE_STATIC_DIR"))
    parser.add_argument("--s3-host", default=os.environ.get("TGDRIVE_S3_HOST"))
    parser.add_argument("--public-url", default=os.environ.get("TGDRIVE_PUBLIC_URL"),
                        help="公开访问地址的默认值，例如 https://drive.example.com；管理员可在控制台覆盖")
    parser.add_argument("--s3-endpoint", default=os.environ.get("TGDRIVE_S3_ENDPOINT"),
                        help="S3 Endpoint 的默认值，例如 https://s3.example.com；管理员可在控制台覆盖")
    parser.add_argument("--trusted-proxies", dest="forwarded_allow_ips",
                        default=os.environ.get("TGDRIVE_TRUSTED_PROXIES"),
                        help="信任 X-Forwarded-For/Proto 的代理 IP 或网段，逗号分隔；留空使用 Uvicorn 默认值")
    parser.add_argument("--insecure-cookies", action="store_true",
                        default=os.environ.get("TGDRIVE_INSECURE_COOKIES", "0") == "1")
    parser.add_argument("--transfer-concurrency", type=int, default=int(os.environ.get("TGDRIVE_TRANSFER_CONCURRENCY", "4")))
    parser.add_argument("--bucket-concurrency", type=int, default=int(os.environ.get("TGDRIVE_BUCKET_CONCURRENCY", "2")))
    parser.add_argument("--audit-retention-days", type=int, default=int(os.environ.get("TGDRIVE_AUDIT_RETENTION_DAYS", "0")),
                        help="审计日志归档期限；0 为永久保留，正数表示归档指定天数以前的记录")
    parser.add_argument("--resource-mode", choices=("auto", "low", "standard", "custom"), default=os.environ.get("TGDRIVE_RESOURCE_MODE", "auto"), help="资源预设；管理员配置优先，容器预算始终限制实际并发")
    parser.add_argument("--offline-concurrency", type=int, default=int(os.environ.get("TGDRIVE_OFFLINE_CONCURRENCY", "1")))
    parser.add_argument("--offline-bandwidth-kib", type=int, default=int(os.environ.get("TGDRIVE_OFFLINE_BANDWIDTH_KIB", "0")), help="离线下载总限速，KiB/s；0 不限速")
    parser.add_argument("--offline-reserve-mib", type=int, default=int(os.environ.get("TGDRIVE_OFFLINE_RESERVE_MIB", "512")))
    parser.add_argument("--offline-hls", action="store_true", default=os.environ.get("TGDRIVE_OFFLINE_HLS", "0") == "1", help="允许 M3U8 封装，仍需本地 FFmpeg")
    parser.add_argument("--offline-x", action="store_true", default=os.environ.get("TGDRIVE_OFFLINE_X", "0") == "1", help="允许 X 单条帖子的图片与视频下载，需本地平台组件")
    parser.add_argument("--offline-youtube", action="store_true", default=os.environ.get("TGDRIVE_OFFLINE_YOUTUBE", "0") == "1", help="允许 YouTube 单视频与 Shorts，需平台组件、JavaScript 运行时和 FFmpeg")
    parser.add_argument("--offline-max-mib", type=int, default=int(os.environ.get("TGDRIVE_OFFLINE_MAX_MIB", "512")), help="需临时缓存的音视频输入轨上限，MiB")
    parser.add_argument("--youtube-max-height", type=int, default=int(os.environ.get("TGDRIVE_YOUTUBE_MAX_HEIGHT", "2160")))
    parser.add_argument("--offline-proxy", default=os.environ.get("TGDRIVE_OFFLINE_PROXY", ""),
                        help="离线下载出站代理，http://主机:端口 或 socks5://主机:端口；启用后由代理解析域名")
    args = parser.parse_args()
    try:
        import uvicorn
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("请安装 uvicorn 后再启动服务") from exc
    uvicorn_options = {
        "host": args.host,
        "port": args.port,
    }
    if args.forwarded_allow_ips is not None:
        uvicorn_options["forwarded_allow_ips"] = args.forwarded_allow_ips
    uvicorn.run(create_app(args.data_dir, static_dir=args.static_dir, s3_host=args.s3_host,
                           secure_cookies=not args.insecure_cookies, public_base_url=args.public_url,
                           s3_endpoint=args.s3_endpoint, transfer_concurrency=args.transfer_concurrency,
                           bucket_concurrency=args.bucket_concurrency, audit_retention_days=args.audit_retention_days,
                           resource_mode=args.resource_mode, offline_concurrency=args.offline_concurrency,
                           offline_bandwidth_kib=args.offline_bandwidth_kib, offline_reserve_mib=args.offline_reserve_mib,
                           offline_hls=args.offline_hls, offline_x=args.offline_x, offline_youtube=args.offline_youtube,
                           offline_max_mib=args.offline_max_mib, youtube_max_height=args.youtube_max_height,
                           offline_proxy=args.offline_proxy), **uvicorn_options)


if __name__ == "__main__":
    main()
