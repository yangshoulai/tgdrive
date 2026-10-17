import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import * as api from "../api";
import { passkeyUnavailable, registerPasskey, type PasskeyRegistrationStage } from "../passkeys";
import { Notice, Badge, Button, ConfirmDialog, EmptyState, Field, Icon, Menu, Modal, PasswordField, formatDate, toast } from "../ui";

type Editor = { kind: "add" } | { kind: "rename" | "enable"; passkey: api.AccountPasskey };
type Action = Editor["kind"] | "delete";

function deviceName() {
  const agent = navigator.userAgent;
  if (/iPad/i.test(agent) || /Macintosh/i.test(agent) && navigator.maxTouchPoints > 1 || /Android/i.test(agent) && !/Mobile/i.test(agent)) return "我的平板";
  return /iPhone|Android/i.test(agent) ? "我的手机" : "我的电脑";
}

export function PasskeysSettings({ username, active, busy, onBusyChange, onOpen, onClose }: {
  username: string; active: boolean; busy: boolean; onBusyChange: (busy: boolean) => void; onOpen: () => void; onClose: () => void;
}) {
  const id = useId(), mounted = useRef(true), controller = useRef<AbortController | null>(null), running = useRef(false);
  const section = useRef<HTMLElement>(null), form = useRef<HTMLFormElement>(null), deleteField = useRef<HTMLDivElement>(null), loadRevision = useRef(0);
  const [data, setData] = useState<api.AccountPasskeys | null>(null), [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Editor | null>(null), [deleting, setDeleting] = useState<api.AccountPasskey | null>(null);
  const [name, setName] = useState(""), [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({}), [error, setError] = useState("");
  const [success, setSuccess] = useState(""), [added, setAdded] = useState<number | null>(null);
  const [action, setAction] = useState<Action | null>(null), [stage, setStage] = useState<"checking" | PasskeyRegistrationStage | null>(null);
  useEffect(() => {
    mounted.current = true;
    const load = new AbortController(); void refresh(load.signal);
    return () => { mounted.current = false; load.abort(); controller.current?.abort(); };
  }, []);
  useEffect(() => { if (!active) resetEditor(); }, [active]);
  async function refresh(signal?: AbortSignal) {
    const revision = ++loadRevision.current;
    if (mounted.current) setLoading(true);
    try {
      const value = await api.accountPasskeys(signal);
      if (mounted.current && revision === loadRevision.current && !signal?.aborted) { setData(value); setLoadError(""); }
    } catch (reason) {
      if (mounted.current && revision === loadRevision.current && !signal?.aborted) setLoadError(api.errorMessage(reason, "暂时无法更新通行密钥列表，请重试"));
    } finally {
      if (mounted.current && revision === loadRevision.current) setLoading(false);
    }
  }
  function resetEditor() { setEditor(null); setDeleting(null); setPassword(""); setName(""); setErrors({}); setError(""); }
  function open(next: Editor | { kind: "delete"; passkey: api.AccountPasskey }) {
    if (busy || running.current) return;
    resetEditor(); setSuccess(""); onOpen();
    if (next.kind === "delete") setDeleting(next.passkey);
    else { setEditor(next); setName(next.kind === "add" ? deviceName() : next.passkey.name); }
  }
  function close(focusId?: number) {
    resetEditor(); onClose();
    window.requestAnimationFrame(() => section.current?.querySelector<HTMLButtonElement>(focusId ? `[data-passkey-id="${focusId}"] button` : "[data-passkey-add]")?.focus());
  }
  function changePassword(value: string) { setPassword(value); setErrors(previous => ({ ...previous, password: "" })); setError(""); }
  function validate(withName: boolean) {
    const next: Record<string, string> = {};
    if (withName && !name.trim()) next.name = "为通行密钥起个容易辨认的名称";
    if (!password) next.password = "请输入当前登录密码确认身份";
    setErrors(next); setError("");
    if (!Object.keys(next).length) return true;
    if (deleting) deleteField.current?.querySelector("input")?.focus();
    else form.current?.querySelector<HTMLInputElement>(`[name="${Object.keys(next)[0]}"]`)?.focus();
    return false;
  }
  function begin(next: Action) {
    const operation = new AbortController(); controller.current = operation; running.current = true;
    setAction(next); setError(""); onBusyChange(true); if (next === "add") setStage("checking");
    return operation;
  }
  function finish() {
    running.current = false; controller.current = null;
    if (mounted.current) { setAction(null); setStage(null); onBusyChange(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || running.current || !editor || !validate(editor.kind !== "enable")) return;
    const current = editor, label = name.trim(), operation = begin(current.kind);
    try {
      let message: string;
      if (current.kind === "add") {
        const result = await registerPasskey(password, label, operation.signal, value => { if (mounted.current) setStage(value); });
        if (!mounted.current) return;
        setAdded(result.id); message = `已添加“${label}”，可用于登录和私密空间解锁。`;
      } else if (current.kind === "rename") {
        await api.renamePasskey(current.passkey.id, password, label, operation.signal);
        if (!mounted.current) return;
        setData(previous => previous && ({ ...previous, passkeys: previous.passkeys.map(item => item.id === current.passkey.id ? { ...item, name: label } : item) }));
        message = "通行密钥名称已更新。";
      } else {
        await api.enablePasskeyLogin(current.passkey.id, password, operation.signal);
        if (!mounted.current) return;
        setData(previous => previous && ({ ...previous, passkeys: previous.passkeys.map(item => item.id === current.passkey.id ? { ...item, login_enabled: true } : item) }));
        message = `“${current.passkey.name}”已可用于登录和私密空间解锁。`;
      }
      setSuccess(message); toast.success(message); close(current.kind === "add" ? undefined : current.passkey.id);
      void refresh();
    } catch (reason) {
      if (mounted.current) {
        if (operation.signal.aborted) { close(); toast.info("设备验证已取消"); }
        else setError(api.errorMessage(reason, "操作未完成，请重试"));
      }
    } finally { finish(); }
  }
  async function remove() {
    if (busy || running.current || !deleting || !validate(false)) return;
    const current = deleting, operation = begin("delete");
    try {
      await api.deletePasskey(current.id, password, operation.signal);
      if (!mounted.current) return;
      setData(previous => previous && ({ ...previous, passkeys: previous.passkeys.filter(item => item.id !== current.id) }));
      setSuccess(`已移除“${current.name}”。你仍可使用登录密码或其他通行密钥。`);
      toast.success("通行密钥已移除"); close(); void refresh();
    } catch (reason) { if (mounted.current) setError(api.errorMessage(reason, "未能移除通行密钥，请重试")); }
    finally { finish(); }
  }
  const unavailable = data ? passkeyUnavailable(data.capability) : null;
  const limited = Boolean(data && data.passkeys.length >= 10);
  const stageIndex = stage === "checking" ? 0 : stage === "device" ? 1 : 2;
  return <section className="account-section" aria-labelledby={`${id}-title`} ref={section}>
    <header className="account-section-heading"><Icon name="key" size={20} /><div><h2 id={`${id}-title`}>通行密钥</h2><p>用指纹、面容或设备 PIN 快捷验证。</p></div></header>
    <div className="account-section-content account-passkeys">
      <div className="account-setting-summary"><div><strong>{data ? data.passkeys.length ? `已添加 ${data.passkeys.length} 个通行密钥` : "更轻松的登录方式" : "你的通行密钥"}</strong><p>一次添加，同时用于登录和私密解锁。</p></div>
        {data && !unavailable && !limited && <Button icon="plus" data-passkey-add disabled={busy} aria-haspopup="dialog" onClick={() => open({ kind: "add" })}>添加通行密钥</Button>}
      </div>
      {success && <p className="account-feedback" role="status"><Icon name="checkCircle" size={17} />{success}</p>}
      {loadError && <div className="account-callout tone-danger" role="alert"><Icon name="alert" size={17} /><div><p>{loadError}</p><Button size="sm" disabled={busy} loading={loading} onClick={() => void refresh()}>重新读取</Button></div></div>}
      {!data && !loadError && <div className="account-passkey-loading" role="status"><span className="spinner" />正在读取通行密钥</div>}
      {data && <>
        {unavailable && <div className="account-callout"><Icon name="info" size={17} /><div><p>{unavailable}</p>
          {data.capability.available && data.capability.origin && data.capability.origin !== window.location.origin && <a className="link" href={`${data.capability.origin}/?view=account`}>前往站点地址</a>}</div></div>}
        {data.passkeys.length ? <ul className="account-passkey-list">
          {data.passkeys.map(item => <li key={item.id} data-passkey-id={item.id}>
            <span className="account-passkey-mark"><Icon name="key" size={20} /></span>
            <div className="account-passkey-copy"><div className="account-passkey-name"><strong title={item.name}>{item.name}</strong>{added === item.id && <Badge tone="success">刚刚添加</Badge>}</div>
              <div className="account-passkey-meta"><span>{item.last_used_at ? `上次使用 ${formatDate(item.last_used_at)}` : `添加于 ${formatDate(item.created_at)}`}</span><span className="account-passkey-domain" title={item.rp_id}>{item.rp_id}</span></div>
              <span className={item.login_enabled ? "" : "tone-warning"}>{item.login_enabled ? "登录与私密解锁" : "仅私密解锁，尚未启用登录"}</span>
              </div>
            <span className="account-passkey-menu-slot">{!busy && <Menu label={`管理通行密钥 ${item.name}`} items={[
              ...(!item.login_enabled ? [{ label: "启用登录", icon: "key" as const, onSelect: () => open({ kind: "enable", passkey: item }) }] : []),
              { label: "重命名", icon: "edit", onSelect: () => open({ kind: "rename", passkey: item }) },
              { label: "移除", icon: "trash", danger: true, onSelect: () => open({ kind: "delete", passkey: item }) },
            ]} />}</span>
          </li>)}
        </ul> : <EmptyState compact icon="key" title="还没有通行密钥" description="添加后，下次登录可以直接在设备上确认。登录密码始终可以使用。" />}
        {limited && <p className="account-editor-note">每个账号最多添加 10 个通行密钥。移除不再使用的凭据后，即可添加新的。</p>}
        <p className="account-editor-note">凭据可能由系统同步到你的其他设备。Tessera 不会接收指纹、面容数据或通行密钥私钥。</p>
      </>}
    </div>
    {editor && <Modal key={editor.kind === "add" ? "add" : `${editor.kind}-${editor.passkey.id}`} className="account-action-dialog"
      title={editor.kind === "add" ? "添加通行密钥" : editor.kind === "rename" ? "重命名通行密钥" : "启用通行密钥登录"} icon="key"
      description={editor.kind === "add" ? "为设备起个名称，确认密码后，按设备提示完成添加。" : editor.kind === "rename" ? "使用容易辨认的名称，方便区分你的设备。" : `确认后，“${editor.passkey.name}”可同时用于登录和私密解锁，无需重新添加。`}
      dismissible={!busy || action === "add" && stage !== "saving"}
      onClose={() => busy ? controller.current?.abort() : close(editor.kind === "add" ? undefined : editor.passkey.id)}
      footer={<><Button disabled={busy && (action !== "add" || stage === "saving")} onClick={() => busy ? controller.current?.abort() : close(editor.kind === "add" ? undefined : editor.passkey.id)}>{busy && action === "add" ? "取消验证" : "取消"}</Button>
        <Button variant="primary" type="submit" form={`${id}-editor`} loading={action === editor.kind} disabled={busy && action !== editor.kind}>{editor.kind === "add" ? "验证并添加" : editor.kind === "rename" ? "保存名称" : "启用登录"}</Button></>}>
      <form id={`${id}-editor`} ref={form} className="form" onSubmit={submit} noValidate aria-label={editor.kind === "add" ? "添加通行密钥" : editor.kind === "rename" ? "重命名通行密钥" : "启用通行密钥登录"}>
          <input className="sr-only" name="username" autoComplete="username" value={username} readOnly tabIndex={-1} aria-hidden="true" />
          {editor.kind !== "enable" && <Field label="通行密钥名称" htmlFor={`${id}-name`} error={errors.name} hint="例如：我的手机、家里的电脑">
            <input className="input" id={`${id}-name`} name="name" value={name} autoComplete="off" maxLength={80} autoFocus disabled={busy} onChange={event => { setName(event.target.value); setErrors(previous => ({ ...previous, name: "" })); setError(""); }} /></Field>}
          <PasswordField label="当前登录密码" name="password" value={password} onChange={changePassword} error={errors.password} hint="用于确认身份，仅在本次操作中使用。" disabled={busy} autoFocus={editor.kind === "enable"} />
          {action === "add" && <div className="account-passkey-progress"><ol aria-label="添加通行密钥进展">{["确认密码", "设备验证", "保存"].map((label, index) => <li key={label} className={index < stageIndex ? "is-complete" : index === stageIndex ? "is-current" : ""} aria-current={index === stageIndex ? "step" : undefined}>{index < stageIndex ? <Icon name="checkCircle" size={15} /> : index === stageIndex ? <span className="spinner" /> : <i aria-hidden="true" />}{label}</li>)}</ol>
            <p role="status">{stage === "checking" ? "正在确认登录密码…" : stage === "device" ? "请在设备提示中完成指纹、面容或 PIN 验证。" : "正在保存通行密钥，请稍候…"}</p></div>}
          {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Modal>}
    {deleting && <ConfirmDialog title="移除通行密钥" confirmLabel="移除通行密钥" onClose={() => close(deleting.id)} onConfirm={remove}
      description={`移除“${deleting.name}”后，此凭据将无法登录或解锁私密空间。`}>
      <input className="sr-only" name="username" autoComplete="username" value={username} readOnly tabIndex={-1} aria-hidden="true" />
      <div ref={deleteField}><PasswordField label="当前登录密码" value={password} onChange={changePassword} error={errors.password} disabled={busy} autoFocus /></div>
      <p className="account-editor-note">当前账号保持登录；其他设备需要重新登录，所有私密窗口会锁定。你仍可使用登录密码。</p>
      {error && <Notice tone="danger">{error}</Notice>}
    </ConfirmDialog>}
  </section>;
}
