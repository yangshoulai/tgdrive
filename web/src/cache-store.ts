/**
 * 浏览器本地缓存的存储与加密（docs/client-cache-design.md）。页面与 Service Worker 共用：
 * 只依赖 IndexedDB、WebCrypto 等两种环境都有的接口，不引用 DOM 或 Service Worker 专有类型。
 *
 * 文件内容按 1 MiB 分块，每块单独 AES-256-GCM 加密；条目的路径、类型、ETag 与大小放在加密的 info 里，
 * 明文只有统计和淘汰需要的字段。页面不持有密钥，只能读统计、删除数据。
 */

export const BLOCK = 1 << 20;
export const DB_NAME = "tessera-cache";
export type Tier = "n" | "p";
export type Kind = "image" | "video" | "audio" | "thumb" | "other";
export type Bytes = Uint8Array<ArrayBuffer>;

export type EntryRecord = {
  key: string; ns: string; tier: Tier; id: string;
  blocks: number[]; bytes: number; accessed: number; created: number;
  /** 只有普通层记录大类，供「本机缓存」页统计；私密层不记录。 */
  kind?: Kind;
  /** 用户手动缓存过（与加密 info 里的 manual 一致）：文件列表只为这些条目显示状态，不必逐个解密。1.11.0 留下的条目没有这个字段，首次建立索引时补上。 */
  manual?: boolean;
  /** 数据块存放位置："dir" 为用户选择的本地文件夹（不占浏览器配额），缺省为 IndexedDB。 */
  store?: "dir";
  info: ArrayBuffer | null;
};
export type EntryInfo = { etag: string; version: string; size: number; type: string; disposition: string; path: string; kind: Kind; manual?: boolean };
export type FileCacheState = { bytes: number; size: number; complete: boolean };

/** 只把全部块已经提交的条目视为完成；字节数相等还不足以证明中间没有缺块。 */
export function fileCacheState(entry: EntryRecord | undefined, size: number): FileCacheState {
  const count = Math.ceil(size / BLOCK);
  return { bytes: entry?.bytes ?? 0, size, complete: Boolean(entry && entry.bytes === size && entry.blocks.length === count && entry.blocks.every((value, index) => value === index)) };
}
export type DeviceSettings = { enabled: boolean; maxMiB: number; video: boolean; private: boolean; privateMaxMiB: number };
export const SIZE_CHOICES = [256, 512, 1024, 2048, 5120, 10240, 20480, 51200, 102400, 204800, 512000];
/** 实际生效的容量（MiB）：用户设置不能突破浏览器给这个网站的配额（quota 为字节，未知时只按设置）。 */
export const effectiveMiB = (value: number, quota?: number | null) => quota ? Math.max(1, Math.min(value, Math.floor(quota / 1048576))) : value;
/** 设置页可选的容量：只列出不超过浏览器配额的选项；配额比最小选项还小时保留最小一项。 */
export const sizeChoices = (quota?: number | null) => {
  const fit = quota ? SIZE_CHOICES.filter(choice => choice * 1048576 <= quota) : SIZE_CHOICES;
  return fit.length ? fit : SIZE_CHOICES.slice(0, 1);
};

/* ---------- IndexedDB ---------- */

let opening: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "key" }).createIndex("scope", ["ns", "tier"]);
      if (!db.objectStoreNames.contains("blocks")) db.createObjectStore("blocks");
    };
    request.onsuccess = () => {
      const db = request.result;
      // 另一个上下文升级数据库时主动让出连接，下次使用重新打开。
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
    request.onerror = () => { opening = null; reject(request.error); };
    request.onblocked = () => { opening = null; reject(new Error("本机缓存数据库被占用")); };
  });
  return opening;
}

