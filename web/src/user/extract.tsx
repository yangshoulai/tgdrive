import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { baseName, parentPath } from "../files";
import { Button, Field, KeyValue, Modal, Notice, Progress, Segmented, Switch, formatBytes, toast } from "../ui";
import { FolderPicker } from "./folders";

/** 压缩包名去掉扩展名，作为「解压到同名文件夹」的名称。 */
export function archiveBase(key: string) {
  return baseName(key).replace(/\.(tar\.(?:gz|bz2|xz)|tgz|tbz2?|txz|zip|tar|gz|bz2|xz)$/i, "") || "解压结果";
}
export const isArchive = (file: api.FileItem) => api.ARCHIVE_NAME.test(file.key);

const ACTIVE = new Set(["queued", "running"]);
const watched = new Set<string>();
/** 关闭对话框后在后台跟踪任务：结束时提示结果，并让所在目录（含上级）刷新。 */
function watchJob(job: api.ArchiveJob, onOpen?: (folder: string) => void) {
  if (watched.has(job.id)) return;
  watched.add(job.id);
  const tick = async () => {
    let current = job;
    try { current = (await api.archiveJobs([job.id], job.private)).jobs[0] ?? job; } catch { /* 网络抖动时下次再查 */ }
    if (ACTIVE.has(current.status)) { window.setTimeout(() => void tick(), 2000); return; }
    watched.delete(job.id);
    announce(current);
    const name = baseName(current.archive);
    const open = onOpen ? { label: "打开", onClick: () => onOpen(current.destination) } : undefined;
    if (current.status === "completed" && !current.failed) toast.success(`「${name}」已解压，共 ${current.done_files} 个文件`, open);
    else if (current.status === "completed") toast.error(`「${name}」解压完成，${current.failed} 个文件失败`);
    else if (current.status === "failed") toast.error(`「${name}」解压失败：${current.error}`);
  };
  window.setTimeout(() => void tick(), 2000);
}
function announce(job: api.ArchiveJob) {
  const folders = new Set<string>();
  for (let folder = job.destination; ; folder = parentPath(folder.slice(0, -1))) {
    folders.add(folder);
    if (!folder || folder === api.PRIVATE_PREFIX) break;
  }
  folders.add(parentPath(job.archive));
  window.dispatchEvent(new CustomEvent("tessera:files-added", { detail: { folders: [...folders] } }));
}

type Place = "folder" | "here" | "other";
const CONFLICTS: { value: api.ArchiveConflict; label: string }[] = [
  { value: "rename", label: "保留两者" }, { value: "skip", label: "跳过" }, { value: "overwrite", label: "覆盖" },
];
const CONFLICT_HINTS: Record<api.ArchiveConflict, string> = {
  rename: "同名文件自动改名为「名称 (1)」，已有文件不变。",
  skip: "已有同名文件时不解出这个文件。",
  overwrite: "用压缩包里的文件替换已有同名文件，原文件会被覆盖。",
};

