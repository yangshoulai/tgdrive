/** 聊天框附件（docs/assistant-design.md §22.5）：选择、粘贴或拖入的文件经普通上传接口保存到 /助手附件/<年-月>/，
 * 不覆盖同名文件；图片上传后先在浏览器生成预览图（识图模型看的是预览图），完成后附件才算就绪。 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { FileGlyph, getFileKind } from "../files";
import { createThumbnails, saveThumbnails, thumbnailSource } from "../thumbnails";
import { Icon, formatBytes, toast } from "../ui";

export const ATTACHMENT_ROOT = "助手附件/";
export const MAX_ATTACHMENTS = 10;
// 单个附件走一次 PUT 上传；更大的文件请在文件页上传（支持分块与续传）。
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

export type Attachment = {
  id: string; file: File; name: string; path: string | null; image: boolean; preview: string | null;
  status: "uploading" | "processing" | "ready" | "error"; percent: number; error?: string;
};

const pad = (value: number) => String(value).padStart(2, "0");
const monthFolder = (date = new Date()) => `${ATTACHMENT_ROOT}${date.getFullYear()}-${pad(date.getMonth() + 1)}/`;

/** 粘贴的截图浏览器一般命名为 image.png，换成带时间的名称。 */
function attachmentName(file: File, pasted: boolean) {
  const name = file.name.replace(/[\\/\u0000-\u001f]/g, "_").trim();
  if (pasted && file.type.startsWith("image/") && (!name || /^image\.(png|jpe?g|gif|webp)$/i.test(name))) {
    const now = new Date();
    const ext = (/^image\/(png|jpeg|gif|webp)$/.exec(file.type)?.[1] ?? "png").replace("jpeg", "jpg");
    return `截图 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.${ext}`;
  }
  return name || "未命名文件";
}

/** 每个目录只列一次已有文件名；本页面已占用的名称也记在里面，同一批附件不会互相覆盖。 */
const knownNames = new Map<string, Promise<Set<string>>>();
function namesIn(folder: string) {
  let names = knownNames.get(folder);
  if (!names) {
    names = (async () => {
      const result = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const data: api.ListPage = await api.listFiles(folder, cursor, false, 1000);
        data.objects.forEach(item => result.add(item.key.slice(folder.length)));
        cursor = data.next_cursor;
        if (!cursor) break;
      }
      return result;
    })();
    names.catch(() => knownNames.delete(folder));
    knownNames.set(folder, names);
  }
  return names;
}
async function reserve(folder: string, name: string) {
  const names = await namesIn(folder);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let candidate = name;
  for (let index = 2; names.has(candidate); index++) candidate = `${stem} (${index})${ext}`;
  names.add(candidate);
  return folder + candidate;
}

export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const aborts = useRef(new Map<string, () => void>());
  const update = useCallback((id: string, patch: Partial<Attachment>) =>
    setItems(current => current.map(item => item.id === id ? { ...item, ...patch } : item)), []);

  const upload = useCallback(async (item: Attachment) => {
    update(item.id, { status: "uploading", percent: 0, error: undefined });
    try {
      const folder = monthFolder();
      const path = item.path ?? await reserve(folder, item.name);
      update(item.id, { path });
      const task = api.uploadFileWithProgress(path, item.file, { onProgress: progress => update(item.id, { percent: progress.percent }) });
      aborts.current.set(item.id, task.abort);
      const saved = await task.promise;
      aborts.current.delete(item.id);
      const source = thumbnailSource(item.name, item.file.type, item.file.size);
      if (source && !saved.thumbnails?.length) {
        // 识图模型看的是预览图：先生成再算就绪；生成失败不阻止发送（服务端会改用受支持格式的小原图或说明原因）。
        update(item.id, { status: "processing", percent: 100 });
        await createThumbnails({ file: item.file }, source).then(value => saveThumbnails(path, value)).catch(() => undefined);
      }
      update(item.id, { status: "ready", percent: 100 });
      window.dispatchEvent(new CustomEvent("tessera:files-added", { detail: { folders: [folder] } }));
    } catch (reason) {
      aborts.current.delete(item.id);
      if (reason instanceof api.ApiError && reason.code === "upload_aborted") return;
      update(item.id, { status: "error", error: api.errorMessage(reason, "上传失败") });
    }
  }, [update]);

  const add = useCallback((files: File[], pasted = false) => {
    setItems(current => {
      const room = MAX_ATTACHMENTS - current.length;
      if (room <= 0) { toast.error(`一条消息最多 ${MAX_ATTACHMENTS} 个附件`); return current; }
      if (files.length > room) toast.error(`一条消息最多 ${MAX_ATTACHMENTS} 个附件，只添加了前 ${room} 个`);
      const accepted: Attachment[] = [];
      for (const file of files.slice(0, room)) {
        if (file.size > MAX_ATTACHMENT_BYTES) { toast.error(`${file.name} 超过 64 MB，请在文件页上传后用 @ 引用`); continue; }
        const name = attachmentName(file, pasted);
        const image = getFileKind(file.type, name) === "image";
        accepted.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, name, path: null, image,
          preview: image ? URL.createObjectURL(file) : null, status: "uploading", percent: 0 });
      }
      window.setTimeout(() => accepted.forEach(item => void upload(item)), 0);
      return [...current, ...accepted];
    });
  }, [upload]);

  const remove = useCallback((id: string) => {
    aborts.current.get(id)?.();
    aborts.current.delete(id);
    setItems(current => {
      const item = current.find(entry => entry.id === id);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return current.filter(entry => entry.id !== id);
    });
  }, []);

  /** 发送后清空托盘（文件已保存，只是不再挂在输入框上）。 */
  const clear = useCallback(() => setItems(current => {
    current.forEach(item => { if (item.preview) URL.revokeObjectURL(item.preview); aborts.current.get(item.id)?.(); });
    aborts.current.clear();
    return [];
  }), []);

  useEffect(() => () => { aborts.current.forEach(abort => abort()); }, []);

  const pending = items.some(item => item.status === "uploading" || item.status === "processing");
  const failed = items.some(item => item.status === "error");
  return {
    items, add, remove, clear, retry: (id: string) => { const item = items.find(entry => entry.id === id); if (item) void upload(item); },
    pending, failed, paths: items.filter(item => item.status === "ready" && item.path).map(item => item.path!),
  };
}
export type Attachments = ReturnType<typeof useAttachments>;

