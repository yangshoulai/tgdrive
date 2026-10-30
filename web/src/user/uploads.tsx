import { useEffect, useMemo, useRef, useState } from "react";

import * as api from "../api";

import { fingerprintFile, fingerprintSupported } from "../fingerprint";
import { FileTile, FileVisual, baseName, getFileKind } from "../files";
import { createThumbnails, generateLoadedThumbnails, thumbnailSource } from "../thumbnails";

import { BRAND } from "../brand";
import { Notice, Badge, Button, Checkbox, ConfirmDialog, EmptyState, Icon, IconButton, Menu, Modal, PageHeader, Progress, Switch, copyText, formatBytes, toast, useDocumentTitle } from "../ui";
import { DestinationPicker } from "./folders";
import { LocationText, TaskControls, TaskListFooter, TaskStats, remainingText, useTaskList, useTransferRates, type TaskFilter } from "./task-list";
import { UploadPicker, UploadSelection, uploadFiles, type UploadFile } from "./upload-selection";

/* ---------- 上传 ---------- */

export function UploadDialog({ files, destination: initialDestination, onClose, onStart }: { files: UploadFile[]; destination: string; onClose: () => void; onStart: (files: UploadFile[], isPublic: boolean, destination: string) => void }) {
  const privateSpace = api.isPrivatePath(initialDestination);
  const [selected, setSelected] = useState(() => new Set(files.map(item => item.path)));
  const list = useMemo(() => files.filter(item => selected.has(item.path)), [files, selected]);
  const [destination, setDestination] = useState(initialDestination);
  const [ready, setReady] = useState(true);
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [checkVersion, setCheckVersion] = useState(0);
  const [isPublic, setIsPublic] = useState(() => !privateSpace && localStorage.getItem("tgdrive:upload-public") === "1");
  const hasFolders = files.some(item => item.path.includes("/"));
  const hasLooseFiles = files.some(item => !item.path.includes("/"));
  const total = list.reduce((sum, item) => sum + item.file.size, 0);
  const conflicts = list.filter(item => existing.has(item.path)).length;
  useEffect(() => {
    let active = true;
    setChecking(true); setExisting(new Set()); setError("");
    const check = async () => {
      // 根目录的保留名称不能让路径自动路由把普通上传误送进私密接口。
      if (!privateSpace && list.some(item => {
        const path = `${destination}${item.path}`;
        return path === ".tgdrive" || path.startsWith(".tgdrive/");
      })) throw new Error("“.tgdrive”在此位置不可用，请更改目标位置或取消勾选该项");
      const found = new Set<string>();
      for (let index = 0; index < list.length; index += 200) {
        if (!active) return;
        const result = await api.checkFiles(list.slice(index, index + 200).map(item => `${destination}${item.path}`));
        if (!active) return;
        result.paths.forEach(path => found.add(path.slice(destination.length)));
      }
      if (active) setExisting(found);
    };
    void check().catch(reason => { if (active) setError(api.errorMessage(reason, "无法检查目标位置，请重试")); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [destination, list, checkVersion, privateSpace]);
  return (
    <Modal title="确认上传" description={<>已选 {list.length} / {files.length} 个文件，共 {formatBytes(total)}</>} icon="upload" onClose={onClose} size="lg" className={`upload-dialog${privateSpace ? " private-dialog" : ""}`}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon="upload" disabled={!ready || checking || Boolean(error) || !list.length} onClick={() => { if (!privateSpace) localStorage.setItem("tgdrive:upload-public", isPublic ? "1" : "0"); onStart(list, isPublic, destination); }}>开始上传</Button></>}>
      <DestinationPicker value={destination} onChange={next => { setReady(false); setDestination(next); setChecking(true); }} onReady={setReady} />
      <UploadSelection files={files} selected={selected} onChange={setSelected} existing={existing} />
      {checking && <Notice icon={false} role="status"><span className="spinner" />正在检查目标位置的同名文件</Notice>}
      {error && <Notice tone="danger"><span>{error}</span><Button size="sm" onClick={() => setCheckVersion(current => current + 1)}>重试</Button></Notice>}
      {conflicts > 0 && <Notice tone="warning">{conflicts} 个文件与现有文件同名，上传后将替换原文件，已有的公开链接保持不变。</Notice>}
      {!privateSpace && <div className={`share-status${isPublic ? " is-public" : ""}`}>
        <Switch checked={isPublic} onChange={setIsPublic} label={hasFolders ? hasLooseFiles ? "上传后公开所选项目" : "上传后公开文件夹" : "上传后公开访问"}
          description={hasFolders ? isPublic
            ? `${hasLooseFiles ? "文件夹生成目录分享链接，单独选择的文件分别生成文件链接。" : "全部所选文件上传成功后，为顶层文件夹生成分享链接，可浏览其中的文件与子文件夹。"}同名文件夹中的已有内容也会一并公开。`
            : "上传后可以在文件或文件夹菜单中管理公开分享。"
            : isPublic ? "每个文件都会生成独立的公开链接，任何拥有链接的人都可以查看和下载。" : "文件仅自己可见，之后可以随时单独分享。"} />
      </div>}
    </Modal>
  );
}

type UploadJob = { id: string; file: File; path: string; isPublic: boolean; folderShare?: string; percent: number; status: "queued" | "uploading" | "done" | "error" | "canceled"; error?: string; result?: api.FileItem; resumed?: boolean; phase?: "hashing" | "waiting"; instant?: boolean; addedAt: number; startedAt?: number; completedAt?: number };
type FolderShare = { id: string; path: string; total: number; uploaded: number; status: "waiting" | "sharing" | "done" | "error" | "canceled"; result?: api.FileItem; error?: string; completedAt?: number };
type FolderShareWork = { path: string; remaining: Set<string>; total: number; canceled: boolean; publishing: boolean };

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
// 秒传探测的最小文件：照片多在 1 MiB 以下，也要能复用已有内容与缩略图；更小的文件多一次请求不划算，由服务端写入后合并兜底。
const INSTANT_MIN_SIZE = 64 * 1024;
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
  const [folderShares, setFolderShares] = useState<FolderShare[]>([]);
  const folderGroups = useRef(new Map<string, FolderShareWork>());
  const queue = useRef<UploadJob[]>([]);
  const disposed = useRef(false);
  const aborters = useRef(new Map<string, () => void>());
  const canceled = useRef(new Set<string>());
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const update = (id: string, patch: Partial<UploadJob>) => { if (!disposed.current) setJobs(current => current.map(job => job.id === id ? { ...job, ...patch } : job)); };
  const updateFolder = (id: string, patch: Partial<FolderShare>) => { if (!disposed.current) setFolderShares(current => current.map(folder => folder.id === id ? { ...folder, ...patch } : folder)); };
  useEffect(() => {
    disposed.current = false;
    return () => { disposed.current = true; queue.current = []; folderGroups.current.clear(); aborters.current.forEach(abort => abort()); };
  }, []);

  const workers = useRef(0);
  const tally = useRef({ done: 0, failed: 0, instant: 0 });
  /** 同一批里内容相同的文件：第一个正常上传，其余等它结束后再探测秒传，避免并行上传出两份数据和两套缩略图。 */
  const sameContent = useRef(new Map<string, Promise<void>>());

  async function publishFolder(id: string) {
    const folder = folderGroups.current.get(id);
    if (disposed.current || !folder || folder.remaining.size || folder.canceled || folder.publishing) return;
    folder.publishing = true;
    updateFolder(id, { status: "sharing", error: undefined });
    try {
      const result = (await api.setPublic([folder.path], true)).objects[0];
      if (!result?.public_token) throw new Error("未能取得文件夹分享链接，请重试");
      updateFolder(id, { status: "done", result, completedAt: Date.now() });
    } catch (reason) {
      updateFolder(id, { status: "error", error: api.errorMessage(reason, "文件已上传，但公开失败，请重试") });
      if (!disposed.current) toast.error("文件已上传，但文件夹公开失败，可在上传列表中重试公开");
    } finally {
      folder.publishing = false;
      if (!disposed.current) settled.current();
    }
  }

  async function uploadOne(job: UploadJob) {
    update(job.id, { status: "uploading", startedAt: Date.now() });
    const multipart = job.file.size > MULTIPART_THRESHOLD;
    const control: { aborted: boolean; abort?: () => void } = { aborted: false };
    aborters.current.set(job.id, () => { control.aborted = true; control.abort?.(); });
    const cancelled = () => new api.ApiError("已取消上传", 0, "upload_aborted");
    let promise: Promise<api.FileItem>;
    const same = { release: () => {} };
    try {
      // 先算内容指纹并向服务端探测：存储桶里已有相同内容就直接引用，不传输任何数据。
      let instant: api.FileItem | null = null;
      if (job.file.size >= INSTANT_MIN_SIZE && fingerprintSupported()) {
        update(job.id, { phase: "hashing", percent: 0 });
        try {
          const fingerprint = await fingerprintFile(job.file, fraction => update(job.id, { percent: fraction * 100 }), control);
          if (control.aborted) throw cancelled();
          const probe = () => api.instantUpload(job.path, job.file.size, fingerprint, job.file.type, job.isPublic || undefined);
          let result = await probe();
          const identity = `${job.file.size}:${fingerprint}`;
          while (!result.hit && sameContent.current.has(identity)) {
            // 同批相同内容的文件正在上传：等它结束（成功或失败）后再探测，命中就直接秒传。
            update(job.id, { phase: "waiting" });
            const gate = sameContent.current.get(identity)!;
            await new Promise<void>(resolve => { control.abort = resolve; void gate.then(resolve); });
            control.abort = undefined;
            if (control.aborted) throw cancelled();
            result = await probe();
          }
          if (result.hit) instant = result;
          else {
            let open = () => {};
            const gate = new Promise<void>(resolve => { open = resolve; });
            sameContent.current.set(identity, gate);
            same.release = () => { if (sameContent.current.get(identity) === gate) sameContent.current.delete(identity); open(); };
          }
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
      if (job.folderShare && !control.aborted) {
        const folder = folderGroups.current.get(job.folderShare);
        if (folder) {
          folder.remaining.delete(job.id);
          updateFolder(job.folderShare, { uploaded: folder.total - folder.remaining.size });
          // 完成数独立于托盘里暂留的成功行，失败后重试也能等齐原来选择的全部文件。
          if (!folder.remaining.size) void publishFolder(job.folderShare);
        }
      }
      const source = thumbnailSource(job.file.name, job.file.type, job.file.size);
      if (!disposed.current && !result.thumbnails?.length && result.thumbnail_status !== "unavailable" && source) {
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
    } finally { aborters.current.delete(job.id); canceled.current.delete(job.id); same.release(); }
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
  function enqueue(items: { file: File; path: string; isPublic: boolean; publicFolder?: string }[]) {
    const folders = new Map<string, string>();
    const next = items.map(({ publicFolder, ...item }) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (api.isPrivatePath(item.path)) publicFolder = undefined;
      let folderShare: string | undefined;
      if (publicFolder) {
        folderShare = folders.get(publicFolder);
        if (!folderShare) {
          folderShare = `folder-${id}`;
          folders.set(publicFolder, folderShare);
          folderGroups.current.set(folderShare, { path: publicFolder, remaining: new Set(), total: 0, canceled: false, publishing: false });
        }
        const folder = folderGroups.current.get(folderShare)!;
        folder.remaining.add(id); folder.total++;
      }
      return { ...item, isPublic: !api.isPrivatePath(item.path) && !publicFolder && item.isPublic, folderShare, id, percent: 0, status: "queued" as const, addedAt: Date.now() };
    });
    const shares = [...folders].map(([path, id]) => ({ id, path, total: folderGroups.current.get(id)!.total, uploaded: 0, status: "waiting" as const }));
    setFolderShares(current => [...current, ...shares]);
    queue.current.push(...next);
    setJobs(current => [...current, ...next]);
    // 先按当前值开始；读到管理员的新配置后，若允许更多文件同时上传就补上。
    run();
    void refreshUploadLimits().then(run);
  }
  function retry(id: string) {
    const failed = jobs.find(job => job.id === id && (job.status === "error" || job.status === "canceled"));
    if (!failed || aborters.current.has(id) || queue.current.some(job => job.id === id)) return;
    // 保留原始 File 与目标路径，分段上传沿用原来的续传记录。
    const next: UploadJob = { id, file: failed.file, path: failed.path, isPublic: failed.isPublic, folderShare: failed.folderShare, percent: 0, status: "queued", addedAt: failed.addedAt };
    setJobs(current => current.map(job => job.id === id ? next : job));
    queue.current.push(next);
    run();
  }
  function cancel(id: string) {
    canceled.current.add(id);
    aborters.current.get(id)?.();
    const folderId = jobs.find(job => job.id === id)?.folderShare;
    if (folderId) cancelFolder(folderId);
    setJobs(current => current.map(job => job.id === id && job.status === "queued" ? { ...job, status: "canceled" } : job));
  }
  function cancelAll() {
    queue.current = [];
    canceled.current.clear();
    aborters.current.forEach(abort => abort());
    folderGroups.current.forEach((_, id) => cancelFolder(id));
    setJobs(current => current.map(job => job.status === "queued" ? { ...job, status: "canceled" } : job));
  }
  function cancelPrivate() {
    queue.current = queue.current.filter(job => !api.isPrivatePath(job.path));
    jobs.filter(job => api.isPrivatePath(job.path)).forEach(job => { canceled.current.add(job.id); aborters.current.get(job.id)?.(); });
    privateResumes.clear();
    setJobs(current => current.filter(job => !api.isPrivatePath(job.path)));
  }
  function cancelFolder(id: string) {
    const folder = folderGroups.current.get(id);
    if (!folder || folder.publishing || !folder.remaining.size) return;
    folder.canceled = true;
    updateFolder(id, { status: "canceled" });
  }
  function clear() {
    const retained = new Set(jobs.filter(job => job.status === "queued" || job.status === "uploading").map(job => job.folderShare));
    folderGroups.current.forEach((folder, id) => { if (!retained.has(id) && !folder.publishing) folderGroups.current.delete(id); });
    setFolderShares(current => current.filter(folder => retained.has(folder.id) || folder.status === "sharing"));
    setJobs(current => current.filter(job => job.status === "queued" || job.status === "uploading"));
  }
  function remove(ids: string[]) {
    const removing = new Set(ids);
    jobs.filter(job => removing.has(job.id) && (job.status === "queued" || job.status === "uploading")).forEach(job => cancel(job.id));
    queue.current = queue.current.filter(job => !removing.has(job.id));
    setJobs(current => current.filter(job => !removing.has(job.id)));
  }
  return { jobs, folderShares, enqueue, retry, retryFolder: (id: string) => void publishFolder(id), cancel, cancelAll, cancelPrivate, clear, remove };
}

const uploadGroup = (job: UploadJob): TaskFilter => job.status === "done" ? "done" : job.status === "error" ? "error" : job.status === "canceled" ? "paused" : "active";
const uploadDescription = (job: UploadJob) => `${job.file.name} ${api.privatePathLabel(job.path)}`;
const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const duration = (ms: number) => ms < 1000 ? "不到 1 秒" : ms < 60000 ? `${Math.round(ms / 1000)} 秒` : ms < 3600000 ? `${Math.floor(ms / 60000)} 分 ${Math.round(ms % 60000 / 1000)} 秒` : `${Math.floor(ms / 3600000)} 小时 ${Math.round(ms % 3600000 / 60000)} 分`;
const UPLOAD_LABEL: Record<UploadJob["status"], string> = { queued: "排队中", uploading: "上传中", done: "已完成", error: "失败", canceled: "已取消" };
const UPLOAD_TONE: Record<UploadJob["status"], "neutral" | "accent" | "success" | "danger"> = { queued: "neutral", uploading: "accent", done: "success", error: "danger", canceled: "neutral" };
const sentBytes = (job: UploadJob) => job.status === "done" ? job.file.size : job.status === "uploading" && !job.phase ? job.file.size * job.percent / 100 : 0;

/** 任务中心 · 上传任务。队列由应用外壳持有：离开本页不会取消上传，但关闭或刷新网页会中断（大文件下次可续传）。 */
export function UploadsPage({ queue, onOpenFolder }: { queue: UploadQueue; onOpenFolder: (prefix: string) => void }) {
  useDocumentTitle(`上传任务 · ${BRAND}`);
  const { jobs, folderShares } = queue;
  const list = useTaskList(jobs, uploadDescription, uploadGroup);
  const [confirm, setConfirm] = useState<{ action: "cancel" | "delete" | "clear" | "cancelAll"; ids: string[] } | null>(null);
  const [pending, setPending] = useState<UploadFile[] | null>(null);
  const running = jobs.filter(job => uploadGroup(job) === "active");
  const uploading = running.filter(job => job.status === "uploading" && !job.phase && job.percent < 100);
  const rates = useTransferRates(uploading.map(job => [job.id, sentBytes(job)]));
  const speed = uploading.reduce((sum, job) => sum + (rates.get(job.id) ?? 0), 0);
  const runningSize = running.reduce((sum, job) => sum + job.file.size, 0), runningSent = running.reduce((sum, job) => sum + sentBytes(job), 0);
  const instant = jobs.filter(job => job.instant && job.status === "done").length;
  const sent = jobs.reduce((sum, job) => sum + sentBytes(job), 0);
  const runningChosen = list.chosen.filter(job => uploadGroup(job) === "active");
  const retryChosen = list.chosen.filter(job => job.status === "error" || job.status === "canceled");
  const toggle = (filter: TaskFilter) => list.setFilter(list.filter === filter ? "" : filter);
  const privateHere = jobs.some(job => api.isPrivatePath(job.path));
  const open = (job: UploadJob) => onOpenFolder(folderOf(job.path));
  const shareLink = (job: UploadJob) => job.result?.public_token ? api.publicLinks(job.result.public_token, job.file.name).page : null;
  return <div className="task-page upload-page">
    <PageHeader title="上传任务" description="在这台设备的网页中上传，离开本页继续进行；关闭或刷新网页会中断，大文件下次可从断点续传。"
      actions={<>
        {running.length > 0 && <Button icon="x" onClick={() => setConfirm({ action: "cancelAll", ids: [] })}>全部取消</Button>}
        <UploadPicker onPick={files => { if (files?.length) setPending(uploadFiles(files)); }} />
      </>} />
    <TaskStats label="上传概览" progress={running.length ? { percent: runningSize ? runningSent / runningSize * 100 : null, label: "进行中任务的总进度" } : null} items={[
      { key: "active", label: "进行中", icon: "upload", tone: "accent", live: running.length > 0, value: running.length.toLocaleString("zh-CN"),
        detail: running.length ? speed > 0 ? `${formatBytes(speed)}/s${speed > 0 && runningSize > runningSent ? ` · ${remainingText((runningSize - runningSent) / speed)}` : ""}` : "准备中" : "没有进行中的上传",
        selected: list.filter === "active", onSelect: () => toggle("active") },
      { key: "done", label: "已完成", icon: "checkCircle", tone: "success", value: list.counts.done.toLocaleString("zh-CN"), detail: instant ? `其中 ${instant} 个秒传` : "保存到你的文件",
        selected: list.filter === "done", onSelect: () => toggle("done") },
      { key: "error", label: "失败", icon: "alert", tone: list.counts.error ? "danger" : "neutral", value: list.counts.error.toLocaleString("zh-CN"), detail: list.counts.error ? "可重新上传" : "一切正常",
        selected: list.filter === "error", onSelect: () => toggle("error") },
      { key: "bytes", label: "已传输", icon: "hardDrive", value: formatBytes(sent), detail: `共 ${formatBytes(jobs.reduce((sum, job) => sum + job.file.size, 0))}` },
    ]} />
    {folderShares.length > 0 && <div className="task-folder-notices">{folderShares.map(folder => {
      const name = baseName(folder.path), token = folder.result?.public_token;
      return <Notice key={folder.id} className="task-folder-notice" icon={folder.status === "done" ? "globe" : "folder"} tone={folder.status === "error" ? "danger" : folder.status === "done" ? "success" : "info"}>
        <div className="task-folder-notice-main"><strong>{folder.status === "done" ? `文件夹“${name}”已公开` : folder.status === "error" ? `文件夹“${name}”未能公开` : folder.status === "canceled" ? `已取消公开“${name}”` : `上传完成后公开“${name}”`}</strong>
          <p>{folder.status === "waiting" ? `已上传 ${folder.uploaded} / ${folder.total} 个文件` : folder.status === "sharing" ? "正在生成分享链接…" : folder.status === "done" ? "任何拥有链接的人都可以浏览其中的文件。" : folder.status === "canceled" ? "部分文件没有上传完成，文件夹保持私有。" : folder.error}</p>
        </div>
        <div className="task-folder-notice-actions">
          {folder.status === "sharing" && <span className="spinner" aria-label="正在公开文件夹" />}
          {folder.status === "error" && <Button size="sm" icon="refresh" onClick={() => queue.retryFolder(folder.id)}>重试公开</Button>}
          {token && <Button size="sm" icon="copy" onClick={() => void copyText(api.publicLinks(token, name).page, "分享链接已复制")}>复制链接</Button>}
        </div>
      </Notice>;
    })}</div>}
    <TaskControls list={list} noun="上传" pausedLabel="已取消" menu={<Menu label="清理上传记录" icon="trash" items={[
      { label: "清理已结束的记录", icon: "trash", danger: true, disabled: !jobs.some(job => uploadGroup(job) !== "active") && !folderShares.some(folder => ["done", "error", "canceled"].includes(folder.status)), onSelect: () => setConfirm({ action: "clear", ids: [] }) },
    ]} />} actions={<>
      {runningChosen.length > 0 && <Button size="sm" icon="x" onClick={() => setConfirm({ action: "cancel", ids: runningChosen.map(job => job.id) })}>取消上传</Button>}
      {retryChosen.length > 0 && <Button size="sm" icon="refresh" onClick={() => { retryChosen.forEach(job => queue.retry(job.id)); list.clearSelection(); }}>重新上传</Button>}
      <Button size="sm" variant="danger" icon="trash" onClick={() => setConfirm({ action: "delete", ids: list.chosen.map(job => job.id) })}>删除记录</Button>
    </>} />
    {privateHere && <Notice icon="lock">私密空间的上传只在本次登录有效：锁定私密空间或退出后，未完成的私密上传会取消。</Notice>}
    <div className="file-surface task-surface">
      {!list.visible.length ? <EmptyState icon="upload" title={jobs.length ? "没有符合条件的上传" : "还没有上传任务"}
        description={jobs.length ? "试试其他名称或任务状态。" : "选择文件或文件夹上传，进度会显示在这里；也可以在「我的文件」中直接拖入文件。"}
        action={jobs.length ? <Button onClick={list.clearFilters}>清除筛选</Button> : undefined} />
        : <div className="data-table task-table upload-table" role="table" aria-label="上传任务">
          <div className="data-row data-head" role="row">
            <span className="cell-check" role="columnheader"><Checkbox checked={list.allSelected} indeterminate={list.chosen.length > 0 && !list.allSelected} label="选择本页全部上传任务" onChange={list.selectPage} /></span>
            <span role="columnheader">文件</span><span role="columnheader">进度</span><span role="columnheader">保存到</span><span role="columnheader">状态</span>
            <span className="cell-actions" role="columnheader"><span className="sr-only">操作</span></span>
          </div>
          {list.visible.map(job => {
            const active = uploadGroup(job) === "active", folder = folderOf(job.path), link = shareLink(job);
            const thumbnail = job.result ? api.fileThumbnail(job.result) : undefined, kind = getFileKind(job.file.type, job.file.name);
            const checked = list.selected.has(job.id);
            const quick = active ? <IconButton icon="x" size="sm" label={`取消上传 ${job.file.name}`} onClick={() => setConfirm({ action: "cancel", ids: [job.id] })} />
              : job.status !== "done" ? <IconButton icon="refresh" size="sm" label={`重新上传 ${job.file.name}`} onClick={() => queue.retry(job.id)} />
                : link ? <IconButton icon="copy" size="sm" label={`复制 ${job.file.name} 的分享链接`} onClick={() => void copyText(link, "分享链接已复制")} />
                  : <IconButton icon="folder" size="sm" label={`打开所在文件夹：${api.privatePathLabel(folder)}`} onClick={() => open(job)} />;
            return <div key={job.id} className={`data-row task-item is-${job.status}${checked ? " is-selected" : ""}`} role="row">
              <span className="cell-check" role="cell"><Checkbox checked={checked} label={`选择 ${job.file.name}`} onChange={value => list.toggle(job.id, value)} /></span>
              <div className="cell-name" role="cell">
                {thumbnail ? <FileVisual kind={kind} src={thumbnail} /> : <FileTile kind={kind} />}
                <div className="name-stack">
                  <strong className="task-name" title={job.file.name}>{job.file.name}{job.isPublic && <Icon name="globe" size={13} />}</strong>
                  <small className="task-subline">{formatBytes(job.file.size)}{job.instant ? " · 秒传" : job.resumed ? " · 断点续传" : ""}</small>
                </div>
              </div>
              <div role="cell"><UploadProgress job={job} rate={rates.get(job.id) ?? 0} /></div>
              <div role="cell" className="muted">
                <button type="button" className="task-location" title={`打开所在文件夹：${api.privatePathLabel(folder)}`} onClick={() => open(job)}>
                  <Icon name={api.isPrivatePath(job.path) ? "lock" : "folder"} size={12} /><LocationText folder={folder} /></button>
              </div>
              <div className="task-state" role="cell"><Badge tone={UPLOAD_TONE[job.status]} dot={job.status !== "done"} icon={job.status === "done" ? "check" : undefined}>
                {job.status === "uploading" ? job.phase === "hashing" ? "检查秒传" : job.phase === "waiting" ? "等待秒传" : job.percent >= 100 ? "正在保存" : "上传中" : UPLOAD_LABEL[job.status]}</Badge></div>
              <div className="cell-actions" role="cell">{quick}<Menu label={`${job.file.name} 的更多操作`} items={[
                { label: "打开所在文件夹", icon: "folder", onSelect: () => open(job) },
                ...(link ? [{ label: "复制分享链接", icon: "copy" as const, onSelect: () => void copyText(link, "分享链接已复制") }] : []),
                ...(job.status === "error" && job.error ? [{ label: "复制失败原因", icon: "alert" as const, onSelect: () => void copyText(job.error!, "失败原因已复制") }] : []),
                ...(job.status === "error" || job.status === "canceled" ? [{ label: "重新上传", icon: "refresh" as const, onSelect: () => queue.retry(job.id) }] : []),
                ...(active ? [{ label: "取消上传", icon: "x" as const, onSelect: () => setConfirm({ action: "cancel", ids: [job.id] }) }] : []),
                { label: "删除记录", icon: "trash", danger: true, divider: true, onSelect: () => setConfirm({ action: "delete", ids: [job.id] }) },
              ]} /></div>
            </div>;
          })}
        </div>}
    </div>
    <TaskListFooter list={list} />
    {pending && <UploadDialog files={pending} destination="" onClose={() => setPending(null)}
      onStart={(items, isPublic, destination) => {
        setPending(null);
        queue.enqueue(items.map(({ file, path }) => ({ file, path: `${destination}${path}`, isPublic,
          publicFolder: isPublic && path.includes("/") ? `${destination}${path.slice(0, path.indexOf("/") + 1)}` : undefined })));
      }} />}
    {confirm && <ConfirmDialog title={confirm.action === "clear" ? "清理已结束的上传记录？" : confirm.action === "cancelAll" ? `取消全部 ${running.length} 个上传？` : `${confirm.action === "cancel" ? "取消" : "删除"} ${confirm.ids.length} 个上传任务？`}
      description={confirm.action === "cancel" || confirm.action === "cancelAll" ? "所选上传会取消，未提交的分段将被清理。已上传成功的文件会保留。" : confirm.action === "clear" ? "移除已完成、失败和取消的记录，正在上传的任务和已保存的文件会保留。" : "移除所选记录；正在上传的任务会先取消，已保存的文件会保留。"}
      confirmLabel={confirm.action === "cancel" || confirm.action === "cancelAll" ? "取消上传" : confirm.action === "clear" ? "清理记录" : "删除记录"} onClose={() => setConfirm(null)}
      onConfirm={() => {
        if (confirm.action === "cancel") confirm.ids.forEach(queue.cancel);
        else if (confirm.action === "cancelAll") queue.cancelAll();
        else if (confirm.action === "delete") queue.remove(confirm.ids); else queue.clear();
        setConfirm(null); list.clearSelection();
      }} />}
  </div>;
}

/** 进度列：上传中显示进度条、已传大小、速度与剩余时间；完成后显示用时，失败时显示原因（点击展开全文）。 */
function UploadProgress({ job, rate }: { job: UploadJob; rate: number }) {
  const [expanded, setExpanded] = useState(false);
  if (job.status === "done") {
    const spent = job.startedAt && job.completedAt ? job.completedAt - job.startedAt : null;
    return <div className="task-progress is-done"><span className="task-figure">{formatBytes(job.file.size)}</span>
      <small>{job.instant ? "内容已存在，秒传完成" : [spent !== null && `用时 ${duration(spent)}`, spent && spent > 500 && `平均 ${formatBytes(job.file.size / (spent / 1000))}/s`].filter(Boolean).join(" · ") || "已保存"}</small></div>;
  }
  if (job.status === "error") return <button type="button" className={`task-failure${expanded ? " is-expanded" : ""}`} title={expanded ? "收起" : job.error} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
    <Icon name="alert" size={13} /><span>{job.error || "上传失败"}</span></button>;
  if (job.status === "canceled") return <div className="task-progress is-stopped"><small>已取消，可重新上传{job.file.size > 64 * 1024 * 1024 ? "（从断点继续）" : ""}</small></div>;
  const indeterminate = job.status === "uploading" && (job.phase === "waiting" || !job.phase && job.percent >= 100);
  const percent = job.status === "queued" ? 0 : job.percent;
  const sent = job.file.size * percent / 100;
  const detail = job.status === "queued" ? "等待开始" : job.phase === "hashing" ? "计算内容指纹，检查是否可秒传" : job.phase === "waiting" ? "等待相同内容的文件完成后秒传"
    : job.percent >= 100 ? "正在保存…" : [`${formatBytes(sent)} / ${formatBytes(job.file.size)}`, rate > 0 && `${formatBytes(rate)}/s`, rate > 0 && remainingText((job.file.size - sent) / rate)].filter(Boolean).join(" · ");
  return <div className={`task-progress is-${job.status}`}>
    <div className="task-progress-bar">
      {indeterminate ? <div className="task-unknown is-running" role="status" aria-label={detail} /> : <Progress value={percent} tone={job.status === "queued" ? "neutral" : "accent"} label={`${job.file.name} 上传进度`} />}
      {!indeterminate && <span className="task-percent">{Math.floor(percent)}%</span>}
    </div>
    <small title={detail}>{detail}</small>
  </div>;
}
