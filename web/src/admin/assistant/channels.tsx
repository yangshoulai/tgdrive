/** 系统管理 · 文件助手 · 渠道与模型：渠道配置、上游模型挑选与模型参数。（docs/assistant-design.md §12.1） */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { SITE } from "../../brand";
import * as api from "../../api";
import * as ai from "../../assistant-api";
import { Notice, Badge, Button, ByteSizeInput, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader, Panel, PasswordField, SetupGuide, SearchInput, Segmented,
  SkeletonRows, Switch, Tabs, Disclosure, formatBytes, formatDateTime, toast, confirmLeave, useDocumentTitle, useUnsavedChanges, type IconName, type Tone } from "../../ui";
import { Stat } from "../overview";
import { CurveChart } from "../../curve-chart";

import { CapabilityBadges, KIND_EXAMPLE, channelLabel, price, tokens } from "./shared";

export const CHANNEL_STEPS = [
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

export function ChannelsTab({ settings, onChanged }: { settings: ai.AssistantSettings | null; onChanged: () => void }) {
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

export function ChannelDetail({ channel, defaultModel, onEdit, onDelete, onPick, onChanged }: { channel: ai.AiChannel; defaultModel: number | null; onEdit: () => void; onDelete: () => void; onPick: () => void; onChanged: () => void }) {
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
                  <CapabilityBadges value={model.capabilities} tools={model.tools} />{effortOf(model) && <span className="assistant-cap is-reasoning" title="请求时使用的思考程度">思考 {effortOf(model)}</span>}
                  {!model.catalog_id && <span className="assistant-cap is-off">目录未收录</span>}</small>
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

export function parseHeaders(text: string): Record<string, string> | string {
  const result: Record<string, string> = {};
  for (const line of text.split("\n").map(item => item.trim()).filter(Boolean)) {
    const index = line.indexOf(":");
    if (index <= 0) return `无法识别的请求头：${line}`;
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

export function ChannelDialog({ channel, onClose, onSaved }: { channel: ai.AiChannel | null; onClose: () => void; onSaved: (channel: ai.AiChannel, created: boolean) => void }) {
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

export const EFFORT_LABELS: Record<string, string> = { none: "不思考", minimal: "极少", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };

/** 请求时实际使用的思考程度：所选档位仍在模型目录的选项里才生效（与服务端 ChannelStore.effort 一致）。 */
export const effortOf = (model: ai.AiModel | null | undefined) =>
  model?.reasoning_effort && model.reasoning_efforts.includes(model.reasoning_effort) ? model.reasoning_effort : null;

export const initialVision = (model: ai.AiModel | null): "auto" | "yes" | "no" =>
  model?.manual_fields.includes("vision") ? (model.capabilities.vision === true ? "yes" : "no") : "auto";

export function ModelDialog({ channelId, model, onClose, onSaved }: { channelId: number; model: ai.AiModel | null; onClose: () => void; onSaved: () => void }) {
  const initial = (value: number | null | undefined) => value == null ? "" : String(value);
  const [form, setForm] = useState({ model: model?.model ?? "", display_name: model?.display_name ?? "", context_window: initial(model?.context_window),
    max_output: initial(model?.max_output), tools: model?.tools ?? "unknown" as ai.ToolSupport, sort: String(model?.sort ?? 0),
    input_price: initial(model?.input_price), output_price: initial(model?.output_price), vision: initialVision(model), private_ok: Boolean(model?.private_ok),
    effort: effortOf(model) ?? "" });
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
      ...(form.vision !== initialVision(model) ? { vision: form.vision } : {}),
      ...(model && form.effort !== (model.reasoning_effort ?? "") ? { reasoning_effort: form.effort || null } : {}) };
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
        {model && <Field label="思考程度" hint={model.reasoning_efforts.length
          ? "可选档位来自模型目录。选择后，每次回复都按这个程度请求模型思考；「不设置」时请求里不带思考程度，由模型服务决定。程度越高回答越慢、消耗的 token 越多。"
          : model.catalog_id ? "模型目录没有提供这个模型的思考程度档位，请求里不带思考程度字段。" : "模型目录未收录这个模型，请求里不带思考程度字段。"}>
          <select className="input" value={form.effort} disabled={!model.reasoning_efforts.length} onChange={event => setForm({ ...form, effort: event.target.value })}>
            <option value="">不设置（由模型决定）</option>
            {model.reasoning_efforts.map(value => <option key={value} value={value}>{EFFORT_LABELS[value] ? `${EFFORT_LABELS[value]}（${value}）` : value}</option>)}
          </select>
        </Field>}
        <Switch label="允许用于私密对话" checked={form.private_ok} onChange={value => setForm({ ...form, private_ok: value })}
          description="私密对话会把私密空间里的文件名、目录结构以及读取的文本和图片发给这个模型，只为你信任的模型服务开启。全局开关在“限制与额度”。" />
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Modal>
  );
}

/** 从渠道的上游模型列表中勾选要加入的模型；目录匹配到的上下文、价格与能力一并展示。 */
export function ModelPickerDialog({ channel, channelId, onClose, onAdded }: { channel: ai.AiChannel | null; channelId: number; onClose: () => void; onAdded: () => void }) {
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

