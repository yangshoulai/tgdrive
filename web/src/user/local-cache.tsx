import { type ReactNode, useCallback, useEffect, useId, useState } from "react";

import * as api from "../api";
import { type CacheStats, cacheStats, cacheSupported, clearCache, isStandalone, loadSettings, resetAllDevices, saveSettings, storageEstimate } from "../cache-client";
import { type DeviceSettings, type Kind, SIZE_CHOICES, webkitOnly } from "../cache-store";
import { Badge, Button, ConfirmDialog, EmptyState, Field, Icon, Switch, formatBytes, formatDate, toast } from "../ui";

const KIND_LABEL: Record<Kind, string> = { image: "图片", video: "视频", audio: "音频", thumb: "缩略图", other: "其他" };
const KIND_ORDER: Kind[] = ["image", "video", "audio", "thumb", "other"];
const baseName = (path: string) => path.replace(/\/$/, "").split("/").pop() || path || "未命名文件";
const sizeLabel = (mib: number) => mib >= 1024 ? `${mib / 1024} GB` : `${mib} MB`;

/** 用户设置 →「本机缓存」：浏览器本地缓存的统计、设置与清理（docs/client-cache-design.md §5）。设置只属于这台设备的这个浏览器。 */
export function LocalCacheSettings() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [settings, setSettings] = useState<DeviceSettings | null>(null);
  const [estimate, setEstimate] = useState<Awaited<ReturnType<typeof storageEstimate>>>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"private" | "reset" | null>(null);
  const supported = cacheSupported();

  const refresh = useCallback(async () => {
    try {
      const [value, current, storage] = await Promise.all([cacheStats(), loadSettings(), storageEstimate()]);
      setStats(value); setSettings(current); setEstimate(storage); setError("");
    } catch (reason) {
      setSettings(await loadSettings().catch(() => null));
      setError(api.errorMessage(reason, "本机缓存状态读取失败"));
    }
  }, []);
  useEffect(() => { if (supported) void refresh(); }, [supported, refresh]);

  if (!supported) return <EmptyState icon="monitor" title="这个浏览器不能使用本机缓存"
    description="本机缓存需要通过 HTTPS 访问，并且浏览器支持 Service Worker 与 IndexedDB。隐私（无痕）模式下也无法使用。不影响正常浏览文件。" />;

  async function update(patch: Partial<DeviceSettings>, message?: string) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setBusy(true);
    try {
      await saveSettings(next);
      // 关闭某一层时同时清除它的数据，不留下用户以为已经关掉的副本。
      if (patch.enabled === false) await clearCache("normal");
      if (patch.private === false) await clearCache("private");
      setSettings(next);
      if (message) toast.success(message);
      await refresh();
    } catch (reason) { toast.error(api.errorMessage(reason, "保存失败")); }
    finally { setBusy(false); }
  }

  async function wipe(scope: "normal" | "private" | "others", message: string) {
    setBusy(true);
    try { await clearCache(scope); toast.success(message); await refresh(); }
    catch (reason) { toast.error(api.errorMessage(reason, "清除失败")); }
    finally { setBusy(false); }
  }

  async function remove(key: string) {
    try { await clearCache("entry", key); await refresh(); }
    catch (reason) { toast.error(api.errorMessage(reason, "移除失败")); }
  }

  const policy = stats?.policy ?? null;
  const adminOff = policy !== null && !policy.enabled;
  const normalLimit = settings ? Math.min(settings.maxMiB, policy?.max_mib ?? settings.maxMiB) : 0;
  const privateLimit = settings ? Math.min(settings.privateMaxMiB, policy?.private_max_mib ?? settings.privateMaxMiB) : 0;
  const kinds = KIND_ORDER.map(kind => ({ kind, bytes: stats?.normal.kinds[kind] ?? 0 })).filter(item => item.bytes > 0);
  const privateOn = Boolean(settings?.private && policy?.private_enabled);

  return <>
    <Section icon="monitor" title="本机缓存" description="文件内容按块加密保存在这个浏览器里，只有登录同一账号时才能解开。">
      {error && <p className="form-alert" role="alert"><Icon name="alert" size={15} />{error}</p>}
      {adminOff ? <p className="inline-note"><Icon name="info" size={15} />管理员已关闭浏览器本地缓存，这台设备上的普通文件缓存已清除。</p>
        : settings && <Switch checked={settings.enabled} disabled={busy} onChange={value => void update({ enabled: value }, value ? "已开启本机缓存" : "已关闭本机缓存并清除数据")}
          label="在这台设备上缓存文件" description="自动保存看过的图片、音乐、视频片段和缩略图；也可点击文件旁的缓存按钮保存完整文件，供预览和下载复用。" />}
      {stats && <div className="local-cache-figures folder-stats-figures">
        <div><span>普通文件</span><strong>{formatBytes(stats.normal.bytes)}</strong><small>上限 {sizeLabel(normalLimit)} · {stats.normal.count.toLocaleString("zh-CN")} 项</small></div>
        <div><span>私密文件</span><strong>{formatBytes(stats.private.bytes)}</strong><small>{privateOn ? `上限 ${sizeLabel(privateLimit)} · ${stats.private.count} 项` : "未开启"}</small></div>
        <div><span>浏览器占用</span><strong>{estimate ? formatBytes(estimate.usage) : "—"}</strong><small>{estimate ? `${estimate.persisted ? "已持久保存" : "空间不足时可能被浏览器清除"}` : "浏览器未提供"}</small></div>
      </div>}
      {kinds.length > 0 && <div className="local-cache-kinds">
        <div className="folder-stats-bar" role="img" aria-label={kinds.map(item => `${KIND_LABEL[item.kind]} ${formatBytes(item.bytes)}`).join("，")}>
          {kinds.map(item => <span key={item.kind} className={`kind-${item.kind}`} style={{ flexGrow: item.bytes }} title={`${KIND_LABEL[item.kind]} ${formatBytes(item.bytes)}`} />)}
        </div>
        <ul className="local-cache-legend">{kinds.map(item => <li key={item.kind}><i className={`folder-stats-swatch kind-${item.kind}`} aria-hidden="true" />{KIND_LABEL[item.kind]} {formatBytes(item.bytes)}</li>)}</ul>
      </div>}
      {settings && webkitOnly(navigator.userAgent) && !isStandalone() && <p className="inline-note"><Icon name="info" size={15} />
        Safari 会清除 7 天内没有访问过的网站数据。把 Tessera 添加到主屏幕后打开，缓存可以保留得更久。</p>}
    </Section>

    {settings && !adminOff && <Section icon="settings" title="容量与内容" description="只对这台设备上的这个浏览器生效。">
      <CacheSizeSelect label="最多占用" value={settings.maxMiB} limit={policy?.max_mib} disabled={busy || !settings.enabled}
        hint="超出后自动移除最久没有打开的文件。" onChange={value => void update({ maxMiB: value }, "已保存")} />
      <Switch checked={settings.video} disabled={busy || !settings.enabled} onChange={value => void update({ video: value }, "已保存")} label="自动缓存视频片段"
        description={webkitOnly(navigator.userAgent) ? "Safari 对缓存视频的支持还不稳定，如果开启后播放异常，请关闭此项。" : "按看过的片段保存，拖回已看过的位置时不必重新下载。"} />
    </Section>}

    {settings && policy?.private_enabled && <Section icon="shield" title="私密文件" description="锁定后无法解开；每次读取都需要服务器确认私密空间已解锁、文件仍在私密空间中。">
      <div className="account-setting-summary"><div>
        <strong>{settings.private ? "这台设备会缓存私密文件" : "不缓存私密文件"}</strong>
        <p>只在你信任的个人设备上开启。超过 {policy.private_ttl_days} 天没有打开的私密文件会被自动清除。</p>
      </div><Badge tone={settings.private ? "success" : "neutral"}>{settings.private ? "已开启" : "未开启"}</Badge></div>
      <div className="account-private-actions">
        {settings.private
          ? <Button size="sm" disabled={busy} onClick={() => void update({ private: false }, "已关闭并清除私密缓存")}>关闭并清除</Button>
          : <Button size="sm" icon="shield" disabled={busy || !settings.enabled} onClick={() => setConfirm("private")}>信任这台设备</Button>}
      </div>
      {settings.private && <CacheSizeSelect label="私密文件最多占用" value={settings.privateMaxMiB} limit={policy.private_max_mib} disabled={busy}
        onChange={value => void update({ privateMaxMiB: value }, "已保存")} />}
    </Section>}

    {stats && stats.items.length > 0 && <Section icon="list" title="已缓存的文件" description="最近打开的文件；移除只删除本机副本，不影响文件本身。">
      <ul className="account-attachments local-cache-items" aria-label="已缓存的文件">
        {stats.items.map(item => <li key={item.key}>
          <Icon name={item.kind === "video" ? "video" : item.kind === "audio" ? "audio" : item.kind === "image" ? "image" : "file"} size={15} />
          <span className="account-attachments-title"><strong title={item.path}>{baseName(item.path)}</strong>
            <small>{item.bytes >= item.size ? formatBytes(item.size) : `已缓存 ${formatBytes(item.bytes)} / ${formatBytes(item.size)}`} · {formatDate(item.accessed / 1000)}</small></span>
          <Button size="sm" variant="ghost" onClick={() => void remove(item.key)}>移除</Button>
        </li>)}
      </ul>
    </Section>}

    <Section icon="trash" title="清理" description="清除只影响这台设备。">
      <div className="account-private-actions">
        <Button size="sm" disabled={busy || !stats?.normal.count} onClick={() => void wipe("normal", "已清除普通文件缓存")}>清除普通文件缓存</Button>
        {(stats?.private.count ?? 0) > 0 && <Button size="sm" disabled={busy} onClick={() => void wipe("private", "已清除私密文件缓存")}>清除私密文件缓存</Button>}
        {(stats?.others.count ?? 0) > 0 && <Button size="sm" disabled={busy} onClick={() => void wipe("others", "已清除其他账号的缓存")}>清除其他账号的缓存（{formatBytes(stats!.others.bytes)}）</Button>}
      </div>
      <div className="account-setting-summary local-cache-reset"><div>
        <strong>重置所有设备的缓存</strong>
        <p>让你在所有设备上的本机缓存都无法再解开，例如设备丢失时。修改登录密码也会有同样效果。</p>
      </div><Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirm("reset")}>重置</Button></div>
    </Section>

    {confirm === "private" && <ConfirmDialog danger={false} title="信任这台设备？" confirmLabel="开启"
      description="打开过的私密文件会加密保存在这个浏览器里。私密空间锁定后无法解开，但请不要在公用或他人的设备上开启。"
      onClose={() => setConfirm(null)} onConfirm={async () => { await update({ private: true }, "已开启私密文件缓存"); setConfirm(null); }} />}
    {confirm === "reset" && <ConfirmDialog title="重置所有设备的缓存？" confirmLabel="重置"
      description="所有设备上已有的本机缓存都将失效，之后打开文件需要重新下载。这台设备上的缓存会立即清除。"
      onClose={() => setConfirm(null)} onConfirm={async () => {
        try { await resetAllDevices(); toast.success("已重置，其他设备的缓存会在下次使用时清除"); setConfirm(null); await refresh(); }
        catch (reason) { toast.error(api.errorMessage(reason, "重置失败")); }
      }} />}
  </>;
}

