import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import * as api from "../api";
import { isFatalCacheError, loadPrivateCacheQueue, savePrivateCacheQueue, startCacheGroup, beginFileCache, cachedFiles, cachedItems, cacheFileId, cacheIndex, cacheStats, cacheSupported, cancelFileCache, clearCache, listCacheGroup, cacheDirectoryInfo, cacheQuota, regrantCacheDirectory, type CacheDirectoryInfo, releaseCacheGroup, removeFileCache, stepFileCache, type CacheFile, type CachedFileState, type CachedItem, type CacheStats, type FileCacheState } from "../cache-client";
import { BRAND } from "../brand";
import { effectiveMiB } from "../cache-store";
import { FileTile, getFileKind } from "../files";
import { Badge, Button, Checkbox, ConfirmDialog, EmptyState, Icon, IconButton, KeyValue, Menu, Modal, Notice, PageHeader, Pagination, Progress, SearchInput, Segmented, SkeletonRows, Tabs, copyText, formatBytes, formatDateTime, toast, useDocumentTitle, type MenuItem } from "../ui";
import { usePrivateAccess } from "./private-session";
import { PrivateUnlockDialog } from "./private-unlock";
import { LocationText, TaskControls, TaskListFooter, TaskStats, remainingText, useTaskList, useTransferRates, type TaskFilter, type TaskStat } from "./task-list";
import { cacheFolderFiles } from "./cache-folders";

export type CacheReport = { state: "none" | "partial" | "auto" | "manual" | "caching"; percent?: number; blocked?: string };
/** retrying：暂时失败后正在等待第几次自动重试（已缓存的块保留，从缺失处继续）。 */
type CacheJob = { id: string; file: CacheFile; group?: string; status: "queued" | "active" | "paused" | "done" | "error" | "canceled"; bytes: number; size: number; error: string; waiting: boolean; retrying?: number; addedAt: number; completedAt?: number };
type FolderCacheJob = { id: string; prefixes: string[]; group?: string; status: "active" | "error"; files: number; error: string; toastId?: number };
type Queue = {
  /** 浏览器支持且用户与管理员都没有关闭本机缓存；否则不显示缓存按钮与菜单项。 */
  available: boolean;
  /** 私密文件可以缓存（这台设备开启了私密缓存且私密空间已解锁）。 */
  privateReady: boolean;
  /** 这台设备开启了私密缓存（不论是否解锁）：锁定时据此提示解锁后查看私密缓存。 */
  privateEnabled: boolean;
  /** states：预览等单独关注的文件的实时状态；cached：这台设备上全部已缓存文件的索引（区分自动与手动），文件列表只看这一份。 */
  jobs: CacheJob[]; states: Map<string, FileCacheState>; cached: Map<string, CachedFileState>; showTasks: () => void;
  folders: FolderCacheJob[]; enqueueFolders: (prefixes: string[]) => void; cancelFolder: (id: string) => void; retryFolder: (id: string) => void;
  watch: (owner: string, files: CacheFile[]) => () => void;
  /** 私密文件只在这台设备开启了私密缓存且私密空间已解锁时可以缓存。 */
  canCache: (file: CacheFile) => boolean; enqueue: (file: CacheFile) => void; enqueueMany: (files: CacheFile[]) => number;
  cancel: (id: string) => void; pause: (id: string) => void; retry: (id: string) => void; clear: () => void; removeJobs: (ids: string[]) => void;
  inspect: (file: CacheFile) => void; remove: (files: CacheFile | CacheFile[]) => void;
  /** 不弹确认直接清除（文件助手卡片：点击卡片本身就是确认）。 */
  forget: (files: CacheFile[]) => Promise<void>;
  /** 文件助手查询用：重新读取一次缓存索引，返回每个文件的状态。 */
  report: (files: CacheFile[]) => Promise<CacheReport[]>;
};
const CacheContext = createContext<Queue | null>(null);
const nameOf = (file: CacheFile) => file.key.split("/").at(-1) || file.key;
const isRunning = (job: CacheJob) => job.status === "queued" || job.status === "active";
const percentOf = (bytes: number, size: number, complete = false) => complete ? 100 : size ? Math.min(99, Math.floor(bytes / size * 100)) : 0;

/** 网络抖动、Worker 被浏览器回收、其他页面占用等暂时失败按此间隔自动续传；连续失败（期间没有新进度）超过次数才算失败。 */
const RETRY_DELAYS = [1000, 3000, 8000, 15000, 30000, 60000];
/** 同时缓存的文件数，与 Worker 的 MAX_MANUAL_FILES 一致；所有文件的回源请求另有共同的并发上限。 */
const CACHE_FILE_CONCURRENCY = 3;

function pause(signal: AbortSignal, delay = 1500) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DOMException("缓存已取消", "AbortError")); };
    const timer = setTimeout(finish, delay);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

/** 刷新页面后恢复的任务记录，按账号分开：普通文件存在 localStorage；私密文件交给 Worker 用私密层密钥加密保存，
 * 只有解锁后才能读写（不以明文写入浏览器存储）。进行中与排队的任务恢复后自动从已缓存处续传；退出登录或关闭本机缓存时删除。 */
const SAVED_VERSION = 1, SAVED_LIMIT = 1000;
type SavedQueue = { version: number; jobs: CacheJob[]; folders: string[][] };
function parseQueue(text: string | null, privateTier: boolean): SavedQueue | null {
  try {
    const value = JSON.parse(text ?? "null") as Partial<SavedQueue> | null;
    if (!value || value.version !== SAVED_VERSION || !Array.isArray(value.jobs)) return null;
    const statuses = new Set(["queued", "active", "paused", "done", "error", "canceled"]);
    const jobs = value.jobs.filter(job => job && typeof job.id === "string" && job.file && typeof job.file.key === "string" && typeof job.file.etag === "string"
      && typeof job.file.size === "number" && api.isPrivatePath(job.file.key) === privateTier && statuses.has(job.status))
      .map(job => ({ ...job, group: undefined, status: job.status === "active" ? "queued" as const : job.status, waiting: false, retrying: undefined }));
    const folders = Array.isArray(value.folders) ? value.folders.filter(prefixes => Array.isArray(prefixes) && prefixes.length > 0
      && prefixes.every(prefix => typeof prefix === "string" && api.isPrivatePath(prefix) === privateTier)) : [];
    return { version: SAVED_VERSION, jobs, folders };
  } catch { return null; }
}
/** 序列化一层的队列；没有任何记录时返回空字符串（表示删除）。 */
function serializeQueue(jobs: CacheJob[], folders: FolderCacheJob[], privateTier: boolean) {
  const tier = jobs.filter(job => api.isPrivatePath(job.file.key) === privateTier).map(({ group: _group, retrying: _retrying, ...job }) => ({ ...job, waiting: false }));
  // 进行中与排队的任务全部保留，历史记录只留最近的部分。
  const running = tier.filter(isRunning), history = tier.filter(job => !isRunning(job)).slice(-SAVED_LIMIT);
  const prefixes = folders.filter(folder => folder.status === "active").map(folder => folder.prefixes.filter(prefix => api.isPrivatePath(prefix) === privateTier)).filter(list => list.length);
  return running.length || history.length || prefixes.length ? JSON.stringify({ version: SAVED_VERSION, jobs: [...history, ...running], folders: prefixes }) : "";
}
function writeLocal(key: string, text: string) {
  try { if (text) localStorage.setItem(key, text); else localStorage.removeItem(key); } catch { /* 存储已满或被禁用时只是不能在刷新后恢复 */ }
}
const readLocal = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };

