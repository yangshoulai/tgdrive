import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Button, Icon, Modal, shortcutLabel, type IconName } from "../ui";
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
  const pending = assistantAvailable ? assistantStatus.pending : 0;
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
  const items: { key: TaskWindow | "assistant"; label: string; description: string; icon: IconName; count: number; pending?: boolean; private?: boolean }[] = [
    { key: "upload", label: "上传任务", description: "查看上传记录", icon: "upload", count: uploadRunning },
    { key: "download", label: "下载任务", description: "查看服务器下载", icon: "download", count: downloads },
    { key: "cache", label: "本机缓存", description: "管理此设备上的缓存", icon: "monitor", count: cacheRunning },
    ...(assistantAvailable ? [{ key: "assistant" as const, label: "文件助手", description: "查找、整理你的文件", icon: "chat" as const, count: assistantCount, pending: pending > 0, private: assistantStatus.private }] : []),
  ];
  return <>
    {createPortal(<div ref={root} hidden={assistantOpen} className={`system-tray${expanded ? " is-open" : ""}${working ? " is-working" : ""}${pending ? " has-pending" : ""}`}
      onPointerEnter={event => { if (event.pointerType !== "touch") { cancelCollapse(); if (!expanded) openedByHover.current = true; setExpanded(true); } }}
      onPointerLeave={event => {
        if (event.pointerType !== "touch" && !root.current?.querySelector(".system-tray-item:focus-visible"))
          collapseTimer.current = window.setTimeout(() => setExpanded(false), 160);
      }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false); }}
      onKeyDown={event => {
        cancelCollapse();
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setExpanded(false); trigger.current?.focus(); }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const buttons = [...root.current!.querySelectorAll<HTMLButtonElement>(".system-tray-item")];
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          const next = event.key === "ArrowUp" ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
          setExpanded(true);
          requestAnimationFrame(() => buttons[next]?.focus({ preventScroll: true }));
        }
      }}>
      <button ref={trigger} type="button" className="system-tray-trigger" aria-label={`系统托盘：任务与助手${count ? `，${count} 项进行中或等待处理` : ""}`}
        title={expanded ? "收起系统托盘" : "系统托盘 · 上传、下载、缓存与助手"} aria-expanded={expanded} aria-controls={`${id}-items`}
        onClick={event => {
          cancelCollapse();
          // 鼠标点击前会先触发进入事件，第一次点击不能把刚展开的入口立即收回。
          if (event.detail > 0 && openedByHover.current) { openedByHover.current = false; setExpanded(true); }
          else setExpanded(value => !value);
        }}>
        <span className="system-tray-trigger-icon"><Icon name="list" size={22} /><span className="system-tray-signal" aria-hidden="true" /></span>
        <span className="system-tray-trigger-label">任务</span><Icon name="chevronDown" size={14} className="system-tray-chevron" />
        {count > 0 && <span className="system-tray-badge" aria-hidden="true">{badgeText(count)}</span>}
      </button>
      <div id={`${id}-items`} className="system-tray-items" role="group" aria-labelledby={`${id}-heading`} aria-hidden={!expanded}>
        <div className="system-tray-panel">
          <div className="system-tray-heading"><strong id={`${id}-heading`}>任务中心</strong><span className="system-tray-summary">
            {pending ? `${badgeText(pending)} 项待确认` : count ? `${badgeText(count)} 项进行中` : "随时查看进度"}
          </span></div>
          {items.map((item, index) => <button type="button" key={item.key} className={`system-tray-item is-${item.key}${item.count && !item.pending ? " is-active" : ""}${item.pending ? " has-pending" : ""}`} tabIndex={expanded ? 0 : -1}
            style={{ "--tray-item-index": items.length - index - 1 } as CSSProperties} onClick={() => open(item.key)}
            aria-label={`${item.label}${item.count ? `，${item.count} ${item.pending ? "项等待处理" : "个进行中"}` : ""}${item.private ? "，私密对话" : ""}`}
            title={item.key === "assistant" ? `文件助手（${shortcutLabel("Mod+J")}）` : item.label}>
            <span className="system-tray-icon"><Icon name={item.icon} size={22} /></span>
            <span className="system-tray-copy"><span className="system-tray-label">{item.label}{item.private && <Icon name="lock" size={12} />}</span>
              <span className="system-tray-description">{item.pending ? "等待你确认" : item.count ? item.key === "assistant" ? "正在处理" : `${item.count.toLocaleString("zh-CN")} 项进行中` : item.description}</span>
            </span>
            {item.count > 0 ? <span className="system-tray-count" aria-hidden="true">{badgeText(item.count)}</span>
              : item.key === "assistant" ? <kbd className="system-tray-shortcut" aria-hidden="true">{shortcutLabel("Mod+J")}</kbd> : <Icon name="chevronRight" size={14} className="system-tray-arrow" />}
          </button>)}
        </div>
      </div>
    </div>, document.body)}
    {activeWindow === "upload" && <UploadTasks queue={uploads} onClose={close} />}
    {activeWindow === "download" && <Modal title="下载任务" icon="download" size="xl" className="task-window task-download-window" onClose={close} initialFocus="dialog"
      description="由服务器下载，关闭网页后任务继续。"
      footer={<><span className="task-window-footnote"><Icon name="server" size={14} /><span>删除任务保留已保存的文件</span></span><Button onClick={close}>隐藏窗口</Button></>}>
      <DownloadsView embedded onChanged={onChanged} onOpenFolder={(prefix, privateSpace) => { close(); onOpenFolder(prefix, privateSpace); }} />
    </Modal>}
    {activeWindow === "cache" && <CacheTasks onClose={close} onSettings={() => { close(); onCacheSettings(); }} />}
  </>;
}
