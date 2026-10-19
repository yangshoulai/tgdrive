import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as api from "../api";
import { FileTile, getFileKind, matchesKindFilter } from "../files";
import { useRenderLimit } from "../pagination";
import { Badge, Button, Checkbox, Icon, Menu, SearchInput, formatBytes } from "../ui";

/** 相对于目标目录的路径，包含用户所选文件夹本身；File 保持原始字节与名称。 */
export type UploadFile = { file: File; path: string };

function validateFiles(items: UploadFile[]): UploadFile[] {
  const paths = new Set<string>();
  return items.map(({ file, path }) => {
    const normalized = path.normalize("NFC");
    if (/[\\\u0000-\u001f\u007f]/.test(normalized) || normalized.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error(`“${file.name}”的路径无效，请调整名称后重新选择`);
    }
    if (paths.has(normalized)) throw new Error(`“${normalized}”在本次上传中重名，请调整名称后重新选择`);
    paths.add(normalized);
    return { file, path: normalized };
  });
}

export function uploadFiles(files: FileList | File[]): UploadFile[] {
  return validateFiles(Array.from(files).map(file => ({ file, path: file.webkitRelativePath || file.name })));
}

/** 拖入目录时逐批读取目录项，避免把不同子目录的同名文件压平成同一路径。 */
export async function droppedUploadFiles(transfer: DataTransfer): Promise<UploadFile[]> {
  // 拖放数据只在事件期间可读，必须先同步取得条目和文件，再开始异步遍历。
  const entries = Array.from(transfer.items).filter(item => item.kind === "file")
    .map(item => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  if (!entries.length) return uploadFiles(transfer.files);
  const files: UploadFile[] = [];
  async function read(entry: FileSystemEntry, parent: string) {
    const path = `${parent}${entry.name}`;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      files.push({ file, path });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await read(child, `${path}/`);
      }
    }
  }
  for (const { entry, file } of entries) {
    if (entry) await read(entry, "");
    else if (file) files.push({ file, path: file.webkitRelativePath || file.name });
  }
  return validateFiles(files);
}

export function UploadPicker({ onPick, shortcut }: { onPick: (files: FileList | null) => void; shortcut?: string }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const supportsFolders = "webkitdirectory" in document.createElement("input");
  useEffect(() => { if (folderInput.current) folderInput.current.webkitdirectory = true; }, []);
  return <>
    <Menu label="上传" size="md" shortcut={shortcut} className="upload-picker-trigger" items={[
      { label: "上传文件", description: "选择一个或多个文件", icon: "file", onSelect: () => fileInput.current?.click() },
      { label: "上传文件夹", description: supportsFolders ? "保留文件夹名称与层级" : "当前浏览器不支持选择文件夹", icon: "folder", disabled: !supportsFolders, onSelect: () => folderInput.current?.click() },
    ]}><Icon name="upload" size={17} /><span>上传</span><Icon name="chevronDown" size={13} /></Menu>
    <input ref={fileInput} type="file" multiple hidden aria-label="选择上传文件" onChange={event => { onPick(event.target.files); event.target.value = ""; }} />
    <input ref={folderInput} type="file" multiple hidden aria-label="选择上传文件夹" onChange={event => { onPick(event.target.files); event.target.value = ""; }} />
  </>;
}

type UploadNode = { path: string; name: string; file?: UploadFile; children: UploadNode[]; start: number; end: number; size: number };
const COLLATOR = new Intl.Collator("zh-CN", { numeric: true });

function buildTree(files: UploadFile[]) {
  const root: UploadNode = { path: "", name: "", children: [], start: 0, end: 0, size: 0 };
  const folders = new Map<string, UploadNode>([["", root]]);
  for (const item of files) {
    const parts = item.path.split("/");
    let parent = root, path = "";
    parts.forEach((name, index) => {
      const isFile = index === parts.length - 1;
      path += `${name}${isFile ? "" : "/"}`;
      let node = isFile ? undefined : folders.get(path);
      if (!node) {
        node = { path, name, file: isFile ? item : undefined, children: [], start: 0, end: 0, size: 0 };
        parent.children.push(node);
        if (!isFile) folders.set(path, node);
      }
      parent = node;
    });
  }
  const ordered: UploadFile[] = [];
  function index(node: UploadNode) {
    node.start = ordered.length;
    if (node.file) { ordered.push(node.file); node.size = node.file.file.size; }
    else {
      node.children.sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || COLLATOR.compare(a.name, b.name));
      node.children.forEach(child => { index(child); node.size += child.size; });
    }
    node.end = ordered.length;
  }
  index(root);
  return { root, ordered };
}

