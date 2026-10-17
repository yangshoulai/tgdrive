/**
 * Tessera 浏览器本地缓存的 Service Worker（docs/client-cache-design.md）。
 *
 * 只接管带内容版本的文件与缩略图 GET 请求；其余请求不调用 respondWith，行为与没有 Service Worker 时一致。
 * 自动读取失败时退回服务器，手动缓存必须报告写入错误。密钥只放在内存里，Worker 重启后重新向服务端获取。
 */
import {
  BLOCK, type Bytes, type DeviceSettings, type EntryInfo, type EntryRecord, type Kind, type Tier,
  aesKey, b64u, blockAad, deleteEntries, deviceId, ensureEntry, evict, fileCacheState, fromB64u, getBlock, getEntry, hkdf, hmac,
  kindOf, listEntries, missingRun, open, openInfo, parseRange, putBlock, readSettings, resolveRange, seal, sealInfo, touchEntry, updateEntryInfo,
} from "../cache-store";

const sw = self as unknown as ServiceWorkerGlobalScope;
const MiB = 1 << 20;

/** 管理员策略只有开关与私密保留期；容量全部来自设备设置（tierBudget）。 */
type Policy = { enabled: boolean; private_enabled: boolean; private_ttl_days: number };
type EntryKeys = { id: string; key: CryptoKey };
type TierContext = {
  tier: Tier; ns: string; key: Bytes; info: CryptoKey; bucketId: number | null; access: string; signal: AbortSignal;
  materials: Map<string, Promise<Bytes>>; derived: Map<string, Promise<EntryKeys>>;
};
type Route = { tier: Tier; etag: string; version: string; path: string; access: string; bucketId: number | null; thumb: boolean };
type Opened = { tier: TierContext; entry: EntryRecord; info: EntryInfo; key: CryptoKey; request: Request; cap: number };
type Source = { start: number; response: Response; controller: AbortController };
type Manual = { id: string; owner: string; route: Route; request: Request; controller: AbortController; opened?: Opened; running: boolean };
let manual: Manual | null = null;

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
    return { tier, etag: version, version, path: params.get("path") ?? "", access: params.get("access") ?? "", bucketId, thumb: false };
  }
  const etag = params.get("etag");
  if (!etag) return null;
  return { tier, etag, version: `thumb|${etag}|${params.get("variant") ?? "thumb"}|${version}`, path: "", access: "", bucketId, thumb: true };
}

/* ---------- 设置、策略与密钥 ---------- */

let settings: { value: DeviceSettings; at: number } | null = null;
let policy: Policy | null = null;
type Cached = { promise: Promise<TierContext | null>; expires: number; access?: string };
let normal: Cached | null = null;
let privateTier: Cached | null = null;
let pageAccess = "";
let askedAt = 0;
const revocation = { n: new AbortController(), p: new AbortController() };
type PrivateBatch = { waiters: Map<string, (value: Bytes | null) => void>; timer: number };
const pendingPrivate = new Map<TierContext, PrivateBatch>();

/** 设备设置中这一层的容量（字节）。 */
const tierBudget = (preferences: DeviceSettings, tier: Tier) => (tier === "n" ? preferences.maxMiB : preferences.privateMaxMiB) * MiB;

async function currentSettings() {
  if (!settings || Date.now() - settings.at > 5000) settings = { value: await readSettings(navigator.userAgent), at: Date.now() };
  return settings.value;
}

function dropKeys(tier?: Tier) {
  if (manual && (!tier || manual.route.tier === tier)) stopManual();
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
  if (!tier || tier === "p") privateTier = null;
  if (!tier || tier === "n") normal = null;
}

async function post(path: string, body: unknown, access = "") {
  const response = await fetch(path, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", ...(access ? { "X-Private-Access": access } : {}) }, body: JSON.stringify(body),
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
    const body = await response.json() as { namespace: string; bucket_id: number; policy: Policy; key?: string };
    if (signal.aborted) return null;
    policy = body.policy;
    lastNamespace = body.namespace;
    if (!body.key) {
      // 管理员关闭了普通文件的本机缓存：这台设备上该账号的普通层数据不再允许保留。
      await deleteEntries((await listEntries(body.namespace, "n")).map(entry => entry.key));
      return null;
    }
    scheduleReconcile(5000);
    return tierContext("n", body.namespace, body.key, body.bucket_id, signal);
  })().catch(() => null);
  normal = remember(pending, 10 * 60_000);
  return pending;
}

