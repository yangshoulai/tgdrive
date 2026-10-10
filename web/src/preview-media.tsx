/** 播放界面与歌词、字幕附件；缓冲状态始终保留播放器。 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { errorMessage, type PreviewAsset } from "./api";
import { readPreviewText } from "./preview-data";
import { loadMediaEngine } from "./preview-runtime";
import { Button, Icon } from "./ui";
import type { MediaState } from "./preview-media-engine";

type Engine = Awaited<ReturnType<typeof loadMediaEngine>>;
type Player = ReturnType<Engine["createVideoPlayer"]> | ReturnType<Engine["createAudioPlayer"]>;
type Lyric = { time: number; text: string };
export type AssetLoader = (signal: AbortSignal) => Promise<PreviewAsset[]>;

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
  return (asset.language && languages[asset.language.toLowerCase()]) || asset.language || "默认";
}

export function MediaPreview({ kind, url, name, downloadUrl, cover, onRetry, loadAssets, assetUrl }: {
  kind: "video" | "audio"; url: string; name: string; downloadUrl: string; cover?: string; onRetry: () => void;
  loadAssets?: AssetLoader; assetUrl?: (path: string) => string;
}) {
  const host = useRef<HTMLDivElement>(null), player = useRef<Player | null>(null);
  const loader = useRef(loadAssets), resolveAsset = useRef(assetUrl);
  loader.current = loadAssets; resolveAsset.current = assetUrl;
  const [state, setState] = useState<MediaState>("loading"), [error, setError] = useState("");
  const [playerReady, setPlayerReady] = useState(false), [slow, setSlow] = useState(false);
  const [assets, setAssets] = useState<PreviewAsset[]>([]), [selected, setSelected] = useState("");
  const [findingAssets, setFindingAssets] = useState(Boolean(loadAssets)), [discoveryError, setDiscoveryError] = useState("");
  const [assetBusy, setAssetBusy] = useState(false), [assetError, setAssetError] = useState("");
  const [lyrics, setLyrics] = useState<Lyric[]>([]), [active, setActive] = useState(-1);
  const lyricRef = useRef(lyrics), timeRef = useRef(0), lyricHost = useRef<HTMLDivElement>(null);
  lyricRef.current = lyrics;
  useEffect(() => {
    let cancelled = false;
    void loadMediaEngine().then(engine => {
      if (cancelled || !host.current) return;
      const notify = (value: MediaState) => { if (!cancelled) setState(value); };
      player.current = kind === "video" ? engine.createVideoPlayer(host.current, url, notify, cover)
        : engine.createAudioPlayer(host.current, url, name, notify, time => {
          timeRef.current = time; if (!cancelled) setActive(lyricAt(lyricRef.current, time));
        }, cover);
      setPlayerReady(true);
    }).catch(reason => { if (!cancelled) { setError(errorMessage(reason, "播放组件加载失败")); setState("failed"); } });
    return () => { cancelled = true; player.current?.destroy(); player.current = null; };
    // 封面只用于初始化播放器，不因封面地址变化而重建正在播放的播放器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, url, name]);
  useEffect(() => {
    if (state !== "loading" && state !== "buffering") { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [state]);
  useEffect(() => {
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
  }, [selected, assets, playerReady, kind]);
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
  const attachmentName = kind === "audio" ? "歌词" : "字幕";
  const selectedAsset = assets.find(asset => asset.path === selected);
  const attachmentStatus = discoveryError || assetError || (findingAssets ? `正在查找${attachmentName}…` : assetBusy ? `正在加载${attachmentName}…` : !assets.length ? `未找到同名${attachmentName}` : "");
  // 音频有封面时：播放键显示封面，歌词区背景使用模糊放大的封面。
  return <div className={`preview-player preview-player-${kind}${cover ? " has-cover" : ""}`} style={kind === "audio" && cover ? { "--preview-cover": `url("${cover}")` } as CSSProperties : undefined}>
    <div className="preview-player-surface">
      <div ref={host} className={`preview-player-host ${kind === "video" ? "preview-video-host" : "preview-audio-host"}`} />
      {waiting && <div className={`preview-playback-status${state === "buffering" ? " is-buffering" : ""}`} role="status"><span className="spinner" />{state === "buffering" ? "正在缓冲…" : "正在加载播放器…"}</div>}
    </div>
    {(state === "failed" || slow) && <div className="preview-player-recovery" role={state === "failed" ? "alert" : "status"}>
      <span>{error || (state === "failed" ? "播放器无法读取文件或解码此格式，请重试或下载后打开。" : "加载时间较长，可以继续等待或重新加载。")}</span>
      <Button size="sm" icon="refresh" onClick={onRetry}>重新加载</Button><a className="btn btn-secondary btn-sm" href={downloadUrl}><Icon name="download" size={15} />下载文件</a>
    </div>}
    {loadAssets && <div className="preview-asset-bar">
      <label className="preview-asset-control"><Icon name="fileText" size={15} /><span>{attachmentName}</span>
        <select className="input" value={selected} disabled={findingAssets || !assets.length} title={selectedAsset?.name} onChange={event => setSelected(event.target.value)} aria-label={kind === "video" ? "选择字幕语言" : "选择歌词"}>
          <option value="">关闭</option>{assets.map(asset => <option key={asset.path} value={asset.path}>
            {assetLabel(asset)}{assets.filter(item => assetLabel(item) === assetLabel(asset)).length > 1 ? ` · ${asset.name}` : ""}
          </option>)}
        </select>
      </label>
      {attachmentStatus ? <span className={`preview-asset-status${discoveryError || assetError ? " is-error" : ""}`} role={discoveryError || assetError ? "alert" : "status"}>{attachmentStatus}</span>
        : kind === "audio" && lyrics.length > 0 && <span className="preview-asset-hint">点击歌词跳转</span>}
    </div>}
    {kind === "audio" && lyrics.length > 0 && <div className="preview-lyrics" ref={lyricHost} aria-label="同步歌词">
      {lyrics.map((line, index) => <Button variant="ghost" size="sm" key={index} data-line={index} className={`preview-lyric${active === index ? " is-active" : ""}`}
        aria-current={active === index ? "true" : undefined} onClick={() => { const instance = player.current; if (instance && "seek" in instance) instance.seek(line.time); }}>{line.text || "♪"}</Button>)}
    </div>}
    {kind === "audio" && !lyrics.length && <div className="preview-lyrics-empty">
      {cover ? <img className="preview-audio-cover" src={cover} alt="专辑封面" /> : <span className="preview-audio-mark"><Icon name="audio" size={30} /></span>}
      <strong>{assetBusy || findingAssets ? "正在加载歌词" : assets.length && !selected ? "歌词已关闭" : "暂无同步歌词"}</strong>
      <span>{assetBusy || findingAssets ? "音乐可以继续播放" : assetError || discoveryError ? "歌词暂时不可用，音乐可以继续播放" : !assets.length ? "同目录的同名 LRC 歌词会自动显示在这里" : "随时开启同步歌词"}</span>
    </div>}
  </div>;
}
