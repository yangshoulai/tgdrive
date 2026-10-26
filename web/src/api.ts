import type { AuthenticationOptions, PasskeyChallenge, RegistrationOptions } from "./passkeys";

export type Role = "admin" | "user";
export type SiteConfig = { public_base_url: string | null; s3_endpoint: string | null };
/** 账号资料：username 是登录邮箱（旧账号可能仍是用户名，needs_email 为 true）；display_name 优先昵称。 */
export type Profile = { nickname?: string | null; display_name?: string; avatar_version?: number | null; needs_email?: boolean };
export type Session = Profile & { csrf_token: string; expires_at: number; username: string; role: Role; bucket_id?: number | null; unlocked?: boolean; remember?: boolean } & Partial<SiteConfig>;
export type FileItem = {
  key: string;
  size: number;
  etag: string;
  content_type: string | null;
  modified_at: number;
  public_token?: string | null;
  public_at?: number | null;
  public_expires_at?: number | null;
  public_has_password?: boolean;
  public_downloads?: number;
  has_thumbnail?: boolean;
  /** 缩略图状态："thumb"、"grid"、"poster"，或 "none"（已尝试但无法生成）。 */
  thumbnails?: string[];
  /** 各规格保存时的独立版本，用于浏览器缓存失效。 */
  thumbnail_versions?: Partial<Record<ThumbnailVariant, string>>;
};
export type PreviewAsset = { path: string; name: string; kind: "lyrics" | "subtitle"; language: string | null; size: number; etag: string };
export type PreviewListPage = { objects: FileItem[]; next_cursor: string | null };
/** public_folders：这一页里已公开的文件夹（键是文件夹路径，以 / 结尾）。 */
export type ListPage = { objects: FileItem[]; common_prefixes: string[]; next_cursor: string | null; public_folders?: Record<string, FileItem>; folder_sizes?: Record<string, number>;
  /** 目录内最近修改时间（含子目录），空目录取目录本身的时间 */
  folder_modified?: Record<string, number | null>;
  /** 网格视图的文件夹封面：每个文件夹最多四张已有缩略图的文件 */
  folder_previews?: Record<string, FileItem[]> };
export type Account = Profile & { id: number; username: string; role: Role; status: "active" | "disabled"; bucket_id: number | null; created_at: number; last_login_at: number | null; quota_bytes: number | null; used_bytes: number };
export type ClientKey = { access_key_id: string; status: "active" | "disabled"; created_at: number; last_used_at: number | null };
export type ClientGrant = { bucket_id: number; bucket_name: string; prefix: string; perms: "ro" | "rw"; path_hidden?: boolean };
export type AdminClient = { id: number; name: string; description: string | null; owner_user_id: number | null; owner_username?: string | null; status: "active" | "disabled"; created_at: number; keys: ClientKey[]; grants: ClientGrant[] };
export type BotRuntime = { failures: number; cooldown_seconds: number; last_sent_at: number; state: "enabled" | "draining" | "disabled" } | null;
export type BotConfig = { id: number; name: string; channel_id: string; status: "active" | "disabled"; created_at: number; last_check_at: number | null; last_check_status: string | null; runtime?: BotRuntime; chunk_count?: number; stored_bytes?: number };
/** 当前登录账号：管理员和普通用户共用同一个会话接口，角色决定能看到哪些功能。 */
export type UserMe = Profile & { id: number; username: string; role: Role; bucket_id: number | null; quota_bytes: number | null; used_bytes: number; unlocked: boolean; remember?: boolean; csrf_token: string; expires_at: number } & SiteConfig;
export type SettingValue = { value: string | null; default: string | null; effective: string | null };
export type SystemSettings = { public_base_url: SettingValue; s3_endpoint: SettingValue };
export type RegistrationConfig = { enabled: boolean; available: boolean; email_enabled: boolean; invite_enabled: boolean; default_quota_bytes: number | null; code_ttl: number; resend_delay: number };
export type SmtpConfig = { host: string; port: number; security: "ssl" | "starttls"; username: string; sender: string; sender_name: string };
export type RegistrationSettings = Pick<RegistrationConfig, "enabled" | "email_enabled" | "invite_enabled" | "default_quota_bytes"> & { smtp: SmtpConfig & { has_password: boolean } };
export type RegistrationUpdate = Omit<RegistrationSettings, "smtp"> & { smtp: SmtpConfig; smtp_password?: string; clear_smtp_password?: boolean };
export type Invitation = { id: number; code: string; status: "active" | "used" | "expired" | "revoked"; quota_bytes: number | null; expires_at: number; created_at: number; used_at?: number | null };
export type InvitationPage = { invites: Invitation[]; total: number; next_cursor: number | null };
export type ResourceConfig = { mode: "auto" | "low" | "custom"; concurrency: number; bandwidth_kib: number; reserve_mib: number; hls_enabled: boolean; x_enabled: boolean; youtube_enabled: boolean; youtube_max_height: number; platform_max_mib: number; proxy: string; transfer_concurrency: number; bucket_concurrency: number; upload_concurrency: number; upload_kib: number; bot_interval_ms: number; web_part_concurrency: number; web_file_concurrency: number };
export type ResourceSettings = { config: ResourceConfig; source: "admin" | "startup"; pressure: string | null;
  components: { versions: Record<string, string | null>; ytdlp_age_days: number | null };
  /** 生效档位：自动模式按检测到的 CPU 与内存选择 low 或 standard。 */
  effective: Omit<ResourceConfig, "mode"> & { mode: "low" | "standard" | "custom"; ffmpeg_concurrency: number; streaming: boolean; cache_mib: number; hls_available: boolean; x_available: boolean; youtube_available: boolean; reduced: boolean; transfer_reduced: boolean; upload_reduced: boolean };
  detected: { cpu_cores: number; memory_bytes: number | null; container_limits: boolean; disk_total_bytes: number | null; disk_free_bytes: number | null } };
export type DownloadCandidate = { ticket: string; group: string; name: string; source_host: string; method: "GET" | "POST"; kind: "http" | "hls"; platform?: "x" | "youtube"; media_type?: "image" | "video" | "audio"; content_type?: string | null; size: number | null; variant: string | null; warnings: string[]; header_names: string[]; body_bytes: number };
export type DownloadStatus = "queued" | "running" | "stopped" | "interrupted" | "completed" | "failed";
export type DownloadTask = { id: number; key: string; private: boolean; source_host: string; method: "GET" | "POST"; kind: "http" | "hls"; platform: "x" | "youtube" | null; phase: "resolving" | "downloading" | "merging" | "saving" | null; status: DownloadStatus; size: number | null; received: number; stored_bytes: number; segments_done: number; segments_total: number; duration: number | null; processed_seconds: number; elapsed_seconds: number; error: string | null; created_at: number; updated_at: number; speed: number; eta_seconds: number | null;
  /** 成品已移入回收站或之后被清除；key 仍为删除前的位置，不暴露内部存储地址。 */
  trashed?: boolean;
  /** 来源地址：直链去掉查询串（has_query 表示有被省略的参数，完整地址经 downloadSource 读取）；私密空间锁定时为 null。 */
  source?: { url: string; has_query: boolean } | null;
  /** 已完成且文件仍在原位置时的文件信息与缩略图状态；文件已删除时为 null。 */
  file?: DownloadFile | null };
