/** 音乐歌单的公共对话框：「添加到歌单」（文件页、专辑与歌单的曲目菜单共用）与歌单名称。
 * 歌单页本身在 library.tsx（音乐页的「歌单」标签）；这里不导入媒体库，避免循环依赖。 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import * as api from "../api";
import { baseName } from "../files";
import { Button, EmptyState, Field, Icon, Modal, SkeletonRows, toast } from "../ui";

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
    onAdded?.(playlist); onClose();
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
