/**
 * 文件助手的消息流（docs/assistant-design.md §19.3–19.4）：按轮组织，每轮依次是思考、过程时间线（工具调用与中间说明）、
 * 卡片（提问、作用域、待确认操作、HTTP 请求、浏览器动作）与最终回复。运行中的思考与工具调用来自事件流（live）。
 * 卡片全部由服务端冻结的数据渲染，不使用模型生成的描述。
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import * as ai from "../assistant-api";
import { Markdown } from "../markdown";
import { MessageAttachments } from "./assistant-attachments";
import { usePreview } from "./preview-host";
import { FileGlyph, getFileKind, parentPath } from "../files";
import { FolderPicker } from "./folders";
import { passkeyUnavailable, privatePasskeyAssertion } from "../passkeys";
import { createThumbnails, generateLoadedThumbnails, thumbnailSource } from "../thumbnails";
import { useCacheQueue } from "./cache";
import { cacheFileId, cacheStats, cacheSupported } from "../cache-client";
import { Notice as InlineNotice, ButtonLink, AssistantMark, Badge, type AssistantMarkState, Button, Checkbox, Icon, Modal, Progress, SkeletonRows, copyText, formatBytes, formatDateTime, toast, type IconName, type Tone } from "../ui";

/** 对象键的显示路径：私密空间的条目显示为相对私密空间根的路径。 */
const display = (key: string) => "/" + (api.isPrivatePath(key) ? key.slice(api.PRIVATE_PREFIX.length) : key);
const baseName = (key: string) => key.replace(/\/$/, "").split("/").pop() || key;
const parentOf = (key: string) => { const trimmed = key.replace(/\/$/, ""); return trimmed.includes("/") ? trimmed.slice(0, trimmed.lastIndexOf("/") + 1) : ""; };
const seconds = (ms: number) => ms < 1000 ? "不到 1 秒" : `${Math.round(ms / 1000)} 秒`;
const duration = (ms: number | null | undefined) => ms == null ? "" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

export type LiveRun = {
  reasoning: string; reasoningStartedAt: number | null; streaming: string;
  tools: { callId: string; name: string; label: string }[]; phase: "queued" | "thinking" | "tool" | "writing" | null; queue?: number;
};
export type HttpApproval = { callId: string; toolCallId: string; runId: string; expires: number; requestedAt: number; request: ai.HttpRequestPreview;
  status: "pending" | "error" | ai.HttpDecision };

/** 运行阶段到头像动效：调用工具时咬合扫描，输出回复时呼吸，其余（排队、思考）环绕。 */
export function markState(live: LiveRun | null | undefined): AssistantMarkState {
  if (!live) return "idle";
  return live.phase === "tool" ? "tool" : live.phase === "writing" ? "writing" : "thinking";
}

/** 头像状态：工具调用通常只有几毫秒，每次开始调用后至少保持一个动效周期（1.4 秒）的「咬合扫描」，避免一闪而过。 */
export function useMarkState(live: LiveRun | null | undefined): AssistantMarkState {
  const raw = markState(live);
  const tools = live?.tools.length ?? 0;
  const [holdUntil, setHoldUntil] = useState(0);
  const [, rerender] = useState(0);
  useEffect(() => { if (tools) setHoldUntil(Date.now() + 1400); }, [tools]);
  useEffect(() => {
    const wait = holdUntil - Date.now();
    if (wait <= 0) return;
    const timer = window.setTimeout(() => rerender(value => value + 1), wait);
    return () => window.clearTimeout(timer);
  }, [holdUntil]);
  return live && raw !== "tool" && Date.now() < holdUntil ? "tool" : raw;
}

export function useNow(active: boolean, interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [active, interval]);
  return now;
}

function ActivityDots() {
  return <span className="ai-activity" aria-hidden="true"><i /><i /><i /></span>;
}

/* ---------- 分组 ---------- */

type Step =
  | { kind: "thinking"; key: string; text: string; ms: number | null; live?: boolean; startedAt?: number | null }
  | { kind: "tool"; key: string; message?: ai.ChatMessage; pending?: { name: string; label: string } }
  | { kind: "note"; key: string; text: string };
type Turn = { key: string; user?: ai.ChatMessage; steps: Step[]; cards: ai.ChatMessage[]; answer?: ai.ChatMessage; notices: ai.ChatMessage[];
  runId: string | null; modelId?: number; input: number; output: number; startedAt?: number; endedAt?: number };
type Item = { kind: "turn"; turn: Turn } | { kind: "event"; message: ai.ChatMessage };
const SYSTEM_EVENTS = ["scope_changed", "scope_rejected", "mode_changed", "model_switched", "action_result", "summary"];

function group(messages: ai.ChatMessage[]): Item[] {
  const items: Item[] = [];
  const plans = new Map<string, { turn: Turn; index: number }>();
  let turn: Turn | null = null;
  const ensure = (message: ai.ChatMessage): Turn => {
    if (!turn) { turn = { key: `t${message.seq}`, steps: [], cards: [], notices: [], runId: message.run_id, input: 0, output: 0, startedAt: message.created_at }; items.push({ kind: "turn", turn }); }
    turn.runId = turn.runId ?? message.run_id;
    if (message.created_at) turn.endedAt = message.created_at;
    return turn;
  };
  for (const message of messages) {
    if (message.role === "user") {
      turn = { key: `t${message.seq}`, user: message, steps: [], cards: [], notices: [], runId: message.run_id, input: 0, output: 0, startedAt: message.created_at };
      items.push({ kind: "turn", turn });
      continue;
    }
    if (message.event?.type === "plan") {
      const id = message.event.id ?? `legacy-${ensure(message).key}`;
      const existing = plans.get(id);
      if (existing) {
        const previous = existing.turn.cards[existing.index].event as ai.PlanEvent;
        if ((message.event.version ?? 0) >= (previous.version ?? 0)) existing.turn.cards[existing.index] = message;
      } else {
        const current = ensure(message);
        plans.set(id, { turn: current, index: current.cards.length });
        current.cards.push(message);
      }
      continue;
    }
    if (message.role === "event" && (SYSTEM_EVENTS.includes(message.type ?? "") || !message.run_id && !["error", "stopped", "limit"].includes(message.type ?? ""))) {
      items.push({ kind: "event", message });
      continue;
    }
    const current = ensure(message);
    if (message.role === "event") { current.notices.push(message); continue; }
    if (message.role === "assistant") {
      current.modelId = message.model_id ?? current.modelId;
      current.input += message.input_tokens ?? 0;
      current.output += message.output_tokens ?? 0;
      if (message.reasoning) current.steps.push({ kind: "thinking", key: `r${message.seq}`, text: message.reasoning, ms: message.reasoning_ms ?? null });
      const text = message.text?.trim() ?? "";
      if (message.tool_calls?.length) {
        if (text) current.steps.push({ kind: "note", key: `n${message.seq}`, text });
      } else if (text) {
        if (current.answer?.text) current.steps.push({ kind: "note", key: `n${current.answer.seq}`, text: current.answer.text });
        current.answer = message;
      }
      continue;
    }
    if (message.role === "tool") {
      if (message.event) {
        current.cards.push(message);
      } else current.steps.push({ kind: "tool", key: `s${message.seq}`, message });
    }
  }
  return items;
}

/* ---------- 消息流 ---------- */

/** 私密对话的链接放行规则：只有对话中出现过的地址可以点击（§24.8）；普通对话不限制。 */
const LinkContext = createContext<((href: string) => boolean) | undefined>(undefined);

export function latestPlan(messages: ai.ChatMessage[]): ai.PlanEvent | null {
  let latest: ai.PlanEvent | null = null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const event = messages[index].event;
    if (event?.type !== "plan") continue;
    if (!latest) latest = event;
    else if (latest.id && event.id === latest.id && (event.version ?? 0) > (latest.version ?? 0)) latest = event;
  }
  return latest;
}

function canResumePlan(plan: ai.PlanEvent, running: boolean): boolean {
  return !running && Boolean(plan.id) && plan.status !== "completed"
    && !plan.items.some(item => item.status === "waiting_user" || item.status === "in_progress");
}

