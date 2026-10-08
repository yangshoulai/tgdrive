import { useCallback, useEffect, useRef, useState } from "react";
import { SITE } from "../brand";
import * as api from "../api";
import { FileTile, PreviewModal, baseName, getFileKind, parentPath } from "../files";

import { Badge, Button, ConfirmDialog, EmptyState, Menu, PageHeader, SearchInput, Segmented, SkeletonRows, copyText, formatBytes, formatDate, formatDateTime, toast, useDocumentTitle, type IconName } from "../ui";

/* ---------- 全部文件 ---------- */

export function Objects({ session }: { session: api.Session }) {
  const [page, setPage] = useState<api.AdminObjectPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "public">("all");
  const [preview, setPreview] = useState<api.AdminObject | null>(null);
  const [revoking, setRevoking] = useState<api.AdminObject | null>(null);
  const requestId = useRef(0);
  useDocumentTitle(`全部文件 · ${SITE.admin}`);
  // 搜索输入防抖后交给服务端筛选，结果按修改时间分页加载。
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search.trim()), 300); return () => window.clearTimeout(timer); }, [search]);
  const load = useCallback(() => {
    const id = ++requestId.current;
    setPage(null);
    void api.adminObjects({ q: query, publicOnly: filter === "public" })
      .then(result => { if (id === requestId.current) setPage(result); })
      .catch(reason => { if (id === requestId.current) { setPage({ objects: [], next_cursor: null, total: 0, public_total: 0 }); toast.error(api.errorMessage(reason, "文件加载失败，请稍后重试")); } });
  }, [query, filter]);
  useEffect(load, [load]);
  async function loadMore() {
    if (!page?.next_cursor) return;
    const id = requestId.current;
    setLoadingMore(true);
    try {
      const next = await api.adminObjects({ q: query, publicOnly: filter === "public", cursor: page.next_cursor });
      if (id === requestId.current) setPage(current => current && { ...next, objects: [...current.objects, ...next.objects] });
    } catch (reason) { toast.error(api.errorMessage(reason, "加载失败，请稍后重试")); }
    finally { setLoadingMore(false); }
  }
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
        {objects === null ? <SkeletonRows rows={6} /> : shown.length === 0 ? <EmptyState icon={filter === "public" ? "globe" : "box"} title={query || filter === "public" ? "没有匹配的文件" : "还没有文件"} /> : (
          <div className="data-table objects-table" role="table" aria-label="全部文件">
            <div className="data-row data-head" role="row">
              <span role="columnheader">文件</span><span role="columnheader">所有者</span><span role="columnheader">大小</span><span role="columnheader">修改时间</span><span role="columnheader"><span className="sr-only">操作</span></span>
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
      {page && page.total > 0 && (
        <footer className="list-footer">
          <span>已显示 {shown.length.toLocaleString("zh-CN")} / {page.total.toLocaleString("zh-CN")} 个文件{filter === "all" && page.public_total ? `，其中 ${page.public_total.toLocaleString("zh-CN")} 个公开` : ""}</span>
          {page.next_cursor && <Button size="sm" loading={loadingMore} onClick={() => void loadMore()}>加载更多</Button>}
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

