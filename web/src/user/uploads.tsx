import { useEffect, useRef, useState } from "react";

import * as api from "../api";

import { fingerprintFile, fingerprintSupported } from "../fingerprint";
import { FileTile, getFileKind, makeThumbnail, thumbnailable } from "../files";

import { Badge, Button, Icon, IconButton, Modal, Progress, Switch, copyText, formatBytes, toast } from "../ui";
import { DestinationPicker } from "./folders";

/* ---------- 上传 ---------- */

export function UploadDialog({ files, destination: initialDestination, onClose, onStart }: { files: File[]; destination: string; onClose: () => void; onStart: (files: File[], isPublic: boolean, destination: string) => void }) {
  const [list, setList] = useState(files);
  const [destination, setDestination] = useState(initialDestination);
  const [ready, setReady] = useState(true);
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [checkVersion, setCheckVersion] = useState(0);
  const [isPublic, setIsPublic] = useState(() => localStorage.getItem("tgdrive:upload-public") === "1");
  const total = list.reduce((sum, file) => sum + file.size, 0);
  const conflicts = list.filter(file => existing.has(file.name.normalize("NFC"))).length;
  useEffect(() => { if (!list.length) onClose(); }, [list.length]);
  useEffect(() => {
    let active = true;
    setChecking(true); setExisting(new Set()); setError("");
    const check = async () => {
      const found = new Set<string>();
      for (let index = 0; index < list.length; index += 200) {
        const result = await api.checkFiles(list.slice(index, index + 200).map(file => `${destination}${file.name}`));
        if (!active) return;
        result.paths.forEach(path => found.add(path.slice(destination.length)));
      }
      if (active) setExisting(found);
    };
    void check().catch(reason => { if (active) setError(api.errorMessage(reason, "无法检查目标位置，请重试")); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [destination, list, checkVersion]);
  return (
    <Modal title={`上传 ${list.length} 个文件`} description={<>上传到 <strong>{destination ? `/${destination}` : "我的文件"}</strong>，共 {formatBytes(total)}</>} icon="upload" onClose={onClose} size="md"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon="upload" disabled={!ready || checking || Boolean(error) || !list.length} onClick={() => { localStorage.setItem("tgdrive:upload-public", isPublic ? "1" : "0"); onStart(list, isPublic, destination); }}>开始上传</Button></>}>
      <DestinationPicker value={destination} onChange={next => { setReady(false); setDestination(next); setChecking(true); }} onReady={setReady} />
      <ul className="upload-pick-list">
        {list.map((file, index) => (
          <li key={`${file.name}-${index}`}>
            <FileTile kind={getFileKind(file.type, file.name)} />
            <span className="upload-pick-name">{file.name}{existing.has(file.name.normalize("NFC")) && <Badge tone="warning">将覆盖</Badge>}</span>
            <span className="muted">{formatBytes(file.size)}</span>
            <IconButton icon="x" size="sm" label={`移除 ${file.name}`} onClick={() => setList(current => current.filter((_, i) => i !== index))} />
          </li>
        ))}
      </ul>
      {checking && <p className="inline-note" role="status"><span className="spinner" />正在检查目标位置的同名文件</p>}
      {error && <div className="form-alert" role="alert"><span>{error}</span><Button size="sm" onClick={() => setCheckVersion(current => current + 1)}>重试</Button></div>}
      {conflicts > 0 && <p className="inline-note tone-warning"><Icon name="alert" size={15} />{conflicts} 个文件与现有文件同名，上传后将替换原文件，已有的公开链接保持不变。</p>}
      <div className={`share-status${isPublic ? " is-public" : ""}`}>
        <Switch checked={isPublic} onChange={setIsPublic} label="上传后公开访问"
          description={isPublic ? "每个文件都会生成独立的公开链接，任何拥有链接的人都可以查看和下载。" : "文件仅自己可见，之后可以随时单独分享。"} />
      </div>
    </Modal>
  );
}

type UploadJob = { id: string; file: File; path: string; isPublic: boolean; percent: number; status: "queued" | "uploading" | "done" | "error" | "canceled"; error?: string; result?: api.FileItem; resumed?: boolean; phase?: "hashing"; instant?: boolean };

/** 超过这个大小的文件分段上传：每段失败自动重试，网络中断或刷新页面后重新选择同一文件即可续传。 */
const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
/** 同一个大文件同时上传的分段数；服务端分段互相独立，并行可以掩盖单连接的往返延迟。 */
const PART_CONCURRENCY = 4;
/** 同时上传的文件数，小文件批量上传时不必逐个等待。 */
const FILE_CONCURRENCY = 2;
/** 小于这个大小的文件不做秒传探测：哈希加一次请求的开销比直接上传还大。 */
const INSTANT_MIN_SIZE = 1024 * 1024;
const resumeKey = (path: string, file: File) => `tgdrive:resume:${path}:${file.size}:${file.lastModified}`;
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

async function uploadMultipart(job: UploadJob, signal: { aborted: boolean; abort?: () => void },
                               onProgress: (percent: number) => void, onResumed: () => void): Promise<api.FileItem> {
  const storageKey = resumeKey(job.path, job.file);
  let uploadId = localStorage.getItem(storageKey);
  let partSize = 16 * 1024 * 1024;
  const done = new Map<number, string>();
  if (uploadId) {
    try {
      const state = await api.getUpload(uploadId);
      if (state.completed || state.path !== job.path) throw new Error("stale");
      const count = Math.ceil(job.file.size / partSize);
      for (const part of state.parts) {
        const expected = part.part_no < count ? partSize : job.file.size - partSize * (count - 1);
        if (part.size === expected) done.set(part.part_no, part.etag);
      }
      if (done.size) onResumed();
    } catch { uploadId = null; done.clear(); }
  }
  if (!uploadId) {
    const created = await api.createUpload(job.path, job.file.type || "application/octet-stream");
    uploadId = created.upload_id;
    partSize = created.part_size;
    localStorage.setItem(storageKey, uploadId);
  }
  if (signal.aborted) throw new api.ApiError("已取消上传", 0, "upload_aborted");
  const count = Math.max(1, Math.ceil(job.file.size / partSize));
  const sizeOf = (number: number) => Math.min(partSize, job.file.size - (number - 1) * partSize);
  let finished = [...done.keys()].reduce((sum, number) => sum + sizeOf(number), 0);
  const inflight = new Map<number, number>();  // 分段号 → 已发送字节
  const report = () => onProgress((finished + [...inflight.values()].reduce((sum, value) => sum + value, 0)) / job.file.size * 100);
  const aborts = new Set<() => void>();
  signal.abort = () => aborts.forEach(abort => abort());
  const todo: number[] = [];
  for (let number = 1; number <= count; number++) if (!done.has(number)) todo.push(number);
  let failure: unknown = null;

  async function uploadPart(number: number) {
    const blob = job.file.slice((number - 1) * partSize, Math.min(job.file.size, number * partSize));
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new api.ApiError("已取消上传", 0, "upload_aborted");
      const task = api.uploadPartWithProgress(uploadId!, number, blob, progress => { inflight.set(number, progress.loaded); report(); });
      aborts.add(task.abort);
      try {
        done.set(number, (await task.promise).etag);
        inflight.delete(number);
        finished += blob.size;
        report();
        return;
      } catch (reason) {
        inflight.delete(number);
        const transient = reason instanceof api.ApiError && (reason.status === 0 || reason.status >= 500) && reason.code !== "upload_aborted";
        if (!transient || attempt >= 4 || failure || signal.aborted) throw reason;
        await sleep(1000 * 2 ** attempt);  // 1、2、4、8 秒后重试
      } finally { aborts.delete(task.abort); }
    }
  }
  async function worker() {
    while (todo.length && !failure) {
      try { await uploadPart(todo.shift()!); }
      catch (reason) {
        // 一个分段彻底失败：记录首个错误并中止其余分段，已完成的分段保留用于续传。
        failure ??= reason;
        aborts.forEach(abort => abort());
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, todo.length) }, worker));
  if (signal.aborted) throw new api.ApiError("已取消上传", 0, "upload_aborted");
  if (failure) throw failure;
  const result = await api.completeUpload(uploadId, [...done.entries()].sort((a, b) => a[0] - b[0]), job.isPublic || undefined);
  localStorage.removeItem(storageKey);
  return result;
}
export type UploadQueue = ReturnType<typeof useUploadQueue>;

