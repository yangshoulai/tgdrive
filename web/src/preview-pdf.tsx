/** PDF 预览：pdf.js 绘制、界面自绘，与文本、图片预览同一套深色画布与浮动头部。
 * 页面纵向连续排列，只绘制视口附近的页（离开后释放画布）；默认适合宽度，可缩放、翻页、跳页和打开目录。文字层可以选择复制。 */
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "./api";
import { loadPdfEngine } from "./preview-runtime";
import { PreviewToolsContext } from "./preview-text";
import { Icon, IconButton } from "./ui";
import type { PdfDocument, PdfOutline } from "./preview-pdf-engine";

const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const GAP = 16;
type Zoom = "fit" | number;

export function PdfPreview({ url, name, onError }: { url: string; name: string; onError: (message: string) => void }) {
  const tools = useContext(PreviewToolsContext);
  const scroller = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [base, setBase] = useState<{ width: number; height: number }[]>([]);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [current, setCurrent] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [outline, setOutline] = useState<PdfOutline[] | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const errorRef = useRef(onError); errorRef.current = onError;

  useEffect(() => {
    const controller = new AbortController();
    let opened: PdfDocument | null = null;
    setDoc(null); setBase([]); setCurrent(1); setPageInput("1"); setOutline(null); setOutlineOpen(false); setZoom("fit");
    void loadPdfEngine().then(({ engine, assets }) => engine.openPdf(url, assets, controller.signal)).then(async value => {
      opened = value;
      if (controller.signal.aborted) { value.destroy(); return; }
      // 页面尺寸：先量第一页，其余先按第一页占位，再在后台逐页校正（不阻塞首屏）。
      const first = await value.size(1);
      if (controller.signal.aborted) return;
      setBase(Array.from({ length: value.pages }, () => first));
      setDoc(value);
      void value.outline().then(items => { if (!controller.signal.aborted) setOutline(items); }).catch(() => undefined);
      for (let page = 2; page <= Math.min(value.pages, 400) && !controller.signal.aborted; page++) {
        const size = await value.size(page).catch(() => first);
        if (size.width !== first.width || size.height !== first.height) setBase(list => list.map((item, index) => index === page - 1 ? size : item));
      }
    }).catch(reason => {
      if (controller.signal.aborted) return;
      const text = errorMessage(reason, "");
      errorRef.current(/password/i.test(text) ? "这个 PDF 设置了打开密码，暂不支持在线查看，请下载后打开。"
        : /Invalid PDF|InvalidPDF|bad XRef|structure/i.test(text) ? "文件不是有效的 PDF，或已经损坏。可以下载后用本地应用打开。"
        : "PDF 没有加载出来，请重试或下载后打开。");
    });
    return () => { controller.abort(); opened?.destroy(); };
  }, [url]);

  // 适合宽度：按滚动区宽度（减去两侧留白）计算；窗口大小变化时跟着重算。
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [doc]);
  const widest = useMemo(() => base.reduce((max, item) => Math.max(max, item.width), 0), [base]);
  const fitScale = widest && width ? Math.max(0.25, Math.min(4, (width - (width < 640 ? 16 : 48)) / widest)) : 1;
  const scale = zoom === "fit" ? fitScale : zoom;

  // 当前页：视口中线所在的页。
  const pageTops = useMemo(() => {
    let top = GAP;
    return base.map(item => { const value = top; top += Math.floor(item.height * scale) + GAP; return value; });
  }, [base, scale]);
  const onScroll = useCallback(() => {
    const node = scroller.current;
    if (!node || !pageTops.length) return;
    const middle = node.scrollTop + node.clientHeight / 3;
    let low = 0, high = pageTops.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (pageTops[mid] <= middle) low = mid; else high = mid - 1; }
    setCurrent(low + 1);
  }, [pageTops]);
  useEffect(() => { setPageInput(String(current)); }, [current]);
  const goTo = useCallback((page: number) => {
    const node = scroller.current;
    if (!node || !pageTops.length) return;
    const target = Math.max(1, Math.min(pageTops.length, page));
    node.scrollTo({ top: pageTops[target - 1] - GAP / 2 });
    setCurrent(target);
  }, [pageTops]);
  // 缩放时保持当前页在视野里。
  const anchor = useRef<{ page: number; offset: number } | null>(null);
  const changeZoom = (next: Zoom) => {
    const node = scroller.current;
    if (node && pageTops.length) {
      const page = current, top = pageTops[page - 1];
      anchor.current = { page, offset: (node.scrollTop - top) / scale };
    }
    setZoom(next);
  };
  useLayoutEffect(() => {
    const node = scroller.current, saved = anchor.current;
    if (!node || !saved || !pageTops.length) return;
    anchor.current = null;
    node.scrollTop = pageTops[saved.page - 1] + saved.offset * scale;
  }, [scale, pageTops]);
  const step = (direction: 1 | -1) => {
    const index = ZOOMS.findIndex(value => direction > 0 ? value > scale + 0.001 : value >= scale - 0.001);
    const next = direction > 0 ? ZOOMS[index === -1 ? ZOOMS.length - 1 : index] : ZOOMS[Math.max(0, (index === -1 ? ZOOMS.length : index) - 1)];
    changeZoom(next);
  };

  useEffect(() => {
    if (!outlineOpen) return;
    const outside = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest(".preview-outline-panel, .playlist-toggle")) setOutlineOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [outlineOpen]);
  // 键盘：翻页、首尾页与缩放；输入框里不接管。
  useEffect(() => {
    const node = scroller.current;
    if (!node || !doc) return;
    const handle = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : document.body;
      if (event.defaultPrevented || target.closest("input, textarea, select, [role=menu], [role=dialog]:not(.preview-modal)") || node.closest(".modal")?.classList.contains("is-minimized") || !node.closest(".modal")?.contains(target) && target !== document.body) return;
      if ((event.metaKey || event.ctrlKey) && (event.key === "=" || event.key === "+")) { event.preventDefault(); step(1); }
      else if ((event.metaKey || event.ctrlKey) && event.key === "-") { event.preventDefault(); step(-1); }
      else if ((event.metaKey || event.ctrlKey) && event.key === "0") { event.preventDefault(); changeZoom("fit"); }
      else if (event.metaKey || event.ctrlKey || event.altKey) return;
      else if (event.key === "PageDown" || event.key === "ArrowRight") { event.preventDefault(); goTo(current + 1); }
      else if (event.key === "PageUp" || event.key === "ArrowLeft") { event.preventDefault(); goTo(current - 1); }
      else if (event.key === "Home") { event.preventDefault(); goTo(1); }
      else if (event.key === "End") { event.preventDefault(); goTo(base.length); }
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  });

  // 目录：当前页之前（含）的最后一个条目算作「当前位置」。
  const flat = useMemo(() => outline ? flatten(outline) : [], [outline]);
  const activeItem = useMemo(() => { let found = -1; flat.forEach((item, index) => { if (item.page !== null && item.page <= current) found = index; }); return found; }, [flat, current]);

  const toolbar = doc && <div className="preview-pdf-tools" role="toolbar" aria-label="PDF 工具">
    {outline && outline.length > 0 && <IconButton icon="list" size="sm" label={outlineOpen ? "收起目录" : "目录"} className="playlist-toggle" active={outlineOpen} onClick={() => setOutlineOpen(value => !value)} />}
    <IconButton icon="chevronLeft" size="sm" label="上一页（PageUp）" className="preview-pdf-step" disabled={current <= 1} onClick={() => goTo(current - 1)} />
    <form className="preview-pdf-page" onSubmit={event => { event.preventDefault(); const value = Number(pageInput); if (Number.isFinite(value)) goTo(Math.round(value)); else setPageInput(String(current)); }}>
      <input aria-label="页码" inputMode="numeric" value={pageInput} onChange={event => setPageInput(event.target.value.replace(/\D/g, ""))} onBlur={() => setPageInput(String(current))}
        onFocus={event => event.currentTarget.select()} style={{ width: `${Math.max(2, String(base.length).length) + 1}ch` }} />
      <span>/ {base.length}</span>
    </form>
    <IconButton icon="chevronRight" size="sm" label="下一页（PageDown）" className="preview-pdf-step" disabled={current >= base.length} onClick={() => goTo(current + 1)} />
    <span className="preview-pdf-divider" aria-hidden="true" />
    <IconButton icon="zoomOut" size="sm" label="缩小（⌘/Ctrl −）" className="preview-pdf-step" disabled={scale <= ZOOMS[0] + 0.001} onClick={() => step(-1)} />
    <button type="button" className="preview-pdf-zoom" title={zoom === "fit" ? "当前适合宽度，点击切换为 100%" : "点击适合宽度（⌘/Ctrl 0）"} onClick={() => changeZoom(zoom === "fit" ? 1 : "fit")}>
      {zoom === "fit" ? "适合宽度" : `${Math.round(scale * 100)}%`}
    </button>
    <IconButton icon="zoomIn" size="sm" label="放大（⌘/Ctrl +）" className="preview-pdf-step" disabled={scale >= ZOOMS[ZOOMS.length - 1] - 0.001} onClick={() => step(1)} />
  </div>;

  return <div className={`preview-pdf${tools ? " is-immersive" : ""}`}>
    {toolbar && (tools ? createPortal(toolbar, tools) : <div className="preview-pdf-bar">{toolbar}</div>)}
    <div ref={scroller} className="preview-pdf-scroller" onScroll={onScroll} tabIndex={-1} aria-label={`${name}，共 ${base.length} 页`}>
      {!doc ? <div className="preview-pdf-loading" role="status"><span className="preview-pdf-spinner" aria-hidden="true" /><span>正在打开 PDF…</span></div>
        : <div className="preview-pdf-pages" style={{ paddingTop: GAP, paddingBottom: GAP }}>
          {base.map((size, index) => <PdfPage key={index} doc={doc} page={index + 1} width={Math.floor(size.width * scale)} height={Math.floor(size.height * scale)} scale={scale} root={scroller} />)}
        </div>}
    </div>
    {outlineOpen && outline && (() => {
      const panel = <aside className="preview-playlist-panel preview-outline-panel" aria-label="目录"
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOutlineOpen(false); } }}>
        <header>
          <div className="preview-playlist-title"><strong>目录</strong><span className="preview-playlist-count">共 {base.length} 页</span></div>
          <IconButton icon="x" label="收起目录" size="sm" onClick={() => setOutlineOpen(false)} />
        </header>
        <ol className="preview-playlist-items preview-outline-items">{flat.map((item, index) =>
          <li key={index}><button type="button" className={`preview-outline-item${index === activeItem ? " is-active" : ""}`} aria-current={index === activeItem ? "location" : undefined} data-level={Math.min(item.level, 2)} disabled={item.page === null}
            onClick={() => item.page && goTo(item.page)}>{item.title}</button></li>)}</ol>
      </aside>;
      // 挂到外层舞台上，固定在右侧而不随页面滚走。
      const stage = scroller.current?.closest<HTMLElement>(".preview-stage");
      return stage ? createPortal(panel, stage) : panel;
    })()}
  </div>;
}

