import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { downloadTaskFolder, isActiveDownload } from "./downloads";

const PREVIEW_LIMIT = 100;

/** 托盘只轮询有界的活动预览，总数取服务端聚合；完整管理窗口独立使用键集分页。 */
export function useDownloadActivity(enabled: boolean, revision: number, onCompleted: () => void) {
  const [count, setCount] = useState(0);
  const [tick, setTick] = useState(0);
  const tracked = useRef(new Map<number, api.DownloadTask>());
  const completed = useRef(onCompleted); completed.current = onCompleted;
  useEffect(() => {
    const refresh = () => setTick(value => value + 1);
    const visible = () => { if (!document.hidden) refresh(); };
    window.addEventListener("tessera:downloads-changed", refresh);
    window.addEventListener("tessera:private-locked", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("tessera:downloads-changed", refresh);
      window.removeEventListener("tessera:private-locked", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  useEffect(() => {
    if (!enabled) { setCount(0); tracked.current.clear(); return; }
    const controller = new AbortController();
    let timer: number | undefined;
    async function read() {
      try {
        const [recent, running] = await Promise.all([
          api.listDownloads(null, "active", controller.signal, "", { limit: PREVIEW_LIMIT }),
          api.listDownloads(null, "running", controller.signal, "", { limit: PREVIEW_LIMIT }),
        ]);
        const seen = new Map([...recent.tasks, ...running.tasks].map(task => [task.id, task]));
        const missing = [...tracked.current.keys()].filter(id => !seen.has(id));
        for (let start = 0; start < missing.length; start += PREVIEW_LIMIT) {
          const result = await api.listDownloads(null, "", controller.signal, "", { ids: missing.slice(start, start + PREVIEW_LIMIT) });
          for (const task of result.tasks) seen.set(task.id, task);
        }
        if (controller.signal.aborted) return;
        const folders = new Set<string>();
        for (const task of seen.values()) if (task.status === "completed" && tracked.current.has(task.id)) folders.add(downloadTaskFolder(task));
        tracked.current = new Map([...recent.tasks, ...running.tasks].filter(isActiveDownload).map(task => [task.id, task]));
        setCount(recent.total);
        if (folders.size) {
          completed.current();
          window.dispatchEvent(new CustomEvent("tessera:downloads-completed", { detail: { folders: [...folders] } }));
        }
        timer = window.setTimeout(read, recent.total ? 3000 : 30000);
      } catch {
        if (!controller.signal.aborted) timer = window.setTimeout(read, 15000);
      }
    }
    void read();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [enabled, revision, tick]);
  return count;
}
