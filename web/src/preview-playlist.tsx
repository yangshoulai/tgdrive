/** 图片与媒体列表沿用打开预览时的当前页及显示顺序。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type FileItem } from "./api";
import { Button, Icon, IconButton, formatBytes } from "./ui";

export type PlaybackMode = "sequence" | "random" | "loop" | "single";
const MODES: { value: PlaybackMode; label: string }[] = [
  { value: "sequence", label: "顺序播放" }, { value: "random", label: "随机播放" },
  { value: "loop", label: "列表循环" }, { value: "single", label: "单曲循环" },
];
const MODE_KEY = "tessera-playback-mode";
const HISTORY_LIMIT = 100;
function initialMode(): PlaybackMode {
  try { const saved = localStorage.getItem(MODE_KEY); return MODES.find(mode => mode.value === saved)?.value ?? "sequence"; }
  catch { return "sequence"; }
}
const nameOf = (file: FileItem) => file.key.slice(file.key.lastIndexOf("/") + 1);

export function usePreviewPlaylist(file: FileItem, kind: string, files: FileItem[] | undefined, accepts: (file: FileItem) => boolean) {
  const [selection, setSelection] = useState({ origin: file.key, file });
  const current = selection.origin === file.key ? selection.file : file;
  const [mode, setMode] = useState<PlaybackMode>(initialMode);
  const history = useRef<string[]>([]), returning = useRef(false);
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (files ?? [file]).filter(item => {
      if (!accepts(item) || seen.has(item.key)) return false;
      seen.add(item.key); return true;
    });
    // 最小化后浏览其他页时，保留打开预览时的列表，不引入其他页的文件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.key, kind]);
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

export function PlaylistControls({ playlist, onSelect, compact = false, image = false, playing, onToggle, expanded, onExpand }: {
  playlist: ReturnType<typeof usePreviewPlaylist>; onSelect: (file: FileItem) => void; compact?: boolean; image?: boolean; playing: boolean; onToggle: () => void;
  expanded?: boolean; onExpand?: () => void;
}) {
  const index = playlist.items.findIndex(file => file.key === playlist.current.key);
  const label = image ? "图片列表" : "播放列表";
  return <section className={`preview-playlist${compact ? " is-compact" : ""}`} aria-label={label}>
    <div className="preview-playlist-toolbar">
      <div className="preview-transport">
        <IconButton icon="previous" label="上一个文件" size="sm" disabled={playlist.items.length < 2} onClick={() => onSelect(playlist.previous())} />
        {compact && !image && <IconButton icon={playing ? "pause" : "play"} label={playing ? "暂停播放" : "继续播放"} size="sm" onClick={onToggle} />}
        <IconButton icon="next" label="下一个文件" size="sm" disabled={playlist.items.length < 2} onClick={() => { const next = playlist.next(); if (next) onSelect(next); }} />
      </div>
      {!image && <label className="preview-playback-mode"><span className="sr-only">播放模式</span>
        <select aria-label="播放模式" value={playlist.mode} onChange={event => playlist.changeMode(event.target.value as PlaybackMode)}>
          {MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
        </select><Icon name="chevronDown" size={12} />
      </label>}
      {compact && image && <span className="preview-playlist-count">{Math.max(0, index) + 1} / {playlist.items.length}</span>}
      {!compact && <Button variant="ghost" size="sm" icon="list" className="preview-playlist-toggle" aria-expanded={expanded} aria-controls={expanded ? "preview-playlist-panel" : undefined} onClick={onExpand}>
        {label} <span className="preview-playlist-count">{Math.max(0, index) + 1} / {playlist.items.length}</span>
      </Button>}
    </div>
  </section>;
}

export function PlaylistPanel({ playlist, onSelect, onCollapse, renderThumbnail, typeLabel, image = false }: {
  playlist: ReturnType<typeof usePreviewPlaylist>; onSelect: (file: FileItem) => void; onCollapse: () => void; image?: boolean;
  renderThumbnail: (file: FileItem) => ReactNode; typeLabel: string;
}) {
  const list = useRef<HTMLOListElement>(null);
  const index = playlist.items.findIndex(file => file.key === playlist.current.key);
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const reveal = () => { if (node.clientHeight) node.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" }); };
    const observer = new ResizeObserver(reveal);
    observer.observe(node); reveal();
    return () => observer.disconnect();
  }, [playlist.current.key, playlist.items.length]);
  const label = image ? "图片列表" : "播放列表";
  return <aside id="preview-playlist-panel" className="preview-playlist-panel" aria-label={label}>
    <header><strong>{label}</strong><span className="preview-playlist-count">{Math.max(0, index) + 1} / {playlist.items.length}</span>
      <IconButton icon="x" label={`收起${label}`} size="sm" onClick={onCollapse} />
    </header>
    <ol ref={list} className="preview-playlist-items" aria-label={image ? "本页同目录的图片" : "本页同目录的可播放文件"}>
      {playlist.items.map(file => <li key={file.key}>
        <Button variant="ghost" size="sm" className={file.key === playlist.current.key ? "is-current" : ""} aria-current={file.key === playlist.current.key ? "true" : undefined} title={nameOf(file)} onClick={() => onSelect(file)}>
          {renderThumbnail(file)}<span className="preview-track-description"><strong>{nameOf(file)}</strong><span>{typeLabel} · {formatBytes(file.size)}</span></span>
          {file.key === playlist.current.key && <Icon name={image ? "check" : "play"} size={12} />}
        </Button>
      </li>)}
    </ol>
  </aside>;
}
