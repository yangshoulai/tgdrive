/** HEIC／HEIF 解码 Worker（libheif 的 WebAssembly 版本）：Chrome 等浏览器不能直接显示 iPhone 照片时，在后台线程里解出主图像素，
 * 不阻塞页面。wasm 文件由页面告诉的地址加载，只在第一次需要时下载。 */
import libheif from "libheif-js/libheif-wasm/libheif.js";

type HeifImage = { get_width(): number; get_height(): number; display(target: { data: Uint8ClampedArray; width: number; height: number }, done: (result: unknown) => void): void; free?: () => void };
type Library = { HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[]; decoder: unknown }; heif_context_free?: (context: unknown) => void };

let library: Promise<Library> | null = null;
function load(wasm: string): Promise<Library> {
  library ??= fetch(wasm).then(response => {
    if (!response.ok) throw new Error("HEIC 解码组件加载失败");
    return response.arrayBuffer();
  }).then(binary => new Promise<Library>((resolve, reject) => {
    // Emscripten 把传入的选项对象本身当作模块返回；wasm 已经给出时初始化可能同步完成，所以用选项对象而不是返回值。
    const options: Record<string, unknown> = { wasmBinary: binary, onRuntimeInitialized: () => resolve(options as unknown as Library),
      onAbort: () => reject(new Error("HEIC 解码组件启动失败")) };
    libheif(options as never);
  }));
  library.catch(() => { library = null; });
  return library;
}

self.onmessage = async (event: MessageEvent<{ id: number; buffer: ArrayBuffer; wasm: string; maxPixels: number }>) => {
  const { id, buffer, wasm, maxPixels } = event.data;
  try {
    const lib = await load(wasm);
    const decoder = new lib.HeifDecoder();
    const images = decoder.decode(new Uint8Array(buffer));
    try {
      const image = images[0];
      if (!image) throw new Error("没有在文件里找到图片");
      const width = image.get_width(), height = image.get_height();
      if (width * height > maxPixels) throw new Error(`图片太大（${width}×${height}），浏览器无法解码`);
      const data = new Uint8ClampedArray(width * height * 4);
      await new Promise<void>((resolve, reject) => image.display({ data, width, height }, result => result ? resolve() : reject(new Error("HEIC 解码失败"))));
      (self as unknown as Worker).postMessage({ id, width, height, data }, [data.buffer]);
    } finally {
      for (const image of images) image.free?.();
      lib.heif_context_free?.(decoder.decoder);
    }
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : "HEIC 解码失败" });
  }
};