/** 队列属于已登录的应用外壳；已加入的缓存任务不受私密空间锁定影响。owner 区分账号，用于刷新后恢复任务。 */
export function CacheTasksProvider({ enabled, owner, onOpenTasks, onActiveChange, children }: { enabled: boolean; owner?: string; onOpenTasks: () => void; onActiveChange?: (count: number) => void; children: ReactNode }) {
  const storageKey = owner ? `tessera:cache-jobs:${owner}` : "";
  const access = usePrivateAccess();
  const [privateCacheEnabled, setPrivateCacheEnabled] = useState(false);
  const privateReady = enabled && privateCacheEnabled && Boolean(access.grant);
  const [jobs, setJobs] = useState<CacheJob[]>([]), jobsRef = useRef(jobs);
  const [folders, setFolders] = useState<FolderCacheJob[]>([]), foldersRef = useRef(folders);
  const folderControllers = useRef(new Map<string, AbortController>());
  const groups = useRef(new Map<string, { ready: Promise<void>; paths: string[] }>());
  const [states, setStates] = useState(new Map<string, FileCacheState>());
  const statesRef = useRef(states); statesRef.current = states;
  const [cached, setCached] = useState(new Map<string, CachedFileState>());
  const cachedRef = useRef(cached); cachedRef.current = cached;
  const [wake, setWake] = useState(0);
  const [details, setDetails] = useState<CacheFile | null>(null), [removing, setRemoving] = useState<CacheFile[] | null>(null);
  // 同时缓存的文件（与 Worker 的 MAX_MANUAL_FILES 一致）；每个大文件在 Worker 内再按段并行下载。
  const active = useRef(new Map<string, AbortController>());
  const [available, setAvailable] = useState(false);
  const watching = useRef(new Map<string, CacheFile[]>()), ready = useRef({ enabled, privateReady, available, privateCacheEnabled });
  ready.current = { enabled, privateReady, available, privateCacheEnabled };
  const prepareGroup = useCallback((paths: string[], id: string) => {
    const task = startCacheGroup(id, paths);
    task.catch(() => undefined);
    groups.current.set(id, { ready: task, paths });
    return id;
  }, []);
  const refreshRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!enabled || !cacheSupported()) { setAvailable(false); setPrivateCacheEnabled(false); return; }
    let alive = true;
    const read = () => void cacheStats().then(value => {
      if (!alive) return;
      setAvailable(value.settings.enabled);
      setPrivateCacheEnabled(value.settings.private);
      if (!value.settings.enabled && storageKey) writeLocal(storageKey, "");
    }).catch(() => undefined);
    read();
    window.addEventListener("tessera:cache-changed", read);
    return () => { alive = false; window.removeEventListener("tessera:cache-changed", read); };
  }, [enabled, storageKey]);
  // 本地缓存目录的授权在浏览器重启后可能需要重新确认：每次登录提示一次，点击提示中的按钮即可授权（需要用户点击）。
  useEffect(() => {
    if (!enabled || !available) return;
    let alive = true;
    void cacheDirectoryInfo().then(folder => {
      if (!alive || !folder || folder.permission === "granted" || sessionStorage.getItem("tessera:cache-regrant")) return;
      sessionStorage.setItem("tessera:cache-regrant", "1");
      toast.info(`本机缓存文件夹「${folder.name}」需要重新授权`, { label: "重新授权", onClick: () => void regrantCacheDirectory().catch(() => undefined) });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [enabled, available]);
  const update = useCallback((apply: (value: CacheJob[]) => CacheJob[]) => { jobsRef.current = apply(jobsRef.current); setJobs(jobsRef.current); }, []);
  const updateFolders = useCallback((apply: (value: FolderCacheJob[]) => FolderCacheJob[]) => { foldersRef.current = apply(foldersRef.current); setFolders(foldersRef.current); }, []);
  const cancelFolder = useCallback((id: string) => {
    const toastId = foldersRef.current.find(folder => folder.id === id)?.toastId;
    if (toastId != null) toast.dismiss(toastId);
    folderControllers.current.get(id)?.abort(); folderControllers.current.delete(id);
    updateFolders(value => value.filter(folder => folder.id !== id));
  }, [updateFolders]);
  const stop = useCallback((id: string, status: "paused" | "canceled") => {
    if (active.current.has(id)) { active.current.get(id)!.abort(); cancelFileCache(id); }
    update(value => value.map(job => job.id === id && isRunning(job) ? { ...job, status, waiting: false, retrying: undefined } : job));
  }, [update]);
  const cancel = useCallback((id: string) => stop(id, "canceled"), [stop]);
  const pauseJob = useCallback((id: string) => stop(id, "paused"), [stop]);
  const removeJobs = useCallback((ids: string[]) => {
    const selected = new Set(ids);
    ids.forEach(cancel);
    update(value => value.filter(job => !selected.has(job.id)));
  }, [cancel, update]);
  const reset = useCallback((privateOnly: boolean) => {
    foldersRef.current.filter(folder => !privateOnly || folder.prefixes.some(api.isPrivatePath)).forEach(folder => cancelFolder(folder.id));
    const selected = jobsRef.current.filter(job => !privateOnly || api.isPrivatePath(job.file.key));
    selected.forEach(job => { if (active.current.has(job.id)) { active.current.get(job.id)!.abort(); cancelFileCache(job.id); } });
    update(value => privateOnly ? value.filter(job => !api.isPrivatePath(job.file.key)) : []);
    setStates(value => new Map([...value].filter(([key]) => privateOnly && !key.startsWith("p:"))));
    setCached(value => new Map([...value].filter(([key]) => privateOnly && !key.startsWith("p:"))));
    setDetails(value => value && (!privateOnly || api.isPrivatePath(value.key)) ? null : value);
    setRemoving(value => value && (!privateOnly || value.some(file => api.isPrivatePath(file.key))) ? null : value);
  }, [update, cancelFolder]);
  const hidePrivate = useCallback(() => {
    setStates(value => new Map([...value].filter(([key]) => !key.startsWith("p:"))));
    setCached(value => new Map([...value].filter(([key]) => !key.startsWith("p:"))));
    setDetails(value => value && api.isPrivatePath(value.key) ? null : value);
    setRemoving(value => value?.some(file => api.isPrivatePath(file.key)) ? null : value);
  }, []);
  useLayoutEffect(() => {
    if (!enabled || !available) reset(false);
    else if (!privateCacheEnabled) reset(true);
    else if (!privateReady) hidePrivate();
  }, [enabled, available, privateCacheEnabled, privateReady, reset, hidePrivate]);
  useEffect(() => {
    const used = new Set([...jobs.filter(job => job.status !== "done").map(job => job.group), ...folders.map(folder => folder.group)]);
    for (const id of groups.current.keys()) if (!used.has(id)) { releaseCacheGroup(id); groups.current.delete(id); }
  }, [jobs, folders]);
  // 刷新后恢复：开启缓存且可用后读取一次保存的队列（私密队列在解锁后读取）；离开页面时先保存再停止，停止后的空队列不写回。
  const restored = useRef(false), leaving = useRef(false), restoreFolders = useRef<string[][]>([]);
  const privateLoaded = useRef<"no" | "loading" | "yes">("no"), privateSaved = useRef<string | null>(null);
  const [restoreTick, setRestoreTick] = useState(0);
  const mergeRestored = useCallback((saved: SavedQueue, group?: string) => {
    update(value => {
      const known = new Set(value.map(job => cacheFileId(job.file)));
      return [...saved.jobs.filter(job => !known.has(cacheFileId(job.file))).map(job => group && job.status !== "done" ? { ...job, group } : job), ...value];
    });
    restoreFolders.current = [...restoreFolders.current, ...saved.folders];
    setRestoreTick(value => value + 1);
  }, [update]);
  useEffect(() => {
    if (!enabled || !available || !storageKey || restored.current) return;
    restored.current = true;
    const saved = parseQueue(readLocal(storageKey), false);
    if (saved) mergeRestored(saved);
  }, [enabled, available, storageKey, restoreTick, mergeRestored]);
  useEffect(() => {
    if (!enabled || !available || !privateReady || privateLoaded.current !== "no") return;
    privateLoaded.current = "loading";
    void loadPrivateCacheQueue().catch(() => null).then(text => {
      privateSaved.current = text ?? "";
      privateLoaded.current = "yes";
      const saved = parseQueue(text, true);
      if (!saved || !ready.current.privateReady) return;
      // 私密任务需要重新登记任务组（服务端按当前解锁授权核对路径）后才能继续。
      const group = crypto.randomUUID(), known = new Set(jobsRef.current.map(job => cacheFileId(job.file)));
      const paths = saved.jobs.filter(job => job.status !== "done" && !known.has(cacheFileId(job.file))).map(job => job.file.key);
      if (paths.length) prepareGroup(paths, group);
      mergeRestored(saved, paths.length ? group : undefined);
    });
  }, [enabled, available, privateReady, restoreTick, mergeRestored, prepareGroup]);
  const persist = useCallback(() => {
    if (leaving.current) return;
    if (restored.current && storageKey) writeLocal(storageKey, serializeQueue(jobsRef.current, foldersRef.current, false));
    if (privateLoaded.current === "yes" && ready.current.privateReady) {
      const text = serializeQueue(jobsRef.current, foldersRef.current, true);
      if (text !== privateSaved.current) { privateSaved.current = text; void savePrivateCacheQueue(text).catch(() => { privateSaved.current = null; }); }
    }
  }, [storageKey]);
  useEffect(() => {
    const timer = window.setTimeout(persist, 1000);
    return () => window.clearTimeout(timer);
  }, [jobs, folders, privateReady, persist]);
  useEffect(() => {
    const stop = () => { persist(); leaving.current = true; reset(false); };
    const logout = () => {
      if (privateLoaded.current === "yes" && ready.current.privateReady) void savePrivateCacheQueue("").catch(() => undefined);
      leaving.current = true; if (storageKey) writeLocal(storageKey, ""); reset(false);
    };
    // 从往返缓存（bfcache）回到页面时重新读取保存的队列。
    const shown = (event: PageTransitionEvent) => { if (event.persisted) { leaving.current = false; restored.current = false; privateLoaded.current = "no"; setRestoreTick(value => value + 1); } };
    const locked = hidePrivate;
    window.addEventListener("pagehide", stop); window.addEventListener("pageshow", shown); window.addEventListener("tessera:logout", logout); window.addEventListener("tessera:private-locked", locked);
    return () => { window.removeEventListener("pagehide", stop); window.removeEventListener("pageshow", shown); window.removeEventListener("tessera:logout", logout); window.removeEventListener("tessera:private-locked", locked); active.current.forEach((controller, id) => { controller.abort(); cancelFileCache(id); }); folderControllers.current.forEach(controller => controller.abort()); foldersRef.current.forEach(folder => { if (folder.toastId != null) toast.dismiss(folder.toastId); }); groups.current.forEach((_, id) => releaseCacheGroup(id)); groups.current.clear(); };
  }, [reset, hidePrivate, storageKey, persist]);

  // 文件列表只取一次「缓存索引」，不逐个文件查询；单独关注的文件（预览中的文件）另外批量查询完整状态。
  useEffect(() => {
    if (!enabled || !available) return;
    let disposed = false, pending = false, refreshAgain = false, timer: number | undefined;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (pending) { refreshAgain = true; return; }
      timer = window.setTimeout(() => void refresh(), delay);
    };
    async function refresh() {
      if (disposed || pending) return;
      pending = true;
      const files = new Map<string, CacheFile>();
      for (const group of watching.current.values()) for (const file of group) {
        if (!api.isPrivatePath(file.key) || ready.current.privateReady) files.set(cacheFileId(file), file);
      }
      for (const tier of [false, true]) {
        const group = [...files.values()].filter(file => api.isPrivatePath(file.key) === tier);
        if (!group.length) continue;
        try {
          const result = await cachedFiles(group);
          if (disposed || tier && !ready.current.privateReady) continue;
          setStates(previous => {
            const next = new Map(previous);
            group.forEach((file, index) => next.set(cacheFileId(file), { ...result[index], size: result[index].size || file.size }));
            // 长时间浏览很多目录时也不在页面内保留无限的状态索引。
            if (next.size > 2000) for (const key of next.keys()) { if (!files.has(key)) next.delete(key); }
            return next;
          });
        } catch {
          if (!disposed) setStates(previous => { const next = new Map(previous); group.forEach(file => next.delete(cacheFileId(file))); return next; });
        }
      }
      try {
        const list = await cacheIndex(ready.current.privateReady);
        if (!disposed) setCached(new Map(list.map(({ id, ...state }) => [id, state])));
      } catch { if (!disposed) setCached(new Map()); }
      pending = false;
      // 写入提交后由 Worker 广播变化；查询中到达的通知不能丢弃，空闲时仍每 20 秒兜底刷新。
      if (!disposed) { const delay = refreshAgain ? 80 : jobsRef.current.some(isRunning) ? 2000 : 20000; refreshAgain = false; schedule(delay); }
    }
    refreshRef.current = () => schedule(80);
    const visible = () => { if (!document.hidden) schedule(0); };
    window.addEventListener("tessera:cache-changed", refreshRef.current); window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    schedule(0);
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener("tessera:cache-changed", refreshRef.current); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); refreshRef.current = () => undefined; };
  }, [enabled, available, privateReady]);
  const watch = useCallback((owner: string, files: CacheFile[]) => {
    watching.current.set(owner, files); refreshRef.current();
    return () => { watching.current.delete(owner); refreshRef.current(); };
  }, []);
  const canCache = useCallback((file: CacheFile) => ready.current.enabled && ready.current.available && cacheSupported() && (!api.isPrivatePath(file.key) || ready.current.privateReady), []);
  const enqueueMany = useCallback((files: CacheFile[], queuedGroup?: string) => {
    const accepted = files.filter(file => queuedGroup && api.isPrivatePath(file.key)
      ? ready.current.enabled && ready.current.available && ready.current.privateCacheEnabled && groups.current.has(queuedGroup) : canCache(file));
    if (!accepted.length) return 0;
    const privateFiles = accepted.filter(file => api.isPrivatePath(file.key));
    let group = queuedGroup;
    let added = 0;
    update(value => {
      const known = new Map(value.map(job => [cacheFileId(job.file), job]));
      const queued = new Map<string, CacheJob>();
      for (const file of accepted) {
        const id = cacheFileId(file), found = known.get(id);
        if ((found && isRunning(found)) || queued.has(id)) continue;
        // 起始进度取已知的最大值：单文件状态只覆盖预览中的文件，列表文件要看缓存索引，不能先显示 0% 像是重新开始。
        const bytes = Math.max(statesRef.current.get(id)?.bytes ?? 0, cachedRef.current.get(id)?.bytes ?? 0, found?.bytes ?? 0);
        const jobId = crypto.randomUUID();
        if (!group && api.isPrivatePath(file.key)) group = jobId;
        queued.set(id, { id: jobId, file, group: api.isPrivatePath(file.key) ? group : undefined, status: "queued", bytes, size: file.size, error: "", waiting: false, addedAt: Date.now() });
      }
      added = queued.size;
      return added ? [...value.filter(job => !queued.has(cacheFileId(job.file))), ...queued.values()] : value;
    });
    if (!queuedGroup && group && jobsRef.current.some(job => job.group === group)) prepareGroup(privateFiles.map(file => file.key), group);
    return added;
  }, [update, canCache, prepareGroup]);
  const enqueue = useCallback((file: CacheFile) => enqueueMany([file]), [enqueueMany]);
  const startFolder = useCallback((prefixes: string[], id: string = crypto.randomUUID(), queuedGroup?: string) => {
    const roots = [...new Set(prefixes)].filter(prefix => prefix && prefix.endsWith("/") && (!prefix.startsWith(".tgdrive/") || api.isPrivatePath(prefix)) && (!api.isPrivatePath(prefix) || ready.current.privateReady || queuedGroup && groups.current.has(queuedGroup)));
    if (!ready.current.available || !roots.length) return;
    const privateRoots = roots.filter(api.isPrivatePath);
    const group = privateRoots.length ? queuedGroup ?? prepareGroup(privateRoots, crypto.randomUUID()) : undefined;
    const toastId = foldersRef.current.find(folder => folder.id === id)?.toastId;
    if (toastId != null) toast.dismiss(toastId);
    const controller = new AbortController();
    folderControllers.current.get(id)?.abort(); folderControllers.current.set(id, controller);
    updateFolders(value => [...value.filter(folder => folder.id !== id), { id, prefixes: roots, group, status: "active", files: 0, error: "" }]);
    void (async () => {
      let added = 0, found = 0;
      const seen = new Set<string>();
      try {
        if (group) await groups.current.get(group)!.ready;
        const load = (prefix: string, cursor: string | null, signal: AbortSignal) => api.isPrivatePath(prefix) && group
          ? listCacheGroup(group, prefix, cursor, signal) : api.listFiles(prefix, cursor, false, 200, "", signal);
        for await (const files of cacheFolderFiles(roots, controller.signal, load)) {
          if (!ready.current.available) throw new Error("本机缓存已关闭，请开启后重试");
          found += files.length;
          added += enqueueMany(files.filter(file => {
            const identity = cacheFileId(file);
            if (seen.has(identity)) return false;
            seen.add(identity);
            const state = cachedRef.current.get(identity);
            return !(state?.complete && state.manual && state.size === file.size);
          }), group);
          updateFolders(value => value.map(folder => folder.id === id ? { ...folder, files: added } : folder));
        }
        if (controller.signal.aborted) return;
        updateFolders(value => value.filter(folder => folder.id !== id));
        if (added) toast.success(`已将 ${added} 个文件加入本机缓存任务`);
        else toast.info(found ? "文件夹中的文件已缓存或正在缓存" : "文件夹及其子目录中没有文件");
      } catch (reason) {
        if (!controller.signal.aborted) {
          const toastId = toast.error("部分文件未能加入缓存，请在本机缓存任务中查看并重试");
          updateFolders(value => value.map(folder => folder.id === id ? { ...folder, status: "error", error: api.errorMessage(reason, "文件夹读取失败，请重试"), toastId } : folder));
        }
      } finally {
        if (folderControllers.current.get(id) === controller) folderControllers.current.delete(id);
      }
    })();
  }, [enqueueMany, updateFolders, prepareGroup]);
  useEffect(() => {
    const prefixes = restoreFolders.current;
    restoreFolders.current = [];
    prefixes.forEach(roots => startFolder(roots));
  }, [restoreTick, startFolder]);
  const retryFolder = useCallback((id: string) => {
    const folder = foldersRef.current.find(folder => folder.id === id);
    if (folder?.status === "error") startFolder(folder.prefixes, id, ready.current.privateReady ? undefined : folder.group);
  }, [startFolder]);
  const retry = useCallback((id: string) => {
    const job = jobsRef.current.find(job => job.id === id);
    if (!job || isRunning(job) || job.status === "done") return;
    const group = job.group && groups.current.get(job.group);
    if (!canCache(job.file) && !(ready.current.available && ready.current.privateCacheEnabled && group)) return;
    if (group && ready.current.privateReady && !jobsRef.current.some(item => item.group === job.group && isRunning(item))
      && !foldersRef.current.some(folder => folder.group === job.group && folder.status === "active")) {
      prepareGroup(group.paths, job.group!);
    }
    update(value => value.map(item => item.id === id ? { ...item, status: "queued", error: "", waiting: false, retrying: undefined } : item));
  }, [canCache, update, prepareGroup]);

  useEffect(() => {
    if (!enabled || !available || active.current.size >= CACHE_FILE_CONCURRENCY) return;
    const job = jobs.find(job => job.status === "queued" && !active.current.has(job.id) && (!api.isPrivatePath(job.file.key) || privateCacheEnabled && job.group));
    if (!job) return;
    const controller = new AbortController();
    active.current.set(job.id, controller);
    // 还有空位时让下一次渲染继续启动排队的任务。
    if (active.current.size < CACHE_FILE_CONCURRENCY) setWake(value => value + 1);
    const patch = (value: Partial<CacheJob>) => {
      if (!controller.signal.aborted) update(jobs => jobs.map(item => item.id === job.id ? { ...item, ...value } : item));
    };
    const progress = (state: FileCacheState) => {
      if (controller.signal.aborted) return;
      patch({ bytes: state.bytes, size: state.size });
      if (!api.isPrivatePath(job.file.key) || ready.current.privateReady) setStates(value => new Map(value).set(cacheFileId(job.file), state));
    };
    void (async () => {
      try {
        if (job.group) {
          const group = groups.current.get(job.group);
          if (!group) throw new Error("缓存任务已结束，请重新加入缓存");
          await group.ready;
          controller.signal.throwIfAborted();
        }
        let failures = 0, reached = -1;
        while (true) {
          try {
            let result;
            do {
              patch({ status: "active", waiting: false });
              result = await beginFileCache(job.file, job.id, controller.signal, job.group);
              if (result.busy) { patch({ status: "queued", waiting: true }); await pause(controller.signal); }
            } while (result.busy);
            progress(result);
            let state: FileCacheState = result;
            while (!state.complete) {
              state = await stepFileCache(job.id, controller.signal, progress); progress(state);
              if (state.bytes > reached) { reached = state.bytes; failures = 0; patch({ retrying: undefined }); }
            }
            break;
          } catch (reason) {
            // 已写入的块都保留：暂时失败时稍等片刻重新开始，只补缺失的部分；空间不足等无法自动解决的失败直接报告。
            if (controller.signal.aborted || isFatalCacheError(reason) || failures >= RETRY_DELAYS.length) throw reason;
            failures++;
            patch({ status: "active", waiting: true, retrying: failures, error: api.errorMessage(reason, "连接中断") });
            cancelFileCache(job.id);
            await pause(controller.signal, RETRY_DELAYS[failures - 1]);
          }
        }
        patch({ status: "done", completedAt: Date.now(), retrying: undefined, error: "" });
      } catch (reason) {
        if (!controller.signal.aborted) patch({ status: "error", retrying: undefined, error: api.errorMessage(reason, "缓存失败，请稍后重试") });
      } finally {
        cancelFileCache(job.id);
        if (active.current.get(job.id) === controller) active.current.delete(job.id);
        setWake(value => value + 1); refreshRef.current();
      }
    })();
  }, [jobs, enabled, available, privateCacheEnabled, wake, update]);

  const forget = useCallback(async (files: CacheFile[]) => {
    const ids = new Set(files.map(cacheFileId));
    jobsRef.current.filter(job => ids.has(cacheFileId(job.file))).forEach(job => cancel(job.id));
    try { for (const file of files) await removeFileCache(file); }
    finally {
      update(value => value.filter(job => !ids.has(cacheFileId(job.file))));
      setStates(value => { const next = new Map(value); ids.forEach(id => next.delete(id)); return next; });
      setCached(value => { const next = new Map(value); ids.forEach(id => next.delete(id)); return next; });
    }
  }, [cancel, update]);
  const report = useCallback(async (files: CacheFile[]): Promise<CacheReport[]> => {
    const index = new Map((await cacheIndex(ready.current.privateReady)).map(({ id, ...state }) => [id, state]));
    return files.map(file => {
      if (api.isPrivatePath(file.key) && !ready.current.privateReady) return { state: "none", blocked: "这台设备没有开启私密文件缓存，或私密空间未解锁" };
      const job = jobsRef.current.find(job => cacheFileId(job.file) === cacheFileId(file) && isRunning(job));
      if (job) return { state: "caching", percent: percentOf(job.bytes, job.size) };
      const state = index.get(cacheFileId(file));
      if (!state?.bytes) return { state: "none" };
      if (!state.complete) return { state: "partial", percent: percentOf(state.bytes, state.size || file.size) };
      return { state: state.manual ? "manual" : "auto" };
    });
  }, []);
  const visibleJobs = useMemo(() => enabled ? jobs : [], [enabled, jobs]);
  const activeCount = enabled ? jobs.filter(isRunning).length + folders.filter(folder => folder.status === "active").length : 0;
  useEffect(() => { onActiveChange?.(activeCount); }, [activeCount, onActiveChange]);
  const visibleFolders = useMemo(() => enabled ? folders : [], [enabled, folders]);
  const value: Queue = useMemo(() => ({ available, privateReady, privateEnabled: enabled && privateCacheEnabled, jobs: visibleJobs, folders: visibleFolders, enqueueFolders: startFolder, cancelFolder, retryFolder, states, cached, showTasks: onOpenTasks, watch, canCache, enqueue, enqueueMany, cancel, pause: pauseJob, retry, removeJobs,
    clear: () => update(value => value.filter(isRunning)), inspect: setDetails, remove: files => setRemoving(Array.isArray(files) ? files : [files]), forget, report }),
  [available, privateReady, privateCacheEnabled, enabled, visibleJobs, visibleFolders, startFolder, cancelFolder, retryFolder, states, cached, onOpenTasks, watch, canCache, enqueue, enqueueMany, cancel, pauseJob, retry, removeJobs, update, forget, report]);
  const detailState = details && (states.get(cacheFileId(details)) ?? cached.get(cacheFileId(details)));
  const detailManual = Boolean(details && cached.get(cacheFileId(details))?.manual);
  const showDetails = enabled && details && (!api.isPrivatePath(details.key) || privateReady);
  const showRemoving = enabled && removing && (privateReady || !removing.some(file => api.isPrivatePath(file.key)));
  return <CacheContext.Provider value={value}>
    {children}
    {showDetails && <Modal title="本机缓存" description={nameOf(details)} icon="monitor" size="sm" className={api.isPrivatePath(details.key) ? "private-dialog" : ""} onClose={() => setDetails(null)}
      footer={<>{(!detailState?.complete || !detailManual) && <Button icon="monitor" onClick={() => { enqueue(details); setDetails(null); }}>{detailState?.complete ? "标记为手动缓存" : "继续缓存"}</Button>}<Button variant="ghost" onClick={() => setDetails(null)}>完成</Button></>}>
      <KeyValue items={[["已缓存", `${formatBytes(detailState?.bytes ?? 0)} / ${formatBytes(details.size)}`]]} />
      <p className="muted">{detailState?.complete ? detailManual ? "完整文件已手动缓存，预览和下载时优先读取本机数据。" : "打开时已自动缓存完整文件，预览和下载优先读取本机数据。空间不够时，自动缓存会先被移除；标记为手动缓存后会尽量保留。" : "已完成的部分会保留，继续缓存只补齐缺失内容。"}仍需登录及有效授权；空间不足或浏览器清理时，缓存可能被移除。</p>
    </Modal>}
    {showRemoving && <ConfirmDialog title="清除本机缓存" className={removing.some(file => api.isPrivatePath(file.key)) ? "private-dialog" : ""} confirmLabel="清除缓存" onClose={() => setRemoving(null)}
      description={removing.length === 1 ? `清除“${nameOf(removing[0])}”在这台设备上的缓存？云端文件不受影响。` : `清除这 ${removing.length} 个文件在这台设备上的缓存？云端文件不受影响。`}
      onConfirm={async () => { try { await forget(removing); } finally { setRemoving(null); } }} />}
  </CacheContext.Provider>;
}

