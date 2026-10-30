/** 浏览器缩略图生成：图片缩放、视频截帧、音频内嵌封面；网页上传优先复用本地文件，后台服务另行补生成。
 * 三种规格：thumb（最长边 160px，列表、目录四宫格）、grid（640px，网格卡片）与 poster（960px，预览封面与占位）；
 * 后两种只在原图明显更大时生成，存为系统区对象并计入用户空间。旧文件没有 grid 时网格退回 poster 或旧版 320px 的 thumb。 */
import * as api from "./api";
import { getFileKind } from "./files";
import { VIDEO_FRAME_TIMES, VIDEO_SAMPLE_SIZE, videoFramePixelsUsable } from "./video-frame";

export type ThumbnailSource = "image" | "video" | "audio";
export type ThumbnailSet = { thumb: string; grid?: string; poster?: string };
/** 生成结果：图片集合；"none" 表示确定无法生成（如音频没有封面）；null 表示这次没成功，可以稍后再试。 */
export type ThumbnailResult = ThumbnailSet | "none" | null;

const THUMB = { size: 160, budget: 24 * 1024 };
const GRID = { size: 640, budget: 120 * 1024 };
const POSTER = { size: 960, budget: 220 * 1024 };

export function thumbnailSource(name: string, type: string | null | undefined, size: number): ThumbnailSource | null {
  const kind = getFileKind(type, name);
  if (kind === "image") return /\.svg$/i.test(name) || (type || "").includes("svg") ? null : "image";
  return kind === "video" || kind === "audio" ? kind : null;
}

/* ---------- 编码 ---------- */

async function encode(source: CanvasImageSource, width: number, height: number, { size, budget }: typeof THUMB): Promise<string | null> {
  const scale = Math.min(1, size / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
  for (const [type, quality] of [["image/webp", 0.8], ["image/jpeg", 0.82], ["image/jpeg", 0.65], ["image/jpeg", 0.5]] as const) {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
    // Safari 不支持编码 WebP，会返回 PNG：跳过，改用 JPEG。
    if (!blob || blob.type !== type || blob.size > budget) continue;
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  return null;
}

async function renderSet(source: CanvasImageSource, width: number, height: number): Promise<ThumbnailSet | null> {
  if (!width || !height) return null;
  const thumb = await encode(source, width, height, THUMB);
  if (!thumb) return null;
  // 原图明显大于上一级规格时才生成下一级，避免把小图放大或重复保存同样的内容。
  const longest = Math.max(width, height);
  const grid = longest > THUMB.size * 1.5 ? await encode(source, width, height, GRID) ?? undefined : undefined;
  const poster = longest > GRID.size * 1.25 ? await encode(source, width, height, POSTER) ?? undefined : undefined;
  return { thumb, grid, poster };
}

/** 已加载的 <img>（例如预览弹窗里的原图）直接生成，不必重新下载。 */
export function thumbnailsFromImage(image: HTMLImageElement): Promise<ThumbnailSet | null> {
  return renderSet(image, image.naturalWidth, image.naturalHeight).catch(() => null);
}

/** 只截取播放器已经解码的当前画面，不创建媒体来源、不跳转、不额外读取视频。 */
export function thumbnailsFromVideo(video: HTMLVideoElement, checkQuality = true): Promise<ThumbnailSet | null> {
  try {
    if (video.readyState < 2 || video.seeking || !video.videoWidth || !video.videoHeight || (checkQuality && !videoFrameUsable(video))) return Promise.resolve(null);
    // 编码会异步等待：先固定当前画面，保证三个规格不会分别截到下一场景或黑屏。
    const frame = document.createElement("canvas");
    const scale = Math.min(1, POSTER.size / Math.max(video.videoWidth, video.videoHeight));
    frame.width = Math.max(1, Math.round(video.videoWidth * scale));
    frame.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = frame.getContext("2d");
    if (!context) return Promise.resolve(null);
    context.drawImage(video, 0, 0, frame.width, frame.height);
    return renderSet(frame, frame.width, frame.height).catch(() => null);
  } catch { return Promise.resolve(null); }
}

/** 只检查已经解码的画面，不跳转或额外读取；播放时间不会绕过质量检查。 */
export function videoFrameUsable(video: HTMLVideoElement): boolean {
  if (video.readyState < 2 || video.seeking || !video.videoWidth || !video.videoHeight) return false;
  try { return videoFramePixelsUsable(frameLuma(video)); } catch { return false; }
}

async function fromBlob(blob: Blob): Promise<ThumbnailSet | null> {
  const bitmap = await createImageBitmap(blob);
  try { return await renderSet(bitmap, bitmap.width, bitmap.height); } finally { bitmap.close(); }
}

/** 把一张图片缩放成三种缩略图规格，返回去掉 data: 前缀的 base64（离线任务附带的缩略图在任务创建后提交）。 */
export async function imageThumbnailSet(image: Blob): Promise<Record<string, string>> {
  let result: ThumbnailSet | null;
  try { result = await fromBlob(image); }
  catch { throw new Error("无法读取这张图片，请换用 JPEG、PNG、WebP 或 GIF 格式"); }
  if (!result) throw new Error("图片处理失败，请换一张图片再试");
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value).map(([variant, value]) => [variant, String(value).slice(String(value).indexOf(",") + 1)]));
}

