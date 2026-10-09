import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import { FileTile, baseName } from "../files";
import { useCursorPage } from "../pagination";
import { Button, Field, Icon, IconButton, Pagination, SkeletonRows } from "../ui";

/** 上传、新建与移动共用的位置浏览器；每次只读取当前目录的一页子目录。 */
export function FolderPicker({ value, onChange, blocked, onReady }: {
  value: string; onChange: (value: string) => void; blocked?: (path: string) => boolean; onReady?: (ready: boolean) => void;
}) {
  const fetchPage = useCallback((cursor: string | null) => api.listFolders(value, cursor), [value]);
  const pagination = useCursorPage(fetchPage);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { onReady?.(!pagination.loading && !pagination.error && pagination.page !== null); }, [pagination.loading, pagination.error, pagination.page, onReady]);
  useEffect(() => { setCreating(false); setName(""); setError(""); }, [value]);
  const segments = value.split("/").filter(Boolean);
  const open = (path: string) => { if (path !== value) onChange(path); };
  async function create() {
    const trimmed = name.trim();
    if (!trimmed || /[/\\]/.test(trimmed) || trimmed === "." || trimmed === "..") { setError("名称不能为空、包含斜杠或使用 . 和 .."); return; }
    setBusy(true); setError("");
    try { await api.makeFolder(`${value}${trimmed}`); onChange(`${value}${trimmed}/`); }
    catch (reason) { setError(api.errorMessage(reason, "创建失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  return <div className="move-browser">
    <div className="move-head">
      <nav className="breadcrumbs" aria-label="目标位置">
        <button type="button" onClick={() => open("")} aria-current={!value ? "page" : undefined}><Icon name="home" size={15} />我的文件</button>
        {segments.map((part, index) => <span key={index}><Icon name="chevronRight" size={14} /><button type="button" onClick={() => open(`${segments.slice(0, index + 1).join("/")}/`)} aria-current={index === segments.length - 1 ? "page" : undefined}>{part}</button></span>)}
      </nav>
      {!creating && <Button size="sm" variant="ghost" icon="folderPlus" onClick={() => setCreating(true)}>新建子文件夹</Button>}
    </div>
    <div className="move-list" aria-label="子文件夹">
      {creating && <div className="move-new">
        <Field label="子文件夹名称" htmlFor="picker-folder-name" error={error}>
          <input id="picker-folder-name" className="input" value={name} autoFocus onChange={event => { setName(event.target.value); setError(""); }} onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); void create(); }
            if (event.key === "Escape") { event.stopPropagation(); setCreating(false); }
          }} />
        </Field>
        <Button size="sm" loading={busy} onClick={() => void create()}>创建</Button>
        <IconButton icon="x" size="sm" label="取消新建子文件夹" onClick={() => setCreating(false)} />
      </div>}
      {pagination.loading ? <SkeletonRows rows={3} /> : pagination.error ? <div className="move-error" role="alert"><p>{pagination.error}</p><Button size="sm" onClick={() => void pagination.reload()}>重试</Button></div>
        : pagination.page?.folders.length === 0 ? <p className="move-empty">这里没有子文件夹，可以选择当前位置。</p>
          : pagination.page?.folders.map(path => <button key={path} type="button" className="move-item" disabled={blocked?.(path)} onClick={() => open(path)}>
            <FileTile kind="folder" /><span className="move-name">{baseName(path)}</span><Icon name="chevronRight" size={16} />
          </button>)}
    </div>
    {(pagination.hasPrevious || pagination.hasNext) && <Pagination {...pagination} />}
    <p className="muted folder-destination">已选位置：{value ? `/${value}` : "我的文件"}</p>
  </div>;
}
