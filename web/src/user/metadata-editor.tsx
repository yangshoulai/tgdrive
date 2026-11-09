import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import * as api from "../api";
import { FileVisual, baseName, getFileKind } from "../files";
import { decodeText, readPreviewText } from "../preview-data";
import { Badge, Button, ConfirmDialog, Icon, IconButton, Menu, Modal, Notice, Tabs, formatBytes, toast, useUnsavedChanges } from "../ui";
import { ThumbnailEditor } from "./thumbnail-editor";
import { AUDIO_FIELD_LABELS, MediaInfoLookupDialog, MediaLookupDialog, VIDEO_FIELD_LABELS } from "./media-lookup";

export type MetadataTab = "info" | "lyrics" | "subtitle" | "cover";
type FieldName = api.MediaInfoField;
const EMPTY: api.AudioEditFields = { title: "", artist: "", album: "", album_artist: "", track: "", year: "", genre: "", composer: "", director: "", actors: "", description: "", lyrics: "", subtitle: "" };
/** 信息页分组：字段名称与「查找信息」共用。 */
const AUDIO_GROUPS: { title: string; fields: FieldName[] }[] = [
  { title: "歌曲", fields: ["title", "artist", "album", "album_artist"] },
  { title: "发行", fields: ["year", "track", "genre", "composer"] },
  { title: "说明", fields: ["description"] },
];
const VIDEO_GROUPS: { title: string; fields: FieldName[] }[] = [
  { title: "影片", fields: ["title", "artist", "year", "genre"] },
  { title: "演职人员", fields: ["director", "actors"] },
  { title: "简介", fields: ["description"] },
];
const PLACEHOLDERS: Partial<Record<FieldName, string>> = { year: "如 2003", track: "如 3 或 3/12", actors: "多位演员用顿号或逗号分隔" };
const WIDE: FieldName[] = ["title", "actors", "description"];
const LANGUAGES = [["zh-CN", "简体中文"], ["zh-TW", "繁体中文"], ["zh", "中文"], ["en", "英语"], ["ja", "日语"], ["ko", "韩语"], ["fr", "法语"], ["de", "德语"], ["es", "西班牙语"], ["ru", "俄语"]];
const ALIASES: Record<string, string> = { chi: "中文", zho: "中文", chs: "简体中文", cht: "繁体中文", eng: "英语", jpn: "日语", kor: "韩语", fre: "法语", fra: "法语", ger: "德语", deu: "德语", spa: "西班牙语", rus: "俄语" };
const languageName = (code: string) => LANGUAGES.find(([value]) => value.toLowerCase() === code.toLowerCase())?.[1] ?? ALIASES[code.toLowerCase()] ?? code;
/** 轨道名称就是语言代码（内置字幕常见）时显示语言名称。 */
const trackName = (title: string, language: string) => !title ? "字幕" : language && title.toLowerCase() === language.toLowerCase() ? languageName(language) : title;
const TEXT_LIMIT = 2 * 1024 * 1024;
type Track = { key: string; id?: string; title: string; language: string; default: boolean; text?: string; changed?: boolean; textChanged?: boolean; embedded?: boolean };
const clock = (seconds: number | null | undefined) => seconds ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}` : "";

/** 元数据与原文件独立保存；同目录歌词、字幕只在用户明确选择时导入，文件内置的歌词与字幕在没有保存时作为回退。 */
export function MetadataEditor({ file, onClose, initialTab }: { file: api.FileItem; onClose: () => void; initialTab?: MetadataTab }) {
  const id = useId(), kind = getFileKind(file.content_type, file.key);
  const audio = kind === "audio", video = kind === "video", media = audio || video;
  const textKey = video ? "subtitle" : "lyrics", textLabel = video ? "字幕" : "歌词";
  const labels = video ? VIDEO_FIELD_LABELS : AUDIO_FIELD_LABELS, groups = video ? VIDEO_GROUPS : AUDIO_GROUPS;
  const [tab, setTab] = useState<MetadataTab>(initialTab && (media || initialTab === "cover") ? initialTab : media ? "info" : "cover");
  const [info, setInfo] = useState<api.AudioEditInfo | null>(null), [fields, setFields] = useState(EMPTY);
  const [tracks, setTracks] = useState<Track[]>([]), [selected, setSelected] = useState(""), [removed, setRemoved] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<number[]>([]), [extracting, setExtracting] = useState<Record<number, number | null>>({});
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<api.AudioEditJob | null>(null), [discard, setDiscard] = useState(false);
  const [lookup, setLookup] = useState<"text" | "info" | null>(null);
  const [sidecars, setSidecars] = useState<api.PreviewAsset[]>([]), [coverFooter, setCoverFooter] = useState<HTMLDivElement | null>(null);
  const [coverDirty, setCoverDirty] = useState(false), [pendingTab, setPendingTab] = useState<MetadataTab | null>(null);
  const operation = useRef<AbortController | null>(null), textRead = useRef<AbortController | null>(null), extraction = useRef(new Map<number, AbortController>());
  const input = useRef<HTMLInputElement>(null);
  const original = info ? { ...EMPTY, ...info.fields, lyrics: info.lyrics } : EMPTY;
  const changedFields = info ? (Object.keys(EMPTY) as (keyof api.AudioEditFields)[]).filter(key => fields[key] !== original[key]) : [];
  const changes = changedFields.length + removed.length + excluded.length + tracks.filter(track => track.changed).length;
  const dirty = changes > 0;
  const track = tracks.find(item => item.key === selected);
  const embedded = (info?.embedded_subtitles ?? []).filter(stream => !tracks.some(item => item.embedded && item.key === `embedded-${stream.index}`));
  useUnsavedChanges(dirty || coverDirty || busy);

  async function load(signal: AbortSignal, keep = false) {
    const value = await api.audioEditInfo(file.key, signal);
    setInfo(value);
    const rows = value.assets.map(asset => ({ key: asset.id!, id: asset.id, title: asset.name, language: asset.language || "", default: !!asset.default }));
    if (!keep) { setFields({ ...EMPTY, ...value.fields, lyrics: value.lyrics }); setTracks(rows); setSelected(rows[0]?.key || ""); return; }
    // 提取内置字幕后只补上新保存的轨道，不打断正在编辑的内容。
    setTracks(items => [...items, ...rows.filter(row => !items.some(item => item.id === row.id) && !removed.includes(row.id!))]);
    setSelected(current => current || rows.find(row => !removed.includes(row.id!))?.key || "");
  }
  useEffect(() => {
    const controller = new AbortController();
    if (media) {
      void load(controller.signal).catch(reason => { if (!controller.signal.aborted) setError(api.errorMessage(reason, "无法读取元数据")); });
      void api.mediaImportFiles(file.key, controller.signal).then(items => setSidecars(items.filter(item => item.kind === textKey))).catch(() => undefined);
    }
    const lock = () => { if (api.isPrivatePath(file.key)) { operation.current?.abort(); onClose(); } };
    window.addEventListener("tessera:private-locked", lock);
    return () => {
      controller.abort(); operation.current?.abort(); textRead.current?.abort();
      for (const item of extraction.current.values()) item.abort();
      window.removeEventListener("tessera:private-locked", lock);
    };
  }, [file.key]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    textRead.current?.abort();
    if (!track?.id || track.text !== undefined || tab !== "subtitle") { setReading(false); return; }
    const controller = new AbortController(); textRead.current = controller; setReading(true);
    void api.mediaAssetText(file.key, track.id, controller.signal).then(text => {
      if (!controller.signal.aborted) setTracks(items => items.map(item => item.key === track.key ? { ...item, text } : item));
    }).catch(reason => { if (!controller.signal.aborted) setError(api.errorMessage(reason, "无法读取字幕")); })
      .finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [selected, tab, info]);  // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { if (busy) return; if (dirty || coverDirty) setDiscard(true); else onClose(); };
  const set = (name: keyof api.AudioEditFields, value: string) => setFields(current => ({ ...current, [name]: value }));
  function addTrack(text = "", language = "", title = "字幕") {
    const key = `new-${Date.now()}-${Math.random()}`;
    setTracks(items => [...items, { key, title, language, default: !items.length, text, changed: true, textChanged: true }]);
    setSelected(key);
  }
  function editTrack(changes: Partial<Track>) {
    setTracks(items => items.map(item => item.key === selected ? { ...item, ...changes, changed: true, textChanged: item.textChanged || changes.text !== undefined }
      : changes.default ? { ...item, default: false, changed: item.default || item.changed } : item));
  }
  function removeTrack() {
    if (!track) return;
    if (track.id) setRemoved(items => [...items, track.id!]);
    const rest = tracks.filter(item => item.key !== selected);
    setTracks(rest); setSelected(rest[0]?.key || "");
  }
  function useText(text: string, language?: string | null, title?: string) {
    if (!video) { set("lyrics", text); return; }
    if (track) editTrack({ text, ...(language ? { language } : {}), ...(title ? { title } : {}) });
    else addTrack(text, language || "", title || "字幕");
  }
  async function save() {
    if (!info || busy) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError("");
    try {
      const values = Object.fromEntries(changedFields.map(name => [name, fields[name]]));
      await api.saveAudioMetadata({ ...file, etag: info.etag }, values, "keep", controller.signal, setProgress, { revision: info.revision,
        subtitles: { upsert: tracks.filter(item => item.changed).map(item => ({ id: item.id, title: item.title, language: item.language || null, default: item.default, ...(item.textChanged ? { text: item.text } : {}) })),
          remove: removed, exclude: excluded } });
      toast.success("元数据已保存，原文件未改动"); onClose();
    } catch (reason) { setError(api.errorMessage(reason, "保存失败，请重试")); }
    finally { operation.current = null; setBusy(false); setProgress(null); }
  }
  async function importLocal(blob: File) {
    if (blob.size > TEXT_LIMIT) throw new Error(`${textLabel}最多 2 MB`);
    const value = decodeText(new Uint8Array(await blob.arrayBuffer()));
    if (!value.exact) throw new Error("无法完整解码，请使用 UTF-8、UTF-16 或 GB18030 文本");
    useText(value.text, null, video ? blob.name.replace(/\.[^.]+$/, "") : undefined);
  }
  async function importSidecar(asset: api.PreviewAsset) {
    textRead.current?.abort(); const controller = new AbortController(); textRead.current = controller; setReading(true); setError("");
    try {
      const value = await readPreviewText(api.contentUrl(asset.path), TEXT_LIMIT, controller.signal);
      if (value.truncated) throw new Error(`${textLabel}最多 2 MB`);
      if (!value.exact) throw new Error("无法完整解码，请使用 UTF-8、UTF-16 或 GB18030 文本");
      if (!controller.signal.aborted) useText(value.text, asset.language, asset.name);
    } catch (reason) { if (!controller.signal.aborted) setError(api.errorMessage(reason, "读取失败")); }
    finally { if (textRead.current === controller) setReading(false); }
  }
  /** 提取内置字幕轨：服务器一次读取提取全部未保存的文字轨并保存为元数据，然后把新轨道加入列表。 */
  async function extract(stream: api.MediaSubtitleStream) {
    if (!info) return;
    const controller = new AbortController(); extraction.current.set(stream.index, controller);
    setExtracting(current => ({ ...current, [stream.index]: null })); setError("");
    try {
      await api.embeddedSubtitle(file.key, info.etag, stream.index, controller.signal,
        fraction => setExtracting(current => ({ ...current, [stream.index]: fraction })));
      await load(controller.signal, true);
      toast.success("内置字幕已保存为元数据");
    } catch (reason) { if (!controller.signal.aborted) setError(api.errorMessage(reason, "内置字幕提取失败")); }
    finally {
      extraction.current.delete(stream.index);
      setExtracting(current => { const next = { ...current }; delete next[stream.index]; return next; });
    }
  }
  async function coverSaved() {
    setBusy(false); setCoverDirty(false);
    api.announceFileUpdated(await api.fileInfo(file.key));
    if (dirty) { toast.success("封面已更新，其他元数据尚未保存"); setTab("info"); return; }
    toast.success("封面已更新"); onClose();
  }

  const tabs: { value: MetadataTab; label: string; icon: "info" | "music" | "fileText" | "image"; count?: number }[] = media
    ? [{ value: "info", label: "信息", icon: "info" }, { value: textKey, label: textLabel, icon: video ? "fileText" : "music", count: video ? tracks.length : undefined }, { value: "cover", label: "封面", icon: "image" }]
    : [{ value: "cover", label: "封面", icon: "image" }];
  const headline = fields.title.trim() || baseName(file.key).replace(/\.[^.]+$/, "");
  const byline = (video ? [fields.director, fields.year] : [fields.artist, fields.album]).map(value => value.trim()).filter(Boolean).join(" · ");
  const status = busy ? progress?.detail || "正在保存…" : dirty ? `${changes} 项修改未保存，原文件不会改动` : "仅保存元数据，原文件不会改动";
  const sidecarMenu = sidecars.length > 0 && <Menu label={`导入同目录${textLabel}`} align="start" className="metadata-menu-button"
    items={sidecars.map(asset => ({ label: asset.name, icon: "fileText" as const, onSelect: () => void importSidecar(asset) }))}>
    <Icon name="folder" size={15} /><span>同目录导入</span><Icon name="chevronDown" size={14} />
  </Menu>;
  const textTools = <div className="metadata-text-tools">
    <Button size="sm" icon="search" onClick={() => setLookup("text")}>在线查找</Button>
    <Button size="sm" icon="upload" onClick={() => input.current?.click()}>上传文件</Button>
    {sidecarMenu}
    <Button size="sm" variant="ghost" icon="trash" disabled={video ? !track?.text : !fields.lyrics} onClick={() => useText("")}>清空</Button>
    <input ref={input} type="file" accept={video ? ".srt,.vtt,.ass,.ssa,.txt" : ".lrc,.txt,text/plain"} hidden onChange={event => {
      const picked = event.target.files?.[0]; event.target.value = "";
      if (picked) void importLocal(picked).catch(reason => setError(api.errorMessage(reason, "读取失败")));
    }} />
  </div>;

  return <Modal title="编辑元数据" description={baseName(file.key)} icon="edit" size="lg" className={`audio-editor metadata-editor${api.isPrivatePath(file.key) ? " private-dialog" : ""}`}
    onClose={close} dismissible={!busy} footer={tab === "cover" ? <div className="metadata-cover-footer" ref={setCoverFooter} /> : <>
      <span className={`muted audio-editor-status${dirty && !busy ? " is-dirty" : ""}`} role="status">{status}</span>
      <Button variant="ghost" disabled={busy && (!progress || !!progress.result)} onClick={() => busy ? operation.current?.abort() : close()}>{busy ? "取消保存" : "取消"}</Button>
      <Button variant="primary" icon="check" loading={busy} disabled={!info?.editable || !dirty || reading} onClick={() => void save()}>保存元数据</Button>
    </>}>
    <div className="metadata-body">
      <header className="metadata-summary">
        <FileVisual kind={kind} src={api.fileThumbnail(file, "grid")} size="xl" />
        <div className="metadata-summary-text">
          <strong title={headline}>{headline}</strong>
          <span className={byline ? undefined : "muted"}>{byline || (media ? (video ? "还没有导演与年份" : "还没有歌手与专辑") : "其他文件只管理封面")}</span>
          <small>{[formatBytes(file.size), clock(info?.duration), baseName(file.key).split(".").length > 1 ? baseName(file.key).split(".").pop()!.toUpperCase() : ""].filter(Boolean).join(" · ")}</small>
        </div>
        <Badge tone="success" icon="shield">原文件不变</Badge>
      </header>
      {tabs.length > 1 && <Tabs label="编辑内容" className="metadata-tabs" value={tab} options={tabs}
        onChange={next => { if (busy || next === tab) return; if (coverDirty) setPendingTab(next); else setTab(next); }} />}
      {error && <Notice tone="danger">{error}</Notice>}
      {tab === "cover" ? <ThumbnailEditor file={file} inline footerTarget={coverFooter} onClose={close}
        onSaved={() => { void coverSaved().catch(reason => setError(api.errorMessage(reason, "封面已保存，请刷新文件信息"))); }} onBusyChange={setBusy} onDirtyChange={setCoverDirty} saveHint="封面独立保存，计入用户空间，原文件不会改动" />
        : !info ? <div className="metadata-loading" role="status">{error ? "关闭后重新打开可以重试。" : <><span className="spinner" aria-hidden="true" />正在读取元数据…</>}</div> : <>
        {info.initialization.state !== "ready" && info.initialization.detail && <Notice tone="info">{info.initialization.detail}</Notice>}
        <fieldset disabled={busy} className="audio-editor-fields">
          {tab === "info" ? <div className="metadata-info">
            {groups.map((group, index) => <section key={group.title} className="metadata-group">
              <div className="metadata-group-head"><h3>{group.title}</h3>
                {index === 0 && <Button size="sm" icon="search" onClick={() => setLookup("info")}>在线查找信息</Button>}</div>
              <div className="metadata-grid">{group.fields.map(name => <MetaField key={name} id={`${id}-${name}`} label={labels[name] ?? name} wide={WIDE.includes(name)}
                changed={fields[name] !== original[name]} onRevert={() => set(name, original[name])}>
                {name === "description" ? <textarea id={`${id}-${name}`} className="input" rows={4} value={fields[name]} maxLength={16000} onChange={event => set(name, event.target.value)} />
                  : <input id={`${id}-${name}`} className="input" value={fields[name]} placeholder={PLACEHOLDERS[name]} maxLength={name === "actors" ? 4000 : 512}
                    inputMode={name === "year" || name === "track" ? "numeric" : undefined} onChange={event => set(name, event.target.value)} />}
              </MetaField>)}</div>
            </section>)}
          </div> : audio ? <div className="metadata-text">
            <div className="metadata-text-head">
              {textTools}
              <TextState source={fields.lyrics !== original.lyrics ? "changed" : info.lyrics_source} />
            </div>
            <textarea id={`${id}-text`} aria-label="歌词" className="input metadata-text-area" value={fields.lyrics} onChange={event => set("lyrics", event.target.value)}
              placeholder="输入普通歌词或带 [00:12.34] 时间标记的 LRC 歌词；也可以在线查找、上传或从同目录导入。" />
            <TextStats text={fields.lyrics} kind="lyrics" />
          </div> : <div className="metadata-subtitles">
            <aside className="metadata-track-pane" aria-label="字幕轨道">
              <div className="metadata-track-list" role="listbox" aria-label="已保存的字幕">
                {tracks.map(item => <button key={item.key} type="button" role="option" aria-selected={item.key === selected}
                  className={`metadata-track${item.key === selected ? " is-selected" : ""}`} onClick={() => setSelected(item.key)}>
                  <span className="metadata-track-title"><strong>{trackName(item.title, item.language)}</strong>{item.default && <Icon name="star" size={13} filled />}</span>
                  <span className="metadata-track-meta">{item.language ? languageName(item.language) : "未标注语言"}{!item.id ? " · 新增" : item.changed ? " · 已修改" : ""}</span>
                </button>)}
                {!tracks.length && <p className="metadata-track-empty">还没有保存的字幕</p>}
              </div>
              <Button size="sm" icon="plus" block disabled={tracks.length >= 32} onClick={() => addTrack()}>添加字幕</Button>
              {(embedded.length > 0 || excluded.length > 0) && <div className="metadata-embedded">
                <h4>文件内置字幕</h4>
                <p>未保存时播放器直接使用；提取后保存为元数据，以后播放不再读取原文件。</p>
                {embedded.map(stream => {
                  const off = excluded.includes(stream.index), fraction = extracting[stream.index];
                  const name = trackName(stream.title || stream.language || `字幕 ${stream.index + 1}`, stream.language ?? "");
                  return <div key={stream.index} className={`metadata-embedded-row${off ? " is-off" : ""}`}>
                    <span title={`${name}${stream.codec ? ` · ${stream.codec}` : ""}`}><strong>{name}</strong><small>{off ? "保存后不再使用" : stream.codec || "文字字幕"}</small></span>
                    {off ? <Button size="sm" variant="ghost" onClick={() => setExcluded(items => items.filter(item => item !== stream.index))}>恢复</Button> : <>
                      <Button size="sm" loading={fraction !== undefined} disabled={tracks.length >= 32} onClick={() => void extract(stream)}>
                        {fraction !== undefined && fraction !== null ? `${Math.round(fraction * 100)}%` : "提取保存"}</Button>
                      <IconButton size="sm" icon="x" label="不再使用这条内置字幕" disabled={fraction !== undefined} onClick={() => setExcluded(items => [...items, stream.index])} />
                    </>}
                  </div>;
                })}
              </div>}
            </aside>
            <div className="metadata-track-detail">
              {!track ? <div className="metadata-track-empty-detail">
                <Icon name="fileText" size={22} /><strong>{tracks.length ? "选择左侧的一条字幕" : "添加一条字幕"}</strong>
                <p>每条字幕独立保存，可以设置名称、语言和默认项；支持 SRT、WebVTT 与 ASS，可以在线查找、上传或从同目录导入。</p>
                {!tracks.length && <Button size="sm" icon="plus" onClick={() => addTrack()}>添加字幕</Button>}
              </div>
                : <>
                  <div className="metadata-track-form">
                    <MetaField id={`${id}-track-name`} label="名称"><input id={`${id}-track-name`} className="input" value={track.title} maxLength={200} onChange={event => editTrack({ title: event.target.value })} /></MetaField>
                    <MetaField id={`${id}-track-lang`} label="语言"><input id={`${id}-track-lang`} className="input" list={`${id}-languages`} value={track.language} placeholder="如 zh-CN、en、jpn" onChange={event => editTrack({ language: event.target.value })} /></MetaField>
                    <datalist id={`${id}-languages`}>{LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</datalist>
                    <div className="metadata-track-switches">
                      <label className="check"><input type="checkbox" checked={track.default} onChange={event => editTrack({ default: event.target.checked })} />播放时默认使用这条字幕</label>
                      <Button size="sm" variant="ghost" icon="trash" onClick={removeTrack}>移除</Button>
                    </div>
                  </div>
                  <div className="metadata-text-head">{textTools}<TextState source={!track.id ? "new" : track.textChanged ? "changed" : "metadata"} /></div>
                  <textarea aria-label="字幕内容" className="input metadata-text-area" disabled={reading} value={reading ? "正在读取…" : track.text ?? ""} onChange={event => useText(event.target.value)}
                    placeholder="输入或粘贴 SRT、WebVTT、ASS 字幕；也可以在线查找、上传或从同目录导入。" />
                  <TextStats text={track.text ?? ""} kind="subtitle" />
                </>}
            </div>
          </div>}
        </fieldset>
      </>}
    </div>
    {lookup === "text" && <MediaLookupDialog file={file} want={textKey} onClose={() => setLookup(null)} onPickText={(text, details) => { useText(text, details?.language, details?.title); setLookup(null); }} />}
    {lookup === "info" && <MediaInfoLookupDialog file={file} current={fields} onClose={() => setLookup(null)}
      onApply={values => { setFields(current => ({ ...current, ...values })); setLookup(null); toast.success(`已填入 ${Object.keys(values).length} 项，保存后生效`); }} />}
    {discard && <ConfirmDialog title="放弃未保存的元数据？" description="当前元数据修改尚未保存。" confirmLabel="放弃修改" onClose={() => setDiscard(false)} onConfirm={onClose} />}
    {pendingTab && <ConfirmDialog title="放弃未保存的封面？" description="切换页面会丢弃刚选择的图片，其他元数据修改会保留。" confirmLabel="放弃封面" onClose={() => setPendingTab(null)} onConfirm={() => { setCoverDirty(false); setTab(pendingTab); setPendingTab(null); }} />}
  </Modal>;
}

function MetaField({ id, label, wide, changed, onRevert, children }: { id: string; label: string; wide?: boolean; changed?: boolean; onRevert?: () => void; children: ReactNode }) {
  return <div className={`metadata-field${wide ? " is-wide" : ""}${changed ? " is-changed" : ""}`}>
    <div className="metadata-field-label"><label htmlFor={id}>{label}</label>
      {changed && onRevert && <button type="button" className="metadata-revert" onClick={onRevert}>还原</button>}</div>
    {children}
  </div>;
}

/** 歌词或字幕的来源：已保存的元数据、文件内置（未另存）、新增或已修改。 */
function TextState({ source }: { source: string }) {
  const [tone, label] = source === "changed" ? ["accent", "已修改，未保存"] as const : source === "new" ? ["accent", "新增，未保存"] as const
    : source === "metadata" ? ["success", "已保存"] as const : source === "embedded" ? ["neutral", "文件内置，未另存"] as const : ["neutral", "空"] as const;
  return <Badge tone={tone} dot>{label}</Badge>;
}

function TextStats({ text, kind }: { text: string; kind: "lyrics" | "subtitle" }) {
  const bytes = new TextEncoder().encode(text).length;
  const lines = text ? text.split("\n").filter(line => line.trim()).length : 0;
  const detail = kind === "lyrics" ? (/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(text) ? "同步歌词（LRC）" : text.trim() ? "纯文本歌词" : "")
    : `${(text.match(/-->/g) ?? []).length} 条字幕`;
  return <p className={`metadata-text-stats${bytes > TEXT_LIMIT ? " is-over" : ""}`}>
    {[lines ? `${lines} 行` : "", detail, `${formatBytes(bytes)} / 2 MB`].filter(Boolean).join(" · ")}
    <span>保存在用户隐藏空间并计入配额。</span>
  </p>;
}
