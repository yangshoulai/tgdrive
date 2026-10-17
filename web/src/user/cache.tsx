import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import * as api from "../api";
import { beginFileCache, cachedFiles, cacheFileId, cacheStats, cacheSupported, cancelFileCache, removeFileCache, stepFileCache, type CacheFile, type FileCacheState } from "../cache-client";
import { Button, ConfirmDialog, Icon, IconButton, KeyValue, Modal, formatBytes, type MenuItem } from "../ui";
import { usePrivateAccess } from "./private-session";
import { TrayBar, TrayRing } from "./tray";

type CacheJob = { id: string; file: CacheFile; status: "queued" | "active" | "done" | "error" | "canceled"; bytes: number; size: number; error: string; waiting: boolean };
type Queue = {
  /** 浏览器支持且用户与管理员都没有关闭本机缓存；否则不显示缓存按钮与菜单项。 */
  available: boolean;
  jobs: CacheJob[]; states: Map<string, FileCacheState>; expanded: boolean; setExpanded: (value: boolean) => void;
  watch: (owner: string, files: CacheFile[]) => () => void; enqueue: (file: CacheFile) => void;
  cancel: (id: string) => void; retry: (id: string) => void; clear: () => void;
  inspect: (file: CacheFile) => void; remove: (file: CacheFile) => void;
};
const CacheContext = createContext<Queue | null>(null);
const nameOf = (file: CacheFile) => file.key.split("/").at(-1) || file.key;
const isRunning = (job: CacheJob) => job.status === "queued" || job.status === "active";
const percentOf = (bytes: number, size: number, complete = false) => complete ? 100 : size ? Math.min(99, Math.floor(bytes / size * 100)) : 0;

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DOMException("缓存已取消", "AbortError")); };
    const timer = setTimeout(finish, 1500);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

