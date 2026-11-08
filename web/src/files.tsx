/** 文件类型识别、预览与公开分享对话框。 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import * as api from "./api";
import { readPreviewText, TEXT_PREVIEW_LIMIT, type PreviewText } from "./preview-data";
import { encodeText } from "./text-encoding";
import { MediaPreview, MinimizedPlayback, PreviewCachedContext, coverTint, type AssetLoader, type MediaProgress, type MediaState, type PlaybackControls, type PlaybackProps } from "./preview-media";
import { PlaylistPanel, usePreviewPlaylist, type PreviewNav, type PreviewStrip } from "./preview-playlist";
import { ImageViewer } from "./preview-image";
import { cacheFileId, startPreviewPrefetch } from "./cache-client";
import { FileCacheButton, cacheMenuItems, useCacheFiles } from "./user/cache";
import { playerShortcut } from "./preview-keys";
import { PreviewToolsContext, TextPreview } from "./preview-text";
import { PdfPreview } from "./preview-pdf";
import { fileFormatOf } from "./preview-formats";
import { FontPreview } from "./preview-font";
import { EpubPreview } from "./preview-epub";
import { ArchivePreview } from "./preview-archive";
import { Notice, ButtonLink, Badge, Button, CopyField, Field, Icon, IconButton, KeyValue, Menu, Modal, Switch, downloadFile, formatBytes, formatDate, formatDateTime, isShortcutControl, latestMinimized, toast, confirmLeave, useUnsavedChanges, type IconName, type MenuItem } from "./ui";
import { ShortcutsDialog } from "./shortcuts";

export type FileKind = "folder" | "image" | "video" | "audio" | "pdf" | "document" | "spreadsheet" | "presentation" | "text" | "code" | "archive" | "other";

export type EntryFilter = "all" | "folder" | "file";
/** 本机缓存筛选：cached 为完整文件已在这台设备（手动或自动缓存），uncached 为没有完整副本（含只缓存了一部分）。 */
export type CacheFilter = "" | "cached" | "uncached";
const CACHE_FILTERS: { value: Exclude<CacheFilter, "">; label: string; title: string }[] = [
  { value: "cached", label: "已缓存", title: "完整文件已缓存到这台设备（手动或自动）" },
  { value: "uncached", label: "未缓存", title: "这台设备上没有完整副本，含只缓存了一部分的文件" },
];
export type FileSort = { key: "name" | "type" | "size" | "modified"; desc: boolean };
const ENTRY_FILTERS: { value: EntryFilter; label: string }[] = [
  { value: "all", label: "全部" }, { value: "folder", label: "文件夹" }, { value: "file", label: "文件" },
];

/** 一行筛选：「全部」与文件类型按钮常驻（类型可多选，取并集）；项目（文件夹／文件）、公开范围与本机缓存收进末尾的「筛选」菜单，
 * 按钮上显示已启用的条件数。选类型或缓存条件即切到「文件」，选「只看文件夹」会清除类型与缓存条件，「全部」清除一切条件。 */
export function FileFilters({ entry, kind, onEntryChange, onKindChange, cache, onCacheChange, scope, onScopeChange }: {
  entry: EntryFilter; kind: api.KindFilter; onEntryChange: (value: EntryFilter) => void; onKindChange: (value: api.KindFilter) => void;
  /** 本机缓存可用时传入：菜单里多一组「已缓存／未缓存」。 */
  cache?: CacheFilter; onCacheChange?: (value: CacheFilter) => void;
  /** 我的文件传入：菜单里多一组「全部／仅公开」。 */
  scope?: "all" | "public"; onScopeChange?: (value: "all" | "public") => void;
}) {
  const chosen = api.kindValues(kind);
  const extra = (entry !== "all" ? 1 : 0) + (scope === "public" ? 1 : 0) + (cache ? 1 : 0);
  const everything = !chosen.length && !extra;
  const reset = () => { onKindChange(""); onEntryChange("all"); onCacheChange?.(""); onScopeChange?.("all"); };
  const items: MenuItem[] = [
    ...ENTRY_FILTERS.map((option, index) => ({ heading: index === 0 ? "项目" : undefined, label: option.value === "all" ? "文件夹和文件" : option.value === "folder" ? "只看文件夹" : "只看文件",
      icon: (option.value === "folder" ? "folder" : "file") as IconName, checked: entry === option.value,
      onSelect: () => { onEntryChange(option.value); if (option.value === "folder") { onKindChange(""); onCacheChange?.(""); } } })),
    ...(onScopeChange ? [{ heading: "公开", label: "全部文件", icon: "file" as IconName, checked: scope !== "public", divider: true, onSelect: () => onScopeChange("all") },
      { label: "只看已公开", icon: "globe" as IconName, checked: scope === "public", onSelect: () => onScopeChange("public") }] : []),
    ...(onCacheChange ? [{ heading: "本机缓存", label: "不限", icon: "hardDrive" as IconName, checked: !cache, divider: true, onSelect: () => onCacheChange("") },
      ...CACHE_FILTERS.map(option => ({ label: option.label, description: option.title, icon: (option.value === "cached" ? "check" : "hardDrive") as IconName, checked: cache === option.value,
        onSelect: () => { onCacheChange(option.value); if (entry === "folder") onEntryChange("file"); } }))] : []),
    ...(extra ? [{ label: "清除这些条件", icon: "x" as IconName, divider: true, onSelect: () => { onEntryChange("all"); onCacheChange?.(""); onScopeChange?.("all"); } }] : []),
  ];
  return <div className="file-filters">
    <div className="filter-chips" role="group" aria-label="文件类型（可多选）">
      <button type="button" aria-pressed={everything} className={`filter-chip${everything ? " is-active" : ""}`} onClick={reset}>全部</button>
      {api.KIND_FILTERS.map(option => {
        const active = chosen.includes(option.value);
        return <button key={option.value} type="button" aria-pressed={active} className={`filter-chip is-multi${active ? " is-active" : ""}`}
          onClick={() => { const next = api.toggleKind(kind, option.value); onKindChange(next); if (next && entry === "folder") onEntryChange("file"); }}>
          {active && <Icon name="check" size={12} />}{option.label}</button>;
      })}
    </div>
    <Menu items={items} label={extra ? `更多筛选（已启用 ${extra} 项）` : "更多筛选"} align="start" className={`filter-chip filter-more${extra ? " is-active" : ""}`}>
      <Icon name="filter" size={14} /><span>筛选</span>{extra > 0 && <span className="filter-more-count">{extra}</span>}
    </Menu>
  </div>;
}

export function SortHeader({ label, column, sort, onSort, className }: {
  label: string; column: FileSort["key"]; sort: FileSort; onSort: (sort: FileSort) => void; className: string;
}) {
  const active = sort.key === column;
  return <span role="columnheader" className={className} aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
    <button type="button" className={`sort-button${active ? " is-active" : ""}`} onClick={() => onSort({ key: column, desc: active ? !sort.desc : column === "size" || column === "modified" })}>
      {label}<Icon name="chevronDown" size={13} className={active && !sort.desc ? "is-flipped" : ""} />
    </button>
  </span>;
}

/** 列表在窄屏显示，网格始终显示；与表头共用同一个排序状态。 */
export function FileSortSelect({ sort, onSort, grid }: { sort: FileSort; onSort: (sort: FileSort) => void; grid: boolean }) {
  return <label className={`mobile-file-sort${grid ? " is-grid-sort" : ""}`}><span className="sr-only">排序</span><select aria-label="排序" value={`${sort.key}:${sort.desc ? "desc" : "asc"}`} onChange={event => {
    const [key, direction] = event.target.value.split(":"); onSort({ key: key as FileSort["key"], desc: direction === "desc" });
  }}><option value="name:asc">名称升序</option><option value="name:desc">名称降序</option><option value="type:asc">类型升序</option><option value="type:desc">类型降序</option><option value="size:desc">容量从大到小</option><option value="size:asc">容量从小到大</option><option value="modified:desc">最近修改优先</option><option value="modified:asc">最早修改优先</option></select><Icon name="chevronDown" size={14} /></label>;
}

export function matchesKindFilter(file: { content_type?: string | null; key: string }, filter: api.KindFilter): boolean {
  if (!filter) return true;
  const kind = getFileKind(file.content_type, file.key);
  return api.kindValues(filter).some(value => value === "document" ? ["pdf", "document", "spreadsheet", "presentation"].includes(kind)
    : value === "text" ? kind === "text" || kind === "code" : kind === value);
}

const GENERIC_TYPES = ["application/octet-stream", "binary/", "application/force-download", "application/x-download", "application/download",
  "application/unknown", "application/x-unknown", "application/binary", "unknown/"];

