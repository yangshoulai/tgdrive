/** 媒体库：跨文件夹浏览「最近」（按天分组的最近文件）、「收藏夹」（收藏的文件，代码里叫 starred）与「相册」（图片）、「影视」（视频）、「音乐」（音频）。
 * 相册与影视首页按所在文件夹分组（GET /api/user/v1/library/folders），打开文件夹只列其中直接包含的这类文件；
 * 音乐分「专辑」与「歌单」两个标签：专辑按标签里的专辑名归类（GET /library/albums，同名专辑合为一张，没有专辑的归为「无专辑」），
 * 歌单是用户自己整理的歌曲列表（/playlists，顺序可调整）。
 * 搜索按相对路径（音乐另含歌名、艺人、专辑）匹配，结果按文件夹（音乐按专辑）分段。数据只含普通文件；预览挂在应用外壳上，播放列表不限同一文件夹。 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import * as api from "../api";
import { FileThumbnail, FileVisual, baseName, canPreview, getFileKind, kindLabel, parentPath } from "../files";
import { coverTint } from "../preview-media";
import { Button, Checkbox, ConfirmDialog, EmptyState, Icon, IconButton, Menu, PageHeader, SearchInput, SkeletonRows, Tabs, formatBytes, toast, useDocumentTitle, type IconName, type MenuItem } from "../ui";
import { BRAND } from "../brand";
import { usePreview } from "./preview-host";
import { useThumbnailPolling } from "./thumbnail-polling";
import { PlaylistBadge, PlaylistNameDialog, SongPickerDialog, playlistsChanged, useAddToPlaylist, usePlaylistMembership } from "./playlists";

export type MediaView = "photos" | "videos" | "music";
/** 一个文件夹最多读多少个文件（影视与音乐按名称排序，需要读完）。 */
const FOLDER_LIMIT = 5_000;
/** 进入音乐文件夹时，最多为多少首还没有标签记录的歌曲补读标签（每首只读文件头）。 */
const TAG_FILL = 60;
const collator = new Intl.Collator("zh-CN", { numeric: true });

const VIEWS: Record<MediaView, { title: string; icon: IconName; unit: string; noun: string; description: string }> = {
  photos: { title: "相册", icon: "image", unit: "张", noun: "照片", description: "所有文件夹里的照片，按所在文件夹分组；文件夹内按拍摄时间排列（读取 EXIF，没有时按修改时间）。" },
  videos: { title: "影视", icon: "film", unit: "个", noun: "视频", description: "所有文件夹里的视频，按所在文件夹分组；文件夹内按名称排列，剧集按集数顺序。" },
  music: { title: "音乐", icon: "music", unit: "首", noun: "音乐", description: "所有文件夹里的音乐，按歌曲标签里的专辑归类（同名专辑合为一张），没有专辑的歌曲归在「无专辑」；专辑内按曲目号排列。" },
};

/** 输入后稍等再搜索，避免每个字都请求一次。 */
function useSearch() {
  const [text, setText] = useState(""), [query, setQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  return { text, setText, query, submit: () => setQuery(text.trim()) };
}

/** 读媒体库的文件：all 为真时按游标读完（上限 FOLDER_LIMIT），否则按滚动逐页读取。 */
function useLibrary(view: api.LibraryView, options: { q?: string; folder?: string; album?: string; all?: boolean; page?: number }) {
  const { q = "", folder, album, all = false, page = 200 } = options;
  const [items, setItems] = useState<api.LibraryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false), generation = useRef(0);
  const load = useCallback(async (from: string | null, reset: boolean, signal?: AbortSignal) => {
    busy.current = true;
    const current = generation.current;
    try {
      let next = from, collected: api.LibraryItem[] = [];
      do {
        const result = await api.library(view, { cursor: next ?? "", limit: all ? 500 : page, q, folder, album }, signal);
        collected = collected.concat(result.objects); next = result.next_cursor;
      } while (all && next && collected.length < FOLDER_LIMIT && !signal?.aborted);
      if (signal?.aborted || current !== generation.current) return;
      setItems(list => reset ? collected : list.concat(collected));
      setCursor(all ? null : next); setError("");
    } catch (reason) {
      if (!signal?.aborted && current === generation.current) setError(api.errorMessage(reason, "读取失败，请稍后重试"));
    } finally {
      if (current === generation.current) { busy.current = false; setLoading(false); setLoadingMore(false); }
    }
  }, [view, q, folder, album, all, page]);
  useEffect(() => {
    const controller = new AbortController();
    generation.current += 1;
    busy.current = false;
    setItems([]); setCursor(null); setLoading(true);
    void load(null, true, controller.signal);
    return () => controller.abort();
  }, [load]);
  const more = useCallback(() => {
    if (!cursor || busy.current) return;
    setLoadingMore(true); void load(cursor, false);
  }, [cursor, load]);
  const reload = useCallback(() => { setLoading(true); void load(null, true); }, [load]);
  return { items, setItems, loading, loadingMore, error, hasMore: Boolean(cursor), more, reload };
}

/** 列表底部的哨兵：滚到附近时读下一页。 */
function LoadMore({ active, loading, onMore }: { active: boolean; loading: boolean; onMore: () => void }) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !node.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) onMore(); }, { rootMargin: "600px" });
    observer.observe(node.current);
    return () => observer.disconnect();
  }, [active, onMore]);
  if (!active) return null;
  return <div ref={node} className="library-more">{loading ? <><span className="spinner" aria-hidden="true" />正在加载</> : null}</div>;
}

function usePreviewOpener(items: api.FileItem[]) {
  const preview = usePreview();
  return (file: api.FileItem, playlist: api.FileItem[] = items) => preview.open({ file, url: api.contentUrl(file.key), downloadUrl: api.contentUrl(file.key, true),
    assetUrl: key => api.contentUrl(key), playlistFiles: playlist, anyFolder: true,
    poster: api.fileThumbnail(file, "poster"), grid: api.fileThumbnail(file, "grid"), thumbnail: api.fileThumbnail(file) });
}

