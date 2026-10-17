import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import * as api from "../api";
import * as ai from "../assistant-api";
import { BRAND } from "../brand";
import { Notice, Avatar, Badge, Button, EmptyState, Field, Icon, Modal, PageHeader, PasswordField, Tabs, formatBytes, formatDate, toast, useDocumentTitle } from "../ui";
import { KeysView } from "./keys";
import { LocalCacheSettings } from "./local-cache";
import { PasskeysSettings } from "./passkeys";
import { PrivateIdleSelect } from "./private-access";
import { usePrivateAccess } from "./private-session";

export type SettingsTab = "account" | "keys" | "cache";
const SETTINGS_TABS: { value: SettingsTab; label: string; icon: "user" | "key" | "monitor" }[] = [{ value: "account", label: "账号", icon: "user" },
  { value: "keys", label: "访问密钥", icon: "key" }, { value: "cache", label: "本机缓存", icon: "monitor" }];

/** 用户设置：从头像菜单进入，分「账号」「访问密钥」「本机缓存」三个标签页（地址 ?view=account&tab=keys|cache，旧地址 ?view=keys 仍可用）。 */
export function UserSettingsPage({ session, onSessionChange, assistant = false, onOpenConversation, tab = "account", onTabChange, bucketName = null, keysAvailable = true }: {
  session: api.Session; onSessionChange: (patch: Partial<api.Session>) => void;
  /** 文件助手可用时显示「助手附件」统计（没有附件且助手不可用时隐藏） */
  assistant?: boolean; onOpenConversation?: (id: string) => void;
  tab?: SettingsTab; onTabChange?: (tab: SettingsTab) => void; bucketName?: string | null;
  /** 系统锁定或服务尚未解锁时不能管理访问密钥 */
  keysAvailable?: boolean }) {
  useDocumentTitle(`${tab === "keys" ? "访问密钥" : tab === "cache" ? "本机缓存" : "用户设置"} · ${BRAND}`);
  return <div className="account-page">
    <PageHeader title="用户设置" description={tab === "keys" ? "让同步工具（如 rclone、AWS CLI）或你自己的脚本访问你的文件。密钥只能访问你自己的文件，随时可以停用。"
      : tab === "cache" ? "看过的图片、音乐、视频片段和缩略图加密保存在这台设备的浏览器里，再次打开时不必重新下载。"
      : "管理你的个人资料和登录方式，登录方式也用于解锁私密空间。"} />
    {onTabChange && <Tabs label="用户设置" value={tab} onChange={onTabChange} options={SETTINGS_TABS} />}
    {tab === "cache" ? <LocalCacheSettings />
      : tab === "keys" ? keysAvailable ? <KeysView bucketName={bucketName} embedded />
      : <EmptyState icon="lock" title="暂时无法管理访问密钥" description="服务正在等待管理员完成启动，稍后再来查看和创建访问密钥。" />
      : <AccountSettings session={session} onSessionChange={onSessionChange} assistant={assistant} onOpenConversation={onOpenConversation} />}
  </div>;
}

function AccountSettings({ session, onSessionChange, assistant, onOpenConversation }: { session: api.Session; onSessionChange: (patch: Partial<api.Session>) => void;
  assistant: boolean; onOpenConversation?: (id: string) => void }) {
  const [editing, setEditing] = useState<"password" | "passkeys" | "private" | "nickname" | "email" | null>(null);
  const [busy, setBusy] = useState(false);
  return <>
    <ProfileCard session={session} busy={busy} onBusyChange={setBusy} onSessionChange={onSessionChange} onEditNickname={() => setEditing("nickname")} />
    {editing === "nickname" && <NicknameDialog session={session} onClose={() => setEditing(null)} onSaved={profile => { onSessionChange(profile); setEditing(null); }} />}
    {/* 登录邮箱与登录密码合成一个「登录方式」分组。 */}
    <PasswordSettings username={session.username} editing={editing === "password"} busy={busy} onBusyChange={setBusy}
      onOpen={() => setEditing("password")} onClose={() => setEditing(null)}
      email={<EmailSettings session={session} busy={busy} onOpen={() => setEditing("email")} />} />
    {editing === "email" && <EmailDialog session={session} onClose={() => setEditing(null)} onSaved={profile => { onSessionChange(profile); setEditing(null); }} />}
    <PasskeysSettings username={session.username} active={editing === "passkeys"} busy={busy} onBusyChange={setBusy}
      onOpen={() => setEditing("passkeys")} onClose={() => setEditing(null)} />
    <PrivateSettingsSummary editing={editing === "private"} busy={busy} onBusyChange={setBusy}
      onOpen={() => setEditing("private")} onClose={() => setEditing(null)} />
    <AssistantAttachmentsSummary assistant={assistant} onOpenConversation={onOpenConversation} />
    <p className="account-page-help"><Icon name="info" size={16} /><span>忘记登录密码？请联系管理员重置。<a className="link" href="/docs/files#private-space" target="_blank" rel="noreferrer">了解登录与私密解锁</a></span></p>
  </>;
}