/** 在线解压：预览压缩包、输入密码、选择位置与同名处理，开始后显示进度；关闭后任务在服务器上继续。 */
export function ExtractDialog({ file, onClose, onOpenFolder }: { file: api.FileItem; onClose: () => void; onOpenFolder?: (folder: string) => void }) {
  const parent = parentPath(file.key);
  const [place, setPlace] = useState<Place>("folder");
  const [other, setOther] = useState(parent);
  const [otherReady, setOtherReady] = useState(true);
  const destination = place === "here" ? parent : place === "folder" ? `${parent}${archiveBase(file.key)}/` : other;
  const [info, setInfo] = useState<api.ArchiveInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [conflict, setConflict] = useState<api.ArchiveConflict>("rename");
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<api.ArchiveJob | null>(null);
  const chosen = useRef(false);
  // 预览压缩包：位置变化时重新统计同名文件（ZIP 读目录，TAR 无法预先列出）。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      api.inspectArchive(file.key, { destination }).then(value => {
        if (cancelled) return;
        setInfo(value); setError("");
        // 压缩包里已经只有一个顶层文件夹，或是单个 .gz：默认解压到当前文件夹，不再多套一层。
        if (!chosen.current) { chosen.current = true; if (value.single_root || value.single_name) setPlace("here"); }
      }, reason => { if (!cancelled) setError(api.errorMessage(reason, "无法读取压缩包")); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, info ? 300 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.key, destination]);
  // 进行中轮询进度；对话框关闭后交给后台跟踪。
  useEffect(() => {
    if (!job || !ACTIVE.has(job.status)) return;
    const timer = window.setTimeout(() => {
      api.archiveJobs([job.id], job.private).then(value => {
        const next = value.jobs[0];
        if (!next) return;
        setJob(next);
        if (!ACTIVE.has(next.status)) announce(next);
      }, () => setJob(current => current && { ...current }));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [job]);
  const close = () => {
    if (job && ACTIVE.has(job.status)) { watchJob(job, onOpenFolder); toast.info("解压在后台继续，完成后会提示"); }
    onClose();
  };

  const need = info?.total_bytes == null ? null
    : Math.max(0, info.total_bytes - (conflict === "skip" || conflict === "overwrite" ? info.conflict_bytes ?? 0 : 0));
  const short = need !== null && info?.room != null && need > info.room;
  const needsPassword = Boolean(info?.encrypted);
  async function start() {
    if (!info || short) return;
    if (needsPassword && !password) { setPasswordError("请输入压缩包密码"); return; }
    setBusy(true); setError(""); setPasswordError("");
    try {
      setJob(await api.extractArchive(file.key, { destination, password: needsPassword ? password : undefined, conflict, keep_archive: keep }));
    } catch (reason) {
      const message = api.errorMessage(reason, "无法开始解压");
      if (/密码/.test(message)) setPasswordError(message); else setError(message);
    } finally { setBusy(false); }
  }

  if (job) {
    const active = ACTIVE.has(job.status);
    const percent = job.total_bytes ? job.done_bytes / job.total_bytes * 100 : job.archive_size ? job.read_bytes / job.archive_size * 100 : 0;
    const title = job.status === "completed" ? job.failed ? "解压完成，部分文件失败" : "解压完成" : job.status === "failed" ? "解压失败" : job.status === "cancelled" ? "已取消解压" : "正在解压";
    return <Modal title={title} icon="archive" description={baseName(file.key)} onClose={close} dismissible={!active}
      footer={active ? <><Button onClick={() => void api.cancelArchiveJob(job.id, job.private).then(setJob, reason => toast.error(api.errorMessage(reason, "取消失败")))}>取消解压</Button><Button variant="primary" onClick={close}>后台运行</Button></>
        : <>{onOpenFolder && job.status !== "failed" && <Button onClick={() => { onClose(); onOpenFolder(job.destination); }}>打开文件夹</Button>}<Button variant="primary" onClick={onClose}>完成</Button></>}>
      <div className="extract-progress">
        {active && <Progress value={percent} label="解压进度" />}
        {active && <p className="muted extract-current" title={job.current}>{job.status === "queued" ? "排队中…" : job.current ? `正在解压 ${job.current}` : "正在读取压缩包…"}</p>}
        {job.error && <Notice tone="danger">{job.error}</Notice>}
        <KeyValue items={[
          ["已解出", `${job.done_files}${job.total_files != null ? ` / ${job.total_files}` : ""} 个文件 · ${formatBytes(job.done_bytes)}${job.total_bytes ? ` / ${formatBytes(job.total_bytes)}` : ""}`],
          ...(job.skipped ? [["跳过同名", `${job.skipped} 个`] as [string, string]] : []),
          ...(job.renamed ? [["自动改名", `${job.renamed} 个`] as [string, string]] : []),
          ...(job.failed ? [["失败", `${job.failed} 个`] as [string, string]] : []),
          ["保存到", api.privatePathLabel(job.destination) || "我的文件"],
          ...(!active ? [["原压缩包", job.archive_removed ? "已移到回收站" : "已保留"] as [string, string]] : []),
        ]} />
        {job.failures.length > 0 && <details className="extract-failures"><summary>查看失败的文件</summary>
          <ul>{job.failures.map((item, index) => <li key={index}><strong>{item.name}</strong><span>{item.error}</span></li>)}</ul>
        </details>}
        {!active && job.failed > 0 && !job.keep_archive && <p className="muted">有文件失败，原压缩包已保留。</p>}
      </div>
    </Modal>;
  }

  return <Modal title="解压" icon="archive" description={baseName(file.key)} size="md" onClose={onClose} dismissible={!busy}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={!info || loading && !info || short || place === "other" && !otherReady} onClick={() => void start()}>开始解压</Button></>}>
    <div className="extract-form">
      {error && <Notice tone="danger">{error}</Notice>}
      {!info && !error && <p className="muted">正在读取压缩包…</p>}
      {info && <>
        <KeyValue items={[
          ["格式", info.format.toUpperCase()],
          ["内容", info.listable ? `${info.files} 个文件 · 解压后 ${formatBytes(info.total_bytes)}` : info.single_name ? `1 个文件：${info.single_name}` : "TAR 需要边读边解，开始前无法统计"],
          ["可用空间", info.room == null ? "不限" : formatBytes(Math.max(0, info.room))],
        ]} />
        {short && <Notice tone="danger">空间不足：解压后约 {formatBytes(need)}，可用 {formatBytes(Math.max(0, info.room ?? 0))}。请清理空间或联系管理员调整配额。</Notice>}
        {!info.listable && !info.single_name && <p className="muted">解压时如果空间用完会停止，已解出的文件保留。</p>}
        {(info.unsafe ?? 0) > 0 && <Notice tone="warning">{info.unsafe} 个条目的路径指向保存位置之外（如 ../），会被跳过。</Notice>}
        {(info.unsupported ?? 0) > 0 && <Notice tone="warning">{info.unsupported} 个文件使用了不支持的压缩方式，会解压失败。</Notice>}
        {needsPassword && <Field label="压缩包密码" error={passwordError} hint={info.encryption === "aes" ? "AES 加密" : "传统 ZIP 加密"}>
          <input className="input" type="password" autoComplete="off" value={password} onChange={event => { setPassword(event.target.value); setPasswordError(""); }}
            onKeyDown={event => { if (event.key === "Enter") void start(); }} autoFocus />
        </Field>}
        <Field label="解压到">
          <Segmented label="解压到" value={place} onChange={setPlace} showLabels options={[
            { value: "folder", label: `「${archiveBase(file.key)}」文件夹` }, { value: "here", label: "当前文件夹" }, { value: "other", label: "其他位置" },
          ]} />
        </Field>
        {place === "other" && <div className="extract-picker"><FolderPicker value={other} onChange={setOther} onReady={setOtherReady} /></div>}
        <p className="muted extract-destination">保存到 {api.privatePathLabel(destination) || "我的文件"}{info.listable && info.conflicts ? `，其中 ${info.conflicts} 个文件已存在` : ""}</p>
        <Field label="同名文件" hint={CONFLICT_HINTS[conflict]}>
          <Segmented label="同名文件" value={conflict} onChange={setConflict} showLabels options={CONFLICTS} />
        </Field>
        <Switch checked={keep} onChange={setKeep} label="解压后保留压缩包"
          description={keep ? "压缩包原样保留。" : "全部文件成功解出后，压缩包移到回收站，可以还原；有文件失败时保留。"} />
        <p className="muted">解压在服务器上进行，直接写入文件空间，不占用本机磁盘；关闭窗口后继续在后台运行。</p>
      </>}
    </div>
  </Modal>;
}
