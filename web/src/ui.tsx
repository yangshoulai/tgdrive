/** Tessera 设计系统基元：所有页面只通过这里的组件表达按钮、表单、浮层和反馈。 */
import { Children, cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BRAND } from "./brand";

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
  key: "M15.5 8.5a3 3 0 1 1-3-3 3 3 0 0 1 3 3Zm-5.1 2.1L4 17v3h3v-2h2v-2h2l1.4-1.4",
  book: "M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2zm0 15a2 2 0 0 0 2 2h13v-4",
  users: "M16 20v-1.5A3.5 3.5 0 0 0 12.5 15h-5A3.5 3.5 0 0 0 4 18.5V20m6-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm6-5a2.5 2.5 0 0 1 0 5m4 8v-1.5a3.5 3.5 0 0 0-2.5-3.35",
  send: "M21 3 3 10.5l7 2.5m11-10-8 18-3-8m11-10L10 13",
  box: "M4 7.5 12 3l8 4.5v9L12 21l-8-4.5zm0 0 8 4.5 8-4.5M12 12v9",
  pulse: "M3 12h4l2-6 4 12 2-6h6",
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
  alert: "M12 3.5 2.5 20h19zM12 10v4.5m0 2.5h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v5m0-8h.01",
  x: "M6 6l12 12M18 6 6 18",
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
  move: "M3 7.2A2.2 2.2 0 0 1 5.2 5h3.6l2 2.2h8A2.2 2.2 0 0 1 21 9.4v8.4a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8zM9 13.5h6m-2.5-2.5 2.5 2.5-2.5 2.5",
  shield: "M12 3 4.5 6v6c0 4.4 3.2 7.8 7.5 9 4.3-1.2 7.5-4.6 7.5-9V6z",
  server: "M4 4h16v6H4zm0 10h16v6H4zm3-7h.01M7 17h.01",
  refresh: "M20 11a8 8 0 0 0-14.6-4.5L4 8m0-4v4h4m-4 5a8 8 0 0 0 14.6 4.5L20 16m0 4v-4h-4",
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

/** 标志：四块马赛克瓦片（tessera）拼成一个方块，右上角那块切成纸飞机的形状并用公开色强调。 */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect className="logo-a" x="2.5" y="2.5" width="13" height="13" rx="3" />
      <polygon className="logo-plane" points="18,4 28,4 28,14" strokeWidth="3" strokeLinejoin="round" />
      <path className="logo-fold" d="M27.2 4.8 23.4 8.6" strokeWidth="1.3" strokeLinecap="round" />
      <rect className="logo-b" x="2.5" y="16.5" width="13" height="13" rx="3" />
      <rect className="logo-c" x="16.5" y="16.5" width="13" height="13" rx="3" />
    </svg>
  );
}

export function Brand({ href = "/", suffix }: { href?: string; suffix?: string }) {
  return (
    <a className="brand" href={href} aria-label={`${BRAND} 首页`}>
      <LogoMark />
      <span className="brand-name">{BRAND}</span>
      {suffix && <span className="brand-suffix">{suffix}</span>}
    </a>
  );
}

