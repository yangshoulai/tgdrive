import { useEffect, useState, type FormEvent } from "react";
import * as api from "../api";
import { Button, Disclosure, Field, KeyValue, Notice, Panel, SkeletonRows, Switch, formatBytes, toast, useUnsavedChanges } from "../ui";

/** 可选的资源模式。「标准」已并入「自动」：硬件足够时自动就是标准档。 */
const MODES: Record<api.ResourceConfig["mode"], string> = { auto: "自动", low: "低资源", custom: "自定义" };
/** 生效档位的名称。 */
const TIERS: Record<api.ResourceSettings["effective"]["mode"], string> = { low: "低资源", standard: "标准", custom: "自定义" };
const MODE_HINTS: Record<api.ResourceConfig["mode"], string> = {
  auto: "按检测到的 CPU 和内存在「标准」与「低资源」之间选择，适合大多数部署。",
  low: "内存达到 512 MiB 时：离线下载 2 个任务，读取最多 8 路（每个账号可以全部使用），写入与网页分段最多 8 路，并按内存的三分之一收紧。更小或无法检测内存时最多 3 路、离线下载 1 个任务。",
  custom: "自己决定同时下载的任务数（1–16）；按每个任务约 64 MB、最多占「离线下载可用内存」封顶（只看内存，不看 CPU 核数）；内存不足 1 GiB 的机器最多 1–4 个。",
};
const rate = (kib: number) => kib ? `${kib.toLocaleString("zh-CN")} KiB/s` : "不限速";

