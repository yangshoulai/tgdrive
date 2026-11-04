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

/** 查询条件与结果；打开时先按文件信息自动查找一次。 */
function useLookup(file: api.FileItem, want: api.MediaWant) {
  const [fields, setFields] = useState<Fields>(emptyFields);
  const [result, setResult] = useState<api.MediaLookup | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  async function search(overrides?: Partial<api.MediaQueryFields>) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError("");
    try {
      const value = await api.mediaLookup(file.key, want, overrides, undefined, controller.signal);
      if (controller.signal.aborted) return;
      setResult(value);
      if (!overrides) setFields(fieldsOf(value.query));
    } catch (reason) {
      if (!controller.signal.aborted) setError(api.errorMessage(reason, `查找${WANT_LABELS[want]}失败，请稍后重试`));
    } finally { if (request.current === controller) { request.current = null; setLoading(false); } }
  }
  useEffect(() => { void search(); return () => request.current?.abort(); }, [file.key, file.etag, want]);  // eslint-disable-line react-hooks/exhaustive-deps
  return { fields, setFields, result, loading, error, search };
}
type Lookup = ReturnType<typeof useLookup>;

function QueryForm({ lookup, kind, want }: { lookup: Lookup; kind: "audio" | "video"; want: api.MediaWant }) {
  const id = useId();
  const { fields, setFields, loading } = lookup;
  const change = (patch: Partial<Fields>) => setFields(current => ({ ...current, ...patch }));
  const submit = (event: FormEvent) => { event.preventDefault(); event.stopPropagation(); if (fields.title.trim()) void lookup.search(overridesOf(fields, kind)); };
  const input = (key: keyof Fields, label: string, placeholder = "", wide = false) => <label className={`media-lookup-field${wide ? " is-wide" : ""}`} htmlFor={`${id}-${key}`}>
    <span>{label}</span>
    <input id={`${id}-${key}`} className="input" value={fields[key]} placeholder={placeholder} disabled={loading && !lookup.result}
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

/** 各来源的查找情况：数量或失败原因。 */
function ProviderStatus({ result, want }: { result: api.MediaLookup | null; want: api.MediaWant }) {
  if (!result) return null;
  const remote = result.providers.filter(item => item.id !== "embedded");
  if (!remote.length && !result.providers.length) return <Notice tone="warning">管理员还没有开启能提供{WANT_LABELS[want]}的来源，可以请管理员在「系统设置 → 媒体信息」中开启。</Notice>;
  return <ul className="media-lookup-sources" aria-label="查找来源">
    {result.providers.filter(item => item.id !== "embedded" || item.count || item.error).map(item => <li key={item.id} className={item.error ? "is-failed" : ""} title={item.error ?? undefined}>
      <Icon name={item.error ? "alert" : "check"} size={13} />
      <span>{item.name}</span><small>{item.error ? item.error : `${item.count} 个`}</small>
    </li>)}
  </ul>;
}

function providerName(result: api.MediaLookup, id: string) {
  return result.providers.find(item => item.id === id)?.name ?? id;
}

/** 歌词、字幕：选择一项查看内容，保存为媒体同目录的同名文件。 */
export function MediaLookupDialog({ file, want, onClose }: { file: api.FileItem; want: "lyrics" | "subtitle"; onClose: () => void }) {
  const kind = want === "lyrics" ? "audio" : "video";
  const lookup = useLookup(file, want);
  const { result } = lookup;
  const [selected, setSelected] = useState<api.MediaCandidate | null>(null);
  const [content, setContent] = useState<Record<string, { text?: string; format?: string | null; error?: string }>>({});
  const [language, setLanguage] = useState("");
  const [saving, setSaving] = useState(false), [conflict, setConflict] = useState<string | null>(null);
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
  useEffect(() => { const first = result?.candidates.find(item => item.score > 0) ?? null; choose(first); }, [result]);  // eslint-disable-line react-hooks/exhaustive-deps

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
    setSaving(true);
    try {
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
      {selected && <span className="media-lookup-target" title={target}>保存为 <strong>{target}</strong></span>}
      <Button variant="ghost" disabled={saving} onClick={onClose}>取消</Button>
      <Button variant="primary" icon="check" loading={saving} disabled={!selected || !shown?.text} onClick={() => void save()}>保存{WANT_LABELS[want]}</Button>
    </>}>
    <div className="media-lookup-body">
      <QueryForm lookup={lookup} kind={kind} want={want} />
      <ProviderStatus result={result} want={want} />
      {lookup.error && <Notice tone="danger">{lookup.error}</Notice>}
      <div className="media-lookup-split">
        <div className="media-lookup-results" role="listbox" aria-label={`${WANT_LABELS[want]}候选`}>
          {lookup.loading && !result ? <SkeletonRows rows={5} />
            : result && !result.candidates.length ? <EmptyState compact icon="search" title={`没有找到${WANT_LABELS[want]}`} description="可以修改歌名、片名等查询条件后重新查找。" />
            : result?.candidates.map(candidate => <button type="button" role="option" key={candidate.token} aria-selected={selected?.token === candidate.token}
              className={`media-lookup-item${selected?.token === candidate.token ? " is-selected" : ""}`} disabled={candidate.score <= 0 && candidate.provider === "embedded"}
              onClick={() => choose(candidate)}>
              <span className="media-lookup-item-head">
                <strong title={candidate.title}>{candidate.title || "（无标题）"}</strong>
                <span className="media-lookup-score" title="匹配度">{percent(candidate.score)}</span>
              </span>
              {candidate.subtitle && <span className="media-lookup-item-sub" title={candidate.subtitle}>{candidate.subtitle}</span>}
              <span className="media-lookup-tags">
                <Badge tone={candidate.provider === "embedded" ? "accent" : "neutral"}>{providerName(result, candidate.provider)}</Badge>
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
      <p className="media-lookup-hint">{want === "lyrics" ? "歌词保存为与音乐同名的 .lrc 文件，放在同一文件夹，播放时自动加载。" : "字幕保存为与视频同名的 .srt 或 .vtt 文件，放在同一文件夹，播放时可在字幕菜单里选择。"}
        查询由服务器发给所选来源，只包含查询条件{want === "subtitle" ? "与用于匹配版本的文件特征值" : ""}，不发送文件内容。</p>
    </div>
    {conflict && <ConfirmDialog title="替换已有的文件？" confirmLabel="替换" description={`${conflict}。替换后原来的内容会被覆盖。`}
      onClose={() => setConflict(null)} onConfirm={async () => { setConflict(null); await save(true); }} />}
  </Modal>;
}

/** 封面候选：嵌在「设置封面」里，选中后把图片交给封面编辑器按普通流程保存。 */
export function MediaCoverSearch({ file, disabled, onPick }: { file: api.FileItem; disabled?: boolean; onPick: (image: Blob, name: string) => Promise<void> | void }) {
  const kind = getFileKind(file.content_type, file.key) === "video" ? "video" : "audio";
  const lookup = useLookup(file, "cover");
  const { result } = lookup;
  const [picking, setPicking] = useState(""), [error, setError] = useState(""), [broken, setBroken] = useState<Set<string>>(new Set());
  async function pick(candidate: api.MediaCandidate) {
    if (picking) return;
    setPicking(candidate.token); setError("");
    try {
      const image = await api.mediaFetchImage(file.key, candidate.token);
      await onPick(image, `${providerName(result!, candidate.provider)}：${candidate.title}`);
    } catch (reason) { setError(api.errorMessage(reason, "这张封面没有读取出来，请换一张")); }
    finally { setPicking(""); }
  }
  const visible = result?.candidates.filter(item => !broken.has(item.token)) ?? [];
  return <div className="media-cover-search">
    <QueryForm lookup={lookup} kind={kind} want="cover" />
    <ProviderStatus result={result} want="cover" />
    {(lookup.error || error) && <Notice tone="danger">{lookup.error || error}</Notice>}
    {lookup.loading && !result ? <div className="media-cover-grid is-loading" aria-label="正在查找">{Array.from({ length: 6 }, (_, index) => <span key={index} className="media-cover-tile is-skeleton" />)}</div>
      : result && !visible.length ? <EmptyState compact icon="image" title="没有找到封面" description="可以修改查询条件后重新查找，或改用本地图片。" />
      : <div className="media-cover-grid" role="list">
        {visible.map(candidate => <button type="button" role="listitem" key={candidate.token} className={`media-cover-tile${picking === candidate.token ? " is-picking" : ""}`}
          disabled={disabled || Boolean(picking)} title={[candidate.title, candidate.subtitle, candidate.note].filter(Boolean).join("\n")} onClick={() => void pick(candidate)}>
          <img src={api.mediaPreviewUrl(file.key, candidate.token)} alt="" loading="lazy" onError={() => setBroken(current => new Set(current).add(candidate.token))} />
          <span className="media-cover-caption"><strong>{candidate.title}</strong><small>{providerName(result!, candidate.provider)}{candidate.note ? ` · ${candidate.note}` : ""}</small></span>
          {picking === candidate.token && <span className="spinner" aria-label="正在读取" />}
        </button>)}
      </div>}
  </div>;
}
