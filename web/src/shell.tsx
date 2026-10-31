/** 用户端与管理端共用的应用外壳、登录页和首次设置页。 */
import { Fragment, useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { BRAND, SITE, STORY, TAGLINE } from "./brand";
import * as api from "./api";
import { loginWithPasskey, passkeyUnavailable } from "./passkeys";
import { Notice, Avatar, Brand, Button, Checkbox, Field, Icon, LeaveGuard, Menu, Segmented, Toaster, type IconName, type MenuItem } from "./ui";

/** live：有任务正在进行，数量角标显示呼吸提示（任务中心）。 */
export type NavItem<K extends string> = { key: K; label: string; icon: IconName; count?: number; live?: boolean; href?: string };
/** 侧栏分组：有标题的分组可以点击展开／收起（状态保存在本机）；workspace 指明所属工作区（管理员的「我的空间／系统管理」）。 */
export type NavGroup<K extends string> = { label?: string; workspace?: string; items: NavItem<K>[] };
export type NavWorkspace = { label: string; icon: IconName };
export type NavLink = { label: string; icon: IconName; href: string };

const COLLAPSED_GROUPS = "tessera:nav-collapsed";
/** 桌面侧栏收起为图标栏，记在这台设备上；手机抽屉不受影响。 */
const SIDEBAR_RAIL = "tessera:sidebar-rail";
/** 没有手动选择时按窗口宽度决定：1200px 以下的桌面窗口自动收起，给内容区留出空间。 */
const RAIL_AUTO = "(max-width: 1199px)";
const readRail = (): boolean | null => {
  try { const value = localStorage.getItem(SIDEBAR_RAIL); return value === "1" ? true : value === "0" ? false : null; } catch { return null; }
};
const autoRail = () => typeof matchMedia === "function" && matchMedia(RAIL_AUTO).matches;
function readCollapsed(): string[] {
  try { const value = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS) ?? "[]"); return Array.isArray(value) ? value.filter(item => typeof item === "string") : []; }
  catch { return []; }
}

