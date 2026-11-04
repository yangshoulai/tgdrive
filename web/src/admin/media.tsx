import { useEffect, useState, type FormEvent } from "react";
import * as api from "../api";
import { Badge, Button, Field, Notice, Panel, SetupGuide, SkeletonRows, Switch, toast, useUnsavedChanges } from "../ui";

/* ---------- 系统设置 · 媒体信息：封面、歌词、字幕的来源 ---------- */

const WANT_LABELS: Record<api.MediaWant, string> = { cover: "封面", lyrics: "歌词", subtitle: "字幕" };
const MEDIA_LABELS = { audio: "音乐", video: "视频" } as const;

type Draft = { enabled: boolean; config: Record<string, string>; secrets: Record<string, string>; clear: string[] };
const draftOf = (provider: api.MediaProvider): Draft => ({ enabled: provider.enabled, config: { ...provider.config }, secrets: {}, clear: [] });
const draftsOf = (value: api.MediaProviders) => Object.fromEntries(value.providers.map(provider => [provider.id, draftOf(provider)]));
function changed(provider: api.MediaProvider, draft: Draft) {
  return draft.enabled !== provider.enabled || draft.clear.length > 0 || Object.values(draft.secrets).some(value => value.trim())
    || provider.fields.some(field => !field.secret && (draft.config[field.key] ?? "") !== (provider.config[field.key] ?? ""));
}
/** 启用前检查必填项：已保存的密钥、本次填写的值都算已填写，本次要清除的不算。 */
function missingOf(provider: api.MediaProvider, draft: Draft) {
  return provider.fields.filter(field => field.required && !(field.secret
    ? draft.secrets[field.key]?.trim() || provider.secrets[field.key] && !draft.clear.includes(field.key)
    : draft.config[field.key]?.trim())).map(field => field.label);
}

