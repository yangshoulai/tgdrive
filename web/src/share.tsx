/** 公开分享页：无需登录，只暴露文件名、大小和内容。带密码的分享先验证密码。 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useDirectory, useRenderLimit, mergePublicFolderPages } from "./pagination";
import { BRAND } from "./brand";
import * as api from "./api";
import { FileFilters, FilePreview, FileThumbnail, FileTile, FileVisual, FolderThumbnail, PreviewModal, canPreview, getFileKind, kindLabel, type EntryFilter } from "./files";
import { Avatar, Brand, Button, Checkbox, EmptyState, Field, Icon, Modal, Segmented, SkeletonRows, Toaster, copyText, formatBytes, formatDate, formatDateTime, toast } from "./ui";
import { LoginPage } from "./shell";
import { FolderPicker } from "./user/folders";

type Shared = Extract<api.PublicObject, { password_required: false }>;
/** 要保存的内容：paths 为分享文件夹内的相对路径，省略时保存整个分享；label 用于对话框标题。 */
type SaveRequest = { paths?: string[]; label: string };

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
  // 已登录的访客可以把分享保存到自己的文件；自己的分享不显示保存按钮（由服务端判断，不比对用户名）。
  const [account, setAccount] = useState<api.Session | null | undefined>(undefined);
  const [own, setOwn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState<SaveRequest | null>(null);
  const [loginFor, setLoginFor] = useState<SaveRequest | null>(null);
  useEffect(() => { void api.restoreSession().then(setAccount).catch(() => setAccount(null)); }, []);
  useEffect(() => {
    setOwn(null);
    if (account && file) void api.shareStatus(token).then(value => setOwn(value.own)).catch(() => setOwn(false));
  }, [account, file, token]);
  const canSave = account === null || (Boolean(account) && own === false);
  const requestSave = (request: SaveRequest) => account ? setSaving(request) : setLoginFor(request);
  async function loggedIn(session: api.Session) {
    const request = loginFor;
    setLoginFor(null); setAccount(session);
    document.title = `${file?.name ?? "分享"} · ${BRAND}`;
    try {
      if ((await api.shareStatus(token)).own) { toast.info("这是你自己分享的内容，已经在你的文件中"); return; }
      if (request) setSaving(request);
    } catch (reason) { toast.error(api.errorMessage(reason, "无法检查分享状态，请刷新后重试")); }
  }
  if (loginFor) return <LoginPage onSuccess={session => void loggedIn(session)} notice={
    <p className="inline-note share-login-note"><Icon name="folderPlus" size={15} /><span>登录后把“{loginFor.label}”保存到你的 {BRAND}。</span>
      <button type="button" className="link-button" onClick={() => { setLoginFor(null); document.title = `${file?.name ?? "分享"} · ${BRAND}`; }}>返回分享页</button></p>} />;
  const saveButton = (request: SaveRequest) => canSave && <Button icon="folderPlus" onClick={() => requestSave(request)}
    title={account ? "保存到你的文件，立即完成并计入你的存储空间" : `登录后保存到你的 ${BRAND}`}>保存到我的 {BRAND}</Button>;
  const single = file?.kind === "file" ? file : null;
  const kind = single ? getFileKind(single.content_type, single.name) : "other";
  const url = single ? api.publicPath(token, single.name, false, access) : "";
  const downloadUrl = single ? api.publicPath(token, single.name, true, access) : "";
  const hasThumbnail = Boolean(single?.thumbnails?.includes("thumb"));
  return (
    <div className="share-page">
      <header className="share-bar">
        <Brand tagline />
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
          <FolderShare token={token} folder={file} access={access} onPasswordRequired={() => load(access)}
            saveButton={saveButton} onSaveSelected={canSave ? paths => requestSave({ paths, label: paths.length === 1 ? paths[0].split("/").pop()! : `${paths.length} 个文件` }) : undefined} />
        ) : (
          <article className="share-card">
            <header className="share-head">
              <FileVisual kind={kind} src={hasThumbnail ? api.publicThumbnail(url) : undefined} size="lg" />
              <div className="share-title">
                <h1>{file.name}</h1>
                <p>
                  <span>{formatBytes(file.size)}</span><span>{kindLabel(kind)}</span><span>更新于 {formatDateTime(file.modified_at)}</span>
                  {file.expires_at && <span>链接有效期至 {formatDateTime(file.expires_at)}</span>}
                </p>
                <SharerLine token={token} sharer={file.sharer} access={access} />
              </div>
              <div className="share-actions">
                <Button icon="link" onClick={() => void copyText(`${window.location.origin}${window.location.pathname}`, "分享链接已复制")}>复制链接</Button>
                {saveButton({ label: file.name })}
                <a className="btn btn-primary btn-md" href={downloadUrl}><Icon name="download" size={17} /><span>下载</span></a>
              </div>
            </header>
            {canPreview(kind) && <div className="share-preview"><FilePreview kind={kind} url={url} name={file.name} downloadUrl={downloadUrl} contentType={file.content_type} poster={hasThumbnail ? api.publicThumbnail(url, "poster") : undefined} /></div>}
          </article>
        )}
        <p className="share-footnote">这是 {BRAND} 用户分享的{file?.kind === "folder" ? "文件夹" : "文件"}，只有拿到链接的人才能访问。</p>
      </main>
      {saving && <SaveDialog token={token} access={access} request={saving} onClose={() => setSaving(null)} onPasswordRequired={() => { setSaving(null); load(access); }} />}
      <Toaster />
    </div>
  );
}

