/** 内容指纹（秒传用），算法与服务端 src/tgdrive/fingerprint.py 一致：
 * 按 16 MiB 分块分别计算 SHA-256，再哈希「tgdrive-fp-v1\n + 文件大小(8 字节大端) + 全部块哈希」。 */

export const FINGERPRINT_BLOCK = 16 * 1024 * 1024;

/** WebCrypto 只在 HTTPS 或 localhost 下可用；不可用时直接跳过秒传，按普通方式上传。 */
export const fingerprintSupported = () => typeof crypto !== "undefined" && Boolean(crypto.subtle);

const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");

export async function fingerprintFile(file: File, onProgress?: (fraction: number) => void, control?: { aborted: boolean }): Promise<string> {
  const count = Math.ceil(file.size / FINGERPRINT_BLOCK);
  const leaves = new Uint8Array(count * 32);
  const read = (index: number) => file.slice(index * FINGERPRINT_BLOCK, (index + 1) * FINGERPRINT_BLOCK).arrayBuffer();
  // 计算当前块的同时预读下一块，磁盘读取和哈希重叠进行。
  let next = count ? read(0) : null;
  for (let index = 0; index < count; index++) {
    const buffer = await next!;
    next = index + 1 < count ? read(index + 1) : null;
    if (control?.aborted) throw new Error("fingerprint aborted");
    leaves.set(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), index * 32);
    onProgress?.(Math.min(1, ((index + 1) * FINGERPRINT_BLOCK) / file.size));
  }
  const header = new TextEncoder().encode("tgdrive-fp-v1\n");
  const message = new Uint8Array(header.length + 8 + leaves.length);
  message.set(header, 0);
  new DataView(message.buffer).setBigUint64(header.length, BigInt(file.size));
  message.set(leaves, header.length + 8);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", message)));
}
