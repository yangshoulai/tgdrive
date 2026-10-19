/** 文件助手输入框引擎（CodeMirror 6，单独打包、打开助手时加载）。
 * 文档始终是 Markdown 纯文本：装饰层隐藏行内标记（光标进入该片段时才显示）、把已选中的 @ 引用替换成带类型图标的原子胶囊、
 * 给网址加地球图标与链接样式、把无序列表标记显示成圆点；Enter 在列表中续写下一项（有序列表自动加一），其余情况发送。
 * 输入法、撤销、粘贴与选区都是 CodeMirror 的原生行为。 */
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder as placeholderText, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, insertNewline } from "@codemirror/commands";

export type ComposerToken = { query: string; from: number };
export type ComposerOptions = {
  value: string;
  placeholder: string;
  label: string;
  maxLength: number;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** 光标前正在输入的 @ 片段（from 为 @ 的位置）；没有时为 null。 */
  onToken: (token: ComposerToken | null) => void;
  /** 宿主先处理的按键（@ 候选列表的方向键、回车、Esc）；返回 true 表示已处理。 */
  onKey: (event: KeyboardEvent) => boolean;
  /** 剪贴板里有文件（截图、在访达／资源管理器里复制的文件）时交给宿主作为附件；返回 true 表示已接管，不再粘贴文字。 */
  onPasteFiles?: (files: File[]) => boolean;
  /** 已选中的引用路径（"/电影/"、"/a/b.txt"）；只有这些 @路径 显示为胶囊。 */
  mentions: () => string[];
  /** 图标元素：文件类型（folder、image…）或 "globe"。 */
  icon: (name: string) => Element | null;
};

