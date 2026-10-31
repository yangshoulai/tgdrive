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

type Tab = "overview" | "channels" | "catalog" | "tools" | "limits" | "usage" | "conversations" | "calls";
/** 控制台五个标签，相关的页面并在一起，用分段切换；每个分段仍有自己的地址（/admin/assistant/<分段>），旧链接不受影响。 */
type Group = "overview" | "models" | "access" | "usage" | "conversations";
const GROUPS: { value: Group; label: string; icon: IconName; sections: { value: Tab; label: string }[] }[] = [
  { value: "overview", label: "概览", icon: "pulse", sections: [{ value: "overview", label: "概览" }] },
  { value: "models", label: "渠道与模型", icon: "server", sections: [{ value: "channels", label: "模型渠道" }, { value: "catalog", label: "模型目录" }] },
  { value: "access", label: "权限与工具", icon: "shield", sections: [{ value: "limits", label: "权限与额度" }, { value: "tools", label: "工具" }] },
  { value: "usage", label: "用量与日志", icon: "chart", sections: [{ value: "usage", label: "用量统计" }, { value: "calls", label: "调用日志" }] },
  { value: "conversations", label: "对话记录", icon: "chat", sections: [{ value: "conversations", label: "对话记录" }] },
];
const TABS = GROUPS.flatMap(group => group.sections);
const groupOf = (tab: Tab) => GROUPS.find(group => group.sections.some(section => section.value === tab))!;
const LEVELS: Record<ai.ToolLevel, { label: string; tone: Tone }> = {
  read: { label: "只读", tone: "neutral" }, meta: { label: "交互", tone: "neutral" }, scope: { label: "需确认", tone: "accent" },
  write: { label: "可修改", tone: "warning" }, danger: { label: "不可恢复", tone: "danger" },
};
const KIND_LABEL = { openai: "OpenAI 兼容", anthropic: "Anthropic" };
const channelLabel = (channel: ai.AiChannel) => channel.kind === "openai" && channel.protocol === "responses" ? "OpenAI Responses" : KIND_LABEL[channel.kind];
const KIND_EXAMPLE = { openai: "https://api.deepseek.com/v1", anthropic: "https://api.anthropic.com" };

export const tokens = (value: number | null | undefined) => value == null ? "—" : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e4 ? `${(value / 1e3).toFixed(1)}K` : value.toLocaleString("zh-CN");
const ms = (value: number | null | undefined) => value == null ? "—" : value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
/** 美元／百万 token 的价格。 */
export const price = (value: number | null | undefined) => value == null ? "—" : value === 0 ? "免费" : `$${value >= 10 ? value.toFixed(0) : value >= 1 ? value.toFixed(2).replace(/\.?0+$/, "") : value.toFixed(3).replace(/\.?0+$/, "")}`;
const CAPABILITY_LABELS: [keyof ai.Capabilities, string][] = [["tools", "工具"], ["reasoning", "推理"], ["vision", "识图"], ["structured", "结构化"]];
function CapabilityBadges({ value, tools }: { value: ai.Capabilities; tools?: ai.ToolSupport }) {
  const items = CAPABILITY_LABELS.filter(([key]) => key === "tools" ? (tools ? tools === "yes" : value.tools) : value[key]);
  return <span className="assistant-caps">{items.map(([key, label]) => <span key={key} className={`assistant-cap is-${key}`}>{label}</span>)}
    {tools === "no" && <span className="assistant-cap is-off">不支持工具</span>}</span>;
}
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
    { done: data.usable_models > 0, label: "从渠道选择模型并启用", tab: "channels" as Tab },
    { done: Boolean(settings?.default_model), label: "设为默认模型", tab: "channels" as Tab },
    { done: data.enabled, label: "打开右上角的总开关", tab: "overview" as Tab },
  ];
  const days = dailyUsage(data.usage_since, data.usage);
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
        <Stat label="今日对话" value={data.today.conversations} detail={`模型请求 ${data.today.requests} 次`} />
        <Stat label="今日 Token" value={tokens(data.today.tokens)} detail={`失败率 ${percent(data.today.failure_rate)}`} />
        <Stat label="启用工具" value={`${data.tools.enabled} / ${data.tools.total}`} detail="管理员可逐个停用" />
        <Stat label="待确认操作" value={data.today.pending_actions} detail={`今日已执行 ${data.today.executed_actions}`} />
      </div>
      <div className="overview-columns">
        <div className="overview-column">
          <Panel title="近 30 天 Token 用量" description="输入与输出合计，按天汇总。">
            {data.usage.length ? <UsageCurve days={days} /> : <p className="muted">暂无用量数据</p>}
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
            <div className="assistant-danger-zone"><Button variant="ghost-danger" icon="trash" onClick={() => { setConfirmText(""); setPurging(true); }}>清除所有助手数据</Button></div>
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

/** 概览的用量按天与模型分组：先按天合计，再补齐 30 天。 */
function dailyUsage(since: string, points: ai.UsagePoint[]) {
  const map = new Map<string, { day: string; input_tokens: number; output_tokens: number }>();
  for (const point of points) {
    const row = map.get(point.day) ?? { day: point.day, input_tokens: 0, output_tokens: 0 };
    row.input_tokens += point.input_tokens ?? 0; row.output_tokens += point.output_tokens ?? 0;
    map.set(point.day, row);
  }
  return fillDays(since, 30, [...map.values()]);
}

type UsageDay = { day: string; input: number; output: number; total: number };

/** 补齐区间内没有用量的日期（记为 0），曲线和日期刻度才连续；日期按字符串计算，不受时区影响。 */
function fillDays(since: string, count: number, rows: { day: string; input_tokens: number | null; output_tokens: number | null }[]): UsageDay[] {
  const known = new Map(rows.map(row => [row.day, row]));
  const start = Date.UTC(Number(since.slice(0, 4)), Number(since.slice(5, 7)) - 1, Number(since.slice(8, 10)));
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(start + index * 86400000).toISOString().slice(0, 10);
    const row = known.get(day);
    const input = row?.input_tokens ?? 0, output = row?.output_tokens ?? 0;
    return { day, input, output, total: input + output };
  });
}