export function Thread({ detail, live, liveModel, modelLabel, runId, httpApprovals, onHttpDecision, onAnswer, onScope, onRetry, onActionChanged, onFilesChanged }: {
  detail: ai.ConversationDetail; live: LiveRun | null; liveModel?: string; modelLabel: (id: number | null | undefined) => string; runId: string | null;
  httpApprovals: HttpApproval[]; onHttpDecision: (callId: string, decision: ai.HttpDecision) => void;
  /** 从这条用户消息重新回答（丢弃之后的记录）。 */
  onAnswer: (text: string) => void; onScope: (id: string, approve: boolean) => void; onRetry?: (seq: number) => void;
  onActionChanged: () => void; onFilesChanged?: () => void;
}) {
  const running = Boolean(runId);
  const items = useMemo(() => group(detail.messages), [detail.messages]);
  const lastQuestion = [...detail.messages].reverse().find(message => message.event?.type === "question");
  const answered = lastQuestion ? detail.messages.some(message => message.role === "user" && message.seq > lastQuestion.seq) : true;
  const lastTurn = [...items].reverse().find(item => item.kind === "turn");
  const lastPlan = latestPlan(detail.messages);
  const resumablePlan = lastPlan && canResumePlan(lastPlan, running) ? lastPlan.id : undefined;
  const links = detail.links;
  const allowLink = useMemo(() => {
    if (!links) return undefined;
    const allowed = new Set(links);
    return (href: string) => { const value = href.split("#", 1)[0]; return allowed.has(value) || allowed.has(value.replace(/\/$/, "")); };
  }, [links]);
  return <LinkContext.Provider value={allowLink}>
    {items.map(item => item.kind === "event" ? <SystemEvent key={`e${item.message.seq}`} message={item.message} />
      : <TurnView key={item.turn.key} turn={item.turn} live={item === lastTurn && running ? live : null}
          model={item.turn.modelId != null ? modelLabel(item.turn.modelId) : item === lastTurn && running ? liveModel ?? "" : ""}
          actions={detail.actions} messages={detail.messages} canAnswer={!running && !answered} questionSeq={lastQuestion?.seq}
          resumablePlan={resumablePlan}
          httpApprovals={httpApprovals.filter(approval => approval.runId === (item.turn.runId ?? (item === lastTurn ? runId : null)))} onHttpDecision={onHttpDecision}
          onAnswer={onAnswer} onScope={onScope} onRetry={!running ? onRetry : undefined}
          onActionChanged={onActionChanged} onFilesChanged={onFilesChanged} />)}
    {running && live && (!lastTurn || lastTurn.kind !== "turn") && <TurnView turn={{ key: "live", steps: [], cards: [], notices: [], runId: null, input: 0, output: 0 }}
      live={live} model="" actions={[]} messages={[]} canAnswer={false} httpApprovals={httpApprovals.filter(approval => approval.runId === runId)} onHttpDecision={onHttpDecision}
      onAnswer={onAnswer} onScope={onScope} onActionChanged={onActionChanged} />}
  </LinkContext.Provider>;
}

function SystemEvent({ message }: { message: ai.ChatMessage }) {
  const icon: IconName = message.type === "mode_changed" ? "zap" : message.type === "model_switched" ? "server"
    : message.type?.startsWith("scope") ? "folder" : message.type === "action_result" ? "checkCircle" : "info";
  return <div className="ai-divider" role="note"><span><Icon name={icon} size={12} />{message.text}</span></div>;
}

function TurnView({ turn, live, model, actions, messages, canAnswer, questionSeq, resumablePlan, httpApprovals, onHttpDecision, onAnswer, onScope, onRetry, onActionChanged, onFilesChanged }: {
  turn: Turn; live: LiveRun | null; model: string; actions: ai.AssistantAction[]; messages: ai.ChatMessage[]; canAnswer: boolean; questionSeq?: number;
  resumablePlan?: string;
  onAnswer: (text: string) => void; onScope: (id: string, approve: boolean) => void; onRetry?: (seq: number) => void;
  onActionChanged: () => void; onFilesChanged?: () => void;
  httpApprovals: HttpApproval[]; onHttpDecision: (callId: string, decision: ai.HttpDecision) => void;
}) {
  const steps = [...turn.steps];
  const retry = turn.user && onRetry ? () => onRetry(turn.user!.seq) : undefined;
  if (live) {
    if (live.reasoning) steps.push({ kind: "thinking", key: "live-thinking", text: live.reasoning, ms: null, live: true, startedAt: live.reasoningStartedAt });
    for (const tool of live.tools) if (!httpApprovals.some(approval => approval.toolCallId === tool.callId)) steps.push({ kind: "tool", key: `live-${tool.callId}`, pending: tool });
  }
  const streaming = live?.streaming ?? "";
  const mark = useMarkState(live);
  const allowLink = useContext(LinkContext);
  const waiting = httpApprovals.some(approval => approval.status === "pending");
  const plans = turn.cards.filter(message => message.event?.type === "plan");
  const cards: { key: string; at: number; message?: ai.ChatMessage; approval?: HttpApproval }[] = turn.cards.filter(message => message.event?.type !== "plan").map(message => ({
    key: message.event?.type === "http_request" ? `${message.run_id}:${message.event.id}` : `card-${message.seq}`,
    at: message.event?.type === "http_request" ? message.event.requested_at : message.created_at ?? 0, message,
  }));
  for (const approval of httpApprovals) if (!cards.some(card => card.key === approval.callId)) cards.push({ key: approval.callId, at: approval.requestedAt, approval });
  cards.sort((a, b) => a.at - b.at);
  const hasAssistant = steps.length > 0 || turn.cards.length > 0 || httpApprovals.length > 0 || turn.answer || streaming || turn.notices.length > 0 || live;
  return <div className="ai-turn">
    {turn.user && <UserMessage message={turn.user} onRetry={retry} />}
    {hasAssistant && <div className={`ai-reply${live ? " is-live" : ""}`}>
      <span className="ai-avatar" aria-hidden="true"><AssistantMark state={waiting ? "idle" : mark} /></span>
      <div className="ai-reply-body">
        <div className="ai-reply-head"><strong>文件助手</strong>{model && <span className="ai-model" title={model}>{model}</span>}
          {live && <LiveStatus live={live} waiting={waiting} />}</div>
        {plans.map(message => message.event?.type === "plan" && <PlanCard key={message.event.id ?? turn.key} plan={message.event}
          canContinue={Boolean(resumablePlan) && message.event.id === resumablePlan}
          onContinue={() => onAnswer("继续当前计划，从尚未完成的步骤继续，先核对已有结果，避免重复执行。")} />)}
        {steps.length > 0 && <Process steps={steps} live={Boolean(live)} />}
        {cards.map(card => {
          const event = card.message?.event;
          const http = card.approval ?? (event?.type === "http_request" ? { request: event.request, status: event.decision } : null);
          if (http) return <HttpRequestCard key={card.key} request={http.request} decision={http.status} approval={card.approval} message={card.message} onDecide={onHttpDecision} />;
          const message = card.message!;
          return <Card key={card.key} message={message} actions={actions} running={Boolean(live)}
            selectedAnswer={event?.type === "question" ? messages.find(item => item.role === "user" && item.seq > message.seq)?.text : undefined}
            canAnswer={canAnswer && message.seq === questionSeq} onAnswer={onAnswer} onScope={onScope} onActionChanged={onActionChanged} onFilesChanged={onFilesChanged} />;
        })}
        {(turn.answer || streaming) && <div className="ai-answer">
          <Markdown source={streaming || turn.answer?.text || ""} allowLink={allowLink} />{streaming && <i className="ai-caret" aria-hidden="true" />}
        </div>}
        {turn.notices.map(notice => <Notice key={notice.seq} message={notice} onRetry={notice.retry ? retry : undefined} />)}
        {!live && (turn.answer || turn.output > 0) && <div className="ai-reply-foot">
          {turn.endedAt && <span>{formatDateTime(turn.endedAt)}</span>}
          {turn.answer?.text && <button type="button" onClick={() => copyMessage(turn.answer?.text ?? "")}><Icon name="copy" size={12} />复制</button>}
        </div>}
      </div>
    </div>}
  </div>;
}

function LiveStatus({ live, waiting = false }: { live: LiveRun; waiting?: boolean }) {
  const label = waiting ? "等待确认" : live.phase === "queued" ? `排队中${live.queue ? `，前面 ${live.queue} 个` : ""}`
    : live.tools.length ? `正在${live.tools.at(-1)!.label}` : live.streaming ? "正在回复" : live.reasoning ? "正在思考" : "正在准备";
  return <span className="ai-live" role="status"><i aria-hidden="true" /><span className={waiting ? undefined : "ai-shimmer"}>{label}</span></span>;
}

/** 消息里的 @ 引用：与文件列表相同的类型图标 + 名称，完整路径在提示里。 */
function renderMention(path: string) {
  return <span className="md-mention" title={path}><FileGlyph kind={path.endsWith("/") ? "folder" : getFileKind(null, path)} size={14} />
    <span>{path.replace(/\/$/, "").split("/").at(-1) || "/"}</span></span>;
}

