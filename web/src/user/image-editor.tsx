/** 图片编辑：旋转、翻转、裁剪（自由或固定比例）、调整尺寸、转换格式与压缩画质，保存为新文件或覆盖原图。
 * 全部在浏览器里用 Canvas 完成，原图不离开设备；保存后只上传结果。照片的 EXIF 信息（拍摄参数、位置）不会保留。 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import * as api from "../api";
import { baseName, parentPath } from "../files";
import { decodeHeif, isHeif } from "../heif";
import { createThumbnails, generateLoadedThumbnails } from "../thumbnails";
import { Button, Field, IconButton, Modal, Notice, Segmented, toast } from "../ui";

type Rect = { x: number; y: number; w: number; h: number };
type Aspect = "free" | "original" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16";
type Format = "image/jpeg" | "image/png" | "image/webp";
const FORMAT_EXT: Record<Format, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const FORMAT_LABEL: Record<Format, string> = { "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP" };
const ASPECTS: { value: Aspect; label: string }[] = [
  { value: "free", label: "自由" }, { value: "original", label: "原比例" }, { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" }, { value: "3:4", label: "3:4" }, { value: "16:9", label: "16:9" }, { value: "9:16", label: "9:16" },
];
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const MAX_PIXELS = 64_000_000;
const MAX_EDGE = 16384;

/** 原图的格式能否原样写回（覆盖原图时保持格式与扩展名一致）。 */
function sameFormat(file: api.FileItem): Format | null {
  const mime = (file.content_type ?? "").split(";")[0].trim().toLowerCase();
  if (mime === "image/jpeg" || /\.jpe?g$/i.test(file.key)) return "image/jpeg";
  if (mime === "image/png" || /\.png$/i.test(file.key)) return "image/png";
  if (mime === "image/webp" || /\.webp$/i.test(file.key)) return "image/webp";
  return null;
}

async function loadBitmap(file: api.FileItem, signal: AbortSignal): Promise<ImageBitmap> {
  const url = api.versionedContentUrl(api.contentUrl(file.key), file.etag, file.size);
  let blob: Blob;
  if (isHeif(file.key, file.content_type) && !nativeHeif()) blob = (await decodeHeif(url, signal)).blob;
  else {
    const response = await fetch(url, { credentials: "include", signal });
    if (!response.ok) throw new Error(`无法读取图片（${response.status}）`);
    blob = await response.blob();
  }
  // 按 EXIF 方向摆正（手机竖拍的照片）。
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  if (bitmap.width * bitmap.height > MAX_PIXELS) { bitmap.close(); throw new Error("图片太大，浏览器无法编辑"); }
  return bitmap;
}
/** Safari（17 起）能直接解码 HEIC，不必加载解码器；其他浏览器在 Worker 里用 libheif 解码。 */
const nativeHeif = () => /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android|Firefox|FxiOS/.test(navigator.userAgent);

/** 按当前的旋转与翻转把原图画到画布：画布坐标是摆正后图片的像素坐标。 */
function drawOriented(context: CanvasRenderingContext2D, bitmap: ImageBitmap, rotation: number, flipX: boolean, flipY: boolean, orientedWidth: number, orientedHeight: number) {
  context.translate(orientedWidth / 2, orientedHeight / 2);
  context.rotate(rotation * Math.PI / 180);
  context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
}

