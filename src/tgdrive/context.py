"""应用依赖上下文，集中描述应用工厂创建的运行时组件。"""

from __future__ import annotations

from dataclasses import dataclass

from .accounts import AccountService
from .blobengine import BlobEngine
from .keystore import KeyStore
from .maintenance import MaintenanceService
from .metadata import Metadata
from .metrics import TrafficMetrics
from .objects import ObjectService
from .s3.auth import ClientAuthStore
from .s3.gateway import S3Gateway
from .settings import SystemSettings
from .telegram.config import ConfiguredBlobStore, TelegramBotConfigStore


@dataclass(frozen=True)
class AppContext:
    metadata: Metadata
    keystore: KeyStore
    engine: BlobEngine
    accounts: AccountService
    objects: ObjectService
    clients: ClientAuthStore
    s3: S3Gateway
    maintenance: MaintenanceService
    telegram_bots: TelegramBotConfigStore
    storage: ConfiguredBlobStore
    system_settings: SystemSettings
    metrics: TrafficMetrics