/* ---------- 视频截帧 ---------- */

class VideoThumbnailError extends Error {}
function videoFailure(target: HTMLMediaElement) {
  return target.error?.code === 3 ? "浏览器无法解码视频，请确认文件编码受支持"
    : target.error?.code === 4 ? "浏览器不支持此视频，或无法读取来源"
    : "视频读取失败，请稍后重试";
}

function waitFor(target: HTMLMediaElement, event: string | string[], signal?: AbortSignal, timeout: number | null = 20000, ready?: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    if (target.error) { reject(new VideoThumbnailError(videoFailure(target))); return; }
    if (ready?.()) { resolve(); return; }
    const events = typeof event === "string" ? [event] : event;
    const done = (error?: unknown) => {
      if (timer !== null) window.clearTimeout(timer); events.forEach(name => target.removeEventListener(name, ok)); target.removeEventListener("error", failed); signal?.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const ok = () => { if (!ready || ready()) done(); }, failed = () => done(new VideoThumbnailError(videoFailure(target))), aborted = () => done(new DOMException("aborted", "AbortError"));
    const timer = timeout === null ? null : window.setTimeout(() => done(new VideoThumbnailError("视频读取或解码超时，可重试生成缩略图")), timeout);
    events.forEach(name => target.addEventListener(name, ok)); target.addEventListener("error", failed, { once: true }); signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** 缩小后的灰度样本（0–255），检查黑白占比、相近亮度集中程度与细节分布。 */
function frameLuma(video: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  canvas.width = VIDEO_SAMPLE_SIZE; canvas.height = VIDEO_SAMPLE_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return new Uint8Array();
  context.drawImage(video, 0, 0, VIDEO_SAMPLE_SIZE, VIDEO_SAMPLE_SIZE);
  const pixels = context.getImageData(0, 0, VIDEO_SAMPLE_SIZE, VIDEO_SAMPLE_SIZE).data;
  const luma = new Uint8Array(pixels.length / 4);
  for (let index = 0; index < luma.length; index++) luma[index] = Math.round(pixels[index * 4] * 0.299 + pixels[index * 4 + 1] * 0.587 + pixels[index * 4 + 2] * 0.114);
  return luma;
}

async function fromVideo(src: string, signal?: AbortSignal, onFailure?: (message: string) => void): Promise<ThumbnailSet | null> {
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.preload = "metadata";
  // 只防止浏览器解码卡住时一直占用生成权；不按文件大小区分，失败后交给服务器处理。
  const deadline = performance.now() + 120000;
  try {
    // 浏览器用 Range 取得容器索引；MP4 的 moov 可能在文件末尾，不能假设首个存储分片足够。
    const metadata = waitFor(video, "loadedmetadata", signal, Math.max(1, deadline - performance.now()), () => video.readyState >= 1);
    video.src = src;
    await metadata;
    if (video.readyState < 2) {
      const frame = waitFor(video, ["loadeddata", "canplay", "seeked", "timeupdate"], signal, Math.max(1, deadline - performance.now()), () => video.readyState >= 2 && video.videoWidth > 0);
      // metadata 不保证加载画面；主动解码开头，取得首帧就暂停，最后释放来源以停止后续下载。
      video.preload = "auto";
      video.currentTime = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(0.1, video.duration / 2) : 0.1;
      void video.play().catch(() => undefined);
      await frame;
      video.pause();
    }
    if (videoFrameUsable(video)) return await thumbnailsFromVideo(video);
    // 仅本地上传或显式生成时尝试多个位置；真实预览仍只截当前画面，不跳转播放位置。
    for (const candidate of VIDEO_FRAME_TIMES.slice(1)) {
      const time = Number.isFinite(video.duration) ? Math.min(candidate, Math.max(0, video.duration - 0.1)) : candidate;
      if (time <= video.currentTime + 0.01 || performance.now() >= deadline) continue;
      const seek = waitFor(video, "seeked", signal, Math.min(10000, Math.max(1, deadline - performance.now())), () => !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - time) < 0.1);
      video.currentTime = time;
      await seek;
      if (videoFrameUsable(video)) return await thumbnailsFromVideo(video);
    }
    onFailure?.("未找到适合的封面画面：候选画面过黑、过白或接近纯色");
    return null;
  } catch (reason) {
    if (signal?.aborted || reason instanceof DOMException && reason.name === "AbortError") throw reason;
    onFailure?.(reason instanceof VideoThumbnailError ? reason.message : "浏览器未能截取视频画面，可重试生成缩略图");
    return null;
  } finally {
    video.pause();
    video.removeAttribute("src"); video.load();
  }
}

/* ---------- 音频内嵌封面：MP3（ID3v2）、FLAC、M4A/MP4 ---------- */

type ByteReader = { size: number; read: (offset: number, length: number) => Promise<Uint8Array> };

function blobReader(blob: Blob): ByteReader {
  return { size: blob.size, read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) };
}