function Section({ icon, title, description, children }: { icon: "monitor" | "settings" | "shield" | "list" | "trash"; title: string; description: string; children: ReactNode }) {
  const id = useId();
  return <section className="account-section" aria-labelledby={`${id}-title`}>
    <header className="account-section-heading"><Icon name={icon} size={20} /><div><h2 id={`${id}-title`}>{title}</h2><p>{description}</p></div></header>
    <div className="account-section-content local-cache-section">{children}</div>
  </section>;
}

function CacheSizeSelect({ label, value, limit, hint, disabled, onChange }: { label: string; value: number; limit?: number; hint?: string; disabled?: boolean; onChange: (value: number) => void }) {
  const id = useId();
  const choices = SIZE_CHOICES.filter(choice => !limit || choice <= limit);
  const effective = limit ? Math.min(value, limit) : value;
  if (!choices.includes(effective)) choices.push(effective);
  return <Field label={label} htmlFor={id} hint={hint ?? (limit && value > limit ? `管理员限制每台设备最多 ${sizeLabel(limit)}` : undefined)}>
    <select id={id} className="input local-cache-select" value={effective} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>
      {choices.sort((a, b) => a - b).map(choice => <option key={choice} value={choice}>{sizeLabel(choice)}</option>)}
    </select>
  </Field>;
}