export function ImageEditorDialog({ file, onClose, onSaved }: { file: api.FileItem; onClose: () => void; onSaved?: (item: api.FileItem, replaced: boolean) => void }) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [loadError, setLoadError] = useState("");
  const [rotation, setRotation] = useState(0);
  const [flipX, setFlipX] = useState(false), [flipY, setFlipY] = useState(false);
  const [crop, setCrop] = useState<Rect>(FULL);
  const [aspect, setAspect] = useState<Aspect>("free");
  const original = sameFormat(file);
  const [format, setFormat] = useState<Format>(original ?? "image/jpeg");
  const [quality, setQuality] = useState(90);
  const [width, setWidth] = useState("");
  const [mode, setMode] = useState<"copy" | "overwrite">("copy");
  const base = baseName(file.key).replace(/\.[^.]+$/, "");
  const [name, setName] = useState(`${base}-编辑`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let loaded: ImageBitmap | null = null;
    void loadBitmap(file, controller.signal).then(value => { loaded = value; if (!controller.signal.aborted) setBitmap(value); else value.close(); },
      reason => { if (!controller.signal.aborted) setLoadError(reason instanceof Error ? reason.message : "图片没有加载出来"); });
    return () => { controller.abort(); loaded?.close(); };
  }, [file.key, file.etag]);

  const turned = rotation % 180 !== 0;
  const orientedWidth = bitmap ? (turned ? bitmap.height : bitmap.width) : 0, orientedHeight = bitmap ? (turned ? bitmap.width : bitmap.height) : 0;
  const cropWidth = Math.max(1, Math.round(crop.w * orientedWidth)), cropHeight = Math.max(1, Math.round(crop.h * orientedHeight));
  const requested = Number(width);
  const outputWidth = width && Number.isFinite(requested) && requested > 0 ? Math.min(MAX_EDGE, Math.round(requested)) : cropWidth;
  const outputHeight = Math.max(1, Math.round(outputWidth * cropHeight / cropWidth));
  const ratio = aspect === "free" ? null : aspect === "original" ? (bitmap ? bitmap.width / bitmap.height : 1) : Number(aspect.split(":")[0]) / Number(aspect.split(":")[1]);

  // 选比例后把裁剪框收成这个比例并居中。
  useEffect(() => {
    if (!ratio || !orientedWidth) return;
    const target = ratio * orientedHeight / orientedWidth;  // 归一化坐标里的宽高比
    setCrop(current => {
      let w = current.w, h = w / target;
      if (h > 1) { h = 1; w = target; }
      if (w > 1) { w = 1; h = 1 / target; }
      return { x: Math.min(1 - w, Math.max(0, current.x + (current.w - w) / 2)), y: Math.min(1 - h, Math.max(0, current.y + (current.h - h) / 2)), w, h };
    });
  }, [ratio, orientedWidth, orientedHeight]);

  // 预览画布：按舞台大小缩放显示摆正后的整张图片，裁剪框叠在上面。
  const stage = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setBox({ width: node.clientWidth, height: node.clientHeight }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const scale = orientedWidth && box.width ? Math.min((box.width - 32) / orientedWidth, (box.height - 32) / orientedHeight, 1) : 0;
  const display = { width: Math.max(1, Math.round(orientedWidth * scale)), height: Math.max(1, Math.round(orientedHeight * scale)) };
  useEffect(() => {
    const node = canvas.current;
    if (!node || !bitmap || !scale) return;
    const density = Math.min(2, window.devicePixelRatio || 1);
    node.width = Math.round(display.width * density); node.height = Math.round(display.height * density);
    const context = node.getContext("2d")!;
    context.setTransform(scale * density, 0, 0, scale * density, 0, 0);
    drawOriented(context, bitmap, rotation, flipX, flipY, orientedWidth, orientedHeight);
  }, [bitmap, rotation, flipX, flipY, scale, display.width, display.height]);

  const drag = useRef<{ handle: string; x: number; y: number; start: Rect } | null>(null);
  function pointerDown(event: ReactPointerEvent<HTMLElement>, handle: string) {
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { handle, x: event.clientX, y: event.clientY, start: crop };
  }
  function pointerMove(event: ReactPointerEvent<HTMLElement>) {
    const state = drag.current;
    if (!state || !display.width) return;
    const dx = (event.clientX - state.x) / display.width, dy = (event.clientY - state.y) / display.height;
    const start = state.start, min = 0.02;
    if (state.handle === "move") {
      setCrop({ ...start, x: Math.min(1 - start.w, Math.max(0, start.x + dx)), y: Math.min(1 - start.h, Math.max(0, start.y + dy)) });
      return;
    }
    let { x, y, w, h } = start;
    if (state.handle.includes("w")) { const right = x + w; x = Math.min(right - min, Math.max(0, x + dx)); w = right - x; }
    if (state.handle.includes("e")) w = Math.min(1 - x, Math.max(min, w + dx));
    if (state.handle.includes("n")) { const bottom = y + h; y = Math.min(bottom - min, Math.max(0, y + dy)); h = bottom - y; }
    if (state.handle.includes("s")) h = Math.min(1 - y, Math.max(min, h + dy));
    if (ratio) {
      // 固定比例：以拖动的边为准换算另一边，超出画面时整体缩小。
      const target = ratio * orientedHeight / orientedWidth;
      if (/^[ns]$/.test(state.handle)) w = h * target; else h = w / target;
      if (x + w > 1) { w = 1 - x; h = w / target; }
      if (y + h > 1) { h = 1 - y; w = h * target; }
      if (state.handle.includes("n")) y = start.y + start.h - h;
      if (state.handle.includes("w")) x = start.x + start.w - w;
      if (x < 0 || y < 0) return;
    }
    setCrop({ x, y, w, h });
  }
  const pointerUp = () => { drag.current = null; };
  const rotate = (delta: number) => { setRotation(value => (value + delta + 360) % 360); setCrop(FULL); setAspect("free"); };
  const flip = (axis: "x" | "y") => { if (axis === "x") setFlipX(value => !value); else setFlipY(value => !value); };
  const edited = rotation !== 0 || flipX || flipY || crop !== FULL && (crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1) || Boolean(width) || format !== original || quality !== 90;

  async function render(): Promise<Blob> {
    if (!bitmap) throw new Error("图片还没有加载");
    const output = document.createElement("canvas");
    output.width = outputWidth; output.height = outputHeight;
    const context = output.getContext("2d")!;
    context.imageSmoothingQuality = "high";
    // JPEG 没有透明通道：透明部分铺白底，不变成黑色。
    if (format === "image/jpeg") { context.fillStyle = "white"; context.fillRect(0, 0, outputWidth, outputHeight); }
    context.scale(outputWidth / cropWidth, outputHeight / cropHeight);
    context.translate(-crop.x * orientedWidth, -crop.y * orientedHeight);
    drawOriented(context, bitmap, rotation, flipX, flipY, orientedWidth, orientedHeight);
    const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, format, format === "image/png" ? undefined : quality / 100));
    output.width = output.height = 0;
    if (!blob) throw new Error("图片导出失败，可以换一种格式或缩小尺寸后重试");
    return blob;
  }
  async function freePath(path: string): Promise<string> {
    const taken = new Set((await api.checkFiles([path])).paths);
    if (!taken.has(path)) return path;
    const dot = path.lastIndexOf("."), stem = path.slice(0, dot), ext = path.slice(dot);
    for (let n = 1; n < 1000; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!(await api.checkFiles([candidate])).paths.includes(candidate)) return candidate;
    }
    throw new Error("同名文件太多，请换个名称");
  }
  const trimmed = name.trim();
  const nameError = mode === "copy" && (!trimmed ? "请填写文件名" : /[\\/]/.test(trimmed) ? "文件名不能包含 / 或 \\" : "");
  async function save() {
    if (nameError || busy) return;
    setBusy(true); setError("");
    try {
      const blob = await render();
      const overwrite = mode === "overwrite";
      const path = overwrite ? file.key : await freePath(`${parentPath(file.key)}${trimmed}.${FORMAT_EXT[format]}`);
      const item = await api.saveImageFile(path, blob, overwrite ? file.etag : undefined);
      void api.setMediaSize(item, { width: outputWidth, height: outputHeight }).catch(() => undefined);
      // 用导出的结果直接生成封面，不必再下载一次。
      void generateLoadedThumbnails(item, signal => createThumbnails({ file: blob, signal }, "image"), overwrite).catch(() => undefined);
      if (overwrite) api.announceFileUpdated(item);
      window.dispatchEvent(new CustomEvent("tessera:files-added", { detail: { folders: [parentPath(item.key)] } }));
      toast.success(overwrite ? "已保存修改，原图放进了回收站，需要时可以还原" : `已另存为「${baseName(item.key)}」`);
      onSaved?.(item, overwrite);
      onClose();
    } catch (reason) {
      setError(reason instanceof api.ApiError && reason.code === "version_conflict" ? "原图已在别处修改，没有覆盖。可以另存为新文件。" : api.errorMessage(reason, "保存失败，请稍后重试"));
    } finally { setBusy(false); }
  }

  const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  return <Modal title="编辑图片" icon="image" description={baseName(file.key)} size="xl" className="image-editor-modal" onClose={onClose} dismissible={!busy}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button>
      <Button variant="primary" loading={busy} disabled={!bitmap || Boolean(nameError) || mode === "overwrite" && (!edited || original !== format)} onClick={() => void save()}>{mode === "overwrite" ? "覆盖保存" : "另存为"}</Button></>}>
    <div className="image-editor">
      <div ref={stage} className="image-editor-stage">
        {loadError ? <Notice tone="danger">{loadError}</Notice> : !bitmap ? <span className="image-loading" role="status"><span className="spinner" />正在加载图片…</span> : <div className="image-editor-canvas" style={display}>
          <canvas ref={canvas} style={display} />
          <div className="image-editor-crop" style={{ left: crop.x * display.width, top: crop.y * display.height, width: crop.w * display.width, height: crop.h * display.height }}
            onPointerDown={event => pointerDown(event, "move")} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
            <span className="image-editor-grid" aria-hidden="true" />
            {handles.map(handle => <span key={handle} className={`image-editor-handle is-${handle}`} onPointerDown={event => pointerDown(event, handle)} onPointerMove={pointerMove} onPointerUp={pointerUp} />)}
          </div>
        </div>}
      </div>
      <aside className="image-editor-panel">
        <Field label="旋转与翻转">
          <div className="image-editor-tools">
            <IconButton icon="rotate" label="向左旋转 90°" variant="secondary" disabled={!bitmap} onClick={() => rotate(-90)} />
            <IconButton icon="rotate" label="向右旋转 90°" variant="secondary" className="is-mirrored" disabled={!bitmap} onClick={() => rotate(90)} />
            <Button size="sm" variant={flipX ? "primary" : "secondary"} disabled={!bitmap} onClick={() => flip("x")}>水平翻转</Button>
            <Button size="sm" variant={flipY ? "primary" : "secondary"} disabled={!bitmap} onClick={() => flip("y")}>垂直翻转</Button>
          </div>
        </Field>
        <Field label="裁剪比例" hint="在左侧拖动裁剪框与边角调整范围。">
          <div className="image-editor-aspects">{ASPECTS.map(option => <button key={option.value} type="button" className={`filter-chip${aspect === option.value ? " is-active" : ""}`} aria-pressed={aspect === option.value}
            onClick={() => setAspect(option.value)}>{option.label}</button>)}
            <button type="button" className="filter-chip" onClick={() => { setCrop(FULL); setAspect("free"); }}>不裁剪</button>
          </div>
        </Field>
        <Field label="输出宽度" hint={`裁剪后 ${cropWidth} × ${cropHeight}，输出 ${outputWidth} × ${outputHeight} 像素；高度按比例计算。`}>
          <input className="input" type="number" min={1} max={MAX_EDGE} placeholder={String(cropWidth)} value={width} onChange={event => setWidth(event.target.value)} />
        </Field>
        <Field label="格式">
          <Segmented label="格式" value={format} onChange={setFormat} showLabels options={(Object.keys(FORMAT_LABEL) as Format[]).map(value => ({ value, label: FORMAT_LABEL[value] }))} />
        </Field>
        {format !== "image/png" && <Field label={`画质 ${quality}`} hint="越低文件越小，80–90 通常看不出区别。">
          <input type="range" min={40} max={100} value={quality} aria-label="画质" onChange={event => setQuality(Number(event.target.value))} />
        </Field>}
        <Field label="保存方式">
          <Segmented label="保存方式" value={mode} onChange={setMode} showLabels options={[{ value: "copy", label: "另存为新文件" }, { value: "overwrite", label: "覆盖原图" }]} />
        </Field>
        {mode === "copy" ? <Field label="文件名" error={name && nameError ? nameError : undefined}>
          <div className="input-affix"><input className="input" value={name} maxLength={200} onChange={event => setName(event.target.value)} /><span className="muted">.{FORMAT_EXT[format]}</span></div>
        </Field> : original !== format ? <Notice tone="warning">覆盖原图时格式要与原图一致（{original ? FORMAT_LABEL[original] : "原格式无法写回，请另存为新文件"}）。</Notice>
          : <p className="muted">原图会被替换，无法撤销；分享链接与收藏保持不变。</p>}
        <p className="muted">编辑在浏览器里完成，原图不会上传或修改；照片的 EXIF 信息（拍摄参数、位置）不会保留。</p>
        {error && <Notice tone="danger">{error}</Notice>}
      </aside>
    </div>
  </Modal>;
}

