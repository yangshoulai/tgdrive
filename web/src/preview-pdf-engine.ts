/** PDF 预览引擎（按需加载）：pdf.js 解析与绘制，界面由 preview-pdf.tsx 自绘，不使用浏览器自带的 PDF 查看器。
 * Worker、字符映射（中日韩无内嵌字体的 PDF 需要）、标准字体与解码器都放在本站 /pdfjs/ 下，不加载外部资源。 */
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist";

export type PdfAssets = { worker: string; base: string };
export type PdfOutline = { title: string; page: number | null; items: PdfOutline[] };
export type PdfDocument = {
  pages: number;
  /** 第 n 页在 100% 缩放下的尺寸（CSS 像素）。 */
  size: (page: number) => Promise<{ width: number; height: number }>;
  /** 把第 n 页画到 canvas，并在 text 容器里铺上可选择的文字层；signal 中止时取消绘制。 */
  render: (page: number, canvas: HTMLCanvasElement, text: HTMLElement | null, scale: number, signal: AbortSignal) => Promise<void>;
  outline: () => Promise<PdfOutline[]>;
  destroy: () => void;
};

export async function openPdf(url: string, assets: PdfAssets, signal: AbortSignal): Promise<PdfDocument> {
  GlobalWorkerOptions.workerSrc = assets.worker;
  const task = getDocument({
    url, withCredentials: true,
    cMapUrl: `${assets.base}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${assets.base}standard_fonts/`, wasmUrl: `${assets.base}wasm/`, iccUrl: `${assets.base}iccs/`,
    // 按需分段读取（Range），只取看得到的页面。
    disableAutoFetch: true, rangeChunkSize: 1 << 20, enableXfa: false,
  });
  const abort = () => void task.destroy();
  signal.addEventListener("abort", abort, { once: true });
  let doc: PDFDocumentProxy;
  try { doc = await task.promise; }
  finally { signal.removeEventListener("abort", abort); }
  const pages = new Map<number, Promise<PDFPageProxy>>();
  const page = (number: number) => { let found = pages.get(number); if (!found) { found = doc.getPage(number); pages.set(number, found); } return found; };
  const resolveDest = async (dest: unknown): Promise<number | null> => {
    try {
      const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || !explicit[0]) return null;
      return typeof explicit[0] === "number" ? explicit[0] + 1 : await doc.getPageIndex(explicit[0]) + 1;
    } catch { return null; }
  };
  const convert = async (items: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>): Promise<PdfOutline[]> =>
    Promise.all((items ?? []).map(async item => ({ title: item.title || "（无标题）", page: await resolveDest(item.dest), items: await convert(item.items) })));
  return {
    pages: doc.numPages,
    size: async number => { const viewport = (await page(number)).getViewport({ scale: 1 }); return { width: viewport.width, height: viewport.height }; },
    render: async (number, canvas, text, scale, cancel) => {
      const target = await page(number);
      if (cancel.aborted) return;
      const viewport = target.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法绘制 PDF 页面");
      const task: RenderTask = target.render({ canvas, canvasContext: context, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      const stop = () => task.cancel();
      cancel.addEventListener("abort", stop, { once: true });
      try { await task.promise; }
      catch (reason) { if ((reason as { name?: string })?.name !== "RenderingCancelledException") throw reason; return; }
      finally { cancel.removeEventListener("abort", stop); }
      if (!text || cancel.aborted) return;
      text.replaceChildren();
      text.style.setProperty("--scale-factor", String(scale));
      const layer = new TextLayer({ textContentSource: target.streamTextContent(), container: text, viewport });
      cancel.addEventListener("abort", () => layer.cancel(), { once: true });
      await layer.render().catch(() => undefined);
    },
    outline: async () => convert(await doc.getOutline()),
    destroy: () => void task.destroy(),
  };
}
