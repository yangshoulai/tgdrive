"""已登记的媒体元数据提供者。新增提供者：在本目录新建一个模块实现 ``Provider``，再加入 ``REGISTRY``。
排列顺序即默认顺序（系统设置与查找结果里同分时的先后）。"""

from __future__ import annotations

from .assrt import AssrtProvider
from .base import Provider
from .embedded import EmbeddedProvider
from .itunes import ItunesProvider
from .kugou import KugouProvider
from .lrclib import LrclibProvider
from .musicbrainz import MusicBrainzProvider
from .netease import NeteaseProvider
from .opensubtitles import OpenSubtitlesProvider
from .qqmusic import QQMusicProvider
from .tmdb import TmdbProvider


def registry() -> dict[str, Provider]:
    providers: list[Provider] = [EmbeddedProvider(), LrclibProvider(), NeteaseProvider(), QQMusicProvider(), KugouProvider(),
                                 ItunesProvider(), MusicBrainzProvider(), TmdbProvider(), OpenSubtitlesProvider(), AssrtProvider()]
    return {provider.id: provider for provider in providers}
