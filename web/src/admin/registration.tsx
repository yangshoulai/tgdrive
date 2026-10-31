import { useCallback, useEffect, useState, type FormEvent } from "react";
import * as api from "../api";
import { useCursorPage } from "../pagination";
import { Badge, Button, ConfirmDialog, EmptyState, Field, Menu, Modal, Notice, Pagination, Panel, SkeletonRows, Switch, copyText, formatBytes, formatDateTime, toast, useUnsavedChanges } from "../ui";

const GIB = 1024 ** 3;
const quotaInput = (value: number | null) => value === null ? "" : String(value / GIB);
function parseQuota(value: string): number | null {
  if (!value.trim()) return null;
  const amount = Number(value);
  const bytes = Math.round(amount * GIB);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(bytes)) throw new Error("额度需为非负数字，留空表示不限");
  return bytes;
}
type SettingsForm = { enabled: boolean; email_enabled: boolean; invite_enabled: boolean; quota: string; smtp: api.SmtpConfig; password: string; clearPassword: boolean };
function settingsForm(value: api.RegistrationSettings): SettingsForm {
  const { has_password: _hasPassword, ...smtp } = value.smtp;
  return { enabled: value.enabled, email_enabled: value.email_enabled, invite_enabled: value.invite_enabled,
    quota: quotaInput(value.default_quota_bytes), smtp, password: "", clearPassword: false };
}

