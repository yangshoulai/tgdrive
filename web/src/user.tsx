import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import * as api from "./api";
import { DocsPage } from "./docs/docs";
import { FileTile, PreviewModal, ShareDialog, baseName, getFileKind, makeThumbnail, parentPath, thumbnailable } from "./files";
import { SharePage } from "./share";
import { AppShell, FullPageLoading, LoginPage, useSessionGuard } from "./shell";
import {
  Badge, Button, Checkbox, ConfirmDialog, CopyField, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader,
  Panel, Progress, SearchInput, Segmented, SkeletonRows, Switch, copyText, formatBytes, formatDate, formatDateTime, toast,
  usageTone, useDocumentTitle, type MenuItem,
} from "./ui";

/* ---------- 路由 ---------- */

export function UserApp() {
  const path = window.location.pathname;
  if (path.startsWith("/docs")) return <DocsPage />;
  const share = path.match(/^\/s\/([A-Za-z0-9_-]+)/);
  if (share) return <SharePage token={share[1]} />;
  return <UserRoute />;
}

export function UserRoute() {
  const { session, setSession, checking } = useSessionGuard("user", api.restoreUserSession);
  if (checking) return <FullPageLoading label="正在打开文件空间" />;
  if (!session) return <LoginPage kind="user" onSuccess={value => { setSession(value); void api.restoreUserSession().then(setSession).catch(() => undefined); }} />;
  return <UserShell session={session} onLogout={() => setSession(null)} />;
}

type Section = "files" | "shared" | "trash" | "keys";
type Usage = { used_bytes: number; quota_bytes: number | null; id: number };

function readLocation(): { section: Section; prefix: string } {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  return { section: view === "shared" || view === "keys" || view === "trash" ? view : "files", prefix: params.get("path") ?? "" };
}

