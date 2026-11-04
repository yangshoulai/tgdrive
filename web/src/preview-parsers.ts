/** 预览用的纯解析函数（CSV、JSONC、Notebook、字体表），不依赖 React 与页面，便于单独测试。 */

export const DELIMITERS = [",", "\t", ";", "|"] as const;
export type Delimiter = typeof DELIMITERS[number];

/** RFC 4180：双引号包住的字段里可以有分隔符、换行和成对的双引号。 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, index = 0;
  if (text.charCodeAt(0) === 0xfeff) index = 1;
  for (; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; } else quoted = false;
      } else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** 按前几行判断分隔符：每行字段数一致且大于 1 的分隔符得分最高。 */
export function detectDelimiter(text: string, name: string): Delimiter {
  if (/\.tsv$/i.test(name)) return "\t";
  const sample = text.slice(0, 64 * 1024);
  let best: Delimiter = ",", score = -1;
  for (const delimiter of DELIMITERS) {
    const counts = parseDelimited(sample, delimiter).slice(0, 20).map(row => row.length);
    if (!counts.length || counts[0] < 2) continue;
    const same = counts.filter(count => count === counts[0]).length;
    const value = same * 10 + counts[0];
    if (value > score) { score = value; best = delimiter; }
  }
  return best;
}

