/**
 * 文件助手的消息流（docs/assistant-design.md §19.3–19.4、§31）：按轮组织，每轮依次是计划摘要、过程时间线（思考、工具调用、
 * 中间说明与「决定」节点）、需要手势的浏览器动作与最终回复。待确认请求由输入区上方的确认坞处理，时间线里的决定节点
 * 原位显示等待／结果并可定位到确认坞，不再另起结果卡片。
 * 卡片全部由服务端冻结的数据渲染，不使用模型生成的描述。
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import * as ai from "../assistant-api";
import { Markdown } from "../markdown";
import { MessageAttachments } from "./assistant-attachments";
import { mentionLabel } from "./assistant-mentions";
import { usePreview } from "./preview-host";
import { FileGlyph, getFileKind, parentPath } from "../files";
import { FolderPicker } from "./folders";
import { passkeyUnavailable, privatePasskeyAssertion } from "../passkeys";
import { createThumbnails, generateLoadedThumbnails, thumbnailSource } from "../thumbnails";
import { useCacheQueue } from "./cache";
import { cacheFileId, cacheStats, cacheSupported } from "../cache-client";
import { Notice as InlineNotice, ButtonLink, AssistantMark, Badge, type AssistantMarkState, Button, Checkbox, Icon, Modal, Progress, SkeletonRows, copyText, formatBytes, formatDateTime, toast, type IconName, type Tone } from "../ui";

/** 对象键的显示路径：私密空间的条目显示为相对私密空间根的路径。 */
/** 对象键 → 显示路径：私密空间写作 私密:/路径（与助手使用的写法一致，§37.3）。 */
const display = mentionLabel;
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
  | { kind: "note"; key: string; text: string; live?: boolean }
  /** 需要用户决定的请求（文件操作、范围、提问、HTTP）：在时间线里原位显示状态，处理在确认坞里完成。 */
  | { kind: "decision"; key: string; message?: ai.ChatMessage; approval?: HttpApproval }
  /** 执行层在过程中插入的节点（自动续跑下一段、核验计划等），按发生位置显示。 */
  | { kind: "marker"; key: string; text: string; tone: "accent" | "neutral" };
type Turn = { key: string; user?: ai.ChatMessage; steps: Step[]; cards: ai.ChatMessage[]; answer?: ai.ChatMessage; notices: ai.ChatMessage[];
  runId: string | null; modelId?: number; input: number; output: number; startedAt?: number; endedAt?: number;
  /** answer 出现时时间线的长度：之后还有步骤（确认后续跑的下一次运行等）时，它不是最终回复，要放回这个位置。 */
  answerAt?: number };
type Item = { kind: "turn"; turn: Turn } | { kind: "event"; message: ai.ChatMessage };
const SYSTEM_EVENTS = ["scope_changed", "scope_rejected", "mode_changed", "model_switched", "action_result", "summary"];
const DECISION_EVENTS = ["action", "scope_request", "question", "http_request"];
const MARKER_EVENTS = ["continued", "plan_check", "review_check", "continue_check", "repeat_check"];

export function group(messages: ai.ChatMessage[]): Item[] {
  const items: Item[] = [];
  const plans = new Map<string, { turn: Turn; index: number }>();
  let turn: Turn | null = null;
  // 决定节点已经显示操作的实时状态；同一操作的结果分隔线只在找不到原节点（更早的消息未加载）时保留。
  const linked = new Set(messages.flatMap(message => message.role === "tool" && message.event?.type === "action" ? [message.event.action_id] : []));
  // 被后续步骤或新回复取代的回复按发生顺序放回时间线，不能留在末尾当作最终回复。
  const settle = (target: Turn) => {
    if (!target.answer?.text) return;
    target.steps.splice(target.answerAt ?? target.steps.length, 0, { kind: "note", key: `n${target.answer.seq}`, text: target.answer.text });
    target.answer = undefined; target.answerAt = undefined;
  };
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
    if (message.role === "event" && message.type === "action_result" && message.action_id && linked.has(message.action_id)) continue;
    // 只给模型看的系统事件（没有界面文字）不显示。
    if (message.role === "event" && !message.text && !message.event) continue;
    if (message.role === "event" && message.run_id && MARKER_EVENTS.includes(message.type ?? "")) {
      ensure(message).steps.push({ kind: "marker", key: `m${message.seq}`, text: message.text ?? "", tone: message.type === "continued" || message.type === "continue_check" ? "accent" : "neutral" });
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
        settle(current);
        current.answer = message;
        current.answerAt = current.steps.length;
      }
      continue;
    }
    if (message.role === "tool") {
      if (message.event && DECISION_EVENTS.includes(message.event.type)) current.steps.push({ kind: "decision", key: `d${message.seq}`, message });
      else if (message.event) current.cards.push(message);
      else current.steps.push({ kind: "tool", key: `s${message.seq}`, message });
    }
  }
  for (const item of items) if (item.kind === "turn" && item.turn.answer && (item.turn.answerAt ?? 0) < item.turn.steps.length) settle(item.turn);
  return items;
}

/* ---------- 消息流 ---------- */

/** 私密对话的链接放行规则：只有对话中出现过的地址可以点击（§24.8）；普通对话不限制。 */

/** 决定节点需要的对话状态与回调；放在上下文里，避免逐层传递到时间线。 */
type DecisionState = {
  actions: ai.AssistantAction[]; messages: ai.ChatMessage[]; running: boolean;
  /** 在确认坞中定位到这项请求（编号与 pendingReviews 的 id 一致）。 */
  onReview?: (id: string) => void; onActionChanged: () => void; onFilesChanged?: () => void;
};
const DecisionContext = createContext<DecisionState>({ actions: [], messages: [], running: false, onActionChanged: () => undefined });

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

