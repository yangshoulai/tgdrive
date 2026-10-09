import { useState } from "react";
import { useCursorPage } from "../pagination";
import { BRAND } from "../brand";
import * as api from "../api";

import { FileTile, baseName, getFileKind, parentPath } from "../files";

import { Button, ConfirmDialog, EmptyState, PageHeader, Pagination, SkeletonRows, formatBytes, formatDate, toast, useDocumentTitle } from "../ui";

/* ---------- 回收站 ---------- */

export function TrashView({ onChanged, onOpenFolder }: { onChanged: () => void; onOpenFolder: (prefix: string) => void }) {
  const pagination = useCursorPage(api.listTrashPage);
  const data = pagination.page;
  const load = pagination.reload;
  const [purging, setPurging] = useState<api.TrashItem[] | "all" | null>(null);
  useDocumentTitle(`回收站 · ${BRAND}`);
  async function restore(items: api.TrashItem[]) {
    try {
      const { restored } = await api.restoreTrash(items.map(item => item.id));
      const location = parentPath(restored[0]?.path ?? "");
      toast.success(restored.length === 1 ? `已还原“${baseName(restored[0].path)}”` : `已还原 ${restored.length} 项`,
        { label: "打开位置", onClick: () => onOpenFolder(location) });
      load(); onChanged();
    } catch (reason) { toast.error(api.errorMessage(reason, "还原失败，请稍后重试")); }
  }
  async function purge(target: api.TrashItem[] | "all") {
    try {
      const { purged } = await api.purgeTrash(target === "all" ? "all" : target.map(item => item.id));
      toast.success(`已永久删除 ${purged} 项`);
      setPurging(null); load(); onChanged();
    } catch (reason) { toast.error(api.errorMessage(reason, "删除失败，请稍后重试")); }
  }
  const days = (until: number) => Math.max(0, Math.ceil((until * 1000 - Date.now()) / 86400000));
  return (
    <>
      <PageHeader title="回收站" description={`删除的文件会在这里保留 ${data?.retention_days ?? 30} 天，之后自动永久删除。回收站中的文件仍占用存储空间，其公开链接暂停访问。`}
        actions={data && data.items.length > 0 ? <Button variant="danger" icon="trash" onClick={() => setPurging("all")}>清空回收站</Button> : undefined} />
      <section className="file-surface">
        {pagination.error ? <EmptyState icon="alert" title="回收站加载失败" description={pagination.error} action={<Button onClick={() => void load()}>重试</Button>} /> : data === null ? <SkeletonRows rows={4} /> : data.items.length === 0 ? (
          <EmptyState icon="trash" title="回收站是空的" description="删除的文件和文件夹会先放到这里，可以随时还原。" />
        ) : (
          <div className="data-table trash-table" role="table" aria-label="回收站">
            <div className="data-row data-head" role="row">
              <span role="columnheader">名称</span><span role="columnheader">大小</span><span role="columnheader">删除时间</span><span role="columnheader"><span className="sr-only">操作</span></span>
            </div>
            {data.items.map(item => (
              <div key={item.id} role="row" className="data-row">
                <span role="cell" className="cell-name">
                  <FileTile kind={item.is_folder ? "folder" : getFileKind(null, item.path)} />
                  <span className="name-stack">
                    <strong>{baseName(item.path)}</strong>
                    <small>原位置：{parentPath(item.path) ? `/${parentPath(item.path)}` : "我的文件"}{item.is_folder ? ` · ${item.item_count - 1 > 0 ? `${item.item_count - 1} 个项目` : "空文件夹"}` : ""}</small>
                  </span>
                </span>
                <span role="cell" className="muted">{formatBytes(item.size)}</span>
                <span role="cell" className="name-stack"><span className="muted">{formatDate(item.deleted_at)}</span><small>{days(item.purge_at)} 天后永久删除</small></span>
                <span role="cell" className="cell-actions">
                  <Button size="sm" variant="ghost" icon="refresh" onClick={() => void restore([item])}>还原</Button>
                  <Button size="sm" variant="ghost" className="btn-ghost-danger" onClick={() => setPurging([item])}>永久删除</Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      {data && <footer className="list-footer"><span>共 {data.total} 项，占用 {formatBytes(data.total_size)}</span><Pagination {...pagination} /></footer>}
      {purging && <ConfirmDialog title={purging === "all" ? "清空回收站？" : `永久删除“${baseName(purging[0].path)}”？`}
        description={purging === "all" ? "回收站中的所有文件都会被永久删除并释放空间，无法恢复。" : "文件会被永久删除并释放空间，无法恢复。"}
        confirmLabel="永久删除" onConfirm={() => purge(purging)} onClose={() => setPurging(null)} />}
    </>
  );
}
