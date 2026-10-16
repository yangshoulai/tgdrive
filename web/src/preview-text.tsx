/** 文本预览界面：只读编辑器、Markdown 和统一工具栏。
 * 在沉浸式预览窗口里（PreviewToolsContext 提供头部插槽）：工具移到浮动头部，Markdown／纯文本放在居中的纸张上，
 * 代码与 Markdown 源码用通栏深色编辑器，行数与截断提示浮在底部；Markdown 预览提供标题目录抽屉。
 * 没有插槽时（分享页等内嵌场景）保持原来的工具栏布局。 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadTextEngine } from "./preview-runtime";
import { Button, Icon, IconButton, Segmented, Switch, copyText, formatBytes } from "./ui";
import type { PreviewText } from "./preview-data";

/** 沉浸式预览头部里放文本工具的元素；为 null 时文本预览使用内嵌工具栏。 */
export const PreviewToolsContext = createContext<HTMLElement | null>(null);

type Heading = { index: number; level: number; text: string };

export function TextPreview({ content, name, code = false, downloadUrl, resolveImage, onError }: {
  content: PreviewText; name: string; code?: boolean; downloadUrl: string; resolveImage?: (src: string) => string | null; onError: (reason: unknown) => void;
}) {
  const [mode, setMode] = useState<"render" | "source">(/\.(md|markdown|mdx)$/i.test(name) ? "render" : "source");
  const [wrapping, setWrapping] = useState(true);
  const [ready, setReady] = useState(false);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [outline, setOutline] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<ReturnType<Awaited<ReturnType<typeof loadTextEngine>>["createTextView"]> | null>(null);
  const resolver = useRef(resolveImage); resolver.current = resolveImage;
  const errorHandler = useRef(onError); errorHandler.current = onError;
  const tools = useContext(PreviewToolsContext);
  const immersive = tools !== null;
  const markdown = /\.(md|markdown|mdx)$/i.test(name);
  // 纸张：Markdown 预览与纯文本；深色通栏：代码文件与 Markdown 源码。
  const paper = immersive && (mode === "render" || !code && !markdown);
  const lineCount = useMemo(() => content.text.split(/\r\n?|\n/).length, [content.text]);
  const compact = content.text.length <= 1200 && lineCount <= 8;
  useEffect(() => {
    let cancelled = false;
    setReady(false); setHeadings([]);
    void loadTextEngine().then(engine => {
      if (cancelled || !host.current) return;
      if (mode === "render") {
        host.current.innerHTML = engine.renderMarkdown(content.text, resolver.current);
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

  const copy = () => void copyText(content.text, content.truncated ? "已复制预览内容" : "内容已复制");
  const jump = (heading: Heading) => {
    host.current?.querySelectorAll("h1, h2, h3")[heading.index]?.scrollIntoView({ block: "start", behavior: "smooth" });
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
  const truncated = content.truncated && <span>仅显示前 {formatBytes(512 * 1024)}{content.total ? `（共 ${formatBytes(content.total)}）` : ""}，<a href={downloadUrl}>下载完整文件</a></span>;

  return <div className={`preview-text${compact ? " is-compact" : ""}${markdown && mode === "source" ? " is-markdown-source" : ""}${content.truncated ? " is-truncated" : ""}${immersive ? paper ? " is-paper" : " is-code" : ""}`}>
    {immersive ? createPortal(toolbar, tools) : toolbar}
    {!ready && <div className="preview-engine-loading" role="status"><span className="spinner" />正在加载文本组件…</div>}
    <div className={immersive ? "preview-sheet" : undefined}>
      <div ref={host} className={mode === "render" ? "preview-doc md" : "preview-code-editor"} onClick={event => {
        const button = (event.target as Element).closest<HTMLButtonElement>("button[data-copy-code]");
        const code = button?.closest(".src-fence")?.querySelector("code");
        if (code) void copyText(code.textContent ?? "", "代码已复制");
      }} />
    </div>
    {immersive ? (status || truncated) && <div className="preview-text-capsule" role="status">{status && <span>{status}</span>}{truncated}</div> : <>
      {truncated && <div className="preview-notice">{truncated}</div>}
      {status && <div className="preview-text-status"><span>{status}</span><span>{markdown ? "Markdown 源码" : "可选择并复制内容"}</span></div>}
    </>}
    {outline && <aside className="preview-playlist-panel preview-outline-panel" aria-label="目录"
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOutline(false); } }}>
      <OutlineList headings={headings} onJump={jump} onClose={() => setOutline(false)} />
    </aside>}
  </div>;
}

function OutlineList({ headings, onJump, onClose }: { headings: Heading[]; onJump: (heading: Heading) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
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
    <ol className="preview-playlist-items preview-outline-items">
      {shown.map(heading => <li key={heading.index}>
        <button type="button" className="preview-outline-item" data-level={heading.level - top} onClick={() => onJump(heading)}>{heading.text}</button>
      </li>)}
      {!shown.length && <li className="preview-playlist-empty">没有匹配“{query.trim()}”的标题</li>}
    </ol>
  </>;
}
