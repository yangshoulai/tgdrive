/**
 * Tessera 浏览器本地缓存的 Service Worker（docs/client-cache-design.md）。
 *
 * 只接管带内容版本的文件与缩略图 GET 请求；其余请求不调用 respondWith，行为与没有 Service Worker 时一致。
 * 自动读取失败时退回服务器，手动缓存必须报告写入错误。密钥只放在内存里，Worker 重启后重新向服务端获取。
 */
import {
  BLOCK, type Bytes, type DeviceSettings, type EntryInfo, type EntryRecord, type Kind, type Tier,
  aesKey, b64u, blockAad, deleteEntries, deviceId, directoryRoot, effectiveMiB, ensureEntry, evict, forgetDirectory, preferredStore, readDirectory, setMeta, sweepDirectory, fileCacheState, fromB64u, getBlock, getEntry, hkdf, hmac,
  kindOf, listEntries, missingRun, open, openInfo, parseRange, putBlock, readSettings, resolveRange, seal, sealInfo, setManualFlags, touchEntry, updateEntryInfo,
} from "../cache-store";

const sw = self as unknown as ServiceWorkerGlobalScope;
const MiB = 1 << 20;

/* 是否缓存、是否缓存私密文件与容量都只来自这台设备的设置（tierBudget），服务端没有管理员策略。 */
type EntryKeys = { id: string; key: CryptoKey };
type TierContext = {
  tier: Tier; ns: string; key: Bytes; info: CryptoKey; bucketId: number | null; access: string; signal: AbortSignal;
  materials: Map<string, Promise<Bytes | null>>; derived: Map<string, Promise<EntryKeys>>;
};
type Route = { tier: Tier; etag: string; version: string; path: string; access: string; bucketId: number | null; thumb: boolean; size?: number; preview?: boolean };
type Opened = { tier: TierContext; entry: EntryRecord; info: EntryInfo; key: CryptoKey; request: Request; cap: number };
type Source = { start: number; response: Response; controller: AbortController };
type Background = { id: string; controller: AbortController; ready: Promise<void>; started: boolean; context: TierContext | null };
const backgrounds = new Map<string, Background>();
type Manual = { key: string; id: string; owner: string; route: Route; request: Request; controller: AbortController; opened?: Opened; running: boolean;
  background?: Background; timer?: number };
/** 手动缓存任务（键为 页面:任务编号）。最多同时缓存 MAX_MANUAL_FILES 个文件，所有文件的回源请求共用 manualSlot 的并发上限。 */
const manuals = new Map<string, Manual>();
const MAX_MANUAL_FILES = 3;

/* ---------- 路由 ---------- */

function routeOf(request: Request): Route | null {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return null;
  const match = /^\/api\/user\/v1(\/private)?\/(content|thumbnail)$/.exec(url.pathname);
  const params = url.searchParams, version = params.get("v");
  if (!match || !version) return null;
  const tier: Tier = match[1] ? "p" : "n";
  const bucket = params.get("bucket_id");
  const bucketId = bucket && /^\d+$/.test(bucket) ? Number(bucket) : null;
  if (match[2] === "content") {
    if (tier === "n" && bucketId === null) return null;
    const rawSize = params.get("size");
    const size = rawSize !== null && /^\d+$/.test(rawSize) && Number.isSafeInteger(Number(rawSize)) ? Number(rawSize) : undefined;
    return { tier, etag: version, version, path: params.get("path") ?? "", access: params.get("access") ?? "", bucketId, thumb: false, size, preview: params.get("preview") === "1" };
  }
  const etag = params.get("etag");
  if (!etag) return null;
  return { tier, etag, version: `thumb|${etag}|${params.get("variant") ?? "thumb"}|${version}`, path: "", access: "", bucketId, thumb: true };
}

/* ---------- 设置、策略与密钥 ---------- */

let settings: { value: DeviceSettings; at: number } | null = null;
type Cached = { promise: Promise<TierContext | null>; expires: number; access?: string };
let normal: Cached | null = null;
let privateTier: Cached | null = null;
let pageAccess = "";
let pageAccessExpires = 0;
let accessTimer: number | undefined;
let askedAt = 0;
const revocation = { n: new AbortController(), p: new AbortController() };
type PrivateBatch = { waiters: Map<string, (value: Bytes | null) => void>; timer: number };
const pendingPrivate = new Map<TierContext, PrivateBatch>();

