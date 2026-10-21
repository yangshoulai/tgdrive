import { useCallback, useEffect, useRef, useState } from "react";
import { BRAND } from "../brand";
import * as api from "../api";
import { useCursorPage, usePageSize } from "../pagination";
import { Notice, Badge, Button, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, Menu, Modal, PageHeader, Pagination, Progress, SearchInput, Segmented, SkeletonRows, copyText, formatBytes, toast, useDocumentTitle, type Tone } from "../ui";
import { FileTile, FileVisual, getFileKind } from "../files";
import { DestinationPicker } from "./folders";
import { PrivateUnlockForm } from "./private-access";
import { usePrivateAccess } from "./private-session";

const LABEL: Record<api.DownloadStatus, string> = { queued: "排队中", running: "下载中", interrupted: "等待恢复", stopped: "已停止", completed: "已完成", failed: "失败" };
const TONE: Record<api.DownloadStatus, Tone> = { queued: "neutral", running: "accent", interrupted: "warning", stopped: "neutral", completed: "success", failed: "danger" };
/** 网页每页最多 100 个任务（服务端 OfflineDownloads.list 的上限）。 */
const DOWNLOAD_PAGE_SIZES = [20, 50, 100];
const DOWNLOAD_PAGE_SIZE_KEY = "tessera-download-page-size";
export const isActiveDownload = (task: api.DownloadTask) => ["queued", "running", "interrupted"].includes(task.status);
const active = isActiveDownload;
export const downloadGlyph = (task: api.DownloadTask) => /\.(m4a|mp3|aac|flac|ogg|opus|wav)$/i.test(task.key) ? "audio" as const
  : task.kind === "hls" || /\.(mp4|m4v|mov|webm|mkv)$/i.test(task.key) ? "video" as const
    : /\.(jpe?g|png|webp|gif)$/i.test(task.key) ? "image" as const : "file" as const;
/** 进度百分比；总大小未知时返回 null，不显示虚构进度。 */
export const downloadPercent = (task: api.DownloadTask) => task.status === "completed" ? 100 : task.kind === "hls" && task.duration ? Math.min(95, task.processed_seconds / task.duration * 95) : task.size ? Math.min(99, task.received / task.size * 100) : null;
export const downloadStatusLabel = (task: api.DownloadTask) => task.status === "running" && task.phase ? { resolving: "解析来源", downloading: "下载媒体", merging: "合并音视频", saving: "完成保存" }[task.phase] : LABEL[task.status];
export const parentFolder = (key: string) => key.includes("/") ? key.slice(0, key.lastIndexOf("/")) + "/" : "";
export const downloadTaskName = (task: api.DownloadTask) => task.private && !api.isPrivatePath(task.key) ? "私密空间下载" : task.key.split("/").at(-1) ?? task.key;
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

