/** 播放界面与歌词、字幕附件；缓冲状态始终保留播放器。 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { errorMessage, type PreviewAsset } from "./api";
import { readPreviewText } from "./preview-data";
import { loadMediaEngine } from "./preview-runtime";
import { Button, Icon } from "./ui";
import type { MediaProgress, MediaState } from "./preview-media-engine";
export type { MediaProgress, MediaState } from "./preview-media-engine";

type Engine = Awaited<ReturnType<typeof loadMediaEngine>>;
type Player = ReturnType<Engine["createVideoPlayer"]> | ReturnType<Engine["createAudioPlayer"]>;
type Lyric = { time: number; text: string };
export type AssetLoader = (signal: AbortSignal) => Promise<PreviewAsset[]>;
export type PlaybackControls = Pick<Player, "play" | "pause" | "isPlaying" | "seek" | "seekBy" | "adjustVolume">;
export type PlaybackProps = { onEnded?: () => void; onPlaying?: (playing: boolean) => void; onProgress?: (progress: MediaProgress) => void; onState?: (state: MediaState) => void; onControls?: (controls: PlaybackControls | null) => void; onVideoSize?: (width: number, height: number) => void };

function playbackTime(time: number): string {
  const seconds = Math.floor(time), hours = Math.floor(seconds / 3600);
  return [...(hours ? [String(hours)] : []), String(Math.floor(seconds / 60) % 60).padStart(2, "0"), String(seconds % 60).padStart(2, "0")].join(":");
}
export function MinimizedPlayback({ progress, state, playing, onSeek, children }: {
  progress: MediaProgress; state: MediaState; playing: boolean; onSeek: (time: number) => void; children: ReactNode;
}) {
  const time = playbackTime(progress.currentTime), duration = progress.duration ? playbackTime(progress.duration) : "--:--";
  const percent = progress.duration ? progress.currentTime / progress.duration * 100 : 0;
  const status = state === "failed" ? "播放失败" : state === "loading" ? "正在加载" : state === "buffering" ? "正在缓冲" : playing ? "正在播放" : "已暂停";
  return <div className={`preview-mini-player${playing && state === "ready" ? " is-playing" : ""}`}>
    <div className="preview-mini-timeline">
      <input className="preview-mini-progress" type="range" aria-label="播放进度" aria-valuetext={`已播放 ${time}，共 ${duration}`} min={0} max={progress.duration || 1} step={0.1}
        value={progress.duration ? progress.currentTime : 0} disabled={!progress.duration || state === "failed"} onChange={event => onSeek(Number(event.target.value))}
        onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); onSeek(Math.max(0, Math.min(progress.duration, progress.currentTime + (event.key === "ArrowLeft" ? -5 : 5)))); } }}
        style={{ "--playback-progress": `${percent}%` } as CSSProperties} />
      <div className="preview-mini-meta">
        <span className="preview-mini-activity" role="status"><span className="preview-equalizer" aria-hidden="true"><i /><i /><i /><i /></span>{status}</span>
        <span className="preview-mini-time">{time}<span> / {duration}</span></span>
      </div>
    </div>
    {children}
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

export function MediaPreview({ kind, url, name, cover, onRetry, loadAssets, assetUrl, onEnded, onPlaying, onProgress, onState, onControls, onVideoSize }: {
  kind: "video" | "audio"; url: string; name: string; cover?: string; onRetry: () => void;
  loadAssets?: AssetLoader; assetUrl?: (path: string) => string;
} & PlaybackProps) {
  const host = useRef<HTMLDivElement>(null), player = useRef<Player | null>(null);
  const loader = useRef(loadAssets), resolveAsset = useRef(assetUrl);
  loader.current = loadAssets; resolveAsset.current = assetUrl;
  const callbacks = useRef({ onEnded, onPlaying, onProgress, onState, onControls, onVideoSize }), source = useRef({ url, name, cover }), loadedUrl = useRef("");
  callbacks.current = { onEnded, onPlaying, onProgress, onState, onControls, onVideoSize }; source.current = { url, name, cover };
  const [state, setState] = useState<MediaState>("loading"), [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [playerReady, setPlayerReady] = useState(false), [slow, setSlow] = useState(false);
  const [assets, setAssets] = useState<PreviewAsset[]>([]), [selected, setSelected] = useState("");
  const [findingAssets, setFindingAssets] = useState(Boolean(loadAssets)), [discoveryError, setDiscoveryError] = useState("");
  const [assetBusy, setAssetBusy] = useState(false), [assetError, setAssetError] = useState("");
  const [lyrics, setLyrics] = useState<Lyric[]>([]), [active, setActive] = useState(-1);
  const lyricRef = useRef(lyrics), timeRef = useRef(0), lyricHost = useRef<HTMLDivElement>(null);
  lyricRef.current = lyrics;
  useEffect(() => {
    let cancelled = false;
    const notify = (value: MediaState) => {
      if (cancelled) return;
      setState(value); callbacks.current.onState?.(value);
      if (value === "failed") { setPlaying(false); callbacks.current.onPlaying?.(false); }
    };
    notify("loading"); callbacks.current.onProgress?.({ currentTime: 0, duration: 0 });
    void loadMediaEngine().then(engine => {
      if (cancelled || !host.current) return;
      const events = { onEnded: () => callbacks.current.onEnded?.(),
        onPlaying: (value: boolean) => { if (!cancelled) setPlaying(value); callbacks.current.onPlaying?.(value); },
        onProgress: (value: MediaProgress) => { if (!cancelled) callbacks.current.onProgress?.(value); },
        onVideoSize: (width: number, height: number) => callbacks.current.onVideoSize?.(width, height) };
      const initial = source.current;
      player.current = kind === "video" ? engine.createVideoPlayer(host.current, initial.url, notify, initial.cover, events)
        : engine.createAudioPlayer(host.current, initial.url, initial.name, notify, time => {
          timeRef.current = time; if (!cancelled) setActive(lyricAt(lyricRef.current, time));
        }, initial.cover, events);
      loadedUrl.current = initial.url;
      setPlayerReady(true);
      callbacks.current.onControls?.(player.current);
    }).catch(reason => { if (!cancelled) { setError(errorMessage(reason, "播放组件加载失败")); notify("failed"); } });
    return () => { cancelled = true; callbacks.current.onControls?.(null); player.current?.destroy(); player.current = null; };
    // 切换同类文件只替换媒体源，最小化、恢复与播放模式变化都保留实例。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  useEffect(() => {
    if (!player.current || loadedUrl.current === url) return;
    setError(""); setSlow(false); timeRef.current = 0;
    loadedUrl.current = url;
    player.current.setSource(url, name, cover);
    callbacks.current.onControls?.(player.current);
    // 封面元信息变化不重置已在播放的媒体。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, playerReady]);
  useEffect(() => {
    if (state !== "loading" && state !== "buffering") { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [state, url]);
  useEffect(() => {
    setAssets([]); setSelected(""); setLyrics([]); lyricRef.current = []; setActive(-1); setDiscoveryError("");
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
    setAssetError(""); setAssetBusy(false); lyricRef.current = []; setLyrics([]); setActive(-1);
    const instance = player.current;
    if (!selected) { if (instance && "setSubtitle" in instance) void instance.setSubtitle(null); return; }
    const asset = assets.find(item => item.path === selected);
    if (!asset || !resolveAsset.current) return;
    setAssetBusy(true);
    if (instance && "setSubtitle" in instance) void instance.setSubtitle(null);
    void readPreviewText(resolveAsset.current(asset.path), 2 * 1024 * 1024, controller.signal).then(async value => {
      if (controller.signal.aborted) return;
      if (value.truncated) throw new Error("歌词或字幕超过 2 MB，无法完整预览");
      if (kind === "audio") {
        const parsed = parseLyrics(value.text);
        if (!parsed.length) throw new Error("歌词没有有效的时间标签");
        lyricRef.current = parsed; setLyrics(parsed); setActive(lyricAt(parsed, timeRef.current));
      } else if (instance && "setSubtitle" in instance) {
        await instance.setSubtitle(value.text, /\.srt$/i.test(asset.name) ? "srt" : "vtt");
      }
    }).catch(reason => { if (!controller.signal.aborted) setAssetError(errorMessage(reason, "歌词或字幕加载失败")); })
      .finally(() => { if (!controller.signal.aborted) setAssetBusy(false); });
    return () => { controller.abort(); if (instance && "setSubtitle" in instance) void instance.setSubtitle(null); };
  }, [selected, assets, playerReady, kind, url]);
  useEffect(() => {
    const row = lyricHost.current?.querySelector<HTMLElement>(`[data-line="${active}"]`);
    if (row && lyricHost.current) lyricHost.current.scrollTo({ top: row.offsetTop - lyricHost.current.clientHeight / 2 + row.clientHeight / 2,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
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
  const options = assets.map(asset => ({ value: asset.path, label: assetLabel(asset) + (assets.filter(item => assetLabel(item) === assetLabel(asset)).length > 1 ? ` · ${asset.name}` : "") }));
  const optionKey = options.map(option => `${option.value}=${option.label}`).join("|");
  // 视频字幕放进播放器自己的设置菜单；没有找到字幕时不出现这一项，也不再单独占一行提示。
  useEffect(() => {
    const instance = player.current;
    if (!playerReady || !instance || !("setSubtitleMenu" in instance)) return;
    instance.setSubtitleMenu(options, selected, setSelected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerReady, optionKey, selected]);
  useEffect(() => {
    const instance = player.current, message = assetError || discoveryError;
    if (message && instance && "notice" in instance) instance.notice(message);
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
  const lyricStatus = findingAssets || assetBusy ? ["正在加载歌词", "音乐可以继续播放"]
    : assetError || discoveryError ? ["歌词暂时不可用", assetError || discoveryError]
    : assets.length && !selected ? ["歌词已关闭", "可以在右上角重新开启"]
    : ["暂无同步歌词", "同目录的同名 LRC 歌词会自动显示在这里"];
  return <div className={`preview-player preview-player-${kind}${cover ? " has-cover" : ""}${waiting && !failed ? " is-waiting" : ""}${playing && !waiting && !failed ? " is-playing" : ""}`}
    style={kind === "audio" && cover ? { "--preview-cover": `url("${cover}")` } as CSSProperties : undefined}>
    <div className="preview-player-surface">
      <div ref={host} className={`preview-player-host ${kind === "video" ? "preview-video-host" : "preview-audio-host"}`} />
      {kind === "video" && (failure || slowNotice)}
    </div>
    {kind === "audio" && <div className="preview-lyrics-region">
      {!failed && <span className="preview-audio-activity" role="status"><span className="preview-equalizer" aria-hidden="true"><i /><i /><i /><i /></span>
        {waiting ? state === "buffering" ? "正在缓冲" : "正在加载" : playing ? "正在播放" : "已暂停"}</span>}
      {assets.length > 0 && !failed && <label className="preview-lyrics-picker" title={assets.find(asset => asset.path === selected)?.name}>
        <span className="sr-only">选择歌词</span><Icon name="fileText" size={13} />
        <select value={selected} disabled={findingAssets} onChange={event => setSelected(event.target.value)}>
          <option value="">关闭歌词</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select><Icon name="chevronDown" size={12} />
      </label>}
      {failure || (lyrics.length > 0
        ? <div className="preview-lyrics" ref={lyricHost} aria-label="同步歌词，点击跳转">
          {lyrics.map((line, index) => <Button variant="ghost" size="sm" key={index} data-line={index} className={`preview-lyric${active === index ? " is-active" : ""}`}
            aria-current={active === index ? "true" : undefined} onClick={() => { const instance = player.current; if (instance && "seek" in instance) instance.seek(line.time); }}>{line.text || "♪"}</Button>)}
        </div>
        : <div className="preview-lyrics-empty">
          {cover ? <img className="preview-audio-cover" src={cover} alt="专辑封面" /> : <span className="preview-audio-mark"><Icon name="audio" size={30} /></span>}
          <strong>{lyricStatus[0]}</strong><span>{lyricStatus[1]}</span>
        </div>)}
      {slowNotice}
    </div>}
  </div>;
}
