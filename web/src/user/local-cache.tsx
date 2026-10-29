import { type ReactNode, useCallback, useEffect, useId, useState } from "react";

import * as api from "../api";
import { type CacheStats, cacheStats, cacheSupported, clearCache, isStandalone, loadSettings, resetAllDevices, saveSettings, storageEstimate } from "../cache-client";
import { type DeviceSettings, type Kind, effectiveMiB, sizeChoices, webkitOnly } from "../cache-store";
import { Notice, Badge, Button, ConfirmDialog, Disclosure, EmptyState, Field, Icon, Switch, formatBytes, toast } from "../ui";

const KIND_LABEL: Record<Kind, string> = { image: "图片", video: "视频", audio: "音频", thumb: "缩略图", other: "其他" };
const KIND_ORDER: Kind[] = ["image", "video", "audio", "thumb", "other"];
const sizeLabel = (mib: number) => mib >= 1024 ? `${mib / 1024} GB` : `${mib} MB`;

/** 设置 →「本机缓存」：浏览器本地缓存的统计、设置与清理（docs/client-cache-design.md §5）。设置只属于这台设备的这个浏览器。 */
export function LocalCacheSettings() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [settings, setSettings] = useState<DeviceSettings | null>(null);
  const [estimate, setEstimate] = useState<Awaited<ReturnType<typeof storageEstimate>>>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"private" | "reset" | "all" | null>(null);
  const supported = cacheSupported();

  const refresh = useCallback(async () => {
    try {
      const [value, current, storage] = await Promise.all([cacheStats(), loadSettings(), storageEstimate()]);
      setStats(value); setSettings(current); setEstimate(storage); setError("");
    } catch (reason) {
      setSettings(await loadSettings().catch(() => null));
      setError(api.errorMessage(reason, "本机缓存状态读取失败，请刷新页面后重试"));
    }
  }, []);
  useEffect(() => { if (supported) void refresh(); }, [supported, refresh]);

  if (!supported) return <EmptyState icon="monitor" title="这个浏览器不能使用本机缓存"
    description="需要通过 https:// 地址访问，并使用较新的 Chrome、Edge、Firefox 或 Safari；隐私（无痕）模式下无法使用。不影响正常浏览和下载文件。" />;

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
    } catch (reason) { toast.error(api.errorMessage(reason, "保存失败，请稍后重试")); }
    finally { setBusy(false); }
  }

  async function wipe(scope: "normal" | "private" | "all", message: string) {
    setBusy(true);
    try { await clearCache(scope); toast.success(message); await refresh(); }
    catch (reason) { toast.error(api.errorMessage(reason, "清除失败，请稍后重试")); }
    finally { setBusy(false); }
  }

  const policy = stats?.policy ?? null;
  const adminOff = policy !== null && !policy.enabled;
  const normalLimit = settings?.maxMiB ?? 0, privateLimit = settings?.privateMaxMiB ?? 0;
  const kinds = KIND_ORDER.map(kind => ({ kind, bytes: stats?.normal.kinds[kind] ?? 0 })).filter(item => item.bytes > 0);
  const privateOn = Boolean(settings?.private && policy?.private_enabled);
  const total = (stats?.normal.count ?? 0) + (stats?.private.count ?? 0) + (stats?.others.count ?? 0);
  const totalBytes = (stats?.normal.bytes ?? 0) + (stats?.private.bytes ?? 0) + (stats?.others.bytes ?? 0);

  return <>
    <Section icon="monitor" title="本机缓存" description="看过的文件加密保存在这个浏览器里，再次打开更快，只有登录你的账号才能打开。">
      {error && <Notice tone="danger">{error}</Notice>}
      {adminOff ? <Notice>管理员已关闭浏览器本地缓存，这台设备上的普通文件缓存已清除。</Notice>
        : settings && <Switch checked={settings.enabled} disabled={busy} onChange={value => void update({ enabled: value }, value ? "已开启本机缓存" : "已关闭本机缓存并清除数据")}
          label="在这台设备上缓存文件" description="自动保存预览过的内容，包括图片、音视频、Markdown、文本、代码、PDF 和缩略图；任意文件都可以通过「缓存到本机」完整保存。文件列表用「本机」标记手动缓存、「自动」标记自动缓存。" />}
      {stats && <div className="local-cache-figures folder-stats-figures">
        <div><span>普通文件</span><strong>{formatBytes(stats.normal.bytes)}</strong><small>上限 {sizeLabel(effectiveMiB(normalLimit, estimate?.quota))} · {stats.normal.count.toLocaleString("zh-CN")} 项</small></div>
        <div><span>私密文件</span><strong>{formatBytes(stats.private.bytes)}</strong><small>{privateOn ? `上限 ${sizeLabel(effectiveMiB(privateLimit, estimate?.quota))} · ${stats.private.count} 项` : "未开启"}</small></div>
        <div><span>浏览器占用</span><strong>{estimate ? formatBytes(estimate.usage) : "—"}</strong><small>{estimate ? `${estimate.persisted ? "已持久保存" : "空间不足时可能被浏览器清除"}` : "浏览器未提供"}</small></div>
      </div>}
      {kinds.length > 0 && <div className="local-cache-kinds">
        <div className="folder-stats-bar" role="img" aria-label={kinds.map(item => `${KIND_LABEL[item.kind]} ${formatBytes(item.bytes)}`).join("，")}>
          {kinds.map(item => <span key={item.kind} className={`kind-${item.kind}`} style={{ flexGrow: item.bytes }} title={`${KIND_LABEL[item.kind]} ${formatBytes(item.bytes)}`} />)}
        </div>
        <ul className="local-cache-legend">{kinds.map(item => <li key={item.kind}><i className={`folder-stats-swatch kind-${item.kind}`} aria-hidden="true" />{KIND_LABEL[item.kind]} {formatBytes(item.bytes)}</li>)}</ul>
      </div>}
      {settings && !adminOff && settings.enabled && <div className="local-cache-options">
      <CacheSizeSelect label="最多占用" value={settings.maxMiB} disabled={busy || !settings.enabled} quota={estimate?.quota}
        hint="超出后先移除最久没有打开的自动缓存，手动缓存的文件会保留；自动缓存的单个文件最多占一半。" onChange={value => void update({ maxMiB: value }, "已保存")} />
      <Switch checked={settings.video} disabled={busy || !settings.enabled} onChange={value => void update({ video: value }, "已保存")} label="自动缓存视频片段"
        description={webkitOnly(navigator.userAgent) ? "Safari 对缓存视频的支持还不稳定，如果开启后播放异常，请关闭此项。" : "按看过的片段保存，拖回已看过的位置时不必重新下载。"} />
      </div>}
      {settings && webkitOnly(navigator.userAgent) && !isStandalone() && <Notice>
        Safari 会清除 7 天内没有访问过的网站数据。把 Tessera 添加到主屏幕后打开，缓存可以保留得更久。</Notice>}
    </Section>


    {settings && policy?.private_enabled && <Section icon="shield" title="私密文件" description="私密空间锁定后，已加入的缓存任务继续，副本仍需解锁才能打开；文件被移出私密空间后也不再使用。">
      <div className="account-setting-summary"><div>
        <strong>{settings.private ? "这台设备会缓存私密文件" : "不缓存私密文件"}</strong>
        <p>只在你信任的个人设备上开启。超过 {policy.private_ttl_days} 天没有打开的私密文件会被自动清除。</p>
      </div><Badge tone={settings.private ? "success" : "neutral"}>{settings.private ? "已开启" : "未开启"}</Badge></div>
      <div className="account-private-actions">
        {settings.private
          ? <Button size="sm" disabled={busy} onClick={() => void update({ private: false }, "已关闭并清除私密缓存")}>关闭并清除</Button>
          : <Button size="sm" icon="shield" disabled={busy || !settings.enabled} onClick={() => setConfirm("private")}>信任这台设备</Button>}
      </div>
      {settings.private && <CacheSizeSelect label="私密文件最多占用" value={settings.privateMaxMiB} disabled={busy} quota={estimate?.quota}
        onChange={value => void update({ privateMaxMiB: value }, "已保存")} />}
    </Section>}

    <Section icon="trash" title="清理" description="清理只删除这台设备上的副本，云端文件不受影响。">
      <div className="account-private-actions">
        <Button size="sm" disabled={busy || !total} onClick={() => setConfirm("all")}>全部清理{total ? `（${formatBytes(totalBytes)}）` : ""}</Button>
        <Button size="sm" disabled={busy || !stats?.normal.count} onClick={() => void wipe("normal", "已清理普通缓存")}>清理普通缓存</Button>
        <Button size="sm" disabled={busy || !stats?.private.count} onClick={() => void wipe("private", "已清理私密缓存")}>清理私密缓存</Button>
      </div>
      {(stats?.others.count ?? 0) > 0 && <p className="muted local-cache-note">这台设备上还有其他账号留下的缓存（{formatBytes(stats!.others.bytes)}），「全部清理」会一并清除。</p>}
      <Disclosure title="重置所有设备的缓存" description="设备丢失时使用：让你在所有设备上的本机缓存都无法再解开。">
        <div className="account-setting-summary local-cache-reset"><div>
          <p>之后在任何设备上打开文件都需要重新下载。修改登录密码也会有同样效果。</p>
        </div><Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirm("reset")}>重置</Button></div>
      </Disclosure>
    </Section>

    {confirm === "private" && <ConfirmDialog danger={false} title="信任这台设备？" confirmLabel="开启"
      description="打开过的私密文件会加密保存在这个浏览器里。私密空间锁定后无法解开，但请不要在公用或他人的设备上开启。"
      onClose={() => setConfirm(null)} onConfirm={async () => { await update({ private: true }, "已开启私密文件缓存"); setConfirm(null); }} />}
    {confirm === "all" && <ConfirmDialog title="全部清理？" confirmLabel="全部清理"
      description="将清除这台设备上的全部本机缓存，包括普通文件、私密文件、缩略图和其他账号留下的缓存。之后打开文件需要重新下载，云端文件不受影响。"
      onClose={() => setConfirm(null)} onConfirm={async () => { await wipe("all", "已清理这台设备上的全部缓存"); setConfirm(null); }} />}
    {confirm === "reset" && <ConfirmDialog title="重置所有设备的缓存？" confirmLabel="重置"
      description="所有设备上已有的本机缓存都将失效，之后打开文件需要重新下载。这台设备上的缓存会立即清除。"
      onClose={() => setConfirm(null)} onConfirm={async () => {
        try { await resetAllDevices(); toast.success("已重置，其他设备的缓存会在下次使用时清除"); setConfirm(null); await refresh(); }
        catch (reason) { toast.error(api.errorMessage(reason, "重置失败，请稍后重试")); }
      }} />}
  </>;
}

