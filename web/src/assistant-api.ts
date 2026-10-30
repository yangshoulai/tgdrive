/** 文件助手的接口：用户端 /api/user/v1/assistant 与管理端 /api/admin/v1/assistant（docs/assistant-design.md §13）。 */
import { ApiError, apiBlob, apiGet, apiPost, postKeepalive } from "./api";

const USER = "/api/user/v1/assistant";
/** 统一对话（§37）：涉及私密空间的对话、操作在私密空间锁定时返回 423 private_locked。
 * 私密授权由服务端按登录会话判断，这里只通知抽屉弹出解锁（不退出登录）。 */
export const UNLOCK_EVENT = "tessera:assistant-unlock";
export const isPrivateLocked = (reason: unknown) => reason instanceof ApiError && reason.code === "private_locked";
const guard = <T>(promise: Promise<T>) => promise.catch((reason: unknown) => {
  if (isPrivateLocked(reason)) window.dispatchEvent(new CustomEvent(UNLOCK_EVENT));
  throw reason;
});
const get = <T>(path: string, signal?: AbortSignal) => path.startsWith(USER) ? guard(apiGet<T>(path, signal)) : apiGet<T>(path, signal);
const post = <T>(path: string, body?: unknown, timeoutMs?: number) => path.startsWith(USER) ? guard(apiPost<T>(path, body, timeoutMs)) : apiPost<T>(path, body, timeoutMs);

export type ToolSupport = "unknown" | "yes" | "no";
export type Capabilities = { tools?: boolean | null; reasoning?: boolean | null; vision?: boolean | null; structured?: boolean | null };
export type AiModel = {
  id: number; channel_id: number; model: string; display_name: string | null; label: string; source: "auto" | "manual";
  enabled: boolean; tools: ToolSupport; context_window: number | null; max_output: number | null; removed_upstream: boolean;
  input_price: number | null; output_price: number | null; capabilities: Capabilities; catalog_id: string | null; manual_fields: string[];
  sort: number; tested_at: number | null; test_note: string | null; channel_name?: string;
  /** 允许用于私密对话（§24.6，默认关闭） */
  private_ok?: boolean;
};
/** 渠道上游模型与目录匹配结果（尚未加入时 added=false）。 */
export type UpstreamModel = {
  model: string; display_name: string | null; context_window: number | null; max_output: number | null; input_price: number | null;
  output_price: number | null; capabilities: Capabilities; catalog_id: string | null; added: boolean; model_id: number | null;
};
export type CatalogEntry = {
  id: string; provider: string; model: string; name: string | null; family: string | null; context_window: number | null; max_output: number | null;
  input_price: number | null; output_price: number | null; cache_price: number | null; capabilities: Capabilities; knowledge: string | null;
  released: string | null; source: "models.dev" | "openrouter" | "manual"; updated_at: number;
};
export type CatalogStatus = {
  url: string; default_url: string; auto_sync: boolean; synced_at: number | null; note: string | null; error: string | null;
  total: number; manual: number; providers: number;
};
export type CatalogInput = { provider?: string; model?: string; name?: string | null; context_window?: number | null; max_output?: number | null;
  input_price?: number | null; output_price?: number | null; cache_price?: number | null; capabilities?: Capabilities };
