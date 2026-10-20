import { useState } from "react";
import * as ai from "../assistant-api";
import { Button, Icon, IconButton } from "../ui";
import { ActionCard, HttpRequestCard, ScopeCard, useNow, type HttpApproval } from "./assistant-thread";

export type ReviewRequest =
  | { id: string; kind: "action" | "scope"; at: number; action: ai.AssistantAction }
  | { id: string; kind: "question"; at: number; question: string; options: string[] }
  | { id: string; kind: "http"; at: number; approval: HttpApproval };

/** 只有仍可决定的请求进入输入区；历史决定和已回答的问题不会重新出现。 */
export function pendingReviews(detail: ai.ConversationDetail, http: HttpApproval[], runId: string | null, now: number): ReviewRequest[] {
  const requests: ReviewRequest[] = detail.actions.filter(action => action.status === "pending" && action.expires_at * 1000 > now)
    .map(action => ({ id: action.id, kind: action.kind === "scope" ? "scope" : "action", at: action.created_at * 1000, action }));
  for (const approval of http) if (approval.status === "pending" && approval.expires > now && approval.runId === runId) {
    requests.push({ id: approval.callId, kind: "http", at: approval.requestedAt * 1000, approval });
  }
  const question = [...detail.messages].reverse().find(message => message.event?.type === "question");
  if (!runId && question?.event?.type === "question" && !detail.messages.some(message => message.role === "user" && message.seq > question.seq)) {
    requests.push({ id: `question-${question.seq}`, kind: "question", at: (question.created_at ?? 0) * 1000,
      question: question.event.question, options: question.event.options ?? [] });
  }
  return requests.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export function ReviewQueue({ detail, httpApprovals, runId, onHttpDecision, onAnswer, onFeedback, onScope, onActionChanged, onFilesChanged }: {
  detail: ai.ConversationDetail; httpApprovals: HttpApproval[]; runId: string | null;
  onHttpDecision: (id: string, decision: ai.HttpDecision) => void;
  onAnswer: (text: string) => Promise<void>; onFeedback: (request: ReviewRequest, text: string) => Promise<void>;
  onScope: (id: string, approve: boolean) => void; onActionChanged: () => void; onFilesChanged?: () => void;
}) {
  const now = useNow(detail.actions.some(action => action.status === "pending") || httpApprovals.some(item => item.status === "pending"));
  const requests = pendingReviews(detail, httpApprovals, runId, now);
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const current = requests.find(request => request.id === selected) ?? requests[0];
  if (!current) return null;
  const index = requests.indexOf(current), draft = drafts[current.id] ?? "", choice = choices[current.id] ?? "";
  const feedback = Boolean(editing[current.id]);
  const update = (value: string) => setDrafts(previous => ({ ...previous, [current.id]: value }));
  const submit = async () => {
    if (busy || (!draft.trim() && !choice)) return;
    setBusy(true);
    setErrors(previous => ({ ...previous, [current.id]: "" }));
    try {
      if (current.kind === "question") await onAnswer([choice, draft.trim()].filter(Boolean).join("\n\n"));
      else await onFeedback(current, draft.trim());
    } catch (reason) {
      setErrors(previous => ({ ...previous, [current.id]: reason instanceof Error ? reason.message : "提交失败，请重试" }));
    } finally { setBusy(false); }
  };
  return <section className="assistant-review" aria-label="待处理请求">
    <header className="assistant-review-head"><Icon name={current.kind === "question" ? "info" : "shield"} size={15} />
      <strong>{current.kind === "question" ? "需要你的回答" : "等待你的确认"}</strong>
      <span role="status">{index + 1} / {requests.length}</span>
      {(current.kind !== "question" || current.options.length > 0) && <button type="button" className="assistant-review-edit" disabled={busy}
        onClick={() => setEditing(previous => ({ ...previous, [current.id]: !feedback }))}>
        {current.kind === "question" ? feedback ? "返回选项" : "补充说明" : feedback ? "返回确认" : "补充要求"}</button>}
      {requests.length > 1 && <div className="assistant-review-nav">
        <IconButton icon="chevronLeft" label="上一个请求" disabled={busy || index === 0} onClick={() => setSelected(requests[index - 1].id)} />
        <IconButton icon="chevronRight" label="下一个请求" disabled={busy || index === requests.length - 1} onClick={() => setSelected(requests[index + 1].id)} />
      </div>}
    </header>
    <div className="assistant-review-body" key={current.id}>
      {errors[current.id] && <p className="ai-card-note tone-danger" role="alert">{errors[current.id]}</p>}
      {!feedback && current.kind === "action" && <ActionCard id={current.id} action={current.action} fallback={current.action} review
        onChanged={onActionChanged} onFilesChanged={onFilesChanged} />}
      {!feedback && current.kind === "scope" && <ScopeCard event={{ type: "scope_request", action_id: current.id, from: current.action.payload?.from ?? "/",
        to: current.action.payload?.to ?? "/", reason: current.action.payload?.reason ?? "" }} action={current.action} running={Boolean(runId)} review onScope={onScope} />}
      {!feedback && current.kind === "http" && <HttpRequestCard request={current.approval.request} decision="pending" approval={current.approval} review onDecide={onHttpDecision} />}
      {current.kind === "question" ? <form className="assistant-review-question" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <h3>{current.question}</h3>
        {!feedback && current.options.length > 0 && <div className="ai-choices" role="radiogroup" aria-label="回答选项" onKeyDown={event => {
          if (busy || event.nativeEvent.isComposing || !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const position = Math.max(0, current.options.indexOf(choice));
          const next = event.key === "Home" ? 0 : event.key === "End" ? current.options.length - 1
            : (position + (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1) + current.options.length) % current.options.length;
          setChoices(previous => ({ ...previous, [current.id]: current.options[next] }));
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
        }}>{current.options.map((option, position) =>
          <button key={option} type="button" role="radio" aria-checked={choice === option} tabIndex={choice ? choice === option ? 0 : -1 : position === 0 ? 0 : -1}
            className={choice === option ? "is-selected" : ""} disabled={busy}
            onClick={() => setChoices(previous => ({ ...previous, [current.id]: choice === option ? "" : option }))}>
            <span className="ai-choice-key">{choice === option ? <Icon name="check" size={12} /> : position + 1}</span><span>{option}</span>
          </button>)}</div>}
        <label className="assistant-review-input"><span>{current.options.length ? "补充说明，也可以直接回答" : "你的回答"}</span>
          <textarea className="input" rows={2} maxLength={4000} value={draft} disabled={busy} onChange={event => update(event.target.value)} placeholder="输入你的要求或想法…" /></label>
        <footer><span>{choice && feedback ? `已选：${choice}` : current.options.length ? "选项和补充说明会一起发送" : "按你的想法回答即可"}</span><Button type="submit" size="sm" variant="primary" disabled={!choice && !draft.trim()} loading={busy}>提交回答</Button></footer>
      </form> : feedback && <div className="assistant-review-feedback">
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <label className="assistant-review-input"><span>告诉助手需要怎样调整</span><textarea className="input" rows={2} maxLength={4000}
            value={draft} disabled={busy} autoFocus onChange={event => update(event.target.value)} placeholder="例如：只处理最近一个月，保留现有目录层级…" /></label>
          <footer><span>当前请求将被拒绝，助手会重新规划</span><Button type="submit" size="sm" disabled={!draft.trim()} loading={busy}>提交补充</Button></footer>
        </form>
      </div>}
    </div>
  </section>;
}
