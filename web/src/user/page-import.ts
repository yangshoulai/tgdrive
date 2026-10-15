import { useEffect, useState } from "react";
import type { SnapshotPage } from "../assistant-api";

/**
 * 资源抓取脚本的「发给文件助手」（docs/assistant-design.md §9.1）：脚本在用户点击时用 window.open 打开
 * `/?view=files#assistant-page=<nonce>&from=<来源页 origin>`，本页向 opener 报到，脚本再把已渲染页面的结构快照发来。
 * 快照只在本页内存里，由用户在助手对话框里点击发送后才上传；访问密钥与网页会话都不经过脚本。
 *
 * 只接受 event.source 为 opener、event.origin 为地址中声明的来源、且 nonce 一致的消息；页数、图片数与大小超限即拒绝。
 * 协议：本页 → 脚本 {source:"tessera", type:"page-ready"|"page-ack"}；脚本 → 本页 {source:"tessera-grabber", type:"page-snapshot", pages}。
 */
export const SNAPSHOT_MAX_PAGES = 50;
export const SNAPSHOT_MAX_IMAGES = 5000;
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

export type PageImportRequest = { nonce: string; origin: string };
export type PageImport = { request: PageImportRequest; pages: SnapshotPage[] | null; error: string; images: number };

export function takePageImportRequest(): PageImportRequest | null {
  const match = /^#assistant-page=([A-Za-z0-9_-]{16,64})&from=([^&]+)$/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  try {
    const origin = new URL(decodeURIComponent(match[2])).origin;
    if (!/^https?:\/\//.test(origin) || origin === window.location.origin) return null;
    return { nonce: match[1], origin };
  } catch { return null; }
}

/** 粗查结构与上限；服务端上传时还会逐项校验地址与字段。 */
export function checkSnapshot(value: unknown): { pages: SnapshotPage[]; images: number } | string {
  if (!Array.isArray(value) || value.length === 0) return "快照为空";
  if (value.length > SNAPSHOT_MAX_PAGES) return `一次最多发送 ${SNAPSHOT_MAX_PAGES} 页`;
  let images = 0;
  for (const page of value) {
    if (!page || typeof page !== "object" || typeof (page as SnapshotPage).url !== "string" || !Array.isArray((page as SnapshotPage).images)) return "快照格式不正确";
    if (!/^https?:\/\//.test((page as SnapshotPage).url)) return "快照页面地址必须是 http(s)";
    images += (page as SnapshotPage).images.length;
  }
  if (images > SNAPSHOT_MAX_IMAGES) return `图片候选超过 ${SNAPSHOT_MAX_IMAGES.toLocaleString("zh-CN")} 个`;
  if (new Blob([JSON.stringify(value)]).size > SNAPSHOT_MAX_BYTES) return "快照超过 2 MB";
  return { pages: value as SnapshotPage[], images };
}

export function usePageImport(request: PageImportRequest | null) {
  const [state, setState] = useState<PageImport | null>(() => request && { request, pages: null, error: "", images: 0 });
  useEffect(() => {
    if (!request) return;
    const opener = window.opener as Window | null;
    if (!opener) {
      setState(value => value && { ...value, error: "无法连接到来源页面（可能已关闭或禁止跨站窗口通信），请回到原页面重新发送" });
      return;
    }
    const post = (message: Record<string, unknown>) => { try { opener.postMessage({ source: "tessera", nonce: request.nonce, ...message }, request.origin); } catch { /* 来源页已关闭 */ } };
    let received = false;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: unknown; nonce?: unknown; type?: unknown; pages?: unknown } | null;
      if (event.source !== opener || event.origin !== request.origin || !data || data.source !== "tessera-grabber"
        || data.nonce !== request.nonce || data.type !== "page-snapshot" || received) return;
      const checked = checkSnapshot(data.pages);
      if (typeof checked === "string") {
        post({ type: "page-ack", ok: false, error: checked });
        setState(value => value && { ...value, error: checked });
        return;
      }
      if (checked.pages.some(page => { try { return new URL(page.url).origin !== request.origin; } catch { return true; } })) {
        const error = "快照页面与发送来源不一致";
        post({ type: "page-ack", ok: false, error });
        setState(value => value && { ...value, error });
        return;
      }
      received = true;
      post({ type: "page-ack", ok: true });
      setState(value => value && { ...value, pages: checked.pages, images: checked.images });
    };
    window.addEventListener("message", onMessage);
    post({ type: "page-ready" });
    const timer = window.setTimeout(() => { if (!received) setState(value => value && !value.pages ? { ...value, error: value.error || "没有收到来源页面的快照，请回到原页面重新发送" } : value); }, 15000);
    return () => { window.removeEventListener("message", onMessage); window.clearTimeout(timer); };
  }, [request]);
  return [state, () => setState(null)] as const;
}