/** 设备设置中这一层的容量（字节）。 */
/** 重试也无法解决的失败（空间不足、文件已变化、设置不允许等）：页面据此停止自动重试，直接提示用户处理。 */
class CacheFatal extends Error {}
/** 4xx（除限流外）说明文件或授权已变化，重试无益；5xx、429 与网络中断按暂时故障自动重试。 */
const statusError = (status: number, message: string) => status >= 400 && status < 500 && status !== 408 && status !== 429 ? new CacheFatal(message) : new Error(message);
const sizeText = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MiB))} MB`;

const tierBudget = (preferences: DeviceSettings, tier: Tier) => (tier === "n" ? preferences.maxMiB : preferences.privateMaxMiB) * MiB;

/** 设备设置，容量按浏览器配额截断：设置值大于配额时以配额为准（配额每 5 秒随设置一起重读）；使用本地缓存目录时不截断。 */
async function currentSettings() {
  if (!settings || Date.now() - settings.at > 5000) {
    const [value, estimate, folder] = await Promise.all([readSettings(navigator.userAgent), navigator.storage?.estimate?.().catch(() => undefined), directoryRoot()]);
    // 数据块写在用户选择的文件夹时不占浏览器配额，容量只按用户设置。
    const quota = folder ? undefined : estimate?.quota;
    settings = { value: { ...value, maxMiB: effectiveMiB(value.maxMiB, quota), privateMaxMiB: effectiveMiB(value.privateMaxMiB, quota) }, at: Date.now() };
  }
  return settings.value;
}

/** 沿用私密空间已有的状态检查与闲置期限，拖动进度时不再重复请求同一密钥。 */
function rememberAccess(access: string, expires = 0) {
  pageAccess = access;
  pageAccessExpires = access && Number.isFinite(expires) ? expires : 0;
  clearTimeout(accessTimer);
  accessTimer = undefined;
  if (pageAccessExpires) accessTimer = setTimeout(() => {
    rememberAccess(""); dropKeys("p");
  }, Math.max(0, pageAccessExpires - Date.now())) as unknown as number;
}

const reusablePrivate = (context: TierContext) => context.access === pageAccess && Date.now() < pageAccessExpires;

function clearPrivateMaterials() {
  return privateTier?.promise.then(context => { context?.materials.clear(); context?.derived.clear(); });
}

function dropKeys(tier?: Tier) {
  stopManualWhere(job => !tier || job.route.tier === tier && !job.background);
  if (!tier) for (const key of backgrounds.keys()) void finishBackground(key);
  for (const selected of tier ? [tier] : ["n", "p"] as const) {
    revocation[selected].abort();
    revocation[selected] = new AbortController();
  }
  for (const [context, batch] of pendingPrivate) {
    if (!context.signal.aborted) continue;
    clearTimeout(batch.timer);
    pendingPrivate.delete(context);
    for (const resolve of batch.waiters.values()) resolve(null);
  }
  if (!tier || tier === "p") { void clearPrivateMaterials(); privateTier = null; }
  if (!tier || tier === "n") normal = null;
}

async function post(path: string, body: unknown, access = "", headers: Record<string, string> = {}) {
  const response = await fetch(path, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", ...(access ? { "X-Private-Access": access } : {}), ...headers }, body: JSON.stringify(body),
  });
  if (response.status === 401) dropKeys();
  return response;
}

async function tierContext(tier: Tier, ns: string, raw: string, bucketId: number | null, signal: AbortSignal, access = ""): Promise<TierContext | null> {
  const key = fromB64u(raw);
  const info = await aesKey(await hkdf(key, "tessera-cache-index"));
  // 旧请求不能在锁定、退出或重置之后重新建立上下文；派生缓存只属于这一把层级密钥。
  return signal.aborted ? null : { tier, ns, key, info, bucketId, access, signal, materials: new Map(), derived: new Map() };
}

/** 成功的上下文保留 10 分钟（期间策略或撤销在下一次获取时生效），失败的保留 30 秒，避免未登录时每个请求都去问服务端。 */
function remember(promise: Promise<TierContext | null>, ttl: number, access?: string): Cached {
  const cached: Cached = { promise, expires: Date.now() + ttl, access };
  promise.then(value => { if (!value) cached.expires = Math.min(cached.expires, Date.now() + 30_000); });
  return cached;
}

function normalContext(): Promise<TierContext | null> {
  if (normal && Date.now() < normal.expires) return normal.promise;
  const signal = revocation.n.signal;
  const pending: Promise<TierContext | null> = (async () => {
    const response = await post("/api/user/v1/cache/session", { device: await deviceId() });
    if (!response.ok) return null;
    const body = await response.json() as { namespace: string; bucket_id: number; key?: string };
    if (signal.aborted) return null;
    lastNamespace = body.namespace;
    if (!body.key) return null;
    scheduleReconcile(5000);
    return tierContext("n", body.namespace, body.key, body.bucket_id, signal);
  })().catch(() => null);
  normal = remember(pending, 10 * 60_000);
  return pending;
}

async function privateContext(route: Route): Promise<TierContext | null> {
  if (pageAccessExpires && Date.now() >= pageAccessExpires) { rememberAccess(""); dropKeys("p"); }
  const signal = revocation.p.signal;
  const [device, preferences, base] = await Promise.all([deviceId(), currentSettings(), normalContext()]);
  if (!preferences.private || !base || base.signal.aborted || signal.aborted) return null;
  if (!pageAccessExpires) await askAccess(signal);
  const access = route.access || pageAccess || await askAccess(signal);
  if (!access || signal.aborted) return null;
  // 页面持续同步有效授权时复用上下文；旧页面没有截止时间时仍沿用逐次验权。
  if (privateTier && privateTier.access === access && (Date.now() < privateTier.expires || access === pageAccess && Date.now() < pageAccessExpires)) return privateTier.promise;
  const pending: Promise<TierContext | null> = (async () => {
    const response = await post("/api/user/v1/private/cache/session", { device }, access);
    if (!response.ok) return null;
    const body = await response.json() as { namespace: string; key: string };
    return tierContext("p", body.namespace, body.key, null, signal, access);
  })().catch(() => null);
  privateTier = remember(pending, 60_000, access);
  return pending;
}

/** 私密条目首次读取向服务端申请；同一有效授权期间复用，未同步授权期限时仍逐次校验。 */
function material(context: TierContext, etag: string): Promise<Bytes | null> {
  if (context.signal.aborted) return Promise.resolve(null);
  if (context.tier === "p" && !reusablePrivate(context)) return requestPrivate(context, etag);
  let value = context.materials.get(etag);
  if (!value) {
    if (context.materials.size > 4000) context.materials.clear();
    value = context.tier === "p" ? requestPrivate(context, etag) : hkdf(context.key, "entry|" + etag);
    context.materials.set(etag, value);
    const forget = () => { if (context.materials.get(etag) === value) context.materials.delete(etag); };
    value.then(result => { if (!result) forget(); }, forget);
  }
  return value;
}

function requestPrivate(context: TierContext, etag: string): Promise<Bytes | null> {
  return new Promise(resolve => {
    let batch = pendingPrivate.get(context);
    if (batch && batch.waiters.size >= 500 && !batch.waiters.has(etag)) {
      clearTimeout(batch.timer);
      void flushPrivate(context, batch);
      batch = undefined;
    }
    if (!batch) {
      batch = { waiters: new Map(), timer: 0 };
      const collecting = batch;
      batch.timer = setTimeout(() => void flushPrivate(context, collecting), 20) as unknown as number;
      pendingPrivate.set(context, batch);
    }
    const previous = batch.waiters.get(etag);
    batch.waiters.set(etag, value => { previous?.(value); resolve(value); });
  });
}

async function flushPrivate(context: TierContext, batch: PrivateBatch) {
  if (pendingPrivate.get(context) === batch) pendingPrivate.delete(context);
  let keys: Record<string, { id: string; key: string } | null> = {};
  try {
    context.signal.throwIfAborted();
    const response = await post("/api/user/v1/private/cache/keys", { device: await deviceId(), etags: [...batch.waiters.keys()] }, context.access);
    if (response.ok) {
      keys = (await response.json() as { keys: typeof keys }).keys;
      if (!context.signal.aborted) {
        const removed = new Set([...batch.waiters.keys()].filter(etag => keys[etag] === null));
        if (removed.size) {
          const byEtag = await etagsOf(context, await listEntries(context.ns, "p"));
          await deleteEntries([...removed].flatMap(etag => byEtag.get(etag) ?? []));
        }
      }
    }
    else dropKeys("p");
  } catch { /* 拿不到密钥时直接回源 */ }
  for (const [etag, resolve] of batch.waiters) resolve(!context.signal.aborted && keys[etag] ? fromB64u(keys[etag]!.key) : null);
}

function entryKeys(context: TierContext, base: Bytes, version: string) {
  const derive = async () => ({ id: b64u(await hmac(base, "id|" + version)).slice(0, 32), key: await aesKey(await hkdf(base, "key|" + version)) });
  if (context.tier === "p" && !reusablePrivate(context)) return derive();
  let value = context.derived.get(version);
  if (!value) {
    if (context.derived.size > 4000) context.derived.clear();
    value = derive();
    context.derived.set(version, value);
    value.catch(() => context.derived.delete(version));
  }
  return value;
}

/** 私密层的条目没有地址里的解锁令牌（缩略图）时，向打开的页面要当前的私密授权。 */
async function askAccess(signal: AbortSignal): Promise<string> {
  if (Date.now() - askedAt < 3000) return "";
  askedAt = Date.now();
  for (const client of await sw.clients.matchAll({ type: "window" })) {
    const grant = await new Promise<{ access: string; expires?: number }>(resolve => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); resolve({ access: "" }); }, 500);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve({ access: typeof event.data?.access === "string" ? event.data.access : "", expires: event.data?.expires }); };
      client.postMessage({ type: "tessera-cache:context?" }, [channel.port2]);
    });
    if (signal.aborted) return "";
    if (grant.access && (!grant.expires || grant.expires > Date.now())) { rememberAccess(grant.access, grant.expires); return grant.access; }
  }
  return "";
}

/* ---------- 读写 ---------- */

const etagOf = (response: Response) => (response.headers.get("etag") ?? "").replace(/^W\//, "");
/** 非预览的页面与内嵌内容直接回源；PDF 预览显式带 preview=1，沿用文件预览的缓存规则。 */
const UNCACHED_DESTINATIONS = new Set(["document", "iframe", "frame", "embed", "object", "script", "style", "font", "worker", "sharedworker", "manifest", "report"]);
const PREVIEW_FRAME_DESTINATIONS = new Set(["document", "iframe", "frame", "embed", "object"]);
const direct = (request: Request) => fetch(request, { cache: "no-store" });
/** 带自定义 Range 回源。媒体元素的请求是 no-cors 模式，直接 fetch(request, { headers }) 时浏览器会丢掉脚本设置的 Range、
 *  返回整个文件；所以按原地址另建同源请求，只沿用原请求的普通请求头。 */
const sourceFetch = (request: Request, headers: Headers, signal: AbortSignal, method = "GET") =>
  fetch(new Request(request.url, { method, headers, credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "follow", signal }));

async function openEntry(request: Request, route: Route): Promise<{ context: TierContext; base: Bytes } | null> {
  const preferences = await currentSettings();
  if (!preferences.enabled) return null;
  const context = route.tier === "n" ? await normalContext() : await privateContext(route);
  if (!context || (route.tier === "n" && route.bucketId !== context.bucketId)) return null;
  const base = await material(context, route.etag);
  return base && !context.signal.aborted ? { context, base } : null;
}

async function handle(request: Request, route: Route): Promise<Response> {
  const range = parseRange(request.headers.get("range"));
  const opened = range === undefined || (range && range.start < 0) ? null : await openEntry(request, route);
  if (!opened) return direct(request);
  const { context, base } = opened;
  const keys = await entryKeys(context, base, route.version);
  context.signal.throwIfAborted();
  const key = `${context.ns}/${context.tier}/${keys.id}`;
  const now = Date.now();
  let entry = await getEntry(key);
  // 数据在本地缓存目录、但目录暂未授权：直接回源，保留条目等用户重新授权后继续使用。
  if (entry?.store === "dir" && !(await directoryRoot())) return direct(request);
  let info = entry ? await openInfo(context.info, entry) : null;
  // 旧版可能把缺失的 Content-Length 写成 0；大小不符时清掉条目，让本次读取正常回源。
  if (entry && (!info || route.size !== undefined && info.size !== route.size)) {
    await deleteEntries([key]); entry = undefined; info = null;
    infoMemo.delete(key); manualCache = null; itemCache = null;
  }
  const preferences = await currentSettings();
  const download = new URL(request.url).searchParams.get("download") === "1";
  // 自动缓存的单个文件最多占这一层容量的一半，看一个长视频不会把其他缓存全部挤掉；手动缓存可以用满。
  const cap = Math.max(BLOCK, Math.floor(tierBudget(preferences, route.tier) / 2));
  context.signal.throwIfAborted();
  if (entry && info) {
    if (download && !fileCacheState(entry, info.size).complete) return direct(request);
    if (info.kind === "video" && !preferences.video && !info.manual) return direct(request);
    if (now - entry.accessed > 60_000) void touchEntry(key, now).catch(() => undefined);
    if (download) info = { ...info, disposition: `attachment; filename*=UTF-8''${encodeURIComponent(route.path.split("/").at(-1) || "file")}` };
    if (!info.size) return new Response(null, { status: range ? 416 : 200, headers: {
      "Content-Type": info.type, "Content-Length": "0", "Content-Disposition": info.disposition,
      "Cache-Control": "no-store", "X-Tessera-Cache": "hit", ETag: info.version,
      ...(range ? { "Content-Range": "bytes */0" } : {}),
    } });
    return build({ tier: context, entry, info, key: keys.key, request, cap }, range ?? null);
  }
  if (download) return direct(request);
  // 关闭自动缓存视频（Safari 默认）时，播放器的每次拖动都只发原始请求，不能变成两次回源。
  if (UNCACHED_DESTINATIONS.has(request.destination) && !(route.preview && PREVIEW_FRAME_DESTINATIONS.has(request.destination))
      || request.destination === "video" && !preferences.video) return direct(request);
  // 第一次读取：按块对齐向服务端请求，从响应得知大小与类型后建立条目。
  const start = range ? Math.floor(range.start / BLOCK) * BLOCK : 0;
  const end = range?.end != null ? Math.min(Number.MAX_SAFE_INTEGER, (Math.floor(range.end / BLOCK) + 1) * BLOCK - 1) : null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal.addEventListener("abort", abort);
  request.signal.addEventListener("abort", abort);
  if (context.signal.aborted || request.signal.aborted) abort();
  let handedOff = false;
  try {
    const headers = new Headers(request.headers);
    if (range) headers.set("Range", `bytes=${start}-${end ?? ""}`);
    const upstream = await sourceFetch(request, headers, controller.signal);
    if (upstream.status === 401) { dropKeys(); return direct(request); }
    // 空文本的 Range 返回 416；额外用 HEAD 验证版本后，也能登记真正的空文件。
    const emptyRange = route.preview && route.size === 0 && upstream.status === 416 && upstream.headers.get("content-range") === "bytes */0";
    const metadata = emptyRange ? await sourceFetch(request, new Headers(request.headers), controller.signal, "HEAD") : upstream;
    const rawSize = metadata.headers.get("content-length")?.trim();
    const total = emptyRange && metadata.ok ? 0 : upstream.status === 206 ? Number(/\/(\d+)$/.exec(upstream.headers.get("content-range") ?? "")?.[1])
      : upstream.status === 200 ? route.size ?? (rawSize && /^\d+$/.test(rawSize) ? Number(rawSize) : NaN) : NaN;
    const validator = etagOf(metadata);
    const bypass = () => {
      // 对齐后的响应不能直接用于原始 Range，版本变化等降级路径必须重发原始请求。
      if (range) { controller.abort(); return direct(request); }
      handedOff = true;
      return upstream;
    };
    if (!Number.isSafeInteger(total) || total < 0 || total === 0 && !route.preview || total > 0 && !upstream.body
        || (!route.thumb && (validator !== `"${route.etag}"` || route.size !== undefined && total !== route.size))) return bypass();
    const type = metadata.headers.get("content-type") ?? "application/octet-stream";
    const kind: Kind = route.thumb ? "thumb" : kindOf(type, request.destination);
    if (kind === "other" && !route.preview || kind === "video" && !preferences.video) return bypass();
    // 配置了本地缓存目录但暂未授权时不自动缓存，避免把数据悄悄写回受配额限制的浏览器存储。
    const store = await preferredStore();
    if (!store) return bypass();
    const record: EntryRecord = { key, ns: context.ns, tier: context.tier, id: keys.id, blocks: [], bytes: 0, accessed: now, created: now,
      ...(context.tier === "n" ? { kind } : {}), manual: false, ...(store === "dir" ? { store } : {}), info: null };
    info = { etag: route.etag, version: validator, size: total, type, disposition: metadata.headers.get("content-disposition") ?? "inline", path: route.path, kind };
    record.info = await sealInfo(context.info, record, info);
    context.signal.throwIfAborted();
    entry = await ensureEntry(record);
    const stored = await openInfo(context.info, entry);
    if (!stored) return bypass();
    context.signal.throwIfAborted();
    if (!stored.size) {
      await cacheChanged(true).catch(() => undefined);
      handedOff = true; return upstream;
    }
    const first = upstream.status === 200 ? 0 : start;
    const response = build({ tier: context, entry, info: stored, key: keys.key, request, cap }, range ?? null,
      { start: first, response: upstream, controller });
    handedOff = true;
    return response;
  } finally {
    context.signal.removeEventListener("abort", abort);
    request.signal.removeEventListener("abort", abort);
    if (!handedOff) controller.abort();
  }
}

function build(opened: Opened, range: { start: number; end: number | null } | null,
  initial?: Source): Response {
  const { info } = opened;
  const span = resolveRange(range, info.size);
  if (!span) {
    initial?.controller.abort();
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}`, "Cache-Control": "no-store" } });
  }
  const hit = opened.entry.blocks.length > 0;
  const headers = new Headers({
    "Content-Type": info.type, "Content-Length": String(span.end - span.start + 1), "Accept-Ranges": "bytes",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
    "Content-Disposition": info.disposition, "X-Tessera-Cache": initial ? "miss" : hit ? "hit" : "miss",
  });
  if (info.version) headers.set("ETag", info.version);
  if (range) headers.set("Content-Range", `bytes ${span.start}-${span.end}/${info.size}`);
  const controller = new AbortController();
  // 首次与后续回源共用这一活动引用；清空 initial 后取消仍能中止正在等待的 read。
  const active = { controller: initial?.controller };
  const abort = () => { controller.abort(); active.controller?.abort(); };
  const finish = () => {
    opened.tier.signal.removeEventListener("abort", abort);
    opened.request.signal.removeEventListener("abort", abort);
    active.controller?.abort();
  };
  opened.tier.signal.addEventListener("abort", abort);
  opened.request.signal.addEventListener("abort", abort);
  if (opened.tier.signal.aborted || opened.request.signal.aborted) abort();
  const iterator = produce(opened, span, controller.signal, active, initial);
  const body = new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const next = await iterator.next();
        controller.signal.throwIfAborted();
        if (next.done) { finish(); output.close(); } else output.enqueue(next.value);
      } catch (error) { finish(); output.error(error); }
    },
    async cancel() { abort(); finish(); await iterator.return(undefined).catch(() => undefined); },
  });
  return new Response(body, { status: range ? 206 : 200, headers });
}

