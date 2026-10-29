import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AssistantMark, Icon, shortcutLabel } from "../ui";
import { type AssistantDockStatus } from "./assistant";

const badgeText = (count: number) => count > 99 ? "99+" : count.toLocaleString("zh-CN");

/** 右下角只保留文件助手入口：悬停时展开名称与快捷键，处理中显示流光描边，待确认事项以角标提示。
 * 上传、离线下载与本机缓存的进度在侧栏「任务中心」的页面里查看。 */
export function AssistantLauncher({ available, open, status, onToggle }: { available: boolean; open: boolean; status: AssistantDockStatus; onToggle: () => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  // 抽屉关闭后把焦点还给入口，键盘用户不会丢失位置。
  useLayoutEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);
  if (!available) return null;
  const working = status.running && !status.pending;
  const state = status.pending ? `，${status.pending} 项等待你确认` : working ? "，正在处理" : "";
  const name = status.private ? "文件助手（私密对话）" : "文件助手";
  return createPortal(<button ref={trigger} type="button" hidden={open}
    className={`assistant-launcher${working ? " is-working" : ""}${status.pending ? " has-pending" : ""}`}
    aria-label={`${name}${state}`} aria-keyshortcuts="Meta+J Control+J" onClick={onToggle}>
    <span className="assistant-launcher-orb" aria-hidden="true"><AssistantMark size={26} state={working ? "thinking" : "idle"} /></span>
    <span className="assistant-launcher-copy" aria-hidden="true">
      <strong>{status.pending ? "等待确认" : working ? "正在处理" : "文件助手"}</strong>
      <kbd>{shortcutLabel("Mod+J")}</kbd>
    </span>
    {status.private && <span className="assistant-launcher-lock" aria-hidden="true"><Icon name="lock" size={10} /></span>}
    {status.pending > 0 && <span className="assistant-launcher-badge" aria-hidden="true">{badgeText(status.pending)}</span>}
  </button>, document.body);
}
