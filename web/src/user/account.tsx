import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import * as api from "../api";
import { BRAND } from "../brand";
import { Avatar, Badge, Button, Icon, Modal, PageHeader, PasswordField, toast, useDocumentTitle } from "../ui";
import { PasskeysSettings } from "./passkeys";

export function UserSettingsPage({ session }: { session: api.Session }) {
  const [editing, setEditing] = useState<"password" | "passkeys" | null>(null);
  const [busy, setBusy] = useState(false);
  useDocumentTitle(`用户设置 · ${BRAND}`);
  return <div className="account-page">
    <PageHeader title="用户设置" description="管理你的登录方式，也用于解锁私密空间。" />
    <div className="account-identity">
      <Avatar name={session.username} tone={session.role === "admin" ? "admin" : "accent"} />
      <div className="account-identity-copy"><strong title={session.username}>{session.username}</strong><span>当前登录账号</span></div>
      <Badge tone={session.role === "admin" ? "accent" : "neutral"}>{session.role === "admin" ? "管理员" : "普通用户"}</Badge>
    </div>
    <PasswordSettings username={session.username} editing={editing === "password"} busy={busy} onBusyChange={setBusy}
      onOpen={() => setEditing("password")} onClose={() => setEditing(null)} />
    <PasskeysSettings username={session.username} active={editing === "passkeys"} busy={busy} onBusyChange={setBusy}
      onOpen={() => setEditing("passkeys")} onClose={() => setEditing(null)} />
    <p className="account-page-help"><Icon name="info" size={16} /><span>忘记登录密码？请联系管理员重置。<a className="link" href="/docs/files#private-space" target="_blank" rel="noreferrer">了解登录与私密解锁</a></span></p>
  </div>;
}

function PasswordSettings({ username, editing, busy, onOpen, onClose, onBusyChange }: {
  username: string; editing: boolean; busy: boolean; onOpen: () => void; onClose: () => void; onBusyChange: (value: boolean) => void;
}) {
  const id = useId();
  const [updated, setUpdated] = useState(false);
  return <section className="account-section" aria-labelledby={`${id}-title`}>
    <header className="account-section-heading"><Icon name="lock" size={20} /><div><h2 id={`${id}-title`}>登录密码</h2><p>账号登录和私密空间共用。</p></div></header>
    <div className="account-section-content">
      <div className="account-setting-summary"><div><strong>{updated ? "密码已更新" : "密码已设置"}</strong><p>使用当前登录密码确认后，即可设置新密码。</p></div>
        <Button disabled={busy} aria-haspopup="dialog" onClick={() => { setUpdated(false); onOpen(); }}>修改密码</Button>
      </div>
      {editing ? <ChangePasswordDialog id={`${id}-form`} username={username} busy={busy} onBusyChange={onBusyChange}
        onCancel={onClose} onSaved={() => { setUpdated(true); onClose(); }} />
        : updated && <p className="account-feedback" role="status"><Icon name="checkCircle" size={17} />私密空间已使用新密码，当前账号保持登录。</p>}
    </div>
  </section>;
}

function ChangePasswordDialog({ id, username, busy, onBusyChange, onCancel, onSaved }: {
  id: string; username: string; busy: boolean; onBusyChange: (value: boolean) => void; onCancel: () => void; onSaved: () => void;
}) {
  const mounted = useRef(true), submitting = useRef(false);
  const [form, setForm] = useState({ old: "", next: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({}), [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function change(key: keyof typeof form, value: string) {
    setForm(previous => ({ ...previous, [key]: value }));
    setErrors(previous => ({ ...previous, [key]: "" })); setError("");
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitting.current) return;
    const next: Record<string, string> = {};
    if (!form.old) next.old = "请输入当前登录密码";
    if (form.next.length < 8) next.next = "新密码至少 8 个字符";
    else if (form.next === form.old) next.next = "请使用与当前密码不同的新密码";
    if (!form.confirm) next.confirm = "请再次输入新密码";
    else if (form.next !== form.confirm) next.confirm = "两次输入的密码不一致";
    setErrors(next); setError("");
    if (Object.keys(next).length) {
      event.currentTarget.querySelector<HTMLInputElement>(`[name="${Object.keys(next)[0]}"]`)?.focus(); return;
    }
    submitting.current = true; setSaving(true); onBusyChange(true);
    try {
      await api.changePassword(form.old, form.next);
      toast.success("登录密码已更新");
      if (mounted.current) { onBusyChange(false); onSaved(); }
    } catch (reason) {
      if (mounted.current) setError(api.errorMessage(reason, "密码未更新，请稍后重试"));
    } finally {
      submitting.current = false;
      if (mounted.current) { setSaving(false); onBusyChange(false); }
    }
  }
  return <Modal className="account-action-dialog" title="修改登录密码" icon="lock" onClose={onCancel} dismissible={!busy}
    description="新密码将同时用于账号登录和私密空间解锁。"
    footer={<><Button disabled={busy} onClick={onCancel}>取消</Button><Button variant="primary" type="submit" form={id} loading={saving} disabled={busy && !saving}>更新密码</Button></>}>
    <form id={id} className="form" onSubmit={submit} noValidate aria-label="修改登录密码">
    <input className="sr-only" name="username" autoComplete="username" value={username} readOnly tabIndex={-1} aria-hidden="true" />
    <PasswordField label="当前登录密码" name="old" value={form.old} onChange={value => change("old", value)} error={errors.old} disabled={busy} autoFocus />
    <PasswordField label="新密码" name="next" value={form.next} onChange={value => change("next", value)} autoComplete="new-password" error={errors.next} hint="至少 8 个字符" disabled={busy} />
    <PasswordField label="确认新密码" name="confirm" value={form.confirm} onChange={value => change("confirm", value)} autoComplete="new-password" error={errors.confirm}
      hint={form.confirm && form.confirm === form.next && form.next.length >= 8 ? <span className="tone-success">两次输入一致</span> : undefined} disabled={busy} />
    <p className="account-editor-note">修改后，其他设备需要重新登录，私密空间需要重新解锁。已添加的通行密钥仍可使用。</p>
    {error && <p className="form-alert" role="alert">{error}</p>}
    </form>
  </Modal>;
}
