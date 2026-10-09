import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useCursorPage } from "../pagination";
import { SITE } from "../brand";
import * as api from "../api";

import { Badge, Button, ConfirmDialog, EmptyState, Field, Icon, KeyValue, PageHeader, Pagination, Panel, Segmented, SkeletonRows, Switch, formatBytes, formatDateTime, toast, useDocumentTitle } from "../ui";

import { UnlockForm } from "./lock";

/* ---------- 安全与维护 ---------- */

export function Maintenance({ status, onStatus, onLocked }: { status: api.SystemStatus | null; onStatus: (status: api.SystemStatus) => void; onLocked: () => void }) {
  const [locking, setLocking] = useState(false);
  const unlocked = status?.unlocked;
  useDocumentTitle(`安全与维护 · ${SITE.admin}`);
  return (
    <>
      <PageHeader title="安全与维护" description="系统的锁定状态、后台清理与检查任务，以及数据备份。" />
      <div className="stack">
        <Panel title="系统锁定" actions={unlocked ? <Badge tone="success" dot>已解锁</Badge> : <Badge tone="warning" dot>已锁定</Badge>}>
          {unlocked ? (
            <div className="key-panel">
              <p>系统正在正常运行，用户可以登录，文件与公开链接可以访问。锁定后所有人会立即退出登录，再次使用需要输入加密口令。</p>
              <Button variant="danger" icon="lock" onClick={() => setLocking(true)}>锁定系统</Button>
            </div>
          ) : (
            <div className="key-panel">
              <p>输入初始化时设置的加密口令以解锁系统。</p>
              <UnlockForm onUnlocked={onStatus} />
            </div>
          )}
        </Panel>
        <TasksPanel unlocked={Boolean(unlocked)} />
        <BackupsPanel unlocked={Boolean(unlocked)} />
        {unlocked && <PassphrasePanel />}
        <AuditPanel />
        <Panel title="系统信息">
          <KeyValue items={[["用户数", String(status?.user_count ?? "—")], ["初始化", status?.initialized ? "已完成" : "未完成"], ["用户端地址", <a className="link" href={api.userSiteOrigin()} target="_blank" rel="noreferrer">{api.userSiteOrigin()}</a>]]} />
        </Panel>
      </div>
      {locking && <ConfirmDialog title="锁定系统？" description="所有用户和管理员会被立即登出，公开链接暂停访问，直到再次输入加密口令解锁。" confirmLabel="锁定系统"
        onClose={() => setLocking(false)}
        onConfirm={async () => {
          try { await api.adminLock(); toast.success("系统已锁定"); setLocking(false); onLocked(); }
          catch (reason) { toast.error(api.errorMessage(reason, "锁定失败，请稍后重试")); }
        }} />}
    </>
  );
}

const ACTOR_LABEL: Record<api.AuditEvent["actor_type"], string> = { admin: "管理员", user: "用户", key: "访问密钥" };

function auditDetail(event: api.AuditEvent) {
  const detail = event.detail ?? {};
  const parts: string[] = [];
  if (typeof detail.status === "string") parts.push(detail.status === "active" ? "启用" : detail.status === "disabled" ? "停用" : detail.status === "ok" ? "连接正常" : detail.status);
  if ("public" in detail) parts.push(detail.public ? "开启" : "关闭");
  if ("quota_bytes" in detail) parts.push(detail.quota_bytes ? `配额 ${formatBytes(Number(detail.quota_bytes))}` : "不限配额");
  if (typeof detail.name === "string") parts.push(detail.name);
  if (typeof detail.public_base_url === "string" || typeof detail.s3_endpoint === "string") parts.push(Object.entries(detail).map(([key, value]) => `${key === "s3_endpoint" ? "S3" : "公开地址"}：${value || "默认"}`).join("，"));
  if (typeof detail.error === "string") parts.push(`错误：${detail.error}`);
  return parts.join("，");
}