function Ring({ percent }: { percent: number }) {
  const length = 2 * Math.PI * 9;
  return <svg className="assistant-upload-ring" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="9" strokeDasharray={length} strokeDashoffset={length * (1 - Math.min(100, percent) / 100)} />
  </svg>;
}

export function AttachmentTray({ attachments, canSee }: { attachments: Attachments; canSee: boolean }) {
  if (!attachments.items.length) return null;
  const images = attachments.items.some(item => item.image);
  return <div className="assistant-uploads">
    <ul aria-label="附件">{attachments.items.map(item => <li key={item.id} className={`assistant-upload is-${item.status}`} title={item.error ?? item.path ?? item.name}>
      <span className="assistant-upload-media">
        {item.preview ? <img src={item.preview} alt="" /> : <FileGlyph kind={getFileKind(item.file.type, item.name)} size={22} />}
        {(item.status === "uploading" || item.status === "processing") && <span className="assistant-upload-progress">
          {item.status === "uploading" ? <Ring percent={item.percent} /> : <span className="spinner" aria-label="生成预览图" />}</span>}
        {item.status === "error" && <span className="assistant-upload-progress is-error"><Icon name="alert" size={16} /></span>}
      </span>
      <span className="assistant-upload-text"><strong>{item.name}</strong>
        <small>{item.status === "error" ? item.error : item.status === "uploading" ? `上传中 ${Math.round(item.percent)}%`
          : item.status === "processing" ? "生成预览图" : formatBytes(item.file.size)}</small></span>
      {item.status === "error" && <button type="button" className="assistant-upload-action" onClick={() => attachments.retry(item.id)} aria-label={`重试上传 ${item.name}`} title="重试"><Icon name="refresh" size={13} /></button>}
      <button type="button" className="assistant-upload-remove" onClick={() => attachments.remove(item.id)} aria-label={`移除附件 ${item.name}`} title="移除（文件已保存的不会删除）"><Icon name="x" size={12} /></button>
    </li>)}</ul>
    {images && !canSee && <p className="assistant-upload-hint"><Icon name="info" size={12} />当前模型不能识图，助手只能看到文件名和类型</p>}
  </div>;
}

/** 消息上方的附件：图片最多 4 张缩略图（超出显示 +N），其他文件为胶囊。 */
export function MessageAttachments({ paths, onOpenImage, onOpenFolder }: { paths: string[]; onOpenImage: (path: string, all: string[]) => void; onOpenFolder: (path: string) => void }) {
  const images = paths.filter(path => getFileKind(null, path) === "image");
  const others = paths.filter(path => !images.includes(path));
  const shown = images.slice(0, 4);
  return <div className="ai-files">
    {shown.length > 0 && <div className={`ai-files-grid is-${shown.length}`}>{shown.map((path, index) => {
      const key = path.replace(/^\//, "");
      return <button type="button" key={path} className="ai-files-image" onClick={() => onOpenImage(path, images)} title={path}>
        <img src={api.thumbnailUrl(key, "attachment", "poster")} alt={key.split("/").at(-1)} loading="lazy" onError={event => { event.currentTarget.style.visibility = "hidden"; }} />
        {index === 3 && images.length > 4 && <span className="ai-files-more">+{images.length - 4}</span>}
      </button>;
    })}</div>}
    {others.length > 0 && <div className="ai-files-files">{others.map(path => <button type="button" key={path} className="ai-files-file" onClick={() => onOpenFolder(path)} title={path}>
      <FileGlyph kind={getFileKind(null, path)} size={14} /><span>{path.split("/").at(-1)}</span></button>)}</div>}
  </div>;
}