/** 去掉字符串之外的注释与对象、数组末尾的逗号。 */
export function stripJsonComments(text: string): string {
  let out = "", index = 0, string = false;
  while (index < text.length) {
    const char = text[index], next = text[index + 1];
    if (string) {
      out += char;
      if (char === "\\") { out += next ?? ""; index += 2; continue; }
      if (char === '"') string = false;
      index++; continue;
    }
    if (char === '"') { string = true; out += char; index++; continue; }
    if (char === "/" && next === "/") { while (index < text.length && text[index] !== "\n") index++; continue; }
    if (char === "/" && next === "*") { index = text.indexOf("*/", index + 2); index = index < 0 ? text.length : index + 2; continue; }
    out += char; index++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export type Lines = string | string[];
export type Output = { output_type: string; name?: string; text?: Lines; data?: Record<string, Lines>; execution_count?: number | null; ename?: string; evalue?: string; traceback?: string[] };
export type Cell = { cell_type: string; source?: Lines; outputs?: Output[]; execution_count?: number | null; attachments?: Record<string, Record<string, string>> };
type Notebook = { cells?: Cell[]; metadata?: { kernelspec?: { display_name?: string; language?: string }; language_info?: { name?: string } }; nbformat?: number;
  worksheets?: { cells?: Cell[] }[] };
export function parseNotebook(text: string): { cells: Cell[]; language: string; kernel: string } {
  const notebook = JSON.parse(text) as Notebook;
  if (!notebook || typeof notebook !== "object") throw new Error("不是有效的 Notebook 文件");
  // nbformat 3 把单元格放在 worksheets 里，代码单元格的源码字段叫 input。
  const cells = (notebook.cells ?? notebook.worksheets?.flatMap(sheet => sheet.cells ?? []) ?? []).map(cell => ({
    ...cell, source: cell.source ?? (cell as { input?: Lines }).input,
  }));
  if (!Array.isArray(cells)) throw new Error("Notebook 里没有单元格");
  const language = notebook.metadata?.language_info?.name || notebook.metadata?.kernelspec?.language || "python";
  return { cells, language, kernel: notebook.metadata?.kernelspec?.display_name || language };
}

export type FontInfo = { format: string; family?: string; style?: string; full?: string; version?: string; designer?: string; maker?: string; copyright?: string; license?: string;
  glyphs?: number; codepoints: number[] | null };

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 读出字体表：sfnt（TrueType、OpenType、字体集合里的第一个字体）直接取，WOFF 逐表解压。 */
async function readTables(buffer: ArrayBuffer): Promise<{ format: string; tables: Map<string, DataView> } | { format: string; tables: null }> {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  const tag = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  const signature = tag(0);
  const tables = new Map<string, DataView>();
  if (signature === "wOF2") return { format: "WOFF2", tables: null };
  if (signature === "wOFF") {
    const count = view.getUint16(12);
    for (let index = 0; index < count; index++) {
      const entry = 44 + index * 20, offset = view.getUint32(entry + 4), compressed = view.getUint32(entry + 8), original = view.getUint32(entry + 12);
      const raw = bytes.subarray(offset, offset + compressed);
      const data = compressed < original ? await inflate(raw) : raw;
      tables.set(tag(entry), new DataView(data.buffer, data.byteOffset, data.byteLength));
    }
    return { format: "WOFF", tables };
  }
  let base = 0, format = signature === "OTTO" ? "OpenType（CFF）" : "TrueType";
  if (signature === "ttcf") { base = view.getUint32(12); format = `字体集合（${view.getUint32(8)} 个字体，显示第一个）`; }
  const count = view.getUint16(base + 4);
  for (let index = 0; index < count; index++) {
    const entry = base + 12 + index * 16, offset = view.getUint32(entry + 8), length = view.getUint32(entry + 12);
    if (offset + length <= buffer.byteLength) tables.set(tag(entry), new DataView(buffer, offset, length));
  }
  return { format, tables };
}

function readNames(table: DataView | undefined): Partial<Record<number, string>> {
  if (!table) return {};
  const count = table.getUint16(2), storage = table.getUint16(4);
  const names: Partial<Record<number, { text: string; score: number }>> = {};
  for (let index = 0; index < count; index++) {
    const record = 6 + index * 12;
    const platform = table.getUint16(record), encoding = table.getUint16(record + 2), language = table.getUint16(record + 4), id = table.getUint16(record + 6);
    const length = table.getUint16(record + 8), offset = storage + table.getUint16(record + 10);
    if (offset + length > table.byteLength) continue;
    const raw = new Uint8Array(table.buffer, table.byteOffset + offset, length);
    let text: string;
    if (platform === 3 || platform === 0) {
      if (platform === 3 && encoding !== 1 && encoding !== 10 && encoding !== 0) continue;
      text = new TextDecoder("utf-16be").decode(raw);
    } else if (platform === 1 && encoding === 0) text = new TextDecoder("macintosh").decode(raw);
    else continue;
    // 优先简体中文名，其次英文，再其次任意语言。
    const score = platform === 3 && (language === 0x0804 || language === 0x0404) ? 3 : platform === 3 && language === 0x0409 ? 2 : 1;
    if (!names[id] || score > names[id]!.score) names[id] = { text: text.replace(/\0/g, "").trim(), score };
  }
  return Object.fromEntries(Object.entries(names).map(([id, value]) => [id, value!.text]));
}

/** cmap 里能映射到字形的码位：优先完整 Unicode 的格式 12，其次 BMP 的格式 4。 */
function readCodepoints(table: DataView | undefined): number[] | null {
  if (!table) return null;
  const count = table.getUint16(2);
  let best: { offset: number; format: number } | null = null;
  for (let index = 0; index < count; index++) {
    const platform = table.getUint16(4 + index * 8), encoding = table.getUint16(6 + index * 8), offset = table.getUint32(8 + index * 8);
    if (offset >= table.byteLength) continue;
    const format = table.getUint16(offset);
    const unicode = platform === 0 || platform === 3 && (encoding === 1 || encoding === 10);
    if (!unicode || (format !== 4 && format !== 12)) continue;
    if (!best || format === 12 && best.format !== 12) best = { offset, format };
  }
  if (!best) return null;
  const points = new Set<number>(), at = best.offset;
  if (best.format === 12) {
    const groups = table.getUint32(at + 12);
    for (let index = 0; index < groups && points.size < 200000; index++) {
      const start = table.getUint32(at + 16 + index * 12), end = table.getUint32(at + 20 + index * 12);
      for (let code = start; code <= end && points.size < 200000; code++) points.add(code);
    }
  } else {
    const segments = table.getUint16(at + 6) / 2;
    const ends = at + 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, ranges = deltas + segments * 2;
    for (let index = 0; index < segments; index++) {
      const end = table.getUint16(ends + index * 2), start = table.getUint16(starts + index * 2);
      const delta = table.getInt16(deltas + index * 2), range = table.getUint16(ranges + index * 2);
      for (let code = start; code <= end && code !== 0xffff; code++) {
        let glyph: number;
        if (range === 0) glyph = (code + delta) & 0xffff;
        else {
          const position = ranges + index * 2 + range + (code - start) * 2;
          glyph = position + 2 <= table.byteLength ? table.getUint16(position) : 0;
          if (glyph) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph) points.add(code);
      }
    }
  }
  // 控制字符与私用区之外的才显示。
  return [...points].filter(code => code > 0x20 && !(code >= 0x7f && code < 0xa0) && !(code >= 0xe000 && code <= 0xf8ff)).sort((a, b) => a - b);
}

export async function readFontInfo(buffer: ArrayBuffer): Promise<FontInfo> {
  const { format, tables } = await readTables(buffer);
  if (!tables) return { format, codepoints: null };
  const names = readNames(tables.get("name"));
  const maxp = tables.get("maxp");
  return { format, family: names[16] || names[1], style: names[17] || names[2], full: names[4], version: names[5], designer: names[9], maker: names[8],
    copyright: names[0], license: names[13], glyphs: maxp && maxp.byteLength >= 6 ? maxp.getUint16(4) : undefined, codepoints: readCodepoints(tables.get("cmap")) };
}

