import { useCallback, useEffect, useId, useRef, useState } from "react";
import * as api from "../api";
import { FileTile, baseName } from "../files";
import { useCursorPage } from "../pagination";
import { Button, Field, Icon, Pagination, SkeletonRows } from "../ui";

/** 上传、新建与移动共用的位置浏览器；每次只读取当前目录的一页子目录。 */
export function FolderPicker({ value, onChange, blocked, onReady }: {
  value: string; onChange: (value: string) => void; blocked?: (path: string) => boolean; onReady?: (ready: boolean) => void;
}) {
  const id = useId();
  const fetchPage = useCallback((cursor: string | null) => api.listFolders(value, cursor), [value]);
  const pagination = useCursorPage(fetchPage);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const returnToCreate = useRef(false);
  useEffect(() => {
    if (!creating && returnToCreate.current) {
      document.getElementById(`${id}-create`)?.focus();
      returnToCreate.current = false;
    }
  }, [creating, id]);
  const cancelCreate = () => { returnToCreate.current = true; setCreating(false); setName(""); setError(""); };
  useEffect(() => { onReady?.(!creating && !busy && !pagination.loading && !pagination.error && pagination.page !== null); }, [creating, busy, pagination.loading, pagination.error, pagination.page, onReady]);
  useEffect(() => { setCreating(false); setName(""); setError(""); }, [value]);
  const segments = value.split("/").filter(Boolean);
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
    <div className="move-head">
      <nav className="breadcrumbs" aria-label="目标位置">
        <button type="button" disabled={busy} onClick={() => open("")} aria-current={!value ? "page" : undefined}><Icon name="home" size={15} />我的文件</button>
        {segments.map((part, index) => <span key={index}><Icon name="chevronRight" size={14} /><button type="button" disabled={busy} onClick={() => open(`${segments.slice(0, index + 1).join("/")}/`)} aria-current={index === segments.length - 1 ? "page" : undefined}>{part}</button></span>)}
      </nav>
      {!creating && <Button id={`${id}-create`} size="sm" variant="ghost" icon="folderPlus" onClick={() => setCreating(true)}>新建子文件夹</Button>}
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
    {(pagination.hasPrevious || pagination.hasNext) && <Pagination {...pagination} />}
    <p className="muted folder-destination">已选位置：{value ? `/${value}` : "我的文件"}</p>
  </div>;
}

/** 常见任务直接使用当前位置，需要更改时再展开目录浏览器。 */
export function DestinationPicker({ value, onChange, onReady }: { value: string; onChange: (path: string) => void; onReady: (ready: boolean) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [ready, setReady] = useState(true);
  const id = useId();
  useEffect(() => { if (!expanded) onReady(true); }, [expanded, onReady]);
  return <div className="destination-picker">
    <div className="destination-summary">
      <Icon name="folder" size={19} />
      <div><span className="field-label">目标位置</span><strong title={value ? `/${value}` : "我的文件"}>{value ? `我的文件 / ${value.replace(/\/$/, "")}` : "我的文件"}</strong></div>
      <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={`${id}-browser`} disabled={expanded && !ready} onClick={() => setExpanded(current => !current)}>{expanded ? "收起" : "更改位置"}</Button>
    </div>
    {expanded && <div id={`${id}-browser`} className="destination-browser"><FolderPicker value={value} onChange={onChange} onReady={next => { setReady(next); onReady(next); }} /></div>}
  </div>;
}
