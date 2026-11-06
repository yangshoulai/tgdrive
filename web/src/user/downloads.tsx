import { useCallback, useEffect, useRef, useState } from "react";
import { BRAND } from "../brand";
import * as api from "../api";
import { useCursorPage, usePageSize } from "../pagination";
import { Notice, Badge, Button, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, Menu, Modal, PageHeader, Pagination, Progress, SearchInput, Segmented, SkeletonRows, copyText, formatBytes, formatDate, formatDateTime, toast, useDocumentTitle, type Tone } from "../ui";
import { FileTile, FileVisual, getFileKind } from "../files";
import { DestinationPicker, FolderPicker } from "./folders";
import { PrivateUnlockDialog } from "./private-unlock";
import { usePrivateAccess } from "./private-session";
import { LocationText, TaskStats, remainingText } from "./task-list";
import { CoverPickerDialog } from "./thumbnail-editor";
import { DiagnosisMetrics, DiagnosisRow, DiagnosisSection, DiagnosisVerdictNotice, seconds as elapsedText, useDiagnosticsEnabled, type DiagnosisVerdict } from "./diagnosis";
import { imageThumbnailSet } from "../thumbnails";

const LABEL: Record<api.DownloadStatus, string> = { queued: "排队中", running: "下载中", interrupted: "等待恢复", stopped: "已停止", completed: "已完成", failed: "失败" };
const TONE: Record<api.DownloadStatus, Tone> = { queued: "neutral", running: "accent", interrupted: "warning", stopped: "neutral", completed: "success", failed: "danger" };
/** 网页每页最多 100 个任务（服务端 OfflineDownloads.list 的上限）。 */
const DOWNLOAD_PAGE_SIZES = [20, 50, 100, 200, 500];
const DOWNLOAD_PAGE_SIZE_KEY = "tessera-download-page-size";
export const isActiveDownload = (task: api.DownloadTask) => ["queued", "running", "interrupted"].includes(task.status);
const active = isActiveDownload;
export const downloadGlyph = (task: api.DownloadTask) => /\.(m4a|mp3|aac|flac|ogg|opus|wav)$/i.test(task.key) ? "audio" as const
  : task.kind === "hls" || /\.(mp4|m4v|mov|webm|mkv)$/i.test(task.key) ? "video" as const
    : /\.(jpe?g|png|webp|gif)$/i.test(task.key) ? "image" as const : "file" as const;
/** 进度百分比；总大小未知时返回 null，不显示虚构进度。 */
export const downloadPercent = (task: api.DownloadTask) => task.status === "completed" ? 100 : task.kind === "hls" && task.duration ? Math.min(95, task.processed_seconds / task.duration * 95) : task.size ? Math.min(99, task.received / task.size * 100) : null;
export const downloadStatusLabel = (task: api.DownloadTask) => task.status === "running" && task.phase ? { resolving: "解析来源", downloading: "下载媒体", merging: "合并音视频", saving: "完成保存" }[task.phase]
  : task.status === "queued" && task.priority > 0 ? "优先排队" : LABEL[task.status];
export const parentFolder = (key: string) => key.includes("/") ? key.slice(0, key.lastIndexOf("/")) + "/" : "";
export const downloadTaskName = (task: Pick<api.DownloadTask, "key" | "private">) => task.private && !api.isPrivatePath(task.key) ? "私密空间下载" : task.key.split("/").at(-1) ?? task.key;
const hasVisibleDownloadPath = (task: api.DownloadTask) => !task.key.startsWith(".tgdrive/") || task.private && api.isPrivatePath(task.key);
export const canOpenDownloadFolder = (task: api.DownloadTask) => !task.trashed && hasVisibleDownloadPath(task);
export const downloadTaskFolder = (task: api.DownloadTask) => task.private && !api.isPrivatePath(task.key) ? api.PRIVATE_PREFIX : hasVisibleDownloadPath(task) ? parentFolder(task.key) : "";
const elapsed = (value: number) => value < 1 ? "不到 1 秒" : value < 60 ? `${Math.round(value)} 秒` : value < 3600 ? `${Math.floor(value / 60)} 分 ${Math.round(value % 60)} 秒` : `${Math.floor(value / 3600)} 小时 ${Math.round(value % 3600 / 60)} 分`;
/** 完整来源地址：列表只带不含查询串的地址，有省略参数时再向服务端读取。 */
const fullSource = async (task: api.DownloadTask) => task.source && !task.source.has_query ? task.source.url : (await api.downloadSource(task.id, task.private)).url;
async function copySource(task: api.DownloadTask) {
  // Safari 要求在点击当下写剪贴板：用 ClipboardItem 承接异步读取的结果。
  if (task.source?.has_query && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": fullSource(task).then(url => new Blob([url], { type: "text/plain" })) })]);
      toast.success("来源链接已复制");
    } catch (reason) { toast.error(api.errorMessage(reason, "无法复制来源链接")); }
    return;
  }
  try { await copyText(await fullSource(task), "来源链接已复制"); }
  catch (reason) { toast.error(api.errorMessage(reason, "无法读取来源链接")); }
}
function openSource(task: api.DownloadTask) {
  if (task.source && !task.source.has_query) { window.open(task.source.url, "_blank", "noopener,noreferrer"); return; }
  // 先在点击当下打开空白页，避免读取完整地址后被浏览器当成弹窗拦截。
  const view = window.open("", "_blank");
  if (view) view.opener = null;
  void fullSource(task).then(url => { if (view) view.location.replace(url); else window.open(url, "_blank", "noopener,noreferrer"); })
    .catch(reason => { view?.close(); toast.error(api.errorMessage(reason, "无法读取来源链接")); });
}
export const seconds = (value: number) => value >= 3600 ? `${Math.ceil(value / 3600)} 小时` : value >= 60 ? `${Math.ceil(value / 60)} 分钟` : `${Math.ceil(value)} 秒`;

type DownloadCounts = { active: number; completed: number; failed: number; stopped: number; speed: number; left: number };

/** 概览卡片的数量来自服务端聚合（每种状态只取 1 条读 total），速度取进行中的前 100 个任务；有任务进行时 5 秒刷新一次。 */
function useDownloadCounts(revision: number) {
  const [counts, setCounts] = useState<DownloadCounts | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const refresh = () => setTick(value => value + 1);
    window.addEventListener("tessera:downloads-changed", refresh);
    return () => window.removeEventListener("tessera:downloads-changed", refresh);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const read = async () => {
      if (document.visibilityState === "hidden") { timer = window.setTimeout(read, 5000); return; }
      try {
        const [running, completed, failed, stopped] = await Promise.all([
          api.listDownloads(null, "active", controller.signal, "", { limit: 100 }),
          ...(["completed", "failed", "stopped"] as const).map(status => api.listDownloads(null, status, controller.signal, "", { limit: 1 })),
        ]);
        const speed = running.tasks.reduce((sum, task) => sum + (task.status === "running" ? task.speed : 0), 0);
        const left = running.tasks.reduce((sum, task) => sum + (task.size ? Math.max(0, task.size - task.received) : 0), 0);
        setCounts({ active: running.total, completed: completed.total, failed: failed.total, stopped: stopped.total, speed, left });
        timer = window.setTimeout(read, running.total ? 5000 : 30000);
      } catch { if (!controller.signal.aborted) timer = window.setTimeout(read, 15000); }
    };
    void read();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [revision, tick]);
  return counts;
}