async function privateContext(route: Route): Promise<TierContext | null> {
  const signal = revocation.p.signal;
  const [device, preferences, base] = await Promise.all([deviceId(), currentSettings(), normalContext()]);
  if (!preferences.private || !policy?.private_enabled || !base || base.signal.aborted || signal.aborted) return null;
  const access = route.access || pageAccess || await askAccess(signal);
  if (!access || signal.aborted) return null;
  // 私密层只保留 60 秒：撤销授权后很快就拿不到密钥；每个条目的密钥另有服务端逐次校验。
  if (privateTier && privateTier.access === access && Date.now() < privateTier.expires) return privateTier.promise;
  const pending: Promise<TierContext | null> = (async () => {
    const response = await post("/api/user/v1/private/cache/session", { device }, access);
    if (!response.ok) return null;
    const body = await response.json() as { namespace: string; key: string };
    return tierContext("p", body.namespace, body.key, null, signal, access);
  })().catch(() => null);
  privateTier = remember(pending, 60_000, access);
  return pending;
}

/** 普通层在本地从层级密钥派生；私密层逐个向服务端申请，同一时刻的请求合并成一批。 */
function material(context: TierContext, etag: string): Promise<Bytes | null> {
  if (context.signal.aborted) return Promise.resolve(null);
  // 私密密钥只合并当前并发批次，不能复用上一次读取的授权结果。
  if (context.tier === "p") return requestPrivate(context, etag);
  let value = context.materials.get(etag);
  if (!value) {
    if (context.materials.size > 4000) context.materials.clear();
    value = hkdf(context.key, "entry|" + etag);
    context.materials.set(etag, value);
    value.catch(() => context.materials.delete(etag));
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
  if (context.tier === "p") return derive();
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
    const access = await new Promise<string>(resolve => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(""), 500);
      channel.port1.onmessage = event => { clearTimeout(timer); resolve(typeof event.data?.access === "string" ? event.data.access : ""); };
      client.postMessage({ type: "tessera-cache:context?" }, [channel.port2]);
    });
    if (signal.aborted) return "";
    if (access) { pageAccess = access; return access; }
  }
  return "";
}

/* ---------- 读写 ---------- */

