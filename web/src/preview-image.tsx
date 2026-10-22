/** 图片查看器：深色画布与模糊背景，滚轮／双指／双击缩放，拖动平移，旋转，悬浮工具栏，左右切换与底部缩略图条。
 * 先显示封面图占位，原图解密完成后替换；新图就绪前保留上一张已解码图片的虚化背景。 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { FileItem } from "./api";
import type { PreviewNav, PreviewStrip } from "./preview-playlist";
import { Icon, isShortcutControl, type IconName } from "./ui";

type Size = { width: number; height: number };
/** 预览封面最长边为 min(960, 原图最长边)：达到这个长度说明原图至少这么大，占位时可以放大到原图将占据的尺寸。 */
const POSTER_EDGE = 950;
type View = { scale: number; x: number; y: number };
const FIT: View = { scale: 1, x: 0, y: 0 };
const MAX_ZOOM = 8;
const IDLE_MS = 3500;

function ToolButton({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="image-tool" aria-label={label} title={label} disabled={disabled} onClick={onClick}><Icon name={icon} size={18} /></button>;
}

/** 复用已经读取的像素生成小背景，避免 CSS 背景再次读取原图；快照只在当前查看器中保留。 */
function backdropOf(image: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement("canvas"), scale = Math.min(1, 64 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", .7);
  } catch { return null; } // 跨域图片无法读取像素时保留已有背景，不为装饰重新请求文件。
}

export function ImageViewer({ url, name, poster, onLoad, onError, onImageSize, nav, strip }: {
  url: string; name: string; poster?: string; onLoad?: (image: HTMLImageElement) => void; onError: () => void;
  onImageSize?: (width: number, height: number, original: boolean) => void; nav?: PreviewNav; strip?: PreviewStrip;
}) {
  const root = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null);
  const original = useRef<HTMLImageElement>(null), cover = useRef<HTMLImageElement>(null);
  const delivered = useRef(new WeakSet<HTMLImageElement>());
  // 就绪状态绑定资源地址，避免旧 load 事件或切换后的 effect 把缓存图片重新置为未加载。
  const [ready, setReady] = useState<{ url: string; image: HTMLImageElement; size: Size; warm: boolean } | null>(null);
  const [coverReady, setCoverReady] = useState<{ url: string; image: HTMLImageElement; size: Size } | null>(null);
  const loaded = ready?.url === url && ready.image === original.current, warm = loaded && ready.warm;
  const natural: (Size & { poster?: boolean }) | null = loaded ? ready.size : coverReady?.url === url && coverReady.image === cover.current ? { ...coverReady.size, poster: true } : null;
  const [backdrops, setBackdrops] = useState<string[]>([]);
  // 原图淡入结束前保留封面在下面，避免切换瞬间露出背景或跳动。
  const [faded, setFaded] = useState<string | null>(null);
  const posterDone = loaded && (warm || faded === url);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [rotation, setRotation] = useState(0);
  const [view, setView] = useState<View>(FIT);
  const [dragging, setDragging] = useState(false);
  const [idle, setIdle] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; view: View; distance?: number; moved: boolean; startX: number; startY: number } | null>(null);

  function rememberBackdrop(image: HTMLImageElement) {
    const snapshot = backdropOf(image);
    if (snapshot) setBackdrops(current => current.at(-1) === snapshot ? current : [...current.slice(-1), snapshot]);
  }
  function imageLoaded(image: HTMLImageElement, fromMemory = false) {
    if (image !== original.current || !image.naturalWidth || delivered.current.has(image)) return;
    delivered.current.add(image);
    setReady({ url, image, size: { width: image.naturalWidth, height: image.naturalHeight }, warm: fromMemory });
    rememberBackdrop(image);
    onImageSize?.(image.naturalWidth, image.naturalHeight, true); onLoad?.(image);
  }
  function coverLoaded(image: HTMLImageElement) {
    if (image !== cover.current || !image.naturalWidth || delivered.current.has(image) || (original.current && delivered.current.has(original.current))) return;
    delivered.current.add(image);
    setCoverReady({ url, image, size: { width: image.naturalWidth, height: image.naturalHeight } });
    rememberBackdrop(image);
    onImageSize?.(image.naturalWidth, image.naturalHeight, false);
  }
  useLayoutEffect(() => { setView(FIT); setRotation(0); }, [url]);
  useLayoutEffect(() => {
    const image = original.current, poster = cover.current;
    // 已在浏览器内存中解码的图片，在首帧绘制前直接就绪，不再先隐藏再淡入。
    if (image?.complete && image.naturalWidth) imageLoaded(image, true);
    else if (poster?.complete && poster.naturalWidth) coverLoaded(poster);
  }, [url, poster]);
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => setFaded(url), 450);
    return () => window.clearTimeout(timer);
  }, [loaded, url]);
  useLayoutEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const measure = () => setBox({ width: node.clientWidth, height: node.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(node); measure();
    return () => observer.disconnect();
  }, []);

  // 适应画布的基准尺寸：旋转 90° 时宽高互换；小图不放大。
  const turned = rotation % 180 !== 0;
  // 小图不放大；封面占位且原图明显更大时按画布放大，原图到达后尺寸不变，不会从小图跳到大图。
  const upscale = Boolean(natural?.poster && Math.max(natural.width, natural.height) >= POSTER_EDGE);
  const fit = natural && box.width && box.height
    ? Math.min(upscale ? Infinity : 1, (box.width - 32) / (turned ? natural.height : natural.width), (box.height - 32) / (turned ? natural.width : natural.height)) : 1;
  const display = natural ? { width: natural.width * fit, height: natural.height * fit } : null;
  const oneToOne = Math.max(1, 1 / fit);
  // 最多放大到适应窗口的 4 倍，或原图像素的 4 倍（大图），取较大者。
  const maxScale = Math.max(MAX_ZOOM / 2, oneToOne * MAX_ZOOM / 2);
  const clampView = (next: View): View => {
    const scale = Math.max(1, Math.min(maxScale, next.scale));
    if (!display) return { scale, x: 0, y: 0 };
    const width = (turned ? display.height : display.width) * scale, height = (turned ? display.width : display.height) * scale;
    const limitX = Math.max(0, (width - box.width) / 2), limitY = Math.max(0, (height - box.height) / 2);
    return { scale, x: Math.max(-limitX, Math.min(limitX, next.x)), y: Math.max(-limitY, Math.min(limitY, next.y)) };
  };
  // 窗口缩放后重新限制平移，避免放大过的图片偏离新的画布边界。
  useLayoutEffect(() => {
    setView(current => {
      const next = clampView(current);
      return next.scale === current.scale && next.x === current.x && next.y === current.y ? current : next;
    });
  }, [box.width, box.height, display?.width, display?.height, turned, maxScale]);
  /** 以画布内某点为中心缩放（点坐标相对画布中心），该点下的像素保持不动。 */
  const zoomAt = (scale: number, point = { x: 0, y: 0 }) => setView(current => {
    const target = Math.max(1, Math.min(maxScale, scale)), ratio = target / current.scale;
    return clampView({ scale: target, x: point.x - (point.x - current.x) * ratio, y: point.y - (point.y - current.y) * ratio });
  });
  const relative = (clientX: number, clientY: number) => {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };
  const actual = fit * view.scale;   // 相对原图像素的显示比例

  // 滚轮与触控板双指缩放；需要非被动监听才能阻止页面滚动。
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!natural) return;
      event.preventDefault();
      const point = relative(event.clientX, event.clientY);
      zoomAt(viewRef.current.scale * Math.exp(-event.deltaY * (event.ctrlKey ? .01 : .0018)), point);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  });

  // 鼠标静止一会儿后隐藏工具栏与切换按钮，移动即恢复；触屏一直显示。
  const idleTimer = useRef<number | undefined>(undefined);
  const wake = () => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    if (window.matchMedia("(hover: hover)").matches) idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  };
  useEffect(() => { wake(); return () => window.clearTimeout(idleTimer.current); }, []);

  // + / - / 0 / R 快捷键。左右切换通常由外层预览在焦点位于弹窗内时处理；焦点因点击页面空白等原因
  // 落到 body 时外层收不到按键，这里兜底处理（外层已处理的会 preventDefault，不会重复切换）。
  const navRef = useRef(nav);
  navRef.current = nav;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const node = root.current, target = event.target as Element | null;
      if (!node || (target && target !== document.body && !node.closest(".modal, .share-card")?.contains(target)) || (target && isShortcutControl(target))) return;
      if (node.closest("[inert]") || node.closest(".modal.is-minimized")) return;
      const actions: Record<string, () => void> = {
        "+": () => zoomAt(viewRef.current.scale * 1.4), "=": () => zoomAt(viewRef.current.scale * 1.4),
        "-": () => zoomAt(viewRef.current.scale / 1.4), "0": () => setView(FIT),
        r: () => { setRotation(value => value + 90); setView(FIT); }, R: () => { setRotation(value => value + 90); setView(FIT); },
      };
      const current = navRef.current;
      if (current && current.count > 1 && !event.shiftKey) {
        actions.ArrowLeft = () => { if (!event.repeat) current.onPrevious(); };
        actions.ArrowRight = () => { if (!event.repeat) current.onNext(); };
      }
      const action = actions[event.key];
      if (!action) return;
      event.preventDefault(); action(); wake();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    const points = [...pointers.current.values()];
    const distance = points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : undefined;
    const center = points.length === 2 ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : points[0];
    gesture.current = { x: center.x, y: center.y, view: viewRef.current, distance, moved: false, startX: event.clientX, startY: event.clientY };
    setDragging(true);
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    wake();
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()], start = gesture.current;
    if (points.length === 2 && start.distance) {
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      const point = relative(start.x, start.y), target = Math.max(1, Math.min(maxScale, start.view.scale * distance / start.distance)), ratio = target / start.view.scale;
      start.moved = true;
      setView(clampView({ scale: target, x: point.x - (point.x - start.view.x) * ratio + center.x - start.x, y: point.y - (point.y - start.view.y) * ratio + center.y - start.y }));
    } else if (points.length === 1) {
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) start.moved = true;
      if (start.view.scale > 1) setView(clampView({ scale: start.view.scale, x: start.view.x + dx, y: start.view.y + dy }));
    }
  }
  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const start = gesture.current;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size) return;
    gesture.current = null; setDragging(false);
    // 未放大时横向轻扫切换上一张／下一张（触屏）。
    if (start && start.view.scale === 1 && event.pointerType !== "mouse" && nav && nav.count > 1) {
      const dx = event.clientX - start.startX, dy = event.clientY - start.startY;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { if (dx > 0) nav.onPrevious(); else nav.onNext(); }
    }
  }
  const stripList = useRef<HTMLOListElement>(null), stripPlaced = useRef(false);
  useEffect(() => {
    const list = stripList.current, item = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !item) return;
    // 只滚动缩略图条本身（scrollIntoView 还会滚动外层容器）；首次打开直接定位，之后从上一张平滑滚到下一张。
    const box = list.getBoundingClientRect(), rect = item.getBoundingClientRect();
    const left = list.scrollLeft + rect.left - box.left - (list.clientWidth - rect.width) / 2;
    const smooth = stripPlaced.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollTo({ left: Math.max(0, left), behavior: smooth ? "smooth" : "instant" });
    stripPlaced.current = true;
  }, [strip?.current, strip?.items.length]);

  const transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale}) rotate(${rotation}deg)`;
  const sized = display ? { width: display.width, height: display.height } : undefined;
  const showStrip = Boolean(strip && strip.items.length > 1);
  return <div ref={root} className={`image-viewer${idle && !dragging ? " is-idle" : ""}${loaded ? " is-loaded" : ""}${warm ? " is-warm" : ""}${poster ? " has-poster" : ""}${view.scale > 1 ? " is-zoomed" : ""}${dragging ? " is-dragging" : ""}`}
    onPointerMove={wake}>
    <div className="image-backdrop" aria-hidden="true">{backdrops.map(snapshot => <div key={snapshot} className="image-backdrop-layer" style={{ backgroundImage: `url("${snapshot}")` } as CSSProperties} />)}</div>
    <div ref={canvas} className="image-canvas" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}
      onDoubleClick={event => { if (view.scale > 1) setView(FIT); else zoomAt(Math.max(2.5, oneToOne), relative(event.clientX, event.clientY)); }}>
      {!posterDone && poster && <img ref={cover} key={`${url}:${poster}`} className="image-poster" src={poster} alt="" aria-hidden="true" draggable={false} style={sized}
        onLoad={event => coverLoaded(event.currentTarget)} />}
      <img ref={original} key={url} className="image-full" src={url} alt={name} draggable={false} style={{ ...sized, transform }}
        onLoad={event => imageLoaded(event.currentTarget)}
        onError={event => { if (event.currentTarget === original.current) onError(); }} />
      {!loaded && <span className="image-loading" role="status"><span className="spinner" />{poster ? "正在加载原图…" : "正在加载…"}</span>}
    </div>
    {nav && nav.count > 1 && <>
      <button type="button" className="image-arrow is-previous" aria-label="上一张（←）" title="上一张（←）" onClick={nav.onPrevious}><Icon name="chevronLeft" size={22} /></button>
      <button type="button" className="image-arrow is-next" aria-label="下一张（→）" title="下一张（→）" onClick={nav.onNext}><Icon name="chevronRight" size={22} /></button>
    </>}
    <div className="image-toolbar" role="toolbar" aria-label="图片操作" onPointerEnter={() => { window.clearTimeout(idleTimer.current); setIdle(false); }}>
      <ToolButton icon="zoomOut" label="缩小（-）" disabled={view.scale <= 1} onClick={() => zoomAt(view.scale / 1.4)} />
      <button type="button" className="image-zoom-level" title="适应窗口（0）" onClick={() => setView(FIT)}>{Math.round(actual * 100)}%</button>
      <ToolButton icon="zoomIn" label="放大（+）" disabled={view.scale >= maxScale} onClick={() => zoomAt(view.scale * 1.4)} />
      <span className="image-tool-divider" aria-hidden="true" />
      <ToolButton icon={view.scale > 1 ? "fitScreen" : "maximize"} label={view.scale > 1 ? "适应窗口（0）" : "原始大小"} disabled={view.scale === 1 && oneToOne === 1}
        onClick={() => view.scale > 1 ? setView(FIT) : zoomAt(oneToOne)} />
      <ToolButton icon="rotate" label="旋转（R）" onClick={() => { setRotation(value => value + 90); setView(FIT); }} />
      {nav && nav.count > 1 && <><span className="image-tool-divider" aria-hidden="true" /><span className="image-counter">{nav.index + 1} / {nav.count}</span></>}
    </div>
    {showStrip && strip && <ol ref={stripList} className="image-strip" aria-label="同目录图片">
      {strip.items.map((file: FileItem) => {
        const thumb = strip.thumbnail(file), current = file.key === strip.current;
        return <li key={file.key}><button type="button" className={current ? "is-current" : ""} aria-current={current ? "true" : undefined} title={file.key.slice(file.key.lastIndexOf("/") + 1)} onClick={() => strip.onSelect(file)}>
          {thumb ? <img src={thumb} alt="" loading="lazy" draggable={false} /> : <Icon name="image" size={18} />}
        </button></li>;
      })}
    </ol>}
  </div>;
}