/** 任务中心 · 离线下载：交给服务器下载，关闭网页后继续。 */
export function DownloadsView({ onChanged, onOpenFolder, onCreated }: { onChanged: () => void; onOpenFolder: (prefix: string, privateSpace?: boolean) => void; onCreated?: () => void }) {
  useDocumentTitle(`离线下载 · ${BRAND}`);
  const [filter, setFilter] = useState("");
  const counts = useDownloadCounts(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search.trim()), 300); return () => window.clearTimeout(timer); }, [search]);
  const [newTask, setNewTask] = useState(false);
  // 资源抓取脚本选择私密空间等需要网页确认的目标时，把解析结果放在地址片段里打开本页。
  const [imported, setImported] = useState<api.DownloadImport | null>(() => api.takeDownloadImport());
  const [edit, setEdit] = useState<api.DownloadTask | null>(null);
  const [confirm, setConfirm] = useState<{ task: api.DownloadTask; action: "stop" | "resume" | "restart" | "delete" } | null>(null);
  const [busy, setBusy] = useState(new Set<number>());
  const [clearing, setClearing] = useState<"completed" | "failed" | null>(null);
  const [selected, setSelected] = useState(new Set<number>());
  const [bulk, setBulk] = useState<"stop" | "delete" | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [now, setNow] = useState<api.DownloadTask | null>(null);
  const [relocating, setRelocating] = useState<api.DownloadTask[] | null>(null);
  const [diagnosing, setDiagnosing] = useState<number | null>(null);
  const diagnostics = useDiagnosticsEnabled();
  const cursor = useRef<string | null>(null), epoch = useRef(0);
  const previous = useRef(new Map<number, api.DownloadStatus>());
  const { pageSize, changePageSize, sizes } = usePageSize(DOWNLOAD_PAGE_SIZE_KEY, DOWNLOAD_PAGE_SIZES, 50);
  const fetchPage = useCallback((next: string | null) => { cursor.current = next; epoch.current++; return api.listDownloads(next, filter, undefined, query, { limit: pageSize }); }, [filter, query, pageSize]);
  const pagination = useCursorPage(fetchPage);
  useEffect(() => {
    const lockPrivate = () => {
      epoch.current++;
      if (!pagination.page) return;
      pagination.setPage({ ...pagination.page, tasks: pagination.page.tasks.map(task => task.private ? { ...task, key: "私密空间下载" } : task) });
      void pagination.reload();
    };
    window.addEventListener("tessera:private-locked", lockPrivate);
    return () => window.removeEventListener("tessera:private-locked", lockPrivate);
  }, [pagination.page, pagination.setPage, pagination.reload]);
  const hasActive = pagination.page?.tasks.some(active) ?? true;
  useEffect(() => {
    let alive = true, polling = false;
    const controller = new AbortController();
    // 没有进行中的任务时放慢轮询；新建或继续任务后会立即重新读取列表。
    const timer = window.setInterval(() => {
      if (polling || document.visibilityState === "hidden") return;
      polling = true;
      const revision = epoch.current;
      void api.listDownloads(cursor.current, filter, controller.signal, query, { limit: pageSize }).then(page => {
        if (alive && revision === epoch.current) pagination.setPage(page);
      }).catch(() => undefined).finally(() => { polling = false; });
    }, hasActive ? 3000 : 15000);
    return () => { alive = false; window.clearInterval(timer); controller.abort(); };
  }, [filter, query, pageSize, pagination.setPage, hasActive]);
  const page = pagination.page;
  // 切换筛选或搜索后清空选择；翻页与轮询时只保留仍在当前页的任务。
  useEffect(() => setSelected(new Set()), [filter, query]);
  useEffect(() => {
    if (!page) return;
    setSelected(current => {
      const ids = new Set(page.tasks.map(task => task.id));
      return [...current].every(id => ids.has(id)) ? current : new Set([...current].filter(id => ids.has(id)));
    });
  }, [page]);
  const chosen = page?.tasks.filter(task => selected.has(task.id)) ?? [];
  const allSelected = Boolean(page?.tasks.length) && chosen.length === page?.tasks.length;
  async function runBulk(action: "stop" | "resume" | "delete") {
    if (!chosen.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      const { done, skipped } = await api.batchDownloads(action, chosen.map(task => task.id), chosen.some(task => task.private));
      window.dispatchEvent(new Event("tessera:downloads-changed"));
      setBulk(null); setSelected(new Set());
      const verb = action === "stop" ? "停止" : action === "delete" ? "删除" : "加入下载队列";
      const note = skipped ? `，${skipped} 个已跳过${action === "resume" ? "（POST 任务需逐个确认）" : ""}` : "";
      if (done) toast.success(`已${verb} ${done} 个任务${note}`); else toast.info(`没有可${action === "resume" ? "继续" : verb}的任务${note}`);
      await pagination.reload();
    } catch (reason) { toast.error(api.errorMessage(reason, "批量操作失败，请稍后重试")); }
    finally { setBulkBusy(false); }
  }
  useEffect(() => {
    for (const task of page?.tasks ?? []) {
      if (task.status === "completed" && previous.current.has(task.id) && previous.current.get(task.id) !== "completed") onChanged();
      previous.current.set(task.id, task.status);
    }
    if (previous.current.size > 500) previous.current.clear();
  }, [page, onChanged]);
  async function control(task: api.DownloadTask, action: "stop" | "resume" | "restart" | "delete") {
    if (busy.has(task.id)) return;
    setBusy(current => new Set(current).add(task.id));
    try {
      await api.controlDownload(task.id, action, undefined, task.private);
      window.dispatchEvent(new Event("tessera:downloads-changed"));
      setConfirm(current => current?.task.id === task.id && current.action === action ? null : current);
      toast.success(action === "stop" ? "任务已停止" : action === "delete" ? "任务已删除" : "任务已加入下载队列");
      await pagination.reload();
    } catch (reason) { toast.error(api.errorMessage(reason, "操作没有完成，请稍后重试")); }
    finally { setBusy(current => { const next = new Set(current); next.delete(task.id); return next; }); }
  }
  async function clear(status: "completed" | "failed") {
    try {
      const { removed } = await api.clearDownloads(status);
      window.dispatchEvent(new Event("tessera:downloads-changed"));
      setClearing(null);
      toast.success(removed ? `已清除 ${removed} 个任务` : "没有需要清除的任务");
      await pagination.reload();
    } catch (reason) { toast.error(api.errorMessage(reason, "清除失败，请稍后重试")); }
  }
  /** 多选「更改保存位置」：只处理未完成的任务；我的文件与私密空间的任务不能一起更改。 */
  function relocateSelected() {
    const tasks = chosen.filter(movableDownload);
    if (!tasks.length) return;
    if (tasks.some(task => task.private) && tasks.some(task => !task.private)) { toast.error("所选任务同时包含我的文件和私密空间的任务，请分别更改保存位置"); return; }
    setRelocating(tasks);
  }
  const completed = () => { setNewTask(false); setEdit(null); void pagination.reload(); onChanged(); onCreated?.(); window.dispatchEvent(new Event("tessera:downloads-changed")); };
  const actions = <><Button icon="refresh" onClick={() => void pagination.reload()} disabled={pagination.loading}>刷新</Button><Button variant="primary" icon="plus" onClick={() => setNewTask(true)}>添加下载</Button></>;
  const searchField = <SearchInput value={search} onChange={setSearch} onSubmit={() => setQuery(search.trim())} onClear={() => setQuery("")} placeholder="搜索名称、路径或来源" label="搜索下载任务" />;
  return <>
    <PageHeader title="离线下载" description="交给服务器下载并保存到你的文件空间，关闭网页后继续；支持直链、M3U8、X 与 YouTube 等来源。" actions={actions} />
    <TaskStats label="离线下载概览" items={[
      { key: "active", label: "进行中", icon: "download", tone: "accent", live: Boolean(counts?.active), value: counts ? counts.active.toLocaleString("zh-CN") : "—",
        detail: !counts ? "正在读取" : counts.active ? counts.speed > 0 ? `${formatBytes(counts.speed)}/s${counts.left ? ` · ${remainingText(counts.left / counts.speed)}` : ""}` : "排队或解析中" : "没有进行中的下载",
        selected: filter === "active", onSelect: () => setFilter(filter === "active" ? "" : "active") },
      { key: "completed", label: "已完成", icon: "checkCircle", tone: "success", value: counts ? counts.completed.toLocaleString("zh-CN") : "—", detail: "已保存到文件空间",
        selected: filter === "completed", onSelect: () => setFilter(filter === "completed" ? "" : "completed") },
      { key: "failed", label: "失败", icon: "alert", tone: counts?.failed ? "danger" : "neutral", value: counts ? counts.failed.toLocaleString("zh-CN") : "—", detail: counts?.failed ? "可查看原因后重新下载" : "一切正常",
        selected: filter === "failed", onSelect: () => setFilter(filter === "failed" ? "" : "failed") },
      { key: "stopped", label: "已停止", icon: "pause", value: counts ? counts.stopped.toLocaleString("zh-CN") : "—", detail: "可随时继续",
        selected: filter === "stopped", onSelect: () => setFilter(filter === "stopped" ? "" : "stopped") },
    ]} />
    <div className="toolbar task-search">{searchField}</div>
    <div className="task-controls">
      {chosen.length > 0 && <div className="toolbar selection-bar task-selection" role="toolbar" aria-label="批量操作">
        <span className="selection-count"><span className="task-selection-prefix">已选择 </span>{chosen.length} 项</span>
        <div className="toolbar-actions">
          {chosen.some(active) && <Button size="sm" icon="pause" disabled={bulkBusy} onClick={() => setBulk("stop")}>停止</Button>}
          {chosen.some(task => ["stopped", "failed"].includes(task.status)) && <Button size="sm" icon="play" loading={bulkBusy && !bulk} disabled={bulkBusy} onClick={() => void runBulk("resume")}>继续</Button>}
          {chosen.some(movableDownload) && <Button size="sm" icon="move" disabled={bulkBusy} onClick={relocateSelected}>更改保存位置</Button>}
          <Button size="sm" variant="danger" icon="trash" disabled={bulkBusy} onClick={() => setBulk("delete")}>删除</Button>
          <IconButton icon="x" label="取消选择" size="sm" onClick={() => setSelected(new Set())} />
        </div>
      </div>}
      <div className={`task-toolbar${chosen.length ? " is-selecting" : ""}`} aria-hidden={chosen.length > 0}><Segmented label="任务状态" showLabels value={filter} onChange={setFilter} options={[
        { value: "", label: "全部" }, { value: "active", label: "进行中" }, { value: "stopped", label: "已停止" }, { value: "completed", label: "已完成" }, { value: "failed", label: "失败" },
      ]} /><span className="task-toolbar-meta">
        <span className="muted">{page ? `${page.total} 个任务` : "正在读取任务"}</span>
        <Menu label="清理下载任务" icon="trash" items={[
          { label: `清除全部已完成的任务${counts?.completed ? `（${counts.completed}）` : ""}`, icon: "checkCircle", disabled: counts ? !counts.completed : false, onSelect: () => setClearing("completed") },
          { label: `清除全部失败的任务${counts?.failed ? `（${counts.failed}）` : ""}`, icon: "alert", disabled: counts ? !counts.failed : false, onSelect: () => setClearing("failed") },
        ]} /></span></div>
    </div>
    {page?.capabilities.pressure && <Notice tone="warning" role="status">{page.capabilities.pressure}</Notice>}
    <div className="file-surface task-surface">
      {pagination.error ? <EmptyState icon="alert" title="任务加载失败" description={pagination.error} action={<Button onClick={() => void pagination.reload()}>重试</Button>} />
        : !page ? <SkeletonRows rows={5} />
          : !page.tasks.length ? <EmptyState icon="download" title={query || filter ? "没有符合条件的任务" : "还没有下载任务"} description={query || filter ? "试试其他关键词或任务状态。" : "粘贴文件链接、X 帖子或 YouTube 视频，也可以使用 curl 命令。"} action={query || filter ? <Button onClick={() => { setSearch(""); setQuery(""); setFilter(""); }}>清除筛选</Button> : <Button icon="plus" onClick={() => setNewTask(true)}>添加下载</Button>} />
            : <div className="data-table task-table" role="table" aria-label="下载任务">
              <div className="data-row data-head" role="row">
                <span className="cell-check" role="columnheader"><Checkbox checked={allSelected} indeterminate={chosen.length > 0 && !allSelected} label="选择本页全部任务" onChange={checked => setSelected(checked ? new Set(page.tasks.map(task => task.id)) : new Set())} /></span>
                <span role="columnheader">文件</span>
                <span role="columnheader">进度</span>
                <span role="columnheader">保存到</span>
                <span role="columnheader">状态</span>
                <span className="cell-actions" role="columnheader"><span className="sr-only">操作</span></span>
              </div>
              {page.tasks.map(task => {
                const name = downloadTaskName(task);
                const folder = downloadTaskFolder(task);
                const completed = task.status === "completed";
                const canOpen = canOpenDownloadFolder(task);
                const kind = task.kind === "hls" ? "video" : task.private && !api.isPrivatePath(task.key) ? "other" : getFileKind(null, task.key);
                const location = api.privatePathLabel(folder);
                const file = completed ? task.file : null;
                const thumbnail = file ? api.fileThumbnail(file) : undefined;
                // 每行一个快捷操作：进行中停止、停止或失败后继续、完成后打开所在目录；其余在「更多」菜单。
                const quick = active(task) ? <IconButton icon="pause" size="sm" label="停止下载" onClick={() => setConfirm({ task, action: "stop" })} />
                  : completed ? <IconButton icon="folder" size="sm" label={canOpen ? `打开所在目录：${location}` : "文件已删除"} disabled={!canOpen} onClick={() => onOpenFolder(folder, task.private)} />
                    : <IconButton icon="play" size="sm" label="继续下载" onClick={() => task.method === "POST" ? setConfirm({ task, action: "resume" }) : void control(task, "resume")} />;
                const checked = selected.has(task.id);
                return <div className={`data-row task-item is-${task.status}${checked ? " is-selected" : ""}`} role="row" key={task.id}>
                  <span className="cell-check" role="cell"><Checkbox checked={checked} label={`选择 ${name}`} onChange={value => setSelected(current => { const next = new Set(current); if (value) next.add(task.id); else next.delete(task.id); return next; })} /></span>
                  <div className="cell-name" role="cell">
                    {thumbnail && file ? <FileVisual kind={getFileKind(file.content_type, file.key)} src={thumbnail} /> : <FileTile kind={kind} />}
                    <div className="name-stack">
                      <strong className="task-name" title={name}>{name}</strong>
                      <small className="task-subline"><span title={task.source?.url ?? task.source_host}>{task.platform === "x" ? "X · " : task.platform === "youtube" ? "YouTube · " : task.kind === "hls" ? "M3U8 · " : ""}{task.source_host}</span>
                        <span className="task-added" title={`添加于 ${formatDateTime(task.created_at)}`}>{"\u00a0· "}{formatDate(task.created_at)}</span></small>
                    </div>
                  </div>
                  <div role="cell"><DownloadProgress task={task} name={name} /></div>
                  <div role="cell" className="muted">
                    {completed && canOpen ? <button type="button" className="task-location" title={`打开所在目录：${location}`} onClick={() => onOpenFolder(folder, task.private)}><Icon name="folder" size={12} /><LocationText folder={folder} /></button>
                      : <span className="task-location" title={task.trashed ? `文件已删除，原位置：${location}` : `保存到 ${location}`}><Icon name={task.trashed ? "trash" : "folder"} size={12} />{task.trashed ? <span className="task-location-text"><span>文件已删除</span></span> : <LocationText folder={folder} />}</span>}
                  </div>
                  <div className="task-state" role="cell"><Badge tone={TONE[task.status]} dot={!completed} icon={completed ? "check" : undefined}>{downloadStatusLabel(task)}</Badge></div>
                  <div className="cell-actions" role="cell">{busy.has(task.id) ? <span className="spinner" aria-label="正在处理任务" /> : <>{quick}<Menu label={`${name}的更多操作`} items={[
                    ...(task.status === "running" && diagnostics ? [{ label: "查看下载诊断", icon: "info" as const, onSelect: () => setDiagnosing(task.id) }] : []),
                    ...(task.source ? [
                      { label: "复制来源链接", icon: "copy" as const, onSelect: () => void copySource(task) },
                      { label: "打开来源链接", icon: "external" as const, onSelect: () => openSource(task) },
                    ] : []),
                    ...(task.error ? [{ label: "复制失败原因", icon: "alert" as const, onSelect: () => void copyText(task.error!, "失败原因已复制") }] : []),
                    ...(movableDownload(task) ? [
                      ...(task.status !== "running" ? [{ label: "立即下载", icon: "zap" as const, divider: Boolean(task.source || task.error), onSelect: () => setNow(task) }] : []),
                      { label: "更改保存位置", icon: "move" as const, divider: task.status === "running" && Boolean(task.source || task.error), onSelect: () => setRelocating([task]) },
                    ] : []),
                    { label: "重新下载", icon: "refresh" as const, divider: !movableDownload(task) && Boolean(task.source || task.error), onSelect: () => setConfirm({ task, action: "restart" }) },
                    { label: "更新下载参数", icon: "settings" as const, onSelect: () => setEdit(task) },
                    { label: "删除任务", icon: "trash" as const, danger: true, divider: true, onSelect: () => setConfirm({ task, action: "delete" }) },
                  ]} /></>}</div>
                </div>;
              })}
            </div>}
    </div>
    {page && (pagination.hasPrevious || pagination.hasNext || page.total > DOWNLOAD_PAGE_SIZES[0]) && <footer className="list-footer task-footer">
      <Pagination {...pagination} total={page.total} pageSize={pageSize} changePageSize={changePageSize} sizes={sizes} /></footer>}
    <details className="task-help"><summary><Icon name="info" size={15} /><span>下载说明</span><Icon name="chevronDown" size={14} /></summary>
      <p>支持文件直链{page?.capabilities.hls ? "、M3U8 点播" : ""}{page?.capabilities.x ? "、X 帖子" : ""}{page?.capabilities.youtube ? "、YouTube 视频和 Shorts" : ""}。平台功能由管理员启用。网络中断会自动重试；文件直链满足条件时可续传，平台和 M3U8 任务手动停止后从头下载。删除任务保留已保存的文件。</p>
    </details>
    {(newTask || edit) && <DownloadDialog task={edit} onClose={() => { setNewTask(false); setEdit(null); }} onComplete={completed} />}
    {imported && !newTask && !edit && <DownloadDialog task={null} initial={imported} onClose={() => setImported(null)} onComplete={() => { setImported(null); completed(); }} />}
    {now && <DownloadNowDialog task={now} onClose={() => setNow(null)} onDone={() => { setNow(null); window.dispatchEvent(new Event("tessera:downloads-changed")); void pagination.reload(); }} />}
    {diagnosing != null && <DownloadDiagnosisDialog id={diagnosing} task={page?.tasks.find(task => task.id === diagnosing) ?? null} onClose={() => setDiagnosing(null)} />}
    {relocating && <RelocateDialog tasks={relocating} onClose={() => setRelocating(null)} onDone={() => { setRelocating(null); setSelected(new Set()); void pagination.reload(); }} />}
    {clearing && <ConfirmDialog title={clearing === "completed" ? `清除全部 ${counts?.completed ?? ""} 个已完成的任务？` : `清除全部 ${counts?.failed ?? ""} 个失败的任务？`}
      description={clearing === "completed" ? "从列表中移除所有已完成的任务（不只是本页），已保存的文件不受影响。任务很多时需要一会儿，请不要关闭页面。"
        : "移除所有失败的任务（不只是本页）并清理未完成的数据，已保存的文件不受影响。任务很多时需要一会儿，请不要关闭页面。"}
      confirmLabel="清除" danger onClose={() => setClearing(null)} onConfirm={() => clear(clearing)} />}
    {bulk && <ConfirmDialog title={bulk === "delete" ? `删除 ${chosen.length} 个下载任务` : `停止 ${chosen.length} 个下载任务`}
      description={bulk === "delete" ? "删除所选任务并清理未完成的数据，已保存的文件会保留。" : "文件直链停止后保留已保存的分段，来源支持时可从断点继续；平台和 M3U8 任务继续时从头下载。"}
      danger={bulk === "delete"} confirmLabel={bulk === "delete" ? "删除任务" : "停止下载"} onClose={() => setBulk(null)} onConfirm={() => runBulk(bulk)} />}
    {confirm && <ConfirmDialog title={confirm.action === "delete" ? "删除下载任务" : confirm.action === "restart" ? "重新下载文件" : confirm.action === "resume" ? "重新发送下载请求" : "停止下载"}
      description={confirm.action === "delete" ? <>删除任务“{downloadTaskName(confirm.task)}”并清理未完成的数据，已保存的文件会保留。</>
        : confirm.action === "restart" ? <>清理当前断点并从头下载“{downloadTaskName(confirm.task)}”。同名文件会自动改名保存。</>
          : confirm.action === "resume" ? "此任务使用 POST 请求，继续下载会重新发送请求和请求体。"
            : confirm.task.kind === "hls" || confirm.task.platform ? "此任务停止后会清理中间数据；继续时从头下载。" : "停止后保留已保存的分段。来源支持且文件未变化时，可从断点继续。"}
      danger={confirm.action === "delete" || confirm.action === "restart"} confirmLabel={confirm.action === "delete" ? "删除任务" : confirm.action === "restart" ? "重新下载" : confirm.action === "resume" ? "重新发送" : "停止下载"}
      onClose={() => setConfirm(null)} onConfirm={() => control(confirm.task, confirm.action)} />}
  </>;
}

