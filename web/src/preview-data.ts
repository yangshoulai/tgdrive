/** 预览文本只进行有上限的流式读取；服务端忽略 Range 时也不会下载完整大文件。 */
export type PreviewText = { text: string; truncated: boolean; total: number | null };
export async function readPreviewText(url: string, limit: number, signal: AbortSignal): Promise<PreviewText> {
  const response = await fetch(url, { credentials: "include", headers: { Range: `bytes=0-${limit}` }, signal });
  if (response.status === 416 && response.headers.get("content-range") === "bytes */0") {
    await response.body?.cancel();
    return { text: "", truncated: false, total: 0 };
  }
  if (!response.ok) throw new Error(`无法读取文件（${response.status}）`);
  const totalRange = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  const contentLength = response.headers.get("content-length");
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
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const truncated = overflow || (total !== null && total > length);
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  try {
    // stream 避免截断后的半个多字节字符触发错误编码回退。
    const decoder = new TextDecoder(encoding, { fatal: true });
    return { text: decoder.decode(bytes, { stream: truncated }), truncated, total };
  } catch {
    return { text: new TextDecoder("gb18030").decode(bytes, { stream: truncated }), truncated, total };
  }
}
