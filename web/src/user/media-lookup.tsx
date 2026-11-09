import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import * as api from "../api";
import { baseName, getFileKind, parentPath } from "../files";
import { Badge, Button, ConfirmDialog, EmptyState, Icon, Modal, Notice, SkeletonRows, toast } from "../ui";

/** 在线查找封面、歌词与字幕（约定见 AGENTS.md「媒体元数据」）。
 *  查询条件先用文件自带的标签（没有时用文件名推断），可以改写后重新查找；结果按匹配度排序，标明来源。
 *  所有第三方请求都由服务器发出，浏览器只拿到候选的短期令牌，封面小图也经服务器读取。 */

const WANT_LABELS: Record<api.MediaWant, string> = { cover: "封面", lyrics: "歌词", subtitle: "字幕" };
const LANGUAGES: { value: string; label: string }[] = [
  { value: "", label: "不标注语言" }, { value: "zh-CN", label: "简体中文（zh-CN）" }, { value: "zh-TW", label: "繁体中文（zh-TW）" },
  { value: "zh", label: "中文（zh）" }, { value: "en", label: "英语（en）" }, { value: "ja", label: "日语（ja）" }, { value: "ko", label: "韩语（ko）" },
];
const SEARCH_LANGUAGES: { value: string; label: string; codes: string[] }[] = [
  { value: "zh", label: "中文优先", codes: ["zh", "en"] }, { value: "en", label: "英文优先", codes: ["en", "zh"] },
  { value: "ja", label: "日文优先", codes: ["ja", "zh", "en"] }, { value: "ko", label: "韩文优先", codes: ["ko", "zh", "en"] },
];

type Fields = { title: string; artist: string; album: string; year: string; season: string; episode: string; language: string };
const emptyFields: Fields = { title: "", artist: "", album: "", year: "", season: "", episode: "", language: "zh" };

function fieldsOf(query: api.MediaQueryFields): Fields {
  return { title: query.title, artist: query.artist, album: query.album, year: query.year,
    season: query.season == null ? "" : String(query.season), episode: query.episode == null ? "" : String(query.episode),
    language: SEARCH_LANGUAGES.find(item => item.codes[0] === query.languages[0])?.value ?? "zh" };
}
function overridesOf(fields: Fields, kind: "audio" | "video"): Partial<api.MediaQueryFields> {
  const number = (value: string) => /^\d{1,4}$/.test(value.trim()) ? Number(value.trim()) : null;
  return kind === "audio" ? { title: fields.title, artist: fields.artist, album: fields.album }
    : { title: fields.title, year: fields.year, season: number(fields.season), episode: number(fields.episode),
      languages: SEARCH_LANGUAGES.find(item => item.value === fields.language)?.codes ?? ["zh", "en"] };
}
export function languageTag(value: string | null): string {
  const code = (value ?? "").toLowerCase();
  if (/^(zh-cn|zh-hans|chs|chi|zho)$/.test(code)) return "zh-CN";
  if (/^(zh-tw|zh-hk|zh-hant|cht)$/.test(code)) return "zh-TW";
  if (code === "zh") return "zh";
  if (/^(en|eng)$/.test(code)) return "en";
  if (/^(ja|jpn)$/.test(code)) return "ja";
  if (/^(ko|kor)$/.test(code)) return "ko";
  return "";
}
const percent = (value: number) => `${Math.round(value * 100)}%`;
const timeText = (seconds: number | null) => seconds == null ? "" : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

type Source = { id: string; name: string; state: "loading" | "done" | "failed"; count: number; error: string | null };
const EMBEDDED = { id: "embedded", name: "内置数据" };
function embeddedFor(info: api.MediaInfo, want: api.MediaWant) {
  return info.embedded && (want === "cover" ? info.cover : want === "lyrics" ? Boolean(info.lyrics) : info.subtitles.some(item => item.text));
}