export type ChannelHealth = { requests: number; success_rate: number | null; p95_ms: number | null; last_error: string | null; unhealthy: boolean };
export type ChannelProtocol = "chat_completions" | "responses";
export type AiChannel = {
  id: number; name: string; kind: "openai" | "anthropic"; base_url: string; api_key: string | null; header_names: string[];
  protocol?: ChannelProtocol;
  enabled: boolean; concurrency: number; timeout: number; synced_at: number | null; sync_note: string | null; last_error: string | null;
  models: number; enabled_models: number; created_at: number; updated_at: number; health?: ChannelHealth | null;
  sync?: { total: number; added: number; removed: number; note: string }; sync_error?: string;
};
export type ChannelInput = { name?: string; kind?: AiChannel["kind"]; protocol?: ChannelProtocol; base_url?: string; api_key?: string | null; headers?: Record<string, string>; enabled?: boolean; concurrency?: number; timeout?: number };
export type ToolLevel = "read" | "write" | "danger" | "scope" | "meta";
export type ToolParam = { name: string; label: string; default: number; min: number; max: number; value: number };
export type AdminTool = {
  name: string; label: string; group: string; group_label: string; level: ToolLevel; description: string; fixed: boolean;
  enabled: boolean; default_enabled: boolean; depends: string[]; warning: string | null; params: ToolParam[];
  /** 私密对话中的可用性（§24.5.1）：allow 照常、limited 有限制、only 仅私密对话、never 不提供、na 不适用。 */
  private: PrivateMode; private_note: string | null; private_enabled: boolean;
};
export type PrivateMode = "allow" | "limited" | "only" | "never" | "na";
export type Bound = { default: number; min: number; max: number; label?: string };
export type AssistantSettings = {
  enabled: boolean; default_model: number | null; full_access: boolean; user_daily_tokens: number; retention_days: number; call_log_days: number;
  notice: string; notice_default: string; bounds: Record<string, Bound>;
  /** 全局允许私密对话（默认关闭） */
  private: boolean;
  /** 完全访问下自动执行公开分享（需要密码的除外）／彻底删除：1 开启，0 仍需确认 */
  full_auto_share: number; full_auto_purge: number;
};
export type AssistantLimits = { values: Record<string, number>; bounds: Record<string, Bound & { label: string }> };
export type UsagePoint = { day: string; model_id: number; input_tokens: number; output_tokens: number; runs: number };
export type AssistantOverview = {
  enabled: boolean; default_model: AiModel | null; usable_models: number; channels: number;
  tools: { enabled: number; total: number };
  today: { conversations: number; requests: number; tokens: number; failure_rate: number | null; pending_actions: number; executed_actions: number };
  usage: UsagePoint[]; usage_since: string; models: Record<string, string>;
  health: (ChannelHealth & { id: number; name: string; enabled: boolean })[];
  storage: Record<string, number>;
};
export type UserPolicy = {
  enabled: boolean | null; max_level: "read" | "write" | "danger" | null; daily_tokens: number | null; full_access: boolean | null;
  private: boolean | null;
  effective: { enabled: boolean; max_level: "read" | "write" | "danger"; daily_tokens: number; full_access: boolean; private: boolean };
  usage: { today: number; days30: number };
};
export type AdminConversation = {
  id: string; user_id: number; username: string | null; model_id: number | null; model_name: string | null; model_label: string | null;
  messages: number; input_tokens: number; output_tokens: number; hidden: boolean; archived: number; created_at: number; updated_at: number;
  runs: number; actions: number;
};
export type AdminConversationDetail = {
  id: string; user_id: number; username: string | null; messages: number; input_tokens: number; output_tokens: number; hidden: boolean;
  created_at: number; updated_at: number;
  runs: { id: string; model_id: number | null; status: string; stop_reason: string | null; steps: number; tool_calls: number; input_tokens: number; output_tokens: number; started_at: number; ended_at: number | null }[];
  tools: { tool_name: string; count: number }[];
  actions: { id: string; kind: string; tool_name: string | null; status: string; count: number; created_at: number; decided_at: number | null }[];
};
export type CallKind = "model" | "tool" | "fetch" | "sync" | "test";
export type AssistantCall = {
  id: number; kind: CallKind; run_id: string | null; conversation_id: string | null; user_id: number | null; username: string | null;
  actor: string | null; channel_id: number | null; channel_name: string | null; model_id: number | null; model_name: string | null;
  model_label: string | null; tool_name: string | null; host: string | null; started_at: number; duration_ms: number | null;
  ttfb_ms: number | null; status: "ok" | "error" | "timeout" | "cancelled" | "limited"; http_status: number | null;
  error_code: string | null; error: string | null; input_tokens: number | null; output_tokens: number | null;
  cached_tokens: number | null; upstream_id: string | null; items: number | null;
};
export type CallStats = { total: number; ok: number; success_rate: number | null; p50_ms: number | null; p95_ms: number | null; input_tokens: number; output_tokens: number };
export type CallFilters = { kind?: string; status?: string; channel_id?: number; model_id?: number; tool?: string; user_id?: number; since?: number; until?: number; conversation_id?: string };