function AuditPanel() {
  const [failedOnly, setFailedOnly] = useState(false);
  const fetchPage = useCallback((cursor: string | null) => api.adminAudit({ failedOnly, cursor: cursor === null ? null : Number(cursor) }), [failedOnly]);
  const pagination = useCursorPage(fetchPage);
  const events = pagination.page?.events ?? null;
  return (
    <Panel title="审计日志" description="登录、权限、密钥、分享与系统设置的变更记录。不会记录密码、口令、token 或 Secret。" flush
      actions={<Segmented label="筛选" value={failedOnly ? "failed" : "all"} onChange={value => setFailedOnly(value === "failed")} options={[{ value: "all", label: "全部" }, { value: "failed", label: "仅失败" }]} />}>
      {pagination.error ? <EmptyState icon="alert" title="审计日志加载失败" description={pagination.error} action={<Button onClick={() => void pagination.reload()}>重试</Button>} /> : events === null ? <SkeletonRows rows={4} /> : events.length === 0 ? <EmptyState icon="shield" title={failedOnly ? "没有失败的操作" : "还没有记录"} /> : (
        <>
          <div className="table-scroll"><div className="data-table audit-table" role="table" aria-label="审计日志">
            <div className="data-row data-head" role="row">
              <span role="columnheader">时间</span><span role="columnheader">操作者</span><span role="columnheader">操作</span><span role="columnheader">对象与详情</span><span role="columnheader">结果</span>
            </div>
            {events.map(event => (
              <div key={event.id} role="row" className="data-row">
                <span role="cell" className="muted" title={event.ip ? `来源 IP：${event.ip}` : undefined}>{formatDateTime(event.ts)}</span>
                <span role="cell" className="name-stack"><strong>{event.actor ?? "—"}</strong><small>{ACTOR_LABEL[event.actor_type] ?? event.actor_type}</small></span>
                <span role="cell">{event.label}</span>
                <span role="cell" className="name-stack"><span className="mono audit-target">{event.target ?? ""}</span><small>{auditDetail(event)}</small></span>
                <span role="cell">{event.ok ? <Badge tone="success" dot>成功</Badge> : <Badge tone="danger" dot>失败</Badge>}</span>
              </div>
            ))}
          </div></div>
          <div className="panel-more"><Pagination {...pagination} /></div>
        </>
      )}
    </Panel>
  );
}

function since(seconds?: number) {
  if (!seconds) return "从未运行";
  return formatDateTime(seconds);
}

