import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BRAND } from "./brand";
import * as api from "./api";
import { type CacheStats, cacheStats, cacheSupported, startLocalCache } from "./cache-client";
import { DocsPage } from "./docs/docs";

import { SharePage } from "./share";
import { ADMIN_MODULES, AdminConsole, AdminDocsGate, LockedGate, type AdminModule } from "./admin";
import { AppShell, FullPageLoading, LoginPage, SetupPage, isPlainClick, useSessionGuard, type NavGroup } from "./shell";
import { Notice, Button, ButtonLink, Icon, Progress, formatBytes, toast, usageTone, useDocumentTitle, type IconName } from "./ui";

import { FilesView } from "./user/files";
import { PrivateSpaceView } from "./user/private";
import { UploadTray, useUploadQueue } from "./user/uploads";

import { SharedView } from "./user/shared";
import { TrashView } from "./user/trash";
import { DownloadsView } from "./user/downloads";
import { DownloadTray } from "./user/download-tray";
import { PreviewHost } from "./user/preview-host";
import { CacheTasksProvider, CacheTray } from "./user/cache";
import { AssistantDock, AssistantDrawer, AssistantLauncher, useAssistantConfig, useAssistantShortcut } from "./user/assistant";
import { takePageImportRequest, usePageImport } from "./user/page-import";
import { PrivateSessionProvider } from "./user/private-session";
import { EmailDialog, UserSettingsPage } from "./user/account";
import { onThemeChange, setThemePreference, themePreference, type ThemePreference } from "./theme";

/* ---------- 路由 ---------- */

/**
 * 整个站点是同一个应用：所有账号从同一个登录页进入，侧栏菜单和可访问的页面由账号角色决定。
 * 管理员除了自己的文件空间，还有「系统管理」分组（/admin/...）；普通用户看不到这些菜单，
 * 直接输入地址也只会看到“没有访问权限”，并且所有管理接口都会在服务端按角色拒绝。
 */
export function App() {
  const path = window.location.pathname;
  if (path === "/docs" || path.startsWith("/docs/")) return <DocsEntry />;
  const share = path.match(/^\/s\/([A-Za-z0-9_-]+)/);
  if (share) return <SharePage token={share[1]} />;
  if (/^\/admin\/docs(?:\/|$)/.test(path)) {
    // 旧的管理员文档地址：现在所有人共用 /docs，管理员会在其中多看到管理员专属的几页。
    window.location.replace(path.replace(/^\/admin\/docs/, "/docs") + window.location.search);
    return <FullPageLoading label="正在跳转到文档" />;
  }
  return <Workspace />;
}

function AccessDenied() {
  useDocumentTitle(`没有访问权限 · ${BRAND}`);
  return (
    <div className="locked-gate">
      <span className="locked-icon"><Icon name="lock" size={26} /></span>
      <h1>没有访问权限</h1>
      <p>这个页面只对管理员开放。如果你需要使用它，请联系管理员。</p>
      <ButtonLink variant="secondary" size="md" href="/">回到我的文件</ButtonLink>
    </div>
  );
}

/**
 * 文档页：所有人共用 /docs。未登录和普通用户看到用户文档；管理员会话会改为加载管理员文档，
 * 其中多出部署、运维等专属页面。这部分代码只能由管理员会话从受保护的接口取得，普通用户拿不到。
 */
function DocsEntry() {
  const [role, setRole] = useState<api.Role | null | undefined>(undefined);  // undefined：检查中，null：未登录
  useEffect(() => { void api.restoreSession().then(session => setRole(session.role)).catch(() => setRole(null)); }, []);
  if (role === undefined) return <FullPageLoading label="正在打开文档" />;
  return role === "admin" ? <AdminDocsGate onFailed={() => setRole(null)} /> : <DocsPage />;
}

/** 系统锁定期间，普通用户只能等待管理员解锁。 */
function UnavailableGate() {
  useDocumentTitle(`服务暂时不可用 · ${BRAND}`);
  return (
    <div className="locked-gate">
      <span className="locked-icon"><Icon name="lock" size={26} /></span>
      <h1>服务暂时不可用</h1>
      <p>系统刚刚重启，需要管理员输入加密口令后才能继续使用。请稍后再试，或联系管理员。</p>
      <Button onClick={() => window.location.reload()}>重新检查</Button>
    </div>
  );
}