const DAY = 86400;
function startOfDay(date: Date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000; }
/** 最近：今天、昨天、本周（7 天内）、本月，之后按年月分组。 */
function dayGroup(seconds: number) {
  const now = new Date(), today = startOfDay(now);
  if (seconds >= today) return "今天";
  if (seconds >= today - DAY) return "昨天";
  if (seconds >= today - 6 * DAY) return "7 天内";
  const date = new Date(seconds * 1000);
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return "本月";
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}
/** 相册的月份：EXIF 时间没有时区，按记录时的 UTC 读出「墙上时间」；没有 EXIF 时用本地时间的修改时间。 */
function photoMonth(item: api.LibraryItem) {
  const date = new Date((item.taken_at ?? item.modified_at) * 1000);
  const [year, month] = item.taken_at != null ? [date.getUTCFullYear(), date.getUTCMonth()] : [date.getFullYear(), date.getMonth()];
  return `${year} 年 ${month + 1} 月`;
}
function groupBy<T>(items: T[], key: (item: T) => string) {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = key(item), last = groups.at(-1);
    if (last?.label === label) last.items.push(item); else groups.push({ label, items: [item] });
  }
  return groups;
}
const clock = (seconds?: number) => seconds ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "";
const time = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const folderName = (path: string) => path ? baseName(path.replace(/\/$/, "")) : "我的文件";
const folderLabel = (path: string) => path ? `/${path.replace(/\/$/, "")}` : "我的文件";

function LibraryState({ loading, error, empty, onRetry, children }: { loading: boolean; error: string; empty: ReactNode; onRetry: () => void; children: ReactNode }) {
  if (loading) return <SkeletonRows rows={6} />;
  if (error) return <EmptyState icon="alert" title="读取失败" description={error} action={<Button icon="refresh" onClick={onRetry}>重试</Button>} />;
  return <>{empty ?? children}</>;
}

function LibrarySearch({ search, placeholder }: { search: ReturnType<typeof useSearch>; placeholder: string }) {
  return <div className="library-toolbar">
    <SearchInput value={search.text} onChange={search.setText} onSubmit={search.submit} onClear={() => search.submit()} placeholder={placeholder} label="搜索媒体库" />
  </div>;
}

/* ---------- 最近 ---------- */

export function RecentView({ onOpenFolder }: { onOpenFolder: (prefix: string) => void }) {
  useDocumentTitle(`最近 · ${BRAND}`);
  const search = useSearch();
  const library = useLibrary("recent", { q: search.query, page: 120 });
  useThumbnailPolling(library.items, !library.loading, library.setItems, () => undefined);
  const open = usePreviewOpener(library.items);
  const groups = useMemo(() => groupBy(library.items, item => dayGroup(item.modified_at)), [library.items]);
  return <div className="library-view">
    <PageHeader title="最近" description="所有文件夹里最近上传或修改的文件，按时间倒序。" />
    <LibrarySearch search={search} placeholder="按文件名或文件夹名搜索最近的文件" />
    <LibraryState loading={library.loading} error={library.error} onRetry={library.reload}
      empty={!library.items.length ? search.query
        ? <EmptyState icon="search" title="没有找到文件" description={`没有路径包含「${search.query}」的文件。`} />
        : <EmptyState icon="clock" title="还没有文件" description="上传或保存的文件会按时间出现在这里。" /> : null}>
      {groups.map(group => <section key={group.label} className="library-group">
        <h2 className="library-group-title">{group.label}<span>{group.items.length} 个</span></h2>
        <ul className="library-list">
          {group.items.map(item => {
            const kind = getFileKind(item.content_type, item.key), folder = parentPath(item.key);
            return <li key={item.key} className="library-row">
              <button type="button" className="library-row-main" onClick={() => canPreview(kind, item.key, item.content_type) ? open(item) : onOpenFolder(folder)}>
                <FileVisual kind={kind} src={api.fileThumbnail(item)} size="lg" />
                <span className="library-row-text"><strong>{baseName(item.key)}</strong>
                  <span>{kindLabel(kind)} · {formatBytes(item.size)} · {time(item.modified_at)}</span></span>
              </button>
              <button type="button" className="library-row-folder" title={`打开 ${folderLabel(folder)}`} onClick={() => onOpenFolder(folder)}>
                <Icon name="folder" size={14} /><span>{folderLabel(folder)}</span>
              </button>
            </li>;
          })}
        </ul>
      </section>)}
      <LoadMore active={library.hasMore} loading={library.loadingMore} onMore={library.more} />
    </LibraryState>
  </div>;
}

/* ---------- 星标 ---------- */