const done = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
  const tx = (await openDb()).transaction(stores, mode);
  const finished = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("本机缓存写入被中止"));
  });
  try {
    const result = await body(tx);
    await finished;
    return result;
  } catch (error) {
    // 请求与事务可能同时失败，必须接住两条拒绝，写入配额错误才不会变成未处理异常。
    // put 也可能同步抛出配额错误；显式回滚此前排队的索引更新，不能留下没有数据的块编号。
    try { tx.abort(); } catch { /* 事务可能已经自动中止或完成 */ }
    await finished.catch(() => undefined);
    throw error;
  }
}

export const getMeta = <T>(key: string) => run(["meta"], "readonly", tx => done(tx.objectStore("meta").get(key)) as Promise<T | undefined>);
export const setMeta = (key: string, value: unknown) => run(["meta"], "readwrite", tx => { tx.objectStore("meta").put(value, key); });
export const getEntry = (key: string) => run(["entries"], "readonly", tx => done(tx.objectStore("entries").get(key)) as Promise<EntryRecord | undefined>);
export const putEntry = (entry: EntryRecord) => run(["entries"], "readwrite", tx => { tx.objectStore("entries").put(entry); });
/** 读取一个数据块；目录中的块在文件夹不可用或文件缺失时返回 undefined，由调用方回源。 */
export async function getBlock(key: string, index: number, store?: "dir"): Promise<ArrayBuffer | undefined> {
  if (store === "dir") {
    const folder = await entryFolder(key, false);
    if (!folder) return undefined;
    try { return await (await (await folder.getFileHandle(`${index}`)).getFile()).arrayBuffer(); } catch { return undefined; }
  }
  return run(["blocks"], "readonly", tx => done(tx.objectStore("blocks").get(`${key}/${index}`)) as Promise<ArrayBuffer | undefined>);
}

export function listEntries(ns?: string, tier?: Tier): Promise<EntryRecord[]> {
  return run(["entries"], "readonly", tx => {
    const store = tx.objectStore("entries");
    return done(ns && tier ? store.index("scope").getAll([ns, tier]) : store.getAll()) as Promise<EntryRecord[]>;
  });
}

/** 删除条目及其全部数据块；块键以「条目键/」开头，按前缀范围删除。目录中的块在提交后尽力删除，
 * 文件夹暂时不可用时留下的文件由 sweepDirectory 在下次可用时清理。 */
export async function deleteEntries(keys: string[]): Promise<void> {
  if (!keys.length) return;
  const folders: string[] = [];
  await run(["entries", "blocks"], "readwrite", async tx => {
    for (const key of keys) {
      const entry = await done(tx.objectStore("entries").get(key)) as EntryRecord | undefined;
      if (entry?.store === "dir") folders.push(key);
      tx.objectStore("entries").delete(key);
      tx.objectStore("blocks").delete(IDBKeyRange.bound(`${key}/`, `${key}/\uffff`));
    }
  });
  for (const key of folders) await removeEntryFolder(key).catch(() => undefined);
}

/** 条目不存在时才创建，已存在则返回现有记录（同一文件的并发首次请求不能互相覆盖块列表）。 */
export function ensureEntry(entry: EntryRecord): Promise<EntryRecord> {
  return run(["entries"], "readwrite", async tx => {
    const store = tx.objectStore("entries");
    const existing = await done(store.get(entry.key)) as EntryRecord | undefined;
    if (existing) return existing;
    store.put(entry);
    return entry;
  });
}

/** 只更新最后访问时间，不覆盖其他字段。 */
export function touchEntry(key: string, time: number): Promise<void> {
  return run(["entries"], "readwrite", async tx => {
    const store = tx.objectStore("entries");
    const entry = await done(store.get(key)) as EntryRecord | undefined;
    if (entry) { entry.accessed = time; store.put(entry); }
  });
}

/** 元信息更新不能覆盖预览或另一个读取刚刚提交的块列表。 */
export function updateEntryInfo(key: string, info: ArrayBuffer, manual?: boolean): Promise<void> {
  return run(["entries"], "readwrite", async tx => {
    const store = tx.objectStore("entries");
    const entry = await done(store.get(key)) as EntryRecord | undefined;
    if (!entry) throw new Error("缓存已被清理，请重试");
    entry.info = info;
    if (manual !== undefined) entry.manual = manual;
    store.put(entry);
  });
}

