import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BRAND } from "./brand";
import * as api from "./api";
import { DocsPage } from "./docs/docs";

import { SharePage } from "./share";
import { ADMIN_MODULES, AdminConsole, AdminDocsGate, LockedGate, type AdminModule } from "./admin";
import { AppShell, FullPageLoading, LoginPage, SetupPage, isPlainClick, useSessionGuard, type NavGroup } from "./shell";
import { Icon, Progress, formatBytes, toast, usageTone, useDocumentTitle } from "./ui";

import { FilesView } from "./user/files";
import { PrivateSpaceView } from "./user/private";
import { UploadTray, useUploadQueue } from "./user/uploads";

import { SharedView } from "./user/shared";
import { TrashView } from "./user/trash";
import { KeysView } from "./user/keys";
import { DownloadsView } from "./user/downloads";
import { DownloadTray } from "./user/download-tray";
import { PreviewHost } from "./user/preview-host";
import { AssistantDrawer, AssistantLauncher, useAssistantConfig, useAssistantShortcut } from "./user/assistant";
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
      <a className="btn btn-secondary btn-md" href="/">回到我的文件</a>
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
      <button type="button" className="btn btn-secondary btn-md" onClick={() => window.location.reload()}>重新检查</button>
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
    notice={justInitialized ? <p className="inline-note tone-success"><Icon name="checkCircle" size={15} />初始化完成，系统已解锁。请使用刚创建的管理员账号登录。</p> : undefined} />;
  return <MainShell session={session} onLogout={() => setSession(null)}
    onSessionChange={patch => setSession(current => current && { ...current, ...patch })} />;
}

type UserSection = "files" | "shared" | "trash" | "keys" | "private" | "downloads" | "account" | "assistantPage";
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
  return { section: view === "shared" || view === "keys" || view === "trash" || view === "private" || view === "downloads" || view === "account" ? view : "files", prefix: view === "private" ? api.PRIVATE_PREFIX + (params.get("path") ?? "") : params.get("path") ?? "" };
}

