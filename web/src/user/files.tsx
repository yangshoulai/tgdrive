import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { useCursorPage } from "../pagination";
import { DestinationPicker, FolderPicker } from "./folders";
import { BRAND } from "../brand";
import * as api from "../api";

import { FileThumbnail, FileTile, PreviewModal, ShareDialog, baseName, getFileKind, kindLabel, makeThumbnail, parentPath, thumbnailable } from "../files";

import { Badge, Button, Checkbox, EmptyState, Field, Icon, IconButton, Menu, Modal, PageHeader, Pagination, SearchInput, Segmented, SkeletonRows, copyText, formatBytes, formatDate, formatDateTime, toast, useDocumentTitle, type MenuItem } from "../ui";

import { UploadDialog, type UploadQueue } from "./uploads";

/* ---------- 文件 ---------- */

type Entry = { kind: "folder"; key: string; size?: number } | { kind: "file"; key: string; file: api.FileItem };
type SortKey = "name" | "size" | "modified";

export function FilesView({ session, prefix, onOpenFolder, onChanged, uploads, uploadRevision }: { session: api.Session; prefix: string; onOpenFolder: (prefix: string) => void; onChanged: () => void; uploads: UploadQueue; uploadRevision: number }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "public">("all");
  const [layout, setLayout] = useState<"list" | "grid">(() => (localStorage.getItem("tgdrive:layout") as "list" | "grid") || "list");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<api.FileItem | null>(null);
  const [sharing, setSharing] = useState<api.FileItem | null>(null);
  const [renaming, setRenaming] = useState<Entry | null>(null);
  const [moving, setMoving] = useState<Entry[] | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragKeys = useRef<string[]>([]);
  const [folderOpen, setFolderOpen] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastUploadRevision = useRef(uploadRevision);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const name = prefix ? baseName(prefix) : "我的文件";
  useDocumentTitle(`${query ? `搜索“${query}”` : name} · ${BRAND}`);

  const fetchPage = useCallback((cursor: string | null) => query
    ? api.searchFiles(query, cursor ?? "", filter === "public")
    : api.listFiles(prefix, cursor, filter === "public"), [prefix, query, filter]);
  const pagination = useCursorPage(fetchPage);
  const load = pagination.reload;
  useEffect(() => {
    if (lastUploadRevision.current !== uploadRevision) { lastUploadRevision.current = uploadRevision; void load(); }
  }, [uploadRevision, load]);
  const loading = pagination.loading;
  const loadError = pagination.error;
  const files = useMemo(() => (pagination.page?.objects ?? []).filter(item => !item.key.endsWith("/")), [pagination.page]);
  const folders = pagination.page?.common_prefixes ?? [];
  const publicFolders = pagination.page?.public_folders ?? {};
  const folderSizes = pagination.page?.folder_sizes ?? {};
  const setFiles = (update: (files: api.FileItem[]) => api.FileItem[]) => pagination.setPage(current => current && { ...current, objects: update(current.objects) });
  const setPublicFolders = (update: (items: Record<string, api.FileItem>) => Record<string, api.FileItem>) => pagination.setPage(current => current && { ...current, public_folders: update(current.public_folders ?? {}) });
  useEffect(() => { setSelected(new Set()); }, [fetchPage, pagination.number]);
  useEffect(() => { setSearch(""); setQuery(""); }, [prefix]);
  useEffect(() => { localStorage.setItem("tgdrive:layout", layout); }, [layout]);

  const entries = useMemo<Entry[]>(() => {
    const direction = sort.desc ? -1 : 1;
    const fileEntries = files
      .filter(file => filter === "all" || file.public_token)
      .sort((a, b) => direction * (sort.key === "size" ? a.size - b.size : sort.key === "modified" ? a.modified_at - b.modified_at : baseName(a.key).localeCompare(baseName(b.key), "zh-CN", { numeric: true })))
      .map(file => ({ kind: "file" as const, key: file.key, file }));
    const folderEntries = [...folders].filter(key => filter === "all" || publicFolders[key])
      .sort((a, b) => sort.key === "size"
        ? direction * ((folderSizes[a] ?? 0) - (folderSizes[b] ?? 0)) || a.localeCompare(b, "zh-CN", { numeric: true })
        : (sort.key === "name" ? direction : 1) * a.localeCompare(b, "zh-CN", { numeric: true }))
      .map(key => ({ kind: "folder" as const, key, size: folderSizes[key] }));
    return [...folderEntries, ...fileEntries];
  }, [files, folders, publicFolders, folderSizes, filter, sort]);
  /** 文件夹的分享信息保存在它的目录标记上；还没公开过的文件夹用一个占位对象打开分享对话框。 */
  const folderItem = (key: string): api.FileItem => publicFolders[key] ?? { key, size: 0, etag: "", content_type: "application/x-directory", modified_at: 0 };
  const selectedEntries = entries.filter(entry => selected.has(entry.key));
  const selectedFiles = selectedEntries.filter((entry): entry is Extract<Entry, { kind: "file" }> => entry.kind === "file");

  function toggleSelect(key: string, value: boolean) {
    setSelected(current => { const next = new Set(current); if (value) next.add(key); else next.delete(key); return next; });
  }
  function replaceFile(updated: api.FileItem) {
    if (updated.key.endsWith("/")) {
      setPublicFolders(current => {
        const next = { ...current };
        if (updated.public_token) next[updated.key] = updated; else delete next[updated.key];
        return next;
      });
      setSharing(current => current && current.key === updated.key ? { ...current, ...updated } : current);
      return;
    }
    setFiles(current => current.map(item => item.key === updated.key ? { ...item, ...updated } : item));
    setSharing(current => current && current.key === updated.key ? { ...current, ...updated } : current);
    setPreview(current => current && current.key === updated.key ? { ...current, ...updated } : current);
  }
  async function bulkPublic(isPublic: boolean) {
    try {
      const result = await api.setPublic(selectedFiles.map(entry => entry.key), isPublic);
      result.objects.forEach(replaceFile);
      toast.success(isPublic ? `已公开 ${result.objects.length} 个文件` : `已取消公开 ${result.objects.length} 个文件`);
      setSelected(new Set()); onChanged();
    } catch (reason) { toast.error(api.errorMessage(reason, "更新分享设置失败，请稍后重试")); }
  }
  /** 删除即移到回收站（可恢复），因此不弹确认框，而是在提示中提供撤销。 */
  async function moveToTrash(targets: Entry[]) {
    try {
      const { items } = await api.moveToTrash(targets.map(target => target.key));
      setSelected(new Set());
      await load(); onChanged();
      toast.success(targets.length === 1 ? `已将“${baseName(targets[0].key)}”移到回收站` : `已将 ${targets.length} 项移到回收站`, {
        label: "撤销",
        onClick: () => void api.restoreTrash(items.map(item => item.id))
          .then(() => { toast.success("已撤销删除"); return load(); }).then(onChanged)
          .catch(reason => toast.error(api.errorMessage(reason, "撤销失败，请稍后重试"))),
      });
    } catch (reason) { toast.error(api.errorMessage(reason, "删除失败，请稍后重试")); }
  }
  function startUpload(list: FileList | File[] | null) {
    const picked = Array.from(list ?? []);
    if (picked.length) setPendingUpload(picked);
  }
  /** 逐项移动；文件夹连同内容一起移动，公开链接随文件保留。 */
  async function moveEntries(targets: Entry[], dest: string, conflict: api.MoveConflict = "rename") {
    const items = targets.filter(target => canMoveInto(target, dest));
    if (!items.length) { toast.info("所选项目已经在这个文件夹中"); return; }
    const destName = dest ? baseName(dest) : "我的文件";
    let movedItems = 0, skippedFiles = 0;
    const failures: string[] = [];
    for (const target of items) {
      try {
        const result = await api.moveFile(target.key, `${dest}${baseName(target.key)}${target.kind === "folder" ? "/" : ""}`, conflict);
        if (result.moved > 0) movedItems++;
        skippedFiles += result.skipped;
      } catch (reason) { failures.push(`${baseName(target.key)}：${api.errorMessage(reason, "移动失败，请稍后重试")}`); }
    }
    if (movedItems) toast.success(`已将 ${movedItems} 项移动到“${destName}”${skippedFiles ? `，${skippedFiles} 个同名文件已跳过` : ""}`);
    else if (skippedFiles) toast.error(`“${destName}”中已有同名文件，未移动任何项目`);
    if (failures.length) toast.error(failures.length === 1 ? failures[0] : `${failures.length} 项移动失败：${failures[0]}`);
    setSelected(new Set());
    await load();
  }
  function dragProps(entry: Entry) {
    return {
      draggable: true,
      onDragStart: (event: DragEvent) => {
        const keys = selected.has(entry.key) ? selectedEntries.map(item => item.key) : [entry.key];
        dragKeys.current = keys;
        event.dataTransfer.setData(INTERNAL_DRAG, JSON.stringify(keys));
        event.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => { dragKeys.current = []; setDropTarget(null); },
    };
  }
  /** 文件夹行、网格卡片和面包屑都可以作为拖放目标。 */
  function dropProps(dest: string) {
    const valid = () => {
      const dragged = entries.filter(entry => dragKeys.current.includes(entry.key));
      return dragged.length > 0 && dragged.some(entry => canMoveInto(entry, dest));
    };
    return {
      onDragOver: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes(INTERNAL_DRAG) || !valid()) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dropTarget !== dest) setDropTarget(dest);
      },
      onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(current => current === dest ? null : current); },
      onDrop: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes(INTERNAL_DRAG)) return;
        event.preventDefault(); event.stopPropagation();
        setDropTarget(null);
        const keys: string[] = JSON.parse(event.dataTransfer.getData(INTERNAL_DRAG) || "[]");
        void moveEntries(entries.filter(entry => keys.includes(entry.key)), dest);
      },
    };
  }
  const dropClass = (dest: string) => dropTarget === dest ? " is-drop-target" : "";
  function fileMenu(file: api.FileItem): MenuItem[] {
    const entry: Entry = { kind: "file", key: file.key, file };
    const items: MenuItem[] = [
      { label: "下载", icon: "download", onSelect: () => undefined, href: api.contentUrl(file.key, true) },
      { label: file.public_token ? "管理分享" : "公开分享", icon: "link", onSelect: () => setSharing(file) },
    ];
    if (file.public_token) items.push({ label: "复制分享链接", icon: "copy", onSelect: () => void copyText(api.publicLinks(file.public_token!, baseName(file.key), session.public_base_url).page, "分享链接已复制") });
    items.push({ label: "重命名", icon: "edit", onSelect: () => setRenaming(entry) });
    items.push({ label: "移动到…", icon: "move", onSelect: () => setMoving([entry]) });
    if (query) items.push({ label: "打开所在文件夹", icon: "folder", onSelect: () => onOpenFolder(parentPath(file.key)) });
    items.push({ label: "删除", icon: "trash", danger: true, divider: true, onSelect: () => void moveToTrash([entry]) });
    return items;
  }
  function folderMenu(key: string): MenuItem[] {
    const shared = publicFolders[key];
    return [
      { label: "打开", icon: "folder", onSelect: () => onOpenFolder(key) },
      { label: shared ? "管理分享" : "公开分享", icon: "link", onSelect: () => setSharing(folderItem(key)) },
      ...(shared ? [{ label: "复制分享链接", icon: "copy" as const, onSelect: () => void copyText(api.publicLinks(shared.public_token!, baseName(key), session.public_base_url).page, "分享链接已复制") }] : []),
      { label: "重命名", icon: "edit", onSelect: () => setRenaming({ kind: "folder", key }) },
      { label: "移动到…", icon: "move", onSelect: () => setMoving([{ kind: "folder", key }]) },
      { label: "删除", icon: "trash", danger: true, divider: true, onSelect: () => void moveToTrash([{ kind: "folder", key }]) },
    ];
  }
  const crumbs = prefix.split("/").filter(Boolean);
  const allSelected = entries.length > 0 && entries.every(entry => selected.has(entry.key));

  return (
    <div className="files-view"
      onDragEnter={event => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); dragDepth.current++; setDragging(true); }}
      onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); startUpload(event.dataTransfer.files); }}>
      <PageHeader title={query ? `搜索“${query}”` : name}
        actions={<>
          <Button icon="folderPlus" onClick={() => setFolderOpen(true)}>新建文件夹</Button>
          <Button variant="primary" icon="upload" onClick={() => fileInput.current?.click()}>上传</Button>
          <input ref={fileInput} type="file" multiple hidden onChange={event => { startUpload(event.target.files); event.target.value = ""; }} />
        </>}>
        {(prefix || query) && <nav className="breadcrumbs" aria-label="当前位置">
          <button type="button" className={dropClass("")} {...dropProps("")} onClick={() => onOpenFolder("")} aria-current={!prefix && !query ? "page" : undefined}><Icon name="home" size={15} />我的文件</button>
          {crumbs.map((part, index) => (
            <span key={index}><Icon name="chevronRight" size={14} /><button type="button" className={dropClass(`${crumbs.slice(0, index + 1).join("/")}/`)} {...dropProps(`${crumbs.slice(0, index + 1).join("/")}/`)} onClick={() => onOpenFolder(`${crumbs.slice(0, index + 1).join("/")}/`)} aria-current={index === crumbs.length - 1 && !query ? "page" : undefined}>{part}</button></span>
          ))}
          {query && <span><Icon name="chevronRight" size={14} /><span className="crumb-current">搜索结果</span></span>}
        </nav>}
      </PageHeader>

      {selected.size > 0 ? (
        <div className="toolbar selection-bar" role="toolbar" aria-label="批量操作">
          <span className="selection-count">已选择 {selected.size} 项</span>
          <div className="toolbar-actions">
            {selectedFiles.length > 0 && <Button size="sm" icon="globe" onClick={() => void bulkPublic(true)}>公开</Button>}
            {selectedFiles.some(entry => entry.file.public_token) && <Button size="sm" icon="lock" onClick={() => void bulkPublic(false)}>取消公开</Button>}
            <Button size="sm" icon="move" onClick={() => setMoving(selectedEntries)}>移动</Button>
            <Button size="sm" variant="danger" icon="trash" onClick={() => void moveToTrash(selectedEntries)}>删除</Button>
            <IconButton icon="x" label="取消选择" size="sm" onClick={() => setSelected(new Set())} />
          </div>
        </div>
      ) : (
        <div className="toolbar">
          <SearchInput value={search} onChange={setSearch} onSubmit={() => setQuery(search.trim())} onClear={() => setQuery("")} placeholder="搜索全部文件，按回车" label="搜索文件" />
          <div className="toolbar-actions">
            <Segmented label="筛选" value={filter} onChange={setFilter} options={[{ value: "all", label: "全部" }, { value: "public", label: "公开" }]} />
            <label className="mobile-file-sort"><span className="sr-only">本页排序</span><select aria-label="本页排序" value={`${sort.key}:${sort.desc ? "desc" : "asc"}`} onChange={event => {
              const [key, direction] = event.target.value.split(":"); setSort({ key: key as SortKey, desc: direction === "desc" });
            }}><option value="name:asc">名称升序</option><option value="name:desc">名称降序</option><option value="size:desc">容量从大到小</option><option value="size:asc">容量从小到大</option><option value="modified:desc">最近修改优先</option><option value="modified:asc">最早修改优先</option></select></label>
            <Segmented label="视图" value={layout} onChange={setLayout} options={[{ value: "list", label: "列表视图", icon: "list" }, { value: "grid", label: "网格视图", icon: "gridView" }]} />
          </div>
        </div>
      )}

      <section className={`file-surface${dragging ? " is-dragging" : ""}`} aria-label="文件列表">
        {loading ? <SkeletonRows rows={6} /> : loadError ? (
          <EmptyState icon="alert" title="文件列表加载失败" description={loadError} action={<Button icon="refresh" onClick={() => void load()}>重试</Button>} />
        ) : entries.length === 0 ? (
          query ? <EmptyState icon="search" title={`没有找到包含“${query}”的文件`} description="换个关键词，或检查拼写。" action={<Button onClick={() => { setSearch(""); setQuery(""); }}>清除搜索</Button>} />
            : filter === "public" ? <EmptyState icon="globe" title="这个文件夹里没有公开内容" description="在文件或文件夹的菜单中选择“公开分享”，即可生成任何人可访问的链接。" />
              : <EmptyState icon="upload" title={prefix ? "这个文件夹是空的" : "上传你的第一个文件"} description="把文件拖到这里，或点击上传按钮。" action={<Button variant="primary" icon="upload" onClick={() => fileInput.current?.click()}>上传文件</Button>} />
        ) : layout === "list" ? (
          <div className="data-table file-table" role="table" aria-label="文件">
            <div className="data-row data-head" role="row">
              <span role="columnheader" className="cell-check"><Checkbox label="全选本页" checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={value => setSelected(value ? new Set(entries.map(entry => entry.key)) : new Set())} /></span>
              <SortHeader label="名称" column="name" sort={sort} onSort={setSort} className="cell-name" />
              <span role="columnheader" className="cell-type">类型</span>
              <SortHeader label="大小" column="size" sort={sort} onSort={setSort} className="cell-size" />
              <SortHeader label="修改时间" column="modified" sort={sort} onSort={setSort} className="cell-date" />
              <span role="columnheader" className="cell-actions"><span className="sr-only">操作</span></span>
            </div>
            {entries.map(entry => entry.kind === "folder" ? (
              <div key={entry.key} role="row" className={`data-row is-clickable${selected.has(entry.key) ? " is-selected" : ""}${dropClass(entry.key)}`} {...dragProps(entry)} {...dropProps(entry.key)} onClick={() => onOpenFolder(entry.key)}>
                <span role="cell" className="cell-check"><Checkbox label={`选择 ${baseName(entry.key)}`} checked={selected.has(entry.key)} onChange={value => toggleSelect(entry.key, value)} /></span>
                <span role="cell" className="cell-name"><FileTile kind="folder" /><span className="name-stack"><button type="button" className="name-button" title={baseName(entry.key)} onClick={event => { event.stopPropagation(); onOpenFolder(entry.key); }}>{baseName(entry.key)}</button>
                  <span className="file-mobile-meta"><span>文件夹 · {entry.size == null ? "—" : formatBytes(entry.size)}</span>{publicFolders[entry.key] && <Badge tone="public" icon="globe">公开</Badge>}</span></span>
                  {publicFolders[entry.key] && <Badge tone="public" icon="globe">公开</Badge>}</span>
                <span role="cell" className="cell-type muted">文件夹</span>
                <span role="cell" className="cell-size muted" title="包含所有子文件夹中的文件">{entry.size == null ? "—" : formatBytes(entry.size)}</span>
                <span role="cell" className="cell-date muted">—</span>
                <span role="cell" className="cell-actions" onClick={event => event.stopPropagation()}>
                  <span className="row-quick"><IconButton icon="link" size="sm" label={`分享 ${baseName(entry.key)}`} onClick={() => setSharing(folderItem(entry.key))} /></span>
                  <Menu label={`${baseName(entry.key)} 的更多操作`} items={folderMenu(entry.key)} />
                </span>
              </div>
            ) : (
              <div key={entry.key} role="row" className={`data-row is-clickable${selected.has(entry.key) ? " is-selected" : ""}`} {...dragProps(entry)} onClick={() => setPreview(entry.file)}>
                <span role="cell" className="cell-check"><Checkbox label={`选择 ${baseName(entry.key)}`} checked={selected.has(entry.key)} onChange={value => toggleSelect(entry.key, value)} /></span>
                <span role="cell" className="cell-name">
                  <FileTile kind={getFileKind(entry.file.content_type, entry.key)} />
                  <span className="name-stack">
                    <button type="button" className="name-button" title={baseName(entry.key)} onClick={event => { event.stopPropagation(); setPreview(entry.file); }}>{baseName(entry.key)}</button>
                    <span className="file-mobile-meta"><span>{kindLabel(getFileKind(entry.file.content_type, entry.key))} · {formatBytes(entry.file.size)} · {formatDate(entry.file.modified_at)}</span>{entry.file.public_token && <Badge tone="public" icon="globe">公开</Badge>}</span>
                    {query && parentPath(entry.key) && <small>{parentPath(entry.key)}</small>}
                  </span>
                  {entry.file.public_token && <Badge tone="public" icon="globe">公开</Badge>}
                </span>
                <span role="cell" className="cell-type muted">{kindLabel(getFileKind(entry.file.content_type, entry.key))}</span>
                <span role="cell" className="cell-size muted">{formatBytes(entry.file.size)}</span>
                <span role="cell" className="cell-date muted" title={formatDateTime(entry.file.modified_at)}>{formatDate(entry.file.modified_at)}</span>
                <span role="cell" className="cell-actions" onClick={event => event.stopPropagation()}>
                  <span className="row-quick"><IconButton icon="link" size="sm" label={`分享 ${baseName(entry.key)}`} onClick={() => setSharing(entry.file)} /></span>
                  <Menu label={`${baseName(entry.key)} 的更多操作`} items={fileMenu(entry.file)} />
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="file-grid">
            {entries.map(entry => {
              const kind = entry.kind === "folder" ? "folder" : getFileKind(entry.file.content_type, entry.key);
              const isSelected = selected.has(entry.key);
              return (
                <div key={entry.key} className={`grid-card${isSelected ? " is-selected" : ""}${entry.kind === "folder" ? dropClass(entry.key) : ""}`} {...dragProps(entry)} {...(entry.kind === "folder" ? dropProps(entry.key) : {})} onClick={() => entry.kind === "folder" ? onOpenFolder(entry.key) : setPreview(entry.file)}>
                  <div className="grid-thumb">
                    {/* 有缩略图用缩略图；小图片直接显示原图；大图片显示类型图标，避免每个卡片下载完整原图。 */}
                    <FileThumbnail kind={kind} url={entry.kind === "file" && entry.file.has_thumbnail ? api.thumbnailUrl(entry.key, entry.file.etag)
                      : kind === "image" && entry.kind === "file" && entry.file.size <= 2 * 1024 * 1024 ? api.contentUrl(entry.key) : undefined} />
                    <span className="grid-check" onClick={event => event.stopPropagation()}><Checkbox label={`选择 ${baseName(entry.key)}`} checked={isSelected} onChange={value => toggleSelect(entry.key, value)} /></span>
                    {(entry.kind === "file" ? entry.file.public_token : publicFolders[entry.key]) && <span className="grid-public"><Badge tone="public" icon="globe">公开</Badge></span>}
                  </div>
                  <div className="grid-meta">
                    {/* 卡片本身只响应鼠标；文件名按钮是键盘与读屏用户的打开入口。 */}
                    <button type="button" className="grid-name name-button" title={baseName(entry.key)}
                      onClick={event => { event.stopPropagation(); if (entry.kind === "folder") onOpenFolder(entry.key); else setPreview(entry.file); }}>
                      {baseName(entry.key)}
                    </button>
                    <span className="grid-sub">{entry.kind === "folder" ? `文件夹 · ${entry.size == null ? "—" : formatBytes(entry.size)}` : `${kindLabel(kind)} · ${formatBytes(entry.file.size)}`}</span>
                    <span className="grid-menu" onClick={event => event.stopPropagation()}><Menu label={`${baseName(entry.key)} 的更多操作`} items={entry.kind === "folder" ? folderMenu(entry.key) : fileMenu(entry.file)} /></span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {dragging && <div className="drop-overlay" aria-hidden="true"><Icon name="upload" size={28} /><strong>松开以上传到“{name}”</strong></div>}
      </section>

      <footer className="list-footer">
        <span>{loading ? "正在加载" : `本页 ${folders.length} 个文件夹，${files.length} 个文件（排序仅作用于本页）`}</span>
        <Pagination {...pagination} />
      </footer>

      {pendingUpload && <UploadDialog files={pendingUpload} destination={prefix} onClose={() => setPendingUpload(null)}
        onStart={(list, isPublic, destination) => { setPendingUpload(null); uploads.enqueue(list.map(file => ({ file, path: `${destination}${file.name}`, isPublic }))); }} />}
      {folderOpen && <NameDialog title="新建文件夹" label="文件夹名称" confirm="创建" location={prefix} onClose={() => setFolderOpen(false)}
        onSubmit={async (value, destination) => { await api.makeFolder(`${destination}${value}`); toast.success(`已创建文件夹“${value}”`); setFolderOpen(false); await load(); }} />}
      {renaming && <NameDialog title={renaming.kind === "folder" ? "重命名文件夹" : "重命名文件"} label="新名称" confirm="重命名" initial={baseName(renaming.key)} onClose={() => setRenaming(null)}
        onSubmit={async value => {
          const folder = renaming.kind === "folder";
          const target = `${parentPath(renaming.key)}${value}${folder ? "/" : ""}`;
          if (target === renaming.key) { setRenaming(null); return; }
          // 重命名不合并：目标已存在时直接提示，而不是并入同名文件夹。
          if (entries.some(entry => entry.key === target)) throw new Error("这个位置已有同名项目");
          const result = await api.moveFile(renaming.key, target, "skip");
          if (!result.moved || result.skipped) throw new Error("这个位置已有同名项目");
          toast.success(`已重命名为“${value}”`); setRenaming(null); await load();
        }} />}
      {moving && <MoveDialog targets={moving} startPrefix={query ? "" : prefix} onClose={() => setMoving(null)}
        onMove={async (dest, conflict) => { await moveEntries(moving, dest, conflict); setMoving(null); }} />}
      {preview && <PreviewModal file={preview} url={api.contentUrl(preview.key)} downloadUrl={api.contentUrl(preview.key, true)} assetUrl={key => api.contentUrl(key)} onClose={() => setPreview(null)} onShare={() => setSharing(preview)}
        onImageLoad={image => {
          // 预览过的图片顺便补上缩略图（例如通过 S3 上传、没有缩略图的图片）。
          if (preview.has_thumbnail || !thumbnailable(preview.key, preview.content_type, preview.size)) return;
          const key = preview.key;
          void makeThumbnail(image).then(data => data
            ? api.setThumbnail(key, data).then(() => setFiles(current => current.map(item => item.key === key ? { ...item, has_thumbnail: true } : item)))
            : undefined).catch(() => undefined);
        }} />}
      {sharing && <ShareDialog file={sharing} publicBase={session.public_base_url} onClose={() => setSharing(null)}
        update={async (isPublic, options) => (await api.setPublic([sharing.key], isPublic, options)).objects[0]} onChange={file => { replaceFile(file); onChanged(); }} />}
    </div>
  );
}

const INTERNAL_DRAG = "application/x-tgdrive-keys";

/** 目标文件夹是否是一个有效的移动位置：不能原地移动，文件夹不能移入自身或其子文件夹。 */
function canMoveInto(entry: Entry, dest: string) {
  if (parentPath(entry.key) === dest) return false;
  return !(entry.kind === "folder" && dest.startsWith(entry.key));
}

function MoveDialog({ targets, startPrefix, onClose, onMove }: { targets: Entry[]; startPrefix: string; onClose: () => void; onMove: (dest: string, conflict: api.MoveConflict) => Promise<void> }) {
  const blocked = (key: string) => targets.some(target => target.kind === "folder" && key.startsWith(target.key));
  const [browse, setBrowse] = useState(() => blocked(startPrefix) ? "" : startPrefix);
  const [ready, setReady] = useState(false);
  const [conflict, setConflict] = useState<api.MoveConflict>("rename");
  const [busy, setBusy] = useState(false);
  const alreadyHere = targets.every(target => !canMoveInto(target, browse));
  const title = targets.length === 1 ? `移动“${baseName(targets[0].key)}”` : `移动 ${targets.length} 个项目`;
  return <Modal title={title} description="选择目标文件夹。文件的公开链接在移动后保持不变。" icon="move" onClose={onClose}
    footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={alreadyHere || !ready || blocked(browse)} onClick={() => {
      setBusy(true); void onMove(browse, conflict).finally(() => setBusy(false));
    }}>{alreadyHere ? "已在此文件夹中" : `移动到“${browse ? baseName(browse) : "我的文件"}”`}</Button></>}>
    <FolderPicker value={browse} onChange={next => { setReady(false); setBrowse(next); }} blocked={blocked} onReady={setReady} />
    <div className="move-conflict"><span>遇到同名文件时</span><Segmented label="同名冲突处理" value={conflict} onChange={setConflict} options={[{ value: "rename", label: "保留两者" }, { value: "skip", label: "跳过" }, { value: "overwrite", label: "覆盖" }]} /></div>
    {conflict === "overwrite" && <p className="inline-note tone-warning"><Icon name="alert" size={15} />目标位置的同名文件会被替换且无法恢复。</p>}
  </Modal>;
}

function SortHeader({ label, column, sort, onSort, className }: { label: string; column: SortKey; sort: { key: SortKey; desc: boolean }; onSort: (sort: { key: SortKey; desc: boolean }) => void; className: string }) {
  const active = sort.key === column;
  return (
    <span role="columnheader" className={className} aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" className={`sort-button${active ? " is-active" : ""}`} onClick={() => onSort({ key: column, desc: active ? !sort.desc : column !== "name" })}>
        {label}<Icon name="chevronDown" size={13} className={active && !sort.desc ? "is-flipped" : ""} />
      </button>
    </span>
  );
}

function NameDialog({ title, label, confirm, initial = "", location, onClose, onSubmit }: { title: string; label: string; confirm: string; initial?: string; location?: string; onClose: () => void; onSubmit: (value: string, destination: string) => Promise<void> }) {
  const [destination, setDestination] = useState(location ?? "");
  const [ready, setReady] = useState(true);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const dot = initial.lastIndexOf(".");
    input.current?.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!ready || busy) return;
    if (!trimmed) { setError("名称不能为空"); return; }
    if (/[/\\]/.test(trimmed) || trimmed === "." || trimmed === "..") { setError("名称不能包含斜杠，也不能是 . 或 .."); return; }
    setBusy(true);
    try { await onSubmit(trimmed, destination); }
    catch (reason) { setError(api.errorMessage(reason, "操作失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose} dismissible={!busy} size={location === undefined ? "sm" : "md"}
      footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="name-form" loading={busy} disabled={!ready || !value.trim()}>{confirm}</Button></>}>
      <form id="name-form" className="form" onSubmit={submit} noValidate>
        <Field label={label} htmlFor="name-input" error={error}>
          <input id="name-input" ref={input} className="input" value={value} onChange={event => { setValue(event.target.value); setError(""); }} autoFocus />
        </Field>
        {location !== undefined && <DestinationPicker value={destination} onChange={next => { setReady(false); setDestination(next); }} onReady={setReady} />}
      </form>
    </Modal>
  );
}

