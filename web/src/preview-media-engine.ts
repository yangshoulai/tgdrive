/** 视频播放器（ArtPlayer）的独立入口；媒体状态与附件加载由预览界面负责。音乐使用原生 <audio>，见 preview-media.tsx。 */
import Artplayer from "artplayer";

export type MediaState = "loading" | "ready" | "buffering" | "failed";
export type MediaProgress = { currentTime: number; duration: number };
type Notify = (state: MediaState) => void;
type Mode = "sequence" | "random" | "loop" | "single";
/** 与 preview-playlist.tsx 的 PreviewNav 一致；这里只声明用到的字段，避免引擎包依赖界面模块。 */
type Navigation = { index: number; count: number; onPrevious: () => void; onNext: () => void; mode?: Mode; onMode?: (mode: Mode) => void; playlistOpen?: boolean; onPlaylist?: () => void };
const MODE_LABELS: [Mode, string][] = [["sequence", "顺序播放"], ["random", "随机播放"], ["loop", "列表循环"], ["single", "单曲循环"]];
/** 画面旋转（顺时针角度）：横屏文件里录成竖屏的内容可转正；只改显示，不改文件。 */
const ROTATION_LABELS: [number, string][] = [[0, "不旋转"], [90, "顺时针 90°"], [180, "旋转 180°"], [270, "逆时针 90°"]];
export const normalizeRotation = (degrees: number) => ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
/** 与 ui.tsx 的图标同一套线条，保持控制条风格一致。 */
const glyph = (path: string) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const GLYPHS = {
  previous: glyph("M5 5v14m13-14L8 12l10 7V5Z"),
  next: glyph("M19 5v14M6 5l10 7-10 7V5Z"),
  list: glyph("M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"),
  thumbnail: glyph("M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M8 8h.01"),
  rotate: glyph("M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5"),
};
/** 尺寸来源：stored 为已记录的尺寸，cover 为封面图比例（没有记录时的临时值），video 为视频元信息。 */
export type VideoSizeSource = "stored" | "cover" | "video";
type PlaybackEvents = { onEnded: () => void; onPlaying: (playing: boolean) => void; onProgress?: (progress: MediaProgress) => void; onVideoSize?: (width: number, height: number, source: VideoSizeSource) => void; onVideoFrame?: (video: HTMLVideoElement) => void; onRotate?: (degrees: number) => void };
function mediaProgress(media: HTMLMediaElement): MediaProgress {
  const duration = Number.isFinite(media.duration) ? Math.max(0, media.duration) : 0;
  const currentTime = Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0;
  return { currentTime: duration ? Math.min(currentTime, duration) : currentTime, duration };
}
function seekBy(media: HTMLMediaElement, seconds: number) {
  const { currentTime, duration } = mediaProgress(media);
  if (duration) media.currentTime = Math.max(0, Math.min(duration, currentTime + seconds));
}
export function createVideoPlayer(container: HTMLDivElement, url: string, notify: Notify, poster?: string, events?: PlaybackEvents, navigation?: () => Navigation | undefined, known?: { width: number; height: number }, initialRotation = 0) {
  // 网页全屏仍留在预览的对话框内，保留焦点锁和无障碍语义。
  Artplayer.FULLSCREEN_WEB_IN_BODY = false;
  // 不自动重连：播放失败直接交给预览界面显示原因与重试，避免画面上反复出现“重新连接”。
  Artplayer.RECONNECT_TIME_MAX = 0;
  const player = new Artplayer({ container, url, poster: poster ?? "", lang: "zh-cn", autoplay: false, theme: "#ffffff",
    setting: true, playbackRate: true, aspectRatio: true, subtitleOffset: true, fullscreen: true, fullscreenWeb: true, pip: true, miniProgressBar: true, fastForward: true,
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
  let currentUrl = url;
  // 进度条悬停预览：时长取播放器当前值，旋转随画面设置。
  const seekPreview = attachSeekPreview(container, () => currentUrl, () => rotation, () => Number.isFinite(player.video.duration) ? player.video.duration : 0);
  let ready = false, destroyed = false, subtitleUrl: string | null = null, version = 0;
  let saveThumbnail: ((video: HTMLVideoElement, rotation: number) => Promise<void>) | null = null, thumbnailBusy = false, sourceVersion = 0;
  const thumbnailState = () => {
    const control = container.querySelector<HTMLElement>(".art-control-thumbnail");
    if (!control) return;
    control.setAttribute("aria-disabled", String(thumbnailBusy || player.video.readyState < 2 || player.video.seeking));
    control.setAttribute("aria-busy", String(thumbnailBusy));
    control.setAttribute("aria-label", thumbnailBusy ? "正在保存封面" : "将当前画面设为封面");
  };
  // 旋转 90°／270° 时窗口按转过来的比例显示；回报给上层的仍是视频本身的尺寸（用于记录分辨率）。
  let rotation = normalizeRotation(initialRotation), lastSize: { width: number; height: number } | null = null;
  const applyRatio = () => {
    if (destroyed || !lastSize) return;
    const ratio = lastSize.width / lastSize.height;
    container.style.setProperty("--preview-video-ratio", String(rotation % 180 ? 1 / ratio : ratio));
  };
  const setRatio = (width: number, height: number, source: "stored" | "cover" | "video") => {
    if (!destroyed && width > 0 && height > 0) {
      lastSize = { width, height }; applyRatio();
      events?.onVideoSize?.(width, height, source);
    }
  };
  // 旋转作用在 <video> 上：四分之一圈时把它的宽高换成播放器的高宽再转，画面仍按 contain 完整显示，控制条与字幕不转。
  const frame = player.template.$player;
  const measure = () => {
    frame.style.setProperty("--art-frame-width", `${frame.clientWidth}px`);
    frame.style.setProperty("--art-frame-height", `${frame.clientHeight}px`);
  };
  const rotationItem = () => {
    const current = ROTATION_LABELS.find(([value]) => value === rotation) ?? ROTATION_LABELS[0];
    return { name: "rotation", html: "画面旋转", icon: GLYPHS.rotate, tooltip: current[1], width: 180,
      selector: ROTATION_LABELS.map(([value, label]) => ({ html: label, value, default: value === rotation })),
      onSelect: (option: { value?: number; html: string }) => { if (typeof option.value === "number") events?.onRotate?.(option.value); return option.html; } };
  };
  const applyRotation = () => {
    // 「画面比例」会在 <video> 上写内联宽高，与旋转叠加会压扁画面、四周留黑边：旋转时恢复默认比例。
    if (rotation && player.aspectRatio !== "default") player.aspectRatio = "default";
    frame.classList.toggle("is-rotated", rotation !== 0);
    frame.classList.toggle("is-rotated-quarter", rotation % 180 !== 0);
    frame.style.setProperty("--art-video-rotation", `${rotation}deg`);
    measure(); applyRatio();
    if (player.setting.find("rotation")) player.setting.update(rotationItem()); else player.setting.add(rotationItem());
  };
  applyRotation();
  // 旋转时又选了画面比例：按所选比例显示，取消旋转。
  player.on("aspectRatio", value => { if (value !== "default" && rotation) events?.onRotate?.(0); });
  // 已记录视频尺寸时直接按它打开，不再用封面比例过渡；没有记录时先用封面比例，元信息就绪后以实际视频尺寸为准。
  let cover: HTMLImageElement | null = null;
  const setCover = (src?: string, size?: { width: number; height: number }) => {
    if (cover) { cover.onload = null; cover.src = ""; }
    if (size) setRatio(size.width, size.height, "stored");
    cover = src && !size ? new Image() : null;
    const image = cover;
    if (image) { image.onload = () => { if (!player.video.videoWidth) setRatio(image.naturalWidth, image.naturalHeight, "cover"); }; image.src = src!; }
  };
  setCover(poster, known);
  let switching = Promise.resolve();
  const updateProgress = () => events?.onProgress?.(mediaProgress(player.video));
  const markReady = () => { setRatio(player.video.videoWidth, player.video.videoHeight, "video"); ready = true; notify("ready"); thumbnailState(); if (player.video.readyState >= 2) events?.onVideoFrame?.(player.video); };
  // iOS Safari 在用户点播放前不预加载画面，只会触发 loadedmetadata：读到时长即视为就绪，避免误报“加载较慢”。
  player.on("video:loadedmetadata", () => { markReady(); updateProgress(); });
  player.on("video:resize", () => setRatio(player.video.videoWidth, player.video.videoHeight, "video"));
  player.on("video:loadeddata", markReady);
  player.on("video:canplay", markReady);
  player.on("video:playing", markReady);
  player.on("video:waiting", () => notify(ready ? "buffering" : "loading"));
  player.on("video:pause", () => { if (ready) notify("ready"); });
  player.on("video:durationchange", () => { updateProgress(); fitControls(); });
  player.on("video:timeupdate", () => { updateProgress(); if (player.video.readyState >= 2) events?.onVideoFrame?.(player.video); });
  player.on("video:seeked", () => { updateProgress(); if (player.video.readyState >= 2) markReady(); });
  player.on("video:seeking", thumbnailState);
  player.on("video:ended", () => { markReady(); events?.onPlaying(false); events?.onEnded(); });
  player.on("video:error", () => notify("failed"));
  /** 控制条放不下时按优先级依次收起按钮：画中画、网页全屏、音量、时间、上一个／下一个（键盘 ← → 仍可切换）。
   * 窗口宽度、按钮数量（多文件时多出上一个、下一个与播放列表）和时间文字长度（超过一小时更宽）都会改变所需宽度，
   * 所以按实际布局测量，而不是只靠固定的宽度断点。 */
  const SQUEEZE = ["pip", "fullscreenWeb", "volume", "time", "previous next"];
  const fitControls = () => {
    if (destroyed) return;
    const bar = frame.querySelector<HTMLElement>(".art-controls");
    if (!bar) return;
    const overflowing = () => {
      const limit = bar.getBoundingClientRect().right + 1;
      return [...bar.querySelectorAll<HTMLElement>(".art-control")].some(node => node.offsetParent && node.getBoundingClientRect().right > limit);
    };
    SQUEEZE.forEach((_, index) => frame.classList.remove(`art-squeeze-${index + 1}`));
    for (let level = 1; level <= SQUEEZE.length && overflowing(); level++) frame.classList.add(`art-squeeze-${level}`);
  };
  // ArtPlayer 默认只监听浏览器窗口；弹窗拖动改变容器尺寸时也要更新比例与控件布局。
  const observer = new ResizeObserver(() => { measure(); player.emit("resize"); fitControls(); });
  observer.observe(container);
  // 原生全屏时放大的是播放器本身，容器尺寸不变，所以也要观察播放器。
  observer.observe(frame);
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
    control("previous", multiple ? { position: "left", index: 11, html: GLYPHS.previous, tooltip: "上一个（←）", click: () => navigation?.()?.onPrevious() } : null);
    control("next", multiple ? { position: "left", index: 12, html: GLYPHS.next, tooltip: "下一个（→）", click: () => navigation?.()?.onNext() } : null);
    control("playlist", multiple && nav?.onPlaylist ? { position: "right", index: 25, html: GLYPHS.list, tooltip: `播放列表 ${nav.index + 1}/${nav.count}（O）`,
      style: nav.playlistOpen ? { color: "var(--art-theme)" } : {}, click: () => navigation?.()?.onPlaylist?.() } : null);
    for (const name of ["previous", "next", "playlist"]) {
      const element = container.querySelector<HTMLElement>(`.art-control-${name}`);
      if (element) { element.tabIndex = 0; element.setAttribute("role", "button"); element.setAttribute("aria-label", name === "previous" ? "上一个" : name === "next" ? "下一个" : "播放列表"); element.setAttribute("aria-keyshortcuts", name === "previous" ? "ArrowLeft" : name === "next" ? "ArrowRight" : "O"); }
    }
    if (multiple && nav?.mode && nav.onMode) {
      const current = MODE_LABELS.find(([value]) => value === nav.mode) ?? MODE_LABELS[0];
      const item = { name: "mode", html: "播放模式", tooltip: current[1], width: 180,
        selector: MODE_LABELS.map(([value, label]) => ({ html: label, value, default: value === current[0] })),
        onSelect: (option: { value?: Mode; html: string }) => { if (option.value) navigation?.()?.onMode?.(option.value); return option.html; } };
      if (player.setting.find("mode")) player.setting.update(item); else player.setting.add(item);
    } else if (player.setting.find("mode")) player.setting.remove("mode");
    fitControls();
  };
  return {
    refreshNavigation,
    /** 当前已解码画面由上层保存；按钮也出现在播放器全屏控制条中。 */
    setThumbnailAction: (save: ((video: HTMLVideoElement, rotation: number) => Promise<void>) | null) => {
      saveThumbnail = save;
      if (destroyed) return;
      if (!save) { if (container.querySelector(".art-control-thumbnail")) player.controls.remove("thumbnail"); return; }
      const click = async () => {
        if (thumbnailBusy || !saveThumbnail || player.video.readyState < 2 || player.video.seeking) return;
        const current = sourceVersion;
        thumbnailBusy = true;
        const control = container.querySelector<HTMLElement>(".art-control-thumbnail");
        if (control) control.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
        thumbnailState();
        try {
          await saveThumbnail(player.video, rotation);
          if (!destroyed && current === sourceVersion) player.notice.show = "已将当前画面设为封面";
        } catch (reason) {
          if (!destroyed && current === sourceVersion) player.notice.show = reason instanceof Error ? reason.message : "封面保存失败，请重试";
        } finally {
          thumbnailBusy = false;
          if (!destroyed) {
            const currentControl = container.querySelector<HTMLElement>(".art-control-thumbnail");
            if (currentControl) currentControl.innerHTML = GLYPHS.thumbnail;
            thumbnailState();
          }
        }
      };
      player.controls.update({ name: "thumbnail", position: "right", index: 24, html: GLYPHS.thumbnail,
        tooltip: "将当前画面设为封面", click: () => { void click(); } });
      const control = container.querySelector<HTMLElement>(".art-control-thumbnail");
      if (control) {
        control.tabIndex = 0; control.setAttribute("role", "button");
        control.onkeydown = event => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat) void click();
          }
        };
      }
      thumbnailState();
    },
    /** 原生媒体元素：预览界面据此估算缓冲速度。 */
    media: () => player.video,
    play: () => player.play(),
    pause: () => player.pause(),
    isPlaying: () => !player.video.paused,
    seek: (time: number) => { player.video.currentTime = time; updateProgress(); },
    seekBy: (seconds: number) => { seekBy(player.video, seconds); updateProgress(); },
    /** 由上层按文件记住的角度设置；换文件时上层会再次调用，引擎自己不重置。 */
    setRotation: (degrees: number) => {
      const next = normalizeRotation(degrees);
      if (destroyed || next === rotation) return;
      rotation = next; applyRotation(); player.emit("resize");
    },
    adjustVolume: (delta: number) => { player.volume = Math.max(0, Math.min(1, player.video.volume + delta)); },
    toggleMute: () => { player.muted = !player.muted; player.notice.show = player.muted ? "已静音" : "取消静音"; },
    /** 调整播放速度（0.25×–3×），返回新速度；ArtPlayer 的设置菜单与这里共用同一个值。 */
    adjustRate: (delta: number) => {
      const rate = Math.round(Math.max(0.25, Math.min(3, player.playbackRate + delta)) * 100) / 100;
      player.playbackRate = rate; player.notice.show = `播放速度 ${rate}×`;
      return rate;
    },
    /** 字幕提前（负）或延后（正），设置菜单里的「字幕偏移」与这里共用同一个值；换片时归零。 */
    shiftCaptions: (seconds: number) => {
      const offset = Math.round(Math.max(-10, Math.min(10, player.subtitleOffset + seconds)) * 10) / 10;
      player.subtitleOffset = offset;
      player.notice.show = offset ? `字幕${offset > 0 ? "延后" : "提前"} ${Math.abs(offset)} 秒` : "字幕时间已还原";
      return offset;
    },
    /** 暂停时逐帧前进或后退（按 30 帧／秒估算）。 */
    step: (direction: 1 | -1) => {
      if (!player.video.paused) player.pause();
      seekBy(player.video, direction / 30); updateProgress();
    },
    setSource: (nextUrl: string, _name: string, nextCover?: string, nextSize?: { width: number; height: number }) => {
      sourceVersion++;
      currentUrl = nextUrl; seekPreview.reset();
      player.pause(); ready = false; notify("loading");
      container.style.removeProperty("--preview-video-ratio"); lastSize = null;
      player.poster = nextCover ?? ""; player.url = nextUrl; player.subtitleOffset = 0;
      // 换源后立即重置原生媒体和控件，不能等新文件的 timeupdate 来清掉旧时间与缓冲条。
      player.video.load(); player.currentTime = 0;
      thumbnailState();
      player.emit("setBar", "played", 0); player.emit("setBar", "loaded", 0);
      const time = container.querySelector(".art-control-time");
      if (time) time.textContent = "00:00 / 00:00";
      events?.onPlaying(false); events?.onProgress?.({ currentTime: 0, duration: 0 });
      setCover(nextCover, nextSize);
    },
    /** 字幕选择放在播放器的设置菜单里；没有字幕、也没有附加操作（如「在线查找字幕」）时不显示这一项。
     *  附加操作排在最后，点击后只执行操作，不改变当前选中的字幕。 */
    setSubtitleMenu: function setSubtitleMenu(options: { value: string; label: string }[], selected: string, onSelect: (value: string) => void, action?: { label: string; run: () => void }) {
      if (destroyed) return;
      if (!options.length && !action) { if (player.setting.find("subtitle")) player.setting.remove("subtitle"); return; }
      const ACTION = "\u0000action";
      const choices = [...(options.length ? [{ value: "", label: "关闭" }, ...options] : []), ...(action ? [{ value: ACTION, label: action.label }] : [])];
      const current = choices.find(choice => choice.value === selected) ?? choices[0];
      const item = {
        name: "subtitle", html: "字幕", tooltip: options.length ? current.label : "没有字幕", width: 220,
        selector: choices.map(choice => ({ html: choice.label, value: choice.value, default: choice.value === current.value && choice.value !== ACTION })),
        onSelect: (option: { value?: string; html: string }) => {
          if (option.value === ACTION) {
            action?.run();
            // 恢复原来的选中项与提示，附加操作不是一条字幕。
            window.setTimeout(() => setSubtitleMenu(options, selected, onSelect, action), 0);
            return options.length ? current.label : "没有字幕";
          }
          onSelect(String(option.value ?? "")); return option.html;
        },
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
      destroyed = true; version++; seekPreview.destroy(); observer.disconnect(); document.removeEventListener("keydown", exitWebScreen, true);
      if (cover) { cover.onload = null; cover.src = ""; }
      player.destroy(); container.style.removeProperty("--preview-video-ratio");
      if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
    },
  };
}

