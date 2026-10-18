import { useEffect, useState, type FormEvent } from "react";
import * as api from "./api";
import { BRAND } from "./brand";
import { AuthLayout, FullPageLoading } from "./shell";
import { Button, ButtonLink, Field, Notice, Segmented, formatBytes, useDocumentTitle } from "./ui";

/** 邀请链接固定本页的验证方式与邀请码；普通入口可在管理员开放的方式中选择。 */
export function RegisterPage() {
  const [linkedInvite] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("invite"));
  const [config, setConfig] = useState<api.RegistrationConfig | null>(null);
  const [loadError, setLoadError] = useState("");
  const [method, setMethod] = useState<"email" | "invite">(linkedInvite !== null ? "invite" : "email");
  const [form, setForm] = useState({ email: "", password: "", confirm: "", invite: linkedInvite ?? "", code: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false), [sending, setSending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sent, setSent] = useState("");
  const [retryAt, setRetryAt] = useState(0), [now, setNow] = useState(Date.now());
  const [created, setCreated] = useState<{ username: string; quota_bytes: number | null } | null>(null);
  useDocumentTitle(`注册 · ${BRAND}`);
  useEffect(() => {
    const controller = new AbortController();
    void api.registrationConfig(controller.signal).then(value => {
      setConfig(value);
      if (linkedInvite === null) setMethod(value.email_enabled ? "email" : "invite");
    }).catch(reason => { if (!controller.signal.aborted) setLoadError(api.errorMessage(reason, "注册信息加载失败")); });
    return () => controller.abort();
  }, [linkedInvite]);
  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setInterval(() => { const current = Date.now(); setNow(current); if (current >= retryAt) window.clearInterval(timer); }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  const countdown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const update = (key: keyof typeof form, value: string) => {
    setForm(current => ({ ...current, [key]: value }));
    setErrors({});
    if (key === "email") { setSent(""); setForm(current => ({ ...current, code: "" })); }
  };
  async function sendCode() {
    const email = form.email.trim();
    if (!api.isEmail(email)) { setErrors({ email: "请输入有效的邮箱地址" }); return; }
    if (sending || busy || countdown) return;
    setSending(true); setErrors({});
    try {
      const result = await api.sendRegistrationCode(email);
      setSent(email); setNow(Date.now()); setRetryAt(Date.now() + result.resend_after * 1000);
    } catch (reason) { setErrors({ request: api.errorMessage(reason, "验证码发送失败，请稍后重试") }); }
    finally { setSending(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || sending) return;
    const next: Record<string, string> = {};
    if (!api.isEmail(form.email.trim())) next.email = "请输入有效的邮箱地址";
    if (form.password.length < 8 || form.password.length > 1024) next.password = "登录密码需要 8–1024 个字符";
    if (form.confirm !== form.password) next.confirm = "两次输入的密码不一致";
    if (method === "invite" && !form.invite.trim()) next.invite = "请输入邀请码";
    if (method === "email" && !/^[0-9]{6}$/.test(form.code.trim())) next.code = "请输入 6 位邮箱验证码";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const result = await api.registerAccount({ email: form.email.trim(), password: form.password, method,
        ...(method === "invite" ? { invite_code: form.invite.trim() } : { email_code: form.code.trim() }) });
      setCreated(result);
      setForm({ email: "", password: "", confirm: "", invite: "", code: "" });
      try { localStorage.setItem("tessera:last-username", result.username); } catch { /* 不影响注册完成 */ }
      window.history.replaceState(null, "", "/register");
    } catch (reason) { setErrors({ request: api.errorMessage(reason, "注册失败，请稍后重试") }); }
    finally { setBusy(false); }
  }
  if (!config && !loadError) return <FullPageLoading label="正在读取注册信息" />;
  if (created) return <AuthLayout admin={false} title="注册成功" description="你的文件空间已准备就绪。" footer={<a href="/docs">使用文档</a>}>
    <div className="form"><Notice tone="success">已创建账号 {created.username}。{created.quota_bytes === null ? "存储空间不限。" : `存储额度为 ${formatBytes(created.quota_bytes)}。`}</Notice>
      <ButtonLink href="/" variant="primary" size="lg">去登录</ButtonLink></div>
  </AuthLayout>;
  const unavailable = loadError || (!config?.enabled ? "管理员尚未开放注册，请联系管理员创建账号。"
    : !config.available ? "服务正在等待管理员完成启动，请稍后再来注册。"
    : linkedInvite !== null && !config.invite_enabled ? "管理员尚未开放邀请码注册，请从登录页重新进入注册。"
    : linkedInvite !== null && !/^[A-Za-z0-9_-]{24}$/.test(linkedInvite) ? "邀请链接不完整，请联系管理员重新获取。" : "");
  return <AuthLayout admin={false} title="创建账号" description="注册你的文件空间。" footer={<><a href="/docs">使用文档</a><span>已有账号？<a href="/">登录</a></span></>}>
    {unavailable ? <div className="form"><Notice>{unavailable}</Notice>{loadError && <Button onClick={() => window.location.reload()}>重新加载</Button>}<ButtonLink href="/">返回登录</ButtonLink></div> : <form className="form" onSubmit={submit} noValidate>
      {linkedInvite === null && config?.email_enabled && config.invite_enabled && <Segmented label="注册验证方式" value={method} disabled={busy || sending}
        onChange={value => { setMethod(value); setErrors({}); }} options={[{ value: "email", label: "邮箱验证码" }, { value: "invite", label: "邀请码" }]} />}
      <Field label="邮箱" htmlFor="register-email" error={errors.email} hint="用作登录账号。">
        <input id="register-email" name="username" className="input" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254}
          value={form.email} onChange={event => update("email", event.target.value)} disabled={busy || sending} autoFocus />
      </Field>
      <Field label="登录密码" htmlFor="register-password" error={errors.password} hint="至少 8 个字符。">
        <div className="input-affix registration-password"><input id="register-password" name="new-password" className="input" type={showPassword ? "text" : "password"} autoComplete="new-password" maxLength={1024}
          value={form.password} onChange={event => update("password", event.target.value)} disabled={busy} />
          <button type="button" className="affix-toggle" aria-pressed={showPassword} disabled={busy} onClick={() => setShowPassword(value => !value)}>{showPassword ? "隐藏" : "显示"}</button></div>
      </Field>
      <Field label="确认密码" htmlFor="register-confirm" error={errors.confirm}>
        <input id="register-confirm" name="confirm-password" className="input" type="password" autoComplete="new-password" maxLength={1024} value={form.confirm} onChange={event => update("confirm", event.target.value)} disabled={busy} />
      </Field>
      {method === "invite" ? <Field label="邀请码" htmlFor="register-invite" error={errors.invite} hint={linkedInvite !== null ? "来自邀请链接，已自动填入且不能更改。每个邀请码仅可使用一次。" : "向管理员获取，需在有效期内使用。"}>
        <input id="register-invite" name="invite" className="input mono" value={form.invite} onChange={event => update("invite", event.target.value)} readOnly={linkedInvite !== null} disabled={busy} autoComplete="off" spellCheck={false} maxLength={128} />
      </Field> : <Field label="邮箱验证码" htmlFor="register-code" error={errors.code} hint={sent ? `已发送至 ${sent}，10 分钟内有效。未收到时请检查垃圾邮件。` : "验证邮箱归属后即可完成注册。"}>
        <div className="registration-code-row"><input id="register-code" name="code" className="input mono" value={form.code} onChange={event => update("code", event.target.value.replace(/[^0-9]/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={busy} />
          <Button onClick={() => void sendCode()} loading={sending} disabled={busy || sending || countdown > 0}>{countdown ? `${countdown} 秒后重发` : sent ? "重新发送" : "获取验证码"}</Button></div>
      </Field>}
      {errors.request && <Notice tone="danger">{errors.request}</Notice>}
      <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={sending}>创建账号</Button>
    </form>}
  </AuthLayout>;
}