/** 收藏夹：普通空间里收藏的文件，最近收藏的在前，按收藏日期分组；行尾的星形按钮取消收藏。 */
export function StarredView({ onOpenFolder }: { onOpenFolder: (prefix: string) => void }) {
  useDocumentTitle(`收藏夹 · ${BRAND}`);
  const search = useSearch();
  const [items, setItems] = useState<api.FileItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const busy = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setItems([]); setCursor(null); setLoading(true); setError("");
    api.starredFiles({ q: search.query, limit: 120 }, controller.signal).then(page => { setItems(page.objects); setCursor(page.next_cursor); setLoading(false); },
      reason => { if (!controller.signal.aborted) { setError(api.errorMessage(reason, "读取失败，请稍后重试")); setLoading(false); } });
    return () => controller.abort();
  }, [search.query, attempt]);
  const more = useCallback(() => {
    if (!cursor || busy.current) return;
    busy.current = true; setLoadingMore(true);
    api.starredFiles({ q: search.query, limit: 120, cursor }).then(page => { setItems(list => list.concat(page.objects)); setCursor(page.next_cursor); },
      reason => toast.error(api.errorMessage(reason, "读取失败，请稍后重试"))).finally(() => { busy.current = false; setLoadingMore(false); });
  }, [cursor, search.query]);
  useThumbnailPolling(items, !loading, setItems, () => undefined);
  const open = usePreviewOpener(items);
  const groups = useMemo(() => groupBy(items, item => dayGroup(item.starred_at ?? item.modified_at)), [items]);
  async function unstar(item: api.FileItem) {
    try {
      await api.setStarred([item.key], false);
      setItems(list => list.filter(entry => entry.key !== item.key));
      toast.success(`已取消收藏「${baseName(item.key)}」`, { label: "撤销", onClick: () => void api.setStarred([item.key], true).then(() => setAttempt(value => value + 1)) });
    } catch (reason) { toast.error(api.errorMessage(reason, "操作失败，请稍后重试")); }
  }
  return <div className="library-view">
    <PageHeader title="收藏夹" description="收藏的文件，不论放在哪个文件夹；在文件的更多操作里选「收藏」，或选中后按 * 键。" />
    <LibrarySearch search={search} placeholder="按文件名或文件夹名搜索收藏的文件" />
    <LibraryState loading={loading} error={error} onRetry={() => setAttempt(value => value + 1)}
      empty={!items.length ? search.query
        ? <EmptyState icon="search" title="没有找到文件" description={`没有路径包含「${search.query}」的收藏文件。`} />
        : <EmptyState icon="star" title="还没有收藏的文件" description="在文件的更多操作里选择「收藏」，常用的文件会集中出现在这里。" /> : null}>
      {groups.map(group => <section key={group.label} className="library-group">
        <h2 className="library-group-title">{group.label}<span>{group.items.length} 个</span></h2>
        <ul className="library-list">
          {group.items.map(item => {
            const kind = getFileKind(item.content_type, item.key), folder = parentPath(item.key);
            return <li key={item.key} className="library-row">
              <button type="button" className="library-row-main" onClick={() => canPreview(kind, item.key, item.content_type) ? open(item) : onOpenFolder(folder)}>
                <FileVisual kind={kind} src={api.fileThumbnail(item)} size="lg" />
                <span className="library-row-text"><strong>{baseName(item.key)}</strong>
                  <span>{kindLabel(kind)} · {formatBytes(item.size)}</span></span>
              </button>
              <button type="button" className="library-row-folder" title={`打开 ${folderLabel(folder)}`} onClick={() => onOpenFolder(folder)}>
                <Icon name="folder" size={14} /><span>{folderLabel(folder)}</span>
              </button>
              <button type="button" className="icon-btn icon-btn-ghost icon-btn-sm star-toggle is-starred" aria-label={`取消收藏「${baseName(item.key)}」`}
                title="取消收藏" onClick={() => void unstar(item)}><Icon name="star" filled size={16} /></button>
            </li>;
          })}
        </ul>
      </section>)}
      <LoadMore active={Boolean(cursor)} loading={loadingMore} onMore={more} />
    </LibraryState>
  </div>;
}

/* ---------- 相册、影视、音乐 ---------- */

const trackNumber = (item: api.FileItem) => parseInt(item.media?.track ?? "", 10) || Number.MAX_SAFE_INTEGER;
const trackTitle = (item: api.FileItem) => item.media?.title || baseName(item.key).replace(/\.[^.]+$/, "");
/** 影视与音乐的文件夹内顺序：音乐先按曲目号；都按文件名自然排序（第 2 集排在第 10 集之前）。 */
function ordered(view: MediaView, items: api.LibraryItem[]) {
  if (view === "photos") return items;
  return [...items].sort((a, b) => (view === "music" ? trackNumber(a) - trackNumber(b) : 0) || collator.compare(baseName(a.key), baseName(b.key)));
}

const albumName = (album: string) => album || "无专辑";
const albumOf = (item: api.FileItem) => item.media?.album?.trim() ?? "";

/** 媒体库三页的入口。place 是地址里的位置（user.tsx 的 prefix）：空串为首页；"/<名称>" 打开一组——相册与影视是文件夹（"" 为根目录），
 * 音乐是专辑（"" 为无专辑）；音乐另有 "playlists"（歌单标签）与 "playlist:<编号>"（打开一个歌单）。 */
export function MediaLibraryView({ view, place, onPlace, onOpenLocation }: {
  view: MediaView; place: string; onPlace: (place: string) => void; onOpenLocation: (prefix: string) => void;
}) {
  const search = useSearch();
  const config = VIEWS[view];
  const folder = place.startsWith("/") ? place.slice(1) : null;
  const onOpenFolder = (group: string | null) => onPlace(group === null ? "" : `/${group}`);
  const playlist = view === "music" && place.startsWith("playlist:") ? Number(place.slice(9)) || null : null;
  const tab = place === "playlists" ? "playlists" : "albums";
  useDocumentTitle(`${folder !== null ? `${view === "music" ? albumName(folder) : folderName(folder)} · ` : tab === "playlists" ? "歌单 · " : ""}${config.title} · ${BRAND}`);
  if (view === "music") {
    if (playlist !== null) return <PlaylistPage key={playlist} id={playlist} onBack={() => onPlace("playlists")} onOpenLocation={onOpenLocation} />;
    if (folder !== null) return <MusicAlbum key={folder} album={folder} onBack={() => onOpenFolder(null)} onOpenLocation={onOpenLocation} />;
    return <div className="library-view">
      <PageHeader title={config.title} description={tab === "playlists" ? "你整理的歌单：从专辑、搜索结果或文件列表把歌曲加入歌单，顺序可以随时调整。" : config.description}
        actions={tab === "albums" ? <PlayAllMusic /> : <NewPlaylistButton onCreated={id => onPlace(`playlist:${id}`)} />} />
      <Tabs label="音乐浏览方式" className="library-tabs" value={tab} onChange={value => onPlace(value === "playlists" ? "playlists" : "")}
        options={[{ value: "albums", label: "专辑", icon: "music" }, { value: "playlists", label: "歌单", icon: "playlist" }]} />
      {tab === "playlists" ? <PlaylistsHome onOpen={id => onPlace(`playlist:${id}`)} /> : <>
        <LibrarySearch search={search} placeholder="搜索歌名、艺人、专辑、文件名或文件夹" />
        {search.query ? <MediaSearch key={search.query} view={view} query={search.query} onOpenFolder={onOpenFolder} onOpenLocation={onOpenLocation} />
          : <MusicAlbums onOpenAlbum={onOpenFolder} />}
      </>}
    </div>;
  }
  if (folder !== null) return <MediaFolder key={`${view}:${folder}`} view={view} folder={folder} onBack={() => onOpenFolder(null)} onOpenLocation={onOpenLocation} />;
  return <div className="library-view">
    <PageHeader title={config.title} description={config.description} />
    <LibrarySearch search={search} placeholder={`按文件名或文件夹名搜索${config.noun}`} />
    {search.query
      ? <MediaSearch key={`${view}:${search.query}`} view={view} query={search.query} onOpenFolder={onOpenFolder} onOpenLocation={onOpenLocation} />
      : <MediaFolders key={view} view={view} onOpenFolder={onOpenFolder} />}
  </div>;
}

