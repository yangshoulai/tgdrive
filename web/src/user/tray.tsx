/** 上传与离线下载托盘共用的展示件：头部总进度、行尾圆环与行内细进度条。 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Icon, type IconName } from "../ui";

export type TrayState = "active" | "done" | "error" | "idle";

/** 进行中显示总进度圆环与方向图标；结束后圆环填满并换成对勾或感叹号。percent 为 null 表示总量未知，圆环转动。 */
export function TrayRing({ state, percent, icon }: { state: TrayState; percent: number | null; icon: IconName }) {
  const value = state === "active" ? percent : 100;
  return <span className={`tray-ring is-${state}${state === "active" && value === null ? " is-indeterminate" : ""}`} aria-hidden="true"
    style={{ "--tray-progress": value ?? 28 } as CSSProperties}>
    <svg viewBox="0 0 36 36"><circle className="tray-ring-track" cx="18" cy="18" r="16" /><circle className="tray-ring-value" cx="18" cy="18" r="16" pathLength="100" /></svg>
    <Icon name={state === "done" ? "check" : state === "error" ? "alert" : state === "idle" ? "x" : icon} size={15} />
  </span>;
}

/** 下载行尾进度复用头部圆环；等待且大小未知时显示空轨道，不伪造进度。 */
export function TrayProgressRing({ percent, label, paused = false }: { percent: number | null; label: string; paused?: boolean }) {
  const value = percent === null ? null : Math.max(0, Math.min(100, percent));
  const detail = value === null ? "总大小未知" : `${Math.floor(value)}%`;
  return <span className={`tray-progress${paused ? " is-paused" : ""}`} role="progressbar" aria-label={label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.floor(value)} aria-valuetext={detail} title={`${label} · ${detail}`}>
    <TrayRing state="active" percent={paused && value === null ? 0 : value} icon="download" />
  </span>;
}

/** 行内进度：已知比例时带流光，未知总量时显示来回移动的条。 */
export function TrayBar({ percent, label, paused = false }: { percent: number | null; label: string; paused?: boolean }) {
  const value = percent === null ? null : Math.max(0, Math.min(100, percent));
  return <div className={`tray-bar${value === null ? " is-indeterminate" : ""}${paused ? " is-paused" : ""}`} role="progressbar" aria-label={label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value)}>
    <span style={value === null ? undefined : { width: `${value}%` }} />
  </div>;
}

/** 托盘底栏：左侧状态摘要，右侧批量操作与跳转。 */
export function TrayFoot({ summary, children }: { summary: ReactNode; children?: ReactNode }) {
  return <footer className="tray-foot"><span className="tray-foot-summary">{summary}</span>{children}</footer>;
}

/** 「全部取消」：第一次点击变为确认态（4 秒内再点一次才执行），避免误触打断大量任务。 */
export function TrayCancelAll({ count, noun, onConfirm }: { count: number; noun: string; onConfirm: () => Promise<void> | void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return <button type="button" className={`tray-cancel-all${armed ? " is-armed" : ""}`} disabled={busy || !count} aria-live="polite"
    onClick={async () => {
      if (!armed) { setArmed(true); return; }
      setBusy(true);
      try { await onConfirm(); } finally { setBusy(false); setArmed(false); }
    }}>
    {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="x" size={12} />}
    {armed ? `确认取消 ${count.toLocaleString("zh-CN")} 个${noun}` : "全部取消"}
  </button>;
}

/** 头部下方的整体进度细条（进行中才显示）。 */
export function TrayOverall({ percent }: { percent: number | null }) {
  return <div className={`tray-overall${percent === null ? " is-indeterminate" : ""}`} aria-hidden="true">
    <span style={percent === null ? undefined : { width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>;
}
