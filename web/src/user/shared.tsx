import { useCallback, useEffect, useState } from "react";
import { useDirectory, mergeObjectPages } from "../pagination";
import { BRAND } from "../brand";
import * as api from "../api";
import { usePreview } from "./preview-host";

import { FileFilters, FileThumbnail, FileVisual, FolderThumbnail, baseName, getFileKind, kindLabel, matchesKindFilter, parentPath, type EntryFilter } from "../files";

import { Badge, Button, ConfirmDialog, EmptyState, Icon, IconButton, Menu, PageHeader, Segmented, SkeletonRows, copyText, formatBytes, formatDate, formatDateTime, toast, useDocumentTitle, type MenuItem } from "../ui";

/* ---------- 公开分享 ---------- */

export function SharedView({ session, onChanged, onOpenFolder }: { session: api.Session; onChanged: () => void; onOpenFolder: (prefix: string) => void }) {
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => api.listPublicPage(cursor, 200, signal), []);
  const pagination = useDirectory(fetchPage, mergeObjectPages);
  const [entryFilter, setEntryFilter] = useState<EntryFilter>("all");
  const [kind, setKind] = useState<api.KindFilter>("");
  const items = pagination.page?.objects.filter(file => (entryFilter === "all" || (file.key.endsWith("/") ? entryFilter === "folder" : entryFilter === "file")) && matchesKindFilter(file, kind)) ?? null;
  const error = pagination.error;
  const load = pagination.reload;
  const [revoking, setRevoking] = useState<api.FileItem | null>(null);
  const preview = usePreview();
  const openPreview = (file: api.FileItem) => preview.open({ file, url: api.contentUrl(file.key), downloadUrl: api.contentUrl(file.key, true),
    assetUrl: key => api.contentUrl(key), playlistFiles: items ?? undefined, poster: api.fileThumbnail(file, "poster"), thumbnail: api.fileThumbnail(file) });
  const [layout, setLayout] = useState<"list" | "grid">(() => localStorage.getItem("tgdrive:share-layout") === "grid" ? "grid" : "list");
  useEffect(() => { localStorage.setItem("tgdrive:share-layout", layout); }, [layout]);
  useDocumentTitle(`公开分享 · ${BRAND}`);

  const links = (file: api.FileItem) => api.publicLinks(file.public_token!, baseName(file.key), session.public_base_url);
  const fileMenu = (file: api.FileItem, includeCopy = false): MenuItem[] => {
    const folder = file.key.endsWith("/");
    return [
      ...(includeCopy ? [{ label: "复制分享链接", icon: "copy" as const, onSelect: () => void copyText(links(file).page, "分享链接已复制") }] : []),
      { label: "打开分享页", icon: "external", onSelect: () => window.open(links(file).page, "_blank", "noreferrer") },
      ...(folder ? [] : [{ label: "复制直链", icon: "link" as const, onSelect: () => void copyText(links(file).direct, "直链已复制") }]),
      { label: folder ? "打开文件夹" : "打开所在文件夹", icon: "folder", onSelect: () => onOpenFolder(folder ? file.key : parentPath(file.key)) },
      { label: "停止分享", icon: "lock", danger: true, divider: true, onSelect: () => setRevoking(file) },
    ];
  };
  const shareBadges = (file: api.FileItem) => <>
    {file.public_has_password && <Badge icon="lock">密码</Badge>}
    {file.public_expires_at && (file.public_expires_at * 1000 < Date.now()
      ? <Badge tone="danger">已过期</Badge>
      : <span title={formatDateTime(file.public_expires_at)}><Badge tone="warning" icon="pulse">{`至 ${new Date(file.public_expires_at * 1000).toLocaleDateString("zh-CN")}`}</Badge></span>)}
  </>;
  return (
    <>
      <PageHeader title="公开分享" description="这些文件和文件夹可以被任何拥有链接的人访问。关闭分享后，链接会立即失效。"
        actions={<Segmented label="视图" value={layout} onChange={setLayout} options={[{ value: "list", label: "列表视图", icon: "list" }, { value: "grid", label: "网格视图", icon: "gridView" }]} />} />
      <FileFilters entry={entryFilter} kind={kind} onEntryChange={setEntryFilter} onKindChange={setKind} />
      <section className={`file-surface${layout === "grid" && items?.length && !error ? " is-grid" : ""}`}>
        {error ? <EmptyState icon="alert" title="加载失败" description={error} action={<Button icon="refresh" onClick={() => void load()}>重试</Button>} />
          : items === null ? <SkeletonRows rows={4} />
            : items.length === 0 && (entryFilter !== "all" || kind) ? <EmptyState icon="search" title="没有符合筛选条件的公开项目" action={<Button onClick={() => { setEntryFilter("all"); setKind(""); }}>清除筛选</Button>} />
            : items.length === 0 ? <EmptyState icon="globe" title="还没有公开的内容" description="在“我的文件”中打开文件或文件夹的菜单，选择“公开分享”，或在上传时开启公开访问。" />
              : layout === "list" ? (
                <div className="data-table shared-table" role="table" aria-label="公开内容">
                  <div className="data-row data-head" role="row">
                    <span role="columnheader" className="cell-name">名称</span>
                    <span role="columnheader" className="cell-type">类型</span>
                    <span role="columnheader" className="cell-size">大小</span>
                    <span role="columnheader" className="cell-count">下载</span>
                    <span role="columnheader" className="cell-date">分享时间</span>
                    <span role="columnheader" className="cell-actions"><span className="sr-only">操作</span></span>
                  </div>
                  {items.map(file => {
                    const folder = file.key.endsWith("/");
                    const size = folder ? pagination.page?.folder_sizes?.[file.key] : file.size;
                    const open = () => folder ? onOpenFolder(file.key) : openPreview(file);
                    return (
                    <div key={file.key} role="row" className="data-row is-clickable" onClick={open}>
                      <span role="cell" className="cell-name">
                        <FileVisual kind={folder ? "folder" : getFileKind(file.content_type, file.key)} src={folder ? undefined : api.fileThumbnail(file)} />
                        <span className="name-stack">
                          <button type="button" className="name-button" title={file.key} onClick={event => { event.stopPropagation(); open(); }}>{baseName(file.key)}</button>
                          {/* 位置是次要信息：小号三级色，带文件夹图标的面包屑，和文件名明显区分。 */}
                          <small className="item-location" title={`位于 /${parentPath(file.key)}`}><Icon name="folder" size={12} />
                            <span>{["我的文件", ...parentPath(file.key).split("/").filter(Boolean)].join(" › ")}</span>
                            <span className="item-location-count">· 下载 {file.public_downloads ?? 0} 次</span></small>
                        </span>
                        {shareBadges(file)}
                      </span>
                      <span role="cell" className="cell-type muted">{kindLabel(getFileKind(file.content_type, file.key))}</span>
                      <span role="cell" className="cell-size muted" title={folder ? "包含所有子文件夹中的文件" : undefined}>{size == null ? "—" : formatBytes(size)}</span>
                      <span role="cell" className="cell-count muted">{(file.public_downloads ?? 0).toLocaleString("zh-CN")} 次</span>
                      <span role="cell" className="cell-date muted">{formatDate(file.public_at)}</span>
                      <span role="cell" className="cell-actions" onClick={event => event.stopPropagation()}>
                        <IconButton icon="copy" size="sm" label="复制分享链接" onClick={() => void copyText(links(file).page, "分享链接已复制")} />
                        <Menu label={`${baseName(file.key)} 的更多操作`} items={fileMenu(file)} />
                      </span>
                    </div>
                    );
                  })}
                </div>
              ) : (
                <div className="file-grid shared-grid">
                  {items.map(file => {
                    const folder = file.key.endsWith("/");
                    const kind = folder ? "folder" : getFileKind(file.content_type, file.key);
                    const size = folder ? pagination.page?.folder_sizes?.[file.key] : file.size;
                    const open = () => folder ? onOpenFolder(file.key) : openPreview(file);
                    return <div key={file.key} className="grid-card shared-grid-card" onClick={open}>
                      <div className="grid-thumb">
                        {folder ? <FolderThumbnail previews={(pagination.page?.folder_previews?.[file.key] ?? []).flatMap(item => {
                          const url = api.fileThumbnail(item); return url ? [{ ...item, url }] : [];
                        })} /> : <FileThumbnail kind={kind} url={api.fileThumbnail(file, "grid")} placeholder={api.fileThumbnail(file)} />}
                        <span className="grid-public grid-share-badges">{shareBadges(file)}</span>
                      </div>
                      <div className="grid-meta">
                        <button type="button" className="grid-name name-button" title={baseName(file.key)} onClick={event => { event.stopPropagation(); open(); }}><span className="grid-name-text">{baseName(file.key)}</span></button>
                        <span className="grid-sub"><span className="grid-kind">{kindLabel(kind)}</span>{" · "}<span className="grid-size">{size == null ? "—" : formatBytes(size)}</span></span>
                        <span className="grid-menu" onClick={event => event.stopPropagation()}><Menu label={`${baseName(file.key)} 的更多操作`} items={fileMenu(file, true)} /></span>
                        <span className="grid-share-meta" title={parentPath(file.key) ? `/${parentPath(file.key)}` : "我的文件"}>{formatDate(file.public_at)} · 下载 {file.public_downloads ?? 0} 次</span>
                      </div>
                    </div>;
                  })}
                </div>
              )}
      </section>
      <footer className="list-footer"><span>共 {items?.length ?? "—"} 个公开项目</span>{pagination.loadingMore && <span role="status">正在读取其余项目…</span>}</footer>
      {revoking && <ConfirmDialog title={`停止分享“${baseName(revoking.key)}”？`} description="原链接会立即失效。再次分享时会生成新的链接。" confirmLabel="停止分享"
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          try { await api.setPublic([revoking.key], false); toast.success("已停止分享"); setRevoking(null); load(); onChanged(); }
          catch (reason) { toast.error(api.errorMessage(reason, "操作没有完成，请稍后重试")); }
        }} />}
    </>
  );
}
