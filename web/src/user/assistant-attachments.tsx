/** 聊天框附件（docs/assistant-design.md §22.5）：选择、粘贴或拖入的文件上传为对话附件，保存在系统区，不出现在我的文件，
 * 随对话删除。图片上传后先在浏览器生成预览图（识图模型看的是预览图），完成后附件才算就绪。
 * 托盘上移除未发送的附件会立即删除它；发送后附件属于对话，只能随对话删除或另存为普通文件。 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import * as ai from "../assistant-api";
import { FileGlyph, getFileKind } from "../files";
import { createThumbnails, thumbnailSource } from "../thumbnails";
import { Button, Icon, Menu, Modal, formatBytes, toast } from "../ui";
import { FolderPicker } from "./folders";
import { usePreview } from "./preview-host";

export const MAX_ATTACHMENTS = 10;
// 单个附件一次 PUT 上传；更大的文件请在文件页上传（支持分块与续传）后用 @ 引用。
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

export type Attachment = {
  id: string; file: File; name: string; uploaded: api.AssistantAttachment | null; image: boolean; preview: string | null;
  status: "uploading" | "processing" | "ready" | "error"; percent: number; error?: string;
};

const pad = (value: number) => String(value).padStart(2, "0");

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

async function saveThumbnails(id: string, file: File) {
  const source = thumbnailSource(file.name, file.type, file.size);
  if (!source) return;
  const result = await createThumbnails({ file }, source);
  if (!result) return;
  if (result === "none") { await ai.setAttachmentThumbnail(id, null, "none"); return; }
  await ai.setAttachmentThumbnail(id, result.thumb, "thumb");
  if (result.poster) await ai.setAttachmentThumbnail(id, result.poster, "poster").catch(() => undefined);
}

export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const aborts = useRef(new Map<string, () => void>());
  const update = useCallback((id: string, patch: Partial<Attachment>) =>
    setItems(current => current.map(item => item.id === id ? { ...item, ...patch } : item)), []);

  const upload = useCallback(async (item: Attachment) => {
    update(item.id, { status: "uploading", percent: 0, error: undefined });
    try {
      let uploaded = item.uploaded;
      if (!uploaded) {
        const task = api.uploadAttachmentWithProgress(item.file, item.name, progress => update(item.id, { percent: progress.percent }));
        aborts.current.set(item.id, task.abort);
        uploaded = await task.promise;
        aborts.current.delete(item.id);
        update(item.id, { uploaded });
      }
      if (thumbnailSource(item.name, item.file.type, item.file.size)) {
        // 识图模型看的是预览图：先生成再算就绪；生成失败不阻止发送（服务端会改用受支持格式的小原图或说明原因）。
        update(item.id, { status: "processing", percent: 100 });
        await saveThumbnails(uploaded.id, item.file).catch(() => undefined);
      }
      update(item.id, { status: "ready", percent: 100 });
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
        accepted.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, name, uploaded: null, image,
          preview: image ? URL.createObjectURL(file) : null, status: "uploading", percent: 0 });
      }
      window.setTimeout(() => accepted.forEach(item => void upload(item)), 0);
      return [...current, ...accepted];
    });
  }, [upload]);

  const release = (item: Attachment, discard: boolean) => {
    aborts.current.get(item.id)?.();
    aborts.current.delete(item.id);
    if (item.preview) URL.revokeObjectURL(item.preview);
    // 未发送的附件属于草稿：移除即删除，立即释放空间。
    if (discard && item.uploaded) void ai.discardAttachment(item.uploaded.id).catch(() => undefined);
  };

  const remove = useCallback((id: string) => {
    setItems(current => {
      const item = current.find(entry => entry.id === id);
      if (item) release(item, true);
      return current.filter(entry => entry.id !== id);
    });
  }, []);

  /** 清空托盘：发送后（附件已属于对话）传 false；放弃草稿（新建对话等）传 true 删除未发送的附件。 */
  const clear = useCallback((discard = false) => setItems(current => {
    current.forEach(item => release(item, discard));
    return [];
  }), []);

  useEffect(() => () => { aborts.current.forEach(abort => abort()); }, []);

  const pending = items.some(item => item.status === "uploading" || item.status === "processing");
  const failed = items.some(item => item.status === "error");
  return {
    items, add, remove, clear, retry: (id: string) => { const item = items.find(entry => entry.id === id); if (item) void upload(item); },
    pending, failed, ids: items.filter(item => item.status === "ready" && item.uploaded).map(item => item.uploaded!.id),
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
    <ul aria-label="附件">{attachments.items.map(item => <li key={item.id} className={`assistant-upload is-${item.status}`} title={item.error ?? item.name}>
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
      <button type="button" className="assistant-upload-remove" onClick={() => attachments.remove(item.id)} aria-label={`移除附件 ${item.name}`} title="移除"><Icon name="x" size={12} /></button>
    </li>)}</ul>
    {images && !canSee && <p className="assistant-upload-hint"><Icon name="info" size={12} />当前模型不能识图，助手只能看到文件名和类型</p>}
  </div>;
}

