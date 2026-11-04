/** JSON／YAML／JSON Lines 结构视图：可折叠的树、按键名或值搜索并定位、复制节点路径与值。
 * 展开的节点拍平成行、只渲染可见部分，几十万个节点也能流畅滚动。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { loadTextEngine } from "./preview-runtime";
import { Button, Icon, IconButton, copyText } from "./ui";
import { stripJsonComments } from "./preview-parsers";

const ROW_HEIGHT = 26;
const OVERSCAN = 20;
const SEARCH_LIMIT = 500;
/** 「全部展开」最多展开的节点数，超过时只展开到能放下的层级。 */
const EXPAND_LIMIT = 20000;

type Parsed = { value: unknown; label: string } | { error: string };
type Row = { id: string; depth: number; key: string | null; value: unknown; container: boolean; size: number; open: boolean };

/** JSON（允许 // 与 /* *\/ 注释、末尾逗号的 JSONC）、JSON Lines 与 YAML 转成普通值。 */
export async function parseStructured(text: string, name: string): Promise<Parsed> {
  const lower = name.toLowerCase();
  try {
    if (/\.ya?ml$/.test(lower)) {
      const { value, documents } = (await loadTextEngine()).parseYaml(text);
      return { value, label: documents > 1 ? `YAML · ${documents} 个文档` : "YAML" };
    }
    if (/\.(jsonl|ndjson)$/.test(lower)) {
      const lines = text.split(/\r?\n/).filter(line => line.trim());
      return { value: lines.map((line, index) => {
        try { return JSON.parse(line); } catch { throw new Error(`第 ${index + 1} 行不是有效的 JSON`); }
      }), label: `JSON Lines · ${lines.length.toLocaleString()} 行` };
    }
    try { return { value: JSON.parse(text.replace(/^\uFEFF/, "")), label: "JSON" }; }
    catch (error) {
      const relaxed = stripJsonComments(text);
      if (relaxed === text) throw error;
      return { value: JSON.parse(relaxed), label: "JSON（含注释）" };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "无法解析文件内容" };
  }
}

const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] => typeof value === "object" && value !== null;
const entriesOf = (value: Record<string, unknown> | unknown[]): [string, unknown][] =>
  Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