export function getFileKind(type: string | null | undefined, name: string): FileKind {
  const lower = name.toLowerCase();
  const mime = (type || "").split(";", 1)[0].trim().toLowerCase();
  if (lower.endsWith("/")) return "folder";
  // 类型以内容为准（服务器写入时按内容判断）：只有 MIME 缺失或是通用二进制时才看扩展名，与 filekinds.py 一致。
  // 与 filekinds.py 的 GENERIC_TYPES 一致：通用二进制与下载站的「强制下载」类类型都按扩展名判断。
  const generic = !mime || GENERIC_TYPES.some(prefix => mime.startsWith(prefix));
  const textual = mime.startsWith("text/") || mime.startsWith("application/json") || /^application\/[\w.-]+\+json/.test(mime);
  const named = (pattern: RegExp) => generic && pattern.test(lower);
  if (mime.startsWith("image/") || named(/\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|heic)$/)) return "image";
  if (mime === "video/mp2t" || named(/\.(mts|m2ts)$/)) return "other";
  // 明确的音频扩展名优先于 video/* MIME：同一种容器看不出音频与视频，来源也常把 FLAC、MP3 标成 video/*。
  const audioName = /\.(mp3|wav|ogg|oga|opus|flac|m4a|aac)$/.test(lower) && (generic || mime.startsWith("video/") || mime.startsWith("audio/"));
  if (!audioName && (mime.startsWith("video/") || named(/\.(mp4|webm|mov|mkv|avi|m4v|ogv)$/))) return "video";
  if (audioName || mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || named(/\.pdf$/)) return "pdf";
  // EPUB 电子书归文档（内容是 ZIP，必须排在压缩包之前）。
  if (named(/\.(docx?|dotx?|odt|rtf|pages|wps|epub)$/) || /wordprocessingml|msword|opendocument\.text/.test(mime) || mime.startsWith("application/epub")) return "document";
  if (named(/\.(xlsx?|xlsm|xltx?|ods|numbers|et)$/) || /spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(mime)) return "spreadsheet";
  if (named(/\.(pptx?|potx?|odp|key|dps)$/) || /presentationml|ms-powerpoint|opendocument\.presentation/.test(mime)) return "presentation";
  if ((generic || textual) && (/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|c|cc|cpp|cxx|h|hpp|cs|sh|bash|zsh|ps1|bat|html?|css|scss|sass|less|vue|svelte|sql|rb|php|swift|kt|kts|scala|dart|gradle|lua|diff|patch)$/.test(lower) || /(^|\/)(dockerfile|makefile)$/.test(lower))) return "code";
  if (textual || named(/\.(md|markdown|mdx|rst|txt|json|jsonc|jsonl|ndjson|geojson|ipynb|csv|tsv|log|xml|ya?ml|toml|ini|conf|cfg|properties|env|gitignore|editorconfig|lrc|srt|vtt)$/) || generic && /(^|\/)\.env(\.[\w.-]+)?$/.test(lower)) return "text";
  if (named(/\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|dmg|iso)$/) || /zip|compressed|x-tar/.test(mime)) return "archive";
  return "other";
}

const KIND_LABEL: Record<FileKind, string> = { folder: "文件夹", image: "图片", video: "视频", audio: "音频", pdf: "PDF 文档", document: "文档", spreadsheet: "表格", presentation: "演示文稿", text: "文本", code: "源代码", archive: "压缩包", other: "文件" };

export function kindLabel(kind: FileKind) { return KIND_LABEL[kind]; }

/* 文件类型图标：文件是一张细描边、折角的纸，类型只靠纸面中下部的单色记号区分（形状或格式标签，不靠颜色）；
 * 文件夹是双色扁平文件夹。纸的描边不随尺寸变粗（non-scaling-stroke），记号随尺寸等比放大。 */
const PAPER = "M6.5 2.5h7l5 5v13a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1Z";
const FOLD = "M13.5 2.5v4a1 1 0 0 0 1 1h4";
function formatLabel(text: string) {
  return <><rect className="glyph-fill" x="3.5" y="12.25" width="12" height="6" rx="1.25" /><text className="glyph-label" x="9.5" y="16.6" textAnchor="middle">{text}</text></>;
}
const KIND_MARK: Record<Exclude<FileKind, "folder">, ReactNode> = {
  text: <path className="glyph-stroke" d="M8.75 12h6.5M8.75 14.75h6.5M8.75 17.5h4" />,
  code: <path className="glyph-stroke" d="M10.25 12.25 8.5 14.5l1.75 2.25m3.5-4.5 1.75 2.25-1.75 2.25" />,
  image: <><circle className="glyph-fill" cx="14.6" cy="11.6" r="1.25" /><path className="glyph-fill" d="M7.9 18.4 10.6 14.3a.5.5 0 0 1 .83 0l1.7 2.45 1.05-1.2a.5.5 0 0 1 .78.04l1.67 2.4a.25.25 0 0 1-.2.4H8.1a.25.25 0 0 1-.2-.38Z" /></>,
  video: <path className="glyph-fill" d="M10.25 11.6a.6.6 0 0 1 .9-.52l4.6 2.9a.6.6 0 0 1 0 1.02l-4.6 2.9a.6.6 0 0 1-.9-.51Z" />,
  audio: <><path className="glyph-stroke" d="M10.75 17.25V12l4.25-.9v5.25" /><circle className="glyph-fill" cx="9.6" cy="17.3" r="1.3" /><circle className="glyph-fill" cx="13.85" cy="16.4" r="1.3" /></>,
  pdf: formatLabel("PDF"),
  document: formatLabel("DOC"),
  spreadsheet: formatLabel("XLS"),
  presentation: formatLabel("PPT"),
  archive: <><path className="glyph-stroke" d="M11.5 2.75v1.25m0 1.75V7m0 1.75V10" /><rect className="glyph-fill" x="10" y="11.25" width="3" height="4.25" rx=".75" /></>,
  other: null,
};

export function FileGlyph({ kind, size = 24 }: { kind: FileKind; size?: number }) {
  return (
    <svg className={`file-glyph glyph-${kind}`} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      {kind === "folder" ? <>
        <path className="folder-back" d="M2.5 6.25c0-.97.78-1.75 1.75-1.75h4.3c.47 0 .92.19 1.25.52L11.3 6.5h8.45c.97 0 1.75.78 1.75 1.75V10h-19Z" />
        <path className="folder-front" d="M2.5 9.25c0-.69.56-1.25 1.25-1.25h16.5c.69 0 1.25.56 1.25 1.25v9c0 .97-.78 1.75-1.75 1.75H4.25c-.97 0-1.75-.78-1.75-1.75Z" />
      </> : <>
        <path className="glyph-paper" d={PAPER} vectorEffect="non-scaling-stroke" />
        <path className="glyph-fold" d={FOLD} vectorEffect="non-scaling-stroke" />
        {KIND_MARK[kind]}
      </>}
    </svg>
  );
}

const TILE_SIZE = { md: 24, lg: 32, xl: 56 } as const;

export function FileTile({ kind, size = "md" }: { kind: FileKind; size?: "md" | "lg" | "xl" }) {
  return <span className={`file-tile tile-${kind} tile-${size}`} aria-hidden="true"><FileGlyph kind={kind} size={TILE_SIZE[size]} /></span>;
}

/** 有缩略图时显示缩略图，否则（或加载失败时）显示文件类型图标。 */
/** 缩略图读取失败（多为服务器繁忙的 503）后隔一会儿重新加载同一地址；几次后仍失败才换成类型图标。
 *  地址不变，浏览器缓存与服务端的长期缓存判断都不受影响。 */
const THUMBNAIL_RETRIES = [3000, 10000, 30000];
function useImageRetry(src?: string) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const timer = useRef(0);
  useEffect(() => { setAttempt(0); setFailed(false); return () => window.clearTimeout(timer.current); }, [src]);
  const onError = () => {
    if (attempt >= THUMBNAIL_RETRIES.length) { setFailed(true); return; }
    setFailed(true);
    timer.current = window.setTimeout(() => { setAttempt(value => value + 1); setFailed(false); }, THUMBNAIL_RETRIES[attempt]);
  };
  return { failed, onError, key: `${src}#${attempt}` };
}

export function FileVisual({ kind, src, size = "md" }: { kind: FileKind; src?: string; size?: "md" | "lg" | "xl" }) {
  const retry = useImageRetry(src);
  if (!src || retry.failed) return <FileTile kind={kind} size={size} />;
  return <span className={`file-tile file-visual tile-${size}`} aria-hidden="true"><img key={retry.key} src={src} alt="" loading="lazy" decoding="async" onError={retry.onError} /></span>;
}

/** 网格视图文件夹卡片左侧的封面：用文件夹里已有的列表小图拼成 1／2／4 格，没有时显示文件夹图标。
 *  角上保留一个小文件夹标记，有封面时也能一眼认出是文件夹。 */
export function FolderCover({ previews = [] }: { previews?: { key: string; url: string }[] }) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const usable = previews.filter(item => !failed.has(item.key));
  const shown = usable.slice(0, usable.length >= 4 ? 4 : usable.length >= 2 ? 2 : 1);
  if (!shown.length) return <FileTile kind="folder" size="lg" />;
  return <span className={`folder-cover is-${shown.length}`} aria-hidden="true">
    {shown.map(item => <img key={item.key} src={item.url} alt="" loading="lazy" decoding="async"
      onError={() => setFailed(current => new Set(current).add(item.key))} />)}
    <span className="folder-cover-mark"><FileGlyph kind="folder" size={14} /></span>
  </span>;
}

/** 网格卡片的占位小图：只有本页已经加载过的列表小图才用来占位（从列表切到网格时，来自内存缓存、不产生请求）。
 *  没加载过就不占位——否则每张卡片要多读一次存储，与网格图挤在同一条缩略图读取通道里，封面整体变慢。 */