export function AppShell<K extends string>({ groups, slot, workspaces = [], active, activeHighlight = true, onNavigate, hrefFor, sidebarAction, sidebarFooter, links = [], account, children }: {
  groups: NavGroup<K>[];
  /** 插在某个分组之后的自定义分组（侧栏收藏）：与普通分组一样可折叠，内容由调用方渲染。 */
  slot?: { label: string; after: string; render: (rail: boolean) => ReactNode };
  /** false 时不高亮任何导航项（当前位置由 slot 里的项目高亮，例如打开了收藏的文件夹）。 */
  activeHighlight?: boolean;
  workspaces?: NavWorkspace[];
  active: K;
  onNavigate: (key: K) => void;
  /** 每个导航项的真实地址：渲染成链接，⌘/Ctrl/中键点击可在新标签页打开。 */
  hrefFor: (key: K) => string;
  /** 导航上方的常用入口（文件助手）。 */
  sidebarAction?: ReactNode;
  sidebarFooter?: ReactNode;
  /** 底部的外部链接（使用文档），在新标签页打开。 */
  links?: NavLink[];
  account: { name: string; caption: string; tone?: "accent" | "admin"; avatar?: string; menu: MenuItem[] };
  children: ReactNode;
}) {
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [saved, setSaved] = useState(readRail);
  const [narrow, setNarrow] = useState(autoRail);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(RAIL_AUTO);
    const update = () => {
      setNarrow(query.matches);
      // 跨过断点时回到自动：在窄窗口里展开过的侧栏，放大后不再固定为展开，反之亦然。
      setSaved(null);
      try { localStorage.removeItem(SIDEBAR_RAIL); } catch { /* 隐私模式下不保存 */ }
    };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const rail = saved ?? narrow;
  const toggleRail = () => {
    try { localStorage.setItem(SIDEBAR_RAIL, rail ? "0" : "1"); } catch { /* 隐私模式下不保存 */ }
    setSaved(!rail);
  };
  const groupOf = (key: K) => groups.find(group => group.items.some(item => item.key === key));
  const currentWorkspace = workspaces.find(workspace => workspace.label === groupOf(active)?.workspace) ?? workspaces[0];
  const saveCollapsed = (next: string[]) => {
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_GROUPS, JSON.stringify(next)); } catch { /* 隐私模式下不保存，只影响下次打开 */ }
  };
  // 进入某个页面时，展开它所在的分组：当前页总是看得见。
  useEffect(() => {
    const label = groupOf(active)?.label;
    if (label && collapsed.includes(label)) saveCollapsed(collapsed.filter(item => item !== label));
  }, [active]);
  useEffect(() => { setDrawer(false); }, [active]);
  useEffect(() => {
    if (!drawer) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawer(false); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [drawer]);
  const visible = groups.filter(group => !group.workspace || !currentWorkspace || group.workspace === currentWorkspace.label);
  return (
    <div className={`shell${drawer ? " drawer-open" : ""}${rail ? " is-rail" : ""}`}>
      <a className="skip-link" href="#main">跳到主要内容</a>
      <header className="mobile-bar">
        <button type="button" className="icon-btn icon-btn-ghost" aria-label="打开导航" aria-expanded={drawer} onClick={() => setDrawer(true)}><Icon name="menu" /></button>
        <Brand />
        {/* 窄屏顶栏的头像直接打开账号菜单（设置、访问密钥、外观、退出），不必先展开侧栏。 */}
        <Menu label="账号操作" items={account.menu} size="md" className="mobile-account"><Avatar name={account.name} tone={account.tone} src={account.avatar} /></Menu>
      </header>
      <div className="drawer-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
      {/* 手机抽屉：点任何导航项（包括当前页）、外部链接或标记了 data-closes-nav 的入口后都收起。 */}
      <aside className="sidebar" aria-label="主导航" onClick={event => { if ((event.target as Element).closest("a[href], [data-closes-nav]")) setDrawer(false); }}>
        <div className="sidebar-top">
          <Brand tagline />
          <button type="button" className="icon-btn icon-btn-ghost icon-btn-sm sidebar-rail-toggle" aria-label={rail ? "展开侧栏" : "收起侧栏"} title={rail ? "展开侧栏" : "收起侧栏"} aria-pressed={rail} onClick={toggleRail}><Icon name="sidebar" size={16} /></button>
          <button type="button" className="icon-btn icon-btn-ghost icon-btn-sm sidebar-close" aria-label="关闭导航" onClick={() => setDrawer(false)}><Icon name="x" size={16} /></button>
        </div>
        {workspaces.length > 1 && currentWorkspace && <div className="workspace-switch"><Segmented label="工作区" showLabels value={currentWorkspace.label} options={workspaces.map(item => ({ value: item.label, label: item.label, icon: item.icon }))} onChange={label => {
          const first = groups.find(group => group.workspace === label)?.items[0]; if (first) onNavigate(first.key);
        }} /></div>}
        {sidebarAction && <div className="sidebar-action">{sidebarAction}</div>}
        <nav className="sidebar-nav">
          {visible.map((group, index) => {
            // 图标栏里分组标题不显示，所有分组都展开，用细线分隔。
            const folded = !rail && Boolean(group.label && collapsed.includes(group.label));
            const holdsActive = group.items.some(item => item.key === active);
            const id = `nav-group-${index}`;
            const items = group.items.map(item => {
              const content = <><Icon name={item.icon} size={17} /><span className="nav-label">{item.label}</span>{item.count !== undefined && item.count > 0 && <span className={`nav-count${item.live ? " is-live" : ""}`}>{item.count > 99 ? "99+" : item.count}</span>}{item.href && <Icon name="external" size={14} className="nav-external" />}</>;
              return item.href
                ? <a key={item.key} className="nav-item" href={item.href} target="_blank" rel="noreferrer" title={rail ? item.label : undefined}>{content}</a>
                : <a key={item.key} className={`nav-item${activeHighlight && active === item.key ? " is-active" : ""}`} href={hrefFor(item.key)} aria-current={activeHighlight && active === item.key ? "page" : undefined} title={rail ? item.label : undefined}
                  onClick={event => { if (isPlainClick(event)) { event.preventDefault(); onNavigate(item.key); } }}>{content}</a>;
            });
            if (!group.label) return <div className="nav-group" key={`group-${index}`}><div className="nav-group-list">{items}</div></div>;
            const block = (label: string, key: string, content: ReactNode, dot: boolean) => {
              const closed = !rail && collapsed.includes(label);
              return <div className={`nav-group is-collapsible${closed ? " is-collapsed" : ""}`} key={key}>
                <button type="button" className="nav-group-toggle" aria-expanded={!closed} aria-controls={`${key}-items`}
                  onClick={() => saveCollapsed(closed ? collapsed.filter(item => item !== label) : [...collapsed, label])}>
                  <span>{label}</span>
                  {closed && dot && <span className="nav-group-dot" aria-hidden="true" />}
                  <Icon name="chevronDown" size={12} />
                </button>
                <div className="nav-group-items" id={`${key}-items`}><div className="nav-group-list">{content}</div></div>
              </div>;
            };
            return <Fragment key={group.label}>
              {block(group.label, id, items, folded && holdsActive)}
              {slot && slot.after === group.label && block(slot.label, `nav-slot-${index}`, slot.render(rail), !activeHighlight)}
            </Fragment>;
          })}
        </nav>
        <div className="sidebar-bottom">
          {sidebarFooter}
          {links.length > 0 && <div className="sidebar-links">
            {links.map(link => <a key={link.href} className="sidebar-link" href={link.href} target="_blank" rel="noreferrer" title={rail ? link.label : undefined}><Icon name={link.icon} size={15} /><span>{link.label}</span><Icon name="external" size={12} className="nav-external" /></a>)}
          </div>}
          {rail
            ? <div className="account-row"><Menu label={`${account.name} · 账号操作`} items={account.menu} align="start" above size="md" className="account-rail-avatar"><Avatar name={account.name} tone={account.tone} src={account.avatar} /></Menu></div>
            : <div className="account-row">
              <Avatar name={account.name} tone={account.tone} src={account.avatar} />
              <span className="account-copy"><strong>{account.name}</strong><small>{account.caption}</small></span>
              <Menu label="账号操作" icon="more" items={account.menu} above />
            </div>}
        </div>
      </aside>
      <main className="main" id="main" tabIndex={-1}>
        <div className="main-inner">{children}</div>
      </main>
      <Toaster />
      <LeaveGuard />
    </div>
  );
}

