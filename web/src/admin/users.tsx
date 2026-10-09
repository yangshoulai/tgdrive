import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useCursorPage } from "../pagination";
import { SITE } from "../brand";
import * as api from "../api";

import { Avatar, Badge, Button, ConfirmDialog, CopyField, EmptyState, Field, Icon, Menu, Modal, PageHeader, Pagination, Progress, SearchInput, Segmented, SkeletonRows, formatBytes, formatDate, formatDateTime, toast, usageTone, useDocumentTitle } from "../ui";

/* ---------- 用户 ---------- */

const GB = 1024 ** 3;

export function Users() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "disabled">("all");
  const [creating, setCreating] = useState(false);
  const [quotaTarget, setQuotaTarget] = useState<api.Account | null>(null);
  const [resetTarget, setResetTarget] = useState<api.Account | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<api.Account | null>(null);
  const [disabling, setDisabling] = useState<api.Account | null>(null);
  useDocumentTitle(`用户 · ${SITE.admin}`);
  const [search, setSearch] = useState("");
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search.trim()), 300); return () => window.clearTimeout(timer); }, [search]);
  const fetchPage = useCallback((cursor: string | null) => api.adminUsersPage(cursor, query, status === "all" ? "" : status), [query, status]);
  const pagination = useCursorPage(fetchPage);
  const users = pagination.page?.users ?? null;
  const shown = users ?? [];
  const load = pagination.reload;
  async function setUserStatus(user: api.Account, next: "active" | "disabled") {
    try { await api.setAdminUserStatus(user.id, next); toast.success(next === "active" ? `已启用 ${user.username}` : `已禁用 ${user.username}`); load(); }
    catch (reason) { toast.error(api.errorMessage(reason, "状态更新失败，请稍后重试")); }
  }
  return (
    <>
      <PageHeader title="用户" description="每个用户拥有独立的存储桶。配额在每次上传提交时强制校验。"
        actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>新建用户</Button>} />
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="按用户名筛选" label="筛选用户" />
        <Segmented label="状态" value={status} onChange={setStatus} options={[{ value: "all", label: "全部" }, { value: "active", label: "启用" }, { value: "disabled", label: "已禁用" }]} />
      </div>
      <section className="file-surface">
        {pagination.error ? <EmptyState icon="alert" title="用户加载失败" description={pagination.error} action={<Button onClick={() => void load()}>重试</Button>} /> : users === null ? <SkeletonRows rows={4} /> : shown.length === 0 ? <EmptyState icon="users" title={query || status !== "all" ? "没有匹配的用户" : "还没有用户"} action={!query && status === "all" ? <Button icon="plus" onClick={() => setCreating(true)}>新建用户</Button> : undefined} /> : (
          <div className="data-table users-table" role="table" aria-label="用户">
            <div className="data-row data-head" role="row">
              <span role="columnheader">用户</span><span role="columnheader">存储空间</span><span role="columnheader">状态</span><span role="columnheader">最近登录</span><span role="columnheader"><span className="sr-only">操作</span></span>
            </div>
            {shown.map(user => {
              const percent = user.quota_bytes ? user.used_bytes / user.quota_bytes * 100 : 0;
              return (
                <div key={user.id} role="row" className="data-row">
                  <span role="cell" className="cell-user"><Avatar name={user.username} tone={user.role === "admin" ? "admin" : "accent"} /><span className="name-stack"><strong>{user.username}</strong><small>{user.role === "admin" ? "管理员" : `创建于 ${formatDate(user.created_at)}`}</small></span></span>
                  <span role="cell" className="cell-usage">
                    <span className="usage-text"><strong>{formatBytes(user.used_bytes)}</strong><span className="muted">{user.quota_bytes ? ` / ${formatBytes(user.quota_bytes)}` : " / 不限"}</span></span>
                    {user.quota_bytes ? <Progress value={percent} tone={usageTone(percent)} label={`${user.username} 存储使用率`} /> : null}
                  </span>
                  <span role="cell">{user.status === "active" ? <Badge tone="success" dot>启用</Badge> : <Badge tone="danger" dot>已禁用</Badge>}</span>
                  <span role="cell" className="muted" title={formatDateTime(user.last_login_at)}>{user.last_login_at ? formatDate(user.last_login_at) : "从未登录"}</span>
                  <span role="cell" className="cell-actions">
                    {user.role === "admin" ? <span className="muted cell-note">管理员账号不可禁用</span> : <>
                      <Button size="sm" variant="ghost" onClick={() => setQuotaTarget(user)}>调整配额</Button>
                      {user.status === "active"
                        ? <Button size="sm" variant="ghost" className="btn-ghost-danger" onClick={() => setDisabling(user)}>禁用</Button>
                        : <Button size="sm" onClick={() => void setUserStatus(user, "active")}>启用</Button>}
                      <Menu label={`${user.username} 的更多操作`} items={[
                        { label: "重置密码", icon: "key", onSelect: () => setResetTarget(user) },
                        { label: "删除用户", icon: "trash", danger: true, divider: true, onSelect: () => setDeleteTarget(user) },
                      ]} />
                    </>}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <footer className="list-footer"><span>共 {pagination.page?.total ?? "—"} 个用户</span><Pagination {...pagination} /></footer>
      {creating && <CreateUserDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
      {quotaTarget && <QuotaDialog user={quotaTarget} onClose={() => setQuotaTarget(null)} onSaved={() => { setQuotaTarget(null); load(); }} />}
      {resetTarget && <ResetPasswordDialog user={resetTarget} onClose={() => setResetTarget(null)} />}
      {deleteTarget && <DeleteUserDialog user={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={() => { setDeleteTarget(null); load(); }} />}
      {disabling && <ConfirmDialog title={`禁用 ${disabling.username}？`} description="该用户会被立即登出，无法再登录，其所有公开链接暂停访问。文件不会被删除，可随时重新启用。" confirmLabel="禁用账号"
        onClose={() => setDisabling(null)} onConfirm={async () => { await setUserStatus(disabling, "disabled"); setDisabling(null); }} />}
    </>
  );
}

function parseQuota(value: string): number | null | undefined {
  if (!value.trim()) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * GB) : undefined;
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ username: "", password: "", quota: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const username = form.username.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/.test(username)) next.username = "2–64 位英文字母、数字、点、下划线或连字符";
    if (form.password.length < 8) next.password = "至少 8 个字符";
    const quota = parseQuota(form.quota);
    if (quota === undefined) next.quota = "请输入大于 0 的数字，或留空表示不限";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try { await api.createAdminUser(username, form.password, quota ?? null); toast.success(`已创建用户 ${username}`); onCreated(); }
    catch (reason) { setErrors({ username: api.errorMessage(reason, "创建失败，请稍后重试") }); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="新建用户" description="创建后，用户可以立即用这个账号登录文件空间。" icon="users" onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="user-form" loading={busy}>创建用户</Button></>}>
      <form id="user-form" className="form" onSubmit={submit} noValidate>
        <Field label="用户名" htmlFor="user-name" error={errors.username}>
          <input id="user-name" className="input" autoComplete="off" value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} autoFocus />
        </Field>
        <Field label="初始密码" htmlFor="user-password" error={errors.password} hint="用户登录后可以在账号菜单中修改。">
          <input id="user-password" className="input" type="password" autoComplete="new-password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} />
        </Field>
        <Field label="容量上限" htmlFor="user-quota" error={errors.quota} hint="留空表示不限制。">
          <div className="input-affix"><input id="user-quota" className="input" inputMode="decimal" placeholder="例如 100" value={form.quota} onChange={event => setForm({ ...form, quota: event.target.value })} /><span>GB</span></div>
        </Field>
      </form>
    </Modal>
  );
}

function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint32Array(14)), value => alphabet[value % alphabet.length]).join("");
}