export function useUploadQueue(onSettled: () => void) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const queue = useRef<UploadJob[]>([]);
  const disposed = useRef(false);
  const aborters = useRef(new Map<string, () => void>());
  const canceled = useRef(new Set<string>());
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const update = (id: string, patch: Partial<UploadJob>) => { if (!disposed.current) setJobs(current => current.map(job => job.id === id ? { ...job, ...patch } : job)); };
  useEffect(() => {
    disposed.current = false;
    return () => { disposed.current = true; queue.current = []; aborters.current.forEach(abort => abort()); };
  }, []);

  const workers = useRef(0);
  const tally = useRef({ done: 0, failed: 0, instant: 0 });

  async function uploadOne(job: UploadJob) {
    update(job.id, { status: "uploading" });
    const multipart = job.file.size > MULTIPART_THRESHOLD;
    const control: { aborted: boolean; abort?: () => void } = { aborted: false };
    aborters.current.set(job.id, () => { control.aborted = true; control.abort?.(); });
    const cancelled = () => new api.ApiError("已取消上传", 0, "upload_aborted");
    let promise: Promise<api.FileItem>;
    try {
      // 先算内容指纹并向服务端探测：存储桶里已有相同内容就直接引用，不传输任何数据。
      let instant: api.FileItem | null = null;
      if (job.file.size >= INSTANT_MIN_SIZE && fingerprintSupported()) {
        update(job.id, { phase: "hashing", percent: 0 });
        try {
          const fingerprint = await fingerprintFile(job.file, fraction => update(job.id, { percent: fraction * 100 }), control);
          if (control.aborted) throw cancelled();
          const probe = await api.instantUpload(job.path, job.file.size, fingerprint, job.file.type, job.isPublic || undefined);
          if (probe.hit) instant = probe;
        } catch (reason) {
          // 指纹或探测失败不影响上传，退回普通方式；只有用户取消才中止。
          if (control.aborted) throw cancelled();
        }
        update(job.id, { phase: undefined, percent: instant ? 100 : 0 });
      }
      if (control.aborted) throw cancelled();
      if (instant) { promise = Promise.resolve(instant); update(job.id, { instant: true }); tally.current.instant++; }
      else if (multipart) promise = uploadMultipart(job, control, percent => update(job.id, { percent }), () => update(job.id, { resumed: true }));
      else {
        const task = api.uploadFileWithProgress(job.path, job.file, { isPublic: job.isPublic || undefined, onProgress: progress => update(job.id, { percent: progress.percent }) });
        control.abort = task.abort;
        promise = task.promise;
      }
    } catch (reason) {
      promise = Promise.reject(reason);
    }
    try {
      const result = await promise;
      update(job.id, { status: "done", percent: 100, result });
      tally.current.done++;
      if (!disposed.current && !result.has_thumbnail && thumbnailable(job.file.name, job.file.type, job.file.size)) {
        // 缩略图失败不影响上传结果。
        void makeThumbnail(job.file).then(data => data && !disposed.current ? api.setThumbnail(job.path, data) : undefined).then(() => { if (!disposed.current) settled.current(); }).catch(() => undefined);
      }
    } catch (reason) {
      const aborted = reason instanceof api.ApiError && reason.code === "upload_aborted";
      if (aborted && multipart) {
        // 用户主动取消：放弃服务端的分段上传，不再保留续传进度。
        const uploadId = localStorage.getItem(resumeKey(job.path, job.file));
        localStorage.removeItem(resumeKey(job.path, job.file));
        if (uploadId) void api.abortUpload(uploadId).catch(() => undefined);
      }
      update(job.id, { status: aborted ? "canceled" : "error",
        error: multipart && !aborted ? `${api.errorMessage(reason, "上传失败，请稍后重试")}。进度已保存，重新上传同一文件即可继续。` : api.errorMessage(reason, "上传失败，请稍后重试") });
      if (!aborted) tally.current.failed++;
    } finally { aborters.current.delete(job.id); canceled.current.delete(job.id); }
    if (!disposed.current) settled.current();
  }

  async function worker() {
    while (queue.current.length) {
      const job = queue.current.shift()!;
      if (canceled.current.delete(job.id)) continue;
      await uploadOne(job);
    }
    if (--workers.current > 0) return;
    const { done, failed, instant } = tally.current;
    tally.current = { done: 0, failed: 0, instant: 0 };
    if (disposed.current) return;
    if (failed) toast.error(`${failed} 个文件上传失败，可在上传列表中查看原因`);
    else if (done) toast.success(instant === done ? (done === 1 ? "秒传完成" : `${done} 个文件秒传完成`) : `${done === 1 ? "上传完成" : `${done} 个文件上传完成`}${instant ? `（其中 ${instant} 个秒传）` : ""}`);
  }
  function run() {
    while (workers.current < FILE_CONCURRENCY && queue.current.length > 0) {
      workers.current++;
      void worker();
    }
  }
  function enqueue(items: { file: File; path: string; isPublic: boolean }[]) {
    const next = items.map(item => ({ ...item, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, percent: 0, status: "queued" as const }));
    queue.current.push(...next);
    setJobs(current => [...current.filter(job => job.status === "queued" || job.status === "uploading"), ...next]);
    run();
  }
  function cancel(id: string) {
    canceled.current.add(id);
    aborters.current.get(id)?.();
    setJobs(current => current.map(job => job.id === id && job.status === "queued" ? { ...job, status: "canceled" } : job));
  }
  function cancelAll() {
    queue.current = [];
    canceled.current.clear();
    aborters.current.forEach(abort => abort());
    setJobs(current => current.map(job => job.status === "queued" ? { ...job, status: "canceled" } : job));
  }
  function clear() { setJobs(current => current.filter(job => job.status === "queued" || job.status === "uploading")); }
  return { jobs, enqueue, cancel, cancelAll, clear };
}

