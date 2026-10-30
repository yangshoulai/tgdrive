import { useCallback, useEffect, useId, useRef, useState } from "react";
import * as api from "../api";
import { FileTile, baseName } from "../files";
import { useDirectory, mergeFolderPages } from "../pagination";
import { Button, Field, Icon, SkeletonRows } from "../ui";
import { usePrivateAccess } from "./private-session";
import { PrivateUnlockDialog } from "./private-unlock";

/** 上传、新建与移动共用的位置浏览器；自动列完当前目录的全部子目录。 */
export function FolderPicker({ value, onChange, blocked, onReady, allowPrivate = false, creatable = true }: {
  value: string; onChange: (value: string) => void; blocked?: (path: string) => boolean; onReady?: (ready: boolean) => void; allowPrivate?: boolean;
  /** 只选择位置、不应在这里写入时（如助手作用域）关闭新建子文件夹 */
  creatable?: boolean;
}) {
  const id = useId();
  const root = api.isPrivatePath(value) ? api.PRIVATE_PREFIX : "";
  const rootName = root ? "私密空间" : "我的文件";
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => api.listFolders(value, cursor, signal), [value]);
  const pagination = useDirectory(fetchPage, mergeFolderPages);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const returnToCreate = useRef(false);
  useEffect(() => {
    const locked = () => { if (api.isPrivatePath(value)) onChange(""); };
    window.addEventListener("tessera:private-locked", locked);
    return () => window.removeEventListener("tessera:private-locked", locked);
  }, [value, onChange]);
  useEffect(() => {
    if (!creating && returnToCreate.current) {
      document.getElementById(`${id}-create`)?.focus();
      returnToCreate.current = false;
    }
  }, [creating, id]);
  const cancelCreate = () => { returnToCreate.current = true; setCreating(false); setName(""); setError(""); };
  useEffect(() => { onReady?.(!creating && !busy && !pagination.loading && !pagination.loadingMore && !pagination.error && pagination.page !== null); }, [creating, busy, pagination.loading, pagination.loadingMore, pagination.error, pagination.page, onReady]);
  useEffect(() => { setCreating(false); setName(""); setError(""); }, [value]);
  const segments = value.slice(root.length).split("/").filter(Boolean);
  const open = (path: string) => { if (path !== value) onChange(path); };
  async function create() {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) { setError("请输入子文件夹名称"); return; }
    if (/[/\\]/.test(trimmed) || trimmed === "." || trimmed === "..") { setError("名称不能包含斜杠，也不能是 . 或 .."); return; }
    setBusy(true); setError("");
    try { await api.makeFolder(`${value}${trimmed}`); onChange(`${value}${trimmed}/`); }
    catch (reason) { setError(api.errorMessage(reason, "创建失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  return <div className="move-browser">
    {allowPrivate && <PrivateScopeToggle privateRoot={Boolean(root)} onOpen={open} />}
    <div className="move-head">
      <nav className="breadcrumbs" aria-label="目标位置">
        <button type="button" disabled={busy} onClick={() => open(root)} aria-current={value === root ? "page" : undefined}><Icon name={root ? "lock" : "home"} size={15} />{rootName}</button>
        {segments.map((part, index) => <span key={index}><Icon name="chevronRight" size={14} /><button type="button" disabled={busy} onClick={() => open(`${root}${segments.slice(0, index + 1).join("/")}/`)} aria-current={index === segments.length - 1 ? "page" : undefined}>{part}</button></span>)}
      </nav>
      {creatable && !creating && <Button id={`${id}-create`} size="sm" variant="ghost" icon="folderPlus" onClick={() => setCreating(true)}>新建子文件夹</Button>}
    </div>
    <div className="move-list" aria-label="子文件夹">
      {creating && <div className="move-new">
        <Field label="子文件夹名称" htmlFor={`${id}-name`} error={error}>
          <input id={`${id}-name`} className="input" value={name} autoFocus disabled={busy} onChange={event => { setName(event.target.value); setError(""); }} onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); void create(); }
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) cancelCreate(); }
          }} />
        </Field>
        <div className="move-new-actions">
          <Button variant="ghost" disabled={busy} aria-label="取消新建子文件夹" onClick={cancelCreate}>取消</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void create()}>创建并进入</Button>
        </div>
      </div>}
      {pagination.loading ? <SkeletonRows rows={3} /> : pagination.error ? <div className="move-error" role="alert"><p>{pagination.error}</p><Button size="sm" onClick={() => void pagination.reload()}>重试</Button></div>
        : pagination.page?.folders.length === 0 ? <p className="move-empty">这里没有子文件夹，可以选择当前位置。</p>
          : pagination.page?.folders.map(path => <button key={path} type="button" className="move-item" disabled={busy || blocked?.(path)} onClick={() => open(path)}>
            <FileTile kind="folder" /><span className="move-name">{baseName(path)}</span><Icon name="chevronRight" size={16} />
          </button>)}
    </div>
    {pagination.loadingMore && <p className="muted" role="status">正在读取其余文件夹…</p>}
    <p className="muted folder-destination">已选位置：{api.privatePathLabel(value)}</p>
  </div>;
}

/** 「我的文件／私密空间」切换。私密空间未解锁时点击先弹出解锁窗口，解锁后直接进入私密空间根目录。
 *  只在应用外壳（PrivateSessionProvider）内使用，分享页等外部页面不传 allowPrivate。 */
function PrivateScopeToggle({ privateRoot, onOpen }: { privateRoot: boolean; onOpen: (path: string) => void }) {
  const access = usePrivateAccess();
  const [unlocking, setUnlocking] = useState(false);
  if (!access.available) return null;
  return <div className="move-scope-toggle" role="group" aria-label="目标空间">
    <button type="button" className={!privateRoot ? "is-active" : ""} aria-pressed={!privateRoot} onClick={() => onOpen("")}><Icon name="home" size={15} />我的文件</button>
    <button type="button" className={privateRoot ? "is-active" : ""} aria-pressed={privateRoot} onClick={() => { if (access.grant) onOpen(api.PRIVATE_PREFIX); else setUnlocking(true); }}>
      <Icon name={access.grant ? "unlock" : "lock"} size={15} />私密空间</button>
    {!access.grant && <span className="muted">点击后解锁</span>}
    {unlocking && <PrivateUnlockDialog description="解锁后即可选择私密空间中的位置。" onClose={() => setUnlocking(false)}
      onUnlocked={() => { setUnlocking(false); onOpen(api.PRIVATE_PREFIX); }} />}
  </div>;
}

/** 常见任务直接使用当前位置，需要更改时再展开目录浏览器。 */
export function DestinationPicker({ value, onChange, onReady, allowPrivate = false }: { value: string; onChange: (path: string) => void; onReady: (ready: boolean) => void; allowPrivate?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [ready, setReady] = useState(true);
  const id = useId();
  useEffect(() => { if (!expanded) onReady(true); }, [expanded, onReady]);
  return <div className="destination-picker">
    <div className="destination-summary">
      <Icon name="folder" size={19} />
      <div><span className="field-label">目标位置</span><strong title={api.privatePathLabel(value)}>{api.privatePathLabel(value)}</strong></div>
      <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={`${id}-browser`} disabled={expanded && !ready} onClick={() => setExpanded(current => !current)}>{expanded ? "收起" : "更改位置"}</Button>
    </div>
    {expanded && <div id={`${id}-browser`} className="destination-browser"><FolderPicker value={value} onChange={onChange} allowPrivate={allowPrivate} onReady={next => { setReady(next); onReady(next); }} /></div>}
  </div>;
}
