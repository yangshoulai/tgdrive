/** 在文件类型（FileKind）之下细分的预览格式：同是文本，CSV 用表格、JSON／YAML 用结构视图、Notebook 按单元格显示；
 * 字体、电子书与压缩包各有自己的查看器。只按扩展名与 MIME 判断，不改变文件类型（类型筛选与服务端规则不受影响）。 */
import type { FileKind } from "./files";

/** 文本类的视图：markdown 渲染、table 表格、tree 结构、notebook 单元格；null 为纯文本／代码。 */
export type TextView = "markdown" | "table" | "tree" | "notebook";
export function textViewOf(name: string, type?: string | null): TextView | null {
  const lower = name.toLowerCase(), mime = (type || "").split(";", 1)[0].trim().toLowerCase();
  if (/\.(md|markdown|mdx)$/.test(lower)) return "markdown";
  if (/\.(csv|tsv)$/.test(lower) || mime === "text/csv" || mime === "text/tab-separated-values") return "table";
  if (/\.ipynb$/.test(lower) || mime === "application/x-ipynb+json") return "notebook";
  if (/\.(json|jsonc|jsonl|ndjson|geojson|ya?ml)$/.test(lower) || mime.startsWith("application/json") || /\+json$/.test(mime)) return "tree";
  return null;
}

/** 有专门查看器的非文本格式。 */
export type FileFormat = "font" | "epub" | "archive" | "heic";
export function fileFormatOf(kind: FileKind, name: string, type?: string | null): FileFormat | null {
  const lower = name.toLowerCase(), mime = (type || "").split(";", 1)[0].trim().toLowerCase();
  if (kind === "image" && (/\.(heic|heif)$/.test(lower) || mime === "image/heic" || mime === "image/heif")) return "heic";
  if (/\.(ttf|otf|woff2?|ttc)$/.test(lower) || mime.startsWith("font/") || mime === "application/font-woff" || mime === "application/x-font-ttf") return "font";
  if (/\.epub$/.test(lower) || mime === "application/epub+zip") return "epub";
  if (kind === "archive" && (/\.(zip|tar|tgz|tbz2?|txz|gz|bz2|xz)$/.test(lower) || /zip|x-tar|gzip|bzip2|x-xz/.test(mime))) return "archive";
  return null;
}
