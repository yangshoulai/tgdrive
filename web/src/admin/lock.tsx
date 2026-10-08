import { useState, type FormEvent } from "react";
import { SITE } from "../brand";
import * as api from "../api";

import { Button, Field, Icon, toast, useDocumentTitle } from "../ui";

export function LockedGate({ onUnlocked }: { onUnlocked: () => void }) {
  useDocumentTitle(`系统已锁定 · ${SITE.admin}`);
  return (
    <div className="locked-gate">
      <span className="locked-icon"><Icon name="lock" size={26} /></span>
      <h1>系统已锁定</h1>
      <p>服务重启或手动锁定后，需要输入加密口令才能继续使用。解锁之前，用户无法登录，文件和公开链接也无法访问。</p>
      <UnlockForm onUnlocked={() => onUnlocked()} />
    </div>
  );
}

export function UnlockForm({ onUnlocked }: { onUnlocked: (status: api.SystemStatus) => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!passphrase) { setError("请输入加密口令"); return; }
    setBusy(true); setError("");
    try { const status = await api.adminUnlock(passphrase); setPassphrase(""); toast.success("系统已解锁"); onUnlocked(status); }
    catch (reason) { setError(reason instanceof api.ApiError && reason.code === "wrong_passphrase" ? "口令不正确" : api.errorMessage(reason, "解锁失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  return (
    <form className="unlock-form" onSubmit={submit} noValidate>
      <Field label="加密口令" htmlFor="unlock-passphrase" error={error}>
        <input id="unlock-passphrase" className="input" type="password" autoComplete="current-password" value={passphrase} onChange={event => { setPassphrase(event.target.value); setError(""); }} autoFocus />
      </Field>
      <Button type="submit" variant="primary" icon="unlock" loading={busy}>解锁</Button>
    </form>
  );
}