function MediaFolders({ view, onOpenFolder }: { view: "photos" | "videos"; onOpenFolder: (folder: string) => void }) {
  const config = VIEWS[view];
  const [state, setState] = useState<{ folders: api.LibraryFolder[]; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState(null); setError("");
    api.libraryFolders(view, "", controller.signal).then(setState, reason => {
      if (!controller.signal.aborted) setError(api.errorMessage(reason, "读取失败，请稍后重试"));
    });
    return () => controller.abort();
  }, [view, attempt]);
  const folders = state?.folders ?? [];
  const total = folders.reduce((sum, item) => sum + item.count, 0);
  return <LibraryState loading={!state && !error} error={error} onRetry={() => setAttempt(value => value + 1)}
    empty={state && !folders.length ? <EmptyState icon={config.icon} title={`还没有${config.noun}`} description={`上传的${config.noun}会按所在文件夹出现在这里。`} /> : null}>
    <p className="library-summary">{folders.length} 个文件夹 · {total} {config.unit}{state?.truncated ? `（只显示最近的 ${folders.length} 个文件夹，可用搜索查找其余的）` : ""}</p>
    <div className={`media-folders is-${view}`}>
      {folders.map(item => <button key={item.path} type="button" className="media-folder" onClick={() => onOpenFolder(item.path)} title={folderLabel(item.path)}>
        <FolderCover view={view} folder={item} />
        <strong>{folderName(item.path)}</strong>
        <span>{item.count} {config.unit} · {formatBytes(item.size)}</span>
        <span className="media-folder-path">{item.path ? folderLabel(parentPath(item.path.replace(/\/$/, ""))) : "根目录"}</span>
      </button>)}
    </div>
  </LibraryState>;
}

/** 文件夹封面：相册是最新四张照片的拼图，影视用第一个有封面的视频；没有封面时用按名称选的色调。 */
function FolderCover({ view, folder }: { view: "photos" | "videos"; folder: api.LibraryFolder }) {
  const kind = view === "photos" ? "image" : "video";
  const tint = { "--cover-tint": coverTint(folder.path || "root") } as CSSProperties;
  if (view === "photos" && folder.samples.length >= 4) {
    return <span className="media-folder-cover is-mosaic">{folder.samples.slice(0, 4).map(item =>
      <span key={item.key}><FileThumbnail kind="image" url={api.fileThumbnail(item, "grid")} placeholder={api.fileThumbnail(item)} /></span>)}</span>;
  }
  const cover = view === "photos" ? folder.samples[0] : folder.samples.find(item => api.fileThumbnail(item));
  return <span className="media-folder-cover" style={tint}>
    {cover && api.fileThumbnail(cover) ? <FileThumbnail kind={kind} url={api.fileThumbnail(cover, "grid")} placeholder={api.fileThumbnail(cover)} />
      : <span className="tint-cover"><Icon name={VIEWS[view].icon} size={28} /></span>}
  </span>;
}

function MediaSearch({ view, query, onOpenFolder, onOpenLocation }: { view: MediaView; query: string; onOpenFolder: (folder: string) => void; onOpenLocation: (prefix: string) => void }) {
  const config = VIEWS[view];
  const library = useLibrary(view, { q: query, page: 200 });
  useThumbnailPolling(library.items, !library.loading, library.setItems, () => undefined);
  const open = usePreviewOpener(library.items);
  const adding = useAddToPlaylist();
  const selection = useTrackSelection(view === "music" ? library.items : []);
  const membership = usePlaylistMembership(view === "music" ? library.items.map(item => item.key) : []);
  // 音乐按专辑分段（专辑名排序，无专辑在最后），其余按文件夹（服务端按路径返回，同一文件夹相邻）。
  const groups = useMemo(() => {
    if (view !== "music") return groupBy(library.items, item => parentPath(item.key)).map(group => ({ ...group, items: ordered(view, group.items) }));
    const albums = new Map<string, api.LibraryItem[]>();
    for (const item of library.items) albums.set(albumOf(item), [...albums.get(albumOf(item)) ?? [], item]);
    return [...albums.entries()].sort(([a], [b]) => Number(!a) - Number(!b) || collator.compare(a, b)).map(([label, items]) => ({ label, items: ordered(view, items) }));
  }, [library.items, view]);
  return <LibraryState loading={library.loading} error={library.error} onRetry={library.reload}
    empty={!library.items.length ? <EmptyState icon="search" title={`没有找到${config.noun}`} description={`没有与「${query}」匹配的${config.noun}。`} /> : null}>
    {view === "music" && <TrackSelectionBar selection={selection} items={library.items} onAdd={adding.open} />}
    {groups.map(group => <section key={group.label} className="library-group">
      <h2 className="library-group-title">
        <button type="button" className="library-group-link" onClick={() => onOpenFolder(group.label)}>
          <Icon name={view === "music" ? "music" : "folder"} size={16} />{view === "music" ? albumName(group.label) : folderLabel(group.label)}</button>
        <span>{group.items.length} {config.unit}</span>
      </h2>
      <MediaItems view={view} items={group.items} open={file => open(file, group.items)}
        menu={view === "music" ? track => trackMenu(track, adding.open, onOpenLocation) : undefined}
        selection={view === "music" ? selection : undefined} membership={view === "music" ? membership : undefined} />
    </section>)}
    <LoadMore active={library.hasMore} loading={library.loadingMore} onMore={library.more} />
    {adding.dialog}
  </LibraryState>;
}

/** 曲目的更多操作：加入歌单、打开所在文件夹；歌单页在前面另加调整顺序与移除。 */
function trackMenu(track: api.LibraryItem, addToPlaylist: (files: api.FileItem[]) => void, onOpenLocation: (prefix: string) => void): MenuItem[] {
  return [
    { label: "添加到歌单…", icon: "playlist", onSelect: () => addToPlaylist([track]) },
    { label: "打开所在文件夹", icon: "folder", onSelect: () => onOpenLocation(parentPath(track.key)) },
  ];
}

