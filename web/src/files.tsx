/** 文件类型识别、预览与公开分享对话框。 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import { HighlightedCode } from "./code";
import { languageOf } from "./highlight";
import { Markdown } from "./markdown";
import { Badge, Button, CopyField, Field, Icon, KeyValue, Modal, Segmented, Switch, formatBytes, formatDateTime, toast, type IconName } from "./ui";

export type FileKind = "folder" | "image" | "video" | "audio" | "pdf" | "text" | "code" | "archive" | "other";

export function getFileKind(type: string | null | undefined, name: string): FileKind {
  const lower = name.toLowerCase();
  const mime = (type || "").toLowerCase();
  if (lower.endsWith("/")) return "folder";
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|heic)$/.test(lower)) return "image";
  if (mime.startsWith("video/") || /\.(mp4|webm|mov|mkv|avi|m4v)$/.test(lower)) return "video";
  if (mime.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a|aac)$/.test(lower)) return "audio";
  if (mime === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|c|cc|cpp|cxx|h|hpp|cs|sh|bash|zsh|ps1|bat|html?|css|scss|sass|less|vue|svelte|sql|rb|php|swift|kt|kts|scala|dart|gradle|lua|diff|patch)$/.test(lower) || /(^|\/)(dockerfile|makefile)$/.test(lower)) return "code";
  if (mime.startsWith("text/") || mime === "application/json" || /\.(md|markdown|mdx|rst|txt|json|jsonc|csv|tsv|log|xml|ya?ml|toml|ini|conf|cfg|properties|env|gitignore|editorconfig)$/.test(lower) || /(^|\/)\.env(\.[\w.-]+)?$/.test(lower)) return "text";
  if (/\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|dmg|iso)$/.test(lower) || /zip|compressed|x-tar/.test(mime)) return "archive";
  return "other";
}

const KIND_ICON: Record<FileKind, IconName> = { folder: "folder", image: "image", video: "video", audio: "audio", pdf: "fileText", text: "fileText", code: "code", archive: "archive", other: "file" };
const KIND_LABEL: Record<FileKind, string> = { folder: "文件夹", image: "图片", video: "视频", audio: "音频", pdf: "PDF 文档", text: "文本", code: "源代码", archive: "压缩包", other: "文件" };

export function kindLabel(kind: FileKind) { return KIND_LABEL[kind]; }

export function FileTile({ kind, size = "md" }: { kind: FileKind; size?: "md" | "lg" | "xl" }) {
  return <span className={`file-tile tile-${kind} tile-${size}`} aria-hidden="true"><Icon name={KIND_ICON[kind]} size={size === "xl" ? 34 : size === "lg" ? 22 : 17} /></span>;
}

export function FileThumbnail({ kind, url }: { kind: FileKind; url?: string }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setState("loading"); setAttempt(0); }, [url]);
  return <div className={`file-thumbnail thumbnail-${state}`}>
    {(!url || state !== "ready") && <FileTile kind={kind} size="xl" />}
    {url && state !== "failed" && <img key={attempt} src={url} alt="" loading="lazy" onLoad={() => setState("ready")} onError={() => setState("failed")} />}
    {url && state === "loading" && <span className="thumbnail-loading" aria-label="正在加载缩略图"><span className="spinner" /></span>}
    {url && state === "failed" && <Button size="sm" variant="ghost" icon="refresh" onClick={event => { event.stopPropagation(); setState("loading"); setAttempt(current => current + 1); }}>重试缩略图</Button>}
  </div>;
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
const TEXT_PREVIEW_LIMIT = 512 * 1024;

/** 解码预览文本：先按 UTF-8 严格解码，失败时回退到 GB18030；被截断的末尾多字节字符会被丢弃。 */
function decodeText(buffer: ArrayBuffer, truncated: boolean): string {
  let bytes = new Uint8Array(buffer);
  if (truncated) {
    let back = 0;
    while (back < 3 && bytes.length - 1 - back >= 0 && (bytes[bytes.length - 1 - back] & 0xc0) === 0x80) back++;
    const lead = bytes[bytes.length - 1 - back];
    if (lead !== undefined && lead >= 0xc0 && back + 1 < (lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2)) bytes = bytes.subarray(0, bytes.length - 1 - back);
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { try { return new TextDecoder("gb18030").decode(bytes); } catch { return new TextDecoder().decode(bytes); } }
}

/** 把 Markdown 里的相对路径图片解析为云盘内的绝对键；越出根目录或带协议的地址返回 null。 */
export function resolveRelativeKey(baseDir: string, src: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return null;
  let path = src.split(/[?#]/)[0];
  try { path = decodeURI(path); } catch { /* 保留原样 */ }
  const segments: string[] = [];
  for (const part of ((path.startsWith("/") ? "" : baseDir) + path).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!segments.pop()) return null; } else segments.push(part);
  }
  return segments.length ? segments.join("/") : null;
}

type TextState = { text: string; truncated: boolean; total: number | null };

/** 内容区：分享页与预览弹窗共用同一套渲染逻辑。 */
type PreviewProps = { kind: FileKind; url: string; name: string; downloadUrl: string; onImageLoad?: (image: HTMLImageElement) => void; resolveImage?: (src: string) => string | null };
export function FilePreview(props: PreviewProps) {
  const [attempt, setAttempt] = useState(0);
  return <PreviewContent key={`${props.kind}:${props.url}:${attempt}`} {...props} onRetry={() => setAttempt(current => current + 1)} />;
}

function PreviewLoading({ onRetry, downloadUrl }: { onRetry: () => void; downloadUrl: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setSlow(true), 8000); return () => window.clearTimeout(timer); }, []);
  return <div className="preview-loading" role="status"><span className="spinner spinner-lg" /><span>{slow ? "加载时间较长，可以重试或下载后打开。" : "正在加载预览…"}</span>
    {slow && <div className="preview-recovery"><Button size="sm" icon="refresh" onClick={onRetry}>重新加载</Button><a className="btn btn-secondary btn-sm" href={downloadUrl}>下载文件</a></div>}
  </div>;
}

