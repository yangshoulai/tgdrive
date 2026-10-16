import { useEffect, useState, type FormEvent } from "react";
import { BRAND, SITE } from "../brand";
import * as api from "../api";
import { Resources } from "./resources";

import { Button, Field, Icon, KeyValue, PageHeader, Panel, SetupGuide, SkeletonRows, toast, useDocumentTitle } from "../ui";

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
      <PageHeader title="系统设置" />
      <SetupGuide id="system-settings" title="访问地址配置指南" description="让分享链接、使用文档和同步工具指向正确的域名。" docHref="/docs/deploy"
        defaultOpen={!settings?.public_base_url.value && !settings?.public_base_url.default} steps={[
          { title: "准备域名", body: <p>网站用一个域名（如 <code>drive.example.com</code>）；如果要给 rclone、AWS CLI 等同步工具使用，再准备一个<strong>独立</strong>的域名（如 <code>s3.example.com</code>）。两个域名都解析到运行 {BRAND} 的服务器。</p> },
          { title: "配置反向代理和 HTTPS", body: <>
            <p>两个域名都转发到服务端口（默认 8000），并保留原始 <code>Host</code>：同步工具靠域名区分，签名校验也依赖它。不要缓冲响应，否则大文件下载和视频拖动会变慢。nginx 示例：</p>
            <pre><code>{`location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_request_buffering off;
    client_max_body_size 0;
}`}</code></pre>
            <p>生产环境必须使用 HTTPS，登录 Cookie 只会经 HTTPS 发送。</p>
          </> },
          { title: "填写下方地址并保存", body: <p>公开访问地址填网站域名，同步工具地址填 S3 域名，都要带 <code>https://</code>。保存后「生效后的地址」会显示用户看到的链接样式。</p> },
          { title: "验证", body: <p>在无痕窗口打开一个分享链接确认能访问；用访问密钥运行 <code>aws --endpoint-url https://s3.example.com s3 ls</code> 确认同步工具能列出存储桶。修改地址后，已发出的旧链接仍指向旧域名，令牌本身保持有效。</p> },
        ]} />
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
            {/* 有改动时才出现保存栏，不常驻一个灰色的禁用按钮。 */}
            {(dirty || busy) && <div className="settings-actions">
              <span className="settings-actions-note">有未保存的修改</span>
              <Button variant="ghost" disabled={busy} onClick={() => settings && setForm({ public_base_url: settings.public_base_url.value ?? "", s3_endpoint: settings.s3_endpoint.value ?? "" })}>放弃修改</Button>
              <Button type="submit" variant="primary" loading={busy}>保存</Button>
            </div>}
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
        <Resources />
      </div>
    </>
  );
}

