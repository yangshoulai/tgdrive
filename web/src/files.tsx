/** 文件类型识别、预览与公开分享对话框。 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as api from "./api";
import { readPreviewText, type PreviewText } from "./preview-data";
import { MediaPreview, MinimizedPlayback, type AssetLoader, type MediaProgress, type MediaState, type PlaybackControls, type PlaybackProps } from "./preview-media";
import { PlaylistPanel, usePreviewPlaylist, type PreviewNav, type PreviewStrip } from "./preview-playlist";
import { ImageViewer } from "./preview-image";
import { TextPreview } from "./preview-text";
import { Badge, Button, CopyField, Field, FilterChips, Icon, IconButton, KeyValue, Modal, Switch, formatBytes, formatDate, formatDateTime, isShortcutControl, toast, type IconName } from "./ui";

export type FileKind = "folder" | "image" | "video" | "audio" | "pdf" | "document" | "spreadsheet" | "presentation" | "text" | "code" | "archive" | "other";

export type EntryFilter = "all" | "folder" | "file";
const ENTRY_FILTERS: { value: EntryFilter; label: string }[] = [
  { value: "all", label: "全部" }, { value: "folder", label: "文件夹" }, { value: "file", label: "文件" },
];

const TYPE_FILTERS = api.KIND_FILTERS.filter(option => option.value);

/** 一行筛选：先选项目（全部／文件夹／文件），分隔线后是文件类型；选类型即切到「文件」，再次点击取消，选文件夹会清除类型。 */
export function FileFilters({ entry, kind, onEntryChange, onKindChange }: {
  entry: EntryFilter; kind: api.KindFilter; onEntryChange: (value: EntryFilter) => void; onKindChange: (value: api.KindFilter) => void;
}) {
  return <div className="file-filters">
    <FilterChips label="项目" value={entry} options={ENTRY_FILTERS} onChange={value => {
      onEntryChange(value); if (value !== "file") onKindChange("");
    }} />
    <span className="file-filters-divider" aria-hidden="true" />
    <FilterChips label="文件类型" value={kind} options={TYPE_FILTERS} clearValue="" onChange={value => {
      onKindChange(value); if (value) onEntryChange("file");
    }} />
  </div>;
}

export function matchesKindFilter(file: { content_type?: string | null; key: string }, filter: api.KindFilter): boolean {
  if (!filter) return true;
  const kind = getFileKind(file.content_type, file.key);
  if (filter === "document") return ["pdf", "document", "spreadsheet", "presentation"].includes(kind);
  if (filter === "text") return kind === "text" || kind === "code";
  return kind === filter;
}

export function getFileKind(type: string | null | undefined, name: string): FileKind {
  const lower = name.toLowerCase();
  const mime = (type || "").split(";", 1)[0].trim().toLowerCase();
  if (lower.endsWith("/")) return "folder";
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|heic)$/.test(lower)) return "image";
  if (mime === "video/mp2t" || /\.(mts|m2ts)$/.test(lower)) return "other";
  if (mime.startsWith("video/") || /\.(mp4|webm|mov|mkv|avi|m4v|ogv)$/.test(lower)) return "video";
  if (mime.startsWith("audio/") || /\.(mp3|wav|ogg|oga|opus|flac|m4a|aac)$/.test(lower)) return "audio";
  if (mime === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (/\.(docx?|dotx?|odt|rtf|pages|wps)$/.test(lower) || /wordprocessingml|msword|opendocument\.text/.test(mime)) return "document";
  if (/\.(xlsx?|xlsm|xltx?|ods|numbers|et)$/.test(lower) || /spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(mime)) return "spreadsheet";
  if (/\.(pptx?|potx?|odp|key|dps)$/.test(lower) || /presentationml|ms-powerpoint|opendocument\.presentation/.test(mime)) return "presentation";
  if (/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|c|cc|cpp|cxx|h|hpp|cs|sh|bash|zsh|ps1|bat|html?|css|scss|sass|less|vue|svelte|sql|rb|php|swift|kt|kts|scala|dart|gradle|lua|diff|patch)$/.test(lower) || /(^|\/)(dockerfile|makefile)$/.test(lower)) return "code";
  if (mime.startsWith("text/") || mime === "application/json" || /\.(md|markdown|mdx|rst|txt|json|jsonc|csv|tsv|log|xml|ya?ml|toml|ini|conf|cfg|properties|env|gitignore|editorconfig|lrc|srt|vtt)$/.test(lower) || /(^|\/)\.env(\.[\w.-]+)?$/.test(lower)) return "text";
  if (/\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|dmg|iso)$/.test(lower) || /zip|compressed|x-tar/.test(mime)) return "archive";
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
export function FileVisual({ kind, src, size = "md" }: { kind: FileKind; src?: string; size?: "md" | "lg" | "xl" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <FileTile kind={kind} size={size} />;
  return <span className={`file-tile file-visual tile-${size}`} aria-hidden="true"><img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /></span>;
}

export function FileThumbnail({ kind, url }: { kind: FileKind; url?: string }) {
  // 按资源地址重建状态，避免缓存图片的 load 事件被挂载后的 effect 重置。
  return <ThumbnailImage key={url} kind={kind} url={url} />;
}

/** 文件夹只展示已有的小缩略图；空目录或尚未生成缩略图时保留文件夹图标。 */
export function FolderThumbnail({ previews = [] }: { previews?: { key: string; content_type: string | null; url: string }[] }) {
  if (!previews.length) return <FileThumbnail kind="folder" />;
  return <div className="folder-thumbnail" role="img" aria-label="文件夹内容预览">
    <div className="folder-preview-grid" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => {
      const file = previews[index];
      return <span key={file?.key ?? index} className={`folder-preview-cell${file ? "" : " is-empty"}`}>
        {file && <FileVisual kind={getFileKind(file.content_type, file.key)} src={file.url} size="xl" />}
      </span>;
    })}</div><span className="folder-preview-badge" aria-hidden="true"><FileGlyph kind="folder" size={20} /></span>
  </div>;
}

