/** 播放界面与歌词、字幕附件；缓冲状态始终保留播放器。
 * 视频使用 ArtPlayer（按需加载）；音乐使用原生 <audio> 与自绘界面：模糊封面背景、唱片、同步歌词（没有时显示音频信息）和一体化控制条。 */
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { errorMessage, type MediaTags, type MediaWant, type PreviewAsset, type PreviewAssetList } from "./api";
import { readPreviewText } from "./preview-data";
import { loadMediaEngine } from "./preview-runtime";
import { MODE_ICONS, PLAYBACK_MODES, type PreviewNav } from "./preview-playlist";
import { Button, Icon, Menu, formatBytes, shortcutAria, shortcutLabel, type IconName } from "./ui";
import type { MediaProgress, MediaState, VideoSizeSource } from "./preview-media-engine";
export type { MediaProgress, MediaState } from "./preview-media-engine";

type Engine = Awaited<ReturnType<typeof loadMediaEngine>>;
type VideoPlayer = ReturnType<Engine["createVideoPlayer"]>;
type Lyric = { time: number; text: string };
export type AssetLoader = (signal: AbortSignal) => Promise<PreviewAsset[] | PreviewAssetList>;
export type PlaybackControls = { play: () => Promise<void>; pause: () => void; isPlaying: () => boolean; seek: (time: number) => void; seekBy: (seconds: number) => void; adjustVolume: (delta: number) => void };
export type PlaybackProps = { onEnded?: () => void; onPlaying?: (playing: boolean) => void; onProgress?: (progress: MediaProgress) => void; onState?: (state: MediaState) => void; onControls?: (controls: PlaybackControls | null) => void; onVideoSize?: (width: number, height: number, source: VideoSizeSource) => void; onVideoFrame?: (video: HTMLVideoElement) => void; onSaveThumbnail?: (video: HTMLVideoElement, rotation: number) => Promise<void>; onLyricLine?: (line: string | null) => void;
  /** 视频画面旋转（顺时针角度），由上层按文件记住；播放器设置菜单与快捷键 R 经 onRotate 修改。 */
  rotation?: number; onRotate?: (degrees: number) => void;
  /** 缓冲速度（字节／秒，估算值）；不在加载或缓冲、或无法估算时为 null。最小化小窗据此显示。 */
  onBufferSpeed?: (speed: number | null) => void;
  /** 在线查找歌词、字幕或封面（只给本人可写的文件）；没有歌词、字幕或封面时播放器里出现对应入口。 */
  onFindAssets?: (want: MediaWant) => void;
  /** 歌词／字幕附件有变化（如刚保存了在线找到的歌词）时递增，播放器重新读取并优先选中 preferAsset。 */
  assetRevision?: number; preferAsset?: string };
type Player = PlaybackControls & { setSource: (url: string, name: string, cover?: string) => void; destroy: () => void };

function playbackTime(time: number): string {
  const seconds = Math.floor(time), hours = Math.floor(seconds / 3600);
  return [...(hours ? [String(hours)] : []), String(Math.floor(seconds / 60) % 60).padStart(2, "0"), String(seconds % 60).padStart(2, "0")].join(":");
}
/** 当前位置所在缓冲段的末尾，以及它后面下一段的起点（用于识别两段合并）。 */
function bufferedAhead(media: HTMLMediaElement): { end: number; next: number } {
  const time = media.currentTime, ranges = media.buffered;
  for (let index = 0; index < ranges.length; index++) {
    if (ranges.start(index) <= time + 0.25 && time <= ranges.end(index))
      return { end: ranges.end(index), next: index + 1 < ranges.length ? ranges.start(index + 1) : Infinity };
  }
  for (let index = 0; index < ranges.length; index++) if (ranges.start(index) > time) return { end: time, next: ranges.start(index) };
  return { end: time, next: Infinity };
}
/** 缓冲速度：浏览器不提供媒体请求的实时字节数，用当前缓冲段末尾的增长 × 文件平均码率（大小 ÷ 时长）估算，取最近 3 秒。
 *  跳转或与后面已缓冲的段合并时重新计时，避免跳变；读到时长前无法估算。
 *  不在服务端统计发送字节：系统缓冲区与反向代理会先吞下几 MB，服务端看到的是到代理的速度，不是浏览器实际收到的速度。 */