const DOWNLOAD_MODE: Record<NonNullable<api.DownloadDiagnosis["phase"]>, string> = {
  starting: "准备中", http: "直链 · 连接中", parallel: "直链 · 多连接分段", single: "直链 · 单连接", fragmented: "直链 · 分片 MP4 转换", hls: "M3U8 · 分片预读", platform: "平台媒体",
};
const MIB = 1024 * 1024;
const rangeTitle = (connection: api.DownloadConnection) => {
  const match = /^(\d+)-(\d*)$/.exec(connection.range);
  if (!match) return `连接 #${connection.id}`;
  const start = Number(match[1]) / MIB, end = match[2] ? (Number(match[2]) + 1) / MIB : null;
  return end != null ? `${start.toFixed(0)}–${end.toFixed(0)} MB` : `${start.toFixed(0)} MB 起`;
};

/** 看数据给出一句判断：来源首字节、存储写入、中途停顿、最近失败，再看是否只能单连接。 */
function downloadVerdict(value: api.DownloadDiagnosis): DiagnosisVerdict {
  const connections = value.connections ?? [], writes = value.writes ?? [];
  const waiting = connections.filter(item => !item.first_byte && (item.wait ?? 0) > 10);
  if (waiting.length) return { tone: "warning", title: "来源响应慢", detail: `${waiting.length} 个连接超过 10 秒还没收到第一个字节，来源服务器响应慢或在限制连接数；可以在「下载与资源」里减少单个任务的连接数试试。` };
  const slowWrites = writes.filter(item => item.elapsed > 30);
  if (slowWrites.length || writes.length && value.upload_slots.active >= value.upload_slots.limit) return { tone: "warning", title: "写入存储慢",
    detail: `同时写入存储 ${value.upload_slots.active} / ${value.upload_slots.limit}，${writes.length} 个分段在等待或正在上传到存储（Telegram）。读完的分段要写完才会读下一段；可以调整「同时写入存储的分片数」与 Bot 发送间隔。` };
  const stalled = connections.filter(item => item.first_byte && (item.idle ?? 0) > 20);
  if (stalled.length) return { tone: "warning", title: "数据中途停住", detail: `${stalled.length} 个连接超过 20 秒没有收到新数据；连接超时后会自动重试这一段。` };
  const failed = (value.recent ?? []).filter(item => item.phase === "failed");
  if (failed.length) return { tone: "info", title: `最近有 ${failed.length} 个连接失败`, detail: `${failed[0].error || "连接中断"}；失败的分段会自动重试。` };
  if (value.single && value.connections_limit > 1) return { tone: "info", title: "只能单连接下载", detail: "来源不支持按范围分段读取，这个任务改用 1 个连接从头下载。" };
  return { tone: "success", title: "运行正常", detail: connections.length ? "各连接都在正常接收数据。" : "正在准备下一段或处理已下载的数据。" };
}

