/**
 * 文件助手抽屉（docs/assistant-design.md §12.2）。挂在 MainShell：切换页面、打开预览时对话不中断。
 * 运行在服务端进行，这里通过 SSE 订阅事件；断线后按 seq 续读。写入类操作的确认卡片由服务端数据渲染。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import * as api from "../api";
import * as ai from "../assistant-api";
import { Markdown } from "../markdown";
import { Badge, Button, Checkbox, EmptyState, Icon, IconButton, Menu, Modal, Progress, Segmented, SkeletonRows, formatBytes, formatDateTime, toast, type IconName, type MenuItem, type Tone } from "../ui";
import type { PageImport } from "./page-import";

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
      <Icon name="sparkle" size={17} /><span>文件助手</span><kbd>{navigator.platform.includes("Mac") ? "⌘J" : "Ctrl J"}</kbd>
    </button>
  );
}

type Activity = { text: string; kind: "thinking" | "tool" | "queued" } | null;

export function AssistantDrawer({ open, config, location, onClose, onConfigChanged, mode = "drawer", initialConversation, onOpenPage,
  onConversationChange, onFilesChanged, pageImport, onPageImportDone }: {
  open: boolean; config: ai.AssistantConfig; location: AssistantLocation; onClose: () => void; onConfigChanged: () => void;
  /** drawer：右侧抽屉；page：全页（左侧对话列表常驻，消息流居中）。 */
  mode?: "drawer" | "page"; initialConversation?: string | null; onOpenPage?: (conversationId: string | null) => void;
  onConversationChange?: (conversationId: string | null) => void; onFilesChanged?: () => void;
  /** 抓取脚本转交的页面快照：用户点击发送时随消息上传。 */
  pageImport?: PageImport | null; onPageImportDone?: () => void;
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
  const [scopeChoice, setScopeChoice] = useState<"conversation" | "location" | "root">("conversation");
  const [runId, setRunId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState("");
  const [activity, setActivity] = useState<Activity>(null);
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

  const follow = useCallback((id: string) => {
    unsubscribe.current?.();
    const version = selection.current;
    setReconnecting(false);
    setRunId(id); setStreaming(""); setActivity({ text: "正在思考…", kind: "thinking" });
    unsubscribe.current = ai.subscribeRun(id, event => {
      if (version !== selection.current) return;
      switch (event.type) {
        case "queued": setActivity({ text: `排队中，前面还有 ${event.position} 个`, kind: "queued" }); break;
        case "run_started": case "thinking": case "stream_reset": setActivity({ text: "正在思考…", kind: "thinking" }); setStreaming(""); break;
        case "text_delta": setStreaming(text => text + String(event.text ?? "")); setActivity(null); window.requestAnimationFrame(() => scrollToEnd()); break;
        case "tool_started": setActivity({ text: `正在调用 ${String(event.label ?? event.name)}…`, kind: "tool" }); break;
        case "message": {
          const message = event.message as ai.ChatMessage;
          if (message.role === "assistant") setStreaming("");
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
          setStreaming("");
          setDetail(current => { if (current) void ai.conversation(current.conversation.id).then(fresh => { if (version === selection.current) setDetail(fresh); }).catch(() => undefined); return current; });
          break;
        case "title": setDetail(current => current && { ...current, conversation: { ...current.conversation, title: String(event.title) } }); loadConversations(); break;
        case "run_finished": case "stream_failed":
          setRunId(null); setActivity(null); setStreaming(""); unsubscribe.current = null;
          onConfigChanged();
          setDetail(current => { if (current) void ai.conversation(current.conversation.id).then(fresh => setDetail(value => value?.conversation.id === fresh.conversation.id ? fresh : value)).catch(() => undefined); return current; });
          break;
      }
    }, value => { if (version === selection.current) setReconnecting(value); });
  }, [onConfigChanged, loadConversations, scrollToEnd]);

  async function openConversation(id: string) {
    const version = ++selection.current;
    unsubscribe.current?.(); unsubscribe.current = null;
    setRunId(null); setStreaming(""); setActivity(null); setHistory(false); setReconnecting(false); setLoading(true); setScopeChoice("conversation");
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
    setDetail(null); setRunId(null); setStreaming(""); setActivity(null); setHistory(false); setScopeChoice("conversation"); setDraft("");
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
      let current = detail;
      if (!current) {
        current = await ai.createConversation(scopeChoice === "root" ? "" : locationKey, modelId);
        if (version !== selection.current) return;
        setDetail(current);
        loadConversations();
      }
      let snapshotId: string | undefined;
      if (importedPages && text === draft) {
        snapshotId = (await ai.uploadSnapshot(current.conversation.id, importedPages)).snapshot_id;
      }
      const result = await ai.sendMessage(current.conversation.id, { text: message, model_id: modelId ?? undefined, location: locationKey, view: location.view,
        scope: current === detail ? scopeChoice : undefined, snapshot_id: snapshotId });
      if (version !== selection.current) return;
      if (snapshotId) onPageImportDone?.();
      setDraft(""); setScopeChoice("conversation");
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

  const reloadDetail = useCallback(() => {
    setDetail(current => { if (current) void ai.conversation(current.conversation.id).then(fresh => setDetail(value => value?.conversation.id === fresh.conversation.id ? fresh : value)).catch(() => undefined); return current; });
  }, []);

  // 键盘：Esc 运行中先停止，空闲时关闭；只在焦点位于抽屉内时响应，弹窗与菜单优先。全页模式不关闭。
  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || event.defaultPrevented || document.querySelector(".modal-backdrop, .menu")) return;
    if (!runId && page) return;
    event.preventDefault();
    if (runId) void stop(); else onClose();
  }
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
  const effectiveScope = scopeChoice === "location" ? currentLocation : scopeChoice === "root" ? "/" : conversationScope;
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
    <span className="assistant-brand-mark" aria-hidden="true"><Icon name="sparkle" size={18} /></span>
    <div className="assistant-title"><strong>{detail?.conversation.title || "文件助手"}</strong><small>{detail ? conversationScope : "查找、整理，让文件井井有条"}</small></div>
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
          : <Messages detail={detail} modelLabel={modelLabel} running={Boolean(runId)} onAnswer={text => void send(text)} onScope={(id, approve) => void decideScope(id, approve)}
              onRetry={lastUser?.text ? () => void send(lastUser.text) : undefined} onActionChanged={reloadDetail} onFilesChanged={onFilesChanged} />}
        {streaming && <div className="assistant-msg is-assistant is-streaming"><ResponseHeading model={selectedModel?.label} streaming /><div className="assistant-response"><Markdown source={streaming} /><i className="assistant-caret" aria-hidden="true" /></div></div>}
        {activity && <p className="assistant-activity" role="status"><span className="assistant-pulse" aria-hidden="true" />{activity.text}</p>}
        {reconnecting && <p className="assistant-activity" role="status"><Icon name="refresh" size={14} />重新连接中…</p>}
      </div>
    </div>
    {unseen && <button type="button" className="assistant-unseen" onClick={() => scrollToEnd(true)}><Icon name="chevronDown" size={14} />有新消息</button>}</div>
    <div className="assistant-composer">
      {pageImport && <SnapshotChip value={pageImport} onRemove={() => onPageImportDone?.()} />}
      <div className="assistant-compose-box">
        <div className="assistant-context-row">
          <ScopeChip scope={effectiveScope} conversationScope={detail ? conversationScope : null} location={currentLocation}
            privateView={location.view === "private"} choice={scopeChoice} onChoose={setScopeChoice} />
          <button type="button" className="assistant-capability-button" onClick={() => setCapabilities(true)} title="查看助手能力"><Icon name="settings" size={14} /><span>能力</span></button>
        </div>
        <textarea ref={input} className="assistant-input" rows={2} value={draft} maxLength={DRAFT_LIMIT}
          placeholder={!config.notice_ack ? "请先阅读上方说明" : exhausted ? "今日额度已用完，明天 0 点后重置" : "想找什么，或想怎样整理？"}
          disabled={!config.notice_ack || exhausted} aria-label="给文件助手的消息"
          onChange={event => setDraft(event.target.value)}
          onInput={event => { const node = event.currentTarget; node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, 8 * 22)}px`; }}
          onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <div className="assistant-controls">
          <Menu label="选择模型" align="start" className="assistant-model" items={config.models.map(model => ({ label: model.label,
            description: `${model.channel_name ?? "模型渠道"}${model.id === config.default_model ? " · 默认模型" : ""}`, icon: "server", checked: model.id === modelId,
            onSelect: () => setModelId(model.id) }))}>
            <Icon name="server" size={14} /><span>{selectedModel?.label ?? "选择模型"}</span><Icon name="chevronDown" size={12} />
          </Menu>
          <span className="assistant-enter-hint">Enter 发送</span>
          {runId ? <button type="button" className="assistant-send is-stop" aria-label="停止" title="停止（Esc）" onClick={() => void stop()}><Icon name="stop" size={16} /></button>
            : <button type="button" className="assistant-send" aria-label="发送" title="发送（Enter）" disabled={!draft.trim() || sending || !config.notice_ack || exhausted || Boolean(pageImport && !pageImport.pages)} onClick={() => void send()}>
              {sending ? <span className="spinner" aria-hidden="true" /> : <Icon name="arrowUp" size={18} />}</button>}
        </div>
      </div>
      <div className={`assistant-footnote${usageRatio >= 0.8 ? " tone-warning" : ""}`}>
        <span title={`今日已用 ${usage.today.toLocaleString("zh-CN")} token${usage.limit ? ` / ${usage.limit.toLocaleString("zh-CN")}` : ""}`}>{usage.limit ? `今日 ${Math.min(100, Math.round(usageRatio * 100))}%` : "今日不限额"}</span>
        <span><Icon name="shield" size={11} />修改文件前会请你确认</span>
      </div>
    </div>
  </>;
  const dialogs = capabilities && <CapabilitiesDialog config={config} onClose={() => setCapabilities(false)} onPick={text => { setCapabilities(false); setDraft(text); input.current?.focus(); }} />;

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

function ScopeChip({ scope, conversationScope, location, privateView, choice, onChoose }: {
  scope: string; conversationScope: string | null; location: string; privateView: boolean;
  choice: "conversation" | "location" | "root"; onChoose: (choice: "conversation" | "location" | "root") => void;
}) {
  const differs = conversationScope !== null && conversationScope !== location && choice === "conversation";
  const items: MenuItem[] = [
    ...(conversationScope !== null ? [{ label: "对话作用域", description: conversationScope, icon: "folder" as IconName, heading: "助手可以访问的范围", checked: choice === "conversation", onSelect: () => onChoose("conversation") }] : []),
    { label: "当前位置", description: location, icon: "folder", heading: conversationScope === null ? "助手可以访问的范围" : undefined, checked: conversationScope === null ? choice !== "root" : choice === "location", onSelect: () => onChoose(conversationScope === null ? "conversation" : "location") },
    { label: "全部普通文件", description: "/ · 不包含私密空间", icon: "home", checked: choice === "root", onSelect: () => onChoose("root") },
  ];
  return <span className={`assistant-scope${differs ? " has-hint" : ""}`} title={privateView ? "私密空间不对助手开放，作用域为普通文件" : differs ? `当前位置 ${location} 与对话作用域不同` : `助手只处理 ${scope} 内的普通文件`}>
    <Menu label="切换作用域" align="start" className="assistant-scope-trigger" items={items}>
      <Icon name={privateView ? "shield" : "folder"} size={14} /><span className="assistant-scope-label">{privateView ? "普通文件" : "作用于"}</span><span className="assistant-scope-text">{scope}</span><Icon name="chevronDown" size={12} />
    </Menu>
  </span>;
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
    <span className="assistant-welcome-icon"><Icon name="sparkle" size={28} /></span>
    <span className="assistant-eyebrow">你的文件，有了新帮手</span>
    <h3>让文件，井井有条。</h3>
    <p className="muted">查找、理解、整理，一句话就开始。<br />每一步修改，都由你来决定。</p>
    <div className="assistant-starters">{examples.map(example => <button type="button" key={example.title} onClick={() => onPick(example.text)}>
      <Icon name={example.icon} size={18} /><strong>{example.title}</strong><small>{example.description}</small><Icon name="chevronRight" size={13} />
    </button>)}</div>
    <div className="assistant-welcome-scope"><Icon name="folder" size={13} /><span>从 <code title={location}>{location}</code> 开始</span></div>
  </div>;
}

function ResponseHeading({ model, streaming = false }: { model?: string; streaming?: boolean }) {
  return <div className="assistant-response-heading"><span className="assistant-response-mark"><Icon name="sparkle" size={13} /></span><strong>文件助手</strong>
    {model && <span className="assistant-response-model" title={model}>{model}</span>}{streaming && <span className="assistant-live-label">正在生成</span>}</div>;
}

function copyMessage(text: string) {
  void navigator.clipboard?.writeText(text).then(() => toast.success("已复制")).catch(() => toast.error("复制失败，请手动选择文本"));
}

/* ---------- 消息流 ---------- */

type Block = { kind: "message"; message: ai.ChatMessage } | { kind: "tools"; messages: ai.ChatMessage[] };

function blocks(messages: ai.ChatMessage[]): Block[] {
  const result: Block[] = [];
  const plans = new Map<string | null | undefined, number>();
  for (const message of messages) if (message.event?.type === "plan") plans.set(message.run_id, message.seq);
  for (const message of messages) {
    if (message.event?.type === "plan" && plans.get(message.run_id) !== message.seq) continue;
    if (message.role === "assistant" && !message.text?.trim()) continue;
    if (message.role === "tool" && !message.event) {
      const last = result.at(-1);
      if (last?.kind === "tools") last.messages.push(message);
      else result.push({ kind: "tools", messages: [message] });
      continue;
    }
    result.push({ kind: "message", message });
  }
  return result;
}

function Messages({ detail, modelLabel, running, onAnswer, onScope, onRetry, onActionChanged, onFilesChanged }: {
  detail: ai.ConversationDetail; modelLabel: (id: number | null | undefined) => string; running: boolean; onAnswer: (text: string) => void; onScope: (id: string, approve: boolean) => void; onRetry?: () => void;
  onActionChanged: () => void; onFilesChanged?: () => void;
}) {
  const items = useMemo(() => blocks(detail.messages), [detail.messages]);
  const lastQuestion = [...detail.messages].reverse().find(message => message.event?.type === "question");
  const answered = lastQuestion ? detail.messages.some(message => message.role === "user" && message.seq > lastQuestion.seq) : true;
  return <>
    {items.map((block, index) => block.kind === "tools" ? <ToolGroup key={`t${block.messages[0].seq}`} messages={block.messages} />
      : <MessageView key={block.message.seq} message={block.message} model={modelLabel(block.message.model_id)} actions={detail.actions} running={running}
          selectedAnswer={block.message.event?.type === "question" ? detail.messages.find(message => message.role === "user" && message.seq > block.message.seq)?.text : undefined}
          canAnswer={!running && !answered && block.message.seq === lastQuestion?.seq} onAnswer={onAnswer} onScope={onScope}
          onRetry={index === items.length - 1 ? onRetry : undefined} onActionChanged={onActionChanged} onFilesChanged={onFilesChanged} />)}
  </>;
}

function MessageView({ message, model, actions, running, canAnswer, selectedAnswer, onAnswer, onScope, onRetry, onActionChanged, onFilesChanged }: {
  message: ai.ChatMessage; model: string; actions: ai.AssistantAction[]; running: boolean; canAnswer: boolean; selectedAnswer?: string;
  onAnswer: (text: string) => void; onScope: (id: string, approve: boolean) => void; onRetry?: () => void;
  onActionChanged: () => void; onFilesChanged?: () => void;
}) {
  if (message.role === "user") return <div className="assistant-msg is-user">
    {message.attachment && <span className="assistant-attachment is-sent"><Icon name="globe" size={14} />
      <span>{message.attachment.source.replace(/^https?:\/\//, "")} 的页面快照 · {message.attachment.pages} 页 · {message.attachment.images.toLocaleString("zh-CN")} 个图片候选</span></span>}
    <div className="assistant-bubble">{message.text}</div>
    <span className="assistant-meta">{message.created_at ? formatDateTime(message.created_at) : ""}
      <button type="button" className="assistant-copy" onClick={() => copyMessage(message.text ?? "")}>复制</button></span>
  </div>;
  if (message.role === "assistant") return <div className="assistant-msg is-assistant">
    <ResponseHeading model={model} /><div className="assistant-response"><Markdown source={message.text ?? ""} /></div>
    <span className="assistant-meta">{message.output_tokens ? `${message.input_tokens ?? 0}+${message.output_tokens} token` : ""}
      <button type="button" className="assistant-copy" onClick={() => copyMessage(message.text ?? "")}>复制</button></span>
  </div>;
  if (message.role === "event") {
    if (message.type === "summary" || message.type === "model_switched" || message.type === "scope_changed" || message.type === "scope_rejected"
      || message.type === "stopped" || message.type === "limit" || message.type === "action_result") {
      return <p className="assistant-event">{message.text}</p>;
    }
    return <p className="assistant-event is-error"><Icon name="alert" size={14} />{message.text}
      {message.retry && onRetry && !running && <button type="button" className="assistant-copy" onClick={onRetry}>重试</button>}</p>;
  }
  const event = message.event;
  if (event?.type === "plan") return <div className="assistant-card assistant-plan">
    <span className="assistant-card-head"><Icon name="list" size={16} /><strong>处理计划</strong><Badge>{event.items.filter(item => item.status === "completed").length} / {event.items.length}</Badge></span>
    <ul>{event.items.map((item, index) => <li key={index} className={`is-${item.status}`}><Icon name={item.status === "completed" ? "checkCircle" : item.status === "in_progress" ? "play" : "chevronRight"} size={14} />{item.content}</li>)}</ul>
  </div>;
  if (event?.type === "question") return <div className="assistant-card assistant-question">
    <span className="assistant-card-head"><Icon name="info" size={16} /><strong>需要你的选择</strong>{selectedAnswer && <Badge tone="success">已回答</Badge>}</span><p>{event.question}</p>
    <div className="assistant-options">{event.options.map(option => <Button key={option} size="sm" variant={selectedAnswer === option ? "primary" : "secondary"} icon={selectedAnswer === option ? "check" : undefined} disabled={!canAnswer} onClick={() => onAnswer(option)}>{option}</Button>)}</div>
  </div>;
  if (event?.type === "scope_request") {
    const action = actions.find(item => item.id === event.action_id);
    if (!action && running) return <div className="assistant-card"><SkeletonRows rows={2} /></div>;
    const status = action?.status ?? "expired";
    return <div className={`assistant-card assistant-scope-card is-${status}`}>
      <span className="assistant-card-head"><Icon name="folder" size={16} /><strong>助手请求扩大作用域</strong>
        {status !== "pending" && <Badge tone={status === "confirmed" ? "success" : "neutral"}>{status === "confirmed" ? "已允许" : status === "rejected" ? "已拒绝" : "已过期"}</Badge>}</span>
      <p><code>{action?.payload?.from ?? event.from}</code> → <code>{action?.payload?.to ?? event.to}</code></p>
      {(action?.payload?.reason ?? event.reason) && <p className="muted">原因：{action?.payload?.reason ?? event.reason}</p>}
      {status === "pending" && <div className="assistant-options">
        <Button size="sm" onClick={() => onScope(event.action_id, false)}>拒绝</Button>
        <Button size="sm" variant="primary" onClick={() => onScope(event.action_id, true)} aria-label={`允许把作用域扩大到 ${action?.payload?.to ?? event.to}`}>允许</Button>
      </div>}
    </div>;
  }
  if (event?.type === "action") {
    const action = actions.find(item => item.id === event.action_id);
    return <ActionCard id={event.action_id} action={action} fallback={event} onChanged={onActionChanged} onFilesChanged={onFilesChanged} />;
  }
  return <ToolGroup messages={[message]} />;
}

/* ---------- 待确认操作卡片（全部由服务端冻结的数据渲染，不使用模型生成的描述） ---------- */

const ACTION_ICONS: Record<string, IconName> = { rename: "edit", move: "move", organize: "folder", mkdir: "folderPlus", trash: "trash",
  restore: "restore", purge: "trash", unshare: "link", downloads: "download", download_control: "download" };
const STATUS_LABEL: Record<string, [string, Tone]> = {
  pending: ["待确认", "accent"], running: ["执行中", "accent"], done: ["已完成", "success"], partial: ["部分完成", "warning"],
  failed: ["执行失败", "danger"], cancelled: ["已取消", "neutral"], rejected: ["已拒绝", "neutral"], expired: ["已过期", "neutral"],
  interrupted: ["已中断", "warning"], undoing: ["撤销中", "accent"], undone: ["已撤销", "neutral"],
};
const MOVE_KINDS = ["rename", "move", "organize"];
const name = (key: string) => key.replace(/\/$/, "").split("/").pop() ?? key;
const parent = (key: string) => { const trimmed = key.replace(/\/$/, ""); return trimmed.includes("/") ? trimmed.slice(0, trimmed.lastIndexOf("/") + 1) : ""; };

function describeItem(kind: string, item: ai.ActionItem): [string, string | null] {
  if (MOVE_KINDS.includes(kind) && item.from && item.to) {
    if (kind === "rename" || parent(item.from) === parent(item.to)) return [name(item.from), name(item.to)];
    return [display(item.from), display(parent(item.to))];
  }
  if (kind === "downloads") return [item.name ?? "", item.host ?? null];
  if (kind === "download_control") return [`#${item.id} ${name(item.path ?? "")}`, null];
  return [display(item.path ?? ""), null];
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function ActionCard({ id, action, fallback, onChanged, onFilesChanged }: {
  id: string; action?: ai.AssistantAction; fallback: { kind: string; count: number }; onChanged: () => void; onFilesChanged?: () => void;
}) {
  const [value, setValue] = useState<ai.AssistantAction | undefined>(action);
  const [busy, setBusy] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [armed, setArmed] = useState(false);
  const [details, setDetails] = useState(false);
  useEffect(() => { if (action) setValue(current => !current || action.status !== current.status || action.finished_at !== current.finished_at ? action : current); }, [action]);
  const status = value?.status ?? "pending";
  const live = status === "running" || status === "undoing";
  const now = useNow(status === "pending");
  const expired = status === "pending" && value != null && value.expires_at <= now;
  // 执行中轮询进度；进入终态后刷新对话。无论终态来自轮询还是对话刷新，只要经历过执行就刷新文件列表。
  useEffect(() => {
    if (!live) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void ai.action(id).then(fresh => {
        if (stopped) return;
        setValue(fresh);
        if (fresh.status !== "running" && fresh.status !== "undoing") onChanged();
      }).catch(() => undefined);
    }, 1000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [live, id]);
  const touched = useRef(false);
  useEffect(() => {
    if (live) touched.current = true;
    else if (touched.current && status !== "pending") { touched.current = false; onFilesChanged?.(); }
  }, [live, status]);

  async function run(label: string, task: () => Promise<ai.AssistantAction>, after?: (fresh: ai.AssistantAction) => void) {
    setBusy(label);
    try {
      const fresh = await task();
      if (fresh.status === "running" || fresh.status === "undoing" || label === "undo") touched.current = true;
      setValue(fresh);
      after?.(fresh);
      onChanged();
    } catch (reason) { toast.error(api.errorMessage(reason, "操作失败")); onChanged(); }
    finally { setBusy(null); setArmed(false); }
  }

  if (!value) return <div className="assistant-card assistant-action is-loading"><SkeletonRows rows={2} /></div>;
  const payload = value.payload ?? {};
  const kind = value.kind || fallback.kind;
  const danger = Boolean(payload.danger);
  const many = value.count > 1000;
  const [label, tone] = STATUS_LABEL[expired ? "expired" : status] ?? [status, "neutral" as Tone];
  const samples = payload.samples ?? [];
  const progress = value.progress;
  const result = value.result;
  const verb = `${payload.title ?? ai.ACTION_KINDS[kind] ?? kind} ${value.count.toLocaleString("zh-CN")} 项`;
  return <div className={`assistant-card assistant-action is-${expired ? "expired" : status}${danger ? " is-danger" : ""}`}>
    <span className="assistant-card-head">
      <Icon name={ACTION_ICONS[kind] ?? "check"} size={16} />
      <strong>{payload.title ?? kind}</strong>
      <Badge tone={danger && status === "pending" && !expired ? "danger" : tone}>{danger && status === "pending" && !expired ? "不可恢复" : label}</Badge>
      {status === "pending" && !expired && <small className="assistant-card-time">{formatClock(value.expires_at)} 过期</small>}
    </span>
    <p className="assistant-action-summary">{payload.summary}</p>
    <p className="assistant-action-meta muted">作用域 <code>{display(payload.scope ?? "")}</code>
      {payload.size ? ` · ${formatBytes(payload.size)}` : ""}
      {kind === "downloads" && payload.options?.target != null ? <> · 保存到 <code>{display(payload.options.target)}</code></> : null}</p>
    {samples.length > 0 && <ul className="assistant-action-items">
      {samples.slice(0, 6).map((item, index) => { const [left, right] = describeItem(kind, item); return <li key={index}>
        <span className="cell-truncate" title={left}>{left}</span>{right != null && <><Icon name="chevronRight" size={12} /><span className="cell-truncate" title={right}>{right}</span></>}
      </li>; })}
    </ul>}
    <div className="assistant-action-links">
      {(value.count > 6 || (payload.conflicts ?? 0) > 0) && <button type="button" className="assistant-copy" onClick={() => setDetails(true)}>
        查看全部 {value.count.toLocaleString("zh-CN")} 项{payload.conflicts ? ` · ${payload.conflicts} 项将跳过` : ""}</button>}
      {kind === "downloads" && payload.options?.hosts?.length ? <span className="muted">来源 {payload.options.hosts.join("、")}</span> : null}
    </div>
    {live && progress && <div className="assistant-action-progress">
      <Progress value={progress.total ? progress.done / progress.total * 100 : 0} label="执行进度" />
      <small className="muted">{progress.done.toLocaleString("zh-CN")} / {progress.total.toLocaleString("zh-CN")}</small>
    </div>}
    {result && !live && <p className="assistant-action-result">
      成功 {result.ok} 项{result.skipped ? ` · 跳过 ${result.skipped} 项` : ""}{result.failed ? ` · 失败 ${result.failed} 项` : ""}
      {Object.keys(result.reasons ?? {}).length > 0 && <small className="muted">（{Object.entries(result.reasons).map(([reason, count]) => `${reason} ${count}`).join("；")}）</small>}
    </p>}
    {kind === "downloads" && result?.failed ? <p className="muted assistant-action-hint">部分图片需要来源页的登录或防盗链，可以在来源页用抓取脚本的「本地下载」保存。</p> : null}
    {status === "pending" && !expired && <>
      {danger && <label className="assistant-ack"><Checkbox checked={acknowledged} onChange={setAcknowledged} label="我了解此操作不可恢复" /><span>我了解此操作不可恢复</span></label>}
      <div className="assistant-options">
        <Button size="sm" disabled={Boolean(busy)} loading={busy === "reject"} onClick={() => void run("reject", () => ai.rejectAction(id))}>拒绝</Button>
        <Button size="sm" variant={danger ? "danger" : "primary"} disabled={Boolean(busy) || (danger && !acknowledged)} loading={busy === "confirm"}
          aria-label={`确认执行：${verb}`}
          onClick={() => { if (many && !armed) { setArmed(true); return; }
            void run("confirm", () => ai.confirmAction(id, { acknowledge: danger ? acknowledged : undefined, count: many ? value.count : undefined })); }}>
          {many && armed ? `确认执行 ${value.count.toLocaleString("zh-CN")} 项` : "确认执行"}</Button>
      </div>
    </>}
    {live && status === "running" && <div className="assistant-options"><Button size="sm" loading={busy === "cancel"} onClick={() => void run("cancel", () => ai.cancelAction(id))}>取消</Button></div>}
    {value.undoable && !live && <div className="assistant-options">
      <Button size="sm" icon="restore" loading={busy === "undo"} onClick={() => void run("undo", () => ai.undoAction(id))}>撤销</Button>
    </div>}
    {details && <ActionItemsDialog action={value} onClose={() => setDetails(false)} />}
  </div>;
}

