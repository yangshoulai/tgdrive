/** 文件助手输入框：加载 CodeMirror 输入引擎（composer-engine.ts）后即时渲染 Markdown、@ 引用胶囊、链接与列表；
 * 引擎加载完成前（或加载失败时）退回普通文本框，内容与发送行为一致。 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FileGlyph, getFileKind, type FileKind } from "../files";
import { loadComposerEngine } from "../preview-runtime";
import { Icon } from "../ui";
import type { ComposerToken, Composer } from "../composer-engine";

export type ComposerHandle = { focus: () => void; insertMention: (from: number, path: string) => void };

const KINDS: FileKind[] = ["folder", "image", "video", "audio", "pdf", "document", "spreadsheet", "presentation", "text", "code", "archive", "other"];

export const AssistantComposer = forwardRef<ComposerHandle, {
  value: string; onChange: (value: string) => void; onSubmit: () => void; disabled: boolean; placeholder: string; maxLength: number;
  /** 已选中的引用（"/电影/" 形式），这些 @路径 显示为胶囊。 */
  mentions: string[];
  onToken: (token: ComposerToken | null) => void; onKey: (event: KeyboardEvent) => boolean;
  /** 粘贴文件（截图等）：返回 true 表示已作为附件接管。 */
  onPasteFiles?: (files: File[]) => boolean;
}>(function AssistantComposer({ value, onChange, onSubmit, disabled, placeholder, maxLength, mentions, onToken, onKey, onPasteFiles }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const templates = useRef<HTMLDivElement>(null);
  const fallback = useRef<HTMLTextAreaElement>(null);
  const editor = useRef<Composer | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  // 引擎回调读取最新的 props，不必随渲染重建编辑器。
  const latest = useRef({ value, onChange, onSubmit, onToken, onKey, mentions, onPasteFiles });
  latest.current = { value, onChange, onSubmit, onToken, onKey, mentions, onPasteFiles };

  useImperativeHandle(ref, () => ({
    focus: () => { if (editor.current) editor.current.focus(); else fallback.current?.focus(); },
    insertMention: (from, path) => {
      if (editor.current) { editor.current.insertMention(from, path); return; }
      const node = fallback.current, current = latest.current.value;
      const end = node?.selectionStart ?? current.length;
      const insert = `@${path} `;
      latest.current.onChange(current.slice(0, from) + insert + current.slice(end));
      window.setTimeout(() => { node?.focus(); node?.setSelectionRange(from + insert.length, from + insert.length); }, 0);
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    void loadComposerEngine().then(engine => {
      if (cancelled || !host.current) return;
      const icon = (name: string) => {
        const kind = name === "globe" ? "globe" : name.startsWith("file:") ? getFileKind(null, name.slice(5)) : name;
        return templates.current?.querySelector(`[data-icon="${kind}"] > svg`)?.cloneNode(true) as Element | null ?? null;
      };
      const typingInFallback = document.activeElement === fallback.current;
      editor.current = engine.createComposer(host.current, {
        value: latest.current.value, placeholder, label: "给文件助手的消息", maxLength, disabled,
        onChange: next => latest.current.onChange(next), onSubmit: () => latest.current.onSubmit(),
        onToken: token => latest.current.onToken(token), onKey: event => latest.current.onKey(event),
        onPasteFiles: files => latest.current.onPasteFiles?.(files) ?? false,
        mentions: () => latest.current.mentions, icon,
      });
      setState("ready");
      if (typingInFallback) editor.current.focus();
    }).catch(() => { if (!cancelled) setState("failed"); });
    return () => { cancelled = true; editor.current?.destroy(); editor.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { editor.current?.setText(value); }, [value, state]);
  useEffect(() => { editor.current?.configure({ disabled, placeholder }); }, [disabled, placeholder, state]);
  const mentionKey = mentions.join("\n");
  useEffect(() => { editor.current?.refresh(); }, [mentionKey, state]);

  return <div className={`assistant-editor${state === "ready" ? " is-ready" : ""}`}>
    <div ref={host} className="assistant-editor-host" />
    {state !== "ready" && <textarea ref={fallback} className="assistant-input" rows={2} value={value} maxLength={maxLength} placeholder={placeholder} disabled={disabled} aria-label="给文件助手的消息"
      onChange={event => onChange(event.target.value)}
      onPaste={event => { const files = [...event.clipboardData.files]; if (files.length && onPasteFiles?.(files)) event.preventDefault(); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.repeat && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); return; }
        if (onKey(event.nativeEvent)) { event.preventDefault(); return; }
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit(); }
      }} />}
    {/* 胶囊与链接图标从这里克隆，和文件列表使用同一套类型图标。 */}
    <div ref={templates} hidden>
      {KINDS.map(kind => <span key={kind} data-icon={kind}><FileGlyph kind={kind} size={14} /></span>)}
      <span data-icon="globe"><Icon name="globe" size={14} /></span>
    </div>
  </div>;
});
