/** 媒体库：跨文件夹浏览「最近」（按天分组的最近文件）、「相册」（图片与视频按拍摄月份）与「音乐」（按专辑）。
 * 数据来自 GET /api/user/v1/library（键集分页，只含普通文件）；预览挂在应用外壳上，播放列表不限同一文件夹。 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import * as api from "../api";
import { FileThumbnail, FileVisual, baseName, canPreview, getFileKind, kindLabel, parentPath } from "../files";
import { coverTint } from "../preview-media";
import { Button, EmptyState, Icon, PageHeader, SkeletonRows, formatBytes, useDocumentTitle } from "../ui";
import { BRAND } from "../brand";
import { usePreview } from "./preview-host";
import { useThumbnailPolling } from "./thumbnail-polling";

const PAGE = { recent: 120, photos: 200, music: 500 } as const;
/** 音乐库一次最多读多少首（按路径分页读完）；更大的曲库请按文件夹浏览。 */
const MUSIC_LIMIT = 10_000;
/** 进入音乐库时，最多为多少首还没有标签记录的歌曲补读标签（每首只读文件头）。 */
const TAG_FILL = 60;

function useLibrary(view: api.LibraryView) {
  const [items, setItems] = useState<api.LibraryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const load = useCallback(async (from: string | null, reset: boolean, signal?: AbortSignal) => {
    busy.current = true;
    try {
      let next = from, collected: api.LibraryItem[] = [];
      // 音乐库要按专辑分组，必须读完；其余页面按滚动逐页读取。
      do {
        const page = await api.library(view, next ?? "", PAGE[view], signal);
        collected = collected.concat(page.objects); next = page.next_cursor;
      } while (view === "music" && next && collected.length < MUSIC_LIMIT && !signal?.aborted);
      if (signal?.aborted) return;
      setItems(current => reset ? collected : current.concat(collected));
      setCursor(next); setError("");
    } catch (reason) {
      if (!signal?.aborted) setError(api.errorMessage(reason, "读取失败，请稍后重试"));
    } finally {
      busy.current = false; setLoading(false); setLoadingMore(false);
    }
  }, [view]);
  useEffect(() => {
    const controller = new AbortController();
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

function LibraryState({ loading, error, empty, onRetry, children }: { loading: boolean; error: string; empty: ReactNode; onRetry: () => void; children: ReactNode }) {
  if (loading) return <SkeletonRows rows={6} />;
  if (error) return <EmptyState icon="alert" title="读取失败" description={error} action={<Button icon="refresh" onClick={onRetry}>重试</Button>} />;
  return <>{empty ?? children}</>;
}

/* ---------- 最近 ---------- */

export function RecentView({ onOpenFolder }: { onOpenFolder: (prefix: string) => void }) {
  useDocumentTitle(`最近 · ${BRAND}`);
  const library = useLibrary("recent");
  useThumbnailPolling(library.items, !library.loading, library.setItems, () => undefined);
  const open = usePreviewOpener(library.items);
  const groups = useMemo(() => groupBy(library.items, item => dayGroup(item.modified_at)), [library.items]);
  return <div className="library-view">
    <PageHeader title="最近" description="所有文件夹里最近上传或修改的文件，按时间倒序。" />
    <LibraryState loading={library.loading} error={library.error} onRetry={library.reload}
      empty={!library.items.length ? <EmptyState icon="clock" title="还没有文件" description="上传或保存的文件会按时间出现在这里。" /> : null}>
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
              <button type="button" className="library-row-folder" title={`打开 /${folder}`} onClick={() => onOpenFolder(folder)}>
                <Icon name="folder" size={14} /><span>{folder ? `/${folder.replace(/\/$/, "")}` : "我的文件"}</span>
              </button>
            </li>;
          })}
        </ul>
      </section>)}
      <LoadMore active={library.hasMore} loading={library.loadingMore} onMore={library.more} />
    </LibraryState>
  </div>;
}

/* ---------- 相册 ---------- */

export function PhotosView() {
  useDocumentTitle(`相册 · ${BRAND}`);
  const library = useLibrary("photos");
  useThumbnailPolling(library.items, !library.loading, library.setItems, () => undefined);
  const open = usePreviewOpener(library.items);
  const groups = useMemo(() => groupBy(library.items, photoMonth), [library.items]);
  return <div className="library-view">
    <PageHeader title="相册" description="所有文件夹里的照片和视频，按拍摄时间排列（照片读取 EXIF；没有拍摄时间时按修改时间）。" />
    <LibraryState loading={library.loading} error={library.error} onRetry={library.reload}
      empty={!library.items.length ? <EmptyState icon="image" title="还没有照片或视频" description="上传的照片和视频会按拍摄时间出现在这里。" /> : null}>
      {groups.map(group => <section key={group.label} className="library-group">
        <h2 className="library-group-title">{group.label}<span>{group.items.length} 项</span></h2>
        <div className="photo-grid">
          {group.items.map(item => {
            const kind = getFileKind(item.content_type, item.key);
            return <button key={item.key} type="button" className="photo-tile" title={baseName(item.key)} onClick={() => open(item)}>
              <FileThumbnail kind={kind} url={api.fileThumbnail(item, "grid")} placeholder={api.fileThumbnail(item)} />
              {kind === "video" && item.media?.duration ? <span className="photo-tile-duration">{clock(item.media.duration)}</span> : null}
            </button>;
          })}
        </div>
      </section>)}
      <LoadMore active={library.hasMore} loading={library.loadingMore} onMore={library.more} />
    </LibraryState>
  </div>;
}

/* ---------- 音乐 ---------- */

