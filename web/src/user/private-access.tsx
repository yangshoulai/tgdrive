import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import * as api from "../api";
import { passkeyUnavailable, unlockWithPrivatePasskey } from "../passkeys";
import { Notice, Button, Field, Icon, Modal, Segmented, toast } from "../ui";
import { FolderPicker } from "./folders";
import { usePrivateAccess, usePrivateSession } from "./private-session";

/** 与服务端 PrivateSpace.IDLE_OPTIONS 一致。 */
const PRIVATE_IDLE_MINUTES = [5, 15, 30, 60, 90, 120];

export function PrivateIdleSelect({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const id = useId();
  return <Field label="无操作后自动锁定" htmlFor={id} hint="私密操作会重新计时；播放音视频时保持解锁，切换页面不会立即锁定。">
    <select id={id} className="input" value={value} onChange={event => onChange(Number(event.target.value))}>
      {PRIVATE_IDLE_MINUTES.map(minutes => <option key={minutes} value={minutes * 60}>{minutes} 分钟</option>)}
    </select>
  </Field>;
}

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

export function PrivateTransferDialog({ paths, into, onClose, onDone }: { paths: string[]; into: boolean; onClose: () => void; onDone: () => void }) {
  const access = usePrivateAccess(), grant = access.grant;
  const [destination, setDestination] = useState(into ? api.PRIVATE_PREFIX : "");
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [conflict, setConflict] = useState<api.MoveConflict>("rename");
  usePrivateSession(grant, onClose, ".private-transfer");
  async function move() {
    if (!grant || !ready || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api.transferPrivate(paths, destination, into, conflict);
      if (!result.moved && result.skipped) { setError("目标位置已有同名项目，未移动任何内容"); return; }
      toast.success(`${into ? "已移入私密空间" : "已移出到我的文件"}${result.skipped ? `，${result.skipped} 个同名文件已跳过` : ""}`);
      onDone(); onClose();
    } catch (reason) { setError(api.errorMessage(reason, "移动失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  return <Modal className="private-transfer" title={into ? "移入私密空间" : "移出到我的文件"} icon="lock" onClose={onClose} dismissible={!busy}
    description={into ? "移入后取消这些项目的公开分享，文件夹中的内容一起移动。" : "移出后可以从我的文件访问，公开分享仍保持关闭。"}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button>{grant && <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void move()}>移动 {paths.length} 个项目</Button>}</>}>
    {access.restoring ? <div className="private-loading" role="status"><span className="spinner" />正在检查私密空间</div> : grant ? <>
      <FolderPicker value={destination} onChange={path => { setReady(false); setDestination(path); }} onReady={setReady} />
      <div className="move-conflict"><span>遇到同名文件时</span><Segmented label="同名冲突处理" value={conflict} onChange={setConflict} options={[{ value: "rename", label: "保留两者" }, { value: "skip", label: "跳过" }, { value: "overwrite", label: "覆盖" }]} /></div>
      {conflict === "overwrite" && <Notice tone="warning">目标位置的同名文件会被替换且无法恢复。</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </> : access.error ? <div className="form"><Notice tone="danger">{access.error}</Notice><Button onClick={access.restore}>重试</Button></div> : <PrivateUnlockForm />}
  </Modal>;
}
