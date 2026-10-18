/** 系统管理：各页面在 admin/ 目录下，这里只负责按模块分发。 */
import * as api from "./api";
import { AssistantAdmin } from "./admin/assistant";
import { Bots } from "./admin/bots";
import { Clients } from "./admin/clients";
import { LockedGate } from "./admin/lock";
import { Audit, Maintenance } from "./admin/maintenance";
import { Overview } from "./admin/overview";
import { Settings } from "./admin/settings";
import { Users } from "./admin/users";
import type { IconName } from "./ui";

export { LockedGate };

export type AdminModule = "overview" | "users" | "bots" | "assistant" | "clients" | "maintenance" | "audit" | "settings";
/** 控制台菜单：概览单独置顶，其余按用途分组（侧栏分组可展开／收起）。 */
export const ADMIN_MODULES: { key: AdminModule; label: string; icon: IconName; group?: string }[] = [
  { key: "overview", label: "概览", icon: "home" },
  { key: "users", label: "用户", icon: "users", group: "账号与访问" },
  { key: "clients", label: "全部密钥", icon: "key", group: "账号与访问" },
  { key: "bots", label: "存储通道", icon: "send", group: "存储与服务" },
  { key: "assistant", label: "文件助手", icon: "sparkle", group: "存储与服务" },
  { key: "maintenance", label: "安全与维护", icon: "shield", group: "安全与运维" },
  { key: "audit", label: "审计日志", icon: "list", group: "安全与运维" },
  { key: "settings", label: "系统设置", icon: "settings", group: "安全与运维" },
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
      {module === "bots" && <Bots />}
      {module === "assistant" && <AssistantAdmin />}
      {module === "clients" && <Clients />}
      {module === "maintenance" && <Maintenance status={status} onStatus={onStatus} onLocked={onLocked} />}
      {module === "audit" && <Audit />}
      {module === "settings" && <Settings onSaved={onConfigSaved} />}
    </>
  );
}
