/** 等待封面：列表里有缺封面的图片、视频、音频及近期书籍时，只查询这些文件的封面状态（POST /thumbnail/status，最多 200 个），
 * 不重读整个目录。间隔 10 秒起逐次加倍到 5 分钟，页面隐藏时跳过，最长等 1 小时。 */
import { useEffect, useMemo } from "react";
import * as api from "../api";
import { bookCoverSource, thumbnailSource } from "../thumbnails";

const FIRST_DELAY = 10_000, MAX_DELAY = 300_000, GIVE_UP = 3_600_000, BATCH = 200;

/** files 变化时重新挑出缺封面的文件；拿到结果原地更新。文件已被删除或覆盖（版本不同）时调用 onStale（页面后台刷新）。 */
export function useThumbnailPolling<T extends api.FileItem>(files: T[], enabled: boolean, setFiles: (update: (files: T[]) => T[]) => void, onStale: () => void) {
  const waiting = useMemo(() => files
    .filter(item => !item.thumbnails?.length && item.thumbnail_status !== "unavailable" && (thumbnailSource(item.key, item.content_type, item.size)
      || bookCoverSource(item.key, item.content_type) && Date.now() - item.modified_at * 1000 < GIVE_UP))
    .sort((a, b) => b.modified_at - a.modified_at).slice(0, BATCH), [files]);
  const waitingKey = waiting.map(item => `${item.key}\n${item.etag}`).join("\n");
  useEffect(() => {
    if (!waiting.length || !enabled) return;
    let delay = FIRST_DELAY, timer = 0, stopped = false;
    const controller = new AbortController(), started = Date.now(), current = waiting;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const { files: states } = await api.thumbnailStatus(current.map(item => item.key), controller.signal);
          if (stopped) return;
          if (current.some(item => !states[item.key] || states[item.key].etag !== item.etag)) onStale();
          const settled = new Map(Object.entries(states).filter(([, state]) => state.thumbnails?.length || state.thumbnail_status === "unavailable"));
          if (settled.size) setFiles(list => list.map(item => {
            const state = settled.get(item.key);
            return state && state.etag === item.etag ? { ...item, ...state } : item;
          }));
        } catch { if (stopped) return; }
      }
      if (stopped || Date.now() - started > GIVE_UP) return;
      delay = Math.min(delay * 2, MAX_DELAY);
      timer = window.setTimeout(() => void tick(), delay);
    };
    timer = window.setTimeout(() => void tick(), delay);
    return () => { stopped = true; window.clearTimeout(timer); controller.abort(); };
    // 只在等待的文件集合或可用状态变化时重新开始；回调用最新的引用即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey, enabled]);
}
