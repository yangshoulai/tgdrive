/**
 * 系统管理 · 文件助手（docs/assistant-design.md §12.1）：概览、渠道与模型、工具、限制与额度、对话记录、调用日志。
 * 对话记录只展示元数据：服务端管理接口不返回任何对话正文。
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { SITE } from "../brand";
import * as api from "../api";
import * as ai from "../assistant-api";
import { Badge, Button, ConfirmDialog, EmptyState, Field, Icon, KeyValue, Menu, Modal, PageHeader, Panel, PasswordField, SearchInput, Segmented,
  SkeletonRows, Switch, Toggle, formatDateTime, toast, useDocumentTitle, type Tone } from "../ui";
import { Stat } from "./overview";

type Tab = "overview" | "channels" | "tools" | "limits" | "usage" | "conversations" | "calls";
const TABS: { value: Tab; label: string }[] = [
  { value: "overview", label: "概览" }, { value: "channels", label: "渠道与模型" }, { value: "tools", label: "工具" },
  { value: "limits", label: "限制与额度" }, { value: "usage", label: "用量" }, { value: "conversations", label: "对话记录" },
  { value: "calls", label: "调用日志" },
];
const LEVELS: Record<ai.ToolLevel, { label: string; tone: Tone }> = {
  read: { label: "只读", tone: "neutral" }, meta: { label: "交互", tone: "neutral" }, scope: { label: "需确认", tone: "accent" },
  write: { label: "需确认", tone: "warning" }, danger: { label: "不可恢复", tone: "danger" },
};
const KIND_LABEL = { openai: "OpenAI 兼容", anthropic: "Anthropic" };
const KIND_EXAMPLE = { openai: "https://api.deepseek.com/v1", anthropic: "https://api.anthropic.com" };

export const tokens = (value: number | null | undefined) => value == null ? "—" : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e4 ? `${(value / 1e3).toFixed(1)}K` : value.toLocaleString("zh-CN");
const ms = (value: number | null | undefined) => value == null ? "—" : value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
const percent = (value: number | null | undefined) => value == null ? "—" : `${(value * 100).toFixed(value < 0.1 && value > 0 ? 1 : 0)}%`;

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
  function choose(next: Tab) {
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
      <PageHeader title="文件助手" description="用户可以通过对话查询、整理自己的文件。写入操作需要用户逐项确认。"
        actions={settings && <div className="assistant-master">
          <Badge tone={settings.enabled ? "success" : settings.default_model ? "neutral" : "warning"} dot>{settings.enabled ? "已启用" : settings.default_model ? "未启用" : "未配置可用模型"}</Badge>
          <Switch label="启用文件助手" checked={settings.enabled} disabled={!settings.enabled && !settings.default_model}
            onChange={value => value ? setEnabling(true) : void setEnabled(false)} />
        </div>} />
      <div className="assistant-tabs"><Segmented label="文件助手设置" showLabels value={tab} onChange={choose} options={TABS} /></div>
      {tab === "overview" && <OverviewTab revision={revision} settings={settings} onNavigate={choose} onChanged={changed} />}
      {tab === "channels" && <ChannelsTab settings={settings} onChanged={changed} />}
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

function OverviewTab({ revision, settings, onNavigate, onChanged }: { revision: number; settings: ai.AssistantSettings | null; onNavigate: (tab: Tab) => void; onChanged: () => void }) {
  const [data, setData] = useState<ai.AssistantOverview | null>(null);
  const [error, setError] = useState("");
  const [purging, setPurging] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const load = useCallback(() => {
    const controller = new AbortController();
    setError("");
    void ai.adminOverview(controller.signal).then(setData).catch(reason => setError(api.errorMessage(reason, "概览加载失败")));
    return () => controller.abort();
  }, []);
  useEffect(load, [load, revision]);
  if (error) return <Panel><EmptyState icon="alert" title="概览加载失败" description={error} action={<Button onClick={load}>重试</Button>} /></Panel>;
  if (!data) return <Panel><SkeletonRows rows={4} /></Panel>;
  const steps = [
    { done: data.channels > 0, label: "添加一个模型渠道", tab: "channels" as Tab },
    { done: data.usable_models > 0, label: "启用至少一个模型", tab: "channels" as Tab },
    { done: Boolean(settings?.default_model), label: "设为默认模型", tab: "channels" as Tab },
    { done: data.enabled, label: "打开右上角的总开关", tab: "overview" as Tab },
  ];
  const days = dailyUsage(data.usage);
  return (
    <>
      {!data.enabled && <Panel title="开始使用" description="完成以下步骤后，用户就能在文件页打开文件助手。">
        <ol className="assistant-steps">
          {steps.map((step, index) => <li key={index} className={step.done ? "is-done" : ""}>
            <span className="assistant-step-mark">{step.done ? <Icon name="check" size={14} /> : index + 1}</span>
            <span>{step.label}</span>
            {!step.done && step.tab !== "overview" && <Button size="sm" variant="ghost" onClick={() => onNavigate(step.tab)}>去设置</Button>}
          </li>)}
        </ol>
      </Panel>}
      <div className="stat-strip assistant-stats">
        <Stat label="默认模型" value={data.default_model?.label ?? "未设置"} detail={`可用模型 ${data.usable_models} 个（${data.channels} 个渠道）`} />
        <Stat label="今日对话" value={String(data.today.conversations)} detail={`模型请求 ${data.today.requests} 次`} />
        <Stat label="今日 Token" value={tokens(data.today.tokens)} detail={`失败率 ${percent(data.today.failure_rate)}`} />
        <Stat label="启用工具" value={`${data.tools.enabled} / ${data.tools.total}`} detail="管理员可逐个停用" />
        <Stat label="待确认操作" value={String(data.today.pending_actions)} detail={`今日已执行 ${data.today.executed_actions}`} />
      </div>
      <div className="overview-columns">
        <div className="overview-column">
          <Panel title="近 30 天 Token 用量" description="输入与输出合计，按天汇总。">
            {days.length ? <UsageBars days={days} /> : <p className="muted">暂无用量数据</p>}
          </Panel>
        </div>
        <div className="overview-column">
          <Panel title="渠道健康" description="每个渠道最近 20 次模型请求。" flush actions={<Button size="sm" variant="ghost" onClick={() => onNavigate("channels")}>管理渠道</Button>}>
            {data.health.length === 0 ? <EmptyState icon="server" title="还没有渠道" /> : (
              <div className="data-table assistant-health-table" role="table" aria-label="渠道健康">
                <div className="data-row data-head" role="row"><span role="columnheader">渠道</span><span role="columnheader">成功率</span><span role="columnheader">P95</span><span role="columnheader">最近错误</span></div>
                {data.health.map(item => <div className="data-row" role="row" key={item.id}>
                  <span role="cell" className="name-stack"><strong>{item.name}</strong><small>{item.enabled ? (item.unhealthy ? <span className="tone-danger">异常</span> : "启用") : "已停用"}</small></span>
                  <span role="cell">{item.requests ? percent(item.success_rate) : "—"}</span>
                  <span role="cell" className="muted">{ms(item.p95_ms)}</span>
                  <span role="cell" className="muted cell-truncate" title={item.last_error ?? undefined}>{item.last_error ?? "—"}</span>
                </div>)}
              </div>
            )}
          </Panel>
          <Panel title="数据占用" description="对话正文加密保存；调用日志只有元数据。">
            <KeyValue items={[
              ["对话", `${(data.storage.assistant_conversations ?? 0).toLocaleString("zh-CN")} 个`],
              ["消息", `${(data.storage.assistant_messages ?? 0).toLocaleString("zh-CN")} 条 · 约 ${formatSize(data.storage.message_bytes ?? 0)}`],
              ["调用日志", `${(data.storage.assistant_calls ?? 0).toLocaleString("zh-CN")} 条`],
            ]} />
            <div className="assistant-danger-zone"><Button variant="ghost" className="btn-ghost-danger" icon="trash" onClick={() => { setConfirmText(""); setPurging(true); }}>清除所有助手数据</Button></div>
          </Panel>
        </div>
      </div>
      {purging && <ConfirmDialog title="清除所有助手数据？" confirmLabel="清除" onClose={() => setPurging(false)}
        description="将删除全部对话、待确认操作、用量统计与调用日志，进行中的对话会被停止。渠道、模型和设置保留。此操作不可恢复。"
        onConfirm={async () => {
          if (confirmText !== "清除") { toast.error("请输入“清除”确认"); return; }
          try { await ai.purgeAssistantData(); toast.success("助手数据已清除"); setPurging(false); onChanged(); }
          catch (reason) { toast.error(api.errorMessage(reason, "清除失败")); }
        }}>
        <Field label="输入“清除”确认"><input className="input" value={confirmText} onChange={event => setConfirmText(event.target.value)} autoFocus /></Field>
      </ConfirmDialog>}
    </>
  );
}

function formatSize(bytes: number) {
  return bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function dailyUsage(points: ai.UsagePoint[]) {
  const map = new Map<string, number>();
  for (const point of points) map.set(point.day, (map.get(point.day) ?? 0) + (point.input_tokens ?? 0) + (point.output_tokens ?? 0));
  return [...map.entries()].map(([day, total]) => ({ day, total }));
}

function UsageBars({ days }: { days: { day: string; total: number }[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const max = Math.max(1, ...days.map(day => day.total));
  const current = days.find(day => day.day === selected) ?? days.at(-1)!;
  return <div className="traffic-chart" aria-label="近 30 天 Token 用量">
    <div className="traffic-plot"><div className="traffic-axis"><span>{tokens(max)}</span><span>{tokens(Math.round(max / 2))}</span><span>0</span></div><div className="traffic-bars">
      {days.map(day => <button type="button" key={day.day} className={`traffic-bar${current.day === day.day ? " is-active" : ""}`}
        aria-label={`${day.day}：${tokens(day.total)} token`} onMouseEnter={() => setSelected(day.day)} onFocus={() => setSelected(day.day)} onClick={() => setSelected(day.day)}>
        <i className="traffic-in" style={{ height: `${day.total / max * 100}%` }} />
      </button>)}
    </div></div>
    <div className="traffic-times"><span>{days[0].day.slice(5)}</span><span>{days.at(-1)!.day.slice(5)}</span></div>
    <p className="traffic-readout">{current.day}：{tokens(current.total)} token</p>
  </div>;
}

/* ---------- 用量报表 ---------- */

