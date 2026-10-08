export type Role = "admin" | "user";
export type SiteConfig = { public_base_url: string | null; s3_endpoint: string | null };
export type Session = { csrf_token: string; expires_at: number; username: string; role: Role; bucket_id?: number | null; unlocked?: boolean; remember?: boolean } & Partial<SiteConfig>;
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
};
/** public_folders：这一页里已公开的文件夹（键是文件夹路径，以 / 结尾）。 */
export type ListPage = { objects: FileItem[]; common_prefixes: string[]; next_cursor: string | null; public_folders?: Record<string, FileItem> };
export type Account = { id: number; username: string; role: Role; status: "active" | "disabled"; bucket_id: number | null; created_at: number; last_login_at: number | null; quota_bytes: number | null; used_bytes: number };
export type ClientKey = { access_key_id: string; status: "active" | "disabled"; created_at: number; last_used_at: number | null };
export type ClientGrant = { bucket_id: number; bucket_name: string; prefix: string; perms: "ro" | "rw" };
export type AdminClient = { id: number; name: string; description: string | null; owner_user_id: number | null; status: "active" | "disabled"; created_at: number; keys: ClientKey[]; grants: ClientGrant[] };
export type BotRuntime = { failures: number; cooldown_seconds: number; last_sent_at: number; state: "enabled" | "draining" | "disabled" } | null;
export type BotConfig = { id: number; name: string; channel_id: string; status: "active" | "disabled"; created_at: number; last_check_at: number | null; last_check_status: string | null; runtime?: BotRuntime };
export type AdminObject = FileItem & { bucket_id: number; bucket_name: string; username: string | null };
/** 当前登录账号：管理员和普通用户共用同一个会话接口，角色决定能看到哪些功能。 */
export type UserMe = { id: number; username: string; role: Role; bucket_id: number | null; quota_bytes: number | null; used_bytes: number; unlocked: boolean; remember?: boolean; csrf_token: string; expires_at: number } & SiteConfig;
export type SettingValue = { value: string | null; default: string | null; effective: string | null };
export type SystemSettings = { public_base_url: SettingValue; s3_endpoint: SettingValue };
export type TrafficPoint = { at: number; in_bytes: number; out_bytes: number };
export type TrafficMetrics = { total_in_bytes: number; total_out_bytes: number; recent: TrafficPoint[] };
export type SystemStatus = { initialized: boolean; unlocked: boolean; user_count: number; traffic?: TrafficMetrics };
export type PublicFile = { kind: "file"; token: string; password_required: false; name: string; size: number; content_type: string | null; etag: string; modified_at: number; public_at: number | null; expires_at: number | null };
export type PublicFolder = { kind: "folder"; token: string; password_required: false; name: string; modified_at: number; public_at: number | null; expires_at: number | null };
export type PublicObject = PublicFile | PublicFolder | { token: string; password_required: true };
export type PublicFolderPage = {
  name: string; path: string; next_cursor: string | null;
  folders: { name: string; path: string }[];
  files: { name: string; path: string; size: number; content_type: string | null; etag: string; modified_at: number }[];
};
export type CreatedClient = { id: number; access_key_id: string; secret: string };

let csrfToken = "";
export function setCsrf(value: string) { csrfToken = value; }

export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