export function Thread({ detail, live, liveModel, modelLabel, runId, httpApprovals, onRetry, onReview, onActionChanged, onFilesChanged }: {
  detail: ai.ConversationDetail; live: LiveRun | null; liveModel?: string; modelLabel: (id: number | null | undefined) => string; runId: string | null;
  httpApprovals: HttpApproval[];
  /** 从这条用户消息重新回答（丢弃之后的记录）。 */
  onRetry?: (seq: number) => void; onReview?: (id: string) => void;
  onActionChanged: () => void; onFilesChanged?: () => void;
}) {
  const running = Boolean(runId);
  const items = useMemo(() => group(detail.messages), [detail.messages]);
  const lastTurn = [...items].reverse().find(item => item.kind === "turn");
  const decisions = useMemo<DecisionState>(() => ({ actions: detail.actions, messages: detail.messages, running, onReview, onActionChanged, onFilesChanged }),
    [detail.actions, detail.messages, running, onReview, onActionChanged, onFilesChanged]);
  return <DecisionContext.Provider value={decisions}>
    {items.map(item => item.kind === "event" ? <SystemEvent key={`e${item.message.seq}`} message={item.message} />
      : <TurnView key={`${detail.conversation.id}:${item.turn.key}`} turn={item.turn} live={item === lastTurn && running ? live : null} runId={runId}
          model={item.turn.modelId != null ? modelLabel(item.turn.modelId) : item === lastTurn && running ? liveModel ?? "" : ""}
          httpApprovals={httpApprovals.filter(approval => approval.runId === (item.turn.runId ?? (item === lastTurn ? runId : null)))}
          onRetry={!running ? onRetry : undefined} />)}
    {running && live && (!lastTurn || lastTurn.kind !== "turn") && <TurnView key={`${detail.conversation.id}:live`} turn={{ key: "live", steps: [], cards: [], notices: [], runId: null, input: 0, output: 0 }}
      live={live} model="" httpApprovals={httpApprovals.filter(approval => approval.runId === runId)} />}
  </DecisionContext.Provider>;
}

function SystemEvent({ message }: { message: ai.ChatMessage }) {
  const icon: IconName = message.type === "mode_changed" ? "zap" : message.type === "model_switched" ? "server"
    : message.type?.startsWith("scope") ? "folder" : message.type === "action_result" ? "checkCircle" : message.type === "private" ? "lock" : "info";
  return <div className="ai-divider" role="note"><span><Icon name={icon} size={12} />{message.text}</span></div>;
}

function TurnView({ turn, live, runId = null, model, httpApprovals, onRetry }: {
  turn: Turn; live: LiveRun | null; runId?: string | null; model: string; httpApprovals: HttpApproval[]; onRetry?: (seq: number) => void;
}) {
  const { actions } = useContext(DecisionContext);
  const steps = [...turn.steps];
  // 同一轮里又开始运行（确认后续跑等）：上一次的回复不再是最终回复，回到它在时间线中的位置。
  let answer = turn.answer;
  if (live && answer?.text && answer.run_id !== runId) {
    steps.splice(turn.answerAt ?? steps.length, 0, { kind: "note", key: `n${answer.seq}`, text: answer.text });
    answer = undefined;
  }
  const retry = turn.user && onRetry ? () => onRetry(turn.user!.seq) : undefined;
  // 已经写入消息的 HTTP 审批由消息渲染；其余（等待中或刚决定、结果未到）用实时审批状态补一个决定节点。
  const recorded = new Set(steps.flatMap(step => step.kind === "decision" && step.message?.event?.type === "http_request"
    ? [`${step.message.run_id}:${step.message.event.id}`] : []));
  for (const approval of httpApprovals) if (!recorded.has(approval.callId)) steps.push({ kind: "decision", key: `h${approval.callId}`, approval });
  if (live) {
    if (live.reasoning) steps.push({ kind: "thinking", key: "live-thinking", text: live.reasoning,
      ms: null, live: live.phase === "thinking", startedAt: live.reasoningStartedAt });
    for (const tool of live.tools) if (!httpApprovals.some(approval => approval.toolCallId === tool.callId)) steps.push({ kind: "tool", key: `live-${tool.callId}`, pending: tool });
  }
  // 已经有工具步骤时，正在输出的文字多半是两次工具调用之间的说明：在时间线末尾显示，结束后若是最终回复再移到下方。
  const inline = Boolean(live?.streaming) && steps.some(step => step.kind !== "thinking");
  if (inline) steps.push({ kind: "note", key: "live-note", text: live!.streaming, live: true });
  const streaming = inline ? "" : live?.streaming ?? "";
  const mark = useMarkState(live);
  const waiting = httpApprovals.some(approval => approval.status === "pending");
  const plans = turn.cards.filter(message => message.event?.type === "plan");
  const cards = turn.cards.filter(message => message.event?.type !== "plan");
  // 公开分享的链接令牌只给界面；放在时间线之外，折叠过程时也能直接复制。
  const shared = steps.flatMap(step => {
    const event = step.kind === "decision" ? step.message?.event : null;
    const action = event?.type === "action" ? actions.find(item => item.id === event.action_id) : undefined;
    return action?.result?.links?.length ? [action] : [];
  });
  const hasAssistant = steps.length > 0 || turn.cards.length > 0 || answer || streaming || turn.notices.length > 0 || live;
  return <div className="ai-turn">
    {turn.user && <UserMessage message={turn.user} onRetry={retry} />}
    {hasAssistant && <div className={`ai-reply${live ? " is-live" : ""}`}>
      <span className="ai-avatar" aria-hidden="true"><AssistantMark state={waiting ? "idle" : mark} /></span>
      <div className="ai-reply-body">
        <div className="ai-reply-head"><strong>文件助手</strong>{model && <span className="ai-model" title={model}>{model}</span>}
          {live && <LiveStatus live={live} waiting={waiting} />}</div>
        {plans.map(message => message.event?.type === "plan" && <PlanLine key={message.event.id ?? turn.key} plan={message.event} />)}
        {steps.length > 0 && <Process steps={steps} live={Boolean(live)} />}
        {cards.map(message => message.event?.type === "browser" && <BrowserCard key={`card-${message.seq}`} event={message.event} />)}
        {shared.map(action => <ShareLinks key={action.id} action={action} />)}
        {(answer || streaming) && <div className="ai-answer">
          <Markdown source={streaming || answer?.text || ""} />{streaming && <i className="ai-caret" aria-hidden="true" />}
        </div>}
        {turn.notices.map(notice => <Notice key={notice.seq} message={notice} onRetry={notice.retry ? retry : undefined} />)}
        {!live && (answer || turn.output > 0) && <div className="ai-reply-foot">
          {turn.endedAt && <span>{formatDateTime(turn.endedAt)}</span>}
          {answer?.text && <button type="button" onClick={() => copyMessage(answer?.text ?? "")}><Icon name="copy" size={12} />复制</button>}
        </div>}
      </div>
    </div>}
  </div>;
}

