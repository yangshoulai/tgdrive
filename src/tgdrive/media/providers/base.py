"""媒体元数据提供者接口。

每个提供者声明自己能提供什么（``capabilities``：封面、歌词、字幕；以后可加其他信息）、适用于哪类文件
（``media``：音频、视频）、需要哪些配置（``fields``）以及给管理员看的配置步骤（``guide``）。
``MediaService`` 按系统设置里启用的提供者并发调用 ``search``，候选的 ``ref`` 只留在服务端，
用户选中后再调用 ``fetch`` 读取内容。所有出站请求都必须经 ``ProviderContext``（受控 HTTP 客户端、限速、
超时与大小上限），提供者不得自行建立连接。
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any, Literal
from urllib.parse import urlencode

Want = Literal["cover", "lyrics", "subtitle", "info"]
Kind = Literal["audio", "video"]
WANTS: tuple[Want, ...] = ("cover", "lyrics", "subtitle")
# 「info」不是独立的查询：声明 info=True 的提供者在封面或歌词搜索结果里附带结构化字段（Candidate.fields），
# 编辑元数据时据此填入歌名、歌手、专辑、年份等，不另外请求第三方。
INFO_FIELDS = ("title", "artist", "album", "album_artist", "track", "year", "genre", "composer", "director", "actors", "description")


class ProviderError(Exception):
    """提供者返回给用户看的失败原因（不含密钥、地址或原始响应）。"""


@dataclass(frozen=True)
class ConfigField:
    key: str
    label: str
    secret: bool = False
    required: bool = False
    hint: str = ""
    placeholder: str = ""

    def describe(self) -> dict:
        return {"key": self.key, "label": self.label, "secret": self.secret, "required": self.required,
                "hint": self.hint, "placeholder": self.placeholder}


@dataclass(frozen=True)
class GuideStep:
    title: str
    body: str = ""
    link: str | None = None
    link_label: str | None = None

    def describe(self) -> dict:
        return {"title": self.title, "body": self.body, "link": self.link, "link_label": self.link_label}


@dataclass
class MediaQuery:
    """查询条件：优先取文件自带的标签，没有时从文件名推断；用户可在查找弹窗中改写。"""
    kind: Kind
    name: str = ""
    title: str = ""
    artist: str = ""
    album: str = ""
    year: str = ""
    season: int | None = None
    episode: int | None = None
    duration: float | None = None
    size: int = 0
    moviehash: str | None = None
    languages: tuple[str, ...] = ("zh", "en")
    extra: dict[str, str] = field(default_factory=dict)

    def titles(self, prefer: str = "latin") -> list[str]:
        """片名的几种写法：文件名常把中文名与英文名写在一起（如「盗梦空间 Inception」），合在一起搜索往往查不到。
        prefer 决定先试英文部分（海外数据库）还是中文部分（国内数据库），最后才用完整写法。"""
        title = (self.title or self.name).strip()
        cjk = " ".join(re.findall(r"[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef0-9：·，！？]+", title)).strip()
        latin = " ".join(re.findall(r"[A-Za-z0-9][A-Za-z0-9'&:!?,.\- ]*[A-Za-z0-9!?]|[A-Za-z]", title)).strip()
        latin = latin if re.search(r"[A-Za-z]{2}", latin) else ""
        cjk = cjk if re.search(r"[\u3000-\u9fff\uac00-\ud7af]", cjk) else ""
        order = [latin, cjk] if prefer == "latin" else [cjk, latin]
        return [item for item in dict.fromkeys([*order, title]) if item]

    @property
    def keywords(self) -> str:
        """给只支持关键词搜索的接口：歌名与歌手（视频为片名）。"""
        return " ".join(part for part in (self.title, self.artist) if part).strip() or self.name

    def cache_key(self, want: str) -> tuple:
        return (want, self.kind, self.title, self.artist, self.album, self.year, self.season, self.episode,
                round(self.duration or 0), self.moviehash, self.languages)


@dataclass
class Candidate:
    want: Want
    title: str
    ref: dict[str, Any]
    subtitle: str = ""
    provider: str = ""
    synced: bool | None = None
    language: str | None = None
    format: str | None = None
    duration: float | None = None
    width: int | None = None
    height: int | None = None
    preview: str | None = None
    note: str = ""
    score: float = 0.0
    hash_match: bool = False
    # 结构化元数据（INFO_FIELDS 中的键），供「查找信息」填入编辑器；只含非空字符串。
    fields: dict[str, str] = field(default_factory=dict)

    def public(self, token: str) -> dict:
        return {"token": token, "want": self.want, "provider": self.provider, "title": self.title, "subtitle": self.subtitle, "fields": self.fields,
                "synced": self.synced, "language": self.language, "format": self.format, "duration": self.duration,
                "width": self.width, "height": self.height, "preview": self.preview, "note": self.note,
                "score": round(self.score, 3), "hash_match": self.hash_match, "has_preview_image": bool(self.ref.get("preview_url"))}


@dataclass
class Fetched:
    """读取结果：封面是图片字节；歌词、字幕是文本与格式（lrc、srt、vtt）。"""
    data: bytes | None = None
    mime: str | None = None
    text: str | None = None
    format: str | None = None
    raw: bytes | None = None
    name: str | None = None


class Provider:
    id: str = ""
    name: str = ""
    description: str = ""
    homepage: str = ""
    capabilities: frozenset[Want] = frozenset()
    media: frozenset[Kind] = frozenset()
    official: bool = True
    default_enabled: bool = False
    # 搜索结果带结构化字段（Candidate.fields），可用于「查找信息」。
    info: bool = False
    fields: tuple[ConfigField, ...] = ()
    guide: tuple[GuideStep, ...] = ()
    notice: str = ""
    # 两次请求之间的最短间隔（秒）；None 表示不限速。interval_hosts 指定只对哪些主机限速（None 为全部）。
    interval: float | None = None
    interval_hosts: tuple[str, ...] | None = None

    def supports(self, want: str, kind: str) -> bool:
        if want == "info":
            return self.info and kind in self.media
        return want in self.capabilities and kind in self.media

    def info_want(self, kind: str) -> Want:
        """「查找信息」复用哪种搜索（结果与封面、歌词查找共用缓存）。"""
        return "cover" if self.supports("cover", kind) else "lyrics" if self.supports("lyrics", kind) else "subtitle"

    async def search(self, query: MediaQuery, want: Want, ctx: "ProviderContext") -> list[Candidate]:
        raise NotImplementedError

    async def fetch(self, ref: dict[str, Any], want: Want, ctx: "ProviderContext") -> Fetched:
        raise NotImplementedError

    async def test(self, ctx: "ProviderContext") -> str:
        """「测试连接」：默认用一个固定的查询检查接口可用。"""
        want = next(iter(sorted(self.capabilities)))
        kind = "audio" if "audio" in self.media else "video"
        query = MediaQuery(kind, title="Yesterday" if kind == "audio" else "Inception", artist="The Beatles" if kind == "audio" else "",
                           year="" if kind == "audio" else "2010", name="test")
        results = await self.search(query, want, ctx)
        return f"连接正常，测试查询返回 {len(results)} 个结果"

    def describe(self) -> dict:
        return {"id": self.id, "name": self.name, "description": self.description, "homepage": self.homepage,
                "capabilities": [item for item in WANTS if item in self.capabilities] + (["info"] if self.info else []), "media": sorted(self.media),
                "official": self.official, "default_enabled": self.default_enabled,
                "fields": [item.describe() for item in self.fields], "guide": [item.describe() for item in self.guide],
                "notice": self.notice, "needs_config": any(item.required for item in self.fields)}

    def missing(self, config: dict[str, str]) -> list[str]:
        return [item.label for item in self.fields if item.required and not str(config.get(item.key) or "").strip()]


class ProviderContext:
    """提供者能用的全部外部能力：受控 HTTP、已解密的配置，以及（内置数据提供者用的）当前文件。"""

    JSON_LIMIT = 2 * 1024 * 1024
    BYTES_LIMIT = 20 * 1024 * 1024

    def __init__(self, provider: Provider, config: dict[str, str], http, file=None):
        self.provider, self.config, self._http, self.file = provider, config, http, file

    async def request(self, method: str, url: str, *, params: dict | None = None, headers: dict[str, str] | None = None,
                      body: bytes | None = None, limit: int = BYTES_LIMIT) -> tuple[int, dict[str, str], bytes]:
        if params:
            url += ("&" if "?" in url else "?") + urlencode({key: value for key, value in params.items() if value not in (None, "")})
        return await self._http.request(self.provider, method, url, headers or {}, body, limit)

    async def get_json(self, url: str, *, params: dict | None = None, headers: dict[str, str] | None = None,
                       allow: tuple[int, ...] = (200,)) -> Any:
        status, _, data = await self.request("GET", url, params=params, headers={"Accept": "application/json", **(headers or {})},
                                             limit=self.JSON_LIMIT)
        return self.decode_json(status, data, allow)

    async def post_json(self, url: str, payload: Any, *, headers: dict[str, str] | None = None, form: bool = False,
                        allow: tuple[int, ...] = (200,)) -> Any:
        body = urlencode(payload).encode() if form else json.dumps(payload, ensure_ascii=False).encode()
        kind = "application/x-www-form-urlencoded" if form else "application/json"
        status, _, data = await self.request("POST", url, headers={"Accept": "application/json", "Content-Type": kind, **(headers or {})},
                                             body=body, limit=self.JSON_LIMIT)
        return self.decode_json(status, data, allow)

    async def get_bytes(self, url: str, *, headers: dict[str, str] | None = None, limit: int = BYTES_LIMIT) -> tuple[bytes, str]:
        status, response_headers, data = await self.request("GET", url, headers=headers, limit=limit)
        if status != 200:
            raise ProviderError(_status_message(status))
        return data, response_headers.get("content-type", "")

    @staticmethod
    def decode_json(status: int, data: bytes, allow: tuple[int, ...]) -> Any:
        if status not in allow:
            raise ProviderError(_status_message(status))
        try:
            text = data.decode("utf-8-sig")
            # 部分接口返回 JSONP：callback({...})
            match = re.fullmatch(r"\s*[\w.$]+\((.*)\)\s*;?\s*", text, re.DOTALL)
            return json.loads(match.group(1) if match else text)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProviderError("接口返回的数据格式不正确，可能已变更") from exc


def info_fields(**values) -> dict[str, str]:
    """整理提供者给出的字段：去掉空值与首尾空白，限制长度（简介 16 KB，演员 4 KB，其余 512 字节以内）。"""
    result = {}
    for name, value in values.items():
        if name not in INFO_FIELDS or value is None or isinstance(value, bool):
            continue
        text = re.sub(r"\s+", " ", str(value)).strip() if name != "description" else str(value).strip()
        limit = 16000 if name == "description" else 4000 if name == "actors" else 200
        if text:
            result[name] = text[:limit]
    return result


def year_of(value) -> str | None:
    """发行时间转年份：毫秒时间戳（网易云）或「2005-01-01」这类日期字符串。"""
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        import datetime
        return str(datetime.datetime.fromtimestamp(value / 1000, datetime.timezone.utc).year)
    match = re.match(r"\s*(\d{4})", str(value or ""))
    return match.group(1) if match else None


def _status_message(status: int) -> str:
    if status in (401, 403):
        return f"接口拒绝访问（HTTP {status}），请检查密钥或账号配置"
    if status == 404:
        return "接口没有找到对应内容（HTTP 404）"
    if status == 429:
        return "请求太频繁，接口暂时限制访问（HTTP 429），请稍后再试"
    if status >= 500:
        return f"接口暂时不可用（HTTP {status}）"
    return f"接口返回了 HTTP {status}"


# ---------- 匹配与打分 ----------

_NOISE = re.compile(r"[\s\-_.·・,，、/\\|:：;；!！?？'\"“”‘’()\[\]（）【】《》<>{}~～+&＆]+")
_DECOR = re.compile(r"[(\[（【](?:live|remaster(?:ed)?|伴奏|纯音乐|demo|cover|翻唱|现场|版|ver\.?|version|feat\.?[^)\]）】]*)[^)\]）】]*[)\]）】]", re.IGNORECASE)


def normalize(value: str | None) -> str:
    value = unicodedata.normalize("NFKC", value or "").casefold()
    return _NOISE.sub("", value)


def similarity(left: str | None, right: str | None) -> float:
    a, b = normalize(left), normalize(right)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a in b or b in a:
        return 0.85 * min(len(a), len(b)) / max(len(a), len(b)) + 0.15
    return SequenceMatcher(None, a, b).ratio()


def strip_decor(value: str) -> str:
    return _DECOR.sub("", value).strip()


def score(query: MediaQuery, candidate: Candidate, *, artist: str = "") -> float:
    """0–1 的匹配分：标题（必有）、歌手、时长差与年份；文件哈希命中直接给高分。"""
    if candidate.hash_match:
        return 1.0
    title = max(similarity(query.title or query.name, candidate.title), similarity(strip_decor(query.title or query.name), strip_decor(candidate.title)))
    if not query.title and query.name:
        # 没有标签时文件名里可能同时有歌名和歌手。
        title = max(title, similarity(query.name, f"{candidate.title} {artist}"), similarity(query.name, f"{artist} {candidate.title}"))
    weights, total = 0.6, title * 0.6
    if query.artist and artist:
        weights += 0.25
        total += 0.25 * max(similarity(query.artist, artist), *(similarity(part, artist) for part in re.split(r"[/&,、]", query.artist) if part.strip()))
    if query.duration and candidate.duration:
        gap = abs(query.duration - candidate.duration)
        weights += 0.15
        total += 0.15 * (1.0 if gap <= 2 else max(0.0, 1 - (gap - 2) / 20))
    if query.year and candidate.subtitle and query.year in candidate.subtitle:
        total += 0.05
    return min(1.0, total / weights if weights else 0.0)
