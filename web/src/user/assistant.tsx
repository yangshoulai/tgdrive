/**
 * 文件助手抽屉（docs/assistant-design.md §12.2）。挂在 MainShell：切换页面、打开预览时对话不中断。
 * 运行在服务端进行，这里通过 SSE 订阅事件；断线后按 seq 续读。写入类操作的确认卡片由服务端数据渲染。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type DragEvent as ReactDragEvent } from "react";
import * as api from "../api";
import * as ai from "../assistant-api";
import { AssistantMark, Badge, Button, ConfirmDialog, EmptyState, Icon, IconButton, Menu, Modal, Segmented, SkeletonRows, formatBytes, isShortcutControl, shortcutLabel, toast, type IconName, type MenuItem } from "../ui";
import { ShortcutsDialog } from "../shortcuts";
import type { PageImport } from "./page-import";
import { Thread, PlanBar, latestPlan, useMarkState, type HttpApproval, type LiveRun } from "./assistant-thread";
import { ReviewQueue, type ReviewRequest } from "./assistant-review";
import { AttachmentTray, useAttachments } from "./assistant-attachments";
import { filesBridge, getPrivateSection, openPrivateSection, waitForFiles } from "./assistant-bridge";
import { usePrivateAccess } from "./private-session";
import { assistantEnvironment } from "./assistant-environment";
import { commonFolder, useMentions } from "./assistant-mentions";
import { AssistantComposer, type ComposerHandle } from "./assistant-composer";
import { FolderPicker } from "./folders";
import { useCacheQueue } from "./cache";
import { cacheStats, cacheSupported, type CacheFile } from "../cache-client";

/** 作用域选择「当前位置」：随文件页切换目录。 */
const HERE = "\u0000here";
const WIDTH_KEY = "tessera-assistant-width";
const MIN_WIDTH = 480, MAX_WIDTH = 720;
const boundWidth = (value: number, maximum = MAX_WIDTH) => Math.max(MIN_WIDTH, Math.min(maximum, value));
const display = (key: string) => "/" + key;
const DRAFT_LIMIT = 8000;

/** 刷新最新一页时保留用户已经向前加载的记录，最新页中的消息以服务器为准。 */
function refreshDetail(current: ai.ConversationDetail | null, fresh: ai.ConversationDetail): ai.ConversationDetail {
  if (!current || current.conversation.id !== fresh.conversation.id) return fresh;
  const first = fresh.messages[0]?.seq ?? 0;
  const earlier = current.messages.filter(message => message.seq < first);
  return earlier.length ? { ...fresh, messages: [...earlier, ...fresh.messages], before_seq: current.before_seq } : fresh;
}

export type AssistantLocation = { view: string; prefix: string };

/** 读取助手是否可用；不可用时不显示入口。 */
export function useAssistantConfig(enabled: boolean) {
  const [config, setConfig] = useState<ai.AssistantConfig | null>(null);
  const refresh = useCallback(() => {
    if (!enabled) { setConfig(null); return; }
    void ai.assistantConfig().then(setConfig).catch(() => setConfig(null));
  }, [enabled]);
  useEffect(refresh, [refresh]);
  return { config, refresh };
}

type DrawerProps = Parameters<typeof AssistantDrawer>[0];

/**
 * 抽屉的宿主（§24.8）：在私密空间页面、私密空间已解锁且账号可以使用私密对话时显示私密对话抽屉，
 * 其他页面显示普通对话。普通抽屉一直挂着（切回时对话还在）；私密抽屉离开私密空间或锁定即卸载，
 * 私密对话保留在服务器内存里，回到私密空间时重新打开。锁定时收起抽屉，不把普通对话顶上来。
 */
export function AssistantDock(props: DrawerProps) {
  const privateView = props.location.view === "private" && Boolean(props.config.private_available);
  const { grant } = usePrivateAccess();
  const access = privateView ? grant?.access ?? "" : "";
  const [privateConfig, setPrivateConfig] = useState<{ access: string; config: ai.AssistantConfig | null } | null>(null);
  const refresh = useCallback(() => {
    if (!access) { setPrivateConfig(null); return; }
    void ai.assistantConfig(undefined, true).then(config => setPrivateConfig({ access, config }))
      .catch(() => setPrivateConfig({ access, config: null }));
  }, [access]);
  useEffect(refresh, [refresh]);
  const current = privateConfig?.access === access ? privateConfig : null;
  const loading = Boolean(access) && !current;
  const config = current?.config?.available ? current.config : null;
  const { onClose, open } = props;
  const shown = useRef(false);
  useEffect(() => {
    if (config) { shown.current = true; return; }
    if (!shown.current || access) return;
    shown.current = false;
    // 在私密空间页面锁定（手动或闲置）：收起抽屉；离开私密空间页面则直接切回普通对话。
    if (privateView && open) onClose();
  }, [Boolean(config), access]);
  return <>
    <AssistantDrawer {...props} open={props.open && !config && !loading} />
    {config && <AssistantDrawer key={access} open={props.open} config={config} location={props.location} onClose={props.onClose}
      onConfigChanged={() => { refresh(); props.onConfigChanged(); }}
      onFilesChanged={props.onFilesChanged} onNavigate={props.onNavigate} privateMode />}
  </>;
}

export function AssistantLauncher({ onOpen, open }: { onOpen: () => void; open: boolean }) {
  return (
    <button type="button" className={`assistant-launch${open ? " is-active" : ""}`} onClick={onOpen} data-closes-nav aria-expanded={open} aria-label="文件助手" title={`文件助手（${shortcutLabel("Mod+J")}）`} aria-keyshortcuts="Meta+J Control+J">
      <AssistantMark size={18} /><span>文件助手</span><kbd>{shortcutLabel("Mod+J")}</kbd>
    </button>
  );
}

export type AssistantNavigate = (view: "files" | "trash" | "downloads" | "shared" | "private", prefix?: string) => void;
const FULL_ACK_KEY = "tessera-assistant-full-ack-v2";
const EMPTY_LIVE: LiveRun = { reasoning: "", reasoningStartedAt: null, streaming: "", tools: [], phase: "thinking" };