/** 选择保存位置：复用文件页的目录浏览器（只能选普通目录，不能选私密空间）。 */
function SaveDialog({ token, access, request, onClose, onPasswordRequired }: { token: string; access: string | null; request: SaveRequest; onClose: () => void; onPasswordRequired: () => void }) {
  const [destination, setDestination] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const target = destination ? destination.replace(/\/$/, "").split("/").pop()! : "我的文件";
  async function save() {
    setBusy(true);
    try {
      const result = await api.saveShare(token, destination, access, request.paths);
      onClose();
      const opened = destination ? `/?path=${encodeURIComponent(destination)}` : "/";
      const saved = result.items.length === 1 ? `“${result.items[0].replace(/\/$/, "").split("/").pop()}”` : `${result.saved} 个文件`;
      toast.success(`已把${saved}保存到“${target}”`, { label: "打开", onClick: () => window.open(opened, "_blank", "noopener") });
    } catch (reason) {
      if (reason instanceof api.ApiError && reason.code === "password_required") { onPasswordRequired(); return; }
      toast.error(reason instanceof api.ApiError && reason.status === 413 ? "你的存储空间不足，无法保存" : api.errorMessage(reason, "保存失败，请稍后重试"));
    } finally { setBusy(false); }
  }
  return <Modal title={request.paths && request.paths.length > 1 ? `保存 ${request.label}` : `保存“${request.label}”`} icon="folderPlus" onClose={onClose}
    description={`保存到你的 ${BRAND} 文件中。内容不需要重新传输，立即完成，并计入你的存储空间；同名时自动改名。`}
    footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={!ready} onClick={() => void save()}>保存到“{target}”</Button></>}>
    <FolderPicker value={destination} onChange={next => { setReady(false); setDestination(next); }} onReady={setReady} />
  </Modal>;
}

