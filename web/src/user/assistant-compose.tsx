/** 输入框的即时 Markdown 与 @ 引用高亮：在透明文字的 textarea 下方放一层逐字对齐的镜像。
 * 镜像只改变颜色、底色和描边，不改变字宽、字号或行高，所以光标、选区、输入法与撤销仍由原生 textarea 负责。 */
import { forwardRef, type ReactNode } from "react";

type Piece = { text: string; className?: string };

const INLINE = /(`+)([^`\n]+?)\1|(\*\*|__)(?=\S)([^\n]+?\S)\3|(~~)(?=\S)([^\n]+?\S)~~|(\*|_)(?=[^\s*_])([^\n*_]+?[^\s*_]|[^\s*_])\7(?![\w*_])|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function inline(text: string, mentions: string[]): Piece[] {
  const pieces: Piece[] = [];
  // 先切出 @ 引用（按长度降序匹配，只认已选中的引用），其余部分再做行内 Markdown。
  let rest = 0;
  const plain = (value: string) => {
    let last = 0;
    for (const match of value.matchAll(INLINE)) {
      const at = match.index ?? 0;
      if (at > last) pieces.push({ text: value.slice(last, at) });
      if (match[1]) pieces.push({ text: match[1], className: "cx-mark" }, { text: match[2], className: "cx-code" }, { text: match[1], className: "cx-mark" });
      else if (match[3]) pieces.push({ text: match[3], className: "cx-mark" }, { text: match[4], className: "cx-strong" }, { text: match[3], className: "cx-mark" });
      else if (match[5]) pieces.push({ text: "~~", className: "cx-mark" }, { text: match[6], className: "cx-del" }, { text: "~~", className: "cx-mark" });
      else if (match[7]) pieces.push({ text: match[7], className: "cx-mark" }, { text: match[8], className: "cx-em" }, { text: match[7], className: "cx-mark" });
      else pieces.push({ text: "[", className: "cx-mark" }, { text: match[9], className: "cx-link" }, { text: `](${match[10]})`, className: "cx-mark" });
      last = at + match[0].length;
    }
    if (last < value.length) pieces.push({ text: value.slice(last) });
  };
  if (mentions.length) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "@" || (i > 0 && !/\s/.test(text[i - 1]))) continue;
      const path = mentions.find(item => text.startsWith(item, i + 1));
      if (!path) continue;
      plain(text.slice(rest, i));
      pieces.push({ text: `@${path}`, className: "cx-mention" });
      rest = i = i + path.length + 1;
      i--;
    }
  }
  plain(text.slice(rest));
  return pieces;
}

function lines(text: string, mentions: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let fence = false;
  text.split("\n").forEach((line, index, all) => {
    const pieces: Piece[] = [];
    const fenceLine = /^ {0,3}(```|~~~)/.test(line);
    if (fenceLine) { pieces.push({ text: line, className: "cx-mark" }); fence = !fence; }
    else if (fence) pieces.push({ text: line, className: "cx-code-line" });
    else {
      const block = /^( {0,3}#{1,6} )|^( {0,3}> ?)|^(\s*(?:[-*+]|\d{1,3}[.)]) (?:\[[ xX]\] )?)/.exec(line);
      const body = block ? line.slice(block[0].length) : line;
      if (block?.[1]) pieces.push({ text: block[1], className: "cx-mark" }, ...inline(body, mentions).map(piece => ({ ...piece, className: `cx-heading ${piece.className ?? ""}` })));
      else if (block?.[2]) pieces.push({ text: block[2], className: "cx-quote-mark" }, ...inline(body, mentions).map(piece => ({ ...piece, className: `cx-quote ${piece.className ?? ""}` })));
      else if (block?.[3]) pieces.push({ text: block[3], className: "cx-list" }, ...inline(body, mentions));
      else pieces.push(...inline(line, mentions));
    }
    out.push(...pieces.map((piece, key) => piece.className ? <span key={`${index}-${key}`} className={piece.className.trim()}>{piece.text}</span> : piece.text));
    if (index < all.length - 1) out.push("\n");
  });
  return out;
}

/** mentions 为已选中的引用路径（"/电影/" 形式）。末尾补一个零宽字符，保证以换行结尾时镜像与输入框同高。 */
export const ComposeMirror = forwardRef<HTMLDivElement, { text: string; mentions: string[] }>(function ComposeMirror({ text, mentions }, ref) {
  const sorted = [...mentions].sort((a, b) => b.length - a.length);
  return <div ref={ref} className="assistant-input-mirror" aria-hidden="true">{lines(text, sorted)}{"​"}</div>;
});
