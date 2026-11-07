/** 系统管理的模块清单：侧栏菜单与路由只需要它，控制台各页面按需加载（admin.tsx）。 */
import type { IconName } from "./ui";

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
