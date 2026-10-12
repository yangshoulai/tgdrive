import { useCallback, useEffect, useRef, useState } from "react";
import { BRAND } from "../brand";
import * as api from "../api";
import { useCursorPage } from "../pagination";
import { Badge, Button, Checkbox, ConfirmDialog, EmptyState, Field, Icon, Menu, Modal, PageHeader, Panel, Pagination, Progress, Segmented, SkeletonRows, formatBytes, toast, useDocumentTitle, type Tone } from "../ui";
import { DestinationPicker } from "./folders";

const LABEL: Record<api.DownloadStatus, string> = { queued: "排队中", running: "下载中", interrupted: "等待恢复", stopped: "已停止", completed: "已完成", failed: "失败" };
const TONE: Record<api.DownloadStatus, Tone> = { queued: "neutral", running: "accent", interrupted: "warning", stopped: "neutral", completed: "success", failed: "danger" };
export const isActiveDownload = (task: api.DownloadTask) => ["queued", "running", "interrupted"].includes(task.status);
const active = isActiveDownload;
export const downloadGlyph = (task: api.DownloadTask) => /\.(m4a|mp3|aac|flac|ogg|opus|wav)$/i.test(task.key) ? "audio" as const
  : task.kind === "hls" || /\.(mp4|m4v|mov|webm|mkv)$/i.test(task.key) ? "video" as const
    : /\.(jpe?g|png|webp|gif)$/i.test(task.key) ? "image" as const : "file" as const;
const glyph = downloadGlyph;
/** 进度百分比；总大小未知时返回 null，不显示虚构进度。 */
export const downloadPercent = (task: api.DownloadTask) => task.status === "completed" ? 100 : task.kind === "hls" && task.duration ? Math.min(95, task.processed_seconds / task.duration * 95) : task.size ? Math.min(99, task.received / task.size * 100) : null;
export const downloadStatusLabel = (task: api.DownloadTask) => task.status === "running" && task.phase ? { resolving: "解析来源", downloading: "下载媒体", merging: "合并音视频", saving: "完成保存" }[task.phase] : LABEL[task.status];
export const parentFolder = (key: string) => key.includes("/") ? key.slice(0, key.lastIndexOf("/")) + "/" : "";
const elapsed = (value: number) => value < 1 ? "不到 1 秒" : value < 60 ? `${Math.round(value)} 秒` : value < 3600 ? `${Math.floor(value / 60)} 分 ${Math.round(value % 60)} 秒` : `${Math.floor(value / 3600)} 小时 ${Math.round(value % 3600 / 60)} 分`;
const seconds = (value: number) => value >= 3600 ? `${Math.ceil(value / 3600)} 小时` : value >= 60 ? `${Math.ceil(value / 60)} 分钟` : `${Math.ceil(value)} 秒`;

