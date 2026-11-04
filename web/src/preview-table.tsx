/** CSV／TSV 表格视图：自动识别分隔符，首行可作表头，按列排序（数字按数值）、按内容筛选；只渲染可见的行，十几 MB 的表也不卡。 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Icon, Switch, copyText } from "./ui";
import { DELIMITERS, detectDelimiter, parseDelimited, type Delimiter } from "./preview-parsers";

const ROW_HEIGHT = 32;
const OVERSCAN = 12;
const DELIMITER_LABEL: Record<Delimiter, string> = { ",": "逗号", "\t": "制表符", ";": "分号", "|": "竖线" };

const numeric = (value: string) => /^\s*[-+]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:e[-+]?\d+)?%?\s*$/i.test(value);
const toNumber = (value: string) => Number(value.replace(/[,%\s]/g, ""));
/** 首行像表头：至少一列是非数字文字，且下一行同一列是数字或首行没有重复值。 */
function looksLikeHeader(rows: string[][]): boolean {
  const [first, second] = rows;
  if (!first || !second) return false;
  if (new Set(first).size !== first.length) return false;
  return first.some((cell, index) => cell.trim() && !numeric(cell) && (second[index] === undefined || numeric(second[index]) || second[index] !== cell));
}

export function TablePreview({ text, name, truncated }: { text: string; name: string; truncated: boolean }) {
  const [delimiter, setDelimiter] = useState<Delimiter>(() => detectDelimiter(text, name));
  const rows = useMemo(() => {
    const parsed = parseDelimited(text, delimiter);
    // 截断的文件最后一行可能不完整，不显示。
    if (truncated && parsed.length > 1) parsed.pop();
    return parsed;
  }, [text, delimiter, truncated]);
  const [header, setHeader] = useState(() => looksLikeHeader(rows));
  const columns = useMemo(() => rows.reduce((max, row) => Math.max(max, row.length), 0), [rows]);
  const titles = header && rows.length ? rows[0] : [];
  const body = header ? rows.slice(1) : rows;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ column: number; desc: boolean } | null>(null);
  const shown = useMemo(() => {
    const terms = query.trim().toLowerCase();
    let list = body.map((row, index) => ({ row, index }));
    if (terms) list = list.filter(item => item.row.some(cell => cell.toLowerCase().includes(terms)));
    if (sort) {
      const values = list.map(item => item.row[sort.column] ?? "");
      const allNumbers = values.every(value => !value.trim() || numeric(value));
      const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
      list = list.map((item, position) => ({ item, value: values[position] }))
        .sort((a, b) => {
          const left = a.value.trim(), right = b.value.trim();
          if (!left !== !right) return left ? -1 : 1;  // 空值总在最后
          const order = allNumbers ? toNumber(left) - toNumber(right) : collator.compare(left, right);
          return sort.desc ? -order : order;
        }).map(entry => entry.item);
    }
    return list;
  }, [body, query, sort]);
  // 列宽按表头与前 200 行的内容长度估算（中文按两个字宽），限制在 72–360 像素。
  const widths = useMemo(() => {
    const units = (value: string) => [...value.slice(0, 80)].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
    return Array.from({ length: columns }, (_, column) => {
      let longest = units(titles[column] ?? "") + 2;
      for (const row of body.slice(0, 200)) longest = Math.max(longest, units(row[column] ?? ""));
      return Math.max(72, Math.min(360, longest * 8 + 32));
    });
  }, [columns, body, titles]);
  const numberWidth = Math.max(48, String(body.length).length * 8 + 24);
  const template = `${numberWidth}px ${widths.map(width => `${Math.round(width)}px`).join(" ")}`;

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
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [query, sort, delimiter, header]);
  const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(shown.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN);
  const toggleSort = (column: number) => setSort(current => current?.column !== column ? { column, desc: false } : current.desc ? null : { column, desc: true });

  return <div className="preview-table">
    <div className="preview-table-bar">
      <label className="preview-table-search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="筛选行" aria-label="筛选行" value={query} spellCheck={false} onChange={event => setQuery(event.target.value)} />
      </label>
      <label className="preview-table-select"><span>分隔符</span>
        <select className="input input-sm" value={delimiter} onChange={event => { setDelimiter(event.target.value as Delimiter); setSort(null); }}>
          {DELIMITERS.map(value => <option key={value} value={value}>{DELIMITER_LABEL[value]}</option>)}
        </select>
      </label>
      <Switch compact label="首行作为表头" checked={header} onChange={value => { setHeader(value); setSort(null); }} />
      <span className="preview-table-header-label" aria-hidden="true">首行作为表头</span>
      <span className="preview-table-count">{query.trim() ? `${shown.length.toLocaleString()} / ${body.length.toLocaleString()} 行` : `${body.length.toLocaleString()} 行 × ${columns} 列`}</span>
    </div>
    <div ref={scroller} className="preview-table-scroll" role="table" aria-label={name} aria-rowcount={shown.length + 1} style={{ "--table-columns": template } as CSSProperties}>
      <div className="preview-table-row is-head" role="row">
        <span role="columnheader" className="preview-table-number">#</span>
        {Array.from({ length: columns }, (_, column) => {
          const active = sort?.column === column;
          return <span role="columnheader" key={column} aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
            <button type="button" className={`preview-table-sort${active ? " is-active" : ""}`} title="点击排序" onClick={() => toggleSort(column)}>
              <span>{header ? titles[column] || `列 ${column + 1}` : `列 ${column + 1}`}</span>
              {active && <Icon name="chevronDown" size={12} className={sort.desc ? undefined : "is-flipped"} />}
            </button>
          </span>;
        })}
      </div>
      <div className="preview-table-body" style={{ height: shown.length * ROW_HEIGHT }}>
        {shown.slice(first, last).map((item, offset) => <div key={item.index} role="row" className="preview-table-row" style={{ top: (first + offset) * ROW_HEIGHT }}>
          <span role="cell" className="preview-table-number">{item.index + 1}</span>
          {Array.from({ length: columns }, (_, column) => {
            const value = item.row[column] ?? "";
            return <span role="cell" key={column} className={numeric(value) ? "is-number" : undefined} title={value.length > 40 ? value : undefined}
              onDoubleClick={() => void copyText(value, "单元格已复制")}>{value}</span>;
          })}
        </div>)}
      </div>
      {!shown.length && <p className="preview-table-empty">{query.trim() ? `没有包含“${query.trim()}”的行` : "表格是空的"}</p>}
    </div>
  </div>;
}