function ThumbnailImage({ kind, url }: { kind: FileKind; url?: string }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  return <div className={`file-thumbnail thumbnail-${state}`}>
    {(!url || state !== "ready") && <FileTile kind={kind} size="xl" />}
    {url && state !== "failed" && <img src={url} alt="" loading="lazy" onLoad={() => setState("ready")} onError={() => setState("failed")} />}
    {url && state === "ready" && (kind === "video" || kind === "audio") && <span className="thumbnail-badge" aria-hidden="true"><Icon name={kind === "video" ? "play" : "audio"} size={12} /></span>}
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
export function canPreview(kind: FileKind) { return PREVIEWABLE.includes(kind); }

/** 内容区：分享页与预览弹窗共用同一套渲染逻辑。 */
const TEXT_PREVIEW_LIMIT = 512 * 1024;

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
type PreviewProps = { kind: FileKind; url: string; name: string; downloadUrl: string; contentType?: string | null; poster?: string; onImageLoad?: (image: HTMLImageElement) => void; onImageSize?: (width: number, height: number, original: boolean) => void; resolveImage?: (src: string) => string | null; loadAssets?: AssetLoader; assetUrl?: (path: string) => string; nav?: PreviewNav; strip?: PreviewStrip } & PlaybackProps;
export function FilePreview(props: PreviewProps) {
  const [attempt, setAttempt] = useState(0);
  // 音视频与图片切换时复用同一个播放器／查看器（图片的缩略图条才能从上一张平滑滚动到下一张），其他类型按地址重建。
  return <PreviewContent key={`${props.kind}:${props.kind === "audio" || props.kind === "video" || props.kind === "image" ? "media" : props.url}:${attempt}`} {...props} onRetry={() => setAttempt(current => current + 1)} />;
}

function PreviewLoading({ onRetry }: { onRetry: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setSlow(true), 8000); return () => window.clearTimeout(timer); }, []);
  return <div className="preview-loading" role="status"><span className="spinner spinner-lg" /><span>{slow ? "加载时间较长" : "正在加载预览…"}</span>
    {slow && <Button size="sm" variant="ghost" icon="refresh" onClick={onRetry}>重试</Button>}
  </div>;
}