export function AssistantDrawer({ open, config, location, onClose, onConfigChanged, mode = "drawer", initialConversation, onOpenPage,
  onConversationChange, onFilesChanged, pageImport, onPageImportDone, onNavigate, privateMode = false }: {
  open: boolean; config: ai.AssistantConfig; location: AssistantLocation; onClose: () => void; onConfigChanged: () => void;
  /** drawer：右侧抽屉；page：全页（左侧对话列表常驻，消息流居中）。 */
  mode?: "drawer" | "page"; initialConversation?: string | null; onOpenPage?: (conversationId: string | null) => void;
  onConversationChange?: (conversationId: string | null) => void; onFilesChanged?: () => void;
  /** 抓取脚本转交的页面快照：用户点击发送时随消息上传。 */
  pageImport?: PageImport | null; onPageImportDone?: () => void;
  /** 浏览器工具 ui_navigate 等：在 Tessera 中打开页面。全页模式不提供（会离开对话页）。 */
  onNavigate?: AssistantNavigate;
  /** 私密对话（§24）：作用域固定为私密空间，对话只在服务器内存中，没有历史、附件与全页模式。 */
  privateMode?: boolean;
}) {
  const page = mode === "page";
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? boundWidth(saved) : MIN_WIDTH;
  });
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const resize = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  const maxWidth = boundWidth(viewportWidth - 32);
  const actualWidth = Math.min(width, maxWidth);
  useEffect(() => {
    const sync = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  const [history, setHistory] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [httpApprovals, setHttpApprovals] = useState<HttpApproval[]>([]);
  const httpResolvers = useRef(new Map<string, { resolve: (decision: ai.HttpDecision | null) => void; expires: number }>());
  const browserCalls = useRef(new Map<string, AbortController>());
  const cancelBrowserCalls = useCallback(() => { for (const controller of browserCalls.current.values()) controller.abort(); }, []);
  useEffect(() => { if (!open) cancelBrowserCalls(); return cancelBrowserCalls; }, [open, cancelBrowserCalls]);
  const decideHttp = useCallback((callId: string, decision: ai.HttpDecision) => {
    const waiter = httpResolvers.current.get(callId);
    if (!waiter) return;
    const status = decision === "approved" && waiter.expires <= Date.now() ? "expired" : decision;
    httpResolvers.current.delete(callId);
    setHttpApprovals(items => items.map(item => item.callId === callId ? { ...item, status } : item));
    waiter.resolve(status);
  }, []);
  const [archived, setArchived] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [conversations, setConversations] = useState<ai.Conversation[] | null>(null);
  const [detail, setDetail] = useState<ai.ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [earlierBusy, setEarlierBusy] = useState(false);
  const earlierRequest = useRef<string | null>(null);
  const [draft, setDraft] = useState("");
  const [modelId, setModelId] = useState<number | null>(null);
  // 用户为下一条消息选定的作用域目录（对象键，"" 为全部普通文件）；null 表示沿用对话作用域，HERE 表示跟随文件页的当前位置。
  const [scopeTarget, setScopeTarget] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<{ seq: number; later: number } | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  useEffect(() => {
    const pending = httpApprovals.filter(item => item.status === "pending");
    for (const item of pending) if (!open || item.runId !== runId) decideHttp(item.callId, "cancelled");
    if (!pending.length) return;
    const timer = window.setTimeout(() => {
      for (const item of pending) if (item.expires <= Date.now()) decideHttp(item.callId, "expired");
    }, Math.max(0, Math.min(...pending.map(item => item.expires)) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [open, runId, httpApprovals, decideHttp]);
  useEffect(() => () => { for (const waiter of httpResolvers.current.values()) waiter.resolve("cancelled"); httpResolvers.current.clear(); }, []);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [pendingMode, setPendingMode] = useState<ai.AccessMode>("approval");
  const [fullPrompt, setFullPrompt] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [sending, setSending] = useState(false);
  const [revising, setRevising] = useState(false);
  const [revisionPrompt, setRevisionPrompt] = useState<{ conversation: string; version: number; text: string } | null>(null);
  const [capabilities, setCapabilities] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const attachments = useAttachments();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const filePicker = useRef<HTMLInputElement>(null);
  const [unseen, setUnseen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<ComposerHandle>(null);
  const drawer = useRef<HTMLElement>(null);
  // 手机上 iOS 弹出键盘时 100dvh 不会变小，按可视区域高度收缩抽屉，输入框不被键盘挡住。
  useEffect(() => {
    const viewport = window.visualViewport, node = drawer.current;
    if (!open || !viewport || !node) return;
    const sync = () => node.style.setProperty("--assistant-viewport", `${Math.round(viewport.height)}px`);
    sync();
    viewport.addEventListener("resize", sync);
    return () => { viewport.removeEventListener("resize", sync); node.style.removeProperty("--assistant-viewport"); };
  }, [open]);
  const unsubscribe = useRef<(() => void) | null>(null);
  const selection = useRef(0);
  const currentId = detail?.conversation.id ?? null;
  const locationKey = location.view === "files" || privateMode && location.view === "private" ? location.prefix : privateMode ? api.PRIVATE_PREFIX : "";
  const headerMark = useMarkState(runId ? live ?? EMPTY_LIVE : null);
  const chosenScope = scopeTarget === HERE ? locationKey : scopeTarget;
  const mention = useMentions({ draft, location: locationKey, root: privateMode ? api.PRIVATE_PREFIX : "", enabled: config.notice_ack && !(config.usage.limit && config.usage.today >= config.usage.limit),
    onPick: (from, path) => input.current?.insertMention(from, path) });

  useEffect(() => {
    if (!config.models.some(model => model.id === modelId)) {
      setModelId([detail?.conversation.model_id, config.default_model, config.models[0]?.id].find(id => config.models.some(model => model.id === id)) ?? null);
    }
  }, [config, detail?.conversation.model_id, modelId]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      if (!document.querySelector(".modal-backdrop:not(.is-minimized), .menu")) input.current?.focus();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [open, currentId]);
  // 抽屉占用的右侧宽度（含 16px 边距）写到根元素上，上传／下载托盘与最小化预览据此居中在剩余区域，不被抽屉挡住。
  useEffect(() => {
    if (page || !open) return;
    const root = document.documentElement;
    root.style.setProperty("--assistant-occupied", `${viewportWidth > 760 ? actualWidth + 32 : 0}px`);
    return () => { root.style.removeProperty("--assistant-occupied"); };
  }, [page, open, actualWidth, viewportWidth]);
  useEffect(() => () => unsubscribe.current?.(), []);
  // 普通与私密抽屉可能同时挂着：只由打开的那个设置，关闭时移除。
  useEffect(() => {
    if (page || !open) return;
    const root = document.documentElement;
    root.classList.add("assistant-open");
    return () => root.classList.remove("assistant-open");
  }, [open, page]);
  // 全页地址随当前对话更新；初始对话还没加载出来时不要把地址改成「新对话」。
  const reported = useRef(!initialConversation);
  useEffect(() => {
    if (currentId) reported.current = true;
    if (reported.current) onConversationChange?.(currentId);
  }, [currentId]);
  useEffect(() => { if (initialConversation && initialConversation !== currentId) void openConversation(initialConversation); }, [initialConversation]);
  // 抓取脚本转交的页面快照到达：开一个新对话，预填输入，由用户确认后发送。
  const importedPages = pageImport?.pages ?? null;
  useEffect(() => {
    if (!importedPages) return;
    newConversation();
    setDraft(location.view === "files" && location.prefix ? `把这个页面里的图片保存到 ${display(location.prefix)}` : "把这个页面里的图片保存到当前目录");
  }, [importedPages]);

  const loadConversations = useCallback(() => {
    setConversations(null);
    void ai.conversations(null, archived, privateMode).then(result => { setConversations(result.conversations); setHistoryCursor(result.next_cursor); })
      .catch(reason => { setConversations([]); toast.error(api.errorMessage(reason, "对话列表加载失败，请稍后重试")); });
  }, [archived, privateMode]);
  useEffect(() => { if (open) loadConversations(); }, [open, loadConversations]);
  // 私密对话每个登录会话最多一个：回到私密空间时直接接上还在内存里的那个。
  const resumed = useRef(false);
  useEffect(() => {
    if (!privateMode || resumed.current || !conversations) return;
    resumed.current = true;
    if (conversations[0] && !detail) void openConversation(conversations[0].id);
  }, [privateMode, conversations]);
  async function moreConversations() {
    if (!historyCursor || historyBusy) return;
    setHistoryBusy(true);
    try {
      const result = await ai.conversations(historyCursor, archived);
      setConversations(current => [...(current ?? []), ...result.conversations.filter(item => !current?.some(old => old.id === item.id))]);
      setHistoryCursor(result.next_cursor);
    } catch (reason) { toast.error(api.errorMessage(reason, "加载失败，请稍后重试")); }
    finally { setHistoryBusy(false); }
  }
  // 桌面允许继续操作文件；窄屏抽屉占满视口时约束焦点，关闭后回到入口。
  useEffect(() => {
    if (!open || page) return;
    const previous = document.activeElement as HTMLElement | null;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !window.matchMedia("(max-width: 760px)").matches || document.querySelector(".menu, .modal-backdrop")) return;
      const nodes = Array.from(drawer.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), [contenteditable="true"], select:not(:disabled), a[href], [tabindex="0"]') ?? [])
        .filter(node => node.getClientRects().length > 0);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && (document.activeElement === first || !drawer.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !drawer.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => { document.removeEventListener("keydown", trap); previous?.isConnected && previous.focus({ preventScroll: true }); };
  }, [open, page]);

  const scrollToEnd = useCallback((force = false) => {
    const node = scroller.current;
    if (!node) return;
    if (force || atBottomRef.current) { node.scrollTop = node.scrollHeight; setUnseen(false); }
    else setUnseen(true);
  }, []);
  const atBottomRef = useRef(true);
  atBottomRef.current = atBottom;
  // 决定后结果行和确认区会改变高度；只为原本跟随底部的阅读位置补齐滚动。
  const reviewState = `${detail?.actions.map(action => `${action.id}:${action.status}`).join(",") ?? ""}|${httpApprovals.map(item => `${item.callId}:${item.status}`).join(",")}`;
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { if (atBottomRef.current) scrollToEnd(); });
    return () => window.cancelAnimationFrame(frame);
  }, [reviewState, scrollToEnd]);

  // 浏览器工具：在当前页面执行后回传结果。只执行仍在有效期内、尚未处理的调用（断线重放时不重复操作页面）。
  const handledCalls = useRef(new Set<string>());
  const cacheQueue = useCacheQueue();
  const clientContext = useRef({ location, onNavigate, page, privateMode, cacheQueue, open });
  clientContext.current = { location, onNavigate, page, privateMode, cacheQueue, open };
  const runClientCall = useCallback(async (runId: string, event: ai.RunEvent) => {
    const callId = String(event.call_id ?? "");
    const handledKey = `${runId}:${callId}`;
    if (!callId || handledCalls.current.has(handledKey) || Number(event.expires_at ?? 0) * 1000 < Date.now()) return;
    handledCalls.current.add(handledKey);
    const controller = event.name === "http_request_approval" ? null : new AbortController();
    if (controller) browserCalls.current.set(handledKey, controller);
    const timer = controller ? window.setTimeout(() => controller.abort(), Math.max(0, Number(event.expires_at) * 1000 - Date.now())) : undefined;
    let outcome: { result?: Record<string, unknown>; error?: string };
    try {
      if (!clientContext.current.open) throw new Error("对话已关闭，未执行页面操作");
      if (event.name === "http_request_approval") {
        const decision = await new Promise<ai.HttpDecision | null>(resolve => {
          const expires = Number(event.expires_at) * 1000;
          httpResolvers.current.set(handledKey, { resolve, expires });
          setHttpApprovals(items => [...items, { callId: handledKey, toolCallId: String(event.tool_call_id ?? callId), runId, expires, requestedAt: Number(event.requested_at) || Date.now() / 1000,
            request: event.args as ai.HttpRequestPreview, status: "pending" }]);
          window.requestAnimationFrame(() => scrollToEnd());
        });
        if (decision === null) return; // 断线重放时结果可能紧接确认事件到达，不再回传旧决定。
        outcome = { result: { approved: decision === "approved", decision } };
      } else outcome = { result: await executeClientTool(String(event.name), (event.args ?? {}) as Record<string, unknown>, clientContext.current, controller?.signal) };
    }
    catch (reason) { outcome = { error: reason instanceof Error ? reason.message : "页面操作失败" }; }
    finally { window.clearTimeout(timer); browserCalls.current.delete(handledKey); }
    if (controller?.signal.aborted) return;
    await ai.sendClientResult(runId, callId, outcome).catch(() => {
      setHttpApprovals(items => items.map(item => item.callId === handledKey ? { ...item, status: "error" } : item));
    });
  }, [scrollToEnd]);

  const follow = useCallback((id: string) => {
    unsubscribe.current?.();
    const version = selection.current;
    setReconnecting(false);
    setRunId(id); setLive({ ...EMPTY_LIVE });
    unsubscribe.current = ai.subscribeRun(id, event => {
      if (version !== selection.current) return;
      switch (event.type) {
        case "queued": setLive(value => ({ ...(value ?? EMPTY_LIVE), phase: "queued", queue: Number(event.position) })); break;
        case "run_started": case "thinking": case "stream_reset":
          setLive(value => ({ ...EMPTY_LIVE, tools: value?.tools ?? [] })); break;
        case "reasoning_delta":
          setLive(value => { const current = value ?? EMPTY_LIVE; return { ...current, phase: "thinking", reasoning: current.reasoning + String(event.text ?? ""), reasoningStartedAt: current.reasoningStartedAt ?? Date.now() }; });
          window.requestAnimationFrame(() => scrollToEnd()); break;
        case "text_delta":
          setLive(value => { const current = value ?? EMPTY_LIVE; return { ...current, phase: "writing", streaming: current.streaming + String(event.text ?? "") }; });
          window.requestAnimationFrame(() => scrollToEnd()); break;
        case "tool_started":
          setLive(value => { const current = value ?? EMPTY_LIVE; return { ...current, phase: "tool", tools: [...current.tools, { callId: String(event.call_id), name: String(event.name), label: String(event.label ?? event.name) }] }; });
          window.requestAnimationFrame(() => scrollToEnd()); break;
        case "client_call": void runClientCall(id, event); break;
        case "message": {
          const message = event.message as ai.ChatMessage;
          // 落库的消息到达后，去掉对应的实时内容（思考与文字随助手消息，工具随工具消息）。
          if (message.role === "assistant") setLive(value => value && { ...value, reasoning: "", reasoningStartedAt: null, streaming: "" });
          if (message.role === "tool") setLive(value => value && { ...value, tools: value.tools.filter(tool => tool.callId !== message.call_id) });
          if (message.event?.type === "http_request") {
            const reviewId = `${id}:${message.event.id}`;
            httpResolvers.current.get(reviewId)?.resolve(null);
            httpResolvers.current.delete(reviewId);
            setHttpApprovals(items => items.filter(item => item.callId !== reviewId));
          }
          setDetail(current => current && !current.messages.some(item => item.seq === message.seq)
            ? { ...current, messages: [...current.messages, message] } : current);
          const actionEvent = message.event;
          if (actionEvent?.type === "action" || actionEvent?.type === "scope_request") {
            void ai.action(actionEvent.action_id).then(action => {
              if (version !== selection.current) return;
              setDetail(current => current && { ...current, actions: [...current.actions.filter(item => item.id !== action.id), action] });
            }).catch(() => undefined);
          }
          if (message.event?.type !== "plan") window.requestAnimationFrame(() => scrollToEnd());
          break;
        }
        case "resync":
          setLive(value => value && { ...value, streaming: "", reasoning: "" });
          setDetail(current => { if (current) void ai.conversation(current.conversation.id).then(fresh => { if (version === selection.current) setDetail(value => refreshDetail(value, fresh)); }).catch(() => undefined); return current; });
          break;
        case "title": setDetail(current => current && { ...current, conversation: { ...current.conversation, title: String(event.title) } }); loadConversations(); break;
        case "context": setDetail(current => current && { ...current, context: { used: Number(event.used) || 0, window: Number(event.window) || 32000 } }); break;
        case "run_finished": case "stream_failed":
          cancelBrowserCalls();
          setRunId(null); setLive(null); unsubscribe.current = null;
          onConfigChanged();
          setDetail(current => { if (current) void ai.conversation(current.conversation.id).then(fresh => setDetail(value => value?.conversation.id === fresh.conversation.id ? refreshDetail(value, fresh) : value)).catch(() => undefined); return current; });
          break;
      }
    }, value => { if (version === selection.current) setReconnecting(value); });
  }, [onConfigChanged, loadConversations, scrollToEnd, runClientCall, cancelBrowserCalls]);

  async function openConversation(id: string) {
    const version = ++selection.current;
    cancelBrowserCalls();
    for (const callId of httpResolvers.current.keys()) decideHttp(callId, "cancelled");
    setHttpApprovals([]);
    unsubscribe.current?.(); unsubscribe.current = null;
    setRunId(null); setLive(null); setHistory(false); setReconnecting(false); setLoading(true); setScopeTarget(null); mention.reset();
    try {
      const value = await ai.conversation(id);
      if (version !== selection.current) return;
      setDetail(value); setModelId(value.conversation.model_id);
      if (value.active_run) follow(value.active_run);
      window.requestAnimationFrame(() => scrollToEnd(true));
    } catch (reason) { toast.error(api.errorMessage(reason, "对话加载失败，请稍后重试")); }
    finally { if (version === selection.current) setLoading(false); }
  }

  async function loadEarlier() {
    if (!detail?.before_seq || earlierRequest.current) return;
    const id = detail.conversation.id, version = selection.current;
    earlierRequest.current = id; setEarlierBusy(true);
    try {
      const older = await ai.conversation(id, detail.before_seq);
      if (version !== selection.current) return;
      const node = scroller.current, height = node?.scrollHeight ?? 0, top = node?.scrollTop ?? 0;
      atBottomRef.current = false; setAtBottom(false);
      setDetail(current => {
        if (current?.conversation.id !== id) return current;
        const known = new Set(current.messages.map(message => message.seq));
        const messages = [...older.messages.filter(message => !known.has(message.seq)), ...current.messages].sort((a, b) => a.seq - b.seq);
        return { ...current, messages, before_seq: older.before_seq };
      });
      window.requestAnimationFrame(() => { if (node && version === selection.current) node.scrollTop = top + node.scrollHeight - height; });
    } catch (reason) { if (version === selection.current) toast.error(api.errorMessage(reason, "更早的消息加载失败，请稍后重试")); }
    finally { earlierRequest.current = null; setEarlierBusy(false); }
  }

  // 关闭抽屉即放弃输入框里尚未发送的附件（§22.5）：附件只属于发出的消息，不留下没有对话的附件。
  useEffect(() => { if (!open) attachments.clear(true); }, [open]);

  function newConversation() {
    selection.current += 1;
    cancelBrowserCalls();
    for (const callId of httpResolvers.current.keys()) decideHttp(callId, "cancelled");
    setHttpApprovals([]);
    setLoading(false); setReconnecting(false);
    unsubscribe.current?.(); unsubscribe.current = null;
    setDetail(null); setRunId(null); setLive(null); setHistory(false); setScopeTarget(null); mention.reset(); setDraft(""); setPendingMode("approval"); attachments.clear(true);
    window.setTimeout(() => input.current?.focus(), 30);
  }

  async function send(text = draft) {
    // 附件只随输入框里的消息发送（不随卡片上的快捷回答）；只有附件没有文字时补一句说明。
    const withFiles = text === draft && attachments.items.length > 0;
    const message = text.trim() || (withFiles ? "请查看这些附件" : "");
    if (!message || runId || sending || revising) return;
    if (withFiles && attachments.pending) { toast.error("附件还在上传或生成预览图，请稍候"); return; }
    if (withFiles && attachments.failed) { toast.error("有附件上传失败，请重试或移除后再发送"); return; }
    if (pageImport && !pageImport.pages) { toast.error(pageImport.error || "页面快照还在接收，请稍候"); return; }
    if (!config.notice_ack) return;
    setSending(true);
    const version = selection.current;
    try {
      // 引用超出作用域时，扩大到作用域与所有引用的公共上级目录（界面已提示，属于用户发送的操作）。
      const mentions = text === draft ? mention.mentions.map(item => item.key) : [];
      const baseScope = chosenScope ?? (detail ? detail.conversation.scope.replace(/^\//, "") : locationKey);
      const target = mentions.some(key => !key.startsWith(baseScope)) ? commonFolder([baseScope || "/", ...mentions].filter(key => key !== "/")) : chosenScope;
      let current = detail;
      if (!current) {
        current = await ai.createConversation(privateMode ? locationKey : target ?? locationKey, modelId, config.full_access ? pendingMode : "approval", privateMode);
        if (version !== selection.current) return;
        setDetail(current);
        loadConversations();
      }
      let snapshotId: string | undefined;
      if (importedPages && text === draft) {
        snapshotId = (await ai.uploadSnapshot(current.conversation.id, importedPages)).snapshot_id;
      }
      const result = await ai.sendMessage(current.conversation.id, { text: message, model_id: modelId ?? undefined, location: locationKey, view: location.view,
        ...(current === detail && target !== null && !privateMode ? { scope: "path" as const, scope_path: display(target) } : {}),
        mentions: mentions.length ? mentions.map(display) : undefined, attachments: withFiles ? attachments.ids : undefined,
        snapshot_id: snapshotId, environment: assistantEnvironment() });
      if (version !== selection.current) return;
      if (snapshotId) onPageImportDone?.();
      // 「跟随当前位置」是持续的选择（新对话默认如此），发送后保留；其他临时选择随这条消息生效后清除。
      const following = scopeTarget === HERE || (!detail && scopeTarget === null);
      setDraft(""); setScopeTarget(following ? HERE : null); mention.reset();
      if (withFiles) attachments.clear();
      const fresh = await ai.conversation(current.conversation.id).catch(() => null);
      if (version !== selection.current) return;
      if (fresh) setDetail(value => refreshDetail(value, fresh));
      follow(result.run_id);
      window.requestAnimationFrame(() => scrollToEnd(true));
    } catch (reason) { toast.error(api.errorMessage(reason, "发送失败，请稍后重试")); }
    finally { setSending(false); }
  }

  async function stop() {
    if (!runId) return;
    cancelBrowserCalls();
    try { await ai.stopRun(runId); } catch (reason) { toast.error(api.errorMessage(reason, "停止失败，请稍后重试")); }
  }

  async function reviseRequest(request: ReviewRequest, text: string) {
    if (!detail || sending || revising || revisionPrompt) throw new Error("请等待当前请求处理完成");
    const conversation = detail.conversation.id, version = selection.current;
    const title = request.kind === "http" ? `${request.approval.request.method} ${request.approval.request.url}`
      : request.kind === "question" ? request.question : request.action.payload?.title ?? "当前操作";
    const prompt = `调整刚才的请求：\n${title}\n\n暂不执行原方案。\n${text}`;
    // 决定或停止失败时，文字仍在输入框中，用户可以继续编辑和重试。
    setDraft(prompt);
    setRevising(true);
    try {
      let active = runId;
      if (request.kind === "action") await ai.rejectAction(request.id);
      else if (request.kind === "scope") {
        const result = await ai.decideScope(request.id, false);
        if (result.run_id) {
          active = result.run_id;
          if (version === selection.current) follow(result.run_id);
        }
      }
      if (active) await ai.stopRun(active);
      if (request.kind === "http") decideHttp(request.id, "rejected");
      if (version !== selection.current) return;
      setRevisionPrompt({ conversation, version, text: prompt });
      reloadDetail();
    } finally {
      setRevising(false);
    }
  }

  // 等待旧运行结束后再发送补充，避免仍在执行的工具或迟到的 SSE 覆盖新运行。
  useEffect(() => {
    if (!revisionPrompt) return;
    if (!open || revisionPrompt.version !== selection.current || revisionPrompt.conversation !== currentId) { setRevisionPrompt(null); return; }
    if (runId || sending || revising) return;
    const text = revisionPrompt.text;
    setRevisionPrompt(null);
    void send(text);
  }, [revisionPrompt, runId, sending, revising, currentId, open]);

  /** 从某条用户消息重新回答：之后还有其他轮次时先确认，因为它们会被丢弃。 */
  function retryFrom(seq: number) {
    if (!detail || runId || sending) return;
    const later = detail.messages.filter(message => message.role === "user" && message.seq > seq).length;
    if (later) setRetrying({ seq, later }); else void retry(seq);
  }
  async function retry(seq: number) {
    if (!detail || runId || sending) return;
    setSending(true);
    const version = ++selection.current, id = detail.conversation.id;
    try {
      const result = await ai.retryMessage(id, { seq, model_id: modelId ?? undefined, location: locationKey, view: location.view, environment: assistantEnvironment() });
      if (version !== selection.current) return;
      const fresh = await ai.conversation(id).catch(() => null);
      if (version !== selection.current) return;
      if (fresh) setDetail(fresh);
      follow(result.run_id);
      window.requestAnimationFrame(() => scrollToEnd(true));
    } catch (reason) { toast.error(api.errorMessage(reason, "重新生成失败，请稍后重试")); }
    finally { setSending(false); }
  }

  async function decideScope(actionId: string, approve: boolean) {
    try {
      const result = await ai.decideScope(actionId, approve);
      const fresh = await ai.conversation(detail!.conversation.id);
      setDetail(value => value?.conversation.id === fresh.conversation.id ? refreshDetail(value, fresh) : value);
      if (result.run_id) follow(result.run_id);
    } catch (reason) { toast.error(api.errorMessage(reason, "操作没有完成，请稍后重试")); }
  }

  async function acknowledge() {
    try { await ai.acknowledgeNotice(privateMode); onConfigChanged(); }
    catch (reason) { toast.error(api.errorMessage(reason, "操作没有完成，请稍后重试")); }
  }

  // 访问模式：新对话先记在本地，创建时提交；已有对话立即保存。切换到完全访问前确认一次说明。
  const accessMode: ai.AccessMode = detail ? detail.conversation.access_mode : pendingMode;
  async function chooseMode(next: ai.AccessMode, confirmed = false) {
    if (next === accessMode) return;
    if (next === "full" && !confirmed && localStorage.getItem(FULL_ACK_KEY) !== "1") { setFullPrompt(true); return; }
    if (!detail) { setPendingMode(next); return; }
    try {
      await ai.updateConversation(detail.conversation.id, { access_mode: next });
      const fresh = await ai.conversation(detail.conversation.id);
      setDetail(value => value?.conversation.id === fresh.conversation.id ? refreshDetail(value, fresh) : value);
      window.requestAnimationFrame(() => scrollToEnd(true));
    } catch (reason) { toast.error(api.errorMessage(reason, "切换模型失败，请稍后重试")); }
  }

  const reloadDetail = useCallback(() => {
    setDetail(current => { if (current) void ai.conversation(current.conversation.id).then(fresh => setDetail(value => value?.conversation.id === fresh.conversation.id ? refreshDetail(value, fresh) : value)).catch(() => undefined); return current; });
  }, []);

  // 键盘：Esc 运行中先停止，空闲时关闭。全页模式只停止运行，不关闭。
  function escape() { if (runId) void stop(); else if (!page) onClose(); }
  function focusArea(event: ReactPointerEvent<HTMLElement>) {
    const target = event.target as Element;
    if (!event.currentTarget.contains(target) || isShortcutControl(target) || target.closest("button, a, summary, [role='button'], [role='separator']")) return;
    // 点击消息或标题后让快捷键仍归助手处理，同时保留原生选中文字。
    event.currentTarget.focus({ preventScroll: true });
  }
  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    const target = event.target as Element;
    if (open && !event.defaultPrevented && !event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !isShortcutControl(target)
      && !document.querySelector(".modal-backdrop:not(.is-minimized), .menu") && (event.key === "?" || !event.shiftKey && ["/", "h"].includes(event.key.toLowerCase()))) {
      event.preventDefault(); event.stopPropagation();
      if (event.repeat) return;
      if (event.key === "?") setShortcutsOpen(true);
      else if (event.key === "/") { setHistory(false); window.setTimeout(() => input.current?.focus(), 0); }
      else if (!privateMode) {
        const side = page ? event.currentTarget.querySelector<HTMLElement>(".assistant-page-side") : null;
        if (side && getComputedStyle(side).display !== "none") side.querySelector<HTMLElement>("input, button, [tabindex='0']")?.focus();
        else { setHistory(value => !value); if (!history) loadConversations(); }
      }
      return;
    }
    if (!page || event.key !== "Escape" || event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || !runId) return;
    if (document.querySelector(".modal-backdrop:not(.is-minimized), .menu")) return;
    event.preventDefault();
    escape();
  }
  const escapeRef = useRef(escape);
  escapeRef.current = escape;
  // 抽屉打开时 Esc 优先交给抽屉：在 window 捕获阶段处理，先于文件页（清除选择）、预览窗口与其他弹窗的 Esc。
  // 只在这些情况下让行：焦点在某个弹窗或菜单里（由它自己关闭）、抽屉自己打开的对话框还在、@ 候选列表打开（先关闭候选）、输入法组字中。
  const mentionOpen = useRef(false);
  mentionOpen.current = mention.open;
  useEffect(() => {
    if (!open || page) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat) return;
      const target = event.target as Element | null;
      if (target?.closest?.(".menu, .modal-backdrop:not(.is-minimized) .modal")) return;
      if (document.querySelector(".menu, .modal-backdrop:not(.is-minimized) .assistant-dialog") || mentionOpen.current) return;
      event.preventDefault(); event.stopPropagation();
      const planToggle = target?.closest?.(".assistant-plan-bar")?.querySelector<HTMLButtonElement>('.assistant-plan-trigger[aria-expanded="true"]');
      if (planToggle) { planToggle.click(); planToggle.focus({ preventScroll: true }); return; }
      escapeRef.current();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, page]);
  // ⌘/Ctrl+Shift+O 新对话（输入控件中也生效，因为带修饰键）。
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && !event.isComposing && (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
        if (document.querySelector(".modal-backdrop:not(.is-minimized), .menu")) return;
        event.preventDefault();
        if (!event.repeat) newConversation();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: actualWidth, width: actualWidth };
    setResizing(true);
  }
  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    const current = resize.current;
    if (!current || event.pointerId !== current.pointerId) return;
    current.width = boundWidth(current.startWidth + current.startX - event.clientX, boundWidth(window.innerWidth - 32));
    setWidth(current.width);
  }
  function saveWidth(value: number) {
    const next = boundWidth(value, boundWidth(window.innerWidth - 32));
    setWidth(next); localStorage.setItem(WIDTH_KEY, String(next));
  }
  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    const current = resize.current;
    if (!current || event.pointerId !== current.pointerId) return;
    resize.current = null;
    setResizing(false);
    saveWidth(current.width);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  const conversationScope = detail?.conversation.scope ?? display(locationKey);
  const currentLocation = display(locationKey);
  const effectiveScope = chosenScope !== null ? display(chosenScope) : conversationScope;
  const scopeKey = effectiveScope.replace(/^\//, "");
  const outside = mention.mentions.filter(item => !item.key.startsWith(scopeKey));
  // 私密对话的作用域固定为私密空间，引用不会超出。
  const expandedScope = outside.length && !privateMode ? display(commonFolder([scopeKey, ...mention.mentions.map(item => item.key)].filter(Boolean))) : null;
  const usage = config.usage;
  const usageRatio = usage.limit ? usage.today / usage.limit : 0;
  const context = detail?.context ?? null;
  const selectedModel = config.models.find(model => model.id === modelId);
  const contextWindow = selectedModel ? selectedModel.context_window || 32000 : context?.window || 32000;
  const contextRatio = context ? context.used / Math.max(1, contextWindow) : 0;
  const exhausted = Boolean(usage.limit && usage.today >= usage.limit);

  const canSee = selectedModel?.capabilities?.vision === true;
  // 私密空间不对助手开放，也不在那里添加附件（附件保存在普通文件区域）。
  const canAttach = config.notice_ack && !exhausted && location.view !== "private" && !privateMode;
  const addFiles = (files: File[], pasted = false) => { if (!canAttach || !files.length) return false; attachments.add(files, pasted); return true; };
  const hasFiles = (event: ReactDragEvent) => [...event.dataTransfer.types].includes("Files");
  const dropProps = {
    onDragEnter: (event: ReactDragEvent) => { if (!canAttach || !hasFiles(event)) return; event.preventDefault(); dragDepth.current++; setDragging(true); },
    onDragOver: (event: ReactDragEvent) => { if (!canAttach || !hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; },
    onDragLeave: () => { if (dragDepth.current > 0 && --dragDepth.current === 0) setDragging(false); },
    onDrop: (event: ReactDragEvent) => { if (!canAttach || !hasFiles(event)) return; event.preventDefault(); dragDepth.current = 0; setDragging(false);
      addFiles([...event.dataTransfer.files]); input.current?.focus(); },
  };
  const dropOverlay = dragging && <div className="assistant-drop" aria-hidden="true"><span><Icon name="paperclip" size={22} />松开以添加为附件</span></div>;
  const modelLabel = (id: number | null | undefined) => config.models.find(model => model.id === id)?.label ?? "文件助手";
  const historyList = <ConversationList archived={archived} onArchiveView={setArchived} more={historyCursor !== null} loadingMore={historyBusy} onMore={() => void moreConversations()} items={conversations} current={currentId} onOpen={id => void openConversation(id)} onChanged={(deleted) => {
    loadConversations(); if (deleted && deleted === currentId) newConversation(); else reloadDetail();
  }} />;
  const header = <header className="assistant-header">
    {!privateMode && <IconButton className={page ? "assistant-mobile-history" : undefined} icon="list" label="对话历史" shortcut="H" active={history} onClick={() => { setHistory(value => !value); if (!history) loadConversations(); }} />}
    <span className={`assistant-brand-mark${runId ? " is-working" : ""}`} aria-hidden="true"><AssistantMark size={24} state={headerMark} /></span>
    {privateMode ? <div className="assistant-title"><strong><span className="assistant-private-tag"><Icon name="lock" size={11} />私密</span>{detail?.conversation.title || "私密对话"}</strong>
      <small>{accessMode === "full" && <span className="assistant-full-tag"><Icon name="zap" size={11} />完全访问</span>}{selectedModel?.label ?? "未选择模型"} · 锁定后对话会被清除</small></div>
    : <div className="assistant-title"><strong>{detail?.conversation.title || "文件助手"}</strong>
      <small>{accessMode === "full" && <span className="assistant-full-tag"><Icon name="zap" size={11} />完全访问</span>}{detail ? conversationScope : "查找、整理，让文件井井有条"}</small></div>}
    <IconButton icon="plus" label={privateMode ? "新的私密对话（当前对话会被清除）" : "新对话"} shortcut="Mod+Shift+O" onClick={newConversation} />
    <IconButton icon="keyboard" label="键盘快捷键" shortcut="?" onClick={() => setShortcutsOpen(true)} />
    {!page && onOpenPage && !privateMode && <IconButton icon="maximize" label="在全页打开" onClick={() => onOpenPage(currentId)} />}
    {!page && <IconButton icon="x" label="关闭" shortcut="Mod+J" onClick={onClose} />}
  </header>;
  const plan = detail && !loading && config.notice_ack ? latestPlan(detail.messages) : null;
  const body = <>
    {plan && <PlanBar key={`${currentId}:${plan.id ?? "legacy"}`} plan={plan} running={Boolean(runId)}
      onContinue={() => void send("继续当前计划，从尚未完成的步骤继续，先核对已有结果，避免重复执行。")} />}
    <div className="assistant-scroll-area"><div className="assistant-thread" ref={scroller} role="log" aria-live="polite" aria-relevant="additions"
      onScroll={event => { const node = event.currentTarget; const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40; setAtBottom(bottom); if (bottom) setUnseen(false); }}>
      <div className="assistant-thread-inner">
        {config.notice_ack && !loading && detail?.before_seq && <Button variant="ghost" loading={earlierBusy} onClick={() => void loadEarlier()}>加载更早消息</Button>}
        {!config.notice_ack ? <NoticeCard notice={config.notice} retention={config.retention_days} privateMode={privateMode} onAccept={() => void acknowledge()} />
          : loading ? <SkeletonRows rows={4} />
          : !detail ? <Welcome location={effectiveScope} view={location.view} privateMode={privateMode} onPick={text => { setDraft(text); input.current?.focus(); }} />
          : <Thread detail={detail} live={live} liveModel={selectedModel?.label} modelLabel={modelLabel} runId={runId} httpApprovals={httpApprovals} onHttpDecision={decideHttp}
              onAnswer={text => void send(text)} onScope={(id, approve) => void decideScope(id, approve)}
              onRetry={retryFrom} onActionChanged={reloadDetail} onFilesChanged={onFilesChanged} />}
        {reconnecting && <p className="ai-notice" role="status"><Icon name="refresh" size={14} /><span>重新连接中…</span></p>}
      </div>
    </div>
    {unseen && <button type="button" className="assistant-unseen" onClick={() => scrollToEnd(true)}><Icon name="chevronDown" size={14} />有新消息</button>}</div>
    <div className="assistant-composer">
      {detail && !loading && config.notice_ack && <ReviewQueue key={currentId} detail={detail} httpApprovals={httpApprovals} runId={runId}
        onHttpDecision={decideHttp} onAnswer={send} onFeedback={reviseRequest} onScope={(id, approve) => void decideScope(id, approve)}
        onActionChanged={reloadDetail} onFilesChanged={onFilesChanged} />}
      {pageImport && <SnapshotChip value={pageImport} onRemove={() => onPageImportDone?.()} />}
      {mention.menu}
      <div className={`assistant-compose-box${runId ? " is-running" : ""}`}>
        <div className="assistant-context-row">
          {privateMode ? <span className="assistant-scope is-private" title="私密对话只处理私密空间里的文件，不能访问普通文件">
            <span className="assistant-scope-trigger"><Icon name="lock" size={14} /><span className="assistant-scope-label">私密空间</span></span></span>
          : <ScopeChip scope={effectiveScope} conversationScope={detail ? conversationScope : null} location={currentLocation}
            privateView={location.view === "private"} changed={scopeTarget !== null} following={scopeTarget === HERE || (!detail && scopeTarget === null)} onChoose={setScopeTarget} />}
          <ModeChip mode={accessMode} allowed={config.full_access} onChoose={next => void chooseMode(next)} />
        </div>
        {expandedScope && <p className="assistant-mention-hint"><Icon name="info" size={12} />引用的文件不在 {effectiveScope} 内，发送后助手可访问的范围会扩大到 {expandedScope}</p>}
        <AttachmentTray attachments={attachments} canSee={canSee} />
        {/* 输入框即时渲染 Markdown、@ 引用胶囊、链接与列表；内容仍是 Markdown 纯文本。 */}
        <AssistantComposer ref={input} value={draft} onChange={setDraft} onSubmit={() => void send()} maxLength={DRAFT_LIMIT}
          placeholder={!config.notice_ack ? "请先阅读上方说明" : exhausted ? "今日额度已用完，明天 0 点后重置" : privateMode ? "在私密空间里想找什么，或想怎样整理？输入 @ 引用文件，支持 Markdown" : "想找什么，或想怎样整理？输入 @ 引用文件，支持 Markdown"}
          disabled={!config.notice_ack || exhausted || revising || Boolean(revisionPrompt)} mentions={mention.known.map(item => display(item.key))}
          onToken={mention.setToken} onKey={mention.onKey} onPasteFiles={files => addFiles(files, true)} />
        <div className="assistant-controls">
          <Menu label="选择模型" align="start" className="assistant-model" items={config.models.map(model => ({ label: model.label,
            description: [model.channel_name ?? "模型渠道", model.capabilities?.reasoning ? "推理" : "", model.capabilities?.vision ? "识图" : "",
              model.context_window ? `${Math.round(model.context_window / 1000)}K 上下文` : "", model.id === config.default_model ? "默认" : ""].filter(Boolean).join(" · "),
            icon: model.capabilities?.reasoning ? "brain" : "server", checked: model.id === modelId,
            onSelect: () => setModelId(model.id) }))}>
            <Icon name={selectedModel?.capabilities?.reasoning ? "brain" : "server"} size={14} /><span>{selectedModel?.label ?? "选择模型"}</span><Icon name="chevronDown" size={12} />
          </Menu>
          <button type="button" className="assistant-capability-button" onClick={() => setCapabilities(true)} title="查看助手能力"><Icon name="sparkle" size={14} /><span>能力</span></button>
          {canAttach && <button type="button" className="assistant-attach-button" onClick={() => filePicker.current?.click()} aria-label="添加附件"
            title={`添加附件（也可以粘贴或拖入），随对话保存${canSee ? "；图片会发给模型识别" : ""}`}><Icon name="paperclip" size={15} /></button>}
          <input ref={filePicker} type="file" multiple hidden onChange={event => { addFiles([...(event.target.files ?? [])]); event.target.value = ""; input.current?.focus(); }} />
          <span className="assistant-enter-hint">@ 引用 · Enter 发送 · Shift+Enter 换行</span>
          {runId ? <button type="button" className="assistant-send is-stop" aria-label="停止" aria-keyshortcuts="Escape" title="停止（Esc）" onClick={() => void stop()}><Icon name="stop" size={16} /></button>
            : <button type="button" className="assistant-send" aria-label="发送" aria-keyshortcuts="Enter Meta+Enter Control+Enter" disabled={(!draft.trim() && !attachments.items.length) || attachments.pending || sending || revising || Boolean(revisionPrompt) || !config.notice_ack || exhausted || Boolean(pageImport && !pageImport.pages)}
              title={attachments.pending ? "附件处理中" : `发送（Enter 或 ${shortcutLabel("Mod+Enter")}）`} onClick={() => void send()}>
              {sending ? <span className="spinner" aria-hidden="true" /> : <Icon name="arrowUp" size={18} />}</button>}
        </div>
      </div>
      <div className={`assistant-footnote${usageRatio >= 0.8 ? " tone-warning" : ""}`}>
        <span className="assistant-footnote-meters">
          <span title={usage.limit ? `今日所有模型请求累计 ${usage.today.toLocaleString("zh-CN")} / ${usage.limit.toLocaleString("zh-CN")} token，明天 0 点恢复；与模型上下文容量独立。` : "今日累计 token 不限额；每轮累计预算由管理员单独配置。"}>{usage.limit ? `今日额度 ${Math.min(100, Math.round(usageRatio * 100))}%` : "今日不限额"}</span>
          {context && <span className={contextRatio >= 0.8 ? "tone-warning" : undefined}
            title={`最近一次请求约 ${context.used.toLocaleString("zh-CN")} / ${contextWindow.toLocaleString("zh-CN")} token（所选模型）。包含提示词、工具和历史内容，接近上限时自动压缩历史；与每日额度、每轮累计预算独立。`}>
            模型上下文 {Math.min(100, Math.round(contextRatio * 100))}%{contextRatio >= 0.8 ? " · 接近容量上限" : ""}</span>}
        </span>
        <span>{accessMode === "full" ? <><Icon name="zap" size={11} />普通修改自动执行，结果记入对话</> : <><Icon name="shield" size={11} />修改文件前会请你确认</>}</span>
      </div>
    </div>
  </>;
  const dialogs = <>
    {capabilities && <CapabilitiesDialog config={config} privateMode={privateMode} onClose={() => setCapabilities(false)} onPick={text => { setCapabilities(false); setDraft(text); input.current?.focus(); }} />}
    {retrying && <ConfirmDialog className="assistant-dialog" title="从这条消息重新回答？" confirmLabel="重新回答"
      description={`之后的 ${retrying.later} 轮对话会从记录中删除，无法恢复；其中已经执行的文件操作不会撤销，待确认的操作会失效。`}
      onClose={() => setRetrying(null)} onConfirm={() => { const seq = retrying.seq; setRetrying(null); void retry(seq); }} />}
    {fullPrompt && <Modal className="assistant-dialog" title="切换到完全访问？" icon="zap" onClose={() => setFullPrompt(false)}
      footer={<><Button onClick={() => setFullPrompt(false)}>取消</Button><Button variant="primary" onClick={() => { localStorage.setItem(FULL_ACK_KEY, "1"); setFullPrompt(false); void chooseMode("full", true); }}>切换</Button></>}>
      <ul className="assistant-mode-points">
        <li><Icon name="zap" size={15} /><span><strong>常规操作自动执行</strong>改名、移动、整理、移入回收站、下载任务与常规 HTTP 请求不再逐项询问，读取文件或网页后仍保持此模式。</span></li>
        <li><Icon name="checkCircle" size={15} /><span><strong>保留执行结果</strong>操作结果记录在对话中，可查看明细；需要调整时请告诉助手，重新生成方案。第三方 HTTP 请求的结果以接口为准。</span></li>
        <li><Icon name="shield" size={15} /><span><strong>这些仍需你确认</strong>彻底删除、公开分享、跨私密空间移动和 HTTP DELETE；打开新标签、下载到本机和复制仍可能需要浏览器要求的点击。</span></li>
      </ul>
    </Modal>}
  </>;

  if (page) return (
    <section className="assistant-page" aria-label="文件助手" tabIndex={-1} onPointerDown={focusArea} onKeyDown={onKeyDown} {...dropProps}>
      <aside className="assistant-page-side" aria-label="对话列表">
        <div className="assistant-page-side-head"><strong>对话</strong><Button size="sm" icon="plus" shortcut="Mod+Shift+O" onClick={newConversation}>新对话</Button></div>
        {historyList}
      </aside>
      <div className="assistant-page-main">{header}{history ? historyList : body}{dropOverlay}</div>
      {dialogs}
      {shortcutsOpen && <ShortcutsDialog area="assistant" privateSpace={privateMode} onClose={() => setShortcutsOpen(false)} />}
    </section>
  );
  return (
    <aside ref={drawer} className={`assistant-drawer${open ? " is-open" : ""}${privateMode ? " is-private" : ""}${resizing ? " is-resizing" : ""}`} style={{ "--assistant-width": `${actualWidth}px` } as CSSProperties}
      aria-label={privateMode ? "文件助手（私密对话）" : "文件助手"} aria-hidden={!open} tabIndex={-1} onPointerDown={focusArea} onKeyDown={onKeyDown} {...dropProps} {...(!open ? { inert: "" } as object : {})}>
      <div className="assistant-resize" onPointerDown={startResize} onPointerMove={moveResize}
        onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={finishResize} onDoubleClick={() => saveWidth(MIN_WIDTH)}
        role="separator" tabIndex={open ? 0 : -1} aria-label="调整助手宽度" aria-orientation="vertical"
        title={`左右拖动调整宽度（${MIN_WIDTH}–${maxWidth} 像素），双击还原`}
        aria-valuemin={MIN_WIDTH} aria-valuemax={maxWidth} aria-valuenow={actualWidth} aria-valuetext={`${actualWidth} 像素`}
        onKeyDown={event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault();
          saveWidth(event.key === "Home" ? MIN_WIDTH : event.key === "End" ? maxWidth : actualWidth + (event.key === "ArrowLeft" ? 20 : -20)); }} />
      {header}
      {history ? historyList : body}
      {dropOverlay}
      {dialogs}
      {shortcutsOpen && <ShortcutsDialog area="assistant" privateSpace={privateMode} onClose={() => setShortcutsOpen(false)} />}
    </aside>
  );
}

/** 在用户当前页面执行浏览器工具（docs/assistant-design.md §19.7）。参数已经过服务端校验，这里只做页面操作。 */
export async function executeClientTool(name: string, args: Record<string, unknown>,
  context: { location: AssistantLocation; onNavigate?: AssistantNavigate; page: boolean; privateMode: boolean; cacheQueue: ReturnType<typeof useCacheQueue>; open: boolean }, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!context.open) throw new Error("对话已关闭，未执行页面操作");
  signal?.throwIfAborted();
  const { location, onNavigate, page } = context;
  if (name === "ui_cache_status") return cacheStatus(args, context.cacheQueue);
  if (["ui_cache_files", "ui_clear_cache", "ui_generate_thumbnails"].includes(name)) {
    signal?.throwIfAborted();
    const items = (Array.isArray(args.items) ? args.items : []) as { path: string; etag: string; size: number; content_type: string | null }[];
    if (Boolean(args.private) !== context.privateMode || items.some(item => api.isPrivatePath(item.path) !== context.privateMode)) throw new Error("文件不属于当前对话的文件区域");
    if (name === "ui_generate_thumbnails") {
      let ok = 0, failed = 0, note = "";
      for (const item of items) {
        if (signal?.aborted) break;
        try { await api.generateThumbnail({ key: item.path, etag: item.etag }); ok++; }
        catch (reason) { failed++; note = api.errorMessage(reason, "缩略图提交失败"); }
      }
      if (ok) for (const delay of [5000, 30000, 120000]) window.setTimeout(() => window.dispatchEvent(new CustomEvent("tessera:files-added", { detail: { folders: [...new Set(items.map(item => item.path.slice(0, item.path.lastIndexOf("/") + 1)))] } })), delay);
      return { ok, failed, note: note || "已提交服务器生成，生成结果以文件缩略图为准" };
    }
    const queue = context.cacheQueue;
    if (!cacheSupported() || !queue?.available) throw new Error("这台设备不能使用本机缓存，请在设置中启用");
    const files = items.map(item => ({ key: item.path, etag: item.etag, size: item.size, content_type: item.content_type }));
    const usable = files.filter(queue.canCache);
    if (name === "ui_cache_files") queue.enqueueMany(usable);
    else await queue.forget(usable);
    return { ok: usable.length, skipped: files.length - usable.length, note: name === "ui_cache_files" ? "已加入缓存队列，进度见本机缓存托盘" : "只清除此设备的副本，云端文件不受影响" };
  }
  if (context.privateMode) return executePrivateTool(name, args, location, onNavigate);
  const bridge = filesBridge();
  if (name === "ui_get_view") {
    if (location.view === "private") return { view: "private" };
    if (location.view !== "files" || !bridge) return { view: page ? "assistant" : location.view };
    return { view: "files", path: "/" + bridge.prefix, selected: bridge.selected().map(key => "/" + key),
      visible: bridge.visible().map(item => ({ path: "/" + item.key, ...(item.size !== undefined ? { size: item.size } : {}) })), total: bridge.total() };
  }
  if (page || !onNavigate) throw new Error("当前在助手全页，无法操作文件页；请在文件页打开助手抽屉后再试");
  const open = async (folder: string) => {
    if (location.view !== "files" || bridge?.prefix !== folder) onNavigate("files", folder);
    const ready = await waitForFiles(folder);
    if (!ready) throw new Error("目录没有在页面上打开");
    return ready;
  };
  if (name === "ui_navigate") {
    const view = String(args.view ?? "files") as Parameters<AssistantNavigate>[0];
    onNavigate(view, view === "files" ? String(args.path ?? "") : "");
    return { ok: true };
  }
  if (name === "ui_select") {
    const target = await open(String(args.folder ?? ""));
    const keys = (args.paths as string[] | undefined) ?? [];
    const count = target.select(keys);
    return { selected: count, missing: keys.length - count };
  }
  if (name === "ui_preview") {
    const key = String(args.path ?? "");
    const folder = key.includes("/") ? key.slice(0, key.lastIndexOf("/") + 1) : "";
    const target = await open(folder);
    if (!target.preview(key)) throw new Error("当前页没有找到这个文件（可能在其他分页）");
    return { ok: true };
  }
  throw new Error("这个浏览器工具不受支持");
}