/** 只更新手动标记（为旧条目补字段），不覆盖并发写入的块列表。 */
export function setManualFlags(flags: [string, boolean][]): Promise<void> {
  if (!flags.length) return Promise.resolve();
  return run(["entries"], "readwrite", async tx => {
    const store = tx.objectStore("entries");
    for (const [key, manual] of flags) {
      const entry = await done(store.get(key)) as EntryRecord | undefined;
      if (entry) { entry.manual = manual; store.put(entry); }
    }
  });
}

/** 写入一个数据块并在同一事务里更新条目的块列表与字节数；条目已被删除时放弃写入，返回 null。
 * 目录条目先把块写成文件（关闭时整体替换，不会留下半个块），再登记到条目；条目已删除时撤回文件。 */
export async function putBlock(key: string, index: number, sealed: ArrayBuffer, plainLength: number, store?: "dir"): Promise<EntryRecord | null> {
  if (store === "dir") {
    const folder = await entryFolder(key, true);
    if (!folder) throw new DOMException("本机缓存目录不可用，请在缓存设置中重新授权", "NotAllowedError");
    const writable = await (await folder.getFileHandle(`${index}`, { create: true })).createWritable();
    try { await writable.write(sealed); await writable.close(); }
    catch (error) { await writable.abort().catch(() => undefined); throw error; }
    const updated = await run(["entries"], "readwrite", async tx => {
      const entries = tx.objectStore("entries");
      const entry = await done(entries.get(key)) as EntryRecord | undefined;
      if (!entry) return null;
      if (!entry.blocks.includes(index)) {
        entry.blocks = [...entry.blocks, index].sort((a, b) => a - b);
        entry.bytes += plainLength;
      }
      entries.put(entry);
      return entry;
    });
    if (!updated) await removeEntryFolder(key).catch(() => undefined);
    return updated;
  }
  return run(["entries", "blocks"], "readwrite", async tx => {
    const entries = tx.objectStore("entries");
    const entry = await done(entries.get(key)) as EntryRecord | undefined;
    if (!entry) return null;
    if (!entry.blocks.includes(index)) {
      entry.blocks = [...entry.blocks, index].sort((a, b) => a - b);
      entry.bytes += plainLength;
    }
    entries.put(entry);
    tx.objectStore("blocks").put(sealed, `${key}/${index}`);
    return entry;
  });
}

/** 淘汰到不超过 target 字节；返回删除的条目键。自动缓存先按最后访问时间移除，
 * 只有全部自动缓存都移除后仍超出（例如用户调低了上限）才动手动缓存——手动缓存的优先级更高。 */
export async function evict(entries: EntryRecord[], target: number, keep?: (entry: EntryRecord) => boolean): Promise<string[]> {
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const victims: string[] = [];
  for (const entry of [...entries].sort((a, b) => Number(Boolean(a.manual)) - Number(Boolean(b.manual)) || a.accessed - b.accessed)) {
    if (total <= target) break;
    if (keep?.(entry)) continue;
    victims.push(entry.key); total -= entry.bytes;
  }
  await deleteEntries(victims);
  return victims;
}

/* ---------- 本地缓存目录（File System Access API，桌面 Chrome／Edge） ---------- */

/** 用户选择的文件夹：句柄存在 meta 表，页面与 Service Worker 共用。数据块写在其中的 tessera-cache 子文件夹，
 * 按「命名空间/层/条目编号/块序号」分层；文件名只有不可逆的编号，内容是加密后的块，离开 Tessera 无法打开。 */
export type CacheDirectory = { handle: FileSystemDirectoryHandle; name: string; since: number };
export type DirectoryPermission = "granted" | "prompt" | "denied";
export const DIRECTORY_FOLDER = "tessera-cache";
type PermissionHandle = FileSystemDirectoryHandle & { queryPermission?: (options: { mode: "readwrite" }) => Promise<PermissionState> };
let rootMemo: { at: number; root: FileSystemDirectoryHandle | null } | null = null;