export type DownloadFile = Pick<FileItem, "key" | "size" | "etag" | "content_type" | "thumbnails" | "thumbnail_versions">;
export type DownloadSource = { input: string; download_type: "http" | "hls" | "x" | "youtube"; cookies: string; url: string };
export type DownloadPage = { tasks: DownloadTask[]; total: number; next_cursor: number | null; capabilities: { hls: boolean; x: boolean; youtube: boolean; concurrency: number; pressure: string | null } };
export type TrafficPoint = { at: number; in_bytes: number; out_bytes: number };
export type TrafficMetrics = { total_in_bytes: number; total_out_bytes: number; recent: TrafficPoint[] };
export type SystemStatus = { initialized: boolean; unlocked: boolean; user_count: number; traffic?: TrafficMetrics };
/** 公开分享页展示的分享者：只有设置了昵称才返回，不含邮箱。 */
export type PublicSharer = { nickname: string; avatar_version: number | null };
export type PublicFile = { kind: "file"; token: string; password_required: false; sharer?: PublicSharer | null; name: string; size: number; content_type: string | null; etag: string; modified_at: number; public_at: number | null; expires_at: number | null; thumbnails?: string[] };
export type PublicFolder = { kind: "folder"; token: string; password_required: false; sharer?: PublicSharer | null; name: string; modified_at: number; public_at: number | null; expires_at: number | null };
export type PublicObject = PublicFile | PublicFolder | { token: string; password_required: true };
export type PublicFolderFile = { name: string; path: string; size: number; content_type: string | null; etag: string; modified_at: number; thumbnails?: string[] };
export type PublicFolderPage = {
  name: string; path: string; next_cursor: string | null;
  folders: { name: string; path: string; size?: number; modified_at?: number | null; previews?: PublicFolderFile[] }[];
  files: PublicFolderFile[];
};
export type CreatedClient = { id: number; access_key_id: string; secret: string };

let csrfToken = "";
let thumbnailBucketId: number | null = null;
let thumbnailSessionEpoch = 0;
export function setCsrf(value: string) { csrfToken = value; }
/** Worker 创建受限缓存任务时复用当前网页会话的 CSRF 校验。 */
export const getCsrf = () => csrfToken;
/** 页面卸载时仍要送达的小请求（fetch keepalive，带 CSRF）；不等待结果。 */
export function postKeepalive(url: string, body: unknown) {
  try {
    void fetch(url, { method: "POST", credentials: "include", keepalive: true, body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) } }).catch(() => undefined);
  } catch { /* 页面正在关闭 */ }
}

export const PRIVATE_PREFIX = ".tgdrive/private/";
let privateAccess = "";
let privateAccessExpires = 0;
export const isPrivatePath = (path: string) => path.startsWith(PRIVATE_PREFIX);
export const privatePathLabel = (path: string) => isPrivatePath(path) ? `私密空间${path.length > PRIVATE_PREFIX.length ? ` / ${path.slice(PRIVATE_PREFIX.length).replace(/\/$/, "")}` : ""}` : path ? `我的文件 / ${path.replace(/\/$/, "")}` : "我的文件";
/** 同步服务端已确认的授权截止时间；锁定时本机缓存立即丢弃私密密钥。 */
export const setPrivateAccess = (access: string, expires = 0) => {
  const until = access ? expires : 0;
  const changed = access !== privateAccess || until !== privateAccessExpires;
  privateAccess = access; privateAccessExpires = until;
  if (changed && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("tessera:private-access", { detail: access }));
};
export const getPrivateAccess = () => privateAccess;
export const getPrivateAccessExpires = () => privateAccessExpires;
const fileApi = (route: string, path = "") => `/api/user/v1${isPrivatePath(path) ? "/private" : ""}${route}`;
const mediaAccess = (url: string, path: string) => isPrivatePath(path) ? `${url}&access=${encodeURIComponent(privateAccess)}` : url;

export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

/**
 * 服务端有些错误只给出英文的内部说明（这些文字也是 S3 与访问密钥接口的约定，不能在服务端改）。
 * 网页显示前换成用户能理解的说法；没有收录、又不含中文的说明，按状态码给出通用提示。
 */
const SERVER_MESSAGES: Record<string, string> = {
  "invalid path": "名称或路径不合法，请换一个名称",
  "reserved path": "这个位置由系统保留，不能使用",
  "path is too long": "路径太长，请缩短文件或文件夹名称",
  "prefix is outside scope": "没有访问这个位置的权限",
  "object key is outside scope prefix": "没有访问这个位置的权限",
  "scope is read-only": "这个位置只能查看，不能修改",
  "user not found": "账号不存在或已被删除",
  "system is locked": "服务正在等待管理员完成启动，请稍后再试",
  "invalid credentials": "邮箱或密码不正确",
  "invalid password": "密码不正确",
  "public link not found": "分享链接不存在或已失效",
  "public link has expired": "分享链接已过期",
  "not a shared folder": "这个链接分享的不是文件夹",
  "shared folder changed": "分享的文件夹已有变化，请刷新页面",
  "trash entry not found": "回收站里找不到这个项目，可能已被还原或清除",
  "upload not found": "上传已过期，请重新上传",
  "thumbnail not found": "缩略图还没有生成",
  "source unavailable": "来源暂时无法访问，请稍后重试",
  "invalid range": "文件读取范围不正确，请刷新页面后重试",
  "the administrator account cannot be disabled": "管理员账号不能禁用",
  "存储桶配额不足": "空间不足，请先清理不需要的文件或联系管理员扩容",
};
function statusMessage(status: number) {
  if (status === 403) return "没有权限执行这个操作";
  if (status === 404) return "要找的内容不存在，可能已被移动或删除";
  if (status === 409) return "内容已经发生变化，请刷新页面后重试";
  if (status === 413) return "内容太大，无法提交";
  if (status === 429) return "操作太频繁，请稍后再试";
  if (status >= 500) return "服务暂时不可用，请稍后重试";
  return `操作没有完成（${status}），请稍后重试`;
}
export function friendlyServerMessage(message: string, status: number, admin = false) {
  const known = SERVER_MESSAGES[message.trim().toLowerCase()];
  if (known) return known;
  // 控制台保留原始说明，方便管理员排查。
  if (admin && message.trim()) return message;
  return /[\u4e00-\u9fff]/.test(message) ? message : statusMessage(status);
}

export function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

/** 会删除、覆盖或移动文件的接口：成功后通知本机缓存尽快对账（docs/client-cache-design.md §4）。 */
const FILE_MUTATIONS = /^\/api\/user\/v1(?:\/private)?\/(?:delete|move|copy|transfer|trash\/purge|trash\/restore|uploads\/[A-Za-z0-9_-]+\/complete|files(?:\/instant)?|assistant\/actions\/[A-Za-z0-9_-]+\/(?:confirm|undo))(?:\?|$)/;

/** 下载响应转成 File：文件名取 Content-Disposition 的 filename*（UTF-8），没有时用 filename。 */
async function responseFile(response: Response) {
  const header = response.headers.get("Content-Disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  let name = /filename="([^"]*)"/i.exec(header)?.[1] ?? "download";
  if (encoded) { try { name = decodeURIComponent(encoded); } catch { /* 保留 filename */ } }
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type });
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 30000, as: "json" | "blob" = "json"): Promise<T> {
  const headers = new Headers(init.headers);
  if (path.startsWith("/api/user/v1/private/") && !headers.has("X-Private-Access")) headers.set("X-Private-Access", privateAccess);
  if (init.body && !headers.has("Content-Type") && !(init.body instanceof Blob)) headers.set("Content-Type", "application/json");
  if (csrfToken && init.method && init.method !== "GET") headers.set("X-CSRF-Token", csrfToken);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  init.signal?.addEventListener("abort", cancel, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal, credentials: "include", headers });
    if (!response.ok) {
      let message = statusMessage(response.status);
      let code = "request_failed";
      try { const body = await response.json(); message = friendlyServerMessage(body.error?.message ?? "", response.status, path.startsWith("/api/admin/")); code = body.error?.code ?? code; } catch { /* 保留状态码对应的提示 */ }
      if (response.status === 401 && path.startsWith("/api/") && !path.endsWith("/login") && !path.startsWith("/api/auth/v1/passkeys/login/")) window.dispatchEvent(new CustomEvent("tgdrive:session-expired"));
      if (code === "private_locked") window.dispatchEvent(new CustomEvent("tessera:private-locked", { detail: headers.get("X-Private-Access") }));
      throw new ApiError(message, response.status, code);
    }
    if (init.method && init.method !== "GET" && FILE_MUTATIONS.test(path)) window.dispatchEvent(new CustomEvent("tessera:files-mutated"));
    if (response.status === 204) return undefined as T;
    return await (as === "blob" ? responseFile(response) : response.json()) as T;
  } catch (reason) {
    if (timedOut) throw new ApiError("请求超时，请稍后重试", 0, "request_timeout");
    if (init.signal?.aborted) throw new ApiError("请求已取消", 0, "request_aborted");
    if (reason instanceof ApiError) throw reason;
    throw new ApiError("无法连接到服务器，请检查网络后重试", 0, "network_error");
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener("abort", cancel);
  }
}

