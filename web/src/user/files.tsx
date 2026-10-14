import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type MouseEvent } from "react";
import { useCursorPage, useFilePageSize } from "../pagination";
import { DestinationPicker, FolderPicker } from "./folders";
import { BRAND } from "../brand";
import * as api from "../api";

import { FileThumbnail, FileTile, FileVisual, ShareDialog, baseName, getFileKind, kindLabel, parentPath } from "../files";
import { saveThumbnails, thumbnailsFromImage, thumbnailSource, useThumbnailBackfill } from "../thumbnails";

import { Badge, Button, Checkbox, ContextMenu, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader, Pagination, FilterChips, SearchInput, Segmented, SkeletonRows, copyText, formatBytes, formatDate, formatDateTime, isShortcutControl, useDocumentTitle, type MenuItem } from "../ui";

import { UploadDialog, type UploadQueue } from "./uploads";
import { PrivateTransferDialog } from "./private-access";
import type { PreviewPlayback } from "../files";
import { usePrivateToast } from "./private-session";
import { usePreview } from "./preview-host";

/* ---------- 文件 ---------- */

type Entry = { kind: "folder"; key: string; size?: number } | { kind: "file"; key: string; file: api.FileItem };
type SortKey = "name" | "type" | "size" | "modified";

/** 文件夹大小：未统计时留空，没有内容时写“空”，不显示生硬的“0 B”或“—”。 */
const folderSize = (size?: number) => size == null ? "" : size === 0 ? "空" : formatBytes(size);
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const DELETE_KEY = IS_MAC ? "⌘⌫" : "Del";
/** 图标上已经印了格式标签（PDF、DOC…）的类型，网格卡片不再重复显示扩展名。 */
const LABELLED_KINDS = new Set(["pdf", "document", "spreadsheet", "presentation"]);

const KIND_FILTERS = api.KIND_FILTERS;

