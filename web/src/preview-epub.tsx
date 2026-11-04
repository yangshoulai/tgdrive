/** EPUB 阅读器：一次显示一章，纸张排版与 Markdown 预览一致；目录抽屉、上一章／下一章、字号调节，记住读到的位置。
 * 书里的脚本、表单与样式都不加载（见 preview-book-engine.ts），外部链接在新标签页打开。 */
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadBookEngine } from "./preview-runtime";
import { PreviewToolsContext } from "./preview-text";
import { IconButton, formatBytes, isShortcutControl, type MenuItem } from "./ui";

type Book = ReturnType<Awaited<ReturnType<typeof loadBookEngine>>["openBook"]>;
const BOOK_LIMIT = 160 * 1024 * 1024;
const FONT_KEY = "tessera:epub-font", POSITION_KEY = "tessera:epub-position", POSITION_LIMIT = 200;
const FONT_SIZES = [14, 15, 16, 17, 18, 20, 22, 24];
/** 私密文件只在本页内存里记阅读位置，不写入浏览器存储。 */
const sessionPositions = new Map<string, { chapter: number; ratio: number }>();

function savedPositions(): Record<string, { chapter: number; ratio: number }> {
  try { const value = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "{}"); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}
function readPosition(key: string | null, remember: boolean) {
  if (!key) return null;
  return remember ? savedPositions()[key] ?? null : sessionPositions.get(key) ?? null;
}
function writePosition(key: string | null, remember: boolean, value: { chapter: number; ratio: number }) {
  if (!key) return;
  if (!remember) { sessionPositions.set(key, value); return; }
  const entries = Object.entries(savedPositions()).filter(([item]) => item !== key);
  entries.push([key, value]);
  try { localStorage.setItem(POSITION_KEY, JSON.stringify(Object.fromEntries(entries.slice(-POSITION_LIMIT)))); } catch { /* 存储不可用时不记位置 */ }
}