function flatten(items: PdfOutline[], level = 0): { title: string; page: number | null; level: number }[] {
  return items.flatMap(item => [{ title: item.title, page: item.page, level }, ...(level < 4 ? flatten(item.items, level + 1) : [])]);
}

/** 单页：进入视口附近才绘制，离开较远时释放画布内存；缩放变化时重绘。 */
function PdfPage({ doc, page, width, height, scale, root }: { doc: PdfDocument; page: number; width: number; height: number; scale: number; root: RefObject<HTMLDivElement> }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [state, setState] = useState<"idle" | "drawing" | "done" | "failed">("idle");
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new IntersectionObserver(entries => setNear(entries[0].isIntersecting), { root: root.current, rootMargin: "120% 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    const target = canvas.current;
    if (!near || !target) { if (target && !near) { target.width = 0; target.height = 0; text.current?.replaceChildren(); setState("idle"); } return; }
    const controller = new AbortController();
    // 缩放连续变化时稍等再画，避免每一档都重绘。
    const timer = window.setTimeout(() => {
      setState(value => value === "done" ? value : "drawing");
      void doc.render(page, target, text.current, scale, controller.signal)
        .then(() => { if (!controller.signal.aborted) setState("done"); })
        .catch(() => { if (!controller.signal.aborted) setState("failed"); });
    }, 60);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [near, doc, page, scale]);
  return <div ref={host} className={`preview-pdf-page-sheet is-${state}`} style={{ width, height }} data-page={page}>
    <canvas ref={canvas} aria-hidden="true" />
    <div ref={text} className="preview-pdf-text" />
    {state === "failed" && <span className="preview-pdf-page-error"><Icon name="alert" size={16} />第 {page} 页没有画出来</span>}
  </div>;
}
