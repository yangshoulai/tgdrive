import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useCursorPage } from "../pagination";
import { SITE } from "../brand";
import * as api from "../api";
import * as ai from "../assistant-api";

import { Notice, ButtonLink, Badge, Button, ConfirmDialog, EmptyState, Field, Icon, KeyValue, PageHeader, Pagination, Panel, Segmented, SkeletonRows, Tabs, Switch, formatBytes, formatDateTime, toast, useDocumentTitle } from "../ui";

import { UnlockForm } from "./lock";

/* ---------- 安全与维护 ---------- */

export function Maintenance({ status, onStatus, onLocked }: { status: api.SystemStatus | null; onStatus: (status: api.SystemStatus) => void; onLocked: () => void }) {
  const [locking, setLocking] = useState(false);
  const unlocked = status?.unlocked;
  const [section, setSection] = useState<"maintenance" | "security">(unlocked ? "maintenance" : "security");
  useEffect(() => { if (!unlocked) setSection("security"); }, [unlocked]);
  useDocumentTitle(`安全与维护 · ${SITE.admin}`);
  return (
    <>
      <PageHeader title="安全与维护" />
      <Tabs label="维护区域" value={section} onChange={setSection} options={[{ value: "maintenance", label: "维护与备份" }, { value: "security", label: "安全设置" }]} />
      <div className="stack maintenance-section" hidden={section !== "maintenance"}>
        <TasksPanel unlocked={Boolean(unlocked)} active={section === "maintenance"} />
        <ThumbnailTasksPanel active={section === "maintenance"} />
        <BackupsPanel unlocked={Boolean(unlocked)} />
      </div>
      <div className="stack maintenance-section" hidden={section !== "security"}>
        <Panel title="系统锁定" actions={unlocked ? <Badge tone="success" dot>已解锁</Badge> : <Badge tone="warning" dot>已锁定</Badge>}>
          {unlocked ? <div className="key-panel">
            <p>系统正在正常运行。锁定后所有账号退出登录，文件和公开链接暂停访问，需输入加密口令重新解锁。</p>
            <Button variant="danger" icon="lock" onClick={() => setLocking(true)}>锁定系统</Button>
          </div> : <div className="key-panel"><p>输入初始化时设置的加密口令以解锁系统。</p><UnlockForm onUnlocked={onStatus} /></div>}
        </Panel>
        {unlocked && <PassphrasePanel />}
        <Panel title="系统信息"><KeyValue items={[["用户数", String(status?.user_count ?? "—")], ["初始化", status?.initialized ? "已完成" : "未完成"], ["用户端地址", <a className="link" href={api.userSiteOrigin()} target="_blank" rel="noreferrer">{api.userSiteOrigin()}</a>]]} /></Panel>
      </div>
      {locking && <ConfirmDialog title="锁定系统？" description="所有用户和管理员会被立即登出，公开链接暂停访问，直到再次输入加密口令解锁。" confirmLabel="锁定系统"
        onClose={() => setLocking(false)} onConfirm={async () => {
          try { await api.adminLock(); toast.success("系统已锁定"); setLocking(false); onLocked(); }
          catch (reason) { toast.error(api.errorMessage(reason, "锁定失败，请稍后重试")); }
        }} />}
    </>
  );
}

export function Audit() {
  useDocumentTitle(`审计日志 · ${SITE.admin}`);
  return <><PageHeader title="审计日志" /><AuditPanel /></>;
}

const ACTOR_LABEL: Record<api.AuditEvent["actor_type"], string> = { admin: "管理员", user: "用户", key: "访问密钥" };

const STATUS_LABEL: Record<string, string> = {
  active: "启用", disabled: "停用", ok: "连接正常", completed: "已完成", pending: "待确认", confirmed: "已确认", rejected: "已拒绝",
  expired: "已过期", running: "执行中", done: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消",
  interrupted: "已中断", undoing: "撤销中", undone: "已撤销",
};
const count = (value: unknown, label: string) => typeof value === "number" ? `${label} ${value.toLocaleString("zh-CN")} 项` : null;