export function Resources() {
  const [settings, setSettings] = useState<api.ResourceSettings | null>(null);
  const [form, setForm] = useState<api.ResourceConfig | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => { void api.adminResources().then(value => { setSettings(value); setForm(value.config); setError(""); }).catch(reason => setError(api.errorMessage(reason, "资源配置加载失败"))); };
  useEffect(load, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true); setError("");
    try {
      const value = await api.updateAdminResources(form);
      setSettings(value); setForm(value.config);
      toast.success("下载与资源配置已保存，立即生效");
    } catch (reason) { setError(api.errorMessage(reason, "资源配置保存失败")); }
    finally { setBusy(false); }
  }
  const dirty = Boolean(settings && form) && JSON.stringify(form) !== JSON.stringify(settings!.config);
  useUnsavedChanges(dirty);
  if (!settings || !form) return <Panel title="下载与资源">{error ? <div className="form"><Notice tone="danger">{error}</Notice><Button onClick={load}>重试</Button></div> : <SkeletonRows rows={3} />}</Panel>;
  const set = <K extends keyof api.ResourceConfig>(key: K, value: api.ResourceConfig[K]) => setForm({ ...form, [key]: value });
  const number = (key: keyof api.ResourceConfig) => (event: { target: { value: string } }) => set(key, Number(event.target.value) as never);
  const effective = settings.effective;
  const component = (ok: boolean) => ok ? "可用" : "未安装";
  return <div className="stack">
    <Panel title="离线下载" description="用户提交的下载任务在服务器上运行，保存到各自的空间。">
      <form id="resource-form" className="form" onSubmit={submit}>
        <Field label="资源模式" hint={MODE_HINTS[form.mode]}>
          <select className="input" value={form.mode} onChange={event => set("mode", event.target.value as api.ResourceConfig["mode"])}>{Object.entries(MODES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        </Field>
        {form.mode === "custom" && <Field label="同时下载的任务数" hint="1–16 个，按内存封顶（每个任务约 64 MB，总共不超过「离线下载可用内存」）；其中 M3U8／YouTube 视频按「同时封装的视频数」。"><input className="input" type="number" min={1} max={16} step={1} required value={form.concurrency} onChange={number("concurrency")} /></Field>}
        <Field label="下载限速（KiB/s）" hint="所有离线下载共用；0 表示不限速。"><input className="input" type="number" min={0} max={1048576} step={1} required value={form.bandwidth_kib} onChange={number("bandwidth_kib")} /></Field>
        <Field label="出站代理" hint="离线下载和平台解析都经此代理，留空为直连。支持 http:// 与 socks5://，密码保存后以 ****** 显示。">
          <input className="input mono" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="http://127.0.0.1:7890" value={form.proxy} onChange={event => set("proxy", event.target.value)} />
        </Field>
        {form.proxy.trim() && <Notice tone="warning">启用代理后无法在本机核对域名解析结果，只能拦截内网 IP 与内部主机名；请确认代理不会把请求转发到内网服务。</Notice>}
        <div className="switch-list">
          <Switch checked={form.hls_enabled} onChange={value => set("hls_enabled", value)} label="允许下载 M3U8 视频" description="已结束、未加密的连续 TS 点播视频，保存为 MP4。需要 FFmpeg。" />
          <Switch checked={form.x_enabled} onChange={value => set("x_enabled", value)} label="允许下载 X 帖子媒体" description="解析单条帖子中的图片与视频，按文件勾选下载。" />
          <Switch checked={form.youtube_enabled} onChange={value => set("youtube_enabled", value)} label="允许下载 YouTube 视频" description="单个视频和 Shorts，选择可用的 MP4 清晰度，合并时不转码。" />
        </div>
        {(form.x_enabled && !effective.x_available || form.youtube_enabled && !effective.youtube_available) && <Notice tone="warning">平台下载需要带解析组件的镜像；YouTube 还需要 JavaScript 运行时和 FFmpeg，安装后重启生效。</Notice>}
        {form.hls_enabled && !effective.hls_available && <Notice tone="warning">未检测到 FFmpeg。使用带 FFmpeg 的镜像并重启后才能下载 M3U8。</Notice>}
        <Disclosure title="高级参数" description="读写并发、上传限速、Bot 发送间隔、网页上传分段与平台缓存。默认值适合大多数部署。">
          <div className="form-row">
            <Field label="服务器同时读取数" hint="下载、预览、播放与 S3 读取共用，1–32。每路约占 24 MB 内存，最多占内存三分之一。">
              <input className="input" type="number" min={1} max={32} step={1} required value={form.transfer_concurrency}
                onChange={event => { const value = Number(event.target.value); setForm({ ...form, transfer_concurrency: value, bucket_concurrency: Math.min(form.bucket_concurrency, Math.max(1, value)) }); }} />
            </Field>
            <Field label="每个账号同时读取数" hint="单个账号最多占用的读取数，不超过服务器总数。本机缓存最多用其中「总数减一」路，留一路给播放与预览。">
              <input className="input" type="number" min={1} max={form.transfer_concurrency || 1} step={1} required value={form.bucket_concurrency} onChange={number("bucket_concurrency")} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="同时写入存储的分片数" hint="所有上传共用，1–32。每个分片 16 MB，约占 32 MB 内存，最多占内存三分之一。"><input className="input" type="number" min={1} max={32} step={1} required value={form.upload_concurrency} onChange={number("upload_concurrency")} /></Field>
            <Field label="上传限速（KiB/s）" hint="写入存储的平均速率，所有上传共用；0 表示不限速。"><input className="input" type="number" min={0} max={1048576} step={1} required value={form.upload_kib} onChange={number("upload_kib")} /></Field>
          </div>
          <div className="form-row">
            <Field label="网页单个文件的分段并发" hint="大于 64 MB 的文件分段上传时同时发送的分段数，1–16。"><input className="input" type="number" min={1} max={16} step={1} required value={form.web_part_concurrency} onChange={number("web_part_concurrency")} /></Field>
            <Field label="网页同时上传的文件数" hint="1–8；网页开始上传时读取，最长 1 分钟后生效。"><input className="input" type="number" min={1} max={8} step={1} required value={form.web_file_concurrency} onChange={number("web_file_concurrency")} /></Field>
          </div>
          <div className="form-row">
            <Field label="离线下载可用内存（%）" hint={`同时下载的任务总共最多占检测内存的比例，10–80，默认 60。每个任务按约 64 MB、每多一个连接再加 32 MB 估算${(settings.detected.memory_bytes ?? 0) >= 1024 ** 3 ? `，按当前设置这台服务器最多同时下载 ${Math.min(16, Math.max(1, Math.floor((settings.detected.memory_bytes ?? 0) * (form.download_memory_percent || 0) / 100 / ((64 + 32 * Math.max(0, (form.download_connections || 1) - 1)) * 1024 * 1024))))} 个` : ""}；内存不足 1 GiB 的机器固定为 1–4 个，CPU 核数不影响这个上限。`}>
              <input className="input" type="number" min={10} max={80} step={5} required value={form.download_memory_percent} onChange={number("download_memory_percent")} /></Field>
            <Field label="单个任务的连接数" hint="每个下载任务同时打开的连接数，1–8，默认 4。直链按 16 MB 分段同时下载，YouTube 的分段与 M3U8 的分片提前并行读取；来源按连接限速时能明显提速。来源不支持分段时自动改用 1 个连接。连接越多每个任务占的内存越多，能同时下载的任务数会相应减少；内存不足 1 GiB 的机器最多 2 个。">
              <input className="input" type="number" min={1} max={8} step={1} required value={form.download_connections} onChange={number("download_connections")} /></Field>
          </div>
          <div className="form-row">
            <Field label="同时封装的视频数" hint="M3U8 与 YouTube 视频同时处理的个数，1–4，默认 2。FFmpeg 只复制音视频数据、不转码，CPU 占用不高；每个 YouTube 任务另占最多「平台临时缓存上限」的磁盘。内存不足 1 GiB 的机器固定为 1 个，也不超过同时下载的任务数。">
              <input className="input" type="number" min={1} max={4} step={1} required value={form.video_concurrency} onChange={number("video_concurrency")} /></Field>
          </div>
          <div className="form-row">
            <Field label="封面读取并发" hint="网格图、预览大图等封面从存储读取的同时数，所有用户共用，1–32，默认 16。不占文件读取名额，每路不到 1 MB 内存；过高可能触发 Telegram 限流。"><input className="input" type="number" min={1} max={32} step={1} required value={form.thumbnail_concurrency} onChange={number("thumbnail_concurrency")} /></Field>
            <Field label="封面缓存上限（MiB）" hint={`上传、离线下载与预览时暂存刚经过的加密数据，后台生成封面时直接使用，不必再从存储读取原文件；128–8192，默认 1024。单个文件最多 ${Math.min(256, Math.floor((form.thumbnail_cache_mib || 0) / 4))} MiB（总量的四分之一、最多 256 MiB），保留 15 分钟。存放在数据目录的磁盘上，剩余空间低于「磁盘保留空间」时不再缓存。`}>
              <input className="input" type="number" min={128} max={8192} step={128} required value={form.thumbnail_cache_mib} onChange={number("thumbnail_cache_mib")} /></Field>
          </div>
          <div className="form-row">
            <Field label="每个 Bot 的发送间隔（毫秒）" hint="0–10000。过短容易被 Telegram 限流，限流后会自动退避。"><input className="input" type="number" min={0} max={10000} step={100} required value={form.bot_interval_ms} onChange={number("bot_interval_ms")} /></Field>
            <Field label="磁盘保留空间（MiB）" hint="至少 128；剩余空间不足时离线下载等待释放。"><input className="input" type="number" min={128} max={1048576} step={1} required value={form.reserve_mib} onChange={number("reserve_mib")} /></Field>
          </div>
          {(form.x_enabled || form.youtube_enabled) && <div className="form-row">
            <Field label="平台临时缓存上限（MiB）" hint="16–8192。分离的音视频轨合并前暂存在数据目录的磁盘上，两轨合计超过这个值的格式不能选择；单轨媒体边下载边保存，不受限制。合并时剩余磁盘低于「磁盘保留空间」会停止。"><input className="input" type="number" min={16} max={8192} step={1} required value={form.platform_max_mib} onChange={number("platform_max_mib")} /></Field>
            {form.youtube_enabled && <Field label="YouTube 清晰度上限" hint="只显示来源实际提供且满足临时缓存预算的格式。"><select className="input" value={form.youtube_max_height} onChange={number("youtube_max_height")}>{[360, 480, 720, 1080, 2160].map(height => <option key={height} value={height}>{height}p</option>)}</select></Field>}
          </div>}
        </Disclosure>
        {error && <Notice tone="danger">{error}</Notice>}
        {(dirty || busy) && <div className="settings-actions"><span className="settings-actions-note">有未保存的修改</span><Button variant="ghost" disabled={busy} onClick={() => setForm(settings.config)}>放弃修改</Button><Button type="submit" variant="primary" loading={busy}>保存</Button></div>}
      </form>
    </Panel>
    <Panel title="当前生效" description={settings.source === "admin" ? "按管理员保存的配置与检测到的资源计算。" : "尚未保存过配置，使用启动参数的默认值。"}>
      <KeyValue items={[
        ["资源档位", form.mode === "auto" ? `自动 · ${TIERS[effective.mode]}` : TIERS[effective.mode]],
        ["离线下载", `${effective.concurrency} 个任务 · 每个 ${effective.download_connections} 个连接 · ${rate(effective.bandwidth_kib)}`],
        ["文件读取", `服务器 ${effective.transfer_concurrency} 路 · 每个账号 ${effective.bucket_concurrency} 路`],
        ["写入存储", `${effective.upload_concurrency} 个分片 · ${rate(effective.upload_kib)}`],
        ["网页上传", `每个文件 ${effective.web_part_concurrency} 段 · 同时 ${effective.web_file_concurrency} 个文件`],
        ["封面读取", `${effective.thumbnail_concurrency} 路`],
        ["出站代理", effective.proxy || "直连"],
        ["视频组件", `FFmpeg ${component(effective.hls_available)} · X ${component(effective.x_available)} · YouTube ${effective.youtube_available ? "可用" : "组件不完整"}`],
      ]} />
      {effective.reduced && <Notice tone="warning">资源预算不足，离线下载并发已按检测到的内存降低为 {effective.concurrency} 个。</Notice>}
      {effective.upload_reduced && <Notice tone="warning">上传并发已按{effective.mode === "low" ? "低资源档与内存预算" : "检测到的内存"}降低为写入 {effective.upload_concurrency} 个分片、网页每个文件 {effective.web_part_concurrency} 段。</Notice>}
      {effective.transfer_reduced && <Notice tone="warning">文件读取并发已按{effective.mode === "low" ? "低资源档与内存预算" : "检测到的内存"}降低为服务器 {effective.transfer_concurrency} 路、每个账号 {effective.bucket_concurrency} 路。</Notice>}
      {settings.pressure && <Notice tone="warning">{settings.pressure}</Notice>}
      {settings.components.ytdlp_age_days !== null && settings.components.ytdlp_age_days > 60 && <Notice tone="warning">yt-dlp 已发布 {settings.components.ytdlp_age_days} 天。YouTube 经常调整接口，解析失败时请拉取最新的平台镜像。</Notice>}
      <Disclosure title="检测信息与组件版本" description="服务器资源、视频处理方式与各组件版本。">
        <KeyValue items={[
          ["检测到的 CPU", `${settings.detected.cpu_cores.toFixed(2)} 核`],
          ["检测到的内存", settings.detected.memory_bytes ? formatBytes(settings.detected.memory_bytes) : "无法可靠检测，采用保守预算"],
          ["磁盘剩余空间", settings.detected.disk_free_bytes !== null ? formatBytes(settings.detected.disk_free_bytes) : "未知"],
          ["视频处理", `M3U8 流式封装；分离的音视频轨暂存在磁盘（每个最多 ${effective.platform_max_mib} MiB）；同时封装 ${effective.ffmpeg_concurrency} 个视频`],
          ["YouTube 生效上限", `${effective.youtube_max_height}p · ${effective.platform_max_mib} MiB`],
          ...Object.entries(settings.components.versions).map(([name, version]) => [`${name} 版本`, version ?? "未安装"] as [string, string]),
        ]} />
        <p className="muted resource-footnote">降低并发不会终止现有任务或传输，后续调度使用新配置。读取名额占满时新的读取最多排队 30 秒；封面大图使用独立通道，不占这里的名额。</p>
      </Disclosure>
    </Panel>
  </div>;
}