export function RegistrationSettings() {
  const [saved, setSaved] = useState<api.RegistrationSettings | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [testing, setTesting] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testResult, setTestResult] = useState("");
  useEffect(() => {
    let alive = true;
    void api.adminRegistration().then(value => { if (alive) { setSaved(value); setForm(settingsForm(value)); } })
      .catch(reason => { if (alive) setError(api.errorMessage(reason, "注册配置加载失败")); });
    return () => { alive = false; };
  }, []);
  const dirty = Boolean(form && saved && JSON.stringify(form) !== JSON.stringify(settingsForm(saved)));
  useUnsavedChanges(dirty);
  function change(patch: Partial<SettingsForm>) { setForm(current => current && { ...current, ...patch }); setError(""); setTestResult(""); }
  function smtpChange(patch: Partial<api.SmtpConfig>) { if (form) change({ smtp: { ...form.smtp, ...patch } }); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form || busy || testing) return;
    setError("");
    let quota: number | null;
    try { quota = parseQuota(form.quota); } catch (reason) { setError(api.errorMessage(reason, "额度不合法")); return; }
    if (form.enabled && !form.email_enabled && !form.invite_enabled) { setError("开启注册时至少选择一种验证方式"); return; }
    setBusy(true);
    try {
      const result = await api.updateRegistration({ enabled: form.enabled, email_enabled: form.email_enabled, invite_enabled: form.invite_enabled,
        default_quota_bytes: quota, smtp: form.smtp, smtp_password: form.password, clear_smtp_password: form.clearPassword });
      setSaved(result); setForm(settingsForm(result)); toast.success("注册配置已保存，立即生效");
    } catch (reason) { setError(api.errorMessage(reason, "注册配置保存失败")); }
    finally { setBusy(false); }
  }
  async function testMail() {
    if (!api.isEmail(testEmail.trim())) { setError("请填写有效的测试收件邮箱"); return; }
    if (dirty || busy || testing) return;
    setError(""); setTestResult(""); setTesting(true);
    try { await api.testRegistrationEmail(testEmail.trim()); setTestResult(`测试邮件已发送至 ${testEmail.trim()}，请检查收件箱或垃圾邮件。`); }
    catch (reason) { setError(api.errorMessage(reason, "测试邮件发送失败")); }
    finally { setTesting(false); }
  }
  if (!form || !saved) return <Panel>{error ? <Notice tone="danger">{error}<Button onClick={() => window.location.reload()}>重新加载</Button></Notice> : <SkeletonRows rows={4} />}</Panel>;
  return <div className="stack">
    <Panel title="访客注册" description="关闭注册后，入口隐藏，注册接口和已有邀请链接暂停使用。已有账号仍可正常登录。">
      <form className="form settings-form" onSubmit={submit} noValidate>
        <div className="registration-switches">
          <Switch label="开放注册" description="允许访客通过邮箱创建账号。" checked={form.enabled} onChange={enabled => change({ enabled })} disabled={busy || testing} />
          <Switch label="邮箱验证码" description="通过邮件验证邮箱归属，需要先配置下方邮件服务器。" checked={form.email_enabled} onChange={email_enabled => change({ email_enabled })} disabled={busy || testing} />
          <Switch label="邀请码" description="凭管理员创建的一次性邀请码注册。两种方式都开启时，访客任选一种。" checked={form.invite_enabled} onChange={invite_enabled => change({ invite_enabled })} disabled={busy || testing} />
        </div>
        <Field label="新用户默认额度（GiB）" htmlFor="registration-quota" hint="留空表示不限，0 表示暂不允许上传。仅影响之后通过邮箱验证码注册的用户，以及之后创建的邀请码。">
          <input id="registration-quota" className="input" type="number" min="0" step="any" value={form.quota} onChange={event => change({ quota: event.target.value })} placeholder="不限" disabled={busy || testing} />
        </Field>
        {form.email_enabled && <>
          <div className="registration-section"><h3>邮件服务器</h3><p>支持 SSL/TLS 与 STARTTLS。使用邮箱服务商提供的 SMTP 地址和授权码，保存后可发送测试邮件。</p></div>
          <Field label="SMTP 服务器" htmlFor="registration-host" hint="只填写主机名，例如 smtp.example.com。">
            <input id="registration-host" className="input mono" value={form.smtp.host} onChange={event => smtpChange({ host: event.target.value })} placeholder="smtp.example.com" autoComplete="off" disabled={busy || testing} />
          </Field>
          <Field label="连接加密" htmlFor="registration-security" hint="SSL/TLS 常用 465 端口，STARTTLS 常用 587 端口。以邮箱服务商的说明为准。">
            <div className="form-row"><select id="registration-security" className="input" value={form.smtp.security} disabled={busy || testing} onChange={event => { const security = event.target.value as api.SmtpConfig["security"]; smtpChange({ security, port: security === "ssl" ? 465 : 587 }); }}>
              <option value="ssl">SSL/TLS</option><option value="starttls">STARTTLS</option></select>
              <input aria-label="SMTP 端口" className="input" type="number" min="1" max="65535" value={form.smtp.port || ""} onChange={event => smtpChange({ port: Number(event.target.value) })} disabled={busy || testing} /></div>
          </Field>
          <Field label="邮件账号" htmlFor="registration-smtp-user" hint="通常为完整邮箱地址。只有服务商明确支持免认证中继时才留空。">
            <input id="registration-smtp-user" className="input" value={form.smtp.username} onChange={event => smtpChange({ username: event.target.value })} autoComplete="off" disabled={busy || testing} />
          </Field>
          <Field label="密码或授权码" htmlFor="registration-smtp-password" hint={saved.smtp.has_password ? "已加密保存，留空保留原值。更换邮件账号时请一并更新。" : "填写 SMTP 密码或邮箱服务商生成的授权码，保存后不再回显。"}>
            <div className="stack"><input id="registration-smtp-password" name="smtp-secret" className="input" type="password" autoComplete="new-password" value={form.password} onChange={event => change({ password: event.target.value, clearPassword: false })} placeholder={saved.smtp.has_password ? "已保存，留空不修改" : "密码或授权码"} disabled={busy || testing} />
              {saved.smtp.has_password && <Switch label="清除已保存的邮件密码" checked={form.clearPassword} onChange={clearPassword => change({ clearPassword, password: "" })} disabled={busy || testing} />}</div>
          </Field>
          <Field label="发件邮箱" htmlFor="registration-sender" hint="需为邮件服务商允许发送的地址。">
            <input id="registration-sender" className="input" type="email" value={form.smtp.sender} onChange={event => smtpChange({ sender: event.target.value })} autoComplete="off" disabled={busy || testing} />
          </Field>
          <Field label="发件人名称" htmlFor="registration-sender-name">
            <input id="registration-sender-name" className="input" value={form.smtp.sender_name} onChange={event => smtpChange({ sender_name: event.target.value })} disabled={busy || testing} />
          </Field>
          <Field label="测试收件邮箱" htmlFor="registration-test-email" hint={dirty ? "请先保存配置，再发送测试邮件。" : "使用已保存的配置发送，可同时检查验证码邮件的排版。"}>
            <div className="registration-code-row"><input id="registration-test-email" className="input" type="email" value={testEmail} onChange={event => setTestEmail(event.target.value)} placeholder="name@example.com" disabled={busy || testing} />
              <Button onClick={() => void testMail()} loading={testing} disabled={dirty || busy || testing}>发送测试</Button></div>
          </Field>
        </>}
        {error && <Notice className="registration-message" tone="danger">{error}</Notice>}
        {testResult && <Notice className="registration-message" tone="success">{testResult}</Notice>}
        {(dirty || busy) && <div className="settings-actions"><span className="settings-actions-note">有未保存的修改</span>
          <Button variant="ghost" disabled={busy || testing} onClick={() => { setForm(settingsForm(saved)); setError(""); }}>放弃修改</Button>
          <Button variant="primary" type="submit" loading={busy} disabled={testing}>保存</Button></div>}
      </form>
    </Panel>
    <Invitations defaultQuota={saved.default_quota_bytes} />
  </div>;
}