/** 分享者：头像与昵称。分享者没有设置昵称时不显示（不退回邮箱）。 */
function SharerLine({ token, sharer, access }: { token: string; sharer?: api.PublicSharer | null; access: string | null }) {
  if (!sharer) return null;
  return <div className="share-sharer"><Avatar name={sharer.nickname} src={api.publicSharerAvatar(token, sharer, access)} size={20} /><span><strong>{sharer.nickname}</strong> 分享</span></div>;
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

/** 访客只读浏览：进入子文件夹、预览、单文件或打包下载。 */
function FolderShare({ token, folder, access, onPasswordRequired, saveButton, onSaveSelected }: {
  token: string; folder: api.PublicFolder; access: string | null; onPasswordRequired: () => void;
  saveButton: (request: SaveRequest) => ReactNode; onSaveSelected?: (paths: string[]) => void;
}) {
  const readPath = () => new URLSearchParams(window.location.search).get("path") ?? "";
  const [path, setPath] = useState(readPath);
  const [layout, setLayout] = useState<"list" | "grid">(() => localStorage.getItem("tgdrive:share-layout") === "grid" ? "grid" : "list");
  const [preview, setPreview] = useState<FolderPage["files"][number] | null>(null);
  const [entryFilter, setEntryFilter] = useState<EntryFilter>("all");
  const [kind, setKind] = useState<api.KindFilter>("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const downloadTarget = useId(), downloadFrame = useRef<HTMLIFrameElement>(null);
  useEffect(() => { setSelected(new Set()); }, [token, path, access, kind, entryFilter]);
  useEffect(() => { localStorage.setItem("tgdrive:share-layout", layout); }, [layout]);
  useEffect(() => {
    const pop = () => setPath(readPath());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const passwordRequired = useRef(onPasswordRequired);
  passwordRequired.current = onPasswordRequired;
  const fetchPage = useCallback(async (cursor: string | null, signal: AbortSignal) => {
    try { return await api.publicFolderList(token, path, cursor, access, 200, kind, signal); }
    catch (reason) {
      if (reason instanceof api.ApiError && reason.code === "password_required") passwordRequired.current();
      throw new Error(reason instanceof api.ApiError && reason.status === 404 ? "这个文件夹不存在，可能已被分享者移动或删除。" : api.errorMessage(reason, "加载失败，请稍后重试"));
    }
  }, [token, path, access, kind]);
  const pagination = useDirectory(fetchPage, mergePublicFolderPages);
  const page = pagination.page && { ...pagination.page, files: entryFilter === "folder" ? [] : pagination.page.files, folders: entryFilter === "file" ? [] : pagination.page.folders };
  const error = pagination.error;
  const load = pagination.reload;
  function open(next: string) {
    window.history.pushState(null, "", next ? `?path=${encodeURIComponent(next)}` : window.location.pathname);
    setPath(next);
  }
  const segments = path.split("/").filter(Boolean);
  const crumbs = [{ label: folder.name, path: "" }, ...segments.map((label, index) => ({ label, path: `${segments.slice(0, index + 1).join("/")}/` }))];
  const empty = page !== null && page.folders.length === 0 && page.files.length === 0;
  const selectedOnPage = page?.files.filter(file => selected.has(file.path)).length ?? 0;
  // 大文件夹分批挂载：先渲染文件夹，再按滚动追加文件。
  const rendered = useRenderLimit<unknown>([...(page?.folders ?? []), ...(page?.files ?? [])], fetchPage);
  const shownFolders = page?.folders.slice(0, rendered.visible.length) ?? [];
  const shownFiles = page?.files.slice(0, Math.max(0, rendered.visible.length - shownFolders.length)) ?? [];
  function selectFiles(paths: string[], checked: boolean) {
    const next = new Set(selected);
    for (const path of paths) { if (checked) next.add(path); else next.delete(path); }
    if (next.size > 1000) { toast.error("一次最多选择 1000 个文件，也可以下载当前目录的全部文件。"); return; }
    setSelected(next);
  }
  function downloadFiles(all = false) {
    if (!all && !selected.size) return;
    // 交给浏览器下载流，不用 fetch/Blob 把整个压缩包保存在前端内存里。
    const form = document.createElement("form");
    form.method = "POST"; form.action = api.publicFolderDownload(token); form.target = downloadTarget; form.hidden = true;
    for (const [name, value] of [["path", path], ["access", access ?? ""], ["all", all ? "1" : "0"],
      ...(!all ? [...selected].map(value => ["files", value]) : [])]) {
      const input = document.createElement("input"); input.type = "hidden"; input.name = name; input.value = value; form.append(input);
    }
    document.body.append(form); form.submit(); form.remove();
  }
  function downloadResponse() {
    const frameDocument = downloadFrame.current?.contentDocument;
    const body = frameDocument?.querySelector("pre")?.textContent ?? frameDocument?.body?.textContent;
    if (!body) return;
    try {
      const response = JSON.parse(body);
      if (response.error) {
        toast.error(response.error.message || "下载失败，请重试");
        if (response.error.code === "password_required") passwordRequired.current();
      }
    } catch { /* ZIP 下载由浏览器处理，只有 JSON 错误需要在页面中反馈。 */ }
  }
  return (
    <article className="share-card share-folder">
      <header className="share-head">
        <FileTile kind="folder" size="lg" />
        <div className="share-title">
          <h1>{folder.name}</h1>
          <p><span>公开文件夹</span><span>更新于 {formatDateTime(folder.modified_at)}</span>{folder.expires_at && <span>链接有效期至 {formatDateTime(folder.expires_at)}</span>}</p>
          <SharerLine token={token} sharer={folder.sharer} access={access} />
        </div>
        <div className="share-actions">
          <Button icon="link" onClick={() => void copyText(`${window.location.origin}${window.location.pathname}`, "分享链接已复制")}>复制链接</Button>
          {saveButton({ label: folder.name })}
          <Button icon="download" disabled={!page || Boolean(error) || !kind && !pagination.loadingMore && !pagination.page?.files.length} title="打包下载当前目录的全部文件（不受类型筛选影响），不包含子文件夹" onClick={() => downloadFiles(true)}>下载全部文件</Button>
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
      <div className="share-folder-toolbar">
        <div className="share-selection">
          {layout === "grid" && Boolean(page?.files.length) && <label className="share-select-all"><Checkbox label="全选当前文件" checked={selectedOnPage === page!.files.length}
            indeterminate={selectedOnPage > 0 && selectedOnPage < page!.files.length} onChange={checked => selectFiles(page!.files.map(file => file.path), checked)} /><span>全选当前文件</span></label>}
          <span className="muted">{selected.size ? `已选择 ${selected.size} 个文件` : page ? `共 ${page.folders.length + page.files.length} 项` : "文件夹内容"}</span>
          <Button size="sm" variant={selected.size ? "primary" : "secondary"} icon="download" disabled={!selected.size} title="将所选文件打包为 ZIP" onClick={() => downloadFiles()}>下载所选</Button>
          {onSaveSelected && selected.size > 0 && <Button size="sm" icon="folderPlus" title={`把所选文件保存到你的 ${BRAND}`} onClick={() => onSaveSelected([...selected])}>保存所选</Button>}
          {selected.size > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>清空选择</Button>}
        </div>
        <Segmented label="视图" value={layout} onChange={setLayout} options={[{ value: "list", label: "列表视图", icon: "list" }, { value: "grid", label: "网格视图", icon: "gridView" }]} />
      </div>
      <div className="share-folder-filters"><FileFilters entry={entryFilter} kind={kind} onEntryChange={setEntryFilter} onKindChange={setKind} /></div>
      {error ? <EmptyState icon="alert" title="无法打开" description={error} action={path ? <Button onClick={() => open("")}>回到根目录</Button> : <Button icon="refresh" onClick={() => void load()}>重试</Button>} />
        : page === null ? <div className="share-folder-loading"><SkeletonRows rows={4} /></div>
          : empty ? (entryFilter === "folder" ? <EmptyState icon="folder" title="这个目录没有子文件夹" action={<Button onClick={() => setEntryFilter("all")}>显示全部项目</Button>} /> : kind ? <EmptyState icon="search" title={`这个文件夹里没有${api.kindFilterLabel(kind)}`} description="类型筛选只看当前文件夹，不包含子文件夹。" action={<Button onClick={() => setKind("")}>显示全部类型</Button>} />
            : entryFilter === "file" ? <EmptyState icon="file" title="这个目录没有文件" action={<Button onClick={() => setEntryFilter("all")}>显示全部项目</Button>} />
              : <EmptyState icon="folder" title="这个文件夹是空的" description="分享者之后添加的文件会显示在这里。" />)
            : layout === "list" ? (
              <div className="data-table public-folder-table" role="table" aria-label="文件夹内容">
                <div className="data-row data-head" role="row">
                  <span role="columnheader" className="cell-check"><Checkbox label="全选当前文件" checked={page.files.length > 0 && selectedOnPage === page.files.length}
                    indeterminate={selectedOnPage > 0 && selectedOnPage < page.files.length} onChange={checked => selectFiles(page.files.map(file => file.path), checked)} /></span>
                  <span role="columnheader" className="cell-name">名称</span>
                  <span role="columnheader" className="cell-type">类型</span>
                  <span role="columnheader" className="cell-size">大小</span>
                  <span role="columnheader" className="cell-date">修改时间</span>
                  <span role="columnheader" className="cell-actions"><span className="sr-only">操作</span></span>
                </div>
                {shownFolders.map(item => (
                  <div key={item.path} role="row" className="data-row is-clickable" onClick={() => open(item.path)}>
                    <span role="cell" className="cell-check" />
                    <span role="cell" className="cell-name"><FileTile kind="folder" /><span className="public-file-details">
                      <button type="button" className="name-button" title={item.name} onClick={event => { event.stopPropagation(); open(item.path); }}>{item.name}</button>
                      <span className="public-file-meta">文件夹 · {item.size == null ? "—" : formatBytes(item.size)}</span>
                    </span></span>
                    <span role="cell" className="cell-type muted">文件夹</span>
                    <span role="cell" className="cell-size muted" title="包含所有子文件夹中的文件">{item.size == null ? "—" : formatBytes(item.size)}</span>
                    <span role="cell" className="cell-date muted">—</span>
                    <span role="cell" className="cell-actions" />
                  </div>
                ))}
                {shownFiles.map(item => {
                  const kind = getFileKind(item.content_type, item.name);
                  const previewable = canPreview(kind);
                  const download = api.publicFolderFile(token, item.path, true, access);
                  return (
                    <div key={item.path} role="row" className={`data-row is-clickable${selected.has(item.path) ? " is-selected" : ""}`} onClick={() => previewable ? setPreview(item) : window.location.assign(download)}>
                      <span role="cell" className="cell-check" onClick={event => event.stopPropagation()}><Checkbox label={`选择 ${item.name}`} checked={selected.has(item.path)} onChange={checked => selectFiles([item.path], checked)} /></span>
                      <span role="cell" className="cell-name"><FileVisual kind={kind} src={item.thumbnails?.includes("thumb") ? api.publicThumbnail(api.publicFolderFile(token, item.path, false, access)) : undefined} />
                        <span className="public-file-details"><a className="name-button" title={item.name} href={previewable ? api.publicFolderFile(token, item.path, false, access) : download} onClick={event => { event.preventDefault(); event.stopPropagation(); if (previewable) setPreview(item); else window.location.assign(download); }}>{item.name}</a>
                          <span className="public-file-meta">{kindLabel(kind)} · {formatBytes(item.size)}</span>
                        </span>
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
            ) : (
              <div className="file-grid share-grid">
                {shownFolders.map(item => (
                  <div key={item.path} className="grid-card" onClick={() => open(item.path)}>
                    <div className="grid-thumb"><FolderThumbnail previews={(item.previews ?? []).map(file => ({ ...file, key: file.path,
                      url: api.publicThumbnail(api.publicFolderFile(token, file.path, false, access)) }))} /></div>
                    <div className="grid-meta">
                      <button type="button" className="grid-name name-button" title={item.name} onClick={event => { event.stopPropagation(); open(item.path); }}><span className="grid-name-text">{item.name}</span></button>
                      <span className="grid-sub" title="包含所有子文件夹中的文件"><span className="grid-kind">文件夹</span>{" · "}<span className="grid-size">{item.size == null ? "—" : formatBytes(item.size)}</span></span>
                    </div>
                  </div>
                ))}
                {shownFiles.map(item => {
                  const kind = getFileKind(item.content_type, item.name);
                  const content = api.publicFolderFile(token, item.path, false, access);
                  const download = api.publicFolderFile(token, item.path, true, access);
                  const openFile = () => canPreview(kind) ? setPreview(item) : window.location.assign(download);
                  return <div key={item.path} className={`grid-card${selected.has(item.path) ? " is-selected" : ""}`} onClick={openFile}>
                    <div className="grid-thumb"><FileThumbnail kind={kind} url={item.thumbnails?.includes("thumb") ? api.publicThumbnail(content, "grid") : undefined}
                      placeholder={item.thumbnails?.includes("thumb") ? api.publicThumbnail(content) : undefined} />
                      <span className="grid-check" onClick={event => event.stopPropagation()}><Checkbox label={`选择 ${item.name}`} checked={selected.has(item.path)} onChange={checked => selectFiles([item.path], checked)} /></span>
                    </div>
                    <div className="grid-meta">
                      <button type="button" className="grid-name name-button" title={item.name} onClick={event => { event.stopPropagation(); openFile(); }}><span className="grid-name-text">{item.name}</span></button>
                      <span className="grid-sub"><span className="grid-kind">{kindLabel(kind)}</span>{" · "}<span className="grid-size">{formatBytes(item.size)}</span></span>
                      <span className="grid-menu" onClick={event => event.stopPropagation()}>
                        <a className="icon-btn icon-btn-ghost icon-btn-sm" href={download} aria-label={`下载 ${item.name}`} title={`下载 ${item.name}`}><Icon name="download" size={16} /></a>
                      </span>
                    </div>
                  </div>;
                })}
              </div>
            )}
      {rendered.more && !error && <div ref={rendered.sentinel} className="list-sentinel" aria-hidden="true" />}
      {pagination.loadingMore && <p className="muted" role="status">正在读取其余项目…</p>}
      <iframe ref={downloadFrame} name={downloadTarget} title="文件下载响应" hidden onLoad={downloadResponse} />
      {preview && (
        <PreviewModal file={{ ...preview, key: preview.path }} onClose={() => setPreview(null)}
          poster={preview.thumbnails?.includes("thumb") ? api.publicThumbnail(api.publicFolderFile(token, preview.path, false, access), "poster") : undefined}
          thumbnail={preview.thumbnails?.includes("thumb") ? api.publicThumbnail(api.publicFolderFile(token, preview.path, false, access)) : undefined}
          url={api.publicFolderFile(token, preview.path, false, access)} downloadUrl={api.publicFolderFile(token, preview.path, true, access)}
          loadAssets={(file, signal) => api.publicPreviewAssets(token, file.key, access, signal)} assetUrl={path => api.publicFolderFile(token, path, false, access)}
          playlistFiles={page?.files.map(file => ({ ...file, key: file.path }))}
          sourceFor={file => { const url = api.publicFolderFile(token, file.key, false, access); return { url, downloadUrl: api.publicFolderFile(token, file.key, true, access), poster: file.thumbnails?.includes("thumb") ? api.publicThumbnail(url, "poster") : undefined, thumbnail: file.thumbnails?.includes("thumb") ? api.publicThumbnail(url) : undefined }; }} />
      )}
    </article>
  );
}