function Workspace() {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [setupDone, setSetupDone] = useState(false);
  useEffect(() => { void api.adminStatus().then(status => setInitialized(status.initialized)).catch(() => setInitialized(true)); }, []);
  if (initialized === null) return <FullPageLoading label={`正在打开 ${BRAND}`} />;
  if (!initialized) return <SetupPage onComplete={() => { setInitialized(true); setSetupDone(true); }} />;
  return <WorkspaceSession justInitialized={setupDone} />;
}

function WorkspaceSession({ justInitialized }: { justInitialized: boolean }) {
  const { session, setSession, checking } = useSessionGuard(api.restoreSession);
  if (checking) return <FullPageLoading label="正在恢复登录状态" />;
  if (!session) return <LoginPage onSuccess={value => { setSession(value); void api.restoreSession().then(setSession).catch(() => undefined); }}
    notice={justInitialized ? <Notice tone="success">初始化完成，系统已解锁。请使用刚创建的管理员账号登录。</Notice> : undefined} />;
  return <MainShell session={session} onLogout={() => setSession(null)}
    onSessionChange={patch => setSession(current => current && { ...current, ...patch })} />;
}

type UserSection = "files" | "shared" | "trash" | "private" | "downloads" | "account" | "assistantPage";
type Section = UserSection | AdminModule;
type Usage = { used_bytes: number; quota_bytes: number | null; id: number };

const ADMIN_KEYS: readonly string[] = ADMIN_MODULES.map(item => item.key);
const isAdminSection = (section: Section): section is AdminModule => ADMIN_KEYS.includes(section);

function readLocation(): { section: Section; prefix: string } {
  const { pathname, search } = window.location;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    const module = pathname.split("/")[2] ?? "";
    return { section: ADMIN_KEYS.includes(module) ? module as AdminModule : "overview", prefix: "" };
  }
  const params = new URLSearchParams(search);
  const view = params.get("view");
  // 文件助手全页：prefix 字段沿用为对话编号（?view=assistant&c=<对话>）。
  if (view === "assistant") return { section: "assistantPage", prefix: params.get("c") ?? "" };
  // 用户设置分「账号」「访问密钥」「本机缓存」三个标签页，prefix 字段沿用为标签名；旧地址 ?view=keys 打开访问密钥标签。
  if (view === "account" || view === "keys") return { section: "account", prefix: view === "keys" ? "keys" : params.get("tab") === "keys" || params.get("tab") === "cache" ? params.get("tab")! : "" };
  return { section: view === "shared" || view === "trash" || view === "private" || view === "downloads" ? view : "files", prefix: view === "private" ? api.PRIVATE_PREFIX + (params.get("path") ?? "") : params.get("path") ?? "" };
}