export function useBufferSpeed(media: () => HTMLMediaElement | null, active: boolean, size?: number, resetKey?: string): number | null {
  const [speed, setSpeed] = useState<number | null>(null);
  useEffect(() => {
    setSpeed(null);
    if (!active || !size) return;
    let samples: { time: number; end: number; next: number }[] = [];
    const tick = () => {
      const element = media();
      if (!element || !Number.isFinite(element.duration) || element.duration <= 0) return;
      const now = performance.now(), { end, next } = bufferedAhead(element), last = samples.at(-1);
      if (last && (end < last.end || end >= last.next)) samples = [];
      samples.push({ time: now, end, next });
      samples = samples.filter(sample => now - sample.time <= 3000);
      const first = samples[0];
      if (now - first.time < 900) return;
      setSpeed(Math.max(0, (end - first.end) / ((now - first.time) / 1000) * size / element.duration));
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [active, size, media, resetKey]);
  return active ? speed : null;
}
export const formatSpeed = (speed: number) => `${formatBytes(speed)}/s`;
/** 最小化后的迷你播放器：一行歌词／状态、切歌与播放、模式和时间，底边是可拖动的细进度条。 */
export function MinimizedPlayback({ progress, state, playing, lyric, speed, onSeek, onToggle, nav }: {
  progress: MediaProgress; state: MediaState; playing: boolean; lyric?: string | null; speed?: number | null; onSeek: (time: number) => void; onToggle: () => void; nav?: PreviewNav;
}) {
  const time = playbackTime(progress.currentTime), duration = progress.duration ? playbackTime(progress.duration) : "--:--";
  const percent = progress.duration ? progress.currentTime / progress.duration * 100 : 0;
  const failed = state === "failed", waiting = state === "loading" || state === "buffering";
  const status = (failed ? "播放失败" : state === "loading" ? "正在加载" : state === "buffering" ? "正在缓冲" : playing ? "正在播放" : "已暂停")
    + (waiting && speed != null ? ` · ${formatSpeed(speed)}` : "");
  const modeIndex = Math.max(0, PLAYBACK_MODES.findIndex(mode => mode.value === nav?.mode));
  const nextMode = PLAYBACK_MODES[(modeIndex + 1) % PLAYBACK_MODES.length];
  return <div className={`preview-mini-player${playing && state === "ready" ? " is-playing" : ""}${waiting ? " is-waiting" : ""}${failed ? " is-failed" : ""}`}>
    <div className="preview-mini-line">
      <span className="preview-equalizer" aria-hidden="true"><i /><i /><i /><i /></span>
      {lyric && !(waiting && speed != null) ? <span key={lyric} className="preview-mini-lyric" title={lyric} aria-label={`当前歌词：${lyric}`}>{lyric}</span> : <span className="preview-mini-status" role="status">{status}</span>}
    </div>
    <div className="preview-mini-controls">
      {nav?.onMode && nav.mode
        ? <MediaButton icon={MODE_ICONS[nav.mode]} label={`${PLAYBACK_MODES[modeIndex]?.label ?? "播放模式"}（点击切换为${nextMode.label}）`} active={nav.mode !== "sequence"} onClick={() => nav.onMode?.(nextMode.value)} />
        : <span />}
      <div className="preview-mini-transport">
        <MediaButton icon="previous" label="上一个" shortcut="ArrowLeft" disabled={!nav || nav.count < 2} onClick={nav?.onPrevious} />
        <button type="button" className="preview-mini-play" aria-label={playing ? "暂停" : "播放"} aria-keyshortcuts="Space K" title={playing ? "暂停（空格 / K）" : "播放（空格 / K）"} disabled={failed} onClick={onToggle}>
          <Icon name={playing ? "pause" : "play"} size={18} />
        </button>
        <MediaButton icon="next" label="下一个" shortcut="ArrowRight" disabled={!nav || nav.count < 2} onClick={nav?.onNext} />
      </div>
      <span className="preview-mini-time">{time}<span> / {duration}</span></span>
    </div>
    <input className="preview-mini-progress" type="range" aria-label="播放进度" aria-valuetext={`已播放 ${time}，共 ${duration}`} min={0} max={progress.duration || 1} step={0.1}
      value={progress.duration ? progress.currentTime : 0} disabled={!progress.duration || failed} onChange={event => onSeek(Number(event.target.value))}
      data-media-progress="" style={{ "--playback-progress": `${percent}%` } as CSSProperties} />
  </div>;
}

export function parseLyrics(source: string): Lyric[] {
  const offset = Number(/\[offset\s*:\s*([+-]?\d+)\]/i.exec(source)?.[1] ?? 0) / 1000;
  const lines = new Map<number, string>();
  for (const line of source.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = line.replace(/\[\d+:\d{2}(?:[.:]\d{1,3})?\]/g, "").trim();
    for (const stamp of stamps) {
      if (Number(stamp[2]) >= 60) continue;
      const time = Math.max(0, Number(stamp[1]) * 60 + Number(stamp[2]) + Number(`0.${stamp[3] ?? "0"}`) + offset);
      if (!lines.has(time)) lines.set(time, text);
      else if (text) lines.set(time, [lines.get(time), text].filter(Boolean).join("\n"));
    }
  }
  return [...lines].map(([time, text]) => ({ time, text })).sort((a, b) => a.time - b.time);
}
function lyricAt(lines: Lyric[], time: number) {
  let low = 0, high = lines.length;
  while (low < high) { const middle = (low + high) >>> 1; if (lines[middle].time <= time) low = middle + 1; else high = middle; }
  return low - 1;
}
function assetLabel(asset: PreviewAsset): string {
  // 内置歌词与字幕轨的名称已是给人看的说明（如「内置 · 简体中文」）。
  if (asset.source === "embedded") return asset.name;
  const languages: Record<string, string> = { zh: "中文", chi: "中文", zho: "中文", "zh-cn": "简体中文", "zh-hans": "简体中文", "zh-tw": "繁体中文", "zh-hant": "繁体中文", en: "英语", eng: "英语", ja: "日语", jpn: "日语", ko: "韩语", kor: "韩语", fr: "法语", fra: "法语", de: "德语", deu: "德语", es: "西班牙语", spa: "西班牙语", it: "意大利语", pt: "葡萄牙语", ru: "俄语" };
  // 没有语言标记的附件按格式命名（如“SRT 字幕”“LRC 歌词”），比“默认”更清楚。
  const format = asset.name.split(".").at(-1)?.toUpperCase() ?? "";
  return (asset.language && languages[asset.language.toLowerCase()]) || asset.language || `${format} ${asset.kind === "lyrics" ? "歌词" : "字幕"}`.trim();
}

const chinese = (asset: PreviewAsset) => /^(zh|chi|zho)\b/i.test(asset.language ?? "");
/** 默认选中的歌词或字幕：文件内置的优先。音乐依次是内置同步歌词、同名 .lrc（无语言标记优先）、内置普通歌词；
 *  视频依次是能立即读取的内置中文字幕、同名中文字幕、其他能立即读取的内置字幕、同名字幕（无语言标记优先）。
 *  MKV 的内置字幕要读完整个文件，只在用户从菜单里选择时提取。 */
function pickAsset(kind: "audio" | "video", items: PreviewAsset[], prefer?: string): PreviewAsset | undefined {
  const preferred = prefer ? items.find(item => item.path === prefer) : undefined;
  if (preferred) return preferred;
  const files = items.filter(item => item.source !== "embedded"), embedded = items.filter(item => item.source === "embedded");
  // 同目录的同名歌词、字幕文件是用户（或文件助手）有意保存的，优先于文件内置的数据；没有时用内置数据。
  // 上传时不会把内置歌词另存为 .lrc，所以同名文件存在就说明内置数据被替换过。
  if (kind === "audio") return files.find(item => !item.language) ?? files[0] ?? embedded.find(item => item.synced) ?? embedded[0];
  const ready = embedded.filter(item => item.instant);
  return files.find(chinese) ?? ready.find(chinese) ?? files.find(item => !item.language) ?? files[0] ?? ready[0];
}

/* ---------- 音乐：原生 <audio> ---------- */

const VOLUME_KEY = "tessera-volume";
type AudioEvents = { notify: (state: MediaState) => void; onPlaying: (playing: boolean) => void; onProgress: (progress: MediaProgress, buffered: number) => void; onEnded: () => void; onVolume: (volume: number, muted: boolean) => void };
type AudioPlayer = Player & { element: HTMLAudioElement; setVolume: (volume: number) => void; toggleMute: () => void };

function createAudioPlayer(url: string, events: AudioEvents): AudioPlayer {
  const audio = new Audio();
  audio.preload = "metadata";
  try { const saved = Number(localStorage.getItem(VOLUME_KEY)); if (saved >= 0 && saved <= 1 && localStorage.getItem(VOLUME_KEY) !== null) audio.volume = saved; } catch { /* 无法读取偏好时使用默认音量 */ }
  let ready = false, destroyed = false;
  const progress = (): MediaProgress => {
    const duration = Number.isFinite(audio.duration) ? Math.max(0, audio.duration) : 0;
    const currentTime = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
    return { currentTime: duration ? Math.min(currentTime, duration) : currentTime, duration };
  };
  const buffered = () => { const ranges = audio.buffered; return ranges.length ? ranges.end(ranges.length - 1) : 0; };
  const update = () => { if (!destroyed) events.onProgress(progress(), buffered()); };
  const markReady = () => { ready = true; events.notify("ready"); };
  const listeners: [string, () => void][] = [
    ["loadedmetadata", () => { markReady(); update(); }], ["canplay", markReady], ["playing", markReady],
    ["waiting", () => events.notify(ready ? "buffering" : "loading")],
    ["play", () => events.onPlaying(true)],
    ["pause", () => { events.onPlaying(false); if (ready) events.notify("ready"); }],
    ["timeupdate", update], ["durationchange", update], ["progress", update],
    ["seeked", () => { update(); if (audio.readyState >= 2) markReady(); }],
    ["ended", () => { markReady(); events.onPlaying(false); events.onEnded(); }],
    ["error", () => { if (audio.getAttribute("src")) events.notify("failed"); }],
    ["volumechange", () => {
      events.onVolume(audio.volume, audio.muted);
      try { localStorage.setItem(VOLUME_KEY, String(audio.volume)); } catch { /* 偏好保存失败不影响播放 */ }
    }],
  ];
  for (const [name, handler] of listeners) audio.addEventListener(name, handler);
  audio.src = url;
  events.onVolume(audio.volume, audio.muted);
  return {
    element: audio,
    play: () => audio.play(),
    pause: () => audio.pause(),
    isPlaying: () => !audio.paused,
    seek: time => { audio.currentTime = time; update(); },
    seekBy: seconds => { const { currentTime, duration } = progress(); if (duration) audio.currentTime = Math.max(0, Math.min(duration, currentTime + seconds)); update(); },
    adjustVolume: delta => { audio.muted = false; audio.volume = Math.max(0, Math.min(1, audio.volume + delta)); },
    setVolume: volume => { audio.volume = Math.max(0, Math.min(1, volume)); audio.muted = volume === 0; },
    toggleMute: () => { if (audio.muted || audio.volume === 0) { audio.muted = false; if (audio.volume === 0) audio.volume = .6; } else audio.muted = true; },
    setSource: nextUrl => {
      audio.pause(); ready = false; events.notify("loading");
      audio.src = nextUrl; audio.load();
      events.onPlaying(false); events.onProgress({ currentTime: 0, duration: 0 }, 0);
    },
    destroy: () => {
      destroyed = true; audio.pause();
      for (const [name, handler] of listeners) audio.removeEventListener(name, handler);
      audio.removeAttribute("src"); audio.load();
    },
  };
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 没有封面时的色调：按文件名固定选一种图表色（--series-1…6），同一首歌每次一样，不同歌曲各不相同。 */
export function coverTint(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `var(--series-${hash % 6 + 1})`;
}

/** 唱片（网易云音乐式）：大唱片居中，封面占唱片约三分之二、外圈一圈黑色刻纹，唱针支点在唱片上方，播放时匀速转动，开始播放渐渐转起、暂停后慢慢停下；
 * 没有封面时标签是主题色。唱臂在点了播放后落到唱片上，暂停时抬起移开。唱片表面的高光不随唱片转动，转动才看得出来。减少动态效果时不转。 */
function Turntable({ cover, spinning }: { cover?: string; spinning: boolean }) {
  const disc = useRef<HTMLDivElement>(null);
  const motion = useRef({ angle: 0, speed: 0 });
  useEffect(() => {
    const node = disc.current;
    if (!node || reducedMotion()) return;
    // 与网易云音乐相近：约 20 秒一圈（每秒 18°），慢转才看得清封面；起转约 1 秒、停转约 1.5 秒。
    const target = spinning ? 18 : 0, state = motion.current;
    let frame = 0, last = performance.now();
    const step = (now: number) => {
      const elapsed = Math.min(.1, (now - last) / 1000); last = now;
      state.speed += (target - state.speed) * Math.min(1, elapsed * (spinning ? 3 : 2));
      if (!spinning && state.speed < .1) state.speed = 0;
      state.angle = (state.angle + state.speed * elapsed) % 360;
      node.style.transform = `rotate(${state.angle}deg)`;
      if (spinning || state.speed > 0) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [spinning]);
  const metal = `tonearm-${useId().replace(/:/g, "")}`;
  // 唱盘（金属转盘）→ 唱片（随播放转动：刻纹、标签）→ 固定不动的光照层（左上受光、右下阴影、刻纹高光）与金属轴心 → 唱臂。
  return <div className="audio-turntable" aria-hidden="true">
    <div className="audio-platter" />
    <div className="audio-record">
      <div ref={disc} className="audio-record-disc">
        <div className={`audio-record-label${cover ? "" : " is-blank"}`}>{cover ? <img src={cover} alt="" /> : <Icon name="audio" size={18} className="audio-record-mark" />}</div>
      </div>
      <div className="audio-record-sheen" />
      <div className="audio-record-light" />
      <div className="audio-record-spindle" />
    </div>
    <svg className="audio-tonearm" viewBox="0 0 100 100">
      <defs>
        <linearGradient id={metal} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--on-dark)" }} /><stop offset=".55" style={{ stopColor: "var(--on-dark-72)" }} /><stop offset="1" style={{ stopColor: "var(--on-dark-40)" }} />
        </linearGradient>
      </defs>
      <rect className="audio-tonearm-weight" x="53.2" y="-5.5" width="5.2" height="6.4" rx="1.4" transform="rotate(-30 55.8 -2.3)" />
      <path className="audio-tonearm-arm" d="M57 4 L67 21 L69.5 28" style={{ stroke: `url(#${metal})` }} />
      <rect className="audio-tonearm-head" x="66.5" y="26" width="6" height="9" rx="1.2" transform="rotate(-20 69.5 30.5)" style={{ fill: `url(#${metal})` }} />
      <circle className="audio-tonearm-ring" cx="57" cy="4" r="6.2" />
      <circle className="audio-tonearm-base" cx="57" cy="4" r="4.6" style={{ fill: `url(#${metal})` }} />
      <circle className="audio-tonearm-pivot" cx="57" cy="4" r="1.8" />
    </svg>
  </div>;
}

/** 当前预览的文件已完整缓存在本机（由文件预览窗口提供）。浏览器只缓冲播放位置前面一段，
 *  完整缓存时「已加载」应显示为满，而不是只到浏览器的缓冲位置。 */
export const PreviewCachedContext = createContext(false);

/** 进度条：已播放、已缓冲两层，悬停显示目标时间；拖动时不被播放进度覆盖。 */
function Timeline({ progress, buffered, disabled, onSeek }: { progress: MediaProgress; buffered: number; disabled: boolean; onSeek: (time: number) => void }) {
  const [scrub, setScrub] = useState<number | null>(null), [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const cached = useContext(PreviewCachedContext);
  const duration = progress.duration;
  const time = scrub ?? progress.currentTime;
  const percent = duration ? time / duration * 100 : 0, loaded = cached && duration ? 100 : duration ? Math.min(100, buffered / duration * 100) : 0;
  return <div className="audio-timeline">
    <span className="audio-time">{playbackTime(time)}</span>
    <div className="audio-track" onPointerMove={event => {
      if (!duration) return;
      const rect = event.currentTarget.getBoundingClientRect(), x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      setHover({ x, time: x / rect.width * duration });
    }} onPointerLeave={() => setHover(null)} style={{ "--played": `${percent}%`, "--loaded": `${loaded}%` } as CSSProperties}>
      <input type="range" aria-label="播放进度" aria-valuetext={`${playbackTime(time)} / ${duration ? playbackTime(duration) : "--:--"}`}
        min={0} max={duration || 1} step={0.1} value={duration ? time : 0} disabled={disabled || !duration}
        onChange={event => setScrub(Number(event.target.value))}
        onPointerUp={event => { if (scrub !== null) onSeek(Number((event.target as HTMLInputElement).value)); setScrub(null); }}
        onKeyUp={event => { if (scrub !== null) { onSeek(scrub); setScrub(null); } else if (event.key === "Home" || event.key === "End") onSeek(Number(event.currentTarget.value)); }}
        data-media-progress="" />
      {hover && <span className="audio-track-tip" style={{ left: hover.x }} aria-hidden="true">{playbackTime(hover.time)}</span>}
    </div>
    <span className="audio-time">{duration ? playbackTime(duration) : "--:--"}</span>
  </div>;
}

function MediaButton({ icon, label, shortcut, onClick, disabled, active, className = "" }: { icon: IconName; label: string; shortcut?: string; onClick?: () => void; disabled?: boolean; active?: boolean; className?: string }) {
  return <button type="button" className={`audio-button${active ? " is-active" : ""} ${className}`} aria-label={label} title={shortcut ? `${label}（${shortcutLabel(shortcut)}）` : label} aria-keyshortcuts={shortcut ? shortcutAria(shortcut) : undefined} aria-pressed={active} disabled={disabled} onClick={onClick}><Icon name={icon} size={20} /></button>;
}

/* ---------- 统一入口 ---------- */

export function MediaPreview({ kind, url, name, size, videoSize, cover, onRetry, loadAssets, assetUrl, nav, onEnded, onPlaying, onProgress, onState, onControls, onVideoSize, onVideoFrame, onSaveThumbnail, onLyricLine, rotation: givenRotation = 0, onRotate, onBufferSpeed, onFindAssets, assetRevision = 0, preferAsset }: {
  kind: "video" | "audio"; url: string; name: string; size?: number; videoSize?: { width: number; height: number }; cover?: string; onRetry: () => void;
  loadAssets?: AssetLoader; assetUrl?: (path: string) => string; nav?: PreviewNav;
} & PlaybackProps) {
  const host = useRef<HTMLDivElement>(null), player = useRef<Player | null>(null);
  // 上层不记旋转（如分享页）时由播放器自己保存，只在本次预览中生效。
  const [localRotation, setLocalRotation] = useState(0);
  const rotation = onRotate ? givenRotation : localRotation;
  const loader = useRef(loadAssets), resolveAsset = useRef(assetUrl);
  loader.current = loadAssets; resolveAsset.current = assetUrl;
  const callbacks = useRef({ onEnded, onPlaying, onProgress, onState, onControls, onVideoSize, onVideoFrame, onSaveThumbnail, onLyricLine, onRotate }), source = useRef({ url, name, cover, videoSize, rotation }), loadedUrl = useRef("");
  callbacks.current = { onEnded, onPlaying, onProgress, onState, onControls, onVideoSize, onVideoFrame, onSaveThumbnail, onLyricLine, onRotate }; source.current = { url, name, cover, videoSize, rotation };
  const navRef = useRef(nav);
  navRef.current = nav;
  const [state, setState] = useState<MediaState>("loading"), [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [playerReady, setPlayerReady] = useState(false), [slow, setSlow] = useState(false);
  const [progress, setProgress] = useState<MediaProgress>({ currentTime: 0, duration: 0 }), [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState({ level: 1, muted: false });
  const [assets, setAssets] = useState<PreviewAsset[]>([]), [selected, setSelected] = useState("");
  const [findingAssets, setFindingAssets] = useState(Boolean(loadAssets)), [discoveryError, setDiscoveryError] = useState("");
  const [assetBusy, setAssetBusy] = useState(false), [assetError, setAssetError] = useState("");
  const [lyrics, setLyrics] = useState<Lyric[]>([]), [active, setActive] = useState(-1);
  // 没有时间轴的歌词按普通文字显示，不跟随播放滚动。
  const [unsynced, setUnsynced] = useState(false);
  const [tags, setTags] = useState<MediaTags | null>(null);
  const lyricRef = useRef(lyrics), lyricSource = useRef(""), timeRef = useRef(0), lyricHost = useRef<HTMLDivElement>(null);
  lyricRef.current = lyrics;
  const preferRef = useRef(preferAsset);
  preferRef.current = preferAsset;
  const findRef = useRef(onFindAssets);
  findRef.current = onFindAssets;
  useEffect(() => {
    let cancelled = false;
    const notify = (value: MediaState) => {
      if (cancelled) return;
      setState(value); callbacks.current.onState?.(value);
      if (value === "failed") { setPlaying(false); callbacks.current.onPlaying?.(false); }
    };
    const playingChanged = (value: boolean) => { if (!cancelled) setPlaying(value); callbacks.current.onPlaying?.(value); };
    notify("loading"); callbacks.current.onProgress?.({ currentTime: 0, duration: 0 });
    if (kind === "audio") {
      const audio = createAudioPlayer(source.current.url, {
        notify, onPlaying: playingChanged, onEnded: () => callbacks.current.onEnded?.(),
        onVolume: (level, muted) => { if (!cancelled) setVolume({ level, muted }); },
        onProgress: (value, loaded) => {
          if (cancelled) return;
          timeRef.current = value.currentTime;
          setProgress(current => current.currentTime === value.currentTime && current.duration === value.duration ? current : value);
          setBuffered(loaded); if (lyricRef.current[0]?.time !== -1) setActive(lyricAt(lyricRef.current, value.currentTime));
          callbacks.current.onProgress?.(value);
        },
      });
      player.current = audio;
      loadedUrl.current = source.current.url;
      setPlayerReady(true);
      callbacks.current.onControls?.(audio);
    } else {
      void loadMediaEngine().then(engine => {
        if (cancelled || !host.current) return;
        const events = { onEnded: () => callbacks.current.onEnded?.(), onPlaying: playingChanged,
          onProgress: (value: MediaProgress) => { if (!cancelled) callbacks.current.onProgress?.(value); },
          onVideoSize: (width: number, height: number, from: VideoSizeSource) => callbacks.current.onVideoSize?.(width, height, from),
          onVideoFrame: (video: HTMLVideoElement) => callbacks.current.onVideoFrame?.(video),
          onRotate: (degrees: number) => (callbacks.current.onRotate ?? setLocalRotation)(degrees) };
        const initial = source.current;
        const video = engine.createVideoPlayer(host.current, initial.url, notify, initial.cover, events, () => navRef.current, initial.videoSize, initial.rotation);
        player.current = video;
        loadedUrl.current = initial.url;
        setPlayerReady(true);
        callbacks.current.onControls?.(video);
      }).catch(reason => { if (!cancelled) { setError(errorMessage(reason, "播放器没有加载出来，请刷新页面后重试")); notify("failed"); } });
    }
    return () => { cancelled = true; callbacks.current.onControls?.(null); callbacks.current.onLyricLine?.(null); player.current?.destroy(); player.current = null; setPlayerReady(false); };
    // 切换同类文件只替换媒体源，最小化、恢复与播放模式变化都保留实例。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  useLayoutEffect(() => {
    if (!player.current || loadedUrl.current === url) return;
    setError(""); setSlow(false); timeRef.current = 0; setProgress({ currentTime: 0, duration: 0 }); setBuffered(0);
    lyricSource.current = ""; callbacks.current.onLyricLine?.(null); setActive(-1);
    loadedUrl.current = url;
    (player.current as VideoPlayer).setSource(url, name, cover, kind === "video" ? videoSize : undefined);
    callbacks.current.onControls?.(player.current);
    // 封面元信息变化不重置已在播放的媒体。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, playerReady]);
  // 视频把上一个／下一个、播放列表与播放模式放进 ArtPlayer 控制条；导航变化时刷新这些控件。
  const navKey = nav ? `${nav.index}/${nav.count}/${nav.mode}/${nav.playlistOpen}` : "";
  useEffect(() => {
    const instance = player.current;
    if (playerReady && instance && "refreshNavigation" in instance) (instance as VideoPlayer).refreshNavigation();
  }, [playerReady, navKey]);
  const canSaveThumbnail = Boolean(onSaveThumbnail);
  useEffect(() => {
    const instance = player.current as VideoPlayer | null;
    if (kind === "video" && playerReady && instance) instance.setThumbnailAction(canSaveThumbnail
      ? async (video, degrees) => { await callbacks.current.onSaveThumbnail?.(video, degrees); } : null);
  }, [kind, playerReady, canSaveThumbnail]);
  useEffect(() => {
    const instance = player.current as VideoPlayer | null;
    if (kind === "video" && playerReady && instance) instance.setRotation(rotation);
  }, [kind, playerReady, rotation]);
  useEffect(() => {
    if (state !== "loading" && state !== "buffering") { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [state, url]);
  const revisionUrl = useRef(url);
  useEffect(() => {
    // 只有附件变化（同一文件、版本号递增）时保留正在显示的歌词，避免重新读取时闪一下。
    const sameFile = revisionUrl.current === url;
    revisionUrl.current = url;
    if (!sameFile) { setAssets([]); setSelected(""); setLyrics([]); lyricRef.current = []; lyricSource.current = ""; setActive(-1); setTags(null); }
    setDiscoveryError("");
    setFindingAssets(Boolean(loader.current));
    if (!loader.current) return;
    const controller = new AbortController();
    void loader.current(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const { assets: items, tags: found } = Array.isArray(result) ? { assets: result, tags: null } : result;
      setTags(found ?? null);
      const matches = items.filter(item => item.kind === (kind === "audio" ? "lyrics" : "subtitle"));
      setAssets(matches);
      setSelected(pickAsset(kind, matches, preferRef.current)?.path ?? "");
    }).catch(reason => { if (!controller.signal.aborted) setDiscoveryError(errorMessage(reason, "无法查找歌词或字幕")); })
      .finally(() => { if (!controller.signal.aborted) setFindingAssets(false); });
    return () => controller.abort();
  }, [kind, url, assetRevision]);
  useEffect(() => {
    if (!playerReady) return;
    const controller = new AbortController();
    setAssetError(""); setAssetBusy(false); lyricRef.current = []; lyricSource.current = ""; setLyrics([]); setActive(-1); setUnsynced(false);
    const instance = player.current as VideoPlayer | null;
    const subtitles = kind === "video" && instance && "setSubtitle" in instance ? instance : null;
    if (!selected) { if (subtitles) void subtitles.setSubtitle(null); return; }
    const asset = assets.find(item => item.path === selected);
    if (!asset || (!asset.read && !resolveAsset.current)) return;
    setAssetBusy(true);
    if (subtitles) void subtitles.setSubtitle(null);
    // 内置字幕轨可能要先在服务器提取（MKV 要读完整个文件），进度显示在播放器的提示里。
    let shown = -1;
    const progress = (fraction: number | null) => {
      const percent = fraction == null ? null : Math.floor(fraction * 20) * 5;
      if (!subtitles || percent === shown) return;
      shown = percent ?? -2;
      subtitles.notice(percent == null ? "正在提取内置字幕…" : `正在提取内置字幕 ${percent}%`);
    };
    const read = asset.read ? asset.read(controller.signal, progress).then(text => ({ text, truncated: false }))
      : readPreviewText(resolveAsset.current!(asset.path), 2 * 1024 * 1024, controller.signal);
    void read.then(async value => {
      if (controller.signal.aborted) return;
      if (value.truncated) throw new Error("歌词或字幕超过 2 MB，无法完整预览");
      if (kind === "audio") {
        const parsed = parseLyrics(value.text);
        // 没有时间标签的歌词（如内嵌的普通歌词）逐行显示，不跟随播放。
        const lines = parsed.length ? parsed : value.text.split(/\r?\n/).map(line => line.replace(/^\[[a-z]+:[^\]]*\]$/i, "").trim()).filter(Boolean).map(text => ({ time: -1, text }));
        if (!lines.length) throw new Error("歌词是空的");
        lyricRef.current = lines; lyricSource.current = url; setLyrics(lines); setUnsynced(!parsed.length);
        setActive(parsed.length ? lyricAt(parsed, timeRef.current) : -1);
      } else if (subtitles) {
        await subtitles.setSubtitle(value.text, /\.srt$/i.test(asset.name) ? "srt" : "vtt");
        if (asset.read) subtitles.notice(`已加载${asset.name}`);
      }
    }).catch(reason => { if (!controller.signal.aborted) setAssetError(errorMessage(reason, "歌词或字幕没有加载出来")); })
      .finally(() => { if (!controller.signal.aborted) setAssetBusy(false); });
    return () => { controller.abort(); if (subtitles) void subtitles.setSubtitle(null); };
  }, [selected, assets, playerReady, kind, url]);
  // 当前行居中；还没唱到第一句（active 为 -1）时回到顶部。换了一份歌词（切歌）时立即定位、不做滚动动画，
  // 否则会停在上一首的位置：切歌瞬间旧音频的进度可能先算出一个靠后的行，新歌从头播放时 active 变成 -1 不会再滚回来。
  const shownLyrics = useRef<Lyric[]>([]);
  useLayoutEffect(() => {
    const node = lyricHost.current;
    if (!node) return;
    const changed = shownLyrics.current !== lyrics;
    shownLyrics.current = lyrics;
    const row = active >= 0 ? node.querySelector<HTMLElement>(`[data-line="${active}"]`) : null;
    node.scrollTo({ top: row ? row.offsetTop - node.clientHeight / 2 + row.clientHeight / 2 : 0,
      behavior: changed || reducedMotion() ? "instant" : "smooth" });
  }, [active, lyrics]);
  useEffect(() => {
    const node = lyricHost.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const row = node.querySelector<HTMLElement>("[aria-current='true']");
      if (row) node.scrollTo({ top: row.offsetTop - node.clientHeight / 2 + row.clientHeight / 2, behavior: "instant" });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [lyrics.length]);
  const waiting = state === "loading" || state === "buffering";
  const failed = state === "failed";
  const mediaElement = useCallback(() => {
    const instance = player.current;
    return instance ? "element" in instance ? (instance as AudioPlayer).element : (instance as VideoPlayer).media() : null;
  }, []);
  const speed = useBufferSpeed(mediaElement, waiting && !failed && playerReady, size, url);
  const speedCallback = useRef(onBufferSpeed);
  speedCallback.current = onBufferSpeed;
  useEffect(() => { speedCallback.current?.(speed); }, [speed]);
  useEffect(() => () => speedCallback.current?.(null), []);
  // 同时间戳的双语歌词只取第一行；空白间奏保留行高，不让小窗口随每句歌词跳动。
  const currentLine = kind === "audio" && !failed && selected && !assetBusy && !findingAssets && lyricSource.current === url && lyrics.length && !unsynced
    ? lyrics[active]?.text.split(/\r?\n/).find(line => line.trim())?.trim() ?? "" : null;
  useEffect(() => { callbacks.current.onLyricLine?.(currentLine); }, [currentLine, url]);
  const options = assets.map(asset => ({ value: asset.path, label: assetLabel(asset) + (assets.filter(item => assetLabel(item) === assetLabel(asset)).length > 1 ? ` · ${asset.name}` : "") }));
  const optionKey = options.map(option => `${option.value}=${option.label}`).join("|");
  // 视频字幕放进播放器自己的设置菜单；没有找到字幕时不出现这一项，也不再单独占一行提示。
  const canFind = Boolean(onFindAssets);
  useEffect(() => {
    const instance = player.current as VideoPlayer | null;
    if (!playerReady || kind !== "video" || !instance) return;
    instance.setSubtitleMenu(options, selected, setSelected, canFind ? { label: "在线查找字幕…", run: () => findRef.current?.("subtitle") } : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerReady, optionKey, selected, canFind]);
  useEffect(() => {
    const instance = player.current as VideoPlayer | null, message = assetError || discoveryError;
    if (message && kind === "video" && instance) instance.notice(message);
  }, [assetError, discoveryError]);
  const failure = failed && <div className="preview-player-failure" role="alert">
    <span className="preview-failure-icon"><Icon name="alert" size={18} /></span>
    <strong>{kind === "video" ? "无法播放这个视频" : "无法播放这段音频"}</strong>
    <span>{error || "浏览器无法读取文件或解码这种格式。可以重试，或下载后用本地播放器打开。"}</span>
    <Button size="sm" variant="secondary" icon="refresh" onClick={onRetry}>重试</Button>
  </div>;
  // 视频的提示在加载动画下方：缓冲时显示估算速度，超过 8 秒再加「加载较慢 · 重试」；音乐的速度显示在状态胶囊里。
  const videoSpeed = kind === "video" && waiting && speed != null;
  const slowNotice = !failed && (slow || videoSpeed) && <div className="preview-player-slow" role="status">
    {videoSpeed && <span className="preview-player-speed" title="按缓冲进度与文件平均码率估算的下载速度">{formatSpeed(speed)}</span>}
    {slow && <><span>加载较慢</span><button type="button" onClick={onRetry}>重试</button></>}
  </div>;

  if (kind === "video") {
    return <div className={`preview-player preview-player-video${waiting && !failed ? " is-waiting" : ""}${playing && !waiting && !failed ? " is-playing" : ""}`}>
      <div className="preview-player-surface">
        <div ref={host} className="preview-player-host preview-video-host" />
        {failure || slowNotice}
      </div>
    </div>;
  }

  const audio = player.current as AudioPlayer | null;
  // 「歌名 - 歌手」或「歌名-歌手」：拆成标题和副标题；格式、大小已在窗口头部显示，这里不再重复。
  // 文件带标签时用标签里的歌名、歌手与专辑。
  const base = name.replace(/\.[^.]+$/, "");
  const parts = /^(.+?)\s*[-–—]\s*([^-–—]+)$/.exec(base);
  const title = tags?.title || (parts ? parts[1].trim() : base);
  const artist = tags?.title ? [tags.artist, tags.album].filter(Boolean).join(" · ") : parts ? parts[2].trim() : "";
  const toggle = () => { if (!audio) return; if (audio.isPlaying()) audio.pause(); else void audio.play().catch(() => undefined); };
  const modeIndex = PLAYBACK_MODES.findIndex(item => item.value === nav?.mode);
  const nextMode = PLAYBACK_MODES[(modeIndex + 1) % PLAYBACK_MODES.length];
  const volumeIcon: IconName = volume.muted || volume.level === 0 ? "volumeMute" : volume.level < .5 ? "volumeLow" : "volume";
  const lyricsLoading = (findingAssets || assetBusy) && !failed;
  const status = failed ? { tone: "failed", text: "播放失败" } : waiting ? { tone: "waiting", text: (state === "buffering" ? "正在缓冲" : "正在加载") + (speed != null ? ` · ${formatSpeed(speed)}` : "") }
    : playing ? { tone: "playing", text: "正在播放" } : { tone: "paused", text: "已暂停" };
  const lyricLabel = selected ? options.find(option => option.value === selected)?.label ?? "歌词" : "";
  const lyricHint = lyricsLoading ? ""
    : assetError || discoveryError ? assetError || discoveryError
    : assets.length && !selected ? "歌词已关闭"
    : loadAssets && !assets.length ? onFindAssets ? "没有歌词" : "没有找到同名歌词（.lrc）"
    : "";
  // 没有歌词时右侧显示音频信息：格式（无损格式标注）、时长、大小与按大小估算的平均码率（含封面等元数据，所以写「约」）。
  const extension = /\.([a-z\d]{2,5})$/i.exec(name)?.[1].toUpperCase() ?? "";
  const facts = [
    extension && `${extension}${/^(FLAC|WAV|APE|AIFF?|ALAC|WV|DSF|DFF)$/.test(extension) ? " 无损" : ""}`,
    progress.duration > 0 && playbackTime(progress.duration),
    size ? formatBytes(size) : "",
    size && progress.duration > 0 ? `约 ${Math.round(size * 8 / progress.duration / 1000)} kbps` : "",
  ].filter((fact): fact is string => Boolean(fact));
  const showLyrics = lyrics.length > 0 && lyricSource.current === url;
  return <div className={`preview-player preview-player-audio${cover ? " has-cover" : ""}${waiting && !failed ? " is-waiting" : ""}${playing && !waiting && !failed ? " is-playing" : ""}${playing ? " is-active" : ""}`}
    style={{ "--preview-tint": coverTint(name), ...(cover ? { "--preview-cover": `url("${cover}")` } : {}) } as CSSProperties}>
    <div className="audio-backdrop" aria-hidden="true" />
    <div className={`audio-body${showLyrics ? " has-lyrics" : ""}`}>
      <div className="audio-art"><Turntable cover={cover} spinning={playing && !waiting && !failed} /></div>
      <div className="audio-side">
        <div className="audio-heading">
          <h3 title={name}>{title}</h3>
          {artist && <p className="audio-artist">{artist}</p>}
          <p role="status" className={`audio-status is-${status.tone}`}>
            {status.tone === "playing" ? <span className="preview-equalizer" aria-hidden="true"><i /><i /><i /><i /></span>
              : status.tone === "waiting" ? <span className="audio-status-spinner" aria-hidden="true" />
              : status.tone === "failed" ? <Icon name="alert" size={13} /> : <Icon name="pause" size={12} />}
            <span>{status.text}</span>
          </p>
        </div>
        {failure || (showLyrics
          ? unsynced ? <div className="audio-lyrics is-unsynced" ref={lyricHost} aria-label="歌词（没有时间轴）">
            {lyrics.map((line, index) => <p key={index} className="audio-lyric">{line.text}</p>)}
          </div>
          : <div className="audio-lyrics" ref={lyricHost} aria-label="同步歌词，点击跳转">
            {lyrics.map((line, index) => <button type="button" key={index} data-line={index} className={`audio-lyric${active === index ? " is-active" : ""}${index < active ? " is-past" : ""}`}
              aria-current={active === index ? "true" : undefined} onClick={() => audio?.seek(line.time)}>{line.text || <Icon name="audio" size={14} className="audio-lyric-rest" />}</button>)}
          </div>
          : lyricsLoading
            ? <div className="audio-lyrics-skeleton" role="status" aria-label="正在加载歌词"><i /><i /><i /><i /><i /></div>
            : <div className="audio-info">
              {facts.length > 0 && <ul className="audio-facts" aria-label="音频信息">{facts.map(fact => <li key={fact}>{fact}</li>)}</ul>}
              {lyricHint && <p className="audio-hint">{lyricHint}</p>}
              {onFindAssets && !lyricsLoading && !failed && (!assets.length || !cover) && <div className="audio-find">
                {!assets.length && <Button size="sm" variant="secondary" icon="search" onClick={() => onFindAssets("lyrics")}>在线查找歌词</Button>}
                {!cover && <Button size="sm" variant="ghost" icon="image" onClick={() => onFindAssets("cover")}>查找封面</Button>}
              </div>}
            </div>)}
      </div>
    </div>
    <div className="audio-controls">
      <Timeline progress={progress} buffered={buffered} disabled={failed} onSeek={time => audio?.seek(time)} />
      <div className="audio-buttons">
        <div className="audio-buttons-start">
          {nav?.onMode && nav.mode && <MediaButton icon={MODE_ICONS[nav.mode]} label={`${PLAYBACK_MODES[modeIndex]?.label ?? "播放模式"}（点击切换为${nextMode.label}）`} active={nav.mode !== "sequence"} onClick={() => nav.onMode?.(nextMode.value)} />}
        </div>
        <div className="audio-buttons-main">
          <MediaButton icon="previous" label="上一首" shortcut="ArrowLeft" disabled={!nav || nav.count < 2} onClick={nav?.onPrevious} />
          <button type="button" className="audio-play" aria-label={playing ? "暂停" : "播放"} aria-keyshortcuts="Space K" title={playing ? "暂停（空格 / K）" : "播放（空格 / K）"} disabled={failed} onClick={toggle}>
            <Icon name={playing ? "pause" : "play"} size={24} />
          </button>
          <MediaButton icon="next" label="下一首" shortcut="ArrowRight" disabled={!nav || nav.count < 2} onClick={nav?.onNext} />
        </div>
        <div className="audio-buttons-end">
          {assets.length > 0 && !failed && <Menu label={selected ? `歌词：${lyricLabel}（点击切换）` : "歌词已关闭（点击选择）"} align="end" above
            className={`audio-button audio-lyrics-button${selected ? " is-active" : ""}`}
            items={[{ label: "关闭歌词", icon: "x", checked: !selected, heading: "歌词", onSelect: () => setSelected("") },
              ...options.map(option => ({ label: option.label, icon: "fileText" as const, checked: selected === option.value, onSelect: () => setSelected(option.value) })),
              ...(onFindAssets ? [{ label: "在线查找歌词…", icon: "search" as const, divider: true, onSelect: () => onFindAssets("lyrics") }] : [])]}>
            <Icon name="fileText" size={20} />
          </Menu>}
          <div className="audio-volume">
            <MediaButton icon={volumeIcon} label={volume.muted ? "取消静音" : "静音"} onClick={() => audio?.toggleMute()} />
            <input type="range" min={0} max={1} step={0.01} aria-label="音量" value={volume.muted ? 0 : volume.level}
              style={{ "--volume": `${(volume.muted ? 0 : volume.level) * 100}%` } as CSSProperties}
              onChange={event => audio?.setVolume(Number(event.target.value))}
              onKeyDown={event => { if (event.key.startsWith("Arrow")) event.stopPropagation(); }} />
          </div>
          {nav?.onPlaylist && nav.count > 1 && <MediaButton icon="list" className="playlist-toggle" label={`播放列表（${nav.index + 1} / ${nav.count}）`} shortcut="O" active={nav.playlistOpen} onClick={nav.onPlaylist} />}
        </div>
      </div>
    </div>
    {slowNotice}
  </div>;
}