function urlReader(url: string, size: number, signal?: AbortSignal): ByteReader {
  return {
    size,
    read: async (offset, length) => {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const end = Math.min(size, offset + length);
      if (end <= offset) return new Uint8Array();
      const response = await fetch(url, { headers: { Range: `bytes=${offset}-${end - 1}` }, credentials: "include", signal });
      if (response.status !== 206 && response.status !== 200) throw new Error(`HTTP ${response.status}`);
      if (response.status === 206 && !response.headers.get("Content-Range")?.startsWith(`bytes ${offset}-`)) throw new Error("文件范围响应无效");
      if (!response.body) throw new Error("文件响应为空");
      const reader = response.body.getReader(), data = new Uint8Array(end - offset);
      // 来源忽略 Range 时也只流式跳过前缀、读取所需范围，随后立即取消，不把整首音频装入内存。
      let skip = response.status === 200 ? offset : 0, filled = 0;
      try {
        while (filled < data.length) {
          const { value, done } = await reader.read();
          if (done) throw new Error("文件数据不完整");
          const ignored = Math.min(skip, value.length);
          skip -= ignored;
          const piece = value.subarray(ignored, ignored + data.length - filled);
          data.set(piece, filled); filled += piece.length;
        }
        return data;
      } finally { await reader.cancel().catch(() => undefined); }
    },
  };
}

const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
const uint32 = (bytes: Uint8Array, at: number) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
const synchsafe = (bytes: Uint8Array, at: number) => (bytes[at] << 21) | (bytes[at + 1] << 14) | (bytes[at + 2] << 7) | bytes[at + 3];
const sniff = (data: Uint8Array) => data[0] === 0xff && data[1] === 0xd8 ? "image/jpeg" : data[0] === 0x89 && data[1] === 0x50 ? "image/png"
  : ascii(data, 8, 4) === "WEBP" ? "image/webp" : ascii(data, 0, 3) === "GIF" ? "image/gif" : "";

function picture(data: Uint8Array): Blob | null {
  const mime = sniff(data);
  return mime ? new Blob([data.slice()], { type: mime }) : null;
}

/** 编码相关的字符串结束位置：ISO-8859-1/UTF-8 以单个 0 结束，UTF-16 以对齐的两个 0 结束。 */
function textEnd(bytes: Uint8Array, start: number, encoding: number) {
  if (encoding === 1 || encoding === 2) {
    for (let index = start; index + 1 < bytes.length; index += 2) if (bytes[index] === 0 && bytes[index + 1] === 0) return index + 2;
  } else {
    for (let index = start; index < bytes.length; index++) if (bytes[index] === 0) return index + 1;
  }
  return bytes.length;
}