/** 普通左键点击由应用内路由处理；带修饰键或非左键的点击交给浏览器（新标签页、新窗口）。 */
export function isPlainClick(event: MouseEvent<HTMLAnchorElement>) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}

/* ---------- 登录与首次设置 ---------- */

/** 登录页右侧：一面由细小瓦片拼成的马赛克（只做一次入场动画，边缘渐隐），配上三句话说明文件是怎么被保管的。 */
const MOSAIC_COLUMNS = 16;
const MOSAIC = (() => {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return Array.from({ length: MOSAIC_COLUMNS * 9 }, (_, index) => ({
    tone: index === 2 * MOSAIC_COLUMNS + 9 ? "plane" : `t${1 + Math.floor(next() * next() * next() * 5.2)}`,
    delay: 80 + Math.round(next() * 520),
  }));
})();

function AuthHero({ admin }: { admin: boolean }) {
  const points: { icon: IconName; text: string }[] = admin
    ? [
      { icon: "lock", text: "设置一个加密口令，所有文件都用它保护。" },
      { icon: "send", text: "添加存储位置，决定文件保存在哪里，之后可以随时增减。" },
      { icon: "users", text: "创建用户，并为每个人设置各自的空间大小。" },
    ]
    : [
      { icon: "upload", text: "上传、整理、预览各种文件，在任何设备上都能找到它们。" },
      { icon: "link", text: "一键生成分享链接，可以设置有效期和访问密码。" },
      { icon: "lock", text: "文件加密保存，由你控制是否公开分享。" },
    ];
  return (
    <div className="auth-visual">
      <div className="mosaic" aria-hidden="true">
        {MOSAIC.map((tile, index) => <i key={index} className={tile.tone} style={{ animationDelay: `${tile.delay}ms` }} />)}
      </div>
      <div className="auth-visual-copy">
        {admin ? <h2>几分钟，搭好你的私人云盘</h2> : <div className="auth-motto">
          <h2>{TAGLINE}</h2>
          <p>{STORY}</p>
        </div>}
        <ul className="auth-points">
          {points.map(point => <li key={point.icon}><span className="icon-wrap" aria-hidden="true"><Icon name={point.icon} size={16} /></span><span>{point.text}</span></li>)}
        </ul>
      </div>
    </div>
  );
}

export function AuthLayout({ admin, title, description, children, footer }: { admin: boolean; title: string; description: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className={`auth ${admin ? "auth-admin" : "auth-user"}`}>
      <div className="auth-form-pane">
        <Brand tagline />
        <div className="auth-form-wrap">
          <h1>{title}</h1>
          <p className="auth-description">{description}</p>
          {children}
        </div>
        <footer className="auth-footer">{footer}</footer>
      </div>
      <AuthHero admin={admin} />
      <Toaster />
    </div>
  );
}

const LAST_USERNAME = "tessera:last-username";
const STAY_SIGNED_IN = "tessera:stay-signed-in";
const stored = (key: string) => { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* 隐私模式下无法保存，不影响登录 */ } };

/**
 * 登录页：记住上次的登录邮箱（下次直接输入密码），可选“30 天内保持登录”（长期会话），
 * 以及显示/隐藏密码和大写锁定提示。邮箱只保存在本机，不含密码。旧账号仍可用原用户名登录。
 */
