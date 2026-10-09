/** 用户端与管理端共用的应用外壳、登录页和首次设置页。 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BRAND, SITE } from "./brand";
import * as api from "./api";
import { Avatar, Brand, Button, Checkbox, Field, Icon, Menu, Segmented, Toaster, type IconName, type MenuItem } from "./ui";

export type NavItem<K extends string> = { key: K; label: string; icon: IconName; count?: number; href?: string };
export type NavGroup<K extends string> = { label?: string; workspace?: boolean; items: NavItem<K>[] };

export function AppShell<K extends string>({ groups, active, onNavigate, sidebarFooter, account, children }: {
  groups: NavGroup<K>[];
  active: K;
  onNavigate: (key: K) => void;
  sidebarFooter?: ReactNode;
  account: { name: string; caption: string; tone?: "accent" | "admin"; menu: MenuItem[] };
  children: ReactNode;
}) {
  const [drawer, setDrawer] = useState(false);
  const workspaces = groups.filter(group => group.workspace && group.label);
  const currentWorkspace = workspaces.find(group => group.items.some(item => item.key === active)) ?? workspaces[0];
  useEffect(() => { setDrawer(false); }, [active]);
  useEffect(() => {
    if (!drawer) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawer(false); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [drawer]);
  return (
    <div className={`shell${drawer ? " drawer-open" : ""}`}>
      <a className="skip-link" href="#main">跳到主要内容</a>
      <header className="mobile-bar">
        <button type="button" className="icon-btn icon-btn-ghost" aria-label="打开导航" aria-expanded={drawer} onClick={() => setDrawer(true)}><Icon name="menu" /></button>
        <Brand />
        <Avatar name={account.name} tone={account.tone} />
      </header>
      <div className="drawer-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
      <aside className="sidebar" aria-label="主导航">
        <div className="sidebar-top">
          <Brand />
          <button type="button" className="icon-btn icon-btn-ghost icon-btn-sm sidebar-close" aria-label="关闭导航" onClick={() => setDrawer(false)}><Icon name="x" size={16} /></button>
        </div>
        {workspaces.length > 1 && <div className="workspace-switch"><Segmented label="工作区" value={currentWorkspace.label!} options={workspaces.map(group => ({ value: group.label!, label: group.label! }))} onChange={label => {
          const group = workspaces.find(item => item.label === label); if (group?.items[0]) onNavigate(group.items[0].key);
        }} /></div>}
        <nav className="sidebar-nav">
          {groups.filter(group => workspaces.length < 2 || !group.workspace || group === currentWorkspace).map((group, index) => (
            <div className="nav-group" key={group.label ?? index}>
              {group.label && !group.workspace && <p className="nav-group-label">{group.label}</p>}
              {group.items.map(item => {
                const content = <><Icon name={item.icon} size={18} /><span className="nav-label">{item.label}</span>{item.count !== undefined && item.count > 0 && <span className="nav-count">{item.count}</span>}{item.href && <Icon name="external" size={14} className="nav-external" />}</>;
                return item.href
                  ? <a key={item.key} className="nav-item" href={item.href} target="_blank" rel="noreferrer">{content}</a>
                  : <button key={item.key} type="button" className={`nav-item${active === item.key ? " is-active" : ""}`} aria-current={active === item.key ? "page" : undefined} onClick={() => onNavigate(item.key)}>{content}</button>;
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {sidebarFooter}
          <div className="account-row">
            <Avatar name={account.name} tone={account.tone} />
            <span className="account-copy"><strong>{account.name}</strong><small>{account.caption}</small></span>
            <Menu label="账号菜单" icon="settings" items={account.menu} />
          </div>
        </div>
      </aside>
      <main className="main" id="main" tabIndex={-1}>
        <div className="main-inner">{children}</div>
      </main>
      <Toaster />
    </div>
  );
}

/* ---------- 登录与首次设置 ---------- */

