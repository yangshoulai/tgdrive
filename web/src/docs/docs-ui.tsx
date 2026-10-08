/** 文档站排版基元：标题、提示框、参数表、端点卡片、代码块与高亮。 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Icon, copyText, type IconName } from "../ui";

/* ---------- 地址上下文：示例代码使用管理员配置的真实地址 ---------- */

export type DocsConfig = { site: string; s3: string; s3Configured: boolean; basePath: string };
export const ConfigContext = createContext<DocsConfig>({ site: "https://drive.example.com", s3: "https://s3.example.com", s3Configured: false, basePath: "/docs" });
export const useDocsConfig = () => useContext(ConfigContext);

export function slug(value: string) {
  return value.toLowerCase().replace(/[`<>（）()]/g, "").replace(/[^\w一-鿿]+/g, "-").replace(/^-|-$/g, "");
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

/* ---------- 排版基元 ---------- */

export function H2({ children, id }: { children: ReactNode; id?: string }) {
  const anchor = id ?? slug(textOf(children));
  return <h2 id={anchor} className="doc-h2"><a href={`#${anchor}`} className="doc-anchor" aria-hidden="true">#</a>{children}</h2>;
}
export function H3({ children, id }: { children: ReactNode; id?: string }) {
  const anchor = id ?? slug(textOf(children));
  return <h3 id={anchor} className="doc-h3"><a href={`#${anchor}`} className="doc-anchor" aria-hidden="true">#</a>{children}</h3>;
}
export function Lead({ children }: { children: ReactNode }) { return <p className="doc-lead">{children}</p>; }
export function C({ children }: { children: ReactNode }) { return <code className="doc-inline">{children}</code>; }
export function DocLink({ to, children }: { to: string; children: ReactNode }) {
  const [page, hash] = to.split("#");
  const { basePath } = useDocsConfig();
  return <a className="doc-link" href={`${basePath}/${page}${hash ? `#${hash}` : ""}`} onClick={event => { event.preventDefault(); navigateDocs(page, hash, basePath); }}>{children}</a>;
}

const CALLOUT_ICON: Record<string, IconName> = { info: "info", tip: "checkCircle", warning: "alert", danger: "alert" };
export function Callout({ tone = "info", title, children }: { tone?: "info" | "tip" | "warning" | "danger"; title?: string; children: ReactNode }) {
  return (
    <aside className={`callout callout-${tone}`}>
      <Icon name={CALLOUT_ICON[tone]} size={18} />
      <div>{title && <strong>{title}</strong>}<div className="callout-body">{children}</div></div>
    </aside>
  );
}

export function Steps({ children }: { children: ReactNode }) { return <ol className="doc-steps">{children}</ol>; }
export function Step({ title, children }: { title: string; children: ReactNode }) {
  return <li><strong className="doc-step-title">{title}</strong><div>{children}</div></li>;
}

export function Table({ head, rows, compact }: { head: ReactNode[]; rows: ReactNode[][]; compact?: boolean }) {
  return (
    <div className="doc-table-wrap">
      <table className={`doc-table${compact ? " is-compact" : ""}`}>
        <thead><tr>{head.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** 参数表：名称、类型、是否必填、说明。 */
export function Params({ title = "参数", rows }: { title?: string; rows: [string, string, boolean, ReactNode][] }) {
  return (
    <div className="doc-params">
      <p className="doc-params-title">{title}</p>
      <dl>
        {rows.map(([name, type, required, description]) => (
          <div key={name}>
            <dt><code>{name}</code><span className="doc-param-type">{type}</span>{required && <span className="doc-param-required">必填</span>}</dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function Endpoint({ method, path, auth, summary, children }: { method: "GET" | "POST" | "PUT" | "DELETE" | "HEAD"; path: string; auth: "public" | "session" | "csrf" | "key"; summary: ReactNode; children?: ReactNode }) {
  const authLabel = { public: "无需认证", session: "需要会话", csrf: "需要会话与 CSRF", key: "需要访问密钥" }[auth];
  return (
    <section className="endpoint" id={slug(`${method} ${path}`)}>
      <header>
        <span className={`method method-${method.toLowerCase()}`}>{method}</span>
        <code className="endpoint-path">{path}</code>
        <span className={`endpoint-auth auth-${auth}`}><Icon name={auth === "public" ? "globe" : auth === "key" ? "key" : "lock"} size={13} />{authLabel}</span>
      </header>
      <div className="endpoint-body">
        <p className="endpoint-summary">{summary}</p>
        {children}
      </div>
    </section>
  );
}

/* ---------- 代码块与轻量高亮 ---------- */

const RULES: Record<string, [string, RegExp][]> = {
  bash: [["comment", /#[^\n]*/y], ["string", /"(?:\\.|[^"\\])*"|'[^']*'/y], ["variable", /\$\{?\w+\}?/y], ["flag", /(?<=\s)--?[\w-]+/y], ["keyword", /\b(?:curl|aws|rclone|export|cd|node|python3?|pip|sudo)\b/y]],
  json: [["property", /"(?:\\.|[^"\\])*"(?=\s*:)/y], ["string", /"(?:\\.|[^"\\])*"/y], ["number", /-?\b\d+(?:\.\d+)?\b/y], ["keyword", /\b(?:true|false|null)\b/y]],
  js: [["comment", /\/\/[^\n]*/y], ["string", /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y], ["keyword", /\b(?:const|let|await|async|function|return|new|if|else|for|of|import|from|export)\b/y], ["number", /\b\d+\b/y], ["fn", /\b[a-zA-Z_]\w*(?=\()/y]],
  python: [["comment", /#[^\n]*/y], ["string", /f?"(?:\\.|[^"\\])*"|f?'(?:\\.|[^'\\])*'/y], ["keyword", /\b(?:import|from|as|def|return|with|for|in|if|else|None|True|False|print)\b/y], ["number", /\b\d+\b/y], ["fn", /\b[a-zA-Z_]\w*(?=\()/y]],
  http: [["keyword", /^(?:GET|POST|PUT|DELETE|HEAD)\b/my], ["property", /^[\w-]+(?=:)/my], ["string", /"(?:\\.|[^"\\])*"/y], ["number", /\b\d+\b/y]],
  ini: [["comment", /[#;][^\n]*/y], ["keyword", /^\[[^\]]+\]/my], ["property", /^[\w.-]+(?=\s*=)/my]],
  nginx: [["comment", /#[^\n]*/y], ["keyword", /\b(?:server|location|listen|server_name|proxy_pass|proxy_set_header|proxy_buffering|proxy_request_buffering|client_max_body_size|root|try_files|ssl_certificate|ssl_certificate_key|proxy_http_version)\b/y], ["variable", /\$\w+/y], ["number", /\b\d+\b/y]],
};
RULES.xml = [["comment", /<!--[\s\S]*?-->/y], ["keyword", /<\/?[\w:]+/y], ["string", /"[^"]*"/y]];

function highlight(code: string, lang: string): ReactNode[] {
  const rules = RULES[lang];
  if (!rules) return [code];
  const out: ReactNode[] = [];
  let plain = "";
  let index = 0;
  while (index < code.length) {
    let matched = false;
    for (const [kind, rule] of rules) {
      rule.lastIndex = index;
      const match = rule.exec(code);
      if (match && match.index === index && match[0].length) {
        if (plain) { out.push(plain); plain = ""; }
        out.push(<span key={index} className={`tok-${kind}`}>{match[0]}</span>);
        index += match[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) plain += code[index++];
  }
  if (plain) out.push(plain);
  return out;
}

const LANG_LABEL: Record<string, string> = { bash: "Shell", json: "JSON", js: "JavaScript", python: "Python", http: "HTTP", ini: "配置", nginx: "Nginx", xml: "XML", text: "文本" };

export function Code({ code, lang = "text", title }: { code: string; lang?: string; title?: string }) {
  return (
    <div className="code-block">
      <div className="code-block-bar"><span>{title ?? LANG_LABEL[lang] ?? lang}</span><CopyButton text={code} /></div>
      <pre><code>{highlight(code.trim(), lang)}</code></pre>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" onClick={() => { void copyText(text.trim(), "已复制"); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }}>
      <Icon name={copied ? "check" : "copy"} size={14} />{copied ? "已复制" : "复制"}
    </button>
  );
}

/** 多语言示例：所选语言在整个文档站内记住。 */
const TAB_EVENT = "tgdrive:docs-tab";
export function CodeTabs({ tabs }: { tabs: { label: string; lang: string; code: string }[] }) {
  const [active, setActive] = useState(() => {
    const saved = localStorage.getItem("tgdrive:docs-tab");
    return tabs.some(tab => tab.label === saved) ? saved! : tabs[0].label;
  });
  useEffect(() => {
    const sync = (event: Event) => { const label = (event as CustomEvent<string>).detail; if (tabs.some(tab => tab.label === label)) setActive(label); };
    window.addEventListener(TAB_EVENT, sync);
    return () => window.removeEventListener(TAB_EVENT, sync);
  }, [tabs]);
  const current = tabs.find(tab => tab.label === active) ?? tabs[0];
  return (
    <div className="code-block code-tabs">
      <div className="code-block-bar">
        <div role="tablist" aria-label="示例语言">
          {tabs.map(tab => (
            <button key={tab.label} type="button" role="tab" aria-selected={tab.label === current.label} className={tab.label === current.label ? "is-active" : ""}
              onClick={() => { localStorage.setItem("tgdrive:docs-tab", tab.label); window.dispatchEvent(new CustomEvent(TAB_EVENT, { detail: tab.label })); }}>
              {tab.label}
            </button>
          ))}
        </div>
        <CopyButton text={current.code} />
      </div>
      <pre role="tabpanel"><code>{highlight(current.code.trim(), current.lang)}</code></pre>
    </div>
  );
}

/** 请求流程示意：横向的方框与箭头，移动端自动换行。 */
export function Flow({ nodes }: { nodes: { title: string; detail: string; icon: IconName }[] }) {
  return (
    <div className="doc-flow">
      {nodes.map((node, index) => (
        <div className="doc-flow-item" key={node.title}>
          {index > 0 && <span className="doc-flow-arrow" aria-hidden="true"><Icon name="chevronRight" size={18} /></span>}
          <div className="doc-flow-node"><Icon name={node.icon} size={20} /><strong>{node.title}</strong><span>{node.detail}</span></div>
        </div>
      ))}
    </div>
  );
}

export function CardGrid({ children }: { children: ReactNode }) { return <div className="doc-cards">{children}</div>; }
export function Card({ to, icon, title, children }: { to: string; icon: IconName; title: string; children: ReactNode }) {
  const { basePath } = useDocsConfig();
  return (
    <a className="doc-card" href={`${basePath}/${to}`} onClick={event => { event.preventDefault(); navigateDocs(to, undefined, basePath); }}>
      <span className="doc-card-icon"><Icon name={icon} size={18} /></span>
      <strong>{title}</strong>
      <span>{children}</span>
    </a>
  );
}

/* ---------- 站内导航 ---------- */

export const NAV_EVENT = "tgdrive:docs-nav";
export function navigateDocs(page: string, hash?: string, basePath = "/docs") {
  window.history.pushState(null, "", `${basePath}/${page}${hash ? `#${hash}` : ""}`);
  window.dispatchEvent(new CustomEvent(NAV_EVENT));
}
