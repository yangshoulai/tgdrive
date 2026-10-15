/** 播放界面与歌词、字幕附件；缓冲状态始终保留播放器。
 * 视频使用 ArtPlayer（按需加载）；音乐使用原生 <audio> 与自绘界面：模糊封面背景、唱片、频谱、同步歌词和一体化控制条。 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { errorMessage, type PreviewAsset } from "./api";
import { readPreviewText } from "./preview-data";
import { loadMediaEngine } from "./preview-runtime";
import { MODE_ICONS, PLAYBACK_MODES, type PreviewNav } from "./preview-playlist";
import { Button, Icon, type IconName } from "./ui";
import type { MediaProgress, MediaState } from "./preview-media-engine";
export type { MediaProgress, MediaState } from "./preview-media-engine";

type Engine = Awaited<ReturnType<typeof loadMediaEngine>>;
type VideoPlayer = ReturnType<Engine["createVideoPlayer"]>;
type Lyric = { time: number; text: string };
export type AssetLoader = (signal: AbortSignal) => Promise<PreviewAsset[]>;
export type PlaybackControls = { play: () => Promise<void>; pause: () => void; isPlaying: () => boolean; seek: (time: number) => void; seekBy: (seconds: number) => void; adjustVolume: (delta: number) => void };
export type PlaybackProps = { onEnded?: () => void; onPlaying?: (playing: boolean) => void; onProgress?: (progress: MediaProgress) => void; onState?: (state: MediaState) => void; onControls?: (controls: PlaybackControls | null) => void; onVideoSize?: (width: number, height: number) => void; onLyricLine?: (line: string | null) => void };
type Player = PlaybackControls & { setSource: (url: string, name: string, cover?: string) => void; destroy: () => void };

function playbackTime(time: number): string {
  const seconds = Math.floor(time), hours = Math.floor(seconds / 3600);
  return [...(hours ? [String(hours)] : []), String(Math.floor(seconds / 60) % 60).padStart(2, "0"), String(seconds % 60).padStart(2, "0")].join(":");
}
/** 最小化后的迷你播放器：一行歌词／状态、切歌与播放、模式和时间，底边是可拖动的细进度条。 */
export function MinimizedPlayback({ progress, state, playing, lyric, onSeek, onToggle, nav }: {
  progress: MediaProgress; state: MediaState; playing: boolean; lyric?: string | null; onSeek: (time: number) => void; onToggle: () => void; nav?: PreviewNav;
}) {
  const time = playbackTime(progress.currentTime), duration = progress.duration ? playbackTime(progress.duration) : "--:--";
  const percent = progress.duration ? progress.currentTime / progress.duration * 100 : 0;
  const failed = state === "failed", waiting = state === "loading" || state === "buffering";
  const status = failed ? "播放失败" : state === "loading" ? "正在加载" : state === "buffering" ? "正在缓冲" : playing ? "正在播放" : "已暂停";
  const modeIndex = Math.max(0, PLAYBACK_MODES.findIndex(mode => mode.value === nav?.mode));
  const nextMode = PLAYBACK_MODES[(modeIndex + 1) % PLAYBACK_MODES.length];
  return <div className={`preview-mini-player${playing && state === "ready" ? " is-playing" : ""}${waiting ? " is-waiting" : ""}${failed ? " is-failed" : ""}`}>
    <div className="preview-mini-line">
      <span className="preview-equalizer" aria-hidden="true"><i /><i /><i /><i /></span>
      {lyric ? <span key={lyric} className="preview-mini-lyric" title={lyric} aria-label={`当前歌词：${lyric}`}>{lyric}</span> : <span className="preview-mini-status" role="status">{status}</span>}
    </div>
    <div className="preview-mini-controls">
      {nav?.onMode && nav.mode
        ? <MediaButton icon={MODE_ICONS[nav.mode]} label={`${PLAYBACK_MODES[modeIndex]?.label ?? "播放模式"}（点击切换为${nextMode.label}）`} active={nav.mode !== "sequence"} onClick={() => nav.onMode?.(nextMode.value)} />
        : <span />}
      <div className="preview-mini-transport">
        <MediaButton icon="previous" label="上一个" disabled={!nav || nav.count < 2} onClick={nav?.onPrevious} />
        <button type="button" className="preview-mini-play" aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停（K）" : "播放（K）"} disabled={failed} onClick={onToggle}>
          <Icon name={playing ? "pause" : "play"} size={18} />
        </button>
        <MediaButton icon="next" label="下一个" disabled={!nav || nav.count < 2} onClick={nav?.onNext} />
      </div>
      <span className="preview-mini-time">{time}<span> / {duration}</span></span>
    </div>
    <input className="preview-mini-progress" type="range" aria-label="播放进度" aria-valuetext={`已播放 ${time}，共 ${duration}`} min={0} max={progress.duration || 1} step={0.1}
      value={progress.duration ? progress.currentTime : 0} disabled={!progress.duration || failed} onChange={event => onSeek(Number(event.target.value))}
      onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); onSeek(Math.max(0, Math.min(progress.duration, progress.currentTime + (event.key === "ArrowLeft" ? -5 : 5)))); } }}
      style={{ "--playback-progress": `${percent}%` } as CSSProperties} />
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
  const languages: Record<string, string> = { zh: "中文", "zh-cn": "简体中文", "zh-hans": "简体中文", "zh-tw": "繁体中文", "zh-hant": "繁体中文", en: "英语", eng: "英语", ja: "日语", jpn: "日语", ko: "韩语", kor: "韩语", fr: "法语", fra: "法语", de: "德语", deu: "德语", es: "西班牙语", spa: "西班牙语", it: "意大利语", pt: "葡萄牙语", ru: "俄语" };
  // 没有语言标记的附件按格式命名（如“SRT 字幕”“LRC 歌词”），比“默认”更清楚。
  const format = asset.name.split(".").at(-1)?.toUpperCase() ?? "";
  return (asset.language && languages[asset.language.toLowerCase()]) || asset.language || `${format} ${asset.kind === "lyrics" ? "歌词" : "字幕"}`.trim();
}