function parseId3(tag: Uint8Array): Blob | null {
  const version = tag[3], flags = tag[5];
  let bytes = tag;
  if (flags & 0x80) {
    // 整体反同步：去掉 0xFF 之后插入的 0x00。
    const out: number[] = [];
    for (let index = 0; index < tag.length; index++) { out.push(tag[index]); if (tag[index] === 0xff && tag[index + 1] === 0) index++; }
    bytes = new Uint8Array(out);
  }
  let offset = 10;
  if (flags & 0x40) offset += version === 4 ? synchsafe(bytes, 10) : uint32(bytes, 10) + 4;
  const headerSize = version === 2 ? 6 : 10;
  let fallback: Blob | null = null;
  while (offset + headerSize <= bytes.length) {
    const id = ascii(bytes, offset, version === 2 ? 3 : 4);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const size = version === 2 ? (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5]
      : version === 4 ? synchsafe(bytes, offset + 4) : uint32(bytes, offset + 4);
    const body = bytes.subarray(offset + headerSize, offset + headerSize + size);
    offset += headerSize + size;
    if (id !== "APIC" && id !== "PIC") continue;
    const encoding = body[0];
    let cursor = id === "PIC" ? 4 : textEnd(body, 1, 0);
    const type = body[cursor];
    cursor = textEnd(body, cursor + 1, encoding);
    const image = picture(body.subarray(cursor));
    if (image && type === 3) return image;  // 优先使用“封面（正面）”
    fallback ??= image;
  }
  return fallback;
}

/** 按帧头跳过无关 ID3 内容，只读取实际图片；旧版整体反同步标签保留兼容解码。 */
async function id3Cover(reader: ByteReader, head: Uint8Array): Promise<Blob | null> {
  const version = head[3], flags = head[5], end = 10 + synchsafe(head, 6);
  if (version < 2 || version > 4 || end > reader.size || version === 2 && flags & 0x40) throw new Error("不支持的音频标签");
  if (flags & 0x80 && version < 4) return parseId3(await reader.read(0, end));
  let offset = 10, fallback: Blob | null = null;
  if (flags & 0x40) {
    const extended = await reader.read(offset, 4);
    offset += version === 4 ? synchsafe(extended, 0) : uint32(extended, 0) + 4;
  }
  const headerSize = version === 2 ? 6 : 10;
  while (offset + headerSize <= end) {
    const header = await reader.read(offset, headerSize), id = ascii(header, 0, version === 2 ? 3 : 4);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const size = version === 2 ? (header[3] << 16) | (header[4] << 8) | header[5]
      : version === 4 ? synchsafe(header, 4) : uint32(header, 4);
    offset += headerSize;
    if (offset + size > end) throw new Error("音频标签不完整");
    if (id === "APIC" || id === "PIC") {
      if (version === 3 && header[9] & 0xc0 || version === 4 && header[9] & 0x0c) throw new Error("不支持的封面编码");
      let body = await reader.read(offset, size);
      if (version === 3 && header[9] & 0x20 || version === 4 && header[9] & 0x40) body = body.subarray(1);
      if (version === 4 && header[9] & 0x01) body = body.subarray(4);
      if (version === 4 && (flags & 0x80 || header[9] & 0x02)) {
        const decoded = new Uint8Array(body.length);
        let length = 0;
        for (let index = 0; index < body.length; index++) { decoded[length++] = body[index]; if (body[index] === 0xff && body[index + 1] === 0) index++; }
        body = decoded.subarray(0, length);
      }
      let cursor = id === "PIC" ? 4 : textEnd(body, 1, 0);
      const type = body[cursor];
      cursor = textEnd(body, cursor + 1, body[0]);
      const image = picture(body.subarray(cursor));
      if (!image) throw new Error("浏览器不支持这张内嵌封面");
      if (type === 3) return image;
      fallback ??= image;
    }
    offset += size;
  }
  return fallback;
}

async function flacCover(reader: ByteReader, start = 0): Promise<Blob | null> {
  let offset = start + 4, fallback: Blob | null = null;
  while (offset + 4 <= reader.size) {
    const header = await reader.read(offset, 4);
    const last = header[0] & 0x80, type = header[0] & 0x7f, length = (header[1] << 16) | (header[2] << 8) | header[3];
    if (offset + 4 + length > reader.size) throw new Error("音频元数据不完整");
    if (type === 6) {
      const block = await reader.read(offset + 4, length);
      let cursor = 4;
      cursor += 4 + uint32(block, cursor);  // MIME
      cursor += 4 + uint32(block, cursor);  // 描述
      cursor += 16;                          // 宽、高、色深、调色板
      const size = uint32(block, cursor);
      if (cursor + 4 + size > block.length) throw new Error("内嵌封面不完整");
      const image = picture(block.subarray(cursor + 4, cursor + 4 + size));
      if (!image) throw new Error("浏览器不支持这张内嵌封面");
      if (uint32(block, 0) === 3) return image;
      fallback ??= image;
    }
    if (last) return fallback;
    offset += 4 + length;
  }
  throw new Error("音频元数据不完整");
}

