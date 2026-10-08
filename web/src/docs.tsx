/** 公开文档站：多页面、侧栏导航、页内目录与搜索。不读取任何会话数据。 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import * as api from "./api";
import { DOC_GROUPS, DOC_PAGES, type DocPage } from "./docs-content";
import { ConfigContext, Lead, NAV_EVENT, navigateDocs, type DocsConfig } from "./docs-ui";
import { Brand, Icon } from "./ui";

function currentSlug() {
  const value = window.location.pathname.replace(/^\/docs\/?/, "").replace(/\/$/, "");
  return DOC_PAGES.some(page => page.slug === value) ? value : DOC_PAGES[0].slug;
}

/* ---------- 页面外壳 ---------- */

export function DocsPage() {
  const [current, setCurrent] = useState(currentSlug);
  const [config, setConfig] = useState<DocsConfig>(() => ({ site: api.userSiteOrigin(), s3: api.s3Endpoint() ?? "https://s3.example.com", s3Configured: Boolean(api.s3Endpoint()) }));
  const [toc, setToc] = useState<{ id: string; text: string; level: number }[]>([]);
  const [activeHeading, setActiveHeading] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const article = useRef<HTMLElement>(null);
  const page = DOC_PAGES.find(item => item.slug === current) ?? DOC_PAGES[0];
  const index = DOC_PAGES.indexOf(page);

  useEffect(() => {
    void api.loadPublicConfig().then(() => {
      const s3 = api.s3Endpoint();
      setConfig({ site: api.userSiteOrigin(), s3: s3 ?? "https://s3.example.com", s3Configured: Boolean(s3) });
    }).catch(() => undefined);
    const sync = () => { setCurrent(currentSlug()); setNavOpen(false); };
    window.addEventListener(NAV_EVENT, sync);
    window.addEventListener("popstate", sync);
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); }
      if (event.key === "/" && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); setSearchOpen(true); }
    };
    document.addEventListener("keydown", key);
    return () => { window.removeEventListener(NAV_EVENT, sync); window.removeEventListener("popstate", sync); document.removeEventListener("keydown", key); };
  }, []);

  // 页面切换后：更新标题、滚动到锚点或顶部、根据实际标题生成目录。
  useEffect(() => {
    document.title = `${page.title} · tgdrive 文档`;
    const headings = Array.from(article.current?.querySelectorAll<HTMLElement>("h2.doc-h2, h3.doc-h3") ?? []);
    setToc(headings.map(heading => ({ id: heading.id, text: heading.textContent?.replace(/^#/, "") ?? "", level: heading.tagName === "H2" ? 2 : 3 })));
    const hash = decodeURIComponent(window.location.hash.slice(1));
    const target = hash ? document.getElementById(hash) : null;
    if (target) target.scrollIntoView(); else window.scrollTo({ top: 0 });
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActiveHeading(visible.target.id);
    }, { rootMargin: "-72px 0px -70% 0px" });
    headings.forEach(heading => observer.observe(heading));
    setActiveHeading(headings[0]?.id ?? "");
    return () => observer.disconnect();
  }, [current]);

  const Content = page.Content;
  return (
    <ConfigContext.Provider value={config}>
      <div className="docs">
        <header className="docs-bar">
          <div className="docs-bar-left">
            <button type="button" className="icon-btn icon-btn-ghost docs-menu-button" aria-label="打开文档目录" aria-expanded={navOpen} onClick={() => setNavOpen(value => !value)}><Icon name="menu" /></button>
            <Brand href="/docs" />
            <span className="docs-bar-tag">文档</span>
          </div>
          <button type="button" className="docs-search-trigger" aria-label="搜索文档" title="搜索文档（⌘K）" onClick={() => setSearchOpen(true)}>
            <Icon name="search" size={15} /><span>搜索文档</span><kbd>⌘K</kbd>
          </button>
          <nav className="docs-bar-links" aria-label="站点导航">
            <a href="/">文件空间</a>
          </nav>
        </header>
        <div className="docs-layout">
          <aside className={`docs-nav${navOpen ? " is-open" : ""}`} aria-label="文档目录">
            {DOC_GROUPS.map(group => (
              <div className="docs-nav-group" key={group}>
                <p>{group}</p>
                {DOC_PAGES.filter(item => item.group === group).map(item => (
                  <a key={item.slug} href={`/docs/${item.slug}`} aria-current={item.slug === current ? "page" : undefined}
                    onClick={event => { event.preventDefault(); navigateDocs(item.slug); }}>
                    <Icon name={item.icon} size={16} />{item.title}
                  </a>
                ))}
              </div>
            ))}
          </aside>
          <main className="docs-main">
            <article ref={article} className="doc" key={current}>
              <p className="doc-breadcrumb">{page.group}</p>
              <h1>{page.title}</h1>
              <Lead>{page.summary}</Lead>
              <Content />
            </article>
            <nav className="doc-pager" aria-label="上一页与下一页">
              {index > 0 ? <PagerLink page={DOC_PAGES[index - 1]} direction="prev" /> : <span />}
              {index < DOC_PAGES.length - 1 ? <PagerLink page={DOC_PAGES[index + 1]} direction="next" /> : <span />}
            </nav>
          </main>
          <aside className="docs-toc" aria-label="本页内容">
            {toc.length > 0 && <>
              <p>本页内容</p>
              {toc.map(item => <a key={item.id} href={`#${item.id}`} className={`${item.level === 3 ? "is-sub" : ""}${activeHeading === item.id ? " is-active" : ""}`}>{item.text}</a>)}
            </>}
          </aside>
        </div>
        {navOpen && <div className="docs-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
        {searchOpen && <DocsSearch onClose={() => setSearchOpen(false)} />}
      </div>
    </ConfigContext.Provider>
  );
}

function PagerLink({ page, direction }: { page: DocPage; direction: "prev" | "next" }) {
  return (
    <a className={`doc-pager-link is-${direction}`} href={`/docs/${page.slug}`} onClick={event => { event.preventDefault(); navigateDocs(page.slug); }}>
      <small>{direction === "prev" ? "上一页" : "下一页"}</small>
      <strong>{direction === "prev" && <Icon name="arrowLeft" size={15} />}{page.title}{direction === "next" && <Icon name="chevronRight" size={15} />}</strong>
    </a>
  );
}

/** 搜索：匹配页面标题、简介和关键词，回车打开第一个结果，方向键切换。 */
function DocsSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return DOC_PAGES;
    return DOC_PAGES
      .map(page => {
        const haystack = `${page.title} ${page.summary} ${page.keywords}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (page.title.toLowerCase().includes(term) ? 3 : haystack.includes(term) ? 1 : -100), 0);
        return { page, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.page);
  }, [query]);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 打开时聚焦输入框，关闭后把焦点还给触发搜索的元素。
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    document.body.classList.add("has-modal");
    return () => { document.body.classList.remove("has-modal"); previous?.focus?.(); };
  }, []);
  function trapFocus(event: ReactKeyboardEvent) {
    if (event.key !== "Tab" || !dialog.current) return;
    const items = Array.from(dialog.current.querySelectorAll<HTMLElement>("input, button"));
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  useEffect(() => setSelected(0), [query]);
  function open(page: DocPage) { onClose(); navigateDocs(page.slug); }
  return (
    <div className="modal-backdrop docs-search-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} className="docs-search" role="dialog" aria-modal="true" aria-label="搜索文档" onKeyDown={trapFocus}>
        <div className="docs-search-input">
          <Icon name="search" size={18} />
          <input ref={input} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索页面，例如：分享、S3、rclone、错误码" aria-label="搜索文档"
            onKeyDown={event => {
              if (event.key === "Escape") onClose();
              if (event.key === "ArrowDown") { event.preventDefault(); setSelected(value => Math.min(results.length - 1, value + 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setSelected(value => Math.max(0, value - 1)); }
              if (event.key === "Enter" && results[selected]) open(results[selected]);
            }} />
          <kbd>Esc</kbd>
        </div>
        <ul className="docs-search-results" role="listbox">
          {results.length === 0 ? <li className="docs-search-empty">没有找到与“{query}”相关的页面</li> : results.map((page, index) => (
            <li key={page.slug} role="option" aria-selected={index === selected}>
              <button type="button" className={index === selected ? "is-selected" : ""} onMouseEnter={() => setSelected(index)} onClick={() => open(page)}>
                <Icon name={page.icon} size={17} />
                <span><strong>{page.title}</strong><small>{page.group}，{page.summary}</small></span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
