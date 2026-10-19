/** Tessera 设计系统基元：所有页面只通过这里的组件表达按钮、表单、浮层和反馈。 */
import { Children, Fragment, cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type CSSProperties, type KeyboardEventHandler, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BRAND, TAGLINE } from "./brand";
import { FILE_PAGE_SIZES } from "./pagination";

/* ---------- 图标 ---------- */

const ICONS = {
  folder: "M3 7.2A2.2 2.2 0 0 1 5.2 5h3.6l2 2.2h8A2.2 2.2 0 0 1 21 9.4v8.4a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8z",
  folderPlus: "M3 7.2A2.2 2.2 0 0 1 5.2 5h3.6l2 2.2h8A2.2 2.2 0 0 1 21 9.4v8.4a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8zM12 11v6m-3-3h6",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zm0 0v5h5",
  fileText: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zm0 0v5h5M9 13h6m-6 4h4",
  image: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm-1 12 4.5-4.5 4 4 2.5-2.5L20 17M15.5 9.5h.01",
  video: "M4 6h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm12 4.5 5-3v9l-5-3",
  audio: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  archive: "M4 4h16v4H4zm1 4v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4",
  code: "m8 8-4 4 4 4m8-8 4 4-4 4M14 5l-4 14",
  home: "m3 11 9-7 9 7v8a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  at: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm0 0v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1",
  wrap: "M4 6h16M4 12h12.5a3.5 3.5 0 0 1 0 7H13m0 0 2-2m-2 2 2 2M4 18h5",
  key: "M15.5 8.5a3 3 0 1 1-3-3 3 3 0 0 1 3 3Zm-5.1 2.1L4 17v3h3v-2h2v-2h2l1.4-1.4",
  book: "M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2zm0 15a2 2 0 0 0 2 2h13v-4",
  users: "M16 20v-1.5A3.5 3.5 0 0 0 12.5 15h-5A3.5 3.5 0 0 0 4 18.5V20m6-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm6-5a2.5 2.5 0 0 1 0 5m4 8v-1.5a3.5 3.5 0 0 0-2.5-3.35",
  send: "M21 3 3 10.5l7 2.5m11-10-8 18-3-8m11-10L10 13",
  box: "M4 7.5 12 3l8 4.5v9L12 21l-8-4.5zm0 0 8 4.5 8-4.5M12 12v9",
  chat: "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  pulse: "M3 12h4l2-6 4 12 2-6h6",
  chart: "M4 20V10m6 10V4m6 16v-7m4 7H3",
  search: "m20 20-4.2-4.2M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z",
  upload: "M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3",
  download: "M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3",
  plus: "M12 5v14M5 12h14",
  more: "M12 6h.01M12 12h.01M12 18h.01",
  eye: "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  trash: "M4 7h16m-10 4v6m4-6v6M9 7V4h6v3M6 7l1 13h10l1-13",
  copy: "M9 9h10v11H9zM5 15V5a1 1 0 0 1 1-1h9",
  link: "M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-9-9h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z",
  unlock: "M7 11V8a5 5 0 0 1 9.6-2M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z",
  check: "m5 12.5 4.5 4.5L19 7.5",
  checkCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-4-9 2.8 2.8L16 9.6",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3 2",
  alert: "M12 3.5 2.5 20h19zM12 10v4.5m0 2.5h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v5m0-8h.01",
  x: "M6 6l12 12M18 6 6 18",
  paperclip: "M20.5 11.5 12 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4L15 7.5",
  pin: "m8 3 8 0-1 5 4 5H5l4-5-1-5M12 13v8",
  minimize: "M5 16h14",
  maximize: "M5 5h14v14H5z",
  restore: "M8 8h12v12H8zM4 16V4h12",
  fullscreen: "M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5",
  exitFullscreen: "M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5",
  chevronRight: "m9 6 6 6-6 6",
  chevronDown: "m6 9 6 6 6-6",
  arrowLeft: "M19 12H5m6-6-6 6 6 6",
  external: "M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  logout: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4m-4 4h10",
  menu: "M4 6h16M4 12h16M4 18h16",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  gridView: "M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z",
  edit: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zm9.5-13.5 4 4",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0",
  mail: "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zm.5-.5 7.5 6 7.5-6",
  move: "M3 7.2A2.2 2.2 0 0 1 5.2 5h3.6l2 2.2h8A2.2 2.2 0 0 1 21 9.4v8.4a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8zM9 13.5h6m-2.5-2.5 2.5 2.5-2.5 2.5",
  shield: "M12 3 4.5 6v6c0 4.4 3.2 7.8 7.5 9 4.3-1.2 7.5-4.6 7.5-9V6z",
  server: "M4 4h16v6H4zm0 10h16v6H4zm3-7h.01M7 17h.01",
  monitor: "M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm4 15h8m-4-3v3",
  play: "M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.2 4.1a.8.8 0 0 0-1.2.7Z",
  pause: "M8 5v14M16 5v14",
  previous: "M5 5v14m13-14L8 12l10 7V5Z",
  next: "M19 5v14M6 5l10 7-10 7V5Z",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-13v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  refresh: "M20 11a8 8 0 0 0-14.6-4.5L4 8m0-4v4h4m-4 5a8 8 0 0 0 14.6 4.5L20 16m0 4v-4h-4",
  shuffle: "M16 4h4v4M4 20 20 4M20 16v4h-4m-1-5 5 5M4 4l5 5",
  repeat: "m17 2 3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3m16-3v2a4 4 0 0 1-4 4H4",
  repeatOne: "m17 2 3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3m16-3v2a4 4 0 0 1-4 4H4m7-9.5 1.5-1v5.5",
  sequence: "M4 6h11M4 12h11M4 18h7m8-9v9m0 0-2.5-2.5M19 18l2.5-2.5",
  volume: "M11 5 6 9H3v6h3l5 4zm4.5 3.5a5 5 0 0 1 0 7m3-10a9 9 0 0 1 0 13",
  volumeLow: "M11 5 6 9H3v6h3l5 4zm4.5 3.5a5 5 0 0 1 0 7",
  volumeMute: "M11 5 6 9H3v6h3l5 4zm11 4-6 6m0-6 6 6",
  zoomIn: "m20 20-4.2-4.2M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm0-10v6m-3-3h6",
  zoomOut: "m20 20-4.2-4.2M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm-3-7h6",
  rotate: "M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5",
  chevronLeft: "m15 6-6 6 6 6",
  fitScreen: "M4 9V5a1 1 0 0 1 1-1h4m6 0h4a1 1 0 0 1 1 1v4m0 6v4a1 1 0 0 1-1 1h-4m-6 0H5a1 1 0 0 1-1-1v-4",
  keyboard: "M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm3 4h.01M11 10h.01M15 10h.01M7 14h.01M17 14h.01M10 14h4",
  sparkle: "M12 4.5 13.6 9a2 2 0 0 0 1.4 1.4l4.5 1.6-4.5 1.6a2 2 0 0 0-1.4 1.4L12 19.5l-1.6-4.5A2 2 0 0 0 9 13.6L4.5 12 9 10.4A2 2 0 0 0 10.4 9zM18.5 3v3.5M16.75 4.75h3.5",
  stop: "M7 7h10v10H7z",
  arrowUp: "M12 19V5m-6 6 6-6 6 6",
  zap: "M13 3 5 13.5h6L10 21l8-10.5h-6z",
  brain: "M9.5 4.5A2.5 2.5 0 0 0 7 7v.2A3 3 0 0 0 5 10a3 3 0 0 0 1 2.2A3 3 0 0 0 7.5 17a2.5 2.5 0 0 0 4.5 1.5V6a1.5 1.5 0 0 0-2.5-1.5ZM14.5 4.5A2.5 2.5 0 0 1 17 7v.2A3 3 0 0 1 19 10a3 3 0 0 1-1 2.2 3 3 0 0 1-1.5 4.8 2.5 2.5 0 0 1-4.5 1.5",
  cursor: "m5 4 13 5.5-5.5 2-2 5.5zm8 8 5 5",
  wrench: "M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17v3h3l5.5-5.5a4 4 0 0 0 5.2-5.2l-2.5 2.5-2.7-.3-.3-2.7z",
  sidebar: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm4 0v16",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-2.2-1.3L14.3 3h-4l-.4 2.4a7.4 7.4 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a7.4 7.4 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3Z",
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {name === "more" ? [5, 12, 19].map(cy => <circle key={cy} cx="12" cy={cy} r="1.65" fill="currentColor" stroke="none" />) : <path d={ICONS[name]} />}
    </svg>
  );
}

