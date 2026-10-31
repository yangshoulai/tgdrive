/**
 * 文本编辑保存时按原编码写回：UTF-8（保留 BOM）、带 BOM 的 UTF-16LE／BE、GB18030。
 * 浏览器只提供 UTF-8 编码器；GB18030 的反向表在第一次需要时用浏览器自带的解码器逐个解出双字节与四字节码位建立，不打包码表。
 */
export type TextEncodingName = "utf-8" | "utf-16le" | "utf-16be" | "gb18030";

export const ENCODING_LABEL: Record<TextEncodingName, string> = { "utf-8": "UTF-8", "utf-16le": "UTF-16 LE", "utf-16be": "UTF-16 BE", gb18030: "GB18030" };

export function encodeText(text: string, encoding: TextEncodingName, bom: boolean): Uint8Array {
  if (encoding === "utf-8") {
    const body = new TextEncoder().encode(text);
    if (!bom) return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]); out.set(body, 3);
    return out;
  }
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    // 预览只按 BOM 识别 UTF-16，所以写回时总是带 BOM。
    const out = new Uint8Array(2 + text.length * 2), little = encoding === "utf-16le";
    out.set(little ? [0xff, 0xfe] : [0xfe, 0xff]);
    for (let index = 0; index < text.length; index++) {
      const unit = text.charCodeAt(index), at = 2 + index * 2;
      out[at] = little ? unit & 0xff : unit >> 8;
      out[at + 1] = little ? unit >> 8 : unit & 0xff;
    }
    return out;
  }
  return encodeGb18030(text);
}

let gbTable: Map<number, number> | null = null;
/** 码位 → GB18030 字节（打包成整数：双字节 0xAABB，四字节 0xAABBCCDD）。只覆盖 BMP，增补平面按算法计算。 */
function gbMap() {
  if (gbTable) return gbTable;
  const table = new Map<number, number>(), decoder = new TextDecoder("gb18030", { fatal: true });
  const pair = new Uint8Array(2), quad = new Uint8Array(4);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      pair[0] = lead; pair[1] = trail;
      try {
        const char = decoder.decode(pair);
        if (char.length === 1 && !table.has(char.charCodeAt(0))) table.set(char.charCodeAt(0), lead << 8 | trail);
      } catch { /* 未分配的双字节组合 */ }
    }
  }
  // 其余 BMP 码位落在四字节区：0x81308130 起按线性序号排列（共 39420 个）。
  for (let linear = 0; linear < 39420; linear++) {
    quad[0] = 0x81 + Math.floor(linear / 12600); quad[1] = 0x30 + Math.floor(linear / 1260) % 10;
    quad[2] = 0x81 + Math.floor(linear / 10) % 126; quad[3] = 0x30 + linear % 10;
    try {
      const char = decoder.decode(quad);
      const code = char.charCodeAt(0);
      if (char.length === 1 && !table.has(code)) table.set(code, ((quad[0] << 24) | (quad[1] << 16) | (quad[2] << 8) | quad[3]) >>> 0);
    } catch { /* 保留区 */ }
  }
  gbTable = table;
  return table;
}

function encodeGb18030(text: string): Uint8Array {
  const table = gbMap(), out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) { out.push(code); continue; }
    if (code >= 0x10000) {
      // 增补平面：0x90308130 起按 (码位 − 0x10000) 线性排列。
      const linear = code - 0x10000;
      out.push(0x90 + Math.floor(linear / 12600), 0x30 + Math.floor(linear / 1260) % 10, 0x81 + Math.floor(linear / 10) % 126, 0x30 + linear % 10);
      continue;
    }
    const bytes = table.get(code);
    if (bytes === undefined) throw new Error(`字符 U+${code.toString(16).toUpperCase().padStart(4, "0")} 无法用 GB18030 保存`);
    if (bytes > 0xffff) out.push(bytes >>> 24, (bytes >> 16) & 0xff, (bytes >> 8) & 0xff, bytes & 0xff);
    else out.push(bytes >> 8, bytes & 0xff);
  }
  return Uint8Array.from(out);
}