const STOP_REASONS: Record<string, string> = {
  completed: "正常完成", waiting_user: "等待用户", stopped: "用户停止", limit: "触达上限", loop: "重复调用", errors: "连续出错",
  timeout: "超时", session: "登录失效", disabled: "助手停用", model: "模型停用", daily_limit: "额度用完", server_restart: "服务重启",
  internal: "内部错误", locked: "系统锁定", account: "账号停用",
};
const ACTION_STATUS: Record<string, string> = { done: "已完成", partial: "部分完成", failed: "失败", rejected: "已拒绝", expired: "已过期",
  cancelled: "已取消", undone: "已撤销", pending: "待确认", running: "执行中", interrupted: "已中断" };

function UsageTab() {
  const [days, setDays] = useState("30");
  const [report, setReport] = useState<ai.UsageReport | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setReport(null); setError("");
    void ai.adminUsage(Number(days)).then(setReport).catch(reason => setError(api.errorMessage(reason, "用量加载失败")));
  }, [days]);
  useEffect(load, [load]);
  const sum = (row: { input_tokens: number | null; output_tokens: number | null }) => (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
  return <>
    <div className="toolbar">
      <div className="toolbar-actions">
        <select className="input input-sm" aria-label="时间范围" value={days} onChange={event => setDays(event.target.value)}>
          <option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option><option value="365">近一年</option>
        </select>
      </div>
      <Button icon="refresh" onClick={load}>刷新</Button>
    </div>
    {error ? <EmptyState icon="alert" title="加载失败" description={error} action={<Button onClick={load}>重试</Button>} />
      : report === null ? <SkeletonRows rows={6} /> : <div className="assistant-admin-stack">
        <div className="stat-strip assistant-stats">
          <Stat label="Token" value={tokens(report.totals.input_tokens + report.totals.output_tokens)} detail={`输入 ${tokens(report.totals.input_tokens)} · 输出 ${tokens(report.totals.output_tokens)}`} />
          <Stat label="运行次数" value={report.totals.runs.toLocaleString("zh-CN")} detail={`自 ${report.since}`} />
          <Stat label="使用人数" value={report.totals.users.toLocaleString("zh-CN")} detail="有用量的账号" />
          <Stat label="人均 Token" value={tokens(report.totals.users ? Math.round((report.totals.input_tokens + report.totals.output_tokens) / report.totals.users) : 0)} detail="所选范围" />
        </div>
        <Panel title="每日 Token 用量" description="输入与输出合计。">
          {report.by_day.length ? <UsageBars days={report.by_day.map(row => ({ day: row.day, total: sum(row) }))} /> : <p className="muted">暂无用量数据</p>}
        </Panel>
        <div className="assistant-usage-grid">
          <Panel title="按用户" description="用量最多的 50 个账号。">
            <UsageTable rows={report.by_user.map(row => [row.nickname || row.username || `#${row.user_id}`, row])} empty="暂无用户用量" />
          </Panel>
          <Panel title="按模型" description="对话所用模型（含标题生成与结构分析）。">
            <UsageTable rows={report.by_model.map(row => [row.model_label || row.model_name ? `${row.channel_name ?? ""} / ${row.model_label || row.model_name}` : "已删除的模型", row])} empty="暂无模型用量" />
          </Panel>
        </div>
        <div className="assistant-usage-grid">
          <Panel title="工具调用" description="次数、出错率与平均耗时，用于调整工具与上限。">
            {report.tools.length ? <div className="data-table assistant-usage-table" role="table" aria-label="工具调用">
              <div className="data-row data-head" role="row"><span role="columnheader">工具</span><span role="columnheader">次数</span><span role="columnheader">出错</span><span role="columnheader">平均耗时</span></div>
              {report.tools.map(row => <div className="data-row" role="row" key={row.tool_name}>
                <span role="cell" className="mono cell-truncate">{row.tool_name}</span><span role="cell">{row.calls.toLocaleString("zh-CN")}</span>
                <span role="cell">{row.calls ? percent(row.errors / row.calls) : "—"}</span><span role="cell">{ms(row.avg_ms)}</span>
              </div>)}
            </div> : <p className="muted">暂无工具调用</p>}
          </Panel>
          <Panel title="结束原因与操作" description="触达上限过多时可适当放宽限制；操作按类型与结果统计。">
            <KeyValue items={report.stops.map(row => [STOP_REASONS[row.reason] ?? (row.reason || "进行中"), `${row.runs.toLocaleString("zh-CN")} 次`])} />
            {report.actions.length > 0 && <KeyValue items={report.actions.map(row => [`${ai.ACTION_KINDS[row.kind] ?? row.kind} · ${ACTION_STATUS[row.status] ?? row.status}`,
              `${row.actions} 个（${(row.items ?? 0).toLocaleString("zh-CN")} 项）`])} />}
          </Panel>
        </div>
      </div>}
  </>;
}