/* ---------- 品牌 ---------- */

/** 标志：与网页图标（build-apps.mjs、docs/logo.svg）同一几何——暗灰圆角底座上三块白色瓦片（透明度递减），右上角是公开色纸飞机。 */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect className="logo-bg" x=".5" y=".5" width="31" height="31" rx="7.5" />
      <rect className="logo-tile" x="5" y="5" width="10" height="10" rx="2.4" />
      <rect className="logo-tile" x="5" y="17" width="10" height="10" rx="2.4" fillOpacity=".6" />
      <rect className="logo-tile" x="17" y="17" width="10" height="10" rx="2.4" fillOpacity=".32" />
      <polygon className="logo-plane" points="18.2,6.2 25.8,6.2 25.8,13.8" strokeWidth="2.4" strokeLinejoin="round" />
      <path className="logo-fold" d="M25.1 6.9 22.2 9.8" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

/** 文件助手标识：实心文件（currentColor）+ 品牌琥珀折角（与 LogoMark 的琥珀片呼应）+ 镂空双眼与浅笑。
 * 实心形状在 18–20px 仍然清晰；眼睛与嘴用 --surface，深浅色下都与身体拉开对比。运行状态只改变双眼明暗。 */
export type AssistantMarkState = "idle" | "thinking" | "tool" | "writing";

/** 文件助手头像「瓦片智核」：四块马赛克瓦片（右上为品牌琥珀色）围绕发光内核。
 * thinking 瓦片环绕旋转、内核呼吸；tool 瓦片依次向内咬合并有扫描线；writing 内核轻柔呼吸；idle 静止。 */
export function AssistantMark({ size = 20, state = "idle" }: { size?: number; state?: AssistantMarkState }) {
  const glow = useId();
  return (
    <svg className={`assistant-mark is-${state}`} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <defs>
        <radialGradient id={glow}>
          <stop offset="0" stopColor="currentColor" stopOpacity=".55" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g className="assistant-mark-tiles">
        <rect className="assistant-mark-tile is-a" x="2.5" y="2.5" width="7" height="7" rx="2" />
        <rect className="assistant-mark-tile is-b" x="14.5" y="2.5" width="7" height="7" rx="2" />
        <rect className="assistant-mark-tile is-c" x="14.5" y="14.5" width="7" height="7" rx="2" />
        <rect className="assistant-mark-tile is-d" x="2.5" y="14.5" width="7" height="7" rx="2" />
      </g>
      <circle className="assistant-mark-halo" cx="12" cy="12" r="5.6" fill={`url(#${glow})`} />
      <circle className="assistant-mark-core" cx="12" cy="12" r="2.5" />
      <circle className="assistant-mark-spark" cx="11.2" cy="11.2" r=".85" />
      <rect className="assistant-mark-scan" x="1.5" y="1" width="21" height="1.3" rx=".65" />
    </svg>
  );
}

export function Brand({ href = "/", suffix, tagline = false }: { href?: string; suffix?: string; /** 在名称下方显示品牌标语 */ tagline?: boolean }) {
  return (
    <a className={`brand${tagline ? " has-tagline" : ""}`} href={href} aria-label={`${BRAND} 首页`}>
      <LogoMark />
      {tagline ? <span className="brand-text"><span className="brand-name">{BRAND}</span><span className="brand-tagline">{TAGLINE}</span></span> : <span className="brand-name">{BRAND}</span>}
      {suffix && <span className="brand-suffix">{suffix}</span>}
    </a>
  );
}

/* ---------- 按钮 ---------- */

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const shortcutAria = (shortcut: string) => shortcut.replace(/Mod/g, IS_MAC ? "Meta" : "Control").replace(/⌘/g, "Meta+").replace(/⇧/g, "Shift+").replace(/⌫/g, "Backspace").replace(/↵/g, "Enter").replace(/\bDel\b/g, "Delete");
export function shortcutLabel(shortcut: string): string {
  if (shortcut.endsWith("++")) return `${shortcutLabel(shortcut.slice(0, -2))}${IS_MAC ? "" : " + "}+`;
  const labels: Record<string, string> = { Mod: IS_MAC ? "⌘" : "Ctrl", Meta: "⌘", Control: "Ctrl", Shift: IS_MAC ? "⇧" : "Shift", Alt: IS_MAC ? "⌥" : "Alt", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "↵", Escape: "Esc", Backspace: IS_MAC ? "⌫" : "Backspace", Space: "空格" };
  return shortcut.split("+").map(key => labels[key] ?? (/^[a-z]$/.test(key) ? key.toUpperCase() : key)).join(IS_MAC ? "" : " + ");
}

/** 下载沿用传入的授权与版本地址；在用户点击或按键触发时调用。 */
export function downloadFile(href: string) {
  const link = document.createElement("a");
  link.href = href; link.download = ""; link.hidden = true;
  document.body.append(link); link.click(); link.remove();
}

