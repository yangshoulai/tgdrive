import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";

/** 只保留当前页与游标历史；旧请求不能覆盖切换目录或筛选后的结果。 */
export function useCursorPage<T extends { next_cursor: string | number | null }>(fetchPage: (cursor: string | null) => Promise<T>) {
  const [page, setPage] = useState<T | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([null]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const pending = useRef(false);
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
  useEffect(() => { void reload(); return () => { requestId.current++; pending.current = false; }; }, [reload]);
  return {
    page, setPage, loading, error, reload,
    number: history.length,
    hasPrevious: history.length > 1,
    hasNext: page?.next_cursor != null,
    previous: () => { if (history.length > 1) void load(history.slice(0, -1)); },
    next: () => { if (page?.next_cursor != null) void load([...history, String(page.next_cursor)]); },
  };
}
