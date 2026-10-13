/** 上传与离线下载托盘共用的展示件：头部的环形总进度和每行的细进度条。 */
import type { CSSProperties } from "react";
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

/** 行内进度：已知比例时带流光，未知总量时显示来回移动的条。 */
export function TrayBar({ percent, label, paused = false }: { percent: number | null; label: string; paused?: boolean }) {
  const value = percent === null ? null : Math.max(0, Math.min(100, percent));
  return <div className={`tray-bar${value === null ? " is-indeterminate" : ""}${paused ? " is-paused" : ""}`} role="progressbar" aria-label={label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value)}>
    <span style={value === null ? undefined : { width: `${value}%` }} />
  </div>;
}