/** ghost-danger：安静的危险操作（如「取消密码」「清除全部」），不抢主按钮的位置。 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "ghost-danger";
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  loading?: boolean;
  block?: boolean;
  /** 只提供提示和无障碍标记，按键由所属区域处理。 */
  shortcut?: string;
};
export function Button({ variant = "secondary", size = "md", icon, loading, block, shortcut, className = "", children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={`btn btn-${variant} btn-${size}${block ? " btn-block" : ""} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined} aria-keyshortcuts={shortcut ? shortcutAria(shortcut) : undefined} title={shortcut ? `${typeof children === "string" ? children : "快捷键"}（${shortcutLabel(shortcut)}）` : undefined} {...rest}>
      {loading ? <span className="spinner" aria-hidden="true" /> : icon && <Icon name={icon} size={size === "sm" ? 15 : 17} />}
      {children && <span>{children}</span>}
    </button>
  );
}

/** 外观与 Button 一致的链接：下载、打开新页面等需要真实地址的操作用它，不要手写 btn 类名。 */
export function ButtonLink({ variant = "secondary", size = "md", icon, shortcut, className = "", children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "lg"; icon?: IconName; shortcut?: string }) {
  return (
    <a className={`btn btn-${variant} btn-${size} ${className}`} aria-keyshortcuts={shortcut ? shortcutAria(shortcut) : undefined} title={shortcut ? `${typeof children === "string" ? children : "快捷键"}（${shortcutLabel(shortcut)}）` : undefined} {...rest}>
      {icon && <Icon name={icon} size={size === "sm" ? 15 : 17} />}
      {children && <span>{children}</span>}
    </a>
  );
}

export function IconButton({ icon, label, onClick, variant = "ghost", size = "md", disabled, active, shortcut, spinning, className = "" }: { className?: string; icon: IconName; label: string; onClick?: () => void; variant?: "ghost" | "secondary"; size?: "sm" | "md"; disabled?: boolean; active?: boolean; shortcut?: string; spinning?: boolean }) {
  return (
    <button type="button" className={`icon-btn icon-btn-${variant} icon-btn-${size}${active ? " is-active" : ""}${spinning ? " is-spinning" : ""} ${className}`} aria-busy={spinning || undefined} onClick={onClick} aria-label={label} aria-keyshortcuts={shortcut ? shortcutAria(shortcut) : undefined} title={shortcut ? `${label}（${shortcutLabel(shortcut)}）` : label} disabled={disabled} aria-pressed={active}>
      <Icon name={icon} size={size === "sm" ? 16 : 18} />
    </button>
  );
}

/* ---------- 状态标签 ---------- */

export type Tone = "neutral" | "success" | "warning" | "danger" | "accent" | "public";
export function Badge({ tone = "neutral", icon, children, dot }: { tone?: Tone; icon?: IconName; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot && <i className="badge-dot" aria-hidden="true" />}
      {icon && <Icon name={icon} size={13} />}
      {children}
    </span>
  );
}

/* ---------- 表单 ---------- */

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string }) {
  const id = useId();
  const content = Children.toArray(children);
  const control = content.find(child => isValidElement(child) && typeof child.type === "string" && ["input", "select", "textarea"].includes(child.type));
  const input = isValidElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>(control) ? control : null;
  const inputId = htmlFor ?? input?.props.id ?? (input ? `${id}-input` : undefined);
  const descriptionId = `${id}-description`;
  return (
    <div className={`field${error ? " has-error" : ""}`}>
      <label className="field-label" htmlFor={inputId}>{label}</label>
      {content.map(child => child === input ? cloneElement(input, {
        id: inputId, "aria-invalid": error ? true : input.props["aria-invalid"],
        "aria-describedby": [input.props["aria-describedby"], (error || hint) && descriptionId].filter(Boolean).join(" ") || undefined,
      }) : child)}
      {error ? <p id={descriptionId} className="field-error" role="alert">{error}</p> : hint && <p id={descriptionId} className="field-hint">{hint}</p>}
    </div>
  );
}

export function PasswordField({ label, value, onChange, name, autoComplete = "current-password", hint, error, disabled, autoFocus }: {
  label: string; value: string; onChange: (value: string) => void; name?: string;
  autoComplete?: "current-password" | "new-password" | "off"; hint?: ReactNode; error?: string; disabled?: boolean; autoFocus?: boolean;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false), [capsLock, setCapsLock] = useState(false);
  return <div className="password-field">
    <Field label={label} htmlFor={id} error={error} hint={capsLock ? <span className="tone-warning">大写锁定已开启</span> : hint}>
      <input id={id} name={name} className="input" type={visible ? "text" : "password"} value={value}
        onChange={event => onChange(event.target.value)} autoComplete={autoComplete} autoFocus={autoFocus} disabled={disabled}
        autoCapitalize="none" spellCheck={false} onKeyDown={event => setCapsLock(event.getModifierState("CapsLock"))}
        onKeyUp={event => setCapsLock(event.getModifierState("CapsLock"))} onBlur={() => setCapsLock(false)} />
      <Button variant="ghost" size="sm" className="password-field-toggle" disabled={disabled} aria-pressed={visible}
        aria-controls={id} aria-label={`${visible ? "隐藏" : "显示"}${label}`} onClick={() => setVisible(value => !value)}>{visible ? "隐藏" : "显示"}</Button>
    </Field>
  </div>;
}

/** 开关。默认是带标题与说明的设置行；compact 用于表格行内，没有可见文字，标题作为 aria-label 与悬停提示。 */
export function Switch({ checked, onChange, label, description, disabled, compact = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: ReactNode; disabled?: boolean; compact?: boolean }) {
  if (compact) return (
    <label className={`toggle${disabled ? " is-disabled" : ""}`} title={label}>
      <input type="checkbox" role="switch" className="switch-input" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
    </label>
  );
  return (
    <label className={`switch-row${disabled ? " is-disabled" : ""}`}>
      <span className="switch-copy">
        <span className="switch-label">{label}</span>
        {description && <span className="switch-description">{description}</span>}
      </span>
      <input type="checkbox" role="switch" className="switch-input" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
    </label>
  );
}

export function Checkbox({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: (value: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = Boolean(indeterminate); }, [indeterminate]);
  return <input ref={ref} type="checkbox" className="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} aria-label={label} onClick={event => event.stopPropagation()} />;
}

export function SearchInput({ value, onChange, onSubmit, onClear, placeholder, label, shortcut }: { value: string; onChange: (value: string) => void; onSubmit?: () => void; onClear?: () => void; placeholder: string; label: string; shortcut?: string }) {
  return (
    <form className="search-input" role="search" noValidate onSubmit={event => { event.preventDefault(); onSubmit?.(); }}>
      <Icon name="search" size={16} />
      <input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={label} aria-keyshortcuts={shortcut ? shortcutAria(shortcut) : undefined} title={shortcut ? `${label}（${shortcutLabel(shortcut)}）` : undefined} enterKeyHint="search" />
      {value && <button type="button" className="search-clear" aria-label="清除搜索" onClick={() => { onChange(""); onClear?.(); }}><Icon name="x" size={14} /></button>}
    </form>
  );
}

/** 快速筛选标签：单选，一行放不下时横向滚动；键盘用左右方向键切换（与 Segmented 相同的单选语义）。 */
/** 胶囊单选组；传入 clearValue 时可以再次点击已选项取消（此时没有选中项，第一项保持可 Tab 到达）。 */
export function FilterChips<T extends string>({ value, options, onChange, label, clearValue }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string; clearValue?: T }) {
  const focusable = options.some(option => option.value === value) ? value : options[0]?.value;
  return (
    <div className="filter-chips" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} tabIndex={focusable === option.value ? 0 : -1}
          className={`filter-chip${value === option.value ? " is-active" : ""}`}
          onClick={() => onChange(clearValue !== undefined && value === option.value ? clearValue : option.value)}
          onKeyDown={event => {
            const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!offset) return;
            event.preventDefault();
            const next = (index + offset + options.length) % options.length;
            onChange(options[next].value);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
          }}>{option.label}</button>
      ))}
    </div>
  );
}


/**
 * 页面级标签页（设置页、控制台的分区）：下划线样式，窄屏横向滚动。只负责切换，内容由调用方按 value 渲染；
 * 方向键、Home／End 在标签间移动并立即切换（与 Segmented 相同）。同一组里的少量选项筛选请用 Segmented。
 */
export function Tabs<T extends string>({ value, options, onChange, label, className = "" }: { value: T; options: { value: T; label: string; icon?: IconName; count?: number }[]; onChange: (value: T) => void; label: string; className?: string }) {
  return (
    <div className={`tabs ${className}`} role="tablist" aria-label={label}>
      {options.map((option, index) => (
        <button key={option.value} type="button" role="tab" aria-selected={value === option.value} tabIndex={value === option.value ? 0 : -1}
          className={`tab${value === option.value ? " is-active" : ""}`} onClick={() => onChange(option.value)}
          onKeyDown={event => {
            const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!offset && event.key !== "Home" && event.key !== "End") return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + offset + options.length) % options.length;
            onChange(options[next].value);
            const target = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next];
            target?.focus(); target?.scrollIntoView({ block: "nearest", inline: "nearest" });
          }}>
          {option.icon && <Icon name={option.icon} size={15} />}
          <span>{option.label}</span>
          {option.count !== undefined && option.count > 0 && <span className="tab-count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, disabled, shortcut, showLabels = false }: { value: T; options: { value: T; label: string; icon?: IconName; count?: number }[]; onChange: (value: T) => void; label: string; disabled?: boolean; shortcut?: string; /** 有图标时同时显示文字（默认只显示图标） */ showLabels?: boolean }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label} aria-keyshortcuts={shortcut ? shortcutAria(shortcut) : undefined} title={shortcut ? `${label}（${shortcutLabel(shortcut)}）` : undefined}>
      {options.map((option, index) => (
        <button key={option.value} type="button" role="radio" disabled={disabled} aria-checked={value === option.value} tabIndex={value === option.value || (!options.some(item => item.value === value) && index === 0) ? 0 : -1} className={value === option.value ? "is-active" : ""} onClick={() => onChange(option.value)} title={shortcut ? `${option.label}（${shortcutLabel(shortcut)} 切换）` : option.icon && !showLabels ? option.label : undefined}
          onKeyDown={event => {
            const offset = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
            if (!offset && event.key !== "Home" && event.key !== "End") return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + offset + options.length) % options.length;
            onChange(options[next].value);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
          }}>
          {option.icon && <Icon name={option.icon} size={15} />}
          {(!option.icon || showLabels || option.count !== undefined) && <span className={option.icon && !showLabels ? "sr-only" : ""}>{option.label}</span>}
          {option.count !== undefined && <span className="segmented-count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------- 浮层 ---------- */

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
const modalStack: HTMLElement[] = [];
const focusable = (node: HTMLElement) => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(item => item.tabIndex >= 0 && item.getClientRects().length > 0);
const WINDOW_POINTER = "(min-width: 861px) and (hover: hover) and (pointer: fine)";
const RESIZE_CURSORS = { n: "ns-resize", e: "ew-resize", s: "ns-resize", w: "ew-resize", ne: "nesw-resize", se: "nwse-resize", sw: "nesw-resize", nw: "nwse-resize" } as const;
type ResizeDirection = keyof typeof RESIZE_CURSORS;

/* 焦点框只在键盘导航时显示：Tab、方向键等切到键盘模式，指针按下切回指针模式。
 * Esc、Enter 不改变模式，所以鼠标打开的弹窗按 Esc 关闭后，焦点归还到原按钮时也不会出现焦点框。 */
const NAVIGATION_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
if (typeof document !== "undefined") {
  const root = document.documentElement;
  document.addEventListener("pointerdown", () => { root.dataset.input = "pointer"; }, true);
  document.addEventListener("keydown", event => { if (NAVIGATION_KEYS.has(event.key)) root.dataset.input = "keyboard"; }, true);
}

/** 输入、选择、进度条与菜单优先使用各自的键盘操作。 */
export function isShortcutControl(target: Element): boolean {
  return Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='slider'], [role='spinbutton'], [role='combobox'], [role^='menu'], .menu, .art-settings"));
}

/** 窗口四周 8px（含圆角被裁掉的角落）也是缩放区：返回方向，离窗口更远时返回 null。 */
function resizeEdge(rect: DOMRect, x: number, y: number, band = 8): ResizeDirection | null {
  if (x < rect.left - band || x > rect.right + band || y < rect.top - band || y > rect.bottom + band) return null;
  const vertical = y <= rect.top + 16 ? "n" : y >= rect.bottom - 16 ? "s" : "";
  const horizontal = x <= rect.left + 16 ? "w" : x >= rect.right - 16 ? "e" : "";
  return (vertical + horizontal || null) as ResizeDirection | null;
}

/** 把记住的窗口尺寸换算到新的宽高比：保持面积，再整体缩小到视口之内。 */
function fitAspect(size: { width: number; height: number }, ratio: number) {
  const width = Math.sqrt(size.width * size.height * ratio), height = width / ratio;
  const scale = Math.min(1, (window.innerWidth - 16) / width, (window.innerHeight - 16) / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function Modal({ title, description, onClose, children, footer, actions, menuItems = [], compactActions = false, size: modalSize = "md", icon, leading, tone, dismissible = true, closable = true, className = "", style, initialFocus = "auto", onKeyDownCapture, expandable = false, pinnable = false, minimizable = false, minimizedContent, windowKey, windowShortcuts = false, movable = false, resizable, aspectRatio }: { title: string; description?: ReactNode; onClose: () => void; children?: ReactNode; footer?: ReactNode; actions?: ReactNode; menuItems?: MenuItem[]; /** 窄预览窗口将窗口操作合并到更多菜单。 */ compactActions?: boolean; size?: "sm" | "md" | "lg" | "xl"; icon?: IconName; leading?: ReactNode; tone?: Tone; dismissible?: boolean; /** false 时不显示右上角关闭按钮（必须完成的对话框） */ closable?: boolean; className?: string; style?: CSSProperties; initialFocus?: "auto" | "dialog"; onKeyDownCapture?: KeyboardEventHandler<HTMLDivElement>; expandable?: boolean; pinnable?: boolean; minimizable?: boolean; minimizedContent?: ReactNode; windowKey?: string; windowShortcuts?: boolean; /** 拖动头部移动窗口（正常与最小化分别记住位置，最大化与全屏时不生效） */ movable?: boolean;
  /** 桌面上拖动四边或四角调整窗口大小；值是记住尺寸用的名称（同名窗口共用），双击边角还原默认大小。手机、最大化、全屏与最小化时不生效。 */ resizable?: string;
  /** 调整大小时保持的宽高比（视频窗口），按住 Shift 自由调整；记住的尺寸按面积换算到当前比例，同名窗口的横竖内容不会互相留下黑边。 */ aspectRatio?: number }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false), [fullscreen, setFullscreen] = useState(false), [switchingScreen, setSwitchingScreen] = useState(false);
  const [pinned, setPinned] = useState(false), [minimized, setMinimized] = useState(false);
  const supportsFullscreen = Boolean(document.fullscreenEnabled && document.documentElement.requestFullscreen);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const closeRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  const pinnedRef = useRef(pinned);
  closeRef.current = onClose;
  dismissibleRef.current = dismissible;
  pinnedRef.current = pinned;
  const [offsets, setOffsets] = useState<Record<"normal" | "mini", { x: number; y: number }>>({ normal: { x: 0, y: 0 }, mini: { x: 0, y: 0 } });
  const [moving, setMoving] = useState(false);
  const expanded = !minimized && (maximized || fullscreen);
  const sizeKey = resizable ? `tessera:window-size:${resizable}` : "";
  const [size, setSize] = useState<{ width: number; height: number } | null>(() => {
    try { const value = sizeKey ? JSON.parse(localStorage.getItem(sizeKey) ?? "null") : null; return value && value.width > 0 && value.height > 0 ? value : null; } catch { return null; }
  });
  const [windowPointer, setWindowPointer] = useState(() => window.matchMedia(WINDOW_POINTER).matches);
  const [resizing, setResizing] = useState<ResizeDirection | null>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => {
    const media = window.matchMedia(WINDOW_POINTER);
    const sync = () => { resizeCleanup.current?.(); setResizing(null); setWindowPointer(media.matches); };
    media.addEventListener("change", sync);
    return () => { media.removeEventListener("change", sync); resizeCleanup.current?.(); };
  }, []);
  const sized = Boolean(resizable && windowPointer && size && !expanded && !minimized);
  const shown = sized && size ? aspectRatio ? fitAspect(size, aspectRatio) : size : null;
  const positionable = movable && !expanded && (minimized || windowPointer);
  function startResize(event: ReactPointerEvent<HTMLElement>, direction: ResizeDirection) {
    const node = ref.current;
    if (!resizable || !windowPointer || !node || expanded || minimized || event.pointerType === "touch" || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation();
    resizeCleanup.current?.();
    const rect = node.getBoundingClientRect(), startX = event.clientX, startY = event.clientY, base = offsets.normal;
    const outer = backdrop.current && getComputedStyle(backdrop.current);
    const west = direction.includes("w"), east = direction.includes("e"), north = direction.includes("n"), south = direction.includes("s");
    const maxWidth = Math.min(west ? rect.right - 8 : window.innerWidth - 8 - rect.left, window.innerWidth - (outer ? parseFloat(outer.paddingLeft) + parseFloat(outer.paddingRight) : 0));
    const maxHeight = Math.min(north ? rect.bottom - 8 : window.innerHeight - 8 - rect.top, window.innerHeight - (outer ? parseFloat(outer.paddingTop) + parseFloat(outer.paddingBottom) : 0));
    // 自动适配的竖屏或矮窗口可能小于常规最小尺寸，开始拖动时不强制放大。
    const minWidth = Math.min(420, rect.width, maxWidth), minHeight = Math.min(300, rect.height, maxHeight);
    const handle = event.currentTarget, pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    let latest = { width: rect.width, height: rect.height }, changed = false;
    setResizing(direction);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const dx = next.clientX - startX, dy = next.clientY - startY;
      if (!dx && !dy) return;
      let width = west || east ? Math.round(Math.max(minWidth, Math.min(maxWidth, rect.width + (west ? -dx : dx)))) : rect.width;
      let height = north || south ? Math.round(Math.max(minHeight, Math.min(maxHeight, rect.height + (north ? -dy : dy)))) : rect.height;
      if (aspectRatio && !next.shiftKey) {
        // 保持比例：角上按变化更大的方向驱动，边上由被拖动的那一维驱动，另一维随之计算并一起受上下限约束。
        const byWidth = (west || east) && (!(north || south) || Math.abs(width - rect.width) / rect.width >= Math.abs(height - rect.height) / rect.height);
        const low = Math.max(minWidth, minHeight * aspectRatio), high = Math.min(maxWidth, maxHeight * aspectRatio);
        width = Math.round(Math.max(Math.min(low, high), Math.min(high, byWidth ? width : height * aspectRatio)));
        height = Math.round(width / aspectRatio);
      }
      latest = { width, height };
      changed = true;
      setSize(latest);
      // 弹窗由网格居中：补偿尺寸变化引起的位移，让拖动边的对侧保持不动。
      setOffsets(current => ({ ...current, normal: {
        x: base.x + (west ? -1 : east ? 1 : 0) * (width - rect.width) / 2,
        y: base.y + (north ? -1 : south ? 1 : 0) * (height - rect.height) / 2,
      } }));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end);
      window.removeEventListener("resize", end);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      resizeCleanup.current = null;
    };
    const end = (next: Event) => {
      if (next instanceof PointerEvent && next.pointerId !== pointerId) return;
      cleanup(); setResizing(null);
      if (changed) try { localStorage.setItem(sizeKey, JSON.stringify(latest)); } catch { /* 隐私模式不保存 */ }
    };
    resizeCleanup.current = cleanup;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
    window.addEventListener("resize", end);
  }
  function resetSize() {
    setSize(null); setOffsets(current => ({ ...current, normal: { x: 0, y: 0 } }));
    try { localStorage.removeItem(sizeKey); } catch { /* 忽略 */ }
  }
  const offset = offsets[minimized ? "mini" : "normal"];
  const resizeEnabled = Boolean(resizable && windowPointer && !expanded && !minimized);
  /** 窗口有圆角且裁剪溢出，角上的缩放区有一部分落在遮罩上：按下遮罩时先判断是否在窗口边缘，在则开始缩放，不能当作点击外部关闭窗口。 */
  const edgeOf = (event: { clientX: number; clientY: number; target: EventTarget; currentTarget: EventTarget }) =>
    resizeEnabled && event.target === event.currentTarget && ref.current ? resizeEdge(ref.current.getBoundingClientRect(), event.clientX, event.clientY) : null;
  useEffect(() => { setMinimized(false); setOffsets({ normal: { x: 0, y: 0 }, mini: { x: 0, y: 0 } }); }, [windowKey]);
  /** 把位移限制在视口内（四周留 8px），头部的窗口按钮始终可见；窗口比视口大时只保证左上角不出界。 */
  const clampOffset = (rect: DOMRect, base: { x: number; y: number }, dx: number, dy: number) => {
    const edge = 8, limit = (start: number, end: number, size: number, delta: number) =>
      Math.max(edge - start, Math.min(Math.max(edge - start, size - edge - end), delta));
    return { x: base.x + limit(rect.left, rect.right, window.innerWidth, dx), y: base.y + limit(rect.top, rect.bottom, window.innerHeight, dy) };
  };
  function startMove(event: ReactPointerEvent<HTMLElement>) {
    const node = ref.current;
    if (!movable || !node || expanded || event.button !== 0 || !event.isPrimary) return;
    if ((event.target as Element).closest("button, a, input, select, textarea, [role='button'], .menu")) return;
    // 窄屏的预览几乎占满屏幕，只允许拖动最小化的小窗。
    if (!minimized && !windowPointer) return;
    event.preventDefault();
    const mode = minimized ? "mini" : "normal", base = offsets[mode], rect = node.getBoundingClientRect();
    const startX = event.clientX, startY = event.clientY;
    setMoving(true);
    const move = (next: PointerEvent) => setOffsets(current => ({ ...current, [mode]: clampOffset(rect, base, next.clientX - startX, next.clientY - startY) }));
    const end = () => {
      setMoving(false);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
  }
  useEffect(() => {
    if (!movable || (!offset.x && !offset.y)) return;
    // 窗口缩小后把已移动的窗口拉回可见区域。
    const fit = () => {
      const node = ref.current;
      if (!node) return;
      const mode = minimized ? "mini" : "normal";
      setOffsets(current => {
        const next = clampOffset(node.getBoundingClientRect(), current[mode], 0, 0);
        return next.x === current[mode].x && next.y === current[mode].y ? current : { ...current, [mode]: next };
      });
    };
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [movable, minimized, offset.x, offset.y]);
  useEffect(() => {
    if (!expandable) return;
    const node = backdrop.current;
    const sync = () => setFullscreen(document.fullscreenElement === node);
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      if (node && document.fullscreenElement && node.contains(document.fullscreenElement)) void document.exitFullscreen().catch(() => {});
    };
  }, [expandable]);
  async function toggleFullscreen() {
    if (!backdrop.current || switchingScreen) return;
    setSwitchingScreen(true);
    try {
      if (document.fullscreenElement && backdrop.current.contains(document.fullscreenElement)) await document.exitFullscreen();
      else await backdrop.current.requestFullscreen();
    } catch { toast.error("无法进入全屏，可以使用最大化预览。"); }
    finally { setSwitchingScreen(false); }
  }
  async function minimize() {
    if (switchingScreen) return;
    setSwitchingScreen(true);
    try {
      if (document.fullscreenElement && backdrop.current?.contains(document.fullscreenElement)) await document.exitFullscreen();
      setMinimized(true);
    } catch { toast.error("请先退出全屏，再最小化预览。"); }
    finally { setSwitchingScreen(false); }
  }
  async function toggleMaximize() {
    if (switchingScreen) return;
    setSwitchingScreen(true);
    try {
      if (document.fullscreenElement && backdrop.current?.contains(document.fullscreenElement)) await document.exitFullscreen();
      setMaximized(value => !value);
    } catch { toast.error("请先退出全屏，再调整预览窗口。"); }
    finally { setSwitchingScreen(false); }
  }
  const handleWindowKey: KeyboardEventHandler<HTMLDivElement> = event => {
    onKeyDownCapture?.(event);
    if (!windowShortcuts || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement, key = event.key.toLowerCase();
    if (!event.currentTarget.contains(target) || event.currentTarget.closest("[inert]") || isShortcutControl(target)) return;
    if (event.shiftKey && key !== "f") return;
    if ((key !== "i" || !minimizable) && (key !== "f" || !expandable) && (key !== "p" || !pinnable)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.repeat || switchingScreen) return;
    event.currentTarget.classList.remove("is-chrome-idle");
    if (key === "p") setPinned(value => !value);
    else if (key === "i") { if (minimized) setMinimized(false); else void minimize(); }
    else {
      setMinimized(false);
      if (event.shiftKey || !supportsFullscreen) void toggleMaximize(); else void toggleFullscreen();
    }
  };
  const focusWindowHeader = (event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target as Element;
    if (windowShortcuts && !isShortcutControl(target) && !target.closest("button, a, summary, [role='button']")) ref.current?.focus({ preventScroll: true });
    if (movable) startMove(event);
  };
  useEffect(() => {
    if (!windowShortcuts || !minimizable || !minimized) return;
    // 小窗口释放页面焦点后，仍可恢复；其他弹窗与输入控件不受影响。
    const restore = (event: KeyboardEvent) => {
      if (modalStack.length || event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.key.toLowerCase() !== "i") return;
      if (!(event.target instanceof Element) || isShortcutControl(event.target) || event.target.closest(".assistant-drawer, .assistant-page, .sidebar") || document.querySelector(".menu")) return;
      event.preventDefault(); event.stopPropagation(); setMinimized(false);
    };
    document.addEventListener("keydown", restore);
    return () => document.removeEventListener("keydown", restore);
  }, [windowShortcuts, minimizable, minimized]);
  useEffect(() => {
    if (minimized) return;
    const previous = previousFocus.current;
    const node = ref.current;
    if (!node) return;
    modalStack.at(-1)?.setAttribute("inert", "");
    modalStack.push(node);
    // 表单沿用输入控件优先；预览聚焦对话框，避免播放控件打开时就被选中。
    const preferred = initialFocus === "auto" ? focusable(node).find(item => item.matches("[autofocus], .modal-body input, .modal-body select, .modal-body textarea")) : undefined;
    (preferred ?? node).focus();
    document.body.classList.add("has-modal");
    const handleKey = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== node || event.defaultPrevented || event.isComposing) return;
      if ((event.target as HTMLElement).closest?.(".menu")) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (event.repeat || pinnedRef.current) return;
        // 全屏中的 Esc 只还原视图，避免同时关掉正在播放的预览。
        if (document.fullscreenElement && backdrop.current?.contains(document.fullscreenElement)) void document.exitFullscreen().catch(() => {});
        else if (dismissibleRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable(node);
      if (!items.length) { event.preventDefault(); node.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === node || document.activeElement === first || !node.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === node || document.activeElement === last || !node.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      const wasTop = modalStack.at(-1) === node;
      modalStack.splice(modalStack.indexOf(node), 1);
      if (!modalStack.length) document.body.classList.remove("has-modal");
      else modalStack.at(-1)?.removeAttribute("inert");
      if (wasTop && previous?.isConnected) previous.focus();
    };
  }, [minimized, initialFocus]);
  return createPortal(
    <div ref={backdrop} className={`modal-backdrop${!minimized && (maximized || fullscreen) ? " is-expanded" : ""}${fullscreen ? " is-fullscreen" : ""}${minimized ? " is-minimized" : ""}`} role="presentation"
      onPointerDown={event => { const edge = edgeOf(event); if (edge) startResize(event, edge); }}
      onPointerMove={event => { if (!resizing) event.currentTarget.style.cursor = (() => { const edge = edgeOf(event); return edge ? RESIZE_CURSORS[edge] : ""; })(); }}
      onMouseDown={event => { if (event.target === event.currentTarget && !edgeOf(event) && dismissible && !pinned && !minimized && modalStack.at(-1) === ref.current) onClose(); }}>
      <div ref={ref} className={`modal modal-${modalSize} ${className}${expanded ? " is-expanded" : ""}${minimized ? " is-minimized" : ""}${positionable ? " is-movable" : ""}${moving ? " is-moving" : ""}${sized ? " is-sized" : ""}${resizing ? " is-resizing" : ""}`}
        style={{ ...style, ...(positionable && (offset.x || offset.y) ? { translate: `${offset.x}px ${offset.y}px` } : {}), ...(resizing ? { "--modal-resize-cursor": RESIZE_CURSORS[resizing] } : {}),
          ...(shown ? { "--modal-width": `${shown.width}px`, "--modal-height": `${shown.height}px` } : {}) } as CSSProperties} role={minimized ? "region" : "dialog"} aria-modal={minimized ? undefined : true} aria-labelledby={`${id}-title`} tabIndex={-1} onKeyDownCapture={handleWindowKey}>
        <header className="modal-header" onPointerDown={focusWindowHeader}>
          {leading ?? (icon && <span className={`modal-icon tone-${tone ?? "accent"}`}><Icon name={icon} size={20} /></span>)}
          <div className="modal-heading">
            <h2 id={`${id}-title`} title={title}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <div className="modal-window-actions">
            {!minimized && actions}
            {/* 宽窗口保留全屏和关闭；窄窗口将其余操作合并到更多菜单。固定状态在按钮或菜单中提示。 */}
            {pinned && !minimized && !compactActions && <IconButton icon="pin" label="取消固定预览" shortcut={windowShortcuts ? "P" : undefined} size="sm" active onClick={() => setPinned(false)} />}
            {minimized && <IconButton icon="restore" label="恢复预览" shortcut={windowShortcuts ? "i" : undefined} size="sm" disabled={switchingScreen} onClick={() => setMinimized(false)} />}
            {expandable && !minimized && !compactActions && !supportsFullscreen && <IconButton icon={maximized ? "restore" : "maximize"} label={maximized ? "还原预览" : "最大化预览"} shortcut={windowShortcuts ? "F" : undefined} onClick={() => void toggleMaximize()} size="sm" active={maximized} disabled={switchingScreen} />}
            {expandable && !minimized && !compactActions && supportsFullscreen && <IconButton icon={fullscreen ? "exitFullscreen" : "fullscreen"} label={fullscreen ? "退出全屏" : "全屏预览"} shortcut={windowShortcuts ? "f" : undefined} onClick={() => void toggleFullscreen()} size="sm" active={fullscreen} disabled={switchingScreen} />}
            {!minimized && (() => {
              const items: MenuItem[] = [...menuItems];
              if (compactActions && expandable) items.push(supportsFullscreen
                ? { label: fullscreen ? "退出全屏" : "全屏预览", icon: fullscreen ? "exitFullscreen" : "fullscreen", divider: items.length > 0, shortcut: windowShortcuts ? "F" : undefined, disabled: switchingScreen, onSelect: () => void toggleFullscreen() }
                : { label: maximized ? "还原大小" : "最大化", icon: maximized ? "restore" : "maximize", divider: items.length > 0, shortcut: windowShortcuts ? "F" : undefined, disabled: switchingScreen, onSelect: () => void toggleMaximize() });
              if (minimizable) items.push({ label: "最小化", icon: "minimize", shortcut: windowShortcuts ? "I" : undefined, onSelect: () => void minimize() });
              if (expandable && supportsFullscreen && !fullscreen) items.push({ label: maximized ? "还原大小" : "最大化", icon: maximized ? "restore" : "maximize", shortcut: windowShortcuts ? "Shift+F" : undefined, disabled: switchingScreen, onSelect: () => void toggleMaximize() });
              if (pinnable && (!pinned || compactActions)) items.push({ label: pinned ? "取消固定预览" : "固定", icon: "pin", shortcut: windowShortcuts ? "P" : undefined, checked: compactActions ? pinned : undefined, onSelect: () => setPinned(value => !value) });
              return items.length > 0 && <Menu label={compactActions ? "更多操作" : "窗口选项"} className={compactActions && pinned ? "is-active" : ""} items={items} />;
            })()}
            {closable && <IconButton icon="x" label="关闭" shortcut={dismissible && !pinned && !minimized ? "Escape" : undefined} onClick={onClose} size="sm" disabled={!dismissible} />}
          </div>
        </header>
        {children && <div className="modal-body">{children}</div>}
        {footer && <footer className="modal-footer">{footer}</footer>}
        {minimized && minimizedContent && <div className="modal-minimized-controls">{minimizedContent}</div>}
        {resizable && windowPointer && !expanded && !minimized && (Object.keys(RESIZE_CURSORS) as ResizeDirection[]).map(direction => <span key={direction} className={`modal-resize modal-resize-${direction}`} aria-hidden="true" title="拖动调整窗口大小，双击还原" onPointerDown={event => startResize(event, direction)} onDoubleClick={resetSize} />)}
      </div>
    </div>, document.body,
  );
}

export function ConfirmDialog({ title, description, confirmLabel, onConfirm, onClose, danger = true, className, children }: { title: string; description: ReactNode; confirmLabel: string; onConfirm: () => Promise<void> | void; onClose: () => void; danger?: boolean; className?: string; children?: ReactNode }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  }
  return (
    <Modal className={className} title={title} description={description} onClose={onClose} dismissible={!busy} size="sm" icon={danger ? "alert" : "info"} tone={danger ? "danger" : "accent"}
      footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant={danger ? "danger" : "primary"} loading={busy}
        type={children ? "submit" : "button"} form={children ? id : undefined} onClick={children ? undefined : () => void confirm()}>{confirmLabel}</Button></>}>
      {children && <form id={id} className="form" noValidate onSubmit={event => { event.preventDefault(); if (!busy) void confirm(); }}>{children}</form>}
    </Modal>
  );
}

export type MenuItem = { label: string; description?: string; icon: IconName; onSelect: () => void; danger?: boolean; href?: string; divider?: boolean; heading?: string; checked?: boolean; shortcut?: string; disabled?: boolean };

/** 浮层挂载点：全屏时只有全屏元素内的内容可见，所以菜单挂到全屏元素里，否则挂到 body。 */
const overlayRoot = () => (document.fullscreenElement as HTMLElement | null) ?? document.body;

/** 菜单列表：按锚点（按钮矩形或指针位置）定位，处理方向键、Esc、Tab、点外部与滚动关闭。 */
function MenuList({ items, label, anchor, onClose, restoreFocus, dark }: { items: MenuItem[]; label: string; anchor: () => { x: number; y: number; bottom?: number; alignRight?: boolean; above?: boolean }; onClose: () => void; restoreFocus?: () => void; dark?: boolean }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    if (!list.current) return;
    const point = anchor();
    const height = list.current.offsetHeight, width = list.current.offsetWidth;
    // 默认向下展开，放不下才向上；贴着底部控制条的菜单（above）优先向上，放不下才向下。
    const below = point.above && point.y - 6 - height >= 8 ? false : (point.bottom ?? point.y) + 6 + height < window.innerHeight;
    const top = below ? (point.bottom ?? point.y) + (point.bottom === undefined ? 2 : 6) : point.y - height - (point.bottom === undefined ? 2 : 6);
    const left = point.alignRight ? point.x - width : point.x;
    setPosition({ top: Math.max(8, top), left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) });
  }, []);
  useLayoutEffect(() => {
    if (position) list.current?.querySelector<HTMLElement>("[role^=menuitem]")?.focus({ preventScroll: true });
  }, [position]);
  useEffect(() => {
    const close = () => closeRef.current();
    const scrolled = (event: Event) => { if (!list.current?.contains(event.target as Node)) close(); };
    const outside = (event: Event) => { if (!list.current?.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); restoreFocus?.(); }
      if (event.key === "Tab") { event.preventDefault(); close(); restoreFocus?.(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const entries = Array.from(list.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? []);
        const index = entries.indexOf(document.activeElement as HTMLElement);
        entries[(index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length]?.focus();
      }
    };
    // 推迟到下一帧再监听，避免打开菜单的那次点击（或右键）立即把它关掉。
    // 用捕获阶段的 pointerdown：拖动窗口头部会 preventDefault，浏览器不再派发 mousedown，菜单就会留在原处。
    const timer = window.setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("contextmenu", outside);
    });
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("scroll", scrolled, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("contextmenu", outside);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("scroll", scrolled, true);
    };
  }, []);
  return createPortal(
    <div ref={list} className={`menu${items.some(item => item.description !== undefined) ? " has-descriptions" : ""}${dark ? " is-dark" : ""}`} role="menu" aria-label={label} style={position ? { top: position.top, left: position.left } : { visibility: "hidden", top: 0, left: 0 }}
      onClick={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
      {items.map(item => {
        const content = <><Icon name={item.icon} size={16} /><span className="menu-copy"><span>{item.label}</span>{item.description !== undefined && <small title={item.description}>{item.description}</small>}</span>{item.checked ? <span className="menu-check"><Icon name="check" size={15} /></span> : item.shortcut && <kbd className="menu-shortcut">{shortcutLabel(item.shortcut)}</kbd>}</>;
        // 带标题的分组：标题承担分隔线，选项用 menuitemradio 表示单选状态。
        const className = `menu-item${item.description !== undefined ? " has-description" : ""}${item.danger ? " is-danger" : ""}${item.divider && !item.heading ? " has-divider" : ""}`;
        const role = item.checked === undefined ? "menuitem" : "menuitemradio";
        const element = item.href
          ? <a key={item.label} role={role} className={className} aria-keyshortcuts={item.shortcut ? shortcutAria(item.shortcut) : undefined} href={item.href} onClick={() => onClose()}>{content}</a>
          : <button key={item.label} type="button" role={role} aria-keyshortcuts={item.shortcut ? shortcutAria(item.shortcut) : undefined} aria-checked={item.checked === undefined ? undefined : item.checked} className={className} disabled={item.disabled} onClick={() => { onClose(); item.onSelect(); }}>{content}</button>;
        return item.heading ? <Fragment key={item.label}><div className={`menu-heading${item.divider ? " has-divider" : ""}`} role="presentation">{item.heading}</div>{element}</Fragment> : element;
      })}
    </div>,
    overlayRoot(),
  );
}

export function Menu({ items, label, icon = "more", size = "sm", children, className = "", shortcut, align = "end", above = false }: { shortcut?: string; align?: "start" | "end"; above?: boolean; items: MenuItem[]; label: string; icon?: IconName; size?: "sm" | "md"; children?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} type="button" className={`icon-btn icon-btn-ghost icon-btn-${size}${open ? " is-active" : ""} ${className}`} aria-label={label} aria-keyshortcuts={shortcut ? shortcutAria(shortcut) : undefined} title={shortcut ? `${label}（${shortcutLabel(shortcut)}）` : label} aria-haspopup="menu" aria-expanded={open}
        onMouseDown={event => { if (open) event.stopPropagation(); }}
        onClick={event => { event.stopPropagation(); setOpen(value => !value); }}>
        {children ?? <Icon name={icon} size={16} />}
      </button>
      {/* 深色画布（预览窗口）里打开的菜单跟随深色配色，不在暗色画面上弹出白色面板。 */}
      {open && <MenuList items={items} label={label} dark={Boolean(trigger.current?.closest(".is-dark-surface"))} onClose={() => setOpen(false)} restoreFocus={() => trigger.current?.focus()}
        anchor={() => { const rect = trigger.current!.getBoundingClientRect(); return { x: align === "start" ? rect.left : rect.right, y: rect.top, bottom: rect.bottom, alignRight: align === "end", above }; }} />}
    </>
  );
}

/** 右键菜单：在指针位置打开，内容与行尾“更多操作”菜单相同。 */
export function ContextMenu({ items, label, x, y, onClose }: { items: MenuItem[]; label: string; x: number; y: number; onClose: () => void }) {
  return <MenuList items={items} label={label} onClose={onClose} anchor={() => ({ x, y })} />;
}

/* ---------- 全局提示 ---------- */

type ToastAction = { label: string; onClick: () => void };
type Toast = { id: number; tone: "success" | "error" | "info"; message: string; action?: ToastAction };
let toasts: Toast[] = [];
const listeners = new Set<(items: Toast[]) => void>();
let toastId = 0;
function pushToast(tone: Toast["tone"], message: string, action?: ToastAction) {
  const id = ++toastId;
  toasts = [...toasts.slice(-3), { id, tone, message, action }];
  listeners.forEach(listener => listener(toasts));
  // 带操作（如撤销）的提示停留更久，给用户反应时间。
  if (tone !== "error") window.setTimeout(() => dismissToast(id), action ? 8000 : 3800);
  return id;
}
function dismissToast(id: number) {
  toasts = toasts.filter(item => item.id !== id);
  listeners.forEach(listener => listener(toasts));
}
export const toast = {
  dismiss: dismissToast,
  success: (message: string, action?: ToastAction) => pushToast("success", message, action),
  error: (message: string) => pushToast("error", message),
  info: (message: string) => pushToast("info", message),
};

export function Toaster() {
  const [items, setItems] = useState<Toast[]>(toasts);
  useEffect(() => { listeners.add(setItems); return () => { listeners.delete(setItems); }; }, []);
  return (
    <div className="toaster" aria-live="polite" aria-atomic="false">
      {items.map(item => (
        <div key={item.id} className={`toast toast-${item.tone}`} role={item.tone === "error" ? "alert" : "status"}>
          <Icon name={item.tone === "success" ? "checkCircle" : item.tone === "error" ? "alert" : "info"} size={18} />
          <span>{item.message}</span>
          {item.action && <button type="button" className="toast-action" onClick={() => { dismissToast(item.id); item.action!.onClick(); }}>{item.action.label}</button>}
          <button type="button" aria-label="关闭提示" onClick={() => dismissToast(item.id)}><Icon name="x" size={14} /></button>
        </div>
      ))}
    </div>
  );
}

/* ---------- 布局与状态 ---------- */

export function PageHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        {children}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

export function Panel({ title, description, actions, children, flush, className = "" }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className={`panel-header${description ? " has-description" : ""}`}>
          <div className="panel-header-main">
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? "panel-body is-flush" : "panel-body"}>{children}</div>
    </section>
  );
}

export type GuideStep = { title: ReactNode; body?: ReactNode };
/**
 * 配置页的「配置指南」：带编号的步骤卡片，可折叠。用户手动展开／收起后记在 localStorage（tessera-guide-<id>），
 * 没有记录时按 defaultOpen 决定，通常传「尚未配置」，让第一次进来的管理员直接看到步骤。
 */
export function SetupGuide({ id, title = "配置指南", description, steps, docHref, defaultOpen = false }: { id: string; title?: string; description?: ReactNode; steps: GuideStep[]; docHref?: string; defaultOpen?: boolean }) {
  const key = `tessera-guide-${id}`;
  const [stored, setStored] = useState<boolean | null>(() => { try { const value = localStorage.getItem(key); return value === null ? null : value === "open"; } catch { return null; } });
  const open = stored ?? defaultOpen;
  const toggle = () => { const next = !open; setStored(next); try { localStorage.setItem(key, next ? "open" : "closed"); } catch { /* 存储不可用时只在本次生效。 */ } };
  const body = useId();
  return (
    <section className={`setup-guide${open ? " is-open" : ""}`}>
      <button type="button" className="setup-guide-toggle" aria-expanded={open} aria-controls={body} onClick={toggle}>
        <span className="setup-guide-icon"><Icon name="book" size={16} /></span>
        <span className="setup-guide-heading"><strong>{title}</strong>{description && <small>{description}</small>}</span>
        <span className="setup-guide-count">{steps.length} 步</span>
        <Icon name="chevronDown" size={16} className="setup-guide-chevron" />
      </button>
      {open && <div id={body} className="setup-guide-body">
        <ol className="setup-guide-steps">{steps.map((step, index) => <li key={index}>
          <span className="setup-guide-number" aria-hidden="true">{index + 1}</span>
          <div><strong>{step.title}</strong>{step.body && <div className="setup-guide-text">{step.body}</div>}</div>
        </li>)}</ol>
        {docHref && <a className="setup-guide-doc link" href={docHref} target="_blank" rel="noreferrer">查看完整文档<Icon name="external" size={13} /></a>}
      </div>}
    </section>
  );
}

/** 折叠区：设置页的「高级参数」、检测信息等不常用的内容。默认收起，标题行说明里面有什么。 */
export function Disclosure({ title, description, defaultOpen = false, children }: { title: string; description?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={`disclosure${open ? " is-open" : ""}`}>
      <button type="button" className="disclosure-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        <Icon name="chevronRight" size={14} />
        <span><strong>{title}</strong>{description && <small>{description}</small>}</span>
      </button>
      {open && <div className="disclosure-body" id={id}>{children}</div>}
    </div>
  );
}

/**
 * 页面内提示：info 普通说明、warning 需要留意的后果、success 完成、danger 错误（表单提交失败等，默认 role="alert"）。
 * 图标按语气自动选择，icon={false} 不显示图标（例如前面已经有加载圈）。不要再手写 inline-note／form-alert 类名。
 */
export function Notice({ tone = "info", icon, role, className = "", children }: { tone?: "info" | "warning" | "success" | "danger"; icon?: IconName | false; role?: "alert" | "status"; className?: string; children: ReactNode }) {
  const glyph = icon === false ? null : icon ?? (tone === "success" ? "checkCircle" : tone === "info" ? "info" : "alert");
  const base = tone === "danger" ? "form-alert" : `inline-note${tone === "info" ? "" : ` tone-${tone}`}`;
  return <div className={`${base} ${className}`.trim()} role={role ?? (tone === "danger" ? "alert" : undefined)}>{glyph && <Icon name={glyph} size={16} />}<span className="notice-body">{children}</span></div>;
}

/** 空状态。页面级用默认尺寸；面板、弹窗与设置分组里用 compact（更小的内边距，左对齐的图标与文字）。 */
export function EmptyState({ icon = "folder", title, description, action, compact = false }: { icon?: IconName; title: string; description?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty-state${compact ? " is-compact" : ""}`}>
      <span className="empty-icon"><Icon name={icon} size={22} /></span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton-rows" aria-busy="true" aria-label="正在加载">
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton skeleton-icon" />
          <span className="skeleton skeleton-line" style={{ width: `${48 - (index % 3) * 9}%` }} />
          <span className="skeleton skeleton-line skeleton-short" />
        </div>
      ))}
    </div>
  );
}

