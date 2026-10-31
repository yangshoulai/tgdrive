/** 任务中心三个页面（上传、离线下载、本机缓存）共用的结构：概览卡片、筛选工具栏、批量操作栏与分页。 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import * as api from "../api";
import { Checkbox, Icon, IconButton, Pagination, SearchInput, Segmented, type IconName } from "../ui";

export type TaskFilter = "" | "active" | "paused" | "done" | "error";
const PAGE_SIZE = 50;

/** 本机队列只渲染当前页；选择限定当前筛选页，进度刷新不会打断勾选。 */
export function useTaskList<T extends { id: string }>(items: T[], describe: (item: T) => string, group: (item: T) => TaskFilter) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("");
  const [pageIndex, setPageIndex] = useState(0);
  const [selected, setSelected] = useState(new Set<string>());
  const counts = useMemo(() => {
    const value: Record<TaskFilter, number> = { "": items.length, active: 0, paused: 0, done: 0, error: 0 };
    for (const item of items) value[group(item)]++;
    return value;
  }, [items, group]);
  const filtered = useMemo(() => items.filter(item => (!filter || group(item) === filter)
    && describe(item).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [items, describe, group, search, filter]);
  const index = Math.min(pageIndex, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const visible = filtered.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE);
  const signature = visible.map(item => item.id).join(",");
  useEffect(() => { setSelected(current => {
    const ids = new Set(visible.map(item => item.id));
    return [...current].every(id => ids.has(id)) ? current : new Set([...current].filter(id => ids.has(id)));
  }); }, [signature]);
  const reset = () => { setPageIndex(0); setSelected(new Set()); };
  return {
    search, filter, filtered, visible, selected, counts,
    chosen: visible.filter(item => selected.has(item.id)),
    setSearch: (value: string) => { reset(); setSearch(value); },
    setFilter: (value: TaskFilter) => { reset(); setFilter(value); },
    clearFilters: () => { reset(); setSearch(""); setFilter(""); },
    clearSelection: () => setSelected(new Set()),
    toggle: (id: string, checked: boolean) => setSelected(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; }),
    allSelected: Boolean(visible.length) && visible.every(item => selected.has(item.id)),
    selectPage: (checked: boolean) => setSelected(checked ? new Set(visible.map(item => item.id)) : new Set()),
    pagination: { number: index + 1, hasPrevious: index > 0, hasNext: (index + 1) * PAGE_SIZE < filtered.length, loading: false,
      previous: () => { setSelected(new Set()); setPageIndex(index - 1); }, next: () => { setSelected(new Set()); setPageIndex(index + 1); }, total: filtered.length, pageSize: PAGE_SIZE },
  };
}

export type TaskListState = ReturnType<typeof useTaskList>;

export type TaskStat = { key: string; label: string; value: ReactNode; detail?: ReactNode; icon: IconName; tone?: "accent" | "success" | "danger" | "warning" | "neutral"; live?: boolean; selected?: boolean; onSelect?: () => void };