/** 本机缓存查询（§26）：只回答服务端发来的文件；缓存索引在这台设备的浏览器里，服务端看不到。 */
async function cacheStatus(args: Record<string, unknown>, queue: ReturnType<typeof useCacheQueue>): Promise<Record<string, unknown>> {
  if (!cacheSupported()) return { available: false, reason: "这个浏览器不能使用本机缓存：需要通过 https:// 地址访问并使用较新的浏览器，无痕模式下不可用" };
  if (!queue?.available) return { available: false, reason: "这台设备的本机缓存已关闭（可在「设置 → 本机缓存」开启），或管理员不允许使用" };
  const stats = await cacheStats();
  const items = (Array.isArray(args.items) ? args.items : []) as (CacheFile & { path: string })[];
  const files = items.map(item => ({ key: item.path, etag: item.etag, size: item.size, content_type: item.content_type }));
  const reports = files.length ? await queue.report(files) : [];
  const blocked = reports.find(report => report.blocked)?.blocked;
  return { available: true,
    device: { normal_bytes: stats.normal.bytes, normal_limit_bytes: stats.settings.maxMiB * 1048576, private_bytes: stats.private.bytes,
      private_enabled: Boolean(stats.settings.private && stats.policy?.private_enabled) },
    items: files.map((file, index) => ({ path: file.key, state: reports[index].state, ...(reports[index].percent !== undefined ? { percent: reports[index].percent } : {}) })),
    ...(blocked ? { private_note: blocked } : {}) };
}

