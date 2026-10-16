/** 输入框里的 @ 引用：输入 @ 列出当前目录，继续输入在全部普通文件中搜索；选中后插入 @/路径，发送时随消息提交。 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import * as api from "../api";
import { FileTile, baseName, getFileKind, parentPath } from "../files";
import { Icon } from "../ui";

export type Mention = { key: string; folder: boolean };
type Candidate = Mention & { name: string; parent: string };

const TOKEN = /(?:^|\s)@([^\s@]{0,60})$/;
const LIMIT = 20;

/** 当前光标前正在输入的 @ 片段；没有时返回 null。 */
function tokenAt(text: string, caret: number) {
  const match = TOKEN.exec(text.slice(0, caret));
  return match ? { query: match[1], start: caret - match[1].length - 1 } : null;
}

const candidate = (key: string, folder: boolean): Candidate => ({ key, folder, name: baseName(key), parent: "/" + parentPath(key) });

/** 一组引用的公共上级目录（对象键，"" 表示根目录）：文件取所在目录，文件夹取自身。 */
export function commonFolder(keys: string[]): string {
  const dirs = keys.map(key => key.endsWith("/") ? key : parentPath(key));
  if (!dirs.length) return "";
  let parts = dirs[0].split("/").filter(Boolean);
  for (const dir of dirs.slice(1)) {
    const other = dir.split("/").filter(Boolean);
    let index = 0;
    while (index < parts.length && index < other.length && parts[index] === other[index]) index += 1;
    parts = parts.slice(0, index);
  }
  return parts.length ? parts.join("/") + "/" : "";
}

export function useMentions({ draft, setDraft, input, location, enabled }: {
  draft: string; setDraft: (value: string) => void; input: RefObject<HTMLTextAreaElement>; location: string; enabled: boolean;
}) {
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [token, setToken] = useState<{ query: string; start: number } | null>(null);
  const [items, setItems] = useState<Candidate[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  // 文本里已删掉的引用不再提交。
  const present = mentions.filter(item => draft.includes(`@/${item.key}`));

  function sync() {
    const node = input.current;
    if (!node || !enabled) { setToken(null); return; }
    const next = node.selectionStart === node.selectionEnd ? tokenAt(node.value, node.selectionStart) : null;
    setToken(current => current?.query === next?.query && current?.start === next?.start ? current : next);
  }

  useEffect(() => {
    if (!token) { setItems([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const query = token.query.trim().toLowerCase();
        const here = await api.listFiles(location, null, false, 60, "", controller.signal);
        const folders = here.common_prefixes.filter(key => !key.startsWith(".tgdrive/")).map(key => candidate(key, true));
        const files = here.objects.filter(item => !item.key.endsWith("/")).map(item => candidate(item.key, false));
        let found = [...folders, ...files].filter(item => !query || item.name.toLowerCase().includes(query));
        if (query) {
          const search = await api.searchFiles(token.query.trim(), "", false, LIMIT, "", "", controller.signal);
          const seen = new Set(found.map(item => item.key));
          found = [...found, ...search.objects.filter(item => !seen.has(item.key) && !item.key.endsWith("/")).map(item => candidate(item.key, false))];
        }
        if (!controller.signal.aborted) { setItems(found.slice(0, LIMIT)); setActive(0); }
      } catch { if (!controller.signal.aborted) setItems([]); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, token.query ? 160 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [token?.query, location]); // eslint-disable-line react-hooks/exhaustive-deps

  function choose(item: Candidate) {
    const node = input.current;
    if (!node || !token) return;
    // 替换范围按 @ 片段本身计算，不读当前光标：上一次插入后的光标还原可能晚于后续输入。
    const end = token.start + 1 + token.query.length;
    const inserted = `@/${item.key} `;
    const next = draft.slice(0, token.start) + inserted + draft.slice(end).replace(/^ /, "");
    setDraft(next);
    setMentions(current => current.some(value => value.key === item.key) ? current : [...current, { key: item.key, folder: item.folder }]);
    setToken(null);
    const position = token.start + inserted.length;
    // 等 React 写回新文本后再放置光标；不依赖动画帧，后台标签页里同样生效。
    window.setTimeout(() => { node.focus(); node.setSelectionRange(position, position); }, 0);
  }

  function remove(key: string) {
    setDraft(draft.split(`@/${key} `).join("").split(`@/${key}`).join(""));
    setMentions(current => current.filter(item => item.key !== key));
  }

  /** 候选列表打开时接管方向键、回车、Tab 与 Esc；返回 true 表示已处理。 */
  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (!token || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") { event.preventDefault(); setToken(null); return true; }
    if (!items.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(value => (value + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); choose(items[active]); return true; }
    return false;
  }

  const menu = token ? <div className="assistant-mention-menu" role="listbox" aria-label="引用文件或文件夹">
    <div className="assistant-mention-head"><Icon name="at" size={13} /><span>{token.query ? `搜索“${token.query}”` : `当前位置 /${location}`}</span><kbd>↑↓</kbd><kbd>Enter</kbd></div>
    {items.length ? items.map((item, index) => <button key={item.key} type="button" role="option" aria-selected={index === active}
      className={`assistant-mention-item${index === active ? " is-active" : ""}`}
      onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
      <FileTile kind={item.folder ? "folder" : getFileKind(null, item.key)} />
      <span className="assistant-mention-name">{item.name}{item.folder ? "/" : ""}</span>
      <span className="assistant-mention-path">{item.parent}</span>
    </button>) : <p className="assistant-mention-empty">{loading ? "正在查找…" : token.query ? "没有匹配的文件" : "这里还没有文件"}</p>}
  </div> : null;

  return { mentions: present, menu, sync, onKeyDown, remove, reset: () => { setMentions([]); setToken(null); } };
}