function UserMessage({ message, onRetry }: { message: ai.ChatMessage; onRetry?: () => void }) {
  return <div className="ai-user">
    {message.attachments?.length ? <MessageAttachments items={message.attachments.filter(item => typeof item === "object" && item?.id)}
      location={(message.location ?? "").replace(/^\//, "")} /> : null}
    {message.attachment && <span className="ai-attachment"><Icon name="globe" size={13} />
      <span>{message.attachment.source.replace(/^https?:\/\//, "")} · {message.attachment.pages} 页 · {message.attachment.images.toLocaleString("zh-CN")} 个图片候选</span></span>}
    {/* 用户输入的 Markdown（列表、加粗、代码等）与回复使用同一个安全渲染器，不执行原始 HTML；@ 引用就地显示为胶囊。 */}
    <div className="ai-bubble"><Markdown source={message.text ?? ""} mentions={message.mentions} renderMention={renderMention} linkIcon /></div>
    <span className="ai-user-meta">{message.created_at ? formatDateTime(message.created_at) : ""}
      {onRetry && <button type="button" onClick={onRetry} title="从这条消息重新回答，之后的记录会被丢弃"><Icon name="refresh" size={12} />重试</button>}
      <button type="button" onClick={() => copyMessage(message.text ?? "")}><Icon name="copy" size={12} />复制</button></span>
  </div>;
}

function Notice({ message, onRetry }: { message: ai.ChatMessage; onRetry?: () => void }) {
  const tone = message.type === "error" ? "is-error" : message.type === "limit" ? "is-warning" : "";
  return <p className={`ai-notice ${tone}`}><Icon name={message.type === "error" ? "alert" : message.type === "stopped" ? "stop" : "info"} size={14} />
    <span>{message.text}</span>{onRetry && <button type="button" onClick={onRetry}>重试</button>}</p>;
}

export function copyMessage(text: string) {
  void copyText(text, "已复制");
}

/* ---------- 过程时间线 ---------- */

function Process({ steps, live }: { steps: Step[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const tools = steps.filter(step => step.kind === "tool");
  const executed = tools.filter(step => step.kind === "tool" && step.message?.status !== "limited" && step.message?.status !== "cancelled");
  const failed = tools.filter(step => step.kind === "tool" && step.message?.status === "error").length;
  const thinkingMs = steps.reduce((sum, step) => sum + (step.kind === "thinking" ? step.ms ?? 0 : 0), 0);
  const thought = steps.some(step => step.kind === "thinking");
  const toolMs = tools.reduce((sum, step) => sum + (step.kind === "tool" ? step.message?.duration_ms ?? 0 : 0), 0);
  // 运行中始终展开；只有一个思考步骤时直接显示，不再套一层折叠。
  if (live || (steps.length === 1 && steps[0].kind === "thinking")) return <div className="ai-process">{steps.map(step => <StepView key={step.key} step={step} />)}</div>;
  const parts = [thought ? (thinkingMs ? `思考 ${seconds(thinkingMs)}` : "思考") : "", executed.length ? `使用 ${executed.length} 个工具` : "",
    toolMs >= 1000 ? `耗时 ${seconds(toolMs)}` : ""].filter(Boolean);
  return <div className={`ai-process is-collapsible${open ? " is-open" : ""}`}>
    <button type="button" className="ai-process-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="ai-process-icons" aria-hidden="true">{thought && <Icon name="brain" size={13} />}{tools.length > 0 && <Icon name="wrench" size={13} />}</span>
      <span>{parts.join(" · ") || `${steps.length} 个步骤`}</span>
      {failed > 0 && <span className="ai-process-error">{failed} 项出错</span>}
      <Icon name="chevronDown" size={14} />
    </button>
    {open && <div className="ai-process-steps">{steps.map(step => <StepView key={step.key} step={step} />)}</div>}
  </div>;
}

function StepView({ step }: { step: Step }) {
  if (step.kind === "thinking") return <Thinking text={step.text} ms={step.ms} live={step.live} startedAt={step.startedAt ?? null} />;
  if (step.kind === "note") return <div className="ai-step ai-note"><span className="ai-step-dot" aria-hidden="true" /><div className="ai-note-text"><NoteMarkdown text={step.text} /></div></div>;
  return <ToolStep message={step.message} pending={step.pending} />;
}

function NoteMarkdown({ text }: { text: string }) {
  return <Markdown source={text} allowLink={useContext(LinkContext)} />;
}

function Thinking({ text, ms, live, startedAt }: { text: string; ms: number | null; live?: boolean; startedAt: number | null }) {
  const [open, setOpen] = useState(false);
  const now = useNow(Boolean(live));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (live && box.current) box.current.scrollTop = box.current.scrollHeight; }, [text, live]);
  if (live) {
    const elapsed = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
    return <div className="ai-step ai-thinking is-live">
      <span className="ai-step-dot" aria-hidden="true"><Icon name="brain" size={12} /></span>
      <div className="ai-thinking-body">
        <div className="ai-thinking-head"><span className="ai-shimmer">正在思考</span><span className="ai-thinking-time">{elapsed} 秒</span></div>
        <div className="ai-thinking-stream" ref={box} aria-live="off">{text}</div>
      </div>
    </div>;
  }
  return <div className={`ai-step ai-thinking${open ? " is-open" : ""}`}>
    <span className="ai-step-dot" aria-hidden="true"><Icon name="brain" size={12} /></span>
    <div className="ai-thinking-body">
      <button type="button" className="ai-thinking-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span>{ms ? `已思考 ${seconds(ms)}` : "思考过程"}</span><Icon name="chevronDown" size={13} />
      </button>
      {open ? <div className="ai-thinking-text">{text}</div> : <p className="ai-thinking-preview">{text.replace(/\s+/g, " ").slice(0, 160)}</p>}
    </div>
  </div>;
}

const TOOL_ICONS: [RegExp, IconName][] = [
  [/^propose_save_attachment/, "paperclip"], [/^ui_generate_thumbnails/, "image"],
  [/^(list_folder|folder_tree|find_empty)/, "folder"], [/^(search_files|find_large|find_duplicates)/, "search"],
  [/^(storage_stats|trash_stats)/, "pulse"], [/^(list_trash)/, "trash"], [/^read_text_file/, "fileText"], [/^get_file_info/, "file"],
  [/^(list_public|propose_share|propose_unshare)/, "link"], [/download/, "download"], [/^(analyze_page|collect_gallery|parse_download)/, "globe"],
  [/^(ui_|browser_)/, "cursor"], [/^propose_/, "edit"], [/^(get_context|request_scope)/, "info"], [/^list_recent/, "list"],
];
const toolIcon = (name = ""): IconName => TOOL_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? "wrench";

function primaryArg(args?: Record<string, unknown>): string {
  if (!args) return "";
  const match = args.match as Record<string, unknown> | undefined;
  const list = (args.paths ?? args.sources) as unknown[] | undefined;
  const value = args.path ?? args.query ?? args.url ?? args.target ?? match?.path ?? match?.glob ?? (Array.isArray(list) && list.length ? `${list[0]}${list.length > 1 ? ` 等 ${list.length} 项` : ""}` : undefined)
    ?? args.template ?? args.by ?? args.text;
  return typeof value === "string" ? value.slice(0, 80) : typeof value === "number" ? String(value) : "";
}

function ToolStep({ message, pending }: { message?: ai.ChatMessage; pending?: { name: string; label: string } }) {
  const [open, setOpen] = useState(false);
  const name = message?.name ?? pending?.name;
  const failed = message?.status === "error";
  const skipped = message?.status === "limited" || message?.status === "cancelled";
  const arg = primaryArg(message?.arguments);
  const state = pending ? "is-running" : failed ? "is-error" : skipped ? "is-skipped" : "is-ok";
  return <div className={`ai-step ai-tool ${state}${open ? " is-open" : ""}`}>
    <span className="ai-step-dot" aria-hidden="true">{pending ? <ActivityDots /> : <Icon name={failed ? "alert" : skipped ? "stop" : toolIcon(name)} size={12} />}</span>
    <div className="ai-tool-body">
      <button type="button" className="ai-tool-head" aria-expanded={open} disabled={!message} onClick={() => setOpen(value => !value)}>
        <strong>{message?.label ?? pending?.label ?? name}</strong>
        {arg && <code title={arg}>{arg}</code>}
        <span className="ai-tool-result">{pending ? <span className="ai-shimmer">进行中</span> : message?.summary}</span>
        {message?.duration_ms != null && <span className="ai-tool-time">{duration(message.duration_ms)}</span>}
        {message && <Icon name="chevronDown" size={13} />}
      </button>
      {open && message && <ToolDetail message={message} />}
    </div>
  </div>;
}

function ToolDetail({ message }: { message: ai.ChatMessage }) {
  const args = Object.entries(message.arguments ?? {});
  const result = JSON.stringify(message.result, null, 2) ?? "";
  return <div className="ai-tool-detail">
    {args.length > 0 && <dl className="ai-kv">{args.map(([key, value]) => <div key={key}><dt>{key}</dt>
      <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl>}
    <div className="ai-tool-output">
      <div className="ai-tool-output-head"><span>结果{message.truncated ? "（已截断）" : ""}</span>
        <button type="button" onClick={() => copyMessage(result)}><Icon name="copy" size={12} />复制</button></div>
      <pre>{result}</pre>
    </div>
  </div>;
}

/* ---------- 卡片 ---------- */

function Card({ message, actions, running, selectedAnswer, canAnswer, onAnswer, onScope, onActionChanged, onFilesChanged }: {
  message: ai.ChatMessage; actions: ai.AssistantAction[]; running: boolean; selectedAnswer?: string; canAnswer: boolean;
  onAnswer: (text: string) => void; onScope: (id: string, approve: boolean) => void; onActionChanged: () => void; onFilesChanged?: () => void;
}) {
  const event = message.event!;
  if (event.type === "plan") return null;
  if (event.type === "question") return <QuestionCard question={event.question} options={event.options} selected={selectedAnswer} canAnswer={canAnswer} onAnswer={onAnswer} />;
  if (event.type === "scope_request") return <ScopeCard event={event} action={actions.find(item => item.id === event.action_id)} running={running} onScope={onScope} />;
  if (event.type === "action") return <ActionCard id={event.action_id} action={actions.find(item => item.id === event.action_id)} fallback={event}
    onChanged={onActionChanged} onFilesChanged={onFilesChanged} />;
  if (event.type === "browser") return <BrowserCard event={event} />;
  return null;
}

function CardHead({ icon, tone = "accent", title, subtitle, badge }: { icon: IconName; tone?: Tone; title: string; subtitle?: string; badge?: ReactNode }) {
  return <header className="ai-card-head">
    <span className={`ai-card-icon tone-${tone}`}><Icon name={icon} size={16} /></span>
    <span className="ai-card-title"><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
    {badge}
  </header>;
}

/** 确认只回传决定；请求内容由服务端冻结，完成后以加密工具消息中的预览与结果替换实时卡片。 */
function HttpRequestCard({ request, decision, approval, message, onDecide }: {
  request: ai.HttpRequestPreview; decision: HttpApproval["status"]; approval?: HttpApproval; message?: ai.ChatMessage;
  onDecide?: (callId: string, decision: ai.HttpDecision) => void;
}) {
  const now = useNow(decision === "pending");
  const remaining = Math.max(0, Math.ceil(((approval?.expires ?? now) - now) / 1000));
  const status = decision === "pending" && !remaining ? "expired" : decision;
  const pending = status === "pending";
  const label = pending ? "待确认" : status === "approved" ? message ? message.status === "ok" ? "已响应" : "执行失败" : "已同意"
    : status === "rejected" ? "已拒绝" : status === "expired" ? "已过期" : status === "error" ? "回传失败" : "已取消";
  const tone: Tone = pending ? "warning" : status === "approved" && message?.status === "ok" ? "success"
    : status === "error" || status === "approved" && message?.status === "error" ? "danger" : "neutral";
  return <section className={`ai-card ai-http is-${status}`} aria-label="HTTP 请求">
    <CardHead icon="globe" tone={pending ? "warning" : "accent"} title="HTTP 请求" subtitle={`${request.method} · 正文 ${formatBytes(request.body_bytes)}`}
      badge={<Badge tone={tone}>{label}</Badge>} />
    <code className="ai-http-target">{request.url}</code>
    {pending && <p className="ai-card-note"><Icon name="globe" size={13} />从服务器发送，可能修改第三方数据或产生费用，请核对请求。</p>}
    <details className="ai-http-details"><summary>请求详情</summary><div className="ai-http-preview">
      <h4>请求头</h4><pre>{Object.entries(request.headers).map(([key, value]) => `${key}: ${value}`).join("\n") || "无自定义请求头"}</pre>
      {request.body !== null && <><h4>{request.body_encoding === "base64" ? "请求正文（Base64）" : "请求正文"}</h4><pre>{request.body || "空正文"}</pre></>}
      <p>认证头及可识别的凭据已隐藏；本次确认仅适用于这一条请求。</p>
    </div></details>
    {message && <><p className="ai-http-summary">{message.summary}</p>
      {status === "approved" && <details className="ai-http-details"><summary>响应结果</summary><ToolDetail message={{ ...message, arguments: undefined }} /></details>}
    </>}
    <footer className="ai-card-foot">
      <span>{pending ? `剩余 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}，超时取消` : status === "approved" ? message ? "已确认本次请求" : "已同意，等待请求结果"
        : status === "error" ? "确认结果回传失败，请等待运行结果或停止本轮" : "未发送请求"}</span>
      {pending && approval && onDecide && <><Button size="sm" onClick={() => onDecide(approval.callId, "rejected")}>拒绝</Button>
        <Button size="sm" variant="primary" onClick={() => onDecide(approval.callId, "approved")}>发送请求</Button></>}
    </footer>
  </section>;
}

const PLAN_LABELS: Record<ai.PlanStatus, string> = { pending: "待执行", in_progress: "执行中", waiting_user: "等待确认", completed: "已完成",
  failed: "失败", paused: "已暂停", cancelled: "已取消" };

function planProgress(plan: ai.PlanEvent) {
  const done = plan.items.filter(item => item.status === "completed").length;
  const status = plan.status ?? (done === plan.items.length ? "completed" : "in_progress");
  const current = plan.items.find(item => item.status === "in_progress" || item.status === "waiting_user");
  const tone: Tone = status === "completed" ? "success" : status === "failed" ? "danger" : status === "waiting_user" ? "warning" : "neutral";
  return { done, status, current, tone };
}

function PlanSteps({ plan }: { plan: ai.PlanEvent }) {
  return <>
    <ol>{plan.items.map((item, index) => <li key={item.id ?? index} className={`is-${item.status}`}>
      <span className="ai-plan-dot" aria-hidden="true">{item.status === "completed" ? <Icon name="check" size={12} />
        : item.status === "in_progress" ? <ActivityDots /> : item.status === "failed" ? <Icon name="alert" size={12} /> : index + 1}</span>
      <div><span className="ai-plan-step"><span>{item.content}</span><small>{PLAN_LABELS[item.status]}</small></span>
        {item.detail && <p className="ai-plan-detail">{item.detail}</p>}</div>
    </li>)}</ol>
    {plan.reason && <p className="ai-plan-reason">调整原因：{plan.reason}</p>}
  </>;
}

/** 位于消息滚动区之外，长任务中随时查看计划，不改变对话的阅读位置。 */
export function PlanBar({ plan, running, onContinue }: { plan: ai.PlanEvent; running: boolean; onContinue: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { done, status, current, tone } = planProgress(plan);
  const panelId = useId();
  const next = current ?? plan.items.find(item => item.status !== "completed");
  const subtitle = next?.content ?? (status === "completed" ? "全部步骤已完成" : "查看完整计划");
  return <section className="assistant-plan-bar ai-plan" aria-label="当前任务计划" onKeyDown={event => {
    if (!expanded || event.key !== "Escape" || event.nativeEvent.isComposing || event.repeat) return;
    event.preventDefault(); event.stopPropagation(); setExpanded(false); trigger.current?.focus({ preventScroll: true });
  }}><div className="assistant-plan-inner">
    <button ref={trigger} type="button" className="assistant-plan-trigger" aria-expanded={expanded} aria-controls={panelId}
      onClick={() => setExpanded(value => !value)}>
      <Icon name="list" size={16} />
      <span className="assistant-plan-summary"><span className="assistant-plan-meta">
        <strong>{plan.title ?? "任务计划"}</strong><span>{done} / {plan.items.length}</span><Badge tone={tone}>{PLAN_LABELS[status]}</Badge>
      </span><small title={subtitle}>{subtitle}</small></span>
      <Icon name="chevronDown" size={14} />
    </button>
    <div id={panelId} className="assistant-plan-panel" hidden={!expanded} role="region" aria-label="完整任务计划" tabIndex={0}
      onPointerDown={event => {
        if (!(event.target as Element).closest("button, a")) event.currentTarget.focus({ preventScroll: true });
        event.stopPropagation();
      }}>
      <PlanSteps plan={plan} />
      {canResumePlan(plan, running) && <div className="assistant-plan-actions"><span>已保留当前进度</span>
        <Button size="sm" onClick={onContinue}>继续任务</Button></div>}
    </div>
  </div></section>;
}

function PlanCard({ plan, canContinue, onContinue }: { plan: ai.PlanEvent; canContinue: boolean; onContinue: () => void }) {
  const { items } = plan;
  const [collapsed, setCollapsed] = useState(plan.status === "completed");
  const { done, status, current, tone } = planProgress(plan);
  return <section className={`ai-card ai-plan is-${status}`} aria-label="任务计划">
    <CardHead icon="list" title={plan.title ?? "处理计划"} subtitle={`${done} / ${items.length} 步骤已完成`}
      badge={<Badge tone={tone}>{PLAN_LABELS[status]}</Badge>} />
    <Progress value={items.length ? done / items.length * 100 : 0} label={`计划步骤完成数：${done} / ${items.length}`} />
    <button type="button" className="ai-plan-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
      <span>{current ? current.content : status === "completed" ? "全部步骤已完成" : "查看计划步骤"}</span>
      <span>{collapsed ? "展开" : "收起"}<Icon name="chevronDown" size={13} /></span>
    </button>
    {!collapsed && <PlanSteps plan={plan} />}
    {canContinue && <footer className="ai-card-foot"><span>已保留当前进度</span>
      <Button size="sm" onClick={onContinue}>继续任务</Button></footer>}
  </section>;
}

function QuestionCard({ question, options, selected, canAnswer, onAnswer }: { question: string; options: string[]; selected?: string; canAnswer: boolean; onAnswer: (text: string) => void }) {
  return <section className={`ai-card ai-question${selected ? " is-answered" : ""}`}>
    <CardHead icon="info" title="需要你的选择" subtitle={question} badge={selected ? <Badge tone="success">已回答</Badge> : undefined} />
    <div className="ai-choices">{options.map((option, index) => <button type="button" key={option} disabled={!canAnswer}
      className={selected === option ? "is-selected" : ""} onClick={() => onAnswer(option)}>
      <span className="ai-choice-key">{selected === option ? <Icon name="check" size={12} /> : String.fromCharCode(65 + index)}</span><span>{option}</span>
    </button>)}</div>
  </section>;
}

function ScopeCard({ event, action, running, onScope }: { event: Extract<ai.ToolEvent, { type: "scope_request" }>; action?: ai.AssistantAction; running: boolean;
  onScope: (id: string, approve: boolean) => void }) {
  if (!action && running) return <section className="ai-card"><SkeletonRows rows={2} /></section>;
  const status = action?.status ?? "expired";
  return <section className={`ai-card ai-scope is-${status}`}>
    <CardHead icon="folder" tone="warning" title="助手请求访问更大的范围" subtitle={action?.payload?.reason ?? event.reason}
      badge={status !== "pending" ? <Badge tone={status === "confirmed" ? "success" : "neutral"}>{status === "confirmed" ? "已允许" : status === "rejected" ? "已拒绝" : "已过期"}</Badge> : undefined} />
    <div className="ai-scope-path"><code>{action?.payload?.from ?? event.from}</code><Icon name="chevronRight" size={14} /><code>{action?.payload?.to ?? event.to}</code></div>
    {status === "pending" && <footer className="ai-card-foot"><span>允许后助手可以处理新范围内的普通文件</span>
      <Button size="sm" onClick={() => onScope(event.action_id, false)}>拒绝</Button>
      <Button size="sm" variant="primary" onClick={() => onScope(event.action_id, true)}>允许</Button></footer>}
  </section>;
}

function BrowserCard({ event }: { event: ai.BrowserEvent }) {
  const [done, setDone] = useState(false);
  if (event.action === "share") return <ShareBrowserCard event={event} />;
  if (event.action === "thumbnails") return <ThumbnailsBrowserCard event={event} />;
  if (event.action === "cache" || event.action === "uncache") return <CacheBrowserCard event={event} />;
  if (event.action === "download") {
    const keys = event.items.map(item => item.path);
    const single = event.items.length === 1 && !event.items[0].folder;
    const href = single ? api.contentUrl(keys[0], true) : api.archiveUrl(keys);
    return <section className="ai-card ai-browser">
      <CardHead icon="download" title={single ? `下载 ${baseName(keys[0])}` : `下载 ${event.items.length} 项（ZIP）`} subtitle={`${formatBytes(event.size)} · 保存到这台电脑`} />
      {!single && <ul className="ai-list">{event.items.slice(0, 5).map(item => <li key={item.path}><Icon name={item.folder ? "folder" : "file"} size={13} /><span className="cell-truncate">{display(item.path)}</span></li>)}</ul>}
      <footer className="ai-card-foot"><span>{done ? "已开始下载" : "浏览器需要你点击后才能下载"}</span>
        <ButtonLink variant="primary" size="sm" icon="download" href={href} onClick={() => setDone(true)} download>下载</ButtonLink></footer>
    </section>;
  }
  if (event.action === "open") return <section className="ai-card ai-browser">
    <CardHead icon="external" title={event.title || "打开网页"} subtitle={event.host} />
    <p className="ai-url" title={event.url}>{event.url}</p>
    <footer className="ai-card-foot"><span>在新标签页中打开</span>
      <ButtonLink variant="primary" size="sm" icon="external" href={event.url} target="_blank" rel="noopener noreferrer">打开</ButtonLink></footer>
  </section>;
  return <section className="ai-card ai-browser">
    <CardHead icon="copy" title={event.title || "可复制的文本"} />
    <pre className="ai-copy-text">{event.text}</pre>
    {event.private && <p className="ai-card-note"><Icon name="lock" size={13} />复制后内容会离开私密空间：剪贴板可以被其他应用读取，锁定后也不会清除。</p>}
    <footer className="ai-card-foot"><span>{done ? "已复制到剪贴板" : `${event.text.length.toLocaleString("zh-CN")} 个字符`}</span>
      <Button size="sm" variant="primary" icon={done ? "check" : "copy"} onClick={() => void copyText(event.text).then(ok => setDone(ok))}>复制</Button></footer>
  </section>;
}

/** 生成缩略图：用户点击后逐个提交给服务器后台生成（优先复用服务器已收到的数据，必要时按预算读取存储），
 * 不经浏览器下载原文件，避免为补图产生出站流量。队列满时等待后继续提交；服务器没有 FFmpeg 时才在当前页面生成。
 * 卡片卸载（切换对话、关闭页面）时停止提交；已提交的任务继续在后台完成。 */
function ThumbnailsBrowserCard({ event }: { event: Extract<ai.BrowserEvent, { action: "thumbnails" }> }) {
  type Run = { phase: "idle" | "running" | "done" | "stopped"; done: number; none: number; failed: number; current: string; local: boolean };
  const [state, setState] = useState<Run>({ phase: "idle", done: 0, none: 0, failed: 0, current: "", local: false });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const pause = (signal: AbortSignal) => new Promise<void>(resolve => { const timer = window.setTimeout(resolve, 5000); signal.addEventListener("abort", () => { window.clearTimeout(timer); resolve(); }, { once: true }); });
  async function start() {
    const signal = (controller.current = new AbortController()).signal;
    const counts = { done: 0, none: 0, failed: 0 }, folders = new Set<string>();
    let local = false;
    setState({ phase: "running", ...counts, current: "", local });
    for (const item of event.items) {
      if (signal.aborted) break;
      setState(value => ({ ...value, current: item.path }));
      const source = thumbnailSource(item.path, item.content_type, item.size);
      if (!source) { counts.none++; setState(value => ({ ...value, ...counts })); continue; }
      try {
        if (!local) {
          for (;;) {
            try { await api.generateThumbnail({ key: item.path, etag: item.etag }); counts.done++; folders.add(parentPath(item.path)); break; }
            catch (reason) {
              const message = api.errorMessage(reason, "");
              if (message.includes("队列已满") && !signal.aborted) { await pause(signal); if (signal.aborted) break; continue; }
              if (message.includes("FFmpeg")) { local = true; setState(value => ({ ...value, local })); }
              else throw reason;
              break;
            }
          }
        }
        if (local && !signal.aborted) {
          // 服务器无法生成时的退路：在当前页面读取文件生成（会产生下载流量）。
          const saved = await generateLoadedThumbnails({ key: item.path, etag: item.etag }, claimSignal => createThumbnails({ url: api.versionedContentUrl(api.contentUrl(item.path), item.etag), size: item.size, signal: claimSignal }, source), event.regenerate, signal);
          if (!saved) counts.failed++; else if (saved.includes("none")) counts.none++; else counts.done++;
          if (saved) folders.add(parentPath(item.path));
        }
      } catch {
        if (signal.aborted) break;
        counts.failed++;
      }
      setState(value => ({ ...value, ...counts }));
    }
    // 后台生成需要一点时间：稍后通知文件页刷新所在目录，只读元数据，不读取原文件。
    if (folders.size) for (const delay of local ? [0] : [5000, 30000, 120000]) window.setTimeout(() => window.dispatchEvent(new CustomEvent("tessera:files-added", { detail: { folders: [...folders] } })), delay);
    setState(value => ({ ...value, ...counts, phase: signal.aborted ? "stopped" : "done", current: "" }));
  }
  const total = event.items.length, processed = state.done + state.none + state.failed;
  const summary = [state.local ? `已生成 ${state.done} 个` : `已提交 ${state.done} 个`, state.none ? `${state.none} 个不支持` : "", state.failed ? `${state.failed} 个失败` : ""].filter(Boolean).join("，");
  return <section className="ai-card ai-browser">
    <CardHead icon="image" title={`为 ${total} 个文件生成缩略图`} subtitle={`${event.regenerate ? "包括重做旧版缩略图 · " : ""}${state.local ? "在当前页面生成" : "由服务器后台生成"}`} />
    {state.phase === "idle" ? <ul className="ai-list">{event.items.slice(0, 5).map(item => <li key={item.path}><Icon name="file" size={13} /><span className="cell-truncate">{display(item.path)}</span></li>)}
      {total > 5 && <li className="ai-list-more">等 {total} 个文件</li>}</ul>
      : <div className="ai-thumbnail-progress">
        <Progress value={total ? processed / total * 100 : 100} label={`${processed} / ${total}`} />
        <p className="cell-truncate">{state.phase === "running" ? `正在提交 ${display(state.current)}` : summary}</p>
      </div>}
    <footer className="ai-card-foot"><span>{state.phase === "idle" ? "网格图与封面计入你的已用空间；服务器优先复用已收到的数据"
      : state.phase === "running" ? `${processed} / ${total}` : state.phase === "stopped" ? `已停止 · ${summary}` : state.local ? "已完成" : "已全部提交，完成后自动刷新"}</span>
      {state.phase === "running" ? <Button size="sm" onClick={() => controller.current?.abort()}>停止</Button>
        : <Button size="sm" variant={state.phase === "idle" ? "primary" : "secondary"} icon={state.phase === "idle" ? "image" : "refresh"} onClick={() => void start()}>{state.phase === "idle" ? "生成" : "重新提交"}</Button>}
    </footer>
  </section>;
}

/** 本机缓存卡片（§26）：缓存会占用这台设备的空间、清除会删除设备上的副本，都等用户点击；卡片点击即确认，不再弹窗。 */
function CacheBrowserCard({ event }: { event: Extract<ai.BrowserEvent, { action: "cache" | "uncache" }> }) {
  const queue = useCacheQueue();
  const [limit, setLimit] = useState<number | null>(null);
  const [phase, setPhase] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [error, setError] = useState("");
  // 执行后缓存状态会变化（清除后 present 为空），完成提示用点击时的数量。
  const [handled, setHandled] = useState(0);
  const caching = event.action === "cache";
  useEffect(() => {
    if (!caching || !queue?.available) return;
    let alive = true;
    void cacheStats().then(stats => { if (alive) setLimit(stats.settings.maxMiB * 1048576); }).catch(() => undefined);
    return () => { alive = false; };
  }, [caching, queue?.available]);
  const files = event.items.map(item => ({ key: item.path, etag: item.etag, size: item.size, content_type: item.content_type }));
  const usable = queue?.available ? files.filter(queue.canCache) : [];
  const present = usable.filter(file => (queue?.cached.get(cacheFileId(file))?.bytes ?? 0) > 0 || queue?.jobs.some(job => cacheFileId(job.file) === cacheFileId(file)));
  const targets = caching ? usable : present;
  const blocked = !cacheSupported() ? "这个浏览器不能使用本机缓存（需要 https:// 访问与较新的浏览器，无痕模式不可用）"
    : !queue?.available ? "这台设备的本机缓存已关闭，可在「设置 → 本机缓存」开启"
    : !usable.length && event.private ? "私密文件需要先在「设置 → 本机缓存」信任这台设备，并保持私密空间解锁"
    : !caching && !present.length && phase !== "done" ? "这些文件在这台设备上没有缓存" : "";
  const total = event.items.length;
  async function run() {
    if (!queue || !targets.length) return;
    setHandled(targets.length);
    if (caching) { queue.enqueueMany(targets); setPhase("done"); return; }
    setPhase("busy"); setError("");
    try { await queue.forget(targets); setPhase("done"); }
    catch (reason) { setError(api.errorMessage(reason, "清除失败，请稍后重试")); setPhase("error"); }
  }
  const skipped = caching ? total - usable.length : 0;
  const note = phase === "done" ? caching ? `已把 ${handled} 个文件加入缓存队列，进度见页面底部的托盘` : `已清除 ${handled} 个文件的本机缓存`
    : blocked || (caching ? `占用这台设备约 ${formatBytes(event.size)}${skipped ? `，${skipped} 个文件无法缓存` : ""}` : `${present.length} 个文件有缓存，云端文件不受影响`);
  return <section className={`ai-card ai-browser${event.private ? " is-private" : ""}`}>
    <CardHead icon={caching ? "monitor" : "trash"} title={caching ? `缓存 ${total} 个文件到本机` : `清除 ${total} 个文件的本机缓存`}
      subtitle={`${formatBytes(event.size)} · 只影响这台设备`} />
    <ul className="ai-list">{event.items.slice(0, 5).map(item => <li key={item.path}><Icon name="file" size={13} /><span className="cell-truncate">{display(item.path)}</span></li>)}
      {total > 5 && <li className="ai-list-more">等 {total} 个文件</li>}</ul>
    {caching && limit !== null && event.size > limit && phase === "idle" && <p className="ai-card-note"><Icon name="alert" size={13} />超过这台设备的缓存上限（{formatBytes(limit)}），较早打开的缓存会被移除。可在「设置 → 本机缓存」调大上限。</p>}
    {error && <p className="ai-card-note tone-danger" role="alert">{error}</p>}
    <footer className="ai-card-foot"><span>{note}</span>
      {phase === "done" ? <Icon name="check" size={16} />
        : <Button size="sm" variant={caching ? "primary" : "danger"} icon={caching ? "monitor" : "trash"} loading={phase === "busy"} disabled={Boolean(blocked) || !targets.length} onClick={() => void run()}>{caching ? "缓存到本机" : "清除"}</Button>}
    </footer>
  </section>;
}

function ShareBrowserCard({ event }: { event: Extract<ai.BrowserEvent, { action: "share" }> }) {
  const [href, setHref] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setHref(""); setError("");
    void ai.shareLink(event.conversation_id, event.path).then(result => {
      if (active) setHref(api.publicLinks(result.token, baseName(event.path), result.public_base_url).page);
    }).catch(reason => { if (active) setError(api.errorMessage(reason, "分享链接读取失败，请稍后重试")); });
    return () => { active = false; };
  }, [event.conversation_id, event.path, retry]);
  return <section className="ai-card ai-browser">
    <CardHead icon="external" title={`打开“${baseName(event.path)}”的分享页`} subtitle="已有公开分享" />
    {error && <p role="alert">{error}</p>}
    <footer className="ai-card-foot"><span>在新标签页中打开</span>
      {href ? <ButtonLink variant="primary" size="sm" icon="external" href={href} target="_blank" rel="noopener noreferrer">打开分享页</ButtonLink>
        : <Button size="sm" loading={!error} disabled={!error} onClick={() => setRetry(value => value + 1)}>{error ? "重试" : "读取分享链接"}</Button>}
    </footer>
  </section>;
}

/* ---------- 待确认操作 ---------- */

const ACTION_ICONS: Record<string, IconName> = { rename: "edit", move: "move", organize: "folder", mkdir: "folderPlus", trash: "trash",
  restore: "restore", purge: "trash", unshare: "link", share: "link", downloads: "download", download_control: "download",
  save_attachment: "paperclip", move_out: "unlock", move_in: "lock" };
const STATUS_LABEL: Record<string, [string, Tone]> = {
  pending: ["待确认", "accent"], running: ["执行中", "accent"], done: ["已完成", "success"], partial: ["部分完成", "warning"],
  failed: ["执行失败", "danger"], cancelled: ["已取消", "neutral"], rejected: ["已拒绝", "neutral"], expired: ["已过期", "neutral"],
  interrupted: ["已中断", "warning"], undoing: ["撤销中", "accent"], undone: ["已撤销", "neutral"],
};
const MOVE_KINDS = ["rename", "move", "organize"];
/** 跨区移动（§24.5.3）：目标目录由用户在卡片上选择。 */
const CROSS_KINDS = ["move_out", "move_in"];
const SHARE_DAYS = [{ value: 0, label: "永久有效" }, { value: 1, label: "1 天" }, { value: 7, label: "7 天" }, { value: 30, label: "30 天" }, { value: 90, label: "90 天" }];

function ItemRow({ kind, item }: { kind: string; item: ai.ActionItem }) {
  if (MOVE_KINDS.includes(kind) && item.from && item.to) {
    const rename = kind === "rename" || parentOf(item.from) === parentOf(item.to);
    return <li className="ai-diff-row"><Icon name={item.folder ? "folder" : "file"} size={13} />
      {rename ? <><del className="cell-truncate" title={baseName(item.from)}>{baseName(item.from)}</del><Icon name="chevronRight" size={12} /><ins className="cell-truncate" title={baseName(item.to)}>{baseName(item.to)}</ins></>
        : <><span className="cell-truncate" title={display(item.from)}>{baseName(item.from)}</span><Icon name="chevronRight" size={12} /><ins className="cell-truncate" title={display(parentOf(item.to))}>{display(parentOf(item.to))}</ins></>}
    </li>;
  }
  if (kind === "downloads") return <li className="ai-diff-row"><Icon name="download" size={13} /><span className="cell-truncate" title={item.name}>{item.name}</span>{item.host && <small>{item.host}</small>}</li>;
  if (kind === "save_attachment") return <li className="ai-diff-row"><Icon name="paperclip" size={13} />
    <span className="cell-truncate" title={item.name}>{(item.name ?? "").replace(/^附件:/, "")}</span><Icon name="chevronRight" size={12} />
    <ins className="cell-truncate" title={display(item.path ?? "")}>{display(parentOf(item.path ?? ""))}</ins></li>;
  if (CROSS_KINDS.includes(kind) && item.from) return <li className="ai-diff-row"><Icon name={item.folder ? "folder" : "file"} size={13} />
    <span className="cell-truncate" title={display(item.from)}>{display(item.from)}</span></li>;
  if (kind === "download_control") return <li className="ai-diff-row"><Icon name="download" size={13} /><span className="cell-truncate">#{item.id} {baseName(item.path ?? "")}</span></li>;
  return <li className="ai-diff-row"><Icon name={item.folder || item.path?.endsWith("/") ? "folder" : "file"} size={13} />
    <span className="cell-truncate" title={display(item.path ?? "")}>{display(item.path ?? "")}</span></li>;
}

function formatClock(seconds: number) {
  const date = new Date(seconds * 1000);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function ActionCard({ id, action, fallback, onChanged, onFilesChanged }: {
  id: string; action?: ai.AssistantAction; fallback: { kind: string; count: number; auto?: boolean }; onChanged: () => void; onFilesChanged?: () => void;
}) {
  const [value, setValue] = useState<ai.AssistantAction | undefined>(action);
  const [busy, setBusy] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [armed, setArmed] = useState(false);
  const [details, setDetails] = useState(false);
  const [shareDays, setShareDays] = useState<number | null>(null);
  const [password, setPassword] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [targetReady, setTargetReady] = useState(false);
  const [verify, setVerify] = useState("");
  // 通行密钥断言只用于这一次确认：随确认请求提交，不在界面里保存。
  const passkeyAssertion = useRef<{ request_id: string; credential: unknown } | null>(null);
  useEffect(() => { if (action) setValue(current => !current || action.status !== current.status || action.finished_at !== current.finished_at ? action : current); }, [action]);
  const status = value?.status ?? "pending";
  const live = status === "running" || status === "undoing";
  const now = useNow(status === "pending") / 1000;
  const expired = status === "pending" && value != null && value.expires_at <= now;
  // 执行中轮询进度；无论终态来自轮询还是对话刷新，只要经历过执行就刷新文件列表。
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
  const touched = useRef(Boolean(fallback.auto));
  useEffect(() => {
    if (live) touched.current = true;
    else if (touched.current && status !== "pending") { touched.current = false; onFilesChanged?.(); }
  }, [live, status]);
  const run = useCallback(async (label: string, task: () => Promise<ai.AssistantAction>) => {
    setBusy(label);
    try {
      const fresh = await task();
      if (fresh.status === "running" || fresh.status === "undoing" || label === "undo") touched.current = true;
      setValue(fresh);
      onChanged();
    } catch (reason) { toast.error(api.errorMessage(reason, "操作没有完成，请稍后重试")); onChanged(); }
    finally { setBusy(null); setArmed(false); }
  }, [onChanged]);

  if (!value) return <section className="ai-card ai-action is-loading"><SkeletonRows rows={2} /></section>;
  const payload = value.payload ?? {};
  const kind = value.kind || fallback.kind;
  const danger = Boolean(payload.danger);
  const share = kind === "share";
  const auto = Boolean(payload.auto);
  const many = value.count > 1000;
  const pending = status === "pending" && !expired;
  const [label, tone] = STATUS_LABEL[expired ? "expired" : status] ?? [status, "neutral" as Tone];
  const samples = payload.samples ?? [];
  const progress = value.progress;
  const result = value.result;
  const days = shareDays ?? payload.options?.expires_days ?? 0;
  const cross = CROSS_KINDS.includes(kind);
  const moveOut = kind === "move_out";
  // 移出的目标是普通目录（对象键）；移入的目标是私密空间里的目录（对象键带私密前缀，提交时去掉）。
  const chosen = target ?? (moveOut ? payload.options?.target ?? "" : api.PRIVATE_PREFIX);
  const unlocked = Boolean(api.getPrivateAccess());
  const crossBlocked = cross && (!targetReady || (moveOut ? !verify && !password : !unlocked));
  const crossInput = () => ({ target: moveOut ? chosen : chosen.slice(api.PRIVATE_PREFIX.length) });
  const iconTone: Tone = danger || moveOut ? "danger" : share ? "public" : status === "done" ? "success" : "accent";
  return <section className={`ai-card ai-action is-${expired ? "expired" : status}${danger || moveOut ? " is-danger" : ""}`}>
    <CardHead icon={ACTION_ICONS[kind] ?? "check"} tone={iconTone} title={payload.title ?? ai.ACTION_KINDS[kind] ?? kind} subtitle={payload.summary}
      badge={<Badge tone={danger && pending ? "danger" : tone} icon={auto && !pending ? "zap" : undefined}>{danger && pending ? "不可恢复" : auto && status === "done" ? "已自动执行" : label}</Badge>} />
    <div className="ai-chips">
      <span><Icon name="folder" size={12} />{display(payload.scope ?? "")}</span>
      <span>{value.count.toLocaleString("zh-CN")} 项</span>
      {payload.size ? <span>{formatBytes(payload.size)}</span> : null}
      {kind === "downloads" && payload.options?.target != null && <span><Icon name="download" size={12} />保存到 {display(payload.options.target)}</span>}
      {cross && !pending && <span><Icon name={moveOut ? "unlock" : "lock"} size={12} />{moveOut ? "移到普通文件" : "移入私密空间"}</span>}
      {(payload.conflicts ?? 0) > 0 && <span className="tone-warning">{payload.conflicts} 项将跳过</span>}
    </div>
    {payload.confirm_reason && pending && <p className="ai-card-note"><Icon name="shield" size={13} />{payload.confirm_reason}</p>}
    {samples.length > 0 && !result?.links && <ul className="ai-diff">{samples.slice(0, 6).map((item, index) => <ItemRow key={index} kind={kind} item={item} />)}</ul>}
    {(value.count > 6 || (payload.conflicts ?? 0) > 0) && <button type="button" className="ai-link" onClick={() => setDetails(true)}>查看全部 {value.count.toLocaleString("zh-CN")} 项</button>}
    {share && pending && <div className="ai-share-form">
      <label><span>有效期</span><select className="input input-sm" value={days} onChange={event => setShareDays(Number(event.target.value))}>
        {SHARE_DAYS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label><span>访问密码{payload.options?.require_password ? "（建议设置）" : "（可选）"}</span>
        <input className="input input-sm" type="password" autoComplete="new-password" value={password} placeholder="4 位以上，留空为不设密码"
          onChange={event => setPassword(event.target.value)} /></label>
      <small>密码只用于这次分享，不会发送给助手或模型。</small>
    </div>}
    {cross && pending && <div className="ai-cross-form">
      <div className="ai-cross-label"><Icon name={moveOut ? "folder" : "lock"} size={13} />
        <span>{moveOut ? "移到「我的文件」中的" : "移入「私密空间」中的"} <strong>{display(chosen)}</strong></span></div>
      {moveOut || unlocked ? <div className="ai-cross-picker"><FolderPicker value={chosen} onChange={setTarget} onReady={setTargetReady} /></div>
        : <p className="ai-card-note"><Icon name="lock" size={13} />请先在私密空间页面解锁，再选择位置并确认移入。</p>}
      {moveOut && <MoveOutVerify password={password} onPassword={value => { setPassword(value); setVerify(""); }} verified={Boolean(verify)}
        onPasskey={async signal => { passkeyAssertion.current = await privatePasskeyAssertion(signal); setPassword(""); setVerify("passkey"); }} />}
      <small>{moveOut ? "移出后文件不再受私密空间保护；同名时自动改名，不能撤销。" : "移入后公开链接会被取消；目标位置不会告诉助手。同名时自动改名，不能撤销。"}</small>
    </div>}
    {result?.links && result.links.length > 0 && <ul className="ai-links">{result.links.map(link => {
      const url = api.publicLinks(link.token, baseName(link.path)).page;
      return <li key={link.path}><Icon name={link.folder ? "folder" : "file"} size={13} /><span className="cell-truncate" title={display(link.path)}>{baseName(link.path)}</span>
        {link.password && <Badge icon="lock">密码</Badge>}
        <button type="button" onClick={() => copyMessage(url)}><Icon name="copy" size={12} />复制链接</button></li>;
    })}</ul>}
    {live && progress && <div className="ai-action-progress">
      <Progress value={progress.total ? progress.done / progress.total * 100 : 0} label="执行进度" />
      <small>{progress.done.toLocaleString("zh-CN")} / {progress.total.toLocaleString("zh-CN")}</small>
    </div>}
    {result && !live && <p className="ai-result">
      <span className="tone-success"><Icon name="checkCircle" size={13} />成功 {result.ok}</span>
      {result.skipped > 0 && <span className="tone-warning">跳过 {result.skipped}</span>}
      {result.failed > 0 && <span className="tone-danger">失败 {result.failed}</span>}
      {Object.keys(result.reasons ?? {}).length > 0 && <small>{Object.entries(result.reasons).map(([reason, count]) => `${reason} ${count}`).join("；")}</small>}
    </p>}
    {kind === "downloads" && result?.failed ? <p className="ai-card-note">部分图片需要来源页的登录或防盗链，可以在来源页用抓取脚本的「本地下载」保存。</p> : null}
    {pending && danger && <label className="ai-ack"><Checkbox checked={acknowledged} onChange={setAcknowledged} label="我了解此操作不可恢复" /><span>我了解此操作不可恢复</span></label>}
    {(pending || (live && status === "running") || (value.undoable && !live)) && <footer className="ai-card-foot">
      <span>{pending ? `${formatClock(value.expires_at)} 前有效` : live ? "正在执行，可以随时取消" : "24 小时内可以撤销"}</span>
      {pending && <>
        <Button size="sm" disabled={Boolean(busy)} loading={busy === "reject"} onClick={() => void run("reject", () => ai.rejectAction(id))}>拒绝</Button>
        <Button size="sm" variant={danger || moveOut ? "danger" : "primary"} disabled={Boolean(busy) || (danger && !acknowledged) || (share && password.length > 0 && password.length < 4) || crossBlocked}
          loading={busy === "confirm"} aria-label={`确认执行：${payload.title ?? kind} ${value.count} 项`}
          onClick={() => { if (many && !armed) { setArmed(true); return; }
            if (cross) {
              void run("confirm", async () => {
                const input: ai.ConfirmInput = crossInput();
                if (moveOut) {
                  if (password) input.password = password;
                  else input.passkey = passkeyAssertion.current ?? undefined;
                }
                try { return await ai.confirmAction(id, input); }
                finally { setPassword(""); setVerify(""); passkeyAssertion.current = null; }
              });
              return;
            }
            void run("confirm", () => ai.confirmAction(id, { acknowledge: danger ? acknowledged : undefined, count: many ? value.count : undefined,
              share: share ? { expires_days: days, ...(password ? { password } : {}) } : undefined })); }}>
          {many && armed ? `确认执行 ${value.count.toLocaleString("zh-CN")} 项` : share ? "确认分享" : moveOut ? "验证并移出" : kind === "move_in" ? "确认移入" : "确认执行"}</Button>
      </>}
      {live && status === "running" && <Button size="sm" loading={busy === "cancel"} onClick={() => void run("cancel", () => ai.cancelAction(id))}>取消</Button>}
      {value.undoable && !live && <Button size="sm" icon="restore" loading={busy === "undo"} onClick={() => void run("undo", () => ai.undoAction(id))}>撤销</Button>}
    </footer>}
    {details && <ActionItemsDialog action={value} onClose={() => setDetails(false)} />}
  </section>;
}

/** 移出私密空间前的重新验证：登录密码或通行密钥，只对这一次确认有效（§24.5.3）。 */
function MoveOutVerify({ password, onPassword, verified, onPasskey }: {
  password: string; onPassword: (value: string) => void; verified: boolean; onPasskey: (signal: AbortSignal) => Promise<void>;
}) {
  const [status, setStatus] = useState<api.PrivateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const signal = (controller.current = new AbortController()).signal;
    void api.privateStatus(signal).then(setStatus).catch(() => undefined);
    return () => controller.current?.abort();
  }, []);
  const unavailable = status ? passkeyUnavailable(status.passkeys) : "";
  const passkeys = Boolean(status && status.passkeys.registered > 0 && !unavailable);
  async function usePasskey() {
    setBusy(true);
    try { await onPasskey((controller.current ??= new AbortController()).signal); }
    catch (reason) { if (!(reason instanceof DOMException && reason.name === "AbortError")) toast.error(api.errorMessage(reason, "通行密钥验证失败")); }
    finally { setBusy(false); }
  }
  return <div className="ai-verify">
    <label><span>重新验证身份</span>
      <input className="input input-sm" type="password" autoComplete="current-password" value={password} placeholder={verified ? "已使用通行密钥验证" : "账号登录密码"}
        disabled={verified} onChange={event => onPassword(event.target.value)} /></label>
    {passkeys && <Button size="sm" icon={verified ? "check" : "key"} loading={busy} disabled={busy || verified} onClick={() => void usePasskey()}>{verified ? "已验证" : "通行密钥"}</Button>}
  </div>;
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
    }).catch(reason => { toast.error(api.errorMessage(reason, "条目加载失败，请稍后重试")); setItems([]); });
  }, [action.id]);
  useEffect(() => load(0), [load]);
  const failures = action.result?.failures ?? [];
  return <Modal title={`${action.payload?.title ?? "操作"}：全部条目`} description={action.payload?.summary} size="lg" onClose={onClose}
    footer={<Button onClick={onClose}>关闭</Button>}>
    {compacted && <InlineNotice>这个操作已超过 30 天，只保留了前 20 条样例。</InlineNotice>}
    {failures.length > 0 && <section className="ai-items-section"><h4>执行时跳过或失败</h4>
      <ul className="ai-diff is-plain">{failures.map((item, index) => <li key={index} className="ai-diff-row"><span className="cell-truncate">{item.path}</span><small>{item.reason}</small></li>)}</ul></section>}
    {skipped.length > 0 && <section className="ai-items-section"><h4>提议时已跳过（{skipped.length}）</h4>
      <ul className="ai-diff is-plain">{skipped.map((item, index) => <li key={index} className="ai-diff-row"><span className="cell-truncate">{item.path}</span><small>{item.reason}</small></li>)}</ul></section>}
    <section className="ai-items-section"><h4>将要执行（{action.count.toLocaleString("zh-CN")}）</h4>
      {items === null ? <SkeletonRows rows={4} /> : <ul className="ai-diff is-plain">{items.map((item, index) => <ItemRow key={index} kind={action.kind} item={item} />)}</ul>}
      {next !== null && <Button size="sm" onClick={() => load(next)}>加载更多</Button>}
    </section>
  </Modal>;
}
