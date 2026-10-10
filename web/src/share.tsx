/** 公开分享页：无需登录，只暴露文件名、大小和内容。带密码的分享先验证密码。 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useCursorPage } from "./pagination";
import { BRAND } from "./brand";
import * as api from "./api";
import { FilePreview, FileTile, PreviewModal, canPreview, getFileKind, kindLabel } from "./files";
import { Brand, Button, EmptyState, Field, Icon, Pagination, SkeletonRows, Toaster, copyText, formatBytes, formatDate, formatDateTime } from "./ui";

type Shared = Extract<api.PublicObject, { password_required: false }>;

/** 验证密码后获得的访问凭证按分享令牌保存在本标签页，刷新页面无需重新输入。 */
const accessKey = (token: string) => `tgdrive:share-access:${token}`;

export function SharePage({ token }: { token: string }) {
  const [file, setFile] = useState<Shared | null>(null);
  const [locked, setLocked] = useState(false);
  const [access, setAccess] = useState<string | null>(() => sessionStorage.getItem(accessKey(token)));
  const [error, setError] = useState<{ status: number; code: string } | null>(null);
  const load = useCallback((grant: string | null) => {
    void api.publicObject(token, grant)
      .then(value => {
        if (value.password_required) {
          sessionStorage.removeItem(accessKey(token));
          setLocked(true); setFile(null);
          document.title = `需要访问密码 · ${BRAND}`;
        } else {
          setLocked(false); setFile(value);
          document.title = `${value.name} · ${BRAND}`;
        }
      })
      .catch(reason => {
        setError({ status: reason instanceof api.ApiError ? reason.status : 0, code: reason instanceof api.ApiError ? reason.code : "" });
        document.title = `链接不可用 · ${BRAND}`;
      });
  }, [token]);
  useEffect(() => load(access), [load, access]);
  const single = file?.kind === "file" ? file : null;
  const kind = single ? getFileKind(single.content_type, single.name) : "other";
  const url = single ? api.publicPath(token, single.name, false, access) : "";
  const downloadUrl = single ? api.publicPath(token, single.name, true, access) : "";
  return (
    <div className="share-page">
      <header className="share-bar">
        <Brand />
        <span className="share-bar-note"><Icon name="globe" size={15} />公开分享</span>
      </header>
      <main className="share-main">
        {error ? (
          <div className="share-card share-missing">
            <EmptyState icon={error.status === 503 ? "lock" : "link"}
              title={error.status === 503 ? "存储服务暂时不可用" : error.code === "share_expired" ? "这个链接已过期" : "这个链接已失效"}
              description={error.status === 503 ? "服务正在维护或尚未解锁，请稍后再试。"
                : error.code === "share_expired" ? "分享者设置的有效期已过。如仍需要，请联系分享者重新分享。"
                  : "分享者可能已关闭公开访问、删除了文件，或链接输入有误。"} />
          </div>
        ) : locked ? (
          <PasswordGate token={token} onUnlocked={grant => { sessionStorage.setItem(accessKey(token), grant); setAccess(grant); }} />
        ) : !file ? (
          <div className="share-card"><SkeletonRows rows={3} /></div>
        ) : file.kind === "folder" ? (
          <FolderShare token={token} folder={file} access={access} onPasswordRequired={() => load(access)} />
        ) : (
          <article className="share-card">
            <header className="share-head">
              <FileTile kind={kind} size="lg" />
              <div className="share-title">
                <h1>{file.name}</h1>
                <p>
                  <span>{formatBytes(file.size)}</span><span>{kindLabel(kind)}</span><span>更新于 {formatDateTime(file.modified_at)}</span>
                  {file.expires_at && <span>链接有效期至 {formatDateTime(file.expires_at)}</span>}
                </p>
              </div>
              <div className="share-actions">
                <Button icon="link" onClick={() => void copyText(`${window.location.origin}${window.location.pathname}`, "分享链接已复制")}>复制链接</Button>
                <a className="btn btn-primary btn-md" href={downloadUrl}><Icon name="download" size={17} /><span>下载</span></a>
              </div>
            </header>
            {canPreview(kind) && <div className="share-preview"><FilePreview kind={kind} url={url} name={file.name} downloadUrl={downloadUrl} /></div>}
          </article>
        )}
        <p className="share-footnote">这是 {BRAND} 用户分享的{file?.kind === "folder" ? "文件夹" : "文件"}，只有拿到链接的人才能访问。</p>
      </main>
      <Toaster />
    </div>
  );
}