function UserShell({ session, onLogout }: { session: api.Session; onLogout: () => void }) {
  const [location, setLocation] = useState(readLocation);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sharedCount, setSharedCount] = useState<number | undefined>();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const refreshUsage = useCallback(() => {
    void api.me().then(value => setUsage({ used_bytes: value.used_bytes, quota_bytes: value.quota_bytes, id: value.id })).catch(() => undefined);
    void api.listPublic().then(items => setSharedCount(items.length)).catch(() => undefined);
  }, []);
  useEffect(refreshUsage, [refreshUsage]);
  useEffect(() => {
    const pop = () => setLocation(readLocation());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const navigate = useCallback((section: Section, prefix = "") => {
    const params = new URLSearchParams();
    if (section !== "files") params.set("view", section);
    if (section === "files" && prefix) params.set("path", prefix);
    const query = params.toString();
    window.history.pushState(null, "", query ? `/?${query}` : "/");
    setLocation({ section, prefix });
    document.getElementById("main")?.scrollTo?.({ top: 0 });
  }, []);
  async function logout() {
    await api.logout().catch(() => undefined);
    onLogout();
  }
  const percent = usage?.quota_bytes ? usage.used_bytes / usage.quota_bytes * 100 : 0;
  return (
    <AppShell variant="user" active={location.section} onNavigate={key => navigate(key)}
      groups={[
        { items: [
          { key: "files", label: "我的文件", icon: "folder" },
          { key: "shared", label: "公开分享", icon: "globe", count: sharedCount },
          { key: "trash", label: "回收站", icon: "trash" },
          { key: "keys", label: "访问密钥", icon: "key" },
        ] },
        { label: "帮助", items: [{ key: "docs" as Section, label: "使用文档", icon: "book", href: "/docs" }] },
      ]}
      sidebarFooter={
        <div className="storage-meter">
          <div className="storage-meter-head"><span>存储空间</span><strong>{usage?.quota_bytes ? `${Math.round(percent)}%` : "不限"}</strong></div>
          <Progress value={usage?.quota_bytes ? percent : 0} tone={usageTone(percent)} label="存储使用率" />
          <p>{formatBytes(usage?.used_bytes ?? 0)}{usage?.quota_bytes ? ` / ${formatBytes(usage.quota_bytes)}` : " 已使用"}</p>
        </div>
      }
      account={{ name: session.username, caption: "个人空间", menu: [
        { label: "修改密码", icon: "lock", onSelect: () => setPasswordOpen(true) },
        { label: "退出登录", icon: "logout", onSelect: () => void logout(), divider: true },
      ] }}>
      {location.section === "files" && <FilesView session={session} prefix={location.prefix} onOpenFolder={prefix => navigate("files", prefix)} onChanged={refreshUsage} />}
      {location.section === "shared" && <SharedView session={session} onChanged={refreshUsage} onOpenFolder={prefix => navigate("files", prefix)} />}
      {location.section === "keys" && <KeysView bucketName={usage ? `user-${usage.id}` : null} />}
      {location.section === "trash" && <TrashView onChanged={refreshUsage} onOpenFolder={prefix => navigate("files", prefix)} />}
      {passwordOpen && <PasswordDialog onClose={() => setPasswordOpen(false)} />}
    </AppShell>
  );
}

/* ---------- 文件 ---------- */

type Entry = { kind: "folder"; key: string } | { kind: "file"; key: string; file: api.FileItem };
type SortKey = "name" | "size" | "modified";

function FilesView({ session, prefix, onOpenFolder, onChanged }: { session: api.Session; prefix: string; onOpenFolder: (prefix: string) => void; onChanged: () => void }) {
  const [files, setFiles] = useState<api.FileItem[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
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
  const uploads = useUploadQueue(() => { void load(); onChanged(); });
  const fileInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const dragDepth = useRef(0);
  const name = prefix ? baseName(prefix) : "我的文件";
  useDocumentTitle(`${query ? `搜索“${query}”` : name} · tgdrive`);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true); setLoadError("");
    try {
      const page = query ? await api.searchFiles(query) : await api.listFiles(prefix);
      if (id !== requestId.current) return;
      setFiles(page.objects.filter(item => !item.key.endsWith("/")));
      setFolders(page.common_prefixes);
      setCursor(page.next_cursor);
    } catch (reason) {
      if (id === requestId.current) setLoadError(api.errorMessage(reason, "文件列表加载失败"));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [prefix, query]);
  useEffect(() => { setSelected(new Set()); void load(); return () => { requestId.current++; }; }, [load]);
  useEffect(() => { setSearch(""); setQuery(""); }, [prefix]);
  useEffect(() => { localStorage.setItem("tgdrive:layout", layout); }, [layout]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = query ? await api.searchFiles(query, cursor) : await api.listFiles(prefix, cursor);
      setFiles(current => [...current, ...page.objects.filter(item => !item.key.endsWith("/"))]);
      setFolders(current => [...current, ...page.common_prefixes]);
      setCursor(page.next_cursor);
    } catch (reason) { toast.error(api.errorMessage(reason, "加载失败")); }
    finally { setLoadingMore(false); }
  }

  const entries = useMemo<Entry[]>(() => {
    const direction = sort.desc ? -1 : 1;
    const fileEntries = files
      .filter(file => filter === "all" || file.public_token)
      .sort((a, b) => direction * (sort.key === "size" ? a.size - b.size : sort.key === "modified" ? a.modified_at - b.modified_at : baseName(a.key).localeCompare(baseName(b.key), "zh-CN", { numeric: true })))
      .map(file => ({ kind: "file" as const, key: file.key, file }));
    const folderEntries = filter === "public" ? [] : [...folders]
      .sort((a, b) => (sort.key === "name" ? direction : 1) * a.localeCompare(b, "zh-CN", { numeric: true }))
      .map(key => ({ kind: "folder" as const, key }));
    return [...folderEntries, ...fileEntries];
  }, [files, folders, filter, sort]);
  const publicCount = files.filter(file => file.public_token).length;
  const selectedEntries = entries.filter(entry => selected.has(entry.key));
  const selectedFiles = selectedEntries.filter((entry): entry is Extract<Entry, { kind: "file" }> => entry.kind === "file");

  function toggleSelect(key: string, value: boolean) {
    setSelected(current => { const next = new Set(current); if (value) next.add(key); else next.delete(key); return next; });
  }
  function replaceFile(updated: api.FileItem) {
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
    } catch (reason) { toast.error(api.errorMessage(reason, "更新分享设置失败")); }
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
          .catch(reason => toast.error(api.errorMessage(reason, "撤销失败"))),
      });
    } catch (reason) { toast.error(api.errorMessage(reason, "删除失败")); }
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
      } catch (reason) { failures.push(`${baseName(target.key)}：${api.errorMessage(reason, "移动失败")}`); }
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
    return [
      { label: "打开", icon: "folder", onSelect: () => onOpenFolder(key) },
      { label: "重命名", icon: "edit", onSelect: () => setRenaming({ kind: "folder", key }) },
      { label: "移动到…", icon: "move", onSelect: () => setMoving([{ kind: "folder", key }]) },
      { label: "删除", icon: "trash", danger: true, divider: true, onSelect: () => void moveToTrash([{ kind: "folder", key }]) },
    ];
  }
  const crumbs = prefix.split("/").filter(Boolean);
  const allSelected = entries.length > 0 && entries.every(entry => selected.has(entry.key));
  const existingNames = useMemo(() => new Set(files.map(file => baseName(file.key))), [files]);

  return (
    <div className="files-view"
      onDragEnter={event => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); dragDepth.current++; setDragging(true); }}
      onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); startUpload(event.dataTransfer.files); }}>
      <PageHeader title={query ? `搜索“${query}”` : name}
        actions={<>
          <Button icon="folderPlus" onClick={() => setFolderOpen(true)} disabled={Boolean(query)}>新建文件夹</Button>
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
            <Segmented label="筛选" value={filter} onChange={setFilter} options={[{ value: "all", label: "全部" }, { value: "public", label: "公开", count: publicCount }]} />
            <Segmented label="视图" value={layout} onChange={setLayout} options={[{ value: "list", label: "列表视图", icon: "list" }, { value: "grid", label: "网格视图", icon: "gridView" }]} />
          </div>
        </div>
      )}

      <section className={`file-surface${dragging ? " is-dragging" : ""}`} aria-label="文件列表">
        {loading ? <SkeletonRows rows={6} /> : loadError ? (
          <EmptyState icon="alert" title="文件列表加载失败" description={loadError} action={<Button icon="refresh" onClick={() => void load()}>重试</Button>} />
        ) : entries.length === 0 ? (
          query ? <EmptyState icon="search" title={`没有找到包含“${query}”的文件`} description="换个关键词，或检查拼写。" action={<Button onClick={() => { setSearch(""); setQuery(""); }}>清除搜索</Button>} />
            : filter === "public" ? <EmptyState icon="globe" title="这个文件夹里没有公开文件" description="在文件菜单中选择“公开分享”，即可生成任何人可访问的链接。" />
              : <EmptyState icon="upload" title={prefix ? "这个文件夹是空的" : "上传你的第一个文件"} description="把文件拖到这里，或点击上传按钮。" action={<Button variant="primary" icon="upload" onClick={() => fileInput.current?.click()}>上传文件</Button>} />
        ) : layout === "list" ? (
          <div className="data-table file-table" role="table" aria-label="文件">
            <div className="data-row data-head" role="row">
              <span role="columnheader" className="cell-check"><Checkbox label="全选" checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={value => setSelected(value ? new Set(entries.map(entry => entry.key)) : new Set())} /></span>
              <SortHeader label="名称" column="name" sort={sort} onSort={setSort} className="cell-name" />
              <SortHeader label="大小" column="size" sort={sort} onSort={setSort} className="cell-size" />
              <SortHeader label="修改时间" column="modified" sort={sort} onSort={setSort} className="cell-date" />
              <span role="columnheader" className="cell-actions"><span className="sr-only">操作</span></span>
            </div>
            {entries.map(entry => entry.kind === "folder" ? (
              <div key={entry.key} role="row" className={`data-row is-clickable${selected.has(entry.key) ? " is-selected" : ""}${dropClass(entry.key)}`} {...dragProps(entry)} {...dropProps(entry.key)} onClick={() => onOpenFolder(entry.key)}>
                <span role="cell" className="cell-check"><Checkbox label={`选择 ${baseName(entry.key)}`} checked={selected.has(entry.key)} onChange={value => toggleSelect(entry.key, value)} /></span>
                <span role="cell" className="cell-name"><FileTile kind="folder" /><button type="button" className="name-button" onClick={event => { event.stopPropagation(); onOpenFolder(entry.key); }}>{baseName(entry.key)}</button></span>
                <span role="cell" className="cell-size muted">—</span>
                <span role="cell" className="cell-date muted">—</span>
                <span role="cell" className="cell-actions" onClick={event => event.stopPropagation()}><Menu label={`${baseName(entry.key)} 的更多操作`} items={folderMenu(entry.key)} /></span>
              </div>
            ) : (
              <div key={entry.key} role="row" className={`data-row is-clickable${selected.has(entry.key) ? " is-selected" : ""}`} {...dragProps(entry)} onClick={() => setPreview(entry.file)}>
                <span role="cell" className="cell-check"><Checkbox label={`选择 ${baseName(entry.key)}`} checked={selected.has(entry.key)} onChange={value => toggleSelect(entry.key, value)} /></span>
                <span role="cell" className="cell-name">
                  <FileTile kind={getFileKind(entry.file.content_type, entry.key)} />
                  <span className="name-stack">
                    <button type="button" className="name-button" onClick={event => { event.stopPropagation(); setPreview(entry.file); }}>{baseName(entry.key)}</button>
                    {query && parentPath(entry.key) && <small>{parentPath(entry.key)}</small>}
                  </span>
                  {entry.file.public_token && <Badge tone="public" icon="globe">公开</Badge>}
                </span>
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
                    {entry.kind === "file" && entry.file.has_thumbnail ? <img src={api.thumbnailUrl(entry.key, entry.file.etag)} alt="" loading="lazy" />
                      : kind === "image" && entry.kind === "file" && entry.file.size <= 2 * 1024 * 1024 ? <img src={api.contentUrl(entry.key)} alt="" loading="lazy" />
                        : <FileTile kind={kind} size="xl" />}
                    <span className="grid-check" onClick={event => event.stopPropagation()}><Checkbox label={`选择 ${baseName(entry.key)}`} checked={isSelected} onChange={value => toggleSelect(entry.key, value)} /></span>
                    {entry.kind === "file" && entry.file.public_token && <span className="grid-public"><Badge tone="public" icon="globe">公开</Badge></span>}
                  </div>
                  <div className="grid-meta">
                    {/* 卡片本身只响应鼠标；文件名按钮是键盘与读屏用户的打开入口。 */}
                    <button type="button" className="grid-name name-button" title={baseName(entry.key)}
                      onClick={event => { event.stopPropagation(); if (entry.kind === "folder") onOpenFolder(entry.key); else setPreview(entry.file); }}>
                      {baseName(entry.key)}
                    </button>
                    <span className="grid-sub">{entry.kind === "folder" ? "文件夹" : formatBytes(entry.file.size)}</span>
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
        <span>{loading ? "正在加载" : `${folders.length} 个文件夹，${files.length} 个文件`}</span>
        {cursor && <Button size="sm" loading={loadingMore} onClick={() => void loadMore()}>加载更多</Button>}
      </footer>

      {pendingUpload && <UploadDialog files={pendingUpload} destination={prefix} existing={existingNames} onClose={() => setPendingUpload(null)}
        onStart={(list, isPublic) => { setPendingUpload(null); uploads.enqueue(list.map(file => ({ file, path: `${prefix}${file.name}`, isPublic }))); }} />}
      {folderOpen && <NameDialog title="新建文件夹" label="文件夹名称" confirm="创建" onClose={() => setFolderOpen(false)}
        onSubmit={async value => { await api.makeFolder(`${prefix}${value}`); toast.success(`已创建文件夹“${value}”`); setFolderOpen(false); await load(); }} />}
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
      {preview && <PreviewModal file={preview} url={api.contentUrl(preview.key)} downloadUrl={api.contentUrl(preview.key, true)} onClose={() => setPreview(null)} onShare={() => setSharing(preview)}
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
      <UploadTray queue={uploads} />
    </div>
  );
}

const INTERNAL_DRAG = "application/x-tgdrive-keys";

/** 目标文件夹是否是一个有效的移动位置：不能原地移动，文件夹不能移入自身或其子文件夹。 */
function canMoveInto(entry: Entry, dest: string) {
  if (parentPath(entry.key) === dest) return false;
  return !(entry.kind === "folder" && dest.startsWith(entry.key));
}

async function listAllFolders(prefix: string) {
  const folders: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await api.listFiles(prefix, cursor);
    folders.push(...page.common_prefixes);
    cursor = page.next_cursor;
  } while (cursor);
  return folders.sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
}

function MoveDialog({ targets, startPrefix, onClose, onMove }: { targets: Entry[]; startPrefix: string; onClose: () => void; onMove: (dest: string, conflict: api.MoveConflict) => Promise<void> }) {
  const movingFolders = targets.filter(target => target.kind === "folder").map(target => target.key);
  const blocked = (key: string) => movingFolders.some(folder => key.startsWith(folder));
  const [browse, setBrowse] = useState(() => blocked(startPrefix) ? "" : startPrefix);
  const [folders, setFolders] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [conflict, setConflict] = useState<api.MoveConflict>("rename");
  const [busy, setBusy] = useState(false);
  const load = useCallback((prefix: string) => {
    setFolders(null); setError("");
    void listAllFolders(prefix).then(setFolders).catch(reason => setError(api.errorMessage(reason, "文件夹加载失败")));
  }, []);
  useEffect(() => load(browse), [browse, load]);
  const alreadyHere = targets.every(target => !canMoveInto(target, browse));
  const crumbs = browse.split("/").filter(Boolean);
  const title = targets.length === 1 ? `移动“${baseName(targets[0].key)}”` : `移动 ${targets.length} 个项目`;
  async function createFolder(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || /[/\\]/.test(name) || name === "." || name === "..") { setError("文件夹名称不能为空，也不能包含斜杠"); return; }
    try {
      await api.makeFolder(`${browse}${name}`);
      setCreating(false); setNewName("");
      setBrowse(`${browse}${name}/`);
    } catch (reason) { setError(api.errorMessage(reason, "创建失败")); }
  }
  async function confirm() {
    setBusy(true);
    try { await onMove(browse, conflict); } finally { setBusy(false); }
  }
  return (
    <Modal title={title} description="选择目标文件夹。文件的公开链接在移动后保持不变。" icon="move" onClose={onClose}
      footer={<>
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" loading={busy} disabled={alreadyHere || folders === null} onClick={() => void confirm()}>
          {alreadyHere ? "已在此文件夹中" : `移动到“${browse ? baseName(browse) : "我的文件"}”`}
        </Button>
      </>}>
      <div className="move-browser">
        <div className="move-head">
          <nav className="breadcrumbs" aria-label="目标位置">
            <button type="button" onClick={() => setBrowse("")} aria-current={!browse ? "page" : undefined}><Icon name="home" size={15} />我的文件</button>
            {crumbs.map((part, index) => (
              <span key={index}><Icon name="chevronRight" size={14} /><button type="button" onClick={() => setBrowse(`${crumbs.slice(0, index + 1).join("/")}/`)} aria-current={index === crumbs.length - 1 ? "page" : undefined}>{part}</button></span>
            ))}
          </nav>
          {!creating && <Button size="sm" variant="ghost" icon="folderPlus" onClick={() => { setCreating(true); setError(""); }}>新建文件夹</Button>}
        </div>
        <div className="move-list" role="listbox" aria-label="子文件夹">
          {creating && (
            <form className="move-new" onSubmit={createFolder} noValidate>
              <FileTile kind="folder" />
              <input className="input" autoFocus placeholder="新文件夹名称" value={newName} onChange={event => { setNewName(event.target.value); setError(""); }} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setCreating(false); } }} />
              <Button size="sm" variant="primary" type="submit">创建</Button>
              <IconButton icon="x" size="sm" label="取消新建" onClick={() => setCreating(false)} />
            </form>
          )}
          {folders === null && !error ? <SkeletonRows rows={3} /> : folders?.length === 0 && !creating ? (
            <p className="move-empty">这个文件夹里没有子文件夹，可以直接移动到这里。</p>
          ) : folders?.map(folder => {
            const disabled = blocked(folder);
            return (
              <button key={folder} type="button" role="option" aria-selected={false} className={`move-item${disabled ? " is-disabled" : ""}`} disabled={disabled} onClick={() => setBrowse(folder)}>
                <FileTile kind="folder" />
                <span className="move-name">{baseName(folder)}</span>
                {disabled ? <span className="muted">正在移动</span> : <Icon name="chevronRight" size={16} />}
              </button>
            );
          })}
          {error && <p className="field-error move-error" role="alert">{error}</p>}
        </div>
        <div className="move-conflict">
          <span>遇到同名文件时</span>
          <Segmented label="同名冲突处理" value={conflict} onChange={setConflict} options={[{ value: "rename", label: "保留两者" }, { value: "skip", label: "跳过" }, { value: "overwrite", label: "覆盖" }]} />
        </div>
        {conflict === "overwrite" && <p className="inline-note tone-warning"><Icon name="alert" size={15} />目标位置的同名文件会被替换且无法恢复。</p>}
      </div>
    </Modal>
  );
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