async function* produce(opened: Opened, span: { start: number; end: number }, signal: AbortSignal,
  active: { controller: AbortController | undefined }, initial?: Source): AsyncGenerator<Uint8Array> {
  const { info } = opened;
  const finishPreviewBlock = info.kind === "other" && new URL(opened.request.url).searchParams.get("preview") === "1";
  const last = Math.floor((info.size - 1) / BLOCK);
  let pos = span.start;
  try {
    while (pos <= span.end) {
      signal.throwIfAborted();
      const index = Math.floor(pos / BLOCK);
      if (opened.entry.blocks.includes(index)) {
        let plain: Bytes | undefined;
        try {
          const sealed = await getBlock(opened.entry.key, index, opened.entry.store);
          if (!sealed) throw new Error("缓存数据块缺失");
          plain = await open(opened.key, sealed, blockAad(opened.entry, index));
          if (plain.length !== Math.min(BLOCK, info.size - index * BLOCK)) throw new Error("缓存数据块大小不符");
        } catch {
          // 流已经返回给页面：删除坏条目，从尚未交付的位置继续回源，不能让用户重试整次读取。
          await deleteEntries([opened.entry.key]).catch(() => undefined);
          opened.entry = { ...opened.entry, blocks: [], bytes: 0 };
          opened.cap = 0;
          plain = undefined;
        }
        if (plain) {
          signal.throwIfAborted();
          const to = Math.min(plain.length, span.end - index * BLOCK + 1);
          yield plain.subarray(pos - index * BLOCK, to);
          pos = index * BLOCK + to;
          continue;
        }
      }
      // 缺失：一次回源到下一个已缓存的块（或请求结束所在的块）为止，边转发边写入完整的块。
      const runLast = Math.min(missingRun(opened.entry.blocks, index, last), Math.floor(span.end / BLOCK));
      const fetchStart = index * BLOCK, fetchEnd = Math.min(info.size - 1, (runLast + 1) * BLOCK - 1);
      let response: Response, controller: AbortController;
      signal.throwIfAborted();
      if (initial && initial.start === fetchStart) ({ response, controller } = initial);
      else {
        initial?.controller.abort();
        controller = new AbortController();
        active.controller = controller;
        const headers = new Headers(opened.request.headers);
        headers.set("Range", `bytes=${fetchStart}-${fetchEnd}`);
        response = await sourceFetch(opened.request, headers, controller.signal);
        if (response.status === 401) dropKeys();
        if (response.status !== 206 || etagOf(response) !== info.version) {
          controller.abort();
          // 只有版本真的变化才说明服务端文件已变，条目不能再续写；没按 Range 返回（200）不能当作文件变化清掉已缓存的数据。
          if (response.ok && etagOf(response) !== info.version) await deleteEntries([opened.entry.key]);
          throw new Error(`回源失败（${response.status}）`);
        }
      }
      active.controller = controller;
      initial = undefined;
      const writer = new BlockWriter(opened, index);
      const reader = response.body!.getReader();
      let offset = fetchStart;
      try {
        while (pos <= span.end) {
          const { value, done } = await reader.read();
          if (done) break;
          await writer.push(value.subarray(0, Math.max(0, fetchEnd - offset + 1)));
          signal.throwIfAborted();
          const chunkStart = offset;
          offset += value.length;
          const to = Math.min(value.length, span.end - chunkStart + 1);
          const from = Math.max(0, pos - chunkStart);
          // 预览可能按上限截断；交付最后一段前补齐当前缓存块（最多额外不到 1 MiB），避免随后的取消让整块丢失。
          if (finishPreviewBlock && opened.cap > 0 && to > from && chunkStart + to > span.end) {
            while (offset <= fetchEnd) {
              signal.throwIfAborted();
              const tail = await reader.read();
              if (tail.done) break;
              await writer.push(tail.value.subarray(0, Math.max(0, fetchEnd - offset + 1))); offset += tail.value.length;
            }
            if (offset <= fetchEnd) throw new Error("服务器提前结束了响应");
          }
          if (to > from) { yield value.subarray(from, to); pos = chunkStart + to; }
        }
      } finally {
        controller.abort();
        if (active.controller === controller) active.controller = undefined;
        reader.releaseLock();
      }
      if (pos <= span.end && offset <= fetchEnd) throw new Error("服务器提前结束了响应");
    }
  } finally {
    active.controller?.abort();
    initial?.controller.abort();
  }
}