function MediaFolder({ view, folder, onBack, onOpenLocation }: { view: "photos" | "videos"; folder: string; onBack: () => void; onOpenLocation: (prefix: string) => void }) {
  const config = VIEWS[view];
  // 照片按拍摄时间分页读取；影视要按名称排序，读完整个文件夹。
  const library = useLibrary(view, { folder, all: view !== "photos", page: 200 });
  useThumbnailPolling(library.items, !library.loading, library.setItems, () => undefined);
  const items = useMemo(() => ordered(view, library.items), [library.items, view]);
  const open = usePreviewOpener(items);
  const total = items.reduce((sum, track) => sum + (track.media?.duration ?? 0), 0);
  const summary = [`${items.length}${library.hasMore ? "+" : ""} ${config.unit}`, view !== "photos" && total ? clock(total) : null].filter(Boolean).join(" · ");
  return <div className="library-view">
    <button type="button" className="library-back" onClick={onBack}><Icon name="chevronLeft" size={16} />{config.title}</button>
    <header className={`album-header is-${view}`}>
      <div className="album-header-text">
        <span className="album-header-kind">{folderLabel(parentPath(folder.replace(/\/$/, "")))}</span>
        <h1>{folderName(folder)}</h1>
        {!library.loading && <p>{summary}</p>}
        <div className="album-header-actions">
          {view === "videos" && items.length > 0 && <Button variant="primary" icon="play" onClick={() => open(items[0])}>从头播放</Button>}
          <Button icon="folder" onClick={() => onOpenLocation(folder)}>在文件中打开</Button>
        </div>
      </div>
    </header>
    <LibraryState loading={library.loading} error={library.error} onRetry={library.reload}
      empty={!items.length ? <EmptyState icon={config.icon} title={`这个文件夹里没有${config.noun}`} description="文件可能已被移动或删除。" /> : null}>
      {view === "photos"
        ? groupBy(items, photoMonth).map(group => <section key={group.label} className="library-group">
          <h2 className="library-group-title">{group.label}<span>{group.items.length} {config.unit}</span></h2>
          <MediaItems view={view} items={group.items} open={file => open(file)} />
        </section>)
        : <MediaItems view={view} items={items} open={file => open(file)} />}
      <LoadMore active={library.hasMore} loading={library.loadingMore} onMore={library.more} />
    </LibraryState>
  </div>;
}

/** 一组文件：照片是方形网格，影视是带名称与时长的横向封面，音乐是曲目列表。 */
function MediaItems({ view, items, open, menu, selection, membership, playlist }: { view: MediaView; items: api.LibraryItem[]; open: (file: api.LibraryItem) => void;
  /** 音乐曲目行尾的更多操作菜单。 */ menu?: (track: api.LibraryItem, index: number) => MenuItem[];
  /** 音乐曲目的多选（行首复选框；有选中项时一直显示）。 */ selection?: TrackSelection;
  /** 每首歌所在的歌单（行内标记）；playlist 是当前打开的歌单，标记里不再列出它。 */ membership?: (key: string) => api.Playlist[]; playlist?: number }) {
  if (view === "photos") return <div className="photo-grid">
    {items.map(item => <button key={item.key} type="button" className="photo-tile" title={baseName(item.key)} onClick={() => open(item)}>
      <FileThumbnail kind="image" url={api.fileThumbnail(item, "grid")} placeholder={api.fileThumbnail(item)} />
    </button>)}
  </div>;
  if (view === "videos") return <div className="video-grid">
    {items.map(item => <button key={item.key} type="button" className="video-card" title={baseName(item.key)} onClick={() => open(item)}>
      <span className="video-card-poster" style={{ "--cover-tint": coverTint(item.key) } as CSSProperties}>
        {api.fileThumbnail(item) ? <FileThumbnail kind="video" url={api.fileThumbnail(item, "grid")} placeholder={api.fileThumbnail(item)} />
          : <span className="tint-cover"><Icon name="film" size={28} /></span>}
        {item.media?.duration ? <span className="photo-tile-duration">{clock(item.media.duration)}</span> : null}
      </span>
      <strong>{baseName(item.key).replace(/\.[^.]+$/, "")}</strong>
      <span>{[item.dimensions ? `${item.dimensions.height}p` : null, formatBytes(item.size)].filter(Boolean).join(" · ")}</span>
    </button>)}
  </div>;
  return <ol className={`track-list${selection ? " is-selectable" : ""}${selection?.selected.size ? " is-selecting" : ""}`}>
    {items.map((track, index) => <li key={track.key} className={selection?.selected.has(track.key) ? "is-selected" : undefined}>
      {selection && <span className="track-check"><Checkbox label={`选择 ${trackTitle(track)}`} checked={selection.selected.has(track.key)}
        onChange={value => selection.toggle(track.key, value)} /></span>}
      <button type="button" className="track-row" onClick={() => selection?.selected.size ? selection.toggle(track.key, !selection.selected.has(track.key)) : open(track)}>
        {/* 左侧是在这份列表里的序号（已按曲目号排好）；标签里的原曲目号在只收录部分曲目或合并同名专辑时会跳号，不直接显示。 */}
        <span className="track-number">{index + 1}</span>
        <span className="track-cover" style={{ "--cover-tint": coverTint(track.key) } as CSSProperties}>
          {api.fileThumbnail(track) ? <FileThumbnail kind="audio" url={api.fileThumbnail(track)} />
            : <span className="tint-cover"><Icon name="music" size={16} /></span>}
        </span>
        <span className="track-text"><strong>{trackTitle(track)}</strong>
          <span title={track.key}>{[track.media?.artist, folderLabel(parentPath(track.key))].filter(Boolean).join(" · ")}</span></span>
        {membership && <PlaylistBadge lists={membership(track.key)} exclude={playlist} />}
        <span className="track-duration">{clock(track.media?.duration)}</span>
      </button>
      {menu && <span className="track-menu"><Menu label={`${trackTitle(track)} 的更多操作`} items={menu(track, index)} /></span>}
    </li>)}
  </ol>;
}

