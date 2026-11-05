/** 压缩包预览：不解压就能按目录浏览 ZIP 里的文件，打开其中的图片、文本、代码、PDF 等，或单独下载某个文件。
 * 服务器只解出被打开的那一个文件（边读边解压，见 extract.py 的 browse／entry）；TAR 没有目录索引，只能解压后查看。 */
import { useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import * as api from "./api";
import { FileGlyph, FilePreview, canPreview, getFileKind } from "./files";
import { PreviewToolsContext } from "./preview-text";
import { archiveChildren, expandSelection, folderCounts, folderState, type ArchiveItem as Item } from "./archive-selection";
import { Button, ButtonLink, Checkbox, Icon, IconButton, formatBytes } from "./ui";

/** 压缩包里的文件预览前要整个读出来：音视频只能顺序读取、不能拖动，超过这个大小改为下载。 */
const ENTRY_PREVIEW_LIMIT = 256 * 1024 * 1024;

type Listing = Awaited<ReturnType<typeof api.browseArchive>>;
/** onExtract：解压（本人的压缩包才有）；picks 是勾选的文件，不传表示整个压缩包。 */
export function ArchivePreview({ file, downloadUrl, onExtract }: { file: api.FileItem; downloadUrl: string; onExtract?: (picks?: string[]) => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [folder, setFolder] = useState("");
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<api.ArchiveEntry | null>(null);
  // 勾选要解压的文件（文件名集合；勾选文件夹即选中其中全部文件）。
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const tools = useContext(PreviewToolsContext);
  useEffect(() => {
    let alive = true;
    setListing(null); setError(""); setFolder(""); setOpened(null); setPicked(new Set());
    void api.browseArchive(file.key).then(value => { if (alive) setListing(value); })
      .catch(reason => { if (alive) setError(api.errorMessage(reason, "压缩包没有打开")); });
    return () => { alive = false; };
  }, [file.key, file.etag]);
  const entries = listing?.entries ?? [];
  const totals = useMemo(() => entries.reduce((sum, entry) => entry.dir ? sum : { files: sum.files + 1, bytes: sum.bytes + entry.size, packed: sum.packed + entry.compressed }, { files: 0, bytes: 0, packed: 0 }), [entries]);
  const terms = query.trim().toLowerCase();
  const items = useMemo((): Item[] => terms
    ? entries.filter(entry => !entry.dir && entry.name.toLowerCase().includes(terms)).slice(0, 1000).map(entry => ({ name: entry.name, path: entry.name, dir: false, size: entry.size, entry, files: 1 }))
    : archiveChildren(entries, folder), [entries, folder, terms]);
  const selecting = Boolean(onExtract && listing?.listable);
  const counts = useMemo(() => folderCounts(entries, picked), [entries, picked]);
  const pickedBytes = useMemo(() => entries.reduce((sum, entry) => !entry.dir && picked.has(entry.name) ? sum + entry.size : sum, 0), [entries, picked]);
  const toggle = (item: Item, on: boolean) => setPicked(current => {
    const next = new Set(current);
    for (const name of item.dir ? expandSelection(entries, [item.path]) : [item.path]) { if (on) next.add(name); else next.delete(name); }
    return next;
  });
  const extract = onExtract && (picked.size
    ? <><Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>取消选择</Button>
      <Button size="sm" variant="primary" icon="archive" onClick={() => onExtract([...picked])}>解压选中的 {picked.size.toLocaleString()} 个文件…</Button></>
    : <Button size="sm" variant="primary" icon="archive" onClick={() => onExtract()}>{listing?.listable ? "全部解压到…" : "解压到…"}</Button>);
  const toolbar = <div className="preview-text-tools">{opened
    ? <Button size="sm" variant="ghost" icon="chevronLeft" onClick={() => setOpened(null)}>返回压缩包</Button>
    : extract}</div>;
  const header = tools ? createPortal(toolbar, tools.target) : toolbar;

  if (error) return <div className="preview-fallback"><span className="file-tile tile-archive tile-xl" aria-hidden="true"><FileGlyph kind="archive" size={56} /></span>
    <h3>压缩包没有打开</h3><p>{error}</p>
    <div className="preview-recovery">{extract}<ButtonLink size="sm" icon="download" href={downloadUrl}>下载文件</ButtonLink></div></div>;
  if (!listing) return <div className="preview-engine-loading" role="status"><span className="spinner" />正在读取压缩包目录…</div>;
  if (!listing.listable) return <>{header}<div className="preview-fallback">
    <span className="file-tile tile-archive tile-xl" aria-hidden="true"><FileGlyph kind="archive" size={56} /></span>
    <h3>{listing.format.toUpperCase()} 压缩包不能直接浏览</h3>
    <p>{/^(gz|bz2|xz)$/.test(listing.format) ? "这是单个文件的压缩包，解压后得到一个文件。" : "TAR 压缩包没有目录索引，要读完整个压缩包才知道里面有什么。"}可以在线解压到网盘，或下载后在本地打开。</p>
    <div className="preview-recovery">{extract}<ButtonLink size="sm" variant={onExtract ? "secondary" : "primary"} icon="download" href={downloadUrl}>下载文件</ButtonLink></div>
  </div></>;

  if (opened) {
    const name = opened.name.split("/").pop() ?? opened.name, kind = getFileKind(null, name);
    const url = api.archiveEntryUrl(file.key, opened.index, listing.etag), download = api.archiveEntryUrl(file.key, opened.index, listing.etag, true);
    return <>{header}<div className="preview-pane preview-archive-entry">
      <div className="preview-archive-path"><Icon name="archive" size={14} /><span title={opened.name}>{opened.name}</span><span className="muted">{formatBytes(opened.size)}</span>
        <ButtonLink size="sm" variant="ghost" icon="download" href={download}>下载</ButtonLink></div>
      <div className="preview-archive-content"><PreviewToolsContext.Provider value={null}><FilePreview kind={kind} url={url} name={name} size={opened.size} downloadUrl={download} /></PreviewToolsContext.Provider></div>
    </div></>;
  }

  const crumbs = folder ? folder.slice(0, -1).split("/") : [];
  return <>{header}<div className="preview-pane preview-archive">
    <div className="preview-table-bar">
      {selecting && <span className="preview-archive-check"><Checkbox label={terms ? "选择全部搜索结果" : "选择这个文件夹里的全部文件"}
        checked={items.length > 0 && items.every(item => item.dir ? folderState(counts, item.path) === "all" : picked.has(item.path))}
        indeterminate={items.some(item => item.dir ? folderState(counts, item.path) !== "none" : picked.has(item.path))
          && !items.every(item => item.dir ? folderState(counts, item.path) === "all" : picked.has(item.path))}
        onChange={on => { for (const item of items) toggle(item, on); }} /></span>}
      <nav className="preview-archive-crumbs" aria-label="压缩包内的位置">
        <button type="button" disabled={!folder || Boolean(terms)} onClick={() => setFolder("")}><Icon name="archive" size={14} />{file.key.split("/").pop()}</button>
        {!terms && crumbs.map((part, position) => <span key={position}><Icon name="chevronRight" size={12} />
          <button type="button" disabled={position === crumbs.length - 1} onClick={() => setFolder(crumbs.slice(0, position + 1).join("/") + "/")}>{part}</button></span>)}
      </nav>
      <span className="preview-table-spacer" />
      <label className="preview-table-search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="搜索压缩包里的文件" aria-label="搜索压缩包里的文件" value={query} spellCheck={false} onChange={event => setQuery(event.target.value)} />
      </label>
      <span className="preview-table-count">{picked.size ? `已选 ${picked.size.toLocaleString()} / ${totals.files.toLocaleString()} 个文件 · ${formatBytes(pickedBytes)}`
        : `${totals.files.toLocaleString()} 个文件 · ${formatBytes(totals.bytes)}${totals.bytes ? ` · 压缩后 ${formatBytes(totals.packed)}` : ""}`}</span>
    </div>
    <ul className="preview-archive-list" role="list">
      {folder && !terms && <li><button type="button" className="preview-archive-row" onClick={() => setFolder(folder.slice(0, -1).split("/").slice(0, -1).join("/").replace(/(.)$/, "$1/"))}>
        <Icon name="chevronLeft" size={16} /><span className="preview-archive-name">上一级</span></button></li>}
      {items.map(item => {
        const kind = item.dir ? "folder" : getFileKind(null, item.name);
        const entry = item.entry, blocked = entry && (entry.encrypted ? "已加密" : !entry.supported ? "压缩方式不支持" : null);
        const viewable = entry && !blocked && canPreview(kind, item.name) && (kind !== "video" && kind !== "audio" || entry.size <= ENTRY_PREVIEW_LIMIT);
        return <li key={item.path}>
          <div className={`preview-archive-row${blocked ? " is-blocked" : ""}${selecting ? " is-selectable" : ""}`}>
            {selecting && (() => {
              const state = item.dir ? folderState(counts, item.path) : picked.has(item.path) ? "all" : "none";
              return <span className="preview-archive-check"><Checkbox label={`选择 ${item.name}`} checked={state === "all"} indeterminate={state === "some"} onChange={on => toggle(item, on)} /></span>;
            })()}
            <button type="button" className="preview-archive-open" disabled={Boolean(entry && !viewable)} title={blocked ?? (entry && !viewable ? "这种文件不能在线查看，可以下载" : undefined)}
              onClick={() => item.dir ? setFolder(item.path) : entry && viewable && setOpened(entry)}>
              <FileGlyph kind={kind} size={22} />
              <span className="preview-archive-name">{item.name}</span>
              {blocked && <span className="preview-archive-tag">{blocked}</span>}
            </button>
            <span className="preview-archive-meta">{item.dir ? `${item.files.toLocaleString()} 个文件` : entry?.modified ?? ""}</span>
            <span className="preview-archive-size">{formatBytes(item.size)}</span>
            <span className="preview-archive-action">{entry && !blocked && <IconButton icon="download" label={`下载 ${item.name}`} size="sm" onClick={() => window.location.assign(api.archiveEntryUrl(file.key, entry.index, listing.etag, true))} />}</span>
          </div>
        </li>;
      })}
      {!items.length && <li className="preview-table-empty">{terms ? `没有名称包含“${query.trim()}”的文件` : "这个文件夹是空的"}</li>}
    </ul>
  </div></>;
}