const etagOf = (response: Response) => (response.headers.get("etag") ?? "").replace(/^W\//, "");
/** 这些请求即使回源也不会建立条目（页面、PDF 内嵌等）：没有本机条目时直接回源，免得先发一次对齐请求再丢弃。 */
const UNCACHED_DESTINATIONS = new Set(["document", "iframe", "frame", "embed", "object", "script", "style", "font", "worker", "sharedworker", "manifest", "report"]);
const direct = (request: Request) => fetch(request, { cache: "no-store" });

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
  let info = entry ? await openInfo(context.info, entry) : null;
  if (entry && !info) { await deleteEntries([key]); entry = undefined; }
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
    if (!info.size) return new Response(null, { headers: { "Content-Type": info.type, "Content-Length": "0", "Content-Disposition": info.disposition, "Cache-Control": "no-store", "X-Tessera-Cache": "hit", ETag: info.version } });
    return build({ tier: context, entry, info, key: keys.key, request, cap }, range ?? null);
  }
  if (download) return direct(request);
  // 关闭自动缓存视频（Safari 默认）时，播放器的每次拖动都只发原始请求，不能变成两次回源。
  if (UNCACHED_DESTINATIONS.has(request.destination) || request.destination === "video" && !preferences.video) return direct(request);
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
    const upstream = await fetch(request, { cache: "no-store", signal: controller.signal, headers });
    if (upstream.status === 401) { dropKeys(); return direct(request); }
    const total = upstream.status === 206 ? Number(/\/(\d+)$/.exec(upstream.headers.get("content-range") ?? "")?.[1])
      : upstream.status === 200 ? Number(upstream.headers.get("content-length")) : NaN;
    const validator = etagOf(upstream);
    const bypass = () => {
      // 对齐后的响应不能直接用于原始 Range，版本变化等降级路径必须重发原始请求。
      if (range) { controller.abort(); return direct(request); }
      handedOff = true;
      return upstream;
    };
    if (!Number.isSafeInteger(total) || total <= 0 || !upstream.body || (!route.thumb && validator !== `"${route.etag}"`)) return bypass();
    const type = upstream.headers.get("content-type") ?? "application/octet-stream";
    const kind: Kind = route.thumb ? "thumb" : kindOf(type, request.destination);
    if (kind === "other" || kind === "video" && !preferences.video) return bypass();
    const record: EntryRecord = { key, ns: context.ns, tier: context.tier, id: keys.id, blocks: [], bytes: 0, accessed: now, created: now,
      ...(context.tier === "n" ? { kind } : {}), info: null };
    info = { etag: route.etag, version: validator, size: total, type, disposition: upstream.headers.get("content-disposition") ?? "inline", path: route.path, kind };
    record.info = await sealInfo(context.info, record, info);
    context.signal.throwIfAborted();
    entry = await ensureEntry(record);
    const stored = await openInfo(context.info, entry);
    if (!stored) return bypass();
    context.signal.throwIfAborted();
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
  const last = Math.floor((info.size - 1) / BLOCK);
  let pos = span.start;
  try {
    while (pos <= span.end) {
      signal.throwIfAborted();
      const index = Math.floor(pos / BLOCK);
      if (opened.entry.blocks.includes(index)) {
        let plain: Bytes | undefined;
        try {
          const sealed = await getBlock(opened.entry.key, index);
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
        response = await fetch(opened.request, { cache: "no-store", signal: controller.signal, headers });
        if (response.status === 401) dropKeys();
        if (response.status !== 206 || etagOf(response) !== info.version) {
          controller.abort();
          // 服务端的文件已变化：这个条目不能再续写。
          if (response.ok) await deleteEntries([opened.entry.key]);
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
          await writer.push(value);
          signal.throwIfAborted();
          const chunkStart = offset;
          offset += value.length;
          const to = Math.min(value.length, span.end - chunkStart + 1);
          const from = Math.max(0, pos - chunkStart);
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
      if (this.strict) throw new Error("文件超过本机缓存的单文件上限");
      this.stopped = true; return;
    }
    try {
      const sealed = await seal(this.opened.key, data, blockAad(entry, index));
      this.opened.tier.signal.throwIfAborted();
      this.strict?.signal.throwIfAborted();
      const updated = await putBlock(entry.key, index, sealed, data.length);
      if (!updated) {
        if (this.strict) throw new Error("缓存已被清理，请重试");
        this.stopped = true; return;
      }
      this.opened.entry = updated;
      this.strict?.signal.throwIfAborted();
      this.strict?.stored();
      scheduleEvict();
    } catch (error) {
      if (this.strict) {
        if (error instanceof DOMException && error.name === "QuotaExceededError") throw new Error("浏览器存储空间不足，请清理本机缓存后重试");
        throw error;
      }
      // 多半是浏览器配额不足：先淘汰一部分，这次读取不再写入。
      this.stopped = true;
      scheduleEvict(0, 0.75);
    }
  }
}

/* ---------- 手动补全：页面调度，Worker 每次只处理至多 8 MiB ---------- */

let manualTimer: number | undefined;
function stopManual() {
  manual?.controller.abort(); manual = null;
  clearTimeout(manualTimer); manualTimer = undefined;
}

function renewManual(job: Manual) {
  clearTimeout(manualTimer);
  // 页面关闭、消息超时或 Worker 重启都不留下持久任务；已提交的块仍可再次续传。
  manualTimer = setTimeout(() => { if (manual === job) stopManual(); }, 120_000) as unknown as number;
}

function manualRoute(url: string) {
  const request = new Request(new URL(url, sw.location.origin), { credentials: "same-origin" });
  const route = routeOf(request);
  if (!route || route.thumb || new URL(request.url).searchParams.get("download") === "1") throw new Error("只能缓存自己的普通或私密文件");
  return { request, route };
}

async function manualOpened(url: string) {
  const { request, route } = manualRoute(url);
  const value = await openEntry(request, route);
  if (!value) throw new Error(route.tier === "p" ? "请解锁私密空间，并在本机缓存设置中允许缓存私密文件" : "本机缓存未启用，请检查用户设置与管理员策略");
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
    return { ...fileCacheState(info ? entry : undefined, info?.size ?? 0), busy: manual?.opened?.entry.key === value.key };
  }));
}

async function verifyManual(job: Manual) {
  const response = await fetch(job.request, { method: "HEAD", cache: "no-store", signal: job.controller.signal });
  if (response.status === 401) dropKeys();
  if (!response.ok) throw new Error(`无法读取文件（${response.status}），请刷新列表后重试`);
  if (etagOf(response) !== `"${job.route.etag}"`) {
    if (job.opened) await deleteEntries([job.opened.entry.key]);
    throw new Error("文件已变化，请刷新列表后重新缓存");
  }
  return response;
}