function LiveStatus({ live, waiting = false }: { live: LiveRun; waiting?: boolean }) {
  const label = waiting ? "等待确认" : live.phase === "queued" ? `排队中${live.queue ? `，前面 ${live.queue} 个` : ""}`
    : live.tools.length ? `正在${live.tools.at(-1)!.label}` : live.streaming ? "正在回复" : live.reasoning ? "正在思考" : live.phase === "thinking" ? "等待模型响应" : "正在准备";
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

type DecisionPhase = "loading" | "pending" | "busy" | "done";

/** 工具消息可先于操作详情到达；缺少详情只表示仍在同步，不能据此认定过期。 */
function actionDecisionState(action: ai.AssistantAction | undefined): DecisionPhase {
  if (!action) return "loading";
  if (action.status === "pending") return action.expires_at * 1000 > Date.now() ? "pending" : "done";
  if (action.kind === "scope" && action.status === "confirmed") return "done";
  return action.status === "running" || action.status === "undoing" || action.status === "confirmed" ? "busy" : "done";
}

/** 决定节点当前的处理状态：同步详情、等待用户、执行中或已有结果。 */
function decisionState(step: Extract<Step, { kind: "decision" }>, state: DecisionState): DecisionPhase {
  if (step.approval) return step.approval.status === "pending" && step.approval.expires > Date.now() ? "pending" : "done";
  const event = step.message?.event;
  if (event?.type === "question") {
    const seq = step.message!.seq;
    const latest = [...state.messages].reverse().find(message => message.event?.type === "question")?.seq === seq;
    return latest && !state.running && !state.messages.some(message => message.role === "user" && message.seq > seq) ? "pending" : "done";
  }
  if (event?.type !== "action" && event?.type !== "scope_request") return "done";
  return actionDecisionState(state.actions.find(item => item.id === event.action_id));
}

const LIVE_TAIL = 6;

type ThoughtStep = Extract<Step, { kind: "thinking" | "note" }>;
type ThinkingDisclosure = { text: string; open: boolean; follow: boolean; top: number };

/** 展开选择属于本轮过程，流式节点保存或被外层折叠卸载后仍保留；不跨对话共享。 */
function useThinkingDisclosures(steps: Step[]) {
  const saved = useRef(new Map<string, ThinkingDisclosure>());
  const thoughts = steps.filter((step): step is ThoughtStep => step.kind === "thinking" || step.kind === "note");
  const fresh = (text: string): ThinkingDisclosure => ({ text, open: false, follow: true, top: 0 });
  for (const kind of ["thinking", "note"] as const) {
    const liveKey = `live-${kind}`;
    let previous = saved.current.get(liveKey);
    for (const step of thoughts) {
      if (step.kind !== kind || step.key === liveKey || saved.current.has(step.key)) continue;
      // 消息落库会更换 seq，按当前流的正文前缀交接阅读状态；两种正文各自交接，空占位不参与匹配。
      const continued = previous?.text.trim() && step.text.trimStart().startsWith(previous.text.trim().slice(0, 64));
      saved.current.set(step.key, continued ? previous! : fresh(step.text));
      if (continued) { saved.current.delete(liveKey); previous = undefined; }
    }
    const live = thoughts.find(step => step.key === liveKey);
    if (live) {
      const value = saved.current.get(liveKey) ?? fresh(live.text);
      value.text = live.text;
      saved.current.set(liveKey, value);
    } else saved.current.delete(liveKey);
  }
  return saved.current;
}

function Process({ steps, live }: { steps: Step[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const disclosures = useThinkingDisclosures(steps);
  const state = useContext(DecisionContext);
  const tools = steps.filter(step => step.kind === "tool");
  const decisions = steps.filter((step): step is Extract<Step, { kind: "decision" }> => step.kind === "decision");
  const states = decisions.map(step => decisionState(step, state));
  const waiting = states.filter(value => value === "pending").length;
  const busy = states.some(value => value === "busy" || value === "loading");
  const executed = tools.filter(step => step.kind === "tool" && step.message?.status !== "limited" && step.message?.status !== "cancelled");
  const failed = tools.filter(step => step.kind === "tool" && step.message?.status === "error").length;
  const thinkingMs = steps.reduce((sum, step) => sum + (step.kind === "thinking" ? step.ms ?? 0 : 0), 0);
  const thought = steps.some(step => step.kind === "thinking");
  const toolMs = tools.reduce((sum, step) => sum + (step.kind === "tool" ? step.message?.duration_ms ?? 0 : 0), 0);
  // 运行中、操作同步或执行中始终展开（执行中的节点需要挂载才能轮询进度）；只有一个思考或说明步骤时不再套一层折叠。
  // 长任务展开时只保留最近几步，更早的步骤收成一行；等待处理或执行中的决定节点始终显示。
  const renderStep = (step: Step) => <StepView key={step.key} step={step} disclosure={disclosures.get(step.key)} onThinkingOpen={() => setOpen(true)} />;
  if (live || busy || (steps.length === 1 && (steps[0].kind === "thinking" || steps[0].kind === "note"))) {
    const keep = steps.map((step, index) => showAll || index >= steps.length - LIVE_TAIL
      || step.kind === "decision" && decisionState(step, state) !== "done");
    const hidden = keep.filter(value => !value).length;
    const visible = hidden >= 3 ? steps.filter((_, index) => keep[index]) : steps;
    return <div className="ai-process">
      {hidden >= 3 && <button type="button" className="ai-process-more" onClick={() => setShowAll(true)}>
        <Icon name="more" size={13} />前面还有 {hidden} 个步骤</button>}
      {visible.map(renderStep)}
    </div>;
  }
  const parts = [thought ? (thinkingMs ? `思考 ${seconds(thinkingMs)}` : "思考") : "", executed.length ? `使用 ${executed.length} 个工具` : "",
    decisions.length - waiting ? `${decisions.length - waiting} 项决定` : "", toolMs >= 1000 ? `耗时 ${seconds(toolMs)}` : ""].filter(Boolean);
  return <div className={`ai-process is-collapsible${open ? " is-open" : ""}`}>
    <button type="button" className="ai-process-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="ai-process-icons" aria-hidden="true">{thought && <Icon name="brain" size={13} />}{tools.length > 0 && <Icon name="wrench" size={13} />}
        {decisions.length > 0 && <Icon name="shield" size={13} />}</span>
      <span>{parts.join(" · ") || `${steps.length} 个步骤`}</span>
      {waiting > 0 && <span className="ai-process-waiting">{waiting} 项待确认</span>}
      {failed > 0 && <span className="ai-process-error">{failed} 项出错</span>}
      <Icon name="chevronDown" size={14} />
    </button>
    {open && <div className="ai-process-steps">{steps.map(renderStep)}</div>}
  </div>;
}

function StepView({ step, disclosure, onThinkingOpen }: { step: Step; disclosure?: ThinkingDisclosure; onThinkingOpen: () => void }) {
  if (step.kind === "thinking" || step.kind === "note") return <ProcessText text={step.text} disclosure={disclosure!}
    ms={step.kind === "thinking" ? step.ms : null} live={step.live} startedAt={step.kind === "thinking" ? step.startedAt ?? null : null}
    note={step.kind === "note"} onOpen={onThinkingOpen} />;
  if (step.kind === "decision") return <DecisionStep step={step} />;
  if (step.kind === "marker") return <div className={`ai-step ai-marker tone-${step.tone}`}>
    <span className="ai-step-dot" aria-hidden="true"><Icon name={step.tone === "accent" ? "refresh" : "checkCircle"} size={12} /></span>
    <span className="ai-marker-text">{step.text}</span></div>;
  return <ToolStep message={step.message} pending={step.pending} />;
}

/** 思考与进度说明复用折叠交互，用图标和标题区分来源；进度另有一行摘要，展开时随输出流式追加，
 * 停在底部时自动跟随，向上翻阅时不打断。 */
function ProcessText({ text, ms, live, startedAt, note, disclosure, onOpen }: {
  text: string; ms: number | null; live?: boolean; startedAt: number | null; note: boolean; disclosure: ThinkingDisclosure; onOpen: () => void;
}) {
  const [choice, setChoice] = useState(() => ({ disclosure, open: disclosure.open }));
  const open = choice.disclosure === disclosure ? choice.open : disclosure.open;
  const contentId = useId();
  const now = useNow(Boolean(live && startedAt));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && box.current) box.current.scrollTop = disclosure.follow ? box.current.scrollHeight : disclosure.top;
  }, [disclosure, open]);
  useEffect(() => {
    if (open && live && disclosure.follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text, live, open, disclosure]);
  const elapsed = live ? (startedAt ? Math.max(0, now - startedAt) : 0) : ms;
  const summary = note ? text.replace(/\s+/g, " ").trim() : "";
  return <div className={`ai-step ${note ? "ai-note" : "ai-thinking"}${open ? " is-open" : ""}${live ? " is-live" : ""}`}>
    <span className="ai-step-dot" aria-hidden="true"><Icon name={note ? "chat" : "brain"} size={12} /></span>
    <div className="ai-thinking-body">
      <button type="button" className="ai-tool-head ai-thinking-head" aria-expanded={open} aria-controls={text ? contentId : undefined} disabled={!text}
        onClick={() => { disclosure.follow = true; disclosure.open = !open; setChoice({ disclosure, open: !open }); if (!open) onOpen(); }}>
        <strong><span className={live ? "ai-shimmer" : undefined}>{note ? "进度说明" : live ? "思考中" : "思考"}</span></strong>
        {note && !open && <span className="ai-tool-result">{summary.slice(0, 120)}{summary.length > 120 ? "…" : ""}</span>}
        {elapsed ? <span className="ai-thinking-time">{seconds(elapsed)}</span> : null}
        {text && <Icon name="chevronDown" size={13} />}
      </button>
      <div id={contentId} className="ai-tool-detail ai-thinking-text" hidden={!open} ref={box} aria-live="off"
        onScroll={event => { const node = event.currentTarget; disclosure.top = node.scrollTop;
          disclosure.follow = node.scrollHeight - node.scrollTop - node.clientHeight < 24; }}>
        {open && <Markdown source={text} />}</div>
    </div>
  </div>;
}

const TOOL_ICONS: [RegExp, IconName][] = [
  [/^propose_save_attachment/, "paperclip"], [/^ui_generate_thumbnails/, "image"],
  [/^(list_folder|folder_tree|find_empty)/, "folder"], [/^(search_files|find_large|find_duplicates)/, "search"],
  [/^(storage_stats|trash_stats)/, "pulse"], [/^(list_trash)/, "trash"], [/^read_text_file/, "fileText"], [/^get_file_info/, "file"],
  [/^(list_public|propose_share|propose_unshare)/, "link"], [/download/, "download"], [/^(inspect_page|analyze_page|collect_gallery|collect_links|parse_download)/, "globe"],
  [/^(ui_|browser_)/, "cursor"], [/^propose_/, "edit"], [/^(get_context|request_scope|recall_result)/, "info"], [/^list_recent/, "list"],
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

/* ---------- 决定节点 ---------- */

const DECISION_TONES: Record<string, Tone> = { pending: "warning", busy: "accent" };

/** 时间线里的决定节点：一行显示请求与状态，等待中可定位到确认坞，展开后查看冻结的请求内容与结果。 */
function DecisionRow({ icon, title, target, label, tone, state, reviewId, extra, children }: {
  icon: IconName; title: string; target?: string; label: string; tone: Tone; state: DecisionPhase; reviewId?: string;
  extra?: ReactNode; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { onReview } = useContext(DecisionContext);
  return <div className={`ai-step ai-decision is-${state} tone-${tone}${open ? " is-open" : ""}`}>
    <span className="ai-step-dot" aria-hidden="true"><Icon name={icon} size={12} /></span>
    <div className="ai-tool-body">
      <div className="ai-decision-head">
        <button type="button" className="ai-tool-head" aria-expanded={children ? open : undefined} disabled={!children} onClick={() => setOpen(value => !value)}>
          <strong>{title}</strong>
          {target && <span className="ai-decision-target" title={target}>{target}</span>}
          {children && <Icon name="chevronDown" size={13} />}
        </button>
        <Badge tone={DECISION_TONES[state] ?? tone}>{label}</Badge>
        {state === "pending" && reviewId && onReview && <button type="button" className="ai-decision-go" onClick={() => onReview(reviewId)}>
          去处理<Icon name="chevronDown" size={12} /></button>}
      </div>
      {extra}
      {open && children && <div className="ai-tool-detail ai-decision-detail">{children}</div>}
    </div>
  </div>;
}

function DecisionStep({ step }: { step: Extract<Step, { kind: "decision" }> }) {
  const decisions = useContext(DecisionContext);
  const state = decisionState(step, decisions);
  if (step.approval) return <HttpDecision request={step.approval.request} status={step.approval.status} approval={step.approval} state={state} />;
  const message = step.message!;
  const event = message.event!;
  if (event.type === "http_request") return <HttpDecision request={event.request} status={event.decision} message={message} state={state} />;
  if (event.type === "question") {
    const answer = decisions.messages.find(item => item.role === "user" && item.seq > message.seq)?.text;
    return <DecisionRow icon="info" title="向你提问" target={event.question} state={state} tone={answer ? "success" : "neutral"}
      label={state === "pending" ? "等待回答" : answer ? "已回答" : "未回答"} reviewId={`question-${message.seq}`}>
      <p className="ai-decision-text">{event.question}</p>
      {event.options?.length ? <ul className="ai-decision-options">{event.options.map(option => <li key={option}>{option}</li>)}</ul> : null}
      {answer && <div className="ai-decision-answer"><span>你的回答</span><p>{answer}</p></div>}
    </DecisionRow>;
  }
  if (event.type === "scope_request") {
    const action = decisions.actions.find(item => item.id === event.action_id);
    const status = action?.status ?? "loading";
    const [label, tone]: [string, Tone] = state === "pending" ? ["等待确认", "warning"] : status === "confirmed" ? ["已允许", "success"]
      : STATUS_LABEL[status === "pending" ? "expired" : status];
    return <DecisionRow icon="folder" title="扩大访问范围" target={action?.payload?.to ?? event.to} label={label} tone={tone} state={state} reviewId={event.action_id}>
      <div className="ai-scope-path"><code>{action?.payload?.from ?? event.from}</code><Icon name="chevronRight" size={14} /><code>{action?.payload?.to ?? event.to}</code></div>
      {(action?.payload?.reason ?? event.reason) && <p className="ai-decision-text">{action?.payload?.reason ?? event.reason}</p>}
    </DecisionRow>;
  }
  if (event.type === "action") return <ActionDecision id={event.action_id} fallback={event} />;
  return null;
}

function HttpDecision({ request, status, approval, message, state }: {
  request: ai.HttpRequestPreview; status: HttpApproval["status"]; approval?: HttpApproval; message?: ai.ChatMessage; state: DecisionPhase;
}) {
  const expired = status === "pending" && state !== "pending";
  const label = state === "pending" ? "等待确认" : expired ? "已过期" : status === "approved" ? message ? message.status === "ok" ? "已响应" : "执行失败" : "已同意，发送中"
    : status === "rejected" ? "已拒绝" : status === "expired" ? "已过期" : status === "error" ? "回传失败" : "已取消";
  const tone: Tone = status === "approved" && message?.status === "ok" ? "success"
    : status === "error" || status === "approved" && message?.status === "error" ? "danger" : "neutral";
  return <DecisionRow icon="globe" title="HTTP 请求" target={`${request.method} ${request.url}`} label={label} tone={tone} state={state}
    reviewId={approval?.callId}>
    <HttpRequestDetail request={request} message={status === "approved" ? message : undefined} />
  </DecisionRow>;
}

function ActionDecision({ id, fallback }: { id: string; fallback: { kind: string; count: number; auto?: boolean } }) {
  const { actions, onActionChanged, onFilesChanged } = useContext(DecisionContext);
  const [details, setDetails] = useState(false);
  const { value, busy, run } = useActionState(id, actions.find(item => item.id === id), fallback, onActionChanged, onFilesChanged);
  const state = actionDecisionState(value);
  const kind = value?.kind || fallback.kind;
  const payload = value?.payload ?? {};
  const status = value?.status ?? "loading";
  const expired = status === "pending" && state !== "pending";
  const [statusLabel, tone] = STATUS_LABEL[expired ? "expired" : status] ?? [status, "neutral" as Tone];
  const count = value?.count ?? fallback.count;
  const result = value?.result;
  const progress = value?.progress;
  const label = state === "pending" ? "等待确认" : payload.auto && status === "done" ? "已自动执行" : statusLabel;
  const samples = payload.samples ?? [];
  return <DecisionRow icon={ACTION_ICONS[kind] ?? "check"} title={payload.title ?? ai.ACTION_KINDS[kind] ?? kind}
    target={`${count.toLocaleString("zh-CN")} 项${payload.scope ? ` · ${display(payload.scope)}` : ""}`} label={label} tone={tone} state={state} reviewId={id}
    extra={<>
      {state === "busy" && <div className="ai-action-progress">
        <Progress value={progress?.total ? progress.done / progress.total * 100 : 0} label="执行进度" />
        <span>{progress ? `${progress.done.toLocaleString("zh-CN")} / ${progress.total.toLocaleString("zh-CN")}` : "准备中"}</span>
        {status === "running" && <Button size="sm" loading={busy === "cancel"} onClick={() => void run("cancel", () => ai.cancelAction(id))}>取消</Button>}
      </div>}
      {result && state === "done" && <p className="ai-decision-result">成功 {result.ok.toLocaleString("zh-CN")}{result.skipped ? `，跳过 ${result.skipped}` : ""}
        {result.failed ? <span className="tone-danger">，失败 {result.failed}</span> : null}</p>}
    </>}>
    {value ? <>
      {payload.summary && <p className="ai-decision-text">{payload.summary}</p>}
      {samples.length > 0 && <ItemList kind={kind} items={samples.slice(0, 6)} />}
      <button type="button" className="ai-link" onClick={() => setDetails(true)}>查看全部 {count.toLocaleString("zh-CN")} 项{result?.failed ? "与失败原因" : ""}</button>
      {details && <ActionItemsDialog action={value} onClose={() => setDetails(false)} />}
    </> : <SkeletonRows rows={2} />}
  </DecisionRow>;
}

/** 公开分享成功后的链接：令牌只出现在给界面的操作结果中，不经过模型。 */
function ShareLinks({ action }: { action: ai.AssistantAction }) {
  return <ul className="ai-links ai-share-links" aria-label="分享链接">{action.result!.links!.map(link => <li key={link.path}>
    <Icon name="link" size={13} /><span className="cell-truncate" title={display(link.path)}>{baseName(link.path)}</span>
    {link.password && <Badge icon="lock">密码</Badge>}
    <Button size="sm" onClick={() => copyMessage(api.publicLinks(link.token, baseName(link.path)).page)}>复制链接</Button>
  </li>)}</ul>;
}

function CardHead({ icon, tone = "accent", title, subtitle, badge }: { icon: IconName; tone?: Tone; title: string; subtitle?: string; badge?: ReactNode }) {
  return <header className="ai-card-head">
    <span className={`ai-card-icon tone-${tone}`}><Icon name={icon} size={16} /></span>
    <span className="ai-card-title"><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
    {badge}
  </header>;
}

/** 请求冻结后的内容与响应：确认坞和时间线的决定节点共用。 */
function HttpRequestDetail({ request, message }: { request: ai.HttpRequestPreview; message?: ai.ChatMessage }) {
  return <>
    <code className="ai-http-target">{request.method} {request.url}</code>
    <details className="ai-http-details"><summary>请求详情 · 正文 {formatBytes(request.body_bytes)}</summary><div className="ai-http-preview">
      <h4>请求头</h4><pre>{Object.entries(request.headers).map(([key, value]) => `${key}: ${value}`).join("\n") || "无自定义请求头"}</pre>
      {request.body !== null && <><h4>{request.body_encoding === "base64" ? "请求正文（Base64）" : "请求正文"}</h4><pre>{request.body || "空正文"}</pre></>}
      <p>认证头及可识别的凭据已隐藏；本次确认仅适用于这一条请求。</p>
    </div></details>
    {message && <><p className="ai-http-summary">{message.summary}</p>
      <details className="ai-http-details"><summary>响应结果</summary><ToolDetail message={{ ...message, arguments: undefined }} /></details></>}
  </>;
}

/** 确认只回传决定；请求内容由服务端冻结，决定后由时间线的决定节点显示结果。 */
export function HttpRequestCard({ request, approval, onDecide }: {
  request: ai.HttpRequestPreview; approval: HttpApproval; onDecide: (callId: string, decision: ai.HttpDecision) => void;
}) {
  const now = useNow(approval.status === "pending");
  const remaining = Math.max(0, Math.ceil((approval.expires - now) / 1000));
  return <section className="ai-card ai-http is-pending" aria-label="HTTP 请求">
    <CardHead icon="globe" tone="warning" title={`发送 ${request.method} 请求`} subtitle={request.url.replace(/^https?:\/\//, "").split(/[/?#]/, 1)[0]} />
    <HttpRequestDetail request={request} />
    <p className="ai-card-note"><Icon name="globe" size={13} />从服务器发送，可能修改第三方数据或产生费用，请核对请求。</p>
    <footer className="ai-card-foot">
      <span>剩余 {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}，超时取消</span>
      <Button size="sm" onClick={() => onDecide(approval.callId, "rejected")}>拒绝</Button>
      <Button size="sm" variant="primary" disabled={!remaining} onClick={() => onDecide(approval.callId, "approved")}>发送请求</Button>
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
      <div><span className="ai-plan-step"><span>{item.content}</span><small>{PLAN_LABELS[item.status]}
        {item.status === "completed" && item.unverified && <span className="ai-plan-unverified" title="没有关联的工具结果，完成依据见下方说明">未关联结果</span>}</small></span>
        {item.detail && <p className="ai-plan-detail">{item.detail}</p>}</div>
    </li>)}</ol>
    {plan.reason && <p className="ai-plan-reason">调整原因：{plan.reason}</p>}
    {plan.notes && <div className="ai-plan-notes"><strong>进度记录</strong><p>{plan.notes}</p></div>}
  </>;
}

function PlanMeter({ done, total }: { done: number; total: number }) {
  return <span className="ai-plan-meter" role="progressbar" aria-label="计划进度" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
    <i style={{ inlineSize: `${total ? done / total * 100 : 0}%` }} /></span>;
}

/** 位于消息滚动区之外，长任务中随时查看计划，不改变对话的阅读位置；也是「继续任务」的唯一入口。 */
export function PlanBar({ plan, running, onContinue }: { plan: ai.PlanEvent; running: boolean; onContinue: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { done, status, current, tone } = planProgress(plan);
  const panelId = useId();
  const next = current ?? plan.items.find(item => item.status !== "completed");
  const subtitle = status === "completed" ? "全部步骤已完成" : next ? `${current ? "当前" : "下一步"}：${next.content}` : "查看完整计划";
  const resumable = canResumePlan(plan, running);
  return <section className={`assistant-plan-bar ai-plan is-${status}`} aria-label="当前任务计划" onKeyDown={event => {
    if (!expanded || event.key !== "Escape" || event.nativeEvent.isComposing || event.repeat) return;
    event.preventDefault(); event.stopPropagation(); setExpanded(false); trigger.current?.focus({ preventScroll: true });
  }}><div className="assistant-plan-inner">
    <div className="assistant-plan-row">
      <button ref={trigger} type="button" className="assistant-plan-trigger" aria-expanded={expanded} aria-controls={panelId}
        onClick={() => setExpanded(value => !value)}>
        <span className="assistant-plan-icon" aria-hidden="true">{status === "in_progress" && running ? <ActivityDots /> : <Icon name={status === "completed" ? "check" : "list"} size={14} />}</span>
        <span className="assistant-plan-summary"><span className="assistant-plan-meta">
          <strong>{plan.title ?? "任务计划"}</strong><Badge tone={tone}>{PLAN_LABELS[status]}</Badge>
        </span><small title={subtitle}>{subtitle}</small></span>
        <span className="assistant-plan-count">{done}/{plan.items.length}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {resumable && <Button size="sm" icon="play" onClick={onContinue}>继续</Button>}
    </div>
    <PlanMeter done={done} total={plan.items.length} />
    <div id={panelId} className="assistant-plan-panel" hidden={!expanded} role="region" aria-label="完整任务计划" tabIndex={0}
      onPointerDown={event => {
        if (!(event.target as Element).closest("button, a")) event.currentTarget.focus({ preventScroll: true });
        event.stopPropagation();
      }}>
      <PlanSteps plan={plan} />
      {resumable && <p className="assistant-plan-actions">已保留当前进度，继续时会先核对已有结果，避免重复执行。</p>}
    </div>
  </div></section>;
}

/** 消息里的计划只占一行（标题、进度与状态），展开查看这一轮的步骤；完整、最新的计划在顶部计划栏。 */
function PlanLine({ plan }: { plan: ai.PlanEvent }) {
  const [open, setOpen] = useState(false);
  const { done, status, tone } = planProgress(plan);
  return <section className={`ai-plan ai-plan-line is-${status}${open ? " is-open" : ""}`} aria-label="任务计划">
    <button type="button" className="ai-plan-line-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name="list" size={14} /><strong>{plan.title ?? "处理计划"}</strong>
      <PlanMeter done={done} total={plan.items.length} />
      <span className="ai-plan-line-count">{done}/{plan.items.length}</span>
      <Badge tone={tone}>{PLAN_LABELS[status]}</Badge><Icon name="chevronDown" size={13} />
    </button>
    {open && <div className="ai-plan-line-body"><PlanSteps plan={plan} /></div>}
  </section>;
}

export function ScopeCard({ event, action, onScope }: { event: Extract<ai.ToolEvent, { type: "scope_request" }>; action?: ai.AssistantAction;
  onScope: (id: string, approve: boolean) => void }) {
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
  loading: ["正在获取状态", "neutral"], pending: ["待确认", "accent"], confirmed: ["准备执行", "accent"],
  running: ["执行中", "accent"], done: ["已完成", "success"], partial: ["部分完成", "warning"],
  failed: ["执行失败", "danger"], cancelled: ["已取消", "neutral"], rejected: ["已拒绝", "neutral"], expired: ["已过期", "neutral"],
  interrupted: ["已中断", "warning"], undoing: ["撤销中", "accent"], undone: ["已撤销", "neutral"],
};
const MOVE_KINDS = ["rename", "move", "organize"];
/** 跨区移动（§24.5.3）：目标目录由用户在卡片上选择。 */
const CROSS_KINDS = ["move_out", "move_in"];
const SHARE_DAYS = [{ value: 0, label: "永久有效" }, { value: 1, label: "1 天" }, { value: 7, label: "7 天" }, { value: 30, label: "30 天" }, { value: 90, label: "90 天" }];

/** 条目里的文件路径：文件名在前、完整换行，所在目录另起一行；同一批条目共用目录时目录只在列表头显示一次。
 * 卡片里文件名最多两行，全部条目对话框里完整显示；悬停提示始终是完整路径。 */
function PathText({ path, base, className }: { path: string; base?: string; className?: string }) {
  const dir = parentOf(path);
  return <span className={`ai-path${className ? ` ${className}` : ""}`} title={display(path)}>
    <span className="ai-path-name">{baseName(path)}{path.endsWith("/") ? "/" : ""}</span>
    {dir && dir !== base && <span className="ai-path-dir">{display(dir)}</span>}
  </span>;
}

const itemPath = (kind: string, item: ai.ActionItem) =>
  MOVE_KINDS.includes(kind) || CROSS_KINDS.includes(kind) ? item.from : ["downloads", "save_attachment", "download_control"].includes(kind) ? undefined : item.path;

/** 条目共同所在的目录（至少两项且全部相同时）。 */
function commonDir(kind: string, items: ai.ActionItem[]) {
  const dirs = items.map(item => itemPath(kind, item)).map(path => path ? parentOf(path) : null);
  return dirs.length > 1 && dirs[0] && dirs.every(dir => dir === dirs[0]) ? dirs[0] : undefined;
}

function ItemList({ kind, items, full }: { kind: string; items: ai.ActionItem[]; full?: boolean }) {
  const base = commonDir(kind, items);
  return <ul className={`ai-diff${full ? " is-plain" : " is-clamped"}`}>
    {base && <li className="ai-diff-dir"><Icon name="folder" size={13} /><span>{display(base)}</span></li>}
    {items.map((item, index) => <ItemRow key={index} kind={kind} item={item} base={base} />)}
  </ul>;
}

function ItemRow({ kind, item, base }: { kind: string; item: ai.ActionItem; base?: string }) {
  if (MOVE_KINDS.includes(kind) && item.from && item.to) {
    const rename = kind === "rename" || parentOf(item.from) === parentOf(item.to);
    return <li className="ai-diff-row"><Icon name={item.folder ? "folder" : "file"} size={13} />
      {rename ? <span className="ai-path" title={`${display(item.from)} → ${display(item.to)}`}>
        <span className="ai-path-name"><del>{baseName(item.from)}</del></span>
        <span className="ai-path-name"><Icon name="chevronRight" size={12} /><ins>{baseName(item.to)}</ins></span>
        {parentOf(item.from) !== base && parentOf(item.from) && <span className="ai-path-dir">{display(parentOf(item.from))}</span>}
      </span>
        : <span className="ai-path" title={`${display(item.from)} → ${display(item.to)}`}>
          <PathText path={item.from} base={base} />
          <span className="ai-path-to"><Icon name="chevronRight" size={12} /><ins>{display(parentOf(item.to)) || "/"}</ins></span>
        </span>}
    </li>;
  }
  if (kind === "downloads") return <li className="ai-diff-row"><Icon name="download" size={13} />
    <span className="ai-path" title={item.name}><span className="ai-path-name">{item.name}</span>{item.host && <span className="ai-path-dir">{item.host}</span>}</span></li>;
  if (kind === "save_attachment") return <li className="ai-diff-row"><Icon name="paperclip" size={13} />
    <span className="ai-path" title={display(item.path ?? "")}><span className="ai-path-name">{(item.name ?? "").replace(/^附件:/, "")}</span>
      <span className="ai-path-to"><Icon name="chevronRight" size={12} /><ins>{display(parentOf(item.path ?? ""))}</ins></span></span></li>;
  if (CROSS_KINDS.includes(kind) && item.from) return <li className="ai-diff-row"><Icon name={item.folder ? "folder" : "file"} size={13} />
    <PathText path={item.from} base={base} /></li>;
  if (kind === "download_control") return <li className="ai-diff-row"><Icon name="download" size={13} />
    <span className="ai-path" title={display(item.path ?? "")}><span className="ai-path-name">#{item.id} {baseName(item.path ?? "")}</span></span></li>;
  const files = kind === "trash" && typeof item.files === "number" ? item.files : null;
  return <li className="ai-diff-row"><Icon name={item.folder || item.path?.endsWith("/") ? "folder" : "file"} size={13} />
    <PathText path={item.path ?? ""} base={base} />
    {files !== null && <small className={files ? "tone-warning" : undefined}>{files ? `含 ${files.toLocaleString("zh-CN")} 个文件` : "空目录"}</small>}</li>;
}

/** 移入回收站时提示文件夹里还有多少文件，避免「删除空目录」误带上非空文件夹。 */
function TrashChips({ options }: { options?: { only_empty?: boolean; files?: number; nonempty?: number } }) {
  if (options?.only_empty) return <span><Icon name="shield" size={12} />仅空目录，执行前再核对</span>;
  if (!options?.nonempty) return null;
  return <span className="tone-warning"><Icon name="alert" size={12} />{options.nonempty.toLocaleString("zh-CN")} 个文件夹含 {(options.files ?? 0).toLocaleString("zh-CN")} 个文件</span>;
}

/** 操作的实时状态：执行中轮询进度；经历过执行（含自动执行）后在终态时刷新文件列表。 */
function useActionState(id: string, action: ai.AssistantAction | undefined, fallback: { auto?: boolean }, onChanged: () => void, onFilesChanged?: () => void) {
  const [value, setValue] = useState<ai.AssistantAction | undefined>(action);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (action) setValue(current => !current || action.status !== current.status || action.finished_at !== current.finished_at ? action : current); }, [action]);
  const status = value?.status ?? "pending";
  const live = status === "running" || status === "undoing";
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
  // 节点可能在折叠后重新挂载：只有挂载时仍在执行的自动操作才需要在结束后刷新文件。
  const touched = useRef(Boolean(fallback.auto) && (!action || action.status === "running" || action.status === "confirmed"));
  useEffect(() => {
    if (live) touched.current = true;
    else if (touched.current && status !== "pending" && status !== "confirmed") { touched.current = false; onFilesChanged?.(); }
  }, [live, status]);
  const run = useCallback(async (label: string, task: () => Promise<ai.AssistantAction>) => {
    setBusy(label);
    try {
      const fresh = await task();
      if (fresh.status === "running" || fresh.status === "undoing") touched.current = true;
      setValue(fresh);
      onChanged();
    } catch (reason) { toast.error(api.errorMessage(reason, "操作没有完成，请稍后重试")); onChanged(); }
    finally { setBusy(null); }
  }, [onChanged]);
  return { value, busy, run };
}

/** 确认坞里的文件操作确认；决定之后由时间线的决定节点显示执行进度与结果。 */
export function ActionCard({ id, action, fallback, onChanged, onFilesChanged }: {
  id: string; action?: ai.AssistantAction; fallback: { kind: string; count: number; auto?: boolean }; onChanged: () => void; onFilesChanged?: () => void;
}) {
  const { value, busy, run: execute } = useActionState(id, action, fallback, onChanged, onFilesChanged);
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
  const status = value?.status ?? "pending";
  const now = useNow(status === "pending") / 1000;
  const expired = status === "pending" && value != null && value.expires_at <= now;
  const run = (label: string, task: () => Promise<ai.AssistantAction>) => execute(label, task).finally(() => setArmed(false));

  if (!value) return <section className="ai-card ai-action is-loading"><SkeletonRows rows={2} /></section>;
  const payload = value.payload ?? {};
  const kind = value.kind || fallback.kind;
  const danger = Boolean(payload.danger);
  const share = kind === "share";
  const many = value.count > 1000;
  const pending = status === "pending" && !expired;
  const [label, tone] = STATUS_LABEL[expired ? "expired" : status] ?? [status, "neutral" as Tone];
  const samples = payload.samples ?? [];
  const days = shareDays ?? payload.options?.expires_days ?? 0;
  const cross = CROSS_KINDS.includes(kind);
  const moveOut = kind === "move_out";
  // 移出的目标是普通目录（对象键）；移入的目标是私密空间里的目录（对象键带私密前缀，提交时去掉），助手可以给出默认值（相对私密空间根）。
  const chosen = target ?? (moveOut ? payload.options?.target ?? "" : api.PRIVATE_PREFIX + (payload.options?.target ?? ""));
  const unlocked = Boolean(api.getPrivateAccess());
  const crossBlocked = cross && (!targetReady || (moveOut ? !verify && !password : !unlocked));
  const crossInput = () => ({ target: moveOut ? chosen : chosen.slice(api.PRIVATE_PREFIX.length) });
  const iconTone: Tone = danger || moveOut ? "danger" : share ? "public" : status === "done" ? "success" : "accent";
  return <section className={`ai-card ai-action is-${expired ? "expired" : status}${danger || moveOut ? " is-danger" : ""}`}>
    <CardHead icon={ACTION_ICONS[kind] ?? "check"} tone={iconTone} title={payload.title ?? ai.ACTION_KINDS[kind] ?? kind} subtitle={payload.summary}
      badge={<Badge tone={danger ? "danger" : tone}>{danger ? "不可恢复" : label}</Badge>} />
    <div className="ai-chips">
      <span><Icon name="folder" size={12} />{display(payload.scope ?? "")}</span>
      <span>{value.count.toLocaleString("zh-CN")} 项</span>
      {payload.size ? <span>{formatBytes(payload.size)}</span> : null}
      {kind === "downloads" && payload.options?.target != null && <span><Icon name="download" size={12} />保存到 {display(payload.options.target)}</span>}
      {cross && !pending && <span><Icon name={moveOut ? "unlock" : "lock"} size={12} />{moveOut ? "移到普通文件" : "移入私密空间"}</span>}
      {(payload.conflicts ?? 0) > 0 && <span className="tone-warning">{payload.conflicts} 项将跳过</span>}
      {kind === "trash" && <TrashChips options={payload.options} />}
    </div>
    {payload.confirm_reason && pending && <p className="ai-card-note"><Icon name="shield" size={13} />{payload.confirm_reason}</p>}
    {samples.length > 0 && <ItemList kind={kind} items={samples.slice(0, 3)} />}
    {(value.count > 3 || (payload.conflicts ?? 0) > 0) && <button type="button" className="ai-link" onClick={() => setDetails(true)}>查看全部 {value.count.toLocaleString("zh-CN")} 项</button>}
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
        : <p className="ai-card-note"><Icon name="lock" size={13} />解锁私密空间后选择位置并确认移入。
          <button type="button" className="ai-link" onClick={() => window.dispatchEvent(new CustomEvent(ai.UNLOCK_EVENT))}>解锁私密空间</button></p>}
      {moveOut && <MoveOutVerify password={password} onPassword={value => { setPassword(value); setVerify(""); }} verified={Boolean(verify)}
        onPasskey={async signal => { passkeyAssertion.current = await privatePasskeyAssertion(signal); setPassword(""); setVerify("passkey"); }} />}
      <small>{moveOut ? "移出后文件不再受私密空间保护；同名时自动改名，不能撤销。" : "移入后公开链接会被取消；目标位置不会告诉助手。同名时自动改名，不能撤销。"}</small>
    </div>}
    {pending && danger && <label className="ai-ack"><Checkbox checked={acknowledged} onChange={setAcknowledged} label="我了解此操作不可恢复" /><span>我了解此操作不可恢复</span></label>}
    {pending && <footer className="ai-card-foot">
      <span>{formatDateTime(value.expires_at)} 前有效</span>
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
  return <Modal className="assistant-dialog" title={`${action.payload?.title ?? "操作"}：全部条目`} description={action.payload?.summary} size="lg" onClose={onClose}
    footer={<Button onClick={onClose}>关闭</Button>}>
    {compacted && <InlineNotice>这个操作已超过 30 天，只保留了前 20 条样例。</InlineNotice>}
    {action.kind === "downloads" && action.result?.failed ? <InlineNotice>部分图片需要来源页的登录或防盗链，可以在来源页用抓取脚本的「本地下载」保存。</InlineNotice> : null}
    {failures.length > 0 && <section className="ai-items-section"><h4>执行时跳过或失败</h4>
      <ul className="ai-diff is-plain">{failures.map((item, index) => <li key={index} className="ai-diff-row"><Icon name={item.path.endsWith("/") ? "folder" : "file"} size={13} /><PathText path={item.path} /><small>{item.reason}</small></li>)}</ul></section>}
    {skipped.length > 0 && <section className="ai-items-section"><h4>提议时已跳过（{skipped.length}）</h4>
      <ul className="ai-diff is-plain">{skipped.map((item, index) => <li key={index} className="ai-diff-row"><Icon name={item.path.endsWith("/") ? "folder" : "file"} size={13} /><PathText path={item.path} /><small>{item.reason}</small></li>)}</ul></section>}
    <section className="ai-items-section"><h4>操作条目（{action.count.toLocaleString("zh-CN")}）</h4>
      {items === null ? <SkeletonRows rows={4} /> : <ItemList kind={action.kind} items={items} full />}
      {next !== null && <Button size="sm" onClick={() => load(next)}>加载更多</Button>}
    </section>
  </Modal>;
}
