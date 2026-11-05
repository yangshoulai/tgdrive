"""在线获取封面、歌词与字幕的提议工具（docs/assistant-design.md §40）。

工具先查询已启用的媒体信息提供者（系统设置 → 媒体信息），把每个文件、每种数据的候选冻结进待确认操作：
- 审批模式下确认卡片列出封面、歌词、字幕候选供用户选择；已有同类数据的条目默认「保留现有」，由用户决定是否覆盖。
- 完全访问下按优先级自动选择（best）并直接覆盖。
优先级：封面先用文件内嵌的图片，再按在线结果的匹配分；歌词按 时长一致 > 能滚动（带时间标签）> 内置 > 匹配分；
字幕按 文件哈希命中 > 匹配分。文件内置的同步歌词可信时不查找（播放器直接使用），force_online 可跳过内置数据。
候选的来源引用（第三方地址等）只存在操作记录里不公开的 _refs 中，不交给模型或网页。
"""

from __future__ import annotations

import asyncio
import re

from ..errors import NotFoundError
from ..filekinds import kind_of
from .tools import PATH, ToolContext, ToolError, ToolOutput, tool
from .write_tools import _propose

WANT_LABELS = {"cover": "封面", "lyrics": "歌词", "subtitle": "字幕"}
MAX_FILES = 10
PER_WANT = {"cover": 12, "lyrics": 8, "subtitle": 8}
# 自动选择的最低匹配分：低于它的结果只列出、不默认选中。
MIN_SCORE = {"cover": 0.5, "lyrics": 0.5, "subtitle": 0.45}
DURATION_GAP = 3.0
_LRC_TIME = re.compile(r"\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]")


def duration_match(duration: float | None, candidate: float | None) -> bool:
    if not duration or not candidate:
        return False
    return abs(duration - candidate) <= max(DURATION_GAP, duration * 0.02)


def last_time(text: str) -> float | None:
    """LRC 歌词里最后一个时间标签（秒）。"""
    times = [int(minute) * 60 + float(second.replace(":", ".")) for minute, second in _LRC_TIME.findall(text or "")]
    return max(times) if times else None


def rank_key(want: str, candidate: dict, duration: float | None) -> tuple:
    embedded = candidate.get("provider") == "embedded"
    score = float(candidate.get("score") or 0)
    if want == "cover":
        return (embedded, bool(candidate.get("hash_match")), score)
    if want == "lyrics":
        return (duration_match(duration, candidate.get("duration")), candidate.get("synced") is True, embedded, score)
    return (bool(candidate.get("hash_match")), score)


def best_index(want: str, candidates: list[dict], duration: float | None) -> int | None:
    """按优先级选出最合适的候选；没有足够匹配的结果时返回 None。"""
    eligible = [index for index, item in enumerate(candidates)
                if item.get("provider") == "embedded" or item.get("hash_match") or float(item.get("score") or 0) >= MIN_SCORE[want]]
    if not eligible:
        return None
    return max(eligible, key=lambda index: (rank_key(want, candidates[index], duration), -index))


def _public(candidate, names: dict[str, str]) -> dict:
    return {"provider": candidate.provider, "provider_name": names.get(candidate.provider, candidate.provider), "title": candidate.title,
            "subtitle": candidate.subtitle, "synced": candidate.synced, "language": candidate.language, "format": candidate.format,
            "duration": candidate.duration, "width": candidate.width, "height": candidate.height,
            "preview": (candidate.preview or "")[:600] or None, "note": candidate.note, "score": round(candidate.score, 3),
            "hash_match": candidate.hash_match, "image": candidate.want == "cover"}


def _files(ctx: ToolContext, paths: list) -> tuple[list[str], list[dict]]:
    """路径可以是文件，也可以是文件夹（取其中第一层的音视频文件）。"""
    keys, skipped = [], []
    for value in paths:
        key = ctx.resolve(value)
        row = ctx.db.execute("SELECT key, content_type FROM objects WHERE bucket_id=? AND key=?", (ctx.bucket_id, key)).fetchone() \
            if key and not key.endswith("/") else None
        if row is not None:
            if kind_of(row["key"], row["content_type"]) in ("audio", "video"):
                keys.append(row["key"])
            else:
                skipped.append({"path": ctx.display(key), "reason": "不是音频或视频文件"})
            continue
        folder = key if key.endswith("/") or not key else key + "/"
        rows = ctx.db.execute("SELECT key, content_type FROM objects WHERE bucket_id=? AND key>? AND key<? AND instr(substr(key,?),'/')=0 "
                              "ORDER BY key LIMIT 2000", (ctx.bucket_id, folder, folder + "\U0010ffff", len(folder) + 1)).fetchall()
        found = [item["key"] for item in rows if kind_of(item["key"], item["content_type"]) in ("audio", "video")]
        if not rows:
            skipped.append({"path": ctx.display(key), "reason": "不存在"})
        elif not found:
            skipped.append({"path": ctx.display(folder), "reason": "文件夹里没有音频或视频文件"})
        keys += found
    unique = list(dict.fromkeys(keys))
    if len(unique) > MAX_FILES:
        raise ToolError(f"一次最多处理 {MAX_FILES} 个音视频文件，现在有 {len(unique)} 个；请分批调用（每次给出其中一部分文件路径）。")
    return unique, skipped


