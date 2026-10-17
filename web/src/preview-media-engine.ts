/** 视频播放器（ArtPlayer）的独立入口；媒体状态与附件加载由预览界面负责。音乐使用原生 <audio>，见 preview-media.tsx。 */
import Artplayer from "artplayer";

export type MediaState = "loading" | "ready" | "buffering" | "failed";
export type MediaProgress = { currentTime: number; duration: number };
type Notify = (state: MediaState) => void;
type Mode = "sequence" | "random" | "loop" | "single";
/** 与 preview-playlist.tsx 的 PreviewNav 一致；这里只声明用到的字段，避免引擎包依赖界面模块。 */
type Navigation = { index: number; count: number; onPrevious: () => void; onNext: () => void; mode?: Mode; onMode?: (mode: Mode) => void; playlistOpen?: boolean; onPlaylist?: () => void };
const MODE_LABELS: [Mode, string][] = [["sequence", "顺序播放"], ["random", "随机播放"], ["loop", "列表循环"], ["single", "单曲循环"]];
/** 与 ui.tsx 的图标同一套线条，保持控制条风格一致。 */
const glyph = (path: string) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const GLYPHS = {
  previous: glyph("M5 5v14m13-14L8 12l10 7V5Z"),
  next: glyph("M19 5v14M6 5l10 7-10 7V5Z"),
  list: glyph("M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"),
};
type PlaybackEvents = { onEnded: () => void; onPlaying: (playing: boolean) => void; onProgress?: (progress: MediaProgress) => void; onVideoSize?: (width: number, height: number) => void; onVideoFrame?: (video: HTMLVideoElement) => void };
function mediaProgress(media: HTMLMediaElement): MediaProgress {
  const duration = Number.isFinite(media.duration) ? Math.max(0, media.duration) : 0;
  const currentTime = Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0;
  return { currentTime: duration ? Math.min(currentTime, duration) : currentTime, duration };
}
function seekBy(media: HTMLMediaElement, seconds: number) {
  const { currentTime, duration } = mediaProgress(media);
  if (duration) media.currentTime = Math.max(0, Math.min(duration, currentTime + seconds));
}
export function createVideoPlayer(container: HTMLDivElement, url: string, notify: Notify, poster?: string, events?: PlaybackEvents, navigation?: () => Navigation | undefined) {
  // 网页全屏仍留在预览的对话框内，保留焦点锁和无障碍语义。
  Artplayer.FULLSCREEN_WEB_IN_BODY = false;
  // 不自动重连：播放失败直接交给预览界面显示原因与重试，避免画面上反复出现“重新连接”。
  Artplayer.RECONNECT_TIME_MAX = 0;
  const player = new Artplayer({ container, url, poster: poster ?? "", lang: "zh-cn", autoplay: false, theme: "#ffffff",
    setting: true, playbackRate: true, aspectRatio: true, fullscreen: true, fullscreenWeb: true, pip: true, miniProgressBar: true, fastForward: true,
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
  const markReady = () => { setRatio(player.video.videoWidth, player.video.videoHeight); ready = true; notify("ready"); if (player.video.readyState >= 2) events?.onVideoFrame?.(player.video); };
  // iOS Safari 在用户点播放前不预加载画面，只会触发 loadedmetadata：读到时长即视为就绪，避免误报“加载较慢”。
  player.on("video:loadedmetadata", () => { markReady(); updateProgress(); });
  player.on("video:resize", () => setRatio(player.video.videoWidth, player.video.videoHeight));
  player.on("video:loadeddata", markReady);
  player.on("video:canplay", markReady);
  player.on("video:playing", markReady);
  player.on("video:waiting", () => notify(ready ? "buffering" : "loading"));
  player.on("video:pause", () => { if (ready) notify("ready"); });
  player.on("video:durationchange", updateProgress);
  player.on("video:timeupdate", () => { updateProgress(); if (player.video.readyState >= 2) events?.onVideoFrame?.(player.video); });
  player.on("video:seeked", () => { updateProgress(); if (player.video.readyState >= 2) markReady(); });
  player.on("video:ended", () => { markReady(); events?.onPlaying(false); events?.onEnded(); });
  player.on("video:error", () => notify("failed"));
  // ArtPlayer 默认只监听浏览器窗口；弹窗拖动改变容器尺寸时也要更新比例与控件布局。
  const observer = new ResizeObserver(() => player.emit("resize"));
  observer.observe(container);
  updateProgress();
  /** 上一个／下一个紧跟播放键，播放列表在设置前，播放模式放进设置菜单；只有一个文件时都不显示。 */
  const refreshNavigation = () => {
    if (destroyed) return;
    const nav = navigation?.();
    const multiple = Boolean(nav && nav.count > 1);
    const control = (name: string, option: Record<string, unknown> | null) => {
      if (option) player.controls.update({ name, ...option });
      else if (container.querySelector(`.art-control-${name}`)) player.controls.remove(name);
    };
    control("previous", multiple ? { position: "left", index: 11, html: GLYPHS.previous, tooltip: "上一个", click: () => navigation?.()?.onPrevious() } : null);
    control("next", multiple ? { position: "left", index: 12, html: GLYPHS.next, tooltip: "下一个", click: () => navigation?.()?.onNext() } : null);
    control("playlist", multiple && nav?.onPlaylist ? { position: "right", index: 25, html: GLYPHS.list, tooltip: `播放列表 ${nav.index + 1}/${nav.count}`,
      style: nav.playlistOpen ? { color: "var(--art-theme)" } : {}, click: () => navigation?.()?.onPlaylist?.() } : null);
    for (const name of ["previous", "next", "playlist"]) {
      const element = container.querySelector<HTMLElement>(`.art-control-${name}`);
      if (element) { element.tabIndex = 0; element.setAttribute("role", "button"); element.setAttribute("aria-label", name === "previous" ? "上一个" : name === "next" ? "下一个" : "播放列表"); }
    }
    if (multiple && nav?.mode && nav.onMode) {
      const current = MODE_LABELS.find(([value]) => value === nav.mode) ?? MODE_LABELS[0];
      const item = { name: "mode", html: "播放模式", tooltip: current[1], width: 180,
        selector: MODE_LABELS.map(([value, label]) => ({ html: label, value, default: value === current[0] })),
        onSelect: (option: { value?: Mode; html: string }) => { if (option.value) navigation?.()?.onMode?.(option.value); return option.html; } };
      if (player.setting.find("mode")) player.setting.update(item); else player.setting.add(item);
    } else if (player.setting.find("mode")) player.setting.remove("mode");
  };
  return {
    refreshNavigation,
    play: () => player.play(),
    pause: () => player.pause(),
    isPlaying: () => !player.video.paused,
    seek: (time: number) => { player.video.currentTime = time; updateProgress(); },
    seekBy: (seconds: number) => { seekBy(player.video, seconds); updateProgress(); },
    adjustVolume: (delta: number) => { player.volume = Math.max(0, Math.min(1, player.video.volume + delta)); },
    setSource: (nextUrl: string, _name: string, nextCover?: string) => {
      player.pause(); ready = false; notify("loading");
      container.style.removeProperty("--preview-video-ratio");
      player.poster = nextCover ?? ""; player.url = nextUrl;
      // 换源后立即重置原生媒体和控件，不能等新文件的 timeupdate 来清掉旧时间与缓冲条。
      player.video.load(); player.currentTime = 0;
      player.emit("setBar", "played", 0); player.emit("setBar", "loaded", 0);
      const time = container.querySelector(".art-control-time");
      if (time) time.textContent = "00:00 / 00:00";
      events?.onPlaying(false); events?.onProgress?.({ currentTime: 0, duration: 0 });
      setCover(nextCover);
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
      destroyed = true; version++; observer.disconnect(); document.removeEventListener("keydown", exitWebScreen, true);
      if (cover) { cover.onload = null; cover.src = ""; }
      player.destroy(); container.style.removeProperty("--preview-video-ratio");
      if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
    },
  };
}