// 浏览器默认只保留 250 条资源计时记录；上千张缩略图的目录需要更大的缓冲，判断才不会在前几百张之后失效。
if (typeof performance !== "undefined") performance.setResourceTimingBufferSize?.(5000);
export function loadedPlaceholder(url?: string) {
  if (!url || typeof performance === "undefined") return undefined;
  const absolute = new URL(url, location.href).href;
  return performance.getEntriesByName(absolute, "resource").length ? url : undefined;
}

/** placeholder：大图加载完成前先显示的小图（用 loadedPlaceholder 判断是否已在本页加载过）。 */
export function FileThumbnail({ kind, url, placeholder }: { kind: FileKind; url?: string; placeholder?: string }) {
  // 按资源地址重建状态，避免缓存图片的 load 事件被挂载后的 effect 重置。
  return <ThumbnailImage key={url} kind={kind} url={url} placeholder={placeholder === url ? undefined : placeholder} />;
}

/** 网格里的文件夹封面：用文件夹里已有的缩略图铺满封面区，按张数拼成 1／2／4 格（不留空格子）；
 * 加载失败的图片去掉后重新排版，一张也没有时显示文件夹图标。左下角的小标记表明这是文件夹。 */
export function FolderThumbnail({ previews = [] }: { previews?: { key: string; content_type: string | null; url: string }[] }) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const usable = previews.filter(item => !failed.has(item.key));
  const shown = usable.slice(0, usable.length >= 4 ? 4 : usable.length >= 2 ? 2 : 1);
  if (!shown.length) return <FileThumbnail kind="folder" />;
  return <div className={`folder-thumbnail is-${shown.length}`} role="img" aria-label="文件夹内容预览">
    {shown.map(item => <span key={item.key} className="folder-thumbnail-cell" aria-hidden="true">
      <img src={item.url} alt="" loading="lazy" decoding="async" onError={() => setFailed(current => new Set(current).add(item.key))} />
    </span>)}
    <span className="folder-preview-badge" aria-hidden="true"><FileGlyph kind="folder" size={16} /></span>
  </div>;
}

function ThumbnailImage({ kind, url, placeholder }: { kind: FileKind; url?: string; placeholder?: string }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [fallback, setFallback] = useState<"loading" | "ready" | "failed">("loading");
  const retry = useImageRetry(url);
  const failed = state === "failed" || retry.failed;
  const covered = state === "ready" || (placeholder && fallback === "ready");
  return <div className={`file-thumbnail thumbnail-${failed ? "failed" : state}`}>
    {(!url || !covered) && <FileTile kind={kind} size="xl" />}
    {url && placeholder && state !== "ready" && fallback !== "failed" && <img className="thumbnail-placeholder" src={placeholder} alt="" loading="lazy" onLoad={() => setFallback("ready")} onError={() => setFallback("failed")} />}
    {url && !retry.failed && state !== "failed" && <img key={retry.key} src={url} alt="" loading="lazy" onLoad={() => setState("ready")} onError={retry.onError} />}
    {url && covered && (kind === "video" || kind === "audio") && <span className="thumbnail-badge" aria-hidden="true"><Icon name={kind === "video" ? "play" : "audio"} size={12} /></span>}
  </div>;
}

export function baseName(key: string) {
  return key.replace(/\/$/, "").split("/").at(-1) || key;
}
export function parentPath(key: string) {
  const parts = key.replace(/\/$/, "").split("/");
  parts.pop();
  return parts.length ? `${parts.join("/")}/` : "";
}

const PREVIEWABLE: FileKind[] = ["image", "video", "audio", "pdf", "text", "code"];
/** 浏览器原生 <video>/<audio> 都无法播放的格式：直接提示下载，不让播放器反复重连。 */
const UNPLAYABLE = /\.(ts|m2ts|mts|avi|wmv|asf|flv|f4v|rm|rmvb|vob|mpg|mpeg|wma|ape|amr|ra)$/i;
const UNPLAYABLE_TYPES = /^(video\/(mp2t|x-msvideo|avi|x-ms-wmv|x-ms-asf|x-flv|mpeg)|audio\/(x-ms-wma|ape|x-ape|amr))$/i;
export function isPlayable(name: string, type?: string | null) {
  return !UNPLAYABLE.test(name) && !UNPLAYABLE_TYPES.test((type || "").split(";")[0].trim());
}
/** 能在线查看：常见类型，以及有专门查看器的字体与电子书（压缩包浏览只给本人的文件，由预览窗口单独判断）。 */
export function canPreview(kind: FileKind, name?: string, type?: string | null) {
  if (PREVIEWABLE.includes(kind)) return true;
  const format = name === undefined ? null : fileFormatOf(kind, name, type);
  return format === "font" || format === "epub";
}

/** 把 Markdown 里的相对路径图片解析为云盘内的绝对键；越出根目录或带协议的地址返回 null。 */
export function resolveRelativeKey(baseDir: string, src: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return null;
  let path = src.split(/[?#]/)[0];
  try { path = decodeURI(path); } catch { /* 保留原样 */ }
  const segments: string[] = [];
  for (const part of ((path.startsWith("/") ? "" : baseDir) + path).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!segments.pop()) return null; } else segments.push(part);
  }
  return segments.length ? segments.join("/") : null;
}

/** 内容区：分享页与预览弹窗共用同一套渲染逻辑。 */
type PreviewProps = { kind: FileKind; url: string; name: string; downloadUrl: string; contentType?: string | null; /** 文件大小：音乐没有歌词时显示大小与估算码率。 */ size?: number; /** 已记录的图片／视频显示尺寸：视频按它设播放器比例，图片按它在加载前就把封面与原图放到最终位置。 */ videoSize?: api.MediaSize; poster?: string; posterMaxEdge?: number; onImageLoad?: (image: HTMLImageElement) => void; onImageSize?: (width: number, height: number, original: boolean) => void; resolveImage?: (src: string) => string | null; loadAssets?: AssetLoader; assetUrl?: (path: string) => string; nav?: PreviewNav; strip?: PreviewStrip; text?: TextEditing;
  /** 电子书的阅读位置：按内容版本记住（remember 为假时只记在本页内存里，私密文件用）。 */ positionKey?: string | null; rememberPosition?: boolean;
  /** 本人的压缩包：可以浏览内容并在线解压。 */ archive?: { file: api.FileItem; onExtract?: (picks?: string[]) => void } } & PlaybackProps;
/** 文本编辑：只给本人有写权限的文件。key 是文件路径（保存后地址随版本变化，编辑器不重建）；load 递增时重新读取（换文件、外部改动、冲突后重新加载）。 */
type TextEditing = { key: string; load: number; save: (data: Uint8Array, force: boolean) => Promise<void>; reload: () => Promise<void>; onDirty: (dirty: boolean) => void; start?: boolean };
export function FilePreview(props: PreviewProps) {
  const [attempt, setAttempt] = useState(0);
  // 音视频与图片切换时复用同一个播放器／查看器（图片的缩略图条才能从上一张平滑滚动到下一张），其他类型按地址重建。
  return <PreviewContent key={`${props.kind}:${props.kind === "audio" || props.kind === "video" || props.kind === "image" ? "media" : props.text?.key ?? props.url}:${attempt}`} {...props} onRetry={() => setAttempt(current => current + 1)} />;
}

function PreviewLoading({ onRetry }: { onRetry: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setSlow(true), 8000); return () => window.clearTimeout(timer); }, []);
  return <div className="preview-loading" role="status"><span className="spinner spinner-lg" /><span>{slow ? "加载时间较长" : "正在加载预览…"}</span>
    {slow && <Button size="sm" variant="ghost" icon="refresh" onClick={onRetry}>重试</Button>}
  </div>;
}