const ADMIN = "/api/admin/v1/assistant";
const query = (values: Record<string, string | number | undefined | null>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
};

export const adminOverview = (signal?: AbortSignal) => get<AssistantOverview>(`${ADMIN}/overview`, signal);
type TokenRow = { input_tokens: number | null; output_tokens: number | null; runs: number | null };
export type UsageReport = {
  days: number; since: string; totals: { input_tokens: number; output_tokens: number; runs: number; users: number; cost: number | null };
  by_day: (TokenRow & { day: string; users: number })[];
  by_user: (TokenRow & { user_id: number; username: string | null; nickname: string | null })[];
  by_model: (TokenRow & { model_id: number; model_name: string | null; model_label: string | null; channel_name: string | null; cost: number | null })[];
  tools: { tool_name: string; calls: number; errors: number; avg_ms: number | null }[];
  stops: { reason: string; runs: number }[];
  actions: { kind: string; status: string; actions: number; items: number | null }[];
};
export const adminUsage = (days: number, signal?: AbortSignal) => get<UsageReport>(`${ADMIN}/usage${query({ days })}`, signal);
export const adminSettings = () => get<AssistantSettings>(`${ADMIN}/settings`);
export const updateAdminSettings = (values: Partial<Omit<AssistantSettings, "bounds" | "notice_default" | "notice">> & { notice?: string | null }) => post<AssistantSettings>(`${ADMIN}/settings`, values);
export const adminLimits = () => get<AssistantLimits>(`${ADMIN}/limits`);
export const updateAdminLimits = (values: Record<string, number>) => post<AssistantLimits>(`${ADMIN}/limits`, values);
export const adminTools = () => get<AdminTool[]>(`${ADMIN}/tools`);
export const updateAdminTools = (values: Record<string, Record<string, boolean | number>>) => post<AdminTool[]>(`${ADMIN}/tools`, values);
export const adminChannels = () => get<AiChannel[]>(`${ADMIN}/channels`);
export const createAdminChannel = (input: ChannelInput) => post<AiChannel>(`${ADMIN}/channels`, input, 120000);
export const updateAdminChannel = (id: number, input: ChannelInput) => post<AiChannel>(`${ADMIN}/channels/${id}/update`, input);
export const deleteAdminChannel = (id: number) => post<void>(`${ADMIN}/channels/${id}/delete`);
export const syncAdminChannel = (id: number) => post<{ total: number; added: number; restored: number; removed: number; note: string }>(`${ADMIN}/channels/${id}/sync`, undefined, 120000);
export const adminChannelModels = (id: number) => get<AiModel[]>(`${ADMIN}/channels/${id}/models`);
type ModelFields = Partial<Pick<AiModel, "display_name" | "enabled" | "tools" | "context_window" | "max_output" | "sort" | "input_price" | "output_price" | "private_ok">>
  & { /** 图片输入：auto 跟随模型目录，yes／no 为手动设置。 */ vision?: "auto" | "yes" | "no" };