export function useCacheFiles(files: CacheFile[], enabled = true) {
  const queue = useContext(CacheContext), owner = useId();
  const signature = enabled ? files.map(file => `${cacheFileId(file)}:${file.key}`).join("\n") : "";
  const watch = queue?.watch;
  useEffect(() => { if (watch && enabled) return watch(owner, files); }, [watch, owner, signature, enabled]);
  return queue;
}

export const useCacheQueue = () => useContext(CacheContext);

function buttonState(queue: Queue, file: CacheFile, indexOnly = false) {
  const indexed = queue.cached.get(cacheFileId(file));
  const state = (indexOnly ? undefined : queue.states.get(cacheFileId(file))) ?? indexed, job = queue.jobs.find(job => cacheFileId(job.file) === cacheFileId(file));
  const running = job && isRunning(job);
  // 任务刚完成时索引可能还没刷新：以任务结果为准，不能闪回旧的百分比。
  const finished = !running && job?.status === "done";
  const complete = finished || !running && Boolean(state?.complete);
  const bytes = running ? job.bytes : finished ? job.size : state?.bytes ?? 0;
  // 只建了条目、还没写入任何数据（例如刚打开就关闭预览）不算已缓存。
  const present = Boolean(state?.complete || bytes);
  const percent = percentOf(bytes, running ? job.size : file.size, complete);
  const label = running ? job.status === "queued" ? "排队中" : "正在缓存" : complete ? "已缓存" : job?.status === "error" ? "重试缓存" : bytes ? "继续缓存" : "缓存到本机";
  return { running, complete, present, bytes, percent, label, error: job?.status === "error", manual: finished || Boolean(indexed?.manual) };
}

