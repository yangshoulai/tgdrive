/**
 * 页面一侧的浏览器本地缓存（docs/client-cache-design.md）：注册 /sw.js、把私密授权与登录状态告诉 Service Worker，
 * 并给「本机缓存」设置页提供统计、设置与清理。页面本身不持有缓存密钥。
 */
import * as api from "./api";
import { type DeviceSettings, type FileCacheState, type Kind, readSettings, setMeta } from "./cache-store";
export type CacheFile = Pick<api.FileItem, "key" | "etag" | "size" | "content_type">;
export type { FileCacheState } from "./cache-store";
export const cacheFileId = (file: CacheFile) => `${api.isPrivatePath(file.key) ? "p" : "n"}:${file.etag}`;
const fileUrl = (file: CacheFile) => api.versionedContentUrl(api.contentUrl(file.key), file.etag);
const changed = () => window.dispatchEvent(new Event("tessera:cache-changed"));

export type CachePolicy = { enabled: boolean; private_enabled: boolean; private_ttl_days: number };
export type CacheStats = {
  namespace: string | null; policy: CachePolicy | null; settings: DeviceSettings;
  normal: { bytes: number; count: number; kinds: Partial<Record<Kind, number>> }; private: { bytes: number; count: number }; others: { bytes: number; count: number };
};
export type CachedItem = { key: string; path: string; kind: Kind; bytes: number; size: number; accessed: number; manual: boolean; complete: boolean };
export type CachedItemFilter = { query?: string; kind?: Kind | ""; status?: "" | "complete" | "partial"; sort?: "recent" | "size" | "name"; offset?: number; limit?: number };

export const cacheSupported = () => typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator
  && typeof indexedDB !== "undefined" && Boolean(globalThis.crypto?.subtle);

let registration: Promise<ServiceWorkerRegistration | null> | null = null;
let listening = false;

/** 登录后调用：注册 Service Worker 并开始转发私密授权变化。重复调用无副作用。 */
export function startLocalCache() {
  if (!cacheSupported()) return;
  registration ??= navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => null);
  if (listening) return;
  listening = true;
  navigator.serviceWorker.addEventListener("message", event => {
    // Service Worker 重启后没有私密授权时会来问；只回答同一页面当前持有的授权。
    if (event.data?.type === "tessera-cache:context?") event.ports[0]?.postMessage({ access: api.getPrivateAccess() });
  });
  window.addEventListener("tessera:private-access", event => notify("tessera-cache:access", { access: (event as CustomEvent<string>).detail }));
  window.addEventListener("tessera:logout", () => notify("tessera-cache:logout"));
  window.addEventListener("tessera:files-mutated", () => notify("tessera-cache:nudge"));
  notify("tessera-cache:access", { access: api.getPrivateAccess() });
}

async function worker(timeout = 3000): Promise<ServiceWorker | null> {
  if (!cacheSupported()) return null;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  const ready = await Promise.race([registration ?? navigator.serviceWorker.getRegistration(), new Promise<null>(resolve => setTimeout(() => resolve(null), timeout))]);
  return ready?.active ?? ready?.waiting ?? ready?.installing ?? null;
}

function notify(type: string, extra: Record<string, unknown> = {}) {
  void worker().then(target => target?.postMessage({ type, ...extra })).catch(() => undefined);
}

async function ask<T>(type: string, extra: Record<string, unknown> = {}, timeout = 8000, progress?: (value: FileCacheState) => void, signal?: AbortSignal): Promise<T> {
  const target = await worker();
  if (!target) throw new Error("本机缓存尚未启动，请刷新页面后重试");
  return new Promise<T>((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error?: Error, value?: T) => {
      clearTimeout(timer); channel.port1.close(); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value as T);
    };
    const abort = () => finish(new DOMException("缓存已取消", "AbortError"));
    const expired = () => finish(new Error("本机缓存没有响应，请重试以继续缓存"));
    let timer = setTimeout(expired, timeout);
    channel.port1.onmessage = event => {
      if (event.data?.progress) { clearTimeout(timer); timer = setTimeout(expired, timeout); progress?.(event.data.progress); return; }
      if (event.data?.ok) finish(undefined, event.data.value as T); else finish(new Error(event.data?.error || "本机缓存操作失败"));
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    target.postMessage({ type, ...extra }, [channel.port2]);
  });
}

/** 只读统计（不解密条目），侧栏与设置页都可以频繁调用。 */
export const cacheStats = () => ask<CacheStats>("tessera-cache:stats");
/** 已缓存文件的分页列表；搜索、筛选与排序在 Worker 内完成，每页最多 200 项。 */
export const cachedItems = (filter: CachedItemFilter) => ask<{ total: number; bytes: number; items: CachedItem[] }>("tessera-cache:items", { filter }, 30000);
export async function removeCachedItems(filter: CachedItemFilter) {
  const removed = await ask<number>("tessera-cache:remove-items", { filter }, 60000);
  changed();
  return removed;
}
export const clearCache = async (scope: "normal" | "private" | "others" | "all" | "entry", key?: string) => { await ask<void>("tessera-cache:clear", { scope, key }, 30000); changed(); };
export const loadSettings = () => readSettings(navigator.userAgent);

export async function saveSettings(next: DeviceSettings) {
  await setMeta("settings", next);
  await ask("tessera-cache:settings");
  changed();
  // 开启时申请持久化存储，减少浏览器在空间紧张时自动清除缓存；拒绝也不影响使用。
  if (next.enabled) void navigator.storage?.persist?.().catch(() => false);
}

/** 让所有设备上的缓存都无法再解开（服务端纪元加一），并清除这台设备上的数据。 */
export async function resetAllDevices() {
  await api.resetClientCache();
  await ask("tessera-cache:reset", {}, 30000).catch(() => undefined);
  changed();
}

export async function cachedFiles(files: CacheFile[]) {
  const result: (FileCacheState & { busy: boolean })[] = [];
  for (let index = 0; index < files.length; index += 200)
    result.push(...await ask<(FileCacheState & { busy: boolean })[]>("tessera-cache:files", { urls: files.slice(index, index + 200).map(fileUrl) }, 30000));
  return result;
}
/** 手动缓存过的文件（键与 cacheFileId 相同）；文件列表只为它们显示状态。私密层只在私密空间已解锁时包含。 */
export const manualCachedFiles = (withPrivate: boolean) =>
  ask<(FileCacheState & { id: string })[]>("tessera-cache:manual", { private: withPrivate }, 30000);
export const beginFileCache = (file: CacheFile, id: string, signal: AbortSignal) => ask<({ busy: true } | ({ busy: false } & FileCacheState))>("tessera-cache:start", { url: fileUrl(file), id }, 30000, undefined, signal);
export const stepFileCache = (id: string, signal: AbortSignal, progress: (state: FileCacheState) => void) => ask<FileCacheState>("tessera-cache:step", { id }, 120000, progress, signal);
export function cancelFileCache(id?: string) {
  // pagehide 中也能同步发出，不等待异步查找 Worker。
  navigator.serviceWorker?.controller?.postMessage({ type: "tessera-cache:cancel", id });
}
export async function removeFileCache(file: CacheFile) { await ask("tessera-cache:remove-file", { url: fileUrl(file) }, 30000); changed(); }

export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate) return null;
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0, persisted: Boolean(await navigator.storage.persisted?.()) };
  } catch { return null; }
}

export const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