class BlockWriter {
  private parts: Uint8Array[] = [];
  private filled = 0;
  private stopped = false;
  constructor(private opened: Opened, private index: number, private strict?: { signal: AbortSignal; stored: () => void }) {}

  private length(index: number) { return Math.min(BLOCK, this.opened.info.size - index * BLOCK); }

  async push(chunk: Uint8Array) {
    let rest = chunk;
    while (rest.length && !this.stopped) {
      const take = Math.min(rest.length, this.length(this.index) - this.filled);
      this.parts.push(rest.subarray(0, take));
      this.filled += take;
      rest = rest.subarray(take);
      if (this.filled === this.length(this.index)) {
        const data = new Uint8Array(this.filled);
        let at = 0;
        for (const part of this.parts) { data.set(part, at); at += part.length; }
        await this.store(this.index, data);
        this.parts = []; this.filled = 0; this.index += 1;
      }
    }
  }

  private async store(index: number, data: Uint8Array) {
    this.strict?.signal.throwIfAborted();
    this.opened.tier.signal.throwIfAborted();
    const { entry } = this.opened;
    if (entry.blocks.includes(index)) return;
    if (entry.bytes + data.length > this.opened.cap) {
      if (this.strict) throw new CacheFatal("文件超过本机缓存的单文件上限");
      this.stopped = true; return;
    }
    try {
      const sealed = await seal(this.opened.key, data, blockAad(entry, index));
      this.opened.tier.signal.throwIfAborted();
      this.strict?.signal.throwIfAborted();
      const updated = await putBlock(entry.key, index, sealed, data.length, entry.store);
      if (!updated) {
        if (this.strict) throw new Error("缓存已被清理，请重试");
        this.stopped = true; return;
      }
      this.opened.entry = updated;
      this.strict?.signal.throwIfAborted();
      this.strict?.stored();
      scheduleEvict();
      if (this.opened.info.kind !== "thumb") await cacheChanged(fileCacheState(updated, this.opened.info.size).complete).catch(() => undefined);
    } catch (error) {
      if (this.strict) {
        if (error instanceof DOMException && error.name === "QuotaExceededError")
          throw new CacheFatal(entry.store === "dir" ? "缓存目录所在磁盘空间不足，请清理磁盘或本机缓存后重试" : "浏览器存储空间不足，请清理本机缓存后重试");
        if (entry.store === "dir" && error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "NotFoundError"))
          throw new CacheFatal("本机缓存目录不可用（未授权或已被移动），请在「本机缓存」设置中重新授权或重新选择目录");
        throw error;
      }
      // 多半是浏览器配额不足：先淘汰一部分，这次读取不再写入。
      this.stopped = true;
      scheduleEvict(0, 0.75);
    }
  }
}

/* ---------- 手动补全：页面调度，Worker 每一步并行补齐若干个 16 MiB 段 ---------- */

/** 停止一个手动任务；不传参数时停止全部。 */
function stopManual(job?: Manual) {
  for (const item of job ? [job] : [...manuals.values()]) {
    item.controller.abort(); clearTimeout(item.timer);
    if (manuals.get(item.key) === item) manuals.delete(item.key);
  }
}
function stopManualWhere(test: (job: Manual) => boolean) {
  for (const job of [...manuals.values()]) if (test(job)) stopManual(job);
}
const manualKeys = () => new Set([...manuals.values()].flatMap(job => job.opened ? [job.opened.entry.key] : []));

function renewManual(job: Manual) {
  clearTimeout(job.timer);
  // 页面关闭、消息超时或 Worker 重启都不留下持久任务；已提交的块仍可再次续传。
  job.timer = setTimeout(() => stopManual(job), 120_000) as unknown as number;
}

/* 多线程缓存：大文件按 16 MiB（服务器存储分片的大小，一段只对应一个分片）切段并行下载，几个文件也可以同时缓存。
 * 所有回源请求共用一个并发上限：服务器给每个账号的读取路数减一（服务器为播放和预览保留一路），最多 3 路，
 * 也给浏览器对同一站点的连接数（HTTP/1.1 约 6 个）留出余量。请求带 X-Tessera-Background，服务器让播放优先。 */