/** 运行中离线任务的来源连接与存储写入，每秒刷新；只有字节数、状态、范围与耗时。 */
function DownloadDiagnosisDialog({ id, task, onClose }: { id: number; task: api.DownloadTask | null; onClose: () => void }) {
  const [value, setValue] = useState<api.DownloadDiagnosis | null | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const read = () => void api.downloadDiagnosis(id).then(result => { if (alive) { setValue(result); setError(""); } },
      reason => { if (alive) setError(api.errorMessage(reason, "读取诊断失败")); });
    read();
    const timer = window.setInterval(read, 1000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [id]);
  const connections = value?.connections ?? [], writes = value?.writes ?? [];
  const failures = (value?.recent ?? []).filter(item => item.phase === "failed");
  return <Modal title="下载诊断" description={task ? downloadTaskName(task) : undefined} icon="info" size="lg" className={task?.private ? "private-dialog" : ""} onClose={onClose}
    footer={<Button variant="ghost" onClick={onClose}>关闭</Button>}>
    {error ? <Notice tone="danger">{error}</Notice> : value === undefined ? <SkeletonRows rows={3} /> : !value?.running ? <Notice tone="info">这个任务目前没有在运行（排队中、已停止或已经结束）。</Notice> : <div className="diagnosis">
      <DiagnosisMetrics items={[
        { label: "下载方式", value: DOWNLOAD_MODE[value.phase ?? "starting"], detail: `已运行 ${elapsedText(value.elapsed)}` },
        { label: "来源连接", value: `${connections.length} / ${value.connections_limit}`, detail: `共 ${value.totals?.requests ?? 0} 次请求` },
        { label: "写入存储", value: `${value.upload_slots.active} / ${value.upload_slots.limit}`, detail: `本任务已写 ${value.totals?.writes ?? 0} 段 · ${formatBytes(value.totals?.written ?? 0)}`,
          tone: value.upload_slots.active >= value.upload_slots.limit ? "warning" : undefined },
        { label: "失败连接", value: value.totals?.failed ?? 0, detail: failures[0]?.error || "—", tone: value.totals?.failed ? "danger" : "success" },
      ]} />
      <DiagnosisVerdictNotice verdict={downloadVerdict(value)} />
      <DiagnosisSection title="来源连接" hint={task?.size ? `任务进度 ${formatBytes(task.received ?? 0)} / ${formatBytes(task.size)}` : undefined}>
        {!connections.length ? <p className="muted">当前没有打开的来源连接。</p> : <ul className="diagnosis-list">{connections.map(item =>
          <DiagnosisRow key={item.id} title={rangeTitle(item)} phase={item.phase === "connecting" ? "连接中" : "接收中"} tone={item.phase === "connecting" ? "warning" : "accent"}
            size={item.size} received={item.received} meta={[
              item.first_byte ? `首字节 ${elapsedText(item.wait)}` : `已等首字节 ${elapsedText(item.wait)}`,
              item.first_byte && `最后收到 ${elapsedText(item.idle)}前`,
              item.status && `HTTP ${item.status}`,
              `已用 ${elapsedText(item.elapsed)}`,
            ]} />)}</ul>}
      </DiagnosisSection>
      {writes.length > 0 && <DiagnosisSection title="正在写入存储的分段" hint="读完的分段排队上传到存储，写完才释放内存">
        <ul className="diagnosis-list">{writes.map(item => <DiagnosisRow key={item.part} title={`第 ${item.part} 段`} phase="写入中" tone="accent" size={item.size} received={item.size}
          meta={[`已用 ${elapsedText(item.elapsed)}`]} />)}</ul>
      </DiagnosisSection>}
      {failures.length > 0 && <DiagnosisSection title="最近失败的连接">
        <ul className="diagnosis-list">{failures.slice(0, 4).map(item => <DiagnosisRow key={item.id} title={rangeTitle(item)} phase="失败" tone="danger" size={item.size} received={item.received}
          meta={[item.status && `HTTP ${item.status}`, `持续 ${elapsedText(item.elapsed)}`]} error={item.error} />)}</ul>
      </DiagnosisSection>}
    </div>}
  </Modal>;
}

