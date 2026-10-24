/** 图片与媒体列表沿用打开预览时的当前页及显示顺序。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type FileItem } from "./api";
import { Icon, IconButton, formatBytes, type IconName } from "./ui";

export type PlaybackMode = "sequence" | "random" | "loop" | "single";
const MODES: { value: PlaybackMode; label: string }[] = [
  { value: "sequence", label: "顺序播放" }, { value: "random", label: "随机播放" },
  { value: "loop", label: "列表循环" }, { value: "single", label: "单曲循环" },
];
export const PLAYBACK_MODES = MODES;
export const MODE_ICONS: Record<PlaybackMode, IconName> = { sequence: "sequence", random: "shuffle", loop: "repeat", single: "repeatOne" };
/** 播放器自带的导航：上一个／下一个、播放模式与列表开关都放进播放器控制条，不再单独占一条工具栏。 */
export type PreviewNav = {
  index: number; count: number; onPrevious: () => void; onNext: () => void;
  mode?: PlaybackMode; onMode?: (mode: PlaybackMode) => void; playlistOpen?: boolean; onPlaylist?: () => void;
};
/** 图片底部的缩略图条：沿用播放列表的文件与当前项。 */
export type PreviewStrip = { items: FileItem[]; current: string; onSelect: (file: FileItem) => void; thumbnail: (file: FileItem) => string | undefined };
const MODE_KEY = "tessera-playback-mode";
const HISTORY_LIMIT = 100;
function initialMode(): PlaybackMode {
  try { const saved = localStorage.getItem(MODE_KEY); return MODES.find(mode => mode.value === saved)?.value ?? "sequence"; }
  catch { return "sequence"; }
}
const nameOf = (file: FileItem) => file.key.slice(file.key.lastIndexOf("/") + 1);