function PreviewContent({ kind, url, name, downloadUrl, contentType, size, videoSize, poster, posterMaxEdge, onImageLoad, onImageSize, resolveImage, loadAssets, assetUrl, nav, strip, onRetry, onEnded, onPlaying, onProgress, onState, onControls, onVideoSize, onVideoFrame, onSaveThumbnail, onLyricLine, rotation, onRotate, onBufferSpeed, onFindAssets, assetRevision, preferAsset, upcoming, session, text, positionKey, rememberPosition, archive }: PreviewProps & { onRetry: () => void }) {
  const format = fileFormatOf(kind, name, contentType);
  const [content, setContent] = useState<PreviewText | null>(null);
  // 每次读到新内容递增，文本预览按它重建；自己保存不重新读取，编辑器保持原状。
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [mediaFailed, setMediaFailed] = useState(false);
  // 图片复用组件，切换到下一张时清除上一张的失败状态。
  useEffect(() => { if (kind === "image") setMediaFailed(false); if (kind === "pdf" || format) setError(""); }, [url, kind]);
  useEffect(() => {
    if (kind !== "text" && kind !== "code") return;
    setContent(null); setError("");
    const controller = new AbortController();
    // 按统一的预览上限读取，避免无界加载大日志。
    void readPreviewText(url, TEXT_PREVIEW_LIMIT, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setContent(value); setRevision(current => current + 1); } })
      .catch(reason => { if (!controller.signal.aborted) setError(api.errorMessage(reason, "无法读取文件，请稍后重试")); });
    return () => controller.abort();
  }, [text ? text.load : url, kind]);
  const failed = Boolean(mediaFailed || error);
  const extension = name.match(/\.([a-z\d]{1,8})$/i)?.[1].toUpperCase();
  const unplayable = (kind === "video" || kind === "audio") && !isPlayable(name, contentType);
  const lower = (extension ?? "").toLowerCase();
  // 不支持在线查看的常见类型给出具体的打开方式，其余用通用说明。
  const advice = /^(docx?|xlsx?|pptx?|odt|ods|odp|pages|numbers|key|rtf)$/.test(lower) ? "Office 与办公文档请下载后用 Word、Excel、Keynote 等应用打开。"
    : /^(zip|rar|7z|tar|gz|tgz|bz2|xz|zst)$/.test(lower) ? "压缩包不能在线查看，下载后解压即可使用。"
    : /^(exe|msi|dmg|pkg|apk|ipa|deb|rpm|iso|img)$/.test(lower) ? "安装包与磁盘映像请下载后在对应的系统中打开。"
    : "下载后用本地应用打开。";
  const fallback = (
    <div className="preview-fallback">
      <FileTile kind={kind} size="xl" />
      <h3>{failed ? "预览没有加载出来" : unplayable ? `浏览器无法播放${extension ? ` ${extension} ` : "这种"}格式` : `${extension ? `${extension} 文件` : "这种文件"}暂不支持在线查看`}</h3>
      <p>{error || (failed ? "可能是网络中断，或浏览器不支持这个格式。可以重试，或下载后打开。" : unplayable ? "请下载后用本地播放器打开，例如 VLC、IINA。" : advice)}</p>
      <div className="preview-recovery">
        {failed && <Button size="sm" icon="refresh" onClick={onRetry}>重试</Button>}
        {downloadUrl && <ButtonLink variant={failed ? "secondary" : "primary"} size="sm" icon="download" href={downloadUrl}>下载文件</ButtonLink>}
      </div>
    </div>
  );

  if (unplayable) return fallback;
  if (format === "font") return error ? fallback : <FontPreview url={url} name={name} onError={setError} />;
  if (format === "epub") return error ? fallback : <EpubPreview url={url} positionKey={positionKey ?? null} remember={rememberPosition ?? true} onError={setError} />;
  if (format === "archive" && archive) return <ArchivePreview file={archive.file} downloadUrl={downloadUrl} onExtract={archive.onExtract} />;
  if (kind === "video" || kind === "audio") return <MediaPreview kind={kind} url={url} name={name} size={size} videoSize={videoSize} cover={poster} onRetry={onRetry} loadAssets={loadAssets} assetUrl={assetUrl} nav={nav} onEnded={onEnded} onPlaying={onPlaying} onProgress={onProgress} onState={onState} onControls={onControls} onVideoSize={onVideoSize} onVideoFrame={onVideoFrame} onSaveThumbnail={onSaveThumbnail} onLyricLine={onLyricLine} rotation={rotation} onRotate={onRotate} onBufferSpeed={onBufferSpeed} onFindAssets={onFindAssets} assetRevision={assetRevision} preferAsset={preferAsset} upcoming={upcoming} session={session} />;
  if (mediaFailed) return fallback;
  // 本机缓存仍需读取、解密及图片解码：先用封面占位，原图就绪后显示；背景与补图延后到绘制之后。
  if (kind === "image") return <ImageViewer url={url} name={name} heic={format === "heic"} poster={poster} posterMaxEdge={posterMaxEdge} size={videoSize} nav={nav} strip={strip} onError={() => setMediaFailed(true)} onLoad={onImageLoad} onImageSize={onImageSize} />;
  if (kind === "pdf") return error ? fallback : <PdfPreview url={url} name={name} onError={setError} />;
  if (kind === "text" || kind === "code") {
    if (error) return fallback;
    if (content === null) return <PreviewLoading onRetry={onRetry} />;
    const edit = text && { save: (value: string, force: boolean) => text.save(encodeText(value, content.encoding, content.bom), force), reload: text.reload, onDirty: text.onDirty, start: text.start };
    return <TextPreview key={revision} content={content} name={name} code={kind === "code"} downloadUrl={downloadUrl} resolveImage={resolveImage} edit={edit || undefined}
      onError={reason => setError(api.errorMessage(reason, "文本预览没有加载出来，请刷新页面后重试"))} />;
  }
  return fallback;
}