/** 队列属于已登录的应用外壳。切换目录继续，离开私密区域立即移除私密任务及文件名。 */
export function CacheTasksProvider({ enabled, privateAllowed, children }: { enabled: boolean; privateAllowed: boolean; children: ReactNode }) {
  const access = usePrivateAccess();
  const privateReady = enabled && privateAllowed && Boolean(access.grant);
  const [jobs, setJobs] = useState<CacheJob[]>([]), jobsRef = useRef(jobs);
  const [states, setStates] = useState(new Map<string, FileCacheState>());
  const statesRef = useRef(states); statesRef.current = states;
  const [expanded, setExpanded] = useState(true), [wake, setWake] = useState(0);
  const [details, setDetails] = useState<CacheFile | null>(null), [removing, setRemoving] = useState<CacheFile | null>(null);
  const active = useRef<{ id: string; controller: AbortController } | null>(null);
  const watching = useRef(new Map<string, CacheFile[]>()), ready = useRef({ enabled, privateReady });
  ready.current = { enabled, privateReady };
  const refreshRef = useRef<() => void>(() => undefined);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!enabled || !cacheSupported()) { setAvailable(false); return; }
    let alive = true;
    const read = () => void cacheStats().then(value => { if (alive) setAvailable(value.settings.enabled && value.policy?.enabled !== false); }).catch(() => undefined);
    read();
    window.addEventListener("tessera:cache-changed", read);
    return () => { alive = false; window.removeEventListener("tessera:cache-changed", read); };
  }, [enabled]);
  const update = useCallback((apply: (value: CacheJob[]) => CacheJob[]) => { jobsRef.current = apply(jobsRef.current); setJobs(jobsRef.current); }, []);
  const cancel = useCallback((id: string) => {
    if (active.current?.id === id) { active.current.controller.abort(); cancelFileCache(id); }
    update(value => value.map(job => job.id === id && isRunning(job) ? { ...job, status: "canceled" } : job));
  }, [update]);
  const reset = useCallback((privateOnly: boolean) => {
    const selected = jobsRef.current.filter(job => !privateOnly || api.isPrivatePath(job.file.key));
    selected.forEach(job => { if (active.current?.id === job.id) { active.current.controller.abort(); cancelFileCache(job.id); } });
    update(value => privateOnly ? value.filter(job => !api.isPrivatePath(job.file.key)) : []);
    setStates(value => new Map([...value].filter(([key]) => privateOnly && !key.startsWith("p:"))));
    setDetails(value => value && (!privateOnly || api.isPrivatePath(value.key)) ? null : value);
    setRemoving(value => value && (!privateOnly || api.isPrivatePath(value.key)) ? null : value);
  }, [update]);
  useLayoutEffect(() => { if (!enabled) reset(false); else if (!privateReady) reset(true); }, [enabled, privateReady, reset]);
  useEffect(() => {
    const stop = () => reset(false);
    const locked = () => reset(true);
    window.addEventListener("pagehide", stop); window.addEventListener("tessera:logout", stop); window.addEventListener("tessera:private-locked", locked);
    return () => { window.removeEventListener("pagehide", stop); window.removeEventListener("tessera:logout", stop); window.removeEventListener("tessera:private-locked", locked); active.current?.controller.abort(); cancelFileCache(active.current?.id); };
  }, [reset]);

  // 可见文件合并为一批查询；不逐行轮询，也不扫描整个本机缓存。
  useEffect(() => {
    if (!enabled || !available) return;
    let disposed = false, pending = false, timer: number | undefined;
    const schedule = (delay: number) => { clearTimeout(timer); timer = window.setTimeout(() => void refresh(), delay); };
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
      pending = false;
      // 空闲时状态只会因预览自动缓存而变化，一分钟刷新一次即可；私密空间每次查询都要向服务端验权。
      if (!disposed) schedule(jobsRef.current.some(isRunning) ? 2000 : 60000);
    }
    refreshRef.current = () => schedule(80);
    const visible = () => { if (!document.hidden) schedule(0); };
    window.addEventListener("tessera:cache-changed", refreshRef.current); window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    schedule(0);
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener("tessera:cache-changed", refreshRef.current); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); refreshRef.current = () => undefined; };
  }, [enabled, available, privateReady]);
  const watch = useCallback((owner: string, files: CacheFile[]) => {
    watching.current.set(owner, files); refreshRef.current();
    return () => { watching.current.delete(owner); };
  }, []);
  const enqueue = useCallback((file: CacheFile) => {
    if (!ready.current.enabled || api.isPrivatePath(file.key) && !ready.current.privateReady || !cacheSupported()) return;
    setExpanded(true);
    update(value => {
      const found = value.find(job => cacheFileId(job.file) === cacheFileId(file));
      if (found && isRunning(found)) return value;
      return [...value.filter(job => job !== found), { id: crypto.randomUUID(), file, status: "queued", bytes: statesRef.current.get(cacheFileId(file))?.bytes ?? found?.bytes ?? 0, size: file.size, error: "", waiting: false }];
    });
  }, [update]);
  const retry = useCallback((id: string) => { const job = jobsRef.current.find(job => job.id === id); if (job) enqueue(job.file); }, [enqueue]);

  useEffect(() => {
    if (!enabled || active.current) return;
    const job = jobs.find(job => job.status === "queued" && (!api.isPrivatePath(job.file.key) || privateReady));
    if (!job) return;
    const controller = new AbortController(), running = { id: job.id, controller };
    active.current = running;
    const patch = (value: Partial<CacheJob>) => {
      if (!controller.signal.aborted) update(jobs => jobs.map(item => item.id === job.id ? { ...item, ...value } : item));
    };
    const progress = (state: FileCacheState) => {
      if (controller.signal.aborted) return;
      patch({ bytes: state.bytes, size: state.size });
      setStates(value => new Map(value).set(cacheFileId(job.file), state));
    };
    void (async () => {
      try {
        let result;
        do {
          patch({ status: "active", waiting: false });
          result = await beginFileCache(job.file, job.id, controller.signal);
          if (result.busy) { patch({ status: "queued", waiting: true }); await pause(controller.signal); }
        } while (result.busy);
        progress(result);
        let state: FileCacheState = result;
        while (!state.complete) { state = await stepFileCache(job.id, controller.signal, progress); progress(state); }
        patch({ status: "done" });
      } catch (reason) {
        if (!controller.signal.aborted) patch({ status: "error", error: api.errorMessage(reason, "缓存失败，请重试") });
      } finally {
        cancelFileCache(job.id);
        if (active.current === running) active.current = null;
        setWake(value => value + 1); refreshRef.current();
      }
    })();
  }, [jobs, enabled, privateReady, wake, update]);

  const visibleJobs = useMemo(() => enabled ? jobs.filter(job => !api.isPrivatePath(job.file.key) || privateReady) : [], [enabled, jobs, privateReady]);
  const value: Queue = useMemo(() => ({ available, jobs: visibleJobs, states, expanded, setExpanded, watch, enqueue, cancel, retry,
    clear: () => update(value => value.filter(isRunning)), inspect: setDetails, remove: setRemoving }), [available, visibleJobs, states, expanded, watch, enqueue, cancel, retry, update]);
  const detailState = details && states.get(cacheFileId(details));
  const showDetails = enabled && details && (!api.isPrivatePath(details.key) || privateReady);
  const showRemoving = enabled && removing && (!api.isPrivatePath(removing.key) || privateReady);
  return <CacheContext.Provider value={value}>
    {children}
    {showDetails && <Modal title="本机缓存" description={nameOf(details)} icon="monitor" size="sm" className={api.isPrivatePath(details.key) ? "private-dialog" : ""} onClose={() => setDetails(null)}
      footer={<>{!detailState?.complete && <Button icon="monitor" onClick={() => { enqueue(details); setDetails(null); }}>继续缓存</Button>}<Button variant="ghost" onClick={() => setDetails(null)}>完成</Button></>}>
      <KeyValue items={[["已缓存", `${formatBytes(detailState?.bytes ?? 0)} / ${formatBytes(details.size)}`]]} />
      <p className="muted">{detailState?.complete ? "完整文件已缓存，预览和下载时优先读取本机数据。" : "已完成的部分会保留，继续缓存只补齐缺失内容。"}仍需登录及有效授权；空间不足或浏览器清理时，缓存可能被移除。</p>
    </Modal>}
    {showRemoving && <ConfirmDialog title="移除本机缓存" className={api.isPrivatePath(removing.key) ? "private-dialog" : ""} description={`移除“${nameOf(removing)}”的本机缓存？云端文件不受影响。`} confirmLabel="移除缓存" onClose={() => setRemoving(null)} onConfirm={async () => {
      jobsRef.current.filter(job => cacheFileId(job.file) === cacheFileId(removing)).forEach(job => cancel(job.id));
      await removeFileCache(removing);
      update(value => value.filter(job => cacheFileId(job.file) !== cacheFileId(removing)));
      setStates(value => { const next = new Map(value); next.delete(cacheFileId(removing)); return next; });
      setRemoving(null);
    }} />}
  </CacheContext.Provider>;
}

