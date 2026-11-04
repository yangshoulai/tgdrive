"""从标签与文件名推断查询条件。"""

from __future__ import annotations

import re

from .providers.base import MediaQuery

_QUALITY = re.compile(
    r"\b(?:2160p|1080[pi]|720p|480p|4k|uhd|hdr10?\+?|dv|dolby\s*vision|blu-?ray|bdrip|brrip|web-?dl|webrip|web|hdtv|dvdrip|remux|"
    r"x26[45]|h\.?26[45]|hevc|avc|aac\d?(?:\.\d)?|ac3|e-?ac-?3|dts(?:-?hd)?|truehd|atmos|flac|ddp?\d?(?:\.\d)?|10bit|8bit|"
    r"proper|repack|extended|unrated|imax|complete|multi|subbed|dubbed|中英(?:双字|字幕)?|国语|粤语|中字|双语)\b", re.IGNORECASE)
_EPISODE = re.compile(r"\bS(\d{1,2})\s*E(\d{1,3})\b|\b(\d{1,2})x(\d{2,3})\b|第\s*(\d{1,3})\s*[集话話]|\bEP?\s*(\d{1,3})\b", re.IGNORECASE)
_YEAR = re.compile(r"(?<!\d)(19[2-9]\d|20[0-4]\d)(?!\d)")


def stem(name: str) -> str:
    base = name.rsplit("/", 1)[-1]
    return base.rsplit(".", 1)[0] if "." in base else base


def audio_from_name(name: str) -> tuple[str, str]:
    """「歌名 - 歌手」与网页播放器的拆分规则一致；开头的曲目编号去掉。"""
    base = re.sub(r"^\s*\d{1,3}\s*[.\-_、]\s*", "", stem(name)).strip()
    match = re.fullmatch(r"(.+?)\s*[-–—]\s*([^-–—]+)", base)
    return (match.group(1).strip(), match.group(2).strip()) if match else (base, "")


def video_from_name(name: str) -> tuple[str, str, int | None, int | None]:
    """返回（片名，年份，季，集）：去掉发布组、分辨率、编码等标记。"""
    base = stem(name)
    base = re.sub(r"^\s*[\[【][^\]】]*[\]】]\s*", "", base)          # 开头的站点或字幕组
    base = re.sub(r"[\[【(（][^\]】)）]*(?:字幕|组|sub|raws?)[^\]】)）]*[\]】)）]", " ", base, flags=re.IGNORECASE)
    text = re.sub(r"[._]+", " ", base)
    season = episode = None
    match = _EPISODE.search(text)
    cut = len(text)
    if match:
        groups = match.groups()
        if groups[0]:
            season, episode = int(groups[0]), int(groups[1])
        elif groups[2]:
            season, episode = int(groups[2]), int(groups[3])
        else:
            episode = int(groups[4] or groups[5])
        cut = min(cut, match.start())
    year = ""
    for found in _YEAR.finditer(text):
        if found.start() > 0:   # 片名本身是年份（如「1917」）时不当作年份
            year = found.group(1)
            cut = min(cut, found.start())
            break
    quality = _QUALITY.search(text)
    if quality:
        cut = min(cut, quality.start())
    title = re.sub(r"[\[\]【】()（）]+", " ", text[:cut])
    title = re.sub(r"\s+", " ", title).strip(" -–—")
    return title or text.strip(), year, season, episode


def build(kind: str, name: str, size: int, info: dict | None, overrides: dict | None = None) -> MediaQuery:
    info = info or {}
    query = MediaQuery(kind, name=stem(name), size=size, duration=info.get("duration"),
                       extra={key: str(value) for key, value in (info.get("extra") or {}).items()})
    if kind == "audio":
        guess_title, guess_artist = audio_from_name(name)
        query.title = info.get("title") or guess_title
        query.artist = info.get("artist") or (guess_artist if not info.get("title") else "")
        query.album = info.get("album") or ""
        query.year = info.get("year") or ""
    else:
        title, year, season, episode = video_from_name(name)
        # 视频的标题标签常是发布组写的文件名，不比文件名可靠：只在文件名推断不出时采用。
        query.title = title or info.get("title") or ""
        query.year, query.season, query.episode = year or info.get("year") or "", season, episode
    for key, value in (overrides or {}).items():
        if key in ("title", "artist", "album", "year") and isinstance(value, str):
            setattr(query, key, value.strip()[:200])
        elif key in ("season", "episode"):
            setattr(query, key, int(value) if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 10000 else None)
        elif key == "languages" and isinstance(value, list):
            languages = tuple(item.lower() for item in value if isinstance(item, str) and re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?", item))
            query.languages = languages[:4] or query.languages
    return query
