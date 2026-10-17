import { useEffect, useState, type FormEvent } from "react";
import * as api from "../api";
import { Button, Field, Icon, Panel, SkeletonRows, Switch, toast } from "../ui";

/** 系统设置 →「浏览器缓存」：每台设备的上限与是否允许缓存私密文件（docs/client-cache-design.md §5）。 */
export function ClientCachePolicy() {
  const [saved, setSaved] = useState<api.ClientCachePolicy | null>(null);
  const [form, setForm] = useState<api.ClientCachePolicy | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => { void api.adminClientCache().then(value => { setSaved(value); setForm(value); setError(""); }).catch(reason => setError(api.errorMessage(reason, "浏览器缓存策略加载失败"))); };
  useEffect(load, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true); setError("");
    try {
      const value = await api.updateAdminClientCache(form);
      setSaved(value); setForm(value);
      toast.success("浏览器缓存策略已保存");
    } catch (reason) { setError(api.errorMessage(reason, "浏览器缓存策略保存失败")); }
    finally { setBusy(false); }
  }
  const dirty = saved && JSON.stringify(form) !== JSON.stringify(saved);
  const number = (key: keyof api.ClientCachePolicy, value: string) => form && setForm({ ...form, [key]: Number(value) });
  return <Panel title="浏览器缓存" description="用户看过的文件加密保存在各自的浏览器里，重复打开时不必再从服务器读取。用户在「用户设置 → 本机缓存」中按设备调整。">
    {!form || !saved ? error ? <div className="form"><p className="form-alert" role="alert">{error}</p><Button onClick={load}>重试</Button></div> : <SkeletonRows rows={2} /> :
      <form className="form" onSubmit={submit}>
        <div className="resource-hls"><Switch checked={form.enabled} onChange={enabled => setForm({ ...form, enabled })} label="允许浏览器缓存文件"
          description="关闭后各设备会在下次使用时清除普通文件的缓存。" /></div>
        <div className="form-row">
          <Field label="每台设备最多占用（MiB）" hint="64–1048576；用户只能在这个范围内选择。"><input className="input" type="number" min={64} max={1048576} step={1} required disabled={!form.enabled} value={form.max_mib} onChange={event => number("max_mib", event.target.value)} /></Field>
          <Field label="单个文件最多缓存（MiB）" hint="视频按看过的片段保存，超出的部分每次从服务器读取。"><input className="input" type="number" min={16} max={65536} step={1} required disabled={!form.enabled} value={form.entry_mib} onChange={event => number("entry_mib", event.target.value)} /></Field>
        </div>
        <div className="resource-hls"><Switch checked={form.private_enabled} disabled={!form.enabled} onChange={value => setForm({ ...form, private_enabled: value })} label="允许在信任的设备上缓存私密文件"
          description="用户需要在每台设备上单独开启。缓存的密钥只在私密空间解锁时下发，锁定后无法解开。" /></div>
        {form.private_enabled && form.enabled && <div className="form-row">
          <Field label="私密文件每台设备最多占用（MiB）" hint="16–1048576"><input className="input" type="number" min={16} max={1048576} step={1} required value={form.private_max_mib} onChange={event => number("private_max_mib", event.target.value)} /></Field>
          <Field label="私密文件保留天数" hint="1–90；超过这么久没有打开的私密文件会被清除。"><input className="input" type="number" min={1} max={90} step={1} required value={form.private_ttl_days} onChange={event => number("private_ttl_days", event.target.value)} /></Field>
        </div>}
        {form.private_enabled && form.enabled && <p className="inline-note"><Icon name="info" size={16} />私密文件的缓存在用户的设备上只以密文保存；但解锁期间设备上的恶意软件或浏览器扩展仍可能读到已打开的内容。</p>}
        {error && <div className="form-alert" role="alert">{error}</div>}
        {(dirty || busy) && <div className="settings-actions"><span className="settings-actions-note">有未保存的修改</span><Button variant="ghost" disabled={busy} onClick={() => setForm(saved)}>放弃修改</Button><Button type="submit" variant="primary" loading={busy}>保存缓存策略</Button></div>}
      </form>}
  </Panel>;
}
