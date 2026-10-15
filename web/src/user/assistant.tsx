/**
 * 文件助手抽屉（docs/assistant-design.md §12.2）。挂在 MainShell：切换页面、打开预览时对话不中断。
 * 运行在服务端进行，这里通过 SSE 订阅事件；断线后按 seq 续读。写入类操作的确认卡片由服务端数据渲染。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import * as api from "../api";
import * as ai from "../assistant-api";
import { Markdown } from "../markdown";
import { Badge, Button, EmptyState, Icon, IconButton, Menu, Modal, SkeletonRows, formatDateTime, toast, type IconName, type MenuItem } from "../ui";

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

export function AssistantDrawer({ open, config, location, onClose, onConfigChanged }: {
  open: boolean; config: ai.AssistantConfig; location: AssistantLocation; onClose: () => void; onConfigChanged: () => void;
}) {
  const [width, setWidth] = useState(() => { const saved = Number(localStorage.getItem(WIDTH_KEY)); return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : 440; });
  const [history, setHistory] = useState(false);
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
  const currentId = detail?.conversation.id ?? null;
  const locationKey = location.view === "files" ? location.prefix : "";

  useEffect(() => { if (modelId === null || !config.models.some(model => model.id === modelId)) setModelId(detail?.conversation.model_id ?? config.default_model ?? config.models[0]?.id ?? null); }, [config, detail?.conversation.model_id]);
  useEffect(() => { if (open) window.setTimeout(() => input.current?.focus(), 60); }, [open, currentId]);
  useEffect(() => () => unsubscribe.current?.(), []);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--assistant-width", `${width}px`);
    root.classList.toggle("assistant-open", open);
    return () => root.classList.remove("assistant-open");
  }, [open, width]);

  const loadConversations = useCallback(() => {
    void ai.conversations().then(page => setConversations(page.conversations)).catch(() => setConversations([]));
  }, []);
  useEffect(() => { if (open && conversations === null) loadConversations(); }, [open]);

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
    setRunId(id); setStreaming(""); setActivity({ text: "正在思考…", kind: "thinking" });
    unsubscribe.current = ai.subscribeRun(id, event => {
      switch (event.type) {
        case "queued": setActivity({ text: `排队中，前面还有 ${event.position} 个`, kind: "queued" }); break;
        case "run_started": case "thinking": setActivity({ text: "正在思考…", kind: "thinking" }); setStreaming(""); break;
        case "text_delta": setStreaming(text => text + String(event.text ?? "")); setActivity(null); window.requestAnimationFrame(() => scrollToEnd()); break;
        case "tool_started": setActivity({ text: `正在调用 ${String(event.label ?? event.name)}…`, kind: "tool" }); break;
        case "message": {
          const message = event.message as ai.ChatMessage;
          if (message.role === "assistant") setStreaming("");
          setDetail(current => current && !current.messages.some(item => item.seq === message.seq)
            ? { ...current, messages: [...current.messages, message] } : current);
          window.requestAnimationFrame(() => scrollToEnd());
          break;
        }
        case "title": setDetail(current => current && { ...current, conversation: { ...current.conversation, title: String(event.title) } }); loadConversations(); break;
        case "run_finished": case "stream_failed":
          setRunId(null); setActivity(null); setStreaming(""); unsubscribe.current = null;
          onConfigChanged();
          setDetail(current => { if (current) void ai.conversation(current.conversation.id).then(fresh => setDetail(value => value?.conversation.id === fresh.conversation.id ? fresh : value)).catch(() => undefined); return current; });
          break;
      }
    }, setReconnecting);
  }, [onConfigChanged, loadConversations, scrollToEnd]);

  async function openConversation(id: string) {
    unsubscribe.current?.(); unsubscribe.current = null;
    setRunId(null); setStreaming(""); setActivity(null); setHistory(false); setLoading(true); setScopeChoice("conversation");
    try {
      const value = await ai.conversation(id);
      setDetail(value); setModelId(value.conversation.model_id);
      if (value.active_run) follow(value.active_run);
      window.requestAnimationFrame(() => scrollToEnd(true));
    } catch (reason) { toast.error(api.errorMessage(reason, "对话加载失败")); }
    finally { setLoading(false); }
  }

  function newConversation() {
    unsubscribe.current?.(); unsubscribe.current = null;
    setDetail(null); setRunId(null); setStreaming(""); setActivity(null); setHistory(false); setScopeChoice("conversation"); setDraft("");
    window.setTimeout(() => input.current?.focus(), 30);
  }

  async function send(text = draft) {
    const message = text.trim();
    if (!message || runId || sending) return;
    if (!config.notice_ack) return;
    setSending(true);
    try {
      let current = detail;
      if (!current) {
        current = await ai.createConversation(scopeChoice === "root" ? "" : locationKey, modelId);
        setDetail(current);
        loadConversations();
      }
      const result = await ai.sendMessage(current.conversation.id, { text: message, model_id: modelId ?? undefined, location: locationKey, view: location.view,
        scope: current === detail ? scopeChoice : undefined });
      setDraft(""); setScopeChoice("conversation");
      const fresh = await ai.conversation(current.conversation.id);
      setDetail(fresh);
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

  // 键盘：Esc 运行中先停止，空闲时关闭；只在焦点位于抽屉内时响应，弹窗与菜单优先。
  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || event.defaultPrevented || document.querySelector(".modal-backdrop, .menu")) return;
    event.preventDefault();
    if (runId) void stop(); else onClose();
  }

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

  return (
    <aside ref={drawer} className={`assistant-drawer${open ? " is-open" : ""}`} style={{ "--assistant-width": `${width}px` } as CSSProperties}
      aria-label="文件助手" aria-hidden={!open} onKeyDown={onKeyDown} {...(!open ? { inert: "" } as object : {})}>
      <div className="assistant-resize" onPointerDown={startResize} aria-hidden="true" />
      <header className="assistant-header">
        <IconButton icon="list" label="对话历史" active={history} onClick={() => { setHistory(value => !value); if (!history) loadConversations(); }} />
        <div className="assistant-title"><strong>{detail?.conversation.title || (detail ? "新对话" : "文件助手")}</strong>{detail && <small>{conversationScope}</small>}</div>
        <IconButton icon="plus" label="新对话" onClick={newConversation} />
        <IconButton icon="x" label="关闭" onClick={onClose} />
      </header>
      {history ? <ConversationList items={conversations} current={currentId} onOpen={id => void openConversation(id)} onChanged={(deleted) => {
        loadConversations(); if (deleted && deleted === currentId) newConversation();
      }} /> : <>
        <div className="assistant-thread" ref={scroller} role="log" aria-live="polite" aria-relevant="additions"
          onScroll={event => { const node = event.currentTarget; const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40; setAtBottom(bottom); if (bottom) setUnseen(false); }}>
          {!config.notice_ack ? <NoticeCard notice={config.notice} retention={config.retention_days} onAccept={() => void acknowledge()} />
            : loading ? <SkeletonRows rows={4} />
            : !detail ? <Welcome location={currentLocation} onPick={text => { setDraft(text); input.current?.focus(); }} />
            : <Messages detail={detail} running={Boolean(runId)} onAnswer={text => void send(text)} onScope={(id, approve) => void decideScope(id, approve)}
                onRetry={lastUser?.text ? () => void send(lastUser.text) : undefined} />}
          {streaming && <div className="assistant-msg is-assistant is-streaming"><Markdown source={streaming} /><i className="assistant-caret" aria-hidden="true" /></div>}
          {activity && <p className="assistant-activity" role="status"><span className="assistant-pulse" aria-hidden="true" />{activity.text}</p>}
          {reconnecting && <p className="assistant-activity" role="status"><Icon name="refresh" size={14} />重新连接中…</p>}
        </div>
        {unseen && <button type="button" className="assistant-unseen" onClick={() => scrollToEnd(true)}><Icon name="chevronDown" size={14} />有新消息</button>}
        <div className="assistant-composer">
          <textarea ref={input} className="assistant-input" rows={1} value={draft} maxLength={DRAFT_LIMIT}
            placeholder={!config.notice_ack ? "请先阅读上方说明" : exhausted ? "今日额度已用完，明天 0 点后重置" : "输入消息，Shift+Enter 换行"}
            disabled={!config.notice_ack || exhausted} aria-label="给文件助手的消息"
            onChange={event => setDraft(event.target.value)}
            onInput={event => { const node = event.currentTarget; node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, 8 * 22)}px`; }}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <div className="assistant-controls">
            <ScopeChip scope={effectiveScope} conversationScope={detail ? conversationScope : null} location={currentLocation}
              privateView={location.view === "private"} choice={scopeChoice} onChoose={setScopeChoice} />
            <button type="button" className="assistant-chip" onClick={() => setCapabilities(true)}><Icon name="settings" size={14} />能力</button>
            <select className="assistant-chip assistant-model" aria-label="模型" value={modelId ?? ""} onChange={event => setModelId(Number(event.target.value))}>
              {groupModels(config.models).map(([channel, models]) => <optgroup key={channel} label={channel}>
                {models.map(model => <option key={model.id} value={model.id}>{model.label}{model.id === config.default_model ? "（默认）" : ""}</option>)}
              </optgroup>)}
            </select>
            <span className="assistant-controls-spacer" />
            {runId ? <button type="button" className="assistant-send is-stop" aria-label="停止" title="停止（Esc）" onClick={() => void stop()}><Icon name="stop" size={16} /></button>
              : <button type="button" className="assistant-send" aria-label="发送" title="发送（Enter）" disabled={!draft.trim() || sending || !config.notice_ack || exhausted} onClick={() => void send()}>
                {sending ? <span className="spinner" aria-hidden="true" /> : <Icon name="arrowUp" size={16} />}</button>}
          </div>
          <p className={`assistant-footnote${usageRatio >= 0.8 ? " tone-warning" : ""}`}>
            {usage.limit ? `今日已用 ${Math.min(100, Math.round(usageRatio * 100))}%` : "今日用量不限"} · 内容会被记录，写入操作需你确认
          </p>
        </div>
      </>}
      {capabilities && <CapabilitiesDialog config={config} onClose={() => setCapabilities(false)} onPick={text => { setCapabilities(false); setDraft(text); input.current?.focus(); }} />}
    </aside>
  );
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
    ...(conversationScope !== null ? [{ label: `对话作用域 ${conversationScope}`, icon: "folder" as IconName, heading: "作用域", checked: choice === "conversation", onSelect: () => onChoose("conversation") }] : []),
    { label: `当前位置 ${location}`, icon: "folder", heading: conversationScope === null ? "作用域" : undefined, checked: conversationScope === null ? choice !== "root" : choice === "location", onSelect: () => onChoose(conversationScope === null ? "conversation" : "location") },
    { label: "全部文件 /", icon: "home", checked: choice === "root", onSelect: () => onChoose("root") },
  ];
  return (
    <span className={`assistant-scope${differs ? " has-hint" : ""}`} title={privateView ? "私密空间不对助手开放，作用域为普通文件" : differs ? `当前位置 ${location} 与对话作用域不同` : "助手只处理这个目录内的文件"}>
      <Icon name="folder" size={14} /><span className="assistant-scope-text">{scope}</span>
      <Menu label="切换作用域" icon="chevronDown" items={items} />
    </span>
  );
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
  const examples = [`统计 ${location} 的空间占用`, "这里有哪些大文件？", "找出重复文件", "最近一周新增了什么？"];
  return (
    <div className="assistant-welcome">
      <span className="assistant-welcome-icon"><Icon name="sparkle" size={22} /></span>
      <h3>我能帮你整理文件</h3>
      <p className="muted">我只会查看 <code>{location}</code> 里的文件，需要处理其他目录时会先征得你同意。</p>
      <div className="assistant-examples">{examples.map(text => <button type="button" key={text} onClick={() => onPick(text)}>{text}</button>)}</div>
    </div>
  );
}

/* ---------- 消息流 ---------- */