/** 消息里的附件当作文件交给预览：同一条消息内显示名唯一，key 用「附件/名称」，地址指向附件接口。 */
function previewFile(item: ai.MessageAttachment): api.FileItem {
  return { key: `附件/${item.name}`, size: item.size, etag: item.id, content_type: item.content_type, modified_at: 0, thumbnails: item.image ? ["thumb", "poster"] : [] };
}
const sourceOf = (item: ai.MessageAttachment) => ({ url: ai.attachmentContentUrl(item.id), downloadUrl: ai.attachmentContentUrl(item.id, true),
  poster: item.image ? ai.attachmentThumbnailUrl(item.id, "poster") : undefined, thumbnail: item.image ? ai.attachmentThumbnailUrl(item.id) : undefined });

/** 消息上方的附件：图片最多 4 张缩略图（超出显示 +N），其他文件为胶囊；点击预览，菜单可另存为普通文件。 */
export function MessageAttachments({ items, location = "" }: { items: ai.MessageAttachment[]; location?: string }) {
  const preview = usePreview();
  const [saving, setSaving] = useState<ai.MessageAttachment | null>(null);
  const images = items.filter(item => item.image);
  const others = items.filter(item => !item.image);
  const shown = images.slice(0, 4);
  function open(item: ai.MessageAttachment) {
    const group = item.image ? images : [item];
    const byKey = new Map(group.map(entry => [previewFile(entry).key, entry]));
    preview.open({ file: previewFile(item), ...sourceOf(item), playlistFiles: group.map(previewFile),
      sourceFor: file => { const entry = byKey.get(file.key); return entry ? sourceOf(entry) : sourceOf(item); },
      loadAssets: async () => [] });
  }
  const menu = (item: ai.MessageAttachment) => <Menu label={`${item.name} 的操作`} className="ai-files-menu" items={[
    { label: "预览", icon: "eye", onSelect: () => open(item) },
    { label: "下载", icon: "download", href: ai.attachmentContentUrl(item.id, true), onSelect: () => undefined },
    { label: "保存到我的文件…", icon: "folderPlus", onSelect: () => setSaving(item) },
  ]} />;
  return <div className="ai-files">
    {shown.length > 0 && <div className={`ai-files-grid is-${shown.length}`}>{shown.map((item, index) =>
      <div key={item.id} className="ai-files-tile">
        <button type="button" className="ai-files-image" onClick={() => open(item)} title={item.name}>
          <img src={ai.attachmentThumbnailUrl(item.id, "poster")} alt={item.name} loading="lazy" onError={event => { event.currentTarget.style.visibility = "hidden"; }} />
          {index === 3 && images.length > 4 && <span className="ai-files-more">+{images.length - 4}</span>}
        </button>
        {menu(item)}
      </div>)}</div>}
    {others.length > 0 && <div className="ai-files-files">{others.map(item => <span key={item.id} className="ai-files-file">
      <button type="button" onClick={() => open(item)} title={`${item.name} · ${formatBytes(item.size)}`}>
        <FileGlyph kind={getFileKind(item.content_type, item.name)} size={14} /><span>{item.name}</span></button>
      {menu(item)}</span>)}</div>}
    {saving && <SaveAttachmentDialog item={saving} initial={location} onClose={() => setSaving(null)} />}
  </div>;
}

/** 另存为普通文件：引用同一份数据，不重复占用上传流量；同名自动改名。 */
function SaveAttachmentDialog({ item, initial, onClose }: { item: ai.MessageAttachment; initial: string; onClose: () => void }) {
  const [value, setValue] = useState(api.isPrivatePath(initial) ? "" : initial);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const result = await ai.saveAttachment(item.id, value);
      toast.success(`已保存到 ${result.path}`);
      window.dispatchEvent(new CustomEvent("tessera:files-added", { detail: { folders: [value] } }));
      onClose();
    } catch (reason) {
      toast.error(api.errorMessage(reason, "保存失败"));
      setBusy(false);
    }
  }
  return <Modal className="assistant-dialog" title="保存到我的文件" icon="folderPlus" onClose={onClose} dismissible={!busy}
    description={`${item.name} 会另存为普通文件；之后删除对话不会影响它。`}
    footer={<><Button onClick={onClose} disabled={busy}>取消</Button>
      <Button variant="primary" disabled={!ready || busy} onClick={() => void save()}>{busy ? "正在保存…" : "保存到这里"}</Button></>}>
    <FolderPicker value={value} onChange={setValue} onReady={setReady} />
  </Modal>;
}