type PreviewSource = { url: string; downloadUrl: string; poster?: string; grid?: string; thumbnail?: string };
/** 本页读到或补记过的图片／视频尺寸（按内容版本）：列表数据刷新前再次打开也直接按实际比例打开、显示分辨率。 */
const recordedSizes = new Map<string, api.MediaSize>();
/** 视频画面旋转按内容版本记在本机（localStorage，最多 300 个）；私密文件只在本页内存里记住，不写入浏览器存储。 */
const ROTATION_KEY = "tessera:video-rotation", ROTATION_LIMIT = 300;
const sessionRotations = new Map<string, number>();
function storedRotations(): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(ROTATION_KEY) ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, number> : {};
  } catch { return {}; }
}
function videoRotation(file: api.FileItem): number {
  if (api.isPrivatePath(file.key)) return sessionRotations.get(file.etag) ?? 0;
  const value = storedRotations()[file.etag];
  return value === 90 || value === 180 || value === 270 ? value : 0;
}
function rememberRotation(file: api.FileItem, degrees: number) {
  if (api.isPrivatePath(file.key)) { if (degrees) sessionRotations.set(file.etag, degrees); else sessionRotations.delete(file.etag); return; }
  const entries = Object.entries(storedRotations()).filter(([etag]) => etag !== file.etag);
  if (degrees) entries.push([file.etag, degrees]);
  try {
    if (entries.length) localStorage.setItem(ROTATION_KEY, JSON.stringify(Object.fromEntries(entries.slice(-ROTATION_LIMIT))));
    else localStorage.removeItem(ROTATION_KEY);
  } catch { /* 存储不可用时只在本次预览里生效 */ }
}
export type PreviewPlayback = { playing: boolean; currentTime: number; state: MediaState };
export function PreviewModal({ file, url, downloadUrl, poster, grid, thumbnail, onClose, onShare, onExtract, onEditImage, onFindMedia, onMissingCover, onImageLoad, onVideoFrame, onSaveVideoThumbnail, assetUrl, loadAssets, playlistFiles, anyFolder = false, sourceFor, onPlaybackActivity, minimizeRequest, startEditing }: PreviewSource & {
  /** 打开后直接进入文本编辑（刚新建的文件）。 */ startEditing?: boolean;
  /** 播放列表不限同一文件夹（相册、音乐库、最近这类跨文件夹的页面）。 */ anyFolder?: boolean; file: api.FileItem; onClose: () => void; minimizeRequest?: number; onShare?: (file: api.FileItem) => void;
  /** 在线查找歌词、字幕或封面（播放器里没有歌词、字幕或封面时的入口）；保存后页面广播 MEDIA_ASSETS_EVENT。 */ onFindMedia?: (file: api.FileItem, want: api.MediaWant) => void;
  /** 本人的音乐还没有封面时调用：由宿主用文件内嵌的封面补上（已有封面时服务器拒绝，不会覆盖）。 */ onMissingCover?: (file: api.FileItem) => void;
  /** 在线解压（压缩包预览里的「解压到…」）；picks 是预览里勾选的文件，不传表示整个压缩包。 */ onExtract?: (file: api.FileItem, picks?: string[]) => void;
  /** 编辑图片（图片预览头部的按钮）。 */ onEditImage?: (file: api.FileItem) => void; onImageLoad?: (image: HTMLImageElement, file: api.FileItem) => void; onVideoFrame?: (video: HTMLVideoElement, file: api.FileItem) => void; onSaveVideoThumbnail?: (video: HTMLVideoElement, file: api.FileItem, rotation: number) => Promise<void>; assetUrl?: (key: string) => string; loadAssets?: (file: api.FileItem, signal: AbortSignal) => Promise<api.PreviewAsset[]>; playlistFiles?: api.FileItem[]; sourceFor?: (file: api.FileItem) => PreviewSource; onPlaybackActivity?: (state: PreviewPlayback) => void }) {
  const kind = getFileKind(file.content_type, file.key);
  const media = (kind === "audio" || kind === "video") && isPlayable(file.key, file.content_type);
  const browsable = media || kind === "image";
  // 文本、代码、PDF、电子书、字体与压缩包也用沉浸式窗口（深色画布 + 浮动头部），但没有播放列表与左右切换。
  const format = fileFormatOf(kind, file.key, file.content_type);
  const ownFile = /^\/api\/user\/v1\/(?:private\/)?content\?/.test(url);
  const reading = kind === "text" || kind === "code" || kind === "pdf" || format === "epub" || format === "font" || format === "archive" && ownFile;
  const immersive = browsable || reading;
  const [textTools, setTextTools] = useState<HTMLElement | null>(null);
  const [compactActions, setCompactActions] = useState(false);
  const [textMenuItems, setTextMenuItems] = useState<MenuItem[]>([]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const readingTools = useMemo(() => reading && textTools ? { target: textTools, compact: compactActions, setMenuItems: setTextMenuItems } : null, [reading, textTools, compactActions]);
  const playlist = usePreviewPlaylist(file, kind, playlistFiles,
    item => getFileKind(item.content_type, item.key) === kind && (kind === "image" || isPlayable(item.key, item.content_type)) && (anyFolder || parentPath(item.key) === parentPath(file.key)));
  const active = browsable && playlist.current.key !== file.key ? playlist.current : file;
  const derived = (item: api.FileItem): PreviewSource => sourceFor?.(item) ?? {
    url: api.contentUrl(item.key), downloadUrl: api.contentUrl(item.key, true), poster: api.fileThumbnail(item, "poster"), grid: api.fileThumbnail(item, "grid"), thumbnail: api.fileThumbnail(item),
  };
  // 打开的文件沿用传入的地址；缩略图按最新的文件信息计算，页面补上缩略图后预览头部与底部列表随之更新。
  const sourceOf = (item: api.FileItem): PreviewSource => {
    if (item.key !== file.key) return derived(item);
    const latest = derived(item);
    return { url, downloadUrl, poster: latest.poster ?? poster, grid: latest.grid ?? grid, thumbnail: latest.thumbnail ?? thumbnail };
  };
  const source = sourceOf(active);
  // 音乐连播：下一首的地址交给播放器预先缓冲（随机模式在 upcoming 里定下，播完时取同一首）。
  const upcomingFile = kind === "audio" && browsable ? playlist.upcoming() : null;
  // 与实际播放地址一致（带内容版本），切歌时播放器才能认出已缓冲的备用元素。
  const upcomingUrl = upcomingFile ? api.versionedContentUrl(sourceOf(upcomingFile).url, upcomingFile.etag, upcomingFile.size, true) : null;
  // 先复用本页已读取的封面，避免网格图已经可见，却为了另一规格的封面再次等待回源。
  // 按文件与封面版本固定本次选择，后续状态刷新不把正在展示的占位图换成尚未加载的地址。
  const imagePoster = useMemo(() => kind === "image"
    ? loadedPlaceholder(source.poster) ?? loadedPlaceholder(source.grid) ?? loadedPlaceholder(source.thumbnail) ?? source.poster ?? source.grid ?? source.thumbnail
    : source.poster, [kind, active.key, source.poster, source.grid, source.thumbnail]);
  const imagePosterMaxEdge = api.thumbnailSpec(active, imagePoster === source.poster ? "poster" : imagePoster === source.grid ? "grid" : "thumb").maxEdge;
  // 播放列表、最小化小窗与快捷键说明沿用音乐播放器的背景：当前文件的封面模糊后铺底，没有封面时用按文件名选的色调。
  const mediaSurface: Record<string, string> = media ? { "--preview-tint": coverTint(baseName(active.key)), ...(source.poster ? { "--preview-cover": `url("${source.poster}")` } : {}) } : {};
  const ownSource = /^\/api\/user\/v1\/(?:private\/)?content\?/.test(source.url);
  const cacheQueue = useCacheFiles([active], ownSource);
  const activeCacheId = cacheFileId(active);
  const fullyCached = Boolean(ownSource && (cacheQueue?.states.get(activeCacheId)?.complete || cacheQueue?.cached.get(activeCacheId)?.complete));
  const downloadHref = ownSource ? api.versionedContentUrl(source.downloadUrl, active.etag, active.size) : source.downloadUrl;
  // 文本编辑：只给本人的文件（我的文件与已解锁的私密空间），回收站、系统区与分享页只读。
  const editable = (kind === "text" || kind === "code") && ownSource && (!active.key.startsWith(".tgdrive/") || api.isPrivatePath(active.key));
  const [textDirty, setTextDirty] = useState(false);
  useUnsavedChanges(textDirty);
  const [textLoad, setTextLoad] = useState(0);
  const savedEtags = useRef(new Set<string>()), shownVersion = useRef(`${active.key}\n${active.etag}`);
  // 文件换了版本：自己保存产生的版本不重新读取（编辑器保持原状），换文件或其他来源的改动重新读取。
  useEffect(() => {
    const version = `${active.key}\n${active.etag}`;
    if (version === shownVersion.current) return;
    shownVersion.current = version;
    if (!savedEtags.current.has(active.etag)) setTextLoad(current => current + 1);
  }, [active.key, active.etag]);
  const textEditing = useMemo(() => editable ? {
    key: active.key, load: textLoad, onDirty: setTextDirty, start: Boolean(startEditing && active.key === file.key),
    save: async (data: Uint8Array, force: boolean) => {
      const item = await api.saveTextFile(active, data, force);
      savedEtags.current.add(item.etag);
      api.announceFileUpdated(item);
    },
    reload: async () => {
      const latest = await api.fileInfo(active.key);
      // 版本变了由上面的副作用重新读取；版本没变（冲突时内容已一致）时这里直接重读。
      if (latest.etag === active.etag) setTextLoad(current => current + 1);
      else api.announceFileUpdated(latest);
    },
  } : undefined, [editable, active, textLoad]);
  const closePreview = () => { if (!textDirty) onClose(); else void confirmLeave().then(leave => { if (leave) onClose(); }); };
  // 在线查找：只给本人的音视频（我的文件与已解锁的私密空间）；保存了新的歌词或字幕后播放器重新读取并选中它。
  const findable = media && ownSource && Boolean(onFindMedia) && (!active.key.startsWith(".tgdrive/") || api.isPrivatePath(active.key));
  const [assetChange, setAssetChange] = useState<{ revision: number; prefer?: string }>({ revision: 0 });
  const missingCover = findable && kind === "audio" && !active.thumbnails?.includes("thumb") && active.thumbnail_status !== "ready";
  useEffect(() => { if (missingCover) onMissingCover?.(active); }, [missingCover, active.key, active.etag]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ media: string; asset?: string }>).detail;
      if (detail?.media === active.key) setAssetChange(current => ({ revision: current.revision + 1, prefer: detail.asset }));
    };
    window.addEventListener(api.MEDIA_ASSETS_EVENT, changed);
    return () => window.removeEventListener(api.MEDIA_ASSETS_EVENT, changed);
  }, [active.key]);
  const [videoSize, setVideoSize] = useState<{ key: string; etag: string; ratio: number } | null>(null);
  // 已记录尺寸（列表接口的 dimensions，或本页刚读到的）时一开始就按视频比例打开；没有时先按 16:9，读到元信息后改为实际比例。
  // 同一份尺寸也在预览头部显示为分辨率（图片、视频）。
  const [, setSizeRevision] = useState(0);
  const knownSize = active.dimensions ?? recordedSizes.get(active.etag);
  const sourceRatio = videoSize?.key === active.key && videoSize.etag === active.etag ? videoSize.ratio : knownSize ? knownSize.width / knownSize.height : 16 / 9;
  // 画面转过四分之一圈时窗口按转过来的比例显示。
  const [rotationRevision, setRotationRevision] = useState(0);
  const rotation = useMemo(() => kind === "video" ? videoRotation(active) : 0, [kind, active.key, active.etag, rotationRevision]);
  const videoRatio = rotation % 180 ? 1 / sourceRatio : sourceRatio;
  function rotateVideo(degrees: number) {
    rememberRotation(active, ((degrees % 360) + 360) % 360);
    setRotationRevision(value => value + 1);
  }
  const [playlistExpanded, setPlaylistExpanded] = useState(false);
  const controls = useRef<PlaybackControls | null>(null), pendingPlay = useRef(false), currentKey = useRef(active.key);
  currentKey.current = active.key;
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState<MediaProgress>({ currentTime: 0, duration: 0 });
  const [mediaState, setMediaState] = useState<MediaState>("loading");
  const [bufferSpeed, setBufferSpeed] = useState<number | null>(null);
  const [lyric, setLyric] = useState<{ key: string; line: string | null }>({ key: active.key, line: null });
  // 预览音视频期间在后台多段并行预读（自动缓存），关闭预览或换文件时停止；拖动进度后从新位置往后预读。
  const prefetch = useRef<ReturnType<typeof startPreviewPrefetch> | null>(null), prefetchTime = useRef(0);
  useEffect(() => {
    if (!media || !ownSource) return;
    const job = startPreviewPrefetch(active);
    prefetch.current = job; prefetchTime.current = 0;
    return () => { job.stop(); if (prefetch.current === job) prefetch.current = null; };
  }, [media, ownSource, active.key, active.etag]);
  // 读到图片原图或视频的实际尺寸时在头部显示分辨率，并记录下来（只记本人的文件），下次直接按这个比例打开、显示分辨率。
  function recordSize(width: number, height: number) {
    if (kind !== "video" && kind !== "image" || width <= 0 || height <= 0) return;
    const known = active.dimensions ?? recordedSizes.get(active.etag);
    if (known && known.width === width && known.height === height) return;
    recordedSizes.set(active.etag, { width, height });
    setSizeRevision(value => value + 1);
    if (ownSource) void api.setMediaSize(active, { width, height }).catch(() => undefined);
  }
  const trackPrefetch = (value: MediaProgress) => {
    // 播放进度跳动超过 15 秒视为拖动：按时长比例换算成字节位置。
    if (value.duration > 0 && Math.abs(value.currentTime - prefetchTime.current) > 15)
      prefetch.current?.seek(value.currentTime / value.duration * active.size);
    prefetchTime.current = value.currentTime;
  };
  const activityCallback = useRef(onPlaybackActivity);
  activityCallback.current = onPlaybackActivity;
  useEffect(() => { activityCallback.current?.({ playing: media && playing, currentTime: progress.currentTime, state: mediaState }); }, [media, playing, progress.currentTime, mediaState]);
  useEffect(() => () => { activityCallback.current?.({ playing: false, currentTime: 0, state: "ready" }); }, []);
  function play() {
    if (!controls.current) { pendingPlay.current = true; return; }
    const key = active.key;
    void controls.current.play().catch(reason => {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      if (currentKey.current === key) toast.error("自动播放未能开始，请点击播放器继续播放。");
    });
  }
  function togglePlayback() {
    if (!controls.current) { pendingPlay.current = !pendingPlay.current; return; }
    // 原生状态先于 React 的画面更新，快速连按也要正确暂停已发起的播放。
    if (controls.current.isPlaying()) { pendingPlay.current = false; controls.current.pause(); } else play();
  }
  function select(item: api.FileItem) {
    if (kind === "image") { playlist.select(item); return; }
    if (item.key === active.key) { if (controls.current) { controls.current.seek(0); play(); } else pendingPlay.current = true; return; }
    pendingPlay.current = true; playlist.select(item);
  }
  // 打开（或换成另一个）音视频文件后直接播放：播放器还没就绪时先记下，就绪后由 onControls 开始；浏览器拦截时 play() 会提示点击播放。
  useEffect(() => { pendingPlay.current = false; if (media) play(); }, [file.key]);
  // 音视频的 ← →：短按（松开时）切换上一首／下一首，长按（按键开始自动重复后）每 150 ms 后退／前进 5 秒，松开时不再切换。
  // 进度条获得焦点时也按这个规则，不再由滑块自己处理方向键。
  const arrowHold = useRef<{ key: string; seeking: boolean; last: number } | null>(null);
  const releaseArrow = useRef<(key: string) => void>(() => undefined);
  releaseArrow.current = key => {
    const hold = arrowHold.current;
    if (!hold || hold.key !== key) return;
    arrowHold.current = null;
    if (hold.seeking || playlist.items.length < 2) return;
    const next = key === "arrowleft" ? playlist.previous() : playlist.next();
    if (next) select(next);
  };
  useEffect(() => {
    const up = (event: globalThis.KeyboardEvent) => releaseArrow.current(event.key.toLowerCase());
    const reset = () => { arrowHold.current = null; };
    window.addEventListener("keyup", up); window.addEventListener("blur", reset);
    return () => { window.removeEventListener("keyup", up); window.removeEventListener("blur", reset); };
  }, []);
  function pressArrow(event: KeyboardEvent<HTMLDivElement>, key: string) {
    event.preventDefault(); event.stopPropagation();
    const hold = arrowHold.current;
    if (!event.repeat || !hold || hold.key !== key) {
      if (!event.repeat) arrowHold.current = { key, seeking: false, last: 0 };
      return;
    }
    hold.seeking = true;
    const now = performance.now();
    if (now - hold.last < 150) return;
    hold.last = now;
    controls.current?.seekBy(key === "arrowleft" ? -5 : 5);
  }
  // 快捷键优先级：文件助手 > 播放器 > 页面。音视频预览打开时（含最小化），即使焦点不在播放器里也响应播放快捷键；
  // 焦点在播放器里时由 Modal 的 onKeyDownCapture 正常处理，这里只接手播放器之外（页面、空白处）的按键。
  const shortcutRef = useRef(handleShortcut);
  shortcutRef.current = handleShortcut;
  useEffect(() => {
    if (!media) return;
    const listener = (event: globalThis.KeyboardEvent) => {
      const modal = stage.current?.closest<HTMLElement>(".modal");
      const target = event.target instanceof Element ? event.target : null;
      if (!modal || !target || modal.contains(target) || event.defaultPrevented || event.isComposing) return;
      if (isShortcutControl(target) || document.querySelector(".assistant-drawer.is-open, .assistant-page, .menu")) return;
      const minimized = modal.classList.contains("is-minimized");
      // 只交给一个播放器：展开的窗口优先，其次是最近最小化的音视频小窗；其他对话框打开时不接手。
      const others = [...document.querySelectorAll<HTMLElement>(".modal-backdrop:not(.is-minimized)")].filter(node => !node.contains(modal));
      if (others.length) return;
      if (minimized && (document.querySelector(".modal.has-media-surface:not(.is-minimized)") || latestMinimized(".has-media-surface") !== modal)) return;
      // 最小化时页面仍在使用：只接手播放控制（空格／K、J／L、方向键），其余按键仍归页面。
      const key = event.key.toLowerCase();
      if (minimized && !["k", " ", "j", "l", "arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) return;
      // 用 Tab 移到按钮或链接上时，空格／回车仍激活它。
      if ((key === " " || key === "enter") && target.closest("button, a, summary, [role='button']") && document.documentElement.dataset.input === "keyboard") return;
      shortcutRef.current({
        key: event.key, repeat: event.repeat, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
        defaultPrevented: false, nativeEvent: event, target: modal, currentTarget: modal,
        preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(),
      } as unknown as KeyboardEvent<HTMLDivElement>);
    };
    // 捕获阶段：先于页面在 document 上的快捷键，接手后页面看到 defaultPrevented 即让行。
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [media]);
  function handleShortcut(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const key = event.key.toLowerCase(), navigation = key === "arrowleft" || key === "arrowright";
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target) || event.currentTarget.closest("[inert]")) return;
    if (navigation && media && !event.shiftKey && target.closest("[data-media-progress]")) { pressArrow(event, key); return; }
    if (isShortcutControl(target)) return;
    if (key === "?") { event.preventDefault(); event.stopPropagation(); event.currentTarget.classList.remove("is-chrome-idle"); if (!event.repeat) void showShortcuts(); return; }
    // 播放快捷键（M、C、G／H、0–9、Shift+< >、视频的 , .）见 preview-keys.ts。
    if (media && controls.current && (kind === "audio" || kind === "video")) {
      const handled = playerShortcut(event, kind, controls.current);
      if (handled) {
        event.preventDefault(); event.stopPropagation();
        if (handled.feedback) toast.status(handled.feedback.status, handled.feedback.message);
        return;
      }
    }
    if (event.shiftKey) return;
    if (key === "d" || key === "s" && onShare || key === "o" && media && playlist.items.length > 1) {
      event.preventDefault(); event.stopPropagation();
      event.currentTarget.classList.remove("is-chrome-idle");
      if (!event.repeat) {
        if (key === "d") { if (downloadHref) downloadFile(downloadHref); }
        else if (key === "s") void share();
        else setPlaylistExpanded(value => !value);
      }
      return;
    }
    if (key === "r" && kind === "video" && media) {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) rotateVideo(rotation + 90);
      return;
    }
    if (!browsable || !navigation && (!media || !["k", " ", "j", "l", "arrowup", "arrowdown"].includes(key))) return;
    // 空格继续激活当前按钮，不能同时切换播放状态。
    if (key === " " && target.closest("button, a, summary, [role='button']")) return;
    event.preventDefault(); event.stopPropagation();
    if (navigation && media) pressArrow(event, key);
    else if (navigation) {
      if (event.repeat || playlist.items.length < 2) return;
      const next = key === "arrowleft" ? playlist.previous() : playlist.next();
      if (next) select(next);
    } else if (key === "k" || key === " ") {
      if (!event.repeat) togglePlayback();
    } else if (key === "j" || key === "l") controls.current?.seekBy(key === "j" ? -10 : 10);
    else controls.current?.adjustVolume(key === "arrowup" ? 0.05 : -0.05);
  }
  const extension = active.key.match(/\.([a-z\d]{1,10})$/i)?.[1].toUpperCase();
  const typeLabel = extension && kind !== "pdf" && kind !== "folder" ? `${extension === "JPG" ? "JPEG" : extension} ${kindLabel(kind)}` : kindLabel(kind);
  // Markdown 里的相对路径图片按文件所在目录解析为云盘内的文件；解析函数保持稳定，避免重复渲染整篇文档。
  const assetRef = useRef(assetUrl);
  assetRef.current = assetUrl;
  const hasAssets = Boolean(assetUrl);
  const stage = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = stage.current, modal = node?.closest<HTMLElement>(".modal"), backdrop = modal?.parentElement;
    const header = modal?.querySelector<HTMLElement>(".modal-header");
    if (!node || !modal || !backdrop || !header) return;
    // 按实际头部高度计算画布，避免窄屏换行挤出内容及百分比高度循环；导航都在播放器内部，不再有单独的工具栏。
    // 沉浸式预览的头部浮在画布上（不占高度），播放器用 --preview-header-height 给顶部内容留出位置。
    const resize = () => {
      if (modal.classList.contains("is-minimized")) return;
      setCompactActions(header.clientWidth <= 580 || window.matchMedia("(hover: none) and (pointer: coarse)").matches);
      if (!immersive) return;
      const outer = getComputedStyle(backdrop), frame = getComputedStyle(modal);
      let available = backdrop.clientHeight - parseFloat(outer.paddingTop) - parseFloat(outer.paddingBottom);
      if (frame.maxHeight.endsWith("px")) available = Math.min(available, parseFloat(frame.maxHeight));
      modal.style.setProperty("--preview-available-height", `${available}px`);
      const overlay = getComputedStyle(header).position === "absolute";
      node.style.setProperty("--preview-header-height", `${header.offsetHeight}px`);
      // 入场动画带缩放变换，布局高度不受动画影响，避免误算可用画布。
      // 手动尺寸与扩展窗口以实际高度为准；视频默认窗口也有按比例计算的明确高度。
      const fixed = kind === "video" || modal.classList.contains("is-sized") || modal.classList.contains("is-expanded");
      const height = fixed ? modal.clientHeight : available - parseFloat(frame.borderTopWidth) - parseFloat(frame.borderBottomWidth);
      const content = Math.max(0, height - (overlay ? 0 : header.offsetHeight));
      node.style.setProperty("--preview-content-height", `${content}px`);
      node.style.setProperty("--preview-player-height", `${content}px`);
    };
    const observer = new ResizeObserver(resize);
    // 也观察窗口本身：用户拖动调整大小后按新的最大高度重新计算画布。
    for (const element of [header, backdrop, modal]) observer.observe(element);
    window.addEventListener("resize", resize); resize();
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, [immersive, kind, playlistExpanded]);
  async function share() {
    // 分享弹窗 portal 到 body；先退出预览全屏，确保它不会被全屏层遮住。
    const screen = document.fullscreenElement;
    if (screen && stage.current?.closest(".modal-backdrop")?.contains(screen)) {
      try { await document.exitFullscreen(); } catch { toast.error("请先退出全屏，再打开分享设置。"); return; }
    }
    onShare?.(active);
  }
  async function showShortcuts() {
    const screen = document.fullscreenElement;
    if (screen && stage.current?.closest(".modal-backdrop")?.contains(screen)) {
      try { await document.exitFullscreen(); } catch { toast.error("请先退出全屏，再查看快捷键。"); return; }
    }
    setShortcutsOpen(true);
  }
  const resolveImage = useMemo(() => hasAssets ? (src: string) => {
    const key = resolveRelativeKey(parentPath(active.key), src);
    return key && assetRef.current ? assetRef.current(key) : null;
  } : undefined, [active.key, hasAssets]);
  // 上一个／下一个、播放模式和列表开关都在播放器或图片查看器内部；图片用底部缩略图条代替侧边列表。
  const index = Math.max(0, playlist.items.findIndex(item => item.key === active.key));
  const nav: PreviewNav | undefined = browsable ? {
    index, count: playlist.items.length,
    onPrevious: () => select(playlist.previous()), onNext: () => { const next = playlist.next(); if (next) select(next); },
    ...(media ? { mode: playlist.mode, onMode: playlist.changeMode, playlistOpen: playlistExpanded, onPlaylist: () => setPlaylistExpanded(value => !value) } : {}),
  } : undefined;
  const strip: PreviewStrip | undefined = kind === "image" ? { items: playlist.items, current: active.key, onSelect: select, thumbnail: item => sourceOf(item).thumbnail } : undefined;
  const panelOpen = media && playlistExpanded;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  // 视频、图片与文本：鼠标静止一会儿后隐藏浮在画面上的头部，移动、滚动、按键或悬停头部时恢复；暂停的视频始终显示。
  // 文本在选中文字、打开查找或目录时保持头部可见。
  useEffect(() => {
    const modal = stage.current?.closest<HTMLElement>(".modal");
    if (!modal || (kind !== "video" && kind !== "image" && !reading)) return;
    let timer = 0;
    const header = modal.querySelector<HTMLElement>(".modal-header");
    const wake = () => {
      modal.classList.remove("is-chrome-idle");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (modal.hasAttribute("inert") || modal.classList.contains("is-minimized") || header?.matches(":hover, :focus-within") || header?.querySelector('[aria-expanded="true"]') || modal.querySelector(".preview-playlist-panel")) return;
        if (kind === "video" && !playingRef.current) return;
        if (reading && (modal.querySelector(".cm-panels, .preview-outline-panel") || !window.getSelection()?.isCollapsed && modal.contains(window.getSelection()?.anchorNode ?? null))) return;
        modal.classList.add("is-chrome-idle");
      }, 2600);
    };
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const name of events) modal.addEventListener(name, wake, { passive: true });
    // 触屏滚动阅读时没有 pointermove：滚动只延后隐藏，不立刻唤出头部，避免遮挡正在读的内容。
    const scroll = () => { window.clearTimeout(timer); if (!modal.classList.contains("is-chrome-idle")) wake(); };
    modal.addEventListener("scroll", scroll, { capture: true, passive: true });
    wake();
    return () => { window.clearTimeout(timer); modal.classList.remove("is-chrome-idle"); for (const name of events) modal.removeEventListener(name, wake); modal.removeEventListener("scroll", scroll, { capture: true }); };
  }, [kind, reading]);
  useEffect(() => { if (!playing) stage.current?.closest(".modal")?.classList.remove("is-chrome-idle"); }, [playing]);
  // 播放列表是浮在右侧的抽屉：点击抽屉外的画面即收起（列表按钮自己负责开关）。
  useEffect(() => {
    const node = stage.current;
    if (!panelOpen || !node) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || target.closest(".preview-playlist-panel, .playlist-toggle, .art-control-playlist")) return;
      setPlaylistExpanded(false);
    };
    node.addEventListener("pointerdown", outside);
    return () => node.removeEventListener("pointerdown", outside);
  }, [panelOpen]);
  // 窄窗口仅保留阅读工具、更多与关闭，其他操作合并到同一个菜单。
  return (
    <><Modal size="xl" initialFocus="dialog" onKeyDownCapture={handleShortcut} windowShortcuts expandable pinnable minimizable movable minimizeRequest={minimizeRequest} compactActions={compactActions}
      menuItems={[
        { label: "键盘快捷键", icon: "keyboard", shortcut: "?", onSelect: () => void showShortcuts() },
        ...(compactActions ? [
        ...textMenuItems,
        ...(onShare ? [{ label: active.public_token ? "管理分享" : "公开分享", icon: "link" as const, shortcut: "S", onSelect: () => void share() }] : []),
        ...(onEditImage && ownSource && kind === "image" && !/\.svg$/i.test(active.key) ? [{ label: "编辑图片", icon: "crop" as const, onSelect: () => onEditImage(active) }] : []),
        ...(ownSource ? cacheMenuItems(cacheQueue, active).filter(item => !item.danger) : []),
        // 下载地址为空（分享者没有允许下载的歌单分享）时不提供下载。
        ...(downloadHref ? [{ label: "下载文件", icon: "download" as const, shortcut: "D", href: downloadHref, onSelect: () => {} }] : []),
        ] : []),
      ]}
      resizable={kind === "audio" ? undefined : `preview-${kind === "code" ? "text" : kind}`} aspectRatio={kind === "video" ? videoRatio : undefined} windowKey={file.key} minimizedContent={media ? <MinimizedPlayback progress={progress} state={mediaState} playing={playing} lyric={kind === "audio" && lyric.key === active.key ? lyric.line : null} speed={bufferSpeed} onSeek={time => controls.current?.seek(time)} onToggle={togglePlayback} nav={nav} />
      : kind === "image" && nav && nav.count > 1 ? <div className="preview-mini-gallery">
        <IconButton icon="previous" label="上一张" size="sm" onClick={nav.onPrevious} />
        <span>{nav.index + 1} / {nav.count}</span>
        <IconButton icon="next" label="下一张" size="sm" onClick={nav.onNext} />
      </div> : undefined} className={`preview-modal preview-modal-${kind}${immersive ? " is-immersive" : ""}${immersive ? " is-dark-surface" : ""}${reading ? " is-reading" : ""}${api.isPrivatePath(active.key) ? " is-private" : ""}${panelOpen ? " has-playlist-open" : ""}${media ? " has-media-surface" : ""}${media && source.poster ? " has-cover" : ""}`} style={{ ...(kind === "video" ? { "--preview-video-ratio": videoRatio } : {}), ...mediaSurface } as CSSProperties} leading={<FileVisual kind={kind} src={source.thumbnail} size="lg" />} title={baseName(active.key)} onClose={closePreview}
      description={<span className="preview-meta">
        <span title={active.content_type ?? undefined}>{typeLabel}</span><span>{formatBytes(active.size)}</span>
        {(kind === "image" || kind === "video") && knownSize && <span className="preview-meta-dimensions" title="分辨率">{api.formatDimensions(knownSize)}</span>}
        <span className="preview-meta-date" title={`修改于 ${formatDateTime(active.modified_at)}`}>{formatDate(active.modified_at)}</span>
        {active.public_token && <span className="preview-meta-public" title="已公开分享"><Icon name="globe" size={12} />公开</span>}
      </span>}
      actions={<>
        {reading && <span className="preview-header-tools" ref={setTextTools} />}
        {!compactActions && <>
          {onEditImage && ownSource && kind === "image" && !/\.svg$/i.test(active.key) && <IconButton icon="crop" label="编辑图片" size="sm" onClick={() => onEditImage(active)} />}
          {onShare && <IconButton icon="link" label={active.public_token ? "管理分享" : "公开分享"} shortcut="S" size="sm" onClick={() => void share()} />}
          {ownSource && <FileCacheButton file={active} />}
          {downloadHref && <a className="icon-btn icon-btn-ghost icon-btn-sm" href={downloadHref} aria-label="下载文件" aria-keyshortcuts="D" title="下载文件（D）"><Icon name="download" size={16} /></a>}
          <span className="modal-actions-divider" aria-hidden="true" />
        </>}
      </>}>
      <div ref={stage} className={`preview-stage${browsable ? " has-playlist is-media" : ""}${reading ? " is-reading" : ""}${panelOpen ? " is-playlist-open" : ""}${fullyCached ? " is-cached" : ""}`}><PreviewToolsContext.Provider value={readingTools}><PreviewCachedContext.Provider value={fullyCached}><FilePreview text={textEditing} kind={kind} size={active.size} videoSize={knownSize ?? undefined} url={ownSource || kind === "image" || kind === "video" || kind === "audio" ? api.versionedContentUrl(source.url, active.etag, active.size, canPreview(kind, active.key, active.content_type)) : source.url}
        positionKey={active.etag || null} rememberPosition={!api.isPrivatePath(active.key)} archive={format === "archive" && ownSource ? { file: active, onExtract: onExtract ? picks => onExtract(active, picks) : undefined } : undefined} name={baseName(active.key)} downloadUrl={downloadHref} contentType={active.content_type} poster={imagePoster} posterMaxEdge={imagePosterMaxEdge} onImageLoad={image => onImageLoad?.(image, active)} onImageSize={(width, height, original) => { if (original) recordSize(width, height); }} onVideoFrame={video => onVideoFrame?.(video, active)} onBufferSpeed={setBufferSpeed} onSaveThumbnail={onSaveVideoThumbnail ? (video, degrees) => onSaveVideoThumbnail(video, active, degrees) : undefined} rotation={rotation} onRotate={rotateVideo} resolveImage={resolveImage} assetUrl={assetUrl}
        onPlaying={setPlaying} onEnded={() => { const next = playlist.next(true); if (next) select(next); }}
        onVideoSize={(width, height, from) => { if (from === "video") recordSize(width, height); setVideoSize(current => current?.key === active.key && current.etag === active.etag && current.ratio === width / height ? current : { key: active.key, etag: active.etag, ratio: width / height }); }}
        onProgress={value => { trackPrefetch(value); setProgress(current => current.currentTime === value.currentTime && current.duration === value.duration ? current : value); }} onState={setMediaState}
        onLyricLine={line => setLyric(current => current.key === active.key && current.line === line ? current : { key: active.key, line })}
        onControls={instance => { controls.current = instance; if (instance && pendingPlay.current) { pendingPlay.current = false; play(); } }}
        loadAssets={loadAssets ? signal => loadAssets(active, signal) : assetUrl ? signal => ownSource ? api.mediaAssets(active, signal) : api.previewAssets(active.key, signal) : undefined}
        onFindAssets={findable ? want => onFindMedia?.(active, want) : undefined} assetRevision={assetChange.revision} preferAsset={assetChange.prefer} nav={nav} strip={strip}
        upcoming={kind === "audio" ? upcomingUrl : null} session={media ? { title: baseName(active.key).replace(/\.[^.]+$/, ""), artwork: source.poster } : undefined} /></PreviewCachedContext.Provider></PreviewToolsContext.Provider>
        {panelOpen && <PlaylistPanel playlist={playlist} onSelect={select} typeLabel={kindLabel(kind)} playing={playing}
          onCollapse={() => setPlaylistExpanded(false)}
          renderThumbnail={item => {
            const itemKind = getFileKind(item.content_type, item.key), thumb = sourceOf(item).thumbnail;
            // 没有封面的音乐用按文件名固定的色调块，与播放器唱片标签一致，比通用文件图标更容易区分曲目。
            return itemKind === "audio" && !thumb ? <span className="tint-cover" style={{ "--cover-tint": coverTint(baseName(item.key)) } as CSSProperties}><Icon name="audio" size={16} /></span>
              : <FileVisual kind={itemKind} src={thumb} size="md" />;
          }} />}
      </div>
    </Modal>
    {shortcutsOpen && <ShortcutsDialog area="preview" kind={kind} privateSpace={api.isPrivatePath(active.key)} onClose={() => setShortcutsOpen(false)} />}</>
  );
}

