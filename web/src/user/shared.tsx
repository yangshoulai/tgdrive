import { useState } from "react";
import { useCursorPage } from "../pagination";
import { BRAND } from "../brand";
import * as api from "../api";

import { FileTile, PreviewModal, baseName, getFileKind, kindLabel, parentPath } from "../files";

import { Badge, Button, ConfirmDialog, EmptyState, Menu, PageHeader, Pagination, SkeletonRows, copyText, formatBytes, formatDate, toast, useDocumentTitle } from "../ui";

/* ---------- 公开分享 ---------- */

export function SharedView({ session, onChanged, onOpenFolder }: { session: api.Session; onChanged: () => void; onOpenFolder: (prefix: string) => void }) {
  const pagination = useCursorPage(api.listPublicPage);
  const items = pagination.page?.objects ?? null;
  const error = pagination.error;
  const load = pagination.reload;
  const [revoking, setRevoking] = useState<api.FileItem | null>(null);
  const [preview, setPreview] = useState<api.FileItem | null>(null);
  useDocumentTitle(`公开分享 · ${BRAND}`);

  const links = (file: api.FileItem) => api.publicLinks(file.public_token!, baseName(file.key), session.public_base_url);
  return (
    <>
      <PageHeader title="公开分享" description="这些文件和文件夹可以被任何拥有链接的人访问。关闭分享后，链接会立即失效。" />
      <section className="file-surface">
        {error ? <EmptyState icon="alert" title="加载失败" description={error} action={<Button icon="refresh" onClick={() => void load()}>重试</Button>} />
          : items === null ? <SkeletonRows rows={4} />
            : items.length === 0 ? <EmptyState icon="globe" title="还没有公开的内容" description="在“我的文件”中打开文件或文件夹的菜单，选择“公开分享”，或在上传时开启公开访问。" />
              : (
                <div className="data-table shared-table" role="table" aria-label="公开内容">
                  <div className="data-row data-head" role="row">
                    <span role="columnheader" className="cell-name">名称</span>
                    <span role="columnheader" className="cell-type">类型</span>
                    <span role="columnheader" className="cell-size">大小</span>
                    <span role="columnheader" className="cell-date">分享时间</span>
                    <span role="columnheader" className="cell-actions"><span className="sr-only">操作</span></span>
                  </div>
                  {items.map(file => {
                    const folder = file.key.endsWith("/");
                    const size = folder ? pagination.page?.folder_sizes?.[file.key] : file.size;
                    const open = () => folder ? onOpenFolder(file.key) : setPreview(file);
                    return (
                    <div key={file.key} role="row" className="data-row is-clickable" onClick={open}>
                      <span role="cell" className="cell-name">
                        <FileTile kind={folder ? "folder" : getFileKind(file.content_type, file.key)} />
                        <span className="name-stack">
                          <button type="button" className="name-button" onClick={event => { event.stopPropagation(); open(); }}>{baseName(file.key)}</button>
                          <small>{parentPath(file.key) ? `/${parentPath(file.key)}` : "我的文件"}{` · 下载 ${file.public_downloads ?? 0} 次`}</small>
                        </span>
                        {file.public_has_password && <Badge icon="lock">密码</Badge>}
                        {file.public_expires_at && (file.public_expires_at * 1000 < Date.now()
                          ? <Badge tone="danger">已过期</Badge>
                          : <Badge tone="warning" icon="pulse">{`至 ${formatDate(file.public_expires_at)}`}</Badge>)}
                      </span>
                      <span role="cell" className="cell-type muted">{kindLabel(getFileKind(file.content_type, file.key))}</span>
                      <span role="cell" className="cell-size muted" title={folder ? "包含所有子文件夹中的文件" : undefined}>{size == null ? "—" : formatBytes(size)}</span>
                      <span role="cell" className="cell-date muted">{formatDate(file.public_at)}</span>
                      <span role="cell" className="cell-actions" onClick={event => event.stopPropagation()}>
                        <Button size="sm" icon="copy" onClick={() => void copyText(links(file).page, "分享链接已复制")}>复制链接</Button>
                        <Menu label={`${baseName(file.key)} 的更多操作`} items={[
                          { label: "打开分享页", icon: "external", onSelect: () => window.open(links(file).page, "_blank", "noreferrer") },
                          ...(folder ? [] : [{ label: "复制直链", icon: "link" as const, onSelect: () => void copyText(links(file).direct, "直链已复制") }]),
                          { label: folder ? "打开文件夹" : "打开所在文件夹", icon: "folder", onSelect: () => onOpenFolder(folder ? file.key : parentPath(file.key)) },
                          { label: "停止分享", icon: "lock", danger: true, divider: true, onSelect: () => setRevoking(file) },
                        ]} />
                      </span>
                    </div>
                    );
                  })}
                </div>
              )}
      </section>
      <footer className="list-footer"><span>共 {pagination.page?.total ?? "—"} 个公开项目</span><Pagination {...pagination} /></footer>
      {revoking && <ConfirmDialog title={`停止分享“${baseName(revoking.key)}”？`} description="原链接会立即失效。再次分享时会生成新的链接。" confirmLabel="停止分享"
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          try { await api.setPublic([revoking.key], false); toast.success("已停止分享"); setRevoking(null); load(); onChanged(); }
          catch (reason) { toast.error(api.errorMessage(reason, "操作失败，请稍后重试")); }
        }} />}
      {preview && <PreviewModal file={preview} url={api.contentUrl(preview.key)} downloadUrl={api.contentUrl(preview.key, true)} assetUrl={key => api.contentUrl(key)} onClose={() => setPreview(null)} />}
    </>
  );
}