/** 按 box 头跳过音轨与无关元数据，不读取整个 moov，也不限制 box 数或元数据大小。 */
async function findBox(reader: ByteReader, start: number, end: number, type: string): Promise<[number, number] | null> {
  let offset = start;
  while (offset + 8 <= end) {
    const bytes = await reader.read(offset, Math.min(16, end - offset));
    let size = uint32(bytes, 0), header = 8;
    if (size === 1) { size = uint32(bytes, 8) * 2 ** 32 + uint32(bytes, 12); header = 16; }
    if (size === 0) size = end - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > end) throw new Error("音频索引无效");
    if (ascii(bytes, 4, 4) === type) return [offset + header, offset + size];
    offset += size;
  }
  return null;
}

async function mp4Cover(reader: ByteReader): Promise<Blob | null> {
  const moov = await findBox(reader, 0, reader.size, "moov");
  if (!moov) throw new Error("音频缺少索引");
  const udta = await findBox(reader, ...moov, "udta");
  let box = (udta && await findBox(reader, ...udta, "meta")) || await findBox(reader, ...moov, "meta");
  if (!box) return null;
  box = [box[0] + 4, box[1]];  // meta 是 full box，跳过版本与标志
  for (const type of ["ilst", "covr", "data"]) box = box && await findBox(reader, ...box, type);
  if (!box) return null;
  const image = picture(await reader.read(box[0] + 8, box[1] - box[0] - 8));
  if (!image) throw new Error("浏览器不支持这张内嵌封面");
  return image;
}

async function audioCover(reader: ByteReader): Promise<Blob | "none" | null> {
  const head = await reader.read(0, Math.min(reader.size, 10));
  if (ascii(head, 0, 3) === "ID3") {
    const cover = await id3Cover(reader, head);
    if (cover) return cover;
    const next = 10 + synchsafe(head, 6) + (head[3] === 4 && head[5] & 0x10 ? 10 : 0);
    if (ascii(await reader.read(next, 4), 0, 4) === "fLaC") return await flacCover(reader, next) ?? "none";
    return "none";
  }
  if (ascii(head, 0, 4) === "fLaC") return await flacCover(reader) ?? "none";
  if (ascii(head, 4, 4) === "ftyp") return await mp4Cover(reader) ?? "none";
  // 未识别的封装交给服务器处理，不能据此永久标记没有封面。
  return null;
}

/* ---------- 入口 ---------- */

type Input = ({ file: Blob } | { url: string; size: number }) & { signal?: AbortSignal; onFailure?: (message: string) => void };

export async function createThumbnails(input: Input, source: ThumbnailSource): Promise<ThumbnailResult> {
  try {
    if (source === "image") return await fromBlob("file" in input ? input.file : await (await fetch(input.url, { credentials: "include", signal: input.signal })).blob());
    if (source === "video") {
      const url = "file" in input ? URL.createObjectURL(input.file) : input.url;
      try { return await fromVideo(url, input.signal, input.onFailure); } finally { if ("file" in input) URL.revokeObjectURL(url); }
    }
    const cover = await audioCover("file" in input ? blobReader(input.file) : urlReader(input.url, input.size, input.signal));
    return cover === "none" ? "none" : cover ? await fromBlob(cover) : null;
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
    return null;
  }
}

/** 保存生成结果；返回保存后的缩略图状态，供界面立即更新。 */
export async function saveThumbnails(path: string, result: ThumbnailResult, claim: api.ThumbnailClaim = {}): Promise<string[] | null> {
  if (!result) return null;
  if (result === "none") { await api.markNoThumbnail(path, claim); return ["none"]; }
  await api.setThumbnail(path, result.thumb, "thumb", claim);
  // 网格图与封面写入系统区（计入空间）；失败（如空间不足）时界面退回小图，不影响列表。
  const saved = ["thumb"];
  for (const variant of ["grid", "poster"] as const) {
    const data = result[variant];
    if (data && await api.setThumbnail(path, data, variant, claim).then(() => true, () => false)) saved.push(variant);
  }
  return saved;
}