/** 公开分享：开关即时生效，开启后可设置有效期与访问密码，并查看下载次数。 */
export function ShareDialog({ file, publicBase, onClose, onChange, update }: {
  file: api.FileItem; publicBase?: string | null; onClose: () => void; onChange: (file: api.FileItem) => void;
  update: (isPublic: boolean, options?: api.ShareOptions) => Promise<api.FileItem>;
}) {
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [editingPassword, setEditingPassword] = useState(false);
  const [error, setError] = useState("");
  const isPublic = Boolean(file.public_token);
  const folder = file.key.endsWith("/");
  const name = baseName(file.key);
  const links = file.public_token ? api.publicLinks(file.public_token, name, publicBase) : null;
  async function apply(next: boolean, options?: api.ShareOptions, message?: string) {
    if (busy) return false;
    setBusy(true); setError("");
    try {
      const updated = await update(next, options);
      onChange(updated);
      toast.success(message ?? (next ? "已开启公开访问" : "已关闭公开访问，原链接立即失效"));
      return true;
    } catch (reason) { setError(api.errorMessage(reason, "更新分享设置失败，请稍后重试")); return false; }
    finally { setBusy(false); }
  }
  const expiry = file.public_expires_at ? "custom" : "never";
  const setExpiry = (days: number | null) => void apply(true, { expires_at: days === null ? null : Date.now() / 1000 + days * 86400 },
    days === null ? "链接已设为永久有效" : `链接将在 ${days} 天后失效`);
  async function savePassword() {
    if (password.length < 4) { setError("访问密码至少 4 个字符"); return; }
    if (await apply(true, { password }, "已设置访问密码，旧的验证凭证已失效")) { setPassword(""); setEditingPassword(false); }
  }
  return (
    <Modal title={folder ? "分享文件夹" : "分享文件"} description={name} icon="link" onClose={onClose} dismissible={!busy}
      footer={<>{links && <ButtonLink variant="ghost" size="md" icon="external" href={links.page} target="_blank" rel="noreferrer">打开分享页</ButtonLink>}<Button disabled={busy} onClick={onClose}>完成</Button></>}>
      <div className={`share-status${isPublic ? " is-public" : ""}`}>
        <Switch checked={isPublic} disabled={busy} onChange={value => void apply(value)} label={isPublic ? "任何拥有链接的人都可以访问" : "仅自己可见"}
          description={isPublic
            ? (file.public_has_password ? `访问者需要输入密码才能查看和下载${folder ? "里面的文件" : ""}。` : folder ? "访问者可浏览、预览和下载全部内容，包括子文件夹。" : "访问者无需登录即可预览和下载。")
            : "开启公开访问后生成分享链接，可随时关闭。"} />
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <p className="share-save-status" role="status">{busy ? "正在保存设置…" : "更改自动保存"}</p>
      {links && <>
        <Field label="分享链接" hint={folder ? "文件夹内容更新后，分享页会同步展示。" : "发送此链接，对方可预览和下载文件。"}>
          <CopyField value={links.page} label="分享页链接" copyMessage="分享链接已复制" primary />
        </Field>
        <details className="settings-disclosure">
          <summary><span>访问设置</span><span className="disclosure-meta">{file.public_has_password ? "有密码" : "无密码"} · {file.public_expires_at ? "限时有效" : "永久有效"}</span><Icon name="chevronDown" size={16} /></summary>
          <div className="disclosure-body form">
            <Field label="有效期" hint={file.public_expires_at ? `将于 ${formatDateTime(file.public_expires_at)} 失效。再次选择天数会从现在重新计算。` : "链接一直有效，直到你关闭分享。"}>
              <select className="input" value={expiry} disabled={busy} onChange={event => setExpiry(event.target.value === "never" ? null : Number(event.target.value))}>
                {file.public_expires_at && <option value="custom" disabled>当前：{formatDateTime(file.public_expires_at)} 失效</option>}
                <option value="never">永久有效</option><option value="1">从现在起 1 天</option><option value="7">从现在起 7 天</option><option value="30">从现在起 30 天</option>
              </select>
            </Field>
            <Field label="访问密码" htmlFor="share-password" hint="至少 4 个字符。修改密码后，访问者需重新验证。">
              {file.public_has_password && !editingPassword ? <div className="share-password-set">
                <Badge tone="accent" icon="lock">已设置</Badge>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditingPassword(true)}>修改</Button>
                <Button size="sm" variant="ghost-danger" disabled={busy} onClick={() => void apply(true, { password: null }, "已取消访问密码")}>取消密码</Button>
              </div> : <form className="share-password-form" noValidate onSubmit={event => { event.preventDefault(); void savePassword(); }}>
                <input id="share-password" className="input" type="text" autoComplete="off" placeholder="不设置则无需密码" value={password} disabled={busy} onChange={event => { setPassword(event.target.value); setError(""); }} />
                <Button size="sm" type="submit" disabled={busy || !password}>设置密码</Button>
                {editingPassword && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditingPassword(false); setPassword(""); }}>取消</Button>}
              </form>}
            </Field>
          </div>
        </details>
        <details className="settings-disclosure">
          <summary><span>{folder ? "分享详情" : "直链与分享详情"}</span><Icon name="chevronDown" size={16} /></summary>
          <div className="disclosure-body form">
            {!folder && <Field label="文件直链" hint={file.public_has_password ? "需要先在分享页输入密码，直链才能使用。" : "适合嵌入网页或用于下载工具。"}><CopyField value={links.direct} label="文件直链" copyMessage="直链已复制" /></Field>}
            <KeyValue items={[["开启时间", formatDateTime(file.public_at)], ["下载次数", `${file.public_downloads ?? 0} 次`], [folder ? "移动或重命名" : "覆盖、移动或重命名", "链接与设置保持不变"]]} />
          </div>
        </details>
      </>}
    </Modal>
  );
}