def _existing(ctx: ToolContext, scope, key: str, info: dict, blob: str | None) -> dict[str, tuple[str | None, bool]]:
    """已有的封面、歌词、字幕：（说明文字，是否只有文件内置的数据）；说明为 None 表示没有。"""
    assets = ctx.objects.preview_assets(scope, key)
    cover = blob and ctx.db.execute("SELECT 1 FROM thumbnails WHERE blob_uuid=? AND variant IN ('thumb','grid','poster') LIMIT 1",
                                    (blob,)).fetchone()
    lyrics = [item["name"] for item in assets if item["kind"] == "lyrics"]
    subtitles = [item["name"] for item in assets if item["kind"] == "subtitle"]
    streams = info.get("subtitles") or []
    synced = (info.get("lyrics") or {}).get("synced")
    return {
        "cover": ("已有封面" if cover else None, False),
        "lyrics": (f"已有歌词文件「{lyrics[0]}」", False) if lyrics else ("文件内置能滚动的歌词" if synced else None, True),
        "subtitle": ((f"已有字幕文件「{subtitles[0]}」" + (f" 等 {len(subtitles)} 个" if len(subtitles) > 1 else "")), False) if subtitles
        else (f"文件内置 {len(streams)} 条字幕轨" if streams else None, True),
    }


async def _lookup(ctx: ToolContext, key: str, wants: list[str] | None, force: bool, hints: dict) -> tuple[list[dict], list[dict]]:
    media, scope = ctx.media, ctx.scope()
    try:
        info = await media.info(scope, key)
        head = ctx.objects.head_object(scope, key)
    except (ValueError, NotFoundError) as exc:
        return [], [{"path": ctx.display(key), "reason": str(exc) or "无法读取媒体信息"}]
    kind = info["kind"]
    names = {provider["id"]: provider["name"] for group in info["providers"].values() for provider in group}
    names["embedded"] = "文件内置"
    existing = _existing(ctx, scope, key, info, head.blob_uuid)
    entries, skipped = [], []
    for want in wants or (["cover", "lyrics"] if kind == "audio" else ["cover", "subtitle"]):
        label = f"{ctx.display(key)}（{WANT_LABELS[want]}）"
        if want == "lyrics" and kind != "audio" or want == "subtitle" and kind != "video":
            continue
        note, skip = "", ("embedded",) if force or want == "subtitle" else ()
        exists, embedded_only = existing[want]
        lyrics = info.get("lyrics") or {}
        if want == "lyrics" and lyrics and not force:
            if lyrics.get("synced"):
                try:
                    end = last_time(await media.embedded_lyrics(scope, key, head.etag))
                except (ValueError, NotFoundError):
                    end = None
                if info.get("duration") and end and end > info["duration"] + 10:
                    note, skip = "内置歌词的时间超出了歌曲时长，可能不是这首歌", ("embedded",)
                    # 内置歌词明显不对时不再当作「已有」：默认换成在线结果。
                    exists = None if embedded_only else exists
                elif embedded_only:
                    skipped.append({"path": label, "reason": "文件内置能滚动的歌词，播放器会直接使用；内置歌词不准确时可设置 force_online 在线查找"})
                    continue
            else:
                note = "内置歌词没有时间标签，不能滚动"
        try:
            _, query, found, statuses = await media.collect(scope, key, want, hints or None, skip=skip)
        except ValueError as exc:
            skipped.append({"path": label, "reason": str(exc)})
            continue
        found = found[:PER_WANT[want]]
        if not found:
            errors = [f"{status['name']}：{status['error']}" for status in statuses if status.get("error")]
            reason = "没有找到结果" if statuses else "管理员没有启用能提供这类数据的来源"
            skipped.append({"path": label, "reason": reason + (f"（{'；'.join(errors[:3])}）" if errors else "")})
            continue
        candidates = [_public(candidate, names) for candidate in found]
        best = best_index(want, candidates, query.duration)
        entries.append({"path": key, "etag": head.etag, "modified_at": head.modified_at, "kind": kind, "want": want,
                        "exists": exists, "note": note, "duration": query.duration, "candidates": candidates,
                        # 审批模式的默认选择：已有同类数据时保留现有，由用户决定是否覆盖；
                        # 用户明确要求在线查找（force_online）时，只有文件内置数据的条目直接换成在线结果。
                        "best": best, "choice": best if not exists or force and embedded_only else None,
                        "target": media.asset_target(key, want, found[best or 0].format or "").rsplit("/", 1)[-1] if want != "cover" else None,
                        "_refs": [{"provider": candidate.provider, "ref": candidate.ref} for candidate in found]})
    return entries, skipped


