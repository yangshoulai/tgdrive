import { useEffect, useState } from "react";

/**
 * 资源抓取脚本的「浏览器上传到私密空间」转交：访问密钥不能写入私密空间，脚本在用户点击时用 window.open 打开
 * `/?view=private#receive=<nonce>&from=<来源页 origin>`，本页通过 postMessage 向 opener 报到，脚本再把浏览器下载好的
 * 文件（Blob）逐个发来。文件只在本页内存里，用户解锁私密空间、在上传对话框确认后才通过网页会话上传。
 *
 * 只接受 event.source 为 opener、event.origin 为地址中声明的来源、且 nonce 一致的消息；数量与大小与脚本的上限一致。
 * 协议：本页 → 脚本 {source:"tessera", type:"transfer-ready"|"transfer-ack"}；脚本 → 本页 {source:"tessera-grabber", type:"file"|"end"}。
 */
export const TRANSFER_MAX_FILES = 50;
export const TRANSFER_MAX_BYTES = 64 * 1024 * 1024;

export type TransferRequest = { nonce: string; origin: string };
export type TransferState = { request: TransferRequest; files: File[]; ended: boolean; error: string; rejected: number };

export function takeTransferRequest(): TransferRequest | null {
  const match = /^#receive=([A-Za-z0-9_-]{16,64})&from=([^&]+)$/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  try {
    const origin = new URL(decodeURIComponent(match[2])).origin;
    if (!/^https?:\/\//.test(origin) || origin === window.location.origin) return null;
    return { nonce: match[1], origin };
  } catch { return null; }
}

/** 文件名只保留最后一段，去掉控制字符；空名称用「文件 n」。 */
function cleanName(value: unknown, index: number) {
  const name = typeof value === "string" ? value.split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f]/g, "").trim().normalize("NFC") : "";
  return name && name !== "." && name !== ".." ? name.slice(0, 255) : `文件 ${index + 1}`;
}

export function useTransferReceiver(request: TransferRequest | null) {
  const [state, setState] = useState<TransferState | null>(() => request && { request, files: [], ended: false, error: "", rejected: 0 });
  useEffect(() => {
    if (!request) return;
    const opener = window.opener as Window | null;
    if (!opener) {
      setState(value => value && { ...value, ended: true, error: "无法连接到来源页面（可能已关闭或禁止跨站窗口通信），请回到原页面重试，或手动保存文件后上传" });
      return;
    }
    const post = (message: Record<string, unknown>) => { try { opener.postMessage({ source: "tessera", nonce: request.nonce, ...message }, request.origin); } catch { /* 来源页已关闭 */ } };
    const names = new Set<string>();
    let count = 0;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: unknown; nonce?: unknown; type?: unknown; index?: unknown; name?: unknown; blob?: unknown } | null;
      if (event.source !== opener || event.origin !== request.origin || !data || data.source !== "tessera-grabber" || data.nonce !== request.nonce) return;
      if (data.type === "end") { setState(value => value && { ...value, ended: true }); return; }
      if (data.type !== "file") return;
      const index = typeof data.index === "number" ? data.index : count;
      const blob = data.blob;
      if (!(blob instanceof Blob) || !blob.size || blob.size > TRANSFER_MAX_BYTES || count >= TRANSFER_MAX_FILES) {
        post({ type: "transfer-ack", index, ok: false, error: count >= TRANSFER_MAX_FILES ? `一次最多转交 ${TRANSFER_MAX_FILES} 个文件` : "文件为空或超过 64 MiB" });
        setState(value => value && { ...value, rejected: value.rejected + 1 });
        return;
      }
      // 同名文件在对话框里会互相覆盖，这里先加序号区分。
      let name = cleanName(data.name, index);
      for (let n = 2; names.has(name); n += 1) name = cleanName(data.name, index).replace(/(\.[^.]*)?$/, ext => ` (${n})${ext}`);
      names.add(name);
      count += 1;
      const file = new File([blob], name, { type: blob.type });
      setState(value => value && { ...value, files: [...value.files, file] });
      post({ type: "transfer-ack", index, ok: true });
    };
    window.addEventListener("message", onMessage);
    post({ type: "transfer-ready" });
    return () => window.removeEventListener("message", onMessage);
  }, [request]);
  return [state, () => setState(null)] as const;
}