const statusLabels = { active: "可使用", used: "已使用", expired: "已过期", revoked: "已撤销" } as const;
function Invitations({ defaultQuota }: { defaultQuota: number | null }) {
  const [status, setStatus] = useState("all");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<api.Invitation[] | null>(null);
  const [revoking, setRevoking] = useState<api.Invitation | null>(null);
  const fetchPage = useCallback((cursor: string | null) => api.adminInvitations(cursor, status), [status]);
  const pagination = useCursorPage(fetchPage);
  const invites = pagination.page?.invites ?? null;
  return <Panel title="邀请码" description="每个邀请码仅供一人注册，必须在失效时间前使用。额度在创建时确定，之后修改默认额度不会改变已有邀请码。" flush
    actions={invites?.length ? <Button icon="plus" onClick={() => setCreating(true)}>创建邀请码</Button> : undefined}>
    <div className="toolbar registration-invite-toolbar"><label className="sr-only" htmlFor="invitation-status">邀请码状态</label><select id="invitation-status" className="input" value={status} onChange={event => setStatus(event.target.value)}>
      <option value="all">全部邀请码</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <Button icon="refresh" variant="ghost" loading={pagination.refreshing} onClick={() => void pagination.refresh()}>刷新</Button></div>
    <section className="file-surface">
      {pagination.error ? <EmptyState icon="alert" title="邀请码加载失败" description={pagination.error} action={<Button onClick={() => void pagination.reload()}>重试</Button>} />
        : invites === null ? <SkeletonRows rows={3} /> : invites.length === 0 ? <EmptyState icon="key" title={status === "all" ? "还没有邀请码" : "没有符合条件的邀请码"} action={<Button icon="plus" onClick={() => setCreating(true)}>创建邀请码</Button>} />
        : <div className="data-table invitations-table" role="table" aria-label="邀请码">
          <div className="data-row data-head" role="row"><span role="columnheader">邀请码</span><span role="columnheader">用户额度</span><span role="columnheader">失效时间</span><span role="columnheader">状态</span><span role="columnheader"><span className="sr-only">操作</span></span></div>
          {invites.map(invite => <div className="data-row" role="row" key={invite.id}>
            <span role="cell" className="mono">{invite.code}</span><span role="cell">{invite.quota_bytes === null ? "不限" : formatBytes(invite.quota_bytes)}</span>
            <span role="cell" className="muted">{formatDateTime(invite.expires_at)}</span>
            <span role="cell"><Badge tone={invite.status === "active" ? "success" : "neutral"}>{statusLabels[invite.status]}</Badge></span>
            <span role="cell" className="cell-actions"><Button size="sm" icon="link" disabled={invite.status !== "active"} onClick={() => void copyText(api.invitationUrl(invite.code), "邀请链接已复制")}>复制链接</Button>
              <Menu label={`邀请码 ${invite.id} 的更多操作`} items={[
                { label: "复制邀请码", icon: "copy", onSelect: () => void copyText(invite.code, "邀请码已复制") },
                ...(invite.status === "active" ? [{ label: "撤销邀请码", icon: "x" as const, danger: true, divider: true, onSelect: () => setRevoking(invite) }] : []),
              ]} /></span>
          </div>)}
        </div>}
    </section>
    <footer className="list-footer registration-invite-footer"><span>共 {pagination.page?.total ?? "…"} 个邀请码</span><Pagination {...pagination} /></footer>
    {creating && <CreateInvitations defaultQuota={defaultQuota} onClose={() => setCreating(false)} onCreated={items => { setCreating(false); setCreated(items); void pagination.reload(); }} />}
    {created && <Modal title={`已创建 ${created.length} 个邀请码`} description="复制链接发给受邀者。打开链接后会自动填入邀请码，且不能更改。" icon="key" onClose={() => setCreated(null)}
      footer={<><Button onClick={() => setCreated(null)}>完成</Button><Button variant="primary" icon="copy" onClick={() => void copyText(created.map(item => api.invitationUrl(item.code)).join("\n"), "全部邀请链接已复制")}>复制全部链接</Button></>}>
      <Field label="邀请链接，每行一个" htmlFor="created-invitation-links" hint={`失效时间：${formatDateTime(created[0].expires_at)}；用户额度：${created[0].quota_bytes === null ? "不限" : formatBytes(created[0].quota_bytes)}。`}>
        <textarea id="created-invitation-links" className="input mono" rows={Math.min(10, created.length * 2)} readOnly value={created.map(item => api.invitationUrl(item.code)).join("\n")} onFocus={event => event.target.select()} />
      </Field>
    </Modal>}
    {revoking && <ConfirmDialog title="撤销这个邀请码？" description="撤销后，此邀请码和对应邀请链接立即失效，无法用于注册。" confirmLabel="撤销邀请码" onClose={() => setRevoking(null)} onConfirm={async () => {
      await api.revokeInvitation(revoking.id); toast.success("邀请码已撤销"); setRevoking(null); void pagination.refresh();
    }} />}
  </Panel>;
}

