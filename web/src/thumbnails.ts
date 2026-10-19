/** 浏览器缩略图生成：图片缩放、视频截帧、音频内嵌封面；网页上传优先复用本地文件，后台服务另行补生成。
 * 三种规格：thumb（最长边 160px，列表、目录四宫格）、grid（640px，网格卡片）与 poster（960px，预览封面与占位）；
 * 后两种只在原图明显更大时生成，存为系统区对象并计入用户空间。旧文件没有 grid 时网格退回 poster 或旧版 320px 的 thumb。 */
import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import { getFileKind } from "./files";
import { videoFramePixelsUsable } from "./video-frame";

export type ThumbnailSource = "image" | "video" | "audio";
export type ThumbnailSet = { thumb: string; grid?: string; poster?: string };
/** 生成结果：图片集合；"none" 表示确定无法生成（如音频没有封面）；null 表示这次没成功，可以稍后再试。 */
export type ThumbnailResult = ThumbnailSet | "none" | null;

const THUMB = { size: 160, budget: 24 * 1024 };
const GRID = { size: 640, budget: 120 * 1024 };
const POSTER = { size: 960, budget: 220 * 1024 };
const IMAGE_LIMIT = 60 * 1024 * 1024;

export function thumbnailSource(name: string, type: string | null | undefined, size: number): ThumbnailSource | null {
  const kind = getFileKind(type, name);
  if (kind === "image") return /\.svg$/i.test(name) || (type || "").includes("svg") || size > IMAGE_LIMIT ? null : "image";
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
export function thumbnailsFromVideo(video: HTMLVideoElement): Promise<ThumbnailSet | null> {
  try {
    if (!videoFrameUsable(video)) return Promise.resolve(null);
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

/* ---------- 视频截帧 ---------- */

class VideoThumbnailError extends Error {}
function videoFailure(target: HTMLMediaElement) {
  return target.error?.code === 3 ? "浏览器无法解码视频，请确认文件编码受支持"
    : target.error?.code === 4 ? "浏览器不支持此视频，或无法读取来源"
    : "视频读取失败，请稍后重试";
}

function waitFor(target: HTMLMediaElement, event: string | string[], signal?: AbortSignal, timeout = 20000, ready?: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    if (target.error) { reject(new VideoThumbnailError(videoFailure(target))); return; }
    if (ready?.()) { resolve(); return; }
    const events = typeof event === "string" ? [event] : event;
    const done = (error?: unknown) => {
      window.clearTimeout(timer); events.forEach(name => target.removeEventListener(name, ok)); target.removeEventListener("error", failed); signal?.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const ok = () => { if (!ready || ready()) done(); }, failed = () => done(new VideoThumbnailError(videoFailure(target))), aborted = () => done(new DOMException("aborted", "AbortError"));
    const timer = window.setTimeout(() => done(new VideoThumbnailError("视频读取或解码超时，可重试生成缩略图")), timeout);
    events.forEach(name => target.addEventListener(name, ok)); target.addEventListener("error", failed, { once: true }); signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** 缩小后的灰度样本（0–255），同时判断黑白占比与画面细节。 */
function frameLuma(video: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  canvas.width = 32; canvas.height = 32;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return new Uint8Array();
  context.drawImage(video, 0, 0, 32, 32);
  const pixels = context.getImageData(0, 0, 32, 32).data;
  const luma = new Uint8Array(pixels.length / 4);
  for (let index = 0; index < luma.length; index++) luma[index] = Math.round(pixels[index * 4] * 0.299 + pixels[index * 4 + 1] * 0.587 + pixels[index * 4 + 2] * 0.114);
  return luma;
}

async function fromVideo(src: string, signal?: AbortSignal, onFailure?: (message: string) => void): Promise<ThumbnailSet | null> {
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.preload = "metadata";
  const deadline = performance.now() + 45000;
  try {
    // 浏览器用 Range 取得容器索引；MP4 的 moov 可能在文件末尾，不能假设首个存储分片足够。
    const metadata = waitFor(video, "loadedmetadata", signal, 45000, () => video.readyState >= 1);
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
    for (const candidate of [1, 3, 10, 30]) {
      const time = Number.isFinite(video.duration) ? Math.min(candidate, Math.max(0, video.duration - 0.1)) : candidate;
      if (time <= video.currentTime + 0.01 || performance.now() >= deadline) continue;
      const seek = waitFor(video, "seeked", signal, Math.min(3000, Math.max(1, deadline - performance.now())), () => !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - time) < 0.1);
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
      const end = Math.min(size, offset + length) - 1;
      const response = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` }, credentials: "include", signal });
      if (response.status !== 206 && !(response.ok && offset === 0)) throw new Error(`HTTP ${response.status}`);
      const data = new Uint8Array(await response.arrayBuffer());
      return response.status === 206 ? data : data.subarray(offset, end + 1);
    },
  };
}

const MAX_COVER_TAG = 16 * 1024 * 1024;
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

async function flacCover(reader: ByteReader): Promise<Blob | null> {
  let offset = 4;
  for (let index = 0; index < 64 && offset + 4 <= reader.size; index++) {
    const header = await reader.read(offset, 4);
    const last = header[0] & 0x80, type = header[0] & 0x7f, length = (header[1] << 16) | (header[2] << 8) | header[3];
    if (type === 6 && length <= MAX_COVER_TAG) {
      const block = await reader.read(offset + 4, length);
      let cursor = 4;
      cursor += 4 + uint32(block, cursor);  // MIME
      cursor += 4 + uint32(block, cursor);  // 描述
      cursor += 16;                          // 宽、高、色深、调色板
      const size = uint32(block, cursor);
      return picture(block.subarray(cursor + 4, cursor + 4 + size));
    }
    if (last) break;
    offset += 4 + length;
  }
  return null;
}

function findBox(bytes: Uint8Array, start: number, end: number, type: string): [number, number] | null {
  let offset = start;
  while (offset + 8 <= end) {
    let size = uint32(bytes, offset), header = 8;
    if (size === 1) { size = uint32(bytes, offset + 8) * 2 ** 32 + uint32(bytes, offset + 12); header = 16; }
    if (size === 0) size = end - offset;
    if (size < header) return null;
    if (ascii(bytes, offset + 4, 4) === type) return [offset + header, Math.min(end, offset + size)];
    offset += size;
  }
  return null;
}

async function mp4Cover(reader: ByteReader): Promise<Blob | null> {
  let offset = 0;
  for (let index = 0; index < 64 && offset + 8 <= reader.size; index++) {
    const header = await reader.read(offset, 16);
    let size = uint32(header, 0);
    if (size === 1) size = uint32(header, 8) * 2 ** 32 + uint32(header, 12);
    if (size === 0) size = reader.size - offset;
    if (size < 8) return null;
    if (ascii(header, 4, 4) === "moov") {
      if (size > 4 * MAX_COVER_TAG) return null;
      const moov = await reader.read(offset, size);
      let box: [number, number] | null = [8, moov.length];
      for (const type of ["udta", "meta", "ilst", "covr", "data"]) {
        box = box && findBox(moov, box[0], box[1], type);
        if (box && type === "meta") box = [box[0] + 4, box[1]];  // meta 是 full box，跳过版本与标志
      }
      return box ? picture(moov.subarray(box[0] + 8, box[1])) : null;
    }
    offset += size;
  }
  return null;
}

async function audioCover(reader: ByteReader): Promise<Blob | null> {
  const head = await reader.read(0, Math.min(reader.size, 64 * 1024));
  if (ascii(head, 0, 3) === "ID3") {
    const total = 10 + synchsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
    if (total > MAX_COVER_TAG) return null;
    return parseId3(total <= head.length ? head.subarray(0, total) : await reader.read(0, total));
  }
  if (ascii(head, 0, 4) === "fLaC") return flacCover(reader);
  if (ascii(head, 4, 4) === "ftyp") return mp4Cover(reader);
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
    return cover ? await fromBlob(cover) ?? "none" : "none";
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

/** 浏览器取得有期限的生成权后才处理本地／已加载数据；失败主动交还，页面关闭则由服务端超时接管。 */
export async function generateLoadedThumbnails(file: Pick<api.FileItem, "key" | "etag">, produce: (signal: AbortSignal) => Promise<ThumbnailResult>, force = false, signal?: AbortSignal): Promise<string[] | null> {
  if (signal?.aborted) return null;
  const lease = await api.claimThumbnail(file, force);
  if (!lease.token) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let timer = 0;
  try {
    if (signal?.aborted) return null;
    const result = await Promise.race([produce(controller.signal), new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => { controller.abort(); reject(new Error("缩略图生成超时")); }, 60000);
    })]);
    if (controller.signal.aborted) return null;
    return await saveThumbnails(file.key, result, { etag: file.etag, ticket: lease.token });
  } finally {
    controller.abort(); window.clearTimeout(timer); signal?.removeEventListener("abort", abort);
    await api.releaseThumbnail(file, lease.token).catch(() => undefined);
  }
}

/* ---------- 用户主动提交后台生成 ---------- */

type ThumbnailWork = { etag: string; phase: "queued" | "failed"; message: string };

/** 只提交用户点击的任务；不在浏览器读取原文件，也不向普通用户轮询后台队列。 */
export function useThumbnailGenerator(files: api.FileItem[], onQueued: () => void) {
  const [states, setStates] = useState<Record<string, ThumbnailWork>>({});
  const current = useRef(files), queued = useRef(onQueued), mounted = useRef(true);
  const requests = useRef(new Set<string>());
  const refreshTimers = useRef<number[]>([]);
  current.current = files; queued.current = onQueued;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; refreshTimers.current.forEach(window.clearTimeout); }; }, []);
  useEffect(() => {
    const identities = new Map(files.map(file => [file.key, file.etag]));
    setStates(previous => {
      const entries = Object.entries(previous).filter(([key, state]) => identities.get(key) === state.etag);
      return entries.length === Object.keys(previous).length ? previous : Object.fromEntries(entries);
    });
  }, [files]);
  return {
    state: (file: api.FileItem) => states[file.key]?.etag === file.etag ? states[file.key] : undefined,
    generate: async (file: api.FileItem) => {
      const identity = `${file.key}:${file.etag}`;
      if (requests.current.has(identity)) return;
      requests.current.add(identity);
      setStates(previous => ({ ...previous, [file.key]: { etag: file.etag, phase: "queued", message: "正在提交生成请求" } }));
      try {
        await api.generateThumbnail(file);
        if (mounted.current && current.current.some(item => item.key === file.key && item.etag === file.etag)) {
          setStates(previous => { const next = { ...previous }; delete next[file.key]; return next; });
          queued.current();
          // 用户提交后的有界元数据刷新，不查询任务队列，也不读取原文件。
          refreshTimers.current.forEach(window.clearTimeout);
          refreshTimers.current = [3000, 15000, 60000, 150000].map(delay => window.setTimeout(() => {
            if (mounted.current) window.dispatchEvent(new CustomEvent("tessera:files-added", { detail: { folders: [file.key.slice(0, file.key.lastIndexOf("/") + 1)] } }));
          }, delay));
        }
      } catch (reason) {
        if (mounted.current) setStates(previous => ({ ...previous, [file.key]: { etag: file.etag, phase: "failed", message: api.errorMessage(reason, "提交失败，请重试") } }));
      } finally { requests.current.delete(identity); }
    },
  };
}
