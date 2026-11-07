/** 命令面板（⌘K／Ctrl+K）：跳转到任意页面与收藏的文件夹、按名称查找文件并直接打开，以及常用操作。
 * 列表上下键选择、回车执行、Esc 关闭；搜索只在普通文件中进行（私密空间请在私密页面内搜索）。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as api from "../api";
import { FileVisual, baseName, canPreview, getFileKind, parentPath } from "../files";
import { Icon, IS_MAC, lockPageScroll, type IconName } from "../ui";
import { usePreview } from "./preview-host";

export type Command = { id: string; label: string; group: string; icon: IconName; run: () => void; hint?: string; keywords?: string };
type Entry = Command & { file?: api.FileItem };

const SEARCH_LIMIT = 8;

/** 全局快捷键：⌘K／Ctrl+K 切换面板。输入法组合中、或已有其他对话框在最上层时不打开。 */
export function useCommandPaletteShortcut(enabled: boolean, toggle: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || !(IS_MAC ? event.metaKey : event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "k") return;
      if (!document.querySelector(".command-palette") && document.querySelector(".modal-backdrop:not(.is-minimized)")) return;
      event.preventDefault();
      if (!event.repeat) toggle();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, toggle]);
}

const matches = (command: Command, terms: string[]) => {
  const text = `${command.label} ${command.group} ${command.keywords ?? ""}`.toLowerCase();
  return terms.every(term => text.includes(term));
};

export function CommandPalette({ commands, onClose, onOpenFolder }: { commands: Command[]; onClose: () => void; onOpenFolder: (prefix: string) => void }) {
  const preview = usePreview();
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<api.FileItem[]>([]), [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const unlock = lockPageScroll();
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => { unlock(); previous?.focus?.(); };
  }, []);
  // 输入停顿 200 ms 后查找文件；新输入会取消上一次请求。
  useEffect(() => {
    const text = query.trim();
    setFiles([]);
    if (!text) { setSearching(false); return; }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      void api.searchFiles(text, "", false, SEARCH_LIMIT, "", "", controller.signal)
        .then(page => { if (!controller.signal.aborted) setFiles(page.objects.slice(0, SEARCH_LIMIT)); })
        .catch(() => undefined).finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 200);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);
  const openFile = (file: api.FileItem) => {
    const kind = getFileKind(file.content_type, file.key);
    if (!canPreview(kind, file.key, file.content_type)) { onOpenFolder(parentPath(file.key)); return; }
    preview.open({ file, url: api.contentUrl(file.key), downloadUrl: api.contentUrl(file.key, true), assetUrl: key => api.contentUrl(key),
      playlistFiles: [file], poster: api.fileThumbnail(file, "poster"), grid: api.fileThumbnail(file, "grid"), thumbnail: api.fileThumbnail(file) });
  };
  const entries = useMemo<Entry[]>(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = terms.length ? commands.filter(command => matches(command, terms)) : commands;
    const found: Entry[] = files.map(file => {
      const folder = file.key.endsWith("/"), parent = parentPath(file.key.replace(/\/$/, ""));
      return { id: `file:${file.key}`, label: baseName(file.key.replace(/\/$/, "")) || file.key, group: "文件", icon: folder ? "folder" : "file",
        hint: parent ? `/${parent}` : "我的文件", file, run: () => folder ? onOpenFolder(file.key) : openFile(file) };
    });
    return [...shown.slice(0, terms.length ? 8 : shown.length), ...found];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands, query, files]);
  useEffect(() => { setActive(0); }, [query, files]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const run = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    // 先关闭面板再执行，执行时打开的预览或对话框不会被面板的焦点恢复抢走。
    window.setTimeout(entry.run, 0);
  };
  let previousGroup = "";
  return createPortal(<div className="modal-backdrop command-palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板"
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setActive(current => entries.length ? (current + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length : 0);
        } else if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); run(entries[active]); }
        else if (event.key === "Tab") event.preventDefault();
      }}>
      <label className="command-palette-search">
        <Icon name="search" size={18} />
        <input ref={input} value={query} onChange={event => setQuery(event.target.value)} placeholder="跳转页面、查找文件或执行操作…" aria-label="搜索命令或文件"
          role="combobox" aria-expanded="true" aria-controls="command-palette-list" aria-activedescendant={entries[active] ? `command-${active}` : undefined} spellCheck={false} />
        {searching && <span className="spinner" aria-hidden="true" />}
        <kbd>Esc</kbd>
      </label>
      <ul ref={list} id="command-palette-list" className="command-palette-list" role="listbox" aria-label="结果">
        {entries.map((entry, index) => {
          const heading = entry.group !== previousGroup ? entry.group : null;
          previousGroup = entry.group;
          return <li key={entry.id} role="presentation">
            {heading && <div className="command-palette-group" role="presentation">{heading}</div>}
            <div id={`command-${index}`} role="option" aria-selected={index === active} data-index={index}
              className={`command-palette-item${index === active ? " is-active" : ""}`}
              onMouseMove={() => { if (index !== active) setActive(index); }} onClick={() => run(entry)}>
              <span className="command-palette-icon">{entry.file && !entry.file.key.endsWith("/")
                ? <FileVisual kind={getFileKind(entry.file.content_type, entry.file.key)} src={api.fileThumbnail(entry.file)} size="md" />
                : <Icon name={entry.icon} size={16} />}</span>
              <span className="command-palette-label">{entry.label}</span>
              {entry.hint && <span className="command-palette-hint">{entry.hint}</span>}
            </div>
          </li>;
        })}
        {!entries.length && !searching && <li className="command-palette-empty">没有找到「{query.trim()}」相关的页面、操作或文件</li>}
      </ul>
      <footer className="command-palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>{IS_MAC ? "⌘" : "Ctrl"}</kbd><kbd>K</kbd> 开关</span></footer>
    </div>
  </div>, document.body);
}