export function FilesView({ session, prefix, onOpenFolder, onChanged, uploads, uploadRevision, onPlayback }: { session: api.Session; prefix: string; onOpenFolder: (prefix: string) => void; onChanged: () => void; uploads: UploadQueue; uploadRevision: number; onPlayback?: (state: PreviewPlayback) => void }) {
  const privateSpace = api.isPrivatePath(prefix);
  const notify = usePrivateToast(privateSpace);
  const root = privateSpace ? api.PRIVATE_PREFIX : "";
  const rootName = privateSpace ? "私密空间" : "我的文件";
  const pageSize = useFilePageSize();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "public">("all");
  const [kind, setKind] = useState<api.KindFilter>("");
  const [layout, setLayout] = useState<"list" | "grid">(() => (localStorage.getItem("tgdrive:layout") as "list" | "grid") || "list");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const preview = usePreview();
  const [sharing, setSharing] = useState<api.FileItem | null>(null);
  const [renaming, setRenaming] = useState<Entry | null>(null);
  const [transferring, setTransferring] = useState<Entry[] | null>(null);
  const [moving, setMoving] = useState<Entry[] | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** 键盘焦点所在的项目（方向键移动）；与勾选状态分开，和桌面文件管理器一致。 */
  const [cursor, setCursor] = useState<string | null>(null);
  const [context, setContext] = useState<{ x: number; y: number; key: string } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const surface = useRef<HTMLElement>(null);
  const dragKeys = useRef<string[]>([]);
  const [folderOpen, setFolderOpen] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastUploadRevision = useRef(uploadRevision);
  const fileInput = useRef<HTMLInputElement>(null);
  const breadcrumbNav = useRef<HTMLElement>(null);
  const dragDepth = useRef(0);
  const name = prefix !== root ? baseName(prefix) : rootName;
  useDocumentTitle(`${query ? `搜索“${query}”` : name} · ${BRAND}`);

  const fetchPage = useCallback((cursor: string | null) => query
    ? api.searchFiles(query, cursor ?? "", filter === "public", pageSize.pageSize, root, kind)
    : api.listFiles(prefix, cursor, filter === "public", pageSize.pageSize, kind), [prefix, query, filter, kind, pageSize.pageSize, root]);
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
  const setThumbnails = (key: string, thumbnails: string[]) =>
    setFiles(current => current.map(item => item.key === key ? { ...item, thumbnails, thumbnail_versions: undefined, has_thumbnail: thumbnails.includes("thumb") } : item));
  const thumbnailBackfill = useThumbnailBackfill(files, key => api.contentUrl(key), setThumbnails);
  const setPublicFolders = (update: (items: Record<string, api.FileItem>) => Record<string, api.FileItem>) => pagination.setPage(current => current && { ...current, public_folders: update(current.public_folders ?? {}) });
  useEffect(() => { setSelected(new Set()); }, [fetchPage, pagination.number]);
  useEffect(() => { setSearch(""); setQuery(""); }, [prefix]);
  useEffect(() => { localStorage.setItem("tgdrive:layout", layout); }, [layout]);
  useEffect(() => {
    // 深路径始终先展示当前位置；祖先目录仍可横向滚动或通过键盘访问。
    const nav = breadcrumbNav.current;
    if (!nav) return;
    const revealCurrent = () => { nav.scrollLeft = nav.scrollWidth; };
    revealCurrent();
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [prefix, query]);

  const entries = useMemo<Entry[]>(() => {
    const direction = sort.desc ? -1 : 1;
    const fileEntries = files
      .filter(file => filter === "all" || file.public_token)
      .sort((a, b) => {
        const name = baseName(a.key).localeCompare(baseName(b.key), "zh-CN", { numeric: true });
        const primary = sort.key === "size" ? a.size - b.size : sort.key === "modified" ? a.modified_at - b.modified_at
          : sort.key === "type" ? kindLabel(getFileKind(a.content_type, a.key)).localeCompare(kindLabel(getFileKind(b.content_type, b.key)), "zh-CN") : name;
        return direction * (primary || name);
      })
      .map(file => ({ kind: "file" as const, key: file.key, file }));
    const folderEntries = [...folders].filter(key => filter === "all" || publicFolders[key])
      .sort((a, b) => sort.key === "size"
        ? direction * ((folderSizes[a] ?? 0) - (folderSizes[b] ?? 0)) || a.localeCompare(b, "zh-CN", { numeric: true })
        : (sort.key === "name" ? direction : 1) * a.localeCompare(b, "zh-CN", { numeric: true }))
      .map(key => ({ kind: "folder" as const, key, size: folderSizes[key] }));
    return [...folderEntries, ...fileEntries];
  }, [files, folders, publicFolders, folderSizes, filter, sort]);
  function openPreview(file: api.FileItem) {
    // 打开文件时记录本页顺序作为播放列表；预览挂在应用外壳上，切换页面后继续播放。
    preview.open({ file, url: api.contentUrl(file.key), downloadUrl: api.contentUrl(file.key, true), assetUrl: key => api.contentUrl(key),
      playlistFiles: entries.flatMap(entry => entry.kind === "file" ? [entry.file] : []),
      poster: api.fileThumbnail(file, "poster"), thumbnail: api.fileThumbnail(file), onPlaybackActivity: onPlayback,
      onShare: privateSpace ? undefined : item => { preview.update(item); setSharing(item); },
      onImageLoad: (image, item) => {
        // 预览过的图片顺便补上缩略图和封面图（例如通过 S3 上传、没有缩略图的图片），不必再下载一次原图。
        // 已有封面、矢量图，或已有缩略图且原图不够大（不会生成封面）时跳过。
        if (item.thumbnails?.includes("poster") || /\.svg$/i.test(item.key)
          || (item.thumbnails?.includes("thumb") && Math.max(image.naturalWidth, image.naturalHeight) <= 480)) return;
        const key = item.key;
        void thumbnailsFromImage(image).then(result => saveThumbnails(key, result)).then(thumbnails => thumbnails && setThumbnails(key, thumbnails)).catch(() => undefined);
      },
    });
  }
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
    preview.update(updated);
  }
  async function bulkPublic(isPublic: boolean) {
    try {
      const result = await api.setPublic(selectedFiles.map(entry => entry.key), isPublic);
      result.objects.forEach(replaceFile);
      notify.success(isPublic ? `已公开 ${result.objects.length} 个文件` : `已取消公开 ${result.objects.length} 个文件`);
      setSelected(new Set()); onChanged();
    } catch (reason) { notify.error(api.errorMessage(reason, "更新分享设置失败，请稍后重试")); }
  }
  /** 删除即移到回收站（可恢复），因此不弹确认框，而是在提示中提供撤销。 */
  async function moveToTrash(targets: Entry[]) {
    try {
      const { items } = await api.moveToTrash(targets.map(target => target.key));
      setSelected(new Set());
      await load(); onChanged();
      notify.success(targets.length === 1 ? `已将“${baseName(targets[0].key)}”移到回收站` : `已将 ${targets.length} 项移到回收站`, {
        label: "撤销",
        onClick: () => void api.restoreTrash(items.map(item => item.id), root)
          .then(() => { notify.success("已撤销删除"); return load(); }).then(onChanged)
          .catch(reason => notify.error(api.errorMessage(reason, "撤销失败，请稍后重试"))),
      });
    } catch (reason) { notify.error(api.errorMessage(reason, "删除失败，请稍后重试")); }
  }
  function startUpload(list: FileList | File[] | null) {
    const picked = Array.from(list ?? []);
    if (picked.length) setPendingUpload(picked);
  }
  /** 逐项移动；文件夹连同内容一起移动，公开链接随文件保留。 */
  async function moveEntries(targets: Entry[], dest: string, conflict: api.MoveConflict = "rename") {
    const items = targets.filter(target => canMoveInto(target, dest));
    if (!items.length) { notify.info("所选项目已经在这个文件夹中"); return; }
    const destName = dest === root ? rootName : baseName(dest);
    let movedItems = 0, skippedFiles = 0;
    const failures: string[] = [];
    for (const target of items) {
      try {
        const result = await api.moveFile(target.key, `${dest}${baseName(target.key)}${target.kind === "folder" ? "/" : ""}`, conflict);
        if (result.moved > 0) movedItems++;
        skippedFiles += result.skipped;
      } catch (reason) { failures.push(`${baseName(target.key)}：${api.errorMessage(reason, "移动失败，请稍后重试")}`); }
    }
    if (movedItems) notify.success(`已将 ${movedItems} 项移动到“${destName}”${skippedFiles ? `，${skippedFiles} 个同名文件已跳过` : ""}`);
    else if (skippedFiles) notify.error(`“${destName}”中已有同名文件，未移动任何项目`);
    if (failures.length) notify.error(failures.length === 1 ? failures[0] : `${failures.length} 项移动失败：${failures[0]}`);
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
      ...(!privateSpace ? [{ label: file.public_token ? "管理分享" : "公开分享", icon: "link" as const, onSelect: () => setSharing(file) }] : []),
    ];
    if (!file.thumbnails?.length && thumbnailSource(file.key, file.content_type, file.size)) {
      const state = thumbnailBackfill.state(file);
      const failed = state?.phase === "waiting" || state?.phase === "failed";
      if (failed) items.push({ label: "查看缩略图失败原因", icon: "info", heading: "缩略图", onSelect: () => notify.info(state.message) });
      if (state?.phase !== "generating") items.push({ label: failed ? "重试生成缩略图" : "生成缩略图", icon: "refresh", heading: failed ? undefined : "缩略图",
        onSelect: () => thumbnailBackfill.retry(file) });
    }
    if (file.public_token) items.push({ label: "复制分享链接", icon: "copy", onSelect: () => void copyText(api.publicLinks(file.public_token!, baseName(file.key), session.public_base_url).page, "分享链接已复制") });
    items.push({ label: "重命名", icon: "edit", shortcut: "F2", onSelect: () => setRenaming(entry) });
    items.push({ label: "移动到…", icon: "move", onSelect: () => setMoving([entry]) });
    items.push({ label: privateSpace ? "移出到我的文件…" : "移入私密空间…", icon: "lock", onSelect: () => setTransferring([entry]) });
    if (query) items.push({ label: "打开所在文件夹", icon: "folder", onSelect: () => onOpenFolder(parentPath(file.key)) });
    items.push({ label: "删除", icon: "trash", danger: true, divider: true, shortcut: DELETE_KEY, onSelect: () => void moveToTrash([entry]) });
    return items;
  }
  function fileVisual(file: api.FileItem) {
    return <FileVisual kind={getFileKind(file.content_type, file.key)} src={api.fileThumbnail(file)} />;
  }
  function folderMenu(key: string): MenuItem[] {
    const shared = publicFolders[key];
    return [
      { label: "打开", icon: "folder", shortcut: "↵", onSelect: () => onOpenFolder(key) },
      { label: "下载（ZIP）", icon: "download", onSelect: () => undefined, href: api.archiveUrl([key]) },
      ...(!privateSpace ? [{ label: shared ? "管理分享" : "公开分享", icon: "link" as const, onSelect: () => setSharing(folderItem(key)) }] : []),
      ...(shared ? [{ label: "复制分享链接", icon: "copy" as const, onSelect: () => void copyText(api.publicLinks(shared.public_token!, baseName(key), session.public_base_url).page, "分享链接已复制") }] : []),
      { label: "重命名", icon: "edit", shortcut: "F2", onSelect: () => setRenaming({ kind: "folder", key }) },
      { label: "移动到…", icon: "move", onSelect: () => setMoving([{ kind: "folder", key }]) },
      { label: privateSpace ? "移出到我的文件…" : "移入私密空间…", icon: "lock", onSelect: () => setTransferring([{ kind: "folder", key }]) },
      { label: "删除", icon: "trash", danger: true, divider: true, shortcut: DELETE_KEY, onSelect: () => void moveToTrash([{ kind: "folder", key }]) },
    ];
  }
  const crumbs = prefix.slice(root.length).split("/").filter(Boolean);
  const allSelected = entries.length > 0 && entries.every(entry => selected.has(entry.key));
  const openEntry = (entry: Entry) => entry.kind === "folder" ? onOpenFolder(entry.key) : openPreview(entry.file);
  const downloadUrl = (targets: Entry[]) => targets.length === 1 && targets[0].kind === "file"
    ? api.contentUrl(targets[0].key, true) : api.archiveUrl(targets.map(target => target.key));
  useEffect(() => { setCursor(current => current && entries.some(entry => entry.key === current) ? current : null); }, [entries]);
  useEffect(() => {
    if (!cursor) return;
    surface.current?.querySelector(`[data-key="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  /** 网格中按位置找上下左右相邻的项目（文件夹区和文件区是两个网格，按几何位置跨区移动）。 */
  function neighbour(key: string | null, direction: "up" | "down" | "left" | "right") {
    const items = Array.from(surface.current?.querySelectorAll<HTMLElement>("[data-key]") ?? []);
    const index = items.findIndex(item => item.dataset.key === key);
    if (index < 0) return items[direction === "up" || direction === "left" ? items.length - 1 : 0]?.dataset.key ?? null;
    if (layout === "list" || direction === "left" || direction === "right") {
      const step = direction === "up" || direction === "left" ? -1 : 1;
      return items[Math.max(0, Math.min(items.length - 1, index + step))].dataset.key ?? null;
    }
    const current = items[index].getBoundingClientRect(), center = current.left + current.width / 2;
    const candidates = items.map(item => ({ key: item.dataset.key ?? null, rect: item.getBoundingClientRect() }))
      .filter(({ rect }) => direction === "down" ? rect.top >= current.bottom - 1 : rect.bottom <= current.top + 1);
    if (!candidates.length) return key;
    const row = direction === "down" ? Math.min(...candidates.map(item => item.rect.top)) : Math.max(...candidates.map(item => item.rect.bottom));
    const sameRow = candidates.filter(item => direction === "down" ? item.rect.top === row : item.rect.bottom === row);
    return sameRow.reduce((best, item) => Math.abs(item.rect.left + item.rect.width / 2 - center) < Math.abs(best.rect.left + best.rect.width / 2 - center) ? item : best).key;
  }
  const handleKey = useRef<(event: KeyboardEvent) => void>(() => undefined);
  handleKey.current = event => {
    if (event.defaultPrevented || event.isComposing || document.body.classList.contains("has-modal") || context) return;
    const target = event.target as Element;
    if (target instanceof Element && (isShortcutControl(target) || target.closest(".modal, .tray-stack, .sidebar"))) return;
    // 焦点在按钮或链接上时，空格和回车照常激活它。
    if ((event.key === " " || event.key === "Enter") && target instanceof Element && target.closest("button, a, summary, [role='button']")) return;
    const mod = event.metaKey || event.ctrlKey;
    const current = entries.find(entry => entry.key === cursor) ?? null;
    const arrows: Record<string, "up" | "down" | "left" | "right"> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    let handled = true;
    if (event.key === "/" && !mod) {
      surface.current?.closest(".files-view")?.querySelector<HTMLInputElement>(".toolbar input[type=search], .toolbar input")?.focus();
    } else if (event.key === "?" && !mod) {
      setShortcutsOpen(true);
    } else if (arrows[event.key] && !mod && !event.altKey && (layout === "grid" || event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const next = neighbour(cursor, arrows[event.key]);
      if (next && event.shiftKey) setSelected(value => new Set([...value, ...(cursor ? [cursor] : []), next]));
      setCursor(next);
    } else if ((event.key === "a" || event.key === "A") && mod && !event.shiftKey) {
      setSelected(new Set(entries.map(entry => entry.key)));
    } else if (event.key === "Escape" && (selected.size || cursor)) {
      if (selected.size) setSelected(new Set()); else setCursor(null);
    } else if (event.key === " " && current && !mod) {
      toggleSelect(current.key, !selected.has(current.key));
    } else if (event.key === "Enter" && current && !mod) {
      openEntry(current);
    } else if (event.key === "F2" && current) {
      setRenaming(current);
    } else if ((event.key === "Delete" || (event.key === "Backspace" && (mod || !IS_MAC))) && (selected.size || current)) {
      void moveToTrash(selected.size ? selectedEntries : [current!]);
    } else handled = false;
    if (handled) { event.preventDefault(); document.documentElement.dataset.input = "keyboard"; }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKey.current(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
  /** 右键：点在已选中的多项之一上时对整个选择操作，否则只针对这一项。 */
  function contextItems(key: string): MenuItem[] {
    if (selected.size > 1 && selected.has(key)) {
      return [
        { label: `下载 ${selected.size} 项（ZIP）`, icon: "download", onSelect: () => undefined, href: downloadUrl(selectedEntries) },
        { label: "移动到…", icon: "move", onSelect: () => setMoving(selectedEntries) },
        { label: privateSpace ? "移出到我的文件…" : "移入私密空间…", icon: "lock", onSelect: () => setTransferring(selectedEntries) },
        { label: `删除 ${selected.size} 项`, icon: "trash", danger: true, divider: true, shortcut: DELETE_KEY, onSelect: () => void moveToTrash(selectedEntries) },
      ];
    }
    const entry = entries.find(item => item.key === key);
    if (!entry) return [];
    return entry.kind === "folder" ? folderMenu(entry.key) : [{ label: "打开", icon: "eye", shortcut: "↵", onSelect: () => openPreview(entry.file) }, ...fileMenu(entry.file)];
  }
  const rowProps = (entry: Entry) => ({
    "data-key": entry.key,
    onMouseDown: () => setCursor(entry.key),
    onContextMenu: (event: MouseEvent) => {
      if ((event.target as Element).closest("input, a")) return;
      event.preventDefault();
      setCursor(entry.key);
      setContext({ x: event.clientX, y: event.clientY, key: entry.key });
    },
  });
  const cursorClass = (key: string) => cursor === key ? " is-cursor" : "";

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
        {(prefix !== root || query) && <nav ref={breadcrumbNav} className="breadcrumbs file-breadcrumbs" aria-label="当前位置">
          <ol>
            <li><button type="button" className={dropClass(root)} {...dropProps(root)} onClick={() => onOpenFolder(root)} title={rootName}><Icon name={privateSpace ? "lock" : "home"} size={15} /><span className="crumb-label">{rootName}</span></button></li>
            {crumbs.map((part, index) => {
              const path = `${root}${crumbs.slice(0, index + 1).join("/")}/`;
              return <li key={path}><Icon name="chevronRight" size={12} /><button type="button" className={dropClass(path)} {...dropProps(path)} onClick={() => onOpenFolder(path)} title={part} aria-current={index === crumbs.length - 1 && !query ? "page" : undefined}><span className="crumb-label">{part}</span></button></li>;
            })}
            {query && <li><Icon name="chevronRight" size={12} /><span className="crumb-current" aria-current="page">搜索结果</span></li>}
          </ol>
        </nav>}
      </PageHeader>

      {selected.size > 0 ? (
        <div className="toolbar selection-bar" role="toolbar" aria-label="批量操作">
          <span className="selection-count">已选择 {selected.size} 项</span>
          <div className="toolbar-actions">
            <a className="btn btn-secondary btn-sm" href={downloadUrl(selectedEntries)}><Icon name="download" size={15} /><span>下载</span></a>
            {!privateSpace && selectedFiles.length > 0 && <Button size="sm" icon="globe" onClick={() => void bulkPublic(true)}>公开</Button>}
            {selectedFiles.some(entry => entry.file.public_token) && <Button size="sm" icon="lock" onClick={() => void bulkPublic(false)}>取消公开</Button>}
            <Button size="sm" icon="move" onClick={() => setMoving(selectedEntries)}>移动</Button>
            <Button size="sm" icon="lock" onClick={() => setTransferring(selectedEntries)}>{privateSpace ? "移出私密空间" : "移入私密空间"}</Button>
            <Button size="sm" variant="danger" icon="trash" onClick={() => void moveToTrash(selectedEntries)}>删除</Button>
            <IconButton icon="x" label="取消选择" size="sm" onClick={() => setSelected(new Set())} />
          </div>
        </div>
      ) : (
        <div className="toolbar">
          <SearchInput value={search} onChange={setSearch} onSubmit={() => setQuery(search.trim())} onClear={() => setQuery("")} placeholder={privateSpace ? "搜索私密空间，按回车" : "搜索全部文件，按回车"} label="搜索文件" />
          <div className="toolbar-actions">
            {!privateSpace && <Segmented label="筛选" value={filter} onChange={setFilter} options={[{ value: "all", label: "全部" }, { value: "public", label: "公开" }]} />}
            <label className={`mobile-file-sort${layout === "grid" ? " is-grid-sort" : ""}`}><span className="sr-only">本页排序</span><select aria-label="本页排序" value={`${sort.key}:${sort.desc ? "desc" : "asc"}`} onChange={event => {
              const [key, direction] = event.target.value.split(":"); setSort({ key: key as SortKey, desc: direction === "desc" });
            }}><option value="name:asc">名称升序</option><option value="name:desc">名称降序</option><option value="type:asc">类型升序</option><option value="type:desc">类型降序</option><option value="size:desc">容量从大到小</option><option value="size:asc">容量从小到大</option><option value="modified:desc">最近修改优先</option><option value="modified:asc">最早修改优先</option></select><Icon name="chevronDown" size={14} /></label>
            <IconButton icon="refresh" label="刷新" variant="secondary" spinning={pagination.refreshing} disabled={loading} onClick={() => void pagination.refresh().then(message => { if (message) notify.error(message); })} />
            <Segmented label="视图" value={layout} onChange={setLayout} options={[{ value: "list", label: "列表视图", icon: "list" }, { value: "grid", label: "网格视图", icon: "gridView" }]} />
          </div>
        </div>
      )}

      <FilterChips label="文件类型" value={kind} onChange={setKind} options={KIND_FILTERS} />

      <section ref={surface} className={`file-surface${layout === "grid" && !loading && !loadError && entries.length > 0 ? " is-grid" : ""}${dragging ? " is-dragging" : ""}`} aria-label="文件列表">
        {loading ? <SkeletonRows rows={6} /> : loadError ? (
          <EmptyState icon="alert" title="文件列表加载失败" description={loadError} action={<Button icon="refresh" onClick={() => void load()}>重试</Button>} />
        ) : entries.length === 0 ? (
          kind && !query ? <EmptyState icon="search" title={`${filter === "public" ? "这个文件夹里没有公开的" : "这个文件夹里没有"}${KIND_FILTERS.find(item => item.value === kind)?.label}`} description="类型筛选只看当前文件夹，不包含子文件夹；搜索时会在全部文件中按类型查找。" action={<Button onClick={() => setKind("")}>显示全部类型</Button>} />
          : query ? <EmptyState icon="search" title={`没有找到包含“${query}”的${kind ? KIND_FILTERS.find(item => item.value === kind)?.label : "文件"}`} description="换个关键词，或检查拼写。" action={<Button onClick={() => { setSearch(""); setQuery(""); }}>清除搜索</Button>} />
            : filter === "public" ? <EmptyState icon="globe" title="这个文件夹里没有公开内容" description="在文件或文件夹的菜单中选择“公开分享”，即可生成任何人可访问的链接。" />
              : <EmptyState icon="upload" title={prefix ? "这个文件夹是空的" : "上传你的第一个文件"} description="把文件拖到这里，或点击上传按钮。" action={<Button icon="upload" onClick={() => fileInput.current?.click()}>选择文件</Button>} />
        ) : layout === "list" ? (
          <div className="data-table file-table" role="table" aria-label="文件">
            <div className="data-row data-head" role="row">
              <span role="columnheader" className="cell-check"><Checkbox label="全选本页" checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={value => setSelected(value ? new Set(entries.map(entry => entry.key)) : new Set())} /></span>
              <SortHeader label="名称" column="name" sort={sort} onSort={setSort} className="cell-name" />
              <SortHeader label="类型" column="type" sort={sort} onSort={setSort} className="cell-type" />
              <SortHeader label="大小" column="size" sort={sort} onSort={setSort} className="cell-size" />
              <SortHeader label="修改时间" column="modified" sort={sort} onSort={setSort} className="cell-date" />
              <span role="columnheader" className="cell-actions"><span className="sr-only">操作</span></span>
            </div>
            {entries.map(entry => entry.kind === "folder" ? (
              <div key={entry.key} role="row" className={`data-row is-clickable${selected.has(entry.key) ? " is-selected" : ""}${cursorClass(entry.key)}${dropClass(entry.key)}`} {...rowProps(entry)} {...dragProps(entry)} {...dropProps(entry.key)} onClick={() => onOpenFolder(entry.key)}>
                <span role="cell" className="cell-check"><Checkbox label={`选择 ${baseName(entry.key)}`} checked={selected.has(entry.key)} onChange={value => toggleSelect(entry.key, value)} /></span>
                <span role="cell" className="cell-name"><FileTile kind="folder" /><span className="name-stack"><button type="button" className="name-button" title={baseName(entry.key)} onClick={event => { event.stopPropagation(); onOpenFolder(entry.key); }}>{baseName(entry.key)}</button>
                  <span className="file-mobile-meta"><span>{["文件夹", folderSize(entry.size)].filter(Boolean).join(" · ")}</span>{publicFolders[entry.key] && <Badge tone="public" icon="globe">公开</Badge>}</span></span>
                  {publicFolders[entry.key] && <Badge tone="public" icon="globe">公开</Badge>}</span>
                <span role="cell" className="cell-type muted">文件夹</span>
                <span role="cell" className="cell-size muted" title="包含所有子文件夹中的文件">{folderSize(entry.size)}</span>
                <span role="cell" className="cell-date muted" />
                <span role="cell" className="cell-actions" onClick={event => event.stopPropagation()}>
                  {!privateSpace && <span className="row-quick"><IconButton icon="link" size="sm" label={`分享 ${baseName(entry.key)}`} onClick={() => setSharing(folderItem(entry.key))} /></span>}
                  <Menu label={`${baseName(entry.key)} 的更多操作`} items={folderMenu(entry.key)} />
                </span>
              </div>
            ) : (
              <div key={entry.key} role="row" className={`data-row is-clickable${selected.has(entry.key) ? " is-selected" : ""}${cursorClass(entry.key)}`} {...rowProps(entry)} {...dragProps(entry)} onClick={() => openPreview(entry.file)}>
                <span role="cell" className="cell-check"><Checkbox label={`选择 ${baseName(entry.key)}`} checked={selected.has(entry.key)} onChange={value => toggleSelect(entry.key, value)} /></span>
                <span role="cell" className="cell-name">
                  {fileVisual(entry.file)}
                  <span className="name-stack">
                    <button type="button" className="name-button" title={baseName(entry.key)} onClick={event => { event.stopPropagation(); openPreview(entry.file); }}>{baseName(entry.key)}</button>
                    <span className="file-mobile-meta"><span>{kindLabel(getFileKind(entry.file.content_type, entry.key))} · {formatBytes(entry.file.size)} · {formatDate(entry.file.modified_at)}</span>{entry.file.public_token && <Badge tone="public" icon="globe">公开</Badge>}</span>
                    {query && parentPath(entry.key) && <small>{privateSpace ? api.privatePathLabel(parentPath(entry.key)) : parentPath(entry.key)}</small>}
                  </span>
                  {entry.file.public_token && <Badge tone="public" icon="globe">公开</Badge>}
                </span>
                <span role="cell" className="cell-type muted">{kindLabel(getFileKind(entry.file.content_type, entry.key))}</span>
                <span role="cell" className="cell-size muted">{formatBytes(entry.file.size)}</span>
                <span role="cell" className="cell-date muted" title={formatDateTime(entry.file.modified_at)}>{formatDate(entry.file.modified_at)}</span>
                <span role="cell" className="cell-actions" onClick={event => event.stopPropagation()}>
                  {!privateSpace && <span className="row-quick"><IconButton icon="link" size="sm" label={`分享 ${baseName(entry.key)}`} onClick={() => setSharing(entry.file)} /></span>}
                  <Menu label={`${baseName(entry.key)} 的更多操作`} items={fileMenu(entry.file)} />
                </span>
              </div>
            ))}
          </div>
        ) : (() => {
          // 网格：文件夹是一排紧凑的横条，文件才用缩略图卡片，避免文件夹占满一屏的大空卡片。
          const folderEntries = entries.filter((entry): entry is Extract<Entry, { kind: "folder" }> => entry.kind === "folder");
          const fileEntries = entries.filter((entry): entry is Extract<Entry, { kind: "file" }> => entry.kind === "file");
          const both = folderEntries.length > 0 && fileEntries.length > 0;
          return <div className="grid-layout">
            {folderEntries.length > 0 && <div className="grid-section">
              {both && <h2 className="grid-section-title">文件夹</h2>}
              <div className="folder-strip">
                {folderEntries.map(entry => {
                  const isSelected = selected.has(entry.key);
                  return (
                    <div key={entry.key} className={`folder-card${isSelected ? " is-selected" : ""}${cursorClass(entry.key)}${dropClass(entry.key)}`} {...rowProps(entry)} {...dragProps(entry)} {...dropProps(entry.key)} onClick={() => onOpenFolder(entry.key)}>
                      <span className="folder-card-lead">
                        <FileTile kind="folder" />
                        <span className="folder-card-check" onClick={event => event.stopPropagation()}><Checkbox label={`选择 ${baseName(entry.key)}`} checked={isSelected} onChange={value => toggleSelect(entry.key, value)} /></span>
                      </span>
                      <span className="folder-card-copy">
                        <button type="button" className="name-button" title={baseName(entry.key)} onClick={event => { event.stopPropagation(); onOpenFolder(entry.key); }}>{baseName(entry.key)}</button>
                        <span className="folder-card-sub">{publicFolders[entry.key] && <span className="folder-card-public"><Icon name="globe" size={12} />公开</span>}{folderSize(entry.size) || "文件夹"}</span>
                      </span>
                      <span className="grid-menu" onClick={event => event.stopPropagation()}><Menu label={`${baseName(entry.key)} 的更多操作`} items={folderMenu(entry.key)} /></span>
                    </div>
                  );
                })}
              </div>
            </div>}
            {fileEntries.length > 0 && <div className="grid-section">
              {both && <h2 className="grid-section-title">文件</h2>}
              <div className="file-grid">
                {fileEntries.map(entry => {
                  const kind = getFileKind(entry.file.content_type, entry.key);
                  const isSelected = selected.has(entry.key);
                  const extension = entry.key.match(/\.([a-z\d]{1,6})$/i)?.[1].toUpperCase();
                  return (
                    <div key={entry.key} className={`grid-card${isSelected ? " is-selected" : ""}${cursorClass(entry.key)}`} {...rowProps(entry)} {...dragProps(entry)} onClick={() => openPreview(entry.file)}>
                      <div className="grid-thumb">
                        {/* 缩略图尚未生成时一直显示类型图标，不在文件列表中拉取原图。 */}
                        <FileThumbnail kind={kind} url={api.fileThumbnail(entry.file)} />
                        {!api.fileThumbnail(entry.file) && extension && !LABELLED_KINDS.has(kind) && <span className="grid-extension" aria-hidden="true">{extension}</span>}
                        <span className="grid-check" onClick={event => event.stopPropagation()}><Checkbox label={`选择 ${baseName(entry.key)}`} checked={isSelected} onChange={value => toggleSelect(entry.key, value)} /></span>
                        {entry.file.public_token && <span className="grid-public"><Badge tone="public" icon="globe">公开</Badge></span>}
                      </div>
                      <div className="grid-meta">
                        {/* 卡片本身只响应鼠标；文件名按钮是键盘与读屏用户的打开入口。 */}
                        <button type="button" className="grid-name name-button" title={baseName(entry.key)}
                          onClick={event => { event.stopPropagation(); openPreview(entry.file); }}>
                          <span className="grid-name-text">{baseName(entry.key)}</span>
                        </button>
                        <span className="grid-sub"><span className="grid-size">{formatBytes(entry.file.size)}</span>{" · "}<span className="grid-kind">{formatDate(entry.file.modified_at)}</span></span>
                        <span className="grid-menu" onClick={event => event.stopPropagation()}><Menu label={`${baseName(entry.key)} 的更多操作`} items={fileMenu(entry.file)} /></span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>}
          </div>;
        })()}
        {dragging && <div className="drop-overlay" aria-hidden="true"><Icon name="upload" size={28} /><strong>松开以上传到“{name}”</strong></div>}
      </section>

      <footer className="list-footer">
        <span>{loading ? "正在加载" : [folders.length && `${folders.length} 个文件夹`, files.length && `${files.length} 个文件`].filter(Boolean).join(" · ") || (kind || filter === "public" ? "没有符合条件的项目" : "空文件夹")}</span>
        <span className="list-footer-end">
          <Pagination {...pagination} {...pageSize} />
          <button type="button" className="link-button shortcut-hint" onClick={() => setShortcutsOpen(true)} aria-keyshortcuts="?"><Icon name="keyboard" size={15} /><span>快捷键</span></button>
        </span>
      </footer>

      {context && <ContextMenu x={context.x} y={context.y} label={`${baseName(context.key)} 的操作`} items={contextItems(context.key)} onClose={() => setContext(null)} />}
      {shortcutsOpen && <Modal title="键盘快捷键" icon="keyboard" size="sm" onClose={() => setShortcutsOpen(false)} footer={<Button onClick={() => setShortcutsOpen(false)}>知道了</Button>}>
        <KeyValue items={[
          [<kbd>/</kbd>, "搜索文件"],
          [<><kbd>↑</kbd> <kbd>↓</kbd>{layout === "grid" && <> <kbd>←</kbd> <kbd>→</kbd></>}</>, "移动焦点；按住 Shift 连续选择"],
          [<kbd>↵</kbd>, "打开文件或文件夹"],
          [<kbd>空格</kbd>, "选中或取消选中"],
          [<kbd>{IS_MAC ? "⌘" : "Ctrl"} A</kbd>, "全选本页"],
          [<kbd>F2</kbd>, "重命名"],
          [<kbd>{DELETE_KEY}</kbd>, "移到回收站"],
          [<kbd>Esc</kbd>, "取消选择"],
          [<kbd>?</kbd>, "显示本说明"],
        ]} />
      </Modal>}

      {pendingUpload && <UploadDialog files={pendingUpload} destination={prefix} onClose={() => setPendingUpload(null)}
        onStart={(list, isPublic, destination) => { setPendingUpload(null); uploads.enqueue(list.map(file => ({ file, path: `${destination}${file.name}`, isPublic }))); }} />}
      {folderOpen && <NameDialog title="新建文件夹" label="文件夹名称" confirm="创建" location={prefix} onClose={() => setFolderOpen(false)}
        onSubmit={async (value, destination) => { await api.makeFolder(`${destination}${value}`); notify.success(`已创建文件夹“${value}”`); setFolderOpen(false); await load(); }} />}
      {renaming && <NameDialog privateSpace={privateSpace} title={renaming.kind === "folder" ? "重命名文件夹" : "重命名文件"} label="新名称" confirm="重命名" initial={baseName(renaming.key)} onClose={() => setRenaming(null)}
        onSubmit={async value => {
          const folder = renaming.kind === "folder";
          const target = `${parentPath(renaming.key)}${value}${folder ? "/" : ""}`;
          if (target === renaming.key) { setRenaming(null); return; }
          // 重命名不合并：目标已存在时直接提示，而不是并入同名文件夹。
          if (entries.some(entry => entry.key === target)) throw new Error("这个位置已有同名项目");
          const result = await api.moveFile(renaming.key, target, "skip");
          if (!result.moved || result.skipped) throw new Error("这个位置已有同名项目");
          notify.success(`已重命名为“${value}”`); setRenaming(null); await load();
        }} />}
      {moving && <MoveDialog targets={moving} startPrefix={query ? root : prefix} onClose={() => setMoving(null)}
        onMove={async (dest, conflict) => { await moveEntries(moving, dest, conflict); setMoving(null); }} />}
      {transferring && <PrivateTransferDialog paths={transferring.map(item => item.key)} into={!privateSpace} onClose={() => setTransferring(null)} onDone={() => { setSelected(new Set()); void load(); onChanged(); }} />}
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
  const root = api.isPrivatePath(startPrefix) ? api.PRIVATE_PREFIX : "";
  const [browse, setBrowse] = useState(() => blocked(startPrefix) ? root : startPrefix);
  const [ready, setReady] = useState(false);
  const [conflict, setConflict] = useState<api.MoveConflict>("rename");
  const [busy, setBusy] = useState(false);
  const alreadyHere = targets.every(target => !canMoveInto(target, browse));
  const title = targets.length === 1 ? `移动“${baseName(targets[0].key)}”` : `移动 ${targets.length} 个项目`;
  return <Modal title={title} className={root ? "private-dialog" : ""} description={root ? "选择私密空间中的目标文件夹。" : "选择目标文件夹。文件的公开链接在移动后保持不变。"} icon="move" onClose={onClose}
    footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={alreadyHere || !ready || blocked(browse)} onClick={() => {
      setBusy(true); void onMove(browse, conflict).finally(() => setBusy(false));
    }}>{alreadyHere ? "已在此文件夹中" : `移动到“${browse !== root ? baseName(browse) : root ? "私密空间" : "我的文件"}”`}</Button></>}>
    <FolderPicker value={browse} onChange={next => { setReady(false); setBrowse(next); }} blocked={blocked} onReady={setReady} />
    <div className="move-conflict"><span>遇到同名文件时</span><Segmented label="同名冲突处理" value={conflict} onChange={setConflict} options={[{ value: "rename", label: "保留两者" }, { value: "skip", label: "跳过" }, { value: "overwrite", label: "覆盖" }]} /></div>
    {conflict === "overwrite" && <p className="inline-note tone-warning"><Icon name="alert" size={15} />目标位置的同名文件会被替换且无法恢复。</p>}
  </Modal>;
}

function SortHeader({ label, column, sort, onSort, className }: { label: string; column: SortKey; sort: { key: SortKey; desc: boolean }; onSort: (sort: { key: SortKey; desc: boolean }) => void; className: string }) {
  const active = sort.key === column;
  return (
    <span role="columnheader" className={className} aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" className={`sort-button${active ? " is-active" : ""}`} onClick={() => onSort({ key: column, desc: active ? !sort.desc : column === "size" || column === "modified" })}>
        {label}<Icon name="chevronDown" size={13} className={active && !sort.desc ? "is-flipped" : ""} />
      </button>
    </span>
  );
}

function NameDialog({ title, label, confirm, initial = "", location, onClose, onSubmit, privateSpace = false }: { title: string; label: string; confirm: string; initial?: string; location?: string; privateSpace?: boolean; onClose: () => void; onSubmit: (value: string, destination: string) => Promise<void> }) {
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
    <Modal title={title} className={privateSpace || location && api.isPrivatePath(location) ? "private-dialog" : ""} onClose={onClose} dismissible={!busy} size={location === undefined ? "sm" : "md"}
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
