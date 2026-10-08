import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import * as api from "./api";
import { FileTile, PreviewModal, baseName, getFileKind, parentPath } from "./files";
import { AppShell, FullPageLoading, LoginPage, SetupPage, useSessionGuard } from "./shell";
import {
  Avatar, Badge, Button, ConfirmDialog, CopyField, EmptyState, Field, Icon, KeyValue, Menu, Modal, PageHeader, Panel, Progress,
  SearchInput, Segmented, SkeletonRows, Switch, copyText, formatBytes, formatDate, formatDateTime, toast, usageTone,
  useDocumentTitle, type IconName,
} from "./ui";

/* ---------- 路由 ---------- */

export function AdminRoute() {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [setupDone, setSetupDone] = useState(false);
  useEffect(() => { void api.adminStatus().then(status => setInitialized(status.initialized)).catch(() => setInitialized(true)); }, []);
  if (initialized === null) return <FullPageLoading label="正在连接控制台" />;
  if (!initialized) return <SetupPage onComplete={() => { setInitialized(true); setSetupDone(true); }} />;
  return <AdminSession justInitialized={setupDone} />;
}

function AdminSession({ justInitialized }: { justInitialized: boolean }) {
  const { session, setSession, checking } = useSessionGuard("admin", api.restoreAdminSession);
  if (checking) return <FullPageLoading label="正在恢复管理会话" />;
  if (!session) return <LoginPage kind="admin" onSuccess={value => { setSession(value); void api.restoreAdminSession().then(setSession).catch(() => undefined); }}
    notice={justInitialized ? <p className="inline-note tone-success"><Icon name="checkCircle" size={15} />初始化完成，系统已解锁。请使用刚创建的管理员账号登录。</p> : undefined} />;
  return <AdminShell session={session} onLogout={() => setSession(null)} />;
}

type Module = "overview" | "users" | "objects" | "bots" | "clients" | "maintenance" | "settings";
const MODULES: { key: Module; label: string; icon: IconName }[] = [
  { key: "overview", label: "概览", icon: "home" },
  { key: "users", label: "用户", icon: "users" },
  { key: "objects", label: "全部文件", icon: "box" },
  { key: "bots", label: "存储通道", icon: "send" },
  { key: "clients", label: "访问密钥", icon: "key" },
  { key: "maintenance", label: "安全与维护", icon: "shield" },
  { key: "settings", label: "系统设置", icon: "settings" },
];

function readModule(): Module {
  const value = new URLSearchParams(window.location.search).get("module");
  return MODULES.some(item => item.key === value) ? value as Module : "overview";
}