export function Progress({ value, tone = "accent", label }: { value: number; tone?: Tone; label?: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className={`progress progress-${tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)} aria-label={label}>
      <span style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function usageTone(percent: number): Tone {
  return percent >= 95 ? "danger" : percent >= 80 ? "warning" : "accent";
}

export async function copyText(value: string, message = "已复制到剪贴板", announce = true) {
  try {
    await navigator.clipboard.writeText(value);
    if (announce) toast.success(message);
    return true;
  } catch {
    toast.error("无法访问剪贴板，请手动选择并复制");
    return false;
  }
}

export function CopyField({ value, label, secret, copyMessage, primary = false }: { value: string; label: string; secret?: boolean; copyMessage?: string; primary?: boolean }) {
  const [revealed, setRevealed] = useState(!secret);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [value]);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 2500); return () => window.clearTimeout(timer); }, [copied]);
  return (
    <div className="copy-field">
      <input readOnly value={revealed ? value : "•".repeat(Math.min(32, value.length))} aria-label={label} onFocus={event => revealed && event.target.select()} />
      {secret && <IconButton icon="eye" label={revealed ? "隐藏" : "显示"} size="sm" active={revealed} onClick={() => setRevealed(value => !value)} />}
      <Button size={primary ? "md" : "sm"} variant={primary ? "primary" : "secondary"} icon={copied ? "check" : "copy"} onClick={() => void copyText(value, copyMessage, false).then(setCopied)}>{copied ? "已复制" : primary ? "复制分享链接" : "复制"}</Button>
      <span className="sr-only" role="status">{copied ? copyMessage ?? "已复制到剪贴板" : ""}</span>
    </div>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="key-value">
      {items.map(([key, value], index) => <div key={index}><dt>{key}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

/** 有头像图片时显示图片（加载失败退回首字母），否则显示名字的首字母。 */
export function Avatar({ name, tone = "accent", src, size }: { name: string; tone?: "accent" | "admin"; src?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const style = size ? { width: size, height: size, fontSize: Math.round(size * .4) } : undefined;
  if (src && !failed) return <img className="avatar avatar-image" src={src} alt="" aria-hidden="true" style={style} onError={() => setFailed(true)} />;
  return <span className={`avatar avatar-${tone}`} aria-hidden="true" style={style}>{Array.from(name.trim() || "?")[0].toUpperCase()}</span>;
}

/* ---------- 格式化 ---------- */

export function formatBytes(value: number | null | undefined) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.max(0, Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1));
  const amount = value / 1024 ** index;
  return `${index === 0 ? Math.round(amount) : amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
const timeFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
export function formatDate(seconds: number | null | undefined) {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400 && new Date().getDate() === date.getDate()) return `今天 ${timeFormatter.format(date)}`;
  return dateFormatter.format(date);
}
export function formatDateTime(seconds: number | null | undefined) {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  return `${dateFormatter.format(date)} ${timeFormatter.format(date)}`;
}

/** title 为 null 时不修改（组件嵌在其他页面里，由外层页面设置标题）。 */
export function useDocumentTitle(title: string | null) {
  useEffect(() => { if (title !== null) document.title = title; }, [title]);
}

export function Pagination({ number, hasPrevious, hasNext, loading, previous, next, pageSize, changePageSize }: {
  number: number; hasPrevious: boolean; hasNext: boolean; loading: boolean; previous: () => void; next: () => void;
  pageSize?: number; changePageSize?: (size: number) => void;
}) {
  // 只有一页时不显示分页（包括每页数量）：数量选择只在内容多于一页时才有意义。
  if (number === 1 && !hasPrevious && !hasNext) return null;
  return <nav className="pagination" aria-label="分页">
    {changePageSize && <label className="pagination-size"><span>每页</span><select className="input" aria-label="每页文件数量" value={pageSize} onChange={event => changePageSize(Number(event.target.value))}>
      {FILE_PAGE_SIZES.map(size => <option key={size} value={size}>{size} 项</option>)}
    </select></label>}
    <Button size="sm" disabled={loading || !hasPrevious} onClick={previous}>上一页</Button>
    <span aria-live="polite" aria-atomic="true">第 {number} 页</span>
    <Button size="sm" disabled={loading || !hasNext} onClick={next}>下一页</Button>
    {loading && <span className="spinner" role="status" aria-label="正在加载" />}
  </nav>;
}
