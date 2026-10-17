import { useEffect, useRef, useState } from "react";

import * as api from "../api";

import { fingerprintFile, fingerprintSupported } from "../fingerprint";
import { FileTile, getFileKind } from "../files";
import { createThumbnails, generateLoadedThumbnails, thumbnailSource } from "../thumbnails";

import { Badge, Button, Icon, IconButton, Modal, Switch, copyText, formatBytes, toast } from "../ui";
import { DestinationPicker } from "./folders";
import { TrayBar, TrayRing, type TrayState } from "./tray";

/* ---------- 上传 ---------- */

export function UploadDialog({ files, destination: initialDestination, onClose, onStart }: { files: File[]; destination: string; onClose: () => void; onStart: (files: File[], isPublic: boolean, destination: string) => void }) {
  const privateSpace = api.isPrivatePath(initialDestination);
  const [list, setList] = useState(files);
  const [destination, setDestination] = useState(initialDestination);
  const [ready, setReady] = useState(true);
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [checkVersion, setCheckVersion] = useState(0);
  const [isPublic, setIsPublic] = useState(() => !privateSpace && localStorage.getItem("tgdrive:upload-public") === "1");
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
    <Modal title={`上传 ${list.length} 个文件`} description={<>上传到 <strong>{api.privatePathLabel(destination)}</strong>，共 {formatBytes(total)}</>} icon="upload" onClose={onClose} size="md" className={privateSpace ? "private-dialog" : ""}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon="upload" disabled={!ready || checking || Boolean(error) || !list.length} onClick={() => { if (!privateSpace) localStorage.setItem("tgdrive:upload-public", isPublic ? "1" : "0"); onStart(list, isPublic, destination); }}>开始上传</Button></>}>
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
      {!privateSpace && <div className={`share-status${isPublic ? " is-public" : ""}`}>
        <Switch checked={isPublic} onChange={setIsPublic} label="上传后公开访问"
          description={isPublic ? "每个文件都会生成独立的公开链接，任何拥有链接的人都可以查看和下载。" : "文件仅自己可见，之后可以随时单独分享。"} />
      </div>}
    </Modal>
  );
}

type UploadJob = { id: string; file: File; path: string; isPublic: boolean; percent: number; status: "queued" | "uploading" | "done" | "error" | "canceled"; error?: string; result?: api.FileItem; resumed?: boolean; phase?: "hashing"; instant?: boolean; completedAt?: number };

/** 超过这个大小的文件分段上传：每段失败自动重试，网络中断或刷新页面后重新选择同一文件即可续传。 */
const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
/** 上传并发由管理员在「下载与资源」配置：parts 是同一个大文件同时上传的分段数（并行可以掩盖单连接的往返延迟），
 *  files 是同时上传的文件数。读取失败时沿用上次的值；每分钟最多读取一次，开始上传时刷新。 */
const uploadLimits = { parts: 4, files: 2, loadedAt: 0 };
async function refreshUploadLimits() {
  if (Date.now() - uploadLimits.loadedAt < 60_000) return;
  uploadLimits.loadedAt = Date.now();
  try {
    const config = await api.uploadConfig();
    uploadLimits.parts = Math.max(1, Math.min(8, config.part_concurrency));
    uploadLimits.files = Math.max(1, Math.min(4, config.file_concurrency));
  } catch { /* 沿用当前值 */ }
}
/** 小于这个大小的文件不做秒传探测：哈希加一次请求的开销比直接上传还大。 */
const INSTANT_MIN_SIZE = 1024 * 1024;
/** 成功反馈留出查看大小、复制分享链接的时间，再逐项收起。 */
const COMPLETED_VISIBLE_MS = 8000;
const resumeKey = (path: string, file: File) => `tgdrive:resume:${path}:${file.size}:${file.lastModified}`;
const privateResumes = new Map<string, string>();
const readResume = (key: string) => key.includes(`:${api.PRIVATE_PREFIX}`) ? privateResumes.get(key) ?? null : localStorage.getItem(key);
const writeResume = (key: string, value: string) => { if (key.includes(`:${api.PRIVATE_PREFIX}`)) privateResumes.set(key, value); else localStorage.setItem(key, value); };
const removeResume = (key: string) => { privateResumes.delete(key); if (!key.includes(`:${api.PRIVATE_PREFIX}`)) localStorage.removeItem(key); };
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

