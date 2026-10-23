import * as api from "../api";

/** 逐页读取文件夹树，不受当前列表的搜索、类型或公开筛选影响。 */
export async function* cacheFolderFiles(prefixes: string[], signal: AbortSignal,
  load = (prefix: string, cursor: string | null, signal: AbortSignal) => api.listFiles(prefix, cursor, false, 200, "", signal)) {
  const roots = [...new Set(prefixes)].filter(prefix => prefix && prefix.endsWith("/"));
  const pending = roots.filter(prefix => !roots.some(other => other !== prefix && prefix.startsWith(other)));
  const visited = new Set(pending);
  for (let index = 0; index < pending.length; index++) {
    const prefix = pending[index];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      signal.throwIfAborted();
      const page = await load(prefix, cursor, signal);
      signal.throwIfAborted();
      const next = page.next_cursor;
      if (next && cursors.has(next)) throw new Error("文件夹列表未能继续读取，请重试");
      if (next) cursors.add(next);
      for (const folder of page.common_prefixes) {
        // 只遍历目标的后代，避免重复目录或异常响应越出用户确认的范围。
        if (folder !== prefix && folder.startsWith(prefix) && folder.endsWith("/") && !visited.has(folder)) {
          visited.add(folder); pending.push(folder);
        }
      }
      yield page.objects.filter(file => file.key.startsWith(prefix) && !file.key.endsWith("/"));
      cursor = next;
    } while (cursor);
  }
}