export function DownloadsView({ onChanged, onOpenFolder, onCreated }: { onChanged: () => void; onOpenFolder: (prefix: string) => void; onCreated?: () => void }) {
  useDocumentTitle(`下载任务 · ${BRAND}`);
  const [filter, setFilter] = useState("");
  const [newTask, setNewTask] = useState(false);
  const [edit, setEdit] = useState<api.DownloadTask | null>(null);
  const [confirm, setConfirm] = useState<{ task: api.DownloadTask; action: "stop" | "resume" | "restart" | "delete" } | null>(null);
  const [busy, setBusy] = useState(new Set<number>());
  const [clearing, setClearing] = useState<"completed" | "failed" | null>(null);
  const cursor = useRef<string | null>(null), epoch = useRef(0);
  const previous = useRef(new Map<number, api.DownloadStatus>());
  const fetchPage = useCallback((next: string | null) => { cursor.current = next; epoch.current++; return api.listDownloads(next, filter); }, [filter]);
  const pagination = useCursorPage(fetchPage);
  const hasActive = pagination.page?.tasks.some(active) ?? true;
  useEffect(() => {
    let alive = true, polling = false;
    const controller = new AbortController();
    // 没有进行中的任务时放慢轮询；新建或继续任务后会立即重新读取列表。
    const timer = window.setInterval(() => {
      if (polling || document.visibilityState === "hidden") return;
      polling = true;
      const revision = epoch.current;
      void api.listDownloads(cursor.current, filter, controller.signal).then(page => {
        if (alive && revision === epoch.current) pagination.setPage(page);
      }).catch(() => undefined).finally(() => { polling = false; });
    }, hasActive ? 3000 : 15000);
    return () => { alive = false; window.clearInterval(timer); controller.abort(); };
  }, [filter, pagination.setPage, hasActive]);
  const page = pagination.page;
  useEffect(() => {
    for (const task of page?.tasks ?? []) {
      if (task.status === "completed" && previous.current.has(task.id) && previous.current.get(task.id) !== "completed") onChanged();
      previous.current.set(task.id, task.status);
    }
    if (previous.current.size > 500) previous.current.clear();
  }, [page, onChanged]);
  async function control(task: api.DownloadTask, action: "stop" | "resume" | "restart" | "delete") {
    if (busy.has(task.id)) return;
    setBusy(current => new Set(current).add(task.id));
    try {
      await api.controlDownload(task.id, action);
      setConfirm(current => current?.task.id === task.id && current.action === action ? null : current);
      toast.success(action === "stop" ? "任务已停止" : action === "delete" ? "任务已删除" : "任务已加入下载队列");
      await pagination.reload();
    } catch (reason) { toast.error(api.errorMessage(reason, "操作失败，请稍后重试")); }
    finally { setBusy(current => { const next = new Set(current); next.delete(task.id); return next; }); }
  }
  async function clear(status: "completed" | "failed") {
    try {
      const { removed } = await api.clearDownloads(status);
      setClearing(null);
      toast.success(removed ? `已清除 ${removed} 个任务` : "没有需要清除的任务");
      await pagination.reload();
    } catch (reason) { toast.error(api.errorMessage(reason, "清除失败，请稍后重试")); }
  }
  const completed = () => { setNewTask(false); setEdit(null); void pagination.reload(); onChanged(); onCreated?.(); };
  return <>
    <PageHeader title="下载任务" description="交给服务器下载，关闭页面后继续保存到你的文件空间。"
      actions={<><Button icon="refresh" onClick={() => void pagination.reload()} disabled={pagination.loading}>刷新</Button><Button variant="primary" icon="plus" onClick={() => setNewTask(true)}>添加下载</Button></>} />
    <div className="download-toolbar"><Segmented label="任务状态" showLabels value={filter} onChange={setFilter} options={[
      { value: "", label: "全部" }, { value: "active", label: "进行中" }, { value: "stopped", label: "已停止" }, { value: "completed", label: "已完成" }, { value: "failed", label: "失败" },
    ]} /><span className="download-toolbar-meta"><span className="muted">{page ? `${page.total} 个任务` : "正在读取任务"}</span>
      <Menu label="清理任务" icon="trash" items={[
        { label: "清除已完成的任务", icon: "checkCircle", onSelect: () => setClearing("completed") },
        { label: "清除失败的任务", icon: "alert", onSelect: () => setClearing("failed") },
      ]} /></span></div>
    {page?.capabilities.pressure && <p className="inline-note tone-warning" role="status"><Icon name="alert" size={16} />{page.capabilities.pressure}</p>}
    <Panel flush>
      {pagination.error ? <EmptyState icon="alert" title="任务加载失败" description={pagination.error} action={<Button onClick={() => void pagination.reload()}>重试</Button>} />
        : !page ? <SkeletonRows rows={5} />
          : !page.tasks.length ? <EmptyState icon="download" title={filter ? "没有符合条件的任务" : "还没有下载任务"} description="粘贴文件链接、X 帖子或 YouTube 视频，也可以使用 curl 命令。" action={<Button variant="primary" icon="plus" onClick={() => setNewTask(true)}>添加下载</Button>} />
            : <div className="download-list" role="table" aria-label="下载任务">
              <div className="download-row download-columns" role="row"><span role="columnheader">文件与来源</span><span role="columnheader">进度</span><span role="columnheader">状态</span><span role="columnheader">速度与剩余时间</span><span role="columnheader" className="sr-only">操作</span></div>
              {page.tasks.map(task => {
                const percent = downloadPercent(task);
                const name = task.key.split("/").at(-1) ?? task.key;
                return <div className="download-row" role="row" key={task.id}>
                  <div className="download-file" role="cell"><span className="download-glyph"><Icon name={glyph(task)} size={22} /></span><div><strong title={task.key}>{name}</strong><small>{task.platform === "youtube" ? "YouTube" : task.platform === "x" ? "X" : task.source_host}{task.kind === "hls" ? " · 视频" : task.method === "POST" ? " · POST" : ""}</small><small title={task.key}>保存到 {task.key.includes("/") ? task.key.slice(0, task.key.lastIndexOf("/")) : "我的文件"}</small></div></div>
                  <div className="download-progress" role="cell">
                    <span>{task.kind === "hls" && task.segments_total ? `${task.segments_done} / ${task.segments_total} 个视频分片` : `${formatBytes(task.received)}${task.size !== null ? ` / ${formatBytes(task.size)}` : " · 大小未知"}`}<b>{percent !== null ? `${Math.floor(percent)}%` : ""}</b></span>
                    {percent !== null ? <Progress value={percent} tone={task.status === "failed" ? "danger" : task.status === "completed" ? "success" : "accent"} label={`${name}下载进度`} /> : <div className="download-unknown" role="status" aria-label="总大小未知" />}
                    {task.kind === "hls" && <small>已保存 {formatBytes(task.stored_bytes)}{task.status === "running" && task.segments_done === task.segments_total ? "，正在完成文件" : ""}</small>}
                  </div>
                  <div className="download-state" role="cell"><Badge tone={TONE[task.status]} dot>{downloadStatusLabel(task)}</Badge>{task.error && <small className="download-error">{task.error}</small>}{task.status === "completed" && <button type="button" className="link-button" onClick={() => onOpenFolder(parentFolder(task.key))}>打开所在目录</button>}</div>
                  <div className="download-speed" role="cell">{task.status === "running"
                    ? <><span>{formatBytes(task.speed)}/s</span>{task.eta_seconds !== null && <small>约剩 {seconds(task.eta_seconds)}</small>}</>
                    // 完成后显示累计用时（不含排队）和平均速度；旧版本完成的任务没有用时记录。
                    : task.status === "completed" && task.elapsed_seconds > 0 ? <><span>用时 {elapsed(task.elapsed_seconds)}</span><small>平均 {formatBytes(task.stored_bytes / Math.max(task.elapsed_seconds, 0.05))}/s</small></>
                      : <span>—</span>}</div>
                  <div className="download-actions" role="cell">{busy.has(task.id) ? <span className="spinner" aria-label="正在处理任务" /> : <Menu label={`${name}的任务操作`} items={[
                    ...(active(task) ? [{ label: "停止下载", icon: "pause" as const, onSelect: () => setConfirm({ task, action: "stop" }) }] : task.status !== "completed" ? [{ label: "继续下载", icon: "play" as const, onSelect: () => task.method === "POST" ? setConfirm({ task, action: "resume" }) : void control(task, "resume") }] : []),
                    { label: "重新下载", icon: "refresh" as const, onSelect: () => setConfirm({ task, action: "restart" }) },
                    { label: "更新下载参数", icon: "settings" as const, onSelect: () => setEdit(task) },
                    { label: "删除任务", icon: "trash" as const, danger: true, divider: true, onSelect: () => setConfirm({ task, action: "delete" }) },
                  ]} />}</div>
                </div>;
              })}
            </div>}
    </Panel>
    <Pagination {...pagination} />
    <p className="muted download-footnote">支持文件直链{page?.capabilities.hls ? "、M3U8 点播" : ""}{page?.capabilities.x ? "、X 帖子" : ""}{page?.capabilities.youtube ? "、YouTube 视频和 Shorts" : ""}。平台功能由管理员启用。网络中断会自动重试；文件直链满足条件时可续传，平台和 M3U8 任务手动停止后从头下载。删除任务保留已保存的文件。</p>
    {(newTask || edit) && <DownloadDialog task={edit} onClose={() => { setNewTask(false); setEdit(null); }} onComplete={completed} />}
    {clearing && <ConfirmDialog title={clearing === "completed" ? "清除已完成的任务" : "清除失败的任务"}
      description={clearing === "completed" ? "从列表中移除所有已完成的任务，已保存的文件不受影响。" : "移除所有失败的任务并清理未完成的数据，已保存的文件不受影响。"}
      confirmLabel="清除" danger onClose={() => setClearing(null)} onConfirm={() => clear(clearing)} />}
    {confirm && <ConfirmDialog title={confirm.action === "delete" ? "删除下载任务" : confirm.action === "restart" ? "重新下载文件" : confirm.action === "resume" ? "重新发送下载请求" : "停止下载"}
      description={confirm.action === "delete" ? <>删除任务“{confirm.task.key}”并清理未完成的数据，已保存的文件会保留。</>
        : confirm.action === "restart" ? <>清理当前断点并从头下载“{confirm.task.key}”。同名文件会自动改名保存。</>
          : confirm.action === "resume" ? "此任务使用 POST 请求，继续下载会重新发送请求和请求体。"
            : confirm.task.kind === "hls" || confirm.task.platform ? "此任务停止后会清理中间数据；继续时从头下载。" : "停止后保留已保存的分段。来源支持且文件未变化时，可从断点继续。"}
      danger={confirm.action === "delete" || confirm.action === "restart"} confirmLabel={confirm.action === "delete" ? "删除任务" : confirm.action === "restart" ? "重新下载" : confirm.action === "resume" ? "重新发送" : "停止下载"}
      onClose={() => setConfirm(null)} onConfirm={() => control(confirm.task, confirm.action)} />}
  </>;
}