async function startManual(owner: string, id: string, url: string) {
  if (!owner || !id || id.length > 100) throw new Error("缓存任务来源无效");
  if (manual) return { busy: true };
  const { request, route } = manualRoute(url);
  const job: Manual = { owner, id, request, route, controller: new AbortController(), running: false };
  manual = job; renewManual(job);
  try {
    // 点击时重取账号策略；长期播放的普通预览仍按原有的上下文周期复用。
    normal = null;
    const value = await manualOpened(url);
    job.controller.signal.throwIfAborted();
    const abort = () => job.controller.abort();
    value.context.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await verifyManual(job);
      const size = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("服务器未提供有效的文件大小");
      const preferences = await currentSettings();
      const budget = tierBudget(preferences, route.tier), cap = budget;
      if (size > budget) throw new Error("文件超过本机缓存容量，请先在「用户设置 → 本机缓存」中提高上限");
      let entry = await getEntry(value.key);
      let info = entry ? await openInfo(value.context.info, entry) : null;
      if (entry && (!info || info.size !== size)) { await deleteEntries([value.key]); entry = undefined; }
      const now = Date.now(), type = response.headers.get("content-type") ?? "application/octet-stream", kind = kindOf(type, "");
      info = { etag: route.etag, version: etagOf(response), path: route.path, type, size, kind,
        disposition: response.headers.get("content-disposition") ?? "inline", manual: true };
      const record: EntryRecord = { key: value.key, ns: value.context.ns, tier: route.tier, id: value.keys.id, blocks: [], bytes: 0,
        created: now, accessed: now, ...(route.tier === "n" ? { kind } : {}), info: null };
      record.info = await sealInfo(value.context.info, record, info);
      job.controller.signal.throwIfAborted();
      entry = await ensureEntry(record);
      job.controller.signal.throwIfAborted();
      await updateEntryInfo(entry.key, record.info);
      job.controller.signal.throwIfAborted();
      job.opened = { tier: value.context, entry, info, key: value.keys.key, request, cap };
      await enforce();
      const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
      if (estimate?.quota && estimate.usage !== undefined && estimate.quota - estimate.usage < size - entry.bytes + Math.ceil(size / BLOCK) * 28)
        throw new Error("浏览器存储空间不足，请清理本机缓存后重试");
      job.controller.signal.throwIfAborted();
      const state = fileCacheState(entry, size);
      if (state.complete) stopManual();
      return { busy: false, ...state };
    } finally { value.context.signal.removeEventListener("abort", abort); }
  } catch (error) { if (manual === job) stopManual(); throw error; }
}