export function LoginPage({ onSuccess, notice }: { onSuccess: (session: api.Session) => void; notice?: ReactNode }) {
  const saved = stored(LAST_USERNAME);
  const [username, setUsername] = useState(saved);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(() => stored(STAY_SIGNED_IN) === "1");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const usernameInput = useRef<HTMLInputElement>(null);
  const [passkeyCapability, setPasskeyCapability] = useState<api.PasskeyCapability | null>(null);
  const [usingPasskey, setUsingPasskey] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const mounted = useRef(true), passkeyController = useRef<AbortController | null>(null);
  useEffect(() => { document.title = `登录 · ${BRAND}`; }, []);
  useEffect(() => {
    mounted.current = true;
    const load = new AbortController();
    void api.passkeyStatus(load.signal).then(value => { if (mounted.current) setPasskeyCapability(value); }).catch(() => undefined);
    void api.registrationConfig(load.signal).then(value => { if (mounted.current) setRegistrationOpen(value.enabled); }).catch(() => undefined);
    return () => { mounted.current = false; load.abort(); passkeyController.current?.abort(); };
  }, []);
  function accept(session: api.Session) {
    store(LAST_USERNAME, session.username);
    store(STAY_SIGNED_IN, remember ? "1" : "0");
    onSuccess(session);
  }
  async function passkeyLogin() {
    if (busy || !passkeyCapability || passkeyUnavailable(passkeyCapability)) return;
    const operation = new AbortController(); passkeyController.current = operation;
    setError(""); setBusy(true); setUsingPasskey(true);
    try {
      const session = await loginWithPasskey(remember, operation.signal);
      if (mounted.current) accept(session);
    } catch (reason) { if (mounted.current) setError(api.errorMessage(reason, "通行密钥登录失败，请使用密码登录")); }
    finally { if (mounted.current) { setBusy(false); setUsingPasskey(false); } }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) { setError("请输入邮箱和密码"); return; }
    setError(""); setBusy(true);
    try {
      const session = await api.login(username.trim(), password, remember);
      accept(session);
    } catch (reason) {
      const status = reason instanceof api.ApiError ? reason.status : 0;
      setError(status === 401 ? "邮箱或密码不正确" : status === 429 ? "登录失败次数过多，请 15 分钟后再试"
        : status === 503 ? "系统当前已锁定，请联系管理员解锁后再登录" : api.errorMessage(reason, "登录失败，请稍后重试"));
    } finally { setBusy(false); }
  }
  function switchAccount() {
    if (busy) return;
    store(LAST_USERNAME, "");
    setUsername(""); setPassword(""); setError("");
    usernameInput.current?.focus();
  }
  const passkeyReason = passkeyCapability ? passkeyUnavailable(passkeyCapability) : null;
  return (
    <AuthLayout admin={false} title="登录" description="登录你的文件空间。"
      footer={<><a href="/docs">使用文档</a>{registrationOpen ? <span>还没有账号？<a href="/register">注册账号</a></span> : <span>没有账号？请联系管理员创建。</span>}</>}>
      {notice}
      <form className="form" onSubmit={submit} noValidate>
        <Field label="邮箱" htmlFor="login-username"
          hint={saved && username === saved ? <>上次登录的账号。<button type="button" className="link-button" onClick={switchAccount}>换个账号</button></> : undefined}>
          <input ref={usernameInput} id="login-username" name="username" className="input input-lg" value={username} onChange={event => setUsername(event.target.value)}
            type="text" inputMode="email" placeholder="name@example.com" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus={!saved} disabled={busy} />
        </Field>
        <Field label="密码" htmlFor="login-password" hint={capsLock ? <span className="tone-warning">大写锁定已开启</span> : undefined}>
          <div className="input-affix input-affix-lg">
            <input id="login-password" name="password" className="input input-lg" value={password} onChange={event => setPassword(event.target.value)}
              type={showPassword ? "text" : "password"} autoComplete="current-password" autoFocus={Boolean(saved)} disabled={busy}
              onKeyDown={event => setCapsLock(event.getModifierState("CapsLock"))} onKeyUp={event => setCapsLock(event.getModifierState("CapsLock"))} onBlur={() => setCapsLock(false)} />
            <button type="button" className="affix-toggle" disabled={busy} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? "隐藏" : "显示"}</button>
          </div>
        </Field>
        <label className="check-row">
          <Checkbox checked={remember} onChange={value => { if (!busy) setRemember(value); }} label="30 天内保持登录" />
          <span><strong>30 天内保持登录</strong><small>下次打开无需重新登录。在公共电脑上请不要勾选。</small></span>
        </label>
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="primary" size="lg" block loading={busy && !usingPasskey} disabled={busy}>登录</Button>
        {passkeyCapability && <>
          <div className="private-unlock-divider"><span>或使用设备验证</span></div>
          <Button icon="key" size="lg" block loading={busy && usingPasskey} disabled={busy || Boolean(passkeyReason)} onClick={() => void passkeyLogin()}>通行密钥登录</Button>
          <p className="login-passkey-hint" role={usingPasskey ? "status" : undefined}>{usingPasskey ? "请在系统提示中完成验证" : passkeyReason || "由设备选择已绑定的账号，无需输入邮箱或密码。"}</p>
        </>}
      </form>
    </AuthLayout>
  );
}

