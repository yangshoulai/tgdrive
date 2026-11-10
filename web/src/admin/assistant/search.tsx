/** 系统管理 · 文件助手 · 网络搜索：选择搜索服务（自建 SearXNG、Brave Search API、Tavily），未配置时助手没有 web_search 工具。 */
import { useEffect, useState, type FormEvent } from "react";
import * as api from "../../api";
import * as ai from "../../assistant-api";
import { Badge, Button, Field, KeyValue, Modal, Notice, Panel, PasswordField, Segmented, toast } from "../../ui";

export function SearchPanel() {
  const [status, setStatus] = useState<ai.SearchSettings | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { void ai.adminSearch().then(setStatus).catch(() => setStatus(null)); }, []);
  const provider = status?.providers.find(item => item.value === status.provider);
  return (
    <Panel title="网络搜索" description="配置后，助手可以搜索公共网页来查资料、找资源页面。只有搜索词会发给搜索服务，结果按不可信的外部内容处理。"
      actions={<Button size="sm" disabled={!status} onClick={() => setEditing(true)}>{status?.configured ? "修改" : "配置"}</Button>}>
      {status && <KeyValue items={[
        ["搜索服务", provider ? <>{provider.label} <Badge tone="success" dot>已启用</Badge></> : <span className="muted">未配置，助手不提供网络搜索</span>],
        ...(status.url ? [["实例地址", <code className="mono">{status.url}</code>] as [string, JSX.Element]] : []),
        ...(status.api_key ? [["API Key", <code className="mono">{status.api_key}</code>] as [string, JSX.Element]] : []),
      ]} />}
      {editing && status && <SearchDialog status={status} onClose={() => setEditing(false)} onSaved={next => { setStatus(next); setEditing(false); }} />}
    </Panel>
  );
}

function SearchDialog({ status, onClose, onSaved }: { status: ai.SearchSettings; onClose: () => void; onSaved: (status: ai.SearchSettings) => void }) {
  const [provider, setProvider] = useState(status.provider || "searxng");
  const [url, setUrl] = useState(status.url);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const spec = status.providers.find(item => item.value === provider);
  const keepKey = status.provider === provider && Boolean(status.api_key);
  async function save(next: string, event?: FormEvent) {
    event?.preventDefault();
    setSaving(true); setError("");
    try {
      const payload: Record<string, string> = { provider: next };
      if (next && spec?.needs_url) payload.url = url.trim();
      if (next && spec?.needs_key && key) payload.api_key = key.trim();
      const saved = await ai.updateAdminSearch(payload);
      toast.success(next ? "网络搜索已启用" : "已关闭网络搜索"); onSaved(saved);
    } catch (reason) { setError(api.errorMessage(reason, "保存失败，请检查后重试")); }
    finally { setSaving(false); }
  }
  return (
    <Modal title="网络搜索" size="sm" onClose={onClose} dismissible={!saving}
      footer={<>{status.configured && <Button variant="ghost" disabled={saving} onClick={() => void save("")}>关闭网络搜索</Button>}<span className="spacer" />
        <Button disabled={saving} onClick={onClose}>取消</Button><Button variant="primary" loading={saving} type="submit" form="assistant-search-form">保存</Button></>}>
      <form id="assistant-search-form" className="form" noValidate onSubmit={event => void save(provider, event)}>
        <Field label="搜索服务">
          <Segmented label="搜索服务" value={provider} showLabels onChange={value => { setProvider(value); setError(""); }}
            options={status.providers.map(item => ({ value: item.value, label: item.value === "searxng" ? "SearXNG" : item.value === "brave" ? "Brave" : "Tavily" }))} />
        </Field>
        {spec?.needs_url && <Field label="实例地址" hint="自建 SearXNG 的地址，需要在实例设置中开启 JSON 输出（search.formats 包含 json）。可以是内网地址。">
          <input className="input" type="url" value={url} placeholder="https://search.example.com" onChange={event => setUrl(event.target.value)} disabled={saving} autoFocus />
        </Field>}
        {spec?.needs_key && <PasswordField label="API Key" value={key} onChange={setKey} autoComplete="off" disabled={saving}
          hint={keepKey ? `已保存 ${status.api_key}，留空则保持不变。` : provider === "brave" ? "在 Brave Search API 控制台创建（Data for AI 或 Web Search 计划）。" : "在 Tavily 控制台创建，以 tvly- 开头。"} />}
        {spec?.needs_key && <p className="muted">API Key 加密保存，页面和接口不会再显示明文。</p>}
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Modal>
  );
}
