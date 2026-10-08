/** 自带的 Markdown 渲染器（CommonMark 常用子集 + GFM 表格、任务列表、删除线、自动链接）。
 * 直接产出 React 元素，不使用 innerHTML；原始 HTML 一律不执行，链接只放行 http(s)/mailto。 */
import { Fragment, useMemo, type ReactNode } from "react";
import { CodeFence } from "./code";
import { languageOf } from "./highlight";

type Ctx = { refs: Map<string, { url: string; title?: string }>; resolveImage?: (src: string) => string | null; depth: number };

const PUNCT = /[!-/:-@[-`{-~]/;
const CJK = /[　-鿿＀-￯]/;

/** 只允许 http(s) 与 mailto；去掉控制字符后再判断，防止 "java\nscript:" 之类的绕过。 */
export function safeHref(url: string): string | null {
  const compact = url.replace(/[\u0000-\u001f\u007f\s]/g, "");
  return /^(?:https?:\/\/|mailto:)/i.test(compact) ? compact : null;
}

const normalizeLabel = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();

/* ---------- 行内 ---------- */

/** failed 记录“从某位置起已确认不存在闭合分隔符”，之后的同类分隔符直接放弃，避免大段未闭合的 * 造成二次方耗时。 */
function findCloser(text: string, from: number, char: string, length: number, failed: Map<string, number>): number {
  const memo = char + length;
  if (failed.has(memo) && from >= failed.get(memo)!) return -1;
  const pattern = new RegExp(`\\${char}+`, "g");
  pattern.lastIndex = from;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index, run = match[0].length;
    if (start <= from || run < length || /\s/.test(text[start - 1])) continue;
    const closer = start + run - length;
    if (char === "_" && /[\p{L}\p{N}]/u.test(text[closer + length] ?? "")) continue;
    return closer;
  }
  failed.set(memo, Math.min(from, failed.get(memo) ?? from));
  return -1;
}

function matchBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "`") { const end = text.indexOf("`", i + 1); if (end > 0) i = end; continue; }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return i;
  }
  return -1;
}

function parseDestination(text: string, at: number): { url: string; title?: string; end: number } | null {
  let i = at;
  while (text[i] === " " || text[i] === "\n") i++;
  let url = "";
  if (text[i] === "<") {
    const end = text.indexOf(">", i);
    if (end < 0) return null;
    url = text.slice(i + 1, end); i = end + 1;
  } else {
    let depth = 0;
    const start = i;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\") { i++; continue; }
      if (/\s/.test(ch)) break;
      if (ch === "(") depth++;
      else if (ch === ")") { if (depth === 0) break; depth--; }
    }
    url = text.slice(start, i);
  }
  while (text[i] === " " || text[i] === "\n") i++;
  let title: string | undefined;
  const quote = text[i];
  if (quote === '"' || quote === "'" || quote === "(") {
    const close = quote === "(" ? ")" : quote;
    const end = text.indexOf(close, i + 1);
    if (end < 0) return null;
    title = text.slice(i + 1, end); i = end + 1;
    while (text[i] === " " || text[i] === "\n") i++;
  }
  return text[i] === ")" ? { url: url.replace(/\\(.)/g, "$1"), title, end: i + 1 } : null;
}

function parseLink(text: string, open: number, ctx: Ctx): { label: string; url: string; title?: string; end: number } | null {
  const close = matchBracket(text, open);
  if (close < 0) return null;
  const label = text.slice(open + 1, close);
  if (text[close + 1] === "(") {
    const dest = parseDestination(text, close + 2);
    return dest ? { label, ...dest } : null;
  }
  let key = label, end = close + 1;
  if (text[close + 1] === "[") {
    const refEnd = text.indexOf("]", close + 2);
    if (refEnd > 0) { key = text.slice(close + 2, refEnd) || label; end = refEnd + 1; }
  }
  const ref = ctx.refs.get(normalizeLabel(key));
  return ref ? { label, url: ref.url, title: ref.title, end } : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", "#39": "'" };

function inline(text: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  const failed = new Map<string, number>();
  let buf = "";
  let i = 0;
  const flush = () => { if (buf) { out.push(buf); buf = ""; } };
  const add = (make: (key: number) => ReactNode) => { flush(); out.push(make(out.length)); };
  const nested = (value: string) => ctx.depth > 6 ? [value] : inline(value, { ...ctx, depth: ctx.depth + 1 });
  const link = (key: number, href: string | null, children: ReactNode, title?: string) => href
    ? <a key={key} href={href} title={title} target="_blank" rel="noreferrer noopener">{children}</a>
    : <Fragment key={key}>{children}</Fragment>;

  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      if (text[i + 1] === "\n") { add(key => <br key={key} />); i += 2; continue; }
      if (PUNCT.test(text[i + 1])) { buf += text[i + 1]; i += 2; continue; }
    }
    if (ch === "\n") {
      if (/ {2,}$/.test(buf)) { buf = buf.replace(/ +$/, ""); add(key => <br key={key} />); }
      else buf += "\n";
      i++; continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(text.slice(i))![0].length;
      let end = -1;
      for (let j = text.indexOf("`", i + run); j >= 0; j = text.indexOf("`", j + 1)) {
        const length = /^`+/.exec(text.slice(j))![0].length;
        if (length === run) { end = j; break; }
        j += length - 1;
      }
      if (end > 0) {
        let code = text.slice(i + run, end).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
        add(key => <code key={key}>{code}</code>);
        i = end + run; continue;
      }
      buf += "`".repeat(run); i += run; continue;
    }
    if (ch === "!" && text[i + 1] === "[") {
      const parsed = parseLink(text, i + 1, ctx);
      if (parsed) {
        const alt = parsed.label.replace(/[*_`~\[\]]/g, "");
        const src = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(parsed.url) ? parsed.url : ctx.resolveImage?.(parsed.url) ?? null;
        if (src) add(key => <img key={key} src={src} alt={alt} title={parsed.title} loading="lazy" />);
        else add(key => link(key, safeHref(parsed.url), <span className="md-image-fallback">{alt || "图片"}</span>, parsed.title));
        i = parsed.end; continue;
      }
    }
    if (ch === "[") {
      const parsed = parseLink(text, i, ctx);
      if (parsed) {
        const label = nested(parsed.label);
        add(key => link(key, safeHref(parsed.url), label, parsed.title));
        i = parsed.end; continue;
      }
    }
    if (ch === "<") {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+|[^\s@<>]+@[^\s@<>]+\.[^\s<>]+)>/i.exec(text.slice(i, i + 600));
      if (auto) {
        const target = auto[1];
        add(key => link(key, safeHref(target.includes("@") && !/^\w+:/.test(target) ? `mailto:${target}` : target), target));
        i += auto[0].length; continue;
      }
      const tag = /^<(\/?)([A-Za-z][\w-]*)([^<>]*)>/.exec(text.slice(i, i + 600));
      if (tag) {
        // 原始 HTML 不执行：<br> 换行，<img> 退化为替代文字，其余标签丢弃、保留其中文字。
        if (tag[2].toLowerCase() === "br") add(key => <br key={key} />);
        else if (tag[2].toLowerCase() === "img") { const alt = /alt\s*=\s*["']([^"']*)["']/i.exec(tag[3]); if (alt?.[1]) buf += alt[1]; }
        i += tag[0].length; continue;
      }
      if (text.startsWith("<!--", i)) { const end = text.indexOf("-->", i + 4); i = end < 0 ? text.length : end + 3; continue; }
    }
    if (ch === "*" || ch === "_") {
      const prev = text[i - 1] ?? "";
      const intraword = ch === "_" && /[\p{L}\p{N}]/u.test(prev);
      let matched = false;
      if (!intraword) {
        for (const length of text.startsWith(ch + ch, i) ? [2, 1] : [1]) {
          const first = text[i + length];
          if (first === undefined || /\s/.test(first)) continue;
          const closer = findCloser(text, i + length, ch, length, failed);
          if (closer < 0) continue;
          const children = nested(text.slice(i + length, closer));
          add(key => length === 2 ? <strong key={key}>{children}</strong> : <em key={key}>{children}</em>);
          i = closer + length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    if (ch === "~" && text.startsWith("~~", i) && !/\s/.test(text[i + 2] ?? " ")) {
      const closer = text.indexOf("~~", i + 2);
      if (closer > i + 2) { const children = nested(text.slice(i + 2, closer)); add(key => <del key={key}>{children}</del>); i = closer + 2; continue; }
    }
    if (ch === "h" && !/\w/.test(text[i - 1] ?? " ")) {
      const bare = /^https?:\/\/[^\s<>]+/.exec(text.slice(i, i + 2000));
      if (bare) {
        let url = bare[0];
        while (/[.,;:!?'"*_~]$/.test(url) || (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0))) url = url.slice(0, -1);
        const target = url;
        add(key => link(key, safeHref(target), target));
        i += url.length; continue;
      }
    }
    if (ch === "&") {
      const entity = /^&(amp|lt|gt|quot|nbsp|#39);/.exec(text.slice(i, i + 8));
      if (entity) { buf += ENTITIES[entity[1]]; i += entity[0].length; continue; }
    }
    buf += ch; i++;
  }
  flush();
  return out;
}

/* ---------- 块级 ---------- */

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;

const indentOf = (line: string) => line.length - line.trimStart().length;
const isTableSeparator = (line: string) => /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line) && line.includes("-") && (line.includes("|") || line.trim().length > 2);

function splitRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && value[i + 1] === "|") { current += "|"; i++; }
    else if (value[i] === "|") { cells.push(current.trim()); current = ""; }
    else current += value[i];
  }
  cells.push(current.trim());
  return cells;
}

function startsBlock(line: string, next: string | undefined): boolean {
  if (FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const list = LIST.exec(line);
  if (list && list[4].trim() && (!/\d/.test(list[2]) || list[2].startsWith("1"))) return true;
  return line.includes("|") && next !== undefined && isTableSeparator(next);
}

/** 把段落的多行连成一行；中文之间的换行不应变成空格。 */
function joinLines(lines: string[]): string {
  let text = lines[0].trimStart();
  for (const raw of lines.slice(1)) {
    const piece = raw.trimStart();
    text += (CJK.test(text.slice(-1)) && CJK.test(piece[0] ?? "") ? "" : "\n") + piece;
  }
  return text;
}

function blocks(lines: string[], ctx: Ctx, tight = false): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  const push = (make: (key: number) => ReactNode) => out.push(make(out.length));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1], body: string[] = [];
      const closing = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \\t]*$`);
      const indent = indentOf(line);
      for (i++; i < lines.length && !closing.test(lines[i]); i++) body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
      i++;
      const tag = fence[2].replace(/^\{?\.?|\}$/g, "");
      push(key => <CodeFence key={key} code={body.join("\n")} lang={languageOf(tag)} label={tag} />);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length, content = inline(heading[2] ?? "", ctx);
      push(key => level === 1 ? <h1 key={key}>{content}</h1> : level === 2 ? <h2 key={key}>{content}</h2> : level === 3 ? <h3 key={key}>{content}</h3> : level === 4 ? <h4 key={key}>{content}</h4> : level === 5 ? <h5 key={key}>{content}</h5> : <h6 key={key}>{content}</h6>);
      i++; continue;
    }
    if (HR.test(line)) { push(key => <hr key={key} />); i++; continue; }
    if (line.trimStart().startsWith("<!--")) {
      while (i < lines.length && !lines[i].includes("-->")) i++;
      i++; continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      for (; i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i], lines[i + 1])); i++) inner.push(lines[i].replace(/^ {0,3}> ?/, ""));
      const content = blocks(inner, ctx);
      push(key => <blockquote key={key}>{content}</blockquote>);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line), separators = splitRow(lines[i + 1]);
      if (header.length === separators.length) {
        const align = separators.map(cell => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : undefined);
        const rows: string[][] = [];
        for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|") && !FENCE.test(lines[i]); i++) rows.push(splitRow(lines[i]));
        const head = header.map(cell => inline(cell, ctx));
        const body = rows.map(row => header.map((_, index) => inline(row[index] ?? "", ctx)));
        push(key => (
          <div key={key} className="md-table-wrap">
            <table>
              <thead><tr>{head.map((cell, index) => <th key={index} style={{ textAlign: align[index] }}>{cell}</th>)}</tr></thead>
              <tbody>{body.map((row, r) => <tr key={r}>{row.map((cell, index) => <td key={index} style={{ textAlign: align[index] }}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </div>
        ));
        continue;
      }
    }
    const list = LIST.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const bullet = list[2].slice(-1);
      const start = ordered ? parseInt(list[2], 10) : undefined;
      const items: { lines: string[]; task: boolean | null }[] = [];
      let loose = false;
      while (i < lines.length) {
        const head = LIST.exec(lines[i]);
        if (!head || /\d/.test(head[2]) !== ordered || (!ordered && head[2] !== bullet) || HR.test(lines[i])) break;
        const spaces = head[3].replace(/\t/g, "    ").length;
        const contentIndent = head[1].length + head[2].length + (spaces > 4 || head[4] === "" ? 1 : spaces);
        const item: string[] = [head[4]];
        i++;
        let blanks = 0;
        for (; i < lines.length; i++) {
          const current = lines[i];
          if (!current.trim()) { blanks++; continue; }
          if (indentOf(current) >= contentIndent) { for (; blanks; blanks--) item.push(""); item.push(current.slice(contentIndent)); continue; }
          if (blanks === 0 && !startsBlock(current, lines[i + 1]) && !LIST.test(current)) { item.push(current.trimStart()); continue; }
          break;
        }
        let task: boolean | null = null;
        const marker = /^\[([ xX])\][ \t]+/.exec(item[0]);
        if (marker) { task = marker[1] !== " "; item[0] = item[0].slice(marker[0].length); }
        const sibling = i < lines.length ? LIST.exec(lines[i]) : null;
        if (blanks && sibling && sibling[1].length < contentIndent && /\d/.test(sibling[2]) === ordered && (ordered || sibling[2] === bullet)) loose = true;
        if (item.some((entry, index) => index > 0 && entry === "" && item.slice(index).some(rest => rest && !LIST.test(rest)))) loose = true;
        items.push({ lines: item, task });
        if (!blanks && i < lines.length && indentOf(lines[i]) >= contentIndent) continue;
      }
      const rendered = items.map(item => ({ task: item.task, content: blocks(item.lines, ctx, !loose) }));
      push(key => {
        const children = rendered.map((item, index) => (
          <li key={index} className={item.task !== null ? "md-task" : undefined}>
            {item.task !== null && <input type="checkbox" checked={item.task} disabled readOnly aria-label={item.task ? "已完成" : "未完成"} />}
            {item.content}
          </li>
        ));
        return ordered ? <ol key={key} start={start !== 1 ? start : undefined}>{children}</ol> : <ul key={key}>{children}</ul>;
      });
      continue;
    }

    const paragraph: string[] = [line];
    let setext = 0;
    for (i++; i < lines.length && lines[i].trim(); i++) {
      if (/^ {0,3}=+[ \t]*$/.test(lines[i])) { setext = 1; i++; break; }
      if (/^ {0,3}-+[ \t]*$/.test(lines[i])) { setext = 2; i++; break; }
      if (startsBlock(lines[i], lines[i + 1])) break;
      paragraph.push(lines[i]);
    }
    const text = joinLines(paragraph);
    if (/^(?:\s*<[^>]*>\s*)+$/.test(text)) continue;  // 只含 HTML 标签的行（如 <p align="center">）
    const content = inline(text, ctx);
    if (setext) push(key => setext === 1 ? <h1 key={key}>{content}</h1> : <h2 key={key}>{content}</h2>);
    else if (tight) push(key => <Fragment key={key}>{content}</Fragment>);
    else push(key => <p key={key}>{content}</p>);
  }
  return out;
}

function parse(source: string, resolveImage?: (src: string) => string | null): ReactNode[] {
  const lines = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const head: ReactNode[] = [];
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end > 0) {
      head.push(<CodeFence key="front-matter" code={lines.slice(1, end).join("\n")} lang="yaml" label="front matter" />);
      lines.splice(0, end + 1);
    }
  }
  const refs: Ctx["refs"] = new Map();
  const content: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const opening = FENCE.exec(line);
    if (opening && (!fence || (line.trim().startsWith(fence[0]) && line.trim().length >= fence.length && !opening[2]))) fence = fence ? null : opening[1];
    const definition = fence ? null : /^ {0,3}\[([^\]]+)\]:[ \t]*<?(\S+?)>?(?:[ \t]+["'(](.*)["')])?[ \t]*$/.exec(line);
    if (definition) refs.set(normalizeLabel(definition[1]), { url: definition[2], title: definition[3] });
    else content.push(line);
  }
  return [...head, ...blocks(content, { refs, resolveImage, depth: 0 })];
}

export function Markdown({ source, resolveImage }: { source: string; resolveImage?: (src: string) => string | null }) {
  const nodes = useMemo(() => parse(source, resolveImage), [source, resolveImage]);
  return <div className="md">{nodes}</div>;
}