/** 长处理与慢速保存期间续期；页面关闭后不再续期，由服务器回收票据。 */
function keepClaim(file: Pick<api.FileItem, "key" | "etag">, ticket: string, expires: number, failed?: () => void) {
  let stopped = false, error: unknown, timer = 0;
  const renew = async () => {
    try { await api.renewThumbnail(file, ticket); }
    catch (reason) { if (!stopped) { error = reason; failed?.(); } return; }
    if (!stopped) timer = window.setTimeout(() => void renew(), expires * 1000 / 3);
  };
  timer = window.setTimeout(() => void renew(), expires * 1000 / 3);
  return { stop: () => { stopped = true; window.clearTimeout(timer); }, check: () => { if (error) throw error; } };
}

/** 用户指定的缩略图适用于任何文件：取得自定义票据（会取消这个文件排队中的自动生成），保存全部规格后移除旧的多余规格。 */
async function saveCustomThumbnails(file: Pick<api.FileItem, "key" | "etag">, result: ThumbnailSet): Promise<string[]> {
  const lease = await api.claimThumbnail(file, true, true);
  if (!lease.token) throw new Error("暂时无法更新缩略图，请稍后重试");
  const heartbeat = keepClaim(file, lease.token, lease.expires_in ?? 90);
  let released = false;
  try {
    const saved = await saveThumbnails(file.key, result, { etag: file.etag, ticket: lease.token }) ?? ["thumb"];
    heartbeat.check();
    await api.releaseThumbnail(file, lease.token, saved);
    released = true;
    return saved;
  } finally {
    heartbeat.stop();
    if (!released) await api.releaseThumbnail(file, lease.token).catch(() => undefined);
  }
}

/** 用户选择当前播放画面：先同步固定这一帧，再申请写入，不用自动画面过滤或重新读取视频。 */
export async function saveCurrentVideoThumbnail(file: Pick<api.FileItem, "key" | "etag">, video: HTMLVideoElement): Promise<void> {
  const result = await thumbnailsFromVideo(video, false);
  if (!result) throw new Error("当前画面尚未就绪，请等待画面加载后重试");
  await saveCustomThumbnails(file, result);
}

/** 用户上传或从网址取得的图片：在浏览器里解码并缩放成三种规格，不把原图存进文件空间。 */
export async function saveImageThumbnail(file: Pick<api.FileItem, "key" | "etag">, image: Blob): Promise<string[]> {
  let result: ThumbnailSet | null;
  try { result = await fromBlob(image); }
  catch { throw new Error("无法读取这张图片，请换用 JPEG、PNG、WebP 或 GIF 格式"); }
  if (!result) throw new Error("图片处理失败，请换一张图片再试");
  return await saveCustomThumbnails(file, result);
}

/** 浏览器取得生成权后处理本地／已加载数据，处理期间持续续期（不设总时限）；失败主动交还，页面关闭则由服务端超时接管。 */
export async function generateLoadedThumbnails(file: Pick<api.FileItem, "key" | "etag">, produce: (signal: AbortSignal) => Promise<ThumbnailResult>, force = false, signal?: AbortSignal): Promise<string[] | null> {
  if (signal?.aborted) return null;
  const lease = await api.claimThumbnail(file, force);
  if (!lease.token) return null;
  const controller = new AbortController();
  const heartbeat = keepClaim(file, lease.token, lease.expires_in ?? 90, () => controller.abort());
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let stopWaiting: (() => void) | undefined;
  try {
    if (signal?.aborted) return null;
    const stopped = new Promise<never>((_, reject) => {
      stopWaiting = () => reject(new DOMException("aborted", "AbortError"));
      controller.signal.addEventListener("abort", stopWaiting, { once: true });
    });
    const result = await Promise.race([produce(controller.signal), stopped]);
    heartbeat.check();
    if (controller.signal.aborted) return null;
    const saved = await saveThumbnails(file.key, result, { etag: file.etag, ticket: lease.token });
    heartbeat.check();
    return saved;
  } finally {
    heartbeat.stop(); if (stopWaiting) controller.signal.removeEventListener("abort", stopWaiting);
    controller.abort(); signal?.removeEventListener("abort", abort);
    await api.releaseThumbnail(file, lease.token).catch(() => undefined);
  }
}