const post = <T>(path: string, body?: unknown, timeoutMs?: number) => request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs);
/** 供独立的接口模块（如 assistant-api.ts）复用同一套错误处理、CSRF 与超时。 */
export const apiGet = <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal });
export const apiPost = post;
/** 下载类 GET：错误仍按 JSON 解析（含 423 private_locked），成功时返回原始内容。 */
export const apiBlob = (path: string, timeoutMs = 120000) => request<File>(path, {}, timeoutMs, "blob");

export type PrivateGrant = { access: string; idle_seconds: number; remaining_seconds?: number };
export type PasskeyCapability = { available: boolean; origin: string | null; rp_id: string | null; reason: string | null; registered: number };
export type PrivateStatus = { configured: boolean; idle_seconds: number; unlocked: boolean; access: string | null; remaining_seconds: number; passkeys: PasskeyCapability };
export type AccountPasskey = { id: number; name: string; rp_id: string; created_at: number; last_used_at: number | null; login_enabled: boolean };
export type AccountPasskeys = { capability: PasskeyCapability; passkeys: AccountPasskey[] };
export const privateStatus = (signal?: AbortSignal) => request<PrivateStatus>("/api/user/v1/private/status", { signal });
export const unlockPrivate = (password: string) => post<PrivateGrant>("/api/user/v1/private/unlock", { password });
export const privateActivity = (active: boolean, playing: boolean) => post<{ remaining_seconds: number; idle_seconds: number }>("/api/user/v1/private/activity", { active, playing });
export const lockPrivate = (access: string, keepalive = false) => request<void>("/api/user/v1/private/lock", { method: "POST", headers: { "X-Private-Access": access }, keepalive });
export async function configurePrivate(idleSeconds: number) {
  const result = await post<{ access: string | null; idle_seconds: number; remaining_seconds?: number }>("/api/user/v1/private/settings", { idle_seconds: idleSeconds });
  window.dispatchEvent(new CustomEvent("tessera:private-policy-changed"));
  return result;
}
export const transferPrivate = (paths: string[], destination: string, into: boolean, conflict: MoveConflict) => post<{ moved: number; skipped: number }>("/api/user/v1/private/transfer", { paths, destination, into, conflict });
export const passkeyStatus = (signal?: AbortSignal) => request<PasskeyCapability>("/api/auth/v1/passkeys/status", { signal });
export const accountPasskeys = (signal?: AbortSignal) => request<AccountPasskeys>("/api/auth/v1/passkeys", { signal });
const passkeyPost = <T>(route: string, body: unknown, signal?: AbortSignal) => request<T>("/api/auth/v1/passkeys/" + route, { method: "POST", body: JSON.stringify(body), signal });
export const beginPasskeyRegistration = (password: string, name: string, signal: AbortSignal) => passkeyPost<PasskeyChallenge<RegistrationOptions>>("register/options", { password, name }, signal);
export const finishPasskeyRegistration = (requestId: string, credential: unknown, signal: AbortSignal) => passkeyPost<{ id: number }>("register/verify", { request_id: requestId, credential }, signal);
export const beginPrivatePasskeyUnlock = (signal: AbortSignal) => request<PasskeyChallenge<AuthenticationOptions>>("/api/user/v1/private/passkeys/unlock/options", { method: "POST", body: "{}", signal });
export const finishPrivatePasskeyUnlock = (requestId: string, credential: unknown, signal: AbortSignal) => request<PrivateGrant>("/api/user/v1/private/passkeys/unlock/verify", { method: "POST", body: JSON.stringify({ request_id: requestId, credential }), signal });
export const renamePasskey = (id: number, password: string, name: string, signal?: AbortSignal) => passkeyPost<{ id: number }>("rename", { id, password, name }, signal);
export const enablePasskeyLogin = (id: number, password: string, signal?: AbortSignal) => passkeyPost<{ id: number }>("enable-login", { id, password }, signal);
export async function deletePasskey(id: number, password: string, signal?: AbortSignal) {
  const result = await passkeyPost<{ id: number }>("delete", { id, password }, signal);
  if (privateAccess) window.dispatchEvent(new CustomEvent("tessera:private-locked", { detail: privateAccess }));
  return result;
}
export const beginPasskeyLogin = (remember: boolean, signal: AbortSignal) => passkeyPost<PasskeyChallenge<AuthenticationOptions>>("login/options", { remember }, signal);
export async function finishPasskeyLogin(requestId: string, credential: unknown, signal: AbortSignal) {
  const session = await passkeyPost<Session>("login/verify", { request_id: requestId, credential }, signal);
  thumbnailBucketId = session.bucket_id ?? null; thumbnailSessionEpoch++; setPrivateAccess(""); setCsrf(session.csrf_token);
  return session;
}

/* ---------- 会话 ---------- */

export const registrationConfig = (signal?: AbortSignal) => request<RegistrationConfig>("/api/auth/v1/registration", { signal });
export const sendRegistrationCode = (email: string) => post<{ sent: boolean; resend_after: number; expires_in: number }>("/api/auth/v1/registration/code", { email }, 45000);
export const registerAccount = (body: { email: string; password: string; method: "email" | "invite"; email_code?: string; invite_code?: string }) => post<{ username: string; quota_bytes: number | null }>("/api/auth/v1/register", body);
export const adminRegistration = () => request<RegistrationSettings>("/api/admin/v1/registration");
export const updateRegistration = (body: RegistrationUpdate) => post<RegistrationSettings>("/api/admin/v1/registration", body);
export const testRegistrationEmail = (email: string) => post<{ sent: boolean }>("/api/admin/v1/registration/test-email", { email }, 45000);
export const adminInvitations = (cursor: string | null, status = "all", limit = 50) => request<InvitationPage>(`/api/admin/v1/registration/invites?cursor=${cursor ?? "0"}&status=${encodeURIComponent(status)}&limit=${limit}`);
export const createInvitations = (body: { count: number; expires_at: number; quota_bytes: number | null }) => post<{ invites: Invitation[] }>("/api/admin/v1/registration/invites", body);
export const revokeInvitation = (id: number) => post<void>(`/api/admin/v1/registration/invites/${id}/revoke`, {});
/** 邀请凭据放在片段中，不进入 HTTP 请求、反向代理日志或 Referer。 */
export const invitationUrl = (code: string) => `${userSiteOrigin()}/register#invite=${encodeURIComponent(code)}`;

