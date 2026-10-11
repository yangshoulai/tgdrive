import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import * as api from "../api";
import { BRAND } from "../brand";
import { Button, Field, Icon, Modal, PageHeader, toast, useDocumentTitle } from "../ui";
import { FilesView } from "./files";
import { TrashView } from "./trash";
import type { UploadQueue } from "./uploads";
import { PrivateIdleSelect, PrivateUnlockForm } from "./private-access";
import { usePrivateSession } from "./private-session";

export function PrivateSpaceView({ session, prefix, onOpenFolder, onChanged, uploads, uploadRevision, onExit }: {
  session: api.Session; prefix: string; onOpenFolder: (prefix: string) => void; onChanged: () => void;
  uploads: UploadQueue; uploadRevision: number; onExit: () => void;
}) {
  useDocumentTitle(`私密空间 · ${BRAND}`);
  const [grant, setGrant] = useState<api.PrivateGrant | null>(null);
  const [trash, setTrash] = useState(false), [settings, setSettings] = useState(false);
  const uploadsRef = useRef(uploads); uploadsRef.current = uploads;
  const unlocked = usePrivateSession(grant, () => {
    uploadsRef.current.cancelPrivate(); setGrant(null); onExit(); toast.info("私密空间已锁定");
  }, ".private-space, .preview-modal, .private-dialog, .private-transfer, .private-settings");
  useEffect(() => () => { uploadsRef.current.cancelPrivate(); }, []);
  if (!grant) return <>
    <PageHeader title="私密空间" description="单独保护文件和文件夹，每次进入都需要访问密码。" />
    <section className="private-gate" aria-label="解锁私密空间">
      <span className="locked-icon"><Icon name="lock" size={26} /></span>
      <h2>解锁后查看私密文件</h2>
      <PrivateUnlockForm onUnlocked={value => { api.setPrivateAccess(value.access); setGrant(value); }} />
    </section>
  </>;
  return <div className="private-space">
    <div className="private-toolbar">
      <span className="private-status"><Icon name="lock" size={16} />已解锁<span className="muted">闲置 {grant.idle_seconds / 60} 分钟后锁定</span></span>
      <div className="toolbar-actions">
        <Button size="sm" icon={trash ? "folder" : "trash"} onClick={() => setTrash(value => !value)}>{trash ? "返回私密文件" : "私密回收站"}</Button>
        <Button size="sm" icon="settings" onClick={() => setSettings(true)}>设置</Button>
        <Button size="sm" icon="lock" onClick={unlocked.lock}>立即锁定</Button>
      </div>
    </div>
    {trash ? <TrashView root={api.PRIVATE_PREFIX} onChanged={onChanged} onOpenFolder={path => { setTrash(false); onOpenFolder(path); }} />
      : <FilesView key={grant.access} session={session} prefix={prefix} onOpenFolder={onOpenFolder} onChanged={onChanged} uploads={uploads} uploadRevision={uploadRevision} onPlayback={unlocked.onPlayback} />}
    {settings && <PrivateSettings grant={grant} onClose={() => setSettings(false)} onSaved={value => { api.setPrivateAccess(value.access); setGrant(value); setSettings(false); }} />}
  </div>;
}

function PrivateSettings({ grant, onClose, onSaved }: { grant: api.PrivateGrant; onClose: () => void; onSaved: (grant: api.PrivateGrant) => void }) {
  const id = useId();
  const [password, setPassword] = useState(""), [newPassword, setNewPassword] = useState(""), [confirmation, setConfirmation] = useState("");
  const [idle, setIdle] = useState(grant.idle_seconds), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (newPassword && newPassword.length < 8) { setError("新访问密码至少需要 8 个字符"); return; }
    if (newPassword !== confirmation) { setError("两次输入的新访问密码不一致"); return; }
    setBusy(true); setError("");
    try { const result = await api.configurePrivate(password, idle, newPassword || undefined); onSaved(result); toast.success("私密空间设置已保存"); }
    catch (reason) { setError(api.errorMessage(reason, "设置保存失败，请重试")); }
    finally { setBusy(false); }
  }
  return <Modal className="private-settings" title="私密空间设置" icon="lock" onClose={onClose} dismissible={!busy}
    description="保存后关闭当前预览，其他已解锁窗口需要重新输入密码。"
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" type="submit" form={id} loading={busy} disabled={!password}>保存</Button></>}>
    <form id={id} className="form" onSubmit={save} noValidate>
      <PrivateIdleSelect value={idle} onChange={setIdle} />
      <Field label="当前访问密码" htmlFor={`${id}-old`} error={error}><input id={`${id}-old`} className="input" type="password" autoComplete="current-password" value={password} disabled={busy} onChange={event => { setPassword(event.target.value); setError(""); }} /></Field>
      <Field label="新访问密码（可选）" htmlFor={`${id}-new`} hint="留空则保留当前访问密码。"><input id={`${id}-new`} className="input" type="password" autoComplete="new-password" value={newPassword} disabled={busy} onChange={event => setNewPassword(event.target.value)} /></Field>
      <Field label="确认新访问密码" htmlFor={`${id}-confirm`}><input id={`${id}-confirm`} className="input" type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></Field>
    </form>
  </Modal>;
}