function sectionUrl(section: Section, prefix = "") {
  if (isAdminSection(section)) return section === "overview" ? "/admin" : `/admin/${section}`;
  const params = new URLSearchParams();
  if (section !== "files") params.set("view", section === "assistantPage" ? "assistant" : section);
  if ((section === "files" || section === "private") && prefix) params.set("path", section === "private" ? prefix.replace(api.PRIVATE_PREFIX, "") : prefix);
  if (section === "assistantPage" && prefix) params.set("c", prefix);
  if (section === "account" && (prefix === "keys" || prefix === "cache")) params.set("tab", prefix);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

/** 侧栏容量：点开按「用户数据」（我的文件、回收站、私密空间）与「系统数据」（缩略图、助手附件）分组显示，两者都计入配额；
 * 另列「本机缓存」（这台设备浏览器里的副本，不计入配额，也不参与上方占比条），点「管理」进入用户设置。 */
function StorageMeter({ usage, percent, onOpenCache }: { usage: Usage | null; percent: number; onOpenCache: () => void }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<api.StorageUsage | null>(null);
  const [local, setLocal] = useState<CacheStats | null>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api.storageUsage().then(value => { if (alive) setDetail(value); }).catch(() => undefined);
    const readLocal = () => { if (cacheSupported()) void cacheStats().then(value => { if (alive) setLocal(value); }).catch(() => { if (alive) setLocal(null); }); };
    readLocal();
    window.addEventListener("tessera:cache-changed", readLocal);
    return () => { alive = false; window.removeEventListener("tessera:cache-changed", readLocal); };
  }, [open, usage?.used_bytes]);
  type Row = [string, IconName, number];
  const groups: { label: string; hint: string; rows: Row[] }[] = detail ? [
    { label: "用户数据", hint: "你保存的文件", rows: [["我的文件", "folder", detail.files], ["回收站", "trash", detail.trash], ["私密空间", "lock", detail.private]] },
    { label: "系统数据", hint: "自动生成的缩略图与文件助手对话附件", rows: [["缩略图", "image", detail.thumbnails ?? 0], ["助手附件", "paperclip", detail.assistant]] },
  ] : [];
  const total = groups.reduce((sum, group) => sum + group.rows.reduce((value, row) => value + row[2], 0), 0);
  return <div className={`storage-meter${open ? " is-open" : ""}`} title={usage?.quota_bytes == null ? "未设置空间配额" : undefined}>
    <button type="button" className="storage-meter-head" aria-expanded={open} aria-controls={`${id}-detail`} onClick={() => setOpen(value => !value)}>
      <span>已用空间<Icon name="chevronDown" size={12} /></span><strong>{formatBytes(usage?.used_bytes ?? 0)}</strong></button>
    {usage?.quota_bytes != null && <>
      {usage.quota_bytes > 0 && <Progress value={percent} tone={usageTone(percent)} label="存储使用率" />}
      <p>{usage.quota_bytes > 0 ? `共 ${formatBytes(usage.quota_bytes)} · ${Math.round(percent)}%` : "配额为 0，无法上传"}</p>
    </>}
    {open && <div id={`${id}-detail`} className="storage-meter-detail" aria-label="已用空间分项">
      {!detail ? <p className="storage-meter-loading">正在统计…</p> : <>
        {total > 0 && <div className="storage-split" aria-hidden="true">{groups.map((group, index) => {
          const size = group.rows.reduce((value, row) => value + row[2], 0);
          return size > 0 ? <span key={group.label} className={`is-${index ? "system" : "user"}`} style={{ flexGrow: size }} /> : null;
        })}</div>}
        {groups.map((group, index) => <section key={group.label} className="storage-group" title={group.hint}>
          <h4><i className={`storage-dot is-${index ? "system" : "user"}`} aria-hidden="true" /><span>{group.label}</span><strong>{formatBytes(group.rows.reduce((value, row) => value + row[2], 0))}</strong></h4>
          <ul>{group.rows.map(([label, icon, size]) => <li key={label}><Icon name={icon} size={12} /><span>{label}</span><strong>{formatBytes(size)}</strong></li>)}</ul>
        </section>)}
        {local && <section className="storage-group storage-local" title="这台设备的浏览器保存的加密副本，不计入空间配额">
          <h4><Icon name="monitor" size={12} /><span>本机缓存</span><strong>{formatBytes(local.normal.bytes + local.private.bytes)}</strong></h4>
          <ul>
            <li><Icon name="folder" size={12} /><span>普通文件</span><strong>{formatBytes(local.normal.bytes)}</strong></li>
            {(local.private.count > 0 || local.settings.private) && <li><Icon name="lock" size={12} /><span>私密文件</span><strong>{formatBytes(local.private.bytes)}</strong></li>}
          </ul>
          <p className="storage-local-note">{local.settings.enabled && local.policy?.enabled !== false ? "不计入配额" : "已关闭"} · <button type="button" className="link-button" onClick={onOpenCache}>管理</button></p>
        </section>}
      </>}
    </div>}
  </div>;
}

/** 系统管理的菜单：概览单独一组（无标题），其余按 ADMIN_MODULES 的 group 依次分组。 */
function adminGroups(): NavGroup<Section>[] {
  const result: NavGroup<Section>[] = [];
  for (const { group, ...item } of ADMIN_MODULES) {
    const last = result[result.length - 1];
    if (last && last.label === group) last.items.push(item);
    else result.push({ label: group, workspace: "系统管理", items: [item] });
  }
  return result;
}