export function FileCacheButton({ file }: { file: CacheFile }) {
  const queue = useContext(CacheContext);
  // 不支持（如未启用 HTTPS 的部署）或已关闭时整个按钮都不显示，不在每一行留下禁用的按钮。
  if (!queue?.available) return null;
  const state = buttonState(queue, file);
  const automatic = state.complete && !state.manual;
  const label = state.complete ? `${automatic ? "已在本机（自动缓存）" : "已缓存到本机"}：${nameOf(file)}` : `${state.label} ${nameOf(file)}${state.bytes ? ` · ${state.percent}%` : ""}`;
  return <button type="button" className={`icon-btn icon-btn-ghost icon-btn-sm file-cache-button${state.complete ? " is-complete" : ""}${automatic ? " is-auto" : ""}${state.running ? " is-active" : ""}`} title={label} aria-label={label}
    onClick={event => { event.stopPropagation(); if (state.running) queue.showTasks(); else if (state.complete) queue.inspect(file); else queue.enqueue(file); }}>
    {state.bytes && !state.complete ? <><svg className="file-cache-ring" viewBox="0 0 20 20" aria-hidden="true" style={{ "--tray-progress": state.percent } as CSSProperties}><circle className="tray-ring-track" cx="10" cy="10" r="8" /><circle className="tray-ring-value" cx="10" cy="10" r="8" pathLength="100" /></svg><span>{state.percent}%</span></>
      : <Icon name={state.complete ? "hardDrive" : state.error ? "refresh" : state.running ? "pulse" : "monitor"} size={16} filled={state.complete && state.manual} />}
  </button>;
}