/* ---------- 音乐：多选 ---------- */

type TrackSelection = { selected: Set<string>; toggle: (key: string, value: boolean) => void };

/** 曲目多选：列表变化时去掉已不在列表里的选择。 */
function useTrackSelection(items: api.LibraryItem[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(current => {
    const keys = new Set(items.map(item => item.key));
    const next = new Set([...current].filter(key => keys.has(key)));
    return next.size === current.size ? current : next;
  }), [items]);
  const toggle = useCallback((key: string, value: boolean) => setSelected(current => {
    const next = new Set(current);
    if (value) next.add(key); else next.delete(key);
    return next;
  }), []);
  return { selected, toggle, setSelected, picked: items.filter(item => selected.has(item.key)) };
}

/** 选中歌曲后出现在列表上方的操作栏：全选、加入歌单，以及调用方给出的其他操作（歌单页的「从歌单移除」）。 */
function TrackSelectionBar({ selection, items, onAdd, children }: { selection: ReturnType<typeof useTrackSelection>; items: api.LibraryItem[];
  onAdd: (files: api.LibraryItem[]) => void; children?: ReactNode }) {
  const count = selection.selected.size;
  const all = count > 0 && items.every(item => selection.selected.has(item.key));
  return <div className={`toolbar selection-bar track-selection-bar${count ? "" : " is-idle"}`} role="toolbar" aria-label="所选歌曲的操作">
    <label className="track-selection-all"><Checkbox label="全选" checked={all} indeterminate={count > 0 && !all}
      onChange={value => selection.setSelected(value ? new Set(items.map(item => item.key)) : new Set())} />
      <span className="selection-count">{count ? `已选择 ${count} 首` : "选择歌曲"}</span></label>
    {count > 0 && <div className="toolbar-actions">
      <Button size="sm" icon="playlist" onClick={() => onAdd(selection.picked)}>加入歌单</Button>
      {children}
      <IconButton icon="x" label="取消选择" size="sm" onClick={() => selection.setSelected(new Set())} />
    </div>}
  </div>;
}

/* ---------- 音乐：按专辑 ---------- */

/** 专辑封面：用排在最前的歌曲的封面（第一首没有封面时依次往后找）；都没有时用按专辑名选的色调。 */
function AlbumCover({ album, tracks, size = "md", icon = "music" }: { album: string; tracks: api.LibraryItem[]; size?: "md" | "lg"; icon?: IconName }) {
  const cover = tracks.find(track => api.fileThumbnail(track));
  return <span className={`album-cover album-cover-${size}`} style={{ "--cover-tint": coverTint(album || "无专辑") } as CSSProperties}>
    {cover ? <FileThumbnail kind="audio" url={api.fileThumbnail(cover, "grid")} placeholder={api.fileThumbnail(cover)} />
      : <span className="tint-cover"><Icon name={icon} size={size === "lg" ? 40 : 28} /></span>}
  </span>;
}

function MusicAlbums({ onOpenAlbum }: { onOpenAlbum: (album: string) => void }) {
  const [state, setState] = useState<{ albums: api.LibraryAlbum[]; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState(null); setError("");
    api.libraryAlbums("", controller.signal).then(setState, reason => {
      if (!controller.signal.aborted) setError(api.errorMessage(reason, "读取失败，请稍后重试"));
    });
    return () => controller.abort();
  }, [attempt]);
  const albums = state?.albums ?? [];
  const total = albums.reduce((sum, item) => sum + item.count, 0);
  const named = albums.filter(item => item.album).length;
  return <LibraryState loading={!state && !error} error={error} onRetry={() => setAttempt(value => value + 1)}
    empty={state && !albums.length ? <EmptyState icon="music" title="还没有音乐" description="上传的音乐会按专辑出现在这里。" /> : null}>
    <p className="library-summary">{named} 张专辑 · {total} 首{state?.truncated ? `（只显示前 ${albums.length} 张专辑，可用搜索查找其余的）` : ""}</p>
    <div className="media-folders is-music">
      {albums.map(item => <button key={item.album || "\u0000"} type="button" className="media-folder" onClick={() => onOpenAlbum(item.album)} title={albumName(item.album)}>
        <AlbumCover album={item.album} tracks={item.samples} />
        <strong>{albumName(item.album)}</strong>
        <span>{[item.album ? item.artist : null, `${item.count} 首`].filter(Boolean).join(" · ")}</span>
      </button>)}
    </div>
  </LibraryState>;
}

/** 「全部播放」：读出全部音乐（上限 FOLDER_LIMIT），按专辑名排列（无专辑在最后）、专辑内按曲目号与文件名，作为播放列表从第一首开始。 */
function PlayAllMusic() {
  const open = usePreviewOpener([]);
  const [busy, setBusy] = useState(false);
  const play = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let cursor: string | null = "", items: api.LibraryItem[] = [];
      do {
        const page = await api.library("music", { cursor: cursor ?? "", limit: 500 });
        items = items.concat(page.objects); cursor = page.next_cursor;
      } while (cursor && items.length < FOLDER_LIMIT);
      if (!items.length) { toast.info("还没有音乐"); return; }
      const albums = new Map<string, api.LibraryItem[]>();
      for (const item of items) albums.set(albumOf(item), [...albums.get(albumOf(item)) ?? [], item]);
      const tracks = [...albums.entries()].sort(([a], [b]) => Number(!a) - Number(!b) || collator.compare(a, b)).flatMap(([, list]) => ordered("music", list));
      open(tracks[0], tracks);
    } catch (reason) {
      toast.error(api.errorMessage(reason, "读取音乐失败，请稍后重试"));
    } finally { setBusy(false); }
  };
  return <Button variant="primary" icon="play" loading={busy} onClick={() => void play()}>全部播放</Button>;
}

