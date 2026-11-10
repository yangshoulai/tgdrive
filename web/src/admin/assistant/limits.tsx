/** 系统管理 · 文件助手 · 权限与额度：访问模式、私密对话与运行上限。（docs/assistant-design.md §12.1） */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { SITE } from "../../brand";
import * as api from "../../api";
import * as ai from "../../assistant-api";
import { Notice, Badge, Button, ByteSizeInput, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader, Panel, PasswordField, SetupGuide, SearchInput, Segmented,
  SkeletonRows, Switch, Tabs, Disclosure, formatBytes, formatDateTime, toast, confirmLeave, useDocumentTitle, useUnsavedChanges, type IconName, type Tone } from "../../ui";
import { Stat } from "../overview";
import { CurveChart } from "../../curve-chart";

import { byteSetting, settingLabel, settingNumber, settingRange } from "./shared";
import { SearchPanel } from "./search";

export const LIMIT_GROUPS: { title: string; description: string; keys: string[] }[] = [
  { title: "Agent 循环", description: "每一轮对话（一条用户消息触发的处理）的运行限制。工具调用超过同时执行数时会分批排队；触达总次数、时间或预算上限后，助手会总结已完成的部分并停止。累计 token 预算合计本轮每次模型请求的输入与输出，设为 0 表示不限，与模型上下文容量独立。长任务带有计划时，预算用完但计划仍有可执行步骤、本段有实际进展且没有等待确认，会按「自动续跑段数」在同一轮中开始新的一段，每段预算重新计算；用户可随时停止，每日额度照常生效。", keys: ["max_steps", "max_tool_calls", "parallel_calls", "repeat_threshold", "error_threshold", "run_seconds", "tool_seconds", "tool_result_bytes", "run_tokens", "auto_continue"] },
  { title: "并发与容量", description: "对话容量按所选模型的上下文窗口判断，接近上限时自动压缩历史。单进程部署：并发过高会占用内存与模型服务额度。", keys: ["user_concurrency", "global_concurrency", "user_messages_per_minute", "max_conversations", "action_items", "download_urls"] },
];

export function LimitsTab({ settings, onSaved }: { settings: ai.AssistantSettings | null; onSaved: (settings: ai.AssistantSettings) => void }) {
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
      <SearchPanel />
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