/** remember 为 true 时服务端签发 30 天的长期会话（服务重启后仍有效）；否则 12 小时。 */
export async function login(username: string, password: string, remember = false): Promise<Session> {
  thumbnailBucketId = null; thumbnailSessionEpoch++;
  const session = await post<Session>("/api/auth/v1/login", { username, password, remember });
  thumbnailBucketId = session.bucket_id ?? null;
  setPrivateAccess("");
  setCsrf(session.csrf_token);
  return session;
}
export async function logout() {
  try { await post<void>("/api/auth/v1/logout"); }
  finally { setCsrf(""); setPrivateAccess(""); thumbnailBucketId = null; thumbnailSessionEpoch++; window.dispatchEvent(new CustomEvent("tessera:logout")); }
}
/** 浏览器本地缓存：重置纪元后所有设备上的缓存都无法再解开。 */
export const resetClientCache = () => post<{ ok: boolean }>("/api/user/v1/cache/reset", {});
export async function me() {
  const epoch = thumbnailSessionEpoch;
  const account = await request<UserMe>("/api/auth/v1/me");
  // 切换账号后，上一账号迟到的请求不能覆盖新账号的缓存所属桶。
  if (epoch === thumbnailSessionEpoch) thumbnailBucketId = account.bucket_id;
  return account;
}
export async function restoreSession(): Promise<Session> {
  const account = await me();
  setCsrf(account.csrf_token);
  setSiteConfig(account);
  return { nickname: account.nickname, display_name: account.display_name, avatar_version: account.avatar_version, needs_email: account.needs_email,
    csrf_token: account.csrf_token, expires_at: account.expires_at, username: account.username, role: account.role, bucket_id: account.bucket_id, unlocked: account.unlocked, remember: account.remember, public_base_url: account.public_base_url, s3_endpoint: account.s3_endpoint };
}
/** 界面显示的名字：优先昵称，其次邮箱 @ 前的部分（服务端的 display_name 规则相同）。 */
export const displayName = (account: Profile & { username: string }) => account.display_name || account.nickname || account.username.split("@", 1)[0];
export const avatarUrl = (version: number | null | undefined) => version ? `/api/auth/v1/avatar?v=${version}` : undefined;
export const adminAvatarUrl = (userId: number, version: number | null | undefined) => version ? `/api/admin/v1/users/${userId}/avatar?v=${version}` : undefined;
export const updateProfile = (nickname: string) => post<Profile>("/api/auth/v1/profile", { nickname });
export const changeEmail = (email: string, password: string) => post<Profile & { username: string }>("/api/auth/v1/email", { email, password });
export const uploadAvatar = (data: string) => post<Profile>("/api/auth/v1/avatar", { data });
export const deleteAvatar = () => post<Profile>("/api/auth/v1/avatar/delete", {});
/** 与服务端 accounts.EMAIL_PATTERN 一致的邮箱格式检查。 */
export const isEmail = (value: string) => value.length <= 254 && /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(value);
export async function changePassword(oldPassword: string, newPassword: string) {
  await post<void>("/api/auth/v1/password", { old_password: oldPassword, new_password: newPassword });
  if (privateAccess) window.dispatchEvent(new CustomEvent("tessera:private-locked", { detail: privateAccess }));
}

/* ---------- 用户文件 ---------- */

