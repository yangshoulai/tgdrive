/** EPUB 电子书引擎：在浏览器里按需解压 ZIP（fflate），读出书名、目录与章节；章节 HTML 经 DOMPurify 清洗，
 * 去掉脚本、表单、内嵌框架与书里的样式（统一用阅读器的排版），图片换成本地 Blob 地址，书内链接改为章节跳转。 */
import { unzipSync, strFromU8 } from "fflate";
import DOMPurify from "dompurify";

export type TocItem = { title: string; href: string; depth: number };
export type Chapter = { html: string; path: string };
export type Book = {
  title: string; creator: string; language: string; toc: TocItem[]; spine: string[]; cover: string | null;
  chapter: (index: number) => Chapter;
  /** 书内链接（相对 from 章节的地址）对应的章节序号与锚点；不在书里时为 null。 */
  resolve: (href: string, from: string) => { index: number; anchor: string } | null;
  dispose: () => void;
};

const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp" };

/** 按 from 所在目录解析相对地址，去掉 . 与 ..；结果是 ZIP 里的完整路径（不含锚点）。 */
function join(from: string, href: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const part of decodeURIComponent(href.split("#")[0]).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return parts.join("/");
}
const anchorOf = (href: string) => href.includes("#") ? decodeURIComponent(href.slice(href.indexOf("#") + 1)) : "";
const parseXml = (text: string, type: DOMParserSupportedType = "application/xml") => {
  const document = new DOMParser().parseFromString(text, type);
  return document.getElementsByTagName("parsererror").length && type !== "text/html" ? new DOMParser().parseFromString(text, "text/html") : document;
};
const byLocal = (root: ParentNode, name: string) => [...(root as Element | Document).getElementsByTagName("*")].filter(node => node.localName === name);