function UsageTable({ rows, empty }: { rows: [string, { input_tokens: number | null; output_tokens: number | null; runs: number | null }][]; empty: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return <div className="data-table assistant-usage-table" role="table">
    <div className="data-row data-head" role="row"><span role="columnheader">名称</span><span role="columnheader">Token</span><span role="columnheader">输入 / 输出</span><span role="columnheader">运行</span></div>
    {rows.map(([label, row], index) => <div className="data-row" role="row" key={index}>
      <span role="cell" className="cell-truncate" title={label}>{label}</span><span role="cell">{tokens((row.input_tokens ?? 0) + (row.output_tokens ?? 0))}</span>
      <span role="cell" className="muted">{tokens(row.input_tokens)} / {tokens(row.output_tokens)}</span><span role="cell">{(row.runs ?? 0).toLocaleString("zh-CN")}</span>
    </div>)}
  </div>;
}

/* ---------- 渠道与模型 ---------- */

function ChannelsTab({ settings, onChanged }: { settings: ai.AssistantSettings | null; onChanged: () => void }) {
  const [channels, setChannels] = useState<ai.AiChannel[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<ai.AiChannel | "new" | null>(null);
  const [deleting, setDeleting] = useState<ai.AiChannel | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    void ai.adminChannels().then(list => { setChannels(list); setSelected(current => current && list.some(c => c.id === current) ? current : list[0]?.id ?? null); })
      .catch(reason => setError(api.errorMessage(reason, "渠道加载失败")));
  }, []);
  useEffect(load, [load]);
  const channel = channels?.find(item => item.id === selected) ?? null;
  if (error) return <Panel><EmptyState icon="alert" title="渠道加载失败" description={error} action={<Button onClick={load}>重试</Button>} /></Panel>;
  if (!channels) return <Panel><SkeletonRows rows={4} /></Panel>;
  return (
    <>
      {channels.length === 0 ? <Panel><EmptyState icon="server" title="还没有模型渠道" description="渠道是一个模型服务的接口地址和 API Key。支持 OpenAI 兼容接口（OpenAI、DeepSeek、通义、Kimi、OpenRouter、Ollama 等）和 Anthropic。"
        action={<Button variant="primary" icon="plus" onClick={() => setEditing("new")}>添加渠道</Button>} /></Panel> : (
        <div className="assistant-channels">
          <Panel title="模型渠道" description="选择渠道，管理连接与模型。" className="assistant-channel-nav" flush actions={<Button size="sm" icon="plus" onClick={() => setEditing("new")}>添加</Button>}>
            <ul className="assistant-channel-list" role="listbox" aria-label="渠道">
              {channels.map(item => <li key={item.id}>
                <button type="button" role="option" aria-selected={item.id === selected} className={item.id === selected ? "is-active" : ""} onClick={() => setSelected(item.id)}>
                  <i className={`assistant-dot${!item.enabled ? "" : item.health?.unhealthy ? " is-danger" : " is-success"}`} aria-hidden="true" />
                  <span className="name-stack"><strong>{item.name}</strong><small>{KIND_LABEL[item.kind]} · {item.enabled_models}/{item.models} 个模型启用</small></span>
                  {!item.enabled ? <Badge>已停用</Badge> : item.health?.unhealthy ? <Badge tone="danger">异常</Badge> : null}
                </button>
              </li>)}
            </ul>
          </Panel>
          {channel && <ChannelDetail key={channel.id} channel={channel} defaultModel={settings?.default_model ?? null}
            onEdit={() => setEditing(channel)} onDelete={() => setDeleting(channel)} onChanged={() => { load(); onChanged(); }} />}
        </div>
      )}
      {editing && <ChannelDialog channel={editing === "new" ? null : editing} onClose={() => setEditing(null)}
        onSaved={saved => { setEditing(null); setSelected(saved.id); load(); onChanged(); }} />}
      {deleting && <ConfirmDialog title={`删除渠道 ${deleting.name}？`} confirmLabel="删除渠道" onClose={() => setDeleting(null)}
        description="渠道下的模型一并删除，已有对话中的引用会显示为“已删除的模型”。调用日志保留。"
        onConfirm={async () => {
          try { await ai.deleteAdminChannel(deleting.id); toast.success("渠道已删除"); setDeleting(null); load(); onChanged(); }
          catch (reason) { toast.error(api.errorMessage(reason, "删除失败")); }
        }} />}
    </>
  );
}