function auditDetail(event: api.AuditEvent) {
  const detail = event.detail ?? {};
  const parts: (string | null)[] = [];
  if (detail.method === "passkey") parts.push("通行密钥验证");
  if (typeof detail.kind === "string") parts.push(ai.ACTION_KINDS[detail.kind] ?? detail.kind);
  if (typeof detail.status === "string") parts.push(STATUS_LABEL[detail.status] ?? detail.status);
  if (typeof detail.enabled === "boolean") parts.push(detail.enabled ? "启用" : "停用");
  if ("public" in detail) parts.push(detail.public ? "开启" : "关闭");
  if (detail.password === "set" || detail.password === "cleared") parts.push(detail.password === "set" ? "设置访问密码" : "清除访问密码");
  if (typeof detail.expires_at === "number") parts.push(`有效期至 ${formatDateTime(detail.expires_at)}`);
  if (typeof detail.count === "number") parts.push(`${detail.count} 项`);
  if (typeof detail.saved === "number") parts.push(`保存 ${detail.saved} 项`);
  parts.push(count(detail.removed, "移除"), count(detail.purged, "清除"), count(detail.deleted_objects, "删除文件"), count(detail.deleted, "删除"),
    count(detail.added, "新增"), count(detail.updated, "更新"), count(detail.processed, "处理"), count(detail.checked, "校验"));
  if (typeof detail.bad === "number" && detail.bad) parts.push(`异常 ${detail.bad} 项`);
  if ("quota_bytes" in detail) parts.push(detail.quota_bytes ? `配额 ${formatBytes(Number(detail.quota_bytes))}` : "不限配额");
  if (typeof detail.name === "string") parts.push(detail.name);
  if (typeof detail.model === "string") parts.push(detail.model);
  if (Array.isArray(detail.models)) parts.push(`${detail.models.length} 个模型`);
  if (detail.api_key === "changed") parts.push("更换 API Key");
  if (typeof detail.full_access === "boolean") parts.push(detail.full_access ? "允许完全访问" : "关闭完全访问");
  if (typeof detail.public_base_url === "string" || typeof detail.s3_endpoint === "string") parts.push(Object.entries(detail).map(([key, value]) => `${key === "s3_endpoint" ? "S3" : "公开地址"}：${value || "默认"}`).join("，"));
  if (typeof detail.error === "string") parts.push(`错误：${detail.error}`);
  return parts.filter(Boolean).join("，");
}