function PasswordGate({ token, onUnlocked }: { token: string; onUnlocked: (grant: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password) { setError("请输入访问密码"); return; }
    setBusy(true); setError("");
    try { onUnlocked((await api.unlockShare(token, password)).access); }
    catch (reason) {
      setError(reason instanceof api.ApiError && reason.status === 429 ? "尝试次数过多，请 15 分钟后再试" : api.errorMessage(reason, "验证失败，请稍后重试"));
    } finally { setBusy(false); }
  }
  return (
    <div className="share-card share-gate">
      <span className="empty-icon"><Icon name="lock" size={22} /></span>
      <h1>需要访问密码</h1>
      <p>分享者为这个链接设置了访问密码。</p>
      <form className="form" onSubmit={submit} noValidate>
        <Field label="访问密码" htmlFor="share-password" error={error}>
          <input id="share-password" className="input" type="password" autoComplete="off" value={password} autoFocus
            onChange={event => { setPassword(event.target.value); setError(""); }} />
        </Field>
        <Button type="submit" variant="primary" block loading={busy}>查看内容</Button>
      </form>
    </div>
  );
}

/* ---------- 分享的文件夹 ---------- */

type FolderPage = api.PublicFolderPage;

/** 访客只读浏览：进入子文件夹、预览和下载单个文件。内容是实时的，分享者新增或删除的文件会直接反映出来。 */
function FolderShare({ token, folder, access, onPasswordRequired }: { token: string; folder: api.PublicFolder; access: string | null; onPasswordRequired: () => void }) {
  const readPath = () => new URLSearchParams(window.location.search).get("path") ?? "";
  const [path, setPath] = useState(readPath);
  const [preview, setPreview] = useState<FolderPage["files"][number] | null>(null);
  useEffect(() => {
    const pop = () => setPath(readPath());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const passwordRequired = useRef(onPasswordRequired);
  passwordRequired.current = onPasswordRequired;
  const fetchPage = useCallback(async (cursor: string | null) => {
    try { return await api.publicFolderList(token, path, cursor, access); }
    catch (reason) {
      if (reason instanceof api.ApiError && reason.code === "password_required") passwordRequired.current();
      throw new Error(reason instanceof api.ApiError && reason.status === 404 ? "这个文件夹不存在，可能已被分享者移动或删除。" : api.errorMessage(reason, "加载失败，请稍后重试"));
    }
  }, [token, path, access]);
  const pagination = useCursorPage(fetchPage);
  const page = pagination.page;
  const error = pagination.error;
  const load = pagination.reload;
  function open(next: string) {
    window.history.pushState(null, "", next ? `?path=${encodeURIComponent(next)}` : window.location.pathname);
    setPath(next);
  }
  const segments = path.split("/").filter(Boolean);
  const crumbs = [{ label: folder.name, path: "" }, ...segments.map((label, index) => ({ label, path: `${segments.slice(0, index + 1).join("/")}/` }))];
  const empty = page !== null && page.folders.length === 0 && page.files.length === 0;
  return (
    <article className="share-card share-folder">
      <header className="share-head">
        <FileTile kind="folder" size="lg" />
        <div className="share-title">
          <h1>{folder.name}</h1>
          <p><span>公开文件夹</span><span>更新于 {formatDateTime(folder.modified_at)}</span>{folder.expires_at && <span>链接有效期至 {formatDateTime(folder.expires_at)}</span>}</p>
        </div>
        <div className="share-actions">
          <Button icon="link" onClick={() => void copyText(`${window.location.origin}${window.location.pathname}`, "分享链接已复制")}>复制链接</Button>
        </div>
      </header>
      {crumbs.length > 1 && <nav className="share-crumbs" aria-label="文件夹路径">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path}>
            {index > 0 && <Icon name="chevronRight" size={14} />}
            {index === crumbs.length - 1 ? <strong aria-current="page">{crumb.label}</strong> : <button type="button" onClick={() => open(crumb.path)}>{crumb.label}</button>}
          </span>
        ))}
      </nav>}
      {error ? <EmptyState icon="alert" title="无法打开" description={error} action={path ? <Button onClick={() => open("")}>回到根目录</Button> : <Button icon="refresh" onClick={() => void load()}>重试</Button>} />
        : page === null ? <div className="share-folder-loading"><SkeletonRows rows={4} /></div>
          : empty ? <EmptyState icon="folder" title="这个文件夹是空的" description="分享者之后添加的文件会显示在这里。" />
            : (
              <div className="data-table public-folder-table" role="table" aria-label="文件夹内容">
                <div className="data-row data-head" role="row">
                  <span role="columnheader" className="cell-name">名称</span>
                  <span role="columnheader" className="cell-type">类型</span>
                  <span role="columnheader" className="cell-size">大小</span>
                  <span role="columnheader" className="cell-date">修改时间</span>
                  <span role="columnheader" className="cell-actions"><span className="sr-only">操作</span></span>
                </div>
                {page.folders.map(item => (
                  <div key={item.path} role="row" className="data-row is-clickable" onClick={() => open(item.path)}>
                    <span role="cell" className="cell-name"><FileTile kind="folder" /><button type="button" className="name-button" onClick={event => { event.stopPropagation(); open(item.path); }}>{item.name}</button></span>
                    <span role="cell" className="cell-type muted">文件夹</span>
                    <span role="cell" className="cell-size muted" title="包含所有子文件夹中的文件">{item.size == null ? "—" : formatBytes(item.size)}</span>
                    <span role="cell" className="cell-date muted">—</span>
                    <span role="cell" className="cell-actions" />
                  </div>
                ))}
                {page.files.map(item => {
                  const kind = getFileKind(item.content_type, item.name);
                  const previewable = canPreview(kind);
                  const download = api.publicFolderFile(token, item.path, true, access);
                  return (
                    <div key={item.path} role="row" className="data-row is-clickable" onClick={() => previewable ? setPreview(item) : window.location.assign(download)}>
                      <span role="cell" className="cell-name"><FileTile kind={kind} />
                        <a className="name-button" href={previewable ? api.publicFolderFile(token, item.path, false, access) : download} onClick={event => { event.preventDefault(); event.stopPropagation(); if (previewable) setPreview(item); else window.location.assign(download); }}>{item.name}</a>
                      </span>
                      <span role="cell" className="cell-type muted">{kindLabel(kind)}</span>
                      <span role="cell" className="cell-size muted">{formatBytes(item.size)}</span>
                      <span role="cell" className="cell-date muted" title={formatDateTime(item.modified_at)}>{formatDate(item.modified_at)}</span>
                      <span role="cell" className="cell-actions" onClick={event => event.stopPropagation()}>
                        <a className="icon-btn icon-btn-ghost icon-btn-sm" href={download} aria-label={`下载 ${item.name}`} title={`下载 ${item.name}`}><Icon name="download" size={16} /></a>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
      <div className="panel-more"><Pagination {...pagination} /></div>
      {preview && (
        <PreviewModal file={{ ...preview, key: preview.path }} onClose={() => setPreview(null)}
          url={api.publicFolderFile(token, preview.path, false, access)} downloadUrl={api.publicFolderFile(token, preview.path, true, access)}
          loadAssets={signal => api.publicPreviewAssets(token, preview.path, access, signal)} assetUrl={path => api.publicFolderFile(token, path, false, access)} />
      )}
    </article>
  );
}