function MusicAlbum({ album, onBack, onOpenLocation }: { album: string; onBack: () => void; onOpenLocation: (prefix: string) => void }) {
  const library = useLibrary("music", { album, all: true });
  const adding = useAddToPlaylist();
  useThumbnailPolling(library.items, !library.loading, library.setItems, () => undefined);
  const tracks = useMemo(() => ordered("music", library.items), [library.items]);
  const selection = useTrackSelection(tracks);
  const membership = usePlaylistMembership(tracks.map(track => track.key));
  const open = usePreviewOpener(tracks);
  useTagFill(library.items, library.setItems);
  const total = tracks.reduce((sum, track) => sum + (track.media?.duration ?? 0), 0);
  const artists = new Set(tracks.map(track => track.media?.artist).filter(Boolean));
  const artist = artists.size === 1 ? [...artists][0] : artists.size > 1 ? "多位艺人" : null;
  const year = tracks.map(track => track.media?.year).find(Boolean);
  return <div className="library-view">
    <button type="button" className="library-back" onClick={onBack}><Icon name="chevronLeft" size={16} />音乐</button>
    <header className="album-header">
      <AlbumCover album={album} tracks={tracks} size="lg" />
      <div className="album-header-text">
        <span className="album-header-kind">{album ? "专辑" : "没有专辑信息的歌曲"}</span>
        <h1>{albumName(album)}</h1>
        {!library.loading && <p>{[album ? artist : null, album ? year : null, `${tracks.length} 首`, total ? clock(total) : null].filter(Boolean).join(" · ")}</p>}
        <div className="album-header-actions">
          {tracks.length > 0 && <Button variant="primary" icon="play" onClick={() => open(tracks[0])}>全部播放</Button>}
          {tracks.length > 0 && <Button icon="playlist" onClick={() => adding.open(tracks)}>整张加入歌单</Button>}
        </div>
      </div>
    </header>
    <LibraryState loading={library.loading} error={library.error} onRetry={library.reload}
      empty={!tracks.length ? <EmptyState icon="music" title="这张专辑里没有歌曲" description="歌曲可能已被移动、删除或修改了专辑信息。" /> : null}>
      <TrackSelectionBar selection={selection} items={tracks} onAdd={adding.open} />
      <MediaItems view="music" items={tracks} open={file => open(file)} menu={track => trackMenu(track, adding.open, onOpenLocation)}
        selection={selection} membership={membership} />
    </LibraryState>
    {adding.dialog}
  </div>;
}

/* ---------- 音乐：歌单 ---------- */

function shuffled<T>(items: T[]) {
  const list = [...items];
  for (let index = list.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [list[index], list[other]] = [list[other], list[index]];
  }
  return list;
}

function NewPlaylistButton({ onCreated }: { onCreated: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>新建歌单</Button>
    {open && <PlaylistNameDialog title="新建歌单" confirm="创建" onClose={() => setOpen(false)}
      onSubmit={async name => { const playlist = await api.createPlaylist(name); setOpen(false); onCreated(playlist.id); }} />}
  </>;
}

/** 歌单封面：前四首都有封面时拼成四宫格，否则用第一张封面；都没有时用按名称选的色调。 */
function PlaylistCover({ playlist, size = "md" }: { playlist: Pick<api.Playlist, "name" | "samples">; size?: "md" | "lg" }) {
  const covers = playlist.samples.filter(item => api.fileThumbnail(item));
  if (covers.length >= 4) return <span className={`album-cover album-cover-${size} is-mosaic`}>{covers.slice(0, 4).map(item =>
    <span key={item.key}><FileThumbnail kind="audio" url={api.fileThumbnail(item, "grid")} placeholder={api.fileThumbnail(item)} /></span>)}</span>;
  return <AlbumCover album={playlist.name} tracks={covers} size={size} icon="playlist" />;
}

function PlaylistsHome({ onOpen }: { onOpen: (id: number) => void }) {
  const [lists, setLists] = useState<api.Playlist[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLists(null); setError("");
    api.playlists(controller.signal).then(result => setLists(result.playlists), reason => {
      if (!controller.signal.aborted) setError(api.errorMessage(reason, "读取失败，请稍后重试"));
    });
    return () => controller.abort();
  }, [attempt]);
  return <LibraryState loading={!lists && !error} error={error} onRetry={() => setAttempt(value => value + 1)}
    empty={lists && !lists.length ? <EmptyState icon="playlist" title="还没有歌单" description="点右上角「新建歌单」，或在专辑、搜索结果和文件列表里选择「添加到歌单」。" /> : null}>
    <p className="library-summary">{lists?.length ?? 0} 个歌单</p>
    <div className="media-folders is-music">
      {(lists ?? []).map(item => <button key={item.id} type="button" className="media-folder" onClick={() => onOpen(item.id)} title={item.name}>
        <PlaylistCover playlist={item} />
        <strong>{item.name}</strong>
        <span>{[`${item.count} 首`, item.duration ? clock(item.duration) : null].filter(Boolean).join(" · ")}</span>
      </button>)}
    </div>
  </LibraryState>;
}

