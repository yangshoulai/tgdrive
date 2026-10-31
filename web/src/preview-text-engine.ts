/** CodeMirror 与 Markdown 引擎的独立入口，不依赖 React。 */
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { defaultKeymap, history, historyKeymap, indentLess, insertTab } from "@codemirror/commands";
import { tags } from "@lezer/highlight";
import { c, cpp, java, csharp, kotlin, scala, dart } from "@codemirror/legacy-modes/mode/clike";
import { javascript, typescript, json } from "@codemirror/legacy-modes/mode/javascript";
import { python } from "@codemirror/legacy-modes/mode/python";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { go } from "@codemirror/legacy-modes/mode/go";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { css } from "@codemirror/legacy-modes/mode/css";
import { html, xml } from "@codemirror/legacy-modes/mode/xml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { highlight, languageOf } from "./highlight";

const modes: Record<string, StreamParser<unknown>> = { c, cpp, java, csharp, kotlin, scala, dart, js: javascript, javascript, typescript, json, python, shell, go, rust, css, html, xml, yaml, toml, ruby, swift, lua, ini: properties, diff, docker: dockerFile, sql: standardSQL };
/** 文本视图：默认只读；setEditable(true) 进入编辑（撤销重做、标准编辑键、⌘S 保存）。 */
export function createTextView(container: HTMLElement, source: string, name: string, options: { onChange?: () => void; onSave?: () => void } = {}) {
  const wrapping = new Compartment(), editing = new Compartment();
  // 编辑保存要逐字节保留换行：只用 CRLF 的文件按 CRLF 拆行与拼接；其他文件按 LF，残留的 CR 作为普通字符保留，不被规整掉。
  const separator = source.includes("\r\n") && !/(^|[^\r])\n/.test(source) ? "\r\n" : "\n";
  const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: "0", "aria-label": "文件内容，只读" })];
  const writable = [
    EditorView.contentAttributes.of({ "aria-label": "编辑文件内容" }),
    keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { options.onSave?.(); return true; } },
      // Tab 缩进；Esc 之后的 Tab 仍可移出编辑器（CodeMirror 的 Tab 焦点陷阱约定）。
      { key: "Tab", run: insertTab, shift: indentLess }, ...historyKeymap, ...defaultKeymap]),
  ];
  const extension = name.toLowerCase().split(".").at(-1)!;
  const language = ({ ts: "typescript", tsx: "typescript", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", scala: "scala", dart: "dart", html: "html", htm: "html", lua: "lua" } as Record<string, string>)[extension] ?? languageOf(name);
  // 已有轻量语法规则作为补充，保留 PHP、Makefile 等文件的高亮。
  const mode = language ? modes[language] ?? {
    startState: () => ({ tokens: [] as ReturnType<typeof highlight>, index: 0 }),
    token: (stream, state) => {
      if (stream.sol()) { state.tokens = highlight(stream.string, language); state.index = 0; }
      const token = state.tokens[state.index++];
      if (!token) { stream.skipToEnd(); return null; }
      stream.pos += token.text.length; return token.type;
    },
    tokenTable: { property: tags.propertyName, function: tags.function(tags.variableName), type: tags.typeName, variable: tags.variableName },
  } satisfies StreamParser<{ tokens: ReturnType<typeof highlight>; index: number }> : undefined;
  const view = new EditorView({ parent: container, state: EditorState.create({ doc: source, extensions: [
    // 只保留阅读所需能力，避免默认编辑器的光标、当前行高亮和折叠留白。
    lineNumbers(), highlightSpecialChars(), drawSelection(), highlightSelectionMatches(),
    search({ top: true }), keymap.of(searchKeymap), history(), EditorState.lineSeparator.of(separator), editing.of(readOnly),
    EditorView.updateListener.of(update => { if (update.docChanged) options.onChange?.(); }),
    EditorState.phrases.of({ "Find": "查找", "next": "下一处", "previous": "上一处", "all": "全部", "match case": "区分大小写", "regexp": "正则表达式", "by word": "完整单词", "close": "关闭", "No matches": "没有匹配项" }),
    wrapping.of(EditorView.lineWrapping), ...(mode ? [StreamLanguage.define(mode)] : []),
    syntaxHighlighting(HighlightStyle.define([
      { tag: tags.keyword, class: "hl-keyword" }, { tag: tags.string, class: "hl-string" },
      { tag: tags.comment, class: "hl-comment" }, { tag: tags.number, class: "hl-number" },
      { tag: tags.bool, class: "hl-number" }, { tag: tags.function(tags.variableName), class: "hl-function" },
      { tag: tags.typeName, class: "hl-type" }, { tag: tags.operator, class: "hl-operator" },
    ])),
    EditorView.theme({
      "&": { color: "var(--ink)", backgroundColor: "var(--surface)", fontSize: "13px", maxHeight: "min(620px, var(--preview-reading-height))", minHeight: "min(var(--preview-text-min-height, 280px), max(80px, var(--preview-reading-height)))" },
      ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.85", overflow: "auto", overscrollBehavior: "contain", minHeight: "0", flex: "1" },
      ".cm-content": { padding: "20px 0" }, ".cm-line": { padding: "0 20px" },
      ".cm-gutters": { color: "var(--ink-3)", backgroundColor: "var(--surface)", borderColor: "var(--line-soft)" },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px", minWidth: "44px" },
      ".cm-selectionBackground": { backgroundColor: "var(--selection) !important" },
      ".cm-searchMatch": { backgroundColor: "var(--warning-soft)", outline: "1px solid var(--warning)" },
      ".cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)", outline: "1px solid var(--accent)" },
      ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
      ".cm-panels": { color: "var(--ink)", backgroundColor: "var(--surface-sunken)" },
      ".cm-textfield": { color: "var(--ink)", backgroundColor: "var(--surface)", borderColor: "var(--line)" },
      ".cm-button": { color: "var(--ink)", background: "var(--surface)", borderColor: "var(--line)" },
      "&.cm-focused": { outline: "none" },
    }),
  ] }) });
  return {
    destroy: () => view.destroy(), search: () => { openSearchPanel(view); },
    // 编辑器只渲染可见行，必须用编辑器自己的选区全选，复制时才包含屏幕外的内容。
    selectAll: () => { view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); view.focus(); },
    setWrapping: (enabled: boolean) => view.dispatch({ effects: wrapping.reconfigure(enabled ? EditorView.lineWrapping : []) }),
    setEditable: (enabled: boolean) => { view.dispatch({ effects: editing.reconfigure(enabled ? writable : readOnly) }); if (enabled) view.focus(); },
    /** 按原换行拼接的全文（sliceDoc 使用 lineSeparator）。 */
    text: () => view.state.sliceDoc(),
  };
}

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
export function renderMarkdown(source: string, resolveImage?: (src: string) => string | null): string {
  const md = new MarkdownIt({ html: true, linkify: true, highlight: (code, tag) =>
    highlight(code, languageOf(tag)).map(token => token.type ? `<span class="hl-${token.type}">${escape(token.text)}</span>` : escape(token.text)).join("") });
  md.core.ruler.after("inline", "task_lists", state => {
    state.tokens.forEach((token, index) => {
      if (token.type !== "inline" || state.tokens[index - 1]?.type !== "paragraph_open" || state.tokens[index - 2]?.type !== "list_item_open") return;
      const first = token.children?.[0], match = first?.type === "text" && /^\[([ xX])\]\s+/.exec(first.content);
      if (!first || !match) return;
      first.content = first.content.slice(match[0].length);
      const checkbox = new state.Token("html_inline", "", 0);
      checkbox.content = `<input type="checkbox" disabled${match[1] === " " ? "" : " checked"}>`;
      token.children!.unshift(checkbox); state.tokens[index - 2].attrJoin("class", "md-task");
    });
  });
  md.renderer.rules.fence = (tokens, index, options) => {
    const token = tokens[index], tag = token.info.trim().split(/\s+/)[0];
    const code = options.highlight?.(token.content, tag, "") || escape(token.content);
    return `<div class="src-fence"><div class="src-fence-bar"><span>${escape(tag || "纯文本")}</span><button type="button" data-copy-code>复制代码</button></div><pre><code>${code}</code></pre></div>`;
  };
  const safeLink = (url: string) => /^(?:https?:\/\/|mailto:)/i.test(url.replace(/[\u0000-\u0020\u007f]/g, ""));
  const link = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    if (!safeLink(String(tokens[index].attrGet("href") ?? ""))) {
      const href = tokens[index].attrIndex("href");
      if (href >= 0) tokens[index].attrs!.splice(href, 1);
    }
    tokens[index].attrSet("rel", "noreferrer noopener");
    return link ? link(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
  };
  md.renderer.rules.image = (tokens, index) => {
    const token = tokens[index];
    return `<img src="${escape(String(token.attrGet("src") ?? ""))}" alt="${escape(token.content)}">`;
  };
  md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>';
  md.renderer.rules.table_close = () => '</table></div>';
  // 允许 README 里常见的少量 HTML（居中的 div、picture、details、kbd 等），全部经 DOMPurify 清洗：
  // 不执行脚本、不加载样式与框架；图片只加载同目录（含子目录）的文件和内嵌 data 图片，外部图片先换成占位，由用户点击后再加载；
  // picture 的 source 一律去掉（srcset 可能指向外部地址），保留其中的 img；链接只放行 http(s) 与 mailto。
  const purify = DOMPurify;
  purify.addHook("afterSanitizeAttributes", node => {
    const element = node as Element;
    if (element.tagName === "IMG") {
      const src = element.getAttribute("src") ?? "";
      element.removeAttribute("srcset");
      element.setAttribute("loading", "lazy");
      if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(src)) return;
      if (/^https?:\/\//i.test(src)) { element.removeAttribute("src"); element.setAttribute("data-remote-src", src); return; }
      const resolved = src ? resolveImage?.(src) : null;
      if (resolved) element.setAttribute("src", resolved);
      else { element.removeAttribute("src"); element.setAttribute("data-missing", ""); }
    } else if (element.tagName === "A") {
      if (!safeLink(element.getAttribute("href") ?? "")) element.removeAttribute("href");
      element.setAttribute("rel", "noreferrer noopener");
      element.removeAttribute("target");
    } else if (element.tagName === "INPUT" && !(element.getAttribute("type") === "checkbox" && element.hasAttribute("disabled"))) element.remove();
  });
  try {
    return purify.sanitize(md.render(source), { ADD_ATTR: ["loading"], FORBID_TAGS: ["style", "form", "iframe", "source", "video", "audio", "object", "embed", "select", "textarea"], FORBID_ATTR: ["style", "id"] });
  } finally { purify.removeHook("afterSanitizeAttributes"); }
}