/** 未完成且没有被删除的任务可以更改保存位置；排队、等待恢复、已停止或失败的还可以立即下载。 */
const movableDownload = (task: api.DownloadTask) => task.status !== "completed" && !task.trashed;

/** 立即下载：先向服务器查询需要让出的任务（同一账号正在运行、进度最小的一个），确认后插队；让出的任务回到排队，稍后自动继续。 */
function DownloadNowDialog({ task, onClose, onDone }: { task: api.DownloadTask; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<api.DownloadNowPlan | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api.downloadNowPlan(task.id, task.private).then(value => { if (alive) setPlan(value); }, reason => { if (alive) setError(api.errorMessage(reason, "无法读取当前的下载情况")); });
    return () => { alive = false; };
  }, [task.id, task.private]);
  const name = downloadTaskName(task);
  const victim = plan?.victim;
  const victimName = victim ? downloadTaskName(victim) : "";
  const victimPercent = victim ? victim.kind === "hls" && victim.duration ? victim.processed_seconds / victim.duration * 100 : victim.size ? victim.received / victim.size * 100 : null : null;
  const restarts = Boolean(victim && (victim.kind === "hls" || victim.platform));
  async function confirm() {
    try {
      const result = await api.downloadNow(task.id, task.private);
      toast.success(result.victim ? `已开始下载“${name}”，“${downloadTaskName(result.victim)}”已暂停并回到排队` : result.waiting ? `“${name}”已排到队列最前，有空位时最先开始` : `已开始下载“${name}”`);
      onDone();
    } catch (reason) { toast.error(api.errorMessage(reason, "没有完成，请稍后重试")); }
  }
  return <ConfirmDialog title="立即下载" danger={false} confirmLabel="立即下载" onClose={onClose} onConfirm={confirm}
    description={<>
      {error ? error : !plan ? "正在检查当前的下载…"
        : victim ? <>“{name}”会插队立即开始下载。为腾出位置，将暂停正在下载、进度最小的“{victimName}”（{victimPercent !== null ? `已完成 ${Math.floor(victimPercent)}%` : `已下载 ${formatBytes(victim.received)}`}），它会回到排队，有空位后自动继续{restarts ? "；这类任务暂停后需要从头下载" : "，已下载的部分会保留"}。</>
          : plan.waiting ? <>当前的下载位置都被占用，且没有可以暂停的任务（其他用户的任务或 POST 任务不会被暂停）。“{name}”会排到队列最前，有空位时最先开始。</>
            : <>“{name}”会插队立即开始下载。</>}
      {task.method === "POST" && ["stopped", "failed"].includes(task.status) && <> 此任务使用 POST 请求，会重新发送请求和请求体。</>}
    </>} />;
}

