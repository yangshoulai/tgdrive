// ==UserScript==
// @name         Tessera 资源抓取
// @namespace    https://github.com/yangshoulai/tgdrive
// @version      0.1.1
// @description  在 X、YouTube 和其他网页上快速复制媒体地址与 curl 命令，或一键发送到 Tessera 离线下载
// @author       yangshoulai
// @match        *://*/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

/*
 * 三处入口：右下角悬浮按钮（所有网页）、X 帖子操作栏、YouTube 播放页操作栏。
 * - 资源嗅探：PerformanceObserver 记录页面加载过的视频、音频、M3U8 和常见文件；图片从 DOM 中按尺寸挑选。
 * - 复制：链接，或带 User-Agent、Referer、Cookie 的 curl 命令（Cookie 经 GM_cookie 读取，包含 HttpOnly）。
 * - 发送：调用 Tessera 的 /api/v1/downloads/parse 与 /api/v1/downloads，需要在设置中填写地址和访问密钥。
 * Cookie 只放进你复制的命令或发给你自己配置的 Tessera 服务器，不发往其他地方。
 */
(function () {
  "use strict";

  const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const MAX_ITEMS = 150;

  // ---------- 设置 ----------

  const DEFAULTS = { server: "", key: "", destination: "", cookies: true, fab: true };
  const settings = () => ({ ...DEFAULTS, ...GM_getValue("settings", {}) });
  const saveSettings = value => GM_setValue("settings", { ...settings(), ...value });

  // ---------- 资源嗅探 ----------

  const EXT = {
    video: /\.(mp4|m4v|mov|webm|mkv|flv|avi)$/i,
    audio: /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus)$/i,
    stream: /\.(m3u8|mpd)$/i,
    image: /\.(jpe?g|png|gif|webp|avif|bmp|heic)$/i,
    file: /\.(zip|rar|7z|tar|gz|pdf|apk|ipa|dmg|exe|msi|iso|epub)$/i,
  };
  const TYPE_LABEL = { video: "视频", audio: "音频", stream: "M3U8", image: "图片", file: "文件" };
  const items = new Map();
  const listeners = new Set();

  function classify(url, initiator) {
    let parts;
    try { parts = new URL(url, location.href); } catch { return null; }
    if (!/^https?:$/.test(parts.protocol)) return null;
    const path = parts.pathname.toLowerCase();
    // 分片与按范围请求的媒体无法单独下载：YouTube 走平台解析，HLS 分片只保留播放列表。
    if (parts.hostname.endsWith("googlevideo.com") || /\.(m4s|ts)$/.test(path)) return null;
    if (parts.hostname === "video.twimg.com" && /\/(avc1|hevc|mp4a)\//.test(path) && !EXT.stream.test(path)) return null;
    for (const type of ["stream", "video", "audio", "file"]) {
      if (EXT[type].test(path)) return type;
    }
    if (initiator === "video" || initiator === "audio") return initiator;
    return null;
  }

  function addItem(url, type, extra = {}) {
    if (!url || items.has(url)) return;
    items.set(url, { url, type, time: Date.now(), ...extra });
    while (items.size > MAX_ITEMS) items.delete(items.keys().next().value);
    listeners.forEach(fn => fn());
  }

  function observeNetwork() {
    const Observer = page.PerformanceObserver || window.PerformanceObserver;
    if (!Observer) return;
    try {
      new Observer(list => {
        for (const entry of list.getEntries()) {
          const type = classify(entry.name, entry.initiatorType);
          if (type) addItem(entry.name, type, { source: "网络" });
        }
      }).observe({ type: "resource", buffered: true });
    } catch { /* 浏览器不支持资源计时 */ }
  }

  function upgradeImage(src) {
    try {
      const url = new URL(src);
      if (url.hostname === "pbs.twimg.com" && url.pathname.startsWith("/media/")) {
        url.searchParams.set("name", "orig");
        return url.href;
      }
    } catch { /* 忽略无效地址 */ }
    return src;
  }

  /** 打开面板时补充 DOM 中的媒体：<video>/<audio>/<source> 的直链与足够大的图片。 */
  function scanDom(root = document) {
    const found = [];
    root.querySelectorAll("video, audio, source").forEach(node => {
      const src = node.currentSrc || node.src;
      if (src && !src.startsWith("blob:") && !src.startsWith("data:")) {
        const type = classify(src) || (node.tagName === "AUDIO" ? "audio" : "video");
        found.push({ url: src, type, source: "页面" });
      }
    });
    root.querySelectorAll("img").forEach(img => {
      const src = img.currentSrc || img.src;
      if (!src || !/^https?:/.test(src)) return;
      const big = img.naturalWidth >= 320 && img.naturalHeight >= 200;
      const twitter = /pbs\.twimg\.com\/media\//.test(src);
      if (big || twitter) found.push({ url: upgradeImage(src), type: "image", source: "页面" });
    });
    return found;
  }

  // ---------- 页面识别 ----------

  function platformOf(href) {
    let url;
    try { url = new URL(href); } catch { return null; }
    const host = url.hostname.replace(/^(www|mobile|m)\./, "");
    if (host === "x.com" || host === "twitter.com") {
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      if (match) return { platform: "x", label: "X 帖子", url: `https://x.com/${match[1]}/status/${match[2]}`, id: match[2] };
    }
    if (host === "youtube.com" || host === "music.youtube.com") {
      const id = url.pathname === "/watch" ? url.searchParams.get("v") : (url.pathname.match(/^\/shorts\/([\w-]{6,})/) || [])[1];
      if (id) return { platform: "youtube", label: "YouTube 视频", url: `https://www.youtube.com/watch?v=${id}`, id };
    }
    if (host === "youtu.be" && url.pathname.length > 1) {
      const id = url.pathname.slice(1);
      return { platform: "youtube", label: "YouTube 视频", url: `https://www.youtube.com/watch?v=${id}`, id };
    }
    return null;
  }

  // ---------- Cookie 与 curl ----------

  function cookieHeader(url) {
    return new Promise(resolve => {
      const fallback = () => {
        // 同站资源退回 document.cookie（读不到 HttpOnly）；跨站资源不附带。
        try { resolve(new URL(url).hostname.endsWith(location.hostname.replace(/^www\./, "")) ? document.cookie : ""); }
        catch { resolve(""); }
      };
      if (typeof GM_cookie === "undefined" || !GM_cookie.list) return fallback();
      const timer = setTimeout(fallback, 2000);
      try {
        GM_cookie.list({ url }, (cookies, error) => {
          clearTimeout(timer);
          if (error || !Array.isArray(cookies)) return fallback();
          resolve(cookies.map(item => `${item.name}=${item.value}`).join("; "));
        });
      } catch {
        clearTimeout(timer);
        fallback();
      }
    });
  }

  const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const referer = () => location.href.split("#")[0];

  async function curlFor(url, withCookies = settings().cookies) {
    const lines = [`curl ${quote(url)} -L`, `-H ${quote("User-Agent: " + navigator.userAgent)}`, `-H ${quote("Referer: " + referer())}`];
    const cookie = withCookies ? await cookieHeader(url) : "";
    if (cookie) lines.push(`-H ${quote("Cookie: " + cookie)}`);
    return lines.join(" \\\n  ");
  }

  function fileName(url) {
    try {
      const parts = new URL(url);
      const last = decodeURIComponent(parts.pathname.split("/").filter(Boolean).pop() || "");
      return last || parts.hostname;
    } catch { return url; }
  }

  // ---------- Tessera API ----------

  function api(method, path, body) {
    const { server, key } = settings();
    if (!server || !key) return Promise.reject(new Error("请先在设置中填写 Tessera 地址和访问密钥"));
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url: server.replace(/\/+$/, "") + path, anonymous: true, timeout: 180000,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        data: body === undefined ? undefined : JSON.stringify(body),
        onload: response => {
          let data = null;
          try { data = response.responseText ? JSON.parse(response.responseText) : null; } catch { /* 非 JSON */ }
          if (response.status >= 200 && response.status < 300) return resolve(data);
          const message = data && data.error && data.error.message;
          reject(new Error(message || `Tessera 返回 HTTP ${response.status}`));
        },
        onerror: () => reject(new Error("无法连接 Tessera，请检查地址，并在 Tampermonkey 提示时允许访问该域名")),
        ontimeout: () => reject(new Error("请求 Tessera 超时")),
      });
    });
  }

  // ---------- 界面 ----------

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root { --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #e5e5ea; --soft: #f5f5f7; --accent: #2f6fed; --danger: #d93025;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; color: var(--fg); }
    @media (prefers-color-scheme: dark) {
      .root { --bg: #1c1c1e; --fg: #f5f5f7; --muted: #a1a1a6; --line: #38383a; --soft: #2c2c2e; --accent: #5b8cff; --danger: #ff6b5f; }
    }
    .fab { position: fixed; right: 20px; bottom: 20px; width: 44px; height: 44px; border-radius: 22px; border: 1px solid var(--line);
      background: var(--bg); color: var(--fg); box-shadow: 0 4px 16px rgba(0,0,0,.18); cursor: pointer; display: grid; place-items: center;
      z-index: 2147483646; pointer-events: auto; }
    .fab:hover { border-color: var(--accent); }
    .badge { position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
      background: var(--accent); color: #fff; font-size: 11px; line-height: 18px; text-align: center; }
    .panel { position: fixed; right: 20px; bottom: 76px; width: min(440px, calc(100vw - 24px)); max-height: min(640px, calc(100vh - 100px));
      display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.25); z-index: 2147483647; pointer-events: auto; overflow: hidden; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    header strong { flex: 1; font-size: 14px; }
    .body { overflow: auto; padding: 12px; display: grid; gap: 12px; }
    .card { border: 1px solid var(--line); border-radius: 10px; padding: 10px; display: grid; gap: 8px; }
    .title { font-weight: 600; }
    .sub { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .row { display: flex; align-items: center; gap: 8px; }
    .row.wrap { flex-wrap: wrap; }
    .grow { flex: 1; min-width: 0; }
    .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tag { flex: none; font-size: 11px; padding: 1px 6px; border-radius: 6px; background: var(--soft); color: var(--muted); }
    .list { display: grid; gap: 2px; }
    .item { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-radius: 8px; }
    .item:hover { background: var(--soft); }
    .thumb { flex: none; width: 36px; height: 36px; border-radius: 6px; object-fit: cover; background: var(--soft); }
    button { font: inherit; color: inherit; background: var(--soft); border: 1px solid transparent; border-radius: 8px; padding: 4px 10px;
      cursor: pointer; white-space: nowrap; }
    button:hover { border-color: var(--line); }
    button.primary { background: var(--accent); color: #fff; }
    button.icon { background: none; padding: 4px 6px; }
    button.small { padding: 2px 8px; font-size: 12px; }
    button:disabled { opacity: .5; cursor: default; }
    input[type=text], input[type=password], input[type=url] { width: 100%; font: inherit; color: inherit; background: var(--bg);
      border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; }
    input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
    label.field { display: grid; gap: 4px; }
    label.check { display: flex; align-items: center; gap: 8px; }
    .empty { color: var(--muted); text-align: center; padding: 16px 0; }
    .error { color: var(--danger); overflow-wrap: anywhere; }
    .tabs { display: flex; gap: 4px; flex-wrap: wrap; }
    .tabs button[aria-pressed=true] { background: var(--accent); color: #fff; }
    .toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); background: var(--fg); color: var(--bg);
      padding: 8px 14px; border-radius: 8px; z-index: 2147483647; pointer-events: none; max-width: 80vw; }
    a { color: var(--accent); }
  `;

  // YouTube 等站点启用了 Trusted Types，禁止给 innerHTML 赋字符串：图标和界面一律用 DOM API 创建。
  function icon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    for (const [key, value] of Object.entries({ width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" })) svg.setAttribute(key, value);
    for (const d of ["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"]) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "className") node.className = value;
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  let host, shadow, fab, badge, panel, toastTimer;

  function mount() {
    if (host || !document.documentElement) return;
    host = h("div", { id: "tessera-grabber" });
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    shadow = host.attachShadow({ mode: "closed" });
    const root = h("div", { className: "root" });
    shadow.append(h("style", {}, STYLE), root);
    badge = h("span", { className: "badge", hidden: true });
    fab = h("button", { className: "fab", title: "Tessera 资源抓取", "aria-label": "Tessera 资源抓取", onclick: () => toggle() });
    fab.append(icon(), badge);
    root.append(fab);
    document.documentElement.append(host);
    refreshFab();
    listeners.add(refreshFab);
    document.addEventListener("fullscreenchange", refreshFab);
  }

  function refreshFab() {
    if (!fab) return;
    const count = [...items.values()].filter(item => item.type !== "image").length;
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
    fab.style.display = !settings().fab || document.fullscreenElement ? "none" : "";
  }

  function toast(message) {
    if (!shadow) return;
    shadow.querySelector(".toast")?.remove();
    const node = h("div", { className: "toast", role: "status" }, message);
    shadow.querySelector(".root").append(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), 2400);
  }

  function copy(text, message = "已复制") {
    GM_setClipboard(text, "text");
    toast(message);
  }

  function close() {
    panel?.remove();
    panel = null;
    listeners.delete(renderListIfOpen);
  }

  function toggle(context) {
    if (panel && !context) return close();
    open(context);
  }

  function frame(title, body, { back } = {}) {
    close();
    const header = h("header", {},
      back ? h("button", { className: "icon", title: "返回", onclick: back }, "←") : null,
      h("strong", {}, title),
      h("button", { className: "icon", title: "设置", onclick: () => openSettings(() => open()) }, "⚙"),
      h("button", { className: "icon", title: "关闭", onclick: close }, "✕"));
    panel = h("div", { className: "panel", role: "dialog", "aria-label": title }, header, h("div", { className: "body" }, body));
    shadow.querySelector(".root").append(panel);
    return panel;
  }

  // ----- 主面板 -----

  let filter = "all";
  let currentContext = null;

  /** context: { platform, label, url, scope } —— scope 为 X 帖子元素时只列出这条帖子的图片。 */
  function open(context) {
    mount();
    currentContext = context || platformOf(location.href);
    const body = h("div", { style: "display:grid;gap:12px" });
    if (currentContext) body.append(platformCard(currentContext));
    body.append(h("div", { className: "list-host" }));
    frame("Tessera 资源抓取", body);
    renderList();
    listeners.add(renderListIfOpen);
  }

  function platformCard(context) {
    const sendable = settings().server && settings().key;
    return h("div", { className: "card" },
      h("div", { className: "row" }, h("span", { className: "tag" }, context.label), h("span", { className: "sub grow" }, context.url)),
      h("div", { className: "row wrap" },
        h("button", { className: "primary", onclick: () => send(context.url, context.platform), title: sendable ? null : "需要先在设置中填写 Tessera 地址和访问密钥" }, "发送到 Tessera"),
        h("button", { onclick: () => copy(context.url, "已复制链接") }, "复制链接"),
        h("button", { onclick: async () => copy(await curlFor(context.url), "已复制 curl 命令") }, "复制 curl")),
      h("div", { className: "sub" }, context.platform === "youtube"
        ? "YouTube 媒体地址带签名且分段，无法直接复制下载；发送到 Tessera 后由服务器解析并选择清晰度。"
        : "视频由服务器解析；图片可在下方直接复制原图地址。"));
  }

  // X、YouTube 会持续加载资源：新资源到达时最多每秒刷新一次列表。
  let renderTimer = 0;
  function renderListIfOpen() {
    if (!panel || renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = 0; if (panel) renderList(); }, 1000);
  }

  function collect() {
    const scope = currentContext && currentContext.scope;
    const dom = scanDom(scope || document);
    if (scope) return dom; // 单条帖子只看它自己的媒体
    const merged = new Map();
    for (const item of [...items.values()].reverse()) merged.set(item.url, item);
    for (const item of dom) if (!merged.has(item.url)) merged.set(item.url, item);
    if (currentContext && currentContext.platform === "youtube") {
      const cover = `https://i.ytimg.com/vi/${currentContext.id}/maxresdefault.jpg`;
      merged.set(cover, { url: cover, type: "image", source: "封面" });
    }
    return [...merged.values()];
  }

  function renderList() {
    const target = panel && panel.querySelector(".list-host");
    if (!target) return;
    const all = collect();
    const counts = all.reduce((acc, item) => ({ ...acc, [item.type]: (acc[item.type] || 0) + 1 }), {});
    if (filter !== "all" && !counts[filter]) filter = "all";
    const shown = all.filter(item => filter === "all" || item.type === filter);
    const tabs = h("div", { className: "tabs" },
      h("button", { className: "small", "aria-pressed": String(filter === "all"), onclick: () => { filter = "all"; renderList(); } }, `全部 ${all.length}`),
      Object.keys(TYPE_LABEL).filter(type => counts[type]).map(type =>
        h("button", { className: "small", "aria-pressed": String(filter === type), onclick: () => { filter = type; renderList(); } }, `${TYPE_LABEL[type]} ${counts[type]}`)));
    const list = h("div", { className: "list" }, shown.length ? shown.map(row) :
      h("div", { className: "empty" }, "还没有发现可下载的资源。播放一下视频，或滚动加载图片后再打开。"));
    target.replaceChildren(
      h("div", { className: "row" }, h("span", { className: "title grow" }, "页面资源"),
        currentContext && currentContext.scope ? null : h("button", { className: "small", onclick: () => { items.clear(); refreshFab(); renderList(); } }, "清空")),
      tabs, list);
  }

  function row(item) {
    const preview = item.type === "image" ? h("img", { className: "thumb", src: item.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })
      : h("span", { className: "thumb", style: "display:grid;place-items:center;font-size:11px;color:var(--muted)" }, TYPE_LABEL[item.type]);
    let domain = "";
    try { domain = new URL(item.url).hostname; } catch { /* 忽略 */ }
    return h("div", { className: "item" }, preview,
      h("div", { className: "grow" },
        h("div", { className: "name", title: item.url }, fileName(item.url)),
        h("div", { className: "sub name" }, `${TYPE_LABEL[item.type]} · ${domain}${item.source ? " · " + item.source : ""}`)),
      h("button", { className: "small", onclick: () => copy(item.url, "已复制链接") }, "链接"),
      h("button", { className: "small", onclick: async () => copy(await curlFor(item.url), "已复制 curl 命令") }, "curl"),
      h("button", { className: "small primary", onclick: () => send(item.url, null) }, "发送"));
  }

  // ----- 发送到 Tessera -----

  async function send(url, platform) {
    mount();
    if (!settings().server || !settings().key) {
      toast("请先填写 Tessera 地址和访问密钥");
      return openSettings(() => open(currentContext));
    }
    const back = () => open(currentContext);
    frame("发送到 Tessera", h("div", { className: "empty" }, platform === "youtube" ? "服务器正在解析视频格式，可能需要十几秒…" : "正在解析…"), { back });
    let parsed;
    try {
      // 平台链接单独传 Cookie；文件直链把 Cookie 写进 curl 命令，与网页「下载任务」的规则一致。
      const payload = platform
        ? { input: url, cookies: settings().cookies ? await cookieHeader(url) : "" }
        : { input: await curlFor(url) };
      parsed = await api("POST", "/api/v1/downloads/parse", payload);
    } catch (error) {
      return frame("发送到 Tessera", h("div", { className: "card" },
        h("div", { className: "error" }, error.message),
        h("div", { className: "row" }, h("button", { onclick: () => send(url, platform) }, "重试"), h("button", { onclick: back }, "返回"))), { back });
    }
    renderCandidates(parsed.candidates || [], back);
  }

  function formatSize(size) {
    if (!size) return "大小未知";
    const units = ["B", "KB", "MB", "GB"];
    let value = size, index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function renderCandidates(candidates, back) {
    // 同一组（同一视频的不同清晰度）默认只选第一个；X 帖子的每张图、每个视频各自一组。
    const seen = new Set();
    const checks = candidates.map(candidate => {
      const first = !seen.has(candidate.group);
      seen.add(candidate.group);
      return h("input", { type: "checkbox", checked: first });
    });
    const destination = h("input", { type: "text", value: settings().destination, placeholder: "根目录" });
    const error = h("div", { className: "error", hidden: true });
    const submit = h("button", { className: "primary" }, "开始下载");
    submit.addEventListener("click", async () => {
      const chosen = candidates.filter((_, index) => checks[index].checked);
      if (!chosen.length) return toast("请至少选择一个文件");
      submit.disabled = true;
      error.hidden = true;
      const folder = destination.value.trim().replace(/^\/+/, "");
      try {
        const result = await api("POST", "/api/v1/downloads", {
          items: chosen.map(item => ({ ticket: item.ticket, name: item.name })),
          ...(folder ? { destination: folder } : {}),
        });
        saveSettings({ destination: folder });
        done(result.tasks || [], back);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        submit.disabled = false;
      }
    });
    const rows = candidates.map((candidate, index) => h("label", { className: "item" }, checks[index],
      h("div", { className: "grow" },
        h("div", { className: "name", title: candidate.name }, candidate.name),
        h("div", { className: "sub" }, [candidate.variant, formatSize(candidate.size), candidate.source_host].filter(Boolean).join(" · ")),
        (candidate.warnings || []).map(text => h("div", { className: "sub" }, "⚠ " + text)))));
    frame("发送到 Tessera", h("div", { style: "display:grid;gap:12px" },
      h("div", { className: "list" }, rows.length ? rows : h("div", { className: "empty" }, "没有可下载的文件")),
      h("label", { className: "field" }, h("span", { className: "sub" }, "保存到目录"), destination),
      error,
      h("div", { className: "row" }, h("span", { className: "grow" }), h("button", { onclick: back }, "取消"), submit)), { back });
  }

  function done(tasks, back) {
    const link = settings().server.replace(/\/+$/, "") + "/?view=downloads";
    frame("发送到 Tessera", h("div", { className: "card" },
      h("div", { className: "title" }, `已添加 ${tasks.length} 个下载任务`),
      tasks.map(task => h("div", { className: "sub" }, task.key)),
      h("div", { className: "row" },
        h("button", { className: "primary", onclick: () => GM_openInTab(link, { active: true }) }, "查看下载任务"),
        h("button", { onclick: back }, "返回"))), { back });
  }

  // ----- 设置 -----

  function openSettings(back) {
    mount();
    const current = settings();
    const server = h("input", { type: "url", value: current.server, placeholder: "https://drive.example.com" });
    const key = h("input", { type: "password", value: current.key, placeholder: "AccessKeyId:Secret", autocomplete: "off" });
    const destination = h("input", { type: "text", value: current.destination, placeholder: "例如 Downloads（留空为根目录）" });
    const cookies = h("input", { type: "checkbox", checked: current.cookies });
    const showFab = h("input", { type: "checkbox", checked: current.fab });
    const status = h("div", { className: "sub" });
    const read = () => ({ server: server.value.trim().replace(/\/+$/, ""), key: key.value.trim(),
      destination: destination.value.trim().replace(/^\/+/, ""), cookies: cookies.checked, fab: showFab.checked });
    const validate = value => {
      if (value.server && !/^https?:\/\/[^/\s]+/.test(value.server)) return "Tessera 地址应以 http:// 或 https:// 开头";
      if (value.key && !/^[^:\s]+:\S+$/.test(value.key)) return "访问密钥格式应为 AccessKeyId:Secret";
      return "";
    };
    const test = h("button", {}, "测试连接");
    test.addEventListener("click", async () => {
      const value = read();
      const problem = validate(value);
      if (problem) return status.replaceChildren(h("span", { className: "error" }, problem));
      saveSettings(value);
      status.textContent = "正在连接…";
      try {
        const me = await api("GET", "/api/v1/me");
        const writable = (me.grants || []).filter(grant => grant.perms === "rw").map(grant => `${grant.bucket}/${grant.prefix}`);
        status.textContent = me.owner
          ? `连接成功：用户 ${me.owner}，可写入 ${writable.join("、") || "无（需要读写权限）"}`
          : "连接成功，但这个密钥不属于任何用户，不能创建离线下载";
      } catch (error) {
        status.replaceChildren(h("span", { className: "error" }, error.message));
      }
    });
    const save = h("button", { className: "primary" }, "保存");
    save.addEventListener("click", () => {
      const value = read();
      const problem = validate(value);
      if (problem) return status.replaceChildren(h("span", { className: "error" }, problem));
      saveSettings(value);
      refreshFab();
      toast("设置已保存");
      back ? back() : close();
    });
    frame("设置", h("div", { style: "display:grid;gap:12px" },
      h("label", { className: "field" }, h("span", {}, "Tessera 地址"), server),
      h("label", { className: "field" }, h("span", {}, "访问密钥"), key,
        h("span", { className: "sub" }, "在 Tessera「访问密钥」页面新建，按「Access Key ID:Secret Access Key」格式填写（Secret 只在创建时显示一次）。密钥只保存在 Tampermonkey 中。")),
      h("label", { className: "field" }, h("span", {}, "默认保存目录"), destination),
      h("label", { className: "check" }, cookies, h("span", {}, "附带当前网站的登录 Cookie（下载需要登录的内容）")),
      h("label", { className: "check" }, showFab, h("span", {}, "显示右下角悬浮按钮（也可从 Tampermonkey 菜单打开）")),
      status,
      h("div", { className: "row" }, test, h("span", { className: "grow" }), back ? h("button", { onclick: back }, "取消") : null, save)),
      { back });
  }

  // ---------- 站内按钮 ----------

  function inlineButton(onclick, title = "Tessera") {
    const button = document.createElement("button");
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.dataset.tesseraGrabber = "1";
    button.append(icon());
    button.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border:0;border-radius:17px;" +
      "background:transparent;color:inherit;cursor:pointer;opacity:.75;flex:none;";
    button.addEventListener("mouseenter", () => { button.style.opacity = "1"; });
    button.addEventListener("mouseleave", () => { button.style.opacity = ".75"; });
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      onclick();
    });
    return button;
  }

  function decorateX() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach(article => {
      const bar = [...article.querySelectorAll('[role="group"]')].pop();
      if (!bar || bar.querySelector("[data-tessera-grabber]")) return;
      const link = article.querySelector('a[href*="/status/"] time')?.closest("a");
      const context = link && platformOf(link.href);
      if (!context) return;
      bar.append(inlineButton(() => open({ ...context, scope: article }), "Tessera：复制或发送这条帖子的媒体"));
    });
  }

  function decorateYouTube() {
    const context = platformOf(location.href);
    const bar = document.querySelector("ytd-watch-metadata #top-level-buttons-computed, ytd-watch-metadata #actions-inner #menu");
    if (!context || !bar || bar.parentElement.querySelector("[data-tessera-grabber]")) return;
    bar.before(inlineButton(() => open(platformOf(location.href)), "Tessera：发送这个视频"));
  }

  function watchDom() {
    const host = location.hostname.replace(/^(www|mobile|m)\./, "");
    const decorate = host === "x.com" || host === "twitter.com" ? decorateX : host === "youtube.com" ? decorateYouTube : null;
    if (!decorate) return;
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; decorate(); }, 400);
    }).observe(document.body, { childList: true, subtree: true });
    decorate();
  }

  // ---------- 启动 ----------

  observeNetwork();
  GM_registerMenuCommand("打开资源面板", () => open());
  GM_registerMenuCommand("设置", () => openSettings());
  const start = () => { mount(); watchDom(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
