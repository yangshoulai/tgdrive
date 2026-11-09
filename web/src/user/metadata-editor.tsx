import { useEffect, useId, useRef, useState } from "react";
import * as api from "../api";
import { baseName, getFileKind } from "../files";
import { decodeText, readPreviewText } from "../preview-data";
import { Button, ConfirmDialog, Field, Modal, Notice, Segmented, formatBytes, toast, useUnsavedChanges } from "../ui";
import { ThumbnailEditor } from "./thumbnail-editor";
import { MediaLookupDialog } from "./media-lookup";

export type MetadataTab = "info" | "lyrics" | "subtitle" | "cover";
const EMPTY: api.AudioEditFields = { title: "", artist: "", album: "", album_artist: "", track: "", year: "", genre: "", lyrics: "", subtitle: "" };
const AUDIO_LABELS = { title: "歌曲名", artist: "歌手", album: "专辑", album_artist: "专辑歌手", track: "曲目编号", year: "发行日期", genre: "流派" };
const VIDEO_LABELS = { title: "标题", artist: "创作者", year: "发行日期", genre: "类型" };

async function coverData(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法处理封面图片");
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
  } finally { bitmap.close(); }
}

/** 文件元数据统一入口；封面复用原编辑器，音频支持把图片直接写入文件。 */
export function MetadataEditor({ file, onClose, initialTab }: { file: api.FileItem; onClose: () => void; initialTab?: MetadataTab }) {
  const id = useId(), kind = getFileKind(file.content_type, file.key);
  const audio = kind === "audio", video = kind === "video", media = audio || video;
  const textKey = video ? "subtitle" : "lyrics", textLabel = video ? "字幕" : "歌词";
  const tabs: { value: MetadataTab; label: string }[] = media ? [{ value: "info", label: "信息" }, { value: textKey, label: textLabel }, { value: "cover", label: "封面" }] : [{ value: "cover", label: "封面" }];
  const [tab, setTab] = useState<MetadataTab>(initialTab && tabs.some(item => item.value === initialTab) ? initialTab : media ? "info" : "cover");
  const [info, setInfo] = useState<api.AudioEditInfo | null>(null), [fields, setFields] = useState(EMPTY);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<api.AudioEditJob | null>(null), [discard, setDiscard] = useState(false), [lookup, setLookup] = useState(false);
  const [sidecars, setSidecars] = useState<api.PreviewAsset[]>([]);
  const [coverFooter, setCoverFooter] = useState<HTMLDivElement | null>(null);
  const [coverDirty, setCoverDirty] = useState(false), [pendingTab, setPendingTab] = useState<MetadataTab | null>(null);
  const operation = useRef<AbortController | null>(null), textRead = useRef<AbortController | null>(null), input = useRef<HTMLInputElement>(null);
  const original = info ? { ...info.fields, lyrics: info.lyrics, subtitle: "" } : EMPTY;
  const dirty = !!info && (Object.keys(EMPTY) as (keyof api.AudioEditFields)[]).some(key => fields[key] !== original[key]);
  useUnsavedChanges(dirty || coverDirty || busy);
  useEffect(() => {
    const controller = new AbortController();
    if (media) {
      void api.audioEditInfo(file.key, controller.signal).then(value => { setInfo(value); setFields({ ...value.fields, lyrics: value.lyrics, subtitle: "" }); })
        .catch(reason => { if (!controller.signal.aborted) setError(api.errorMessage(reason, "无法读取元数据")); });
      void api.previewAssets(file.key, controller.signal).then(items => setSidecars(items.filter(item => item.kind === textKey))).catch(() => undefined);
    }
    const lock = () => { if (api.isPrivatePath(file.key)) { operation.current?.abort(); onClose(); } };
    window.addEventListener("tessera:private-locked", lock);
    return () => { controller.abort(); operation.current?.abort(); textRead.current?.abort(); window.removeEventListener("tessera:private-locked", lock); };
  }, [file.key]);
  const close = () => { if (busy) return; if (dirty || coverDirty) setDiscard(true); else onClose(); };
  const set = (name: keyof api.AudioEditFields, value: string) => setFields(current => ({ ...current, [name]: value }));
  async function write(cover = "keep") {
    if (!info) throw new Error("请等待元数据读取完成");
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError("");
    try {
      const changes = Object.fromEntries(Object.entries(fields).filter(([name, value]) => value !== original[name as keyof api.AudioEditFields]));
      return await api.saveAudioMetadata({ ...file, etag: info.etag }, changes, cover, controller.signal, setProgress);
    } finally { operation.current = null; setBusy(false); setProgress(null); }
  }
  async function save(cover = "keep") {
    if (busy) return;
    try { await write(cover); toast.success("元数据已写入文件"); onClose(); }
    catch (reason) { setError(api.errorMessage(reason, "保存失败，请重试")); }
  }
  async function importLocal(blob: Blob) {
    if (blob.size > 512 * 1024) throw new Error(`${textLabel}最多 512 KB`);
    const value = decodeText(new Uint8Array(await blob.arrayBuffer()));
    if (!value.exact) throw new Error("无法完整解码，请使用 UTF-8、UTF-16 或 GB18030 文本");
    set(textKey, value.text);
  }
  async function importSidecar(path: string) {
    textRead.current?.abort(); const controller = new AbortController(); textRead.current = controller; setReading(true); setError("");
    try {
      const value = await readPreviewText(api.contentUrl(path), 512 * 1024, controller.signal);
      if (value.truncated) throw new Error(`${textLabel}最多 512 KB`);
      if (!value.exact) throw new Error("无法完整解码，请使用 UTF-8、UTF-16 或 GB18030 文本");
      if (!controller.signal.aborted) set(textKey, value.text);
    } catch (reason) { if (!controller.signal.aborted) setError(api.errorMessage(reason, "读取失败")); }
    finally { if (textRead.current === controller) setReading(false); }
  }
  const nativeCover = audio && !!info?.editable;
  async function coverSaved() {
    setBusy(false); setCoverDirty(false);
    if (!nativeCover) {
      const latest = await api.fileInfo(file.key);
      api.announceFileUpdated(latest);
      window.dispatchEvent(new CustomEvent("tessera:files-mutated"));
    }
    if (!nativeCover && dirty) { toast.success("封面已更新，其他元数据尚未保存"); setTab("info"); return; }
    toast.success(nativeCover ? "封面已内置到音频文件" : "封面已更新"); onClose();
  }
  return <Modal title="编辑元数据" description={baseName(file.key)} icon="edit" size="lg" className={`audio-editor metadata-editor${api.isPrivatePath(file.key) ? " private-dialog" : ""}`}
    onClose={close} dismissible={!busy} footer={tab === "cover" ? <div className="metadata-cover-footer" ref={setCoverFooter} /> : <>
      <span className="muted audio-editor-status" role="status">{busy ? progress?.detail || "正在准备保存…" : "直接更新文件，音视频不重新编码"}</span>
      <Button variant="ghost" disabled={busy && (!progress || !!progress.result)} onClick={() => busy ? operation.current?.abort() : close()}>{busy ? "取消保存" : "取消"}</Button>
      <Button variant="primary" icon="check" loading={busy} disabled={!info?.editable || !dirty || reading} onClick={() => void save()}>保存元数据</Button>
    </>}>
    <div className="audio-editor-body">
      {error && <Notice tone="danger">{error}</Notice>}
      <Segmented label="编辑内容" value={tab} onChange={next => { if (busy || next === tab) return; if (coverDirty) setPendingTab(next); else setTab(next); }} options={tabs} />
      {tab === "cover" ? media && !info && !error ? <p role="status">正在读取元数据…</p> : <>
        {nativeCover && <p className="muted">保存后封面内置到音频，随文件下载；其他页的未保存修改也会一并写入。</p>}
        <ThumbnailEditor file={file} inline footerTarget={coverFooter} onClose={close} onSaved={() => { void coverSaved().catch(reason => setError(api.errorMessage(reason, "封面已保存，请刷新文件信息"))); }}
          onBusyChange={setBusy} onDirtyChange={setCoverDirty} onCancelSave={nativeCover && progress && !progress.result ? () => operation.current?.abort() : undefined}
          onSaveImage={nativeCover ? async blob => { const saved = await write(await coverData(blob)); return saved.thumbnails || []; } : undefined}
          saveHint={nativeCover ? busy ? progress?.detail || "正在写入音频…" : "封面直接写入音频文件，音质不变" : undefined} />
        {nativeCover && info.cover && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save("remove")}>移除内置封面</Button>}
      </> : !info ? <p role="status">{error ? "关闭后重新打开可以重试。" : "正在读取元数据…"}</p> : <>
        {!info.editable && <Notice tone="warning">{info.reason}</Notice>}
        <fieldset disabled={busy || reading} className="audio-editor-fields">
          {tab === "info" ? <div className="audio-editor-grid">
            {(Object.entries(video ? VIDEO_LABELS : AUDIO_LABELS) as [keyof typeof AUDIO_LABELS, string][]).map(([name, label]) => <Field key={name} label={label} htmlFor={`${id}-${name}`}>
              <input id={`${id}-${name}`} className="input" disabled={!info.editable} value={fields[name]} maxLength={512} onChange={event => set(name, event.target.value)} />
            </Field>)}
          </div> : <div className="audio-editor-lyrics">
            <div className="audio-editor-actions">
              <Button size="sm" icon="search" onClick={() => setLookup(true)}>在线查找</Button>
              <Button size="sm" icon="upload" onClick={() => input.current?.click()}>上传{textLabel}文件</Button>
              <Button size="sm" variant="ghost" onClick={() => set(textKey, "")}>清空输入</Button>
              <input ref={input} type="file" accept={video ? ".srt,.vtt,.ass,.ssa,.txt" : ".lrc,.txt,text/plain"} hidden onChange={event => {
                const selected = event.target.files?.[0]; event.target.value = "";
                if (selected) void importLocal(selected).catch(reason => setError(api.errorMessage(reason, "读取失败")));
              }} />
            </div>
            <label className="field"><span>同目录{textLabel}</span><select className="input" defaultValue="" disabled={!sidecars.length} onChange={event => {
              const path = event.target.value; event.target.value = ""; if (path) void importSidecar(path);
            }}><option value="">{sidecars.length ? `选择要导入的${textLabel}文件…` : `同目录暂无关联${textLabel}文件`}</option>{sidecars.map(item => <option key={item.path} value={item.path}>{item.name}</option>)}</select>
              <small className="muted" role="status">{reading ? "正在读取…" : "导入后原文件保留，由你确认后自行删除。"}</small></label>
            <label htmlFor={`${id}-text`}>输入或粘贴{textLabel}</label>
            <textarea id={`${id}-text`} className="input audio-editor-text" value={fields[textKey]} onChange={event => set(textKey, event.target.value)} placeholder={video ? "在此输入或粘贴 SRT、WebVTT、ASS 字幕" : "在此输入或粘贴普通歌词，或带 [00:12.34] 时间标记的 LRC 歌词"} />
            <p className="muted">{video ? "字幕内置为视频的新轨道，已有字幕保留；视频与音频不重新编码。" : "歌词直接内置到音频中，支持纯文本与 LRC 时间轴，不生成额外文件。"}</p>
          </div>}
        </fieldset>
        {busy && progress && <p className="muted" role="status">已读取 {formatBytes(progress.read)} / {formatBytes(progress.size)}{progress.stored ? ` · 已保存 ${formatBytes(progress.stored)}` : ""}</p>}
      </>}
    </div>
    {lookup && <MediaLookupDialog file={file} want={textKey} onClose={() => setLookup(false)} onPickText={info?.editable ? text => { set(textKey, text); setLookup(false); } : undefined} />}
    {discard && <ConfirmDialog title="放弃未保存的元数据？" description="当前修改尚未写入文件。" confirmLabel="放弃修改" onClose={() => setDiscard(false)} onConfirm={onClose} />}
    {pendingTab && <ConfirmDialog title="放弃未保存的封面？" description="切换页面会丢弃刚选择的图片，其他元数据修改会保留。" confirmLabel="放弃封面" onClose={() => setPendingTab(null)} onConfirm={() => { setCoverDirty(false); setTab(pendingTab); setPendingTab(null); }} />}
  </Modal>;
}