/** 助手附件：随对话保存、计入已用空间，不提供单独删除（docs/assistant-design.md §22.5）。 */
function AssistantAttachmentsSummary({ assistant, onOpenConversation }: { assistant: boolean; onOpenConversation?: (id: string) => void }) {
  const id = useId();
  const [stats, setStats] = useState<ai.AttachmentStats | null>(null);
  const [error, setError] = useState("");
  const [clearing, setClearing] = useState(false);
  async function clearPending() {
    setClearing(true);
    try {
      const result = await ai.discardPendingAttachments();
      toast.success(`已清除 ${result.removed} 个未发送的附件，释放 ${formatBytes(result.size)}`);
      setStats(await ai.attachmentStats());
    } catch (reason) { toast.error(api.errorMessage(reason, "清除失败，请稍后重试")); }
    finally { setClearing(false); }
  }
  useEffect(() => {
    let alive = true;
    ai.attachmentStats().then(value => { if (alive) setStats(value); }).catch(reason => { if (alive) setError(api.errorMessage(reason, "附件统计加载失败，请稍后重试")); });
    return () => { alive = false; };
  }, []);
  if (!assistant && !stats?.count) return null;
  return <section className="account-section" aria-labelledby={`${id}-title`}>
    <header className="account-section-heading"><Icon name="paperclip" size={20} /><div><h2 id={`${id}-title`}>助手附件</h2><p>随消息上传给文件助手的文件，计入已用空间。</p></div></header>
    <div className="account-section-content">
      <div className="account-setting-summary"><div>
        <strong>{stats ? `${stats.count.toLocaleString("zh-CN")} 个附件，共 ${formatBytes(stats.size)}` : error ? "统计暂不可用" : "正在统计…"}</strong>
        <p>附件属于对话，不出现在我的文件。删除对话会同时删除它的附件；想长期保留时，在消息里的附件菜单选择「保存到我的文件」。</p>
      </div></div>
      {error && <Notice tone="danger">{error}</Notice>}
      {stats && stats.conversations.length > 0 && <ul className="account-attachments" aria-label="各对话的附件">
        {stats.conversations.map(item => <li key={item.conversation_id}>
          <Icon name="chat" size={15} />
          <span className="account-attachments-title"><strong title={item.title ?? "未命名对话"}>{item.title || "未命名对话"}</strong>
            <small>{item.count} 个 · {formatBytes(item.size)} · {formatDate(item.latest)}{item.archived ? " · 已归档" : ""}</small></span>
          {onOpenConversation && <Button size="sm" variant="ghost" onClick={() => onOpenConversation(item.conversation_id)}>打开对话</Button>}
        </li>)}
      </ul>}
      {stats && stats.pending.count > 0 && <div className="account-attachments-note"><Icon name="info" size={13} />
        <span>另有 {stats.pending.count} 个尚未发送的附件（{formatBytes(stats.pending.size)}），2 小时内未发送会自动删除。</span>
        <Button size="sm" variant="ghost" loading={clearing} onClick={() => void clearPending()}>立即清除</Button></div>}
    </div>
  </section>;
}