export function useCacheFiles(files: CacheFile[], enabled = true) {
  const queue = useContext(CacheContext), owner = useId();
  const signature = enabled ? files.map(file => `${cacheFileId(file)}:${file.key}`).join("\n") : "";
  const watch = queue?.watch;
  useEffect(() => { if (watch && enabled) return watch(owner, files); }, [watch, owner, signature, enabled]);
  return queue;
}

function buttonState(queue: Queue, file: CacheFile) {
  const state = queue.states.get(cacheFileId(file)), job = queue.jobs.find(job => cacheFileId(job.file) === cacheFileId(file));
  const running = job && isRunning(job);
  const complete = !running && Boolean(state?.complete);
  const bytes = running ? job.bytes : state?.bytes ?? 0;
  const percent = percentOf(bytes, running ? job.size : file.size, complete);
  const label = running ? job.status === "queued" ? "排队中" : "正在缓存" : complete ? "已缓存" : job?.status === "error" ? "重试缓存" : bytes ? "继续缓存" : "缓存到本机";
  return { running, complete, bytes, percent, label, error: job?.status === "error" };
}

export function FileCacheButton({ file }: { file: CacheFile }) {
  const queue = useContext(CacheContext);
  // 不支持（如未启用 HTTPS 的部署）或已关闭时整个按钮都不显示，不在每一行留下禁用的按钮。
  if (!queue?.available) return null;
  const state = buttonState(queue, file);
  const label = `${state.label} ${nameOf(file)}${state.bytes || state.complete ? ` · ${state.percent}%` : ""}`;
  return <button type="button" className={`icon-btn icon-btn-ghost icon-btn-sm file-cache-button${state.complete ? " is-complete" : ""}${state.running ? " is-active" : ""}`} title={label} aria-label={label}
    onClick={event => { event.stopPropagation(); if (state.running) queue.setExpanded(true); else if (state.complete) queue.inspect(file); else queue.enqueue(file); }}>
    {state.bytes && !state.complete ? <><svg className="file-cache-ring" viewBox="0 0 20 20" aria-hidden="true" style={{ "--tray-progress": state.percent } as CSSProperties}><circle className="tray-ring-track" cx="10" cy="10" r="8" /><circle className="tray-ring-value" cx="10" cy="10" r="8" pathLength="100" /></svg><span>{state.percent}%</span></>
      : <Icon name={state.complete ? "check" : state.error ? "refresh" : state.running ? "pulse" : "monitor"} size={16} />}
  </button>;
}

