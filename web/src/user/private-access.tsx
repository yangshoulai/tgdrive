import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import * as api from "../api";
import { Button, Field, Icon, Modal, Segmented, toast } from "../ui";
import { FolderPicker } from "./folders";
import { usePrivateSession } from "./private-session";

export function PrivateIdleSelect({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const id = useId();
  return <Field label="无操作后自动锁定" htmlFor={id} hint="音视频正在播放时保持解锁，暂停后重新计时。">
    <select id={id} className="input" value={value} onChange={event => onChange(Number(event.target.value))}>
      <option value={60}>1 分钟</option><option value={300}>5 分钟</option><option value={900}>15 分钟</option><option value={1800}>30 分钟</option>
    </select>
  </Field>;
}

export function PrivateUnlockForm({ onUnlocked }: { onUnlocked: (grant: api.PrivateGrant) => void }) {
  const id = useId(), mounted = useRef(true);
  const [status, setStatus] = useState<{ configured: boolean; idle_seconds: number } | null>(null);
  const [password, setPassword] = useState(""), [confirmation, setConfirmation] = useState("");
  const [idle, setIdle] = useState(300), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    void api.privateStatus().then(value => { if (active) { setStatus(value); setIdle(value.idle_seconds); setError(""); } })
      .catch(reason => { if (active) setError(api.errorMessage(reason, "无法读取私密空间设置")); });
    return () => { active = false; };
  }, [revision]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!status || busy) return;
    if (password.length < 8) { setError("访问密码至少需要 8 个字符"); return; }
    if (!status.configured && password !== confirmation) { setError("两次输入的访问密码不一致"); return; }
    setBusy(true); setError("");
    try {
      const grant = status.configured ? await api.unlockPrivate(password) : await api.setupPrivate(password, idle);
      if (!mounted.current) { void api.lockPrivate(grant.access).catch(() => undefined); return; }
      setPassword(""); setConfirmation(""); api.setPrivateAccess(grant.access); onUnlocked(grant);
    } catch (reason) { if (mounted.current) setError(api.errorMessage(reason, "解锁失败，请重试")); }
    finally { if (mounted.current) setBusy(false); }
  }
  if (!status) return <div className="private-loading" role="status">{error ? <><p role="alert">{error}</p><Button onClick={() => setRevision(v => v + 1)}>重试</Button></> : <><span className="spinner" />正在读取私密空间设置</>}</div>;
  return <form className="form private-unlock-form" onSubmit={submit} noValidate>
    <p className="muted">{status.configured ? "输入独立访问密码，解锁文件和文件夹。" : "设置独立访问密码。文件仍使用现有加密存储，并计入账号容量。"}</p>
    <Field label={status.configured ? "访问密码" : "设置访问密码"} htmlFor={`${id}-password`} error={error}>
      <input id={`${id}-password`} className="input" type="password" value={password} autoComplete={status.configured ? "current-password" : "new-password"} autoFocus disabled={busy} onChange={event => { setPassword(event.target.value); setError(""); }} />
    </Field>
    {!status.configured && <>
      <Field label="确认访问密码" htmlFor={`${id}-confirm`}><input id={`${id}-confirm`} className="input" type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></Field>
      <PrivateIdleSelect value={idle} onChange={setIdle} />
    </>}
    <Button type="submit" variant="primary" icon="lock" loading={busy} disabled={!password}>{status.configured ? "解锁私密空间" : "创建并进入私密空间"}</Button>
  </form>;
}

export function PrivateTransferDialog({ paths, into, onClose, onDone }: { paths: string[]; into: boolean; onClose: () => void; onDone: () => void }) {
  const [grant, setGrant] = useState<api.PrivateGrant | null>(() => into ? null : { access: api.getPrivateAccess(), idle_seconds: 300 });
  const [destination, setDestination] = useState(into ? api.PRIVATE_PREFIX : "");
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [conflict, setConflict] = useState<api.MoveConflict>("rename");
  usePrivateSession(into ? grant : null, onClose, ".private-transfer");
  async function move() {
    if (!grant || !ready || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api.transferPrivate(paths, destination, into, conflict);
      if (!result.moved && result.skipped) { setError("目标位置已有同名项目，未移动任何内容"); return; }
      toast.success(`${into ? "已移入私密空间" : "已移出到我的文件"}${result.skipped ? `，${result.skipped} 个同名文件已跳过` : ""}`);
      onDone(); onClose();
    } catch (reason) { setError(api.errorMessage(reason, "移动失败，请重试")); }
    finally { setBusy(false); }
  }
  return <Modal className="private-transfer" title={into ? "移入私密空间" : "移出到我的文件"} icon="lock" onClose={onClose} dismissible={!busy}
    description={into ? "移入后取消这些项目的公开分享，文件夹中的内容一起移动。" : "移出后可以从我的文件访问，公开分享仍保持关闭。"}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button>{grant && <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void move()}>移动 {paths.length} 个项目</Button>}</>}>
    {grant ? <>
      <FolderPicker value={destination} onChange={path => { setReady(false); setDestination(path); }} onReady={setReady} />
      <div className="move-conflict"><span>遇到同名文件时</span><Segmented label="同名冲突处理" value={conflict} onChange={setConflict} options={[{ value: "rename", label: "保留两者" }, { value: "skip", label: "跳过" }, { value: "overwrite", label: "覆盖" }]} /></div>
      {conflict === "overwrite" && <p className="inline-note tone-warning"><Icon name="alert" size={15} />目标位置的同名文件会被替换且无法恢复。</p>}
      {error && <p className="form-alert" role="alert">{error}</p>}
    </> : <PrivateUnlockForm onUnlocked={setGrant} />}
  </Modal>;
}