export function UploadTray({ queue }: { queue: UploadQueue }) {
  const [collapsed, setCollapsed] = useState(false);
  const { jobs } = queue;
  if (!jobs.length) return null;
  const active = jobs.filter(job => job.status === "queued" || job.status === "uploading").length;
  const failed = jobs.filter(job => job.status === "error").length;
  const canceledCount = jobs.filter(job => job.status === "canceled").length;
  const completed = jobs.filter(job => job.status === "done").length;
  const allCanceled = canceledCount === jobs.length;
  const overall = jobs.reduce((sum, job) => sum + (job.status === "done" ? 100 : job.percent), 0) / jobs.length;
  const title = active ? `正在上传 ${jobs.length - active + 1}/${jobs.length}` : failed ? `${failed} 个文件上传失败` : allCanceled ? "上传已取消" : canceledCount ? `${completed} 个完成，${canceledCount} 个已取消` : "上传完成";
  return (
    <aside className={`upload-tray${collapsed ? " is-collapsed" : ""}`} aria-label="上传进度" aria-live="polite">
      <header>
        <span className={`tray-status${active ? " is-active" : failed ? " is-error" : allCanceled ? "" : " is-done"}`}><Icon name={active ? "upload" : failed ? "alert" : allCanceled ? "x" : "check"} size={16} /></span>
        <strong>{title}</strong>
        <IconButton icon="chevronDown" size="sm" label={collapsed ? "展开" : "收起"} onClick={() => setCollapsed(value => !value)} />
        {!active && <IconButton icon="x" size="sm" label="关闭上传列表" onClick={queue.clear} />}
      </header>
      {active > 0 && <Progress value={overall} label="总体进度" />}
      {!collapsed && (
        <ul>
          {jobs.map(job => (
            <li key={job.id}>
              <FileTile kind={getFileKind(job.file.type, job.file.name)} />
              <div className="tray-job">
                <span className="tray-name">{job.file.name}{job.isPublic && <Icon name="globe" size={13} className="tray-public" />}{job.resumed && <Badge tone="accent">续传</Badge>}{job.instant && <Badge tone="success">秒传</Badge>}</span>
                {job.status === "uploading" || job.status === "queued" ? <Progress value={job.percent} label={`${job.file.name} 上传进度`} />
                  : <small className={job.status === "error" ? "tone-danger" : "muted"}>{job.status === "done" ? formatBytes(job.file.size) : job.status === "canceled" ? "已取消" : job.error}</small>}
              </div>
              <span className="tray-right">
                {job.status === "uploading" && <small className="muted">{job.phase === "hashing" ? `检查中 ${Math.round(job.percent)}%` : job.percent >= 100 ? "处理中" : `${Math.round(job.percent)}%`}</small>}
                {job.status === "queued" && <small className="muted">等待中</small>}
                {(job.status === "uploading" || job.status === "queued") && <IconButton icon="x" size="sm" label={`取消上传 ${job.file.name}`} onClick={() => queue.cancel(job.id)} />}
                {job.status === "done" && job.result?.public_token && <IconButton icon="copy" size="sm" label="复制分享链接" onClick={() => void copyText(api.publicLinks(job.result!.public_token!, job.file.name).page, "分享链接已复制")} />}
                {job.status === "done" && !job.result?.public_token && <Icon name="check" size={16} className="tone-success" />}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