/* ---------- 音乐：原生 <audio> ---------- */

const VOLUME_KEY = "tessera-volume";
type AudioEvents = { notify: (state: MediaState) => void; onPlaying: (playing: boolean) => void; onProgress: (progress: MediaProgress, buffered: number) => void; onEnded: () => void; onVolume: (volume: number, muted: boolean) => void };
type AudioPlayer = Player & { element: HTMLAudioElement; analyser: () => AnalyserNode | null; setVolume: (volume: number) => void; toggleMute: () => void };

/** iOS 把经 Web Audio 输出的媒体在锁屏后挂起，所以触屏的苹果设备不接频谱，只用装饰动画。 */
const spectrumAllowed = () => !/iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));

function createAudioPlayer(url: string, events: AudioEvents): AudioPlayer {
  const audio = new Audio();
  audio.preload = "metadata";
  try { const saved = Number(localStorage.getItem(VOLUME_KEY)); if (saved >= 0 && saved <= 1 && localStorage.getItem(VOLUME_KEY) !== null) audio.volume = saved; } catch { /* 无法读取偏好时使用默认音量 */ }
  let ready = false, destroyed = false;
  let context: AudioContext | null = null, analyser: AnalyserNode | null = null;
  const progress = (): MediaProgress => {
    const duration = Number.isFinite(audio.duration) ? Math.max(0, audio.duration) : 0;
    const currentTime = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
    return { currentTime: duration ? Math.min(currentTime, duration) : currentTime, duration };
  };
  const buffered = () => { const ranges = audio.buffered; return ranges.length ? ranges.end(ranges.length - 1) : 0; };
  const update = () => { if (!destroyed) events.onProgress(progress(), buffered()); };
  const markReady = () => { ready = true; events.notify("ready"); };
  /** 频谱只能在用户手势中创建：浏览器不允许在非手势下启动 AudioContext，挂起的上下文会让音乐静音。 */
  const ensureAnalyser = () => {
    if (analyser || context || !spectrumAllowed() || !(navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive) return;
    try {
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;
      context = new Context();
      const source = context.createMediaElementSource(audio);
      analyser = context.createAnalyser();
      analyser.fftSize = 256; analyser.smoothingTimeConstant = .78;
      source.connect(analyser); analyser.connect(context.destination);
    } catch { analyser = null; }
  };
  const listeners: [string, () => void][] = [
    ["loadedmetadata", () => { markReady(); update(); }], ["canplay", markReady], ["playing", markReady],
    ["waiting", () => events.notify(ready ? "buffering" : "loading")],
    ["play", () => { void context?.resume().catch(() => undefined); events.onPlaying(true); }],
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
    analyser: () => analyser,
    play: () => { ensureAnalyser(); void context?.resume().catch(() => undefined); return audio.play(); },
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
      void context?.close().catch(() => undefined);
    },
  };
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 频谱：有 Web Audio 时画真实频率，否则播放时用平滑的伪随机律动；暂停后柱子缓缓落下。 */
function Spectrum({ analyser, playing, bars = 48 }: { analyser: () => AnalyserNode | null; playing: boolean; bars?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = canvas.current, context = node?.getContext("2d");
    if (!node || !context) return;
    const levels = new Float32Array(bars), phases = Float32Array.from({ length: bars }, (_, index) => index * 1.7 % 6.28);
    let frame = 0, data: Uint8Array<ArrayBuffer> | null = null, start = performance.now();
    const still = reducedMotion();
    const draw = (now: number) => {
      const ratio = window.devicePixelRatio || 1, width = node.clientWidth, height = node.clientHeight;
      if (node.width !== Math.round(width * ratio) || node.height !== Math.round(height * ratio)) { node.width = Math.round(width * ratio); node.height = Math.round(height * ratio); }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const source = playing && !still ? analyser() : null;
      if (source) { data ??= new Uint8Array(new ArrayBuffer(source.frequencyBinCount)); source.getByteFrequencyData(data); }
      let moving = false;
      const gap = Math.max(2, width / bars * .35), barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);
      for (let index = 0; index < bars; index++) {
        let target = .06;
        if (playing && !still) {
          if (source && data) {
            // 左右对称：低频在中间、向两侧过渡到高频；高频能量弱，按距离适当提升，避免一侧总是平的。
            const distance = Math.abs(index - (bars - 1) / 2) / ((bars - 1) / 2);
            const bin = Math.min(data.length - 1, Math.floor(1 + Math.pow(distance, 1.5) * data.length * .5));
            target = Math.max(.06, Math.min(1, Math.pow(data[bin] / 255, 1.2) * (1 + distance * .9)));
          } else {
            const t = (now - start) / 1000;
            target = .18 + .5 * Math.pow((Math.sin(t * (1.6 + index % 5 * .37) + phases[index]) + 1) / 2, 2) * Math.sin(Math.PI * (index + .5) / bars);
          }
        } else if (still && playing) target = .3 * Math.sin(Math.PI * (index + .5) / bars) + .06;
        levels[index] += (target - levels[index]) * (target > levels[index] ? .35 : .12);
        if (Math.abs(target - levels[index]) > .002) moving = true;
        const barHeight = Math.max(3, levels[index] * height);
        const x = index * (barWidth + gap), y = (height - barHeight) / 2;
        context.fillStyle = `rgba(255, 255, 255, ${.28 + levels[index] * .62})`;
        context.beginPath();
        context.roundRect(x, y, barWidth, barHeight, barWidth / 2);
        context.fill();
      }
      if ((playing && !still) || moving) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [analyser, playing, bars]);
  return <canvas ref={canvas} className="audio-spectrum" aria-hidden="true" />;
}

/** 进度条：已播放、已缓冲两层，悬停显示目标时间；拖动时不被播放进度覆盖。 */
function Timeline({ progress, buffered, disabled, onSeek }: { progress: MediaProgress; buffered: number; disabled: boolean; onSeek: (time: number) => void }) {
  const [scrub, setScrub] = useState<number | null>(null), [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const duration = progress.duration;
  const time = scrub ?? progress.currentTime;
  const percent = duration ? time / duration * 100 : 0, loaded = duration ? Math.min(100, buffered / duration * 100) : 0;
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
        onKeyDown={event => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault(); event.stopPropagation();
          onSeek(Math.max(0, Math.min(duration, progress.currentTime + (event.key === "ArrowLeft" ? -5 : 5))));
        }} />
      {hover && <span className="audio-track-tip" style={{ left: hover.x }} aria-hidden="true">{playbackTime(hover.time)}</span>}
    </div>
    <span className="audio-time">{duration ? playbackTime(duration) : "--:--"}</span>
  </div>;
}

function MediaButton({ icon, label, onClick, disabled, active, className = "" }: { icon: IconName; label: string; onClick?: () => void; disabled?: boolean; active?: boolean; className?: string }) {
  return <button type="button" className={`audio-button${active ? " is-active" : ""} ${className}`} aria-label={label} title={label} aria-pressed={active} disabled={disabled} onClick={onClick}><Icon name={icon} size={20} /></button>;
}

/* ---------- 统一入口 ---------- */

export function MediaPreview({ kind, url, name, cover, onRetry, loadAssets, assetUrl, nav, onEnded, onPlaying, onProgress, onState, onControls, onVideoSize, onLyricLine }: {
  kind: "video" | "audio"; url: string; name: string; cover?: string; onRetry: () => void;
  loadAssets?: AssetLoader; assetUrl?: (path: string) => string; nav?: PreviewNav;
} & PlaybackProps) {
  const host = useRef<HTMLDivElement>(null), player = useRef<Player | null>(null);
  const loader = useRef(loadAssets), resolveAsset = useRef(assetUrl);
  loader.current = loadAssets; resolveAsset.current = assetUrl;
  const callbacks = useRef({ onEnded, onPlaying, onProgress, onState, onControls, onVideoSize, onLyricLine }), source = useRef({ url, name, cover }), loadedUrl = useRef("");
  callbacks.current = { onEnded, onPlaying, onProgress, onState, onControls, onVideoSize, onLyricLine }; source.current = { url, name, cover };
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
  const lyricRef = useRef(lyrics), lyricSource = useRef(""), timeRef = useRef(0), lyricHost = useRef<HTMLDivElement>(null);
  lyricRef.current = lyrics;
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
          setBuffered(loaded); setActive(lyricAt(lyricRef.current, value.currentTime));
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
          onVideoSize: (width: number, height: number) => callbacks.current.onVideoSize?.(width, height) };
        const initial = source.current;
        const video = engine.createVideoPlayer(host.current, initial.url, notify, initial.cover, events, () => navRef.current);
        player.current = video;
        loadedUrl.current = initial.url;
        setPlayerReady(true);
        callbacks.current.onControls?.(video);
      }).catch(reason => { if (!cancelled) { setError(errorMessage(reason, "播放组件加载失败")); notify("failed"); } });
    }
    return () => { cancelled = true; callbacks.current.onControls?.(null); callbacks.current.onLyricLine?.(null); player.current?.destroy(); player.current = null; setPlayerReady(false); };
    // 切换同类文件只替换媒体源，最小化、恢复与播放模式变化都保留实例。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  useLayoutEffect(() => {
    if (!player.current || loadedUrl.current === url) return;
    setError(""); setSlow(false); timeRef.current = 0; setProgress({ currentTime: 0, duration: 0 }); setBuffered(0);
    lyricSource.current = ""; callbacks.current.onLyricLine?.(null);
    loadedUrl.current = url;
    player.current.setSource(url, name, cover);
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
  useEffect(() => {
    if (state !== "loading" && state !== "buffering") { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [state, url]);
  useEffect(() => {
    setAssets([]); setSelected(""); setLyrics([]); lyricRef.current = []; lyricSource.current = ""; setActive(-1); setDiscoveryError("");
    setFindingAssets(Boolean(loader.current));
    if (!loader.current) return;
    const controller = new AbortController();
    void loader.current(controller.signal).then(items => {
      if (controller.signal.aborted) return;
      const matches = items.filter(item => item.kind === (kind === "audio" ? "lyrics" : "subtitle"));
      setAssets(matches);
      const preferred = kind === "audio" ? matches.find(item => !item.language) : matches.find(item => item.language?.toLowerCase().startsWith("zh"));
      setSelected((preferred ?? matches.find(item => !item.language) ?? matches[0])?.path ?? "");
    }).catch(reason => { if (!controller.signal.aborted) setDiscoveryError(errorMessage(reason, "无法查找歌词或字幕")); })
      .finally(() => { if (!controller.signal.aborted) setFindingAssets(false); });
    return () => controller.abort();
  }, [kind, url]);
  useEffect(() => {
    if (!playerReady) return;
    const controller = new AbortController();
    setAssetError(""); setAssetBusy(false); lyricRef.current = []; lyricSource.current = ""; setLyrics([]); setActive(-1);
    const instance = player.current as VideoPlayer | null;
    const subtitles = kind === "video" && instance && "setSubtitle" in instance ? instance : null;
    if (!selected) { if (subtitles) void subtitles.setSubtitle(null); return; }
    const asset = assets.find(item => item.path === selected);
    if (!asset || !resolveAsset.current) return;
    setAssetBusy(true);
    if (subtitles) void subtitles.setSubtitle(null);
    void readPreviewText(resolveAsset.current(asset.path), 2 * 1024 * 1024, controller.signal).then(async value => {
      if (controller.signal.aborted) return;
      if (value.truncated) throw new Error("歌词或字幕超过 2 MB，无法完整预览");
      if (kind === "audio") {
        const parsed = parseLyrics(value.text);
        if (!parsed.length) throw new Error("歌词没有有效的时间标签");
        lyricRef.current = parsed; lyricSource.current = url; setLyrics(parsed); setActive(lyricAt(parsed, timeRef.current));
      } else if (subtitles) {
        await subtitles.setSubtitle(value.text, /\.srt$/i.test(asset.name) ? "srt" : "vtt");
      }
    }).catch(reason => { if (!controller.signal.aborted) setAssetError(errorMessage(reason, "歌词或字幕加载失败")); })
      .finally(() => { if (!controller.signal.aborted) setAssetBusy(false); });
    return () => { controller.abort(); if (subtitles) void subtitles.setSubtitle(null); };
  }, [selected, assets, playerReady, kind, url]);
  useEffect(() => {
    const row = lyricHost.current?.querySelector<HTMLElement>(`[data-line="${active}"]`);
    if (row && lyricHost.current) lyricHost.current.scrollTo({ top: row.offsetTop - lyricHost.current.clientHeight / 2 + row.clientHeight / 2,
      behavior: reducedMotion() ? "instant" : "smooth" });
  }, [active]);
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
  // 同时间戳的双语歌词只取第一行；空白间奏保留行高，不让小窗口随每句歌词跳动。
  const currentLine = kind === "audio" && !failed && selected && !assetBusy && !findingAssets && lyricSource.current === url && lyrics.length
    ? lyrics[active]?.text.split(/\r?\n/).find(line => line.trim())?.trim() ?? "" : null;
  useEffect(() => { callbacks.current.onLyricLine?.(currentLine); }, [currentLine, url]);
  const options = assets.map(asset => ({ value: asset.path, label: assetLabel(asset) + (assets.filter(item => assetLabel(item) === assetLabel(asset)).length > 1 ? ` · ${asset.name}` : "") }));
  const optionKey = options.map(option => `${option.value}=${option.label}`).join("|");
  // 视频字幕放进播放器自己的设置菜单；没有找到字幕时不出现这一项，也不再单独占一行提示。
  useEffect(() => {
    const instance = player.current as VideoPlayer | null;
    if (!playerReady || kind !== "video" || !instance) return;
    instance.setSubtitleMenu(options, selected, setSelected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerReady, optionKey, selected]);
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
  const slowNotice = !failed && slow && <div className="preview-player-slow" role="status">
    <span>加载较慢</span><button type="button" onClick={onRetry}>重试</button>
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
  const base = name.replace(/\.[^.]+$/, "");
  const parts = /^(.+?)\s*[-–—]\s*([^-–—]+)$/.exec(base);
  const title = parts ? parts[1].trim() : base, artist = parts ? parts[2].trim() : "";
  const toggle = () => { if (!audio) return; if (audio.isPlaying()) audio.pause(); else void audio.play().catch(() => undefined); };
  const modeIndex = PLAYBACK_MODES.findIndex(item => item.value === nav?.mode);
  const nextMode = PLAYBACK_MODES[(modeIndex + 1) % PLAYBACK_MODES.length];
  const volumeIcon: IconName = volume.muted || volume.level === 0 ? "volumeMute" : volume.level < .5 ? "volumeLow" : "volume";
  const lyricHint = findingAssets || assetBusy ? "正在加载歌词…"
    : assetError || discoveryError ? assetError || discoveryError
    : assets.length && !selected ? "歌词已关闭"
    : "";
  const showLyrics = lyrics.length > 0 && lyricSource.current === url;
  return <div className={`preview-player preview-player-audio${cover ? " has-cover" : ""}${waiting && !failed ? " is-waiting" : ""}${playing && !waiting && !failed ? " is-playing" : ""}${playing ? " is-active" : ""}`}
    style={cover ? { "--preview-cover": `url("${cover}")` } as CSSProperties : undefined}>
    <div className="audio-backdrop" aria-hidden="true" />
    <div className={`audio-body${showLyrics ? " has-lyrics" : ""}`}>
      <div className="audio-art">
        <div className="audio-disc" aria-hidden="true"><div className="audio-disc-spin">{cover && <img src={cover} alt="" />}</div></div>
        <div className="audio-sleeve">{cover ? <img src={cover} alt="专辑封面" /> : <Icon name="audio" size={56} />}</div>
      </div>
      <div className="audio-side">
        <div className="audio-heading">
          <h3 title={name}>{title}</h3>
          {artist && <p className="audio-artist">{artist}</p>}
          <p role="status">
            <span className="preview-equalizer" aria-hidden="true"><i /><i /><i /><i /></span>
            <span>{failed ? "播放失败" : waiting ? state === "buffering" ? "正在缓冲" : "正在加载" : playing ? "正在播放" : "已暂停"}</span>
          </p>
          {assets.length > 0 && !failed && <label className="audio-lyrics-picker" title={assets.find(asset => asset.path === selected)?.name}>
            <span className="sr-only">选择歌词</span><Icon name="fileText" size={13} />
            <select value={selected} disabled={findingAssets} onChange={event => setSelected(event.target.value)}>
              <option value="">关闭歌词</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select><Icon name="chevronDown" size={12} />
          </label>}
        </div>
        {failure || (showLyrics
          ? <div className="audio-lyrics" ref={lyricHost} aria-label="同步歌词，点击跳转">
            {lyrics.map((line, index) => <button type="button" key={index} data-line={index} className={`audio-lyric${active === index ? " is-active" : ""}${index < active ? " is-past" : ""}`}
              aria-current={active === index ? "true" : undefined} onClick={() => audio?.seek(line.time)}>{line.text || "♪"}</button>)}
          </div>
          : <div className="audio-visual">
            <Spectrum analyser={() => audio?.analyser() ?? null} playing={playing && !waiting} />
            {lyricHint && <p className="audio-hint">{lyricHint}</p>}
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
          <MediaButton icon="previous" label="上一首" disabled={!nav || nav.count < 2} onClick={nav?.onPrevious} />
          <button type="button" className="audio-play" aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停（空格）" : "播放（空格）"} disabled={failed} onClick={toggle}>
            <Icon name={playing ? "pause" : "play"} size={24} />
          </button>
          <MediaButton icon="next" label="下一首" disabled={!nav || nav.count < 2} onClick={nav?.onNext} />
        </div>
        <div className="audio-buttons-end">
          <div className="audio-volume">
            <MediaButton icon={volumeIcon} label={volume.muted ? "取消静音" : "静音"} onClick={() => audio?.toggleMute()} />
            <input type="range" min={0} max={1} step={0.01} aria-label="音量" value={volume.muted ? 0 : volume.level}
              style={{ "--volume": `${(volume.muted ? 0 : volume.level) * 100}%` } as CSSProperties}
              onChange={event => audio?.setVolume(Number(event.target.value))}
              onKeyDown={event => { if (event.key.startsWith("Arrow")) event.stopPropagation(); }} />
          </div>
          {nav?.onPlaylist && nav.count > 1 && <MediaButton icon="list" className="playlist-toggle" label={`播放列表（${nav.index + 1} / ${nav.count}）`} active={nav.playlistOpen} onClick={nav.onPlaylist} />}
        </div>
      </div>
    </div>
    {slowNotice}
  </div>;
}