@tool("propose_media_assets", "获取封面、歌词与字幕", "write", "write",
      "为音频、视频文件在线获取封面、歌词（音频）或字幕（视频），生成待确认操作：确认卡片列出各来源的候选供用户挑选，"
      "完全访问模式下自动选择最合适的一项并覆盖已有数据。来源是管理员在「系统设置 → 媒体信息」启用的提供者。"
      "封面优先用文件内嵌的图片；歌词按「时长一致 > 能滚动 > 文件内置」挑选，文件内置能滚动的歌词默认不再查找；"
      "用户说内置数据不准确时设置 force_online=true，只用在线结果。paths 可以是文件或文件夹（取其中第一层的音视频，一次最多 10 个）。"
      "已有封面、歌词文件或字幕时，卡片默认保留现有，由用户选择是否覆盖。",
      {"paths": {"type": "array", "items": PATH, "description": "音频、视频文件或文件夹路径（合计最多 10 个文件）"},
       "want": {"type": "array", "items": {"type": "string", "enum": ["cover", "lyrics", "subtitle"]},
                "description": "要获取的数据：cover 封面、lyrics 歌词（音频）、subtitle 字幕（视频）；省略时音频为封面与歌词、视频为封面与字幕"},
       "force_online": {"type": "boolean", "description": "忽略文件内置的封面与歌词，只用在线结果（用户认为内置数据不准确时）"},
       "title": {"type": "string", "description": "可选：歌名或片名（文件名与标签不准确时使用，只在处理单个文件时有效）"},
       "artist": {"type": "string", "description": "可选：歌手（只在处理单个文件时有效）"},
       "album": {"type": "string", "description": "可选：专辑（只在处理单个文件时有效）"},
       "year": {"type": "string", "description": "可选：年份（只在处理单个文件时有效）"}},
      ("paths",), timeout=240)
async def propose_media_assets(ctx: ToolContext, args: dict) -> ToolOutput:
    if ctx.media is None:
        raise ToolError("媒体信息服务不可用")
    paths = args.get("paths")
    if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_FILES:
        raise ToolError(f"参数 paths 需要 1–{MAX_FILES} 个路径")
    wants = args.get("want")
    if wants is not None and (not isinstance(wants, list) or not wants or any(item not in WANT_LABELS for item in wants)):
        raise ToolError("参数 want 只能包含 cover、lyrics、subtitle")
    wants = list(dict.fromkeys(wants)) if wants else None
    hints = {}
    for name in ("title", "artist", "album", "year"):
        value = args.get(name)
        if value is not None:
            if not isinstance(value, str) or len(value) > 200:
                raise ToolError(f"参数 {name} 需要不超过 200 个字符的文本")
            if value.strip():
                hints[name] = value.strip()
    keys, skipped = _files(ctx, paths)
    if hints and len(keys) > 1:
        raise ToolError("title、artist、album、year 只在处理单个文件时有效")
    gate = asyncio.Semaphore(3)

    async def one(key: str):
        async with gate:
            return await _lookup(ctx, key, wants, args.get("force_online") is True, hints)

    items = []
    for entries, missed in await asyncio.gather(*(one(key) for key in keys)):
        items += entries
        skipped += missed
    if ctx.taint is not None and items:
        ctx.taint("读取过第三方媒体信息")
    refs = {}
    for index, item in enumerate(items):
        for number, frozen in enumerate(item.pop("_refs")):
            refs[f"{index}:{number}"] = frozen
    files = len({item["path"] for item in items})
    kinds = "、".join(WANT_LABELS[want] for want in dict.fromkeys(item["want"] for item in items))
    overwrite = sum(1 for item in items if item["exists"])
    summary = f"为 {files} 个文件获取{kinds}" + (f"（{overwrite} 项已有数据）" if overwrite else "")

    def sample(item: dict) -> str:
        best = item["candidates"][item["best"]] if item["best"] is not None else None
        chosen = (f"推荐 {best['provider_name']}「{best['title']}」" + ("，能滚动" if best.get("synced") else "")) if best else "没有足够匹配的结果"
        return (f"{ctx.display(item['path'])}（{WANT_LABELS[item['want']]}）：{len(item['candidates'])} 个候选，{chosen}"
                + (f"；{item['exists']}" if item["exists"] else ""))

    output = await _propose(ctx, "media", items, skipped=skipped, summary=summary, sample=sample, refs=refs)
    return output