/** 更改保存位置：只改目录、文件名不变；正在下载的任务不中断，完成后保存到新位置。私密任务需先解锁，且只能选择私密空间中的目录。 */
function RelocateDialog({ tasks, onClose, onDone }: { tasks: api.DownloadTask[]; onClose: () => void; onDone: () => void }) {
  const access = usePrivateAccess();
  const privateTasks = tasks[0].private;
  const current = downloadTaskFolder(tasks[0]);
  const [destination, setDestination] = useState(current);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 锁定时列表里看不到私密任务的路径：解锁后从私密空间根目录开始选择。
  useEffect(() => { if (privateTasks && access.grant && !api.isPrivatePath(destination)) setDestination(api.PRIVATE_PREFIX); }, [privateTasks, access.grant, destination]);
  if (privateTasks && !access.grant) return <PrivateUnlockDialog description="解锁后才能更改私密空间下载任务的保存位置。" onClose={onClose} onUnlocked={() => undefined} />;
  const single = tasks.length === 1;
  async function save() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const { moved, skipped } = await api.moveDownloads(tasks.map(task => task.id), destination, privateTasks);
      toast.success(`已更改${single ? "" : ` ${moved} 个任务的`}保存位置：${api.privatePathLabel(destination)}${skipped ? `，${skipped} 个已完成或已删除的任务已跳过` : ""}`);
      onDone();
    } catch (reason) { setError(api.errorMessage(reason, "更改失败，请稍后重试")); setBusy(false); }
  }
  return <Modal title={single ? "更改保存位置" : `更改 ${tasks.length} 个任务的保存位置`} description={single ? downloadTaskName(tasks[0]) : undefined} icon="move" size="md" onClose={onClose} dismissible={!busy}
    footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
      <Button variant="primary" icon="check" loading={busy} disabled={!ready || (single && destination === current)} onClick={() => void save()}>保存到这里</Button></>}>
    <FolderPicker value={destination} onChange={setDestination} onReady={setReady} />
    <p className="muted">只改变保存目录，文件名不变。正在下载的任务不会中断，完成后保存到新位置；同名文件自动改名。</p>
    {error && <Notice tone="danger">{error}</Notice>}
  </Modal>;
}

/** 进度列：进行中显示进度条与「已下载／总大小 · 速度 · 剩余时间」，完成后显示大小与用时，失败显示原因（点击展开全文）。 */
function DownloadProgress({ task, name }: { task: api.DownloadTask; name: string }) {
  const [expanded, setExpanded] = useState(false);
  const percent = downloadPercent(task);
  const saved = task.stored_bytes || task.received;
  if (task.status === "completed") {
    const average = task.elapsed_seconds > 0 ? saved / Math.max(task.elapsed_seconds, 0.05) : null;
    return <div className="task-progress is-done">
      <span className="task-figure">{formatBytes(saved)}</span>
      <small>{[task.elapsed_seconds > 0 && `用时 ${elapsed(task.elapsed_seconds)}`, average !== null && `平均 ${formatBytes(average)}/s`].filter(Boolean).join(" · ") || "已保存"}</small>
    </div>;
  }
  if (task.status === "failed" && task.error) {
    return <button type="button" className={`task-failure${expanded ? " is-expanded" : ""}`} title={expanded ? "收起" : task.error} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <Icon name="alert" size={13} /><span>{task.error}</span>
    </button>;
  }
  const received = task.kind === "hls" ? saved : task.received;
  const running = task.status === "running";
  const detail = [
    task.status === "queued" && !received ? "等待开始" : task.size ? `${formatBytes(received)} / ${formatBytes(task.size)}` : received ? `已下载 ${formatBytes(received)}` : task.kind === "hls" && task.segments_total ? `${task.segments_done}/${task.segments_total} 段` : "大小未知",
    running && task.speed > 0 && `${formatBytes(task.speed)}/s`,
    running && task.eta_seconds !== null && `约剩 ${seconds(task.eta_seconds)}`,
    task.status === "interrupted" && task.error,
  ].filter(Boolean).join(" · ");
  return <div className={`task-progress is-${task.status}`}>
    <div className="task-progress-bar">
      {percent !== null ? <Progress value={percent} tone={running || task.status === "queued" ? "accent" : "neutral"} label={`${name}下载进度`} />
        : <div className={`task-unknown${running ? " is-running" : ""}`} role="status" aria-label="总大小未知" />}
      {percent !== null && <span className="task-percent">{Math.floor(percent)}%</span>}
    </div>
    <small title={detail}>{detail}</small>
  </div>;
}