export function EpubPreview({ url, positionKey, remember, onError }: { url: string; /** 按内容版本记住读到的位置；为 null 时不记。 */ positionKey: string | null; remember: boolean; onError: (message: string) => void }) {
  const [book, setBook] = useState<Book | null>(null);
  const [index, setIndex] = useState(0);
  const [html, setHtml] = useState<string | null>(null);
  const [outline, setOutline] = useState(false);
  const [fontSize, setFontSize] = useState(() => { const value = Number(localStorage.getItem(FONT_KEY)); return FONT_SIZES.includes(value) ? value : 17; });
  const host = useRef<HTMLDivElement>(null), sheet = useRef<HTMLDivElement>(null);
  const pendingAnchor = useRef<string | null>(null), pendingRatio = useRef<number | null>(null);
  const tools = useContext(PreviewToolsContext);
  useEffect(() => {
    const controller = new AbortController();
    let opened: Book | null = null;
    setBook(null);
    void (async () => {
      try {
        const response = await fetch(url, { credentials: "include", signal: controller.signal });
        if (!response.ok) throw new Error(`无法读取电子书（${response.status}）`);
        if (Number(response.headers.get("content-length") || 0) > BOOK_LIMIT) { await response.body?.cancel(); throw new Error(`电子书超过 ${formatBytes(BOOK_LIMIT)}，请下载后阅读`); }
        const [engine, buffer] = await Promise.all([loadBookEngine(), response.arrayBuffer()]);
        opened = engine.openBook(buffer);
        if (controller.signal.aborted) { opened.dispose(); return; }
        const saved = readPosition(positionKey, remember);
        const start = saved && saved.chapter < opened.spine.length ? saved.chapter : 0;
        pendingRatio.current = saved && saved.chapter === start ? saved.ratio : null;
        setIndex(start); setBook(opened);
      } catch (reason) {
        if (!controller.signal.aborted) onError(reason instanceof Error ? reason.message : "电子书没有打开");
      }
    })();
    return () => { controller.abort(); opened?.dispose(); };
  }, [url]);
  useEffect(() => {
    if (!book) return;
    try { setHtml(book.chapter(index).html); } catch { setHtml("<p>这一章没有读出来。</p>"); }
  }, [book, index]);
  // 换章后回到顶部，或跳到链接指向的位置、上次读到的位置。
  useEffect(() => {
    const node = host.current, scroller = sheet.current?.closest<HTMLElement>(".preview-text") ?? sheet.current;
    if (!node || html === null) return;
    node.innerHTML = html;
    const anchor = pendingAnchor.current, ratio = pendingRatio.current;
    pendingAnchor.current = pendingRatio.current = null;
    requestAnimationFrame(() => {
      if (!scroller) return;
      const target = anchor ? node.querySelector(`[id="book-${CSS.escape(anchor)}"]`) : null;
      if (target) target.scrollIntoView({ block: "start" });
      else scroller.scrollTop = ratio !== null ? ratio * (scroller.scrollHeight - scroller.clientHeight) : 0;
    });
  }, [html]);
  // 记住阅读位置（章节与章内滚动比例）。
  useEffect(() => {
    const scroller = sheet.current?.closest<HTMLElement>(".preview-text") ?? sheet.current;
    if (!book || !scroller) return;
    let timer = 0;
    const save = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const range = scroller.scrollHeight - scroller.clientHeight;
        writePosition(positionKey, remember, { chapter: index, ratio: range > 0 ? Math.min(1, scroller.scrollTop / range) : 0 });
      }, 400);
    };
    save();
    scroller.addEventListener("scroll", save, { passive: true });
    return () => { window.clearTimeout(timer); scroller.removeEventListener("scroll", save); };
  }, [book, index, positionKey]);
  useEffect(() => { try { localStorage.setItem(FONT_KEY, String(fontSize)); } catch { /* 忽略 */ } }, [fontSize]);
  const go = (next: number, anchor = "") => {
    if (!book || next < 0 || next >= book.spine.length) return;
    pendingAnchor.current = anchor || null;
    if (next === index && anchor) {
      host.current?.querySelector(`[id="book-${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    setIndex(next);
  };
  const follow = (href: string) => {
    const target = book?.resolve(href, book.spine[index]);
    if (target) go(target.index, target.anchor);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const node = host.current, target = event.target as Element | null, dialog = node?.closest(".modal");
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || !dialog || dialog.closest("[inert]") || (target && (!dialog.contains(target) && target !== document.body || isShortcutControl(target)))) return;
      if (event.key === "ArrowLeft" || event.key === "[") { event.preventDefault(); go(index - 1); }
      else if (event.key === "ArrowRight" || event.key === "]") { event.preventDefault(); go(index + 1); }
      else if (event.key.toLowerCase() === "o") { event.preventDefault(); setOutline(value => !value); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });
  useEffect(() => {
    if (!tools?.compact || !book) return;
    const items: MenuItem[] = [
      { label: "放大文字", icon: "zoomIn", disabled: fontSize >= FONT_SIZES.at(-1)!, onSelect: () => setFontSize(value => FONT_SIZES[Math.min(FONT_SIZES.length - 1, FONT_SIZES.indexOf(value) + 1)]) },
      { label: "缩小文字", icon: "zoomOut", disabled: fontSize <= FONT_SIZES[0], onSelect: () => setFontSize(value => FONT_SIZES[Math.max(0, FONT_SIZES.indexOf(value) - 1)]) },
    ];
    tools.setMenuItems(items);
    return () => tools.setMenuItems([]);
  }, [tools, book, fontSize]);

  // 外层舞台（不滚动）：章节提示与目录挂在这里。书打开后纸张才渲染，所以在这之后读取。
  const [stage, setStage] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setStage(sheet.current?.closest<HTMLElement>(".preview-stage") ?? null); }, [book]);
  if (!book) return <div className="preview-engine-loading" role="status"><span className="spinner" />正在打开电子书…</div>;
  const chapterPath = book.spine[index];
  const current = [...book.toc].reverse().find(item => item.href.split("#")[0] === chapterPath)?.title;
  const toolbar = <div className="preview-text-tools">
    {book.toc.length > 0 && <IconButton icon="list" label="目录" shortcut="O" size="sm" className="playlist-toggle" active={outline} onClick={() => setOutline(value => !value)} />}
    <IconButton icon="chevronLeft" label="上一章（←）" size="sm" disabled={index === 0} onClick={() => go(index - 1)} />
    <IconButton icon="chevronRight" label="下一章（→）" size="sm" disabled={index >= book.spine.length - 1} onClick={() => go(index + 1)} />
    {!tools?.compact && <>
      <IconButton icon="zoomOut" label="缩小文字" size="sm" disabled={fontSize <= FONT_SIZES[0]} onClick={() => setFontSize(value => FONT_SIZES[Math.max(0, FONT_SIZES.indexOf(value) - 1)])} />
      <IconButton icon="zoomIn" label="放大文字" size="sm" disabled={fontSize >= FONT_SIZES.at(-1)!} onClick={() => setFontSize(value => FONT_SIZES[Math.min(FONT_SIZES.length - 1, FONT_SIZES.indexOf(value) + 1)])} />
    </>}
  </div>;
  const panel = outline && <aside className="preview-playlist-panel preview-outline-panel" aria-label="目录"
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOutline(false); } }}>
    <header>
      <div className="preview-playlist-title"><strong>目录</strong><span className="preview-playlist-count">{book.toc.length} 项</span></div>
      <IconButton icon="x" label="收起目录" size="sm" onClick={() => setOutline(false)} />
    </header>
    <ol className="preview-playlist-items preview-outline-items">
      {book.toc.map((item, position) => {
        const active = item.href.split("#")[0] === chapterPath && item.title === current;
        return <li key={position}><button type="button" className={`preview-outline-item${active ? " is-active" : ""}`} data-level={Math.min(item.depth, 3)} aria-current={active ? "location" : undefined}
          onClick={() => { const target = book.resolve(item.href, ""); if (target) go(target.index, target.anchor); if (window.matchMedia("(max-width: 640px)").matches) setOutline(false); }}>{item.title}</button></li>;
      })}
    </ol>
  </aside>;
  return <div className="preview-text is-paper is-epub">
    {tools ? createPortal(toolbar, tools.target) : toolbar}
    <div ref={sheet} className="preview-sheet">
      <article className="preview-doc md preview-epub" style={{ fontSize }} lang={book.language || undefined}>
        {index === 0 && (book.title || book.creator) && <header className="preview-epub-title">{book.title && <h1>{book.title}</h1>}{book.creator && <p>{book.creator}</p>}</header>}
        <div ref={host} onClick={event => {
          const link = (event.target as Element).closest<HTMLElement>("[data-book-link], a[data-external]");
          if (!link) return;
          event.preventDefault();
          if (link.hasAttribute("data-external")) window.open(link.getAttribute("href") ?? "", "_blank", "noopener,noreferrer");
          else follow(link.getAttribute("data-book-link") ?? "");
        }} onKeyDown={event => {
          const link = (event.target as Element).closest<HTMLElement>("[data-book-link]");
          if (link && event.key === "Enter") { event.preventDefault(); follow(link.getAttribute("data-book-link") ?? ""); }
        }} />
        <nav className="preview-epub-pager" aria-label="翻章">
          <button type="button" disabled={index === 0} onClick={() => go(index - 1)}>上一章</button>
          <span>{index + 1} / {book.spine.length}</span>
          <button type="button" disabled={index >= book.spine.length - 1} onClick={() => go(index + 1)}>下一章</button>
        </nav>
      </article>
    </div>
    {/* 纸张在 .preview-text 里滚动：章节提示与目录都挂到外层舞台上，固定在窗口里，不随正文滚走。 */}
    {(() => { const capsule = <div className="preview-text-capsule" role="status"><span>第 {index + 1} / {book.spine.length} 章{current ? ` · ${current}` : ""}</span></div>;
      return stage ? createPortal(capsule, stage) : capsule; })()}
    {panel && (stage ? createPortal(panel, stage) : panel)}
  </div>;
}