export const addAdminModel = (channelId: number, input: ModelFields & { model: string }) => post<AiModel>(`${ADMIN}/channels/${channelId}/models`, input);
export const updateAdminModel = (id: number, input: ModelFields & { reset_catalog?: boolean }) => post<AiModel>(`${ADMIN}/models/${id}/update`, input);
export const discoverChannelModels = (id: number) => get<{ models: UpstreamModel[]; total: number; removed: number; note: string }>(`${ADMIN}/channels/${id}/discover`);
export const addChannelModels = (id: number, models: string[]) => post<{ added: number; enabled: number }>(`${ADMIN}/channels/${id}/models/batch`, { models }, 120000);
export const adminCatalog = (filters: { q?: string; provider?: string; cursor?: string | null }) =>
  get<{ status: CatalogStatus; providers: { provider: string; count: number }[]; entries: CatalogEntry[]; next_cursor: string | null }>(`${ADMIN}/catalog${query(filters)}`);
export const syncCatalog = () => post<{ total: number; added: number; updated: number; models: number; note: string }>(`${ADMIN}/catalog/sync`, {}, 120000);
export const updateCatalogSettings = (input: { url?: string | null; auto_sync?: boolean }) => post<CatalogStatus>(`${ADMIN}/catalog/settings`, input);
export const createCatalogEntry = (input: CatalogInput) => post<CatalogEntry>(`${ADMIN}/catalog`, input);
export const updateCatalogEntry = (id: string, input: CatalogInput) => post<CatalogEntry>(`${ADMIN}/catalog/update`, { id, ...input });
export const deleteCatalogEntry = (id: string) => post<void>(`${ADMIN}/catalog/delete`, { id });
export const deleteAdminModel = (id: number) => post<void>(`${ADMIN}/models/${id}/delete`);
export const testAdminModel = (id: number) => post<{ ok: boolean; tools: ToolSupport; note: string; duration_ms: number }>(`${ADMIN}/models/${id}/test`, undefined, 150000);
export const adminPolicy = (userId: number) => get<UserPolicy>(`${ADMIN}/users/${userId}/policy`);
export const updateAdminPolicy = (userId: number, input: Partial<Pick<UserPolicy, "enabled" | "max_level" | "daily_tokens" | "full_access" | "private">>) => post<UserPolicy>(`${ADMIN}/users/${userId}/policy`, input);
export const adminConversations = (cursor: string | null, filters: { user_id?: number; model_id?: number; since?: number; until?: number; action?: string }) =>
  get<{ conversations: AdminConversation[]; next_cursor: string | null }>(`${ADMIN}/conversations${query({ cursor, ...filters })}`);
export const adminConversation = (id: string) => get<AdminConversationDetail>(`${ADMIN}/conversations/${encodeURIComponent(id)}`);
export const deleteAdminConversations = (input: { user_id?: number; before?: number; dry_run?: boolean }) => post<{ count?: number; deleted?: number }>(`${ADMIN}/conversations/delete`, input);
export const adminCalls = (cursor: number | null, filters: CallFilters) => get<{ calls: AssistantCall[]; next_cursor: number | null }>(`${ADMIN}/calls${query({ cursor, ...filters })}`);
export const adminCallStats = (filters: CallFilters) => get<CallStats>(`${ADMIN}/calls/stats${query({ ...filters })}`);
export const purgeAssistantData = () => post<void>(`${ADMIN}/purge`, { confirm: "清除" });

/* ---------- 用户端 ---------- */

export type UserTool = { name: string; label: string; group: string; group_label: string; level: ToolLevel; description: string; available: boolean; reason: string | null; warning: string | null;
  /** 用于私密空间时的限制或不可用说明（§37.3） */
  note?: string };
