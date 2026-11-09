import { useEffect, useId, useRef, useState } from "react";
import * as api from "../api";
import { baseName } from "../files";
import { decodeText, readPreviewText } from "../preview-data";
import { Button, ConfirmDialog, Field, Modal, Notice, Segmented, formatBytes, toast, useUnsavedChanges } from "../ui";
import { ImageUrlForm, LocalImageButton, useImagePicker } from "./thumbnail-editor";
import { MediaCoverSearch, MediaLookupDialog } from "./media-lookup";

const EMPTY: api.AudioEditFields = { title: "", artist: "", album: "", album_artist: "", track: "", year: "", genre: "", lyrics: "" };
const LABELS = { title: "歌曲名", artist: "歌手", album: "专辑", album_artist: "专辑歌手", track: "曲目编号", year: "发行日期", genre: "流派" };

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

/** 标签写入音频本身；普通目录和私密空间使用相同界面，后端按版本条件提交。 */
export function AudioEditor({ file, onClose }: { file: api.FileItem; onClose: () => void }) {
  const id = useId();
  const [info, setInfo] = useState<api.AudioEditInfo | null>(null), [fields, setFields] = useState(EMPTY);
  const [tab, setTab] = useState<"info" | "lyrics" | "cover">("info");
  const [cover, setCover] = useState<"keep" | "replace" | "remove">("keep");
  const [source, setSource] = useState<"local" | "url" | "online">("local");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [readingCover, setReadingCover] = useState(false), [readingLyrics, setReadingLyrics] = useState(false);
  const [progress, setProgress] = useState<api.AudioEditJob | null>(null), [discard, setDiscard] = useState(false), [lookup, setLookup] = useState(false);
  const [sidecars, setSidecars] = useState<api.PreviewAsset[]>([]);
  const operation = useRef<AbortController | null>(null), imageRead = useRef<AbortController | null>(null);
  const lyricRead = useRef<AbortController | null>(null);
  const picker = useImagePicker(file.key), lyricInput = useRef<HTMLInputElement>(null);
  const original = info ? { ...info.fields, lyrics: info.lyrics } : EMPTY;
  const dirty = !!info && (JSON.stringify(fields) !== JSON.stringify(original) || cover !== "keep");
  useUnsavedChanges(dirty || busy);
  useEffect(() => {
    const controller = new AbortController();
    void api.audioEditInfo(file.key, controller.signal).then(value => {
      setInfo(value); setFields({ ...value.fields, lyrics: value.lyrics });
    }).catch(reason => { if (!controller.signal.aborted) setError(api.errorMessage(reason, "无法读取音频信息")); });
    void api.previewAssets(file.key, controller.signal).then(items => setSidecars(items.filter(item => item.kind === "lyrics"))).catch(() => undefined);
    const lock = () => { if (api.isPrivatePath(file.key)) { operation.current?.abort(); onClose(); } };
    window.addEventListener("tessera:private-locked", lock);
    return () => { controller.abort(); operation.current?.abort(); imageRead.current?.abort(); lyricRead.current?.abort(); window.removeEventListener("tessera:private-locked", lock); };
  }, [file.key]);
  useEffect(() => { if (picker.picked) setCover("replace"); }, [picker.picked]);
  const close = () => { if (busy) return; if (dirty) setDiscard(true); else onClose(); };
  const currentCover = file.has_thumbnail ? api.thumbnailUrl(file.key, file.etag, file.thumbnail_versions?.poster || file.thumbnail_versions?.thumb || file.etag, "poster") : "";
  async function save() {
    if (!info || !dirty || busy) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError("");
    try {
      const changes = Object.fromEntries(Object.entries(fields).filter(([name, value]) => value !== original[name as keyof api.AudioEditFields]));
      const image = cover === "replace" && picker.picked ? await coverData(picker.picked.blob) : cover;
      await api.saveAudioMetadata({ ...file, etag: info.etag }, changes, image, controller.signal, setProgress);
      toast.success("音频信息已写入文件"); onClose();
    } catch (reason) {
      if (!controller.signal.aborted) setError(api.errorMessage(reason, "保存失败，请重试"));
      else setError("已请求取消保存；未完成的修改不会覆盖原文件。");
    } finally { operation.current = null; setBusy(false); setProgress(null); }
  }
  const set = (name: keyof api.AudioEditFields, value: string) => setFields(current => ({ ...current, [name]: value }));
  async function importLyrics(blob: Blob) {
    if (blob.size > 512 * 1024) throw new Error("歌词最多 512 KB");
    const value = decodeText(new Uint8Array(await blob.arrayBuffer()));
    if (!value.exact) throw new Error("无法完整解码这份歌词，请使用 UTF-8、UTF-16 或 GB18030 文本");
    set("lyrics", value.text);
  }
  async function importSidecar(path: string) {
    lyricRead.current?.abort(); const controller = new AbortController(); lyricRead.current = controller;
    setReadingLyrics(true); setError("");
    try {
      const value = await readPreviewText(api.contentUrl(path), 512 * 1024, controller.signal);
      if (value.truncated) throw new Error("歌词最多 512 KB");
      if (!value.exact) throw new Error("无法完整解码这份歌词，请使用 UTF-8、UTF-16 或 GB18030 文本");
      if (!controller.signal.aborted) set("lyrics", value.text);
    } catch (reason) {
      if (!controller.signal.aborted) setError(api.errorMessage(reason, "读取歌词失败"));
    } finally { if (lyricRead.current === controller) setReadingLyrics(false); }
  }
  return <Modal title="编辑音频信息" description={baseName(file.key)} icon="music" size="lg" className="audio-editor"
    onClose={close} dismissible={!busy} footer={<>
      <span className="muted audio-editor-status" role="status">{busy ? progress?.detail || "正在准备保存…" : "直接更新音频文件，音质不变"}</span>
      <Button variant="ghost" disabled={busy && (!progress || !!progress.result)} onClick={() => busy ? operation.current?.abort() : close()}>{busy ? "取消保存" : "取消"}</Button>
      <Button variant="primary" icon="check" loading={busy} disabled={!info?.editable || !dirty || readingCover || readingLyrics || picker.loading} onClick={() => void save()}>保存到音频</Button>
    </>}>
    <div className="audio-editor-body">
      {error && <Notice tone="danger">{error}</Notice>}
      {!info ? <p role="status">{error ? "关闭后重新打开可以重试。" : "正在读取音频信息…"}</p> : <>
        {!info.editable && <Notice tone="warning">{info.reason}</Notice>}
        <Segmented label="编辑内容" value={tab} onChange={setTab} options={[{ value: "info", label: "信息" }, { value: "lyrics", label: "歌词" }, { value: "cover", label: "封面" }]} />
        <fieldset disabled={busy || readingLyrics || !info.editable} className="audio-editor-fields">
          {tab === "info" && <div className="audio-editor-grid">
            {(Object.entries(LABELS) as [keyof typeof LABELS, string][]).map(([name, label]) => <Field key={name} label={label} htmlFor={`${id}-${name}`}>
              <input id={`${id}-${name}`} className="input" value={fields[name]} maxLength={512} onChange={event => set(name, event.target.value)} />
            </Field>)}
          </div>}
          {tab === "lyrics" && <div className="audio-editor-lyrics">
            <div className="audio-editor-actions">
              <Button size="sm" icon="search" onClick={() => setLookup(true)}>在线查找</Button>
              <Button size="sm" icon="upload" onClick={() => lyricInput.current?.click()}>导入歌词文件</Button>
              <Button size="sm" variant="ghost" onClick={() => set("lyrics", "")}>清空歌词</Button>
              <input ref={lyricInput} type="file" accept=".lrc,.txt,text/plain" hidden onChange={event => {
                const selected = event.target.files?.[0]; event.target.value = "";
                if (!selected) return;
                if (selected.size > 512 * 1024) return setError("歌词最多 512 KB");
                void importLyrics(selected).catch(reason => setError(api.errorMessage(reason, "读取歌词失败")));
              }} />
            </div>
            {sidecars.length > 0 && <label className="field"><span>导入同目录歌词</span>
              <select className="input" defaultValue="" onChange={event => {
                const path = event.target.value; event.target.value = "";
                if (path) void importSidecar(path);
              }}><option value="">选择要内置的歌词文件…</option>{sidecars.map(item => <option key={item.path} value={item.path}>{item.name}</option>)}</select>
              <small className="muted" role="status">{readingLyrics ? "正在读取歌词…" : "导入后保存到音频；已有歌词文件保留，由你确认后自行删除。"}</small>
            </label>}
            <label className="sr-only" htmlFor={`${id}-lyrics`}>歌词正文</label>
            <textarea id={`${id}-lyrics`} className="input audio-editor-text" value={fields.lyrics} onChange={event => set("lyrics", event.target.value)} placeholder="可以输入纯文本歌词，或带 [00:12.34] 时间标记的 LRC 歌词" />
            <p className="muted">歌词将直接内置到音频中；支持纯文本与 LRC 时间轴，不再生成额外文件。</p>
          </div>}
          {tab === "cover" && <div className="audio-editor-cover">
            <div className="audio-editor-art">{cover === "replace" && picker.picked ? <img src={picker.picked.url} alt="待写入的封面" />
              : cover !== "remove" && currentCover ? <img src={currentCover} alt="当前封面" /> : <span>{cover === "remove" ? "保存后移除内置封面" : info.cover ? "音频已内置封面" : "音频尚无内置封面"}</span>}</div>
            <div className="audio-editor-actions">
              <Button size="sm" variant="ghost" onClick={() => { picker.setPicked(null); setCover("keep"); }}>保留原封面</Button>
              <Button size="sm" variant="ghost" onClick={() => setCover("remove")}>移除内置封面</Button>
              {currentCover && <Button size="sm" onClick={() => { void api.audioCoverImage(currentCover).then(blob => picker.accept(blob, "当前显示封面")).catch(reason => setError(api.errorMessage(reason, "读取封面失败"))); }}>写入当前显示封面</Button>}
            </div>
            <Segmented label="封面来源" value={source} onChange={setSource} options={[{ value: "local", label: "本地图片" }, { value: "url", label: "网络图片" }, { value: "online", label: "在线查找" }]} />
            {picker.error && <Notice tone="danger">{picker.error}</Notice>}
            {source === "local" && <LocalImageButton picker={picker} disabled={busy} />}
            {source === "url" && <ImageUrlForm picker={picker} disabled={busy} />}
            {source === "online" && <MediaCoverSearch file={file} disabled={busy || readingCover} onPick={candidate => {
              imageRead.current?.abort(); const controller = new AbortController(); imageRead.current = controller; setReadingCover(true);
              void api.mediaFetchImage(file.key, candidate.token, controller.signal).then(blob => { if (!controller.signal.aborted) return picker.accept(blob, candidate.title); })
                .catch(reason => { if (!controller.signal.aborted) setError(api.errorMessage(reason, "读取封面失败")); }).finally(() => { if (imageRead.current === controller) setReadingCover(false); });
            }} />}
            <p className="muted">选中的图片会内置到音频中，下载后仍带封面；保留原封面不会改动文件里已有的图片。</p>
          </div>}
        </fieldset>
        {busy && progress && <p className="muted" role="status">已读取 {formatBytes(progress.read)} / {formatBytes(progress.size)}{progress.stored ? ` · 已保存 ${formatBytes(progress.stored)}` : ""}</p>}
      </>}
    </div>
    {lookup && <MediaLookupDialog file={file} want="lyrics" onClose={() => setLookup(false)} onPickLyrics={text => { set("lyrics", text); setLookup(false); }} />}
    {discard && <ConfirmDialog title="放弃未保存的音频信息？" description="当前修改尚未写入音频文件。" confirmLabel="放弃修改" onClose={() => setDiscard(false)} onConfirm={onClose} />}
  </Modal>;
}
