import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BRAND } from "./brand";
import * as api from "./api";
import { DocsPage } from "./docs/docs";

import { SharePage } from "./share";
import { ADMIN_MODULES, AdminConsole, AdminDocsGate, LockedGate, type AdminModule } from "./admin";
import { AppShell, FullPageLoading, LoginPage, SetupPage, useSessionGuard, type NavGroup } from "./shell";
import { Icon, Progress, formatBytes, toast, usageTone, useDocumentTitle } from "./ui";

import { FilesView } from "./user/files";

import { SharedView } from "./user/shared";
import { TrashView } from "./user/trash";
import { KeysView } from "./user/keys";
import { PasswordDialog } from "./user/account";

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
  return <MainShell session={session} onLogout={() => setSession(null)} />;
}

type UserSection = "files" | "shared" | "trash" | "keys";
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
  return { section: view === "shared" || view === "keys" || view === "trash" ? view : "files", prefix: params.get("path") ?? "" };
}

function MainShell({ session, onLogout }: { session: api.Session; onLogout: () => void }) {
  const isAdmin = session.role === "admin";
  const [location, setLocation] = useState(readLocation);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sharedCount, setSharedCount] = useState<number | undefined>();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [status, setStatus] = useState<api.SystemStatus | null>(null);
  const [, setConfigVersion] = useState(0);
  const refreshUsage = useCallback(() => {
    void api.me().then(value => setUsage({ used_bytes: value.used_bytes, quota_bytes: value.quota_bytes, id: value.id })).catch(() => undefined);
    void api.listPublicPage(null, 1).then(page => setSharedCount(page.total)).catch(() => undefined);
  }, []);
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
    let url = "/";
    if (isAdminSection(section)) url = section === "overview" ? "/admin" : `/admin/${section}`;
    else {
      const params = new URLSearchParams();
      if (section !== "files") params.set("view", section);
      if (section === "files" && prefix) params.set("path", prefix);
      const query = params.toString();
      url = query ? `/?${query}` : "/";
    }
    window.history.pushState(null, "", url);
    setLocation({ section, prefix });
    document.getElementById("main")?.scrollTo?.({ top: 0 });
  }, []);
  async function logout() {
    await api.logout().catch(() => undefined);
    onLogout();
  }
  const locked = isAdmin && status !== null && !status.unlocked;
  const percent = usage?.quota_bytes ? usage.used_bytes / usage.quota_bytes * 100 : 0;
  const unlocked = () => { refreshStatus(); refreshUsage(); };
  const section = location.section;
  let content: ReactNode;
  if (isAdminSection(section)) {
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
      {section === "files" && <FilesView session={session} prefix={location.prefix} onOpenFolder={prefix => navigate("files", prefix)} onChanged={refreshUsage} />}
      {section === "shared" && <SharedView session={session} onChanged={refreshUsage} onOpenFolder={prefix => navigate("files", prefix)} />}
      {section === "keys" && <KeysView bucketName={usage ? `user-${usage.id}` : null} />}
      {section === "trash" && <TrashView onChanged={refreshUsage} onOpenFolder={prefix => navigate("files", prefix)} />}
    </>;
  }
  const personal: NavGroup<Section> = { label: isAdmin ? "我的空间" : undefined, items: [
    { key: "files", label: "我的文件", icon: "folder" },
    { key: "shared", label: "公开分享", icon: "globe", count: sharedCount },
    { key: "trash", label: "回收站", icon: "trash" },
    { key: "keys", label: "访问密钥", icon: "key" },
  ] };
  const groups: NavGroup<Section>[] = [
    personal,
    ...(isAdmin ? [{ label: "系统管理", items: ADMIN_MODULES }] : []),
    { label: "帮助", items: [{ key: "docs" as Section, label: "使用文档", icon: "book", href: "/docs" }] },
  ];
  return (
    <AppShell active={section} onNavigate={key => navigate(key)} groups={groups}
      sidebarFooter={<>
        {isAdmin && (
          <button type="button" className={`system-chip${locked ? " is-locked" : ""}`} onClick={() => navigate("maintenance")}>
            <Icon name={locked ? "lock" : "unlock"} size={16} />
            <span><strong>{status === null ? "检查中" : locked ? "系统已锁定" : "系统运行中"}</strong><small>{locked ? "输入加密口令后继续使用" : "一切正常"}</small></span>
          </button>
        )}
        <div className="storage-meter">
          <div className="storage-meter-head"><span>存储空间</span><strong>{usage?.quota_bytes ? `${Math.round(percent)}%` : "不限"}</strong></div>
          <Progress value={usage?.quota_bytes ? percent : 0} tone={usageTone(percent)} label="存储使用率" />
          <p>{formatBytes(usage?.used_bytes ?? 0)}{usage?.quota_bytes ? ` / ${formatBytes(usage.quota_bytes)}` : " 已使用"}</p>
        </div>
      </>}
      account={{ name: session.username, caption: isAdmin ? "管理员" : "个人空间", tone: isAdmin ? "admin" : "accent", menu: [
        { label: "修改密码", icon: "lock", onSelect: () => setPasswordOpen(true) },
        { label: "退出登录", icon: "logout", onSelect: () => void logout(), divider: true },
      ] }}>
      {content}
      {passwordOpen && <PasswordDialog onClose={() => setPasswordOpen(false)} />}
    </AppShell>
  );
}

