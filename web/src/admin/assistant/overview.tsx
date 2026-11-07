/** 系统管理 · 文件助手 · 概览：开关、默认模型与状态提示。（docs/assistant-design.md §12.1） */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { SITE } from "../../brand";
import * as api from "../../api";
import * as ai from "../../assistant-api";
import { Notice, Badge, Button, ByteSizeInput, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader, Panel, PasswordField, SetupGuide, SearchInput, Segmented,
  SkeletonRows, Switch, Tabs, Disclosure, formatBytes, formatDateTime, toast, confirmLeave, useDocumentTitle, useUnsavedChanges, type IconName, type Tone } from "../../ui";
import { Stat } from "../overview";
import { CurveChart } from "../../curve-chart";

import { Tab, formatSize, ms, percent, tokens } from "./shared";
import { UsageCurve, dailyUsage } from "./usage";

export function OverviewTab({ revision, settings, onNavigate, onChanged }: { revision: number; settings: ai.AssistantSettings | null; onNavigate: (tab: Tab) => void; onChanged: () => void }) {
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

