/** 系统管理 · 文件助手 · 标签分组、能力与容量格式化等各标签页共用的小工具。（docs/assistant-design.md §12.1） */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { SITE } from "../../brand";
import * as api from "../../api";
import * as ai from "../../assistant-api";
import { Notice, Badge, Button, ByteSizeInput, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader, Panel, PasswordField, SetupGuide, SearchInput, Segmented,
  SkeletonRows, Switch, Tabs, Disclosure, formatBytes, formatDateTime, toast, confirmLeave, useDocumentTitle, useUnsavedChanges, type IconName, type Tone } from "../../ui";
import { Stat } from "../overview";
import { CurveChart } from "../../curve-chart";


export type Tab = "overview" | "channels" | "catalog" | "tools" | "limits" | "usage" | "conversations" | "calls";
/** 控制台五个标签，相关的页面并在一起，用分段切换；每个分段仍有自己的地址（/admin/assistant/<分段>），旧链接不受影响。 */
export type Group = "overview" | "models" | "access" | "usage" | "conversations";
export const GROUPS: { value: Group; label: string; icon: IconName; sections: { value: Tab; label: string }[] }[] = [
  { value: "overview", label: "概览", icon: "pulse", sections: [{ value: "overview", label: "概览" }] },
  { value: "models", label: "渠道与模型", icon: "server", sections: [{ value: "channels", label: "模型渠道" }, { value: "catalog", label: "模型目录" }] },
  { value: "access", label: "权限与工具", icon: "shield", sections: [{ value: "limits", label: "权限与额度" }, { value: "tools", label: "工具" }] },
  { value: "usage", label: "用量与日志", icon: "chart", sections: [{ value: "usage", label: "用量统计" }, { value: "calls", label: "调用日志" }] },
  { value: "conversations", label: "对话记录", icon: "chat", sections: [{ value: "conversations", label: "对话记录" }] },
];
export const TABS = GROUPS.flatMap(group => group.sections);
export const groupOf = (tab: Tab) => GROUPS.find(group => group.sections.some(section => section.value === tab))!;
export const LEVELS: Record<ai.ToolLevel, { label: string; tone: Tone }> = {
  read: { label: "只读", tone: "neutral" }, meta: { label: "交互", tone: "neutral" }, scope: { label: "需确认", tone: "accent" },
  write: { label: "可修改", tone: "warning" }, danger: { label: "不可恢复", tone: "danger" },
};
export const KIND_LABEL = { openai: "OpenAI 兼容", anthropic: "Anthropic" };
export const channelLabel = (channel: ai.AiChannel) => channel.kind === "openai" && channel.protocol === "responses" ? "OpenAI Responses" : KIND_LABEL[channel.kind];
export const KIND_EXAMPLE = { openai: "https://api.deepseek.com/v1", anthropic: "https://api.anthropic.com" };

export const tokens = (value: number | null | undefined) => value == null ? "—" : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e4 ? `${(value / 1e3).toFixed(1)}K` : value.toLocaleString("zh-CN");
export const ms = (value: number | null | undefined) => value == null ? "—" : value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
/** 美元／百万 token 的价格。 */
export const price = (value: number | null | undefined) => value == null ? "—" : value === 0 ? "免费" : `$${value >= 10 ? value.toFixed(0) : value >= 1 ? value.toFixed(2).replace(/\.?0+$/, "") : value.toFixed(3).replace(/\.?0+$/, "")}`;
export const CAPABILITY_LABELS: [keyof ai.Capabilities, string][] = [["tools", "工具"], ["reasoning", "推理"], ["vision", "识图"], ["structured", "结构化"]];
export function CapabilityBadges({ value, tools }: { value: ai.Capabilities; tools?: ai.ToolSupport }) {
  const items = CAPABILITY_LABELS.filter(([key]) => key === "tools" ? (tools ? tools === "yes" : value.tools) : value[key]);
  return <span className="assistant-caps">{items.map(([key, label]) => <span key={key} className={`assistant-cap is-${key}`}>{label}</span>)}
    {tools === "no" && <span className="assistant-cap is-off">不支持工具</span>}</span>;
}
export const percent = (value: number | null | undefined) => value == null ? "—" : `${(value * 100).toFixed(value < 0.1 && value > 0 ? 1 : 0)}%`;

export function formatSize(bytes: number) {
  return bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// 接口中以 _bytes 结尾的配置使用字节存储，界面统一转换容量单位。
export const byteSetting = (name: string) => name.endsWith("_bytes");
export const sizeLabel = (label: string) => label.replace(/字节数/g, "大小").replace(/（字节）/g, "");
export const settingLabel = (name: string, label: string) => byteSetting(name) ? sizeLabel(label) : label;
export const settingNumber = (name: string, value: number) => byteSetting(name) ? formatBytes(value).replace(/\.0(?= )/, "") : value.toLocaleString("zh-CN");
export const settingRange = (name: string, bound: { min: number; max: number }) => `${settingNumber(name, bound.min)}–${settingNumber(name, bound.max)}`;

export const RANGES = { "1": "近 24 小时", "7": "近 7 天", "30": "近 30 天", all: "全部时间" };
export const sinceOf = (range: string) => range === "all" ? undefined : Math.floor(Date.now() / 1000) - Number(range) * 86400;

export function useUserOptions() {
  const [users, setUsers] = useState<api.Account[]>([]);
  useEffect(() => { void api.adminUsersPage(null).then(page => setUsers(page.users)).catch(() => undefined); }, []);
  return users;
}

