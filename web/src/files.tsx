/** 文件类型识别、预览与公开分享对话框。 */
import { useEffect, useState } from "react";
import * as api from "./api";
import { Badge, Button, CopyField, Field, Icon, KeyValue, Modal, Segmented, SkeletonRows, Switch, formatBytes, formatDateTime, toast, type IconName } from "./ui";

export type FileKind = "folder" | "image" | "video" | "audio" | "pdf" | "text" | "code" | "archive" | "other";

export function getFileKind(type: string | null | undefined, name: string): FileKind {
  const lower = name.toLowerCase();
  const mime = (type || "").toLowerCase();
  if (lower.endsWith("/")) return "folder";
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|heic)$/.test(lower)) return "image";
  if (mime.startsWith("video/") || /\.(mp4|webm|mov|mkv|avi|m4v)$/.test(lower)) return "video";
  if (mime.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a|aac)$/.test(lower)) return "audio";
  if (mime === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (/\.(js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|sh|html|css|sql|rb|php|swift|kt)$/.test(lower)) return "code";
  if (mime.startsWith("text/") || mime === "application/json" || /\.(md|txt|json|csv|log|xml|ya?ml|toml|ini|conf)$/.test(lower)) return "text";
  if (/\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|dmg|iso)$/.test(lower) || /zip|compressed|x-tar/.test(mime)) return "archive";
  return "other";
}

const KIND_ICON: Record<FileKind, IconName> = { folder: "folder", image: "image", video: "video", audio: "audio", pdf: "fileText", text: "fileText", code: "code", archive: "archive", other: "file" };
const KIND_LABEL: Record<FileKind, string> = { folder: "文件夹", image: "图片", video: "视频", audio: "音频", pdf: "PDF 文档", text: "文本", code: "源代码", archive: "压缩包", other: "文件" };

export function kindLabel(kind: FileKind) { return KIND_LABEL[kind]; }

export function FileTile({ kind, size = "md" }: { kind: FileKind; size?: "md" | "lg" | "xl" }) {
  return <span className={`file-tile tile-${kind} tile-${size}`} aria-hidden="true"><Icon name={KIND_ICON[kind]} size={size === "xl" ? 34 : size === "lg" ? 22 : 17} /></span>;
}

export function baseName(key: string) {
  return key.replace(/\/$/, "").split("/").at(-1) || key;
}
export function parentPath(key: string) {
  const parts = key.replace(/\/$/, "").split("/");
  parts.pop();
  return parts.length ? `${parts.join("/")}/` : "";
}

const PREVIEWABLE: FileKind[] = ["image", "video", "audio", "pdf", "text", "code"];
export function canPreview(kind: FileKind) { return PREVIEWABLE.includes(kind); }

