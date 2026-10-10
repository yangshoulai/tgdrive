/** 开源播放器的独立入口；媒体状态与附件加载由预览界面负责。 */
import Artplayer from "artplayer";
import APlayer from "aplayer";
import "aplayer/dist/APlayer.min.css";

export type MediaState = "loading" | "ready" | "buffering" | "failed";
type Notify = (state: MediaState) => void;
export function createVideoPlayer(container: HTMLDivElement, url: string, notify: Notify, poster?: string) {
  // 网页全屏仍留在预览的对话框内，保留焦点锁和无障碍语义。
  Artplayer.FULLSCREEN_WEB_IN_BODY = false;
  const player = new Artplayer({ container, url, poster: poster ?? "", lang: "zh-cn", autoplay: false, theme: getComputedStyle(container).getPropertyValue("--accent").trim(),
    setting: true, playbackRate: true, aspectRatio: true, fullscreen: true, fullscreenWeb: true, pip: true,
    hotkey: true, mutex: true, autoSize: false, moreVideoAttr: { preload: "metadata", playsInline: true } });
  const controls = [["playAndPause", "播放视频"], ["setting", "显示设置"], ["pip", "开启画中画"], ["fullscreenWeb", "网页全屏"], ["fullscreen", "全屏"]];
  for (const [control, label] of controls) {
    const button = container.querySelector<HTMLElement>(`.art-control-${control}`);
    if (!button) continue;
    button.tabIndex = 0; button.setAttribute("role", "button"); button.setAttribute("aria-label", label);
    button.addEventListener("keydown", event => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault(); event.stopPropagation();
        if (control === "playAndPause") player.toggle(); else button.click();
      }
    });
  }
  const playButton = container.querySelector(".art-control-playAndPause");
  player.on("video:play", () => playButton?.setAttribute("aria-label", "暂停视频"));
  player.on("video:pause", () => playButton?.setAttribute("aria-label", "播放视频"));
  player.on("video:ended", () => playButton?.setAttribute("aria-label", "播放视频"));
  // 播放器的网页全屏先消费 Esc，不能让外层预览同时关闭。
  const exitWebScreen = (event: KeyboardEvent) => {
    if (event.key === "Escape" && player.fullscreenWeb) { event.preventDefault(); event.stopPropagation(); player.fullscreenWeb = false; }
  };
  document.addEventListener("keydown", exitWebScreen, true);
  let ready = false, destroyed = false, subtitleUrl: string | null = null, version = 0;
  let switching = Promise.resolve();
  const markReady = () => { ready = true; notify("ready"); };
  player.on("video:loadeddata", markReady);
  player.on("video:canplay", markReady);
  player.on("video:playing", markReady);
  player.on("video:waiting", () => notify(ready ? "buffering" : "loading"));
  player.on("video:pause", () => { if (ready) notify("ready"); });
  player.on("video:seeked", () => { if (player.video.readyState >= 2) markReady(); });
  player.on("video:ended", markReady);
  player.on("video:error", () => notify("failed"));
  return {
    setSubtitle: (source: string | null, type: "srt" | "vtt" = "vtt") => {
      const current = ++version;
      switching = switching.catch(() => {}).then(async () => {
        if (destroyed || current !== version) return;
        if (!source) { player.subtitle.show = false; return; }
        const next = URL.createObjectURL(new Blob([source], { type: "text/plain;charset=utf-8" }));
        try {
          await player.subtitle.switch(next, { type, escape: true });
          if (!destroyed && current === version) player.subtitle.show = true;
          else if (!destroyed) player.subtitle.show = false;
        } finally {
          if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
          subtitleUrl = next;
          if (destroyed) { URL.revokeObjectURL(next); subtitleUrl = null; }
        }
      });
      return switching;
    },
    destroy: () => { destroyed = true; version++; document.removeEventListener("keydown", exitWebScreen, true); player.destroy(); if (subtitleUrl) URL.revokeObjectURL(subtitleUrl); },
  };
}

export function createAudioPlayer(container: HTMLElement, url: string, name: string, notify: Notify, onTime: (time: number) => void, cover?: string) {
  const player = new APlayer({ container, theme: getComputedStyle(container).getPropertyValue("--accent").trim(),
    autoplay: false, preload: "metadata", mutex: true, lrcType: 0,
    audio: [{ name: "音频", artist: "", url, ...(cover ? { cover } : {}) }] });
  // 文件名通过 textContent 写入，避免第三方模板将它解释为 HTML。
  const title = container.querySelector(".aplayer-title");
  if (title) { title.textContent = name; container.querySelector(".aplayer-music")?.replaceChildren(title); }
  const play = container.querySelector<HTMLElement>(".aplayer-pic");
  if (play) {
    play.tabIndex = 0; play.setAttribute("role", "button"); play.setAttribute("aria-label", "播放音频");
    play.addEventListener("keydown", event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); player.toggle(); } });
    player.on("play", () => play.setAttribute("aria-label", "暂停音频"));
    player.on("pause", () => play.setAttribute("aria-label", "播放音频"));
  }
  container.querySelector(".aplayer-icon-volume-down")?.setAttribute("aria-label", "调整音量");
  container.querySelector(".aplayer-icon-loop")?.setAttribute("aria-label", "切换循环模式");
  const progress = container.querySelector<HTMLElement>(".aplayer-bar-wrap");
  if (progress) {
    progress.tabIndex = 0; progress.setAttribute("role", "slider"); progress.setAttribute("aria-label", "播放进度");
    progress.setAttribute("aria-valuemin", "0"); progress.setAttribute("aria-valuemax", "0"); progress.setAttribute("aria-valuenow", "0");
    progress.addEventListener("keydown", event => {
      const duration = player.audio.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      const times: Record<string, number> = { ArrowLeft: player.audio.currentTime - 5, ArrowRight: player.audio.currentTime + 5, Home: 0, End: duration };
      if (event.key in times) { event.preventDefault(); player.audio.currentTime = Math.max(0, Math.min(duration, times[event.key])); }
    });
  }
  const updateProgress = () => {
    progress?.setAttribute("aria-valuemax", String(Number.isFinite(player.audio.duration) ? player.audio.duration : 0));
    progress?.setAttribute("aria-valuenow", String(Math.floor(player.audio.currentTime)));
    onTime(player.audio.currentTime);
  };
  let ready = false;
  const markReady = () => { ready = true; notify("ready"); };
  player.on("loadedmetadata", () => { markReady(); updateProgress(); }); player.on("canplay", markReady); player.on("playing", markReady);
  player.on("waiting", () => notify(ready ? "buffering" : "loading"));
  player.on("pause", () => { if (ready) notify("ready"); }); player.on("ended", markReady);
  player.on("error", () => notify("failed"));
  player.on("timeupdate", updateProgress);
  player.on("seeked", () => { updateProgress(); if (player.audio.readyState >= 2) markReady(); });
  return { seek: (time: number) => { player.audio.currentTime = time; onTime(time); }, destroy: () => player.destroy() };
}
