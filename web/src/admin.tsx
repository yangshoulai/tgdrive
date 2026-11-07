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
import type { AdminModule } from "./admin-modules";

export { ADMIN_MODULES, type AdminModule } from "./admin-modules";
export { LockedGate };

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