function DownloadDialog({ task, initial, onClose, onComplete }: { task: api.DownloadTask | null; initial?: api.DownloadImport; onClose: () => void; onComplete: () => void }) {
  const [input, setInput] = useState("");
  const [downloadType, setDownloadType] = useState<"auto" | "http" | "hls" | "x" | "youtube">("auto");
  const [cookies, setCookies] = useState("");
  const [cookiesOpen, setCookiesOpen] = useState(false);
  // 更新参数时回填原来的链接、请求头与平台 Cookie，用户只需修改失效的部分。
  const [prefill, setPrefill] = useState<"loading" | "ready" | "failed">(task ? "loading" : "ready");
  useEffect(() => {
    if (!task) return;
    let alive = true;
    void api.downloadSource(task.id, task.private).then(value => {
      if (!alive) return;
      setInput(current => current || value.input);
      setDownloadType(value.download_type);
      if (value.cookies) { setCookies(value.cookies); setCookiesOpen(true); }
      setPrefill("ready");
    }).catch(() => { if (alive) setPrefill("failed"); });
    return () => { alive = false; };
  }, [task]);
  const [candidates, setCandidates] = useState<api.DownloadCandidate[] | null>(initial?.candidates ?? null);
  const [selected, setSelected] = useState(() => new Set<number>(initial?.candidates.map((_, index) => index) ?? []));
  const [destination, setDestination] = useState(initial?.destination ?? "");
  // 来自脚本的私密目标：未解锁时先在本页解锁；手动切换位置时同步意图，避免又被改回私密空间。
  const access = usePrivateAccess();
  const [wantPrivate, setWantPrivate] = useState(Boolean(initial?.private));
  const needsUnlock = wantPrivate && !access.grant;
  // 脚本转交到私密空间的任务直接弹出统一的解锁框；记住的私密位置只提示，由用户点「解锁」。
  const [unlocking, setUnlocking] = useState(Boolean(initial?.private));
  useEffect(() => { if (access.grant) setUnlocking(false); }, [access.grant]);
  useEffect(() => { if (wantPrivate && access.grant && !api.isPrivatePath(destination)) setDestination(api.PRIVATE_PREFIX); }, [wantPrivate, access.grant, destination]);
  // 默认使用上次的保存位置（服务端按账号记录，脚本提交的任务也会更新）；私密位置在解锁后才取得具体目录。
  // 用户在本窗口改过位置后不再覆盖。
  const chosen = useRef(false);
  useEffect(() => {
    if (task) return;
    let alive = true;
    void api.lastDownloadDestination().then(last => {
      if (!alive || chosen.current) return;
      if (initial) { if (initial.private && last.private) setDestination(last.private); return; }
      if (last.area === "private") { setWantPrivate(true); setDestination(last.private ?? ""); }
      else setDestination(last.normal);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [task, initial, access.grant]);
  // 每个文件可以附带一张缩略图（本地图片或图片地址），任务创建后提交，下载完成时设为文件的缩略图。
  const [covers, setCovers] = useState<Map<number, Blob>>(new Map());
  const [coverFor, setCoverFor] = useState<number | null>(null);
  const [ready, setReady] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initial?.error ?? "");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function parse() {
    setBusy(true); setError("");
    abort.current = new AbortController();
    try {
      const result = await api.parseDownloads(input, abort.current.signal, downloadType, cookies);
      setCandidates(result.candidates); setCovers(new Map());
      const seen = new Set<string>();
      setSelected(new Set(result.candidates.flatMap((candidate, index) => {
        if (task) return index === 0 ? [index] : [];
        if (candidate.variant && seen.has(candidate.group)) return [];
        seen.add(candidate.group); return [index];
      })));
    } catch (reason) { setError(api.errorMessage(reason, "解析失败，请检查链接或命令")); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!candidates || !selected.size || !ready || needsUnlock) return;
    setBusy(true); setError("");
    try {
      if (task) {
        await api.controlDownload(task.id, "update", { ticket: candidates[[...selected][0]].ticket }, task.private);
        toast.success("参数已更新，任务已重新加入队列");
        onComplete();
        return;
      }
      const chosenIndexes = [...selected];
      // 先在浏览器里缩放缩略图：图片有问题时还没创建任务，可以直接更换。
      const images = new Map<number, Record<string, string>>();
      for (const index of chosenIndexes) {
        const cover = covers.get(index);
        if (!cover) continue;
        try { images.set(index, await imageThumbnailSet(cover)); }
        catch (reason) { throw new Error(`${candidates[index].name} 的封面：${api.errorMessage(reason, "图片处理失败")}`); }
      }
      const { tasks } = await api.createDownloads(chosenIndexes.map(index => ({ ticket: candidates[index].ticket, name: candidates[index].name, ...(candidates[index].folder ? { folder: candidates[index].folder } : {}) })), destination);
      let failed = 0;
      for (const [position, index] of chosenIndexes.entries()) {
        const value = images.get(index), created = tasks[position];
        if (!value || !created) continue;
        try { await api.setDownloadCover(created.id, value, api.isPrivatePath(destination)); } catch { failed++; }
      }
      if (failed) toast.error(`任务已创建，但 ${failed} 个封面未能提交；下载完成后可在文件菜单「更新封面」中设置`);
      else toast.success(`${selected.size} 个任务已加入下载队列`);
      onComplete();
    } catch (reason) {
      const expired = initial && reason instanceof api.ApiError && reason.status === 400 && /过期|expired/i.test(reason.message);
      setError(expired ? "解析结果已过期（30 分钟），请回到原网页重新发送。" : api.errorMessage(reason, "创建任务失败，请稍后重试"));
    }
    finally { setBusy(false); }
  }
  // 同一视频的多个清晰度只能选一个：全选时每组取已选的那个，没有时取第一个。
  const groupCount = candidates ? (task ? 1 : new Set(candidates.map((item, index) => item.variant ? item.group : `#${index}`)).size) : 0;
  const allSelected = Boolean(candidates) && selected.size > 0 && selected.size === groupCount;
  const selectedList = candidates ? [...selected].map(index => candidates[index]).filter(Boolean) : [];
  const selectedSize = selectedList.reduce((sum, item) => sum + (item.size ?? 0), 0);
  const unknownSize = selectedList.some(item => item.size === null);
  function toggle(index: number, checked: boolean) {
    if (!candidates) return;
    const candidate = candidates[index];
    setSelected(current => {
      const next = task ? new Set<number>() : new Set(current);
      if (checked) { if (candidate.variant) for (const item of next) if (candidates[item].group === candidate.group) next.delete(item); next.add(index); }
      else next.delete(index);
      return next;
    });
  }
  function selectAll(checked: boolean) {
    if (!candidates) return;
    if (!checked) { setSelected(new Set()); return; }
    const picked = new Map<string, number>();
    candidates.forEach((item, index) => {
      const key = item.variant ? item.group : `#${index}`;
      if (!picked.has(key) || (selected.has(index) && !selected.has(picked.get(key)!))) picked.set(key, index);
    });
    setSelected(new Set(picked.values()));
  }
  return <Modal title={task ? "更新下载参数" : initial ? "确认下载" : "添加下载"} icon="download" size="lg" onClose={onClose} dismissible={!busy}
    className={`download-dialog${candidates ? " is-review" : ""}`}
    description={task ? "已填入原来的链接和请求参数，修改后重新解析，选择文件后从头重新下载。" : initial ? "这些文件由资源抓取脚本转交，确认保存位置后开始下载。" : "粘贴文件直链、X 帖子、YouTube 视频或 curl 命令。"}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button>{candidates ? <>{!initial && <Button variant="ghost" disabled={busy} onClick={() => { setCandidates(null); setError(""); }}>返回编辑</Button>}<Button variant="primary" loading={busy} disabled={!selected.size || !ready || needsUnlock} onClick={() => void submit()}>{task ? "更新并重新下载" : `开始下载${selected.size ? `（${selected.size}）` : ""}`}</Button></> : <Button variant="primary" loading={busy || prefill === "loading"} disabled={!input.trim()} onClick={() => void parse()}>{busy ? "正在读取文件信息" : "解析内容"}</Button>}</>}>
    <div className={candidates ? "download-review" : "form"}>
      {!candidates ? <>{prefill === "failed" && <Notice tone="warning" role="status">无法读取原来的下载参数，请重新粘贴链接或命令。</Notice>}
        <Field label="链接或下载命令" hint={task ? "已填入原来的参数，可直接修改失效的值（如过期的签名或 Cookie）；命令使用 bash 格式，不执行命令。" : "平台链接每次一个，多个直链每行一个。命令使用 bash 格式；支持请求头、Cookie、文本 POST 请求体，不执行命令。"}>
        <textarea className="input mono download-input" rows={8} autoComplete="off" autoCapitalize="none" spellCheck={false} value={input} disabled={prefill === "loading"} onChange={event => setInput(event.target.value)} placeholder={"https://example.com/video.mp4\n\ncurl 'https://example.com/file.zip' -H 'Cookie: …'"} />
      </Field><Field label="下载类型" hint="平台链接自动解析媒体；无法识别的播放列表可选择 M3U8。"><select className="input" value={downloadType} onChange={event => setDownloadType(event.target.value as typeof downloadType)}><option value="auto">自动识别</option><option value="http">文件直链</option><option value="hls">M3U8 视频</option><option value="x">X 单条帖子</option><option value="youtube">YouTube 视频 / Shorts</option></select></Field>
        <details className="download-cookie-options" open={cookiesOpen} onToggle={event => setCookiesOpen(event.currentTarget.open)}><summary>平台登录 Cookie（可选）</summary><div className="form">
          <Field label="Cookie 文本" hint="支持 Netscape cookies.txt 或 name=value 文本。仅用于平台解析，加密保存；不填写时尝试公开访问。"><textarea className="input mono download-cookie-input" rows={4} autoComplete="off" autoCapitalize="none" spellCheck={false} value={cookies} onChange={event => setCookies(event.target.value)} placeholder="粘贴当前平台的 Cookie，或导入 cookies.txt" /></Field>
          <Field label="导入 cookies.txt" hint="最多 32 KB；只使用对应平台域名的 Cookie。"><input className="input download-cookie-file" type="file" accept=".txt,text/plain" disabled={busy} onChange={event => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 32768) { setError("Cookie 文件不能超过 32 KB"); return; }
            void file.text().then(value => { setCookies(value); setError(""); }).catch(() => setError("无法读取 Cookie 文件，请粘贴文本"));
          }} /></Field>
        </div></details></> : <>
        <div className="download-review-bar">
          {!task && <Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected} label="全选" onChange={selectAll} />}
          <span className="download-review-count">{task ? "选择一个文件重新下载" : <>已选 <strong>{selected.size}</strong> / {groupCount} 个文件</>}</span>
          {selectedSize > 0 && <span className="download-review-size">{formatBytes(selectedSize)}{unknownSize ? " 以上" : ""}</span>}
        </div>
        <div className="download-candidates" role="group" aria-label="选择要下载的文件">
          {candidates.map((candidate, index) => {
            const checked = selected.has(index);
            const type = candidate.variant ?? candidate.content_type ?? (candidate.media_type === "image" ? "图片" : candidate.media_type === "video" ? "视频" : candidate.media_type === "audio" ? "音频" : candidate.method);
            const hasDetails = candidate.header_names.length > 0 || candidate.body_bytes > 0;
            return <div className={`download-candidate${checked ? " is-selected" : ""}`} key={candidate.ticket}>
              <Checkbox checked={checked} label={`下载 ${candidate.name}${candidate.variant ? ` ${candidate.variant}` : ""}`} onChange={value => toggle(index, value)} />
              {task ? <span className="download-candidate-tile"><FileTile kind={kindOf(candidate)} /></span>
                : <CoverTile image={covers.get(index) ?? null} name={candidate.name} kind={kindOf(candidate)} disabled={busy}
                  onEdit={() => setCoverFor(index)} onRemove={() => setCovers(current => { const next = new Map(current); next.delete(index); return next; })} />}
              <div className="download-candidate-copy">
                {task ? <strong className="download-candidate-name">{candidate.name}</strong>
                  : <input className="input download-name" aria-label={`文件 ${index + 1} 的名称`} value={candidate.name} spellCheck={false}
                    onChange={event => setCandidates(current => current?.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) ?? null)} />}
                <div className="download-candidate-meta">
                  <span>{candidate.source_host}</span>
                  <span>{type}</span>
                  {candidate.folder && <span className="is-folder"><Icon name="folder" size={12} />{candidate.folder}</span>}
                  {covers.has(index) && <span className="is-cover"><Icon name="image" size={12} />已设封面</span>}
                </div>
                {(hasDetails || candidate.method === "POST" || candidate.kind === "hls" || candidate.platform || candidate.warnings.length > 0) && <div className="download-candidate-notes">
                  {hasDetails && <details><summary>请求参数（凭据已隐藏）</summary><p>{candidate.header_names.length ? `请求头：${candidate.header_names.join("、")}` : "无额外请求头"}{candidate.body_bytes > 0 ? `；文本请求体 ${formatBytes(candidate.body_bytes)}` : ""}。下载时使用你提交的原值。</p></details>}
                  {candidate.method === "POST" && <p className="tone-warning">点击开始才发送 POST 请求；中断后需要手动重新发送。</p>}
                  {candidate.kind === "hls" && <p>保存为 MP4；停止后从头重新下载。</p>}
                  {candidate.platform && <p>已解析的媒体地址会直接用于下载，失效时自动重新解析；{candidate.platform === "youtube" ? "同一视频选择一个清晰度，" : ""}停止后从头下载。</p>}
                  {candidate.warnings.map((warning, i) => <p className="tone-warning" key={i}>{warning}</p>)}
                </div>}
              </div>
              <span className="download-candidate-size">{candidate.size !== null ? formatBytes(candidate.size) : "大小未知"}</span>
            </div>;
          })}
        </div>
        <div className="download-review-foot">
          {task ? <p className="muted">保存位置：{task.private && !api.isPrivatePath(task.key) ? "私密空间" : api.privatePathLabel(task.key)}</p>
            : needsUnlock ? <div className="download-import-unlock">
              <div className="download-import-unlock-head"><Icon name="lock" size={18} /><div><strong>保存到私密空间需要先解锁</strong><p className="muted">{initial ? `解锁只在当前 ${BRAND} 页面完成，脚本和原网页拿不到你的密码。` : "上次保存到了私密空间，解锁后继续使用那个位置。"}</p></div>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { chosen.current = true; setWantPrivate(false); setDestination(""); }}>改存普通目录</Button>
                <Button size="sm" variant="primary" icon="unlock" disabled={busy} onClick={() => setUnlocking(true)}>解锁</Button></div>
            </div>
            : <><DestinationPicker key={access.grant ? "unlocked" : "locked"} value={destination} allowPrivate onChange={path => { chosen.current = true; setWantPrivate(api.isPrivatePath(path)); setDestination(path); setReady(false); }} onReady={setReady} /><p className="muted">同名文件自动改名保存。来源凭据加密保存，任务列表只显示不含查询参数的来源地址。</p></>}
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </>}
      {!candidates && error && <Notice tone="danger">{error}</Notice>}
    </div>
    {unlocking && needsUnlock && <PrivateUnlockDialog description={initial ? `解锁只在当前 ${BRAND} 页面完成，脚本和原网页拿不到你的密码。` : "解锁后保存到私密空间。"}
      onClose={() => setUnlocking(false)} onUnlocked={() => setUnlocking(false)} />}
    {coverFor !== null && candidates?.[coverFor] && <CoverPickerDialog name={candidates[coverFor].name} onClose={() => setCoverFor(null)}
      onPick={image => { setCovers(current => new Map(current).set(coverFor, image)); setCoverFor(null); }} />}
  </Modal>;
}

