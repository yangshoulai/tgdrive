/** 按行比较两段文本（文件助手编辑文本文件的确认卡片用）。
 *  先去掉相同的开头与结尾，中间用 Myers 算法求最短编辑；改动过多（估算的计算量超过上限）时退化为整段删除加整段新增，
 *  不会因为大文件占满内存或卡住页面。 */
export type DiffLine = { type: "same" | "add" | "del"; text: string; oldNo?: number; newNo?: number };
export type DiffPart = { type: "lines"; lines: DiffLine[] } | { type: "skip"; count: number; from: number };

const WORK_LIMIT = 4_000_000;
const split = (text: string) => text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

/** Myers 最短编辑路径：返回中间部分的增删序列；超出计算量上限返回 null。 */
function myers(a: string[], b: string[]): DiffLine[] | null {
  const n = a.length, m = b.length, max = n + m, offset = max;
  const trace: Int32Array[] = [];
  const v = new Int32Array(2 * max + 2);
  for (let d = 0; d <= max; d++) {
    if ((d + 1) * (2 * max + 2) > WORK_LIMIT) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset);
    }
  }
  return null;
}

/** trace[d] 是第 d 步开始前的状态：从终点倒推每一步来自哪条对角线。 */
function backtrack(trace: Int32Array[], a: string[], b: string[], depth: number, offset: number): DiffLine[] {
  const out: DiffLine[] = [];
  let x = a.length, y = b.length;
  for (let d = depth; d >= 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : prev[offset + prevK], prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; out.push({ type: "same", text: a[x] }); }
    if (d > 0) {
      if (down) { y--; out.push({ type: "add", text: b[y] }); }
      else { x--; out.push({ type: "del", text: a[x] }); }
    }
  }
  return out.reverse();
}

/** start：这段文本第一行在文件中的行号（服务器只交出有变化的一段时用）。 */
export function diffLines(before: string, after: string, start = 1): DiffLine[] {
  const a = split(before), b = split(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail), midB = b.slice(head, b.length - tail);
  const middle = myers(midA, midB) ?? [...midA.map(text => ({ type: "del" as const, text })), ...midB.map(text => ({ type: "add" as const, text }))];
  const lines: DiffLine[] = [...a.slice(0, head).map(text => ({ type: "same" as const, text })), ...middle,
    ...a.slice(a.length - tail).map(text => ({ type: "same" as const, text }))];
  let oldNo = start - 1, newNo = start - 1;
  for (const line of lines) {
    if (line.type !== "add") line.oldNo = ++oldNo;
    if (line.type !== "del") line.newNo = ++newNo;
  }
  return lines;
}

/** 把未改动的长段折叠起来：每处改动前后各保留 context 行。 */
export function diffParts(lines: DiffLine[], context = 3): DiffPart[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((line, index) => {
    if (line.type === "same") return;
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) keep[i] = 1;
  });
  const parts: DiffPart[] = [];
  let index = 0;
  while (index < lines.length) {
    if (keep[index]) {
      const start = index;
      while (index < lines.length && keep[index]) index++;
      parts.push({ type: "lines", lines: lines.slice(start, index) });
    } else {
      const start = index;
      while (index < lines.length && !keep[index]) index++;
      parts.push({ type: "skip", count: index - start, from: start });
    }
  }
  return parts;
}
