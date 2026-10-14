import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";

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