/** 登录页右侧：一面由瓦片拼成的马赛克（只做一次入场动画），配上三句话说明文件是怎么被保管的。 */
const MOSAIC = (() => {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return Array.from({ length: 9 * 5 }, (_, index) => index === 13 ? "plane" : `t${1 + Math.floor(next() * next() * 4.4)}`);
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
        {MOSAIC.map((tone, index) => <i key={index} className={tone} style={{ animationDelay: `${120 + index * 22}ms` }} />)}
      </div>
      <div className="auth-visual-copy">
        <h2>{admin ? "几分钟，搭好你的私人云盘" : "把文件放在一个只属于你的地方"}</h2>
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
        <Brand />
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
 * 登录页：记住上次的用户名（下次直接输入密码），可选“30 天内保持登录”（长期会话），
 * 以及显示/隐藏密码和大写锁定提示。用户名只保存在本机，不含密码。
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
  useEffect(() => { document.title = `登录 · ${BRAND}`; }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || !password) { setError("请输入用户名和密码"); return; }
    setError(""); setBusy(true);
    try {
      const session = await api.login(username.trim(), password, remember);
      store(LAST_USERNAME, username.trim());
      store(STAY_SIGNED_IN, remember ? "1" : "0");
      onSuccess(session);
    } catch (reason) {
      const status = reason instanceof api.ApiError ? reason.status : 0;
      setError(status === 401 ? "用户名或密码不正确" : status === 429 ? "登录失败次数过多，请 15 分钟后再试"
        : status === 503 ? "系统当前已锁定，请联系管理员解锁后再登录" : api.errorMessage(reason, "登录失败，请稍后重试"));
    } finally { setBusy(false); }
  }
  function switchAccount() {
    store(LAST_USERNAME, "");
    setUsername(""); setPassword(""); setError("");
    usernameInput.current?.focus();
  }
  return (
    <AuthLayout admin={false} title="登录" description="登录你的文件空间。"
      footer={<><a href="/docs">使用文档</a><span>没有账号？请联系管理员创建。</span></>}>
      {notice}
      <form className="form" onSubmit={submit} noValidate>
        <Field label="用户名" htmlFor="login-username"
          hint={saved && username === saved ? <>上次登录的账号。<button type="button" className="link-button" onClick={switchAccount}>换个账号</button></> : undefined}>
          <input ref={usernameInput} id="login-username" name="username" className="input input-lg" value={username} onChange={event => setUsername(event.target.value)}
            autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus={!saved} />
        </Field>
        <Field label="密码" htmlFor="login-password" hint={capsLock ? <span className="tone-warning">大写锁定已开启</span> : undefined}>
          <div className="input-affix input-affix-lg">
            <input id="login-password" name="password" className="input input-lg" value={password} onChange={event => setPassword(event.target.value)}
              type={showPassword ? "text" : "password"} autoComplete="current-password" autoFocus={Boolean(saved)}
              onKeyDown={event => setCapsLock(event.getModifierState("CapsLock"))} onKeyUp={event => setCapsLock(event.getModifierState("CapsLock"))} onBlur={() => setCapsLock(false)} />
            <button type="button" className="affix-toggle" aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? "隐藏" : "显示"}</button>
          </div>
        </Field>
        <label className="check-row">
          <Checkbox checked={remember} onChange={setRemember} label="30 天内保持登录" />
          <span><strong>30 天内保持登录</strong><small>下次打开无需重新登录。在公共电脑上请不要勾选。</small></span>
        </label>
        {error && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{error}</div>}
        <Button type="submit" variant="primary" size="lg" block loading={busy}>{busy ? "正在登录" : "登录"}</Button>
      </form>
    </AuthLayout>
  );
}

export function SetupPage({ onComplete }: { onComplete: () => void }) {
  const [form, setForm] = useState({ passphrase: "", passphrase2: "", username: "admin", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = `初始化 · ${BRAND}`; }, []);
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: event.target.value });
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (form.passphrase.length < 12) next.passphrase = "加密口令至少 12 个字符";
    if (form.passphrase !== form.passphrase2) next.passphrase2 = "两次输入的口令不一致";
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/.test(form.username)) next.username = "2–64 位英文字母、数字、点、下划线或连字符";
    if (form.password.length < 8) next.password = "密码至少 8 个字符";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try { await api.adminSetup(form.passphrase, form.username, form.password); onComplete(); }
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
          <Field label="管理员用户名" htmlFor="setup-username" error={errors.username}>
            <input id="setup-username" className="input" autoComplete="username" value={form.username} onChange={set("username")} />
          </Field>
          <Field label="管理员密码" htmlFor="setup-password" error={errors.password}>
            <input id="setup-password" className="input" type="password" autoComplete="new-password" value={form.password} onChange={set("password")} />
          </Field>
        </div>
        {errors.form && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{errors.form}</div>}
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
