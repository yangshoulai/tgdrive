/** 系统管理：各页面在 admin/ 目录下，这里只负责按模块分发，以及管理员文档的受保护加载。 */
import { useEffect } from "react";
import * as api from "./api";
import { Bots } from "./admin/bots";
import { Clients } from "./admin/clients";
import { LockedGate } from "./admin/lock";
import { Audit, Maintenance } from "./admin/maintenance";
import { Objects } from "./admin/objects";
import { Overview } from "./admin/overview";
import { Settings } from "./admin/settings";
import { Users } from "./admin/users";
import { FullPageLoading } from "./shell";
import type { IconName } from "./ui";

export { LockedGate };

export type AdminModule = "overview" | "users" | "objects" | "bots" | "clients" | "maintenance" | "audit" | "settings";
export const ADMIN_MODULES: { key: AdminModule; label: string; icon: IconName }[] = [
  { key: "overview", label: "概览", icon: "home" },
  { key: "users", label: "用户", icon: "users" },
  { key: "objects", label: "全部文件", icon: "box" },
  { key: "bots", label: "存储通道", icon: "send" },
  { key: "clients", label: "全部密钥", icon: "key" },
  { key: "maintenance", label: "安全与维护", icon: "shield" },
  { key: "audit", label: "审计日志", icon: "list" },
  { key: "settings", label: "系统设置", icon: "settings" },
];

/**
 * 系统管理各页面。侧栏、会话与路由由外层应用壳管理（管理员和普通用户共用同一个应用，菜单按角色显示）；
 * 这里只按 module 渲染内容。系统锁定时除「安全与维护」「系统设置」外都先要求输入加密口令。
 */
export function AdminConsole({ module, session, status, onStatus, onRefreshStatus, onNavigate, onLocked, onConfigSaved }: {
  module: AdminModule; session: api.Session; status: api.SystemStatus;
  onStatus: (status: api.SystemStatus) => void; onRefreshStatus: () => void;
  onNavigate: (module: AdminModule) => void; onLocked: () => void; onConfigSaved: () => void;
}) {
  if (!status.unlocked && module !== "maintenance" && module !== "settings") return <LockedGate onUnlocked={onRefreshStatus} />;
  return (
    <>
      {module === "overview" && <Overview onNavigate={onNavigate} status={status} />}
      {module === "users" && <Users />}
      {module === "objects" && <Objects session={session} />}
      {module === "bots" && <Bots />}
      {module === "clients" && <Clients />}
      {module === "maintenance" && <Maintenance status={status} onStatus={onStatus} onLocked={onLocked} />}
      {module === "audit" && <Audit />}
      {module === "settings" && <Settings onSaved={onConfigSaved} />}
    </>
  );
}

/** 管理员文档的代码只在管理员会话下由 /api/admin/v1/docs-bundle.js 下发；加载失败（会话刚好失效等）时退回用户文档。 */
export function AdminDocsGate({ onFailed }: { onFailed: () => void }) {
  useEffect(() => {
    const script = document.createElement("script");
    script.src = "/api/admin/v1/docs-bundle.js";
    script.async = true;
    script.onerror = onFailed;
    document.head.appendChild(script);
    return () => script.remove();
  }, []);
  return <div id="admin-docs-root"><FullPageLoading label="正在加载文档" /></div>;
}