export function cacheMenuItems(queue: Queue | null, file: CacheFile): MenuItem[] {
  if (!queue?.available) return [];
  const state = buttonState(queue, file);
  return [{ label: state.label, icon: "monitor", onSelect: () => state.running ? queue.setExpanded(true) : state.complete ? queue.inspect(file) : queue.enqueue(file) },
    ...(state.bytes ? [{ label: "移除本机缓存", icon: "trash" as const, divider: true, danger: true, onSelect: () => queue.remove(file) }] : [])];
}

export function CacheTray() {
  const queue = useContext(CacheContext);
  if (!queue?.jobs.length) return null;
  const { jobs, expanded } = queue;
  const active = jobs.filter(isRunning).length, failed = jobs.filter(job => job.status === "error").length;
  const done = jobs.filter(job => job.status === "done").length;
  const bytes = jobs.reduce((sum, job) => sum + job.bytes, 0), total = jobs.reduce((sum, job) => sum + job.size, 0);
  const percent = percentOf(bytes, total, done === jobs.length);
  const state = active ? "active" : failed ? "error" : done === jobs.length ? "done" : "idle";
  return <aside className={`upload-tray cache-tray is-${state}${expanded ? "" : " is-collapsed"}${jobs.some(job => api.isPrivatePath(job.file.key)) ? " private-dialog" : ""}`} aria-label="本机缓存进度">
    <header><TrayRing state={state} percent={percent} icon="monitor" /><div className="tray-heading"><strong>本机缓存{active ? ` · ${active} 个进行中` : failed ? ` · ${failed} 个失败` : done === jobs.length ? "完成" : "已停止"}</strong><small>{formatBytes(bytes)} / {formatBytes(total)} · {percent}%</small></div>
      <IconButton icon="chevronDown" size="sm" label={expanded ? "收起缓存列表" : "展开缓存列表"} onClick={() => queue.setExpanded(!expanded)} />
      {!active && <IconButton icon="x" size="sm" label="关闭缓存列表" onClick={queue.clear} />}</header>
    {expanded && <ul>{jobs.map(job => {
      const running = isRunning(job), percent = percentOf(job.bytes, job.size, job.status === "done");
      const detail = job.status === "error" ? job.error : job.status === "queued" ? job.waiting ? "其他页面正在缓存，等待完成…" : "排队中" : job.status === "canceled" ? "已取消，已缓存的部分会保留" : job.status === "done" ? "完整文件已缓存" : `${formatBytes(job.bytes)} / ${formatBytes(job.size)}`;
      return <li key={job.id} className={`tray-item is-${job.status}`}><Icon name={api.isPrivatePath(job.file.key) ? "lock" : "monitor"} size={22} /><div className="tray-job"><span className="tray-name" title={nameOf(job.file)}><span>{nameOf(job.file)}</span></span><small className={job.status === "error" ? "tone-danger" : "muted"}>{detail}</small>
        {(running || job.status === "canceled") && <TrayBar percent={percent} label={`${nameOf(job.file)} 缓存进度`} paused={job.status !== "active"} />}</div><span className="tray-right">
        {job.status === "active" && <span className="tray-percent">{percent}%</span>}
        {running ? <IconButton icon="x" size="sm" label={`取消缓存 ${nameOf(job.file)}`} onClick={() => queue.cancel(job.id)} /> : job.status !== "done" ? <Button size="sm" variant="ghost" icon="refresh" onClick={() => queue.retry(job.id)}>{job.status === "canceled" ? "继续" : "重试"}</Button> : <Icon name="check" size={16} />}
      </span></li>;
    })}</ul>}
  </aside>;
}