export function MediaSettings() {
  const [saved, setSaved] = useState<api.MediaProviders | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, { busy?: boolean; ok?: boolean; message?: string }>>({});
  useEffect(() => {
    let alive = true;
    void api.adminMediaProviders().then(value => { if (alive) { setSaved(value); setDrafts(draftsOf(value)); } })
      .catch(reason => { if (alive) setError(api.errorMessage(reason, "媒体信息设置加载失败")); });
    return () => { alive = false; };
  }, []);
  const dirtyIds = saved ? saved.providers.filter(provider => drafts[provider.id] && changed(provider, drafts[provider.id])).map(provider => provider.id) : [];
  useUnsavedChanges(dirtyIds.length > 0);
  const change = (id: string, patch: Partial<Draft>) => { setDrafts(current => ({ ...current, [id]: { ...current[id], ...patch } })); setError(""); };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!saved || busy || !dirtyIds.length) return;
    for (const provider of saved.providers) {
      const draft = drafts[provider.id];
      const missing = draft.enabled ? missingOf(provider, draft) : [];
      if (missing.length) { setError(`启用 ${provider.name} 前请先填写「${missing.join("」「")}」`); return; }
    }
    const body: Record<string, api.MediaProviderChange> = {};
    for (const id of dirtyIds) {
      const provider = saved.providers.find(item => item.id === id)!, draft = drafts[id];
      const config: Record<string, string> = {};
      for (const field of provider.fields) {
        if (field.secret) { if (draft.secrets[field.key]?.trim()) config[field.key] = draft.secrets[field.key].trim(); }
        else config[field.key] = draft.config[field.key] ?? "";
      }
      body[id] = { enabled: draft.enabled, config, clear: draft.clear.filter(key => !draft.secrets[key]?.trim()) };
    }
    setBusy(true); setError("");
    try {
      const result = await api.updateMediaProviders(body);
      setSaved(result); setDrafts(draftsOf(result)); setTests({});
      toast.success("媒体信息设置已保存，立即生效");
    } catch (reason) { setError(api.errorMessage(reason, "媒体信息设置保存失败")); }
    finally { setBusy(false); }
  }
  async function test(id: string) {
    setTests(current => ({ ...current, [id]: { busy: true } }));
    try { const result = await api.testMediaProvider(id); setTests(current => ({ ...current, [id]: result })); }
    catch (reason) { setTests(current => ({ ...current, [id]: { ok: false, message: api.errorMessage(reason, "测试失败") } })); }
  }

  if (!saved) return <Panel>{error ? <Notice tone="danger">{error}<Button onClick={() => window.location.reload()}>重新加载</Button></Notice> : <SkeletonRows rows={6} />}</Panel>;
  return <form className="stack" onSubmit={submit} noValidate>
    <Panel title="封面、歌词与字幕的来源" description="播放器、文件菜单与「设置封面」里的在线查找会用到这里开启的来源；查询由服务器发出，只包含歌名、片名等查询条件，不发送文件内容。文件自带的数据始终优先。">
      <ul className="media-providers">
        {saved.providers.map(provider => {
          const draft = drafts[provider.id], result = tests[provider.id];
          const missing = missingOf(provider, draft);
          const configurable = provider.fields.length > 0;
          return <li key={provider.id} className={`media-provider${draft.enabled ? " is-enabled" : ""}`}>
            <div className="media-provider-head">
              <div className="media-provider-title">
                <strong>{provider.name}</strong>
                <span className="media-provider-badges">
                  {provider.capabilities.map(want => <Badge key={want} tone="accent">{WANT_LABELS[want]}</Badge>)}
                  {provider.media.map(kind => <Badge key={kind}>{MEDIA_LABELS[kind]}</Badge>)}
                  {!provider.official && <Badge tone="warning" icon="alert">非官方接口</Badge>}
                  {provider.needs_config && <Badge tone={missing.length ? "warning" : "success"} icon={missing.length ? "key" : "check"}>{missing.length ? "需要配置" : "已配置"}</Badge>}
                </span>
              </div>
              <Switch compact label={`启用 ${provider.name}`} checked={draft.enabled} disabled={busy} onChange={enabled => change(provider.id, { enabled })} />
            </div>
            <p className="media-provider-description">{provider.description}
              {provider.homepage && <> <a className="link" href={provider.homepage} target="_blank" rel="noreferrer">官网</a></>}</p>
            {provider.id === "embedded" && !saved.ffmpeg && <Notice tone="info">服务器没有安装 FFmpeg：仍可读取标签、内嵌歌词与内嵌封面，视频里的内嵌字幕轨无法提取。使用带 FFmpeg 的镜像即可提取。</Notice>}
            {provider.notice && (!provider.official || draft.enabled) && <Notice tone={provider.official ? "info" : "warning"}>{provider.notice}</Notice>}
            {configurable && <div className="media-provider-config">
              {provider.guide.length > 0 && <SetupGuide id={`media-${provider.id}`} title={`${provider.name} 配置指南`} defaultOpen={provider.needs_config && missing.length > 0}
                steps={provider.guide.map(step => ({ title: step.title, body: <>{step.body}{step.link && <> <a className="link" href={step.link} target="_blank" rel="noreferrer">{step.link_label || "打开"}</a></>}</> }))} />}
              <div className="media-provider-fields">
                {provider.fields.map(field => {
                  const id = `media-${provider.id}-${field.key}`;
                  const stored = field.secret && provider.secrets[field.key] && !draft.clear.includes(field.key);
                  return <Field key={field.key} label={field.label + (field.required ? "" : "（可选）")} htmlFor={id}
                    hint={field.secret && provider.secrets[field.key] ? <>{field.hint} 已加密保存，留空保留原值。{" "}
                      <button type="button" className="link-button" disabled={busy} onClick={() => change(provider.id, { clear: draft.clear.includes(field.key) ? draft.clear.filter(key => key !== field.key) : [...draft.clear, field.key], secrets: { ...draft.secrets, [field.key]: "" } })}>
                        {draft.clear.includes(field.key) ? "撤销清除" : "清除已保存的值"}</button></> : field.hint}>
                    {field.secret
                      ? <input id={id} name={`${id}-secret`} className="input mono" type="password" autoComplete="new-password" disabled={busy}
                        placeholder={stored ? "已保存，留空不修改" : draft.clear.includes(field.key) ? "保存后清除" : field.placeholder || field.label}
                        value={draft.secrets[field.key] ?? ""} onChange={event => change(provider.id, { secrets: { ...draft.secrets, [field.key]: event.target.value }, clear: draft.clear.filter(key => key !== field.key) })} />
                      : <input id={id} className="input" autoComplete="off" disabled={busy} placeholder={field.placeholder}
                        value={draft.config[field.key] ?? ""} onChange={event => change(provider.id, { config: { ...draft.config, [field.key]: event.target.value } })} />}
                  </Field>;
                })}
              </div>
              <div className="media-provider-test">
                <Button size="sm" icon="zap" loading={result?.busy} disabled={busy || dirtyIds.includes(provider.id) || missing.length > 0} onClick={() => void test(provider.id)}>测试连接</Button>
                {dirtyIds.includes(provider.id) ? <small>保存后才能测试</small> : result?.message && <span className={`media-provider-result${result.ok ? " is-ok" : " is-failed"}`} role="status">{result.message}</span>}
              </div>
            </div>}
            {!configurable && provider.id !== "embedded" && <div className="media-provider-test">
              <Button size="sm" variant="ghost" icon="zap" loading={result?.busy} disabled={busy} onClick={() => void test(provider.id)}>测试连接</Button>
              {result?.message && <span className={`media-provider-result${result.ok ? " is-ok" : " is-failed"}`} role="status">{result.message}</span>}
            </div>}
          </li>;
        })}
      </ul>
    </Panel>
    {error && <Notice tone="danger">{error}</Notice>}
    {(dirtyIds.length > 0 || busy) && <div className="settings-actions"><span className="settings-actions-note">有未保存的修改</span>
      <Button variant="ghost" disabled={busy} onClick={() => { setDrafts(draftsOf(saved)); setError(""); }}>放弃修改</Button>
      <Button variant="primary" type="submit" loading={busy}>保存</Button></div>}
  </form>;
}
