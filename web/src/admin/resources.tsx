import { useEffect, useState, type FormEvent } from "react";
import * as api from "../api";
import { Button, Field, Icon, KeyValue, Panel, SkeletonRows, Switch, formatBytes, toast } from "../ui";

const MODES = { auto: "自动", low: "低资源", standard: "标准", custom: "自定义" };

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
      toast.success("下载与资源配置已保存");
    } catch (reason) { setError(api.errorMessage(reason, "资源配置保存失败")); }
    finally { setBusy(false); }
  }
  const dirty = settings && JSON.stringify(form) !== JSON.stringify(settings.config);
  return <Panel title="下载与资源" description="自动选择保守的资源预设，也可以固定模式；手动配置在重启后保留。">
    {!settings || !form ? error ? <div className="form"><p className="form-alert" role="alert">{error}</p><Button onClick={load}>重试</Button></div> : <SkeletonRows rows={3} /> : <div className="resource-layout">
      <form className="form" onSubmit={submit}>
        <Field label="资源模式" hint="自动模式按启动时检测到的 CPU 和内存选档。容器预算不足时，实际并发会降低。">
          <select className="input" value={form.mode} onChange={event => setForm({ ...form, mode: event.target.value as api.ResourceConfig["mode"] })}>{Object.entries(MODES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        </Field>
        {form.mode === "custom" && <Field label="同时下载的任务数" hint="1–4 个；视频封装始终最多 1 个。"><input className="input" type="number" min={1} max={4} step={1} required value={form.concurrency} onChange={event => setForm({ ...form, concurrency: Number(event.target.value) })} /></Field>}
        <div className="form-row">
          <Field label="总下载限速（KiB/s）" hint="0 表示不限速。"><input className="input" type="number" min={0} max={1048576} step={1} required value={form.bandwidth_kib} onChange={event => setForm({ ...form, bandwidth_kib: Number(event.target.value) })} /></Field>
          <Field label="磁盘保留空间（MiB）" hint="至少 128；不足时等待释放空间。"><input className="input" type="number" min={128} max={1048576} step={1} required value={form.reserve_mib} onChange={event => setForm({ ...form, reserve_mib: Number(event.target.value) })} /></Field>
        </div>
        <div className="form-row">
          <Field label="服务器同时读取数" hint="下载、预览、播放与 S3 读取共用，1–16。每路约占 24 MB 内存。">
            <input className="input" type="number" min={1} max={16} step={1} required value={form.transfer_concurrency}
              onChange={event => { const value = Number(event.target.value); setForm({ ...form, transfer_concurrency: value, bucket_concurrency: Math.min(form.bucket_concurrency, Math.max(1, value)) }); }} />
          </Field>
          <Field label="每个账号同时读取数" hint="单个账号最多占用的读取数，不超过服务器总数。">
            <input className="input" type="number" min={1} max={form.transfer_concurrency || 1} step={1} required value={form.bucket_concurrency} onChange={event => setForm({ ...form, bucket_concurrency: Number(event.target.value) })} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="同时写入存储的分片数" hint="所有上传共用，1–16。每个分片 16 MB，约占 32 MB 内存。">
            <input className="input" type="number" min={1} max={16} step={1} required value={form.upload_concurrency} onChange={event => setForm({ ...form, upload_concurrency: Number(event.target.value) })} />
          </Field>
          <Field label="上传限速（KiB/s）" hint="写入存储的平均速率，所有上传共用；0 表示不限速。">
            <input className="input" type="number" min={0} max={1048576} step={1} required value={form.upload_kib} onChange={event => setForm({ ...form, upload_kib: Number(event.target.value) })} />
          </Field>
        </div>
        <Field label="每个 Bot 的发送间隔（毫秒）" hint="同一个 Bot 两次发送之间至少相隔的时间，0–10000。多个 Bot 轮流发送，间隔各自计算；过短容易被 Telegram 限流，限流后会自动退避。">
          <input className="input" type="number" min={0} max={10000} step={100} required value={form.bot_interval_ms} onChange={event => setForm({ ...form, bot_interval_ms: Number(event.target.value) })} />
        </Field>
        <div className="form-row">
          <Field label="网页单个文件的分段并发" hint="大于 64 MB 的文件分段上传时同时发送的分段数，1–8。">
            <input className="input" type="number" min={1} max={8} step={1} required value={form.web_part_concurrency} onChange={event => setForm({ ...form, web_part_concurrency: Number(event.target.value) })} />
          </Field>
          <Field label="网页同时上传的文件数" hint="1–4；网页在开始上传时读取，最长 1 分钟后生效。">
            <input className="input" type="number" min={1} max={4} step={1} required value={form.web_file_concurrency} onChange={event => setForm({ ...form, web_file_concurrency: Number(event.target.value) })} />
          </Field>
        </div>
        <Field label="出站代理" hint="所有离线下载和平台解析都经此代理，域名由代理解析；留空为直连。支持 http:// 与 socks5://，密码保存后以 ****** 显示。">
          <input className="input mono" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="http://127.0.0.1:7890" value={form.proxy} onChange={event => setForm({ ...form, proxy: event.target.value })} />
        </Field>
        {form.proxy.trim() && <p className="inline-note tone-warning"><Icon name="alert" size={16} />启用代理后无法在本机核对域名解析结果，只能拦截内网 IP 与内部主机名；请确认代理不会把请求转发到内网服务。</p>}
        <div className="resource-hls"><Switch checked={form.hls_enabled} onChange={enabled => setForm({ ...form, hls_enabled: enabled })} label="允许下载 M3U8 视频" description="仅支持已结束、未加密的连续 TS 点播视频，保存为 MP4。" /></div>
        <div className="resource-hls"><Switch checked={form.x_enabled} onChange={enabled => setForm({ ...form, x_enabled: enabled })} label="允许下载 X 帖子媒体" description="解析单条帖子中的图片与视频，按文件勾选下载。" /></div>
        <div className="resource-hls"><Switch checked={form.youtube_enabled} onChange={enabled => setForm({ ...form, youtube_enabled: enabled })} label="允许下载 YouTube 视频" description="支持单个视频和 Shorts，选择可用 MP4 清晰度；合并时不转码。" /></div>
        {(form.x_enabled || form.youtube_enabled) && <Field label="平台临时缓存上限（MiB）" hint="仅限制需要缓存并合并的音视频轨；单轨媒体直接流式保存，仍受用户空间配额限制。低资源预算最高 512 MiB。"><input className="input" type="number" min={16} max={8192} step={1} required value={form.platform_max_mib} onChange={event => setForm({ ...form, platform_max_mib: Number(event.target.value) })} /></Field>}
        {form.youtube_enabled && <Field label="YouTube 清晰度上限" hint="默认上限为 2160p；低资源模式不会自动下调。仅显示来源实际提供且满足临时缓存预算的格式。"><select className="input" value={form.youtube_max_height} onChange={event => setForm({ ...form, youtube_max_height: Number(event.target.value) })}>{[360, 480, 720, 1080, 2160].map(height => <option key={height} value={height}>{height}p</option>)}</select></Field>}
        {(!settings.effective.x_available || !settings.effective.youtube_available) && <p className="inline-note tone-warning"><Icon name="alert" size={16} />平台功能需要使用带解析组件的镜像；YouTube 还需要 JavaScript 运行时和 FFmpeg，安装后重启生效。</p>}
        {!settings.effective.hls_available && <p className="inline-note tone-warning"><Icon name="alert" size={16} />未检测到 FFmpeg。使用带 FFmpeg 的镜像后重启服务才能下载 M3U8。</p>}
        {error && <div className="form-alert" role="alert">{error}</div>}
        {(dirty || busy) && <div className="settings-actions"><span className="settings-actions-note">有未保存的修改</span><Button variant="ghost" disabled={busy} onClick={() => setForm(settings.config)}>放弃修改</Button><Button type="submit" variant="primary" loading={busy}>保存资源配置</Button></div>}
      </form>
      <div className="resource-effective"><h3>当前生效配置</h3><KeyValue items={[
        ["配置来源", settings.source === "admin" ? "管理员配置" : "启动默认值"],
        ["资源模式", MODES[settings.effective.mode]],
        ["离线下载并发", `${settings.effective.concurrency} 个任务`],
        ["视频封装并发", "1 个任务"],
        ["文件读取并发", `服务器 ${settings.effective.transfer_concurrency} 路 · 每个账号 ${settings.effective.bucket_concurrency} 路`],
        ["写入存储", `${settings.effective.upload_concurrency} 个分片 · ${settings.effective.upload_kib ? `${settings.effective.upload_kib.toLocaleString("zh-CN")} KiB/s` : "不限速"}`],
        ["Bot 发送间隔", `${settings.effective.bot_interval_ms} 毫秒`],
        ["网页上传", `每个文件 ${settings.effective.web_part_concurrency} 段 · 同时 ${settings.effective.web_file_concurrency} 个文件`],
        ["检测到的 CPU", `${settings.detected.cpu_cores.toFixed(2)} 核`],
        ["检测到的内存", settings.detected.memory_bytes ? formatBytes(settings.detected.memory_bytes) : "无法可靠检测，采用保守预算"],
        ["磁盘剩余空间", settings.detected.disk_free_bytes !== null ? formatBytes(settings.detected.disk_free_bytes) : "未知"],
        ["YouTube 生效上限", `${settings.effective.youtube_max_height}p · ${settings.effective.platform_max_mib} MiB`],
        ["出站代理", settings.effective.proxy || "直连"],
        ["视频处理", "M3U8 流式封装；分离音视频轨使用受限缓存"],
        ["FFmpeg", settings.effective.hls_available ? "可用" : "未安装"],
        ["X 解析组件", settings.effective.x_available ? "可用" : "未安装"],
        ["YouTube 解析组件", settings.effective.youtube_available ? "可用" : "组件不完整"],
        ...Object.entries(settings.components.versions).map(([name, version]) => [`${name} 版本`, version ?? "未安装"] as [string, string]),
      ]} />{settings.components.ytdlp_age_days !== null && settings.components.ytdlp_age_days > 60 && <p className="tone-warning">yt-dlp 已发布 {settings.components.ytdlp_age_days} 天。YouTube 经常调整接口，解析失败时请拉取最新的平台镜像。</p>}{settings.effective.reduced && <p className="tone-warning">当前资源预算不足，并发已降低。</p>}{settings.effective.upload_reduced && <p className="tone-warning">上传并发已按{settings.effective.mode === "low" ? "低资源模式（写入最多 2 个分片、网页每个文件最多 2 段）" : "检测到的内存"}降低。</p>}{settings.effective.transfer_reduced && <p className="tone-warning">文件读取并发已按{settings.effective.mode === "low" ? "低资源模式（最多 2 路、每个账号 1 路）" : "检测到的内存"}降低。</p>}{settings.pressure && <p className="tone-warning">{settings.pressure}</p>}<p className="muted">降低并发不会终止现有任务或传输，后续调度使用新配置。名额占满时新的读取最多排队 30 秒；缩略图大图使用独立通道，不占这里的名额。</p></div>
    </div>}
  </Panel>;
}