/** 文件列表与网格卡片上的缓存状态：完成时统一用硬盘图标，以绿色／灰色区分手动与自动缓存；另显示进度与失败。没有缓存时什么也不渲染。 */
export function FileCacheStatus({ file, className = "" }: { file: CacheFile; className?: string }) {
  const queue = useContext(CacheContext);
  if (!queue?.available) return null;
  const state = buttonState(queue, file, true);
  if (!state.running && !state.error && !state.present) return null;
  const name = nameOf(file), origin = state.manual ? "is-manual" : "is-auto";
  const [label, text, tone] = state.running ? [`${state.label} ${name} · ${state.percent}%`, `${state.percent}%`, "is-active"]
    : state.error ? [`缓存失败，点击重试：${name}`, "重试", "is-error"]
    : state.complete ? [`已${state.manual ? "手动" : "自动"}缓存到本机：${name}`, "", `is-complete ${origin}`]
    : [`${state.manual ? "已手动缓存" : "已自动缓存"} ${state.percent}%，点击继续：${name}`, `${state.percent}%`, `is-partial ${origin}`];
  return <button type="button" className={`file-cache-status ${tone} ${className}`} title={label} aria-label={label}
    onClick={event => { event.stopPropagation(); if (state.running) queue.showTasks(); else if (state.complete) queue.inspect(file); else queue.enqueue(file); }}>
    {state.complete ? <Icon name="hardDrive" size={16} filled={state.manual} /> : state.error ? <Icon name="refresh" size={12} />
      : <svg className="file-cache-ring" viewBox="0 0 20 20" aria-hidden="true" style={{ "--tray-progress": state.percent } as CSSProperties}><circle className="tray-ring-track" cx="10" cy="10" r="8" /><circle className="tray-ring-value" cx="10" cy="10" r="8" pathLength="100" /></svg>}
    {text && <span>{text}</span>}
  </button>;
}

export function cacheMenuItems(queue: Queue | null, file: CacheFile): MenuItem[] {
  if (!queue?.available || !queue.canCache(file)) return [];
  const state = buttonState(queue, file);
  return [{ label: state.complete && !state.manual ? "标记为手动缓存" : state.label, icon: "monitor", onSelect: () => state.running ? queue.showTasks() : state.complete && state.manual ? queue.inspect(file) : queue.enqueue(file) },
    ...(state.present || state.running ? [{ label: "清除本机缓存", icon: "trash" as const, divider: true, danger: true, onSelect: () => queue.remove(file) }] : [])];
}

/** 批量操作中的文件状态；文件夹由分页遍历单独处理。 */
export function cacheSelection(queue: Queue | null, files: CacheFile[]) {
  if (!queue?.available) return { cacheable: [], cached: [] };
  const usable = files.filter(queue.canCache);
  return {
    cacheable: usable.filter(file => { const state = buttonState(queue, file); return !state.running && !(state.complete && state.manual); }),
    cached: usable.filter(file => { const state = buttonState(queue, file); return state.present || state.running; }),
  };
}

const cacheGroup = (job: CacheJob): TaskFilter => job.status === "done" ? "done" : job.status === "error" ? "error" : job.status === "paused" || job.status === "canceled" ? "paused" : "active";
const cacheDescription = (job: CacheJob) => `${nameOf(job.file)} ${api.privatePathLabel(job.file.key)}`;
const folderOf = (key: string) => key.slice(0, key.lastIndexOf("/") + 1);
const CACHE_LABEL: Record<CacheJob["status"], string> = { queued: "排队中", active: "缓存中", paused: "已暂停", canceled: "已暂停", done: "已完成", error: "失败" };
const CACHE_TONE: Record<CacheJob["status"], "neutral" | "accent" | "success" | "danger" | "warning"> = { queued: "neutral", active: "accent", paused: "neutral", canceled: "neutral", done: "success", error: "danger" };
export type CacheTab = "tasks" | "files";

/** 任务中心 · 本机缓存：「缓存任务」管理手动缓存的进度，「已缓存的文件」浏览、清理这台设备上的副本。 */
export function CachePage({ tab, onTabChange, onSettings, onOpenFolder }: { tab: CacheTab; onTabChange: (tab: CacheTab) => void; onSettings: () => void; onOpenFolder: (prefix: string, privateSpace?: boolean) => void }) {
  useDocumentTitle(`本机缓存 · ${BRAND}`);
  const queue = useContext(CacheContext);
  const [stats, setStats] = useState<CacheStats | null>(null);
  // 浏览器配额：上限按「设置值与配额的较小者」显示，和 Worker 实际生效的容量一致。
  const [quota, setQuota] = useState<number | null>(null);
  const [directory, setDirectory] = useState<CacheDirectoryInfo | null>(null);
  useEffect(() => {
    if (!cacheSupported()) return;
    let alive = true;
    const read = () => void Promise.all([cacheStats(), cacheQuota(), cacheDirectoryInfo().catch(() => null)]).then(([value, limit, folder]) => {
      if (alive) { setStats(value); setQuota(limit); setDirectory(folder); }
    }).catch(() => undefined);
    read();
    window.addEventListener("tessera:cache-changed", read);
    const timer = window.setInterval(read, 15000);
    return () => { alive = false; window.removeEventListener("tessera:cache-changed", read); window.clearInterval(timer); };
  }, []);
  const header = <PageHeader title="本机缓存" description="把文件加密保存在这台设备的浏览器里，再次打开或离线查看时不必重新下载。手动缓存优先保留，空间不够时先移除自动缓存。"
    actions={<Button icon="settings" onClick={onSettings}>缓存设置</Button>} />;
  if (!cacheSupported() || !queue) return <div className="task-page cache-page">{header}
    <EmptyState icon="monitor" title="这个浏览器不能使用本机缓存" description="需要通过 https:// 地址访问，并使用较新的 Chrome、Edge、Firefox 或 Safari；隐私（无痕）模式下无法使用。" /></div>;
  return <div className="task-page cache-page">
    {header}
    <Tabs label="本机缓存" value={tab} onChange={onTabChange} options={[
      { value: "tasks", label: "缓存任务", icon: "list", count: queue.jobs.filter(isRunning).length || undefined },
      { value: "files", label: "已缓存的文件", icon: "hardDrive" },
    ]} />
    {directory && directory.permission !== "granted" && <Notice tone="warning" icon="folder">缓存文件夹「{directory.name}」需要重新授权，授权前不会缓存新文件。
      <button type="button" className="link-button" onClick={() => void regrantCacheDirectory().then(result => { if (result !== "granted") toast.error("没有获得文件夹的读写权限"); })}>重新授权</button></Notice>}
    {!queue.available && <Notice>本机缓存已关闭，或管理员未开放。可以在<button type="button" className="link-button" onClick={onSettings}>缓存设置</button>中开启。</Notice>}
    {tab === "tasks" ? <CacheTaskList queue={queue} stats={stats} quota={quota} onSettings={onSettings} onOpenFolder={onOpenFolder} />
      : <CachedFileList privateReady={queue.privateReady} privateEnabled={queue.privateEnabled} stats={stats} quota={quota} onOpenFolder={onOpenFolder} onSettings={onSettings} />}
  </div>;
}

/** 本机占用的概览卡片：普通层（与私密层）已用／上限。 */
function usageStat(stats: CacheStats | null, quota: number | null, onSettings: () => void): TaskStat {
  const used = stats ? stats.normal.bytes + stats.private.bytes : 0;
  const configured = stats ? (stats.settings.maxMiB + (stats.settings.private ? stats.settings.privateMaxMiB : 0)) * 1048576 : 0;
  const limit = quota ? Math.min(configured, quota) : configured;
  return { key: "usage", label: "本机占用", icon: "hardDrive", tone: limit && used / limit > 0.9 ? "danger" : "neutral", value: stats ? formatBytes(used) : "—",
    detail: stats ? `上限 ${formatBytes(limit)} · 点击调整` : "正在读取", onSelect: onSettings };
}

