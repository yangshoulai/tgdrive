/**
 * 系统管理 · 文件助手（docs/assistant-design.md §12.1）：概览、渠道与模型、工具、限制与额度、对话记录、调用日志。
 * 对话记录只展示元数据：服务端管理接口不返回任何对话正文。
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { SITE } from "../brand";
import * as api from "../api";
import * as ai from "../assistant-api";
import { Notice, Badge, Button, ByteSizeInput, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader, Panel, PasswordField, SetupGuide, SearchInput, Segmented,
  SkeletonRows, Switch, Tabs, Disclosure, formatBytes, formatDateTime, toast, confirmLeave, useDocumentTitle, useUnsavedChanges, type IconName, type Tone } from "../ui";
import { Stat } from "./overview";
import { CurveChart } from "../curve-chart";

import { CallsTab } from "./assistant/calls";
import { CatalogTab } from "./assistant/catalog";
import { ChannelsTab } from "./assistant/channels";
import { ConversationsTab } from "./assistant/conversations";
import { LimitsTab } from "./assistant/limits";
import { OverviewTab } from "./assistant/overview";
import { GROUPS, TABS, Tab, groupOf } from "./assistant/shared";
import { ToolsTab } from "./assistant/tools";
import { UsageTab } from "./assistant/usage";
export { AssistantPolicyDialog } from "./assistant/policy";
export { price, tokens } from "./assistant/shared";

function readTab(): Tab {
  const part = window.location.pathname.split("/")[3] ?? "";
  return TABS.some(tab => tab.value === part) ? part as Tab : "overview";
}

export function AssistantAdmin() {
  const [tab, setTab] = useState<Tab>(readTab);
  const [settings, setSettings] = useState<ai.AssistantSettings | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [revision, setRevision] = useState(0);
  useDocumentTitle(`文件助手 · ${SITE.admin}`);
  const loadSettings = useCallback(() => { void ai.adminSettings().then(setSettings).catch(reason => toast.error(api.errorMessage(reason, "助手设置加载失败"))); }, []);
  useEffect(loadSettings, [loadSettings, revision]);
  useEffect(() => {
    const pop = () => setTab(readTab());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  async function choose(next: Tab) {
    if (next === tab || !await confirmLeave()) return;
    setTab(next);
    window.history.pushState(null, "", next === "overview" ? "/admin/assistant" : `/admin/assistant/${next}`);
  }
  async function setEnabled(enabled: boolean) {
    try { setSettings(await ai.updateAdminSettings({ enabled })); toast.success(enabled ? "文件助手已启用" : "文件助手已关闭"); setRevision(value => value + 1); }
    catch (reason) { toast.error(api.errorMessage(reason, "保存失败")); }
  }
  const changed = () => setRevision(value => value + 1);
  return (
    <>
      <PageHeader title="文件助手"
        actions={settings && <div className="assistant-master">
          <Badge tone={settings.enabled ? "success" : settings.default_model ? "neutral" : "warning"} dot>{settings.enabled ? "已启用" : settings.default_model ? "未启用" : "未配置可用模型"}</Badge>
          <Switch label="启用文件助手" checked={settings.enabled} disabled={!settings.enabled && !settings.default_model}
            onChange={value => value ? setEnabling(true) : void setEnabled(false)} />
        </div>} />
      <Tabs label="文件助手设置" value={groupOf(tab).value} onChange={group => choose(GROUPS.find(item => item.value === group)!.sections[0].value)} options={GROUPS} />
      {groupOf(tab).sections.length > 1 && <div className="assistant-subnav"><Segmented label={groupOf(tab).label} value={tab} onChange={choose} options={groupOf(tab).sections} /></div>}
      {tab === "overview" && <OverviewTab revision={revision} settings={settings} onNavigate={choose} onChanged={changed} />}
      {tab === "channels" && <ChannelsTab settings={settings} onChanged={changed} />}
      {tab === "catalog" && <CatalogTab />}
      {tab === "tools" && <ToolsTab />}
      {tab === "limits" && <LimitsTab settings={settings} onSaved={setSettings} />}
      {tab === "usage" && <UsageTab />}
      {tab === "conversations" && <ConversationsTab />}
      {tab === "calls" && <CallsTab />}
      {enabling && <ConfirmDialog title="启用文件助手？" danger={false} confirmLabel="启用"
        description="启用后，用户的文件名、目录结构以及助手读取的文本文件内容会发送给所选的模型服务。对话会被记录，管理员无法查看对话内容。用户首次使用时会看到同样的说明。"
        onClose={() => setEnabling(false)} onConfirm={async () => { await setEnabled(true); setEnabling(false); }} />}
    </>
  );
}

/* ---------- 概览 ---------- */

