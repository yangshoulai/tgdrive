/** 文本预览界面：只读编辑器、Markdown 和统一工具栏。
 * 在沉浸式预览窗口里（PreviewToolsContext 提供头部插槽）：工具移到浮动头部，Markdown／纯文本放在居中的纸张上，
 * 代码与 Markdown 源码用通栏深色编辑器，行数与截断提示浮在底部；Markdown 预览提供标题目录抽屉。
 * 没有插槽时（分享页等内嵌场景）保持原来的工具栏布局。 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadTextEngine } from "./preview-runtime";
import { Button, Icon, IconButton, Segmented, Switch, copyText, formatBytes } from "./ui";
import { TEXT_PREVIEW_LIMIT, type PreviewText } from "./preview-data";

/** 沉浸式预览头部里放文本工具的元素；为 null 时文本预览使用内嵌工具栏。 */
export const PreviewToolsContext = createContext<HTMLElement | null>(null);

type Heading = { index: number; level: number; text: string };

/**
 * Markdown 里的外部图片默认不加载（打开文档不应向第三方暴露访问记录），先换成占位按钮；点任意一个后加载本文档的全部外部图片。
 * 找不到的本地图片显示替代文字。只用 DOM API 创建节点。
 */
function holdRemoteImages(root: HTMLElement) {
  for (const image of root.querySelectorAll<HTMLImageElement>("img[data-remote-src]")) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "md-remote-image"; button.dataset.remoteSrc = image.dataset.remoteSrc ?? ""; button.title = `外部图片：${image.dataset.remoteSrc}`;
    const label = document.createElement("span"); label.textContent = image.alt || "外部图片";
    const hint = document.createElement("small"); hint.textContent = "点击加载";
    button.append(label, hint);
    image.replaceWith(button);
  }
  const missing = (image: HTMLImageElement) => {
    const text = document.createElement("span"); text.className = "md-missing-image"; text.textContent = image.alt || "图片";
    text.title = "找不到这张图片，或它不是浏览器能显示的格式";
    image.replaceWith(text);
  };
  for (const image of root.querySelectorAll<HTMLImageElement>("img[data-missing]")) missing(image);
  // 相对路径的图片可能不存在：加载失败时同样换成替代文字，不留破图标。
  for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
    if (image.complete && image.naturalWidth === 0 && image.getAttribute("src")) missing(image);
    else image.addEventListener("error", () => missing(image), { once: true });
  }
}
function loadRemoteImages(root: HTMLElement) {
  for (const button of root.querySelectorAll<HTMLButtonElement>("button.md-remote-image")) {
    const image = document.createElement("img");
    image.src = button.dataset.remoteSrc ?? ""; image.alt = button.querySelector("span")?.textContent ?? ""; image.loading = "lazy"; image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
      const text = document.createElement("span"); text.className = "md-missing-image"; text.textContent = image.alt || "外部图片"; text.title = "外部图片无法加载";
      image.replaceWith(text);
    }, { once: true });
    button.replaceWith(image);
  }
}