/** 内容区：分享页与预览弹窗共用同一套渲染逻辑。 */
export function FilePreview({ kind, url, name, downloadUrl, onImageLoad }: { kind: FileKind; url: string; name: string; downloadUrl: string; onImageLoad?: (image: HTMLImageElement) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [mediaFailed, setMediaFailed] = useState(false);
  useEffect(() => {
    if (kind !== "text" && kind !== "code") return;
    setText(null); setError("");
    const controller = new AbortController();
    // 文本预览只读取前 512 KB，避免大日志拖垮页面。
    void fetch(url, { credentials: "include", headers: { Range: "bytes=0-524287" }, signal: controller.signal })
      .then(response => response.ok ? response.text() : Promise.reject(new Error(`无法读取文件（${response.status}）`)))
      .then(setText)
      .catch(reason => { if (!controller.signal.aborted) setError(api.errorMessage(reason, "无法读取文件")); });
    return () => controller.abort();
  }, [url, kind]);
  const fallback = (
    <div className="preview-fallback">
      <FileTile kind={kind} size="xl" />
      <h3>{mediaFailed || error ? "无法在浏览器中预览" : "此类型不支持在线预览"}</h3>
      <p>{error || "下载后使用本地应用打开。"}</p>
      <a className="btn btn-primary btn-md" href={downloadUrl}><Icon name="download" size={17} /><span>下载文件</span></a>
    </div>
  );
  if (mediaFailed) return fallback;
  if (kind === "image") return <div className="preview-media"><img src={url} alt={name} onError={() => setMediaFailed(true)} onLoad={event => onImageLoad?.(event.currentTarget)} /></div>;
  if (kind === "video") return <div className="preview-media"><video src={url} controls preload="metadata" onError={() => setMediaFailed(true)} /></div>;
  if (kind === "audio") return <div className="preview-audio"><FileTile kind="audio" size="xl" /><audio src={url} controls onError={() => setMediaFailed(true)} /></div>;
  if (kind === "pdf") return <iframe className="preview-frame" src={url} title={name} />;
  if (kind === "text" || kind === "code") return error ? fallback : text === null ? <div className="preview-loading"><SkeletonRows rows={6} /></div> : <pre className="preview-text">{text}</pre>;
  return fallback;
}

export function PreviewModal({ file, url, downloadUrl, onClose, onShare, onImageLoad }: { file: api.FileItem; url: string; downloadUrl: string; onClose: () => void; onShare?: () => void; onImageLoad?: (image: HTMLImageElement) => void }) {
  const kind = getFileKind(file.content_type, file.key);
  return (
    <Modal size="xl" title={baseName(file.key)} onClose={onClose}
      description={<span className="preview-meta"><span>{formatBytes(file.size)}</span><span>{file.content_type || kindLabel(kind)}</span><span>{formatDateTime(file.modified_at)}</span>{file.public_token && <Badge tone="public" icon="globe">公开</Badge>}</span>}
      footer={<>
        {onShare && <Button icon="link" onClick={onShare}>{file.public_token ? "管理分享" : "公开分享"}</Button>}
        <a className="btn btn-primary btn-md" href={downloadUrl}><Icon name="download" size={17} /><span>下载</span></a>
      </>}>
      <div className="preview-stage"><FilePreview kind={kind} url={url} name={baseName(file.key)} downloadUrl={downloadUrl} onImageLoad={onImageLoad} /></div>
    </Modal>
  );
}

/** 公开分享：开关即时生效，开启后可设置有效期与访问密码，并查看下载次数。 */
export function ShareDialog({ file, publicBase, onClose, onChange, update }: {
  file: api.FileItem; publicBase?: string | null; onClose: () => void; onChange: (file: api.FileItem) => void;
  update: (isPublic: boolean, options?: api.ShareOptions) => Promise<api.FileItem>;
}) {
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [editingPassword, setEditingPassword] = useState(false);
  const isPublic = Boolean(file.public_token);
  const name = baseName(file.key);
  const links = file.public_token ? api.publicLinks(file.public_token, name, publicBase) : null;
  async function apply(next: boolean, options?: api.ShareOptions, message?: string) {
    setBusy(true);
    try {
      const updated = await update(next, options);
      onChange(updated);
      toast.success(message ?? (next ? "已开启公开访问" : "已关闭公开访问，原链接立即失效"));
      return true;
    } catch (reason) { toast.error(api.errorMessage(reason, "更新分享设置失败")); return false; }
    finally { setBusy(false); }
  }
  const expiry = file.public_expires_at ? "custom" : "never";
  const setExpiry = (days: number | null) => void apply(true, { expires_at: days === null ? null : Date.now() / 1000 + days * 86400 },
    days === null ? "链接已设为永久有效" : `链接将在 ${days} 天后失效`);
  async function savePassword() {
    if (password.length < 4) { toast.error("访问密码至少 4 个字符"); return; }
    if (await apply(true, { password }, "已设置访问密码，旧的验证凭证已失效")) { setPassword(""); setEditingPassword(false); }
  }
  return (
    <Modal title="分享文件" description={name} icon="link" tone={isPublic ? "public" : "accent"} onClose={onClose}
      footer={<>{links && <a className="btn btn-secondary btn-md" href={links.page} target="_blank" rel="noreferrer"><Icon name="external" size={17} /><span>打开分享页</span></a>}<Button variant="primary" onClick={onClose}>完成</Button></>}>
      <div className={`share-status${isPublic ? " is-public" : ""}`}>
        <Switch checked={isPublic} disabled={busy} onChange={value => void apply(value)} label={isPublic ? "任何拥有链接的人都可以访问" : "仅自己可见"}
          description={isPublic ? (file.public_has_password ? "访问者需要输入密码才能查看和下载。" : "访问者无需登录即可预览和下载这个文件。") : "开启后会生成一个随机链接，可随时关闭。"} />
      </div>
      {links && (
        <div className="form">
          <Field label="分享页" hint="带预览和下载按钮的页面，适合发给他人。">
            <CopyField value={links.page} label="分享页链接" copyMessage="分享链接已复制" />
          </Field>
          <Field label="直链" hint={file.public_has_password ? "设置了访问密码时，直链需要先在分享页验证密码后才能使用。" : "直接返回文件内容，可用于 <img>、<video> 或下载工具，支持断点续传。"}>
            <CopyField value={links.direct} label="文件直链" copyMessage="直链已复制" />
          </Field>
          <Field label="有效期" hint={file.public_expires_at ? `将于 ${formatDateTime(file.public_expires_at)} 失效，之后访问会提示链接已过期。` : "链接一直有效，直到你关闭分享。"}>
            {/* 设置限时后当前值不对应任何选项：再次点击某个天数会从现在重新计算。 */}
            <Segmented label="有效期" value={expiry} onChange={value => setExpiry(value === "never" ? null : Number(value))}
              options={[{ value: "never", label: "永久" }, { value: "1", label: "1 天" }, { value: "7", label: "7 天" }, { value: "30", label: "30 天" }]} />
          </Field>
          <Field label="访问密码" htmlFor="share-password" hint="至少 4 个字符。修改或取消密码后，已验证过的访问者需要重新输入。">
            {file.public_has_password && !editingPassword ? (
              <div className="share-password-set">
                <Badge tone="public" icon="lock">已设置</Badge>
                <Button size="sm" variant="ghost" onClick={() => setEditingPassword(true)}>修改</Button>
                <Button size="sm" variant="ghost" className="btn-ghost-danger" disabled={busy} onClick={() => void apply(true, { password: null }, "已取消访问密码")}>取消密码</Button>
              </div>
            ) : (
              <form className="share-password-form" noValidate onSubmit={event => { event.preventDefault(); void savePassword(); }}>
                <input id="share-password" className="input" type="text" autoComplete="off" placeholder="不设置则无需密码" value={password}
                  onChange={event => setPassword(event.target.value)} />
                <Button size="sm" type="submit" disabled={busy || !password}>设置密码</Button>
                {editingPassword && <Button size="sm" variant="ghost" onClick={() => { setEditingPassword(false); setPassword(""); }}>取消</Button>}
              </form>
            )}
          </Field>
          <KeyValue items={[["开启时间", formatDateTime(file.public_at)], ["下载次数", `${file.public_downloads ?? 0} 次`], ["覆盖、移动或重命名", "链接与设置保持不变"]]} />
        </div>
      )}
    </Modal>
  );
}

/* ---------- 缩略图 ---------- */

/** 在浏览器中生成缩略图（最长边 320px），返回 data URL；失败或过大时返回 null。服务端上限 96 KB。 */
export async function makeThumbnail(source: Blob | HTMLImageElement, max = 320): Promise<string | null> {
  try {
    const image = source instanceof Blob ? await createImageBitmap(source) : source;
    const width = source instanceof Blob ? (image as ImageBitmap).width : (image as HTMLImageElement).naturalWidth;
    const height = source instanceof Blob ? (image as ImageBitmap).height : (image as HTMLImageElement).naturalHeight;
    if (!width || !height) return null;
    const scale = Math.min(1, max / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d")?.drawImage(image as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    if (image instanceof ImageBitmap) image.close();
    for (const [type, quality] of [["image/webp", 0.78], ["image/jpeg", 0.8], ["image/jpeg", 0.6]] as const) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
      // Safari 不支持编码 WebP，会返回 PNG：跳过，改用 JPEG。
      if (!blob || blob.type !== type || blob.size > 90 * 1024) continue;
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }
    return null;
  } catch {
    return null;
  }
}

/** 适合生成缩略图的文件：常见位图格式，且不超过 60 MB（避免浏览器解码超大图片）。 */
export function thumbnailable(name: string, type: string | null | undefined, size: number) {
  return getFileKind(type, name) === "image" && !/\.svg$/i.test(name) && !(type || "").includes("svg") && size <= 60 * 1024 * 1024;
}