function PlaylistPage({ id, onBack, onOpenLocation }: { id: number; onBack: () => void; onOpenLocation: (prefix: string) => void }) {
  const [info, setInfo] = useState<api.PlaylistInfo | null>(null);
  const [tracks, setTracks] = useState<api.LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [picking, setPicking] = useState(false);
  const adding = useAddToPlaylist();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void (async () => {
      try {
        let cursor: string | null = "", items: api.LibraryItem[] = [], playlist: api.PlaylistInfo | null = null;
        do {
          const page = await api.playlistItems(id, cursor ?? "", 500, controller.signal);
          playlist = page.playlist; items = items.concat(page.objects); cursor = page.next_cursor;
        } while (cursor && !controller.signal.aborted);
        setInfo(playlist); setTracks(items);
      } catch (reason) {
        if (!controller.signal.aborted) setError(api.errorMessage(reason, "歌单读取失败，请稍后重试"));
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [id, attempt]);
  useThumbnailPolling(tracks, !loading, setTracks, () => undefined);
  useTagFill(tracks, setTracks);
  const open = usePreviewOpener(tracks);
  const selection = useTrackSelection(tracks);
  const membership = usePlaylistMembership(tracks.map(track => track.key));
  useDocumentTitle(`${info?.name ?? "歌单"} · 音乐 · ${BRAND}`);
  const total = tracks.reduce((sum, track) => sum + (track.media?.duration ?? 0), 0);
  async function change(update: Parameters<typeof api.updatePlaylist>[1], apply: (list: api.LibraryItem[]) => api.LibraryItem[], message?: string) {
    const before = tracks;
    setTracks(apply);
    try { const result = await api.updatePlaylist(id, update); setInfo(result); if (update.remove) playlistsChanged(); if (message) toast.success(message); }
    catch (reason) { setTracks(before); toast.error(api.errorMessage(reason, "操作失败，请稍后重试")); }
  }
  const moveTo = (track: api.LibraryItem, target: number) => {
    const without = tracks.filter(item => item.key !== track.key);
    const before = without[target]?.key ?? null;
    void change({ move: { path: track.key, before } }, () => [...without.slice(0, target), track, ...without.slice(target)]);
  };
  const menu = (track: api.LibraryItem, index: number): MenuItem[] => {
    const order: MenuItem[] = [
      ...(index > 0 ? [{ label: "移到最前", icon: "arrowUp" as const, onSelect: () => moveTo(track, 0) },
        { label: "上移", icon: "chevronUp" as const, onSelect: () => moveTo(track, index - 1) }] : []),
      ...(index < tracks.length - 1 ? [{ label: "下移", icon: "chevronDown" as const, onSelect: () => moveTo(track, index + 1) }] : []),
    ];
    const [first, ...rest] = trackMenu(track, adding.open, onOpenLocation);
    return [...order, { ...first, divider: order.length > 0 }, ...rest,
      { label: "从歌单移除", icon: "x", danger: true, divider: true, onSelect: () => void change({ remove: [track.key] }, list => list.filter(item => item.key !== track.key), `已从歌单移除「${trackTitle(track)}」`) }];
  };
  return <div className="library-view">
    <button type="button" className="library-back" onClick={onBack}><Icon name="chevronLeft" size={16} />歌单</button>
    <header className="album-header">
      <PlaylistCover playlist={{ name: info?.name ?? "", samples: tracks.slice(0, 4) }} size="lg" />
      <div className="album-header-text">
        <span className="album-header-kind">歌单</span>
        <h1>{info?.name ?? "歌单"}</h1>
        {!loading && <p>{[`${tracks.length} 首`, total ? clock(total) : null].filter(Boolean).join(" · ")}</p>}
        <div className="album-header-actions">
          {tracks.length > 0 && <Button variant="primary" icon="play" onClick={() => open(tracks[0])}>全部播放</Button>}
          {info && <Button icon="plus" onClick={() => setPicking(true)}>添加歌曲</Button>}
          {tracks.length > 1 && <Button icon="shuffle" onClick={() => { const list = shuffled(tracks); open(list[0], list); }}>随机播放</Button>}
          {info && <Menu label="歌单的更多操作" size="md" items={[
            { label: "重命名", icon: "edit", onSelect: () => setRenaming(true) },
            { label: "删除歌单", icon: "trash", danger: true, divider: true, onSelect: () => setDeleting(true) },
          ]} />}
        </div>
      </div>
    </header>
    <LibraryState loading={loading} error={error} onRetry={() => setAttempt(value => value + 1)}
      empty={!tracks.length ? <EmptyState icon="playlist" title="歌单里还没有歌曲" description="点「添加歌曲」从全部音乐里搜索并勾选，或在专辑、搜索结果与文件列表里选择「添加到歌单」。移入回收站的歌曲暂不显示，还原后回到原位置。"
        action={info ? <Button variant="primary" icon="plus" onClick={() => setPicking(true)}>添加歌曲</Button> : undefined} /> : null}>
      <TrackSelectionBar selection={selection} items={tracks} onAdd={adding.open}>
        <Button size="sm" variant="danger" icon="x" onClick={() => {
          const keys = new Set(selection.selected);
          void change({ remove: [...keys] }, list => list.filter(item => !keys.has(item.key)), `已从歌单移除 ${keys.size} 首歌`);
          selection.setSelected(new Set());
        }}>从歌单移除</Button>
      </TrackSelectionBar>
      <MediaItems view="music" items={tracks} open={file => open(file)} menu={menu} selection={selection} membership={membership} playlist={id} />
    </LibraryState>
    {adding.dialog}
    {picking && info && <SongPickerDialog playlist={info} existing={new Set(tracks.map(track => track.key))} onClose={() => setPicking(false)}
      onAdded={() => setAttempt(value => value + 1)} />}
    {renaming && info && <PlaylistNameDialog title="重命名歌单" confirm="保存" initial={info.name} onClose={() => setRenaming(false)}
      onSubmit={async name => { setInfo(await api.updatePlaylist(id, { name })); setRenaming(false); }} />}
    {deleting && info && <ConfirmDialog title="删除歌单" confirmLabel="删除" onClose={() => setDeleting(false)}
      description={<>删除歌单「{info.name}」？歌单里的歌曲文件不会被删除。</>}
      onConfirm={async () => { await api.deletePlaylist(id); playlistsChanged(); toast.success(`已删除歌单「${info.name}」`); onBack(); }} />}
  </div>;
}

/** 还没有标签记录的歌曲（例如升级前上传、从未播放过）：打开文件夹时在后台补读一部分，读到后原地更新。 */
function useTagFill(items: api.LibraryItem[], setItems: (update: (items: api.LibraryItem[]) => api.LibraryItem[]) => void) {
  const filling = useRef(new Set<string>());
  useEffect(() => {
    const missing = items.filter(item => !item.media && !filling.current.has(item.key)).slice(0, TAG_FILL);
    if (!missing.length) return;
    const controller = new AbortController();
    for (const item of missing) filling.current.add(item.key);
    void (async () => {
      for (let index = 0; index < missing.length && !controller.signal.aborted; index += 2) {
        await Promise.all(missing.slice(index, index + 2).map(item => api.mediaInfo(item.key, controller.signal).then(info => {
          const media = { title: info.title ?? undefined, artist: info.artist ?? undefined, album: info.album ?? undefined, album_artist: info.album_artist ?? undefined,
            track: info.track ?? undefined, year: info.year ?? undefined, duration: info.duration ?? undefined };
          setItems(current => current.map(entry => entry.key === item.key ? { ...entry, media } : entry));
        }, () => undefined)));
      }
    })();
    return () => controller.abort();
    // 只在文件数量变化时检查；补读结果原地更新不会再触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, setItems]);
}