/** 私密对话的浏览器工具（§24.5.4）：只读取和操作私密空间页面；路径是带私密前缀的对象键，服务端会再次校验。 */
async function executePrivateTool(name: string, args: Record<string, unknown>, location: AssistantLocation, onNavigate?: AssistantNavigate): Promise<Record<string, unknown>> {
  const inPrivate = location.view === "private";
  const privateBridge = () => { const bridge = filesBridge(); return bridge && api.isPrivatePath(bridge.prefix) ? bridge : null; };
  if (name === "ui_get_view") {
    if (!inPrivate) return { view: location.view };
    const section = getPrivateSection(), bridge = privateBridge();
    if (section === "trash" || !bridge) return { view: "private", section };
    return { view: "private", section: "files", path: bridge.prefix, selected: bridge.selected(),
      visible: bridge.visible().map(item => ({ path: item.key, ...(item.size !== undefined ? { size: item.size } : {}) })), total: bridge.total() };
  }
  if (!onNavigate) throw new Error("当前页面无法执行这个操作");
  const open = async (folder: string) => {
    const bridge = privateBridge();
    if (!inPrivate || getPrivateSection() !== "files" || bridge?.prefix !== folder) { onNavigate("private", folder); openPrivateSection("files"); }
    const ready = await waitForFiles(folder);
    if (!ready) throw new Error("目录没有在页面上打开");
    return ready;
  };
  if (name === "ui_navigate") {
    const view = String(args.view ?? "files");
    // 旧运行重连后也可能重放下载页导航，必须在页面侧再次拒绝，避免卸载私密抽屉形成跳转循环。
    if (view !== "files" && view !== "trash") throw new Error("私密对话保持在私密空间中，请通过侧栏手动打开下载任务；助手可直接查询下载进度");
    if (!inPrivate || view === "files") onNavigate("private", view === "files" ? String(args.path ?? api.PRIVATE_PREFIX) : api.PRIVATE_PREFIX);
    openPrivateSection(view === "trash" ? "trash" : "files");
    return { ok: true };
  }
  if (name === "ui_select") {
    const target = await open(String(args.folder ?? api.PRIVATE_PREFIX));
    const keys = (args.paths as string[] | undefined) ?? [];
    const count = target.select(keys);
    return { selected: count, missing: keys.length - count };
  }
  if (name === "ui_preview") {
    const key = String(args.path ?? "");
    const target = await open(key.slice(0, key.lastIndexOf("/") + 1) || api.PRIVATE_PREFIX);
    if (!target.preview(key)) throw new Error("当前页没有找到这个文件");
    return { ok: true };
  }
  throw new Error("这个浏览器工具不受支持");
}