export const directorySupported = () => typeof globalThis.FileSystemDirectoryHandle !== "undefined";
export const readDirectory = () => getMeta<CacheDirectory>("directory").catch(() => undefined);
export async function directoryPermission(directory?: CacheDirectory): Promise<DirectoryPermission> {
  try { return (await (directory?.handle as PermissionHandle | undefined)?.queryPermission?.({ mode: "readwrite" })) as DirectoryPermission ?? "denied"; }
  catch { return "denied"; }
}
/** 选择或停用目录后让各上下文重新检查（Worker 内最多沿用 5 秒）。 */
export const forgetDirectory = () => { rootMemo = null; };

/** 已授权的缓存根目录；未配置或未授权时为 null（不在后台弹出授权，授权只能由页面在用户点击后完成）。 */
export async function directoryRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (rootMemo && Date.now() - rootMemo.at < 5000) return rootMemo.root;
  const directory = await readDirectory();
  let root: FileSystemDirectoryHandle | null = null;
  if (directory && await directoryPermission(directory) === "granted") {
    try { root = await directory.handle.getDirectoryHandle(DIRECTORY_FOLDER, { create: true }); } catch { root = null; }
  }
  rootMemo = { at: Date.now(), root };
  return root;
}

/** 新条目的数据块放在哪里："dir" 目录、"idb" 浏览器存储；配置了目录但暂未授权时为 null（不写入，等用户重新授权）。 */
export async function preferredStore(): Promise<"dir" | "idb" | null> {
  if (!(await readDirectory())) return "idb";
  return await directoryRoot() ? "dir" : null;
}

const segment = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, character => `~${character.charCodeAt(0).toString(16)}`) || "_";

async function entryFolder(key: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  let folder = await directoryRoot();
  if (!folder) return null;
  try {
    for (const part of key.split("/")) folder = await folder.getDirectoryHandle(segment(part), { create });
    return folder;
  } catch { return null; }
}

async function removeEntryFolder(key: string) {
  const parts = key.split("/");
  const parent = await entryFolder(parts.slice(0, -1).join("/"), false);
  await parent?.removeEntry(segment(parts.at(-1)!), { recursive: true }).catch(() => undefined);
}

type IterableDirectory = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };

/** 清理目录中没有对应条目的文件夹（目录暂不可用时删除的条目、浏览器数据被清除后留下的文件）；返回删除的条目文件夹数。 */
export async function sweepDirectory(): Promise<number> {
  const root = await directoryRoot();
  if (!root) return 0;
  const known = new Set((await listEntries()).filter(entry => entry.store === "dir").map(entry => entry.key.split("/").map(segment).join("/")));
  let removed = 0;
  for await (const [ns, nsHandle] of (root as IterableDirectory).entries()) {
    if (nsHandle.kind !== "directory") continue;
    for await (const [tier, tierHandle] of (nsHandle as IterableDirectory).entries()) {
      if (tierHandle.kind !== "directory") continue;
      for await (const [id] of (tierHandle as IterableDirectory).entries()) {
        if (known.has(`${ns}/${tier}/${id}`)) continue;
        await (tierHandle as FileSystemDirectoryHandle).removeEntry(id, { recursive: true }).catch(() => undefined);
        removed++;
      }
    }
  }
  return removed;
}

/* ---------- 设备设置 ---------- */

/** Safari／iOS 上 Service Worker 回应 <video> 的分段请求兼容性不稳定，默认不缓存视频，用户可以自行开启。 */
export const webkitOnly = (agent: string) => /AppleWebKit/.test(agent) && !/Chrome|Chromium|Edg|Android|CriOS|FxiOS|Firefox/.test(agent);

export function defaultSettings(agent: string): DeviceSettings {
  return { enabled: true, maxMiB: 10240, video: !webkitOnly(agent), private: false, privateMaxMiB: 2048 };
}