function NameDialog({ title, label, confirm, initial = "", onClose, onSubmit }: { title: string; label: string; confirm: string; initial?: string; onClose: () => void; onSubmit: (value: string) => Promise<void> }) {
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
    if (!trimmed) { setError("名称不能为空"); return; }
    if (/[/\\]/.test(trimmed) || trimmed === "." || trimmed === "..") { setError("名称不能包含斜杠，也不能是 . 或 .."); return; }
    setBusy(true);
    try { await onSubmit(trimmed); }
    catch (reason) { setError(api.errorMessage(reason, "操作失败")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose} size="sm"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="name-form" loading={busy}>{confirm}</Button></>}>
      <form id="name-form" className="form" onSubmit={submit} noValidate>
        <Field label={label} htmlFor="name-input" error={error}>
          <input id="name-input" ref={input} className="input" value={value} onChange={event => { setValue(event.target.value); setError(""); }} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

/* ---------- 上传 ---------- */

function UploadDialog({ files, destination, existing, onClose, onStart }: { files: File[]; destination: string; existing: Set<string>; onClose: () => void; onStart: (files: File[], isPublic: boolean) => void }) {
  const [list, setList] = useState(files);
  const [isPublic, setIsPublic] = useState(() => localStorage.getItem("tgdrive:upload-public") === "1");
  const total = list.reduce((sum, file) => sum + file.size, 0);
  const conflicts = list.filter(file => existing.has(file.name)).length;
  useEffect(() => { if (!list.length) onClose(); }, [list.length]);
  return (
    <Modal title={`上传 ${list.length} 个文件`} description={<>上传到 <strong>{destination ? `/${destination}` : "我的文件"}</strong>，共 {formatBytes(total)}</>} icon="upload" onClose={onClose} size="md"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon="upload" onClick={() => { localStorage.setItem("tgdrive:upload-public", isPublic ? "1" : "0"); onStart(list, isPublic); }}>开始上传</Button></>}>
      <ul className="upload-pick-list">
        {list.map((file, index) => (
          <li key={`${file.name}-${index}`}>
            <FileTile kind={getFileKind(file.type, file.name)} />
            <span className="upload-pick-name">{file.name}{existing.has(file.name) && <Badge tone="warning">将覆盖</Badge>}</span>
            <span className="muted">{formatBytes(file.size)}</span>
            <IconButton icon="x" size="sm" label={`移除 ${file.name}`} onClick={() => setList(current => current.filter((_, i) => i !== index))} />
          </li>
        ))}
      </ul>
      {conflicts > 0 && <p className="inline-note tone-warning"><Icon name="alert" size={15} />{conflicts} 个文件与现有文件同名，上传后将替换原文件，已有的公开链接保持不变。</p>}
      <div className={`share-status${isPublic ? " is-public" : ""}`}>
        <Switch checked={isPublic} onChange={setIsPublic} label="上传后公开访问"
          description={isPublic ? "每个文件都会生成独立的公开链接，任何拥有链接的人都可以查看和下载。" : "文件仅自己可见，之后可以随时单独分享。"} />
      </div>
    </Modal>
  );
}