const sizeOf = (value: Record<string, unknown> | unknown[]) => Array.isArray(value) ? value.length : Object.keys(value).length;
const childId = (parent: string, key: string, array: boolean) => array ? `${parent}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;

function flatten(root: unknown, open: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (value: unknown, id: string, key: string | null, depth: number) => {
    const container = isContainer(value);
    const expanded = container && open.has(id);
    rows.push({ id, depth, key, value, container, size: container ? sizeOf(value) : 0, open: expanded });
    if (!expanded) return;
    const array = Array.isArray(value);
    for (const [name, child] of entriesOf(value)) walk(child, childId(id, name, array), name, depth + 1);
  };
  walk(root, "$", null, 0);
  return rows;
}

/** 展开到第 depth 层，节点总数不超过上限。 */
function expandTo(root: unknown, depth: number): Set<string> {
  const open = new Set<string>();
  let count = 0;
  const walk = (value: unknown, id: string, level: number) => {
    if (!isContainer(value) || level >= depth || count > EXPAND_LIMIT) return;
    open.add(id); count += sizeOf(value);
    const array = Array.isArray(value);
    for (const [name, child] of entriesOf(value)) walk(child, childId(id, name, array), level + 1);
  };
  walk(root, "$", 0);
  return open;
}

/** 键名或值（字符串、数字、布尔）包含关键词的节点，最多 SEARCH_LIMIT 个。 */
function search(root: unknown, terms: string): { id: string; ancestors: string[] }[] {
  const found: { id: string; ancestors: string[] }[] = [];
  const walk = (value: unknown, id: string, key: string | null, ancestors: string[]) => {
    if (found.length >= SEARCH_LIMIT) return;
    const scalar = !isContainer(value) && value !== null && String(value).toLowerCase().includes(terms);
    if ((key !== null && key.toLowerCase().includes(terms)) || scalar) found.push({ id, ancestors });
    if (!isContainer(value)) return;
    const array = Array.isArray(value), path = [...ancestors, id];
    for (const [name, child] of entriesOf(value)) walk(child, childId(id, name, array), array ? null : name, path);
  };
  walk(root, "$", null, []);
  return found;
}

function scalarText(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return value === null ? "null" : String(value);
}
const scalarKind = (value: unknown) => value === null ? "null" : typeof value === "string" ? "string" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "other";

export function TreePreview({ text, name, truncated }: { text: string; name: string; truncated: boolean }) {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  useEffect(() => {
    let alive = true;
    setParsed(null);
    void parseStructured(text, name).then(result => { if (alive) setParsed(result); });
    return () => { alive = false; };
  }, [text, name]);
  if (!parsed) return <div className="preview-engine-loading" role="status"><span className="spinner" />正在解析…</div>;
  if ("error" in parsed) return <div className="preview-structured-error" role="alert">
    <Icon name="alert" size={18} /><div><strong>{truncated ? "文件太大，只读取了开头部分，无法按结构显示" : "无法按结构显示"}</strong><p>{parsed.error}</p><p>可以切换到「源码」查看原文。</p></div>
  </div>;
  return <Tree value={parsed.value} label={parsed.label} />;
}

function Tree({ value, label }: { value: unknown; label: string }) {
  const [open, setOpen] = useState<Set<string>>(() => expandTo(value, 2));
  const [selected, setSelected] = useState<string>("$");
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState(0);
  const rows = useMemo(() => flatten(value, open), [value, open]);
  const terms = query.trim().toLowerCase();
  const [results, setResults] = useState<{ id: string; ancestors: string[] }[]>([]);
  useEffect(() => {
    if (!terms) { setResults([]); return; }
    const timer = window.setTimeout(() => { setResults(search(value, terms)); setMatch(0); }, 200);
    return () => window.clearTimeout(timer);
  }, [value, terms]);
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const update = () => setViewport({ top: node.scrollTop, height: node.clientHeight });
    const observer = new ResizeObserver(update);
    observer.observe(node); update();
    node.addEventListener("scroll", update, { passive: true });
    return () => { observer.disconnect(); node.removeEventListener("scroll", update); };
  }, []);
  const reveal = (id: string, ancestors: string[]) => {
    setOpen(current => { const next = new Set(current); for (const item of ancestors) next.add(item); return next; });
    setSelected(id);
  };
  useEffect(() => { const target = results[match]; if (target) reveal(target.id, target.ancestors); }, [results, match]);
  // 选中的行滚到可见范围内。
  useEffect(() => {
    const index = rows.findIndex(row => row.id === selected), node = scroller.current;
    if (index < 0 || !node) return;
    const top = index * ROW_HEIGHT;
    if (top < node.scrollTop || top + ROW_HEIGHT > node.scrollTop + node.clientHeight) node.scrollTo({ top: Math.max(0, top - node.clientHeight / 3) });
  }, [selected, rows]);
  const toggle = (row: Row) => setOpen(current => {
    const next = new Set(current);
    if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
    return next;
  });
  const hits = useMemo(() => new Set(results.map(item => item.id)), [results]);
  const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN);
  const current = rows.find(row => row.id === selected);
  const copyValue = () => current && void copyText(current.container ? JSON.stringify(current.value, null, 2) : typeof current.value === "string" ? current.value : scalarText(current.value), "值已复制");
  const step = (delta: number) => results.length && setMatch(index => (index + delta + results.length) % results.length);

  return <div className="preview-tree">
    <div className="preview-table-bar">
      <label className="preview-table-search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="搜索键名或值" aria-label="搜索键名或值" value={query} spellCheck={false} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); } }} />
      </label>
      {terms && <span className="preview-table-count">{results.length ? `${match + 1} / ${results.length}${results.length >= SEARCH_LIMIT ? "+" : ""}` : "没有匹配"}</span>}
      {terms && results.length > 1 && <>
        <IconButton icon="chevronUp" label="上一个（Shift+Enter）" size="sm" onClick={() => step(-1)} />
        <IconButton icon="chevronDown" label="下一个（Enter）" size="sm" onClick={() => step(1)} />
      </>}
      <span className="preview-table-spacer" />
      <Button size="sm" variant="ghost" onClick={() => setOpen(expandTo(value, 6))}>全部展开</Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(new Set(["$"]))}>全部收起</Button>
      <span className="preview-table-count">{label}</span>
    </div>
    <div ref={scroller} className="preview-tree-scroll" role="tree" aria-label="结构">
      <div className="preview-tree-body" style={{ height: rows.length * ROW_HEIGHT }}>
        {rows.slice(first, last).map((row, offset) => <div key={row.id} role="treeitem" aria-expanded={row.container ? row.open : undefined} aria-selected={row.id === selected}
          className={`preview-tree-row${row.id === selected ? " is-selected" : ""}${hits.has(row.id) ? " is-hit" : ""}`}
          style={{ top: (first + offset) * ROW_HEIGHT, paddingLeft: 8 + row.depth * 16 }}
          onClick={() => { setSelected(row.id); if (row.container) toggle(row); }}>
          <span className="preview-tree-caret">{row.container && <Icon name="chevronRight" size={12} className={row.open ? "is-open" : undefined} />}</span>
          {row.key !== null && <span className="preview-tree-key">{row.key}</span>}
          {row.key !== null && <span className="preview-tree-colon">:</span>}
          {row.container
            ? <span className="preview-tree-summary">{Array.isArray(row.value) ? `[ ${row.size} 项 ]` : `{ ${row.size} 个键 }`}</span>
            : <span className={`preview-tree-value is-${scalarKind(row.value)}`}>{scalarText(row.value)}</span>}
        </div>)}
      </div>
    </div>
    <div className="preview-tree-path">
      <code title={selected}>{selected}</code>
      <IconButton icon="copy" label="复制路径" size="sm" onClick={() => void copyText(selected, "路径已复制")} />
      <Button size="sm" variant="ghost" disabled={!current} onClick={copyValue}>复制值</Button>
    </div>
  </div>;
}