function PreviewContent({ kind, url, name, downloadUrl, onImageLoad, resolveImage, onRetry }: PreviewProps & { onRetry: () => void }) {
  const [content, setContent] = useState<TextState | null>(null);
  const [error, setError] = useState("");
  const [mediaFailed, setMediaFailed] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const [mode, setMode] = useState<"render" | "source">("render");
  useEffect(() => {
    if (kind !== "text" && kind !== "code") return;
    setContent(null); setError("");
    const controller = new AbortController();
    // 文本预览只读取前 512 KB，避免大日志拖垮页面。
    void fetch(url, { credentials: "include", headers: { Range: `bytes=0-${TEXT_PREVIEW_LIMIT - 1}` }, signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`无法读取文件（${response.status}）`);
        const range = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
        let buffer = await response.arrayBuffer();
        let total = range ? Number(range[1]) : null;
        if (buffer.byteLength > TEXT_PREVIEW_LIMIT) { total = buffer.byteLength; buffer = buffer.slice(0, TEXT_PREVIEW_LIMIT); }
        const truncated = total !== null && total > buffer.byteLength;
        return { text: decodeText(buffer, truncated), truncated, total };
      })
      .then(value => { if (!controller.signal.aborted) setContent(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(api.errorMessage(reason, "无法读取文件")); });
    return () => controller.abort();
  }, [url, kind]);
  const fallback = (
    <div className="preview-fallback">
      <FileTile kind={kind} size="xl" />
      <h3>{mediaFailed || error ? "预览加载失败" : "此类型不支持在线预览"}</h3>
      <p>{error || (mediaFailed ? "文件未能加载或当前浏览器不支持此格式，可以重试或下载后打开。" : "下载后使用本地应用打开。")}</p>
      <div className="preview-recovery">{(mediaFailed || error) && <Button icon="refresh" onClick={onRetry}>重新加载</Button>}<a className="btn btn-primary btn-md" href={downloadUrl}><Icon name="download" size={17} /><span>下载文件</span></a></div>
    </div>
  );
  if (mediaFailed) return fallback;
  if (["image", "video", "audio", "pdf"].includes(kind)) return <div className={`preview-resource${mediaReady ? " is-ready" : ""}`} aria-busy={!mediaReady}>
    {!mediaReady && <div className="preview-media-loader"><PreviewLoading onRetry={onRetry} downloadUrl={downloadUrl} /></div>}
    {kind === "image" && <div className="preview-media"><img src={url} alt={name} onError={() => setMediaFailed(true)} onLoad={event => { setMediaReady(true); onImageLoad?.(event.currentTarget); }} /></div>}
    {kind === "video" && <div className="preview-media"><video src={url} controls preload="metadata" onError={() => setMediaFailed(true)} onLoadedMetadata={() => setMediaReady(true)} onWaiting={() => setMediaReady(false)} onCanPlay={() => setMediaReady(true)} onPlaying={() => setMediaReady(true)} /></div>}
    {kind === "audio" && <div className="preview-audio"><FileTile kind="audio" size="xl" /><audio src={url} controls preload="metadata" onError={() => setMediaFailed(true)} onLoadedMetadata={() => setMediaReady(true)} onWaiting={() => setMediaReady(false)} onCanPlay={() => setMediaReady(true)} onPlaying={() => setMediaReady(true)} /></div>}
    {kind === "pdf" && <iframe className="preview-frame" src={url} title={name} onLoad={() => setMediaReady(true)} onError={() => setMediaFailed(true)} />}
  </div>;
  if (kind === "text" || kind === "code") {
    if (error) return fallback;
    if (content === null) return <PreviewLoading onRetry={onRetry} downloadUrl={downloadUrl} />;
    const markdown = /\.(md|markdown|mdx)$/i.test(name);
    const lang = languageOf(name);
    return (
      <div className="preview-text">
        {(markdown || content.truncated) && (
          <div className="preview-toolbar">
            {markdown && <Segmented label="显示方式" value={mode} onChange={setMode} options={[{ value: "render", label: "预览" }, { value: "source", label: "源码" }]} />}
            {content.truncated && <span className="preview-notice">仅显示前 {formatBytes(TEXT_PREVIEW_LIMIT)}{content.total ? `（共 ${formatBytes(content.total)}）` : ""}，<a href={downloadUrl}>下载完整文件</a></span>}
          </div>
        )}
        {markdown && mode === "render"
          ? <article className="preview-doc"><Markdown source={content.text} resolveImage={resolveImage} /></article>
          : <HighlightedCode code={content.text} lang={lang} lineNumbers={lang !== null || kind === "code"} />}
      </div>
    );
  }
  return fallback;
}