type Block = { kind: "message"; message: ai.ChatMessage } | { kind: "tools"; messages: ai.ChatMessage[] };

function blocks(messages: ai.ChatMessage[]): Block[] {
  const result: Block[] = [];
  for (const message of messages) {
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

function Messages({ detail, running, onAnswer, onScope, onRetry }: {
  detail: ai.ConversationDetail; running: boolean; onAnswer: (text: string) => void; onScope: (id: string, approve: boolean) => void; onRetry?: () => void;
}) {
  const items = useMemo(() => blocks(detail.messages), [detail.messages]);
  const lastQuestion = [...detail.messages].reverse().find(message => message.event?.type === "question");
  const answered = lastQuestion ? detail.messages.some(message => message.role === "user" && message.seq > lastQuestion.seq) : true;
  return <>
    {items.map((block, index) => block.kind === "tools" ? <ToolGroup key={`t${block.messages[0].seq}`} messages={block.messages} />
      : <MessageView key={block.message.seq} message={block.message} actions={detail.actions} running={running}
          canAnswer={!running && !answered && block.message.seq === lastQuestion?.seq} onAnswer={onAnswer} onScope={onScope}
          onRetry={index === items.length - 1 ? onRetry : undefined} />)}
  </>;
}

function MessageView({ message, actions, running, canAnswer, onAnswer, onScope, onRetry }: {
  message: ai.ChatMessage; actions: ai.AssistantAction[]; running: boolean; canAnswer: boolean;
  onAnswer: (text: string) => void; onScope: (id: string, approve: boolean) => void; onRetry?: () => void;
}) {
  if (message.role === "user") return <div className="assistant-msg is-user">
    <div className="assistant-bubble">{message.text}</div>
    <span className="assistant-meta">{message.created_at ? formatDateTime(message.created_at) : ""}
      <button type="button" className="assistant-copy" onClick={() => void navigator.clipboard?.writeText(message.text ?? "").then(() => toast.success("已复制"))}>复制</button></span>
  </div>;
  if (message.role === "assistant") return <div className="assistant-msg is-assistant">
    <Markdown source={message.text ?? ""} />
    <span className="assistant-meta">{message.output_tokens ? `${message.input_tokens ?? 0}+${message.output_tokens} token` : ""}
      <button type="button" className="assistant-copy" onClick={() => void navigator.clipboard?.writeText(message.text ?? "").then(() => toast.success("已复制"))}>复制</button></span>
  </div>;
  if (message.role === "event") {
    if (message.type === "summary" || message.type === "model_switched" || message.type === "scope_changed" || message.type === "scope_rejected" || message.type === "stopped" || message.type === "limit") {
      return <p className="assistant-event">{message.text}</p>;
    }
    return <p className="assistant-event is-error"><Icon name="alert" size={14} />{message.text}
      {message.retry && onRetry && !running && <button type="button" className="assistant-copy" onClick={onRetry}>重试</button>}</p>;
  }
  const event = message.event;
  if (event?.type === "plan") return <div className="assistant-card assistant-plan">
    <strong>计划</strong>
    <ul>{event.items.map((item, index) => <li key={index} className={`is-${item.status}`}><Icon name={item.status === "completed" ? "checkCircle" : item.status === "in_progress" ? "play" : "chevronRight"} size={14} />{item.content}</li>)}</ul>
  </div>;
  if (event?.type === "question") return <div className="assistant-card assistant-question">
    <p>{event.question}</p>
    <div className="assistant-options">{event.options.map(option => <Button key={option} size="sm" disabled={!canAnswer} onClick={() => onAnswer(option)}>{option}</Button>)}</div>
  </div>;
  if (event?.type === "scope_request") {
    const action = actions.find(item => item.id === event.action_id);
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
  return <ToolGroup messages={[message]} />;
}

function ToolGroup({ messages }: { messages: ai.ChatMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  if (messages.length > 3 && !expanded) {
    const failed = messages.filter(message => message.status === "error").length;
    return <button type="button" className="assistant-tool assistant-tool-summary" onClick={() => setExpanded(true)}>
      <Icon name="chevronRight" size={14} /><span>调用了 {messages.length} 个工具{failed ? `，${failed} 个出错` : ""}</span>
    </button>;
  }
  return <div className="assistant-tools">{messages.map(message => <ToolRow key={message.seq} message={message} />)}</div>;
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
    {open && <div className="assistant-tool-detail">
      {message.arguments && Object.keys(message.arguments).length > 0 && <><small>参数</small><pre>{JSON.stringify(message.arguments, null, 2)}</pre></>}
      <small>结果{message.truncated ? "（已截断）" : ""}</small><pre>{JSON.stringify(message.result, null, 2)}</pre>
    </div>}
  </div>;
}

function summarizeArgs(args: Record<string, unknown>) {
  return Object.entries(args).slice(0, 3).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ").slice(0, 80);
}

/* ---------- 对话历史 ---------- */

function ConversationList({ items, current, onOpen, onChanged }: { items: ai.Conversation[] | null; current: string | null; onOpen: (id: string) => void; onChanged: (deleted?: string) => void }) {
  const [renaming, setRenaming] = useState<ai.Conversation | null>(null);
  const [title, setTitle] = useState("");
  if (items === null) return <div className="assistant-history"><SkeletonRows rows={5} /></div>;
  if (items.length === 0) return <div className="assistant-history"><EmptyState icon="list" title="还没有对话" description="开始一个新对话后会显示在这里。" /></div>;
  const groups = groupByDate(items);
  return <div className="assistant-history">
    {groups.map(([label, list]) => <section key={label}>
      <h4>{label}</h4>
      <ul>{list.map(item => <li key={item.id} className={item.id === current ? "is-active" : ""}>
        <button type="button" className="assistant-history-item" onClick={() => onOpen(item.id)}>
          <span className="name-stack"><strong>{item.title || "新对话"}</strong><small>{item.scope} · {item.messages} 条消息</small></span>
          {item.active_run && <span className="assistant-pulse" aria-label="进行中" />}
        </button>
        <Menu label={`${item.title || "对话"} 的操作`} items={[
          { label: "重命名", icon: "edit", onSelect: () => { setRenaming(item); setTitle(item.title ?? ""); } },
          { label: "归档", icon: "archive", onSelect: () => void ai.updateConversation(item.id, { archived: true }).then(() => { toast.success("已归档"); onChanged(); }).catch(reason => toast.error(api.errorMessage(reason, "操作失败"))) },
          { label: "删除", icon: "trash", danger: true, divider: true, onSelect: () => void ai.deleteConversation(item.id).then(() => { toast.success("对话已删除"); onChanged(item.id); }).catch(reason => toast.error(api.errorMessage(reason, "删除失败"))) },
        ]} />
      </li>)}</ul>
    </section>)}
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
