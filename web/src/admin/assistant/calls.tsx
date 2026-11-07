/** 系统管理 · 文件助手 · 调用日志：模型与工具调用的元数据。（docs/assistant-design.md §12.1） */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { SITE } from "../../brand";
import * as api from "../../api";
import * as ai from "../../assistant-api";
import { Notice, Badge, Button, ByteSizeInput, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader, Panel, PasswordField, SetupGuide, SearchInput, Segmented,
  SkeletonRows, Switch, Tabs, Disclosure, formatBytes, formatDateTime, toast, confirmLeave, useDocumentTitle, useUnsavedChanges, type IconName, type Tone } from "../../ui";
import { Stat } from "../overview";
import { CurveChart } from "../../curve-chart";

import { RANGES, ms, percent, sinceOf, tokens, useUserOptions } from "./shared";

export const CALL_KINDS: Record<string, string> = { model: "模型", tool: "工具", fetch: "抓取", sync: "同步", test: "测试" };
export const CALL_STATUS: Record<string, { label: string; tone: Tone }> = {
  ok: { label: "成功", tone: "success" }, error: { label: "失败", tone: "danger" }, timeout: { label: "超时", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" }, limited: { label: "被限制", tone: "warning" },
};

export function CallsTab() {
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