export function SetupPage({ onComplete }: { onComplete: () => void }) {
  const [form, setForm] = useState({ passphrase: "", passphrase2: "", username: "", nickname: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = `初始化 · ${BRAND}`; }, []);
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: event.target.value });
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (form.passphrase.length < 12) next.passphrase = "加密口令至少 12 个字符";
    if (form.passphrase !== form.passphrase2) next.passphrase2 = "两次输入的口令不一致";
    if (!api.isEmail(form.username.trim())) next.username = "请输入有效的邮箱地址";
    if (form.nickname.trim().length > 32) next.nickname = "昵称最多 32 个字符";
    if (form.password.length < 8) next.password = "密码至少 8 个字符";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try { await api.adminSetup(form.passphrase, form.username.trim(), form.password, form.nickname.trim()); onComplete(); }
    catch (reason) { setErrors({ form: api.errorMessage(reason, "初始化失败，请稍后重试") }); }
    finally { setBusy(false); }
  }
  return (
    <AuthLayout admin title={`初始化 ${BRAND}`} description="先设置加密口令，再创建第一个管理员账号。加密口令用来保护所有文件，每次重启服务后需要输入它才能继续使用。">
      <form className="form" onSubmit={submit} noValidate>
        <Field label="加密口令" htmlFor="setup-passphrase" error={errors.passphrase} hint="无法找回。口令丢失后，已有的文件将无法再打开，请妥善保管。">
          <input id="setup-passphrase" className="input" type="password" autoComplete="new-password" value={form.passphrase} onChange={set("passphrase")} autoFocus />
        </Field>
        <Field label="确认加密口令" htmlFor="setup-passphrase2" error={errors.passphrase2}>
          <input id="setup-passphrase2" className="input" type="password" autoComplete="new-password" value={form.passphrase2} onChange={set("passphrase2")} />
        </Field>
        <div className="form-row">
          <Field label="管理员邮箱" htmlFor="setup-username" error={errors.username} hint="用于登录，之后可以在设置中修改。">
            <input id="setup-username" className="input" type="text" inputMode="email" placeholder="name@example.com" autoComplete="username"
              autoCapitalize="none" spellCheck={false} value={form.username} onChange={set("username")} />
          </Field>
          <Field label="昵称" htmlFor="setup-nickname" error={errors.nickname} hint="可选，显示在界面上。">
            <input id="setup-nickname" className="input" autoComplete="nickname" maxLength={32} value={form.nickname} onChange={set("nickname")} />
          </Field>
        </div>
        <Field label="管理员密码" htmlFor="setup-password" error={errors.password}>
          <input id="setup-password" className="input" type="password" autoComplete="new-password" value={form.password} onChange={set("password")} />
        </Field>
        {errors.form && <Notice tone="danger">{errors.form}</Notice>}
        <Button type="submit" variant="primary" size="lg" block loading={busy}>完成初始化</Button>
      </form>
    </AuthLayout>
  );
}

export function FullPageLoading({ label }: { label: string }) {
  return <div className="full-loading" role="status"><span className="spinner spinner-lg" aria-hidden="true" /><span>{label}</span></div>;
}

/** 恢复登录状态，并在任何接口返回 401（会话过期、被注销、被禁用）时回到登录页。 */
export function useSessionGuard(restore: () => Promise<api.Session>) {
  const [session, setSession] = useState<api.Session | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let active = true;
    void restore().then(value => { if (active) setSession(value); }).catch(() => undefined).finally(() => { if (active) setChecking(false); });
    const expire = () => setSession(null);
    window.addEventListener("tgdrive:session-expired", expire);
    return () => { active = false; window.removeEventListener("tgdrive:session-expired", expire); };
  }, []);
  return { session, setSession, checking };
}
