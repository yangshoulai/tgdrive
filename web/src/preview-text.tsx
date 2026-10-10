/** 文本预览界面：只读编辑器、Markdown 和统一工具栏。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { loadTextEngine } from "./preview-runtime";
import { Button, Icon, Segmented, Switch, copyText, formatBytes } from "./ui";
import type { PreviewText } from "./preview-data";

export function TextPreview({ content, name, downloadUrl, resolveImage, onError }: {
  content: PreviewText; name: string; downloadUrl: string; resolveImage?: (src: string) => string | null; onError: (reason: unknown) => void;
}) {
  const [mode, setMode] = useState<"render" | "source">(/\.(md|markdown|mdx)$/i.test(name) ? "render" : "source");
  const [wrapping, setWrapping] = useState(true);
  const [ready, setReady] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<ReturnType<Awaited<ReturnType<typeof loadTextEngine>>["createTextView"]> | null>(null);
  const resolver = useRef(resolveImage); resolver.current = resolveImage;
  const errorHandler = useRef(onError); errorHandler.current = onError;
  const markdown = /\.(md|markdown|mdx)$/i.test(name);
  const lineCount = useMemo(() => content.text.split(/\r\n?|\n/).length, [content.text]);
  const compact = content.text.length <= 1200 && lineCount <= 8;
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void loadTextEngine().then(engine => {
      if (cancelled || !host.current) return;
      if (mode === "render") {
        host.current.innerHTML = engine.renderMarkdown(content.text, resolver.current);
      } else editor.current = engine.createTextView(host.current, content.text, name);
      setReady(true);
    }).catch(reason => { if (!cancelled) errorHandler.current(reason); });
    return () => { cancelled = true; editor.current?.destroy(); editor.current = null; if (host.current) host.current.replaceChildren(); };
  }, [content.text, name, mode]);
  useEffect(() => { editor.current?.setWrapping(wrapping); }, [wrapping, ready]);
  return <div className={`preview-text${compact ? " is-compact" : ""}${markdown && mode === "source" ? " is-markdown-source" : ""}${content.truncated ? " is-truncated" : ""}`}>
    <div className="preview-toolbar">
      {markdown && <Segmented label="显示方式" value={mode} onChange={setMode} options={[{ value: "render", label: "预览" }, { value: "source", label: "源码" }]} />}
      {!markdown && <span className="preview-readonly"><Icon name="fileText" size={14} />只读预览</span>}
      {mode === "source" && <div className="preview-toolbar-actions">
        <Button variant="ghost" size="sm" icon="search" disabled={!ready} onClick={() => editor.current?.search()}>查找</Button>
        <Button variant="ghost" size="sm" icon="copy" disabled={!ready} title={content.truncated ? "复制已加载的预览内容" : "复制全部内容"} onClick={() => void copyText(content.text, content.truncated ? "已复制预览内容" : "内容已复制")}>复制</Button>
        <Switch checked={wrapping} onChange={setWrapping} label="自动换行" />
      </div>}
    </div>
    {!ready && <div className="preview-engine-loading" role="status"><span className="spinner" />正在加载文本组件…</div>}
    <div ref={host} className={mode === "render" ? "preview-doc md" : "preview-code-editor"} onClick={event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button[data-copy-code]");
      const code = button?.closest(".src-fence")?.querySelector("code");
      if (code) void copyText(code.textContent ?? "", "代码已复制");
    }} />
    {content.truncated && <div className="preview-notice">仅显示前 {formatBytes(512 * 1024)}{content.total ? `（共 ${formatBytes(content.total)}）` : ""}，<a href={downloadUrl}>下载完整文件</a></div>}
    {mode === "source" && ready && <div className="preview-text-status"><span>{content.text.length ? `${lineCount.toLocaleString()} 行` : "文件内容为空"}</span><span>{markdown ? "Markdown 源码" : "可选择并复制内容"}</span></div>}
  </div>;
}