export type AssistantConfig = {
  available: boolean; reason: string | null; models: AiModel[]; default_model: number | null; tools: UserTool[];
  max_level: "read" | "write" | "danger"; usage: { today: number; limit: number | null }; notice: string; notice_ack: boolean; retention_days: number;
  full_access: boolean;
  /** 私密空间（§37）：账号能否让助手处理私密文件、私密说明与是否已确认、当前登录会话是否已解锁。 */
  private_available: boolean; private_notice: string; private_notice_ack: boolean; private_unlocked: boolean;
};
export type AccessMode = "approval" | "full";
export type Conversation = { id: string; title: string | null; scope: string; model_id: number | null; archived: boolean; messages: number;
  access_mode: AccessMode; created_at: number; updated_at: number; active_run?: string | null;
  /** 涉及私密空间（§37）；locked：私密空间未解锁，标题已隐藏。 */
  private?: boolean; locked?: boolean };
export type BrowserEvent =
  | { type: "browser"; action: "download"; items: { path: string; folder: boolean }[]; size: number }
  | { type: "browser"; action: "open"; url: string; host: string; title: string | null }
  | { type: "browser"; action: "share"; path: string; conversation_id: string }
  | { type: "browser"; action: "copy"; text: string; title: string | null; private?: boolean }
  | { type: "browser"; action: "thumbnails"; items: { path: string; size: number; etag: string; content_type: string | null; retry?: boolean }[]; regenerate: boolean }
  | { type: "browser"; action: "cache"; items: { path: string; size: number; etag: string; content_type: string | null }[]; size: number; private?: boolean }
  | { type: "browser"; action: "uncache"; items: { path: string; size: number; etag: string; content_type: string | null }[]; size: number; private?: boolean };
export type HttpDecision = "approved" | "rejected" | "expired" | "cancelled";
export type HttpRequestPreview = { url: string; method: string; headers: Record<string, string>; body: string | null; body_encoding: "text" | "base64"; body_bytes: number };
export type PlanStatus = "pending" | "in_progress" | "waiting_user" | "completed" | "failed" | "paused" | "cancelled";
export type PlanEvent = { type: "plan"; id?: string; run_id?: string; version?: number; title?: string; reason?: string;
  /** 助手的进度记录：已完成范围、下一步起点与需要记住的编号（§38）。 */
  notes?: string;
  status?: PlanStatus; automatic?: boolean;
  items: { id?: string; content: string; status: PlanStatus; kind?: "tool" | "reasoning"; detail?: string;
    /** 没有关联的成功工具结果，由助手说明依据后标为完成。 */
    unverified?: boolean }[] };
export type ToolEvent =
  | PlanEvent
  | { type: "question"; question: string; options: string[] }
  | { type: "scope_request"; action_id: string; from: string; to: string; reason: string }
  | { type: "action"; action_id: string; kind: string; count: number; auto?: boolean }
  | { type: "http_request"; id: string; requested_at: number; request: HttpRequestPreview; decision: HttpDecision }
  | BrowserEvent;
export type SnapshotAttachment = { type: "snapshot"; id: string; source: string; pages: number; images: number };
export type ChatMessage = {
  seq: number; run_id: string | null; role: "user" | "assistant" | "tool" | "event"; tool_name?: string | null; created_at?: number;
  text?: string; scope?: string; location?: string;
  tool_calls?: { id: string; name: string; arguments: string }[]; model_id?: number; input_tokens?: number; output_tokens?: number;
  reasoning?: string; reasoning_ms?: number | null;
  call_id?: string; name?: string; label?: string; arguments?: Record<string, unknown>; status?: "ok" | "error" | "limited" | "cancelled"; summary?: string;
  result?: unknown; items?: number | null; duration_ms?: number; truncated?: boolean; event?: ToolEvent | null;
  type?: string; retry?: boolean; action_id?: string; attachment?: SnapshotAttachment; mentions?: string[]; attachments?: MessageAttachment[];
};
/** 消息里的对话附件：name 是对话内的显示名（模型以「附件:名称」称呼）。 */
export type MessageAttachment = { id: string; name: string; size: number; content_type: string | null; image: boolean };
export const ACTION_KINDS: Record<string, string> = {
  rename: "批量改名", move: "移动", organize: "整理文件", mkdir: "新建文件夹", trash: "移入回收站", restore: "从回收站恢复",
  purge: "彻底删除", unshare: "取消公开", share: "公开分享", downloads: "离线下载", download_control: "下载任务操作",
  save_attachment: "保存附件", move_out: "移出私密空间", move_in: "移入私密空间",
};
export type ActionStatus = "pending" | "confirmed" | "rejected" | "expired" | "running" | "done" | "partial" | "failed" | "cancelled"
  | "interrupted" | "undoing" | "undone";
