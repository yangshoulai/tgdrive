import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Checkbox, Pagination, SearchInput, Segmented } from "../ui";

export type TaskFilter = "" | "active" | "paused" | "done" | "error";
const PAGE_SIZE = 50;

/** 本机队列只渲染当前页；选择限定当前筛选页，进度刷新不会打断勾选。 */
export function useTaskList<T extends { id: string }>(items: T[], describe: (item: T) => string, group: (item: T) => TaskFilter) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("");
  const [pageIndex, setPageIndex] = useState(0);
  const [selected, setSelected] = useState(new Set<string>());
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
    search, filter, filtered, visible, selected,
    chosen: visible.filter(item => selected.has(item.id)),
    setSearch: (value: string) => { reset(); setSearch(value); },
    setFilter: (value: TaskFilter) => { reset(); setFilter(value); },
    clearSelection: () => setSelected(new Set()),
    toggle: (id: string, checked: boolean) => setSelected(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; }),
    allSelected: Boolean(visible.length) && visible.every(item => selected.has(item.id)),
    selectPage: (checked: boolean) => setSelected(checked ? new Set(visible.map(item => item.id)) : new Set()),
    pagination: { number: index + 1, hasPrevious: index > 0, hasNext: (index + 1) * PAGE_SIZE < filtered.length, loading: false,
      previous: () => { setSelected(new Set()); setPageIndex(index - 1); }, next: () => { setSelected(new Set()); setPageIndex(index + 1); }, total: filtered.length, pageSize: PAGE_SIZE },
  };
}

type ListState = ReturnType<typeof useTaskList>;
export function TaskListControls({ list, actions, menu, noun, pausedLabel = "已暂停" }: { list: ListState; actions: ReactNode; menu?: ReactNode; noun: string; pausedLabel?: string }) {
  return <div className="task-list-controls">
    <SearchInput value={list.search} onChange={list.setSearch} placeholder={`搜索${noun}名称或路径`} label={`搜索${noun}`} />
    <div className="task-list-filters"><Segmented label={`${noun}状态`} showLabels value={list.filter} onChange={list.setFilter} options={[
      { value: "", label: "全部" }, { value: "active", label: "进行中" }, { value: "paused", label: pausedLabel }, { value: "done", label: "已完成" }, { value: "error", label: "失败" },
    ]} />{menu}</div>
    <div className="task-list-selection" role="toolbar" aria-label={`${noun}批量操作`}>
      <Checkbox checked={list.allSelected} indeterminate={list.chosen.length > 0 && !list.allSelected} label={`选择本页全部${noun}`} onChange={list.selectPage} />
      <span>{list.chosen.length ? `已选 ${list.chosen.length} 项` : `${list.filtered.length} 个任务`}</span>
      <div className="task-list-actions">{actions}</div>
    </div>
  </div>;
}

export function TaskListFooter({ list }: { list: ListState }) {
  return list.pagination.total > PAGE_SIZE ? <div className="task-list-footer"><Pagination {...list.pagination} /></div> : null;
}