type UploadJob = { id: string; file: File; path: string; isPublic: boolean; percent: number; status: "queued" | "uploading" | "done" | "error" | "canceled"; error?: string; result?: api.FileItem; resumed?: boolean };

/** 超过这个大小的文件分段上传：每段失败自动重试，网络中断或刷新页面后重新选择同一文件即可续传。 */
const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
const resumeKey = (path: string, file: File) => `tgdrive:resume:${path}:${file.size}:${file.lastModified}`;
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

async function uploadMultipart(job: UploadJob, signal: { aborted: boolean; abort?: () => void },
                               onProgress: (percent: number) => void, onResumed: () => void): Promise<api.FileItem> {
  const storageKey = resumeKey(job.path, job.file);
  let uploadId = localStorage.getItem(storageKey);
  let partSize = 16 * 1024 * 1024;
  const done = new Map<number, string>();
  if (uploadId) {
    try {
      const state = await api.getUpload(uploadId);
      if (state.completed || state.path !== job.path) throw new Error("stale");
      const count = Math.ceil(job.file.size / partSize);
      for (const part of state.parts) {
        const expected = part.part_no < count ? partSize : job.file.size - partSize * (count - 1);
        if (part.size === expected) done.set(part.part_no, part.etag);
      }
      if (done.size) onResumed();
    } catch { uploadId = null; done.clear(); }
  }
  if (!uploadId) {
    const created = await api.createUpload(job.path, job.file.type || "application/octet-stream");
    uploadId = created.upload_id;
    partSize = created.part_size;
    localStorage.setItem(storageKey, uploadId);
  }
  const count = Math.max(1, Math.ceil(job.file.size / partSize));
  let finished = [...done.keys()].reduce((sum, number) => sum + Math.min(partSize, job.file.size - (number - 1) * partSize), 0);
  for (let number = 1; number <= count; number++) {
    if (done.has(number)) continue;
    const blob = job.file.slice((number - 1) * partSize, Math.min(job.file.size, number * partSize));
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new api.ApiError("已取消上传", 0, "upload_aborted");
      const task = api.uploadPartWithProgress(uploadId, number, blob, progress => onProgress((finished + progress.loaded) / job.file.size * 100));
      signal.abort = task.abort;
      try {
        done.set(number, (await task.promise).etag);
        finished += blob.size;
        break;
      } catch (reason) {
        const transient = reason instanceof api.ApiError && (reason.status === 0 || reason.status >= 500) && reason.code !== "upload_aborted";
        if (!transient || attempt >= 4) throw reason;
        await sleep(1000 * 2 ** attempt);  // 1、2、4、8 秒后重试
      }
    }
  }
  const result = await api.completeUpload(uploadId, [...done.entries()].sort((a, b) => a[0] - b[0]), job.isPublic || undefined);
  localStorage.removeItem(storageKey);
  return result;
}
type UploadQueue = ReturnType<typeof useUploadQueue>;

