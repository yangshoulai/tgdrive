import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SITE } from "../brand";
import * as api from "../api";

import { Notice, Badge, Button, ConfirmDialog, EmptyState, Field, Icon, IconButton, Menu, Modal, PageHeader, SetupGuide, SkeletonRows, formatBytes, formatDate, formatDateTime, toast, useDocumentTitle } from "../ui";

/* ---------- 存储通道 ---------- */

/** 存储通道配置步骤；完整说明在管理员文档「存储通道」页（docs-admin-content.tsx），两处同步修改。 */
const STORAGE_STEPS = [
  { title: "创建 Bot，获取 token", body: <p>在 Telegram 中打开 <code>@BotFather</code>，发送 <code>/newbot</code>，按提示设置名称和以 <code>bot</code> 结尾的用户名。完成后它会回复一串形如 <code>123456789:AAH…</code> 的 token，复制备用，不要发给别人。</p> },
  { title: "新建一个私有频道", body: <p>在 Telegram 中选择「新建频道」，类型选<strong>私有</strong>。这个频道只用来存放加密后的分片，不需要邀请其他成员，也不要公开链接。</p> },
  { title: "把 Bot 设为频道管理员", body: <p>进入频道的「管理员」→「添加管理员」，搜索刚才的 Bot 用户名并添加。权限只需保留<strong>发布消息</strong>；Bot 会用它上传分片，并在垃圾回收时删除自己发的消息。</p> },
  { title: "获取频道 ID", body: <>
    <p>私有频道的 ID 是以 <code>-100</code> 开头的数字，例如 <code>-1001234567890</code>。任选一种方式：</p>
    <ul>
      <li>在频道里随便发一条消息，转发给 <code>@userinfobot</code> 或 <code>@RawDataBot</code>，回复中的 <code>id</code> 即是。</li>
      <li>在网页版 <code>web.telegram.org</code> 打开频道，地址栏 <code>#-</code> 后面的数字前加上 <code>-100</code>。</li>
    </ul>
  </> },
  { title: "在这里添加通道", body: <p>点击「添加通道」，填写显示名称、token 和频道 ID。保存后会立即检查 token、频道访问和发消息权限，结果显示在「最近连接检查」列；token 只以密文保存。</p> },
  { title: "按需添加更多通道", body: <p>多个启用的通道会分担上传。Telegram 对单个 Bot 有发送频率限制，文件多、上传频繁时建议准备 2–3 个 Bot 和频道。停用的通道不再接收新分片，已有分片仍可读取。</p> },
];

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
      <PageHeader title="存储通道"
        actions={bots?.length ? <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>添加通道</Button> : undefined} />
      {bots !== null && <SetupGuide id="storage-channels" description="在 Telegram 中准备 Bot 和私有频道，大约需要 5 分钟。" steps={STORAGE_STEPS}
        docHref="/docs/storage-channels" defaultOpen={!error && active === 0} />}
      {/* 还没有通道时只由空状态说明并提供“添加通道”，不再叠加页头按钮和警告横幅。 */}
      {!error && bots !== null && bots.length > 0 && active === 0 && <Notice tone="warning" className="banner">当前没有启用的通道，新上传的文件会加密后暂存在服务器本地磁盘。</Notice>}
      <section className="file-surface table-scroll">
        {error ? <EmptyState icon="alert" title="存储通道加载失败" description={error} action={<Button icon="refresh" onClick={load}>重试</Button>} /> : bots === null ? <SkeletonRows rows={3} /> : bots.length === 0 ? (
          <EmptyState icon="send" title="还没有存储通道" description="在 Telegram 中通过 BotFather 创建 Bot，把它设为私有频道的管理员，然后在这里添加。添加之前，新上传的文件会加密后暂存在服务器本地磁盘。" action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>添加通道</Button>} />
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
                  <IconButton icon="refresh" size="sm" label={checking === bot.id ? "正在检查连接" : "检查连接"} spinning={checking === bot.id} disabled={checking === bot.id} onClick={() => void check(bot)} />
                  <Menu label={`${bot.name} 的操作`} items={[
                    bot.status === "active"
                      ? { label: "停用通道", icon: "lock", danger: true, onSelect: () => setDisabling(bot) }
                      : { label: "启用通道", icon: "unlock", onSelect: () => void setStatus(bot, "active") },
                  ]} />
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      {bots && bots.length > 0 && <p className="channel-storage-note">分片是文件加密后拆分的存储单元。统计包含上传中及回收站的分片，大小为加密后的容量；待清理分片和频道中的其他消息不计入。</p>}
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
        <Field label="Bot token" htmlFor="bot-token" error={errors.token} hint="在 Telegram 中向 @BotFather 发送 /newbot 获取，见页面上方「配置指南」第 1 步。">
          <input id="bot-token" className="input mono" type="password" autoComplete="new-password" value={form.token} onChange={event => setForm({ ...form, token: event.target.value })} />
        </Field>
        <Field label="私有频道" htmlFor="bot-channel" error={errors.channel} hint="以 -100 开头的频道 ID；Bot 必须是该频道的管理员并能发布消息，见「配置指南」第 3、4 步。">
          <input id="bot-channel" className="input mono" value={form.channel} placeholder="-1001234567890" onChange={event => setForm({ ...form, channel: event.target.value })} />
        </Field>
      </form>
    </Modal>
  );
}