function ChannelDetail({ channel, defaultModel, onEdit, onDelete, onChanged }: { channel: ai.AiChannel; defaultModel: number | null; onEdit: () => void; onDelete: () => void; onChanged: () => void }) {
  const [models, setModels] = useState<ai.AiModel[] | null>(null);
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingModel, setEditingModel] = useState<ai.AiModel | null>(null);
  const load = useCallback(() => { void ai.adminChannelModels(channel.id).then(setModels).catch(reason => toast.error(api.errorMessage(reason, "模型加载失败"))); }, [channel.id]);
  useEffect(load, [load]);
  async function sync() {
    setSyncing(true);
    try { const result = await ai.syncAdminChannel(channel.id); toast.success(`${result.note}${result.added ? "，新模型默认停用" : ""}`); load(); onChanged(); }
    catch (reason) { toast.error(api.errorMessage(reason, "同步失败")); }
    finally { setSyncing(false); }
  }
  async function update(model: ai.AiModel, input: Parameters<typeof ai.updateAdminModel>[1], message?: string) {
    try { await ai.updateAdminModel(model.id, input); if (message) toast.success(message); load(); onChanged(); }
    catch (reason) { toast.error(api.errorMessage(reason, "保存失败")); }
  }
  async function setDefault(model: ai.AiModel) {
    try {
      if (!model.enabled) await ai.updateAdminModel(model.id, { enabled: true });
      await ai.updateAdminSettings({ default_model: model.id });
      toast.success(`已将 ${model.label} 设为默认模型`); load(); onChanged();
    } catch (reason) { toast.error(api.errorMessage(reason, "设置失败")); }
  }
  async function test(model: ai.AiModel) {
    setTesting(model.id);
    try { const result = await ai.testAdminModel(model.id); result.ok ? toast.success(result.note) : toast.error(result.note); load(); onChanged(); }
    catch (reason) { toast.error(api.errorMessage(reason, "测试失败")); }
    finally { setTesting(null); }
  }
  async function remove(model: ai.AiModel) {
    try { await ai.deleteAdminModel(model.id); toast.success("模型已删除"); load(); onChanged(); }
    catch (reason) { toast.error(api.errorMessage(reason, "删除失败")); }
  }
  const shown = (models ?? []).filter(model => (filter === "all" || model.enabled === (filter === "enabled"))
    && (!search.trim() || `${model.model} ${model.display_name ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())));
  return (
    <Panel flush className="assistant-channel-detail" title={<span className="assistant-channel-title"><span className="assistant-channel-symbol"><Icon name="server" size={20} /></span><span>{channel.name}<small>{KIND_LABEL[channel.kind]}</small></span><Badge tone={channel.enabled ? "success" : "neutral"} dot>{channel.enabled ? "已启用" : "已停用"}</Badge></span>}
      actions={<>
        <Button size="sm" icon="refresh" loading={syncing} onClick={() => void sync()}>同步模型</Button>
        <Button size="sm" icon="edit" onClick={onEdit}>编辑</Button>
        <Menu label={`${channel.name} 的更多操作`} items={[
          channel.enabled
            ? { label: "停用渠道", icon: "lock", onSelect: () => void ai.updateAdminChannel(channel.id, { enabled: false }).then(() => { toast.success("渠道已停用"); onChanged(); }).catch(reason => toast.error(api.errorMessage(reason, "停用失败"))) }
            : { label: "启用渠道", icon: "unlock", onSelect: () => void ai.updateAdminChannel(channel.id, { enabled: true }).then(() => { toast.success("渠道已启用"); onChanged(); }).catch(reason => toast.error(api.errorMessage(reason, "启用失败"))) },
          { label: "删除渠道", icon: "trash", danger: true, divider: true, onSelect: onDelete },
        ]} />
      </>}>
      <div className="assistant-channel-meta">
        <KeyValue items={[
          ["Base URL", <code className="mono" key="url">{channel.base_url}</code>],
          ["API Key", channel.api_key ? <code className="mono" key="key">{channel.api_key}</code> : <span className="muted">未设置</span>],
          ["并发 / 超时", `${channel.concurrency} 个请求 · ${channel.timeout} 秒`],
          ["上次同步", channel.synced_at ? `${formatDateTime(channel.synced_at)}${channel.sync_note ? `，${channel.sync_note}` : ""}` : "尚未同步"],
          ...(channel.last_error ? [["最近错误", <span className="tone-danger" key="error">{channel.last_error}</span>] as [ReactNode, ReactNode]] : []),
        ]} />
      </div>
      <div className="assistant-model-heading"><h3>可用模型 <span>{models?.length ?? "—"}</span></h3><p>同步发现的新模型默认停用，测试通过后即可启用。</p></div>
      <div className="toolbar assistant-model-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="搜索模型" label="搜索模型" />
        <div className="toolbar-actions">
          <Segmented label="筛选模型" value={filter} onChange={setFilter} options={[{ value: "all", label: "全部" }, { value: "enabled", label: "已启用" }, { value: "disabled", label: "未启用" }]} />
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>手动添加</Button>
        </div>
      </div>
      {models === null ? <SkeletonRows rows={3} /> : shown.length === 0 ? <EmptyState icon="box" title={models.length ? "没有匹配的模型" : "还没有模型"} description={models.length ? undefined : "点击“同步模型”从上游加载，或手动添加模型 ID。"} /> : (
        <div className="file-surface table-scroll"><div className="data-table assistant-models-table" role="table" aria-label="模型">
          <div className="data-row data-head" role="row"><span role="columnheader">启用</span><span role="columnheader">模型</span><span role="columnheader">工具调用</span><span role="columnheader">上下文</span><span role="columnheader">来源</span><span role="columnheader"><span className="sr-only">操作</span></span></div>
          {shown.map(model => (
            <div className="data-row" role="row" key={model.id}>
              <span role="cell"><Toggle label={`启用 ${model.label}`} checked={model.enabled}
                onChange={value => void update(model, { enabled: value }, value && model.tools !== "yes" ? "已启用。建议先点“测试”确认它支持工具调用" : undefined)} /></span>
              <span role="cell" className="name-stack">
                <strong>{model.label}{model.id === defaultModel && <Badge tone="accent">默认</Badge>}{model.removed_upstream && <Badge tone="warning">上游已移除</Badge>}</strong>
                {(model.display_name || model.test_note) && <small className="mono" title={model.test_note ?? undefined}>
                  {[model.display_name ? model.model : "", model.test_note ?? ""].filter(Boolean).join(" · ")}</small>}
              </span>
              <span role="cell">{model.tools === "yes" ? <Badge tone="success">支持</Badge> : model.tools === "no" ? <Badge tone="danger">不支持</Badge> : <Badge>未知</Badge>}</span>
              <span role="cell" className="muted">{model.context_window ? tokens(model.context_window) : "—"}</span>
              <span role="cell" className="muted">{model.source === "auto" ? "自动" : "手动"}</span>
              <span role="cell" className="cell-actions">
                <Button size="sm" variant="ghost" loading={testing === model.id} onClick={() => void test(model)}>测试</Button>
                <Menu label={`${model.label} 的操作`} items={[
                  { label: "设为默认", icon: "check", onSelect: () => void setDefault(model) },
                  { label: "编辑", icon: "edit", onSelect: () => setEditingModel(model) },
                  ...(model.source === "manual" || model.removed_upstream ? [{ label: "删除", icon: "trash" as const, danger: true, divider: true, onSelect: () => void remove(model) }] : []),
                ]} />
              </span>
            </div>
          ))}
        </div></div>
      )}
      {adding && <ModelDialog channelId={channel.id} model={null} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); onChanged(); }} />}
      {editingModel && <ModelDialog channelId={channel.id} model={editingModel} onClose={() => setEditingModel(null)} onSaved={() => { setEditingModel(null); load(); onChanged(); }} />}
    </Panel>
  );
}

function parseHeaders(text: string): Record<string, string> | string {
  const result: Record<string, string> = {};
  for (const line of text.split("\n").map(item => item.trim()).filter(Boolean)) {
    const index = line.indexOf(":");
    if (index <= 0) return `无法识别的请求头：${line}`;
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

function ChannelDialog({ channel, onClose, onSaved }: { channel: ai.AiChannel | null; onClose: () => void; onSaved: (channel: ai.AiChannel) => void }) {
  const [clearHeaders, setClearHeaders] = useState(false);
  const [form, setForm] = useState({ name: channel?.name ?? "", kind: channel?.kind ?? "openai" as ai.AiChannel["kind"], base_url: channel?.base_url ?? "",
    api_key: "", headers: "", concurrency: String(channel?.concurrency ?? 4), timeout: String(channel?.timeout ?? 120), enabled: channel?.enabled ?? true });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) { setError("请填写渠道名称"); return; }
    if (!/^https?:\/\//.test(form.base_url.trim())) { setError("Base URL 必须以 http:// 或 https:// 开头"); return; }
    const headers = parseHeaders(form.headers);
    if (typeof headers === "string") { setError(headers); return; }
    const input: ai.ChannelInput = { name: form.name.trim(), base_url: form.base_url.trim(), enabled: form.enabled,
      concurrency: Number(form.concurrency), timeout: Number(form.timeout) };
    if (!channel) input.kind = form.kind;
    if (form.api_key.trim()) input.api_key = form.api_key.trim();
    if (clearHeaders || form.headers.trim() || !channel) input.headers = clearHeaders ? {} : headers;
    setBusy(true); setError("");
    try {
      const saved = channel ? await ai.updateAdminChannel(channel.id, input) : await ai.createAdminChannel(input);
      if (!channel) {
        if (saved.sync_error) toast.error(`渠道已添加，但${saved.sync_error}`);
        else if (saved.sync) toast.success(`渠道已添加，发现 ${saved.sync.total} 个模型，已全部设为未启用`);
      } else toast.success("渠道已保存");
      onSaved(saved);
    } catch (reason) { setError(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={channel ? "编辑模型渠道" : "添加模型渠道"} icon="server" onClose={onClose} dismissible={!busy}
      description={channel ? "API Key 留空表示不修改。" : "保存后会自动同步模型列表，新模型默认停用。API Key 加密保存，不会再次显示。"}
      footer={<><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" type="submit" form="channel-form" loading={busy}>{channel ? "保存" : "添加并同步"}</Button></>}>
      <form id="channel-form" className="form assistant-config-form" onSubmit={submit} noValidate>
        <div className="assistant-form-section"><h3>连接信息</h3><p>填写模型服务提供的接口地址与凭据。</p></div>
        <div className="form-row">
          <Field label="名称"><input className="input" value={form.name} maxLength={40} placeholder="例如：DeepSeek" onChange={event => setForm({ ...form, name: event.target.value })} autoFocus /></Field>
          <Field label="类型" hint={channel ? "创建后不能修改" : undefined}>
            <select className="input" value={form.kind} disabled={Boolean(channel)} onChange={event => setForm({ ...form, kind: event.target.value as ai.AiChannel["kind"] })}>
              <option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option>
            </select>
          </Field>
        </div>
        <Field label="Base URL" hint={`例如 ${KIND_EXAMPLE[form.kind]}${form.kind === "openai" ? "；本地 Ollama 为 http://127.0.0.1:11434/v1" : ""}`}>
          <input className="input mono" value={form.base_url} placeholder={KIND_EXAMPLE[form.kind]} autoCapitalize="none" spellCheck={false} onChange={event => setForm({ ...form, base_url: event.target.value })} />
        </Field>
        <PasswordField label="API Key" name="channel-api-key" autoComplete="off" value={form.api_key} onChange={api_key => setForm({ ...form, api_key })}
          hint={channel?.api_key ? `已保存 ${channel.api_key}；留空保留，填写新值替换。` : "仅用于连接模型服务，加密保存；本地模型可留空。"} />
        <details className="settings-disclosure assistant-advanced">
          <summary><Icon name="settings" size={16} /><span>高级设置</span><span className="disclosure-meta">请求头、并发与超时</span><Icon name="chevronDown" size={16} /></summary>
          <div className="disclosure-body form">
        <Field label="附加请求头" hint={`每行一个，格式为 名称: 值；值加密保存。${channel?.header_names.length ? `当前：${channel.header_names.join("、")}（留空表示不修改）` : ""}`}>
          <textarea className="input mono" rows={3} disabled={clearHeaders} value={form.headers} placeholder="HTTP-Referer: https://drive.example.com" onChange={event => setForm({ ...form, headers: event.target.value })} />
        </Field>
        {Boolean(channel?.header_names.length) && <Switch label="移除已保存的请求头" description="保存后清除当前渠道的附加请求头。" checked={clearHeaders} onChange={setClearHeaders} />}
        <div className="form-row">
          <Field label="并发请求数" hint="1–32"><input className="input" type="number" min={1} max={32} value={form.concurrency} onChange={event => setForm({ ...form, concurrency: event.target.value })} /></Field>
          <Field label="超时（秒）" hint="10–600"><input className="input" type="number" min={10} max={600} value={form.timeout} onChange={event => setForm({ ...form, timeout: event.target.value })} /></Field>
        </div>
          </div>
        </details>
        <Switch checked={form.enabled} onChange={enabled => setForm({ ...form, enabled })} label="启用渠道" description="停用后其下所有模型对用户不可见。" />
        {error && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{error}</div>}
      </form>
    </Modal>
  );
}

function ModelDialog({ channelId, model, onClose, onSaved }: { channelId: number; model: ai.AiModel | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ model: model?.model ?? "", display_name: model?.display_name ?? "", context_window: model?.context_window ? String(model.context_window) : "",
    max_output: model?.max_output ? String(model.max_output) : "", tools: model?.tools ?? "unknown" as ai.ToolSupport, sort: String(model?.sort ?? 0) });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const number = (value: string) => value.trim() ? Number(value) : null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!model && !form.model.trim()) { setError("请填写模型 ID"); return; }
    for (const [key, label, high] of [["context_window", "上下文窗口", 10000000], ["max_output", "最大输出", 1000000], ["sort", "显示顺序", 100000]] as const) {
      const value = number(form[key]);
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > high)) { setError(`${label}必须是 0–${high.toLocaleString("zh-CN")} 的整数`); return; }
    }
    setBusy(true); setError("");
    try {
      if (model) await ai.updateAdminModel(model.id, { display_name: form.display_name.trim() || null, context_window: number(form.context_window), max_output: number(form.max_output), tools: form.tools, sort: Number(form.sort) });
      else await ai.addAdminModel(channelId, { model: form.model.trim(), display_name: form.display_name.trim() || null, context_window: number(form.context_window), max_output: number(form.max_output), tools: form.tools, sort: Number(form.sort) });
      toast.success(model ? "模型已保存" : "模型已添加，默认停用");
      onSaved();
    } catch (reason) { setError(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={model ? "模型配置" : "手动添加模型"} description={model ? `正在配置 ${model.model}` : "模型 ID 需与服务商接口一致，新模型默认停用。"} icon="sparkle" onClose={onClose} dismissible={!busy}
      footer={<><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" type="submit" form="model-form" loading={busy}>保存</Button></>}>
      <form id="model-form" className="form assistant-config-form" onSubmit={submit} noValidate>
        {!model && <Field label="模型 ID" hint="与上游接口中的 model 参数一致。"><input className="input mono" value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} autoFocus /></Field>}
        <Field label="显示名" hint="用户在模型选择器里看到的名称，留空使用模型 ID。"><input className="input" value={form.display_name} maxLength={80} onChange={event => setForm({ ...form, display_name: event.target.value })} /></Field>
        <div className="form-row">
          <Field label="上下文窗口" hint="token 数，用于决定何时压缩历史。"><input className="input" type="number" min={0} value={form.context_window} onChange={event => setForm({ ...form, context_window: event.target.value })} /></Field>
          <Field label="最大输出" hint="留空由服务决定。"><input className="input" type="number" min={0} value={form.max_output} onChange={event => setForm({ ...form, max_output: event.target.value })} /></Field>
        </div>
        <div className="assistant-form-section"><h3>能力与展示</h3><p>工具调用支持决定模型是否可供文件助手使用。</p></div>
        <div className="form-row">
        <Field label="工具调用" hint="“测试”会自动更新此项。不支持工具调用的模型不会出现在用户的选择器里。">
          <select className="input" value={form.tools} onChange={event => setForm({ ...form, tools: event.target.value as ai.ToolSupport })}>
            <option value="unknown">未知</option><option value="yes">支持</option><option value="no">不支持</option>
          </select>
        </Field>
        <Field label="显示顺序" hint="数字越小越靠前。"><input className="input" type="number" min={0} max={100000} value={form.sort} onChange={event => setForm({ ...form, sort: event.target.value })} /></Field>
        </div>
        {error && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{error}</div>}
      </form>
    </Modal>
  );
}

/* ---------- 工具 ---------- */

function ToolsTab() {
  const [tools, setTools] = useState<ai.AdminTool[] | null>(null);
  const [draft, setDraft] = useState<Record<string, { enabled?: boolean; [param: string]: boolean | number | undefined }>>({});
  const [paramsFor, setParamsFor] = useState<ai.AdminTool | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => { void ai.adminTools().then(value => { setTools(value); setDraft({}); }).catch(reason => setError(api.errorMessage(reason, "工具加载失败"))); }, []);
  useEffect(load, [load]);
  const effective = useMemo(() => {
    if (!tools) return [];
    const enabled = (tool: ai.AdminTool) => tool.fixed || (draft[tool.name]?.enabled ?? tool.enabled) as boolean;
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    return tools.map(tool => ({ ...tool, on: enabled(tool) && tool.depends.every(dep => enabled(byName.get(dep)!)),
      blocked: tool.depends.some(dep => !enabled(byName.get(dep)!)) }));
  }, [tools, draft]);
  const groups = useMemo(() => {
    const result = new Map<string, typeof effective>();
    for (const tool of effective) result.set(tool.group_label, [...(result.get(tool.group_label) ?? []), tool]);
    return [...result.entries()];
  }, [effective]);
  const dirty = Object.keys(draft).length > 0;
  function toggle(name: string, value: boolean) { setDraft(current => ({ ...current, [name]: { ...current[name], enabled: value } })); }
  async function save() {
    setBusy(true); setError("");
    try {
      const payload: Record<string, Record<string, boolean | number>> = {};
      for (const [name, value] of Object.entries(draft)) payload[name] = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Record<string, boolean | number>;
      setTools(await ai.updateAdminTools(payload)); setDraft({}); toast.success("工具配置已保存，下一次模型调用时生效");
    } catch (reason) { setError(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }
  if (!tools) return error ? <Panel><EmptyState icon="alert" title="工具加载失败" description={error} action={<Button onClick={load}>重试</Button>} /></Panel> : <Panel><SkeletonRows rows={6} /></Panel>;
  return (
    <>
      <p className="inline-note banner"><Icon name="info" size={16} />停用的工具不会发送给模型，模型不知道它存在。需要确认的写入操作始终需要用户在界面上逐项确认，不能关闭。改动在下一次模型调用时生效。</p>
      {groups.map(([group, items]) => (
        <Panel key={group} title={group} flush className="assistant-tool-group"
          actions={items.some(tool => !tool.fixed) && <Button size="sm" variant="ghost" onClick={() => {
            const allOn = items.filter(tool => !tool.fixed).every(tool => tool.on);
            setDraft(current => { const next = { ...current }; for (const tool of items) if (!tool.fixed) next[tool.name] = { ...next[tool.name], enabled: !allOn }; return next; });
          }}>{items.filter(tool => !tool.fixed).every(tool => tool.on) ? "全部停用" : "全部启用"}</Button>}>
          <ul className="assistant-tool-list">
            {items.map(tool => (
              <li key={tool.name} className={tool.on ? "" : "is-off"}>
                <span className="assistant-tool-copy">
                  <span className="assistant-tool-head"><strong>{tool.label}</strong><code className="mono">{tool.name}</code><Badge tone={LEVELS[tool.level].tone}>{LEVELS[tool.level].label}</Badge>
                    {tool.warning && <span className="tone-warning assistant-tool-warning"><Icon name="alert" size={13} />{tool.warning}</span>}</span>
                  <small>{tool.description}</small>
                  {tool.blocked && <small className="tone-warning">依赖 {tool.depends.join("、")}，已随之停用</small>}
                </span>
                <span className="assistant-tool-actions">
                  {tool.params.length > 0 && <Button size="sm" variant="ghost" onClick={() => setParamsFor(tool)}>参数…</Button>}
                  {tool.fixed ? <span className="muted">固定启用</span>
                    : <Toggle label={`启用 ${tool.label}`} checked={(draft[tool.name]?.enabled ?? tool.enabled) as boolean} onChange={value => toggle(tool.name, value)} />}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ))}
      {error && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{error}</div>}
      {(dirty || busy) && <div className="settings-actions assistant-sticky-actions"><span className="settings-actions-note">有未保存的修改</span><Button variant="ghost" disabled={busy} onClick={() => setDraft({})}>放弃修改</Button><Button variant="primary" loading={busy} onClick={() => void save()}>保存工具配置</Button></div>}
      {paramsFor && <ToolParamsDialog tool={paramsFor} values={draft[paramsFor.name] ?? {}} onClose={() => setParamsFor(null)}
        onApply={values => { setDraft(current => ({ ...current, [paramsFor.name]: { ...current[paramsFor.name], ...values } })); setParamsFor(null); }} />}
    </>
  );
}

function ToolParamsDialog({ tool, values, onClose, onApply }: { tool: ai.AdminTool; values: Record<string, unknown>; onClose: () => void; onApply: (values: Record<string, number>) => void }) {
  const [form, setForm] = useState(() => Object.fromEntries(tool.params.map(param => [param.name, String(values[param.name] ?? param.value)])));
  const [error, setError] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    const result: Record<string, number> = {};
    for (const param of tool.params) {
      const value = Number(form[param.name]);
      if (!Number.isInteger(value) || value < param.min || value > param.max) { setError(`${param.label}必须在 ${param.min}–${param.max} 之间`); return; }
      result[param.name] = value;
    }
    onApply(result);
  }
  return (
    <Modal title={`${tool.label} · 参数`} size="sm" onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="tool-params-form">应用</Button></>}>
      <form id="tool-params-form" className="form" onSubmit={submit} noValidate>
        {tool.params.map(param => <Field key={param.name} label={param.label} hint={`默认 ${param.default}，范围 ${param.min}–${param.max}（硬上限）`}>
          <input className="input" type="number" min={param.min} max={param.max} value={form[param.name]} onChange={event => setForm({ ...form, [param.name]: event.target.value })} />
        </Field>)}
        {error && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{error}</div>}
        <p className="muted">应用后点击页面底部的“保存工具配置”才会生效。</p>
      </form>
    </Modal>
  );
}

/* ---------- 限制与额度 ---------- */

const LIMIT_GROUPS: { title: string; description: string; keys: string[] }[] = [
  { title: "Agent 循环", description: "每一轮对话（一条用户消息触发的处理）的上限。触达后助手会总结已完成的部分并停止。", keys: ["max_steps", "max_tool_calls", "parallel_calls", "repeat_threshold", "error_threshold", "run_seconds", "tool_seconds", "tool_result_bytes", "run_tokens"] },
  { title: "并发与容量", description: "单进程部署：并发过高会占用内存与模型服务额度。", keys: ["user_concurrency", "global_concurrency", "user_messages_per_minute", "max_messages", "max_conversations", "action_items", "download_urls"] },
];

function LimitsTab({ settings, onSaved }: { settings: ai.AssistantSettings | null; onSaved: (settings: ai.AssistantSettings) => void }) {
  const [limits, setLimits] = useState<ai.AssistantLimits | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reset = useCallback((value: ai.AssistantLimits, current: ai.AssistantSettings) => {
    setForm(Object.fromEntries(Object.entries(value.values).map(([key, item]) => [key, String(item)])));
    setGeneral({ user_daily_tokens: String(current.user_daily_tokens), retention_days: String(current.retention_days), call_log_days: String(current.call_log_days), notice: current.notice });
  }, []);
  useEffect(() => {
    if (!settings) return;
    void ai.adminLimits().then(value => { setLimits(value); reset(value, settings); }).catch(reason => setError(api.errorMessage(reason, "加载失败")));
  }, [settings === null]);
  if (!limits || !settings) return error ? <Panel><EmptyState icon="alert" title="加载失败" description={error} /></Panel> : <Panel><SkeletonRows rows={6} /></Panel>;
  const dirty = Object.entries(form).some(([key, value]) => value !== String(limits.values[key]))
    || general.user_daily_tokens !== String(settings.user_daily_tokens) || general.retention_days !== String(settings.retention_days)
    || general.call_log_days !== String(settings.call_log_days) || general.notice !== settings.notice;
  async function submit(event: FormEvent) {
    event.preventDefault();
    for (const [key, value] of Object.entries(form)) {
      const bound = limits!.bounds[key], parsed = Number(value);
      if (!value.trim() || !Number.isInteger(parsed) || parsed < bound.min || parsed > bound.max) { setError(`${bound.label}必须在 ${bound.min}–${bound.max} 之间`); return; }
    }
    for (const key of ["user_daily_tokens", "retention_days", "call_log_days"]) {
      const bound = settings!.bounds[key], parsed = Number(general[key]);
      if (!general[key].trim() || !Number.isInteger(parsed) || parsed < bound.min || parsed > bound.max) { setError(`${key === "user_daily_tokens" ? "每日额度" : "保留天数"}必须在 ${bound.min}–${bound.max} 之间`); return; }
    }
    setBusy(true); setError("");
    try {
      const values = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, Number(value)]));
      const next = await ai.updateAdminLimits(values);
      const saved = await ai.updateAdminSettings({ user_daily_tokens: Number(general.user_daily_tokens), retention_days: Number(general.retention_days),
        call_log_days: Number(general.call_log_days), notice: general.notice.trim() === settings!.notice_default ? null : general.notice });
      setLimits(next); onSaved(saved); reset(next, saved); toast.success("限制与额度已保存");
    } catch (reason) { setError(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }
  const numberField = (key: string, label: string, bound: ai.Bound, value: string, onChange: (value: string) => void) => (
    <Field key={key} label={label} hint={`默认 ${bound.default.toLocaleString("zh-CN")}，范围 ${bound.min.toLocaleString("zh-CN")}–${bound.max.toLocaleString("zh-CN")}`}>
      <input className="input" type="number" min={bound.min} max={bound.max} value={value} onChange={event => onChange(event.target.value)} />
    </Field>
  );
  return (
    <form className="assistant-limits" onSubmit={submit} noValidate>
      {LIMIT_GROUPS.map(group => <Panel key={group.title} title={group.title} description={group.description} className="assistant-limit-panel">
        <div className="assistant-limit-grid">{group.keys.map(key => numberField(key, limits.bounds[key].label, limits.bounds[key], form[key] ?? "", value => setForm({ ...form, [key]: value })))}</div>
      </Panel>)}
      <Panel title="额度与保留期" description="每个用户的默认额度可在“用户”页按人覆盖。" className="assistant-limit-panel">
        <div className="assistant-limit-grid">
          {numberField("user_daily_tokens", "每用户每日 token（0 为不限）", settings.bounds.user_daily_tokens, general.user_daily_tokens, value => setGeneral({ ...general, user_daily_tokens: value }))}
          {numberField("retention_days", "对话留痕保留天数", settings.bounds.retention_days, general.retention_days, value => setGeneral({ ...general, retention_days: value }))}
          {numberField("call_log_days", "调用日志保留天数", settings.bounds.call_log_days, general.call_log_days, value => setGeneral({ ...general, call_log_days: value }))}
        </div>
        <div className="assistant-notice-setting form settings-form"><Field label="首次使用说明" hint="用户第一次打开助手时显示，确认后才能发送消息。">
          <textarea className="input" rows={3} maxLength={2000} value={general.notice} onChange={event => setGeneral({ ...general, notice: event.target.value })} />
        </Field></div>
        <Button size="sm" variant="ghost" onClick={() => setGeneral({ ...general, notice: settings.notice_default })}>恢复默认说明</Button>
      </Panel>
      {error && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{error}</div>}
      {(dirty || busy) && <div className="settings-actions assistant-sticky-actions"><span className="settings-actions-note">有未保存的修改</span><Button variant="ghost" disabled={busy} onClick={() => reset(limits, settings)}>放弃修改</Button><Button type="submit" variant="primary" loading={busy}>保存</Button></div>}
    </form>
  );
}

/* ---------- 对话记录（仅元数据） ---------- */

const RANGES = { "1": "近 24 小时", "7": "近 7 天", "30": "近 30 天", all: "全部时间" };
const sinceOf = (range: string) => range === "all" ? undefined : Math.floor(Date.now() / 1000) - Number(range) * 86400;

function useUserOptions() {
  const [users, setUsers] = useState<api.Account[]>([]);
  useEffect(() => { void api.adminUsersPage(null).then(page => setUsers(page.users)).catch(() => undefined); }, []);
  return users;
}

function ConversationsTab() {
  const users = useUserOptions();
  const [userId, setUserId] = useState("");
  const [range, setRange] = useState("30");
  const [action, setAction] = useState("");
  const [items, setItems] = useState<ai.AdminConversation[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const filters = useMemo(() => ({ user_id: userId ? Number(userId) : undefined, since: sinceOf(range), action: action || undefined }), [userId, range, action]);
  const load = useCallback(() => {
    setItems(null); setError("");
    void ai.adminConversations(null, filters).then(page => { setItems(page.conversations); setCursor(page.next_cursor); }).catch(reason => setError(api.errorMessage(reason, "加载失败")));
  }, [filters]);
  useEffect(load, [load]);
  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try { const page = await ai.adminConversations(cursor, filters); setItems(current => [...(current ?? []), ...page.conversations]); setCursor(page.next_cursor); }
    catch (reason) { toast.error(api.errorMessage(reason, "加载失败")); }
    finally { setLoadingMore(false); }
  }
  return (
    <>
      <p className="inline-note banner"><Icon name="lock" size={16} />对话正文加密保存，只有用户本人能查看。这里只显示统计信息，用于了解使用情况和清理数据。</p>
      <div className="toolbar">
        <div className="toolbar-actions">
          <select className="input input-sm" aria-label="用户" value={userId} onChange={event => setUserId(event.target.value)}>
            <option value="">全部用户</option>{users.map(user => <option key={user.id} value={user.id}>{api.displayName(user)}</option>)}
          </select>
          <select className="input input-sm" aria-label="时间范围" value={range} onChange={event => setRange(event.target.value)}>{Object.entries(RANGES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select className="input input-sm" aria-label="操作" value={action} onChange={event => setAction(event.target.value)}>
            <option value="">全部</option><option value="pending">有待确认操作</option><option value="done">有已执行操作</option><option value="failed">有失败操作</option>
          </select>
        </div>
        <Button icon="trash" onClick={() => setDeleting(true)}>按条件删除…</Button>
      </div>
      <section className="file-surface table-scroll">
        {error ? <EmptyState icon="alert" title="加载失败" description={error} action={<Button onClick={load}>重试</Button>} /> : items === null ? <SkeletonRows rows={4} /> : items.length === 0 ? <EmptyState icon="list" title="没有对话记录" /> : (
          <div className="data-table assistant-conversations-table" role="table" aria-label="对话记录">
            <div className="data-row data-head" role="row"><span role="columnheader">对话</span><span role="columnheader">用户</span><span role="columnheader">模型</span><span role="columnheader">消息</span><span role="columnheader">轮次</span><span role="columnheader">操作</span><span role="columnheader">Token</span><span role="columnheader">最后活动</span><span role="columnheader">状态</span></div>
            {items.map(item => <div key={item.id} role="row" className="data-row is-clickable" tabIndex={0} onClick={() => setDetail(item.id)} onKeyDown={event => { if (event.key === "Enter") setDetail(item.id); }}>
              <span role="cell"><code className="mono">{item.id.slice(0, 10)}…</code></span>
              <span role="cell" className="cell-truncate" title={item.username ?? undefined}>{item.username ?? "—"}</span>
              <span role="cell" className="muted cell-truncate">{item.model_label ?? item.model_name ?? "已删除的模型"}</span>
              <span role="cell">{item.messages}</span>
              <span role="cell">{item.runs}</span>
              <span role="cell">{item.actions}</span>
              <span role="cell" className="muted">{tokens(item.input_tokens + item.output_tokens)}</span>
              <span role="cell" className="muted">{formatDateTime(item.updated_at)}</span>
              <span role="cell">{item.hidden ? <Badge>用户已删除</Badge> : item.archived ? <Badge>已归档</Badge> : <Badge tone="success">正常</Badge>}</span>
            </div>)}
          </div>
        )}
      </section>
      {cursor && <footer className="list-footer"><span /><Button size="sm" loading={loadingMore} onClick={() => void more()}>加载更多</Button></footer>}
      {detail && <ConversationDetailDialog id={detail} onClose={() => setDetail(null)} />}
      {deleting && <DeleteConversationsDialog users={users} onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); load(); }} />}
    </>
  );
}

const RUN_STATUS: Record<string, string> = { completed: "完成", running: "进行中", stopped: "已停止", failed: "失败", interrupted: "已中断", queued: "排队" };

function ConversationDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<ai.AdminConversationDetail | null>(null);
  useEffect(() => { void ai.adminConversation(id).then(setData).catch(reason => { toast.error(api.errorMessage(reason, "加载失败")); onClose(); }); }, [id]);
  return (
    <Modal title="对话统计" description="仅元数据：不包含标题、消息、工具参数与结果。" size="lg" onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
      {!data ? <SkeletonRows rows={4} /> : <div className="assistant-detail">
        <KeyValue items={[["对话 ID", <code className="mono" key="id">{data.id}</code>], ["用户", data.username ?? "—"], ["消息", `${data.messages} 条`],
          ["Token", `输入 ${tokens(data.input_tokens)} · 输出 ${tokens(data.output_tokens)}`], ["创建 / 最后活动", `${formatDateTime(data.created_at)} / ${formatDateTime(data.updated_at)}`]]} />
        <h3>运行</h3>
        <div className="data-table assistant-runs-table" role="table" aria-label="运行">
          <div className="data-row data-head" role="row"><span role="columnheader">开始</span><span role="columnheader">状态</span><span role="columnheader">停止原因</span><span role="columnheader">模型调用</span><span role="columnheader">工具调用</span><span role="columnheader">Token</span></div>
          {data.runs.map(run => <div className="data-row" role="row" key={run.id}>
            <span role="cell" className="muted">{formatDateTime(run.started_at)}</span><span role="cell">{RUN_STATUS[run.status] ?? run.status}</span>
            <span role="cell" className="muted">{run.stop_reason ?? "—"}</span><span role="cell">{run.steps}</span><span role="cell">{run.tool_calls}</span>
            <span role="cell" className="muted">{tokens(run.input_tokens + run.output_tokens)}</span>
          </div>)}
        </div>
        {data.tools.length > 0 && <><h3>工具调用</h3><p className="assistant-tool-counts">{data.tools.map(tool => <Badge key={tool.tool_name}>{tool.tool_name} × {tool.count}</Badge>)}</p></>}
        {data.actions.length > 0 && <><h3>操作</h3><KeyValue items={data.actions.map(item => [`${item.kind} · ${formatDateTime(item.created_at)}`, `${item.status} · ${item.count} 项`])} /></>}
      </div>}
    </Modal>
  );
}

function DeleteConversationsDialog({ users, onClose, onDeleted }: { users: api.Account[]; onClose: () => void; onDeleted: () => void }) {
  const [userId, setUserId] = useState("");
  const [before, setBefore] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState("");
  const input = () => ({ user_id: userId ? Number(userId) : undefined, before: before ? new Date(`${before}T00:00:00`).getTime() / 1000 : undefined });
  useEffect(() => {
    setCount(null); setError("");
    if (!userId && !before) return;
    void ai.deleteAdminConversations({ ...input(), dry_run: true }).then(result => setCount(result.count ?? 0)).catch(reason => setError(api.errorMessage(reason, "统计失败")));
  }, [userId, before]);
  return (
    <ConfirmDialog title="按条件删除对话" confirmLabel={count ? `删除 ${count} 个对话` : "删除"} onClose={onClose}
      description="删除对话及其消息、运行和操作记录，不可恢复。调用日志不受影响。"
      onConfirm={async () => {
        if (!count) { setError(userId || before ? "没有符合条件的对话" : "请至少选择用户或日期"); return; }
        try { const result = await ai.deleteAdminConversations(input()); toast.success(`已删除 ${result.deleted ?? 0} 个对话`); onDeleted(); }
        catch (reason) { setError(api.errorMessage(reason, "删除失败")); }
      }}>
      <Field label="用户"><select className="input" value={userId} onChange={event => setUserId(event.target.value)}><option value="">全部用户</option>{users.map(user => <option key={user.id} value={user.id}>{api.displayName(user)}</option>)}</select></Field>
      <Field label="最后活动早于" hint="留空表示不限日期。"><input className="input" type="date" value={before} onChange={event => setBefore(event.target.value)} /></Field>
      {count !== null && <p className="inline-note"><Icon name="info" size={16} />符合条件的对话：{count} 个</p>}
      {error && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{error}</div>}
    </ConfirmDialog>
  );
}

/* ---------- 调用日志 ---------- */

const CALL_KINDS: Record<string, string> = { model: "模型", tool: "工具", fetch: "抓取", sync: "同步", test: "测试" };
const CALL_STATUS: Record<string, { label: string; tone: Tone }> = {
  ok: { label: "成功", tone: "success" }, error: { label: "失败", tone: "danger" }, timeout: { label: "超时", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" }, limited: { label: "被限制", tone: "warning" },
};

function CallsTab() {
  const users = useUserOptions();
  const [channels, setChannels] = useState<ai.AiChannel[]>([]);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [userId, setUserId] = useState("");
  const [range, setRange] = useState("1");
  const [items, setItems] = useState<ai.AssistantCall[] | null>(null);
  const [stats, setStats] = useState<ai.CallStats | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void ai.adminChannels().then(setChannels).catch(() => undefined); }, []);
  const filters = useMemo<ai.CallFilters>(() => ({ kind: kind || undefined, status: status || undefined, channel_id: channel ? Number(channel) : undefined,
    user_id: userId ? Number(userId) : undefined, since: sinceOf(range) }), [kind, status, channel, userId, range]);
  const load = useCallback(() => {
    setItems(null); setError("");
    void ai.adminCalls(null, filters).then(page => { setItems(page.calls); setCursor(page.next_cursor); }).catch(reason => setError(api.errorMessage(reason, "加载失败")));
    void ai.adminCallStats(filters).then(setStats).catch(() => setStats(null));
  }, [filters]);
  useEffect(load, [load]);
  async function more() {
    if (cursor === null) return;
    try { const page = await ai.adminCalls(cursor, filters); setItems(current => [...(current ?? []), ...page.calls]); setCursor(page.next_cursor); }
    catch (reason) { toast.error(api.errorMessage(reason, "加载失败")); }
  }
  const select = (label: string, value: string, onChange: (value: string) => void, options: [string, string][]) => (
    <select className="input input-sm" aria-label={label} value={value} onChange={event => onChange(event.target.value)}>{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select>
  );
  return (
    <>
      <div className="toolbar">
        <div className="toolbar-actions">
          {select("类型", kind, setKind, [["", "全部类型"], ...Object.entries(CALL_KINDS)])}
          {select("状态", status, setStatus, [["", "全部状态"], ...Object.entries(CALL_STATUS).map(([key, item]) => [key, item.label] as [string, string])])}
          {select("渠道", channel, setChannel, [["", "全部渠道"], ...channels.map(item => [String(item.id), item.name] as [string, string])])}
          {select("用户", userId, setUserId, [["", "全部用户"], ...users.map(user => [String(user.id), api.displayName(user)] as [string, string])])}
          {select("时间", range, setRange, Object.entries(RANGES))}
        </div>
        <Button icon="refresh" onClick={load}>刷新</Button>
      </div>
      {stats && <div className="stat-strip assistant-stats assistant-call-stats">
        <Stat label="请求" value={stats.total.toLocaleString("zh-CN")} detail={`成功 ${stats.ok.toLocaleString("zh-CN")}`} />
        <Stat label="成功率" value={percent(stats.success_rate)} detail="所选范围" />
        <Stat label="P50 延迟" value={ms(stats.p50_ms)} detail="中位数" />
        <Stat label="P95 延迟" value={ms(stats.p95_ms)} detail="慢请求" />
        <Stat label="Token" value={tokens(stats.input_tokens + stats.output_tokens)} detail={`输入 ${tokens(stats.input_tokens)} · 输出 ${tokens(stats.output_tokens)}`} />
      </div>}
      <section className="file-surface table-scroll">
        {error ? <EmptyState icon="alert" title="加载失败" description={error} action={<Button onClick={load}>重试</Button>} /> : items === null ? <SkeletonRows rows={5} /> : items.length === 0 ? <EmptyState icon="list" title="没有调用记录" /> : (
          <div className="data-table assistant-calls-table" role="table" aria-label="调用日志">
            <div className="data-row data-head" role="row"><span role="columnheader">时间</span><span role="columnheader">类型</span><span role="columnheader">对象</span><span role="columnheader">用户</span><span role="columnheader">状态</span><span role="columnheader">耗时</span><span role="columnheader">首字</span><span role="columnheader">Token（入/出）</span></div>
            {items.map(item => <div key={item.id} className="assistant-call">
              <div role="row" className="data-row is-clickable" tabIndex={0} aria-expanded={expanded === item.id}
                onClick={() => setExpanded(current => current === item.id ? null : item.id)} onKeyDown={event => { if (event.key === "Enter") setExpanded(current => current === item.id ? null : item.id); }}>
                <span role="cell" className="muted mono">{new Date(item.started_at * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span>
                <span role="cell">{CALL_KINDS[item.kind] ?? item.kind}</span>
                <span role="cell" className="cell-truncate">{item.tool_name ?? (item.channel_name ? `${item.channel_name}${item.model_label || item.model_name ? ` / ${item.model_label ?? item.model_name}` : ""}` : item.host ?? "—")}</span>
                <span role="cell" className="muted cell-truncate">{item.username ?? item.actor ?? "—"}</span>
                <span role="cell"><Badge tone={CALL_STATUS[item.status]?.tone ?? "neutral"}>{CALL_STATUS[item.status]?.label ?? item.status}</Badge></span>
                <span role="cell" className="muted">{ms(item.duration_ms)}</span>
                <span role="cell" className="muted">{ms(item.ttfb_ms)}</span>
                <span role="cell" className="muted">{item.input_tokens != null ? `${tokens(item.input_tokens)} / ${tokens(item.output_tokens)}` : "—"}</span>
              </div>
              {expanded === item.id && <div className="assistant-call-detail"><KeyValue items={[
                ["上游请求 ID", item.upstream_id ? <code className="mono" key="u">{item.upstream_id}</code> : "—"],
                ["HTTP 状态", item.http_status ?? "—"], ["错误", item.error ? `${item.error_code ?? ""} ${item.error}` : item.error_code ?? "—"],
                ["条目数", item.items ?? "—"], ["缓存命中 token", tokens(item.cached_tokens)],
                ["对话 / 运行", item.conversation_id ? <code className="mono" key="c">{item.conversation_id} / {item.run_id}</code> : "—"],
              ]} /></div>}
            </div>)}
          </div>
        )}
      </section>
      {cursor !== null && <footer className="list-footer"><span /><Button size="sm" onClick={() => void more()}>加载更多</Button></footer>}
    </>
  );
}

/* ---------- 用户策略（在“用户”页的菜单中打开） ---------- */

export function AssistantPolicyDialog({ user, onClose }: { user: api.Account; onClose: () => void }) {
  const [policy, setPolicy] = useState<ai.UserPolicy | null>(null);
  const [form, setForm] = useState({ enabled: "inherit", max_level: "inherit", daily_tokens: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void ai.adminPolicy(user.id).then(value => {
      setPolicy(value);
      setForm({ enabled: value.enabled === null ? "inherit" : value.enabled ? "on" : "off", max_level: value.max_level ?? "inherit", daily_tokens: value.daily_tokens === null ? "" : String(value.daily_tokens) });
    }).catch(reason => setError(api.errorMessage(reason, "加载失败")));
  }, [user.id]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await ai.updateAdminPolicy(user.id, { enabled: form.enabled === "inherit" ? null : form.enabled === "on",
        max_level: form.max_level === "inherit" ? null : form.max_level as "read" | "write" | "danger",
        daily_tokens: form.daily_tokens.trim() === "" ? null : Number(form.daily_tokens) });
      toast.success(`已更新 ${api.displayName(user)} 的文件助手设置`); onClose();
    } catch (reason) { setError(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={`${api.displayName(user)} · 文件助手`} icon="sparkle" size="sm" onClose={onClose} dismissible={!busy}
      footer={<><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" type="submit" form="policy-form" loading={busy} disabled={!policy}>保存</Button></>}>
      {!policy ? (error ? <p className="form-alert">{error}</p> : <SkeletonRows rows={3} />) : <form id="policy-form" className="form" onSubmit={submit} noValidate>
        <Field label="使用权限"><select className="input" value={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.value })}>
          <option value="inherit">跟随全局（允许）</option><option value="on">允许</option><option value="off">禁止</option></select></Field>
        <Field label="最高操作级别" hint="只读：只能查询与统计；普通写入：可提议改名、移动、移入回收站等；含不可恢复操作：还可提议清空回收站。所有写入仍需用户逐项确认。">
          <select className="input" value={form.max_level} onChange={event => setForm({ ...form, max_level: event.target.value })}>
            <option value="inherit">跟随全局（普通写入）</option><option value="read">只读</option><option value="write">普通写入</option><option value="danger">含不可恢复操作</option></select></Field>
        <Field label="每日 token" hint={`留空跟随全局（当前 ${policy.effective.daily_tokens ? tokens(policy.effective.daily_tokens) : "不限"}），0 表示不限。`}>
          <input className="input" type="number" min={0} value={form.daily_tokens} onChange={event => setForm({ ...form, daily_tokens: event.target.value })} /></Field>
        <KeyValue items={[["今日用量", tokens(policy.usage.today)], ["近 30 天", tokens(policy.usage.days30)]]} />
        {error && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{error}</div>}
      </form>}
    </Modal>
  );
}
