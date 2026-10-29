import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import * as api from "../api";
import { baseName, getFileKind } from "../files";
import { saveImageThumbnail } from "../thumbnails";
import { Button, Icon, Modal, Notice, Segmented, formatBytes, shortcutLabel } from "../ui";

type Source = "local" | "url";
type Picked = { blob: Blob; url: string; name: string; width: number; height: number };
const MAX_IMAGE = 20 * 1024 * 1024;

/** 更新缩略图：任何文件都可以用一张本地图片或网络图片作为缩略图。
 * 图片在浏览器里缩放成三种规格后保存，原图不进入文件空间；网络图片由服务器代为读取，只接受常见图片格式。 */
export function ThumbnailEditor({ file, onClose, onSaved }: { file: api.FileItem; onClose: () => void; onSaved: (variants: string[]) => void }) {
  const id = useId();
  const [source, setSource] = useState<Source>("local");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const fetching = useRef<AbortController | null>(null);
  const close = useRef(onClose); close.current = onClose;
  const current = api.fileThumbnail(file, "poster");
  const video = getFileKind(file.content_type, file.key) === "video";

  useEffect(() => () => { fetching.current?.abort(); }, []);
  useEffect(() => () => { if (picked) URL.revokeObjectURL(picked.url); }, [picked]);
  useEffect(() => {
    if (!api.isPrivatePath(file.key)) return;
    const locked = () => close.current();
    window.addEventListener("tessera:private-locked", locked);
    return () => window.removeEventListener("tessera:private-locked", locked);
  }, [file.key]);

  async function accept(blob: Blob, name: string) {
    setError("");
    if (blob.size > MAX_IMAGE) { setError("图片超过 20 MB，请换一张较小的图片"); return; }
    if (blob.type && !blob.type.startsWith("image/")) { setError("请选择图片文件"); return; }
    const url = URL.createObjectURL(blob);
    try {
      // 先在浏览器里解码一次：格式不受支持时立即提示，不等到保存时才失败。
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
      const blob = await api.fetchThumbnailImage(file, value, controller.signal);
      if (!controller.signal.aborted) await accept(blob, value.split(/[?#]/)[0].split("/").filter(Boolean).at(-1) || "网络图片");
    } catch (reason) {
      if (!controller.signal.aborted) setError(api.errorMessage(reason, "读取图片失败，请检查地址后重试"));
    } finally { if (fetching.current === controller) { fetching.current = null; setLoading(false); } }
  }

  async function save() {
    if (!picked || saving) return;
    setSaving(true); setError("");
    try { onSaved(await saveImageThumbnail(file, picked.blob)); }
    catch (reason) { setError(api.errorMessage(reason, "保存失败，请稍后重试")); setSaving(false); }
  }

  const drop = (event: DragEvent) => {
    event.preventDefault(); setDragging(false);
    const image = [...event.dataTransfer.files].find(item => item.type.startsWith("image/"));
    if (image) { setSource("local"); void accept(image, image.name); }
    else {
      const link = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
      if (/^https?:\/\//i.test(link.trim())) { setSource("url"); setAddress(link.trim()); }
      else setError("请拖入一张图片");
    }
  };

  return <Modal title="更新缩略图" description={baseName(file.key)} icon="image" size="md" className={`thumbnail-editor${api.isPrivatePath(file.key) ? " private-dialog" : ""}`}
    onClose={() => { if (!saving) onClose(); }} dismissible={!saving}
    footer={<><Button variant="ghost" disabled={saving} onClick={onClose}>取消</Button><Button variant="primary" icon="check" loading={saving} disabled={!picked} onClick={() => void save()}>保存缩略图</Button></>}>
    <div className="thumbnail-editor-body"
      onPaste={event => {
        const image = [...event.clipboardData.files].find(item => item.type.startsWith("image/"));
        if (image) { event.preventDefault(); setSource("local"); void accept(image, image.name || "粘贴的图片"); }
      }}>
      <div className={`thumbnail-stage${dragging ? " is-dragging" : ""}${picked ? " has-image" : ""}`}
        onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
        {picked ? <>
          <img src={picked.url} alt="新的缩略图预览" />
          <span className="thumbnail-stage-tag">新图片 · {picked.width}×{picked.height} · {formatBytes(picked.blob.size)}</span>
        </> : current ? <>
          <img src={current} alt="当前缩略图" />
          <span className="thumbnail-stage-tag is-current">当前缩略图</span>
        </> : <div className="thumbnail-stage-empty"><Icon name="image" size={28} /><span>还没有缩略图</span></div>}
      </div>
      <Segmented label="图片来源" showLabels value={source} onChange={value => { setSource(value); setError(""); }} options={[
        { value: "local", label: "本地图片", icon: "upload" }, { value: "url", label: "图片地址", icon: "link" },
      ]} />
      {source === "local" ? <button type="button" className={`thumbnail-drop${dragging ? " is-dragging" : ""}`} disabled={saving}
        onClick={() => input.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
        <Icon name="upload" size={20} />
        <span><strong>{picked && !address ? "换一张图片" : "选择图片"}</strong><small>点击选择、拖入或直接粘贴（{shortcutLabel("Mod+V")}），最大 20 MB</small></span>
        <input ref={input} type="file" accept="image/*" hidden onChange={event => {
          const image = event.target.files?.[0];
          event.target.value = "";
          if (image) { setAddress(""); void accept(image, image.name); }
        }} />
      </button> : <form className="thumbnail-url" onSubmit={event => { event.preventDefault(); void load(); }}>
        <label className="sr-only" htmlFor={`${id}-url`}>图片地址</label>
        <input id={`${id}-url`} className="input" type="url" inputMode="url" autoFocus placeholder="https://example.com/cover.jpg" value={address} disabled={saving}
          onChange={event => setAddress(event.target.value)} />
        <Button type="submit" icon="download" loading={loading} disabled={!address.trim() || saving}>读取</Button>
      </form>}
      {error && <Notice tone="danger">{error}</Notice>}
      <p className="thumbnail-editor-hint">图片会缩放为列表、网格与预览封面三种尺寸保存，原图不会存入你的文件。{source === "url" ? "网络图片由服务器读取，需能公开访问。" : ""}{video ? "播放视频时，也可以点击控制条的图片按钮把当前画面设为缩略图。" : ""}</p>
    </div>
  </Modal>;
}