async function stepManual(owner: string, id: string, progress: (value: unknown) => void) {
  const job = manual;
  if (!job || job.owner !== owner || job.id !== id || !job.opened) throw new Error("缓存任务已停止，请重试以继续缓存");
  if (job.running) throw new Error("缓存任务正在写入");
  job.running = true; renewManual(job);
  const abort = () => job.controller.abort();
  try {
    const value = await manualOpened(job.request.url);
    if (value.key !== job.opened.entry.key) throw new Error("缓存密钥已变化，请重试");
    value.context.signal.addEventListener("abort", abort, { once: true });
    job.controller.signal.throwIfAborted();
    const entry = await getEntry(value.key);
    if (!entry) throw new Error("缓存已被清理，请重试");
    const opened = job.opened = { ...job.opened, tier: value.context, key: value.keys.key, entry };
    const count = Math.ceil(opened.info.size / BLOCK);
    const present = new Set(entry.blocks);
    let missing = 0;
    while (present.has(missing)) missing++;
    const index = missing < count ? missing : undefined;
    if (index !== undefined) {
      const end = Math.min(opened.info.size - 1, (Math.min(index + 7, missingRun(entry.blocks, index, count - 1)) + 1) * BLOCK - 1);
      const headers = new Headers({ Range: `bytes=${index * BLOCK}-${end}` });
      const response = await fetch(job.request, { headers, cache: "no-store", signal: job.controller.signal });
      if (response.status === 401) dropKeys();
      if (response.status !== 206 || etagOf(response) !== opened.info.version || response.headers.get("content-range") !== `bytes ${index * BLOCK}-${end}/${opened.info.size}`) {
        await response.body?.cancel();
        if (response.ok) { await deleteEntries([entry.key]); throw new Error("文件已变化，请刷新列表后重新缓存"); }
        throw new Error(`读取文件失败（${response.status}），请稍后重试`);
      }
      if (!response.body) throw new Error("服务器未返回文件内容");
      const reader = response.body.getReader();
      const writer = new BlockWriter(opened, index, { signal: job.controller.signal, stored: () => {
        if (manual !== job || job.controller.signal.aborted) return;
        renewManual(job); progress(fileCacheState(opened.entry, opened.info.size));
      } });
      let received = 0;
      try {
        while (true) {
          job.controller.signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > end - index * BLOCK + 1) throw new Error("服务器返回的数据大小不符");
          await writer.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (received !== end - index * BLOCK + 1) throw new Error("服务器提前结束了响应，请重试以继续缓存");
    }
    job.controller.signal.throwIfAborted();
    const state = fileCacheState(await getEntry(entry.key), opened.info.size);
    if (state.complete) { await verifyManual(job); if (manual === job) stopManual(); }
    return state;
  } catch (error) { if (manual === job) stopManual(); throw error; }
  finally { job.opened?.tier.signal.removeEventListener("abort", abort); job.running = false; }
}

async function removeFile(url: string) {
  const value = await manualOpened(url);
  if (manual?.route.etag === value.route.etag && manual.route.tier === value.route.tier) stopManual();
  await deleteEntries([value.key]);
  itemCache = null;
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
    const opened = manual?.opened;
    const reserved = opened?.tier.tier === tier ? opened : undefined;
    const remaining = reserved ? Math.max(0, reserved.info.size - reserved.entry.bytes) : 0;
    await evict(await listEntries(lastNamespace, tier), Math.max(0, (tier === "n" ? normalBudget : privateBudget) * factor - remaining), entry => entry.key === reserved?.entry.key);
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
  // 私密层：先按保留期清理（不需要密钥），再在私密授权有效时核对引用。
  const ttl = (policy?.private_ttl_days ?? 7) * 86_400_000;
  const privateEntries = await listEntries(context.ns, "p");
  await deleteEntries(privateEntries.filter(entry => Date.now() - entry.accessed > ttl).map(entry => entry.key));
  if (!policy?.private_enabled || !(await currentSettings()).private) {
    await deleteEntries(privateEntries.map(entry => entry.key));
    return;
  }
  const secret = privateTier && Date.now() < privateTier.expires ? await privateTier.promise : null;
  if (!secret || secret.signal.aborted) return;
  const privateEtags = await etagsOf(secret, await listEntries(context.ns, "p"));
  const list = [...privateEtags.keys()];
  for (let index = 0; index < list.length; index += 500) {
    const batch = list.slice(index, index + 500);
    const response = await post("/api/user/v1/private/cache/keys", { device: await deviceId(), etags: batch }, secret.access);
    if (!response.ok) return;
    const keys = (await response.json() as { keys: Record<string, unknown> }).keys;
    await deleteEntries(batch.filter(etag => !keys[etag]).flatMap(etag => privateEtags.get(etag) ?? []));
  }
}

/* ---------- 页面消息 ---------- */

type Stats = {
  namespace: string | null; policy: Policy | null; settings: DeviceSettings;
  normal: { bytes: number; count: number; kinds: Partial<Record<Kind, number>> }; private: { bytes: number; count: number }; others: { bytes: number; count: number };
};

/** 只读明文字段（字节数、条目数、大类），不解密任何条目：侧栏与设置页的统计都用它。 */
async function stats(): Promise<Stats> {
  const context = await normalContext();
  const namespace = context?.ns ?? (lastNamespace || null);
  const result: Stats = { namespace, policy, settings: await currentSettings(), normal: { bytes: 0, count: 0, kinds: {} },
    private: { bytes: 0, count: 0 }, others: { bytes: 0, count: 0 } };
  for (const entry of await listEntries()) {
    const bucket = entry.ns !== namespace ? result.others : entry.tier === "p" ? result.private : result.normal;
    bucket.bytes += entry.bytes; bucket.count += 1;
    if (bucket === result.normal && entry.kind) result.normal.kinds[entry.kind] = (result.normal.kinds[entry.kind] ?? 0) + entry.bytes;
  }
  return result;
}

type Item = { key: string; path: string; kind: Kind; bytes: number; size: number; accessed: number; manual: boolean; complete: boolean };
type ItemQuery = { query?: string; kind?: Kind | ""; status?: "" | "complete" | "partial"; sort?: "recent" | "size" | "name"; offset?: number; limit?: number };
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
      manual: Boolean(info.manual), complete: fileCacheState(entry, info.size).complete });
  }
  context.signal.throwIfAborted();
  itemCache = { ns: context.ns, at: Date.now(), items };
  return items;
}

