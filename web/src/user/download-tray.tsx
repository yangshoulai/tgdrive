import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { Button, Icon, IconButton, Progress, formatBytes } from "../ui";
import { downloadGlyph, downloadPercent, downloadStatusLabel, isActiveDownload, parentFolder } from "./downloads";

/**
 * 离线下载在服务器上运行，离开「下载任务」页后仍要能看到进度。
 * 托盘只跟踪本次打开页面期间处于进行中的任务；结束后保留结果，直到用户关闭。
 * 在「下载任务」页隐藏并暂停轮询，避免与页面列表重复。
 */
export function DownloadTray({ hidden, revision, onOpenTasks, onOpenFolder, onCompleted }: {
  hidden: boolean; revision: number; onOpenTasks: () => void; onOpenFolder: (prefix: string) => void; onCompleted: () => void;
}) {
  const [tracked, setTrackedState] = useState<Map<number, api.DownloadTask>>(new Map());
  const trackedRef = useRef(tracked);
  const setTracked = (next: Map<number, api.DownloadTask>) => { trackedRef.current = next; setTrackedState(next); };
  const [collapsed, setCollapsed] = useState(false);
  const [retrying, setRetrying] = useState(new Set<number>());
  const completedRef = useRef(onCompleted);
  completedRef.current = onCompleted;
  const anyActive = [...tracked.values()].some(isActiveDownload);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (hidden) return;
    const controller = new AbortController();
    void api.listDownloads(null, "", controller.signal).then(page => {
      const next = new Map(trackedRef.current);
      let finished = false;
      for (const task of page.tasks) {
        const previous = next.get(task.id);
        if (previous || isActiveDownload(task)) next.set(task.id, task);
        if (previous && isActiveDownload(previous) && task.status === "completed") finished = true;
      }
      setTracked(next);
      // 新完成的文件出现在文件列表和用量里。
      if (finished) completedRef.current();
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
  useEffect(() => { if (!tasks.length) setCollapsed(false); }, [tasks.length]);
  if (hidden || !tasks.length) return null;
  const active = tasks.filter(isActiveDownload);
  const failed = tasks.filter(task => task.status === "failed").length;
  const known = active.filter(task => downloadPercent(task) !== null);
  const overall = known.length ? known.reduce((sum, task) => sum + (downloadPercent(task) ?? 0), 0) / known.length : null;
  const title = active.length ? `正在下载 ${active.length} 个文件` : failed ? `${failed} 个下载失败` : "离线下载完成";
  const dismiss = () => setTracked(new Map([...trackedRef.current].filter(([, task]) => isActiveDownload(task))));
  async function retry(task: api.DownloadTask) {
    setRetrying(current => new Set(current).add(task.id));
    try {
      const updated = await api.controlDownload(task.id, "resume");
      if (updated) setTracked(new Map(trackedRef.current).set(task.id, updated));
      setTick(value => value + 1);
    } catch { /* 失败原因在任务页查看 */ }
    finally { setRetrying(current => { const next = new Set(current); next.delete(task.id); return next; }); }
  }
  return (
    <aside className={`upload-tray download-tray${collapsed ? " is-collapsed" : ""}`} aria-label="离线下载进度" aria-live="polite">
      <header>
        <span className={`tray-status${active.length ? " is-active" : failed ? " is-error" : " is-done"}`}><Icon name={active.length ? "download" : failed ? "alert" : "check"} size={16} /></span>
        <strong>{title}</strong>
        <IconButton icon="chevronDown" size="sm" label={collapsed ? "展开" : "收起"} onClick={() => setCollapsed(value => !value)} />
        <IconButton icon="list" size="sm" label="查看下载任务" onClick={onOpenTasks} />
        {!active.length && <IconButton icon="x" size="sm" label="关闭下载列表" onClick={dismiss} />}
      </header>
      {overall !== null && <Progress value={overall} label="离线下载总体进度" />}
      {!collapsed && (
        <ul>
          {tasks.map(task => {
            const name = task.key.split("/").at(-1) ?? task.key;
            const percent = downloadPercent(task);
            const running = isActiveDownload(task);
            return <li key={task.id}>
              <span className="download-glyph"><Icon name={downloadGlyph(task)} size={20} /></span>
              <div className="tray-job">
                <span className="tray-name" title={task.key}>{name}</span>
                {running ? percent !== null ? <Progress value={percent} label={`${name} 下载进度`} /> : <div className="download-unknown" role="status" aria-label="总大小未知" />
                  : <small className={task.status === "failed" ? "tone-danger" : "muted"}>{task.status === "completed" ? formatBytes(task.stored_bytes || task.size || 0) : task.error ?? downloadStatusLabel(task)}</small>}
                {running && <small className="muted">{downloadStatusLabel(task)}{task.status === "running" && task.speed ? ` · ${formatBytes(task.speed)}/s` : ""}{task.status === "interrupted" && task.error ? ` · ${task.error}` : ""}</small>}
              </div>
              <span className="tray-right">
                {running && percent !== null && <small className="muted">{Math.floor(percent)}%</small>}
                {task.status === "completed" && <IconButton icon="folder" size="sm" label={`打开 ${name} 所在目录`} onClick={() => onOpenFolder(parentFolder(task.key))} />}
                {(task.status === "failed" || task.status === "stopped") && task.method !== "POST" && <Button size="sm" icon="refresh" loading={retrying.has(task.id)} aria-label={`继续下载 ${name}`} onClick={() => void retry(task)}>继续</Button>}
              </span>
            </li>;
          })}
        </ul>
      )}
    </aside>
  );
}
