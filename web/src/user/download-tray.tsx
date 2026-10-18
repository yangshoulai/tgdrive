import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { Button, Icon, IconButton, formatBytes } from "../ui";
import { downloadGlyph, downloadPercent, downloadStatusLabel, downloadTaskFolder, downloadTaskName, isActiveDownload, seconds } from "./downloads";
import { TrayProgressRing, TrayRing, type TrayState } from "./tray";

const COMPLETED_VISIBLE_MS = 8000;

/**
 * 离线下载在服务器上运行，离开「下载任务」页后仍要能看到进度。
 * 托盘只跟踪本次打开页面期间处于进行中的任务；结束后保留结果，直到用户关闭。
 * 在「下载任务」页隐藏并暂停轮询，避免与页面列表重复。
 */
export function DownloadTray({ hidden, revision, onOpenTasks, onOpenFolder, onCompleted }: {
  hidden: boolean; revision: number; onOpenTasks: () => void; onOpenFolder: (prefix: string, privateSpace?: boolean) => void; onCompleted: () => void;
}) {
  const [tracked, setTrackedState] = useState<Map<number, api.DownloadTask>>(new Map());
  const trackedRef = useRef(tracked);
  const setTracked = (next: Map<number, api.DownloadTask>) => { trackedRef.current = next; setTrackedState(next); };
  const [collapsed, setCollapsed] = useState(false);
  const [retrying, setRetrying] = useState(new Set<number>());
  const completedAt = useRef(new Map<number, number>());
  const completedRef = useRef(onCompleted);
  completedRef.current = onCompleted;
  const anyActive = [...tracked.values()].some(isActiveDownload);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const lockPrivate = () => setTracked(new Map([...trackedRef.current].map(([id, task]) => [id, task.private ? { ...task, key: "私密空间下载" } : task])));
    window.addEventListener("tessera:private-locked", lockPrivate);
    return () => window.removeEventListener("tessera:private-locked", lockPrivate);
  }, []);
  useEffect(() => {
    if (hidden) return;
    const controller = new AbortController();
    // 读取全部进行中的任务（每页 100 个，最多 20 页），再按编号补读已跟踪但不再进行中的任务，取得它们的最终状态。
    // 不能只读第一页：一次添加超过一页的任务时，托盘会漏掉其余任务，标题数量也会偏少。
    const read = async () => {
      const seen = new Map<number, api.DownloadTask>();
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const result: api.DownloadPage = await api.listDownloads(cursor, "active", controller.signal, "", { limit: 100 });
        for (const task of result.tasks) seen.set(task.id, task);
        if (!result.next_cursor) break;
        cursor = String(result.next_cursor);
      }
      const rest = [...trackedRef.current.keys()].filter(id => !seen.has(id));
      for (let start = 0; start < rest.length; start += 100) {
        const result = await api.listDownloads(null, "", controller.signal, "", { ids: rest.slice(start, start + 100) });
        for (const task of result.tasks) seen.set(task.id, task);
      }
      return [...seen.values()];
    };
    void read().then(tasks => {
      const next = new Map(trackedRef.current);
      const finished = new Set<string>();
      // 已跟踪却读不到的任务已被删除（例如在任务页或另一个窗口），从托盘移除。
      const present = new Set(tasks.map(task => task.id));
      for (const id of [...next.keys()]) if (!present.has(id)) { next.delete(id); completedAt.current.delete(id); }
      for (const task of tasks) {
        const previous = next.get(task.id);
        if (previous || isActiveDownload(task)) next.set(task.id, task);
        if (previous && isActiveDownload(previous) && task.status === "completed") {
          completedAt.current.set(task.id, Date.now());
          finished.add(downloadTaskFolder(task));
        }
        if (task.status !== "completed") completedAt.current.delete(task.id);
      }
      setTracked(next);
      // 新完成的文件出现在用量里；正在浏览保存目录的文件页按事件里的目录自行刷新（其他目录不受影响）。
      if (finished.size) {
        completedRef.current();
        window.dispatchEvent(new CustomEvent("tessera:downloads-completed", { detail: { folders: [...finished] } }));
      }
    }).catch(() => undefined);
    // 有进行中的任务时 3 秒刷新；否则 30 秒检查一次其他窗口新建的任务。
    const timer = window.setTimeout(() => setTick(value => value + 1), anyActive ? 3000 : 30000);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [hidden, revision, tick, anyActive]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") setTick(value => value + 1); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  const tasks = [...tracked.values()].sort((a, b) => b.id - a.id);
  useEffect(() => {
    const completed = tasks.filter(task => task.status === "completed" && completedAt.current.has(task.id));
    if (!completed.length) return;
    const expires = Math.min(...completed.map(task => completedAt.current.get(task.id)! + COMPLETED_VISIBLE_MS));
    const timer = window.setTimeout(() => setTracked(new Map([...trackedRef.current].filter(([id, task]) => {
      const doneAt = completedAt.current.get(id);
      if (task.status === "completed" && doneAt != null && doneAt + COMPLETED_VISIBLE_MS <= Date.now()) {
        completedAt.current.delete(id);
        return false;
      }
      return true;
    }))), Math.max(0, expires - Date.now()));
    return () => window.clearTimeout(timer);
  }, [tracked]);
  useEffect(() => { if (!tasks.length) setCollapsed(false); }, [tasks.length]);
  if (hidden || !tasks.length) return null;
  const active = tasks.filter(isActiveDownload);
  const failed = tasks.filter(task => task.status === "failed").length;
  const known = active.filter(task => downloadPercent(task) !== null);
  const overall = known.length ? known.reduce((sum, task) => sum + (downloadPercent(task) ?? 0), 0) / known.length : null;
  const speed = active.reduce((sum, task) => sum + (task.status === "running" ? task.speed || 0 : 0), 0);
  const eta = active.reduce<number | null>((longest, task) => task.eta_seconds === null ? longest : Math.max(longest ?? 0, task.eta_seconds), null);
  const state: TrayState = active.length ? "active" : failed ? "error" : "done";
  const title = active.length ? `正在下载 ${active.length} 个文件` : failed ? `${failed} 个下载失败` : "离线下载完成";
  const subtitle = active.length ? [speed ? `${formatBytes(speed)}/s` : "等待数据", eta !== null && speed ? `约剩 ${seconds(eta)}` : null, overall !== null ? `${Math.floor(overall)}%` : null].filter(Boolean).join(" · ")
    : failed ? "可以继续下载，或到任务页查看原因" : "文件已保存到云盘";
  const dismiss = () => setTracked(new Map([...trackedRef.current].filter(([, task]) => isActiveDownload(task))));
  async function retry(task: api.DownloadTask) {
    setRetrying(current => new Set(current).add(task.id));
    try {
      const updated = await api.controlDownload(task.id, "resume", undefined, task.private);
      if (updated) setTracked(new Map(trackedRef.current).set(task.id, updated));
      setTick(value => value + 1);
    } catch { /* 失败原因在任务页查看 */ }
    finally { setRetrying(current => { const next = new Set(current); next.delete(task.id); return next; }); }
  }
  return (
    <aside className={`upload-tray download-tray is-${state}${collapsed ? " is-collapsed" : ""}`} aria-label="离线下载进度" aria-live="polite">
      <header>
        <TrayRing state={state} percent={overall} icon="download" />
        <div className="tray-heading"><strong>{title}</strong><small>{subtitle}</small></div>
        <IconButton icon="chevronDown" size="sm" label={collapsed ? "展开" : "收起"} onClick={() => setCollapsed(value => !value)} />
        <IconButton icon="list" size="sm" label="查看下载任务" onClick={onOpenTasks} />
        {!active.length && <IconButton icon="x" size="sm" label="关闭下载列表" onClick={dismiss} />}
      </header>
      {!collapsed && (
        <ul>
          {tasks.map(task => {
            const name = downloadTaskName(task);
            const location = api.privatePathLabel(downloadTaskFolder(task));
            const percent = downloadPercent(task);
            const running = isActiveDownload(task);
            const progress = task.size ? `${formatBytes(task.received)} / ${formatBytes(task.size)}` : task.received ? formatBytes(task.received) : null;
            const detail = running ? [downloadStatusLabel(task), task.status === "running" && task.phase !== "resolving" ? progress : null, task.status === "running" && task.speed ? `${formatBytes(task.speed)}/s` : null, task.status === "interrupted" ? task.error : null].filter(Boolean).join(" · ")
              : task.status === "completed" ? formatBytes(task.stored_bytes || task.size || 0) : task.error ?? downloadStatusLabel(task);
            return <li key={task.id} className={`tray-item is-${task.status}`}>
              <span className="tray-icon"><span className={`download-glyph download-glyph-${downloadGlyph(task)}`}><Icon name={downloadGlyph(task)} size={18} /></span>
                {(task.status === "queued" || task.status === "completed" || task.status === "failed") && <span className="tray-badge" role="img" aria-label={downloadStatusLabel(task)} title={downloadStatusLabel(task)}><Icon name={task.status === "queued" ? "clock" : task.status === "completed" ? "check" : "alert"} size={10} /></span>}</span>
              <div className="tray-job">
                <span className="tray-name" title={name}><span>{name}</span></span>
                <small className="tray-destination muted" title={`保存到 ${location}`}><Icon name={task.private ? "lock" : "folder"} size={12} /><span>{location}</span></small>
                {task.status !== "queued" && <small className={task.status === "failed" ? "tone-danger" : "muted"}>{detail}</small>}
              </div>
              <span className="tray-right">
                {running && <TrayProgressRing percent={percent} paused={task.status !== "running"} label={`${name}：${downloadStatusLabel(task)}`} />}
                {task.status === "completed" && <IconButton icon="folder" size="sm" label={`打开 ${name} 所在目录`} onClick={() => onOpenFolder(downloadTaskFolder(task), task.private)} />}
                {(task.status === "failed" || task.status === "stopped") && task.method !== "POST" && <Button size="sm" icon="refresh" loading={retrying.has(task.id)} aria-label={`继续下载 ${name}`} onClick={() => void retry(task)}>继续</Button>}
              </span>
            </li>;
          })}
        </ul>
      )}
    </aside>
  );
}
