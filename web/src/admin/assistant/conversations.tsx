/** 系统管理 · 文件助手 · 对话记录：只有元数据，管理接口不返回对话正文。（docs/assistant-design.md §12.1） */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { SITE } from "../../brand";
import * as api from "../../api";
import * as ai from "../../assistant-api";
import { Notice, Badge, Button, ByteSizeInput, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader, Panel, PasswordField, SetupGuide, SearchInput, Segmented,
  SkeletonRows, Switch, Tabs, Disclosure, formatBytes, formatDateTime, toast, confirmLeave, useDocumentTitle, useUnsavedChanges, type IconName, type Tone } from "../../ui";
import { Stat } from "../overview";
import { CurveChart } from "../../curve-chart";

import { RANGES, sinceOf, tokens, useUserOptions } from "./shared";

export function ConversationsTab() {
  const users = useUserOptions();
  const [userId, setUserId] = useState("");
  const [range, setRange] = useState("30");
  const [action, setAction] = useState("");
  const [items, setItems] = useState<ai.AdminConversation[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const filters = useMemo(() => ({ user_id: userId ? Number(userId) : undefined, since: sinceOf(range), action: action || undefined }), [userId, range, action]);
  const load = useCallback(() => {
    setItems(null); setError("");
    void ai.adminConversations(null, filters).then(page => { setItems(page.conversations); setCursor(page.next_cursor); }).catch(reason => setError(api.errorMessage(reason, "加载失败")));
  }, [filters]);
  useEffect(load, [load]);
  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try { const page = await ai.adminConversations(cursor, filters); setItems(current => [...(current ?? []), ...page.conversations]); setCursor(page.next_cursor); }
    catch (reason) { toast.error(api.errorMessage(reason, "加载失败")); }
    finally { setLoadingMore(false); }
  }
  return (
    <>
      <Notice icon="lock" className="banner">对话正文加密保存，只有用户本人能查看。这里只显示统计信息，用于了解使用情况和清理数据。</Notice>
      <div className="toolbar">
        <div className="toolbar-actions">
          <select className="input input-sm" aria-label="用户" value={userId} onChange={event => setUserId(event.target.value)}>
            <option value="">全部用户</option>{users.map(user => <option key={user.id} value={user.id}>{api.displayName(user)}</option>)}
          </select>
          <select className="input input-sm" aria-label="时间范围" value={range} onChange={event => setRange(event.target.value)}>{Object.entries(RANGES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select className="input input-sm" aria-label="操作" value={action} onChange={event => setAction(event.target.value)}>
            <option value="">全部</option><option value="pending">有待确认操作</option><option value="done">有已执行操作</option><option value="failed">有失败操作</option>
          </select>
        </div>
        <Button icon="trash" onClick={() => setDeleting(true)}>按条件删除…</Button>
      </div>
      <section className="file-surface table-scroll">
        {error ? <EmptyState icon="alert" title="加载失败" description={error} action={<Button onClick={load}>重试</Button>} /> : items === null ? <SkeletonRows rows={4} /> : items.length === 0 ? <EmptyState icon="list" title="没有对话记录" /> : (
          <div className="data-table assistant-conversations-table" role="table" aria-label="对话记录">
            <div className="data-row data-head" role="row"><span role="columnheader">对话</span><span role="columnheader">用户</span><span role="columnheader">模型</span><span role="columnheader">消息</span><span role="columnheader">轮次</span><span role="columnheader">操作</span><span role="columnheader">Token</span><span role="columnheader">最后活动</span><span role="columnheader">状态</span></div>
            {items.map(item => <div key={item.id} role="row" className="data-row is-clickable" tabIndex={0} onClick={() => setDetail(item.id)} onKeyDown={event => { if (event.key === "Enter") setDetail(item.id); }}>
              <span role="cell"><code className="mono">{item.id.slice(0, 10)}…</code></span>
              <span role="cell" className="cell-truncate" title={item.username ?? undefined}>{item.username ?? "—"}</span>
              <span role="cell" className="muted cell-truncate">{item.model_label ?? item.model_name ?? "已删除的模型"}</span>
              <span role="cell">{item.messages}</span>
              <span role="cell">{item.runs}</span>
              <span role="cell">{item.actions}</span>
              <span role="cell" className="muted">{tokens(item.input_tokens + item.output_tokens)}</span>
              <span role="cell" className="muted">{formatDateTime(item.updated_at)}</span>
              <span role="cell">{item.hidden ? <Badge>用户已删除</Badge> : item.archived ? <Badge>已归档</Badge> : <Badge tone="success">正常</Badge>}</span>
            </div>)}
          </div>
        )}
      </section>
      {cursor && <footer className="list-footer"><span /><Button size="sm" loading={loadingMore} onClick={() => void more()}>加载更多</Button></footer>}
      {detail && <ConversationDetailDialog id={detail} onClose={() => setDetail(null)} />}
      {deleting && <DeleteConversationsDialog users={users} onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); load(); }} />}
    </>
  );
}