function ResetPasswordDialog({ user, onClose }: { user: api.Account; onClose: () => void }) {
  const [password, setPassword] = useState(generatePassword);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 8) { setError("至少 8 个字符"); return; }
    setBusy(true);
    try { await api.resetAdminUserPassword(user.id, password); setDone(true); toast.success(`已重置 ${user.username} 的密码`); }
    catch (reason) { setError(api.errorMessage(reason, "重置失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={`重置 ${user.username} 的密码`} description="新密码立即生效，该用户的现有登录会被注销。把新密码通过安全的方式告诉用户，并提醒他登录后修改。" icon="key" onClose={onClose} size="sm"
      footer={done ? <Button variant="primary" onClick={onClose}>完成</Button> : <><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="reset-form" loading={busy}>重置密码</Button></>}>
      <form id="reset-form" className="form" onSubmit={submit} noValidate>
        {done ? <Field label="新密码"><CopyField value={password} label="新密码" copyMessage="密码已复制" /></Field> : (
          <Field label="新密码" htmlFor="reset-password" error={error} hint="已随机生成，也可以改成自己设定的密码。">
            <div className="input-affix">
              <input id="reset-password" className="input mono" value={password} onChange={event => { setPassword(event.target.value); setError(""); }} autoFocus />
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => setPassword(generatePassword())}>换一个</Button>
            </div>
          </Field>
        )}
      </form>
    </Modal>
  );
}