export function TextPreview({ content, name, code = false, downloadUrl, resolveImage, onError }: {
  content: PreviewText; name: string; code?: boolean; downloadUrl: string; resolveImage?: (src: string) => string | null; onError: (reason: unknown) => void;
}) {
  const [mode, setMode] = useState<"render" | "source">(/\.(md|markdown|mdx)$/i.test(name) ? "render" : "source");
  const [wrapping, setWrapping] = useState(true);
  const [ready, setReady] = useState(false);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [outline, setOutline] = useState(false);
  const [active, setActive] = useState(-1);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<ReturnType<Awaited<ReturnType<typeof loadTextEngine>>["createTextView"]> | null>(null);
  const resolver = useRef(resolveImage); resolver.current = resolveImage;
  const errorHandler = useRef(onError); errorHandler.current = onError;
  const tools = useContext(PreviewToolsContext);
  const immersive = tools !== null;
  const markdown = /\.(md|markdown|mdx)$/i.test(name);
  // 纸张：Markdown 预览与纯文本；深色通栏：代码文件与 Markdown 源码。
  const paper = immersive && (mode === "render" || !code && !markdown);
  const lineCount = useMemo(() => {
    // 大文本只统计换行，避免 split 为每一行额外分配字符串。
    let count = 1;
    for (let index = 0; index < content.text.length; index++) {
      if (content.text[index] === "\n") count++;
      else if (content.text[index] === "\r") {
        count++;
        if (content.text[index + 1] === "\n") index++;
      }
    }
    return count;
  }, [content.text]);
  const compact = content.text.length <= 1200 && lineCount <= 8;
  useEffect(() => {
    let cancelled = false;
    setReady(false); setHeadings([]);
    void loadTextEngine().then(engine => {
      if (cancelled || !host.current) return;
      if (mode === "render") {
        host.current.innerHTML = engine.renderMarkdown(content.text, resolver.current);
        holdRemoteImages(host.current);
        setHeadings([...host.current.querySelectorAll("h1, h2, h3")].map((node, index) => ({ index, level: Number(node.tagName[1]), text: node.textContent?.trim() || "（无标题）" })));
      } else editor.current = engine.createTextView(host.current, content.text, name);
      setReady(true);
    }).catch(reason => { if (!cancelled) errorHandler.current(reason); });
    return () => { cancelled = true; editor.current?.destroy(); editor.current = null; if (host.current) host.current.replaceChildren(); };
  }, [content.text, name, mode]);
  useEffect(() => { editor.current?.setWrapping(wrapping); }, [wrapping, ready]);
  useEffect(() => { if (mode !== "render") setOutline(false); }, [mode]);
  // 预览弹窗里按 Ctrl/⌘+A 只选中文件内容，而不是整个页面；输入框（如查找框）保留原生行为。
  useEffect(() => {
    if (!ready) return;
    const handleKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return;
      const node = host.current, dialog = node?.closest(".modal"), target = event.target as HTMLElement;
      if (!node || !dialog?.contains(target) || dialog.hasAttribute("inert") || target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      if (editor.current) { editor.current.selectAll(); return; }
      const selection = window.getSelection();
      selection?.selectAllChildren(node);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [ready, mode]);
  // 目录抽屉：点击抽屉外收起（目录按钮自己负责开关）。
  useEffect(() => {
    if (!outline) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || target.closest(".preview-outline-panel, .playlist-toggle")) return;
      setOutline(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [outline]);

  // 目录跟随滚动：当前标题是最后一个越过阅读区顶部的标题；滚到底时是最后一个标题。
  useEffect(() => {
    const node = host.current;
    if (!ready || mode !== "render" || !headings.length || !node) return;
    const nodes = [...node.querySelectorAll<HTMLElement>("h1, h2, h3")];
    const scroller = scrollParent(node);
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = (scroller === document.documentElement ? 0 : scroller.getBoundingClientRect().top)
        + (parseFloat(getComputedStyle(nodes[0]).scrollMarginTop) || 0) + 8;
      let index = 0;
      nodes.forEach((heading, position) => { if (heading.getBoundingClientRect().top <= top) index = position; });
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) index = nodes.length - 1;
      setActive(index);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    return () => { scroller.removeEventListener("scroll", schedule); cancelAnimationFrame(frame); };
  }, [ready, mode, headings]);

  const copy = () => void copyText(content.text, content.truncated ? "已复制预览内容" : "内容已复制");
  const jump = (heading: Heading) => {
    host.current?.querySelectorAll("h1, h2, h3")[heading.index]?.scrollIntoView({ block: "start", behavior: "smooth" });
    setActive(heading.index);
    if (window.matchMedia("(max-width: 640px)").matches) setOutline(false);
  };
  const toolbar = immersive ? <div className="preview-text-tools">
    {markdown && <Segmented label="显示方式" value={mode} onChange={setMode} options={[{ value: "render", label: "预览" }, { value: "source", label: "源码" }]} />}
    {markdown && mode === "render" && headings.length > 0 && <IconButton icon="list" label="目录" size="sm" className="playlist-toggle" active={outline} onClick={() => setOutline(value => !value)} />}
    {mode === "source" && <>
      <IconButton icon="search" label="查找（⌘F）" size="sm" disabled={!ready} onClick={() => editor.current?.search()} />
      <IconButton icon="wrap" label={wrapping ? "关闭自动换行" : "自动换行"} size="sm" active={wrapping} onClick={() => setWrapping(value => !value)} />
    </>}
    <IconButton icon="copy" label={content.truncated ? "复制已加载的预览内容" : "复制全部内容"} size="sm" disabled={!ready && mode === "source"} onClick={copy} />
  </div> : <div className="preview-toolbar">
    {markdown && <Segmented label="显示方式" value={mode} onChange={setMode} options={[{ value: "render", label: "预览" }, { value: "source", label: "源码" }]} />}
    {!markdown && <span className="preview-readonly"><Icon name="fileText" size={14} />只读预览</span>}
    {mode === "source" && <div className="preview-toolbar-actions">
      <Button variant="ghost" size="sm" icon="search" disabled={!ready} onClick={() => editor.current?.search()}>查找</Button>
      <Button variant="ghost" size="sm" icon="copy" disabled={!ready} title={content.truncated ? "复制已加载的预览内容" : "复制全部内容"} onClick={copy}>复制</Button>
      <Switch checked={wrapping} onChange={setWrapping} label="自动换行" />
    </div>}
  </div>;
  const status = mode === "source" && ready ? (content.text.length ? `${lineCount.toLocaleString()} 行` : "文件内容为空") : null;
  const truncated = content.truncated && <span>仅显示前 {formatBytes(TEXT_PREVIEW_LIMIT)}{content.total ? `（共 ${formatBytes(content.total)}）` : ""}，<a href={downloadUrl}>下载完整文件</a></span>;

  return <div className={`preview-text${compact ? " is-compact" : ""}${markdown && mode === "source" ? " is-markdown-source" : ""}${content.truncated ? " is-truncated" : ""}${immersive ? paper ? " is-paper" : " is-code" : ""}`}>
    {immersive ? createPortal(toolbar, tools) : toolbar}
    {!ready && <div className="preview-engine-loading" role="status"><span className="spinner" />正在准备预览…</div>}
    <div className={immersive ? "preview-sheet" : undefined}>
      <div ref={host} className={mode === "render" ? "preview-doc md" : "preview-code-editor"} onClick={event => {
        const remote = (event.target as Element).closest("button.md-remote-image");
        if (remote && host.current) { event.preventDefault(); loadRemoteImages(host.current); return; }
        const button = (event.target as Element).closest<HTMLButtonElement>("button[data-copy-code]");
        const code = button?.closest(".src-fence")?.querySelector("code");
        if (code) void copyText(code.textContent ?? "", "代码已复制");
      }} />
    </div>
    {immersive ? (status || truncated) && <div className="preview-text-capsule" role="status">{status && <span>{status}</span>}{truncated}</div> : <>
      {truncated && <div className="preview-notice">{truncated}</div>}
      {status && <div className="preview-text-status"><span>{status}</span><span>{markdown ? "Markdown 源码" : "可选择并复制内容"}</span></div>}
    </>}
    {outline && (() => {
      const panel = <aside className="preview-playlist-panel preview-outline-panel" aria-label="目录"
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOutline(false); } }}>
        <OutlineList headings={headings} active={active} onJump={jump} onClose={() => setOutline(false)} />
      </aside>;
      // 纸张在 .preview-text 里滚动：目录挂到外层舞台上，才能固定在右侧而不随正文滚走。
      const stage = host.current?.closest<HTMLElement>(".preview-stage");
      return stage ? createPortal(panel, stage) : panel;
    })()}
  </div>;
}