function MainShell({ session, onLogout, onSessionChange }: { session: api.Session; onLogout: () => void; onSessionChange: (patch: Partial<api.Session>) => void }) {
  const isAdmin = session.role === "admin";
  const [location, setLocation] = useState(readLocation);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sharedCount, setSharedCount] = useState<number | undefined>();
  const [theme, setTheme] = useState<ThemePreference>(themePreference);
  useEffect(() => onThemeChange(setTheme), []);
  // 浏览器本地缓存（docs/client-cache-design.md）：登录后注册 Service Worker，不支持的浏览器保持现状。
  useEffect(() => startLocalCache(), []);
  const [status, setStatus] = useState<api.SystemStatus | null>(null);
  const [, setConfigVersion] = useState(0);
  const [uploadRevision, setUploadRevision] = useState(0);
  const [downloadRevision, setDownloadRevision] = useState(0);
  const refreshTimer = useRef<number | undefined>();
  const refreshUsage = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      void api.me().then(value => setUsage({ used_bytes: value.used_bytes, quota_bytes: value.quota_bytes, id: value.id })).catch(() => undefined);
      void api.listPublicPage(null, 1).then(page => setSharedCount(page.total)).catch(() => undefined);
    }, 300);
  }, []);
  const uploads = useUploadQueue(() => { setUploadRevision(revision => revision + 1); refreshUsage(); });
  useEffect(() => () => window.clearTimeout(refreshTimer.current), []);
  // 只有管理员需要系统状态（是否已解锁、流量统计）；普通用户在系统锁定时根本无法登录。
  const refreshStatus = useCallback(() => {
    if (isAdmin) void api.adminStatus().then(setStatus).catch(reason => toast.error(api.errorMessage(reason, "系统状态加载失败，请稍后重试")));
  }, [isAdmin]);
  useEffect(refreshUsage, [refreshUsage]);
  useEffect(refreshStatus, [refreshStatus]);
  useEffect(() => {
    const pop = () => setLocation(readLocation());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const navigate = useCallback((section: Section, prefix = "") => {
    window.history.pushState(null, "", sectionUrl(section, prefix));
    setLocation({ section, prefix: section === "private" ? (api.isPrivatePath(prefix) ? prefix : api.PRIVATE_PREFIX + prefix) : prefix });
    document.getElementById("main")?.scrollTo?.({ top: 0 });
  }, []);
  async function logout() {
    uploads.cancelAll();
    await api.logout().catch(() => undefined);
    onLogout();
  }
  const locked = isAdmin && status !== null && !status.unlocked;
  useEffect(() => { if (locked || session.unlocked === false && !isAdmin) uploads.cancelAll(); }, [locked, session.unlocked, isAdmin]);
  const percent = usage?.quota_bytes ? usage.used_bytes / usage.quota_bytes * 100 : 0;
  // 文件助手：管理员启用且对该账号开放时才显示入口；系统锁定或服务未解锁时关闭。
  const assistantReady = !locked && !(!isAdmin && session.unlocked === false) && !(isAdmin && status === null);
  const assistant = useAssistantConfig(assistantReady);
  const assistantAvailable = Boolean(assistant.config?.available);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const assistantPage = location.section === "assistantPage";
  const toggleAssistant = useCallback(() => { if (!assistantPage) setAssistantOpen(value => !value); }, [assistantPage]);
  useAssistantShortcut(assistantAvailable, toggleAssistant);
  useEffect(() => { if (!assistantAvailable) setAssistantOpen(false); }, [assistantAvailable]);
  useEffect(() => { if (assistantPage) setAssistantOpen(false); }, [assistantPage]);
  // 抓取脚本「发给文件助手」：收到页面快照后打开助手，由用户确认发送。
  const [pageImportRequest] = useState(takePageImportRequest);
  const [pageImport, clearPageImport] = usePageImport(pageImportRequest);
  useEffect(() => { if (pageImport && assistantAvailable && !assistantPage) setAssistantOpen(true); }, [Boolean(pageImport), assistantAvailable]);
  const filesChanged = useCallback(() => { setUploadRevision(value => value + 1); setDownloadRevision(value => value + 1); refreshUsage(); }, [refreshUsage]);
  const unlocked = () => { refreshStatus(); refreshUsage(); };
  const section = location.section;
  // 文件空间可用时才保留预览和下载托盘；系统锁定、服务未解锁时一并关闭。
  const workspaceReady = !locked && !(!isAdmin && session.unlocked === false) && !(isAdmin && status === null);
  let content: ReactNode;
  if (section === "assistantPage") {
    content = !assistantAvailable || !assistant.config ? (assistant.config ? <AccessDenied /> : <FullPageLoading label="正在读取文件助手" />)
      : <AssistantDrawer mode="page" open config={assistant.config} onClose={() => navigate("files")} onConfigChanged={assistant.refresh}
          location={{ view: "assistant", prefix: "" }} initialConversation={location.prefix || null} onFilesChanged={filesChanged}
          pageImport={pageImport} onPageImportDone={clearPageImport}
          onConversationChange={id => { if ((id ?? "") !== (new URLSearchParams(window.location.search).get("c") ?? "")) window.history.replaceState(null, "", sectionUrl("assistantPage", id ?? "")); }} />;
  } else if (section === "account") {
    content = <UserSettingsPage session={session} onSessionChange={onSessionChange} assistant={assistantAvailable} onOpenConversation={id => navigate("assistantPage", id)}
      tab={location.prefix === "keys" || location.prefix === "cache" ? location.prefix : "account"} onTabChange={tab => navigate("account", tab === "account" ? "" : tab)}
      bucketName={usage ? `user-${usage.id}` : null} keysAvailable={workspaceReady && !locked} />;
  } else if (isAdminSection(section)) {
    if (!isAdmin) content = <AccessDenied />;
    else if (status === null) content = <FullPageLoading label="正在读取系统状态" />;
    else content = <AdminConsole module={section} session={session} status={status} onStatus={setStatus} onRefreshStatus={unlocked}
      onNavigate={navigate} onLocked={onLogout} onConfigSaved={() => setConfigVersion(version => version + 1)} />;
  } else if (!isAdmin && session.unlocked === false) {
    // 服务刚重启、管理员还没有解锁：保持登录的普通用户进来后看到的是说明，而不是一连串错误。
    content = <UnavailableGate />;
  } else if (isAdmin && status === null) {
    // 状态未知时不渲染文件页，避免锁定状态下先发出一批 503 请求。
    content = <FullPageLoading label="正在读取系统状态" />;
  } else if (locked) {
    content = <LockedGate onUnlocked={unlocked} />;
  } else {
    content = <>
      {section === "files" && <FilesView session={session} prefix={location.prefix} uploads={uploads} uploadRevision={uploadRevision} onOpenFolder={prefix => navigate("files", prefix)} onChanged={refreshUsage} />}
      {section === "private" && <PrivateSpaceView session={session} prefix={location.prefix} uploads={uploads} uploadRevision={uploadRevision} onOpenFolder={path => navigate("private", path)} onChanged={refreshUsage} />}
      {section === "shared" && <SharedView session={session} onChanged={refreshUsage} onOpenFolder={prefix => navigate("files", prefix)} />}
      {section === "downloads" && <DownloadsView onChanged={refreshUsage} onOpenFolder={(prefix, privateSpace) => navigate(privateSpace ? "private" : "files", prefix)} onCreated={() => setDownloadRevision(value => value + 1)} />}
      {section === "trash" && <TrashView onChanged={refreshUsage} onOpenFolder={prefix => navigate("files", prefix)} />}
    </>;
  }
  // 个人空间与系统管理都按用途分组；管理员在两个工作区之间切换，侧栏只显示当前工作区的分组。
  const personalWorkspace = isAdmin ? "我的空间" : undefined;
  const groups: NavGroup<Section>[] = [
    { label: "文件", workspace: personalWorkspace, items: [
      { key: "files", label: "我的文件", icon: "folder" },
      { key: "private", label: "私密空间", icon: "lock" },
      { key: "trash", label: "回收站", icon: "trash" },
    ] },
    { label: "分享与传输", workspace: personalWorkspace, items: [
      { key: "shared", label: "公开分享", icon: "globe", count: sharedCount },
      { key: "downloads", label: "下载任务", icon: "download" },
    ] },
    ...(isAdmin ? adminGroups() : []),
  ];
  return (
    <AppShell active={section} onNavigate={key => navigate(key)} hrefFor={key => sectionUrl(key)} groups={groups}
      workspaces={isAdmin ? [{ label: "我的空间", icon: "folder" }, { label: "系统管理", icon: "shield" }] : []}
      sidebarAction={assistantAvailable ? <AssistantLauncher open={assistantOpen || assistantPage} onOpen={toggleAssistant} /> : undefined}
      links={[{ label: "使用文档", icon: "book", href: "/docs" }]}
      sidebarFooter={<>
        {/* 系统正常时不占位置；只有锁定（或状态读取中）才提示，点击进入安全与维护。 */}
        {isAdmin && locked && (
          <a className="system-chip is-locked" href={sectionUrl("maintenance")} onClick={event => { if (isPlainClick(event)) { event.preventDefault(); navigate("maintenance"); } }}>
            <Icon name="lock" size={15} />
            <span><strong>系统已锁定</strong><small>输入加密口令后继续使用</small></span>
          </a>
        )}
        <StorageMeter usage={usage} percent={percent} onOpenCache={() => navigate("account", "cache")} />
      </>}
      account={{ name: api.displayName(session), caption: isAdmin ? "管理员" : "个人空间", tone: isAdmin ? "admin" : "accent", avatar: api.avatarUrl(session.avatar_version), menu: [
        // 用户设置（含访问密钥）从头像菜单进入，不占侧栏位置。
        { label: "用户设置", icon: "settings", onSelect: () => navigate("account") },
        { label: "访问密钥", icon: "key", onSelect: () => navigate("account", "keys") },
        { label: "跟随系统", icon: "monitor", heading: "外观", divider: true, checked: theme === "system", onSelect: () => setThemePreference("system") },
        { label: "浅色", icon: "sun", checked: theme === "light", onSelect: () => setThemePreference("light") },
        { label: "深色", icon: "moon", checked: theme === "dark", onSelect: () => setThemePreference("dark") },
        { label: "退出登录", icon: "logout", onSelect: () => void logout(), divider: true },
      ] }}>
      <PrivateSessionProvider enabled={workspaceReady}>
      <CacheTasksProvider enabled={workspaceReady} privateAllowed={section === "private"}>
      <PreviewHost enabled={workspaceReady} privateAllowed={section === "private"}>
        {content}
      <div className="tray-stack">
        {workspaceReady && <DownloadTray hidden={section === "downloads"} revision={downloadRevision} onOpenTasks={() => navigate("downloads")}
          onOpenFolder={(prefix, privateSpace) => navigate(privateSpace ? "private" : "files", prefix)} onCompleted={refreshUsage} />}
        <UploadTray queue={uploads} />
        <CacheTray />
      </div>
      {/* 私密空间页面已解锁时显示私密对话（§24.8），其他页面显示普通对话。 */}
      {assistantAvailable && assistant.config && !assistantPage && <AssistantDock open={assistantOpen} config={assistant.config} onClose={() => setAssistantOpen(false)}
        onConfigChanged={assistant.refresh} location={{ view: section, prefix: section === "files" || section === "private" ? location.prefix : "" }}
        onFilesChanged={filesChanged} pageImport={pageImport} onPageImportDone={clearPageImport} onNavigate={(view, prefix) => navigate(view, prefix ?? "")}
        onOpenPage={id => { setAssistantOpen(false); navigate("assistantPage", id ?? ""); }} />}
      {/* 助手抽屉也在预览宿主内：消息里的附件图片直接打开预览。 */}
      </PreviewHost>
      </CacheTasksProvider>
      {/* 旧版用户名账号：登录后必须先设置邮箱（之后用邮箱登录，也为邮箱验证做准备）。 */}
      {session.needs_email && <EmailDialog session={session} required onSaved={onSessionChange} onLogout={() => void logout()} />}
      </PrivateSessionProvider>
    </AppShell>
  );
}