function PrivateSettingsSummary({ editing, busy, onOpen, onClose, onBusyChange }: {
  editing: boolean; busy: boolean; onOpen: () => void; onClose: () => void; onBusyChange: (value: boolean) => void;
}) {
  const access = usePrivateAccess(), id = useId();
  return <section className="account-section" aria-labelledby={`${id}-title`}>
    <header className="account-section-heading"><Icon name="shield" size={20} /><div><h2 id={`${id}-title`}>私密空间</h2><p>闲置时自动保护私密文件。</p></div></header>
    <div className="account-section-content account-passkeys">
      <div className="account-setting-summary"><div><strong>无操作 {access.idleSeconds / 60} 分钟后锁定</strong><p>私密操作会重新计时，播放时保持解锁。切换页面或刷新后可直接返回。</p></div>
        {!access.available ? <Badge>系统未解锁</Badge> : access.restoring ? <Badge>检查中</Badge> : access.error ? <Badge tone="warning">状态待确认</Badge> : <Badge tone={access.grant ? "success" : "neutral"}>{access.grant ? "已解锁" : "未解锁"}</Badge>}
      </div>
      {access.error && <Notice tone="danger">{access.error}</Notice>}
      <div className="account-private-actions">{access.error && <Button size="sm" disabled={busy || access.restoring} onClick={access.restore}>重试</Button>}{access.grant && <Button icon="lock" size="sm" disabled={busy || access.restoring} onClick={access.lock}>立即锁定</Button>}
        <Button size="sm" icon="settings" aria-haspopup="dialog" disabled={busy || !access.available || access.restoring || !!access.error} onClick={onOpen}>修改锁定时间</Button>
      </div>
      {editing && <PrivateIdleDialog initialIdle={access.idleSeconds} busy={busy} onBusyChange={onBusyChange} onClose={onClose} />}
    </div>
  </section>;
}

function PrivateIdleDialog({ initialIdle, busy, onBusyChange, onClose }: {
  initialIdle: number; busy: boolean; onBusyChange: (value: boolean) => void; onClose: () => void;
}) {
  const id = useId(), mounted = useRef(true), submitting = useRef(false);
  const [idle, setIdle] = useState(initialIdle), [saving, setSaving] = useState(false), [error, setError] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || submitting.current || idle === initialIdle) return;
    submitting.current = true; setSaving(true); setError(""); onBusyChange(true);
    try {
      const saved = await api.configurePrivate(idle);
      toast.success(`私密空间将于闲置 ${saved.idle_seconds / 60} 分钟后自动锁定`);
      if (mounted.current) { onBusyChange(false); onClose(); }
    } catch (reason) { if (mounted.current) setError(api.errorMessage(reason, "锁定时间未保存，请重试")); }
    finally { submitting.current = false; if (mounted.current) { setSaving(false); onBusyChange(false); } }
  }
  return <Modal className="account-action-dialog" title="私密空间自动锁定" icon="lock" description="选择你自己的闲置锁定时间，默认 30 分钟。" onClose={onClose} dismissible={!busy}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" type="submit" form={id} loading={saving} disabled={idle === initialIdle || busy && !saving}>保存时间</Button></>}>
    <form id={id} className="form" onSubmit={submit} noValidate>
      <fieldset disabled={busy} className="settings-fieldset"><PrivateIdleSelect value={idle} onChange={value => { setIdle(value); setError(""); }} /></fieldset>
      <p className="account-editor-note">仅影响你的账号。保存后重新计时，其他登录设备需重新解锁；未解锁时只保存时间设置。</p>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  </Modal>;
}

function PasswordSettings({ username, editing, busy, onOpen, onClose, onBusyChange, email }: {
  username: string; editing: boolean; busy: boolean; onOpen: () => void; onClose: () => void; onBusyChange: (value: boolean) => void; email?: ReactNode;
}) {
  const id = useId();
  const [updated, setUpdated] = useState(false);
  return <section className="account-section" aria-labelledby={`${id}-title`}>
    <header className="account-section-heading"><Icon name="lock" size={20} /><div><h2 id={`${id}-title`}>登录方式</h2><p>用邮箱和密码登录；密码也用于解锁私密空间。</p></div></header>
    <div className="account-section-content">
      {email}
      <div className="account-setting-summary"><div><strong>{updated ? "密码已更新" : "登录密码已设置"}</strong><p>使用当前登录密码确认后，即可设置新密码。</p></div>
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
    {error && <Notice tone="danger">{error}</Notice>}
    </form>
  </Modal>;
}

const AVATAR_SIZE = 256, AVATAR_LIMIT = 256 * 1024;

