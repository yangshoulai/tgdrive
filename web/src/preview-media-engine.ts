/** 开源播放器的独立入口；媒体状态与附件加载由预览界面负责。 */
import Artplayer from "artplayer";
import APlayer from "aplayer";
import "aplayer/dist/APlayer.min.css";

export type MediaState = "loading" | "ready" | "buffering" | "failed";
export type MediaProgress = { currentTime: number; duration: number };
type Notify = (state: MediaState) => void;
type PlaybackEvents = { onEnded: () => void; onPlaying: (playing: boolean) => void; onProgress?: (progress: MediaProgress) => void; onVideoSize?: (width: number, height: number) => void };
function mediaProgress(media: HTMLMediaElement): MediaProgress {
  const duration = Number.isFinite(media.duration) ? Math.max(0, media.duration) : 0;
  const currentTime = Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0;
  return { currentTime: duration ? Math.min(currentTime, duration) : currentTime, duration };
}
function seekBy(media: HTMLMediaElement, seconds: number) {
  const { currentTime, duration } = mediaProgress(media);
  if (duration) media.currentTime = Math.max(0, Math.min(duration, currentTime + seconds));
}
export function createVideoPlayer(container: HTMLDivElement, url: string, notify: Notify, poster?: string, events?: PlaybackEvents) {
  // 网页全屏仍留在预览的对话框内，保留焦点锁和无障碍语义。
  Artplayer.FULLSCREEN_WEB_IN_BODY = false;
  // 不自动重连：播放失败直接交给预览界面显示原因与重试，避免画面上反复出现“重新连接”。
  Artplayer.RECONNECT_TIME_MAX = 0;
  const player = new Artplayer({ container, url, poster: poster ?? "", lang: "zh-cn", autoplay: false, theme: getComputedStyle(container).getPropertyValue("--accent").trim(),
    setting: true, playbackRate: true, aspectRatio: true, fullscreen: true, fullscreenWeb: true, pip: true,
    // 快捷键由预览窗口统一处理，避免全局监听重复跳转或影响最小化后的页面操作。
    hotkey: false, mutex: true, autoSize: false, moreVideoAttr: { preload: "metadata", playsInline: true } });
  const controls = [["playAndPause", "播放视频"], ["setting", "显示设置"], ["pip", "开启画中画"], ["fullscreenWeb", "网页全屏"], ["fullscreen", "全屏"]];
  for (const [control, label] of controls) {
    const button = container.querySelector<HTMLElement>(`.art-control-${control}`);
    if (!button) continue;
    button.tabIndex = 0; button.setAttribute("role", "button"); button.setAttribute("aria-label", label);
    button.addEventListener("keydown", event => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault(); event.stopPropagation();
        if (event.repeat) return;
        if (control === "playAndPause") { if (player.video.paused) void player.play(); else player.pause(); } else button.click();
      }
    });
  }
  const playButton = container.querySelector(".art-control-playAndPause");
  player.on("video:play", () => playButton?.setAttribute("aria-label", "暂停视频"));
  player.on("video:pause", () => playButton?.setAttribute("aria-label", "播放视频"));
  player.on("video:ended", () => playButton?.setAttribute("aria-label", "播放视频"));
  player.on("video:play", () => events?.onPlaying(true));
  player.on("video:pause", () => events?.onPlaying(false));
  // 播放器的网页全屏先消费 Esc，不能让外层预览同时关闭。
  const exitWebScreen = (event: KeyboardEvent) => {
    if (event.key === "Escape" && player.fullscreenWeb) { event.preventDefault(); event.stopPropagation(); player.fullscreenWeb = false; }
  };
  document.addEventListener("keydown", exitWebScreen, true);
  let ready = false, destroyed = false, subtitleUrl: string | null = null, version = 0;
  const setRatio = (width: number, height: number) => {
    if (!destroyed && width > 0 && height > 0) {
      container.style.setProperty("--preview-video-ratio", String(width / height));
      events?.onVideoSize?.(width, height);
    }
  };
  // 封面与视频都使用原始比例；元信息就绪后以实际视频尺寸为准，兼容旧封面。
  let cover: HTMLImageElement | null = null;
  const setCover = (src?: string) => {
    if (cover) { cover.onload = null; cover.src = ""; }
    cover = src ? new Image() : null;
    const image = cover;
    if (image) { image.onload = () => { if (!player.video.videoWidth) setRatio(image.naturalWidth, image.naturalHeight); }; image.src = src!; }
  };
  setCover(poster);
  let switching = Promise.resolve();
  const updateProgress = () => events?.onProgress?.(mediaProgress(player.video));
  const markReady = () => { setRatio(player.video.videoWidth, player.video.videoHeight); ready = true; notify("ready"); };
  // iOS Safari 在用户点播放前不预加载画面，只会触发 loadedmetadata：读到时长即视为就绪，避免误报“加载较慢”。
  player.on("video:loadedmetadata", () => { markReady(); updateProgress(); });
  player.on("video:loadeddata", markReady);
  player.on("video:canplay", markReady);
  player.on("video:playing", markReady);
  player.on("video:waiting", () => notify(ready ? "buffering" : "loading"));
  player.on("video:pause", () => { if (ready) notify("ready"); });
  player.on("video:durationchange", updateProgress);
  player.on("video:timeupdate", updateProgress);
  player.on("video:seeked", () => { updateProgress(); if (player.video.readyState >= 2) markReady(); });
  player.on("video:ended", () => { markReady(); events?.onPlaying(false); events?.onEnded(); });
  player.on("video:error", () => notify("failed"));
  updateProgress();
  return {
    play: () => player.play(),
    pause: () => player.pause(),
    isPlaying: () => !player.video.paused,
    seek: (time: number) => { player.video.currentTime = time; updateProgress(); },
    seekBy: (seconds: number) => { seekBy(player.video, seconds); updateProgress(); },
    adjustVolume: (delta: number) => { player.volume = Math.max(0, Math.min(1, player.video.volume + delta)); },
    setSource: (nextUrl: string, _name: string, nextCover?: string) => {
      player.pause(); ready = false; notify("loading");
      events?.onProgress?.({ currentTime: 0, duration: 0 });
      container.style.removeProperty("--preview-video-ratio");
      player.poster = nextCover ?? ""; player.url = nextUrl; setCover(nextCover);
    },
    /** 字幕选择放在播放器的设置菜单里；没有字幕时不显示这一项。 */
    setSubtitleMenu: (options: { value: string; label: string }[], selected: string, onSelect: (value: string) => void) => {
      if (destroyed) return;
      if (!options.length) { if (player.setting.find("subtitle")) player.setting.remove("subtitle"); return; }
      const choices = [{ value: "", label: "关闭" }, ...options];
      const current = choices.find(choice => choice.value === selected) ?? choices[0];
      const item = {
        name: "subtitle", html: "字幕", tooltip: current.label, width: 220,
        selector: choices.map(choice => ({ html: choice.label, value: choice.value, default: choice.value === current.value })),
        onSelect: (option: { value?: string; html: string }) => { onSelect(String(option.value ?? "")); return option.html; },
      };
      if (player.setting.find("subtitle")) player.setting.update(item); else player.setting.add(item);
    },
    notice: (message: string) => { if (!destroyed) player.notice.show = message; },
    setSubtitle: (source: string | null, type: "srt" | "vtt" = "vtt") => {
      const current = ++version;
      switching = switching.catch(() => {}).then(async () => {
        if (destroyed || current !== version) return;
        if (!source) {
          player.subtitle.show = false;
          if (subtitleUrl) { URL.revokeObjectURL(subtitleUrl); subtitleUrl = null; }
          return;
        }
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
    destroy: () => {
      destroyed = true; version++; document.removeEventListener("keydown", exitWebScreen, true);
      if (cover) { cover.onload = null; cover.src = ""; }
      player.destroy(); container.style.removeProperty("--preview-video-ratio");
      if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
    },
  };
}

export function createAudioPlayer(container: HTMLElement, url: string, name: string, notify: Notify, onTime: (time: number) => void, cover?: string, events?: PlaybackEvents) {
  const player = new APlayer({ container, theme: getComputedStyle(container).getPropertyValue("--accent").trim(),
    autoplay: false, preload: "metadata", mutex: true, lrcType: 0, loop: "none", order: "list",
    audio: [{ name: "音频", artist: "", url, ...(cover ? { cover } : {}) }] });
  // 文件名通过 textContent 写入，避免第三方模板将它解释为 HTML。
  const title = container.querySelector(".aplayer-title");
  if (title) { title.textContent = name; container.querySelector(".aplayer-music")?.replaceChildren(title); }
  const play = container.querySelector<HTMLElement>(".aplayer-pic");
  if (play) {
    play.tabIndex = 0; play.setAttribute("role", "button"); play.setAttribute("aria-label", "播放音频");
    play.addEventListener("keydown", event => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) { if (player.audio.paused) void player.audio.play(); else player.audio.pause(); }
      }
    });
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
    const value = mediaProgress(player.audio);
    progress?.setAttribute("aria-valuemax", String(value.duration));
    progress?.setAttribute("aria-valuenow", String(Math.floor(value.currentTime)));
    onTime(value.currentTime); events?.onProgress?.(value);
  };
  let ready = false;
  const markReady = () => { ready = true; notify("ready"); };
  player.on("loadedmetadata", () => { markReady(); updateProgress(); }); player.on("canplay", markReady); player.on("playing", markReady);
  player.on("play", () => events?.onPlaying(true));
  player.on("pause", () => events?.onPlaying(false));
  player.on("waiting", () => notify(ready ? "buffering" : "loading"));
  player.on("pause", () => { if (ready) notify("ready"); });
  // 预览统一决定下一首，拦截 APlayer 自带的单文件回绕，避免两个播放模式同时生效。
  const ended = (event: Event) => { event.stopImmediatePropagation(); player.audio.pause(); markReady(); events?.onPlaying(false); events?.onEnded(); };
  player.audio.addEventListener("ended", ended, true);
  player.on("error", () => notify("failed"));
  player.on("durationchange", updateProgress);
  player.on("timeupdate", updateProgress);
  player.on("seeked", () => { updateProgress(); if (player.audio.readyState >= 2) markReady(); });
  updateProgress();
  return {
    play: () => player.audio.play(), pause: () => player.audio.pause(),
    isPlaying: () => !player.audio.paused,
    seek: (time: number) => { player.audio.currentTime = time; updateProgress(); },
    seekBy: (seconds: number) => { seekBy(player.audio, seconds); updateProgress(); },
    adjustVolume: (delta: number) => { player.volume(Math.max(0, Math.min(1, player.audio.volume + delta))); },
    setSource: (nextUrl: string, nextName: string, nextCover?: string) => {
      player.audio.pause(); ready = false; notify("loading");
      if (title) title.textContent = nextName;
      if (play) play.style.backgroundImage = nextCover ? `url("${nextCover}")` : "";
      player.audio.src = nextUrl; onTime(0); updateProgress();
    },
    destroy: () => { player.audio.removeEventListener("ended", ended, true); player.destroy(); },
  };
}