/** 进度条悬停预览：用一个隐藏的第二个 video 定位到悬停时间并截一帧显示在进度条上方。
 *  只在第一次悬停时创建（preload=metadata，按 Range 读取少量数据，同样经过本机缓存）；
 *  上一次定位还没完成时只记下最新时间，不堆积请求。触屏设备没有悬停，不启用。 */
function attachSeekPreview(container: HTMLElement, getUrl: () => string, getRotation: () => number, getDuration: () => number) {
  const bar = container.querySelector<HTMLElement>(".art-control-progress");
  const noop = { reset: () => {}, destroy: () => {} };
  if (!bar || !window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return noop;
  const box = document.createElement("div");
  box.className = "art-seek-preview"; box.hidden = true; box.setAttribute("aria-hidden", "true");
  const canvas = document.createElement("canvas");
  box.append(canvas);
  bar.append(box);
  let probe: HTMLVideoElement | null = null, pending: number | null = null, busy = false, broken = false;
  const WIDTH = 176;
  const draw = () => {
    if (!probe || !probe.videoWidth) return;
    const rotation = getRotation(), quarter = rotation % 180 !== 0;
    const ratio = probe.videoHeight / probe.videoWidth, height = Math.round(WIDTH * (quarter ? 1 / ratio : ratio));
    canvas.width = WIDTH * 2; canvas.height = Math.min(height, WIDTH * 2) * 2;
    const g = canvas.getContext("2d");
    if (!g) return;
    g.save(); g.translate(canvas.width / 2, canvas.height / 2); g.rotate(rotation * Math.PI / 180);
    const w = quarter ? canvas.height : canvas.width, h = quarter ? canvas.width : canvas.height;
    g.drawImage(probe, -w / 2, -h / 2, w, h); g.restore();
    box.classList.add("is-ready");
  };
  const seek = (time: number) => {
    if (!probe) return;
    if (busy) { pending = time; return; }
    busy = true; probe.currentTime = time;
  };
  const ensure = () => {
    if (probe || broken) return;
    probe = document.createElement("video");
    probe.muted = true; probe.preload = "metadata"; probe.playsInline = true; probe.src = getUrl();
    probe.addEventListener("seeked", () => { busy = false; draw(); if (pending !== null) { const next = pending; pending = null; seek(next); } });
    probe.addEventListener("error", () => { broken = true; box.hidden = true; });
  };
  const move = (event: PointerEvent) => {
    const duration = getDuration();
    if (!duration || broken) return;
    ensure();
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    box.hidden = false;
    const half = WIDTH / 2;
    box.style.left = `${Math.min(rect.width - half, Math.max(half, ratio * rect.width))}px`;
    seek(ratio * duration);
  };
  const leave = () => { box.hidden = true; pending = null; };
  bar.addEventListener("pointermove", move);
  bar.addEventListener("pointerleave", leave);
  return {
    reset: () => { leave(); box.classList.remove("is-ready"); broken = false; busy = false; if (probe) { probe.removeAttribute("src"); probe.load(); probe = null; } },
    destroy: () => { bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerleave", leave); if (probe) { probe.removeAttribute("src"); probe.load(); } box.remove(); },
  };
}