/** 文件类型快速筛选；与服务端 tgdrive/filekinds.py 的 KIND_GROUPS 对应。可多选：值是按 KIND_FILTERS 顺序以逗号连接的类型（"image,video"），空串表示全部。 */
export type KindName = "image" | "video" | "audio" | "document" | "text" | "archive";
export type KindFilter = string;
export const KIND_FILTERS: { value: KindName; label: string }[] = [
  { value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" },
  { value: "document", label: "文档" }, { value: "text", label: "文本" }, { value: "archive", label: "压缩包" },
];
export const kindValues = (filter: KindFilter): KindName[] => KIND_FILTERS.map(item => item.value).filter(value => filter.split(",").includes(value));
/** 切换某个类型的选中状态，结果保持固定顺序，便于比较与作为请求参数。 */
export const toggleKind = (filter: KindFilter, kind: KindName): KindFilter => {
  const values = new Set(kindValues(filter));
  if (values.has(kind)) values.delete(kind); else values.add(kind);
  return KIND_FILTERS.map(item => item.value).filter(value => values.has(value)).join(",");
};
/** 「图片、视频」；用于空状态等提示文案。 */
export const kindFilterLabel = (filter: KindFilter) => kindValues(filter).map(value => KIND_FILTERS.find(item => item.value === value)!.label).join("、") || "文件";
export const listFiles = (prefix = "", cursor: string | null = null, publicOnly = false, limit = 100, kind: KindFilter = "", signal?: AbortSignal) =>
  request<ListPage>(`${fileApi("/list", prefix)}?limit=${limit}&prefix=${encodeURIComponent(prefix)}&public=${publicOnly ? "1" : "0"}${kind ? `&kind=${encodeURIComponent(kind)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal });
export const previewAssets = (path: string, signal?: AbortSignal) => request<PreviewAsset[]>(`${fileApi("/preview-assets", path)}?path=${encodeURIComponent(path)}`, { signal });
export const previewList = (path: string, cursor: string | null, signal: AbortSignal) => request<PreviewListPage>(
  `${fileApi("/preview-list", path)}?path=${encodeURIComponent(path)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal });
export const publicPreviewList = async (token: string, path: string, cursor: string | null, access: string | null, signal: AbortSignal): Promise<PreviewListPage> => {
  const params = new URLSearchParams({ path: path.slice(0, path.lastIndexOf("/") + 1), limit: "200" });
  if (cursor) params.set("cursor", cursor);
  if (access) params.set("access", access);
  const page = await request<PublicFolderPage>(`/api/public/v1/folders/${encodeURIComponent(token)}/list?${params}`, { signal });
  return { objects: page.files.map(file => ({ ...file, key: file.path })), next_cursor: page.next_cursor };
};
export const publicPreviewAssets = (token: string, path: string, access?: string | null, signal?: AbortSignal) => {
  const params = new URLSearchParams({ path });
  if (access) params.set("access", access);
  return request<PreviewAsset[]>(`/api/public/v1/folders/${encodeURIComponent(token)}/preview-assets?${params}`, { signal });
};
export const searchFiles = (query: string, cursor = "", publicOnly = false, limit = 100, root = "", kind: KindFilter = "", signal?: AbortSignal) =>
  request<ListPage>(`${fileApi("/search", root)}?limit=${limit}&q=${encodeURIComponent(query)}&cursor=${encodeURIComponent(cursor)}&public=${publicOnly ? "1" : "0"}${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`, { signal });
/** 目录统计（含子文件夹）：数量、总大小、按类型分组（与 KIND_FILTERS 同组，另有 other）、最大的文件。 */
export type FolderStats = { prefix: string; files: number; folders: number; bytes: number; direct_files: number; direct_folders: number;
  kinds: { kind: KindName | "other"; count: number; bytes: number }[]; largest: { key: string; size: number; content_type: string | null }[]; latest_modified: number | null };
export const folderStats = (prefix: string, signal?: AbortSignal) => request<FolderStats>(`${fileApi("/stats", prefix)}?prefix=${encodeURIComponent(prefix)}`, { signal });
export const listFolders = (prefix: string, cursor: string | null = null, signal?: AbortSignal) => request<{ folders: string[]; next_cursor: string | null }>(
  `${fileApi("/folders", prefix)}?limit=50&prefix=${encodeURIComponent(prefix)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal });
export const checkFiles = (paths: string[]) => post<{ paths: string[] }>(fileApi("/files/check", paths[0]), { paths });
export const makeFolder = (path: string) => post<FileItem>(fileApi("/folders", path), { path });
/** recursive 为 true 时，以 / 结尾的文件夹路径会在服务端连同其中所有内容一起删除。 */
export const deleteFiles = (paths: string[], recursive = false) => post<{ results: { path: string; deleted: boolean; count?: number }[] }>(fileApi("/delete", paths[0]), { paths, recursive });
/** 移动冲突策略：rename 保留两者（自动编号），skip 跳过同名文件，overwrite 覆盖目标。 */
export type MoveConflict = "rename" | "skip" | "overwrite";
/** 他人的分享：own 表示是否为当前账号自己的分享（是则不显示保存按钮）。 */
export const shareStatus = (token: string) => request<{ own: boolean }>(`/api/user/v1/shares/${encodeURIComponent(token)}/status`);
/** 把分享保存到自己的文件：引用同一份加密数据，立即完成并计入自己的容量；paths 为分享文件夹内的相对路径，省略时保存整个分享。 */
export const saveShare = (token: string, destination: string, access: string | null, paths?: string[]) =>
  post<{ saved: number; bytes: number; items: string[] }>(`/api/user/v1/shares/${encodeURIComponent(token)}/save`, { destination, access, ...(paths ? { paths } : {}) });
export const moveFile = (from: string, to: string, conflict: MoveConflict = "skip") => post<{ moved: number; skipped: number }>(fileApi("/move", from), { from, to, conflict });
export const copyFile = (from: string, to: string) => post<FileItem>(fileApi("/copy", from), { from, to });
export type ShareOptions = { expires_at?: number | null; password?: string | null };
export const setPublic = (paths: string[], isPublic: boolean, options: ShareOptions = {}) => post<{ objects: FileItem[] }>("/api/user/v1/public", { paths, public: isPublic, ...options });

/* ---------- 回收站 ---------- */
export type TrashItem = { id: string; path: string; is_folder: boolean; size: number; item_count: number; deleted_at: number; purge_at: number };
export const listTrash = () => request<{ items: TrashItem[]; total_size: number; retention_days: number }>("/api/user/v1/trash");
export const listTrashPage = (cursor: string | null, limit = 100, root = "", signal?: AbortSignal) => request<{ items: TrashItem[]; total: number; total_size: number; retention_days: number; next_cursor: string | null }>(
  `${fileApi("/trash", root)}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal });
export const moveToTrash = (paths: string[]) => post<{ items: { id: string; path: string }[] }>(fileApi("/trash", paths[0]), { paths });
export const restoreTrash = (ids: string[], root = "") => post<{ restored: { id: string; path: string }[] }>(fileApi("/trash/restore", root), { ids });
export const purgeTrash = (ids: string[] | "all", root = "") => post<{ purged: number }>(fileApi("/trash/purge", root), ids === "all" ? { all: true } : { ids });

/* ---------- 缩略图 ---------- */
export type ThumbnailVariant = "thumb" | "grid" | "poster";
/** 所需规格缺失时依次退回（与服务端 THUMBNAIL_FALLBACK 一致）：网格图与封面互为替代，最后用小图。 */
const THUMBNAIL_FALLBACK: Record<ThumbnailVariant, ThumbnailVariant[]> = { thumb: ["thumb"], grid: ["grid", "poster", "thumb"], poster: ["poster", "grid", "thumb"] };
/** 缩略图地址只由路径、规格与内容版本组成（私密空间也不带解锁令牌，服务端按登录会话的私密授权校验），
 * 浏览器据此长期缓存；删除、覆盖或重新生成后版本变化，地址随之变化。 */
/** 缩略图地址按内容版本（ETag）标识，不含路径：文件移动或改名后浏览器缓存仍然有效；路径只用来区分私密空间接口。 */
export const thumbnailUrl = (path: string, etag: string, version: string, variant: ThumbnailVariant = "thumb") =>
  `${fileApi("/thumbnail", path)}?etag=${encodeURIComponent(etag)}&variant=${variant}&v=${encodeURIComponent(version)}${thumbnailBucketId !== null ? `&bucket_id=${thumbnailBucketId}` : ""}`;
export type ThumbnailClaim = { etag?: string; ticket?: string };
export const setThumbnail = (path: string, data: string, variant: ThumbnailVariant = "thumb", claim: ThumbnailClaim = {}) => post<void>(fileApi("/thumbnail", path), { path, data, variant, ...claim });
export const markNoThumbnail = (path: string, claim: ThumbnailClaim = {}) => post<void>(fileApi("/thumbnail", path), { path, variant: "none", ...claim });
export const claimThumbnail = (file: Pick<FileItem, "key" | "etag">, force = false) => post<{ token: string | null; expires_in?: number }>(fileApi("/thumbnail/claim", file.key), { path: file.key, etag: file.etag, force });
export const releaseThumbnail = (file: Pick<FileItem, "key" | "etag">, ticket: string, variants?: string[]) => post<void>(fileApi("/thumbnail/release", file.key), { path: file.key, etag: file.etag, ticket, ...(variants ? { variants } : {}) });
export type ThumbnailState = Pick<FileItem, "etag" | "size" | "modified_at" | "has_thumbnail" | "thumbnails" | "thumbnail_versions">;
/** 只查询所列文件的 ETag 与缩略图状态（最多 200 个）；不存在或无权访问的路径不在结果中。 */
export const thumbnailStatus = (paths: string[], signal?: AbortSignal) => request<{ files: Record<string, ThumbnailState> }>(fileApi("/thumbnail/status", paths[0]),
  { method: "POST", body: JSON.stringify({ paths }), signal });
/** 网页上传并发：由管理员在「下载与资源」配置。 */
export const uploadConfig = () => request<{ part_concurrency: number; file_concurrency: number }>("/api/user/v1/upload-config");
export const generateThumbnail = (file: Pick<FileItem, "key" | "etag">) => post<{ accepted: boolean }>(fileApi("/thumbnail/generate", file.key), { path: file.key, etag: file.etag });
export type ThumbnailCandidates = { id: string; state: "queued" | "running" | "ready" | "failed" | "saving"; detail: string; count: number; expires_in: number; frames: { index: number; seconds: number }[] };
export const createThumbnailCandidates = (file: Pick<FileItem, "key" | "etag">) => post<ThumbnailCandidates>(fileApi("/thumbnail/candidates", file.key), { path: file.key, etag: file.etag });
export const thumbnailCandidates = (file: Pick<FileItem, "key" | "etag">, id: string, signal?: AbortSignal) => request<ThumbnailCandidates>(fileApi("/thumbnail/candidates/status", file.key), { method: "POST", body: JSON.stringify({ path: file.key, etag: file.etag, id }), signal });
export const thumbnailCandidateImage = (file: Pick<FileItem, "key" | "etag">, id: string, index: number, signal?: AbortSignal) => request<File>(`${fileApi("/thumbnail/candidate", file.key)}?path=${encodeURIComponent(file.key)}&etag=${encodeURIComponent(file.etag)}&id=${encodeURIComponent(id)}&index=${index}`, { signal, cache: "no-store" }, 30000, "blob");
export const cancelThumbnailCandidates = (file: Pick<FileItem, "key" | "etag">, id: string) => request<void>(fileApi("/thumbnail/candidates/cancel", file.key), { method: "POST", body: JSON.stringify({ path: file.key, etag: file.etag, id }), keepalive: true });
export const selectThumbnailCandidate = (file: Pick<FileItem, "key" | "etag">, id: string, index: number) => post<void>(fileApi("/thumbnail/candidates/select", file.key), { path: file.key, etag: file.etag, id, index }, 60000);
type ThumbnailFile = Pick<FileItem, "key" | "etag" | "thumbnails" | "has_thumbnail" | "thumbnail_versions">;
function thumbnailSpec(file: ThumbnailFile, variant: ThumbnailVariant) {
  const resolved = THUMBNAIL_FALLBACK[variant].find(item => item === "thumb" || file.thumbnails?.includes(item)) ?? "thumb";
  const revision = file.thumbnail_versions?.[resolved];
  return { variant: resolved, version: `${file.etag}.${resolved}${revision ? `.${revision}` : ""}` };
}
/** 返回所需规格的缩略图地址；网格图或封面尚未生成时按退回顺序复用已有的规格。 */
export function fileThumbnail(file: ThumbnailFile, variant: ThumbnailVariant = "thumb") {
  if (!file.thumbnails?.includes("thumb") && !file.has_thumbnail) return undefined;
  // 小图地址不受 poster 的生成或状态顺序影响，目录四宫格、文件列表和预览头部共用缓存。
  const spec = thumbnailSpec(file, variant);
  return thumbnailUrl(file.key, file.etag, spec.version, spec.variant);
}
/** 公开分享里文件的缩略图：在 /p/ 地址上加 thumbnail 参数，沿用分享的权限。 */
export const publicThumbnail = (contentUrl: string, variant: ThumbnailVariant = "thumb") =>
  `${contentUrl}${contentUrl.includes("?") ? "&" : "?"}thumbnail=${variant}`;
export const publicFolderDownload = (token: string) => `/api/public/v1/folders/${encodeURIComponent(token)}/download`;
/** 内容地址绑定版本；本机缓存用同版本的原始大小校验条目，避免把缺失的响应长度当成空文件。 */
export function versionedContentUrl(url: string, etag: string, size?: number, preview = false) {
  if (!etag) return url;
  const [path, query = ""] = url.split("?");
  const params = new URLSearchParams(query); params.set("v", etag);
  if (path === "/api/user/v1/content" && thumbnailBucketId !== null) params.set("bucket_id", String(thumbnailBucketId));
  if (/^\/api\/user\/v1\/(?:private\/)?content$/.test(path)) {
    if (size !== undefined && Number.isSafeInteger(size) && size >= 0) params.set("size", String(size));
    if (preview) params.set("preview", "1");
  }
  return `${path}?${params}`;
}

/* ---------- 可续传的分段上传 ---------- */
export type UploadState = { upload_id: string; path: string; completed: boolean; parts: { part_no: number; size: number; etag: string }[] };
export type InstantResult = ({ hit: true } & FileItem) | { hit: false };
/** 秒传：存储桶里已有内容相同的文件时直接引用；未命中返回 { hit: false }，调用方再走普通上传。 */
export const instantUpload = (path: string, size: number, fingerprint: string, contentType: string, isPublic?: boolean) =>
  post<InstantResult>(fileApi("/files/instant", path), { path, size, fingerprint, content_type: contentType || undefined, ...(isPublic === undefined ? {} : { public: isPublic }) });
export const createUpload = (path: string, contentType: string) => post<{ upload_id: string; part_size: number }>(fileApi("/uploads", path), { path, content_type: contentType });
export const getUpload = (id: string, path = "") => request<UploadState>(fileApi(`/uploads/${id}`, path));
export const completeUpload = (id: string, parts: [number, string][], isPublic?: boolean, path = "") => post<FileItem>(fileApi(`/uploads/${id}/complete`, path), { parts, ...(isPublic === undefined ? {} : { public: isPublic }) }, 15 * 60000);
export const abortUpload = (id: string, path = "") => request<void>(fileApi(`/uploads/${id}`, path), { method: "DELETE" });
export const listPublic = () => request<FileItem[]>("/api/user/v1/public");
export const listPublicPage = (cursor: string | null = null, limit = 100, signal?: AbortSignal) => request<{ objects: FileItem[]; total: number; next_cursor: string | null; folder_sizes?: Record<string, number>; folder_previews?: Record<string, FileItem[]> }>(
  `/api/user/v1/public?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal });
/** 打包下载所选文件与文件夹（递归）；文件夹路径以 / 结尾。 */
export const archiveUrl = (paths: string[]) => mediaAccess(`${fileApi("/archive", paths[0] ?? "")}?${paths.map(path => `path=${encodeURIComponent(path)}`).join("&")}`, paths[0] ?? "");
export const contentUrl = (path: string, download = false) => mediaAccess(`${fileApi("/content", path)}?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`, path);

export type UploadProgress = { loaded: number; total: number; percent: number };
/** 用 XHR 上传一个请求体以获得进度；文件体直接流向服务端，不在前端复制。返回的 abort 可取消该请求。 */
function xhrPut<T>(url: string, body: Blob, contentType: string, onProgress: (progress: UploadProgress) => void): { promise: Promise<T>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const access = url.startsWith("/api/user/v1/private/") ? privateAccess : "";
  let timer: number | undefined;
  let timedOut = false;
  const touch = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { timedOut = true; xhr.abort(); }, 5 * 60000); };
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open("PUT", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", contentType);
    if (csrfToken) xhr.setRequestHeader("X-CSRF-Token", csrfToken);
    if (access) xhr.setRequestHeader("X-Private-Access", access);
    xhr.onprogress = touch;
    xhr.upload.onprogress = event => {
      touch();
      const total = event.lengthComputable ? event.total : body.size;
      onProgress({ loaded: event.loaded, total, percent: total ? Math.min(100, event.loaded / total * 100) : 0 });
    };
    xhr.onerror = () => reject(new ApiError("网络连接中断，请重试", 0, "network_error"));
    xhr.onabort = () => reject(new ApiError(timedOut ? "上传长时间无响应，请重试" : "已取消上传", 0, timedOut ? "request_timeout" : "upload_aborted"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress({ loaded: body.size, total: body.size, percent: 100 });
        try { resolve(JSON.parse(xhr.responseText) as T); } catch { reject(new ApiError("上传结果无法识别，请刷新页面确认文件是否已保存", xhr.status, "invalid_response")); }
        return;
      }
      let message = `上传失败（${xhr.status}）`; let code = "upload_failed";
      try { const parsed = JSON.parse(xhr.responseText); message = parsed.error?.message ? friendlyServerMessage(parsed.error.message, xhr.status) : message; code = parsed.error?.code ?? code; } catch { /* 保留状态码 */ }
      if (xhr.status === 401) window.dispatchEvent(new CustomEvent("tgdrive:session-expired"));
      if (code === "private_locked") window.dispatchEvent(new CustomEvent("tessera:private-locked", { detail: access }));
      reject(new ApiError(message, xhr.status, code));
    };
    touch();
    xhr.send(body);
  });
  return { promise: promise.finally(() => window.clearTimeout(timer)), abort: () => xhr.abort() };
}