/** 解析结果里每个文件的缩略图：默认自动生成，可换成自己的图片。 */
function kindOf(candidate: api.DownloadCandidate) {
  return candidate.media_type ?? getFileKind(candidate.content_type ?? null, candidate.name);
}

/** 文件行左侧的方块：没有封面时显示类型图标，点击设置封面；已设置时显示图片，可更换或移除。 */
function CoverTile({ image, name, kind, disabled, onEdit, onRemove }: { image: Blob | null; name: string; kind: ReturnType<typeof getFileKind>; disabled: boolean; onEdit: () => void; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!image) { setUrl(null); return; }
    const value = URL.createObjectURL(image); setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [image]);
  return <span className={`download-candidate-tile is-cover${url ? " has-image" : ""}`}>
    <button type="button" className="download-cover-button" disabled={disabled} onClick={onEdit}
      aria-label={image ? `更换 ${name} 的封面` : `为 ${name} 设置封面（下载完成后使用，不设置时自动生成）`}
      title={image ? "更换封面" : "设置封面（不设置时自动生成）"}>
      {url ? <img src={url} alt="" /> : <FileTile kind={kind} />}
      <span className="download-cover-hint" aria-hidden="true"><Icon name={image ? "edit" : "image"} size={14} /></span>
    </button>
    {image && <button type="button" className="download-cover-remove" disabled={disabled} onClick={onRemove} aria-label={`移除 ${name} 的封面`} title="移除封面"><Icon name="x" size={10} /></button>}
  </span>;
}