function SnapshotChip({ value, onRemove }: { value: PageImport; onRemove: () => void }) {
  const host = value.request.origin.replace(/^https?:\/\//, "");
  return <div className={`assistant-attachment${value.error ? " is-error" : ""}`} role="status">
    <Icon name={value.error ? "alert" : value.pages ? "globe" : "download"} size={16} />
    <span className="name-stack"><strong>{value.error ? "页面快照接收失败" : value.pages ? `来自 ${host} 的页面快照` : `正在接收 ${host} 的页面快照…`}</strong>
      <small>{value.error || (value.pages ? `${value.pages.length} 页 · ${value.images.toLocaleString("zh-CN")} 个图片候选 · 发送消息时一起提交` : "请保持来源页面打开")}</small></span>
    <IconButton icon="x" label="移除快照" size="sm" onClick={onRemove} />
  </div>;
}

function groupModels(models: ai.AiModel[]) {
  const groups = new Map<string, ai.AiModel[]>();
  for (const model of models) groups.set(model.channel_name ?? "模型", [...(groups.get(model.channel_name ?? "模型") ?? []), model]);
  return [...groups.entries()];
}

/* ---------- 输入区 ---------- */

function ScopeChip({ scope, conversationScope, location, privateView, changed, following, onChoose }: {
  scope: string; conversationScope: string | null; location: string; privateView: boolean;
  /** changed：为下一条消息另选了作用域；following：作用域跟随文件页的当前位置。 */
  changed: boolean; following: boolean; onChoose: (target: string | null) => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  const key = (path: string) => path.replace(/^\//, "");
  const differs = conversationScope !== null && conversationScope !== location && !changed;
  const items: MenuItem[] = [
    ...(conversationScope !== null ? [{ label: "助手可访问的范围", description: conversationScope, icon: "folder" as IconName, heading: "助手可以访问的范围", checked: !changed, onSelect: () => onChoose(null) }] : []),
    { label: "当前位置", description: `跟随文件页 · ${location}`, icon: "folder", heading: conversationScope === null ? "助手可以访问的范围" : undefined,
      checked: following, onSelect: () => onChoose(conversationScope === null ? null : HERE) },
    { label: "全部普通文件", description: "/ · 不包含私密空间", icon: "home", checked: scope === "/" && !following, onSelect: () => onChoose("") },
    { label: "浏览目录…", description: "在目录树中选择", icon: "move", divider: true, onSelect: () => setBrowsing(true) },
  ];
  return <span className={`assistant-scope${differs ? " has-hint" : ""}${following ? " is-following" : ""}`} title={privateView ? "私密空间不对助手开放，只能访问普通文件"
    : differs ? `当前位置 ${location} 不在这个对话的访问范围内` : following ? `跟随当前位置：助手只处理 ${scope} 内的普通文件` : `助手只处理 ${scope} 内的普通文件`}>
    <Menu label="更改访问范围" align="start" className="assistant-scope-trigger" items={items}>
      <Icon name={privateView ? "shield" : "folder"} size={14} /><span className="assistant-scope-label">{privateView ? "普通文件" : following ? "跟随" : "作用于"}</span><span className="assistant-scope-text">{scope}</span><Icon name="chevronDown" size={12} />
    </Menu>
    {browsing && <ScopeDialog initial={key(scope)} onClose={() => setBrowsing(false)} onChoose={target => { setBrowsing(false); onChoose(target === key(conversationScope ?? "") && conversationScope !== null ? null : target); }} />}
  </span>;
}

/** 目录树选择作用域：复用上传与移动的位置浏览器，私密空间与系统区域不在其中。 */
function ScopeDialog({ initial, onClose, onChoose }: { initial: string; onClose: () => void; onChoose: (target: string) => void }) {
  const [value, setValue] = useState(initial);
  const [ready, setReady] = useState(false);
  return <Modal title="选择访问范围" description="助手只会查看和整理这个目录中的普通文件。" icon="folder" onClose={onClose} className="assistant-dialog assistant-scope-dialog"
    footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!ready} onClick={() => onChoose(value)}>作用于 {display(value)}</Button></>}>
    <FolderPicker value={value} onChange={setValue} onReady={setReady} creatable={false} />
  </Modal>;
}

function ModeChip({ mode, allowed, onChoose }: { mode: ai.AccessMode; allowed: boolean; onChoose: (mode: ai.AccessMode) => void }) {
  const items: MenuItem[] = [
    { label: "审批模式", description: "每次修改都由你在卡片上确认", icon: "shield", heading: "修改文件时", checked: mode === "approval", onSelect: () => onChoose("approval") },
    { label: "完全访问", description: allowed ? "普通修改自动执行，保留结果" : "管理员未开启", icon: "zap", checked: mode === "full", disabled: !allowed,
      onSelect: () => onChoose("full") },
  ];
  return <Menu label="访问模式" align="start" className={`assistant-mode${mode === "full" ? " is-full" : ""}`} items={items}>
    <Icon name={mode === "full" ? "zap" : "shield"} size={14} /><span>{mode === "full" ? "完全访问" : "审批"}</span><Icon name="chevronDown" size={12} />
  </Menu>;
}

function CapabilitiesDialog({ config, privateMode, onClose, onPick }: { config: ai.AssistantConfig; privateMode?: boolean; onClose: () => void; onPick: (text: string) => void }) {
  const groups = new Map<string, ai.UserTool[]>();
  for (const tool of config.tools) groups.set(tool.group_label, [...(groups.get(tool.group_label) ?? []), tool]);
  const examples = privateMode ? ["统计私密空间的空间占用，按类型分组", "私密空间里最大的 10 个文件是什么？", "找出私密空间里的重复文件", "私密回收站里有什么？"]
    : ["统计当前目录的空间占用，按类型分组", "找出最大的 10 个文件", "找出重复文件，看看能省多少空间", "最近 7 天新增了哪些文件？", "回收站里有什么，什么时候会被清除？", "读一下 README.md，帮我总结要点"];
  return (
    <Modal title={privateMode ? "私密对话能做什么" : "助手能做什么"} description={`你的账号权限：${config.max_level === "read" ? "只读" : config.max_level === "danger" ? "可提议包括不可恢复的操作" : "可提议普通写入"}。修改文件的操作总是需要你确认。${privateMode ? "私密对话只处理私密空间，联网只访问你在消息里给出的链接。" : ""}`}
      icon="sparkle" className="assistant-dialog" onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
      <div className="assistant-capabilities">
        {[...groups.entries()].map(([group, tools]) => <section key={group}>
          <h3>{group}</h3>
          <ul>{tools.map(tool => <li key={tool.name} className={tool.available ? "" : "is-off"}>
            <span className="name-stack"><strong>{tool.label}</strong><small>{tool.description}{tool.note ? ` ${tool.note}` : ""}</small></span>
            {tool.available ? (tool.level === "scope" ? <Badge tone="accent">需确认</Badge> : tool.warning ? <Badge tone="warning">{tool.warning}</Badge> : null)
              : <Badge>{tool.reason}</Badge>}
          </li>)}</ul>
        </section>)}
        <section><h3>试试这样问</h3><div className="assistant-examples">{examples.map(text => <button type="button" key={text} onClick={() => onPick(text)}>{text}</button>)}</div></section>
      </div>
    </Modal>
  );
}

/* ---------- 空状态 ---------- */

function NoticeCard({ notice, retention, privateMode, onAccept }: { notice: string; retention: number; privateMode?: boolean; onAccept: () => void }) {
  return (
    <div className="assistant-notice">
      <span className="assistant-notice-icon"><Icon name={privateMode ? "lock" : "shield"} size={20} /></span>
      <h3>{privateMode ? "使用私密对话前请了解" : "使用前请了解"}</h3>
      <p>{notice}</p>
      <p className="muted">{privateMode ? "私密对话只保存在服务器内存中，不写入对话记录，也不能归档或在全页打开。"
        : `对话保留 ${retention} 天；你可以随时删除对话，删除后对你不再可见，并在保留期满后彻底清除。`}</p>
      <Button variant="primary" onClick={onAccept}>我知道了</Button>
    </div>
  );
}

/** 按所在页面给出的建议：回收站、公开分享、下载任务各有更贴切的问题，其他页面用通用的四个。 */
const PAGE_STARTERS: Record<string, { title: string; description: string; text: string; icon: IconName }[]> = {
  trash: [
    { title: "回收站里有什么", description: "按类型和大小汇总", text: "回收站里有哪些内容？按类型汇总大小", icon: "trash" },
    { title: "最占空间的", description: "找出可以彻底删除的", text: "回收站里最大的 10 个项目是什么？先不要删除", icon: "search" },
    { title: "找回文件", description: "按名称在回收站里查找", text: "我误删了一个文件，帮我在回收站里找找", icon: "refresh" },
    { title: "即将清除的", description: "看看哪些快到期了", text: "回收站里哪些项目放得最久？", icon: "chart" },
  ],
  shared: [
    { title: "检查公开内容", description: "列出所有分享与有效期", text: "列出我公开分享的全部内容，标出有效期和是否设置了密码", icon: "globe" },
    { title: "收回旧分享", description: "找出很久以前的分享", text: "哪些分享已经公开超过 30 天？先不要取消", icon: "chart" },
    { title: "无密码的分享", description: "看看哪些任何人都能打开", text: "哪些分享没有设置访问密码？", icon: "lock" },
    { title: "分享一个文件", description: "生成链接并设置有效期", text: "帮我公开分享一个文件，有效期 7 天", icon: "link" },
  ],
  downloads: [
    { title: "下载进度", description: "正在进行与排队的任务", text: "现在有哪些下载任务在进行？", icon: "download" },
    { title: "失败的任务", description: "原因与处理建议", text: "列出失败的下载任务，并说明原因", icon: "alert" },
    { title: "下载网页里的文件", description: "粘贴链接即可", text: "帮我下载这个链接里的文件：", icon: "link" },
    { title: "整理下载的文件", description: "按类型归档", text: "看看最近下载完成的文件，再帮我按类型整理", icon: "folder" },
  ],
};

function Welcome({ location, view, privateMode, onPick }: { location: string; view?: string; privateMode?: boolean; onPick: (text: string) => void }) {
  if (privateMode) return <div className="assistant-welcome is-private">
    <span className="assistant-welcome-icon"><AssistantMark size={36} /></span>
    <span className="assistant-eyebrow"><Icon name="lock" size={12} />私密对话</span>
    <h3>只在私密空间里工作。</h3>
    <p className="muted">助手只能看到私密空间，对话不保存，锁定后立即清除。<br />支持任务所需的公共网页、跨站链接和第三方接口。</p>
    <div className="assistant-starters">{[
      { title: "看懂空间", description: "用量与文件分布", text: "统计私密空间的空间占用，按类型分组", icon: "pulse" as IconName },
      { title: "找到大文件", description: "发现空间占用大户", text: "私密空间里最大的 10 个文件是什么？", icon: "search" as IconName },
      { title: "整理文件", description: "按类型自动归类", text: "先看看当前目录的文件，再帮我按类型整理", icon: "folder" as IconName },
      { title: "发现重复", description: "看看能节省多少空间", text: "找出私密空间里的重复文件，先不要修改", icon: "copy" as IconName },
    ].map(example => <button type="button" key={example.title} onClick={() => onPick(example.text)}>
      <Icon name={example.icon} size={18} /><strong>{example.title}</strong><small>{example.description}</small><Icon name="chevronRight" size={13} />
    </button>)}</div>
  </div>;
  const examples: { title: string; description: string; text: string; icon: IconName }[] = (view && PAGE_STARTERS[view]) || [
    { title: "看懂空间", description: "用量与文件分布", text: `统计 ${location} 的空间占用，按类型分组`, icon: "pulse" },
    { title: "找到大文件", description: "发现空间占用大户", text: "这里最大的 10 个文件是什么？", icon: "search" },
    { title: "整理文件", description: "按类型自动归类", text: "先看看当前目录的文件，再帮我按类型整理", icon: "folder" },
    { title: "发现重复", description: "看看能节省多少空间", text: "找出这里的重复文件，先不要修改", icon: "copy" },
  ];
  return <div className="assistant-welcome">
    <span className="assistant-welcome-icon"><AssistantMark size={36} /></span>
    <span className="assistant-eyebrow">你的文件，有了新帮手</span>
    <h3>让文件，井井有条。</h3>
    <p className="muted">查找、理解、整理，一句话就开始。<br />每一步修改，都由你来决定。</p>
    <div className="assistant-starters">{examples.map(example => <button type="button" key={example.title} onClick={() => onPick(example.text)}>
      <Icon name={example.icon} size={18} /><strong>{example.title}</strong><small>{example.description}</small><Icon name="chevronRight" size={13} />
    </button>)}</div>
    <div className="assistant-welcome-scope"><Icon name="folder" size={13} /><span>从 <code title={location}>{location}</code> 开始</span></div>
  </div>;
}

/* ---------- 对话历史 ---------- */

function ConversationList({ items, current, onOpen, onChanged, archived, onArchiveView, more, loadingMore, onMore }: {
  items: ai.Conversation[] | null; current: string | null; onOpen: (id: string) => void; onChanged: (deleted?: string) => void;
  archived: boolean; onArchiveView: (value: boolean) => void; more: boolean; loadingMore: boolean; onMore: () => void;
}) {
  const [renaming, setRenaming] = useState<ai.Conversation | null>(null);
  const [deleting, setDeleting] = useState<ai.Conversation | null>(null);
  const [title, setTitle] = useState("");
  const [search, setSearch] = useState("");
  const terms = search.trim().toLowerCase();
  const shown = (items ?? []).filter(item => !terms || (item.title || "新对话").toLowerCase().includes(terms) || item.scope.toLowerCase().includes(terms));
  const groups = groupByDate(shown);
  return <div className="assistant-history">
    <div className="assistant-history-filter">
      <label className="assistant-history-search"><Icon name="search" size={14} />
        <input type="search" placeholder="搜索对话" aria-label="搜索对话" value={search} spellCheck={false} onChange={event => setSearch(event.target.value)} /></label>
      <Segmented label="对话分类" showLabels value={archived ? "archived" : "recent"} onChange={value => onArchiveView(value === "archived")}
        options={[{ value: "recent", label: "最近" }, { value: "archived", label: "已归档" }]} />
    </div>
    {items === null ? <SkeletonRows rows={5} /> : items.length === 0 ? <EmptyState icon="list" title={archived ? "还没有归档的对话" : "还没有对话"} description="对话会保留在这里，随时可以继续。" />
      : !shown.length ? <p className="assistant-history-empty">没有标题包含“{search.trim()}”的对话</p> : null}
    {groups.map(([label, list]) => <section key={label}>
      <h4>{label}</h4>
      <ul>{list.map(item => <li key={item.id} className={`assistant-history-row${item.id === current ? " is-active" : ""}`}>
        <button type="button" className="assistant-history-item" onClick={() => onOpen(item.id)} aria-current={item.id === current ? "true" : undefined}>
          <span className="assistant-history-icon" aria-hidden="true"><Icon name={item.active_run ? "pulse" : "chat"} size={15} />{item.active_run && <i className="assistant-pulse" />}</span>
          <span className="name-stack"><strong>{item.title || "新对话"}</strong>
            <small><span className="assistant-history-scope" title={item.scope}>{item.scope === "/" ? "全部文件" : item.scope.replace(/^\/|\/$/g, "")}</span><span>{relativeTime(item.updated_at)}</span><span>{item.messages} 条消息</span></small></span>
        </button>
        <Menu label={`${item.title || "对话"} 的操作`} items={[
          { label: "重命名", icon: "edit", onSelect: () => { setRenaming(item); setTitle(item.title ?? ""); } },
          { label: archived ? "移回最近对话" : "归档", icon: "archive", onSelect: () => void ai.updateConversation(item.id, { archived: !archived }).then(() => { toast.success(archived ? "已移回最近对话" : "已归档"); onChanged(); }).catch(reason => toast.error(api.errorMessage(reason, "操作没有完成，请稍后重试"))) },
          { label: "删除", icon: "trash", danger: true, divider: true, onSelect: () => setDeleting(item) },
        ]} />
      </li>)}</ul>
    </section>)}
    {more && <Button size="sm" variant="ghost" className="assistant-history-more" loading={loadingMore} onClick={onMore}>加载更多对话</Button>}
    {deleting && <DeleteConversationDialog item={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); onChanged(deleting.id); }} />}
    {renaming && <Modal className="assistant-dialog" title="重命名对话" size="sm" onClose={() => setRenaming(null)}
      footer={<><Button onClick={() => setRenaming(null)}>取消</Button><Button variant="primary" type="submit" form="rename-conversation">保存</Button></>}>
      <form id="rename-conversation" className="form" onSubmit={event => {
        event.preventDefault();
        if (!title.trim()) return;
        void ai.updateConversation(renaming.id, { title: title.trim() }).then(() => { setRenaming(null); onChanged(); }).catch(reason => toast.error(api.errorMessage(reason, "保存失败，请稍后重试")));
      }}><input className="input" value={title} maxLength={60} onChange={event => setTitle(event.target.value)} autoFocus aria-label="对话标题" /></form>
    </Modal>}
  </div>;
}