export const RUN_STATUS: Record<string, string> = { completed: "完成", running: "进行中", stopped: "已停止", failed: "失败", interrupted: "已中断", queued: "排队" };

export function ConversationDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<ai.AdminConversationDetail | null>(null);
  useEffect(() => { void ai.adminConversation(id).then(setData).catch(reason => { toast.error(api.errorMessage(reason, "加载失败")); onClose(); }); }, [id]);
  return (
    <Modal title="对话统计" description="仅元数据：不包含标题、消息、工具参数与结果。" size="lg" onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
      {!data ? <SkeletonRows rows={4} /> : <div className="assistant-detail">
        <KeyValue items={[["对话 ID", <code className="mono" key="id">{data.id}</code>], ["用户", data.username ?? "—"], ["消息", `${data.messages} 条`],
          ["Token", `输入 ${tokens(data.input_tokens)} · 输出 ${tokens(data.output_tokens)}`], ["创建 / 最后活动", `${formatDateTime(data.created_at)} / ${formatDateTime(data.updated_at)}`]]} />
        <h3>运行</h3>
        <div className="data-table assistant-runs-table" role="table" aria-label="运行">
          <div className="data-row data-head" role="row"><span role="columnheader">开始</span><span role="columnheader">状态</span><span role="columnheader">停止原因</span><span role="columnheader">模型调用</span><span role="columnheader">工具调用</span><span role="columnheader">Token</span></div>
          {data.runs.map(run => <div className="data-row" role="row" key={run.id}>
            <span role="cell" className="muted">{formatDateTime(run.started_at)}</span><span role="cell">{RUN_STATUS[run.status] ?? run.status}</span>
            <span role="cell" className="muted">{run.stop_reason ?? "—"}</span><span role="cell">{run.steps}</span><span role="cell">{run.tool_calls}</span>
            <span role="cell" className="muted">{tokens(run.input_tokens + run.output_tokens)}</span>
          </div>)}
        </div>
        {data.tools.length > 0 && <><h3>工具调用</h3><p className="assistant-tool-counts">{data.tools.map(tool => <Badge key={tool.tool_name}>{tool.tool_name} × {tool.count}</Badge>)}</p></>}
        {data.actions.length > 0 && <><h3>操作</h3><KeyValue items={data.actions.map(item => [`${item.kind} · ${formatDateTime(item.created_at)}`, `${item.status} · ${item.count} 项`])} /></>}
      </div>}
    </Modal>
  );
}

export function DeleteConversationsDialog({ users, onClose, onDeleted }: { users: api.Account[]; onClose: () => void; onDeleted: () => void }) {
  const [userId, setUserId] = useState("");
  const [before, setBefore] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState("");
  const input = () => ({ user_id: userId ? Number(userId) : undefined, before: before ? new Date(`${before}T00:00:00`).getTime() / 1000 : undefined });
  useEffect(() => {
    setCount(null); setError("");
    if (!userId && !before) return;
    void ai.deleteAdminConversations({ ...input(), dry_run: true }).then(result => setCount(result.count ?? 0)).catch(reason => setError(api.errorMessage(reason, "统计失败")));
  }, [userId, before]);
  return (
    <ConfirmDialog title="按条件删除对话" confirmLabel={count ? `删除 ${count} 个对话` : "删除"} onClose={onClose}
      description="删除对话及其消息、运行和操作记录，不可恢复。调用日志不受影响。"
      onConfirm={async () => {
        if (!count) { setError(userId || before ? "没有符合条件的对话" : "请至少选择用户或日期"); return; }
        try { const result = await ai.deleteAdminConversations(input()); toast.success(`已删除 ${result.deleted ?? 0} 个对话`); onDeleted(); }
        catch (reason) { setError(api.errorMessage(reason, "删除失败")); }
      }}>
      <Field label="用户"><select className="input" value={userId} onChange={event => setUserId(event.target.value)}><option value="">全部用户</option>{users.map(user => <option key={user.id} value={user.id}>{api.displayName(user)}</option>)}</select></Field>
      <Field label="最后活动早于" hint="留空表示不限日期。"><input className="input" type="date" value={before} onChange={event => setBefore(event.target.value)} /></Field>
      {count !== null && <Notice>符合条件的对话：{count} 个</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </ConfirmDialog>
  );
}

/* ---------- 调用日志 ---------- */