/** 冻结的条目：移动类为 from/to（对象键），其余为 path / id / url 等。 */
export type ActionItem = { from?: string; to?: string; path?: string; id?: string | number; name?: string; url?: string; host?: string;
  size?: number; folder?: boolean; op?: string; status?: string; variant?: string | null; attachment?: string;
  /** 移入回收站的文件夹内的文件数（0 为空目录） */
  files?: number };
export type ShareLink = { path: string; token: string; folder: boolean; expires_at: number | null; password: boolean };
export type ActionResult = { ok: number; skipped: number; failed: number; total: number; reasons: Record<string, number>;
  failures: { path: string; reason: string; status: "skipped" | "failed" }[]; links?: ShareLink[] };
export type AssistantAction = {
  id: string; kind: string; tool_name: string | null; status: ActionStatus; count: number;
  payload: {
    from?: string; to?: string; reason?: string; kind?: string; title?: string; scope?: string; summary?: string; size?: number;
    conflicts?: number; danger?: boolean; samples?: ActionItem[]; skipped?: { path: string; reason: string }[];
    options?: { target?: string; hosts?: string[]; source?: string | null; op?: string; by?: string; folders?: string[];
      expires_days?: number | null; require_password?: boolean;
      /** 移入回收站：只删除空目录；所选文件夹中的文件总数与非空文件夹数 */
      only_empty?: boolean; files?: number; nonempty?: number };
    auto?: boolean; confirm_reason?: string;
  } | null;
  result: ActionResult | null; undoable?: boolean; progress?: { done: number; total: number; ok: number; skipped: number; failed: number };
  created_at: number; expires_at: number; decided_at: number | null; finished_at?: number | null;
};
export type ConversationDetail = { conversation: Conversation; messages: ChatMessage[]; actions: AssistantAction[]; active_run: string | null;
  /** 向前翻页的消息游标；null 表示已加载到最早的消息。 */
  before_seq?: number | null;
  attachments?: { count: number; size: number };
  /** 最近一次模型请求的上下文占用（包括因超长而停止的请求）与模型窗口（§23） */
  context?: { used: number; window: number } | null };
export type RunEvent = { seq: number; type: string; [key: string]: unknown };

export const assistantConfig = (signal?: AbortSignal) => get<AssistantConfig>(`${USER}/config`, signal);
/** 确认使用说明；private 为私密空间的单独说明（同时确认普通说明）。 */
export const acknowledgeNotice = (privateNotice = false) => post<void>(`${USER}/notice/ack`, privateNotice ? { private: true } : {});
export const conversations = (cursor?: string | null, archived = false) => get<{ conversations: Conversation[]; next_cursor: string | null }>(`${USER}/conversations${query({ cursor, archived: archived ? "1" : undefined })}`);
/** location 在私密空间页面时是带私密前缀的对象键：新对话一开始就涉及私密（需已解锁）。 */
export const createConversation = (location: string, modelId?: number | null, accessMode: AccessMode = "approval") =>
  post<ConversationDetail>(`${USER}/conversations`, { location, model_id: modelId ?? undefined, access_mode: accessMode });