/** 删除对话会同时删除它的附件（附件属于对话），确认框写明数量与大小。 */
function DeleteConversationDialog({ item, onClose, onDeleted }: { item: ai.Conversation; onClose: () => void; onDeleted: () => void }) {
  const [files, setFiles] = useState<{ count: number; size: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void ai.attachmentStats().then(stats => {
      const found = stats.conversations.find(entry => entry.conversation_id === item.id);
      if (alive) setFiles({ count: found?.count ?? 0, size: found?.size ?? 0 });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [item.id]);
  return <ConfirmDialog className="assistant-dialog" title="删除这个对话？" confirmLabel="删除"
    description={<>「{item.title || "新对话"}」删除后不再可见。{files?.count
      ? <>其中的 <strong>{files.count} 个附件（{formatBytes(files.size)}）</strong>会一起删除并释放空间；需要保留的附件请先在消息里「保存到我的文件」。</> : null}</>}
    onClose={onClose}
    onConfirm={async () => {
      try { await ai.deleteConversation(item.id); toast.success("对话已删除"); onDeleted(); }
      catch (reason) { toast.error(api.errorMessage(reason, "删除失败，请稍后重试")); }
    }} />;
}

/** 对话列表里的更新时间：刚刚、N 分钟前、N 小时前、昨天、N 天前，再早显示日期。 */
function relativeTime(seconds: number) {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  const date = new Date(seconds * 1000), today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86400000);
  if (days === 0) return `${Math.floor(diff / 3600)} 小时前`;
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function groupByDate(items: ai.Conversation[]): [string, ai.Conversation[]][] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  const groups: Record<string, ai.Conversation[]> = { 今天: [], "7 天内": [], 更早: [] };
  for (const item of items) groups[item.updated_at >= today ? "今天" : item.updated_at >= today - 6 * 86400 ? "7 天内" : "更早"].push(item);
  return Object.entries(groups).filter(([, list]) => list.length > 0);
}

/** ⌘/Ctrl+J 开关抽屉；文件页的快捷键在输入控件中让行，这个组合键带修饰键所以全局生效。 */
export function useAssistantShortcut(enabled: boolean, toggle: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && !event.isComposing && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "j") {
        if (document.querySelector(".modal-backdrop:not(.is-minimized), .menu")) return;
        event.preventDefault();
        if (!event.repeat) toggle();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, toggle]);
}
