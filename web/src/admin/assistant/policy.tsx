/** 系统管理 · 文件助手 · 单个用户的助手策略（用户列表里打开）。（docs/assistant-design.md §12.1） */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { SITE } from "../../brand";
import * as api from "../../api";
import * as ai from "../../assistant-api";
import { Notice, Badge, Button, ByteSizeInput, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, KeyValue, Menu, Modal, PageHeader, Panel, PasswordField, SetupGuide, SearchInput, Segmented,
  SkeletonRows, Switch, Tabs, Disclosure, formatBytes, formatDateTime, toast, confirmLeave, useDocumentTitle, useUnsavedChanges, type IconName, type Tone } from "../../ui";
import { Stat } from "../overview";
import { CurveChart } from "../../curve-chart";

import { tokens } from "./shared";

export function AssistantPolicyDialog({ user, onClose }: { user: api.Account; onClose: () => void }) {
  const [policy, setPolicy] = useState<ai.UserPolicy | null>(null);
  const [form, setForm] = useState({ enabled: "inherit", max_level: "inherit", daily_tokens: "", full_access: "inherit", private: "inherit" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void ai.adminPolicy(user.id).then(value => {
      setPolicy(value);
      setForm({ enabled: value.enabled === null ? "inherit" : value.enabled ? "on" : "off", max_level: value.max_level ?? "inherit", daily_tokens: value.daily_tokens === null ? "" : String(value.daily_tokens),
        full_access: value.full_access === null ? "inherit" : value.full_access ? "on" : "off",
        private: value.private === null ? "inherit" : value.private ? "on" : "off" });
    }).catch(reason => setError(api.errorMessage(reason, "加载失败")));
  }, [user.id]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await ai.updateAdminPolicy(user.id, { enabled: form.enabled === "inherit" ? null : form.enabled === "on",
        max_level: form.max_level === "inherit" ? null : form.max_level as "read" | "write" | "danger",
        daily_tokens: form.daily_tokens.trim() === "" ? null : Number(form.daily_tokens),
        full_access: form.full_access === "inherit" ? null : form.full_access === "on",
        private: form.private === "inherit" ? null : form.private === "on" });
      toast.success(`已更新 ${api.displayName(user)} 的文件助手设置`); onClose();
    } catch (reason) { setError(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={`${api.displayName(user)} · 文件助手`} icon="sparkle" size="sm" onClose={onClose} dismissible={!busy}
      footer={<><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" type="submit" form="policy-form" loading={busy} disabled={!policy}>保存</Button></>}>
      {!policy ? (error ? <Notice tone="danger">{error}</Notice> : <SkeletonRows rows={3} />) : <form id="policy-form" className="form" onSubmit={submit} noValidate>
        <Field label="使用权限"><select className="input" value={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.value })}>
          <option value="inherit">跟随全局（允许）</option><option value="on">允许</option><option value="off">禁止</option></select></Field>
        <Field label="最高操作级别" hint="只读：只能查询与统计；普通写入：可提议改名、移动、移入回收站等；含不可恢复操作：还可提议清空回收站。所有写入仍需用户逐项确认。">
          <select className="input" value={form.max_level} onChange={event => setForm({ ...form, max_level: event.target.value })}>
            <option value="inherit">跟随全局（普通写入）</option><option value="read">只读</option><option value="write">普通写入</option><option value="danger">含不可恢复操作</option></select></Field>
        <Field label="完全访问模式" hint="允许后，用户可以让普通修改自动执行（仍可撤销）。">
          <select className="input" value={form.full_access} onChange={event => setForm({ ...form, full_access: event.target.value })}>
            <option value="inherit">跟随“限制与额度”中的全局设置</option>
            <option value="on">允许</option><option value="off">不允许</option></select></Field>
        <Field label="私密对话" hint="允许后，用户解锁私密空间即可让助手处理私密文件；禁止时立即停止该用户进行中的私密任务。">
          <select className="input" value={form.private} onChange={event => setForm({ ...form, private: event.target.value })}>
            <option value="inherit">跟随“限制与额度”中的全局设置</option>
            <option value="on">允许</option><option value="off">不允许</option></select></Field>
        <Field label="每日 token" hint={`留空跟随全局（当前 ${policy.effective.daily_tokens ? tokens(policy.effective.daily_tokens) : "不限"}），0 表示不限。`}>
          <input className="input" type="number" min={0} value={form.daily_tokens} onChange={event => setForm({ ...form, daily_tokens: event.target.value })} /></Field>
        <KeyValue items={[["今日用量", tokens(policy.usage.today)], ["近 30 天", tokens(policy.usage.days30)]]} />
        {error && <Notice tone="danger">{error}</Notice>}
      </form>}
    </Modal>
  );
}
