/** Jupyter Notebook（.ipynb）只读视图：Markdown 单元格按文档渲染，代码单元格带语法高亮和执行序号，输出显示文本、图片、表格与错误。
 * HTML 输出经 DOMPurify 清洗，不执行脚本；外部图片同 Markdown 预览一样先显示占位。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HighlightedCode } from "./code";
import { languageOf } from "./highlight";
import { loadTextEngine } from "./preview-runtime";
import { Icon } from "./ui";
import { parseNotebook, type Cell, type Lines, type Output } from "./preview-parsers";

type Engine = Awaited<ReturnType<typeof loadTextEngine>>;

const join = (value: Lines | undefined) => Array.isArray(value) ? value.join("") : value ?? "";
/** 去掉终端颜色控制符（错误回溯里很常见）。 */
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

export function NotebookPreview({ text }: { text: string }) {
  const parsed = useMemo(() => {
    try { return parseNotebook(text); } catch (error) { return error instanceof Error ? error.message : "无法解析 Notebook"; }
  }, [text]);
  const [engine, setEngine] = useState<Engine | null>(null);
  useEffect(() => { let alive = true; void loadTextEngine().then(value => { if (alive) setEngine(value); }); return () => { alive = false; }; }, []);
  if (typeof parsed === "string") return <div className="preview-structured-error" role="alert"><Icon name="alert" size={18} /><div><strong>无法按 Notebook 显示</strong><p>{parsed}</p><p>可以切换到「源码」查看原文。</p></div></div>;
  const lang = languageOf(parsed.language) ?? languageOf("python");
  return <div className="preview-notebook">
    <p className="preview-notebook-meta">{parsed.kernel} · {parsed.cells.length} 个单元格</p>
    {parsed.cells.map((cell, index) => <NotebookCell key={index} cell={cell} lang={lang} engine={engine} />)}
  </div>;
}

function NotebookCell({ cell, lang, engine }: { cell: Cell; lang: string | null; engine: Engine | null }) {
  const source = join(cell.source);
  if (cell.cell_type === "markdown") {
    // 单元格附件（attachment:图片名）换成内嵌的 data 地址。
    const attachments = cell.attachments ?? {};
    const resolve = (src: string) => {
      const name = src.startsWith("attachment:") ? decodeURIComponent(src.slice(11)) : null;
      const item = name ? attachments[name] : undefined;
      const type = item && Object.keys(item).find(key => /^image\/(png|jpeg|gif|webp)$/.test(key));
      return item && type ? `data:${type};base64,${item[type].replace(/\s/g, "")}` : null;
    };
    return <section className="notebook-cell is-markdown"><Html html={engine ? engine.renderMarkdown(source, resolve) : null} fallback={source} /></section>;
  }
  if (cell.cell_type !== "code") return <section className="notebook-cell is-raw"><pre>{source}</pre></section>;
  return <section className="notebook-cell is-code">
    <div className="notebook-input">
      <span className="notebook-prompt">In [{cell.execution_count ?? " "}]:</span>
      <HighlightedCode code={source.replace(/\n$/, "")} lang={lang} lineNumbers={false} className="notebook-source" />
    </div>
    {(cell.outputs ?? []).map((output, index) => <NotebookOutput key={index} output={output} engine={engine} />)}
  </section>;
}

function NotebookOutput({ output, engine }: { output: Output; engine: Engine | null }) {
  const prompt = output.output_type === "execute_result" ? `Out[${output.execution_count ?? " "}]:` : "";
  let body: ReactNode;
  if (output.output_type === "stream") body = <pre className={`notebook-stream${output.name === "stderr" ? " is-stderr" : ""}`}>{plain(join(output.text))}</pre>;
  // 回溯的最后一行已经包含错误名称与说明；没有回溯时才单独显示。
  else if (output.output_type === "error") body = <pre className="notebook-stream is-error">{plain(output.traceback?.length ? output.traceback.join("\n") : `${output.ename ?? "Error"}: ${output.evalue ?? ""}`)}</pre>;
  else {
    const data = output.data ?? {};
    const image = ["image/png", "image/jpeg", "image/gif", "image/webp"].find(type => data[type]);
    if (image) body = <img className="notebook-image" alt="输出图片" src={`data:${image};base64,${join(data[image]).replace(/\s/g, "")}`} />;
    else if (data["image/svg+xml"]) body = <img className="notebook-image" alt="输出图片" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(join(data["image/svg+xml"]))}`} />;
    else if (data["text/html"]) body = <Html html={engine ? engine.sanitizeHtml(join(data["text/html"])) : null} fallback={join(data["text/plain"] ?? data["text/html"])} className="notebook-html" />;
    else if (data["text/markdown"]) body = <Html html={engine ? engine.renderMarkdown(join(data["text/markdown"])) : null} fallback={join(data["text/markdown"])} />;
    else if (data["application/json"]) body = <pre className="notebook-stream">{JSON.stringify(data["application/json"], null, 2)}</pre>;
    else body = <pre className="notebook-stream">{plain(join(data["text/plain"] ?? data["text/latex"]))}</pre>;
  }
  return <div className="notebook-output">{prompt && <span className="notebook-prompt is-out">{prompt}</span>}<div className="notebook-output-body">{body}</div></div>;
}

/** 经过清洗的 HTML；引擎还没加载时先显示原文。 */
function Html({ html, fallback, className = "" }: { html: string | null; fallback: string; className?: string }) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => { if (node.current && html !== null) node.current.innerHTML = html; }, [html]);
  if (html === null) return <pre className="notebook-stream">{fallback}</pre>;
  return <div ref={node} className={`md ${className}`} />;
}
