import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { useDirectory, useRenderLimit, mergeFilePages, reconcileFilePage } from "../pagination";
import { DestinationPicker, FolderPicker } from "./folders";
import { BRAND } from "../brand";
import * as api from "../api";

import { FolderStatsDialog } from "./folder-stats";
import { FileFilters, FileThumbnail, FileTile, FileVisual, FolderCover, ShareDialog, baseName, getFileKind, kindLabel, parentPath, type EntryFilter } from "../files";
import { generateLoadedThumbnails, thumbnailsFromImage, thumbnailsFromVideo, thumbnailSource, useThumbnailGenerator, videoFrameUsable } from "../thumbnails";

import { Badge, Button, Checkbox, ContextMenu, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader, SearchInput, Segmented, SkeletonRows, copyText, formatBytes, formatDate, formatDateTime, isShortcutControl, useDocumentTitle, type MenuItem } from "../ui";

import { UploadDialog, type UploadQueue } from "./uploads";
import { PrivateTransferDialog } from "./private-access";
import type { PreviewPlayback } from "../files";
import { usePrivateToast } from "./private-session";
import { usePreview } from "./preview-host";
import { FileCacheStatus, cacheMenuItems, useCacheQueue } from "./cache";
import { useFilesBridge } from "./assistant-bridge";

/* ---------- 文件 ---------- */

type Entry = { kind: "folder"; key: string; size?: number } | { kind: "file"; key: string; file: api.FileItem };
type SortKey = "name" | "type" | "size" | "modified";

/** 文件夹大小：未统计时留空，没有内容时写“空”，不显示生硬的“0 B”或“—”。 */
const folderSize = (size?: number) => size == null ? "" : size === 0 ? "空" : formatBytes(size);
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const DELETE_KEY = IS_MAC ? "⌘⌫" : "Del";
/** 图标上已经印了格式标签（PDF、DOC…）的类型，网格卡片不再重复显示扩展名。 */
const LABELLED_KINDS = new Set(["pdf", "document", "spreadsheet", "presentation"]);

const SEARCH_PAGES = 5;
const COLLATOR = new Intl.Collator("zh-CN", { numeric: true });