function formatClock(seconds: number) {
  const date = new Date(seconds * 1000);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function ActionItemsDialog({ action, onClose }: { action: ai.AssistantAction; onClose: () => void }) {
  const [items, setItems] = useState<ai.ActionItem[] | null>(null);
  const [skipped, setSkipped] = useState<{ path: string; reason: string }[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [compacted, setCompacted] = useState(false);
  const load = useCallback((offset: number) => {
    void ai.actionItems(action.id, offset).then(page => {
      setItems(current => offset ? [...(current ?? []), ...page.items] : page.items);
      if (!offset) { setSkipped(page.skipped); setCompacted(page.compacted); }
      setNext(page.next_offset);
    }).catch(reason => { toast.error(api.errorMessage(reason, "条目加载失败")); setItems([]); });
  }, [action.id]);
  useEffect(() => load(0), [load]);
  const failures = action.result?.failures ?? [];
  return <Modal title={`${action.payload?.title ?? "操作"}：全部条目`} description={action.payload?.summary} size="lg" onClose={onClose}
    footer={<Button onClick={onClose}>关闭</Button>}>
    {compacted && <p className="inline-note">这个操作已超过 30 天，只保留了前 20 条样例。</p>}
    {failures.length > 0 && <section className="assistant-action-section"><h4>执行时跳过或失败</h4>
      <ul className="assistant-action-items is-plain">{failures.map((item, index) => <li key={index}><span className="cell-truncate">{item.path}</span><small className="muted">{item.reason}</small></li>)}</ul></section>}
    {skipped.length > 0 && <section className="assistant-action-section"><h4>提议时已跳过（{skipped.length}）</h4>
      <ul className="assistant-action-items is-plain">{skipped.map((item, index) => <li key={index}><span className="cell-truncate">{item.path}</span><small className="muted">{item.reason}</small></li>)}</ul></section>}
    <section className="assistant-action-section"><h4>将要执行（{action.count.toLocaleString("zh-CN")}）</h4>
      {items === null ? <SkeletonRows rows={4} /> : <ul className="assistant-action-items is-plain">
        {items.map((item, index) => { const [left, right] = describeItem(action.kind, item); return <li key={index}>
          <span className="cell-truncate" title={left}>{left}</span>{right != null && <><Icon name="chevronRight" size={12} /><span className="cell-truncate" title={right}>{right}</span></>}
        </li>; })}
      </ul>}
      {next !== null && <Button size="sm" onClick={() => load(next)}>加载更多</Button>}
    </section>
  </Modal>;
}

function ToolGroup({ messages }: { messages: ai.ChatMessage[] }) {
  const rows = <div className="assistant-tools">{messages.map(message => <ToolRow key={message.seq} message={message} />)}</div>;
  if (messages.length <= 3) return rows;
  const failed = messages.filter(message => message.status === "error").length;
  return <details className="assistant-tool-group"><summary className="assistant-tool-summary"><Icon name="chevronRight" size={14} />
    <span>完成 {messages.length} 项工具查询{failed ? ` · ${failed} 项出错` : ""}</span></summary>{rows}</details>;
}

function ToolRow({ message }: { message: ai.ChatMessage }) {
  const [open, setOpen] = useState(false);
  const failed = message.status === "error";
  const args = message.arguments && Object.keys(message.arguments).length ? summarizeArgs(message.arguments) : "";
  return <div className={`assistant-tool${failed ? " is-error" : ""}${open ? " is-open" : ""}`}>
    <button type="button" className="assistant-tool-row" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name={failed ? "alert" : "check"} size={14} />
      <strong>{message.label ?? message.name}</strong>
      {args && <span className="assistant-tool-args">{args}</span>}
      <span className="assistant-tool-summary-text">{message.summary}</span>
      <span className="assistant-tool-time">{message.duration_ms != null ? (message.duration_ms >= 1000 ? `${(message.duration_ms / 1000).toFixed(1)}s` : `${message.duration_ms}ms`) : ""}</span>
    </button>
    {!open && message.status === "ok" && message.name === "collect_gallery" && Array.isArray((message.result as { samples?: unknown })?.samples) &&
      <div className="assistant-collection">{((message.result as { samples: string[] }).samples).map(url => <span key={url} className="assistant-chip-static" title={url}>{urlName(url)}</span>)}</div>}
    {open && <div className="assistant-tool-detail">
      {message.arguments && Object.keys(message.arguments).length > 0 && <><small>参数</small><pre>{JSON.stringify(message.arguments, null, 2)}</pre></>}
      <small>结果{message.truncated ? "（已截断）" : ""}</small><pre>{JSON.stringify(message.result, null, 2)}</pre>
    </div>}
  </div>;
}

function urlName(url: string) {
  const value = url.split("?")[0].split("/").pop() || url;
  try { return decodeURIComponent(value); } catch { return value; }
}

function summarizeArgs(args: Record<string, unknown>) {
  return Object.entries(args).slice(0, 3).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ").slice(0, 80);
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