const SEGMENT_BLOCKS = 16;
let manualActive = 0;
const manualWaiters: (() => void)[] = [];
let readConcurrency: { value: number; at: number } | null = null;
async function manualParallel() {
  if (!readConcurrency || Date.now() - readConcurrency.at > 60_000) {
    let value = readConcurrency?.value ?? 2;
    try {
      const response = await fetch("/api/user/v1/upload-config", { credentials: "same-origin", cache: "no-store" });
      if (response.ok) {
        const reads = Number((await response.json() as { read_concurrency?: unknown }).read_concurrency);
        if (Number.isInteger(reads) && reads > 0) value = reads;
      }
    } catch { /* 沿用上次的值 */ }
    readConcurrency = { value, at: Date.now() };
  }
  return Math.max(1, Math.min(3, readConcurrency.value - 1));
}
async function manualSlot(signal: AbortSignal) {
  const limit = await manualParallel();
  while (manualActive >= limit) {
    signal.throwIfAborted();
    await new Promise<void>(resolve => {
      manualWaiters.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  signal.throwIfAborted();
  manualActive++;
  let released = false;
  return () => {
    if (released) return;
    released = true; manualActive--;
    manualWaiters.shift()?.();
  };
}

async function startPrivateTask(owner: string, id: string, paths: string[], csrf: string, access: string) {
  if (!owner || !id || id.length > 100 || !Array.isArray(paths)) throw new CacheFatal("缓存任务来源无效");
  const key = `${owner}:${id}`, existing = backgrounds.get(key);
  const previous = existing ? releaseBackground(owner, id) : Promise.resolve();
  const background: Background = { id, controller: new AbortController(), ready: Promise.resolve(), started: false, context: null };
  background.ready = (async () => {
    await previous;
    background.controller.signal.throwIfAborted();
    const preferences = await currentSettings();
    const normal = await normalContext();
    if (!preferences.enabled || !preferences.private || !normal || normal.signal.aborted)
      throw new CacheFatal("请在本机缓存设置中允许缓存私密文件");
    const device = await deviceId();
    background.controller.signal.throwIfAborted();
    const response = await post("/api/user/v1/cache/tasks", { id, device, paths }, access, { "X-CSRF-Token": csrf });
    if (!response.ok) throw new Error(`无法创建缓存任务（${response.status}），请解锁后重试`);
    const body = await response.json() as { namespace: string; bucket_id: number; key: string };
    background.started = true;
    background.controller.signal.throwIfAborted();
    background.context = await tierContext("p", body.namespace, body.key, body.bucket_id, background.controller.signal);
    if (!background.context) throw new Error("缓存任务已停止");
  })().catch(async error => {
    background.controller.abort();
    if (backgrounds.get(key) === background) {
      backgrounds.delete(key);
      if (background.started) await post("/api/user/v1/cache/tasks/release", {}, "", { "X-Tessera-Cache-Task": background.id }).catch(() => undefined);
    }
    throw error;
  });
  backgrounds.set(key, background);
  return background.ready;
}

async function getBackground(owner: string, id: string) {
  const background = backgrounds.get(`${owner}:${id}`);
  if (!background) throw new Error("缓存任务已结束，请重新加入缓存");
  await background.ready;
  background.controller.signal.throwIfAborted();
  return background;
}

function releaseBackground(owner: string, id: string) { return finishBackground(`${owner}:${id}`); }

async function finishBackground(key: string) {
  const background = backgrounds.get(key);
  if (!background) return;
  backgrounds.delete(key); background.controller.abort();
  stopManualWhere(job => job.background === background);
  await background.ready.catch(() => undefined);
  if (background.started) await post("/api/user/v1/cache/tasks/release", {}, "", { "X-Tessera-Cache-Task": background.id }).catch(() => undefined);
}

async function listBackground(owner: string, id: string, prefix: string, cursor?: string | null) {
  const background = await getBackground(owner, id);
  const query = new URLSearchParams({ prefix, ...(cursor ? { cursor } : {}) });
  const response = await fetch(`/api/user/v1/cache/tasks/list?${query}`, { credentials: "same-origin", cache: "no-store",
    headers: { "X-Tessera-Cache-Task": background.id }, signal: background.controller.signal });
  if (!response.ok) throw new Error(`无法读取缓存目录（${response.status}），请解锁后重试`);
  const result: unknown = await response.json();
  background.controller.signal.throwIfAborted();
  return result;
}

function manualRoute(url: string) {
  const request = new Request(new URL(url, sw.location.origin), { credentials: "same-origin" });
  const route = routeOf(request);
  if (!route || route.thumb || new URL(request.url).searchParams.get("download") === "1") throw new CacheFatal("只能缓存自己的普通或私密文件");
  return { request, route };
}

async function manualOpened(url: string, background?: Background) {
  const { request, route } = manualRoute(url);
  let value;
  if (background && route.tier === "p") {
    const preferences = await currentSettings();
    const context = background.context;
    if (!preferences.enabled || !preferences.private || !context) throw new CacheFatal("私密文件缓存已关闭");
    const response = await post("/api/user/v1/cache/tasks/keys", { path: route.path, etag: route.etag }, "", { "X-Tessera-Cache-Task": background.id });
    if (!response.ok) throw new Error(`缓存任务或文件版本已变化（${response.status}），请解锁后重试`);
    const body = await response.json() as { key: string };
    context.signal.throwIfAborted();
    value = { context, base: fromB64u(body.key) };
  } else value = await openEntry(request, route);
  if (!value) throw new CacheFatal(route.tier === "p" ? "请解锁私密空间，并在本机缓存设置中允许缓存私密文件" : "本机缓存未启用，请检查设置与管理员策略");
  const keys = await entryKeys(value.context, value.base, route.version);
  value.context.signal.throwIfAborted();
  return { ...value, keys, request, route, key: `${value.context.ns}/${route.tier}/${keys.id}` };
}

async function fileStates(urls: string[]) {
  if (urls.length > 200) throw new Error("一次最多查询 200 个文件");
  return Promise.all(urls.map(async url => {
    const value = await manualOpened(url);
    const entry = await getEntry(value.key);
    const info = entry && await openInfo(value.context.info, entry);
    value.context.signal.throwIfAborted();
    return { ...fileCacheState(info ? entry : undefined, info?.size ?? 0), busy: manualKeys().has(value.key) };
  }));
}

async function verifyManual(job: Manual) {
  const response = await manualFetch(job, { method: "HEAD" });
  if (response.status === 401) dropKeys();
  if (!response.ok) throw statusError(response.status, `无法读取文件（${response.status}），请刷新列表后重试`);
  if (etagOf(response) !== `"${job.route.etag}"`) {
    if (job.opened) await deleteEntries([job.opened.entry.key]);
    throw new CacheFatal("文件已变化，请刷新列表后重新缓存");
  }
  return response;
}

function manualFetch(job: Manual, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  let request = job.request;
  if (job.background) {
    const url = new URL(request.url);
    url.pathname = "/api/user/v1/cache/tasks/content"; url.searchParams.delete("access");
    request = new Request(url, { credentials: "same-origin" });
    headers.set("X-Tessera-Cache-Task", job.background.id);
  }
  return fetch(request, { ...options, headers, cache: "no-store", signal: job.controller.signal });
}

async function startManual(owner: string, id: string, url: string, group?: string) {
  if (!owner || !id || id.length > 100) throw new CacheFatal("缓存任务来源无效");
  const key = `${owner}:${id}`;
  const busy = (route: Route) => manuals.has(key) || manuals.size >= MAX_MANUAL_FILES
    || [...manuals.values()].some(job => job.route.etag === route.etag && job.route.tier === route.tier);
  const { request, route } = manualRoute(url);
  if (busy(route)) return { busy: true };
  const background = group && route.tier === "p" ? await getBackground(owner, group) : undefined;
  if (busy(route)) return { busy: true };
  const job: Manual = { key, owner, id, request, route, controller: new AbortController(), running: false, background };
  manuals.set(key, job); renewManual(job);
  try {
    // 点击时重取账号策略；长期播放的普通预览仍按原有的上下文周期复用。
    normal = null;
    const value = await manualOpened(url, background);
    job.controller.signal.throwIfAborted();
    const abort = () => job.controller.abort();
    value.context.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await verifyManual(job);
      // 文本经过代理压缩后，HEAD 可能不含原始长度；同 ETag 的列表大小优先，未知长度不能转成 0。
      const rawSize = response.headers.get("content-length")?.trim();
      const size = route.size ?? (rawSize && /^\d+$/.test(rawSize) ? Number(rawSize) : NaN);
      if (!Number.isSafeInteger(size) || size < 0) throw new CacheFatal("服务器未提供有效的文件大小");
      const preferences = await currentSettings();
      const budget = tierBudget(preferences, route.tier), cap = budget;
      if (size > budget) throw new CacheFatal(`文件（${sizeText(size)}）超过本机缓存上限 ${sizeText(budget)}，请先在「设置 → 本机缓存」中提高上限`);
      // 手动缓存优先于自动缓存：自动缓存的文件随时可以让出空间（enforce 按最久未使用先移除），
      // 已手动缓存的文件不会被挤掉；它们加上这个文件仍超出上限时，交给用户自己清理。
      const pinned = (await listEntries(value.context.ns, route.tier)).filter(item => item.manual && item.key !== value.key).reduce((sum, item) => sum + item.bytes, 0);
      if (pinned + size > budget)
        throw new CacheFatal(`本机缓存空间不足：已手动缓存 ${sizeText(pinned)}，加上这个文件（${sizeText(size)}）会超过上限 ${sizeText(budget)}。请在「本机缓存」中清除部分手动缓存或提高上限后重试`);
      let entry = await getEntry(value.key);
      let info = entry ? await openInfo(value.context.info, entry) : null;
      if (entry && (!info || info.size !== size)) { await deleteEntries([value.key]); entry = undefined; }
      const store = await preferredStore();
      if (!store) throw new CacheFatal("本机缓存目录需要重新授权：请到「本机缓存」设置点击「重新授权」后重试");
      if (entry?.store === "dir" && store !== "dir") throw new CacheFatal("这个文件缓存在本地缓存目录中，目录暂不可用，请重新授权后重试");
      // 已选择本地缓存目录：浏览器存储里未完成的旧条目改到目录重新缓存，不再占用浏览器配额；已完整的保留原处。
      if (entry && !entry.store && store === "dir" && !fileCacheState(entry, size).complete) { await deleteEntries([value.key]); entry = undefined; }
      const now = Date.now(), type = response.headers.get("content-type") ?? "application/octet-stream", kind = kindOf(type, "");
      info = { etag: route.etag, version: etagOf(response), path: route.path, type, size, kind,
        disposition: response.headers.get("content-disposition") ?? "inline", manual: true };
      const record: EntryRecord = { key: value.key, ns: value.context.ns, tier: route.tier, id: value.keys.id, blocks: [], bytes: 0,
        created: now, accessed: now, ...(route.tier === "n" ? { kind } : {}), manual: true, ...(store === "dir" ? { store } : {}), info: null };
      record.info = await sealInfo(value.context.info, record, info);
      job.controller.signal.throwIfAborted();
      entry = await ensureEntry(record);
      job.controller.signal.throwIfAborted();
      await updateEntryInfo(entry.key, record.info, true);
      infoMemo.delete(entry.key); manualCache = null; itemCache = null;
      job.controller.signal.throwIfAborted();
      job.opened = { tier: value.context, entry, info, key: value.keys.key, request, cap };
      await enforce();
      if (entry.store !== "dir") await reserveQuota(entry.key, size - entry.bytes + Math.ceil(size / BLOCK) * 28);
      job.controller.signal.throwIfAborted();
      const state = fileCacheState(entry, size);
      await cacheChanged(state.complete).catch(() => undefined);
      if (state.complete) stopManual(job);
      return { busy: false, ...state };
    } finally { value.context.signal.removeEventListener("abort", abort); }
  } catch (error) { stopManual(job); throw error; }
}

/** 浏览器配额（整个站点共用）不够时，先移除这台设备上最久未使用的自动缓存（含其他账号与私密层），手动缓存不动；仍不够就请用户处理。 */
async function reserveQuota(keep: string, need: number) {
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  if (!estimate?.quota || estimate.usage === undefined) return;
  const shortfall = need - (estimate.quota - estimate.usage);
  if (shortfall <= 0) return;
  const victims: string[] = [];
  let freed = 0;
  const busy = manualKeys();
  for (const item of (await listEntries()).filter(item => !item.manual && item.key !== keep && !busy.has(item.key)).sort((a, b) => a.accessed - b.accessed)) {
    if (freed >= shortfall) break;
    victims.push(item.key); freed += item.bytes;
  }
  if (victims.length) {
    await deleteEntries(victims);
    victims.forEach(key => infoMemo.delete(key));
    manualCache = null; itemCache = null;
    await cacheChanged(true).catch(() => undefined);
  }
  if (freed < shortfall)
    throw new CacheFatal(`浏览器可用空间不足，还差约 ${sizeText(shortfall - freed)}。自动缓存已全部让出，请在「本机缓存」中清除部分手动缓存后重试`);
}

async function stepManual(owner: string, id: string, progress: (value: unknown) => void) {
  const job = manuals.get(`${owner}:${id}`);
  if (!job || !job.opened) throw new Error("缓存任务已停止，请重试以继续缓存");
  if (job.running) throw new Error("缓存任务正在写入");
  job.running = true; renewManual(job);
  const abort = () => job.controller.abort();
  try {
    const value = await manualOpened(job.request.url, job.background);
    if (value.key !== job.opened.entry.key) throw new Error("缓存密钥已变化，请重试");
    value.context.signal.addEventListener("abort", abort, { once: true });
    job.controller.signal.throwIfAborted();
    const entry = await getEntry(value.key);
    if (!entry) throw new Error("缓存已被清理，请重试");
    const opened = job.opened = { ...job.opened, tier: value.context, key: value.keys.key, entry };
    // 这一步并行补齐的段：每个 16 MiB 段取第一段连续缺失的块；段内其他空洞留给下一步。
    const count = Math.ceil(opened.info.size / BLOCK);
    const present = new Set(entry.blocks);
    const parallel = await manualParallel();
    const segments: [number, number][] = [];
    for (let lo = 0; lo < count && segments.length < parallel * 2; lo += SEGMENT_BLOCKS) {
      const hi = Math.min(count - 1, lo + SEGMENT_BLOCKS - 1);
      let first = lo;
      while (first <= hi && present.has(first)) first++;
      if (first > hi) continue;
      let last = first;
      while (last < hi && !present.has(last + 1)) last++;
      segments.push([first, last]);
    }
    const failures: unknown[] = [];
    await Promise.all(segments.map(segment => fetchSegment(job, opened, segment, progress).catch(error => {
      failures.push(error);
      // 文件已变化、空间不足等无法自动恢复的错误：停止其余段；临时故障让其余段继续，已写入的块都保留。
      if (error instanceof CacheFatal) job.controller.abort();
    })));
    if (failures.length) throw failures.find(error => error instanceof CacheFatal) ?? failures.find(error => !(error instanceof DOMException && error.name === "AbortError")) ?? failures[0];
    job.controller.signal.throwIfAborted();
    const state = fileCacheState(await getEntry(entry.key), opened.info.size);
    if (state.complete) { await verifyManual(job); stopManual(job); }
    manualCache = null;
    return state;
  } catch (error) { stopManual(job); throw error; }
  finally { job.opened?.tier.signal.removeEventListener("abort", abort); job.running = false; }
}

async function fetchSegment(job: Manual, opened: Opened, [first, last]: [number, number], progress: (value: unknown) => void) {
  const release = await manualSlot(job.controller.signal);
  try {
    const end = Math.min(opened.info.size - 1, (last + 1) * BLOCK - 1);
    const headers = new Headers({ Range: `bytes=${first * BLOCK}-${end}`, "X-Tessera-Background": "cache" });
    const response = await manualFetch(job, { headers });
    if (response.status === 401) dropKeys();
    if (response.status !== 206 || etagOf(response) !== opened.info.version || response.headers.get("content-range") !== `bytes ${first * BLOCK}-${end}/${opened.info.size}`) {
      await response.body?.cancel();
      if (response.ok) { await deleteEntries([opened.entry.key]); throw new CacheFatal("文件已变化，请刷新列表后重新缓存"); }
      throw statusError(response.status, `读取文件失败（${response.status}），请稍后重试`);
    }
    if (!response.body) throw new Error("服务器未返回文件内容");
    const reader = response.body.getReader();
    const writer = new BlockWriter(opened, first, { signal: job.controller.signal, stored: () => {
      if (manuals.get(job.key) !== job || job.controller.signal.aborted) return;
      renewManual(job); progress(fileCacheState(opened.entry, opened.info.size));
    } });
    let received = 0;
    try {
      while (true) {
        job.controller.signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > end - first * BLOCK + 1) throw new Error("服务器返回的数据大小不符");
        await writer.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    if (received !== end - first * BLOCK + 1) throw new Error("服务器提前结束了响应，请重试以继续缓存");
  } finally { release(); }
}

/* ---------- 预览预读：预览打开期间，从播放位置往后多段并行补齐自动缓存；关闭预览即停止 ----------
 * 播放器自己的请求仍按原路读取（未缓存的块直接回源），预读只是让后面的数据提前进缓存：
 * 分片 MP4 这类需要跳着读很多位置才能开始播放的文件，跳到的位置多半已经在缓存里。
 * 与手动缓存共用 manualSlot 的并发上限并带后台标记，服务器始终给播放留一路读取。
 * 页面关闭预览时发 prefetch-stop；页面每 30 秒续期一次，超过 60 秒没有续期（页面崩溃、标签页关闭）也会停止。 */
/** woken：有段完成或播放位置变化；主循环在重新安排的间隙里也不会错过这些通知。 */
type Prefetch = { key: string; owner: string; id: string; url: string; from: number; controller: AbortController; timer?: number; wake?: () => void; woken?: boolean };
const prefetches = new Map<string, Prefetch>();
const PREFETCH_IDLE = 60_000, MAX_PREFETCH_FILES = 2;

const wakePrefetch = (job: Prefetch) => { job.woken = true; job.wake?.(); };
function stopPrefetch(job?: Prefetch) {
  for (const item of job ? [job] : [...prefetches.values()]) {
    item.controller.abort(); clearTimeout(item.timer); wakePrefetch(item);
    if (prefetches.get(item.key) === item) prefetches.delete(item.key);
  }
}
function renewPrefetch(job: Prefetch) {
  clearTimeout(job.timer);
  job.timer = setTimeout(() => stopPrefetch(job), PREFETCH_IDLE) as unknown as number;
}

/** 开始或更新一个预览的预读：同一预览再次调用只更新播放位置（拖动进度条后从新位置往后预读）。 */
function startPrefetch(owner: string, id: string, url: string, from: number) {
  if (!owner || !id || id.length > 100 || !url) return;
  const key = `${owner}:${id}`, existing = prefetches.get(key);
  const position = Number.isFinite(from) && from > 0 ? Math.floor(from) : 0;
  if (existing && existing.url === url) { existing.from = position; renewPrefetch(existing); wakePrefetch(existing); return; }
  if (existing) stopPrefetch(existing);
  // 同时预览的文件很少；超过上限时停掉最早的那个。
  if (prefetches.size >= MAX_PREFETCH_FILES) stopPrefetch(prefetches.values().next().value);
  const job: Prefetch = { key, owner, id, url, from: position, controller: new AbortController() };
  prefetches.set(key, job); renewPrefetch(job);
  void runPrefetch(job).catch(() => undefined).finally(() => { if (prefetches.get(key) === job) stopPrefetch(job); });
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

async function runPrefetch(job: Prefetch) {
  const signal = job.controller.signal;
  const value = await manualOpened(job.url);
  const preferences = await currentSettings();
  // 条目由播放器的第一次读取建立（handle 里登记类型、大小与版本）；等它出现再开始，最多等 20 秒。
  let entry: EntryRecord | undefined, info: EntryInfo | null = null;
  for (let attempt = 0; attempt < 40 && !signal.aborted; attempt++) {
    entry = await getEntry(value.key);
    info = entry ? await openInfo(value.context.info, entry) : null;
    if (entry && info) break;
    await pause(500, signal);
  }
  if (!entry || !info || signal.aborted || !info.size) return;
  if (info.kind === "video" && !preferences.video && !info.manual) return;
  if (entry.store === "dir" && !(await directoryRoot())) return;
  const budget = tierBudget(preferences, value.route.tier);
  const cap = info.manual ? budget : Math.max(BLOCK, Math.floor(budget / 2));
  const opened: Opened = { tier: value.context, entry, info, key: value.keys.key, request: value.request, cap };
  const worker: Manual = { key: `prefetch:${job.key}`, id: job.id, owner: job.owner, route: value.route, request: value.request, controller: job.controller, running: false };
  const abort = () => job.controller.abort();
  value.context.signal.addEventListener("abort", abort, { once: true });
  const count = Math.ceil(info.size / BLOCK), inflight = new Set<number>();
  let running = 0, failures = 0;
  try {
    while (!signal.aborted) {
      const current = await getEntry(value.key);
      if (!current) return;
      opened.entry = current;
      if (fileCacheState(current, info.size).complete || current.bytes >= cap) return;
      const parallel = await manualParallel();
      const present = new Set(current.blocks);
      // 从播放位置所在的块往后找缺失的块，到末尾后再从头补；每段不跨 16 MiB 的存储分片边界。
      const start = Math.min(count - 1, Math.floor(job.from / BLOCK));
      for (let step = 0; step < count && running < parallel; step++) {
        const first = (start + step) % count;
        if (present.has(first) || inflight.has(first)) continue;
        const groupEnd = Math.min(count - 1, (Math.floor(first / SEGMENT_BLOCKS) + 1) * SEGMENT_BLOCKS - 1);
        let last = first;
        while (last < groupEnd && !present.has(last + 1) && !inflight.has(last + 1)) last++;
        for (let block = first; block <= last; block++) inflight.add(block);
        running++;
        void fetchSegment(worker, opened, [first, last], () => undefined)
          .then(() => { failures = 0; }, error => {
            // 空间到上限、文件已变化等无法恢复的错误直接停止；临时故障最多连续重试几次。
            if (error instanceof CacheFatal || ++failures >= 4) job.controller.abort();
          })
          .finally(() => { for (let block = first; block <= last; block++) inflight.delete(block); running--; wakePrefetch(job); });
      }
      if (!running) return;
      // 等任一段完成或播放位置变化，再重新安排。
      if (!job.woken) await new Promise<void>(resolve => { job.wake = resolve; });
      job.wake = undefined; job.woken = false;
    }
  } finally {
    value.context.signal.removeEventListener("abort", abort);
  }
}

async function removeFile(url: string) {
  const value = await manualOpened(url);
  stopManualWhere(job => job.route.etag === value.route.etag && job.route.tier === value.route.tier);
  await deleteEntries([value.key]);
  infoMemo.delete(value.key);
  await cacheChanged(true).catch(() => undefined);
}

/* ---------- 缓存索引：文件列表据此标记自动缓存与手动缓存的文件 ---------- */

type IndexState = { id: string; bytes: number; size: number; complete: boolean; manual: boolean };
let manualCache: { ns: string; withPrivate: boolean; at: number; items: IndexState[] } | null = null;
/** 条目的 etag 与大小在写入后不变：按条目键记住解密结果，索引重建时只解密新条目。 */
const infoMemo = new Map<string, { etag: string; size: number; manual: boolean; thumb: boolean }>();

let lastCacheNotice = 0;
/** 只广播状态变化，不携带文件名与私密信息；分块进度最多每两秒通知一次，完成时立即通知。 */
async function cacheChanged(complete = false) {
  manualCache = null; itemCache = null;
  const now = Date.now();
  if (!complete && now - lastCacheNotice < 2000) return;
  lastCacheNotice = now;
  for (const client of await sw.clients.matchAll({ type: "window" })) client.postMessage({ type: "tessera-cache:changed" });
}

/** 当前账号已缓存的文件（不含缩略图），键与 cacheFileId 相同；私密层只在私密空间已解锁时包含。 */
async function cacheIndex(withPrivate: boolean): Promise<IndexState[]> {
  const context = await normalContext();
  if (!context) return [];
  if (manualCache && manualCache.ns === context.ns && manualCache.withPrivate === withPrivate && Date.now() - manualCache.at < 5_000) return manualCache.items;
  const secret = withPrivate ? await privateContext({ tier: "p", etag: "", version: "", path: "", access: "", bucketId: null, thumb: false }) : null;
  const items: IndexState[] = [], flags: [string, boolean][] = [], seen = new Set<string>();
  for (const entry of await listEntries(context.ns)) {
    const tierContext = entry.tier === "n" ? context : secret;
    if (!tierContext || entry.kind === "thumb") continue;
    seen.add(entry.key);
    let known = infoMemo.get(entry.key);
    if (!known || known.size < entry.bytes) {
      const info = await openInfo(tierContext.info, entry);
      if (!info) continue;
      known = { etag: info.etag, size: info.size, manual: Boolean(info.manual), thumb: info.kind === "thumb" };
      infoMemo.set(entry.key, known);
      if (entry.manual === undefined) flags.push([entry.key, known.manual]);
    }
    if (known.thumb) continue;
    items.push({ id: `${entry.tier}:${known.etag}`, ...fileCacheState(entry, known.size), manual: entry.manual ?? known.manual });
  }
  for (const key of infoMemo.keys()) if (!seen.has(key) && infoMemo.size > seen.size) infoMemo.delete(key);
  await setManualFlags(flags);
  context.signal.throwIfAborted();
  manualCache = { ns: context.ns, withPrivate, at: Date.now(), items };
  return items;
}

/* ---------- 淘汰与对账 ---------- */

let evictTimer: number | undefined;
let evictRatio = 1;
let lastNamespace = "";

function scheduleEvict(delay = 3000, ratio = 1) {
  evictRatio = Math.min(evictRatio, ratio);
  if (evictTimer !== undefined) clearTimeout(evictTimer);
  evictTimer = setTimeout(() => { evictTimer = undefined; const factor = evictRatio; evictRatio = 1; void enforce(factor).catch(() => undefined); }, delay) as unknown as number;
}

async function enforce(factor = 1) {
  const preferences = await currentSettings();
  if (!lastNamespace) return;
  const normalBudget = tierBudget(preferences, "n"), privateBudget = tierBudget(preferences, "p");
  // 为手动任务预留剩余空间，普通预览的延迟淘汰也不能删除正在补全的条目。
  for (const tier of ["n", "p"] as const) {
    const reserved = [...manuals.values()].flatMap(job => job.opened?.tier.tier === tier ? [job.opened] : []);
    const remaining = reserved.reduce((sum, opened) => sum + Math.max(0, opened.info.size - opened.entry.bytes), 0);
    const keep = new Set(reserved.map(opened => opened.entry.key));
    await evict(await listEntries(lastNamespace, tier), Math.max(0, (tier === "n" ? normalBudget : privateBudget) * factor - remaining), entry => keep.has(entry.key));
  }
  // 其他账号留在这台设备上的数据同样计入：超过普通层上限时先淘汰它们中最久未用的。
  const others = (await listEntries()).filter(entry => entry.ns !== lastNamespace);
  await evict(others, normalBudget * factor);
}

let reconcileTimer: number | undefined;
let lastReconcile = 0;
let reconciling: Promise<void> | null = null;

function scheduleReconcile(delay = 3000) {
  if (reconcileTimer !== undefined) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = undefined;
    reconciling ??= reconcile().catch(() => undefined).finally(() => { reconciling = null; lastReconcile = Date.now(); });
  }, delay) as unknown as number;
}

async function etagsOf(context: TierContext, entries: EntryRecord[]) {
  const byEtag = new Map<string, string[]>();
  const broken: string[] = [];
  for (const entry of entries) {
    const info = await openInfo(context.info, entry);
    if (!info) { broken.push(entry.key); continue; }
    byEtag.set(info.etag, [...(byEtag.get(info.etag) ?? []), entry.key]);
  }
  await deleteEntries(broken);
  return byEtag;
}

/** 别处删除、覆盖或移出某个区域的文件：服务端不再引用这个版本时删除本地数据（解不开的条目同样删除）。 */
/** 停用本地缓存目录：删除数据在目录中的条目；目录仍有授权时一并删除其中的 tessera-cache 子文件夹，再移除配置。 */
async function stopDirectory() {
  const directory = await readDirectory();
  const entries = (await listEntries()).filter(entry => entry.store === "dir");
  await deleteEntries(entries.map(entry => entry.key));
  if (directory && await directoryRoot()) await directory.handle.removeEntry("tessera-cache", { recursive: true }).catch(() => undefined);
  await setMeta("directory", undefined);
  forgetDirectory(); settings = null; manualCache = null; itemCache = null;
  await cacheChanged(true).catch(() => undefined);
  return entries.length;
}

async function reconcile() {
  const context = await normalContext();
  if (!context) return;
  const byEtag = await etagsOf(context, await listEntries(context.ns, "n"));
  const etags = [...byEtag.keys()];
  for (let index = 0; index < etags.length; index += 500) {
    const batch = etags.slice(index, index + 500);
    const response = await post("/api/user/v1/cache/check", { etags: batch });
    if (!response.ok) return;
    const valid = new Set((await response.json() as { valid: string[] }).valid);
    await deleteEntries(batch.filter(etag => !valid.has(etag)).flatMap(etag => byEtag.get(etag) ?? []));
  }
  // 私密层：这台设备关闭私密缓存后清除全部副本；仍开启时在私密授权有效期间核对引用（文件已删除或移出就清除）。
  // 副本只以密文保存、需要解锁才能打开，不再按未访问天数自动清除。
  const privateEntries = await listEntries(context.ns, "p");
  if (!(await currentSettings()).private) {
    await deleteEntries(privateEntries.map(entry => entry.key));
    return;
  }
  const secret = privateTier && (Date.now() < privateTier.expires || privateTier.access === pageAccess && Date.now() < pageAccessExpires) ? await privateTier.promise : null;
  if (!secret || secret.signal.aborted) return;
  const privateEtags = await etagsOf(secret, await listEntries(context.ns, "p"));
  const list = [...privateEtags.keys()];
  for (let index = 0; index < list.length; index += 500) {
    const batch = list.slice(index, index + 500);
    const response = await post("/api/user/v1/private/cache/keys", { device: await deviceId(), etags: batch }, secret.access);
    if (!response.ok) { dropKeys("p"); return; }
    const keys = (await response.json() as { keys: Record<string, { key: string } | null> }).keys;
    for (const etag of batch) {
      const cached = await secret.materials.get(etag);
      // 其他设备重置缓存后，旧纪元的密钥不能继续复用。
      if (cached && keys[etag] && b64u(cached) !== keys[etag]!.key) { dropKeys("p"); return; }
      if (!keys[etag]) { secret.materials.delete(etag); secret.derived.clear(); }
    }
    await deleteEntries(batch.filter(etag => !keys[etag]).flatMap(etag => privateEtags.get(etag) ?? []));
  }
}

/* ---------- 页面消息 ---------- */

type Stats = {
  namespace: string | null; settings: DeviceSettings;
  normal: { bytes: number; count: number; kinds: Partial<Record<Kind, number>> }; private: { bytes: number; count: number }; others: { bytes: number; count: number };
};

/** 只读明文字段（字节数、条目数、大类），不解密任何条目：侧栏与设置页的统计都用它。 */
async function stats(): Promise<Stats> {
  const context = await normalContext();
  const namespace = context?.ns ?? (lastNamespace || null);
  const result: Stats = { namespace, settings: await currentSettings(), normal: { bytes: 0, count: 0, kinds: {} },
    private: { bytes: 0, count: 0 }, others: { bytes: 0, count: 0 } };
  for (const entry of await listEntries()) {
    const bucket = entry.ns !== namespace ? result.others : entry.tier === "p" ? result.private : result.normal;
    bucket.bytes += entry.bytes; bucket.count += 1;
    if (bucket === result.normal && entry.kind) result.normal.kinds[entry.kind] = (result.normal.kinds[entry.kind] ?? 0) + entry.bytes;
  }
  return result;
}

type Item = { key: string; path: string; kind: Kind; bytes: number; size: number; accessed: number; manual: boolean; complete: boolean; private: boolean };
type ItemQuery = { private?: boolean; all?: boolean; prefix?: string; query?: string; kind?: Kind | ""; status?: "" | "complete" | "partial"; origin?: "" | "manual" | "auto"; sort?: "recent" | "size" | "name"; offset?: number; limit?: number };
let itemCache: { ns: string; at: number; items: Item[] } | null = null;

/** 普通层已缓存文件的完整索引：解密一次后在内存里保留 15 秒，翻页、搜索与筛选都不再解密。缩略图不列出。 */
async function allItems(): Promise<Item[]> {
  const context = await normalContext();
  if (!context) return [];
  if (itemCache && itemCache.ns === context.ns && Date.now() - itemCache.at < 15_000) return itemCache.items;
  const items: Item[] = [];
  for (const entry of await listEntries(context.ns, "n")) {
    if (entry.kind === "thumb") continue;
    const info = await openInfo(context.info, entry);
    if (info) items.push({ key: entry.key, path: info.path, kind: info.kind, bytes: entry.bytes, size: info.size, accessed: entry.accessed,
      manual: Boolean(entry.manual ?? info.manual), complete: fileCacheState(entry, info.size).complete, private: false });
  }
  context.signal.throwIfAborted();
  itemCache = { ns: context.ns, at: Date.now(), items };
  return items;
}

/** 私密层已缓存的文件：只在私密空间已解锁、这台设备允许私密缓存时可读；每次重新解密，不在内存里保留路径。 */
async function privateItems(): Promise<Item[]> {
  const context = await normalContext();
  const secret = context && await privateContext({ tier: "p", etag: "", version: "", path: "", access: "", bucketId: null, thumb: false });
  if (!context || !secret) return [];
  const items: Item[] = [];
  for (const entry of await listEntries(context.ns, "p")) {
    if (entry.kind === "thumb") continue;
    const info = await openInfo(secret.info, entry);
    if (info && info.kind !== "thumb") items.push({ key: entry.key, path: info.path, kind: info.kind, bytes: entry.bytes, size: info.size, accessed: entry.accessed,
      manual: Boolean(entry.manual ?? info.manual), complete: fileCacheState(entry, info.size).complete, private: true });
  }
  context.signal.throwIfAborted();
  return items;
}

async function matchItems(options: ItemQuery) {
  const query = (options.query ?? "").trim().toLowerCase();
  // prefix：目录统计只看某个文件夹（含子文件夹）里的缓存；private：私密空间的目录统计读私密层。
  // all：普通层与（已解锁时的）私密层合在一起，「已缓存的文件」的「全部」标签使用；私密层锁定时只有普通层。
  const source = options.all ? [...await allItems(), ...await privateItems().catch(() => [] as Item[])] : await (options.private ? privateItems() : allItems());
  return source.filter(item => (!options.prefix || item.path.startsWith(options.prefix)) && (!query || item.path.toLowerCase().includes(query))
    && (!options.kind || (options.kind === "other" ? !["image", "video", "audio"].includes(item.kind) : item.kind === options.kind))
    && (!options.status || (options.status === "complete") === item.complete) && (!options.origin || (options.origin === "manual") === item.manual));
}

async function listItems(options: ItemQuery) {
  const matched = await matchItems(options);
  const order = options.sort ?? "recent";
  matched.sort(order === "size" ? (a, b) => b.bytes - a.bytes : order === "name" ? (a, b) => a.path.localeCompare(b.path, "zh-CN") : (a, b) => b.accessed - a.accessed);
  const offset = Math.max(0, options.offset ?? 0), limit = Math.max(1, Math.min(200, options.limit ?? 50));
  return { total: matched.length, bytes: matched.reduce((sum, item) => sum + item.bytes, 0), manual: matched.filter(item => item.manual).length,
    complete: matched.filter(item => item.complete).length, items: matched.slice(offset, offset + limit) };
}

/** 按同样的条件移除（「移除筛选出的文件」）；只作用于当前账号的普通层。 */
async function removeItems(options: ItemQuery) {
  const keys = new Set((await matchItems({ ...options, private: false })).map(item => item.key));
  stopManualWhere(job => Boolean(job.opened && keys.has(job.opened.entry.key)));
  await deleteEntries([...keys]);
  itemCache = null; manualCache = null;
  return keys.size;
}

async function clear(scope: string, key?: string) {
  const entries = await listEntries();
  const namespace = (await normalContext())?.ns ?? lastNamespace;
  // 单个条目：「本机缓存 → 已缓存的文件」中逐项清除，普通与私密层都只删除当前账号的副本。
  const victims = scope === "entry" ? entries.filter(entry => entry.key === key && (!namespace || entry.ns === namespace))
    : scope === "all" ? entries
    : scope === "others" ? entries.filter(entry => entry.ns !== namespace)
    : entries.filter(entry => entry.tier === (scope === "private" ? "p" : "n") && (!namespace || entry.ns === namespace));
  stopManualWhere(job => scope === "all" || scope === "normal" && job.route.tier === "n" || scope === "private" && job.route.tier === "p"
    || victims.some(entry => entry.key === job.opened?.entry.key));
  await deleteEntries(victims.map(entry => entry.key));
  itemCache = null; manualCache = null;
}

sw.addEventListener("message", event => {
  const data = event.data as { type?: string; access?: string; expires?: number; scope?: string; key?: string; id?: string; url?: string; urls?: string[];
    group?: string; paths?: string[]; csrf?: string; prefix?: string; cursor?: string | null } | null;
  const port = event.ports[0];
  const owner = event.source && "id" in event.source ? event.source.id : "";
  const reply = (work: Promise<unknown>) => event.waitUntil(work.then(value => port?.postMessage({ ok: true, value }), error => port?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error), fatal: error instanceof CacheFatal })));
  switch (data?.type) {
    case "tessera-cache:access":
      if (!data.access || pageAccess !== data.access || !data.expires || data.expires <= Date.now()) dropKeys("p");
      rememberAccess(typeof data.access === "string" ? data.access : "", data.expires);
      askedAt = 0;
      break;
    case "tessera-cache:logout": rememberAccess(""); dropKeys(); stopPrefetch(); break;
    case "tessera-cache:settings":
      settings = null; stopManual(); stopPrefetch(); dropKeys("p");
      for (const key of backgrounds.keys()) void finishBackground(key);
      reply(Promise.resolve(null)); break;
    case "tessera-cache:directory":
      // 页面选择、重新授权或停用了本地缓存目录：重新读取配置，清理目录里没有对应条目的残留文件。
      forgetDirectory(); settings = null; stopManual(); stopPrefetch(); manualCache = null; itemCache = null;
      reply(sweepDirectory().catch(() => 0)); break;
    case "tessera-cache:directory-off": stopManual(); stopPrefetch(); reply(stopDirectory()); break;
    case "tessera-cache:nudge":
      event.waitUntil(Promise.resolve(clearPrivateMaterials()));
      if (Date.now() - lastReconcile > 5000) scheduleReconcile(3000); break;
    case "tessera-cache:stats": reply(stats()); break;
    case "tessera-cache:items": reply(listItems((data as { filter?: ItemQuery }).filter ?? {})); break;
    case "tessera-cache:remove-items": reply(removeItems((data as { filter?: ItemQuery }).filter ?? {})); break;
    case "tessera-cache:clear": reply(clear(data.scope ?? "normal", data.key)); break;
    case "tessera-cache:reset": dropKeys(); reply(clear("all")); break;
    case "tessera-cache:files": reply(fileStates(data.urls ?? [])); break;
    case "tessera-cache:index": reply(cacheIndex((data as { private?: boolean }).private === true)); break;
    case "tessera-cache:queue-group": reply(startPrivateTask(owner, data.id ?? "", data.paths ?? [], data.csrf ?? "", data.access ?? "")); break;
    case "tessera-cache:list-group": reply(listBackground(owner, data.id ?? "", data.prefix ?? "", data.cursor)); break;
    case "tessera-cache:release-group": reply(releaseBackground(owner, data.id ?? "")); break;
    case "tessera-cache:start": reply(startManual(owner, data.id ?? "", data.url ?? "", data.group)); break;
    case "tessera-cache:step": reply(stepManual(owner, data.id ?? "", value => port?.postMessage({ progress: value }))); break;
    case "tessera-cache:cancel":
      stopManualWhere(job => job.owner === owner && (!data.id || job.id === data.id));
      reply(Promise.resolve(null)); break;
    case "tessera-cache:remove-file": reply(removeFile(data.url ?? "")); break;
    case "tessera-cache:prefetch": startPrefetch(owner, data.id ?? "", data.url ?? "", Number((data as { from?: unknown }).from ?? 0)); break;
    case "tessera-cache:prefetch-stop": for (const job of [...prefetches.values()]) if (job.owner === owner && (!data.id || job.id === data.id)) stopPrefetch(job); break;
  }
});

/* ---------- 生命周期 ---------- */

sw.addEventListener("install", () => {
  // 下载可能由导航触发，不能把全部 navigate 请求静态分流到网络。
  void sw.skipWaiting();
});
sw.addEventListener("activate", event => event.waitUntil(sw.clients.claim()));

sw.addEventListener("fetch", event => {
  const route = routeOf(event.request);
  if (!route) return;
  if (Date.now() - lastReconcile > 15 * 60_000 && reconcileTimer === undefined && !reconciling) scheduleReconcile(10_000);
  event.respondWith(handle(event.request, route).catch(error => {
    if (event.request.signal.aborted || error?.name === "AbortError") throw error;
    return direct(event.request);
  }));
});
