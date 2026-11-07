/** 音乐歌单的公共部分：「添加到歌单」（文件页、专辑与歌单的曲目菜单共用）、歌单名称、给歌单挑选歌曲的对话框，
 * 以及每首歌所在歌单的标记（usePlaylistMembership）。
 * 歌单页本身在 library.tsx（音乐页的「歌单」标签）；这里不导入媒体库，避免循环依赖。 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import * as api from "../api";
import { FileThumbnail, baseName, parentPath } from "../files";
import { coverTint } from "../preview-media";
import { Button, Checkbox, EmptyState, Field, Icon, Modal, SearchInput, SkeletonRows, toast } from "../ui";

/** 歌单有改动（新建、删除、加入、移出）时通知同一页面上的其他部分重新读取所在歌单。 */
const CHANGED = "tessera:playlists-changed";
export const playlistsChanged = () => window.dispatchEvent(new Event(CHANGED));

/** 一组歌曲各在哪些歌单里：歌单名称读一次全部歌单，所在关系按 500 首一批查询；歌单有改动时重新读取。 */
export function usePlaylistMembership(keys: string[]) {
  const [lists, setLists] = useState<api.Playlist[]>([]);
  const [found, setFound] = useState<Record<string, number[]>>({});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRevision(value => value + 1);
    window.addEventListener(CHANGED, changed);
    return () => window.removeEventListener(CHANGED, changed);
  }, []);
  const signature = keys.join("\n");
  useEffect(() => {
    if (!keys.length) { setFound({}); return; }
    let alive = true;
    void (async () => {
      try {
        const [result, ...pages] = await Promise.all([api.playlists(), ...Array.from({ length: Math.ceil(keys.length / 500) },
          (_, index) => api.playlistsContaining(keys.slice(index * 500, index * 500 + 500)))]);
        if (!alive) return;
        setLists(result.playlists);
        setFound(Object.assign({}, ...pages.map(page => page.playlists)));
      } catch { /* 标记只是辅助信息，读取失败时不显示 */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, revision]);
  const byId = useMemo(() => new Map(lists.map(item => [item.id, item])), [lists]);
  return useCallback((key: string) => (found[key] ?? []).flatMap(id => byId.get(id) ?? []), [found, byId]);
}

/** 曲目行上的歌单标记：所在歌单的数量，悬停显示名称。 */
export function PlaylistBadge({ lists, exclude }: { lists: api.Playlist[]; exclude?: number }) {
  const shown = exclude == null ? lists : lists.filter(item => item.id !== exclude);
  if (!shown.length) return null;
  const names = shown.map(item => `「${item.name}」`).join("");
  return <span className="playlist-badge" title={`${exclude == null ? "在歌单" : "也在歌单"}${names}`}
    aria-label={`${exclude == null ? "在" : "也在"} ${shown.length} 个歌单：${shown.map(item => item.name).join("、")}`}>
    <Icon name="playlist" size={13} />{shown.length === 1 ? shown[0].name : `${shown.length} 个歌单`}
  </span>;
}

/** 新建或重命名歌单。 */
export function PlaylistNameDialog({ title, confirm, initial = "", onClose, onSubmit }: {
  title: string; confirm: string; initial?: string; onClose: () => void; onSubmit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!value.trim()) { setError("请填写歌单名称"); return; }
    setBusy(true);
    try { await onSubmit(value.trim()); }
    catch (reason) { setError(api.errorMessage(reason, "保存失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  return <Modal title={title} size="sm" onClose={onClose} dismissible={!busy}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="playlist-name-form" loading={busy} disabled={!value.trim()}>{confirm}</Button></>}>
    <form id="playlist-name-form" className="form" onSubmit={submit} noValidate>
      <Field label="歌单名称" htmlFor="playlist-name" error={error}>
        <input id="playlist-name" className="input" value={value} maxLength={80} autoFocus placeholder="例如：通勤路上"
          onChange={event => { setValue(event.target.value); setError(""); }} />
      </Field>
    </form>
  </Modal>;
}

/** 把一首或几首歌加入歌单：列出全部歌单（标出已包含这些歌曲的），也可以直接新建一个并加入。 */
export function AddToPlaylistDialog({ files, onClose, onAdded }: { files: api.FileItem[]; onClose: () => void; onAdded?: (playlist: api.PlaylistInfo) => void }) {
  const [lists, setLists] = useState<api.Playlist[] | null>(null);
  const [containing, setContaining] = useState<Record<string, number[]>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | "new" | null>(null);
  const [creating, setCreating] = useState(false);
  const paths = files.map(file => file.key);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.playlists(controller.signal), api.playlistsContaining(paths.slice(0, 500))]).then(([result, found]) => {
      setLists(result.playlists); setContaining(found.playlists);
    }, reason => { if (!controller.signal.aborted) setError(api.errorMessage(reason, "歌单读取失败，请稍后重试")); });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const label = files.length === 1 ? `「${files[0].media?.title || baseName(files[0].key)}」` : `${files.length} 首歌曲`;
  const done = (playlist: api.PlaylistInfo, added: number) => {
    toast.success(added ? `已把${label}加入「${playlist.name}」` : `${label}已在「${playlist.name}」里`);
    playlistsChanged(); onAdded?.(playlist); onClose();
  };
  async function add(playlist: api.Playlist) {
    setBusy(playlist.id);
    try { const result = await api.updatePlaylist(playlist.id, { add: paths }); done(result, result.added ?? 0); }
    catch (reason) { toast.error(api.errorMessage(reason, "添加失败，请稍后重试")); }
    finally { setBusy(null); }
  }
  if (creating) return <PlaylistNameDialog title="新建歌单" confirm="创建并加入" onClose={() => setCreating(false)}
    onSubmit={async name => { const playlist = await api.createPlaylist(name, paths); done(playlist, paths.length); }} />;
  let body: ReactNode;
  if (error) body = <EmptyState icon="alert" title="歌单读取失败" description={error} />;
  else if (!lists) body = <SkeletonRows rows={3} />;
  else if (!lists.length) body = <EmptyState icon="playlist" title="还没有歌单" description="新建一个歌单，把喜欢的歌曲放在一起播放。"
    action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>新建歌单</Button>} />;
  else body = <ul className="playlist-picker">
    {lists.map(playlist => {
      const has = paths.length > 0 && paths.every(path => containing[path]?.includes(playlist.id));
      return <li key={playlist.id}>
        <button type="button" className="playlist-picker-row" disabled={busy !== null} onClick={() => void add(playlist)}>
          <span className="playlist-picker-icon"><Icon name="playlist" size={18} /></span>
          <span className="playlist-picker-text"><strong>{playlist.name}</strong><span>{playlist.count} 首</span></span>
          {busy === playlist.id ? <span className="spinner" aria-hidden="true" /> : has ? <span className="playlist-picker-has"><Icon name="check" size={14} />已添加</span> : null}
        </button>
      </li>;
    })}
  </ul>;
  return <Modal title="添加到歌单" description={`把${label}加入歌单，已在歌单里的歌曲不会重复添加。`} size="sm" onClose={onClose}
    footer={lists?.length ? <><Button icon="plus" onClick={() => setCreating(true)}>新建歌单</Button><Button onClick={onClose}>关闭</Button></> : <Button onClick={onClose}>关闭</Button>}>
    {body}
  </Modal>;
}

/** 在任意页面打开「添加到歌单」：open(files) 弹出对话框，dialog 放进页面里渲染。 */
export function useAddToPlaylist(onAdded?: (playlist: api.PlaylistInfo) => void) {
  const [files, setFiles] = useState<api.FileItem[] | null>(null);
  return {
    open: (items: api.FileItem[]) => { if (items.length) setFiles(items); },
    dialog: files ? <AddToPlaylistDialog files={files} onClose={() => setFiles(null)} onAdded={onAdded} /> : null,
  };
}

const clock = (seconds?: number) => seconds ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "";

/** 给歌单挑选歌曲：在全部音乐里按歌名、艺人、专辑或文件名搜索，勾选多首后一次加入；已在这个歌单里的歌曲标出且不能再选。 */
export function SongPickerDialog({ playlist, existing, onClose, onAdded }: {
  playlist: api.PlaylistInfo; existing: Set<string>; onClose: () => void; onAdded: (added: number) => void;
}) {
  const [text, setText] = useState(""), [query, setQuery] = useState("");
  const [items, setItems] = useState<api.LibraryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Map<string, api.LibraryItem>>(new Map());
  const [busy, setBusy] = useState(false);
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => { const timer = window.setTimeout(() => setQuery(text.trim()), 300); return () => window.clearTimeout(timer); }, [text]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    api.library("music", { q: query, limit: 200 }, controller.signal).then(page => { setItems(page.objects); setCursor(page.next_cursor); setLoading(false); },
      reason => { if (!controller.signal.aborted) { setError(api.errorMessage(reason, "读取音乐失败，请稍后重试")); setLoading(false); } });
    return () => controller.abort();
  }, [query]);
  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    api.library("music", { q: query, limit: 200, cursor }).then(page => { setItems(list => list.concat(page.objects)); setCursor(page.next_cursor); },
      () => undefined).finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, query]);
  useEffect(() => {
    if (!cursor || !more.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadMore(); }, { rootMargin: "200px" });
    observer.observe(more.current);
    return () => observer.disconnect();
  }, [cursor, loadMore]);
  const choosable = items.filter(item => !existing.has(item.key));
  const allPicked = choosable.length > 0 && choosable.every(item => picked.has(item.key));
  const toggle = (item: api.LibraryItem, value: boolean) => setPicked(current => {
    const next = new Map(current);
    if (value) next.set(item.key, item); else next.delete(item.key);
    return next;
  });
  async function submit() {
    if (!picked.size) return;
    setBusy(true);
    try {
      const result = await api.updatePlaylist(playlist.id, { add: [...picked.keys()] });
      toast.success(`已把 ${result.added ?? picked.size} 首歌加入「${playlist.name}」`);
      playlistsChanged(); onAdded(result.added ?? 0); onClose();
    } catch (reason) { toast.error(api.errorMessage(reason, "添加失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  return <Modal title={`添加歌曲到「${playlist.name}」`} size="lg" onClose={onClose} dismissible={!busy} className="song-picker"
    footer={<><span className="song-picker-count">{picked.size ? `已选 ${picked.size} 首` : "勾选要加入的歌曲"}</span>
      <Button disabled={busy} onClick={onClose}>取消</Button>
      <Button variant="primary" icon="plus" loading={busy} disabled={!picked.size} onClick={() => void submit()}>加入歌单</Button></>}>
    <div className="song-picker-toolbar">
      <SearchInput value={text} onChange={setText} onSubmit={() => setQuery(text.trim())} onClear={() => setQuery("")} placeholder="搜索歌名、艺人、专辑或文件名" label="搜索音乐" />
      {choosable.length > 0 && <label className="song-picker-all"><Checkbox label="选择列表中的全部歌曲" checked={allPicked} indeterminate={!allPicked && choosable.some(item => picked.has(item.key))}
        onChange={value => setPicked(current => { const next = new Map(current); for (const item of choosable) { if (value) next.set(item.key, item); else next.delete(item.key); } return next; })} />全选</label>}
    </div>
    {error ? <EmptyState icon="alert" title="读取失败" description={error} /> : loading ? <SkeletonRows rows={6} />
      : !items.length ? <EmptyState icon="music" title={query ? "没有找到歌曲" : "还没有音乐"} description={query ? `没有与「${query}」匹配的歌曲。` : "上传的音乐会出现在这里。"} />
      : <ul className="song-picker-list">
        {items.map(item => {
          const already = existing.has(item.key), checked = already || picked.has(item.key);
          const thumb = api.fileThumbnail(item);
          return <li key={item.key}>
            <label className={`song-picker-row${already ? " is-disabled" : ""}`}>
              <input type="checkbox" className="checkbox" checked={checked} disabled={already} onChange={event => toggle(item, event.target.checked)}
                aria-label={`选择 ${item.media?.title || baseName(item.key)}`} />
              <span className="track-cover" style={{ "--cover-tint": coverTint(item.key) } as CSSProperties}>
                {thumb ? <FileThumbnail kind="audio" url={thumb} /> : <span className="tint-cover"><Icon name="music" size={16} /></span>}
              </span>
              <span className="track-text"><strong>{item.media?.title || baseName(item.key).replace(/\.[^.]+$/, "")}</strong>
                <span title={item.key}>{[item.media?.artist, item.media?.album, `/${parentPath(item.key).replace(/\/$/, "")}`].filter(Boolean).join(" · ")}</span></span>
              {already ? <span className="playlist-picker-has"><Icon name="check" size={14} />已在歌单</span> : <span className="track-duration">{clock(item.media?.duration)}</span>}
            </label>
          </li>;
        })}
        {cursor && <div ref={more} className="library-more">{loadingMore ? <><span className="spinner" aria-hidden="true" />正在加载</> : null}</div>}
      </ul>}
  </Modal>;
}