/** 头像在浏览器中按中心裁成 256×256 正方形并压缩，服务端只校验格式和大小，不解码图片。 */
async function avatarData(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > 20 * 1024 * 1024) throw new Error("图片不能超过 20 MB");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error("无法读取这张图片，请换一张试试"); }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法处理图片");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close();
  for (const quality of [.9, .8, .65, .5]) {
    for (const type of ["image/webp", "image/jpeg"]) {
      const url = canvas.toDataURL(type, quality);
      // toDataURL 不支持的格式会退回 PNG，按实际前缀判断。
      if (!url.startsWith(`data:${type}`)) continue;
      if ((url.length - url.indexOf(",") - 1) * .75 <= AVATAR_LIMIT) return url;
    }
  }
  throw new Error("图片压缩后仍然过大，请换一张试试");
}

function ProfileCard({ session, busy, onBusyChange, onSessionChange, onEditNickname }: {
  session: api.Session; busy: boolean; onBusyChange: (value: boolean) => void; onSessionChange: (patch: Partial<api.Session>) => void; onEditNickname: () => void;
}) {
  const input = useRef<HTMLInputElement>(null), mounted = useRef(true);
  const [saving, setSaving] = useState<"upload" | "delete" | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const name = api.displayName(session);
  async function run(kind: "upload" | "delete", action: () => Promise<api.Profile>, message: string) {
    setSaving(kind); onBusyChange(true);
    try { onSessionChange(await action()); toast.success(message); }
    catch (reason) { toast.error(api.errorMessage(reason, kind === "upload" ? "头像未更新，请稍后重试" : "头像未移除，请稍后重试")); }
    finally { if (mounted.current) setSaving(null); onBusyChange(false); }
  }
  return <section className="account-profile" aria-label="个人资料">
    <button type="button" className="account-avatar-button" disabled={busy} onClick={() => input.current?.click()} aria-label="更换头像" title="更换头像">
      <Avatar name={name} tone={session.role === "admin" ? "admin" : "accent"} src={api.avatarUrl(session.avatar_version)} size={72} />
      <span className="account-avatar-overlay" aria-hidden="true"><Icon name="upload" size={18} /></span>
    </button>
    <input ref={input} type="file" accept="image/*" hidden onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (file) void run("upload", async () => api.uploadAvatar(await avatarData(file)), "头像已更新");
    }} />
    <div className="account-profile-copy">
      <div className="account-profile-name"><strong title={name}>{name}</strong>
        <Badge tone={session.role === "admin" ? "accent" : "neutral"}>{session.role === "admin" ? "管理员" : "普通用户"}</Badge></div>
      <span className="account-profile-email" title={session.username}>{session.username}</span>
      <div className="account-profile-actions">
        <Button size="sm" icon="upload" loading={saving === "upload"} disabled={busy} onClick={() => input.current?.click()}>{session.avatar_version ? "更换头像" : "上传头像"}</Button>
        {session.avatar_version ? <Button size="sm" variant="ghost" loading={saving === "delete"} disabled={busy} onClick={() => void run("delete", api.deleteAvatar, "头像已移除")}>移除头像</Button> : null}
        <Button size="sm" variant="ghost" icon="edit" disabled={busy} aria-haspopup="dialog" onClick={onEditNickname}>{session.nickname ? "修改昵称" : "设置昵称"}</Button>
      </div>
    </div>
  </section>;
}

function NicknameDialog({ session, onClose, onSaved }: { session: api.Session; onClose: () => void; onSaved: (profile: api.Profile) => void }) {
  const id = useId(), mounted = useRef(true);
  const [value, setValue] = useState(session.nickname ?? ""), [saving, setSaving] = useState(false), [error, setError] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fallback = session.username.includes("@") ? session.username.split("@", 1)[0] : session.username;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const nickname = value.trim();
    if (nickname.length > 32) { setError("昵称最多 32 个字符"); return; }
    setSaving(true); setError("");
    try { const profile = await api.updateProfile(nickname); toast.success(nickname ? "昵称已更新" : "已清除昵称"); if (mounted.current) onSaved(profile); }
    catch (reason) { if (mounted.current) setError(api.errorMessage(reason, "昵称未保存，请稍后重试")); }
    finally { if (mounted.current) setSaving(false); }
  }
  return <Modal className="account-action-dialog" title="昵称" icon="user" description="昵称显示在侧栏和管理员的用户列表中，不用于登录。" onClose={onClose} dismissible={!saving}
    footer={<><Button disabled={saving} onClick={onClose}>取消</Button><Button variant="primary" type="submit" form={id} loading={saving}>保存</Button></>}>
    <form id={id} className="form" onSubmit={submit} noValidate>
      <Field label="昵称" htmlFor={`${id}-nickname`} error={error} hint={`留空则显示为「${fallback}」，最多 32 个字符。`}>
        <input id={`${id}-nickname`} className="input" value={value} maxLength={32} autoComplete="nickname" autoFocus disabled={saving}
          onChange={event => { setValue(event.target.value); setError(""); }} />
      </Field>
    </form>
  </Modal>;
}

