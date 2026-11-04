import { useEffect, useState } from "react";
import * as api from "../api";
import { baseName, parentPath } from "../files";
import { Button, Field, KeyValue, Modal, Notice, Progress, Segmented, formatBytes, toast } from "../ui";
import { FolderPicker } from "./folders";

const ACTIVE = new Set(["queued", "running"]);
const watched = new Set<string>();

/** 压缩包默认名：单项用它自己的名字，多项用所在文件夹的名字。 */
export function compressName(keys: string[]) {
  if (keys.length === 1) return baseName(keys[0]).replace(/\.[^./]{1,10}$/, "") || "压缩包";
  const parent = parentPath(keys[0]);
  return (parent && parent !== api.PRIVATE_PREFIX ? baseName(parent) : "") || "压缩包";
}

function announce(job: api.ArchiveJob) {
  window.dispatchEvent(new CustomEvent("tessera:files-added", { detail: { folders: [job.destination] } }));
}
/** 关闭对话框后在后台跟踪：结束时提示，并让压缩包所在的文件夹刷新。 */
function watchJob(job: api.ArchiveJob, onOpen?: (folder: string) => void) {
  if (watched.has(job.id)) return;
  watched.add(job.id);
  const tick = async () => {
    let current = job;
    try { current = (await api.archiveJobs([job.id], job.private)).jobs[0] ?? job; } catch { /* 下次再查 */ }
    if (ACTIVE.has(current.status)) { window.setTimeout(() => void tick(), 2000); return; }
    watched.delete(job.id);
    announce(current);
    const name = baseName(current.archive);
    if (current.status === "completed") toast.success(`已生成「${name}」`, onOpen ? { label: "打开", onClick: () => onOpen(current.destination) } : undefined);
    else if (current.status === "failed") toast.error(`「${name}」压缩失败：${current.error}`);
  };
  window.setTimeout(() => void tick(), 2000);
}

/** 在线压缩：选中的文件与文件夹在服务器上边读边打包成 ZIP，直接保存到网盘，不经过本机。 */
export function CompressDialog({ keys, onClose, onOpenFolder }: { keys: string[]; onClose: () => void; onOpenFolder?: (folder: string) => void }) {
  const parent = parentPath(keys[0]);
  const [name, setName] = useState(() => compressName(keys));
  const [place, setPlace] = useState<"here" | "other">("here");
  const [other, setOther] = useState(parent);
  const [otherReady, setOtherReady] = useState(true);
  const [compression, setCompression] = useState<"deflate" | "store">("deflate");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState<api.ArchiveJob | null>(null);
  const destination = place === "here" ? parent : other;
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
    if (job && ACTIVE.has(job.status)) { watchJob(job, onOpenFolder); toast.info("压缩在后台继续，完成后会提示"); }
    onClose();
  };
  const trimmed = name.trim().replace(/\.zip$/i, "");
  const nameError = !trimmed ? "请填写压缩包名称" : /[\\/]/.test(trimmed) ? "名称不能包含 / 或 \\" : new TextEncoder().encode(trimmed).length > 200 ? "名称太长" : "";
  async function start() {
    if (nameError) return;
    setBusy(true); setError("");
    try { setJob(await api.compressFiles(keys, { name: `${trimmed}.zip`, destination, compression })); }
    catch (reason) { setError(api.errorMessage(reason, "无法开始压缩")); }
    finally { setBusy(false); }
  }

  if (job) {
    const active = ACTIVE.has(job.status);
    const percent = job.total_bytes ? job.done_bytes / job.total_bytes * 100 : 0;
    const title = job.status === "completed" ? "压缩完成" : job.status === "failed" ? "压缩失败" : job.status === "cancelled" ? "已取消压缩" : "正在压缩";
    return <Modal title={title} icon="archive" description={baseName(job.archive)} onClose={close} dismissible={!active}
      footer={active ? <><Button onClick={() => void api.cancelArchiveJob(job.id, job.private).then(setJob, reason => toast.error(api.errorMessage(reason, "取消失败")))}>取消压缩</Button><Button variant="primary" onClick={close}>后台运行</Button></>
        : <>{onOpenFolder && job.status === "completed" && <Button onClick={() => { onClose(); onOpenFolder(job.destination); }}>打开文件夹</Button>}<Button variant="primary" onClick={onClose}>完成</Button></>}>
      <div className="extract-progress">
        {active && <Progress value={percent} label="压缩进度" />}
        {active && <p className="muted extract-current" title={job.current}>{job.status === "queued" ? "排队中…" : job.current ? `正在压缩 ${job.current}` : "正在准备…"}</p>}
        {job.error && <Notice tone="danger">{job.error}</Notice>}
        <KeyValue items={[
          ["已压缩", `${job.done_files} / ${job.total_files ?? 0} 个文件 · ${formatBytes(job.done_bytes)}${job.total_bytes ? ` / ${formatBytes(job.total_bytes)}` : ""}`],
          ...(job.read_bytes ? [["压缩包大小", formatBytes(job.read_bytes)] as [string, string]] : []),
          ["保存为", api.privatePathLabel(job.archive) || baseName(job.archive)],
        ]} />
      </div>
    </Modal>;
  }

  return <Modal title="压缩为 ZIP" icon="archive" description={keys.length === 1 ? baseName(keys[0]) : `${keys.length} 项`} size="md" onClose={onClose} dismissible={!busy}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={Boolean(nameError) || place === "other" && !otherReady} onClick={() => void start()}>开始压缩</Button></>}>
    <div className="extract-form">
      {error && <Notice tone="danger">{error}</Notice>}
      <Field label="压缩包名称" error={name && nameError ? nameError : undefined}>
        <div className="input-affix"><input className="input" value={name} maxLength={200} autoFocus onChange={event => setName(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") void start(); }} /><span className="muted">.zip</span></div>
      </Field>
      <Field label="压缩方式" hint={compression === "deflate" ? "Deflate 压缩，文档、代码等能明显变小；图片、视频、压缩包本身已经压缩过，几乎不会变小。" : "只打包不压缩，速度最快，大小约等于原文件之和。"}>
        <Segmented label="压缩方式" value={compression} onChange={setCompression} showLabels options={[{ value: "deflate", label: "压缩" }, { value: "store", label: "仅打包" }]} />
      </Field>
      <Field label="保存到">
        <Segmented label="保存到" value={place} onChange={setPlace} showLabels options={[{ value: "here", label: "当前文件夹" }, { value: "other", label: "其他位置" }]} />
      </Field>
      {place === "other" && <div className="extract-picker"><FolderPicker value={other} onChange={setOther} onReady={setOtherReady} /></div>}
      <p className="muted extract-destination">保存到 {api.privatePathLabel(destination) || "我的文件"}；已有同名压缩包时自动改名。</p>
      <p className="muted">压缩在服务器上进行，直接写入文件空间，不占用本机磁盘；关闭窗口后继续在后台运行。</p>
    </div>
  </Modal>;
}