/** 自动任务每 10 分钟运行一次（完整性校验与备份每天一次）；这里显示最近结果并允许立即运行。 */
function TasksPanel({ unlocked }: { unlocked: boolean }) {
  const [status, setStatus] = useState<api.MaintenanceStatus | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [deep, setDeep] = useState(false);
  const load = useCallback(() => { void api.maintenanceStatus().then(setStatus).catch(() => undefined); }, []);
  useEffect(load, [load]);
  async function run(name: string, action: () => Promise<string>) {
    setRunning(name);
    try { toast.success(await action()); }
    catch (reason) { toast.error(api.errorMessage(reason, "执行失败，请稍后重试")); }
    finally { setRunning(null); load(); }
  }
  const outcome = (task?: api.MaintenanceTask, describe?: (task: api.MaintenanceTask) => string) => !task ? <small className="muted">从未运行</small>
    : task.error ? <span className="task-outcome tone-danger"><Icon name="alert" size={14} />{task.error}<span className="muted">{since(task.at)}</span></span>
      : <span className="task-outcome tone-success"><Icon name="check" size={14} />{describe?.(task) ?? "完成"}<span className="muted">{since(task.at)}</span></span>;
  const n = (value: unknown) => Number(value ?? 0);
  return (
    <Panel title="维护任务" description="服务运行时会自动执行：清理类任务每 10 分钟一次，文件校验与备份每天一次。系统锁定时暂停。" flush>
      <ul className="task-list">
        <li>
          <span className="attention-icon tone-accent"><Icon name="trash" size={17} /></span>
          <span className="attention-copy">
            <strong>清除已删除的文件</strong><small>把已经删除的文件从存储位置真正清除，释放空间。待清除 {status?.gc_pending ?? "—"} 项。</small>
            {outcome(status?.gc, task => `处理 ${n(task.processed)} 项，删除 ${n(task.deleted)} 项${n(task.failed) ? `，${n(task.failed)} 项失败` : ""}`)}
            {status && status.gc_dead > 0 && <span className="task-outcome tone-warning"><Icon name="alert" size={14} />{status.gc_dead} 项多次删除失败后已暂停重试（例如对应的存储通道已不可用）。
              <Button size="sm" variant="ghost" disabled={!unlocked} onClick={() => void run("retry", async () => `已重新排队 ${(await api.retryDeadGc()).requeued} 项`)}>重新尝试</Button></span>}
          </span>
          <Button size="sm" loading={running === "gc"} disabled={!unlocked || running !== null} onClick={() => void run("gc", async () => {
            const result = await api.runAdminGc(500); return `处理 ${result.processed} 项，删除 ${result.deleted} 项`;
          })}>立即运行</Button>
        </li>
        <li>
          <span className="attention-icon tone-accent"><Icon name="upload" size={17} /></span>
          <span className="attention-copy">
            <strong>清理未完成的上传</strong><small>清除 7 天没有继续的上传，以及服务中断时遗留的临时数据。</small>
            {outcome(status?.cleanup, task => `中止 ${n(task.aborted_uploads)} 个上传，清理 ${n(task.stale_blobs)} 份临时数据`)}
          </span>
          <Button size="sm" loading={running === "cleanup"} disabled={!unlocked || running !== null} onClick={() => void run("cleanup", async () => {
            const result = await api.runCleanup(); return `中止 ${result.aborted_uploads} 个上传，清理 ${result.stale_blobs} 份临时数据`;
          })}>立即运行</Button>
        </li>
        <li>
          <span className="attention-icon tone-accent"><Icon name="checkCircle" size={17} /></span>
          <span className="attention-copy">
            <strong>文件校验</strong><small>检查已保存的文件是否完好；每次从上次停下的位置继续，所有文件轮流被检查。</small>
            {outcome(status?.scrub, task => n(task.bad) ? `检查 ${n(task.checked)} 个文件，发现 ${n(task.bad)} 个损坏` : `检查 ${n(task.checked)} 个文件，全部完好${task.wrapped ? "（已完成一轮）" : ""}`)}
            <Switch checked={deep} onChange={setDeep} label="深度校验" description="手动运行时额外检查文件内容能否正常打开，耗时更长。" />
          </span>
          <Button size="sm" loading={running === "scrub"} disabled={!unlocked || running !== null} onClick={() => void run("scrub", async () => {
            const result = await api.runAdminScrub(100, deep);
            return result.bad.length ? `发现 ${result.bad.length} 个损坏的文件` : `检查 ${result.checked} 个文件，全部完好`;
          })}>立即运行</Button>
        </li>
        <li>
          <span className="attention-icon tone-accent"><Icon name="refresh" size={17} /></span>
          <span className="attention-copy">
            <strong>清理回收站</strong><small>永久删除在回收站中超过 30 天的文件。</small>
            {outcome(status?.trash, task => `永久删除 ${n(task.purged)} 项`)}
          </span>
        </li>
      </ul>
    </Panel>
  );
}