function CacheTaskList({ queue, stats, quota, onSettings, onOpenFolder }: { queue: Queue; stats: CacheStats | null; quota: number | null; onSettings: () => void; onOpenFolder: (prefix: string, privateSpace?: boolean) => void }) {
  const { jobs } = queue;
  const describe = useCallback((job: CacheJob) => api.isPrivatePath(job.file.key) && !queue.privateReady ? "私密文件" : cacheDescription(job), [queue.privateReady]);
  const list = useTaskList(jobs, describe, cacheGroup);
  const [removing, setRemoving] = useState<string[] | null>(null);
  const running = jobs.filter(isRunning);
  const rates = useTransferRates(running.filter(job => job.status === "active" && !job.waiting).map(job => [job.id, job.bytes]));
  const speed = running.reduce((sum, job) => sum + (rates.get(job.id) ?? 0), 0);
  const left = running.reduce((sum, job) => sum + Math.max(0, job.size - job.bytes), 0), total = running.reduce((sum, job) => sum + job.size, 0);
  const adding = queue.folders.filter(folder => folder.status === "active").length;
  const runningChosen = list.chosen.filter(isRunning);
  const resumable = list.chosen.filter(job => ["paused", "canceled", "error"].includes(job.status));
  const toggle = (filter: TaskFilter) => list.setFilter(list.filter === filter ? "" : filter);
  const [unlocking, setUnlocking] = useState(false);
  const closeUnlock = useCallback(() => setUnlocking(false), []);
  const hiddenPrivate = queue.privateReady ? 0 : jobs.filter(job => api.isPrivatePath(job.file.key)).length;
  return <>
    {hiddenPrivate > 0 && <Notice className="cached-private-notice" icon="lock" tone="warning">
      <span>私密空间已锁定：{hiddenPrivate} 个私密缓存任务仍在继续，名称和位置已隐藏。</span>
      <Button size="sm" variant="primary" icon="unlock" onClick={() => setUnlocking(true)}>解锁查看</Button></Notice>}
    {unlocking && <CacheUnlockDialog onClose={closeUnlock} />}
    <TaskStats label="缓存任务概览" progress={running.length ? { percent: total ? (total - left) / total * 100 : null, label: "进行中任务的总进度" } : null} items={[
      { key: "active", label: "进行中", icon: "monitor", tone: "accent", live: running.length + adding > 0, value: (running.length + adding).toLocaleString("zh-CN"),
        detail: running.length ? speed > 0 ? `${formatBytes(speed)}/s · ${remainingText(left / speed)}` : `剩余 ${formatBytes(left)}` : adding ? "正在读取文件夹" : "多线程分段缓存，播放与预览优先",
        selected: list.filter === "active", onSelect: () => toggle("active") },
      { key: "done", label: "已完成", icon: "checkCircle", tone: "success", value: list.counts.done.toLocaleString("zh-CN"), detail: "本次登录期间", selected: list.filter === "done", onSelect: () => toggle("done") },
      { key: "error", label: "失败", icon: "alert", tone: list.counts.error ? "danger" : "neutral", value: list.counts.error.toLocaleString("zh-CN"),
        detail: list.counts.error ? "空间不足等需手动处理" : "中断会自动重试", selected: list.filter === "error", onSelect: () => toggle("error") },
      usageStat(stats, quota, onSettings),
    ]} />
    {queue.folders.length > 0 && <div className="task-folder-notices">{queue.folders.map(folder => {
      const path = folder.prefixes.map(prefix => api.isPrivatePath(prefix) && !queue.privateReady ? "私密文件夹" : api.privatePathLabel(prefix)).join("、");
      return <Notice key={folder.id} className="task-folder-notice" icon="folder" tone={folder.status === "error" ? "danger" : "info"} role={folder.status === "error" ? "alert" : "status"}>
        <div className="task-folder-notice-main"><strong>{folder.status === "error" ? "文件夹未全部加入缓存" : "正在添加文件夹缓存"}</strong>
          <p className="task-folder-notice-path" title={path}>已加入 {folder.files} 个文件 · {path}</p>
          {folder.error && <p>{!queue.privateReady && folder.prefixes.some(api.isPrivatePath) ? "请解锁后查看具体原因" : folder.error}；已加入的文件任务会保留，重试会跳过已缓存或正在缓存的文件。</p>}
        </div>
        <div className="task-folder-notice-actions">
          {folder.status === "error" && <IconButton icon="refresh" label={`重试添加缓存：${path}`} disabled={!queue.available} onClick={() => queue.retryFolder(folder.id)} />}
          <IconButton icon="x" label={`${folder.status === "error" ? "移除提示" : "停止添加"}：${path}`} onClick={() => queue.cancelFolder(folder.id)} />
        </div>
      </Notice>;
    })}</div>}
    <TaskControls list={list} noun="缓存" menu={<Menu label="清理缓存任务记录" icon="trash" items={[
      { label: "清理已结束的记录", icon: "trash", danger: true, disabled: !jobs.some(job => !isRunning(job)), onSelect: () => setRemoving(jobs.filter(job => !isRunning(job)).map(job => job.id)) },
    ]} />} actions={<>
      {runningChosen.length > 0 && <Button size="sm" icon="pause" onClick={() => { runningChosen.forEach(job => queue.pause(job.id)); list.clearSelection(); }}>暂停</Button>}
      {resumable.length > 0 && <Button size="sm" icon="play" disabled={!queue.available} onClick={() => { resumable.forEach(job => queue.retry(job.id)); list.clearSelection(); }}>继续</Button>}
      <Menu label="所选缓存的更多操作" items={[
        { label: "清除所选文件的本机缓存", icon: "trash", danger: true, disabled: !queue.privateReady && list.chosen.some(job => api.isPrivatePath(job.file.key)), onSelect: () => queue.remove(list.chosen.map(job => job.file)) },
        { label: "删除所选任务记录", icon: "x", danger: true, divider: true, onSelect: () => setRemoving(list.chosen.map(job => job.id)) },
      ]} />
    </>} />
    <div className="file-surface task-surface">
      {!list.visible.length ? queue.folders.length ? null : <EmptyState icon="monitor" title={jobs.length ? "没有符合条件的缓存任务" : "还没有缓存任务"}
        description={jobs.length ? "试试其他名称或任务状态。" : "在文件或文件夹菜单中选择「缓存到本机」，完整文件会保存到这台设备，离线也能打开。"}
        action={jobs.length ? <Button onClick={list.clearFilters}>清除筛选</Button> : undefined} />
        : <div className="data-table task-table cache-table" role="table" aria-label="缓存任务">
          <div className="data-row data-head" role="row">
            <span className="cell-check" role="columnheader"><Checkbox checked={list.allSelected} indeterminate={list.chosen.length > 0 && !list.allSelected} label="选择本页全部缓存任务" onChange={list.selectPage} /></span>
            <span role="columnheader">文件</span><span role="columnheader">进度</span><span role="columnheader">位置</span><span role="columnheader">状态</span>
            <span className="cell-actions" role="columnheader"><span className="sr-only">操作</span></span>
          </div>
          {list.visible.map(job => {
            const running = isRunning(job), hidden = api.isPrivatePath(job.file.key) && !queue.privateReady;
            const name = hidden ? "私密文件" : nameOf(job.file), folder = folderOf(job.file.key), secret = api.isPrivatePath(job.file.key);
            const checked = list.selected.has(job.id);
            const quick = running ? <IconButton icon="pause" size="sm" label={`暂停缓存 ${name}`} onClick={() => queue.pause(job.id)} />
              : job.status !== "done" ? <IconButton icon="play" size="sm" label={`继续缓存 ${name}`} disabled={!queue.available} onClick={() => queue.retry(job.id)} />
                : <IconButton icon="info" size="sm" label={`查看 ${name} 的缓存`} disabled={hidden} onClick={() => queue.inspect(job.file)} />;
            return <div key={job.id} className={`data-row task-item is-${job.status}${secret ? " is-private" : ""}${checked ? " is-selected" : ""}`} role="row">
              <span className="cell-check" role="cell"><Checkbox checked={checked} label={`选择 ${name}`} onChange={value => list.toggle(job.id, value)} /></span>
              <div className="cell-name" role="cell">
                {hidden ? <span className="task-lock-tile"><Icon name="lock" size={18} /></span>
                  : <span className="cached-tile"><FileTile kind={getFileKind(job.file.content_type, job.file.key)} />{secret && <span className="cached-tile-lock" aria-hidden="true"><Icon name="lock" size={10} /></span>}</span>}
                <div className="name-stack"><strong className="task-name" title={name}>{name}{secret && !hidden && <span className="cached-private-tag"><Icon name="lock" size={10} />私密</span>}</strong><small className="task-subline">{formatBytes(job.size)}</small></div>
              </div>
              <div role="cell"><CacheProgress job={job} rate={rates.get(job.id) ?? 0} hidden={hidden} /></div>
              <div role="cell" className="muted">{hidden ? <span className="task-location"><Icon name="lock" size={12} /><span className="task-location-text"><span>私密空间已锁定</span></span></span>
                : <button type="button" className="task-location" title={`打开所在文件夹：${api.privatePathLabel(folder)}`} onClick={() => onOpenFolder(folder, secret)}>
                  <Icon name={secret ? "lock" : "folder"} size={12} /><LocationText folder={folder} /></button>}</div>
              <div className="task-state" role="cell"><Badge tone={job.retrying ? "warning" : CACHE_TONE[job.status]} dot={job.status !== "done"} icon={job.status === "done" ? "check" : undefined}>
                {job.retrying ? "自动重试" : job.status === "queued" && job.waiting ? "等待中" : CACHE_LABEL[job.status]}</Badge></div>
              <div className="cell-actions" role="cell">{quick}<Menu label={`${name} 的更多操作`} items={[
                ...(!hidden ? [{ label: "打开所在文件夹", icon: "folder" as const, onSelect: () => onOpenFolder(folder, secret) }] : []),
                ...(job.status === "error" && !hidden ? [{ label: "复制失败原因", icon: "alert" as const, onSelect: () => void copyText(job.error, "失败原因已复制") }] : []),
                { label: "清除文件的本机缓存", icon: "trash", danger: true, divider: true, disabled: hidden, onSelect: () => queue.remove(job.file) },
                { label: "删除任务记录", icon: "x", danger: true, onSelect: () => setRemoving([job.id]) },
              ]} /></div>
            </div>;
          })}
        </div>}
    </div>
    <TaskListFooter list={list} />
    {removing && <ConfirmDialog title={`删除 ${removing.length} 个缓存任务记录？`} confirmLabel="删除记录" description="所选任务会停止并从列表移除，已经缓存的内容和云端文件会保留。如需释放本机空间，请选择「清除文件的本机缓存」。"
      onClose={() => setRemoving(null)} onConfirm={() => { queue.removeJobs(removing); setRemoving(null); list.clearSelection(); }} />}
  </>;
}