const refresh = StateEffect.define<null>();
const TOKEN = /(?:^|\s)@([^\s@]{0,60})$/;
const LIST = /^(\s*)([-*+]|(\d{1,3})([.)]))(\s+)(\[[ xX]\]\s+)?/;
const FENCE = /^\s{0,3}(```|~~~)/;
const URL_END = /[.,;:!?'"）)\]】」》，。！？；：、]+$/;

class IconWidget extends WidgetType {
  constructor(readonly name: string, readonly className: string, readonly make: ComposerOptions["icon"]) { super(); }
  eq(other: IconWidget) { return other.name === this.name && other.className === this.className; }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.className;
    const icon = this.make(this.name);
    if (icon) span.append(icon);
    return span;
  }
  ignoreEvent() { return false; }
}

class MentionWidget extends WidgetType {
  constructor(readonly path: string, readonly make: ComposerOptions["icon"]) { super(); }
  eq(other: MentionWidget) { return other.path === this.path; }
  toDOM() {
    const chip = document.createElement("span");
    chip.className = "cx-chip";
    chip.title = this.path;
    const icon = this.make(this.path.endsWith("/") ? "folder" : `file:${this.path}`);
    if (icon) chip.append(icon);
    const name = document.createElement("span");
    name.textContent = this.path.replace(/\/$/, "").split("/").at(-1) || "/";
    chip.append(name);
    return chip;
  }
  ignoreEvent() { return false; }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const span = document.createElement("span"); span.className = "cx-bullet"; span.textContent = "•"; return span; }
}

type Built = { decorations: DecorationSet; atoms: DecorationSet };

function build(view: EditorView, options: ComposerOptions): Built {
  const { state } = view;
  const head = state.selection.main.head;
  const focused = view.hasFocus;
  const ranges: Range<Decoration>[] = [];
  const atoms: Range<Decoration>[] = [];
  const mentions = [...options.mentions()].sort((a, b) => b.length - a.length);
  const hide = Decoration.replace({});
  const mark = (className: string) => Decoration.mark({ class: className });
  // 光标严格位于片段内部时显示原始标记，便于修改；片段刚输入完（光标在末尾）立即收起。
  const active = (from: number, to: number) => focused && head > from && head < to;
  let fence = false;
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const text = line.text;
    if (FENCE.test(text)) {
      ranges.push(Decoration.line({ class: "cx-fence-line" }).range(line.from));
      fence = !fence;
      continue;
    }
    if (fence) { ranges.push(Decoration.line({ class: "cx-codeblock-line" }).range(line.from)); continue; }
    let start = 0;
    const list = LIST.exec(text);
    const heading = /^(#{1,6}) /.exec(text);
    const quote = /^> ?/.exec(text);
    if (list) {
      ranges.push(Decoration.line({ class: "cx-list-line" }).range(line.from));
      const markerFrom = line.from + list[1].length, markerTo = markerFrom + list[2].length;
      if (list[3]) ranges.push(mark("cx-ol-marker").range(markerFrom, markerTo));
      else ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(markerFrom, markerTo));
      start = list[0].length;
    } else if (heading) {
      ranges.push(Decoration.line({ class: `cx-heading-line cx-h${heading[1].length}` }).range(line.from));
      if (!(focused && head >= line.from && head <= line.to)) ranges.push(hide.range(line.from, line.from + heading[0].length));
      else ranges.push(mark("cx-mark").range(line.from, line.from + heading[0].length));
      start = heading[0].length;
    } else if (quote) {
      ranges.push(Decoration.line({ class: "cx-quote-line" }).range(line.from));
      ranges.push(mark("cx-quote-mark").range(line.from, line.from + quote[0].length));
      start = quote[0].length;
    }
    inline(text, start, line.from);
  }

  function wrapped(from: number, to: number, open: number, close: number, className: string) {
    if (active(from, to)) {
      ranges.push(mark("cx-mark").range(from, from + open), mark("cx-mark").range(to - close, to));
    } else {
      ranges.push(hide.range(from, from + open), hide.range(to - close, to));
    }
    if (to - close > from + open) ranges.push(mark(className).range(from + open, to - close));
  }

  function inline(text: string, start: number, base: number) {
    let i = start;
    while (i < text.length) {
      const ch = text[i];
      const boundary = i === 0 || /[\s(（\[【「《]/.test(text[i - 1]);
      if (ch === "@" && boundary) {
        const path = mentions.find(item => text.startsWith(item, i + 1));
        if (path) {
          const deco = Decoration.replace({ widget: new MentionWidget(path, options.icon) });
          ranges.push(deco.range(base + i, base + i + path.length + 1));
          atoms.push(deco.range(base + i, base + i + path.length + 1));
          i += path.length + 1; continue;
        }
      }
      if (ch === "`") {
        const run = /^`+/.exec(text.slice(i))![0].length;
        const close = text.indexOf("`".repeat(run), i + run);
        if (close > i + run && !text.slice(i + run, close).includes("\n")) {
          wrapped(base + i, base + close + run, run, run, "cx-code");
          i = close + run; continue;
        }
        i += run; continue;
      }
      if (ch === "*" || ch === "~" || ch === "_") {
        const pair = /^(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/.exec(text.slice(i));
        if (pair) {
          wrapped(base + i, base + i + pair[0].length, 2, 2, pair[1] === "~~" ? "cx-del" : "cx-strong");
          i += pair[0].length; continue;
        }
        const single = ch === "*" && boundary ? /^\*(?=[^\s*])([^\n*]*?[^\s*])\*(?![\w*])/.exec(text.slice(i)) : null;
        if (single) { wrapped(base + i, base + i + single[0].length, 1, 1, "cx-em"); i += single[0].length; continue; }
      }
      if (ch === "[") {
        const link = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.exec(text.slice(i));
        if (link) {
          const from = base + i, to = from + link[0].length;
          ranges.push(Decoration.widget({ widget: new IconWidget("globe", "cx-link-icon", options.icon), side: -1 }).range(from));
          wrapped(from, to, 1, link[2].length + 3, "cx-link");
          i += link[0].length; continue;
        }
      }
      if ((ch === "h" || ch === "H") && (i === 0 || !/[\w/]/.test(text[i - 1]))) {
        const url = /^https?:\/\/[^\s<>"'`]+/i.exec(text.slice(i));
        if (url) {
          const value = url[0].replace(URL_END, "");
          if (value.length > url[0].indexOf("//") + 2) {
            const from = base + i, to = from + value.length;
            ranges.push(Decoration.widget({ widget: new IconWidget("globe", "cx-link-icon", options.icon), side: -1 }).range(from));
            ranges.push(mark("cx-link").range(from, to));
            i += value.length; continue;
          }
        }
      }
      i++;
    }
  }
  return { decorations: Decoration.set(ranges, true), atoms: Decoration.set(atoms, true) };
}

/** 列表续写：光标在列表项内容中时插入下一项标记（有序列表自动加一并重排后续编号）；空项上回车退出列表。 */
function continueList(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;
  const line = state.doc.lineAt(range.head);
  const match = LIST.exec(line.text);
  if (!match || range.head < line.from + match[0].length) return false;
  if (!line.text.slice(match[0].length).trim()) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "" }, selection: { anchor: line.from }, userEvent: "delete" });
    return true;
  }
  const next = match[3] ? Number(match[3]) + 1 : null;
  const marker = next !== null ? `${next}${match[4]}` : match[2];
  const insert = `\n${match[1]}${marker}${match[5]}${match[6] ? "[ ] " : ""}`;
  const changes = [{ from: range.head, to: range.head, insert }];
  // 在有序列表中间插入：后面同一缩进的连续项依次加一。
  if (next !== null) {
    let expected = next;
    for (let number = line.number + 1; number <= state.doc.lines; number++) {
      const following = state.doc.line(number);
      const item = LIST.exec(following.text);
      if (!item || !item[3] || item[1] !== match[1]) break;
      expected += 1;
      const from = following.from + item[1].length;
      changes.push({ from, to: from + item[3].length, insert: String(expected) });
    }
  }
  view.dispatch(state.update({ changes, selection: EditorSelection.cursor(range.head + insert.length), scrollIntoView: true, userEvent: "input" }));
  return true;
}