function BackupsPanel({ unlocked }: { unlocked: boolean }) {
  const [backups, setBackups] = useState<api.Backup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void api.listBackups().then(setBackups).catch(() => setBackups([])); }, []);
  useEffect(load, [load]);
  async function create() {
    setBusy(true);
    try { const backup = await api.createBackup(); toast.success(`已创建备份 ${backup.name}`); load(); }
    catch (reason) { toast.error(api.errorMessage(reason, "备份失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  return (
    <Panel title="数据备份" description="数据库记录了每个文件保存在哪里、如何打开。它丢失后，已保存的文件将无法读取。系统每天自动备份一次，保留最近 14 份。"
      actions={<Button size="sm" icon="plus" loading={busy} disabled={!unlocked} onClick={() => void create()}>立即备份</Button>} flush>
      {backups === null ? <SkeletonRows rows={2} /> : backups.length === 0 ? <EmptyState icon="shield" title="还没有备份" description="解锁后系统会自动创建第一份备份。" /> : (
        <div className="data-table backups-table" role="table" aria-label="备份">
          <div className="data-row data-head" role="row"><span role="columnheader">备份文件</span><span role="columnheader">大小</span><span role="columnheader">创建时间</span><span role="columnheader"><span className="sr-only">操作</span></span></div>
          {backups.map(backup => (
            <div key={backup.name} role="row" className="data-row">
              <span role="cell" className="mono">{backup.name}</span>
              <span role="cell" className="muted">{formatBytes(backup.size)}</span>
              <span role="cell" className="muted">{formatDateTime(backup.created_at)}</span>
              <span role="cell" className="cell-actions"><a className="btn btn-ghost btn-sm" href={api.backupUrl(backup.name)} download><Icon name="download" size={15} /><span>下载</span></a></span>
            </div>
          ))}
        </div>
      )}
      <div className="panel-note">
        <p>备份已用加密口令加密，可以放在其他机器或网盘。请把备份保存在服务器以外的地方。恢复时先停止服务，然后执行：</p>
        <div className="code-block"><pre><code>tgdrive restore tgdrive-20261007-030000.tgdbak --data-dir /var/lib/tgdrive</code></pre></div>
        <p className="muted">恢复需要输入<strong>创建该备份时</strong>的加密口令。原数据库会被保留为 meta.db.before-restore-*，不会被覆盖。</p>
      </div>
    </Panel>
  );
}

function PassphrasePanel() {
  const [form, setForm] = useState({ old: "", next: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!form.old) next.old = "请输入当前加密口令";
    if (form.next.length < 12) next.next = "新口令至少 12 个字符";
    else if (form.next !== form.confirm) next.confirm = "两次输入的口令不一致";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const result = await api.changePassphrase(form.old, form.next);
      setForm({ old: "", next: "", confirm: "" });
      toast.success(`加密口令已更换，重新加密了 ${result.rewrapped_files} 个文件的密钥`);
    } catch (reason) {
      setErrors(reason instanceof api.ApiError && reason.code === "wrong_passphrase" ? { old: "当前口令不正确" } : { form: api.errorMessage(reason, "更换失败，请稍后重试") });
    } finally { setBusy(false); }
  }
  const field = (key: keyof typeof form, label: string) => (
    <Field label={label} htmlFor={`pass-${key}`} error={errors[key]}>
      <input id={`pass-${key}`} className="input" type="password" autoComplete={key === "old" ? "current-password" : "new-password"}
        value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} />
    </Field>
  );
  return (
    <Panel title="更换加密口令" description="用新口令重新保护所有文件、访问密钥和存储通道的凭据，已保存的文件不需要重新上传。更换后旧口令立即失效。">
      <form className="form passphrase-form" onSubmit={submit} noValidate>
        {field("old", "当前加密口令")}
        <div className="form-row">{field("next", "新加密口令")}{field("confirm", "确认新口令")}</div>
        {errors.form && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{errors.form}</div>}
        <p className="inline-note tone-warning"><Icon name="alert" size={15} />之前的备份仍需用当时的旧口令恢复。新口令同样无法找回，请先保存到密码管理器。</p>
        <div><Button type="submit" variant="primary" loading={busy}>更换口令</Button></div>
      </form>
    </Panel>
  );
}