async function matchItems(options: ItemQuery) {
  const query = (options.query ?? "").trim().toLowerCase();
  return (await allItems()).filter(item => (!query || item.path.toLowerCase().includes(query))
    && (!options.kind || (options.kind === "other" ? !["image", "video", "audio"].includes(item.kind) : item.kind === options.kind))
    && (!options.status || (options.status === "complete") === item.complete));
}

async function listItems(options: ItemQuery) {
  const matched = await matchItems(options);
  const order = options.sort ?? "recent";
  matched.sort(order === "size" ? (a, b) => b.bytes - a.bytes : order === "name" ? (a, b) => a.path.localeCompare(b.path, "zh-CN") : (a, b) => b.accessed - a.accessed);
  const offset = Math.max(0, options.offset ?? 0), limit = Math.max(1, Math.min(200, options.limit ?? 50));
  return { total: matched.length, bytes: matched.reduce((sum, item) => sum + item.bytes, 0), items: matched.slice(offset, offset + limit) };
}

/** 按同样的条件移除（「移除筛选出的文件」）；只作用于当前账号的普通层。 */
async function removeItems(options: ItemQuery) {
  const keys = new Set((await matchItems(options)).map(item => item.key));
  if (manual?.opened && keys.has(manual.opened.entry.key)) stopManual();
  await deleteEntries([...keys]);
  itemCache = null;
  return keys.size;
}

async function clear(scope: string, key?: string) {
  const entries = await listEntries();
  const namespace = (await normalContext())?.ns ?? lastNamespace;
  const victims = scope === "entry" ? entries.filter(entry => entry.key === key && entry.tier === "n")
    : scope === "all" ? entries
    : scope === "others" ? entries.filter(entry => entry.ns !== namespace)
    : entries.filter(entry => entry.tier === (scope === "private" ? "p" : "n") && (!namespace || entry.ns === namespace));
  if (manual && (scope === "all" || scope === "normal" && manual.route.tier === "n" || scope === "private" && manual.route.tier === "p"
    || victims.some(entry => entry.key === manual?.opened?.entry.key))) stopManual();
  await deleteEntries(victims.map(entry => entry.key));
  itemCache = null;
}

sw.addEventListener("message", event => {
  const data = event.data as { type?: string; access?: string; scope?: string; key?: string; id?: string; url?: string; urls?: string[] } | null;
  const port = event.ports[0];
  const owner = event.source && "id" in event.source ? event.source.id : "";
  const reply = (work: Promise<unknown>) => event.waitUntil(work.then(value => port?.postMessage({ ok: true, value }), error => port?.postMessage({ ok: false, error: String(error).replace(/^Error: /, "") })));
  switch (data?.type) {
    case "tessera-cache:access":
      if (!data.access || pageAccess !== data.access) dropKeys("p");
      pageAccess = typeof data.access === "string" ? data.access : "";
      askedAt = 0;
      break;
    case "tessera-cache:logout": pageAccess = ""; dropKeys(); break;
    case "tessera-cache:settings": settings = null; stopManual(); dropKeys("p"); reply(Promise.resolve(null)); break;
    case "tessera-cache:nudge": if (Date.now() - lastReconcile > 5000) scheduleReconcile(3000); break;
    case "tessera-cache:stats": reply(stats()); break;
    case "tessera-cache:items": reply(listItems((data as { filter?: ItemQuery }).filter ?? {})); break;
    case "tessera-cache:remove-items": reply(removeItems((data as { filter?: ItemQuery }).filter ?? {})); break;
    case "tessera-cache:clear": reply(clear(data.scope ?? "normal", data.key)); break;
    case "tessera-cache:reset": dropKeys(); reply(clear("all")); break;
    case "tessera-cache:files": reply(fileStates(data.urls ?? [])); break;
    case "tessera-cache:start": reply(startManual(owner, data.id ?? "", data.url ?? "")); break;
    case "tessera-cache:step": reply(stepManual(owner, data.id ?? "", value => port?.postMessage({ progress: value }))); break;
    case "tessera-cache:cancel":
      if (manual?.owner === owner && (!data.id || manual.id === data.id)) stopManual();
      reply(Promise.resolve(null)); break;
    case "tessera-cache:remove-file": reply(removeFile(data.url ?? "")); break;
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