export function PreviewModal({ file, url, downloadUrl, onClose, onShare, onImageLoad, assetUrl }: { file: api.FileItem; url: string; downloadUrl: string; onClose: () => void; onShare?: () => void; onImageLoad?: (image: HTMLImageElement) => void; assetUrl?: (key: string) => string }) {
  const kind = getFileKind(file.content_type, file.key);
  const extension = file.key.match(/\.([a-z\d]{1,10})$/i)?.[1].toUpperCase();
  const typeLabel = extension && kind !== "pdf" && kind !== "folder" ? `${extension === "JPG" ? "JPEG" : extension} ${kindLabel(kind)}` : kindLabel(kind);
  // Markdown 里的相对路径图片按文件所在目录解析为云盘内的文件；解析函数保持稳定，避免重复渲染整篇文档。
  const assetRef = useRef(assetUrl);
  assetRef.current = assetUrl;
  const hasAssets = Boolean(assetUrl);
  const resolveImage = useMemo(() => hasAssets ? (src: string) => {
    const key = resolveRelativeKey(parentPath(file.key), src);
    return key && assetRef.current ? assetRef.current(key) : null;
  } : undefined, [file.key, hasAssets]);
  return (
    <Modal size="xl" title={baseName(file.key)} onClose={onClose}
      description={<span className="preview-meta"><span>{formatBytes(file.size)}</span><span title={file.content_type ?? undefined}>{typeLabel}</span><span>{formatDateTime(file.modified_at)}</span>{file.public_token && <Badge tone="public" icon="globe">公开</Badge>}</span>}
      footer={<>
        {onShare && <Button icon="link" onClick={onShare}>{file.public_token ? "管理分享" : "公开分享"}</Button>}
        <a className="btn btn-primary btn-md" href={downloadUrl}><Icon name="download" size={17} /><span>下载</span></a>
      </>}>
      <div className="preview-stage"><FilePreview kind={kind} url={url} name={baseName(file.key)} downloadUrl={downloadUrl} onImageLoad={onImageLoad} resolveImage={resolveImage} /></div>
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
  const [error, setError] = useState("");
  const isPublic = Boolean(file.public_token);
  const folder = file.key.endsWith("/");
  const name = baseName(file.key);
  const links = file.public_token ? api.publicLinks(file.public_token, name, publicBase) : null;
  async function apply(next: boolean, options?: api.ShareOptions, message?: string) {
    if (busy) return false;
    setBusy(true); setError("");
    try {
      const updated = await update(next, options);
      onChange(updated);
      toast.success(message ?? (next ? "已开启公开访问" : "已关闭公开访问，原链接立即失效"));
      return true;
    } catch (reason) { setError(api.errorMessage(reason, "更新分享设置失败，请稍后重试")); return false; }
    finally { setBusy(false); }
  }
  const expiry = file.public_expires_at ? "custom" : "never";
  const setExpiry = (days: number | null) => void apply(true, { expires_at: days === null ? null : Date.now() / 1000 + days * 86400 },
    days === null ? "链接已设为永久有效" : `链接将在 ${days} 天后失效`);
  async function savePassword() {
    if (password.length < 4) { setError("访问密码至少 4 个字符"); return; }
    if (await apply(true, { password }, "已设置访问密码，旧的验证凭证已失效")) { setPassword(""); setEditingPassword(false); }
  }
  return (
    <Modal title={folder ? "分享文件夹" : "分享文件"} description={name} icon="link" onClose={onClose} dismissible={!busy}
      footer={<>{links && <a className="btn btn-ghost btn-md" href={links.page} target="_blank" rel="noreferrer"><Icon name="external" size={17} /><span>打开分享页</span></a>}<Button disabled={busy} onClick={onClose}>完成</Button></>}>
      <div className={`share-status${isPublic ? " is-public" : ""}`}>
        <Switch checked={isPublic} disabled={busy} onChange={value => void apply(value)} label={isPublic ? "任何拥有链接的人都可以访问" : "仅自己可见"}
          description={isPublic
            ? (file.public_has_password ? `访问者需要输入密码才能查看和下载${folder ? "里面的文件" : ""}。` : folder ? "访问者可浏览、预览和下载全部内容，包括子文件夹。" : "访问者无需登录即可预览和下载。")
            : "开启公开访问后生成分享链接，可随时关闭。"} />
      </div>
      {error && <div className="form-alert" role="alert">{error}</div>}
      <p className="share-save-status" role="status">{busy ? "正在保存设置…" : "更改自动保存"}</p>
      {links && <>
        <Field label="分享链接" hint={folder ? "文件夹内容更新后，分享页会同步展示。" : "发送此链接，对方可预览和下载文件。"}>
          <CopyField value={links.page} label="分享页链接" copyMessage="分享链接已复制" primary />
        </Field>
        <details className="settings-disclosure">
          <summary><span>访问设置</span><span className="disclosure-meta">{file.public_has_password ? "有密码" : "无密码"} · {file.public_expires_at ? "限时有效" : "永久有效"}</span><Icon name="chevronDown" size={16} /></summary>
          <div className="disclosure-body form">
            <Field label="有效期" hint={file.public_expires_at ? `将于 ${formatDateTime(file.public_expires_at)} 失效。再次选择天数会从现在重新计算。` : "链接一直有效，直到你关闭分享。"}>
              <select className="input" value={expiry} disabled={busy} onChange={event => setExpiry(event.target.value === "never" ? null : Number(event.target.value))}>
                {file.public_expires_at && <option value="custom" disabled>当前：{formatDateTime(file.public_expires_at)} 失效</option>}
                <option value="never">永久有效</option><option value="1">从现在起 1 天</option><option value="7">从现在起 7 天</option><option value="30">从现在起 30 天</option>
              </select>
            </Field>
            <Field label="访问密码" htmlFor="share-password" hint="至少 4 个字符。修改密码后，访问者需重新验证。">
              {file.public_has_password && !editingPassword ? <div className="share-password-set">
                <Badge tone="accent" icon="lock">已设置</Badge>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditingPassword(true)}>修改</Button>
                <Button size="sm" variant="ghost" className="btn-ghost-danger" disabled={busy} onClick={() => void apply(true, { password: null }, "已取消访问密码")}>取消密码</Button>
              </div> : <form className="share-password-form" noValidate onSubmit={event => { event.preventDefault(); void savePassword(); }}>
                <input id="share-password" className="input" type="text" autoComplete="off" placeholder="不设置则无需密码" value={password} disabled={busy} onChange={event => { setPassword(event.target.value); setError(""); }} />
                <Button size="sm" type="submit" disabled={busy || !password}>设置密码</Button>
                {editingPassword && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditingPassword(false); setPassword(""); }}>取消</Button>}
              </form>}
            </Field>
          </div>
        </details>
        <details className="settings-disclosure">
          <summary><span>{folder ? "分享详情" : "直链与分享详情"}</span><Icon name="chevronDown" size={16} /></summary>
          <div className="disclosure-body form">
            {!folder && <Field label="文件直链" hint={file.public_has_password ? "需要先在分享页输入密码，直链才能使用。" : "适合嵌入网页或用于下载工具。"}><CopyField value={links.direct} label="文件直链" copyMessage="直链已复制" /></Field>}
            <KeyValue items={[["开启时间", formatDateTime(file.public_at)], ["下载次数", `${file.public_downloads ?? 0} 次`], [folder ? "移动或重命名" : "覆盖、移动或重命名", "链接与设置保持不变"]]} />
          </div>
        </details>
      </>}
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
