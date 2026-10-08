/** 带语法高亮和行号的代码块，预览和 Markdown 围栏代码共用。 */
import { useMemo } from "react";
import { highlight, splitLines } from "./highlight";
import { copyText, Icon } from "./ui";

export function HighlightedCode({ code, lang, lineNumbers = true, className = "" }: { code: string; lang: string | null; lineNumbers?: boolean; className?: string }) {
  const lines = useMemo(() => {
    const result = splitLines(highlight(code, lang));
    if (result.length > 1 && result[result.length - 1].length === 0) result.pop();  // 文件末尾的换行不算新的一行
    return result;
  }, [code, lang]);
  return (
    <pre className={`src-view${lineNumbers ? " has-lines" : ""} ${className}`} tabIndex={0}>
      <code>
        {lines.map((line, index) => (
          <span className="src-line" key={index}>
            {line.map((token, position) => token.type ? <span key={position} className={`hl-${token.type}`}>{token.text}</span> : token.text)}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

/** Markdown 围栏代码：右上角带语言标签与复制按钮，较短的代码不显示行号。 */
export function CodeFence({ code, lang, label }: { code: string; lang: string | null; label?: string }) {
  return (
    <div className="src-fence">
      <div className="src-fence-bar">
        <span>{label || lang || "text"}</span>
        <button type="button" onClick={() => void copyText(code, "代码已复制")} aria-label="复制代码"><Icon name="copy" size={14} /><span>复制</span></button>
      </div>
      <HighlightedCode code={code.replace(/\n$/, "")} lang={lang} lineNumbers={code.split("\n").length > 8} />
    </div>
  );
}
