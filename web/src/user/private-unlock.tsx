import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import * as api from "../api";
import { passkeyUnavailable, unlockWithPrivatePasskey } from "../passkeys";
import { Button, Field, Modal, Notice } from "../ui";
import { usePrivateAccess } from "./private-session";

/** 私密空间解锁表单：账号通行密钥或登录密码。只在 PrivateUnlockDialog 内使用；独立成文件，位置选择器等底层组件也能使用而不形成循环导入。 */
export function PrivateUnlockForm() {
  const access = usePrivateAccess();
  const id = useId(), mounted = useRef(true), controller = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<api.PrivateStatus | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [usingPasskey, setUsingPasskey] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    let active = true;
    void api.privateStatus().then(value => { if (active) { setStatus(value); setError(""); } })
      .catch(reason => { if (active) setError(api.errorMessage(reason, "无法读取私密空间设置")); });
    return () => { active = false; };
  }, [revision]);
  async function quickUnlock() {
    if (busy) return;
    const accept = access.beginUnlock();
    const operation = new AbortController(); controller.current = operation;
    setBusy(true); setUsingPasskey(true); setError("");
    try { accept(await unlockWithPrivatePasskey(operation.signal)); if (mounted.current) setPassword(""); }
    catch (reason) { if (mounted.current) setError(api.errorMessage(reason, "快捷解锁失败，请使用登录密码")); }
    finally { if (mounted.current) { setBusy(false); setUsingPasskey(false); } }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!status || busy) return;
    if (!password) { setError("请输入账号登录密码"); return; }
    const accept = access.beginUnlock();
    setBusy(true); setError("");
    try {
      const grant = await api.unlockPrivate(password);
      accept(grant); if (mounted.current) setPassword("");
    } catch (reason) { if (mounted.current) setError(api.errorMessage(reason, "解锁失败，请稍后重试")); }
    finally { if (mounted.current) setBusy(false); }
  }
  if (!status) return <div className="private-loading" role="status">{error ? <><p role="alert">{error}</p><Button onClick={() => setRevision(v => v + 1)}>重试</Button></> : <><span className="spinner" />正在读取私密空间设置</>}</div>;
  const unavailable = passkeyUnavailable(status.passkeys);
  const quick = status.passkeys.registered > 0 && !unavailable;
  return <form className="form private-unlock-form" onSubmit={submit} noValidate>
    <p className="muted">{quick ? "使用账号通行密钥，或输入登录密码解锁。" : "输入账号登录密码，即可解锁私密文件，无需单独设置密码。"}</p>
    {quick && <>
      <Button variant="primary" icon="key" loading={busy && usingPasskey} disabled={busy} onClick={() => void quickUnlock()}>快捷解锁</Button>
      <p className="private-passkey-hint">使用指纹、面容或设备 PIN，由系统验证。</p>
      <div className="private-unlock-divider"><span>或使用登录密码</span></div>
    </>}
    <Field label="账号登录密码" htmlFor={`${id}-password`} error={error}>
      <input id={`${id}-password`} className="input" type="password" value={password} autoComplete="current-password" autoFocus={!quick} disabled={busy} onChange={event => { setPassword(event.target.value); setError(""); }} />
    </Field>
    <Button type="submit" variant={quick ? "secondary" : "primary"} icon="lock" loading={busy && !usingPasskey} disabled={busy || !password}>使用登录密码解锁</Button>
    <p className="private-passkey-hint">解锁后可在当前登录会话内直接返回，闲置 {status.idle_seconds / 60} 分钟自动锁定。可在「设置 → 私密空间」中调整时间。</p>
    {!quick && <p className="private-passkey-hint">{unavailable || "在侧栏的「设置」中添加通行密钥，可同时用于登录和私密解锁。"}</p>}
  </form>;
}

/**
 * 私密空间唯一的解锁入口：进入私密空间、移入移出、保存到私密目录、本机缓存、文件助手等需要解锁时都弹出它，
 * 不在页面或其他弹窗里内嵌解锁表单。解锁成功后回调 onUnlocked（调用方自行关闭或继续原操作）。
 */
export function PrivateUnlockDialog({ title = "解锁私密空间", description, onClose, onUnlocked, className = "" }: {
  title?: string; description: string; onClose: () => void; onUnlocked?: () => void; className?: string;
}) {
  const access = usePrivateAccess();
  const done = useRef(onUnlocked); done.current = onUnlocked;
  useEffect(() => { if (access.grant) done.current?.(); }, [access.grant]);
  return <Modal title={title} description={description} icon="lock" size="sm" className={`private-dialog${className ? ` ${className}` : ""}`} onClose={onClose}>
    {access.restoring ? <div className="private-loading" role="status"><span className="spinner" />正在检查私密空间</div>
      : access.error ? <div className="form"><Notice tone="danger">{access.error}</Notice><Button onClick={access.restore}>重试</Button></div>
      : <PrivateUnlockForm />}
  </Modal>;
}
