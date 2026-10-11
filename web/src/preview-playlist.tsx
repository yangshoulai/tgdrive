/** 同目录媒体列表：只加载元信息，选中后才读取媒体内容。 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage, type FileItem, type PreviewListPage } from "./api";
import { Button, Icon, IconButton, formatBytes } from "./ui";

export type PlaylistLoader = (file: FileItem, cursor: string | null, signal: AbortSignal) => Promise<PreviewListPage>;
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

export function useMediaPlaylist(file: FileItem, kind: string, load: PlaylistLoader | undefined, accepts: (file: FileItem) => boolean) {
  const [items, setItems] = useState([file]), [current, setCurrent] = useState(file);
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<PlaybackMode>(initialMode);
  const loader = useRef(load), accept = useRef(accepts), history = useRef<string[]>([]), returning = useRef(false);
  loader.current = load; accept.current = accepts;
  useEffect(() => { setCurrent(file); history.current = []; }, [file.key]);
  useEffect(() => {
    setItems([file]); setError("");
    if (!loader.current || (kind !== "audio" && kind !== "video")) { setLoading(false); return; }
    const controller = new AbortController(), read = loader.current;
    setLoading(true);
    void (async () => {
      const found = new Map([[file.key, file]]), cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await read(file, cursor, controller.signal);
        if (controller.signal.aborted) return;
        for (const item of page.objects) if (accept.current(item)) found.set(item.key, item);
        setItems([...found.values()].sort((a, b) => nameOf(a).localeCompare(nameOf(b), "zh-CN", { numeric: true }) || a.key.localeCompare(b.key)));
        cursor = page.next_cursor;
        if (cursor && cursors.has(cursor)) throw new Error("文件列表分页未能继续，请重试");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    })().catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason, "播放列表加载失败")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
    // 加载器可随父组件渲染更新，但同目录播放切换不重复扫描目录。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.key, kind, Boolean(load), attempt]);
  function select(next: FileItem) {
    if (mode === "random" && !returning.current && next.key !== current.key) {
      history.current.push(current.key);
      if (history.current.length > HISTORY_LIMIT) history.current.shift();
    }
    returning.current = false;
    setCurrent(next);
  }
  function next(ended = false): FileItem | null {
    if (ended && mode === "single") return current;
    if (mode === "random") {
      const choices = items.filter(item => item.key !== current.key);
      return choices.length ? choices[Math.floor(Math.random() * choices.length)] : current;
    }
    const index = items.findIndex(item => item.key === current.key);
    return items[index + 1] ?? (mode === "loop" || !ended ? items[0] : null);
  }
  function previous(): FileItem {
    if (mode === "random") {
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
  return { items, current, select, next, previous, mode, changeMode, loading, error, retry: () => setAttempt(value => value + 1) };
}

export function PlaylistControls({ playlist, onSelect, compact = false, playing, onToggle, expanded, onExpand }: {
  playlist: ReturnType<typeof useMediaPlaylist>; onSelect: (file: FileItem) => void; compact?: boolean; playing: boolean; onToggle: () => void;
  expanded?: boolean; onExpand?: () => void;
}) {
  const index = playlist.items.findIndex(file => file.key === playlist.current.key);
  return <section className={`preview-playlist${compact ? " is-compact" : ""}`} aria-label="播放列表">
    <div className="preview-playlist-toolbar">
      <div className="preview-transport">
        <IconButton icon="previous" label="上一个文件" size="sm" disabled={playlist.items.length < 2} onClick={() => onSelect(playlist.previous())} />
        {compact && <IconButton icon={playing ? "pause" : "play"} label={playing ? "暂停播放" : "继续播放"} size="sm" onClick={onToggle} />}
        <IconButton icon="next" label="下一个文件" size="sm" disabled={playlist.items.length < 2} onClick={() => { const next = playlist.next(); if (next) onSelect(next); }} />
      </div>
      <label className="preview-playback-mode"><span className="sr-only">播放模式</span>
        <select aria-label="播放模式" value={playlist.mode} onChange={event => playlist.changeMode(event.target.value as PlaybackMode)}>
          {MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
        </select><Icon name="chevronDown" size={12} />
      </label>
      {!compact && <Button variant="ghost" size="sm" icon="list" className="preview-playlist-toggle" aria-expanded={expanded} aria-controls={expanded ? "preview-playlist-panel" : undefined} onClick={onExpand}>
        播放列表 <span className="preview-playlist-count">{Math.max(0, index) + 1} / {playlist.items.length}</span>
        {playlist.loading && <span className="spinner" />}
        {!playlist.loading && playlist.error && <span title="播放列表加载失败，展开后可重试"><Icon name="alert" size={12} /></span>}
      </Button>}
    </div>
  </section>;
}

export function PlaylistPanel({ playlist, onSelect, onCollapse, renderThumbnail, typeLabel }: {
  playlist: ReturnType<typeof useMediaPlaylist>; onSelect: (file: FileItem) => void; onCollapse: () => void;
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
  return <aside id="preview-playlist-panel" className="preview-playlist-panel" aria-label="播放列表">
    <header><strong>播放列表</strong><span className="preview-playlist-count">{Math.max(0, index) + 1} / {playlist.items.length}</span>
      <IconButton icon="x" label="收起播放列表" size="sm" onClick={onCollapse} />
    </header>
    {playlist.error && <div className="preview-playlist-error" role="status"><span>{playlist.error}</span><Button variant="ghost" size="sm" icon="refresh" onClick={playlist.retry}>重试列表</Button></div>}
    <ol ref={list} className="preview-playlist-items" aria-label="同目录的可播放文件">
      {playlist.items.map(file => <li key={file.key}>
        <Button variant="ghost" size="sm" className={file.key === playlist.current.key ? "is-current" : ""} aria-current={file.key === playlist.current.key ? "true" : undefined} title={nameOf(file)} onClick={() => onSelect(file)}>
          {renderThumbnail(file)}<span className="preview-track-description"><strong>{nameOf(file)}</strong><span>{typeLabel} · {formatBytes(file.size)}</span></span>
          {file.key === playlist.current.key && <Icon name="play" size={12} />}
        </Button>
      </li>)}
    </ol>
  </aside>;
}