export async function readSettings(agent: string): Promise<DeviceSettings> {
  const stored = await getMeta<Partial<DeviceSettings>>("settings").catch(() => undefined);
  return { ...defaultSettings(agent), ...(stored ?? {}) };
}

export async function deviceId(): Promise<string> {
  const stored = await getMeta<string>("device");
  if (stored) return stored;
  const id = b64u(crypto.getRandomValues(new Uint8Array(24)));
  await setMeta("device", id);
  return id;
}

/* ---------- 加密 ---------- */

const encoder = new TextEncoder();
const text = (value: string): Bytes => encoder.encode(value) as Bytes;

export function b64u(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(value: string): Bytes {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function hkdf(material: Bytes, info: string): Promise<Bytes> {
  const base = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: text(info) }, base, 256));
}

export async function hmac(material: Bytes, message: string): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, text(message)));
}

/** 只用于加解密、不可导出的 AES-GCM 密钥。 */
export const aesKey = (material: Bytes) => crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);

export async function seal(key: CryptoKey, data: Uint8Array, aad: string): Promise<ArrayBuffer> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: text(aad) }, key, data as Bytes));
  const out = new Uint8Array(12 + body.length);
  out.set(nonce); out.set(body, 12);
  return out.buffer;
}

export async function open(key: CryptoKey, sealed: ArrayBuffer, aad: string): Promise<Bytes> {
  if (sealed.byteLength < 28) throw new Error("缓存数据已损坏");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(sealed, 0, 12), additionalData: text(aad) },
    key, new Uint8Array(sealed, 12)));
}

export const blockAad = (entry: Pick<EntryRecord, "ns" | "tier" | "id">, index: number) => `tessera-block|${entry.ns}|${entry.tier}|${entry.id}|${index}`;
export const infoAad = (entry: Pick<EntryRecord, "ns" | "tier" | "id">) => `tessera-info|${entry.ns}|${entry.tier}|${entry.id}`;

export async function sealInfo(key: CryptoKey, entry: EntryRecord, info: EntryInfo) {
  return seal(key, text(JSON.stringify(info)), infoAad(entry));
}

export async function openInfo(key: CryptoKey, entry: EntryRecord): Promise<EntryInfo | null> {
  if (!entry.info) return null;
  try { return JSON.parse(new TextDecoder().decode(await open(key, entry.info, infoAad(entry)))) as EntryInfo; }
  catch { return null; }
}

/* ---------- 分段 ---------- */

/** 只支持单个区间（浏览器播放媒体只会发这种）；多区间或格式错误返回 undefined，由调用方直接回源。 */
export function parseRange(header: string | null): { start: number; end: number | null } | null | undefined {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) return { start: -Number(match[2]), end: null };
  return { start: Number(match[1]), end: match[2] ? Number(match[2]) : null };
}

/** 把请求区间换算成文件内的闭区间；越界返回 null（416）。 */
export function resolveRange(range: { start: number; end: number | null } | null, size: number): { start: number; end: number } | null {
  if (!range) return size > 0 ? { start: 0, end: size - 1 } : { start: 0, end: -1 };
  if (range.start < 0) return size > 0 ? { start: Math.max(0, size + range.start), end: size - 1 } : null;
  if (range.start >= size) return null;
  return { start: range.start, end: Math.min(size - 1, range.end ?? size - 1) };
}

/** 从 index 起连续缺失的块一直到哪个块为止（不含已缓存的下一块），用来决定一次回源的范围。 */
export function missingRun(blocks: number[], index: number, last: number): number {
  const next = blocks.find(block => block > index);
  return next === undefined ? last : Math.min(last, next - 1);
}

export function kindOf(type: string, destination: string): Kind {
  const mime = type.split(";", 1)[0].trim().toLowerCase();
  if (mime.startsWith("image/") || destination === "image") return "image";
  if (mime.startsWith("video/") || destination === "video") return "video";
  if (mime.startsWith("audio/") || destination === "audio") return "audio";
  return "other";
}
