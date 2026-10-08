/** 用户端与管理端共用的应用外壳、登录页和首次设置页。 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import * as api from "./api";
import { Avatar, Brand, Button, Field, Icon, Menu, Toaster, type IconName, type MenuItem } from "./ui";

export type NavItem<K extends string> = { key: K; label: string; icon: IconName; count?: number; href?: string };
export type NavGroup<K extends string> = { label?: string; items: NavItem<K>[] };

export function AppShell<K extends string>({ variant, groups, active, onNavigate, sidebarFooter, account, children }: {
  variant: "user" | "admin";
  groups: NavGroup<K>[];
  active: K;
  onNavigate: (key: K) => void;
  sidebarFooter?: ReactNode;
  account: { name: string; caption: string; menu: MenuItem[] };
  children: ReactNode;
}) {
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [active]);
  useEffect(() => {
    if (!drawer) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawer(false); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [drawer]);
  return (
    <div className={`shell shell-${variant}${drawer ? " drawer-open" : ""}`}>
      <a className="skip-link" href="#main">跳到主要内容</a>
      <header className="mobile-bar">
        <button type="button" className="icon-btn icon-btn-ghost" aria-label="打开导航" aria-expanded={drawer} onClick={() => setDrawer(true)}><Icon name="menu" /></button>
        <Brand suffix={variant === "admin" ? "控制台" : undefined} />
        <Avatar name={account.name} tone={variant === "admin" ? "admin" : "accent"} />
      </header>
      <div className="drawer-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
      <aside className="sidebar" aria-label="主导航">
        <div className="sidebar-top">
          <Brand suffix={variant === "admin" ? "控制台" : undefined} />
          <button type="button" className="icon-btn icon-btn-ghost icon-btn-sm sidebar-close" aria-label="关闭导航" onClick={() => setDrawer(false)}><Icon name="x" size={16} /></button>
        </div>
        <nav className="sidebar-nav">
          {groups.map((group, index) => (
            <div className="nav-group" key={group.label ?? index}>
              {group.label && <p className="nav-group-label">{group.label}</p>}
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
            <Avatar name={account.name} tone={variant === "admin" ? "admin" : "accent"} />
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

function ChannelIllustration({ admin }: { admin: boolean }) {
  const chunks = [
    { part: "0001", size: "16.0 MB", hash: "9f2c…a71e" },
    { part: "0002", size: "16.0 MB", hash: "41bd…0c93" },
    { part: "0003", size: "16.0 MB", hash: "e7a0…5f12" },
    { part: "0004", size: "4.2 MB", hash: "c3d8…b6e4" },
  ];
  return (
    <div className="auth-visual" aria-hidden="true">
      <div className="channel">
        <div className="channel-head">
          <span className="channel-avatar"><Icon name="send" size={16} /></span>
          <span><strong>私有存储频道</strong><small>{admin ? "3 个 Bot 在线" : "仅你的 Bot 可见"}</small></span>
          <Icon name="lock" size={16} />
        </div>
        <div className="channel-feed">
          <div className="channel-file">
            <span className="file-tile tile-pdf"><Icon name="fileText" size={18} /></span>
            <span><strong>年度报告-2026.pdf</strong><small>52.2 MB，已切分为 4 个分片</small></span>
          </div>
          {chunks.map((chunk, index) => (
            <div className="chunk" key={chunk.part} style={{ animationDelay: `${180 + index * 140}ms` }}>
              <Icon name="lock" size={14} />
              <code>chunk-{chunk.part}.enc</code>
              <span className="chunk-size">{chunk.size}</span>
              <span className="chunk-hash">{chunk.hash}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="auth-visual-caption">
        每个文件在服务端以 AES-256-GCM 加密并切分为分片，作为消息保存在你自己的 Telegram 私有频道中。
      </p>
    </div>
  );
}

export function AuthLayout({ admin, title, description, children, footer }: { admin: boolean; title: string; description: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className={`auth ${admin ? "auth-admin" : "auth-user"}`}>
      <div className="auth-form-pane">
        <Brand suffix={admin ? "控制台" : undefined} />
        <div className="auth-form-wrap">
          <h1>{title}</h1>
          <p className="auth-description">{description}</p>
          {children}
        </div>
        <footer className="auth-footer">{footer}</footer>
      </div>
      <ChannelIllustration admin={admin} />
      <Toaster />
    </div>
  );
}

export function LoginPage({ kind, onSuccess, notice }: { kind: api.Role; onSuccess: (session: api.Session) => void; notice?: ReactNode }) {
  const admin = kind === "admin";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = admin ? "登录控制台 · tgdrive" : "登录 · tgdrive"; }, [admin]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || !password) { setError("请输入用户名和密码"); return; }
    setError(""); setBusy(true);
    try { onSuccess(admin ? await api.adminLogin(username.trim(), password) : await api.login(username.trim(), password)); }
    catch (reason) {
      const status = reason instanceof api.ApiError ? reason.status : 0;
      setError(status === 401 ? "用户名或密码不正确" : status === 429 ? "登录失败次数过多，请 15 分钟后再试"
        : status === 503 ? "系统当前已锁定，请联系管理员解锁后再登录" : api.errorMessage(reason, "登录失败，请稍后重试"));
    } finally { setBusy(false); }
  }
  const docsHref = admin && window.location.pathname.startsWith("/admin") ? "/admin/docs" : "/docs";
  return (
    <AuthLayout admin={admin} title={admin ? "登录控制台" : "登录 tgdrive"}
      description={admin ? "管理用户、存储通道和系统密钥。" : "访问你的私有文件空间。"}
      footer={<><a href={docsHref}>使用文档</a>{!admin && <span>没有账号？请联系管理员创建。</span>}</>}>
      {notice}
      <form className="form" onSubmit={submit} noValidate>
        <Field label="用户名" htmlFor="login-username">
          <input id="login-username" className="input input-lg" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoFocus />
        </Field>
        <Field label="密码" htmlFor="login-password">
          <input id="login-password" className="input input-lg" value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" />
        </Field>
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
  useEffect(() => { document.title = "初始化 · tgdrive"; }, []);
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
    catch (reason) { setErrors({ form: api.errorMessage(reason, "初始化失败") }); }
    finally { setBusy(false); }
  }
  return (
    <AuthLayout admin title="初始化 tgdrive" description="设置加密口令并创建第一个管理员账号。口令用于派生主密钥，服务每次重启后都需要输入它来解锁。">
      <form className="form" onSubmit={submit} noValidate>
        <Field label="加密口令" htmlFor="setup-passphrase" error={errors.passphrase} hint="无法找回。丢失口令意味着所有文件都无法解密。">
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

/** 两个入口各自监听自己的会话失效事件，互不影响。 */
export function useSessionGuard(role: api.Role, restore: () => Promise<api.Session>) {
  const [session, setSession] = useState<api.Session | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let active = true;
    void restore().then(value => { if (active) setSession(value); }).catch(() => undefined).finally(() => { if (active) setChecking(false); });
    const expire = (event: Event) => { if ((event as CustomEvent<string>).detail === role) setSession(null); };
    window.addEventListener("tgdrive:session-expired", expire);
    return () => { active = false; window.removeEventListener("tgdrive:session-expired", expire); };
  }, []);
  return { session, setSession, checking };
}
