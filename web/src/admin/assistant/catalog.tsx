/** 系统管理 · 文件助手 · 模型目录：models.dev 同步与手动条目。（docs/assistant-design.md §12.1） */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { SITE } from "../../brand";
import * as api from "../../api";
import * as ai from "../../assistant-api";
import { Notice, Badge, Button, ByteSizeInput, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader, Panel, PasswordField, SetupGuide, SearchInput, Segmented,
  SkeletonRows, Switch, Tabs, Disclosure, formatBytes, formatDateTime, toast, confirmLeave, useDocumentTitle, useUnsavedChanges, type IconName, type Tone } from "../../ui";
import { Stat } from "../overview";
import { CurveChart } from "../../curve-chart";

import { CapabilityBadges, price, tokens } from "./shared";

export function CatalogTab() {
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
              <small className="assistant-model-sub"><code className="mono">{entry.id}</code><CapabilityBadges value={entry.capabilities} />
                {entry.reasoning_efforts.length > 0 && <span className="assistant-cap" title="可选的思考程度">思考程度 {entry.reasoning_efforts.join(" · ")}</span>}</small></span>
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

export function CatalogSettingsDialog({ status, onClose, onSaved }: { status: ai.CatalogStatus; onClose: () => void; onSaved: () => void }) {
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

export function CatalogEntryDialog({ entry, onClose, onSaved }: { entry: ai.CatalogEntry | null; onClose: () => void; onSaved: () => void }) {
  const text = (value: number | null | undefined) => value == null ? "" : String(value);
  const [form, setForm] = useState({ provider: entry?.provider ?? "", model: entry?.model ?? "", name: entry?.name ?? "",
    context_window: text(entry?.context_window), max_output: text(entry?.max_output), input_price: text(entry?.input_price),
    output_price: text(entry?.output_price), cache_price: text(entry?.cache_price), efforts: (entry?.reasoning_efforts ?? []).join(", ") });
  const [caps, setCaps] = useState<ai.Capabilities>(entry?.capabilities ?? { tools: null, reasoning: null, vision: null, structured: null });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const number = (value: string) => value.trim() ? Number(value) : null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const values: ai.CatalogInput = { name: form.name.trim() || null, context_window: number(form.context_window), max_output: number(form.max_output),
      input_price: number(form.input_price), output_price: number(form.output_price), cache_price: number(form.cache_price), capabilities: caps,
      reasoning_efforts: [...new Set(form.efforts.split(/[\s,，、]+/).map(value => value.trim().toLowerCase()).filter(Boolean))] };
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
      <Field label="思考程度档位" hint="模型接受的 effort 取值，按从低到高用逗号分隔，如 low, medium, high；留空表示没有可选的思考程度。渠道模型可从这些档位中选择。">
        <input className="input mono" value={form.efforts} placeholder="low, medium, high" onChange={event => setForm({ ...form, efforts: event.target.value })} />
      </Field>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  </Modal>;
}

/* ---------- 工具 ---------- */

