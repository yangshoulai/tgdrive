import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import * as api from "../api";
import { baseName, getFileKind } from "../files";
import { createThumbnails, generateLoadedThumbnails, saveImageThumbnail, thumbnailSource } from "../thumbnails";
import { Button, Icon, Modal, Notice, Segmented, formatBytes, shortcutLabel } from "../ui";

type Source = "auto" | "local" | "url";
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
  async function accept(blob: Blob, name: string) {
    setError("");
    if (blob.type && !blob.type.startsWith("image/")) { setError("请选择图片文件"); return; }
    const url = URL.createObjectURL(blob);
    try {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      setPicked({ blob, url, name, ...size });
    } catch {
      URL.revokeObjectURL(url);
      setError("无法读取这张图片，请换用 JPEG、PNG、WebP 或 GIF 格式");
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
export function LocalImageButton({ picker, disabled, dragging, onDragging }: { picker: ImagePicker; disabled?: boolean; dragging?: boolean; onDragging?: (value: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <button type="button" className={`thumbnail-drop${dragging ? " is-dragging" : ""}`} disabled={disabled}
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

/** 更新缩略图：图片、视频、音频可以重新自动生成（上传或下载时没生成成功也能在这里补上）；
 * 任何文件都可以用一张本地图片或网络图片作为缩略图。图片在浏览器里缩放成三种规格后保存，原图不进入文件空间；
 * 网络图片由服务器代为读取，只接受常见图片格式。 */
export function ThumbnailEditor({ file, onClose, onSaved }: { file: api.FileItem; onClose: () => void; onSaved: (variants: string[]) => void }) {
  const media = thumbnailSource(file.key, file.content_type, file.size);
  const [source, setSource] = useState<Source>(media ? "auto" : "local");
  const [generating, setGenerating] = useState<Generating | null>(null);
  const generation = useRef<AbortController | null>(null);
  const picker = useImagePicker(file.key);
  const { picked, error, setError, accept } = picker;
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const close = useRef(onClose); close.current = onClose;
  const current = api.fileThumbnail(file, "poster");
  const video = getFileKind(file.content_type, file.key) === "video";

  // 关闭窗口只停止在窗口里等待；已提交给服务器的生成继续，完成后文件列表自动更新。
  useEffect(() => () => { generation.current?.abort(); }, []);
  useEffect(() => {
    if (!api.isPrivatePath(file.key)) return;
    const locked = () => close.current();
    window.addEventListener("tessera:private-locked", locked);
    return () => window.removeEventListener("tessera:private-locked", locked);
  }, [file.key]);

  async function save() {
    if (!picked || saving) return;
    setSaving(true); setError("");
    try { onSaved(await saveImageThumbnail(file, picked.blob)); }
    catch (reason) { setError(api.errorMessage(reason, "保存失败，请稍后重试")); setSaving(false); }
  }

  /** 自动生成：交给服务器重新生成（与上传后的自动生成相同的流程，不限制文件大小）；服务器没有 FFmpeg 时改在这个页面读取文件生成。 */
  async function generate() {
    if (!media || generation.current) return;
    const controller = new AbortController();
    generation.current = controller;
    setError(""); setGenerating({ state: "running", detail: "正在提交" });
    const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
    try {
      let local = false;
      try { await api.generateThumbnail(file); }
      catch (reason) {
        if (!api.errorMessage(reason, "").includes("FFmpeg")) throw reason;
        local = true;
      }
      if (local) {
        setGenerating({ state: "running", detail: "服务器无法生成，正在这个页面读取文件生成" });
        const saved = await generateLoadedThumbnails(file, signal => createThumbnails({ url: api.versionedContentUrl(api.contentUrl(file.key), file.etag, file.size), size: file.size, signal }, media), true, controller.signal);
        if (controller.signal.aborted) return;
        if (!saved) throw new Error("没有生成成功，可以稍后重试，或上传一张图片作为缩略图");
        if (saved.includes("none")) throw new Error(media === "audio" ? "这个音频没有内嵌封面，可以上传一张图片作为缩略图" : "没有找到可用的画面，可以上传一张图片作为缩略图");
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
          throw new Error(media === "audio" ? "这个音频没有内嵌封面，可以上传一张图片作为缩略图" : "没有找到可用的画面，可以上传一张图片作为缩略图");
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
    if (image) { setSource("local"); void accept(image, image.name); }
    else {
      const link = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
      if (/^https?:\/\//i.test(link.trim())) { setSource("url"); picker.setAddress(link.trim()); }
      else setError("请拖入一张图片");
    }
  };

  return <Modal title="更新缩略图" description={baseName(file.key)} icon="image" size="md" className={`thumbnail-editor${api.isPrivatePath(file.key) ? " private-dialog" : ""}`}
    onClose={() => { if (!saving) onClose(); }} dismissible={!saving}
    footer={source === "auto" ? <>
      <Button variant="ghost" onClick={onClose}>{generating?.state === "running" ? "在后台继续" : "取消"}</Button>
      {generating?.state === "running" ? <Button icon="x" onClick={() => void stopGenerating()}>停止生成</Button>
        : <Button variant="primary" icon="refresh" disabled={!media} onClick={() => void generate()}>{generating ? "重试" : current ? "重新生成" : "生成缩略图"}</Button>}
    </> : <><Button variant="ghost" disabled={saving} onClick={onClose}>取消</Button><Button variant="primary" icon="check" loading={saving} disabled={!picked} onClick={() => void save()}>保存缩略图</Button></>}>
    <div className="thumbnail-editor-body"
      onPaste={event => {
        const image = [...event.clipboardData.files].find(item => item.type.startsWith("image/"));
        if (image) { event.preventDefault(); setSource("local"); void accept(image, image.name || "粘贴的图片"); }
      }}>
      <div className={`thumbnail-stage${dragging ? " is-dragging" : ""}${picked ? " has-image" : ""}`}
        onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
        {source !== "auto" && picked ? <>
          <img src={picked.url} alt="新的缩略图预览" />
          <span className="thumbnail-stage-tag">新图片 · {picked.width}×{picked.height} · {formatBytes(picked.blob.size)}</span>
        </> : current ? <>
          <img src={current} alt="当前缩略图" />
          <span className="thumbnail-stage-tag is-current">当前缩略图</span>
        </> : <div className="thumbnail-stage-empty"><Icon name="image" size={28} /><span>还没有缩略图</span></div>}
      </div>
      <Segmented label="缩略图来源" showLabels value={source} disabled={generating?.state === "running" || saving} onChange={value => { setSource(value); setError(""); }} options={[
        { value: "auto", label: "自动生成", icon: "sparkle" }, { value: "local", label: "本地图片", icon: "upload" }, { value: "url", label: "图片地址", icon: "link" },
      ]} />
      {source === "auto" ? <div className={`thumbnail-auto${generating ? ` is-${generating.state}` : ""}`} role="status">
        {generating?.state === "running" ? <span className="spinner" aria-hidden="true" /> : <Icon name={generating?.state === "failed" ? "alert" : "sparkle"} size={20} />}
        <span><strong>{generating?.state === "running" ? generating.detail : generating?.state === "failed" ? "没有生成成功" : media ? "从文件内容重新生成" : "这类文件不能自动生成"}</strong>
          <small>{generating?.state === "failed" ? generating.detail
            : generating?.state === "running" ? "由服务器读取文件生成，文件较大时需要一些时间；关闭窗口不影响生成，完成后列表自动更新。"
            : media === "video" ? "在视频的多个位置寻找有内容的画面，跳过黑屏、白屏和纯色片头。"
            : media === "audio" ? "使用音频文件里内嵌的专辑封面；没有封面时请上传一张图片。"
            : media === "image" ? "按原图重新缩放出列表、网格与预览三种尺寸。"
            : "只有图片、视频和音频可以从文件内容生成；其他文件请上传本地图片或填写图片地址。"}</small></span>
      </div> : source === "local" ? <LocalImageButton picker={picker} disabled={saving} dragging={dragging} onDragging={setDragging} />
        : <ImageUrlForm picker={picker} disabled={saving} />}
      {error && <Notice tone="danger">{error}</Notice>}
      {source !== "auto" && <p className="thumbnail-editor-hint">图片会缩放为列表、网格与预览封面三种尺寸保存，原图不会存入你的文件。{source === "url" ? "网络图片由服务器读取，需能公开访问，最大 50 MB。" : ""}{video ? "播放视频时，也可以点击控制条的图片按钮把当前画面设为缩略图。" : ""}</p>}
    </div>
  </Modal>;
}

/** 为还没有下载的文件选择缩略图（新建离线任务时使用）：只选择图片，提交任务后再缩放上传，下载完成时设为文件的缩略图。 */
export function CoverPickerDialog({ name, onClose, onPick }: { name: string; onClose: () => void; onPick: (image: Blob) => void }) {
  const picker = useImagePicker();
  const [source, setSource] = useState<"local" | "url">("local");
  const [dragging, setDragging] = useState(false);
  const { picked } = picker;
  return <Modal title="设置缩略图" description={name} icon="image" size="md" className="thumbnail-editor" onClose={onClose}
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
          <img src={picked.url} alt="缩略图预览" />
          <span className="thumbnail-stage-tag">{picked.width}×{picked.height} · {formatBytes(picked.blob.size)}</span>
        </> : <div className="thumbnail-stage-empty"><Icon name="image" size={28} /><span>选择一张图片作为缩略图</span></div>}
      </div>
      <Segmented label="图片来源" showLabels value={source} onChange={value => { setSource(value); picker.setError(""); }} options={[
        { value: "local", label: "本地图片", icon: "upload" }, { value: "url", label: "图片地址", icon: "link" },
      ]} />
      {source === "local" ? <LocalImageButton picker={picker} dragging={dragging} onDragging={setDragging} /> : <ImageUrlForm picker={picker} />}
      {picker.error && <Notice tone="danger">{picker.error}</Notice>}
      <p className="thumbnail-editor-hint">下载完成后，这张图片会缩放为列表、网格与预览封面三种尺寸，作为文件的缩略图；原图不会存入你的文件。{source === "url" ? "网络图片由服务器读取，需能公开访问，最大 50 MB。" : ""}</p>
    </div>
  </Modal>;
}
