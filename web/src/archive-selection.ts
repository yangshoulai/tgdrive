/** 压缩包里的目录结构与「选择部分文件解压」：压缩包预览与解压对话框共用。只处理 ZIP（有目录索引）。 */
import type { ArchiveEntry } from "./api";

export type ArchiveItem = { name: string; path: string; dir: boolean; size: number; entry?: ArchiveEntry; files: number };

const collator = new Intl.Collator("zh-CN", { numeric: true });

/** 某个目录下的直接子项：文件夹汇总其中的文件数与大小（压缩包里没有目录条目的文件夹也会出现）。 */
export function archiveChildren(entries: ArchiveEntry[], folder: string): ArchiveItem[] {
  const items = new Map<string, ArchiveItem>();
  for (const entry of entries) {
    if (!entry.name.startsWith(folder) || entry.name === folder) continue;
    const rest = entry.name.slice(folder.length), slash = rest.indexOf("/");
    if (slash >= 0 && slash < rest.length - 1 || entry.dir) {
      const name = rest.slice(0, slash >= 0 ? slash : rest.length), path = `${folder}${name}/`;
      const item = items.get(path) ?? { name, path, dir: true, size: 0, files: 0 };
      if (!entry.dir) { item.size += entry.size; item.files += 1; }
      items.set(path, item);
    } else items.set(entry.name, { name: rest, path: entry.name, dir: false, size: entry.size, entry, files: 1 });
  }
  return [...items.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || collator.compare(a.name, b.name));
}

/** 可以解压的文件（不含文件夹条目）。 */
export const archiveFiles = (entries: ArchiveEntry[]) => entries.filter(entry => !entry.dir);

/** 选中的项目（文件名，或以 / 结尾的文件夹）展开成文件名集合。 */
export function expandSelection(entries: ArchiveEntry[], picks: Iterable<string>): Set<string> {
  const result = new Set<string>();
  const folders: string[] = [];
  for (const pick of picks) { if (pick.endsWith("/")) folders.push(pick); else result.add(pick); }
  if (folders.length) for (const entry of entries) if (!entry.dir && folders.some(folder => entry.name.startsWith(folder))) result.add(entry.name);
  return result;
}

export type FolderCounts = Map<string, { total: number; chosen: number }>;
/** 一次统计每个文件夹里的文件数与选中数（每个文件计入它的各级上级文件夹），避免逐行扫描全部条目。 */
export function folderCounts(entries: ArchiveEntry[], selected: Set<string>): FolderCounts {
  const counts: FolderCounts = new Map();
  for (const entry of entries) {
    if (entry.dir) continue;
    const chosen = selected.has(entry.name);
    for (let slash = entry.name.indexOf("/"); slash >= 0; slash = entry.name.indexOf("/", slash + 1)) {
      const folder = entry.name.slice(0, slash + 1), count = counts.get(folder) ?? { total: 0, chosen: 0 };
      count.total++; if (chosen) count.chosen++;
      counts.set(folder, count);
    }
  }
  return counts;
}

/** 文件夹的勾选状态：其中的文件全选、部分选中或都没选（空文件夹按没选）。 */
export function folderState(counts: FolderCounts, folder: string): "all" | "some" | "none" {
  const count = counts.get(folder);
  return !count || !count.chosen ? "none" : count.chosen === count.total ? "all" : "some";
}

/** 交给解压接口的条目编号：全部选中时返回 null（解压整个压缩包，包括空文件夹），否则只给选中的文件。 */
export function selectionIndices(entries: ArchiveEntry[], selected: Set<string>): number[] | null {
  const files = archiveFiles(entries);
  if (files.every(entry => selected.has(entry.name))) return null;
  return files.filter(entry => selected.has(entry.name)).map(entry => entry.index);
}
