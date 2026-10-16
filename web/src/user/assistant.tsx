/**
 * 文件助手抽屉（docs/assistant-design.md §12.2）。挂在 MainShell：切换页面、打开预览时对话不中断。
 * 运行在服务端进行，这里通过 SSE 订阅事件；断线后按 seq 续读。写入类操作的确认卡片由服务端数据渲染。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import * as api from "../api";
import * as ai from "../assistant-api";
import { AssistantMark, Badge, Button, EmptyState, Icon, IconButton, Menu, Modal, Segmented, SkeletonRows, toast, type IconName, type MenuItem } from "../ui";
import type { PageImport } from "./page-import";
import { Thread, useMarkState, type LiveRun } from "./assistant-thread";
import { filesBridge, waitForFiles } from "./assistant-bridge";
import { assistantEnvironment } from "./assistant-environment";
import { commonFolder, useMentions } from "./assistant-mentions";
import { FolderPicker } from "./folders";

const WIDTH_KEY = "tessera-assistant-width";
const MIN_WIDTH = 360, MAX_WIDTH = 720;
const display = (key: string) => "/" + key;
const DRAFT_LIMIT = 8000;

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

export function AssistantLauncher({ onOpen, open }: { onOpen: () => void; open: boolean }) {
  return (
    <button type="button" className={`assistant-launch${open ? " is-active" : ""}`} onClick={onOpen} data-closes-nav aria-expanded={open} aria-keyshortcuts="Meta+J Control+J">
      <AssistantMark size={18} /><span>文件助手</span><kbd>{navigator.platform.includes("Mac") ? "⌘J" : "Ctrl J"}</kbd>
    </button>
  );
}

export type AssistantNavigate = (view: "files" | "trash" | "downloads" | "shared", prefix?: string) => void;
const FULL_ACK_KEY = "tessera-assistant-full-ack";
const EMPTY_LIVE: LiveRun = { reasoning: "", reasoningStartedAt: null, streaming: "", tools: [], phase: "thinking" };

export function AssistantDrawer({ open, config, location, onClose, onConfigChanged, mode = "drawer", initialConversation, onOpenPage,
  onConversationChange, onFilesChanged, pageImport, onPageImportDone, onNavigate }: {
  open: boolean; config: ai.AssistantConfig; location: AssistantLocation; onClose: () => void; onConfigChanged: () => void;
  /** drawer：右侧抽屉；page：全页（左侧对话列表常驻，消息流居中）。 */
  mode?: "drawer" | "page"; initialConversation?: string | null; onOpenPage?: (conversationId: string | null) => void;
  onConversationChange?: (conversationId: string | null) => void; onFilesChanged?: () => void;
  /** 抓取脚本转交的页面快照：用户点击发送时随消息上传。 */
  pageImport?: PageImport | null; onPageImportDone?: () => void;
  /** 浏览器工具 ui_navigate 等：在 Tessera 中打开页面。全页模式不提供（会离开对话页）。 */
  onNavigate?: AssistantNavigate;
}) {
  const page = mode === "page";
  const [width, setWidth] = useState(() => { const saved = Number(localStorage.getItem(WIDTH_KEY)); return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : 480; });
  const [history, setHistory] = useState(false);
  const [archived, setArchived] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [conversations, setConversations] = useState<ai.Conversation[] | null>(null);
  const [detail, setDetail] = useState<ai.ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [modelId, setModelId] = useState<number | null>(null);
  // 用户为下一条消息选定的作用域目录（对象键，"" 为全部普通文件）；null 表示沿用对话作用域。
  const [scopeTarget, setScopeTarget] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [pendingMode, setPendingMode] = useState<ai.AccessMode>("approval");
  const [fullPrompt, setFullPrompt] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [sending, setSending] = useState(false);
  const [capabilities, setCapabilities] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  const selection = useRef(0);
  const currentId = detail?.conversation.id ?? null;
  const locationKey = location.view === "files" ? location.prefix : "";
  const headerMark = useMarkState(runId ? live ?? EMPTY_LIVE : null);
  const mention = useMentions({ draft, setDraft, input, location: locationKey, enabled: config.notice_ack && !(config.usage.limit && config.usage.today >= config.usage.limit) });

  useEffect(() => {
    if (!config.models.some(model => model.id === modelId)) {
      setModelId([detail?.conversation.model_id, config.default_model, config.models[0]?.id].find(id => config.models.some(model => model.id === id)) ?? null);
    }
  }, [config, detail?.conversation.model_id, modelId]);
  useEffect(() => { if (open) window.setTimeout(() => input.current?.focus(), 60); }, [open, currentId]);
  useEffect(() => () => unsubscribe.current?.(), []);
  useEffect(() => {
    if (page) return;
    const root = document.documentElement;
    root.classList.toggle("assistant-open", open);
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
    void ai.conversations(null, archived).then(result => { setConversations(result.conversations); setHistoryCursor(result.next_cursor); })
      .catch(reason => { setConversations([]); toast.error(api.errorMessage(reason, "对话列表加载失败")); });
  }, [archived]);
  useEffect(() => { if (open) loadConversations(); }, [open, loadConversations]);
  async function moreConversations() {
    if (!historyCursor || historyBusy) return;
    setHistoryBusy(true);
    try {
      const result = await ai.conversations(historyCursor, archived);
      setConversations(current => [...(current ?? []), ...result.conversations.filter(item => !current?.some(old => old.id === item.id))]);
      setHistoryCursor(result.next_cursor);
    } catch (reason) { toast.error(api.errorMessage(reason, "加载失败")); }
    finally { setHistoryBusy(false); }
  }
  // 桌面允许继续操作文件；窄屏抽屉占满视口时约束焦点，关闭后回到入口。
  useEffect(() => {
    if (!open || page) return;
    const previous = document.activeElement as HTMLElement | null;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !window.matchMedia("(max-width: 760px)").matches || document.querySelector(".menu, .modal-backdrop")) return;
      const nodes = Array.from(drawer.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])
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

  // 浏览器工具：在当前页面执行后回传结果。只执行仍在有效期内、尚未处理的调用（断线重放时不重复操作页面）。
  const handledCalls = useRef(new Set<string>());
  const clientContext = useRef({ location, onNavigate, page });
  clientContext.current = { location, onNavigate, page };
  const runClientCall = useCallback(async (runId: string, event: ai.RunEvent) => {
    const callId = String(event.call_id ?? "");
    if (!callId || handledCalls.current.has(callId) || Number(event.expires_at ?? 0) * 1000 < Date.now()) return;
    handledCalls.current.add(callId);
    let outcome: { result?: Record<string, unknown>; error?: string };
    try { outcome = { result: await executeClientTool(String(event.name), (event.args ?? {}) as Record<string, unknown>, clientContext.current) }; }
    catch (reason) { outcome = { error: reason instanceof Error ? reason.message : "页面操作失败" }; }
    await ai.sendClientResult(runId, callId, outcome).catch(() => undefined);
  }, []);

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
          setDetail(current => current && !current.messages.some(item => item.seq === message.seq)
            ? { ...current, messages: [...current.messages, message] } : current);
          const actionEvent = message.event;
          if (actionEvent?.type === "action" || actionEvent?.type === "scope_request") {
            void ai.action(actionEvent.action_id).then(action => {
              if (version !== selection.current) return;
              setDetail(current => current && { ...current, actions: [...current.actions.filter(item => item.id !== action.id), action] });
            }).catch(() => undefined);
          }
          window.requestAnimationFrame(() => scrollToEnd());
          break;
        }
        case "resync":
          setLive(value => value && { ...value, streaming: "", reasoning: "" });
          setDetail(current => { if (current) void ai.conversation(current.conversation.id).then(fresh => { if (version === selection.current) setDetail(fresh); }).catch(() => undefined); return current; });
          break;
        case "title": setDetail(current => current && { ...current, conversation: { ...current.conversation, title: String(event.title) } }); loadConversations(); break;
        case "run_finished": case "stream_failed":
          setRunId(null); setLive(null); unsubscribe.current = null;
          onConfigChanged();
          setDetail(current => { if (current) void ai.conversation(current.conversation.id).then(fresh => setDetail(value => value?.conversation.id === fresh.conversation.id ? fresh : value)).catch(() => undefined); return current; });
          break;
      }
    }, value => { if (version === selection.current) setReconnecting(value); });
  }, [onConfigChanged, loadConversations, scrollToEnd, runClientCall]);

  async function openConversation(id: string) {
    const version = ++selection.current;
    unsubscribe.current?.(); unsubscribe.current = null;
    setRunId(null); setLive(null); setHistory(false); setReconnecting(false); setLoading(true); setScopeTarget(null); mention.reset();
    try {
      const value = await ai.conversation(id);
      if (version !== selection.current) return;
      setDetail(value); setModelId(value.conversation.model_id);
      if (value.active_run) follow(value.active_run);
      window.requestAnimationFrame(() => scrollToEnd(true));
    } catch (reason) { toast.error(api.errorMessage(reason, "对话加载失败")); }
    finally { if (version === selection.current) setLoading(false); }
  }

  function newConversation() {
    selection.current += 1;
    setLoading(false); setReconnecting(false);
    unsubscribe.current?.(); unsubscribe.current = null;
    setDetail(null); setRunId(null); setLive(null); setHistory(false); setScopeTarget(null); mention.reset(); setDraft(""); setPendingMode("approval");
    window.setTimeout(() => input.current?.focus(), 30);
  }

  async function send(text = draft) {
    const message = text.trim();
    if (!message || runId || sending) return;
    if (pageImport && !pageImport.pages) { toast.error(pageImport.error || "页面快照还在接收，请稍候"); return; }
    if (!config.notice_ack) return;
    setSending(true);
    const version = selection.current;
    try {
      // 引用超出作用域时，扩大到作用域与所有引用的公共上级目录（界面已提示，属于用户发送的操作）。
      const mentions = text === draft ? mention.mentions.map(item => item.key) : [];
      const baseScope = scopeTarget ?? (detail ? detail.conversation.scope.replace(/^\//, "") : locationKey);
      const target = mentions.some(key => !key.startsWith(baseScope)) ? commonFolder([baseScope || "/", ...mentions].filter(key => key !== "/")) : scopeTarget;
      let current = detail;
      if (!current) {
        current = await ai.createConversation(target ?? locationKey, modelId, config.full_access ? pendingMode : "approval");
        if (version !== selection.current) return;
        setDetail(current);
        loadConversations();
      }
      let snapshotId: string | undefined;
      if (importedPages && text === draft) {
        snapshotId = (await ai.uploadSnapshot(current.conversation.id, importedPages)).snapshot_id;
      }
      const result = await ai.sendMessage(current.conversation.id, { text: message, model_id: modelId ?? undefined, location: locationKey, view: location.view,
        ...(current === detail && target !== null ? { scope: "path" as const, scope_path: display(target) } : {}),
        mentions: mentions.length ? mentions.map(display) : undefined, snapshot_id: snapshotId, environment: assistantEnvironment() });
      if (version !== selection.current) return;
      if (snapshotId) onPageImportDone?.();
      setDraft(""); setScopeTarget(null); mention.reset();
      if (input.current) input.current.style.height = "";
      const fresh = await ai.conversation(current.conversation.id).catch(() => null);
      if (version !== selection.current) return;
      if (fresh) setDetail(fresh);
      follow(result.run_id);
      window.requestAnimationFrame(() => scrollToEnd(true));
    } catch (reason) { toast.error(api.errorMessage(reason, "发送失败")); }
    finally { setSending(false); }
  }

  async function stop() {
    if (!runId) return;
    try { await ai.stopRun(runId); } catch (reason) { toast.error(api.errorMessage(reason, "停止失败")); }
  }

  async function decideScope(actionId: string, approve: boolean) {
    try {
      const result = await ai.decideScope(actionId, approve);
      const fresh = await ai.conversation(detail!.conversation.id);
      setDetail(fresh);
      if (result.run_id) follow(result.run_id);
    } catch (reason) { toast.error(api.errorMessage(reason, "操作失败")); }
  }

  async function acknowledge() {
    try { await ai.acknowledgeNotice(); onConfigChanged(); }
    catch (reason) { toast.error(api.errorMessage(reason, "操作失败")); }
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
      setDetail(value => value?.conversation.id === fresh.conversation.id ? fresh : value);
      window.requestAnimationFrame(() => scrollToEnd(true));
    } catch (reason) { toast.error(api.errorMessage(reason, "切换失败")); }
  }

  const reloadDetail = useCallback(() => {
    setDetail(current => { if (current) void ai.conversation(current.conversation.id).then(fresh => setDetail(value => value?.conversation.id === fresh.conversation.id ? fresh : value)).catch(() => undefined); return current; });
  }, []);

  // 键盘：Esc 运行中先停止，空闲时关闭；只在焦点位于抽屉内时响应，弹窗与菜单优先。全页模式不关闭。
  // 打开的弹窗与菜单自己处理 Esc；最小化的预览小窗不算。
  const overlayOpen = () => Boolean(document.querySelector(".modal-backdrop:not(.is-minimized), .menu"));
  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || overlayOpen()) return;
    if (!runId && page) return;
    event.preventDefault();
    if (runId) void stop(); else onClose();
  }
  const escapeRef = useRef(onKeyDown);
  escapeRef.current = onKeyDown;
  // 抽屉打开后焦点可能不在抽屉里（输入框尚未可用、点击了消息区等，焦点落回页面）：此时页面本身或助手入口上的 Esc
  // 同样交给抽屉。捕获阶段先于文件页的 Esc（清除选择）处理；页面上的输入控件与其他元素保留各自的 Esc。
  useEffect(() => {
    if (!open || page) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (event.key !== "Escape" || !target || drawer.current?.contains(target)) return;
      if (target !== document.body && target !== document.documentElement && !target.closest(".assistant-launch")) return;
      escapeRef.current({ key: event.key, defaultPrevented: event.defaultPrevented, nativeEvent: event, preventDefault: () => event.preventDefault() } as ReactKeyboardEvent<HTMLElement>);
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, page]);
  // ⌘/Ctrl+Shift+O 新对话（输入控件中也生效，因为带修饰键）。
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
        if (document.querySelector(".modal-backdrop:not(.is-minimized)")) return;
        event.preventDefault();
        newConversation();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX, startWidth = width;
    const move = (moveEvent: PointerEvent) => setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + startX - moveEvent.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      setWidth(value => { localStorage.setItem(WIDTH_KEY, String(value)); return value; });
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }

  const conversationScope = detail?.conversation.scope ?? display(locationKey);
  const currentLocation = display(locationKey);
  const effectiveScope = scopeTarget !== null ? display(scopeTarget) : conversationScope;
  const scopeKey = effectiveScope.replace(/^\//, "");
  const outside = mention.mentions.filter(item => !item.key.startsWith(scopeKey));
  const expandedScope = outside.length ? display(commonFolder([scopeKey, ...mention.mentions.map(item => item.key)].filter(Boolean))) : null;
  const usage = config.usage;
  const usageRatio = usage.limit ? usage.today / usage.limit : 0;
  const exhausted = Boolean(usage.limit && usage.today >= usage.limit);
  const lastUser = [...(detail?.messages ?? [])].reverse().find(message => message.role === "user");

  const selectedModel = config.models.find(model => model.id === modelId);
  const modelLabel = (id: number | null | undefined) => config.models.find(model => model.id === id)?.label ?? "文件助手";
  const historyList = <ConversationList archived={archived} onArchiveView={setArchived} more={historyCursor !== null} loadingMore={historyBusy} onMore={() => void moreConversations()} items={conversations} current={currentId} onOpen={id => void openConversation(id)} onChanged={(deleted) => {
    loadConversations(); if (deleted && deleted === currentId) newConversation(); else reloadDetail();
  }} />;
  const header = <header className="assistant-header">
    {<IconButton className={page ? "assistant-mobile-history" : undefined} icon="list" label="对话历史" active={history} onClick={() => { setHistory(value => !value); if (!history) loadConversations(); }} />}
    <span className={`assistant-brand-mark${runId ? " is-working" : ""}`} aria-hidden="true"><AssistantMark size={24} state={headerMark} /></span>
    <div className="assistant-title"><strong>{detail?.conversation.title || "文件助手"}</strong>
      <small>{accessMode === "full" && <span className="assistant-full-tag"><Icon name="zap" size={11} />完全访问</span>}{detail ? conversationScope : "查找、整理，让文件井井有条"}</small></div>
    <IconButton icon="plus" label="新对话（⌘⇧O）" onClick={newConversation} />
    {!page && onOpenPage && <IconButton icon="maximize" label="在全页打开" onClick={() => onOpenPage(currentId)} />}
    {!page && <IconButton icon="x" label="关闭" onClick={onClose} />}
  </header>;
  const body = <>
    <div className="assistant-scroll-area"><div className="assistant-thread" ref={scroller} role="log" aria-live="polite" aria-relevant="additions"
      onScroll={event => { const node = event.currentTarget; const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40; setAtBottom(bottom); if (bottom) setUnseen(false); }}>
      <div className="assistant-thread-inner">
        {!config.notice_ack ? <NoticeCard notice={config.notice} retention={config.retention_days} onAccept={() => void acknowledge()} />
          : loading ? <SkeletonRows rows={4} />
          : !detail ? <Welcome location={effectiveScope} onPick={text => { setDraft(text); input.current?.focus(); }} />
          : <Thread detail={detail} live={live} liveModel={selectedModel?.label} modelLabel={modelLabel} running={Boolean(runId)} onAnswer={text => void send(text)} onScope={(id, approve) => void decideScope(id, approve)}
              onRetry={lastUser?.text ? () => void send(lastUser.text) : undefined} onActionChanged={reloadDetail} onFilesChanged={onFilesChanged} />}
        {reconnecting && <p className="ai-notice" role="status"><Icon name="refresh" size={14} /><span>重新连接中…</span></p>}
      </div>
    </div>
    {unseen && <button type="button" className="assistant-unseen" onClick={() => scrollToEnd(true)}><Icon name="chevronDown" size={14} />有新消息</button>}</div>
    <div className="assistant-composer">
      {pageImport && <SnapshotChip value={pageImport} onRemove={() => onPageImportDone?.()} />}
      {mention.menu}
      <div className={`assistant-compose-box${runId ? " is-running" : ""}`}>
        <div className="assistant-context-row">
          <ScopeChip scope={effectiveScope} conversationScope={detail ? conversationScope : null} location={currentLocation}
            privateView={location.view === "private"} changed={scopeTarget !== null} onChoose={setScopeTarget} />
          <ModeChip mode={accessMode} allowed={config.full_access} onChoose={next => void chooseMode(next)} />
        </div>
        {mention.mentions.length > 0 && <div className="assistant-mention-chips">
          {mention.mentions.map(item => <span key={item.key} className="assistant-mention-chip"><Icon name={item.folder ? "folder" : "file"} size={12} />
            <span title={display(item.key)}>{item.key.replace(/\/$/, "").split("/").at(-1)}</span>
            <button type="button" aria-label={`移除引用 ${display(item.key)}`} onClick={() => mention.remove(item.key)}><Icon name="x" size={11} /></button></span>)}
          {expandedScope && <span className="assistant-mention-hint"><Icon name="info" size={12} />引用不在 {effectiveScope} 内，发送时作用域扩大到 {expandedScope}</span>}
        </div>}
        <textarea ref={input} className="assistant-input" rows={2} value={draft} maxLength={DRAFT_LIMIT}
          placeholder={!config.notice_ack ? "请先阅读上方说明" : exhausted ? "今日额度已用完，明天 0 点后重置" : "想找什么，或想怎样整理？输入 @ 引用文件"}
          disabled={!config.notice_ack || exhausted} aria-label="给文件助手的消息"
          onChange={event => { setDraft(event.target.value); mention.sync(); }}
          onSelect={mention.sync} onBlur={() => window.setTimeout(mention.sync, 120)}
          onInput={event => { const node = event.currentTarget; node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, 8 * 22)}px`; }}
          onKeyDown={event => { if (mention.onKeyDown(event)) return; if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <div className="assistant-controls">
          <Menu label="选择模型" align="start" className="assistant-model" items={config.models.map(model => ({ label: model.label,
            description: [model.channel_name ?? "模型渠道", model.capabilities?.reasoning ? "推理" : "", model.capabilities?.vision ? "识图" : "",
              model.context_window ? `${Math.round(model.context_window / 1000)}K 上下文` : "", model.id === config.default_model ? "默认" : ""].filter(Boolean).join(" · "),
            icon: model.capabilities?.reasoning ? "brain" : "server", checked: model.id === modelId,
            onSelect: () => setModelId(model.id) }))}>
            <Icon name={selectedModel?.capabilities?.reasoning ? "brain" : "server"} size={14} /><span>{selectedModel?.label ?? "选择模型"}</span><Icon name="chevronDown" size={12} />
          </Menu>
          <button type="button" className="assistant-capability-button" onClick={() => setCapabilities(true)} title="查看助手能力"><Icon name="sparkle" size={14} /><span>能力</span></button>
          <span className="assistant-enter-hint">@ 引用 · Enter 发送 · Shift+Enter 换行</span>
          {runId ? <button type="button" className="assistant-send is-stop" aria-label="停止" title="停止（Esc）" onClick={() => void stop()}><Icon name="stop" size={16} /></button>
            : <button type="button" className="assistant-send" aria-label="发送" title="发送（Enter）" disabled={!draft.trim() || sending || !config.notice_ack || exhausted || Boolean(pageImport && !pageImport.pages)} onClick={() => void send()}>
              {sending ? <span className="spinner" aria-hidden="true" /> : <Icon name="arrowUp" size={18} />}</button>}
        </div>
      </div>
      <div className={`assistant-footnote${usageRatio >= 0.8 ? " tone-warning" : ""}`}>
        <span title={`今日已用 ${usage.today.toLocaleString("zh-CN")} token${usage.limit ? ` / ${usage.limit.toLocaleString("zh-CN")}` : ""}`}>{usage.limit ? `今日 ${Math.min(100, Math.round(usageRatio * 100))}%` : "今日不限额"}</span>
        <span>{accessMode === "full" ? <><Icon name="zap" size={11} />普通修改自动执行，可在卡片上撤销</> : <><Icon name="shield" size={11} />修改文件前会请你确认</>}</span>
      </div>
    </div>
  </>;
  const dialogs = <>
    {capabilities && <CapabilitiesDialog config={config} onClose={() => setCapabilities(false)} onPick={text => { setCapabilities(false); setDraft(text); input.current?.focus(); }} />}
    {fullPrompt && <Modal title="切换到完全访问？" icon="zap" onClose={() => setFullPrompt(false)}
      footer={<><Button onClick={() => setFullPrompt(false)}>取消</Button><Button variant="primary" onClick={() => { localStorage.setItem(FULL_ACK_KEY, "1"); setFullPrompt(false); void chooseMode("full", true); }}>切换</Button></>}>
      <ul className="assistant-mode-points">
        <li><Icon name="zap" size={15} /><span><strong>普通修改自动执行</strong>改名、移动、整理、新建文件夹、移入回收站等不再逐项询问，结果直接显示在对话里。</span></li>
        <li><Icon name="restore" size={15} /><span><strong>24 小时内可以撤销</strong>每个自动执行的操作都保留卡片，可以一键撤销。</span></li>
        <li><Icon name="shield" size={15} /><span><strong>这些仍需你确认</strong>彻底删除、公开分享、超过 1,000 项的操作，以及对话中读取过文件内容或网页之后的修改。</span></li>
      </ul>
    </Modal>}
  </>;

  if (page) return (
    <section className="assistant-page" aria-label="文件助手" onKeyDown={onKeyDown}>
      <aside className="assistant-page-side" aria-label="对话列表">
        <div className="assistant-page-side-head"><strong>对话</strong><Button size="sm" icon="plus" onClick={newConversation}>新对话</Button></div>
        {historyList}
      </aside>
      <div className="assistant-page-main">{header}{history ? historyList : body}</div>
      {dialogs}
    </section>
  );
  return (
    <aside ref={drawer} className={`assistant-drawer${open ? " is-open" : ""}`} style={{ "--assistant-width": `${width}px` } as CSSProperties}
      aria-label="文件助手" aria-hidden={!open} onKeyDown={onKeyDown} {...(!open ? { inert: "" } as object : {})}>
      <div className="assistant-resize" onPointerDown={startResize} role="separator" tabIndex={open ? 0 : -1} aria-label="调整助手宽度" aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={width}
        onKeyDown={event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault();
          const next = event.key === "Home" ? MIN_WIDTH : event.key === "End" ? MAX_WIDTH : Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width + (event.key === "ArrowLeft" ? 20 : -20)));
          setWidth(next); localStorage.setItem(WIDTH_KEY, String(next)); }} />
      {header}
      {history ? historyList : body}
      {dialogs}
    </aside>
  );
}

/** 在用户当前页面执行浏览器工具（docs/assistant-design.md §19.7）。参数已经过服务端校验，这里只做页面操作。 */
async function executeClientTool(name: string, args: Record<string, unknown>,
  context: { location: AssistantLocation; onNavigate?: AssistantNavigate; page: boolean }): Promise<Record<string, unknown>> {
  const { location, onNavigate, page } = context;
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

function ScopeChip({ scope, conversationScope, location, privateView, changed, onChoose }: {
  scope: string; conversationScope: string | null; location: string; privateView: boolean;
  changed: boolean; onChoose: (target: string | null) => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  const key = (path: string) => path.replace(/^\//, "");
  const differs = conversationScope !== null && conversationScope !== location && !changed;
  const items: MenuItem[] = [
    ...(conversationScope !== null ? [{ label: "对话作用域", description: conversationScope, icon: "folder" as IconName, heading: "助手可以访问的范围", checked: !changed, onSelect: () => onChoose(null) }] : []),
    { label: "当前位置", description: location, icon: "folder", heading: conversationScope === null ? "助手可以访问的范围" : undefined,
      checked: scope === location && (changed || conversationScope === null), onSelect: () => onChoose(conversationScope === null ? null : key(location)) },
    { label: "全部普通文件", description: "/ · 不包含私密空间", icon: "home", checked: scope === "/", onSelect: () => onChoose("") },
    { label: "浏览目录…", description: "在目录树中选择", icon: "move", divider: true, onSelect: () => setBrowsing(true) },
  ];
  return <span className={`assistant-scope${differs ? " has-hint" : ""}`} title={privateView ? "私密空间不对助手开放，作用域为普通文件" : differs ? `当前位置 ${location} 与对话作用域不同` : `助手只处理 ${scope} 内的普通文件`}>
    <Menu label="切换作用域" align="start" className="assistant-scope-trigger" items={items}>
      <Icon name={privateView ? "shield" : "folder"} size={14} /><span className="assistant-scope-label">{privateView ? "普通文件" : "作用于"}</span><span className="assistant-scope-text">{scope}</span><Icon name="chevronDown" size={12} />
    </Menu>
    {browsing && <ScopeDialog initial={key(scope)} onClose={() => setBrowsing(false)} onChoose={target => { setBrowsing(false); onChoose(target === key(conversationScope ?? "") && conversationScope !== null ? null : target); }} />}
  </span>;
}

/** 目录树选择作用域：复用上传与移动的位置浏览器，私密空间与系统区域不在其中。 */
function ScopeDialog({ initial, onClose, onChoose }: { initial: string; onClose: () => void; onChoose: (target: string) => void }) {
  const [value, setValue] = useState(initial);
  const [ready, setReady] = useState(false);
  return <Modal title="选择作用域" description="助手只会查看和整理这个目录中的普通文件。" icon="folder" onClose={onClose} className="assistant-scope-dialog"
    footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!ready} onClick={() => onChoose(value)}>作用于 {display(value)}</Button></>}>
    <FolderPicker value={value} onChange={setValue} onReady={setReady} creatable={false} />
  </Modal>;
}

function ModeChip({ mode, allowed, onChoose }: { mode: ai.AccessMode; allowed: boolean; onChoose: (mode: ai.AccessMode) => void }) {
  const items: MenuItem[] = [
    { label: "审批模式", description: "每次修改都由你在卡片上确认", icon: "shield", heading: "修改文件时", checked: mode === "approval", onSelect: () => onChoose("approval") },
    { label: "完全访问", description: allowed ? "普通修改自动执行，可撤销" : "管理员未开启", icon: "zap", checked: mode === "full", disabled: !allowed,
      onSelect: () => onChoose("full") },
  ];
  return <Menu label="访问模式" align="start" className={`assistant-mode${mode === "full" ? " is-full" : ""}`} items={items}>
    <Icon name={mode === "full" ? "zap" : "shield"} size={14} /><span>{mode === "full" ? "完全访问" : "审批"}</span><Icon name="chevronDown" size={12} />
  </Menu>;
}

function CapabilitiesDialog({ config, onClose, onPick }: { config: ai.AssistantConfig; onClose: () => void; onPick: (text: string) => void }) {
  const groups = new Map<string, ai.UserTool[]>();
  for (const tool of config.tools) groups.set(tool.group_label, [...(groups.get(tool.group_label) ?? []), tool]);
  const examples = ["统计当前目录的空间占用，按类型分组", "找出最大的 10 个文件", "找出重复文件，看看能省多少空间", "最近 7 天新增了哪些文件？", "回收站里有什么，什么时候会被清除？", "读一下 README.md，帮我总结要点"];
  return (
    <Modal title="助手能做什么" description={`你的账号权限：${config.max_level === "read" ? "只读" : config.max_level === "danger" ? "可提议包括不可恢复的操作" : "可提议普通写入"}。修改文件的操作总是需要你确认。`}
      icon="sparkle" onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
      <div className="assistant-capabilities">
        {[...groups.entries()].map(([group, tools]) => <section key={group}>
          <h3>{group}</h3>
          <ul>{tools.map(tool => <li key={tool.name} className={tool.available ? "" : "is-off"}>
            <span className="name-stack"><strong>{tool.label}</strong><small>{tool.description}</small></span>
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

function NoticeCard({ notice, retention, onAccept }: { notice: string; retention: number; onAccept: () => void }) {
  return (
    <div className="assistant-notice">
      <span className="assistant-notice-icon"><Icon name="shield" size={20} /></span>
      <h3>使用前请了解</h3>
      <p>{notice}</p>
      <p className="muted">对话保留 {retention} 天；你可以随时删除对话，删除后对你不再可见，并在保留期满后彻底清除。</p>
      <Button variant="primary" onClick={onAccept}>我知道了</Button>
    </div>
  );
}

function Welcome({ location, onPick }: { location: string; onPick: (text: string) => void }) {
  const examples: { title: string; description: string; text: string; icon: IconName }[] = [
    { title: "看懂空间", description: "用量与文件分布", text: `统计 ${location} 的空间占用，按类型分组`, icon: "pulse" },
    { title: "找到大文件", description: "发现空间占用大户", text: "这里最大的 10 个文件是什么？", icon: "search" },
    { title: "整理文件", description: "按类型自动归类", text: "先看看当前目录的文件，再帮我按类型整理", icon: "folder" },
    { title: "发现重复", description: "看看能节省多少空间", text: "找出当前作用域的重复文件，先不要修改", icon: "copy" },
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
  const [title, setTitle] = useState("");
  const groups = groupByDate(items ?? []);
  return <div className="assistant-history">
    <div className="assistant-history-filter"><Segmented label="对话分类" showLabels value={archived ? "archived" : "recent"} onChange={value => onArchiveView(value === "archived")}
      options={[{ value: "recent", label: "最近对话" }, { value: "archived", label: "已归档" }]} /></div>
    {items === null ? <SkeletonRows rows={5} /> : items.length === 0 ? <EmptyState icon="list" title={archived ? "还没有归档的对话" : "还没有对话"} description="对话会保留在这里，随时可以继续。" /> : null}
    {groups.map(([label, list]) => <section key={label}>
      <h4>{label}</h4>
      <ul>{list.map(item => <li key={item.id} className={item.id === current ? "is-active" : ""}>
        <button type="button" className="assistant-history-item" onClick={() => onOpen(item.id)}>
          <span className="name-stack"><strong>{item.title || "新对话"}</strong><small>{item.scope} · {item.messages} 条消息</small></span>
          {item.active_run && <span className="assistant-pulse" aria-label="进行中" />}
        </button>
        <Menu label={`${item.title || "对话"} 的操作`} items={[
          { label: "重命名", icon: "edit", onSelect: () => { setRenaming(item); setTitle(item.title ?? ""); } },
          { label: archived ? "移回最近对话" : "归档", icon: "archive", onSelect: () => void ai.updateConversation(item.id, { archived: !archived }).then(() => { toast.success(archived ? "已移回最近对话" : "已归档"); onChanged(); }).catch(reason => toast.error(api.errorMessage(reason, "操作失败"))) },
          { label: "删除", icon: "trash", danger: true, divider: true, onSelect: () => void ai.deleteConversation(item.id).then(() => { toast.success("对话已删除"); onChanged(item.id); }).catch(reason => toast.error(api.errorMessage(reason, "删除失败"))) },
        ]} />
      </li>)}</ul>
    </section>)}
    {more && <Button size="sm" variant="ghost" className="assistant-history-more" loading={loadingMore} onClick={onMore}>加载更多对话</Button>}
    {renaming && <Modal title="重命名对话" size="sm" onClose={() => setRenaming(null)}
      footer={<><Button onClick={() => setRenaming(null)}>取消</Button><Button variant="primary" type="submit" form="rename-conversation">保存</Button></>}>
      <form id="rename-conversation" className="form" onSubmit={event => {
        event.preventDefault();
        if (!title.trim()) return;
        void ai.updateConversation(renaming.id, { title: title.trim() }).then(() => { setRenaming(null); onChanged(); }).catch(reason => toast.error(api.errorMessage(reason, "保存失败")));
      }}><input className="input" value={title} maxLength={60} onChange={event => setTitle(event.target.value)} autoFocus aria-label="对话标题" /></form>
    </Modal>}
  </div>;
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
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "j") {
        if (document.querySelector(".modal-backdrop:not(.is-minimized)")) return;
        event.preventDefault();
        toggle();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, toggle]);
}