function CacheProgress({ job, rate, hidden }: { job: CacheJob; rate: number; hidden: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (job.status === "done") return <div className="task-progress is-done"><span className="task-figure">{formatBytes(job.size)}</span><small>完整文件已保存到这台设备</small></div>;
  if (job.status === "error") {
    const message = hidden ? "缓存失败，请解锁后查看详情" : job.error || "缓存失败";
    return <button type="button" className={`task-failure${expanded ? " is-expanded" : ""}`} title={expanded ? "收起" : message} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <Icon name="alert" size={13} /><span>{message}</span></button>;
  }
  const percent = percentOf(job.bytes, job.size);
  const detail = job.retrying ? `连接中断，正在第 ${job.retrying} 次自动重试，已缓存的部分会保留`
    : job.status === "queued" ? job.waiting ? "其他页面正在缓存，完成后自动开始" : `${formatBytes(job.bytes)} / ${formatBytes(job.size)} · 等待开始`
      : job.status === "paused" || job.status === "canceled" ? `${formatBytes(job.bytes)} / ${formatBytes(job.size)} · 已暂停，已缓存的部分会保留`
        : [`${formatBytes(job.bytes)} / ${formatBytes(job.size)}`, rate > 0 && `${formatBytes(rate)}/s`, rate > 0 && remainingText(Math.max(0, job.size - job.bytes) / rate)].filter(Boolean).join(" · ");
  return <div className={`task-progress is-${job.retrying ? "interrupted" : job.status}`}>
    <div className="task-progress-bar"><Progress value={percent} tone={job.status === "active" && !job.retrying ? "accent" : "neutral"} label={`缓存进度`} /><span className="task-percent">{percent}%</span></div>
    <small title={detail}>{detail}</small>
  </div>;
}

const CACHED_PAGE = 50;
type CachedOrigin = "" | "manual" | "auto";
type CachedTier = "all" | "normal" | "private";

/** 私密缓存的解锁：使用统一的解锁弹窗，解锁成功后自动关闭，列表随授权变化重新读取。 */
function CacheUnlockDialog({ onClose }: { onClose: () => void }) {
  return <PrivateUnlockDialog description="解锁后即可查看和管理这台设备上缓存的私密文件。" onClose={onClose} onUnlocked={onClose} />;
}

/** 已缓存的文件：普通文件与私密空间分开统计，「全部」把两者合在一起并用锁形标记区分；私密空间锁定时提示解锁后再读取。 */
function CachedFileList({ privateReady, privateEnabled, stats, quota, onOpenFolder, onSettings }: { privateReady: boolean; privateEnabled: boolean; stats: CacheStats | null; quota: number | null; onOpenFolder: (prefix: string, privateSpace?: boolean) => void; onSettings: () => void }) {
  const [tier, setTier] = useState<CachedTier>("all");
  const [search, setSearch] = useState(""), [query, setQuery] = useState("");
  const [kind, setKind] = useState<"" | "image" | "video" | "audio" | "other">("");
  const [origin, setOrigin] = useState<CachedOrigin>("");
  const [sort, setSort] = useState<"recent" | "size" | "name">("recent");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Awaited<ReturnType<typeof cachedItems>> | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const [removing, setRemoving] = useState<CachedItem[] | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [revision, setRevision] = useState(0);
  const closeUnlock = useCallback(() => setUnlocking(false), []);
  // 未完成的文件（暂停、失败或只缓存了看过的片段）可以直接继续缓存：按记录的内容版本重新加入缓存任务，只补缺失的部分。
  const queue = useContext(CacheContext);
  const fileOf = (item: CachedItem): CacheFile => ({ key: item.path, etag: item.etag, size: item.size, content_type: item.type || null });
  const resumable = (item: CachedItem) => !item.complete && Boolean(item.etag) && Boolean(queue?.canCache(fileOf(item)));
  const cachingJob = (item: CachedItem) => queue?.jobs.find(job => isRunning(job) && cacheFileId(job.file) === cacheFileId(fileOf(item)));
  const resume = (targets: CachedItem[]) => {
    if (!queue) return;
    const files = targets.filter(item => resumable(item) && !cachingJob(item)).map(fileOf);
    if (!files.length) { toast.info("所选文件已完整缓存或正在缓存"); return; }
    const added = queue.enqueueMany(files);
    if (added) toast.success(added === 1 ? "已继续缓存，只补齐缺失的部分" : `已继续缓存 ${added} 个文件`, { label: "查看任务", onClick: queue.showTasks });
    else toast.info("所选文件已在缓存任务中");
    setSelected(new Set());
  };
  const resumableChosen = (items: CachedItem[]) => items.filter(item => resumable(item) && !cachingJob(item));
  // 私密层：这台设备允许缓存私密文件（或仍留有私密副本）时才出现；锁定时只能看到数量与大小。
  const privateCount = stats?.private.count ?? 0, privateBytes = stats?.private.bytes ?? 0;
  const showPrivate = privateEnabled || privateCount > 0;
  const privateLocked = showPrivate && !privateReady;
  const waitingUnlock = tier === "private" && privateLocked;
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search.trim()), 250); return () => window.clearTimeout(timer); }, [search]);
  useEffect(() => { setOffset(0); setSelected(new Set()); }, [tier, query, kind, origin, sort, privateReady]);
  useEffect(() => { if (!showPrivate && tier === "private") setTier("all"); }, [showPrivate, tier]);
  useEffect(() => {
    const changed = () => setRevision(value => value + 1);
    window.addEventListener("tessera:cache-changed", changed);
    return () => window.removeEventListener("tessera:cache-changed", changed);
  }, []);
  useEffect(() => {
    if (waitingUnlock) { setPage(null); return; }
    let alive = true;
    setError("");
    const scope = tier === "all" ? { all: true } : { private: tier === "private" };
    void cachedItems({ ...scope, query, kind, origin, sort, offset, limit: CACHED_PAGE })
      .then(value => { if (alive) { setPage(value); setSelected(current => new Set([...current].filter(key => value.items.some(item => item.key === key)))); } })
      .catch(reason => { if (alive) setError(api.errorMessage(reason, "读取本机缓存失败，请刷新页面后重试")); });
    return () => { alive = false; };
  }, [tier, query, kind, origin, sort, offset, revision, privateReady, waitingUnlock]);
  const items = page?.items ?? [];
  const chosen = items.filter(item => selected.has(item.key));
  const allSelected = items.length > 0 && chosen.length === items.length;
  const filtered = Boolean(query || kind || origin);
  const limitOf = (mib: number | undefined) => mib ? ` / 上限 ${formatBytes(effectiveMiB(mib, quota) * 1048576)}` : "";
  const toggleTier = (value: CachedTier) => setTier(tier === value ? "all" : value);
  const unlockAction = <Button size="sm" variant="primary" icon="unlock" onClick={() => setUnlocking(true)}>解锁查看</Button>;
  return <>
    <TaskStats label="已缓存文件概览" items={[
      { key: "normal", label: "普通文件", icon: "folder", value: stats ? stats.normal.count.toLocaleString("zh-CN") : "—",
        detail: stats ? `${formatBytes(stats.normal.bytes)}${limitOf(stats.settings.maxMiB)}` : "正在读取", selected: tier === "normal", onSelect: () => toggleTier("normal") },
      ...(showPrivate ? [{ key: "private", label: "私密空间", icon: "lock" as const, tone: "warning" as const, value: stats ? privateCount.toLocaleString("zh-CN") : "—",
        detail: privateLocked ? `${formatBytes(privateBytes)} · 已锁定，解锁后查看` : `${formatBytes(privateBytes)}${limitOf(stats?.settings.privateMaxMiB)}`,
        selected: tier === "private", onSelect: () => toggleTier("private") }] : []),
      { key: "manual", label: "手动缓存", icon: "pin", tone: "success", value: page && !filtered ? page.manual.toLocaleString("zh-CN") : "—", detail: "优先保留，不会被自动移除",
        selected: origin === "manual", onSelect: () => setOrigin(origin === "manual" ? "" : "manual") },
      usageStat(stats, quota, onSettings),
    ]} />
    {privateLocked && tier === "all" && privateCount > 0 && <Notice className="cached-private-notice" icon="lock" tone="warning">
      <span>私密空间已锁定：这台设备还缓存了 {privateCount.toLocaleString("zh-CN")} 个私密文件（{formatBytes(privateBytes)}），解锁后一并显示。</span>{unlockAction}</Notice>}
    <div className="toolbar task-search cached-search">
      {showPrivate && <Segmented label="缓存范围" showLabels value={tier} onChange={setTier} options={[
        { value: "all", label: "全部" }, { value: "normal", label: "普通文件", icon: "folder" }, { value: "private", label: "私密空间", icon: "lock" },
      ]} />}
      <SearchInput value={search} onChange={setSearch} placeholder="搜索文件名或路径" label="搜索已缓存的文件" />
    </div>
    {!waitingUnlock && <div className="task-controls">
      {chosen.length > 0 && <div className="toolbar selection-bar task-selection" role="toolbar" aria-label="已缓存文件批量操作">
        <Checkbox checked={allSelected} indeterminate={!allSelected} label="选择本页全部文件" onChange={checked => setSelected(checked ? new Set(items.map(item => item.key)) : new Set())} />
        <span className="selection-count"><span className="task-selection-prefix">已选择 </span>{chosen.length} 项 · {formatBytes(chosen.reduce((sum, item) => sum + item.bytes, 0))}</span>
        <div className="toolbar-actions">{resumableChosen(chosen).length > 0 && <Button size="sm" icon="monitor" onClick={() => resume(chosen)}>继续缓存{chosen.length > 1 ? `（${resumableChosen(chosen).length}）` : ""}</Button>}<Button size="sm" variant="danger" icon="trash" onClick={() => setRemoving(chosen)}>清除缓存</Button><IconButton icon="x" label="取消选择" size="sm" onClick={() => setSelected(new Set())} /></div>
      </div>}
      <div className={`task-toolbar${chosen.length ? " is-selecting" : ""}`} aria-hidden={chosen.length > 0}>
        <Segmented label="文件类型" showLabels value={kind} onChange={setKind} options={[
          { value: "", label: "全部类型" }, { value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" }, { value: "other", label: "其他" },
        ]} />
        <span className="task-toolbar-meta">
          <span className="muted">{page ? `${page.total.toLocaleString("zh-CN")} 个文件 · ${formatBytes(page.bytes)}` : "正在读取"}</span>
          <Menu label={`来源：${origin === "manual" ? "手动缓存" : origin === "auto" ? "自动缓存" : "全部"}`} icon="pin" items={[
            { label: "全部来源", icon: "list", checked: origin === "", onSelect: () => setOrigin("") },
            { label: "手动缓存", icon: "pin", checked: origin === "manual", onSelect: () => setOrigin("manual") },
            { label: "自动缓存", icon: "refresh", checked: origin === "auto", onSelect: () => setOrigin("auto") },
          ]} />
          <Menu label={`排序：${sort === "recent" ? "最近使用" : sort === "size" ? "占用空间" : "名称"}`} icon="sequence" items={[
            { label: "最近使用", icon: "clock", checked: sort === "recent", onSelect: () => setSort("recent") },
            { label: "占用空间", icon: "hardDrive", checked: sort === "size", onSelect: () => setSort("size") },
            { label: "名称", icon: "fileText", checked: sort === "name", onSelect: () => setSort("name") },
          ]} />
        </span>
      </div>
    </div>}
    <div className="file-surface task-surface">
      {waitingUnlock ? <EmptyState icon="lock" title="私密空间已锁定"
        description={privateCount ? `这台设备缓存了 ${privateCount.toLocaleString("zh-CN")} 个私密文件（${formatBytes(privateBytes)}）。解锁私密空间后才能查看名称与位置、清除缓存。` : "解锁私密空间后查看这台设备上缓存的私密文件。"}
        action={unlockAction} />
        : error ? <EmptyState icon="alert" title="读取失败" description={error} action={<Button onClick={() => setRevision(value => value + 1)}>重试</Button>} />
        : !page ? <SkeletonRows rows={5} />
          : !items.length ? <EmptyState icon={tier === "private" ? "lock" : "hardDrive"} title={filtered ? "没有符合条件的文件" : tier === "private" ? "这台设备上还没有缓存私密文件" : "这台设备上还没有缓存"}
            description={filtered ? "试试其他名称、类型或来源。" : tier === "private" && !privateEnabled ? "在本机缓存设置中「信任这台设备」后，私密文件也可以缓存。" : "预览过的文件会自动缓存；在文件菜单中选择「缓存到本机」可以完整保存并优先保留。"}
            action={filtered ? <Button onClick={() => { setSearch(""); setQuery(""); setKind(""); setOrigin(""); }}>清除筛选</Button> : tier === "private" && !privateEnabled ? <Button onClick={onSettings}>缓存设置</Button> : undefined} />
            : <div className="data-table task-table cached-table" role="table" aria-label="已缓存的文件">
              <div className="data-row data-head" role="row">
                <span className="cell-check" role="columnheader"><Checkbox checked={allSelected} indeterminate={chosen.length > 0 && !allSelected} label="选择本页全部文件" onChange={checked => setSelected(checked ? new Set(items.map(item => item.key)) : new Set())} /></span>
                <span role="columnheader">文件</span><span role="columnheader">已缓存</span><span role="columnheader">位置</span><span role="columnheader">来源</span>
                <span className="cell-actions" role="columnheader"><span className="sr-only">操作</span></span>
              </div>
              {items.map(item => {
                const name = item.path.split("/").at(-1) || item.path, folder = folderOf(item.path), checked = selected.has(item.key), secret = item.private;
                return <div key={item.key} className={`data-row task-item${secret ? " is-private" : ""}${checked ? " is-selected" : ""}`} role="row">
                  <span className="cell-check" role="cell"><Checkbox checked={checked} label={`选择 ${name}`} onChange={value => setSelected(current => { const next = new Set(current); if (value) next.add(item.key); else next.delete(item.key); return next; })} /></span>
                  <div className="cell-name" role="cell">
                    <span className="cached-tile"><FileTile kind={item.kind === "thumb" ? "image" : getFileKind(null, item.path)} />{secret && <span className="cached-tile-lock" aria-hidden="true"><Icon name="lock" size={10} /></span>}</span>
                    <div className="name-stack"><strong className="task-name" title={name}>{name}{secret && <span className="cached-private-tag"><Icon name="lock" size={10} />私密</span>}</strong>
                      <small className="task-subline">最近使用 {formatDateTime(item.accessed / 1000)}</small></div></div>
                  <div role="cell"><div className="task-progress is-done">
                    {item.complete ? <span className="task-figure">{formatBytes(item.bytes)}</span>
                      : <div className="task-progress-bar"><Progress value={percentOf(item.bytes, item.size)} tone="neutral" label={`${name} 已缓存比例`} /><span className="task-percent">{percentOf(item.bytes, item.size)}%</span></div>}
                    <small>{item.complete ? "完整文件" : cachingJob(item) ? `${formatBytes(item.bytes)} / ${formatBytes(item.size)} · 正在缓存` : `${formatBytes(item.bytes)} / ${formatBytes(item.size)}（${item.manual ? "未完成" : "看过的片段"}）`}</small></div></div>
                  <div role="cell" className="muted"><button type="button" className="task-location" title={`打开所在文件夹：${api.privatePathLabel(folder)}`} onClick={() => onOpenFolder(folder, secret)}>
                    <Icon name={secret ? "lock" : "folder"} size={12} /><LocationText folder={folder} /></button></div>
                  <div className="task-state" role="cell"><Badge tone={item.manual ? "success" : "neutral"} icon={item.manual ? "pin" : undefined}>{item.manual ? "手动" : "自动"}</Badge></div>
                  <div className="cell-actions" role="cell">
                    {resumable(item) && (cachingJob(item)
                      ? <IconButton icon="pulse" size="sm" label={`正在缓存 ${name}，查看缓存任务`} onClick={() => queue?.showTasks()} />
                      : <IconButton icon="monitor" size="sm" label={`继续缓存 ${name}`} onClick={() => resume([item])} />)}
                    <IconButton icon="trash" size="sm" label={`清除 ${name} 的本机缓存`} onClick={() => setRemoving([item])} /></div>
                </div>;
              })}
            </div>}
    </div>
    {page && !waitingUnlock && page.total > CACHED_PAGE && <footer className="list-footer task-footer"><Pagination number={Math.floor(offset / CACHED_PAGE) + 1} total={page.total} pageSize={CACHED_PAGE} loading={false}
      hasPrevious={offset > 0} hasNext={offset + CACHED_PAGE < page.total} previous={() => setOffset(Math.max(0, offset - CACHED_PAGE))} next={() => setOffset(offset + CACHED_PAGE)} /></footer>}
    {unlocking && <CacheUnlockDialog onClose={closeUnlock} />}
    {removing && <ConfirmDialog title={removing.length === 1 ? "清除本机缓存？" : `清除 ${removing.length} 个文件的本机缓存？`} confirmLabel="清除缓存"
      className={removing.some(item => item.private) ? "private-dialog" : ""}
      description={`${removing.length === 1 ? `“${removing[0].path.split("/").at(-1)}”` : "所选文件"}在这台设备上的副本会被删除，释放 ${formatBytes(removing.reduce((sum, item) => sum + item.bytes, 0))}。云端文件不受影响。`}
      onClose={() => setRemoving(null)} onConfirm={async () => {
        try { for (const item of removing) await clearCache("entry", item.key); toast.success("已清除本机缓存"); }
        catch (reason) { toast.error(api.errorMessage(reason, "清除失败，请稍后重试")); }
        finally { setRemoving(null); setSelected(new Set()); setRevision(value => value + 1); }
      }} />}
  </>;
}