/** 「登录方式」分组里的邮箱一行。 */
function EmailSettings({ session, busy, onOpen }: { session: api.Session; busy: boolean; onOpen: () => void }) {
  return <div className="account-setting-summary"><div><strong>{session.needs_email ? "尚未设置登录邮箱" : session.username}</strong>
        <p>{session.needs_email ? `当前仍使用旧用户名「${session.username}」登录，请改为邮箱。` : "修改后请使用新邮箱登录，通行密钥不受影响。"}</p></div>
        <Button variant={session.needs_email ? "primary" : "secondary"} disabled={busy} aria-haspopup="dialog" onClick={onOpen}>{session.needs_email ? "设置邮箱" : "修改邮箱"}</Button>
      </div>;
}

/**
 * 修改或首次设置登录邮箱，需要确认登录密码。required 为 true 时用于旧用户名账号的强制设置：
 * 不能关闭，只能完成设置或退出登录。
 */
export function EmailDialog({ session, required = false, onClose, onSaved, onLogout }: {
  session: api.Session; required?: boolean; onClose?: () => void; onSaved: (profile: api.Profile & { username: string }) => void; onLogout?: () => void;
}) {
  const id = useId(), mounted = useRef(true);
  const [email, setEmail] = useState(session.needs_email ? "" : session.username), [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({}), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const value = email.trim().toLowerCase(), next: Record<string, string> = {};
    if (!api.isEmail(value)) next.email = "请输入有效的邮箱地址";
    else if (value === session.username) next.email = "新邮箱与当前登录邮箱相同";
    if (!password) next.password = "请输入当前登录密码";
    setErrors(next); setError("");
    if (Object.keys(next).length) { event.currentTarget.querySelector<HTMLInputElement>(`[name="${Object.keys(next)[0]}"]`)?.focus(); return; }
    setSaving(true);
    try {
      const profile = await api.changeEmail(value, password);
      try { localStorage.setItem("tessera:last-username", profile.username); } catch { /* 隐私模式下无法保存 */ }
      toast.success(required ? "登录邮箱已设置，以后请使用邮箱登录" : "登录邮箱已修改");
      if (mounted.current) onSaved(profile);
    } catch (reason) { if (mounted.current) setError(api.errorMessage(reason, "邮箱未保存，请稍后重试")); }
    finally { if (mounted.current) setSaving(false); }
  }
  return <Modal className="account-action-dialog" title={required ? "设置登录邮箱" : "修改登录邮箱"} icon="mail" onClose={() => onClose?.()} dismissible={!required && !saving} closable={!required}
    description={required ? `${BRAND} 现在使用邮箱登录。请为账号「${session.username}」设置一个邮箱，以后用它代替用户名登录。` : "邮箱用于登录，必须是其他账号没有使用过的地址。"}
    footer={<>{required ? <Button disabled={saving} onClick={onLogout}>退出登录</Button> : <Button disabled={saving} onClick={onClose}>取消</Button>}
      <Button variant="primary" type="submit" form={id} loading={saving}>{required ? "设置邮箱" : "保存"}</Button></>}>
    <form id={id} className="form" onSubmit={submit} noValidate aria-label="登录邮箱">
      <Field label="邮箱" htmlFor={`${id}-email`} error={errors.email}>
        <input id={`${id}-email`} name="email" className="input" type="text" inputMode="email" placeholder="name@example.com" autoComplete="email"
          autoCapitalize="none" spellCheck={false} autoFocus value={email} disabled={saving}
          onChange={event => { setEmail(event.target.value); setErrors(previous => ({ ...previous, email: "" })); setError(""); }} />
      </Field>
      <PasswordField label="当前登录密码" name="password" value={password} error={errors.password} disabled={saving}
        onChange={value => { setPassword(value); setErrors(previous => ({ ...previous, password: "" })); setError(""); }} />
      <p className="account-editor-note">目前只检查邮箱格式，不会发送验证邮件。当前登录保持有效，其他设备下次登录时使用新邮箱。</p>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  </Modal>;
}
