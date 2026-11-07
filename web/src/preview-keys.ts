/** 音视频预览的播放快捷键（files.tsx 的 PreviewModal 调用）：只依赖播放器控制接口，便于单独测试。
 * 空格／K、J／L、方向键、O、R 等与窗口相关的按键仍由 PreviewModal 处理。 */

/** 播放器为快捷键提供的控制（preview-media.tsx 的 PlaybackControls 子集）。 */
export type PlayerKeys = {
  seek: (time: number) => void;
  toggleMute?: () => void; adjustRate?: (delta: number) => number; step?: (direction: 1 | -1) => void;
  toggleCaptions?: () => void; shiftCaptions?: (seconds: number) => number; duration?: () => number;
};
type Key = { key: string; shiftKey: boolean; repeat: boolean };
/** 需要页面显示的反馈（音乐没有播放器内的提示层，由 PreviewModal 用状态提示显示；视频由播放器自己提示）。 */
export type KeyFeedback = { status: "playback-rate" | "lyric-offset"; message: string } | null;

export const RATE_STEP = 0.25;
export const CAPTION_STEP = 0.5;

/** 处理一个按键；返回 null 表示不是播放快捷键（交给其他处理），否则返回反馈（没有反馈时为 { status: null }）。 */
export function playerShortcut(event: Key, kind: "audio" | "video", player: PlayerKeys): { feedback: KeyFeedback } | null {
  const key = event.key.toLowerCase();
  // 调速：Shift+< / Shift+>，按住会连续调整。
  if (key === "<" || key === ">") {
    if (!player.adjustRate) return null;
    const rate = player.adjustRate(key === ">" ? RATE_STEP : -RATE_STEP);
    return { feedback: kind === "audio" ? { status: "playback-rate", message: `播放速度 ${rate}×` } : null };
  }
  if (event.shiftKey) return null;
  if (key === "m" || key === "c") {
    if (!event.repeat) (key === "m" ? player.toggleMute : player.toggleCaptions)?.();
    return { feedback: null };
  }
  if (key === "g" || key === "h") {
    const offset = player.shiftCaptions?.(key === "h" ? CAPTION_STEP : -CAPTION_STEP);
    if (kind !== "audio" || offset === undefined) return { feedback: null };
    return { feedback: { status: "lyric-offset", message: offset ? `歌词${offset > 0 ? "延后" : "提前"} ${Math.abs(offset)} 秒` : "歌词时间已还原" } };
  }
  if (kind === "video" && (key === "," || key === ".")) {
    player.step?.(key === "." ? 1 : -1);
    return { feedback: null };
  }
  if (/^[0-9]$/.test(key)) {
    const duration = player.duration?.() ?? 0;
    if (duration) player.seek(duration * Number(key) / 10);
    return { feedback: null };
  }
  return null;
}