function inFence(state: EditorState, pos: number): boolean {
  let open = false;
  const target = state.doc.lineAt(pos).number;
  for (let number = 1; number < target; number++) if (FENCE.test(state.doc.line(number).text)) open = !open;
  return open;
}

export function createComposer(parent: HTMLElement, options: ComposerOptions) {
  const editable = new Compartment();
  const hint = new Compartment();
  let lastToken: string | null = null;

  const plugin = ViewPlugin.fromClass(class {
    built: Built;
    constructor(view: EditorView) { this.built = build(view, options); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged || update.transactions.some(tr => tr.effects.some(effect => effect.is(refresh)))) {
        this.built = build(update.view, options);
      }
    }
  }, { decorations: value => value.built.decorations });

  const reportToken = (state: EditorState) => {
    const range = state.selection.main;
    let token: ComposerToken | null = null;
    if (range.empty) {
      const line = state.doc.lineAt(range.head);
      const match = TOKEN.exec(line.text.slice(0, range.head - line.from));
      if (match) token = { query: match[1], from: range.head - match[1].length - 1 };
    }
    const key = token ? `${token.from}:${token.query}` : null;
    if (key !== lastToken) { lastToken = key; options.onToken(token); }
  };

  const submit = () => { options.onSubmit(); return true; };
  const extensions: Extension[] = [
    history(),
    EditorView.lineWrapping,
    plugin,
    EditorView.atomicRanges.of(view => view.plugin(plugin)?.built.atoms ?? Decoration.none),
    editable.of(EditorView.editable.of(!options.disabled)),
    hint.of(placeholderText(options.placeholder)),
    EditorView.contentAttributes.of({ "aria-label": options.label, "aria-multiline": "true", spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
    EditorState.transactionFilter.of(tr => tr.docChanged && tr.newDoc.length > options.maxLength && tr.newDoc.length > tr.startState.doc.length ? [] : tr),
    Prec.highest(EditorView.domEventHandlers({
      keydown: event => {
        if (event.isComposing) return false;
        if (event.repeat && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); return true; }
        return options.onKey(event);
      },
      paste: event => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length || !options.onPasteFiles?.(files)) return false;
        event.preventDefault();
        return true;
      },
    })),
    Prec.high(keymap.of([
      { key: "Enter", run: view => continueList(view) || (inFence(view.state, view.state.selection.main.head) ? insertNewline(view) : submit()) },
      { key: "Shift-Enter", run: view => continueList(view) || insertNewline(view) },
      { key: "Mod-Enter", run: submit },
      // 光标紧跟在列表标记后退格：去掉整个标记，变回普通行。
      { key: "Backspace", run: view => {
        const range = view.state.selection.main;
        if (!range.empty) return false;
        const line = view.state.doc.lineAt(range.head);
        const match = LIST.exec(line.text);
        if (!match || range.head !== line.from + match[0].length) return false;
        view.dispatch({ changes: { from: line.from, to: range.head, insert: match[1] }, userEvent: "delete" });
        return true;
      } },
    ])),
    keymap.of([...historyKeymap, ...defaultKeymap]),
    EditorView.updateListener.of(update => {
      if (update.docChanged) options.onChange(update.state.doc.toString());
      if (update.docChanged || update.selectionSet || update.focusChanged) reportToken(update.state);
    }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc: options.value, extensions, selection: { anchor: options.value.length } }) });

  return {
    view,
    text: () => view.state.doc.toString(),
    /** 外部改写内容（预填、发送后清空）：光标放到末尾。 */
    setText(value: string) {
      if (value === view.state.doc.toString()) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: value.length } });
    },
    /** 用 @路径 替换正在输入的 @ 片段，后面补一个空格，光标放在空格之后。 */
    insertMention(from: number, path: string) {
      const head = view.state.selection.main.head;
      const insert = `@${path} `;
      view.dispatch({ changes: { from, to: Math.max(from, head), insert }, selection: { anchor: from + insert.length }, effects: refresh.of(null), userEvent: "input" });
      view.focus();
    },
    refresh() { view.dispatch({ effects: refresh.of(null) }); },
    configure({ disabled, placeholder }: { disabled: boolean; placeholder: string }) {
      view.dispatch({ effects: [editable.reconfigure(EditorView.editable.of(!disabled)), hint.reconfigure(placeholderText(placeholder))] });
    },
    focus() { view.focus(); },
    destroy() { view.destroy(); },
  };
}

export type Composer = ReturnType<typeof createComposer>;
