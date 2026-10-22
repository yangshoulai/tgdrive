import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AssistantMark, Icon, Modal, SystemTrayMark, shortcutLabel, type IconName } from "../ui";
import { type AssistantDockStatus } from "./assistant";
import { CacheTasks, useCacheQueue } from "./cache";
import { useDownloadActivity } from "./download-tray";
import { DownloadsView } from "./downloads";
import { UploadTasks, type UploadQueue } from "./uploads";

export type TaskWindow = "upload" | "download" | "cache";
type Props = {
  enabled: boolean; uploads: UploadQueue; activeWindow: TaskWindow | null; onWindowChange: (value: TaskWindow | null) => void;
  downloadRevision: number; onChanged: () => void; onOpenFolder: (prefix: string, privateSpace?: boolean) => void; onCacheSettings: () => void;
  assistantAvailable: boolean; assistantOpen: boolean; assistantStatus: AssistantDockStatus; onOpenAssistant: () => void;
};
const badgeText = (count: number) => count > 99 ? "99+" : count.toLocaleString("zh-CN");

/** 唯一的全局任务入口。任务由各自队列持有，托盘展开与管理窗口的显示都不改变执行状态。 */
export function TaskCenter({ enabled, uploads, activeWindow, onWindowChange, downloadRevision, onChanged, onOpenFolder, onCacheSettings,
  assistantAvailable, assistantOpen, assistantStatus, onOpenAssistant }: Props) {
  const cache = useCacheQueue();
  const downloads = useDownloadActivity(enabled, downloadRevision, onChanged);
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const collapseTimer = useRef<number>();
  const openedByHover = useRef(false);
  const wasAssistantOpen = useRef(assistantOpen);
  const id = useId();
  const uploadRunning = uploads.jobs.filter(job => job.status === "queued" || job.status === "uploading").length
    + uploads.folderShares.filter(folder => folder.status === "sharing").length;
  const cacheRunning = (cache?.jobs.filter(job => job.status === "queued" || job.status === "active").length ?? 0)
    + (cache?.folders.filter(folder => folder.status === "active").length ?? 0);
  const assistantCount = assistantAvailable ? assistantStatus.pending || (assistantStatus.running ? 1 : 0) : 0;
  const count = uploadRunning + downloads + cacheRunning + assistantCount;
  const working = Boolean(uploadRunning || downloads || cacheRunning || assistantAvailable && assistantStatus.running && !assistantStatus.pending);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setExpanded(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);
  useEffect(() => () => window.clearTimeout(collapseTimer.current), []);
  useEffect(() => { if (assistantOpen || !enabled) setExpanded(false); }, [assistantOpen, enabled]);
  useEffect(() => { if (!expanded) openedByHover.current = false; }, [expanded]);
  useLayoutEffect(() => {
    if (wasAssistantOpen.current && !assistantOpen && !activeWindow) trigger.current?.focus({ preventScroll: true });
    wasAssistantOpen.current = assistantOpen;
  }, [assistantOpen, activeWindow]);
  if (!enabled) return null;
  const close = () => onWindowChange(null);
  const open = (target: TaskWindow | "assistant") => {
    cancelCollapse(); setExpanded(false); trigger.current?.focus();
    if (target === "assistant") { close(); onOpenAssistant(); } else onWindowChange(target);
  };
  function cancelCollapse() { window.clearTimeout(collapseTimer.current); }
  const items: { key: TaskWindow | "assistant"; label: string; icon: IconName; count: number; pending?: boolean; private?: boolean }[] = [
    { key: "upload", label: "上传任务", icon: "upload", count: uploadRunning },
    { key: "download", label: "下载任务", icon: "download", count: downloads },
    { key: "cache", label: "本机缓存", icon: "monitor", count: cacheRunning },
    ...(assistantAvailable ? [{ key: "assistant" as const, label: "文件助手", icon: "chat" as const, count: assistantCount, pending: assistantStatus.pending > 0, private: assistantStatus.private }] : []),
  ];
  return <>
    {createPortal(<div ref={root} hidden={assistantOpen} className={`system-tray${expanded ? " is-open" : ""}${working ? " is-working" : ""}${assistantAvailable && assistantStatus.pending ? " has-pending" : ""}`}
      onPointerEnter={event => { if (event.pointerType !== "touch") { cancelCollapse(); if (!expanded) openedByHover.current = true; setExpanded(true); } }}
      onPointerLeave={event => { if (event.pointerType !== "touch") collapseTimer.current = window.setTimeout(() => setExpanded(false), 160); }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setExpanded(false); trigger.current?.focus(); }
        if (event.key === "ArrowUp" && event.target === trigger.current) { event.preventDefault(); setExpanded(true); requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(".system-tray-item")?.focus()); }
      }}>
      <div id={`${id}-items`} className="system-tray-items" aria-label="任务与助手入口" aria-hidden={!expanded}>
        {items.map((item, index) => <button type="button" key={item.key} className={`system-tray-item${item.pending ? " has-pending" : ""}`} tabIndex={expanded ? 0 : -1}
          style={{ "--tray-item-index": items.length - index - 1 } as CSSProperties} onClick={() => open(item.key)}
          aria-label={`${item.label}${item.count ? `，${item.count} ${item.pending ? "项等待处理" : "个进行中"}` : ""}${item.private ? "，私密对话" : ""}`}
          title={item.key === "assistant" ? `文件助手（${shortcutLabel("Mod+J")}）` : item.label}>
          {item.key === "assistant" ? <AssistantMark size={24} monochrome state={assistantStatus.running && !assistantStatus.pending ? "thinking" : "idle"} /> : <Icon name={item.icon} size={21} />}
          {item.count > 0 && <span className="system-tray-badge" aria-hidden="true">{badgeText(item.count)}</span>}
          {item.private && <span className="system-tray-lock" aria-hidden="true"><Icon name="lock" size={10} /></span>}
        </button>)}
      </div>
      <button ref={trigger} type="button" className="system-tray-trigger" aria-label={`系统托盘${count ? `，${count} 项进行中或等待处理` : ""}`}
        title={expanded ? "收起系统托盘" : "系统托盘 · 上传、下载、缓存与助手"} aria-expanded={expanded} aria-controls={`${id}-items`}
        onClick={event => {
          cancelCollapse();
          // 鼠标点击前会先触发进入事件，第一次点击不能把刚展开的入口立即收回。
          if (event.detail > 0 && openedByHover.current) { openedByHover.current = false; setExpanded(true); }
          else setExpanded(value => !value);
        }}>
        <span className="system-tray-orbit" aria-hidden="true" /><SystemTrayMark />
        {count > 0 && <span className="system-tray-badge" aria-hidden="true">{badgeText(count)}</span>}
      </button>
    </div>, document.body)}
    {activeWindow === "upload" && <UploadTasks queue={uploads} onClose={close} />}
    {activeWindow === "download" && <Modal title="下载任务" icon="download" size="xl" className="task-window task-download-window" onClose={close} initialFocus="dialog"
      description="下载由服务器执行。关闭窗口后任务继续，已保存的文件不受任务删除影响。">
      <DownloadsView embedded onChanged={onChanged} onOpenFolder={(prefix, privateSpace) => { close(); onOpenFolder(prefix, privateSpace); }} />
    </Modal>}
    {activeWindow === "cache" && <CacheTasks onClose={close} onSettings={() => { close(); onCacheSettings(); }} />}
  </>;
}
