/** 续播：按内容版本记住视频与长音频的播放位置。私密文件只记在本页内存里，不写入浏览器存储（与电子书阅读位置一致）。 */

const KEY = "tessera:media-position", LIMIT = 300;
/** 视频至少 2 分钟、音频至少 10 分钟才记位置：短视频与普通歌曲每次从头播放更自然。 */
const MIN_VIDEO = 120, MIN_AUDIO = 600;
/** 播放不到 15 秒不记；离结尾不到 20 秒视为看完，清除记录。 */
const HEAD = 15, TAIL = 20;

type Position = { t: number; d: number; at: number };
const memory = new Map<string, Position>();

function saved(): Record<string, Position> {
  try { const value = JSON.parse(localStorage.getItem(KEY) ?? "{}"); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}

export function resumeEligible(kind: "audio" | "video", duration: number) {
  return Number.isFinite(duration) && duration >= (kind === "video" ? MIN_VIDEO : MIN_AUDIO);
}

/** 可以继续播放的位置（秒）；没有记录、已接近结尾或时长变了（不是同一内容）时返回 null。 */
export function readResume(key: string, remember: boolean, duration: number): number | null {
  const value = remember ? saved()[key] : memory.get(key);
  if (!value || typeof value.t !== "number" || Math.abs(value.d - duration) > 2) return null;
  return value.t > HEAD && value.t < duration - TAIL ? value.t : null;
}

export function writeResume(key: string, remember: boolean, time: number, duration: number) {
  const keep = time > HEAD && time < duration - TAIL;
  if (!remember) { if (keep) memory.set(key, { t: time, d: duration, at: Date.now() }); else memory.delete(key); return; }
  const entries = Object.entries(saved()).filter(([item]) => item !== key);
  if (keep) entries.push([key, { t: Math.round(time), d: Math.round(duration), at: Date.now() }]);
  try {
    if (entries.length) localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries.slice(-LIMIT))));
    else localStorage.removeItem(KEY);
  } catch { /* 存储不可用时不记位置 */ }
}

export function clockLabel(seconds: number) {
  const total = Math.floor(seconds), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