function useUploadQueue(onSettled: () => void) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const running = useRef(false);
  const queue = useRef<UploadJob[]>([]);
  const aborters = useRef(new Map<string, () => void>());
  const canceled = useRef(new Set<string>());
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const update = (id: string, patch: Partial<UploadJob>) => setJobs(current => current.map(job => job.id === id ? { ...job, ...patch } : job));

  async function run() {
    if (running.current) return;
    running.current = true;
    let done = 0, failed = 0;
    while (queue.current.length) {
      const job = queue.current.shift()!;
      if (canceled.current.has(job.id)) continue;
      update(job.id, { status: "uploading" });
      const multipart = job.file.size > MULTIPART_THRESHOLD;
      const signal: { aborted: boolean; abort?: () => void } = { aborted: false };
      let promise: Promise<api.FileItem>;
      if (multipart) {
        aborters.current.set(job.id, () => { signal.aborted = true; signal.abort?.(); });
        promise = uploadMultipart(job, signal, percent => update(job.id, { percent }), () => update(job.id, { resumed: true }));
      } else {
        const task = api.uploadFileWithProgress(job.path, job.file, { isPublic: job.isPublic || undefined, onProgress: progress => update(job.id, { percent: progress.percent }) });
        aborters.current.set(job.id, task.abort);
        promise = task.promise;
      }
      try {
        const result = await promise;
        update(job.id, { status: "done", percent: 100, result });
        done++;
        if (thumbnailable(job.file.name, job.file.type, job.file.size)) {
          // 缩略图失败不影响上传结果。
          void makeThumbnail(job.file).then(data => data ? api.setThumbnail(job.path, data) : undefined).then(() => settled.current()).catch(() => undefined);
        }
      } catch (reason) {
        const aborted = reason instanceof api.ApiError && reason.code === "upload_aborted";
        if (aborted && multipart) {
          // 用户主动取消：放弃服务端的分段上传，不再保留续传进度。
          const uploadId = localStorage.getItem(resumeKey(job.path, job.file));
          localStorage.removeItem(resumeKey(job.path, job.file));
          if (uploadId) void api.abortUpload(uploadId).catch(() => undefined);
        }
        update(job.id, { status: aborted ? "canceled" : "error",
          error: multipart && !aborted ? `${api.errorMessage(reason, "上传失败")}。进度已保存，重新上传同一文件即可继续。` : api.errorMessage(reason, "上传失败") });
        if (!aborted) failed++;
      } finally { aborters.current.delete(job.id); }
      settled.current();
    }
    running.current = false;
    if (failed) toast.error(`${failed} 个文件上传失败，可在上传列表中查看原因`);
    else if (done) toast.success(done === 1 ? "上传完成" : `${done} 个文件上传完成`);
  }
  function enqueue(items: { file: File; path: string; isPublic: boolean }[]) {
    const next = items.map(item => ({ ...item, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, percent: 0, status: "queued" as const }));
    queue.current.push(...next);
    setJobs(current => [...current.filter(job => job.status === "queued" || job.status === "uploading"), ...next]);
    void run();
  }
  function cancel(id: string) {
    canceled.current.add(id);
    aborters.current.get(id)?.();
    setJobs(current => current.map(job => job.id === id && job.status === "queued" ? { ...job, status: "canceled" } : job));
  }
  function clear() { setJobs(current => current.filter(job => job.status === "queued" || job.status === "uploading")); }
  return { jobs, enqueue, cancel, clear };
}