function CreateInvitations({ defaultQuota, onClose, onCreated }: { defaultQuota: number | null; onClose: () => void; onCreated: (items: api.Invitation[]) => void }) {
  const [count, setCount] = useState("1");
  const [quota, setQuota] = useState(quotaInput(defaultQuota));
  const [expires, setExpires] = useState(() => { const date = new Date(Date.now() + 7 * 86400 * 1000); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    const amount = Number(count), expiry = new Date(expires).getTime() / 1000;
    if (!Number.isInteger(amount) || amount < 1 || amount > 100) { setError("一次可以创建 1–100 个邀请码"); return; }
    if (!Number.isFinite(expiry) || expiry <= Date.now() / 1000) { setError("请选择将来的失效时间"); return; }
    let bytes: number | null;
    try { bytes = parseQuota(quota); } catch (reason) { setError(api.errorMessage(reason, "额度不合法")); return; }
    setBusy(true);
    try { const result = await api.createInvitations({ count: amount, expires_at: expiry, quota_bytes: bytes }); onCreated(result.invites); }
    catch (reason) { setError(api.errorMessage(reason, "邀请码创建失败")); }
    finally { setBusy(false); }
  }
  return <Modal title="创建邀请码" description="每个邀请码仅能使用一次。批量创建的所有邀请码使用相同的额度与失效时间。" icon="key" onClose={onClose}
    footer={<><Button onClick={onClose} disabled={busy}>取消</Button><Button type="submit" form="create-invitations" variant="primary" loading={busy}>创建邀请码</Button></>}>
    <form id="create-invitations" className="form" onSubmit={submit} noValidate>
      <Field label="数量" htmlFor="invitation-count" hint="一次最多创建 100 个。"><input id="invitation-count" className="input" type="number" min="1" max="100" value={count} onChange={event => setCount(event.target.value)} disabled={busy} autoFocus /></Field>
      <Field label="失效时间" htmlFor="invitation-expiry" hint="按当前设备的本地时间填写。"><input id="invitation-expiry" className="input" type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} disabled={busy} /></Field>
      <Field label="用户额度（GiB）" htmlFor="invitation-quota" hint="已填入当前新用户默认额度，可为这批受邀者单独调整。留空不限，0 表示暂不允许上传。"><input id="invitation-quota" className="input" type="number" min="0" step="any" value={quota} onChange={event => setQuota(event.target.value)} placeholder="不限" disabled={busy} /></Field>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  </Modal>;
}
