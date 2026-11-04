/** 浏览器不能直接显示 HEIC／HEIF（Chrome、Firefox）时，在 Worker 里用 libheif 解码，再转成 JPEG 供 <img> 与图片编辑使用。 */
const HEIF_LIMIT = 128 * 1024 * 1024;
/** 最多解码 6400 万像素（RGBA 约 256 MB），更大的照片只能下载后查看。 */
const MAX_PIXELS = 64_000_000;

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, { resolve: (value: ImageData) => void; reject: (reason: Error) => void }>();

function heifWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(window.tesseraPreviewAssets.heif.worker);
  worker.onmessage = (event: MessageEvent<{ id: number; width?: number; height?: number; data?: Uint8ClampedArray; error?: string }>) => {
    const { id, width, height, data, error } = event.data, pending = waiting.get(id);
    if (!pending) return;
    waiting.delete(id);
    if (error || !data || !width || !height) pending.reject(new Error(error || "HEIC 解码失败"));
    else pending.resolve(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height));
  };
  worker.onerror = () => {
    for (const pending of waiting.values()) pending.reject(new Error("HEIC 解码组件出错，请刷新页面后重试"));
    waiting.clear(); worker?.terminate(); worker = null;
  };
  return worker;
}

export async function decodeHeifBuffer(buffer: ArrayBuffer): Promise<ImageData> {
  const id = ++nextId;
  return new Promise<ImageData>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    heifWorker().postMessage({ id, buffer, wasm: window.tesseraPreviewAssets.heif.wasm, maxPixels: MAX_PIXELS }, [buffer]);
  });
}

/** 读取并解码 HEIC，返回 JPEG（画质 0.92）与原图尺寸。 */
export async function decodeHeif(url: string, signal?: AbortSignal): Promise<{ blob: Blob; width: number; height: number }> {
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) throw new Error(`无法读取图片（${response.status}）`);
  if (Number(response.headers.get("content-length") || 0) > HEIF_LIMIT) { await response.body?.cancel(); throw new Error("图片文件太大，请下载后查看"); }
  const image = await decodeHeifBuffer(await response.arrayBuffer());
  signal?.throwIfAborted();
  const canvas = document.createElement("canvas");
  canvas.width = image.width; canvas.height = image.height;
  canvas.getContext("2d")!.putImageData(image, 0, 0);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.92));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error("图片转换失败");
  return { blob, width: image.width, height: image.height };
}

export const isHeif = (name: string, type?: string | null) => /\.(heic|heif)$/i.test(name) || /^image\/hei[cf]/i.test(type ?? "");