function DownloadDialog({ task, onClose, onComplete }: { task: api.DownloadTask | null; onClose: () => void; onComplete: () => void }) {
  const [input, setInput] = useState("");
  const [downloadType, setDownloadType] = useState<"auto" | "http" | "hls" | "x" | "youtube">("auto");
  const [cookies, setCookies] = useState("");
  const [candidates, setCandidates] = useState<api.DownloadCandidate[] | null>(null);
  const [selected, setSelected] = useState(new Set<number>());
  const [destination, setDestination] = useState("");
  const [ready, setReady] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function parse() {
    setBusy(true); setError("");
    abort.current = new AbortController();
    try {
      const result = await api.parseDownloads(input, abort.current.signal, downloadType, cookies);
      setCandidates(result.candidates);
      const seen = new Set<string>();
      setSelected(new Set(result.candidates.flatMap((candidate, index) => {
        if (task) return index === 0 ? [index] : [];
        if (candidate.variant && seen.has(candidate.group)) return [];
        seen.add(candidate.group); return [index];
      })));
    } catch (reason) { setError(api.errorMessage(reason, "解析失败，请检查链接或命令")); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!candidates || !selected.size || !ready) return;
    setBusy(true); setError("");
    try {
      if (task) await api.controlDownload(task.id, "update", { ticket: candidates[[...selected][0]].ticket });
      else await api.createDownloads([...selected].map(index => ({ ticket: candidates[index].ticket, name: candidates[index].name })), destination);
      toast.success(task ? "参数已更新，任务已重新加入队列" : `${selected.size} 个任务已加入下载队列`);
      onComplete();
    } catch (reason) { setError(api.errorMessage(reason, "创建任务失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  return <Modal title={task ? "更新下载参数" : "添加下载"} icon="download" size="lg" onClose={onClose} dismissible={!busy}
    description={task ? "粘贴新的链接或命令，选择文件后从头重新下载。" : "粘贴文件直链、X 帖子、YouTube 视频或 curl 命令。"}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button>{candidates ? <><Button variant="ghost" disabled={busy} onClick={() => { setCandidates(null); setError(""); }}>返回编辑</Button><Button variant="primary" loading={busy} disabled={!selected.size || !ready} onClick={() => void submit()}>{task ? "更新并重新下载" : `开始下载${selected.size ? `（${selected.size}）` : ""}`}</Button></> : <Button variant="primary" loading={busy} disabled={!input.trim()} onClick={() => void parse()}>{busy ? "正在读取文件信息" : "解析内容"}</Button>}</>}>
    <div className="form">
      {!candidates ? <><Field label="链接或下载命令" hint="平台链接每次一个，多个直链每行一个。命令使用 bash 格式；支持请求头、Cookie、文本 POST 请求体，不执行命令。">
        <textarea className="input mono download-input" rows={8} autoComplete="off" autoCapitalize="none" spellCheck={false} value={input} onChange={event => setInput(event.target.value)} placeholder={"https://example.com/video.mp4\n\ncurl 'https://example.com/file.zip' -H 'Cookie: …'"} />
      </Field><Field label="下载类型" hint="平台链接自动解析媒体；无法识别的播放列表可选择 M3U8。"><select className="input" value={downloadType} onChange={event => setDownloadType(event.target.value as typeof downloadType)}><option value="auto">自动识别</option><option value="http">文件直链</option><option value="hls">M3U8 视频</option><option value="x">X 单条帖子</option><option value="youtube">YouTube 视频 / Shorts</option></select></Field>
        <details className="download-cookie-options"><summary>平台登录 Cookie（可选）</summary><div className="form">
          <Field label="Cookie 文本" hint="支持 Netscape cookies.txt 或 name=value 文本。仅用于平台解析，加密保存；不填写时尝试公开访问。"><textarea className="input mono download-cookie-input" rows={4} autoComplete="off" autoCapitalize="none" spellCheck={false} value={cookies} onChange={event => setCookies(event.target.value)} placeholder="粘贴当前平台的 Cookie，或导入 cookies.txt" /></Field>
          <Field label="导入 cookies.txt" hint="最多 32 KiB；只使用对应平台域名的 Cookie。"><input className="input download-cookie-file" type="file" accept=".txt,text/plain" disabled={busy} onChange={event => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 32768) { setError("Cookie 文件不能超过 32 KiB"); return; }
            void file.text().then(value => { setCookies(value); setError(""); }).catch(() => setError("无法读取 Cookie 文件，请粘贴文本"));
          }} /></Field>
        </div></details></> : <>
        <div className="download-candidates" role="group" aria-label="选择要下载的文件">
          {candidates.map((candidate, index) => <div className={`download-candidate${selected.has(index) ? " is-selected" : ""}`} key={candidate.ticket}>
            <Checkbox checked={selected.has(index)} label={`下载 ${candidate.name}${candidate.variant ? ` ${candidate.variant}` : ""}`} onChange={checked => setSelected(current => { const next = task ? new Set<number>() : new Set(current); if (checked) { if (candidate.variant) for (const item of next) if (candidates[item].group === candidate.group) next.delete(item); next.add(index); } else next.delete(index); return next; })} />
            <div className="download-candidate-copy">
              {task ? <strong>{candidate.name}</strong> : <Field label={`文件 ${index + 1} 的名称`}><input className="input" value={candidate.name} onChange={event => setCandidates(current => current?.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) ?? null)} /></Field>}
              <p>{candidate.source_host} · {candidate.variant ?? candidate.content_type ?? (candidate.media_type === "image" ? "图片" : candidate.media_type === "video" ? "视频" : candidate.media_type === "audio" ? "音频" : candidate.method)} · {candidate.size !== null ? formatBytes(candidate.size) : "大小未知"}</p>
              {(candidate.header_names.length > 0 || candidate.body_bytes > 0) && <details><summary>请求参数（凭据已隐藏）</summary><p>{candidate.header_names.length ? `请求头：${candidate.header_names.join("、")}` : "无额外请求头"}{candidate.body_bytes > 0 ? `；文本请求体 ${formatBytes(candidate.body_bytes)}` : ""}。下载时使用你提交的原值。</p></details>}
              {candidate.method === "POST" && <p className="tone-warning">点击开始才发送 POST 请求；中断后需要手动重新发送。</p>}
              {candidate.kind === "hls" && <p className="muted">保存为 MP4；停止后从头重新下载。</p>}
              {candidate.platform && <p className="muted">已解析的媒体地址会直接用于下载，失效时自动重新解析；{candidate.platform === "youtube" ? "同一视频选择一个清晰度，" : ""}停止后从头下载。</p>}
              {candidate.warnings.map((warning, i) => <p className="tone-warning" key={i}>{warning}</p>)}
            </div>
          </div>)}
        </div>
        {task ? <p className="muted">保存位置：{task.key}</p> : <><DestinationPicker value={destination} onChange={path => { setDestination(path); setReady(false); }} onReady={setReady} /><p className="muted">同名文件自动改名保存。来源凭据加密保存，任务列表只显示域名。</p></>}
      </>}
      {error && <div className="form-alert" role="alert"><Icon name="alert" size={16} />{error}</div>}
    </div>
  </Modal>;
}