/** 页面顶部的概览卡片；可点击的卡片切换到对应的状态筛选。live 表示有任务正在进行（图标呼吸提示）。 */
export function TaskStats({ items, progress, label }: { items: TaskStat[]; progress?: { percent: number | null; label: string } | null; label: string }) {
  return <section className="task-stats" aria-label={label}>
    <div className={`task-stats-grid${items.length >= 4 ? " is-wide" : ""}`} style={{ "--stat-count": items.length } as CSSProperties}>{items.map(item => {
      const body = <>
        <span className={`task-stat-icon is-${item.tone ?? "neutral"}${item.live ? " is-live" : ""}`} aria-hidden="true"><Icon name={item.icon} size={18} /></span>
        <span className="task-stat-copy"><span className="task-stat-label">{item.label}</span><strong className="task-stat-value">{item.value}</strong>
          {item.detail !== undefined && <small className="task-stat-detail">{item.detail}</small>}</span>
      </>;
      return item.onSelect
        ? <button type="button" key={item.key} className={`task-stat is-${item.tone ?? "neutral"}${item.selected ? " is-selected" : ""}`} aria-pressed={item.selected} onClick={item.onSelect}>{body}</button>
        : <div key={item.key} className={`task-stat is-${item.tone ?? "neutral"}`}>{body}</div>;
    })}</div>
    {progress && <div className={`task-stats-progress${progress.percent === null ? " is-indeterminate" : ""}`} role="progressbar" aria-label={progress.label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent === null ? undefined : Math.round(progress.percent)}>
      <span style={progress.percent === null ? undefined : { width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
    </div>}
  </section>;
}

export const FILTER_LABELS: Record<TaskFilter, string> = { "": "全部", active: "进行中", paused: "已暂停", done: "已完成", error: "失败" };

/** 本机队列（上传、缓存）的工具栏：搜索、带数量的状态筛选与清理菜单；有勾选时原位换成批量操作栏，高度不变。 */
export function TaskControls({ list, noun, actions, menu, pausedLabel = "已暂停" }: { list: TaskListState; noun: string; actions: ReactNode; menu?: ReactNode; pausedLabel?: string }) {
  const labels = { ...FILTER_LABELS, paused: pausedLabel };
  return <>
    <div className="toolbar task-search"><SearchInput value={list.search} onChange={list.setSearch} placeholder={`搜索${noun}的文件名或位置`} label={`搜索${noun}任务`} /></div>
    <div className="task-controls">
      {list.chosen.length > 0 && <div className="toolbar selection-bar task-selection" role="toolbar" aria-label={`${noun}批量操作`}>
        <Checkbox checked={list.allSelected} indeterminate={!list.allSelected} label={`选择本页全部${noun}任务`} onChange={list.selectPage} />
        <span className="selection-count"><span className="task-selection-prefix">已选择 </span>{list.chosen.length} 项</span>
        <div className="toolbar-actions">{actions}<IconButton icon="x" label="取消选择" size="sm" onClick={list.clearSelection} /></div>
      </div>}
      <div className={`task-toolbar${list.chosen.length ? " is-selecting" : ""}`} aria-hidden={list.chosen.length > 0}>
        <Segmented label={`${noun}状态`} showLabels value={list.filter} onChange={list.setFilter}
          options={(["", "active", "paused", "done", "error"] as TaskFilter[]).map(value => ({ value, label: labels[value], count: list.counts[value] || undefined }))} />
        <span className="task-toolbar-meta"><span className="muted">{list.filtered.length.toLocaleString("zh-CN")} 个任务</span>{menu}</span>
      </div>
    </div>
  </>;
}

export function TaskListFooter({ list }: { list: TaskListState }) {
  return list.pagination.total > PAGE_SIZE ? <footer className="list-footer task-footer"><Pagination {...list.pagination} /></footer> : null;
}

/** 按 1 秒采样估算每个任务的传输速度（指数平滑），只在有进行中的任务时计时。 */
export function useTransferRates(samples: [string, number][]) {
  const latest = useRef(samples); latest.current = samples;
  const previous = useRef(new Map<string, { bytes: number; at: number; rate: number }>());
  const [rates, setRates] = useState(new Map<string, number>());
  const active = samples.length > 0;
  useEffect(() => {
    if (!active) { previous.current.clear(); setRates(new Map()); return; }
    const timer = window.setInterval(() => {
      const now = performance.now(), next = new Map<string, { bytes: number; at: number; rate: number }>();
      for (const [id, bytes] of latest.current) {
        const before = previous.current.get(id);
        const instant = before && now > before.at ? Math.max(0, bytes - before.bytes) / ((now - before.at) / 1000) : 0;
        next.set(id, { bytes, at: now, rate: before ? before.rate ? before.rate * 0.6 + instant * 0.4 : instant : 0 });
      }
      previous.current = next;
      setRates(new Map([...next].map(([id, value]) => [id, value.rate])));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return rates;
}

/** 剩余时间的简短说法。 */
export const remainingText = (seconds: number) => seconds >= 3600 ? `约剩 ${Math.ceil(seconds / 3600)} 小时` : seconds >= 60 ? `约剩 ${Math.ceil(seconds / 60)} 分钟` : `约剩 ${Math.max(1, Math.ceil(seconds))} 秒`;

/** 保存位置：最后一级目录名在前（长路径也能一眼看出是哪个目录），上级路径另起一行；完整路径在悬停提示里。 */
export function LocationText({ folder }: { folder: string }) {
  const trimmed = folder.replace(/\/$/, "");
  const root = api.PRIVATE_PREFIX.replace(/\/$/, "");
  if (!trimmed || trimmed === root) return <span className="task-location-text"><span>{api.privatePathLabel(folder)}</span></span>;
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
  return <span className="task-location-text"><span>{trimmed.slice(trimmed.lastIndexOf("/") + 1)}</span><small>{api.privatePathLabel(parent)}</small></span>;
}
