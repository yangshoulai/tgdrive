import { useEffect, useId, useRef, useState, type ComponentProps, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as api from "../api";
import { baseName } from "../files";
import { bookCoverSource, createThumbnails, generateLoadedThumbnails, readEmbeddedCover, saveImageThumbnail, thumbnailSource } from "../thumbnails";
import { Button, Icon, Modal, Notice, Segmented, formatBytes, shortcutLabel, type IconName } from "../ui";
import { MediaCoverSearch } from "./media-lookup";

type Source = "embedded" | "local" | "url" | "capture" | "online";
export type PickedImage = { blob: Blob; url: string; name: string; width: number; height: number };
type Generating = { state: "running" | "failed"; detail: string };

/** 选择一张本地图片或读取图片地址（缩略图编辑器与离线下载的缩略图共用）。图片先在浏览器解码一次，
 *  格式不受支持时立即提示；图片地址由服务器经受控出站客户端读取。key 只用于选择普通或私密接口。 */
export function useImagePicker(key = "") {
  const [picked, setPicked] = useState<PickedImage | null>(null);
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const fetching = useRef<AbortController | null>(null);
  useEffect(() => () => { fetching.current?.abort(); }, []);
  useEffect(() => () => { if (picked) URL.revokeObjectURL(picked.url); }, [picked]);
  /** 检查并选中一张图片；返回选中的图片，无法解码时返回 null 并给出提示。 */
  async function accept(blob: Blob, name: string): Promise<PickedImage | null> {
    setError("");
    if (blob.type && !blob.type.startsWith("image/")) { setError("请选择图片文件"); return null; }
    const url = URL.createObjectURL(blob);
    try {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      const image = { blob, url, name, ...size };
      setPicked(image);
      return image;
    } catch {
      URL.revokeObjectURL(url);
      setError("无法读取这张图片，请换用 JPEG、PNG、WebP 或 GIF 格式");
      return null;
    }
  }
  async function load() {
    const value = address.trim();
    if (!value || loading) return;
    if (!/^https?:\/\//i.test(value)) { setError("图片地址必须以 http:// 或 https:// 开头"); return; }
    fetching.current?.abort();
    const controller = new AbortController();
    fetching.current = controller;
    setLoading(true); setError("");
    try {
      const blob = await api.fetchThumbnailImage({ key }, value, controller.signal);
      if (!controller.signal.aborted) await accept(blob, value.split(/[?#]/)[0].split("/").filter(Boolean).at(-1) || "网络图片");
    } catch (reason) {
      if (!controller.signal.aborted) setError(api.errorMessage(reason, "读取图片失败，请检查地址后重试"));
    } finally { if (fetching.current === controller) { fetching.current = null; setLoading(false); } }
  }
  return { picked, setPicked, address, setAddress, loading, error, setError, accept, load };
}
type ImagePicker = ReturnType<typeof useImagePicker>;

/** 本地图片按钮：点击选择或拖入。 */
export function LocalImageButton({ picker, disabled, dragging, onDragging, large }: { picker: ImagePicker; disabled?: boolean; dragging?: boolean; onDragging?: (value: boolean) => void;
  /** 大号拖放区（封面编辑器的「本地图片」面板） */ large?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <button type="button" className={`thumbnail-drop${large ? " is-large" : ""}${dragging ? " is-dragging" : ""}`} disabled={disabled}
    onClick={() => input.current?.click()} onDragOver={event => { event.preventDefault(); onDragging?.(true); }} onDragLeave={() => onDragging?.(false)}
    onDrop={event => {
      event.preventDefault(); onDragging?.(false);
      const image = [...event.dataTransfer.files].find(item => item.type.startsWith("image/"));
      if (image) { picker.setAddress(""); void picker.accept(image, image.name); } else picker.setError("请拖入一张图片");
    }}>
    <Icon name="upload" size={20} />
    <span><strong>{picker.picked && !picker.address ? "换一张图片" : "选择图片"}</strong><small>点击选择、拖入或直接粘贴（{shortcutLabel("Mod+V")}）</small></span>
    <input ref={input} type="file" accept="image/*" hidden onChange={event => {
      const image = event.target.files?.[0];
      event.target.value = "";
      if (image) { picker.setAddress(""); void picker.accept(image, image.name); }
    }} />
  </button>;
}

/** 图片地址输入框，回车或「读取」由服务器读取图片。 */
export function ImageUrlForm({ picker, disabled }: { picker: ImagePicker; disabled?: boolean }) {
  const id = useId();
  return <form className="thumbnail-url" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void picker.load(); }}>
    <label className="sr-only" htmlFor={`${id}-url`}>图片地址</label>
    <input id={`${id}-url`} className="input" type="url" inputMode="url" autoFocus placeholder="https://example.com/cover.jpg" value={picker.address} disabled={disabled}
      onChange={event => picker.setAddress(event.target.value)} />
    <Button type="submit" icon="download" loading={picker.loading} disabled={!picker.address.trim() || disabled}>读取</Button>
  </form>;
}

/** 较大的图片生成时可能要从存储读完整个文件，并按服务器内存评估；提示用户可能不会生成。 */
const LARGE_IMAGE = 64 * 1024 * 1024;

type OnlinePick = { token: string; preview: string; label: string; ready: Promise<PickedImage | null> };
type Embedded = { state: "loading" } | { state: "found"; blob: Blob } | { state: "none"; detail: string } | { state: "failed"; detail: string };
const SOURCES: Record<Source, { label: string; icon: IconName }> = {
  embedded: { label: "内置封面", icon: "box" }, local: { label: "本地图片", icon: "upload" }, url: { label: "网络图片", icon: "link" },
  capture: { label: "截图生成", icon: "camera" }, online: { label: "在线查找", icon: "search" },
};

/** 更新封面：来源依次是内置封面（音视频／书籍的图片）、本地图片、网络图片、截图生成（图片按原图缩放、视频截取画面）
 * 与在线查找（音视频，管理员启用的媒体信息来源）。任何文件都可以用本地或网络图片；图片在浏览器里缩放成三种规格后保存，
 * 原图不进入文件空间，网络图片由服务器代为读取。截图生成交给服务器（服务器没有 FFmpeg 时在这个页面读取文件生成）。 */
export function ThumbnailEditor({ file, onClose, onSaved, initialSource, inline, footerTarget, onSaveImage, onBusyChange, onDirtyChange, onCancelSave, saveHint }: { file: api.FileItem; onClose: () => void; onSaved: (variants: string[]) => void;
  inline?: boolean; footerTarget?: HTMLElement | null; onSaveImage?: (blob: Blob) => Promise<string[]>; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void; onCancelSave?: () => void; saveHint?: string;
  /** 打开时选中的来源（播放器里的「查找封面」直接打开在线查找）。 */ initialSource?: Source }) {
  const media = thumbnailSource(file.key, file.content_type, file.size);
  const book = bookCoverSource(file.key, file.content_type);
  const playable = media === "audio" || media === "video";
  const sources = (Object.keys(SOURCES) as Source[]).filter(item =>
    item === "embedded" ? playable || book : item === "online" ? playable : item === "capture" ? media === "image" || media === "video" : true);
  const [source, setSource] = useState<Source>(initialSource && sources.includes(initialSource) ? initialSource : sources[0]);
  const [generating, setGenerating] = useState<Generating | null>(null);
  const generation = useRef<AbortController | null>(null);
  const picker = useImagePicker(file.key);
  const { picked, setPicked, error, setError, accept } = picker;
  const [saving, setSaving] = useState(false);
  useEffect(() => { onBusyChange?.(saving); }, [saving, onBusyChange]);
  const [dragging, setDragging] = useState(false);
  const [embedded, setEmbedded] = useState<Embedded | null>(null);
  // 在线候选：点中后立即显示小图并在后台读取原图，保存时再等原图读完。
  const [onlinePick, setOnlinePick] = useState<OnlinePick | null>(null), [onlineLoading, setOnlineLoading] = useState(false);
  const latestPick = useRef("");
  useEffect(() => { onDirtyChange?.(source !== "embedded" && Boolean(picked || onlinePick)); }, [source, picked, onlinePick, onDirtyChange]);
  const close = useRef(onClose); close.current = onClose;
  const current = api.fileThumbnail(file, "poster");
  const video = media === "video";

  // 关闭窗口只停止在窗口里等待；已提交给服务器的生成继续，完成后文件列表自动更新。
  useEffect(() => () => { generation.current?.abort(); }, []);
  useEffect(() => {
    if (!api.isPrivatePath(file.key)) return;
    const locked = () => close.current();
    window.addEventListener("tessera:private-locked", locked);
    return () => window.removeEventListener("tessera:private-locked", locked);
  }, [file.key]);

  /** 内置封面只读一次：先由服务器按文件头读取，服务器读不到时在页面按范围读取（同样不读完整个文件）。 */
  const embeddedRead = useRef<AbortController | null>(null);
  useEffect(() => () => embeddedRead.current?.abort(), []);
  async function loadEmbedded() {
    if (embedded && embedded.state !== "failed") {
      if (embedded.state === "found") void accept(embedded.blob, "内置封面");
      return;
    }
    const controller = new AbortController();
    embeddedRead.current?.abort(); embeddedRead.current = controller;
    setEmbedded({ state: "loading" });
    let result: Embedded;
    try { result = { state: "found", blob: await api.embeddedCover(file.key, file.etag, controller.signal) }; }
    catch (reason) {
      if (controller.signal.aborted) return;
      const missing = reason instanceof api.ApiError && reason.status === 404;
      const local = missing || book ? null : await readEmbeddedCover(api.versionedContentUrl(api.contentUrl(file.key), file.etag, file.size), file.size, controller.signal).catch(() => null);
      if (controller.signal.aborted) return;
      result = local instanceof Blob ? { state: "found", blob: local }
        : missing || local === "none" ? { state: "none", detail: book ? "这本书没有可读取的封面图片" : "文件里没有嵌入封面图片" }
        : { state: "failed", detail: api.errorMessage(reason, "读取内置封面失败，请稍后重试") };
    }
    setEmbedded(result);
    if (result.state === "found" && !await accept(result.blob, "内置封面")) setEmbedded({ state: "failed", detail: "内置封面的格式浏览器无法显示" });
  }
  useEffect(() => { if (source === "embedded") void loadEmbedded(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  /** 切换来源：每个来源单独挑选，切走时丢弃上一个来源未保存的图片。 */
  function switchSource(next: Source) {
    if (next === source) return;
    setSource(next); setError(""); setPicked(null);
    latestPick.current = ""; setOnlinePick(null); setOnlineLoading(false);
    if (generating?.state === "failed") setGenerating(null);
    if (next === "embedded") void loadEmbedded();
  }

  function pickOnline(candidate: api.MediaCandidate, preview: string, label: string) {
    if (latestPick.current === candidate.token) return;
    latestPick.current = candidate.token;
    setError(""); setOnlineLoading(true);
    const ready = api.mediaFetchImage(file.key, candidate.token)
      .then(blob => latestPick.current === candidate.token ? accept(blob, label) : null)
      .catch(reason => {
        if (latestPick.current === candidate.token) { setError(api.errorMessage(reason, "这张封面没有读取出来，请换一张")); latestPick.current = ""; setOnlinePick(null); }
        return null;
      })
      .finally(() => { if (latestPick.current === candidate.token || !latestPick.current) setOnlineLoading(false); });
    setOnlinePick({ token: candidate.token, preview, label, ready });
  }

  async function save() {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const image = source === "online" && onlinePick && onlineLoading ? await onlinePick.ready : picked;
      if (!image) { setSaving(false); return; }
      onSaved(await (onSaveImage ? onSaveImage(image.blob) : saveImageThumbnail(file, image.blob)));
    }
    catch (reason) { setError(api.errorMessage(reason, "保存失败，请稍后重试")); setSaving(false); }
  }

  /** 截图生成：交给服务器（图片按原图缩放、视频在多个位置截取画面）。服务器先按自己的内存与读取速度评估，不适合时直接说明原因，
   *  不改在页面里读取原文件；只有服务器没有 FFmpeg 时才改在这个页面读取文件生成。 */
  async function generate() {
    if (!media || generation.current) return;
    const controller = new AbortController();
    generation.current = controller;
    setError(""); setGenerating({ state: "running", detail: "正在提交" });
    const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
    const nothing = video ? "截取的画面都是黑屏、白屏或细节太少，可以播放到喜欢的画面后在播放器里设为封面" : "没有生成成功，可以稍后重试，或换用本地图片";
    try {
      let local = false;
      try { await api.generateThumbnail(file, "capture"); }
      catch (reason) {
        if (!api.errorMessage(reason, "").includes("FFmpeg")) throw reason;
        local = true;
      }
      if (local) {
        setGenerating({ state: "running", detail: "服务器无法生成，正在这个页面读取文件生成" });
        const saved = await generateLoadedThumbnails(file, signal => createThumbnails({ url: api.versionedContentUrl(api.contentUrl(file.key), file.etag, file.size), size: file.size, signal }, media, "capture"), true, controller.signal);
        if (controller.signal.aborted) return;
        if (!saved || saved.includes("none")) throw new Error(nothing);
        onSaved(saved);
        return;
      }
      while (!controller.signal.aborted) {
        await wait(1500);
        if (controller.signal.aborted) return;
        const progress = await api.thumbnailProgress(file, controller.signal);
        if (progress.state === "done" || progress.state === "idle") {
          const state = (await api.thumbnailStatus([file.key], controller.signal)).files[file.key];
          if (state?.thumbnails?.includes("thumb")) { onSaved(state.thumbnails); return; }
          throw new Error(nothing);
        }
        if (progress.state === "failed" || progress.state === "cancelled") throw new Error(progress.detail || "生成失败，请稍后重试");
        setGenerating({ state: "running", detail: progress.state === "running" ? "正在生成" : progress.detail || "排队中" });
      }
    } catch (reason) {
      if (!controller.signal.aborted) setGenerating({ state: "failed", detail: api.errorMessage(reason, "生成失败，请稍后重试") });
    } finally { if (generation.current === controller) generation.current = null; }
  }

  async function stopGenerating() {
    generation.current?.abort(); generation.current = null;
    setGenerating(null);
    await api.cancelThumbnail(file).catch(() => undefined);
  }

  const drop = (event: DragEvent) => {
    event.preventDefault(); setDragging(false);
    const image = [...event.dataTransfer.files].find(item => item.type.startsWith("image/"));
    if (image) { if (source !== "local") switchSource("local"); void accept(image, image.name); }
    else {
      const link = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
      if (/^https?:\/\//i.test(link.trim())) { if (source !== "url") switchSource("url"); picker.setAddress(link.trim()); }
      else setError("请拖入一张图片");
    }
  };

  const choosing = source === "online" && onlinePick;
  // 在线候选读取原图期间先显示它的小图；其他来源显示已选的新图片，没有时显示当前封面。
  const fresh = choosing && onlineLoading ? { src: onlinePick.preview, tag: "正在读取原图…" }
    : picked && source !== "capture" ? { src: picked.url, tag: `${picked.width}×${picked.height} · ${formatBytes(picked.blob.size)}` } : null;
  const canSave = source === "online" ? Boolean(onlinePick || picked) : source !== "capture" && Boolean(picked);
  const switchTo = (next: Source) => <Button size="sm" variant="secondary" icon={SOURCES[next].icon} onClick={() => switchSource(next)}>{SOURCES[next].label}</Button>;
  const fallbacks = (...items: Source[]) => <div className="thumbnail-panel-actions">{items.filter(item => sources.includes(item)).map(item => <span key={item}>{switchTo(item)}</span>)}</div>;

  const stage = <div className="thumbnail-preview">
    <div className={`thumbnail-stage${dragging ? " is-dragging" : ""}${fresh ? " has-image" : ""}${playable ? " is-square" : ""}`}
      onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
      {fresh ? <img key={fresh.src} src={fresh.src} alt="新的封面预览" />
        : current ? <img key={current} src={current} alt="当前封面" />
        : <div className="thumbnail-stage-empty"><Icon name="image" size={28} /><span>还没有封面</span></div>}
      {(fresh || current) && <span className={`thumbnail-stage-tag${fresh ? "" : " is-current"}`}>
        {choosing && onlineLoading && <span className="spinner" aria-hidden="true" />}{fresh ? `新封面 · ${fresh.tag}` : "当前封面"}</span>}
    </div>
    {fresh && current && <div className="thumbnail-preview-before"><img src={current} alt="" /><span>当前封面<small>保存后替换</small></span></div>}
  </div>;

  let panel: ReactNode;
  if (source === "embedded") {
    const state = embedded ?? { state: "loading" as const };
    panel = <div className="thumbnail-panel">
      <PanelHead icon="box" title="使用文件里嵌入的封面" detail={book ? "读取电子书里的封面图片；漫画优先使用标记的封面，没有时使用按页码排序的第一张图片。" : media === "audio" ? "音乐文件常把专辑封面嵌在标签里，直接取出这张图片，不需要联网。" : "MP4、MKV 等视频可以带一张海报图片，直接取出使用，不会截取画面。"} />
      {state.state === "loading" ? <div className="thumbnail-status" role="status"><span className="spinner" aria-hidden="true" /><span><strong>正在读取内置封面</strong><small>{book ? "正在从书籍中寻找封面图片" : "只读取文件开头的标签与索引，不下载整个文件"}</small></span></div>
        : state.state === "found" ? <div className="thumbnail-status is-done" role="status"><Icon name="checkCircle" size={20} /><span><strong>找到了内置封面</strong>
          <small>{picked ? `${picked.width}×${picked.height} · ${formatBytes(picked.blob.size)}，` : ""}点「保存封面」即可使用</small></span></div>
        : <><div className={`thumbnail-status is-${state.state === "none" ? "empty" : "failed"}`} role="status"><Icon name={state.state === "none" ? "info" : "alert"} size={20} />
          <span><strong>{state.state === "none" ? "这个文件没有内置封面" : "没有读取到内置封面"}</strong><small>{state.detail}</small></span>
          {state.state === "failed" && <Button size="sm" variant="ghost" icon="refresh" onClick={() => void loadEmbedded()}>重试</Button>}</div>
          {fallbacks("online", "local", "capture")}</>}
    </div>;
  } else if (source === "local") {
    panel = <div className="thumbnail-panel">
      <PanelHead icon="upload" title="选择一张本地图片" detail="支持 JPEG、PNG、WebP、GIF 等常见格式，也可以把图片拖到左侧预览区。" />
      <LocalImageButton picker={picker} disabled={saving} dragging={dragging} onDragging={setDragging} large />
    </div>;
  } else if (source === "url") {
    panel = <div className="thumbnail-panel">
      <PanelHead icon="link" title="使用网络图片" detail="填写能公开访问的图片地址，由服务器读取（最大 50 MB），不会转发你的登录信息。" />
      <ImageUrlForm picker={picker} disabled={saving} />
      <ul className="thumbnail-tips"><li>可以直接粘贴图片链接，或把网页上的图片拖进来</li><li>支持 JPEG、PNG、WebP、GIF、BMP 与 AVIF</li></ul>
    </div>;
  } else if (source === "capture") {
    const running = generating?.state === "running";
    panel = <div className="thumbnail-panel">
      <PanelHead icon="camera" title={video ? "从视频截取画面" : "按原图重新生成"}
        detail={video ? "在视频的多个位置寻找有内容的画面，跳过黑屏、白屏和纯色片头。" : "把原图缩放为列表、网格与预览三种尺寸。"} />
      <div className={`thumbnail-status${generating ? ` is-${generating.state}` : ""}`} role="status">
        {running ? <span className="spinner" aria-hidden="true" /> : <Icon name={generating?.state === "failed" ? "alert" : "sparkle"} size={20} />}
        <span><strong>{running ? generating.detail : generating?.state === "failed" ? "没有生成成功" : "由服务器读取文件生成"}</strong>
          <small>{generating?.state === "failed" ? generating.detail
            : running ? "文件较大时需要一些时间；关闭窗口不影响生成，完成后列表自动更新。"
            : media === "image" && file.size >= LARGE_IMAGE ? "文件较大：服务器会先按自己的内存与读取速度评估，条件不适合时不会生成，可以改用本地图片或网络图片。"
            : current ? "生成成功后替换当前封面；没有合适的画面时保留现有封面。" : "生成后自动保存为这个文件的封面。"}</small></span>
      </div>
      {video && <p className="thumbnail-editor-hint"><Icon name="info" size={13} />想要指定画面？播放视频到合适的位置，点击控制条的图片按钮即可设为封面。</p>}
      {generating?.state === "failed" && fallbacks("embedded", "online", "local")}
    </div>;
  } else {
    panel = <div className="thumbnail-panel is-wide">
      <MediaCoverSearch file={file} selected={onlinePick?.token} disabled={saving} onPick={pickOnline} />
    </div>;
  }

  return <ThumbnailFrame inline={inline} footerTarget={footerTarget} title={current ? "更新封面" : "设置封面"} description={baseName(file.key)} icon="image" size="lg"
    className={`thumbnail-editor${api.isPrivatePath(file.key) ? " private-dialog" : ""}`}
    onClose={() => { if (!saving) onClose(); }} dismissible={!saving}
    footer={<>
      <span className="thumbnail-editor-foot" role="status">{saveHint ?? (source === "capture" ? "" : "图片会缩放为三种尺寸保存，原图不会存入你的文件")}</span>
      {source === "capture" ? <>
        <Button variant="ghost" onClick={onClose}>{generating?.state === "running" ? "在后台继续" : "取消"}</Button>
        {generating?.state === "running" ? <Button icon="stop" onClick={() => void stopGenerating()}>停止生成</Button>
          : <Button variant="primary" icon="camera" onClick={() => void generate()}>{generating ? "重试" : video ? "截取画面" : current ? "重新生成" : "生成封面"}</Button>}
      </> : <><Button variant="ghost" disabled={saving && !onCancelSave} onClick={() => saving ? onCancelSave?.() : onClose()}>{saving && onCancelSave ? "取消保存" : "取消"}</Button>
        <Button variant="primary" icon="check" loading={saving} disabled={!canSave} onClick={() => void save()}>{saving && source === "online" && onlineLoading ? "正在读取原图" : "保存封面"}</Button></>}
    </>}>
    <div className="thumbnail-editor-body"
      onPaste={event => {
        const image = [...event.clipboardData.files].find(item => item.type.startsWith("image/"));
        if (image) { event.preventDefault(); if (source !== "local") switchSource("local"); void accept(image, image.name || "粘贴的图片"); }
      }}>
      <div className="thumbnail-tabs" role="tablist" aria-label="封面来源">
        {sources.map(item => <button key={item} type="button" role="tab" aria-selected={source === item} className={source === item ? "is-active" : ""}
          disabled={generating?.state === "running" || saving} onClick={() => switchSource(item)}
          onKeyDown={event => {
            const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!offset) return;
            event.preventDefault();
            const next = sources[(sources.indexOf(item) + offset + sources.length) % sources.length];
            switchSource(next);
            (event.currentTarget.parentElement?.children[sources.indexOf(next)] as HTMLElement | undefined)?.focus();
          }} tabIndex={source === item ? 0 : -1}>
          <Icon name={SOURCES[item].icon} size={15} /><span>{SOURCES[item].label}</span>
        </button>)}
      </div>
      <div className={`thumbnail-layout${source === "online" ? " is-online" : ""}`} role="tabpanel">
        {stage}
        <div className="thumbnail-panel-wrap">{panel}{error && <Notice tone="danger">{error}</Notice>}</div>
      </div>
    </div>
  </ThumbnailFrame>;
}

function ThumbnailFrame({ inline, footerTarget, ...props }: ComponentProps<typeof Modal> & { inline?: boolean; footerTarget?: HTMLElement | null }) {
  return inline ? <section className={props.className}>{props.children}{footerTarget ? createPortal(props.footer, footerTarget) : <footer className="metadata-panel-footer">{props.footer}</footer>}</section> : <Modal {...props} />;
}

function PanelHead({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return <div className="thumbnail-panel-head"><span className="thumbnail-panel-icon"><Icon name={icon} size={18} /></span>
    <span><strong>{title}</strong><small>{detail}</small></span></div>;
}

/** 为还没有下载的文件选择缩略图（新建离线任务时使用）：只选择图片，提交任务后再缩放上传，下载完成时设为文件的缩略图。 */
export function CoverPickerDialog({ name, onClose, onPick }: { name: string; onClose: () => void; onPick: (image: Blob) => void }) {
  const picker = useImagePicker();
  const [source, setSource] = useState<"local" | "url">("local");
  const [dragging, setDragging] = useState(false);
  const { picked } = picker;
  return <Modal title="设置封面" description={name} icon="image" size="md" className="thumbnail-editor" onClose={onClose}
    footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" icon="check" disabled={!picked} onClick={() => { if (picked) onPick(picked.blob); }}>使用这张图片</Button></>}>
    <div className="thumbnail-editor-body" onPaste={event => {
      const image = [...event.clipboardData.files].find(item => item.type.startsWith("image/"));
      if (image) { event.preventDefault(); setSource("local"); picker.setAddress(""); void picker.accept(image, image.name || "粘贴的图片"); }
    }}>
      <div className={`thumbnail-stage${dragging ? " is-dragging" : ""}${picked ? " has-image" : ""}`}
        onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={event => {
          event.preventDefault(); setDragging(false);
          const image = [...event.dataTransfer.files].find(item => item.type.startsWith("image/"));
          if (image) { setSource("local"); void picker.accept(image, image.name); }
        }}>
        {picked ? <>
          <img src={picked.url} alt="封面预览" />
          <span className="thumbnail-stage-tag">{picked.width}×{picked.height} · {formatBytes(picked.blob.size)}</span>
        </> : <div className="thumbnail-stage-empty"><Icon name="image" size={28} /><span>选择一张图片作为封面</span></div>}
      </div>
      <Segmented label="图片来源" showLabels value={source} onChange={value => { setSource(value); picker.setError(""); }} options={[
        { value: "local", label: "本地图片", icon: "upload" }, { value: "url", label: "图片地址", icon: "link" },
      ]} />
      {source === "local" ? <LocalImageButton picker={picker} dragging={dragging} onDragging={setDragging} /> : <ImageUrlForm picker={picker} />}
      {picker.error && <Notice tone="danger">{picker.error}</Notice>}
      <p className="thumbnail-editor-hint">下载完成后，这张图片会缩放为列表、网格与预览大图三种尺寸，作为文件的封面；原图不会存入你的文件。{source === "url" ? "网络图片由服务器读取，需能公开访问，最大 50 MB。" : ""}</p>
    </div>
  </Modal>;
}