function PreviewContent({ kind, url, name, downloadUrl, contentType, poster, onImageLoad, onImageSize, resolveImage, loadAssets, assetUrl, nav, strip, onRetry, onEnded, onPlaying, onProgress, onState, onControls, onVideoSize, onLyricLine }: PreviewProps & { onRetry: () => void }) {
  const [content, setContent] = useState<PreviewText | null>(null);
  const [error, setError] = useState("");
  const [mediaFailed, setMediaFailed] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  // 图片复用组件，切换到下一张时清除上一张的失败状态。
  useEffect(() => { if (kind === "image") setMediaFailed(false); }, [url, kind]);
  useEffect(() => {
    if (kind !== "text" && kind !== "code") return;
    setContent(null); setError("");
    const controller = new AbortController();
    // 文本预览只读取前 512 KB，避免大日志拖垮页面。
    void readPreviewText(url, TEXT_PREVIEW_LIMIT, controller.signal)
      .then(value => { if (!controller.signal.aborted) setContent(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(api.errorMessage(reason, "无法读取文件")); });
    return () => controller.abort();
  }, [url, kind]);
  const failed = Boolean(mediaFailed || error);
  const extension = name.match(/\.([a-z\d]{1,8})$/i)?.[1].toUpperCase();
  const unplayable = (kind === "video" || kind === "audio") && !isPlayable(name, contentType);
  const fallback = (
    <div className="preview-fallback">
      <FileTile kind={kind} size="xl" />
      <h3>{failed ? "预览加载失败" : unplayable ? `浏览器无法播放${extension ? ` ${extension} ` : "此"}格式` : "此类型不支持在线预览"}</h3>
      <p>{error || (failed ? "文件未能加载或当前浏览器不支持此格式。" : unplayable ? "请下载后用本地播放器打开。" : "下载后使用本地应用打开。")}</p>
      <div className="preview-recovery">{failed ? <Button size="sm" icon="refresh" onClick={onRetry}>重试</Button>
        : <a className="btn btn-primary btn-sm" href={downloadUrl}><Icon name="download" size={15} /><span>下载文件</span></a>}</div>
    </div>
  );
  if (unplayable) return fallback;
  if (kind === "video" || kind === "audio") return <MediaPreview kind={kind} url={url} name={name} cover={poster} onRetry={onRetry} loadAssets={loadAssets} assetUrl={assetUrl} nav={nav} onEnded={onEnded} onPlaying={onPlaying} onProgress={onProgress} onState={onState} onControls={onControls} onVideoSize={onVideoSize} onLyricLine={onLyricLine} />;
  if (mediaFailed) return fallback;
  // 原图从存储取回并解密需要时间：查看器先显示封面图占位，原图加载完成后淡入替换。
  if (kind === "image") return <ImageViewer url={url} name={name} poster={poster} nav={nav} strip={strip} onError={() => setMediaFailed(true)} onLoad={onImageLoad} onImageSize={onImageSize} />;
  if (kind === "pdf") return <div className={`preview-resource${mediaReady ? " is-ready" : ""}`} aria-busy={!mediaReady}>
    {!mediaReady && <div className="preview-media-loader"><PreviewLoading onRetry={onRetry} /></div>}
    {kind === "pdf" && <iframe className="preview-frame" src={url} title={name} onLoad={() => setMediaReady(true)} onError={() => setMediaFailed(true)} />}
  </div>;
  if (kind === "text" || kind === "code") {
    if (error) return fallback;
    if (content === null) return <PreviewLoading onRetry={onRetry} />;
    return <TextPreview content={content} name={name} downloadUrl={downloadUrl} resolveImage={resolveImage} onError={reason => setError(api.errorMessage(reason, "文本组件加载失败"))} />;
  }
  return fallback;
}

type PreviewSource = { url: string; downloadUrl: string; poster?: string; thumbnail?: string };
export type PreviewPlayback = { playing: boolean; currentTime: number; state: MediaState };
export function PreviewModal({ file, url, downloadUrl, poster, thumbnail, onClose, onShare, onImageLoad, assetUrl, loadAssets, playlistFiles, sourceFor, onPlaybackActivity }: PreviewSource & { file: api.FileItem; onClose: () => void; onShare?: (file: api.FileItem) => void; onImageLoad?: (image: HTMLImageElement, file: api.FileItem) => void; assetUrl?: (key: string) => string; loadAssets?: (file: api.FileItem, signal: AbortSignal) => Promise<api.PreviewAsset[]>; playlistFiles?: api.FileItem[]; sourceFor?: (file: api.FileItem) => PreviewSource; onPlaybackActivity?: (state: PreviewPlayback) => void }) {
  const kind = getFileKind(file.content_type, file.key);
  const media = (kind === "audio" || kind === "video") && isPlayable(file.key, file.content_type);
  const browsable = media || kind === "image";
  const playlist = usePreviewPlaylist(file, kind, playlistFiles,
    item => getFileKind(item.content_type, item.key) === kind && (kind === "image" || isPlayable(item.key, item.content_type)) && parentPath(item.key) === parentPath(file.key));
  const active = browsable && playlist.current.key !== file.key ? playlist.current : file;
  const sourceOf = (item: api.FileItem): PreviewSource => item.key === file.key ? { url, downloadUrl, poster, thumbnail } : sourceFor?.(item) ?? {
    url: api.contentUrl(item.key), downloadUrl: api.contentUrl(item.key, true), poster: api.fileThumbnail(item, "poster"), thumbnail: api.fileThumbnail(item),
  };
  const source = sourceOf(active);
  const [playlistExpanded, setPlaylistExpanded] = useState(false);
  const controls = useRef<PlaybackControls | null>(null), pendingPlay = useRef(false), currentKey = useRef(active.key);
  currentKey.current = active.key;
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState<MediaProgress>({ currentTime: 0, duration: 0 });
  const [mediaState, setMediaState] = useState<MediaState>("loading");
  const [lyric, setLyric] = useState<{ key: string; line: string | null }>({ key: active.key, line: null });
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
  useEffect(() => { pendingPlay.current = false; }, [file.key]);
  function handleShortcut(event: KeyboardEvent<HTMLDivElement>) {
    if (!browsable || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    const key = event.key.toLowerCase(), navigation = key === "arrowleft" || key === "arrowright";
    if (!navigation && (!media || !["k", " ", "j", "l", "arrowup", "arrowdown"].includes(key))) return;
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target) || event.currentTarget.closest("[inert]")) return;
    if (isShortcutControl(target)) return;
    // 空格继续激活当前按钮，不能同时切换播放状态。
    if (key === " " && target.closest("button, a, summary, [role='button']")) return;
    event.preventDefault(); event.stopPropagation();
    if (navigation) {
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
    if (!browsable || !node || !modal || !backdrop || !header) return;
    // 按实际头部高度计算画布，避免窄屏换行挤出内容及百分比高度循环；导航都在播放器内部，不再有单独的工具栏。
    // 沉浸式预览的头部浮在画布上（不占高度），播放器用 --preview-header-height 给顶部内容留出位置。
    const resize = () => {
      if (modal.classList.contains("is-minimized")) return;
      const outer = getComputedStyle(backdrop), frame = getComputedStyle(modal);
      let height = backdrop.clientHeight - parseFloat(outer.paddingTop) - parseFloat(outer.paddingBottom);
      if (frame.maxHeight.endsWith("px")) height = Math.min(height, parseFloat(frame.maxHeight));
      const overlay = getComputedStyle(header).position === "absolute";
      node.style.setProperty("--preview-header-height", `${header.offsetHeight}px`);
      // 入场动画带缩放变换，布局高度不受动画影响，避免误算可用画布。
      const content = Math.max(0, height - (overlay ? 0 : header.offsetHeight) - parseFloat(frame.borderTopWidth) - parseFloat(frame.borderBottomWidth));
      node.style.setProperty("--preview-content-height", `${content}px`);
      node.style.setProperty("--preview-player-height", `${content}px`);
    };
    const observer = new ResizeObserver(resize);
    for (const element of [header, backdrop]) observer.observe(element);
    window.addEventListener("resize", resize); resize();
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, [browsable, kind, playlistExpanded]);
  async function share() {
    // 分享弹窗 portal 到 body；先退出预览全屏，确保它不会被全屏层遮住。
    const screen = document.fullscreenElement;
    if (screen && stage.current?.closest(".modal-backdrop")?.contains(screen)) {
      try { await document.exitFullscreen(); } catch { toast.error("请先退出全屏，再打开分享设置。"); return; }
    }
    onShare?.(active);
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
  // 视频与图片：鼠标静止一会儿后隐藏浮在画面上的头部，移动、按键或悬停头部时恢复；暂停的视频始终显示。
  useEffect(() => {
    const modal = stage.current?.closest<HTMLElement>(".modal");
    if (!modal || (kind !== "video" && kind !== "image")) return;
    let timer = 0;
    const header = modal.querySelector<HTMLElement>(".modal-header");
    const wake = () => {
      modal.classList.remove("is-chrome-idle");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (modal.classList.contains("is-minimized") || header?.matches(":hover, :focus-within") || modal.querySelector(".preview-playlist-panel")) return;
        if (kind === "video" && !playingRef.current) return;
        modal.classList.add("is-chrome-idle");
      }, 2600);
    };
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const name of events) modal.addEventListener(name, wake, { passive: true });
    wake();
    return () => { window.clearTimeout(timer); modal.classList.remove("is-chrome-idle"); for (const name of events) modal.removeEventListener(name, wake); };
  }, [kind]);
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
  // 下载、分享放在头部，与窗口按钮一组；不再保留底部操作栏，内容区可以更高。
  return (
    <Modal size="xl" initialFocus="dialog" onKeyDownCapture={handleShortcut} windowShortcuts expandable pinnable minimizable movable windowKey={file.key} minimizedContent={media ? <MinimizedPlayback progress={progress} state={mediaState} playing={playing} lyric={kind === "audio" && lyric.key === active.key ? lyric.line : null} onSeek={time => controls.current?.seek(time)} onToggle={togglePlayback} nav={nav} />
      : kind === "image" && nav && nav.count > 1 ? <div className="preview-mini-gallery">
        <IconButton icon="previous" label="上一张" size="sm" onClick={nav.onPrevious} />
        <span>{nav.index + 1} / {nav.count}</span>
        <IconButton icon="next" label="下一张" size="sm" onClick={nav.onNext} />
      </div> : undefined} className={`preview-modal preview-modal-${kind}${browsable ? " is-immersive" : ""}${api.isPrivatePath(active.key) ? " is-private" : ""}${panelOpen ? " has-playlist-open" : ""}`} leading={<FileVisual kind={kind} src={source.thumbnail} size="lg" />} title={baseName(active.key)} onClose={onClose}
      description={<span className="preview-meta">
        <span title={active.content_type ?? undefined}>{typeLabel}</span><span>{formatBytes(active.size)}</span>
        <span className="preview-meta-date" title={`修改于 ${formatDateTime(active.modified_at)}`}>{formatDate(active.modified_at)}</span>
        {active.public_token && <span className="preview-meta-public" title="已公开分享"><Icon name="globe" size={12} />公开</span>}
      </span>}
      actions={<>
        {onShare && <IconButton icon="link" label={active.public_token ? "管理分享" : "公开分享"} size="sm" onClick={() => void share()} />}
        <a className="icon-btn icon-btn-ghost icon-btn-sm" href={source.downloadUrl} aria-label="下载文件" title="下载文件"><Icon name="download" size={16} /></a>
        <span className="modal-actions-divider" aria-hidden="true" />
      </>}>
      <div ref={stage} className={`preview-stage${browsable ? " has-playlist is-media" : ""}${panelOpen ? " is-playlist-open" : ""}`}><FilePreview kind={kind} url={kind === "image" || kind === "video" || kind === "audio" ? api.versionedContentUrl(source.url, active.etag) : source.url} name={baseName(active.key)} downloadUrl={source.downloadUrl} contentType={active.content_type} poster={source.poster} onImageLoad={image => onImageLoad?.(image, active)} resolveImage={resolveImage} assetUrl={assetUrl}
        onPlaying={setPlaying} onEnded={() => { const next = playlist.next(true); if (next) select(next); }}
        onProgress={value => setProgress(current => current.currentTime === value.currentTime && current.duration === value.duration ? current : value)} onState={setMediaState}
        onLyricLine={line => setLyric(current => current.key === active.key && current.line === line ? current : { key: active.key, line })}
        onControls={instance => { controls.current = instance; if (instance && pendingPlay.current) { pendingPlay.current = false; play(); } }}
        loadAssets={loadAssets ? signal => loadAssets(active, signal) : assetUrl ? signal => api.previewAssets(active.key, signal) : undefined} nav={nav} strip={strip} />
        {panelOpen && <PlaylistPanel playlist={playlist} onSelect={select} typeLabel={kindLabel(kind)} playing={playing}
          onCollapse={() => setPlaylistExpanded(false)}
          renderThumbnail={item => <FileVisual kind={getFileKind(item.content_type, item.key)} src={sourceOf(item).thumbnail} size="md" />} />}
      </div>
    </Modal>
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
      footer={<>{links && <a className="btn btn-ghost btn-md" href={links.page} target="_blank" rel="noreferrer"><Icon name="external" size={17} /><span>打开分享页</span></a>}<Button disabled={busy} onClick={onClose}>完成</Button></>}>
      <div className={`share-status${isPublic ? " is-public" : ""}`}>
        <Switch checked={isPublic} disabled={busy} onChange={value => void apply(value)} label={isPublic ? "任何拥有链接的人都可以访问" : "仅自己可见"}
          description={isPublic
            ? (file.public_has_password ? `访问者需要输入密码才能查看和下载${folder ? "里面的文件" : ""}。` : folder ? "访问者可浏览、预览和下载全部内容，包括子文件夹。" : "访问者无需登录即可预览和下载。")
            : "开启公开访问后生成分享链接，可随时关闭。"} />
      </div>
      {error && <div className="form-alert" role="alert">{error}</div>}
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
                <Button size="sm" variant="ghost" className="btn-ghost-danger" disabled={busy} onClick={() => void apply(true, { password: null }, "已取消访问密码")}>取消密码</Button>
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

