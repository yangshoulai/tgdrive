/** 字体预览（TTF／OTF／WOFF／WOFF2／TTC）：在页面里加载字体后显示样张、字号阶梯和全部字符。
 * 名称、版本与字符表从字体文件的 name、maxp、cmap 表读出；WOFF2 的表用 Brotli 压缩，浏览器无法解开，只显示样张。 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Button, Icon, Segmented, copyText, formatBytes } from "./ui";
import { readFontInfo, type FontInfo } from "./preview-parsers";

const FONT_LIMIT = 48 * 1024 * 1024;
const GRID_PAGE = 600;
const SAMPLES = { zh: "天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。", en: "The quick brown fox jumps over the lazy dog.", digits: "0123456789 !@#$%&*()[]{}<>?" };
const SIZES = [12, 16, 20, 24, 32, 48, 64, 96];

async function fetchFont(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) throw new Error(`无法读取字体文件（${response.status}）`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > FONT_LIMIT) { await response.body?.cancel(); throw new Error(`字体文件超过 ${formatBytes(FONT_LIMIT)}，请下载后查看`); }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > FONT_LIMIT) throw new Error(`字体文件超过 ${formatBytes(FONT_LIMIT)}，请下载后查看`);
  return buffer;
}

let fontCounter = 0;

export function FontPreview({ url, name, onError }: { url: string; name: string; onError: (message: string) => void }) {
  const [state, setState] = useState<{ family: string; info: FontInfo } | null>(null);
  const [sample, setSample] = useState("");
  const [preset, setPreset] = useState<"zh" | "en" | "digits">("zh");
  const [size, setSize] = useState(40);
  const [shownGlyphs, setShownGlyphs] = useState(GRID_PAGE);
  useEffect(() => {
    const controller = new AbortController();
    let face: FontFace | null = null;
    setState(null); setShownGlyphs(GRID_PAGE);
    void (async () => {
      try {
        const buffer = await fetchFont(url, controller.signal);
        const family = `tessera-preview-font-${++fontCounter}`;
        const [info] = await Promise.all([readFontInfo(buffer).catch((): FontInfo => ({ format: "未知", codepoints: null })), (async () => {
          face = new FontFace(family, buffer);
          await face.load();
          document.fonts.add(face);
        })()]);
        if (!controller.signal.aborted) setState({ family, info });
      } catch (reason) {
        if (!controller.signal.aborted) onError(reason instanceof Error && reason.message.includes("字体文件") ? reason.message : "浏览器无法加载这个字体文件，它可能已损坏或格式不受支持");
      }
    })();
    return () => { controller.abort(); if (face) document.fonts.delete(face); };
  }, [url]);
  const text = sample || SAMPLES[preset];
  const covered = useMemo(() => state?.info.codepoints ? new Set(state.info.codepoints) : null, [state]);
  /** 字体里没有的字由浏览器用系统字体补上：淡化显示并说明，免得误以为是这款字体的字形。 */
  const sampleOf = (value: string) => covered ? [...value].map((char, index) => {
    const code = char.codePointAt(0)!;
    return code > 0x20 && !covered.has(code) ? <span key={index} className="preview-font-missing" title="这个字体里没有这个字，显示的是系统字体">{char}</span> : char;
  }) : value;
  const style = useMemo(() => state ? { fontFamily: `"${state.family}", var(--font-display)` } as CSSProperties : undefined, [state]);
  if (!state) return <div className="preview-engine-loading" role="status"><span className="spinner" />正在加载字体…</div>;
  const { info } = state;
  const points = info.codepoints;
  const details: [string, string | number | undefined][] = [["格式", info.format], ["字形数", info.glyphs?.toLocaleString()], ["字符数", points?.length.toLocaleString()],
    ["版本", info.version], ["设计者", info.designer], ["制作者", info.maker], ["版权", info.copyright]];
  return <div className="preview-pane preview-font" style={style}>
    <header className="preview-font-head">
      <h2 style={style}>{info.full || [info.family, info.style].filter(Boolean).join(" ") || name}</h2>
      <dl className="preview-font-details">{details.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={String(value)}>{value}</dd></div>)}</dl>
      {info.license && <details className="preview-font-license"><summary>许可说明</summary><p>{info.license}</p></details>}
    </header>
    <section className="preview-font-sample">
      <div className="preview-font-controls">
        <Segmented label="样张" value={preset} onChange={value => { setPreset(value); setSample(""); }} options={[{ value: "zh", label: "中文" }, { value: "en", label: "英文" }, { value: "digits", label: "数字符号" }]} />
        <input className="input input-sm preview-font-input" placeholder="输入要预览的文字" aria-label="输入要预览的文字" value={sample} onChange={event => setSample(event.target.value)} />
        <label className="preview-font-size"><span>{size}px</span><input type="range" min={10} max={160} value={size} aria-label="字号" onChange={event => setSize(Number(event.target.value))} /></label>
      </div>
      <p className="preview-font-specimen" style={{ ...style, fontSize: size }}>{sampleOf(text)}</p>
      <ol className="preview-font-waterfall">{SIZES.map(value => <li key={value}><span>{value}</span><span style={{ ...style, fontSize: value }}>{sampleOf(text)}</span></li>)}</ol>
    </section>
    <section className="preview-font-glyphs">
      <h3>字符<span>{points ? `${points.length.toLocaleString()} 个` : ""}</span></h3>
      {points ? <>
        <ol className="preview-font-grid" style={style}>{points.slice(0, shownGlyphs).map(code => {
          const char = String.fromCodePoint(code), label = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
          return <li key={code}><button type="button" title={`${label} · 点击复制`} onClick={() => void copyText(char, `已复制 ${char}`)}><span>{char}</span><small>{label}</small></button></li>;
        })}</ol>
        {points.length > shownGlyphs && <div className="panel-more"><Button size="sm" variant="ghost" onClick={() => setShownGlyphs(value => value + GRID_PAGE * 2)}>再显示 {Math.min(GRID_PAGE * 2, points.length - shownGlyphs).toLocaleString()} 个</Button></div>}
      </> : <p className="preview-font-note"><Icon name="info" size={14} />{info.format === "WOFF2" ? "WOFF2 字体的字符表经过压缩，浏览器无法直接读取，可以用上面的样张检查字形。" : "没有读到这个字体的字符表。"}</p>}
    </section>
  </div>;
}