function UploadTray({ queue }: { queue: UploadQueue }) {
  const [collapsed, setCollapsed] = useState(false);
  const { jobs } = queue;
  if (!jobs.length) return null;
  const active = jobs.filter(job => job.status === "queued" || job.status === "uploading").length;
  const failed = jobs.filter(job => job.status === "error").length;
  const overall = jobs.reduce((sum, job) => sum + (job.status === "done" ? 100 : job.percent), 0) / jobs.length;
  const title = active ? `正在上传 ${jobs.length - active + 1}/${jobs.length}` : failed ? `${failed} 个文件上传失败` : "上传完成";
  return (
    <aside className={`upload-tray${collapsed ? " is-collapsed" : ""}`} aria-label="上传进度" aria-live="polite">
      <header>
        <span className={`tray-status${active ? " is-active" : failed ? " is-error" : " is-done"}`}><Icon name={active ? "upload" : failed ? "alert" : "check"} size={16} /></span>
        <strong>{title}</strong>
        <IconButton icon="chevronDown" size="sm" label={collapsed ? "展开" : "收起"} onClick={() => setCollapsed(value => !value)} />
        {!active && <IconButton icon="x" size="sm" label="关闭上传列表" onClick={queue.clear} />}
      </header>
      {active > 0 && <Progress value={overall} label="总体进度" />}
      {!collapsed && (
        <ul>
          {jobs.map(job => (
            <li key={job.id}>
              <FileTile kind={getFileKind(job.file.type, job.file.name)} />
              <div className="tray-job">
                <span className="tray-name">{job.file.name}{job.isPublic && <Icon name="globe" size={13} className="tray-public" />}{job.resumed && <Badge tone="accent">续传</Badge>}</span>
                {job.status === "uploading" || job.status === "queued" ? <Progress value={job.percent} label={`${job.file.name} 上传进度`} />
                  : <small className={job.status === "error" ? "tone-danger" : "muted"}>{job.status === "done" ? formatBytes(job.file.size) : job.status === "canceled" ? "已取消" : job.error}</small>}
              </div>
              <span className="tray-right">
                {job.status === "uploading" && <small className="muted">{job.percent >= 100 ? "加密中" : `${Math.round(job.percent)}%`}</small>}
                {job.status === "queued" && <small className="muted">等待中</small>}
                {(job.status === "uploading" || job.status === "queued") && <IconButton icon="x" size="sm" label={`取消上传 ${job.file.name}`} onClick={() => queue.cancel(job.id)} />}
                {job.status === "done" && job.result?.public_token && <IconButton icon="copy" size="sm" label="复制分享链接" onClick={() => void copyText(api.publicLinks(job.result!.public_token!, job.file.name).page, "分享链接已复制")} />}
                {job.status === "done" && !job.result?.public_token && <Icon name="check" size={16} className="tone-success" />}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/* ---------- 公开分享 ---------- */

function SharedView({ session, onChanged, onOpenFolder }: { session: api.Session; onChanged: () => void; onOpenFolder: (prefix: string) => void }) {
  const [items, setItems] = useState<api.FileItem[] | null>(null);
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState<api.FileItem | null>(null);
  const [preview, setPreview] = useState<api.FileItem | null>(null);
  useDocumentTitle("公开分享 · tgdrive");
  const load = useCallback(() => {
    setError("");
    void api.listPublic().then(setItems).catch(reason => setError(api.errorMessage(reason, "加载失败")));
  }, []);
  useEffect(load, [load]);
  const links = (file: api.FileItem) => api.publicLinks(file.public_token!, baseName(file.key), session.public_base_url);
  return (
    <>
      <PageHeader title="公开分享" description="这些文件可以被任何拥有链接的人访问。关闭分享后，链接会立即失效。" />
      <section className="file-surface">
        {error ? <EmptyState icon="alert" title="加载失败" description={error} action={<Button icon="refresh" onClick={load}>重试</Button>} />
          : items === null ? <SkeletonRows rows={4} />
            : items.length === 0 ? <EmptyState icon="globe" title="还没有公开的文件" description="在“我的文件”中打开文件菜单，选择“公开分享”，或在上传时开启公开访问。" />
              : (
                <div className="data-table shared-table" role="table" aria-label="公开文件">
                  <div className="data-row data-head" role="row">
                    <span role="columnheader" className="cell-name">文件</span>
                    <span role="columnheader" className="cell-size">大小</span>
                    <span role="columnheader" className="cell-date">分享时间</span>
                    <span role="columnheader" className="cell-actions"><span className="sr-only">操作</span></span>
                  </div>
                  {items.map(file => (
                    <div key={file.key} role="row" className="data-row is-clickable" onClick={() => setPreview(file)}>
                      <span role="cell" className="cell-name">
                        <FileTile kind={getFileKind(file.content_type, file.key)} />
                        <span className="name-stack">
                          <button type="button" className="name-button" onClick={event => { event.stopPropagation(); setPreview(file); }}>{baseName(file.key)}</button>
                          <small>{parentPath(file.key) ? `/${parentPath(file.key)}` : "我的文件"}{` · 下载 ${file.public_downloads ?? 0} 次`}</small>
                        </span>
                        {file.public_has_password && <Badge icon="lock">密码</Badge>}
                        {file.public_expires_at && (file.public_expires_at * 1000 < Date.now()
                          ? <Badge tone="danger">已过期</Badge>
                          : <Badge tone="warning" icon="pulse">{`至 ${formatDate(file.public_expires_at)}`}</Badge>)}
                      </span>
                      <span role="cell" className="cell-size muted">{formatBytes(file.size)}</span>
                      <span role="cell" className="cell-date muted">{formatDate(file.public_at)}</span>
                      <span role="cell" className="cell-actions" onClick={event => event.stopPropagation()}>
                        <Button size="sm" icon="copy" onClick={() => void copyText(links(file).page, "分享链接已复制")}>复制链接</Button>
                        <Menu label={`${baseName(file.key)} 的更多操作`} items={[
                          { label: "打开分享页", icon: "external", onSelect: () => window.open(links(file).page, "_blank", "noreferrer") },
                          { label: "复制直链", icon: "link", onSelect: () => void copyText(links(file).direct, "直链已复制") },
                          { label: "打开所在文件夹", icon: "folder", onSelect: () => onOpenFolder(parentPath(file.key)) },
                          { label: "停止分享", icon: "lock", danger: true, divider: true, onSelect: () => setRevoking(file) },
                        ]} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
      </section>
      {revoking && <ConfirmDialog title={`停止分享“${baseName(revoking.key)}”？`} description="原链接会立即失效。再次分享时会生成新的链接。" confirmLabel="停止分享"
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          try { await api.setPublic([revoking.key], false); toast.success("已停止分享"); setRevoking(null); load(); onChanged(); }
          catch (reason) { toast.error(api.errorMessage(reason, "操作失败")); }
        }} />}
      {preview && <PreviewModal file={preview} url={api.contentUrl(preview.key)} downloadUrl={api.contentUrl(preview.key, true)} onClose={() => setPreview(null)} />}
    </>
  );
}

/* ---------- 回收站 ---------- */

function TrashView({ onChanged, onOpenFolder }: { onChanged: () => void; onOpenFolder: (prefix: string) => void }) {
  const [data, setData] = useState<{ items: api.TrashItem[]; total_size: number; retention_days: number } | null>(null);
  const [purging, setPurging] = useState<api.TrashItem[] | "all" | null>(null);
  useDocumentTitle("回收站 · tgdrive");
  const load = useCallback(() => {
    void api.listTrash().then(setData).catch(reason => { setData({ items: [], total_size: 0, retention_days: 30 }); toast.error(api.errorMessage(reason, "回收站加载失败")); });
  }, []);
  useEffect(load, [load]);
  async function restore(items: api.TrashItem[]) {
    try {
      const { restored } = await api.restoreTrash(items.map(item => item.id));
      const location = parentPath(restored[0]?.path ?? "");
      toast.success(restored.length === 1 ? `已还原“${baseName(restored[0].path)}”` : `已还原 ${restored.length} 项`,
        { label: "打开位置", onClick: () => onOpenFolder(location) });
      load(); onChanged();
    } catch (reason) { toast.error(api.errorMessage(reason, "还原失败")); }
  }
  async function purge(target: api.TrashItem[] | "all") {
    try {
      const { purged } = await api.purgeTrash(target === "all" ? "all" : target.map(item => item.id));
      toast.success(`已永久删除 ${purged} 项`);
      setPurging(null); load(); onChanged();
    } catch (reason) { toast.error(api.errorMessage(reason, "删除失败")); }
  }
  const days = (until: number) => Math.max(0, Math.ceil((until * 1000 - Date.now()) / 86400000));
  return (
    <>
      <PageHeader title="回收站" description={`删除的文件会在这里保留 ${data?.retention_days ?? 30} 天，之后自动永久删除。回收站中的文件仍占用存储空间，其公开链接暂停访问。`}
        actions={data && data.items.length > 0 ? <Button variant="danger" icon="trash" onClick={() => setPurging("all")}>清空回收站</Button> : undefined} />
      <section className="file-surface">
        {data === null ? <SkeletonRows rows={4} /> : data.items.length === 0 ? (
          <EmptyState icon="trash" title="回收站是空的" description="删除的文件和文件夹会先放到这里，可以随时还原。" />
        ) : (
          <div className="data-table trash-table" role="table" aria-label="回收站">
            <div className="data-row data-head" role="row">
              <span role="columnheader">名称</span><span role="columnheader">大小</span><span role="columnheader">删除时间</span><span role="columnheader"><span className="sr-only">操作</span></span>
            </div>
            {data.items.map(item => (
              <div key={item.id} role="row" className="data-row">
                <span role="cell" className="cell-name">
                  <FileTile kind={item.is_folder ? "folder" : getFileKind(null, item.path)} />
                  <span className="name-stack">
                    <strong>{baseName(item.path)}</strong>
                    <small>原位置：{parentPath(item.path) ? `/${parentPath(item.path)}` : "我的文件"}{item.is_folder ? ` · ${item.item_count - 1 > 0 ? `${item.item_count - 1} 个项目` : "空文件夹"}` : ""}</small>
                  </span>
                </span>
                <span role="cell" className="muted">{formatBytes(item.size)}</span>
                <span role="cell" className="name-stack"><span className="muted">{formatDate(item.deleted_at)}</span><small>{days(item.purge_at)} 天后永久删除</small></span>
                <span role="cell" className="cell-actions">
                  <Button size="sm" variant="ghost" icon="refresh" onClick={() => void restore([item])}>还原</Button>
                  <Button size="sm" variant="ghost" className="btn-ghost-danger" onClick={() => setPurging([item])}>永久删除</Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      {data && data.items.length > 0 && <footer className="list-footer"><span>{data.items.length} 项，共占用 {formatBytes(data.total_size)}</span></footer>}
      {purging && <ConfirmDialog title={purging === "all" ? "清空回收站？" : `永久删除“${baseName(purging[0].path)}”？`}
        description={purging === "all" ? "回收站中的所有文件都会被永久删除并释放空间，无法恢复。" : "文件会被永久删除并释放空间，无法恢复。"}
        confirmLabel="永久删除" onConfirm={() => purge(purging)} onClose={() => setPurging(null)} />}
    </>
  );
}

/* ---------- 访问密钥 ---------- */

function KeysView({ bucketName }: { bucketName: string | null }) {
  const [clients, setClients] = useState<api.AdminClient[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<(api.CreatedClient & { name: string }) | null>(null);
  const [disabling, setDisabling] = useState<{ client: string; key: string } | null>(null);
  useDocumentTitle("访问密钥 · tgdrive");
  const load = useCallback(() => { void api.userClients().then(setClients).catch(reason => { setClients([]); toast.error(api.errorMessage(reason, "访问密钥加载失败")); }); }, []);
  useEffect(load, [load]);
  const endpoint = api.s3Endpoint();
  const bucket = clients?.[0]?.grants[0]?.bucket_name ?? bucketName ?? "你的存储桶";
  return (
    <>
      <PageHeader title="访问密钥" description="为脚本、rclone、AWS CLI 或自己的程序创建访问凭据。同一个密钥既可以调用 HTTP API，也可以连接 S3，并且只能访问你自己的存储桶。"
        actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>新建访问密钥</Button>} />
      <div className="stack">
        <Panel title="连接信息" description={<>HTTP API 使用 <code>Authorization: Bearer AccessKeyId:Secret</code> 认证；S3 客户端使用路径风格（path-style）访问。</>}>
          <KeyValue items={[
            ["HTTP API", <CopyField value={`${api.userSiteOrigin()}/api/v1`} label="HTTP API 地址" />],
            ["S3 Endpoint", endpoint ? <CopyField value={endpoint} label="S3 Endpoint" /> : <span className="muted">管理员尚未配置 S3 Endpoint，请联系管理员。</span>],
            ["存储桶", <CopyField value={bucket} label="存储桶名称" />],
            ["区域", <code>us-east-1</code>],
          ]} />
        </Panel>
        <Panel title="已创建的密钥" flush actions={clients && clients.length > 0 ? <Badge>{clients.length}</Badge> : undefined}>
          {clients === null ? <SkeletonRows rows={3} /> : clients.length === 0 ? (
            <EmptyState icon="key" title="还没有访问密钥" description="创建密钥后，就可以用命令行工具同步和备份文件。" action={<Button icon="plus" onClick={() => setCreating(true)}>新建访问密钥</Button>} />
          ) : (
            <div className="data-table keys-table" role="table" aria-label="访问密钥">
              <div className="data-row data-head" role="row">
                <span role="columnheader">名称</span><span role="columnheader">Access Key</span><span role="columnheader">状态</span><span role="columnheader">最近使用</span><span role="columnheader"><span className="sr-only">操作</span></span>
              </div>
              {clients.flatMap(client => client.keys.map(key => (
                <div key={key.access_key_id} role="row" className="data-row">
                  <span role="cell" className="cell-strong">{client.name}</span>
                  <span role="cell"><code className="mono">{key.access_key_id}</code></span>
                  <span role="cell">{key.status === "active" && client.status === "active" ? <Badge tone="success" dot>启用</Badge> : <Badge dot>已禁用</Badge>}</span>
                  <span role="cell" className="muted">{key.last_used_at ? formatDate(key.last_used_at) : "从未使用"}</span>
                  <span role="cell" className="cell-actions">{key.status === "active" && <Button size="sm" variant="ghost" onClick={() => setDisabling({ client: client.name, key: key.access_key_id })}>禁用</Button>}</span>
                </div>
              )))}
            </div>
          )}
        </Panel>
      </div>
      {creating && <CreateKeyDialog onClose={() => setCreating(false)} onCreated={value => { setCreating(false); setCreated(value); load(); }} />}
      {created && <SecretDialog created={created} endpoint={endpoint ?? "https://<S3 Endpoint>"} bucket={bucket} onClose={() => setCreated(null)} />}
      {disabling && <ConfirmDialog title={`禁用“${disabling.client}”的密钥？`} description="使用该密钥的程序会立即失去访问权限，禁用后无法重新启用。" confirmLabel="禁用密钥"
        onClose={() => setDisabling(null)}
        onConfirm={async () => {
          try { await api.disableUserKey(disabling.key); toast.success("密钥已禁用"); setDisabling(null); load(); }
          catch (reason) { toast.error(api.errorMessage(reason, "操作失败")); }
        }} />}
    </>
  );
}

function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (value: api.CreatedClient & { name: string }) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setError("请输入名称，方便以后识别这个密钥"); return; }
    setBusy(true);
    try { onCreated({ ...await api.createUserClient(name.trim()), name: name.trim() }); }
    catch (reason) { setError(api.errorMessage(reason, "创建失败")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="新建访问密钥" icon="key" onClose={onClose} size="sm"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="key-form" loading={busy}>创建</Button></>}>
      <form id="key-form" className="form" onSubmit={submit} noValidate>
        <Field label="名称" htmlFor="key-name" error={error} hint="例如设备或用途：NAS 备份、笔记本 rclone">
          <input id="key-name" className="input" value={name} onChange={event => { setName(event.target.value); setError(""); }} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

function SecretDialog({ created, endpoint, bucket, onClose }: { created: api.CreatedClient & { name: string }; endpoint: string; bucket: string; onClose: () => void }) {
  const [example, setExample] = useState<"http" | "rclone">("http");
  const rclone = `[tgdrive]\ntype = s3\nprovider = Other\naccess_key_id = ${created.access_key_id}\nsecret_access_key = ${created.secret}\nendpoint = ${endpoint}\nforce_path_style = true`;
  const curl = `curl -u ${created.access_key_id}:${created.secret} \\\n  ${api.userSiteOrigin()}/api/v1/list`;
  const snippet = example === "http" ? curl : rclone;
  return (
    <Modal title="保存你的 Secret Key" description={`“${created.name}”已创建。Secret Key 只显示这一次，关闭后无法再次查看。`} icon="alert" tone="warning" onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>我已安全保存</Button>}>
      <div className="form">
        <Field label="Access Key ID"><CopyField value={created.access_key_id} label="Access Key ID" /></Field>
        <Field label="Secret Access Key"><CopyField value={created.secret} label="Secret Access Key" secret copyMessage="Secret 已复制" /></Field>
        <Field label="使用示例" hint={example === "http" ? "列出根目录文件；更多接口见使用文档的 API 参考。" : `存储桶：${bucket}`}>
          <Segmented label="示例" value={example} onChange={setExample} options={[{ value: "http", label: "HTTP API" }, { value: "rclone", label: "rclone" }]} />
          <div className="code-block"><div className="code-block-bar"><span>{example === "http" ? "Shell" : "rclone.conf"}</span><button type="button" onClick={() => void copyText(snippet, "示例已复制")}><Icon name="copy" size={14} />复制</button></div><pre><code>{snippet.replace(created.secret, "•".repeat(12))}</code></pre></div>
        </Field>
      </div>
    </Modal>
  );
}

/* ---------- 账号 ---------- */

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ old: "", next: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!form.old) next.old = "请输入当前密码";
    if (form.next.length < 8) next.next = "新密码至少 8 个字符";
    else if (form.next !== form.confirm) next.confirm = "两次输入的密码不一致";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try { await api.changePassword(form.old, form.next); toast.success("密码已更新"); onClose(); }
    catch (reason) { setErrors({ old: api.errorMessage(reason, "修改失败") }); }
    finally { setBusy(false); }
  }
  const field = (key: keyof typeof form, label: string, autoComplete: string): ReactNode => (
    <Field label={label} htmlFor={`pw-${key}`} error={errors[key]}>
      <input id={`pw-${key}`} className="input" type="password" autoComplete={autoComplete} value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} />
    </Field>
  );
  return (
    <Modal title="修改密码" icon="lock" onClose={onClose} size="sm"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="pw-form" loading={busy}>更新密码</Button></>}>
      <form id="pw-form" className="form" onSubmit={submit} noValidate>
        {field("old", "当前密码", "current-password")}
        {field("next", "新密码", "new-password")}
        {field("confirm", "确认新密码", "new-password")}
      </form>
    </Modal>
  );
}
