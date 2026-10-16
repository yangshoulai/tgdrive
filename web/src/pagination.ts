import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";
import type { ListPage, PublicFolderPage } from "./api";

/**
 * 目录连续浏览：自动读完有界游标接口，切换位置时取消旧请求。
 * 首次读取按第 1、2、4、8… 页逐步展示，总渲染量与目录大小成线性；refresh 保留原列表与滚动位置，
 * 读完后整体替换，并会中断仍在进行的读取，保证修改后看到的是最新结果。maxPages 用于搜索等需要上限的场景；
 * reconcile 在刷新替换时复用未变化的条目对象，避免整表重绘；refresh(true) 为后台刷新，不显示刷新中状态。
 */
export function useDirectory<T extends { next_cursor: string | number | null }>(
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<T>, merge: (previous: T, next: T) => T,
  maxPages = Infinity, reconcile?: (previous: T, next: T) => T,
) {
  const [page, setPage] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const shown = useRef(false);
  const load = useCallback(async (keep = false, quiet = false): Promise<string | null> => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const progressive = !keep;
    if (keep && !quiet) setRefreshing(true);
    else { shown.current = false; setPage(null); setLoading(true); setLoadingMore(false); setRefreshing(false); setTruncated(false); setError(""); }
    try {
      let cursor: string | null = null, result: T | null = null, pages = 0;
      const seen = new Set<string>();
      do {
        const next = await fetchPage(cursor, controller.signal);
        if (controller.signal.aborted) return null;
        result = result === null ? next : merge(result, next);
        pages += 1;
        cursor = next.next_cursor === null ? null : String(next.next_cursor);
        if (cursor !== null && seen.has(cursor)) throw new Error("目录读取未能继续，请刷新后重试");
        if (cursor !== null) seen.add(cursor);
        if (cursor !== null && pages >= maxPages) break;
        if (progressive && cursor !== null && (pages & (pages - 1)) === 0) {
          shown.current = true; setPage(result); setLoading(false); setLoadingMore(true);
        }
      } while (cursor !== null);
      shown.current = true;
      const final = result;
      setPage(current => keep && current && final && reconcile ? reconcile(current, final) : final);
      setTruncated(cursor !== null); setError("");
      return null;
    } catch (reason) {
      if (controller.signal.aborted) return null;
      const message = errorMessage(reason, "目录加载失败，请重试");
      if (!shown.current) setError(message);
      return message;
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false); setLoadingMore(false); setRefreshing(false);
      }
    }
  }, [fetchPage, merge, maxPages, reconcile]);
  const reload = useCallback(() => load(), [load]);
  const refresh = useCallback((quiet = false) => load(true, quiet), [load]);
  useEffect(() => { void reload(); return () => { request.current?.abort(); request.current = null; }; }, [reload]);
  return { page, setPage, loading, loadingMore, refreshing, truncated, error, reload, refresh };
}

/**
 * 长列表分批挂载：数据已全部读入，界面先渲染 step 项，底部哨兵接近视口时再追加，避免一次创建数千行卡住主线程。
 * 排序、全选和快捷键仍作用于完整数据；reveal(index) 让键盘焦点或助手选中的远处项目先被渲染出来。
 */