function AdminShell({ session, onLogout }: { session: api.Session; onLogout: () => void }) {
  const [module, setModule] = useState<Module>(readModule);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [status, setStatus] = useState<api.SystemStatus | null>(null);
  const [, setConfigVersion] = useState(0);
  const refreshStatus = useCallback(() => { void api.adminStatus().then(setStatus).catch(reason => toast.error(api.errorMessage(reason, "系统状态加载失败"))); }, []);
  useEffect(refreshStatus, [refreshStatus]);
  useEffect(() => {
    const pop = () => setModule(readModule());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  function navigate(next: Module) {
    window.history.pushState(null, "", next === "overview" ? window.location.pathname : `?module=${next}`);
    setModule(next);
  }
  async function logout() {
    await api.logout(true).catch(() => undefined);
    onLogout();
  }
  const locked = status !== null && !status.unlocked;
  // 状态未知时不渲染模块，避免锁定状态下先发出一批 503 请求。
  const content = status === null
    ? <FullPageLoading label="正在读取系统状态" />
    : locked && module !== "maintenance" && module !== "settings"
    ? <LockedGate onUnlocked={refreshStatus} />
    : <>
      {module === "overview" && <Overview onNavigate={navigate} />}
      {module === "users" && <Users />}
      {module === "objects" && <Objects session={session} />}
      {module === "bots" && <Bots />}
      {module === "clients" && <Clients />}
      {module === "maintenance" && <Maintenance status={status} onStatus={setStatus} onLocked={onLogout} />}
      {module === "settings" && <Settings onSaved={() => setConfigVersion(version => version + 1)} />}
    </>;
  return (
    <AppShell variant="admin" active={module} onNavigate={navigate}
      groups={[
        { items: MODULES.slice(0, 3) },
        { label: "系统", items: MODULES.slice(3) },
        { label: "帮助", items: [{ key: "docs" as Module, label: "使用文档", icon: "book", href: `${api.userSiteOrigin()}/docs` }] },
      ]}
      sidebarFooter={
        <button type="button" className={`system-chip${locked ? " is-locked" : ""}`} onClick={() => navigate("maintenance")}>
          <Icon name={locked ? "lock" : "unlock"} size={16} />
          <span><strong>{status === null ? "检查中" : locked ? "系统已锁定" : "系统运行中"}</strong><small>{locked ? "输入加密口令以解锁" : "密钥已加载"}</small></span>
        </button>
      }
      account={{ name: session.username, caption: "管理员", menu: [
        { label: "修改密码", icon: "lock", onSelect: () => setPasswordOpen(true) },
        { label: "打开用户端", icon: "external", onSelect: () => window.open(api.userSiteOrigin(), "_blank", "noreferrer") },
        { label: "退出登录", icon: "logout", onSelect: () => void logout(), divider: true },
      ] }}>
      {content}
      {passwordOpen && <AdminPasswordDialog onClose={() => setPasswordOpen(false)} />}
    </AppShell>
  );
}

function LockedGate({ onUnlocked }: { onUnlocked: () => void }) {
  useDocumentTitle("系统已锁定 · tgdrive 控制台");
  return (
    <div className="locked-gate">
      <span className="locked-icon"><Icon name="lock" size={26} /></span>
      <h1>系统已锁定</h1>
      <p>服务重启或手动锁定后，主密钥不在内存中。输入加密口令解锁后，用户才能登录，文件和公开链接才能访问。</p>
      <UnlockForm onUnlocked={() => onUnlocked()} />
    </div>
  );
}

function UnlockForm({ onUnlocked }: { onUnlocked: (status: api.SystemStatus) => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!passphrase) { setError("请输入加密口令"); return; }
    setBusy(true); setError("");
    try { const status = await api.adminUnlock(passphrase); setPassphrase(""); toast.success("系统已解锁"); onUnlocked(status); }
    catch (reason) { setError(reason instanceof api.ApiError && reason.code === "wrong_passphrase" ? "口令不正确" : api.errorMessage(reason, "解锁失败")); }
    finally { setBusy(false); }
  }
  return (
    <form className="unlock-form" onSubmit={submit} noValidate>
      <Field label="加密口令" htmlFor="unlock-passphrase" error={error}>
        <input id="unlock-passphrase" className="input" type="password" autoComplete="current-password" value={passphrase} onChange={event => { setPassphrase(event.target.value); setError(""); }} autoFocus />
      </Field>
      <Button type="submit" variant="primary" icon="unlock" loading={busy}>解锁</Button>
    </form>
  );
}

/* ---------- 概览 ---------- */

function Overview({ onNavigate }: { onNavigate: (module: Module) => void }) {
  const [data, setData] = useState<{ users: api.Account[]; objects: api.AdminObjectPage; bots: api.BotConfig[] } | null>(null);
  useDocumentTitle("概览 · tgdrive 控制台");
  const [settings, setSettings] = useState<api.SystemSettings | null>(null);
  useEffect(() => {
    void api.adminSettings().then(setSettings).catch(() => undefined);
    void Promise.all([api.adminUsers(), api.adminObjects({ limit: 6 }), api.adminBots()])
      .then(([users, objects, bots]) => setData({ users, objects, bots }))
      .catch(reason => toast.error(api.errorMessage(reason, "概览加载失败")));
  }, []);
  if (!data) return <><PageHeader title="概览" /><Panel><SkeletonRows rows={4} /></Panel></>;
  const used = data.users.reduce((sum, user) => sum + user.used_bytes, 0);
  const files = data.objects.objects;
  const activeBots = data.bots.filter(bot => bot.status === "active");
  const nearQuota = data.users.filter(user => user.quota_bytes && user.used_bytes / user.quota_bytes >= 0.85);
  const attention: { tone: "warning" | "danger" | "accent"; icon: IconName; title: string; detail: string; action: string; module: Module }[] = [];
  if (!activeBots.length) attention.push({ tone: "warning", icon: "send", title: "还没有启用的存储通道", detail: "新文件会暂存在服务器本地磁盘。添加 Bot 和私有频道后，文件将加密写入 Telegram。", action: "添加通道", module: "bots" });
  if (settings && (!settings.public_base_url.effective || !settings.s3_endpoint.effective)) attention.push({ tone: "accent", icon: "globe", title: "尚未配置对外访问地址", detail: `${!settings.public_base_url.effective ? "分享链接目前使用访问者打开的地址生成。" : ""}${!settings.s3_endpoint.effective ? "用户在访问密钥页看不到 S3 Endpoint。" : ""}`, action: "去配置", module: "settings" });
  if (data.users.filter(user => user.role === "user").length === 0) attention.push({ tone: "accent", icon: "users", title: "还没有普通用户", detail: "创建用户后，他们可以登录文件空间上传和分享文件。", action: "创建用户", module: "users" });
  nearQuota.forEach(user => attention.push({ tone: user.used_bytes >= (user.quota_bytes ?? 0) ? "danger" : "warning", icon: "pulse", title: `${user.username} 的空间即将用完`, detail: `已使用 ${formatBytes(user.used_bytes)} / ${formatBytes(user.quota_bytes)}。`, action: "调整配额", module: "users" }));
  return (
    <>
      <PageHeader title="概览" description="存储、用户与分享的当前状态。" />
      <div className="stat-strip">
        <Stat label="用户" value={String(data.users.length)} detail={`${data.users.filter(user => user.status === "active").length} 个启用`} />
        <Stat label="文件" value={data.objects.total.toLocaleString("zh-CN")} detail="全部用户" />
        <Stat label="已用空间" value={formatBytes(used)} detail="加密前的原始大小" />
        <Stat label="公开链接" value={data.objects.public_total.toLocaleString("zh-CN")} detail="任何人可访问" tone={data.objects.public_total ? "public" : undefined} />
        <Stat label="存储通道" value={`${activeBots.length}/${data.bots.length}`} detail="启用 / 全部" />
      </div>
      <div className="overview-grid">
        <Panel title="需要关注" flush>
          {attention.length === 0 ? <EmptyState icon="checkCircle" title="一切正常" description="没有需要处理的配置或容量问题。" /> : (
            <ul className="attention-list">
              {attention.map((item, index) => (
                <li key={index}>
                  <span className={`attention-icon tone-${item.tone}`}><Icon name={item.icon} size={17} /></span>
                  <span className="attention-copy"><strong>{item.title}</strong><small>{item.detail}</small></span>
                  <Button size="sm" onClick={() => onNavigate(item.module)}>{item.action}</Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="最近上传" flush actions={<Button size="sm" variant="ghost" onClick={() => onNavigate("objects")}>查看全部</Button>}>
          {files.length === 0 ? <EmptyState icon="box" title="还没有文件" description="用户上传的文件会显示在这里。" /> : (
            <ul className="recent-list">
              {files.slice(0, 6).map(item => (
                <li key={`${item.bucket_id}:${item.key}`}>
                  <FileTile kind={getFileKind(item.content_type, item.key)} />
                  <span className="recent-copy"><strong>{baseName(item.key)}</strong><small>{item.username ?? item.bucket_name}</small></span>
                  {item.public_token && <Badge tone="public" icon="globe">公开</Badge>}
                  <span className="muted recent-meta">{formatBytes(item.size)}</span>
                  <span className="muted recent-meta">{formatDate(item.modified_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

function Stat({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: "public" }) {
  return <div className={`stat${tone ? ` stat-${tone}` : ""}`}><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong><span className="stat-detail">{detail}</span></div>;
}

/* ---------- 用户 ---------- */

const GB = 1024 ** 3;

function Users() {
  const [users, setUsers] = useState<api.Account[] | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "disabled">("all");
  const [creating, setCreating] = useState(false);
  const [quotaTarget, setQuotaTarget] = useState<api.Account | null>(null);
  const [resetTarget, setResetTarget] = useState<api.Account | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<api.Account | null>(null);
  const [disabling, setDisabling] = useState<api.Account | null>(null);
  useDocumentTitle("用户 · tgdrive 控制台");
  const load = useCallback(() => { void api.adminUsers().then(setUsers).catch(reason => { setUsers([]); toast.error(api.errorMessage(reason, "用户加载失败")); }); }, []);
  useEffect(load, [load]);
  const shown = (users ?? []).filter(user => user.username.toLowerCase().includes(query.trim().toLowerCase()) && (status === "all" || user.status === status));
  async function setUserStatus(user: api.Account, next: "active" | "disabled") {
    try { await api.setAdminUserStatus(user.id, next); toast.success(next === "active" ? `已启用 ${user.username}` : `已禁用 ${user.username}`); load(); }
    catch (reason) { toast.error(api.errorMessage(reason, "状态更新失败")); }
  }
  return (
    <>
      <PageHeader title="用户" description="每个用户拥有独立的存储桶。配额在每次上传提交时强制校验。"
        actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>新建用户</Button>} />
      <div className="toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="按用户名筛选" label="筛选用户" />
        <Segmented label="状态" value={status} onChange={setStatus} options={[{ value: "all", label: "全部" }, { value: "active", label: "启用" }, { value: "disabled", label: "已禁用" }]} />
      </div>
      <section className="file-surface">
        {users === null ? <SkeletonRows rows={4} /> : shown.length === 0 ? <EmptyState icon="users" title={users.length ? "没有匹配的用户" : "还没有用户"} action={!users.length ? <Button icon="plus" onClick={() => setCreating(true)}>新建用户</Button> : undefined} /> : (
          <div className="data-table users-table" role="table" aria-label="用户">
            <div className="data-row data-head" role="row">
              <span role="columnheader">用户</span><span role="columnheader">存储空间</span><span role="columnheader">状态</span><span role="columnheader">最近登录</span><span role="columnheader"><span className="sr-only">操作</span></span>
            </div>
            {shown.map(user => {
              const percent = user.quota_bytes ? user.used_bytes / user.quota_bytes * 100 : 0;
              return (
                <div key={user.id} role="row" className="data-row">
                  <span role="cell" className="cell-user"><Avatar name={user.username} tone={user.role === "admin" ? "admin" : "accent"} /><span className="name-stack"><strong>{user.username}</strong><small>{user.role === "admin" ? "管理员" : `创建于 ${formatDate(user.created_at)}`}</small></span></span>
                  <span role="cell" className="cell-usage">
                    <span className="usage-text"><strong>{formatBytes(user.used_bytes)}</strong><span className="muted">{user.quota_bytes ? ` / ${formatBytes(user.quota_bytes)}` : " / 不限"}</span></span>
                    {user.quota_bytes ? <Progress value={percent} tone={usageTone(percent)} label={`${user.username} 存储使用率`} /> : null}
                  </span>
                  <span role="cell">{user.status === "active" ? <Badge tone="success" dot>启用</Badge> : <Badge tone="danger" dot>已禁用</Badge>}</span>
                  <span role="cell" className="muted" title={formatDateTime(user.last_login_at)}>{user.last_login_at ? formatDate(user.last_login_at) : "从未登录"}</span>
                  <span role="cell" className="cell-actions">
                    {user.role === "admin" ? <span className="muted cell-note">管理员账号不可禁用</span> : <>
                      <Button size="sm" variant="ghost" onClick={() => setQuotaTarget(user)}>调整配额</Button>
                      {user.status === "active"
                        ? <Button size="sm" variant="ghost" className="btn-ghost-danger" onClick={() => setDisabling(user)}>禁用</Button>
                        : <Button size="sm" onClick={() => void setUserStatus(user, "active")}>启用</Button>}
                      <Menu label={`${user.username} 的更多操作`} items={[
                        { label: "重置密码", icon: "key", onSelect: () => setResetTarget(user) },
                        { label: "删除用户", icon: "trash", danger: true, divider: true, onSelect: () => setDeleteTarget(user) },
                      ]} />
                    </>}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
      {creating && <CreateUserDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
      {quotaTarget && <QuotaDialog user={quotaTarget} onClose={() => setQuotaTarget(null)} onSaved={() => { setQuotaTarget(null); load(); }} />}
      {resetTarget && <ResetPasswordDialog user={resetTarget} onClose={() => setResetTarget(null)} />}
      {deleteTarget && <DeleteUserDialog user={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={() => { setDeleteTarget(null); load(); }} />}
      {disabling && <ConfirmDialog title={`禁用 ${disabling.username}？`} description="该用户会被立即登出，无法再登录，其所有公开链接暂停访问。文件不会被删除，可随时重新启用。" confirmLabel="禁用账号"
        onClose={() => setDisabling(null)} onConfirm={async () => { await setUserStatus(disabling, "disabled"); setDisabling(null); }} />}
    </>
  );
}

function parseQuota(value: string): number | null | undefined {
  if (!value.trim()) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * GB) : undefined;
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ username: "", password: "", quota: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const username = form.username.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/.test(username)) next.username = "2–64 位英文字母、数字、点、下划线或连字符";
    if (form.password.length < 8) next.password = "至少 8 个字符";
    const quota = parseQuota(form.quota);
    if (quota === undefined) next.quota = "请输入大于 0 的数字，或留空表示不限";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try { await api.createAdminUser(username, form.password, quota ?? null); toast.success(`已创建用户 ${username}`); onCreated(); }
    catch (reason) { setErrors({ username: api.errorMessage(reason, "创建失败") }); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="新建用户" description="创建后，用户可以立即用这个账号登录文件空间。" icon="users" onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="user-form" loading={busy}>创建用户</Button></>}>
      <form id="user-form" className="form" onSubmit={submit} noValidate>
        <Field label="用户名" htmlFor="user-name" error={errors.username}>
          <input id="user-name" className="input" autoComplete="off" value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} autoFocus />
        </Field>
        <Field label="初始密码" htmlFor="user-password" error={errors.password} hint="用户登录后可以在账号菜单中修改。">
          <input id="user-password" className="input" type="password" autoComplete="new-password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} />
        </Field>
        <Field label="容量上限" htmlFor="user-quota" error={errors.quota} hint="留空表示不限制。">
          <div className="input-affix"><input id="user-quota" className="input" inputMode="decimal" placeholder="例如 100" value={form.quota} onChange={event => setForm({ ...form, quota: event.target.value })} /><span>GB</span></div>
        </Field>
      </form>
    </Modal>
  );
}

function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint32Array(14)), value => alphabet[value % alphabet.length]).join("");
}

function ResetPasswordDialog({ user, onClose }: { user: api.Account; onClose: () => void }) {
  const [password, setPassword] = useState(generatePassword);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 8) { setError("至少 8 个字符"); return; }
    setBusy(true);
    try { await api.resetAdminUserPassword(user.id, password); setDone(true); toast.success(`已重置 ${user.username} 的密码`); }
    catch (reason) { setError(api.errorMessage(reason, "重置失败")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={`重置 ${user.username} 的密码`} description="新密码立即生效，该用户的现有登录会被注销。把新密码通过安全的方式告诉用户，并提醒他登录后修改。" icon="key" onClose={onClose} size="sm"
      footer={done ? <Button variant="primary" onClick={onClose}>完成</Button> : <><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="reset-form" loading={busy}>重置密码</Button></>}>
      <form id="reset-form" className="form" onSubmit={submit} noValidate>
        {done ? <Field label="新密码"><CopyField value={password} label="新密码" copyMessage="密码已复制" /></Field> : (
          <Field label="新密码" htmlFor="reset-password" error={error} hint="已随机生成，也可以改成自己设定的密码。">
            <div className="input-affix">
              <input id="reset-password" className="input mono" value={password} onChange={event => { setPassword(event.target.value); setError(""); }} autoFocus />
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => setPassword(generatePassword())}>换一个</Button>
            </div>
          </Field>
        )}
      </form>
    </Modal>
  );
}

function DeleteUserDialog({ user, onClose, onDeleted }: { user: api.Account; onClose: () => void; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.deleteAdminUser(user.id, confirm);
      toast.success(`已删除用户 ${result.username}，共删除 ${result.deleted_objects} 个文件`);
      onDeleted();
    } catch (reason) { toast.error(api.errorMessage(reason, "删除失败")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={`删除用户 ${user.username}？`} icon="alert" tone="danger" onClose={onClose} size="sm"
      description={<>该用户的全部文件（{formatBytes(user.used_bytes)}，含回收站）、访问密钥与公开链接都会被<strong>永久删除</strong>，无法恢复。只想暂时阻止登录时，请改用“禁用”。</>}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="danger" type="submit" form="delete-user-form" loading={busy} disabled={confirm !== user.username}>永久删除</Button></>}>
      <form id="delete-user-form" className="form" onSubmit={submit} noValidate>
        <Field label={`输入用户名 ${user.username} 以确认`} htmlFor="delete-confirm">
          <input id="delete-confirm" className="input" autoComplete="off" value={confirm} onChange={event => setConfirm(event.target.value)} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

function AdminPasswordDialog({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ old: "", next: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!form.old) next.old = "请输入当前密码";
    if (form.next.length < 8) next.next = "新密码至少 8 个字符";
    else if (form.next !== form.confirm) next.confirm = "两次输入的密码不一致";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try { await api.changeAdminPassword(form.old, form.next); toast.success("管理员密码已更新"); onClose(); }
    catch (reason) { setErrors({ old: api.errorMessage(reason, "修改失败") }); }
    finally { setBusy(false); }
  }
  const field = (key: keyof typeof form, label: string, autoComplete: string) => (
    <Field label={label} htmlFor={`admin-pw-${key}`} error={errors[key]}>
      <input id={`admin-pw-${key}`} className="input" type="password" autoComplete={autoComplete} value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} />
    </Field>
  );
  return (
    <Modal title="修改管理员密码" icon="lock" onClose={onClose} size="sm"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="admin-pw-form" loading={busy}>更新密码</Button></>}>
      <form id="admin-pw-form" className="form" onSubmit={submit} noValidate>
        {field("old", "当前密码", "current-password")}
        {field("next", "新密码", "new-password")}
        {field("confirm", "确认新密码", "new-password")}
      </form>
    </Modal>
  );
}

function QuotaDialog({ user, onClose, onSaved }: { user: api.Account; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(user.quota_bytes ? String(+(user.quota_bytes / GB).toFixed(2)) : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const quota = parseQuota(value);
    if (quota === undefined) { setError("请输入大于 0 的数字，或留空表示不限"); return; }
    setBusy(true);
    try { await api.setAdminUserQuota(user.id, quota); toast.success(`已更新 ${user.username} 的配额`); onSaved(); }
    catch (reason) { setError(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }
  const quota = parseQuota(value);
  return (
    <Modal title={`调整 ${user.username} 的配额`} description={`当前已使用 ${formatBytes(user.used_bytes)}。`} size="sm" onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="quota-form" loading={busy}>保存</Button></>}>
      <form id="quota-form" className="form" onSubmit={submit} noValidate>
        <Field label="容量上限" htmlFor="quota-value" error={error} hint="留空表示不限制。">
          <div className="input-affix"><input id="quota-value" className="input" inputMode="decimal" value={value} onChange={event => { setValue(event.target.value); setError(""); }} autoFocus /><span>GB</span></div>
        </Field>
        {quota && quota < user.used_bytes ? <p className="inline-note tone-warning"><Icon name="alert" size={15} />新配额小于已用空间，用户将无法继续上传，现有文件不受影响。</p> : null}
      </form>
    </Modal>
  );
}

/* ---------- 全部文件 ---------- */

function Objects({ session }: { session: api.Session }) {
  const [page, setPage] = useState<api.AdminObjectPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "public">("all");
  const [preview, setPreview] = useState<api.AdminObject | null>(null);
  const [revoking, setRevoking] = useState<api.AdminObject | null>(null);
  const requestId = useRef(0);
  useDocumentTitle("全部文件 · tgdrive 控制台");
  // 搜索输入防抖后交给服务端筛选，结果按修改时间分页加载。
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search.trim()), 300); return () => window.clearTimeout(timer); }, [search]);
  const load = useCallback(() => {
    const id = ++requestId.current;
    setPage(null);
    void api.adminObjects({ q: query, publicOnly: filter === "public" })
      .then(result => { if (id === requestId.current) setPage(result); })
      .catch(reason => { if (id === requestId.current) { setPage({ objects: [], next_cursor: null, total: 0, public_total: 0 }); toast.error(api.errorMessage(reason, "文件加载失败")); } });
  }, [query, filter]);
  useEffect(load, [load]);
  async function loadMore() {
    if (!page?.next_cursor) return;
    const id = requestId.current;
    setLoadingMore(true);
    try {
      const next = await api.adminObjects({ q: query, publicOnly: filter === "public", cursor: page.next_cursor });
      if (id === requestId.current) setPage(current => current && { ...next, objects: [...current.objects, ...next.objects] });
    } catch (reason) { toast.error(api.errorMessage(reason, "加载失败")); }
    finally { setLoadingMore(false); }
  }
  const objects = page?.objects ?? null;
  const shown = objects ?? [];
  return (
    <>
      <PageHeader title="全部文件" description="所有用户的文件。管理员可以预览、下载，并撤销不当的公开分享。" />
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} onSubmit={() => setQuery(search.trim())} onClear={() => setQuery("")} placeholder="按文件名、路径或用户筛选" label="筛选文件" />
        <Segmented label="筛选" value={filter} onChange={setFilter} options={[{ value: "all", label: "全部" }, { value: "public", label: "公开" }]} />
      </div>
      <section className="file-surface">
        {objects === null ? <SkeletonRows rows={6} /> : shown.length === 0 ? <EmptyState icon={filter === "public" ? "globe" : "box"} title={query || filter === "public" ? "没有匹配的文件" : "还没有文件"} /> : (
          <div className="data-table objects-table" role="table" aria-label="全部文件">
            <div className="data-row data-head" role="row">
              <span role="columnheader">文件</span><span role="columnheader">所有者</span><span role="columnheader">大小</span><span role="columnheader">修改时间</span><span role="columnheader"><span className="sr-only">操作</span></span>
            </div>
            {shown.map(item => {
              const links = item.public_token ? api.publicLinks(item.public_token, baseName(item.key)) : null;
              return (
                <div key={`${item.bucket_id}:${item.key}`} role="row" className="data-row is-clickable" onClick={() => setPreview(item)}>
                  <span role="cell" className="cell-name">
                    <FileTile kind={getFileKind(item.content_type, item.key)} />
                    <span className="name-stack"><button type="button" className="name-button" onClick={event => { event.stopPropagation(); setPreview(item); }}>{baseName(item.key)}</button><small>/{parentPath(item.key)}</small></span>
                    {item.public_token && <Badge tone="public" icon="globe">公开</Badge>}
                  </span>
                  <span role="cell" className="muted">{item.username ?? item.bucket_name}</span>
                  <span role="cell" className="muted">{formatBytes(item.size)}</span>
                  <span role="cell" className="muted" title={formatDateTime(item.modified_at)}>{formatDate(item.modified_at)}</span>
                  <span role="cell" className="cell-actions" onClick={event => event.stopPropagation()}>
                    <Menu label={`${baseName(item.key)} 的操作`} items={[
                      { label: "预览", icon: "eye", onSelect: () => setPreview(item) },
                      { label: "下载", icon: "download", onSelect: () => undefined, href: api.adminContentUrl(item.bucket_id, item.key, true) },
                      ...(links ? [
                        { label: "复制分享链接", icon: "copy" as IconName, onSelect: () => void copyText(links.page, "分享链接已复制") },
                        { label: "撤销公开访问", icon: "lock" as IconName, danger: true, divider: true, onSelect: () => setRevoking(item) },
                      ] : []),
                    ]} />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
      {page && page.total > 0 && (
        <footer className="list-footer">
          <span>已显示 {shown.length.toLocaleString("zh-CN")} / {page.total.toLocaleString("zh-CN")} 个文件{filter === "all" && page.public_total ? `，其中 ${page.public_total.toLocaleString("zh-CN")} 个公开` : ""}</span>
          {page.next_cursor && <Button size="sm" loading={loadingMore} onClick={() => void loadMore()}>加载更多</Button>}
        </footer>
      )}
      {preview && <PreviewModal file={preview} url={api.adminContentUrl(preview.bucket_id, preview.key)} downloadUrl={api.adminContentUrl(preview.bucket_id, preview.key, true)} onClose={() => setPreview(null)} />}
      {revoking && <ConfirmDialog title={`撤销“${baseName(revoking.key)}”的公开访问？`} description={`该文件属于 ${revoking.username ?? revoking.bucket_name}。撤销后原链接立即失效，用户可以重新分享。`} confirmLabel="撤销公开访问"
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          try { await api.setAdminObjectPublic(revoking.bucket_id, revoking.key, false); toast.success("已撤销公开访问"); setRevoking(null); load(); }
          catch (reason) { toast.error(api.errorMessage(reason, "操作失败")); }
        }} />}
    </>
  );
}

/* ---------- 存储通道 ---------- */

function Bots() {
  const [bots, setBots] = useState<api.BotConfig[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [disabling, setDisabling] = useState<api.BotConfig | null>(null);
  const [checking, setChecking] = useState<number | null>(null);
  useDocumentTitle("存储通道 · tgdrive 控制台");
  const load = useCallback(() => { void api.adminBots().then(setBots).catch(reason => { setBots([]); toast.error(api.errorMessage(reason, "存储通道加载失败")); }); }, []);
  useEffect(load, [load]);
  async function setStatus(bot: api.BotConfig, status: "active" | "disabled") {
    try { await api.setAdminBotStatus(bot.id, status); toast.success(status === "active" ? `已启用 ${bot.name}` : `已停用 ${bot.name}`); load(); }
    catch (reason) { toast.error(api.errorMessage(reason, "状态更新失败")); }
  }
  async function check(bot: api.BotConfig, quiet = false) {
    setChecking(bot.id);
    try {
      const result = await api.checkAdminBot(bot.id);
      if (!quiet) result.ok ? toast.success(`${bot.name} 连接正常`) : toast.error(`${bot.name}：${result.status}`);
      load();
    } catch (reason) { toast.error(api.errorMessage(reason, "检查失败")); }
    finally { setChecking(null); }
  }
  const active = (bots ?? []).filter(bot => bot.status === "active").length;
  return (
    <>
      <PageHeader title="存储通道" description="每个通道由一个 Bot 和一个私有频道组成。新文件会加密后分片写入启用中的通道。"
        actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>添加通道</Button>} />
      {bots !== null && active === 0 && <p className="inline-note tone-warning banner"><Icon name="alert" size={16} />当前没有启用的通道，新上传的文件会加密后暂存在服务器本地磁盘。</p>}
      <section className="file-surface">
        {bots === null ? <SkeletonRows rows={3} /> : bots.length === 0 ? (
          <EmptyState icon="send" title="还没有存储通道" description="在 Telegram 中通过 BotFather 创建 Bot，把它设为私有频道的管理员，然后在这里添加。" action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>添加通道</Button>} />
        ) : (
          <div className="data-table bots-table" role="table" aria-label="存储通道">
            <div className="data-row data-head" role="row">
              <span role="columnheader">通道</span><span role="columnheader">频道 ID</span><span role="columnheader">状态</span><span role="columnheader">最近检查</span><span role="columnheader"><span className="sr-only">操作</span></span>
            </div>
            {bots.map(bot => (
              <div key={bot.id} role="row" className="data-row">
                <span role="cell" className="cell-user"><span className={`channel-mark${bot.status === "active" ? " is-active" : ""}`}><Icon name="send" size={16} /></span><span className="name-stack"><strong>{bot.name}</strong><small>添加于 {formatDate(bot.created_at)}</small></span></span>
                <span role="cell"><code className="mono">{bot.channel_id}</code></span>
                <span role="cell">{bot.status === "active" ? <Badge tone="success" dot>启用</Badge> : <Badge dot>已停用</Badge>}</span>
                <span role="cell" className="check-cell">
                  {!bot.last_check_at ? <span className="muted">尚未检查</span>
                    : bot.last_check_status === "ok" ? <Badge tone="success" icon="check">连接正常</Badge>
                      : <Badge tone="danger" icon="alert">连接异常</Badge>}
                  {bot.last_check_at && <small className="muted" title={bot.last_check_status === "ok" ? undefined : bot.last_check_status ?? undefined}>
                    {bot.last_check_status === "ok" ? formatDateTime(bot.last_check_at) : bot.last_check_status}
                  </small>}
                </span>
                <span role="cell" className="cell-actions">
                  <Menu label={`${bot.name} 的操作`} items={[
                    { label: checking === bot.id ? "正在检查…" : "检查连接", icon: "refresh", onSelect: () => void check(bot) },
                    bot.status === "active"
                      ? { label: "停用", icon: "lock", danger: true, divider: true, onSelect: () => setDisabling(bot) }
                      : { label: "启用", icon: "unlock", divider: true, onSelect: () => void setStatus(bot, "active") },
                  ]} />
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      <Panel title="安全说明">
        <ul className="plain-list">
          <li>Bot token 使用主密钥派生的子密钥加密保存，列表和接口不会返回明文。</li>
          <li>私有频道中只保留存储用的 Bot，并关闭不需要的管理员权限。</li>
          <li>停用通道只影响新写入；已经存放在该频道的分片仍会被读取。</li>
        </ul>
      </Panel>
      {creating && <CreateBotDialog onClose={() => setCreating(false)} onCreated={bot => { setCreating(false); void check(bot, true); }} />}
      {disabling && <ConfirmDialog title={`停用 ${disabling.name}？`} description="新文件不会再写入这个通道，已有分片仍可读取。" confirmLabel="停用通道" onClose={() => setDisabling(null)}
        onConfirm={async () => { await setStatus(disabling, "disabled"); setDisabling(null); }} />}
    </>
  );
}

function CreateBotDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (bot: api.BotConfig) => void }) {
  const [form, setForm] = useState({ name: "", token: "", channel: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = "请输入显示名称";
    if (!/^\d+:[\w-]{20,}$/.test(form.token.trim())) next.token = "格式应为 123456789:AA… 的完整 token";
    if (!/^(-100\d+|@\w{4,})$/.test(form.channel.trim())) next.channel = "填写 -100 开头的数字 ID，或 @频道用户名";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const bot = await api.createAdminBot(form.name.trim(), form.token.trim(), form.channel.trim());
      toast.success("存储通道已添加，正在检查连接");
      onCreated(bot);
    }
    catch (reason) { setErrors({ token: api.errorMessage(reason, "添加失败，请检查 token 和频道") }); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="添加存储通道" description="token 保存后只以密文存在，不会再次显示。" icon="send" onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="bot-form" loading={busy}>添加通道</Button></>}>
      <form id="bot-form" className="form" onSubmit={submit} noValidate>
        <Field label="显示名称" htmlFor="bot-name" error={errors.name}>
          <input id="bot-name" className="input" value={form.name} placeholder="例如：主存储" onChange={event => setForm({ ...form, name: event.target.value })} autoFocus />
        </Field>
        <Field label="Bot token" htmlFor="bot-token" error={errors.token} hint="在 Telegram 中向 @BotFather 发送 /newbot 获取。">
          <input id="bot-token" className="input mono" type="password" autoComplete="new-password" value={form.token} onChange={event => setForm({ ...form, token: event.target.value })} />
        </Field>
        <Field label="私有频道" htmlFor="bot-channel" error={errors.channel} hint="Bot 必须是该频道的管理员，并拥有发送消息的权限。">
          <input id="bot-channel" className="input mono" value={form.channel} placeholder="-1001234567890" onChange={event => setForm({ ...form, channel: event.target.value })} />
        </Field>
      </form>
    </Modal>
  );
}

/* ---------- 访问密钥 ---------- */

function Clients() {
  const [clients, setClients] = useState<api.AdminClient[] | null>(null);
  const [owners, setOwners] = useState<Map<number, string>>(new Map());
  const [disabling, setDisabling] = useState<api.AdminClient | null>(null);
  useDocumentTitle("访问密钥 · tgdrive 控制台");
  const load = useCallback(() => {
    void Promise.all([api.adminClients(), api.adminUsers()])
      .then(([items, users]) => { setClients(items); setOwners(new Map(users.map(user => [user.id, user.username]))); })
      .catch(reason => { setClients([]); toast.error(api.errorMessage(reason, "访问密钥加载失败")); });
  }, []);
  useEffect(load, [load]);
  async function setStatus(client: api.AdminClient, status: "active" | "disabled") {
    try { await api.setAdminClientStatus(client.id, status); toast.success(status === "active" ? `已启用 ${client.name}` : `已停用 ${client.name}`); load(); }
    catch (reason) { toast.error(api.errorMessage(reason, "状态更新失败")); }
  }
  return (
    <>
      <PageHeader title="访问密钥" description="用户创建的访问凭据，可用于 HTTP API 和 S3。管理员可以查看归属与授权范围并停用密钥，但看不到 Secret。" />
      <section className="file-surface">
        {clients === null ? <SkeletonRows rows={3} /> : clients.length === 0 ? <EmptyState icon="key" title="还没有访问密钥" description="用户在自己的“访问密钥”页面创建后会显示在这里。" /> : (
          <div className="data-table clients-table" role="table" aria-label="访问密钥">
            <div className="data-row data-head" role="row">
              <span role="columnheader">名称</span><span role="columnheader">所有者</span><span role="columnheader">授权范围</span><span role="columnheader">状态</span><span role="columnheader"><span className="sr-only">操作</span></span>
            </div>
            {clients.map(client => (
              <div key={client.id} role="row" className="data-row">
                <span role="cell" className="name-stack"><strong>{client.name}</strong><small className="mono">{client.keys.map(key => key.access_key_id).join("，") || "无密钥"}</small></span>
                <span role="cell" className="muted">{client.owner_user_id ? owners.get(client.owner_user_id) ?? `用户 ${client.owner_user_id}` : "管理员创建"}</span>
                <span role="cell" className="grant-list">{client.grants.length ? client.grants.map(grant => <Badge key={`${grant.bucket_id}:${grant.prefix}`} tone={grant.perms === "rw" ? "accent" : "neutral"}>{grant.bucket_name}/{grant.prefix || "*"} {grant.perms === "rw" ? "读写" : "只读"}</Badge>) : <span className="muted">无授权</span>}</span>
                <span role="cell">{client.status === "active" ? <Badge tone="success" dot>启用</Badge> : <Badge dot>已停用</Badge>}</span>
                <span role="cell" className="cell-actions">
                  {client.status === "active" ? <Button size="sm" variant="ghost" onClick={() => setDisabling(client)}>停用</Button> : <Button size="sm" onClick={() => void setStatus(client, "active")}>启用</Button>}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      {disabling && <ConfirmDialog title={`停用 ${disabling.name}？`} description="使用该凭据的程序会立即失去访问权限。可以随时重新启用。" confirmLabel="停用" onClose={() => setDisabling(null)}
        onConfirm={async () => { await setStatus(disabling, "disabled"); setDisabling(null); }} />}
    </>
  );
}

/* ---------- 系统设置 ---------- */

function Settings({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<api.SystemSettings | null>(null);
  const [form, setForm] = useState({ public_base_url: "", s3_endpoint: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useDocumentTitle("系统设置 · tgdrive 控制台");
  useEffect(() => {
    void api.adminSettings().then(value => {
      setSettings(value);
      setForm({ public_base_url: value.public_base_url.value ?? "", s3_endpoint: value.s3_endpoint.value ?? "" });
    }).catch(reason => setError(api.errorMessage(reason, "设置加载失败")));
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const saved = await api.updateAdminSettings(form);
      setSettings(saved);
      setForm({ public_base_url: saved.public_base_url.value ?? "", s3_endpoint: saved.s3_endpoint.value ?? "" });
      toast.success("访问地址已保存，立即生效");
      onSaved();
    } catch (reason) { setError(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }
  if (!settings && !error) return <><PageHeader title="系统设置" /><Panel><SkeletonRows rows={3} /></Panel></>;
  const trimmed = (value: string) => value.trim().replace(/\/+$/, "");
  const site = trimmed(form.public_base_url) || settings?.public_base_url.default || api.detectedSiteOrigin();
  const s3 = trimmed(form.s3_endpoint) || settings?.s3_endpoint.default || null;
  const dirty = settings !== null && (form.public_base_url !== (settings.public_base_url.value ?? "") || form.s3_endpoint !== (settings.s3_endpoint.value ?? ""));
  return (
    <>
      <PageHeader title="系统设置" description="用户和外部工具访问 tgdrive 时使用的地址。保存后立即生效，无需重启服务。" />
      <div className="stack">
        <Panel title="访问地址">
          <form className="form settings-form" onSubmit={submit} noValidate>
            <Field label="公开访问地址" htmlFor="setting-site"
              hint={<>用户站点的对外地址，分享链接、HTTP API 和使用文档都以它为基础。{settings?.public_base_url.default
                ? <>留空则使用启动参数中的默认值 <code>{settings.public_base_url.default}</code>。</>
                : <>留空则按访问者当前打开的地址生成。</>}</>}>
              <input id="setting-site" className="input mono" inputMode="url" placeholder="https://drive.example.com" value={form.public_base_url} onChange={event => { setForm({ ...form, public_base_url: event.target.value }); setError(""); }} />
            </Field>
            <Field label="S3 Endpoint" htmlFor="setting-s3"
              hint={<>rclone、AWS CLI 等 S3 客户端连接的地址，必须使用独立的域名。发往这个域名的请求会交给 S3 网关处理。{settings?.s3_endpoint.default
                ? <>留空则使用启动参数中的默认值 <code>{settings.s3_endpoint.default}</code>。</>
                : <>留空时，用户的访问密钥页不显示 Endpoint。</>}</>}>
              <input id="setting-s3" className="input mono" inputMode="url" placeholder="https://s3.example.com" value={form.s3_endpoint} onChange={event => { setForm({ ...form, s3_endpoint: event.target.value }); setError(""); }} />
            </Field>
            {error && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{error}</div>}
            <div className="settings-actions">
              <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>保存</Button>
              {dirty && <Button variant="ghost" onClick={() => settings && setForm({ public_base_url: settings.public_base_url.value ?? "", s3_endpoint: settings.s3_endpoint.value ?? "" })}>放弃修改</Button>}
            </div>
          </form>
        </Panel>
        <Panel title="生效后的地址" description="按当前填写的内容预览，用户看到的链接会是这样。">
          <KeyValue items={[
            ["分享页", <code className="mono">{site}/s/Ab3dE5fG7hJ9kL2m</code>],
            ["文件直链", <code className="mono">{site}/p/Ab3dE5fG7hJ9kL2m/report.pdf</code>],
            ["HTTP API", <code className="mono">{site}/api/v1</code>],
            ["S3", s3 ? <code className="mono">aws --endpoint-url {s3} s3 ls s3://user-2/</code> : <span className="muted">未配置</span>],
          ]} />
        </Panel>
        <Panel title="部署要求">
          <ul className="plain-list">
            <li>两个域名都需要解析到 tgdrive，或由反向代理转发到 API 服务（默认端口 8000）。</li>
            <li>反向代理必须保留原始 <code>Host</code> 请求头：S3 路由按域名区分，签名校验也依赖它。</li>
            <li>公开访问地址需要能访问 <code>/s/</code>、<code>/p/</code> 与 <code>/api/</code> 路径；分享直链支持 Range，代理不要缓冲整个文件。</li>
            <li>修改地址后，已经发出的旧分享链接仍指向旧域名，令牌本身保持有效。</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}

/* ---------- 安全与维护 ---------- */


function Maintenance({ status, onStatus, onLocked }: { status: api.SystemStatus | null; onStatus: (status: api.SystemStatus) => void; onLocked: () => void }) {
  const [locking, setLocking] = useState(false);
  const unlocked = status?.unlocked;
  return (
    <>
      <PageHeader title="安全与维护" description="主密钥状态与存储后台任务。" />
      <div className="stack">
        <Panel title="主密钥" actions={unlocked ? <Badge tone="success" dot>已解锁</Badge> : <Badge tone="warning" dot>已锁定</Badge>}>
          {unlocked ? (
            <div className="key-panel">
              <p>主密钥当前在内存中，用户可以登录，文件与公开链接可以访问。锁定会立即清空内存中的密钥，并登出所有用户和管理员。</p>
              <Button variant="danger" icon="lock" onClick={() => setLocking(true)}>锁定系统</Button>
            </div>
          ) : (
            <div className="key-panel">
              <p>输入初始化时设置的加密口令以解锁系统。</p>
              <UnlockForm onUnlocked={onStatus} />
            </div>
          )}
        </Panel>
        <TasksPanel unlocked={Boolean(unlocked)} />
        <BackupsPanel unlocked={Boolean(unlocked)} />
        {unlocked && <PassphrasePanel />}
        <AuditPanel />
        <Panel title="系统信息">
          <KeyValue items={[["用户数", String(status?.user_count ?? "—")], ["初始化", status?.initialized ? "已完成" : "未完成"], ["用户端地址", <a className="link" href={api.userSiteOrigin()} target="_blank" rel="noreferrer">{api.userSiteOrigin()}</a>]]} />
        </Panel>
      </div>
      {locking && <ConfirmDialog title="锁定系统？" description="所有用户和管理员会被立即登出，公开链接暂停访问，直到再次输入加密口令解锁。" confirmLabel="锁定系统"
        onClose={() => setLocking(false)}
        onConfirm={async () => {
          try { await api.adminLock(); toast.success("系统已锁定"); setLocking(false); onLocked(); }
          catch (reason) { toast.error(api.errorMessage(reason, "锁定失败")); }
        }} />}
    </>
  );
}

const ACTOR_LABEL: Record<api.AuditEvent["actor_type"], string> = { admin: "管理员", user: "用户", key: "访问密钥" };

function auditDetail(event: api.AuditEvent) {
  const detail = event.detail ?? {};
  const parts: string[] = [];
  if (typeof detail.status === "string") parts.push(detail.status === "active" ? "启用" : detail.status === "disabled" ? "停用" : detail.status === "ok" ? "连接正常" : detail.status);
  if ("public" in detail) parts.push(detail.public ? "开启" : "关闭");
  if ("quota_bytes" in detail) parts.push(detail.quota_bytes ? `配额 ${formatBytes(Number(detail.quota_bytes))}` : "不限配额");
  if (typeof detail.name === "string") parts.push(detail.name);
  if (typeof detail.public_base_url === "string" || typeof detail.s3_endpoint === "string") parts.push(Object.entries(detail).map(([key, value]) => `${key === "s3_endpoint" ? "S3" : "公开地址"}：${value || "默认"}`).join("，"));
  if (typeof detail.error === "string") parts.push(`错误：${detail.error}`);
  return parts.join("，");
}

function AuditPanel() {
  const [events, setEvents] = useState<api.AuditEvent[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setEvents(null);
    void api.adminAudit({ failedOnly }).then(page => { setEvents(page.events); setCursor(page.next_cursor); })
      .catch(reason => { setEvents([]); toast.error(api.errorMessage(reason, "审计日志加载失败")); });
  }, [failedOnly]);
  async function loadMore() {
    setLoadingMore(true);
    try {
      const page = await api.adminAudit({ failedOnly, cursor });
      setEvents(current => [...(current ?? []), ...page.events]);
      setCursor(page.next_cursor);
    } catch (reason) { toast.error(api.errorMessage(reason, "加载失败")); }
    finally { setLoadingMore(false); }
  }
  return (
    <Panel title="审计日志" description="登录、权限、密钥、分享与系统设置的变更记录。不会记录密码、口令、token 或 Secret。" flush
      actions={<Segmented label="筛选" value={failedOnly ? "failed" : "all"} onChange={value => setFailedOnly(value === "failed")} options={[{ value: "all", label: "全部" }, { value: "failed", label: "仅失败" }]} />}>
      {events === null ? <SkeletonRows rows={4} /> : events.length === 0 ? <EmptyState icon="shield" title={failedOnly ? "没有失败的操作" : "还没有记录"} /> : (
        <>
          <div className="data-table audit-table" role="table" aria-label="审计日志">
            <div className="data-row data-head" role="row">
              <span role="columnheader">时间</span><span role="columnheader">操作者</span><span role="columnheader">操作</span><span role="columnheader">对象与详情</span><span role="columnheader">结果</span>
            </div>
            {events.map(event => (
              <div key={event.id} role="row" className="data-row">
                <span role="cell" className="muted" title={event.ip ? `来源 IP：${event.ip}` : undefined}>{formatDateTime(event.ts)}</span>
                <span role="cell" className="name-stack"><strong>{event.actor ?? "—"}</strong><small>{ACTOR_LABEL[event.actor_type] ?? event.actor_type}</small></span>
                <span role="cell">{event.label}</span>
                <span role="cell" className="name-stack"><span className="mono audit-target">{event.target ?? ""}</span><small>{auditDetail(event)}</small></span>
                <span role="cell">{event.ok ? <Badge tone="success" dot>成功</Badge> : <Badge tone="danger" dot>失败</Badge>}</span>
              </div>
            ))}
          </div>
          {cursor && <div className="panel-more"><Button size="sm" loading={loadingMore} onClick={() => void loadMore()}>加载更多</Button></div>}
        </>
      )}
    </Panel>
  );
}

function since(seconds?: number) {
  if (!seconds) return "从未运行";
  return formatDateTime(seconds);
}

/** 自动任务每 10 分钟运行一次（完整性校验与备份每天一次）；这里显示最近结果并允许立即运行。 */
function TasksPanel({ unlocked }: { unlocked: boolean }) {
  const [status, setStatus] = useState<api.MaintenanceStatus | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [deep, setDeep] = useState(false);
  const load = useCallback(() => { void api.maintenanceStatus().then(setStatus).catch(() => undefined); }, []);
  useEffect(load, [load]);
  async function run(name: string, action: () => Promise<string>) {
    setRunning(name);
    try { toast.success(await action()); }
    catch (reason) { toast.error(api.errorMessage(reason, "执行失败")); }
    finally { setRunning(null); load(); }
  }
  const outcome = (task?: api.MaintenanceTask, describe?: (task: api.MaintenanceTask) => string) => !task ? <small className="muted">从未运行</small>
    : task.error ? <span className="task-outcome tone-danger"><Icon name="alert" size={14} />{task.error}<span className="muted">{since(task.at)}</span></span>
      : <span className="task-outcome tone-success"><Icon name="check" size={14} />{describe?.(task) ?? "完成"}<span className="muted">{since(task.at)}</span></span>;
  const n = (value: unknown) => Number(value ?? 0);
  return (
    <Panel title="维护任务" description="服务运行时会自动执行：清理与垃圾回收每 10 分钟一次，完整性校验与备份每天一次。系统锁定时暂停。" flush>
      <ul className="task-list">
        <li>
          <span className="attention-icon tone-accent"><Icon name="trash" size={17} /></span>
          <span className="attention-copy">
            <strong>垃圾回收</strong><small>从频道删除已没有文件引用的加密分片。待回收 {status?.gc_pending ?? "—"} 项。</small>
            {outcome(status?.gc, task => `处理 ${n(task.processed)} 项，删除 ${n(task.deleted)} 项${n(task.failed) ? `，${n(task.failed)} 项失败` : ""}`)}
            {status && status.gc_dead > 0 && <span className="task-outcome tone-warning"><Icon name="alert" size={14} />{status.gc_dead} 项多次删除失败后已暂停重试（例如对应的存储通道已不可用）。
              <Button size="sm" variant="ghost" disabled={!unlocked} onClick={() => void run("retry", async () => `已重新排队 ${(await api.retryDeadGc()).requeued} 项`)}>重新尝试</Button></span>}
          </span>
          <Button size="sm" loading={running === "gc"} disabled={!unlocked || running !== null} onClick={() => void run("gc", async () => {
            const result = await api.runAdminGc(500); return `处理 ${result.processed} 项，删除 ${result.deleted} 项`;
          })}>立即运行</Button>
        </li>
        <li>
          <span className="attention-icon tone-accent"><Icon name="upload" size={17} /></span>
          <span className="attention-copy">
            <strong>清理未完成的上传</strong><small>回收 7 天未继续的分段上传，以及服务中断时遗留的临时数据。</small>
            {outcome(status?.cleanup, task => `中止 ${n(task.aborted_uploads)} 个上传，清理 ${n(task.stale_blobs)} 份临时数据`)}
          </span>
          <Button size="sm" loading={running === "cleanup"} disabled={!unlocked || running !== null} onClick={() => void run("cleanup", async () => {
            const result = await api.runCleanup(); return `中止 ${result.aborted_uploads} 个上传，清理 ${result.stale_blobs} 份临时数据`;
          })}>立即运行</Button>
        </li>
        <li>
          <span className="attention-icon tone-accent"><Icon name="checkCircle" size={17} /></span>
          <span className="attention-copy">
            <strong>完整性校验</strong><small>下载分片并校验哈希；每次从上次停下的位置继续，所有文件轮流被检查。</small>
            {outcome(status?.scrub, task => n(task.bad) ? `检查 ${n(task.checked)} 个文件，发现 ${n(task.bad)} 个损坏` : `检查 ${n(task.checked)} 个文件，全部完好${task.wrapped ? "（已完成一轮）" : ""}`)}
            <Switch checked={deep} onChange={setDeep} label="深度校验" description="手动运行时同时解密分片内容，耗时更长。" />
          </span>
          <Button size="sm" loading={running === "scrub"} disabled={!unlocked || running !== null} onClick={() => void run("scrub", async () => {
            const result = await api.runAdminScrub(100, deep);
            return result.bad.length ? `发现 ${result.bad.length} 个损坏的文件` : `检查 ${result.checked} 个文件，全部完好`;
          })}>立即运行</Button>
        </li>
        <li>
          <span className="attention-icon tone-accent"><Icon name="refresh" size={17} /></span>
          <span className="attention-copy">
            <strong>清理回收站</strong><small>永久删除在回收站中超过 30 天的文件。</small>
            {outcome(status?.trash, task => `永久删除 ${n(task.purged)} 项`)}
          </span>
        </li>
      </ul>
    </Panel>
  );
}

function BackupsPanel({ unlocked }: { unlocked: boolean }) {
  const [backups, setBackups] = useState<api.Backup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void api.listBackups().then(setBackups).catch(() => setBackups([])); }, []);
  useEffect(load, [load]);
  async function create() {
    setBusy(true);
    try { const backup = await api.createBackup(); toast.success(`已创建备份 ${backup.name}`); load(); }
    catch (reason) { toast.error(api.errorMessage(reason, "备份失败")); }
    finally { setBusy(false); }
  }
  return (
    <Panel title="元数据备份" description="数据库记录了每个文件对应的频道消息与加密密钥，丢失后频道中的数据将无法读取。系统每天自动备份一次，保留最近 14 份。"
      actions={<Button size="sm" icon="plus" loading={busy} disabled={!unlocked} onClick={() => void create()}>立即备份</Button>} flush>
      {backups === null ? <SkeletonRows rows={2} /> : backups.length === 0 ? <EmptyState icon="shield" title="还没有备份" description="解锁后系统会自动创建第一份备份。" /> : (
        <div className="data-table backups-table" role="table" aria-label="备份">
          <div className="data-row data-head" role="row"><span role="columnheader">备份文件</span><span role="columnheader">大小</span><span role="columnheader">创建时间</span><span role="columnheader"><span className="sr-only">操作</span></span></div>
          {backups.map(backup => (
            <div key={backup.name} role="row" className="data-row">
              <span role="cell" className="mono">{backup.name}</span>
              <span role="cell" className="muted">{formatBytes(backup.size)}</span>
              <span role="cell" className="muted">{formatDateTime(backup.created_at)}</span>
              <span role="cell" className="cell-actions"><a className="btn btn-ghost btn-sm" href={api.backupUrl(backup.name)} download><Icon name="download" size={15} /><span>下载</span></a></span>
            </div>
          ))}
        </div>
      )}
      <div className="panel-note">
        <p>备份已用加密口令加密，可以放在其他机器或网盘。请把备份保存在服务器以外的地方。恢复时先停止服务，然后执行：</p>
        <div className="code-block"><pre><code>tgdrive restore tgdrive-20261007-030000.tgdbak --data-dir /var/lib/tgdrive</code></pre></div>
        <p className="muted">恢复需要输入<strong>创建该备份时</strong>的加密口令。原数据库会被保留为 meta.db.before-restore-*，不会被覆盖。</p>
      </div>
    </Panel>
  );
}

function PassphrasePanel() {
  const [form, setForm] = useState({ old: "", next: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!form.old) next.old = "请输入当前加密口令";
    if (form.next.length < 12) next.next = "新口令至少 12 个字符";
    else if (form.next !== form.confirm) next.confirm = "两次输入的口令不一致";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const result = await api.changePassphrase(form.old, form.next);
      setForm({ old: "", next: "", confirm: "" });
      toast.success(`加密口令已更换，重新加密了 ${result.rewrapped_files} 个文件的密钥`);
    } catch (reason) {
      setErrors(reason instanceof api.ApiError && reason.code === "wrong_passphrase" ? { old: "当前口令不正确" } : { form: api.errorMessage(reason, "更换失败") });
    } finally { setBusy(false); }
  }
  const field = (key: keyof typeof form, label: string) => (
    <Field label={label} htmlFor={`pass-${key}`} error={errors[key]}>
      <input id={`pass-${key}`} className="input" type="password" autoComplete={key === "old" ? "current-password" : "new-password"}
        value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} />
    </Field>
  );
  return (
    <Panel title="更换加密口令" description="重新加密所有文件密钥、访问密钥 Secret 与 Bot token，频道中的数据无需改动。更换后旧口令立即失效。">
      <form className="form passphrase-form" onSubmit={submit} noValidate>
        {field("old", "当前加密口令")}
        <div className="form-row">{field("next", "新加密口令")}{field("confirm", "确认新口令")}</div>
        {errors.form && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{errors.form}</div>}
        <p className="inline-note tone-warning"><Icon name="alert" size={15} />之前的备份仍需用当时的旧口令恢复。新口令同样无法找回，请先保存到密码管理器。</p>
        <div><Button type="submit" variant="primary" loading={busy}>更换口令</Button></div>
      </form>
    </Panel>
  );
}
