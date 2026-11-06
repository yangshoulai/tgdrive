import type { TextEncodingName } from "./text-encoding";

/** 预览文本只进行有上限的流式读取；服务端忽略 Range 时也不会下载完整大文件。 */
export const TEXT_PREVIEW_LIMIT = 16 * 1024 * 1024;
/** encoding／bom 供编辑保存按原编码写回；exact 为假表示解码时有无法识别的字节（替换成了 �），不能安全编辑。 */
export type PreviewText = { text: string; truncated: boolean; total: number | null; encoding: TextEncodingName; bom: boolean; exact: boolean };
class IncompleteText extends Error {
  constructor() { super("文件读取不完整，请重试"); }
}
export async function readPreviewText(url: string, limit: number, signal: AbortSignal): Promise<PreviewText> {
  try { return await readText(url, limit, signal); }
  catch (reason) {
    if (!(reason instanceof IncompleteText)) throw reason;
    signal.throwIfAborted();
    // 小文件也可能只收到较短的范围响应；绕过 HTTP 缓存完整重读一次，仍按同一字节上限截断。
    return readText(url, limit, signal, true);
  }
}
async function readText(url: string, limit: number, signal: AbortSignal, retry = false): Promise<PreviewText> {
  const response = await fetch(url, { credentials: "include", headers: retry ? undefined : { Range: `bytes=0-${limit}` }, cache: retry ? "reload" : "default", signal });
  if (response.status === 416 && response.headers.get("content-range") === "bytes */0") {
    await response.body?.cancel();
    return { text: "", truncated: false, total: 0, encoding: "utf-8", bom: false, exact: true };
  }
  if (!response.ok) throw new Error(`无法读取文件（${response.status}）`);
  const totalRange = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  // fetch 已解压正文；压缩响应的 Content-Length 是传输大小，不能拿来判断文本是否完整。
  const encoded = response.headers.get("content-encoding");
  const contentLength = encoded && encoded !== "identity" ? null : response.headers.get("content-length");
  const total = totalRange ? Number(totalRange[1]) : response.status === 200 && contentLength ? Number(contentLength) : null;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("无法读取文件内容");
  const chunks: Uint8Array[] = [];
  let length = 0, overflow = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = limit - length;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining)); length += remaining; overflow = true;
        await reader.cancel(); break;
      }
      chunks.push(value); length += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  // 「没有读完」不等于「超过预览上限」：几 KB 的歌词缺了一段时应重读，不能误报超过 2 MB。
  const truncated = overflow || (total !== null && total > limit);
  if (!truncated && total !== null && total > length) throw new IncompleteText();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { ...decodeText(bytes, truncated), truncated, total };
}

/** 按 BOM 识别 UTF-16，其余先试 UTF-8，失败回退 GB18030；记录所用编码与 BOM，编辑保存时按原样写回。 */
export function decodeText(bytes: Uint8Array, truncated = false): { text: string; encoding: TextEncodingName; bom: boolean; exact: boolean } {
  let encoding: TextEncodingName = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  const bom = encoding !== "utf-8" || bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    // stream 避免截断后的半个多字节字符触发错误编码回退。
    return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated }), encoding, bom, exact: true };
  } catch {
    try { return { text: new TextDecoder("gb18030", { fatal: true }).decode(bytes, { stream: truncated }), encoding: "gb18030", bom: false, exact: true }; }
    catch { return { text: new TextDecoder("gb18030").decode(bytes, { stream: truncated }), encoding: "gb18030", bom: false, exact: false }; }
  }
}