export function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type") && !(init.body instanceof Blob)) headers.set("Content-Type", "application/json");
  if (csrfToken && init.method && init.method !== "GET") headers.set("X-CSRF-Token", csrfToken);
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "include", headers });
  } catch {
    throw new ApiError("无法连接到服务器，请检查网络后重试", 0, "network_error");
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    let code = "request_failed";
    try { const body = await response.json(); message = body.error?.message ?? message; code = body.error?.code ?? code; } catch { /* 保留状态码 */ }
    if (response.status === 401 && path.startsWith("/api/") && !path.endsWith("/login")) window.dispatchEvent(new CustomEvent("tgdrive:session-expired"));
    throw new ApiError(message, response.status, code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

/* ---------- 会话 ---------- */

/** remember 为 true 时服务端签发 30 天的长期会话（服务重启后仍有效）；否则 12 小时。 */
export async function login(username: string, password: string, remember = false): Promise<Session> {
  const session = await post<Session>("/api/auth/v1/login", { username, password, remember });
  setCsrf(session.csrf_token);
  return session;
}
export async function logout() {
  try { await post<void>("/api/auth/v1/logout"); }
  finally { setCsrf(""); }
}
export const me = () => request<UserMe>("/api/auth/v1/me");
export async function restoreSession(): Promise<Session> {
  const account = await me();
  setCsrf(account.csrf_token);
  setSiteConfig(account);
  return { csrf_token: account.csrf_token, expires_at: account.expires_at, username: account.username, role: account.role, bucket_id: account.bucket_id, unlocked: account.unlocked, remember: account.remember, public_base_url: account.public_base_url, s3_endpoint: account.s3_endpoint };
}
export const changePassword = (oldPassword: string, newPassword: string) => post<void>("/api/auth/v1/password", { old_password: oldPassword, new_password: newPassword });

/* ---------- 用户文件 ---------- */

export const listFiles = (prefix = "", cursor: string | null = null) =>
  request<ListPage>(`/api/user/v1/list?prefix=${encodeURIComponent(prefix)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
export const searchFiles = (query: string, cursor = "") =>
  request<ListPage>(`/api/user/v1/search?q=${encodeURIComponent(query)}&cursor=${encodeURIComponent(cursor)}`);
export const makeFolder = (path: string) => post<FileItem>("/api/user/v1/folders", { path });
/** recursive 为 true 时，以 / 结尾的文件夹路径会在服务端连同其中所有内容一起删除。 */
export const deleteFiles = (paths: string[], recursive = false) => post<{ results: { path: string; deleted: boolean; count?: number }[] }>("/api/user/v1/delete", { paths, recursive });
/** 移动冲突策略：rename 保留两者（自动编号），skip 跳过同名文件，overwrite 覆盖目标。 */
export type MoveConflict = "rename" | "skip" | "overwrite";
export const moveFile = (from: string, to: string, conflict: MoveConflict = "skip") => post<{ moved: number; skipped: number }>("/api/user/v1/move", { from, to, conflict });
export const copyFile = (from: string, to: string) => post<FileItem>("/api/user/v1/copy", { from, to });
export type ShareOptions = { expires_at?: number | null; password?: string | null };
export const setPublic = (paths: string[], isPublic: boolean, options: ShareOptions = {}) => post<{ objects: FileItem[] }>("/api/user/v1/public", { paths, public: isPublic, ...options });

/* ---------- 回收站 ---------- */
export type TrashItem = { id: string; path: string; is_folder: boolean; size: number; item_count: number; deleted_at: number; purge_at: number };
export const listTrash = () => request<{ items: TrashItem[]; total_size: number; retention_days: number }>("/api/user/v1/trash");
export const moveToTrash = (paths: string[]) => post<{ items: { id: string; path: string }[] }>("/api/user/v1/trash", { paths });
export const restoreTrash = (ids: string[]) => post<{ restored: { id: string; path: string }[] }>("/api/user/v1/trash/restore", { ids });
export const purgeTrash = (ids: string[] | "all") => post<{ purged: number }>("/api/user/v1/trash/purge", ids === "all" ? { all: true } : { ids });

/* ---------- 缩略图 ---------- */
export const thumbnailUrl = (path: string, etag: string) => `/api/user/v1/thumbnail?path=${encodeURIComponent(path)}&v=${etag}`;
export const setThumbnail = (path: string, data: string) => post<void>("/api/user/v1/thumbnail", { path, data });

/* ---------- 可续传的分段上传 ---------- */
export type UploadState = { upload_id: string; path: string; completed: boolean; parts: { part_no: number; size: number; etag: string }[] };
export type InstantResult = ({ hit: true } & FileItem) | { hit: false };
/** 秒传：存储桶里已有内容相同的文件时直接引用；未命中返回 { hit: false }，调用方再走普通上传。 */
export const instantUpload = (path: string, size: number, fingerprint: string, contentType: string, isPublic?: boolean) =>
  post<InstantResult>("/api/user/v1/files/instant", { path, size, fingerprint, content_type: contentType || undefined, ...(isPublic === undefined ? {} : { public: isPublic }) });
export const createUpload = (path: string, contentType: string) => post<{ upload_id: string; part_size: number }>("/api/user/v1/uploads", { path, content_type: contentType });
export const getUpload = (id: string) => request<UploadState>(`/api/user/v1/uploads/${id}`);
export const completeUpload = (id: string, parts: [number, string][], isPublic?: boolean) => post<FileItem>(`/api/user/v1/uploads/${id}/complete`, { parts, ...(isPublic === undefined ? {} : { public: isPublic }) });
export const abortUpload = (id: string) => request<void>(`/api/user/v1/uploads/${id}`, { method: "DELETE" });
export const listPublic = () => request<FileItem[]>("/api/user/v1/public");
export const contentUrl = (path: string, download = false) => `/api/user/v1/content?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;

export type UploadProgress = { loaded: number; total: number; percent: number };
/** 用 XHR 上传一个请求体以获得进度；文件体直接流向服务端，不在前端复制。返回的 abort 可取消该请求。 */
function xhrPut<T>(url: string, body: Blob, contentType: string, onProgress: (progress: UploadProgress) => void): { promise: Promise<T>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open("PUT", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", contentType);
    if (csrfToken) xhr.setRequestHeader("X-CSRF-Token", csrfToken);
    xhr.upload.onprogress = event => {
      const total = event.lengthComputable ? event.total : body.size;
      onProgress({ loaded: event.loaded, total, percent: total ? Math.min(100, event.loaded / total * 100) : 0 });
    };
    xhr.onerror = () => reject(new ApiError("网络连接中断，请重试", 0, "network_error"));
    xhr.onabort = () => reject(new ApiError("已取消上传", 0, "upload_aborted"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress({ loaded: body.size, total: body.size, percent: 100 });
        try { resolve(JSON.parse(xhr.responseText) as T); } catch { reject(new ApiError("服务器返回格式异常", xhr.status, "invalid_response")); }
        return;
      }
      let message = `上传失败（${xhr.status}）`; let code = "upload_failed";
      try { const parsed = JSON.parse(xhr.responseText); message = parsed.error?.message ?? message; code = parsed.error?.code ?? code; } catch { /* 保留状态码 */ }
      if (xhr.status === 401) window.dispatchEvent(new CustomEvent("tgdrive:session-expired"));
      reject(new ApiError(message, xhr.status, code));
    };
    xhr.send(body);
  });
  return { promise, abort: () => xhr.abort() };
}

export function uploadFileWithProgress(path: string, file: File, options: { isPublic?: boolean; onProgress: (progress: UploadProgress) => void }): { promise: Promise<FileItem>; abort: () => void } {
  const publicParam = options.isPublic === undefined ? "" : `&public=${options.isPublic ? "1" : "0"}`;
  return xhrPut<FileItem>(`/api/user/v1/files?path=${encodeURIComponent(path)}${publicParam}`, file, file.type || "application/octet-stream", options.onProgress);
}

export function uploadPartWithProgress(uploadId: string, partNo: number, blob: Blob, onProgress: (progress: UploadProgress) => void) {
  return xhrPut<{ part_no: number; size: number; etag: string }>(`/api/user/v1/uploads/${uploadId}/parts/${partNo}`, blob, "application/octet-stream", onProgress);
}

/* ---------- 用户客户端密钥 ---------- */

export const userClients = () => request<AdminClient[]>("/api/user/v1/clients");
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
export const publicObject = (token: string, access?: string | null) => request<PublicObject>(`/api/public/v1/objects/${encodeURIComponent(token)}${access ? `?access=${encodeURIComponent(access)}` : ""}`);
export const publicFolderList = (token: string, path = "", cursor: string | null = null, access?: string | null) => {
  const params = new URLSearchParams({ path });
  if (cursor) params.set("cursor", cursor);
  if (access) params.set("access", access);
  return request<PublicFolderPage>(`/api/public/v1/folders/${encodeURIComponent(token)}/list?${params}`);
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

export const adminSettings = () => request<SystemSettings>("/api/admin/v1/settings");
export const updateAdminSettings = async (values: Partial<Record<keyof SiteConfig, string>>) => {
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
export const adminStatus = () => request<SystemStatus>("/api/admin/v1/status");
export const adminSetup = (passphrase: string, username: string, password: string) => post<{ user_id: number; username: string }>("/api/admin/v1/setup", { passphrase, username, password });
export const adminUnlock = (passphrase: string) => post<SystemStatus>("/api/admin/v1/unlock", { passphrase });
export const adminLock = () => post<void>("/api/admin/v1/lock");
export const adminUsers = () => request<Account[]>("/api/admin/v1/users");
export const createAdminUser = (username: string, password: string, quotaBytes: number | null) => post<{ id: number; username: string; bucket_id: number; quota_bytes: number | null }>("/api/admin/v1/users", { username, password, quota_bytes: quotaBytes });
export const setAdminUserStatus = (id: number, status: "active" | "disabled") => post<void>(`/api/admin/v1/users/${id}/status`, { status });
export const resetAdminUserPassword = (id: number, password: string) => post<void>(`/api/admin/v1/users/${id}/password`, { password });
export const deleteAdminUser = (id: number, confirm: string) => post<{ username: string; deleted_objects: number }>(`/api/admin/v1/users/${id}/delete`, { confirm });
export const changePassphrase = (oldPassphrase: string, newPassphrase: string) => post<{ key_version: number; rewrapped_files: number }>("/api/admin/v1/passphrase", { old_passphrase: oldPassphrase, new_passphrase: newPassphrase });
export type MaintenanceTask = { at: number; error?: string; [key: string]: unknown };
export type MaintenanceStatus = { gc_pending: number; gc_dead: number; cleanup?: MaintenanceTask; gc?: MaintenanceTask; scrub?: MaintenanceTask; backup?: MaintenanceTask; trash?: MaintenanceTask };
export const maintenanceStatus = () => request<MaintenanceStatus>("/api/admin/v1/maintenance/status");
export const runCleanup = () => post<{ aborted_uploads: number; stale_blobs: number; expired_upload_records: number }>("/api/admin/v1/maintenance/cleanup");
export const retryDeadGc = () => post<{ requeued: number }>("/api/admin/v1/maintenance/gc/retry");
export type Backup = { name: string; size: number; created_at: number };
export const listBackups = () => request<Backup[]>("/api/admin/v1/backups");
export const createBackup = () => post<Backup>("/api/admin/v1/backups");
export const backupUrl = (name: string) => `/api/admin/v1/backups/${encodeURIComponent(name)}`;
export const setAdminUserQuota = (id: number, quotaBytes: number | null) => post<void>(`/api/admin/v1/users/${id}/quota`, { quota_bytes: quotaBytes });
export const adminClients = () => request<AdminClient[]>("/api/admin/v1/clients");
export const deleteAdminClient = (id: number) => post<void>(`/api/admin/v1/clients/${id}/delete`);
export const setAdminClientStatus = (id: number, status: "active" | "disabled") => post<void>(`/api/admin/v1/clients/${id}/status`, { status });
export const disableAdminKey = (accessKeyId: string) => post<void>("/api/admin/v1/client-keys/disable", { access_key_id: accessKeyId });
export const adminBots = () => request<BotConfig[]>("/api/admin/v1/bots");
export const createAdminBot = (name: string, token: string, channelId: string) => post<BotConfig>("/api/admin/v1/bots", { name, token, channel_id: channelId });
export const checkAdminBot = (id: number) => post<{ id: number; ok: boolean; status: string }>(`/api/admin/v1/bots/${id}/check`);
export const setAdminBotStatus = (id: number, status: "active" | "disabled") => post<void>(`/api/admin/v1/bots/${id}/status`, { status });
export type AdminObjectPage = { objects: AdminObject[]; next_cursor: string | null; total: number; public_total: number };
export const adminObjects = (options: { q?: string; publicOnly?: boolean; cursor?: string | null; limit?: number } = {}) => {
  const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
  if (options.q) params.set("q", options.q);
  if (options.publicOnly) params.set("public", "1");
  if (options.cursor) params.set("cursor", options.cursor);
  return request<AdminObjectPage>(`/api/admin/v1/objects?${params}`);
};
export const setAdminObjectPublic = (bucketId: number, path: string, isPublic: boolean) => post<FileItem>("/api/admin/v1/objects/public", { bucket_id: bucketId, path, public: isPublic });
export const adminContentUrl = (bucketId: number, path: string, download = false) => `/api/admin/v1/content?bucket_id=${bucketId}&path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
export const runAdminGc = (limit = 100) => post<{ processed: number; deleted: number; failed: number; dead: number }>("/api/admin/v1/maintenance/gc", { limit });
export const runAdminScrub = (limit = 100, deep = false) => post<{ checked: number; wrapped: boolean; bad: { blob_uuid: string; chunks: [number, number][] }[] }>("/api/admin/v1/maintenance/scrub", { limit, deep });

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