function AuditPanel() {
  const [failedOnly, setFailedOnly] = useState(false);
  const fetchPage = useCallback((cursor: string | null) => api.adminAudit({ failedOnly, cursor: cursor === null ? null : Number(cursor) }), [failedOnly]);
  const pagination = useCursorPage(fetchPage);
  const events = pagination.page?.events ?? null;
  return (
    <Panel title="活动记录" description="记录账号、安全操作和结果，不记录文件名、路径、来源链接或凭据。" flush
      actions={<Segmented label="筛选" value={failedOnly ? "failed" : "all"} onChange={value => setFailedOnly(value === "failed")} options={[{ value: "all", label: "全部" }, { value: "failed", label: "仅失败" }]} />}>
      {pagination.error ? <EmptyState icon="alert" title="审计日志加载失败" description={pagination.error} action={<Button onClick={() => void pagination.reload()}>重试</Button>} /> : events === null ? <SkeletonRows rows={4} /> : events.length === 0 ? <EmptyState icon="shield" title={failedOnly ? "没有失败的操作" : "还没有记录"} /> : (
        <>
          <div className="table-scroll"><div className="data-table audit-table" role="table" aria-label="审计日志">
            <div className="data-row data-head" role="row">
              <span role="columnheader">时间</span><span role="columnheader">操作者</span><span role="columnheader">操作</span><span role="columnheader">对象与详情</span><span role="columnheader">结果</span>
            </div>
            {events.map(event => { const detail = auditDetail(event); return (
              <div key={event.id} role="row" className="data-row">
                <span role="cell" className="muted" title={event.ip ? `来源 IP：${event.ip}` : undefined}>{formatDateTime(event.ts)}</span>
                <span role="cell" className="name-stack"><strong>{event.actor ?? "—"}</strong><small>{ACTOR_LABEL[event.actor_type] ?? event.actor_type}</small></span>
                <span role="cell" className="audit-action" title={event.action}>{event.label}</span>
                <span role="cell" className="name-stack audit-detail">{event.target && <span className="mono audit-target" title={event.target}>{event.target}</span>}{detail && <small title={detail}>{detail}</small>}</span>
                <span role="cell">{event.ok ? <Badge tone="success" dot>成功</Badge> : <Badge tone="danger" dot>失败</Badge>}</span>
              </div>
            ); })}
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

function ThumbnailTasksPanel({ active }: { active: boolean }) {
  const [status, setStatus] = useState<api.ThumbnailQueueStatus | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => { void api.thumbnailQueue().then(value => { setStatus(value); setError(""); }).catch(reason => setError(api.errorMessage(reason, "缩略图队列读取失败"))); }, []);
  useEffect(() => {
    if (!active) return;
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 5000);
    return () => window.clearInterval(timer);
  }, [active, load]);
  const labels: Record<string, string> = { queued: "待处理", running: "处理中", waiting_client: "等待浏览器", waiting_data: "等待数据", done: "已完成", failed: "失败", cancelled: "已取消" };
  const [saving, setSaving] = useState(false);
  async function changeBackfill(value: string) {
    setSaving(true);
    try { const backfill = await api.setThumbnailBackfill(Number(value)); setStatus(current => current && { ...current, backfill }); toast.success("自动补图设置已保存"); }
    catch (reason) { toast.error(api.errorMessage(reason, "保存失败，请稍后重试")); }
    finally { setSaving(false); }
  }
  const backfill = status?.backfill;
  const dailyMib = backfill ? backfill.daily_bytes === null ? -1 : Math.round(backfill.daily_bytes / 1048576) : 4096;
  const presets = [0, 1024, 4096, 16384, 65536, -1];
  const kinds = { image: "图片", video: "视频", audio: "音频" };
  return <Panel title="缩略图队列" description="优先使用上传和预览时已收到的数据；仍缺缩略图的文件由自动补图按预算从存储读取（只产生入站流量）。此处仅显示任务编号与处理情况。"
    actions={<Button size="sm" icon="refresh" onClick={load}>刷新</Button>}>
    {error ? <EmptyState icon="alert" title="队列读取失败" description={error} /> : !status ? <SkeletonRows rows={2} /> : <>
      <KeyValue items={[["队列", `${status.jobs.length} / ${status.capacity}`], ["当前处理", `${status.jobs.filter(job => job.state === "running").length} 项`],
        ["缓存", `${formatBytes(status.cache.bytes)} / ${formatBytes(status.cache.limit_bytes)}`], ["从存储读取（本次运行）", formatBytes(status.remote_bytes)],
        ["今日自动补图", status.backfill.daily_bytes === 0 ? "已关闭" : `${formatBytes(status.backfill.used_bytes)} / ${status.backfill.daily_bytes === null ? "不限制" : formatBytes(status.backfill.daily_bytes)}`],
        ...(status.inline.count ? [["数据库中待转存", `${status.inline.count} 张（${formatBytes(status.inline.bytes)}）${status.inline.skipped_quota ? `，${status.inline.skipped_quota} 张因空间已满暂缓` : ""}`] as [string, string]] : [])]} />
      <div className="thumbnail-backfill">
        <Field label="自动补图每日读取上限" hint={`上传或修改超过 ${Math.round(status.backfill.age_seconds / 60)} 分钟仍没有缩略图的图片、视频、音频，由后台从存储读取生成（单个文件图片 60、视频 64、音频 32 MiB 以内），保证最终都有缩略图。关闭后只能等实际预览或手动生成。`}>
          <select className="input" value={presets.includes(dailyMib) ? String(dailyMib) : "custom"} disabled={saving} onChange={event => void changeBackfill(event.target.value)}>
            {!presets.includes(dailyMib) && <option value="custom" disabled>{formatBytes(dailyMib * 1048576)}</option>}
            {presets.map(value => <option key={value} value={value}>{value === 0 ? "关闭" : value === -1 ? "不限制" : formatBytes(value * 1048576)}</option>)}
          </select>
        </Field>
      </div>
      {!status.available && <Notice tone="warning">服务器未安装 FFmpeg，后台生成不可用；网页仍可用本地文件或已加载的画面生成。</Notice>}
      {!status.unlocked && <Notice>系统已锁定，后台任务暂停。</Notice>}
      {status.pressure && <Notice tone="warning">{status.pressure}</Notice>}
      {status.jobs.length === 0 ? <p className="muted">当前没有待处理的缩略图任务。</p> : <div className="table-scroll"><div className="data-table thumbnail-jobs-table" role="table" aria-label="缩略图任务">
        <div className="data-row data-head" role="row"><span role="columnheader">任务</span><span role="columnheader">类型</span><span role="columnheader">状态</span><span role="columnheader">说明</span></div>
        {status.jobs.map(job => <div className="data-row" role="row" key={job.id}><span role="cell" className="mono">{job.id}</span><span role="cell">{kinds[job.kind]}</span>
          <span role="cell"><Badge tone={job.state === "running" ? "accent" : "neutral"}>{job.backfill && job.state === "queued" ? "自动补图" : labels[job.state] ?? job.state}</Badge></span>
          <span role="cell" className="muted">{job.detail}{job.wait_seconds ? `（${job.wait_seconds} 秒）` : ""}</span></div>)}
      </div></div>}
      {status.recent.length > 0 && <details><summary>最近处理记录（{status.recent.length}）</summary><ul className="task-list">
        {status.recent.slice(0, 20).map(job => <li key={job.id}><span className="mono">{job.id}</span><span className="attention-copy"><strong>{kinds[job.kind]} · {labels[job.state] ?? job.state}</strong><small>{job.detail}</small></span><small className="muted">{job.at ? formatDateTime(job.at) : ""}</small></li>)}
      </ul></details>}
      <p className="muted">浏览器生成权 {status.client_timeout_seconds} 秒，后台单次处理 {status.task_timeout_seconds} 秒。缓存最长保留 {Math.round(status.cache.ttl_seconds / 60)} 分钟，进程重启后等待新的上传或预览数据。</p>
    </>}
  </Panel>;
}

/** 自动任务每 10 分钟运行一次（完整性校验与备份每天一次）；这里显示最近结果并允许立即运行。 */
function TasksPanel({ unlocked, active }: { unlocked: boolean; active: boolean }) {
  const [status, setStatus] = useState<api.MaintenanceStatus | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [deep, setDeep] = useState(false);
  const failures = status?.gc_failures ?? [];
  const load = useCallback(async () => { try { setStatus(await api.maintenanceStatus()); } catch { /* 下轮再刷新，不覆盖已有结果。 */ } }, []);
  useEffect(() => {
    if (!active || !unlocked) return;
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => window.clearInterval(timer);
  }, [active, unlocked, load]);
  async function run(name: string, action: () => Promise<string>) {
    setRunning(name);
    try { toast.success(await action()); }
    catch (reason) { toast.error(api.errorMessage(reason, "执行失败，请稍后重试")); }
    finally { setRunning(null); void load(); }
  }
  async function collect(retry = false) {
    setRunning(retry ? "retry" : "gc");
    try {
      if (retry) {
        const result = await api.retryDeadGc();
        toast.info(`已重新排队 ${result.requeued} 项，正在尝试清除`);
        await load();
      }
      const result = await api.runAdminGc(500);
      const message = `处理 ${result.processed} 项，删除 ${result.deleted} 项${result.failed ? `，${result.failed} 项失败，请查看失败原因` : ""}`;
      if (result.failed) toast.error(message); else toast.success(message);
    } catch (reason) { toast.error(api.errorMessage(reason, "清除失败，请稍后重试")); }
    finally { setRunning(null); void load(); }
  }
  const outcome = (task?: api.MaintenanceTask, describe?: (task: api.MaintenanceTask) => string, warning = false) => !task ? <small className="muted">从未运行</small>
    : task.error ? <span className="task-outcome tone-danger"><Icon name="alert" size={14} />{task.error}<span className="muted">{since(task.at)}</span></span>
      : <span className={`task-outcome ${warning ? "tone-warning" : "tone-success"}`}><Icon name={warning ? "alert" : "check"} size={14} />{describe?.(task) ?? "完成"}<span className="muted">{since(task.at)}</span></span>;
  const n = (value: unknown) => Number(value ?? 0);
  return (
    <Panel title="维护任务" description="服务运行时会自动执行：清理类任务每 10 分钟一次，文件校验与备份每天一次。系统锁定时暂停。" flush>
      <ul className="task-list">
        <li>
          <span className="attention-icon tone-accent"><Icon name="trash" size={17} /></span>
          <div className="attention-copy">
            <strong>清除已删除的文件</strong><small>把已经删除的文件从存储位置真正清除，释放空间。待清除 {status ? status.gc_pending + status.gc_dead : "—"} 项{status && status.gc_dead > 0 ? `（其中 ${status.gc_dead} 项已暂停重试）` : ""}。</small>
            {outcome(status?.gc, task => `最近一轮：处理 ${n(task.processed)} 项，删除 ${n(task.deleted)} 项${n(task.failed) ? `，${n(task.failed)} 项失败` : ""}`,
              n(status?.gc?.failed) > 0 || n(status?.gc_dead) > 0)}
            {status && status.gc_dead > 0 && <span className="task-outcome tone-warning"><Icon name="alert" size={14} />{status.gc_dead} 项连续删除失败，已暂停自动重试；请先查看原因。
              <Button size="sm" variant="ghost" loading={running === "retry"} disabled={!unlocked || running !== null} onClick={() => void collect(true)}>重新尝试</Button></span>}
            {failures.length > 0 && <details className="gc-failures"><summary>查看失败原因</summary><div className="gc-failure-list">
              {failures.map(failure => <div className="gc-failure" key={failure.reason}><strong>{failure.count} 项：{failure.label}</strong><small>{failure.hint}</small></div>)}
            </div></details>}
          </div>
          <Button size="sm" loading={running === "gc" || running === "retry"} disabled={!unlocked || running !== null} onClick={() => void collect()}>立即运行</Button>
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
  const [error, setError] = useState("");
  const load = useCallback(() => { setError(""); void api.listBackups().then(setBackups).catch(reason => setError(api.errorMessage(reason, "备份列表加载失败，请稍后重试"))); }, []);
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
      {error ? <EmptyState icon="alert" title="备份列表加载失败" description={error} action={<Button onClick={load}>重试</Button>} /> : backups === null ? <SkeletonRows rows={2} /> : backups.length === 0 ? <EmptyState icon="shield" title="还没有备份" description="解锁后系统会自动创建第一份备份。" /> : (
        <div className="table-scroll"><div className="data-table backups-table" role="table" aria-label="备份">
          <div className="data-row data-head" role="row"><span role="columnheader">备份文件</span><span role="columnheader">大小</span><span role="columnheader">创建时间</span><span role="columnheader"><span className="sr-only">操作</span></span></div>
          {backups.map(backup => (
            <div key={backup.name} role="row" className="data-row">
              <span role="cell" className="mono">{backup.name}</span>
              <span role="cell" className="muted">{formatBytes(backup.size)}</span>
              <span role="cell" className="muted">{formatDateTime(backup.created_at)}</span>
              <span role="cell" className="cell-actions"><ButtonLink variant="ghost" size="sm" icon="download" href={api.backupUrl(backup.name)} download>下载</ButtonLink></span>
            </div>
          ))}
        </div></div>
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
        {errors.form && <Notice tone="danger">{errors.form}</Notice>}
        <Notice tone="warning">之前的备份仍需用当时的旧口令恢复。新口令同样无法找回，请先保存到密码管理器。</Notice>
        <div><Button type="submit" variant="primary" loading={busy}>更换口令</Button></div>
      </form>
    </Panel>
  );
}
