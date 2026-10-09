import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SITE } from "../brand";
import * as api from "../api";

import { Badge, Button, ConfirmDialog, EmptyState, Field, Icon, Menu, Modal, PageHeader, SkeletonRows, formatBytes, formatDate, formatDateTime, toast, useDocumentTitle } from "../ui";

/* ---------- 存储通道 ---------- */

export function Bots() {
  const [bots, setBots] = useState<api.BotConfig[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [disabling, setDisabling] = useState<api.BotConfig | null>(null);
  const [checking, setChecking] = useState<number | null>(null);
  const [error, setError] = useState("");
  useDocumentTitle(`存储通道 · ${SITE.admin}`);
  const load = useCallback(() => { setError(""); void api.adminBots().then(setBots).catch(reason => setError(api.errorMessage(reason, "存储通道加载失败，请稍后重试"))); }, []);
  useEffect(load, [load]);
  async function setStatus(bot: api.BotConfig, status: "active" | "disabled") {
    try { await api.setAdminBotStatus(bot.id, status); toast.success(status === "active" ? `已启用 ${bot.name}` : `已停用 ${bot.name}`); load(); return true; }
    catch (reason) { toast.error(api.errorMessage(reason, "状态更新失败，请稍后重试")); return false; }
  }
  async function check(bot: api.BotConfig, quiet = false) {
    setChecking(bot.id);
    try {
      const result = await api.checkAdminBot(bot.id);
      if (!quiet) result.ok ? toast.success(`${bot.name} 连接正常`) : toast.error(`${bot.name}：${result.status}`);
      load();
    } catch (reason) { toast.error(api.errorMessage(reason, "检查失败，请稍后重试")); }
    finally { setChecking(null); }
  }
  const active = (bots ?? []).filter(bot => bot.status === "active").length;
  return (
    <>
      <PageHeader title="存储通道" description="查看各通道的分片容量、启用状态与最近连接检查。"
        actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>添加通道</Button>} />
      {!error && bots !== null && active === 0 && <p className="inline-note tone-warning banner"><Icon name="alert" size={16} />当前没有启用的通道，新上传的文件会加密后暂存在服务器本地磁盘。</p>}
      <section className="file-surface table-scroll">
        {error ? <EmptyState icon="alert" title="存储通道加载失败" description={error} action={<Button icon="refresh" onClick={load}>重试</Button>} /> : bots === null ? <SkeletonRows rows={3} /> : bots.length === 0 ? (
          <EmptyState icon="send" title="还没有存储通道" description="在 Telegram 中通过 BotFather 创建 Bot，把它设为私有频道的管理员，然后在这里添加。" action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>添加通道</Button>} />
        ) : (
          <div className="data-table bots-table" role="table" aria-label="存储通道">
            <div className="data-row data-head" role="row">
              <span role="columnheader">通道</span><span role="columnheader">频道 ID</span><span role="columnheader">分片数量</span><span role="columnheader">存储大小</span><span role="columnheader">启用状态</span><span role="columnheader">最近连接检查</span><span role="columnheader"><span className="sr-only">操作</span></span>
            </div>
            {bots.map(bot => (
              <div key={bot.id} role="row" className="data-row">
                <span role="cell" className="cell-user"><span className={`channel-mark${bot.status === "active" ? " is-active" : ""}`}><Icon name="send" size={16} /></span><span className="name-stack"><strong>{bot.name}</strong><small>添加于 {formatDate(bot.created_at)}</small></span></span>
                <span role="cell"><code className="mono">{bot.channel_id}</code></span>
                <span role="cell" className="cell-size muted">{bot.chunk_count == null ? "—" : `${bot.chunk_count.toLocaleString("zh-CN")} 个`}</span>
                <span role="cell" className="cell-size muted">{bot.stored_bytes == null ? "—" : formatBytes(bot.stored_bytes)}</span>
                <span role="cell">{bot.status === "active" ? <Badge tone="success" dot>启用</Badge> : <Badge dot>已停用</Badge>}</span>
                <span role="cell" className="check-cell">
                  {!bot.last_check_at ? <span className="muted">尚未检查</span>
                    : bot.last_check_status === "ok" ? <Badge tone="success" icon="check">连接正常</Badge>
                      : <Badge tone="danger" icon="alert">连接异常</Badge>}
                  {bot.last_check_at && <small className="muted" title={bot.last_check_status === "ok" ? undefined : bot.last_check_status ?? undefined}>
                    {bot.last_check_status === "ok" ? formatDateTime(bot.last_check_at) : bot.last_check_status}
                  </small>}
                  {bot.runtime?.cooldown_seconds ? <small className="tone-warning">限速退避 {Math.ceil(bot.runtime.cooldown_seconds)} 秒</small>
                    : bot.runtime?.failures ? <small className="tone-warning">连续失败 {bot.runtime.failures} 次</small> : null}
                </span>
                <span role="cell" className="cell-actions">
                  <Menu label={`${bot.name} 的操作`} items={[
                    { label: checking === bot.id ? "正在检查…" : "检查连接", icon: "refresh", onSelect: () => void check(bot) },
                    bot.status === "active"
                      ? { label: "停用", icon: "lock", danger: true, divider: true, onSelect: () => setDisabling(bot) }
                      : { label: "启用", icon: "unlock", divider: true, onSelect: () => void setStatus(bot, "active") },
                  ]} />
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      <p className="channel-storage-note">分片是文件加密后拆分的存储单元。统计包含上传中及回收站的分片，大小为加密后的容量；待清理分片和频道中的其他消息不计入。</p>
      <details className="settings-disclosure channel-help"><summary><Icon name="shield" size={17} /><span>通道与安全说明</span><Icon name="chevronDown" size={16} /></summary><div className="disclosure-body">
        <ul className="plain-list">
          <li>每个通道由一个 Telegram Bot 和一个私有频道组成，新文件保存到已启用的通道。</li>
          <li>Bot token 加密保存，页面和接口都不会再显示明文。</li>
          <li>私有频道中只保留存储用的 Bot，并关闭不需要的管理员权限。</li>
          <li>停用通道只影响之后上传的文件；已经保存在这个通道里的文件仍可正常读取。</li>
        </ul>
      </div></details>
      {creating && <CreateBotDialog onClose={() => setCreating(false)} onCreated={bot => { setCreating(false); void check(bot, true); }} />}
      {disabling && <ConfirmDialog title={`停用 ${disabling.name}？`} description="新上传的文件不会再保存到这个通道，已保存的文件仍可正常读取。" confirmLabel="停用通道" onClose={() => setDisabling(null)}
        onConfirm={async () => { if (await setStatus(disabling, "disabled")) setDisabling(null); }} />}
    </>
  );
}

function CreateBotDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (bot: api.BotConfig) => void }) {
  const [form, setForm] = useState({ name: "", token: "", channel: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = "请输入显示名称";
    if (!/^\d+:[\w-]{20,}$/.test(form.token.trim())) next.token = "格式应为 123456789:AA… 的完整 token";
    if (!/^(-100\d+|@\w{4,})$/.test(form.channel.trim())) next.channel = "填写 -100 开头的数字 ID，或 @频道用户名";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const bot = await api.createAdminBot(form.name.trim(), form.token.trim(), form.channel.trim());
      toast.success("存储通道已添加，正在检查连接");
      onCreated(bot);
    }
    catch (reason) { setErrors({ token: api.errorMessage(reason, "添加失败，请检查 token 和频道") }); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="添加存储通道" description="token 保存后只以密文存在，不会再次显示。" icon="send" onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="bot-form" loading={busy}>添加通道</Button></>}>
      <form id="bot-form" className="form" onSubmit={submit} noValidate>
        <Field label="显示名称" htmlFor="bot-name" error={errors.name}>
          <input id="bot-name" className="input" value={form.name} placeholder="例如：主存储" onChange={event => setForm({ ...form, name: event.target.value })} autoFocus />
        </Field>
        <Field label="Bot token" htmlFor="bot-token" error={errors.token} hint="在 Telegram 中向 @BotFather 发送 /newbot 获取。">
          <input id="bot-token" className="input mono" type="password" autoComplete="new-password" value={form.token} onChange={event => setForm({ ...form, token: event.target.value })} />
        </Field>
        <Field label="私有频道" htmlFor="bot-channel" error={errors.channel} hint="Bot 必须是该频道的管理员，并拥有发送消息的权限。">
          <input id="bot-channel" className="input mono" value={form.channel} placeholder="-1001234567890" onChange={event => setForm({ ...form, channel: event.target.value })} />
        </Field>
      </form>
    </Modal>
  );
}