/* ---------- 按钮 ---------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  loading?: boolean;
  block?: boolean;
};
export function Button({ variant = "secondary", size = "md", icon, loading, block, className = "", children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={`btn btn-${variant} btn-${size}${block ? " btn-block" : ""} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="spinner" aria-hidden="true" /> : icon && <Icon name={icon} size={size === "sm" ? 15 : 17} />}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon, label, onClick, variant = "ghost", size = "md", disabled, active }: { icon: IconName; label: string; onClick?: () => void; variant?: "ghost" | "secondary"; size?: "sm" | "md"; disabled?: boolean; active?: boolean }) {
  return (
    <button type="button" className={`icon-btn icon-btn-${variant} icon-btn-${size}${active ? " is-active" : ""}`} onClick={onClick} aria-label={label} title={label} disabled={disabled} aria-pressed={active}>
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

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: ReactNode; disabled?: boolean }) {
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

export function SearchInput({ value, onChange, onSubmit, onClear, placeholder, label }: { value: string; onChange: (value: string) => void; onSubmit?: () => void; onClear?: () => void; placeholder: string; label: string }) {
  return (
    <form className="search-input" role="search" noValidate onSubmit={event => { event.preventDefault(); onSubmit?.(); }}>
      <Icon name="search" size={16} />
      <input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={label} enterKeyHint="search" />
      {value && <button type="button" className="search-clear" aria-label="清除搜索" onClick={() => { onChange(""); onClear?.(); }}><Icon name="x" size={14} /></button>}
    </form>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: { value: T; label: string; icon?: IconName; count?: number }[]; onChange: (value: T) => void; label: string; disabled?: boolean }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button key={option.value} type="button" role="radio" disabled={disabled} aria-checked={value === option.value} tabIndex={value === option.value || (!options.some(item => item.value === value) && index === 0) ? 0 : -1} className={value === option.value ? "is-active" : ""} onClick={() => onChange(option.value)} title={option.icon ? option.label : undefined}
          onKeyDown={event => {
            const offset = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
            if (!offset && event.key !== "Home" && event.key !== "End") return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + offset + options.length) % options.length;
            onChange(options[next].value);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
          }}>
          {option.icon && <Icon name={option.icon} size={15} />}
          {(!option.icon || option.count !== undefined) && <span className={option.icon ? "sr-only" : ""}>{option.label}</span>}
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

export function Modal({ title, description, onClose, children, footer, size = "md", icon, leading, tone, dismissible = true, className = "", expandable = false }: { title: string; description?: ReactNode; onClose: () => void; children?: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" | "xl"; icon?: IconName; leading?: ReactNode; tone?: Tone; dismissible?: boolean; className?: string; expandable?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false), [fullscreen, setFullscreen] = useState(false), [switchingScreen, setSwitchingScreen] = useState(false);
  const supportsFullscreen = Boolean(document.fullscreenEnabled && document.documentElement.requestFullscreen);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const closeRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  closeRef.current = onClose;
  dismissibleRef.current = dismissible;
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
      if (document.fullscreenElement === backdrop.current) await document.exitFullscreen();
      else await backdrop.current.requestFullscreen();
    } catch { toast.error("无法进入全屏，可以使用最大化预览。"); }
    finally { setSwitchingScreen(false); }
  }
  useEffect(() => {
    const previous = previousFocus.current;
    const node = ref.current;
    if (!node) return;
    modalStack.at(-1)?.setAttribute("inert", "");
    modalStack.push(node);
    const preferred = focusable(node).find(item => item.matches("[autofocus], .modal-body input, .modal-body select")) ?? focusable(node)[0];
    (preferred ?? node).focus();
    document.body.classList.add("has-modal");
    const handleKey = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== node || event.defaultPrevented) return;
      if ((event.target as HTMLElement).closest?.(".menu")) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        // 全屏中的 Esc 只还原视图，避免同时关掉正在播放的预览。
        if (document.fullscreenElement && backdrop.current?.contains(document.fullscreenElement)) void document.exitFullscreen().catch(() => {});
        else if (dismissibleRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable(node);
      if (!items.length) { event.preventDefault(); node.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
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
  }, []);
  return createPortal(
    <div ref={backdrop} className={`modal-backdrop${maximized || fullscreen ? " is-expanded" : ""}${fullscreen ? " is-fullscreen" : ""}`} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && dismissible && modalStack.at(-1) === ref.current) onClose(); }}>
      <div ref={ref} className={`modal modal-${size} ${className}${maximized || fullscreen ? " is-expanded" : ""}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          {leading ?? (icon && <span className={`modal-icon tone-${tone ?? "accent"}`}><Icon name={icon} size={20} /></span>)}
          <div className="modal-heading">
            <h2 id={`${id}-title`} title={title}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <div className="modal-window-actions">
            {expandable && <>
              <IconButton icon={maximized ? "restore" : "maximize"} label={maximized ? "还原预览" : "最大化预览"} onClick={() => setMaximized(value => !value)} size="sm" active={maximized} disabled={fullscreen || switchingScreen} />
              {supportsFullscreen && <IconButton icon={fullscreen ? "exitFullscreen" : "fullscreen"} label={fullscreen ? "退出全屏" : "全屏预览"} onClick={() => void toggleFullscreen()} size="sm" active={fullscreen} disabled={switchingScreen} />}
            </>}
            <IconButton icon="x" label="关闭" onClick={onClose} size="sm" disabled={!dismissible} />
          </div>
        </header>
        {children && <div className="modal-body">{children}</div>}
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>, document.body,
  );
}

export function ConfirmDialog({ title, description, confirmLabel, onConfirm, onClose, danger = true }: { title: string; description: ReactNode; confirmLabel: string; onConfirm: () => Promise<void> | void; onClose: () => void; danger?: boolean }) {
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  }
  return (
    <Modal title={title} description={description} onClose={onClose} dismissible={!busy} size="sm" icon={danger ? "alert" : "info"} tone={danger ? "danger" : "accent"}
      footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant={danger ? "danger" : "primary"} loading={busy} onClick={() => void confirm()}>{confirmLabel}</Button></>} />
  );
}

export type MenuItem = { label: string; icon: IconName; onSelect: () => void; danger?: boolean; href?: string; divider?: boolean };
export function Menu({ items, label, icon = "more" }: { items: MenuItem[]; label: string; icon?: IconName }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !list.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const height = list.current.offsetHeight, width = list.current.offsetWidth;
    const below = rect.bottom + 6 + height < window.innerHeight;
    setPosition({ top: below ? rect.bottom + 6 : rect.top - height - 6, left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) });
  }, [open]);
  useLayoutEffect(() => {
    if (open && position) list.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true });
  }, [open, position]);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (!list.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
      if (event.key === "Tab") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = Array.from(list.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    const dismiss = () => setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);
  return (
    <>
      <button ref={trigger} type="button" className={`icon-btn icon-btn-ghost icon-btn-sm${open ? " is-active" : ""}`} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={event => { event.stopPropagation(); setOpen(value => !value); setPosition(null); }}>
        <Icon name={icon} size={16} />
      </button>
      {open && createPortal(
        <div ref={list} className="menu" role="menu" aria-label={label} style={position ? { top: position.top, left: position.left } : { visibility: "hidden", top: 0, left: 0 }} onClick={event => event.stopPropagation()}>
          {items.map(item => {
            const content = <><Icon name={item.icon} size={16} /><span>{item.label}</span></>;
            const className = `menu-item${item.danger ? " is-danger" : ""}${item.divider ? " has-divider" : ""}`;
            return item.href
              ? <a key={item.label} role="menuitem" className={className} href={item.href} onClick={() => setOpen(false)}>{content}</a>
              : <button key={item.label} type="button" role="menuitem" className={className} onClick={() => { setOpen(false); item.onSelect(); }}>{content}</button>;
          })}
        </div>,
        document.body,
      )}
    </>
  );
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
}
function dismissToast(id: number) {
  toasts = toasts.filter(item => item.id !== id);
  listeners.forEach(listener => listener(toasts));
}
export const toast = {
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

export function EmptyState({ icon = "folder", title, description, action }: { icon?: IconName; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
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

export function Avatar({ name, tone = "accent" }: { name: string; tone?: "accent" | "admin" }) {
  return <span className={`avatar avatar-${tone}`} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
}

/* ---------- 格式化 ---------- */

export function formatBytes(value: number | null | undefined) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${index === 0 ? amount : amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
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

export function useDocumentTitle(title: string) {
  useEffect(() => { document.title = title; }, [title]);
}

export function Pagination({ number, hasPrevious, hasNext, loading, previous, next }: {
  number: number; hasPrevious: boolean; hasNext: boolean; loading: boolean; previous: () => void; next: () => void;
}) {
  if (number === 1 && !hasPrevious && !hasNext && !loading) return null;
  return <nav className="pagination" aria-label="分页">
    <Button size="sm" disabled={loading || !hasPrevious} onClick={previous}>上一页</Button>
    <span aria-live="polite" aria-atomic="true">第 {number} 页</span>
    <Button size="sm" disabled={loading || !hasNext} onClick={next}>下一页</Button>
    {loading && <span className="spinner" role="status" aria-label="正在加载" />}
  </nav>;
}