export const conversation = (id: string, beforeSeq?: number) => get<ConversationDetail>(`${USER}/conversations/${encodeURIComponent(id)}${query({ before_seq: beforeSeq })}`);
export const updateConversation = (id: string, input: { title?: string; archived?: boolean; access_mode?: AccessMode }) => post<Conversation>(`${USER}/conversations/${encodeURIComponent(id)}/update`, input);
export type ExportFormat = "markdown" | "json";
/** 下载对话的明文留痕（Markdown 或 JSON）；涉及私密的对话未解锁时返回 423，经 guard 通知抽屉弹出解锁。 */
export async function exportConversation(id: string, format: ExportFormat) {
  let zone = "";
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""; } catch { /* 取不到时区时按 UTC 导出。 */ }
  return guard(apiBlob(`${USER}/conversations/${encodeURIComponent(id)}/export?format=${format}&tz=${encodeURIComponent(zone)}`));
}
export const deleteConversation = (id: string) => post<void>(`${USER}/conversations/${encodeURIComponent(id)}/delete`, {});
const attachmentPath = (id: string, tail: string) => `${USER}/attachments/${encodeURIComponent(id)}/${tail}`;
export const attachmentContentUrl = (id: string, download = false) => attachmentPath(id, `content${download ? "?download=1" : ""}`);
export const attachmentThumbnailUrl = (id: string, variant: "thumb" | "grid" | "poster" = "thumb") => attachmentPath(id, `thumbnail?variant=${variant}`);
export const setAttachmentThumbnail = (id: string, data: string | null, variant: "thumb" | "grid" | "poster" | "none") =>
  post<void>(attachmentPath(id, "thumbnails"), { data, variant });
export const discardAttachment = (id: string) => post<void>(attachmentPath(id, "discard"), {});
/** 页面关闭时放弃未发送的附件：keepalive 请求在卸载后仍会送达。 */
export const discardAttachmentsOnUnload = (ids: string[]) => ids.forEach(id => postKeepalive(attachmentPath(id, "discard"), {}));
/** 清除自己全部未发送的附件（设置「助手附件」）。 */
export const discardPendingAttachments = () => post<{ removed: number; size: number }>(`${USER}/attachments/discard-pending`, {});
/** 另存为普通文件：path 为目标文件夹（以 / 结尾）；同名自动改名。 */
export const saveAttachment = (id: string, path: string) => post<{ path: string; size: number }>(attachmentPath(id, "save"), { path });
export type AttachmentStats = { count: number; size: number; pending: { count: number; size: number };
  conversations: { conversation_id: string; title: string | null; archived: boolean; count: number; size: number; latest: number }[] };
export const attachmentStats = () => get<AttachmentStats>(`${USER}/attachments/stats`);
export type ClientEnvironment = { browser: string; browser_version: string; os: string; language: string; timezone: string; origin: string };
export const sendMessage = (id: string, input: { text: string; model_id?: number; location: string; view: string; scope?: "conversation" | "location" | "root" | "path"; scope_path?: string; mentions?: string[]; attachments?: string[]; snapshot_id?: string; environment?: ClientEnvironment }) =>
  post<{ run_id: string; message_seq: number }>(`${USER}/conversations/${encodeURIComponent(id)}/messages`, input);
/** 从自己的某条消息重新回答：服务端丢弃这条消息及之后的记录，以同样的内容（引用、附件）开始新运行。 */
export const retryMessage = (id: string, input: { seq: number; model_id?: number; location: string; view: string; environment?: ClientEnvironment }) =>
  post<{ run_id: string; message_seq: number }>(`${USER}/conversations/${encodeURIComponent(id)}/retry`, input);
export const stopRun = (runId: string) => post<void>(`${USER}/runs/${encodeURIComponent(runId)}/stop`, {});
export const shareLink = (conversationId: string, path: string) =>
  get<{ token: string; public_base_url: string | null }>(`${USER}/conversations/${encodeURIComponent(conversationId)}/share-link${query({ path })}`);
/** 回传浏览器工具的执行结果（只有发起这个运行的登录会话可以回传）。 */
export const sendClientResult = (runId: string, callId: string, outcome: { result?: Record<string, unknown>; error?: string }) =>
  post<void>(`${USER}/runs/${encodeURIComponent(runId)}/client-results`, { call_id: callId, ...outcome });