async function uploadMultipart(job: UploadJob, signal: { aborted: boolean; abort?: () => void },
                               onProgress: (percent: number) => void, onResumed: () => void): Promise<api.FileItem> {
  const storageKey = resumeKey(job.path, job.file);
  let uploadId = readResume(storageKey);
  let partSize = 16 * 1024 * 1024;
  const done = new Map<number, string>();
  if (uploadId) {
    try {
      const state = await api.getUpload(uploadId, job.path);
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
    writeResume(storageKey, uploadId);
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
      const task = api.uploadPartWithProgress(uploadId!, number, blob, progress => { inflight.set(number, progress.loaded); report(); }, job.path);
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
  await Promise.all(Array.from({ length: Math.min(uploadLimits.parts, todo.length) }, worker));
  if (signal.aborted) throw new api.ApiError("已取消上传", 0, "upload_aborted");
  if (failure) throw failure;
  const result = await api.completeUpload(uploadId, [...done.entries()].sort((a, b) => a[0] - b[0]), job.isPublic || undefined, job.path);
  removeResume(storageKey);
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
  useEffect(() => {
    const completed = jobs.filter(job => job.status === "done" && job.completedAt != null);
    if (!completed.length) return;
    const expires = Math.min(...completed.map(job => job.completedAt! + COMPLETED_VISIBLE_MS));
    const timer = window.setTimeout(() => setJobs(current => current.filter(job =>
      job.status !== "done" || job.completedAt == null || job.completedAt + COMPLETED_VISIBLE_MS > Date.now())), Math.max(0, expires - Date.now()));
    return () => window.clearTimeout(timer);
  }, [jobs]);

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
      update(job.id, { status: "done", percent: 100, result, completedAt: Date.now() });
      tally.current.done++;
      const source = thumbnailSource(job.file.name, job.file.type, job.file.size);
      if (!disposed.current && !result.thumbnails?.length && source) {
        // 用本地文件生成缩略图（图片缩放、视频截帧、音频封面），不需要再下载；失败不影响上传结果。
        void generateLoadedThumbnails(result, signal => createThumbnails({ file: job.file, signal }, source))
          .then(() => { if (!disposed.current) settled.current(); }).catch(() => undefined);
      }
    } catch (reason) {
      const aborted = reason instanceof api.ApiError && reason.code === "upload_aborted";
      if (aborted && multipart) {
        // 用户主动取消：放弃服务端的分段上传，不再保留续传进度。
        const uploadId = readResume(resumeKey(job.path, job.file));
        removeResume(resumeKey(job.path, job.file));
        if (uploadId) void api.abortUpload(uploadId, job.path).catch(() => undefined);
      }
      update(job.id, { status: aborted ? "canceled" : "error",
        error: multipart && !aborted ? `${api.errorMessage(reason, "上传失败，请稍后重试")}。进度已保存，点击重试即可继续。` : api.errorMessage(reason, "上传失败，请稍后重试") });
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
    if (failed) toast.error(`${failed} 个文件上传失败，可在上传列表中重试`);
    else if (done) toast.success(instant === done ? (done === 1 ? "秒传完成" : `${done} 个文件秒传完成`) : `${done === 1 ? "上传完成" : `${done} 个文件上传完成`}${instant ? `（其中 ${instant} 个秒传）` : ""}`);
  }
  function run() {
    while (workers.current < uploadLimits.files && queue.current.length > 0) {
      workers.current++;
      void worker();
    }
  }
  function enqueue(items: { file: File; path: string; isPublic: boolean }[]) {
    const next = items.map(item => ({ ...item, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, percent: 0, status: "queued" as const }));
    queue.current.push(...next);
    setJobs(current => [...current, ...next]);
    // 先按当前值开始；读到管理员的新配置后，若允许更多文件同时上传就补上。
    run();
    void refreshUploadLimits().then(run);
  }
  function retry(id: string) {
    const failed = jobs.find(job => job.id === id && job.status === "error");
    if (!failed || aborters.current.has(id) || queue.current.some(job => job.id === id)) return;
    // 保留原始 File 与目标路径，分段上传沿用原来的续传记录。
    const next: UploadJob = { id, file: failed.file, path: failed.path, isPublic: failed.isPublic, percent: 0, status: "queued" };
    setJobs(current => current.map(job => job.id === id ? next : job));
    queue.current.push(next);
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
  function cancelPrivate() {
    queue.current = queue.current.filter(job => !api.isPrivatePath(job.path));
    jobs.filter(job => api.isPrivatePath(job.path)).forEach(job => { canceled.current.add(job.id); aborters.current.get(job.id)?.(); });
    privateResumes.clear();
    setJobs(current => current.filter(job => !api.isPrivatePath(job.path)));
  }
  function clear() { setJobs(current => current.filter(job => job.status === "queued" || job.status === "uploading")); }
  return { jobs, enqueue, retry, cancel, cancelAll, cancelPrivate, clear };
}

export function UploadTray({ queue }: { queue: UploadQueue }) {
  const [collapsed, setCollapsed] = useState(false);
  const { jobs } = queue;
  useEffect(() => { if (!jobs.length) setCollapsed(false); }, [jobs.length]);
  if (!jobs.length) return null;
  const active = jobs.filter(job => job.status === "queued" || job.status === "uploading").length;
  const failed = jobs.filter(job => job.status === "error").length;
  const canceledCount = jobs.filter(job => job.status === "canceled").length;
  const completed = jobs.filter(job => job.status === "done").length;
  const allCanceled = canceledCount === jobs.length;
  // 总进度按字节计算，大文件不会被一堆小文件的“已完成”冲淡。
  const counted = jobs.filter(job => job.status !== "canceled");
  const totalBytes = counted.reduce((sum, job) => sum + job.file.size, 0);
  const sentBytes = counted.reduce((sum, job) => sum + job.file.size * (job.status === "done" ? 1 : job.status === "error" ? 0 : job.percent / 100), 0);
  const overall = totalBytes ? sentBytes / totalBytes * 100 : counted.length ? counted.filter(job => job.status === "done").length / counted.length * 100 : 0;
  const state: TrayState = active ? "active" : failed ? "error" : allCanceled ? "idle" : "done";
  const title = active ? `正在上传 ${active} 个文件` : failed ? `${failed} 个文件上传失败` : allCanceled ? "上传已取消" : "上传完成";
  const subtitle = active ? `${formatBytes(sentBytes)} / ${formatBytes(totalBytes)} · ${Math.floor(overall)}%`
    : failed ? `${completed} 个已完成，可逐个重试` : allCanceled ? `${canceledCount} 个文件` : `${completed} 个文件 · ${formatBytes(totalBytes)}${canceledCount ? ` · ${canceledCount} 个已取消` : ""}`;
  return (
    <aside className={`upload-tray is-${state}${collapsed ? " is-collapsed" : ""}`} aria-label="上传进度" aria-live="polite">
      <header>
        <TrayRing state={state} percent={overall} icon="upload" />
        <div className="tray-heading"><strong>{title}</strong><small>{subtitle}</small></div>
        <IconButton icon="chevronDown" size="sm" label={collapsed ? "展开" : "收起"} onClick={() => setCollapsed(value => !value)} />
        {!active && <IconButton icon="x" size="sm" label="关闭上传列表" onClick={queue.clear} />}
      </header>
      {!collapsed && (
        <ul>
          {jobs.map(job => {
            const running = job.status === "uploading" || job.status === "queued";
            const detail = job.status === "queued" ? `等待上传 · ${formatBytes(job.file.size)}`
              : job.status === "uploading" ? job.phase === "hashing" ? `检查是否可秒传 · ${Math.round(job.percent)}%` : job.percent >= 100 ? "正在保存…" : `${formatBytes(job.file.size * job.percent / 100)} / ${formatBytes(job.file.size)}`
              : job.status === "done" ? `${formatBytes(job.file.size)}${job.instant ? " · 秒传" : job.resumed ? " · 续传完成" : ""}` : job.status === "canceled" ? "已取消" : job.error;
            return <li key={job.id} className={`tray-item is-${job.status}`}>
              <span className="tray-icon"><FileTile kind={getFileKind(job.file.type, job.file.name)} />
                {(job.status === "done" || job.status === "error") && <span className="tray-badge"><Icon name={job.status === "done" ? "check" : "alert"} size={10} /></span>}</span>
              <div className="tray-job">
                <span className="tray-name" title={job.file.name}><span>{job.file.name}</span>{job.isPublic && <Icon name="globe" size={13} className="tray-public" />}{job.resumed && running && <Badge tone="accent">续传</Badge>}</span>
                <small className={job.status === "error" ? "tone-danger" : "muted"}>{detail}</small>
                {running && <TrayBar percent={job.status === "queued" ? 0 : job.percent} paused={job.status === "queued"} label={`${job.file.name} 上传进度`} />}
              </div>
              <span className="tray-right">
                {job.status === "uploading" && job.phase !== "hashing" && job.percent < 100 && <span className="tray-percent">{Math.floor(job.percent)}%</span>}
                {running && <IconButton icon="x" size="sm" label={`取消上传 ${job.file.name}`} onClick={() => queue.cancel(job.id)} />}
                {job.status === "error" && <Button size="sm" icon="refresh" aria-label={`重试上传 ${job.file.name}`} onClick={() => queue.retry(job.id)}>重试</Button>}
                {job.status === "done" && job.result?.public_token && <IconButton icon="copy" size="sm" label="复制分享链接" onClick={() => void copyText(api.publicLinks(job.result!.public_token!, job.file.name).page, "分享链接已复制")} />}
              </span>
            </li>;
          })}
        </ul>
      )}
    </aside>
  );
}
