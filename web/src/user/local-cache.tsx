import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

import * as api from "../api";
import { type CacheStats, type CachedItem, type CachedItemFilter, cacheStats, cacheSupported, cachedItems, clearCache, isStandalone, loadSettings, removeCachedItems, resetAllDevices, saveSettings, storageEstimate } from "../cache-client";
import { type DeviceSettings, type Kind, SIZE_CHOICES, webkitOnly } from "../cache-store";
import { Notice, Badge, Button, ConfirmDialog, Disclosure, EmptyState, Field, FilterChips, Icon, SearchInput, Switch, formatBytes, formatDate, toast } from "../ui";

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
  const [revision, setRevision] = useState(0);
  const supported = cacheSupported();

  const refresh = useCallback(async () => {
    try {
      const [value, current, storage] = await Promise.all([cacheStats(), loadSettings(), storageEstimate()]);
      setStats(value); setSettings(current); setEstimate(storage); setError(""); setRevision(value => value + 1);
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

  async function wipe(scope: "normal" | "private" | "others", message: string) {
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

  return <>
    <Section icon="monitor" title="本机缓存" description="看过的文件加密保存在这个浏览器里，再次打开更快，只有登录你的账号才能打开。">
      {error && <Notice tone="danger">{error}</Notice>}
      {adminOff ? <Notice>管理员已关闭浏览器本地缓存，这台设备上的普通文件缓存已清除。</Notice>
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
      {settings && !adminOff && settings.enabled && <div className="local-cache-options">
      <CacheSizeSelect label="最多占用" value={settings.maxMiB} disabled={busy || !settings.enabled} quota={estimate?.quota}
        hint="超出后自动移除最久没有打开的文件；自动缓存的单个文件最多占一半。" onChange={value => void update({ maxMiB: value }, "已保存")} />
      <Switch checked={settings.video} disabled={busy || !settings.enabled} onChange={value => void update({ video: value }, "已保存")} label="自动缓存视频片段"
        description={webkitOnly(navigator.userAgent) ? "Safari 对缓存视频的支持还不稳定，如果开启后播放异常，请关闭此项。" : "按看过的片段保存，拖回已看过的位置时不必重新下载。"} />
      </div>}
      {settings && webkitOnly(navigator.userAgent) && !isStandalone() && <Notice>
        Safari 会清除 7 天内没有访问过的网站数据。把 Tessera 添加到主屏幕后打开，缓存可以保留得更久。</Notice>}
    </Section>


    {settings && policy?.private_enabled && <Section icon="shield" title="私密文件" description="私密空间锁定后，这些副本无法打开；文件被移出私密空间后也不再使用。">
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

    {stats && stats.normal.count > 0 && <CachedFiles revision={revision} onChanged={() => void refresh()} />}

    <Section icon="trash" title="清理" description="清除只影响这台设备，文件本身不受影响。">
      <div className="account-private-actions">
        <Button size="sm" disabled={busy || !stats?.normal.count} onClick={() => void wipe("normal", "已清除普通文件缓存")}>清除普通文件缓存</Button>
        {(stats?.private.count ?? 0) > 0 && <Button size="sm" disabled={busy} onClick={() => void wipe("private", "已清除私密文件缓存")}>清除私密文件缓存</Button>}
        {(stats?.others.count ?? 0) > 0 && <Button size="sm" disabled={busy} onClick={() => void wipe("others", "已清除其他账号的缓存")}>清除其他账号的缓存（{formatBytes(stats!.others.bytes)}）</Button>}
      </div>
      <Disclosure title="重置所有设备的缓存" description="设备丢失时使用：让你在所有设备上的本机缓存都无法再解开。">
        <div className="account-setting-summary local-cache-reset"><div>
          <p>之后在任何设备上打开文件都需要重新下载。修改登录密码也会有同样效果。</p>
        </div><Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirm("reset")}>重置</Button></div>
      </Disclosure>
    </Section>

    {confirm === "private" && <ConfirmDialog danger={false} title="信任这台设备？" confirmLabel="开启"
      description="打开过的私密文件会加密保存在这个浏览器里。私密空间锁定后无法解开，但请不要在公用或他人的设备上开启。"
      onClose={() => setConfirm(null)} onConfirm={async () => { await update({ private: true }, "已开启私密文件缓存"); setConfirm(null); }} />}
    {confirm === "reset" && <ConfirmDialog title="重置所有设备的缓存？" confirmLabel="重置"
      description="所有设备上已有的本机缓存都将失效，之后打开文件需要重新下载。这台设备上的缓存会立即清除。"
      onClose={() => setConfirm(null)} onConfirm={async () => {
        try { await resetAllDevices(); toast.success("已重置，其他设备的缓存会在下次使用时清除"); setConfirm(null); await refresh(); }
        catch (reason) { toast.error(api.errorMessage(reason, "重置失败，请稍后重试")); }
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

/** 容量由用户按设备决定；浏览器配额是硬上限，超过配额的选项仍可选，但会在说明里提示。 */
function CacheSizeSelect({ label, value, hint, quota, disabled, onChange }: { label: string; value: number; hint?: string; quota?: number; disabled?: boolean; onChange: (value: number) => void }) {
  const id = useId();
  const choices = SIZE_CHOICES.includes(value) ? SIZE_CHOICES : [...SIZE_CHOICES, value].sort((a, b) => a - b);
  const over = Boolean(quota && value * 1048576 > quota);
  return <Field label={label} htmlFor={id} hint={[hint, quota ? `这个浏览器最多可用约 ${formatBytes(quota)}${over ? "，实际以浏览器为准" : ""}。` : ""].filter(Boolean).join("")}>
    <select id={id} className="input local-cache-select" value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>
      {choices.map(choice => <option key={choice} value={choice}>{sizeLabel(choice)}</option>)}
    </select>
  </Field>;
}

const PAGE = 50;
const KIND_FILTERS: { value: Kind | ""; label: string }[] = [{ value: "", label: "全部" }, { value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" }, { value: "other", label: "其他" }];
const STATUS_FILTERS: { value: "" | "complete" | "partial"; label: string }[] = [{ value: "", label: "全部状态" }, { value: "complete", label: "完整" }, { value: "partial", label: "部分" }];
const folderOf = (path: string) => { const parts = path.replace(/\/$/, "").split("/"); parts.pop(); return parts.join("/"); };
const ITEM_ICON: Record<Kind, "image" | "video" | "audio" | "file"> = { image: "image", video: "video", audio: "audio", thumb: "image", other: "file" };

/** 已缓存的文件：Worker 内搜索、筛选、排序与分页，页面只挂载已加载的几页（每页 50 项）。 */
function CachedFiles({ revision, onChanged }: { revision: number; onChanged: () => void }) {
  const [query, setQuery] = useState(""), [search, setSearch] = useState("");
  const [kind, setKind] = useState<Kind | "">(""), [status, setStatus] = useState<"" | "complete" | "partial">("");
  const [sort, setSort] = useState<"recent" | "size" | "name">("recent");
  const [page, setPage] = useState<{ total: number; bytes: number; items: CachedItem[] } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [confirmBulk, setConfirmBulk] = useState(false);
  const request = useRef(0);
  useEffect(() => { const timer = window.setTimeout(() => setSearch(query), 250); return () => window.clearTimeout(timer); }, [query]);
  const filter: CachedItemFilter = { query: search, kind, status, sort };
  const filtered = Boolean(search.trim() || kind || status);
  const load = useCallback(async (offset: number) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const value = await cachedItems({ query: search, kind, status, sort, offset, limit: PAGE });
      if (id !== request.current) return;
      setPage(current => offset && current ? { ...value, items: [...current.items, ...value.items] } : value);
      setError("");
    } catch (reason) { if (id === request.current) setError(api.errorMessage(reason, "已缓存的文件读取失败，请稍后重试")); }
    finally { if (id === request.current) setLoading(false); }
  }, [search, kind, status, sort]);
  useEffect(() => { void load(0); }, [load, revision]);

  async function remove(item: CachedItem) {
    try {
      await clearCache("entry", item.key);
      setPage(current => current && { total: current.total - 1, bytes: current.bytes - item.bytes, items: current.items.filter(entry => entry.key !== item.key) });
      onChanged();
    } catch (reason) { toast.error(api.errorMessage(reason, "移除失败，请稍后重试")); }
  }

  const rest = page ? page.total - page.items.length : 0;
  return <Section icon="list" title="已缓存的文件" description="移除只删除这台设备上的副本，不影响文件本身。缩略图不在此列出。">
    <div className="local-cache-toolbar">
      <SearchInput value={query} onChange={setQuery} placeholder="搜索文件名或路径" label="搜索已缓存的文件" />
      <select className="input local-cache-sort" aria-label="排序" value={sort} onChange={event => setSort(event.target.value as typeof sort)}>
        <option value="recent">最近打开</option><option value="size">占用最大</option><option value="name">按名称</option>
      </select>
    </div>
    <div className="local-cache-filters">
      <FilterChips label="按类型筛选" value={kind} onChange={setKind} options={KIND_FILTERS} />
      <FilterChips label="按缓存状态筛选" value={status} onChange={setStatus} options={STATUS_FILTERS} />
    </div>
    {error && <Notice tone="danger">{error}</Notice>}
    {page && <p className="local-cache-count muted" aria-live="polite">{filtered ? `找到 ${page.total.toLocaleString("zh-CN")} 个文件，共 ${formatBytes(page.bytes)}` : `共 ${page.total.toLocaleString("zh-CN")} 个文件，${formatBytes(page.bytes)}`}</p>}
    {page && page.items.length === 0 ? <p className="local-cache-empty muted">{filtered ? "没有符合条件的文件。" : "还没有缓存的文件。"}</p>
      : page && <ul className={`account-attachments local-cache-items${loading ? " is-loading" : ""}`} aria-label="已缓存的文件" aria-busy={loading}>
        {page.items.map(item => {
          const folder = folderOf(item.path), percent = item.size ? Math.min(99, Math.floor(item.bytes / item.size * 100)) : 0;
          return <li key={item.key}>
            <Icon name={ITEM_ICON[item.kind]} size={15} />
            <span className="account-attachments-title"><strong title={item.path}>{baseName(item.path)}</strong>
              <small>{folder && <span className="local-cache-folder" title={api.privatePathLabel(folder + "/")}>{api.privatePathLabel(folder + "/")}</span>}
                <span>{item.complete ? `完整 · ${formatBytes(item.size)}` : `已缓存 ${percent}% · ${formatBytes(item.bytes)} / ${formatBytes(item.size)}`}</span>
                <span>{formatDate(item.accessed / 1000)}打开</span></small></span>
            {item.manual && <Badge>手动</Badge>}
            <Button size="sm" variant="ghost" onClick={() => void remove(item)}>移除</Button>
          </li>;
        })}
      </ul>}
    {page && (rest > 0 || filtered && page.total > 0) && <div className="local-cache-more">
      {rest > 0 && <Button size="sm" loading={loading} onClick={() => void load(page.items.length)}>显示更多（还有 {rest.toLocaleString("zh-CN")} 个）</Button>}
      {filtered && page.total > 0 && <Button size="sm" variant="ghost" onClick={() => setConfirmBulk(true)}>移除这 {page.total.toLocaleString("zh-CN")} 个文件</Button>}
    </div>}
    {confirmBulk && page && <ConfirmDialog title="移除筛选出的缓存？" confirmLabel="移除" description={`将移除 ${page.total.toLocaleString("zh-CN")} 个文件在这台设备上的缓存（${formatBytes(page.bytes)}），文件本身不受影响。`}
      onClose={() => setConfirmBulk(false)} onConfirm={async () => {
        try { const removed = await removeCachedItems(filter); toast.success(`已移除 ${removed.toLocaleString("zh-CN")} 个文件的缓存`); setConfirmBulk(false); onChanged(); }
        catch (reason) { toast.error(api.errorMessage(reason, "移除失败，请稍后重试")); }
      }} />}
  </Section>;
}