export const action = (id: string) => get<AssistantAction>(`${USER}/actions/${encodeURIComponent(id)}`);
export const actionItems = (id: string, offset = 0) =>
  get<{ items: ActionItem[]; skipped: { path: string; reason: string }[]; total: number; next_offset: number | null; compacted: boolean }>(
    `${USER}/actions/${encodeURIComponent(id)}/items${query({ offset: offset || undefined })}`);
/** 跨区移动（§24.5.3）：target 为卡片上选择的目标目录（相对路径）；移出私密空间还要带登录密码或通行密钥断言。 */
export type ConfirmInput = { acknowledge?: boolean; count?: number; share?: { expires_days?: number; password?: string };
  target?: string; password?: string; passkey?: { request_id: string; credential: unknown } };
export const confirmAction = (id: string, input: ConfirmInput = {}) => post<AssistantAction>(`${USER}/actions/${encodeURIComponent(id)}/confirm`, input);
export const rejectAction = (id: string) => post<AssistantAction>(`${USER}/actions/${encodeURIComponent(id)}/reject`, {});
export const cancelAction = (id: string) => post<AssistantAction>(`${USER}/actions/${encodeURIComponent(id)}/cancel`, {});
export const undoAction = (id: string) => post<AssistantAction>(`${USER}/actions/${encodeURIComponent(id)}/undo`, {});
/** 抓取脚本转交的已渲染页面快照（规范页列表），上传后随消息提交 snapshot_id。 */
export type SnapshotPage = { url: string; title?: string; images: { path: string; urls: Record<string, string>; w?: number | null; h?: number | null }[];
  links?: { path: string; href: string; text: string; rel?: string }[] };
export const uploadSnapshot = (conversationId: string, pages: SnapshotPage[]) =>
  post<{ snapshot_id: string; source: string; pages: number; images: number }>(`${USER}/conversations/${encodeURIComponent(conversationId)}/snapshots`, { pages });
export const decideScope = (actionId: string, approve: boolean) => post<{ status: string; scope: string; run_id?: string }>(`${USER}/scope-requests/${encodeURIComponent(actionId)}/${approve ? "confirm" : "reject"}`, {});

/**
 * 订阅运行事件（Server-Sent Events）。断线后按最后收到的 seq 续读；收到 run_finished 后关闭。
 * 返回取消函数。
 */
export function subscribeRun(runId: string, onEvent: (event: RunEvent) => void, onReconnecting?: (value: boolean) => void): () => void {
  let after = 0, closed = false, source: EventSource | null = null, timer = 0, retries = 0;
  const open = () => {
    if (closed) return;
    source = new EventSource(`${USER}/runs/${encodeURIComponent(runId)}/events?after=${after}`);
    source.onmessage = message => {
      retries = 0;
      onReconnecting?.(false);
      let event: RunEvent;
      try { event = JSON.parse(message.data) as RunEvent; } catch { return; }
      if (typeof event.seq === "number" && event.seq <= after && event.type !== "run_finished") return;
      if (typeof event.seq === "number") after = Math.max(after, event.seq);
      onEvent(event);
      if (event.type === "run_finished") stop();
    };
    source.onerror = () => {
      source?.close();
      if (closed) return;
      retries += 1;
      // 会话失效、运行不存在等非网络错误会一直失败：重试几次后放弃，交给调用方重新加载对话。
      if (retries > 6) { stop(); onReconnecting?.(false); onEvent({ seq: after, type: "stream_failed" }); return; }
      onReconnecting?.(true);
      timer = window.setTimeout(open, Math.min(8000, 500 * 2 ** Math.min(retries, 4)));
    };
  };
  const stop = () => { closed = true; source?.close(); window.clearTimeout(timer); };
  open();
  return stop;
}