export function uploadFileWithProgress(path: string, file: File, options: { isPublic?: boolean; onProgress: (progress: UploadProgress) => void }): { promise: Promise<FileItem>; abort: () => void } {
  const publicParam = options.isPublic === undefined ? "" : `&public=${options.isPublic ? "1" : "0"}`;
  return xhrPut<FileItem>(`${fileApi("/files", path)}?path=${encodeURIComponent(path)}${publicParam}`, file, file.type || "application/octet-stream", options.onProgress);
}

/** 文件助手对话附件：保存在系统区，不出现在我的文件（docs/assistant-design.md §22.5）。 */
export type AssistantAttachment = { id: string; name: string; size: number; content_type: string | null; image: boolean; conversation_id?: string | null };
export function uploadAttachmentWithProgress(file: File, name: string, onProgress: (progress: UploadProgress) => void) {
  return xhrPut<AssistantAttachment>(`/api/user/v1/assistant/attachments?name=${encodeURIComponent(name)}`, file, file.type || "application/octet-stream", onProgress);
}

export function uploadPartWithProgress(uploadId: string, partNo: number, blob: Blob, onProgress: (progress: UploadProgress) => void, path = "") {
  return xhrPut<{ part_no: number; size: number; etag: string }>(fileApi(`/uploads/${uploadId}/parts/${partNo}`, path), blob, "application/octet-stream", onProgress);
}

/** 已用空间分项：我的文件、回收站、私密空间、助手附件与缩略图（网格图和预览封面；列表小图不计入）。 */
export type StorageUsage = { total: number; quota_bytes: number | null; files: number; trash: number; private: number; assistant: number; thumbnails?: number };
export const storageUsage = () => request<StorageUsage>("/api/user/v1/usage");

/* ---------- 用户客户端密钥 ---------- */

