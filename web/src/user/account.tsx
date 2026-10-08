import { useState, type FormEvent, type ReactNode } from "react";

import * as api from "../api";

import { Button, Field, Modal, toast } from "../ui";

/* ---------- 账号 ---------- */

export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ old: "", next: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!form.old) next.old = "请输入当前密码";
    if (form.next.length < 8) next.next = "新密码至少 8 个字符";
    else if (form.next !== form.confirm) next.confirm = "两次输入的密码不一致";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try { await api.changePassword(form.old, form.next); toast.success("密码已更新"); onClose(); }
    catch (reason) { setErrors({ old: api.errorMessage(reason, "修改失败，请稍后重试") }); }
    finally { setBusy(false); }
  }
  const field = (key: keyof typeof form, label: string, autoComplete: string): ReactNode => (
    <Field label={label} htmlFor={`pw-${key}`} error={errors[key]}>
      <input id={`pw-${key}`} className="input" type="password" autoComplete={autoComplete} value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} />
    </Field>
  );
  return (
    <Modal title="修改密码" icon="lock" onClose={onClose} size="sm"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="pw-form" loading={busy}>更新密码</Button></>}>
      <form id="pw-form" className="form" onSubmit={submit} noValidate>
        {field("old", "当前密码", "current-password")}
        {field("next", "新密码", "new-password")}
        {field("confirm", "确认新密码", "new-password")}
      </form>
    </Modal>
  );
}