export function FilesView({ session, prefix, onOpenFolder, onChanged, uploads, uploadRevision, onPlayback, incoming, onIncomingTaken }: { session: api.Session; prefix: string; onOpenFolder: (prefix: string) => void; onChanged: () => void; uploads: UploadQueue; uploadRevision: number; onPlayback?: (state: PreviewPlayback) => void;
  /** 外部转交来的待上传文件（抓取脚本转交到私密空间），打开上传对话框确认后交给上传队列。 */
  incoming?: File[] | null; onIncomingTaken?: () => void }) {
  const privateSpace = api.isPrivatePath(prefix);
  const notify = usePrivateToast(privateSpace);
  const root = privateSpace ? api.PRIVATE_PREFIX : "";
  const rootName = privateSpace ? "私密空间" : "我的文件";
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "public">("all");
  const [entryFilter, setEntryFilter] = useState<EntryFilter>("all");
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
  const [statsFor, setStatsFor] = useState<{ prefix: string; title: string } | null>(null);
  const surface = useRef<HTMLElement>(null);
  const dragKeys = useRef<string[]>([]);
  const [folderOpen, setFolderOpen] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<File[] | null>(null);
  useEffect(() => { if (incoming?.length) { setPendingUpload(incoming); onIncomingTaken?.(); } }, [incoming, onIncomingTaken]);
  const [dragging, setDragging] = useState(false);
  const lastUploadRevision = useRef(uploadRevision);
  const fileInput = useRef<HTMLInputElement>(null);
  const breadcrumbNav = useRef<HTMLElement>(null);
  const dragDepth = useRef(0);
  const name = prefix !== root ? baseName(prefix) : rootName;
  useDocumentTitle(`${query ? `搜索“${query}”` : name} · ${BRAND}`);

  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => query
    ? api.searchFiles(query, cursor ?? "", filter === "public", 200, root, kind, signal)
    : api.listFiles(prefix, cursor, filter === "public", 200, kind, signal), [prefix, query, filter, kind, root]);
  // 目录连续展示全部项目；搜索最多读取 SEARCH_PAGES 页，结果过多时提示细化关键词。
  const pagination = useDirectory(fetchPage, mergeFilePages, query ? SEARCH_PAGES : Infinity, reconcileFilePage);
  const load = pagination.reload;
  /** 修改后的原地刷新：保留列表、滚动位置与选择，读完后整体替换；失败时保留原列表并提示。 */
  const refreshList = useCallback(() => pagination.refresh().then(message => { if (message) notify.error(message); }), [pagination.refresh, notify]);
  // 上传与离线下载完成后的后台刷新：静止 800 ms 后合并执行（最长等 3 秒），两次刷新至少相隔 3 秒；
  // 不显示刷新状态、不清空列表，未变化的行原地保留，避免批量任务逐个完成时列表持续闪动。
  const backgroundRefresh = useRef<{ timer?: number; since?: number; last?: number }>({});
  const quietRefresh = useRef(pagination.refresh);
  quietRefresh.current = pagination.refresh;
  const scheduleRefresh = useCallback(() => {
    const state = backgroundRefresh.current, now = Date.now();
    state.since ??= now;
    window.clearTimeout(state.timer);
    const due = Math.max(Math.min(now + 800, state.since + 3000), (state.last ?? 0) + 3000);
    state.timer = window.setTimeout(() => { state.since = undefined; state.last = Date.now(); void quietRefresh.current(true); }, Math.max(0, due - now));
  }, []);
  useEffect(() => {
    if (lastUploadRevision.current === uploadRevision) return;
    lastUploadRevision.current = uploadRevision;
    scheduleRefresh();
  }, [uploadRevision, scheduleRefresh]);
  // 离线下载完成：只有保存目录就是当前目录（或正在搜索）时才刷新。
  useEffect(() => {
    const completed = (event: Event) => {
      const folders = (event as CustomEvent<{ folders: string[] }>).detail?.folders ?? [];
      if (query || folders.includes(prefix)) scheduleRefresh();
    };
    // 其他入口（如文件助手把附件保存到我的文件）写入文件后同样按目录判断。
    window.addEventListener("tessera:downloads-completed", completed);
    window.addEventListener("tessera:files-added", completed);
    return () => { window.removeEventListener("tessera:downloads-completed", completed); window.removeEventListener("tessera:files-added", completed); };
  }, [prefix, query, scheduleRefresh]);
  useEffect(() => () => window.clearTimeout(backgroundRefresh.current.timer), []);
  const loading = pagination.loading;
  const loadError = pagination.error;
  const files = useMemo(() => (pagination.page?.objects ?? []).filter(item => !item.key.endsWith("/")), [pagination.page]);
  const folders = pagination.page?.common_prefixes ?? [];
  const publicFolders = pagination.page?.public_folders ?? {};
  const folderSizes = pagination.page?.folder_sizes ?? {};
  const folderPreviews = pagination.page?.folder_previews ?? {};
  const setFiles = (update: (files: api.FileItem[]) => api.FileItem[]) => pagination.setPage(current => current && { ...current, objects: update(current.objects) });
  const setThumbnails = (key: string, thumbnails: string[]) =>
    setFiles(current => current.map(item => item.key === key ? { ...item, thumbnails, thumbnail_versions: undefined, has_thumbnail: thumbnails.includes("thumb") } : item));
  const thumbnailGenerator = useThumbnailGenerator(files, () => { notify.success("已提交缩略图生成请求"); scheduleRefresh(); });
  // 预览打开时，把页面上最新的文件信息（补上的缩略图、覆盖后的新版本）同步给预览的当前文件与底部列表。
  useEffect(() => { preview.sync(files); }, [files, preview.sync]);
  // 等待缩略图：当前列表里有缺缩略图的图片、视频、音频时，只查询这些文件的缩略图状态（不重读整个目录），
  // 间隔 10 秒起逐次加倍到 5 分钟，页面隐藏时跳过，最长等 1 小时；文件被删除或覆盖时改为整页后台刷新。
  const waitingThumbnails = useMemo(() => files
    .filter(item => !item.thumbnails?.length && thumbnailSource(item.key, item.content_type, item.size))
    .sort((a, b) => b.modified_at - a.modified_at).slice(0, 200), [files]);
  const waitingKey = waitingThumbnails.map(item => `${item.key}\n${item.etag}`).join("\n");
  useEffect(() => {
    if (!waitingThumbnails.length || loading) return;
    let delay = 10000, timer = 0, stopped = false;
    const controller = new AbortController(), started = Date.now(), waiting = waitingThumbnails;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const { files: states } = await api.thumbnailStatus(waiting.map(item => item.key), controller.signal);
          if (stopped) return;
          if (waiting.some(item => !states[item.key] || states[item.key].etag !== item.etag)) scheduleRefresh();
          const ready = new Map(Object.entries(states).filter(([, state]) => state.thumbnails?.length));
          if (ready.size) setFiles(current => current.map(item => {
            const state = ready.get(item.key);
            return state && state.etag === item.etag ? { ...item, ...state } : item;
          }));
        } catch { if (stopped) return; }
      }
      if (stopped || Date.now() - started > 3600_000) return;
      delay = Math.min(delay * 2, 300_000);
      timer = window.setTimeout(() => void tick(), delay);
    };
    timer = window.setTimeout(() => void tick(), delay);
    return () => { stopped = true; window.clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey, loading]);
  const previewThumbnailAttempts = useRef(new Set<string>());
  function savePreviewThumbnail(item: api.FileItem, produce: () => ReturnType<typeof thumbnailsFromImage>, force = false) {
    const identity = `${item.key}:${item.etag}`;
    if (previewThumbnailAttempts.current.has(identity)) return;
    previewThumbnailAttempts.current.add(identity);
    void generateLoadedThumbnails(item, produce, force).then(thumbnails => {
      if (thumbnails) { setThumbnails(item.key, thumbnails); scheduleRefresh(); }
    }).catch(() => undefined);
  }
  const setPublicFolders = (update: (items: Record<string, api.FileItem>) => Record<string, api.FileItem>) => pagination.setPage(current => current && { ...current, public_folders: update(current.public_folders ?? {}) });
  useEffect(() => { setSelected(new Set()); }, [fetchPage, entryFilter]);
  useEffect(() => { setSearch(""); setQuery(""); }, [prefix]);
  useEffect(() => { localStorage.setItem("tgdrive:layout", layout); }, [layout]);
  useEffect(() => {
    // 深路径始终先展示当前位置；祖先目录仍可横向滚动或通过键盘访问。
    const nav = breadcrumbNav.current;
    if (!nav) return;
    const revealCurrent = () => { nav.scrollLeft = nav.scrollWidth; };
    revealCurrent();
    // 同时观察导航与其内容：字体加载完成或目录名变化只改变内容宽度，导航本身的尺寸不变。
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(nav);
    if (nav.firstElementChild) observer.observe(nav.firstElementChild);
    return () => observer.disconnect();
  }, [prefix, query]);

  const entries = useMemo<Entry[]>(() => {
    const direction = sort.desc ? -1 : 1;
    // 名称与类型先算好再排序：大目录有数千项，比较函数里重复解析会拖慢每次提交。
    const fileEntries = files
      .filter(file => filter === "all" || file.public_token)
      .map(file => ({ file, name: baseName(file.key), type: sort.key === "type" ? kindLabel(getFileKind(file.content_type, file.key)) : "" }))
      .sort((a, b) => {
        const name = COLLATOR.compare(a.name, b.name);
        const primary = sort.key === "size" ? a.file.size - b.file.size : sort.key === "modified" ? a.file.modified_at - b.file.modified_at
          : sort.key === "type" ? COLLATOR.compare(a.type, b.type) : name;
        return direction * (primary || name);
      })
      .map(({ file }) => ({ kind: "file" as const, key: file.key, file }));
    const folderEntries = [...folders].filter(key => filter === "all" || publicFolders[key])
      .sort((a, b) => sort.key === "size"
        ? direction * ((folderSizes[a] ?? 0) - (folderSizes[b] ?? 0)) || COLLATOR.compare(a, b)
        : (sort.key === "name" ? direction : 1) * COLLATOR.compare(a, b))
      .map(key => ({ kind: "folder" as const, key, size: folderSizes[key] }));
    return [...(entryFilter === "file" ? [] : folderEntries), ...(entryFilter === "folder" ? [] : fileEntries)];
  }, [files, folders, publicFolders, folderSizes, filter, sort, entryFilter]);
  useEffect(() => {
    if (loading || pagination.loadingMore || loadError) return;
    const keys = new Set(entries.map(entry => entry.key));
    setSelected(current => {
      const next = new Set([...current].filter(key => keys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [entries, loading, pagination.loadingMore, loadError]);
  function openPreview(file: api.FileItem) {
    // 打开文件时记录当前结果顺序作为播放列表；预览挂在应用外壳上，切换页面后继续播放。
    preview.open({ file, url: api.contentUrl(file.key), downloadUrl: api.contentUrl(file.key, true), assetUrl: key => api.contentUrl(key),
      playlistFiles: entries.flatMap(entry => entry.kind === "file" ? [entry.file] : []),
      poster: api.fileThumbnail(file, "poster"), thumbnail: api.fileThumbnail(file), onPlaybackActivity: onPlayback,
      onShare: privateSpace ? undefined : item => { preview.update(item); setSharing(item); },
      onImageLoad: (image, item) => {
        // 预览过的图片顺便补上缩略图和封面图（例如通过 S3 上传、没有缩略图的图片），不必再下载一次原图。
        // 只在能补上缺少的规格时生成（阈值与 thumbnails.ts 的 renderSet 一致）：没有小图；原图超过 240px 却没有网格图或封面；
        // 原图超过 800px 却没有封面。旧版文件的 960px 封面可以代替网格图，不重复生成；矢量图跳过。
        const longest = Math.max(image.naturalWidth, image.naturalHeight), has = (variant: string) => item.thumbnails?.includes(variant);
        const missing = !has("thumb") || (longest > 240 && !has("grid") && !has("poster")) || (longest > 800 && !has("poster"));
        if (!missing || /\.svg$/i.test(item.key)) return;
        savePreviewThumbnail(item, () => thumbnailsFromImage(image), true);
      },
      onVideoFrame: (video, item) => {
        // 等到当前画面不是片头黑屏再截取；画面来自播放器已经解码的数据，不额外读取视频。
        if (item.thumbnails?.length || previewThumbnailAttempts.current.has(`${item.key}:${item.etag}`) || !videoFrameUsable(video)) return;
        const source = video.currentSrc;
        savePreviewThumbnail(item, () => video.currentSrc === source ? thumbnailsFromVideo(video) : Promise.resolve(null));
      },
    });
  }
  // 文件助手的浏览器工具读取当前目录、可见条目与选中状态（私密空间不登记）。
  // 私密空间也登记（prefix 带私密前缀），只有私密对话读取。
  useFilesBridge(!query, prefix, {
    ready: () => !loading && !pagination.loadingMore && !loadError && pagination.page !== null,
    visible: () => entries.slice(0, 200).map(entry => ({ key: entry.key, size: entry.kind === "file" ? entry.file.size : entry.size })),
    total: () => entries.length,
    selected: () => [...selected],
    select: keys => { const found = keys.filter(key => entries.some(entry => entry.key === key)); setSelected(new Set(found)); return found.length; },
    preview: key => { const entry = entries.find(item => item.key === key && item.kind === "file"); if (entry?.kind !== "file") return false; openPreview(entry.file); return true; },
  });
  /** 文件夹的分享信息保存在它的目录标记上；还没公开过的文件夹用一个占位对象打开分享对话框。 */
  const folderItem = (key: string): api.FileItem => publicFolders[key] ?? { key, size: 0, etag: "", content_type: "application/x-directory", modified_at: 0 };
  const selectedEntries = entries.filter(entry => selected.has(entry.key));
  const selectedFiles = selectedEntries.filter((entry): entry is Extract<Entry, { kind: "file" }> => entry.kind === "file");
  const downloadLimit = () => notify.error("一次最多打包 200 项，请减少选择，或直接下载整个文件夹");

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
      await refreshList(); onChanged();
      notify.success(targets.length === 1 ? `已将“${baseName(targets[0].key)}”移到回收站` : `已将 ${targets.length} 项移到回收站`, {
        label: "撤销",
        onClick: () => void api.restoreTrash(items.map(item => item.id), root)
          .then(() => { notify.success("已撤销删除"); return refreshList(); }).then(onChanged)
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
    await refreshList();
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
      { label: "下载", icon: "download", onSelect: () => undefined, href: api.versionedContentUrl(api.contentUrl(file.key, true), file.etag) },
      ...cacheMenuItems(cacheQueue, file).filter(item => !item.danger),
      ...(!privateSpace ? [{ label: file.public_token ? "管理分享" : "公开分享", icon: "link" as const, shortcut: "S", onSelect: () => setSharing(file) }] : []),
    ];
    if (thumbnailSource(file.key, file.content_type, file.size)) {
      const state = thumbnailGenerator.state(file);
      const failed = state?.phase === "failed";
      const pending = state?.phase === "queued";
      if (failed) items.push({ label: "查看缩略图失败原因", icon: "info", heading: "缩略图", onSelect: () => notify.info(state.message) });
      items.push({ label: pending ? state.message : failed ? "重试生成缩略图" : file.thumbnails?.length ? "重新生成缩略图" : "生成缩略图", icon: "refresh", heading: failed ? undefined : "缩略图", disabled: pending,
        onSelect: () => void thumbnailGenerator.generate(file) });
    }
    if (file.public_token) items.push({ label: "打开分享页", icon: "external", onSelect: () => window.open(api.publicLinks(file.public_token!, baseName(file.key), session.public_base_url).page, "_blank", "noreferrer") });
    if (file.public_token) items.push({ label: "复制分享链接", icon: "copy", onSelect: () => void copyText(api.publicLinks(file.public_token!, baseName(file.key), session.public_base_url).page, "分享链接已复制") });
    items.push({ label: "重命名", icon: "edit", shortcut: "F2", onSelect: () => setRenaming(entry) });
    items.push({ label: "移动到…", icon: "move", onSelect: () => setMoving([entry]) });
    items.push({ label: privateSpace ? "移出到我的文件…" : "移入私密空间…", icon: "lock", onSelect: () => setTransferring([entry]) });
    if (query) items.push({ label: "打开所在文件夹", icon: "folder", onSelect: () => onOpenFolder(parentPath(file.key)) });
    items.push(...cacheMenuItems(cacheQueue, file).filter(item => item.danger));
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
      { label: "目录统计", icon: "chart", onSelect: () => setStatsFor({ prefix: key, title: baseName(key) }) },
      ...(!privateSpace ? [{ label: shared ? "管理分享" : "公开分享", icon: "link" as const, shortcut: "S", onSelect: () => setSharing(folderItem(key)) }] : []),
      ...(shared ? [{ label: "打开分享页", icon: "external" as const, onSelect: () => window.open(api.publicLinks(shared.public_token!, baseName(key), session.public_base_url).page, "_blank", "noreferrer") }] : []),
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
    ? api.versionedContentUrl(api.contentUrl(targets[0].key, true), targets[0].file.etag) : api.archiveUrl(targets.map(target => target.key));
  useEffect(() => { setCursor(current => current && entries.some(entry => entry.key === current) ? current : null); }, [entries]);
  const rendered = useRenderLimit(entries, fetchPage);
  // 列表只显示手动缓存的状态（索引由 CacheTasksProvider 统一读取），不逐个文件查询本机缓存。
  const cacheQueue = useCacheQueue();
  // 焦点项可能还没挂载（End、跨批移动）：先放宽渲染范围，等它出现在 DOM 后只滚动一次，之后滚动加载不再拉回焦点。
  const pendingScroll = useRef<string | null>(null);
  useEffect(() => {
    if (!cursor) return;
    pendingScroll.current = cursor;
    rendered.reveal(entries.findIndex(entry => entry.key === cursor));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);
  useEffect(() => {
    const key = pendingScroll.current;
    const node = key && surface.current?.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!node) return;
    pendingScroll.current = null;
    node.scrollIntoView({ block: "nearest" });
  }, [cursor, rendered.visible]);

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
  // 最近一次是否用 Tab 移动了焦点：只有这时按钮上的空格／回车才交给按钮。鼠标点过的按钮会残留焦点，弹窗关闭（含 Esc）
  // 也会把焦点还给触发按钮，浏览器的 :focus-visible 无法区分；点击页面或用方向键移动焦点项都算回到列表。
  const tabbed = useRef(false);
  handleKey.current = event => {
    if (event.key === "Tab") { tabbed.current = true; return; }
    if (event.defaultPrevented || event.isComposing || document.body.classList.contains("has-modal") || context) return;
    const target = event.target as Element;
    if (target instanceof Element && (isShortcutControl(target) || target.closest(".modal, .tray-stack, .sidebar"))) return;
    const control = target instanceof Element ? target.closest("button, a, summary, [role='button']") : null;
    if ((event.key === " " || event.key === "Enter") && control && tabbed.current) return;
    const mod = event.metaKey || event.ctrlKey;
    const current = entries.find(entry => entry.key === cursor) ?? null;
    const arrows: Record<string, "up" | "down" | "left" | "right"> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    let handled = true;
    if (event.key === "ArrowUp" && (IS_MAC ? event.metaKey : event.altKey) && !event.shiftKey) {
      if (query || prefix === root) handled = false;
      else onOpenFolder(parentPath(prefix));
    } else if ((event.key === "Home" || event.key === "End") && !mod && entries.length) {
      const next = (event.key === "Home" ? entries[0] : entries[entries.length - 1]).key;
      if (next && event.shiftKey) setSelected(value => new Set([...value, ...(cursor ? [cursor] : []), next]));
      setCursor(next);
    } else if (event.key === "/" && !mod) {
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
    } else if (event.key === " " && !mod) {
      // 还没有焦点项时先落到第一项，避免空格激活残留焦点的按钮或滚动页面。
      if (current) toggleSelect(current.key, !selected.has(current.key));
      else setCursor(neighbour(null, "down"));
    } else if (event.key === "Enter" && current && !mod) {
      openEntry(current);
    } else if ((event.key === "s" || event.key === "S") && !mod && !event.altKey && !event.shiftKey && current && !privateSpace) {
      setSharing(current.kind === "folder" ? folderItem(current.key) : current.file);
    } else if (event.key === "F2" && current) {
      setRenaming(current);
    } else if ((event.key === "Delete" || (event.key === "Backspace" && (mod || !IS_MAC))) && (selected.size || current)) {
      void moveToTrash(selected.size ? selectedEntries : [current!]);
    } else handled = false;
    if (handled) { event.preventDefault(); tabbed.current = false; document.documentElement.dataset.input = "keyboard"; }
    // 残留焦点的按钮不响应回车（例如刚关闭的弹窗的触发按钮）。
    else if (event.key === "Enter" && control) event.preventDefault();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKey.current(event);
    const pointer = () => { tabbed.current = false; };
    document.addEventListener("keydown", listener);
    document.addEventListener("pointerdown", pointer, true);
    return () => { document.removeEventListener("keydown", listener); document.removeEventListener("pointerdown", pointer, true); };
  }, []);
  /** 右键：点在已选中的多项之一上时对整个选择操作，否则只针对这一项。 */
  function contextItems(key: string): MenuItem[] {
    if (selected.size > 1 && selected.has(key)) {
      return [
        { label: `下载 ${selected.size} 项（ZIP）`, icon: "download", onSelect: selectedEntries.length > 200 ? downloadLimit : () => undefined,
          href: selectedEntries.length > 200 ? undefined : downloadUrl(selectedEntries) },
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
            {selectedEntries.length > 200 ? <Button size="sm" icon="download" onClick={downloadLimit}>下载</Button>
              : <a className="btn btn-secondary btn-sm" href={downloadUrl(selectedEntries)}><Icon name="download" size={15} /><span>下载</span></a>}
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
            <label className={`mobile-file-sort${layout === "grid" ? " is-grid-sort" : ""}`}><span className="sr-only">排序</span><select aria-label="排序" value={`${sort.key}:${sort.desc ? "desc" : "asc"}`} onChange={event => {
              const [key, direction] = event.target.value.split(":"); setSort({ key: key as SortKey, desc: direction === "desc" });
            }}><option value="name:asc">名称升序</option><option value="name:desc">名称降序</option><option value="type:asc">类型升序</option><option value="type:desc">类型降序</option><option value="size:desc">容量从大到小</option><option value="size:asc">容量从小到大</option><option value="modified:desc">最近修改优先</option><option value="modified:asc">最早修改优先</option></select><Icon name="chevronDown" size={14} /></label>
            <IconButton icon="chart" label="目录统计" variant="secondary" className="toolbar-stats" onClick={() => setStatsFor({ prefix, title: name })} />
            <IconButton icon="refresh" label="刷新" variant="secondary" spinning={pagination.refreshing} disabled={loading} onClick={() => void refreshList()} />
            <Segmented label="视图" value={layout} onChange={setLayout} options={[{ value: "list", label: "列表视图", icon: "list" }, { value: "grid", label: "网格视图", icon: "gridView" }]} />
          </div>
        </div>
      )}

      <FileFilters entry={entryFilter} kind={kind} onEntryChange={setEntryFilter} onKindChange={setKind} />

      <section ref={surface} className={`file-surface${layout === "grid" && !loading && !loadError && entries.length > 0 ? " is-grid" : ""}${dragging ? " is-dragging" : ""}`} aria-label="文件列表">
        {loading ? <SkeletonRows rows={6} /> : loadError ? (
          <EmptyState icon="alert" title="文件列表加载失败" description={loadError} action={<Button icon="refresh" onClick={() => void load()}>重试</Button>} />
        ) : entries.length === 0 ? (
          entryFilter === "folder" ? <EmptyState icon="folder" title="没有符合条件的文件夹" description={query ? "搜索目前按文件名查找文件；清除搜索可浏览当前目录的文件夹。" : "当前目录没有符合筛选条件的文件夹。"} action={<Button onClick={() => setEntryFilter("all")}>显示全部项目</Button>} />
          : entryFilter === "file" && !kind && !query ? <EmptyState icon="file" title="这个目录没有符合条件的文件" description="文件筛选只看当前目录，不包含子文件夹中的内容。" action={<Button onClick={() => setEntryFilter("all")}>显示全部项目</Button>} />
          : kind && !query ? <EmptyState icon="search" title={`${filter === "public" ? "这个文件夹里没有公开的" : "这个文件夹里没有"}${api.kindFilterLabel(kind)}`} description="类型筛选只看当前文件夹，不包含子文件夹；搜索时会在全部文件中按类型查找。" action={<Button onClick={() => setKind("")}>显示全部类型</Button>} />
          : query ? <EmptyState icon="search" title={`没有找到包含“${query}”的${kind ? api.kindFilterLabel(kind) : "文件"}`} description="换个关键词，或检查拼写。" action={<Button onClick={() => { setSearch(""); setQuery(""); }}>清除搜索</Button>} />
            : filter === "public" ? <EmptyState icon="globe" title="这个文件夹里没有公开内容" description="在文件或文件夹的菜单中选择“公开分享”，即可生成任何人可访问的链接。" />
              : <EmptyState icon="upload" title={prefix ? "这个文件夹是空的" : "上传你的第一个文件"} description="把文件拖到这里，或点击上传按钮。" action={<Button icon="upload" onClick={() => fileInput.current?.click()}>选择文件</Button>} />
        ) : layout === "list" ? (
          <div className="data-table file-table" role="table" aria-label="文件">
            <div className="data-row data-head" role="row">
              <span role="columnheader" className="cell-check"><Checkbox label="全选当前结果" checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={value => setSelected(value ? new Set(entries.map(entry => entry.key)) : new Set())} /></span>
              <SortHeader label="名称" column="name" sort={sort} onSort={setSort} className="cell-name" />
              <SortHeader label="类型" column="type" sort={sort} onSort={setSort} className="cell-type" />
              <SortHeader label="大小" column="size" sort={sort} onSort={setSort} className="cell-size" />
              <SortHeader label="修改时间" column="modified" sort={sort} onSort={setSort} className="cell-date" />
              <span role="columnheader" className="cell-actions"><span className="sr-only">操作</span></span>
            </div>
            {rendered.visible.map(entry => entry.kind === "folder" ? (
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
                    <span className="file-mobile-meta"><span>{kindLabel(getFileKind(entry.file.content_type, entry.key))} · {formatBytes(entry.file.size)} · {formatDate(entry.file.modified_at)}</span>{entry.file.public_token && <Badge tone="public" icon="globe">公开</Badge>}<FileCacheStatus file={entry.file} /></span>
                    {query && parentPath(entry.key) && <small>{privateSpace ? api.privatePathLabel(parentPath(entry.key)) : parentPath(entry.key)}</small>}
                  </span>
                  {entry.file.public_token && <Badge tone="public" icon="globe">公开</Badge>}
                  <FileCacheStatus file={entry.file} className="cell-cache" />
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
          // 网格：文件夹是紧凑的横向卡片（左侧用内部图片拼成封面，名称最多两行），文件才用缩略图卡片，避免文件夹占满一屏的大空卡片。
          const folderEntries = rendered.visible.filter((entry): entry is Extract<Entry, { kind: "folder" }> => entry.kind === "folder");
          const fileEntries = rendered.visible.filter((entry): entry is Extract<Entry, { kind: "file" }> => entry.kind === "file");
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
                        <FolderCover previews={(folderPreviews[entry.key] ?? []).flatMap(item => { const url = api.fileThumbnail(item); return url ? [{ key: item.key, url }] : []; })} />
                        <span className="folder-card-check" onClick={event => event.stopPropagation()}><Checkbox label={`选择 ${baseName(entry.key)}`} checked={isSelected} onChange={value => toggleSelect(entry.key, value)} /></span>
                      </span>
                      <span className="folder-card-copy">
                        <button type="button" className="name-button folder-card-name" title={baseName(entry.key)} onClick={event => { event.stopPropagation(); onOpenFolder(entry.key); }}><span className="folder-card-name-text">{baseName(entry.key)}</span></button>
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
                        <FileThumbnail kind={kind} url={api.fileThumbnail(entry.file, "grid")} placeholder={api.fileThumbnail(entry.file)} />
                        {!api.fileThumbnail(entry.file) && extension && !LABELLED_KINDS.has(kind) && <span className="grid-extension" aria-hidden="true">{extension}</span>}
                        <span className="grid-check" onClick={event => event.stopPropagation()}><Checkbox label={`选择 ${baseName(entry.key)}`} checked={isSelected} onChange={value => toggleSelect(entry.key, value)} /></span>
                        {entry.file.public_token && <span className="grid-public"><Badge tone="public" icon="globe">公开</Badge></span>}
                        <FileCacheStatus file={entry.file} className="grid-cache" />
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
        {rendered.more && !loading && !loadError && <div ref={rendered.sentinel} className="list-sentinel" aria-hidden="true" />}
        {dragging && <div className="drop-overlay" aria-hidden="true"><Icon name="upload" size={28} /><strong>松开以上传到“{name}”</strong></div>}
      </section>

      <footer className="list-footer">
        <span className="list-footer-summary">{loading ? "正在加载" : [entries.some(item => item.kind === "folder") && `${entries.filter(item => item.kind === "folder").length} 个文件夹`, entries.some(item => item.kind === "file") && `${entries.filter(item => item.kind === "file").length} 个文件`, entries.some(item => item.kind === "file") && formatBytes(entries.reduce((sum, item) => sum + (item.kind === "file" ? item.file.size : 0), 0))].filter(Boolean).join(" · ") || (kind || entryFilter !== "all" || filter === "public" ? "没有符合条件的项目" : "空文件夹")}
          {!loading && !query && <button type="button" className="link-button" onClick={() => setStatsFor({ prefix, title: name })}><Icon name="chart" size={14} /><span>目录统计</span></button>}</span>
        <span className="list-footer-end">
          {pagination.loadingMore ? <span role="status">正在读取其余项目…</span>
            : pagination.truncated && <span role="status">仅显示前 {SEARCH_PAGES * 200} 个结果，请细化关键词</span>}
          <button type="button" className="link-button shortcut-hint" onClick={() => setShortcutsOpen(true)} aria-keyshortcuts="?"><Icon name="keyboard" size={15} /><span>快捷键</span></button>
        </span>
      </footer>

      {context && <ContextMenu x={context.x} y={context.y} label={`${baseName(context.key)} 的操作`} items={contextItems(context.key)} onClose={() => setContext(null)} />}
      {statsFor && <FolderStatsDialog prefix={statsFor.prefix} title={statsFor.prefix === root ? rootName : api.privatePathLabel(statsFor.prefix).replace(/\/$/, "")} onClose={() => setStatsFor(null)} onOpenFolder={onOpenFolder} />}
      {shortcutsOpen && <Modal title="键盘快捷键" icon="keyboard" size="sm" onClose={() => setShortcutsOpen(false)} footer={<Button onClick={() => setShortcutsOpen(false)}>知道了</Button>}>
        <KeyValue items={[
          [<kbd>/</kbd>, "搜索文件"],
          [<><kbd>↑</kbd> <kbd>↓</kbd>{layout === "grid" && <> <kbd>←</kbd> <kbd>→</kbd></>}</>, "移动焦点；按住 Shift 连续选择"],
          [<><kbd>Home</kbd> <kbd>End</kbd></>, "跳到第一项／最后一项"],
          [<kbd>↵</kbd>, "打开文件或文件夹"],
          [<kbd>{IS_MAC ? "⌘ ↑" : "Alt ↑"}</kbd>, "返回上一级文件夹"],
          [<kbd>空格</kbd>, "选中或取消选中"],
          [<kbd>{IS_MAC ? "⌘" : "Ctrl"} A</kbd>, "全选当前结果"],
          ...(!privateSpace ? [[<kbd>S</kbd>, "公开分享或管理分享"] as [ReactNode, ReactNode]] : []),
          [<kbd>F2</kbd>, "重命名"],
          [<kbd>{DELETE_KEY}</kbd>, "移到回收站"],
          [<kbd>Esc</kbd>, "取消选择"],
          [<kbd>?</kbd>, "显示本说明"],
        ]} />
      </Modal>}

      {pendingUpload && <UploadDialog files={pendingUpload} destination={prefix} onClose={() => setPendingUpload(null)}
        onStart={(list, isPublic, destination) => { setPendingUpload(null); uploads.enqueue(list.map(file => ({ file, path: `${destination}${file.name}`, isPublic }))); }} />}
      {folderOpen && <NameDialog title="新建文件夹" label="文件夹名称" confirm="创建" location={prefix} onClose={() => setFolderOpen(false)}
        onSubmit={async (value, destination) => { await api.makeFolder(`${destination}${value}`); notify.success(`已创建文件夹“${value}”`); setFolderOpen(false); await refreshList(); }} />}
      {renaming && <NameDialog privateSpace={privateSpace} title={renaming.kind === "folder" ? "重命名文件夹" : "重命名文件"} label="新名称" confirm="重命名" initial={baseName(renaming.key)} onClose={() => setRenaming(null)}
        onSubmit={async value => {
          const folder = renaming.kind === "folder";
          const target = `${parentPath(renaming.key)}${value}${folder ? "/" : ""}`;
          if (target === renaming.key) { setRenaming(null); return; }
          // 重命名不合并：目标已存在时直接提示，而不是并入同名文件夹。
          if (entries.some(entry => entry.key === target)) throw new Error("这个位置已有同名项目");
          const result = await api.moveFile(renaming.key, target, "skip");
          if (!result.moved || result.skipped) throw new Error("这个位置已有同名项目");
          notify.success(`已重命名为“${value}”`); setRenaming(null); await refreshList();
        }} />}
      {moving && <MoveDialog targets={moving} startPrefix={query ? root : prefix} onClose={() => setMoving(null)}
        onMove={async (dest, conflict) => { await moveEntries(moving, dest, conflict); setMoving(null); }} />}
      {transferring && <PrivateTransferDialog paths={transferring.map(item => item.key)} into={!privateSpace} onClose={() => setTransferring(null)} onDone={() => { setSelected(new Set()); void refreshList(); onChanged(); }} />}
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