export function openBook(buffer: ArrayBuffer): Book {
  const bytes = new Uint8Array(buffer);
  // 只解出需要的那个文件：每次按名称过滤，不把整本书一次解压进内存。
  const names = new Set<string>();
  unzipSync(bytes, { filter: file => { names.add(file.name); return false; } });
  const read = (path: string): Uint8Array | null => {
    if (!names.has(path)) return null;
    return unzipSync(bytes, { filter: file => file.name === path })[path] ?? null;
  };
  const text = (path: string) => { const data = read(path); return data ? strFromU8(data) : null; };
  const container = text("META-INF/container.xml");
  if (!container) throw new Error("不是有效的 EPUB 电子书（缺少 META-INF/container.xml）");
  const opfPath = byLocal(parseXml(container), "rootfile")[0]?.getAttribute("full-path");
  const opfText = opfPath && text(opfPath);
  if (!opfPath || !opfText) throw new Error("电子书缺少内容清单（OPF）");
  const opf = parseXml(opfText);
  const meta = (name: string) => byLocal(opf, name)[0]?.textContent?.trim() ?? "";
  const manifest = new Map<string, { href: string; type: string; properties: string }>();
  for (const item of byLocal(opf, "item")) {
    const id = item.getAttribute("id"), href = item.getAttribute("href");
    if (id && href) manifest.set(id, { href: join(opfPath, href), type: item.getAttribute("media-type") ?? "", properties: item.getAttribute("properties") ?? "" });
  }
  const spine = byLocal(opf, "itemref").map(item => manifest.get(item.getAttribute("idref") ?? "")?.href).filter((href): href is string => Boolean(href && names.has(href)));
  if (!spine.length) throw new Error("电子书里没有可阅读的章节");

  const urls = new Map<string, string>();
  const blobUrl = (path: string): string | null => {
    const existing = urls.get(path);
    if (existing) return existing;
    const data = read(path);
    if (!data) return null;
    const type = IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];
    if (!type) return null;
    const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type }));
    urls.set(path, url);
    return url;
  };

  // 目录：EPUB 3 的 nav 文档优先，其次 EPUB 2 的 NCX。
  const toc: TocItem[] = [];
  const nav = [...manifest.values()].find(item => item.properties.split(/\s+/).includes("nav"));
  const navText = nav && text(nav.href);
  if (nav && navText) {
    const document = parseXml(navText, "application/xhtml+xml");
    const list = byLocal(document, "nav").find(node => (node.getAttribute("epub:type") ?? node.getAttributeNS("http://www.idpf.org/2007/ops", "type") ?? "").includes("toc")) ?? byLocal(document, "nav")[0];
    const walk = (node: Element, depth: number) => {
      for (const item of [...node.children].filter(child => child.localName === "li")) {
        const link = [...item.children].find(child => child.localName === "a" || child.localName === "span");
        const href = link?.getAttribute("href");
        if (link && href) toc.push({ title: link.textContent?.trim() || "（无标题）", href: join(nav.href, href) + (href.includes("#") ? `#${anchorOf(href)}` : ""), depth });
        const nested = [...item.children].find(child => child.localName === "ol");
        if (nested) walk(nested, depth + 1);
      }
    };
    const ol = list && [...list.children].find(child => child.localName === "ol");
    if (ol) walk(ol, 0);
  }
  if (!toc.length) {
    const ncxId = byLocal(opf, "spine")[0]?.getAttribute("toc");
    const ncx = ncxId ? manifest.get(ncxId) : [...manifest.values()].find(item => item.type === "application/x-dtbncx+xml");
    const ncxText = ncx && text(ncx.href);
    if (ncx && ncxText) {
      const walk = (node: Element, depth: number) => {
        for (const point of [...node.children].filter(child => child.localName === "navPoint")) {
          const label = byLocal(point, "text")[0]?.textContent?.trim() || "（无标题）";
          const src = byLocal(point, "content")[0]?.getAttribute("src");
          if (src) toc.push({ title: label, href: join(ncx.href, src) + (src.includes("#") ? `#${anchorOf(src)}` : ""), depth });
          walk(point, depth + 1);
        }
      };
      const map = byLocal(parseXml(ncxText), "navMap")[0];
      if (map) walk(map, 0);
    }
  }

  const coverId = byLocal(opf, "meta").find(node => node.getAttribute("name") === "cover")?.getAttribute("content");
  const coverItem = [...manifest.values()].find(item => item.properties.split(/\s+/).includes("cover-image")) ?? (coverId ? manifest.get(coverId) : undefined);

  const resolve = (href: string, from: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
    const path = href.startsWith("#") ? from : join(from, href);
    const index = spine.indexOf(path);
    return index < 0 ? null : { index, anchor: anchorOf(href) };
  };

  const chapter = (index: number): Chapter => {
    const path = spine[index];
    const source = text(path) ?? "";
    const document = parseXml(source, path.endsWith(".html") || path.endsWith(".htm") ? "text/html" : "application/xhtml+xml");
    const body = byLocal(document, "body")[0] ?? document.documentElement;
    const purify = DOMPurify;
    purify.addHook("afterSanitizeAttributes", node => {
      const element = node as Element;
      if (element.hasAttribute("id")) element.setAttribute("id", `book-${element.getAttribute("id")}`);
      if (element.localName === "img" || element.localName === "image") {
        const raw = element.getAttribute("data-book-src");
        element.removeAttribute("data-book-src");
        const url = raw ? blobUrl(join(path, raw)) : null;
        if (url) element.setAttribute(element.localName === "image" ? "href" : "src", url);
        else element.remove();
        element.setAttribute("loading", "lazy");
      } else if (element.localName === "a") {
        const raw = element.getAttribute("data-book-href");
        element.removeAttribute("data-book-href");
        if (raw && /^(?:https?:|mailto:)/i.test(raw)) { element.setAttribute("href", raw); element.setAttribute("data-external", ""); }
        else if (raw) { element.removeAttribute("href"); element.setAttribute("data-book-link", raw); element.setAttribute("role", "link"); element.setAttribute("tabindex", "0"); }
        element.setAttribute("rel", "noreferrer noopener");
      }
    });
    // 地址先挪到 data-* 属性里，清洗后由钩子换成 Blob 地址或章节跳转（DOMPurify 不放行 blob: 地址）。
    for (const image of [...body.getElementsByTagName("*")].filter(node => node.localName === "img" || node.localName === "image")) {
      const src = image.getAttribute("src") ?? image.getAttribute("href") ?? image.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "";
      image.removeAttribute("src"); image.removeAttribute("href"); image.removeAttributeNS("http://www.w3.org/1999/xlink", "href"); image.removeAttribute("srcset");
      image.setAttribute("data-book-src", src);
    }
    for (const link of [...body.getElementsByTagName("*")].filter(node => node.localName === "a")) {
      const href = link.getAttribute("href");
      if (href) { link.setAttribute("data-book-href", href); link.removeAttribute("href"); }
    }
    try {
      const html = purify.sanitize(body.innerHTML, { ADD_ATTR: ["loading", "data-book-src", "data-book-href"],
        FORBID_TAGS: ["style", "link", "script", "form", "iframe", "object", "embed", "input", "button", "select", "textarea", "video", "audio", "source"],
        FORBID_ATTR: ["style", "srcset"] });
      return { html, path };
    } finally { purify.removeHook("afterSanitizeAttributes"); }
  };

  return {
    title: meta("title"), creator: meta("creator"), language: meta("language"), toc, spine,
    cover: coverItem ? blobUrl(coverItem.href) : null, chapter, resolve,
    dispose: () => { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); },
  };
}
