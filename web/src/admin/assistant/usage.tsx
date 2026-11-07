/** 系统管理 · 文件助手 · 用量统计：按天的 token 曲线与按模型、用户的用量表。（docs/assistant-design.md §12.1） */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { SITE } from "../../brand";
import * as api from "../../api";
import * as ai from "../../assistant-api";
import { Notice, Badge, Button, ByteSizeInput, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader, Panel, PasswordField, SetupGuide, SearchInput, Segmented,
  SkeletonRows, Switch, Tabs, Disclosure, formatBytes, formatDateTime, toast, confirmLeave, useDocumentTitle, useUnsavedChanges, type IconName, type Tone } from "../../ui";
import { Stat } from "../overview";
import { CurveChart } from "../../curve-chart";

import { ms, percent, tokens } from "./shared";

/** 概览的用量按天与模型分组：先按天合计，再补齐 30 天。 */
export function dailyUsage(since: string, points: ai.UsagePoint[]) {
  const map = new Map<string, { day: string; input_tokens: number; output_tokens: number }>();
  for (const point of points) {
    const row = map.get(point.day) ?? { day: point.day, input_tokens: 0, output_tokens: 0 };
    row.input_tokens += point.input_tokens ?? 0; row.output_tokens += point.output_tokens ?? 0;
    map.set(point.day, row);
  }
  return fillDays(since, 30, [...map.values()]);
}

export type UsageDay = { day: string; input: number; output: number; total: number };

/** 补齐区间内没有用量的日期（记为 0），曲线和日期刻度才连续；日期按字符串计算，不受时区影响。 */
export function fillDays(since: string, count: number, rows: { day: string; input_tokens: number | null; output_tokens: number | null }[]): UsageDay[] {
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
export function UsageCurve({ days }: { days: UsageDay[] }) {
  return <CurveChart label={`近 ${days.length} 天 Token 用量曲线`} selectionLabel="选择日期" formatValue={tokens}
    points={days.map(day => ({ id: day.day, tick: day.day.slice(5), values: [day.total],
      description: `${day.day}：${tokens(day.total)} token（输入 ${tokens(day.input)} · 输出 ${tokens(day.output)}）` }))} />;
}

/* ---------- 用量报表 ---------- */

export const STOP_REASONS: Record<string, string> = {
  completed: "正常完成", waiting_user: "等待用户", stopped: "用户停止", limit: "触达上限", loop: "重复调用", errors: "连续出错",
  timeout: "超时", session: "登录失效", disabled: "助手停用", model: "模型停用", daily_limit: "额度用完", server_restart: "服务重启",
  internal: "内部错误", locked: "系统锁定", account: "账号停用",
};
export const ACTION_STATUS: Record<string, string> = { done: "已完成", partial: "部分完成", failed: "失败", rejected: "已拒绝", expired: "已过期",
  cancelled: "已取消", undone: "已撤销", pending: "待确认", running: "执行中", interrupted: "已中断" };

export function UsageTab() {
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

export function UsageTable({ rows, empty, cost = false }: { rows: [string, { input_tokens: number | null; output_tokens: number | null; runs: number | null; cost?: number | null }][]; empty: string; cost?: boolean }) {
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