/** 最近的可滚动祖先（沉浸式纸张是 .preview-text，内嵌预览是文档自身）。 */
function scrollParent(node: HTMLElement): HTMLElement {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    const overflow = getComputedStyle(current).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && current.scrollHeight > current.clientHeight) return current;
  }
  return document.documentElement;
}

function OutlineList({ headings, active, onJump, onClose }: { headings: Heading[]; active: number; onJump: (heading: Heading) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const list = useRef<HTMLOListElement>(null);
  // 当前标题保持在目录可见范围内（只滚动目录自身，不影响正文）。
  useEffect(() => {
    const item = list.current?.querySelector<HTMLElement>(".preview-outline-item.is-active");
    const box = list.current;
    if (!item || !box) return;
    const top = item.offsetTop - box.offsetTop, bottom = top + item.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top - 8;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 8;
  }, [active]);
  const terms = query.trim().toLowerCase();
  const shown = terms ? headings.filter(heading => heading.text.toLowerCase().includes(terms)) : headings;
  const top = Math.min(...headings.map(heading => heading.level));
  return <>
    <header>
      <div className="preview-playlist-title"><strong>目录</strong><span className="preview-playlist-count">{terms ? `${shown.length} / ${headings.length}` : `${headings.length} 个标题`}</span></div>
      <IconButton icon="x" label="收起目录" size="sm" onClick={onClose} />
    </header>
    {headings.length > 6 && <label className="preview-playlist-search">
      <Icon name="search" size={14} />
      <input type="search" placeholder="过滤标题" aria-label="过滤标题" value={query} spellCheck={false} onChange={event => setQuery(event.target.value)} />
    </label>}
    <ol ref={list} className="preview-playlist-items preview-outline-items">
      {shown.map(heading => <li key={heading.index}>
        <button type="button" className={`preview-outline-item${heading.index === active ? " is-active" : ""}`} data-level={heading.level - top}
          aria-current={heading.index === active ? "location" : undefined} onClick={() => onJump(heading)}>{heading.text}</button>
      </li>)}
      {!shown.length && <li className="preview-playlist-empty">没有匹配“{query.trim()}”的标题</li>}
    </ol>
  </>;
}
