/** 预览引擎独立打包并按需加载，普通文件列表不下载播放器和文本编辑器。 */
type TextEngine = typeof import("./preview-text-engine");
type MediaEngine = typeof import("./preview-media-engine");
type ComposerEngine = typeof import("./composer-engine");
type PdfEngine = typeof import("./preview-pdf-engine");
type Asset = { js: string; css?: string };
declare global {
  interface Window {
    tesseraPreviewAssets: { text: Asset; media: Asset; composer: Asset; pdf: Asset & { worker: string; base: string } };
    TesseraTextPreview?: TextEngine;
    TesseraMediaPreview?: MediaEngine;
    TesseraComposer?: ComposerEngine;
    TesseraPdfPreview?: PdfEngine;
  }
}

const pending = new Map<string, Promise<void>>();
function load(asset: Asset): Promise<void> {
  const existing = pending.get(asset.js);
  if (existing) return existing;
  const stylesheet = !asset.css || document.querySelector<HTMLLinkElement>(`link[href="${asset.css}"]`)?.sheet ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    const style = document.createElement("link");
    style.rel = "stylesheet"; style.href = asset.css!;
    style.onload = () => resolve();
    style.onerror = () => { style.remove(); reject(new Error("预览样式加载失败，请重试")); };
    document.head.append(style);
  });
  const scriptLoaded = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = asset.js; script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); reject(new Error("预览组件加载失败，请重试")); };
    document.head.append(script);
  });
  const promise = Promise.all([stylesheet, scriptLoaded]).then(() => {}).catch(reason => { pending.delete(asset.js); throw reason; });
  pending.set(asset.js, promise);
  return promise;
}
export async function loadTextEngine(): Promise<TextEngine> {
  await load(window.tesseraPreviewAssets.text);
  if (!window.TesseraTextPreview) throw new Error("文本预览组件未能启动");
  return window.TesseraTextPreview;
}
export async function loadMediaEngine(): Promise<MediaEngine> {
  await load(window.tesseraPreviewAssets.media);
  if (!window.TesseraMediaPreview) throw new Error("播放组件未能启动");
  return window.TesseraMediaPreview;
}
/** 文件助手的输入框（CodeMirror）：打开助手时才加载。 */
export async function loadComposerEngine(): Promise<ComposerEngine> {
  await load(window.tesseraPreviewAssets.composer);
  if (!window.TesseraComposer) throw new Error("输入框组件未能启动");
  return window.TesseraComposer;
}
/** PDF 预览（pdf.js）：打开 PDF 时才加载，Worker 与字体资源随后按需请求。 */
export async function loadPdfEngine(): Promise<{ engine: PdfEngine; assets: { worker: string; base: string } }> {
  const asset = window.tesseraPreviewAssets.pdf;
  await load(asset);
  if (!window.TesseraPdfPreview) throw new Error("PDF 预览组件未能启动");
  return { engine: window.TesseraPdfPreview, assets: { worker: asset.worker, base: asset.base } };
}