/** 每日 Token 与概览流量共用曲线样式及交互。 */
function UsageCurve({ days }: { days: UsageDay[] }) {
  return <CurveChart label={`近 ${days.length} 天 Token 用量曲线`} selectionLabel="选择日期" formatValue={tokens}
    points={days.map(day => ({ id: day.day, tick: day.day.slice(5), values: [day.total],
      description: `${day.day}：${tokens(day.total)} token（输入 ${tokens(day.input)} · 输出 ${tokens(day.output)}）` }))} />;
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
          <Stat label="运行次数" value={report.totals.runs} detail={`自 ${report.since}`} />
          <Stat label="使用人数" value={report.totals.users} detail="有用量的账号" />
          <Stat label="估算费用" value={report.totals.cost == null ? "—" : `$${report.totals.cost.toFixed(report.totals.cost >= 10 ? 0 : 2)}`} detail="按模型目录价格估算，仅供参考" />
        </div>
        <Panel title="每日 Token 用量" description="输入与输出合计。">
          {report.by_day.length ? <UsageCurve days={fillDays(report.since, report.days, report.by_day)} /> : <p className="muted">暂无用量数据</p>}
        </Panel>
        <div className="assistant-usage-grid">
          <Panel title="按用户" description="用量最多的 50 个账号。">
            <UsageTable rows={report.by_user.map(row => [row.nickname || row.username || `#${row.user_id}`, row])} empty="暂无用户用量" />
          </Panel>
          <Panel title="按模型" description="对话所用模型（含标题生成与结构分析）。">
            <UsageTable rows={report.by_model.map(row => [row.model_label || row.model_name ? `${row.channel_name ?? ""} / ${row.model_label || row.model_name}` : "已删除的模型", row])} empty="暂无模型用量" cost />
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

function UsageTable({ rows, empty, cost = false }: { rows: [string, { input_tokens: number | null; output_tokens: number | null; runs: number | null; cost?: number | null }][]; empty: string; cost?: boolean }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return <div className="data-table assistant-usage-table" role="table">
    <div className="data-row data-head" role="row"><span role="columnheader">名称</span><span role="columnheader">Token</span><span role="columnheader">输入 / 输出</span><span role="columnheader">{cost ? "估算费用" : "运行"}</span></div>
    {rows.map(([label, row], index) => <div className="data-row" role="row" key={index}>
      <span role="cell" className="cell-truncate" title={label}>{label}</span><span role="cell">{tokens((row.input_tokens ?? 0) + (row.output_tokens ?? 0))}</span>
      <span role="cell" className="muted">{tokens(row.input_tokens)} / {tokens(row.output_tokens)}</span>
      <span role="cell">{cost ? (row.cost == null ? "—" : `$${row.cost.toFixed(row.cost >= 10 ? 0 : 2)}`) : (row.runs ?? 0).toLocaleString("zh-CN")}</span>
    </div>)}
  </div>;
}

/* ---------- 渠道与模型 ---------- */

const CHANNEL_STEPS = [
  { title: "在模型服务商处创建 API Key", body: <p>在服务商控制台创建 Key 并确认账户有余额或额度。Key 保存后只以密文存在，界面只显示掩码。</p> },
  { title: "添加渠道，填写 Base URL", body: <>
    <p>大多数服务选「OpenAI 兼容」，Claude 官方接口选「Anthropic」。常用地址：</p>
    <table><thead><tr><th>服务</th><th>类型</th><th>Base URL</th></tr></thead><tbody>
      <tr><td>OpenAI</td><td>OpenAI 兼容</td><td><code>https://api.openai.com/v1</code></td></tr>
      <tr><td>DeepSeek</td><td>OpenAI 兼容</td><td><code>https://api.deepseek.com/v1</code></td></tr>
      <tr><td>通义千问</td><td>OpenAI 兼容</td><td><code>https://dashscope.aliyuncs.com/compatible-mode/v1</code></td></tr>
      <tr><td>Kimi</td><td>OpenAI 兼容</td><td><code>https://api.moonshot.cn/v1</code></td></tr>
      <tr><td>OpenRouter</td><td>OpenAI 兼容</td><td><code>https://openrouter.ai/api/v1</code></td></tr>
      <tr><td>Ollama（本机）</td><td>OpenAI 兼容</td><td><code>http://127.0.0.1:11434/v1</code>；在 Docker 中运行时改用宿主机地址</td></tr>
      <tr><td>Anthropic</td><td>Anthropic</td><td><code>https://api.anthropic.com</code></td></tr>
    </tbody></table>
  </> },
  { title: "选择要用的模型", body: <p>在渠道详情中点「选择模型」列出上游提供的模型，勾选后加入；再点模型行的「测试」确认能正常回复。工具调用能力和上下文长度会从模型目录自动补全，没有匹配时请手动填写。</p> },
  { title: "设为默认模型并启用助手", body: <p>在模型行的菜单中选「设为默认」，再打开页面右上角的「启用文件助手」。用户只能使用已启用的模型，额度与工具范围在「限制与额度」「工具」中调整。</p> },
];

function ChannelsTab({ settings, onChanged }: { settings: ai.AssistantSettings | null; onChanged: () => void }) {
  const [channels, setChannels] = useState<ai.AiChannel[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<ai.AiChannel | "new" | null>(null);
  const [deleting, setDeleting] = useState<ai.AiChannel | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
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
      <SetupGuide id="assistant-channels" title="接入模型指南" description="渠道是模型服务的接口地址加 API Key，接好后选择模型、设为默认。" docHref="/docs/admin-assistant"
        defaultOpen={channels.length === 0} steps={CHANNEL_STEPS} />
      {channels.length === 0 ? <Panel><EmptyState icon="server" title="还没有模型渠道" description="渠道是一个模型服务的接口地址和 API Key。支持 OpenAI 兼容接口（OpenAI、DeepSeek、通义、Kimi、OpenRouter、Ollama 等）和 Anthropic。"
        action={<Button variant="primary" icon="plus" onClick={() => setEditing("new")}>添加渠道</Button>} /></Panel> : (
        <div className="assistant-channels">
          <Panel title="模型渠道" description="选择渠道，管理连接与模型。" className="assistant-channel-nav" flush actions={<Button size="sm" icon="plus" onClick={() => setEditing("new")}>添加</Button>}>
            <ul className="assistant-channel-list" role="listbox" aria-label="渠道">
              {channels.map(item => <li key={item.id}>
                <button type="button" role="option" aria-selected={item.id === selected} className={item.id === selected ? "is-active" : ""} onClick={() => setSelected(item.id)}>
                  <i className={`assistant-dot${!item.enabled ? "" : item.health?.unhealthy ? " is-danger" : " is-success"}`} aria-hidden="true" />
                  <span className="name-stack"><strong>{item.name}</strong><small>{channelLabel(item)} · {item.enabled_models}/{item.models} 个模型启用</small></span>
                  {!item.enabled ? <Badge>已停用</Badge> : item.health?.unhealthy ? <Badge tone="danger">异常</Badge> : null}
                </button>
              </li>)}
            </ul>
          </Panel>
          {channel && <ChannelDetail key={`${channel.id}-${picking === null}`} channel={channel} defaultModel={settings?.default_model ?? null}
            onEdit={() => setEditing(channel)} onDelete={() => setDeleting(channel)} onPick={() => setPicking(channel.id)} onChanged={() => { load(); onChanged(); }} />}
        </div>
      )}
      {editing && <ChannelDialog channel={editing === "new" ? null : editing} onClose={() => setEditing(null)}
        onSaved={(saved, created) => { setEditing(null); setSelected(saved.id); load(); onChanged(); if (created) setPicking(saved.id); }} />}
      {picking !== null && <ModelPickerDialog channel={channels.find(item => item.id === picking) ?? null} channelId={picking}
        onClose={() => setPicking(null)} onAdded={() => { load(); onChanged(); }} />}
      {deleting && <ConfirmDialog title={`删除渠道 ${deleting.name}？`} confirmLabel="删除渠道" onClose={() => setDeleting(null)}
        description="渠道下的模型一并删除，已有对话中的引用会显示为“已删除的模型”。调用日志保留。"
        onConfirm={async () => {
          try { await ai.deleteAdminChannel(deleting.id); toast.success("渠道已删除"); setDeleting(null); load(); onChanged(); }
          catch (reason) { toast.error(api.errorMessage(reason, "删除失败")); }
        }} />}
    </>
  );
}

function ChannelDetail({ channel, defaultModel, onEdit, onDelete, onPick, onChanged }: { channel: ai.AiChannel; defaultModel: number | null; onEdit: () => void; onDelete: () => void; onPick: () => void; onChanged: () => void }) {
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
    try { const result = await ai.syncAdminChannel(channel.id); toast.success(result.note); load(); onChanged(); }
    catch (reason) { toast.error(api.errorMessage(reason, "检查失败")); }
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
    <Panel flush className="assistant-channel-detail" title={<span className="assistant-channel-title"><span className="assistant-channel-symbol"><Icon name="server" size={20} /></span><span>{channel.name}<small>{channelLabel(channel)}</small></span><Badge tone={channel.enabled ? "success" : "neutral"} dot>{channel.enabled ? "已启用" : "已停用"}</Badge></span>}
      actions={<>
        <Button size="sm" variant="primary" icon="plus" onClick={onPick}>选择模型</Button>
        <Button size="sm" icon="edit" onClick={onEdit}>编辑</Button>
        <Menu label={`${channel.name} 的更多操作`} items={[
          { label: syncing ? "正在检查上游…" : "检查上游", description: "标记上游已经下线的模型", icon: "refresh", onSelect: () => void sync() },
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
      <div className="assistant-model-heading"><h3>已加入的模型 <span>{models?.length ?? "—"}</span></h3><p>上下文、价格与能力来自模型目录，可在模型配置中手动覆盖。启用的模型出现在用户的模型选择器里。</p></div>
      <div className="toolbar assistant-model-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="搜索模型" label="搜索模型" />
        <div className="toolbar-actions">
          <Segmented label="筛选模型" value={filter} onChange={setFilter} options={[{ value: "all", label: "全部" }, { value: "enabled", label: "已启用" }, { value: "disabled", label: "未启用" }]} />
          <Button size="sm" icon="plus" variant="ghost" onClick={() => setAdding(true)}>手动添加</Button>
        </div>
      </div>
      {models === null ? <SkeletonRows rows={3} /> : shown.length === 0 ? <EmptyState icon="box" title={models.length ? "没有匹配的模型" : "还没有加入模型"}
        description={models.length ? undefined : "从这个渠道的模型列表中选择需要的模型，系统会按模型目录自动填好上下文、价格与能力。"}
        action={models.length ? undefined : <Button variant="primary" icon="plus" onClick={onPick}>选择模型</Button>} /> : (
        <div className="file-surface table-scroll"><div className="data-table assistant-models-table" role="table" aria-label="模型">
          <div className="data-row data-head" role="row"><span role="columnheader">启用</span><span role="columnheader">模型</span><span role="columnheader">上下文</span><span role="columnheader">价格（$/M）</span><span role="columnheader"><span className="sr-only">操作</span></span></div>
          {shown.map(model => (
            <div className="data-row" role="row" key={model.id}>
              <span role="cell"><Switch compact label={`启用 ${model.label}`} checked={model.enabled}
                onChange={value => void update(model, { enabled: value }, value && model.tools !== "yes" ? "已启用。建议先点“测试”确认它支持工具调用" : undefined)} /></span>
              <span role="cell" className="name-stack">
                <strong>{model.label}{model.id === defaultModel && <Badge tone="accent">默认</Badge>}{model.removed_upstream && <Badge tone="warning">上游已移除</Badge>}
                  {model.private_ok && <Badge icon="lock" tone="public">私密对话</Badge>}</strong>
                <small className="assistant-model-sub"><code className="mono" title={model.test_note ?? model.model}>{model.model}</code>
                  <CapabilityBadges value={model.capabilities} tools={model.tools} />{!model.catalog_id && <span className="assistant-cap is-off">目录未收录</span>}</small>
              </span>
              <span role="cell" className="muted">{model.context_window ? tokens(model.context_window) : "—"}</span>
              <span role="cell" className="muted">{model.input_price == null && model.output_price == null ? "—" : `${price(model.input_price)} / ${price(model.output_price)}`}</span>
              <span role="cell" className="cell-actions">
                <Button size="sm" variant="ghost" loading={testing === model.id} onClick={() => void test(model)}>测试</Button>
                <Menu label={`${model.label} 的操作`} items={[
                  { label: "设为默认", icon: "check", onSelect: () => void setDefault(model) },
                  { label: "编辑", icon: "edit", onSelect: () => setEditingModel(model) },
                  { label: model.private_ok ? "不再用于私密对话" : "允许用于私密对话", icon: "lock", onSelect: () => void update(model, { private_ok: !model.private_ok },
                    model.private_ok ? "已不再用于私密对话" : "已允许用于私密对话：私密空间中的文件名与内容会发送给这个模型") },
                  ...(model.id !== defaultModel ? [{ label: "从系统移除", icon: "trash" as const, danger: true, divider: true, onSelect: () => void remove(model) }] : []),
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

function ChannelDialog({ channel, onClose, onSaved }: { channel: ai.AiChannel | null; onClose: () => void; onSaved: (channel: ai.AiChannel, created: boolean) => void }) {
  const [clearHeaders, setClearHeaders] = useState(false);
  const [form, setForm] = useState({ name: channel?.name ?? "", kind: channel?.kind ?? "openai" as ai.AiChannel["kind"], base_url: channel?.base_url ?? "",
    protocol: channel?.protocol ?? "chat_completions" as ai.ChannelProtocol,
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
    if (form.kind === "openai") input.protocol = form.protocol;
    if (!channel) input.kind = form.kind;
    if (form.api_key.trim()) input.api_key = form.api_key.trim();
    if (clearHeaders || form.headers.trim() || !channel) input.headers = clearHeaders ? {} : headers;
    setBusy(true); setError("");
    try {
      const saved = channel ? await ai.updateAdminChannel(channel.id, input) : await ai.createAdminChannel(input);
      toast.success(channel ? "渠道已保存" : "渠道已添加，请选择要加入的模型");
      onSaved(saved, !channel);
    } catch (reason) { setError(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={channel ? "编辑模型渠道" : "添加模型渠道"} icon="server" onClose={onClose} dismissible={!busy}
      description={channel ? "API Key 留空表示不修改。" : "保存后从这个渠道的模型列表中选择要加入的模型。API Key 加密保存，不会再次显示。"}
      footer={<><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" type="submit" form="channel-form" loading={busy}>{channel ? "保存" : "添加并选择模型"}</Button></>}>
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
        {form.kind === "openai" && <Field label="接口方式" hint={form.protocol === "responses"
          ? "用于支持 Responses 的官方接口或中转，主动请求并流式展示思考摘要；请选择支持思考摘要的模型。"
          : "兼容提供 Chat Completions 的服务；思考正文取决于渠道实际返回的字段。"}>
          <select className="input" value={form.protocol} onChange={event => setForm({ ...form, protocol: event.target.value as ai.ChannelProtocol })}>
            <option value="chat_completions">Chat Completions</option><option value="responses">Responses（思考摘要）</option>
          </select>
        </Field>}
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
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Modal>
  );
}

const initialVision = (model: ai.AiModel | null): "auto" | "yes" | "no" =>
  model?.manual_fields.includes("vision") ? (model.capabilities.vision === true ? "yes" : "no") : "auto";

function ModelDialog({ channelId, model, onClose, onSaved }: { channelId: number; model: ai.AiModel | null; onClose: () => void; onSaved: () => void }) {
  const initial = (value: number | null | undefined) => value == null ? "" : String(value);
  const [form, setForm] = useState({ model: model?.model ?? "", display_name: model?.display_name ?? "", context_window: initial(model?.context_window),
    max_output: initial(model?.max_output), tools: model?.tools ?? "unknown" as ai.ToolSupport, sort: String(model?.sort ?? 0),
    input_price: initial(model?.input_price), output_price: initial(model?.output_price), vision: initialVision(model), private_ok: Boolean(model?.private_ok) });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const number = (value: string) => value.trim() ? Number(value) : null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!model && !form.model.trim()) { setError("请填写模型 ID"); return; }
    for (const [key, label, high] of [["context_window", "上下文窗口", 100000000], ["max_output", "最大输出", 10000000], ["sort", "显示顺序", 100000]] as const) {
      const value = number(form[key]);
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > high)) { setError(`${label}必须是 0–${high.toLocaleString("zh-CN")} 的整数`); return; }
    }
    for (const key of ["input_price", "output_price"] as const) {
      const value = number(form[key]);
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100000)) { setError("价格必须是 0–100000 之间的数字"); return; }
    }
    const values = { display_name: form.display_name.trim() || null, context_window: number(form.context_window), max_output: number(form.max_output),
      tools: form.tools, sort: Number(form.sort), input_price: number(form.input_price), output_price: number(form.output_price), private_ok: form.private_ok,
      // 只在改动时提交：提交会把它标记为手动值或恢复为跟随目录。
      ...(form.vision !== initialVision(model) ? { vision: form.vision } : {}) };
    setBusy(true); setError("");
    try {
      if (model) await ai.updateAdminModel(model.id, values);
      else await ai.addAdminModel(channelId, { model: form.model.trim(), ...values });
      toast.success(model ? "模型已保存" : "模型已添加，默认停用");
      onSaved();
    } catch (reason) { setError(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }
  async function reset() {
    if (!model) return;
    setBusy(true);
    try { await ai.updateAdminModel(model.id, { reset_catalog: true }); toast.success("已恢复为模型目录中的信息"); onSaved(); }
    catch (reason) { setError(api.errorMessage(reason, "恢复失败")); }
    finally { setBusy(false); }
  }
  const manual = new Set(model?.manual_fields ?? []);
  const tag = (field: string) => manual.has(field) ? "（已手动修改）" : "";
  return (
    <Modal title={model ? "模型配置" : "手动添加模型"} description={model ? (model.catalog_id ? `正在配置 ${model.model} · 目录条目 ${model.catalog_id}` : `正在配置 ${model.model} · 模型目录未收录`) : "模型 ID 需与服务商接口一致，新模型默认停用。"}
      icon="server" onClose={onClose} dismissible={!busy}
      footer={<>{model && manual.size > 0 && model.catalog_id && <Button variant="ghost" icon="restore" disabled={busy} onClick={() => void reset()}>恢复目录值</Button>}
        <Button onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" type="submit" form="model-form" loading={busy}>保存</Button></>}>
      <form id="model-form" className="form assistant-config-form" onSubmit={submit} noValidate>
        {!model && <Field label="模型 ID" hint="与上游接口中的 model 参数一致。"><input className="input mono" value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} autoFocus /></Field>}
        <Field label="显示名" hint="用户在模型选择器里看到的名称，留空使用模型 ID。"><input className="input" value={form.display_name} maxLength={80} onChange={event => setForm({ ...form, display_name: event.target.value })} /></Field>
        <div className="assistant-form-section"><h3>上下文与输出</h3><p>来自模型目录；修改后会标记为手动值，之后目录同步不再覆盖。</p></div>
        <div className="form-row">
          <Field label={`上下文窗口${tag("context_window")}`} hint="token 数，用于决定何时压缩历史。"><input className="input" type="number" min={0} value={form.context_window} onChange={event => setForm({ ...form, context_window: event.target.value })} /></Field>
          <Field label={`最大输出${tag("max_output")}`} hint="留空由服务决定。"><input className="input" type="number" min={0} value={form.max_output} onChange={event => setForm({ ...form, max_output: event.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label={`输入价格${tag("input_price")}`} hint="美元／百万 token，用于估算费用。"><input className="input" type="number" min={0} step="any" value={form.input_price} onChange={event => setForm({ ...form, input_price: event.target.value })} /></Field>
          <Field label={`输出价格${tag("output_price")}`} hint="美元／百万 token。"><input className="input" type="number" min={0} step="any" value={form.output_price} onChange={event => setForm({ ...form, output_price: event.target.value })} /></Field>
        </div>
        <div className="assistant-form-section"><h3>能力与展示</h3><p>工具调用支持决定模型是否可供文件助手使用。</p></div>
        <div className="form-row">
          <Field label={`工具调用${tag("tools")}`} hint="“测试”会自动更新此项。不支持工具调用的模型不会出现在用户的选择器里。">
            <select className="input" value={form.tools} onChange={event => setForm({ ...form, tools: event.target.value as ai.ToolSupport })}>
              <option value="unknown">未知</option><option value="yes">支持</option><option value="no">不支持</option>
            </select>
          </Field>
          <Field label="显示顺序" hint="数字越小越靠前。"><input className="input" type="number" min={0} max={100000} value={form.sort} onChange={event => setForm({ ...form, sort: event.target.value })} /></Field>
        </div>
        <Field label={`图片输入（识图）${tag("vision")}`} hint={`支持时，用户 @ 或上传的图片会以预览图发给模型，并可使用「查看图片」工具。${!model?.catalog_id ? "模型目录未收录这个模型，跟随目录时按不支持处理。"
          : manual.has("vision") ? "已手动设置，改回「跟随模型目录」后使用目录中的值。"
          : `模型目录中为「${model.capabilities.vision === true ? "支持" : model.capabilities.vision === false ? "不支持" : "未声明（按不支持处理）"}」。`}`}>
          <select className="input" value={form.vision} onChange={event => setForm({ ...form, vision: event.target.value as "auto" | "yes" | "no" })}>
            <option value="auto">跟随模型目录</option><option value="yes">支持</option><option value="no">不支持</option>
          </select>
        </Field>
        <Switch label="允许用于私密对话" checked={form.private_ok} onChange={value => setForm({ ...form, private_ok: value })}
          description="私密对话会把私密空间里的文件名、目录结构以及读取的文本和图片发给这个模型，只为你信任的模型服务开启。全局开关在“限制与额度”。" />
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Modal>
  );
}

/** 从渠道的上游模型列表中勾选要加入的模型；目录匹配到的上下文、价格与能力一并展示。 */
function ModelPickerDialog({ channel, channelId, onClose, onAdded }: { channel: ai.AiChannel | null; channelId: number; onClose: () => void; onAdded: () => void }) {
  const [items, setItems] = useState<ai.UpstreamModel[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [toolsOnly, setToolsOnly] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setItems(null); setError("");
    void ai.discoverChannelModels(channelId).then(result => setItems(result.models)).catch(reason => setError(api.errorMessage(reason, "读取模型列表失败")));
  }, [channelId]);
  useEffect(load, [load]);
  const shown = (items ?? []).filter(item => (!toolsOnly || item.capabilities.tools)
    && (!search.trim() || `${item.model} ${item.display_name ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())));
  const available = shown.filter(item => !item.added);
  const allChosen = available.length > 0 && available.every(item => chosen.has(item.model));
  function toggle(model: string, value: boolean) { setChosen(current => { const next = new Set(current); if (value) next.add(model); else next.delete(model); return next; }); }
  async function submit() {
    setBusy(true);
    try {
      const result = await ai.addChannelModels(channelId, [...chosen]);
      toast.success(`已加入 ${result.added} 个模型${result.enabled ? `，其中 ${result.enabled} 个支持工具调用，已启用` : "，测试后即可启用"}`);
      onAdded(); onClose();
    } catch (reason) { toast.error(api.errorMessage(reason, "加入失败")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="选择模型" description={`从 ${channel?.name ?? "渠道"} 的模型列表中勾选要加入的模型。上下文、价格与能力来自模型目录。`} icon="server" size="lg" onClose={onClose} dismissible={!busy}
      footer={<><span className="assistant-picker-count">已选择 {chosen.size} 个</span><Button onClick={onClose} disabled={busy}>取消</Button>
        <Button variant="primary" loading={busy} disabled={!chosen.size} onClick={() => void submit()}>加入 {chosen.size || ""} 个模型</Button></>}>
      <div className="toolbar assistant-picker-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="搜索模型 ID 或名称" label="搜索模型" />
        <div className="toolbar-actions">
          <Segmented label="筛选" value={toolsOnly ? "tools" : "all"} onChange={value => setToolsOnly(value === "tools")} options={[{ value: "all", label: "全部" }, { value: "tools", label: "支持工具调用" }]} />
        </div>
      </div>
      {error ? <EmptyState icon="alert" title="读取模型列表失败" description={error} action={<Button onClick={load}>重试</Button>} />
        : items === null ? <SkeletonRows rows={6} />
        : shown.length === 0 ? <EmptyState icon="box" title={items.length ? "没有匹配的模型" : "上游没有返回模型"} description={items.length ? undefined : "可以关闭后用“手动添加”填写模型 ID。"} />
        : <div className="file-surface table-scroll assistant-picker"><div className="data-table assistant-picker-table" role="table" aria-label="上游模型">
          <div className="data-row data-head" role="row">
            <span role="columnheader" className="cell-check"><Checkbox label="全选" checked={allChosen} indeterminate={!allChosen && available.some(item => chosen.has(item.model))}
              onChange={value => setChosen(current => { const next = new Set(current); for (const item of available) { if (value) next.add(item.model); else next.delete(item.model); } return next; })} /></span>
            <span role="columnheader">模型</span><span role="columnheader">上下文</span><span role="columnheader">价格（$/M）</span>
          </div>
          {shown.map(item => <label key={item.model} role="row" className={`data-row${item.added ? " is-disabled" : chosen.has(item.model) ? " is-selected" : ""}`}>
            <span role="cell" className="cell-check">{item.added ? <Icon name="check" size={15} /> : <Checkbox label={`选择 ${item.model}`} checked={chosen.has(item.model)} onChange={value => toggle(item.model, value)} />}</span>
            <span role="cell" className="name-stack"><strong>{item.display_name ?? item.model}{item.added && <Badge>已加入</Badge>}</strong>
              <small className="assistant-model-sub"><code className="mono">{item.model}</code><CapabilityBadges value={item.capabilities} />
                {!item.catalog_id && <span className="assistant-cap is-off">目录未收录</span>}</small></span>
            <span role="cell" className="muted">{item.context_window ? tokens(item.context_window) : "—"}</span>
            <span role="cell" className="muted">{item.input_price == null && item.output_price == null ? "—" : `${price(item.input_price)} / ${price(item.output_price)}`}</span>
          </label>)}
        </div></div>}
    </Modal>
  );
}

/* ---------- 模型目录 ---------- */

function CatalogTab() {
  const [data, setData] = useState<Awaited<ReturnType<typeof ai.adminCatalog>> | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<ai.CatalogEntry | "new" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [more, setMore] = useState(false);
  const load = useCallback((cursor: string | null = null) => {
    if (!cursor) setError("");
    void ai.adminCatalog({ q: query, provider, cursor }).then(value => setData(current => cursor && current ? { ...value, entries: [...current.entries, ...value.entries] } : value))
      .catch(reason => setError(api.errorMessage(reason, "模型目录加载失败"))).finally(() => setMore(false));
  }, [query, provider]);
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search.trim()), 250); return () => window.clearTimeout(timer); }, [search]);
  useEffect(() => load(), [load]);
  async function sync() {
    setSyncing(true);
    try { const result = await ai.syncCatalog(); toast.success(`模型目录已同步：${result.note}${result.models ? `，更新了 ${result.models} 个渠道模型` : ""}`); load(); }
    catch (reason) { toast.error(api.errorMessage(reason, "同步失败")); load(); }
    finally { setSyncing(false); }
  }
  async function remove(entry: ai.CatalogEntry) {
    try { await ai.deleteCatalogEntry(entry.id); toast.success("已删除手动条目"); load(); }
    catch (reason) { toast.error(api.errorMessage(reason, "删除失败")); }
  }
  if (error && !data) return <Panel><EmptyState icon="alert" title="模型目录加载失败" description={error} action={<Button onClick={() => load()}>重试</Button>} /></Panel>;
  if (!data) return <Panel><SkeletonRows rows={6} /></Panel>;
  const status = data.status;
  return <div className="assistant-admin-stack">
    <Panel title="数据来源" description="模型目录记录上下文、输出上限、能力与价格。渠道加入模型时按模型 ID 自动匹配；手动新增或编辑过的条目不会被同步覆盖。"
      actions={<><Button size="sm" icon="settings" onClick={() => setSettingsOpen(true)}>来源设置</Button><Button size="sm" variant="primary" icon="refresh" loading={syncing} onClick={() => void sync()}>立即同步</Button></>}>
      <KeyValue items={[
        ["来源", <code className="mono" key="url">{status.url}</code>],
        ["自动同步", status.auto_sync ? "每天一次（配置了模型渠道后）" : "已关闭"],
        ["上次同步", status.synced_at ? `${formatDateTime(status.synced_at)}${status.note ? `，${status.note}` : ""}` : "尚未同步"],
        ["收录", `${status.total.toLocaleString("zh-CN")} 个模型 · ${status.providers} 个服务商 · 手动 ${status.manual} 个`],
        ...(status.error ? [["最近错误", <span className="tone-danger" key="error">{status.error}</span>] as [ReactNode, ReactNode]] : []),
      ]} />
    </Panel>
    <Panel flush title="目录条目" actions={<Button size="sm" icon="plus" onClick={() => setEditing("new")}>手动新增</Button>}>
      <div className="toolbar assistant-model-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="搜索模型 ID 或名称" label="搜索目录" />
        <div className="toolbar-actions">
          <select className="input input-sm" aria-label="服务商" value={provider} onChange={event => setProvider(event.target.value)}>
            <option value="">全部服务商</option>{data.providers.map(item => <option key={item.provider} value={item.provider}>{item.provider}（{item.count}）</option>)}
          </select>
        </div>
      </div>
      {data.entries.length === 0 ? <EmptyState icon="box" title={status.total ? "没有匹配的条目" : "目录是空的"} description={status.total ? undefined : "点击“立即同步”从数据来源获取模型信息，或手动新增。"} />
        : <div className="file-surface table-scroll"><div className="data-table assistant-catalog-table" role="table" aria-label="模型目录">
          <div className="data-row data-head" role="row"><span role="columnheader">模型</span><span role="columnheader">上下文</span><span role="columnheader">最大输出</span>
            <span role="columnheader">价格（$/M）</span><span role="columnheader">来源</span><span role="columnheader"><span className="sr-only">操作</span></span></div>
          {data.entries.map(entry => <div className="data-row" role="row" key={entry.id}>
            <span role="cell" className="name-stack"><strong>{entry.name ?? entry.model}</strong>
              <small className="assistant-model-sub"><code className="mono">{entry.id}</code><CapabilityBadges value={entry.capabilities} /></small></span>
            <span role="cell" className="muted">{tokens(entry.context_window)}</span>
            <span role="cell" className="muted">{tokens(entry.max_output)}</span>
            <span role="cell" className="muted">{`${price(entry.input_price)} / ${price(entry.output_price)}`}</span>
            <span role="cell">{entry.source === "manual" ? <Badge tone="accent">手动</Badge> : <span className="muted">{entry.source}</span>}</span>
            <span role="cell" className="cell-actions"><Menu label={`${entry.id} 的操作`} items={[
              { label: "编辑", icon: "edit", onSelect: () => setEditing(entry) },
              ...(entry.source === "manual" ? [{ label: "删除", icon: "trash" as const, danger: true, divider: true, onSelect: () => void remove(entry) }] : []),
            ]} /></span>
          </div>)}
        </div></div>}
      {data.next_cursor && <div className="panel-more"><Button size="sm" variant="ghost" loading={more} onClick={() => { setMore(true); load(data.next_cursor); }}>加载更多</Button></div>}
    </Panel>
    {editing && <CatalogEntryDialog entry={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    {settingsOpen && <CatalogSettingsDialog status={status} onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); load(); }} />}
  </div>;
}

function CatalogSettingsDialog({ status, onClose, onSaved }: { status: ai.CatalogStatus; onClose: () => void; onSaved: () => void }) {
  const [url, setUrl] = useState(status.url === status.default_url ? "" : status.url);
  const [auto, setAuto] = useState(status.auto_sync);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try { await ai.updateCatalogSettings({ url: url.trim() || null, auto_sync: auto }); toast.success("来源设置已保存"); onSaved(); }
    catch (reason) { setError(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }
  return <Modal title="模型目录来源" icon="settings" onClose={onClose} dismissible={!busy}
    footer={<><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" type="submit" form="catalog-settings" loading={busy}>保存</Button></>}>
    <form id="catalog-settings" className="form" onSubmit={submit} noValidate>
      <Field label="数据地址" hint={<>留空使用默认的 <code>{status.default_url}</code>。也支持 OpenRouter 的 <code>/api/v1/models</code> 格式。</>}>
        <input className="input mono" value={url} placeholder={status.default_url} onChange={event => setUrl(event.target.value)} />
      </Field>
      <Switch label="每天自动同步" description="由维护任务执行；只有配置了模型渠道后才会访问外网。" checked={auto} onChange={setAuto} />
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  </Modal>;
}

function CatalogEntryDialog({ entry, onClose, onSaved }: { entry: ai.CatalogEntry | null; onClose: () => void; onSaved: () => void }) {
  const text = (value: number | null | undefined) => value == null ? "" : String(value);
  const [form, setForm] = useState({ provider: entry?.provider ?? "", model: entry?.model ?? "", name: entry?.name ?? "",
    context_window: text(entry?.context_window), max_output: text(entry?.max_output), input_price: text(entry?.input_price),
    output_price: text(entry?.output_price), cache_price: text(entry?.cache_price) });
  const [caps, setCaps] = useState<ai.Capabilities>(entry?.capabilities ?? { tools: null, reasoning: null, vision: null, structured: null });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const number = (value: string) => value.trim() ? Number(value) : null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const values: ai.CatalogInput = { name: form.name.trim() || null, context_window: number(form.context_window), max_output: number(form.max_output),
      input_price: number(form.input_price), output_price: number(form.output_price), cache_price: number(form.cache_price), capabilities: caps };
    for (const [key, value] of Object.entries(values)) if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) { setError(`${key} 不正确`); return; }
    setBusy(true); setError("");
    try {
      if (entry) await ai.updateCatalogEntry(entry.id, values);
      else await ai.createCatalogEntry({ provider: form.provider.trim(), model: form.model.trim(), ...values });
      toast.success(entry ? "目录条目已保存，之后同步不会覆盖它" : "已新增目录条目");
      onSaved();
    } catch (reason) { setError(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }
  const capability = (key: keyof ai.Capabilities, label: string) => <Field label={label} key={key}>
    <select className="input" value={caps[key] == null ? "" : caps[key] ? "yes" : "no"} onChange={event => setCaps({ ...caps, [key]: event.target.value === "" ? null : event.target.value === "yes" })}>
      <option value="">未知</option><option value="yes">支持</option><option value="no">不支持</option></select></Field>;
  return <Modal title={entry ? "编辑目录条目" : "手动新增目录条目"} description={entry ? `${entry.id}${entry.source !== "manual" ? " · 保存后转为手动条目，之后同步不会覆盖" : ""}` : "渠道加入模型时会按模型 ID 匹配这里的条目。"}
    icon="box" onClose={onClose} dismissible={!busy}
    footer={<><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" type="submit" form="catalog-entry" loading={busy}>保存</Button></>}>
    <form id="catalog-entry" className="form assistant-config-form" onSubmit={submit} noValidate>
      {!entry && <div className="form-row">
        <Field label="服务商" hint="如 openai、deepseek、local"><input className="input mono" value={form.provider} onChange={event => setForm({ ...form, provider: event.target.value })} autoFocus /></Field>
        <Field label="模型 ID" hint="与渠道中的模型 ID 一致"><input className="input mono" value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} /></Field>
      </div>}
      <Field label="名称"><input className="input" value={form.name} maxLength={120} onChange={event => setForm({ ...form, name: event.target.value })} /></Field>
      <div className="form-row">
        <Field label="上下文窗口"><input className="input" type="number" min={1} value={form.context_window} onChange={event => setForm({ ...form, context_window: event.target.value })} /></Field>
        <Field label="最大输出"><input className="input" type="number" min={1} value={form.max_output} onChange={event => setForm({ ...form, max_output: event.target.value })} /></Field>
      </div>
      <div className="form-row">
        <Field label="输入价格" hint="美元／百万 token"><input className="input" type="number" min={0} step="any" value={form.input_price} onChange={event => setForm({ ...form, input_price: event.target.value })} /></Field>
        <Field label="输出价格" hint="美元／百万 token"><input className="input" type="number" min={0} step="any" value={form.output_price} onChange={event => setForm({ ...form, output_price: event.target.value })} /></Field>
      </div>
      <div className="form-row">{capability("tools", "工具调用")}{capability("reasoning", "推理")}</div>
      <div className="form-row">{capability("vision", "图片输入")}{capability("structured", "结构化输出")}</div>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  </Modal>;
}

/* ---------- 工具 ---------- */

/** 工具能否作用于私密空间（§24.5.1、§37.3），说明来自服务端。 */
const PRIVATE_LABELS: Record<ai.PrivateMode, string> = { allow: "私密空间可用", limited: "私密空间有限制", only: "仅私密空间", never: "私密空间不提供", na: "私密空间不适用" };

function ToolsTab() {
  const [tools, setTools] = useState<ai.AdminTool[] | null>(null);
  const [draft, setDraft] = useState<Record<string, { enabled?: boolean; private_enabled?: boolean; [param: string]: boolean | number | undefined }>>({});
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
  useUnsavedChanges(dirty);
  function toggle(name: string, value: boolean) { setDraft(current => ({ ...current, [name]: { ...current[name], enabled: value } })); }
  function togglePrivate(name: string, value: boolean) { setDraft(current => ({ ...current, [name]: { ...current[name], private_enabled: value } })); }
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
      <Notice className="banner">停用的工具不会发送给模型，模型不知道它存在。操作按对话选择的审批或完全访问模式执行；彻底删除、公开分享、跨私密空间移动和 HTTP DELETE 始终确认。改动在下一次模型调用时生效。
        锁形开关只控制私密空间：关闭后这个工具不能用于私密文件，普通文件不受影响。</Notice>
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
                  <small className={`assistant-tool-private is-${tool.private}`}><Icon name="lock" size={12} />{PRIVATE_LABELS[tool.private]}{tool.private_note ? `：${tool.private_note}` : ""}</small>
                </span>
                <span className="assistant-tool-actions">
                  <span className="assistant-tool-params">{tool.params.length > 0 && <IconButton icon="settings" size="sm" label={`配置${tool.label}参数`} onClick={() => setParamsFor(tool)} />}</span>
                  <span className="assistant-tool-private-toggle">{!tool.fixed && ["allow", "limited", "only"].includes(tool.private) && <><Icon name="lock" size={13} />
                    <Switch compact label={`对私密空间提供 ${tool.label}`} disabled={!tool.on} checked={(draft[tool.name]?.private_enabled ?? tool.private_enabled) as boolean} onChange={value => togglePrivate(tool.name, value)} /></>}</span>
                  <span className="assistant-tool-enable">{tool.fixed ? <span className="muted">固定启用</span>
                    : <Switch compact label={`启用 ${tool.label}`} checked={(draft[tool.name]?.enabled ?? tool.enabled) as boolean} onChange={value => toggle(tool.name, value)} />}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ))}
      {error && <Notice tone="danger">{error}</Notice>}
      {(dirty || busy) && <div className="settings-actions assistant-sticky-actions"><span className="settings-actions-note">有未保存的修改</span><Button variant="ghost" disabled={busy} onClick={() => setDraft({})}>放弃修改</Button><Button variant="primary" loading={busy} onClick={() => void save()}>保存工具配置</Button></div>}
      {paramsFor && <ToolParamsDialog tool={paramsFor} values={draft[paramsFor.name] ?? {}} onClose={() => setParamsFor(null)}
        onApply={values => { setDraft(current => ({ ...current, [paramsFor.name]: { ...current[paramsFor.name], ...values } })); setParamsFor(null); }} />}
    </>
  );
}

// 接口中以 _bytes 结尾的配置使用字节存储，界面统一转换容量单位。
const byteSetting = (name: string) => name.endsWith("_bytes");
const sizeLabel = (label: string) => label.replace(/字节数/g, "大小").replace(/（字节）/g, "");
const settingLabel = (name: string, label: string) => byteSetting(name) ? sizeLabel(label) : label;
const settingNumber = (name: string, value: number) => byteSetting(name) ? formatBytes(value).replace(/\.0(?= )/, "") : value.toLocaleString("zh-CN");
const settingRange = (name: string, bound: { min: number; max: number }) => `${settingNumber(name, bound.min)}–${settingNumber(name, bound.max)}`;

function ToolParamsDialog({ tool, values, onClose, onApply }: { tool: ai.AdminTool; values: Record<string, unknown>; onClose: () => void; onApply: (values: Record<string, number>) => void }) {
  const [form, setForm] = useState(() => Object.fromEntries(tool.params.map(param => [param.name, String(values[param.name] ?? param.value)])));
  const [error, setError] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    const result: Record<string, number> = {};
    for (const param of tool.params) {
      const raw = form[param.name].trim(), value = Number(raw);
      if (!raw || !Number.isInteger(value) || value < param.min || value > param.max) { setError(`${settingLabel(param.name, param.label)}必须在 ${settingRange(param.name, param)} 之间`); return; }
      result[param.name] = value;
    }
    onApply(result);
  }
  return (
    <Modal title={`${tool.label} · 参数`} size="sm" onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="tool-params-form">应用</Button></>}>
      <form id="tool-params-form" className="form" onSubmit={submit} noValidate>
        {tool.params.map(param => <Field key={param.name} label={settingLabel(param.name, param.label)} hint={`默认 ${settingNumber(param.name, param.default)}，范围 ${settingRange(param.name, param)}（硬上限）`}>
          {byteSetting(param.name) ? <ByteSizeInput label={settingLabel(param.name, param.label)} min={param.min} max={param.max} value={form[param.name]} onChange={value => setForm({ ...form, [param.name]: value })} />
            : <input className="input" type="number" min={param.min} max={param.max} value={form[param.name]} onChange={event => setForm({ ...form, [param.name]: event.target.value })} />}
        </Field>)}
        {error && <Notice tone="danger">{error}</Notice>}
        <p className="muted">应用后点击页面底部的“保存工具配置”才会生效。</p>
      </form>
    </Modal>
  );
}

/* ---------- 限制与额度 ---------- */

const LIMIT_GROUPS: { title: string; description: string; keys: string[] }[] = [
  { title: "Agent 循环", description: "每一轮对话（一条用户消息触发的处理）的运行限制。工具调用超过同时执行数时会分批排队；触达总次数、时间或预算上限后，助手会总结已完成的部分并停止。累计 token 预算合计本轮每次模型请求的输入与输出，设为 0 表示不限，与模型上下文容量独立。长任务带有计划时，预算用完但计划仍有可执行步骤、本段有实际进展且没有等待确认，会按「自动续跑段数」在同一轮中开始新的一段，每段预算重新计算；用户可随时停止，每日额度照常生效。", keys: ["max_steps", "max_tool_calls", "parallel_calls", "repeat_threshold", "error_threshold", "run_seconds", "tool_seconds", "tool_result_bytes", "run_tokens", "auto_continue"] },
  { title: "并发与容量", description: "对话容量按所选模型的上下文窗口判断，接近上限时自动压缩历史。单进程部署：并发过高会占用内存与模型服务额度。", keys: ["user_concurrency", "global_concurrency", "user_messages_per_minute", "max_conversations", "action_items", "download_urls"] },
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
  const dirty = Boolean(limits && settings) && (Object.entries(form).some(([key, value]) => value !== String(limits!.values[key]))
    || general.user_daily_tokens !== String(settings!.user_daily_tokens) || general.retention_days !== String(settings!.retention_days)
    || general.call_log_days !== String(settings!.call_log_days) || general.notice !== settings!.notice);
  useUnsavedChanges(dirty);
  if (!limits || !settings) return error ? <Panel><EmptyState icon="alert" title="加载失败" description={error} /></Panel> : <Panel><SkeletonRows rows={6} /></Panel>;
  async function submit(event: FormEvent) {
    event.preventDefault();
    for (const [key, value] of Object.entries(form)) {
      const bound = limits!.bounds[key], parsed = Number(value);
      if (!value.trim() || !Number.isInteger(parsed) || parsed < bound.min || parsed > bound.max) { setError(`${settingLabel(key, bound.label)}必须在 ${settingRange(key, bound)} 之间`); return; }
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
    <Field key={key} label={settingLabel(key, label)} hint={`默认 ${settingNumber(key, bound.default)}，范围 ${settingRange(key, bound)}`}>
      {byteSetting(key) ? <ByteSizeInput label={settingLabel(key, label)} min={bound.min} max={bound.max} value={value} onChange={onChange} />
        : <input className="input" type="number" min={bound.min} max={bound.max} value={value} onChange={event => onChange(event.target.value)} />}
    </Field>
  );
  async function setPrivate(value: boolean) {
    try { onSaved(await ai.updateAdminSettings({ private: value })); toast.success(value ? "已开放私密对话" : "已关闭私密对话，进行中的私密任务已停止"); }
    catch (reason) { toast.error(api.errorMessage(reason, "保存失败")); }
  }
  async function setAuto(key: "full_auto_share" | "full_auto_purge", value: boolean) {
    try { onSaved(await ai.updateAdminSettings({ [key]: value ? 1 : 0 })); toast.success(value ? "已设为完全访问下自动执行" : "已改为需要用户确认"); }
    catch (reason) { toast.error(api.errorMessage(reason, "保存失败")); }
  }
  async function setFullAccess(value: boolean) {
    try { onSaved(await ai.updateAdminSettings({ full_access: value })); toast.success(value ? "已允许用户使用完全访问模式" : "已关闭完全访问模式"); }
    catch (reason) { toast.error(api.errorMessage(reason, "保存失败")); }
  }
  return (
    <form className="assistant-limits" onSubmit={submit} noValidate>
      <Panel title="访问模式" description="审批模式下，每次修改文件都由用户在卡片上确认。完全访问模式下，普通修改自动执行并保留 24 小时撤销。">
        <Switch label="允许用户切换到完全访问" checked={settings.full_access} onChange={value => void setFullAccess(value)}
          description="跨私密空间移动、需要访问密码的分享与 HTTP DELETE 始终需要用户确认。可在“用户”页按人单独允许或禁止。" />
        <Switch label="完全访问下自动公开分享" checked={settings.full_auto_share === 1} disabled={!settings.full_access}
          onChange={value => void setAuto("full_auto_share", value)}
          description="按助手提议的有效期创建分享链接，不设密码；用户要求设置访问密码的分享仍需在卡片中确认。" />
        <Switch label="完全访问下自动彻底删除" checked={settings.full_auto_purge === 1} disabled={!settings.full_access}
          onChange={value => void setAuto("full_auto_purge", value)}
          description="彻底删除回收站中的项目不可恢复。开启后助手按用户要求直接删除，适合信任模型判断范围的场景。" />
      </Panel>
      <Panel title="私密对话" description="用户解锁私密空间后，助手可以处理私密文件。涉及私密的对话保存在历史中，锁定后需解锁才能查看；管理员看不到内容。">
        <Switch label="允许用户使用私密对话" checked={settings.private} onChange={value => void setPrivate(value)}
          description="还需要至少一个在模型配置中「允许用于私密对话」的模型；可在“用户”页按人单独允许或禁止。关闭时立即停止所有进行中的私密任务。" />
      </Panel>
      <Panel title="额度与保留期" description="每个用户的默认额度可在“用户”页按人覆盖。">
        <div className="form settings-form assistant-limit-form">
          {numberField("user_daily_tokens", "每用户每日 token（0 为不限）", settings.bounds.user_daily_tokens, general.user_daily_tokens, value => setGeneral({ ...general, user_daily_tokens: value }))}
          {numberField("retention_days", "对话留痕保留天数", settings.bounds.retention_days, general.retention_days, value => setGeneral({ ...general, retention_days: value }))}
          {numberField("call_log_days", "调用日志保留天数", settings.bounds.call_log_days, general.call_log_days, value => setGeneral({ ...general, call_log_days: value }))}
          <Field label="首次使用说明" hint={<>用户第一次打开助手时显示，确认后才能发送消息。<button type="button" className="link-button assistant-notice-reset" onClick={() => setGeneral({ ...general, notice: settings.notice_default })}>恢复默认说明</button></>}>
            <textarea className="input" rows={4} maxLength={2000} value={general.notice} onChange={event => setGeneral({ ...general, notice: event.target.value })} />
          </Field>
        </div>
      </Panel>
      <Panel title="运行上限" description="每轮对话的调用次数、耗时与内容长度。默认值适合大多数模型，经常触达上限时再调整（见「用量与日志」的结束原因）。">
        <div className="disclosure-list">{LIMIT_GROUPS.map(group => <Disclosure key={group.title} title={group.title} description={group.description}>
          <div className="form settings-form assistant-limit-form">{group.keys.map(key => numberField(key, limits.bounds[key].label, limits.bounds[key], form[key] ?? "", value => setForm({ ...form, [key]: value })))}</div>
        </Disclosure>)}</div>
      </Panel>
      {error && <Notice tone="danger">{error}</Notice>}
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
      <Notice icon="lock" className="banner">对话正文加密保存，只有用户本人能查看。这里只显示统计信息，用于了解使用情况和清理数据。</Notice>
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
      {count !== null && <Notice>符合条件的对话：{count} 个</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
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
        <Stat label="请求" value={stats.total} detail={`成功 ${stats.ok.toLocaleString("zh-CN")}`} />
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
                ["HTTP 状态", item.http_status ?? "—"], ["错误", item.status === "ok" ? "无" : item.error ? `${item.error_code ?? ""} ${item.error}` : item.error_code ?? "—"],
                [item.kind === "model" || item.kind === "test" ? "返回工具调用数" : "条目数", item.items ?? "—"], ["缓存命中 token", tokens(item.cached_tokens)],
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
  const [form, setForm] = useState({ enabled: "inherit", max_level: "inherit", daily_tokens: "", full_access: "inherit", private: "inherit" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void ai.adminPolicy(user.id).then(value => {
      setPolicy(value);
      setForm({ enabled: value.enabled === null ? "inherit" : value.enabled ? "on" : "off", max_level: value.max_level ?? "inherit", daily_tokens: value.daily_tokens === null ? "" : String(value.daily_tokens),
        full_access: value.full_access === null ? "inherit" : value.full_access ? "on" : "off",
        private: value.private === null ? "inherit" : value.private ? "on" : "off" });
    }).catch(reason => setError(api.errorMessage(reason, "加载失败")));
  }, [user.id]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await ai.updateAdminPolicy(user.id, { enabled: form.enabled === "inherit" ? null : form.enabled === "on",
        max_level: form.max_level === "inherit" ? null : form.max_level as "read" | "write" | "danger",
        daily_tokens: form.daily_tokens.trim() === "" ? null : Number(form.daily_tokens),
        full_access: form.full_access === "inherit" ? null : form.full_access === "on",
        private: form.private === "inherit" ? null : form.private === "on" });
      toast.success(`已更新 ${api.displayName(user)} 的文件助手设置`); onClose();
    } catch (reason) { setError(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={`${api.displayName(user)} · 文件助手`} icon="sparkle" size="sm" onClose={onClose} dismissible={!busy}
      footer={<><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" type="submit" form="policy-form" loading={busy} disabled={!policy}>保存</Button></>}>
      {!policy ? (error ? <Notice tone="danger">{error}</Notice> : <SkeletonRows rows={3} />) : <form id="policy-form" className="form" onSubmit={submit} noValidate>
        <Field label="使用权限"><select className="input" value={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.value })}>
          <option value="inherit">跟随全局（允许）</option><option value="on">允许</option><option value="off">禁止</option></select></Field>
        <Field label="最高操作级别" hint="只读：只能查询与统计；普通写入：可提议改名、移动、移入回收站等；含不可恢复操作：还可提议清空回收站。所有写入仍需用户逐项确认。">
          <select className="input" value={form.max_level} onChange={event => setForm({ ...form, max_level: event.target.value })}>
            <option value="inherit">跟随全局（普通写入）</option><option value="read">只读</option><option value="write">普通写入</option><option value="danger">含不可恢复操作</option></select></Field>
        <Field label="完全访问模式" hint="允许后，用户可以让普通修改自动执行（仍可撤销）。">
          <select className="input" value={form.full_access} onChange={event => setForm({ ...form, full_access: event.target.value })}>
            <option value="inherit">跟随“限制与额度”中的全局设置</option>
            <option value="on">允许</option><option value="off">不允许</option></select></Field>
        <Field label="私密对话" hint="允许后，用户解锁私密空间即可让助手处理私密文件；禁止时立即停止该用户进行中的私密任务。">
          <select className="input" value={form.private} onChange={event => setForm({ ...form, private: event.target.value })}>
            <option value="inherit">跟随“限制与额度”中的全局设置</option>
            <option value="on">允许</option><option value="off">不允许</option></select></Field>
        <Field label="每日 token" hint={`留空跟随全局（当前 ${policy.effective.daily_tokens ? tokens(policy.effective.daily_tokens) : "不限"}），0 表示不限。`}>
          <input className="input" type="number" min={0} value={form.daily_tokens} onChange={event => setForm({ ...form, daily_tokens: event.target.value })} /></Field>
        <KeyValue items={[["今日用量", tokens(policy.usage.today)], ["近 30 天", tokens(policy.usage.days30)]]} />
        {error && <Notice tone="danger">{error}</Notice>}
      </form>}
    </Modal>
  );
}
