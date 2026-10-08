import { useEffect, useState, type FormEvent } from "react";
import { BRAND, SITE } from "../brand";
import * as api from "../api";

import { Button, Field, Icon, KeyValue, PageHeader, Panel, SkeletonRows, toast, useDocumentTitle } from "../ui";

/* ---------- 系统设置 ---------- */

export function Settings({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<api.SystemSettings | null>(null);
  const [form, setForm] = useState({ public_base_url: "", s3_endpoint: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useDocumentTitle(`系统设置 · ${SITE.admin}`);
  useEffect(() => {
    void api.adminSettings().then(value => {
      setSettings(value);
      setForm({ public_base_url: value.public_base_url.value ?? "", s3_endpoint: value.s3_endpoint.value ?? "" });
    }).catch(reason => setError(api.errorMessage(reason, "设置加载失败，请稍后重试")));
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const saved = await api.updateAdminSettings(form);
      setSettings(saved);
      setForm({ public_base_url: saved.public_base_url.value ?? "", s3_endpoint: saved.s3_endpoint.value ?? "" });
      toast.success("访问地址已保存，立即生效");
      onSaved();
    } catch (reason) { setError(api.errorMessage(reason, "保存失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  if (!settings && !error) return <><PageHeader title="系统设置" /><Panel><SkeletonRows rows={3} /></Panel></>;
  const trimmed = (value: string) => value.trim().replace(/\/+$/, "");
  const site = trimmed(form.public_base_url) || settings?.public_base_url.default || api.detectedSiteOrigin();
  const s3 = trimmed(form.s3_endpoint) || settings?.s3_endpoint.default || null;
  const dirty = settings !== null && (form.public_base_url !== (settings.public_base_url.value ?? "") || form.s3_endpoint !== (settings.s3_endpoint.value ?? ""));
  return (
    <>
      <PageHeader title="系统设置" description={`用户和外部工具访问 ${BRAND} 的地址。保存后立即生效，无需重启服务。`} />
      <div className="stack">
        <Panel title="访问地址">
          <form className="form settings-form" onSubmit={submit} noValidate>
            <Field label="公开访问地址" htmlFor="setting-site"
              hint={<>用户访问的网站地址，分享链接和使用文档里的示例都以它为基础。{settings?.public_base_url.default
                ? <>留空则使用启动参数中的默认值 <code>{settings.public_base_url.default}</code>。</>
                : <>留空则按访问者当前打开的地址生成。</>}</>}>
              <input id="setting-site" className="input mono" inputMode="url" placeholder="https://drive.example.com" value={form.public_base_url} onChange={event => { setForm({ ...form, public_base_url: event.target.value }); setError(""); }} />
            </Field>
            <Field label="同步工具地址（S3）" htmlFor="setting-s3"
              hint={<>rclone、AWS CLI 等同步工具连接用的地址，需要使用独立的域名。{settings?.s3_endpoint.default
                ? <>留空则使用启动参数中的默认值 <code>{settings.s3_endpoint.default}</code>。</>
                : <>留空时，用户在访问密钥页看不到这个地址。</>}</>}>
              <input id="setting-s3" className="input mono" inputMode="url" placeholder="https://s3.example.com" value={form.s3_endpoint} onChange={event => { setForm({ ...form, s3_endpoint: event.target.value }); setError(""); }} />
            </Field>
            {error && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{error}</div>}
            <div className="settings-actions">
              <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>保存</Button>
              {dirty && <Button variant="ghost" onClick={() => settings && setForm({ public_base_url: settings.public_base_url.value ?? "", s3_endpoint: settings.s3_endpoint.value ?? "" })}>放弃修改</Button>}
            </div>
          </form>
        </Panel>
        <Panel title="生效后的地址" description="按当前填写的内容预览，用户看到的链接会是这样。">
          <KeyValue items={[
            ["分享页", <code className="mono">{site}/s/Ab3dE5fG7hJ9kL2m</code>],
            ["文件直链", <code className="mono">{site}/p/Ab3dE5fG7hJ9kL2m/report.pdf</code>],
            ["脚本接口", <code className="mono">{site}/api/v1</code>],
            ["同步工具", s3 ? <code className="mono">aws --endpoint-url {s3} s3 ls s3://user-2/</code> : <span className="muted">未配置</span>],
          ]} />
        </Panel>
        <Panel title="部署要求">
          <ul className="plain-list">
            <li>两个域名都需要解析到 {BRAND} 服务，或由反向代理转发到服务端口（默认 8000）。</li>
            <li>反向代理必须保留原始 <code>Host</code> 请求头：同步工具的地址靠域名区分，签名校验也依赖它。</li>
            <li>公开访问地址需要能访问 <code>/s/</code>、<code>/p/</code> 与 <code>/api/</code> 路径；代理不要缓冲整个文件，否则大文件下载和视频拖动会变慢。</li>
            <li>修改地址后，已经发出的旧分享链接仍指向旧域名，令牌本身保持有效。</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}