function DeleteUserDialog({ user, onClose, onDeleted }: { user: api.Account; onClose: () => void; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.deleteAdminUser(user.id, confirm);
      toast.success(`已删除用户 ${result.username}，共删除 ${result.deleted_objects} 个文件`);
      onDeleted();
    } catch (reason) { toast.error(api.errorMessage(reason, "删除失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={`删除用户 ${user.username}？`} icon="alert" tone="danger" onClose={onClose} size="sm"
      description={<>该用户的全部文件（{formatBytes(user.used_bytes)}，含回收站）、访问密钥与公开链接都会被<strong>永久删除</strong>，无法恢复。只想暂时阻止登录时，请改用“禁用”。</>}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="danger" type="submit" form="delete-user-form" loading={busy} disabled={confirm !== user.username}>永久删除</Button></>}>
      <form id="delete-user-form" className="form" onSubmit={submit} noValidate>
        <Field label={`输入用户名 ${user.username} 以确认`} htmlFor="delete-confirm">
          <input id="delete-confirm" className="input" autoComplete="off" value={confirm} onChange={event => setConfirm(event.target.value)} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

function QuotaDialog({ user, onClose, onSaved }: { user: api.Account; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(user.quota_bytes ? String(+(user.quota_bytes / GB).toFixed(2)) : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const quota = parseQuota(value);
    if (quota === undefined) { setError("请输入大于 0 的数字，或留空表示不限"); return; }
    setBusy(true);
    try { await api.setAdminUserQuota(user.id, quota); toast.success(`已更新 ${user.username} 的配额`); onSaved(); }
    catch (reason) { setError(api.errorMessage(reason, "保存失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  const quota = parseQuota(value);
  return (
    <Modal title={`调整 ${user.username} 的配额`} description={`当前已使用 ${formatBytes(user.used_bytes)}。`} size="sm" onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="quota-form" loading={busy}>保存</Button></>}>
      <form id="quota-form" className="form" onSubmit={submit} noValidate>
        <Field label="容量上限" htmlFor="quota-value" error={error} hint="留空表示不限制。">
          <div className="input-affix"><input id="quota-value" className="input" inputMode="decimal" value={value} onChange={event => { setValue(event.target.value); setError(""); }} autoFocus /><span>GB</span></div>
        </Field>
        {quota && quota < user.used_bytes ? <p className="inline-note tone-warning"><Icon name="alert" size={15} />新配额小于已用空间，用户将无法继续上传，现有文件不受影响。</p> : null}
      </form>
    </Modal>
  );
}