type Album = { id: string; title: string; artist: string; year?: string; tracks: api.LibraryItem[] };

const trackNumber = (item: api.FileItem) => parseInt(item.media?.track ?? "", 10) || Number.MAX_SAFE_INTEGER;
const trackTitle = (item: api.FileItem) => item.media?.title || baseName(item.key).replace(/\.[^.]+$/, "");
const collator = new Intl.Collator("zh-CN", { numeric: true });

/** 按专辑分组：同名专辑按专辑艺人（没有时取艺人）区分；没有专辑标签的按所在文件夹归为一组。 */
function albumsOf(items: api.LibraryItem[]): Album[] {
  const albums = new Map<string, Album>();
  for (const item of items) {
    const tags = item.media ?? {}, folder = parentPath(item.key);
    const title = tags.album || (folder ? baseName(folder.replace(/\/$/, "")) : "我的文件");
    const owner = tags.album ? tags.album_artist || tags.artist || "" : "";
    const id = tags.album ? `${title}\u0001${owner}` : `\u0002${folder}`;
    const album = albums.get(id) ?? { id, title, artist: owner, year: tags.year, tracks: [] };
    album.tracks.push(item);
    albums.set(id, album);
  }
  for (const album of albums.values()) {
    album.tracks.sort((a, b) => trackNumber(a) - trackNumber(b) || collator.compare(a.key, b.key));
    const artists = new Set(album.tracks.map(track => track.media?.artist).filter(Boolean));
    if (!album.artist) album.artist = artists.size === 1 ? [...artists][0]! : artists.size > 1 ? "多位艺人" : "";
  }
  return [...albums.values()].sort((a, b) => collator.compare(a.title, b.title));
}

function AlbumCover({ album, size = "md" }: { album: Album; size?: "md" | "lg" }) {
  const cover = album.tracks.find(track => api.fileThumbnail(track));
  return <span className={`album-cover album-cover-${size}`} style={{ "--cover-tint": coverTint(album.title) } as CSSProperties}>
    {cover ? <FileThumbnail kind="audio" url={api.fileThumbnail(cover, "grid")} placeholder={api.fileThumbnail(cover)} />
      : <span className="tint-cover"><Icon name="music" size={size === "lg" ? 40 : 28} /></span>}
  </span>;
}

export function MusicView({ album: albumId, onOpenAlbum }: { album: string; onOpenAlbum: (id: string) => void }) {
  const library = useLibrary("music");
  const albums = useMemo(() => albumsOf(library.items), [library.items]);
  const open = usePreviewOpener(library.items);
  const current = albums.find(album => album.id === albumId) ?? null;
  useDocumentTitle(`${current ? current.title : "音乐"} · ${BRAND}`);
  // 还没有标签记录的歌曲（例如升级前上传、从未播放过）：进入音乐库时在后台补读一部分，读到后原地更新。
  const { setItems } = library;
  const filling = useRef(new Set<string>());
  useEffect(() => {
    const missing = library.items.filter(item => !item.media && !filling.current.has(item.key)).slice(0, TAG_FILL);
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
  }, [library.items.length, setItems]);
  if (current) {
    const total = current.tracks.reduce((sum, track) => sum + (track.media?.duration ?? 0), 0);
    return <div className="library-view">
      <button type="button" className="library-back" onClick={() => onOpenAlbum("")}><Icon name="chevronLeft" size={16} />音乐</button>
      <header className="album-header">
        <AlbumCover album={current} size="lg" />
        <div className="album-header-text">
          <span className="album-header-kind">专辑</span>
          <h1>{current.title}</h1>
          <p>{[current.artist, current.year, `${current.tracks.length} 首`, total ? clock(total) : null].filter(Boolean).join(" · ")}</p>
          <div className="album-header-actions">
            <Button variant="primary" icon="play" onClick={() => open(current.tracks[0], current.tracks)}>播放</Button>
          </div>
        </div>
      </header>
      <ol className="track-list">
        {current.tracks.map((track, index) => <li key={track.key}>
          <button type="button" className="track-row" onClick={() => open(track, current.tracks)}>
            <span className="track-number">{Number.isFinite(trackNumber(track)) && trackNumber(track) < Number.MAX_SAFE_INTEGER ? trackNumber(track) : index + 1}</span>
            <span className="track-text"><strong>{trackTitle(track)}</strong><span>{track.media?.artist ?? baseName(track.key)}</span></span>
            <span className="track-duration">{clock(track.media?.duration)}</span>
          </button>
        </li>)}
      </ol>
    </div>;
  }
  return <div className="library-view">
    <PageHeader title="音乐" description={library.items.length ? `${albums.length} 张专辑 · ${library.items.length} 首歌曲。按歌曲标签里的专辑分组，没有专辑标签的按所在文件夹归类。` : "所有文件夹里的音乐，按专辑浏览。"}
      actions={library.items.length ? <Button variant="primary" icon="play" onClick={() => {
        const tracks = albums.flatMap(album => album.tracks);
        open(tracks[0], tracks);
      }}>全部播放</Button> : undefined} />
    <LibraryState loading={library.loading} error={library.error} onRetry={library.reload}
      empty={!library.items.length ? <EmptyState icon="music" title="还没有音乐" description="上传的音乐会按专辑出现在这里。" /> : null}>
      <div className="album-grid">
        {albums.map(album => <button key={album.id} type="button" className="album-card" onClick={() => onOpenAlbum(album.id)}>
          <AlbumCover album={album} />
          <strong>{album.title}</strong>
          <span>{[album.artist, `${album.tracks.length} 首`].filter(Boolean).join(" · ")}</span>
        </button>)}
      </div>
    </LibraryState>
  </div>;
}