/** 查询条件与结果；打开时先按文件信息自动查找一次。每个来源单独请求，先返回的先显示，不等最慢的来源。 */
function useLookup(file: api.FileItem, want: api.MediaWant) {
  const [fields, setFields] = useState<Fields>(emptyFields);
  const [sources, setSources] = useState<Source[]>([]);
  const [candidates, setCandidates] = useState<api.MediaCandidate[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [ready, setReady] = useState(false);
  const request = useRef<AbortController | null>(null);
  const providers = useRef<{ id: string; name: string }[] | null>(null);
  async function search(overrides?: Partial<api.MediaQueryFields>) {
    request.current?.abort();
    const controller = new AbortController(), signal = controller.signal;
    request.current = controller;
    setLoading(true); setError(""); setCandidates([]);
    try {
      if (!providers.current) {
        const info = await api.mediaInfo(file.key, signal);
        // 封面的内置图片在「设置封面 → 内置封面」里单独提供，在线查找只列第三方来源。
        providers.current = [...(want !== "cover" && embeddedFor(info, want) ? [EMBEDDED] : []), ...info.providers[want].filter(item => want !== "cover" || item.id !== "embedded")];
      }
      const list = providers.current;
      const order = new Map(list.map((item, index) => [item.id, index]));
      setSources(list.map(item => ({ ...item, state: "loading", count: 0, error: null })));
      let filled = Boolean(overrides);
      await Promise.all(list.map(async item => {
        const update = (patch: Partial<Source>) => setSources(current => current.map(source => source.id === item.id ? { ...source, ...patch } : source));
        try {
          const value = await api.mediaLookup(file.key, want, overrides, [item.id], signal);
          if (signal.aborted) return;
          if (!filled) { filled = true; setFields(fieldsOf(value.query)); }
          const status = value.providers[0];
          update({ state: status?.error ? "failed" : "done", count: value.candidates.length, error: status?.error ?? null });
          // 内置数据排最前，其余按匹配度，同分时按来源顺序。
          setCandidates(current => [...current, ...value.candidates].sort((a, b) => Number(b.provider === "embedded") - Number(a.provider === "embedded")
            || Math.round(b.score * 100) - Math.round(a.score * 100) || (order.get(a.provider) ?? 0) - (order.get(b.provider) ?? 0)));
        } catch (reason) {
          if (!signal.aborted) update({ state: "failed", error: api.errorMessage(reason, "查询失败") });
        }
      }));
    } catch (reason) {
      if (!signal.aborted) setError(api.errorMessage(reason, `查找${WANT_LABELS[want]}失败，请稍后重试`));
    } finally { if (request.current === controller) { request.current = null; setLoading(false); setReady(true); } }
  }
  useEffect(() => { providers.current = null; void search(); return () => request.current?.abort(); }, [file.key, file.etag, want]);  // eslint-disable-line react-hooks/exhaustive-deps
  const nameOf = (id: string) => sources.find(item => item.id === id)?.name ?? id;
  return { fields, setFields, sources, candidates, loading, ready, error, search, nameOf };
}
type Lookup = ReturnType<typeof useLookup>;

function QueryForm({ lookup, kind, want }: { lookup: Lookup; kind: "audio" | "video"; want: api.MediaWant }) {
  const id = useId();
  const { fields, setFields, loading } = lookup;
  const change = (patch: Partial<Fields>) => setFields(current => ({ ...current, ...patch }));
  const submit = (event: FormEvent) => { event.preventDefault(); event.stopPropagation(); if (fields.title.trim()) void lookup.search(overridesOf(fields, kind)); };
  const input = (key: keyof Fields, label: string, placeholder = "", wide = false) => <label className={`media-lookup-field${wide ? " is-wide" : ""}`} htmlFor={`${id}-${key}`}>
    <span>{label}</span>
    <input id={`${id}-${key}`} className="input" value={fields[key]} placeholder={placeholder} disabled={loading && !fields.title && !lookup.ready}
      inputMode={key === "year" || key === "season" || key === "episode" ? "numeric" : undefined} onChange={event => change({ [key]: event.target.value })} />
  </label>;
  return <form className="media-lookup-query" onSubmit={submit} aria-label="查询条件">
    {kind === "audio" ? <>{input("title", "歌名", "", true)}{input("artist", "歌手")}{input("album", "专辑")}</>
      : <>{input("title", "片名", "", true)}{input("year", "年份", "如 2010")}{input("season", "季", "")}{input("episode", "集", "")}
        {want === "subtitle" && <label className="media-lookup-field" htmlFor={`${id}-language`}><span>字幕语言</span>
          <select id={`${id}-language`} className="input" value={fields.language} onChange={event => change({ language: event.target.value })}>
            {SEARCH_LANGUAGES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select></label>}</>}
    <Button type="submit" icon="search" loading={loading} disabled={!fields.title.trim()}>查找</Button>
  </form>;
}

/** 各来源的查找情况：查询中、数量或失败原因。 */
function ProviderStatus({ lookup, want }: { lookup: Lookup; want: api.MediaWant }) {
  if (lookup.ready && !lookup.sources.length && !lookup.error) return <Notice tone="warning">管理员还没有开启能提供{WANT_LABELS[want]}的来源，可以请管理员在「系统设置 → 媒体信息」中开启。</Notice>;
  if (!lookup.sources.length) return null;
  return <ul className="media-lookup-sources" aria-label="查找来源">
    {lookup.sources.filter(item => item.id !== "embedded" || item.state !== "done" || item.count).map(item => <li key={item.id} className={`is-${item.state}`} title={item.error ?? undefined}>
      {item.state === "loading" ? <span className="spinner spinner-xs" aria-hidden="true" /> : <Icon name={item.state === "failed" ? "alert" : "check"} size={13} />}
      <span>{item.name}</span><small>{item.state === "loading" ? "查询中" : item.state === "failed" ? item.error : `${item.count} 个`}</small>
    </li>)}
  </ul>;
}

/** 歌词、字幕：选择一项查看内容，保存为媒体同目录的同名文件。 */
export function MediaLookupDialog({ file, want, onClose, onPickLyrics }: { file: api.FileItem; want: "lyrics" | "subtitle"; onClose: () => void; onPickLyrics?: (text: string) => void }) {
  const kind = want === "lyrics" ? "audio" : "video";
  const lookup = useLookup(file, want);
  const { candidates } = lookup;
  const [selected, setSelected] = useState<api.MediaCandidate | null>(null);
  const [content, setContent] = useState<Record<string, { text?: string; format?: string | null; error?: string }>>({});
  const [language, setLanguage] = useState("");
  const [saving, setSaving] = useState(false), [conflict, setConflict] = useState<string | null>(null);
  const [editInfo, setEditInfo] = useState<api.AudioEditInfo | null>(null);
  const [saveMode, setSaveMode] = useState<"embedded" | "file" | null>(null), [saveStatus, setSaveStatus] = useState("");
  const embedded = want === "lyrics" && (saveMode ?? (editInfo?.editable ? "embedded" : "file")) === "embedded";
  useEffect(() => {
    if (want !== "lyrics" || onPickLyrics) return;
    const controller = new AbortController();
    void api.audioEditInfo(file.key, controller.signal).then(setEditInfo).catch(() => undefined);
    return () => controller.abort();
  }, [file.key, want]);
  const reading = useRef<AbortController | null>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => () => reading.current?.abort(), []);
  useEffect(() => {
    if (!api.isPrivatePath(file.key)) return;
    const locked = () => close.current();
    window.addEventListener("tessera:private-locked", locked);
    return () => window.removeEventListener("tessera:private-locked", locked);
  }, [file.key]);
  // 新的结果到达时默认选中第一项（匹配度最高）。
  // 结果陆续到达：还没有选中（或选中的已不在新结果里）时选中匹配度最高的一项。
  useEffect(() => {
    if (selected && candidates.some(item => item.token === selected.token)) return;
    choose(candidates.find(item => item.score > 0) ?? null);
  }, [candidates]);  // eslint-disable-line react-hooks/exhaustive-deps

  function choose(candidate: api.MediaCandidate | null) {
    setSelected(candidate);
    setLanguage(want === "subtitle" && candidate ? languageTag(candidate.language) : "");
    if (!candidate || content[candidate.token]) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    void api.mediaFetchText(file.key, candidate.token, controller.signal)
      .then(value => setContent(current => ({ ...current, [candidate.token]: { text: value.text, format: value.format } })))
      .catch(reason => { if (!controller.signal.aborted) setContent(current => ({ ...current, [candidate.token]: { error: api.errorMessage(reason, "内容没有读取出来") } })); });
  }
  const shown = selected ? content[selected.token] : undefined;
  const stem = baseName(file.key).replace(/\.[^.]+$/, "");
  const extension = want === "lyrics" ? "lrc" : shown?.format === "vtt" ? "vtt" : "srt";
  const target = `${stem}${language ? `.${language}` : ""}.${extension}`;

  async function save(overwrite = false) {
    if (!selected || saving) return;
    if (onPickLyrics && shown?.text) { onPickLyrics(shown.text); return; }
    setSaving(true);
    try {
      if (embedded && shown?.text && editInfo) {
        await api.saveAudioMetadata({ ...file, etag: editInfo.etag }, { lyrics: shown.text }, "keep", undefined, job => setSaveStatus(job.detail));
        toast.success("歌词已写入音频文件"); onClose(); return;
      }
      const saved = await api.mediaSave(file.key, selected.token, language, overwrite);
      api.announceMediaAssets(file.key, saved.path);
      window.dispatchEvent(new CustomEvent("tessera:files-added", { detail: { folders: [parentPath(file.key)] } }));
      toast.success(`${saved.replaced ? "已替换" : "已保存"}「${saved.name}」`);
      onClose();
    } catch (reason) {
      if (reason instanceof api.ApiError && reason.code === "asset_exists") setConflict(reason.message);
      else toast.error(api.errorMessage(reason, "保存失败，请稍后重试"));
    } finally { setSaving(false); }
  }

  return <Modal title={`在线查找${WANT_LABELS[want]}`} description={baseName(file.key)} icon="search" size="lg"
    className={`media-lookup${api.isPrivatePath(file.key) ? " private-dialog" : ""}`} onClose={() => { if (!saving) onClose(); }} dismissible={!saving}
    footer={<>
      {selected && !onPickLyrics && <span className="media-lookup-target" title={embedded ? baseName(file.key) : target}>{embedded ? "写入" : "保存为"} <strong>{embedded ? baseName(file.key) : target}</strong></span>}
      <Button variant="ghost" disabled={saving} onClick={onClose}>取消</Button>
      <Button variant="primary" icon="check" loading={saving} disabled={!selected || !shown?.text} onClick={() => void save()}>{onPickLyrics ? "使用这份歌词" : embedded ? "写入音频" : `保存${WANT_LABELS[want]}`}</Button>
    </>}>
    <div className="media-lookup-body">
      <QueryForm lookup={lookup} kind={kind} want={want} />
      <ProviderStatus lookup={lookup} want={want} />
      {saving && saveStatus && <Notice>{saveStatus}</Notice>}
      {want === "lyrics" && !onPickLyrics && <label className="media-lookup-field">
        <span>保存方式</span>
        <select className="input" value={embedded ? "embedded" : "file"} disabled={saving} onChange={event => setSaveMode(event.target.value as "embedded" | "file")}>
          <option value="embedded" disabled={!editInfo?.editable}>写入音频文件（推荐）</option>
          <option value="file">另存为同目录 .lrc 文件</option>
        </select>
        {!editInfo?.editable && <small>内置歌词支持 MP3、FLAC、M4A，服务器需安装 FFmpeg。</small>}
      </label>}
      {lookup.error && <Notice tone="danger">{lookup.error}</Notice>}
      <div className="media-lookup-split">
        <div className="media-lookup-results" role="listbox" aria-label={`${WANT_LABELS[want]}候选`}>
          {lookup.loading && !candidates.length ? <SkeletonRows rows={5} />
            : !candidates.length ? <EmptyState compact icon="search" title={`没有找到${WANT_LABELS[want]}`} description="可以修改歌名、片名等查询条件后重新查找。" />
            : candidates.map(candidate => <button type="button" role="option" key={candidate.token} aria-selected={selected?.token === candidate.token}
              className={`media-lookup-item${selected?.token === candidate.token ? " is-selected" : ""}`} disabled={candidate.score <= 0 && candidate.provider === "embedded"}
              onClick={() => choose(candidate)}>
              <span className="media-lookup-item-head">
                <strong title={candidate.title}>{candidate.title || "（无标题）"}</strong>
                <span className="media-lookup-score" title="匹配度">{percent(candidate.score)}</span>
              </span>
              {candidate.subtitle && <span className="media-lookup-item-sub" title={candidate.subtitle}>{candidate.subtitle}</span>}
              <span className="media-lookup-tags">
                <Badge tone={candidate.provider === "embedded" ? "accent" : "neutral"}>{lookup.nameOf(candidate.provider)}</Badge>
                {candidate.hash_match && <Badge tone="success" icon="check">版本匹配</Badge>}
                {want === "lyrics" && candidate.synced !== null && <Badge tone={candidate.synced ? "success" : "warning"}>{candidate.synced ? "同步歌词" : "没有时间轴"}</Badge>}
                {candidate.language && <Badge>{candidate.language}</Badge>}
                {candidate.duration != null && <Badge>{timeText(candidate.duration)}</Badge>}
              </span>
              {candidate.note && <span className="media-lookup-item-note">{candidate.note}</span>}
            </button>)}
        </div>
        <div className="media-lookup-preview" aria-live="polite">
          {!selected ? <EmptyState compact icon="fileText" title="选择一项查看内容" />
            : !shown ? <SkeletonRows rows={8} />
            : shown.error ? <Notice tone="danger">{shown.error}</Notice>
            : <pre className="media-lookup-text">{shown.text}</pre>}
        </div>
      </div>
      {want === "subtitle" && selected && <label className="media-lookup-field media-lookup-save-language">
        <span>字幕语言标记</span>
        <select className="input" value={language} onChange={event => setLanguage(event.target.value)}>
          {LANGUAGES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <small>写进文件名，播放器按它显示字幕语言；同一视频可以保存多种语言的字幕。</small>
      </label>}
      <p className="media-lookup-hint">{want === "lyrics" ? onPickLyrics ? "选中的歌词先填入编辑窗口，点击「保存到音频」后才写入文件。" : embedded ? "歌词直接内置到音频中，不生成额外文件，也不会重新编码音频。" : "歌词保存为与音乐同名的 .lrc 文件，放在同一文件夹，播放时自动加载。" : "字幕保存为与视频同名的 .srt 或 .vtt 文件，放在同一文件夹，播放时可在字幕菜单里选择。"}
        查询由服务器发给所选来源，只包含查询条件{want === "subtitle" ? "与用于匹配版本的文件特征值" : ""}，不发送文件内容。</p>
    </div>
    {conflict && <ConfirmDialog title="替换已有的文件？" confirmLabel="替换" description={`${conflict}。替换后原来的内容会被覆盖。`}
      onClose={() => setConflict(null)} onConfirm={async () => { setConflict(null); await save(true); }} />}
  </Modal>;
}

/** 封面候选：嵌在「设置封面」里。点一张立即交给封面编辑器（先显示小图、后台读取原图），不必等其他图片或来源加载完。 */
export function MediaCoverSearch({ file, selected, disabled, onPick }: { file: api.FileItem; selected?: string; disabled?: boolean;
  onPick: (candidate: api.MediaCandidate, preview: string, label: string) => void }) {
  const kind = getFileKind(file.content_type, file.key) === "video" ? "video" : "audio";
  const lookup = useLookup(file, "cover");
  const [broken, setBroken] = useState<Set<string>>(new Set()), [loaded, setLoaded] = useState<Set<string>>(new Set());
  const visible = lookup.candidates.filter(item => !broken.has(item.token));
  const pending = lookup.sources.filter(item => item.state === "loading").length;
  const mark = (set: typeof setLoaded, token: string) => set(current => current.has(token) ? current : new Set(current).add(token));
  return <div className="media-cover-search">
    <QueryForm lookup={lookup} kind={kind} want="cover" />
    <ProviderStatus lookup={lookup} want="cover" />
    {lookup.error && <Notice tone="danger">{lookup.error}</Notice>}
    {lookup.ready && !lookup.loading && !lookup.sources.length && !lookup.error
      ? <EmptyState compact icon="search" title="没有可用的在线来源" description="管理员还没有在「系统设置 → 媒体信息」开启封面来源，可以改用内置封面、本地图片或网络图片。" />
      : lookup.ready && !lookup.loading && !visible.length && lookup.sources.length > 0
      ? <EmptyState compact icon="image" title="没有找到封面" description={kind === "video" ? "可以把片名改成中文或英文原名、补上年份后重新查找，或改用本地图片。" : "可以修改歌名、歌手后重新查找，或改用本地图片。"} />
      : <div className="media-cover-grid" role="listbox" aria-label="封面候选" aria-busy={pending > 0}>
        {visible.map(candidate => {
          const preview = api.mediaPreviewUrl(file.key, candidate.token), label = `${lookup.nameOf(candidate.provider)}：${candidate.title}`;
          const details = [candidate.subtitle, candidate.note].filter(Boolean).join(" · ");
          return <button type="button" role="option" aria-selected={selected === candidate.token} key={candidate.token}
            className={`media-cover-tile${selected === candidate.token ? " is-selected" : ""}${loaded.has(candidate.token) ? " is-loaded" : ""}`}
            disabled={disabled} title={[candidate.title, details].filter(Boolean).join("\n")} onClick={() => onPick(candidate, preview, label)}>
            <span className="media-cover-art">
              <img src={preview} alt="" loading="lazy" decoding="async" onLoad={() => mark(setLoaded, candidate.token)} onError={() => mark(setBroken, candidate.token)} />
              <span className="media-cover-source">{lookup.nameOf(candidate.provider)}</span>
              {selected === candidate.token && <span className="media-cover-check"><Icon name="check" size={14} /></span>}
            </span>
            <span className="media-cover-caption"><strong>{candidate.title || "（无标题）"}</strong>{details && <small>{details}</small>}</span>
          </button>;
        })}
        {pending > 0 && Array.from({ length: visible.length ? 2 : 8 }, (_, index) => <span key={`skeleton-${index}`} className="media-cover-tile is-skeleton" aria-hidden="true">
          <span className="media-cover-art" /><span className="media-cover-caption"><i /><i /></span></span>)}
      </div>}
  </div>;
}