export function DownloadsView({ onChanged, onOpenFolder, onCreated }: { onChanged: () => void; onOpenFolder: (prefix: string, privateSpace?: boolean) => void; onCreated?: () => void }) {
  useDocumentTitle(`下载任务 · ${BRAND}`);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search.trim()), 300); return () => window.clearTimeout(timer); }, [search]);
  const [newTask, setNewTask] = useState(false);
  // 资源抓取脚本选择私密空间等需要网页确认的目标时，把解析结果放在地址片段里打开本页。
  const [imported, setImported] = useState<api.DownloadImport | null>(api.takeDownloadImport);
  const [edit, setEdit] = useState<api.DownloadTask | null>(null);
  const [confirm, setConfirm] = useState<{ task: api.DownloadTask; action: "stop" | "resume" | "restart" | "delete" } | null>(null);
  const [busy, setBusy] = useState(new Set<number>());
  const [clearing, setClearing] = useState<"completed" | "failed" | null>(null);
  const [selected, setSelected] = useState(new Set<number>());
  const [bulk, setBulk] = useState<"stop" | "delete" | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
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
      setConfirm(current => current?.task.id === task.id && current.action === action ? null : current);
      toast.success(action === "stop" ? "任务已停止" : action === "delete" ? "任务已删除" : "任务已加入下载队列");
      await pagination.reload();
    } catch (reason) { toast.error(api.errorMessage(reason, "操作没有完成，请稍后重试")); }
    finally { setBusy(current => { const next = new Set(current); next.delete(task.id); return next; }); }
  }
  async function clear(status: "completed" | "failed") {
    try {
      const { removed } = await api.clearDownloads(status);
      setClearing(null);
      toast.success(removed ? `已清除 ${removed} 个任务` : "没有需要清除的任务");
      await pagination.reload();
    } catch (reason) { toast.error(api.errorMessage(reason, "清除失败，请稍后重试")); }
  }
  const completed = () => { setNewTask(false); setEdit(null); void pagination.reload(); onChanged(); onCreated?.(); };
  return <>
    <PageHeader title="下载任务" description="交给服务器下载，关闭页面后继续保存到你的文件空间。"
      actions={<><Button icon="refresh" onClick={() => void pagination.reload()} disabled={pagination.loading}>刷新</Button><Button variant="primary" icon="plus" onClick={() => setNewTask(true)}>添加下载</Button></>} />
    <div className="toolbar download-search"><SearchInput value={search} onChange={setSearch} onSubmit={() => setQuery(search.trim())} onClear={() => setQuery("")} placeholder="搜索文件名、保存路径或来源域名" label="搜索下载任务" /></div>
    <div className="download-controls">
      {chosen.length > 0 && <div className="toolbar selection-bar download-selection" role="toolbar" aria-label="批量操作">
        <span className="selection-count"><span className="download-selection-prefix">已选择 </span>{chosen.length} 项</span>
        <div className="toolbar-actions">
          {chosen.some(active) && <Button size="sm" icon="pause" disabled={bulkBusy} onClick={() => setBulk("stop")}>停止</Button>}
          {chosen.some(task => ["stopped", "failed"].includes(task.status)) && <Button size="sm" icon="play" loading={bulkBusy && !bulk} disabled={bulkBusy} onClick={() => void runBulk("resume")}>继续</Button>}
          <Button size="sm" variant="danger" icon="trash" disabled={bulkBusy} onClick={() => setBulk("delete")}>删除</Button>
          <IconButton icon="x" label="取消选择" size="sm" onClick={() => setSelected(new Set())} />
        </div>
      </div>}
      <div className={`download-toolbar${chosen.length ? " is-selecting" : ""}`} aria-hidden={chosen.length > 0}><Segmented label="任务状态" showLabels value={filter} onChange={setFilter} options={[
        { value: "", label: "全部" }, { value: "active", label: "进行中" }, { value: "stopped", label: "已停止" }, { value: "completed", label: "已完成" }, { value: "failed", label: "失败" },
      ]} /><span className="download-toolbar-meta">
        {/* 进行中与失败的数量来自当前页（新任务排在最前），方便一眼看出需要处理的任务。 */}
        {page && !filter && page.tasks.some(active) && <span className="download-summary is-active">进行中 {page.tasks.filter(active).length}</span>}
        {page && !filter && page.tasks.some(task => task.status === "failed") && <span className="download-summary is-failed">失败 {page.tasks.filter(task => task.status === "failed").length}</span>}
        <span className="muted">{page ? `${page.total} 个任务` : "正在读取任务"}</span>
        <Menu label="清理任务" icon="trash" items={[
          { label: "清除已完成的任务", icon: "checkCircle", onSelect: () => setClearing("completed") },
          { label: "清除失败的任务", icon: "alert", onSelect: () => setClearing("failed") },
        ]} /></span></div>
    </div>
    {page?.capabilities.pressure && <Notice tone="warning" role="status">{page.capabilities.pressure}</Notice>}
    <div className="file-surface download-surface">
      {pagination.error ? <EmptyState icon="alert" title="任务加载失败" description={pagination.error} action={<Button onClick={() => void pagination.reload()}>重试</Button>} />
        : !page ? <SkeletonRows rows={5} />
          : !page.tasks.length ? <EmptyState icon="download" title={query || filter ? "没有符合条件的任务" : "还没有下载任务"} description={query || filter ? "试试其他关键词或任务状态。" : "粘贴文件链接、X 帖子或 YouTube 视频，也可以使用 curl 命令。"} action={query || filter ? <Button onClick={() => { setSearch(""); setQuery(""); setFilter(""); }}>清除筛选</Button> : <Button icon="plus" onClick={() => setNewTask(true)}>添加下载</Button>} />
            : <div className="data-table download-list" role="table" aria-label="下载任务">
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
                return <div className={`data-row download-item is-${task.status}${checked ? " is-selected" : ""}`} role="row" key={task.id}>
                  <span className="cell-check" role="cell"><Checkbox checked={checked} label={`选择 ${name}`} onChange={value => setSelected(current => { const next = new Set(current); if (value) next.add(task.id); else next.delete(task.id); return next; })} /></span>
                  <div className="cell-name" role="cell">
                    {thumbnail && file ? <FileVisual kind={getFileKind(file.content_type, file.key)} src={thumbnail} /> : <FileTile kind={kind} />}
                    <div className="name-stack">
                      <strong className="download-name" title={name}>{name}</strong>
                      <small className="download-host" title={task.source?.url ?? task.source_host}>{task.platform === "x" ? "X · " : task.platform === "youtube" ? "YouTube · " : task.kind === "hls" ? "M3U8 · " : ""}{task.source_host}</small>
                    </div>
                  </div>
                  <div role="cell"><DownloadProgress task={task} name={name} /></div>
                  <div role="cell" className="muted">
                    {completed && canOpen ? <button type="button" className="download-location" title={`打开所在目录：${location}`} onClick={() => onOpenFolder(folder, task.private)}><Icon name="folder" size={12} /><LocationText folder={folder} /></button>
                      : <span className="download-location" title={task.trashed ? `文件已删除，原位置：${location}` : `保存到 ${location}`}><Icon name={task.trashed ? "trash" : "folder"} size={12} />{task.trashed ? <span className="download-location-text"><span>文件已删除</span></span> : <LocationText folder={folder} />}</span>}
                  </div>
                  <div className="download-state" role="cell"><Badge tone={TONE[task.status]} dot={!completed} icon={completed ? "check" : undefined}>{downloadStatusLabel(task)}</Badge></div>
                  <div className="cell-actions" role="cell">{busy.has(task.id) ? <span className="spinner" aria-label="正在处理任务" /> : <>{quick}<Menu label={`${name}的更多操作`} items={[
                    ...(task.source ? [
                      { label: "复制来源链接", icon: "copy" as const, onSelect: () => void copySource(task) },
                      { label: "打开来源链接", icon: "external" as const, onSelect: () => openSource(task) },
                    ] : []),
                    ...(task.error ? [{ label: "复制失败原因", icon: "alert" as const, onSelect: () => void copyText(task.error!, "失败原因已复制") }] : []),
                    { label: "重新下载", icon: "refresh" as const, divider: Boolean(task.source || task.error), onSelect: () => setConfirm({ task, action: "restart" }) },
                    { label: "更新下载参数", icon: "settings" as const, onSelect: () => setEdit(task) },
                    { label: "删除任务", icon: "trash" as const, danger: true, divider: true, onSelect: () => setConfirm({ task, action: "delete" }) },
                  ]} /></>}</div>
                </div>;
              })}
            </div>}
    </div>
    {page && (pagination.hasPrevious || pagination.hasNext || page.total > DOWNLOAD_PAGE_SIZES[0]) && <footer className="list-footer download-footer">
      <Pagination {...pagination} total={page.total} pageSize={pageSize} changePageSize={changePageSize} sizes={sizes} /></footer>}
    <details className="download-help"><summary><Icon name="info" size={15} /><span>下载说明</span><Icon name="chevronDown" size={14} /></summary>
      <p>支持文件直链{page?.capabilities.hls ? "、M3U8 点播" : ""}{page?.capabilities.x ? "、X 帖子" : ""}{page?.capabilities.youtube ? "、YouTube 视频和 Shorts" : ""}。平台功能由管理员启用。网络中断会自动重试；文件直链满足条件时可续传，平台和 M3U8 任务手动停止后从头下载。删除任务保留已保存的文件。</p>
    </details>
    {(newTask || edit) && <DownloadDialog task={edit} onClose={() => { setNewTask(false); setEdit(null); }} onComplete={completed} />}
    {imported && !newTask && !edit && <DownloadDialog task={null} initial={imported} onClose={() => setImported(null)} onComplete={() => { setImported(null); completed(); }} />}
    {clearing && <ConfirmDialog title={clearing === "completed" ? "清除已完成的任务" : "清除失败的任务"}
      description={clearing === "completed" ? "从列表中移除所有已完成的任务，已保存的文件不受影响。" : "移除所有失败的任务并清理未完成的数据，已保存的文件不受影响。"}
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

/** 保存位置：最后一级目录名在前（长路径也能一眼看出是哪个目录），上级路径另起一行；完整路径在悬停提示里。 */
function LocationText({ folder }: { folder: string }) {
  const trimmed = folder.replace(/\/$/, "");
  const root = api.PRIVATE_PREFIX.replace(/\/$/, "");
  if (!trimmed || trimmed === root) return <span className="download-location-text"><span>{api.privatePathLabel(folder)}</span></span>;
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
  return <span className="download-location-text"><span>{trimmed.slice(trimmed.lastIndexOf("/") + 1)}</span><small>{api.privatePathLabel(parent)}</small></span>;
}

/** 进度列：进行中显示进度条与「已下载／总大小 · 速度 · 剩余时间」，完成后显示大小与用时，失败显示原因（点击展开全文）。 */
function DownloadProgress({ task, name }: { task: api.DownloadTask; name: string }) {
  const [expanded, setExpanded] = useState(false);
  const percent = downloadPercent(task);
  const saved = task.stored_bytes || task.received;
  if (task.status === "completed") {
    const average = task.elapsed_seconds > 0 ? saved / Math.max(task.elapsed_seconds, 0.05) : null;
    return <div className="download-progress is-done">
      <span className="download-figure">{formatBytes(saved)}</span>
      <small>{[task.elapsed_seconds > 0 && `用时 ${elapsed(task.elapsed_seconds)}`, average !== null && `平均 ${formatBytes(average)}/s`].filter(Boolean).join(" · ") || "已保存"}</small>
    </div>;
  }
  if (task.status === "failed" && task.error) {
    return <button type="button" className={`download-failure${expanded ? " is-expanded" : ""}`} title={expanded ? "收起" : task.error} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
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
  return <div className={`download-progress is-${task.status}`}>
    <div className="download-progress-bar">
      {percent !== null ? <Progress value={percent} tone={running || task.status === "queued" ? "accent" : "neutral"} label={`${name}下载进度`} />
        : <div className={`download-unknown${running ? " is-running" : ""}`} role="status" aria-label="总大小未知" />}
      {percent !== null && <span className="download-percent">{Math.floor(percent)}%</span>}
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
  // 来自脚本的私密目标：未解锁时先在本页解锁，再确认保存位置。
  const access = usePrivateAccess();
  const [wantPrivate, setWantPrivate] = useState(Boolean(initial?.private));
  const needsUnlock = wantPrivate && !access.grant;
  useEffect(() => { if (wantPrivate && access.grant && !api.isPrivatePath(destination)) setDestination(api.PRIVATE_PREFIX); }, [wantPrivate, access.grant, destination]);
  const [ready, setReady] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function parse() {
    setBusy(true); setError("");
    abort.current = new AbortController();
    try {
      const result = await api.parseDownloads(input, abort.current.signal, downloadType, cookies);
      setCandidates(result.candidates);
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
      if (task) await api.controlDownload(task.id, "update", { ticket: candidates[[...selected][0]].ticket }, task.private);
      else await api.createDownloads([...selected].map(index => ({ ticket: candidates[index].ticket, name: candidates[index].name })), destination);
      toast.success(task ? "参数已更新，任务已重新加入队列" : `${selected.size} 个任务已加入下载队列`);
      onComplete();
    } catch (reason) {
      const expired = initial && reason instanceof api.ApiError && reason.status === 400 && /过期|expired/i.test(reason.message);
      setError(expired ? "解析结果已过期（20 分钟），请回到原网页重新发送。" : api.errorMessage(reason, "创建任务失败，请稍后重试"));
    }
    finally { setBusy(false); }
  }
  return <Modal title={task ? "更新下载参数" : initial ? "确认下载" : "添加下载"} icon="download" size="lg" onClose={onClose} dismissible={!busy}
    description={task ? "已填入原来的链接和请求参数，修改后重新解析，选择文件后从头重新下载。" : initial ? "这些文件由资源抓取脚本转交，确认保存位置后开始下载。" : "粘贴文件直链、X 帖子、YouTube 视频或 curl 命令。"}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button>{candidates ? <>{!initial && <Button variant="ghost" disabled={busy} onClick={() => { setCandidates(null); setError(""); }}>返回编辑</Button>}<Button variant="primary" loading={busy} disabled={!selected.size || !ready || needsUnlock} onClick={() => void submit()}>{task ? "更新并重新下载" : `开始下载${selected.size ? `（${selected.size}）` : ""}`}</Button></> : <Button variant="primary" loading={busy || prefill === "loading"} disabled={!input.trim()} onClick={() => void parse()}>{busy ? "正在读取文件信息" : "解析内容"}</Button>}</>}>
    <div className="form">
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
        <div className="download-candidates" role="group" aria-label="选择要下载的文件">
          {candidates.map((candidate, index) => <div className={`download-candidate${selected.has(index) ? " is-selected" : ""}`} key={candidate.ticket}>
            <Checkbox checked={selected.has(index)} label={`下载 ${candidate.name}${candidate.variant ? ` ${candidate.variant}` : ""}`} onChange={checked => setSelected(current => { const next = task ? new Set<number>() : new Set(current); if (checked) { if (candidate.variant) for (const item of next) if (candidates[item].group === candidate.group) next.delete(item); next.add(index); } else next.delete(index); return next; })} />
            <div className="download-candidate-copy">
              {task ? <strong>{candidate.name}</strong> : <Field label={`文件 ${index + 1} 的名称`}><input className="input" value={candidate.name} onChange={event => setCandidates(current => current?.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) ?? null)} /></Field>}
              <p>{candidate.source_host} · {candidate.variant ?? candidate.content_type ?? (candidate.media_type === "image" ? "图片" : candidate.media_type === "video" ? "视频" : candidate.media_type === "audio" ? "音频" : candidate.method)} · {candidate.size !== null ? formatBytes(candidate.size) : "大小未知"}</p>
              {(candidate.header_names.length > 0 || candidate.body_bytes > 0) && <details><summary>请求参数（凭据已隐藏）</summary><p>{candidate.header_names.length ? `请求头：${candidate.header_names.join("、")}` : "无额外请求头"}{candidate.body_bytes > 0 ? `；文本请求体 ${formatBytes(candidate.body_bytes)}` : ""}。下载时使用你提交的原值。</p></details>}
              {candidate.method === "POST" && <p className="tone-warning">点击开始才发送 POST 请求；中断后需要手动重新发送。</p>}
              {candidate.kind === "hls" && <p className="muted">保存为 MP4；停止后从头重新下载。</p>}
              {candidate.platform && <p className="muted">已解析的媒体地址会直接用于下载，失效时自动重新解析；{candidate.platform === "youtube" ? "同一视频选择一个清晰度，" : ""}停止后从头下载。</p>}
              {candidate.warnings.map((warning, i) => <p className="tone-warning" key={i}>{warning}</p>)}
            </div>
          </div>)}
        </div>
        {task ? <p className="muted">保存位置：{task.private && !api.isPrivatePath(task.key) ? "私密空间" : api.privatePathLabel(task.key)}</p>
          : needsUnlock ? <div className="download-import-unlock">
            <div className="download-import-unlock-head"><Icon name="lock" size={18} /><div><strong>保存到私密空间需要先解锁</strong><p className="muted">解锁只在当前 {BRAND} 页面完成，脚本和原网页拿不到你的密码。</p></div>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setWantPrivate(false); setDestination(""); }}>改存普通目录</Button></div>
            <PrivateUnlockForm />
          </div>
          : <><DestinationPicker key={access.grant ? "unlocked" : "locked"} value={destination} allowPrivate onChange={path => { setDestination(path); setReady(false); }} onReady={setReady} /><p className="muted">同名文件自动改名保存。来源凭据加密保存，任务列表只显示不含查询参数的来源地址。</p></>}
      </>}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  </Modal>;
}