function Section({ icon, title, description, children }: { icon: "monitor" | "settings" | "shield" | "trash"; title: string; description: string; children: ReactNode }) {
  const id = useId();
  return <section className="account-section" aria-labelledby={`${id}-title`}>
    <header className="account-section-heading"><Icon name={icon} size={20} /><div><h2 id={`${id}-title`}>{title}</h2><p>{description}</p></div></header>
    <div className="account-section-content local-cache-section">{children}</div>
  </section>;
}

/** 容量由用户按设备决定，但不能超过浏览器配额：下拉框只列出配额以内的选项；
 * 已保存的值超出配额（换了设备环境、硬盘变满）时仍显示并标注，实际按配额生效。 */
function CacheSizeSelect({ label, value, hint, quota, disabled, onChange }: { label: string; value: number; hint?: string; quota?: number; disabled?: boolean; onChange: (value: number) => void }) {
  const id = useId();
  const fit = sizeChoices(quota);
  const over = Boolean(quota && value * 1048576 > quota);
  const choices = fit.includes(value) ? fit : [...fit, value].sort((a, b) => a - b);
  const note = quota ? over ? `当前设置超出这个浏览器的可用空间（约 ${formatBytes(quota)}），实际按 ${sizeLabel(effectiveMiB(value, quota))} 生效，建议改小。` : `这个浏览器最多可用约 ${formatBytes(quota)}。` : "";
  return <Field label={label} htmlFor={id} hint={[hint, note].filter(Boolean).join("")}>
    <select id={id} className="input local-cache-select" value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>
      {choices.map(choice => <option key={choice} value={choice}>{sizeLabel(choice)}{quota && choice * 1048576 > quota ? "（超出浏览器可用空间）" : ""}</option>)}
    </select>
  </Field>;
}