export function usePreviewPlaylist(file: FileItem, kind: string, files: FileItem[] | undefined, accepts: (file: FileItem) => boolean) {
  const [selection, setSelection] = useState({ origin: file.key, file });
  const [mode, setMode] = useState<PlaybackMode>(initialMode);
  const history = useRef<string[]>([]), returning = useRef(false);
  const base = useMemo(() => {
    const seen = new Set<string>();
    return (files ?? [file]).filter(item => {
      if (!accepts(item) || seen.has(item.key)) return false;
      seen.add(item.key); return true;
    });
    // 最小化后浏览其他页时，保留打开预览时的列表，不引入其他页的文件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.key, kind]);
  // 列表成员固定，但每一项用页面传来的最新信息（例如刚补上的缩略图）；页面已不包含的项保留原样。
  const items = useMemo(() => {
    const latest = new Map((files ?? []).map(item => [item.key, item]));
    latest.set(file.key, file);
    return base.map(item => latest.get(item.key) ?? item);
  }, [base, files, file]);
  const chosen = selection.origin === file.key ? selection.file : file;
  const current = items.find(item => item.key === chosen.key) ?? chosen;
  useEffect(() => {
    setSelection(current => current.origin === file.key && current.file === file ? current : { origin: file.key, file });
    history.current = []; returning.current = false;
  }, [file.key]);
  function select(next: FileItem) {
    if (kind !== "image" && mode === "random" && !returning.current && next.key !== current.key) {
      history.current.push(current.key);
      if (history.current.length > HISTORY_LIMIT) history.current.shift();
    }
    returning.current = false;
    setSelection({ origin: file.key, file: next });
  }
  function next(ended = false): FileItem | null {
    if (kind !== "image" && ended && mode === "single") return current;
    if (kind !== "image" && mode === "random") {
      const choices = items.filter(item => item.key !== current.key);
      return choices.length ? choices[Math.floor(Math.random() * choices.length)] : current;
    }
    const index = items.findIndex(item => item.key === current.key);
    return items[index + 1] ?? (mode === "loop" || !ended ? items[0] : null);
  }
  function previous(): FileItem {
    if (kind !== "image" && mode === "random") {
      const key = history.current.pop();
      const previous = items.find(item => item.key === key);
      returning.current = Boolean(previous && previous.key !== current.key);
      return previous ?? current;
    }
    const index = items.findIndex(item => item.key === current.key);
    return items[(index - 1 + items.length) % items.length] ?? current;
  }
  function changeMode(value: PlaybackMode) {
    setMode(value); history.current = []; returning.current = false;
    try { localStorage.setItem(MODE_KEY, value); } catch { /* 本地偏好不可用时仍可切换。 */ }
  }
  return { items, current, select, next, previous, mode, changeMode };
}

/**
 * 播放列表抽屉：浮在播放器右侧，不挤压画面；顶部可按文件名过滤（空格分隔多个关键词，都要命中），
 * 当前项显示律动条（播放中）或序号。点击抽屉外、按 Esc 或右上角按钮收起。
 */
export function PlaylistPanel({ playlist, onSelect, onCollapse, renderThumbnail, typeLabel, playing = false, image = false }: {
  playlist: ReturnType<typeof usePreviewPlaylist>; onSelect: (file: FileItem) => void; onCollapse: () => void; image?: boolean;
  renderThumbnail: (file: FileItem) => ReactNode; typeLabel: string; playing?: boolean;
}) {
  const list = useRef<HTMLOListElement>(null), search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const index = playlist.items.findIndex(file => file.key === playlist.current.key);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = terms.length ? playlist.items.filter(file => { const name = nameOf(file).toLowerCase(); return terms.every(term => name.includes(term)); }) : playlist.items;
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const reveal = () => {
      const current = node.querySelector<HTMLElement>('[aria-current="true"]');
      if (!node.clientHeight || !current) return;
      // 只按列表内的位置滚动，避免窗口动画、旋转与 scrollIntoView 连带移动背景。
      const top = current.offsetTop, bottom = top + current.offsetHeight;
      if (top < node.scrollTop) node.scrollTop = top;
      else if (bottom > node.scrollTop + node.clientHeight) node.scrollTop = bottom - node.clientHeight;
    };
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(reveal); };
    const observer = new ResizeObserver(schedule);
    observer.observe(node); schedule();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [playlist.current.key, playlist.items.length]);
  const label = image ? "图片列表" : "播放列表";
  return <aside id="preview-playlist-panel" className={`preview-playlist-panel${playing ? " is-playing" : ""}`} aria-label={label}
    onKeyDown={event => {
      if (event.key !== "Escape") return;
      // Esc 先清空过滤词，再收起抽屉；不让它冒泡关闭整个预览。
      event.preventDefault(); event.stopPropagation();
      if (query) setQuery(""); else onCollapse();
    }}>
    <header>
      <div className="preview-playlist-title"><strong>{label}</strong>
        <span className="preview-playlist-count">{terms.length ? `${shown.length} / ${playlist.items.length} 项` : `${Math.max(0, index) + 1} / ${playlist.items.length}`}</span></div>
      <IconButton icon="x" label={`收起${label}`} size="sm" onClick={onCollapse} />
    </header>
    {playlist.items.length > 1 && <label className="preview-playlist-search">
      <Icon name="search" size={14} />
      <input ref={search} type="search" placeholder="过滤文件名" aria-label={`过滤${label}`} value={query} spellCheck={false}
        onChange={event => setQuery(event.target.value)} />
      {query && <button type="button" aria-label="清空过滤" title="清空过滤" onClick={() => { setQuery(""); search.current?.focus(); }}><Icon name="x" size={12} /></button>}
    </label>}
    <ol ref={list} className="preview-playlist-items" aria-label={image ? "本页同目录的图片" : "本页同目录的可播放文件"}>
      {shown.map(file => {
        const current = file.key === playlist.current.key;
        const order = playlist.items.indexOf(file) + 1;
        return <li key={file.key}>
          <button type="button" className={`preview-track${current ? " is-current" : ""}`} aria-current={current ? "true" : undefined} title={nameOf(file)} onClick={() => onSelect(file)}>
            <span className="preview-track-order" aria-hidden="true">{current && !image
              ? <span className="preview-equalizer"><i /><i /><i /><i /></span> : String(order).padStart(2, "0")}</span>
            <span className="preview-track-cover">{renderThumbnail(file)}</span>
            <span className="preview-track-description"><strong>{nameOf(file)}</strong><span>{typeLabel} · {formatBytes(file.size)}</span></span>
            {!current && <Icon name={image ? "image" : "play"} size={14} className="preview-track-play" />}
          </button>
        </li>;
      })}
      {!shown.length && <li className="preview-playlist-empty">没有匹配“{query.trim()}”的文件</li>}
    </ol>
  </aside>;
}