function sectionUrl(section: Section, prefix = "") {
  if (isAdminSection(section)) return section === "overview" ? "/admin" : `/admin/${section}`;
  const params = new URLSearchParams();
  if (section !== "files") params.set("view", section === "assistantPage" ? "assistant" : section);
  if ((section === "files" || section === "private") && prefix) params.set("path", section === "private" ? prefix.replace(api.PRIVATE_PREFIX, "") : prefix);
  if (section === "assistantPage" && prefix) params.set("c", prefix);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function MainShell({ session, onLogout, onSessionChange }: { session: api.Session; onLogout: () => void; onSessionChange: (patch: Partial<api.Session>) => void }) {
  const isAdmin = session.role === "admin";
  const [location, setLocation] = useState(readLocation);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sharedCount, setSharedCount] = useState<number | undefined>();
  const [theme, setTheme] = useState<ThemePreference>(themePreference);
  useEffect(() => onThemeChange(setTheme), []);
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
    content = <UserSettingsPage session={session} onSessionChange={onSessionChange} />;
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
      {section === "keys" && <KeysView bucketName={usage ? `user-${usage.id}` : null} />}
      {section === "downloads" && <DownloadsView onChanged={refreshUsage} onOpenFolder={(prefix, privateSpace) => navigate(privateSpace ? "private" : "files", prefix)} onCreated={() => setDownloadRevision(value => value + 1)} />}
      {section === "trash" && <TrashView onChanged={refreshUsage} onOpenFolder={prefix => navigate("files", prefix)} />}
    </>;
  }
  const personal: NavGroup<Section> = { label: isAdmin ? "我的空间" : undefined, workspace: isAdmin, icon: "folder", items: [
    { key: "files", label: "我的文件", icon: "folder" },
    { key: "private", label: "私密空间", icon: "lock" },
    { key: "shared", label: "公开分享", icon: "globe", count: sharedCount },
    { key: "downloads", label: "下载任务", icon: "download" },
    { key: "trash", label: "回收站", icon: "trash" },
    { key: "keys", label: "访问密钥", icon: "key" },
    { key: "account", label: "用户设置", icon: "settings" },
  ] };
  const groups: NavGroup<Section>[] = [
    personal,
    ...(isAdmin ? [{ label: "系统管理", workspace: true, icon: "shield" as const, items: ADMIN_MODULES }] : []),
    { label: "帮助", items: [{ key: "docs" as Section, label: "使用文档", icon: "book", href: "/docs" }] },
  ];
  return (
    <AppShell active={section} onNavigate={key => navigate(key)} hrefFor={key => sectionUrl(key)} groups={groups}
      sidebarFooter={<>
        {/* 系统正常时不占位置；只有锁定（或状态读取中）才提示，点击进入安全与维护。 */}
        {isAdmin && locked && (
          <a className="system-chip is-locked" href={sectionUrl("maintenance")} onClick={event => { if (isPlainClick(event)) { event.preventDefault(); navigate("maintenance"); } }}>
            <Icon name="lock" size={15} />
            <span><strong>系统已锁定</strong><small>输入加密口令后继续使用</small></span>
          </a>
        )}
        {assistantAvailable && <AssistantLauncher open={assistantOpen || assistantPage} onOpen={toggleAssistant} />}
        <div className="storage-meter" title={usage?.quota_bytes == null ? "未设置空间配额" : undefined}>
          <div className="storage-meter-head"><span>已用空间</span><strong>{formatBytes(usage?.used_bytes ?? 0)}</strong></div>
          {usage?.quota_bytes != null && <>
            {usage.quota_bytes > 0 && <Progress value={percent} tone={usageTone(percent)} label="存储使用率" />}
            <p>{usage.quota_bytes > 0 ? `共 ${formatBytes(usage.quota_bytes)} · ${Math.round(percent)}%` : "配额为 0，无法上传"}</p>
          </>}
        </div>
      </>}
      account={{ name: api.displayName(session), caption: isAdmin ? "管理员" : "个人空间", tone: isAdmin ? "admin" : "accent", avatar: api.avatarUrl(session.avatar_version), menu: [
        { label: "跟随系统", icon: "monitor", heading: "外观", checked: theme === "system", onSelect: () => setThemePreference("system") },
        { label: "浅色", icon: "sun", checked: theme === "light", onSelect: () => setThemePreference("light") },
        { label: "深色", icon: "moon", checked: theme === "dark", onSelect: () => setThemePreference("dark") },
        { label: "退出登录", icon: "logout", onSelect: () => void logout(), divider: true },
      ] }}>
      <PrivateSessionProvider enabled={workspaceReady}>
      <PreviewHost enabled={workspaceReady} privateAllowed={section === "private"}>
        {content}
      <div className="tray-stack">
        {workspaceReady && <DownloadTray hidden={section === "downloads"} revision={downloadRevision} onOpenTasks={() => navigate("downloads")}
          onOpenFolder={(prefix, privateSpace) => navigate(privateSpace ? "private" : "files", prefix)} onCompleted={refreshUsage} />}
        <UploadTray queue={uploads} />
      </div>
      {assistantAvailable && assistant.config && !assistantPage && <AssistantDrawer open={assistantOpen} config={assistant.config} onClose={() => setAssistantOpen(false)}
        onConfigChanged={assistant.refresh} location={{ view: section, prefix: section === "files" ? location.prefix : "" }}
        onFilesChanged={filesChanged} pageImport={pageImport} onPageImportDone={clearPageImport} onNavigate={(view, prefix) => navigate(view, prefix ?? "")}
        onOpenPage={id => { setAssistantOpen(false); navigate("assistantPage", id ?? ""); }} />}
      {/* 助手抽屉也在预览宿主内：消息里的附件图片直接打开预览。 */}
      </PreviewHost>
      {/* 旧版用户名账号：登录后必须先设置邮箱（之后用邮箱登录，也为邮箱验证做准备）。 */}
      {session.needs_email && <EmailDialog session={session} required onSaved={onSessionChange} onLogout={() => void logout()} />}
      </PrivateSessionProvider>
    </AppShell>
  );
}