export const userClients = () => request<AdminClient[]>("/api/user/v1/clients");
export type ClientPage = { clients: AdminClient[]; total: number; next_cursor: number | null };
export const userClientsPage = (cursor: string | null) => request<ClientPage>(`/api/user/v1/clients?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
export const createUserClient = (name: string) => post<CreatedClient>("/api/user/v1/clients", { name });
export const disableUserKey = (accessKeyId: string) => post<void>("/api/user/v1/client-keys/disable", { access_key_id: accessKeyId });
/** 永久删除：立即失效，无法恢复。 */
export const deleteUserKey = (accessKeyId: string) => post<void>("/api/user/v1/client-keys/delete", { access_key_id: accessKeyId });

/* ---------- 公开分享 ---------- */

export async function loadPublicConfig() {
  const config = await request<SiteConfig>("/api/public/v1/config");
  setSiteConfig(config);
  return config;
}
export const publicSharerAvatar = (token: string, sharer: PublicSharer, access?: string | null) => sharer.avatar_version
  ? `/api/public/v1/objects/${encodeURIComponent(token)}/avatar?v=${sharer.avatar_version}${access ? `&access=${encodeURIComponent(access)}` : ""}` : undefined;
export const publicObject = (token: string, access?: string | null) => request<PublicObject>(`/api/public/v1/objects/${encodeURIComponent(token)}${access ? `?access=${encodeURIComponent(access)}` : ""}`);
export const publicFolderList = (token: string, path = "", cursor: string | null = null, access?: string | null, limit = 100, kind: KindFilter = "", signal?: AbortSignal) => {
  const params = new URLSearchParams({ path, limit: String(limit) });
  if (kind) params.set("kind", kind);
  if (cursor) params.set("cursor", cursor);
  if (access) params.set("access", access);
  return request<PublicFolderPage>(`/api/public/v1/folders/${encodeURIComponent(token)}/list?${params}`, { signal });
};
/** 分享文件夹中某个文件的地址：/p/<令牌>/<相对路径>。 */
export const publicFolderFile = (token: string, path: string, download = false, access?: string | null) => {
  const params = new URLSearchParams();
  if (download) params.set("download", "1");
  if (access) params.set("access", access);
  const query = params.toString();
  return `/p/${encodeURIComponent(token)}/${path.split("/").map(encodeURIComponent).join("/")}${query ? `?${query}` : ""}`;
};
export const unlockShare = (token: string, password: string) => post<{ access: string; expires_at: number }>(`/api/public/v1/objects/${encodeURIComponent(token)}/unlock`, { password });
export const publicPath = (token: string, name: string, download = false, access?: string | null) => {
  const params = new URLSearchParams();
  if (download) params.set("download", "1");
  if (access) params.set("access", access);
  const query = params.toString();
  return `/p/${encodeURIComponent(token)}/${encodeURIComponent(name)}${query ? `?${query}` : ""}`;
};

/* ---------- 管理端 ---------- */

export const adminSettings = (signal?: AbortSignal) => request<SystemSettings>("/api/admin/v1/settings", { signal });
export const adminResources = () => request<ResourceSettings>("/api/admin/v1/resources");
export const updateAdminResources = (values: ResourceConfig) => post<ResourceSettings>("/api/admin/v1/resources", values);
/** 浏览器本地缓存策略（docs/client-cache-design.md §5）。 */
export type ClientCachePolicy = { enabled: boolean; private_enabled: boolean; private_ttl_days: number };
export const adminClientCache = () => request<ClientCachePolicy>("/api/admin/v1/client-cache");
export const updateAdminClientCache = (values: Partial<ClientCachePolicy>) => post<ClientCachePolicy>("/api/admin/v1/client-cache", values);
/** ids：只读取这些任务（最多 100 个，托盘跟踪用）；limit 为每页数量（最多 100）。 */
export async function listDownloads(cursor: string | null, status: string, signal?: AbortSignal, query = "", options: { ids?: number[]; limit?: number } = {}) {
  const params = new URLSearchParams({ limit: String(options.limit ?? 50), cursor: cursor ?? "", status });
  if (query) params.set("q", query);
  if (options.ids) params.set("ids", options.ids.join(","));
  const suffix = `?${params}`;
  if (privateAccess) {
    try { return await request<DownloadPage>(`/api/user/v1/private/downloads${suffix}`, { signal }); }
    catch (reason) { if (!(reason instanceof ApiError) || reason.code !== "private_locked") throw reason; }
  }
  return request<DownloadPage>(`/api/user/v1/downloads${suffix}`, { signal });
}
export const parseDownloads = (input: string, signal?: AbortSignal, download_type: "auto" | "http" | "hls" | "x" | "youtube" = "auto", cookies = "") => request<{ candidates: DownloadCandidate[] }>("/api/user/v1/downloads/parse", { method: "POST", body: JSON.stringify({ input, download_type, cookies }), signal }, 180000);
/**
 * 资源抓取脚本转交的解析结果：地址 #import=<base64url(JSON)>。片段不会发给服务器；票据加密、绑定账号且 20 分钟过期。
 * 读取后立即从地址栏和历史记录中移除。
 */
export const MAX_DOWNLOAD_ITEMS = 1000;
export type DownloadImport = { candidates: DownloadCandidate[]; private: boolean; destination: string; error?: string };
export function takeDownloadImport(): DownloadImport | null {
  const match = /^#import=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  try {
    const bytes = Uint8Array.from(atob(match[1].replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { candidates?: Partial<DownloadCandidate>[]; private?: unknown; destination?: unknown };
    // 脚本可能只带部分展示字段，缺省值与普通解析结果一致。
    const candidates: DownloadCandidate[] = Array.isArray(value.candidates) ? value.candidates.filter(item => item && typeof item.ticket === "string" && typeof item.name === "string")
      .map(item => ({ group: "", source_host: "", method: "GET", kind: "http", size: null, variant: null, warnings: [], header_names: [], body_bytes: 0, ...item } as DownloadCandidate)) : [];
    if (!candidates.length) return null;
    // 私密目标只接受私密前缀下的相对目录；普通目标不能指向私密空间或回收站。
    const destination = typeof value.destination === "string" ? value.destination.replace(/^\/+/, "") : "";
    const error = candidates.length > MAX_DOWNLOAD_ITEMS ? `一次最多导入 ${MAX_DOWNLOAD_ITEMS} 个文件，请回到来源页面分批发送。` : undefined;
    return { candidates: error ? [] : candidates, error, private: value.private === true,
      destination: value.private === true ? PRIVATE_PREFIX : destination.startsWith(".tgdrive/") ? "" : destination };
  } catch { return null; }
}
export const createDownloads = (items: { ticket: string; name: string }[], destination: string) => post<{ tasks: DownloadTask[] }>(`/api/user/v1${isPrivatePath(destination) ? "/private" : ""}/downloads`, { items, destination });
export const clearDownloads = (status: "completed" | "failed") => post<{ removed: number }>("/api/user/v1/downloads/clear", { status });
export const controlDownload = (id: number, action: "stop" | "resume" | "restart" | "delete" | "update", item?: { ticket: string }, privateTask = false) => {
  const usePrivate = privateTask && Boolean(privateAccess);
  return post<DownloadTask | undefined>(`/api/user/v1${usePrivate ? "/private" : ""}/downloads/${id}/${action}`, { item });
};
const downloadRoute = (privateTask: boolean) => `/api/user/v1${privateTask && privateAccess ? "/private" : ""}/downloads`;
/** 「更新下载参数」回填用的完整链接与请求参数（仅任务所有者；私密任务需已解锁）。 */
export const downloadSource = (id: number, privateTask = false) => request<DownloadSource>(`${downloadRoute(privateTask)}/${id}/source`);
/** 停止账号下全部进行中的下载任务（含私密任务，停止不需要解锁）；任务记录和断点保留。 */
export const stopAllDownloads = () => post<{ stopped: number }>("/api/user/v1/downloads/stop-all", {});
export const batchDownloads = (action: "stop" | "resume" | "delete", ids: number[], privateTasks = false) =>
  post<{ done: number; skipped: number }>(`${downloadRoute(privateTasks)}/batch`, { action, ids });
export const updateAdminSettings = async (values: Partial<Record<keyof SystemSettings, string>>) => {
  const result = await post<SystemSettings>("/api/admin/v1/settings", values);
  setSiteConfig({ public_base_url: result.public_base_url.effective, s3_endpoint: result.s3_endpoint.effective });
  return result;
};
export type AuditEvent = { id: number; ts: number; actor_type: "admin" | "user" | "key"; actor: string | null; action: string; label: string; target: string | null; ip: string | null; ok: boolean; detail: Record<string, unknown> | null };
export const adminAudit = (options: { cursor?: number | null; failedOnly?: boolean } = {}) => {
  const params = new URLSearchParams({ limit: "30" });
  if (options.cursor) params.set("cursor", String(options.cursor));
  if (options.failedOnly) params.set("failed", "1");
  return request<{ events: AuditEvent[]; next_cursor: number | null }>(`/api/admin/v1/audit?${params}`);
};
export const deleteAuditEvent = (id: number) => post<{ deleted: number }>(`/api/admin/v1/audit/${id}/delete`);
export const clearAudit = (confirm: string) => post<{ deleted: number }>("/api/admin/v1/audit/clear", { confirm });
export const adminStatus = () => request<SystemStatus>("/api/admin/v1/status");
export const adminVersion = (signal?: AbortSignal) => request<{ version: string }>("/api/admin/v1/version", { signal });
export const adminSetup = (passphrase: string, username: string, password: string, nickname = "") => post<{ user_id: number; username: string }>("/api/admin/v1/setup", { passphrase, username, password, nickname });
export const adminUnlock = (passphrase: string) => post<SystemStatus>("/api/admin/v1/unlock", { passphrase });
export const adminLock = () => post<void>("/api/admin/v1/lock");
export const adminUsers = () => request<Account[]>("/api/admin/v1/users");
export type AccountSummary = { total: number; active: number; user_total: number; used_bytes: number; top_users: Account[]; near_quota: Account[] };
export const adminUserSummary = (signal?: AbortSignal) => request<AccountSummary>("/api/admin/v1/users/summary", { signal });
export const adminUsersPage = (cursor: string | null, q = "", status = "") => request<{ users: Account[]; total: number; next_cursor: number | null }>(
  `/api/admin/v1/users?limit=50&q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
export const createAdminUser = (username: string, password: string, quotaBytes: number | null, nickname = "") => post<{ id: number; username: string; bucket_id: number; quota_bytes: number | null }>("/api/admin/v1/users", { username, password, quota_bytes: quotaBytes, nickname });
export const setAdminUserStatus = (id: number, status: "active" | "disabled") => post<void>(`/api/admin/v1/users/${id}/status`, { status });
export const resetAdminUserPassword = (id: number, password: string) => post<void>(`/api/admin/v1/users/${id}/password`, { password });
export const deleteAdminUser = (id: number, confirm: string) => post<{ username: string; deleted_objects: number }>(`/api/admin/v1/users/${id}/delete`, { confirm });
export const changePassphrase = (oldPassphrase: string, newPassphrase: string) => post<{ key_version: number; rewrapped_files: number }>("/api/admin/v1/passphrase", { old_passphrase: oldPassphrase, new_passphrase: newPassphrase }, 15 * 60000);
export type MaintenanceTask = { at: number; error?: string; [key: string]: unknown };
export type GcFailure = { reason: string; count: number; dead?: number; label: string; hint: string };
export type MaintenanceStatus = { gc_pending: number; gc_dead: number; gc_failures?: GcFailure[]; cleanup?: MaintenanceTask; gc?: MaintenanceTask; scrub?: MaintenanceTask; backup?: MaintenanceTask; trash?: MaintenanceTask };
export const maintenanceStatus = () => request<MaintenanceStatus>("/api/admin/v1/maintenance/status");
export type ThumbnailJob = { id: string; kind: "image" | "video" | "audio"; state: string; detail: string; at?: number; wait_seconds?: number; manual?: boolean; backfill?: boolean };
/** 自动补图：daily_bytes 为 null 表示不限制，0 表示关闭。 */
export type ThumbnailBackfill = { daily_bytes: number | null; used_bytes: number; age_seconds: number; pending: number };
export type ThumbnailQueueStatus = { available: boolean; unlocked: boolean; pressure: string | null; jobs: ThumbnailJob[]; recent: ThumbnailJob[];
  cache: { bytes: number; limit_bytes: number; ttl_seconds: number }; remote_bytes: number; client_timeout_seconds: number; task_timeout_seconds: number; capacity: number; backfill: ThumbnailBackfill;
  candidate_count: number;
  inline: { count: number; bytes: number; skipped_quota: number } };
export const thumbnailQueue = () => request<ThumbnailQueueStatus>("/api/admin/v1/maintenance/thumbnails");
/** daily_mib：每日自动补图读取上限（MiB），0 关闭，-1 不限制。 */
export const setThumbnailBackfill = (dailyMib: number) => post<ThumbnailBackfill>("/api/admin/v1/maintenance/thumbnails", { daily_mib: dailyMib });
export const setThumbnailCandidateCount = (count: number) => post<{ candidate_count: number }>("/api/admin/v1/maintenance/thumbnails", { candidate_count: count });
export const runCleanup = () => post<{ aborted_uploads: number; stale_blobs: number; expired_upload_records: number }>("/api/admin/v1/maintenance/cleanup");
export const retryDeadGc = () => post<{ requeued: number }>("/api/admin/v1/maintenance/gc/retry");
export type Backup = { name: string; size: number; created_at: number };
export type BackupSettings = { keep: number };
export const listBackups = () => request<Backup[]>("/api/admin/v1/backups");
export const backupSettings = () => request<BackupSettings>("/api/admin/v1/backups/settings");
export const configureBackups = (keep: number) => post<BackupSettings>("/api/admin/v1/backups/settings", { keep }, 15 * 60000);
export const deleteBackup = (name: string) => post<{ name: string }>("/api/admin/v1/backups/delete", { name }, 15 * 60000);
export const createBackup = () => post<Backup>("/api/admin/v1/backups", undefined, 15 * 60000);
export const backupUrl = (name: string) => `/api/admin/v1/backups/${encodeURIComponent(name)}`;
export const setAdminUserQuota = (id: number, quotaBytes: number | null) => post<void>(`/api/admin/v1/users/${id}/quota`, { quota_bytes: quotaBytes });
export const adminClients = () => request<AdminClient[]>("/api/admin/v1/clients");
export const adminClientsPage = (cursor: string | null) => request<ClientPage>(`/api/admin/v1/clients?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
export const deleteAdminClient = (id: number) => post<void>(`/api/admin/v1/clients/${id}/delete`);
export const setAdminClientStatus = (id: number, status: "active" | "disabled") => post<void>(`/api/admin/v1/clients/${id}/status`, { status });
export const disableAdminKey = (accessKeyId: string) => post<void>("/api/admin/v1/client-keys/disable", { access_key_id: accessKeyId });
export const adminBots = (signal?: AbortSignal) => request<BotConfig[]>("/api/admin/v1/bots", { signal });
export const createAdminBot = (name: string, token: string, channelId: string) => post<BotConfig>("/api/admin/v1/bots", { name, token, channel_id: channelId });
export const checkAdminBot = (id: number) => post<{ id: number; ok: boolean; status: string }>(`/api/admin/v1/bots/${id}/check`);
export const setAdminBotStatus = (id: number, status: "active" | "disabled") => post<void>(`/api/admin/v1/bots/${id}/status`, { status });
export type AdminObjectSummary = { total: number; public_total: number };
export const adminObjectSummary = (signal?: AbortSignal) => request<AdminObjectSummary>("/api/admin/v1/objects/summary", { signal });
export const runAdminGc = (limit = 100) => post<{ processed: number; deleted: number; failed: number; dead: number }>("/api/admin/v1/maintenance/gc", { limit }, 15 * 60000);
export const runAdminScrub = (limit = 100, deep = false) => post<{ checked: number; wrapped: boolean; bad: { blob_uuid: string; chunks: [number, number][] }[] }>("/api/admin/v1/maintenance/scrub", { limit, deep }, 15 * 60000);

/* ---------- 站点地址 ---------- */

/* 管理员在「系统设置」中配置的对外地址；未配置时按当前站点推断。 */
let siteConfig: SiteConfig = { public_base_url: null, s3_endpoint: null };
export function setSiteConfig(config: Partial<SiteConfig>) {
  siteConfig = { public_base_url: config.public_base_url ?? null, s3_endpoint: config.s3_endpoint ?? null };
}

/** 推断的用户站点地址：用户端、控制台和 API 在同一个站点下，直接取当前站点。 */
export function detectedSiteOrigin() {
  return window.location.origin;
}
export function detectedS3Endpoint() {
  const { hostname } = window.location;
  return hostname === "127.0.0.1" || hostname === "localhost" ? "http://s3.localhost:8000" : null;
}
/** 公开访问地址：分享链接与 HTTP API 都以它为基础。 */
export function userSiteOrigin() {
  return siteConfig.public_base_url || detectedSiteOrigin();
}
/** S3 Endpoint；未配置且无法推断时返回 null，由界面提示管理员配置。 */
export function s3Endpoint() {
  return siteConfig.s3_endpoint || detectedS3Endpoint();
}
export function publicLinks(token: string, name: string, base?: string | null) {
  const root = (base || userSiteOrigin()).replace(/\/$/, "");
  return { page: `${root}/s/${encodeURIComponent(token)}`, direct: `${root}${publicPath(token, name)}` };
}
