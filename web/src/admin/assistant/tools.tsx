/** 系统管理 · 文件助手 · 工具：逐个启停与参数。（docs/assistant-design.md §12.1） */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { SITE } from "../../brand";
import * as api from "../../api";
import * as ai from "../../assistant-api";
import { Notice, Badge, Button, ByteSizeInput, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader, Panel, PasswordField, SetupGuide, SearchInput, Segmented,
  SkeletonRows, Switch, Tabs, Disclosure, formatBytes, formatDateTime, toast, confirmLeave, useDocumentTitle, useUnsavedChanges, type IconName, type Tone } from "../../ui";
import { Stat } from "../overview";
import { CurveChart } from "../../curve-chart";

import { LEVELS, byteSetting, settingLabel, settingNumber, settingRange } from "./shared";

/** 工具能否作用于私密空间（§24.5.1、§37.3），说明来自服务端。 */
export const PRIVATE_LABELS: Record<ai.PrivateMode, string> = { allow: "私密空间可用", limited: "私密空间有限制", only: "仅私密空间", never: "私密空间不提供", na: "私密空间不适用" };

export function ToolsTab() {
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

export function ToolParamsDialog({ tool, values, onClose, onApply }: { tool: ai.AdminTool; values: Record<string, unknown>; onClose: () => void; onApply: (values: Record<string, number>) => void }) {
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

