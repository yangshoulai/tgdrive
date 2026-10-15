/** 文件助手的接口：用户端 /api/user/v1/assistant 与管理端 /api/admin/v1/assistant（docs/assistant-design.md §13）。 */
import { apiGet as get, apiPost as post } from "./api";

export type ToolSupport = "unknown" | "yes" | "no";
export type AiModel = {
  id: number; channel_id: number; model: string; display_name: string | null; label: string; source: "auto" | "manual";
  enabled: boolean; tools: ToolSupport; context_window: number | null; max_output: number | null; removed_upstream: boolean;
  sort: number; tested_at: number | null; test_note: string | null; channel_name?: string;
};
export type ChannelHealth = { requests: number; success_rate: number | null; p95_ms: number | null; last_error: string | null; unhealthy: boolean };
export type AiChannel = {
  id: number; name: string; kind: "openai" | "anthropic"; base_url: string; api_key: string | null; header_names: string[];
  enabled: boolean; concurrency: number; timeout: number; synced_at: number | null; sync_note: string | null; last_error: string | null;
  models: number; enabled_models: number; created_at: number; updated_at: number; health?: ChannelHealth | null;
  sync?: { total: number; added: number; removed: number; note: string }; sync_error?: string;
};
export type ChannelInput = { name?: string; kind?: AiChannel["kind"]; base_url?: string; api_key?: string | null; headers?: Record<string, string>; enabled?: boolean; concurrency?: number; timeout?: number };
export type ToolLevel = "read" | "write" | "danger" | "scope" | "meta";
export type ToolParam = { name: string; label: string; default: number; min: number; max: number; value: number };
export type AdminTool = {
  name: string; label: string; group: string; group_label: string; level: ToolLevel; description: string; fixed: boolean;
  enabled: boolean; default_enabled: boolean; depends: string[]; warning: string | null; params: ToolParam[];
};
export type Bound = { default: number; min: number; max: number; label?: string };
export type AssistantSettings = {
  enabled: boolean; default_model: number | null; user_daily_tokens: number; retention_days: number; call_log_days: number;
  notice: string; notice_default: string; bounds: Record<string, Bound>;
};
export type AssistantLimits = { values: Record<string, number>; bounds: Record<string, Bound & { label: string }> };
export type UsagePoint = { day: string; model_id: number; input_tokens: number; output_tokens: number; runs: number };
export type AssistantOverview = {
  enabled: boolean; default_model: AiModel | null; usable_models: number; channels: number;
  tools: { enabled: number; total: number };
  today: { conversations: number; requests: number; tokens: number; failure_rate: number | null; pending_actions: number; executed_actions: number };
  usage: UsagePoint[]; models: Record<string, string>;
  health: (ChannelHealth & { id: number; name: string; enabled: boolean })[];
  storage: Record<string, number>;
};
export type UserPolicy = {
  enabled: boolean | null; max_level: "read" | "write" | "danger" | null; daily_tokens: number | null;
  effective: { enabled: boolean; max_level: "read" | "write" | "danger"; daily_tokens: number };
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
export const addAdminModel = (channelId: number, input: { model: string; display_name?: string | null; context_window?: number | null }) => post<AiModel>(`${ADMIN}/channels/${channelId}/models`, input);
export const updateAdminModel = (id: number, input: Partial<Pick<AiModel, "display_name" | "enabled" | "tools" | "context_window" | "max_output" | "sort">>) => post<AiModel>(`${ADMIN}/models/${id}/update`, input);
export const deleteAdminModel = (id: number) => post<void>(`${ADMIN}/models/${id}/delete`);
export const testAdminModel = (id: number) => post<{ ok: boolean; tools: ToolSupport; note: string; duration_ms: number }>(`${ADMIN}/models/${id}/test`, undefined, 150000);
export const adminPolicy = (userId: number) => get<UserPolicy>(`${ADMIN}/users/${userId}/policy`);
export const updateAdminPolicy = (userId: number, input: Partial<Pick<UserPolicy, "enabled" | "max_level" | "daily_tokens">>) => post<UserPolicy>(`${ADMIN}/users/${userId}/policy`, input);
export const adminConversations = (cursor: string | null, filters: { user_id?: number; model_id?: number; since?: number; until?: number; action?: string }) =>
  get<{ conversations: AdminConversation[]; next_cursor: string | null }>(`${ADMIN}/conversations${query({ cursor, ...filters })}`);
export const adminConversation = (id: string) => get<AdminConversationDetail>(`${ADMIN}/conversations/${encodeURIComponent(id)}`);
export const deleteAdminConversations = (input: { user_id?: number; before?: number; dry_run?: boolean }) => post<{ count?: number; deleted?: number }>(`${ADMIN}/conversations/delete`, input);
export const adminCalls = (cursor: number | null, filters: CallFilters) => get<{ calls: AssistantCall[]; next_cursor: number | null }>(`${ADMIN}/calls${query({ cursor, ...filters })}`);
export const adminCallStats = (filters: CallFilters) => get<CallStats>(`${ADMIN}/calls/stats${query({ ...filters })}`);
export const purgeAssistantData = () => post<void>(`${ADMIN}/purge`, { confirm: "清除" });

/* ---------- 用户端 ---------- */

export type UserTool = { name: string; label: string; group: string; group_label: string; level: ToolLevel; description: string; available: boolean; reason: string | null; warning: string | null };
export type AssistantConfig = {
  available: boolean; reason: string | null; models: AiModel[]; default_model: number | null; tools: UserTool[];
  max_level: "read" | "write" | "danger"; usage: { today: number; limit: number | null }; notice: string; notice_ack: boolean; retention_days: number;
};
export type Conversation = { id: string; title: string | null; scope: string; model_id: number | null; archived: boolean; messages: number; created_at: number; updated_at: number; active_run?: string | null };
export type ToolEvent =
  | { type: "plan"; items: { content: string; status: "pending" | "in_progress" | "completed" }[] }
  | { type: "question"; question: string; options: string[] }
  | { type: "scope_request"; action_id: string; from: string; to: string; reason: string };
export type ChatMessage = {
  seq: number; run_id: string | null; role: "user" | "assistant" | "tool" | "event"; tool_name?: string | null; created_at?: number;
  text?: string; scope?: string; location?: string;
  tool_calls?: { id: string; name: string; arguments: string }[]; model_id?: number; input_tokens?: number; output_tokens?: number;
  call_id?: string; name?: string; label?: string; arguments?: Record<string, unknown>; status?: "ok" | "error"; summary?: string;
  result?: unknown; items?: number | null; duration_ms?: number; truncated?: boolean; event?: ToolEvent | null;
  type?: string; retry?: boolean; action_id?: string;
};
export type AssistantAction = { id: string; kind: string; tool_name: string | null; status: "pending" | "confirmed" | "rejected" | "expired" | "done" | "failed"; count: number; payload: { from?: string; to?: string; reason?: string } | null; created_at: number; expires_at: number; decided_at: number | null };
export type ConversationDetail = { conversation: Conversation; messages: ChatMessage[]; actions: AssistantAction[]; active_run: string | null };
export type RunEvent = { seq: number; type: string; [key: string]: unknown };

const USER = "/api/user/v1/assistant";
export const assistantConfig = (signal?: AbortSignal) => get<AssistantConfig>(`${USER}/config`, signal);
export const acknowledgeNotice = () => post<void>(`${USER}/notice/ack`, {});
export const conversations = (cursor?: string | null) => get<{ conversations: Conversation[]; next_cursor: string | null }>(`${USER}/conversations${query({ cursor })}`);
export const createConversation = (location: string, modelId?: number | null) => post<ConversationDetail>(`${USER}/conversations`, { location, model_id: modelId ?? undefined });
export const conversation = (id: string) => get<ConversationDetail>(`${USER}/conversations/${encodeURIComponent(id)}`);
export const updateConversation = (id: string, input: { title?: string; archived?: boolean }) => post<Conversation>(`${USER}/conversations/${encodeURIComponent(id)}/update`, input);
export const deleteConversation = (id: string) => post<void>(`${USER}/conversations/${encodeURIComponent(id)}/delete`, {});
export const sendMessage = (id: string, input: { text: string; model_id?: number; location: string; view: string; scope?: "conversation" | "location" | "root" }) =>
  post<{ run_id: string; message_seq: number }>(`${USER}/conversations/${encodeURIComponent(id)}/messages`, input);
export const stopRun = (runId: string) => post<void>(`${USER}/runs/${encodeURIComponent(runId)}/stop`, {});
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
