import { useCallback, useEffect, useState } from "react";
import { useCursorPage } from "../pagination";
import { SITE } from "../brand";
import * as api from "../api";
import { FileTile, PreviewModal, baseName, getFileKind, kindLabel, parentPath } from "../files";

import { Badge, Button, ConfirmDialog, EmptyState, Menu, PageHeader, Pagination, SearchInput, Segmented, SkeletonRows, copyText, formatBytes, formatDate, formatDateTime, toast, useDocumentTitle, type IconName } from "../ui";

/* ---------- 全部文件 ---------- */

export function Objects({ session }: { session: api.Session }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "public">("all");
  const [preview, setPreview] = useState<api.AdminObject | null>(null);
  const [revoking, setRevoking] = useState<api.AdminObject | null>(null);
  useDocumentTitle(`全部文件 · ${SITE.admin}`);
  // 搜索输入防抖后交给服务端筛选，结果按修改时间分页加载。
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search.trim()), 300); return () => window.clearTimeout(timer); }, [search]);
  const fetchPage = useCallback((cursor: string | null) => api.adminObjects({ q: query, publicOnly: filter === "public", cursor }), [query, filter]);
  const pagination = useCursorPage(fetchPage);
  const page = pagination.page;
  const load = pagination.reload;
  const objects = page?.objects ?? null;
  const shown = objects ?? [];
  return (
    <>
      <PageHeader title="全部文件" description="所有用户的文件。管理员可以预览、下载，并撤销不当的公开分享。" />
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} onSubmit={() => setQuery(search.trim())} onClear={() => setQuery("")} placeholder="按文件名、路径或用户筛选" label="筛选文件" />
        <Segmented label="筛选" value={filter} onChange={setFilter} options={[{ value: "all", label: "全部" }, { value: "public", label: "公开" }]} />
      </div>
      <section className="file-surface">
        {pagination.error ? <EmptyState icon="alert" title="文件加载失败" description={pagination.error} action={<Button onClick={() => void load()}>重试</Button>} /> : objects === null ? <SkeletonRows rows={6} /> : shown.length === 0 ? <EmptyState icon={filter === "public" ? "globe" : "box"} title={query || filter === "public" ? "没有匹配的文件" : "还没有文件"} /> : (
          <div className="data-table objects-table" role="table" aria-label="全部文件">
            <div className="data-row data-head" role="row">
              <span role="columnheader">文件</span><span role="columnheader">所有者</span><span role="columnheader">类型</span><span role="columnheader">大小</span><span role="columnheader">修改时间</span><span role="columnheader"><span className="sr-only">操作</span></span>
            </div>
            {shown.map(item => {
              const links = item.public_token ? api.publicLinks(item.public_token, baseName(item.key)) : null;
              return (
                <div key={`${item.bucket_id}:${item.key}`} role="row" className="data-row is-clickable" onClick={() => setPreview(item)}>
                  <span role="cell" className="cell-name">
                    <FileTile kind={getFileKind(item.content_type, item.key)} />
                    <span className="name-stack"><button type="button" className="name-button" onClick={event => { event.stopPropagation(); setPreview(item); }}>{baseName(item.key)}</button><small>/{parentPath(item.key)}</small></span>
                    {item.public_token && <Badge tone="public" icon="globe">公开</Badge>}
                  </span>
                  <span role="cell" className="muted">{item.username ?? item.bucket_name}</span>
                  <span role="cell" className="muted">{kindLabel(getFileKind(item.content_type, item.key))}</span>
                  <span role="cell" className="muted">{formatBytes(item.size)}</span>
                  <span role="cell" className="muted" title={formatDateTime(item.modified_at)}>{formatDate(item.modified_at)}</span>
                  <span role="cell" className="cell-actions" onClick={event => event.stopPropagation()}>
                    <Menu label={`${baseName(item.key)} 的操作`} items={[
                      { label: "预览", icon: "eye", onSelect: () => setPreview(item) },
                      { label: "下载", icon: "download", onSelect: () => undefined, href: api.adminContentUrl(item.bucket_id, item.key, true) },
                      ...(links ? [
                        { label: "复制分享链接", icon: "copy" as IconName, onSelect: () => void copyText(links.page, "分享链接已复制") },
                        { label: "撤销公开访问", icon: "lock" as IconName, danger: true, divider: true, onSelect: () => setRevoking(item) },
                      ] : []),
                    ]} />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
      {page && (
        <footer className="list-footer">
          <span>本页 {shown.length.toLocaleString("zh-CN")} 个文件，共 {page.total.toLocaleString("zh-CN")} 个{filter === "all" && page.public_total ? `，其中 ${page.public_total.toLocaleString("zh-CN")} 个公开` : ""}</span>
          <Pagination {...pagination} />
        </footer>
      )}
      {preview && <PreviewModal file={preview} url={api.adminContentUrl(preview.bucket_id, preview.key)} downloadUrl={api.adminContentUrl(preview.bucket_id, preview.key, true)} assetUrl={key => api.adminContentUrl(preview.bucket_id, key)} onClose={() => setPreview(null)} />}
      {revoking && <ConfirmDialog title={`撤销“${baseName(revoking.key)}”的公开访问？`} description={`该文件属于 ${revoking.username ?? revoking.bucket_name}。撤销后原链接立即失效，用户可以重新分享。`} confirmLabel="撤销公开访问"
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          try { await api.setAdminObjectPublic(revoking.bucket_id, revoking.key, false); toast.success("已撤销公开访问"); setRevoking(null); load(); }
          catch (reason) { toast.error(api.errorMessage(reason, "操作失败，请稍后重试")); }
        }} />}
    </>
  );
}
