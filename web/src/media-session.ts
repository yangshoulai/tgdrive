/** 系统媒体控制（Media Session）：锁屏、通知中心、耳机线控与键盘媒体键控制正在播放的音视频，并显示标题、艺人与封面。
 * 同一时间只有一个播放器拥有它：最近开始播放的那个接管，卸载时只清理自己设置的内容。 */
import { useEffect, useRef, useState } from "react";
import type { PreviewNav } from "./preview-playlist";

type Controls = { play: () => Promise<void>; pause: () => void; seek: (time: number) => void; seekBy: (seconds: number) => void };
type SessionInput = {
  active: boolean; playing: boolean; media: () => HTMLMediaElement | null; controls: Controls | null; nav?: PreviewNav;
  title: string; artist: string; album: string; artwork?: string;
};

const ACTIONS: MediaSessionAction[] = ["play", "pause", "stop", "previoustrack", "nexttrack", "seekbackward", "seekforward", "seekto"];
let owner: symbol | null = null;
const owners = new Set<() => void>();
/** 换成另一个播放器接管时通知全部播放器重新判断。 */
function claim(token: symbol | null) { owner = token; for (const notify of owners) notify(); }

const supported = () => typeof navigator !== "undefined" && "mediaSession" in navigator;

function clear() {
  if (!supported()) return;
  navigator.mediaSession.metadata = null;
  navigator.mediaSession.playbackState = "none";
  for (const action of ACTIONS) {
    try { navigator.mediaSession.setActionHandler(action, null); } catch { /* 浏览器不支持这个动作 */ }
  }
}

function handle(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
  try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* 浏览器不支持这个动作 */ }
}

export function useMediaSession({ active, playing, media, controls, nav, title, artist, album, artwork }: SessionInput) {
  const token = useRef(Symbol("media-session"));
  const latest = useRef({ controls, nav, media });
  latest.current = { controls, nav, media };
  const [current, setCurrent] = useState(false);
  useEffect(() => {
    const notify = () => setCurrent(owner === token.current);
    owners.add(notify);
    return () => { owners.delete(notify); };
  }, []);
  // 开始播放时接管；没有接管过的播放器（例如另一个最小化的小窗）不改动系统控制。
  useEffect(() => { if (active && playing && owner !== token.current) claim(token.current); }, [active, playing]);
  const mine = active && current;
  useEffect(() => {
    if (!supported() || !mine) return;
    const artworkUrl = artwork ? new URL(artwork, window.location.href).href : undefined;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork: artworkUrl ? [{ src: artworkUrl, sizes: "960x960" }] : [] });
    } catch { /* 封面地址不可用时只显示文字 */ }
  }, [mine, title, artist, album, artwork]);
  useEffect(() => {
    if (supported() && mine) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }, [mine, playing]);
  const navigable = Boolean(nav && nav.count > 1);
  useEffect(() => {
    if (!supported() || !mine) return;
    const run = () => latest.current.controls;
    handle("play", () => void run()?.play().catch(() => undefined));
    handle("pause", () => run()?.pause());
    handle("stop", () => run()?.pause());
    handle("seekbackward", details => run()?.seekBy(-(details.seekOffset || 10)));
    handle("seekforward", details => run()?.seekBy(details.seekOffset || 10));
    handle("seekto", details => { if (details.seekTime != null) run()?.seek(details.seekTime); });
    handle("previoustrack", navigable ? () => latest.current.nav?.onPrevious() : null);
    handle("nexttrack", navigable ? () => latest.current.nav?.onNext() : null);
  }, [mine, navigable]);
  // 进度：锁屏上的进度条与拖动需要时长和当前位置；只在元素事件发生时更新，不另开定时器。
  useEffect(() => {
    if (!supported() || !mine || !("setPositionState" in navigator.mediaSession)) return;
    const element = media();
    if (!element) return;
    const sync = () => {
      const duration = element.duration, position = element.currentTime;
      if (!Number.isFinite(duration) || duration <= 0) return;
      try {
        navigator.mediaSession.setPositionState({ duration, position: Math.min(Math.max(0, position), duration), playbackRate: element.playbackRate || 1 });
      } catch { /* 位置超出时长等瞬时状态 */ }
    };
    const events = ["durationchange", "loadedmetadata", "seeked", "ratechange", "play", "pause"];
    for (const name of events) element.addEventListener(name, sync);
    sync();
    return () => { for (const name of events) element.removeEventListener(name, sync); };
  }, [mine, media, title, playing]);
  useEffect(() => () => {
    if (owner !== token.current) return;
    clear();
    claim(null);
  }, []);
}