export function UploadSelection({ files, selected, onChange, existing }: {
  files: UploadFile[]; selected: Set<string>; onChange: (paths: Set<string>) => void; existing: Set<string>;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<api.KindFilter>("");
  const [hidden, setHidden] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set(tree.root.children.filter(node => !node.file).map(node => node.path)));
  const [collapsedMatches, setCollapsedMatches] = useState(new Set<string>());
  const filterKey = `${search.trim()}\n${kind}\n${hidden}`;
  useEffect(() => { setCollapsedMatches(new Set()); }, [filterKey]);
  const filtering = Boolean(search.trim() || kind || hidden);
  const matching = useMemo(() => {
    const words = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return new Set(files.filter(({ file, path }) => {
      const lower = path.toLocaleLowerCase(), parts = lower.split("/");
      // 点开头的查询只匹配名称开头，不会把每个带扩展名的文件都当成隐藏文件。
      return (!hidden || parts.some(part => part.startsWith(".")))
        && words.every(word => word.startsWith(".") ? parts.some(part => part.startsWith(word)) : lower.includes(word))
        && matchesKindFilter({ content_type: file.type, key: path }, kind);
    }).map(item => item.path));
  }, [files, search, kind, hidden]);
  // 子树在排序后的文件数组中连续；前缀计数让每行的勾选状态不必重复遍历所有后代。
  const counts = useMemo(() => {
    const matched = [0], checked = [0];
    tree.ordered.forEach((item, index) => {
      const match = matching.has(item.path);
      matched.push(matched[index] + Number(match));
      checked.push(checked[index] + Number(match && selected.has(item.path)));
    });
    return (node: UploadNode) => ({ total: matched[node.end] - matched[node.start], checked: checked[node.end] - checked[node.start] });
  }, [tree, matching, selected]);
  const rows = useMemo(() => {
    const result: { node: UploadNode; depth: number; open: boolean }[] = [];
    function visit(node: UploadNode, depth: number) {
      if (!counts(node).total) return;
      const open = !node.file && (filtering ? !collapsedMatches.has(node.path) : expanded.has(node.path));
      result.push({ node, depth, open });
      if (open) node.children.forEach(child => visit(child, depth + 1));
    }
    tree.root.children.forEach(node => visit(node, 0));
    return result;
  }, [tree, counts, filtering, expanded, collapsedMatches]);
  const rendered = useRenderLimit(rows, filterKey, 200);
  const chosenKinds = api.kindValues(kind);
  const all = counts(tree.root);
  function select(node: UploadNode, checked: boolean) {
    const next = new Set(selected);
    for (let index = node.start; index < node.end; index++) {
      const { path } = tree.ordered[index];
      if (matching.has(path)) { if (checked) next.add(path); else next.delete(path); }
    }
    onChange(next);
  }
  function toggle(node: UploadNode) {
    const update = (current: Set<string>) => { const next = new Set(current); if (next.has(node.path)) next.delete(node.path); else next.add(node.path); return next; };
    if (filtering) setCollapsedMatches(update); else setExpanded(update);
  }
  const clear = () => { setSearch(""); setKind(""); setHidden(false); };
  return <div className="upload-selection">
    <SearchInput value={search} onChange={setSearch} label="筛选待上传文件" placeholder="筛选名称或路径，输入 . 查找隐藏文件" />
    <div className="filter-chips upload-type-filters" role="group" aria-label="待上传文件类型（可多选）">
      <button type="button" className={`filter-chip${!kind && !hidden ? " is-active" : ""}`} aria-pressed={!kind && !hidden} onClick={() => { setKind(""); setHidden(false); }}>全部</button>
      {api.KIND_FILTERS.map(option => <button key={option.value} type="button" className={`filter-chip is-multi${chosenKinds.includes(option.value) ? " is-active" : ""}`} aria-pressed={chosenKinds.includes(option.value)} onClick={() => setKind(current => api.toggleKind(current, option.value))}>
        {chosenKinds.includes(option.value) && <Icon name="check" size={12} />}{option.label}
      </button>)}
      <button type="button" className={`filter-chip is-multi${hidden ? " is-active" : ""}`} aria-pressed={hidden} onClick={() => setHidden(current => !current)}>{hidden && <Icon name="check" size={12} />}隐藏文件</button>
    </div>
    <div className="upload-tree-surface">
      <div className="upload-selection-bar">
        <label><Checkbox label="全选当前筛选结果" checked={all.total > 0 && all.checked === all.total} indeterminate={all.checked > 0 && all.checked < all.total} onChange={checked => select(tree.root, checked)} /><span>全选{filtering ? "结果" : "文件"}</span></label>
        <span className="muted" role="status">{filtering ? `匹配 ${matching.size} 个文件` : `${files.length} 个文件`}</span>
      </div>
      <div className="upload-tree-scroll">
        <ul className="upload-tree" aria-label="待上传文件与文件夹">
          {rendered.visible.map(({ node, depth, open }) => {
            const { total, checked } = counts(node);
            return <li key={node.path} className={`upload-tree-row${!node.file ? " is-folder" : ""}${checked === 0 ? " is-excluded" : ""}`} style={{ "--upload-depth": Math.min(depth, 6) } as CSSProperties}>
              <label className="upload-tree-check"><Checkbox label={`选择 ${node.path}`} checked={checked === total} indeterminate={checked > 0 && checked < total} onChange={value => select(node, value)} /></label>
              {node.file ? <span className="upload-tree-name" title={node.path}><span className="upload-tree-spacer" /><FileTile kind={getFileKind(node.file.file.type, node.path)} /><span>{node.name}</span></span>
                : <button type="button" className="upload-tree-name" title={node.path} aria-label={`${open ? "收起" : "展开"} ${node.path}`} aria-expanded={open} onClick={() => toggle(node)}>
                  <Icon name={open ? "chevronDown" : "chevronRight"} size={14} /><FileTile kind="folder" /><span>{node.name}</span>
                </button>}
              {node.file && existing.has(node.path) && <Badge tone="warning">将覆盖</Badge>}
              <span className="upload-tree-meta muted">{node.file ? formatBytes(node.size) : `${total} 个文件`}</span>
            </li>;
          })}
        </ul>
        {rendered.more && <div ref={rendered.sentinel} className="list-sentinel" aria-hidden="true" />}
        {!rows.length && <div className="upload-selection-empty"><Icon name="search" size={24} /><span>没有匹配的文件</span><Button variant="ghost" size="sm" onClick={clear}>清除筛选</Button></div>}
      </div>
    </div>
    <p className="upload-selection-hint muted">{filtering ? "勾选框只调整当前匹配的文件；其他已选文件仍会上传。" : "默认选中全部文件；取消勾选文件夹可排除其中的所有文件。"}</p>
  </div>;
}