export function useRenderLimit<T>(items: T[], reset: unknown, step = 400) {
  const [limit, setLimit] = useState(step);
  useEffect(() => { setLimit(step); }, [reset, step]);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const more = items.length > limit;
  useEffect(() => {
    const node = sentinel.current;
    if (!more || !node) return;
    // limit 变化时重建观察器：哨兵仍在视口附近时会立即再触发一次，快速滚动也能接上。
    const observer = new IntersectionObserver(records => {
      if (records.some(record => record.isIntersecting)) setLimit(value => value + step);
    }, { rootMargin: "1600px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, limit, step]);
  const reveal = useCallback((index: number) => setLimit(value => index < value ? value : index + step), [step]);
  return { visible: more ? items.slice(0, limit) : items, more, sentinel, reveal };
}

export const mergeFilePages = (a: ListPage, b: ListPage): ListPage => ({
  ...b, objects: [...a.objects, ...b.objects], common_prefixes: [...new Set([...a.common_prefixes, ...b.common_prefixes])],
  public_folders: { ...a.public_folders, ...b.public_folders }, folder_sizes: { ...a.folder_sizes, ...b.folder_sizes },
});
/** 刷新后复用内容未变的文件对象：行、缩略图与补生成队列不会因为对象换新而重新渲染或重启。 */
export const reconcileFilePage = (previous: ListPage, next: ListPage): ListPage => {
  const known = new Map(previous.objects.map(item => [item.key, item]));
  const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);
  const objects = next.objects.map(item => { const old = known.get(item.key); return old && same(old, item) ? old : item; });
  const changed = objects.length !== previous.objects.length || objects.some((item, index) => item !== previous.objects[index]);
  if (!changed && same({ ...previous, objects: [] }, { ...next, objects: [] })) return previous;
  return {
    ...next, objects: changed ? objects : previous.objects,
    common_prefixes: same(previous.common_prefixes, next.common_prefixes) ? previous.common_prefixes : next.common_prefixes,
    public_folders: same(previous.public_folders ?? {}, next.public_folders ?? {}) ? previous.public_folders : next.public_folders,
    folder_sizes: same(previous.folder_sizes ?? {}, next.folder_sizes ?? {}) ? previous.folder_sizes : next.folder_sizes,
  };
};
export const mergePublicFolderPages = (a: PublicFolderPage, b: PublicFolderPage): PublicFolderPage => ({
  ...b, files: [...a.files, ...b.files], folders: [...a.folders, ...b.folders],
});
export const mergeObjectPages = <T extends { objects: unknown[]; folder_sizes?: Record<string, number>; folder_previews?: Record<string, unknown[]> }>(a: T, b: T): T => ({
  ...b, objects: [...a.objects, ...b.objects],
  folder_sizes: { ...a.folder_sizes, ...b.folder_sizes }, folder_previews: { ...a.folder_previews, ...b.folder_previews },
});
export const mergeTrashPages = <T extends { items: unknown[] }>(a: T, b: T): T => ({ ...b, items: [...a.items, ...b.items] });
export const mergeFolderPages = <T extends { folders: string[] }>(a: T, b: T): T => ({ ...b, folders: [...new Set([...a.folders, ...b.folders])] });

export const FILE_PAGE_SIZES = [50, 100, 200];
const FILE_PAGE_SIZE_KEY = "tessera-file-page-size";
export function useFilePageSize() {
  const [pageSize, setPageSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(FILE_PAGE_SIZE_KEY));
      return FILE_PAGE_SIZES.includes(saved) ? saved : 100;
    } catch { return 100; }
  });
  const changePageSize = useCallback((size: number) => {
    if (!FILE_PAGE_SIZES.includes(size)) return;
    setPageSize(size);
    try { localStorage.setItem(FILE_PAGE_SIZE_KEY, String(size)); } catch { /* 存储不可用时仍可切换。 */ }
  }, []);
  return { pageSize, changePageSize };
}

/** 只保留当前页与游标历史；旧请求不能覆盖切换目录或筛选后的结果。 */
export function useCursorPage<T extends { next_cursor: string | number | null }>(fetchPage: (cursor: string | null) => Promise<T>) {
  const [page, setPage] = useState<T | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([null]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);
  const pending = useRef(false);
  const historyRef = useRef(history);
  historyRef.current = history;
  const load = useCallback(async (cursors: (string | null)[], reset = false) => {
    if (pending.current && !reset) return;
    const id = ++requestId.current;
    pending.current = true;
    setLoading(true); setError("");
    if (reset) { setPage(null); setHistory([null]); }
    try {
      const result = await fetchPage(cursors[cursors.length - 1]);
      if (id === requestId.current) { setPage(result); setHistory(cursors); }
    } catch (reason) {
      if (id === requestId.current) setError(errorMessage(reason, "加载失败，请稍后重试"));
    } finally {
      if (id === requestId.current) { pending.current = false; setLoading(false); }
    }
  }, [fetchPage]);
  const reload = useCallback(() => load([null], true), [load]);
  /** 原地刷新当前页：保留页码和已显示的列表，不显示骨架屏；失败时保留原列表并返回错误信息。 */
  const refresh = useCallback(async (): Promise<string | null> => {
    if (pending.current) return null;
    const id = ++requestId.current;
    const cursors = historyRef.current;
    pending.current = true;
    setRefreshing(true);
    try {
      const result = await fetchPage(cursors[cursors.length - 1]);
      if (id === requestId.current) { setPage(result); setError(""); }
      return null;
    } catch (reason) {
      return errorMessage(reason, "刷新失败，请稍后重试");
    } finally {
      if (id === requestId.current) { pending.current = false; setRefreshing(false); }
    }
  }, [fetchPage]);
  useEffect(() => { void reload(); return () => { requestId.current++; pending.current = false; }; }, [reload]);
  return {
    page, setPage, loading, error, reload, refresh, refreshing,
    number: history.length,
    hasPrevious: history.length > 1,
    hasNext: page?.next_cursor != null,
    previous: () => { if (history.length > 1) void load(history.slice(0, -1)); },
    next: () => { if (page?.next_cursor != null) void load([...history, String(page.next_cursor)]); },
  };
}
